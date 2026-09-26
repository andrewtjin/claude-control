// `cctl shell-init <shell>` — print a `claude` shell wrapper function that forwards to the launcher.
//
// The wrapper is what makes folder bindings transparent: with it on PATH shadowing the real binary,
// typing `claude` in a bound folder automatically runs on that folder's account (and everywhere else
// runs on the global account), with no habit change. It is emitted as text the operator installs
// themselves (with the printed instructions) rather than written to a profile automatically —
// editing someone's shell profile without asking is not this tool's call.
//
// PowerShell gets special treatment. When cctl is installed via npm, `cctl` on PATH is a generated
// `cctl.cmd` shim that forwards its arguments through cmd.exe with `%*`. cmd.exe re-expands `%*`, so
// a value containing & | < > ^ (or %VAR%) that is not adjacent to whitespace is split or expanded
// before the launcher ever runs — a session argument is corrupted, and text-derived arguments become
// a command-injection surface. cmd.exe is exactly the layer the launcher exists to avoid. So the
// PowerShell wrapper invokes the cctl JS entry through node directly (bypassing the .cmd shim); a
// native process launched from PowerShell never re-enters cmd.exe, so & | < > ^ and %VAR% reach the
// launcher verbatim. The POSIX shims npm generates are shell scripts that already forward with "$@",
// so bash/zsh/fish need no such rewrite.
//
// TWO PowerShell-only limitations the wrapper cannot remove, so it documents them instead of
// pretending they are gone:
//   - Pipeline stdin. A PowerShell function does NOT auto-forward pipeline input to a native command
//     invoked inside it. `... | claude -p` would reach the child with an empty, never-closing stdin
//     unless the wrapper explicitly forwards `$input`. The wrapper forwards it, but only when the
//     call actually has pipeline input (`$MyInvocation.ExpectingInput`): piping an empty `$input`
//     into a native command hands it a closed empty pipe, which would break an interactive launch
//     that must inherit the console instead.
//   - A literal double quote in an argument. Windows PowerShell 5.1 and PowerShell < 7.3 pass
//     native-command arguments in "Legacy" mode, which cannot carry an embedded `"` through
//     `& native @args`: the quote is dropped and the following arguments merge into that one. This
//     is a property of the PowerShell -> native-process boundary, not of this launcher's own spawn
//     (which is verbatim), and PowerShell 7.3+ fixes it with $PSNativeCommandArgumentPassing =
//     'Standard'. The wrapper text warns about it rather than silently corrupting the argument.

export type SupportedShell = 'powershell' | 'bash' | 'zsh' | 'fish';

export const SUPPORTED_SHELLS: readonly SupportedShell[] = ['powershell', 'bash', 'zsh', 'fish'];

/** Stable marker in the emitted PowerShell wrapper's leading comment. `cctl doctor` locates an
 *  installed wrapper by this string, so the emitted text and the detector never drift. */
export const POWERSHELL_WRAPPER_MARKER = 'cctl claude wrapper (PowerShell)';

export function isSupportedShell(value: string): value is SupportedShell {
  return (SUPPORTED_SHELLS as readonly string[]).includes(value);
}

/** The concrete node invocation the PowerShell wrapper should embed so it can bypass the npm `.cmd`
 *  shim: an absolute node binary plus the cctl JS entry it runs. */
export interface ShellInitTarget {
  /** Absolute path to the node binary (typically process.execPath). */
  nodePath: string;
  /** Absolute path to the cctl JS entry point (typically process.argv[1]). */
  cctlEntry: string;
}

/**
 * Resolve how PowerShell should reach cctl without the npm `.cmd` shim, from the running process.
 * Returns the node binary and JS entry when cctl is running as `node <entry.js>` (the npm/pnpm
 * install shape), or undefined when it is not — e.g. a future standalone executable whose argv[1] is
 * not a JS file — so the caller falls back to the plain `cctl claude` form with a quoting caveat.
 */
export function resolveShellInitTarget(deps: {
  execPath: string;
  argv: readonly string[];
}): ShellInitTarget | undefined {
  const entry = deps.argv[1];
  // Only a real JS entry can be handed to `node` directly; anything else means cctl is not the
  // node-plus-script shape this rewrite depends on.
  if (typeof entry !== 'string' || !/\.(?:c|m)?js$/i.test(entry)) return undefined;
  if (typeof deps.execPath !== 'string' || deps.execPath.length === 0) return undefined;
  return { nodePath: deps.execPath, cctlEntry: entry };
}

/** Quote a string as a PowerShell single-quoted literal: single quotes are the only metacharacter
 *  inside one, escaped by doubling. This keeps embedded paths (backslashes, spaces, $, backticks)
 *  fully literal, so a path can never be reinterpreted by PowerShell. */
function psSingleQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** The wrapper script for one shell, with install instructions as leading comments. Pure text.
 *  `target` (PowerShell only) supplies the node-direct invocation; without it the PowerShell wrapper
 *  falls back to calling `cctl` and warns that metacharacters must be quoted. */
