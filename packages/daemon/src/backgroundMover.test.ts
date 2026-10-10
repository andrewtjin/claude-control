// The background mover's decisions, against a fake Claude Code service: which sessions move (idle,
// on the global slot, with no terminal open, in a folder with a target), how (stop, resume by full
// id under the folder's profile with every saved option, or with the profile's own row when it
// saved the same ones, confirm), how often (once per interval per session), what it refuses to move
// (options it cannot carry over, a profile row saved with other options), and what a failure leaves
// behind (put back where it was, tried a few times, never tried again, one notice). The real
// commands sit behind the host seam; cli/backgroundHost.test.ts covers them.

import { describe, expect, it, vi } from 'vitest';
import {
  BackgroundMover,
  type BackgroundSession,
  type BackgroundSessionHost,
  type MoveTarget,
  type SavedLaunch,
  type SessionActivity,
} from './backgroundMover.js';
import type { SessionLock } from './backgroundMove.js';

const MAIN = null;
const PROFILE = 'C:/vault/profiles/rule-1';
const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SID2 = 'f38038c6-523b-4be5-9dff-160c472faeb0';

/** A fake Claude Code: which config dir hosts which session, what each is doing, what each config
 *  dir's job row saved, and a log of every command. Commands behave like the real ones by default (a
 *  stop removes the session from its host, a resume adds it and writes the target's row the way
 *  Claude Code does, a resume with options over an existing row is refused), and each can be made to
 *  fail. */
class FakeHost implements BackgroundSessionHost {
  readonly calls: string[] = [];
  readonly hosted = new Map<string | null, BackgroundSession[]>();
  readonly states = new Map<string, SessionActivity>();
  /** Each config dir's job row for the session; a dir with none holds no row. */
  readonly saved = new Map<string | null, SavedLaunch>([
    [MAIN, { kind: 'replayable', options: ['--permission-mode=auto'] }],
  ]);
  attached = false;
  /** Session ids whose move lock another process holds. */
  readonly lockedElsewhere = new Set<string>();
  /** Every lock taken and released, in order. */
  readonly locks: string[] = [];
  failAttached = false;
  failListing = false;
  failActivity = false;
  failStop = false;
  /** Config dirs whose resume fails. */
  readonly failResumeIn = new Set<string | null>();
  /** Config dirs whose next N resumes start a copy instead (then they work). */
  readonly copyResumesIn = new Map<string | null, number>();
  /** Config dirs whose resume "succeeds" but never shows the session hosted. */
  readonly silentResumeIn = new Set<string | null>();
  /** Config dirs whose resumed session shows up only on the Nth roster read after the resume. */
  readonly showOnReadIn = new Map<string | null, number>();
  private readonly pendingReads = new Map<string | null, number>();

  add(configDir: string | null, s: BackgroundSession, activity: SessionActivity): void {
    this.hosted.set(configDir, [...(this.hosted.get(configDir) ?? []), s]);
    this.states.set(s.short, activity);
  }

  listHosted(configDir: string | null): Promise<BackgroundSession[]> {
    this.calls.push(`list ${String(configDir)}`);
    if (this.failListing) return Promise.reject(new Error('no claude'));
    const pending = this.pendingReads.get(configDir);
    if (pending !== undefined && pending > 1) {
      this.pendingReads.set(configDir, pending - 1);
      return Promise.resolve([]);
    }
    this.pendingReads.delete(configDir);
    return Promise.resolve([...(this.hosted.get(configDir) ?? [])]);
  }

  activity(configDir: string | null): Promise<Map<string, SessionActivity>> {
    this.calls.push(`activity ${String(configDir)}`);
    if (this.failActivity) return Promise.reject(new Error('agents failed'));
    return Promise.resolve(new Map(this.states));
  }

  attachedNow(configDir: string | null): Promise<boolean> {
    this.calls.push(`attached ${String(configDir)}`);
    if (this.failAttached) return Promise.reject(new Error('journal unreadable'));
    return Promise.resolve(this.attached);
  }

  stop(configDir: string | null, short: string): Promise<void> {
    this.calls.push(`stop ${String(configDir)} ${short}`);
    if (this.failStop) return Promise.reject(new Error('stop refused'));
    this.hosted.set(
      configDir,
      (this.hosted.get(configDir) ?? []).filter((s) => s.short !== short),
    );
    return Promise.resolve();
  }

  lockSession(sessionId: string, waitMs: number): Promise<SessionLock | undefined> {
    if (this.lockedElsewhere.has(sessionId)) return Promise.resolve(undefined);
    this.locks.push(`take ${sessionId} ${waitMs}`);
    return Promise.resolve({ release: () => void this.locks.push(`release ${sessionId}`) });
  }

