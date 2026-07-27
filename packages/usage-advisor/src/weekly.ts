// The ONE rule for "which weekly limit is this account's budget, and when does it reset".
//
// Four modules used to answer that question four different ways — pacing picked by array
// order, the advisor picked the minimum reset (past ones included), auto-switch picked the
// maximum percent, and the timeline picked the soonest still-future reset. The Pacing line and
// the Plan line in the same Discord embed could therefore be reasoning about different limits
// and quoting different numbers for one account. This module is the single answer they all
// call, so they cannot drift apart again.
//
// The rule:
//   - PERCENT comes from `weekly_all`: that IS the account's budget. `weekly_scoped` is the
//     Fable-tier SUB-cap — a full scoped cap blocks Fable while the account still has budget
//     for everything else — so it answers only when no `weekly_all` entry reports a percent.
//   - RESET is the soonest still-future reset across BOTH weekly kinds. They are two views of
//     one weekly window and the endpoint stamps them within the same second, so taking either
//     is honest; taking whichever is actually present is what stops a `weekly_all` entry with
//     a null reset from shadowing a `weekly_scoped` entry that has one.
//   - When neither kind carries a future reset, the caller's history-derived PREDICTION stands
//     in, flagged so no renderer can present a prediction as an observation.
//
// Pure: `nowMs` is a parameter, never read from the clock internally.

import type { LimitInput } from './types.js';

/** The account's weekly budget as resolved by the rule above. Fields are absent rather than
 *  defaulted, so a caller can tell "0% used" apart from "no usage reported". */
export interface WeeklyBudget {
  /** Which kind supplied `percent` — `weekly_scoped` means the sub-cap fallback fired. */
  kind: LimitInput['kind'];
  /** Percent of the weekly budget consumed, 0-100. Absent on a malformed snapshot. */
  percent?: number;
  /** Epoch ms of the next weekly reset, observed or predicted. Absent when neither exists. */
  resetsAt?: number;
  /** True when `resetsAt` came from the caller's prediction rather than the endpoint. */
  predicted: boolean;
}

/**
 * Resolve one account's weekly budget. `predictedResetAt` is the caller's history-derived
 * fallback (see `AccountUsageInput.predictedResetAt`); pass `undefined` when there is none.
 * Returns `undefined` only when the account reported no weekly limit whatsoever.
 */
export function selectWeeklyBudget(
  limits: LimitInput[],
  nowMs: number,
  predictedResetAt?: number,
): WeeklyBudget | undefined {
  const weekly = limits.filter((l) => l.kind === 'weekly_all' || l.kind === 'weekly_scoped');
  if (weekly.length === 0) return undefined;

  // `weekly[0]` is defined (the emptiness check above returned), and it only ever answers when
  // no entry reported a percent at all — the budget is then reset-only, not usage-bearing.
  const withPercent = weekly.filter((l) => isFiniteNumber(l.percent));
  const source = withPercent.find((l) => l.kind === 'weekly_all') ?? withPercent[0] ?? weekly[0];
  if (source === undefined) return undefined;

  // A prediction is only a clock if it points forward. A caller handing back a stale one
  // (history that never caught up) is refused here rather than fed to a reset simulation.
  const observed = soonestFutureReset(weekly, nowMs);
  const usablePrediction =
    isFiniteNumber(predictedResetAt) && predictedResetAt > nowMs ? predictedResetAt : undefined;
  const resetsAt = observed ?? usablePrediction;
  return {
    kind: source.kind,
    ...(isFiniteNumber(source.percent) ? { percent: source.percent } : {}),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    predicted: observed === undefined && resetsAt !== undefined,
  };
}

/** Soonest reset strictly in the future across the given limits, or undefined. A reset already
 *  in the past describes a window that has since rolled, so it is never a usable clock. */
function soonestFutureReset(limits: LimitInput[], nowMs: number): number | undefined {
  let best: number | undefined;
  for (const l of limits) {
    if (!isFiniteNumber(l.resetsAt) || l.resetsAt <= nowMs) continue;
    if (best === undefined || l.resetsAt < best) best = l.resetsAt;
  }
  return best;
}

/** The wire declares `percent` required, but a malformed or partial snapshot can still omit
 *  it at runtime — never trust the type alone when the value drives arithmetic. */
function isFiniteNumber(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}
