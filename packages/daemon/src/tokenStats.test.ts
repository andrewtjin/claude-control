// Aggregation tests. Pure inputs, pure outputs — no disk, no clock, no store.
//
// The cases that matter here are the ones where a number could quietly become a lie: a turn that
// falls in no activation interval, a turn on an interval boundary, and the ordering that decides
// what a reader sees first.

import { describe, it, expect } from 'vitest';
import {
  aggregateTokenStats,
  buildSlotAt,
  buildTurnAttributor,
  localDayKey,
  totalTokens,
  UNATTRIBUTED_LABEL,
} from './tokenStats.js';
import type { ActivationWindow, SessionSlotSpan } from './tokenStats.js';
import type { TranscriptScan, TranscriptTurn } from './transcriptTokens.js';

function turn(overrides: Partial<TranscriptTurn> & { tsMs: number }): TranscriptTurn {
  return {
    model: 'claude-sonnet-5',
    inputTokens: 1,
    outputTokens: 2,
    cacheCreationTokens: 4,
    cacheReadTokens: 8,
    ...overrides,
  };
}

function scanOf(turns: TranscriptTurn[], overrides: Partial<TranscriptScan> = {}): TranscriptScan {
  return {
    turns,
    filesScanned: turns.length,
    filesSkippedByMtime: 0,
    filesUnreadable: 0,
    dirsUnreadable: 0,
    malformedLines: 0,
    duplicateTurns: 0,
    ...overrides,
  };
}

const T0 = Date.parse('2026-07-10T00:00:00.000Z');
const HOUR = 3_600_000;

function aggregate(turns: TranscriptTurn[], intervals: ActivationWindow[] = []) {
  return aggregateTokenStats({
    scan: scanOf(turns),
    intervals,
    windowStartMs: T0 - 7 * 24 * HOUR,
    windowEndMs: T0 + 24 * HOUR,
    labelById: new Map([
      ['acct-a', 'main'],
      ['acct-b', 'spare'],
    ]),
  });
}

