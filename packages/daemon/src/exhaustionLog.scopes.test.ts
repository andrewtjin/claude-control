// The exhaustion log's scopes: the global pool and each folder rule's pool, each with its own
// episodes in the one file. Pure functions and the file reader, no daemon: what a scope holds,
// how an account live in another slot counts, how lines of different scopes (and lines written
// before scopes existed) are told apart, and how a folder's episode ends when its rule is removed.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessFleet,
  type AccountUsageInput,
  type LimitInput,
} from '@claude-control/usage-advisor';
import {
  ruleSlotId,
  type AccountView,
  type FolderRule,
  type SlotId,
} from '@claude-control/switch-engine';
import {
  describeScope,
  episodesOf,
  exhaustedCardBody,
  exhaustedCardTitle,
  exhaustedRecord,
  ExhaustionLog,
  fileWallChanges,
  GLOBAL_SCOPE,
  judgeScope,
  openEpisodeFrom,
  openEpisodeOf,
  outageScopes,
  recoveredCardTitle,
  recoveredRecord,
  recoveryText,
  resumeOpenEpisode,
  resumeOpenEpisodes,
  ruleRemovedRecord,
  scopeKey,
  scopeOf,
  type ExhaustionRecord,
  type OutageScope,
} from './exhaustionLog.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;

const view = (id: string, ruleIds?: string[], extra: Partial<AccountView> = {}): AccountView => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...(ruleIds !== undefined ? { ruleIds } : {}),
  ...extra,
});

const rule = (
  id: string,
  folder: string,
  include: string[],
  exclude: string[] = [],
): FolderRule => ({
  id,
  label: folder,
  folders: [folder],
  include,
  exclude,
  activeId: null,
  createdAtMs: 0,
  updatedAtMs: 0,
});

function acct(id: string, limits: LimitInput[] = []): AccountUsageInput {
  return { accountId: id, label: id, active: false, quarantined: false, limits };
}
const spent = (id: string, resetsInH = 2) =>
  acct(id, [{ kind: 'session', percent: 100, resetsAt: T0 + resetsInH * H }]);
const free = (id: string) => acct(id, [{ kind: 'weekly_all', percent: 20, resetsAt: T0 + 50 * H }]);

const research: OutageScope = {
  kind: 'folder',
  ruleId: 'r1',
  folders: ['C:/research'],
  label: 'C:/research',
};

/** Shared A, B, C; E included by the research rule, which also excludes C. */
function fleet(liveSlots: Array<[SlotId, string | null]>) {
  return outageScopes({
    accounts: [view('A'), view('B'), view('C'), view('E', ['r1'])],
    rules: [rule('r1', 'C:/research', ['E'], ['C'])],
    liveSlots: new Map(liveSlots),
  });
}

describe('outageScopes', () => {
  it('the global pool is the shared accounts; a folder is its included accounts first, then the shared ones it keeps', () => {
    const [global, folder] = fleet([['global', 'A']]);
    // Beside folder rules the global pool is not every account, and its words say so.
    expect(global?.scope).toEqual({ kind: 'global', ruled: true });
    expect(global?.accountIds).toEqual(['A', 'B', 'C']);
    expect(folder?.scope).toEqual(research);
    expect(folder?.key).toBe('folder:r1');
    expect(folder?.accountIds).toEqual(['E', 'A', 'B']);
  });

  it('an account live in another slot is named there, for the global pool too', () => {
    const [global, folder] = fleet([
      ['global', 'A'],
      [ruleSlotId('r1'), 'B'],
    ]);
    expect([...(global?.liveElsewhere ?? [])]).toEqual([['B', 'the slot of C:/research']]);
    expect([...(folder?.liveElsewhere ?? [])]).toEqual([['A', 'the global slot']]);
  });

  it('keeps quarantined and globally excluded accounts: one is out, the other still takes work by hand', () => {
    const [global] = outageScopes({
      accounts: [
        view('A', undefined, { quarantined: true }),
        view('B', undefined, { autoSwitchExcluded: true }),
      ],
      rules: [],
      liveSlots: new Map([['global', null]]),
    });
    expect(global?.accountIds).toEqual(['A', 'B']);
  });

  it('two rules including one account: each pool has it, and its copy live in one is elsewhere for the other', () => {
    const scopes = outageScopes({
      accounts: [view('A'), view('E', ['r1', 'r2'])],
      rules: [rule('r1', 'C:/one', ['E']), rule('r2', 'C:/two', ['E'])],
      liveSlots: new Map<SlotId, string | null>([
        ['global', 'A'],
        [ruleSlotId('r1'), 'E'],
        [ruleSlotId('r2'), null],
      ]),
    });
    expect(scopes[1]?.liveElsewhere.has('E')).toBe(false);
    expect(scopes[2]?.liveElsewhere.get('E')).toBe('the slot of C:/one');
  });
});

