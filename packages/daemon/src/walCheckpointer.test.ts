import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from './store.js';
import {
  startWalCheckpointer,
  WAL_RESTART_SCHEMA,
  type WalCheckpointerOptions,
} from './walCheckpointer.js';

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

/** The WAL header's two salts. SQLite changes them every time the log restarts from the top,
 *  so a change with no write of ours in between means another connection restarted it. */
function walSalts(path: string): string {
  return readFileSync(`${path}-wal`).subarray(16, 24).toString('hex');
}

/** How many times the worker has restarted the log, read from its own row. */
function restarts(db: DatabaseSync): number {
  const row = db.prepare('SELECT restarts FROM wal_restart').get();
  return row === undefined ? 0 : Number(row['restarts']);
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
  /** A WAL-mode database whose own connection never checkpoints and waits out the worker's
   *  write lock, as the store sets it up. */
  function openWithoutAutoCheckpoint(): DatabaseSync {
    const db = new DatabaseSync(dbPath);
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA wal_autocheckpoint = 0;
      PRAGMA busy_timeout = 10000;
      CREATE TABLE t (id INTEGER PRIMARY KEY, body TEXT);
    `);
    db.exec(WAL_RESTART_SCHEMA);
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

  it('restarts the log itself after a complete checkpoint, so the next commit has no sync to make', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    for (let i = 0; i < 50; i++) insert.run(ROW);
    const saltsBefore = walSalts(dbPath);
    const onFailure = vi.fn();
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 50, onFailure });
    try {
      await waitFor(() => restarts(db) === 1);
      // Nothing here wrote since the checkpoint, so the new header is the worker's.
      expect(walSalts(dbPath)).not.toBe(saltsBefore);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await checkpointer.stop();
      db.close();
    }
  });

  it('does nothing while no other connection commits, then resumes when one does', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    insert.run(ROW);
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 20, onFailure: vi.fn() });
    try {
      await waitFor(() => restarts(db) === 1);
      const walAfterRestart = readFileSync(`${dbPath}-wal`);
      // Ten ticks with no commit but the worker's own: no checkpoint of that write, no second
      // restart, not a byte of the WAL rewritten.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(restarts(db)).toBe(1);
      expect(readFileSync(`${dbPath}-wal`).equals(walAfterRestart)).toBe(true);
      insert.run(ROW);
      await waitFor(() => restarts(db) === 2);
    } finally {
      await checkpointer.stop();
      db.close();
    }
  });

  it('skips the restart while the main thread holds the write lock, and keeps going', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    const onFailure = vi.fn();
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 20, onFailure });
    try {
      insert.run(ROW);
      await waitFor(() => restarts(db) === 1);
      // A commit the worker hasn't seen, then the lock held past several of its ticks: each
      // one copies the log and then finds the lock taken.
      insert.run(ROW);
      db.exec('BEGIN IMMEDIATE');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(restarts(db)).toBe(1);
      db.exec('COMMIT');
      expect(onFailure).not.toHaveBeenCalled();
      await waitFor(() => restarts(db) === 2);
      expect(onFailure).not.toHaveBeenCalled();
    } finally {
      await checkpointer.stop();
      db.close();
    }
  });

  it('truncates a grown WAL back to 4 MB with no write from the main thread', async () => {
    const db = openWithoutAutoCheckpoint();
    const insert = db.prepare('INSERT INTO t (body) VALUES (?)');
    for (let i = 0; i < 1_500; i++) insert.run(ROW);
    expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(8 * 1024 * 1024);
    const checkpointer = startWalCheckpointer({ dbPath, intervalMs: 50, onFailure: vi.fn() });
    try {
      await waitFor(() => statSync(`${dbPath}-wal`).size <= 4 * 1024 * 1024);
    } finally {
      await checkpointer.stop();
      db.close();
    }
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

  it('falls back when the worker cannot even be started', () => {
    const onFailure = vi.fn();
    const store = new Store(dbPath, {
      backgroundCheckpoints: {
        onFailure,
        start: () => {
          throw new Error('no threads');
        },
      },
    });
    try {
      expect(store.autoCheckpointPages()).toBe(1000);
      expect(onFailure).toHaveBeenCalledTimes(1);
      expect((onFailure.mock.calls[0]?.[0] as Error).message).toBe('no threads');
    } finally {
      store.close();
    }
  });

  it('a second failure report is ignored', () => {
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
      failWorker?.(new Error('first'));
      failWorker?.(new Error('second'));
      expect(onFailure).toHaveBeenCalledTimes(1);
    } finally {
      store.close();
    }
  });

  it('truncates a grown WAL back to 4 MB when it next resets', () => {
    // A burst between two worker runs can grow the WAL past the 4 MB the automatic checkpoint
    // used to hold it to; the file must not stay that size.
    const store = new Store(dbPath, {
      backgroundCheckpoints: {
        onFailure: vi.fn(),
        start: () => ({ stop: () => Promise.resolve() }),
      },
    });
    const checkpointer = new DatabaseSync(dbPath);
    try {
      for (let i = 0; i < 1_500; i++) {
        store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: i, source: 'live', json: ROW });
      }
      expect(statSync(`${dbPath}-wal`).size).toBeGreaterThan(8 * 1024 * 1024);
      // What the worker does, from another connection.
      checkpointer.prepare('PRAGMA wal_checkpoint(PASSIVE)').get();
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 0, source: 'live', json: '{}' });
      expect(statSync(`${dbPath}-wal`).size).toBeLessThanOrEqual(4 * 1024 * 1024);
    } finally {
      checkpointer.close();
      store.close();
    }
  });

  it("waits out another connection's write lock instead of failing the write", async () => {
    const store = new Store(dbPath);
    // Another thread takes the write lock and holds it for 300 ms, as the checkpointer does
    // across its log header sync. This thread is blocked while it waits, so the lock has to
    // be held and released from somewhere else.
    const holder = new Worker(
      `
      const { parentPort, workerData } = require('node:worker_threads');
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(workerData);
      db.exec('BEGIN IMMEDIATE');
      parentPort.postMessage('locked');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      db.exec('COMMIT');
      db.close();
      `,
      { eval: true, workerData: dbPath },
    );
    try {
      await new Promise((resolve) => holder.once('message', resolve));
      const startedAt = performance.now();
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 0, source: 'live', json: '{}' });
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(150);
    } finally {
      await new Promise((resolve) => holder.once('exit', resolve));
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
