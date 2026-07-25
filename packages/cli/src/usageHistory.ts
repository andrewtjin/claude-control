// What the pure advisor cannot know: the fleet's MEASURED burn rate and each account's next
// weekly reset when the endpoint has stopped publishing one.
//
// Both answers come from stored snapshot history, so they belong at the edge — the advisor
// stays a pure function of a moment and never touches the database. This module is the seam:
// the functions below are pure over already-read rows, so they are unit-testable without a
// store, and `program.ts` supplies the rows.
//
// Reset prediction. The usage endpoint stops reporting `resets_at` for an account once its
// weekly window closes, and does not republish until the account is used again. The cadence is
// a fixed 7 days anchored per account, so the next reset is the LAST one ever observed
// advanced by whole weeks until it lands in the future. The most recent observation wins
// outright; older ones are never averaged in, because only the newest reading reflects the
// account's current anchor.
//
// Burn measurement. Usage is reported as percent of each account's own limit, so a percent
// delta becomes budget only after scaling by that account's plan weight. Only INCREASES count:
// a drop in percent is a weekly window resetting, i.e. replenishment, never negative burn.

/** One weekly reading of one account, as pulled out of a stored snapshot. */
export interface WeeklyObservation {
  fetchedAtMs: number;
  percent: number;
  /** Epoch ms of the reset the endpoint reported alongside this reading, when it reported one. */
  resetsAtMs?: number;
}

/** One account's history plus the plan weight its percentages scale by. */
export interface AccountHistory {
  accountId: string;
  /** Weekly allowance in Pro-equivalent units. 1 when the plan tier is unknown. */
  weight: number;
  /** Observations in ascending `fetchedAtMs` order. */
  observations: WeeklyObservation[];
}

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

/** Trailing window the burn rate is measured over. Long enough to average out a single idle
 *  evening, short enough that last week's habits do not dominate today's outlook. */
export const BURN_WINDOW_MS = 3 * DAY_MS;

/** How far back to look for the last observed reset. One weekly cycle plus slack: any account
 *  whose window closed within the cadence still has its anchor inside this span, and reading
 *  further back only surfaces anchors that later readings already superseded. */
export const RESET_LOOKBACK_MS = 10 * DAY_MS;

/**
 * Predict an account's next weekly reset from its history, or `undefined` when no reset was
 * ever observed (a brand-new account the daemon has only ever seen dormant). Returns a
 * strictly future timestamp: the caller labels it as predicted, never as observed.
 */
export function predictWeeklyReset(
  observations: WeeklyObservation[],
  nowMs: number,
): number | undefined {
  let anchor: number | undefined;
  for (const observation of observations) {
    if (observation.resetsAtMs !== undefined && Number.isFinite(observation.resetsAtMs)) {
      anchor = observation.resetsAtMs; // ascending order, so the last hit is the newest
    }
  }
  if (anchor === undefined) return undefined;
  if (anchor > nowMs) return anchor;
  // Advance by whole cadences in one step rather than looping: an anchor months stale is a
  // arithmetic problem, not a reason to iterate.
  return anchor + (Math.floor((nowMs - anchor) / WEEK_MS) + 1) * WEEK_MS;
}

/**
 * Measure the fleet's burn over `[sinceMs, nowMs]` in Pro-equivalent units/day, or `undefined`
 * when no account has two readings in the window to difference — an unmeasurable burn is
 * reported as unmeasurable, never as zero (which would read as "nothing is being used").
 */
export function measureBurnUnitsPerDay(
  histories: AccountHistory[],
  sinceMs: number,
  nowMs: number,
): number | undefined {
  const spanDays = (nowMs - sinceMs) / DAY_MS;
  if (spanDays <= 0) return undefined;

  let units = 0;
  let measurable = false;
  for (const history of histories) {
    const inWindow = history.observations.filter((o) => o.fetchedAtMs >= sinceMs);
    if (inWindow.length >= 2) measurable = true;
    for (let i = 1; i < inWindow.length; i += 1) {
      const previous = inWindow[i - 1] as WeeklyObservation;
      const current = inWindow[i] as WeeklyObservation;
      const delta = current.percent - previous.percent;
      // A decrease is the weekly window resetting, not negative usage.
      if (delta > 0) units += (delta / 100) * history.weight;
    }
  }
  return measurable ? units / spanDays : undefined;
}

/** Structural stand-in for a stored usage snapshot row, so this module needs no dependency on
 *  the daemon's store types. */
export interface SnapshotRowLike {
  fetchedAtMs: number;
  json: string;
}

/**
 * Parse stored snapshot rows into weekly observations, ascending by fetch time. A row whose
 * JSON is corrupt or carries no weekly limit is skipped: history is a best-effort record, and
 * one bad row must not blind the whole measurement.
 *
 * Deliberately reads `weekly_all` only. That limit IS the account's overall budget, which is
 * what burn is measured against; `weekly_scoped` meters Fable alone, so differencing it would
 * report a fraction of the real burn as if it were all of it.
 */
export function readWeeklyObservations(rows: SnapshotRowLike[]): WeeklyObservation[] {
  const observations: WeeklyObservation[] = [];
  for (const row of rows) {
    type StoredLimit = { kind?: unknown; percent?: unknown; resetsAt?: unknown };
    let weekly: StoredLimit | undefined;
    try {
      const parsed = JSON.parse(row.json) as { limits?: StoredLimit[] };
      weekly = parsed.limits?.find((l) => l.kind === 'weekly_all');
    } catch {
      continue;
    }
    if (typeof weekly?.percent !== 'number' || !Number.isFinite(weekly.percent)) continue;
    const resetsAtMs = typeof weekly.resetsAt === 'string' ? Date.parse(weekly.resetsAt) : NaN;
    observations.push({
      fetchedAtMs: row.fetchedAtMs,
      percent: weekly.percent,
      ...(Number.isFinite(resetsAtMs) ? { resetsAtMs } : {}),
    });
  }
  return observations.sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
}
