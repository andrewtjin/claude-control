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
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 *  slot the session is running on and was not carried into a different one. */
export interface BindTokenRecord {
  v: 1;
  kind: BindTokenKind;
  profileKey: string;
  createdAtMs: number;
}

/** Records older than this are pruned on the next mint — a backstop for a launcher that exited
 *  without cleaning up its own token (e.g. a hard kill). Far longer than any real interactive
 *  session, so it never invalidates a live one. */
export const BIND_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
  /** Injectable clock, for tests. */
  now?: () => number;
  /** Injectable token source, for tests. Must return 32 lower-case hex chars. */
  randomHex?: () => string;
}

/** Mint a relaxation token: write its record and return the token value the launcher puts in the env
 *  var. Best-effort prunes stale records first so a crashed launcher's leftovers do not accumulate. */
export function mintBindToken(opts: MintBindTokenOptions): string {
  const now = opts.now ?? Date.now;
  const token = (opts.randomHex ?? (() => randomBytes(16).toString('hex')))();
  cleanupBindTokens({ tokensDir: opts.tokensDir, now });
  mkdirSync(opts.tokensDir, { recursive: true });
  const record: BindTokenRecord = {
    v: 1,
    kind: opts.kind,
    profileKey: opts.profileKey,
    createdAtMs: now(),
  };
  writeFileSync(join(opts.tokensDir, tokenFileName(token)), JSON.stringify(record), 'utf8');
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
  now?: () => number;
}

/** Prune records older than maxAgeMs (default {@link BIND_TOKEN_MAX_AGE_MS}) and any that cannot be
 *  parsed. Best-effort and silent — a failure here must never break a launch. */
export function cleanupBindTokens(opts: CleanupBindTokensOptions): void {
  const now = (opts.now ?? Date.now)();
  const maxAgeMs = opts.maxAgeMs ?? BIND_TOKEN_MAX_AGE_MS;
  let entries: string[];
  try {
    entries = readdirSync(opts.tokensDir);
  } catch {
    return; // No dir yet, or unreadable: nothing to prune.
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const full = join(opts.tokensDir, name);
    let stale = true;
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8')) as Partial<BindTokenRecord>;
      if (typeof parsed.createdAtMs === 'number' && now - parsed.createdAtMs < maxAgeMs) {
        stale = false;
      }
    } catch {
      stale = true; // Unparseable record: drop it.
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
