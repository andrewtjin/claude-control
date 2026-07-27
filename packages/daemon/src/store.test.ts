import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Store } from './store.js';

describe('Store', () => {
  let store: Store;

  beforeEach(() => {
    store = new Store(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('usage_snapshots', () => {
    it('inserts and lists newest-first, scoped to an account', () => {
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 100, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 200, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'b', fetchedAtMs: 150, source: 'cached', json: '{}' });

      const forA = store.listUsageSnapshots('a');
      expect(forA.map((r) => r.fetchedAtMs)).toEqual([200, 100]);

      const all = store.listUsageSnapshots();
      expect(all).toHaveLength(3);
    });

    it('returns the latest snapshot for an account', () => {
      store.insertUsageSnapshot({
        accountId: 'a',
        fetchedAtMs: 100,
        source: 'live',
        json: '{"x":1}',
      });
      store.insertUsageSnapshot({
        accountId: 'a',
        fetchedAtMs: 300,
        source: 'live',
        json: '{"x":2}',
      });
      const latest = store.latestUsageSnapshot('a');
      expect(latest?.fetchedAtMs).toBe(300);
      expect(latest?.json).toBe('{"x":2}');
    });

    it('returns undefined for an account with no snapshots', () => {
      expect(store.latestUsageSnapshot('missing')).toBeUndefined();
    });

    it('trims snapshots strictly older than the cutoff, across every account', () => {
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 100, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 500, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'b', fetchedAtMs: 100, source: 'live', json: '{}' });
      // Exactly at the cutoff survives — the predicate is `<`, so a boundary row is kept.
      store.insertUsageSnapshot({ accountId: 'b', fetchedAtMs: 400, source: 'live', json: '{}' });

      expect(store.trimUsageSnapshots(400)).toBe(2);
      expect(store.listUsageSnapshots().map((r) => [r.accountId, r.fetchedAtMs])).toEqual([
        ['a', 500],
        ['b', 400],
      ]);
    });

    it('reports zero and changes nothing when everything is inside the retention window', () => {
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 900, source: 'live', json: '{}' });
      expect(store.trimUsageSnapshots(500)).toBe(0);
      expect(store.listUsageSnapshots()).toHaveLength(1);
    });

    it('leaves the account-scoped reads working after a trim', () => {
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 100, source: 'live', json: '{}' });
      store.insertUsageSnapshot({
        accountId: 'a',
        fetchedAtMs: 900,
        source: 'live',
        json: '{"x":1}',
      });
      store.trimUsageSnapshots(500);
      expect(store.latestUsageSnapshot('a')?.json).toBe('{"x":1}');
    });

    it('lists a time window oldest-first, scoped to an account', () => {
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 100, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 300, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'a', fetchedAtMs: 200, source: 'live', json: '{}' });
      store.insertUsageSnapshot({ accountId: 'b', fetchedAtMs: 250, source: 'live', json: '{}' });

      // Inclusive lower bound; 'b' never leaks in; ascending order is what a series needs.
      expect(store.listUsageSnapshotsSince('a', 200).map((r) => r.fetchedAtMs)).toEqual([200, 300]);
      expect(store.listUsageSnapshotsSince('a', 999)).toEqual([]);
      expect(store.listUsageSnapshotsSince('missing', 0)).toEqual([]);
    });
  });

  describe('activation_intervals', () => {
    it('opens and closes an interval', () => {
      const id = store.openActivationInterval('acct-1', 1000);
      let open = store.getOpenActivationInterval();
      expect(open?.id).toBe(id);
      expect(open?.endedAtMs).toBeNull();

      store.closeActivationInterval(id, 2000);
      open = store.getOpenActivationInterval();
      expect(open).toBeUndefined();

      const all = store.listActivationIntervals('acct-1');
      expect(all).toEqual([{ id, accountId: 'acct-1', startedAtMs: 1000, endedAtMs: 2000 }]);
    });

    it('closeOpenActivationIntervals closes every open row', () => {
      const id1 = store.openActivationInterval('a', 100);
      store.closeOpenActivationIntervals(500);
      const rows = store.listActivationIntervals();
      expect(rows.find((r) => r.id === id1)?.endedAtMs).toBe(500);
    });

    it('findActivationIntervalAt finds the covering interval, including an open-ended one', () => {
      const closedId = store.openActivationInterval('a', 0);
      store.closeActivationInterval(closedId, 1000);
      store.openActivationInterval('b', 1000);

      expect(store.findActivationIntervalAt(500)?.accountId).toBe('a');
      expect(store.findActivationIntervalAt(1500)?.accountId).toBe('b');
      // Before any interval started.
      expect(store.findActivationIntervalAt(-1)).toBeUndefined();
    });
  });

  describe('pending_permissions', () => {
    it('inserts, reads, and resolves exactly once', () => {
      store.insertPendingPermission({
        requestId: 'req-1',
        sessionId: 'sess-1',
        tool: 'Bash',
        summary: 'run ls',
        createdAtMs: 10,
        origin: 'hook',
      });

      const row = store.getPendingPermission('req-1');
      expect(row?.resolvedDecision).toBeNull();
      expect(row?.origin).toBe('hook');

      const changed = store.resolvePendingPermission('req-1', 'allow');
      expect(changed).toBe(1);
      expect(store.getPendingPermission('req-1')?.resolvedDecision).toBe('allow');
    });

    it('rejects resolving an unknown requestId (0 rows changed)', () => {
      expect(store.resolvePendingPermission('nope', 'allow')).toBe(0);
    });

    it('rejects a double-resolve (second call is a no-op)', () => {
      store.insertPendingPermission({
        requestId: 'req-2',
        sessionId: 'sess-1',
        tool: 'Bash',
        summary: 'run ls',
        createdAtMs: 10,
        origin: 'hook',
      });
      expect(store.resolvePendingPermission('req-2', 'allow')).toBe(1);
      expect(store.resolvePendingPermission('req-2', 'deny')).toBe(0);
      // The first decision sticks.
      expect(store.getPendingPermission('req-2')?.resolvedDecision).toBe('allow');
    });

    it('lists pending permissions oldest first', () => {
      store.insertPendingPermission({
        requestId: 'r1',
        sessionId: 's',
        tool: 't',
        summary: 'x',
        createdAtMs: 200,
        origin: 'hook',
      });
      store.insertPendingPermission({
        requestId: 'r2',
        sessionId: 's',
        tool: 't',
        summary: 'x',
        createdAtMs: 100,
        origin: 'hook',
      });
      expect(store.listPendingPermissions().map((r) => r.requestId)).toEqual(['r2', 'r1']);
    });

    it('round-trips a managed origin', () => {
      store.insertPendingPermission({
        requestId: 'req-m',
        sessionId: 'sess-1',
        tool: 'Write',
        summary: 'write file',
        createdAtMs: 10,
        origin: 'managed',
      });
      expect(store.getPendingPermission('req-m')?.origin).toBe('managed');
    });
  });

  describe('sessions', () => {
    it('upserts by id (insert then update)', () => {
      store.upsertSession({
        id: 'sess-1',
        kind: 'managed',
        state: 'starting',
        accountId: 'a',
        json: '{}',
        updatedAtMs: 1,
      });
      store.upsertSession({
        id: 'sess-1',
        kind: 'managed',
        state: 'running',
        accountId: 'a',
        json: '{"turn":1}',
        updatedAtMs: 2,
      });

      const row = store.getSession('sess-1');
      expect(row?.state).toBe('running');
      expect(row?.json).toBe('{"turn":1}');
      expect(store.listSessions()).toHaveLength(1);
    });

    it('supports a null accountId', () => {
      store.upsertSession({
        id: 'sess-2',
        kind: 'observed',
        state: 'starting',
        accountId: null,
        json: '{}',
        updatedAtMs: 1,
      });
      expect(store.getSession('sess-2')?.accountId).toBeNull();
    });

    it('returns undefined for an unknown session id', () => {
      expect(store.getSession('missing')).toBeUndefined();
    });

    it('deleteSession removes the row and reports whether anything was there', () => {
      store.upsertSession({
        id: 'sess-3',
        kind: 'interactive',
        state: 'active',
        accountId: null,
        json: '{}',
        updatedAtMs: 1,
      });
      expect(store.deleteSession('sess-3')).toBe(true);
      expect(store.getSession('sess-3')).toBeUndefined();
      expect(store.deleteSession('sess-3')).toBe(false);
    });
  });

  describe('outbox', () => {
    it('enqueues and lists oldest-first', () => {
      store.enqueueOutbox('{"a":1}', 100);
      store.enqueueOutbox('{"a":2}', 200);
      const rows = store.listOutbox();
      expect(rows.map((r) => r.envelopeJson)).toEqual(['{"a":1}', '{"a":2}']);
    });

    it('deletes a specific row', () => {
      const id = store.enqueueOutbox('{"a":1}', 100);
      store.enqueueOutbox('{"a":2}', 200);
      store.deleteOutbox(id);
      expect(store.listOutbox().map((r) => r.envelopeJson)).toEqual(['{"a":2}']);
    });

    it('counts rows', () => {
      expect(store.countOutbox()).toBe(0);
      store.enqueueOutbox('{}', 1);
      store.enqueueOutbox('{}', 2);
      expect(store.countOutbox()).toBe(2);
    });

    it('trims to a bound by dropping the OLDEST rows first', () => {
      for (let i = 0; i < 5; i++) store.enqueueOutbox(`{"i":${i}}`, i);
      store.trimOutboxOldest(3);
      const remaining = store.listOutbox().map((r) => r.envelopeJson);
      expect(remaining).toEqual(['{"i":2}', '{"i":3}', '{"i":4}']);
    });

    it('trimming is a no-op when already within the bound', () => {
      store.enqueueOutbox('{}', 1);
      store.trimOutboxOldest(10);
      expect(store.countOutbox()).toBe(1);
    });
  });
});