describe('aggregateTokenStats', () => {
  it('sums every token kind into the overall totals', () => {
    const stats = aggregate([
      turn({
        tsMs: T0,
        inputTokens: 10,
        outputTokens: 20,
        cacheCreationTokens: 30,
        cacheReadTokens: 40,
      }),
      turn({
        tsMs: T0 + HOUR,
        inputTokens: 1,
        outputTokens: 2,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
      }),
    ]);
    expect(stats.overall).toEqual({
      input: 11,
      output: 22,
      cacheCreation: 33,
      cacheRead: 44,
      turns: 2,
    });
    expect(totalTokens(stats.overall)).toBe(110);
  });

  it('attributes each turn to the account live at that moment', () => {
    const stats = aggregate(
      [
        turn({ tsMs: T0 + HOUR, outputTokens: 100 }),
        turn({ tsMs: T0 + 3 * HOUR, outputTokens: 200 }),
      ],
      [
        { accountId: 'acct-a', startedAtMs: T0, endedAtMs: T0 + 2 * HOUR },
        { accountId: 'acct-b', startedAtMs: T0 + 2 * HOUR, endedAtMs: null },
      ],
    );
    expect(stats.byAccount.map((r) => [r.accountId, r.label, r.totals.output])).toEqual([
      ['acct-b', 'spare', 200],
      ['acct-a', 'main', 100],
    ]);
  });

  it('buckets pre-journal turns as unattributed and RENDERS them, never dropping them', () => {
    const stats = aggregate(
      [turn({ tsMs: T0 - HOUR, outputTokens: 500 }), turn({ tsMs: T0 + HOUR, outputTokens: 5 })],
      [{ accountId: 'acct-a', startedAtMs: T0, endedAtMs: null }],
    );
    const unattributed = stats.byAccount.find((r) => r.accountId == null);
    expect(unattributed?.label).toBe(UNATTRIBUTED_LABEL);
    expect(unattributed?.totals.output).toBe(500);
    // Biggest first, unattributed included — a mostly-unattributable week must say so at the top.
    expect(stats.byAccount[0]?.accountId ?? null).toBeNull();
    expect(totalTokens(stats.overall)).toBe(
      stats.byAccount.reduce((sum, r) => sum + totalTokens(r.totals), 0),
    );
  });

  it('treats an interval as half-open: its end instant belongs to the NEXT account', () => {
    const stats = aggregate(
      [turn({ tsMs: T0 + 2 * HOUR, outputTokens: 7 })],
      [
        { accountId: 'acct-a', startedAtMs: T0, endedAtMs: T0 + 2 * HOUR },
        { accountId: 'acct-b', startedAtMs: T0 + 2 * HOUR, endedAtMs: null },
      ],
    );
    expect(stats.byAccount).toHaveLength(1);
    expect(stats.byAccount[0]?.accountId).toBe('acct-b');
  });

  it('leaves a turn inside a CLOSED gap unattributed', () => {
    // The journal only closes an interval when another opens, but a hand-built or repaired
    // journal can leave a hole; a turn in it belongs to nobody rather than to its neighbour.
    const stats = aggregate(
      [turn({ tsMs: T0 + 5 * HOUR })],
      [{ accountId: 'acct-a', startedAtMs: T0, endedAtMs: T0 + HOUR }],
    );
    expect(stats.byAccount[0]?.accountId ?? null).toBeNull();
  });

  it('sorts intervals itself, so an unsorted journal cannot misattribute', () => {
    const unsorted: ActivationWindow[] = [
      { accountId: 'acct-b', startedAtMs: T0 + 2 * HOUR, endedAtMs: null },
      { accountId: 'acct-a', startedAtMs: T0, endedAtMs: T0 + 2 * HOUR },
    ];
    const stats = aggregate([turn({ tsMs: T0 + HOUR })], unsorted);
    expect(stats.byAccount[0]?.accountId).toBe('acct-a');
  });

  it('falls back to the raw id for an account the registry no longer knows', () => {
    const stats = aggregate(
      [turn({ tsMs: T0 + HOUR })],
      [{ accountId: 'acct-removed', startedAtMs: T0, endedAtMs: null }],
    );
    expect(stats.byAccount[0]?.label).toBe('acct-removed');
  });

  it('groups by model, biggest first', () => {
    const stats = aggregate([
      turn({ tsMs: T0, model: 'claude-sonnet-5', outputTokens: 1 }),
      turn({ tsMs: T0, model: 'claude-opus-5', outputTokens: 1000 }),
      turn({ tsMs: T0, model: 'claude-sonnet-5', outputTokens: 1 }),
    ]);
    expect(stats.byModel.map((r) => [r.label, r.totals.turns])).toEqual([
      ['claude-opus-5', 1],
      ['claude-sonnet-5', 2],
    ]);
  });

  it('groups by local calendar day in chronological order', () => {
    const day1 = T0;
    const day2 = T0 + 36 * HOUR;
    const stats = aggregate([turn({ tsMs: day2 }), turn({ tsMs: day1 }), turn({ tsMs: day1 })]);
    expect(stats.byDay.map((r) => r.label)).toEqual([localDayKey(day1), localDayKey(day2)]);
    expect(stats.byDay[0]?.totals.turns).toBe(2);
  });

  it('carries the scan coverage through untouched', () => {
    const stats = aggregateTokenStats({
      scan: scanOf([], {
        filesScanned: 12,
        filesSkippedByMtime: 400,
        filesUnreadable: 2,
        malformedLines: 3,
        duplicateTurns: 99,
      }),
      intervals: [],
      windowStartMs: T0,
      windowEndMs: T0 + HOUR,
      labelById: new Map(),
    });
    expect(stats.coverage).toEqual({
      filesScanned: 12,
      filesSkippedByMtime: 400,
      filesUnreadable: 2,
      dirsUnreadable: 0,
      malformedLines: 3,
      duplicateTurns: 99,
    });
    expect(stats.overall.turns).toBe(0);
    expect(stats.byAccount).toEqual([]);
  });

  describe('slot-aware attribution', () => {
    // Tokens for one account, by account label, out of a finished snapshot.
    function tokensFor(
      stats: ReturnType<typeof aggregateTokenStats>,
      label: string,
    ): number | undefined {
      const row = stats.byAccount.find((r) => r.label === label);
      return row ? totalTokens(row.totals) : undefined;
    }

    it('attributes a turn against its session slot, not the global account live at the same instant', () => {
      // At T0 two accounts are live AT ONCE — 'acct-a' globally, 'acct-b' in group:x. A turn from a
      // session bound to group:x must be credited to acct-b, even though acct-a is the global live
      // account at that instant.
      const intervals: ActivationWindow[] = [
        { accountId: 'acct-a', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'global' },
        { accountId: 'acct-b', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'group:x' },
      ];
      const stats = aggregateTokenStats({
        scan: scanOf([
          turn({ tsMs: T0, sessionId: 'sess-global', inputTokens: 100 }),
          turn({ tsMs: T0, sessionId: 'sess-group', inputTokens: 200 }),
        ]),
        intervals,
        windowStartMs: T0 - 7 * 24 * HOUR,
        windowEndMs: T0 + 24 * HOUR,
        labelById: new Map([
          ['acct-a', 'main'],
          ['acct-b', 'spare'],
        ]),
        slotBySession: new Map([['sess-group', 'group:x']]),
      });
      // acct-a gets the global session's turn (100 + 2 + 4 + 8 = 114); acct-b the group's (200+2+4+8).
      expect(tokensFor(stats, 'main')).toBe(114);
      expect(tokensFor(stats, 'spare')).toBe(214);
    });

    it('a session absent from the slot map falls to the global timeline', () => {
      const intervals: ActivationWindow[] = [
        { accountId: 'acct-a', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'global' },
        { accountId: 'acct-b', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'group:x' },
      ];
      const stats = aggregateTokenStats({
        scan: scanOf([turn({ tsMs: T0, sessionId: 'unknown-session', inputTokens: 50 })]),
        intervals,
        windowStartMs: T0 - 7 * 24 * HOUR,
        windowEndMs: T0 + 24 * HOUR,
        labelById: new Map([
          ['acct-a', 'main'],
          ['acct-b', 'spare'],
        ]),
        slotBySession: new Map([['some-other', 'group:x']]),
      });
      // The unknown session is global → acct-a, never the group's acct-b.
      expect(tokensFor(stats, 'main')).toBe(64);
      expect(tokensFor(stats, 'spare')).toBeUndefined();
    });

    it('a group turn with no member live in its slot at that instant is unattributed', () => {
      // The group slot only became live AFTER the turn; nothing global covers it either.
      const intervals: ActivationWindow[] = [
        { accountId: 'acct-b', startedAtMs: T0 + HOUR, endedAtMs: null, slot: 'group:x' },
      ];
      const stats = aggregateTokenStats({
        scan: scanOf([turn({ tsMs: T0, sessionId: 'sess-group', inputTokens: 9 })]),
        intervals,
        windowStartMs: T0 - 7 * 24 * HOUR,
        windowEndMs: T0 + 24 * HOUR,
        labelById: new Map([['acct-b', 'spare']]),
        slotBySession: new Map([['sess-group', 'group:x']]),
      });
      expect(tokensFor(stats, UNATTRIBUTED_LABEL)).toBe(9 + 2 + 4 + 8);
      expect(tokensFor(stats, 'spare')).toBeUndefined();
    });

    it('with no slots configured, behaves exactly as the global-only path (a legacy interval + turn)', () => {
      // Legacy intervals carry no slot (undefined) and turns no sessionId — everything is global.
      const stats = aggregate(
        [turn({ tsMs: T0, inputTokens: 5 })],
        [{ accountId: 'acct-a', startedAtMs: T0 - HOUR, endedAtMs: null }],
      );
      const row = stats.byAccount.find((r) => r.label === 'main');
      expect(row && totalTokens(row.totals)).toBe(5 + 2 + 4 + 8);
    });

    it('bills an UNREGISTERED session to its group member from a recorded span alone', () => {
      // The hand-started case: the session was never registered (absent from slotBySession), and
      // the only record of its slot is the span the hooks wrote. Without the span it would be billed
      // to the global account live at the same instant.
      const intervals: ActivationWindow[] = [
        { accountId: 'acct-a', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'global' },
        { accountId: 'acct-b', startedAtMs: T0 - HOUR, endedAtMs: null, slot: 'group:g1' },
      ];
      const stats = aggregateTokenStats({
        scan: scanOf([turn({ tsMs: T0, sessionId: 'hand-started', inputTokens: 100 })]),
        intervals,
        windowStartMs: T0 - 7 * 24 * HOUR,
        windowEndMs: T0 + 24 * HOUR,
        labelById: new Map([
          ['acct-a', 'main'],
          ['acct-b', 'spare'],
        ]),
        slotSpans: [{ sessionId: 'hand-started', slot: 'group:g1', startedAtMs: T0 - HOUR }],
      });
      expect(tokensFor(stats, 'spare')).toBe(114);
      expect(tokensFor(stats, 'main')).toBeUndefined();
    });

    it('splits a session resumed from global into a group at the span boundary', () => {
      // One session id, two runs: before the span it ran on the global profile, after it under the
      // group's. Each turn is billed to the account live in the slot it ran in at that moment.
      const intervals: ActivationWindow[] = [
        { accountId: 'acct-a', startedAtMs: T0 - 5 * HOUR, endedAtMs: null, slot: 'global' },
        { accountId: 'acct-b', startedAtMs: T0 - 5 * HOUR, endedAtMs: null, slot: 'group:g1' },
      ];
      const stats = aggregateTokenStats({
        scan: scanOf([
          turn({ tsMs: T0 - 2 * HOUR, sessionId: 'resumed', inputTokens: 10 }),
          turn({ tsMs: T0 + HOUR, sessionId: 'resumed', inputTokens: 1000 }),
        ]),
        intervals,
        windowStartMs: T0 - 7 * 24 * HOUR,
        windowEndMs: T0 + 24 * HOUR,
        labelById: new Map([
          ['acct-a', 'main'],
          ['acct-b', 'spare'],
        ]),
        slotSpans: [{ sessionId: 'resumed', slot: 'group:g1', startedAtMs: T0 }],
      });
      expect(tokensFor(stats, 'main')).toBe(10 + 2 + 4 + 8);
      expect(tokensFor(stats, 'spare')).toBe(1000 + 2 + 4 + 8);
    });
  });
});

