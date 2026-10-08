// WAL checkpoints on a worker thread.
//
// SQLite's automatic checkpoint runs inside whichever commit pushes the WAL past its
// threshold (1000 pages, about 4 MB). In the daemon that is a main-thread commit, so the copy
// back into the database file and its fsyncs block the event loop: hooks and `/healthz` wait
// behind it (356ms and 589ms on a box under memory pressure). With `synchronous = NORMAL`
// checkpoints are the only fsyncs SQLite makes, so moving them moves all of that disk wait.
//
// The worker opens its own connection to the same file and runs a PASSIVE checkpoint every
// `intervalMs`. PASSIVE never waits for readers or writers, and a WAL writer does not wait for
// a checkpointer, so main-thread commits keep appending while the copy runs. The owner turns
// off its own connection's automatic checkpoint while this runs, and turns it back on if the
// worker fails (see `Store`), so a dead worker can never let the WAL grow without bound.
//
// The worker source is inline (`eval`) so the bundle needs no separate file, the same way the
// DPAPI worker is built.

import { Worker } from 'node:worker_threads';

/** Options for {@link startWalCheckpointer}. */
export interface WalCheckpointerOptions {
  /** The database file. Must already be in WAL mode (the store sets it on open). */
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
 * at its heaviest), so each checkpoint is small; an idle checkpoint only reads the WAL index.
 */
export const WAL_CHECKPOINT_INTERVAL_MS = 30_000;

/** The worker's whole program. Nothing in it catches: an open or a checkpoint that throws
 *  ends the worker with an 'error' event on the owner's side, and the owner then checkpoints
 *  on its own, which is what happened before this file existed. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.dbPath);
const checkpoint = db.prepare('PRAGMA wal_checkpoint(PASSIVE)');
const timer = setInterval(() => checkpoint.get(), workerData.intervalMs);
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
