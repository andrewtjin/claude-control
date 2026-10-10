// One move of a Claude Code background session from one config dir's service to another's.
//
// Claude Code hosts background sessions (`claude --bg`) in a background service of its own, one per
// config dir (keyed on CLAUDE_CONFIG_DIR), and a session's account is the config dir that hosts it.
// Every folder profile shares `projects/` (the conversations) with the main config dir, so a
// background session stopped in one service and resumed by its full id in another continues the same
// conversation on the other config dir's account — measured against the real binary (2.1.295):
//   - resuming with no prompt leaves it idle ("send a prompt to start"); no turn is spent;
//   - resuming while it is still live anywhere starts a COPY under a new id, so it is stopped first,
//     and Claude Code's stop returns a moment before the session has exited;
//   - each config dir keeps a JOB ROW for a session it ran (`jobs/<short>/state.json`), and a row
//     left behind is a trap: any command under that config dir that wakes, stops or removes the row
//     (`claude attach`, an interactive `--resume`, `claude stop`, `claude rm`, the agents view)
//     reaches the session wherever it runs now, killing it there, mid-turn included. So a session
//     has a row only in the config dir where it runs or last ran: a move removes every row the
//     session has (`claude rm`, measured to delete the row and keep the conversation) while the
//     session runs nowhere, between the stop and the resume;
//   - `claude rm` also deletes a git worktree Claude Code made for the session and recorded on the
//     row, so a session that has one is never moved: it stays where it runs;
//   - a first resume in a config dir does not inherit the source's saved options, so they are passed
//     explicitly, ALL of them: a session started with restrictions (a tool deny list, a settings
//     file) must not come back without them. One holding anything a move cannot carry over is not
//     moved at all. The same options carry it back when a move fails;
//   - `/clear` in a background session starts a new conversation in the same job: the shared session
//     registry then names the new id (with the job's short id), while the roster and the row keep the
//     id the job started with and the row records the new one as `resumeSessionId`. A move resumes
//     the CURRENT conversation, which then runs under a job named after it;
//   - a session waiting on a scheduled wakeup or running background work is reported idle, but its
//     row records the work (`inFlight`); a stop would drop it, so such a session is not moved.
//
// Two callers move sessions, and both go through {@link moveBackgroundSession} so a session moves on
// the same terms whoever moves it: the daemon's background mover (backgroundMover.ts), which decides
// every poll cycle WHEN and WHICH, and `cctl claude`, which moves a session the operator opens from a
// ruled folder. They can reach the same session at the same moment, so each holds the session's
// cross-process move lock ({@link BackgroundSessionHost.lockSession}) around a move, and a move first
// reads again where the session runs. HOW is the injected {@link BackgroundSessionHost}, the one seam
// to Claude Code's own commands and files, so every decision here is testable without a Claude Code
// binary.

import { folderUniquenessKey, type Logger } from '@claude-control/switch-engine';
import { assessFleet, type AccountUsageInput } from '@claude-control/usage-advisor';

/** A full Claude Code session id, as Claude Code writes it (lowercase). */
export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A job's short id: the first 8 hex digits of the session id the job started with. */
export const JOB_ID_PATTERN = /^[0-9a-f]{8}$/;

/** One background session as a config dir's Claude Code service hosts it. */
export interface BackgroundSession {
  /** Its job's short id in the service that hosts it. */
  short: string;
  /** The session id the job started with (the roster's and the row's; see the header on /clear). */
  sessionId: string;
  /** Its working directory: which folder rule applies, and where a resume must run. */
  cwd: string;
}

/** What Claude Code reports a session doing right now. */
export interface SessionActivity {
  /** Between turns (Claude Code reports it idle). Anything else is never stopped. */
  idle: boolean;
  /** Claude Code's name for it, when it has one, for the operator's notice. */
  name?: string;
}

/**
 * What a config dir's job row saved for a session, as a move would carry it over:
 *   - `none`: the config dir holds no row for it;
 *   - `unreadable`: it holds one that cannot be read right now;
 *   - `replayable`: every saved option, in a canonical spelling;
 *   - `unreplayable`: the row holds something a move cannot carry over (`reason` says what, without
 *     repeating anything the session was told), so moving it would quietly change the session.
 */
