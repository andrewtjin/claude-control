// The `cctl claude` launcher core: find the real Claude Code executable, decide how to invoke it
// WITHOUT a shell, build the child environment for the chosen slot, and run it while propagating
// the exit code and shielding the parent from the interrupt signals the child owns.
//
// Why no shell (spawn shell:false, an argv array): a session's arguments are operator-supplied and
// routinely contain characters cmd.exe and POSIX shells treat specially (spaces, quotes, & | ^,
// non-ASCII). Going through a shell would require quoting them correctly for TWO different shells
// and still leave an injection surface; from this launcher's own spawn, passing an argv array to the
// real binary passes every argument through verbatim, exactly once. That is also why a Windows
// `.cmd`/`.bat`/`.ps1` shim is never spawned as-is: those only run under a shell. An npm/pnpm `.cmd`
// shim is a thin wrapper around `node <cli.js>`, so it is UNWRAPPED to that node invocation; anything
// else is refused.
//
// NOTE ON THE ENTRY HOP: this verbatim guarantee covers the spawn below, not how the operator's
// shell reaches cctl in the first place. When cctl is installed via npm, `cctl` on PATH is a
// generated `cctl.cmd` shim that forwards its arguments through cmd.exe — so a PowerShell caller
// hits a cmd.exe layer BEFORE this file runs, and `%*` re-expansion there would corrupt the very
// characters above. The PowerShell shell-init wrapper (see shellInit.ts) closes most of that entry
// hop by invoking the node entry directly and skipping the .cmd shim, so & | < > ^ and %VAR% reach
// this file verbatim. ONE character it cannot rescue on Windows PowerShell 5.1 / PowerShell < 7.3: a
// literal double quote in an argument is dropped and the following arguments merge into it, because
// those PowerShell versions pass native-command arguments in Legacy mode (fixed by
// $PSNativeCommandArgumentPassing = 'Standard' in PowerShell 7.3+). That corruption is at the
// PowerShell -> node.exe boundary, above this file; the spawn below is still verbatim.
//
// The functions here are split so the decisions are unit-testable in isolation from the spawn:
// findClaudeOnPath (PATH lookup), resolveLaunchTarget (how to invoke a candidate), buildLaunchEnv
// (the child env), configDirPointsIntoProfiles (the one env deletion rule), and spawnClaude (the
// process itself, with an injectable signal seam).

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { extname, posix, win32 } from 'node:path';
import { canonicalizeFolder, isWithin } from '@claude-control/switch-engine';

/** How to invoke a resolved claude candidate, or why we refuse to. */
export type LaunchTarget =
  { kind: 'run'; command: string; prefixArgs: string[] } | { kind: 'refused'; reason: string };

/** The slot a launch runs in — drives the banner and the child env. */
export interface LaunchSlot {
  kind: 'global' | 'group';
  /** The group's profile config dir (group slots only). */
  profileDir?: string;
  /** Account label for the one-line banner. */
  label: string;
  /** Banner parenthetical, e.g. "C:\\repo binding" or "global". */
  context: string;
}

// ---------------------------------------------------------------------------
// PATH lookup
// ---------------------------------------------------------------------------

export interface FindClaudeDeps {
  platform: NodeJS.Platform;
  /** The PATH value to search (defaults to process.env.PATH). */
  pathEnv?: string;
  /** PATHEXT on Windows (defaults to process.env.PATHEXT or a standard set). */
  pathExt?: string;
  existsSync?: (p: string) => boolean;
}

/**
 * Find the `claude` command on PATH. On Windows the search resolves the way the shell's own bare
 * `claude` does: each PATH directory is tried in order, and only WITHIN a directory does an extension
 * preference apply. So a `claude.cmd` in an earlier PATH directory beats a `claude.exe` in a later
 * one — otherwise `cctl claude` could launch a different binary than typing `claude` would. Within a
 * single directory the launchable extensions are preferred (`.exe`, which needs no unwrapping, then
 * `.cmd`, the npm shim we unwrap), then any other PATHEXT match so the caller can report exactly what
 * it found and why it will not run it. On POSIX it looks for an executable named `claude` (a shebang
 * script or symlink runs fine under spawn). Returns the resolved path WITH extension, or undefined
 * when nothing matches.
 */
