// The routing of `cctl claude attach <session>` and `cctl claude --resume <session>` for background
// sessions, against a fake Claude Code that models several config dirs the way the real one behaves
// (one service per config dir, a job row per config dir, one shared registry): where the session is
// found, where it belongs, what is run, what is moved (through the daemon's own move), and above all
// that nothing is ever opened or resumed under a config dir while the session runs as a background
// session in another — the steal, which kills it mid-turn. The real commands are covered in
// backgroundHost.test.ts, and the two together against a fake binary in
// backgroundAttach.integration.test.ts.

import { describe, expect, it } from 'vitest';
import type { SavedLaunch, SessionActivity } from '@claude-control/daemon';
import {
  parseBackgroundRequest,
  routeBackgroundLaunch,
  runHolding,
  type BackgroundRequest,
  type RouteContext,
  type RouteDecision,
  type RouteMode,
  type SessionHome,
} from './backgroundAttach.js';
import type { ClaudeBackgroundHost, JobRow, LiveSession } from './backgroundHost.js';

const MAIN = null;
const X = 'C:/data/profiles/rule-x';
const Q = 'C:/data/profiles/rule-q';
const SID = 'c5f2097e-d500-42a0-9ddf-8a33f4f9a886';
const SHORT = 'c5f2097e';
const SID2 = '0dff6248-faa1-48a3-ba02-a3ac6c888819';
const WORK = 'C:/work/app';
const OTHER = 'C:/elsewhere';

type Config = string | null;
const key = (c: Config): string => c ?? 'main';

/** A Claude Code with services in MAIN, X (the folder's profile) and Q (another profile). Commands
 *  behave like the real ones: a stop removes the session from its service and the registry; a resume
 *  while it runs anywhere starts a copy (and is refused here); a resume with options over a row is
 *  refused; a resume wakes the row (a new one saved with the options given). Every command and every
 *  copy is recorded. */
class FakeClaude implements ClaudeBackgroundHost {
  readonly calls: string[] = [];
  /** Resumes run while the session ran as a background session somewhere: copies. */
  readonly copies: string[] = [];
  /** Who hosts what, by config dir. */
  readonly hosted = new Map<string, Array<{ sessionId: string; cwd: string }>>();
  readonly registry: LiveSession[] = [];
  readonly rows = new Map<string, JobRow[]>();
  readonly saved = new Map<string, SavedLaunch>();
  readonly titles = new Map<string, string>();
  readonly attachedIn = new Set<string>();
  readonly failResumeIn = new Set<string>();
  /** The status `claude agents` reports at the move's own look, when it differs from the registry's
   *  (a turn starting in between). */
  agentsStatus: string | undefined;
  failStop = false;
  /** How many lock takes another process wins before letting go (Infinity: never). */
  lockedFor = 0;
  readonly locks: string[] = [];
  /** Runs before a roster read, by config dir (to move the session between two looks). */
  beforeList: ((c: Config) => void) | undefined;

  /** The session runs as a background session in `c`, with a row there in state running. */
  runs(
    c: Config,
    sessionId = SID,
    opts: { status?: string; cwd?: string; name?: string } = {},
  ): void {
    const cwd = opts.cwd ?? WORK;
    this.hosted.set(key(c), [...(this.hosted.get(key(c)) ?? []), { sessionId, cwd }]);
    this.registry.push({
      pid: 4000 + this.registry.length,
      sessionId,
      kind: 'bg',
      ...(opts.status !== undefined ? { status: opts.status } : { status: 'idle' }),
      jobId: sessionId.slice(0, 8),
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      cwd,
    });
    this.row(c, 'running', sessionId, {
      cwd,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
    });
  }

  /** A row for the session in `c`. */
  row(
    c: Config,
    state: string,
    sessionId = SID,
    opts: { cwd?: string; name?: string; updatedAt?: string; saved?: SavedLaunch } = {},
  ): void {
    const rows = (this.rows.get(key(c)) ?? []).filter((r) => r.sessionId !== sessionId);
    rows.push({
      short: sessionId.slice(0, 8),
      sessionId,
      state,
      cwd: opts.cwd ?? WORK,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      updatedAt: opts.updatedAt ?? '2026-10-09T22:00:00.000Z',
    });
    this.rows.set(key(c), rows);
    if (opts.saved !== undefined) this.saved.set(`${key(c)} ${sessionId}`, opts.saved);
  }

