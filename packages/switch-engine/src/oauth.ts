// OAuth token refresh + authorization-code (PKCE) exchange.
//
// Anthropic refresh tokens are single-use and rotating: each successful refresh returns a
// NEW refresh token and invalidates the old one. The switch engine must therefore persist
// the rotated token immediately (see SwitchEngine.activate) — a stale copy is already dead.
// A hard `invalid_grant` means the token is permanently spent and the account must be
// quarantined; anything else (network, 5xx) is transient and safe to retry later. That rotation
// is also why a REPEATED refresh cannot be read the same way — see refreshCredentials.
//
// The authorization-code half powers headless re-login (`cctl accounts reauth`, phone
// `/reauth`): mint a PKCE pair, hand the user an authorize URL, and exchange the code they
// paste back for a fresh token set. The verifier NEVER leaves the minting process — that is
// the whole security posture that makes relaying the pasted code through Discord safe.
// CRITICALLY, a failed code exchange must never throw QuarantineError: quarantine means
// "this account's stored REFRESH token is dead", which a bad/expired/reused authorization
// code (a fresh-login artifact) can never establish. Only refreshCredentials may quarantine.
//
// The endpoint URLs, client id, and exact request/response shapes are reverse-
// engineered from the CLI and MUST be confirmed against a real refresh/exchange before
// trusting. Everything here is injectable so tests never hit the network.
// See docs/VERIFICATION.md.

import { createHash, randomBytes } from 'node:crypto';
import type { ClaudeOauth, OauthAccount } from './types.js';
import { QuarantineError, RefreshError } from './errors.js';
import {
  describeStatus,
  withOverloadRetry,
  LOCKED_OVERLOAD_BUDGET_CAP_MS,
  OVERLOAD_STATUSES,
  type OverloadRetryDeps,
  type StatusVerdict,
} from './overload.js';

/** The public OAuth client id the Claude Code CLI presents. Override if verification shows
 *  a different value. */
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Best-known token endpoint; confirm against the live service. */
export const DEFAULT_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/** Refresh below this remaining access-token lifetime. */
export const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Hard ceiling on the refresh network call. A hung token endpoint aborts here and surfaces as
 *  a TRANSIENT {@link RefreshError} (safe to retry) rather than pinning the switch engine's
 *  credential lock; invalid_grant → {@link QuarantineError} semantics are unaffected because
 *  they only apply to a completed non-2xx response. */
export const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;

type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  /** Optional so a test double stays two fields wide; a real `Response` satisfies it, which is
   *  what lets the overload retry honor a `Retry-After` in production. */
  headers?: { get(name: string): string | null | undefined };
  /** Same reasoning: a real `Response` satisfies it, which is what lets an answer the retry
   *  loop discards release its socket instead of holding it until the collector notices. */
  body?: { cancel?: () => unknown } | null;
}>;

export interface RefreshDeps {
  fetch?: FetchLike;
  clientId?: string;
  tokenEndpoint?: string;
  now?: () => number;
  /** Extra headers if verification shows the endpoint requires them (e.g. an anthropic-beta). */
  extraHeaders?: Record<string, string>;
  /** Clock/sleep/jitter and the status-page probe used when the endpoint answers 529. Defaults
   *  are the real ones, so production needs no wiring; tests inject to keep the suite instant. */
  overload?: OverloadRetryDeps;
}

