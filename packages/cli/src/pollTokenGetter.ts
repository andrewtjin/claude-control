// Rate-limited, self-healing token getter for the daemon's usage poller.
//
// The poller peeks access tokens straight from the vault; an idle account's token eventually
// expires and that account's poll goes blind — the tier-0 cache in `~/.claude.json` only ever
// describes the ACTIVE account. This wrapper closes the gap: on an expired/near-expiry token
// it asks the switch engine — the only component allowed to consume single-use refresh tokens,
// under its credential lock — to refresh the vault copy, then retries the vault read once.
//
// Failure posture: at most one refresh attempt per account per interval (1h), exponential
// backoff on consecutive failures. This layer never quarantines anything itself (the engine
// quarantines a permanently dead token as part of its own refresh path); a failure here just
// THROWS a descriptive error, which the poller turns into a tier-0 fallback with the message
// surfaced on the account's snapshot entry. Token material is never logged and never appears
// in error messages.

import type { RefreshTokenResult, Vault } from '@claude-control/switch-engine';

/** Floor between refresh attempts for one account — polling must not churn refresh tokens. */
export const POLL_REFRESH_MIN_INTERVAL_MS = 60 * 60_000;
/** Cap on the failure backoff (1h, 2h, 4h, then capped). */
export const POLL_REFRESH_BACKOFF_CAP_MS = 6 * 60 * 60_000;

/** The one engine capability this wrapper needs — tests inject a fake. */
export interface PollRefreshEngine {
  refreshToken(accountId: string): Promise<RefreshTokenResult>;
}

export interface PollTokenGetterOptions {
  /** Peek-only vault reads; production passes a real `Vault` on the daemon's paths. */
  vault: Pick<Vault, 'readBundle'>;
  engine: PollRefreshEngine;
  /** A token within this window before expiry is treated as unusable for polling. */
  minTtlMs: number;
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

/**
 * Build the `getToken` function the {@link UsagePoller} is wired with. Returns the account's
 * access token when the vault copy is usable; otherwise attempts (rate-limited) a refresh via
 * the engine and retries the read once. Returns `undefined` for a quiet tier-0 fallback;
 * throws when there is a refresh failure worth surfacing in the snapshot.
 */
export function createPollTokenGetter(
  options: PollTokenGetterOptions,
): (accountId: string) => Promise<string | undefined> {
  const clock = options.clock ?? Date.now;
  const minIntervalMs = options.minRefreshIntervalMs ?? POLL_REFRESH_MIN_INTERVAL_MS;
  const backoffCapMs = options.backoffCapMs ?? POLL_REFRESH_BACKOFF_CAP_MS;
  const state = new Map<string, RefreshAttemptState>();

  /** Read the vault token; `undefined` when expired/near-expiry. Read errors propagate. */
  const readUsableToken = async (accountId: string): Promise<string | undefined> => {
    const bundle = await options.vault.readBundle(accountId);
    const oauth = bundle.claudeAiOauth;
    if (oauth.expiresAt - clock() < options.minTtlMs) return undefined;
    return oauth.accessToken;
  };

  return async (accountId: string): Promise<string | undefined> => {
    let token: string | undefined;
    try {
      token = await readUsableToken(accountId);
    } catch {
      return undefined; // unreadable bundle → tier-0 fallback, never a poll crash
    }
    if (token !== undefined) return token;

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
    // which tier-0 covers anyway) → quiet fallback.
    try {
      return await readUsableToken(accountId);
    } catch {
      return undefined;
    }
  };
}
