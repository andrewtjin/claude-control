// The pure pool rules: which accounts each slot may hold, in what order, and which of them it can
// take right now. Exhaustive over every combination of the facts that decide it — where an account
// lives (shared, included here, reserved only elsewhere, included here and elsewhere), whether this
// rule excludes it, whether it is globally excluded or quarantined, and where it is live — because
// every engine decision about who may go where is one of these functions.

import { describe, it, expect } from 'vitest';
import {
  allSlots,
  assignDistinct,
  availableInOrder,
  describeRuleScopes,
  exactAliasRule,
  exactFolderRule,
  legitimateOccupancy,
  liveElsewhere,
  resolveFolderRule,
  resolveSessionRule,
  ruleOfSlot,
  ruleScopeCount,
  ruleScopes,
  rulesIncluding,
  scopedRuleOf,
  slotMayHold,
  slotMembers,
  slotPhrase,
  slotPool,
  withRule,
  type RulesPicture,
} from './folderRules.js';
import { ruleIdOfSlot, ruleSlotId } from './types.js';
import type { FolderRule, SlotId, StoredAccount } from './types.js';

function account(id: string, over: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label: id, quarantined: false, createdAtMs: 1, updatedAtMs: 1, ...over };
}

function rule(id: string, over: Partial<FolderRule> = {}): FolderRule {
  return {
    id,
    label: id,
    folders: [],
    include: [],
    exclude: [],
    activeId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  };
}

const GLOBAL: SlotId = 'global';
const R = ruleSlotId('r');
const R2 = ruleSlotId('r2');

type Residency = 'shared' | 'included' | 'elsewhere' | 'both';
type LiveIn = 'none' | 'global' | 'r' | 'r2';

/** Every legal combination of the facts about one account X, relative to rule r (and rule r2). An
 *  account a rule includes cannot also be excluded by it (the vault refuses that), so that pair is
 *  left out; an exclusion of an account reserved elsewhere is legal and inert. */
function* combinations(): Generator<{
  residency: Residency;
  excludedHere: boolean;
  globallyExcluded: boolean;
  quarantined: boolean;
  liveIn: LiveIn;
}> {
  for (const residency of ['shared', 'included', 'elsewhere', 'both'] as const) {
    for (const excludedHere of [false, true]) {
      if (excludedHere && (residency === 'included' || residency === 'both')) continue;
      for (const globallyExcluded of [false, true]) {
        for (const quarantined of [false, true]) {
          for (const liveIn of ['none', 'global', 'r', 'r2'] as const) {
            yield { residency, excludedHere, globallyExcluded, quarantined, liveIn };
          }
        }
      }
    }
  }
}

/** The picture and occupancy one combination describes, with X the only account. */
function scenario(c: ReturnType<typeof combinations> extends Generator<infer T> ? T : never) {
  const x = account('x', {
    quarantined: c.quarantined,
    ...(c.globallyExcluded ? { autoSwitchExcluded: true } : {}),
  });
  const reserved = c.residency !== 'shared';
  const picture: RulesPicture = {
    shared: reserved ? [] : [x],
    reserved: reserved ? [x] : [],
    rules: [
      rule('r', {
        include: c.residency === 'included' || c.residency === 'both' ? ['x'] : [],
        exclude: c.excludedHere ? ['x'] : [],
      }),
      rule('r2', { include: c.residency === 'elsewhere' || c.residency === 'both' ? ['x'] : [] }),
    ],
  };
  const occupancy = new Map<SlotId, Set<string>>([
    [GLOBAL, new Set(c.liveIn === 'global' ? ['x'] : [])],
    [R, new Set(c.liveIn === 'r' ? ['x'] : [])],
    [R2, new Set(c.liveIn === 'r2' ? ['x'] : [])],
  ]);
  return { picture, occupancy };
}

const slotOfLive: Record<LiveIn, SlotId | null> = {
  none: null,
  global: GLOBAL,
  r: R,
  r2: R2,
};

