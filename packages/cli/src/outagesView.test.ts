import { describe, it, expect } from 'vitest';
import {
  assessFleet,
  type AccountUsageInput,
  type LimitInput,
} from '@claude-control/usage-advisor';
import {
  GLOBAL_SCOPE,
  openEpisodeFrom,
  type ExhaustedRecord,
  type ExhaustionEpisode,
  type OutageScope,
  type RecoveredRecord,
} from '@claude-control/daemon';
import {
  episodesForFolder,
  episodesInWindow,
  expectedFirstBack,
  formatLocalTime,
  renderOutageBanner,
  renderOutages,
} from './outagesView.js';
import { displayWidth } from './textWidth.js';

// Built from LOCAL components, so the expected strings hold in whatever zone the suite runs.
const local = (month: number, day: number, hour: number, minute: number, year = 2026): number =>
  new Date(year, month - 1, day, hour, minute).getTime();
const NOW = local(10, 1, 15, 0);
const H = 60 * 60 * 1000;

function start(at: number, overrides: Partial<ExhaustedRecord> = {}): ExhaustedRecord {
  return {
    v: 1,
    event: 'exhausted',
    id: `ep-${at}`,
    at,
    time: new Date(at).toISOString(),
    summary: '',
    active: 'work1',
    accounts: [
      {
        accountId: 'a1',
        label: 'work1',
        reason: 'weekly_all',
        percent: 100,
        backAt: at + 30 * H,
        spent: [{ kind: 'weekly_all', percent: 100, resetsAt: at + 30 * H }],
      },
      {
        accountId: 'a2',
        label: 'w2',
        reason: 'session',
        percent: 99.6,
        backAt: at + 2 * H,
        spent: [{ kind: 'session', percent: 99.6, resetsAt: at + 2 * H }],
      },
      { accountId: 'a3', label: 'work3', reason: 'quarantined', spent: [] },
    ],
    firstBack: { accountId: 'a2', label: 'w2', at: at + 2 * H, predicted: false },
    switches: [],
    ...overrides,
  };
}

function end(s: ExhaustedRecord, backSince: number): RecoveredRecord {
  return {
    v: 1,
    event: 'recovered',
    id: s.id,
    at: backSince + 60_000,
    time: '',
    summary: '',
    backSince,
    durationMs: backSince - s.at,
    account: { accountId: 'a2', label: 'w2' },
    how: 'reset',
    limit: 'session',
  };
}

describe('formatLocalTime', () => {
  it('reads as a local month, day and 24-hour time, with the year only when it differs', () => {
    expect(formatLocalTime(local(10, 1, 9, 5), NOW)).toBe('Oct 1 09:05');
    expect(formatLocalTime(local(12, 31, 23, 59, 2025), NOW)).toBe('Dec 31 2025 23:59');
  });
});

