// Platform dispatch for the daemon's logon autostart.
//
// The daemon must run as the logged-in user (the vault is scoped to that user on every
// platform), so each host has its own logon-time mechanism: a Scheduled Task on Windows
// (daemonInstall.ts), a LaunchAgent on macOS (launchdInstall.ts), a Windows Scheduled Task
// registered from inside the distro on WSL (wslInstall.ts — a distro cannot autostart anything
// by itself, see there), and a systemd user unit on other Linux (systemdInstall.ts). A Linux
// host with neither Windows interop nor a systemd user manager has no backend and says so.
//
// Every command that touches autostart goes through this module so that decision is made in
// exactly one place. Deciding it per call site was how Linux once ended up in the Windows
// backend: a darwin-or-else check sent it to PowerShell, which on WSL failed with
// `spawnSync powershell.exe ENOENT` — or, with Windows interop on PATH, would have registered a
// Windows task pointing at a Linux path.

import {
  installDaemonTask,
  queryDaemonTask,
  startDaemonTaskNow,
  uninstallDaemonTask,
} from './daemonInstall.js';
import { installDaemonAgent, queryDaemonAgent, uninstallDaemonAgent } from './launchdInstall.js';
import {
  detectWsl,
  installWslDaemonTask,
  queryWslDaemonTask,
  startWslDaemonTaskNow,
  uninstallWslDaemonTask,
  type WslHost,
} from './wslInstall.js';
import {
  installDaemonUnit,
  queryDaemonUnit,
  startDaemonUnitNow,
  systemdUserAvailable,
  uninstallDaemonUnit,
} from './systemdInstall.js';

// ---------------------------------------------------------------------------
// The host, and which backend it gets
// ---------------------------------------------------------------------------

export type AutostartBackend =
  'scheduled-task' | 'launch-agent' | 'wsl-task' | 'systemd-user' | 'none';

/** Pins the Linux backend regardless of detection: `wsl-task`, `systemd-user`, or `none` (for
 *  someone who would rather not have cctl touch their Task Scheduler or user manager). Ignored
 *  off Linux, where the platform alone decides; an unrecognized value is ignored too. */
export const AUTOSTART_BACKEND_ENV = 'CCTL_AUTOSTART_BACKEND';

const LINUX_OVERRIDES = ['wsl-task', 'systemd-user', 'none'] as const;
export type LinuxAutostartOverride = (typeof LINUX_OVERRIDES)[number];

function isLinuxOverride(value: string): value is LinuxAutostartOverride {
  return (LINUX_OVERRIDES as readonly string[]).includes(value);
}

/** Everything the backend decision depends on, gathered once so the decision itself is pure
 *  and every surface (install, status, the wizard's deps) reasons from the same facts. */
export interface AutostartHost {
  platform: NodeJS.Platform;
  /** Set inside a WSL distro; `powerShell` is present only when the Windows side is reachable. */
  wsl?: WslHost;
  /** Whether `systemctl --user` reaches a running user manager. */
  systemdUser: boolean;
  /** A recognized `CCTL_AUTOSTART_BACKEND` value, when one is set. */
  override?: LinuxAutostartOverride;
}

export interface DetectHostOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Probes, injected for tests. Production reads /proc and runs `systemctl --user`. */
  wsl?: () => WslHost | undefined;
  systemdUser?: () => boolean;
}

/** Gather the host facts. The probes run only on Linux — they are Linux tools, and each is a
 *  process spawn or a /proc read that the other platforms have no reason to pay for. */
export function detectAutostartHost(options: DetectHostOptions = {}): AutostartHost {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const raw = env[AUTOSTART_BACKEND_ENV]?.trim();
  const override = raw !== undefined && isLinuxOverride(raw) ? raw : undefined;
  const withOverride = override !== undefined ? { override } : {};
  if (platform !== 'linux') return { platform, systemdUser: false, ...withOverride };
  const wsl = (options.wsl ?? (() => detectWsl({ env })))();
  const systemdUser = (options.systemdUser ?? systemdUserAvailable)();
  return { platform, ...(wsl !== undefined ? { wsl } : {}), systemdUser, ...withOverride };
}

/**
 * The one place the host → autostart mechanism decision lives. On Linux the Windows task wins
 * wherever it is reachable — a unit inside a WSL distro dies with the distro's idle shutdown
 * (wslInstall.ts) — then a systemd user manager, then nothing. An override that asks for a
 * backend the host cannot provide resolves to 'none' rather than to the other backend: the
 * user said which mechanism they want, not "whatever works".
 */
