import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, isTransientRenameError } from './fsutil.js';

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

// The retry ladder only exists for a Windows sharing violation, so which platform the writer
// believes it is on is now part of its behavior — and both branches have to be provable from
// either kind of machine, or CI covers exactly one of them. `process.platform` is read at the
// moment of the failure, so swapping it for the length of a test is enough.
const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
function pretendPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

beforeEach(() => {
  renameFault.armed = false;
  renameFault.source = '';
  renameFault.code = 'EPERM';
  renameFault.calls = 0;
  renameFault.maxFailures = Number.POSITIVE_INFINITY;
});
afterEach(async () => {
  if (realPlatform) Object.defineProperty(process, 'platform', realPlatform);
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
    // credential write: on Windows that condition clears on its own, so the write rides it out
    // instead of making every caller carry a race it cannot avoid.
    pretendPlatform('win32');
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
    pretendPlatform('win32');
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
    pretendPlatform('win32');
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    renameFault.code = 'ENOSPC';
    renameFault.armed = true;
    await expect(atomicWriteFile(target, 'new')).rejects.toMatchObject({ code: 'ENOSPC' });
    expect(renameFault.calls).toBe(1);
    expect(await strayTempFiles(dir)).toEqual([]);
  });

  it('surfaces a permission failure at once off Windows instead of spending the ladder on it', async () => {
    // EPERM is the exact code the ladder waits out on Windows, and the one it must NOT wait out
    // here: `rename(2)` does not care that a reader has the file open, so this is the directory
    // refusing the write, and it will refuse it just as hard 255ms later. The delay is not free —
    // this writer is what a credential write and the metadata sweep commit through, both of them
    // holding the credential lock while they do it.
    pretendPlatform('linux');
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    renameFault.armed = true;
    await expect(atomicWriteFile(target, 'new')).rejects.toMatchObject({ code: 'EPERM' });
    expect(renameFault.calls).toBe(1);
    expect(await strayTempFiles(dir)).toEqual([]);
  });

  it('surfaces an access-denied rename at once even on Windows', async () => {
    // A sharing violation reaches us as EPERM/EBUSY. EACCES is the read-only/ACL refusal, which
    // no handle ever closes out of.
    pretendPlatform('win32');
    const dir = await sandbox();
    const target = join(dir, 'registry.json');
    renameFault.code = 'EACCES';
    renameFault.armed = true;
    await expect(atomicWriteFile(target, 'new')).rejects.toMatchObject({ code: 'EACCES' });
    expect(renameFault.calls).toBe(1);
    expect(await strayTempFiles(dir)).toEqual([]);
  });
});

describe('isTransientRenameError', () => {
  it('treats only the Windows sharing-violation codes as worth waiting out', () => {
    // The whole matrix at the boundary: the two codes that clear on their own, the neighbouring
    // permission code that does not, and the platforms where none of them do.
    expect(isTransientRenameError('EPERM', 'win32')).toBe(true);
    expect(isTransientRenameError('EBUSY', 'win32')).toBe(true);
    expect(isTransientRenameError('EACCES', 'win32')).toBe(false);
    expect(isTransientRenameError('ENOSPC', 'win32')).toBe(false);
    for (const platform of ['linux', 'darwin'] as const) {
      expect(isTransientRenameError('EPERM', platform)).toBe(false);
      expect(isTransientRenameError('EBUSY', platform)).toBe(false);
      expect(isTransientRenameError('EACCES', platform)).toBe(false);
    }
  });
});
