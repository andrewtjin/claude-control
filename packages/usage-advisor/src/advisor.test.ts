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
});

describe('computePlan — burn-before-reset (the core behavior)', () => {
  it('prefers the account whose unused quota is about to reset over one with more headroom', () => {
    // A: 40% unused, resets in 2h (at risk). B: 80% unused, resets in 6 days (safe reserve).
    const a = acct('a', 'Burnme', [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 2 * HOUR }]);
    const b = acct('b', 'Reserve', [{ kind: 'weekly_all', percent: 20, resetsAt: NOW + 6 * DAY }]);
    const plan = computePlan([b, a], opts); // note: input order shouldn't matter

    expect(plan.recommendedAccountId).toBe('a');
    expect(plan.reason).toMatch(/resets soon|use it now/i);
    const burn = plan.advisories.find((x) => x.kind === 'burn_before_reset' && x.accountId === 'a');
    expect(burn).toBeDefined();
    expect(burn?.deadlineMs).toBe(NOW + 2 * HOUR);
    // B ranks below A despite more headroom, because A's quota is at risk.
    expect(plan.ranking[0]?.accountId).toBe('a');
  });

  it('does not raise a burn advisory for a reset outside the urgent window', () => {
    const a = acct('a', 'A', [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 3 * DAY }]);
    const plan = computePlan([a], opts);
    expect(plan.advisories.some((x) => x.kind === 'burn_before_reset')).toBe(false);
  });

  it('ignores an imminent reset with only trivial unused quota', () => {
    // Only 5% unused — below the significance threshold, so not worth burning.
    const a = acct('a', 'A', [{ kind: 'weekly_all', percent: 95, resetsAt: NOW + 1 * HOUR }]);
    const plan = computePlan([a], opts);
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
