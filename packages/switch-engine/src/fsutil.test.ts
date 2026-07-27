import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile } from './fsutil.js';

// A seam to make `rename` fail the way a Windows sharing violation does — the target is open in
// another process, so the replace is refused with EPERM until that handle closes. vi.spyOn cannot
// touch a builtin's ESM namespace, so the module is replaced with a thin passthrough.
//
// The fault is keyed to the SOURCE path, which `atomicWriteFile` makes unique per call, so arming
// it targets exactly one write and its retries; `maxFailures` then decides whether that write ever
// gets through, without the test needing to know how many attempts the writer makes.
const renameFault = vi.hoisted(() => ({
  armed: false,
  source: '',
  code: 'EPERM',
  calls: 0,
  maxFailures: Number.POSITIVE_INFINITY,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: ((from: string, to: string): Promise<void> => {
      if (renameFault.armed) {
        if (renameFault.source === '') renameFault.source = String(from);
        if (renameFault.source === String(from) && renameFault.calls < renameFault.maxFailures) {
          renameFault.calls += 1;
          const err: NodeJS.ErrnoException = new Error(
            `${renameFault.code}: operation not permitted, rename`,
          );
          err.code = renameFault.code;
          return Promise.reject(err);
        }
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

let dirs: string[] = [];
async function sandbox(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'ce-fsutil-'));
  dirs.push(d);
  return d;
}

beforeEach(() => {
  renameFault.armed = false;
  renameFault.source = '';
  renameFault.code = 'EPERM';
  renameFault.calls = 0;
  renameFault.maxFailures = Number.POSITIVE_INFINITY;
});
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** Temp files `atomicWriteFile` left in `dir`, by the prefix it names them with. */
async function strayTempFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.startsWith('.tmp-'));
}

describe('atomicWriteFile', () => {
  it('replaces the target with the new content', async () => {
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    await writeFile(target, 'old');
    await atomicWriteFile(target, 'new');
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await strayTempFiles(dir)).toEqual([]);
  });

  it('waits out a rename that lost a race with a concurrent reader', async () => {
    // A reader holding the target open for the length of one `readFile` is not a reason to fail a
    // credential write: the condition clears on its own, so the write rides it out instead of
    // making every caller carry a race it cannot avoid.
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    renameFault.maxFailures = 3;
    renameFault.armed = true;
    await atomicWriteFile(target, 'new');
    expect(renameFault.calls).toBe(3);
    expect(await readFile(target, 'utf8')).toBe('new');
    expect(await strayTempFiles(dir)).toEqual([]);
  });

  it('leaves no temp file behind when the rename never succeeds', async () => {
    // The temp lives in the target's own directory — for credentials, the vault — so a write that
    // gives up without cleaning up turns that directory into a growing pile of partial copies.
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    await writeFile(target, 'old');
    renameFault.armed = true;
    await expect(atomicWriteFile(target, 'new')).rejects.toMatchObject({ code: 'EPERM' });
    expect(await strayTempFiles(dir)).toEqual([]);
    // Atomic in the failure case too: a reader still sees the whole old file, never a partial one.
    expect(await readFile(target, 'utf8')).toBe('old');
    // The wait is bounded — an unresolvable fault must surface, not retry forever.
    expect(renameFault.calls).toBeLessThan(50);
  });

  it('reports a rename fault that waiting cannot clear without retrying it', async () => {
    // Retrying is for a race that resolves itself. A full disk, a cross-device target, a missing
    // directory — none of those improve by being asked again, and spending the retry budget on
    // them only delays the error the caller needs.
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    renameFault.code = 'ENOSPC';
    renameFault.armed = true;
    await expect(atomicWriteFile(target, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(renameFault.calls).toBe(1);
    expect(await strayTempFiles(dir)).toEqual([]);
  });
});