describe('slotPool — every combination of the facts about one account', () => {
  const all = [...combinations()];

  it('covers every legal combination', () => {
    // 4 residencies x 2 exclusions (minus the 2 illegal) x 2 x 2 x 4 live places.
    expect(all.length).toBe((4 * 2 - 2) * 2 * 2 * 4);
  });

  for (const c of all) {
    const name =
      `${c.residency}${c.excludedHere ? ', excluded here' : ''}` +
      `${c.globallyExcluded ? ', globally excluded' : ''}${c.quarantined ? ', quarantined' : ''}` +
      `, live in ${c.liveIn}`;
    it(name, () => {
      const { picture, occupancy } = scenario(c);
      const includedHere = c.residency === 'included' || c.residency === 'both';
      const shared = c.residency === 'shared';

      // The rule's slot: included first (always an auto target), or inherited when shared and not
      // excluded here (an auto target unless globally excluded); never quarantined; never when it is
      // reserved only to the other rule.
      const inR = !c.quarantined && (includedHere || (shared && !c.excludedHere));
      const poolR = slotPool(R, picture, occupancy);
      expect(poolR.map((e) => e.account.id)).toEqual(inR ? ['x'] : []);
      if (inR) {
        expect(poolR[0]!.source).toBe(includedHere ? 'include' : 'inherited');
        expect(poolR[0]!.autoTarget).toBe(includedHere ? true : !c.globallyExcluded);
        const elsewhere = slotOfLive[c.liveIn] === R ? null : slotOfLive[c.liveIn];
        expect(poolR[0]!.liveElsewhere).toBe(elsewhere);
        expect(availableInOrder(poolR).map((a) => a.id)).toEqual(elsewhere === null ? ['x'] : []);
      }

      // The global slot: shared rows only, whatever any rule excludes.
      const inGlobal = shared && !c.quarantined;
      const poolG = slotPool(GLOBAL, picture, occupancy);
      expect(poolG.map((e) => e.account.id)).toEqual(inGlobal ? ['x'] : []);
      if (inGlobal) {
        expect(poolG[0]!.source).toBe('inherited');
        expect(poolG[0]!.autoTarget).toBe(!c.globallyExcluded);
        const elsewhere = slotOfLive[c.liveIn] === GLOBAL ? null : slotOfLive[c.liveIn];
        expect(poolG[0]!.liveElsewhere).toBe(elsewhere);
      }

      // The other rule's slot: it includes x when x is 'elsewhere' or 'both', inherits it when shared.
      const includedR2 = c.residency === 'elsewhere' || c.residency === 'both';
      const inR2 = !c.quarantined && (includedR2 || shared);
      expect(slotPool(R2, picture, occupancy).map((e) => e.account.id)).toEqual(inR2 ? ['x'] : []);

      // Legitimacy ignores quarantine and liveness: a quarantined account is still in its place.
      expect(slotMayHold(R, 'x', picture)).toBe(includedHere || (shared && !c.excludedHere));
      expect(slotMayHold(GLOBAL, 'x', picture)).toBe(shared);
      expect(slotMayHold(R2, 'x', picture)).toBe(includedR2 || shared);
    });
  }
});

