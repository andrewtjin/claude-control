// An in-memory host for the background-session tests: services per config dir, a job row per config
// dir, one shared registry, every command logged. It stands in for the real host (cli's
// backgroundHost.ts) over a Claude Code that behaves as the binary was measured to (2.1.295 and
// 2.1.296): a stop takes the session out of its service and leaves its row stopped (a failed one
// failed); a resume while the session runs anywhere starts a copy (refused here); a resume with
// options over a row is refused; a first resume in a config dir writes a row saved with the options
// given; `rm` deletes a row. Like the real host, it never runs an rm Claude Code would turn into a
// kill or a worktree deletion: it refuses a row that records a worktree, one that cannot be read
// right now, one that reads starting, and one whose session is live or starting anywhere (by the
// registry, the way Claude Code's rm reaches it, or by any service's roster). Reads can be made
// verified, as the real host's are: a roster record whose pid was reused is listed only by an
// unverified read. Each command can be made to fail. Test support only: nothing in the product
// imports it.

import type {
  BackgroundSession,
  BackgroundSessionHost,
  JobRow,
  LiveSession,
  ResumeRecovery,
  RowRead,
  SavedLaunch,
  SessionActivity,
  SessionLock,
} from './backgroundMove.js';

/** One config dir's row for a session, with what it saved. */
export interface FakeRow {
  sessionId: string;
  resumeSessionId?: string;
  state: string;
  name?: string;
  cwd?: string;
  updatedAt?: string;
  worktreePath?: string;
  pending?: boolean;
  saved: SavedLaunch;
  /** Caught mid-write: it cannot be read right now. */
  unreadable?: boolean;
}

/** Where a config dir is named in the log: `null` is the main config dir. */
const named = (configDir: string | null): string => String(configDir);

export class FakeBackgroundHost implements BackgroundSessionHost {
  readonly calls: string[] = [];
  /** Every config dir with a service, the main one first. */
  readonly dirs: Array<string | null>;
  readonly hosted = new Map<string | null, BackgroundSession[]>();
  /** Roster records whose pid now names another process: only an unverified read lists them. */
  readonly reusedPids = new Map<string | null, BackgroundSession[]>();
  /** What `claude agents` reports, by short id. */
  readonly states = new Map<string, SessionActivity>();
  /** Each config dir's rows, by short id. */
  readonly rows = new Map<string | null, Map<string, FakeRow>>();
  /** Registry entries beyond the ones the hosted sessions give (a terminal, a stale file). */
  readonly extraEntries: LiveSession[] = [];
  /** The conversation a hosted job runs now, by short id, when /clear moved it on. */
  readonly currentIds = new Map<string, string>();
  /** Config dirs a terminal has a session of open in. */
  readonly attachedIn = new Set<string | null>();
  /** Ids whose move lock another process holds. */
  readonly lockedElsewhere = new Set<string>();
  /** Ids whose move lock is held here now, taken and not yet released. */
  readonly heldLocks = new Set<string>();
  /** Ids whose move lock cannot be let go (its directory still held open): a release throws and
   *  the lock stays held, as one left on disk does until it lapses. */
  readonly failRelease = new Set<string>();
  /** Every lock taken and released, in order. */
  readonly locks: string[] = [];
  /** The recoveries a move saved, by the conversation it resumes. */
  readonly recoveries = new Map<string, ResumeRecovery>();
  failAttached = false;
  failListing = false;
  failRegistry = false;
  failActivity = false;
  failStop = false;
  failSaveRecovery = false;
  /** A stop that Claude Code takes but the host does not see through: it rejects after stopping. */
  stopNotSeenThrough = false;
  /** A stop after which the session is still hosted (slow to exit, or respawned): with
   *  {@link stopNotSeenThrough} the stop rejects so, without it, it resolves so. */
  stopKeepsHosted = false;
  /** Config dirs whose `rm` fails. */
  readonly failRemoveIn = new Set<string | null>();
  /** Config dirs whose resume fails. */
  readonly failResumeIn = new Set<string | null>();
  /** Config dirs whose next N resumes start a copy instead (then they work). */
  readonly copyResumesIn = new Map<string | null, number>();
  /** Config dirs whose resume "succeeds" but never shows the session hosted. */
  readonly silentResumeIn = new Set<string | null>();
  /** Config dirs whose resumed session shows up only on the Nth roster read after the resume. */
  readonly showOnReadIn = new Map<string | null, number>();
  /** Runs before every roster read, to change what is hosted between two looks. */
  beforeList: ((configDir: string | null) => void) | undefined;
  private readonly pendingReads = new Map<string | null, number>();
  private nextPid = 4000;