describe('buildSlotAt', () => {
  const spans: SessionSlotSpan[] = [
    // Deliberately unsorted: the resolver must order each session's spans itself.
    { sessionId: 's1', slot: 'global', startedAtMs: 3000 },
    { sessionId: 's1', slot: 'group:g1', startedAtMs: 1000 },
    { sessionId: 's2', slot: 'group:g2', startedAtMs: 500 },
  ];

  it('answers the global slot for a turn with no session', () => {
    const slotAt = buildSlotAt(spans, new Map([['s1', 'group:mirror']]));
    expect(slotAt(null, 2000)).toBe('global');
    expect(slotAt(undefined, 2000)).toBe('global');
  });

  it('answers the span in force at the turn time, the span start itself included', () => {
    const slotAt = buildSlotAt(spans);
    expect(slotAt('s1', 1000)).toBe('group:g1');
    expect(slotAt('s1', 2999)).toBe('group:g1');
    expect(slotAt('s1', 3000)).toBe('global');
    expect(slotAt('s1', 9999)).toBe('global');
  });

  it("never lets one session's spans answer for another", () => {
    const slotAt = buildSlotAt(spans);
    expect(slotAt('s2', 2000)).toBe('group:g2');
    expect(slotAt('s3', 2000)).toBe('global');
  });

  it('falls back to the sessions mirror before the first span, else to global', () => {
    // Before its first span the earlier run's slot is unknown: the first span must NOT be borrowed
    // backwards, or a resumed session's whole pre-binding history would bill to the group.
    expect(buildSlotAt(spans)('s1', 999)).toBe('global');
    expect(buildSlotAt(spans, new Map([['s1', 'group:mirror']]))('s1', 999)).toBe('group:mirror');
  });

  it('answers from the sessions mirror alone when no spans were recorded', () => {
    const slotAt = buildSlotAt([], new Map([['registered', 'group:g1']]));
    expect(slotAt('registered', 0)).toBe('group:g1');
    expect(slotAt('other', 0)).toBe('global');
  });

  it('lets a recorded span override the mirror once it is in force', () => {
    // The mirror holds one slot per session; a later span (a resume elsewhere) is more precise.
    const slotAt = buildSlotAt(
      [{ sessionId: 's1', slot: 'global', startedAtMs: 1000 }],
      new Map([['s1', 'group:g1']]),
    );
    expect(slotAt('s1', 500)).toBe('group:g1');
    expect(slotAt('s1', 1500)).toBe('global');
  });
});

