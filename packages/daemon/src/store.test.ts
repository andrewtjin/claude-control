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
      });

      const row = store.getPendingPermission('req-1');
      expect(row?.resolvedDecision).toBeNull();

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
      });
      store.insertPendingPermission({
        requestId: 'r2',
        sessionId: 's',
        tool: 't',
        summary: 'x',
        createdAtMs: 100,
      });
      expect(store.listPendingPermissions().map((r) => r.requestId)).toEqual(['r2', 'r1']);
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
