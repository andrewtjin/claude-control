// Tests for cross-account pacing: the aggregate ratio, its verdict bands (and their exact
// boundaries), account-level exclusion/clamping, and the never-NaN headline guarantee.

import { describe, expect, it } from 'vitest';
import { computePacing } from './pacing.js';
import type { AccountUsageInput, LimitInput } from './types.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Convenience account factory with sane defaults, matching timeline.test.ts's convention. */
function account(overrides: Partial<AccountUsageInput> & { accountId: string }): AccountUsageInput {
  return {
    label: overrides.accountId,
    active: false,
    quarantined: false,
    limits: [],
    ...overrides,
  };
}

/** A weekly_all limit whose reset time encodes an exact elapsedFraction, so test numbers can
 *  be reasoned about by hand instead of guessed. */
function weeklyLimit(percent: number, elapsedFraction: number): LimitInput {
  return {
    kind: 'weekly_all',
    percent,
    resetsAt: NOW + Math.round((1 - elapsedFraction) * WEEK_MS),
  };
}

describe('computePacing — verdict bands', () => {
  it('reports ahead of pace when burn outruns elapsed time', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(52, 0.38)] })],
      NOW,
    );
    expect(pacing.verdict).toBe('ahead');
    expect(pacing.weekElapsedPct).toBe(38);
    expect(pacing.budgetUsedPct).toBe(52);
    expect(pacing.paceRatio).toBeCloseTo(52 / 38, 5);
    expect(pacing.headline).toBe(
      '38% of the combined week elapsed, 52% of budget burned - ahead of pace (~1.4x): ' +
        'slow down or expect an early wall.',
    );
  });

  it('reports behind pace when there is headroom to spare', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(41, 0.6)] })],
      NOW,
    );
    expect(pacing.verdict).toBe('behind');
    expect(pacing.headline).toBe(
      '60% elapsed, 41% burned - behind pace (~0.7x): headroom to burn faster.',
    );
  });

  it('reports on pace inside the band', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(49, 0.52)] })],
      NOW,
    );
    expect(pacing.verdict).toBe('on-pace');
    expect(pacing.headline).toBe('on pace (52% elapsed, 49% burned).');
  });

  it('treats exactly 1.15 as on-pace, not ahead', () => {
    // usedFraction 0.69 / elapsedFraction 0.6 = 1.15 exactly.
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(69, 0.6)] })],
      NOW,
    );
    expect(pacing.paceRatio).toBeCloseTo(1.15, 5);
    expect(pacing.verdict).toBe('on-pace');
  });

  it('treats exactly 0.85 as on-pace, not behind', () => {
    // usedFraction 0.51 / elapsedFraction 0.6 = 0.85 exactly.
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(51, 0.6)] })],
      NOW,
    );
    expect(pacing.paceRatio).toBeCloseTo(0.85, 5);
    expect(pacing.verdict).toBe('on-pace');
  });

  it('crosses to ahead just past the 1.15 boundary', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(70, 0.6)] })], // ratio 1.1667
      NOW,
    );
    expect(pacing.verdict).toBe('ahead');
  });

  it('crosses to behind just past the 0.85 boundary', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(50, 0.6)] })], // ratio 0.8333
      NOW,
    );
    expect(pacing.verdict).toBe('behind');
  });
});

describe('computePacing — fresh and unknown', () => {
  it('reports fresh when the combined week just reset (elapsed ~0)', () => {
    const pacing = computePacing([account({ accountId: 'a', limits: [weeklyLimit(10, 0)] })], NOW);
    expect(pacing.verdict).toBe('fresh');
    expect(pacing.paceRatio).toBeUndefined();
    expect(pacing.weekElapsedPct).toBe(0);
    expect(pacing.budgetUsedPct).toBe(10);
    expect(pacing.headline).toBe(
      '0% of the combined week elapsed - just reset, too early to gauge pace.',
    );
  });

  it('guards the division when several accounts all sum to ~0 elapsed', () => {
    const pacing = computePacing(
      [
        account({ accountId: 'a', limits: [weeklyLimit(10, 0)] }),
        account({ accountId: 'b', limits: [weeklyLimit(90, 0)] }),
      ],
      NOW,
    );
    expect(pacing.verdict).toBe('fresh');
    expect(pacing.paceRatio).toBeUndefined();
    expect(Number.isNaN(pacing.weekElapsedPct)).toBe(false);
    expect(Number.isFinite(pacing.budgetUsedPct)).toBe(true);
    expect(pacing.budgetUsedPct).toBe(50);
  });

  it('reports unknown with no accounts at all', () => {
    const pacing = computePacing([], NOW);
    expect(pacing.verdict).toBe('unknown');
    expect(pacing.weekElapsedPct).toBe(0);
    expect(pacing.budgetUsedPct).toBe(0);
    expect(pacing.headline).toBe('No weekly usage data yet - pace unknown.');
    expect(pacing.accounts).toEqual([]);
  });

  it('reports unknown when accounts exist but none carry weekly data', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [{ kind: 'session', percent: 20, resetsAt: NOW + 1000 }],
        }),
      ],
      NOW,
    );
    expect(pacing.verdict).toBe('unknown');
    expect(pacing.accounts).toEqual([
      {
        accountId: 'a',
        label: 'a',
        contributing: false,
        reason: 'no weekly limit reported',
      },
    ]);
  });
});

