import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assessFleet,
  type AccountUsageInput,
  type LimitInput,
} from '@claude-control/usage-advisor';
import {
  decideExhaustion,
  episodesOf,
  exhaustedCardBody,
  exhaustedRecord,
  ExhaustionLog,
  openEpisodeFrom,
  exhaustionLogPath,
  openEpisodeOf,
  outageStatus,
  fileWallChanges,
  resumeOpenEpisode,
  WALL_MOVE_MS,
  type WallsRecord,
  trackOpenEpisode,
  recoveredRecord,
  recoveryText,
  type ExhaustedRecord,
  type ExhaustionRecord,
} from './exhaustionLog.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;
const M = 60 * 1000;

function acct(
  id: string,
  limits: LimitInput[] = [],
  overrides: Partial<AccountUsageInput> = {},
): AccountUsageInput {
  return { accountId: id, label: id, active: false, quarantined: false, limits, ...overrides };
}

const session = (percent: number, resetsAt: number): LimitInput => ({
  kind: 'session',
  percent,
  resetsAt,
});
const weekly = (percent: number, resetsAt?: number): LimitInput => ({
  kind: 'weekly_all',
  percent,
  ...(resetsAt !== undefined ? { resetsAt } : {}),
});

/** A two-account fleet out of usage at T0: a back at T0+1h (5-hour window), b at T0+30h (week). */
function exhaustedAtT0(): ExhaustedRecord {
  const fleet = assessFleet(
    [
      acct('a', [session(100, T0 + H), weekly(40, T0 + 90 * H)]),
      acct('b', [weekly(100, T0 + 30 * H)]),
    ],
    T0,
  );
  expect(fleet.exhausted).toBe(true);
  return exhaustedRecord({ fleet, now: T0, active: 'a', switches: [] });
}

describe('decideExhaustion — starting', () => {
  it('starts when no account can take work and nothing is open', () => {
    const fleet = assessFleet([acct('a', [session(100, T0 + H)])], T0);
    expect(decideExhaustion(undefined, fleet, T0)).toEqual({ kind: 'start' });
  });

  it('does nothing while any account can take work', () => {
    const fleet = assessFleet(
      [acct('a', [session(100, T0 + H)]), acct('b', [session(10, T0 + H)])],
      T0,
    );
    expect(decideExhaustion(undefined, fleet, T0)).toEqual({ kind: 'none' });
  });

  it('never starts a second episode while one is open', () => {
    const open = exhaustedAtT0();
    const still = assessFleet(
      [acct('a', [session(100, T0 + H)]), acct('b', [weekly(100, T0 + 30 * H)])],
      T0 + 10 * M,
    );
    expect(decideExhaustion(openEpisodeFrom(open), still, T0 + 10 * M)).toEqual({ kind: 'none' });
  });
});

