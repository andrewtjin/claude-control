// Moving Claude Code background sessions in a ruled folder off the global slot and onto the rule's
// own slot, every poll cycle.
//
// A ruled folder accepts the global slot's account (its pool inherits the shared pool), but it
// prefers its own included accounts. A running Claude Code process cannot change account in place:
// its account is the config dir it started with. The global slot cannot be switched for one folder
// either, because every plain session in every folder shares it. What CAN move is a background
// session (`claude --bg`): stopped in the main config's service and resumed by its full id under the
// rule's profile, it continues the same session id and the same conversation on the rule's account
// (see backgroundMove.ts for how one move is made, and why it is made that way).
//
// This module owns WHEN and WHICH: only sessions the main config's service hosts (the global slot),
// only in a folder whose rule has an included account live in its slot that can take work, at most
// once an hour per session, never again after an attempt that failed or that nothing will change
// (a worktree, options a move cannot carry over), and never while another cctl process holds the
// session's move lock (`cctl claude` moves a session the operator opens). HOW is the injected
// {@link BackgroundSessionHost}, the one seam to Claude Code's own commands, so every decision here
// is testable without a Claude Code binary. The daemon's own reads every cycle are the cheap ones
// (the global slot's roster); the move reads everything again, verified, before it touches anything.

import { type Logger, noopLogger } from '@claude-control/switch-engine';
import {
  DEFAULT_CONFIRM_TIMEOUT_MS,
  moveBackgroundSession,
  reasonOf,
  sessionLabel,
  type BackgroundSession,
  type BackgroundSessionHost,
  type MoveResult,
  type MoveTiming,
  type ResumeRecovery,
  type SessionLock,
} from './backgroundMove.js';

export type {
  BackgroundSession,
  BackgroundSessionHost,
  SavedLaunch,
  SessionActivity,
} from './backgroundMove.js';

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
/** How the mover names the global slot in its reasons. */
const GLOBAL_SLOT = 'the global slot';

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

  /** Move one session under its move lock (see backgroundMove.ts for the move itself), and turn
   *  what happened into this cycle's outcome: a session left as it was is tried again next cycle
   *  unless nothing about it will change, and one whose move failed is given up on. */
  private async move(session: BackgroundSession, target: MoveTarget): Promise<MoveOutcome> {
    const base = { sessionId: session.sessionId, ruleId: target.ruleId };
    // Not waited for: a lock someone holds is `cctl claude` moving or opening this session right
    // now, and the next cycle looks again.
    let lock: SessionLock | undefined;
    try {
      lock = await this.host.lockSession(session.sessionId, 0);
    } catch (err) {
      return { ...base, result: 'skipped', reason: reasonOf(err) };
    }
    if (lock === undefined) {
      return { ...base, result: 'skipped', reason: 'another cctl process is moving it' };
    }
    let moved: MoveResult;
    try {
      moved = await moveBackgroundSession(
        this.host,
        {
          session,
          from: { configDir: null, name: GLOBAL_SLOT },
          to: { configDir: target.configDir, name: `${target.folder}'s slot` },
        },
        this.timing(),
        // Recorded before anything is touched, so even a move that dies half way is not retried
        // before the interval is up.
        () => this.lastAttemptAt.set(session.sessionId, this.clock()),
      );
    } finally {
      lock.release();
    }

    if (moved.result === 'not-moved' && moved.cause === 'activity') {
      if (moved.reason !== this.lastActivityFailure) {
        this.lastActivityFailure = moved.reason;
        this.logger.warn(
          { sessionId: session.sessionId, reason: moved.reason },
          'could not tell whether a background session is idle; not moving it',
        );
      }
      return { ...base, result: 'skipped', reason: moved.reason };
    }
    // Claude Code said what the session is doing; a session found gone, or not found at all, was
    // never asked, so it says nothing about whether asking works again.
    if (moved.result !== 'not-moved' || (moved.cause !== 'gone' && moved.cause !== 'unknown')) {
      this.lastActivityFailure = undefined;
    }

    switch (moved.result) {
      case 'not-moved':
        // Nothing touched: the session still runs where it was. Given up on only when nothing about
        // it will change; anything else is tried again next cycle.
        return moved.final
          ? this.giveUp(session, moved.name, target, moved.reason, undefined)
          : { ...base, result: 'skipped', reason: moved.reason };
      case 'failed':
        return this.giveUp(
          session,
          moved.name,
          target,
          moved.reason,
          moved.restored ? undefined : moved.recovery,
        );
      case 'moved': {
        const body =
          `cctl moved background session ${sessionLabel(moved.short, moved.name)} in ` +
          `${target.folder} onto ${target.accountLabel}, the folder's own account. Same session, ` +
          'same conversation; it is idle until its next prompt.';
        this.logger.info(
          { sessionId: session.sessionId, ruleId: target.ruleId, options: moved.replayed },
          body,
        );
        this.notify({ title: 'Background session moved', body, level: 'info' });
        return { ...base, result: 'moved' };
      }
    }
  }

  /** How one move is timed: this mover's clock, confirm window, pauses and log. */
  private timing(): MoveTiming {
    return {
      clock: this.clock,
      confirmTimeoutMs: this.confirmTimeoutMs,
      sleep: this.sleep,
      logger: this.logger,
    };
  }

  /** Stop trying a session for good, and tell the operator once where it was left: still where it
   *  was, or (`recovery`) possibly stopped, with the command that brings it back as it was. */
  private giveUp(
    session: BackgroundSession,
    name: string | undefined,
    target: MoveTarget,
    reason: string,
    recovery: ResumeRecovery | undefined,
  ): MoveOutcome {
    this.gaveUp.add(session.sessionId);
    const restored = recovery === undefined;
    const where = restored
      ? 'It is still on the shared account, as before.'
      : `It may be stopped: resume it with: ${this.host.resumeHint(
          recovery.configDir,
          recovery.sessionId,
          recovery.options,
        )}`;
    const body =
      `cctl could not move background session ${sessionLabel(session.short, name)} in ` +
      `${target.folder} onto ${target.accountLabel} (${reason}), and will not try again until the ` +
      `daemon restarts. ${where}`;
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
