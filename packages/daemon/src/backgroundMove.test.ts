// The one move both the daemon and `cctl claude` make, on its own: between any two config dirs (not
// only off the global slot), what a stop that was taken but not seen through leaves behind, and the
// judgment of which folder slots a session moves onto. The daemon's per-cycle policy around it is
// covered in backgroundMover.test.ts; the real commands in cli/backgroundHost.test.ts.

import { describe, expect, it } from 'vitest';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import {
  isMoveTarget,
  moveBackgroundSession,
  type BackgroundSession,
  type BackgroundSessionHost,
  type MoveTiming,
  type SavedLaunch,
  type SessionActivity,
  type SessionLock,
} from './backgroundMove.js';

const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SHORT = SID.slice(0, 8);
const OLD = 'C:/vault/profiles/rule-old';
const NEW = 'C:/vault/profiles/rule-new';
const S: BackgroundSession = { short: SHORT, sessionId: SID, cwd: 'C:/research' };

/** A two-profile Claude Code: who hosts the session, each config dir's row, and every command. */
function fakeHost(over: Partial<BackgroundSessionHost> = {}): {
  host: BackgroundSessionHost;
  calls: string[];
  hosted: Map<string | null, BackgroundSession[]>;
} {
  const calls: string[] = [];
  const hosted = new Map<string | null, BackgroundSession[]>([[OLD, [S]]]);
  const saved = new Map<string | null, SavedLaunch>([
    [OLD, { kind: 'replayable', options: ['--model=opus'] }],
  ]);
  const host: BackgroundSessionHost = {
    listHosted: (c) => Promise.resolve([...(hosted.get(c) ?? [])]),
    activity: () =>
      Promise.resolve(new Map<string, SessionActivity>([[SHORT, { idle: true, name: 'pods' }]])),
    attachedNow: () => Promise.resolve(false),
    stop: (c, short) => {
      calls.push(`stop ${String(c)} ${short}`);
      hosted.set(c, []);
      return Promise.resolve();
    },
    savedOptions: (c) => Promise.resolve(saved.get(c) ?? { kind: 'none' }),
    resumeIdle: (input) => {
      calls.push(
        `resume ${String(input.configDir)}` +
          (input.options === undefined ? '' : ` [${input.options.join(' ')}]`),
      );
      hosted.set(input.configDir, [S]);
      return Promise.resolve();
    },
    lockSession: (): Promise<SessionLock> => Promise.resolve({ release: () => {} }),
    ...over,
  };
  return { host, calls, hosted };
}

const timing: MoveTiming = {
  clock: () => 0,
  confirmTimeoutMs: 0,
  sleep: () => Promise.resolve(),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

const REQUEST = {
  session: S,
  from: { configDir: OLD, name: "C:/old's slot" },
  to: { configDir: NEW, name: "C:/research's slot" },
};

describe('moveBackgroundSession', () => {
  it('moves between two folder profiles, replaying the source row and naming both in words', async () => {
    const { host, calls, hosted } = fakeHost();
    expect(await moveBackgroundSession(host, REQUEST, timing)).toEqual({
      result: 'moved',
      name: 'pods',
      replayed: 1,
    });
    expect(calls).toEqual([`stop ${OLD} ${SHORT}`, `resume ${NEW} [--model=opus]`]);
    expect(hosted.get(NEW)).toEqual([S]);
  });

  it('runs onCommit once, right before the stop, and not at all when nothing is touched', async () => {
    const order: string[] = [];
    const { host } = fakeHost({
      stop: () => {
        order.push('stop');
        return Promise.resolve();
      },
    });
    await moveBackgroundSession(host, REQUEST, timing, () => order.push('commit'));
    expect(order).toEqual(['commit', 'stop']);

    const busy = fakeHost({
      activity: () => Promise.resolve(new Map([[SHORT, { idle: false }]])),
    });
    let committed = false;
    const r = await moveBackgroundSession(busy.host, REQUEST, timing, () => (committed = true));
    expect(r).toMatchObject({ result: 'not-moved', cause: 'busy', final: false });
    expect(committed).toBe(false);
  });

  it('a session no longer where the caller found it is left alone, in words that name the place', async () => {
    const { host, calls, hosted } = fakeHost();
    hosted.set(OLD, []);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toEqual({
      result: 'not-moved',
      cause: 'gone',
      final: false,
      reason: "it is no longer on C:/old's slot",
    });
    expect(calls).toEqual([]);
  });

  it('a roster that cannot be read counts as gone: nothing is stopped on a guess', async () => {
    const { host, calls } = fakeHost({ listHosted: () => Promise.reject(new Error('torn')) });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'gone',
    });
    expect(calls).toEqual([]);
  });

  it('a stop taken but not seen through puts the session back where it was', async () => {
    // Claude Code took the stop, but the session had not exited when the host stopped waiting; it
    // is gone from the roster by the time the move looks again, so it may be stopped: resumed back.
    const { host, calls, hosted } = fakeHost();
    host.stop = (c) => {
      calls.push(`stop ${String(c)}`);
      hosted.set(c, []);
      return Promise.reject(new Error('it was still running 10s after claude stop'));
    };
    const r = await moveBackgroundSession(host, REQUEST, timing);
    expect(r).toEqual({
      result: 'failed',
      restored: true,
      reason: 'could not stop it: it was still running 10s after claude stop',
      name: 'pods',
    });
    expect(calls).toEqual([`stop ${OLD}`, `resume ${OLD}`]);
  });

  it('a stop refused outright leaves it running where it was, with no resume anywhere', async () => {
    const { host, calls } = fakeHost();
    host.stop = () => Promise.reject(new Error('claude stop exited 1: no such session'));
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
    });
    expect(calls.some((c) => c.startsWith('resume'))).toBe(false);
  });

  it('a resume the target refuses is put back on the source, not on the global slot', async () => {
    const { host, calls } = fakeHost();
    const resume = host.resumeIdle.bind(host);
    host.resumeIdle = (input) =>
      input.configDir === NEW ? Promise.reject(new Error('untrusted')) : resume(input);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
      reason: 'untrusted',
    });
    expect(calls).toEqual([`stop ${OLD} ${SHORT}`, `resume ${OLD}`]);
  });
});

describe('isMoveTarget', () => {
  const NOW = 1_000_000;
  const usage = (percent: number): AccountUsageInput => ({
    accountId: 'inc',
    label: 'Inc',
    active: true,
    quarantined: false,
    limits: [{ kind: 'weekly_all', percent, resetsAt: NOW + 3_600_000 }],
  });

  it('a slot holding one of its included accounts with usage left is a target', () => {
    expect(isMoveTarget(['inc'], 'inc', usage(10), NOW)).toBe(true);
  });

  it('an account never polled counts as able: no usage known is not out', () => {
    expect(isMoveTarget(['inc'], 'inc', { ...usage(0), limits: [] }, NOW)).toBe(true);
  });

  it('is not one in fallback, when out of usage, with nothing live, or for an exclude-only rule', () => {
    expect(isMoveTarget(['inc'], 'shared', usage(10), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], 'inc', usage(100), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], null, usage(10), NOW)).toBe(false);
    expect(isMoveTarget([], 'inc', usage(10), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], 'inc', { ...usage(10), quarantined: true }, NOW)).toBe(false);
    // The daemon passes no usage for an account this cycle did not poll.
    expect(isMoveTarget(['inc'], 'inc', undefined, NOW)).toBe(false);
  });
});