export function renderShellInit(shell: SupportedShell, target?: ShellInitTarget): string {
  switch (shell) {
    case 'powershell': {
      // `@args` (splatting) preserves argument boundaries so quoted args stay intact. When we know
      // the node entry, invoke it directly so PowerShell -> node.exe never passes through cmd.exe;
      // otherwise fall back to the shim and warn, since cmd.exe would then re-expand `%*`.
      //
      // The double-quote caveat is a PowerShell < 7.3 property (Legacy native argument passing), so it
      // applies to BOTH forms — it is stated in both headers so the operator sees it wherever they
      // install from. The `$input` guard (below) is what makes `... | claude -p` deliver its stdin.
      const header =
        target !== undefined
          ? [
              `# ${POWERSHELL_WRAPPER_MARKER}.`,
              '# Invokes the cctl entry through node directly, never the npm .cmd shim, so no cmd.exe',
              '# layer can reinterpret arguments: & | < > ^ and %VAR% in a prompt or flag reach Claude',
              '# Code verbatim. Re-run this command after moving or reinstalling node or cctl.',
              '# CAVEAT (Windows PowerShell 5.1 / PowerShell < 7.3): an argument containing a literal',
              '# double quote (") is mangled and merges with the arguments after it, because those',
              '# PowerShell versions pass native-command arguments in Legacy mode. Use PowerShell 7.3+',
              "# ($PSNativeCommandArgumentPassing = 'Standard') for verbatim double quotes.",
            ]
          : [
              `# ${POWERSHELL_WRAPPER_MARKER}.`,
              '# NOTE: cctl resolved to a .cmd shim, so arguments still pass through cmd.exe. Double-quote',
              '# any value containing & | < > ^ ; note quoting does not stop %VAR% expansion.',
              '# CAVEAT (Windows PowerShell 5.1 / PowerShell < 7.3): even quoted, an argument containing a',
              '# literal double quote (") is mangled and merges with the arguments after it. Use',
              '# PowerShell 7.3+ for verbatim double quotes.',
            ];
      // The invocation the two guard branches share (with vs. without piped stdin).
      const invoke =
        target !== undefined
          ? `& ${psSingleQuote(target.nodePath)} ${psSingleQuote(target.cctlEntry)} claude @args`
          : 'cctl claude @args';
      // A PowerShell function does not forward pipeline input to a native command on its own, so pipe
      // `$input` in — but ONLY when the call actually has pipeline input. Piping an empty `$input`
      // hands the child a closed empty stdin, which would break an interactive launch that must
      // inherit the console; the else-branch invokes the child with the console's stdin intact.
      const body = [
        '  if ($MyInvocation.ExpectingInput) {',
        `    $input | ${invoke}`,
        '  } else {',
        `    ${invoke}`,
        '  }',
      ];
      return [
        ...header,
        '# Add it to your profile so `claude` always runs on the right account:',
        '#   cctl shell-init powershell | Out-File -Append $PROFILE',
        '# then open a new shell (or: . $PROFILE).',
        'function claude {',
        ...body,
        '}',
        '',
      ].join('\n');
    }
    case 'bash':
    case 'zsh': {
      const rc = shell === 'bash' ? '~/.bashrc' : '~/.zshrc';
      // "$@" forwards every argument with word boundaries preserved (never $* / unquoted $@). The npm
      // POSIX shim is a shell script that runs `node <entry> "$@"`, so no cmd.exe layer is involved.
      return [
        `# cctl claude wrapper (${shell}).`,
        '# Add it to your shell rc so `claude` always runs on the right account:',
        `#   cctl shell-init ${shell} >> ${rc}`,
        '# then open a new shell (or: source it).',
        'claude() {',
        '  command cctl claude "$@"',
        '}',
        '',
      ].join('\n');
    }
    case 'fish':
      // $argv forwards all arguments; fish preserves boundaries without extra quoting.
      return [
        '# cctl claude wrapper (fish).',
        '# Add it to your fish config so `claude` always runs on the right account:',
        '#   cctl shell-init fish >> ~/.config/fish/config.fish',
        '# then open a new shell.',
        'function claude',
        '  command cctl claude $argv',
        'end',
        '',
      ].join('\n');
  }
}

/** What an installed PowerShell wrapper points at, parsed from a profile's text. `node-direct` is the
 *  node+entry form (the paths must still exist); `shim` is the `cctl claude` fallback (nothing to
 *  verify); undefined means no cctl wrapper is present. */
export type ParsedPowerShellWrapper =
  { kind: 'node-direct'; nodePath: string; cctlEntry: string } | { kind: 'shim' };

/** Undo a PowerShell single-quoted literal: doubled single quotes collapse to one. */
function unPsSingleQuote(value: string): string {
  return value.replace(/''/g, "'");
}

/**
 * Find a cctl `claude` wrapper in the text of a PowerShell profile and report what it invokes. The
 * node-direct body is `& '<node>' '<entry>' claude @args`; a stale install is detected by checking
 * whether those two paths still exist (the caller does the existence check). Returns undefined when
 * the wrapper marker is absent, so `cctl doctor` stays silent for a profile that never had one.
 */
export function parsePowerShellWrapper(profileText: string): ParsedPowerShellWrapper | undefined {
  if (!profileText.includes(POWERSHELL_WRAPPER_MARKER)) return undefined;
  // The node-direct body: two PowerShell single-quoted literals (doubled quotes inside) before the
  // literal `claude @args`. `(?:[^']|'')*` matches a single-quoted literal's contents.
  const nodeDirect = profileText.match(/&\s+'((?:[^']|'')*)'\s+'((?:[^']|'')*)'\s+claude\s+@args/);
  if (nodeDirect && nodeDirect[1] !== undefined && nodeDirect[2] !== undefined) {
    return {
      kind: 'node-direct',
      nodePath: unPsSingleQuote(nodeDirect[1]),
      cctlEntry: unPsSingleQuote(nodeDirect[2]),
    };
  }
  // The fallback body just calls the `cctl` shim — no embedded absolute paths to go stale.
  if (/(?:^|\s)cctl\s+claude\s+@args/m.test(profileText)) return { kind: 'shim' };
  return undefined;
}
