// The authorization-code half of oauth.ts (PKCE mint, authorize URL, paste parsing, exchange).
// Kept in its own file rather than appended to oauth.test.ts because its central guarantee is a
// NEGATIVE one about the refresh path's error taxonomy — a failed code exchange must never be a
// QuarantineError — and that deserves to be findable.

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  parsePastedCode,
  CLAUDE_CODE_CLIENT_ID,
  DEFAULT_REDIRECT_URI,
  OAUTH_AUTHORIZE_SCOPES,
} from './oauth.js';
import { QuarantineError, RefreshError } from './errors.js';

function fakeFetch(status: number, body: string) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  });
}

function okBody(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: 'new-access',
    refresh_token: 'new-refresh',
    expires_in: 3600,
    ...extra,
  });
}

describe('generatePkce / generateState', () => {
  it('mints an RFC 7636-valid verifier and its real S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    // 43 chars is the RFC minimum; base64url is already inside the unreserved charset.
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier).toMatch(/^[A-Za-z0-9\-_]+$/);
    // Recomputed independently: the challenge must really be the hash of THIS verifier.
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('never repeats a verifier or a state across calls', () => {
    const verifiers = new Set(Array.from({ length: 50 }, () => generatePkce().verifier));
    const states = new Set(Array.from({ length: 50 }, () => generateState()));
    expect(verifiers.size).toBe(50);
    expect(states.size).toBe(50);
  });
});

describe('buildAuthorizeUrl', () => {
  it('carries every parameter the login flow needs, and the challenge NOT the verifier', () => {
    const { verifier, challenge } = generatePkce();
    const url = new URL(buildAuthorizeUrl({ challenge, state: 'st-1' }));
    const q = url.searchParams;
    expect(q.get('code')).toBe('true');
    expect(q.get('client_id')).toBe(CLAUDE_CODE_CLIENT_ID);
    expect(q.get('response_type')).toBe('code');
    expect(q.get('redirect_uri')).toBe(DEFAULT_REDIRECT_URI);
    expect(q.get('scope')).toBe(OAUTH_AUTHORIZE_SCOPES);
    expect(q.get('code_challenge')).toBe(challenge);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('state')).toBe('st-1');
    // The security posture, asserted: the verifier never appears in what the user's browser
    // (and therefore the relay, and Discord) gets to see.
    expect(url.toString()).not.toContain(verifier);
  });

  it('honors injected overrides so tests and future endpoint changes need no code edit', () => {
    const url = new URL(
      buildAuthorizeUrl(
        { challenge: 'ch', state: 'st' },
        {
          clientId: 'client-2',
          redirectUri: 'https://example.test/cb',
          authorizeEndpoint: 'https://example.test/authorize',
        },
      ),
    );
    expect(url.origin + url.pathname).toBe('https://example.test/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-2');
    expect(url.searchParams.get('redirect_uri')).toBe('https://example.test/cb');
  });
});

describe('parsePastedCode', () => {
  it('splits "<code>#<state>" and tolerates the whitespace a mobile paste brings', () => {
    expect(parsePastedCode('  abc123#st-1\n')).toEqual({ code: 'abc123', state: 'st-1' });
  });

  it('splits on the LAST hash, so a code containing one still round-trips', () => {
    expect(parsePastedCode('ab#cd#st-1')).toEqual({ code: 'ab#cd', state: 'st-1' });
  });

  it('returns undefined (never throws) for every incomplete paste', () => {
    // The most likely real mistake first: copying only the part before the '#'.
    expect(parsePastedCode('abc123')).toBeUndefined();
    expect(parsePastedCode('')).toBeUndefined();
    expect(parsePastedCode('   ')).toBeUndefined();
    expect(parsePastedCode('#st-1')).toBeUndefined();
    expect(parsePastedCode('abc123#')).toBeUndefined();
  });
});