export function autostartBackend(host: AutostartHost = detectAutostartHost()): AutostartBackend {
  if (host.platform === 'win32') return 'scheduled-task';
  if (host.platform === 'darwin') return 'launch-agent';
  if (host.platform !== 'linux') return 'none';
  if (host.override === 'none') return 'none';
  if (host.override === 'systemd-user') return 'systemd-user';
  if (host.wsl?.powerShell !== undefined) return 'wsl-task';
  if (host.override === 'wsl-task') return 'none';
  return host.systemdUser ? 'systemd-user' : 'none';
}

/** What the user-facing surfaces call the mechanism. Hosts with no backend never print it. */
export function autostartNoun(backend: Exclude<AutostartBackend, 'none'>): string {
  switch (backend) {
    case 'launch-agent':
      return 'LaunchAgent';
    case 'systemd-user':
      return 'systemd user service';
    case 'scheduled-task':
    case 'wsl-task':
      return 'logon task';
  }
}

// ---------------------------------------------------------------------------
// What to say when there is no backend
// ---------------------------------------------------------------------------

/** How the daemon gets started on a host with no backend — the hint every surface (install,
 *  status, the wizard) hands the reader in place of `cctl daemon install`. Deliberately names
 *  no platform: the wizard and renderers print it from injected state, so their tests must not
 *  depend on the host they run on (CI is Linux, the dev box is Windows). */
export const MANUAL_START_HINT =
  'run the daemon yourself: cctl daemon supervise ' +
  '(keep it in a terminal, tmux/nohup, or your own service manager — see docs/PLATFORM.md)';

export const AUTOSTART_UNSUPPORTED_NOTE = `autostart is not available on this platform — ${MANUAL_START_HINT}`;

/** The note plus the host-specific reason, for the surfaces that know the host: a WSL distro
 *  whose Windows side is unreachable, a Linux box without a user manager, or an explicit
 *  opt-out — each of which the reader can act on. */
export function autostartUnsupportedNote(host: AutostartHost): string {
  if (host.platform !== 'linux') return AUTOSTART_UNSUPPORTED_NOTE;
  if (host.override === 'none') {
    return `${AUTOSTART_UNSUPPORTED_NOTE}. Autostart is switched off by ${AUTOSTART_BACKEND_ENV}=none`;
  }
  if (host.wsl !== undefined && host.wsl.powerShell === undefined) {
    return (
      `${AUTOSTART_UNSUPPORTED_NOTE}. WSL distro ${host.wsl.distro}: Windows interop is off or ` +
      'Windows PowerShell is not under /mnt/c, so the Windows logon task cannot be registered from here'
    );
  }
  if (host.override === 'wsl-task') {
    return `${AUTOSTART_UNSUPPORTED_NOTE}. ${AUTOSTART_BACKEND_ENV}=wsl-task asks for the Windows logon task, but this is not a WSL distro`;
  }
  if (!host.systemdUser) {
    return `${AUTOSTART_UNSUPPORTED_NOTE}. No systemd user manager answered (systemctl --user), so there is nothing to register a unit with`;
  }
  return AUTOSTART_UNSUPPORTED_NOTE;
}

/** Thrown by `installAutostart` on a host with no backend. Callers that want a clean message
 *  check `autostartBackend()` first; this is the safety net for the ones that don't. */
export class AutostartUnsupportedError extends Error {
  constructor(message: string = AUTOSTART_UNSUPPORTED_NOTE) {
    super(message);
    this.name = 'AutostartUnsupportedError';
  }
}

// ---------------------------------------------------------------------------
// Result shapes shared by every surface
// ---------------------------------------------------------------------------

export type AutostartOutcome = 'created' | 'updated' | 'unchanged';

/** Result of registering + kicking autostart. `task` mirrors the backend's register outcome;
 *  `started` is best-effort (a failure to start now still leaves the registration in place for
 *  the next logon). */
export interface AutostartResult {
  task: AutostartOutcome;
  started: boolean;
  detail?: string;
}

/** What `cctl daemon status` shows about autostart. `supported: false` is a host fact, not a
 *  failure — nothing to register, nothing to fix. */
export type AutostartQuery =
  { supported: false } | { supported: true; registered: boolean; state?: string };

/** The tri-state every summary surface needs. 'unsupported' satisfies "setup complete" —
 *  there is nothing for the user to do about it. */
export type AutostartState = 'registered' | 'unregistered' | 'unsupported';

export type AutostartUninstallOutcome = 'removed' | 'not_installed' | 'unsupported';

// ---------------------------------------------------------------------------
// Backends (injected so the dispatch is unit-tested without any of the real managers)
// ---------------------------------------------------------------------------

/** The uniform shape every mechanism presents to the dispatch. */
export interface AutostartBackendImpl {
  install(shimPath: string): AutostartOutcome;
  /** The separate "run it now" step. Absent when registering already starts the daemon (a
   *  RunAtLoad LaunchAgent). */
  startNow?(): void;
  query(): { registered: boolean; state?: string };
  uninstall(): 'removed' | 'not_installed';
}

