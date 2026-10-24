import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import type { PathLike, PathOrFileDescriptor, RmOptions, WriteFileOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from './lock.js';
import { LockTimeoutError } from './errors.js';

// A seam to force `rmSync` to fail for one specific path, so a reclaim can be made to throw the
// way a Windows EBUSY/EPERM (the holder still has the directory open) would — vi.spyOn can't
// touch a builtin's ESM namespace, so we replace the module with a thin passthrough. `failFor`
// is empty except during the reclaim-contention test, so every other test sees the real rmSync.
// `writes` records the path of every writeFileSync, which still writes through: it shows whether a
// file was written in place or under another name and renamed into place.
//
// `renames` makes the next renames onto an owner record fail with a code of its choosing, the way
// Windows refuses to replace a file a contender has open just then.
//
// `claimedWhenEmptied` makes the next delete of a path find a successor's lock there once it has
// emptied it, the way POSIX lets a contender's claim (a rename) replace an empty directory.
const rmState = vi.hoisted(() => ({
  failFor: new Set<string>(),
  claimedWhenEmptied: new Set<string>(),
}));
const writes = vi.hoisted(() => ({ paths: [] as string[] }));
const renames = vi.hoisted(() => ({ failures: 0, code: 'EPERM' }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: ((from: PathLike, to: PathLike): void => {
      if (renames.failures > 0 && String(to).endsWith('owner.json')) {
        renames.failures -= 1;
        const err: NodeJS.ErrnoException = new Error(`${renames.code}: operation not permitted`);
        err.code = renames.code;
        throw err;
      }
      return actual.renameSync(from, to);
    }) as typeof actual.renameSync,
    rmSync: ((target: PathLike, options?: RmOptions): void => {
      if (rmState.failFor.has(String(target))) {
        const err: NodeJS.ErrnoException = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      if (rmState.claimedWhenEmptied.delete(String(target))) {
        actual.rmSync(target, options);
        actual.mkdirSync(target);
        actual.writeFileSync(
          `${String(target)}/owner.json`,
          JSON.stringify({ token: 'successor' }),
        );
        const err: NodeJS.ErrnoException = new Error('ENOTEMPTY: directory not empty');
        err.code = 'ENOTEMPTY';
        throw err;
      }
      return actual.rmSync(target, options);
    }) as typeof actual.rmSync,
    writeFileSync: ((file: PathOrFileDescriptor, data: string, options?: WriteFileOptions) => {
      writes.paths.push(String(file));
      return actual.writeFileSync(file, data, options);
    }) as typeof actual.writeFileSync,
  };
});

let dirs: string[] = [];
async function sandbox(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ce-lock-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe('acquireLock', () => {
  it('grants an uncontended lock and releases it', async () => {
    const root = await sandbox();
    const lock = await acquireLock(join(root, '.lock'));
    lock.release();
    // A second acquire after release succeeds immediately.
    const again = await acquireLock(join(root, '.lock'));
    again.release();
  });

  it('is idempotent on release', async () => {
    const root = await sandbox();
    const lock = await acquireLock(join(root, '.lock'));
    lock.release();
    expect(() => lock.release()).not.toThrow();
  });

  it("releases without throwing when a contender claims the lock the moment it is emptied, leaving the successor's", async () => {
    const root = await sandbox();
    const dir = join(root, '.lock');
    const lock = await acquireLock(dir);
    rmState.claimedWhenEmptied.add(dir);
    expect(() => lock.release()).not.toThrow();
    expect(JSON.parse(await readFile(join(dir, 'owner.json'), 'utf8'))).toEqual({
      token: 'successor',
    });
  });

  it('still throws a release that fails for any other reason', async () => {
    const root = await sandbox();
    const dir = join(root, '.lock');
    const lock = await acquireLock(dir);
    rmState.failFor.add(dir);
    try {
      expect(() => lock.release()).toThrow(/EBUSY/);
    } finally {
      rmState.failFor.delete(dir);
    }
  });

  it('times out when a live holder keeps the lock', async () => {
    const root = await sandbox();
    const held = await acquireLock(join(root, '.lock'));
    try {
      await expect(
        acquireLock(join(root, '.lock'), Date.now, { timeoutMs: 150, pollMs: 20 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      held.release();
    }
  });

  it('reclaims a stale lock whose holder is long dead', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    // Forge a lock owned by a definitely-dead pid, started far in the past.
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2 ** 30, startedAtMs: 0, host: 'other-host' }),
    );
    // staleMs small so the ancient startedAtMs makes it reclaimable.
    const lock = await acquireLock(lockDir, Date.now, { timeoutMs: 1000, staleMs: 10 });
    lock.release();
  });

  it('reclaims a lock with a corrupt owner file', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    await mkdir(lockDir, { recursive: true });
    await writeFile(join(lockDir, 'owner.json'), '{ broken');
    const lock = await acquireLock(lockDir, Date.now, { timeoutMs: 1000 });
    lock.release();
  });

  it('reclaims a claimed-but-ownerless lock directory instead of wedging on it', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    // The exact intermediate state the OLD mkdir-then-write scheme let a contender observe: a
    // lock directory that exists but has no owner record inside it yet. Under the atomic-rename
    // scheme a lock is never published without its owner record, so this can only be a broken or
    // half-released lock — acquireLock must reclaim it and proceed, never treat it as a live
    // holder (the bug that let two processes both "hold" the lock).
    await mkdir(lockDir, { recursive: true });

    const lock = await acquireLock(lockDir, Date.now, { timeoutMs: 1000, pollMs: 20 });

    // We now hold a real lock: the owner record is present, so we never left it ownerless.
    const owner = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as {
      pid: number;
    };
    expect(owner.pid).toBe(process.pid);
    lock.release();
  });

  it('yields exactly one holder at a time under concurrent acquisition', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    let held = 0;
    let maxHeld = 0;
    // If a contender could ever observe a claimed-but-ownerless lock and reclaim a live one,
    // two workers would be inside the critical section together and `maxHeld` would exceed 1.
    //
    // The acquisition budget is deliberately far larger than the work: 20 workers holding for 1ms
    // need ~20ms of critical section, so a budget in the tens of seconds still fails fast on a
    // real deadlock while never failing merely because the machine was busy. This assertion is
    // about mutual exclusion, not latency, and a tighter budget made it flaky under parallel load.
    const worker = async () => {
      const lock = await acquireLock(lockDir, Date.now, { timeoutMs: 30_000, pollMs: 5 });
      held += 1;
      maxHeld = Math.max(maxHeld, held);
      await new Promise((resolve) => setTimeout(resolve, 1)); // hold briefly so races must wait
      held -= 1;
      lock.release();
    };
    await Promise.all(Array.from({ length: 20 }, () => worker()));
    expect(maxHeld).toBe(1);
  });

  it('a holder whose lock was reclaimed from under it never releases its successor', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    let now = 1_000;
    const clock = (): number => now;
    const first = await acquireLock(lockDir, clock, { staleMs: 100 });
    // The first holder is still alive, but past the staleness: a contender reclaims by age.
    now += 500;
    const second = await acquireLock(lockDir, clock, { staleMs: 100, timeoutMs: 1_000 });
    first.release();
    // The second claim is untouched: a third contender still has to wait for it.
    await expect(
      acquireLock(lockDir, clock, { staleMs: 10_000, timeoutMs: 0, pollMs: 1 }),
    ).rejects.toBeInstanceOf(LockTimeoutError);
    expect(first.refresh()).toBe(false);
    second.release();
    const third = await acquireLock(lockDir, clock, { timeoutMs: 0 });
    third.release();
  });

  it('a refreshed claim is not reclaimed by age while its holder keeps refreshing it', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    let now = 1_000;
    const clock = (): number => now;
    const held = await acquireLock(lockDir, clock, { staleMs: 100 });
    for (let i = 0; i < 5; i++) {
      now += 80;
      expect(held.refresh()).toBe(true);
      await expect(
        acquireLock(lockDir, clock, { staleMs: 100, timeoutMs: 0, pollMs: 1 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
    }
    // Left unrefreshed past the staleness, it is reclaimable as before.
    now += 500;
    const next = await acquireLock(lockDir, clock, { staleMs: 100, timeoutMs: 1_000 });
    expect(held.refresh()).toBe(false);
    next.release();
  });

  it('a refresh waits out a contender reading the owner record as it is replaced', async () => {
    // On Windows a rename over a file another process has open just then fails, and clears as soon
    // as the reader is done: that is no sign the claim was taken over.
    const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const lockDir = join(await sandbox(), '.lock');
      let now = 1_000;
      const held = await acquireLock(lockDir, () => now, { staleMs: 100 });
      now = 1_050;
      renames.failures = 3;
      expect(held.refresh()).toBe(true);
      const record = JSON.parse(await readFile(join(lockDir, 'owner.json'), 'utf8')) as {
        startedAtMs: number;
      };
      expect(record.startedAtMs).toBe(1_050);
      held.release();
    } finally {
      renames.failures = 0;
      Object.defineProperty(process, 'platform', real);
    }
  });

  it('a refresh that cannot replace the owner record for good reports the claim not renewed', async () => {
    const lockDir = join(await sandbox(), '.lock');
    const held = await acquireLock(lockDir, () => 1_000, { staleMs: 100 });
    renames.code = 'EACCES';
    renames.failures = 1;
    try {
      expect(held.refresh()).toBe(false);
    } finally {
      renames.failures = 0;
      renames.code = 'EPERM';
    }
    held.release();
  });

  it('a refresh never writes the live owner record in place, so no contender reads it torn', async () => {
    // A contender that read a half-written record would take the lock for broken and reclaim it
    // from its live holder: the new record is written beside it and renamed over it.
    const lockDir = join(await sandbox(), '.lock');
    const held = await acquireLock(lockDir, () => 1_000, { staleMs: 100 });
    writes.paths.length = 0;
    expect(held.refresh()).toBe(true);
    expect(writes.paths).not.toEqual([]);
    expect(writes.paths.filter((p) => p === join(lockDir, 'owner.json'))).toEqual([]);
    held.release();
  });

  it('times out cleanly when a stale lock cannot be reclaimed (reclaim contention)', async () => {
    const root = await sandbox();
    const lockDir = join(root, '.lock');
    // Forge a stale lock so reclaim WILL be attempted...
    await mkdir(lockDir, { recursive: true });
    await writeFile(
      join(lockDir, 'owner.json'),
      JSON.stringify({ pid: 2 ** 30, startedAtMs: 0, host: 'other-host' }),
    );
    // ...but simulate another process holding the directory open (Windows EBUSY/EPERM): every
    // attempt to remove the LOCK dir throws. Staging cleanup (a different path) uses the real
    // implementation so the acquiring call can still tidy up after itself.
    rmState.failFor.add(lockDir);
    try {
      // A reclaim failure must surface as the ordinary lock-contention error, never crash.
      await expect(
        acquireLock(lockDir, Date.now, { timeoutMs: 120, pollMs: 20, staleMs: 10 }),
      ).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      rmState.failFor.delete(lockDir);
    }
  });
});
