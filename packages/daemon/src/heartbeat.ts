// Liveness signal for the running daemon process.
//
// The daemon and `cctl daemon status` are separate processes — the daemon runs headless under
// a logon Scheduled Task with no attached console, so there is no process handle for `cctl` to
// query directly. A small file beside the vault, touched on a timer, is the one channel that
// survives a hard crash or a killed process: `cctl daemon status` reads its age to tell "alive"
// from "silently dead" without needing the daemon's cooperation at read time.
//
// Write cadence is deliberately loose: liveness only needs to be "recently true", not
// real-time, and a reader tolerates a few missed ticks before calling it stale.

import { readFile } from 'node:fs/promises';
import { atomicWriteFile } from '@claude-control/switch-engine';

/** How often the running daemon touches its heartbeat file. */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** A heartbeat older than this many missed ticks reads as stale rather than alive — generous
 *  enough that one slow write (disk hiccup, GC pause) never flips a live daemon to "stale" in
 *  `cctl daemon status`. */
export const HEARTBEAT_STALE_AFTER_MS = HEARTBEAT_INTERVAL_MS * 3;

interface HeartbeatFile {
  writtenAtMs: number;
}

export interface HeartbeatWriterOptions {
  intervalMs?: number;
  clock?: () => number;
  /** A write failure is never fatal to the daemon itself — report it, don't throw; the next
   *  tick tries again. */
  onError?: (err: unknown) => void;
}

/**
 * Writes {@link HeartbeatFile} to `filePath` immediately on `start()`, then every
 * `intervalMs`, until `stop()`. One writer per daemon process.
 */
export class HeartbeatWriter {
  private readonly filePath: string;
  private readonly intervalMs: number;
  private readonly clock: () => number;
  private readonly onError: ((err: unknown) => void) | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(filePath: string, options: HeartbeatWriterOptions = {}) {
    this.filePath = filePath;
    this.intervalMs = options.intervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.clock = options.clock ?? Date.now;
    this.onError = options.onError;
  }

  start(): void {
    if (this.timer) return; // already running — start() is idempotent
    const tick = (): void => {
      this.writeOnce().catch((err: unknown) => this.onError?.(err));
    };
    tick();
    this.timer = setInterval(tick, this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  private async writeOnce(): Promise<void> {
    const payload: HeartbeatFile = { writtenAtMs: this.clock() };
    // Atomic replace, not a plain write: `cctl daemon status` reads this file on its own
    // schedule, and a reader that catches a truncated write parses nothing and reports the
    // daemon as having NEVER run — the most alarming possible reading of a live daemon.
    await atomicWriteFile(this.filePath, JSON.stringify(payload));
  }
}

/** 'never' = no heartbeat file has ever been written here (fresh install, or the daemon has
 *  never started on this machine) — distinct from 'stale' (it ran before, but the most recent
 *  write is too old to trust). */
export type HeartbeatState = 'alive' | 'stale' | 'never';

/** A discriminated union rather than optional fields on one shape: 'never' genuinely has no
 *  age to report, and callers should not need an `?? 0` fallback to read the other two. */
export type HeartbeatReading =
  { state: 'never' } | { state: 'alive' | 'stale'; writtenAtMs: number; ageMs: number };

/**
 * Read and classify the heartbeat file against `nowMs`. Missing or unparseable content reads
 * as 'never' rather than throwing — this feeds a purely informational view (`cctl daemon
 * status`) that must degrade gracefully, the same stance `dpapiIdentityStore.load()` takes for
 * a corrupt identity file.
 */
export async function readHeartbeat(
  filePath: string,
  nowMs: number = Date.now(),
  staleAfterMs: number = HEARTBEAT_STALE_AFTER_MS,
): Promise<HeartbeatReading> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return { state: 'never' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'never' };
  }
  const writtenAtMs = (parsed as Partial<HeartbeatFile>).writtenAtMs;
  if (typeof writtenAtMs !== 'number') return { state: 'never' };
  const ageMs = nowMs - writtenAtMs;
  return { state: ageMs > staleAfterMs ? 'stale' : 'alive', writtenAtMs, ageMs };
}
