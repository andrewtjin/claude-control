// Cross-process credential lock.
//
// The daemon and the `cctl` CLI are separate processes that may both try to switch at once,
// so the lock lives on the filesystem, not in memory. Acquisition is an atomic `mkdir`:
// exactly one process can create the lock directory; the rest retry. A lock records the
// holder's pid and start time so a crashed holder's stale lock can be reclaimed instead of
// deadlocking forever.
//
// This is a mutex between OUR processes. It cannot lock out the Claude CLI itself — that
// race is handled separately by reconcile-by-reading in the switch engine.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir } from './fsutil.js';
import { LockTimeoutError } from './errors.js';

export interface LockOptions {
  /** Give up acquiring after this long. */
  timeoutMs?: number;
  /** Poll interval while waiting. */
  pollMs?: number;
  /** A lock whose holder started longer ago than this is presumed dead and reclaimable. */
  staleMs?: number;
}

interface LockRecord {
  pid: number;
  startedAtMs: number;
  host: string;
}

const DEFAULTS: Required<LockOptions> = {
  timeoutMs: 15_000,
  pollMs: 100,
  staleMs: 60_000,
};

/** A held lock. Call {@link release} exactly once (a `try/finally` in the caller). */
export class Lock {
  private released = false;

  constructor(private readonly dir: string) {}

  release(): void {
    if (this.released) return;
    this.released = true;
    // Remove the lock directory; ignore if it is already gone (reclaimed as stale, etc.).
    rmSync(this.dir, { recursive: true, force: true });
  }
}

/** Whether a lock's holder looks dead: not a live process, or older than `staleMs`. */
function isStale(record: LockRecord, now: number, staleMs: number): boolean {
  if (now - record.startedAtMs > staleMs) return true;
  // A same-host record whose pid no longer exists is definitively stale.
  if (record.host === hostId()) {
    try {
      process.kill(record.pid, 0); // signal 0 = existence check, kills nothing
      return false; // holder is alive
    } catch (err) {
      // ESRCH = no such process → stale. EPERM = exists but not ours → alive.
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
  return false;
}

function hostId(): string {
  return process.env.COMPUTERNAME || process.env.HOSTNAME || 'local';
}

/**
 * Acquire the credential lock, waiting up to `timeoutMs`. Reclaims a stale lock from a dead
 * holder. Throws {@link LockTimeoutError} if a live holder keeps it past the timeout.
 */
export async function acquireLock(
  lockDir: string,
  clock: () => number = Date.now,
  options: LockOptions = {},
): Promise<Lock> {
  const { timeoutMs, pollMs, staleMs } = { ...DEFAULTS, ...options };
  const deadline = clock() + timeoutMs;
  ensureDir(join(lockDir, '..'));

  for (;;) {
    try {
      mkdirSync(lockDir); // atomic: succeeds for exactly one contender
      const record: LockRecord = { pid: process.pid, startedAtMs: clock(), host: hostId() };
      writeFileSync(join(lockDir, 'owner.json'), JSON.stringify(record));
      return new Lock(lockDir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      // Someone holds it. Reclaim if the holder is dead; otherwise wait and retry.
      reclaimIfStale(lockDir, clock(), staleMs);
      if (clock() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire credential lock at ${lockDir} within ${timeoutMs}ms`,
        );
      }
      await sleep(pollMs);
    }
  }
}

function reclaimIfStale(lockDir: string, now: number, staleMs: number): void {
  try {
    const record = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as LockRecord;
    if (isStale(record, now, staleMs)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  } catch {
    // Owner file missing/corrupt: treat as stale so a broken lock can't wedge us forever.
    rmSync(lockDir, { recursive: true, force: true });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
