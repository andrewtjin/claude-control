import { describe, it, expect } from 'vitest';
import { computePlan } from './advisor.js';
import type { AccountUsageInput, LimitInput } from './types.js';

const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const opts = { now: () => NOW };

/** Terse account builder for tests. */
function acct(
  accountId: string,
  label: string,
  limits: LimitInput[],
  extra: { active?: boolean; quarantined?: boolean } = {},
): AccountUsageInput {
  return {
    accountId,
    label,
    active: extra.active ?? false,
    quarantined: extra.quarantined ?? false,
    limits,
  };
}

describe('computePlan — degenerate inputs', () => {
  it('handles no accounts', () => {
    const plan = computePlan([], opts);
    expect(plan.recommendedAccountId).toBeNull();
    expect(plan.reason).toMatch(/no accounts/i);
    expect(plan.ranking).toEqual([]);
    expect(plan.advisories).toEqual([]);
  });

  it('recommends the only usable account and reports all-healthy', () => {
    const plan = computePlan([acct('a', 'Solo', [{ kind: 'weekly_all', percent: 20 }])], opts);
    expect(plan.recommendedAccountId).toBe('a');
    expect(plan.advisories.map((x) => x.kind)).toContain('all_healthy');
  });

  it('recommends nobody when all accounts are quarantined', () => {
    const plan = computePlan(
      [
        acct('a', 'A', [{ kind: 'weekly_all', percent: 0 }], { quarantined: true }),
        acct('b', 'B', [{ kind: 'weekly_all', percent: 0 }], { quarantined: true }),
      ],
      opts,
    );
    expect(plan.recommendedAccountId).toBeNull();
    expect(plan.reason).toMatch(/quarantined/i);
    expect(plan.advisories.filter((x) => x.kind === 'quarantined')).toHaveLength(2);
  });

  it('keeps unusable-account scores finite so the plan survives JSON serialization', () => {
    // Regression: -Infinity scores JSON.stringify to null, which fails the wire schema's
    // z.number() on the bot side and silently drops the whole usage.snapshot frame —
    // exactly when an account is quarantined/exhausted and visibility matters most.
    const plan = computePlan(
      [
        acct('a', 'Healthy', [{ kind: 'weekly_all', percent: 20 }]),
        acct('b', 'Jailed', [{ kind: 'weekly_all', percent: 0 }], { quarantined: true }),
        acct('c', 'Empty', [{ kind: 'weekly_all', percent: 100 }]),
      ],
      opts,
    );
    for (const entry of plan.ranking) expect(Number.isFinite(entry.score)).toBe(true);
    // Unusable accounts still sink below every usable one.
    const jailed = plan.ranking.find((r) => r.accountId === 'b');
    const healthy = plan.ranking.find((r) => r.accountId === 'a');
    expect(jailed && healthy && jailed.score < healthy.score).toBe(true);
    // The full round-trip preserves numbers (no null holes where scores were).
    const revived = JSON.parse(JSON.stringify(plan)) as typeof plan;
    expect(revived.ranking.map((r) => typeof r.score)).toEqual(plan.ranking.map(() => 'number'));
  });
});

describe('computePlan — the ranking must survive JSON', () => {
  // An unusable account scores -Infinity internally. JSON.stringify turns that into "null",
  // which the numeric wire field rejects — and the transport drops the ENTIRE plan frame, so
  // one quarantined account silently blinds every usage view until it is un-quarantined.
  it('serializes an unusable account to a finite score that survives a JSON round-trip', () => {
    const plan = computePlan(
      [
        acct('good', 'Good', [{ kind: 'weekly_all', percent: 10 }]),
        acct('dead', 'Dead', [{ kind: 'weekly_all', percent: 0 }], { quarantined: true }),
      ],
      opts,
    );

    const dead = plan.ranking.find((r) => r.accountId === 'dead');
    expect(dead).toBeDefined();
    expect(Number.isFinite(dead?.score)).toBe(true);

    // The real regression: every score must still be a number on the far side of the wire.
    const roundTripped = JSON.parse(JSON.stringify(plan)) as typeof plan;
    for (const rank of roundTripped.ranking) {
      expect(typeof rank.score, `score for ${rank.accountId} must survive JSON`).toBe('number');
    }
  });

  it('still ranks an unusable account below every usable one', () => {
    const plan = computePlan(
      [
        acct('dead', 'Dead', [{ kind: 'weekly_all', percent: 0 }], { quarantined: true }),
        // Near its cap, so the risk penalty drives its usable score negative — the unusable
        // floor has to sit below even this, not merely below zero.
        acct('thin', 'Thin', [{ kind: 'weekly_all', percent: 97 }]),
      ],
      opts,
    );

    const score = (id: string) => plan.ranking.find((r) => r.accountId === id)?.score ?? 0;
    expect(score('dead')).toBeLessThan(score('thin'));
    expect(plan.ranking[plan.ranking.length - 1]?.accountId).toBe('dead');
  });
});

