import { describe, it, expect, vi } from 'vitest';
import { refreshCredentials } from './oauth.js';
import { QuarantineError, RefreshError } from './errors.js';
import type { ClaudeOauth } from './types.js';

const current: ClaudeOauth = {
  accessToken: 'old-access',
  refreshToken: 'old-refresh',
  expiresAt: 1_000,
  subscriptionType: 'pro',
  rateLimitTier: 'tier-1',
};

/** Build a fake fetch returning a given status + body. */
function fakeFetch(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
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
});
