import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireInstanceLock,
  releaseInstanceLock,
  instanceLockPath,
  DaemonAlreadyRunningError,
} from './daemonInstanceLock.js';

// A definitely-dead pid: astronomically above any real pid range, and a fresh mkdtemp sandbox
// per test means nothing here could ever coincide with a live process.
const DEAD_PID = 999_999_999;

let dirs: string[] = [];
async function sandbox(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'cctl-instance-lock-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

describe('acquireInstanceLock / releaseInstanceLock', () => {
  it('acquires on a clean dir, writing our pid, then releases cleanly', async () => {
    const dir = await sandbox();
    const lockFile = instanceLockPath(dir);

    await acquireInstanceLock(dir);
    const record = JSON.parse(await readFile(lockFile, 'utf8')) as {
      pid: number;
      startedAt: string;
    };
    expect(record.pid).toBe(process.pid);
    expect(Number.isNaN(Date.parse(record.startedAt))).toBe(false);

    await releaseInstanceLock(dir);
    await expect(readFile(lockFile, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses when the recorded pid is alive, and leaves the file untouched', async () => {
    const dir = await sandbox();
    const lockFile = instanceLockPath(dir);
    // Our own pid stands in for "another daemon" here — it is guaranteed alive without the test
    // needing to spawn a real second process.
    const original = { pid: process.pid, startedAt: '2020-01-01T00:00:00.000Z' };
    await writeFile(lockFile, JSON.stringify(original), 'utf8');

    await expect(acquireInstanceLock(dir)).rejects.toThrow(DaemonAlreadyRunningError);
    await expect(acquireInstanceLock(dir)).rejects.toThrow(String(process.pid));

    // Refused acquisition must not touch the existing record.
    expect(JSON.parse(await readFile(lockFile, 'utf8'))).toEqual(original);
  });

  it('reclaims a stale lock left by a dead pid and proceeds', async () => {
    const dir = await sandbox();
    const lockFile = instanceLockPath(dir);
    await writeFile(
      lockFile,
      JSON.stringify({ pid: DEAD_PID, startedAt: '2020-01-01T00:00:00.000Z' }),
      'utf8',
    );

    await acquireInstanceLock(dir);

    const record = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
  });

  it('treats a corrupt lock file as stale and replaces it', async () => {
    const dir = await sandbox();
    const lockFile = instanceLockPath(dir);
    await writeFile(lockFile, '{ not valid json', 'utf8');

    await acquireInstanceLock(dir);

    const record = JSON.parse(await readFile(lockFile, 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
  });

  it("release only removes a lock this process owns, preserving someone else's", async () => {
    const dir = await sandbox();
    const lockFile = instanceLockPath(dir);
    const someoneElse = { pid: DEAD_PID, startedAt: '2020-01-01T00:00:00.000Z' };
    await writeFile(lockFile, JSON.stringify(someoneElse), 'utf8');

    await releaseInstanceLock(dir);

    expect(JSON.parse(await readFile(lockFile, 'utf8'))).toEqual(someoneElse);
  });

  it('release on an already-absent lock is a no-op, not an error', async () => {
    const dir = await sandbox();
    await expect(releaseInstanceLock(dir)).resolves.toBeUndefined();
  });

  it('supports acquire -> release -> acquire (a restarted daemon reclaims cleanly)', async () => {
    const dir = await sandbox();
    await acquireInstanceLock(dir);
    await releaseInstanceLock(dir);
    await acquireInstanceLock(dir);
    const record = JSON.parse(await readFile(instanceLockPath(dir), 'utf8')) as { pid: number };
    expect(record.pid).toBe(process.pid);
  });
});
