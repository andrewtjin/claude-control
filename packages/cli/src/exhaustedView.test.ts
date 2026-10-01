import { describe, it, expect } from 'vitest';
import {
  assessFleet,
  type AccountUsageInput,
  type LimitInput,
} from '@claude-control/usage-advisor';
import type { ExhaustedRecord, ExhaustionEpisode, RecoveredRecord } from '@claude-control/daemon';
import {
  episodesInWindow,
  formatLocalTime,
  renderExhaustionBanner,
  renderExhaustionLog,
} from './exhaustedView.js';

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
        spent: [],
      },
      {
        accountId: 'a2',
        label: 'w2',
        reason: 'session',
        percent: 99.6,
        backAt: at + 2 * H,
        spent: [],
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

describe('renderExhaustionLog', () => {
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
  const episodes: ExhaustionEpisode[] = [
    { start: closed, end: end(closed, local(9, 29, 11, 44)) },
    { start: start(local(10, 1, 14, 20)) },
  ];

  it('lists newest first: ongoing, then closed with how long and how it ended', () => {
    expect(
      renderExhaustionLog(episodes, { now: NOW, logPath: 'C:\\data\\exhaustion-log.jsonl' }),
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

  it('says so when nothing is on record, naming the window when one was asked for', () => {
    expect(renderExhaustionLog([], { now: NOW, logPath: 'x.jsonl' })).toBe(
      'No time on record when every account was out of usage.\nLog: x.jsonl',
    );
    expect(renderExhaustionLog([], { now: NOW, logPath: 'x.jsonl', days: 7 })).toBe(
      'No time on record in the last 7 days when every account was out of usage.\nLog: x.jsonl',
    );
  });

  it('marks an unknown reset and a predicted one', () => {
    const s = start(local(10, 1, 14, 0), {
      accounts: [
        { accountId: 'a1', label: 'a', reason: 'weekly_scoped', percent: 100, spent: [] },
        {
          accountId: 'a2',
          label: 'b',
          reason: 'weekly_all',
          percent: 100,
          backAt: local(10, 3, 9, 0),
          backAtPredicted: true,
          spent: [],
        },
      ],
    });
    const text = renderExhaustionLog([{ start: s }], { now: NOW, logPath: 'x' });
    expect(text).toContain('  a  Fable weekly cap 100%, reset time unknown');
    expect(text).toContain('  b  weekly budget 100%, back Oct 3 09:00 (predicted)');
  });
});

describe('episodesInWindow', () => {
  it('keeps the episodes that started inside the window, and any still open', () => {
    const old = start(NOW - 10 * 24 * H);
    const oldOpen = start(NOW - 9 * 24 * H);
    const recent = start(NOW - 2 * 24 * H);
    const all: ExhaustionEpisode[] = [
      { start: old, end: end(old, old.at + H) },
      { start: recent, end: end(recent, recent.at + H) },
      { start: oldOpen },
    ];
    expect(episodesInWindow(all, NOW, 7).map((e) => e.start.id)).toEqual([recent.id, oldOpen.id]);
    expect(episodesInWindow(all, NOW, undefined)).toHaveLength(3);
  });
});

describe('renderExhaustionBanner', () => {
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

  it('says nothing while an account can take work', () => {
    const fine = assessFleet(
      [acct('a', [{ kind: 'session', percent: 10, resetsAt: NOW + H }])],
      NOW,
    );
    expect(renderExhaustionBanner(fine, undefined, NOW)).toBeUndefined();
  });

  it('says since when (from the open episode) and when the first account is back', () => {
    expect(renderExhaustionBanner(out, start(local(10, 1, 14, 20)), NOW)).toBe(
      'No account can take work since Oct 1 14:20 (40m). First back: a in 2h. ' +
        'cctl exhausted lists every time this happened.',
    );
  });

  it('without an open episode (no daemon recorded it) it still says so, without a since', () => {
    expect(renderExhaustionBanner(out, undefined, NOW)).toBe(
      'No account can take work. First back: a in 2h. cctl exhausted lists every time this happened.',
    );
  });
});