export type SavedLaunch =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'replayable'; options: string[] }
  | { kind: 'unreplayable'; reason: string };

/** One job row a config dir holds (`jobs/<short>/state.json`). */
export interface JobRow {
  short: string;
  /** The session id the job started with. */
  sessionId: string;
  /** The conversation the job runs now, when /clear moved it on from `sessionId`. */
  resumeSessionId?: string;
  /** Claude Code's state for it: `running`, `working`, `stopped`, `failed`, ... */
  state: string;
  name?: string;
  cwd?: string;
  /** When the row last changed (ISO 8601), to tell the latest of several apart. */
  updatedAt?: string;
  /** A git worktree Claude Code made for the session: `claude rm` deletes it with the row. */
  worktreePath?: string;
  /** Work the session holds between turns (a scheduled wakeup, a background task, a queued
   *  prompt): it reports idle all the same, and a stop would drop the work. */
  pending: boolean;
}

/** One config dir's row for one short id: none, one that cannot be read right now, or the row. */
export type RowRead = { kind: 'none' } | { kind: 'unreadable' } | { kind: 'row'; row: JobRow };

/** A job row and the config dir that holds it (`null` is the main config dir). */
export interface LocatedRow {
  configDir: string | null;
  row: JobRow;
}

/** One live entry of Claude Code's shared session registry (`sessions/<pid>.json`). */
export interface LiveSession {
  /** The session process. Only entries whose process is alive (and is the one recorded) are
   *  returned. */
  pid: number;
  /** The conversation it runs now. */
  sessionId: string;
  /** `bg` for a session a background service hosts, `interactive` for one open in a terminal. */
  kind: string;
  /** `idle` between turns, `busy` in one, `waiting` on a prompt; absent while it starts. */
  status?: string;
  /** A background session's job short id. */
  jobId?: string;
  name?: string;
  cwd?: string;
}

/** A held move lock for one session. Released exactly once by whoever took it. */
export interface SessionLock {
  release(): void;
}

/**
 * The seam to Claude Code's background services. A config dir of `null` is the main config dir —
 * the global slot — exactly as the daemon itself resolves it.
 */
export interface BackgroundSessionHost {
  /** Every config dir with a background service a session of cctl's can run in: the main one
   *  (`null`) first, then each folder profile, including those of rules since removed. */
  configDirs(): Promise<Array<string | null>>;
  /**
   * The background sessions the service of a config dir hosts right now; empty when no service
   * ever ran there. Rejects when its roster exists but cannot be read right now, so a torn read is
   * never taken for "hosts nothing". Cheap (no Claude Code process), so it is read every cycle;
   * `verified` also checks each process against the start time Claude Code recorded for it (a pid
   * reused by another process is not the session), which costs a process query.
   */
  listHosted(configDir: string | null, opts?: { verified?: boolean }): Promise<BackgroundSession[]>;
  /** Every live entry of the shared session registry, each process checked against the start time
   *  Claude Code recorded for it. Rejects when an entry of a live process cannot be read. */
  liveSessions(): Promise<LiveSession[]>;
  /** What each session is doing, by short id, as a config dir's Claude Code reports it. Asks Claude
   *  Code itself, so it is read only when there is a session to move. */
  activity(configDir: string | null): Promise<Map<string, SessionActivity>>;
  /** Whether a terminal has a background session of a config dir's service open right now. Claude
   *  Code does not say which one, and reports an open session as idle all the same. */
  attachedNow(configDir: string | null): Promise<boolean>;
  /** Stop a hosted session, resolving once it has exited (Claude Code's own stop returns a moment
   *  before the session does, and a resume in that moment would start a copy). Rejects when Claude
   *  Code refuses, or when the session is still running a while after the stop. */
  stop(configDir: string | null, short: string): Promise<void>;
  /** Every readable job row a config dir holds. Rejects when its jobs dir cannot be listed. */
  jobRows(configDir: string | null): Promise<JobRow[]>;
  /** One config dir's row for a short id. */
  jobRow(configDir: string | null, short: string): Promise<RowRead>;
  /** What a config dir's job row saved for a session (see {@link SavedLaunch}). */
  savedOptions(configDir: string | null, short: string): Promise<SavedLaunch>;
  /**
   * Resume a session by its full id in a config dir's service, idle (no prompt), from its cwd.
   * Without `options`, the session wakes with the saved options of the row that config dir holds
   * for it. With `options`, that config dir must hold no row for `short` (a row there would keep its
   * own options and start a copy); the call rejects rather than run over one. Rejects when Claude
   * Code refuses, or starts a copy instead.
   */
  resumeIdle(input: {
    configDir: string | null;
    sessionId: string;
    short: string;
    cwd: string;
    options?: string[];
  }): Promise<void>;
  /** Remove a config dir's job row (`claude rm <short>`), keeping the conversation. Refuses a row
   *  that records a worktree (rm would delete it) or whose session is live, and resolves at once
   *  when there is no row. */
  removeRow(configDir: string | null, short: string): Promise<void>;
  /**
   * Take the cross-process lock that serializes moves of one session (the daemon and `cctl claude`
   * are separate processes), waiting up to `waitMs` for a holder to let go. Resolves `undefined`
   * when another process still holds it then. A holder that died leaves no lock behind.
   */
  lockSession(sessionId: string, waitMs: number): Promise<SessionLock | undefined>;
  /** The command an operator runs to resume a session idle under a config dir by hand, naming the
   *  config dir the way this host reaches it. */
  resumeHint(configDir: string | null, sessionId: string, options: readonly string[]): string;
}

