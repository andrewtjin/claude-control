// The routing of `cctl claude` arguments that reach a background session, against a fake Claude
// Code that models several config dirs the way the real one was measured to behave (one service per
// config dir, a job row per config dir, one shared registry, /clear moving a job onto a new
// conversation): where the session is found, where it belongs, what is run, what is moved (through
// the daemon's own move), which rows are left, and above all that nothing is ever run under a config
// dir that could reach the session through a row there while it runs as a background session in
// another — the steal, which kills it mid-turn. The real commands are covered in
// backgroundHost.test.ts, and the two together against a fake binary in
// backgroundAttach.integration.test.ts.

import { describe, expect, it } from 'vitest';
import type {
  JobRow,
  LiveSession,
  RowRead,
  SavedLaunch,
  SessionActivity,
} from '@claude-control/daemon';
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
import type { ClaudeBackgroundHost } from './backgroundHost.js';

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

interface FakeRow {
  sessionId: string;
  resumeSessionId?: string;
  state: string;
  name?: string;
  cwd: string;
  updatedAt: string;
  worktreePath?: string;
  pending?: boolean;
  saved: SavedLaunch;
}

/** A Claude Code with services in MAIN, X (the folder's profile) and Q (a removed rule's profile).
 *  Commands behave like the real ones: a stop removes the session from its service and the registry
 *  and leaves its row stopped (a failed one failed); a resume while it runs anywhere starts a copy
 *  (refused here); a resume with options over a row is refused; a resume wakes the row (a new one
 *  saved with the options given); `rm` removes a row, refusing one with a worktree or of a live
 *  session. Every command and every copy is recorded. */
class FakeClaude implements ClaudeBackgroundHost {
  readonly calls: string[] = [];
  /** Resumes run while the session ran as a background session somewhere: copies. */
  readonly copies: string[] = [];
  /** `rm` asked of a row recording a worktree, or of a live session: never done by cctl. */
  readonly badRemovals: string[] = [];
  /** Who hosts what, by config dir. */
  readonly hosted = new Map<string, Array<{ short: string; sessionId: string; cwd: string }>>();
  readonly registry: LiveSession[] = [];
  readonly rows = new Map<string, Map<string, FakeRow>>();
  readonly titles = new Map<string, string>();
  /** Titles of conversations no background session has: what `titlesIn` finds. */
  readonly plainTitles = new Map<string, string>();
  readonly attachedIn = new Set<string>();
  readonly attachedPids = new Map<string, number[]>();
  readonly failResumeIn = new Set<string>();
  /** Config dirs whose resume is accepted but never shows up. */
  readonly silentResumeIn = new Set<string>();
  readonly failRemoveIn = new Set<string>();
  /** The status `claude agents` reports at the move's own look, when it differs from the registry's
   *  (a turn starting in between). */
  agentsStatus: string | undefined;
  failStop = false;
  /** How many lock takes another process wins before letting go (Infinity: never). */
  lockedFor = 0;
  readonly locks: string[] = [];
  /** Runs before a roster read, by config dir (to move the session between two looks). */
  beforeList: ((c: Config) => void) | undefined;
  /** Runs before every registry read, with its count so far. */
  beforeRegistry: ((n: number) => void) | undefined;
  registryReads = 0;
  failRegistry = 0;