  /** Where the session runs as a background session right now. */
  hostOf(sessionId = SID): string[] {
    return [...this.hosted.entries()]
      .filter(([, list]) => list.some((s) => s.sessionId === sessionId))
      .map(([k]) => k);
  }

  private rowOf(c: Config, sessionId: string): JobRow | undefined {
    return (this.rows.get(key(c)) ?? []).find((r) => r.sessionId === sessionId);
  }

  liveSessions(): Promise<LiveSession[]> {
    return Promise.resolve([...this.registry]);
  }
  jobRows(c: Config): Promise<JobRow[]> {
    return Promise.resolve([...(this.rows.get(key(c)) ?? [])]);
  }
  profileConfigDirs(): Promise<string[]> {
    return Promise.resolve([X, Q]);
  }
  sessionTitle(sessionId: string): Promise<string | undefined> {
    return Promise.resolve(this.titles.get(sessionId));
  }
  listHosted(c: Config): Promise<Array<{ short: string; sessionId: string; cwd: string }>> {
    this.beforeList?.(c);
    return Promise.resolve(
      (this.hosted.get(key(c)) ?? []).map((s) => ({ short: s.sessionId.slice(0, 8), ...s })),
    );
  }
  activity(c: Config): Promise<Map<string, SessionActivity>> {
    this.calls.push(`agents ${key(c)}`);
    const out = new Map<string, SessionActivity>();
    for (const row of this.rows.get(key(c)) ?? []) {
      const entry = this.registry.find((e) => e.sessionId === row.sessionId);
      const status = this.agentsStatus ?? entry?.status;
      out.set(row.short, { idle: status === 'idle', ...(row.name ? { name: row.name } : {}) });
    }
    return Promise.resolve(out);
  }
  attachedNow(c: Config): Promise<boolean> {
    return Promise.resolve(this.attachedIn.has(key(c)));
  }
  stop(c: Config, short: string): Promise<void> {
    this.calls.push(`stop ${key(c)} ${short}`);
    if (this.failStop) return Promise.reject(new Error('claude stop exited 1: refused'));
    const sessionId = (this.hosted.get(key(c)) ?? []).find((s) =>
      s.sessionId.startsWith(short),
    )?.sessionId;
    this.hosted.set(
      key(c),
      (this.hosted.get(key(c)) ?? []).filter((s) => !s.sessionId.startsWith(short)),
    );
    const i = this.registry.findIndex((e) => e.sessionId === sessionId);
    if (i >= 0) this.registry.splice(i, 1);
    const row = sessionId !== undefined ? this.rowOf(c, sessionId) : undefined;
    if (row !== undefined) row.state = 'stopped';
    return Promise.resolve();
  }
  savedOptions(c: Config, short: string): Promise<SavedLaunch> {
    const row = (this.rows.get(key(c)) ?? []).find((r) => r.short === short);
    if (row === undefined) return Promise.resolve({ kind: 'none' });
    return Promise.resolve(
      this.saved.get(`${key(c)} ${row.sessionId}`) ?? { kind: 'replayable', options: [] },
    );
  }
  resumeIdle(input: {
    configDir: Config;
    sessionId: string;
    short: string;
    cwd: string;
    options?: string[];
  }): Promise<void> {
    const c = input.configDir;
    this.calls.push(
      `resume ${key(c)}` + (input.options !== undefined ? ` [${input.options.join(' ')}]` : ''),
    );
    const running = this.hostOf(input.sessionId);
    if (running.length > 0) {
      this.copies.push(`resume under ${key(c)} while it ran in ${running.join(', ')}`);
      return Promise.reject(new Error('claude started a copy (5e1d04b2) instead of resuming it'));
    }
    if (input.options !== undefined && this.rowOf(c, input.sessionId) !== undefined) {
      return Promise.reject(new Error('that config dir already holds a job row for it'));
    }
    if (this.failResumeIn.has(key(c))) return Promise.reject(new Error('untrusted folder'));
    const existing = this.rowOf(c, input.sessionId);
    if (existing === undefined) {
      this.row(c, 'running', input.sessionId, {
        cwd: input.cwd,
        saved: { kind: 'replayable', options: input.options ?? [] },
      });
    } else {
      existing.state = 'running';
    }
    this.hosted.set(key(c), [
      ...(this.hosted.get(key(c)) ?? []),
      { sessionId: input.sessionId, cwd: input.cwd },
    ]);
    this.registry.push({
      pid: 5000 + this.registry.length,
      sessionId: input.sessionId,
      kind: 'bg',
      status: 'idle',
      jobId: input.short,
      cwd: input.cwd,
    });
    return Promise.resolve();
  }
  lockSession(_sessionId: string, waitMs: number): Promise<{ release(): void } | undefined> {
    if (this.lockedFor > 0) {
      this.lockedFor--;
      return Promise.resolve(undefined);
    }
    this.locks.push(`take ${waitMs}`);
    let released = false;
    return Promise.resolve({
      release: () => {
        if (!released) this.locks.push('release');
        released = true;
      },
    });
  }
}