/** One end of a move: a config dir and the slot it is, in words. */
export interface MoveEnd {
  /** The config dir whose service hosts the session (the source) or is to host it (the target);
   *  `null` is the main config dir. */
  configDir: string | null;
  /** The slot in words, for reasons: "the global slot", "C:/research's slot". */
  name: string;
}

export interface MoveRequest {
  session: BackgroundSession;
  from: MoveEnd;
  to: MoveEnd;
  /** Set for a session that runs nowhere (`cctl claude` opening a stopped one): it is started under
   *  the target from its row on `from`, instead of stopped there first. */
  start?: boolean;
  /** The platform config dirs are compared by (default: this process's). */
  platform?: NodeJS.Platform;
}

/** The timing of a move, injectable so tests need not wait. */
export interface MoveTiming {
  /** A monotonic clock in ms. Everything it measures is a duration (the confirm window), and wall
   *  time steps on some boxes: stepped back, it would hold the caller in a confirm loop for as long
   *  as the step. */
  clock: () => number;
  /** How long a resume may take to show up in the target service's roster. */
  confirmTimeoutMs: number;
  /** Pause between roster reads while confirming, and between tries of a way back. */
  sleep: (ms: number) => Promise<void>;
  logger: Logger;
}

/** Why a session was left where it was, with nothing touched. */
export type NotMovedCause =
  /** It is no longer where the caller found it (moved, stopped or started meanwhile). */
  | 'gone'
  /** Where it runs, or its rows, could not be read right now. */
  | 'unknown'
  /** What it is doing could not be read. */
  | 'activity'
  /** It is in a turn, waiting on a prompt, holding work between turns, or not in Claude Code's
   *  listing. */
  | 'busy'
  /** A terminal has a background session of its service open. */
  | 'attached'
  /** It works in a git worktree Claude Code made for it. */
  | 'worktree'
  /** It cannot move without changing (its options), or its row cannot be read right now. */
  | 'options';

/** How to bring a session back by hand when a failed move could not: resume it under `configDir`
 *  with these options (see {@link BackgroundSessionHost.resumeHint}). */
export interface ResumeRecovery {
  configDir: string | null;
  sessionId: string;
  options: string[];
}

/** What one move did. `name` is Claude Code's name for the session, when it was read. */
export type MoveResult =
  | {
      result: 'moved';
      /** The job's short id in the target, which names the conversation it runs now. */
      short: string;
      /** That conversation's id. */
      sessionId: string;
      name?: string;
      /** How many saved options it was resumed with. */
      replayed: number;
    }
  | {
      result: 'not-moved';
      cause: NotMovedCause;
      /** True when nothing about the session will change it (its saved options, its worktree);
       *  false when a later try may find it movable. */
      final: boolean;
      reason: string;
      name?: string;
    }
  | {
      result: 'failed';
      /** Whether it was put back where it was. */
      restored: boolean;
      reason: string;
      name?: string;
      recovery: ResumeRecovery;
    };

