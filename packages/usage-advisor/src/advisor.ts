// The burn-down optimizer.
//
// Problem: you hold several Claude accounts whose quotas reset on independent clocks. Quota
// that resets unused is wasted. The optimizer's job each moment is to answer "use which
// account now?" so that (a) soon-to-reset unused quota gets burned before it evaporates,
// (b) you don't start fresh work on an account that's about to hit its wall, and (c) an
// exhausted or quarantined account is never recommended.
//
// Only WEEKLY quota is burnable scarcity. A 5h session window is rolling: when it resets,
// nothing is lost — the same capacity comes right back. When a weekly limit resets, every
// unused percent evaporates for good. So an account with an empty session window but a
// distant weekly reset is a RESERVE (its budget is safe for days), never a burn target —
// the same owner ruling the auto-switch policy encodes ("weekly is the budget; the 5h
// window is only a gate"). Session limits still bind headroom and exhaustion.
//
// The plan's single `reason` line carries the whole story — the burn order (soonest-expiring
// weekly budget first) and who to hold in reserve — so frontends render ONE compact line,
// not a recommendation heading plus a per-account advisory list.

import { humanizeDuration, roundPct } from './format.js';
import type {
  AccountScore,
  AccountUsageInput,
  Advisory,
  AdvisorOptions,
  LimitInput,
  UsagePlan,
} from './types.js';

// Defaults, chosen for the 5-hour session + weekly cadence of Claude subscriptions.
const DEFAULTS = {
  urgentWindowMs: 24 * 60 * 60 * 1000, // resets within a day are "imminent"
  significantUnusedPct: 15, // don't fuss over burning the last few percent
  riskHeadroomPct: 15, // below this, an account is near its cap
  minUsableHeadroomPct: 2, // below this, treat as exhausted
};

// Weights turning the model's factors into one comparable score. Urgency dominates headroom
// on purpose: burning about-to-reset quota is the whole point.
const URGENCY_WEIGHT = 2;
const RISK_WEIGHT = 3;

// An unusable account scores -Infinity internally so it can never be picked, but JSON has no
// representation for it: `JSON.stringify(-Infinity)` is the string "null", which a numeric wire
// field rejects — taking the WHOLE plan frame down with it, not just the one account. The
// ranking therefore serializes non-finite scores as this finite floor. Nothing renders a score
// (it exists only to sort), so the magnitude just has to stay below every reachable usable
// score, which MIN_SAFE_INTEGER does unconditionally and no weight change can catch up to.
const UNUSABLE_WIRE_SCORE = Number.MIN_SAFE_INTEGER;

/** Internal per-account analysis, before it becomes an AccountScore. */
interface Analysis {
  input: AccountUsageInput;
  headroomPct: number;
  usable: boolean;
  weeklyResetAt?: number;
  sessionResetAt?: number;
  /** The most at-risk WEEKLY limit: soonest reset with meaningful unused quota. Session
   *  limits never appear here — a session reset wastes nothing (see module header). */
  burn?: { unusedPct: number; resetsAt: number; kind: LimitInput['kind']; urgency: number };
  score: number;
}

/**
 * Compute the plan for the current moment. Pure and deterministic: same inputs + same `now`
 * always yield the same plan. Accounts are never mutated.
 */
export function computePlan(
  accounts: AccountUsageInput[],
  options: AdvisorOptions = {},
): UsagePlan {
  const now = options.now?.() ?? Date.now();
  const cfg = {
    urgentWindowMs: options.urgentWindowMs ?? DEFAULTS.urgentWindowMs,
    significantUnusedPct: options.significantUnusedPct ?? DEFAULTS.significantUnusedPct,
    riskHeadroomPct: options.riskHeadroomPct ?? DEFAULTS.riskHeadroomPct,
    minUsableHeadroomPct: options.minUsableHeadroomPct ?? DEFAULTS.minUsableHeadroomPct,
  };

  const greedy = options.greedyAutoSwitch === true;
  const analyses = accounts.map((a) => analyze(a, now, cfg));
  const ranking = toRanking(analyses);
  // The burn queue: every usable account whose weekly budget is expiring soon, soonest
  // expiry first (ties by label for determinism). This IS the plan — burn down the queue.
  const burns = analyses
    .filter((a) => a.usable && a.burn)
    .sort(
      (a, b) =>
        (a.burn as NonNullable<Analysis['burn']>).resetsAt -
          (b.burn as NonNullable<Analysis['burn']>).resetsAt ||
        a.input.label.localeCompare(b.input.label),
    );
  // Head of the burn queue wins outright — an expiring weekly budget outranks any amount of
  // headroom elsewhere (headroom keeps; expiring budget doesn't). Even if its session window
  // is nearly shut, it is still the right TARGET: the window reopens within hours while the
  // weekly budget is still evaporating. No burns → most headroom wins, as before.
  const recommended = burns[0] ?? pickRecommended(analyses);
  const advisories = buildAdvisories(analyses, recommended, burns.length > 0, greedy);

  return {
    recommendedAccountId: recommended?.input.accountId ?? null,
    reason: buildReason(recommended, analyses, burns, greedy, now),
    ranking,
    advisories,
    generatedAtMs: now,
  };
}

