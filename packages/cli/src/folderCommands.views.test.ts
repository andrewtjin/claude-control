// Unit coverage for the pure halves of the folder-rule commands: account references, the views
// `cctl folders` / `where` / `accounts list` build, what a rule change did in words, and the slot
// `cctl switch` asserts.

import { describe, it, expect } from 'vitest';
import {
  SlotError,
  type AccountView,
  type FolderRule,
  type PoolEntry,
} from '@claude-control/switch-engine';
import { PLAIN_PALETTE } from './ansi.js';
import {
  buildLiveView,
  buildPoolView,
  buildReservedViews,
  describeExclude,
  describeInclude,
  describeReset,
  describeSlotRefusal,
  parseAccountList,
  resolveAccountRefOrEmail,
  slotName,
  switchSlotOf,
  type ChangeContext,
} from './folderCommands.js';

/** A folder path in this platform's shape, so folder matching runs the way it does for real. */
const F = (name: string): string =>
  process.platform === 'win32' ? `C:\\repos\\${name}` : `/repos/${name}`;

const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  label: id.toUpperCase(),
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const rule = (id: string, over: Partial<FolderRule> = {}): FolderRule => ({
  id,
  label: id,
  folders: [F(id)],
  include: [],
  exclude: [],
  activeId: null,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const poolEntry = (a: AccountView, over: Partial<PoolEntry> = {}): PoolEntry => ({
  account: a,
  source: 'inherited',
  autoTarget: true,
  liveElsewhere: null,
  ...over,
});

const session = (pid: number) => ({ pid, cwd: F('research'), sessionFile: `${pid}.json` });

describe('parseAccountList', () => {
  it('splits on commas, trims, and drops empties', () => {
    expect(parseAccountList(' a, b,,c ')).toEqual(['a', 'b', 'c']);
  });

  it('yields nothing for an argument with no account in it, never a default', () => {
    expect(parseAccountList(',')).toEqual([]);
    expect(parseAccountList('  ')).toEqual([]);
  });
});

describe('resolveAccountRefOrEmail', () => {
  const all = [
    account('a', { label: 'work', emailAddress: 'Work@Example.com' }),
    account('b', { label: 'research', emailAddress: 'r@example.com' }),
    account('c', { label: 'other', emailAddress: 'r@example.com' }),
  ];

  it('resolves an id or a label first, as every account command does', () => {
    expect(resolveAccountRefOrEmail(all, 'a')).toMatchObject({ ok: true, account: { id: 'a' } });
    expect(resolveAccountRefOrEmail(all, 'research')).toMatchObject({
      ok: true,
      account: { id: 'b' },
    });
  });

  it('falls back to the email, case-insensitively', () => {
    expect(resolveAccountRefOrEmail(all, 'work@example.com')).toMatchObject({
      ok: true,
      account: { id: 'a' },
    });
  });

  it('refuses an email two accounts share rather than guessing', () => {
    const r = resolveAccountRefOrEmail(all, 'r@example.com');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('use the label or the id');
  });

  it('reports an unknown ref as no match', () => {
    const r = resolveAccountRefOrEmail(all, 'ghost');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toBe('No account matches "ghost".');
  });
});

describe('slotName', () => {
  it('names the global slot and a folder slot by its folders', () => {
    const rules = [rule('r1', { folders: [F('a'), F('b')] })];
    expect(slotName('global', rules)).toBe('the global slot');
    expect(slotName('group:r1', rules)).toBe(`the folder slot of ${F('a')}, ${F('b')}`);
    expect(slotName('group:gone', rules)).toContain('no longer exists');
  });
});

describe('buildLiveView', () => {
  const e = account('e', { ruleIds: ['r1'] });
  const a = account('a');
  const d = account('d');
  const q = account('q', { quarantined: true });
  const r1 = rule('r1', { include: ['e'], exclude: ['d'] });
  const all = [e, a, d, q];

  it('says whether the live account is included, inherited or outside the pool', () => {
    expect(buildLiveView('e', r1, all)).toEqual({
      label: 'E',
      source: 'include',
      quarantined: false,
    });
    expect(buildLiveView('a', r1, all)?.source).toBe('inherited');
    expect(buildLiveView('d', r1, all)?.source).toBe('outside');
    expect(buildLiveView('e', undefined, all)?.source).toBe('outside');
    expect(buildLiveView('a', undefined, all)?.source).toBe('inherited');
  });

  it('carries quarantine, and null for an empty slot', () => {
    expect(buildLiveView('q', r1, all)?.quarantined).toBe(true);
    expect(buildLiveView(null, r1, all)).toBeNull();
  });
});

describe('buildPoolView', () => {
  const e = account('e', { ruleIds: ['r1'] });
  const b = account('b', { ruleIds: ['r1'], quarantined: true });
  const a = account('a');
  const c = account('c', { autoSwitchExcluded: true });
  const dead = account('x', { quarantined: true });
  const d = account('d', { quarantined: true });
  const r1 = rule('r1', { include: ['e', 'b'], exclude: ['d'] });
  const r2 = rule('r2');
  const rules = [r1, r2];
  const all = [a, c, dead, d, e, b];

  it('puts quarantined accounts back where they sit, and words where others are live', () => {
    // The engine's pool leaves quarantined accounts out.
    const pool = [
      poolEntry(e, { source: 'include' }),
      poolEntry(a, { liveElsewhere: 'group:r2' }),
      poolEntry(c, { autoTarget: false }),
    ];
    const view = buildPoolView(r1, pool, 'e', all, rules);
    expect(view.map((v) => v.label)).toEqual(['E', 'B', 'A', 'C', 'X']);
    expect(view[0]).toMatchObject({ source: 'include', live: true, quarantined: false });
    expect(view[1]).toMatchObject({ source: 'include', quarantined: true });
    expect(view[2]).toMatchObject({ liveElsewhere: `the folder slot of ${F('r2')}` });
    expect(view[3]).toMatchObject({ autoTarget: false });
    // A dead shared account the folder excludes is not part of its pool at all.
    expect(view.some((v) => v.label === 'D')).toBe(false);
    expect(view[4]).toMatchObject({ source: 'inherited', quarantined: true });
  });

  it('builds the global pool from shared accounts only', () => {
    const view = buildPoolView(
      undefined,
      [poolEntry(a), poolEntry(c, { autoTarget: false })],
      'a',
      all,
      rules,
    );
    expect(view.map((v) => v.label)).toEqual(['A', 'C', 'X', 'D']);
    expect(view[0]?.live).toBe(true);
  });
});

describe('buildReservedViews', () => {
  it('lists every reserved account with its email, the folders including it, and liveness', () => {
    const r1 = rule('r1', { include: ['e'] });
    const r2 = rule('r2', { include: ['e', 'f'] });
    const views = buildReservedViews(
      [
        account('a'),
        account('e', { ruleIds: ['r1', 'r2'], emailAddress: 'e@example.com' }),
        account('f', { ruleIds: ['r2'] }),
      ],
      [r1, r2],
      new Map([
        ['global', 'a'],
        ['group:r2', 'e'],
      ]),
    );
    expect(views).toEqual([
      {
        id: 'e',
        label: 'E',
        email: 'e@example.com',
        quarantined: false,
        live: true,
        includedBy: [F('r1'), F('r2')],
      },
      {
        id: 'f',
        label: 'F',
        email: undefined,
        quarantined: false,
        live: false,
        includedBy: [F('r2')],
      },
    ]);
  });
});

/** A plain-palette change context over these accounts and rules. */
const ctx = (accounts: AccountView[], rules: FolderRule[]): ChangeContext => ({
  accounts,
  rules,
  vaultDir: process.platform === 'win32' ? 'C:\\data\\vault' : '/data/vault',
  palette: PLAIN_PALETTE,
});

const liveResult = (liveAccount: string | null, noWorkingAccount = false) => ({
  ruleId: 'r1',
  liveAccount,
  activated: true,
  noWorkingAccount,
});

describe('describeInclude', () => {
  const e = account('e', { ruleIds: ['r1'] });
  const f = account('f', { ruleIds: ['r1', 'r2'] });
  const a = account('a');
  const b = account('b');
  const r1 = rule('r1', { include: ['e', 'f'] });
  const r2 = rule('r2', { include: ['f'] });

  it('says what a new rule does and every place an include moved', () => {
    const out = describeInclude(
      {
        rule: r1,
        created: true,
        reserved: ['e'],
        unexcluded: [],
        handedOff: [
          { slot: 'global', from: 'e', to: 'a' },
          { slot: 'group:r2', from: 'e', to: 'b' },
        ],
        live: liveResult('e'),
        runningSessions: [session(1), session(2)],
      },
      ['e', 'f'],
      ctx([e, f, a, b], [r1, r2]),
    );
    expect(out).toContain(
      `Created a folder rule on ${F('r1')}: it uses E, F first, then the shared pool.`,
    );
    expect(out).toContain('reserved: E left the shared pool');
    expect(out).toContain(`F is also included by ${F('r2')}; those folders share it`);
    expect(out).toContain('the global slot switched off E (now reserved) and is on A.');
    expect(out).toContain(
      `the folder slot of ${F('r2')} switched off E (now reserved) and is on B.`,
    );
    expect(out).toContain("live in the folder's slot: E (included)");
    expect(out).toContain('2 running session(s) under this folder keep their current account');
    expect(out).toMatch(/profile: .*r1/);
  });

  it('names an account taken off the exclude list, and an existing rule', () => {
    const out = describeInclude(
      {
        rule: r1,
        created: false,
        reserved: ['e'],
        unexcluded: ['e'],
        handedOff: [],
        live: liveResult('a'),
        runningSessions: [],
      },
      ['e'],
      ctx([e, f, a], [r1, r2]),
    );
    expect(out).toContain(`Included E in the folder rule on ${F('r1')}.`);
    expect(out).toContain('no longer excluded here: E.');
    expect(out).toContain("live in the folder's slot: A (inherited from the shared pool)");
    expect(out).not.toContain('running session');
  });

  it('says plainly when the folder has no working account', () => {
    const out = describeInclude(
      {
        rule: r1,
        created: false,
        reserved: [],
        unexcluded: [],
        handedOff: [],
        live: liveResult(null, true),
        runningSessions: [],
      },
      ['e'],
      ctx([e, f], [r1]),
    );
    expect(out).toContain('no working account');
    expect(out).toContain('cctl accounts relogin');
  });

  it('flags a quarantined account kept live for want of another', () => {
    const out = describeInclude(
      {
        rule: r1,
        created: false,
        reserved: [],
        unexcluded: [],
        handedOff: [],
        live: liveResult('e', true),
        runningSessions: [],
      },
      ['e'],
      ctx([e, f], [r1]),
    );
    expect(out).toContain("live in the folder's slot: E, which is quarantined");
  });
});

describe('describeExclude', () => {
  const a = account('a');
  const b = account('b');
  const c = account('c');

  it('says a new exclude-only rule gets its own slot and the accounts stay usable elsewhere', () => {
    const r1 = rule('r1', { exclude: ['a', 'b'] });
    const out = describeExclude(
      { rule: r1, created: true, movedOff: null, live: liveResult('c'), runningSessions: [] },
      ['a', 'b'],
      ctx([a, b, c], [r1]),
    );
    expect(out).toContain(`Created a folder rule on ${F('r1')} that excludes A, B`);
    expect(out).toContain('in its own slot');
    expect(out).toContain('A, B stay usable everywhere else.');
    expect(out).toContain("live in the folder's slot: C (inherited from the shared pool)");
  });

  it('reports the slot moving off an excluded live account', () => {
    const r1 = rule('r1', { exclude: ['a'] });
    const out = describeExclude(
      {
        rule: r1,
        created: false,
        movedOff: 'a',
        live: liveResult('b'),
        runningSessions: [session(3)],
      },
      ['a'],
      ctx([a, b], [r1]),
    );
    expect(out).toContain(`Excluded A from the folder rule on ${F('r1')}.`);
    expect(out).toContain('A stays usable everywhere else.');
    expect(out).toContain("the folder's slot switched off A.");
    expect(out).toContain("live in the folder's slot: B");
    expect(out).toContain('1 running session(s)');
  });

  it('reports a slot cleared because nothing else was free', () => {
    const r1 = rule('r1', { exclude: ['a'] });
    const out = describeExclude(
      {
        rule: r1,
        created: false,
        movedOff: 'a',
        live: liveResult(null, true),
        runningSessions: [],
      },
      ['a'],
      ctx([a], [r1]),
    );
    expect(out).toContain("the folder's slot was cleared off A");
    expect(out).toContain('no working account');
  });
});

describe('describeReset', () => {
  const e = account('e');
  const f = account('f', { ruleIds: ['other'] });
  const a = account('a');

  it('says the whole rule is gone, what returned to the pool, and what the folder uses now', () => {
    const before = rule('r1', { include: ['e', 'f'] });
    const other = rule('other', { include: ['f'] });
    const out = describeReset(
      {
        folder: F('r1'),
        dissolved: true,
        released: ['e'],
        adoptedRotation: true,
        runningSessions: [],
      },
      before,
      null,
      ctx([e, f, a], [other]),
      undefined,
    );
    expect(out).toContain(
      `Removed the folder rule on ${F('r1')}. ${F('r1')} now uses the global slot and the shared pool.`,
    );
    expect(out).toContain('returned to the shared pool: E');
    expect(out).toContain('latest login was saved first');
    expect(out).toContain('still reserved to other folders: F.');
    expect(out).toContain('profile dir is kept');
  });

  it('names the parent rule a nested folder falls back to', () => {
    const parent = rule('parent', { folders: [F('top')] });
    const nested = process.platform === 'win32' ? `${F('top')}\\sub` : `${F('top')}/sub`;
    const out = describeReset(
      {
        folder: nested,
        dissolved: true,
        released: [],
        adoptedRotation: false,
        runningSessions: [session(1)],
      },
      rule('child', { folders: [nested] }),
      null,
      ctx([], [parent]),
      undefined,
    );
    expect(out).toContain(`now uses the folder rule on ${F('top')}.`);
    expect(out).toContain('1 running session(s) under it lost');
  });

  it('says a folder left a rule that keeps its other folders', () => {
    const kept = rule('r1', { folders: [F('b')] });
    const out = describeReset(
      {
        folder: F('a'),
        dissolved: false,
        rule: kept,
        released: [],
        adoptedRotation: false,
        runningSessions: [],
      },
      rule('r1', { folders: [F('a'), F('b')] }),
      null,
      ctx([], [kept]),
      undefined,
    );
    expect(out).toContain(`${F('a')} left its folder rule, which stays on ${F('b')}.`);
    expect(out).toContain('now uses the global slot');
  });

  it('separates named accounts that were included from ones that were excluded', () => {
    const before = rule('r1', { include: ['e', 'f'], exclude: ['a'] });
    const after = rule('r1', { include: ['e'] });
    const out = describeReset(
      {
        folder: F('r1'),
        dissolved: false,
        rule: after,
        released: [],
        adoptedRotation: false,
        runningSessions: [],
      },
      before,
      'e',
      ctx([account('e', { ruleIds: ['r1'] }), f, a], [after, rule('other', { include: ['f'] })]),
      ['f', 'a'],
    );
    expect(out).toContain(`Removed F from what ${F('r1')} includes.`);
    expect(out).toContain(`Removed A from what ${F('r1')} excludes: the folder may use it again.`);
    expect(out).toContain('still reserved to other folders: F.');
    expect(out).toContain("live in the folder's slot: E (included)");
  });

  it('names accounts a partial reset returned to the shared pool', () => {
    const before = rule('r1', { include: ['e'], exclude: ['a'] });
    const after = rule('r1', { exclude: ['a'] });
    const out = describeReset(
      {
        folder: F('r1'),
        dissolved: false,
        rule: after,
        released: ['e'],
        adoptedRotation: false,
        runningSessions: [],
      },
      before,
      null,
      ctx([e, a], [after]),
      ['e'],
    );
    expect(out).toContain('returned to the shared pool: E.');
    expect(out).toContain('no working account');
  });
});

describe('describeSlotRefusal', () => {
  it('gives each refusal its own next step and says nothing changed', () => {
    const ambiguous = describeSlotRefusal(
      new SlotError('included by several', 'slot_ambiguous'),
      'E',
    );
    expect(ambiguous).toContain('Nothing was changed');
    expect(ambiguous).toContain('cctl switch E --folder <folder>');
    expect(describeSlotRefusal(new SlotError('live in X', 'live_elsewhere'), 'E')).toContain(
      'switch that slot to another account first',
    );
    expect(describeSlotRefusal(new SlotError('excludes it', 'slot_mismatch'), 'E')).toContain(
      'cctl folder include',
    );
    expect(describeSlotRefusal(new SlotError('gone', 'rule_gone'), 'E')).toContain(
      'check cctl folders',
    );
  });
});

describe('switchSlotOf', () => {
  it('asserts the global slot for a shared account and the one rule slot for a reserved one', () => {
    expect(switchSlotOf(account('a'))).toBe('global');
    expect(switchSlotOf(account('e', { ruleIds: ['r1'] }))).toBe('group:r1');
  });

  it('asserts nothing for an account several rules include, leaving the engine to pick or refuse', () => {
    expect(switchSlotOf(account('e', { ruleIds: ['r1', 'r2'] }))).toBeUndefined();
  });
});