describe('decideExhaustion — ending needs positive evidence', () => {
  it('ends when fresh numbers show headroom, dated to the reset that brought it back', () => {
    const open = exhaustedAtT0();
    const at = T0 + H + 3 * M;
    const fleet = assessFleet(
      [
        acct('a', [session(4, T0 + 6 * H), weekly(41, T0 + 90 * H)]),
        acct('b', [weekly(100, T0 + 30 * H)]),
      ],
      at,
    );
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toEqual({
      kind: 'end',
      recovery: { accountId: 'a', label: 'a', how: 'reset', backSince: T0 + H, limit: 'session' },
    });
  });

  it('a failed poll (no numbers at all) does NOT end it while the recorded reset is ahead', () => {
    const open = exhaustedAtT0();
    const at = T0 + 20 * M;
    // a's poll came back empty: usable by "unknown is not exhausted", but nothing proves it.
    const fleet = assessFleet([acct('a'), acct('b', [weekly(100, T0 + 30 * H)])], at);
    expect(fleet.exhausted).toBe(false);
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toEqual({ kind: 'none' });
  });

  it('no numbers, but the recorded reset has passed: the clock is the evidence', () => {
    const open = exhaustedAtT0();
    const at = T0 + 2 * H;
    const fleet = assessFleet([acct('a'), acct('b', [weekly(100, T0 + 30 * H)])], at);
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toMatchObject({
      kind: 'end',
      recovery: { label: 'a', how: 'reset', backSince: T0 + H },
    });
  });

  it('numbers that still show the wall keep it open even after the recorded reset', () => {
    const open = exhaustedAtT0();
    const at = T0 + 2 * H;
    // The endpoint moved a's window: a fresh 5-hour window already at 100%.
    const fleet = assessFleet(
      [acct('a', [session(100, T0 + 6 * H)]), acct('b', [weekly(100, T0 + 30 * H)])],
      at,
    );
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toEqual({ kind: 'none' });
  });

  it('headroom before the recorded reset is still a return (the endpoint said so)', () => {
    const open = exhaustedAtT0();
    const at = T0 + 30 * M;
    const fleet = assessFleet(
      [acct('a', [session(60, T0 + H)]), acct('b', [weekly(100, T0 + 30 * H)])],
      at,
    );
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toMatchObject({
      kind: 'end',
      recovery: { label: 'a', how: 'headroom', backSince: at },
    });
  });

  it('an account added during the episode ends it once its numbers show headroom', () => {
    const open = exhaustedAtT0();
    const at = T0 + 5 * M;
    const fleetWith = (added: AccountUsageInput) =>
      assessFleet(
        [acct('a', [session(100, T0 + H)]), acct('b', [weekly(100, T0 + 30 * H)]), added],
        at,
      );
    expect(
      decideExhaustion(
        openEpisodeFrom(open),
        fleetWith(acct('new', [session(10, T0 + 4 * H)])),
        at,
      ),
    ).toMatchObject({
      kind: 'end',
      recovery: { label: 'new', how: 'new_account', backSince: at },
    });
  });

  it('an added account with no numbers yet (its first poll failed) does not end it', () => {
    const open = exhaustedAtT0();
    const at = T0 + 5 * M;
    const fleet = assessFleet(
      [acct('a', [session(100, T0 + H)]), acct('b', [weekly(100, T0 + 30 * H)]), acct('new')],
      at,
    );
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toEqual({ kind: 'none' });
  });

  it('a restored login ends it once its numbers show headroom; a still-dead one does not', () => {
    const fleetAt = (quarantined: boolean, limits: LimitInput[]) =>
      assessFleet([acct('q', limits, { quarantined })], T0 + 10 * M);
    const open = exhaustedRecord({
      fleet: assessFleet([acct('q', [], { quarantined: true })], T0),
      now: T0,
      active: null,
      switches: [],
    });
    expect(decideExhaustion(openEpisodeFrom(open), fleetAt(true, []), T0 + 10 * M)).toEqual({
      kind: 'none',
    });
    // Restored, but no numbers yet: nothing proves it has usage.
    expect(decideExhaustion(openEpisodeFrom(open), fleetAt(false, []), T0 + 10 * M)).toEqual({
      kind: 'none',
    });
    expect(
      decideExhaustion(openEpisodeFrom(open), fleetAt(false, [session(20, T0 + H)]), T0 + 10 * M),
    ).toMatchObject({ kind: 'end', recovery: { how: 'relogin' } });
  });

  it('a restored login whose quota was also spent waits for that reset when there are no numbers', () => {
    const open = exhaustedRecord({
      fleet: assessFleet([acct('q', [session(100, T0 + H)], { quarantined: true })], T0),
      now: T0,
      active: null,
      switches: [],
    });
    const early = assessFleet([acct('q')], T0 + 10 * M);
    expect(decideExhaustion(openEpisodeFrom(open), early, T0 + 10 * M)).toEqual({ kind: 'none' });
    const late = assessFleet([acct('q')], T0 + 2 * H);
    expect(decideExhaustion(openEpisodeFrom(open), late, T0 + 2 * H)).toMatchObject({
      kind: 'end',
      recovery: { how: 'relogin' },
    });
  });

  it('two accounts back at once: the earlier return names the end', () => {
    const open = exhaustedAtT0();
    const at = T0 + 40 * H;
    const fleet = assessFleet(
      [acct('a', [session(0, T0 + 45 * H)]), acct('b', [weekly(0, T0 + 200 * H)])],
      at,
    );
    expect(decideExhaustion(openEpisodeFrom(open), fleet, at)).toMatchObject({
      kind: 'end',
      recovery: { label: 'a', backSince: T0 + H },
    });
  });
});

