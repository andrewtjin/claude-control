// Tests for the single weekly-limit selection rule every consumer now shares: which kind
// supplies the percent, where the reset comes from, and how a prediction is admitted.

import { describe, expect, it } from 'vitest';
import { selectWeeklyBudget } from './weekly.js';
import type { LimitInput } from './types.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;

describe('selectWeeklyBudget', () => {
  it('returns undefined when the account reports no weekly limit at all', () => {
    expect(selectWeeklyBudget([{ kind: 'session', percent: 40 }], NOW)).toBeUndefined();
    expect(selectWeeklyBudget([], NOW)).toBeUndefined();
  });

  it('takes the percent from weekly_all, the budget, not the Fable sub-cap', () => {
    const budget = selectWeeklyBudget(
      [
        { kind: 'weekly_scoped', percent: 90, resetsAt: NOW + HOUR_MS },
        { kind: 'weekly_all', percent: 30, resetsAt: NOW + HOUR_MS },
      ],
      NOW,
    );
    expect(budget?.kind).toBe('weekly_all');
    expect(budget?.percent).toBe(30);
  });

  it('falls back to weekly_scoped for the percent only when weekly_all reports none', () => {
    const budget = selectWeeklyBudget(
      [
        { kind: 'weekly_all', resetsAt: NOW + HOUR_MS } as unknown as LimitInput,
        { kind: 'weekly_scoped', percent: 25, resetsAt: NOW + HOUR_MS },
      ],
      NOW,
    );
    expect(budget?.kind).toBe('weekly_scoped');
    expect(budget?.percent).toBe(25);
  });

  it('takes the reset from weekly_scoped when the weekly_all entry carries none', () => {
    const budget = selectWeeklyBudget(
      [
        { kind: 'weekly_all', percent: 40 },
        { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 2 * HOUR_MS },
      ],
      NOW,
    );
    expect(budget?.percent).toBe(40);
    expect(budget?.resetsAt).toBe(NOW + 2 * HOUR_MS);
    expect(budget?.predicted).toBe(false);
  });

  it('picks the soonest still-future reset and ignores one already in the past', () => {
    const budget = selectWeeklyBudget(
      [
        { kind: 'weekly_all', percent: 40, resetsAt: NOW - HOUR_MS },
        { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 3 * HOUR_MS },
      ],
      NOW,
    );
    expect(budget?.resetsAt).toBe(NOW + 3 * HOUR_MS);
  });

  it('uses the prediction only when no observed reset is still in the future', () => {
    const predicted = selectWeeklyBudget([{ kind: 'weekly_all', percent: 0 }], NOW, NOW + HOUR_MS);
    expect(predicted?.resetsAt).toBe(NOW + HOUR_MS);
    expect(predicted?.predicted).toBe(true);

    const observed = selectWeeklyBudget(
      [{ kind: 'weekly_all', percent: 0, resetsAt: NOW + 5 * HOUR_MS }],
      NOW,
      NOW + HOUR_MS,
    );
    expect(observed?.resetsAt).toBe(NOW + 5 * HOUR_MS);
    expect(observed?.predicted).toBe(false);
  });

  it('refuses a stale or non-finite prediction rather than simulating a reset in the past', () => {
    expect(
      selectWeeklyBudget([{ kind: 'weekly_all', percent: 0 }], NOW, NOW - 1)?.resetsAt,
    ).toBeUndefined();
    expect(
      selectWeeklyBudget([{ kind: 'weekly_all', percent: 0 }], NOW, NaN)?.resetsAt,
    ).toBeUndefined();
  });

  it('reports the percent even when no clock is available at all', () => {
    const budget = selectWeeklyBudget([{ kind: 'weekly_all', percent: 12 }], NOW);
    expect(budget?.percent).toBe(12);
    expect(budget?.resetsAt).toBeUndefined();
    expect(budget?.predicted).toBe(false);
  });

  it('leaves percent absent on a malformed entry rather than inventing a zero', () => {
    const malformed = { kind: 'weekly_all', resetsAt: NOW + HOUR_MS } as unknown as LimitInput;
    const budget = selectWeeklyBudget([malformed], NOW);
    expect(budget?.percent).toBeUndefined();
    expect(budget?.resetsAt).toBe(NOW + HOUR_MS);
  });
});
