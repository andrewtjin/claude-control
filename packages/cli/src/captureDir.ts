// Lifecycle of the throwaway `CLAUDE_CONFIG_DIR` that `accounts add --fresh` and
// `accounts relogin` run an interactive `claude` inside.
//
// This is its own module, rather than three lines inlined in each command, because deleting
// that directory is a security obligation (it holds a real `.credentials.json`) and two
// separate hazards were defeating it:
//
//  1. **`process.exit` does not unwind `finally`.** `fail()` exits the process, so a cleanup
//     sitting in a `finally` around a body that can `fail()` never runs at all. Every "the
//     login never completed" and "wrong account" path therefore leaked its dir permanently.
//     `withCaptureDir` fixes that by shape: the body RETURNS its failure message and the
//     caller fails *after* cleanup has already happened.
//  2. **Windows refuses to unlink a file another process still has open.** `claude` (and any
//     grandchild it spawned) can hold handles inside the config dir for seconds after
//     `spawnSync` returns, so the delete races the window we just closed and fails with
//     `EPERM, Permission denied`. Measured on Node 24: the *sync* `rmSync` ignores
//     `maxRetries` entirely (it gives up in under a millisecond), which is why the delete is
//     async — and the promises `rm` retries at every level of the tree, so its delays multiply
//     with depth (30s measured on a three-level capture dir with one handle held). Neither is
//     usable as-is, so this module retries the whole tree itself against a fixed wall clock,
//     and a delete that still loses is a warning — never a failure of the operation the user
//     actually asked for, which by then has already succeeded.

import { mkdirSync } from 'node:fs';
import { readdir, rm, stat } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

/** Which flow a transient dir belongs to. Doubles as its name prefix, which is what makes a
 *  leftover identifiable to {@link sweepStaleCaptureDirs} later. */
export type CapturePrefix = 'capture' | 'relogin';

const CAPTURE_PREFIXES: readonly CapturePrefix[] = ['capture', 'relogin'];

/** The two files in a capture dir that carry secrets or identity. Deleted first and
 *  individually so that, when the recursive delete loses the handle race on some unrelated
 *  file (a transcript, a statsig cache), the credentials are gone regardless. */
const TOKEN_FILES = ['.credentials.json', '.claude.json'] as const;

/** How long to keep re-attempting a delete that is racing a just-exited `claude`. Long enough
 *  to outlast handle release (measured at ~2.9s on this class of race), short enough that a
 *  command which has already printed its success does not appear to hang. Node's own
 *  `maxRetries` is deliberately left at 0: it retries per tree level, so its total wait
 *  compounds with depth and cannot be bounded from the call site. */
const DELETE_BUDGET_MS = 8_000;

/** Backoff between whole-tree attempts, capped so late attempts stay responsive. Each attempt
 *  also makes partial progress — everything not locked is already gone — so a later pass has
 *  strictly less to do. */
const RETRY_STEP_MS = 250;
const RETRY_CAP_MS = 1_000;

/** How long a capture dir must sit untouched before a later run treats it as abandoned and
 *  deletes it. Generous on purpose: the sweep runs while ANOTHER capture may be mid-flight in
 *  a second terminal, and deleting a live one would break that login. An interactive login
 *  that writes nothing into its config dir for an hour is not a real scenario; a leftover from
 *  a lost handle race is. */
const STALE_AFTER_MS = 60 * 60 * 1000;

/** Injection seam for the failure paths, which cannot be provoked portably in a test (they
 *  need a Windows file handle held by a live process). Production passes nothing. */
export interface CaptureDirDeps {
  /** Defaults to `fs/promises.rm`. */
  remove?: (path: string, options: { recursive: boolean; force: boolean }) => Promise<void>;
  /** Defaults to a line on stderr. */
  warn?: (message: string) => void;
  /** Retry budget for one delete. Defaults to {@link DELETE_BUDGET_MS}; 0 means a single
   *  attempt (what the sweep uses, and how tests reach the give-up path without sleeping). */
  budgetMs?: number;
}

function resolveDeps(deps: CaptureDirDeps): Required<CaptureDirDeps> {
  return {
    remove: deps.remove ?? rm,
    warn: deps.warn ?? ((message) => process.stderr.write(`warning: ${message}\n`)),
    budgetMs: deps.budgetMs ?? DELETE_BUDGET_MS,
  };
}

