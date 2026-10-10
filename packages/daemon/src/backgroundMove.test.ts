// The one move both the daemon and `cctl claude` make, on its own: between any two config dirs (not
// only off the global slot), the rows it leaves (only under the target), a session started from its
// row (`cctl claude` opening one that runs nowhere), what a stop that was taken but not seen through
// leaves behind, where a session runs and what its lineage is after /clear, and the judgment of which
// folder slots a session moves onto. The daemon's per-cycle policy around it is covered in
// backgroundMover.test.ts; the real commands in cli/backgroundHost.test.ts.

import { describe, expect, it } from 'vitest';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import {
  isMoveTarget,
  lineageOf,
  moveBackgroundSession,
  sameConfigDir,
  sessionLabel,
  whereRuns,
  type BackgroundSession,
  type MoveRequest,
  type MoveTiming,
} from './backgroundMove.js';
import { FakeBackgroundHost } from './fakeBackgroundHost.js';

const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SHORT = SID.slice(0, 8);
const OLD = 'C:/vault/profiles/rule-old';
const NEW = 'C:/vault/profiles/rule-new';
const S: BackgroundSession = { short: SHORT, sessionId: SID, cwd: 'C:/research' };
/** The conversation a /clear in S moves its job on to; a move resumes it as a job of that name. */
const CLEARED = '7a7a7a7a-1111-4222-8333-444444444444';
const CLEARED_SHORT = CLEARED.slice(0, 8);

/** A Claude Code with services in the main config dir, OLD and NEW; S runs idle under OLD, its row
 *  there saved with `--model=opus`. */
function fakeHost(): FakeBackgroundHost {
  const host = new FakeBackgroundHost([null, OLD, NEW]);
  host.add(
    OLD,
    S,
    { idle: true, name: 'pods' },
    {
      saved: { kind: 'replayable', options: ['--model=opus'] },
    },
  );
  return host;
}

