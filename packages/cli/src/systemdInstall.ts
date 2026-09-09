// Linux (outside WSL) autostart: a systemd USER unit — the per-user counterpart of the macOS
// LaunchAgent. The daemon must run as the user whose vault key file it reads, and a user unit
// runs inside that user's own systemd instance without root. `loginctl enable-linger`
// (best-effort) makes that instance start at boot rather than at first login, which is what
// turns "starts when I log in" into "comes up unattended" on a server.
//
// Idempotent like the LaunchAgent: the desired unit text is rendered and compared first;
// identical content is 'unchanged' and touches systemctl only for the separate start step.
// Every systemctl/loginctl call goes through an injected runner so the decisions here are
// unit-tested without a real systemd.

import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { posix } from 'node:path';
import { defaultTextFileStore, type TextFileStore } from './textFileStore.js';

export const DAEMON_UNIT_NAME = 'claude-control-daemon.service';

// ---------------------------------------------------------------------------
// Shelling out
// ---------------------------------------------------------------------------

/** Runs `systemctl --user <args>` and returns trimmed stdout; throws on a non-zero exit. */
export type SystemctlRunner = (args: string[]) => string;
/** Runs `loginctl <args>`. */
export type LoginctlRunner = (args: string[]) => string;

function runTool(tool: string, args: string[]): string {
  return execFileSync(tool, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

export const defaultSystemctlRunner: SystemctlRunner = (args) =>
  runTool('systemctl', ['--user', ...args]);
export const defaultLoginctlRunner: LoginctlRunner = (args) => runTool('loginctl', args);

/**
 * Whether `systemctl --user` reaches a running user manager on this host. `is-system-running`
 * prints the manager state and exits non-zero for anything but `running` (`degraded` included,
 * which is still a usable manager), so the state word is read from stdout either way; no
 * manager at all ("Failed to connect to bus", or no systemctl) is the false case.
 */
export function systemdUserAvailable(run: SystemctlRunner = defaultSystemctlRunner): boolean {
  let state: string;
  try {
    state = run(['is-system-running']);
  } catch (err) {
    const stdout = (err as { stdout?: unknown }).stdout;
    state = typeof stdout === 'string' ? stdout.trim() : '';
  }
  return state.length > 0 && !/offline|unknown/i.test(state);
}

// ---------------------------------------------------------------------------
// The unit file
// ---------------------------------------------------------------------------

/** Where systemd looks for a user's own units, honoring `XDG_CONFIG_HOME`. POSIX-joined on
 *  every platform for the same reason as the LaunchAgent plist path: this is a Linux location
 *  by definition, and the tests run wherever the developer is. */
export function daemonUnitPath(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const configHome = env.XDG_CONFIG_HOME?.trim() || posix.join(home, '.config');
  return posix.join(configHome, 'systemd', 'user', DAEMON_UNIT_NAME);
}

/** Quote one word for a unit-file setting (`ExecStart=`, `Environment=`): double quotes, with
 *  backslash and double quote escaped, per systemd.syntax(7). */
function unitQuote(word: string): string {
  return `"${word.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The unit body. Like the LaunchAgent plist, it names the npm shim by absolute path with a PATH
 * that starts at the shim's own bin directory: a user manager's environment is minimal, the
 * shim re-execs `node` by name and the daemon spawns `claude`, so both must resolve from there.
 * Restart policy mirrors the Windows task — a few restarts after a crash, then stop trying —
 * because the daemon's own control-plane client already retries forever and a restart loop on a
 * fundamentally broken install would only fight `cctl daemon supervise`.
 */
export function renderDaemonUnit(shimPath: string): string {
  const binDir = posix.dirname(shimPath);
  const path = `${binDir}:/usr/local/bin:/usr/bin:/bin`;
  return `[Unit]
Description=claude-control daemon (managed by cctl; see: cctl daemon uninstall)
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
ExecStart=${unitQuote(shimPath)} daemon run
Environment=${unitQuote(`PATH=${path}`)}
Restart=on-failure
RestartSec=60

[Install]
WantedBy=default.target
`;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type DaemonUnitOutcome = 'created' | 'updated' | 'unchanged';

export interface DaemonUnitOptions {
  run?: SystemctlRunner;
  loginctl?: LoginctlRunner;
  fs?: TextFileStore;
  unitPath?: string;
}

export interface DaemonUnitInstall {
  outcome: DaemonUnitOutcome;
  /** Non-fatal remarks for the operator — today, a refused `enable-linger`. */
  notes: string[];
}

/**
 * Write (or rewrite) the unit and enable it. A changed unit is reloaded so the manager sees
 * the new definition; an identical one is 'unchanged' and runs nothing. Linger is requested
 * whenever the unit is written: without it the user manager — and this unit — exists only
 * while the user is logged in. It is best-effort because some polkit setups refuse it for the
 * user's own account (and WSL has no logind to grant it); the unit is enabled either way and
 * the refusal comes back as a note, since "starts at login, not at boot" is worth knowing.
 */
export function installDaemonUnit(
  options: DaemonUnitOptions & { shimPath: string },
): DaemonUnitInstall {
  const run = options.run ?? defaultSystemctlRunner;
  const loginctl = options.loginctl ?? defaultLoginctlRunner;
  const fs = options.fs ?? defaultTextFileStore;
  const unitPath = options.unitPath ?? daemonUnitPath();

  const desired = renderDaemonUnit(options.shimPath);
  const existing = fs.read(unitPath);
  if (existing === desired) return { outcome: 'unchanged', notes: [] };

  fs.write(unitPath, desired);
  run(['daemon-reload']);
  run(['enable', DAEMON_UNIT_NAME]);
  const notes: string[] = [];
  try {
    loginctl(['enable-linger']);
  } catch (err) {
    // execFileSync's message carries the command line and the tool's stderr on separate lines;
    // fold it onto one so the note reads as a sentence.
    const reason = (err as Error).message.replace(/\s+/g, ' ').trim();
    notes.push(
      `could not enable linger (${reason}); the service starts at your next login rather ` +
        'than at boot — run `loginctl enable-linger` yourself to change that',
    );
  }
  return { outcome: existing === undefined ? 'created' : 'updated', notes };
}

/** Start the service now — the separate step that leaves the daemon running after an install,
 *  same contract as `startDaemonTaskNow`. */
export function startDaemonUnitNow(options: DaemonUnitOptions = {}): void {
  (options.run ?? defaultSystemctlRunner)(['start', DAEMON_UNIT_NAME]);
}

export interface DaemonUnitQuery {
  registered: boolean;
  /** systemd's ActiveState (`active`, `inactive`, `failed`, …) when the manager answered. */
  state?: string;
}

/** Registered means the unit file is on disk; the state comes from the manager when it can be
 *  asked (a missing manager still leaves the registration standing). */
export function queryDaemonUnit(options: DaemonUnitOptions = {}): DaemonUnitQuery {
  const run = options.run ?? defaultSystemctlRunner;
  const fs = options.fs ?? defaultTextFileStore;
  const unitPath = options.unitPath ?? daemonUnitPath();
  if (fs.read(unitPath) === undefined) return { registered: false };
  let state: string | undefined;
  try {
    state = run(['show', '-p', 'ActiveState', '--value', DAEMON_UNIT_NAME]) || undefined;
  } catch {
    state = undefined;
  }
  return { registered: true, ...(state !== undefined ? { state } : {}) };
}

export type DaemonUnitUninstallOutcome = 'removed' | 'not_installed';

/** True when systemctl failed only because the unit is already gone from the manager's view —
 *  the normal state after a manual removal, not an error worth surfacing. */
function isUnitMissing(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = `${(err as Error)?.message ?? ''}${typeof stderr === 'string' ? stderr : ''}`;
  return /does not exist|not found|not loaded|No such file/i.test(text);
}

/** Disable and delete the unit. Same contract as the Windows task: the autostart registration
 *  goes away, a daemon already running keeps running until stopped (`disable` without `--now`). */
export function uninstallDaemonUnit(options: DaemonUnitOptions = {}): DaemonUnitUninstallOutcome {
  const run = options.run ?? defaultSystemctlRunner;
  const fs = options.fs ?? defaultTextFileStore;
  const unitPath = options.unitPath ?? daemonUnitPath();
  if (fs.read(unitPath) === undefined) return 'not_installed';
  try {
    run(['disable', DAEMON_UNIT_NAME]);
  } catch (err) {
    if (!isUnitMissing(err)) throw err;
  }
  fs.remove(unitPath);
  try {
    run(['daemon-reload']);
  } catch {
    // The file is gone, which is the durable part; a reload failure only delays the manager
    // noticing until its next reload.
  }
  return 'removed';
}