/**
 * Exchange the current refresh token for a fresh credential. Returns a new {@link ClaudeOauth}
 * carrying the rotated tokens; the caller MUST persist it before the old token is lost.
 *
 * An OVERLOADED token endpoint (529) is retried in place for a few seconds — see
 * {@link withOverloadRetry} for why that budget is deliberately small — and only becomes a
 * {@link RefreshError} once the budget is spent. Its message names the status page's verdict,
 * because that message is what a stranded user ends up reading.
 *
 * @throws {QuarantineError} the token is permanently dead (`invalid_grant`) — only on an
 *   attempt that was not preceded by a retry of this same, non-idempotent request.
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
  let attempts = 1;
  let retried = false;
  let statusVerdict: StatusVerdict | undefined;
  try {
    // Each attempt builds its own request (a fresh abort signal above all — a reused, already
    // fired one would abort the retry the instant it started).
    const outcome = await withOverloadRetry(
      (ctx) =>
        doFetch(deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT, {
          method: 'POST',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
            ...deps.extraHeaders,
          },
          body,
          // A timeout rejects into this catch as a transient RefreshError, never a
          // QuarantineError — and, because it is a throw rather than a status, it is never
          // retried here: a hung endpoint is a different failure from an overloaded one.
          // The retry deadline rides along with it so the LAST attempt cannot outlive the
          // budget: this whole call runs inside the credential lock, and a lock held past its
          // stale window is reclaimed mid-refresh by the next process that wants it.
          signal: AbortSignal.any([AbortSignal.timeout(DEFAULT_REFRESH_TIMEOUT_MS), ctx.signal]),
        }),
      // Retries here lengthen a lock hold that everything else queues behind, so they get the
      // locked caller's tighter cap rather than the poller-sized budget.
      { budgetCapMs: LOCKED_OVERLOAD_BUDGET_CAP_MS, ...deps.overload },
    );
    res = outcome.response;
    attempts = outcome.retries + 1;
    retried = outcome.retries > 0;
    statusVerdict = outcome.verdict;
  } catch (err) {
    throw new RefreshError('network error during token refresh', 'network', { cause: err });
  }

  const raw = await res.text();
  if (!res.ok) {
    // A 400 mentioning invalid_grant is the permanent-death signal; everything else is transient.
    //
    // Unless we RETRIED to get here. The token exchange is not idempotent: the refresh token is
    // single-use and rotates, so a 529 emitted after the service already accepted the request
    // leaves the next identical attempt replaying a token that is legitimately spent. That
    // invalid_grant describes our own retry, not a dead account, and quarantining on it would
    // strand a healthy user behind a re-login card. Report it as transient instead and let the
    // next refresh — a single attempt against a fresh read — establish the truth.
    if (res.status === 400 && /invalid_grant/i.test(raw)) {
      if (retried) {
        throw new RefreshError(
          `refresh token rejected (invalid_grant) after ${attempts} attempts against an ` +
            `overloaded endpoint; treating as transient because a retried refresh may have ` +
            `replayed an already-rotated token`,
          'invalid_grant_after_retry',
        );
      }
      throw new QuarantineError(`refresh token rejected (invalid_grant): ${truncate(raw)}`);
    }
    // Still overloaded after the whole budget. Keep the `http_<status>` code (callers branch on
    // it to avoid punishing an account for a fleet-wide outage) but say so in words, and skip
    // the response body: the useful fact is the outage, not whatever the load shedder wrote.
    if (OVERLOAD_STATUSES.has(res.status)) {
      throw new RefreshError(
        `token endpoint overloaded (${res.status}) after ${attempts} attempts; ` +
          `status.claude.com: ${describeStatus(statusVerdict)}`,
        `http_${res.status}`,
      );
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

// ---------------------------------------------------------------------------
// Authorization-code + PKCE flow (headless re-login)
// ---------------------------------------------------------------------------

/** Best-known authorize page; confirm against the live service (docs/VERIFICATION.md). */
export const DEFAULT_AUTHORIZE_ENDPOINT = 'https://claude.ai/oauth/authorize';

/** The display-code callback the CLI's own login flow uses: instead of redirecting to a local
 *  listener, the console renders the authorization code as "<code>#<state>" text for the user
 *  to copy — which is exactly what makes a phone-side login possible (no port on the phone). */
export const DEFAULT_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';

/** The scope set the Claude Code CLI requests at login. */
export const OAUTH_AUTHORIZE_SCOPES = 'org:create_api_key user:profile user:inference';

export interface ExchangeDeps extends RefreshDeps {
  /** Override the redirect_uri presented at authorize + exchange (both must match). */
  redirectUri?: string;
  authorizeEndpoint?: string;
}

/** A fresh PKCE pair. `verifier` must never leave the process that minted it (never on the
 *  wire, never logged); only `challenge` — its one-way S256 hash — rides in the authorize URL. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: 32 random bytes → base64url gives a 43-char verifier (the RFC minimum,
 *  charset already inside the unreserved set), challenge = base64url(sha256(verifier)). */
export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** CSRF/flow-binding state. Independent of the verifier on purpose — state is DESIGNED to be
 *  seen (URL, pasted code); the verifier never is. 16 bytes ≈ 128 bits. */
export function generateState(): string {
  return randomBytes(16).toString('base64url');
}

/** Build the authorize URL the user opens to log in. Pure string building via URLSearchParams
 *  (no hand-rolled concatenation — the space-separated scope must encode exactly once). */
export function buildAuthorizeUrl(
  params: { challenge: string; state: string },
  deps: ExchangeDeps = {},
): string {
  const query = new URLSearchParams({
    // `code=true` selects the display-code flow (the callback page SHOWS the code instead of
    // redirecting a local listener) — reverse-engineered like everything else here.
    code: 'true',
    client_id: deps.clientId ?? CLAUDE_CODE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: deps.redirectUri ?? DEFAULT_REDIRECT_URI,
    scope: OAUTH_AUTHORIZE_SCOPES,
    code_challenge: params.challenge,
    code_challenge_method: 'S256',
    state: params.state,
  });
  return `${deps.authorizeEndpoint ?? DEFAULT_AUTHORIZE_ENDPOINT}?${query.toString()}`;
}

