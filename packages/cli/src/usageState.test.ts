// The usage reader: a snapshot row of the wrong shape is skipped like an unparsable one, and a
// long-lived reader (the full-screen view) does not redo the history measurement on every read.

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

  it('measures history once a minute, not on every read', async () => {
    const readHistory = vi.fn(readFleetHistory);
    const reader = new UsageReader(engine, { dbPath, readHistory });
    try {
      await reader.read(NOW);
      await reader.read(NOW + 2_000);
      await reader.read(NOW + 30_000);
      expect(readHistory).toHaveBeenCalledTimes(1);
      await reader.read(NOW + 61_000);
      expect(readHistory).toHaveBeenCalledTimes(2);
    } finally {
      reader.close();
    }
  });
});
