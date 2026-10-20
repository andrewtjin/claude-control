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
import {
  BackgroundMover,
  type JobRow,
  type LiveSession,
  type MoveOutcome,
  type ResumeRecovery,
  type RowRead,
  type SavedLaunch,
  type SessionActivity,
} from '@claude-control/daemon';
import {
  parseBackgroundRequest,
  routeBackgroundLaunch,
  runHolding,
  selfRelaunchRefusal,
  selfRelaunchingWord,
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
/** The profile of W's parallel session (`cctl claude --account W`). */
const P = 'C:/data/profiles/session-w';
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

/** A Claude Code with services in MAIN, X (the folder's profile) and Q (a removed rule's profile),
 *  behind a host that behaves like the real one: a stop removes the session from its service and
 *  the registry and leaves its row stopped (a failed one failed); a resume while it runs anywhere
 *  starts a copy (refused here); a resume with options over a row is refused; a resume wakes the row
 *  (a new one saved with the options given); `rm` removes a row, refusing one with a worktree, one
 *  Claude Code is waking, and one of a session live or starting anywhere (by the registry, the way
 *  Claude Code's rm reaches it, or by any roster). Verified reads leave out roster records whose pid
 *  was reused; titles are searched in the folders given only; the move lock is one per id, taken by
 *  one holder at a time, a wait for it ending when its holder lets go. Every command and every copy
 *  is recorded. */
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
  /** The folder each of those conversations was filed under (by default the work folder). */
  readonly plainFolders = new Map<string, string>();
  /** Roster records whose pid now names another process: only an unverified read lists them. */
  readonly reusedPids = new Map<string, Array<{ short: string; sessionId: string; cwd: string }>>();
  /** The recoveries a move saved, by the conversation it resumes. */
  readonly recoveries = new Map<string, ResumeRecovery>();
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
  /** Every take and every release of a move lock, a lock on several ids counted once. */
  readonly locks: string[] = [];
  /** Every id taken, in order. */
  readonly lockedIds: string[] = [];
  /** Ids whose lock cannot be let go (its directory still held open): a release throws, and the
   *  lock stays held, as one left on disk does until it lapses. */
  readonly stuckLocks = new Set<string>();
  /** Ids held now, each with the takers waiting on it. */
  private readonly held = new Map<string, Array<() => void>>();
  /** Runs before a roster read, by config dir (to move the session between two looks). */
  beforeList: ((c: Config) => void) | undefined;
  /** Runs before every registry read, with its count so far. */
  beforeRegistry: ((n: number) => void) | undefined;
  registryReads = 0;
  failRegistry = 0;
  /** How many strict reads of a config dir's rows fail next, as one caught mid-write or locked. */
  readonly unreadableRowsIn = new Map<string, number>();

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

  /** Config dirs beyond the usual three, for a case that needs one (a parallel session's). */
  extraDirs: Config[] = [];
  configDirs(): Promise<Config[]> {
    return Promise.resolve([MAIN, X, Q, ...this.extraDirs]);
  }
  liveSessions(): Promise<LiveSession[]> {
    this.beforeRegistry?.(++this.registryReads);
    if (this.failRegistry > 0) {
      this.failRegistry--;
      return Promise.reject(new Error('a live session registry entry could not be read right now'));
    }
    return Promise.resolve([...this.registry]);
  }
  jobRows(c: Config, opts?: { strict?: boolean }): Promise<JobRow[]> {
    const failing = this.unreadableRowsIn.get(key(c)) ?? 0;
    if (opts?.strict === true && failing > 0) {
      this.unreadableRowsIn.set(key(c), failing - 1);
      const short = [...(this.rows.get(key(c))?.keys() ?? [])][0] ?? SHORT;
      return Promise.reject(new Error(`its job row ${short} there could not be read right now`));
    }
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
  titlesIn(folders: readonly string[]): Promise<Map<string, string>> {
    const inScope = (f: string): boolean =>
      folders.some((x) => x.toLowerCase() === f.toLowerCase());
    // A background session's conversation is filed under the folder it started in.
    const folderOf = (id: string): string =>
      [...this.hosted.values()].flat().find((w) => w.sessionId === id)?.cwd ??
      [...this.rows.values()].flatMap((m) => [...m.values()]).find((r) => r.sessionId === id)
        ?.cwd ??
      WORK;
    return Promise.resolve(
      new Map([
        ...[...this.titles].filter(([id]) => inScope(folderOf(id))),
        ...[...this.plainTitles].filter(([id]) => inScope(this.plainFolders.get(id) ?? WORK)),
      ]),
    );
  }
  listHosted(
    c: Config,
    opts?: { verified?: boolean },
  ): Promise<Array<{ short: string; sessionId: string; cwd: string }>> {
    this.beforeList?.(c);
    const reused = opts?.verified === true ? [] : (this.reusedPids.get(key(c)) ?? []);
    return Promise.resolve([...(this.hosted.get(key(c)) ?? []), ...reused]);
  }
  /** Parallel sessions are not what these cases drive: no service hosts a worker for one. */
  hostedWorkerProcesses(): Promise<Array<{ pid: number; procStart?: string }>> {
    return Promise.resolve([]);
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
    const existing = this.rows.get(key(c))?.get(input.short);
    // A row woken by the id its job started with runs the conversation it ran last (after /clear,
    // not that id), as Claude Code wakes one.
    const conversation =
      existing !== undefined && existing.sessionId === input.sessionId
        ? (existing.resumeSessionId ?? existing.sessionId)
        : input.sessionId;
    const running = this.hostOf(conversation);
    if (running.length > 0 || this.registry.some((e) => e.sessionId === conversation)) {
      this.copies.push(`resume under ${key(c)} while it ran in ${running.join(', ')}`);
      return Promise.reject(new Error('claude started a copy (5e1d04b2) instead of resuming it'));
    }
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
    // Its worker records that conversation under the row's job id (measured).
    this.hosted.set(key(c), [
      ...(this.hosted.get(key(c)) ?? []),
      { short: input.short, sessionId: conversation, cwd: input.cwd },
    ]);
    this.registry.push({
      pid: 5000 + this.registry.length,
      sessionId: conversation,
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
  /** One lock per id, as on disk: a second take of a held id gets nothing at once, or waits for
   *  its holder to let go. `locks` counts a move lock once, however many ids it is taken on. */
  async lockSession(sessionId: string, waitMs: number): Promise<{ release(): void } | undefined> {
    if (this.lockedFor > 0) {
      this.lockedFor--;
      return undefined;
    }
    while (this.held.has(sessionId)) {
      if (waitMs === 0) return undefined;
      await new Promise<void>((resolve) => this.held.get(sessionId)!.push(resolve));
    }
    const first = this.held.size === 0;
    this.held.set(sessionId, []);
    this.lockedIds.push(sessionId);
    if (first) this.locks.push(`take ${waitMs}`);
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        if (this.stuckLocks.has(sessionId)) {
          throw Object.assign(new Error(`EBUSY: resource busy, rmdir '${sessionId}'`), {
            code: 'EBUSY',
          });
        }
        const waiting = this.held.get(sessionId) ?? [];
        this.held.delete(sessionId);
        if (this.held.size === 0) this.locks.push('release');
        for (const wake of waiting) wake();
      },
    };
  }
  /** Whether an id's lock is held now. */
  isLocked(sessionId: string): boolean {
    return this.held.has(sessionId);
  }
  saveRecovery(recovery: ResumeRecovery): Promise<void> {
    this.recoveries.set(recovery.sessionId, recovery);
    return Promise.resolve();
  }
  dropRecovery(sessionId: string): Promise<void> {
    this.recoveries.delete(sessionId);
    return Promise.resolve();
  }
  recoveryOf(sessionId: string): Promise<ResumeRecovery | undefined> {
    return Promise.resolve(this.recoveries.get(sessionId));
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
  /** How many times the move shield ran, how many of those a move committed in (held Ctrl-C), and
   *  the command each said would bring the session back. */
  shields: { n: number; held: number; hints: string[] };
}

/** A world where C:/work belongs to the rule whose profile is X, and anything else to MAIN. */
function world(
  home: Partial<SessionHome> = {},
  opts: { daemonRunning?: boolean; cwd?: string; worktrees?: string[] } = {},
): World {
  const host = new FakeClaude();
  const lines: string[] = [];
  const shields = { n: 0, held: 0, hints: [] as string[] };
  const homeX: SessionHome = { configDir: X, movable: true, ...home };
  const views: Record<
    string,
    { account?: string; slot: string; removed?: boolean; parallel?: boolean }
  > = {
    main: { account: 'Shared', slot: 'the global slot' },
    [X]: { account: 'Inc', slot: 'the folder slot of C:/work' },
    [Q]: { slot: 'the profile of a folder rule since removed', removed: true },
    [P]: { account: 'W', slot: 'the parallel-session slot of W', parallel: true },
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
    shield: async (fn, note) => {
      shields.n++;
      try {
        return await fn(() => void shields.held++);
      } finally {
        const hint = note?.();
        if (hint !== undefined) shields.hints.push(hint);
      }
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
  // What Claude Code's wake sweep reaches from a row under that config dir (measured): a live
  // background session in another service filed under the row's job id, or whose conversation
  // starts with it. After /clear and a move, a row of the job's earlier conversation reaches none.
  if (under !== undefined) {
    const here = [...(w.host.rows.get(key(under))?.keys() ?? [])];
    const elsewhere = (jobId: string | undefined): boolean =>
      [...w.host.hosted.entries()].some(
        ([c, list]) => c !== key(under) && list.some((j) => j.short === jobId),
      );
    const reached = w.host.registry.filter(
      (e) =>
        e.kind === 'bg' &&
        elsewhere(e.jobId) &&
        here.some((short) => e.jobId === short || e.sessionId.startsWith(short)),
    );
    expect({ under: key(under), reached }).toEqual({ under: key(under), reached: [] });
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

  it('--bg or --background after -- or as an option value is a background start too, as Claude Code takes it', () => {
    // Measured (2.1.296): each of these, run where a stopped row could take the session from the
    // service running it, went into Claude Code's background launcher and started a copy; none
    // opened it in a terminal. Read as a resume, cctl would run that very copy where it runs.
    for (const args of [
      ['--resume', SID, '--append-system-prompt', '--bg'],
      ['-r', SID, '--name', '--background'],
      ['--resume', SID, '--', '--bg'],
    ]) {
      expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({ args, parsed: undefined });
    }
  });

  it('with a background-session verb first, reads the verb whatever background words follow, as Claude Code runs it', () => {
    // Claude Code runs a verb that comes first and never its background launcher, so these reach a
    // row just as the same words without --bg do.
    const asVerb = (verb: string, args: string[]): BackgroundRequest | undefined =>
      verb === 'logs'
        ? GUARD
        : {
            verb: verb === 'attach' ? 'attach' : 'control',
            ref: SHORT,
            args,
            refAt: args.indexOf(SHORT),
          };
    for (const verb of ['attach', 'stop', 'kill', 'rm', 'respawn', 'logs']) {
      expect(parseBackgroundRequest([verb, SHORT])).toEqual(asVerb(verb, [verb, SHORT]));
      for (const bg of ['--bg', '--background']) {
        for (const args of [
          [verb, SHORT, bg],
          [verb, bg, SHORT],
          [verb, SHORT, '--', bg],
        ]) {
          expect({ args, parsed: parseBackgroundRequest(args) }).toEqual({
            args,
            parsed: asVerb(verb, args),
          });
        }
      }
    }
    expect(parseBackgroundRequest(['respawn', '--all', '--bg'])).toEqual(GUARD);
  });

  it('reads a verb behind root options as Claude Code does: before a whole job id, behind options it knows, no background start among them', () => {
    expect(parseBackgroundRequest(['--verbose', 'attach', SHORT, '--bg'])).toEqual({
      verb: 'attach',
      ref: SHORT,
      args: ['--verbose', 'attach', SHORT, '--bg'],
      refAt: 2,
    });
    expect(parseBackgroundRequest(['--model', 'opus', 'stop', SHORT, '--background'])).toEqual({
      verb: 'control',
      ref: SHORT,
      args: ['--model', 'opus', 'stop', SHORT, '--background'],
      refAt: 3,
    });
    // The values of a list option end at the next option; the verb after it is read.
    const listed = ['--allowed-tools', 'Read', 'Edit', '--verbose', 'attach', SHORT, '--bg'];
    expect(parseBackgroundRequest(listed)).toEqual({
      verb: 'attach',
      ref: SHORT,
      args: listed,
      refAt: 5,
    });
    expect(parseBackgroundRequest(['--verbose', 'respawn', '--all', '--bg'])).toEqual(GUARD);
    // Claude Code takes each of these to its background launcher instead: a background start.
    for (const args of [
      ['--bg', 'attach', SHORT],
      ['--background', '--verbose', 'stop', SHORT],
      ['-p', 'attach', SHORT, '--bg'],
      ['-cp', 'attach', SHORT, '--bg'],
      ['--routine=nightly', 'attach', SHORT, '--bg'],
      ['--exec', 'ls', 'attach', SHORT, '--bg'],
      // A name, or part of a job id, is no job id behind root options.
      ['--verbose', 'attach', 'bg eval', '--bg'],
      ['--verbose', 'attach', 'c5f2', '--bg'],
      // An option Claude Code does not know.
      ['--some-later-option', 'attach', SHORT, '--bg'],
      // The verb read as a value: of --name, or one of a list option's.
      ['--name', 'attach', SHORT, '--bg'],
      ['--allowed-tools', 'Read', 'attach', SHORT, '--bg'],
      // After --, no word is a verb.
      ['--', 'attach', SHORT, '--bg'],
      ['hello', '--', 'attach', SHORT, '--bg'],
      // agents is no verb of Claude Code's: with --bg its background launcher starts a session.
      ['agents', '--bg'],
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

describe('selfRelaunchingWord', () => {
  /** Every option Claude Code 2.1.296's own argument scanner reads a value for: the next word,
   *  whatever it looks like. Written out here as Claude Code's list, so cctl's own is pinned. */
  const CLAUDE_CODE_VALUE_OPTIONS = `
    --add-dir --advisor --agent --agent-color --agent-id --agent-name --agent-type --agents
    --allowed-tools --allowedTools --append-subagent-system-prompt
    --append-subagent-system-prompt-file --append-system-prompt --append-system-prompt-file
    --attach-serve --autocompact --betas --channels --client-data-url --correlation-id
    --dangerously-load-development-channels --debug-file --deep-link-cwd-b64
    --deep-link-last-fetch --deep-link-repo --disallowed-tools --disallowedTools --effort
    --environment --exec --fallback-model --file --forward-home-settings --handle-uri
    --inherit-permission-mode --input-format --json-schema --managed-settings --max-budget-usd
    --max-thinking-tokens --max-turns --mcp-config --messaging-socket-path --model --name
    --on-branch --output-format --parent-session-id --permission-mode --permission-prompt-tool
    --permission-prompts --plan-mode-instructions --plugin-dir --plugin-dir-no-mcp --plugin-url
    --pool --prefill --prefill-b64 --proactivity --project-config-root --ref
    --remote-control-session-name-prefix --resume-drops-turn --resume-session-at --rewind-files
    --routine --sdk-url --session-id --setting-sources --settings --system-prompt
    --system-prompt-file --system-prompt-snapshot --task-budget --team-name --teammate-mode
    --thinking --thinking-display --tools --watch-artifact --watch-artifact-no-autoreact
    --workload -m -n
  `
    .trim()
    .split(/\s+/);

  it('finds --bg or --background given as the separate value of any option Claude Code reads a value for', () => {
    expect(CLAUDE_CODE_VALUE_OPTIONS).toHaveLength(84);
    for (const option of CLAUDE_CODE_VALUE_OPTIONS) {
      for (const word of ['--bg', '--background']) {
        for (const args of [
          [option, word],
          ['--resume', SID, option, word, 'carry on'],
          // A background start given as well: the copy it starts still keeps the value.
          ['--bg', option, word],
        ]) {
          expect({ args, found: selfRelaunchingWord(args) }).toEqual({
            args,
            found: { word, option },
          });
        }
      }
    }
  });

  it('finds one given to a short option at the end of a cluster Claude Code peels', () => {
    expect(selfRelaunchingWord(['-pn', '--bg'])).toEqual({ word: '--bg', option: '-n' });
    expect(selfRelaunchingWord(['-cn', '--background'])).toEqual({
      word: '--background',
      option: '-n',
    });
    expect(selfRelaunchingWord(['-pcm', '--bg'])).toEqual({ word: '--bg', option: '-m' });
  });

  it('finds --bg or --background after --, as a word of the prompt', () => {
    for (const [args, word] of [
      [['--', '--bg'], '--bg'],
      [['--', '--background'], '--background'],
      [['--resume', SID, '--', '--bg'], '--bg'],
      [['hello', '--', 'and', '--background', 'too'], '--background'],
      [['--bg', '--', '--bg'], '--bg'],
      [['-p', '--', '--bg'], '--bg'],
    ] as const) {
      expect({ args, found: selfRelaunchingWord(args) }).toEqual({ args, found: { word } });
    }
  });

  it('passes every background start where the word stands as an option, and attached values', () => {
    for (const args of [
      ['--bg'],
      ['--background'],
      ['--bg', 'fix the failing test'],
      ['--bg', 'fix the --bg flag'],
      ['--', 'explain the --bg flag'],
      ['--bg', '--resume', SID],
      // The value attached to its option: the word is no --bg of its own, so no background start.
      ['--append-system-prompt=--bg'],
      ['--append-system-prompt=--bg', '--bg', 'hi'],
      ['--name=--background', '--background'],
      ['-n--bg'],
      // Switches: the word after one is an option of its own.
      ['--verbose', '--bg'],
      ['--dangerously-skip-permissions', '--bg', 'hi'],
      ['--fork-session', '--bg'],
      ['-c', '--bg'],
      // -p is a switch too: Claude Code takes the --bg after it as a background start.
      ['-p', '--bg', 'what is in this folder'],
      ['--print', '--background', 'hi'],
      // Options whose value is optional never take a word that starts with -.
      ['--resume', '--bg'],
      ['-r', '--bg'],
      ['--resume', SID, '--bg'],
      ['-d', '--bg'],
      ['--debug', '--bg'],
      ['-w', '--bg'],
      ['--worktree', '--background'],
      ['--from-pr', '--bg'],
      ['--remote-control', '--bg'],
      ['--rc', '--bg'],
      // A list option's later values never start with -.
      ['--allowed-tools', 'Read', 'Edit', '--bg'],
      ['--add-dir', 'a', 'b', '--background'],
      // The value of an option is the next word whatever it is, so the word after it stands free.
      ['--name', '--', '--bg'],
      ['--name', '--model', '--bg'],
      ['--allowed-tools', '--', '--bg'],
      // -np names the session "p"; -rn resumes "n": neither takes the next word.
      ['-np', '--bg'],
      ['-rn', '--bg'],
      // An option not known to take a value is read as the option it is.
      ['--some-later-option', '--bg'],
      ['--name', 'my session', '--', 'hello'],
      [],
    ]) {
      expect({ args, found: selfRelaunchingWord(args) }).toEqual({ args, found: undefined });
    }
  });

  it('passes a background-session verb that comes first: Claude Code runs the verb, never its background launcher', () => {
    for (const args of [
      ['attach', SHORT, '--', '--bg'],
      ['attach', 'x', '--', '--background'],
      ['attach', SHORT, '--name', '--bg'],
      ['stop', SHORT, '--', '--bg'],
      ['kill', SHORT, '--append-system-prompt', '--background'],
      ['rm', SHORT, '--', '--bg'],
      ['respawn', '--all', '--', '--bg'],
      ['logs', SHORT, '--', '--background'],
    ]) {
      expect({ args, found: selfRelaunchingWord(args) }).toEqual({ args, found: undefined });
    }
  });

  it('still refuses what Claude Code may take to its background launcher, a verb behind root options among it', () => {
    // Behind root options Claude Code runs the verb only outside a background session's own shell,
    // so cctl refuses it wherever it runs.
    expect(selfRelaunchingWord(['--verbose', 'attach', SHORT, '--', '--bg'])).toEqual({
      word: '--bg',
    });
    expect(selfRelaunchingWord(['--', 'attach', SHORT, '--bg'])).toEqual({ word: '--bg' });
    expect(selfRelaunchingWord(['agents', '--', '--bg'])).toEqual({ word: '--bg' });
    expect(selfRelaunchingWord(['--bg', 'attach', SHORT, '--name', '--bg'])).toEqual({
      word: '--bg',
      option: '--name',
    });
  });

  it('says what Claude Code would do and how to write it safely, in two lines', () => {
    const value = selfRelaunchRefusal({ word: '--bg', option: '--append-system-prompt' });
    expect(value.split('\n')).toEqual([
      'Claude Code would treat this as a background launch that keeps re-launching itself ' +
        '(--bg here is the value of --append-system-prompt).',
      'Attach the value to its option instead: --append-system-prompt=--bg',
    ]);
    // A short option is shown by its long name when it has one, else with the value attached.
    expect(selfRelaunchRefusal({ word: '--background', option: '-n' })).toContain(
      'instead: --name=--background',
    );
    expect(selfRelaunchRefusal({ word: '--bg', option: '-m' })).toContain('instead: -m--bg');
    const prompt = selfRelaunchRefusal({ word: '--bg' });
    expect(prompt.split('\n')).toEqual([
      'Claude Code would treat this as a background launch that keeps re-launching itself ' +
        '(--bg here is a word of the prompt, after --).',
      'Quote the prompt as one argument instead, so --bg is no word of its own: ' +
        '-- "explain the --bg flag"',
    ]);
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
    ] as const) {
      const w = world({}, { daemonRunning: true });
      w.host.runs(MAIN, SID, { status });
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

  it('a session still coming up, its registry entry saying nothing yet, is read again and never decided on a guess', async () => {
    // Measured: a session's first registry entry has a stand-in session id and no status.
    const w = world();
    w.host.runs(MAIN, SID, { current: '7a7a7a7a-1111-4222-8333-444444444444' });
    w.host.registry[0]!.sessionId = '0f0f0f0f-1111-4222-8333-444444444444';
    delete w.host.registry[0]!.status;
    let looks = 0;
    w.host.beforeRegistry = (n) => {
      looks = n;
      // Up a moment later: its entry names the conversation it runs, and says it is idle.
      if (n === 3) {
        w.host.registry[0]!.sessionId = '7a7a7a7a-1111-4222-8333-444444444444';
        w.host.registry[0]!.status = 'idle';
      }
    };
    const d = await decideIn(w, resume(SID, ['carry on']));
    expect(looks).toBeGreaterThanOrEqual(3);
    expect(d).toMatchObject({
      kind: 'open',
      configDir: X,
      args: ['--resume', '7a7a7a7a-1111-4222-8333-444444444444', 'carry on'],
    });

    const stuck = world();
    stuck.host.runs(MAIN, SID);
    delete stuck.host.registry[0]!.status;
    const refused = await decideIn(stuck, attach(SHORT));
    expect(refused.kind === 'refuse' && refused.message).toContain('cannot tell which account');
    expect(stuck.host.calls).toEqual([]);
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

  it('put back, it is looked for a moment longer while its registry entry says nothing yet: opened where it runs, never sent to bring it back', async () => {
    // Measured: a session coming up has a registry entry saying what it does 0.45 to 2 s after
    // its worker is listed, which is all a put-back's confirm waits for.
    const w = world();
    w.host.runs(MAIN, SID, { saved: { kind: 'replayable', options: ['--model=opus'] } });
    w.host.failResumeIn.add(X);
    let looks = 0;
    w.host.beforeRegistry = () => {
      if (!w.host.calls.includes('resume main [--model=opus]')) return;
      const entry = w.host.registry.at(-1)!;
      if (++looks <= 5) delete entry.status;
      else entry.status = 'idle';
    };
    const d = await decideIn(w, attach(SHORT));
    expect(looks).toBeGreaterThan(5);
    expect(d).toMatchObject(openUnder(MAIN));
    expect(w.lines.at(-1)).toContain('for now: untrusted folder.');
    // Still saying nothing after that: refused with the way back, as before.
    const stuck = world();
    stuck.host.runs(MAIN, SID, { saved: { kind: 'replayable', options: ['--model=opus'] } });
    stuck.host.failResumeIn.add(X);
    stuck.host.beforeRegistry = () => {
      if (stuck.host.calls.includes('resume main [--model=opus]')) {
        delete stuck.host.registry.at(-1)!.status;
      }
    };
    const refused = await decideIn(stuck, attach(SHORT));
    expect(refused.kind === 'refuse' && refused.message).toContain(
      `Bring it back with: cctl claude --resume ${SID}`,
    );
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
        `it on the profile of a folder rule since removed. Bring it back with: cctl claude --resume ${SID}`,
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

describe("routeBackgroundLaunch — a session on a parallel session's slot", () => {
  it('idle there and working in a ruled folder: opened where it runs, never moved onto the folder', async () => {
    const w = world();
    w.host.extraDirs.push(P);
    w.host.runs(P, SID, { name: 'bg eval', saved: { kind: 'replayable', options: [] } });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(P));
    expect(w.host.hostOf()).toEqual([P]);
    expect(w.host.calls.some((c) => c.startsWith('stop') || c.startsWith('rm'))).toBe(false);
    expect(w.lines.join(' ')).not.toContain('moving');
  });

  it('runs nowhere, its only row there: opened there, never started on the folder', async () => {
    const w = world();
    w.host.extraDirs.push(P);
    w.host.row(P, 'stopped');
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(P));
    expect(w.host.rowsOf()).toEqual([P]);
  });

  it('runs nowhere, its latest row there and an older one on the folder slot: opened there, never moved', async () => {
    const w = world();
    w.host.extraDirs.push(P);
    w.host.row(X, 'stopped', SID, { updatedAt: '2026-10-09T20:00:00Z' });
    w.host.row(P, 'stopped', SID, { updatedAt: '2026-10-09T23:00:00Z' });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(P));
    // Only the folder slot's older row goes, as for any session opened where it last ran.
    expect(w.host.calls).toEqual([`rm ${X} ${SHORT}`]);
    expect(w.host.rowsOf()).toEqual([P]);
  });

  it('runs nowhere, its latest row on the folder slot and an older one there: the parallel row is kept', async () => {
    const w = world();
    w.host.extraDirs.push(P);
    w.host.row(P, 'stopped', SID, { updatedAt: '2026-10-09T20:00:00Z' });
    w.host.row(X, 'stopped', SID, { updatedAt: '2026-10-09T23:00:00Z' });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls.some((c) => c.startsWith(`rm ${P}`))).toBe(false);
    expect(w.host.rowsOf()).toContain(P);
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

  it('a failed row after /clear is woken by the id its job started with: its conversation, its options, its own job id', async () => {
    // Measured: Claude Code wakes the row given that id, into the conversation it ran last; given
    // the conversation's own id, it starts a new job of that name with no options instead.
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
    const w = world();
    w.host.row(X, 'failed', SID, {
      resumeSessionId: NEW,
      saved: { kind: 'replayable', options: ['--name=bg eval'] },
    });
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([`resume ${X}`]);
    expect([...w.host.rows.get(X)!.keys()]).toEqual([SHORT]);
    // Its worker, under its own job id, records the conversation it was woken into.
    expect(w.host.hosted.get(X)).toEqual([{ short: SHORT, sessionId: NEW, cwd: WORK }]);
    expect(w.host.registry.at(-1)).toMatchObject({ sessionId: NEW, jobId: SHORT });
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

  it('a move lock that cannot be let go is said, and what was decided still runs', async () => {
    const STUCK =
      `cctl: could not let go of the move lock on ${SID} (EBUSY: resource busy, rmdir '${SID}'); ` +
      'it lapses on its own within 2 minutes.';
    // Let go of as the decision is made: a stop is run where the session runs all the same.
    const w = world();
    w.host.runs(MAIN);
    w.host.stuckLocks.add(SID);
    expect(await decideIn(w, control('stop', SHORT))).toMatchObject({
      kind: 'open',
      configDir: MAIN,
      args: ['stop', SHORT],
    });
    expect(w.lines.at(-1)).toBe(STUCK);
    // Kept until the terminal shows up, then let go: the terminal's own exit is what is returned.
    const v = world();
    v.host.runs(X);
    v.host.stuckLocks.add(SID);
    const d = await decideIn(v, attach(SHORT));
    expect(d).toMatchObject(openUnder(X));
    const exit = await runHolding(v.host, d.kind === 'open' ? d.hold : undefined, () =>
      Promise.resolve(7),
    );
    expect(exit).toBe(7);
    expect(v.lines).toEqual([STUCK]);
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
    // "eval" is part of both names; "bg eval" is one whole name and wins, in any case. Each open
    // holds the lock for its terminal, let go here as the terminal shows up.
    for (const ref of ['bg eval', ' BG Eval ']) {
      const d = await decideIn(w, attach(ref));
      expect(d).toMatchObject(openUnder(X));
      if (d.kind === 'open') d.hold?.lock.release();
    }
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

describe('routeBackgroundLaunch and the daemon on one session after /clear', () => {
  const NEW = '7a7a7a7a-1111-4222-8333-444444444444';

  /** The daemon's mover over the same Claude Code, moving C:/work's sessions onto X. */
  function daemonOf(w: World): { run: () => Promise<MoveOutcome[]> } {
    const mover = new BackgroundMover({
      host: w.host,
      resolveRule: ({ cwd }) =>
        Promise.resolve(cwd.toLowerCase().startsWith('c:/work') ? 'rule-x' : null),
      notify: () => {},
      clock: () => 0,
      confirmTimeoutMs: 0,
      sleep: () => Promise.resolve(),
    });
    const targets = new Map([
      ['rule-x', { ruleId: 'rule-x', folder: 'C:/work', configDir: X, accountLabel: 'Inc' }],
    ]);
    return { run: () => mover.run(targets) };
  }

  it('takes the lock on every id the session is known by: the id its job started with and the one it runs now', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW, status: 'busy' });
    await routeBackgroundLaunch(attach(SHORT), w.ctx, FOLLOW);
    // The daemon's mover takes the roster's id (the job's start) and the registry's (its current).
    expect([...w.host.lockedIds].sort()).toEqual([SID, NEW].sort());
  });

  it('the daemon moving it first: cctl waits for the move, then opens it where it went', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW });
    const daemon = daemonOf(w);
    let opened: Promise<RouteDecision> | undefined;
    const stop = w.host.stop.bind(w.host);
    w.host.stop = async (c, short) => {
      if (opened === undefined) {
        // The operator opens it as the daemon's move is about to stop it: cctl finds it running
        // there, and comes to its lock (or, held by nothing, would go on, which a bound lets show).
        opened = routeBackgroundLaunch(attach(SHORT), w.ctx, FOLLOW);
        for (let i = 0; i < 500 && !w.lines.some((l) => l.includes('is moving')); i++) {
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      return stop(c, short);
    };
    expect(await daemon.run()).toMatchObject([{ result: 'moved' }]);
    const d = await opened!;
    expect(w.lines[0]).toContain('another cctl process is moving');
    expect(d).toMatchObject({ kind: 'open', configDir: X, args: ['attach', '7a7a7a7a'] });
    expect(w.host.calls.filter((c) => c.startsWith('stop'))).toEqual([`stop main ${SHORT}`]);
    expect(w.host.copies).toEqual([]);
    expect(w.host.badRemovals).toEqual([]);
    expect(w.host.hostOf(NEW)).toEqual([X]);
  });

  it('cctl moving it first: the daemon holds back while the move runs, and while the terminal opens', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW });
    const daemon = daemonOf(w);
    const during: MoveOutcome[][] = [];
    const stop = w.host.stop.bind(w.host);
    w.host.stop = async (c, short) => {
      // The daemon's cycle comes while cctl's move is about to stop it.
      during.push(await daemon.run());
      return stop(c, short);
    };
    const d = await routeBackgroundLaunch(attach(SHORT), w.ctx, FOLLOW);
    expect(during).toEqual([
      [
        {
          sessionId: SID,
          ruleId: 'rule-x',
          result: 'skipped',
          reason: 'another cctl process is moving it',
        },
      ],
    ]);
    expect(d).toMatchObject({ kind: 'open', configDir: X, args: ['attach', '7a7a7a7a'] });
    // Held for the terminal: the session, now its own job under the folder slot, is still locked.
    expect(d.kind === 'open' && d.hold).toBeTruthy();
    expect(w.host.isLocked(NEW)).toBe(true);
    expect(w.host.calls.filter((c) => c.startsWith('stop'))).toEqual([`stop main ${SHORT}`]);
    if (d.kind === 'open') d.hold?.lock.release();
    expect(w.host.isLocked(NEW)).toBe(false);
    expect(w.host.isLocked(SID)).toBe(false);
  });

  it('a move put back after /clear is opened under the job it runs as now', async () => {
    const w = world();
    w.host.runs(MAIN, SID, {
      current: NEW,
      saved: { kind: 'replayable', options: ['--model=opus'] },
    });
    w.host.failResumeIn.add(X);
    const d = await decideIn(w, attach(SHORT));
    // The way back resumed its conversation as a job named after it.
    expect(w.host.hostOf(NEW)).toEqual(['main']);
    expect(d).toMatchObject({ kind: 'open', configDir: MAIN, args: ['attach', '7a7a7a7a'] });
    expect(w.lines.at(-1)).toContain(
      'stays on Shared (the global slot) for now: untrusted folder.',
    );
  });
});

describe('routeBackgroundLaunch — a move cut off half way', () => {
  const recoveryOn = (configDir: Config, options: string[]): ResumeRecovery => ({
    configDir,
    sessionId: SID,
    job: { short: SHORT, sessionId: SID },
    options,
    cwd: WORK,
  });

  it('every move says, as it commits, the command that brings the session back from what it saved', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { saved: { kind: 'replayable', options: ['--model=opus'] } });
    await decideIn(w, attach(SHORT));
    expect(w.shields.hints).toEqual([`cctl claude --resume ${SID}`]);
    // Moved: nothing is left to bring back.
    expect(w.host.recoveries.size).toBe(0);
  });

  it('cctl claude --resume <id> brings back a session its move left stopped nowhere, where the move found it, then opens it', async () => {
    // Its rows were removed and its resume never ran: the move's process was ended half way.
    const w = world();
    w.host.recoveries.set(SID, recoveryOn(MAIN, ['--model=opus']));
    w.host.titles.set(SID, 'bg eval');
    const d = await decideIn(w, resume(SID));
    expect(w.host.calls[0]).toBe('resume main [--model=opus]');
    expect(w.lines[0]).toBe(
      'cctl: brought background session c5f2097e-d500-42a0-9ddf-8a33f4f9a886 back on Shared (the ' +
        'global slot), where a move found it.',
    );
    expect(w.host.recoveries.size).toBe(0);
    // Then like any session found on another account: moved where it belongs, and opened there.
    expect(d).toMatchObject(openUnder(X));
    expect(w.host.hostOf()).toEqual([X]);
  });

  it('cut off right after the stop, its row still there: the row is woken, never resumed over', async () => {
    const w = world();
    w.host.row(Q, 'stopped', SID, { saved: { kind: 'replayable', options: ['--model=opus'] } });
    w.host.recoveries.set(SID, recoveryOn(Q, ['--model=opus']));
    await decideIn(w, attach(SID));
    expect(w.host.calls[0]).toBe(`resume ${Q}`);
  });

  it('a session that runs again needs nothing: its recovery is dropped, and it is opened as usual', async () => {
    const w = world();
    w.host.runs(X);
    w.host.recoveries.set(SID, recoveryOn(MAIN, []));
    expect(await decideIn(w, resume(SID))).toMatchObject(openUnder(X));
    expect(w.host.calls).toEqual([]);
    expect(w.host.recoveries.size).toBe(0);
  });

  it('a way back that fails again runs nothing and keeps the recovery for a later try', async () => {
    const w = world();
    w.host.recoveries.set(SID, recoveryOn(MAIN, []));
    w.host.failResumeIn.add('main');
    expect(await decideIn(w, resume(SID))).toEqual({
      kind: 'refuse',
      message: `could not bring ${SID} back on Shared (the global slot), where a move found it; try again in a moment.`,
    });
    expect(w.host.recoveries.has(SID)).toBe(true);
  });

  it('waits for a move of it still running in another cctl process', async () => {
    const w = world();
    w.host.recoveries.set(SID, recoveryOn(MAIN, []));
    w.host.lockedFor = Infinity;
    expect(await decideIn(w, resume(SID))).toEqual({
      kind: 'refuse',
      message: `another cctl process is still moving ${SID}; try again in a moment.`,
    });
    expect(w.host.calls).toEqual([]);
  });

  it('after /clear, the lock and the look take in the job the move saved: one coming up under it is never brought back over', async () => {
    // Its job is being woken on the global slot by hand: its worker is listed under the job id,
    // recording the id the job started with, before any registry entry names the conversation.
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
    const w = world();
    w.host.recoveries.set(NEW, { ...recoveryOn(MAIN, []), sessionId: NEW });
    w.host.row(MAIN, 'starting', SID, { resumeSessionId: NEW });
    w.host.hosted.set('main', [{ short: SHORT, sessionId: SID, cwd: WORK }]);
    expect(await decideIn(w, resume(NEW))).toEqual({
      kind: 'refuse',
      message: `cannot tell where ${NEW} runs right now (it is starting or stopping); try again in a moment.`,
    });
    expect(w.host.calls).toEqual([]);
    // The daemon's mover locks the job by the id it started with: the two meet on it.
    expect([...w.host.lockedIds].sort()).toEqual([NEW, SID].sort());
    expect(w.host.recoveries.has(NEW)).toBe(true);
  });

  it('found running by any look of it, its recovery is dropped: nothing is ever brought back on a stale one', async () => {
    const w = world();
    w.host.runs(X);
    w.host.recoveries.set(SID, recoveryOn(MAIN, []));
    // An attach by its job id never reads the recovery, but sees the session run.
    expect(await decideIn(w, attach(SHORT))).toMatchObject(openUnder(X));
    expect(w.host.recoveries.size).toBe(0);
  });

  it('its job row there woken since the move was cut off: the recovery is stale, dropped, and nothing is brought back', async () => {
    // Woken by hand afterwards, its process gone since: the row reads running, not stopped.
    const w = world();
    w.host.row(MAIN, 'running', SID);
    w.host.recoveries.set(SID, recoveryOn(MAIN, []));
    // A --resume of a session that runs nowhere: Claude Code runs it in the foreground.
    expect(await decideIn(w, resume(SID))).toEqual({ kind: 'pass' });
    expect(w.host.calls).toEqual([]);
    expect(w.lines).toEqual([]);
    expect(w.host.recoveries.size).toBe(0);
  });
});

describe('routeBackgroundLaunch — rows of more than one conversation under one job id', () => {
  const NEW = '7a7a7a7a-1111-4222-8333-444444444444';

  it('running nowhere: refused with each conversation and where its row is, nothing removed', async () => {
    // The job moved on after /clear on the global slot; the folder profile kept a row of its
    // earlier conversation.
    const w = world();
    w.host.row(MAIN, 'stopped', SID, { resumeSessionId: NEW });
    w.host.row(X, 'failed', SID);
    const d = await decideIn(w, attach(SHORT));
    expect(d).toEqual({
      kind: 'refuse',
      message:
        `c5f2097e has job rows for more than one conversation (${NEW} on Shared (the global ` +
        `slot); ${SID} on Inc (the folder slot of C:/work)); resume the one you mean by its id: ` +
        'cctl claude --resume <id>.',
    });
    expect(w.host.calls).toEqual([]);
  });

  it("running after /clear: moved with its own rows, the earlier conversation's row left as it was", async () => {
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW });
    w.host.row(Q, 'stopped', SID);
    const d = await decideIn(w, attach(SHORT));
    expect(d).toMatchObject(openUnder(X, '7a7a7a7a'));
    expect(w.host.calls.filter((c) => c.startsWith('rm'))).toEqual([`rm main ${SHORT}`]);
    expect(w.host.rowsOf(SID)).toEqual([Q]);
    expect(w.host.rowsOf(NEW)).toEqual([X]);
  });
});

describe('Ctrl-C around a move', () => {
  it('is held only once the move commits: a move refused by its own checks holds nothing', async () => {
    const refused = world();
    refused.host.runs(MAIN);
    refused.host.agentsStatus = 'busy';
    await decideIn(refused, attach(SHORT));
    expect(refused.shields).toMatchObject({ n: 1, held: 0 });

    const moved = world();
    moved.host.runs(MAIN);
    await decideIn(moved, attach(SHORT));
    expect(moved.shields).toMatchObject({ n: 1, held: 1 });
  });
});

describe('routeBackgroundLaunch — which rows are traps', () => {
  const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
  const guardRef = (ref: string): BackgroundRequest => ({ verb: 'guard', ref });

  it('after /clear on the global slot, a stale profile row naming only the id the job started with is still a trap', async () => {
    // Claude Code's wake and rm reach a session by its job id, which /clear keeps.
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW, status: 'busy' });
    w.host.row(X, 'stopped');
    expect(await decideIn(w, GUARD)).toMatchObject({ kind: 'refuse' });
  });

  it("a session live in the registry that no service of cctl's lists still makes its row here a trap", async () => {
    const w = world();
    w.host.registry.push({
      pid: 4100,
      sessionId: SID,
      kind: 'bg',
      status: 'busy',
      jobId: SHORT,
      cwd: WORK,
    });
    w.host.row(X, 'stopped');
    const d = await routeBackgroundLaunch(GUARD, w.ctx, FOLLOW);
    expect(d.kind === 'refuse' && d.message).toContain('runs on another background service');
  });

  it('a trap check that cannot read the registry refuses rather than passes', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy' });
    w.host.row(X, 'stopped');
    w.host.failRegistry = 3;
    const d = await routeBackgroundLaunch(GUARD, w.ctx, FOLLOW);
    expect(d.kind === 'refuse' && d.message).toContain('cannot tell whether a background session');
  });

  it('a registry read caught mid-write is read again before the trap check answers', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy' });
    w.host.row(X, 'stopped');
    w.host.failRegistry = 1;
    const d = await routeBackgroundLaunch(GUARD, w.ctx, FOLLOW);
    expect(d.kind === 'refuse' && d.message).toContain('still holds a job row');
  });

  it('a row here that cannot be read is read again, and refuses with a retry hint while it cannot', async () => {
    // It could be the trap row itself: the picker, --continue and the agents view never pass on a
    // guess that it is not.
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy' });
    w.host.row(X, 'stopped');
    w.host.unreadableRowsIn.set(X, 3);
    expect(await routeBackgroundLaunch(GUARD, w.ctx, FOLLOW)).toEqual({
      kind: 'refuse',
      message:
        'cannot tell whether a background session would be taken from the service running it ' +
        `(its job row ${SHORT} there could not be read right now); try again in a moment.`,
    });
    // Read cleanly a moment later: the row is seen for the trap it is.
    w.host.unreadableRowsIn.set(X, 1);
    const d = await routeBackgroundLaunch(GUARD, w.ctx, FOLLOW);
    expect(d.kind === 'refuse' && d.message).toContain('still holds a job row');
  });

  it('a print-mode resume naming the trap session any way Claude Code could take it is refused', async () => {
    const trapWorld = (): World => {
      const w = world();
      w.host.runs(MAIN, SID, { name: 'bg eval', status: 'busy' });
      w.host.row(X, 'stopped', SID, { name: 'ok', resumeSessionId: NEW });
      w.host.titles.set(SID, 'feat x');
      return w;
    };
    // Its full id, its /clear id, a job id prefix, part of its name, the row's own name, its
    // title, its whole name.
    for (const ref of [SID, NEW, 'c5f2', 'eval', 'ok', 'feat x', 'bg eval']) {
      const d = await routeBackgroundLaunch(guardRef(ref), trapWorld().ctx, FOLLOW);
      expect({ ref, kind: d.kind }).toEqual({ ref, kind: 'refuse' });
    }
    expect(await routeBackgroundLaunch(guardRef('unrelated'), trapWorld().ctx, FOLLOW)).toEqual({
      kind: 'pass',
    });
  });
});

describe('routeBackgroundLaunch — every id a session has had', () => {
  const NEW = '7a7a7a7a-1111-4222-8333-444444444444';

  it('a stopped session is found by the conversation it ran after /clear', async () => {
    const w = world();
    w.host.row(X, 'stopped', SID, { resumeSessionId: NEW });
    expect(await decideIn(w, attach(NEW))).toMatchObject(openUnder(X));
  });

  it('an uppercase hex word is a name for Claude Code, never a job id prefix', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { name: 'BEEF', status: 'busy' });
    w.host.row(X, 'stopped', SID, { name: 'BEEF' });
    expect(await decideIn(w, attach('BEEF'))).toMatchObject(openUnder(MAIN));
  });

  it('after /clear, a prompt given with --resume reaches the conversation it moved, on the folder slot', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW });
    expect(await decideIn(w, resume(SID, ['carry on']))).toMatchObject({
      kind: 'open',
      configDir: X,
      args: ['--resume', NEW, 'carry on'],
    });
  });
});

describe('routeBackgroundLaunch — stop, rm, kill and respawn, read with care', () => {
  it('a session whose service cannot be told is not stopped on a guess', async () => {
    const w = world();
    // Live in the registry, but no roster of cctl's lists it; a row of it here.
    w.host.registry.push({
      pid: 4100,
      sessionId: SID,
      kind: 'bg',
      status: 'busy',
      jobId: SHORT,
      cwd: WORK,
    });
    w.host.row(X, 'stopped');
    const d = await routeBackgroundLaunch(control('stop', SHORT), w.ctx, FOLLOW);
    expect(d.kind === 'refuse' && d.message).toContain(
      "cannot tell which account's background service",
    );
  });

  it('the session is located for a stop while its move lock is held', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { status: 'busy' });
    let heldAtLook = false;
    w.host.beforeRegistry = (n) => {
      // Read 1 finds the session; the next ones are the look under the lock.
      if (n >= 2) heldAtLook = w.host.isLocked(SID);
    };
    await routeBackgroundLaunch(control('stop', SHORT), w.ctx, FOLLOW);
    expect(heldAtLook).toBe(true);
  });
});