describe('pool order', () => {
  const s1 = account('s1');
  const s2 = account('s2', { autoSwitchExcluded: true });
  const s3 = account('s3');
  const i1 = account('i1');
  const i2 = account('i2', { autoSwitchExcluded: true });
  const picture: RulesPicture = {
    shared: [s1, s2, s3],
    reserved: [i1, i2],
    rules: [rule('r', { include: ['i2', 'i1'], exclude: ['s3'] })],
  };
  const nobodyLive = new Map<SlotId, Set<string>>([
    [GLOBAL, new Set()],
    [R, new Set()],
  ]);

  it('lists the included accounts in include order, then the inherited shared rows in row order', () => {
    expect(slotMembers(R, picture).map((e) => [e.account.id, e.source, e.autoTarget])).toEqual([
      ['i2', 'include', true],
      ['i1', 'include', true],
      ['s1', 'inherited', true],
      ['s2', 'inherited', false],
    ]);
  });

  it('the global slot holds the shared rows in row order, the excluded ones present but not targets', () => {
    expect(slotMembers(GLOBAL, picture).map((e) => [e.account.id, e.autoTarget])).toEqual([
      ['s1', true],
      ['s2', false],
      ['s3', true],
    ]);
  });

  it('availableInOrder puts auto targets first in pool order, then the rest as a last resort', () => {
    expect(availableInOrder(slotPool(R, picture, nobodyLive)).map((a) => a.id)).toEqual([
      'i2',
      'i1',
      's1',
      's2',
    ]);
    expect(availableInOrder(slotPool(GLOBAL, picture, nobodyLive)).map((a) => a.id)).toEqual([
      's1',
      's3',
      's2',
    ]);
  });

  it('availableInOrder drops every account live in another slot, keeping the one live here', () => {
    const occupancy = new Map<SlotId, Set<string>>([
      [GLOBAL, new Set(['s1'])],
      [R, new Set(['i1'])],
    ]);
    expect(availableInOrder(slotPool(R, picture, occupancy)).map((a) => a.id)).toEqual([
      'i2',
      'i1',
      's2',
    ]);
    // s1 is live in the global slot itself, so the global slot keeps it.
    expect(availableInOrder(slotPool(GLOBAL, picture, occupancy)).map((a) => a.id)).toEqual([
      's1',
      's3',
      's2',
    ]);
  });

  it('a rule that no longer exists has an empty pool and holds nothing', () => {
    const gone = ruleSlotId('gone');
    expect(slotMembers(gone, picture)).toEqual([]);
    expect(slotMayHold(gone, 's1', picture)).toBe(false);
  });
});

describe('liveness and slot helpers', () => {
  it("slotPhrase names a parallel session's slot by its account, never as a folder slot", () => {
    const rules = [
      rule('session-w', { label: 'W', include: ['w'], lease: { holders: [], startedAtMs: 1 } }),
      rule('r', { folders: ['C:/a'] }),
      rule('r2', { aliases: [{ folder: 'C:/a', alias: 'job' }] }),
    ];
    expect(slotPhrase(GLOBAL, rules)).toBe('the global slot');
    expect(slotPhrase(ruleSlotId('session-w'), rules)).toBe('the parallel-session slot of W');
    expect(slotPhrase(R, rules)).toBe('the folder slot of C:/a');
    expect(slotPhrase(R2, rules)).toBe('the slot of session "job" in C:/a');
    expect(slotPhrase(ruleSlotId('gone'), rules)).toBe('a folder slot whose rule no longer exists');
  });

  it('liveElsewhere names the first other slot in occupancy order, never the slot asked about', () => {
    const occupancy = new Map<SlotId, Set<string>>([
      [GLOBAL, new Set(['a'])],
      [R, new Set(['a', 'b'])],
      [R2, new Set(['b'])],
    ]);
    expect(liveElsewhere(R, 'a', occupancy)).toBe(GLOBAL);
    expect(liveElsewhere(GLOBAL, 'a', occupancy)).toBe(R);
    expect(liveElsewhere(R, 'b', occupancy)).toBe(R2);
    expect(liveElsewhere(R2, 'c', occupancy)).toBeNull();
  });

  it('legitimateOccupancy drops the copies a slot may not hold, and keeps every rightful one', () => {
    // r includes a; r2 includes b; s is shared and r excludes it. Every slot claims every account.
    const picture: RulesPicture = {
      shared: [account('s')],
      reserved: [account('a'), account('b')],
      rules: [rule('r', { include: ['a'], exclude: ['s'] }), rule('r2', { include: ['b'] })],
    };
    const everywhere = new Map<SlotId, Set<string>>([
      [GLOBAL, new Set(['a', 'b', 's'])],
      [R, new Set(['a', 'b', 's'])],
      [R2, new Set(['a', 'b', 's'])],
    ]);
    const legit = legitimateOccupancy(everywhere, picture);
    expect([...legit.get(GLOBAL)!]).toEqual(['s']);
    expect([...legit.get(R)!]).toEqual(['a']);
    expect([...legit.get(R2)!].sort()).toEqual(['b', 's']);
    // A squatter's copy no longer makes the rightful slot's account "live elsewhere".
    expect(liveElsewhere(R, 'a', everywhere)).toBe(GLOBAL);
    expect(liveElsewhere(R, 'a', legit)).toBeNull();
  });

  it('rulesIncluding, ruleOfSlot and allSlots read the rules in file order', () => {
    const rules = [rule('r', { include: ['a'] }), rule('r2', { include: ['a', 'b'] })];
    expect(rulesIncluding('a', rules).map((r) => r.id)).toEqual(['r', 'r2']);
    expect(rulesIncluding('c', rules)).toEqual([]);
    expect(ruleOfSlot(R2, rules)?.id).toBe('r2');
    expect(ruleOfSlot(GLOBAL, rules)).toBeUndefined();
    expect(ruleOfSlot(ruleSlotId('gone'), rules)).toBeUndefined();
    expect(allSlots(rules)).toEqual([GLOBAL, R, R2]);
  });

  it('ruleSlotId and ruleIdOfSlot are inverses, and the global slot has no rule', () => {
    expect(ruleIdOfSlot(ruleSlotId('abc'))).toBe('abc');
    expect(ruleIdOfSlot(GLOBAL)).toBeUndefined();
  });

  it('withRule replaces exactly the rule of that id and leaves the input untouched', () => {
    const picture: RulesPicture = {
      shared: [],
      reserved: [],
      rules: [rule('r'), rule('r2')],
    };
    const next = withRule(picture, rule('r', { exclude: ['s'] }));
    expect(next.rules.map((r) => r.exclude)).toEqual([['s'], []]);
    expect(picture.rules[0]!.exclude).toEqual([]);
  });
});

