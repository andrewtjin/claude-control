import { describe, it, expect } from 'vitest';
import {
  assessFleet,
  type AccountUsageInput,
  type LimitInput,
} from '@claude-control/usage-advisor';
import {
  openEpisodeFrom,
  type ExhaustedRecord,
  type ExhaustionEpisode,
  type RecoveredRecord,
} from '@claude-control/daemon';
import {
  episodesInWindow,
  expectedFirstBack,
  formatLocalTime,
  renderOutageBanner,
  renderOutages,
} from './outagesView.js';

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
        open: { id: ongoing.id, expected: { label: 'w2', at: local(10, 1, 16, 20) } },
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
      open: { id: s.id },
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
      open: { id: s.id },
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
      open: {
        id: ongoing.id,
        overBy: {
          accountId: 'a2',
          label: 'w2',
          how: 'reset',
          limit: 'session',
          backSince: local(10, 1, 14, 50),
        },
      },
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
    expect(episodesInWindow(all, NOW, 7, openOld.id).map((e) => e.start.id)).toEqual([
      recent.id,
      openOld.id,
    ]);
    expect(episodesInWindow(all, NOW, undefined, openOld.id)).toHaveLength(4);
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