const timing: MoveTiming = {
  clock: () => 0,
  confirmTimeoutMs: 0,
  sleep: () => Promise.resolve(),
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

const REQUEST: MoveRequest = {
  session: S,
  from: { configDir: OLD, name: "C:/old's slot" },
  to: { configDir: NEW, name: "C:/research's slot" },
};

const changes = (host: FakeBackgroundHost): string[] =>
  host.calls.filter((c) => /^(stop|rm|resume) /.test(c));

describe('moveBackgroundSession', () => {
  it('moves between two folder profiles, replaying the source row and leaving a row only under the target', async () => {
    const host = fakeHost();
    expect(await moveBackgroundSession(host, REQUEST, timing)).toEqual({
      result: 'moved',
      short: SHORT,
      sessionId: SID,
      name: 'pods',
      replayed: 1,
    });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${SID} C:/research [--model=opus]`,
    ]);
    expect(host.hosted.get(NEW)).toEqual([S]);
    expect(host.rowsFor(SID)).toEqual([NEW]);
  });

  it('runs onCommit once, right before the stop, and not at all when nothing is touched', async () => {
    const order: string[] = [];
    const host = fakeHost();
    const stop = host.stop.bind(host);
    host.stop = (c, short) => {
      order.push('stop');
      return stop(c, short);
    };
    let told: unknown;
    await moveBackgroundSession(host, REQUEST, timing, (recovery) => {
      order.push('commit');
      told = recovery;
    });
    expect(order).toEqual(['commit', 'stop']);
    // Told how to bring it back by hand, should the move be cut off from there on.
    expect(told).toEqual({
      configDir: OLD,
      sessionId: SID,
      job: { short: SHORT, sessionId: SID },
      options: ['--model=opus'],
      cwd: 'C:/research',
    });

    const busy = fakeHost();
    busy.states.set(SHORT, { idle: false });
    let committed = false;
    const r = await moveBackgroundSession(busy, REQUEST, timing, () => (committed = true));
    expect(r).toMatchObject({ result: 'not-moved', cause: 'busy', final: false });
    expect(committed).toBe(false);
  });

  it('a session no longer where the caller found it is left alone, in words that name the place', async () => {
    const host = fakeHost();
    host.hosted.set(OLD, []);
    host.hosted.set(NEW, [S]);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'gone',
      final: false,
      reason: "it is no longer on C:/old's slot",
    });
    expect(changes(host)).toEqual([]);
  });

  it('a roster that cannot be read is not known: nothing is stopped on a guess', async () => {
    const host = fakeHost();
    host.failListing = true;
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'unknown',
      final: false,
    });
    expect(changes(host)).toEqual([]);
  });

  it('two services listing it at once is not known either', async () => {
    const host = fakeHost();
    host.hosted.set(NEW, [S]);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'unknown',
      reason: 'more than one background service lists it',
    });
    expect(changes(host)).toEqual([]);
  });

  it('a stop taken but not seen through puts the session back where it was', async () => {
    // Claude Code took the stop, but the session had not exited when the host stopped waiting; it
    // is gone by the time the move looks again, so it may be stopped: resumed back with its row.
    const host = fakeHost();
    host.stopNotSeenThrough = true;
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
      reason: 'could not stop it: it was still running 10s after claude stop',
      name: 'pods',
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`, `resume ${OLD} ${SID} C:/research`]);
  });

  it('a stop not seen through whose way back fails too is NOT reported restored', async () => {
    const host = fakeHost();
    host.stopNotSeenThrough = true;
    host.failResumeIn.add(OLD);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
      recovery: {
        configDir: OLD,
        sessionId: SID,
        job: { short: SHORT, sessionId: SID },
        options: ['--model=opus'],
        cwd: 'C:/research',
      },
    });
  });

  it('a stop refused outright leaves it running where it was, with no resume anywhere', async () => {
    const host = fakeHost();
    host.failStop = true;
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`]);
  });

  it('a stop that returns while it is still hosted touches nothing more, and it is left where it runs', async () => {
    // Claude Code's stop returns, but the session is still listed (respawned, or slow to exit).
    const host = fakeHost();
    host.stopKeepsHosted = true;
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
      reason: 'it was still running after the stop',
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`]);
    expect(host.rowsFor(SID)).toEqual([OLD]);
  });

  it('a look after the stop that cannot be read removes no row and resumes nothing', async () => {
    const host = fakeHost();
    const stop = host.stop.bind(host);
    host.stop = async (c, short) => {
      await stop(c, short);
      // Every roster read from here on is torn.
      host.failListing = true;
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`]);
  });

  it('a stop not seen through, after which where it runs cannot be read: nothing is resumed on a guess', async () => {
    const host = fakeHost();
    host.stopNotSeenThrough = true;
    const stop = host.stop.bind(host);
    host.stop = async (c, short) => {
      try {
        await stop(c, short);
      } finally {
        host.failListing = true;
      }
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`]);
  });

  it('a stop not seen through, after which it runs on another service: nothing is resumed where it was', async () => {
    const host = fakeHost();
    host.stopNotSeenThrough = true;
    const stop = host.stop.bind(host);
    host.stop = async (c, short) => {
      try {
        await stop(c, short);
      } finally {
        // Started under NEW by someone else meanwhile.
        host.hosted.set(NEW, [S]);
      }
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`]);
  });

  it('a way back over a source row that cannot be read wakes that row, never passes options over it', async () => {
    // A resume with options over a row Claude Code still holds is refused.
    const host = fakeHost();
    host.stopNotSeenThrough = true;
    const stop = host.stop.bind(host);
    host.stop = async (c, short) => {
      try {
        await stop(c, short);
      } finally {
        host.rowOf(OLD, SHORT)!.unreadable = true;
      }
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
    });
    expect(changes(host)).toEqual([`stop ${OLD} ${SHORT}`, `resume ${OLD} ${SID} C:/research`]);
  });

  it('a resume the target refuses is put back on the source with its options, its row there rebuilt', async () => {
    const host = fakeHost();
    host.failResumeIn.add(NEW);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
      reason: 'untrusted',
    });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${SID} C:/research [--model=opus]`,
      `resume ${OLD} ${SID} C:/research [--model=opus]`,
    ]);
    expect(host.rowOf(OLD, SHORT)?.saved).toEqual({
      kind: 'replayable',
      options: ['--model=opus'],
    });
    expect(host.rowsFor(SID)).toEqual([OLD]);
  });

  it('a resume that fails while the session turns up on a third service is neither a move nor put back', async () => {
    const host = fakeHost();
    host.failResumeIn.add(NEW);
    const resume = host.resumeIdle.bind(host);
    host.resumeIdle = async (input) => {
      try {
        return await resume(input);
      } finally {
        // Started under the main config dir by someone else meanwhile.
        if (input.configDir === NEW) host.hosted.set(null, [S]);
      }
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${SID} C:/research [--model=opus]`,
    ]);
  });

  it('a target row a failed resume left that cannot be removed: not put back, as that row would be a trap', async () => {
    const host = fakeHost();
    host.silentResumeIn.add(NEW);
    host.failRemoveIn.add(NEW);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
    expect(changes(host).filter((c) => c.startsWith(`resume ${OLD}`))).toEqual([]);
  });

  it('a target row a failed resume left is never taken for none when it cannot be read: its removal comes before any way back', async () => {
    const host = fakeHost();
    host.silentResumeIn.add(NEW);
    const resume = host.resumeIdle.bind(host);
    host.resumeIdle = async (input) => {
      await resume(input);
      // Caught mid-write: it is still the row the resume wrote.
      if (input.configDir === NEW) host.rowOf(NEW, SHORT)!.unreadable = true;
    };
    await moveBackgroundSession(host, REQUEST, timing);
    expect(changes(host)).toContain(`rm ${NEW} ${SHORT}`);
    // The row could not be removed, so it is not put back either.
    expect(changes(host).filter((c) => c.startsWith(`resume ${OLD}`))).toEqual([]);
  });

  it('a roster that cannot be read after the resume is no proof it is hosted there', async () => {
    const host = fakeHost();
    host.silentResumeIn.add(NEW);
    const resume = host.resumeIdle.bind(host);
    host.resumeIdle = async (input) => {
      await resume(input);
      if (input.configDir === NEW) host.failListing = true;
    };
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: false,
    });
  });

  it('a stale target row saved with fewer options goes: the session keeps its restrictions', async () => {
    // The row Claude Code makes for a plain `claude --bg --resume <id>` there saves no options; the
    // session was started with a tool deny list.
    const host = fakeHost();
    host.rowOf(OLD, SHORT)!.saved = {
      kind: 'replayable',
      options: ['--disallowedTools=Bash', '--name=pods'],
    };
    host.setRow(NEW, SHORT, {
      sessionId: SID,
      state: 'stopped',
      saved: { kind: 'replayable', options: [] },
    });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({ result: 'moved' });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `rm ${NEW} ${SHORT}`,
      `resume ${NEW} ${SID} C:/research [--disallowedTools=Bash --name=pods]`,
    ]);
  });

  it('starts a session that runs nowhere under the target from its row elsewhere, removing that row first', async () => {
    const host = fakeHost();
    host.hosted.set(OLD, []);
    host.rowOf(OLD, SHORT)!.state = 'failed';
    const start: MoveRequest = { ...REQUEST, start: true };
    expect(await moveBackgroundSession(host, start, timing)).toMatchObject({
      result: 'moved',
      short: SHORT,
    });
    // Nothing to stop and nothing asked of a session that is not running.
    expect(host.calls.some((c) => c.startsWith('activity') || c.startsWith('attached'))).toBe(
      false,
    );
    expect(changes(host)).toEqual([
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${SID} C:/research [--model=opus]`,
    ]);
    expect(host.rowsFor(SID)).toEqual([NEW]);
  });

  it('a start finds it running again: left alone', async () => {
    const host = fakeHost();
    expect(await moveBackgroundSession(host, { ...REQUEST, start: true }, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'gone',
    });
    expect(changes(host)).toEqual([]);
  });

  it('a session with work held between turns is busy, though Claude Code reports it idle', async () => {
    const host = fakeHost();
    host.rowOf(OLD, SHORT)!.pending = true;
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'busy',
      final: false,
    });
    expect(changes(host)).toEqual([]);
  });

  it('a row that changed a moment ago is read again once it has settled: a wakeup re-armed in between keeps the session', async () => {
    // Measured: as a scheduled wakeup fires, the row reads idle with nothing held for a fraction of
    // a second, until Claude Code arms the next one.
    const host = fakeHost();
    const row = host.rowOf(OLD, SHORT)!;
    row.updatedAt = new Date().toISOString();
    const settling: MoveTiming = {
      ...timing,
      sleep: () => {
        row.pending = true;
        return Promise.resolve();
      },
    };
    expect(await moveBackgroundSession(host, REQUEST, settling)).toMatchObject({
      result: 'not-moved',
      cause: 'busy',
    });
    expect(changes(host)).toEqual([]);
    // A row that has been quiet a while is not waited on.
    const quiet = fakeHost();
    quiet.rowOf(OLD, SHORT)!.updatedAt = new Date(Date.now() - 60_000).toISOString();
    let paused = 0;
    const counting: MoveTiming = { ...timing, sleep: () => (paused++, Promise.resolve()) };
    expect(await moveBackgroundSession(quiet, REQUEST, counting)).toMatchObject({
      result: 'moved',
    });
    expect(paused).toBe(0);
  });

  it('a session whose registry entry says busy is not stopped, whatever the listing says', async () => {
    const host = fakeHost();
    host.liveSessions = () =>
      Promise.resolve([
        { pid: 1, sessionId: SID, kind: 'bg', status: 'busy', jobId: SHORT, cwd: 'C:/research' },
      ]);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({ cause: 'busy' });
    expect(changes(host)).toEqual([]);
  });

  it('open in a terminal: not the background session the caller found', async () => {
    const host = fakeHost();
    host.extraEntries.push({ pid: 9, sessionId: SID, kind: 'interactive' });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({ cause: 'gone' });
    expect(changes(host)).toEqual([]);
  });

  it('a row of it that records a worktree keeps it where it runs, for good', async () => {
    const host = fakeHost();
    host.rowOf(OLD, SHORT)!.worktreePath = 'C:/research/.claude/worktrees/x';
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'worktree',
      final: true,
    });
    expect(changes(host)).toEqual([]);
  });

  it('after /clear, the conversation it runs now is resumed, and every row of that conversation goes', async () => {
    const host = fakeHost();
    const NEXT = '7a7a7a7a-1111-4222-8333-444444444444';
    host.rowOf(OLD, SHORT)!.resumeSessionId = NEXT;
    host.currentIds.set(SHORT, NEXT);
    // A stale row of its job under the main config dir, written after the clear.
    host.setRow(null, SHORT, {
      sessionId: SID,
      resumeSessionId: NEXT,
      state: 'stopped',
      saved: { kind: 'replayable', options: [] },
    });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'moved',
      short: '7a7a7a7a',
      sessionId: NEXT,
    });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm null ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${NEXT} C:/research [--model=opus]`,
    ]);
    expect(host.rowsFor(NEXT)).toEqual([NEW]);
    expect(host.rowsFor(SID)).toEqual([]);
  });

  it('after /clear, a row elsewhere of its earlier conversation is left as it was: it reaches no job the session runs under', async () => {
    // Measured: two jobs can share a job id, one running a cleared job's new conversation and one
    // its earlier conversation, resumed as a job of its own. A wake of the earlier one's row reaches
    // only its job id, and the moved session runs under a job named after its own conversation.
    const host = fakeHost();
    const NEXT = '7a7a7a7a-1111-4222-8333-444444444444';
    host.rowOf(OLD, SHORT)!.resumeSessionId = NEXT;
    host.currentIds.set(SHORT, NEXT);
    host.setRow(null, SHORT, {
      sessionId: SID,
      resumeSessionId: SID,
      name: 'the earlier one',
      state: 'stopped',
      saved: { kind: 'replayable', options: ['--name=the earlier one'] },
    });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'moved',
      short: '7a7a7a7a',
    });
    expect(changes(host)).toEqual([
      `stop ${OLD} ${SHORT}`,
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${NEXT} C:/research [--model=opus]`,
    ]);
    expect(host.rowOf(null, SHORT)).toMatchObject({ name: 'the earlier one', state: 'stopped' });
  });

  it('another conversation under the very job id the session keeps after the move: not moved, for good', async () => {
    // No /clear here, so the session keeps its job id when moved; a row elsewhere runs another
    // conversation under that id (its job was cleared there), and would reach it after the move.
    const host = fakeHost();
    const OTHER = '9b9b9b9b-1111-4222-8333-444444444444';
    host.setRow(null, SHORT, {
      sessionId: SID,
      resumeSessionId: OTHER,
      state: 'stopped',
      saved: { kind: 'replayable', options: [] },
    });
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'not-moved',
      cause: 'conversations',
      final: true,
      reason:
        `Claude Code keeps another conversation (${OTHER}) under the job id it would run under ` +
        `(${SHORT}), so a move cannot tell the two apart`,
    });
    expect(changes(host)).toEqual([]);
  });

  it('after /clear, a failed move puts back the conversation it ran, not the one it started with', async () => {
    const host = fakeHost();
    host.rowOf(OLD, SHORT)!.resumeSessionId = CLEARED;
    host.currentIds.set(SHORT, CLEARED);
    host.failResumeIn.add(NEW);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'failed',
      restored: true,
    });
    expect(changes(host).at(-1)).toBe(`resume ${OLD} ${CLEARED} C:/research [--model=opus]`);
  });

  it('after /clear, a start resumes the conversation its row ran last, under the job named after it', async () => {
    const host = fakeHost();
    host.hosted.set(OLD, []);
    host.rowOf(OLD, SHORT)!.resumeSessionId = CLEARED;
    expect(await moveBackgroundSession(host, { ...REQUEST, start: true }, timing)).toMatchObject({
      result: 'moved',
      short: CLEARED_SHORT,
      sessionId: CLEARED,
    });
    expect(changes(host)).toEqual([
      `rm ${OLD} ${SHORT}`,
      `resume ${NEW} ${CLEARED} C:/research [--model=opus]`,
    ]);
  });

  it('after /clear, a resume that shows up just past the confirm window is a move, not a failure', async () => {
    // The registry names the conversation it runs now; its row has not recorded it yet, so only
    // the second look, made with the id and job it was resumed as, can find it.
    const host = fakeHost();
    host.currentIds.set(SHORT, CLEARED);
    host.showOnReadIn.set(NEW, 2);
    expect(await moveBackgroundSession(host, REQUEST, timing)).toMatchObject({
      result: 'moved',
      short: CLEARED_SHORT,
      sessionId: CLEARED,
    });
    expect(host.hostsOf(CLEARED_SHORT)).toEqual([NEW]);
  });
});

