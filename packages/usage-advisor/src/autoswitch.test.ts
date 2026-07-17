import { describe, it, expect } from 'vitest';
import { decideAutoSwitch } from './autoswitch.js';
import type { AccountUsageInput, LimitInput } from './types.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const H = 60 * 60 * 1000;

function acct(
  id: string,
  overrides: Partial<AccountUsageInput> = {},
  limits: LimitInput[] = [],
): AccountUsageInput {
  return { accountId: id, label: id, active: false, quarantined: false, limits, ...overrides };
}

/** An active account past the default 94% trigger on its session limit. */
function lowActive(): AccountUsageInput {
  return acct('hot', { active: true }, [
    { kind: 'session', percent: 96, resetsAt: NOW + 2 * H },
    { kind: 'weekly_all', percent: 50, resetsAt: NOW + 48 * H },
  ]);
}

describe('decideAutoSwitch — trigger conditions', () => {
  it('does nothing when no account is active', () => {
    expect(decideAutoSwitch([acct('a'), acct('b')], NOW)).toBeNull();
  });

  it('does nothing while the active account is healthy', () => {
    const active = acct('a', { active: true }, [
      { kind: 'session', percent: 50, resetsAt: NOW + 2 * H },
    ]);
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([active, spare], NOW)).toBeNull();
  });

  it('does nothing when the active account has no limit data (never act on ignorance)', () => {
    const active = acct('a', { active: true });
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([active, spare], NOW)).toBeNull();
  });

  it('triggers when the session window is nearly exhausted', () => {
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    const decision = decideAutoSwitch([lowActive(), spare], NOW);
    expect(decision?.targetAccountId).toBe('b');
  });

  it('triggers when the WEEKLY cap is nearly exhausted even with a fresh session', () => {
    const active = acct('a', { active: true }, [
      { kind: 'session', percent: 5, resetsAt: NOW + 4 * H },
      { kind: 'weekly_all', percent: 95, resetsAt: NOW + 48 * H },
    ]);
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([active, spare], NOW)?.targetAccountId).toBe('b');
  });

  it('holds below the 94% default trigger and fires exactly at it', () => {
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    const at = (percent: number) =>
      acct('a', { active: true }, [{ kind: 'session', percent, resetsAt: NOW + 2 * H }]);
    expect(decideAutoSwitch([at(93.9), spare], NOW)).toBeNull();
    expect(decideAutoSwitch([at(94), spare], NOW)?.targetAccountId).toBe('b');
  });

  it('ignores limits whose reset time is already past (stale window)', () => {
    // Session says 96% used but its window ended an hour ago — that percent is stale.
    const active = acct('a', { active: true }, [
      { kind: 'session', percent: 96, resetsAt: NOW - H },
      { kind: 'weekly_all', percent: 50, resetsAt: NOW + 48 * H },
    ]);
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([active, spare], NOW)).toBeNull();
  });

  it('respects a custom trigger threshold', () => {
    const active = acct('a', { active: true }, [
      { kind: 'session', percent: 70, resetsAt: NOW + 2 * H },
    ]);
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([active, spare], NOW)).toBeNull();
    expect(decideAutoSwitch([active, spare], NOW, { triggerPercent: 65 })?.targetAccountId).toBe(
      'b',
    );
  });
});

describe('decideAutoSwitch — candidate eligibility', () => {
  it('excludes quarantined accounts', () => {
    const spare = acct('b', { quarantined: true }, [
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H },
    ]);
    expect(decideAutoSwitch([lowActive(), spare], NOW)).toBeNull();
  });

  it('excludes candidates with less than 25% of the 5h window left', () => {
    const spare = acct('b', {}, [
      { kind: 'session', percent: 80, resetsAt: NOW + 3 * H }, // only 20% left
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H },
    ]);
    expect(decideAutoSwitch([lowActive(), spare], NOW)).toBeNull();
  });

  it('accepts a candidate at exactly the 25% headroom boundary', () => {
    const spare = acct('b', {}, [
      { kind: 'session', percent: 75, resetsAt: NOW + 3 * H },
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H },
    ]);
    expect(decideAutoSwitch([lowActive(), spare], NOW)?.targetAccountId).toBe('b');
  });

  it('treats a candidate with no open session window as having a full window', () => {
    const spare = acct('b', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 24 * H }]);
    expect(decideAutoSwitch([lowActive(), spare], NOW)?.targetAccountId).toBe('b');
  });

  it('never hops to an account that would itself immediately count as low', () => {
    const spare = acct('b', {}, [
      { kind: 'session', percent: 10, resetsAt: NOW + 3 * H },
      { kind: 'weekly_all', percent: 95, resetsAt: NOW + 24 * H }, // would re-trigger at once
    ]);
    expect(decideAutoSwitch([lowActive(), spare], NOW)).toBeNull();
  });
});

