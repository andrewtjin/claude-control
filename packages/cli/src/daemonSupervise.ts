// Daemon supervision: crash visibility, restart-on-crash, and hang detection.
//
// Three pieces, born from live incidents where a daemon stopped serving hooks and nothing
// noticed:
//
//   1. installCrashLogging: process-level last-breath handlers. An uncaught exception or
//      unhandled rejection appends WHAT killed the daemon to `daemon-crash.log` before the
//      process exits non-zero. Synchronous fs on purpose: the process is dying, there is no
//      later tick to await.
//   2. superviseDaemon: `cctl daemon supervise` — runs `cctl daemon run` as a child and
//      respawns it whenever it exits non-zero (~2s; a crash loop backs off), so the receiver
//      port is re-listening within seconds of any crash. A CLEAN exit (code 0) ends
//      supervision: that is the operator deliberately stopping the daemon (Ctrl+C reaches
//      the child on the shared console), and a supervisor that resurrects a deliberate stop
//      would fight its own operator. The one exception is a kill the supervisor ordered
//      itself (piece 3): the daemon answers SIGTERM with a graceful shutdown that also exits
//      0, so the exit code alone cannot tell the two apart — the supervisor remembers that it
//      pulled the trigger and respawns whatever the code. A spawn failure (missing binary, EPERM, ...) surfaces as
//      the child's 'error' event rather than 'exit' — Node's own contract for a child that
//      never actually started, and 'exit' may never follow it — so that path is treated as a
//      crash too, never a silent hang or an uncaught throw.
//   3. The optional health probe: a crashed child is easy (it exits), but a HUNG one — alive,
//      event loop wedged, never answering a hook — never exits on its own. While a child is
//      alive, superviseDaemon can poll its /healthz on an interval and, after enough
//      consecutive failures, kill it so the respawn path takes over. A wedged loop cannot run
//      its own SIGTERM handler, so a child still alive after a grace period gets SIGKILL.
//      Absent the `probe` option, behavior is unchanged from before this existed.
//
// The loop is dependency-injected (spawn/clock/sleep/probe) so the policy is provable in unit
// tests without real processes or real time.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hookEndpointPath, readHookEndpoint } from '@claude-control/daemon';

/** Where crash lines land: a sibling of the vault under the claude-control data dir. */
export function crashLogPath(dataDir: string): string {
  return join(dataDir, 'daemon-crash.log');
}

/** Append one timestamped line to the crash log, creating the directory on first use.
 *  Failures are swallowed — crash logging must never produce a second crash. */
export function appendCrashLine(filePath: string, line: string): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // dying breath — nothing sensible left to do
  }
}

/**
 * Install last-breath handlers so the daemon can never again die silently. Exits 1 after
 * logging: an uncaught error leaves the process in an unknown state, and a supervisor (or
 * the operator) restarting a fresh process beats limping on in that state.
 */
export function installCrashLogging(filePath: string): void {
  process.on('uncaughtException', (err) => {
    appendCrashLine(filePath, `uncaughtException: ${err.stack ?? err.message}`);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const text =
      reason instanceof Error ? (reason.stack ?? reason.message) : JSON.stringify(reason);
    appendCrashLine(filePath, `unhandledRejection: ${text}`);
    process.exit(1);
  });
}

/** The child capabilities the loop needs — tests inject an emitter-backed fake. 'error' fires
 *  when the OS never actually managed to start the process (bad binary, EPERM, ...); Node's
 *  contract is that 'exit' may never follow it, so it must be watched separately from 'exit'
 *  rather than assumed to eventually resolve it. */
export interface SupervisedChild {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  once(event: 'error', listener: (err: Error) => void): void;
  /** No argument = SIGTERM (graceful). The health probe escalates to SIGKILL when a wedged
   *  child never gets to run its SIGTERM handler. */
  kill(signal?: 'SIGTERM' | 'SIGKILL'): void;
}

/** Health-probe knobs. The whole block is optional — omit it and superviseDaemon behaves
 *  exactly as it did before hang detection existed (crash-only). `probeFn` is required
 *  (rather than defaulting internally) because building the production default needs a data
 *  directory this options bag has no way to carry; see {@link buildDefaultProbeFn}, which the
 *  real `cctl daemon supervise` wiring uses to build one. */
export interface ProbeOptions {
  /** How often to probe while a child is alive. Default 15s. */
  intervalMs?: number;
  /** Only meaningful to a fetch-based probeFn — the production default treats it as its
   *  AbortController deadline. A custom probeFn is free to ignore it. Default 5s. */
  timeoutMs?: number;
  /** CONSECUTIVE unhealthy results before the child is killed for respawn. Resets to zero on
   *  any healthy result and on every new child. Default 3. */
  failuresToKill?: number;
  /** How long a health-killed child gets to act on SIGTERM before it is sent SIGKILL. A
   *  daemon whose event loop is blocked cannot run its shutdown handler at all, so without
   *  this a health kill lands only whenever the loop happens to unblock (minutes, live).
   *  Default 10s — ample for a responsive daemon's graceful shutdown. */
  killGraceMs?: number;
  /** What "healthy" means for the currently-running child. */
  probeFn: () => Promise<boolean>;
}

