import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock } from './lock.js';
import { LockTimeoutError } from './errors.js';

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
});