describe('records', () => {
  it('the exhausted entry carries every account, the first back, the walk and a readable summary', () => {
    const fleet = assessFleet(
      [acct('a', [session(100, T0 + H)]), acct('q', [], { quarantined: true })],
      T0,
    );
    const r = exhaustedRecord({
      fleet,
      now: T0,
      active: 'a',
      switches: [{ at: T0 - H, from: 'q', to: 'a', origin: 'auto', reason: 'q at 95%' }],
    });
    expect(r).toMatchObject({
      v: 1,
      event: 'exhausted',
      id: `ep-${T0}`,
      time: '2026-10-01T12:00:00.000Z',
      active: 'a',
      firstBack: { label: 'a', at: T0 + H, predicted: false },
    });
    expect(r.accounts.map((a) => a.reason)).toEqual(['session', 'quarantined']);
    expect(r.summary).toBe(
      'No account can take work: a (5-hour window 100%, back in 1h), q (login expired). First back: a in 1h.',
    );
    expect(exhaustedCardBody(fleet, r)).toBe(
      [
        'No account can take work.',
        '• a (5-hour window 100%, back in 1h)',
        '• q (login expired)',
        'First back: a in 1h.',
        '1 switch in the last 5 hours; cctl outages lists them.',
      ].join('\n'),
    );
  });

  it('refuses to record a fleet that still has an account able to work', () => {
    const fleet = assessFleet([acct('a', [session(10, T0 + H)])], T0);
    expect(() => exhaustedRecord({ fleet, now: T0, active: null, switches: [] })).toThrow(
      /can still take work/,
    );
  });

  it('the recovered entry measures the outage to the reset, not to when the daemon noticed', () => {
    const open = exhaustedAtT0();
    const noticed = T0 + 9 * H; // say the daemon was stopped through the reset
    const r = recoveredRecord(
      open,
      { accountId: 'a', label: 'a', how: 'reset', backSince: T0 + H, limit: 'session' },
      noticed,
    );
    expect(r).toMatchObject({ id: open.id, at: noticed, backSince: T0 + H, durationMs: H });
    expect(r.summary).toBe(
      'Usage is back: a (its 5-hour window reset). No account could take work for 1h.',
    );
  });

  it('words every way back', () => {
    expect(recoveryText({ how: 'reset', limit: 'weekly_all' })).toBe('its weekly budget reset');
    expect(recoveryText({ how: 'relogin' })).toBe('its login was restored');
    expect(recoveryText({ how: 'new_account' })).toBe('a newly added account');
    expect(recoveryText({ how: 'headroom' })).toBe('it has usage left again');
  });
});

describe('the log file', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('appends one line per record, creating the folder, and reads them back', async () => {
    dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    const log = new ExhaustionLog(exhaustionLogPath(join(dir, 'nested')));
    expect(await log.read()).toEqual([]);
    const start = exhaustedAtT0();
    await log.append(start);
    const end = recoveredRecord(
      start,
      { accountId: 'a', label: 'a', how: 'headroom', backSince: T0 + H },
      T0 + H,
    );
    await log.append(end);
    const raw = await readFile(log.path, 'utf8');
    expect(raw.split('\n').filter(Boolean)).toHaveLength(2);
    expect(await log.read()).toEqual([start, end]);
    expect(log.path.endsWith('exhaustion-log.jsonl')).toBe(true);
  });

  it('a log whose folder is a file reads as empty, on every platform', async () => {
    dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    // Linux reports ENOTDIR here where Windows reports ENOENT: either way there is no log.
    await writeFile(join(dir, 'blocker'), 'not a folder');
    const log = new ExhaustionLog(join(dir, 'blocker', 'exhaustion-log.jsonl'));
    expect(await log.read()).toEqual([]);
  });

  it('skips torn lines and records from another version, keeps the rest', async () => {
    dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    const log = new ExhaustionLog(join(dir, 'x.jsonl'));
    const start = exhaustedAtT0();
    await writeFile(
      log.path,
      [
        JSON.stringify(start),
        '{"v":1,"event":"exhaus',
        JSON.stringify({ ...start, v: 2 }),
        '',
      ].join('\n'),
    );
    expect(await log.read()).toEqual([start]);
  });
});

