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
  extra: {
    active?: boolean;
    quarantined?: boolean;
    predictedResetAt?: number;
    autoSwitchExcluded?: boolean;
  } = {},
): AccountUsageInput {
  return {
    accountId,
    label,
    active: extra.active ?? false,
    quarantined: extra.quarantined ?? false,
    limits,
    ...(extra.predictedResetAt !== undefined ? { predictedResetAt: extra.predictedResetAt } : {}),
    ...(extra.autoSwitchExcluded !== undefined
      ? { autoSwitchExcluded: extra.autoSwitchExcluded }
      : {}),
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

  it('never names an excluded account as a greedy burn target, and says why it is held', () => {
    // Locked has the soonest-expiring budget and would head the queue, but the daemon is the
    // one executing this plan and auto-switch will never hop there — so the line must not
    // promise a burn that cannot happen.
    const locked = acct(
      'x',
      'Locked',
      [{ kind: 'weekly_all', percent: 50, resetsAt: NOW + HOUR }],
      {
        autoSwitchExcluded: true,
      },
    );
    const burnme = acct('a', 'Burnme', [
      { kind: 'weekly_all', percent: 60, resetsAt: NOW + 2 * HOUR },
    ]);
    const reserve = acct('b', 'Reserve', [
      { kind: 'weekly_all', percent: 20, resetsAt: NOW + 6 * DAY },
    ]);
    const plan = computePlan([burnme, locked, reserve], { ...opts, greedyAutoSwitch: true });
    expect(plan.reason).toBe(
      'Greedy auto-switch burns Burnme (40% weekly left, resets in 2h); ' +
        'hold Locked (weekly resets in 1h) (excluded from auto-switch), ' +
        'Reserve (weekly resets in 6d).',
    );
    expect(plan.recommendedAccountId).toBe('a');
  });

  it('keeps an excluded account burnable when the advice is for a human, and labels it', () => {
    // Greedy off: nothing executes this plan, so the operator may still switch by hand — the
    // queue keeps its true order and only gains the label.
    const locked = acct(
      'x',
      'Locked',
      [{ kind: 'weekly_all', percent: 50, resetsAt: NOW + HOUR }],
      {
        autoSwitchExcluded: true,
      },
    );
    const burnme = acct('a', 'Burnme', [
      { kind: 'weekly_all', percent: 60, resetsAt: NOW + 2 * HOUR },
    ]);
    const plan = computePlan([burnme, locked], opts);
    expect(plan.reason).toBe(
      'Burn Locked (50% weekly left, resets in 1h) (excluded from auto-switch) → ' +
        'Burnme (40% weekly left, in 2h).',
    );
    expect(plan.recommendedAccountId).toBe('x');
  });

  it('still recommends the only usable account when greedy and every account is excluded', () => {
    // Nothing to hop to means the fleet keeps running on what is live — claiming "no usable
    // account" would be false, and the phone would show an outage that is not happening.
    const only = acct('a', 'Solo', [{ kind: 'weekly_all', percent: 20 }], {
      active: true,
      autoSwitchExcluded: true,
    });
    const plan = computePlan([only], { ...opts, greedyAutoSwitch: true });
    expect(plan.recommendedAccountId).toBe('a');
  });

  it('still burns the LIVE account when it is the excluded one', () => {
    // Exclusion bars hops TO an account; the fleet is already on this one, so burning its
    // soonest-expiring budget needs no switch at all. Demoting it to a hold would have the
    // plan advertise a hop away that auto-switch will never make — it only fires when someone
    // ELSE expires sooner — while the fleet quietly burns the budget the line called held.
    const live = acct('a', 'Live', [{ kind: 'weekly_all', percent: 50, resetsAt: NOW + HOUR }], {
      active: true,
      autoSwitchExcluded: true,
    });
    const other = acct('b', 'Other', [
      { kind: 'weekly_all', percent: 60, resetsAt: NOW + 5 * HOUR },
    ]);
    const plan = computePlan([live, other], { ...opts, greedyAutoSwitch: true });
    expect(plan.reason).toBe(
      'Greedy auto-switch burns Live (50% weekly left, resets in 1h) (excluded from auto-switch) → ' +
        'Other (40% weekly left, in 5h).',
    );
    expect(plan.recommendedAccountId).toBe('a');
  });

  it('keeps the excluded live account as the recommendation when there is nothing to burn', () => {
    // Same rule on the no-burn path: filtering the live account out of the pool would print a
    // superlative about a less healthy account while the ranking in the same payload shows the
    // live one scoring far higher, and nothing forces a hop off a healthy account anyway.
    const alpha = acct(
      'a',
      'Alpha',
      [
        { kind: 'session', percent: 5 },
        { kind: 'weekly_all', percent: 5 },
      ],
      { active: true, autoSwitchExcluded: true },
    );
    const bravo = acct('b', 'Bravo', [
      { kind: 'session', percent: 60 },
      { kind: 'weekly_all', percent: 60 },
    ]);
    const plan = computePlan([alpha, bravo], { ...opts, greedyAutoSwitch: true });
    expect(plan.recommendedAccountId).toBe('a');
    expect(plan.reason).toBe(
      'Alpha has the most available headroom (95%) (excluded from auto-switch).',
    );
  });

  it('never promises a hop to an excluded account when the live one is out of quota', () => {
    // The only spare is excluded, so auto-switch has nowhere to go. Naming it anyway would
    // leave the operator waiting for a recovery that never arrives instead of switching by
    // hand — the plan says there is no target rather than inventing one.
    const live = acct(
      'a',
      'Live',
      [
        { kind: 'session', percent: 100 },
        { kind: 'weekly_all', percent: 99 },
      ],
      { active: true },
    );
    const spare = acct('b', 'Spare', [{ kind: 'weekly_all', percent: 20 }], {
      autoSwitchExcluded: true,
    });
    const plan = computePlan([live, spare], { ...opts, greedyAutoSwitch: true });
    expect(plan.recommendedAccountId).toBeNull();
    expect(plan.advisories.some((x) => x.kind === 'switch_now')).toBe(false);
    expect(plan.reason).toBe(
      'No auto-switch target: every usable account is excluded from auto-switch.',
    );
  });

  it('names a sole excluded burn candidate as manual work instead of dropping it', () => {
    // Greedy filtering empties the queue here. The expiring budget is still the most
    // actionable fact on the fleet — nothing automatic will burn it, and the operator can —
    // so it must not vanish from the line along with the queue.
    const live = acct(
      'a',
      'Live',
      [{ kind: 'weekly_all', percent: 30, resetsAt: NOW + 200 * HOUR }],
      { active: true },
    );
    const locked = acct(
      'x',
      'Locked',
      [{ kind: 'weekly_all', percent: 40, resetsAt: NOW + HOUR }],
      {
        autoSwitchExcluded: true,
      },
    );
    const plan = computePlan([live, locked], { ...opts, greedyAutoSwitch: true });
    expect(plan.reason).toBe(
      'Burn by hand: Locked (60% weekly left, resets in 1h) (excluded from auto-switch); ' +
        'hold Live (weekly resets in 8d 8h).',
    );
    // The recommendation is still somewhere auto-switch may actually go.
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

describe('computePlan — the Fable sub-cap is not a second weekly budget', () => {
  it('never reads the scoped cap as burnable budget when the weekly budget is nearly spent', () => {
    // The endpoint reports both weekly limits on one clock: the overall budget (94% used) and
    // the Fable sub-cap inside it (47% used). Only 6% of the week is actually left, which is
    // under the significance floor — so there is nothing here to burn. Reading the sub-cap as
    // budget of its own turns this into "53% weekly left" and recommends the fleet's most
    // drained account.
    const drained = acct('drained', 'drained', [
      { kind: 'weekly_all', percent: 94, resetsAt: NOW + 14 * HOUR },
      { kind: 'weekly_scoped', percent: 47, resetsAt: NOW + 14 * HOUR },
    ]);
    const reserve = acct('reserve', 'reserve', [
      { kind: 'weekly_all', percent: 20, resetsAt: NOW + 6 * DAY },
      { kind: 'weekly_scoped', percent: 3, resetsAt: NOW + 6 * DAY },
    ]);
    const plan = computePlan([drained, reserve], opts);

    expect(plan.reason).not.toMatch(/burn/i);
    expect(plan.reason).not.toMatch(/53%/);
    expect(plan.recommendedAccountId).toBe('reserve');
    // The ranking must not advertise the sub-cap's slack either.
    expect(plan.ranking.find((r) => r.accountId === 'drained')?.note).not.toMatch(/burn/i);
  });

  it('quotes the weekly budget, not the sub-cap, for an account that IS worth burning', () => {
    // Same two-limit shape, but the budget itself has real slack left: the advice must carry
    // the budget's 45%, never the sub-cap's 90%.
    const a = acct('a', 'A', [
      { kind: 'weekly_all', percent: 55, resetsAt: NOW + 2 * HOUR },
      { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 2 * HOUR },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn A (45% weekly left, resets in 2h).');
    expect(plan.ranking[0]?.note).toBe('burn: 45% weekly resets soon');
  });

  it('ranks the burn queue by weekly budget, so a full sub-cap cannot jump the line', () => {
    // Both budgets expire inside the window. B holds more budget and resets sooner, so it
    // leads; A's untouched sub-cap must not promote it.
    const a = acct('a', 'A', [
      { kind: 'weekly_all', percent: 70, resetsAt: NOW + 9 * HOUR },
      { kind: 'weekly_scoped', percent: 0, resetsAt: NOW + 9 * HOUR },
    ]);
    const b = acct('b', 'B', [
      { kind: 'weekly_all', percent: 40, resetsAt: NOW + 3 * HOUR },
      { kind: 'weekly_scoped', percent: 35, resetsAt: NOW + 3 * HOUR },
    ]);
    const plan = computePlan([a, b], opts);
    expect(plan.recommendedAccountId).toBe('b');
    expect(plan.reason).toBe(
      'Burn B (60% weekly left, resets in 3h) → A (30% weekly left, in 9h).',
    );
  });

  it('says "weekly (fable)" when the sub-cap is the only weekly reading the account has', () => {
    // No `weekly_all` entry at all, so the sub-cap legitimately stands in as the budget —
    // but the advice names it rather than passing a Fable-only figure off as the whole week.
    const a = acct('a', 'A', [{ kind: 'weekly_scoped', percent: 40, resetsAt: NOW + 2 * HOUR }]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn A (60% weekly (fable) left, resets in 2h).');
    expect(plan.ranking[0]?.note).toBe('burn: 60% weekly (fable) resets soon');
  });

  it('takes the sub-cap reset as the clock while still quoting the budget percent', () => {
    // The endpoint sometimes drops `resets_at` from one of the pair. They are two views of one
    // weekly window, so the surviving reset is the honest clock — with the budget's percent.
    const a = acct('a', 'A', [
      { kind: 'weekly_all', percent: 55 },
      { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 2 * HOUR },
    ]);
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn A (45% weekly left, resets in 2h).');
  });

  it('labels a burn deadline that came from a prediction rather than the endpoint', () => {
    // Once a weekly window closes the endpoint stops publishing its reset; history predicts
    // the next one. Burning is an action, so the inferred deadline is marked as inferred.
    const a = acct('a', 'A', [{ kind: 'weekly_all', percent: 55 }], {
      predictedResetAt: NOW + 2 * HOUR,
    });
    const plan = computePlan([a], opts);
    expect(plan.reason).toBe('Burn A (45% weekly left, resets in 2h (predicted)).');
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
});
