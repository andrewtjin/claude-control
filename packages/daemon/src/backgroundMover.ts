// Moving Claude Code background sessions in a ruled folder off the global slot and onto the rule's
// own slot.
//
// A ruled folder accepts the global slot's account (its pool inherits the shared pool), but it
// prefers its own included accounts. A running Claude Code process cannot change account in place:
// its account is the config dir it started with. The global slot cannot be switched for one folder
// either, because every plain session in every folder shares it. What CAN move is a background
// session (`claude --bg`): Claude Code hosts those in a background service of its own, one per
// config dir (keyed on CLAUDE_CONFIG_DIR), and a session's conversation lives in `projects/`, which
// every folder profile shares with the main config dir. So a background session stopped in the main
// config's service and resumed by its full id under the rule's profile continues the same session id
// and the same conversation on the rule's account — measured against the real binary:
//   - resuming with no prompt leaves it idle ("send a prompt to start"); no turn is spent;
//   - resuming while it is still live anywhere starts a COPY under a new id, so it is stopped first;
//   - a first move does not inherit the source's saved options, so they are passed explicitly, ALL
//     of them: a session started with restrictions (a tool deny list, a settings file) must not
//     come back without them. One holding anything a move cannot carry over is not moved at all;
//   - a target config that already holds a job row for the session (it was moved before) wakes it
//     with that row's options, and passing others starts a copy. Dropping the row is no way out:
//     Claude Code's `rm` deletes the session's worktree with it. So a row there is used as it is
//     when it saved the same options, and the session is not moved when it saved others.
//
// This module owns WHEN and WHICH: only sessions the main config's service hosts (the global slot),
// only between turns and while no terminal has one open, only in a folder whose rule has an included
// account live in its slot that can take work, at most once an hour per session, and never again
// after an attempt that failed. HOW is the injected {@link BackgroundSessionHost}, the one seam to
// Claude Code's own commands, so every decision here is testable without a Claude Code binary.

import { type Logger, noopLogger } from '@claude-control/switch-engine';

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
  /** Stop a hosted session. Claude Code's stop is synchronous: it is stopped once this resolves. */
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
}

/** Where a ruled folder's background sessions move to this cycle. */
export interface MoveTarget {
  ruleId: string;
  /** The rule's folders in words, for the log and the notice. */
  folder: string;
  /** The rule slot's profile dir: the config dir the session resumes under. */
  configDir: string;
  /** The included account live in that slot, for the notice. */
  accountLabel: string;
}

/** What happened to one session this cycle. */
export interface MoveOutcome {
  sessionId: string;
  ruleId: string;
  result: 'moved' | 'failed' | 'skipped';
  /** Whether a failed move was put back on the global slot. */
  restored?: boolean;
  reason?: string;
}

export interface BackgroundMoverOptions {
  host: BackgroundSessionHost;
  /** The folder rule a working directory runs under (longest match), or null for none. */
  resolveRule: (cwd: string) => Promise<string | null>;
  /** One operator notice: the log line is written here; this reaches the phone. */
  notify: (notice: { title: string; body: string; level: 'info' | 'warn' }) => void;
  logger?: Logger;
  /** A monotonic clock in ms (default `performance.now`). Everything it measures is a duration (the
   *  interval between moves, the confirm window), and wall time steps on some boxes: stepped back,
   *  it would hold the poll cycle in a confirm loop for as long as the step. */
  clock?: () => number;
  /** The least time between two moves of one session. A session woken back onto the global slot by
   *  hand is moved again only after this, so cctl and the operator can never bounce it every cycle. */
  minIntervalMs?: number;
  /** How long a resume may take to show up in the target service's roster. */
  confirmTimeoutMs?: number;
  /** Pause between roster reads while confirming, and between tries of a way back. Injectable so
   *  tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** An hour: well above a poll cycle, so a move never repeats on a cadence the operator would see. */
export const DEFAULT_MOVE_INTERVAL_MS = 60 * 60_000;
/** Claude Code's resume returns once the session is dispatched; its worker shows up in the roster
 *  within a second or two on a loaded box. */
const DEFAULT_CONFIRM_TIMEOUT_MS = 15_000;
const CONFIRM_POLL_MS = 500;
/** How many times a failed move tries to resume the session back on the global slot, and the pause
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

/** Why a move of one session is not made, and whether that can change on a later cycle. */
class NotMoved extends Error {
  constructor(
    message: string,
    /** True when nothing about the session will change it (its saved options), so it is given up;
     *  false when a later cycle may find it movable (a row caught mid-write). */
    readonly final: boolean,
  ) {
    super(message);
  }
}

/** How a session is named to the operator: its name and short id, or the short id alone. */
function describeSession(s: BackgroundSession, name: string | undefined): string {
  return name !== undefined && name.length > 0 ? `"${name}" (${s.short})` : s.short;
}

export class BackgroundMover {
  private readonly host: BackgroundSessionHost;
  private readonly resolveRule: (cwd: string) => Promise<string | null>;
  private readonly notify: BackgroundMoverOptions['notify'];
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly minIntervalMs: number;
  private readonly confirmTimeoutMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** When each session was last moved (or a move of it was attempted), by session id. */
  private readonly lastAttemptAt = new Map<string, number>();
  /** Sessions a move failed for: never tried again while this daemon runs, so a session Claude Code
   *  will not host under the rule's profile cannot be stopped and resumed over and over. */
  private readonly gaveUp = new Set<string>();
  /** The last reason Claude Code could not say what sessions are doing, logged once per reason: a
   *  daemon whose PATH has no `claude` would otherwise skip every move without a word. */
  private lastActivityFailure: string | undefined;

