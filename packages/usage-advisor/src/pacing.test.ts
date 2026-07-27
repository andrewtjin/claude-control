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
  it('leads with the verdict, then labels the burn pair and the headroom row', () => {
    // Reset lands outside the horizon (no in-horizon replenishment) and the burn rate never
    // drains the balance across the full 14d, so this stays sustainable throughout.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 7, limits: [weekly(50, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 0.2 },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      [
        'Pacing  [ok] sustainable past 14d (0.2u/1u burned per day)',
        '  left     3.5u of 7u (50%)',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
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
      [
        'Pacing  [!!] runs dry in 1d (1u/0.1u burned per day)',
        '  left     1u of 1u (100%)',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
    );
  });

  it('drops the burn fraction entirely when there is no burn history yet', () => {
    // An unmeasured burn has no fraction to print, and a "0u/0.3u" would read as a measured
    // zero — the opposite claim. The verdict line says the rate is missing and stops.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 2, limits: [weekly(50, 10)] })],
      {
        nowMs: NOW,
      },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      [
        'Pacing  [--] burn rate not measured yet',
        '  left     1u of 2u (50%)',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
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
      [
        'Pacing  [ok] sustainable past 14d (0u/0.1u burned per day)',
        '  left     1u of 1u (100%)',
        '  expires  a 2u in 5d - nothing else expires within 14d',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
    );
  });

  it('pairs the named account with ITS OWN loss and ITS OWN deadline, not the fleet total', () => {
    // 'big' loses the most units but expires last. Printing the 22u fleet total beside 'early's
    // date tells the reader all of it keeps until then, and 'early' burns to nothing meanwhile.
    const pacing = computePacing(
      [
        account({ accountId: 'big', weight: 20, limits: [weekly(0, 6)] }),
        account({ accountId: 'early', weight: 2, limits: [weekly(0, 2)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0, horizonDays: 7 },
    );
    // Both waste their whole allowance once inside the 7d horizon: 22u fleet-wide.
    expect(pacing.wastedUnits).toBeCloseTo(22, 6);
    // 2u is early's own loss; the 22u fleet figure is stated separately and labelled "total".
    expect(renderPacingSummary(pacing, NOW)).toContain(
      'expires  early 2u in 2d, then 1 more - 22u total over 7d',
    );
  });

  it('names the FIRST ACCOUNT TO LOSE budget, which need not be the first to reset', () => {
    // 'drained' resets first (2d) but the burn empties it before then, so it loses nothing.
    // 'holder' resets later (5d) still holding budget, and is the first real loss. A row that
    // ranked by reset time would name 'drained' and send the reader to guard budget that was
    // always going to be spent.
    const pacing = computePacing(
      [
        account({ accountId: 'drained', weight: 2, limits: [weekly(0, 2)] }),
        account({ accountId: 'holder', weight: 20, limits: [weekly(0, 5)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 1, horizonDays: 6 },
    );
    expect(pacing.waste.map((w) => w.label)).toEqual(['holder']);
    expect(renderPacingSummary(pacing, NOW)).toContain('expires  holder ');
    expect(renderPacingSummary(pacing, NOW)).not.toContain('drained');
  });

  it('states the equal-weighting fallback in the legend rather than quoting the 20x rule', () => {
    // `weight` omitted on purpose: the model falls back to 1 unit and must say so. Printing
    // "a Max 20x counts 20" here would describe arithmetic that did not run.
    const pacing = computePacing([account({ accountId: 'a', limits: [weekly(0, 20)] })], {
      nowMs: NOW,
      burnUnitsPerDay: 0,
    });
    expect(pacing.tiersUnknown).toBe(true);
    expect(renderPacingSummary(pacing, NOW)).toBe(
      [
        'Pacing  [ok] sustainable past 14d (0u/0.1u burned per day)',
        '  left     1u of 1u (100%)',
        '  1u = one Pro account-week; plan tiers unknown, so every account counts 1u',
      ].join('\n'),
    );
  });

  it('counts the accounts it does not name, and keeps the fleet total labelled as a total', () => {
    // Each account's weekly reset fires twice inside the 14d horizon: a loses 2u twice (4u),
    // b loses 1u twice (2u). 'a' expires first, so 'a' is named with its own 4u.
    const pacing = computePacing(
      [
        account({ accountId: 'a', label: 'a', weight: 2, limits: [weekly(0, 3)] }),
        // No weight on b: also exercises the unknown-tier legend alongside a waste row.
        account({ accountId: 'b', label: 'b', limits: [weekly(0, 4)] }),
      ],
      { nowMs: NOW, burnUnitsPerDay: 0 },
    );
    expect(renderPacingSummary(pacing, NOW)).toBe(
      [
        'Pacing  [ok] sustainable past 14d (0u/0.4u burned per day)',
        '  left     3u of 3u (100%)',
        '  expires  a 4u in 3d, then 1 more - 6u total over 14d',
        '  1u = one Pro account-week; plan tiers unknown, so every account counts 1u',
      ].join('\n'),
    );
  });

  it('prints both figures of the burn pair even when they are equal', () => {
    // weight 7 replenishes exactly 1u/day. The pair is printed as a fraction precisely so a
    // reader never has to decide what an operator between two bare numbers meant.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 7, limits: [weekly(50, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 1 },
    );
    expect(renderPacingSummary(pacing, NOW)).toContain('(1u/1u burned per day)');
  });

  it('colors the burn pair by the share of the refill consumed, not by the stock left', () => {
    // A full fleet burning double what it refills: the headroom is 100% (green) while the burn
    // pair is 200% of refill, which must read hot. One percent painted by the other's band is
    // how a fleet gets called healthy right up to the moment it isn't.
    const pacing = computePacing(
      [account({ accountId: 'a', weight: 7, limits: [weekly(0, 20)] })],
      { nowMs: NOW, burnUnitsPerDay: 2 },
    );
    const bands: number[] = [];
    renderPacingSummary(pacing, NOW, {
      ...PLAIN_PACING_STYLE,
      percent: (t, pct) => {
        bands.push(pct);
        return t;
      },
    });
    // Burn pair first (200% of a 1u/d refill), then headroom as percent USED (0% of 7u gone).
    expect(bands).toEqual([200, 0]);
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
      label: (t) => {
        calls.push('label');
        return `_${t.trim()}_`;
      },
    });
    // Order follows the rendered block top-down: the verdict line (marker, then the burn
    // fraction through `percent`), then each labelled row, then the dim unit legend. `warn`
    // never fires — it belongs to the no-capacity line this fleet never reaches. A burn of 0
    // still routes through `percent`: measured-zero is a reading, and only an ABSENT burn
    // suppresses the fraction.
    // Within a row the VALUE is painted before its label — it is an argument to the row
    // builder, so it evaluates first — which is why the two `percent` calls sit together.
    expect(calls).toEqual([
      'marker:sustainable',
      'percent',
      'percent',
      'label',
      'waste',
      'label',
      'dim',
    ]);
    expect(spy).toContain('<[ok]>');
    expect(spy).toContain('_expires_');
    expect(spy).toContain('{a 2u in 5d - nothing else expires within 14d}');
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