describe('episodes', () => {
  const start = (at: number): ExhaustedRecord => ({ ...exhaustedAtT0(), id: `ep-${at}`, at });
  const end = (s: ExhaustedRecord, at: number): ExhaustionRecord =>
    recoveredRecord(s, { accountId: 'a', label: 'a', how: 'headroom', backSince: at }, at);

  it('pairs starts with ends; the last start without an end is the open one', () => {
    const s1 = start(T0);
    const s2 = start(T0 + 10 * H);
    const records = [s1, end(s1, T0 + H), s2];
    expect(episodesOf(records).map((e) => [e.start.id, e.end?.id])).toEqual([
      [s1.id, s1.id],
      [s2.id, undefined],
    ]);
    expect(openEpisodeOf(records)).toBe(s2);
    expect(openEpisodeOf([...records, end(s2, T0 + 11 * H)])).toBeUndefined();
  });

  it('an older start left without an end is history, not an open episode', () => {
    const s1 = start(T0);
    const s2 = start(T0 + 10 * H);
    expect(openEpisodeOf([s1, s2, end(s2, T0 + 11 * H)])).toBeUndefined();
  });

  it('an end with no start is dropped', () => {
    const orphan = end(start(T0), T0 + H);
    expect(episodesOf([orphan])).toEqual([]);
  });
});

describe('reading the file back', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('a record appended after a torn last line (a crash mid-append) starts its own line', async () => {
    dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    const log = new ExhaustionLog(join(dir, 'x.jsonl'));
    await writeFile(log.path, '{"v":1,"event":"recovered","id":"ep-1","at":1790');
    const record = exhaustedAtT0();
    await log.append(record);
    expect(await log.read()).toEqual([record]);
  });

  it('skips a version-1 line whose inner shape is broken, keeps the good ones', async () => {
    dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    const log = new ExhaustionLog(join(dir, 'x.jsonl'));
    const good = exhaustedAtT0();
    const broken = [
      { ...good, accounts: [null] },
      { ...good, accounts: good.accounts.map(({ spent: _spent, ...rest }) => rest) },
      { ...good, accounts: [{ ...good.accounts[0], reason: 'tired' }] },
      { ...good, switches: [{ at: 'yesterday', to: 'a' }] },
      { ...good, at: 'noon' },
      { v: 1, event: 'recovered', id: good.id, at: T0, account: null, backSince: T0 },
    ];
    await writeFile(log.path, [...broken, good].map((r) => JSON.stringify(r)).join('\n') + '\n');
    expect(await log.read()).toEqual([good]);
  });
});

describe('an open episode, tracked', () => {
  it('a wall an account hits mid-outage replaces the walls it was recorded with', () => {
    const open = openEpisodeFrom(exhaustedAtT0());
    // At the start a was out on its 5-hour window; now its week is at the wall too.
    const later = assessFleet(
      [
        acct('a', [session(100, T0 + H), weekly(99, T0 + 90 * H)]),
        acct('b', [weekly(100, T0 + 30 * H)]),
      ],
      T0 + 30 * M,
    );
    const tracked = trackOpenEpisode(open, later, T0 + 30 * M);
    expect(tracked.accounts.get('a')).toMatchObject({
      lastOutAt: T0 + 30 * M,
      spent: [
        { kind: 'session', percent: 100 },
        { kind: 'weekly_all', percent: 99 },
      ],
    });
    // After the window's reset, a poll with no numbers is no proof: the week is still ahead.
    const empty = assessFleet([acct('a'), acct('b', [weekly(100, T0 + 30 * H)])], T0 + 2 * H);
    expect(
      decideExhaustion(trackOpenEpisode(tracked, empty, T0 + 2 * H), empty, T0 + 2 * H),
    ).toEqual({
      kind: 'none',
    });
  });

  it('an account first seen out mid-outage joins it, so its return needs the same proof', () => {
    const open = openEpisodeFrom(exhaustedAtT0());
    const withC = assessFleet(
      [
        acct('a', [session(100, T0 + H)]),
        acct('b', [weekly(100, T0 + 30 * H)]),
        acct('c', [session(100, T0 + 2 * H)]),
      ],
      T0 + 10 * M,
    );
    const tracked = trackOpenEpisode(open, withC, T0 + 10 * M);
    expect(tracked.accounts.get('c')?.reason).toBe('session');
    const cEmpty = assessFleet(
      [acct('a', [session(100, T0 + H)]), acct('b', [weekly(100, T0 + 30 * H)]), acct('c')],
      T0 + 20 * M,
    );
    expect(decideExhaustion(tracked, cEmpty, T0 + 20 * M)).toEqual({ kind: 'none' });
  });

  it('a dead login with no numbers keeps the walls it had', () => {
    const open = openEpisodeFrom(
      exhaustedRecord({
        fleet: assessFleet([acct('q', [session(100, T0 + H)], { quarantined: true })], T0),
        now: T0,
        active: null,
        switches: [],
      }),
    );
    const blind = assessFleet([acct('q', [], { quarantined: true })], T0 + 10 * M);
    expect(trackOpenEpisode(open, blind, T0 + 10 * M).accounts.get('q')?.spent).toEqual([
      session(100, T0 + H),
    ]);
  });
});