// Retention has to stay cheap on the table it exists to bound, so this checks the PLAN, not just
// the result. It runs against a database the real `Store` migration built, so the index it asserts
// on is the shipped one. The SQL text is restated here on purpose: this is a guard on the
// schema/query PAIR, and it must be updated in step with `Store.trimUsageSnapshots`.
describe('usage snapshot retention query plan', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctl-store-plan-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('finds expired rows through the (accountId, fetchedAtMs) index, not a table scan', () => {
    const dbPath = join(dir, 'daemon.db');
    const store = new Store(dbPath);
    for (let i = 0; i < 500; i++) {
      store.insertUsageSnapshot({
        accountId: `acct-${i % 3}`,
        fetchedAtMs: i * 1000,
        source: 'live',
        json: '{}',
      });
    }
    store.close();

    const db = new DatabaseSync(dbPath);
    try {
      const plan = (sql: string): string =>
        db
          .prepare(`EXPLAIN QUERY PLAN ${sql}`)
          .all()
          .map((row) => String(row['detail']))
          .join(' | ');

      const shipped = plan(
        `DELETE FROM usage_snapshots WHERE id IN (
           SELECT id FROM usage_snapshots WHERE fetchedAtMs < 100000
         )`,
      );
      expect(shipped).toContain('idx_usage_snapshots_account');
      // COVERING means the candidate ids come out of the index alone; the table is touched only
      // for the rows actually being deleted.
      expect(shipped).toContain('COVERING INDEX');

      // WHY the sub-select shape exists at all: `fetchedAtMs` is the SECOND column of the only
      // index, so without ANALYZE statistics (the normal state of a daemon database) the obvious
      // form degrades to reading every row of the table.
      expect(plan(`DELETE FROM usage_snapshots WHERE fetchedAtMs < 100000`)).toBe(
        'SCAN usage_snapshots',
      );
    } finally {
      db.close();
    }
  });
});

