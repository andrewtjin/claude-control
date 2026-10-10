// One move of a Claude Code background session from one config dir's service to another's.
//
// Claude Code hosts background sessions (`claude --bg`) in a background service of its own, one per
// config dir (keyed on CLAUDE_CONFIG_DIR), and a session's account is the config dir that hosts it.
// Every folder profile shares `projects/` (the conversations) with the main config dir, so a
// background session stopped in one service and resumed by its full id in another continues the same
// session id and the same conversation on the other config dir's account — measured against the real
// binary:
//   - resuming with no prompt leaves it idle ("send a prompt to start"); no turn is spent;
//   - resuming while it is still live anywhere starts a COPY under a new id, so it is stopped first,
//     and Claude Code's stop returns a moment before the session has exited;
//   - a first resume in a config dir does not inherit the source's saved options, so they are passed
//     explicitly, ALL of them: a session started with restrictions (a tool deny list, a settings
//     file) must not come back without them. One holding anything a move cannot carry over is not
//     moved at all;
//   - a target config dir that already holds a job row for the session wakes it with that row's
//     options, and passing others starts a copy. Dropping the row is no way out: Claude Code's `rm`
//     deletes the session's worktree with it. So a row there is used as it is when it saved the same
//     options, and the session is not moved when it saved others.
//
// Two callers move sessions, and both go through {@link moveBackgroundSession} so a session moves on
// the same terms whoever moves it: the daemon's background mover (backgroundMover.ts), which decides
// every poll cycle WHEN and WHICH, and `cctl claude`, which moves a session the operator opens from a
// ruled folder. They can reach the same session at the same moment, so each holds the session's
// cross-process move lock ({@link BackgroundSessionHost.lockSession}) around a move, and a move first
// checks the session is still where its caller found it. HOW is the injected
// {@link BackgroundSessionHost}, the one seam to Claude Code's own commands, so every decision here is
// testable without a Claude Code binary.

import { type Logger } from '@claude-control/switch-engine';
import { assessFleet, type AccountUsageInput } from '@claude-control/usage-advisor';