interface World {
  host: FakeClaude;
  ctx: RouteContext;
  lines: string[];
  home: SessionHome;
}

/** A world where C:/work belongs to the rule whose profile is X, and anything else to MAIN. */
function world(
  home: Partial<SessionHome> = {},
  opts: { daemonRunning?: boolean; cwd?: string } = {},
): World {
  const host = new FakeClaude();
  const lines: string[] = [];
  const homeX: SessionHome = { configDir: X, movable: true, ...home };
  const views: Record<string, { account?: string; slot: string }> = {
    main: { account: 'Shared', slot: 'the global slot' },
    [X]: { account: 'Inc', slot: 'the folder slot of C:/work' },
    [Q]: { slot: 'the profile of a folder rule since removed' },
  };
  const ctx: RouteContext = {
    host,
    cwd: opts.cwd ?? WORK,
    platform: 'win32',
    sameFolder: (a, b) => a.toLowerCase() === b.toLowerCase(),
    homeOf: (cwd) =>
      Promise.resolve(
        cwd.toLowerCase().startsWith('c:/work') ? homeX : { configDir: null, movable: false },
      ),
    view: (c) => Promise.resolve(views[key(c)]!),
    daemonRunning: opts.daemonRunning ?? false,
    say: (line) => lines.push(line),
    lockWaitMs: 90_000,
    timing: {
      clock: () => 0,
      confirmTimeoutMs: 0,
      sleep: () => Promise.resolve(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
  };
  return { host, ctx, lines, home: homeX };
}

const attach = (ref: string): BackgroundRequest => ({ verb: 'attach', ref });
const resume = (ref: string): BackgroundRequest => ({ verb: 'resume', ref });
const FOLLOW: RouteMode = { kind: 'follow' };

/** The config dir the decision's attach or resume runs under (a pass runs on the launch's own slot:
 *  the caller's folder's in follow mode, the chosen one in fixed mode). */
function runsUnder(w: World, d: RouteDecision, mode: RouteMode): { under: Config } | undefined {
  if (d.kind === 'refuse') return undefined;
  if (d.kind === 'open') return { under: d.configDir };
  return { under: mode.kind === 'fixed' ? mode.configDir : w.home.configDir };
}

/** THE property: nothing is opened or resumed under a config dir while the session runs as a
 *  background session in another, and no resume ever started a copy. Checked on the state the
 *  decision leaves, which is the state Claude Code meets when the decision runs. */
function expectNoSteal(w: World, d: RouteDecision, mode: RouteMode = FOLLOW): void {
  expect(w.host.copies).toEqual([]);
  const runs = runsUnder(w, d, mode);
  if (runs === undefined) return;
  const under = runs.under;
  // A pass with no lock ever taken found no session by that name: what runs does not open it.
  if (d.kind === 'pass' && w.host.locks.length === 0) return;
  const elsewhere = w.host.hostOf().filter((k) => k !== key(under));
  expect({ under: key(under), runsElsewhere: elsewhere }).toEqual({
    under: key(under),
    runsElsewhere: [],
  });
}

async function decideIn(
  w: World,
  req: BackgroundRequest,
  mode: RouteMode = FOLLOW,
): Promise<RouteDecision> {
  const d = await routeBackgroundLaunch(req, w.ctx, mode);
  expectNoSteal(w, d, mode);
  return d;
}

const openUnder = (c: Config): Partial<RouteDecision> => ({
  kind: 'open',
  configDir: c,
  args: ['attach', SHORT],
});

describe('parseBackgroundRequest', () => {
  it('reads attach with one session, and an interactive --resume in every spelling', () => {
    expect(parseBackgroundRequest(['attach', SHORT])).toEqual(attach(SHORT));
    expect(parseBackgroundRequest(['--', 'attach', 'bg eval'])).toEqual(attach('bg eval'));
    expect(parseBackgroundRequest(['--resume', 'bg eval'])).toEqual(resume('bg eval'));
    expect(parseBackgroundRequest(['-r', SID])).toEqual(resume(SID));
    expect(parseBackgroundRequest([`--resume=${SID}`])).toEqual(resume(SID));
    expect(parseBackgroundRequest(['--', '--resume', SID, '--model', 'opus'])).toEqual(resume(SID));
  });

  it('leaves alone what opens no running session: the picker, a copy, a new background start, print mode', () => {
    for (const args of [
      ['--resume'],
      ['--resume', '--model', 'opus'],
      ['--resume', SID, '--fork-session'],
      ['--bg', '--resume', SID],
      ['-p', '--resume', SID, 'hi'],
      ['--continue'],
      ['attach'],
      ['attach', SHORT, 'extra'],
      ['attach', '--help'],
      ['--model', 'opus'],
      [],
      ['agents'],
      ['--resume', '   '],
    ]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: undefined });
    }
  });
});

