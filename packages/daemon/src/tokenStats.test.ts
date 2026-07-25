// Aggregation tests. Pure inputs, pure outputs — no disk, no clock, no store.
//
// The cases that matter here are the ones where a number could quietly become a lie: a turn that
// falls in no activation interval, a turn on an interval boundary, and the ordering that decides
// what a reader sees first.

import { describe, it, expect } from 'vitest';
import { aggregateTokenStats, localDayKey, totalTokens, UNATTRIBUTED_LABEL } from './tokenStats.js';
import type { ActivationWindow } from './tokenStats.js';
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
      malformedLines: 3,
      duplicateTurns: 99,
    });
    expect(stats.overall.turns).toBe(0);
    expect(stats.byAccount).toEqual([]);
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
