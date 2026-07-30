// Relative plan-capacity weight — the missing denominator for cross-account aggregation.
//
// THE PROBLEM: the usage endpoint reports `percent` of an account's OWN limit; the payload
// never carries an absolute allowance. Summing or averaging `percent` across accounts on
// different plans (e.g. a Pro account and a Max 20x account) silently treats their quota as
// equal, which is wrong by up to 20x. Every cross-account aggregate has this bug; it stays
// invisible whenever every account on a machine happens to be the same plan.
//
// THE FIX is a relative WEIGHT, not an absolute number: Anthropic's published plan ratios
// (Pro = 1x baseline, Max 5x, Max 20x) used as a capacity PROXY. This is honest, not exact —
// correct in ORDERING (a 20x account can absorb ~20x the burn of a Pro account), approximate
// in MAGNITUDE (nothing here claims to be a measured allowance).
//
// SIGNAL SOURCES, in precedence order (strongest first):
//   1. `organizationRateLimitTier` — the org-wide plan tier, e.g. "default_claude_max_20x".
//      Preferred first because it is the tier the ORGANIZATION is billed under, which is what
//      actually gates capacity for a seat inside it.
//   2. `rateLimitTier` — the account's own credential-reported tier, same string family.
//      Used when there's no org tier to read (e.g. a personal, non-org account).
//   3. `subscriptionType` — e.g. "max". The weakest signal: it names the PRODUCT but carries
//      no multiplier, so "max" alone cannot distinguish 5x from 20x.
// Both (1) and (2) carry the multiplier as a literal substring (e.g. "_20x"); (3) never does.
//
// PARSING IS DEFENSIVE ON PURPOSE: these tier strings are undocumented, and the provider is
// free to add spellings and suffixes at any time. Matching a `<digits>x` token (or a bare
// "pro") out of whatever string arrives is far safer than hard-coding an enum of every tier
// spelling Anthropic might use — an enum would silently misclassify the first unseen variant
// instead of degrading visibly.

/** The signals `planWeight` reads, in precedence order. All optional: an account predating
 *  this capture, or a provider response missing a field, must still produce a usable result. */
export interface PlanTierSignals {
  organizationRateLimitTier?: string;
  rateLimitTier?: string;
  subscriptionType?: string;
}

/** Which signal (if any) actually produced the weight. `'none'` means no signal was even
 *  present to try. */
export type PlanWeightSource =
  'organizationRateLimitTier' | 'rateLimitTier' | 'subscriptionType' | 'none';

export interface PlanWeightResult {
  /** Relative capacity weight; 1 = the Pro baseline. Use this to scale `percent` before
   *  summing/averaging across accounts — never sum raw percentages across different weights. */
  weight: number;
  /** False means `weight` is a DEFAULT (1), not a derived fact — the caller must render this
   *  visibly (e.g. "plan: unknown, showing as 1x") rather than silently equal-weighting, which
   *  is the exact bug this function exists to fix. */
  known: boolean;
  /** Which signal was used (or, when `known` is false, which one was tried last). */
  source: PlanWeightSource;
  /** The raw tier string that produced (or failed to produce) the result, for display/debugging. */
  raw?: string;
  /** Present only when `known` is false — a human-readable note explaining the fallback. */
  reason?: string;
}

/** Signals tried in order, paired with the field name reported back to the caller. */
const SIGNAL_ORDER: ReadonlyArray<{ key: keyof PlanTierSignals; source: PlanWeightSource }> = [
  { key: 'organizationRateLimitTier', source: 'organizationRateLimitTier' },
  { key: 'rateLimitTier', source: 'rateLimitTier' },
  { key: 'subscriptionType', source: 'subscriptionType' },
];

/** Split a tier string on non-alphanumeric separators. Tier strings are snake_case
 *  ("default_claude_max_20x"), and `_` is itself a word character — so a `\b` regex boundary
 *  does NOT exist between "x" and a following "_". Every matcher below tokenizes through this
 *  instead of relying on `\b`, which would silently miss suffixed variants like
 *  "default_claude_max_20x_v2" — an account the multiplier is present in but unreadable from. */
function tokenize(raw: string): string[] {
  return raw.toLowerCase().split(/[^a-z0-9]+/);
}

/** Pull a `<digits>x` multiplier out of a tier string, e.g. "default_claude_max_20x" -> 20.
 *  Anchored to a whole token so it reads the multiplier wherever it sits in the string and
 *  whatever follows it. Returns `undefined` if no token is a bare `<digits>x`. */
function extractMultiplier(raw: string): number | undefined {
  for (const token of tokenize(raw)) {
    const match = /^(\d+)x$/.exec(token);
    if (!match) continue;
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

/** True if the string names the Pro plan outright. Pro has no published multiplier variants,
 *  so recognizing the word is enough to assign the 1x baseline with confidence. Matching the
 *  whole token (not a substring) keeps this from misfiring on an unrelated word merely
 *  containing "pro" (e.g. "professional"). */
function isProBaseline(raw: string): boolean {
  return tokenize(raw).includes('pro');
}

/**
 * Derive a relative capacity weight from whatever plan-tier signals are available, in the
 * documented precedence order. Never throws, never returns a weight for an unrecognized or
 * absent signal without also flagging `known: false` — see the file header for why silent
 * equal-weighting is exactly the bug this exists to prevent.
 */
export function planWeight(signals: PlanTierSignals): PlanWeightResult {
  let lastTried: { source: PlanWeightSource; raw: string } | undefined;

  for (const { key, source } of SIGNAL_ORDER) {
    const raw = signals[key];
    if (typeof raw !== 'string' || raw.trim() === '') continue;

    const multiplier = extractMultiplier(raw);
    if (multiplier !== undefined) return { weight: multiplier, known: true, source, raw };

    if (isProBaseline(raw)) return { weight: 1, known: true, source, raw };

    // This signal existed but named neither a multiplier nor "pro" — keep it as the best
    // available explanation and fall through to the next, weaker signal rather than giving up.
    lastTried = { source, raw };
  }

  return {
    weight: 1,
    known: false,
    source: lastTried?.source ?? 'none',
    ...(lastTried ? { raw: lastTried.raw } : {}),
    reason: lastTried
      ? `unrecognized plan tier "${lastTried.raw}" (from ${lastTried.source}); treating as 1x baseline`
      : 'no plan tier signal available; treating as 1x baseline',
  };
}