describe('routeBackgroundLaunch — the session runs where it belongs', () => {
  it('opens it there, by short id, full id or name, and keeps the lock until the terminal shows up', async () => {
    for (const ref of [SHORT, SID, SID.toUpperCase(), 'bg eval', 'eval']) {
      const w = world();
      w.host.runs(X, SID, { name: 'bg eval' });
      const d = await decideIn(w, attach(ref));
      expect(d).toMatchObject(openUnder(X));
      expect(d.kind === 'open' && d.hold?.configDir).toBe(X);
      expect(w.host.locks).toEqual(['take 0']);
      expect(w.host.calls).toEqual([]);
    }
  });

  it('turns a --resume of it into the same attach', async () => {
    const w = world();
    w.host.runs(X);
    expect(await decideIn(w, resume(SID))).toMatchObject(openUnder(X));
  });
});

describe('routeBackgroundLaunch — the session runs on another account', () => {
  it("idle and unwatched: moves it with the daemon's move (stop, resume with its options, confirm), then opens it", async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'bg eval' });
    w.host.saved.set(`main ${SID}`, { kind: 'replayable', options: ['--name=bg eval'] });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([
      'agents main',
      `stop main ${SHORT}`,
      `resume ${X} [--name=bg eval]`,
    ]);
    expect(w.host.hostOf()).toEqual([X]);
    expect(w.lines).toEqual([
      'cctl: moved background session "bg eval" (c5f2097e) from Shared (the global slot) onto ' +
        "Inc (the folder slot of C:/work), the folder's own account. Same session, same conversation.",
    ]);
  });

  it('a stale stopped or failed row where it belongs, saved with the same options, is woken as it is', async () => {
    for (const state of ['stopped', 'failed']) {
      const w = world();
      w.host.runs(MAIN);
      w.host.row(X, state);
      const d = await decideIn(w, attach(SHORT));
      expect(d).toMatchObject(openUnder(X));
      // The row there keeps its own options: none passed, nothing dropped.
      expect(w.host.calls).toEqual(['agents main', `stop main ${SHORT}`, `resume ${X}`]);
    }
  });

  it('--resume by title from the ruled folder, with a failed row there, moves it and opens it', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'bg eval' });
    w.host.row(X, 'failed');
    w.host.titles.set(SID, 'bg eval');
    const d = await decideIn(w, resume('BG Eval '));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.hostOf()).toEqual([X]);
  });

  it('busy or waiting: opens it where it runs, stops nothing, and says it stays there for now', async () => {
    for (const [status, why] of [
      ['busy', 'it is in a turn'],
      ['waiting', 'it is waiting on a prompt'],
      [undefined, 'it is not idle between turns'],
    ] as const) {
      const w = world({}, { daemonRunning: true });
      w.host.runs(MAIN, SID, status === undefined ? {} : { status });
      if (status === undefined) delete w.host.registry[0]!.status;
      w.host.row(X, 'stopped');
      const d = await decideIn(w, attach(SHORT));
      expect(d).toMatchObject(openUnder(MAIN));
      expect(w.host.calls).toEqual([]);
      expect(w.lines).toEqual([
        `cctl: background session c5f2097e stays on Shared (the global slot) for now: ${why}. ` +
          "cctl's daemon moves it onto Inc between turns. Opening it there.",
      ]);
    }
  });

  it('says the daemon moves it only while a daemon runs', async () => {
    const w = world({}, { daemonRunning: false });
    w.host.runs(MAIN, SID, { status: 'busy' });
    await decideIn(w, attach(SHORT));
    expect(w.lines[0]).not.toContain('daemon');
  });

  it('a turn that starts between the look and the stop is never cut off', async () => {
    // The registry said idle; Claude Code says busy at the move's own look, right before the stop.
    const w = world();
    w.host.runs(MAIN);
    w.host.agentsStatus = 'busy';
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual(['agents main']);
    expect(w.lines[0]).toContain(
      'stays on Shared (the global slot) for now: it is not idle between turns',
    );
  });

  it('a terminal on that service holds the move back', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.attachedIn.add('main');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    expect(w.lines[0]).toContain('for now: a terminal has a background session open.');
  });

  it('a move refused for its options leaves it running, opened where it runs, without the daemon promise', async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(MAIN);
    w.host.row(X, 'stopped', SID, {
      saved: { kind: 'replayable', options: ['--permission-mode=plan'] },
    });
    w.host.saved.set(`main ${SID}`, { kind: 'replayable', options: ['--model=opus'] });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual(['agents main']);
    expect(w.lines[0]).toContain(
      'for now: the folder slot of C:/work still holds it from an earlier move, saved with other options.',
    );
    expect(w.lines[0]).not.toContain('daemon');
  });

  it('a move that fails is put back, and the session is opened where it runs again', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.failResumeIn.add(X);
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual([
      'agents main',
      `stop main ${SHORT}`,
      `resume ${X} []`,
      'resume main',
    ]);
    expect(w.host.hostOf()).toEqual(['main']);
    expect(w.lines[0]).toContain('for now: untrusted folder.');
  });

  it('a move whose way back fails too runs nothing, and says how to resume it by hand', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.failResumeIn.add(X);
    w.host.failResumeIn.add('main');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toEqual({
      kind: 'refuse',
      message:
        'could not move c5f2097e onto Inc (the folder slot of C:/work) (untrusted folder), nor resume ' +
        `it on Shared (the global slot). Resume it there with: claude --bg --resume ${SID}`,
    });
    expect(w.host.locks).toEqual(['take 0', 'release']);
  });

  it('a stop Claude Code refuses leaves it where it runs, opened there', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.failStop = true;
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls.some((c) => c.startsWith('resume'))).toBe(false);
  });

  it('where it belongs holds no included account with usage left, or none at all: opened where it runs', async () => {
    const fallback = world({ movable: false });
    fallback.host.runs(MAIN);
    expect(await decideIn(fallback, attach(SHORT))).toMatchObject(openUnder(MAIN));
    expect(fallback.host.calls).toEqual([]);
    expect(fallback.lines[0]).toContain(
      'for now: the folder slot of C:/work does not hold one of its own accounts with usage left.',
    );
    const out = world({
      movable: false,
      unusable: 'C:/work has a folder rule, but no account it may use is usable: all are out',
    });
    out.host.runs(MAIN);
    expect(await decideIn(out, attach(SHORT))).toMatchObject(openUnder(MAIN));
    expect(out.lines[0]).toContain(
      'for now: C:/work has a folder rule, but no account it may use is usable: all are out.',
    );
  });

  it("a session that belongs to the global slot but runs on a removed rule's profile is opened there, not moved", async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(Q, SID, { cwd: OTHER });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(Q));
    expect(w.host.calls).toEqual([]);
    expect(w.lines[0]).toBe(
      'cctl: background session c5f2097e stays on the profile of a folder rule since removed for ' +
        'now: cctl moves background sessions only onto a folder slot. Opening it there.',
    );
  });

  it('moved between the look and the move by someone else: looks again and opens it where it now runs', async () => {
    const w = world();
    w.host.runs(MAIN);
    // After locate's look, the session leaves MAIN for X (another cctl's move, finished).
    let mainReads = 0;
    w.host.beforeList = (c) => {
      if (c !== MAIN) return;
      mainReads++;
      if (mainReads === 2) {
        w.host.hosted.set('main', []);
        w.host.hosted.set(X, [{ sessionId: SID, cwd: WORK }]);
      }
    };
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
  });
});

