// Cross-account pacing: is combined usage burning faster or slower than the calendar week
// allows?
//
// advisor.ts answers "use which account right now"; timeline.ts answers "when does each
// limit refresh". Neither answers the owner's actual planning question: across every
// registered account, are we on track to land the week with headroom to spare, or heading
// for a wall before the reset? Pacing collapses every account's weekly budget into one
// ratio — used-so-far vs. time-elapsed-so-far — so a single verdict answers it. Pure, like
// its siblings: `nowMs` is a parameter, never read from the clock internally, so the CLI and
// the Discord bot render identical, unit-tested output from the same snapshot.

import { roundPct } from './format.js';
import type { AccountUsageInput, LimitInput } from './types.js';

/** One weekly quota cycle. Every account's weekly budget resets on this cadence, so it is
 *  the fixed denominator "how much of the week is behind us" is measured against. */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Above this ratio, budget is being burned faster than the week is passing — the account(s)
 *  risk hitting a wall before the reset. Below the lower bound, there is headroom to spare. */
const AHEAD_THRESHOLD = 1.15;
const BEHIND_THRESHOLD = 0.85;

/** Treat the combined elapsed-fraction denominator as zero below this — guards the ratio
 *  against a divide-by-near-zero blowup right after a reset, rather than trusting float noise. */
const ELAPSED_EPSILON = 1e-9;

export type PacingVerdict = 'ahead' | 'on-pace' | 'behind' | 'fresh' | 'unknown';

/** One account's contribution to the pacing verdict, or why it has none. Always present in
 *  the result — even a non-contributing account is listed, so a renderer can show why the
 *  aggregate excludes it rather than silently dropping it from view. */
export interface AccountPacing {
  accountId: string;
  label: string;
  /** Percent of the weekly budget used, when known — shown even for a non-contributing
   *  account (e.g. quarantined) so the reader can see what it would have contributed. */
  usedPct?: number;
  /** Percent of the week elapsed against that account's weekly reset, when known. */
  elapsedPct?: number;
  contributing: boolean;
  /** Why this account was excluded from the aggregate. Absent when contributing. */
  reason?: string;
}

/** The aggregate pacing verdict for a moment across every registered account. */
export interface Pacing {
  verdict: PacingVerdict;
  /** sum(used)/sum(elapsed) across contributing accounts. Absent for 'fresh' (denominator
   *  ~0) and 'unknown' (no contributing account at all) — there is nothing to ratio. */
  paceRatio?: number;
  /** Aggregate week-elapsed percent (mean across contributing accounts), 0-100. */
  weekElapsedPct: number;
  /** Aggregate budget-used percent (mean across contributing accounts), 0-100. */
  budgetUsedPct: number;
  /** One human sentence carrying the whole verdict — the line frontends print as-is. */
  headline: string;
  accounts: AccountPacing[];
}

/** Per-account fractions feeding the aggregate, kept separate from the public AccountPacing
 *  shape so the aggregate can sum raw [0,1] fractions while the public shape reports rounded
 *  percents — rounding before summing would drift the aggregate off the true ratio. */
interface Contribution {
  used: number;
  elapsed: number;
}

/**
 * Compute the pacing verdict for a snapshot. Pure and deterministic: same accounts + same
 * `nowMs` always yield the same result. Quarantined accounts and accounts with no usable
 * weekly data are excluded from the aggregate but still appear in `accounts` with a reason,
 * so a renderer can explain why the totals don't cover every registered account.
 */
export function computePacing(accounts: AccountUsageInput[], nowMs: number): Pacing {
  const analyzed = accounts.map((account) => analyzeAccount(account, nowMs));
  const outAccounts = analyzed.map((a) => a.pacing);
  const contributions = analyzed
    .map((a) => a.contribution)
    .filter((c): c is Contribution => c !== undefined);

  if (contributions.length === 0) {
    return {
      verdict: 'unknown',
      weekElapsedPct: 0,
      budgetUsedPct: 0,
      headline: 'No weekly usage data yet - pace unknown.',
      accounts: outAccounts,
    };
  }

  const n = contributions.length;
  const usedSum = contributions.reduce((sum, c) => sum + c.used, 0);
  const elapsedSum = contributions.reduce((sum, c) => sum + c.elapsed, 0);
  const weekElapsedPct = roundPct((elapsedSum / n) * 100);
  const budgetUsedPct = roundPct((usedSum / n) * 100);

  // sum(used)/sum(elapsed) equals mean(used)/mean(elapsed) (the /n cancels) — computed from
  // the sums directly so there is exactly one division, not one per account.
  if (elapsedSum < ELAPSED_EPSILON) {
    return {
      verdict: 'fresh',
      weekElapsedPct,
      budgetUsedPct,
      headline: `${weekElapsedPct}% of the combined week elapsed - just reset, too early to gauge pace.`,
      accounts: outAccounts,
    };
  }

  const paceRatio = usedSum / elapsedSum;
  const verdict: PacingVerdict =
    paceRatio > AHEAD_THRESHOLD ? 'ahead' : paceRatio < BEHIND_THRESHOLD ? 'behind' : 'on-pace';

  return {
    verdict,
    paceRatio,
    weekElapsedPct,
    budgetUsedPct,
    headline: buildHeadline(verdict, weekElapsedPct, budgetUsedPct, paceRatio),
    accounts: outAccounts,
  };
}

