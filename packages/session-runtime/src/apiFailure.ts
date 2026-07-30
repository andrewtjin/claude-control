// Shared vocabulary for "did this session die of a TRANSIENT Anthropic API failure?" —
// the question both auto-continue tiers ask of different inputs. Managed sessions ask it
// of free text (an SDK result's error summary, or a thrown stream error's message);
// hook-observed sessions ask it of the StopFailure hook's already-classified `error_type`.
// One module answers both so the two tiers can never drift on what counts as retryable.
//
// The bias is deliberately asymmetric: a false "transient" costs retry requests against an
// API that keeps failing (bounded by the retry budget), while a false "permanent" strands
// a session a retry would have saved. So the NON-transient guards are narrow and explicit
// (things retrying provably cannot fix: auth, billing, request shape, rate limits), and
// they are checked FIRST so "429 rate limit error" never falls through to the generic
// "error" of a server-error pattern.

/** What kind of transient failure was recognized — display flavor only; every kind is
 *  handled identically (wait, then continue). */
export type TransientFailureKind = 'server_error' | 'overloaded' | 'connection' | 'timeout';

export interface ApiFailureClassification {
  /** True when a retry after a backoff has a real chance of succeeding. */
  transient: boolean;
  /** Present only when `transient` — which recognizer matched. */
  kind?: TransientFailureKind;
  /** True when the failure is the account's own usage/rate limit — never transient (waiting
   *  doesn't help within the window), but also not dead: a different account fixes it. This
   *  is what lets a managed session PARK on an exhausted account instead of failing, to be
   *  resumed by the daemon after an account switch (see managedSession's stall handling). */
  usageLimit?: boolean;
}

const NOT_TRANSIENT: ApiFailureClassification = { transient: false };
const USAGE_LIMIT: ApiFailureClassification = { transient: false, usageLimit: true };

/** The usage/rate-limit vocabulary (HTTP 429, the API's `rate_limit_error`, the CLI's own
 *  "Claude usage limit reached" copy). Split out of {@link PERMANENT_PATTERN} — which it is
 *  still part of, composed below so the two can never drift — because this one permanent
 *  cause has a distinct recovery: not retrying, not giving up, but switching accounts. */
const USAGE_LIMIT_PATTERN: RegExp = new RegExp(
  [/\b429\b/, /rate.?limit/, /usage limit/].map((r) => r.source).join('|'),
  'i',
);

/**
 * Failures that retrying cannot fix, checked before any transient pattern. Rate limits
 * (429) are listed here even though they ARE technically transient: usage limits are the
 * auto-switcher's domain (switch accounts, don't hammer), and auto-continue must never
 * fight it by burning retry turns into an exhausted window.
 */
const PERMANENT_PATTERN: RegExp = new RegExp(
  [
    USAGE_LIMIT_PATTERN,
    /authentication|unauthori[sz]ed|forbidden|invalid.?api.?key|oauth/,
    /billing|credit balance/,
    /invalid.?request|model.?not.?found/,
    /max.?output.?tokens|prompt.?too.?long|context.?limit/,
  ]
    .map((r) => r.source)
    .join('|'),
  'i',
);

/** 529 first: it is the one 5xx-adjacent status with its own vocabulary ("Overloaded"),
 *  and the CLI's own message ("API Error: 529 Overloaded. …") should classify by the more
 *  specific kind rather than the generic server bucket. */
const OVERLOADED_PATTERN = /\b529\b|overloaded/i;

/** The CLI's synthetic give-up messages ("API Error: 500 Internal server error. …"),
 *  HTTP-shaped statuses from SDK/transport errors, and the named 5xx reason phrases.
 *  The status match is anchored to an HTTP-ish context ("API Error: 502", "status 503",
 *  "HTTP 500") rather than any bare 3-digit number, so "line 500 of foo.ts" in an
 *  unrelated error text never reads as a server failure. */
const SERVER_ERROR_PATTERN =
  /(?:api error|http|status(?: code)?)[:\s]+5\d\d\b|internal server error|server error|bad gateway|service unavailable|gateway timeout/i;

/** Mid-response drops and network-level failures — the CLI's own "…mid-response/mid-stream"
 *  wording plus the Node error codes a dead route/socket surfaces through the SDK. */
const CONNECTION_PATTERN =
  /connection closed mid-response|response stalled mid-stream|connection (?:error|refused|reset)|fetch failed|network error|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN/i;

/** Request-level timeouts (408, the CLI's "Request timed out", API_TIMEOUT_MS expiry). */
const TIMEOUT_PATTERN = /\b408\b|request timed out|timed? ?out waiting|api.?timeout/i;

/**
 * Classify a failure's free text (a failed turn's summary, or a thrown stream error's
 * message). Unrecognized text is NOT transient: auto-continue only ever retries failures
 * it can positively name, because the input space here ("anything an error message can
 * say") is unbounded and a retry loop is the wrong default for the unknown.
 */
export function classifyFailureText(text: string): ApiFailureClassification {
  // Usage limits first: they are a subset of PERMANENT_PATTERN, and the generic permanent
  // verdict would erase the one bit (usageLimit) that names their distinct recovery.
  if (USAGE_LIMIT_PATTERN.test(text)) return USAGE_LIMIT;
  if (PERMANENT_PATTERN.test(text)) return NOT_TRANSIENT;
  if (OVERLOADED_PATTERN.test(text)) return { transient: true, kind: 'overloaded' };
  if (SERVER_ERROR_PATTERN.test(text)) return { transient: true, kind: 'server_error' };
  if (CONNECTION_PATTERN.test(text)) return { transient: true, kind: 'connection' };
  if (TIMEOUT_PATTERN.test(text)) return { transient: true, kind: 'timeout' };
  return NOT_TRANSIENT;
}

/**
 * Classify a StopFailure hook's `error_type` — the CLI's own taxonomy for why a turn died
 * (`server_error`, `overloaded`, `rate_limit`, `authentication_failed`, …). `unknown` falls
 * back to the free-text classifier over `error_text` (when given), for the same
 * positively-named-only reason as above.
 */
export function classifyStopFailureType(
  errorType: string,
  errorText?: string,
): ApiFailureClassification {
  switch (errorType) {
    case 'server_error':
      return { transient: true, kind: 'server_error' };
    case 'overloaded':
      return { transient: true, kind: 'overloaded' };
    case 'rate_limit':
      // Same verdict the free-text side gives 429s: not retryable, but recoverable by an
      // account switch — the two tiers must agree on the usageLimit bit like everything else.
      return USAGE_LIMIT;
    default:
      // authentication_failed, oauth_org_not_allowed, billing_error, invalid_request,
      // model_not_found, max_output_tokens — retrying fixes none of them.
      if (errorType === 'unknown' && errorText !== undefined) {
        return classifyFailureText(errorText);
      }
      return NOT_TRANSIENT;
  }
}