/** Parse the approval page's displayed "<code>#<state>" text as the user pasted it. Trims and
 *  splits on the LAST '#': the state half is ours (base64url, '#'-free) while the code half is
 *  opaque. Returns undefined for anything that doesn't split into two non-empty halves — this
 *  is user-pasted text, so it NEVER throws, and callers get to phrase the error at the
 *  boundary where they can say something useful. */
export function parsePastedCode(raw: string): { code: string; state: string } | undefined {
  const trimmed = raw.trim();
  const hash = trimmed.lastIndexOf('#');
  if (hash <= 0 || hash === trimmed.length - 1) return undefined;
  return { code: trimmed.slice(0, hash), state: trimmed.slice(hash + 1) };
}

/**
 * Exchange a completed authorization-code login for a fresh credential set, plus whatever
 * account identity the response carries (used for the same-account guard; absent identity is
 * tolerated and reported as absent, never invented).
 *
 * Mirrors {@link refreshCredentials}'s posture (injectable fetch, timeout → transient, tolerant
 * mapping) with one DELIBERATE divergence: no failure here is ever a {@link QuarantineError}.
 * A rejected code — including an `invalid_grant`-shaped 400, the same wire text refresh treats
 * as permanent death — means only "this one-shot login attempt failed"; it says nothing about
 * the vaulted refresh token this flow exists to replace.
 *
 * @throws {RefreshError} always — codes: 'no_fetch' | 'network' | 'invalid_code' |
 *   `http_<status>` | 'bad_response'.
 */
export async function exchangeAuthorizationCode(
  params: { code: string; state: string; verifier: string },
  deps: ExchangeDeps = {},
): Promise<{ claudeAiOauth: ClaudeOauth; oauthAccount?: OauthAccount }> {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const now = deps.now ?? Date.now;
  if (!doFetch) throw new RefreshError('no fetch implementation available', 'no_fetch');

  // JSON here, unlike refresh's form encoding — matching how the CLI's own login flow calls
  // this grant (reverse-engineered; wet-verify per docs/VERIFICATION.md).
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    code: params.code,
    state: params.state,
    client_id: deps.clientId ?? CLAUDE_CODE_CLIENT_ID,
    redirect_uri: deps.redirectUri ?? DEFAULT_REDIRECT_URI,
    code_verifier: params.verifier,
  });

  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(deps.tokenEndpoint ?? DEFAULT_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        ...deps.extraHeaders,
      },
      body,
      signal: AbortSignal.timeout(DEFAULT_REFRESH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new RefreshError('network error during code exchange', 'network', { cause: err });
  }

  const raw = await res.text();
  if (!res.ok) {
    // A 400 is "this code is bad/expired/already used" — the user's to fix with a fresh
    // /reauth, and NEVER grounds to quarantine (see the function comment).
    if (res.status === 400) {
      throw new RefreshError(`authorization code rejected: ${truncate(raw)}`, 'invalid_code');
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
  return mapExchangeResponse(parsed, now());
}

/** Map an exchange response. Reuses {@link mapTokenResponse}'s tolerant field extraction with
 *  one hard divergence: a missing refresh_token is fatal here (there is no "current" token to
 *  fall back to — an access-only credential would strand the account at first expiry). The
 *  response's `account`/`organization` blocks become a minimal {@link OauthAccount}; their
 *  field names are reverse-engineered and unverified, so absence of any (or all) of them
 *  degrades to "no identity reported" rather than an error. */
function mapExchangeResponse(
  parsed: unknown,
  nowMs: number,
): { claudeAiOauth: ClaudeOauth; oauthAccount?: OauthAccount } {
  if (typeof parsed !== 'object' || parsed === null) {
    throw new RefreshError('token response was not an object', 'bad_response');
  }
  const p = parsed as Record<string, unknown>;
  if (typeof p.refresh_token !== 'string') {
    throw new RefreshError('exchange response missing refresh_token', 'bad_response');
  }
  // Delegate the shared field mapping; the placeholder "current" only supplies fallbacks for
  // fields the response omits, and every placeholder value is empty/undefined on purpose.
  const claudeAiOauth = mapTokenResponse(
    { accessToken: '', refreshToken: p.refresh_token, expiresAt: 0 },
    parsed,
    nowMs,
  );

  const account = asRecord(p.account);
  const organization = asRecord(p.organization);
  const oauthAccount: OauthAccount = {
    ...(typeof account?.uuid === 'string' ? { accountUuid: account.uuid } : {}),
    ...(typeof account?.email_address === 'string' ? { emailAddress: account.email_address } : {}),
    ...(typeof organization?.uuid === 'string' ? { organizationUuid: organization.uuid } : {}),
    ...(typeof organization?.name === 'string' ? { organizationName: organization.name } : {}),
  };
  return Object.keys(oauthAccount).length > 0 ? { claudeAiOauth, oauthAccount } : { claudeAiOauth };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
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
  return text.length > max ? text.slice(0, max) + '...' : text;
}