describe('renderOutages', () => {
  const closed = start(local(9, 29, 9, 44), {
    switches: [
      {
        at: local(9, 29, 6, 44),
        from: 'work1',
        to: 'w2',
        origin: 'auto',
        reason: 'work1 at 95% of its weekly budget',
      },
      { at: local(9, 29, 8, 44), from: null, to: 'work1' },
    ],
  });
  const ongoing = start(local(10, 1, 14, 20));
  const episodes: ExhaustionEpisode[] = [
    { start: closed, end: end(closed, local(9, 29, 11, 44)) },
    { start: ongoing },
  ];

  it('lists newest first: the open outage, then closed ones with how long and how they ended', () => {
    expect(
      renderOutages(episodes, {
        now: NOW,
        logPath: 'C:\\data\\exhaustion-log.jsonl',
        open: [
          {
            id: ongoing.id,
            scope: GLOBAL_SCOPE,
            expected: { label: 'w2', at: local(10, 1, 16, 20) },
          },
        ],
      }),
    ).toBe(
      [
        '2 times no account could take work (newest first):',
        '',
        'Oct 1 14:20 -> ongoing, 40m so far; first back expected: w2 at Oct 1 16:20',
        '  work1  weekly budget 100%, back Oct 2 20:20',
        '  w2     5-hour window 100%, back Oct 1 16:20',
        '  work3  login expired',
        '  No switches in the 5 hours before.',
        '',
        'Sep 29 09:44 -> Sep 29 11:44  2h  back: w2 (its 5-hour window reset)',
        '  work1  weekly budget 100%, back Sep 30 15:44',
        '  w2     5-hour window 100%, back Sep 29 11:44',
        '  work3  login expired',
        '  Switches in the 5 hours before:',
        '    Sep 29 06:44  work1 -> w2  auto: work1 at 95% of its weekly budget',
        '    Sep 29 08:44  (none) -> work1',
        '',
        'Log: C:\\data\\exhaustion-log.jsonl',
      ].join('\n'),
    );
  });

  it('names every limit holding an account out, and the reset of the last', () => {
    const s = start(local(10, 1, 14, 0), {
      accounts: [
        {
          accountId: 'a1',
          label: 'a',
          reason: 'session',
          percent: 100,
          backAt: local(10, 4, 14, 0),
          spent: [
            { kind: 'session', percent: 100, resetsAt: local(10, 1, 15, 0) },
            { kind: 'weekly_all', percent: 99, resetsAt: local(10, 4, 14, 0) },
          ],
        },
      ],
    });
    const text = renderOutages([{ start: s }], {
      now: NOW,
      logPath: 'x',
      open: [{ id: s.id, scope: GLOBAL_SCOPE }],
    });
    expect(text).toContain('  a  5-hour window 100% and weekly budget 99%, back Oct 4 14:00');
  });

  it('marks an unknown reset and a predicted one', () => {
    const s = start(local(10, 1, 14, 0), {
      accounts: [
        {
          accountId: 'a1',
          label: 'a',
          reason: 'weekly_scoped',
          percent: 100,
          spent: [{ kind: 'weekly_scoped', percent: 100 }],
        },
        {
          accountId: 'a2',
          label: 'b',
          reason: 'weekly_all',
          percent: 100,
          backAt: local(10, 3, 9, 0),
          backAtPredicted: true,
          spent: [{ kind: 'weekly_all', percent: 100 }],
        },
      ],
    });
    const text = renderOutages([{ start: s }], {
      now: NOW,
      logPath: 'x',
      open: [{ id: s.id, scope: GLOBAL_SCOPE }],
    });
    expect(text).toContain('  a  Fable weekly cap 100%, reset time unknown');
    expect(text).toContain('  b  weekly budget 100%, back Oct 3 09:00 (predicted)');
  });

  it('a start whose end was never written is not "ongoing" when it is not the open outage', () => {
    const orphan = start(local(9, 20, 10, 0));
    const text = renderOutages([{ start: orphan }], { now: NOW, logPath: 'x' });
    expect(text).toContain('Sep 20 10:00 -> end not recorded');
    expect(text).not.toContain('ongoing');
  });

  it('an open outage the latest numbers show is over says so, and who is back since when', () => {
    const text = renderOutages([{ start: ongoing }], {
      now: NOW,
      logPath: 'x',
      open: [
        {
          id: ongoing.id,
          scope: GLOBAL_SCOPE,
          overBy: {
            accountId: 'a2',
            label: 'w2',
            how: 'reset',
            limit: 'session',
            backSince: local(10, 1, 14, 50),
          },
        },
      ],
    });
    expect(text).toContain(
      'Oct 1 14:20 -> over by the latest numbers: w2 back since Oct 1 14:50 (its 5-hour window reset); no running daemon has recorded the end yet',
    );
  });

  it('says so when nothing is on record, naming the window when one was asked for', () => {
    expect(renderOutages([], { now: NOW, logPath: 'x.jsonl' })).toBe(
      'No time on record when every account was out of usage.\nLog: x.jsonl',
    );
    expect(renderOutages([], { now: NOW, logPath: 'x.jsonl', days: 7 })).toBe(
      'No time on record in the last 7 days when every account was out of usage.\nLog: x.jsonl',
    );
    expect(renderOutages([], { now: NOW, logPath: 'x.jsonl', days: 1 })).toContain(
      'in the last 1 day when',
    );
  });
});

