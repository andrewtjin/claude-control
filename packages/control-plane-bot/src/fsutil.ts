// Minimal filesystem helpers for optional on-disk state (bindings persistence).
//
// Mirrors switch-engine's atomic-write discipline (temp file in the same directory, fsync,
// then rename) without depending on that package — this package may only import
// '@claude-control/shared-protocol', so the helper is duplicated in miniature rather than
// shared. Rename is atomic on both Windows and POSIX, so a crash mid-write can never leave a
// half-written bindings file on disk.

import { mkdirSync } from 'node:fs';
import { open, readFile, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Ensure a directory exists (recursively); a no-op if it already does. */
export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

/** Atomically replace `target` with `data`. The temp file lives in the target's own
 *  directory so the final rename is a same-filesystem move, never a cross-device copy. */
export async function atomicWriteFile(target: string, data: string): Promise<void> {
  ensureDir(dirname(target));
  // A per-call unique temp name avoids collisions between concurrent writers.
  const tmp = join(dirname(target), `.tmp-${process.pid}-${randomUUID()}`);
  const handle = await open(tmp, 'w', 0o600);
  try {
    await handle.writeFile(Buffer.from(data, 'utf8'));
    await handle.sync(); // flush to disk before the rename makes it visible
  } finally {
    await handle.close();
  }
  await rename(tmp, target);
}

/** Read and JSON-parse a file, or return `undefined` if it does not exist. Other IO errors
 *  (permissions, etc.) propagate — a real failure should be loud, not treated as "absent". */
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
