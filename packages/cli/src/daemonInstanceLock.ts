// Prevents a second `cctl daemon run` from starting while one is already live. Without this, two
// daemons fight over the same hook-endpoint.json, settings.json hook installs, the hook secret,
// and daemon.db — all four get corrupted by the loser writing over the winner mid-run.
//
// ATOMICITY: a plain `existsSync(target) ? refuse : writeFileSync(target, ...)` has a gap between
// the check and the write, wide enough for two racing starters to both pass the check before
// either writes. The fix (in the spirit of the credential lock's rename-based claim in
// switch-engine/lock.ts, adapted for a single file rather than a directory) is to publish the pid
// record through a filesystem operation that is ITSELF exclusive: write the full record to a
// uniquely-named temp file in the SAME directory (so the eventual link is same-filesystem, never
// a cross-device copy), then `link()` the temp file onto `daemon.pid`.
//
// `link()`, not `rename()`: hard-link creation fails with EEXIST when the target already exists,
// which is exactly the exclusive-create primitive this needs. `rename()` does not give that —
// verified empirically on this platform, `fs.renameSync(tmp, target)` SILENTLY OVERWRITES an
// existing `target` with no error (the same overwrite-on-rename behavior the repo's
// `atomicWriteFile` helper deliberately relies on for atomic REPLACE elsewhere), so it cannot
// double as a race detector here — two racing starters would both "succeed", each overwriting the
// other's just-published record. `link()`'s EEXIST is therefore the definitive "someone else
// already holds (or has just retaken) this lock" signal, including for the tiny window between
// this process's own staleness read and its own write.

import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** On-disk record of the daemon holding the instance lock. */
interface InstanceLockRecord {
  pid: number;
  startedAt: string;
}

/** Stable location: a sibling of the vault / daemon-identity / hook-secret under the
 *  claude-control data dir, matching the naming convention of crashLogPath/hookSecretPath. */
export function instanceLockPath(dataDir: string): string {
  return join(dataDir, 'daemon.pid');
}

/** Thrown by {@link acquireInstanceLock} when another daemon already holds the lock. `message`
 *  is the actionable, user-facing refusal text — callers print it as-is, they never need to
 *  re-derive anything from `pid`. */
export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number) {
    super(
      `another daemon (pid ${pid}) is already running — stop it or use ` +
        '`cctl daemon supervise` exclusively.',
    );
    this.name = new.target.name;
  }
}

/** Read and parse the lock file, or `undefined` if it is absent OR unparseable. Both cases are
 *  treated identically by every caller: a lock file that cannot be attributed to a specific pid
 *  is not a lock anyone can be holding. */
async function readLockRecord(filePath: string): Promise<InstanceLockRecord | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined; // no lock has ever been written here
  }
  try {
    const parsed = JSON.parse(raw) as Partial<InstanceLockRecord>;
    if (typeof parsed.pid !== 'number' || typeof parsed.startedAt !== 'string') {
      return undefined; // structurally wrong -> corrupt, treat as absent
    }
    return { pid: parsed.pid, startedAt: parsed.startedAt };
  } catch {
    return undefined; // corrupt / half-written blob
  }
}

/** Whether `pid` names a live process. `process.kill(pid, 0)` sends no signal — it only asks the
 *  OS whether the pid exists. ESRCH ("no such process") is the only code that means dead; every
 *  other outcome, notably EPERM (Windows raises this for a pid that exists but this process
 *  lacks rights to signal), means the process is there. */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Bounded retries for the acquire loop: one attempt can lose a genuine race to a concurrent
 *  starter reclaiming the very same stale lock, and one retry after that resolves it. A tight
 *  bound (rather than the credential lock's unbounded polling) is correct here because there is
 *  nothing worth WAITING for — a live holder is a permanent refusal, not a transient contention
 *  state that clears with time. */
const MAX_ACQUIRE_ATTEMPTS = 5;

/**
 * Claim the single-instance lock for this daemon process. Writes `<dataDir>/daemon.pid` with
 * `{ pid: process.pid, startedAt }`. Throws {@link DaemonAlreadyRunningError} if another live
 * process already holds it; silently reclaims a stale lock (dead pid, or a corrupt/unparseable
 * file) and proceeds.
 */
export async function acquireInstanceLock(dataDir: string): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = instanceLockPath(dataDir);

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
    const record: InstanceLockRecord = { pid: process.pid, startedAt: new Date().toISOString() };
    // Per-call unique temp name in the SAME directory as `target`: same-filesystem, so the link
    // below is a metadata-only operation, and unique so concurrent acquirers never collide on the
    // temp file itself (only on the final `link`, which is the point where exactly one must win).
    const tmp = join(dataDir, `.daemon.pid.tmp-${process.pid}-${randomUUID()}`);
    await writeFile(tmp, JSON.stringify(record), 'utf8');
    try {
      await link(tmp, target);
      return; // we now hold the lock; `target` and `tmp` are two names for the same content
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    } finally {
      // Always disposable: on success the content is already reachable via `target`; on failure
      // it was never published anywhere else.
      await rm(tmp, { force: true });
    }

    // Lost the race, or found a leftover lock from a previous run — decide whether it is worth
    // reclaiming.
    const existing = await readLockRecord(target);
    if (existing !== undefined && isPidAlive(existing.pid)) {
      throw new DaemonAlreadyRunningError(existing.pid);
    }
    // Stale (dead pid) or corrupt: clear it and loop to retry the exclusive link. Another starter
    // may be reclaiming this very same stale lock concurrently — if it wins, the next `link`
    // attempt EEXISTs again and this loop re-reads to find its (now live) pid.
    await rm(target, { force: true });
  }
  // Only reachable under pathological, sustained contention (every attempt loses the race to a
  // DIFFERENT concurrent reclaimer) — a real condition, not a "should never happen", so it gets
  // its own message rather than an assertion.
  throw new Error(
    `could not acquire the daemon instance lock at ${target} after ${MAX_ACQUIRE_ATTEMPTS} attempts`,
  );
}

/**
 * Release the instance lock, but ONLY if it still records THIS process's pid — the same
 * guarded-delete pattern the hook forwarder uses for its endpoint file cleanup. Without the
 * re-read, a slow release racing a fresh acquire could delete a lock this process no longer
 * owns (its own lock went stale and was reclaimed by another daemon before this process's own
 * shutdown path got around to cleaning up).
 */
export async function releaseInstanceLock(dataDir: string): Promise<void> {
  const target = instanceLockPath(dataDir);
  const existing = await readLockRecord(target);
  if (existing === undefined || existing.pid !== process.pid) return; // not (or no longer) ours
  await rm(target, { force: true });
}
