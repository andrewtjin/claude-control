// Records which slot every hook-reporting session runs in, so per-account views can bill a
// folder-bound session's turns to its group's live member.
//
// Before this, a session's slot was known only when it was registered (`cctl session register`)
// or spawned by the daemon, so a hand-started session in a bound folder — the common case — was
// attributed against the GLOBAL account's timeline: `cctl stats` and `cctl session show` named
// the wrong account for every one of its turns. Every hook POST already carries the session's
// launch-time CLAUDE_CONFIG_DIR (the forwarder stamps it), which is exactly what decides the slot,
// so recording it costs one map lookup per event and one sqlite write per slot change.
//
// Observability only: nothing here may slow or fail a hook. Resolution is async and detached from
// the HTTP response, and every fault is logged and dropped.

import type { Logger } from '@claude-control/switch-engine';
import type { Store } from './store.js';

/** The slot a config dir runs in — the switch engine's `slotForConfigDir`. */
export type SlotForConfigDir = (configDir: string | null) => Promise<string>;

export interface SessionSlotRecorderOptions {
  store: Pick<Store, 'recordSessionSlot'>;
  slotForConfigDir: SlotForConfigDir;
  clock?: () => number;
  logger?: Pick<Logger, 'warn'>;
  /** How many sessions' last-seen config dir to remember before forgetting the oldest. A forgotten
   *  session costs one redundant resolve on its next event (the store dedups the write), so this
   *  only bounds memory; the default comfortably covers a machine's concurrent sessions. */
  maxTracked?: number;
}

/** One hook event's identity: the session and the config dir its forwarder reported (`null` = the
 *  shared config dir, i.e. the global slot). */
export interface SessionSighting {
  sessionId: string;
  configDir: string | null;
}

const DEFAULT_MAX_TRACKED = 4096;

export class SessionSlotRecorder {
  private readonly store: Pick<Store, 'recordSessionSlot'>;
  private readonly slotForConfigDir: SlotForConfigDir;
  private readonly clock: () => number;
  private readonly logger: Pick<Logger, 'warn'> | undefined;
  private readonly maxTracked: number;
  /** sessionId -> the config dir last recorded (or being recorded) for it. Insertion-ordered, so
   *  the first key is the least recently changed one. */
  private readonly lastConfigDir = new Map<string, string | null>();

  constructor(options: SessionSlotRecorderOptions) {
    this.store = options.store;
    this.slotForConfigDir = options.slotForConfigDir;
    this.clock = options.clock ?? Date.now;
    this.logger = options.logger;
    this.maxTracked = options.maxTracked ?? DEFAULT_MAX_TRACKED;
  }

  /**
   * Note one hook event. Returns immediately; the slot is resolved and written in the background.
   * Repeat events of a session on the same config dir do nothing at all — the common case, since a
   * session's config dir is fixed for its whole run.
   */
  observe(sighting: SessionSighting): void {
    const { sessionId, configDir } = sighting;
    if (this.lastConfigDir.has(sessionId) && this.lastConfigDir.get(sessionId) === configDir)
      return;
    // Claimed BEFORE the async resolve, so a burst of events from one new session resolves once.
    this.lastConfigDir.delete(sessionId);
    this.lastConfigDir.set(sessionId, configDir);
    if (this.lastConfigDir.size > this.maxTracked) {
      const oldest = this.lastConfigDir.keys().next().value;
      if (oldest !== undefined) this.lastConfigDir.delete(oldest);
    }
    // The span starts when the event ARRIVED, not when the resolve finished: the turn that event
    // announces may already be under way.
    const atMs = this.clock();
    void this.slotForConfigDir(configDir)
      .then((slot) => {
        this.store.recordSessionSlot(sessionId, slot, atMs);
      })
      .catch((err: unknown) => {
        // Forget the claim so the session's next event tries again.
        if (this.lastConfigDir.get(sessionId) === configDir) this.lastConfigDir.delete(sessionId);
        this.logger?.warn({ err, sessionId }, 'session slot record failed (attribution only)');
      });
  }
}