describe('routeBackgroundLaunch — the session runs in no service', () => {
  it('a stopped row where it belongs: opened there, and Claude Code wakes it with that row', async () => {
    const w = world();
    w.host.row(X, 'stopped');
    w.host.row(MAIN, 'stopped');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([]);
  });

  it('a failed row where it belongs: restarted idle there first, then opened', async () => {
    const w = world();
    w.host.row(X, 'failed');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([`resume ${X}`]);
    expect(w.host.hostOf()).toEqual([X]);
  });

  it('no row where it belongs: started there with what its latest row saved, then opened', async () => {
    const w = world();
    w.host.row(MAIN, 'stopped', SID, {
      updatedAt: '2026-10-09T22:00:00Z',
      saved: { kind: 'replayable', options: ['--name=bg eval', '--model=opus'] },
    });
    w.host.row(Q, 'stopped', SID, {
      updatedAt: '2026-10-08T00:00:00Z',
      saved: { kind: 'replayable', options: ['--model=haiku'] },
    });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([`resume ${X} [--name=bg eval --model=opus]`]);
    expect(w.lines[0]).toContain(
      'started background session c5f2097e on Inc (the folder slot of C:/work)',
    );
  });

  it('no row where it belongs and its options cannot be carried over: opened where its row is', async () => {
    for (const state of ['stopped', 'failed']) {
      const w = world();
      w.host.row(MAIN, state, SID, {
        saved: {
          kind: 'unreplayable',
          reason: 'it was started with --file, which a move does not replay',
        },
      });
      const d = await decideIn(w, attach(SHORT));
      expect(d).toMatchObject(openUnder(MAIN));
      expect(w.host.calls).toEqual(state === 'failed' ? ['resume main'] : []);
      expect(w.lines[0]).toBe(
        'cctl: background session c5f2097e stays on Shared (the global slot): it was started with ' +
          '--file, which a move does not replay. Opening it there.',
      );
    }
  });

  it('no row anywhere: passed through, and Claude Code says so itself', async () => {
    const w = world();
    w.host.titles.set(SID, 'bg eval');
    expect(await decideIn(w, attach(SID))).toEqual({ kind: 'pass' });
    expect(w.host.locks).toEqual([]);
  });

  it('a restart that fails runs nothing and says why', async () => {
    const w = world();
    w.host.row(X, 'failed');
    w.host.failResumeIn.add(X);
    expect(await decideIn(w, attach(SHORT))).toEqual({
      kind: 'refuse',
      message: 'could not start c5f2097e on Inc (the folder slot of C:/work): untrusted folder.',
    });
    expect(w.host.locks).toEqual(['take 0', 'release']);
  });

  it('where it belongs has no usable account: refused with why, nothing started', async () => {
    const w = world({
      movable: false,
      unusable: 'C:/work has a folder rule, but no account it may use is usable: x',
    });
    w.host.row(X, 'stopped');
    expect(await decideIn(w, attach(SHORT))).toEqual({
      kind: 'refuse',
      message: 'C:/work has a folder rule, but no account it may use is usable: x',
    });
  });

  it('--resume runs it in the foreground as Claude Code does, unless the row where it belongs failed', async () => {
    for (const state of [undefined, 'stopped', 'running']) {
      const w = world();
      w.host.titles.set(SID, 'bg eval');
      if (state !== undefined) w.host.row(X, state);
      w.host.row(MAIN, 'failed');
      expect(await decideIn(w, resume(SID))).toEqual({ kind: 'pass' });
      expect(w.host.calls).toEqual([]);
    }
    const failed = world();
    failed.host.row(X, 'failed');
    failed.host.titles.set(SID, 'bg eval');
    const d = await decideIn(failed, resume('bg eval'));
    expect(d).toMatchObject(openUnder(X));
    expect(failed.host.calls).toEqual([`resume ${X}`]);
    expect(failed.lines[0]).toContain('had stopped on an error; started it again on Inc');
  });
});

