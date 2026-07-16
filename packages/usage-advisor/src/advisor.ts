// The burn-down optimizer.
//
// Problem: you hold several Claude accounts whose quotas reset on independent clocks. Quota
// that resets unused is wasted. The optimizer's job each moment is to answer "use which
// account now?" so that (a) soon-to-reset unused quota gets burned before it evaporates,
// (b) you don't start fresh work on an account that's about to hit its wall, and (c) an
// exhausted or quarantined account is never recommended.
//
// The core idea is an "at-risk" score: an account with lots of unused quota AND an imminent
// reset is the most valuable to use right now, because that capacity is about to vanish. An
// account with plenty of headroom but a distant reset is best kept in reserve. The scoring
// is deliberately simple and fully documented so its behavior is predictable and tunable.

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

/** Internal per-account analysis, before it becomes an AccountScore. */
interface Analysis {
  input: AccountUsageInput;
  headroomPct: number;
  usable: boolean;
  weeklyResetAt?: number;
  sessionResetAt?: number;
  /** The most at-risk limit: soonest reset that still has meaningful unused quota. */
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

  const analyses = accounts.map((a) => analyze(a, now, cfg));
  const ranking = toRanking(analyses);
  const recommended = pickRecommended(analyses);
  const advisories = buildAdvisories(analyses, recommended, now);

  return {
    recommendedAccountId: recommended?.input.accountId ?? null,
    reason: buildReason(recommended, analyses),
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

  // Find the most at-risk limit: the soonest-resetting one that still has meaningful unused
  // capacity. That unused capacity is what we'd waste by letting it reset.
  let burn: Analysis['burn'];
  for (const limit of input.limits) {
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
        score: Math.round(a.score),
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
  if (a.burn) return `burn now: ${roundPct(a.burn.unusedPct)}% resets soon`;
  if (a.headroomPct < DEFAULTS.riskHeadroomPct) return 'near cap';
  return `${roundPct(a.headroomPct)}% headroom`;
}

function buildAdvisories(
  analyses: Analysis[],
  recommended: Analysis | undefined,
  now: number,
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
    // Burn-before-reset: meaningful unused quota about to evaporate.
    if (a.burn) {
      advisories.push({
        kind: 'burn_before_reset',
        accountId: a.input.accountId,
        message: `Burn ${a.input.label}: ${roundPct(a.burn.unusedPct)}% of its ${limitLabel(a.burn.kind)} quota resets in ${humanizeDuration(a.burn.resetsAt - now)}.`,
        deadlineMs: a.burn.resetsAt,
      });
    }
    // Exhausted (but not quarantined) accounts are worth surfacing so the user knows why
    // they're not being recommended.
    if (!a.usable && !a.input.quarantined) {
      advisories.push({
        kind: 'exhausted',
        accountId: a.input.accountId,
        message: `${a.input.label} is out of quota right now.`,
      });
    }
  }

  // If the live account is exhausted and a healthy one exists, tell the user to switch now.
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
      message: `${active.input.label} is out of quota — switch to ${recommended.input.label}.`,
    });
  }

  // Nothing pressing and at least one account is usable: an explicit all-clear.
  if (advisories.length === 0 && recommended) {
    advisories.push({ kind: 'all_healthy', message: 'All accounts have healthy headroom.' });
  }
  return advisories;
}

/** The recommendation's rationale, keyed to whichever factor decided it. */
function buildReason(recommended: Analysis | undefined, analyses: Analysis[]): string {
  if (!recommended) {
    const anyQuarantined = analyses.some((a) => a.input.quarantined);
    if (analyses.length === 0) return 'No accounts configured.';
    return anyQuarantined
      ? 'No usable account: all are exhausted or quarantined.'
      : 'No usable account: all are out of quota.';
  }
  if (recommended.burn) {
    return `${recommended.input.label}: ${roundPct(recommended.burn.unusedPct)}% of its ${limitLabel(recommended.burn.kind)} quota resets soon — use it now so it isn't wasted.`;
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

function limitLabel(kind: LimitInput['kind']): string {
  switch (kind) {
    case 'session':
      return 'session';
    case 'weekly_all':
      return 'weekly';
    case 'weekly_scoped':
      return 'weekly (scoped)';
  }
}