describe('routeBackgroundLaunch — a --resume title, searched where Claude Code searches', () => {
  const TREE = 'C:/work/app/.claude/worktrees/feat';

  it('a session whose row records a worktree of this folder is in scope through that worktree', async () => {
    const w = world({}, { worktrees: [TREE] });
    w.host.runs(MAIN, SID, { cwd: OTHER, status: 'busy', worktreePath: TREE });
    w.host.titles.set(SID, 'feat x');
    expect(await decideIn(w, resume('feat x'))).toMatchObject(openUnder(MAIN));
  });

  it('a session that moved into this folder after it started is in scope by where its registry entry says it is', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { cwd: OTHER, status: 'busy' });
    w.host.registry[0]!.cwd = WORK;
    w.host.titles.set(SID, 'feat x');
    expect(await decideIn(w, resume('feat x'))).toMatchObject(openUnder(MAIN));
  });

  it('a session is in scope by where its service started it, whatever its rows say', async () => {
    const w = world();
    w.host.runs(MAIN, SID, { cwd: WORK, status: 'busy' });
    w.host.rows.get('main')!.get(SHORT)!.cwd = OTHER;
    w.host.registry[0]!.cwd = OTHER;
    w.host.titles.set(SID, 'feat x');
    expect(await decideIn(w, resume('feat x'))).toMatchObject(openUnder(MAIN));
  });

  it('after /clear, the title of the conversation it runs now is matched', async () => {
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
    const w = world();
    w.host.runs(MAIN, SID, { current: NEW, status: 'busy' });
    w.host.titles.set(NEW, 'next step');
    expect(await decideIn(w, resume('next step'))).toMatchObject(openUnder(MAIN));
  });

  it('an ordinary conversation with the same title in a worktree of this folder makes the title ambiguous; one elsewhere does not', async () => {
    const OLD = '11111111-2222-4333-8444-555555555555';
    const inTree = world({}, { worktrees: [TREE] });
    inTree.host.runs(MAIN, SID, { status: 'busy' });
    inTree.host.row(X, 'stopped');
    inTree.host.titles.set(SID, 'bg eval');
    inTree.host.plainTitles.set(OLD, 'bg eval');
    inTree.host.plainFolders.set(OLD, TREE);
    const d = await decideIn(inTree, resume('bg eval'));
    expect(d.kind === 'refuse' && d.message).toContain('names more than one session');

    // Filed under a folder Claude Code does not search from here: the title names one session.
    const elsewhere = world({}, { worktrees: [TREE] });
    elsewhere.host.runs(MAIN, SID, { status: 'busy' });
    elsewhere.host.titles.set(SID, 'bg eval');
    elsewhere.host.plainTitles.set(OLD, 'bg eval');
    elsewhere.host.plainFolders.set(OLD, OTHER);
    expect(await decideIn(elsewhere, resume('bg eval'))).toMatchObject(openUnder(MAIN));
  });
});