  /** The session runs as a background session in `c`, with a row there in state running. */
  runs(
    c: Config,
    sessionId = SID,
    opts: {
      status?: string;
      cwd?: string;
      name?: string;
      saved?: SavedLaunch;
      current?: string;
      worktreePath?: string;
      pending?: boolean;
    } = {},
  ): void {
    const cwd = opts.cwd ?? WORK;
    const short = sessionId.slice(0, 8);
    this.hosted.set(key(c), [...(this.hosted.get(key(c)) ?? []), { short, sessionId, cwd }]);
    this.registry.push({
      pid: 4000 + this.registry.length,
      sessionId: opts.current ?? sessionId,
      kind: 'bg',
      ...(opts.status !== undefined ? { status: opts.status } : { status: 'idle' }),
      jobId: short,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      cwd,
    });
    this.row(c, 'running', sessionId, {
      cwd,
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.saved !== undefined ? { saved: opts.saved } : {}),
      ...(opts.current !== undefined ? { resumeSessionId: opts.current } : {}),
      ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
      ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
    });
  }

  /** A row for the session in `c`. */
  row(
    c: Config,
    state: string,
    sessionId = SID,
    opts: Partial<Omit<FakeRow, 'state' | 'sessionId'>> = {},
  ): void {
    const rows = this.rows.get(key(c)) ?? new Map<string, FakeRow>();
    rows.set(sessionId.slice(0, 8), {
      sessionId,
      state,
      cwd: opts.cwd ?? WORK,
      updatedAt: opts.updatedAt ?? '2026-10-09T22:00:00.000Z',
      saved: opts.saved ?? { kind: 'replayable', options: [] },
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.worktreePath !== undefined ? { worktreePath: opts.worktreePath } : {}),
      ...(opts.pending !== undefined ? { pending: opts.pending } : {}),
    });
    this.rows.set(key(c), rows);
  }

  /** Where the session runs as a background session right now. */
  hostOf(sessionId = SID): string[] {
    return [...this.hosted.entries()]
      .filter(([, list]) =>
        list.some((s) => s.sessionId === sessionId || s.short === sessionId.slice(0, 8)),
      )
      .map(([k]) => k);
  }

  /** Every config dir holding a row of the session (by the id it started with or runs now). */
  rowsOf(sessionId = SID): string[] {
    return [...this.rows.entries()]
      .filter(([, rows]) =>
        [...rows.values()].some(
          (r) => r.sessionId === sessionId || r.resumeSessionId === sessionId,
        ),
      )
      .map(([k]) => k);
  }

  private toJobRow(short: string, r: FakeRow): JobRow {
    return {
      short,
      sessionId: r.sessionId,
      state: r.state,
      cwd: r.cwd,
      updatedAt: r.updatedAt,
      pending: r.pending === true,
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.resumeSessionId !== undefined ? { resumeSessionId: r.resumeSessionId } : {}),
      ...(r.worktreePath !== undefined ? { worktreePath: r.worktreePath } : {}),
    };
  }

  configDirs(): Promise<Config[]> {
    return Promise.resolve([MAIN, X, Q]);
  }
  liveSessions(): Promise<LiveSession[]> {
    this.beforeRegistry?.(++this.registryReads);
    if (this.failRegistry > 0) {
      this.failRegistry--;
      return Promise.reject(new Error('a live session registry entry could not be read right now'));
    }
    return Promise.resolve([...this.registry]);
  }
  jobRows(c: Config): Promise<JobRow[]> {
    return Promise.resolve(
      [...(this.rows.get(key(c)) ?? new Map<string, FakeRow>())].map(([short, r]) =>
        this.toJobRow(short, r),
      ),
    );
  }
  jobRow(c: Config, short: string): Promise<RowRead> {
    const r = this.rows.get(key(c))?.get(short);
    return Promise.resolve(
      r === undefined ? { kind: 'none' } : { kind: 'row', row: this.toJobRow(short, r) },
    );
  }
  sessionTitle(sessionId: string): Promise<string | undefined> {
    return Promise.resolve(this.titles.get(sessionId));
  }
  titlesIn(): Promise<Map<string, string>> {
    return Promise.resolve(new Map([...this.titles, ...this.plainTitles]));
  }
  listHosted(c: Config): Promise<Array<{ short: string; sessionId: string; cwd: string }>> {
    this.beforeList?.(c);
    return Promise.resolve([...(this.hosted.get(key(c)) ?? [])]);
  }
  activity(c: Config): Promise<Map<string, SessionActivity>> {
    this.calls.push(`agents ${key(c)}`);
    const out = new Map<string, SessionActivity>();
    for (const [short, row] of this.rows.get(key(c)) ?? []) {
      const entry = this.registry.find((e) => e.jobId === short);
      const status = this.agentsStatus ?? entry?.status;
      out.set(short, { idle: status === 'idle', ...(row.name ? { name: row.name } : {}) });
    }
    return Promise.resolve(out);
  }
  attachedNow(c: Config): Promise<boolean> {
    return Promise.resolve(this.attachedIn.has(key(c)));
  }
  attachedBy(c: Config, pid: number): Promise<boolean> {
    return Promise.resolve((this.attachedPids.get(key(c)) ?? []).includes(pid));
  }
  stop(c: Config, short: string): Promise<void> {
    this.calls.push(`stop ${key(c)} ${short}`);
    if (this.failStop) return Promise.reject(new Error('claude stop exited 1: refused'));
    const gone = (this.hosted.get(key(c)) ?? []).find((s) => s.short === short);
    this.hosted.set(
      key(c),
      (this.hosted.get(key(c)) ?? []).filter((s) => s.short !== short),
    );
    if (gone !== undefined) {
      const i = this.registry.findIndex((e) => e.jobId === short);
      if (i >= 0) this.registry.splice(i, 1);
    }
    const row = this.rows.get(key(c))?.get(short);
    if (row !== undefined && row.state !== 'failed') row.state = 'stopped';
    return Promise.resolve();
  }
  savedOptions(c: Config, short: string): Promise<SavedLaunch> {
    const row = this.rows.get(key(c))?.get(short);
    return Promise.resolve(row === undefined ? { kind: 'none' } : row.saved);
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
    if (running.length > 0 || this.registry.some((e) => e.sessionId === input.sessionId)) {
      this.copies.push(`resume under ${key(c)} while it ran in ${running.join(', ')}`);
      return Promise.reject(new Error('claude started a copy (5e1d04b2) instead of resuming it'));
    }
    const existing = this.rows.get(key(c))?.get(input.short);
    if (input.options !== undefined && existing !== undefined) {
      return Promise.reject(new Error('that config dir already holds a job row for it'));
    }
    if (this.failResumeIn.has(key(c))) return Promise.reject(new Error('untrusted folder'));
    if (existing === undefined) {
      this.row(c, 'running', input.sessionId, {
        cwd: input.cwd,
        saved: { kind: 'replayable', options: input.options ?? [] },
      });
    } else {
      existing.state = 'running';
    }
    if (this.silentResumeIn.has(key(c))) return Promise.resolve();
    this.hosted.set(key(c), [
      ...(this.hosted.get(key(c)) ?? []),
      { short: input.short, sessionId: input.sessionId, cwd: input.cwd },
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
  removeRow(c: Config, short: string): Promise<void> {
    this.calls.push(`rm ${key(c)} ${short}`);
    const row = this.rows.get(key(c))?.get(short);
    if (row === undefined) return Promise.resolve();
    if (row.worktreePath !== undefined) {
      this.badRemovals.push(`worktree row ${key(c)} ${short}`);
      return Promise.reject(new Error('its job row records a git worktree'));
    }
    const ids = [row.sessionId, row.resumeSessionId];
    const live =
      row.state === 'starting' ||
      this.registry.some(
        (e) => e.kind === 'bg' && (e.jobId === short || ids.includes(e.sessionId)),
      ) ||
      [...this.hosted.values()].flat().some((w) => w.short === short || ids.includes(w.sessionId));
    if (live) {
      this.badRemovals.push(`live session ${key(c)} ${short}`);
      return Promise.reject(new Error('its session is live'));
    }
    if (this.failRemoveIn.has(key(c))) return Promise.reject(new Error('rm refused'));
    this.rows.get(key(c))!.delete(short);
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
  resumeHint(c: Config, sessionId: string, options: readonly string[]): string {
    return (
      (c === null ? '' : `CLAUDE_CONFIG_DIR=${c} `) +
      ['claude', '--bg', '--resume', sessionId, ...options].join(' ')
    );
  }
  configEnv(c: Config): string | undefined {
    return c ?? undefined;
  }
}

interface World {
  host: FakeClaude;
  ctx: RouteContext;
  lines: string[];
  home: SessionHome;
  /** How many times the move shield ran. */
  shields: { n: number };
}

/** A world where C:/work belongs to the rule whose profile is X, and anything else to MAIN. */
function world(
  home: Partial<SessionHome> = {},
  opts: { daemonRunning?: boolean; cwd?: string; worktrees?: string[] } = {},
): World {
  const host = new FakeClaude();
  const lines: string[] = [];
  const shields = { n: 0 };
  const homeX: SessionHome = { configDir: X, movable: true, ...home };
  const views: Record<string, { account?: string; slot: string; removed?: boolean }> = {
    main: { account: 'Shared', slot: 'the global slot' },
    [X]: { account: 'Inc', slot: 'the folder slot of C:/work' },
    [Q]: { slot: 'the profile of a folder rule since removed', removed: true },
  };
  const ruled = (cwd: string): boolean => cwd.toLowerCase().startsWith('c:/work');
  const ctx: RouteContext = {
    host,
    cwd: opts.cwd ?? WORK,
    platform: 'win32',
    sameFolder: (a, b) => a.toLowerCase() === b.toLowerCase(),
    titleFolders: (cwd) => Promise.resolve([cwd, ...(opts.worktrees ?? [])]),
    homeOf: (cwd) => Promise.resolve(ruled(cwd) ? homeX : { configDir: null, movable: false }),
    launchConfigDir: () => Promise.resolve(ruled(opts.cwd ?? WORK) ? X : null),
    view: (c) => Promise.resolve(views[key(c)]!),
    daemonRunning: opts.daemonRunning ?? false,
    say: (line) => lines.push(line),
    shield: (fn) => {
      shields.n++;
      return fn();
    },
    lockWaitMs: 90_000,
    timing: {
      clock: () => 0,
      confirmTimeoutMs: 0,
      sleep: () => Promise.resolve(),
      logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
    },
  };
  return { host, ctx, lines, home: homeX, shields };
}

const attach = (ref: string): BackgroundRequest => ({
  verb: 'attach',
  ref,
  args: ['attach', ref],
  refAt: 1,
});
const resume = (ref: string, rest: string[] = []): BackgroundRequest => ({
  verb: 'resume',
  ref,
  rest,
});
const control = (cmd: string, ref: string): BackgroundRequest => ({
  verb: 'control',
  ref,
  args: [cmd, ref],
  refAt: 1,
});
const GUARD: BackgroundRequest = { verb: 'guard' };
const FOLLOW: RouteMode = { kind: 'follow' };

/** The config dir what a decision runs is run under: an open's own; a pass runs on the launch's
 *  slot (the caller's folder's in follow mode, the chosen one in fixed mode). */
async function runsUnder(w: World, d: RouteDecision, mode: RouteMode): Promise<Config | undefined> {
  if (d.kind === 'refuse') return undefined;
  if (d.kind === 'open') return d.configDir;
  return mode.kind === 'fixed' ? mode.configDir : w.ctx.launchConfigDir();
}

/**
 * THE property, on the state a decision leaves (the state Claude Code meets when it runs): nothing
 * is run under a config dir that holds a row of the session while it runs as a background session
 * in another; an open of it is run where it runs; no resume started a copy; no row recording a
 * worktree, or of a live session, was ever removed; and once moved, the session has a row only where
 * it runs.
 */
async function expectNoSteal(w: World, d: RouteDecision, mode: RouteMode = FOLLOW): Promise<void> {
  expect(w.host.copies).toEqual([]);
  expect(w.host.badRemovals).toEqual([]);
  const under = await runsUnder(w, d, mode);
  const live = w.host.hostOf();
  if (under !== undefined) {
    const elsewhere = live.filter((k) => k !== key(under));
    if (d.kind === 'open' && live.length > 0) {
      expect({ opens: key(under), runs: live }).toEqual({ opens: live[0], runs: live });
    }
    if (w.host.rowsOf().includes(key(under))) {
      expect({ under: key(under), runsElsewhere: elsewhere }).toEqual({
        under: key(under),
        runsElsewhere: [],
      });
    }
  }
  // Moved, or put back, with every row removal done: a row only where it runs.
  const moved =
    w.host.calls.some((c) => c.startsWith('rm ')) &&
    w.host.calls.some((c) => c.startsWith('resume'));
  if (moved && live.length === 1 && w.host.failRemoveIn.size === 0) {
    expect(w.host.rowsOf()).toEqual(live);
  }
}

async function decideIn(
  w: World,
  req: BackgroundRequest,
  mode: RouteMode = FOLLOW,
): Promise<RouteDecision> {
  const d = await routeBackgroundLaunch(req, w.ctx, mode);
  await expectNoSteal(w, d, mode);
  return d;
}

const openUnder = (c: Config, short = SHORT): Partial<RouteDecision> => ({
  kind: 'open',
  configDir: c,
  args: ['attach', short],
});

describe('parseBackgroundRequest', () => {
  it('reads attach with one session, flags before or after, and an interactive --resume in every spelling', () => {
    expect(parseBackgroundRequest(['attach', SHORT])).toEqual(attach(SHORT));
    expect(parseBackgroundRequest(['--', 'attach', 'bg eval'])).toEqual(attach('bg eval'));
    expect(parseBackgroundRequest(['--verbose', 'attach', SHORT])).toEqual({
      verb: 'attach',
      ref: SHORT,
      args: ['--verbose', 'attach', SHORT],
      refAt: 2,
    });
    expect(parseBackgroundRequest(['attach', '--verbose', 'c5f2'])).toEqual({
      verb: 'attach',
      ref: 'c5f2',
      args: ['attach', '--verbose', 'c5f2'],
      refAt: 2,
    });
    expect(parseBackgroundRequest(['--resume', 'bg eval'])).toEqual(resume('bg eval'));
    expect(parseBackgroundRequest(['-r', SID])).toEqual(resume(SID));
    expect(parseBackgroundRequest([`--resume=${SID}`])).toEqual(resume(SID));
    expect(parseBackgroundRequest(['--', '--resume', SID, '--model', 'opus'])).toEqual(
      resume(SID, ['--model', 'opus']),
    );
  });

  it('keeps a prompt given after --resume <session>', () => {
    expect(parseBackgroundRequest(['--resume', SID, 'carry on with step 2'])).toEqual(
      resume(SID, ['carry on with step 2']),
    );
  });

  it('reads stop, kill, rm and respawn of one session, wherever the word stands', () => {
    expect(parseBackgroundRequest(['stop', SHORT])).toEqual(control('stop', SHORT));
    expect(parseBackgroundRequest(['rm', 'c5f2'])).toEqual(control('rm', 'c5f2'));
    expect(parseBackgroundRequest(['--model', 'opus', 'kill', SHORT])).toEqual({
      verb: 'control',
      ref: SHORT,
      args: ['--model', 'opus', 'kill', SHORT],
      refAt: 3,
    });
    expect(parseBackgroundRequest(['respawn', SHORT])).toEqual(control('respawn', SHORT));
  });

  it("checks Claude Code's own lists before passing them on: the picker, --continue, the agents view, a respawn of all", () => {
    for (const args of [
      ['--resume'],
      ['--resume', '--model', 'opus'],
      ['-r'],
      ['--resume='],
      ['--continue'],
      ['-c'],
      ['agents'],
      ['respawn'],
      ['attach'],
      ['attach', '--help'],
    ]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: GUARD });
    }
    expect(parseBackgroundRequest(['-p', '--resume', SID, 'hi'])).toEqual({
      verb: 'guard',
      ref: SID,
    });
  });

  it('leaves alone only what is positively a plain new session, a new background start or a copy', () => {
    for (const args of [
      ['--resume', SID, '--fork-session'],
      ['--continue', '--fork-session'],
      ['--bg', '--resume', SID],
      ['--bg', `-r${SID}`],
      ['--background', '--resume', SID],
      ['--bg', 'attach', '--help'],
      ['--model', 'opus'],
      ['--model', 'opus', 'hello'],
      ['-p', 'what is in this folder'],
      ['-n', 'my session', 'do it'],
      ['-w', 'feature', 'start here'],
      ['-d'],
      [],
    ]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: undefined });
    }
  });

  it('reads a resume in every spelling Claude Code takes: -r<id>, -r <id>, -pr <id>, --resume <id>, --resume=<id>', () => {
    expect(parseBackgroundRequest([`-r${SID}`])).toEqual(resume(SID));
    expect(parseBackgroundRequest([`-r${SID}`, 'carry on'])).toEqual(resume(SID, ['carry on']));
    // Measured: Claude Code peels -p off the front of -pr, and decides print mode on the word -p
    // alone, so -pr <id> "<prompt>" is an interactive resume with that prompt.
    expect(parseBackgroundRequest(['-pr', SID, 'hi'])).toEqual(resume(SID, ['hi']));
    expect(parseBackgroundRequest([`-pr${SID}`])).toEqual(resume(SID));
    // -r=<id> searches for "=<id>" in Claude Code's picker: a term, as cctl reads it too.
    expect(parseBackgroundRequest([`-r=${SID}`])).toEqual(resume(`=${SID}`));
    expect(parseBackgroundRequest(['--model', 'opus', '-r', SID])).toEqual(
      resume(SID, ['--model', 'opus']),
    );
    // The value Claude Code takes for -r is the rest of its cluster, whatever it is.
    expect(parseBackgroundRequest(['-rc'])).toEqual(resume('c'));
    // The last resume given is the one Claude Code takes.
    expect(parseBackgroundRequest(['--resume', SID2, `--resume=${SID}`])).toEqual(resume(SID));
  });

  it('a cluster that continues is a continue, as Claude Code runs it; print mode is the word -p', () => {
    // Measured: -cr <id>, -cr<id> and -cpr <id> continue the latest conversation, whatever id follows.
    for (const args of [['-cr', SID], [`-cr${SID}`], ['-cpr', SID, 'hi'], ['-pc'], ['-c']]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: GUARD });
    }
    expect(parseBackgroundRequest(['-p', '-r', SID, 'hi'])).toEqual({ verb: 'guard', ref: SID });
    expect(parseBackgroundRequest(['--print', `-r${SID}`])).toEqual({ verb: 'guard', ref: SID });
  });

  it('checks anything that could reach a row, however it is spelled, before passing it on', () => {
    for (const args of [
      ['agents', '--json'],
      ['logs', SHORT],
      ['stop'],
      ['daemon', 'stop', '--any'],
      ['--from-pr', '12'],
      ['--from-pr=12'],
      // A short option Claude Code reads as -d with the value "r": still a cluster with r in it.
      ['-dr', SID],
      // A resume behind -v or -h: Claude Code may print its version or help instead.
      ['-vr', SID],
      ['hi', '--', '-r', SID],
    ]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: GUARD });
    }
  });
});