  savedOptions(configDir: string | null, short: string): Promise<SavedLaunch> {
    this.calls.push(`options ${String(configDir)} ${short}`);
    return Promise.resolve(this.saved.get(configDir) ?? { kind: 'none' });
  }

  resumeIdle(input: {
    configDir: string | null;
    sessionId: string;
    short: string;
    cwd: string;
    options?: string[];
  }): Promise<void> {
    this.calls.push(
      `resume ${String(input.configDir)} ${input.sessionId} ${input.cwd}` +
        (input.options === undefined ? '' : ` [${input.options.join(' ')}]`),
    );
    if (input.options !== undefined && this.saved.has(input.configDir)) {
      return Promise.reject(new Error('that config dir already holds a job row for it'));
    }
    if (this.failResumeIn.has(input.configDir)) return Promise.reject(new Error('untrusted'));
    const copiesLeft = this.copyResumesIn.get(input.configDir) ?? 0;
    if (copiesLeft > 0) {
      this.copyResumesIn.set(input.configDir, copiesLeft - 1);
      return Promise.reject(new Error('claude started a copy (5ad47a09) instead of resuming it'));
    }
    // Claude Code saves the options a first resume was given as that config dir's row.
    if (input.options !== undefined) {
      this.saved.set(input.configDir, { kind: 'replayable', options: [...input.options] });
    }
    if (!this.silentResumeIn.has(input.configDir)) {
      this.hosted.set(input.configDir, [
        ...(this.hosted.get(input.configDir) ?? []),
        { short: input.short, sessionId: input.sessionId, cwd: input.cwd },
      ]);
      const reads = this.showOnReadIn.get(input.configDir);
      if (reads !== undefined) this.pendingReads.set(input.configDir, reads);
    }
    return Promise.resolve();
  }
}

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
  host: FakeHost;
  mover: BackgroundMover;
  notices: Array<{ title: string; body: string; level: string }>;
  /** Every warn line the mover logged. */
  warns: string[];
  /** Every pause the mover asked for. */
  sleeps: number[];
  now: { ms: number };
}

/** A mover whose rule resolution maps C:/research (and below) to rule-1, C:/other to rule-2, and
 *  everything else to no rule. Its clock is `now`, which only its pauses move forward. */
function harness(opts: { minIntervalMs?: number; confirmTimeoutMs?: number } = {}): Harness {
  const host = new FakeHost();
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
  return { host, mover, notices, warns, sleeps, now };
}

const targets = (...t: MoveTarget[]): Map<string, MoveTarget> =>
  new Map(t.map((x) => [x.ruleId, x]));

