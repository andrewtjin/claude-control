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
// (the child env), configDirPointsIntoProfiles (the one env deletion rule), parseClaudeSessionArgs
// and resolveLaunchSessions (which session Claude Code's own arguments open, over an injectable
// session lookup), and spawnClaude (the process itself, with an injectable signal seam).

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { extname, posix, win32 } from 'node:path';
import { aliasKey, canonicalizeFolder, isWithin } from '@claude-control/switch-engine';

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
// The parse mirrors how Claude Code 2.1.283 consumes the same argv, because a misread is exactly how
// a flag VALUE would be taken for a flag: `--append-system-prompt --resume` passes the text
// "--resume" as a prompt, it does not resume anything. First come the paths Claude Code decides
// before its option parser runs: a first word naming a fast path (`claude rc`, `claude logs`, ...),
// `daemon`, and `--bg`/`--background` anywhere. Then its option parser's (commander's) rules: an
// option with a REQUIRED value takes the next token whatever it looks like; an OPTIONAL value
// (`--resume [value]`) takes the next token only when it does not look like an option; a VARIADIC
// option keeps taking tokens that do not look like options; `--x=v` and short `-xVALUE` attach the
// value; combined short booleans (`-pc`) expand; `--` ends option parsing; and a first operand naming
// a subcommand (`claude mcp add --name x`) hands everything after it to that subcommand, which opens
// no session.
//
// The tables are Claude Code 2.1.283's full top-level option set. An option they do not list may be
// one a newer Claude Code added, and nothing says whether it takes a value — so when one appears
// before a session option, the parse refuses to guess (`uncertain`). The launcher then routes by the
// folder rule alone and says so on stderr, and the enforcement guard judges the session Claude Code
// actually opens.

/** How a top-level option consumes the tokens after it (commander's arities). */
type OptionArity = 'boolean' | 'required' | 'variadic' | 'optional';

/** Options whose value is REQUIRED: the next token is always consumed. Claude Code's own argv
 *  pre-scan table, plus two value options only its option parser defines (`--project-config-root`,
 *  `--attach-serve`). The variadic ones are listed separately below. */
const REQUIRED_VALUE_OPTIONS = [
  '--prefill',
  '--prefill-b64',
  '--deep-link-repo',
  '--deep-link-last-fetch',
  '--deep-link-cwd-b64',
  '--handle-uri',
  '--settings',
  '--managed-settings',
  '--setting-sources',
  '--client-data-url',
  '--watch-artifact',
  '--watch-artifact-no-autoreact',
  '--team-name',
  '--agent-id',
  '--agent-name',
  '--agent-color',
  '--parent-session-id',
  '--agent-type',
  '--model',
  '--agent',
  '--routine',
  '--effort',
  '--permission-mode',
  '--inherit-permission-mode',
  '--proactivity',
  '--debug-file',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file',
  '--plan-mode-instructions',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--json-schema',
  '--fallback-model',
  '--advisor',
  '--agents',
  '--name',
  '-n',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--plugin-url',
  '--remote-control-session-name-prefix',
  '--sdk-url',
  '--exec',
  '-m',
  '--thinking',
  '--thinking-display',
  '--max-thinking-tokens',
  '--max-turns',
  '--max-budget-usd',
  '--task-budget',
  '--autocompact',
  '--rewind-files',
  '--resume-session-at',
  '--resume-drops-turn',
  '--workload',
  '--output-format',
  '--input-format',
  '--teammate-mode',
  '--messaging-socket-path',
  '--session-id',
  '--environment',
  '--pool',
  '--ref',
  '--on-branch',
  '--correlation-id',
  '--forward-home-settings',
  '--project-config-root',
  '--attach-serve',
] as const;

/** VARIADIC options: a required first value, then every further token that does not look like an
 *  option is a value too. */
const VARIADIC_OPTIONS = [
  '--allowedTools',
  '--allowed-tools',
  '--disallowedTools',
  '--disallowed-tools',
  '--tools',
  '--add-dir',
  '--mcp-config',
  '--betas',
  '--file',
  '--channels',
  '--dangerously-load-development-channels',
] as const;