describe('folder -> rule resolution', () => {
  const rules = [
    rule('outer', { folders: ['C:\\work'] }),
    rule('inner', { folders: ['C:\\work\\client'] }),
    rule('other', { folders: ['C:\\research', 'D:\\data'] }),
  ];

  it('the longest rule folder containing the path wins, with no merging', () => {
    expect(resolveFolderRule('C:\\work\\client\\src', rules, 'win32')?.rule.id).toBe('inner');
    expect(resolveFolderRule('C:\\work\\other', rules, 'win32')).toMatchObject({
      rule: { id: 'outer' },
      folder: 'C:\\work',
    });
    expect(resolveFolderRule('D:\\data\\x', rules, 'win32')?.rule.id).toBe('other');
  });

  it('matches on a folder boundary only, and case-insensitively on Windows', () => {
    expect(resolveFolderRule('C:\\research2', rules, 'win32')).toBeNull();
    expect(resolveFolderRule('c:\\WORK\\CLIENT', rules, 'win32')?.rule.id).toBe('inner');
    expect(resolveFolderRule('C:\\elsewhere', rules, 'win32')).toBeNull();
  });

  it('exactFolderRule finds only the rule holding that exact folder', () => {
    expect(exactFolderRule('C:\\work', rules, 'win32')?.id).toBe('outer');
    expect(exactFolderRule('c:/WORK', rules, 'win32')?.id).toBe('outer');
    expect(exactFolderRule('C:\\work\\client\\src', rules, 'win32')).toBeUndefined();
  });
});