describe('routeBackgroundLaunch — open in a terminal, unclear, or locked', () => {
  it('open in a terminal: touches nothing, and says where', async () => {
    const w = world();
    w.host.registry.push({ pid: 777, sessionId: SID, kind: 'interactive', cwd: WORK });
    w.host.row(X, 'stopped');
    expect(await decideIn(w, attach(SHORT))).toEqual({
      kind: 'refuse',
      message:
        'c5f2097e is open in a terminal right now (process 777, in C:/work/app); use that ' +
        'terminal, or close the session there first.',
    });
    expect(w.host.calls).toEqual([]);
  });

  it("live in the registry with no service of cctl's claiming it: nothing is run on a guess", async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.hosted.clear();
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject({ kind: 'refuse' });
    expect(d.kind === 'refuse' && d.message).toContain('cannot tell which account');
    expect(w.host.calls).toEqual([]);
  });

  it('waits for another cctl process moving it, then decides on what that left', async () => {
    const w = world();
    w.host.runs(X);
    w.host.lockedFor = 1;
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.locks).toEqual(['take 90000']);
    expect(w.lines).toEqual([
      'cctl: another cctl process is moving c5f2097e; waiting for it to finish.',
    ]);
  });

  it('refuses when that process never lets go', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.lockedFor = Infinity;
    expect(await decideIn(w, attach(SHORT))).toEqual({
      kind: 'refuse',
      message: 'another cctl process is still moving c5f2097e; try again in a moment.',
    });
    expect(w.host.calls).toEqual([]);
  });
});