/** One background session as a config dir's Claude Code service hosts it. */
export interface BackgroundSession {
  /** Claude Code's short id for it (the first 8 hex digits of the session id). */
  short: string;
  /** The full, lowercase session id — what a resume must name to keep the same session. */
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
 *   - `replayable`: every saved option, in a canonical spelling, so two rows saved with the same
 *     options compare equal however each was spelled;
 *   - `unreplayable`: the row holds something a move cannot carry over (`reason` says what, without
 *     repeating anything the session was told), so moving it would quietly change the session.
 */
export type SavedLaunch =
  | { kind: 'none' }
  | { kind: 'unreadable' }
  | { kind: 'replayable'; options: string[] }
  | { kind: 'unreplayable'; reason: string };

/** A held move lock for one session. Released exactly once by whoever took it. */
export interface SessionLock {
  release(): void;
}

/**
 * The seam to Claude Code's background service. A config dir of `null` is the main config dir —
 * the global slot — exactly as the daemon itself resolves it.
 */
export interface BackgroundSessionHost {
  /** The background sessions the service of a config dir hosts right now; empty when no service
   *  runs there. Cheap (no Claude Code process), so it is read every cycle. */
  listHosted(configDir: string | null): Promise<BackgroundSession[]>;
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
  /** What a config dir's job row saved for a session (see {@link SavedLaunch}). */
  savedOptions(configDir: string | null, short: string): Promise<SavedLaunch>;
  /**
   * Resume a session by its full id in a config dir's service, idle (no prompt), from its cwd.
   * Without `options`, the session wakes with the saved options of the row that config dir holds
   * for it. With `options`, that config dir must hold no row for it (a row there would keep its own
   * options and start a copy); the call rejects rather than drop one, since dropping a row drops the
   * session's worktree with it. Rejects when Claude Code refuses, or starts a copy instead.
   */
  resumeIdle(input: {
    configDir: string | null;
    sessionId: string;
    short: string;
    cwd: string;
    options?: string[];
  }): Promise<void>;
  /**
   * Take the cross-process lock that serializes moves of one session (the daemon and `cctl claude`
   * are separate processes), waiting up to `waitMs` for a holder to let go. Resolves `undefined`
   * when another process still holds it then. A holder that died leaves no lock behind.
   */
  lockSession(sessionId: string, waitMs: number): Promise<SessionLock | undefined>;
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
  /** It is no longer hosted where the caller found it (moved or stopped meanwhile). */
  | 'gone'
  /** What it is doing could not be read. */
  | 'activity'
  /** It is in a turn, waiting on a prompt, or not in Claude Code's listing. */
  | 'busy'
  /** A terminal has a background session of its service open. */
  | 'attached'
  /** It cannot move without changing (its options), or a row it needs cannot be read right now. */
  | 'options';

/** What one move did. `name` is Claude Code's name for the session, when it was read. */
export type MoveResult =
  | { result: 'moved'; name?: string; replayed: number | 'kept' }
  | {
      result: 'not-moved';
      cause: NotMovedCause;
      /** True when nothing about the session will change it (its saved options); false when a
       *  later try may find it movable. */
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
    };

/** Claude Code's resume returns once the session is dispatched; its worker shows up in the roster
 *  within a second or two on a loaded box. */
export const DEFAULT_CONFIRM_TIMEOUT_MS = 15_000;
const CONFIRM_POLL_MS = 500;
/** How many times a failed move tries to resume the session back where it was, and the pause
 *  between tries. Right after a stop, Claude Code can still count the session as open or running
 *  and start a copy instead; that clears within moments, so one immediate try is not enough. A few
 *  are: every refused try leaves a stopped copy behind in the list. */
const PUT_BACK_TRIES = 3;
const PUT_BACK_PAUSE_MS = 2_000;

/** A thrown value as one line. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whether two canonical option lists hold the same options, in any order. */
function sameOptions(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((x, i) => x === right[i]);
}

/** Why a move of one session is not made, and whether that can change later. */
class NotMoved extends Error {
  constructor(
    message: string,
    /** True when nothing about the session will change it (its saved options), so it is given up;
     *  false when a later try may find it movable (a row caught mid-write). */
    readonly final: boolean,
  ) {
    super(message);
  }
}

/**
 * Whether a ruled folder's slot is one its background sessions move onto right now: its rule
 * includes accounts, one of them is live in the slot, and that account can take work by the usage
 * given (no usage known counts as able: an account never polled holds an untouched allowance). A
 * folder in fallback on a shared account, or whose included account is out, is not: a move there
 * would gain nothing. An exclude-only rule prefers no account, so it never is.
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

/**
 * The options a session resumes with under the target: the source's saved options when the target
 * holds no row for it, or none (`undefined`, the target row's own) when the target's row saved the
 * same ones. Throws {@link NotMoved} when it cannot move without changing the session.
 */
async function resumeOptions(
  host: BackgroundSessionHost,
  { session, from, to }: MoveRequest,
): Promise<string[] | undefined> {
  const source = await host.savedOptions(from.configDir, session.short);
  // The way back after a failed move is a plain resume where it was, which needs its row there.
  if (source.kind === 'none' || source.kind === 'unreadable') {
    throw new NotMoved(`its job row on ${from.name} could not be read`, false);
  }
  if (source.kind === 'unreplayable') throw new NotMoved(source.reason, true);
  const there = await host.savedOptions(to.configDir, session.short);
  switch (there.kind) {
    case 'none':
      return source.options;
    case 'unreadable':
      throw new NotMoved(`its job row on ${to.name} could not be read`, false);
    case 'replayable':
      if (sameOptions(there.options, source.options)) return undefined;
      throw new NotMoved(
        `${to.name} still holds it from an earlier move, saved with other options`,
        true,
      );
    case 'unreplayable':
      throw new NotMoved(`${to.name} still holds it: ${there.reason}`, true);
  }
}

/** Whether a config dir's service hosts a session, polling until the confirm window closes. */
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

/** Whether a config dir's service still hosts a session; not knowing counts as hosted, so a
 *  session is never reported moved off on a roster that could not be read. */
async function stillHosted(
  host: BackgroundSessionHost,
  configDir: string | null,
  sessionId: string,
): Promise<boolean> {
  return host
    .listHosted(configDir)
    .then((list) => list.some((s) => s.sessionId === sessionId))
    .catch(() => true);
}

/** Put a session whose move failed back where it was: the source kept its job row with its saved
 *  options, so a plain resume there wakes it exactly as it was. Tried a few times (see
 *  {@link PUT_BACK_TRIES}); true once it is hosted there again. */
async function putBack(
  host: BackgroundSessionHost,
  { session, from }: MoveRequest,
  timing: MoveTiming,
): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await host.resumeIdle({
        configDir: from.configDir,
        sessionId: session.sessionId,
        short: session.short,
        cwd: session.cwd,
      });
      // Accepted: trying again would only start copies of a session that is already coming up.
      return await confirmHosted(host, from.configDir, session.short, timing);
    } catch (err) {
      timing.logger.warn(
        { sessionId: session.sessionId, attempt, reason: reasonOf(err) },
        `could not resume a background session back on ${from.name}`,
      );
      if (attempt >= PUT_BACK_TRIES) return false;
      await timing.sleep(PUT_BACK_PAUSE_MS);
    }
  }
}