describe('decideAutoSwitch — choosing among candidates', () => {
  it('picks the candidate whose weekly quota resets soonest', () => {
    const later = acct('later', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 72 * H }]);
    const sooner = acct('sooner', {}, [
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 12 * H },
    ]);
    const decision = decideAutoSwitch([lowActive(), later, sooner], NOW);
    expect(decision?.targetAccountId).toBe('sooner');
  });

  it('uses the soonest across weekly_all AND weekly_scoped', () => {
    const scopedSooner = acct('scoped', {}, [
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 72 * H },
      { kind: 'weekly_scoped', percent: 10, resetsAt: NOW + 6 * H },
    ]);
    const plain = acct('plain', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 12 * H }]);
    expect(decideAutoSwitch([lowActive(), scopedSooner, plain], NOW)?.targetAccountId).toBe(
      'scoped',
    );
  });

  it('excludes candidates with an unknown weekly reset — the choice is BY the weekly clock', () => {
    const unknown = acct('unknown', {}, [{ kind: 'weekly_all', percent: 10 }]);
    // Unknown-only: no switch at all rather than a hop the budget rule can't justify.
    expect(decideAutoSwitch([lowActive(), unknown], NOW)).toBeNull();
    const known = acct('known', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 72 * H }]);
    expect(decideAutoSwitch([lowActive(), unknown, known], NOW)?.targetAccountId).toBe('known');
  });

  it('weekly reset time outranks session headroom — a closer reset wins even with a busier 5h window', () => {
    const freshSessionLaterReset = acct('freshSession', {}, [
      { kind: 'session', percent: 0, resetsAt: NOW + 3 * H },
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 72 * H },
    ]);
    const busySessionSoonerReset = acct('busySession', {}, [
      { kind: 'session', percent: 70, resetsAt: NOW + 3 * H }, // 30% left — eligible, but worse 5h
      { kind: 'weekly_all', percent: 10, resetsAt: NOW + 12 * H },
    ]);
    expect(
      decideAutoSwitch([lowActive(), freshSessionLaterReset, busySessionSoonerReset], NOW)
        ?.targetAccountId,
    ).toBe('busySession');
  });

  it('breaks a reset-time tie on remaining weekly budget, never on the 5h window', () => {
    // Session says pick 'lessWeeklyLeft' (fresher window); the weekly budget says otherwise.
    const lessWeeklyLeft = acct('lessWeeklyLeft', {}, [
      { kind: 'session', percent: 5, resetsAt: NOW + 3 * H },
      { kind: 'weekly_all', percent: 60, resetsAt: NOW + 24 * H },
    ]);
    const moreWeeklyLeft = acct('moreWeeklyLeft', {}, [
      { kind: 'session', percent: 70, resetsAt: NOW + 3 * H },
      { kind: 'weekly_all', percent: 20, resetsAt: NOW + 24 * H },
    ]);
    expect(
      decideAutoSwitch([lowActive(), lessWeeklyLeft, moreWeeklyLeft], NOW)?.targetAccountId,
    ).toBe('moreWeeklyLeft');
  });

  it('explains the hop weekly-first in one sentence', () => {
    const spare = acct('spare', {}, [{ kind: 'weekly_all', percent: 10, resetsAt: NOW + 13 * H }]);
    const decision = decideAutoSwitch([lowActive(), spare], NOW);
    expect(decision?.reason).toContain('hot is at 96% used');
    expect(decision?.reason).toContain('spare has the soonest weekly reset');
    expect(decision?.reason).toContain('in 13h');
    expect(decision?.reason).toContain('90% weekly budget left');
  });

  it('returns null when every other account is ineligible', () => {
    const q = acct('q', { quarantined: true });
    expect(decideAutoSwitch([lowActive(), q], NOW)).toBeNull();
    expect(decideAutoSwitch([lowActive()], NOW)).toBeNull();
  });
});
