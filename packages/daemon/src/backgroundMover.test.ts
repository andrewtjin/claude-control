// The background mover's decisions, against a fake Claude Code service: which sessions move (idle,
// on the global slot, with no work held between turns and no terminal open, in a folder with a
// target), how (stop, remove every job row the session has while it runs nowhere, resume its current
// conversation under the folder's profile with every saved option, confirm), how often (once per
// interval per session), what it refuses to move (options it cannot carry over, a worktree Claude
// Code made for it), and what a failure leaves behind (put back where it was with its options, tried
// a few times, never tried again, one notice). The real commands sit behind the host seam;
// cli/backgroundHost.test.ts covers them.

import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundMover,
  type BackgroundSession,
  type MoveTarget,
  type SessionActivity,
} from './backgroundMover.js';
import { FakeBackgroundHost, type FakeRow } from './fakeBackgroundHost.js';

const MAIN = null;
const PROFILE = 'C:/vault/profiles/rule-1';
const OTHER_PROFILE = 'C:/vault/profiles/rule-old';
const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SID2 = 'f38038c6-523b-4be5-9dff-160c472faeb0';
const SHORT = '1ee43a2b';
/** What every session here was started with, unless a test says otherwise. */
const SAVED = ['--permission-mode=auto'];

const session = (sessionId: string, cwd: string): BackgroundSession => ({
  short: sessionId.slice(0, 8),
  sessionId,
  cwd,
});

const TARGET: MoveTarget = {
  ruleId: 'rule-1',
  folder: 'C:/research',
  configDir: PROFILE,
  accountLabel: 'Alice',
};

interface Harness {
  host: FakeBackgroundHost;
  mover: BackgroundMover;
  notices: Array<{ title: string; body: string; level: string }>;
  /** Every warn line the mover logged. */
  warns: string[];
  /** Every pause the mover asked for. */
  sleeps: number[];
  now: { ms: number };
  /** Host a session on the global slot, its row there saved with {@link SAVED}. */
  onMain(s: BackgroundSession, activity: SessionActivity, row?: Partial<FakeRow>): void;
}

/** A mover whose rule resolution maps C:/research (and below) to rule-1, C:/other to rule-2, and
 *  everything else to no rule. Its clock is `now`, which only its pauses move forward. */
function harness(opts: { minIntervalMs?: number; confirmTimeoutMs?: number } = {}): Harness {
  const host = new FakeBackgroundHost([MAIN, PROFILE, OTHER_PROFILE]);
  const notices: Harness['notices'] = [];
  const warns: string[] = [];
  const sleeps: number[] = [];
  const now = { ms: 1_000_000 };
  const noop = (): void => {};
  const mover = new BackgroundMover({
    host,
    resolveRule: (cwd) =>
      Promise.resolve(
        cwd.startsWith('C:/research') ? 'rule-1' : cwd.startsWith('C:/other') ? 'rule-2' : null,
      ),
    notify: (n) => notices.push(n),
    logger: { debug: noop, info: noop, error: noop, warn: (_obj, msg) => warns.push(String(msg)) },
    clock: () => now.ms,
    ...(opts.minIntervalMs !== undefined ? { minIntervalMs: opts.minIntervalMs } : {}),
    confirmTimeoutMs: opts.confirmTimeoutMs ?? 0,
    sleep: (ms) => {
      sleeps.push(ms);
      now.ms += ms;
      return Promise.resolve();
    },
  });
  const onMain: Harness['onMain'] = (s, activity, row = {}) =>
    host.add(MAIN, s, activity, { saved: { kind: 'replayable', options: SAVED }, ...row });
  return { host, mover, notices, warns, sleeps, now, onMain };
}

const targets = (...t: MoveTarget[]): Map<string, MoveTarget> =>
  new Map(t.map((x) => [x.ruleId, x]));

/** The commands that change something: stops, row removals and resumes. */
const changes = (h: Harness): string[] => h.host.calls.filter((c) => /^(stop|rm|resume) /.test(c));

