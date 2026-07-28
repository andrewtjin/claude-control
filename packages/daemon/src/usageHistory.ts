// What the pure advisor cannot know: the fleet's MEASURED burn rate and each account's next
// weekly reset when the endpoint has stopped publishing one.
//
// Both answers come from stored snapshot history, so they belong at the edge — the advisor
// stays a pure function of a moment and never touches the database. This module is the seam:
// the measurements below are pure over already-read rows, so they are unit-testable without a
// store, and `readFleetHistory` is the one place that pairs them with a reader. The daemon
// calls it once per poll cycle and ships the answers on the snapshot it already sends, which
// is how the phone gets inputs it could never measure for itself; the CLI calls it against
// the same store for its own views.
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

/** The weekly reading pulled out of one serialized snapshot payload. `null` in both fields is
 *  "this payload has no weekly reading", which is a normal shape, not a failure. */
export interface ExtractedWeeklyReading {
  weeklyPercent: number | null;
  weeklyResetsAtMs: number | null;
}

/**
 * Read the weekly figures out of one serialized `AccountUsage` payload.
 *
 * This is the single definition of what a weekly reading IS, and it is called on the WRITE path
 * (the store denormalizes its result into columns as each snapshot is appended) rather than once
 * per row per read. That inversion is the whole point: the same parse that used to run ~13k times
 * every sixty seconds now runs four times, and the read side never sees JSON at all.
 *
 * Deliberately reads `weekly_all` only. That limit IS the account's overall budget, which is what
 * burn is measured against; `weekly_scoped` meters Fable alone, so differencing it would report a
 * fraction of the real burn as if it were all of it.
 *
 * Total by construction: corrupt JSON, a missing `limits` array, a payload that is a poll-error
 * record rather than a reading, and a non-finite percent all answer "no reading". History is a
 * best-effort record, and one bad payload must never fail the write that carries it.
 */
export function extractWeeklyReading(json: string): ExtractedWeeklyReading {
  const none: ExtractedWeeklyReading = { weeklyPercent: null, weeklyResetsAtMs: null };
  type StoredLimit = { kind?: unknown; percent?: unknown; resetsAt?: unknown };
  let weekly: StoredLimit | undefined;
  try {
    const parsed = JSON.parse(json) as { limits?: StoredLimit[] };
    weekly = parsed.limits?.find((l) => l.kind === 'weekly_all');
  } catch {
    return none;
  }
  if (typeof weekly?.percent !== 'number' || !Number.isFinite(weekly.percent)) return none;
  const resetsAtMs = typeof weekly.resetsAt === 'string' ? Date.parse(weekly.resetsAt) : NaN;
  return {
    weeklyPercent: weekly.percent,
    weeklyResetsAtMs: Number.isFinite(resetsAtMs) ? resetsAtMs : null,
  };
}

/** The slice of the daemon's store these measurements read. Structural so the same code
 *  serves the daemon (which owns the store) and the CLI (which opens it to read the last
 *  poll), without either needing the other's wiring.
 *
 *  Reads observations, NOT snapshot rows: the blob a snapshot also carries is the expensive part
 *  of that table and none of it is used here, so the narrow shape is what keeps a future caller
 *  from quietly putting the parse back on this path. */
export interface UsageHistoryReader {
  listWeeklyObservationsSince(accountId: string, sinceMs: number): WeeklyObservation[];
}

/** Everything history can say about the fleet at one moment. */
export interface FleetHistory {
  /** Next weekly reset per account, for the accounts history can predict one for. An account
   *  with no observed reset in the lookback is ABSENT rather than defaulted — it has no
   *  known clock, and every consumer says so instead of inventing one. */
  predictedResetByAccount: Map<string, number>;
  /** Fleet burn in Pro-equivalent units/day. Absent = not measurable, never zero. */
  burnUnitsPerDay?: number;
}

/**
 * Read both history-derived measurements for a fleet in one pass. Pure apart from `reader`,
 * and `nowMs` is a parameter, so a caller with a fake reader gets fully deterministic answers.
 */
export function readFleetHistory(
  reader: UsageHistoryReader,
  accounts: ReadonlyArray<{ accountId: string; weight?: number }>,
  nowMs: number,
): FleetHistory {
  const predictedResetByAccount = new Map<string, number>();
  const histories: AccountHistory[] = [];
  for (const { accountId, weight } of accounts) {
    // One read per account covers both measurements: the reset lookback is the longer of the
    // two windows, and the burn measurement filters the same observations down to its own.
    // Already ascending by `fetchedAtMs` — the store's ORDER BY is served by the index, so the
    // sort this used to do in JS is gone rather than moved.
    const observations = reader.listWeeklyObservationsSince(accountId, nowMs - RESET_LOOKBACK_MS);
    // An unresolved plan tier weighs 1 Pro-equivalent unit — the same fallback pacing applies to
    // capacity, so burn and capacity stay denominated in the same units even for a fleet whose
    // tiers are half known. The pacing renderer states the fallback outright.
    histories.push({
      accountId,
      weight: weight !== undefined && weight > 0 ? weight : 1,
      observations,
    });
    const predicted = predictWeeklyReset(observations, nowMs);
    if (predicted !== undefined) predictedResetByAccount.set(accountId, predicted);
  }
  const burnUnitsPerDay = measureBurnUnitsPerDay(histories, nowMs - BURN_WINDOW_MS, nowMs);
  return {
    predictedResetByAccount,
    ...(burnUnitsPerDay !== undefined ? { burnUnitsPerDay } : {}),
  };
}
