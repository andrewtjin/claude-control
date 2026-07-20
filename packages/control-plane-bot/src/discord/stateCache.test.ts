import { describe, it, expect } from 'vitest';
import type { Envelope } from '@claude-control/shared-protocol';
import { DaemonStateCache } from './stateCache.js';

function usageSnapshot(discordUserId: string, plan?: object): Envelope {
  return {
    v: 1,
    id: 'id-1',
    ts: 0,
    daemonId: 'daemon-1',
    discordUserId,
    type: 'usage.snapshot',
    payload: {
      accounts: [
        {
          accountId: 'a1',
          label: 'Work',
          active: true,
          source: 'live',
          fetchedAtMs: 0,
          limits: [],
        },
      ],
      ...(plan ? { plan } : {}),
    },
  } as Envelope;
}

describe('DaemonStateCache', () => {
  it('has nothing cached for a user before any envelope arrives', () => {
    const cache = new DaemonStateCache();
    expect(cache.getUsage('user-a')).toBeUndefined();
    expect(cache.getSessions('user-a')).toEqual([]);
  });

  it('records usage.snapshot and makes it readable by discordUserId', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', usageSnapshot('user-a'));
    const usage = cache.getUsage('user-a');
    expect(usage?.accounts).toHaveLength(1);
    expect(usage?.plan).toBeUndefined();
  });

  it('only sets plan when the snapshot actually included one', () => {
    const cache = new DaemonStateCache();
    const plan = { recommendedAccountId: 'a1', reason: 'ok', ranking: [], advisories: [] };
    cache.record('user-a', usageSnapshot('user-a', plan));
    expect(cache.getUsage('user-a')?.plan).toEqual(plan);
  });

  it('a later snapshot overwrites the earlier one', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', usageSnapshot('user-a'));
    const second: Envelope = {
      v: 1,
      id: 'id-2',
      ts: 1,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
      type: 'usage.snapshot',
      payload: { accounts: [] },
    };
    cache.record('user-a', second);
    expect(cache.getUsage('user-a')?.accounts).toHaveLength(0);
  });

  it('keeps per-user state isolated', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', usageSnapshot('user-a'));
    expect(cache.getUsage('user-b')).toBeUndefined();
  });

  it('records session.status by sessionId, latest write wins', () => {
    const cache = new DaemonStateCache();
    const base: Omit<Envelope, 'payload' | 'type'> = {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
    };
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's1', state: 'starting' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's1', state: 'running' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's2', state: 'done' },
    });

    const sessions = cache.getSessions('user-a');
    expect(sessions).toHaveLength(2);
    expect(sessions.find((s) => s.sessionId === 's1')?.state).toBe('running');
    expect(sessions.find((s) => s.sessionId === 's2')?.state).toBe('done');
  });

  it('session.prune.result removes exactly the pruned ids, leaving the rest', () => {
    const cache = new DaemonStateCache();
    const base: Omit<Envelope, 'payload' | 'type'> = {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
    };
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's1', state: 'orphaned' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's2', state: 'running' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.prune.result',
      // 's-unknown' was never cached — removal of an unknown id must be a silent no-op
      // (the daemon can legitimately prune records this cache never saw).
      payload: { requestId: 'r1', ok: true, prunedSessionIds: ['s1', 's-unknown'] },
    });

    const sessions = cache.getSessions('user-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('s2');
  });

  it('a prune result carrying the remaining view also drops cached ghosts the daemon never named', () => {
    const cache = new DaemonStateCache();
    const base: Omit<Envelope, 'payload' | 'type'> = {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
    };
    // 's-ghost' is a session the daemon holds NO record of (lost, not pruned): it can never
    // appear in prunedSessionIds, so the remaining view is the only thing that can clear it.
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's-ghost', state: 'waiting_permission' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's-live', state: 'running' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.prune.result',
      payload: {
        requestId: 'r1',
        ok: true,
        prunedSessionIds: ['s-old'],
        remainingSessionIds: ['s-live'],
      },
    });

    const sessions = cache.getSessions('user-a');
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe('s-live');
  });

  it('a FAILED prune result never reconciles against its remaining view', () => {
    const cache = new DaemonStateCache();
    const base: Omit<Envelope, 'payload' | 'type'> = {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
    };
    cache.record('user-a', {
      ...base,
      type: 'session.status',
      payload: { sessionId: 's1', state: 'running' },
    });
    cache.record('user-a', {
      ...base,
      type: 'session.prune.result',
      payload: { requestId: 'r1', ok: false, prunedSessionIds: [], remainingSessionIds: [] },
    });

    expect(cache.getSessions('user-a')).toHaveLength(1);
  });

  it('records settings.snapshot per user, latest write wins', () => {
    const cache = new DaemonStateCache();
    const base: Omit<Envelope, 'payload' | 'type'> = {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
    };
    expect(cache.getSettings('user-a')).toBeUndefined();
    cache.record('user-a', {
      ...base,
      type: 'settings.snapshot',
      payload: {
        startedAtMs: 100,
        settings: [{ name: 'auto-switch', value: 'off', source: 'default' }],
      },
    });
    // A daemon restart with different flags pushes a new report — it must replace the old.
    cache.record('user-a', {
      ...base,
      type: 'settings.snapshot',
      payload: {
        startedAtMs: 200,
        settings: [{ name: 'auto-switch', value: 'on', source: 'flag' }],
      },
    });
    expect(cache.getSettings('user-a')?.startedAtMs).toBe(200);
    expect(cache.getSettings('user-a')?.settings[0]?.value).toBe('on');
    expect(cache.getSettings('user-b')).toBeUndefined();
  });

  it('ignores envelope types it does not track (e.g. hook.notification)', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', {
      v: 1,
      id: 'id-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'user-a',
      type: 'hook.notification',
      payload: { event: 'notification', title: 't', body: 'b', level: 'info' },
    });
    expect(cache.getUsage('user-a')).toBeUndefined();
    expect(cache.getSessions('user-a')).toEqual([]);
  });
});
