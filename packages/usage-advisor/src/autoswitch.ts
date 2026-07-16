// Auto-switch policy: WHEN to hop accounts without being asked, and WHERE to hop.
//
// Like the advisor and the timeline, this is a PURE function of a moment's usage snapshot —
// no IO, no clock reads unless the caller omits `now` — so the daemon's trigger behavior is
// fully deterministic and unit-testable. The daemon owns the side effects (actually calling
// the switch engine, cooldowns, notifying the phone); this module only decides.
//
// The policy, as specified by the owner:
//   TRIGGER — the ACTIVE account's remaining quota is low (its worst limit is at/above
//   `triggerPercent` used).
//   ELIGIBLE — a candidate must still have at least `minSessionHeadroomPct` of its 5h
//   session window left, and must not itself already be low (otherwise the switch would
//   immediately re-trigger).
//   CHOICE — among eligible candidates, the one whose WEEKLY quota resets soonest wins:
//   its unused quota expires first, so burning it first wastes the least (the same
//   asymmetry the timeline's "unused expires" line surfaces).

import { humanizeDuration, roundPct } from './format.js';
import type { AccountUsageInput, LimitInput } from './types.js';

/** Knobs governing the auto-switch decision. Defaults live in this module. */
export interface AutoSwitchPolicy {
  /** The active account is "low" when its worst limit is at/above this percent used. */
  triggerPercent?: number;
  /** Candidates must have at least this percent of the 5h session window unused. */
  minSessionHeadroomPct?: number;
}

export const DEFAULT_TRIGGER_PERCENT = 90;
export const DEFAULT_MIN_SESSION_HEADROOM_PCT = 25;

/** A concrete "switch now" verdict. `null` from `decideAutoSwitch` means "do nothing". */
export interface AutoSwitchDecision {
  targetAccountId: string;
  targetLabel: string;
  /** One human sentence explaining the hop — shipped verbatim to the phone. */
  reason: string;
}

/**
 * Decide whether to auto-switch, and to which account. Returns `null` unless ALL of:
 * an active account exists, its remaining quota is low, and at least one eligible
 * candidate exists. Limits whose reset time is already past are ignored everywhere —
 * their percents describe a window that no longer exists (stale cached snapshots
 * routinely carry them).
 */
export function decideAutoSwitch(
  accounts: AccountUsageInput[],
  now = Date.now(),
  policy: AutoSwitchPolicy = {},
): AutoSwitchDecision | null {
  const triggerPercent = policy.triggerPercent ?? DEFAULT_TRIGGER_PERCENT;
  const minSessionHeadroomPct = policy.minSessionHeadroomPct ?? DEFAULT_MIN_SESSION_HEADROOM_PCT;

  const active = accounts.find((a) => a.active);
  if (!active) return null;

  // No limit data at all means we know nothing — never act on ignorance.
  const activeWorst = worstPercent(active, now);
  if (activeWorst === undefined || activeWorst < triggerPercent) return null;

  const candidates = accounts.filter(
    (a) =>
      !a.active &&
      !a.quarantined &&
      100 - sessionUsedPct(a, now) >= minSessionHeadroomPct &&
      // Never hop to an account that would itself immediately count as low.
      (worstPercent(a, now) ?? 0) < triggerPercent,
  );
  if (candidates.length === 0) return null;

  // Soonest weekly reset first (unused quota expiring soonest = burn it first). Accounts
  // with no known weekly reset sort last; ties break on session headroom, then label so the
  // decision is deterministic.
  candidates.sort((a, b) => {
    const resetDelta = (weeklyResetAt(a, now) ?? Infinity) - (weeklyResetAt(b, now) ?? Infinity);
    if (resetDelta !== 0) return resetDelta;
    const sessionDelta = sessionUsedPct(a, now) - sessionUsedPct(b, now);
    if (sessionDelta !== 0) return sessionDelta;
    return a.label.localeCompare(b.label);
  });
  const target = candidates[0] as AccountUsageInput;

  const targetReset = weeklyResetAt(target, now);
  const resetNote =
    targetReset !== undefined
      ? `weekly resets in ${humanizeDuration(targetReset - now)}`
      : 'weekly reset unknown';
  const reason =
    `${active.label} is at ${roundPct(activeWorst)}% used — switching to ${target.label} ` +
    `(${roundPct(100 - sessionUsedPct(target, now))}% of a 5h window free, ${resetNote})`;

  return { targetAccountId: target.accountId, targetLabel: target.label, reason };
}

/** Limits that still describe a live window: reset time unknown, or still in the future. */
function effectiveLimits(account: AccountUsageInput, now: number): LimitInput[] {
  return account.limits.filter((l) => l.resetsAt === undefined || l.resetsAt > now);
}

/** The account's binding constraint — max percent used across live limits. `undefined`
 *  when the account reported no usable limit data. */
function worstPercent(account: AccountUsageInput, now: number): number | undefined {
  const limits = effectiveLimits(account, now);
  if (limits.length === 0) return undefined;
  return Math.max(...limits.map((l) => l.percent));
}

/** Percent of the 5h session window used. No live session limit = no open window = 0. */
function sessionUsedPct(account: AccountUsageInput, now: number): number {
  const session = effectiveLimits(account, now).find((l) => l.kind === 'session');
  return session?.percent ?? 0;
}

/** The soonest known FUTURE weekly reset (weekly_all or weekly_scoped), or undefined. */
function weeklyResetAt(account: AccountUsageInput, now: number): number | undefined {
  let best: number | undefined;
  for (const l of effectiveLimits(account, now)) {
    if (l.kind !== 'weekly_all' && l.kind !== 'weekly_scoped') continue;
    if (l.resetsAt === undefined) continue;
    if (best === undefined || l.resetsAt < best) best = l.resetsAt;
  }
  return best;
}