/** One account's pacing analysis: its public-facing entry, plus its raw [0,1] contribution
 *  when it has one (undefined when excluded). */
function analyzeAccount(
  account: AccountUsageInput,
  nowMs: number,
): { pacing: AccountPacing; contribution?: Contribution } {
  const limit = weeklyLimitFor(account.limits);
  const { percent, resetsAt } = weeklyFields(limit);
  const usedPct = percent !== undefined ? roundPct(clamp01(percent / 100) * 100) : undefined;
  const elapsedPct = resetsAt !== undefined ? roundPct(elapsedFraction(resetsAt, nowMs) * 100) : undefined;

  if (account.quarantined) {
    return {
      pacing: {
        accountId: account.accountId,
        label: account.label,
        ...(usedPct !== undefined ? { usedPct } : {}),
        ...(elapsedPct !== undefined ? { elapsedPct } : {}),
        contributing: false,
        reason: 'quarantined - excluded from pacing until re-login',
      },
    };
  }

  if (percent === undefined || resetsAt === undefined) {
    return {
      pacing: {
        accountId: account.accountId,
        label: account.label,
        ...(usedPct !== undefined ? { usedPct } : {}),
        ...(elapsedPct !== undefined ? { elapsedPct } : {}),
        contributing: false,
        reason: missingDataReason(limit, percent !== undefined, resetsAt !== undefined),
      },
    };
  }

  // Both narrowed to `number` by the guard above — no assertions needed past this point.
  const used = clamp01(percent / 100);
  const elapsed = elapsedFraction(resetsAt, nowMs);
  return {
    pacing: {
      accountId: account.accountId,
      label: account.label,
      usedPct: roundPct(used * 100),
      elapsedPct: roundPct(elapsed * 100),
      contributing: true,
    },
    contribution: { used, elapsed },
  };
}

/** The limit pacing budgets against: weekly_all, falling back to weekly_scoped only when no
 *  weekly_all entry exists at all (matches the advisor's "weekly is the budget" convention). */
function weeklyLimitFor(limits: LimitInput[]): LimitInput | undefined {
  return limits.find((l) => l.kind === 'weekly_all') ?? limits.find((l) => l.kind === 'weekly_scoped');
}

/** Pull percent/resetsAt off the selected limit, treating a non-finite or absent value as not
 *  reported — the wire declares `percent` required, but a malformed/partial snapshot must not
 *  be trusted just because the type says so. Returns real `undefined`-narrowed fields (not
 *  `NaN`), so every downstream check is a plain `!== undefined`. */
function weeklyFields(limit: LimitInput | undefined): { percent?: number; resetsAt?: number } {
  if (!limit) return {};
  return {
    ...(isFiniteNumber(limit.percent) ? { percent: limit.percent } : {}),
    ...(isFiniteNumber(limit.resetsAt) ? { resetsAt: limit.resetsAt } : {}),
  };
}

/** Why an account with no quarantine flag still failed to contribute. */
function missingDataReason(limit: LimitInput | undefined, hasPercent: boolean, hasReset: boolean): string {
  if (!limit) return 'no weekly limit reported';
  if (!hasPercent && !hasReset) return 'weekly limit missing percent and reset time';
  return hasPercent ? 'weekly limit missing reset time' : 'weekly limit missing percent';
}

/** Fraction of the week elapsed, given when this limit resets. A reset a full week out is
 *  0% elapsed (just reset); a reset landing now is 100% elapsed; a reset already in the past
 *  clamps to 100% rather than going negative — a stale-but-still-informative reading, not an
 *  excluded one (see the module header: pacing treats it as "fully elapsed", not unusable). */
function elapsedFraction(resetsAt: number, nowMs: number): number {
  return clamp01((WEEK_MS - (resetsAt - nowMs)) / WEEK_MS);
}

/** True width-checked runtime guard: the wire's `percent` is typed as a required number, but
 *  a malformed/partial snapshot can still omit it at runtime — never trust the type alone. */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

/** The one-sentence verdict, in the voice frontends print verbatim. ASCII only (no em
 *  dashes) — this is operator-facing runtime copy, not a comment. */
function buildHeadline(
  verdict: 'ahead' | 'behind' | 'on-pace',
  weekElapsedPct: number,
  budgetUsedPct: number,
  paceRatio: number,
): string {
  const ratio = paceRatio.toFixed(1);
  switch (verdict) {
    case 'ahead':
      return (
        `${weekElapsedPct}% of the combined week elapsed, ${budgetUsedPct}% of budget burned - ` +
        `ahead of pace (~${ratio}x): slow down or expect an early wall.`
      );
    case 'behind':
      return (
        `${weekElapsedPct}% elapsed, ${budgetUsedPct}% burned - behind pace (~${ratio}x): ` +
        `headroom to burn faster.`
      );
    case 'on-pace':
      return `on pace (${weekElapsedPct}% elapsed, ${budgetUsedPct}% burned).`;
  }
}