describe('routeBackgroundLaunch — arguments in any spelling, with a trap row on the slot', () => {
  it('a resume spelled -r<id> or -pr <id> is routed like --resume <id>: opened where it runs, never passed under the trap row', async () => {
    for (const args of [[`-r${SID}`], ['-pr', SID, 'carry on']]) {
      const w = world();
      w.host.runs(MAIN, SID, { status: 'busy' });
      w.host.row(X, 'stopped');
      const d = await decideIn(w, parseBackgroundRequest(args)!);
      expect(d).toMatchObject({ kind: 'open', configDir: MAIN });
    }
  });

  it('anything cctl cannot tell is a plain new session is refused while the slot holds a trap row', async () => {
    for (const args of [
      ['-cr', SID],
      ['-vr', SID],
      ['logs', SHORT],
      ['agents', '--json'],
    ]) {
      const w = world();
      w.host.runs(MAIN, SID, { status: 'busy' });
      w.host.row(X, 'stopped');
      const d = await decideIn(w, parseBackgroundRequest(args)!);
      expect({ args, d }).toMatchObject({ args, d: { kind: 'refuse' } });
    }
  });
});

describe('routeBackgroundLaunch — the session runs where it belongs', () => {
  it('opens it there, by short id, any prefix of it, full id or name, and keeps the lock until the terminal shows up', async () => {
    for (const ref of [SHORT, 'c5f2', 'c', SID, SID.toUpperCase(), 'bg eval', 'eval']) {
      const w = world();
      w.host.runs(X, SID, { name: 'bg eval' });
      const d = await decideIn(w, attach(ref));
      expect(d).toMatchObject(openUnder(X));
      expect(d.kind === 'open' && d.hold?.configDir).toBe(X);
      expect(w.host.locks).toEqual(['take 0']);
      expect(w.host.calls).toEqual([]);
    }
  });

  it('keeps the operator words around attach', async () => {
    const w = world();
    w.host.runs(X);
    const req = parseBackgroundRequest(['--verbose', 'attach', 'c5f2'])!;
    expect(await decideIn(w, req)).toMatchObject({
      kind: 'open',
      configDir: X,
      args: ['--verbose', 'attach', SHORT],
    });
  });

  it('turns a --resume of it into the same attach', async () => {
    const w = world();
    w.host.runs(X);
    expect(await decideIn(w, resume(SID))).toMatchObject(openUnder(X));
  });

  it('a prompt after --resume <id> is sent to the session where it runs, by its conversation id', async () => {
    const w = world();
    w.host.runs(X);
    expect(await decideIn(w, resume(SID, ['carry on with step 2']))).toMatchObject({
      kind: 'open',
      configDir: X,
      args: ['--resume', SID, 'carry on with step 2'],
    });
  });
});