/** Where a session runs right now (see {@link whereRuns}). */
export type SessionWhere =
  /** Open in a terminal (a foreground Claude Code holds it). */
  | { kind: 'interactive'; pid: number; cwd?: string }
  /** Hosted by exactly one service of cctl's. */
  | {
      kind: 'bg';
      configDir: string | null;
      /** Its job's short id there. */
      short: string;
      /** The session id that job started with. */
      sessionId: string;
      /** The conversation it runs now (differs from `sessionId` after /clear). */
      currentId: string;
      status?: string;
      cwd: string;
    }
  | { kind: 'nowhere' }
  /** The registry and the rosters disagree, or one could not be read: nothing is done on a guess. */
  | { kind: 'unclear'; reason: string };

/** Every id and job id a session has had: the ids it started with and moved on to after /clear,
 *  and the job ids each config dir knows it by. */
export interface Lineage {
  ids: ReadonlySet<string>;
  shorts: ReadonlySet<string>;
}

/** Claude Code's resume returns once the session is dispatched; its worker shows up in the roster
 *  within a second or two on a loaded box. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 15_000;
const CONFIRM_POLL_MS = 500;
/** How many times a failed move tries to resume the session back where it was, and the pause
 *  between tries. Right after a stop, Claude Code can still count the session as open or running
 *  and start a copy instead; that clears within moments, so one immediate try is not enough. */
const PUT_BACK_TRIES = 3;
const PUT_BACK_PAUSE_MS = 2_000;
/** How many times {@link settledWhere} reads again when the registry and the rosters disagree for
 *  a moment (a session starting or stopping, a file caught mid-write), and the pause between. */
const WHERE_TRIES = 3;
const WHERE_PAUSE_MS = 500;
/** How long a job row must have been left alone before a move trusts what it says. */
const ROW_QUIET_MS = 1_500;

/** A thrown value as one line. */
export function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How a session is named to the operator: its name and short id, or the short id alone. */
export function sessionLabel(short: string, name: string | undefined): string {
  return name !== undefined && name.length > 0 && name !== short ? `"${name}" (${short})` : short;
}

/** Whether two config dirs are the same one (null is the main config dir), however each is
 *  spelled: separators, a trailing separator, and case on Windows. */
export function sameConfigDir(
  a: string | null,
  b: string | null,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (a === null || b === null) return a === b;
  return folderUniquenessKey(a, platform) === folderUniquenessKey(b, platform);
}

/**
 * Whether a ruled folder's slot is one its background sessions move onto right now: its rule
 * includes accounts, one of them is live in the slot, and that account can take work by the usage
 * given. Usage read with no limits recorded counts as able (an account never polled holds an
 * untouched allowance); usage not known at all (`undefined`: not polled this cycle, or its record
 * could not be read) does not. A folder in fallback on a shared account, or whose included account
 * is out, is not a target: a move there would gain nothing. An exclude-only rule prefers no
 * account, so it never is.
 */
export function isMoveTarget(
  include: readonly string[],
  liveAccountId: string | null,
  usage: AccountUsageInput | undefined,
  nowMs: number,
): liveAccountId is string {
  if (include.length === 0 || liveAccountId === null || !include.includes(liveAccountId)) {
    return false;
  }
  return usage !== undefined && assessFleet([usage], nowMs).accounts[0]!.usable;
}

/** Every readable job row every config dir holds. Rejects when a jobs dir cannot be listed. */
export async function allRows(host: BackgroundSessionHost): Promise<LocatedRow[]> {
  const out: LocatedRow[] = [];
  for (const configDir of await host.configDirs()) {
    for (const row of await host.jobRows(configDir)) out.push({ configDir, row });
  }
  return out;
}

/**
 * A session's lineage, grown from what is known of it to everything linked to it: a row links the
 * job id it is filed under, the id the job started with and the conversation it runs now; a live
 * background entry links its job id and its conversation. Rows in two config dirs filed under the
 * same job id are the same session (a job id is the start of the session id it was made from).
 */