describe('outageStatus (what the CLI shows)', () => {
  it('with nothing open, the outage is on exactly when no account can take work', () => {
    const out = assessFleet([acct('a', [session(100, T0 + H)])], T0);
    const fine = assessFleet([acct('a', [session(10, T0 + H)])], T0);
    expect(outageStatus(undefined, out, T0)).toEqual({ on: true });
    expect(outageStatus(undefined, fine, T0)).toEqual({ on: false });
  });

  it('an open outage stays on through a reading with no numbers, and ends on proof', () => {
    const open = exhaustedAtT0();
    const blind = assessFleet([acct('a'), acct('b', [weekly(100, T0 + 30 * H)])], T0 + 10 * M);
    expect(outageStatus(openEpisodeFrom(open), blind, T0 + 10 * M)).toEqual({ on: true });
    const back = assessFleet(
      [acct('a', [session(5, T0 + 6 * H)]), acct('b', [weekly(100, T0 + 30 * H)])],
      T0 + 2 * H,
    );
    expect(outageStatus(openEpisodeFrom(open), back, T0 + 2 * H)).toMatchObject({
      on: false,
      recovery: { label: 'a', how: 'reset', backSince: T0 + H },
    });
  });
});

describe('a clock that stepped back', () => {
  it('never dates the end before the start, and a zero-length outage reads "<1m"', () => {
    const open = exhaustedRecord({
      fleet: assessFleet([acct('a', [session(100, T0 + 2 * H)])], T0 + H),
      now: T0 + H,
      active: 'a',
      switches: [],
    });
    const r = recoveredRecord(
      open,
      { accountId: 'a', label: 'a', how: 'headroom', backSince: T0 + 10 * M },
      T0 + 10 * M,
    );
    expect(r).toMatchObject({ backSince: open.at, durationMs: 0 });
    expect(r.summary).toBe(
      'Usage is back: a (it has usage left again). No account could take work for <1m.',
    );
  });
});

