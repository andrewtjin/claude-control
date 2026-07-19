// Rate-limited, self-healing token getter for the daemon's usage poller.
//
// The poller peeks access tokens straight from the vault; an idle account's token eventually
// expires and that account's poll goes blind — the tier-0 cache in `~/.claude.json` only ever
// describes the ACTIVE account. This wrapper closes the gap: on an expired/near-expiry token
// it asks the switch engine — the only component allowed to consume single-use refresh tokens,
// under its credential lock — to refresh the vault copy, then retries the vault read once.
//
// IDENTITY INVARIANT (learned from a live contamination incident): the poller must never
// TRUST that a stored token belongs to the account it is filed under. A pre-guard adoption
// bug once wrote one account's credentials into another account's bundle — polling the victim
// silently reported the intruder's usage, so the advisor double-counted one account and hid a
// fully-fresh one, with nothing anywhere saying so. Two checks close that hole:
//   1. LOCAL (every read, free): the bundle's captured `oauthAccount.accountUuid` must match
//      the registry row's `accountUuid`. Our own two files disagreeing IS the incident.
//   2. NETWORK (per poll, live truth): the OAuth profile endpoint, asked with the very token
//      about to be used, must name the expected account. This also catches the subtler lie
//      the local check cannot: a refresh response carries no identity, so a bundle can hold
//      FOREIGN tokens under a row-matching identity block.
// A confirmed mismatch quarantines the account (the daemon's existing quarantine notice then
// pushes the guided re-login card) and withholds the token — stale-but-honest data beats
// fresh numbers attributed to the wrong account. The network check FAILS OPEN on anything
// that is not positive evidence of mismatch (network error, non-2xx, unrecognized shape):
// availability problems must never quarantine a healthy account.
//
// Failure posture: at most one refresh attempt per account per interval (1h), exponential
// backoff on consecutive failures. This layer never quarantines for DEAD tokens itself (the
// engine quarantines a permanently dead token as part of its own refresh path); identity
// mismatches are the one condition it quarantines for directly, because it is the only
// component that pairs a token with the account the caller believes it belongs to. A failure
// here just THROWS a descriptive error, which the poller turns into a tier-0 fallback with
// the message surfaced on the account's snapshot entry. Token material is never logged and
// never appears in error messages.

import type { RefreshTokenResult, Vault } from '@claude-control/switch-engine';

/** Floor between refresh attempts for one account — polling must not churn refresh tokens. */
export const POLL_REFRESH_MIN_INTERVAL_MS = 60 * 60_000;
/** Cap on the failure backoff (1h, 2h, 4h, then capped). */
export const POLL_REFRESH_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** The OAuth profile endpoint — same auth class as the usage endpoint the poller already
 *  hits (bearer token + beta header); returns the token owner's identity at `account.uuid`
 *  (shape confirmed against the live endpoint). */
export const PROFILE_ENDPOINT = 'https://api.anthropic.com/api/oauth/profile';
/** Mirrors the usage poller's beta header — both endpoints sit behind the same OAuth gate. */
export const PROFILE_BETA_HEADER = 'oauth-2025-04-20';

/** The ownership check is a liveness probe, not a gate: bound it tightly so a slow/hung profile
 *  endpoint fails OPEN (hands the token out) fast instead of stalling the account's poll. An
 *  abort lands in the same catch as any other network error, which already fails open. */
export const PROFILE_FETCH_TIMEOUT_MS = 10_000;

/** The one engine capability this wrapper needs — tests inject a fake. */
export interface PollRefreshEngine {
  refreshToken(accountId: string): Promise<RefreshTokenResult>;
}

/** The slice of a registry row the identity checks need. Structurally satisfied by
 *  `StoredAccount`, so production wires `vault.getAccount` straight through. */
export interface AccountIdentityRow {
  accountUuid?: string;
  quarantined: boolean;
  quarantineReason?: string;
}

/** Minimal fetch shape for the profile call, injectable for tests. `signal` rides through so
 *  the call can be bounded with an `AbortSignal.timeout`; the default `globalThis.fetch` path
 *  forwards it untouched. */
export type ProfileFetch = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Wiring for the identity invariant. Absent entirely → legacy behavior (no checks) — the
 *  production composition root always passes it. */
