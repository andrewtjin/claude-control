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
// the same rule the auto-switch policy encodes ("weekly is the budget; the 5h
// window is only a gate"). Session limits still bind headroom and exhaustion.
//
// The plan's single `reason` line carries the whole story — the burn order (soonest-expiring
// weekly budget first) and who to hold in reserve — so frontends render ONE compact line,
// not a recommendation heading plus a per-account advisory list.

import { MIN_USABLE_HEADROOM_PCT } from './autoswitch.js';
import { humanizeDuration, roundPct } from './format.js';
import { selectWeeklyBudget } from './weekly.js';
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
  minUsableHeadroomPct: MIN_USABLE_HEADROOM_PCT, // below this, treat as exhausted
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
  /** This account's weekly BUDGET when it is at risk: meaningful unused quota against a reset
   *  that lands inside the urgent window. Never a session limit (a session reset wastes
   *  nothing — see the module header) and never the Fable sub-cap on its own (it is a ceiling
   *  inside the budget, not spendable capacity beside it — see `analyze`). */
  burn?: {
    unusedPct: number;
    resetsAt: number;
    /** Which limit supplied the figures. `weekly_scoped` means the account reported no
     *  `weekly_all` percent at all and the sub-cap is the only weekly reading there is — the
     *  rendered advice says so rather than passing it off as the overall budget. */
    kind: LimitInput['kind'];
    urgency: number;
    /** True when `resetsAt` is predicted from history rather than reported by the endpoint.
     *  Carried so the advice can label it: burning is an ACTION, and an operator taking it
     *  deserves to know the deadline driving it was inferred. */
    predicted: boolean;
  };
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
  // May the plan name this account as somewhere to GO? Under greedy auto-switch the plan text
  // stops being advice and starts describing what the daemon will actually do ("Greedy
  // auto-switch burns A -> B"), so an account the operator excluded from auto-switch must not
  // head the burn queue or be the recommendation — the executor will never hop there, and the
  // line would promise a switch that cannot happen. The account already LIVE is exempt:
  // exclusion bars hops TO an account, and staying where you are needs no hop at all — the
  // same carve-out `decideAutoSwitch` makes by only ever filtering non-active candidates.
  // With greedy off the whole text is advice to a human, who may still switch there by hand,
  // so exclusion only earns a label (see `buildReason`) and changes nothing about eligibility.
  const targetable = (a: Analysis): boolean =>
    !greedy || a.input.active === true || a.input.autoSwitchExcluded !== true;
  // The burn queue: every usable account whose weekly budget is expiring soon, soonest
  // expiry first (ties by label for determinism). This IS the plan — burn down the queue.
  // `dropped` keeps the entries greedy removed, so the advice can still account for them
  // rather than letting an expiring budget disappear from the line (see `buildReason`).
  const burnable = analyses
    .filter((a) => a.usable && a.burn)
    .sort(
      (a, b) =>
        (a.burn as NonNullable<Analysis['burn']>).resetsAt -
          (b.burn as NonNullable<Analysis['burn']>).resetsAt ||
        a.input.label.localeCompare(b.input.label),
    );
  const burns = burnable.filter((a) => targetable(a));
  const dropped = burnable.filter((a) => !targetable(a));
  // Head of the burn queue wins outright — an expiring weekly budget outranks any amount of
  // headroom elsewhere (headroom keeps; expiring budget doesn't). Even if its session window
  // is nearly shut, it is still the right TARGET: the window reopens within hours while the
  // weekly budget is still evaporating. No burns → most headroom wins, as before.
  // There is deliberately no unfiltered fallback: resurrecting an excluded account as the
  // recommendation is exactly the false promise this gate exists to prevent — the advisories
  // would then announce a hop the executor refuses to make.
  const recommended = burns[0] ?? pickRecommended(analyses.filter(targetable));
  const advisories = buildAdvisories(analyses, recommended, burns.length > 0, greedy);

  return {
    recommendedAccountId: recommended?.input.accountId ?? null,
    reason: buildReason(recommended, analyses, burns, dropped, greedy, now),
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

  // The weekly budget — percent used AND the clock it resets on — comes from the one
  // fleet-wide rule (see weekly.ts) so the Plan line and the Pacing line in the same view can
  // never quote different limits for one account.
  const weekly = selectWeeklyBudget(input.limits, now, input.predictedResetAt);
  const weeklyResetAt = weekly?.resetsAt;
  const sessionResetAt = nearestResetOfKind(input.limits, ['session']);

  // The burn candidate: this account's weekly BUDGET, when it still holds meaningful unused
  // capacity and resets soon. That unused capacity is what we'd waste by letting it reset.
  //
  // It reads the budget through `selectWeeklyBudget` instead of scanning the limits itself,
  // and that distinction is load-bearing. A scan sees `weekly_scoped` — the Fable-tier
  // sub-cap — as a second weekly budget standing beside `weekly_all`, and since the sub-cap
  // is the one that lags, it is the one a scan picks. An account 94% through its weekly
  // budget while only 47% through its Fable sub-cap then reports "53% weekly left" and leads
  // the burn queue, making the fleet's most-drained account the recommendation. The sub-cap
  // is a ceiling INSIDE the budget, never budget beside it: with 6% of the week left there is
  // 6% left for Fable too. Only `weekly_all` is spendable capacity, which is exactly the rule
  // weekly.ts already encodes for everyone else.
  //
  // Session limits are out for a different reason: a session reset restores quota, it never
  // destroys any, so "unused session capacity resetting soon" is not a loss worth chasing.
  let burn: Analysis['burn'];
  if (weekly?.percent !== undefined && weekly.resetsAt !== undefined) {
    const unusedPct = 100 - clampPct(weekly.percent);
    const msUntil = weekly.resetsAt - now;
    if (unusedPct >= cfg.significantUnusedPct && msUntil > 0 && msUntil <= cfg.urgentWindowMs) {
      // Sooner reset => higher fraction => more urgent. Scaled by how much would be wasted.
      const fraction = 1 - msUntil / cfg.urgentWindowMs;
      burn = {
        unusedPct,
        resetsAt: weekly.resetsAt,
        kind: weekly.kind,
        urgency: unusedPct * fraction,
        predicted: weekly.predicted,
      };
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
  if (a.burn) return `burn: ${roundPct(a.burn.unusedPct)}% ${budgetWord(a.burn.kind)} resets soon`;
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
  dropped: Analysis[],
  greedy: boolean,
  now: number,
): string {
  if (!recommended) {
    if (analyses.length === 0) return 'No accounts configured.';
    // Greedy can leave the plan without a target while the fleet is perfectly healthy: every
    // usable account is excluded and none of them is the live one. Reporting an outage there
    // would be a plain falsehood — the accounts have quota, auto-switch just may not take it.
    if (analyses.some((a) => a.usable))
      return 'No auto-switch target: every usable account is excluded from auto-switch.';
    const anyQuarantined = analyses.some((a) => a.input.quarantined);
    return anyQuarantined
      ? 'No usable account: all are exhausted or quarantined.'
      : 'No usable account: all are out of quota.';
  }

  // Greedy drops excluded accounts from the queue, and they normally land in the holds below
  // with the label saying why. But when dropping them empties the queue there is no queue
  // sentence left to hold them against, and a budget about to evaporate would vanish from the
  // plan entirely — the one fact exclusion does NOT make irrelevant, since the operator can
  // still burn it by hand. So it is named as manual work instead.
  const manual = burns.length === 0 ? dropped : [];
  const named = burns.length > 0 ? burns : manual;
  if (named.length > 0) {
    // Reserves: usable accounts that are not named in the queue — say why they're being
    // skipped. Membership is judged against the RENDERED queue, not against `burn`, so an
    // account greedy dropped for being excluded lands here (with the label saying why)
    // instead of being listed twice or not at all.
    const holds = analyses
      .filter((a) => a.usable && !named.includes(a))
      .map(
        (a) =>
          (a.weeklyResetAt !== undefined
            ? `${a.input.label} (weekly resets in ${humanizeDuration(a.weeklyResetAt - now)})`
            : a.input.label) + exclusionSuffix(a),
      );
    const holdPart = holds.length > 0 ? `; hold ${holds.join(', ')}` : '';
    const lead =
      burns.length > 0
        ? `${greedy ? 'Greedy auto-switch burns' : 'Burn'} ${renderQueue(burns, now)}`
        : `Burn by hand: ${renderQueue(manual, now)}`;
    return `${lead}${holdPart}.`;
  }

  return `${recommended.input.label} has the most available headroom (${roundPct(recommended.headroomPct)}%)${exclusionSuffix(recommended)}.`;
}

/** Render a burn queue: soonest-expiring budget first, each entry labelled if it is excluded
 *  from auto-switch. The first entry spells everything out; later ones drop the repeated
 *  words, since the sentence has already established what the figures mean. */
function renderQueue(entries: Analysis[], now: number): string {
  return entries
    .map((a, i) => {
      const b = a.burn as NonNullable<Analysis['burn']>;
      const left = `${roundPct(b.unusedPct)}% ${budgetWord(b.kind)} left`;
      const when = `${humanizeDuration(b.resetsAt - now)}${b.predicted ? ' (predicted)' : ''}`;
      return i === 0
        ? `${a.input.label} (${left}, resets in ${when})${exclusionSuffix(a)}`
        : `${a.input.label} (${left}, in ${when})${exclusionSuffix(a)}`;
    })
    .join(' → ');
}

// ---- small helpers ----

/** The label an excluded account carries wherever the plan line names it. Shown whether or not
 *  greedy is on: with greedy on it explains why the account is being held rather than burned,
 *  and with greedy off it warns the human that acting on this advice means switching by hand. */
function exclusionSuffix(a: Analysis): string {
  return a.input.autoSwitchExcluded === true ? ' (excluded from auto-switch)' : '';
}

/** What to CALL the figures a burn entry carries. Normally "weekly", because they came from
 *  the account's overall weekly budget. When the sub-cap had to stand in for a missing
 *  `weekly_all` percent the word changes, matching how the timeline already names that limit —
 *  a reader must never be handed a Fable-only number under the word for the whole budget. */
function budgetWord(kind: LimitInput['kind']): string {
  return kind === 'weekly_scoped' ? 'weekly (fable)' : 'weekly';
}

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
