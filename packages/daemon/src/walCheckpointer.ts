// WAL checkpoints on a worker thread.
//
// SQLite's automatic checkpoint runs inside whichever commit pushes the WAL past its
// threshold (1000 pages, about 4 MB). In the daemon that is a main-thread commit, so the copy
// back into the database file and its fsyncs block the event loop: hooks and `/healthz` wait
// behind it (356ms and 589ms on a box under memory pressure, 8.9s when ext4 was waiting on its
// journal). With `synchronous = NORMAL` the checkpoint cycle makes all of SQLite's fsyncs, so
// all of that disk wait has to leave the main thread, not most of it.
//
// The worker opens its own connection to the same file and, every `intervalMs`, runs a PASSIVE
// checkpoint. PASSIVE never waits for readers or writers, and a WAL writer does not wait for a
// checkpointer, so main-thread commits keep appending while the copy runs. A checkpoint that
// copies the whole log leaves one fsync behind: the next write restarts the log from the top
// and syncs its new header first. Under journal pressure that one small sync waits as long as a
// big one, so the worker makes that next write itself (one row in `wal_restart`) and takes the
// sync on its own thread. While it writes it holds the write lock, so the store's connection
// carries a busy timeout and waits out the overlap (the sync it would otherwise have made
// itself) instead of failing. If the main thread is mid-write the worker's write is skipped;
// that commit restarts the log as it always did, and the worker tries again next time. The worker does nothing at all while no other
// connection has committed since its last complete checkpoint, so an idle daemon writes nothing.
//
// The owner turns off its own connection's automatic checkpoint while this runs, and turns it
// back on if the worker dies or fails to start (see `Store`). That covers a worker that ends,
// not one that hangs: a checkpoint stuck in the kernel goes unnoticed, though a disk stall that
// long would stop the main thread's own commits too. A failed worker is not restarted;
// checkpoints stay on the main thread, as before this file, until the daemon restarts.
//
// The worker source is inline (`eval`) so the bundle needs no separate file, the same way the
// DPAPI worker is built.

import { Worker } from 'node:worker_threads';

/** Options for {@link startWalCheckpointer}. */
export interface WalCheckpointerOptions {
  /** The database file. Must already be in WAL mode and hold {@link WAL_RESTART_SCHEMA} (the
   *  store sets up both on open). */
  dbPath: string;
  /** Called once if the worker cannot open the database, a checkpoint throws, or the worker
   *  dies. No checkpoint runs after it; the caller must fall back to its own. */
  onFailure: (err: Error) => void;
  /** Checkpoint cadence. Default {@link WAL_CHECKPOINT_INTERVAL_MS}. */
  intervalMs?: number;
}

/** A running checkpointer. */
export interface WalCheckpointer {
  /** Stop checkpointing and close the worker's connection. Resolves once the worker has
   *  exited. Idempotent; never calls `onFailure`. */
  stop(): Promise<void>;
}

/**
 * How often the worker checkpoints. Short enough that the WAL stays far below the 4 MB
 * automatic threshold at any write rate the daemon has been measured at (about 1 MB a minute
 * at its heaviest), so each checkpoint is small.
 */
export const WAL_CHECKPOINT_INTERVAL_MS = 30_000;

/**
 * The WAL file's size after it resets, in bytes. With the automatic checkpoint on, the commit
 * that crossed 1000 pages checkpointed at once, so the file stopped near 4 MB. A checkpoint on
 * another thread can't promise that (a burst between two runs, or a commit landing during one,
 * lets the WAL keep growing), so whichever connection resets the WAL truncates it back to the
 * same size. SQLite applies this on the connection that resets, which is usually the worker
 * and sometimes the store's, so both set it.
 */
export const WAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

/** The one-row table the worker writes to restart the log. Created by the database's owner
 *  before the worker starts, so the worker never changes the schema under a live writer. */
export const WAL_RESTART_SCHEMA =
  'CREATE TABLE IF NOT EXISTS wal_restart (id INTEGER PRIMARY KEY CHECK (id = 1), restarts INTEGER NOT NULL)';

/** The worker's whole program. The only error it catches is the lock it can't get while the
 *  main thread writes: anything else ends the worker with an 'error' event on the owner's side,
 *  and the owner then checkpoints on its own, which is what happened before this file existed. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
// NORMAL: the restart write syncs only the new log header, not its commit too.
db.exec('PRAGMA synchronous = NORMAL; PRAGMA journal_size_limit = ' + workerData.walSizeLimitBytes);
const dataVersion = db.prepare('PRAGMA data_version');
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const restart = db.prepare(
  'INSERT INTO wal_restart (id, restarts) VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET restarts = restarts + 1',
);
const SQLITE_BUSY = 5;
// data_version as of the last checkpoint that copied the whole log. It changes only when
// another connection commits (never for this one's own restart write), so an unchanged value
// means there is nothing to copy and no restart to take.
let settledVersion;
function tick() {
  const version = dataVersion.get().data_version;
  if (version === settledVersion) return;
  const result = checkpoint.get();
  // busy: another checkpoint is running. checkpointed < log: a reader still needs the old
  // frames, so the log can't restart yet. Either way, try again next tick.
  if (result.busy !== 0 || result.checkpointed !== result.log) return;
  // 0: the log is already empty. -1: not in WAL mode, where a write would make a journal.
  if (result.log > 0) {
    try {
      restart.run();
    } catch (err) {
      if ((err.errcode & 0xff) !== SQLITE_BUSY) throw err;
      // Another connection holds the write lock. If it commits, that commit restarts the log;
      // if it doesn't, the next tick tries again.
      return;
    }
  }
  settledVersion = version;
}
const timer = setInterval(tick, workerData.intervalMs);
parentPort.on('message', (msg) => {
  if (msg !== 'stop') return;
  clearInterval(timer);
  db.close();
  parentPort.close();
});
`;

/**
 * Start checkpointing `dbPath` on a worker thread. The worker is unref'd: it never keeps the
 * process alive on its own.
 */
export function startWalCheckpointer(options: WalCheckpointerOptions): WalCheckpointer {
  const worker = new Worker(WORKER_SOURCE, {
    eval: true,
    workerData: {
      dbPath: options.dbPath,
      intervalMs: options.intervalMs ?? WAL_CHECKPOINT_INTERVAL_MS,
      walSizeLimitBytes: WAL_SIZE_LIMIT_BYTES,
    },
  });
  worker.unref();

  // Both flags make the outcome single-shot: a failure is reported once, and nothing is
  // reported after a deliberate stop (whose exit is expected).
  let stopped = false;
  let failed = false;
  const reportFailure = (err: Error): void => {
    if (stopped || failed) return;
    failed = true;
    options.onFailure(err);
  };
  worker.on('error', reportFailure);
  const exited = new Promise<void>((resolve) => {
    // Any exit not ordered by stop() means checkpoints stopped.
    worker.on('exit', (code) => {
      reportFailure(new Error(`WAL checkpoint worker exited with code ${code}`));
      resolve();
    });
  });

  return {
    stop() {
      if (!stopped) {
        stopped = true;
        // A worker that already exited ignores the message; `exited` has resolved then.
        worker.postMessage('stop');
      }
      return exited;
    },
  };
}
