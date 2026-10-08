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

  it('carries each activation entry origin into its interval, and null for one that never had one', async () => {
    await writeAuditLog(vaultDir, [
      { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' }, // pre-origin line
      { ts: 2000, event: 'activated', fromAccountId: 'a', toAccountId: 'b', origin: 'auto' },
      { ts: 3000, event: 'activated', fromAccountId: 'b', toAccountId: 'a', origin: 'phone' },
    ]);
    const journal = new AttributionJournal({ store, vaultDir });
    await journal.sync();

    const intervals = store.listActivationIntervals();
    expect(intervals.map((i) => i.origin)).toEqual([null, 'auto', 'phone']);
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

  describe('per-slot timelines', () => {
    it('derives one independent timeline per slot: a group hop never closes the global interval', async () => {
      // Interleaved global and group activations. Each slot's live account switches on its own; a
      // group activation must NOT truncate the global account's interval (they are different logins).
      await writeAuditLog(vaultDir, [
        { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'g1', slot: 'global' },
        { ts: 1500, event: 'activated', fromAccountId: null, toAccountId: 'm1', slot: 'group:x' },
        { ts: 2500, event: 'activated', fromAccountId: 'm1', toAccountId: 'm2', slot: 'group:x' },
        { ts: 3000, event: 'activated', fromAccountId: 'g1', toAccountId: 'g2', slot: 'global' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();

      const global = store
        .listActivationIntervals()
        .filter((i) => (i.slot ?? 'global') === 'global');
      const group = store.listActivationIntervals().filter((i) => i.slot === 'group:x');
      // Global timeline: g1 held from 1000 until the global hop at 3000 (the group hops in between
      // did not touch it), then g2 open-ended.
      expect(global).toHaveLength(2);
      expect(global[0]).toMatchObject({ accountId: 'g1', startedAtMs: 1000, endedAtMs: 3000 });
      expect(global[1]).toMatchObject({ accountId: 'g2', startedAtMs: 3000, endedAtMs: null });
      // Group timeline: m1 from 1500 to 2500, then m2 open-ended.
      expect(group).toHaveLength(2);
      expect(group[0]).toMatchObject({ accountId: 'm1', startedAtMs: 1500, endedAtMs: 2500 });
      expect(group[1]).toMatchObject({ accountId: 'm2', startedAtMs: 2500, endedAtMs: null });
    });

    it('stamps the slot on every derived interval, defaulting a pre-slot line to global', async () => {
      await writeAuditLog(vaultDir, [
        { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'a' }, // pre-slot line
        { ts: 2000, event: 'activated', fromAccountId: null, toAccountId: 'm', slot: 'group:x' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();
      const bySlot = new Map(store.listActivationIntervals().map((i) => [i.accountId, i.slot]));
      // A pre-slot line is derived as the global slot and written explicitly as 'global' (the journal
      // always stamps a slot on the rows it writes); a group line keeps its own slot.
      expect(bySlot.get('a')).toBe('global');
      expect(bySlot.get('m')).toBe('group:x');
    });

    it('accountActiveAt is global-only: a group activation is invisible to it', async () => {
      await writeAuditLog(vaultDir, [
        { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'g', slot: 'global' },
        { ts: 1500, event: 'activated', fromAccountId: null, toAccountId: 'm', slot: 'group:x' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();
      // At any instant after 1500 the global account is still 'g' — the group's live member never
      // shadows the global timeline.
      expect(journal.accountActiveAt(2000)).toBe('g');
    });

    it('a second sync is idempotent across mixed-slot activations', async () => {
      await writeAuditLog(vaultDir, [
        { ts: 1000, event: 'activated', fromAccountId: null, toAccountId: 'g', slot: 'global' },
        { ts: 1500, event: 'activated', fromAccountId: null, toAccountId: 'm', slot: 'group:x' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      await journal.sync();
      const first = store.listActivationIntervals();
      await journal.sync();
      expect(store.listActivationIntervals()).toEqual(first);
    });
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

  describe('switchesBetween', () => {
    it('returns the live-account switches inside the window, oldest first, with who and why', async () => {
      await writeAuditLog(vaultDir, [
        {
          ts: 3000,
          event: 'activated',
          fromAccountId: 'a',
          toAccountId: 'b',
          origin: 'auto',
          detail: 'a at 95%',
        },
        { ts: 500, event: 'activated', fromAccountId: null, toAccountId: 'a', origin: 'manual' },
        { ts: 1000, event: 'activated', fromAccountId: 'x', toAccountId: 'a' },
        { ts: 2000, event: 'refreshed', fromAccountId: null, toAccountId: 'a' },
        { ts: 2500, event: 'activated', fromAccountId: 'a', toAccountId: null },
        { ts: 4001, event: 'activated', fromAccountId: 'b', toAccountId: 'a' },
      ]);
      const journal = new AttributionJournal({ store, vaultDir });
      // Both ends inclusive; a refresh, a target-less entry and anything outside are not switches.
      expect(await journal.switchesBetween(1000, 4000)).toEqual([
        { at: 1000, fromAccountId: 'x', toAccountId: 'a' },
        { at: 3000, fromAccountId: 'a', toAccountId: 'b', origin: 'auto', reason: 'a at 95%' },
      ]);
    });

    it('is empty when nothing was ever switched', async () => {
      const journal = new AttributionJournal({ store, vaultDir });
      expect(await journal.switchesBetween(0, Date.now())).toEqual([]);
    });
  });
});
