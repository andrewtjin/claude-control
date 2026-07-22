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

/** Rename with a short bounded retry on EPERM/EBUSY. Windows can transiently reject a rename onto
 *  an existing file with one of these codes right after a prior rename to the same path settles —
 *  typically an AV scanner or the search indexer holds a fleeting handle on the file just replaced.
 *  This is a known Node-on-Windows quirk (the same reason write-file-atomic retries here); the file
 *  itself is never corrupted by it, the call just needs re-issuing. A genuine permissions problem
 *  keeps failing past the retry budget and still surfaces. Mirrors the daemon's sessionManager. */
async function renameWithRetry(tmp: string, target: string): Promise<void> {
  const maxAttempts = 8;
  for (let attempt = 1; ; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (attempt >= maxAttempts || (code !== 'EPERM' && code !== 'EBUSY')) throw err;
      await new Promise((resolve) => setTimeout(resolve, attempt * 15));
    }
  }
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
  await renameWithRetry(tmp, target);
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