describe('Store migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctl-store-migration-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('adds the origin column to a pre-origin database, defaulting legacy rows to hook', () => {
    const dbPath = join(dir, 'daemon.db');
    // Recreate the table shape a pre-`origin` deploy left behind, with one in-flight row —
    // `CREATE TABLE IF NOT EXISTS` alone would never add the column to this file.
    const legacy = new DatabaseSync(dbPath);
    legacy.exec(`
      CREATE TABLE pending_permissions (
        requestId TEXT PRIMARY KEY,
        sessionId TEXT NOT NULL,
        tool TEXT NOT NULL,
        summary TEXT NOT NULL,
        createdAtMs INTEGER NOT NULL,
        resolvedDecision TEXT
      );
    `);
    legacy
      .prepare(
        `INSERT INTO pending_permissions (requestId, sessionId, tool, summary, createdAtMs, resolvedDecision)
         VALUES ('legacy-1', 's', 'Bash', 'x', 10, NULL)`,
      )
      .run();
    legacy.close();

    const store = new Store(dbPath);
    try {
      // The legacy row survives the upgrade and reads as hook-originated — the resolve path
      // treated every pre-upgrade row that way, so the default preserves its behavior.
      expect(store.getPendingPermission('legacy-1')?.origin).toBe('hook');
      // And post-upgrade inserts carry an explicit origin end to end.
      store.insertPendingPermission({
        requestId: 'new-1',
        sessionId: 's',
        tool: 'Write',
        summary: 'y',
        createdAtMs: 20,
        origin: 'managed',
      });
      expect(store.getPendingPermission('new-1')?.origin).toBe('managed');
    } finally {
      store.close();
    }
  });

  it('is idempotent across reopenings of an already-migrated database', () => {
    const dbPath = join(dir, 'daemon.db');
    const first = new Store(dbPath);
    first.insertPendingPermission({
      requestId: 'r1',
      sessionId: 's',
      tool: 'Bash',
      summary: 'x',
      createdAtMs: 10,
      origin: 'managed',
    });
    first.close();

    // A second open must not attempt (and fail) a duplicate ALTER, and the data survives.
    const second = new Store(dbPath);
    try {
      expect(second.getPendingPermission('r1')?.origin).toBe('managed');
    } finally {
      second.close();
    }
  });
});
