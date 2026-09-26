// Auto-switch executor: turns the pure policy's verdict into an actual account hop.
//
// The policy (usage-advisor's `decideAutoSwitch`) decides WHEN and WHERE; this class owns
// everything stateful around it: the cooldown that stops a flapping snapshot from hammering
// the engine, calling `activate()`, and telling the phone what happened via the existing
// `switch.result` push (so an auto-hop shows up in Discord exactly like a manual /switch).
//
// ToS posture: this deliberately does NOT force. The engine's human-plausible cadence guard
// applies to auto-switches exactly as it does to manual ones — a refused hop is logged,
// reported, and retried no sooner than the next cooldown expiry.

import { randomUUID } from 'node:crypto';
import type { PayloadOf } from '@claude-control/shared-protocol';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import {
  decideAutoSwitch,
  type AccountUsageInput,
  type AutoSwitchPolicy,
} from '@claude-control/usage-advisor';

/** The slice of the switch engine's activate() result this class reports on. */
export interface AutoSwitchActivateResult {
  ok: boolean;
  activeAccountId: string;
}

export interface AutoSwitcherOptions {
  /** Perform the hop — production wires this to `SwitchEngine.activate` (never forced). The
   *  origin/reason this class always passes lets the audit trail (and, via the attribution
   *  journal, `activation_intervals`) tell a policy hop apart from a human's `/switch`. */
  activate: (
    accountId: string,
    options: { origin: 'auto'; reason: string },
  ) => Promise<AutoSwitchActivateResult>;
  /** Ship a `switch.result` payload to the phone (the daemon stamps the envelope). */
  notify: (payload: PayloadOf<'switch.result'>) => void;
  policy?: AutoSwitchPolicy;
  /** Minimum time between auto-switch ATTEMPTS (success or failure). */
  cooldownMs?: number;
  clock?: () => number;
  /** Injectable id source so tests can assert exact payloads. */
  newRequestId?: () => string;
  logger?: Logger;
}

/** Attempts, not successes, gate the cooldown — a failing engine must not be hammered
 *  every poll cycle. 10 minutes ≈ several poll cycles of breathing room. */
export const DEFAULT_AUTOSWITCH_COOLDOWN_MS = 10 * 60_000;

/** The cooldown key for the global slot — the default when no slot is named, so a caller that
 *  never passes a key keeps the single-slot behavior it always had. */
const GLOBAL_SLOT_KEY = 'global';

/** Per-evaluation context beyond the snapshot: which slot's rotation this decision is, and which
 *  accounts may be hop TARGETS in it. Absent = the global slot with no target restriction, exactly
 *  the pre-slot behavior. */
export interface EvaluateOptions {
  /** Distinct cooldown bucket for this slot, so a group hop never spends the global slot's
   *  cooldown (or another group's). Defaults to the global bucket. */
  slotKey?: string;
  /** Restrict hop targets to this id set (the slot's own pool). Passed through to the policy. */
  candidateIds?: ReadonlySet<string>;
  /** Human name of the slot this hop is in — the bound folder(s) for a group slot. When present it
   *  is woven into the `switch.result` message so the phone notice for a GROUP hop says WHICH folder
   *  group rotated, exactly as the operator needs to tell a group hop apart from the global one.
   *  Absent for the global slot, whose notice keeps its historical wording. */
  slotLabel?: string;
}

export class AutoSwitcher {
  private readonly activate: (
    accountId: string,
    options: { origin: 'auto'; reason: string },
  ) => Promise<AutoSwitchActivateResult>;
  private readonly notify: (payload: PayloadOf<'switch.result'>) => void;
  private readonly policy: AutoSwitchPolicy;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly newRequestId: () => string;
  private readonly logger: Logger;

  /** Last attempt time PER slot bucket, so each slot's cooldown runs independently — a group hop
   *  and a global hop never share a clock. */
  private readonly lastAttemptAtMs = new Map<string, number>();

  constructor(options: AutoSwitcherOptions) {
    this.activate = options.activate;
    this.notify = options.notify;
    this.policy = options.policy ?? {};
    this.cooldownMs = options.cooldownMs ?? DEFAULT_AUTOSWITCH_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
    this.newRequestId = options.newRequestId ?? randomUUID;
    this.logger = options.logger ?? noopLogger;
  }

  /**
   * Evaluate one usage snapshot and hop if the policy says so. Never throws: an engine failure
   * is reported (log + phone) and absorbed so the poll cycle stays healthy.
   *
   * Resolves with the account id this call ACTIVATED, or `undefined` when it activated nothing
   * (no decision, still in cooldown, or the engine refused). That id is the caller's only honest
   * way to tell its own hop apart from a switch somebody else made while the cycle was running:
   * re-reading the live account afterwards cannot distinguish the two, and reading a human's
   * switch as the daemon's own is what silently swallows it. Reported only for a successful
   * activation — a refused hop left the live account wherever it already was, and claiming it as
   * ours would swallow that account's real owner just the same.
   */
  async evaluate(
    accounts: AccountUsageInput[],
    opts: EvaluateOptions = {},
  ): Promise<string | undefined> {
    const now = this.clock();
    const slotKey = opts.slotKey ?? GLOBAL_SLOT_KEY;
    const decision = decideAutoSwitch(
      accounts,
      now,
      this.policy,
      opts.candidateIds !== undefined ? { candidateIds: opts.candidateIds } : {},
    );
    if (!decision) return undefined;

    const lastAttempt = this.lastAttemptAtMs.get(slotKey) ?? -Infinity;
    if (now - lastAttempt < this.cooldownMs) {
      this.logger.debug({ decision, slotKey }, 'auto-switch wanted but still in cooldown');
      return undefined;
    }
    // Stamp BEFORE attempting so a throwing engine still gets its cooldown — for THIS slot only.
    this.lastAttemptAtMs.set(slotKey, now);

    // A group hop's notice names its folder so it is not read as a global switch; the global slot
    // passes no label and keeps its historical wording.
    const scope = opts.slotLabel !== undefined ? ` (${opts.slotLabel})` : '';
    const requestId = `autoswitch-${this.newRequestId()}`;
    try {
      const result = await this.activate(decision.targetAccountId, {
        origin: 'auto',
        reason: decision.reason,
      });
      this.logger.info({ decision, result }, 'auto-switch executed');
      this.notify({
        requestId,
        ok: result.ok,
        outcome: result.ok ? 'hot_applied' : 'failed',
        activeAccountId: result.activeAccountId,
        message: `auto-switch${scope}: ${decision.reason}`,
      });
      // The engine's own word for what is live now, not the target we asked for: the two agree
      // today, and a caller that absorbs this id must absorb what actually happened.
      return result.ok ? result.activeAccountId : undefined;
    } catch (err) {
      // Typically the engine's cadence guard or a refresh failure — absorbed, reported.
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn({ decision, err }, 'auto-switch attempt failed');
      const currentActive = accounts.find((a) => a.active)?.accountId ?? decision.targetAccountId;
      this.notify({
        requestId,
        ok: false,
        outcome: 'failed',
        activeAccountId: currentActive,
        message: `auto-switch${scope} to ${decision.targetLabel} failed`,
        error: message,
      });
      return undefined;
    }
  }
}