describe('where a session runs, and its lineage', () => {
  it('a row and a live entry link every id the session has had', () => {
    const NEXT = '7a7a7a7a-1111-4222-8333-444444444444';
    const lineage = lineageOf(
      { ids: [NEXT], shorts: [] },
      [
        {
          configDir: null,
          row: {
            short: SHORT,
            sessionId: SID,
            resumeSessionId: NEXT,
            state: 'stopped',
            pending: false,
          },
        },
        {
          configDir: NEW,
          row: { short: '7a7a7a7a', sessionId: NEXT, state: 'running', pending: false },
        },
        {
          configDir: OLD,
          row: {
            short: 'ffffffff',
            sessionId: 'ffffffff-1111-4222-8333-444444444444',
            state: 'stopped',
            pending: false,
          },
        },
      ],
      [{ pid: 1, sessionId: NEXT, kind: 'bg', jobId: '7a7a7a7a' }],
    );
    expect([...lineage.ids].sort()).toEqual([SID, NEXT].sort());
    expect([...lineage.shorts].sort()).toEqual([SHORT, '7a7a7a7a'].sort());
  });

  it('a chain through a /clear id reaches a row filed under the new job, whatever order the rows come in', () => {
    // The row naming the new job comes first, before anything links it: only a second pass does.
    const lineage = lineageOf({ ids: [SID], shorts: [SHORT] }, [
      {
        configDir: NEW,
        row: { short: CLEARED_SHORT, sessionId: CLEARED, state: 'stopped', pending: false },
      },
      {
        configDir: null,
        row: {
          short: SHORT,
          sessionId: SID,
          resumeSessionId: CLEARED,
          state: 'stopped',
          pending: false,
        },
      },
    ]);
    expect([...lineage.shorts].sort()).toEqual([SHORT, CLEARED_SHORT].sort());
    expect([...lineage.ids].sort()).toEqual([SID, CLEARED].sort());
  });

  it('the registry entry of a job after /clear is found by its job id before any row names the new id', async () => {
    const host = fakeHost();
    host.currentIds.set(SHORT, CLEARED);
    expect(await whereRuns(host, { ids: new Set([SID]), shorts: new Set([SHORT]) })).toMatchObject({
      kind: 'bg',
      currentId: CLEARED,
      status: 'idle',
    });
  });

  it('is unclear while a session is live with no service listing it, and nowhere once it is gone', async () => {
    const host = new FakeBackgroundHost([null]);
    const lineage = { ids: new Set([SID]), shorts: new Set([SHORT]) };
    host.extraEntries.push({ pid: 1, sessionId: SID, kind: 'bg', jobId: SHORT, status: 'idle' });
    expect(await whereRuns(host, lineage)).toMatchObject({ kind: 'unclear' });
    host.extraEntries.length = 0;
    expect(await whereRuns(host, lineage)).toEqual({ kind: 'nowhere' });
  });

  it('names the job, the id it started with, and the conversation it runs now', async () => {
    const host = fakeHost();
    const NEXT = '7a7a7a7a-1111-4222-8333-444444444444';
    host.currentIds.set(SHORT, NEXT);
    expect(await whereRuns(host, { ids: new Set([NEXT]), shorts: new Set() })).toEqual({
      kind: 'bg',
      configDir: OLD,
      short: SHORT,
      sessionId: SID,
      currentId: NEXT,
      status: 'idle',
      cwd: 'C:/research',
    });
  });
});