describe('judgeScope', () => {
  it('a folder is out when its only free account is live in the global slot', () => {
    const [, folder] = fleet([['global', 'A']]);
    const inputs = [spent('E'), free('A'), spent('B'), free('C')];
    const judged = judgeScope(inputs, folder!, undefined, T0, {});
    expect(judged.transition).toEqual({ kind: 'start' });
    // C is free, but the rule excludes it: not in the pool at all.
    expect(judged.fleet.accounts.map((a) => a.accountId)).toEqual(['E', 'A', 'B']);
    expect(judged.fleet.accounts.find((a) => a.accountId === 'A')?.reason).toBe('live_elsewhere');
  });

  it('the global pool is out while the folder still works, and the other way round', () => {
    const [global, folder] = fleet([
      ['global', 'A'],
      [ruleSlotId('r1'), 'E'],
    ]);
    const globalOut = [spent('A'), spent('B'), spent('C'), free('E')];
    expect(judgeScope(globalOut, global!, undefined, T0, {}).on).toBe(true);
    expect(judgeScope(globalOut, folder!, undefined, T0, {}).on).toBe(false);
    const folderOut = [free('A'), spent('B'), free('C'), spent('E')];
    expect(judgeScope(folderOut, global!, undefined, T0, {}).on).toBe(false);
    expect(judgeScope(folderOut, folder!, undefined, T0, {}).on).toBe(true);
  });

  it('ends when the slot holding the account lets it go, with numbers to show it can work', () => {
    const inputs = [spent('E'), free('A'), spent('B')];
    const [, held] = fleet([['global', 'A']]);
    const start = judgeScope(inputs, held!, undefined, T0, {});
    const record = exhaustedRecord({
      fleet: start.fleet,
      now: T0,
      active: 'E',
      switches: [],
      scope: research,
    });
    const open = openEpisodeFrom(record);
    // Still held: nothing changes.
    expect(judgeScope(inputs, held!, open, T0 + H, {}).transition.kind).toBe('none');
    // Global moves off A: A is back for the folder.
    const [, freed] = fleet([['global', 'B']]);
    const end = judgeScope(inputs, freed!, open, T0 + H, {});
    expect(end.transition).toMatchObject({
      kind: 'end',
      recovery: { accountId: 'A', how: 'released' },
    });
    // Freed but its poll came back empty: no proof yet.
    const noNumbers = [spent('E'), acct('A'), spent('B')];
    expect(judgeScope(noNumbers, freed!, open, T0 + H, {}).transition.kind).toBe('none');
  });
});

