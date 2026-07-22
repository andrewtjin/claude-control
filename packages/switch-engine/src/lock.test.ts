import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import type { PathLike, RmOptions } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from './lock.js';
import { LockTimeoutError } from './errors.js';

// A seam to force `rmSync` to fail for one specific path, so a reclaim can be made to throw the
// way a Windows EBUSY/EPERM (the holder still has the directory open) would — vi.spyOn can't
// touch a builtin's ESM namespace, so we replace the module with a thin passthrough. `failFor`
// is empty except during the reclaim-contention test, so every other test sees the real rmSync.
const rmState = vi.hoisted(() => ({ failFor: new Set<string>() }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    rmSync: ((target: PathLike, options?: RmOptions): void => {
      if (rmState.failFor.has(String(target))) {
        const err: NodeJS.ErrnoException = new Error('EBUSY: resource busy or locked');
        err.code = 'EBUSY';
        throw err;
      }
      return actual.rmSync(target, options);
    }) as typeof actual.rmSync,
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
    const worker = async () => {
      const lock = await acquireLock(lockDir, Date.now, { timeoutMs: 5000, pollMs: 5 });
      held += 1;
      maxHeld = Math.max(maxHeld, held);
      await new Promise((resolve) => setTimeout(resolve, 1)); // hold briefly so races must wait
      held -= 1;
      lock.release();
    };
    await Promise.all(Array.from({ length: 20 }, () => worker()));
    expect(maxHeld).toBe(1);
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
