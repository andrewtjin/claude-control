// Per-launch relaxation tokens for the enforcement guard.
//
// The guard (bindGuard.ts) relaxes a folder binding in exactly two places: --override lets a session
// work in a folder bound to a DIFFERENT account (case A), and --account lets a session on a reserved
// account's slot work outside that account's folders (case B). Both relaxations used to be requested
// with a plain env var set to "1" (CCTL_BIND_OVERRIDE / CCTL_LAUNCH_EXPLICIT). A plain "1" cannot be
// told apart from an inherited or persisted value: a value exported once in a shell, set with a
// persistent user-environment edit, or carried by an IDE's integrated terminal would relax the
// binding for every session that inherited it — defeating enforcement without the launcher ever
// being involved.
//
// A token closes that. When the launcher relaxes a binding it mints an unguessable value, records it
// on disk (a file named by the token, holding the slot the launch runs in), and sets the env var to
// that value instead of "1". The guard honors the relaxation only when the env var names a token
// file that exists AND records the same slot the session is actually running on. An inherited "1"
// (or any value with no backing record) is not honored, so the binding still applies and the guard
// reports it visibly rather than silently letting the session through.
//
// This defends against accidental bypass — the guard's stated scope is preventing accidents, not a
// same-user actor who can already read this directory — which is exactly the leak class above. The
// record is non-secret; the token value (which is both the file name and the env var) is the only
// secret, and it only ever grants what the launcher already intended for that one launch.

import { randomBytes } from 'node:crypto';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

/** Directory (beside the snapshot the guard reads) that holds the per-launch relaxation records.
 *  Derived from the snapshot path alone so the guard — which has only the snapshot path baked in —
 *  and the launcher always agree on where the records live without sharing any other state. */
export const BIND_TOKEN_DIR_NAME = 'bind-guard-tokens';

/** The tokens directory for a given snapshot path. */
export function bindTokensDir(snapshotPath: string): string {
  return join(dirname(snapshotPath), BIND_TOKEN_DIR_NAME);
}

/** Which relaxation a token grants. */
export type BindTokenKind = 'explicit' | 'override';

/** The on-disk relaxation record. `profileKey` is the folderKey of the launch's slot config dir
 *  (empty string for the global slot), so the guard can confirm the token was minted for the SAME
 *  slot the session is running on and was not carried into a different one. `launcherPid` is the pid
 *  of the `cctl claude` process that minted it: the guard honors the token only while that process
 *  is alive, so a relaxation lasts exactly the lifetime of the launch that requested it and a hard
 *  kill of the launcher ends it at once rather than leaving a standing bypass. */
export interface BindTokenRecord {
  v: 1;
  kind: BindTokenKind;
  profileKey: string;
  launcherPid: number;
  createdAtMs: number;
}

/** Backstop age for a record that carries NO live launcher pid to reason about (a legacy record, or
 *  one whose launcher pid is not a number). The primary lifetime bound is launcher-pid liveness
 *  (see {@link isLauncherAlive}); a record whose launcher is alive is never pruned by age, so a long
 *  interactive session keeps its relaxation. This only reaps orphaned, pid-less leftovers, and is
 *  kept short so no stale record can linger — a hard kill of the launcher is caught immediately by
 *  the liveness check, not by this timer. */
export const BIND_TOKEN_MAX_AGE_MS = 60 * 60 * 1000;

/** Grace window before an UNPARSEABLE token file is reaped. A mint writes atomically (temp+rename),
 *  so a partial file should never be observed; this window is a safety margin so a concurrent peer's
 *  file that is momentarily unreadable (a Windows sharing error, say) is not destroyed by another
 *  launch's cleanup. Reaped only once it is both unparseable AND older than this. */
export const BIND_TOKEN_UNPARSEABLE_GRACE_MS = 60 * 1000;

/** Whether the process that minted a token is still running. The guard honors a relaxation only while
 *  its launcher lives, so a session that merely inherited the env value after the launch died (a hard
 *  kill, an orphaned child) is not relaxed. `kill(pid, 0)` sends no signal; it throws ESRCH when the
 *  process is gone and EPERM when it exists but is not signalable by this user (still alive). */
export function isLauncherAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A minted token is 16 random bytes as lower-case hex; the guard rejects anything else outright,
 *  which is what turns a stray "1"/"off"/"true" into an immediate non-match. Kept here so the mint
 *  and the guard's embedded check share one definition of a well-formed token. */
export const BIND_TOKEN_PATTERN = /^[0-9a-f]{32}$/;

/** File name for a token value (already validated hex, so it is safe as a single path segment). */
function tokenFileName(token: string): string {
  return `${token}.json`;
}

