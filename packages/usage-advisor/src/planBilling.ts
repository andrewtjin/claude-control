// The PLAN and BILLING cells, in one place because three surfaces render them.
//
// `cctl accounts list` grew these first and owned them privately. The phone then needed the
// same two facts, and a phone that derives its own billing estimate from the same fields is a
// second implementation that will drift the first time either rule changes — so the derivation
// moved here (pure, no CLI or registry imports) and the terminal, the daemon's wire payload and
// the Discord embeds all call it.
//
// Both labels are DERIVATIONS presented as such. Neither Anthropic endpoint publishes a plan
// size or an invoice date, so "20x" is a capacity proxy read out of an undocumented tier string
// and the billing date is an anniversary rolled forward from the subscription's creation. The
// "?"/"~"/"(est.)" markers are not decoration: they are the difference between a reading and a
// claim, and every caller renders them verbatim.

import { planWeight, type PlanTierSignals } from './planWeight.js';

/** Longest verbatim billing type rendered before elision. Sized for the CLI's BILLING column,
 *  which is the tightest of the three surfaces — an upstream string of unbounded length must
 *  never be what decides the table's width. */
const MAX_BILLING_CHARS = 16;

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The billing-side fields, structurally typed so this module never imports the registry's
 *  `StoredAccount` — that would point usage-advisor at switch-engine for two strings. */
export interface BillingSignals {
  billingType?: string;
  subscriptionCreatedAt?: string;
  claudeCodeTrialEndsAt?: string;
}

/** "Aug 15" from an epoch ms, in UTC (the source timestamps are all UTC ISO strings). */
function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

function truncate(value: string): string {
  return value.length <= MAX_BILLING_CHARS ? value : `${value.slice(0, MAX_BILLING_CHARS - 3)}...`;
}

/** Days in a given UTC month. Day 0 of the NEXT month is the last day of this one. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/** The compact plan-tier cell: the relative capacity weight from `planWeight()`, e.g. "20x", or
 *  "?" when no signal let us derive one — the account still gets weight 1 in any aggregate math,
 *  but every surface must SAY so rather than implying we KNOW it's 1x (silent equal-weighting is
 *  exactly the bug `planWeight` exists to fix). */
export function planLabel(signals: PlanTierSignals): string {
  const result = planWeight(signals);
  return result.known ? `${result.weight}x` : '?';
}

/**
 * Estimate the next monthly billing anniversary from `subscriptionCreatedAt`, rolled forward
 * to the first occurrence strictly after `nowMs`. This is a DERIVATION, not an authoritative
 * invoice date — no endpoint exposes one — so every caller must render it with an "est."/"~"
 * marker, never as a bare fact.
 *
 * Each candidate is built from the ORIGINAL date plus a month offset, never by mutating the
 * previous candidate. Cumulative `setUTCMonth` would let a short month permanently corrupt the
 * day: a Jan 31 subscription overflows to Mar 3 crossing February, and every later step then
 * rolls from the 3rd, so the estimate drifts weeks away from the true anniversary and never
 * recovers. The day is clamped to the target month's length instead (Jan 31 -> Feb 28), which
 * is also what a monthly subscription actually does.
 */
export function estimateNextBillingMs(
  subscriptionCreatedAtIso: string,
  nowMs: number,
): number | undefined {
  const created = new Date(subscriptionCreatedAtIso);
  if (Number.isNaN(created.getTime())) return undefined;
  // The loop below terminates by walking candidates PAST `nowMs`; a non-finite one makes that
  // comparison unsatisfiable and would hang the caller rather than fail.
  if (!Number.isFinite(nowMs)) return undefined;

  const year = created.getUTCFullYear();
  const month = created.getUTCMonth();
  const day = created.getUTCDate();

  // Bounded: each step advances one month from a fixed origin, so this terminates as soon as
  // the candidate passes `nowMs` regardless of how old the subscription is.
  for (let offset = 0; ; offset++) {
    const target = new Date(Date.UTC(year, month + offset, 1));
    const clampedDay = Math.min(day, daysInUtcMonth(target.getUTCFullYear(), target.getUTCMonth()));
    const candidate = Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      clampedDay,
      created.getUTCHours(),
      created.getUTCMinutes(),
      created.getUTCSeconds(),
      created.getUTCMilliseconds(),
    );
    if (candidate > nowMs) return candidate;
  }
}

/** The compact billing cell: a live trial's end date takes priority (there's no subscription to
 *  bill yet), then a `stripe_subscription`-derived estimate, then an honest "unknown" for any
 *  other or absent `billingType` — never a fabricated date for a billing type we haven't seen. */
export function billingLabel(account: BillingSignals, nowMs: number): string {
  if (account.claudeCodeTrialEndsAt !== undefined) {
    const trialEndMs = Date.parse(account.claudeCodeTrialEndsAt);
    if (!Number.isNaN(trialEndMs) && trialEndMs > nowMs) {
      return `trial->${formatMonthDay(trialEndMs)}`;
    }
  }
  if (account.billingType === undefined) return 'unknown';
  // Anything other than the known recurring type is shown verbatim rather than guessed at,
  // since we don't know how (or whether) it recurs monthly — but it is upstream text of
  // unbounded length, so it is elided to keep one odd value from stretching a column.
  if (account.billingType !== 'stripe_subscription') return truncate(account.billingType);
  if (account.subscriptionCreatedAt === undefined) return 'unknown';
  const nextMs = estimateNextBillingMs(account.subscriptionCreatedAt, nowMs);
  return nextMs === undefined ? 'unknown' : `~${formatMonthDay(nextMs)} (est.)`;
}