  constructor(options: BackgroundMoverOptions) {
    this.host = options.host;
    this.resolveRule = options.resolveRule;
    this.notify = options.notify;
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? (() => performance.now());
    this.minIntervalMs = options.minIntervalMs ?? DEFAULT_MOVE_INTERVAL_MS;
    this.confirmTimeoutMs = options.confirmTimeoutMs ?? DEFAULT_CONFIRM_TIMEOUT_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Move every idle background session the global slot hosts in a folder with a target onto that
   * folder's slot. `targets` holds, by rule id, only the rules whose slot holds an included account
   * that can take work right now (the caller's judgment); no target means nothing is read at all.
   * Sessions in folders without a target — every folder with no rule among them — are never touched.
   */
  async run(targets: ReadonlyMap<string, MoveTarget>): Promise<MoveOutcome[]> {
    if (targets.size === 0) return [];
    let hosted: BackgroundSession[];
    try {
      hosted = await this.host.listHosted(null);
    } catch (err) {
      // An unreadable roster: nothing to move this cycle. Debug, not warn — it heals on its own (a
      // roster caught mid-write) and a later cycle reads it.
      this.logger.debug({ reason: reasonOf(err) }, 'could not list background sessions');
      return [];
    }
    const candidates: Array<{ session: BackgroundSession; target: MoveTarget }> = [];
    for (const session of hosted) {
      if (this.gaveUp.has(session.sessionId)) continue;
      const last = this.lastAttemptAt.get(session.sessionId);
      if (last !== undefined && this.clock() - last < this.minIntervalMs) continue;
      const ruleId = await this.resolveRule(session.cwd).catch(() => null);
      if (ruleId === null) continue;
      const target = targets.get(ruleId);
      if (target !== undefined) candidates.push({ session, target });
    }
    const outcomes: MoveOutcome[] = [];
    for (const { session, target } of candidates) {
      outcomes.push(await this.move(session, target));
    }
    return outcomes;
  }

  /** Move one session: re-check it is idle and that no terminal has one open, decide what it
   *  resumes with, stop it, resume it under the target, confirm it is hosted there; on any failure
   *  put it back where it was and give up on it. */
  private async move(session: BackgroundSession, target: MoveTarget): Promise<MoveOutcome> {
    const base = { sessionId: session.sessionId, ruleId: target.ruleId };
    // Read right before stopping, per session: a stop mid-turn would cut the turn off, and a turn can
    // start at any moment (a prompt sent to it, an attached terminal).
    let activity: SessionActivity | undefined;
    try {
      activity = (await this.host.activity(null)).get(session.short);
      this.lastActivityFailure = undefined;
    } catch (err) {
      const reason = reasonOf(err);
      if (reason !== this.lastActivityFailure) {
        this.lastActivityFailure = reason;
        this.logger.warn(
          { sessionId: session.sessionId, reason },
          'could not tell whether a background session is idle; not moving it',
        );
      }
      return { ...base, result: 'skipped', reason };
    }
    if (activity === undefined || !activity.idle) {
      return { ...base, result: 'skipped', reason: 'not idle between turns' };
    }
    // Idle is all Claude Code reports for a session someone has open in a terminal too, reading it
    // or typing the next prompt; stopping it would close that terminal under them. Which session a
    // terminal has open is not said, so any open one holds every move back. Not knowing counts as
    // open: a stop is the one step here that cannot be taken back.
    const attached = await this.host.attachedNow(null).catch(() => true);
    if (attached) {
      return { ...base, result: 'skipped', reason: 'a terminal has a background session open' };
    }
    const name = activity.name;

    // What it resumes with under the profile, decided before anything is touched.
    let options: string[] | undefined;
    try {
      options = await this.resumeOptions(session, target);
    } catch (err) {
      // Nothing touched: the session still runs where it was. Given up on only when nothing about it
      // will change; anything else is tried again next cycle.
      if (err instanceof NotMoved && err.final) {
        return this.giveUp(session, name, target, err.message, true);
      }
      return { ...base, result: 'skipped', reason: reasonOf(err) };
    }
    // Recorded before anything is touched, so even a move that dies half way is not retried before
    // the interval is up.
    this.lastAttemptAt.set(session.sessionId, this.clock());

    try {
      await this.host.stop(null, session.short);
    } catch (err) {
      // Nothing moved: the session still runs where it was.
      return this.giveUp(session, name, target, `could not stop it: ${reasonOf(err)}`, true);
    }
    try {
      await this.host.resumeIdle({
        configDir: target.configDir,
        sessionId: session.sessionId,
        short: session.short,
        cwd: session.cwd,
        ...(options !== undefined ? { options } : {}),
      });
      if (!(await this.confirmHosted(target.configDir, session.short))) {
        throw new Error(`it did not appear under ${target.folder}'s slot`);
      }
    } catch (err) {
      return this.giveUp(session, name, target, reasonOf(err), await this.putBack(session));
    }

    const body =
      `cctl moved background session ${describeSession(session, name)} in ${target.folder} onto ` +
      `${target.accountLabel}, the folder's own account. Same session, same conversation; it is ` +
      'idle until its next prompt.';
    this.logger.info(
      { sessionId: session.sessionId, ruleId: target.ruleId, options: options?.length ?? 'kept' },
      body,
    );
    this.notify({ title: 'Background session moved', body, level: 'info' });
    return { ...base, result: 'moved' };
  }

  /**
   * The options a session resumes with under the target: the source's saved options when the
   * target holds no row for it, or none (`undefined`, the target row's own) when the target's row
   * saved the same ones. Throws {@link NotMoved} when it cannot move without changing the session.
   */
  private async resumeOptions(
    session: BackgroundSession,
    target: MoveTarget,
  ): Promise<string[] | undefined> {
    const source = await this.host.savedOptions(null, session.short);
    // The way back after a failed move is a plain resume on the global slot, which needs its row.
    if (source.kind === 'none' || source.kind === 'unreadable') {
      throw new NotMoved('its job row on the global slot could not be read', false);
    }
    if (source.kind === 'unreplayable') throw new NotMoved(source.reason, true);
    const there = await this.host.savedOptions(target.configDir, session.short);
    switch (there.kind) {
      case 'none':
        return source.options;
      case 'unreadable':
        throw new NotMoved(`its job row on ${target.folder}'s slot could not be read`, false);
      case 'replayable':
        if (sameOptions(there.options, source.options)) return undefined;
        throw new NotMoved(
          `${target.folder}'s slot still holds it from an earlier move, saved with other options`,
          true,
        );
      case 'unreplayable':
        throw new NotMoved(`${target.folder}'s slot still holds it: ${there.reason}`, true);
    }
  }

  /** Put a session whose move failed back on the global slot: the main config kept its job row with
   *  its saved options, so a plain resume there wakes it exactly as it was. Tried a few times (see
   *  {@link PUT_BACK_TRIES}); true once it is hosted there again. */
  private async putBack(session: BackgroundSession): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.host.resumeIdle({
          configDir: null,
          sessionId: session.sessionId,
          short: session.short,
          cwd: session.cwd,
        });
        // Accepted: trying again would only start copies of a session that is already coming up.
        return await this.confirmHosted(null, session.short);
      } catch (err) {
        this.logger.warn(
          { sessionId: session.sessionId, attempt, reason: reasonOf(err) },
          'could not resume a background session back on the global slot',
        );
        if (attempt >= PUT_BACK_TRIES) return false;
        await this.sleep(PUT_BACK_PAUSE_MS);
      }
    }
  }