export interface MintBindTokenOptions {
  tokensDir: string;
  kind: BindTokenKind;
  /** folderKey of the launch's slot config dir; '' for the global slot. */
  profileKey: string;
  /** pid of the launching process; defaults to this process. The guard honors the token only while
   *  this pid is alive. Injectable for tests. */
  launcherPid?: number;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable token source, for tests. Must return 32 lower-case hex chars. */
  randomHex?: () => string;
}

/** Mint a relaxation token: write its record and return the token value the launcher puts in the env
 *  var. Best-effort prunes stale records first so a dead launcher's leftovers do not accumulate. The
 *  record is written atomically (temp + rename) so a concurrent launch's cleanup can never observe a
 *  half-written file. */
export function mintBindToken(opts: MintBindTokenOptions): string {
  const now = opts.now ?? Date.now;
  const token = (opts.randomHex ?? (() => randomBytes(16).toString('hex')))();
  cleanupBindTokens({ tokensDir: opts.tokensDir, now });
  mkdirSync(opts.tokensDir, { recursive: true });
  const record: BindTokenRecord = {
    v: 1,
    kind: opts.kind,
    profileKey: opts.profileKey,
    launcherPid: opts.launcherPid ?? process.pid,
    createdAtMs: now(),
  };
  const finalPath = join(opts.tokensDir, tokenFileName(token));
  // Temp name uses the token (already validated hex) so concurrent mints never collide on it.
  const tmpPath = `${finalPath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(record), 'utf8');
  renameSync(tmpPath, finalPath);
  return token;
}

/** Remove the record for one token — called when the launched session exits, so a token is valid
 *  only for the lifetime of the launch that minted it. Best-effort: a leftover is pruned by age on
 *  the next mint. */
export function removeBindToken(tokensDir: string, token: string): void {
  if (!BIND_TOKEN_PATTERN.test(token)) return;
  try {
    rmSync(join(tokensDir, tokenFileName(token)), { force: true });
  } catch {
    // Best-effort: age-based cleanup is the backstop.
  }
}

export interface CleanupBindTokensOptions {
  tokensDir: string;
  maxAgeMs?: number;
  unparseableGraceMs?: number;
  now?: () => number;
  /** Injectable liveness probe, for tests. Defaults to {@link isLauncherAlive}. */
  isAlive?: (pid: number) => boolean;
}

/**
 * Prune records whose launch is no longer running. A record whose `launcherPid` is dead is reaped at
 * once (so a hard kill of `cctl claude` leaves no standing relaxation); a record whose launcher is
 * alive is kept regardless of age, so a long interactive session never loses its own token. A record
 * with no usable pid is reaped only past {@link BIND_TOKEN_MAX_AGE_MS}. An UNPARSEABLE file is reaped
 * only once it is also older than {@link BIND_TOKEN_UNPARSEABLE_GRACE_MS}, so a concurrent peer's
 * momentarily unreadable file is not destroyed on a read/parse error alone. Best-effort and silent —
 * a failure here must never break a launch.
 */
export function cleanupBindTokens(opts: CleanupBindTokensOptions): void {
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? BIND_TOKEN_MAX_AGE_MS;
  const graceMs = opts.unparseableGraceMs ?? BIND_TOKEN_UNPARSEABLE_GRACE_MS;
  const isAlive = opts.isAlive ?? isLauncherAlive;
  let entries: string[];
  try {
    entries = readdirSync(opts.tokensDir);
  } catch {
    return; // No dir yet, or unreadable: nothing to prune.
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(opts.tokensDir, name);
    let raw: string;
    try {
      raw = readFileSync(full, 'utf8');
    } catch {
      continue; // A transient read error is not evidence the file should die; leave it.
    }
    let parsed: Partial<BindTokenRecord> | undefined;
    try {
      parsed = JSON.parse(raw) as Partial<BindTokenRecord>;
    } catch {
      parsed = undefined;
    }
    let stale: boolean;
    if (parsed === undefined || parsed.v !== 1) {
      // Unparseable / unknown shape: reap only past the grace window (it may be a peer's in-flight
      // or momentarily unreadable file), judged by the file's own mtime, never purely on parse error.
      stale = fileAgeMs(full, now) > graceMs;
    } else if (typeof parsed.launcherPid === 'number') {
      // The real lifetime bound: reap once the launch that minted it is gone.
      stale = !isAlive(parsed.launcherPid);
    } else {
      // No pid to reason about (legacy record): fall back to the short age backstop.
      const createdAtMs = typeof parsed.createdAtMs === 'number' ? parsed.createdAtMs : 0;
      stale = now - createdAtMs >= maxAgeMs;
    }
    if (stale) {
      try {
        rmSync(full, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

/** Age of a file in ms by its mtime, or Infinity when it cannot be stat'd (treat as ancient). */
function fileAgeMs(path: string, now: number): number {
  try {
    return now - statSync(path).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
