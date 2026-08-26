import { describe, it, expect } from 'vitest';
import { classifyFailureText, classifyStopFailureType, isStopFailureType } from './apiFailure.js';

describe('classifyFailureText', () => {
  // The CLI's real synthetic give-up messages, verbatim from transcripts — the primary
  // inputs this classifier exists for. If the CLI rewords these, these cases are the canary.
  it.each([
    [
      'API Error: 500 Internal server error. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
      'server_error',
    ],
    [
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment. If it persists, check https://status.claude.com.',
      'overloaded',
    ],
    [
      'API Error: Connection closed mid-response. The response above may be incomplete.',
      'connection',
    ],
    ['API Error: Server error mid-response. The response above may be incomplete.', 'server_error'],
    ['API Error: Response stalled mid-stream. The response above may be incomplete.', 'connection'],
  ])('recognizes the CLI give-up message %#', (text, kind) => {
    expect(classifyFailureText(text)).toEqual({ transient: true, kind });
  });

  it.each([
    ['API Error: 502 Bad gateway', 'server_error'],
    ['API Error: 503 Service unavailable', 'server_error'],
    ['Request failed with status 504', 'server_error'],
    ['HTTP 500 from upstream', 'server_error'],
    ['fetch failed', 'connection'],
    ['read ECONNRESET', 'connection'],
    ['connect ECONNREFUSED 127.0.0.1:443', 'connection'],
    ['getaddrinfo EAI_AGAIN api.anthropic.com', 'connection'],
    ['socket hang up', 'connection'],
    ['API Error: 408 Request timeout', 'timeout'],
    ['Request timed out.', 'timeout'],
  ])('recognizes transport/status failure "%s"', (text, kind) => {
    expect(classifyFailureText(text)).toEqual({ transient: true, kind });
  });

  // Usage/rate limits: never transient (a retry loop must not fight an exhausted window),
  // but flagged usageLimit — the one permanent cause an account switch recovers, which is
  // what lets a managed session park instead of fail.
  it.each([
    'API Error: 429 Rate limit exceeded',
    'You have hit your usage limit.',
    'Claude usage limit reached. Your limit will reset at 3pm.',
    'rate_limit_error: Number of requests has exceeded your per-minute rate limit',
  ])('flags "%s" as a non-transient usage limit', (text) => {
    expect(classifyFailureText(text)).toEqual({ transient: false, usageLimit: true });
  });

  // Failures neither a retry nor an account switch can fix.
  it.each([
    'API Error: 401 Unauthorized',
    'authentication_error: invalid x-api-key',
    'OAuth token has expired',
    'Your credit balance is too low to access the Anthropic API',
    'billing_error: payment required',
    'invalid_request_error: max_tokens is required',
    'model_not_found: claude-nonexistent',
    'prompt too long: 250000 tokens > 200000 maximum',
  ])('never treats "%s" as transient', (text) => {
    expect(classifyFailureText(text)).toEqual({ transient: false });
  });

  // A permanent marker anywhere in the text must win even when transient markers are also
  // present — the guards run first precisely for mixed messages like these.
  it('prefers the permanent classification for mixed messages', () => {
    expect(classifyFailureText('429 rate limit while retrying after server error')).toEqual({
      transient: false,
      usageLimit: true,
    });
  });

  it.each([
    'Error: something else entirely',
    'Session failed: the tool crashed',
    'TypeError: cannot read properties of undefined',
    // A bare 3-digit number in a non-HTTP context must not read as a status code.
    'SyntaxError at line 500 of foo.ts',
    'exit code 503',
    '',
  ])('does not guess on unrecognized text "%s"', (text) => {
    expect(classifyFailureText(text)).toEqual({ transient: false });
  });
});

describe('classifyStopFailureType', () => {
  it.each([
    ['server_error', 'server_error'],
    ['overloaded', 'overloaded'],
  ])('maps error_type %s to a transient kind', (errorType, kind) => {
    expect(classifyStopFailureType(errorType)).toEqual({ transient: true, kind });
  });

  it('gives error_type rate_limit the same usage-limit verdict as the free-text side', () => {
    expect(classifyStopFailureType('rate_limit')).toEqual({ transient: false, usageLimit: true });
  });

  it.each([
    'authentication_failed',
    'oauth_org_not_allowed',
    'billing_error',
    'invalid_request',
    'model_not_found',
    'max_output_tokens',
  ])('treats error_type %s as permanent', (errorType) => {
    expect(classifyStopFailureType(errorType)).toEqual({ transient: false });
  });

  it('falls back to the text classifier for anything the taxonomy does not define', () => {
    expect(classifyStopFailureType('unknown', 'API Error: 500 Internal server error')).toEqual({
      transient: true,
      kind: 'server_error',
    });
    expect(classifyStopFailureType('unknown', 'some novel failure')).toEqual({ transient: false });
    expect(classifyStopFailureType('unknown')).toEqual({ transient: false });
    // A recognized-permanent type never consults the text, even when the text looks transient.
    expect(classifyStopFailureType('billing_error', 'API Error: 500')).toEqual({
      transient: false,
    });
  });

  // The installed CLI puts a whole sentence in the slot the docs promise a token in, so these
  // strings arrive as `errorType` with nothing else alongside. Read as a token they are all
  // "unrecognized", which used to mean permanent — and told the user to go fix an outage.
  it.each([
    ['API Error: 529 Overloaded. Please try again later.', 'overloaded'],
    ['API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}', 'overloaded'],
    ['API Error: 500 Internal server error.', 'server_error'],
  ])('reads the CLI free text %# as a transient death', (text, kind) => {
    expect(classifyStopFailureType(text)).toEqual({ transient: true, kind });
  });

  it('keeps the usage-limit verdict when the free text is a rate limit', () => {
    expect(classifyStopFailureType('API Error: 429 rate_limit_error')).toEqual({
      transient: false,
      usageLimit: true,
    });
  });

  it('still refuses to retry free text naming a cause a retry cannot fix', () => {
    expect(
      classifyStopFailureType('API Error: 401 authentication_error: invalid bearer token'),
    ).toEqual({ transient: false });
  });

  it('prefers the dedicated text field when the payload carries both', () => {
    // `error_text` is the documented home for prose; a token slot holding prose is the fallback,
    // never the winner.
    expect(classifyStopFailureType('unknown', 'API Error: 529 Overloaded.')).toEqual({
      transient: true,
      kind: 'overloaded',
    });
  });
});

describe('isStopFailureType', () => {
  it('separates the taxonomy tokens from the prose that arrives in the same slot', () => {
    // What a card asks before quoting the value as a named cause.
    expect(isStopFailureType('billing_error')).toBe(true);
    expect(isStopFailureType('overloaded')).toBe(true);
    expect(isStopFailureType('unknown')).toBe(false);
    expect(isStopFailureType('API Error: 529 Overloaded. Please try again later.')).toBe(false);
  });
});
