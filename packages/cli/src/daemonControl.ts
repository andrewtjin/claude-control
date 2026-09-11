// `cctl daemon stop | start | restart` — the daemon's lifecycle from the command line.
//
// Before this existed the product said "restart the daemon to apply" (settings, npm updates)
// and shipped nothing that did it: an installed daemon is a Scheduled Task / LaunchAgent
// process with no console, so applying a saved setting meant Task Manager or a reboot.
//
// stop:    ask the running daemon to shut down over its own loopback endpoint (the graceful
//          path — held permissions are handed back to the terminal, the endpoint file and the
//          instance lock are cleaned up). A daemon that answers but has no such route (an older
//          build) or one that no longer answers at all (a wedged event loop) is terminated by
//          the pid its instance lock records instead. Either way the command returns only once
//          that pid is gone, so a following `start` never trips the instance lock.
// start:   through the registered autostart mechanism when there is one, so the daemon comes
//          up exactly as it does at logon (same shim, same environment); otherwise as a
//          detached background `daemon run` of this same cctl. Waits for the new process to
//          publish its settings report so the caller can say what it resolved.
// restart: stop, then start.
//
// Every OS edge (fetch, kill, spawn, the autostart backends, the clock) is injected so the
// policy is provable without a real daemon; program.ts supplies the real ones.

import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { defaultPaths, defaultProtector, type Protector } from '@claude-control/switch-engine';
import {
  hookEndpointPath,
  hookSecretPath,
  loadHookSecret,
  readHookEndpoint,
} from '@claude-control/daemon';
import { PLAIN_PALETTE, type Palette } from './ansi.js';
import { queryAutostart, startAutostart, type AutostartQuery } from './autostart.js';
import {
  isPidAlive,
  probePredecessorEndpoint,
  readLiveInstanceLock,
  type InstanceLockRecord,
} from './daemonInstanceLock.js';
import { daemonSettingsPath, readSettingsReport, type SettingsReport } from './settings.js';

/** Actionable, user-facing failures — printed as-is by `fail()`. */
export class DaemonControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DaemonControlError';
  }
}

export interface DaemonControlDeps {
  /** The daemon's loopback secret, or undefined when no daemon has ever run here. */
  loadSecret: () => Promise<string | undefined>;
  /** The published loopback endpoint, or undefined when none is published. */
  readEndpoint: () => Promise<{ port: number } | undefined>;
  /** Whether a daemon answers on that port — a published endpoint alone can be a leftover. */
  probeEndpoint: (port: number) => Promise<'serving' | 'dead'>;
  /** The instance lock, but only while its pid is alive. */
  readLiveLock: () => Promise<InstanceLockRecord | undefined>;
  isPidAlive: (pid: number) => boolean;
  /** Terminate a pid outright (SIGTERM; on Windows that is a hard TerminateProcess). */
  kill: (pid: number) => void;
  fetch: typeof fetch;
  /** What autostart registration exists, and how to start through it. */
  queryAutostart: () => AutostartQuery;
  startAutostart: () => void;
  /** Start a detached `daemon run` of this cctl. */
  spawnDetached: () => void;
  readReport: () => Promise<SettingsReport | undefined>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the process to go (stop) or the report to appear (start). */
  timeoutMs?: number;
  /** How long the stop request itself may hang before the daemon counts as wedged. */
  requestTimeoutMs?: number;
}

/** How long stop waits for the pid to disappear and start waits for the new report. A daemon
 *  drains held hooks and closes sqlite on the way out; a starting one runs recovery and
 *  resolves config before its report lands. Both are seconds, never a minute. */
export const DEFAULT_CONTROL_TIMEOUT_MS = 20_000;
/** A healthy daemon answers the stop route in milliseconds; a wedged event loop never does. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;
const POLL_MS = 200;

export type StopOutcome =
  | { outcome: 'not_running' }
  /** `graceful`: the daemon acknowledged the stop route and exited on its own.
   *  `terminated`: it was alive but could not be asked (no such route on an older build, or no
   *  answer at all), so the pid its instance lock records was killed. */
  | { outcome: 'stopped'; how: 'graceful' | 'terminated'; pid: number };