export interface SuperviseOptions {
  /** Spawn one `cctl daemon run` child (stdio inherited in production). */
  spawnChild: () => SupervisedChild;
  /** Console line sink (production: process.stdout). */
  log: (line: string) => void;
  /** Crash-line sink (production: appendCrashLine into daemon-crash.log). */
  logCrash: (line: string) => void;
  /** Abort to stop supervising (SIGINT/SIGTERM wiring); the current child is killed. */
  signal?: AbortSignal;
  /** Delay before an ordinary respawn. Default 2s — fast enough that hook events barely
   *  notice, slow enough to never busy-spin. */
  restartDelayMs?: number;
  /** A "crash loop" is `crashLoopThreshold` exits within `crashLoopWindowMs`; respawns then
   *  slow to `crashLoopDelayMs` so a daemon that dies on startup doesn't thrash the box. */
  crashLoopWindowMs?: number;
  crashLoopThreshold?: number;
  crashLoopDelayMs?: number;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Health-probe loop that runs while a child is alive, to catch a HUNG daemon that a plain
   *  exit-code check would never see. Absent = today's crash-only behavior. */
  probe?: ProbeOptions;
}

const DEFAULT_RESTART_DELAY_MS = 2_000;
const DEFAULT_CRASH_LOOP_WINDOW_MS = 60_000;
const DEFAULT_CRASH_LOOP_THRESHOLD = 5;
const DEFAULT_CRASH_LOOP_DELAY_MS = 30_000;
export const DEFAULT_PROBE_INTERVAL_MS = 15_000;
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_PROBE_FAILURES_TO_KILL = 3;
export const DEFAULT_PROBE_KILL_GRACE_MS = 10_000;

/** Race a delay against `signal` so an operator interrupt during a respawn/backoff sleep is
 *  honored immediately instead of lingering until the timer elapses. By the time the loop is
 *  in this sleep the child is already dead (the wait above resolved on its exit), so nothing
 *  else would ever unblock an interrupt here otherwise. */
function abortAwareDelay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** A plain delay that neither races the abort signal nor holds the process open. The SIGKILL
 *  grace period uses it: an operator interrupt arriving mid-grace must not cut the grace short
 *  (the child is still owed its chance to shut down), and once supervision has ended the
 *  timer must not keep the supervisor process alive by itself. */
function unrefDelay(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms).unref();
  });
}

/**
 * Build the production health probe: GET /healthz on the daemon's currently-published
 * loopback port. Re-reads hook-endpoint.json on every call rather than caching the port,
 * because a still-starting or deliberately-stopped daemon simply has no file yet — treating
 * that absence as "unhealthy" would have the supervisor kill a daemon that was never
 * unhealthy, just not up yet. That case is deliberately VACUOUS (true): crash detection is
 * the exit listener's job, not this probe's, and a genuinely wedged daemon still has its
 * last-published (stale-but-present) file, so it stays probeable.
 */
export function buildDefaultProbeFn(
  dataDir: string,
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS,
): () => Promise<boolean> {
  const endpointFile = hookEndpointPath(dataDir);
  return async () => {
    const endpoint = await readHookEndpoint(endpointFile);
    if (!endpoint) return true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`http://127.0.0.1:${endpoint.port}/healthz`, {
        signal: controller.signal,
      });
      return res.status === 200;
    } catch {
      return false; // refused connection, network error, or the abort firing on timeout
    } finally {
      clearTimeout(timer);
    }
  };
}

/** Handle on one child's probe loop. `stop` must be called as soon as the child's own
 *  exit/error settles (or the supervisor aborts), so no probe or grace timer ever acts on a
 *  child that is already gone. `killedByProbe` tells the exit path that the supervisor ordered
 *  this death itself, so even a graceful code-0 exit is answered with a respawn. */
interface ProbeLoopHandle {
  stop: () => void;
  killedByProbe: () => boolean;
}

/**
 * Run the health-probe loop for one live child: probeFn every intervalMs, and after
 * `failuresToKill` CONSECUTIVE unhealthy results, kill the child so the exit path (in
 * superviseDaemon, below) respawns it. A child still alive `killGraceMs` after that SIGTERM is
 * sent SIGKILL.
 */