describe('routeBackgroundLaunch — the session runs on another account', () => {
  it("idle and unwatched: says so first, moves it with the daemon's move, leaves a row only where it runs, then opens it", async () => {
    const w = world();
    w.host.runs(MAIN, SID, {
      name: 'bg eval',
      saved: { kind: 'replayable', options: ['--name=bg eval'] },
    });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([
      'agents main',
      `stop main ${SHORT}`,
      `rm main ${SHORT}`,
      `resume ${X} [--name=bg eval]`,
    ]);
    expect(w.host.hostOf()).toEqual([X]);
    expect(w.host.rowsOf()).toEqual([X]);
    expect(w.shields.n).toBe(1);
    expect(w.lines).toEqual([
      'cctl: moving background session "bg eval" (c5f2097e) from Shared (the global slot) onto ' +
        'Inc (the folder slot of C:/work); Ctrl-C waits until it has finished.',
      'cctl: moved background session "bg eval" (c5f2097e) onto ' +
        "Inc (the folder slot of C:/work), the folder's own account. Same session, same conversation.",
    ]);
  });

  it('a stale stopped or failed row where it belongs goes too: the session comes back with its own options', async () => {
    for (const state of ['stopped', 'failed']) {
      const w = world();
      w.host.runs(MAIN, SID, {
        saved: { kind: 'replayable', options: ['--disallowedTools=Bash'] },
      });
      w.host.row(X, state);
      const d = await decideIn(w, attach(SHORT));
      expect(d).toMatchObject(openUnder(X));
      expect(w.host.calls).toEqual([
        'agents main',
        `stop main ${SHORT}`,
        `rm main ${SHORT}`,
        `rm ${X} ${SHORT}`,
        `resume ${X} [--disallowedTools=Bash]`,
      ]);
      expect(w.host.rowsOf()).toEqual([X]);
    }
  });

  it('a prompt after --resume <id> of a session it moves is sent to it on the folder slot', async () => {
    const w = world();
    w.host.runs(MAIN);
    expect(await decideIn(w, resume(SID, ['carry on']))).toMatchObject({
      kind: 'open',
      configDir: X,
      args: ['--resume', SID, 'carry on'],
    });
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

  it('a session holding a scheduled wakeup is not moved, though it reports idle', async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(MAIN, SID, { pending: true });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
    // Nothing was moved, so nothing said it would be.
    expect(w.lines).toEqual([
      'cctl: background session c5f2097e stays on Shared (the global slot) for now: it holds ' +
        "work between turns (a scheduled wakeup or a background task). cctl's daemon moves it " +
        'onto Inc between turns. Opening it there.',
    ]);
  });

  it('a session in a git worktree Claude Code made for it is opened where it runs, never moved', async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(MAIN, SID, { worktreePath: 'C:/work/app/.claude/worktrees/feat' });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual([]);
    expect(w.lines[0]).toBe(
      'cctl: background session c5f2097e stays on Shared (the global slot) for now: it works in a ' +
        'git worktree Claude Code made for it, which a move would delete. Opening it there.',
    );
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
    expect(w.lines.at(-1)).toContain(
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
    expect(w.lines.at(-1)).toContain('for now: a terminal has a background session open.');
  });

  it('a move refused for its options leaves it running, opened where it runs, without the daemon promise', async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(MAIN, SID, {
      saved: {
        kind: 'unreplayable',
        reason: 'it was started with --file, which a move does not replay',
      },
    });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual(['agents main']);
    expect(w.lines.at(-1)).toContain(
      'for now: it was started with --file, which a move does not replay.',
    );
    expect(w.lines.at(-1)).not.toContain('daemon');
  });

  it('a move that fails is put back with its options, and the session is opened where it runs again', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { saved: { kind: 'replayable', options: ['--model=opus'] } });
    w.host.failResumeIn.add(X);
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual([
      'agents main',
      `stop main ${SHORT}`,
      `rm main ${SHORT}`,
      `resume ${X} [--model=opus]`,
      'resume main [--model=opus]',
    ]);
    expect(w.host.hostOf()).toEqual(['main']);
    expect(w.host.rowsOf()).toEqual(['main']);
    expect(w.lines.at(-1)).toContain('for now: untrusted folder.');
  });

  it('a move whose way back fails too runs nothing, and says how to resume it by hand there', async () => {
    const w = world();
    w.host.runs(Q, SID, { cwd: WORK, saved: { kind: 'replayable', options: ['--model=opus'] } });
    w.host.failResumeIn.add(X);
    w.host.failResumeIn.add(Q);
    const d = await decideIn(w, attach(SHORT));
    expect(d).toEqual({
      kind: 'refuse',
      message:
        'could not move c5f2097e onto Inc (the folder slot of C:/work) (untrusted folder), nor resume ' +
        `it on the profile of a folder rule since removed. Resume it there with: CLAUDE_CONFIG_DIR=${Q} ` +
        `claude --bg --resume ${SID} --model=opus`,
    });
    expect(w.host.locks).toEqual(['take 0', 'release']);
  });

  it('a stop Claude Code refuses leaves it where it runs, opened there', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.failStop = true;
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls.some((c) => c.startsWith('resume') || c.startsWith('rm'))).toBe(false);
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

  it("a session left on a removed rule's profile has no login there: moved where it belongs whenever it is idle", async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(Q, SID, { cwd: OTHER });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual([
      'agents ' + Q,
      `stop ${Q} ${SHORT}`,
      `rm ${Q} ${SHORT}`,
      'resume main []',
    ]);
    expect(w.host.rowsOf()).toEqual(['main']);
  });

  it("busy on a removed rule's profile: opened there, saying plainly it has no login, and no daemon promise", async () => {
    const w = world({}, { daemonRunning: true });
    w.host.runs(Q, SID, { status: 'busy' });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(Q));
    expect(w.lines[0]).toBe(
      'cctl: background session c5f2097e stays on the profile of a folder rule since removed for ' +
        'now: it is in a turn. That profile has no login, so prompts there fail with "Not logged ' +
        'in" until cctl can move it, between turns. Opening it there.',
    );
  });

  it('moved between the look and the move by someone else: looks again and opens it where it now runs', async () => {
    const w = world();
    w.host.runs(MAIN);
    // Registry read 1 is the lookup's, 2 the look under the lock, 3 the move's own look: by then
    // another cctl's move has taken it from MAIN to X.
    w.host.beforeRegistry = (n) => {
      if (n !== 3) return;
      w.host.hosted.set('main', []);
      w.host.hosted.set(X, [{ short: SHORT, sessionId: SID, cwd: WORK }]);
      w.host.rows.get('main')!.delete(SHORT);
      w.host.row(X, 'running');
    };
    const d = await decideIn(w, attach(SHORT));
    expect(w.host.registryReads).toBeGreaterThanOrEqual(4);
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls.some((c) => c.startsWith('stop'))).toBe(false);
  });

  it('after /clear, found by its job id and by its new id, and moved with the conversation it runs now', async () => {
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
    for (const ref of [attach(SHORT), attach(NEW), resume(NEW), resume(SID)]) {
      const w = world();
      w.host.runs(MAIN, SID, { current: NEW, name: 'bg eval' });
      const d = await decideIn(w, ref);
      expect(d).toMatchObject(openUnder(X, '7a7a7a7a'));
      expect(w.host.calls).toEqual([
        'agents main',
        `stop main ${SHORT}`,
        `rm main ${SHORT}`,
        `resume ${X} []`,
      ]);
      expect(w.host.hosted.get(X)).toEqual([{ short: '7a7a7a7a', sessionId: NEW, cwd: WORK }]);
      expect(w.host.rowsOf(NEW)).toEqual([X]);
    }
  });
});