export function lineageOf(
  seed: { ids: readonly string[]; shorts: readonly string[] },
  rows: readonly LocatedRow[],
  live: readonly LiveSession[] = [],
): Lineage {
  const ids = new Set(seed.ids);
  const shorts = new Set(seed.shorts);
  for (let grew = true; grew;) {
    grew = false;
    const add = (set: Set<string>, value: string | undefined): void => {
      if (value !== undefined && !set.has(value)) {
        set.add(value);
        grew = true;
      }
    };
    for (const { row } of rows) {
      const linked =
        shorts.has(row.short) ||
        ids.has(row.sessionId) ||
        (row.resumeSessionId !== undefined && ids.has(row.resumeSessionId));
      if (!linked) continue;
      add(shorts, row.short);
      add(ids, row.sessionId);
      add(ids, row.resumeSessionId);
    }
    for (const entry of live) {
      if (entry.kind !== 'bg' || entry.jobId === undefined) continue;
      if (!shorts.has(entry.jobId) && !ids.has(entry.sessionId)) continue;
      add(shorts, entry.jobId);
      add(ids, entry.sessionId);
    }
  }
  return { ids, shorts };
}

/** The rows of a session's lineage. */
export function rowsOf(lineage: Lineage, rows: readonly LocatedRow[]): LocatedRow[] {
  return rows.filter(
    ({ row }) =>
      lineage.shorts.has(row.short) ||
      lineage.ids.has(row.sessionId) ||
      (row.resumeSessionId !== undefined && lineage.ids.has(row.resumeSessionId)),
  );
}

/**
 * Where a session runs right now, in one verified look: the shared registry (open in a terminal,
 * or live as a background session) and every config dir's roster (which service hosts it), each
 * process checked against the start time Claude Code recorded for it. Anything that cannot be read,
 * and any disagreement, is `unclear`: a move or an open is never made on a guess.
 */
export async function whereRuns(
  host: BackgroundSessionHost,
  lineage: Lineage,
): Promise<SessionWhere> {
  let entries: LiveSession[];
  const holders: Array<{ configDir: string | null; worker: BackgroundSession }> = [];
  try {
    entries = (await host.liveSessions()).filter(
      (e) => lineage.ids.has(e.sessionId) || (e.jobId !== undefined && lineage.shorts.has(e.jobId)),
    );
    // A live background entry names the job that runs it, which is how its service's roster lists
    // it (by the id the job started with, not the conversation it runs now).
    const shorts = new Set(lineage.shorts);
    for (const e of entries) if (e.kind === 'bg' && e.jobId !== undefined) shorts.add(e.jobId);
    for (const configDir of await host.configDirs()) {
      for (const worker of await host.listHosted(configDir, { verified: true })) {
        if (shorts.has(worker.short) || lineage.ids.has(worker.sessionId)) {
          holders.push({ configDir, worker });
        }
      }
    }
  } catch (err) {
    return { kind: 'unclear', reason: reasonOf(err) };
  }
  const foreground = entries.find((e) => e.kind !== 'bg');
  if (foreground !== undefined) {
    return {
      kind: 'interactive',
      pid: foreground.pid,
      ...(foreground.cwd !== undefined ? { cwd: foreground.cwd } : {}),
    };
  }
  if (holders.length === 1) {
    const { configDir, worker } = holders[0]!;
    const entry = entries.find((e) => e.kind === 'bg' && e.jobId === worker.short);
    // A session coming up is listed in its roster before its registry entry is written, then has an
    // entry with a stand-in session id and no status for a moment (measured); one going down loses
    // its entry first. Until its entry says what it is doing, what it runs is not known either.
    if (entry?.status === undefined)
      return { kind: 'unclear', reason: 'it is starting or stopping' };
    return {
      kind: 'bg',
      configDir,
      short: worker.short,
      sessionId: worker.sessionId,
      currentId: entry.sessionId,
      cwd: worker.cwd,
      status: entry.status,
    };
  }
  if (holders.length === 0 && entries.length === 0) return { kind: 'nowhere' };
  return {
    kind: 'unclear',
    reason:
      holders.length > 1
        ? 'more than one background service lists it'
        : "it is live with no background service of cctl's listing it",
  };
}

/** {@link whereRuns}, read again a few times while it is unclear: a session starting or stopping,
 *  or a file caught mid-write, settles within moments. */
export async function settledWhere(
  host: BackgroundSessionHost,
  lineage: Lineage,
  timing: Pick<MoveTiming, 'sleep'>,
): Promise<SessionWhere> {
  for (let attempt = 1; ; attempt++) {
    const where = await whereRuns(host, lineage);
    if (where.kind !== 'unclear' || attempt >= WHERE_TRIES) return where;
    await timing.sleep(WHERE_PAUSE_MS);
  }
}