export type AutostartBackends = Record<Exclude<AutostartBackend, 'none'>, AutostartBackendImpl>;

/** The production backends for a host. Only the WSL entry needs host facts (the distro and the
 *  PowerShell path); it throws if used on a host without them, which `autostartBackend` never
 *  selects. */
export function defaultBackends(host: AutostartHost): AutostartBackends {
  const wslHost = (): WslHost => {
    if (host.wsl === undefined) throw new Error('the WSL autostart backend needs a WSL host');
    return host.wsl;
  };
  return {
    'scheduled-task': {
      install: (shimPath) => installDaemonTask({ shimPath }),
      startNow: () => startDaemonTaskNow(),
      query: () => queryDaemonTask(),
      uninstall: () => uninstallDaemonTask(),
    },
    'launch-agent': {
      install: (shimPath) => installDaemonAgent({ shimPath }),
      query: () => queryDaemonAgent(),
      uninstall: () => uninstallDaemonAgent(),
    },
    'wsl-task': {
      install: (shimPath) => installWslDaemonTask({ host: wslHost(), shimPath }),
      startNow: () => startWslDaemonTaskNow({ host: wslHost() }),
      query: () => queryWslDaemonTask({ host: wslHost() }),
      uninstall: () => uninstallWslDaemonTask({ host: wslHost() }),
    },
    'systemd-user': {
      install: (shimPath) => installDaemonUnit({ shimPath }),
      startNow: () => startDaemonUnitNow(),
      query: () => queryDaemonUnit(),
      uninstall: () => uninstallDaemonUnit(),
    },
  };
}

export interface AutostartOptions {
  /** The host facts; detected when omitted. Commands detect once and pass the same host to
   *  every call so one invocation reasons from one snapshot. */
  host?: AutostartHost;
  backends?: AutostartBackends;
}

interface Resolved {
  host: AutostartHost;
  backend: AutostartBackend;
  /** Absent exactly when `backend` is 'none'. */
  impl?: AutostartBackendImpl;
}

function resolve(options: AutostartOptions): Resolved {
  const host = options.host ?? detectAutostartHost();
  const backend = autostartBackend(host);
  if (backend === 'none') return { host, backend };
  const backends = options.backends ?? defaultBackends(host);
  return { host, backend, impl: backends[backend] };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Register (or update) autostart and get the daemon running now. Throws
 * `AutostartUnsupportedError` on a host with no backend, and whatever the backend throws on a
 * registration failure; a failure to START is reported in the result rather than thrown, since
 * the registration itself succeeded and the next logon will bring the daemon up regardless.
 */
export function installAutostart(
  shimPath: string,
  options: AutostartOptions = {},
): AutostartResult {
  const { host, impl } = resolve(options);
  if (impl === undefined) throw new AutostartUnsupportedError(autostartUnsupportedNote(host));
  const task = impl.install(shimPath);
  // No separate start step means registering started it: for a LaunchAgent, 'unchanged' is an
  // agent already loaded — i.e. already running — so "started" holds in every outcome.
  if (impl.startNow === undefined) return { task, started: true };
  try {
    impl.startNow();
    return { task, started: true };
  } catch (err) {
    return { task, started: false, detail: (err as Error).message };
  }
}

/** Remove the autostart registration. Never stops an already-running daemon. On a host with no
 *  backend there is nothing to remove, which is an outcome, not an error. */
export function uninstallAutostart(options: AutostartOptions = {}): AutostartUninstallOutcome {
  const { impl } = resolve(options);
  return impl === undefined ? 'unsupported' : impl.uninstall();
}

/**
 * What is registered right now. Never throws: a backend that cannot even be asked (PowerShell
 * missing, launchctl or systemctl failing) reads as "not registered", because every caller —
 * `cctl daemon status`, the bare-`cctl` summary, the wizard's re-entry check — must keep
 * rendering its other lines when this one source is broken.
 */
export function queryAutostart(options: AutostartOptions = {}): AutostartQuery {
  const { impl } = resolve(options);
  if (impl === undefined) return { supported: false };
  try {
    const q = impl.query();
    return {
      supported: true,
      registered: q.registered,
      ...(q.state !== undefined ? { state: q.state } : {}),
    };
  } catch {
    return { supported: true, registered: false };
  }
}

/** `queryAutostart` folded to the tri-state the summaries render. */
export function readAutostartState(options: AutostartOptions = {}): AutostartState {
  const q = queryAutostart(options);
  if (!q.supported) return 'unsupported';
  return q.registered ? 'registered' : 'unregistered';
}
