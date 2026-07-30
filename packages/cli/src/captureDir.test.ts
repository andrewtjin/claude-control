import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discardCaptureDir, sweepStaleCaptureDirs, withCaptureDir } from './captureDir.js';

let dirs: string[] = [];
async function sandbox(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'cctl-capture-dir-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** Backdate a path far enough that the sweep must treat it as abandoned (threshold: 1h). */
async function ageBy(path: string, ms: number): Promise<void> {
  const when = new Date(Date.now() - ms);
  await utimes(path, when, when);
}
const TWO_HOURS = 2 * 60 * 60 * 1000;

describe('withCaptureDir', () => {
  it('hands the body a fresh prefixed dir and deletes it on success', async () => {
    const parent = await sandbox();
    let seen = '';
    const failure = await withCaptureDir(parent, 'relogin', async (dir) => {
      seen = dir;
      await writeFile(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
      return undefined;
    });

    expect(failure).toBeUndefined();
    expect(seen.startsWith(join(parent, 'relogin-'))).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });

  // The regression this guards: failing inline used to mean calling fail() — process.exit —
  // from inside the try, and process.exit does not unwind `finally`, so every failed capture
  // left its token-bearing dir on disk forever.
  it('still deletes the dir when the body reports a failure', async () => {
    const parent = await sandbox();
    const failure = await withCaptureDir(parent, 'capture', async (dir) => {
      await writeFile(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
      return 'no credentials found; did the login complete?';
    });

    expect(failure).toBe('no credentials found; did the login complete?');
    expect(await readdir(parent)).toEqual([]);
  });

  it('still deletes the dir when the body throws, and propagates the error', async () => {
    const parent = await sandbox();
    await expect(
      withCaptureDir(parent, 'capture', async (dir) => {
        await writeFile(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
        throw new Error('vault write blew up');
      }),
    ).rejects.toThrow('vault write blew up');

    expect(await readdir(parent)).toEqual([]);
  });

  it('sweeps a leftover from an earlier run before starting a new capture', async () => {
    const parent = await sandbox();
    const leftover = join(parent, 'relogin-11111111-1111-1111-1111-111111111111');
    await mkdir(leftover);
    await writeFile(join(leftover, '.credentials.json'), '{"claudeAiOauth":{}}');
    await ageBy(join(leftover, '.credentials.json'), TWO_HOURS);
    await ageBy(leftover, TWO_HOURS);

    await withCaptureDir(parent, 'capture', () => Promise.resolve(undefined));

    expect(await readdir(parent)).toEqual([]);
  });
});

describe('discardCaptureDir', () => {
  it('deletes the whole tree, transcripts and all', async () => {
    const parent = await sandbox();
    const dir = join(parent, 'capture-x');
    await mkdir(join(dir, 'projects', 'some-project'), { recursive: true });
    await writeFile(join(dir, '.credentials.json'), '{"claudeAiOauth":{}}');
    await writeFile(join(dir, 'projects', 'some-project', 'a.jsonl'), '{}');

    expect(await discardCaptureDir(dir)).toBe(true);
    expect(await readdir(parent)).toEqual([]);
  });

  // Ordering is the safety property: when the recursive delete loses a Windows handle race on
  // some unrelated file, the credentials must already be gone.
  it('deletes the credential files before the tree', async () => {
    const dir = join('nowhere', 'capture-x');
    const order: string[] = [];
    const removed = await discardCaptureDir(dir, {
      remove: (path) => {
        order.push(path);
        return Promise.resolve();
      },
    });

    expect(removed).toBe(true);
    expect(order).toEqual([join(dir, '.credentials.json'), join(dir, '.claude.json'), dir]);
  });

  // The real race: `claude` holds a handle for a beat after its window closes, and the first
  // attempt loses. Retrying the whole tree is what turns that into a clean delete.
  it('retries a losing delete until it wins', async () => {
    const dir = join('nowhere', 'capture-x');
    let treeAttempts = 0;
    const removed = await discardCaptureDir(dir, {
      remove: (_path, options) => {
        if (!options.recursive) return Promise.resolve(); // the per-file credential deletes
        treeAttempts += 1;
        return treeAttempts < 3
          ? Promise.reject(Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' }))
          : Promise.resolve();
      },
    });

    expect(removed).toBe(true);
    expect(treeAttempts).toBe(3);
  });

  // A dir we cannot delete is a warning, never a failure: the relogin it belongs to has
  // already succeeded, and exiting non-zero would report that success as an error.
  it('warns and reports failure instead of throwing when the delete keeps losing', async () => {
    const dir = join('nowhere', 'relogin-x');
    const warnings: string[] = [];
    const removed = await discardCaptureDir(dir, {
      remove: () =>
        Promise.reject(Object.assign(new Error('EPERM, Permission denied'), { code: 'EPERM' })),
      warn: (message) => warnings.push(message),
      budgetMs: 0, // spend the whole retry budget up front rather than sleeping through it
    });

    expect(removed).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(dir);
    expect(warnings[0]).toContain('could not delete');
  });
});

describe('sweepStaleCaptureDirs', () => {
  it('removes abandoned capture dirs and leaves everything else alone', async () => {
    const parent = await sandbox();
    const stale = join(parent, 'capture-stale');
    const fresh = join(parent, 'relogin-fresh');
    const vault = join(parent, 'vault');
    await mkdir(stale);
    await mkdir(fresh);
    await mkdir(vault);
    await writeFile(join(vault, 'registry.json'), '{}');
    await ageBy(stale, TWO_HOURS);
    await ageBy(vault, TWO_HOURS); // old, but not ours — the prefix is what makes it ours

    await sweepStaleCaptureDirs(parent);

    expect((await readdir(parent)).sort()).toEqual(['relogin-fresh', 'vault']);
  });

  it('keeps a dir whose CHILDREN are still being written', async () => {
    const parent = await sandbox();
    const live = join(parent, 'capture-live');
    await mkdir(join(live, 'projects'), { recursive: true });
    // A live `claude` writes into subdirectories for long stretches without touching the root,
    // so root mtime alone would misread an in-flight login as abandoned.
    await ageBy(live, TWO_HOURS);

    await sweepStaleCaptureDirs(parent);

    expect(await readdir(parent)).toEqual(['capture-live']);
    expect((await stat(live)).isDirectory()).toBe(true);
  });

  it('is a no-op on a data dir that does not exist yet', async () => {
    await expect(sweepStaleCaptureDirs(join(tmpdir(), 'cctl-definitely-absent-dir'))).resolves.toBe(
      undefined,
    );
  });
});
