// Tests for the two history-derived measurements the pure advisor cannot make: predicting a
// dormant account's next weekly reset from the fixed 7-day cadence, and measuring the fleet's
// burn rate from stored snapshots.

import { describe, expect, it } from 'vitest';
import {
  extractWeeklyReading,
  measureBurnUnitsPerDay,
  predictWeeklyReset,
  readFleetHistory,
  type WeeklyObservation,
} from './usageHistory.js';

const NOW = Date.parse('2026-07-25T19:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

function observation(fetchedAtMs: number, percent: number, resetsAtMs?: number): WeeklyObservation {
  return { fetchedAtMs, percent, ...(resetsAtMs !== undefined ? { resetsAtMs } : {}) };
}

describe('predictWeeklyReset', () => {
  it('advances the last observed reset by whole weeks until it is in the future', () => {
    const anchor = NOW - 2 * DAY_MS;
    expect(predictWeeklyReset([observation(NOW - 3 * DAY_MS, 40, anchor)], NOW)).toBe(
      anchor + WEEK_MS,
    );
  });

  it('advances by more than one week when the anchor is several cycles stale', () => {
    const anchor = NOW - (2 * WEEK_MS + DAY_MS);
    expect(predictWeeklyReset([observation(NOW - 2 * WEEK_MS, 40, anchor)], NOW)).toBe(
      anchor + 3 * WEEK_MS,
    );
  });

  it('returns a still-future observed reset unchanged', () => {
    const future = NOW + 2 * DAY_MS;
    expect(predictWeeklyReset([observation(NOW - HOUR_MS, 40, future)], NOW)).toBe(future);
  });

  it('takes the NEWEST anchor, so a superseded reading never wins', () => {
    const stale = NOW - 9 * DAY_MS;
    const current = NOW - DAY_MS;
    const predicted = predictWeeklyReset(
      [observation(NOW - 8 * DAY_MS, 80, stale), observation(NOW - 2 * DAY_MS, 0, current)],
      NOW,
    );
    expect(predicted).toBe(current + WEEK_MS);
  });

  it('degrades to undefined when no reset was ever observed', () => {
    expect(predictWeeklyReset([observation(NOW - DAY_MS, 0)], NOW)).toBeUndefined();
    expect(predictWeeklyReset([], NOW)).toBeUndefined();
  });
});

describe('measureBurnUnitsPerDay', () => {
  const since = NOW - 2 * DAY_MS;

  it('scales percent deltas by each account plan weight', () => {
    // 10% of a 20-unit account over 2 days = 2 units = 1 unit/day.
    const burn = measureBurnUnitsPerDay(
      [
        {
          accountId: 'a',
          weight: 20,
          observations: [observation(since, 30), observation(NOW, 40)],
        },
      ],
      since,
      NOW,
    );
    expect(burn).toBeCloseTo(1, 6);
  });

  it('sums across accounts, weighting a Pro account far below a Max 20x one', () => {
    const burn = measureBurnUnitsPerDay(
      [
        {
          accountId: 'pro',
          weight: 1,
          observations: [observation(since, 0), observation(NOW, 50)],
        },
        {
          accountId: 'max',
          weight: 20,
          observations: [observation(since, 0), observation(NOW, 50)],
        },
      ],
      since,
      NOW,
    );
    // 0.5u + 10u over 2 days.
    expect(burn).toBeCloseTo(5.25, 6);
  });

  it('treats a drop in percent as a window reset, never as negative burn', () => {
    const burn = measureBurnUnitsPerDay(
      [
        {
          accountId: 'a',
          weight: 20,
          observations: [
            observation(since, 80),
            observation(since + DAY_MS, 0),
            observation(NOW, 10),
          ],
        },
      ],
      since,
      NOW,
    );
    // Only the +10 after the reset counts: 2 units over 2 days.
    expect(burn).toBeCloseTo(1, 6);
  });

  it('ignores observations older than the window', () => {
    const burn = measureBurnUnitsPerDay(
      [
        {
          accountId: 'a',
          weight: 20,
          observations: [
            observation(since - DAY_MS, 0),
            observation(since, 50),
            observation(NOW, 60),
          ],
        },
      ],
      since,
      NOW,
    );
    expect(burn).toBeCloseTo(1, 6);
  });

  it('reports a measured zero when the fleet was idle all window', () => {
    const burn = measureBurnUnitsPerDay(
      [{ accountId: 'a', weight: 20, observations: [observation(since, 0), observation(NOW, 0)] }],
      since,
      NOW,
    );
    expect(burn).toBe(0);
  });

  it('reports UNMEASURABLE, not zero, when no account has two readings to difference', () => {
    expect(
      measureBurnUnitsPerDay(
        [{ accountId: 'a', weight: 20, observations: [observation(NOW, 40)] }],
        since,
        NOW,
      ),
    ).toBeUndefined();
    expect(measureBurnUnitsPerDay([], since, NOW)).toBeUndefined();
  });

  it('refuses a non-positive window rather than dividing by zero', () => {
    expect(
      measureBurnUnitsPerDay(
        [{ accountId: 'a', weight: 20, observations: [observation(NOW, 0), observation(NOW, 40)] }],
        NOW,
        NOW,
      ),
    ).toBeUndefined();
  });
});

describe('extractWeeklyReading', () => {
  const payload = (limits: unknown): string => JSON.stringify({ limits });

  it('pulls percent and reset off the weekly_all limit', () => {
    expect(
      extractWeeklyReading(
        payload([{ kind: 'weekly_all', percent: 60, resetsAt: '2026-07-30T05:00:00.000Z' }]),
      ),
    ).toEqual({ weeklyPercent: 60, weeklyResetsAtMs: Date.parse('2026-07-30T05:00:00.000Z') });
  });

  it('reads a reading with no reset as a reading, not as an absence', () => {
    expect(extractWeeklyReading(payload([{ kind: 'weekly_all', percent: 40 }]))).toEqual({
      weeklyPercent: 40,
      weeklyResetsAtMs: null,
    });
  });

  it('answers "no reading" for a corrupt payload instead of throwing on the write path', () => {
    // Total by construction: this runs inside insertUsageSnapshot, so a throw here would fail the
    // write carrying the snapshot, not merely lose one observation.
    expect(extractWeeklyReading('not json')).toEqual({
      weeklyPercent: null,
      weeklyResetsAtMs: null,
    });
    expect(extractWeeklyReading('{}')).toEqual({ weeklyPercent: null, weeklyResetsAtMs: null });
  });

  it('answers "no reading" with no weekly_all limit or a non-numeric percent', () => {
    expect(extractWeeklyReading(payload([{ kind: 'session', percent: 20 }])).weeklyPercent).toBe(
      null,
    );
    expect(extractWeeklyReading(payload([{ kind: 'weekly_all' }])).weeklyPercent).toBe(null);
  });

  it('drops an unparseable reset timestamp rather than poisoning the anchor with NaN', () => {
    expect(
      extractWeeklyReading(payload([{ kind: 'weekly_all', percent: 10, resetsAt: 'never' }]))
        .weeklyResetsAtMs,
    ).toBe(null);
  });

  it('reads weekly_all only, never the Fable-scoped meter beside it', () => {
    expect(
      extractWeeklyReading(
        payload([
          { kind: 'weekly_scoped', percent: 99 },
          { kind: 'weekly_all', percent: 12 },
        ]),
      ).weeklyPercent,
    ).toBe(12);
  });
});

describe('readFleetHistory', () => {
  /** Fixtures stay written as the PAYLOAD the endpoint actually returns, then go through the same
   *  `extractWeeklyReading` the store now runs at insert time — so these tests keep covering the
   *  real weekly_all semantics end to end, rather than hand-building the denormalized answer and
   *  asserting against a shape no production write ever produced. */
  const weeklyRow = (
    fetchedAtMs: number,
    percent: number,
    resetsAt?: string,
  ): WeeklyObservation => {
    const reading = extractWeeklyReading(
      JSON.stringify({
        limits: [{ kind: 'weekly_all', percent, ...(resetsAt !== undefined ? { resetsAt } : {}) }],
      }),
    );
    return {
      fetchedAtMs,
      percent: reading.weeklyPercent as number,
      ...(reading.weeklyResetsAtMs !== null ? { resetsAtMs: reading.weeklyResetsAtMs } : {}),
    };
  };

  /** A store stand-in honoring the same `sinceMs` bound and ascending order the real query
   *  applies — the sort is the store's job now, so a reader that returned them shuffled would be
   *  testing a contract the production reader does not have. */
  function reader(rows: Record<string, WeeklyObservation[]>) {
    return {
      listWeeklyObservationsSince: (accountId: string, sinceMs: number) =>
        (rows[accountId] ?? [])
          .filter((r) => r.fetchedAtMs >= sinceMs)
          .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs),
    };
  }

  it('predicts each account from its OWN anchor and measures burn across the fleet', () => {
    const anchor = '2026-07-19T05:00:00.000Z';
    const history = readFleetHistory(
      reader({
        // In use: the endpoint still reports its reset, and usage climbed 20% over 2 days.
        live: [
          weeklyRow(NOW - 2 * DAY_MS, 40, '2026-07-29T05:00:00.000Z'),
          weeklyRow(NOW, 60, '2026-07-29T05:00:00.000Z'),
        ],
        // Dormant: its window closed, so the newest rows carry no reset at all.
        dormant: [weeklyRow(NOW - 9 * DAY_MS, 90, anchor), weeklyRow(NOW - DAY_MS, 0)],
      }),
      [{ accountId: 'live' }, { accountId: 'dormant' }],
      NOW,
    );

    expect(history.predictedResetByAccount.get('dormant')).toBe(Date.parse(anchor) + WEEK_MS);
    expect(history.predictedResetByAccount.get('live')).toBe(
      Date.parse('2026-07-29T05:00:00.000Z'),
    );
    // 20% of a 1-unit account over the 3-day burn window.
    expect(history.burnUnitsPerDay).toBeCloseTo(0.2 / 3, 9);
  });

  it('omits an account with no observed reset instead of inventing a clock for it', () => {
    const history = readFleetHistory(
      reader({ fresh: [weeklyRow(NOW - DAY_MS, 0), weeklyRow(NOW, 0)] }),
      [{ accountId: 'fresh' }],
      NOW,
    );
    expect(history.predictedResetByAccount.has('fresh')).toBe(false);
  });

  // Burn and the capacity it is judged against MUST be denominated in the same units. Measuring
  // a Max 20x account's burn at 1x while pacing sizes its allowance at 20x understates
  // consumption by the plan multiplier, and every fleet then reads as sustainable.
  it('scales measured burn by the account plan weight', () => {
    const rows = { big: [weeklyRow(NOW - 3 * DAY_MS, 0), weeklyRow(NOW, 20)] };
    const atOneX = readFleetHistory(reader(rows), [{ accountId: 'big' }], NOW);
    const atTwentyX = readFleetHistory(reader(rows), [{ accountId: 'big', weight: 20 }], NOW);

    expect(atOneX.burnUnitsPerDay).toBeCloseTo(0.2 / 3, 9);
    expect(atTwentyX.burnUnitsPerDay).toBeCloseTo((0.2 * 20) / 3, 9);
  });

  it('falls back to 1x for an unresolved tier rather than dropping the account', () => {
    // An absent weight is the same fallback pacing applies to capacity, so a half-known fleet
    // still has both sides of the comparison in one unit.
    const rows = { mixed: [weeklyRow(NOW - 3 * DAY_MS, 0), weeklyRow(NOW, 20)] };
    const history = readFleetHistory(reader(rows), [{ accountId: 'mixed', weight: 0 }], NOW);
    expect(history.burnUnitsPerDay).toBeCloseTo(0.2 / 3, 9);
  });

  it('reports an unmeasurable burn as absent, never as zero', () => {
    const history = readFleetHistory(reader({ empty: [] }), [{ accountId: 'empty' }], NOW);
    expect(history.burnUnitsPerDay).toBeUndefined();
    expect(history.predictedResetByAccount.size).toBe(0);
  });
});