/** Whether a config dir's service hosts a session, polling until the confirm window closes. A
 *  roster caught mid-write is read again on the next poll. */
export async function confirmHosted(
  host: BackgroundSessionHost,
  configDir: string | null,
  short: string,
  timing: Pick<MoveTiming, 'clock' | 'confirmTimeoutMs' | 'sleep'>,
): Promise<boolean> {
  const deadline = timing.clock() + timing.confirmTimeoutMs;
  for (;;) {
    const hosted = await host.listHosted(configDir).catch(() => []);
    if (hosted.some((s) => s.short === short)) return true;
    if (timing.clock() >= deadline) return false;
    await timing.sleep(CONFIRM_POLL_MS);
  }
}

/** Why a move is not made: what kind of reason, whether that can change, the reason in words, and
 *  Claude Code's name for the session when it was read by then. */
class NotMoved extends Error {
  constructor(
    readonly kind: NotMovedCause,
    message: string,
    readonly final: boolean,
    readonly sessionName?: string,
  ) {
    super(message);
  }
}

/** What a move resumes, and with what, decided before anything is touched. */
interface MovePlan {
  /** Every row the session has, in every config dir: all removed once it runs nowhere. */
  rows: LocatedRow[];
  /** The session's job short id on the source. */
  sourceShort: string;
  /** The conversation it runs now, which the target resumes. */
  currentId: string;
  /** Every saved option of its row on the source, replayed on the target (and on a way back). */
  options: string[];
  name?: string;
}

/**
 * Read everything a move needs and check it may be made: where the session runs (still where the
 * caller found it, or nowhere for a start), what it is doing, its rows (none recording a worktree,
 * none unreadable), whether a terminal watches its service, and its saved options. Throws
 * {@link NotMoved}.
 */
async function planMove(
  host: BackgroundSessionHost,
  request: MoveRequest,
  timing: MoveTiming,
  settled = false,
): Promise<{ plan: MovePlan; lineage: Lineage }> {
  const { session, from, start } = request;
  const platform = request.platform ?? process.platform;
  let name: string | undefined;
  const refuse = (kind: NotMovedCause, reason: string, final = false): NotMoved =>
    new NotMoved(kind, reason, final, name);

  let configDirs: Array<string | null>;
  let rows: LocatedRow[];
  try {
    configDirs = await host.configDirs();
    rows = await allRows(host);
  } catch (err) {
    throw refuse('unknown', `its job rows could not be read: ${reasonOf(err)}`);
  }
  const lineage = lineageOf({ ids: [session.sessionId], shorts: [session.short] }, rows);
  const where = await settledWhere(host, lineage, timing);
  if (where.kind === 'unclear') throw refuse('unknown', where.reason);
  if (start === true ? where.kind !== 'nowhere' : where.kind !== 'bg') {
    throw refuse('gone', `it is no longer where it was found, on ${from.name}`);
  }
  if (where.kind === 'bg' && !sameConfigDir(where.configDir, from.configDir, platform)) {
    throw refuse('gone', `it is no longer on ${from.name}`);
  }
  const mine = rowsOf(lineage, rows);
  const sourceShort = where.kind === 'bg' ? where.short : session.short;
  const source = mine.find(
    (r) => sameConfigDir(r.configDir, from.configDir, platform) && r.row.short === sourceShort,
  );
  name = source?.row.name;
  // A row Claude Code rewrote a moment ago may be between two states: as a scheduled wakeup fires,
  // its row reads idle with nothing held until the next one is armed, a fraction of a second later.
  // Such a row is read again, everything with it, once it has been quiet a while.
  const changedAt = Date.parse(source?.row.updatedAt ?? '');
  if (!settled && Number.isFinite(changedAt) && Date.now() - changedAt < ROW_QUIET_MS) {
    await timing.sleep(ROW_QUIET_MS);
    return planMove(host, request, timing, true);
  }

  if (where.kind === 'bg') {
    let activity: SessionActivity | undefined;
    try {
      activity = (await host.activity(from.configDir)).get(sourceShort);
    } catch (err) {
      throw refuse('activity', reasonOf(err));
    }
    name = activity?.name ?? name;
    if (activity === undefined || !activity.idle || where.status !== 'idle') {
      throw refuse('busy', 'it is not idle between turns');
    }
  }
  // The way back after a failed move resumes it with this row's options.
  if (source === undefined)
    throw refuse('options', `its job row on ${from.name} could not be read`);
  if (where.kind === 'bg' && source.row.pending) {
    throw refuse('busy', 'it holds work between turns (a scheduled wakeup or a background task)');
  }
  if (mine.some((r) => r.row.worktreePath !== undefined)) {
    throw refuse(
      'worktree',
      'it works in a git worktree Claude Code made for it, which Claude Code deletes with the job ' +
        'row a move removes',
      true,
    );
  }
  // A row of it that cannot be read right now could hold anything, a worktree among them.
  for (const configDir of configDirs) {
    for (const short of lineage.shorts) {
      const known = mine.some(
        (r) => sameConfigDir(r.configDir, configDir, platform) && r.row.short === short,
      );
      if (!known && (await host.jobRow(configDir, short)).kind === 'unreadable') {
        throw refuse('options', 'a job row of it could not be read right now');
      }
    }
  }
  // Idle is all Claude Code reports for a session someone has open in a terminal too, reading it
  // or typing the next prompt; stopping it would close that terminal under them. Which session a
  // terminal has open is not said, so any open one holds every move back. Not knowing counts as
  // open: a stop is the one step here that cannot be taken back.
  if (where.kind === 'bg' && (await host.attachedNow(from.configDir).catch(() => true))) {
    throw refuse('attached', 'a terminal has a background session open');
  }
  const saved = await host.savedOptions(from.configDir, sourceShort);
  if (saved.kind === 'unreplayable') throw refuse('options', saved.reason, true);
  if (saved.kind !== 'replayable') {
    throw refuse('options', `its job row on ${from.name} could not be read`);
  }
  return {
    lineage,
    plan: {
      rows: mine,
      sourceShort,
      // The registry names the conversation a live session runs now; a stopped one's row does.
      currentId:
        where.kind === 'bg'
          ? where.currentId
          : (source.row.resumeSessionId ?? source.row.sessionId),
      options: saved.options,
      ...(name !== undefined ? { name } : {}),
    },
  };
}