/**
 * Delete a transient capture dir. Never throws and never changes the exit code: by the time
 * this runs the capture itself has already succeeded or failed on its own terms, and a
 * leftover directory must not turn a successful `relogin` into an `error:` line.
 *
 * Returns whether the directory is actually gone, so callers (and tests) can tell the
 * difference between a clean delete and one the user was warned about.
 */
export async function discardCaptureDir(dir: string, deps: CaptureDirDeps = {}): Promise<boolean> {
  const { remove, warn, budgetMs } = resolveDeps(deps);
  // Credentials first — see TOKEN_FILES. `force` makes an absent file a no-op, which is the
  // common case (a login that never completed writes neither).
  for (const file of TOKEN_FILES) {
    try {
      await remove(join(dir, file), { recursive: false, force: true });
    } catch {
      // Not fatal and not worth its own line: the tree loop below retries these paths too.
    }
  }

  const deadline = Date.now() + budgetMs;
  let lastError: unknown;
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      lastError = err;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(RETRY_STEP_MS * 2 ** attempt, RETRY_CAP_MS));
    }
  }

  warn(
    'could not delete the throwaway login directory — something still has a file open in it:\n' +
      `  ${dir}\n` +
      '  Your account is fine; this is leftover state. cctl deletes it on the next ' +
      '`accounts add --fresh` or `accounts relogin`, or you can remove it yourself.',
  );
  // The underlying errno is for postmortems, not for the user's normal path.
  if (process.env.CCTL_LOG_LEVEL === 'debug') {
    warn(`  cause: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  }
  return false;
}

/**
 * Delete capture dirs abandoned by earlier runs — the ones a lost handle race (or any cctl
 * older than this fix) left behind. Best-effort by design: a sweep failure must never block
 * the capture the user is actually running, so every error here is swallowed.
 */
export async function sweepStaleCaptureDirs(
  parent: string,
  now: number = Date.now(),
  deps: CaptureDirDeps = {},
): Promise<void> {
  let entries;
  try {
    entries = await readdir(parent, { withFileTypes: true });
  } catch {
    return; // No data dir yet — nothing to sweep.
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!CAPTURE_PREFIXES.some((prefix) => entry.name.startsWith(`${prefix}-`))) continue;
    const dir = join(parent, entry.name);
    try {
      if (now - (await lastTouchedMs(dir)) < STALE_AFTER_MS) continue;
    } catch {
      continue; // Vanished or unreadable — either way, not ours to force.
    }
    // One attempt each, and silently: these are old leftovers the user was already warned
    // about once, so they must neither nag nor make the command they interrupted wait —
    // whatever still holds a handle gets another chance on the next run.
    await discardCaptureDir(dir, { ...deps, warn: () => {}, budgetMs: deps.budgetMs ?? 0 });
  }
}

/** Newest mtime among a directory and its immediate children. The root's own mtime is not
 *  enough: a live `claude` writes into `projects/` and `statsig/` for long stretches without
 *  touching the root, which would make an in-use dir look abandoned. */
async function lastTouchedMs(dir: string): Promise<number> {
  let newest = (await stat(dir)).mtimeMs;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    try {
      const child = await stat(join(dir, entry.name));
      if (child.mtimeMs > newest) newest = child.mtimeMs;
    } catch {
      // Raced away mid-scan; the entries that remain still bound the age.
    }
  }
  return newest;
}

/**
 * Run a capture flow inside a fresh throwaway config dir, and delete that dir however the
 * flow ends.
 *
 * `body` returns an error message instead of calling `fail()`, and this function returns it
 * to the caller to fail on. That indirection is the whole point: `fail()` is `process.exit`,
 * which skips `finally`, so a body that fails inline would walk out of the process leaving
 * real credentials on disk. Anything the body *throws* propagates normally (cleanup still
 * runs) and surfaces as the CLI's usual `error:` line.
 */
export async function withCaptureDir(
  parent: string,
  prefix: CapturePrefix,
  body: (dir: string) => Promise<string | undefined>,
  deps: CaptureDirDeps = {},
): Promise<string | undefined> {
  // Cheap, and the only moment we know a capture dir is in play — so it is also the natural
  // moment to clear out ones that outlived their run.
  await sweepStaleCaptureDirs(parent, Date.now(), deps);
  const dir = join(parent, `${prefix}-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  try {
    return await body(dir);
  } finally {
    await discardCaptureDir(dir, deps);
  }
}