/**
 * Move one session from `from`'s service to `to`'s: check it is still hosted where the caller found
 * it, that it is idle between turns (read right before stopping, per session: a stop mid-turn would
 * cut the turn off, and a turn can start at any moment) and that no terminal has one open, decide
 * what it resumes with, stop it, resume it under the target, confirm it is hosted there; on any
 * failure after the stop, put it back where it was. The caller holds the session's move lock.
 * `onCommit` runs once, right before the stop: the last moment nothing has been touched.
 */
export async function moveBackgroundSession(
  host: BackgroundSessionHost,
  request: MoveRequest,
  timing: MoveTiming,
  onCommit?: () => void,
): Promise<MoveResult> {
  const { session, from, to } = request;
  // Another process may have moved or stopped it between the caller's look and the lock.
  const there = await host.listHosted(from.configDir).catch(() => undefined);
  if (there === undefined || !there.some((s) => s.sessionId === session.sessionId)) {
    return {
      result: 'not-moved',
      cause: 'gone',
      final: false,
      reason: `it is no longer on ${from.name}`,
    };
  }
  let activity: SessionActivity | undefined;
  try {
    activity = (await host.activity(from.configDir)).get(session.short);
  } catch (err) {
    return { result: 'not-moved', cause: 'activity', final: false, reason: reasonOf(err) };
  }
  const name = activity?.name;
  const named = name !== undefined ? { name } : {};
  if (activity === undefined || !activity.idle) {
    return {
      result: 'not-moved',
      cause: 'busy',
      final: false,
      reason: 'not idle between turns',
      ...named,
    };
  }
  // Idle is all Claude Code reports for a session someone has open in a terminal too, reading it
  // or typing the next prompt; stopping it would close that terminal under them. Which session a
  // terminal has open is not said, so any open one holds every move back. Not knowing counts as
  // open: a stop is the one step here that cannot be taken back.
  const attached = await host.attachedNow(from.configDir).catch(() => true);
  if (attached) {
    return {
      result: 'not-moved',
      cause: 'attached',
      final: false,
      reason: 'a terminal has a background session open',
      ...named,
    };
  }

  // What it resumes with under the target, decided before anything is touched.
  let options: string[] | undefined;
  try {
    options = await resumeOptions(host, request);
  } catch (err) {
    const final = err instanceof NotMoved && err.final;
    return { result: 'not-moved', cause: 'options', final, reason: reasonOf(err), ...named };
  }
  onCommit?.();

  try {
    await host.stop(from.configDir, session.short);
  } catch (err) {
    const reason = `could not stop it: ${reasonOf(err)}`;
    // A stop refused outright left it where it was. One taken but not seen through (it had not
    // exited in time) may have stopped it after all, so then it is put back to be sure.
    if (await stillHosted(host, from.configDir, session.sessionId)) {
      return { result: 'failed', restored: true, reason, ...named };
    }
    return { result: 'failed', restored: await putBack(host, request, timing), reason, ...named };
  }
  try {
    await host.resumeIdle({
      configDir: to.configDir,
      sessionId: session.sessionId,
      short: session.short,
      cwd: session.cwd,
      ...(options !== undefined ? { options } : {}),
    });
    if (!(await confirmHosted(host, to.configDir, session.short, timing))) {
      throw new Error(`it did not appear under ${to.name}`);
    }
  } catch (err) {
    return {
      result: 'failed',
      restored: await putBack(host, request, timing),
      reason: reasonOf(err),
      ...named,
    };
  }
  return { result: 'moved', replayed: options?.length ?? 'kept', ...named };
}
