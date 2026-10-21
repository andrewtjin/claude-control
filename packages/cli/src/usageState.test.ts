// The usage reader: a snapshot row of the wrong shape is skipped like an unparsable one, and a
// reader that wants no burn rate (the full-screen view) predicts resets without reading the whole
// history.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store, readFleetHistory } from '@claude-control/daemon';
import type { StoredAccount } from '@claude-control/switch-engine';
import { UsageReader } from './usageState.js';

const NOW = Date.UTC(2026, 9, 1, 12);

function stored(id: string): StoredAccount {
  return { id, label: id } as unknown as StoredAccount;
}

describe('UsageReader', () => {
  let dir: string;
  let dbPath: string;
  const engine = {
    listAccounts: () => Promise.resolve([stored('a'), stored('b'), stored('c')]),
    getActiveId: () => Promise.resolve('a'),
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctl-usage-reader-'));
    dbPath = join(dir, 'daemon.db');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function seed(rows: Array<[string, unknown]>): void {
    const store = new Store(dbPath);
    for (const [accountId, value] of rows) {
      store.insertUsageSnapshot({
        accountId,
        fetchedAtMs: NOW - 60_000,
        source: 'live',
        json: JSON.stringify(value),
      });
    }
    store.close();
  }

  it('skips a snapshot that parses but is not a usage reading, keeping the good ones', async () => {
    seed([
      ['a', { accountId: 'a', fetchedAtMs: NOW, source: 'live' }],
      [
        'b',
        { accountId: 'b', fetchedAtMs: NOW, source: 'live', limits: [], error: { status: 429 } },
      ],
      [
        'c',
        {
          accountId: 'c',
          label: 'c',
          active: false,
          source: 'live',
          fetchedAtMs: NOW,
          limits: [{ kind: 'session', percent: 12, isActive: true }],
        },
      ],
    ]);
    const reader = new UsageReader(engine, { dbPath });
    try {
      const usage = await reader.read(NOW);
      expect(usage.usageFor('a')).toBeUndefined();
      expect(usage.usageFor('b')).toBeUndefined();
      expect(usage.usageFor('c')?.limits[0]?.percent).toBe(12);
    } finally {
      reader.close();
    }
  });

  /** Weekly readings `ago` ms before NOW, each with the reset it reported (or none). */
  function seedWeekly(rows: Array<[string, number, number | undefined]>): void {
    const store = new Store(dbPath);
    for (const [accountId, ago, resetIn] of rows) {
      const limit = {
        kind: 'weekly_all',
        percent: 40,
        isActive: true,
        ...(resetIn !== undefined ? { resetsAt: new Date(NOW + resetIn).toISOString() } : {}),
      };
      store.insertUsageSnapshot({
        accountId,
        fetchedAtMs: NOW - ago,
        source: 'live',
        json: JSON.stringify({
          accountId,
          fetchedAtMs: NOW - ago,
          source: 'live',
          limits: [limit],
        }),
      });
    }
    store.close();
  }

  it('predicts resets without reading the whole history when no burn rate is wanted', async () => {
    const DAY = 86_400_000;
    seedWeekly([
      // An old anchor, then a newer one, then readings that stopped reporting it.
      ['a', 9 * DAY, -8 * DAY],
      ['a', 3_600_000, 2 * DAY],
      ['a', 60_000, undefined],
      // Only an anchor that has passed: advanced by whole weeks.
      ['b', 9 * DAY, -8.5 * DAY],
      // Never reported one.
      ['c', 60_000, undefined],
    ]);
    const readHistory = vi.fn(readFleetHistory);
    const reader = new UsageReader(engine, { dbPath, readHistory, burn: false });
    const store = new Store(dbPath);
    try {
      const expected = readFleetHistory(
        store,
        ['a', 'b', 'c'].map((accountId) => ({ accountId })),
        NOW,
      );
      for (const at of [NOW + 2_000, NOW + 61_000]) {
        expect((await reader.read(at)).burnUnitsPerDay).toBeUndefined();
      }
      const usage = await reader.read(NOW);
      expect(usage.burnUnitsPerDay).toBeUndefined();
      expect(usage.predictedResetFor('a')).toBe(NOW + 2 * DAY);
      expect(usage.predictedResetFor('b')).toBeGreaterThan(NOW);
      expect(usage.predictedResetFor('c')).toBeUndefined();
      for (const id of ['a', 'b', 'c']) {
        expect(usage.predictedResetFor(id)).toBe(expected.predictedResetByAccount.get(id));
      }
      // Not one measurement of the whole history: each read asks for one row per account.
      expect(readHistory).not.toHaveBeenCalled();
    } finally {
      store.close();
      reader.close();
    }
  });

  it('still measures the burn rate for a reader that wants it', async () => {
    const readHistory = vi.fn(readFleetHistory);
    const reader = new UsageReader(engine, { dbPath, readHistory });
    try {
      await reader.read(NOW);
      expect(readHistory).toHaveBeenCalledTimes(1);
    } finally {
      reader.close();
    }
  });
});
