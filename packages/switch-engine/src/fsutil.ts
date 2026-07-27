// Small filesystem helpers shared across the engine.
//
// Every credential write goes through `atomicWriteFile`: write to a temp file in the same
// directory, fsync, then rename over the target. Rename is atomic on Windows and POSIX, so
// a crash mid-write can never leave a half-written credentials file — a reader sees either
// the whole old file or the whole new one. The write is fsync'd before the rename so the
// durable on-disk state is always the new bytes, never a truncated temp.

import { mkdirSync } from 'node:fs';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Whether a failed rename means "someone else has this file open right now" — the one condition
 * that clears on its own and is therefore worth waiting out. Everything else is a real fault and
 * must surface at once, at the speed of the syscall that produced it.
 *
 * The condition is a Windows one: Windows refuses to replace a file while any handle to it is
 * open — including a reader doing nothing but a single `readFile` — and reports that refusal as
 * EPERM or EBUSY (the same pair the daemon's session registry and the bot's bindings file wait
 * out, for the same reason). POSIX has no such rule: `rename(2)` is unaffected by open handles,
 * so the very same codes there describe a permission or mount fault on the directory, and those
 * are permanent. Retrying them would spend the whole ladder on a failure whose answer is already
 * final — on the switch path, in front of a credential write, holding the credential lock.
 *
 * `platform` is a parameter rather than a read of `process.platform` so both branches are
 * reachable from a test on either kind of machine.
 */
export function isTransientRenameError(code: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' && (code === 'EPERM' || code === 'EBUSY');
}

/**
 * Waits, in ms, before each rename retry — doubling, ~255ms of patience in total.
 *
 * Sized against what it is waiting for: a concurrent read of the same small file, which holds its
 * handle for microseconds. A budget this short outlasts any number of such readers while staying
 * far below the point where a caller would notice; it is deliberately NOT long enough to wait out
 * a process that holds the file open indefinitely, because that is not a race and no amount of
 * waiting resolves it.
 */
const RENAME_RETRY_DELAYS_MS = [1, 2, 4, 8, 16, 32, 64, 128];

/** Ensure a directory exists (recursively). No-op if already present. Sync so that callers
 *  in sync contexts (audit append, lock acquisition) can use it too. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Rename `tmp` over `target`, waiting out a losing race with a concurrent reader.
 *
 * A rename that fails because another process momentarily has the target open has not been
 * rejected — it has been asked to come back. Surfacing that as an error makes every caller carry
 * a race it cannot do anything about, and makes correctness depend on nothing ever reading the
 * file at the wrong instant. Retrying resolves it where waiting can; where it cannot — every
 * failure `isTransientRenameError` does not claim, including all of them off Windows — the
 * original error reaches the caller unchanged and immediately.
 */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? '';
      const exhausted = attempt >= RENAME_RETRY_DELAYS_MS.length;
      if (exhausted || !isTransientRenameError(code, process.platform)) throw err;
      await delay(RENAME_RETRY_DELAYS_MS[attempt] ?? 0);
    }
  }
}

/**
 * Atomically replace `target` with `data`. The temp file is created in the target's own
 * directory so the final rename is a same-filesystem move (atomic), never a cross-device
 * copy. The handle is fsync'd before the rename so the durable state is the new content.
 *
 * Either the replace happens or nothing is left behind: a rename that ultimately fails takes its
 * temp file with it. The temp lives in the target's own directory — for credentials that is the
 * vault — so leaking one per failed write turns a directory the user is meant to be able to read
 * into a growing pile of partial copies of that same file.
 */
export async function atomicWriteFile(
  target: string,
  data: string | Buffer,
  mode = 0o600,
): Promise<void> {
  ensureDir(dirname(target));
  // A per-call temp name avoids collisions between concurrent writers to different targets.
  const tmp = join(dirname(target), `.tmp-${process.pid}-${Date.now()}-${randomSuffix()}`);
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const handle = await open(tmp, 'w', mode);
  try {
    await handle.writeFile(buf);
    await handle.sync(); // flush to disk before the rename
  } finally {
    await handle.close();
  }
  try {
    await renameWithRetry(tmp, target);
  } catch (err) {
    // The rename is the only step that can fail with the temp still on disk. A cleanup that
    // itself fails is swallowed on purpose: the caller needs to know why the WRITE failed, and
    // replacing that reason with a secondary one would hide it.
    await rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/** Read and JSON-parse a file, or return `undefined` if it does not exist. Other IO errors
 *  propagate — a permissions failure should be loud, not silently treated as "absent". */
export async function readJsonIfExists<T>(path: string): Promise<T | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return JSON.parse(raw) as T;
}

/** Best-effort delete; a missing file is success. */
export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

// Non-cryptographic suffix; only needs to disambiguate concurrent temp files, not be secret.
let counter = 0;
function randomSuffix(): string {
  counter = (counter + 1) % Number.MAX_SAFE_INTEGER;
  return counter.toString(36);
}