export interface PollIdentityOptions {
  /** Registry truth for one account (uuid + quarantine state); `undefined` = unknown id. */
  lookupAccount: (accountId: string) => Promise<AccountIdentityRow | undefined>;
  /** Quarantine the account; the daemon's notice reconciler pushes the re-login card. */
  quarantine: (accountId: string, reason: string) => Promise<void>;
  /** The NETWORK ownership check (the local row-vs-bundle check always runs — comparing our
   *  own files costs nothing and cannot false-positive). Default true. */
  verifyOwnership?: boolean;
  fetchFn?: ProfileFetch;
  userAgent?: string;
}

export interface PollTokenGetterOptions {
  /** Peek-only vault reads; production passes a real `Vault` on the daemon's paths. */
  vault: Pick<Vault, 'readBundle'>;
  engine: PollRefreshEngine;
  /** A token within this window before expiry is treated as unusable for polling. */
  minTtlMs: number;
  identity?: PollIdentityOptions;
  clock?: () => number;
  /** Override the attempt floor / backoff cap (tests only). */
  minRefreshIntervalMs?: number;
  backoffCapMs?: number;
}

/** Per-account refresh-attempt bookkeeping, kept in memory (a daemon restart resets it —
 *  worst case one extra attempt per account, still bounded by the poller's own floor). */
interface RefreshAttemptState {
  /** When the next refresh attempt for this account is allowed. */
  nextAttemptAtMs: number;
  /** Consecutive failed attempts; drives the exponential backoff. */
  consecutiveFailures: number;
  /** The last failure's message, re-surfaced on every poll until the next attempt so the
   *  snapshot keeps showing WHY the account is degraded, not just that it is. */
  lastError?: string;
}

/** An identity check found positive evidence of mismatch (and quarantined the account) — a
 *  dedicated class so the quiet unreadable-bundle fallbacks can never swallow it. */
class IdentityMismatchError extends Error {}

/**
 * Build the `getToken` function the {@link UsagePoller} is wired with. Returns the account's
 * access token when the vault copy is usable AND provably belongs to the account; otherwise
 * attempts (rate-limited) a refresh via the engine and retries the read once. Returns
 * `undefined` for a quiet tier-0 fallback; throws when there is a failure worth surfacing in
 * the snapshot (refresh failure, identity mismatch, quarantined account).
 */
