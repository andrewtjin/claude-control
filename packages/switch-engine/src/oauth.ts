// OAuth token refresh.
//
// Anthropic refresh tokens are single-use and rotating: each successful refresh returns a
// NEW refresh token and invalidates the old one. The switch engine must therefore persist
// the rotated token immediately (see SwitchEngine.activate) — a stale copy is already dead.
// A hard `invalid_grant` means the token is permanently spent and the account must be
// quarantined; anything else (network, 5xx) is transient and safe to retry later.
//
// WET-GATED: the endpoint URL, client id, and exact request/response shape are reverse-
// engineered from the CLI and MUST be confirmed against a real refresh before trusting.
// Everything here is injectable so tests never hit the network. See docs/VERIFICATION.md.

import type { ClaudeOauth } from './types.js';
import { QuarantineError, RefreshError } from './errors.js';

/** The public OAuth client id the Claude Code CLI presents. Override if verification shows
 *  a different value. */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Best-known token endpoint; confirm during wet verification. */
export const DEFAULT_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/** Refresh below this remaining access-token lifetime. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

export interface RefreshDeps {
  fetch?: FetchLike;
  clientId?: string;
  tokenEndpoint?: string;
  now?: () => number;
  /** Extra headers if verification shows the endpoint requires them (e.g. an anthropic-beta). */
  extraHeaders?: Record<string, string>;
}

/**
 * Exchange the current refresh token for a fresh credential. Returns a new {@link ClaudeOauth}
 * carrying the rotated tokens; the caller MUST persist it before the old token is lost.
 *
 * @throws {QuarantineError} the token is permanently dead (`invalid_grant`).
 * @throws {RefreshError} a transient failure (network, non-2xx, malformed response).
 */
export async function refreshCredentials(
  current: ClaudeOauth,
  deps: RefreshDeps = {},
): Promise<ClaudeOauth> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  if (!doFetch) throw new RefreshError('no fetch implementation available', 'no_fetch');

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: current.refreshToken,
    client_id: deps.clientId ?? CLAUDE_CODE_CLIENT_ID,
  }).toString();

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
        ...deps.extraHeaders,
      },
      body,
    });
  } catch (err) {
    throw new RefreshError('network error during token refresh', 'network', { cause: err });
  }

  const raw = await res.text();
  if (!res.ok) {
    // A 400 mentioning invalid_grant is the permanent-death signal; everything else is transient.
    if (res.status === 400 && /invalid_grant/i.test(raw)) {
      throw new QuarantineError(`refresh token rejected (invalid_grant): ${truncate(raw)}`);
    }
    throw new RefreshError(
      `token endpoint returned ${res.status}: ${truncate(raw)}`,
      `http_${res.status}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new RefreshError('token endpoint returned non-JSON', 'bad_response', { cause: err });
  }

  return mapTokenResponse(current, parsed, now());
}

/** Map a raw token response onto a {@link ClaudeOauth}, tolerantly and preserving fields the
 *  endpoint does not echo back (subscriptionType, rateLimitTier). */
function mapTokenResponse(current: ClaudeOauth, parsed: unknown, nowMs: number): ClaudeOauth {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RefreshError('token response was not an object', 'bad_response');
  }
  const p = parsed as Record<string, unknown>;
  const accessToken = p.access_token;
  if (typeof accessToken !== 'string') {
    throw new RefreshError('token response missing access_token', 'bad_response');
  }
  // A rotating provider returns a new refresh_token; if one is somehow absent, keep the
  // current one rather than blanking it.
  const refreshToken = typeof p.refresh_token === 'string' ? p.refresh_token : current.refreshToken;
  const expiresInSec = typeof p.expires_in === 'number' ? p.expires_in : 3600;
  const scopes = typeof p.scope === 'string' ? p.scope.split(' ').filter(Boolean) : current.scopes;

  const next: ClaudeOauth = {
    accessToken,
    refreshToken,
    expiresAt: nowMs + expiresInSec * 1000,
  };
  // Preserve optional fields only when present, to satisfy exactOptionalPropertyTypes.
  if (typeof p.refresh_expires_in === 'number') {
    next.refreshTokenExpiresAt = nowMs + p.refresh_expires_in * 1000;
  } else if (current.refreshTokenExpiresAt !== undefined) {
    next.refreshTokenExpiresAt = current.refreshTokenExpiresAt;
  }
  if (scopes !== undefined) next.scopes = scopes;
  if (current.subscriptionType !== undefined) next.subscriptionType = current.subscriptionType;
  if (current.rateLimitTier !== undefined) next.rateLimitTier = current.rateLimitTier;
  return next;
}

function truncate(text: string, max = 200): string {
  return text.length > max ? text.slice(0, max) + '…' : text;
}
