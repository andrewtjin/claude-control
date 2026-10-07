import { describe, it, expect } from 'vitest';
import {
  assessAccount,
  assessFleet,
  describeFirstBack,
  describeUnavailable,
  hasUsableHeadroom,
  MIN_USABLE_HEADROOM_PCT,
} from './availability.js';
import { computePlan } from './advisor.js';
import type { AccountUsageInput, LimitInput } from './types.js';

const NOW = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;

function acct(
  id: string,
  overrides: Partial<AccountUsageInput> = {},
  limits: LimitInput[] = [],
): AccountUsageInput {
  return { accountId: id, label: id, active: false, quarantined: false, limits, ...overrides };
}

/** An account out of its 5-hour window only, back when that window resets. */
function sessionSpent(id: string, resetsInH: number): AccountUsageInput {
  return acct(id, {}, [
    { kind: 'session', percent: 100, resetsAt: NOW + resetsInH * H },
    { kind: 'weekly_all', percent: 60, resetsAt: NOW + 72 * H },
  ]);
}

describe('assessAccount', () => {
  it('names the binding limit, its percent and when it resets', () => {
    const a = assessAccount(sessionSpent('a', 2), NOW);
    expect(a).toMatchObject({ usable: false, measured: true, reason: 'session', percent: 100 });
    expect(a.backAt).toBe(NOW + 2 * H);
    expect(a.spent.map((l) => l.kind)).toEqual(['session']);
  });

  it('is back only when EVERY limit at the wall has reset, not the first one', () => {
    const both = acct('a', {}, [
      { kind: 'session', percent: 100, resetsAt: NOW + 2 * H },
      { kind: 'weekly_all', percent: 99, resetsAt: NOW + 30 * H },
    ]);
    const a = assessAccount(both, NOW);
    // The 5-hour window is the worse limit and names the reason, but the account still waits
    // for the week before it is back.
    expect(a.reason).toBe('session');
    expect(a.backAt).toBe(NOW + 30 * H);
  });

  it('a wall with no known reset makes the return time unknown', () => {
    const a = assessAccount(acct('a', {}, [{ kind: 'weekly_scoped', percent: 100 }]), NOW);
    expect(a.usable).toBe(false);
    expect(a.backAt).toBeUndefined();
  });

  it('falls back to the predicted weekly reset, and says it is predicted', () => {
    const a = assessAccount(
      acct('a', { predictedResetAt: NOW + 40 * H }, [{ kind: 'weekly_all', percent: 100 }]),
      NOW,
    );
    expect(a.backAt).toBe(NOW + 40 * H);
    expect(a.backAtPredicted).toBe(true);
  });

  it('ignores a prediction that is already in the past', () => {
    const a = assessAccount(
      acct('a', { predictedResetAt: NOW - H }, [{ kind: 'weekly_all', percent: 100 }]),
      NOW,
    );
    expect(a.backAt).toBeUndefined();
  });

  it('a dead login is out whatever the quota says, with no clock to come back on', () => {
    const a = assessAccount(
      acct('q', { quarantined: true }, [{ kind: 'session', percent: 3, resetsAt: NOW + 2 * H }]),
      NOW,
    );
    expect(a).toMatchObject({ usable: false, reason: 'quarantined', measured: true });
    expect(a.backAt).toBeUndefined();
    expect(a.spent).toEqual([]);
  });

  it('no live numbers = usable but NOT measured, so a failed poll can be told apart', () => {
    expect(assessAccount(acct('fresh'), NOW)).toMatchObject({ usable: true, measured: false });
    // Every window it had has reset: also usable and unmeasured.
    const rested = acct('r', {}, [{ kind: 'session', percent: 100, resetsAt: NOW - H }]);
    expect(assessAccount(rested, NOW)).toMatchObject({ usable: true, measured: false });
  });

  it('holds exactly at the exhausted bar, like hasUsableHeadroom', () => {
    const at = (percent: number) =>
      acct('a', {}, [{ kind: 'weekly_all', percent, resetsAt: NOW + 48 * H }]);
    expect(assessAccount(at(100 - MIN_USABLE_HEADROOM_PCT), NOW).usable).toBe(true);
    expect(assessAccount(at(100 - MIN_USABLE_HEADROOM_PCT + 0.5), NOW).usable).toBe(false);
  });

  it('the Fable cap counts by default and drops out when the policy ignores it', () => {
    const capped = acct('f', {}, [
      { kind: 'session', percent: 10, resetsAt: NOW + 4 * H },
      { kind: 'weekly_all', percent: 40, resetsAt: NOW + 48 * H },
      { kind: 'weekly_scoped', percent: 100, resetsAt: NOW + 20 * H },
    ]);
    expect(assessAccount(capped, NOW)).toMatchObject({ usable: false, reason: 'weekly_scoped' });
    expect(assessAccount(capped, NOW, { fableCapTriggers: false })).toMatchObject({
      usable: true,
      percent: 40,
    });
  });

  it('hasUsableHeadroom is the same verdict, every limit counted', () => {
    const cases = [
      sessionSpent('a', 2),
      acct('fresh'),
      acct('q', { quarantined: true }),
      acct('f', {}, [{ kind: 'weekly_scoped', percent: 100, resetsAt: NOW + H }]),
      acct('ok', {}, [{ kind: 'weekly_all', percent: 50, resetsAt: NOW + H }]),
    ];
    for (const c of cases) expect(hasUsableHeadroom(c, NOW)).toBe(assessAccount(c, NOW).usable);
  });
});