describe('episodesInWindow', () => {
  it('keeps the episodes that started inside the window, and the open outage however old', () => {
    const old = start(NOW - 10 * 24 * H);
    const orphan = start(NOW - 9 * 24 * H);
    const recent = start(NOW - 2 * 24 * H);
    const openOld = start(NOW - 8 * 24 * H);
    const all: ExhaustionEpisode[] = [
      { start: old, end: end(old, old.at + H) },
      { start: orphan },
      { start: recent, end: end(recent, recent.at + H) },
      { start: openOld },
    ];
    expect(
      episodesInWindow(all, NOW, 7, [{ id: openOld.id, scope: GLOBAL_SCOPE }]).map(
        (e) => e.start.id,
      ),
    ).toEqual([recent.id, openOld.id]);
    expect(
      episodesInWindow(all, NOW, undefined, [{ id: openOld.id, scope: GLOBAL_SCOPE }]),
    ).toHaveLength(4);
  });
});

describe('renderOutageBanner', () => {
  const acct = (id: string, limits: LimitInput[], quarantined = false): AccountUsageInput => ({
    accountId: id,
    label: id,
    active: false,
    quarantined,
    limits,
  });
  const out = assessFleet(
    [acct('a', [{ kind: 'session', percent: 100, resetsAt: NOW + 2 * H }]), acct('q', [], true)],
    NOW,
  );

  it('says since when (from the open outage) and when the first account is back', () => {
    expect(renderOutageBanner(out, openEpisodeFrom(start(local(10, 1, 14, 20))), NOW)).toBe(
      'No account can take work since Oct 1 14:20 (40m). First back: a in 2h. ' +
        'cctl outages lists every time this happened.',
    );
  });

  it('without an open outage in the log it still says so, without a since', () => {
    expect(renderOutageBanner(out, undefined, NOW)).toBe(
      'No account can take work. First back: a in 2h. cctl outages lists every time this happened.',
    );
  });

  // The outage's own accounts, with no numbers right now (a poll that came back empty).
  const unmeasured = assessFleet([acct('a1', []), acct('a2', []), acct('a3', [], true)], NOW);

  it('when an account has no numbers right now, the first-back time comes from the outage record', () => {
    expect(unmeasured.exhausted).toBe(false);
    expect(renderOutageBanner(unmeasured, openEpisodeFrom(start(local(10, 1, 14, 20))), NOW)).toBe(
      'No account can take work since Oct 1 14:20 (40m). First back expected: w2 at Oct 1 16:20. ' +
        'cctl outages lists every time this happened.',
    );
  });

  it('a later walls line moves the expected first-back time with it', () => {
    const s0 = start(local(10, 1, 14, 20));
    // w2's 5-hour window was due at 16:20; a walls line since says it is out for the week too.
    const open = openEpisodeFrom(s0, [
      {
        v: 1,
        event: 'walls',
        id: s0.id,
        at: local(10, 1, 14, 50),
        time: '',
        accountId: 'a2',
        label: 'w2',
        reason: 'session',
        spent: [
          { kind: 'session', percent: 100, resetsAt: local(10, 1, 16, 20) },
          { kind: 'weekly_all', percent: 99, resetsAt: local(10, 3, 9, 0) },
        ],
      },
    ]);
    // work1 (week, back Oct 2 20:20) is now the first back, not w2.
    expect(renderOutageBanner(unmeasured, open, NOW)).toContain(
      'First back expected: work1 at Oct 2 20:20.',
    );
  });
});