export function createPollTokenGetter(
  options: PollTokenGetterOptions,
): (accountId: string) => Promise<string | undefined> {
  const clock = options.clock ?? Date.now;
  const minIntervalMs = options.minRefreshIntervalMs ?? POLL_REFRESH_MIN_INTERVAL_MS;
  const backoffCapMs = options.backoffCapMs ?? POLL_REFRESH_BACKOFF_CAP_MS;
  const identity = options.identity;
  const state = new Map<string, RefreshAttemptState>();

  /** Read the vault token, enforcing the LOCAL identity invariant; `undefined` when
   *  expired/near-expiry. Read errors propagate (the caller maps them to a quiet fallback,
   *  EXCEPT IdentityMismatchError which always surfaces). */
  const readUsableToken = async (
    accountId: string,
    row: AccountIdentityRow | undefined,
  ): Promise<string | undefined> => {
    const bundle = await options.vault.readBundle(accountId);
    const bundleUuid = bundle.oauthAccount?.accountUuid;
    // Both sides must exist to compare — an uncaptured identity is unverifiable, not guilty.
    if (
      identity !== undefined &&
      row?.accountUuid !== undefined &&
      bundleUuid !== undefined &&
      bundleUuid !== row.accountUuid
    ) {
      const reason = `vault bundle identity mismatch (bundle ${bundleUuid} != registry ${row.accountUuid})`;
      await identity.quarantine(accountId, reason);
      throw new IdentityMismatchError(`${reason} - quarantined; run cctl accounts relogin`);
    }
    const oauth = bundle.claudeAiOauth;
    if (oauth.expiresAt - clock() < options.minTtlMs) return undefined;
    return oauth.accessToken;
  };

  /** NETWORK ownership check on the token about to be handed out. Resolves with the token on
   *  a match or on anything that is not positive evidence (fail open); quarantines and
   *  throws on a confirmed mismatch. */
  const verifiedToken = async (
    accountId: string,
    row: AccountIdentityRow | undefined,
    token: string,
  ): Promise<string> => {
    if (
      identity === undefined ||
      row?.accountUuid === undefined ||
      (identity.verifyOwnership ?? true) === false
    ) {
      return token;
    }
    const fetchFn = identity.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
    let body: unknown;
    try {
      const res = await fetchFn(PROFILE_ENDPOINT, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': PROFILE_BETA_HEADER,
          'user-agent': identity.userAgent ?? 'claude-code/1.0.0',
        },
        // A timeout aborts into the catch below and fails open, exactly like a network error.
        signal: AbortSignal.timeout(PROFILE_FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return token; // 401/429/5xx: availability or auth, never identity evidence
      body = await res.json();
    } catch {
      return token; // network/parse failure: fail open
    }
    const account = (body as { account?: { uuid?: unknown } } | undefined)?.account;
    const liveUuid = typeof account?.uuid === 'string' ? account.uuid : undefined;
    if (liveUuid === undefined || liveUuid === row.accountUuid) return token; // drift or match
    const reason = `token ownership mismatch (profile account ${liveUuid} != registry ${row.accountUuid})`;
    await identity.quarantine(accountId, reason);
    throw new IdentityMismatchError(`${reason} - quarantined; run cctl accounts relogin`);
  };

  return async (accountId: string): Promise<string | undefined> => {
    const row = identity !== undefined ? await identity.lookupAccount(accountId) : undefined;
    // A quarantined account's token is withheld outright: its bundle needs a re-login before
    // it can be TRUSTED again, and polling with a suspect token is precisely the
    // wrong-account attribution this layer exists to prevent. The thrown reason keeps the
    // snapshot honest (retained data + why) instead of silently serving the wrong numbers.
    if (identity !== undefined && row?.quarantined === true) {
      throw new Error(
        `account is quarantined (${row.quarantineReason ?? 're-login required'}) - not polled`,
      );
    }

    let token: string | undefined;
    try {
      token = await readUsableToken(accountId, row);
    } catch (err) {
      if (err instanceof IdentityMismatchError) throw err;
      return undefined; // unreadable bundle → tier-0 fallback, never a poll crash
    }
    if (token !== undefined) return verifiedToken(accountId, row, token);

    // Expired/near-expiry. A refresh may be attempted at most once per interval per account.
    const now = clock();
    const prior = state.get(accountId);
    if (prior && now < prior.nextAttemptAtMs) {
      if (prior.lastError !== undefined) {
        // Keep the standing failure visible in every snapshot until the next attempt.
        const retryInMin = Math.ceil((prior.nextAttemptAtMs - now) / 60_000);
        throw new Error(`token refresh failed (retry in ~${retryInMin}m): ${prior.lastError}`);
      }
      return undefined; // attempted recently without a reportable failure — quiet fallback
    }

    try {
      await options.engine.refreshToken(accountId);
      // Success (or a deliberate engine skip) — either way this attempt is spent.
      state.set(accountId, { nextAttemptAtMs: now + minIntervalMs, consecutiveFailures: 0 });
    } catch (err) {
      const consecutiveFailures = (prior?.consecutiveFailures ?? 0) + 1;
      const backoffMs = Math.min(minIntervalMs * 2 ** (consecutiveFailures - 1), backoffCapMs);
      const message = err instanceof Error ? err.message : String(err);
      state.set(accountId, {
        nextAttemptAtMs: now + backoffMs,
        consecutiveFailures,
        lastError: message,
      });
      throw new Error(`token refresh failed: ${message}`);
    }

    // Retry the vault read ONCE. Still unusable (e.g. the engine skipped the active account,
    // which tier-0 covers anyway) → quiet fallback. The re-read runs the same identity
    // checks: a refresh rotates the bundle, and rotated contents deserve no more trust than
    // the originals.
    try {
      token = await readUsableToken(accountId, row);
    } catch (err) {
      if (err instanceof IdentityMismatchError) throw err;
      return undefined;
    }
    return token === undefined ? undefined : verifiedToken(accountId, row, token);
  };
}