describe('routeBackgroundLaunch — which session a name means', () => {
  it('a short id or a job id, before any name', async () => {
    const w = world();
    w.host.runs(X);
    w.host.registry[0]!.name = SHORT;
    expect(await decideIn(w, attach(SHORT))).toMatchObject(openUnder(X));
  });

  it('an attach name matching two sessions is refused with their short ids', async () => {
    const w = world();
    w.host.runs(X, SID, { name: 'bg eval' });
    w.host.row(MAIN, 'stopped', SID2, { name: 'bg eval two' });
    // "eval" is part of both names; "bg eval" is one whole name and wins.
    expect(await decideIn(w, attach('bg eval'))).toMatchObject(openUnder(X));
    expect(await decideIn(w, attach('eval'))).toEqual({
      kind: 'refuse',
      message:
        '"eval" names more than one background session (c5f2097e "bg eval", 0dff6248 "bg eval ' +
        'two"); name one by its id.',
    });
  });

  it("a --resume title is looked up among this folder's sessions only, and two matches are refused", async () => {
    const elsewhere = world();
    elsewhere.host.runs(MAIN, SID, { cwd: OTHER });
    elsewhere.host.titles.set(SID, 'bg eval');
    expect(await decideIn(elsewhere, resume('bg eval'))).toEqual({ kind: 'pass' });
    expect(elsewhere.host.calls).toEqual([]);

    const two = world();
    two.host.runs(MAIN, SID, { status: 'busy' });
    two.host.row(X, 'failed', SID2);
    two.host.titles.set(SID, 'bg eval');
    two.host.titles.set(SID2, 'bg eval');
    expect(await decideIn(two, resume('bg eval'))).toEqual({
      kind: 'refuse',
      message: `"bg eval" names more than one background session (${SID}, ${SID2}); name one by its id.`,
    });
  });

  it("a --resume title matches the conversation's title, never a job row's name", async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'ok', status: 'busy' });
    w.host.titles.set(SID, 'bg eval');
    expect(await decideIn(w, resume('ok'))).toEqual({ kind: 'pass' });
    expect(await decideIn(w, resume('bg eval'))).toMatchObject(openUnder(MAIN));
  });

  it('a --resume of an 8-digit id is a title, as Claude Code reads it: unknown, so passed through', async () => {
    const w = world();
    w.host.runs(MAIN);
    expect(await decideIn(w, resume(SHORT))).toEqual({ kind: 'pass' });
  });

  it('an unknown name or id is passed through untouched, and no lock is taken', async () => {
    const w = world();
    w.host.runs(MAIN);
    for (const req of [attach('nope'), attach('deadbeef'), resume(SID2)]) {
      expect(await decideIn(w, req)).toEqual({ kind: 'pass' });
    }
    expect(w.host.locks).toEqual([]);
  });
});

describe('routeBackgroundLaunch — a slot chosen with --account or --override', () => {
  it('never moves the session, and opens it where it runs when that is not the chosen slot', async () => {
    const w = world();
    w.host.runs(X);
    const fixed: RouteMode = { kind: 'fixed', configDir: MAIN };
    w.host.row(MAIN, 'stopped');
    const d = await decideIn(w, attach(SHORT), fixed);
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([]);
    expect(w.lines).toEqual([
      'cctl: background session c5f2097e runs on Inc (the folder slot of C:/work); opening it there.',
    ]);
  });

  it("runs the operator's own arguments where it runs, keeping the lock until the terminal shows up", async () => {
    const w = world();
    w.host.runs(MAIN);
    const fixed: RouteMode = { kind: 'fixed', configDir: MAIN };
    const d = await decideIn(w, attach(SHORT), fixed);
    expect(d).toMatchObject({ kind: 'pass', hold: { configDir: MAIN } });
    expect(w.host.locks).toEqual(['take 0']);
  });

  it('a session running nowhere is opened as asked, and the lock let go', async () => {
    const w = world();
    w.host.row(X, 'failed');
    const d = await decideIn(w, attach(SHORT), { kind: 'fixed', configDir: MAIN });
    expect(d).toEqual({ kind: 'pass' });
    expect(w.host.locks).toEqual(['take 0', 'release']);
    expect(w.host.calls).toEqual([]);
  });
});

