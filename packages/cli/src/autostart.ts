// Platform dispatch for the daemon's logon autostart.
//
// The daemon must run as the logged-in user (the vault is scoped to that user on every
// platform), so each platform has its own logon-time mechanism: a Scheduled Task on Windows
// (daemonInstall.ts), a LaunchAgent on macOS (launchdInstall.ts), and nothing yet on Linux —
// there the daemon runs by hand or under a user-provided systemd unit (docs/PLATFORM.md).
//
// Every command that touches autostart goes through this module so that platform decision is
// made in exactly one place. Deciding it per call site was how Linux ended up in the Windows
// backend: a darwin-or-else check sent it to PowerShell, which on WSL fails with
// `spawnSync powershell.exe ENOENT` — or, with Windows interop on PATH, would have registered a
// Windows task pointing at a Linux path. A platform without a backend now gets an honest
// "unsupported" answer instead.

import {
  installDaemonTask,
  queryDaemonTask,
  startDaemonTaskNow,
  uninstallDaemonTask,
} from './daemonInstall.js';
import {
  installDaemonAgent,
  queryDaemonAgent,
  startDaemonAgentNow,
  uninstallDaemonAgent,
} from './launchdInstall.js';

// ---------------------------------------------------------------------------
// Which backend a platform uses
// ---------------------------------------------------------------------------

export type AutostartBackend = 'scheduled-task' | 'launch-agent' | 'none';

/** The one place the platform → autostart mechanism decision lives. Anything that is not
 *  Windows or macOS has no backend — Linux included, WSL included. */
export function autostartBackend(platform: NodeJS.Platform = process.platform): AutostartBackend {
  if (platform === 'win32') return 'scheduled-task';
  if (platform === 'darwin') return 'launch-agent';
  return 'none';
}

/** What the user-facing surfaces call the mechanism. Platforms with no backend never print it. */
export function autostartNoun(backend: Exclude<AutostartBackend, 'none'>): string {
  return backend === 'launch-agent' ? 'LaunchAgent' : 'logon task';
}

/** How the daemon gets started on a platform with no backend — the hint every surface (install,
 *  status, the wizard) hands the reader in place of `cctl daemon install`. Deliberately names
 *  no platform: the wizard and renderers print it from injected state, so their tests must not
 *  depend on the host they run on (CI is Linux, the dev box is Windows). */
export const MANUAL_START_HINT =
  'run the daemon yourself: cctl daemon supervise ' +
  '(keep it in a terminal, tmux/nohup, or your own systemd user unit — see docs/PLATFORM.md)';

export const AUTOSTART_UNSUPPORTED_NOTE = `autostart is not available on this platform yet — ${MANUAL_START_HINT}`;

/** Thrown by `installAutostart` on a platform with no backend. Callers that want a clean
 *  message check `autostartBackend()` first; this is the safety net for the ones that don't. */