  constructor(dirs: Array<string | null>) {
    this.dirs = dirs;
  }

  /** Host a session in a config dir's service, with what Claude Code reports it doing, and a row
   *  there in state `running` (saved as `row.saved`, by default with no options). */
  add(
    configDir: string | null,
    s: BackgroundSession,
    activity: SessionActivity,
    row: Partial<FakeRow> = {},
  ): void {
    this.hosted.set(configDir, [...(this.hosted.get(configDir) ?? []), s]);
    this.states.set(s.short, activity);
    this.setRow(configDir, s.short, {
      sessionId: s.sessionId,
      state: 'running',
      cwd: s.cwd,
      saved: { kind: 'replayable', options: [] },
      ...row,
    });
  }

  setRow(configDir: string | null, short: string, row: FakeRow): void {
    const rows = this.rows.get(configDir) ?? new Map<string, FakeRow>();
    rows.set(short, row);
    this.rows.set(configDir, rows);
  }

  rowOf(configDir: string | null, short: string): FakeRow | undefined {
    return this.rows.get(configDir)?.get(short);
  }

  /** Every config dir holding a row for a session id (as started with, or run now). */
  rowsFor(sessionId: string): Array<string | null> {
    return this.dirs.filter((c) =>
      [...(this.rows.get(c)?.values() ?? [])].some(
        (r) => r.sessionId === sessionId || r.resumeSessionId === sessionId,
      ),
    );
  }

  /** Every config dir hosting a session (by short id or session id). */
  hostsOf(key: string): Array<string | null> {
    return this.dirs.filter((c) =>
      (this.hosted.get(c) ?? []).some((s) => s.short === key || s.sessionId === key),
    );
  }

  configDirs(): Promise<Array<string | null>> {
    return Promise.resolve([...this.dirs]);
  }

  listHosted(
    configDir: string | null,
    opts?: { verified?: boolean },
  ): Promise<BackgroundSession[]> {
    this.calls.push(`list ${named(configDir)}`);
    this.beforeList?.(configDir);
    if (this.failListing) return Promise.reject(new Error('roster unreadable'));
    const pending = this.pendingReads.get(configDir);
    if (pending !== undefined && pending > 1) {
      this.pendingReads.set(configDir, pending - 1);
      return Promise.resolve([]);
    }
    this.pendingReads.delete(configDir);
    const reused = opts?.verified === true ? [] : (this.reusedPids.get(configDir) ?? []);
    return Promise.resolve([...(this.hosted.get(configDir) ?? []), ...reused]);
  }

  liveSessions(): Promise<LiveSession[]> {
    if (this.failRegistry) return Promise.reject(new Error('a registry entry is mid-write'));
    const out: LiveSession[] = [];
    for (const c of this.dirs) {
      for (const s of this.hosted.get(c) ?? []) {
        const activity = this.states.get(s.short);
        out.push({
          pid: this.nextPid + out.length,
          sessionId: this.currentIds.get(s.short) ?? s.sessionId,
          kind: 'bg',
          ...(activity !== undefined ? { status: activity.idle ? 'idle' : 'busy' } : {}),
          jobId: s.short,
          cwd: s.cwd,
        });
      }
    }
    return Promise.resolve([...out, ...this.extraEntries]);
  }