  /** Whether a config dir's service hosts the session, polling until the confirm window closes. */
  private async confirmHosted(configDir: string | null, short: string): Promise<boolean> {
    const deadline = this.clock() + this.confirmTimeoutMs;
    for (;;) {
      const hosted = await this.host.listHosted(configDir).catch(() => []);
      if (hosted.some((s) => s.short === short)) return true;
      if (this.clock() >= deadline) return false;
      await this.sleep(CONFIRM_POLL_MS);
    }
  }

  /** Stop trying a session for good, and tell the operator once where it was left. */
  private giveUp(
    session: BackgroundSession,
    name: string | undefined,
    target: MoveTarget,
    reason: string,
    restored: boolean,
  ): MoveOutcome {
    this.gaveUp.add(session.sessionId);
    const where = restored
      ? 'It is still on the shared account, as before.'
      : `It may be stopped: resume it with: claude --bg --resume ${session.sessionId}`;
    const body =
      `cctl could not move background session ${describeSession(session, name)} in ${target.folder} ` +
      `onto ${target.accountLabel} (${reason}), and will not try again until the daemon restarts. ` +
      where;
    this.logger.warn({ sessionId: session.sessionId, ruleId: target.ruleId, restored }, body);
    this.notify({ title: 'Background session not moved', body, level: 'warn' });
    return {
      sessionId: session.sessionId,
      ruleId: target.ruleId,
      result: 'failed',
      restored,
      reason,
    };
  }
}