describe('sameConfigDir and sessionLabel', () => {
  it('a config dir spelled with other case, slashes or a trailing separator is the same one on Windows', () => {
    expect(sameConfigDir('C:/Data/Profiles/rule-x', 'c:\\data\\profiles\\RULE-X\\', 'win32')).toBe(
      true,
    );
    expect(sameConfigDir('/data/a', '/data/A', 'linux')).toBe(false);
    expect(sameConfigDir(null, null)).toBe(true);
    expect(sameConfigDir(null, 'C:/x', 'win32')).toBe(false);
  });

  it('names a session by its name and short id, never twice by its id', () => {
    expect(sessionLabel(SHORT, 'pods')).toBe('"pods" (1ee43a2b)');
    expect(sessionLabel(SHORT, undefined)).toBe(SHORT);
    expect(sessionLabel(SHORT, '')).toBe(SHORT);
    expect(sessionLabel(SHORT, SHORT)).toBe(SHORT);
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

  it('an account read with no limits recorded counts as able: never polled is not out', () => {
    expect(isMoveTarget(['inc'], 'inc', { ...usage(0), limits: [] }, NOW)).toBe(true);
  });

  it('is not one in fallback, when out of usage, with nothing live, for an exclude-only rule, or with usage unknown', () => {
    expect(isMoveTarget(['inc'], 'shared', usage(10), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], 'inc', usage(100), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], null, usage(10), NOW)).toBe(false);
    expect(isMoveTarget([], 'inc', usage(10), NOW)).toBe(false);
    expect(isMoveTarget(['inc'], 'inc', { ...usage(10), quarantined: true }, NOW)).toBe(false);
    // Not polled this cycle, or its record could not be read: not known to be able.
    expect(isMoveTarget(['inc'], 'inc', undefined, NOW)).toBe(false);
  });
});
