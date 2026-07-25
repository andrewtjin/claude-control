// Tests for the two history-derived measurements the pure advisor cannot make: predicting a
// dormant account's next weekly reset from the fixed 7-day cadence, and measuring the fleet's
// burn rate from stored snapshots.

import { describe, expect, it } from 'vitest';
import {
  measureBurnUnitsPerDay,
  predictWeeklyReset,
  readWeeklyObservations,
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

describe('readWeeklyObservations', () => {
  const row = (fetchedAtMs: number, limits: unknown): { fetchedAtMs: number; json: string } => ({
    fetchedAtMs,
    json: JSON.stringify({ limits }),
  });

  it('pulls percent and reset off the weekly_all limit, sorted oldest first', () => {
    const observations = readWeeklyObservations([
      row(NOW, [{ kind: 'weekly_all', percent: 60, resetsAt: '2026-07-30T05:00:00.000Z' }]),
      row(NOW - DAY_MS, [{ kind: 'weekly_all', percent: 40 }]),
    ]);
    expect(observations).toEqual([
      { fetchedAtMs: NOW - DAY_MS, percent: 40 },
      { fetchedAtMs: NOW, percent: 60, resetsAtMs: Date.parse('2026-07-30T05:00:00.000Z') },
    ]);
  });

  it('skips a corrupt row instead of blinding the whole measurement', () => {
    const observations = readWeeklyObservations([
      { fetchedAtMs: NOW - DAY_MS, json: 'not json' },
      row(NOW, [{ kind: 'weekly_all', percent: 10 }]),
    ]);
    expect(observations).toHaveLength(1);
    expect(observations[0]?.percent).toBe(10);
  });

  it('skips rows with no weekly_all limit or a non-numeric percent', () => {
    expect(readWeeklyObservations([row(NOW, [{ kind: 'session', percent: 20 }])])).toEqual([]);
    expect(readWeeklyObservations([row(NOW, [{ kind: 'weekly_all' }])])).toEqual([]);
  });

  it('drops an unparseable reset timestamp rather than poisoning the anchor with NaN', () => {
    const observations = readWeeklyObservations([
      row(NOW, [{ kind: 'weekly_all', percent: 10, resetsAt: 'never' }]),
    ]);
    expect(observations[0]?.resetsAtMs).toBeUndefined();
  });
});
