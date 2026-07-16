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

/** Ensure a directory exists (recursively). No-op if already present. Sync so that callers
 *  in sync contexts (audit append, lock acquisition) can use it too. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/**
 * Atomically replace `target` with `data`. The temp file is created in the target's own
 * directory so the final rename is a same-filesystem move (atomic), never a cross-device
 * copy. The handle is fsync'd before the rename so the durable state is the new content.
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
  await rename(tmp, target);
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
