// macOS launchd LaunchAgent lifecycle for `cctl daemon install|uninstall` — the darwin
// counterpart of daemonInstall.ts's Windows Scheduled Task.
//
// A per-user LaunchAgent (not a LaunchDaemon) for the same reason the Windows task is
// logon-scoped: Keychain access to the vault key is login-keychain-scoped, so the daemon must
// run inside the user's GUI session. The plist lives at
// `~/Library/LaunchAgents/com.claude-control.daemon.plist` and is loaded/unloaded with the
// modern `launchctl bootstrap|bootout gui/<uid>` verbs.
//
// Idempotent by construction, same as installDaemonTask: the desired plist text is rendered
// first and compared against what is already on disk — identical content is 'unchanged' and
// runs no launchctl at all; changed content is rewritten and re-bootstrapped.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join, posix } from 'node:path';

export const DAEMON_AGENT_LABEL = 'com.claude-control.daemon';

/** How this module runs `launchctl`. Injected so every code path unit-tests without touching
 *  a real launchd (mirrors daemonInstall.ts's PowerShellRunner seam). */
export type LaunchctlRunner = (args: string[]) => string;

export const defaultLaunchctlRunner: LaunchctlRunner = (args) =>
  execFileSync('launchctl', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();

/** Filesystem seam, so the plist read/compare/write logic unit-tests in memory. */
export interface PlistFs {
  read(path: string): string | undefined;
  write(path: string, content: string): void;
  remove(path: string): void;
}

const defaultPlistFs: PlistFs = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
  },
  write(path, content) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
  },
};

/** Where launchd expects a per-user agent. Joined as a POSIX path on every platform: this is a
 *  macOS location by definition, so the platform separator would only ever be wrong — it turns
 *  `/Users/u/...` into backslashes when the code merely runs on Windows (as its tests do). */
export function daemonAgentPlistPath(home: string = homedir()): string {
  return posix.join(home, 'Library', 'LaunchAgents', `${DAEMON_AGENT_LABEL}.plist`);
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The LaunchAgent plist body. The agent invokes the npm shim by ABSOLUTE path with an explicit
 * PATH containing the shim's own bin directory: launchd jobs inherit a minimal PATH, and the
 * shim re-execs `node` (and the daemon spawns `claude`) by bare name, so both must resolve
 * from the shim's directory. `KeepAlive` is deliberately false — the daemon's control-plane
 * client already retries forever, and `cctl daemon supervise` exists for process-level
 * restarts; a launchd restart loop on a fundamentally broken install would fight both.
 */
export function renderDaemonAgentPlist(shimPath: string, logPath: string): string {
  const binDir = dirname(shimPath);
  const path = `${binDir}:/usr/local/bin:/usr/bin:/bin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(DAEMON_AGENT_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(shimPath)}</string>
    <string>daemon</string>
    <string>run</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xmlEscape(path)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <false/>
  <key>StandardOutPath</key>
  <string>${xmlEscape(logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(logPath)}</string>
</dict>
</plist>
`;
}

export type DaemonAgentOutcome = 'created' | 'updated' | 'unchanged';

export interface InstallDaemonAgentOptions {
  /** Absolute path to the cctl shim (see resolveCctlShimPath). */
  shimPath: string;
  run?: LaunchctlRunner;
  fs?: PlistFs;
  plistPath?: string;
  logPath?: string;
  uid?: number;
}

/** True when launchctl failed only because the job was not loaded — the normal state before
 *  the first bootstrap (`bootout` of an absent job) or after a manual bootout. */
function isNotLoaded(err: unknown): boolean {
  // execFileSync attaches the child's stderr under `stderr` (a string here — the runner sets
  // `encoding: 'utf8'`); tolerate other shapes rather than stringifying an object to noise.
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = `${(err as Error)?.message ?? ''}${typeof stderr === 'string' ? stderr : ''}`;
  return /No such process|not find|5: input\/output error|113/i.test(text);
}

/**
 * Write (or rewrite) the LaunchAgent plist and bootstrap it. Content-compared first so a
 * repeated `cctl daemon install` is a no-op; a changed plist (e.g. npm reinstalled to a new
 * prefix) is booted out and re-bootstrapped so launchd picks up the new definition.
 * `RunAtLoad` means a successful bootstrap also STARTS the daemon — no separate start step,
 * unlike the Windows path. Its own instance lock makes a redundant start harmless.
 */
export function installDaemonAgent(options: InstallDaemonAgentOptions): DaemonAgentOutcome {
  const run = options.run ?? defaultLaunchctlRunner;
  const fs = options.fs ?? defaultPlistFs;
  const plistPath = options.plistPath ?? daemonAgentPlistPath();
  const logPath = options.logPath ?? join(homedir(), 'Library', 'Logs', 'claude-control.log');
  const uid = options.uid ?? userInfo().uid;

  const desired = renderDaemonAgentPlist(options.shimPath, logPath);
  const existing = fs.read(plistPath);
  if (existing === desired) return 'unchanged';

  fs.write(plistPath, desired);
  // Re-bootstrap: launchd caches the definition it loaded, so a content change must bootout
  // first. An absent job is the normal first-install case — swallowed, everything else thrown.
  try {
    run(['bootout', `gui/${uid}/${DAEMON_AGENT_LABEL}`]);
  } catch (err) {
    if (!isNotLoaded(err)) throw err;
  }
  run(['bootstrap', `gui/${uid}`, plistPath]);
  return existing === undefined ? 'created' : 'updated';
}

/** Same shape as daemonInstall.ts's DaemonTaskQuery so `cctl daemon status` renders both
 *  platforms through one code path. `execute` is recovered from the plist's first
 *  ProgramArguments string; `state` reflects whether launchd currently has the job loaded. */
export interface DaemonAgentQuery {
  registered: boolean;
  execute?: string;
  arguments?: string;
  state?: string;
}

export function queryDaemonAgent(
  run: LaunchctlRunner = defaultLaunchctlRunner,
  fs: PlistFs = defaultPlistFs,
  plistPath: string = daemonAgentPlistPath(),
  uid: number = userInfo().uid,
): DaemonAgentQuery {
  const existing = fs.read(plistPath);
  if (existing === undefined) return { registered: false };
  const execute = /<array>\s*<string>([^<]*)<\/string>/.exec(existing)?.[1];
  let state = 'NotLoaded';
  try {
    run(['print', `gui/${uid}/${DAEMON_AGENT_LABEL}`]);
    state = 'Loaded';
  } catch {
    // Not loaded (or launchctl unavailable) — the registration on disk still counts.
  }
  return {
    registered: true,
    ...(execute !== undefined ? { execute } : {}),
    arguments: 'daemon run',
    state,
  };
}

export type DaemonAgentUninstallOutcome = 'removed' | 'not_installed';

/** Bootout and delete the LaunchAgent. Mirrors uninstallDaemonTask's contract: removing the
 *  autostart registration does not stop an already-running daemon process. */
export function uninstallDaemonAgent(
  run: LaunchctlRunner = defaultLaunchctlRunner,
  fs: PlistFs = defaultPlistFs,
  plistPath: string = daemonAgentPlistPath(),
  uid: number = userInfo().uid,
): DaemonAgentUninstallOutcome {
  const existing = fs.read(plistPath);
  if (existing === undefined) return 'not_installed';
  try {
    run(['bootout', `gui/${uid}/${DAEMON_AGENT_LABEL}`]);
  } catch (err) {
    if (!isNotLoaded(err)) throw err;
  }
  fs.remove(plistPath);
  return 'removed';
}