describe('scoped records', () => {
  const folderStart = () => {
    const f = assessFleet([spent('E'), free('A')], T0, {
      liveElsewhere: new Map([['A', 'the global slot']]),
    });
    return {
      fleet: f,
      record: exhaustedRecord({ fleet: f, now: T0, active: 'E', switches: [], scope: research }),
    };
  };

  it('a folder start is version 2, carries its scope and names the folder', () => {
    const { fleet: f, record } = folderStart();
    expect(record).toMatchObject({ v: 2, scope: research, id: `ep-${T0}-r1` });
    expect(record.summary).toContain("No account in C:/research's pool can take work: E (");
    expect(record.summary).toContain('A (live in the global slot)');
    expect(record.accounts.find((a) => a.accountId === 'A')).toMatchObject({
      reason: 'live_elsewhere',
      liveIn: 'the global slot',
    });
    expect(exhaustedCardTitle(research)).toBe('C:/research: every account in its pool is out');
    expect(exhaustedCardBody(f, record).split('\n')[0]).toBe(
      "No account in C:/research's pool can take work.",
    );
  });

  it('a global start stays version 1, worded as before', () => {
    const f = assessFleet([spent('A')], T0);
    const record = exhaustedRecord({ fleet: f, now: T0, active: 'A', switches: [] });
    expect(record).toMatchObject({ v: 1, id: `ep-${T0}`, scope: { kind: 'global' } });
    expect(record.summary.startsWith('No account can take work: ')).toBe(true);
    expect(exhaustedCardTitle(GLOBAL_SCOPE)).toBe('All accounts are out of usage');
  });

  it('an end and a walls line carry the start scope and version', () => {
    const { record } = folderStart();
    const end = recoveredRecord(
      record,
      { accountId: 'A', label: 'A', how: 'released', backSince: T0 + H },
      T0 + H,
    );
    expect(end).toMatchObject({ v: 2, scope: research });
    expect(end.summary).toBe(
      'Usage is back in C:/research: A (another slot let it go). No account in its pool could take work for 1h.',
    );
    expect(recoveredCardTitle(end)).toBe('Usage is back in C:/research');
    const open = openEpisodeFrom(record);
    const changed = {
      ...open,
      accounts: new Map(
        [...open.accounts].map(([id, a]) => [id, id === 'E' ? { ...a, spent: [] } : a]),
      ),
    };
    const walls = fileWallChanges(changed, T0 + H).records;
    expect(walls).toHaveLength(1);
    expect(walls[0]).toMatchObject({ v: 2, scope: research, id: record.id });
  });

  it('a removed rule ends its episode with no account, worded as such', () => {
    const { record } = folderStart();
    const end = ruleRemovedRecord(record, T0 + 2 * H);
    expect(end).toMatchObject({ v: 2, scope: research, how: 'rule_removed', durationMs: 2 * H });
    expect(end.account).toBeUndefined();
    expect(end.summary).toBe(
      'The folder rule for C:/research was removed, which ends its outage. No account in its pool could take work for 2h.',
    );
    expect(recoveredCardTitle(end)).toBe('C:/research: folder rule removed');
    expect(recoveryText(end)).toBe('its folder rule was removed');
  });

  it('describes each scope', () => {
    expect(describeScope(GLOBAL_SCOPE)).toBe('the global pool');
    expect(describeScope({ ...research, folders: ['C:/a', 'C:/b'] })).toBe('C:/a, C:/b');
    expect(describeScope({ ...research, folders: [] })).toBe('C:/research');
    expect(scopeKey(GLOBAL_SCOPE)).toBe('global');
    expect(scopeOf({})).toEqual(GLOBAL_SCOPE);
  });
});