export type StartOutcome =
  | { outcome: 'already_running'; pid: number }
  | {
      outcome: 'started';
      /** `autostart`: through the logon task / LaunchAgent. `background`: a detached child of
       *  this cctl (no registration exists). */
      how: 'autostart' | 'background';
      /** The new daemon's report, once it published one within the timeout. */
      report: SettingsReport;
    };

export interface RestartOutcome {
  stop: StopOutcome;
  start: StartOutcome;
}

/** Wire the real OS behind the seams. `dataDir`/`protector` are overridable for tests that
 *  drive the production composition against a temp dir. */
export function defaultDaemonControlDeps(
  overrides: { dataDir?: string; protector?: Protector } = {},
): DaemonControlDeps {
  const dataDir = overrides.dataDir ?? dirname(defaultPaths().vaultDir);
  const protector = overrides.protector ?? defaultProtector();
  return {
    loadSecret: () => loadHookSecret({ filePath: hookSecretPath(dataDir), protector }),
    readEndpoint: () => readHookEndpoint(hookEndpointPath(dataDir)),
    probeEndpoint: (port) => probePredecessorEndpoint(port),
    readLiveLock: () => readLiveInstanceLock(dataDir),
    isPidAlive,
    kill: (pid) => process.kill(pid),
    fetch: (url, init) => globalThis.fetch(url, init),
    queryAutostart: () => queryAutostart(),
    startAutostart: () => startAutostart(),
    // The same cctl that is running this command, as `daemon run` — mirroring what the logon
    // task executes, minus the registration. Detached + ignored stdio so the child outlives
    // this shell; `unref` so this process does not wait on it.
    spawnDetached: () => {
      spawn(process.execPath, [process.argv[1] ?? '', 'daemon', 'run'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      }).unref();
    },
    // Same file name the daemon writes, relocated with the rest of the data dir.
    readReport: () => readSettingsReport(join(dataDir, basename(daemonSettingsPath()))),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}

/** What asking the daemon to stop came back with. `acknowledged` carries the pid the daemon
 *  reported for itself. `no_route` is a live daemon that answered with anything but 200 — 404
 *  before the route existed, 501 from a receiver without a stop hook, 401 from a secret that
 *  no longer matches — so it is alive and must be terminated instead. `hung` is a daemon that
 *  accepted the connection but never answered: the same wedged state `cctl daemon supervise`
 *  kills on. `unreachable` is nothing listening: a crash left the endpoint file behind. */
type StopRequestOutcome =
  | { kind: 'acknowledged'; pid: number }
  | { kind: 'no_route' }
  | { kind: 'hung' }
  | { kind: 'unreachable' };

/** POST the stop route. Never throws — every failure is a classification the caller acts on. */
async function requestGracefulStop(
  deps: DaemonControlDeps,
  port: number,
  secret: string,
): Promise<StopRequestOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
  );
  try {
    const res = await deps.fetch(`http://127.0.0.1:${port}/cli/daemon/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': secret },
      body: '{}',
      signal: controller.signal,
    });
    if (!res.ok) return { kind: 'no_route' };
    const body = (await res.json().catch(() => undefined)) as { pid?: unknown } | undefined;
    // A 200 without a pid is not a daemon we know how to watch; treat it as having no route.
    return typeof body?.pid === 'number'
      ? { kind: 'acknowledged', pid: body.pid }
      : { kind: 'no_route' };
  } catch {
    return controller.signal.aborted ? { kind: 'hung' } : { kind: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

/** Poll `probe` until it yields a value or the timeout passes. */
async function waitFor<T>(
  deps: DaemonControlDeps,
  probe: () => Promise<T | undefined>,
): Promise<T | undefined> {
  const deadline = deps.now() + (deps.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS);
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (deps.now() >= deadline) return undefined;
    await deps.sleep(POLL_MS);
  }
}

/**
 * Stop the running daemon: gracefully when it can be asked, by pid when it is alive but cannot
 * be. Killing is deliberately narrow — only a pid the live instance lock names, and only when
 * the daemon's own endpoint proves something is there (answering without the route, or
 * accepting the connection and hanging). A live pid with nothing behind the endpoint is NOT
 * killed: after a crash the lock can name a pid the OS has since handed to an unrelated
 * process, and terminating that would be far worse than asking the operator to look.
 */
export async function stopDaemon(deps: DaemonControlDeps): Promise<StopOutcome> {
  const lock = await deps.readLiveLock();
  const endpoint = await deps.readEndpoint();
  const secret = endpoint ? await deps.loadSecret() : undefined;

  let asked: StopRequestOutcome | undefined;
  if (endpoint && secret !== undefined) {
    asked = await requestGracefulStop(deps, endpoint.port, secret);
    if (asked.kind === 'acknowledged') {
      // The process that answered is the one to watch, whatever the lock says.
      return finishStop(deps, 'graceful', asked.pid);
    }
  }
  if (lock && (asked?.kind === 'no_route' || asked?.kind === 'hung')) {
    deps.kill(lock.pid);
    return finishStop(deps, 'terminated', lock.pid);
  }
  if (lock) {
    throw new DaemonControlError(
      `a daemon (pid ${lock.pid}) holds the instance lock but nothing answers on its endpoint` +
        (endpoint ? '' : ' (none is published)') +
        '; it may still be starting up - retry in a moment, or end that process by hand',
    );
  }
  if (endpoint && (asked?.kind === 'no_route' || asked?.kind === 'hung')) {
    // Alive and answering, but from before both the route and the lock existed: there is no
    // pid on record to terminate, and guessing one is not an option.
    throw new DaemonControlError(
      `a daemon answers on 127.0.0.1:${endpoint.port} but cannot be asked to stop (an older ` +
        'build) and records no pid; end that process by hand, then start the daemon again',
    );
  }
  return { outcome: 'not_running' };
}

/** Both stop paths end the same way: the process is gone. A graceful stop that never exits is
 *  reported, not escalated — killing a daemon mid-shutdown (sqlite closing, live sessions
 *  being ended) is exactly the corruption the graceful path exists to avoid. */
async function finishStop(
  deps: DaemonControlDeps,
  how: 'graceful' | 'terminated',
  pid: number,
): Promise<StopOutcome> {
  const gone = await waitFor(deps, () => Promise.resolve(deps.isPidAlive(pid) ? undefined : true));
  if (!gone) {
    throw new DaemonControlError(
      how === 'graceful'
        ? `the daemon (pid ${pid}) acknowledged the stop but is still running; give it a ` +
            'moment and check `cctl daemon status`, or end the process by hand'
        : `the daemon (pid ${pid}) could not be terminated; end the process by hand`,
    );
  }
  return { outcome: 'stopped', how, pid };
}

/**
 * Start the daemon. Refuses nothing: an already-running daemon is an outcome, not an error,
 * so `restart` and a double `start` both read naturally. The new daemon counts as up once it
 * has published a settings report newer than this call — written right after it resolves its
 * configuration, before it listens, which is exactly the moment the caller's question ("what
 * is it running with now?") has an answer.
 */
export async function startDaemon(deps: DaemonControlDeps): Promise<StartOutcome> {
  const lock = await deps.readLiveLock();
  if (lock) return { outcome: 'already_running', pid: lock.pid };

  const startedAt = deps.now();
  const autostart = deps.queryAutostart();
  let how: 'autostart' | 'background';
  if (autostart.supported && autostart.registered) {
    // The Scheduled Task is registered to ignore a start while an instance is running, and
    // its view of an instance can outlive the process by a moment (a terminated daemon's
    // instance is still "Running" until the scheduler notices). A start issued in that window
    // is swallowed without an error, so wait for the instance to be over first. The
    // LaunchAgent never reports Running here; the wait is a no-op for it.
    if (autostart.state === 'Running') {
      const over = await waitFor(deps, () => {
        const q = deps.queryAutostart();
        return Promise.resolve(q.supported && q.state === 'Running' ? undefined : true);
      });
      if (!over) {
        throw new DaemonControlError(
          'the logon task still shows its previous instance as running; retry in a moment, ' +
            'or end that process by hand',
        );
      }
    }
    try {
      deps.startAutostart();
    } catch (err) {
      throw new DaemonControlError(
        `could not start the daemon through its logon registration: ${(err as Error).message}`,
      );
    }
    how = 'autostart';
  } else {
    deps.spawnDetached();
    how = 'background';
  }

  // Up means SERVING, not merely started: a report newer than this call (an older one belongs
  // to the daemon just stopped) written by a process that still holds the instance lock and
  // answers on its published endpoint. The report lands before the daemon listens, so a
  // process that dies between the two — a port it cannot bind, hooks it cannot install —
  // must not be announced as started on the strength of its report alone.
  let died = false;
  const report = await waitFor(deps, async () => {
    const r = await deps.readReport();
    if (r === undefined || r.startedAtMs < startedAt) return undefined;
    if ((await deps.readLiveLock()) === undefined) {
      died = true;
      return r;
    }
    const endpoint = await deps.readEndpoint();
    if (endpoint === undefined) return undefined;
    return (await deps.probeEndpoint(endpoint.port)) === 'serving' ? r : undefined;
  });
  if (died) {
    throw new DaemonControlError(
      'the daemon started but is no longer running; check daemon-crash.log beside the vault' +
        (how === 'autostart' ? ' and the daemon log' : ''),
    );
  }
  if (report === undefined) {
    throw new DaemonControlError(
      how === 'autostart'
        ? 'the daemon was started through its logon registration but is not serving yet; ' +
            'check `cctl daemon status` and the daemon log'
        : 'the daemon was started in the background but is not serving yet; check ' +
            '`cctl daemon status` and daemon-crash.log beside the vault',
    );
  }
  return { outcome: 'started', how, report };
}

export async function restartDaemon(deps: DaemonControlDeps): Promise<RestartOutcome> {
  const stop = await stopDaemon(deps);
  const start = await startDaemon(deps);
  return { stop, start };
}

// ---------------------------------------------------------------------------
// Rendering (pure; plain by default, a palette paints the outcome word)
// ---------------------------------------------------------------------------

export function renderStopOutcome(outcome: StopOutcome, palette: Palette = PLAIN_PALETTE): string {
  if (outcome.outcome === 'not_running') return 'No daemon is running.\n';
  return outcome.how === 'graceful'
    ? `${palette.green('Stopped the daemon')} (pid ${outcome.pid}).\n`
    : `${palette.yellow('Terminated the daemon')} (pid ${outcome.pid}): it was running but could ` +
        'not be asked to stop (an older build, or it had stopped answering).\n';
}

/** `via` names the registration the daemon was started through ("logon task", "LaunchAgent");
 *  it is only read for an autostart start. The config.json line answers the question a restart
 *  is usually run for — did the saved setting take? — without a second command. */
export function renderStartOutcome(
  outcome: StartOutcome,
  via: string,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (outcome.outcome === 'already_running') {
    return `The daemon is already running (pid ${outcome.pid}).\n`;
  }
  const build = outcome.report.settings.find((r) => r.name === 'daemon build')?.value;
  const where = outcome.how === 'autostart' ? `via the ${via}` : 'in the background';
  const fromFile = outcome.report.settings.filter((r) => r.source === 'config');
  return (
    `${palette.green('Started the daemon')} ${where}${build ? ` (build ${build})` : ''}.\n` +
    (fromFile.length === 0
      ? 'Settings from config.json: none.\n'
      : `Settings from config.json: ${fromFile.map((r) => `${r.name} ${r.value}`).join(', ')}.\n`)
  );
}

export function renderRestartOutcome(
  outcome: RestartOutcome,
  via: string,
  palette: Palette = PLAIN_PALETTE,
): string {
  return renderStopOutcome(outcome.stop, palette) + renderStartOutcome(outcome.start, via, palette);
}