describe('exchangeAuthorizationCode', () => {
  it('posts the code, state and verifier as JSON and maps the token response', async () => {
    const fetch = fakeFetch(200, okBody({ scope: 'user:profile user:inference' }));
    const result = await exchangeAuthorizationCode(
      { code: 'the-code', state: 'st-1', verifier: 'ver-1' },
      { fetch, now: () => 10_000 },
    );

    const [, init] = fetch.mock.calls[0] as [
      string,
      { body: string; headers: Record<string, string> },
    ];
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({
      grant_type: 'authorization_code',
      code: 'the-code',
      state: 'st-1',
      client_id: CLAUDE_CODE_CLIENT_ID,
      redirect_uri: DEFAULT_REDIRECT_URI,
      code_verifier: 'ver-1',
    });
    expect(result.claudeAiOauth.accessToken).toBe('new-access');
    expect(result.claudeAiOauth.refreshToken).toBe('new-refresh');
    expect(result.claudeAiOauth.expiresAt).toBe(10_000 + 3600 * 1000);
    expect(result.claudeAiOauth.scopes).toEqual(['user:profile', 'user:inference']);
  });

  it('maps the account/organization blocks into an identity when the response carries them', async () => {
    const fetch = fakeFetch(
      200,
      okBody({
        account: { uuid: 'acct-uuid-1', email_address: 'someone@example.test' },
        organization: { uuid: 'org-uuid-1', name: 'Org One' },
      }),
    );
    const result = await exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v' },
      { fetch, now: () => 0 },
    );
    expect(result.oauthAccount).toEqual({
      accountUuid: 'acct-uuid-1',
      emailAddress: 'someone@example.test',
      organizationUuid: 'org-uuid-1',
      organizationName: 'Org One',
    });
  });

  it('reports NO identity rather than inventing one when the response omits those blocks', async () => {
    const fetch = fakeFetch(200, okBody());
    const result = await exchangeAuthorizationCode(
      { code: 'c', state: 's', verifier: 'v' },
      { fetch, now: () => 0 },
    );
    // Absent, not an empty object: the caller's identity guard keys off "was it reported at all".
    expect(result.oauthAccount).toBeUndefined();
  });

  // The load-bearing negative: quarantine means "the vaulted REFRESH token is dead", which a
  // rejected authorization code can never establish. Every failure mode is checked, because the
  // failure this guards against is someone later copying refreshCredentials' invalid_grant branch.
  describe('never quarantines, whatever the failure', () => {
    it('maps a 400 (bad/expired/reused code) to a plain RefreshError', async () => {
      const fetch = fakeFetch(400, JSON.stringify({ error: 'invalid_grant' }));
      const err = await exchangeAuthorizationCode(
        { code: 'c', state: 's', verifier: 'v' },
        { fetch },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('invalid_code');
    });

    it('maps a 5xx to a transient RefreshError', async () => {
      const fetch = fakeFetch(503, 'upstream down');
      const err = await exchangeAuthorizationCode(
        { code: 'c', state: 's', verifier: 'v' },
        { fetch },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('http_503');
    });

    it('maps a network failure to a transient RefreshError', async () => {
      const fetch = vi.fn().mockRejectedValue(new Error('socket hang up'));
      const err = await exchangeAuthorizationCode(
        { code: 'c', state: 's', verifier: 'v' },
        { fetch },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('network');
    });

    it('maps a non-JSON body to bad_response', async () => {
      const fetch = fakeFetch(200, '<html>nope</html>');
      const err = await exchangeAuthorizationCode(
        { code: 'c', state: 's', verifier: 'v' },
        { fetch },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('bad_response');
    });

    it('refuses a response with no refresh_token instead of writing an access-only credential', async () => {
      // There is no "current" token to fall back on here, so accepting this would strand the
      // account at the access token's first expiry.
      const fetch = fakeFetch(200, JSON.stringify({ access_token: 'a', expires_in: 60 }));
      const err = await exchangeAuthorizationCode(
        { code: 'c', state: 's', verifier: 'v' },
        { fetch },
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RefreshError);
      expect(err).not.toBeInstanceOf(QuarantineError);
      expect((err as RefreshError).code).toBe('bad_response');
    });
  });
});