describe('BackgroundMover', () => {
  it('with no folder ready, asks Claude Code nothing at all', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    expect(await h.mover.run(new Map())).toEqual([]);
    expect(h.host.calls).toEqual([]);
  });

  it('moves an idle global-slot session in a ready folder: stop, remove its rows, resume under the profile, confirm', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research/sub'), { idle: true, name: 'pods' });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([{ sessionId: SID, ruleId: 'rule-1', result: 'moved' }]);
    expect(changes(h)).toEqual([
      `stop null ${SHORT}`,
      // While it runs nowhere, its row on the global slot goes: nothing is left there to wake it by.
      `rm null ${SHORT}`,
      // Same full id, same cwd, the source's saved options, under the rule's profile.
      `resume ${PROFILE} ${SID} C:/research/sub [--permission-mode=auto]`,
    ]);
    expect(h.host.hosted.get(PROFILE)?.map((s) => s.sessionId)).toEqual([SID]);
    expect(h.host.hosted.get(MAIN)).toEqual([]);
    expect(h.host.rowsFor(SID)).toEqual([PROFILE]);
    expect(h.notices).toEqual([
      {
        title: 'Background session moved',
        level: 'info',
        body:
          'cctl moved background session "pods" (1ee43a2b) in C:/research onto Alice, the ' +
          "folder's own account. Same session, same conversation; it is idle until its next prompt.",
      },
    ]);
  });

  it('removes the rows other config dirs kept of it too, a stale one under the profile included', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    // Left by an earlier move and a wake by hand: a stopped row under the profile, saved with no
    // options, and a failed one under a removed rule's profile.
    h.host.setRow(PROFILE, SHORT, {
      sessionId: SID,
      state: 'stopped',
      saved: { kind: 'replayable', options: [] },
    });
    h.host.setRow(OTHER_PROFILE, SHORT, {
      sessionId: SID,
      state: 'failed',
      saved: { kind: 'replayable', options: [] },
    });
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    expect(changes(h)).toEqual([
      `stop null ${SHORT}`,
      `rm null ${SHORT}`,
      `rm ${PROFILE} ${SHORT}`,
      `rm ${OTHER_PROFILE} ${SHORT}`,
      // The profile's stale row saved no options; the session keeps its own restrictions.
      `resume ${PROFILE} ${SID} C:/research [--permission-mode=auto]`,
    ]);
    expect(h.host.rowsFor(SID)).toEqual([PROFILE]);
  });

  it('never stops a session in a turn, or one waiting on a prompt', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: false });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([
      {
        sessionId: SID,
        ruleId: 'rule-1',
        result: 'skipped',
        reason: 'it is not idle between turns',
      },
    ]);
    expect(changes(h)).toEqual([]);
    // Not given up on: once it is idle, the next cycle moves it.
    h.host.states.set(SHORT, { idle: true });
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('never stops a session that holds work between turns (a scheduled wakeup), though it reports idle', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true }, { pending: true });
    expect(await h.mover.run(targets(TARGET))).toEqual([
      {
        sessionId: SID,
        ruleId: 'rule-1',
        result: 'skipped',
        reason: 'it holds work between turns (a scheduled wakeup or a background task)',
      },
    ]);
    expect(changes(h)).toEqual([]);
    expect(h.notices).toEqual([]);
    // Once the wakeup has fired and the session is idle with nothing held, it moves.
    h.host.rowOf(MAIN, SHORT)!.pending = false;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('a session in a worktree Claude Code made for it is never moved, and said so once', async () => {
    const h = harness();
    h.onMain(
      session(SID, 'C:/research'),
      { idle: true },
      { worktreePath: 'C:/research/.claude/worktrees/feat' },
    );
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(outcomes[0]?.reason).toContain('git worktree Claude Code made for it');
    expect(changes(h)).toEqual([]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.body).toContain('It is still on the shared account, as before.');
    h.host.calls.length = 0;
    h.now.ms += 10 * 60 * 60_000;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    expect(h.notices).toHaveLength(1);
  });

  it('a stale row elsewhere that records a worktree keeps the session where it runs too', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.setRow(OTHER_PROFILE, SHORT, {
      sessionId: SID,
      state: 'stopped',
      worktreePath: 'C:/research/.claude/worktrees/feat',
      saved: { kind: 'replayable', options: [] },
    });
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'failed' });
    expect(changes(h)).toEqual([]);
  });

  it('after /clear, resumes the conversation the session runs now, under a job named after it', async () => {
    const h = harness();
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
    h.onMain(session(SID, 'C:/research'), { idle: true }, { resumeSessionId: NEW });
    h.host.currentIds.set(SHORT, NEW);
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    expect(changes(h)).toEqual([
      `stop null ${SHORT}`,
      `rm null ${SHORT}`,
      `resume ${PROFILE} ${NEW} C:/research [--permission-mode=auto]`,
    ]);
    expect(h.host.hosted.get(PROFILE)).toEqual([
      { short: '7a7a7a7a', sessionId: NEW, cwd: 'C:/research' },
    ]);
    expect(h.notices[0]?.body).toContain('background session 7a7a7a7a in C:/research');
  });

  it('never touches a session outside every ruled folder, or in a folder that is not ready', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/elsewhere'), { idle: true });
    h.onMain(session(SID2, 'C:/other/app'), { idle: true });
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    // Nothing to move, so Claude Code is not even asked what the sessions are doing.
    expect(h.host.calls).toEqual(['list null']);
  });

  it('moves only the sessions of the ready folders when several are hosted', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.onMain(session(SID2, 'C:/elsewhere'), { idle: true });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes.map((o) => [o.sessionId, o.result])).toEqual([[SID, 'moved']]);
    expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID2]);
    expect(h.host.rowsFor(SID2)).toEqual([MAIN]);
  });

  it('moves a session at most once per interval, however often it lands back on the global slot', async () => {
    const h = harness({ minIntervalMs: 60_000 });
    h.onMain(session(SID, 'C:/research'), { idle: true });
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    // Woken back onto the global slot by hand, with a row there again.
    h.host.hosted.set(PROFILE, []);
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.now.ms += 59_000;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    h.now.ms += 2_000;
    h.host.calls.length = 0;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    // Both rows go, and it comes back on the profile with its own options.
    expect(changes(h)).toEqual([
      `stop null ${SHORT}`,
      `rm null ${SHORT}`,
      `rm ${PROFILE} ${SHORT}`,
      `resume ${PROFILE} ${SID} C:/research [--permission-mode=auto]`,
    ]);
  });

  it('a resume the target refuses puts the session back with its options, gives up on it, and says so once', async () => {
    const h = harness({ minIntervalMs: 1 });
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failResumeIn.add(PROFILE);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([
      { sessionId: SID, ruleId: 'rule-1', result: 'failed', restored: true, reason: 'untrusted' },
    ]);
    // Its row there is gone by then: put back by a resume with the options it was saved with.
    expect(changes(h).at(-1)).toBe(`resume null ${SID} C:/research [--permission-mode=auto]`);
    expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID]);
    expect(h.host.rowOf(MAIN, SHORT)?.saved).toEqual({ kind: 'replayable', options: SAVED });
    expect(h.host.rowsFor(SID)).toEqual([MAIN]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]).toMatchObject({ title: 'Background session not moved', level: 'warn' });
    expect(h.notices[0]?.body).toContain('It is still on the shared account, as before.');
    // Never again while this daemon runs, even past the interval.
    h.now.ms += 10 * 60 * 60_000;
    h.host.calls.length = 0;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    expect(h.host.calls).toEqual(['list null']);
    expect(h.notices).toHaveLength(1);
  });

  it('a resume that never shows up under the profile counts as a failure too, and its row there goes', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.silentResumeIn.add(PROFILE);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(outcomes[0]?.reason).toContain("did not appear under C:/research's slot");
    expect(h.host.rowsFor(SID)).toEqual([MAIN]);
  });

  it('when even the way back fails, the notice says how to resume it by hand, options included', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failResumeIn.add(PROFILE);
    h.host.failResumeIn.add(MAIN);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
    expect(h.notices[0]?.body).toContain(
      `resume it with: claude --bg --resume ${SID} --permission-mode=auto`,
    );
  });

  it('a stop Claude Code refuses leaves the session running where it was, and gives up', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failStop = true;
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(changes(h)).toEqual([`stop null ${SHORT}`]);
    expect(h.notices[0]?.body).toContain('could not stop it: stop refused');
  });

  it('a stop taken but not seen through puts the session back, and keeps its row', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.stopNotSeenThrough = true;
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    // Nothing was removed before the way back: it wakes with its own row.
    expect(changes(h)).toEqual([`stop null ${SHORT}`, `resume null ${SID} C:/research`]);
  });

  it('a row that cannot be removed puts the session back where it was', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failRemoveIn.add(MAIN);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(outcomes[0]?.reason).toContain('could not remove its job row: rm refused');
    expect(changes(h)).toEqual([
      `stop null ${SHORT}`,
      `rm null ${SHORT}`,
      `resume null ${SID} C:/research`,
    ]);
    expect(h.host.hosted.get(PROFILE) ?? []).toEqual([]);
  });

  it('a listing that fails moves nothing and is not an error', async () => {
    const h = harness();
    h.host.failListing = true;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('when where a session runs cannot be read under the lock, it is left alone and tried next cycle', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failRegistry = true;
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({
      result: 'skipped',
      reason: 'a registry entry is mid-write',
    });
    expect(changes(h)).toEqual([]);
    expect(h.notices).toEqual([]);
    h.host.failRegistry = false;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('when what a session is doing cannot be read, it is left alone and tried next cycle', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failActivity = true;
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
    expect(changes(h)).toEqual([]);
    // Said once, not every cycle: a daemon without claude on its PATH would otherwise be silent.
    await h.mover.run(targets(TARGET));
    expect(h.warns).toEqual(['could not tell whether a background session is idle; not moving it']);
    h.host.failActivity = false;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('a session found gone or unknown in between says nothing about the activity listing: warned once all the same', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.failActivity = true;
    await h.mover.run(targets(TARGET));
    // A cycle in which the session could not be located never asked Claude Code anything.
    h.host.failRegistry = true;
    await h.mover.run(targets(TARGET));
    h.host.failRegistry = false;
    await h.mover.run(targets(TARGET));
    expect(h.warns).toEqual(['could not tell whether a background session is idle; not moving it']);
  });

  it('a session gone from the activity listing is not stopped', async () => {
    const h = harness();
    h.onMain(session(SID, 'C:/research'), { idle: true });
    h.host.states.clear();
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
    expect(changes(h)).toEqual([]);
  });

  describe('the move lock it shares with cctl claude', () => {
    it("takes the session's lock without waiting, and lets go of it after the move", async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });

    it('leaves a session another cctl process holds the lock of alone, and looks again next cycle', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.lockedElsewhere.add(SID);
      expect(await h.mover.run(targets(TARGET))).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'skipped',
          reason: 'another cctl process is moving it',
        },
      ]);
      expect(h.host.calls).toEqual(['list null']);
      expect(h.notices).toEqual([]);
      h.host.lockedElsewhere.clear();
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    });

    it('a session moved off the global slot by another process meanwhile is not touched', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      // The listing saw it; by the time the lock is held, cctl claude has moved it.
      let reads = 0;
      h.host.beforeList = (configDir) => {
        if (configDir === MAIN && ++reads === 2) {
          h.host.hosted.set(MAIN, []);
          h.host.hosted.set(PROFILE, [session(SID, 'C:/research')]);
        }
      };
      expect(await h.mover.run(targets(TARGET))).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'skipped',
          reason: 'it is no longer on the global slot',
        },
      ]);
      expect(h.host.calls.some((c) => c.startsWith('activity'))).toBe(false);
      expect(changes(h)).toEqual([]);
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });

    it('lets go of the lock even when a move fails', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('failed');
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });
  });

  describe('what it carries over, or refuses to', () => {
    it('passes every saved option on a move, restrictions included', async () => {
      const h = harness();
      const saved = [
        '--effort=low',
        '--disallowedTools=Bash',
        '--disallowedTools=WebFetch',
        '--dangerously-skip-permissions',
      ];
      h.onMain(
        session(SID, 'C:/research'),
        { idle: true },
        {
          saved: { kind: 'replayable', options: saved },
        },
      );
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(h.host.calls).toContain(`resume ${PROFILE} ${SID} C:/research [${saved.join(' ')}]`);
    });

    it('a session saved with something a move cannot carry over is never stopped, and said so once', async () => {
      const h = harness();
      h.onMain(
        session(SID, 'C:/research'),
        { idle: true },
        {
          saved: {
            kind: 'unreplayable',
            reason: 'it was started with --file, which a move does not replay',
          },
        },
      );
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'failed',
          restored: true,
          reason: 'it was started with --file, which a move does not replay',
        },
      ]);
      expect(changes(h)).toEqual([]);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]?.body).toContain('It is still on the shared account, as before.');
      // Its saved options do not change, so it is not looked at again.
      h.host.calls.length = 0;
      expect(await h.mover.run(targets(TARGET))).toEqual([]);
      expect(h.notices).toHaveLength(1);
    });

    it('a row of it that cannot be read right now is skipped, not given up on', async () => {
      for (const where of [MAIN, PROFILE]) {
        const h = harness();
        h.onMain(session(SID, 'C:/research'), { idle: true });
        if (where === MAIN) {
          h.host.rowOf(MAIN, SHORT)!.unreadable = true;
        } else {
          h.host.setRow(PROFILE, SHORT, {
            sessionId: SID,
            state: 'stopped',
            unreadable: true,
            saved: { kind: 'replayable', options: [] },
          });
        }
        expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
        expect(changes(h)).toEqual([]);
        expect(h.notices).toEqual([]);
        // Readable next cycle (written in full by then): moved.
        if (where === MAIN) h.host.rowOf(MAIN, SHORT)!.unreadable = false;
        else h.host.rows.get(PROFILE)!.delete(SHORT);
        expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      }
    });

    it('a session with no row on the global slot is skipped: the way back would need its options', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.rows.get(MAIN)!.delete(SHORT);
      expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
      expect(changes(h)).toEqual([]);
    });
  });

  describe('a terminal with a session open', () => {
    it('holds every move back while one is open on its service, and moves once it has left', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.attachedIn.add(MAIN);
      expect(await h.mover.run(targets(TARGET))).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'skipped',
          reason: 'a terminal has a background session open',
        },
      ]);
      expect(changes(h)).toEqual([]);
      h.host.attachedIn.clear();
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    });

    it("a terminal on another config dir's service does not hold it back", async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.attachedIn.add(PROFILE);
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    });

    it('when it cannot be told whether one is open, the session is not stopped', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.failAttached = true;
      expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
      expect(changes(h)).toEqual([]);
    });
  });

  describe('confirming, and the way back', () => {
    it('waits for a resumed session that shows up only a few roster reads later', async () => {
      // Claude Code returns once the session is dispatched; its worker reaches the roster later.
      const h = harness({ confirmTimeoutMs: 15_000 });
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.showOnReadIn.set(PROFILE, 3);
      const before = h.host.calls.length;
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      const resumeAt = h.host.calls.findIndex((c, i) => i >= before && c.startsWith('resume'));
      expect(h.host.calls.slice(resumeAt + 1).filter((c) => c === `list ${PROFILE}`)).toHaveLength(
        3,
      );
      expect(h.sleeps.filter((ms) => ms === 500)).toEqual([500, 500]);
    });

    it('a resumed session that shows up only after the confirm window counts as moved', async () => {
      const h = harness({ confirmTimeoutMs: 0 });
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.showOnReadIn.set(PROFILE, 2);
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(changes(h).some((c) => c.startsWith('resume null'))).toBe(false);
    });

    it('a way back that is accepted but never shows up is not reported as restored', async () => {
      const h = harness({ confirmTimeoutMs: 2_000 });
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.silentResumeIn.add(PROFILE);
      h.host.silentResumeIn.add(MAIN);
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
      expect(h.notices[0]?.body).toContain(`resume it with: claude --bg --resume ${SID}`);
      expect(h.notices[0]?.body).not.toContain('as before');
      // Accepted once is enough: another try would only start a copy of a session coming up.
      expect(h.host.calls.filter((c) => c.startsWith('resume null'))).toHaveLength(1);
    });

    it('a way back Claude Code answers with a copy is tried again, after a pause', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      h.host.copyResumesIn.set(MAIN, 1);
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
      expect(h.host.calls.filter((c) => c.startsWith('resume null'))).toHaveLength(2);
      expect(h.sleeps).toContain(2_000);
      expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID]);
    });

    it('gives up on the way back after a few tries', async () => {
      const h = harness();
      h.onMain(session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      h.host.copyResumesIn.set(MAIN, 10);
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
      expect(h.host.calls.filter((c) => c.startsWith('resume null'))).toHaveLength(3);
      expect(h.sleeps.filter((ms) => ms === 2_000)).toEqual([2_000, 2_000]);
    });

    it('measures the confirm window on its own clock: a frozen wall clock cannot hold it open', async () => {
      // No clock given, as the daemon builds it. Were the window measured on Date.now, frozen here,
      // it would never close and the poll cycle would wait on it forever.
      const frozen = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        const host = new FakeBackgroundHost([MAIN, PROFILE]);
        host.add(MAIN, session(SID, 'C:/research'), { idle: true });
        host.silentResumeIn.add(PROFILE);
        host.silentResumeIn.add(MAIN);
        const mover = new BackgroundMover({
          host,
          resolveRule: () => Promise.resolve('rule-1'),
          notify: () => {},
          confirmTimeoutMs: 30,
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 5))),
        });
        const outcomes = await mover.run(targets(TARGET));
        expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
      } finally {
        frozen.mockRestore();
      }
    });
  });
});