describe('computePlan — burn-before-reset (the core behavior)', () => {
  it('prefers the account whose unused weekly quota is about to reset over one with more headroom', () => {
    // A: 40% unused, resets in 2h (at risk). B: 80% unused, resets in 6 days (safe reserve).
    const a = acct('a', 'Burnme', [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 2 * HOUR }]);
    const b = acct('b', 'Reserve', [{ kind: 'weekly_all', percent: 20, resetsAt: NOW + 6 * DAY }]);
    const plan = computePlan([b, a], opts); // note: input order shouldn't matter

    expect(plan.recommendedAccountId).toBe('a');
    // The single reason line carries the whole strategy: burn order plus the held reserve.
    expect(plan.reason).toBe(
      'Burn Burnme (40% weekly left, resets in 2h); hold Reserve (weekly resets in 6d).',
    );
    // The queue is no longer duplicated as per-account advisories — the reason IS the plan.
    expect(plan.advisories).toEqual([]);
    // B ranks below A despite more headroom, because A's quota is at risk.
    expect(plan.ranking[0]?.accountId).toBe('a');
  });

  it('never treats an expiring SESSION window as burnable quota (the 5h window rolls back)', () => {
    // The owner's real trio: legoboy's empty session resets soonest, but its weekly budget
    // is safe for 7 days — the old algorithm said "burn legoboy"; the right call is to burn
    // the soonest-expiring WEEKLY budgets: jina25 (9h) then tjin.29 (19h).
    const legoboy = acct('lego', 'legoboy', [
      { kind: 'session', percent: 1, resetsAt: NOW + 4 * HOUR },
      { kind: 'weekly_all', percent: 0, resetsAt: NOW + 7 * DAY },
    ]);
    const jina = acct(
      'jina',
      'jina25',
      [
        { kind: 'session', percent: 5, resetsAt: NOW + 5 * HOUR },
        { kind: 'weekly_all', percent: 52, resetsAt: NOW + 9 * HOUR },
      ],
      { active: true },
    );
    const tjin = acct('tjin', 'tjin.29', [
      { kind: 'session', percent: 0, resetsAt: NOW + 4 * HOUR },
      { kind: 'weekly_all', percent: 20, resetsAt: NOW + 19 * HOUR },
    ]);
    const plan = computePlan([legoboy, jina, tjin], opts);

    expect(plan.recommendedAccountId).toBe('jina');
    expect(plan.reason).toBe(
      'Burn jina25 (48% weekly left, resets in 9h) → tjin.29 (80% weekly left, in 19h); ' +
        'hold legoboy (weekly resets in 7d).',
    );
    expect(plan.advisories).toEqual([]);
  });

  it('phrases the plan descriptively when greedy auto-switch executes it', () => {
    const a = acct('a', 'Burnme', [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 2 * HOUR }]);
    const b = acct('b', 'Reserve', [{ kind: 'weekly_all', percent: 20, resetsAt: NOW + 6 * DAY }]);
    const plan = computePlan([a, b], { ...opts, greedyAutoSwitch: true });
    expect(plan.reason).toBe(
      'Greedy auto-switch burns Burnme (40% weekly left, resets in 2h); ' +
        'hold Reserve (weekly resets in 6d).',
    );
    // The queue itself is identical — only the wording changes.
    expect(plan.recommendedAccountId).toBe('a');
  });

  it('falls back to headroom advice for a weekly reset outside the urgent window', () => {
    const a = acct('a', 'A', [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 3 * DAY }]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('A has the most available headroom (40%).');
    expect(plan.advisories.some((x) => x.kind === 'burn_before_reset')).toBe(false);
  });

  it('ignores an imminent weekly reset with only trivial unused quota', () => {
    // Only 5% unused — below the significance threshold, so not worth burning.
    const a = acct('a', 'A', [{ kind: 'weekly_all', percent: 95, resetsAt: NOW + 1 * HOUR }]);
    const plan = computePlan([a], opts);
    expect(plan.reason).not.toMatch(/burn/i);
    expect(plan.advisories.some((x) => x.kind === 'burn_before_reset')).toBe(false);
  });
});

