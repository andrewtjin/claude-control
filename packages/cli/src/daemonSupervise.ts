// Daemon supervision: crash visibility and restart-on-crash.
//
// Two pieces, both born from the same live incident — the daemon died silently overnight and
// nothing restarted it, so every session paid the dead-port hook tax until morning:
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
//      would fight its own operator.
//
// The loop is dependency-injected (spawn/clock/sleep) so the policy is provable in unit
// tests without real processes.

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

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

/** The one child capability the loop needs — tests inject an emitter-backed fake. */
export interface SupervisedChild {
  once(event: 'exit', listener: (code: number | null, signal: string | null) => void): void;
  kill(): void;
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
}

const DEFAULT_RESTART_DELAY_MS = 2_000;
const DEFAULT_CRASH_LOOP_WINDOW_MS = 60_000;
const DEFAULT_CRASH_LOOP_THRESHOLD = 5;
const DEFAULT_CRASH_LOOP_DELAY_MS = 30_000;

/**
 * Run the supervision loop until the child exits cleanly (deliberate stop) or `signal`
 * aborts. Every non-zero exit is logged to both sinks and answered with a respawn.
 */
export async function superviseDaemon(options: SuperviseOptions): Promise<void> {
  const restartDelayMs = options.restartDelayMs ?? DEFAULT_RESTART_DELAY_MS;
  const windowMs = options.crashLoopWindowMs ?? DEFAULT_CRASH_LOOP_WINDOW_MS;
  const threshold = options.crashLoopThreshold ?? DEFAULT_CRASH_LOOP_THRESHOLD;
  const crashLoopDelayMs = options.crashLoopDelayMs ?? DEFAULT_CRASH_LOOP_DELAY_MS;
  const clock = options.clock ?? Date.now;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const crashTimes: number[] = [];

  for (;;) {
    if (options.signal?.aborted) return;
    const child = options.spawnChild();
    const abortListener = () => child.kill();
    options.signal?.addEventListener('abort', abortListener, { once: true });
    const { code, signal } = await new Promise<{ code: number | null; signal: string | null }>(
      (resolve) => child.once('exit', (c, s) => resolve({ code: c, signal: s })),
    );
    options.signal?.removeEventListener('abort', abortListener);

    if (options.signal?.aborted) {
      options.log('supervise: stopping (operator interrupt).');
      return;
    }
    if (code === 0) {
      options.log('supervise: daemon exited cleanly — supervision ends with it.');
      return;
    }

    const now = clock();
    crashTimes.push(now);
    while (crashTimes.length > 0 && now - (crashTimes[0] ?? 0) > windowMs) crashTimes.shift();
    const looping = crashTimes.length >= threshold;
    const delayMs = looping ? crashLoopDelayMs : restartDelayMs;
    const detail = `daemon exited code=${code ?? 'null'} signal=${signal ?? 'none'}`;
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