describe('routeBackgroundLaunch — the session runs in no service', () => {
  it('a stopped row where it belongs: opened there, its rows elsewhere removed first', async () => {
    const w = world();
    w.host.row(X, 'stopped');
    w.host.row(MAIN, 'stopped');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([`rm main ${SHORT}`]);
    expect(w.host.rowsOf()).toEqual([X]);
  });

  it('a failed row where it belongs: restarted idle there first, then opened', async () => {
    const w = world();
    w.host.row(X, 'failed');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([`resume ${X}`]);
    expect(w.host.hostOf()).toEqual([X]);
  });

  it('a restart accepted but never shown under the folder slot runs nothing and says so', async () => {
    const w = world();
    w.host.row(X, 'failed');
    w.host.silentResumeIn.add(X);
    expect(await decideIn(w, attach(SHORT))).toEqual({
      kind: 'refuse',
      message:
        'could not start c5f2097e on Inc (the folder slot of C:/work): it did not show up there.',
    });
  });

  it('no row where it belongs: started there with what its latest row saved, its other rows removed', async () => {
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
    expect(w.host.calls).toEqual([
      `rm main ${SHORT}`,
      `rm ${Q} ${SHORT}`,
      `resume ${X} [--name=bg eval --model=opus]`,
    ]);
    expect(w.host.rowsOf()).toEqual([X]);
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

  it('a session whose row records a worktree is opened where that row is, and that row stays', async () => {
    const w = world();
    w.host.row(MAIN, 'stopped', SID, { worktreePath: 'C:/work/app/.claude/worktrees/feat' });
    w.host.row(X, 'stopped');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.host.calls).toEqual([`rm ${X} ${SHORT}`]);
    expect(w.lines[0]).toContain('it works in a git worktree Claude Code made for it');
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

  it('--resume runs it in the foreground as Claude Code does, whatever its rows say', async () => {
    for (const state of [undefined, 'stopped', 'running', 'failed']) {
      const w = world();
      w.host.titles.set(SID, 'bg eval');
      if (state !== undefined) w.host.row(X, state);
      w.host.row(MAIN, 'failed');
      expect(await decideIn(w, resume(SID))).toEqual({ kind: 'pass' });
      expect(w.host.calls).toEqual([]);
    }
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

  it('open in a terminal and live in a service too: the terminal is what counts', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.registry.push({ pid: 777, sessionId: SID, kind: 'interactive', cwd: WORK });
    expect(await decideIn(w, attach(SHORT))).toMatchObject({ kind: 'refuse' });
    expect(w.host.calls).toEqual([]);
  });

  it("live in the registry with no service of cctl's claiming it: nothing is run on a guess", async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.hosted.clear();
    const d = await decideIn(w, attach(SHORT));
    expect(d.kind === 'refuse' && d.message).toContain('cannot tell which account');
    expect(w.host.calls).toEqual([]);
  });

  it('two services claiming it at once: nothing is run on a guess', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.hosted.set(X, [{ short: SHORT, sessionId: SID, cwd: WORK }]);
    const d = await decideIn(w, attach(SHORT));
    expect(d.kind === 'refuse' && d.message).toContain('cannot tell which account');
    expect(w.host.calls).toEqual([]);
  });

  it('a registry entry caught mid-write that reads cleanly a moment later is not refused', async () => {
    const w = world();
    w.host.runs(X);
    // The lookup reads it fine; the strict look under the lock is torn once, then whole.
    w.host.beforeRegistry = (n) => {
      if (n === 2) w.host.failRegistry = 1;
    };
    expect(await decideIn(w, attach(SHORT))).toMatchObject(openUnder(X));
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
  it('a hex word of up to 8 digits is a job id prefix, never a name, as Claude Code reads it', async () => {
    const w = world();
    const A = 'ab12cd34-0000-4000-8000-000000000001';
    w.host.runs(X, A, { name: 'first' });
    w.host.runs(X, SID, { name: 'tab cleanup' });
    expect(await decideIn(w, attach('ab'))).toMatchObject(openUnder(X, 'ab12cd34'));
    // A prefix of no job id is not looked up as a name: Claude Code says no job matches.
    expect(await decideIn(w, attach('fe'))).toEqual({ kind: 'pass' });
  });

  it('a prefix two jobs share is refused with their ids', async () => {
    const w = world();
    w.host.runs(X, SID);
    w.host.row(MAIN, 'stopped', 'c5f2aaaa-0000-4000-8000-000000000001');
    const d = await decideIn(w, attach('c5f2'));
    expect(d.kind === 'refuse' && d.message).toContain('names more than one session');
  });

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
    // "eval" is part of both names; "bg eval" is one whole name and wins, in any case.
    expect(await decideIn(w, attach('bg eval'))).toMatchObject(openUnder(X));
    expect(await decideIn(w, attach(' BG Eval '))).toMatchObject(openUnder(X));
    expect(await decideIn(w, attach('eval'))).toEqual({
      kind: 'refuse',
      message:
        '"eval" names more than one session (0dff6248 "bg eval two", c5f2097e "bg eval"); ' +
        'name one by its id.',
    });
  });

  it("a --resume title is looked up among this folder's sessions and its worktrees'", async () => {
    const elsewhere = world();
    elsewhere.host.runs(MAIN, SID, { cwd: OTHER });
    elsewhere.host.titles.set(SID, 'bg eval');
    expect(await decideIn(elsewhere, resume('bg eval'))).toEqual({ kind: 'pass' });
    expect(elsewhere.host.calls).toEqual([]);

    const WT = 'C:/work/app/.claude/worktrees/feat-x';
    const tree = world({}, { worktrees: [WT] });
    tree.host.runs(MAIN, SID, { cwd: WT, status: 'busy' });
    tree.host.row(X, 'stopped', SID, { cwd: WT });
    tree.host.titles.set(SID, 'feat x');
    expect(await decideIn(tree, resume('feat x'))).toMatchObject(openUnder(MAIN));
  });

  it('a title two sessions share opens the picker only while no row here can be chosen into a steal', async () => {
    const OLD = '11111111-2222-4333-8444-555555555555';
    const shared = world();
    shared.host.runs(MAIN, SID, { status: 'busy' });
    shared.host.titles.set(SID, 'bg eval');
    shared.host.plainTitles.set(OLD, 'bg eval');
    // X holds no row of the background session: Claude Code's picker is safe.
    expect(await decideIn(shared, resume('bg eval'))).toEqual({ kind: 'pass' });

    const trap = world();
    trap.host.runs(MAIN, SID, { status: 'busy' });
    trap.host.row(X, 'stopped');
    trap.host.titles.set(SID, 'bg eval');
    trap.host.plainTitles.set(OLD, 'bg eval');
    expect(await decideIn(trap, resume('bg eval'))).toEqual({
      kind: 'refuse',
      message: `"bg eval" names more than one session (${SID}, ${OLD}); name one by its id.`,
    });
  });

  it("a --resume title matches the conversation's title, never a job row's name", async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'ok', status: 'busy' });
    w.host.titles.set(SID, 'bg eval');
    expect(await decideIn(w, resume('ok'))).toEqual({ kind: 'pass' });
    expect(await decideIn(w, resume('bg eval'))).toMatchObject(openUnder(MAIN));
  });

  it('a --resume of an 8-digit id is a title, as Claude Code reads it: unknown, so passed through when nothing here is a trap', async () => {
    const w = world();
    w.host.runs(MAIN);
    expect(await decideIn(w, resume(SHORT))).toEqual({ kind: 'pass' });
  });

  it('an ordinary session (no job row, no service) is never routed: passed through untouched', async () => {
    const OLD = '11111111-2222-4333-8444-555555555555';
    const w = world();
    w.host.registry.push({ pid: 9999, sessionId: OLD, kind: 'interactive', cwd: WORK });
    expect(await decideIn(w, resume(OLD))).toEqual({ kind: 'pass' });
    expect(w.host.locks).toEqual([]);
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

describe('routeBackgroundLaunch — a row here for a session running elsewhere (a trap)', () => {
  it('refuses the picker, --continue, the agents view and a respawn of all while one is here', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'bg eval', status: 'busy' });
    w.host.row(X, 'stopped');
    const d = await decideIn(w, GUARD);
    expect(d).toEqual({
      kind: 'refuse',
      message:
        'the folder slot of C:/work still holds a job row for a background session that runs ' +
        'elsewhere, and Claude Code would stop it there and take it over from this command. ' +
        '"bg eval" (c5f2097e) runs on Shared (the global slot); open it with: cctl claude attach ' +
        'c5f2097e.',
    });
  });

  it('passes them on once no row here belongs to a session live elsewhere', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy' });
    w.host.row(X, 'stopped', SID2);
    expect(await decideIn(w, GUARD)).toEqual({ kind: 'pass' });
    // A row here for a session running here is no trap either.
    const here = world();
    here.host.runs(X);
    expect(await decideIn(here, GUARD)).toEqual({ kind: 'pass' });
  });

  it('a reference cctl cannot place is refused when it could reach a trap row here', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy', cwd: 'C:/elsewhere/tree' });
    w.host.row(X, 'stopped', SID, { cwd: 'C:/elsewhere/tree' });
    w.host.titles.set(SID, 'feat x');
    // The title's folder is not one cctl searches from here, but Claude Code may match it; any other
    // term opens its picker, where the session can be chosen too.
    expect(await decideIn(w, resume('feat x'))).toMatchObject({ kind: 'refuse' });
    expect(await decideIn(w, resume('something else'))).toMatchObject({ kind: 'refuse' });
    // attach opens no picker: a name that is not the session's reaches nothing (and so is no steal,
    // though the row is still there).
    expect(await routeBackgroundLaunch(attach('something else'), w.ctx, FOLLOW)).toEqual({
      kind: 'pass',
    });
  });

  it('under --account or --override, the chosen slot is what is checked', async () => {
    const w = world();
    w.host.runs(X, SID, { status: 'busy' });
    w.host.row(MAIN, 'stopped');
    expect(await decideIn(w, GUARD, { kind: 'fixed', configDir: MAIN })).toMatchObject({
      kind: 'refuse',
    });
    expect(await decideIn(w, GUARD, { kind: 'fixed', configDir: X })).toEqual({ kind: 'pass' });
  });
});