describe('scopes in the file', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    while (dirs.length > 0) await rm(dirs.pop() as string, { recursive: true, force: true });
  });
  const logWith = async (lines: unknown[]): Promise<ExhaustionLog> => {
    const dir = await mkdtemp(join(tmpdir(), 'exhaustion-scopes-'));
    dirs.push(dir);
    const log = new ExhaustionLog(join(dir, 'exhaustion-log.jsonl'));
    await writeFile(log.path, lines.map((l) => JSON.stringify(l) + '\n').join(''));
    return log;
  };
  const start = (id: string, at: number, scope?: OutageScope, v = 1) => ({
    v,
    event: 'exhausted',
    id,
    ...(scope !== undefined ? { scope } : {}),
    at,
    time: new Date(at).toISOString(),
    summary: 's',
    active: null,
    accounts: [{ accountId: 'a', label: 'a', reason: 'session', spent: [] }],
    switches: [],
  });
  const end = (id: string, at: number, scope?: OutageScope, v = 1, extra: object = {}) => ({
    v,
    event: 'recovered',
    id,
    ...(scope !== undefined ? { scope } : {}),
    at,
    time: new Date(at).toISOString(),
    summary: 's',
    backSince: at,
    durationMs: 1,
    account: { accountId: 'a', label: 'a' },
    how: 'headroom',
    ...extra,
  });

  it('a line written before scopes existed reads as the global pool', async () => {
    const records = await (await logWith([start('ep-1', T0)])).read();
    expect(records).toHaveLength(1);
    expect(scopeOf(records[0] as ExhaustionRecord)).toEqual(GLOBAL_SCOPE);
    expect(resumeOpenEpisode(records)?.record.id).toBe('ep-1');
  });

  it('accepts a folder only at version 2 and version 2 only with a whole folder scope', async () => {
    const log = await logWith([
      start('ok', T0, research, 2),
      start('v1-folder', T0, research, 1),
      start('v2-global', T0, GLOBAL_SCOPE, 2),
      start('v2-none', T0, undefined, 2),
      start('v2-half', T0, { kind: 'folder', ruleId: 'r1' } as unknown as OutageScope, 2),
      start('v3', T0, research, 3),
    ]);
    expect((await log.read()).map((r) => r.id)).toEqual(['ok']);
  });

  it('pairs each start with its own scope end, even when two scopes share an id', async () => {
    const records = await (
      await logWith([
        start('ep-1', T0),
        start('ep-1', T0, research, 2),
        end('ep-1', T0 + H, research, 2),
      ])
    ).read();
    const episodes = episodesOf(records);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]?.end).toBeUndefined();
    expect(episodes[1]?.end?.at).toBe(T0 + H);
    expect(openEpisodeOf(records)?.id).toBe('ep-1');
    expect(openEpisodeOf(records, research)).toBeUndefined();
  });

  it('resumes every open scope, each with only its own walls', async () => {
    const walls = (id: string, scope: OutageScope | undefined, v: number, accountId: string) => ({
      v,
      event: 'walls',
      id,
      ...(scope !== undefined ? { scope } : {}),
      at: T0 + H,
      time: '',
      accountId,
      label: accountId,
      reason: 'live_elsewhere',
      spent: [],
      liveIn: 'the global slot',
    });
    const records = await (
      await logWith([
        start('g', T0),
        start('f', T0, research, 2),
        walls('f', research, 2, 'x'),
        walls('g', undefined, 1, 'y'),
        start('old', T0 - H, { ...research, ruleId: 'r2' }, 2),
        end('old', T0, { ...research, ruleId: 'r2' }, 2),
      ])
    ).read();
    const open = resumeOpenEpisodes(records);
    expect([...open.keys()]).toEqual(['global', 'folder:r1']);
    expect(open.get('folder:r1')?.accounts.get('x')).toMatchObject({
      reason: 'live_elsewhere',
      liveIn: 'the global slot',
    });
    expect(open.get('folder:r1')?.accounts.has('y')).toBe(false);
    expect(open.get('global')?.accounts.has('y')).toBe(true);
  });

  it('reads a rule-removed end without an account, and no other end without one', async () => {
    const records = await (
      await logWith([
        start('f', T0, research, 2),
        { ...end('f', T0 + H, research, 2, { how: 'rule_removed' }), account: undefined },
        { ...end('x', T0 + H, research, 2), account: undefined },
        end('y', T0 + H, research, 2, { how: 'rule_removed' }),
      ])
    ).read();
    expect(records.map((r) => `${r.event}:${r.id}`)).toEqual(['exhausted:f', 'recovered:f']);
    expect(resumeOpenEpisodes(records).size).toBe(0);
  });
});

