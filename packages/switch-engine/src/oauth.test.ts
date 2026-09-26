import { describe, it, expect, vi } from 'vitest';
import { refreshCredentials, OAUTH_REFRESH_SCOPES, type RefreshDeps } from './oauth.js';
import { QuarantineError, RefreshError } from './errors.js';
import {
  createStatusProbeCache,
  isOverloadCode,
  LOCKED_CALL_BUDGET_MS,
  LOCKED_OVERLOAD_BUDGET_CAP_MS,
  OVERLOAD_MIN_ATTEMPT_MS,
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

  it('posts a JSON refresh body with grant_type, the current refresh token, client_id and scope', async () => {
    const fetch = fakeFetch(
      200,
      JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
    );
    // `current` records no scopes, so the CLI-default refresh scope set is sent.
    await refreshCredentials(current, { fetch, clientId: 'cid', tokenEndpoint: 'https://ep' });
    expect(fetch).toHaveBeenCalledOnce();
    const call = fetch.mock.calls[0] as [string, { body: string; headers: Record<string, string> }];
    const [url, init] = call;
    expect(url).toBe('https://ep');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'old-refresh',
      client_id: 'cid',
      scope: OAUTH_REFRESH_SCOPES,
    });
  });

  it('always sends the full base refresh scope set — a refresh never ratchets scopes down', async () => {
    // The CLI's refresh scope is $zr(stored) = dedupe([...s9e, ...stored ∩ project scopes]); the
    // base login set is always present even when the stored credential recorded a narrower set, so
    // a session keeps remote control, MCP connectors, file upload and plugins across a refresh.
    const fetch = fakeFetch(
      200,
      JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
    );
    const scoped = { ...current, scopes: ['user:profile', 'user:inference'] };
    await refreshCredentials(scoped, { fetch });
    const [, init] = fetch.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as { scope: string }).scope).toBe(OAUTH_REFRESH_SCOPES);
  });

  it('never sends org:create_api_key on a refresh, even when the credential holds it', async () => {
    // org:create_api_key is a console-only authorize scope; the CLI's refresh drops it. Carrying it
    // onto a refresh could exceed the grant and be rejected.
    const fetch = fakeFetch(
      200,
      JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
    );
    const scoped = { ...current, scopes: ['org:create_api_key', 'user:profile', 'user:inference'] };
    await refreshCredentials(scoped, { fetch });
    const [, init] = fetch.mock.calls[0] as [string, { body: string }];
    const sent = (JSON.parse(init.body) as { scope: string }).scope.split(' ');
    expect(sent).not.toContain('org:create_api_key');
    expect((JSON.parse(init.body) as { scope: string }).scope).toBe(OAUTH_REFRESH_SCOPES);
  });

  it('carries the two project scopes from the stored credential onto the base set', async () => {
    // The only scopes the CLI carries over from the stored credential are user:projects:read /
    // user:projects:write (its `n=[Lhn,Nhn]`), appended after the base set and de-duplicated.
    const fetch = fakeFetch(
      200,
      JSON.stringify({ access_token: 'a', refresh_token: 'b', expires_in: 60 }),
    );
    const scoped = {
      ...current,
      scopes: ['user:profile', 'user:projects:read', 'user:projects:write'],
    };
    await refreshCredentials(scoped, { fetch });
    const [, init] = fetch.mock.calls[0] as [string, { body: string }];
    expect((JSON.parse(init.body) as { scope: string }).scope).toBe(
      `${OAUTH_REFRESH_SCOPES} user:projects:read user:projects:write`,
    );
  });

  it('maps invalid_grant to a QuarantineError (permanent death)', async () => {
    const fetch = fakeFetch(400, JSON.stringify({ error: 'invalid_grant' }));
    await expect(refreshCredentials(current, { fetch })).rejects.toBeInstanceOf(QuarantineError);
  });

  it('detects invalid_grant in the object error shape too (error.type)', async () => {
    // The CLI keys off the precise code, which is `error` when a string or its `.type` when an
    // object. Both must quarantine.
    const fetch = fakeFetch(400, JSON.stringify({ error: { type: 'invalid_grant' } }));
    await expect(refreshCredentials(current, { fetch })).rejects.toBeInstanceOf(QuarantineError);
  });

  it('does NOT quarantine a 400 whose real code is invalid_scope but whose text mentions invalid_grant', async () => {
    // The classifier keys off the precise OAuth error code, not a substring of the body: a body
    // whose actual `error` is invalid_scope must never quarantine just because its description
    // happens to contain the word "invalid_grant". A loose scan would strand a healthy account
    // behind a re-login card — the dangerous direction.
    const fetch = fakeFetch(
      400,
      JSON.stringify({
        error: 'invalid_scope',
        error_description: 'the requested scope is not invalid_grant-compatible',
      }),
    );
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(QuarantineError);
    // `current` records no scopes, so there is nothing to fall back to and the primary
    // invalid_scope surfaces directly (never reclassified as invalid_grant).
    expect((err as RefreshError).code).toBe('invalid_scope');
  });

  it('does NOT quarantine a 400 whose body merely mentions invalid_grant in non-code text', async () => {
    // No precise `error` code of invalid_grant → transient, not a quarantine. Matches the CLI,
    // which parses JSON and reads Ca(data).code rather than scanning the raw body.
    const fetch = fakeFetch(
      400,
      JSON.stringify({ error: 'server_error', error_description: 'downstream said invalid_grant' }),
    );
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(QuarantineError);
    expect((err as RefreshError).code).toBe('http_400');
  });

  it('quarantines an invalid_grant returned as HTTP 401, matching the CLI dead-token guard', async () => {
    // The CLI's guard accepts 400 OR 401 for a spent refresh token. A 401 + invalid_grant is a
    // dead account and must be parked, not retried forever as a generic transient 401.
    const fetch = fakeFetch(401, JSON.stringify({ error: 'invalid_grant' }));
    await expect(refreshCredentials(current, { fetch })).rejects.toBeInstanceOf(QuarantineError);
  });

  it('does NOT quarantine a bare 401 without an invalid_grant code (stays transient)', async () => {
    // A 401 that is not invalid_grant says nothing about the refresh token being dead; keep it a
    // transient http_401 so a blip does not park a healthy account.
    const fetch = fakeFetch(401, JSON.stringify({ error: 'unauthorized' }));
    const err = await refreshCredentials(current, { fetch }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(QuarantineError);
    expect((err as RefreshError).code).toBe('http_401');
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

  describe('invalid_scope fallback (mirrors the CLI)', () => {
    const scoped = { ...current, scopes: ['user:profile', 'user:inference'] };

    it('retries ONCE with the credential’s own stored scopes and succeeds', async () => {
      // The primary attempt sends the base refresh set; a 400 invalid_scope triggers a single
      // retry with the stored scopes (the CLI's tengu_oauth_refresh_invalid_scope_fallback).
      const fetch = scriptedFetch([
        [400, JSON.stringify({ error: 'invalid_scope' })],
        [200, TOKENS],
      ]);
      const next = await refreshCredentials(scoped, depsFor(fetch, 'none'));
      expect(next.accessToken).toBe('new-access');
      expect(fetch).toHaveBeenCalledTimes(2);
      // First attempt: base set. Retry: exactly the credential's stored scopes, nothing widened.
      const first = JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, { body: string }])[1].body,
      ) as { scope: string };
      const retry = JSON.parse(
        (fetch.mock.calls[1] as unknown as [string, { body: string }])[1].body,
      ) as { scope: string };
      expect(first.scope).toBe(OAUTH_REFRESH_SCOPES);
      expect(retry.scope).toBe('user:profile user:inference');
    });

    it('detects invalid_scope in the object error shape too (error.type)', async () => {
      const fetch = scriptedFetch([
        [400, JSON.stringify({ error: { type: 'invalid_scope' } })],
        [200, TOKENS],
      ]);
      const next = await refreshCredentials(scoped, depsFor(fetch, 'none'));
      expect(next.accessToken).toBe('new-access');
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('classifies a repeated invalid_scope after the retry as a permanent http_400 (never quarantine)', async () => {
      // A permanent 400 must NOT loop and must NOT quarantine: invalid_scope is never invalid_grant.
      // Callers key retry/backoff off the code — pollTokenGetter, usagePoller and accountProbe all
      // treat only isOverloadCode(...) failures as blameless; http_400 is not one, so they count it
      // as a real failure and grow their exponential backoff (capped), rather than retrying forever
      // or holding the account blind. refreshAndPersist only quarantines a QuarantineError, so a
      // http_400 leaves the vault untouched.
      const fetch = scriptedFetch([[400, JSON.stringify({ error: 'invalid_scope' })]]);
      const err = await refreshCredentials(scoped, depsFor(fetch, 'none')).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('http_400');
      expect(isOverloadCode((err as RefreshError).code)).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    });

    it('does not retry when the credential has no stored scopes to fall back to', async () => {
      // `current` records no scopes, so the retry would only re-send the base default already tried.
      const fetch = scriptedFetch([[400, JSON.stringify({ error: 'invalid_scope' })]]);
      const err = await refreshCredentials(current, depsFor(fetch, 'none')).catch(
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect(fetch).toHaveBeenCalledTimes(1);
    });
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

    it('reports the retry loop to an injected logger so an outage leaves a trace', async () => {
      // The loop defaults to a discarding sink, so without a logger wired through refreshDeps a
      // token endpoint shedding load spends seconds in silence and surfaces only as the failure
      // message at the end. These lines are the incident's only record while it is happening.
      const lines: { obj: unknown; msg: string | undefined }[] = [];
      const record = (obj: unknown, msg?: string): void => void lines.push({ obj, msg });
      const deps = depsFor(scriptedFetch([[529, 'overloaded']]), 'none');

      await refreshCredentials(current, {
        ...deps,
        overload: {
          ...deps.overload,
          logger: { debug: record, info: record, warn: record, error: record },
        },
      }).catch(() => undefined);

      const retries = lines.filter((l) => l.msg === 'upstream overloaded; retrying');
      expect(retries).toHaveLength(SHORT_OVERLOAD_BUDGET.maxAttempts - 1);
      expect(retries[0]?.obj).toMatchObject({ status: 529, attempt: 1, statusPage: 'none' });
      // One closing line when the budget is spent: an incident needs an end as well as a start.
      expect(
        lines.filter((l) => l.msg === 'upstream still overloaded; retry budget spent'),
      ).toHaveLength(1);
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

    it('bounds the WHOLE refresh, not just its retries, because it holds the credential lock', async () => {
      // A token endpoint that answers 529 slowly: the first attempt alone eats nearly the whole
      // budget a lock holder has. The retry phase's own cap would still allow another try; the
      // time the caller has left does not, and a refresh that kept going here would be writing
      // credentials under a lock another process had already reclaimed.
      let nowMs = 0;
      const slowOverloaded = vi.fn(() => {
        nowMs += LOCKED_CALL_BUDGET_MS - OVERLOAD_MIN_ATTEMPT_MS;
        return Promise.resolve({
          ok: false,
          status: 529,
          text: () => Promise.resolve('overloaded'),
        });
      });

      const err = await refreshCredentials(current, {
        fetch: slowOverloaded,
        overload: { ...overloadDeps('none'), now: () => nowMs },
      }).catch((e: unknown) => e);

      expect(slowOverloaded).toHaveBeenCalledTimes(1);
      expect((err as RefreshError).code).toBe('http_529');
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