describe('the steal property, over every arrangement', () => {
  it('no arrangement of where it runs, its rows, its status and the slot ever opens it under another service', async () => {
    // Where it runs; undefined is nowhere.
    const places: Array<Config | undefined> = [MAIN, X, Q, undefined];
    const rowStates = [undefined, 'stopped', 'failed', 'running'];
    const statuses = ['idle', 'busy', 'waiting'];
    let checked = 0;
    for (const place of places) {
      for (const rowX of rowStates) {
        for (const rowMain of rowStates) {
          for (const status of statuses) {
            for (const movable of [true, false]) {
              for (const attachedThere of [false, true]) {
                for (const failMove of [false, true]) {
                  for (const req of [attach(SHORT), resume(SID), attach(SID)]) {
                    for (const mode of [FOLLOW, { kind: 'fixed', configDir: MAIN } as RouteMode]) {
                      const w = world({ movable });
                      if (place !== undefined) w.host.runs(place, SID, { status });
                      if (rowX !== undefined) w.host.row(X, place === X ? 'running' : rowX);
                      if (rowMain !== undefined)
                        w.host.row(MAIN, place === MAIN ? 'running' : rowMain);
                      if (attachedThere && place !== undefined) w.host.attachedIn.add(key(place));
                      if (failMove) w.host.failResumeIn.add(X);
                      w.host.titles.set(SID, 'bg eval');
                      await decideIn(w, req, mode);
                      checked++;
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
    expect(checked).toBe(4 * 4 * 4 * 3 * 2 * 2 * 2 * 3 * 2);
  });
});

describe('runHolding', () => {
  function lock(): { release(): void; released: () => number } {
    let n = 0;
    return { release: () => void n++, released: () => n };
  }

  it('lets go of the lock once the terminal shows up in the attach journal, while it still runs', async () => {
    const l = lock();
    let attached = false;
    let releasedWhileRunning = -1;
    const code = await runHolding(
      { attachedNow: () => Promise.resolve(attached) },
      { lock: l, configDir: X },
      async () => {
        attached = true;
        for (let i = 0; i < 50 && l.released() === 0; i++)
          await new Promise((r) => setTimeout(r, 1));
        releasedWhileRunning = l.released();
        return 7;
      },
      { sleep: () => new Promise((r) => setTimeout(r, 1)) },
    );
    expect(code).toBe(7);
    expect(releasedWhileRunning).toBe(1);
    expect(l.released()).toBe(1);
  });

  it('lets go when the terminal exits, when it fails to start, or once the cap passes', async () => {
    const exited = lock();
    await runHolding(
      { attachedNow: () => Promise.resolve(false) },
      { lock: exited, configDir: X },
      () => Promise.resolve(0),
    );
    expect(exited.released()).toBe(1);

    const failed = lock();
    await expect(
      runHolding(
        { attachedNow: () => Promise.resolve(false) },
        { lock: failed, configDir: X },
        () => Promise.reject(new Error('no claude')),
      ),
    ).rejects.toThrow('no claude');
    expect(failed.released()).toBe(1);

    const capped = lock();
    let now = 0;
    let releasedEarly = 0;
    await runHolding(
      { attachedNow: () => Promise.resolve(false) },
      { lock: capped, configDir: X },
      async () => {
        for (let i = 0; i < 100 && capped.released() === 0; i++)
          await new Promise((r) => setTimeout(r, 1));
        releasedEarly = capped.released();
        return 0;
      },
      {
        clock: () => now,
        sleep: (ms) => {
          now += ms;
          return new Promise((r) => setTimeout(r, 1));
        },
        capMs: 1_000,
      },
    );
    expect(releasedEarly).toBe(1);
  });

  it('with nothing held, just runs', async () => {
    expect(
      await runHolding({ attachedNow: () => Promise.reject(new Error('unread')) }, undefined, () =>
        Promise.resolve(3),
      ),
    ).toBe(3);
  });
});
