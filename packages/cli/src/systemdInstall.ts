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
 * Read the unit's `UnitFileState` — systemd's own word for whether it is enabled (`enabled`,
 * `disabled`, `masked`, `static`, …). `show` exits 0 even for a unit the manager has never
 * heard of (it answers with an empty value), unlike `is-enabled`, whose non-zero exit for a
 * disabled unit would reach callers as a thrown error. A manager that cannot be asked at all
 * answers `undefined` — "unknown", which is never treated as a negative.
 */
function unitFileState(run: SystemctlRunner): string | undefined {
  try {
    return run(['show', '-p', 'UnitFileState', '--value', DAEMON_UNIT_NAME]) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether a `UnitFileState` is a DEFINITE "does not start at login" — the only answer allowed to
 * drive work. `enabled-runtime` is one: it is dropped on reboot, which is the opposite of
 * autostart. An ABSENT state is not: that is the manager saying nothing at all (no bus, no
 * systemctl, a manager that has never been told about this unit), and "could not ask" is evidence
 * of neither side.
 *
 * Phrased as the negative rather than as its opposite because that is what both callers actually
 * need, and because the opposite reads an unknown as "not enabled" — which rewrites and re-enables
 * a perfectly current unit on every install, on hosts that can never answer, and reports each
 * no-op as work done.
 */
function saysNotEnabled(state: string | undefined): boolean {
  return state !== undefined && state !== 'enabled';
}

/**
 * Write (or rewrite) the unit and enable it. A changed unit is reloaded so the manager sees
 * the new definition; a unit that is already both current and enabled is 'unchanged'. Linger is
 * requested whenever the unit is written: without it the user manager — and this unit — exists
 * only while the user is logged in. It is best-effort because some polkit setups refuse it for
 * the user's own account (and WSL has no logind to grant it); the unit is enabled either way and
 * the refusal comes back as a note, since "starts at login, not at boot" is worth knowing.
 *
 * Idempotence is content AND enablement, and a failed registration takes the file back out,
 * because the file alone is not the registration: `enable` is what links it into
 * `default.target`. Judged on content alone, a unit whose `enable` failed (no bus, a polkit
 * refusal) would answer 'unchanged' on every later install and never be enabled — while the
 * caller starts the daemon now and nothing brings it back at the next login. Either half of
 * this alone closes that hole; both are cheap, and they fail independently.
 *
 * Only a manager that DEFINITELY says "not enabled" forces that rewrite, though. A manager that
 * cannot answer at all leaves the content-only verdict standing, because the alternative is an
 * install that is never idempotent on such a host: identical content rewritten, re-enabled and
 * reported 'updated' every single time, which is the same lie in the other direction.
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
  if (existing === desired && !saysNotEnabled(unitFileState(run))) {
    return { outcome: 'unchanged', notes: [] };
  }

  fs.write(unitPath, desired);
  try {
    run(['daemon-reload']);
    run(['enable', DAEMON_UNIT_NAME]);
  } catch (err) {
    // Put the filesystem back exactly as it was, so the next install is a fresh attempt rather
    // than a no-op over a file that never became a registration.
    if (existing === undefined) fs.remove(unitPath);
    else fs.write(unitPath, existing);
    // …and tell the manager, because the reload above already happened: it is holding a parsed
    // definition for content that no longer exists on disk, and nothing else would correct that
    // until the next successful install. Best-effort — this runs while an error is on its way
    // out, and a reload that also fails must not replace the failure the caller has to see.
    try {
      run(['daemon-reload']);
    } catch {
      // Nothing to add: the throw below already says the registration did not happen.
    }
    throw err;
  }
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
  // A unit whose content was already current but whose enablement had to be redone reads as
  // 'updated': work was done, and claiming 'unchanged' is exactly the lie this function had to
  // stop telling.
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
  /** systemd's UnitFileState (`enabled`, `disabled`, …) when the manager answered — whether
   *  the unit is linked into `default.target` and will therefore start at the next login. */
  enabled?: string;
}

/**
 * What the autostart registration looks like right now.
 *
 * Registered means the unit will actually start at login, which takes BOTH the unit file and an
 * `enable` — a present-but-disabled unit is a file the manager ignores, and reporting it as a
 * healthy registration hides the one thing wrong with it behind a green line in
 * `cctl daemon status`. `registered: false` is also the honest answer for the reader, because
 * the remedy it prints (`cctl daemon install`) is exactly what re-enables it.
 *
 * Only a definite negative demotes it: a manager that cannot be asked (no bus, no systemctl)
 * answers nothing about either state, and a registration already on disk stands.
 */
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
  const enabled = unitFileState(run);
  return {
    registered: !saysNotEnabled(enabled),
    ...(state !== undefined ? { state } : {}),
    ...(enabled !== undefined ? { enabled } : {}),
  };
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