describe('buildTurnAttributor', () => {
  const intervals: ActivationWindow[] = [
    { accountId: 'acct-global', startedAtMs: 0, endedAtMs: null, slot: 'global' },
    // A member hop inside the group slot, listed out of order: acct-g1a until 2000, acct-g1b after.
    { accountId: 'acct-g1b', startedAtMs: 2000, endedAtMs: null, slot: 'group:g1' },
    { accountId: 'acct-g1a', startedAtMs: 0, endedAtMs: 2000, slot: 'group:g1' },
  ];

  it("bills a span-only session against its group slot's timeline, member hops included", () => {
    const accountFor = buildTurnAttributor({
      intervals,
      slotSpans: [{ sessionId: 'hand', slot: 'group:g1', startedAtMs: 0 }],
    });
    expect(accountFor({ sessionId: 'hand', tsMs: 1000 })).toBe('acct-g1a');
    expect(accountFor({ sessionId: 'hand', tsMs: 2500 })).toBe('acct-g1b');
    // A session nobody recorded stays on the global timeline.
    expect(accountFor({ sessionId: 'other', tsMs: 2500 })).toBe('acct-global');
  });

  it('bills a resumed session to global before its span and to the group after', () => {
    const accountFor = buildTurnAttributor({
      intervals,
      slotSpans: [{ sessionId: 'resumed', slot: 'group:g1', startedAtMs: 2500 }],
    });
    expect(accountFor({ sessionId: 'resumed', tsMs: 1000 })).toBe('acct-global');
    expect(accountFor({ sessionId: 'resumed', tsMs: 3000 })).toBe('acct-g1b');
  });

  it('claims no account for a slot with no interval covering the turn', () => {
    const accountFor = buildTurnAttributor({
      intervals,
      slotSpans: [{ sessionId: 's', slot: 'group:unknown', startedAtMs: 0 }],
    });
    // Never the global account: a group turn with no live member is unattributed, not misbilled.
    expect(accountFor({ sessionId: 's', tsMs: 1000 })).toBeNull();
  });

  it('reads an interval with no slot as a global one', () => {
    const accountFor = buildTurnAttributor({
      intervals: [{ accountId: 'legacy', startedAtMs: 0, endedAtMs: null }],
    });
    expect(accountFor({ sessionId: null, tsMs: 10 })).toBe('legacy');
    expect(accountFor({ sessionId: 'any', tsMs: 10 })).toBe('legacy');
  });
});

describe('localDayKey', () => {
  it('formats a zero-padded, sortable local date', () => {
    const key = localDayKey(new Date(2026, 0, 5, 13, 30).getTime());
    expect(key).toBe('2026-01-05');
  });

  it('sorts lexicographically in chronological order across a year boundary', () => {
    const dec = localDayKey(new Date(2025, 11, 31).getTime());
    const jan = localDayKey(new Date(2026, 0, 1).getTime());
    expect([jan, dec].sort((a, b) => a.localeCompare(b))).toEqual([dec, jan]);
  });
});