function startProbeLoop(args: {
  child: SupervisedChild;
  probe: ProbeOptions;
  sleep: (ms: number) => Promise<void>;
  graceSleep: (ms: number) => Promise<void>;
  signal: AbortSignal | undefined;
  log: (line: string) => void;
  logCrash: (line: string) => void;
}): ProbeLoopHandle {
  const { child, probe, sleep, graceSleep, signal, log, logCrash } = args;
  const intervalMs = probe.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const failuresToKill = probe.failuresToKill ?? DEFAULT_PROBE_FAILURES_TO_KILL;
  const killGraceMs = probe.killGraceMs ?? DEFAULT_PROBE_KILL_GRACE_MS;
  // `cancelled` ends probing (child gone, abort, or the kill below). `exited` is set only by
  // stop(), i.e. once the child is really gone, and is what holds back the SIGKILL.
  let cancelled = false;
  let exited = false;
  let killed = false;
  let consecutiveFailures = 0;

  void (async () => {
    while (!cancelled) {
      await sleep(intervalMs);
      // Re-check after every await: cancellation and abort can both land while we were
      // asleep, and neither one interrupts an in-flight probeFn call once it starts.
      if (cancelled || signal?.aborted) return;

      let healthy: boolean;
      try {
        healthy = await probe.probeFn();
      } catch {
        healthy = false; // a throwing probeFn is a failed probe, not a supervisor crash
      }
      if (cancelled || signal?.aborted) return;

      if (healthy) {
        consecutiveFailures = 0;
        continue;
      }
      consecutiveFailures += 1;
      if (consecutiveFailures < failuresToKill) continue;

      cancelled = true;
      // Set before the exit is seen, so a deliberate stop that lands in this very tick is
      // respawned too. That takes a daemon unresponsive for every probe in the streak, and
      // erring toward a running daemon is the safe side.
      killed = true;
      const detail = `supervise: daemon unresponsive (${consecutiveFailures} consecutive health probes failed); killing for respawn`;
      logCrash(detail);
      log(detail);
      child.kill();

      await graceSleep(killGraceMs);
      if (exited) return;
      const escalation = `supervise: daemon still running ${Math.round(killGraceMs / 1000)}s after the health kill; sending SIGKILL`;
      logCrash(escalation);
      log(escalation);
      child.kill('SIGKILL');
    }
  })();

  return {
    stop: () => {
      cancelled = true;
      exited = true;
    },
    killedByProbe: () => killed,
  };
}

/** Outcome of waiting on a child: either it exited, or it never managed to start at all. */
interface ChildOutcome {
  code: number | null;
  signal: string | null;
  error?: Error;
}

/**
 * Run the supervision loop until the child exits cleanly (deliberate stop) or `signal`
 * aborts. Every non-zero exit — including a spawn failure that never produced a process to
 * exit — and every exit after a health kill, whatever its code, is logged to both sinks and
 * answered with a respawn.
 */
export async function superviseDaemon(options: SuperviseOptions): Promise<void> {
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const windowMs = options.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
  const threshold = options.crashLoopThreshold ?? DEFAULT_CRASH_LOOP_THRESHOLD;
  const crashLoopDelayMs = options.crashLoopDelayMs ?? DEFAULT_CRASH_LOOP_DELAY_MS;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => abortAwareDelay(ms, options.signal));
  const graceSleep = options.sleep ?? unrefDelay;
  const crashTimes: number[] = [];

  for (;;) {
    if (options.signal?.aborted) return;
    const child = options.spawnChild();
    const abortListener = () => child.kill();
    options.signal?.addEventListener('abort', abortListener, { once: true });

    // The probe loop's interval sleep must end with its child, not only with the supervisor:
    // left to run, a pending 15s delay holds the process open after a deliberate stop.
    const childGone = new AbortController();
    const probeSignal = options.signal
      ? AbortSignal.any([options.signal, childGone.signal])
      : childGone.signal;
    const probing = options.probe
      ? startProbeLoop({
          child,
          probe: options.probe,
          sleep: options.sleep ?? ((ms: number) => abortAwareDelay(ms, probeSignal)),
          graceSleep,
          signal: options.signal,
          log: options.log,
          logCrash: options.logCrash,
        })
      : undefined;

    const outcome = await new Promise<ChildOutcome>((resolve) => {
      child.once('exit', (c, s) => resolve({ code: c, signal: s }));
      child.once('error', (err) => resolve({ code: null, signal: null, error: err }));
    });
    probing?.stop();
    childGone.abort();
    options.signal?.removeEventListener('abort', abortListener);
    const healthKilled = probing?.killedByProbe() ?? false;

    if (options.signal?.aborted) {
      options.log('supervise: stopping (operator interrupt).');
      return;
    }
    // A code-0 exit is a deliberate stop only when the supervisor did not order it: the
    // daemon shuts down gracefully on the health kill's SIGTERM and exits 0 as well.
    if (!outcome.error && outcome.code === 0 && !healthKilled) {
      options.log('supervise: daemon exited cleanly - supervision ends with it.');
      return;
    }

    const now = clock();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - (crashTimes[0] ?? 0) > windowMs) crashTimes.shift();
    const looping = crashTimes.length >= threshold;
    const delayMs = looping ? crashLoopDelayMs : restartDelayMs;
    const detail = outcome.error
      ? `daemon failed to start: ${outcome.error.message}`
      : `daemon exited code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'}` +
        (healthKilled ? ' after the health kill' : '');
    options.logCrash(`supervise: ${detail}; restarting in ${delayMs}ms`);
    options.log(
      `supervise: ${detail} - restarting in ${Math.round(delayMs / 1000)}s` +
        (looping
          ? ` (crash loop: ${crashTimes.length} exits in ${Math.round(windowMs / 1000)}s)`
          : ''),
    );
    await sleep(delayMs);
  }
}
