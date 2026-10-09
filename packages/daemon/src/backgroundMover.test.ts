// The background mover's decisions, against a fake Claude Code service: which sessions move (idle,
// on the global slot, in a folder with a target), how (stop, resume by full id under the folder's
// profile with the saved options, confirm), how often (once per interval per session), and what a
// failure leaves behind (put back where it was, never tried again, one notice). The real commands
// sit behind the host seam; cli/backgroundHost.test.ts covers them.

import { describe, expect, it } from 'vitest';
import {
  BackgroundMover,
  type BackgroundSession,
  type BackgroundSessionHost,
  type MoveTarget,
  type SessionActivity,
} from './backgroundMover.js';

const MAIN = null;
const PROFILE = 'C:/vault/profiles/rule-1';
const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SID2 = 'f38038c6-523b-4be5-9dff-160c472faeb0';

/** A fake Claude Code: which config dir hosts which session, what each is doing, and a log of every
 *  command. Commands behave like the real ones by default (a stop removes the session from its
 *  host, a resume adds it), and each can be made to fail. */
class FakeHost implements BackgroundSessionHost {
  readonly calls: string[] = [];
  readonly hosted = new Map<string | null, BackgroundSession[]>();
  readonly states = new Map<string, SessionActivity>();
  savedFlags: string[] = ['--permission-mode', 'auto'];
  failListing = false;
  failActivity = false;
  failStop = false;
  /** Config dirs whose resume fails. */
  readonly failResumeIn = new Set<string | null>();
  /** Config dirs whose resume "succeeds" but never shows the session hosted. */
  readonly silentResumeIn = new Set<string | null>();

  add(configDir: string | null, s: BackgroundSession, activity: SessionActivity): void {
    this.hosted.set(configDir, [...(this.hosted.get(configDir) ?? []), s]);
    this.states.set(s.short, activity);
  }

  listHosted(configDir: string | null): Promise<BackgroundSession[]> {
    this.calls.push(`list ${String(configDir)}`);
    if (this.failListing) return Promise.reject(new Error('no claude'));
    return Promise.resolve([...(this.hosted.get(configDir) ?? [])]);
  }

  activity(configDir: string | null): Promise<Map<string, SessionActivity>> {
    this.calls.push(`activity ${String(configDir)}`);
    if (this.failActivity) return Promise.reject(new Error('agents failed'));
    return Promise.resolve(new Map(this.states));
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

  savedOptions(configDir: string | null, short: string): Promise<string[]> {
    this.calls.push(`options ${String(configDir)} ${short}`);
    return Promise.resolve([...this.savedFlags]);
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
    if (this.failResumeIn.has(input.configDir)) return Promise.reject(new Error('untrusted'));
    if (!this.silentResumeIn.has(input.configDir)) {
      this.hosted.set(input.configDir, [
        ...(this.hosted.get(input.configDir) ?? []),
        { short: input.short, sessionId: input.sessionId, cwd: input.cwd },
      ]);
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
  now: { ms: number };
}

/** A mover whose rule resolution maps C:/research (and below) to rule-1, C:/other to rule-2, and
 *  everything else to no rule. */
function harness(opts: { minIntervalMs?: number } = {}): Harness {
  const host = new FakeHost();
  const notices: Harness['notices'] = [];
  const warns: string[] = [];
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
    confirmTimeoutMs: 0,
    sleep: () => Promise.resolve(),
  });
  return { host, mover, notices, warns, now };
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
      'activity null',
      'options null 1ee43a2b',
      'stop null 1ee43a2b',
      // Same full id, same cwd, the source's saved options, under the rule's profile.
      `resume ${PROFILE} ${SID} C:/research/sub [--permission-mode auto]`,
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
    expect((await h.mover.run(targets(TARGET)))[0]?.result).toBe('moved');
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
});