/** Remove a row of the session's job under a config dir when one is there: what a refused resume
 *  can leave behind before the way back runs. */
async function removeIfHeld(
  host: BackgroundSessionHost,
  configDir: string | null,
  short: string,
): Promise<void> {
  if ((await host.jobRow(configDir, short)).kind !== 'none') await host.removeRow(configDir, short);
}

/** Put a session whose move failed back where it was: resumed under the source with its saved
 *  options (its row there is gone by then, unless the failure came before the rows were removed).
 *  Tried a few times (see {@link PUT_BACK_TRIES}); true once it is hosted there again. */
async function putBack(
  host: BackgroundSessionHost,
  request: MoveRequest,
  plan: MovePlan,
  timing: MoveTiming,
): Promise<boolean> {
  const { session, from } = request;
  const short = plan.currentId.slice(0, 8);
  for (let attempt = 1; ; attempt++) {
    try {
      const held = await host.jobRow(from.configDir, short);
      await host.resumeIdle({
        configDir: from.configDir,
        sessionId: plan.currentId,
        short,
        cwd: session.cwd,
        ...(held.kind === 'none' ? { options: plan.options } : {}),
      });
      // Accepted: trying again would only start copies of a session that is already coming up.
      return await confirmHosted(host, from.configDir, short, timing);
    } catch (err) {
      timing.logger.warn(
        { sessionId: plan.currentId, attempt, reason: reasonOf(err) },
        `could not resume a background session back on ${from.name}`,
      );
      if (attempt >= PUT_BACK_TRIES) return false;
      await timing.sleep(PUT_BACK_PAUSE_MS);
    }
  }
}

/**
 * Move one session from `from`'s service to `to`'s (see the header): check it still runs where the
 * caller found it, idle between turns with no work held and no terminal on its service, with no
 * worktree and with options a move carries over; stop it and wait until it runs nowhere; remove
 * every job row it has; resume its current conversation under the target with its saved options and
 * confirm it is hosted there. On any failure after the stop, put it back where it was. With
 * `request.start`, the session runs nowhere and is started under the target from its row on `from`
 * the same way, minus the stop. The caller holds the session's move lock. `onCommit` runs once,
 * with how the session is brought back by hand should the move be cut off from here on,
 * right before the first change: the last moment nothing has been touched.
 */