describe('walls lines: what an open outage learned, on file', () => {
  /** A walls line for `a`, filed at `at`. */
  const walls = (open: ExhaustedRecord, at: number, spent: LimitInput[]): WallsRecord => ({
    v: 1,
    event: 'walls',
    id: open.id,
    at,
    time: new Date(at).toISOString(),
    accountId: 'a',
    label: 'a',
    reason: 'session',
    spent,
  });

  it('files a new wall once, and nothing while the walls hold still', () => {
    let open = openEpisodeFrom(exhaustedAtT0());
    expect(fileWallChanges(open, T0).records).toEqual([]);
    const later = assessFleet(
      [
        acct('a', [session(100, T0 + H), weekly(99, T0 + 90 * H)]),
        acct('b', [weekly(100, T0 + 30 * H)]),
      ],
      T0 + 30 * M,
    );
    open = trackOpenEpisode(open, later, T0 + 30 * M);
    const first = fileWallChanges(open, T0 + 30 * M);
    expect(first.records.map((r) => [r.accountId, r.spent.map((l) => l.kind)])).toEqual([
      ['a', ['session', 'weekly_all']],
    ]);
    const again = trackOpenEpisode(first.open, later, T0 + 40 * M);
    expect(fileWallChanges(again, T0 + 40 * M).records).toEqual([]);
  });

  it('a reset that jitters by seconds is not a change; one that moves past the margin is', () => {
    const open = openEpisodeFrom(exhaustedAtT0());
    const at = (resetsAt: number) =>
      trackOpenEpisode(
        open,
        assessFleet(
          [acct('a', [session(100, resetsAt)]), acct('b', [weekly(100, T0 + 30 * H)])],
          T0 + 5 * M,
        ),
        T0 + 5 * M,
      );
    expect(fileWallChanges(at(T0 + H + 2_000), T0 + 5 * M).records).toEqual([]);
    expect(fileWallChanges(at(T0 + H + WALL_MOVE_MS + 1), T0 + 5 * M).records).toHaveLength(1);
  });

  it('an account first seen mid-outage is filed', () => {
    const open = openEpisodeFrom(exhaustedAtT0());
    const withC = trackOpenEpisode(
      open,
      assessFleet(
        [
          acct('a', [session(100, T0 + H)]),
          acct('b', [weekly(100, T0 + 30 * H)]),
          acct('c', [session(100, T0 + 2 * H)]),
        ],
        T0 + 10 * M,
      ),
      T0 + 10 * M,
    );
    expect(fileWallChanges(withC, T0 + 10 * M).records.map((r) => r.accountId)).toEqual(['c']);
  });

  it('a resumed outage folds its walls lines in, the last one winning', () => {
    const start = exhaustedAtT0();
    const records = [
      start,
      walls(start, T0 + 20 * M, [session(100, T0 + H), weekly(99, T0 + 90 * H)]),
      walls(start, T0 + 40 * M, [weekly(99, T0 + 95 * H)]),
    ];
    const resumed = resumeOpenEpisode(records);
    expect(resumed?.record).toBe(start);
    expect(resumed?.accounts.get('a')).toMatchObject({
      lastOutAt: T0 + 40 * M,
      spent: [weekly(99, T0 + 95 * H)],
    });
    // Walls lines of an episode that has ended belong to nobody.
    const ended = recoveredRecord(
      start,
      { accountId: 'b', label: 'b', how: 'headroom', backSince: T0 + H },
      T0 + H,
    );
    expect(resumeOpenEpisode([...records, ended])).toBeUndefined();
  });

  it('walls lines are tracking, not history, and a start written twice is one episode', () => {
    const start = exhaustedAtT0();
    const w = walls(start, T0 + 20 * M, [session(100, T0 + H)]);
    expect(episodesOf([start, w, start]).map((e) => e.start.id)).toEqual([start.id]);
  });

  it('a walls line with a broken shape is skipped on read', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'exhaustion-log-'));
    try {
      const log = new ExhaustionLog(join(dir, 'x.jsonl'));
      const start = exhaustedAtT0();
      const good = walls(start, T0 + M, [session(100, T0 + H)]);
      await writeFile(
        log.path,
        [start, { ...good, spent: 'none' }, good].map((r) => JSON.stringify(r)).join('\n') + '\n',
      );
      expect(await log.read()).toEqual([start, good]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('walls with two limits of the same kind', () => {
  it('an account out on an Opus and a Fable weekly cap is not filed again and again', () => {
    // Both caps normalize to weekly_scoped; they reset at different times.
    const twoCaps = [
      { kind: 'weekly_scoped' as const, percent: 100, resetsAt: T0 + 30 * H },
      { kind: 'weekly_scoped' as const, percent: 100, resetsAt: T0 + 50 * H },
    ];
    let open = openEpisodeFrom(
      exhaustedRecord({
        fleet: assessFleet([acct('a', twoCaps)], T0),
        now: T0,
        active: 'a',
        switches: [],
      }),
    );
    let filed = 0;
    for (let i = 1; i <= 10; i++) {
      const at = T0 + i * 10 * M;
      // The endpoint may list them in either order.
      const reading = i % 2 === 0 ? [...twoCaps].reverse() : twoCaps;
      open = trackOpenEpisode(open, assessFleet([acct('a', reading)], at), at);
      const step = fileWallChanges(open, at);
      filed += step.records.length;
      open = step.open;
    }
    expect(filed).toBe(0);
  });
});