describe('routeBackgroundLaunch — what a start that runs nowhere says', () => {
  it('a start whose way back fails too says how to bring it back, from what the move saved', async () => {
    const w = world();
    w.host.row(MAIN, 'stopped', SID, {
      saved: { kind: 'replayable', options: ['--model=opus'] },
    });
    w.host.failResumeIn.add(X);
    w.host.failResumeIn.add('main');
    const d = await decideIn(w, attach(SHORT));
    expect(d.kind === 'refuse' && d.message).toContain(
      `Bring it back with: cctl claude --resume ${SID}`,
    );
    expect(w.host.recoveries.get(SID)).toEqual({
      configDir: MAIN,
      sessionId: SID,
      job: { short: SHORT, sessionId: SID },
      options: ['--model=opus'],
      cwd: WORK,
    });
  });

  it('a row elsewhere that cannot be removed before the open is said', async () => {
    const w = world();
    w.host.row(X, 'stopped');
    w.host.row(MAIN, 'stopped');
    w.host.failRemoveIn.add('main');
    await decideIn(w, attach(SHORT));
    expect(w.lines.join('\n')).toContain('could not remove the job row');
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
  it('no arrangement of where it runs, its rows, /clear, names, titles, folders, failures, locks and the slot ever lets it be taken', async () => {
    const NEW = '7a7a7a7a-1111-4222-8333-444444444444';
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
      // A quarter of the time the job moved on to a new conversation with /clear.
      const cleared = r(4) === 0;
      // One row at most records the worktree: the one of the config dir that started the session
      // with it (measured: a resume elsewhere records none).
      let treeTaken = place !== undefined && tree !== undefined;
      const withTree = (): boolean => {
        if (treeTaken || tree === undefined || r(10) !== 0) return false;
        treeTaken = true;
        return true;
      };
      if (place !== undefined) {
        const status = pick(statuses);
        w.host.runs(place, SID, {
          cwd,
          name: 'bg eval',
          saved,
          ...(cleared ? { current: NEW } : {}),
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
          // A row elsewhere of the cleared job: written before the clear, or after it.
          const resumed = cleared ? pick([undefined, NEW, SID]) : undefined;
          w.host.row(c, state, SID, {
            cwd,
            saved: pick(saves),
            ...(resumed !== undefined ? { resumeSessionId: resumed } : {}),
            ...(withTree() && tree !== undefined ? { worktreePath: tree } : {}),
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
      // Its new conversation's id names it only once it has one.
      const req = pick(
        cleared ? [...requests, attach(NEW), resume(NEW), resume(NEW, ['carry on'])] : requests,
      );
      const mode = pick(modes);
      let d: RouteDecision;
      try {
        d = await decideIn(w, req, mode);
      } catch (err) {
        // Named by its seed, so the arrangement can be replayed alone.
        throw new Error(
          `arrangement ${seed} (${JSON.stringify({ req, mode, place, cleared })}): ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
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