describe('expectedFirstBack', () => {
  const s0 = start(local(10, 1, 14, 20));
  const acct = (id: string): AccountUsageInput => ({
    accountId: id,
    label: id,
    active: false,
    quarantined: false,
    limits: [],
  });

  it('skips a time that has already passed: the next account still ahead is named', () => {
    // w2 was due back at 16:20 and the outage is still on at 17:00 (its reset moved, or the
    // numbers say nothing): work1, due Oct 2 20:20, is the one still expected.
    expect(expectedFirstBack(openEpisodeFrom(s0), local(10, 1, 17, 0))).toEqual({
      label: 'work1',
      at: local(10, 2, 20, 20),
    });
  });

  it('with the current fleet, an account removed since the outage began is not named', () => {
    const withoutW2 = assessFleet([acct('a1'), acct('a3')], NOW);
    expect(expectedFirstBack(openEpisodeFrom(s0), NOW, withoutW2)).toEqual({
      label: 'work1',
      at: local(10, 2, 20, 20),
    });
    expect(expectedFirstBack(openEpisodeFrom(s0), NOW, assessFleet([], NOW))).toBeUndefined();
  });
});

describe('scopes in the views', () => {
  const research: OutageScope = {
    kind: 'folder',
    ruleId: 'r1',
    folders: ['C:\\research'],
    label: 'C:\\research',
  };
  const folderStart = (at: number): ExhaustedRecord =>
    start(at, {
      v: 2,
      id: `ep-${at}-r1`,
      scope: research,
      accounts: [
        {
          accountId: 'e1',
          label: 'inc1',
          reason: 'session',
          percent: 100,
          backAt: at + 2 * H,
          spent: [{ kind: 'session', percent: 100, resetsAt: at + 2 * H }],
        },
        {
          accountId: 'a1',
          label: 'work1',
          reason: 'live_elsewhere',
          spent: [],
          liveIn: 'the global slot',
        },
      ],
    });

  it('tags every episode with its scope once one is a folder, and says where a held account is live', () => {
    const g = start(local(9, 29, 9, 44));
    const f = folderStart(local(10, 1, 14, 20));
    const text = renderOutages([{ start: g, end: end(g, local(9, 29, 11, 44)) }, { start: f }], {
      now: NOW,
      logPath: 'x',
      open: [{ id: f.id, scope: research }],
    });
    expect(text).toContain('[C:\\research] Oct 1 14:20 -> ongoing, 40m so far');
    expect(text).toContain('[global] Sep 29 09:44 -> Sep 29 11:44  2h  back: w2');
    expect(text).toContain('  work1  live in the global slot');
  });

  it('matches an open status by scope as well as id', () => {
    const f = folderStart(local(10, 1, 14, 20));
    // A global status with the same id is not this folder episode's.
    const text = renderOutages([{ start: f }], {
      now: NOW,
      logPath: 'x',
      open: [{ id: f.id, scope: GLOBAL_SCOPE }],
    });
    expect(text).toContain('end not recorded');
  });

  it('an episode ended by its rule removed names no account', () => {
    const f = folderStart(local(10, 1, 12, 0));
    const removed: RecoveredRecord = {
      v: 2,
      event: 'recovered',
      id: f.id,
      scope: research,
      at: local(10, 1, 13, 0),
      time: '',
      summary: '',
      backSince: local(10, 1, 13, 0),
      durationMs: H,
      how: 'rule_removed',
    };
    const text = renderOutages([{ start: f, end: removed }], { now: NOW, logPath: 'x' });
    expect(text).toContain(
      '[C:\\research] Oct 1 12:00 -> Oct 1 13:00  1h  ended: its folder rule was removed',
    );
  });

  it('an open folder episode whose rule is gone says so', () => {
    const f = folderStart(local(10, 1, 14, 20));
    const text = renderOutages([{ start: f }], {
      now: NOW,
      logPath: 'x',
      open: [{ id: f.id, scope: research, ruleRemoved: true }],
    });
    expect(text).toContain(
      'Oct 1 14:20 -> its folder rule was removed; no running daemon has recorded the end yet',
    );
  });

  it('a list narrowed to a folder with nothing on record names the folder', () => {
    expect(renderOutages([], { now: NOW, logPath: 'x', folder: 'C:\\research' })).toBe(
      "No time on record when every account in C:\\research's pool was out of usage.\nLog: x",
    );
  });

  it('--folder resolves a folder or a subfolder to its rule, the longest rule folder winning', () => {
    const outer = folderStart(local(10, 1, 10, 0));
    const inner = start(local(10, 1, 11, 0), {
      v: 2,
      id: 'inner',
      scope: { ...research, ruleId: 'r2', folders: ['C:\\research\\deep'], label: 'deep' },
    });
    const g = start(local(10, 1, 9, 0));
    const all: ExhaustionEpisode[] = [{ start: g }, { start: outer }, { start: inner }];
    const ids = (folder: string) => episodesForFolder(all, folder, 'win32').map((e) => e.start.id);
    expect(ids('C:\\research')).toEqual([outer.id]);
    expect(ids('C:\\research\\other')).toEqual([outer.id]);
    expect(ids('C:\\research\\deep\\x')).toEqual(['inner']);
    expect(ids('C:\\elsewhere')).toEqual([]);
  });

  it('--folder resolves against the rules in force, not only those with outages on record', () => {
    // r1 was reset and the folder included again, which made a new rule r9 on the same folder.
    const old = folderStart(local(10, 1, 10, 0));
    const current = start(local(10, 1, 12, 0), {
      v: 2,
      id: 'current',
      scope: { ...research, ruleId: 'r9' },
    });
    const g = start(local(10, 1, 9, 0));
    const all: ExhaustionEpisode[] = [{ start: g }, { start: old }, { start: current }];
    const rules = [
      { id: 'r9', folders: ['C:\\research'] },
      { id: 'deep', folders: ['C:\\research\\deep'] },
    ];
    const ids = (folder: string) =>
      episodesForFolder(all, folder, 'win32', rules).map((e) => e.start.id);
    expect(ids('C:\\research')).toEqual(['current']);
    // deep runs under its own rule now, which has nothing on record: not its parent's outages.
    expect(ids('C:\\research\\deep\\x')).toEqual([]);
    // A folder no rule applies to runs under the global pool.
    expect(ids('C:\\elsewhere')).toEqual([g.id]);
  });

  it('--folder on a folder whose rule was removed shows the global pool and that rule history', () => {
    const removed = folderStart(local(10, 1, 10, 0));
    const g = start(local(10, 1, 9, 0));
    const all: ExhaustionEpisode[] = [{ start: g }, { start: removed }];
    expect(episodesForFolder(all, 'C:\\research', 'win32', []).map((e) => e.start.id)).toEqual([
      g.id,
      removed.id,
    ]);
  });

  it('a folder banner line names the folder', () => {
    const out = assessFleet(
      [
        {
          accountId: 'e1',
          label: 'inc1',
          active: false,
          quarantined: false,
          limits: [{ kind: 'session', percent: 100, resetsAt: NOW + 2 * H }],
        },
      ],
      NOW,
    );
    expect(renderOutageBanner(out, undefined, NOW, undefined, research)).toBe(
      "No account in C:\\research's pool can take work. First back: inc1 in 2h. " +
        'cctl outages lists every time this happened.',
    );
  });
});

describe('renderOutages column widths', () => {
  it('lines account lines up by terminal width, CJK labels included', () => {
    const s = start(local(10, 1, 14, 0), {
      accounts: [
        { accountId: 'a1', label: '仕事', reason: 'quarantined', spent: [] },
        { accountId: 'a2', label: 'work', reason: 'quarantined', spent: [] },
      ],
    });
    const lines = renderOutages([{ start: s }], { now: NOW, logPath: 'x' }).split('\n');
    const at = (label: string): number => {
      const line = lines.find((l) => l.startsWith(`  ${label}`))!;
      const rest = line.slice(2 + label.length).search(/\S/);
      return displayWidth(label) + rest;
    };
    expect(at('仕事')).toBe(at('work'));
  });
});
