// Tests for fleet pacing: the balance model, the reset simulation (waste, running dry), how
// weights change every total, and the honesty notes that must appear whenever the model had to
// assume something.

import { describe, expect, it } from 'vitest';
import { computePacing, PLAIN_PACING_STYLE, renderPacingSummary } from './pacing.js';
import type { AccountUsageInput, LimitInput } from './types.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

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

/** A weekly_all limit resetting `days` from NOW. Omit `days` for a dormant account: the
 *  endpoint stops reporting a reset once the weekly window closes. */
function weekly(percent: number, days?: number): LimitInput {
  return {
    kind: 'weekly_all',
    percent,
    ...(days !== undefined ? { resetsAt: NOW + days * DAY_MS } : {}),
  };
}

describe('computePacing — balances and capacity', () => {
  it('counts a dormant account at its FULL allowance instead of dropping it', () => {
    // The defect this model replaces: three untouched accounts were excluded for having no
    // reset time, so the verdict came from the one account in use and read "slow down".
    const pacing = computePacing(
      [
        account({ accountId: 'a', weight: 20, limits: [weekly(0)] }),
        account({ accountId: 'b', weight: 20, limits: [weekly(0)] }),
        account({ accountId: 'c', weight: 20, limits: [weekly(0)] }),
        account({ accountId: 'd', weight: 20, limits: [weekly(60, 4)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 5 },
    );
    expect(pacing.capacityUnits).toBe(80);
    expect(pacing.availableUnits).toBeCloseTo(68, 6);
    expect(pacing.accounts.every((a) => a.contributing)).toBe(true);
    expect(pacing.verdict).toBe('sustainable');
    expect(pacing.headline).toContain('68u of 80u available (85%)');
  });

  it('weights a Pro account and a Max 20x account by their allowances, not equally', () => {
    const pacing = computePacing(
      [
        account({ accountId: 'pro', weight: 1, limits: [weekly(0, 3)] }),
        account({ accountId: 'max', weight: 20, limits: [weekly(50, 3)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.capacityUnits).toBe(21);
    // 1 unit from the untouched Pro + 10 from the half-used Max. A mean of percentages would
    // have said 75% available; the weighted truth is 11/21.
    expect(pacing.availableUnits).toBeCloseTo(11, 6);
    expect(pacing.headline).toContain('11u of 21u available (52%)');
  });

  it('clamps a grace overage past 100% to a zero balance, never a negative one', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(140, 2)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 0,
      },
    );
    expect(pacing.availableUnits).toBe(0);
    expect(pacing.accounts[0]?.usedPct).toBe(100);
  });

  it('replenishes one full capacity per weekly cycle', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 21, limits: [weekly(0, 1)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 1,
      },
    );
    expect(pacing.replenishUnitsPerDay).toBeCloseTo(3, 6);
  });
});

describe('computePacing — the simulation', () => {
  it('reports sustainable when burn never outruns the resets in the horizon', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(0, 1)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 2,
      },
    );
    expect(pacing.verdict).toBe('sustainable');
    expect(pacing.dryAtMs).toBeUndefined();
    expect(pacing.headline).toContain('sustainable for the next 14d');
  });

  it('runs dry, and dates it, when burn exceeds everything the fleet can hold', () => {
    // 20 units on hand, 40/day burned: gone in half a day, well before the reset in 3d.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(0, 3)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 40,
      },
    );
    expect(pacing.verdict).toBe('runs-dry');
    expect(pacing.dryAtMs).toBeCloseTo(NOW + 0.5 * DAY_MS, -2);
    expect(pacing.headline).toContain('runs dry in 12h');
  });

  it('survives past a mid-horizon reset that a balance-only check would call exhaustion', () => {
    // 1 unit left against 2/day: gone in half a day looking at the balance alone. The window
    // rolls at exactly that half-day mark, and 2/day sits under the 2.86/day replenishment,
    // so the fleet holds for the whole horizon.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(95, 0.5)] })],
      { nowMs: NOW, burnUnitsPerDay: 2 },
    );
    expect(pacing.verdict).toBe('sustainable');
  });

  it('draws from the soonest-expiring account first, leaving the later one untouched', () => {
    // 5 units are burned over the first day. All of them must come from 'soon' (resetting in
    // 1d) rather than 'late' (10d), because only soon's budget is about to be destroyed.
    const pacing = computePacing(
      [
        account({ accountId: 'soon', weight: 20, limits: [weekly(0, 1)] }),
        account({ accountId: 'late', weight: 20, limits: [weekly(0, 10)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 5 },
    );
    expect(pacing.verdict).toBe('sustainable');
    expect(pacing.waste[0]?.accountId).toBe('soon');
    expect(pacing.waste[0]?.units).toBeCloseTo(15, 6);
  });

  it('re-orders the draw after a reset, so the account that just rolled is drawn last', () => {
    // 'soon' resets on day 1 (next expiry day 8) and 'late' on day 6. From day 1 the burn must
    // switch to 'late', whose budget is now the one about to be destroyed. If the draw kept
    // using the stale day-1 clock, 'soon' would stay first and 'late' would waste all 20 units.
    const pacing = computePacing(
      [
        account({ accountId: 'soon', weight: 20, limits: [weekly(0, 1)] }),
        account({ accountId: 'late', weight: 20, limits: [weekly(0, 6)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 2, horizonDays: 7 },
    );
    const lateWaste = pacing.waste.find((w) => w.accountId === 'late');
    expect(lateWaste?.units).toBeCloseTo(10, 6); // 5 days x 2/day drawn off 'late'
  });

  it('counts an account with no reset time at all as spendable but never replenished', () => {
    const pacing = computePacing(
      [account({ accountId: 'blind', weight: 20, limits: [weekly(0)] })],
      { nowMs: NOW, burnUnitsPerDay: 10 },
    );
    expect(pacing.verdict).toBe('runs-dry');
    expect(pacing.waste).toEqual([]);
    expect(pacing.notes).toContain(
      'no reset time for blind, so their budget is never modelled as expiring.',
    );
  });
});

describe('computePacing — waste', () => {
  it('reports the units, the account, and the reset that destroys them', () => {
    const pacing = computePacing(
      [
        account({ accountId: 'used', label: 'debate', weight: 20, limits: [weekly(60, 4)] }),
        account({
          accountId: 'idle',
          label: 'tjin.29',
          weight: 20,
          predictedResetAt: NOW + 6 * DAY_MS,
          limits: [weekly(0)],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    const first = pacing.waste[0];
    expect(first?.label).toBe('debate');
    expect(first?.units).toBeCloseTo(8, 6);
    expect(first?.atMs).toBe(NOW + 4 * DAY_MS);
    // Both accounts reset twice inside the 14d horizon; nothing is burned, so all of it goes.
    expect(pacing.wastedUnits).toBeCloseTo(8 + 20 + 20 + 20, 6);
    // Named once per ACCOUNT, biggest loss first, stamped with the deadline to act by: the two
    // tjin.29 resets are one decision, not two entries crowding debate off the line.
    expect(pacing.notes[0]).toBe(
      '68u expires unused within 14d: 40u on tjin.29 in 6d, 28u on debate in 4d.',
    );
  });

  it('counts the accounts it does not name rather than dropping them', () => {
    const accounts = ['a', 'b', 'c', 'd'].map((id, i) =>
      account({ accountId: id, weight: 20 - i, limits: [weekly(0, i + 1)] }),
    );
    const pacing = computePacing(accounts, { nowMs: NOW, burnUnitsPerDay: 0, horizonDays: 7 });
    expect(pacing.waste).toHaveLength(4);
    expect(pacing.notes[0]).toContain('and 1 more account.');
  });

  it('reports no waste note when every unit is spent before it expires', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(0, 1)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 20,
      },
    );
    expect(pacing.wastedUnits).toBe(0);
    expect(pacing.notes.some((n) => n.includes('expires unused'))).toBe(false);
  });
});

describe('computePacing — degraded inputs are stated, never assumed', () => {
  it('gives no verdict when the burn rate could not be measured', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(30, 3)] })],
      {
        nowMs: NOW,
      },
    );
    expect(pacing.verdict).toBe('unknown');
    expect(pacing.burnUnitsPerDay).toBeUndefined();
    expect(pacing.headline).toContain('burn rate not measured yet');
    expect(pacing.notes).toContain('no usage history to measure a burn rate from yet.');
  });

  it('distinguishes a MEASURED zero burn from an unmeasurable one', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 20, limits: [weekly(30, 3)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 0,
      },
    );
    expect(pacing.verdict).toBe('sustainable');
    expect(pacing.notes).not.toContain('no usage history to measure a burn rate from yet.');
  });

  it('says so when plan tiers are unknown instead of weighting accounts equally in silence', () => {
    const pacing = computePacing([account({ accountId: 'a', limits: [weekly(50, 3)] })], {
      nowMs: NOW,
      burnUnitsPerDay: 0,
    });
    expect(pacing.accounts[0]?.weightUnits).toBe(1);
    expect(pacing.notes).toContain(
      'plan tiers unknown, so accounts are weighted equally (1 unit each).',
    );
  });

  it('does not claim tiers were assumed when the weightless account never entered the math', () => {
    // 'dead' has no weight AND is quarantined, so no total ever used a fallback weight. Claiming
    // otherwise puts a permanent caveat on a fleet whose arithmetic is entirely known.
    const pacing = computePacing(
      [
        account({ accountId: 'known', weight: 20, limits: [weekly(50, 20)] }),
        account({ accountId: 'dead', quarantined: true, limits: [weekly(0, 3)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.tiersUnknown).toBe(false);
    expect(pacing.notes).not.toContain(
      'plan tiers unknown, so accounts are weighted equally (1 unit each).',
    );
    expect(renderPacingSummary(pacing, NOW)).not.toContain('tiers unknown');
  });

  it('treats a non-positive weight as an assumed tier, since the fallback did fire', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 0, limits: [weekly(50, 3)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 1,
      },
    );
    expect(pacing.accounts[0]?.weightUnits).toBe(1);
    expect(pacing.tiersUnknown).toBe(true);
  });

  it('labels a predicted reset as predicted, never as observed', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          label: 'legoboy',
          weight: 20,
          predictedResetAt: NOW + 5 * DAY_MS,
          limits: [weekly(0)],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.accounts[0]?.resetPredicted).toBe(true);
    expect(pacing.accounts[0]?.resetsAt).toBe(NOW + 5 * DAY_MS);
    expect(pacing.notes).toContain('next weekly reset predicted from history for legoboy.');
  });

  it('refuses a prediction that is already in the past', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          weight: 20,
          predictedResetAt: NOW - DAY_MS,
          limits: [weekly(0)],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.accounts[0]?.resetsAt).toBeUndefined();
    expect(pacing.accounts[0]?.resetPredicted).toBe(false);
  });

  it('excludes a quarantined account from the totals but lists it with a reason', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'dead',
          label: 'dead',
          quarantined: true,
          weight: 20,
          limits: [weekly(0, 3)],
        }),
        account({ accountId: 'live', weight: 20, limits: [weekly(50, 3)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.capacityUnits).toBe(20);
    expect(pacing.availableUnits).toBeCloseTo(10, 6);
    const dead = pacing.accounts.find((a) => a.accountId === 'dead');
    expect(dead?.contributing).toBe(false);
    expect(dead?.balanceUnits).toBeUndefined();
    expect(pacing.notes).toContain('dead excluded: quarantined - excluded until re-login.');
  });

  it('excludes an account with no weekly limit at all, and names why', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          limits: [{ kind: 'session', percent: 20, resetsAt: NOW + HOUR_MS }],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.verdict).toBe('unknown');
    expect(pacing.headline).toBe('No weekly usage data yet - fleet pacing unknown.');
    expect(pacing.notes).toContain('a excluded: no weekly limit reported.');
  });

  it('excludes a malformed weekly limit that reports no percent', () => {
    const malformed = { kind: 'weekly_all', resetsAt: NOW + DAY_MS } as unknown as LimitInput;
    const pacing = computePacing([account({ accountId: 'a', limits: [malformed] })], {
      nowMs: NOW,
      burnUnitsPerDay: 1,
    });
    expect(pacing.accounts[0]?.contributing).toBe(false);
    expect(pacing.notes).toContain('a excluded: weekly limit missing percent.');
  });

  it('reports unknown with no accounts at all', () => {
    const pacing = computePacing([], { nowMs: NOW });
    expect(pacing.verdict).toBe('unknown');
    expect(pacing.availableUnits).toBe(0);
    expect(pacing.capacityUnits).toBe(0);
    expect(pacing.headline).toBe('No weekly usage data yet - fleet pacing unknown.');
    expect(pacing.accounts).toEqual([]);
  });
});

