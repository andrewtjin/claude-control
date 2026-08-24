import { describe, it, expect, vi } from 'vitest';
import { refreshCredentials, type RefreshDeps } from './oauth.js';
import { QuarantineError, RefreshError } from './errors.js';
import {
  createStatusProbeCache,
  LOCKED_OVERLOAD_BUDGET_CAP_MS,
  PATIENT_OVERLOAD_BUDGET,
  SHORT_OVERLOAD_BUDGET,
  type OverloadRetryDeps,
} from './overload.js';
import type { ClaudeOauth } from './types.js';

const current: ClaudeOauth = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1_000,
  subscriptionType: 'pro',
  rateLimitTier: 'tier-1',
};

const TOKENS = JSON.stringify({ access_token: 'new-access', refresh_token: 'new-refresh' });

/** Build a fake fetch returning a given status + body. */
function fakeFetch(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
}

/** A fetch that walks a list of (status, body) pairs, repeating the last forever after — the
 *  shape a retried refresh needs. */
function scriptedFetch(steps: [number, string][]) {
  let index = 0;
  return vi.fn(() => {
    const step = steps[Math.min(index, steps.length - 1)] ?? [200, TOKENS];
    index += 1;
    const [status, body] = step;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(body),
    });
  });
}

/** Overload deps with no real waiting and a status page under the test's control. `indicator`
 *  of `undefined` means the probe itself fails. */
function overloadDeps(indicator: string | undefined): OverloadRetryDeps {
  return {
    now: () => 0,
    sleep: () => Promise.resolve(),
    random: () => 0,
    statusCache: createStatusProbeCache(),
    statusFetch: () =>
      indicator === undefined
        ? Promise.reject(new Error('status page unreachable'))
        : Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve<unknown>({ status: { indicator } }),
          }),
  };
}

/** Deps for a refresh under a controlled status page. */
function depsFor(fetch: RefreshDeps['fetch'], indicator: string | undefined): RefreshDeps {
  return { ...(fetch !== undefined ? { fetch } : {}), overload: overloadDeps(indicator) };
}