describe('session -> rule resolution (the precedence rule over rules)', () => {
  const rules = [
    rule('folder', { folders: ['C:\\work'] }),
    rule('alias', { aliases: [{ folder: 'C:\\work', alias: 'Auth Work' }] }),
    rule('sub', { aliases: [{ folder: 'C:\\work\\sub', alias: 'Auth Work' }] }),
  ];

  it('the alias rule of the recorded folder wins over the longest folder rule', () => {
    expect(resolveSessionRule('C:\\work', ' auth WORK ', rules, 'win32')).toMatchObject({
      rule: { id: 'alias' },
      via: 'alias',
      folder: 'C:\\work',
      aliasKey: 'auth work',
    });
    // Another title, or none, falls to the folder rule.
    expect(resolveSessionRule('C:\\work', 'other', rules, 'win32')).toMatchObject({
      rule: { id: 'folder' },
      via: 'folder',
    });
    expect(resolveSessionRule('C:\\work', null, rules, 'win32')?.rule.id).toBe('folder');
    expect(resolveSessionRule('C:\\work', '   ', rules, 'win32')?.rule.id).toBe('folder');
  });

  it('keys on the RECORDED folder, exactly (never a subfolder)', () => {
    // Resumed from C:\\work, recorded in C:\\work\\sub: the sub folder's alias rule.
    expect(
      resolveSessionRule('C:\\work', 'Auth Work', rules, 'win32', 'C:\\work\\sub')?.rule.id,
    ).toBe('sub');
    // Running in a deeper folder with no alias rule of its own: the folder rule.
    expect(resolveSessionRule('C:\\work\\sub\\x', 'Auth Work', rules, 'win32')?.rule.id).toBe(
      'folder',
    );
    // Recorded in no folder an alias rule can name: only the folder rule applies.
    expect(resolveSessionRule('C:\\work', 'Auth Work', rules, 'win32', null)?.rule.id).toBe(
      'folder',
    );
  });

  it('exactAliasRule matches by folder key and alias key', () => {
    expect(exactAliasRule('c:/WORK', 'AUTH work ', rules, 'win32')?.id).toBe('alias');
    expect(exactAliasRule('C:\\work', 'other', rules, 'win32')).toBeUndefined();
    expect(exactAliasRule('C:\\work\\sub\\x', 'Auth Work', rules, 'win32')).toBeUndefined();
  });

  it('scopedRuleOf keys aliases and spells stored folders canonically', () => {
    const hand = rule('h', {
      folders: ['c:/Work/'],
      aliases: [{ folder: 'C:/work/sub/', alias: ' Mixed Case ' }],
    });
    expect(scopedRuleOf(hand, 'win32')).toEqual({
      id: 'h',
      // The drive letter is upper-cased, the separators and trailing one normalized.
      folders: ['C:\\Work'],
      aliases: [{ folder: 'C:\\work\\sub', aliasKey: 'mixed case' }],
    });
    // A hand-edited spelling still resolves.
    expect(resolveSessionRule('C:\\work\\sub', 'mixed case', [hand], 'win32')?.via).toBe('alias');
  });

  it('counts and names scopes: folders, then session aliases, falling back to the label', () => {
    const both = rule('b', {
      label: 'B',
      folders: ['C:\\a'],
      aliases: [{ folder: 'C:\\a', alias: 'x' }],
    });
    expect(ruleScopeCount(both)).toBe(2);
    expect(ruleScopes(both)).toEqual(['C:\\a', 'session "x" in C:\\a']);
    expect(describeRuleScopes(both)).toBe('C:\\a, session "x" in C:\\a');
    expect(describeRuleScopes(rule('none', { label: 'Lone' }))).toBe('Lone');
    expect(ruleScopeCount(rule('none'))).toBe(0);
  });
});

describe('assignDistinct — one different account per slot', () => {
  it('gives each slot its best candidate when they do not contend', () => {
    expect(assignDistinct([['a', 'b'], ['c']])).toEqual({ ok: true, chosen: ['a', 'c'] });
  });

  it('moves an earlier slot to its next candidate when a later slot has no other', () => {
    expect(assignDistinct([['c', 'd'], ['c']])).toEqual({ ok: true, chosen: ['d', 'c'] });
  });

  it('does not move an earlier slot while the later one has a free candidate of its own', () => {
    expect(
      assignDistinct([
        ['a', 'b'],
        ['a', 'c'],
      ]),
    ).toEqual({ ok: true, chosen: ['a', 'c'] });
  });

  it('follows a chain of moves', () => {
    expect(assignDistinct([['a', 'b'], ['a', 'c'], ['a']])).toEqual({
      ok: true,
      chosen: ['b', 'c', 'a'],
    });
  });

  it('never gives two slots the same account, naming the first slot left without', () => {
    expect(assignDistinct([['c'], ['c']])).toEqual({ ok: false, unserved: 1 });
    expect(assignDistinct([['a'], []])).toEqual({ ok: false, unserved: 1 });
  });

  it('serves no slots trivially', () => {
    expect(assignDistinct([])).toEqual({ ok: true, chosen: [] });
  });
});