type Config = typeof DEFAULTS;

/** Score one account: headroom, minus a near-cap risk penalty, plus a burn-urgency bonus. */
function analyze(input: AccountUsageInput, now: number, cfg: Config): Analysis {
  // Headroom is set by the MOST-constrained limit — the one closest to its cap binds the
  // account. With no limits reported we optimistically assume full capacity.
  const headroomPct =
    input.limits.length === 0
      ? 100
      : Math.min(...input.limits.map((l) => 100 - clampPct(l.percent)));

  const weeklyResetAt = nearestResetOfKind(input.limits, ['weekly_all', 'weekly_scoped']);
  const sessionResetAt = nearestResetOfKind(input.limits, ['session']);

  // Find the most at-risk WEEKLY limit: the soonest-resetting one that still has meaningful
  // unused capacity. That unused capacity is what we'd waste by letting it reset. Session
  // limits are skipped on purpose: a session reset restores quota, it never destroys any,
  // so "unused session capacity resetting soon" is not a loss worth chasing.
  let burn: Analysis['burn'];
  for (const limit of input.limits) {
    if (limit.kind === 'session') continue;
    if (limit.resetsAt === undefined) continue;
    const unusedPct = 100 - clampPct(limit.percent);
    if (unusedPct < cfg.significantUnusedPct) continue;
    const msUntil = limit.resetsAt - now;
    if (msUntil <= 0 || msUntil > cfg.urgentWindowMs) continue;
    // Sooner reset => higher fraction => more urgent. Scaled by how much would be wasted.
    const fraction = 1 - msUntil / cfg.urgentWindowMs;
    const urgency = unusedPct * fraction;
    if (!burn || urgency > burn.urgency) {
      burn = { unusedPct, resetsAt: limit.resetsAt, kind: limit.kind, urgency };
    }
  }

  const usable = !input.quarantined && headroomPct >= cfg.minUsableHeadroomPct;
  const riskPenalty =
    headroomPct < cfg.riskHeadroomPct ? (cfg.riskHeadroomPct - headroomPct) * RISK_WEIGHT : 0;
  const urgencyBonus = (burn?.urgency ?? 0) * URGENCY_WEIGHT;
  // Unusable accounts sink below every usable one via -Infinity, so they can never be picked.
  const score = usable ? headroomPct + urgencyBonus - riskPenalty : Number.NEGATIVE_INFINITY;

  const analysis: Analysis = { input, headroomPct, usable, score };
  if (weeklyResetAt !== undefined) analysis.weeklyResetAt = weeklyResetAt;
  if (sessionResetAt !== undefined) analysis.sessionResetAt = sessionResetAt;
  if (burn) analysis.burn = burn;
  return analysis;
}

/** Pick the highest-scoring usable account. Ties break by headroom, then label, for
 *  determinism (never rely on input order or Math.random). */
function pickRecommended(analyses: Analysis[]): Analysis | undefined {
  const usable = analyses.filter((a) => a.usable);
  if (usable.length === 0) return undefined;
  return usable.reduce((best, a) => {
    if (a.score !== best.score) return a.score > best.score ? a : best;
    if (a.headroomPct !== best.headroomPct) return a.headroomPct > best.headroomPct ? a : best;
    return a.input.label <= best.input.label ? a : best;
  });
}

/** Render the ranking, best score first (with the same deterministic tie-break). */
function toRanking(analyses: Analysis[]): AccountScore[] {
  return [...analyses]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.headroomPct !== a.headroomPct) return b.headroomPct - a.headroomPct;
      return a.input.label.localeCompare(b.input.label);
    })
    .map((a) => {
      const score: AccountScore = {
        accountId: a.input.accountId,
        label: a.input.label,
        // Math.round passes -Infinity (and NaN) straight through; clamp before it reaches JSON.
        score: Number.isFinite(a.score) ? Math.round(a.score) : UNUSABLE_WIRE_SCORE,
        headroomPct: roundPct(a.headroomPct),
        note: noteFor(a),
      };
      if (a.weeklyResetAt !== undefined) score.weeklyResetAt = a.weeklyResetAt;
      if (a.sessionResetAt !== undefined) score.sessionResetAt = a.sessionResetAt;
      return score;
    });
}

/** One-line status for an account in the ranking. */
function noteFor(a: Analysis): string {
  if (a.input.quarantined) return 'quarantined — re-login required';
  if (!a.usable) return 'exhausted';
  if (a.burn) return `burn: ${roundPct(a.burn.unusedPct)}% weekly resets soon`;
  if (a.headroomPct < DEFAULTS.riskHeadroomPct) return 'near cap';
  return `${roundPct(a.headroomPct)}% headroom`;
}