describe('refreshCredentials', () => {
  it('applies the rotated refresh token and computes absolute expiry', async () => {
    const fetch = fakeFetch(
      200,
      JSON.stringify({
        access_token: 'new-access',
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    );
    const next = await refreshCredentials(current, { fetch, now: () => 10_000 });
    expect(next.accessToken).toBe('new-access');
    expect(next.refreshToken).toBe('new-refresh'); // rotation captured
    expect(next.expiresAt).toBe(10_000 + 3600 * 1000);
    // Fields the endpoint does not echo are preserved from the prior credential.
    expect(next.subscriptionType).toBe('pro');
    expect(next.rateLimitTier).toBe('tier-1');
  });

  it('sends grant_type=refresh_token with the current refresh token', async () => {
    const fetch = fakeFetch(
      200,
      JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
    );
    await refreshCredentials(current, { fetch, clientId: 'cid', tokenEndpoint: 'https://ep' });
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0] as [string, { body: string }];
    const [url, init] = call;
    expect(url).toBe('https://ep');
    expect(init.body).toContain('grant_type=refresh_token');
    expect(init.body).toContain('refresh_token=old-refresh');
    expect(init.body).toContain('client_id=cid');
  });

  it('maps invalid_grant to a QuarantineError (permanent death)', async () => {
    const fetch = fakeFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    await expect(refreshCredentials(current, { fetch })).rejects.toBeInstanceOf(QuarantineError);
  });

  it('maps a 5xx to a transient RefreshError, not quarantine', async () => {
    const fetch = fakeFetch(503, 'upstream unavailable');
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshError);
    expect(err).not.toBeInstanceOf(QuarantineError);
    expect((err as RefreshError).code).toBe('http_503');
  });

  it('treats a network throw as transient', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).code).toBe('network');
  });

  it('maps a refresh timeout (abort) to a transient RefreshError, never a QuarantineError', async () => {
    // What AbortSignal.timeout produces when the bound fires — it must land in the transient
    // branch (safe to retry), keeping invalid_grant → QuarantineError semantics untouched.
    const aborted = new Error('The operation was aborted due to timeout');
    aborted.name = 'TimeoutError';
    const fetch = vi.fn().mockRejectedValue(aborted);
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RefreshError);
    expect(err).not.toBeInstanceOf(QuarantineError);
    expect((err as RefreshError).code).toBe('network');
  });

  it('rejects a malformed (non-JSON) success body', async () => {
    const fetch = fakeFetch(200, 'not json');
    await expect(refreshCredentials(current, { fetch })).rejects.toBeInstanceOf(RefreshError);
  });

  it('keeps the current refresh token if the response omits a new one', async () => {
    const fetch = fakeFetch(200, JSON.stringify({ access_token: 'new-access', expires_in: 60 }));
    const next = await refreshCredentials(current, { fetch, now: () => 0 });
    expect(next.refreshToken).toBe('old-refresh');
  });

  describe('when the token endpoint is overloaded', () => {
    it('retries a 529 and succeeds on the retry', async () => {
      const fetch = scriptedFetch([
        [529, 'overloaded'],
        [200, TOKENS],
      ]);

      const next = await refreshCredentials(current, depsFor(fetch, 'none'));

      expect(next.accessToken).toBe('new-access');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('gives up after the short budget when the status page is all-clear', async () => {
      const fetch = scriptedFetch([[529, 'overloaded']]);

      const err = await refreshCredentials(current, depsFor(fetch, 'none')).catch(
        (e: unknown) => e,
      );

      expect(fetch).toHaveBeenCalledTimes(SHORT_OVERLOAD_BUDGET.maxAttempts);
      expect(err).toBeInstanceOf(RefreshError);
      // The code stays the plain http_<status>, which is what callers branch on.
      expect((err as RefreshError).code).toBe('http_529');
      expect((err as RefreshError).message).toBe(
        'token endpoint overloaded (529) after 3 attempts; status.claude.com: none',
      );
    });

    it('is patient during a reported incident and names it in the message', async () => {
      const fetch = scriptedFetch([[529, 'overloaded']]);

      const err = await refreshCredentials(current, depsFor(fetch, 'major')).catch(
        (e: unknown) => e,
      );

      expect(fetch).toHaveBeenCalledTimes(PATIENT_OVERLOAD_BUDGET.maxAttempts);
      // This message reaches the user's phone verbatim, so it must be honest about both facts.
      expect((err as RefreshError).message).toBe(
        'token endpoint overloaded (529) after 6 attempts; status.claude.com: major',
      );
    });

    it('is patient — never LESS patient — when the status page cannot be reached', async () => {
      const fetch = scriptedFetch([[529, 'overloaded']]);

      const err = await refreshCredentials(current, depsFor(fetch, undefined)).catch(
        (e: unknown) => e,
      );

      expect(fetch).toHaveBeenCalledTimes(PATIENT_OVERLOAD_BUDGET.maxAttempts);
      expect((err as RefreshError).message).toBe(
        'token endpoint overloaded (529) after 6 attempts; status.claude.com: unreachable',
      );
    });

    it('never quarantines: an overload says nothing about the refresh token', async () => {
      const fetch = scriptedFetch([[529, 'overloaded']]);

      const err = await refreshCredentials(current, depsFor(fetch, 'critical')).catch(
        (e: unknown) => e,
      );

      expect(err).not.toBeInstanceOf(QuarantineError);
    });

    it('still quarantines an invalid_grant, with no retrying at all', async () => {
      const fetch = scriptedFetch([[400, JSON.stringify({ error: 'invalid_grant' })]]);

      const err = await refreshCredentials(current, depsFor(fetch, 'major')).catch(
        (e: unknown) => e,
      );

      expect(err).toBeInstanceOf(QuarantineError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('does NOT quarantine an invalid_grant that only appeared after a retry', async () => {
      // The refresh token is single-use: a 529 emitted after the service already accepted the
      // request leaves the retry replaying a token that is legitimately spent. That answer
      // describes our own retry, not a dead account, and must not strand a healthy user behind
      // a re-login card.
      const fetch = scriptedFetch([
        [529, 'overloaded'],
        [400, JSON.stringify({ error: 'invalid_grant' })],
      ]);

      const err = await refreshCredentials(current, depsFor(fetch, 'major')).catch(
        (e: unknown) => e,
      );

      expect(err).not.toBeInstanceOf(QuarantineError);
      expect(err).toBeInstanceOf(RefreshError);
      expect((err as RefreshError).code).toBe('invalid_grant_after_retry');
      expect((err as RefreshError).message).toContain('already-rotated token');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('spends less than the patient budget, because it retries inside the credential lock', async () => {
      // The lock reclaims a holder at 60s and a contender gives up waiting at 15s, so this
      // path buys fewer of the patient budget's seconds than the poller does.
      let nowMs = 0;
      const fetch = vi.fn(() => {
        nowMs += 1_000; // a fast 529 from a load shedder
        return Promise.resolve({
          ok: false,
          status: 529,
          text: () => Promise.resolve('overloaded'),
        });
      });

      const err = await refreshCredentials(current, {
        fetch,
        overload: {
          now: () => nowMs,
          sleep: (ms: number) => {
            nowMs += ms;
            return Promise.resolve();
          },
          random: () => 1, // top of the jitter range: the longest sleeps the budget allows
          statusCache: createStatusProbeCache(),
          statusFetch: () =>
            Promise.resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve<unknown>({ status: { indicator: 'major' } }),
            }),
        },
      }).catch((e: unknown) => e);

      expect(fetch.mock.calls.length).toBeGreaterThan(1);
      expect(fetch.mock.calls.length).toBeLessThan(PATIENT_OVERLOAD_BUDGET.maxAttempts);
      expect((err as RefreshError).code).toBe('http_529');
      // Retries and sleeps together stay inside the locked cap, plus the request that
      // discovered the overload and the one that ends the loop.
      expect(nowMs).toBeLessThanOrEqual(LOCKED_OVERLOAD_BUDGET_CAP_MS + 2_000);
    });

    it('leaves a 503 on its old single-attempt path', async () => {
      const fetch = scriptedFetch([[503, 'upstream unavailable']]);

      const err = await refreshCredentials(current, depsFor(fetch, 'major')).catch(
        (e: unknown) => e,
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect((err as RefreshError).code).toBe('http_503');
      expect((err as RefreshError).message).toContain('upstream unavailable');
    });

    it('costs no status request when nothing is overloaded', async () => {
      const statusFetch = vi.fn(() =>
        Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve<unknown>({}) }),
      );
      const fetch = scriptedFetch([[200, TOKENS]]);

      await refreshCredentials(current, {
        fetch,
        overload: { ...overloadDeps('none'), statusFetch },
      });

      expect(statusFetch).not.toHaveBeenCalled();
    });
  });
});