describe('routeBackgroundLaunch — stop, rm, kill and respawn of one session', () => {
  it('run under the config dir that runs it, by its job id there', async () => {
    for (const cmd of ['stop', 'rm', 'kill', 'respawn']) {
      const w = world();
      w.host.runs(MAIN, SID, { status: 'busy' });
      w.host.row(X, 'stopped');
      expect(await decideIn(w, control(cmd, 'c5f2'))).toEqual({
        kind: 'open',
        configDir: MAIN,
        args: [cmd, SHORT],
      });
      expect(w.host.calls).toEqual([]);
    }
  });

  it('a session running nowhere is passed on: it acts on rows only', async () => {
    const w = world();
    w.host.row(X, 'stopped');
    expect(await decideIn(w, control('rm', SHORT))).toEqual({ kind: 'pass' });
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

  it('chosen as the folder profile: a session on the global slot is opened there', async () => {
    const w = world();
    w.host.runs(MAIN);
    w.host.row(X, 'stopped');
    expect(await decideIn(w, attach(SHORT), { kind: 'fixed', configDir: X })).toMatchObject(
      openUnder(MAIN),
    );
  });

  it("runs the operator's own arguments where it runs, keeping the lock until the terminal shows up", async () => {
    const w = world();
    w.host.runs(MAIN);
    const fixed: RouteMode = { kind: 'fixed', configDir: MAIN };
    const d = await decideIn(w, attach(SHORT), fixed);
    expect(d).toMatchObject({ kind: 'pass', hold: { configDir: MAIN } });
    expect(w.host.locks).toEqual(['take 0']);
  });

  it('a config dir spelled with other case or slashes is the same one', async () => {
    const w = world();
    w.host.runs(X);
    const fixed: RouteMode = {
      kind: 'fixed',
      configDir: X.toUpperCase().replace(/\//g, '\\') + '\\',
    };
    const d = await routeBackgroundLaunch(attach(SHORT), w.ctx, fixed);
    expect(d).toMatchObject({ kind: 'pass' });
    const follow = world({ configDir: X.toUpperCase() });
    follow.host.runs(X);
    expect(await routeBackgroundLaunch(attach(SHORT), follow.ctx, FOLLOW)).toMatchObject(
      openUnder(X),
    );
    expect(follow.host.calls).toEqual([]);
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

/** A small deterministic generator (mulberry32), so a failing arrangement can be replayed by its
 *  seed. Its low bits are as random as its high ones, which a plain linear congruence's are not:
 *  picks between two or four would come out in lockstep and leave whole arrangements unvisited. */
function rng(seed: number): (n: number) => number {
  let s = seed >>> 0;
  return (n) => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) % n;
  };
}

describe('the steal property, over every arrangement', () => {
  it('no arrangement of where it runs, its rows, names, titles, folders, failures, locks and the slot ever lets it be taken', async () => {
    const places: Array<Config | undefined> = [MAIN, X, Q, undefined];
    const rowStates = [undefined, 'stopped', 'failed', 'running'];
    // Idle twice as often: a move needs it, and moves are what most needs checking.
    const statuses = ['idle', 'idle', 'busy', 'waiting', undefined];
    const saves: SavedLaunch[] = [
      { kind: 'replayable', options: [] },
      { kind: 'replayable', options: ['--name=bg eval', '--disallowedTools=Bash'] },
      { kind: 'unreplayable', reason: 'it was started with --file, which a move does not replay' },
    ];
    const requests: BackgroundRequest[] = [
      attach(SHORT),
      attach('c5f2'),
      attach('bg eval'),
      attach(SID),
      resume(SID),
      resume('bg eval'),
      resume(SID, ['carry on']),
      control('stop', SHORT),
      control('rm', 'c5f2'),
      GUARD,
    ];
    const modes: RouteMode[] = [
      FOLLOW,
      FOLLOW,
      { kind: 'fixed', configDir: MAIN },
      { kind: 'fixed', configDir: X },
    ];
    const homes: Array<Partial<SessionHome>> = [
      {},
      { movable: false },
      {
        movable: false,
        unusable: 'C:/work has a folder rule, but no account it may use is usable: x',
      },
    ];
    let checked = 0;
    // What the arrangements came to, so the property is known to reach every branch.
    const seen = { open: 0, pass: 0, refuse: 0, moved: 0, putBack: 0, started: 0, trapRefused: 0 };
    for (let seed = 1; seed <= 10_000; seed++) {
      const r = rng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[r(xs.length)]!;
      const place = pick(places);
      const cwd = pick([WORK, OTHER, 'C:/work/app/.claude/worktrees/feat']);
      const w = world(pick(homes), { daemonRunning: r(2) === 0, cwd: pick([WORK, OTHER]) });
      const saved = pick(saves);
      const tree = r(8) === 0 ? 'C:/work/app/.claude/worktrees/feat' : undefined;
      if (place !== undefined) {
        const status = pick(statuses);
        w.host.runs(place, SID, {
          cwd,
          name: 'bg eval',
          saved,
          ...(status !== undefined ? { status } : {}),
          ...(r(6) === 0 ? { pending: true } : {}),
          ...(tree !== undefined ? { worktreePath: tree } : {}),
        });
        if (status === undefined) delete w.host.registry[0]!.status;
      }
      for (const c of [MAIN, X, Q]) {
        if (place !== undefined && key(c) === key(place)) continue;
        const state = pick(rowStates);
        if (state !== undefined) {
          w.host.row(c, state, SID, {
            cwd,
            saved: pick(saves),
            ...(r(10) === 0 && tree ? { worktreePath: tree } : {}),
          });
        }
      }
      if (r(3) === 0) w.host.titles.set(SID, 'bg eval');
      if (r(5) === 0) w.host.plainTitles.set('11111111-2222-4333-8444-555555555555', 'bg eval');
      if (place !== undefined && r(4) === 0) w.host.attachedIn.add(key(place));
      if (r(4) === 0) w.host.failResumeIn.add(X);
      if (r(6) === 0) w.host.failResumeIn.add(key(place ?? MAIN));
      if (r(8) === 0) w.host.failStop = true;
      if (r(8) === 0) w.host.failRemoveIn.add(key(pick([MAIN, X, Q])));
      if (r(10) === 0) w.host.agentsStatus = 'busy';
      if (r(12) === 0) w.host.lockedFor = 1;
      if (r(12) === 0) w.host.failRegistry = 1;
      if (r(10) === 0 && place !== undefined) {
        // Another process moves it away between two looks.
        const away = key(place) === 'main' ? X : MAIN;
        w.host.beforeRegistry = (n) => {
          if (n !== 3) return;
          const moved = w.host.hosted.get(key(place)) ?? [];
          w.host.hosted.set(key(place), []);
          w.host.hosted.set(key(away), moved);
          // Its row goes with it, work held between turns and all.
          const row = w.host.rows.get(key(place))?.get(SHORT);
          w.host.rows.get(key(place))?.delete(SHORT);
          if (row !== undefined) w.host.row(away, 'running', SID, row);
        };
      }
      const busyAtStart = place !== undefined && w.host.registry[0]?.status !== 'idle';
      const pendingAtStart =
        place !== undefined && w.host.rows.get(key(place))?.get(SHORT)?.pending === true;
      const d = await decideIn(w, pick(requests), pick(modes));
      // Never stopped mid-turn or holding work between turns.
      if (pendingAtStart || busyAtStart) {
        expect(w.host.calls.filter((c) => c.startsWith('stop'))).toEqual([]);
      }
      seen[d.kind]++;
      if (seed === 10_000) console.log(JSON.stringify(seen));
      const resumes = w.host.calls.filter((c) => c.startsWith('resume'));
      if (w.host.calls.some((c) => c.startsWith('stop')) && resumes.length === 1) seen.moved++;
      if (resumes.length > 1) seen.putBack++;
      if (!w.host.calls.some((c) => c.startsWith('stop')) && resumes.length > 0) seen.started++;
      if (d.kind === 'refuse' && d.message.includes('still holds a job row')) seen.trapRefused++;
      checked++;
    }
    expect(checked).toBe(10_000);
    for (const [what, n] of Object.entries(seen)) {
      expect({ what, reached: n > 20 }).toEqual({ what, reached: true });
    }
  });
});

describe('runHolding', () => {
  function lock(): { release(): void; released: () => number } {
    let n = 0;
    return { release: () => void n++, released: () => n };
  }
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 1));

  it('lets go of the lock once THIS terminal shows up in the attach journal, while it still runs', async () => {
    const l = lock();
    let ours = false;
    let releasedWhileRunning = -1;
    const code = await runHolding(
      { attachedBy: (c, pid) => Promise.resolve(ours && c === X && pid === 4242) },
      { lock: l, configDir: X },
      async (spawned) => {
        spawned(4242);
        ours = true;
        for (let i = 0; i < 50 && l.released() === 0; i++) await tick();
        releasedWhileRunning = l.released();
        return 7;
      },
      { sleep: tick },
    );
    expect(code).toBe(7);
    expect(releasedWhileRunning).toBe(1);
    expect(l.released()).toBe(1);
  });

  it("keeps the lock while another terminal of that service, or this one of another's, is all the journals show", async () => {
    const l = lock();
    let heldBefore = -1;
    let ours = false;
    await runHolding(
      // Some other terminal is attached under X the whole time; ours shows up only later, and
      // MAIN's journal shows this pid from the start (not the service it opens).
      {
        attachedBy: (c, pid) =>
          Promise.resolve(
            (c === null && pid === 4242) || (c === X && (pid === 9 || (ours && pid === 4242))),
          ),
      },
      { lock: l, configDir: X },
      async (spawned) => {
        spawned(4242);
        for (let i = 0; i < 20; i++) await tick();
        heldBefore = l.released();
        ours = true;
        for (let i = 0; i < 100 && l.released() === 0; i++) await tick();
        return 0;
      },
      { sleep: tick },
    );
    expect(heldBefore).toBe(0);
    expect(l.released()).toBe(1);
  });

  it('an unreadable journal is not taken for the terminal: the lock is kept until it can be read', async () => {
    const l = lock();
    let readable = false;
    let heldBefore = -1;
    await runHolding(
      {
        attachedBy: () => (readable ? Promise.resolve(true) : Promise.reject(new Error('EBUSY'))),
      },
      { lock: l, configDir: X },
      async (spawned) => {
        spawned(1);
        for (let i = 0; i < 20; i++) await tick();
        heldBefore = l.released();
        readable = true;
        for (let i = 0; i < 100 && l.released() === 0; i++) await tick();
        return 0;
      },
      { sleep: tick },
    );
    expect(heldBefore).toBe(0);
  });

  it('lets go when the terminal exits, when it fails to start, or once the cap passes', async () => {
    const exited = lock();
    await runHolding(
      { attachedBy: () => Promise.resolve(false) },
      { lock: exited, configDir: X },
      () => Promise.resolve(0),
    );
    expect(exited.released()).toBe(1);

    const failed = lock();
    await expect(
      runHolding({ attachedBy: () => Promise.resolve(false) }, { lock: failed, configDir: X }, () =>
        Promise.reject(new Error('no claude')),
      ),
    ).rejects.toThrow('no claude');
    expect(failed.released()).toBe(1);

    const capped = lock();
    let now = 0;
    let releasedEarly = 0;
    await runHolding(
      { attachedBy: () => Promise.resolve(false) },
      { lock: capped, configDir: X },
      async (spawned) => {
        spawned(1);
        for (let i = 0; i < 100 && capped.released() === 0; i++) await tick();
        releasedEarly = capped.released();
        return 0;
      },
      {
        clock: () => now,
        sleep: (ms) => {
          now += ms;
          return tick();
        },
        capMs: 1_000,
      },
    );
    expect(releasedEarly).toBe(1);
  });

  it('with nothing held, just runs', async () => {
    expect(
      await runHolding({ attachedBy: () => Promise.reject(new Error('unread')) }, undefined, () =>
        Promise.resolve(3),
      ),
    ).toBe(3);
  });
});