describe('computePacing — weekly_all vs weekly_scoped', () => {
  it('budgets against weekly_all when both are present', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          weight: 20,
          limits: [
            { kind: 'weekly_scoped', percent: 20, resetsAt: NOW + 3 * DAY_MS },
            weekly(80, 3),
          ],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    expect(pacing.accounts[0]?.usedPct).toBe(80);
  });

  it('takes the reset from weekly_scoped when the weekly_all entry has none', () => {
    // The shadowing defect: a weekly_all entry with a null reset used to hide a perfectly
    // usable weekly_scoped reset, and the account fell out of the aggregate entirely.
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          weight: 20,
          limits: [
            { kind: 'weekly_all', percent: 40 },
            { kind: 'weekly_scoped', percent: 20, resetsAt: NOW + 2 * DAY_MS },
          ],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    expect(pacing.accounts[0]?.usedPct).toBe(40); // percent still from weekly_all
    expect(pacing.accounts[0]?.resetsAt).toBe(NOW + 2 * DAY_MS);
    expect(pacing.accounts[0]?.resetPredicted).toBe(false);
  });

  it('falls back to weekly_scoped for the percent when weekly_all is absent', () => {
    const pacing = computePacing(
      [
        account({
          accountId: 'a',
          weight: 20,
          limits: [{ kind: 'weekly_scoped', percent: 25, resetsAt: NOW + WEEK_MS / 2 }],
        }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    expect(pacing.accounts[0]?.contributing).toBe(true);
    expect(pacing.accounts[0]?.usedPct).toBe(25);
  });
});

describe('computePacing — misc', () => {
  it('preserves input order and one entry per account in the output', () => {
    const pacing = computePacing(
      [
        account({ accountId: 'b', limits: [weekly(10, 2)] }),
        account({ accountId: 'a', limits: [weekly(20, 3)] }),
        account({ accountId: 'c', quarantined: true, limits: [] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.accounts.map((a) => a.accountId)).toEqual(['b', 'a', 'c']);
  });

  it('never renders NaN, across every verdict', () => {
    const scenarios: Array<[AccountUsageInput[], number | undefined]> = [
      [[account({ accountId: 'a', weight: 20, limits: [weekly(0, 1)] })], 2],
      [[account({ accountId: 'a', weight: 20, limits: [weekly(0, 3)] })], 40],
      [[account({ accountId: 'a', weight: 20, limits: [weekly(30, 3)] })], undefined],
      [[], undefined],
    ];
    for (const [accounts, burnUnitsPerDay] of scenarios) {
      const pacing = computePacing(accounts, {
        nowMs: NOW,
        ...(burnUnitsPerDay !== undefined ? { burnUnitsPerDay } : {}),
      });
      expect(renderPacingSummary(pacing, NOW)).not.toContain('NaN');
    }
  });
});

describe('renderPacingSummary', () => {
  it('prints headroom, burn vs replenish, and the sustainable horizon on one line', () => {
    // Reset lands outside the horizon (no in-horizon replenishment) and the burn rate never
    // drains the balance across the full 14d, so this stays sustainable throughout.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 7, limits: [weekly(50, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 0.2 },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      'Pacing: [ok] 3.5u/7u (50%) - burn 0.2u/d < 1u/d - 14d',
    );
  });

  it('prints a countdown for a fleet that runs dry inside the horizon', () => {
    // Reset lands outside the horizon so this exercises the dry-out path in isolation from
    // the waste path (the fleet burns out before any account ever resets).
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 1, limits: [weekly(0, 20)] })],
      {
        nowMs: NOW,
        burnUnitsPerDay: 1,
      },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      'Pacing: [!!] 1u/1u (100%) - burn 1u/d > 0.1u/d - dry in 1d',
    );
  });

  it('prints "burn unmeasured" and no verdict when there is no burn history yet', () => {
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 2, limits: [weekly(50, 10)] })],
      {
        nowMs: NOW,
      },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      'Pacing: [--] 1u/2u (50%) - burn unmeasured - replenish 0.3u/d',
    );
  });

  it('says so and stops when no account has ever reported a weekly limit', () => {
    const pacing = computePacing([account({ accountId: 'a' })], { nowMs: NOW });
    expect(pacing.capacityUnits).toBe(0);
    expect(renderPacingSummary(pacing, NOW)).toBe('Pacing: no usage data yet.');
  });

  it('says the fleet is locked out, not dataless, when every account is quarantined', () => {
    // The usage data is there and readable; the logins are not. "No usage data yet" sends the
    // operator looking for a poll that already happened instead of re-logging in.
    const pacing = computePacing(
      [
        account({ accountId: 'tjin.29', quarantined: true, weight: 20, limits: [weekly(40, 3)] }),
        account({ accountId: 'legoboy', quarantined: true, weight: 20, limits: [weekly(10, 5)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(pacing.capacityUnits).toBe(0);
    expect(renderPacingSummary(pacing, NOW)).toBe(
      'Pacing: [--] no usable accounts - tjin.29, legoboy quarantined; run: cctl accounts relogin <label>',
    );
  });

  it('counts the quarantined accounts it does not name', () => {
    const pacing = computePacing(
      ['a', 'b', 'c', 'd'].map((id) =>
        account({ accountId: id, quarantined: true, weight: 20, limits: [weekly(0, 3)] }),
      ),
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(renderPacingSummary(pacing, NOW)).toContain('a, b, c +1 quarantined');
  });

  it('adds a waste line naming the account and deadline, without narrating the rest', () => {
    // A weekly reset every 7d inside a 14d horizon fires twice (day 5, day 12); with nothing
    // burned, the account's full 1u allowance is lost at each — 2u total, one account named.
    const pacing = computePacing([account({ accountId: 'a', weight: 1, limits: [weekly(0, 5)] })], {
      nowMs: NOW,
      burnUnitsPerDay: 0,
    });
    expect(renderPacingSummary(pacing, NOW)).toBe(
      ['Pacing: [ok] 1u/1u (100%) - burn 0u/d < 0.1u/d - 14d', '  waste 2u: soonest a in 5d'].join(
        '\n',
      ),
    );
  });

  it('stamps the fleet-wide waste total with the SOONEST deadline, not the biggest loser', () => {
    // 'big' loses the most units but expires last. Printing its deadline beside the fleet total
    // tells the reader all of it keeps until then, and 'early' burns to nothing meanwhile.
    const pacing = computePacing(
      [
        account({ accountId: 'big', weight: 20, limits: [weekly(0, 6)] }),
        account({ accountId: 'early', weight: 2, limits: [weekly(0, 2)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0, horizonDays: 7 },
    );
    // Both waste their whole allowance once inside the 7d horizon: 22u fleet-wide.
    expect(pacing.wastedUnits).toBeCloseTo(22, 6);
    expect(renderPacingSummary(pacing, NOW)).toContain('waste 22u: soonest early in 2d +1');
  });

  it('compresses the plan-tier caveat to a short marker instead of dropping it', () => {
    // `weight` omitted on purpose: the model falls back to 1 unit and must say so.
    const pacing = computePacing([account({ accountId: 'a', limits: [weekly(0, 20)] })], {
      nowMs: NOW,
      burnUnitsPerDay: 0,
    });
    expect(pacing.tiersUnknown).toBe(true);
    expect(renderPacingSummary(pacing, NOW)).toBe(
      ['Pacing: [ok] 1u/1u (100%) - burn 0u/d < 0.1u/d - 14d', '  tiers unknown'].join('\n'),
    );
  });

  it('ranks waste by units lost, names the top account, and counts the rest', () => {
    // Each account's weekly reset also fires twice inside the 14d horizon (see the previous
    // test): a loses 2u twice (4u), b loses 1u twice (2u) — a outranks b on total units lost.
    const pacing = computePacing(
      [
        account({ accountId: 'a', label: 'a', weight: 2, limits: [weekly(0, 3)] }),
        // No weight on b: also exercises both caveats sharing one line.
        account({ accountId: 'b', label: 'b', limits: [weekly(0, 4)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      [
        'Pacing: [ok] 3u/3u (100%) - burn 0u/d < 0.4u/d - 14d',
        '  waste 6u: soonest a in 3d +1  tiers unknown',
      ].join('\n'),
    );
  });

  it('renders "=" when burn and replenishment are equal', () => {
    // weight 7 replenishes exactly 1u/day; "1u/d < 1u/d" asserts 1 < 1.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 7, limits: [weekly(50, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(renderPacingSummary(pacing, NOW)).toContain('burn 1u/d = 1u/d');
  });

  it('renders "=" when unequal rates round to the same printed figure', () => {
    // 0.62 burned against 0.58 replenished: both print "0.6u", so any inequality sign puts the
    // line at odds with the two numbers it just printed.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 4.06, limits: [weekly(50, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 0.62 },
    );
    expect(pacing.burnUnitsPerDay).toBeGreaterThan(pacing.replenishUnitsPerDay);
    expect(renderPacingSummary(pacing, NOW)).toContain('burn 0.6u/d = 0.6u/d');
  });

  it('routes exactly the marker, headroom and waste segments through an injected style', () => {
    const pacing = computePacing([account({ accountId: 'a', weight: 1, limits: [weekly(0, 5)] })], {
      nowMs: NOW,
      burnUnitsPerDay: 0,
    });
    const calls: string[] = [];
    const spy = renderPacingSummary(pacing, NOW, {
      marker: (t, v) => {
        calls.push(`marker:${v}`);
        return `<${t}>`;
      },
      percent: (t) => {
        calls.push('percent');
        return `[${t}]`;
      },
      waste: (t) => {
        calls.push('waste');
        return `{${t}}`;
      },
      warn: (t) => {
        calls.push('warn');
        return `!${t}!`;
      },
      dim: (t) => {
        calls.push('dim');
        return `(${t})`;
      },
    });
    // Execution order follows source order, not call-site prominence: headroom is computed
    // (and painted) before the marker is embedded into the headline template, so `percent`
    // fires before `marker` here. `dim` never fires — this scenario has a known plan tier — and
    // neither does `warn`, which belongs to the no-capacity line this fleet never reaches.
    expect(calls).toEqual(['percent', 'marker:sustainable', 'waste']);
    expect(spy).toContain('<[ok]>');
    expect(spy).toContain('{waste 2u: soonest a in 5d}');
  });

  it('routes the locked-out marker through `warn`, not the verdict marker', () => {
    const pacing = computePacing([account({ accountId: 'a', quarantined: true, limits: [] })], {
      nowMs: NOW,
      burnUnitsPerDay: 1,
    });
    const line = renderPacingSummary(pacing, NOW, {
      ...PLAIN_PACING_STYLE,
      warn: (t) => `!${t}!`,
      marker: (t) => `<${t}>`,
    });
    expect(line).toContain('![--]!');
    expect(line).not.toContain('<[--]>');
  });
});
