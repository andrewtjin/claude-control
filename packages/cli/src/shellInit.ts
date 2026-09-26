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
// native process launched from PowerShell never re-enters cmd.exe, so every argument reaches the
// launcher verbatim. The POSIX shims npm generates are shell scripts that already forward with "$@",
// so bash/zsh/fish need no such rewrite.

export type SupportedShell = 'powershell' | 'bash' | 'zsh' | 'fish';

export const SUPPORTED_SHELLS: readonly SupportedShell[] = ['powershell', 'bash', 'zsh', 'fish'];

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
      const header =
        target !== undefined
          ? [
              '# cctl claude wrapper (PowerShell).',
              '# Invokes the cctl entry through node directly, never the npm .cmd shim, so no cmd.exe',
              '# layer can reinterpret arguments: & | < > ^ and %VAR% in a prompt or flag reach Claude',
              '# Code verbatim. Re-run this command after moving or reinstalling node or cctl.',
            ]
          : [
              '# cctl claude wrapper (PowerShell).',
              '# NOTE: cctl resolved to a .cmd shim, so arguments still pass through cmd.exe. Double-quote',
              '# any value containing & | < > ^ ; note quoting does not stop %VAR% expansion.',
            ];
      const body =
        target !== undefined
          ? `  & ${psSingleQuote(target.nodePath)} ${psSingleQuote(target.cctlEntry)} claude @args`
          : '  cctl claude @args';
      return [
        ...header,
        '# Add it to your profile so `claude` always runs on the right account:',
        '#   cctl shell-init powershell | Out-File -Append $PROFILE',
        '# then open a new shell (or: . $PROFILE).',
        'function claude {',
        body,
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
