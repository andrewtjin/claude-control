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

  it('carries the daemon-measured burn rate, and leaves it absent when none was sent', () => {
    const cache = new DaemonStateCache();
    // A daemon predating the field sends no burn rate, and "absent" has to reach the renderer
    // distinguishable from a measured zero — which is a real verdict, not a missing one.
    cache.record('user-a', usageSnapshot('user-a'));
    expect(cache.getUsage('user-a')?.burnUnitsPerDay).toBeUndefined();

    const withBurn = usageSnapshot('user-b');
    (withBurn.payload as { burnUnitsPerDay?: number }).burnUnitsPerDay = 0;
    cache.record('user-b', withBurn);
    expect(cache.getUsage('user-b')?.burnUnitsPerDay).toBe(0);
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

describe('DaemonStateCache stats.snapshot', () => {
  function statsSnapshot(discordUserId: string, turns: number): Envelope {
    return {
      v: 1,
      id: 'stats-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId,
      type: 'stats.snapshot',
      payload: {
        windowStartMs: 0,
        windowEndMs: 1000,
        overall: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns },
        byAccount: [],
        byModel: [],
        byDay: [],
        coverage: {
          filesScanned: 1,
          filesSkippedByMtime: 0,
          filesUnreadable: 0,
          dirsUnreadable: 0,
          malformedLines: 0,
          duplicateTurns: 0,
        },
      },
    };
  }

  it('has nothing cached before a snapshot arrives', () => {
    expect(new DaemonStateCache().getStats('user-a')).toBeUndefined();
  });

  it('records a snapshot per user and lets a later one overwrite it', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', statsSnapshot('user-a', 10));
    expect(cache.getStats('user-a')?.overall.turns).toBe(10);
    cache.record('user-a', statsSnapshot('user-a', 25));
    expect(cache.getStats('user-a')?.overall.turns).toBe(25);
    // Strictly per-user: one daemon's stats must never answer another user's /stats.
    expect(cache.getStats('user-b')).toBeUndefined();
  });

  it('leaves the usage cache untouched', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', usageSnapshot('user-a'));
    cache.record('user-a', statsSnapshot('user-a', 5));
    expect(cache.getUsage('user-a')?.accounts).toHaveLength(1);
  });

  /** The answer to one `/stats days:N` interaction. Deliberately NOT a tracked envelope type —
   *  see the tests below for why. */
  function statsResult(discordUserId: string, turns: number): Envelope {
    const snapshot = statsSnapshot(discordUserId, turns);
    if (snapshot.type !== 'stats.snapshot') throw new Error('unreachable');
    return {
      ...snapshot,
      id: 'stats-result-1',
      type: 'stats.result',
      payload: { requestId: 'req-1', ok: true, snapshot: snapshot.payload },
    };
  }

  it('never lets a requested window overwrite the cached default one', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', statsSnapshot('user-a', 10));
    // `/stats days:90` answers ONE interaction, over a window that user chose for that question.
    // Caching it would silently redefine what a later bare `/stats` means — the next reader would
    // get a 90-day total under a card presented as the daemon's regular snapshot.
    cache.record('user-a', statsResult('user-a', 999));
    expect(cache.getStats('user-a')?.overall.turns).toBe(10);
  });

  it('caches nothing at all for a user whose only stats traffic was a requested window', () => {
    const cache = new DaemonStateCache();
    cache.record('user-a', statsResult('user-a', 999));
    expect(cache.getStats('user-a')).toBeUndefined();
  });
});