  activity(configDir: string | null): Promise<Map<string, SessionActivity>> {
    this.calls.push(`activity ${named(configDir)}`);
    if (this.failActivity) return Promise.reject(new Error('agents failed'));
    // Claude Code lists the rows of this config dir only.
    const out = new Map<string, SessionActivity>();
    for (const short of this.rows.get(configDir)?.keys() ?? []) {
      const state = this.states.get(short);
      if (state !== undefined) out.set(short, state);
    }
    return Promise.resolve(out);
  }

  attachedNow(configDir: string | null): Promise<boolean> {
    this.calls.push(`attached ${named(configDir)}`);
    if (this.failAttached) return Promise.reject(new Error('journal unreadable'));
    return Promise.resolve(this.attachedIn.has(configDir));
  }

  stop(configDir: string | null, short: string): Promise<void> {
    this.calls.push(`stop ${named(configDir)} ${short}`);
    if (this.failStop) return Promise.reject(new Error('stop refused'));
    if (!this.stopKeepsHosted) this.unhost(configDir, short);
    const row = this.rowOf(configDir, short);
    // A failed row stays failed (measured); any other is left stopped.
    if (row !== undefined && row.state !== 'failed') row.state = 'stopped';
    if (this.stopNotSeenThrough) {
      return Promise.reject(new Error('it was still running 10s after claude stop'));
    }
    return Promise.resolve();
  }

  private unhost(configDir: string | null, short: string): void {
    this.hosted.set(
      configDir,
      (this.hosted.get(configDir) ?? []).filter((s) => s.short !== short),
    );
  }

  private toJobRow(short: string, r: FakeRow): JobRow {
    return {
      short,
      sessionId: r.sessionId,
      state: r.state,
      pending: r.pending === true,
      ...(r.resumeSessionId !== undefined ? { resumeSessionId: r.resumeSessionId } : {}),
      ...(r.name !== undefined ? { name: r.name } : {}),
      ...(r.cwd !== undefined ? { cwd: r.cwd } : {}),
      ...(r.updatedAt !== undefined ? { updatedAt: r.updatedAt } : {}),
      ...(r.worktreePath !== undefined ? { worktreePath: r.worktreePath } : {}),
    };
  }

  jobRows(configDir: string | null): Promise<JobRow[]> {
    const out: JobRow[] = [];
    for (const [short, r] of this.rows.get(configDir) ?? []) {
      if (r.unreadable !== true) out.push(this.toJobRow(short, r));
    }
    return Promise.resolve(out);
  }

  jobRow(configDir: string | null, short: string): Promise<RowRead> {
    const r = this.rowOf(configDir, short);
    if (r === undefined) return Promise.resolve({ kind: 'none' });
    if (r.unreadable === true) return Promise.resolve({ kind: 'unreadable' });
    return Promise.resolve({ kind: 'row', row: this.toJobRow(short, r) });
  }

  savedOptions(configDir: string | null, short: string): Promise<SavedLaunch> {
    this.calls.push(`options ${named(configDir)} ${short}`);
    const r = this.rowOf(configDir, short);
    if (r === undefined) return Promise.resolve({ kind: 'none' });
    if (r.unreadable === true) return Promise.resolve({ kind: 'unreadable' });
    return Promise.resolve(r.saved);
  }

