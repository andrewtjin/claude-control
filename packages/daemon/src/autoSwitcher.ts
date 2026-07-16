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
  /** Perform the hop — production wires this to `SwitchEngine.activate` (never forced). */
  activate: (accountId: string) => Promise<AutoSwitchActivateResult>;
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

export class AutoSwitcher {
  private readonly activate: (accountId: string) => Promise<AutoSwitchActivateResult>;
  private readonly notify: (payload: PayloadOf<'switch.result'>) => void;
  private readonly policy: AutoSwitchPolicy;
  private readonly cooldownMs: number;
  private readonly clock: () => number;
  private readonly newRequestId: () => string;
  private readonly logger: Logger;

  private lastAttemptAtMs = -Infinity;

  constructor(options: AutoSwitcherOptions) {
    this.activate = options.activate;
    this.notify = options.notify;
    this.policy = options.policy ?? {};
    this.cooldownMs = options.cooldownMs ?? DEFAULT_AUTOSWITCH_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
    this.newRequestId = options.newRequestId ?? randomUUID;
    this.logger = options.logger ?? noopLogger;
  }

  /** Evaluate one usage snapshot and hop if the policy says so. Never throws: an engine
   *  failure is reported (log + phone) and absorbed so the poll cycle stays healthy. */
  async evaluate(accounts: AccountUsageInput[]): Promise<void> {
    const now = this.clock();
    const decision = decideAutoSwitch(accounts, now, this.policy);
    if (!decision) return;

    if (now - this.lastAttemptAtMs < this.cooldownMs) {
      this.logger.debug({ decision }, 'auto-switch wanted but still in cooldown');
      return;
    }
    // Stamp BEFORE attempting so a throwing engine still gets its cooldown.
    this.lastAttemptAtMs = now;

    const requestId = `autoswitch-${this.newRequestId()}`;
    try {
      const result = await this.activate(decision.targetAccountId);
      this.logger.info({ decision, result }, 'auto-switch executed');
      this.notify({
        requestId,
        ok: result.ok,
        outcome: result.ok ? 'hot_applied' : 'failed',
        activeAccountId: result.activeAccountId,
        message: `auto-switch: ${decision.reason}`,
      });
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
        message: `auto-switch to ${decision.targetLabel} failed`,
        error: message,
      });
    }
  }
}
