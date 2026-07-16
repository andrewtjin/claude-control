import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store.js';
import { AttributionJournal } from './attributionJournal.js';

async function writeAuditLog(vaultDir: string, lines: unknown[]): Promise<void> {
  await writeFile(
    join(vaultDir, 'switch-audit.jsonl'),
    lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
  );
}

describe('AttributionJournal', () => {
  let store: Store;
  let vaultDir: string;

  beforeEach(async () => {
    store = new Store(':memory:');
    vaultDir = await mkdtemp(join(tmpdir(), 'attribution-journal-'));
  });

  afterEach(async () => {
    store.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('builds intervals from a synthetic audit log: each activation closes the prior interval', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
      { ts: 2000, event: 'activated', fromAccountId: 'a', toAccountId: 'b' },
      { ts: 3000, event: 'activated', fromAccountId: 'b', toAccountId: 'a' },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();

    const intervals = store.listActivationIntervals();
    expect(intervals).toHaveLength(3);
    expect(intervals[0]).toMatchObject({ accountId: 'a', startedAtMs: 1000, endedAtMs: 2000 });
    expect(intervals[1]).toMatchObject({ accountId: 'b', startedAtMs: 2000, endedAtMs: 3000 });
    expect(intervals[2]).toMatchObject({ accountId: 'a', startedAtMs: 3000, endedAtMs: null });
  });

  it('missing audit log yields no intervals, without throwing', async () => {
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    expect(store.listActivationIntervals()).toHaveLength(0);
  });

  it('skips torn/malformed lines instead of failing the whole sync', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
    ]);
    // Append a torn/partial line (simulating a crash mid-append) after the good one.
    await appendFile(join(vaultDir, 'switch-audit.jsonl'), '{"ts": 2000, "event": "activ');

    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    const intervals = store.listActivationIntervals();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]?.accountId).toBe('a');
  });

  it('ignores non-activation events (quarantined, recovered, refresh_adopted)', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
      { ts: 1500, event: 'refresh_adopted', fromAccountId: 'a', toAccountId: 'a', detail: 'x' },
      { ts: 1800, event: 'quarantined', fromAccountId: null, toAccountId: 'z' },
      { ts: 2000, event: 'recovered', fromAccountId: 'a', toAccountId: null },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    const intervals = store.listActivationIntervals();
    expect(intervals).toHaveLength(1);
    expect(intervals[0]).toMatchObject({ accountId: 'a', endedAtMs: null });
  });

  it('a second sync() is idempotent when nothing new was appended', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    await journal.sync();
    expect(store.listActivationIntervals()).toHaveLength(1);
  });

  it('a second sync() picks up newly appended activations, closing the prior open interval', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    const firstPass = store.listActivationIntervals();
    expect(firstPass).toHaveLength(1);
    expect(firstPass[0]?.endedAtMs).toBeNull();

    await appendFile(
      join(vaultDir, 'switch-audit.jsonl'),
      JSON.stringify({ ts: 5000, event: 'activated', fromAccountId: 'a', toAccountId: 'b' }) + '\n',
    );
    await journal.sync();
    const secondPass = store.listActivationIntervals();
    expect(secondPass).toHaveLength(2);
    // The set is fully re-derived each sync (so an out-of-order timestamp can't corrupt it);
    // the first interval is now closed at the new activation, the second is open.
    expect(secondPass[0]).toMatchObject({ accountId: 'a', startedAtMs: 1000, endedAtMs: 5000 });
    expect(secondPass[1]).toMatchObject({ accountId: 'b', startedAtMs: 5000, endedAtMs: null });
  });

  it('a later sync with an out-of-order (earlier) audit timestamp rebuilds correct, non-overlapping intervals', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
      { ts: 3000, event: 'activated', fromAccountId: 'a', toAccountId: 'c' },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();
    expect(store.listActivationIntervals()).toHaveLength(2);

    // A new activation arrives stamped EARLIER than the already-synced last one (clock skew /
    // NTP step-back). A tail-append cursor would slot it past the end and corrupt intervals;
    // a full re-derive must instead sort it into the middle.
    await appendFile(
      join(vaultDir, 'switch-audit.jsonl'),
      JSON.stringify({ ts: 2000, event: 'activated', fromAccountId: 'a', toAccountId: 'b' }) + '\n',
    );
    await journal.sync();

    const intervals = store.listActivationIntervals();
    expect(intervals).toHaveLength(3);
    // Contiguous + non-overlapping: each interval ends exactly where the next begins.
    expect(intervals[0]).toMatchObject({ accountId: 'a', startedAtMs: 1000, endedAtMs: 2000 });
    expect(intervals[1]).toMatchObject({ accountId: 'b', startedAtMs: 2000, endedAtMs: 3000 });
    expect(intervals[2]).toMatchObject({ accountId: 'c', startedAtMs: 3000, endedAtMs: null });
    // The point-in-time lookup reflects the corrected intervals.
    expect(journal.accountActiveAt(1500)).toBe('a');
    expect(journal.accountActiveAt(2500)).toBe('b');
    expect(journal.accountActiveAt(3500)).toBe('c');
  });

  describe('accountActiveAt', () => {
    it('finds the account active at a point in time, including the open-ended final interval', async () => {
      await writeAuditLog(vaultDir, [
        { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' },
        { ts: 2000, event: 'activated', fromAccountId: 'a', toAccountId: 'b' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();

      expect(journal.accountActiveAt(1500)).toBe('a');
      expect(journal.accountActiveAt(2500)).toBe('b');
      expect(journal.accountActiveAt(999)).toBeNull();
    });

    it('returns null when nothing has ever been activated', async () => {
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();
      expect(journal.accountActiveAt(Date.now())).toBeNull();
    });
  });
});
