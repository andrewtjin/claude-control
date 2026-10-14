// Cross-process credential lock.
//
// The daemon and the `cctl` CLI are separate processes that may both try to switch at once,
// so the lock lives on the filesystem, not in memory. The lock is a DIRECTORY claimed by an
// atomic rename: a process builds the directory privately — with its owner record already
// inside — then renames it onto the public lock name. A rename onto an existing name fails,
// so exactly one contender wins; the rest retry. Writing the owner record BEFORE the directory
// is renamed into view is the crux: a contender can never observe the lock in a
// claimed-but-ownerless state, so reclaim can safely treat a missing/corrupt owner record as a
// genuinely broken lock instead of a half-finished acquisition it must tiptoe around. A lock
// records the holder's pid and start time so a crashed holder's stale lock can be reclaimed
// instead of deadlocking forever, and a token of its own claim: a holder whose lock was reclaimed
// from under it (it outlived the staleness) must never remove the lock its successor now holds.
//
// This is a mutex between OUR processes. It cannot lock out the Claude CLI itself — that
// race is handled separately by reconcile-by-reading in the switch engine.

import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
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
  /** When the holder claimed the lock, or last refreshed its claim (see {@link Lock.refresh}). */
  startedAtMs: number;
  host: string;
  /** Unique to one claim, so a holder can tell its own lock from a successor's. */
  token: string;
}

/**
 * How old a holder may be before a contender presumes it dead and reclaims the lock.
 *
 * Exported because it is not a lock-internal default: it is the ceiling on everything a holder
 * does while holding. Reclaim goes by AGE for a live holder — the owner record's `startedAtMs`
 * is stamped once at the claim and never renewed — so a holder that spends longer than this
 * inside the lock has it pulled out from under it mid-write, and the network budgets of the
 * calls that run under it are sized from this number (see overload.ts's
 * {@link LOCKED_CALL_BUDGET_MS}).
 */
export const LOCK_STALE_MS = 60_000;

const DEFAULTS: Required<LockOptions> = {
  timeoutMs: 15_000,
  pollMs: 100,
  staleMs: LOCK_STALE_MS,
};

/** A held lock. Call {@link release} exactly once (a `try/finally` in the caller). */
export class Lock {
  private released = false;

  constructor(
    private readonly dir: string,
    private readonly token: string,
    private readonly clock: () => number,
  ) {}

  /** Whether the lock directory still holds this claim's owner record. */
  private stillOurs(): boolean {
    try {
      const record = JSON.parse(readFileSync(join(this.dir, 'owner.json'), 'utf8')) as LockRecord;
      return record.token === this.token;
    } catch {
      // Gone (reclaimed and released since), or not readable: nothing here is provably ours.
      return false;
    }
  }

  /**
   * Restamp the claim's time, so a holder that is alive but holds for long (a move that waits on
   * Claude Code) is never reclaimed as stale by age. The record is replaced by a rename, so a
   * contender never reads it half-written. Returns false, touching nothing, once the lock is no
   * longer this claim's.
   */
  refresh(): boolean {
    if (this.released || !this.stillOurs()) return false;
    const record: LockRecord = {
      pid: process.pid,
      startedAtMs: this.clock(),
      host: hostId(),
      token: this.token,
    };
    const temp = join(this.dir, `owner.${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, JSON.stringify(record));
      renameSync(temp, join(this.dir, 'owner.json'));
      return true;
    } catch {
      // Reclaimed between the check and the write: the claim is lost, and the temp file with it.
      try {
        unlinkSync(temp);
      } catch {
        // Already gone with the directory.
      }
      return false;
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    // Remove the lock directory only while it is still this claim's. A holder that outlived the
    // staleness had it reclaimed, and the directory there now is its successor's.
    if (this.stillOurs()) rmSync(this.dir, { recursive: true, force: true });
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

  // Build the lock in a private staging directory that shares the lock's parent, so the final
  // rename is a same-filesystem move (atomic), never a cross-device copy. A per-call unique name
  // means two processes — or two attempts — never collide on the staging dir itself.
  const staging = `${lockDir}.staging-${randomUUID()}`;
  const token = randomUUID();
  mkdirSync(staging, { recursive: true });
  try {
    for (;;) {
      // Refresh the owner record on every attempt so `startedAtMs` reflects the moment of the
      // claim, not the (possibly much earlier) start of a long contended wait.
      const record: LockRecord = { pid: process.pid, startedAtMs: clock(), host: hostId(), token };
      writeFileSync(join(staging, 'owner.json'), JSON.stringify(record));
      try {
        // Atomic claim: rename fails if the lock already exists, so exactly one contender wins.
        // The owner record is already inside the directory being moved, so the lock never
        // becomes visible without it.
        renameSync(staging, lockDir);
        return new Lock(lockDir, token, clock);
      } catch (err) {
        if (!isLockHeld(err)) throw err;
        // Someone holds it. Reclaim if the holder is dead; otherwise wait and retry. The staging
        // dir still exists (the rename failed), so the next attempt reuses it.
        reclaimIfStale(lockDir, clock(), staleMs);
        if (clock() >= deadline) {
          throw new LockTimeoutError(
            `could not acquire credential lock at ${lockDir} within ${timeoutMs}ms`,
          );
        }
        await sleep(pollMs);
      }
    }
  } finally {
    // Drop the staging dir if we still own it (timed out, or threw before a winning rename). A
    // successful rename already consumed it, so `force` makes the now-absent path a no-op. This
    // never touches `lockDir` — only our own staging path.
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * rename failure codes that mean "the lock already exists" (a live or stale holder), as opposed
 * to a genuine IO fault. Windows reports EEXIST/EPERM/EACCES for a rename onto an existing
 * directory; POSIX reports ENOTEMPTY (the lock always holds an owner file, so it is never the
 * empty dir POSIX would let a rename replace) or EEXIST. All route to reclaim-or-wait; any other
 * code is a real error and propagates.
 */
function isLockHeld(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EACCES';
}

function reclaimIfStale(lockDir: string, now: number, staleMs: number): void {
  try {
    const record = JSON.parse(readFileSync(join(lockDir, 'owner.json'), 'utf8')) as LockRecord;
    if (!isStale(record, now, staleMs)) return; // a live holder — leave it alone
  } catch {
    // Missing or unparseable owner record. Because a lock only ever becomes visible with its
    // owner record already inside it (the atomic rename above), this can NOT be a half-finished
    // acquisition we would be racing — it is a genuinely broken lock, or one being released right
    // now. Falling through to reclaim it is therefore safe, and keeps a broken lock from wedging
    // every future acquirer forever.
  }
  try {
    rmSync(lockDir, { recursive: true, force: true });
  } catch {
    // The holder may still have the directory open (Windows can throw EBUSY/EPERM) or be partway
    // through its own release. A failed reclaim is not fatal: leave the lock in place and let the
    // caller's retry/backoff loop try again, or time out with a clean LockTimeoutError — never
    // escalate a reclaim race into a thrown IO error.
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