describe('BackgroundMover', () => {
  it('with no folder ready, asks Claude Code nothing at all', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    expect(await h.mover.run(new Map())).toEqual([]);
    expect(h.host.calls).toEqual([]);
  });

  it('moves an idle global-slot session in a ready folder: stop, resume under the profile, confirm', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research/sub'), { idle: true, name: 'pods' });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([{ sessionId: SID, ruleId: 'rule-1', result: 'moved' }]);
    expect(h.host.calls).toEqual([
      'list null',
      // Re-read under the session's move lock: another cctl process may have moved it meanwhile.
      'list null',
      'activity null',
      'attached null',
      'options null 1ee43a2b',
      `options ${PROFILE} 1ee43a2b`,
      'stop null 1ee43a2b',
      // Same full id, same cwd, the source's saved options, under the rule's profile.
      `resume ${PROFILE} ${SID} C:/research/sub [--permission-mode=auto]`,
      `list ${PROFILE}`,
    ]);
    expect(h.host.hosted.get(PROFILE)?.map((s) => s.sessionId)).toEqual([SID]);
    expect(h.host.hosted.get(MAIN)).toEqual([]);
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

  it('never stops a session in a turn, or one waiting on a prompt', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: false });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([
      { sessionId: SID, ruleId: 'rule-1', result: 'skipped', reason: 'not idle between turns' },
    ]);
    expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    // Not given up on: once it is idle, the next cycle moves it.
    h.host.states.set('1ee43a2b', { idle: true });
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('never touches a session outside every ruled folder, or in a folder that is not ready', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/elsewhere'), { idle: true });
    h.host.add(MAIN, session(SID2, 'C:/other/app'), { idle: true });
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    // Nothing to move, so Claude Code is not even asked what the sessions are doing.
    expect(h.host.calls).toEqual(['list null']);
  });

  it('moves only the sessions of the ready folders when several are hosted', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.add(MAIN, session(SID2, 'C:/elsewhere'), { idle: true });
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes.map((o) => [o.sessionId, o.result])).toEqual([[SID, 'moved']]);
    expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID2]);
  });

  it('moves a session at most once per interval, however often it lands back on the global slot', async () => {
    const h = harness({ minIntervalMs: 60_000 });
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    // Woken back onto the global slot by hand (its main job row kept its saved options).
    h.host.hosted.set(PROFILE, []);
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.now.ms += 59_000;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    h.now.ms += 2_000;
    h.host.calls.length = 0;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    // The profile kept the row the first move gave it, saved with the same options: the session
    // wakes with that row, so nothing is passed (and nothing there is dropped).
    expect(h.host.calls).toContain(`resume ${PROFILE} ${SID} C:/research`);
  });

  it('a resume the target refuses puts the session back, gives up on it, and says so once', async () => {
    const h = harness({ minIntervalMs: 1 });
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.failResumeIn.add(PROFILE);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes).toEqual([
      { sessionId: SID, ruleId: 'rule-1', result: 'failed', restored: true, reason: 'untrusted' },
    ]);
    // Put back by a plain resume on the main config, which wakes it with its own saved options.
    expect(h.host.calls).toContain(`resume null ${SID} C:/research`);
    expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID]);
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

  it('a resume that never shows up under the profile counts as a failure too', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.silentResumeIn.add(PROFILE);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(outcomes[0]?.reason).toContain("did not appear under C:/research's slot");
  });

  it('when even the way back fails, the notice says how to resume it by hand', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.failResumeIn.add(PROFILE);
    h.host.failResumeIn.add(MAIN);
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
    expect(h.notices[0]?.body).toContain(`resume it with: claude --bg --resume ${SID}`);
  });

  it('a stop Claude Code refuses leaves the session running where it was, and gives up', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.failStop = true;
    const outcomes = await h.mover.run(targets(TARGET));
    expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
    expect(h.host.calls.some((c) => c.startsWith('resume'))).toBe(false);
    expect(h.notices[0]?.body).toContain('could not stop it: stop refused');
  });

  it('a listing that fails moves nothing and is not an error', async () => {
    const h = harness();
    h.host.failListing = true;
    expect(await h.mover.run(targets(TARGET))).toEqual([]);
    expect(h.notices).toEqual([]);
  });

  it('when what a session is doing cannot be read, it is left alone and tried next cycle', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.failActivity = true;
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
    expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    // Said once, not every cycle: a daemon without claude on its PATH would otherwise be silent.
    await h.mover.run(targets(TARGET));
    expect(h.warns).toEqual(['could not tell whether a background session is idle; not moving it']);
    h.host.failActivity = false;
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
  });

  it('a session gone from the activity listing is not stopped', async () => {
    const h = harness();
    h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
    h.host.states.clear();
    expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
    expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
  });

  describe('the move lock it shares with cctl claude', () => {
    it("takes the session's lock without waiting, and lets go of it after the move", async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });

    it('leaves a session another cctl process holds the lock of alone, and looks again next cycle', async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
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
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      // The listing saw it; by the time the lock is held, cctl claude has moved it.
      const listHosted = h.host.listHosted.bind(h.host);
      let reads = 0;
      h.host.listHosted = (configDir) => {
        reads++;
        if (reads === 2) h.host.hosted.set(MAIN, []);
        return listHosted(configDir);
      };
      expect(await h.mover.run(targets(TARGET))).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'skipped',
          reason: 'it is no longer on the global slot',
        },
      ]);
      expect(h.host.calls.some((c) => c.startsWith('stop') || c.startsWith('activity'))).toBe(
        false,
      );
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });

    it('lets go of the lock even when a move fails', async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('failed');
      expect(h.host.locks).toEqual([`take ${SID} 0`, `release ${SID}`]);
    });
  });

  describe('what it carries over, or refuses to', () => {
    it('passes every saved option on a first move, restrictions included', async () => {
      const h = harness();
      const saved = [
        '--effort=low',
        '--disallowedTools=Bash',
        '--disallowedTools=WebFetch',
        '--dangerously-skip-permissions',
      ];
      h.host.saved.set(MAIN, { kind: 'replayable', options: saved });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(h.host.calls).toContain(`resume ${PROFILE} ${SID} C:/research [${saved.join(' ')}]`);
    });

    it('a session saved with something a move cannot carry over is never stopped, and said so once', async () => {
      const h = harness();
      h.host.saved.set(MAIN, {
        kind: 'unreplayable',
        reason: 'it was started with --file, which a move does not replay',
      });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
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
      expect(h.host.calls.some((c) => c.startsWith('stop') || c.startsWith('resume'))).toBe(false);
      expect(h.notices).toHaveLength(1);
      expect(h.notices[0]?.body).toContain('It is still on the shared account, as before.');
      // Its saved options do not change, so it is not looked at again.
      h.host.calls.length = 0;
      expect(await h.mover.run(targets(TARGET))).toEqual([]);
      expect(h.notices).toHaveLength(1);
    });

    it('a profile row saved with other options is left alone: no stop, no resume over it', async () => {
      // Dropping that row is no way out: Claude Code's rm takes the session's worktree with it.
      const h = harness();
      h.host.saved.set(PROFILE, { kind: 'replayable', options: ['--permission-mode=plan'] });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
      expect(outcomes[0]?.reason).toBe(
        "C:/research's slot still holds it from an earlier move, saved with other options",
      );
      expect(h.host.calls.some((c) => c.startsWith('stop') || c.startsWith('resume'))).toBe(false);
    });

    it('a profile row that cannot be carried over itself is left alone too', async () => {
      const h = harness();
      h.host.saved.set(PROFILE, {
        kind: 'unreplayable',
        reason: 'it holds permission rules granted while it ran, which a move cannot carry over',
      });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]?.reason).toBe(
        "C:/research's slot still holds it: it holds permission rules granted while it ran, " +
          'which a move cannot carry over',
      );
      expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    });

    it('a row that cannot be read right now is skipped, not given up on', async () => {
      for (const where of [MAIN, PROFILE]) {
        const h = harness();
        h.host.saved.set(where, { kind: 'unreadable' });
        h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
        expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
        expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
        expect(h.notices).toEqual([]);
        // Readable next cycle (written in full by then): moved.
        if (where === MAIN) {
          h.host.saved.set(MAIN, { kind: 'replayable', options: [] });
        } else {
          h.host.saved.delete(PROFILE);
        }
        expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      }
    });

    it('a session with no row on the global slot is skipped: the way back would need it', async () => {
      const h = harness();
      h.host.saved.delete(MAIN);
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
      expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    });
  });

  describe('a terminal with a session open', () => {
    it('holds every move back while one is open, and moves once it has left', async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.attached = true;
      expect(await h.mover.run(targets(TARGET))).toEqual([
        {
          sessionId: SID,
          ruleId: 'rule-1',
          result: 'skipped',
          reason: 'a terminal has a background session open',
        },
      ]);
      expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
      h.host.attached = false;
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
    });

    it('when it cannot be told whether one is open, the session is not stopped', async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.failAttached = true;
      expect((await h.mover.run(targets(TARGET)))[0]).toMatchObject({ result: 'skipped' });
      expect(h.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    });
  });

  describe('confirming, and the way back', () => {
    it('waits for a resumed session that shows up only a few roster reads later', async () => {
      // Claude Code returns once the session is dispatched; its worker reaches the roster later.
      const h = harness({ confirmTimeoutMs: 15_000 });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.showOnReadIn.set(PROFILE, 3);
      expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
      expect(h.host.calls.filter((c) => c === `list ${PROFILE}`)).toHaveLength(3);
      expect(h.sleeps).toEqual([500, 500]);
    });

    it('a way back that is accepted but never shows up is not reported as restored', async () => {
      const h = harness({ confirmTimeoutMs: 2_000 });
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
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
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      h.host.copyResumesIn.set(MAIN, 1);
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: true });
      expect(h.host.calls.filter((c) => c.startsWith('resume null'))).toHaveLength(2);
      expect(h.sleeps).toEqual([2_000]);
      expect(h.host.hosted.get(MAIN)?.map((s) => s.sessionId)).toEqual([SID]);
    });

    it('gives up on the way back after a few tries', async () => {
      const h = harness();
      h.host.add(MAIN, session(SID, 'C:/research'), { idle: true });
      h.host.failResumeIn.add(PROFILE);
      h.host.copyResumesIn.set(MAIN, 10);
      const outcomes = await h.mover.run(targets(TARGET));
      expect(outcomes[0]).toMatchObject({ result: 'failed', restored: false });
      expect(h.host.calls.filter((c) => c.startsWith('resume null'))).toHaveLength(3);
      expect(h.sleeps).toEqual([2_000, 2_000]);
    });

    it('measures the confirm window on its own clock: a frozen wall clock cannot hold it open', async () => {
      // No clock given, as the daemon builds it. Were the window measured on Date.now, frozen here,
      // it would never close and the poll cycle would wait on it forever.
      const frozen = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
      try {
        const host = new FakeHost();
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