/**
 * Only genuinely exceptional conditions get an advisory line: quarantine, exhaustion, and
 * an exhausted ACTIVE account. The burn queue itself is NOT an advisory — it already lives,
 * complete and ordered, in the plan's reason line, and repeating it per-account is exactly
 * the multi-line noise this advisor used to produce.
 */
function buildAdvisories(
  analyses: Analysis[],
  recommended: Analysis | undefined,
  anyBurns: boolean,
  greedy: boolean,
): Advisory[] {
  const advisories: Advisory[] = [];

  for (const a of analyses) {
    if (a.input.quarantined) {
      advisories.push({
        kind: 'quarantined',
        accountId: a.input.accountId,
        message: `${a.input.label} is quarantined — re-login to use it again.`,
      });
      continue;
    }
    // Exhausted (but not quarantined) accounts are worth surfacing so the user knows why
    // they're not being recommended.
    if (!a.usable) {
      advisories.push({
        kind: 'exhausted',
        accountId: a.input.accountId,
        message: `${a.input.label} is out of quota right now.`,
      });
    }
  }

  // If the live account is exhausted and a healthy one exists, say what happens next: with
  // greedy auto-switch running the daemon hops on its own; otherwise the user must act.
  const active = analyses.find((a) => a.input.active);
  if (
    active &&
    !active.usable &&
    recommended &&
    recommended.input.accountId !== active.input.accountId
  ) {
    advisories.push({
      kind: 'switch_now',
      accountId: recommended.input.accountId,
      message: greedy
        ? `${active.input.label} is out of quota — auto-switch will hop to ${recommended.input.label}.`
        : `${active.input.label} is out of quota — switch to ${recommended.input.label}.`,
    });
  }

  // Nothing pressing, nothing to burn, and at least one usable account: an explicit
  // all-clear (suppressed when a burn plan exists — the reason line is the message then).
  if (advisories.length === 0 && !anyBurns && recommended) {
    advisories.push({ kind: 'all_healthy', message: 'All accounts have healthy headroom.' });
  }
  return advisories;
}

/**
 * The single compact advice line. With a burn queue it reads, in full:
 *   "Burn A (48% weekly left, resets in 9h) → B (62% weekly left, in 19h); hold C
 *    (weekly resets in 6d)."
 * — the whole strategy in one sentence: the order to burn expiring weekly budgets, then who
 * to keep in reserve because their budget is safe. With greedy auto-switch on the phrasing
 * turns descriptive ("Greedy auto-switch burns …") since the daemon executes the plan
 * itself. With nothing to burn it falls back to plain most-headroom advice.
 */
function buildReason(
  recommended: Analysis | undefined,
  analyses: Analysis[],
  burns: Analysis[],
  greedy: boolean,
  now: number,
): string {
  if (!recommended) {
    const anyQuarantined = analyses.some((a) => a.input.quarantined);
    if (analyses.length === 0) return 'No accounts configured.';
    return anyQuarantined
      ? 'No usable account: all are exhausted or quarantined.'
      : 'No usable account: all are out of quota.';
  }

  if (burns.length > 0) {
    const queue = burns
      .map((a, i) => {
        const b = a.burn as NonNullable<Analysis['burn']>;
        const left = `${roundPct(b.unusedPct)}% weekly left`;
        const when = humanizeDuration(b.resetsAt - now);
        // First entry spells everything out; later ones drop the repeated words.
        return i === 0
          ? `${a.input.label} (${left}, resets in ${when})`
          : `${a.input.label} (${left}, in ${when})`;
      })
      .join(' → ');
    // Reserves: usable accounts with no expiring budget — say why they're being skipped.
    const holds = analyses
      .filter((a) => a.usable && !a.burn)
      .map((a) =>
        a.weeklyResetAt !== undefined
          ? `${a.input.label} (weekly resets in ${humanizeDuration(a.weeklyResetAt - now)})`
          : a.input.label,
      );
    const holdPart = holds.length > 0 ? `; hold ${holds.join(', ')}` : '';
    return `${greedy ? 'Greedy auto-switch burns' : 'Burn'} ${queue}${holdPart}.`;
  }

  return `${recommended.input.label} has the most available headroom (${roundPct(recommended.headroomPct)}%).`;
}

// ---- small helpers ----

function clampPct(pct: number): number {
  return Math.max(0, Math.min(100, pct));
}

/** The soonest reset among limits of the given kinds, or undefined if none carry a reset. */
function nearestResetOfKind(limits: LimitInput[], kinds: LimitInput['kind'][]): number | undefined {
  const resets = limits
    .filter((l) => kinds.includes(l.kind) && l.resetsAt !== undefined)
    .map((l) => l.resetsAt as number);
  return resets.length ? Math.min(...resets) : undefined;
}
