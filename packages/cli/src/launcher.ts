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
// characters above. That entry hop is closed by the PowerShell shell-init wrapper (see
// shellInit.ts), which invokes the node entry directly and skips the .cmd shim.
//
// The functions here are split so the decisions are unit-testable in isolation from the spawn:
// findClaudeOnPath (PATH lookup), resolveLaunchTarget (how to invoke a candidate), buildLaunchEnv
// (the child env), configDirPointsIntoProfiles (the one env deletion rule), and spawnClaude (the
// process itself, with an injectable signal seam).

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { existsSync as nodeExistsSync, readFileSync as nodeReadFileSync } from 'node:fs';
import { extname, isAbsolute, posix, win32 } from 'node:path';
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
 * Find the `claude` command on PATH. On Windows the search PREFERS a standalone `claude.exe` over a
 * `claude.cmd` shim (the exe needs no unwrapping), then falls back to any other PATHEXT match so the
 * caller can report exactly what it found and why it will not run it. On POSIX it looks for an
 * executable named `claude` (a shebang script or symlink runs fine under spawn). Returns the
 * resolved path WITH extension, or undefined when nothing matches.
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
  // Windows: split PATHEXT so we can prefer .exe, then .cmd, then anything else.
  const exts = (deps.pathExt ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  const preferenceOrder = ['.exe', '.cmd', ...exts.filter((e) => e !== '.exe' && e !== '.cmd')];
  for (const ext of preferenceOrder) {
    for (const dir of dirs) {
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
  // A quoted absolute entry path anywhere in the shim.
  const abs = cmdText.match(/"([A-Za-z]:\\[^"\r\n]*?\.(?:c|m)?js)"/);
  if (abs && abs[1] && isAbsolute(abs[1])) {
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
  /** --account: mark the launch as an explicit account choice (relaxes the guard's case B). */
  explicit: boolean;
  /** --override: allow a session in a folder bound to a DIFFERENT account (relaxes case A). */
  override: boolean;
  /** For a global slot: whether an inherited CLAUDE_CONFIG_DIR points into the profiles root and so
   *  must be dropped (see {@link configDirPointsIntoProfiles}). Ignored for a group slot. */
  dropInheritedConfigDir: boolean;
}

/**
 * Build the child environment for a launch. A group slot pins CLAUDE_CONFIG_DIR to the group's
 * profile (that IS the account). A global slot inherits the parent env untouched EXCEPT that a
 * CLAUDE_CONFIG_DIR pointing into the profiles root is dropped — otherwise a launch from a shell
 * that still has a previous `cctl claude` group session's var set would silently reuse that group's
 * account instead of the global one. CCTL_LAUNCH_EXPLICIT / CCTL_BIND_OVERRIDE are the guard's
 * relaxation knobs, set from --account / --override.
 */
export function buildLaunchEnv(opts: BuildLaunchEnvOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...opts.baseEnv };
  // Start from a clean guard state so an inherited knob never leaks into this launch.
  delete env.CCTL_LAUNCH_EXPLICIT;
  delete env.CCTL_BIND_OVERRIDE;

  if (opts.slot.kind === 'group') {
    env.CLAUDE_CONFIG_DIR = opts.slot.profileDir;
    if (opts.explicit) env.CCTL_LAUNCH_EXPLICIT = '1';
  } else if (opts.dropInheritedConfigDir) {
    delete env.CLAUDE_CONFIG_DIR;
  }
  if (opts.override) env.CCTL_BIND_OVERRIDE = '1';
  return env;
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