/** Options whose value is OPTIONAL: the next token is taken only when it does not look like an
 *  option (commander: a token of length > 1 starting with '-'). */
const OPTIONAL_VALUE_OPTIONS = [
  '-d',
  '--debug',
  '-r',
  '--resume',
  '--from-pr',
  '-w',
  '--worktree',
  '--teleport',
  '--cloud',
  '--remote',
  '--project',
  '--remote-control',
  '--rc',
  '--prompt-suggestions',
] as const;

/** Options that take no value. `-d2e` is one whole short flag, which is why exact tokens are
 *  matched before a short token is split into combined flags. */
const BOOLEAN_OPTIONS = [
  '-d2e',
  '--debug-to-stderr',
  '--verbose',
  '-p',
  '--print',
  '--bare',
  '--safe-mode',
  '--init',
  '--init-only',
  '--maintenance',
  '--include-hook-events',
  '--include-partial-messages',
  '--forward-subagent-text',
  '--session-mirror',
  '--await-claim',
  '--await-initialize',
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--replay-user-messages',
  '--enable-auth-status',
  '--restricted',
  '--exclude-dynamic-system-prompt-sections',
  '-c',
  '--continue',
  '--fork-session',
  '--deep-link-origin',
  '--no-session-persistence',
  '--reply-on-resume',
  '--ide',
  '--strict-mcp-config',
  '--disable-slash-commands',
  '--chrome',
  '--no-chrome',
  '--tmux',
  '--enable-auto-mode',
  '--bg',
  '--background',
  '--brief',
  '--ax-screen-reader',
  '--plan-mode-required',
  '-h',
  '--help',
  '-v',
  '--version',
] as const;

/**
 * Every known top-level option with its arity, built once from the lists above. An option listed
 * twice would make the parse depend on list order, so a duplicate is a programming error that fails
 * the module load (and with it every test that imports it) rather than silently picking one.
 */
const OPTION_ARITY: ReadonlyMap<string, OptionArity> = (() => {
  const table = new Map<string, OptionArity>();
  const add = (names: readonly string[], arity: OptionArity): void => {
    for (const name of names) {
      if (table.has(name)) throw new Error(`launcher option table lists ${name} twice`);
      table.set(name, arity);
    }
  };
  add(REQUIRED_VALUE_OPTIONS, 'required');
  add(VARIADIC_OPTIONS, 'variadic');
  add(OPTIONAL_VALUE_OPTIONS, 'optional');
  add(BOOLEAN_OPTIONS, 'boolean');
  return table;
})();

/** Claude Code's root subcommands (with their aliases): a FIRST operand naming one hands every token
 *  after it to that subcommand, which opens no session. Words like `login`, `config` or `eval` are
 *  not commands in 2.1.283 — there they are prompt text, and the session still opens. */
const ROOT_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'gateway',
  'auth',
  'project',
  'setup-token',
  'agents',
  'ultrareview',
  'auto-mode',
  'remote-control',
  'rc',
  'doctor',
  'sandbox',
  'update',
  'upgrade',
  'install',
  'import',
  'import-conversations',
  'mcp',
  'plugin',
  'plugins',
]);

/** First words Claude Code routes BEFORE its option parser runs — decided on the very first token
 *  only, so the same word later in the argv is ordinary text. None of them opens a session here. */
const FAST_PATH_COMMANDS: ReadonlySet<string> = new Set([
  'remote-control',
  'rc',
  'remote',
  'sync',
  'bridge',
  'logs',
  'attach',
  'stop',
  'kill',
  'respawn',
  'rm',
]);

/** Leading flags Claude Code skips when it looks for the `daemon` fast path. */
const DAEMON_LEADING_FLAGS: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
]);

/** Flags that send the launch down Claude Code's background-session path, wherever they appear. */
const BACKGROUND_FLAGS: ReadonlySet<string> = new Set(['--bg', '--background']);