export async function moveBackgroundSession(
  host: BackgroundSessionHost,
  request: MoveRequest,
  timing: MoveTiming,
  onCommit?: (recovery: ResumeRecovery) => void,
): Promise<MoveResult> {
  const { session, from, to } = request;
  const platform = request.platform ?? process.platform;
  let plan: MovePlan;
  let lineage: Lineage;
  try {
    ({ plan, lineage } = await planMove(host, request, timing));
  } catch (err) {
    // Nothing has been touched: whatever went wrong while reading, the session is where it was.
    if (!(err instanceof NotMoved)) {
      return { result: 'not-moved', cause: 'unknown', final: false, reason: reasonOf(err) };
    }
    return {
      result: 'not-moved',
      cause: err.kind,
      final: err.final,
      reason: err.message,
      ...(err.sessionName !== undefined ? { name: err.sessionName } : {}),
    };
  }
  const named = plan.name !== undefined ? { name: plan.name } : {};
  const recovery: ResumeRecovery = {
    configDir: from.configDir,
    sessionId: plan.currentId,
    options: plan.options,
  };
  // `back` is whether it is known to be where it was, or 'put-back' to resume it there now.
  const failed = async (reason: string, back: boolean | 'put-back'): Promise<MoveResult> => ({
    result: 'failed',
    restored: back === 'put-back' ? await putBack(host, request, plan, timing) : back,
    reason,
    recovery,
    ...named,
  });
  const runsOnSource = (w: SessionWhere): boolean =>
    w.kind === 'bg' && sameConfigDir(w.configDir, from.configDir, platform);
  onCommit?.(recovery);

  if (request.start !== true) {
    try {
      await host.stop(from.configDir, plan.sourceShort);
    } catch (err) {
      // A stop refused outright left it where it was. One taken but not seen through (it had not
      // exited in time) may have stopped it after all, so then it is put back to be sure.
      const reason = `could not stop it: ${reasonOf(err)}`;
      const after = await settledWhere(host, lineage, timing);
      if (runsOnSource(after)) return failed(reason, true);
      return failed(reason, after.kind === 'nowhere' ? 'put-back' : false);
    }
    const after = await settledWhere(host, lineage, timing);
    if (after.kind !== 'nowhere') {
      return failed(
        after.kind === 'unclear' ? after.reason : 'it was still running after the stop',
        runsOnSource(after),
      );
    }
  }

  // It runs nowhere now: remove every row it has, so none is left anywhere to wake or stop it by.
  try {
    for (const r of plan.rows) await host.removeRow(r.configDir, r.row.short);
  } catch (err) {
    return failed(`could not remove its job row: ${reasonOf(err)}`, 'put-back');
  }

  const short = plan.currentId.slice(0, 8);
  const moved: MoveResult = {
    result: 'moved',
    short,
    sessionId: plan.currentId,
    replayed: plan.options.length,
    ...named,
  };
  try {
    await host.resumeIdle({
      configDir: to.configDir,
      sessionId: plan.currentId,
      short,
      cwd: session.cwd,
      options: plan.options,
    });
    if (!(await confirmHosted(host, to.configDir, short, timing))) {
      throw new Error(`it did not appear under ${to.name}`);
    }
  } catch (err) {
    const reason = reasonOf(err);
    const after = await settledWhere(
      host,
      {
        ids: new Set([...lineage.ids, plan.currentId]),
        shorts: new Set([...lineage.shorts, short]),
      },
      timing,
    );
    // Up after all, only later than the confirm window: moved.
    if (after.kind === 'bg' && sameConfigDir(after.configDir, to.configDir, platform)) return moved;
    // Running somewhere else, or not known where: nothing is resumed on a guess.
    if (after.kind !== 'nowhere') return failed(reason, false);
    try {
      await removeIfHeld(host, to.configDir, short);
    } catch (removeErr) {
      return failed(`${reason}; its row there could not be removed: ${reasonOf(removeErr)}`, false);
    }
    return failed(reason, 'put-back');
  }
  return moved;
}