describe('the global pool beside folder rules', () => {
  const ruled = outageScopes({
    accounts: [view('A'), view('B'), view('E', ['r1'])],
    rules: [rule('r1', 'C:/research', ['E'])],
    liveSlots: new Map<SlotId, string | null>([['global', 'A']]),
  })[0]!;

  it('is named as the global pool once folder rules exist, never as every account', () => {
    expect(ruled.scope).toEqual({ kind: 'global', ruled: true });
    const f = assessFleet([spent('A'), spent('B')], T0);
    const record = exhaustedRecord({
      fleet: f,
      now: T0,
      active: 'A',
      switches: [],
      scope: ruled.scope,
    });
    expect(record).toMatchObject({ v: 1, scope: { kind: 'global' } });
    expect(record.summary.startsWith('No account in the global pool can take work: ')).toBe(true);
    expect(exhaustedCardTitle(ruled.scope)).toBe('Every account in the global pool is out');
    expect(exhaustedCardBody(f, record).split('\n')[0]).toBe(
      'No account in the global pool can take work.',
    );
    const end = recoveredRecord(
      record,
      { accountId: 'A', label: 'A', how: 'headroom', backSince: T0 + H },
      T0 + H,
    );
    expect(end.summary).toBe(
      'Usage is back in the global pool: A (it has usage left again). No account in its pool could take work for 1h.',
    );
    expect(recoveredCardTitle(end)).toBe('Usage is back in the global pool');
  });

  it('is worded as before with no folder rules', () => {
    const plain = outageScopes({
      accounts: [view('A')],
      rules: [],
      liveSlots: new Map<SlotId, string | null>([['global', 'A']]),
    })[0]!;
    expect(plain.scope).toEqual(GLOBAL_SCOPE);
    expect(exhaustedCardTitle(plain.scope)).toBe('All accounts are out of usage');
  });

  it('reads a global line that says folder rules existed, and keeps it the global scope', async () => {
    const f = assessFleet([spent('A')], T0);
    const record = exhaustedRecord({
      fleet: f,
      now: T0,
      active: 'A',
      switches: [],
      scope: ruled.scope,
    });
    const dir = await mkdtemp(join(tmpdir(), 'exh-ruled-'));
    try {
      const log = new ExhaustionLog(join(dir, 'log.jsonl'));
      await log.append(record);
      const [read] = await log.read();
      expect(read).toMatchObject({ scope: { kind: 'global', ruled: true } });
      expect(scopeKey(scopeOf(read!))).toBe('global');
      expect(resumeOpenEpisodes([read!]).has('global')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('a folder whose pool is empty', () => {
  const emptied = (exclude: string[]) =>
    outageScopes({
      accounts: [view('A'), view('B')],
      rules: [rule('r1', 'C:/scratch', [], exclude)],
      liveSlots: new Map<SlotId, string | null>([['global', 'A']]),
    })[1]!;

  it('is out, worded as an empty pool rather than as expired logins', () => {
    const scope = emptied(['A', 'B']);
    expect(scope.accountIds).toEqual([]);
    const judged = judgeScope([free('A'), free('B')], scope, undefined, T0, {});
    expect(judged.on).toBe(true);
    expect(judged.transition).toEqual({ kind: 'start' });
    const record = exhaustedRecord({
      fleet: judged.fleet,
      now: T0,
      active: null,
      switches: [],
      scope: scope.scope,
    });
    expect(record.summary).toBe(
      "No account in C:/scratch's pool can take work. Its pool is empty: every account it could " +
        'use is excluded by its rule or reserved to other folders.',
    );
    expect(exhaustedCardBody(judged.fleet, record)).toContain('Its pool is empty');
    expect(exhaustedCardBody(judged.fleet, record)).not.toContain('login');
  });

  it('ends once an account that can work joins its pool', () => {
    const start = judgeScope([free('A'), free('B')], emptied(['A', 'B']), undefined, T0, {});
    const record = exhaustedRecord({
      fleet: start.fleet,
      now: T0,
      active: null,
      switches: [],
      scope: emptied(['A', 'B']).scope,
    });
    const open = openEpisodeFrom(record);
    expect(judgeScope([free('A'), free('B')], emptied(['A', 'B']), open, T0 + H, {}).on).toBe(true);
    const end = judgeScope([free('A'), free('B')], emptied(['A']), open, T0 + H, {});
    expect(end.transition).toMatchObject({ kind: 'end', recovery: { accountId: 'B' } });
  });

  it('a fleet with no accounts at all is not an outage', () => {
    const none = outageScopes({ accounts: [], rules: [], liveSlots: new Map() })[0]!;
    expect(judgeScope([], none, undefined, T0, {}).on).toBe(false);
  });
});