export class AutostartUnsupportedError extends Error {
  constructor() {
    super(AUTOSTART_UNSUPPORTED_NOTE);
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

/** What `cctl daemon status` shows about autostart. `supported: false` is a platform fact, not
 *  a failure — nothing to register, nothing to fix. */
export type AutostartQuery =
  | { supported: false }
  | {
      supported: true;
      registered: boolean;
      state?: string;
      /** The executable the registration runs (the cctl shim it was installed with). */
      execute?: string;
    };

/** The tri-state every summary surface needs. 'unsupported' satisfies "setup complete" —
 *  there is nothing for the user to do about it. */
export type AutostartState = 'registered' | 'unregistered' | 'unsupported';

export type AutostartUninstallOutcome = 'removed' | 'not_installed' | 'unsupported';

// ---------------------------------------------------------------------------
// Backends (injected so the dispatch is unit-tested without a Task Scheduler or launchd)
// ---------------------------------------------------------------------------

export interface AutostartBackends {
  scheduledTask: {
    install(shimPath: string): AutostartOutcome;
    /** Separate from install: a Scheduled Task registration does not start the task. */
    startNow(): void;
    query(): { registered: boolean; state?: string; execute?: string };
    uninstall(): 'removed' | 'not_installed';
  };
  launchAgent: {
    /** A RunAtLoad LaunchAgent registers AND starts in one bootstrap — no separate start. */
    install(shimPath: string): AutostartOutcome;
    /** Kick a loaded-but-stopped agent (after `cctl daemon stop`); throws when not loaded. */
    startNow(): void;
    query(): { registered: boolean; state?: string; execute?: string };
    uninstall(): 'removed' | 'not_installed';
  };
}

const defaultBackends: AutostartBackends = {
  scheduledTask: {
    install: (shimPath) => installDaemonTask({ shimPath }),
    startNow: () => startDaemonTaskNow(),
    query: () => queryDaemonTask(),
    uninstall: () => uninstallDaemonTask(),
  },
  launchAgent: {
    install: (shimPath) => installDaemonAgent({ shimPath }),
    startNow: () => startDaemonAgentNow(),
    query: () => queryDaemonAgent(),
    uninstall: () => uninstallDaemonAgent(),
  },
};

export interface AutostartOptions {
  platform?: NodeJS.Platform;
  backends?: AutostartBackends;
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Register (or update) autostart and get the daemon running now. Throws
 * `AutostartUnsupportedError` on a platform with no backend, and whatever the backend throws on
 * a registration failure; a failure to START (Windows only — launchd starts as part of
 * registering) is reported in the result rather than thrown, since the registration itself
 * succeeded and the next logon will bring the daemon up regardless.
 */
export function installAutostart(
  shimPath: string,
  options: AutostartOptions = {},
): AutostartResult {
  const backends = options.backends ?? defaultBackends;
  switch (autostartBackend(options.platform)) {
    case 'scheduled-task': {
      const task = backends.scheduledTask.install(shimPath);
      try {
        backends.scheduledTask.startNow();
        return { task, started: true };
      } catch (err) {
        return { task, started: false, detail: (err as Error).message };
      }
    }
    case 'launch-agent':
      // 'unchanged' means the agent was already loaded — i.e. already running — so "started"
      // holds in every outcome: the daemon is up, or coming up, once this returns.
      return { task: backends.launchAgent.install(shimPath), started: true };
    case 'none':
      throw new AutostartUnsupportedError();
  }
}

/**
 * Start the daemon through its registered autostart mechanism — what `cctl daemon start` and
 * `restart` do when a registration exists, so the daemon comes up exactly as it does at logon
 * (same shim, same environment, same flag-less `daemon run`) rather than as a child of this
 * shell. Throws on a platform without a backend; backend failures (task not registered, agent
 * not loaded, PowerShell/launchctl missing) propagate for the caller to phrase.
 */
export function startAutostart(options: AutostartOptions = {}): void {
  const backends = options.backends ?? defaultBackends;
  switch (autostartBackend(options.platform)) {
    case 'scheduled-task':
      backends.scheduledTask.startNow();
      return;
    case 'launch-agent':
      backends.launchAgent.startNow();
      return;
    case 'none':
      throw new AutostartUnsupportedError();
  }
}

/** Remove the autostart registration. Never stops an already-running daemon. On a platform
 *  with no backend there is nothing to remove, which is an outcome, not an error. */
export function uninstallAutostart(options: AutostartOptions = {}): AutostartUninstallOutcome {
  const backends = options.backends ?? defaultBackends;
  switch (autostartBackend(options.platform)) {
    case 'scheduled-task':
      return backends.scheduledTask.uninstall();
    case 'launch-agent':
      return backends.launchAgent.uninstall();
    case 'none':
      return 'unsupported';
  }
}

/**
 * What is registered right now. Never throws: a backend that cannot even be asked (PowerShell
 * missing, launchctl failing) reads as "not registered", because every caller — `cctl daemon
 * status`, the bare-`cctl` summary, the wizard's re-entry check — must keep rendering its other
 * lines when this one source is broken.
 */
export function queryAutostart(options: AutostartOptions = {}): AutostartQuery {
  const backends = options.backends ?? defaultBackends;
  const backend = autostartBackend(options.platform);
  if (backend === 'none') return { supported: false };
  try {
    const q =
      backend === 'scheduled-task' ? backends.scheduledTask.query() : backends.launchAgent.query();
    return {
      supported: true,
      registered: q.registered,
      ...(q.state !== undefined ? { state: q.state } : {}),
      ...(q.execute !== undefined ? { execute: q.execute } : {}),
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