/** A token that can be (or, inside a combined short token, contain) one of the options that decide
 *  which session opens. Used only to judge whether an unrecognized option could have swallowed one,
 *  so it errs toward "yes": any short token carrying a c, r or n letter counts. */
const SESSION_LONG_OPTION = /^--(?:resume|continue|name|session-id|fork-session)(?:=|$)/;
function looksLikeSessionOption(token: string): boolean {
  if (SESSION_LONG_OPTION.test(token)) return true;
  return /^-[^-]/.test(token) && /[crn]/.test(token.slice(1));
}

/** The longest option name quoted back in the uncertainty note — enough to recognize it, never a
 *  wall of operator text. */
const NOTE_OPTION_MAX = 40;

/** What Claude Code's arguments say about the session a launch opens. */
export interface ClaudeSessionArgs {
  /** `--resume/-r`: the value (a session id, a transcript path or a title), `null` for a bare
   *  `--resume` (the picker), absent when not resuming. Last occurrence wins, as in commander. */
  resume?: string | null;
  /** `--continue/-c`: the most recent session in the folder. It beats `--resume` when both are
   *  given — Claude Code checks it first. */
  continue: boolean;
  /** `--name/-n <name>`: the new session's (or the opened one's new) custom title. An empty name
   *  names nothing, so `--name ""` leaves this absent. */
  name?: string;
  /** `--session-id <uuid>`. */
  sessionId?: string;
  /** `--fork-session`: the resumed or continued conversation is copied into a NEW session of the
   *  launch folder (a new id, the same title; measured: a fork of a session recorded in `repo/sub`,
   *  launched from `repo`, is written to repo's project directory with every cwd rewritten to
   *  `repo`). So a fork belongs to the folder it is launched in, not to the one it came from. */
  fork: boolean;
  /** `-p` / `--print`: a non-interactive run. Its `--resume <title>` search also finds sessions
   *  created by `-p` or the SDK, which the interactive search leaves out. */
  print?: true;
  /** Set when no session opens: the first operand names a subcommand, or the first word is one of
   *  Claude Code's fast paths. */
  subcommand?: string;
  /** Set when the arguments do not say for certain which session opens (an unrecognized option
   *  before a session option, or the background path): a short, human reason. */
  uncertain?: string;
}