describe('assessFleet', () => {
  it('is exhausted only when every account is out', () => {
    expect(assessFleet([sessionSpent('a', 2), sessionSpent('b', 3)], NOW).exhausted).toBe(true);
    const oneLeft = [sessionSpent('a', 2), acct('b', {}, [{ kind: 'session', percent: 50 }])];
    expect(assessFleet(oneLeft, NOW).exhausted).toBe(false);
  });

  it('an account nobody has measured keeps the fleet available (unknown is not exhausted)', () => {
    expect(assessFleet([sessionSpent('a', 2), acct('never-polled')], NOW).exhausted).toBe(false);
  });

  it('an excluded account with quota left keeps the fleet available', () => {
    const excluded = acct('x', { autoSwitchExcluded: true }, [{ kind: 'session', percent: 5 }]);
    expect(assessFleet([sessionSpent('a', 2), excluded], NOW).exhausted).toBe(false);
  });

  it('a fleet of no accounts is not exhausted', () => {
    expect(assessFleet([], NOW)).toMatchObject({ exhausted: false, accounts: [] });
  });

  it('names the account back soonest, ties broken by label', () => {
    const fleet = assessFleet(
      [
        sessionSpent('c', 3),
        sessionSpent('b', 1),
        sessionSpent('a', 1),
        acct('q', { quarantined: true }),
      ],
      NOW,
    );
    expect(fleet.firstBack).toEqual({ accountId: 'a', label: 'a', at: NOW + H, predicted: false });
  });

  it('dead logins and unknown resets leave no first-back answer', () => {
    const fleet = assessFleet(
      [acct('q', { quarantined: true }), acct('u', {}, [{ kind: 'weekly_all', percent: 100 }])],
      NOW,
    );
    expect(fleet.exhausted).toBe(true);
    expect(fleet.firstBack).toBeUndefined();
  });
});

describe('describing an exhausted fleet', () => {
  it('describes each account the same way everywhere', () => {
    expect(describeUnavailable(assessAccount(sessionSpent('work2', 2), NOW), NOW)).toBe(
      'work2 (5-hour window 100%, back in 2h)',
    );
    expect(describeUnavailable(assessAccount(acct('q', { quarantined: true }), NOW), NOW)).toBe(
      'q (login expired)',
    );
    const predicted = assessAccount(
      acct('p', { predictedResetAt: NOW + 26 * H }, [{ kind: 'weekly_all', percent: 100 }]),
      NOW,
    );
    expect(describeUnavailable(predicted, NOW)).toBe(
      'p (weekly budget 100%, back in 1d 2h (predicted))',
    );
    const unknown = assessAccount(acct('u', {}, [{ kind: 'weekly_scoped', percent: 99 }]), NOW);
    expect(describeUnavailable(unknown, NOW)).toBe('u (Fable weekly cap 99%, reset time unknown)');
  });

  it('says when the first account is back, or why nobody knows', () => {
    expect(describeFirstBack(assessFleet([sessionSpent('a', 2)], NOW), NOW)).toBe(
      'First back: a in 2h.',
    );
    expect(describeFirstBack(assessFleet([acct('q', { quarantined: true })], NOW), NOW)).toMatch(
      /cctl accounts reauth/,
    );
    expect(
      describeFirstBack(
        assessFleet([acct('u', {}, [{ kind: 'weekly_all', percent: 100 }])], NOW),
        NOW,
      ),
    ).toBe('No reset time is known for any of them.');
  });
});

describe('an account out on more than one limit', () => {
  it('is described by every wall, so the reason and the return time never name different limits', () => {
    const a = assessAccount(
      acct('work1', {}, [
        { kind: 'session', percent: 100, resetsAt: NOW + H },
        { kind: 'weekly_all', percent: 99, resetsAt: NOW + 72 * H },
      ]),
      NOW,
    );
    expect(describeUnavailable(a, NOW)).toBe(
      'work1 (5-hour window 100% and weekly budget 99%, back in 3d)',
    );
  });
});

describe('the advisor reads the same rule', () => {
  it('with the Fable cap opted out, a Fable-capped fleet is usable to the plan too', () => {
    const capped = (id: string, active = false) =>
      acct('', { accountId: id, label: id, active }, [
        { kind: 'session', percent: 20, resetsAt: NOW + 3 * H },
        { kind: 'weekly_all', percent: 40, resetsAt: NOW + 72 * H },
        { kind: 'weekly_scoped', percent: 100, resetsAt: NOW + 30 * H },
      ]);
    const inputs = [capped('work1', true), capped('work2')];
    const plan = computePlan(inputs, {
      now: () => NOW,
      autoSwitchPolicy: { fableCapTriggers: false },
    });
    expect(assessFleet(inputs, NOW, { fableCapTriggers: false }).exhausted).toBe(false);
    expect(plan.reason).not.toMatch(/^No usable account/);
    // And with the cap counted, both say every account is out.
    const counted = computePlan(inputs, { now: () => NOW });
    expect(assessFleet(inputs, NOW).exhausted).toBe(true);
    expect(counted.reason).toMatch(/^No usable account/);
  });

  it('a limit whose reset has passed holds nothing back, in the plan as in the rule', () => {
    const rested = (id: string, active = false) =>
      acct('', { accountId: id, label: id, active }, [
        { kind: 'session', percent: 100, resetsAt: NOW - 5 * 60_000 },
      ]);
    const inputs = [rested('work1', true), rested('work2')];
    const plan = computePlan(inputs, { now: () => NOW });
    expect(inputs.map((i) => assessAccount(i, NOW).usable)).toEqual([true, true]);
    expect(plan.ranking.every((r) => r.score > Number.MIN_SAFE_INTEGER)).toBe(true);
    expect(plan.reason).not.toMatch(/^No usable account/);
  });
});
