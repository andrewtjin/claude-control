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
//      would fight its own operator. A spawn failure (missing binary, EPERM, ...) surfaces as
//      the child's 'error' event rather than 'exit' — Node's own contract for a child that
//      never actually started, and 'exit' may never follow it — so that path is treated as a
//      crash too, never a silent hang or an uncaught throw.
//   3. The optional health probe: a crashed child is easy (it exits), but a HUNG one — alive,
//      event loop wedged, never answering a hook — never exits on its own. While a child is
//      alive, superviseDaemon can poll its /healthz on an interval and, after enough
//      consecutive failures, kill it so the ordinary respawn path takes over. Absent the
//      `probe` option, behavior is unchanged from before this existed.
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
  kill(): void;
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

/**
 * Run the health-probe loop for one live child: probeFn every intervalMs, and after
 * `failuresToKill` CONSECUTIVE unhealthy results, kill the child so the ordinary exit path
 * (in superviseDaemon, below) respawns it. Returns a cancel function — call it as soon as the
 * child's own exit/error settles, or the supervisor aborts, so no probe timer ever outlives
 * the child it was watching.
 */
function startProbeLoop(args: {
  child: SupervisedChild;
  probe: ProbeOptions;
  sleep: (ms: number) => Promise<void>;
  signal: AbortSignal | undefined;
  log: (line: string) => void;
  logCrash: (line: string) => void;
}): () => void {
  const { child, probe, sleep, signal, log, logCrash } = args;
  const intervalMs = probe.intervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
  const failuresToKill = probe.failuresToKill ?? DEFAULT_PROBE_FAILURES_TO_KILL;
  let cancelled = false;
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
      const detail = `supervise: daemon unresponsive (${consecutiveFailures} consecutive health probes failed); killing for respawn`;
      logCrash(detail);
      log(detail);
      child.kill();
    }
  })();

  return () => {
    cancelled = true;
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
 * exit — is logged to both sinks and answered with a respawn.
 */
export async function superviseDaemon(options: SuperviseOptions): Promise<void> {
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const windowMs = options.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
  const threshold = options.crashLoopThreshold ?? DEFAULT_CRASH_LOOP_THRESHOLD;
  const crashLoopDelayMs = options.crashLoopDelayMs ?? DEFAULT_CRASH_LOOP_DELAY_MS;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => abortAwareDelay(ms, options.signal));
  const crashTimes: number[] = [];

  for (;;) {
    if (options.signal?.aborted) return;
    const child = options.spawnChild();
    const abortListener = () => child.kill();
    options.signal?.addEventListener('abort', abortListener, { once: true });

    const stopProbing = options.probe
      ? startProbeLoop({
          child,
          probe: options.probe,
          sleep,
          signal: options.signal,
          log: options.log,
          logCrash: options.logCrash,
        })
      : undefined;

    const outcome = await new Promise<ChildOutcome>((resolve) => {
      child.once('exit', (c, s) => resolve({ code: c, signal: s }));
      child.once('error', (err) => resolve({ code: null, signal: null, error: err }));
    });
    stopProbing?.();
    options.signal?.removeEventListener('abort', abortListener);

    if (options.signal?.aborted) {
      options.log('supervise: stopping (operator interrupt).');
      return;
    }
    if (!outcome.error && outcome.code === 0) {
      options.log('supervise: daemon exited cleanly — supervision ends with it.');
      return;
    }

    const now = clock();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - (crashTimes[0] ?? 0) > windowMs) crashTimes.shift();
    const looping = crashTimes.length >= threshold;
    const delayMs = looping ? crashLoopDelayMs : restartDelayMs;
    const detail = outcome.error
      ? `daemon failed to start: ${outcome.error.message}`
      : `daemon exited code=${outcome.code ?? 'null'} signal=${outcome.signal ?? 'none'}`;
    options.logCrash(`supervise: ${detail}; restarting in ${delayMs}ms`);
    options.log(
      `supervise: ${detail} — restarting in ${Math.round(delayMs / 1000)}s` +
        (looping
          ? ` (crash loop: ${crashTimes.length} exits in ${Math.round(windowMs / 1000)}s)`
          : ''),
    );
    await sleep(delayMs);
  }
}