/** commander's `maybeOption`: a token that parses as an option rather than a value. */
function looksLikeOption(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/**
 * Read which session Claude Code will open from its argv, the way Claude Code itself would (see the
 * section header). Pure, and never mutates `args` — the launcher spawns the caller's array as is.
 */
export function parseClaudeSessionArgs(args: readonly string[]): ClaudeSessionArgs {
  const out: ClaudeSessionArgs = { continue: false, fork: false };

  // Paths Claude Code takes before its option parser ever sees the argv.
  const first = args[0];
  if (first !== undefined && FAST_PATH_COMMANDS.has(first)) return { ...out, subcommand: first };
  const afterLeadingFlags = args.find((t) => !DAEMON_LEADING_FLAGS.has(t));
  if (afterLeadingFlags === 'daemon') return { ...out, subcommand: 'daemon' };
  const background = args.find((t) => BACKGROUND_FLAGS.has(t));
  if (background !== undefined) {
    return { ...out, uncertain: `"${background}" starts a background session` };
  }

  let sawOperand = false;
  let variadic = false;
  /** The first token no table recognizes, with its position in `args`. */
  let unrecognized: { token: string; index: number } | undefined;
  // Tokens still to read, front first, each with its position in `args`. A combined short token
  // pushes its remainder back onto the front, the way commander unshifts `-${rest}`.
  const queue = args.map((token, index) => ({ token, index }));
  const next = (): { token: string; index: number } | undefined => queue.shift();

  /** Apply one known option, with its attached value if it had one (`--x=v`, `-xv`). */
  const apply = (name: string, arity: OptionArity, attached: string | undefined): void => {
    let value: string | null = null;
    if (arity === 'required' || arity === 'variadic') {
      // A missing value is a Claude Code usage error (nothing opens); null records "no value".
      value = attached ?? next()?.token ?? null;
      // Only a value in its own token keeps a variadic option collecting: commander's `--x=v`
      // branch never re-arms it.
      variadic = arity === 'variadic' && attached === undefined;
    } else if (arity === 'optional') {
      if (attached !== undefined) value = attached;
      else if (queue[0] !== undefined && !looksLikeOption(queue[0].token)) value = next()!.token;
    }
    if (name === '--resume' || name === '-r') out.resume = value;
    else if (name === '--continue' || name === '-c') out.continue = true;
    else if (name === '--fork-session') out.fork = true;
    else if (name === '-p' || name === '--print') out.print = true;
    else if ((name === '--name' || name === '-n') && value !== null) out.name = value;
    else if (name === '--session-id' && value !== null) out.sessionId = value;
  };

  for (let item = next(); item !== undefined; item = next()) {
    const { token, index } = item;
    if (token === '--') {
      // Everything after is an operand — and commander still dispatches a subcommand named by the
      // first operand, even one that follows `--`.
      const following = queue[0]?.token;
      if (!sawOperand && following !== undefined && ROOT_SUBCOMMANDS.has(following)) {
        out.subcommand = following;
      }
      break;
    }
    if (variadic && !looksLikeOption(token)) continue; // a further value of a variadic option
    variadic = false;

    if (!looksLikeOption(token)) {
      // An operand. The FIRST one may name a subcommand, which owns every token after it.
      if (!sawOperand && ROOT_SUBCOMMANDS.has(token)) {
        out.subcommand = token;
        break;
      }
      sawOperand = true;
      continue;
    }

    // An exact known token first: that is how `-d2e` stays one flag rather than `-d` + "2e".
    const exact = OPTION_ARITY.get(token);
    if (exact !== undefined) {
      apply(token, exact, undefined);
      continue;
    }
    if (token.startsWith('--')) {
      // `--x=v` attaches a value only to an option that takes one; `--bool=v` is not an option.
      const eq = token.indexOf('=');
      const arity = eq > 2 ? OPTION_ARITY.get(token.slice(0, eq)) : undefined;
      if (arity !== undefined && arity !== 'boolean') {
        apply(token.slice(0, eq), arity, token.slice(eq + 1));
        continue;
      }
    } else {
      // A combined short token: its first letter decides. A value-taking flag takes the rest
      // verbatim (so `-r=x` resumes "=x"); a boolean flag hands the rest back as `-${rest}`.
      const flag = token.slice(0, 2);
      const arity = OPTION_ARITY.get(flag);
      if (arity !== undefined) {
        if (arity === 'boolean') {
          apply(flag, arity, undefined);
          queue.unshift({ token: `-${token.slice(2)}`, index });
        } else {
          apply(flag, arity, token.slice(2));
        }
        continue;
      }
    }
    // Not an option these tables know. commander reads it as a boolean; remember the first one.
    unrecognized ??= { token, index };
  }

  // An empty name names nothing (measured: `--name "" --resume X` keeps X's title).
  if (out.name === '') delete out.name;

  // An unrecognized option may take a value in the Claude Code actually installed; if a session
  // option follows it (or hides in its own combined letters), that option may have been swallowed
  // as the value, and the parse cannot tell which session opens.
  if (unrecognized !== undefined) {
    const { token, index } = unrecognized;
    const ownLetters = !token.startsWith('--') && /[crn]/.test(token.slice(2));
    if (ownLetters || args.slice(index + 1).some(looksLikeSessionOption)) {
      const name = token.startsWith('--') ? token.split('=', 1)[0]! : token.slice(0, 2);
      const shown = name.length > NOTE_OPTION_MAX ? `${name.slice(0, NOTE_OPTION_MAX)}...` : name;
      out.uncertain = `unrecognized option "${shown}"`;
    }
  }
  return out;
}

/** What the launcher knows about one Claude Code session: its titles, from Claude Code's own quick
 *  read of its transcript, and the folder its conversation belongs to, from the one recorded-folder
 *  reading every consumer of an alias binding uses (switch-engine readRecordedFolder; see
 *  launchSessionStore.ts). */
export interface LaunchSessionFacts {
  /** The last custom title (`/rename`, `--name`); null when none is recorded. */
  customTitle: string | null;
  /** The last generated title; null when none is recorded. */
  aiTitle: string | null;
  /** The folder the conversation belongs to, as recorded and trusted (readRecordedFolder's
   *  `folder`); null when none is. */
  folder: string | null;
  /** How the session was started, as its first line recording one says (`cli` interactively,
   *  `sdk-cli` for `-p` or the SDK); absent when the quick read sees none. */
  entrypoint?: string;
  /** The project directory the transcript lives in: with no trusted folder, it stands for the launch
   *  folder when it can (recordedFolderFor). Absent = unknown, so no fallback applies. */
  dirName?: string;
}

/**
 * The session lookups {@link resolveLaunchSessions} needs: Claude Code's own session search,
 * reproduced over its transcripts. launchSessionStore.ts implements it; tests pass stand-ins. Every
 * lookup is relative to the launch folder the implementation was built for.
 */
export interface LaunchSessionDeps {
  /** `--resume <uuid>` / `--session-id <uuid>`: the session with this id, or null when none. */
  sessionById(sessionId: string): Promise<LaunchSessionFacts | null>;
  /** `--resume <absolute .jsonl path>`: that transcript, or null when it cannot be read. */
  sessionAtPath(file: string): Promise<LaunchSessionFacts | null>;
  /** `--resume <text>`: every session Claude Code's title search can match, from the launch folder
   *  (any number: one resumes it, several open a picker, none opens the picker empty). */
  sessionsTitled(text: string): Promise<LaunchSessionFacts[]>;
  /** `--continue`: the session(s) it may open — more than one when the newest transcript belongs to
   *  another folder, and none when the launcher cannot name it. */
  continueSessions(): Promise<LaunchSessionFacts[]>;
}

/** One session a launch may open, as the precedence rule reads it. */
export interface LaunchCandidate {
  /** Its custom title once open (a `--name` renames it); null = unnamed. */
  title: string | null;
  /** The folder its conversation belongs to: the recorded one of an existing session, the launch
   *  folder for a new session or a fork; null = none is recorded (see {@link dirName}). */
  folder: string | null;
  /** An existing session's project directory, the fallback when no folder is recorded (see
   *  {@link LaunchSessionFacts.dirName}). */
  dirName?: string;
}

/** Which session(s) a launch may open. `candidates` empty = no session opens, or the launcher
 *  cannot name the one that will (a picker, an unknown id): either way the folder rule applies. */
export type LaunchSessions =
  { kind: 'candidates'; candidates: LaunchCandidate[] } | { kind: 'uncertain'; reason: string };

/** What {@link resolveLaunchSessions} needs besides the lookups. */
export interface LaunchSessionContext {
  /** The folder the launch runs in: where a NEW session's conversation belongs. */
  launchFolder: string;
  /** Every alias key some binding holds. A title outside it cannot route by alias, which lets a
   *  resume skip reading transcripts entirely. */
  boundAliasKeys: ReadonlySet<string>;
  platform: NodeJS.Platform;
}

/** A session id as Claude Code writes it (a UUID). */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether `--resume <value>` names a transcript file: Claude Code's own rule, an absolute path
 *  ending in `.jsonl` (resumed from that file, never matched as a title). */
function isTranscriptPath(value: string, platform: NodeJS.Platform): boolean {
  const path = platform === 'win32' ? win32 : posix;
  return path.isAbsolute(value) && value.endsWith('.jsonl');
}

/** A custom title that names a session (non-blank), or null. */
function namedTitle(title: string | null): string | null {
  return title !== null && title.trim() !== '' ? title : null;
}

/** No session the launcher can name: the folder rule decides. */
const FOLDER_RULE: LaunchSessions = { kind: 'candidates', candidates: [] };

/** The entrypoint Claude Code records for a session started by `-p` or the SDK. */
const SDK_ENTRYPOINT = 'sdk-cli';

/**
 * The session(s) a launch opens, as Claude Code will pick them — each with the title it will carry
 * and the folder its conversation belongs to:
 *   - a subcommand or fast path opens none; an uncertain parse is reported, never guessed;
 *   - `--continue` wins over `--resume` (Claude Code checks it first): its session(s);
 *   - `--resume <uuid>` / `<absolute .jsonl>`: that session; a bare `--resume`, or a title that is
 *     blank, opens the picker (none nameable); `--resume <title>`: every session Claude Code's title
 *     search matches — one resumes, several open a picker the enforcement guard then judges;
 *   - `--session-id <uuid>` alone: that session if it exists, else a new one;
 *   - otherwise a new session, recorded in the launch folder.
 * `--name v` renames whatever opens to v. `--fork-session` copies what `--continue` / `--resume`
 * opens into a NEW conversation of the launch folder under the same title, so a fork's folder is the
 * launch folder, whatever folder it was forked from — exactly what the enforcement guard sees once
 * the fork runs. A match found only by its GENERATED title opens as an unnamed session (only a custom
 * title binds).
 *
 * Reads are skipped whenever no title the launch can end up with is bound: a `--name` bound nowhere
 * settles every candidate before anything is read, and so does a resume title bound nowhere.
 */
export async function resolveLaunchSessions(
  parsed: ClaudeSessionArgs,
  deps: LaunchSessionDeps,
  context: LaunchSessionContext,
): Promise<LaunchSessions> {
  if (parsed.uncertain !== undefined) return { kind: 'uncertain', reason: parsed.uncertain };
  if (parsed.subcommand !== undefined) return FOLDER_RULE;
  const name = parsed.name;
  const isBound = (title: string): boolean => context.boundAliasKeys.has(aliasKey(title));
  if (name !== undefined && !isBound(name)) return FOLDER_RULE;

  /** An existing session as it will open: renamed by --name, else under its own custom title; in
   *  its own recorded folder, or — forked — as a new conversation of the launch folder. */
  const fork = parsed.fork && (parsed.continue || parsed.resume !== undefined);
  const opened = (s: LaunchSessionFacts): LaunchCandidate => {
    const title = name ?? namedTitle(s.customTitle);
    if (fork) return { title, folder: context.launchFolder };
    return { title, folder: s.folder, ...(s.dirName !== undefined ? { dirName: s.dirName } : {}) };
  };
  const found = (s: LaunchSessionFacts | null): LaunchSessions => ({
    kind: 'candidates',
    candidates: s === null ? [] : [opened(s)],
  });

  if (parsed.continue) {
    return { kind: 'candidates', candidates: (await deps.continueSessions()).map(opened) };
  }
  if (parsed.resume !== undefined) {
    if (parsed.resume === null) return FOLDER_RULE; // the picker
    const value = parsed.resume;
    if (SESSION_UUID.test(value.trim())) return found(await deps.sessionById(value.trim()));
    if (isTranscriptPath(value, context.platform)) return found(await deps.sessionAtPath(value));
    if (aliasKey(value) === '') return FOLDER_RULE; // a blank title matches nothing: the picker
    // Every match opens under its own custom title, whose key IS the resume text's: unbound there,
    // no match can route by alias, so none needs reading.
    if (name === undefined && !isBound(value)) return FOLDER_RULE;
    const matches = await deps.sessionsTitled(value);
    // Interactively, Claude Code's title search leaves out sessions started by `-p` or the SDK
    // (measured: its picker reports no match for them); a `-p` launch finds them.
    const reachable =
      parsed.print === true ? matches : matches.filter((s) => s.entrypoint !== SDK_ENTRYPOINT);
    return { kind: 'candidates', candidates: reachable.map(opened) };
  }
  if (parsed.sessionId !== undefined) {
    const id = parsed.sessionId.trim();
    if (!SESSION_UUID.test(id)) return FOLDER_RULE; // Claude Code refuses a malformed id
    const existing = await deps.sessionById(id);
    if (existing !== null) return found(existing);
  }
  return {
    kind: 'candidates',
    candidates: [{ title: name ?? null, folder: context.launchFolder }],
  };
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