  resumeIdle(input: {
    configDir: string | null;
    sessionId: string;
    short: string;
    cwd: string;
    options?: string[];
  }): Promise<void> {
    const c = input.configDir;
    this.calls.push(
      `resume ${named(c)} ${input.sessionId} ${input.cwd}` +
        (input.options === undefined ? '' : ` [${input.options.join(' ')}]`),
    );
    const row = this.rowOf(c, input.short);
    if (input.options !== undefined && row !== undefined) {
      return Promise.reject(new Error('that config dir already holds a job row for it'));
    }
    if (this.failResumeIn.has(c)) return Promise.reject(new Error('untrusted'));
    const copiesLeft = this.copyResumesIn.get(c) ?? 0;
    // Live anywhere: Claude Code starts a copy instead.
    if (copiesLeft > 0 || this.hostsOf(input.short).length > 0) {
      if (copiesLeft > 0) this.copyResumesIn.set(c, copiesLeft - 1);
      return Promise.reject(new Error('claude started a copy (5ad47a09) instead of resuming it'));
    }
    // Woken by the id its job started with, a row runs the conversation it ran last (after /clear,
    // not that id), and its worker records that conversation under the row's job id, as Claude
    // Code wakes a row (measured).
    const conversation = row?.resumeSessionId ?? input.sessionId;
    if (row === undefined) {
      this.setRow(c, input.short, {
        sessionId: input.sessionId,
        state: 'running',
        cwd: input.cwd,
        saved: { kind: 'replayable', options: [...(input.options ?? [])] },
      });
    } else {
      row.state = 'running';
      if (conversation !== row.sessionId) this.currentIds.set(input.short, conversation);
    }
    if (!this.silentResumeIn.has(c)) {
      this.hosted.set(c, [
        ...(this.hosted.get(c) ?? []),
        { short: input.short, sessionId: conversation, cwd: input.cwd },
      ]);
      this.states.set(input.short, { idle: true });
      const reads = this.showOnReadIn.get(c);
      if (reads !== undefined) this.pendingReads.set(c, reads);
    }
    return Promise.resolve();
  }

  async removeRow(configDir: string | null, short: string): Promise<void> {
    this.calls.push(`rm ${named(configDir)} ${short}`);
    const row = this.rowOf(configDir, short);
    if (row === undefined) return;
    if (row.unreadable === true) throw new Error('its job row could not be read right now');
    if (row.worktreePath !== undefined) {
      throw new Error('it records a worktree, which claude rm would delete');
    }
    if (row.state === 'starting')
      throw new Error('its session is starting, and claude rm would kill it');
    // Live by the registry (Claude Code's rm reaches its job id or either of its ids) or starting
    // in any service (listed before its registry entry is written).
    const ids = [row.sessionId, row.resumeSessionId];
    const live = (await this.liveSessions()).some(
      (e) => e.kind === 'bg' && (e.jobId === short || ids.includes(e.sessionId)),
    );
    if (live || this.hostsOf(short).length > 0 || this.hostsOf(row.sessionId).length > 0) {
      throw new Error('its session is live, and claude rm would kill it');
    }
    if (this.failRemoveIn.has(configDir)) throw new Error('rm refused');
    this.rows.get(configDir)?.delete(short);
  }

  lockSession(sessionId: string, waitMs: number): Promise<SessionLock | undefined> {
    if (this.lockedElsewhere.has(sessionId) || this.heldLocks.has(sessionId)) {
      return Promise.resolve(undefined);
    }
    this.heldLocks.add(sessionId);
    this.locks.push(`take ${sessionId} ${waitMs}`);
    let released = false;
    return Promise.resolve({
      release: () => {
        if (released) return;
        released = true;
        if (this.failRelease.has(sessionId)) {
          this.locks.push(`stuck ${sessionId}`);
          throw Object.assign(new Error(`EBUSY: resource busy, rmdir '${sessionId}'`), {
            code: 'EBUSY',
          });
        }
        this.heldLocks.delete(sessionId);
        this.locks.push(`release ${sessionId}`);
      },
    });
  }

  saveRecovery(recovery: ResumeRecovery): Promise<void> {
    this.calls.push(`save ${recovery.sessionId}`);
    if (this.failSaveRecovery) return Promise.reject(new Error('disk full'));
    this.recoveries.set(recovery.sessionId, recovery);
    return Promise.resolve();
  }

  dropRecovery(sessionId: string): Promise<void> {
    this.calls.push(`drop ${sessionId}`);
    this.recoveries.delete(sessionId);
    return Promise.resolve();
  }
}
