import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import { startWalCheckpointer, type WalCheckpointerOptions } from './walCheckpointer.js';

/** Poll until `check` holds, by real time: these tests wait on another thread. */
async function waitFor(check: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Bytes in the main database file. Pages committed to the WAL only reach it through a
 *  checkpoint, so growth here is a checkpoint observed without running one. */
function dbFileSize(path: string): number {
  return statSync(path).size;
}

/** A row big enough that a few hundred of them span more than SQLite's 1000-page automatic
 *  checkpoint threshold. */
const ROW = 'x'.repeat(8_000);

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cctl-wal-checkpoint-'));
  dbPath = join(dir, 'daemon.db');
});

afterEach(async () => {
  // Windows holds the file until the worker has closed its connection, which `Store.close()`
  // does not wait for. Retry across event-loop turns: a synchronous retry never lets the
  // worker's exit be processed.
  for (let attempt = 0; ; attempt++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
});

describe('startWalCheckpointer', () => {
  /** A WAL-mode database whose own connection never checkpoints, as the store sets it up. */
  function openWithoutAutoCheckpoint(): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 0;
      CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);
    `);
    return db;
  }

  it('copies the WAL into the database file from its own thread', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    for (let i = 0; i < 100; i++) insert.run(ROW);
    const before = dbFileSize(dbPath);
    const onFailure = vi.fn();
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 50, onFailure });
    try {
      await waitFor(() => dbFileSize(dbPath) > before + 100 * ROW.length);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await checkpointer.stop();
      db.close();
    }
  });

  it('keeps checkpointing as writes continue', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 50, onFailure: vi.fn() });
    try {
      for (let round = 1; round <= 3; round++) {
        for (let i = 0; i < 50; i++) insert.run(ROW);
        await waitFor(() => dbFileSize(dbPath) > round * 50 * ROW.length);
      }
    } finally {
      await checkpointer.stop();
      db.close();
    }
  });

  it('reports a database it cannot open, once', async () => {
    const onFailure = vi.fn();
    // A directory is not a database file.
    const checkpointer = startWalCheckpointer({ dbPath: dir, intervalMs: 50, onFailure });
    await waitFor(() => onFailure.mock.calls.length > 0);
    // The 'error' and the following 'exit' are one failure.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    // Stopping after a failure still settles.
    await checkpointer.stop();
  });

  it('stops without reporting a failure, and stop is idempotent', async () => {
    const db = openWithoutAutoCheckpoint();
    const onFailure = vi.fn();
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 50, onFailure });
    await new Promise((resolve) => setTimeout(resolve, 120));
    await checkpointer.stop();
    await checkpointer.stop();
    db.close();
    expect(onFailure).not.toHaveBeenCalled();
  });
});

describe('Store background checkpoints', () => {
  it('turns off main-thread checkpoints only when asked, and never for :memory:', () => {
    const plain = new Store(dbPath);
    expect(plain.autoCheckpointPages()).toBe(1000);
    plain.close();

    const memory = new Store(':memory:', { backgroundCheckpoints: { onFailure: vi.fn() } });
    expect(memory.autoCheckpointPages()).toBe(1000);
    memory.close();
  });

  it('no main-thread commit checkpoints, even past the automatic threshold', () => {
    // The worker is never started, so any growth of the database file came from a commit.
    const store = new Store(dbPath, {
      backgroundCheckpoints: {
        onFailure: vi.fn(),
        start: () => ({ stop: () => Promise.resolve() }),
      },
    });
    try {
      expect(store.autoCheckpointPages()).toBe(0);
      const before = dbFileSize(dbPath);
      // ~2,000 pages of WAL: twice the threshold at which a main-thread commit used to
      // checkpoint.
      for (let i = 0; i < 1_000; i++) {
        store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: i, source: 'live', json: ROW });
      }
      expect(dbFileSize(dbPath)).toBe(before);
    } finally {
      store.close();
    }
  });

  it('checkpoints the store from the worker', async () => {
    const onFailure = vi.fn();
    const store = new Store(dbPath, { backgroundCheckpoints: { onFailure, intervalMs: 50 } });
    try {
      const before = dbFileSize(dbPath);
      for (let i = 0; i < 100; i++) {
        store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: i, source: 'live', json: ROW });
      }
      await waitFor(() => dbFileSize(dbPath) > before + 100 * ROW.length);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      store.close();
    }
  });

  it('checkpoints on the main thread again when the worker fails, then says so', () => {
    let failWorker: ((err: Error) => void) | undefined;
    const onFailure = vi.fn();
    const store = new Store(dbPath, {
      backgroundCheckpoints: {
        onFailure,
        start: (options: WalCheckpointerOptions) => {
          failWorker = options.onFailure;
          return { stop: () => Promise.resolve() };
        },
      },
    });
    try {
      expect(store.autoCheckpointPages()).toBe(0);
      const err = new Error('worker died');
      failWorker?.(err);
      expect(store.autoCheckpointPages()).toBe(1000);
      expect(onFailure).toHaveBeenCalledWith(err);
    } finally {
      store.close();
    }
  });

  it('stops the worker on close, and a failure reported after close is harmless', () => {
    let failWorker: ((err: Error) => void) | undefined;
    const stop = vi.fn(() => Promise.resolve());
    const onFailure = vi.fn();
    const store = new Store(dbPath, {
      backgroundCheckpoints: {
        onFailure,
        start: (options: WalCheckpointerOptions) => {
          failWorker = options.onFailure;
          return { stop };
        },
      },
    });
    store.close();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(() => failWorker?.(new Error('late'))).not.toThrow();
  });
});