export function findClaudeOnPath(deps: FindClaudeDeps): string | undefined {
  const existsSync = deps.existsSync ?? nodeExistsSync;
  // Split on the delimiter of the TARGET platform, not the host — so the lookup is correct whether
  // it runs on Windows or POSIX (and testable for either from either).
  const pathDelimiter = deps.platform === 'win32' ? ';' : ':';
  const dirs = (deps.pathEnv ?? process.env.PATH ?? '')
    .split(pathDelimiter)
    .filter((d) => d.length > 0);
  if (deps.platform !== 'win32') {
    for (const dir of dirs) {
      const candidate = posix.join(dir, 'claude');
      if (existsSync(candidate)) return candidate;
    }
    return undefined;
  }
  // Windows: PATHEXT gives the within-directory extension order. Prefer the launchable extensions
  // first (.exe, then the .cmd shim), then any remaining PATHEXT entry.
  const exts = (deps.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const extOrder = ['.exe', '.cmd', ...exts.filter((e) => e !== '.exe' && e !== '.cmd')];
  // PATH directories are the OUTER loop, in order, matching real Windows command resolution: the
  // first directory that holds any `claude` wins, and the extension preference decides only among
  // matches inside that same directory.
  for (const dir of dirs) {
    for (const ext of extOrder) {
      const candidate = win32.join(dir, `claude${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Deciding how to invoke a candidate
// ---------------------------------------------------------------------------

export interface ResolveTargetDeps {
  platform: NodeJS.Platform;
  readFileSync?: (p: string, enc: 'utf8') => string;
  /** The node binary to run an unwrapped .cmd shim with (defaults to the current process's). */
  nodePath?: string;
}

/**
 * Decide how to invoke a resolved claude candidate:
 *   - `.exe`, or any executable on POSIX -> run it directly (argv array, no shell).
 *   - `.cmd` (npm/pnpm shim) -> unwrap to `node <entry.js>` and run that.
 *   - `.bat` / `.ps1` / anything else -> refuse: those only run under a shell, which this launcher
 *     deliberately never uses.
 */
export function resolveLaunchTarget(candidate: string, deps: ResolveTargetDeps): LaunchTarget {
  if (deps.platform !== 'win32') {
    return { kind: 'run', command: candidate, prefixArgs: [] };
  }
  const ext = extname(candidate).toLowerCase();
  if (ext === '.exe') {
    return { kind: 'run', command: candidate, prefixArgs: [] };
  }
  if (ext === '.cmd') {
    const readFileSync = deps.readFileSync ?? nodeReadFileSync;
    let text: string;
    try {
      text = readFileSync(candidate, 'utf8');
    } catch {
      return {
        kind: 'refused',
        reason: `found ${candidate} but could not read it to unwrap the shim. Install the standalone claude.exe, or reinstall Claude Code.`,
      };
    }
    const entry = unwrapNpmCmdShim(candidate, text);
    if (entry === undefined) {
      return {
        kind: 'refused',
        reason: `found ${candidate} but could not unwrap it to a node entry point. Install the standalone claude.exe, or reinstall Claude Code.`,
      };
    }
    return { kind: 'run', command: deps.nodePath ?? process.execPath, prefixArgs: [entry] };
  }
  return {
    kind: 'refused',
    reason:
      `refusing to launch ${candidate}: cctl runs the real Claude Code executable directly, ` +
      `never through a shell, so a ${ext || 'shell'} wrapper is not supported. ` +
      `Put claude.exe on PATH, or install Claude Code via npm (its .cmd shim is unwrapped automatically).`,
  };
}

/**
 * Extract the JS entry point an npm/pnpm-generated `claude.cmd` shim invokes. Those shims run
 * `"%_prog%" "%dp0%\\...\\cli.js" %*` where `%dp0%`/`%~dp0%` is the shim's own directory; a few
 * variants embed an absolute `.js` path instead. Returns the resolved absolute entry path, or
 * undefined when the shim shape is unrecognized (the caller then refuses cleanly).
 */
export function unwrapNpmCmdShim(cmdPath: string, cmdText: string): string | undefined {
  const cmdDir = cmdPath.slice(0, cmdPath.length - extname(cmdPath).length).replace(/[^\\/]*$/, '');
  // A dp0-relative entry: "%dp0%\..\pkg\cli.js" or "%~dp0\pkg\cli.js" (js/cjs/mjs).
  const rel = cmdText.match(/%~?dp0%?\\?([^"\r\n]*?\.(?:c|m)?js)/i);
  if (rel && rel[1]) {
    return win32.join(cmdDir, rel[1]);
  }
  // A quoted absolute entry path anywhere in the shim. A .cmd shim is a Windows artifact, so the
  // path is validated with win32 rules regardless of the host running cctl (native isAbsolute would
  // reject a drive-letter path on POSIX).
  const abs = cmdText.match(/"([A-Za-z]:\\[^"\r\n]*?\.(?:c|m)?js)"/);
  if (abs && abs[1] && win32.isAbsolute(abs[1])) {
    return abs[1];
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Child environment
// ---------------------------------------------------------------------------

export interface BuildLaunchEnvOptions {
  baseEnv: NodeJS.ProcessEnv;
  slot: LaunchSlot;
  /** --account: the per-launch token that relaxes the guard's case B (undefined = not explicit). The
   *  guard honors CCTL_LAUNCH_EXPLICIT only when it names a token minted for this launch, so a plain
   *  inherited value cannot relax the binding. Set on a group slot only (case B is a group-slot rule).
   */
  explicitToken?: string;
  /** --override: the per-launch token that relaxes the guard's case A (undefined = no override). Like
   *  {@link explicitToken}, the guard honors CCTL_BIND_OVERRIDE only when it names a matching token. */
  overrideToken?: string;
  /** For a global slot: whether an inherited CLAUDE_CONFIG_DIR points into the profiles root and so
   *  must be dropped (see {@link configDirPointsIntoProfiles}). Ignored for a group slot. */
  dropInheritedConfigDir: boolean;
}

/**
 * Build the child environment for a launch. A group slot pins CLAUDE_CONFIG_DIR to the group's
 * profile (that IS the account). A global slot inherits the parent env untouched EXCEPT that a
 * CLAUDE_CONFIG_DIR pointing into the profiles root is dropped — otherwise a launch from a shell
 * that still has a previous `cctl claude` group session's var set would silently reuse that group's
 * account instead of the global one.
 *
 * CCTL_LAUNCH_EXPLICIT / CCTL_BIND_OVERRIDE are the guard's relaxation knobs; they carry a per-launch
 * token (not a bare "1"), so the guard can tell a value THIS launch set from one inherited from the
 * shell. Any inherited copy of these knobs — and of CCTL_BIND_ENFORCE — is cleared first so nothing
 * from the parent environment leaks into (or past) this launch.
 */
export function buildLaunchEnv(opts: BuildLaunchEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.baseEnv };
  // Start from a clean guard state so an inherited knob never leaks into this launch. CCTL_BIND_ENFORCE
  // is cleared too: the guard reads its mode from the snapshot, and a stale value must not travel on.
  delete env.CCTL_LAUNCH_EXPLICIT;
  delete env.CCTL_BIND_OVERRIDE;
  delete env.CCTL_BIND_ENFORCE;

  if (opts.slot.kind === 'group') {
    env.CLAUDE_CONFIG_DIR = opts.slot.profileDir;
    if (opts.explicitToken !== undefined) env.CCTL_LAUNCH_EXPLICIT = opts.explicitToken;
  } else if (opts.dropInheritedConfigDir) {
    delete env.CLAUDE_CONFIG_DIR;
  }
  if (opts.overrideToken !== undefined) env.CCTL_BIND_OVERRIDE = opts.overrideToken;
  return env;
}

/**
 * The banner context for a launch, corrected so a global launch never claims the global store when
 * the child will actually run on an inherited CLAUDE_CONFIG_DIR. A global launch drops an inherited
 * CLAUDE_CONFIG_DIR only when it points into the profiles root; any OTHER inherited value survives,
 * so the child uses that config store — a different account than the global slot. In that case the
 * context names the inherited dir instead of silently reading "global". Group slots (which pin their
 * own CLAUDE_CONFIG_DIR) and launches with no surviving inherited dir keep their context verbatim.
 */
export function bannerContextForLaunch(
  slot: LaunchSlot,
  inheritedConfigDir: string | undefined,
  dropInheritedConfigDir: boolean,
): string {
  if (
    slot.kind === 'global' &&
    typeof inheritedConfigDir === 'string' &&
    inheritedConfigDir.length > 0 &&
    !dropInheritedConfigDir
  ) {
    return (
      `${slot.context}; inherited CLAUDE_CONFIG_DIR=${inheritedConfigDir} — the child uses that ` +
      `config store, not the global slot`
    );
  }
  return slot.context;
}

export interface ConfigDirCheckDeps {
  platform: NodeJS.Platform;
  cwd: string;
  realpath: (p: string) => string;
}

/** Whether an inherited CLAUDE_CONFIG_DIR resolves to somewhere inside the profiles root — the only
 *  case a global launch drops it. Canonicalizes both sides with the shared engine canonicalizer so
 *  the boundary/case rules match everywhere. */
export function configDirPointsIntoProfiles(
  configDir: string | undefined,
  profilesRoot: string,
  deps: ConfigDirCheckDeps,
): boolean {
  if (typeof configDir !== 'string' || configDir.length === 0) return false;
  const c = canonicalizeFolder(configDir, deps);
  const r = canonicalizeFolder(profilesRoot, deps);
  if (!c.ok || !r.ok) return false;
  return isWithin(c.path, r.path, deps.platform);
}

// ---------------------------------------------------------------------------
// Which session a launch opens (Claude Code's own arguments)
// ---------------------------------------------------------------------------
//
// An alias binding routes a NAMED session, so before spawning the launcher reads Claude Code's own
// arguments for the session they open. It only READS the argv: the array handed to the child is the
// caller's, untouched, byte for byte (see spawnClaude — no shell, no rewrite).
//
// The parse mirrors how Claude Code's option parser (commander) consumes the same argv, because a
// misread is exactly how a flag VALUE would be taken for a flag: `--append-system-prompt --resume`
// passes the text "--resume" as a prompt, it does not resume anything. The commander rules that
// matter: an option with a REQUIRED value takes the next token whatever it looks like; an OPTIONAL
// value (`--resume [value]`) takes the next token only when it does not start with '-'; a VARIADIC
// option keeps taking non-dash tokens; `--x=v` and short `-xVALUE` attach the value; combined short
// booleans (`-pc`) expand; `--` ends option parsing; and a first operand naming a subcommand
// (`claude mcp add --name x`) hands everything after it to that subcommand, which opens no session.
// The tables list Claude Code 2.1.x's value-taking top-level options; an option not listed is read
// as a boolean, which can only mis-attribute a token when that unknown option's value is itself one
// of the session flags — and even then the enforcement guard, not this parse, has the last word.

/** Top-level options whose value is REQUIRED (the next token is always consumed). */
const REQUIRED_VALUE_OPTIONS = new Set([
  '--name',
  '-n',
  '--session-id',
  '--model',
  '--fallback-model',
  '--agent',
  '--agents',
  '--settings',
  '--setting-sources',
  '--permission-mode',
  '--permission-prompt-tool',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt',
  '--system-prompt-file',
  '--output-format',
  '--input-format',
  '--max-turns',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--json-schema',
  '--debug-file',
  '--plugin-dir',
  '--effort',
  '--thinking',
  '--resume-session-at',
  '--rewind-files',
  '--parent-session-id',
  '--sdk-url',
  '--advisor',
  '--agent-id',
  '--agent-name',
  '--agent-type',
  '--agent-color',
  '--team-name',
  '--teammate-mode',
  '--autocompact',
  '--task-budget',
  '--workload',
]);

/** Top-level VARIADIC options (the first value is required; further non-dash tokens are values). */
const VARIADIC_OPTIONS = new Set([
  '--add-dir',
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--mcp-config',
  '--betas',
  '--channels',
  '--dangerously-load-development-channels',
  '--file',
]);

/** Top-level options whose value is OPTIONAL (taken only when the next token is not dash-led). */
const OPTIONAL_VALUE_OPTIONS = new Set([
  '--resume',
  '-r',
  '--debug',
  '-d',
  '--worktree',
  '-w',
  '--remote',
  '--teleport',
  '--rc',
  '--remote-control',
  '--from-pr',
  '--prompt-suggestions',
  '--cloud',
]);

/** Claude Code subcommands: a first operand naming one opens no interactive session. */
const CLAUDE_SUBCOMMANDS = new Set([
  'mcp',
  'plugin',
  'plugins',
  'auth',
  'login',
  'logout',
  'doctor',
  'update',
  'upgrade',
  'install',
  'setup-token',
  'agents',
  'config',
  'migrate-installer',
  'remote-control',
  'sandbox',
  'gateway',
  'project',
  'import-conversations',
  'ultrareview',
  'auto-mode',
  'eval',
]);

/** What Claude Code's arguments say about the session a launch opens. */
export interface ClaudeSessionArgs {
  /** `--resume/-r`: the value (a session id or a title), `null` for a bare `--resume` (the picker),
   *  absent when not resuming. Last occurrence wins, as in commander. */
  resume?: string | null;
  /** `--continue/-c`: the most recent session in the folder. */
  continue: boolean;
  /** `--name/-n <name>`: the new session's (or the resumed one's) custom title. */
  name?: string;
  /** `--session-id <uuid>`. */
  sessionId?: string;
  /** `--fork-session`: a new id, but the SAME title — so it never changes which alias applies. */
  fork: boolean;
  /** Set when the first operand names a subcommand: nothing after it is a session option. */
  subcommand?: string;
}

/** commander's `maybeOption`: a token that parses as an option rather than a value. */
function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/**
 * Read which session Claude Code will open from its argv, the way its option parser would (see the
 * section header). Pure, and never mutates `args` — the launcher spawns the caller's array as is.
 */
export function parseClaudeSessionArgs(args: readonly string[]): ClaudeSessionArgs {
  const out: ClaudeSessionArgs = { continue: false, fork: false };
  let sawOperand = false;
  let variadic = false;
  // Tokens still to read, front first. Combined short flags push their expansion back onto it, the
  // way commander unshifts `-${rest}`.
  const queue = [...args];
  const next = (): string | undefined => queue.shift();

  /** Apply one option by name, with its attached value if it had one (`--x=v`, `-xv`). */
  const apply = (name: string, attached: string | undefined): void => {
    const takeRequired = (): string | undefined => attached ?? next();
    const takeOptional = (): string | undefined => {
      if (attached !== undefined) return attached;
      const peek = queue[0];
      return peek !== undefined && !looksLikeOption(peek) ? next() : undefined;
    };
    if (name === '--resume' || name === '-r') {
      out.resume = takeOptional() ?? null;
    } else if (name === '--continue' || name === '-c') {
      out.continue = true;
    } else if (name === '--fork-session') {
      out.fork = true;
    } else if (name === '--name' || name === '-n') {
      const v = takeRequired();
      if (v !== undefined) out.name = v;
    } else if (name === '--session-id') {
      const v = takeRequired();
      if (v !== undefined) out.sessionId = v;
    } else if (REQUIRED_VALUE_OPTIONS.has(name)) {
      takeRequired();
    } else if (VARIADIC_OPTIONS.has(name)) {
      takeRequired();
      variadic = true;
    } else if (OPTIONAL_VALUE_OPTIONS.has(name)) {
      takeOptional();
    }
    // Anything else is read as a boolean flag.
  };

  for (let token = next(); token !== undefined; token = next()) {
    if (token === '--') break; // everything after is an operand (the prompt)
    if (variadic && !looksLikeOption(token)) continue; // a further value of a variadic option
    variadic = false;
    if (token.startsWith('--')) {
      const eq = token.indexOf('=');
      apply(eq === -1 ? token : token.slice(0, eq), eq === -1 ? undefined : token.slice(eq + 1));
    } else if (looksLikeOption(token)) {
      const flag = token.slice(0, 2);
      const rest = token.slice(2);
      const takesValue =
        REQUIRED_VALUE_OPTIONS.has(flag) ||
        VARIADIC_OPTIONS.has(flag) ||
        OPTIONAL_VALUE_OPTIONS.has(flag);
      if (rest === '') {
        apply(flag, undefined);
      } else if (takesValue) {
        apply(flag, rest); // -rVALUE: the rest is the value, verbatim (so -r=v is the value "=v")
      } else {
        apply(flag, undefined);
        queue.unshift(`-${rest}`); // -pc: -p, then -c
      }
    } else {
      // An operand. The FIRST one may name a subcommand, which owns every token after it.
      if (!sawOperand && CLAUDE_SUBCOMMANDS.has(token)) {
        out.subcommand = token;
        break;
      }
      sawOperand = true;
    }
  }
  return out;
}

/** What {@link resolveLaunchAlias} needs to look sessions up (the daemon's session catalog). */
export interface LaunchAliasDeps {
  /** The CUSTOM title of the session with this id, or null (unknown session, or unnamed). */
  customTitleById: (sessionId: string) => Promise<string | null>;
  /** The CUSTOM title of the most recently active session in the launch folder, or null. */
  latestCustomTitleInFolder: () => Promise<string | null>;
}

/** A session id as Claude Code writes it (a UUID). */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The custom title the launched session will carry — the alias the precedence rule is asked about —
 * or null for an unnamed / unknown target:
 *   - a subcommand opens no session: null;
 *   - `--name v` names it v (also on a resume or a fork: the name is what its prompts will report);
 *   - `--resume <uuid>` -> that session's custom title (the catalog); `--resume <v>` -> v itself
 *     (Claude Code resumes the session whose title matches v; a picker opens when none or several
 *     do, and the guard judges whatever is picked); a bare `--resume` (the picker) -> null;
 *   - `--continue` -> the most recent session in the folder's custom title;
 *   - `--session-id <uuid>` alone -> that session's title if it exists (else a new, unnamed one).
 * `--fork-session` changes nothing: a fork keeps its parent's title.
 */
export async function resolveLaunchAlias(
  parsed: ClaudeSessionArgs,
  deps: LaunchAliasDeps,
): Promise<string | null> {
  if (parsed.subcommand !== undefined) return null;
  if (parsed.name !== undefined) return parsed.name;
  if (parsed.resume !== undefined) {
    if (parsed.resume === null) return null;
    const value = parsed.resume.trim();
    return SESSION_UUID.test(value) ? deps.customTitleById(value) : parsed.resume;
  }
  if (parsed.continue) return deps.latestCustomTitleInFolder();
  if (parsed.sessionId !== undefined && SESSION_UUID.test(parsed.sessionId.trim())) {
    return deps.customTitleById(parsed.sessionId.trim());
  }
  return null;
}

// ---------------------------------------------------------------------------
// Spawning
// ---------------------------------------------------------------------------

/** The minimal signal seam so the ignore-during-child behavior is testable without sending real
 *  signals to the test runner. */
export interface SignalSeam {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

export interface SpawnClaudeDeps {
  spawn?: typeof nodeSpawn;
  signals?: SignalSeam;
  platform?: NodeJS.Platform;
}

/**
 * Run the resolved target as a child that inherits this process's stdio (Claude Code is an
 * interactive TUI), and resolve with its exit code. While the child runs, the PARENT installs
 * no-op handlers for SIGINT (and SIGBREAK on Windows): a console Ctrl-C is delivered to the whole
 * group, and the parent must not tear itself down before the child has handled it and exited —
 * otherwise the terminal is left to a half-exited child. The handlers are removed the instant the
 * child closes. A child killed by a signal maps to the conventional 128+signal exit code.
 */
export function spawnClaude(opts: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  deps?: SpawnClaudeDeps;
}): Promise<number> {
  const spawn = opts.deps?.spawn ?? nodeSpawn;
  const signals: SignalSeam = opts.deps?.signals ?? process;
  const platform = opts.deps?.platform ?? process.platform;

  const child: ChildProcess = spawn(opts.command, opts.args, {
    stdio: 'inherit',
    env: opts.env,
    shell: false,
    windowsHide: false,
  });

  const ignore = (): void => {
    // Intentionally empty: swallow the signal in the parent; the child owns Ctrl-C.
  };
  const watched: NodeJS.Signals[] = platform === 'win32' ? ['SIGINT', 'SIGBREAK'] : ['SIGINT'];
  for (const sig of watched) signals.on(sig, ignore);
  const restore = (): void => {
    for (const sig of watched) signals.off(sig, ignore);
  };

  return new Promise<number>((resolve, reject) => {
    child.on('error', (err) => {
      restore();
      reject(err);
    });
    child.on('close', (code, signal) => {
      restore();
      if (typeof code === 'number') {
        resolve(code);
        return;
      }
      // Killed by a signal, no numeric code: the shell convention is 128 + signal number.
      const signalNumbers: Record<string, number> = { SIGINT: 2, SIGTERM: 15, SIGBREAK: 21 };
      resolve(signal ? 128 + (signalNumbers[signal] ?? 0) : 1);
    });
  });
}