describe('computePacing — quarantine and missing data', () => {
  it('excludes a quarantined account from the aggregate but lists it with a reason', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'dead',
          quarantined: true,
          limits: [weeklyLimit(90, 0.5)],
        }),
        account({ accountId: 'live', limits: [weeklyLimit(50, 0.5)] }),
      ],
      NOW,
    );
    // If the quarantined 90%/50% were included, the average would push ahead of pace
    // (used avg 0.7 / elapsed avg 0.5 = 1.4); excluding it leaves exactly on-pace (1.0).
    expect(pacing.verdict).toBe('on-pace');
    expect(pacing.paceRatio).toBeCloseTo(1.0, 5);

    const dead = pacing.accounts.find((a) => a.accountId === 'dead');
    expect(dead?.contributing).toBe(false);
    expect(dead?.reason).toBe('quarantined - excluded from pacing until re-login');
    // Still surfaced for context, even though excluded.
    expect(dead?.usedPct).toBe(90);
    expect(dead?.elapsedPct).toBe(50);

    const live = pacing.accounts.find((a) => a.accountId === 'live');
    expect(live?.contributing).toBe(true);
  });

  it('marks an account with no weekly limit at all as non-contributing', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [{ kind: 'session', percent: 40, resetsAt: NOW + 3600_000 }],
        }),
      ],
      NOW,
    );
    expect(pacing.accounts[0]).toEqual({
      accountId: 'a',
      label: 'a',
      contributing: false,
      reason: 'no weekly limit reported',
    });
  });

  it('marks an account missing resetsAt as non-contributing but still shows usedPct', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [{ kind: 'weekly_all', percent: 44 }] })],
      NOW,
    );
    const a = pacing.accounts[0];
    expect(a?.contributing).toBe(false);
    expect(a?.reason).toBe('weekly limit missing reset time');
    expect(a?.usedPct).toBe(44);
    expect(a?.elapsedPct).toBeUndefined();
  });

  it('marks an account missing percent (a malformed snapshot) as non-contributing', () => {
    // percent omitted at runtime despite the type declaring it required — a partial/corrupt
    // snapshot must not be trusted just because TS says the field exists.
    const malformed = { kind: 'weekly_all', resetsAt: NOW + 100_000 } as unknown as LimitInput;
    const pacing = computePacing([account({ accountId: 'a', limits: [malformed] })], NOW);
    const a = pacing.accounts[0];
    expect(a?.contributing).toBe(false);
    expect(a?.reason).toBe('weekly limit missing percent');
    expect(a?.usedPct).toBeUndefined();
    expect(a?.elapsedPct).toBeDefined();
  });
});

describe('computePacing — clamping', () => {
  it('clamps usedFraction when percent exceeds 100 (grace overage)', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', limits: [weeklyLimit(140, 0.6)] })],
      NOW,
    );
    expect(pacing.accounts[0]?.usedPct).toBe(100);
    expect(pacing.budgetUsedPct).toBe(100);
    expect(pacing.verdict).toBe('ahead');
  });

  it('clamps elapsedFraction to 100% when resetsAt is already in the past, without excluding it', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [{ kind: 'weekly_all', percent: 30, resetsAt: NOW - 3_600_000 }],
        }),
      ],
      NOW,
    );
    const a = pacing.accounts[0];
    expect(a?.contributing).toBe(true);
    expect(a?.elapsedPct).toBe(100);
    expect(pacing.weekElapsedPct).toBe(100);
    expect(pacing.verdict).toBe('behind'); // 30% used against a "fully elapsed" week
  });
});

describe('computePacing — weekly_all vs weekly_scoped', () => {
  it('prefers weekly_all when both are present', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'weekly_scoped', percent: 20, resetsAt: NOW + 1000 },
            weeklyLimit(80, 0.5),
          ],
        }),
      ],
      NOW,
    );
    expect(pacing.accounts[0]?.usedPct).toBe(80);
  });

  it('falls back to weekly_scoped when weekly_all is absent', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'weekly_scoped', percent: 33, resetsAt: NOW + Math.round(0.5 * WEEK_MS) },
          ],
        }),
      ],
      NOW,
    );
    expect(pacing.accounts[0]?.contributing).toBe(true);
    expect(pacing.accounts[0]?.usedPct).toBe(33);
  });
});

describe('computePacing — misc', () => {
  it('preserves input order and one entry per account in the output', () => {
    const pacing = computePacing(
      [
        account({ accountId: 'b', limits: [weeklyLimit(10, 0.2)] }),
        account({ accountId: 'a', limits: [weeklyLimit(20, 0.3)] }),
        account({ accountId: 'c', quarantined: true, limits: [] }),
      ],
      NOW,
    );
    expect(pacing.accounts.map((a) => a.accountId)).toEqual(['b', 'a', 'c']);
  });

  it('never produces a headline containing NaN, across every verdict', () => {
    const scenarios: AccountUsageInput[][] = [
      [account({ accountId: 'a', limits: [weeklyLimit(52, 0.38)] })], // ahead
      [account({ accountId: 'a', limits: [weeklyLimit(41, 0.6)] })], // behind
      [account({ accountId: 'a', limits: [weeklyLimit(49, 0.52)] })], // on-pace
      [account({ accountId: 'a', limits: [weeklyLimit(10, 0)] })], // fresh
      [], // unknown
    ];
    for (const accounts of scenarios) {
      expect(computePacing(accounts, NOW).headline).not.toContain('NaN');
    }
  });
});