describe('computePlan — risk and exhaustion', () => {
  it('avoids a near-cap account in favor of one with real headroom', () => {
    const nearCap = acct('a', 'NearCap', [{ kind: 'weekly_all', percent: 95 }]); // 5% headroom
    const healthy = acct('b', 'Healthy', [{ kind: 'weekly_all', percent: 40 }]); // 60% headroom
    const plan = computePlan([nearCap, healthy], opts);
    expect(plan.recommendedAccountId).toBe('b');
    expect(plan.reason).toMatch(/most available headroom/i);
  });

  it('treats an account below the usable floor as exhausted and never recommends it', () => {
    const dead = acct('a', 'Dead', [{ kind: 'weekly_all', percent: 100 }]);
    const plan = computePlan([dead], opts);
    expect(plan.recommendedAccountId).toBeNull();
    expect(plan.advisories.some((x) => x.kind === 'exhausted' && x.accountId === 'a')).toBe(true);
  });

  it('advises switching when the live account is exhausted and a healthy one exists', () => {
    const active = acct('a', 'Active', [{ kind: 'weekly_all', percent: 100 }], { active: true });
    const fresh = acct('b', 'Fresh', [{ kind: 'weekly_all', percent: 10 }]);
    const plan = computePlan([active, fresh], opts);
    expect(plan.recommendedAccountId).toBe('b');
    const switchAdv = plan.advisories.find((x) => x.kind === 'switch_now');
    expect(switchAdv?.accountId).toBe('b');
  });
});

describe('computePlan — headroom is set by the binding limit', () => {
  it('takes the minimum headroom across an account’s limits', () => {
    // Session nearly spent (10% headroom) even though weekly is fresh (70%). Binding = 10%.
    const a = acct('a', 'A', [
      { kind: 'session', percent: 90 },
      { kind: 'weekly_all', percent: 30 },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.ranking[0]?.headroomPct).toBe(10);
  });

  it('surfaces both weekly and session reset times in the ranking', () => {
    const a = acct('a', 'A', [
      { kind: 'session', percent: 50, resetsAt: NOW + 3 * HOUR },
      { kind: 'weekly_all', percent: 50, resetsAt: NOW + 4 * DAY },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.ranking[0]?.sessionResetAt).toBe(NOW + 3 * HOUR);
    expect(plan.ranking[0]?.weeklyResetAt).toBe(NOW + 4 * DAY);
  });
});

describe('computePlan — determinism', () => {
  it('produces identical plans for identical inputs regardless of account order', () => {
    const a = acct('a', 'Aaa', [{ kind: 'weekly_all', percent: 50 }]);
    const b = acct('b', 'Bbb', [{ kind: 'weekly_all', percent: 50 }]);
    const one = computePlan([a, b], opts);
    const two = computePlan([b, a], opts);
    // Tie on score+headroom resolves by label, so both orders agree on the recommendation.
    expect(one.recommendedAccountId).toBe(two.recommendedAccountId);
    expect(one.recommendedAccountId).toBe('a'); // 'Aaa' < 'Bbb'
    expect(one.ranking.map((r) => r.accountId)).toEqual(two.ranking.map((r) => r.accountId));
  });
});

describe('computePlan — the scoped (Fable) weekly cap is not the weekly budget', () => {
  it('caps a scoped burn at the shared weekly headroom left to spend it through', () => {
    // 90% fable unused, but only 40% of the shared weekly budget remains — only 40% is
    // actually burnable, and it must be NAMED fable, never advertised as "weekly left".
    const a = acct('a', 'Mixed', [
      { kind: 'weekly_all', percent: 60 },
      { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 2 * HOUR },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn Mixed (40% fable left, resets in 2h).');
    expect(plan.ranking[0]?.note).toBe('burn: 40% fable resets soon');
  });

  it('does not advertise fable-left as burnable when the shared weekly budget is empty', () => {
    // Andrew's live case: fable quota remains, weekly_all has none. The near-empty account
    // must not be recommended as a burn target on the strength of stranded fable quota.
    const stranded = acct('a', 'Stranded', [
      { kind: 'weekly_all', percent: 97 },
      { kind: 'weekly_scoped', percent: 20, resetsAt: NOW + 2 * HOUR },
    ]);
    const healthy = acct('b', 'Healthy', [{ kind: 'weekly_all', percent: 40 }]);
    const plan = computePlan([stranded, healthy], opts);
    expect(plan.recommendedAccountId).toBe('b');
    expect(plan.reason).not.toContain('weekly left');
    expect(plan.reason).not.toContain('fable left');
  });

  it('a scoped-only account (no weekly_all reported) still burns on its own terms', () => {
    const a = acct('a', 'ScopedOnly', [
      { kind: 'weekly_scoped', percent: 40, resetsAt: NOW + 3 * HOUR },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn ScopedOnly (60% fable left, resets in 3h).');
  });

  it("ranking's weeklyResetAt is the SHARED weekly reset, not the sooner scoped one", () => {
    const a = acct('a', 'Aaa', [
      { kind: 'weekly_scoped', percent: 50, resetsAt: NOW + 1 * DAY },
      { kind: 'weekly_all', percent: 50, resetsAt: NOW + 4 * DAY },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.ranking[0]?.weeklyResetAt).toBe(NOW + 4 * DAY);
  });
});
