// Auto-switch policy: WHEN to hop accounts without being asked, and WHERE to hop.
//
// Like the advisor and the timeline, this is a PURE function of a moment's usage snapshot —
// no IO, no clock reads unless the caller omits `now` — so the daemon's trigger behavior is
// fully deterministic and unit-testable. The daemon owns the side effects (actually calling
// the switch engine, cooldowns, notifying the phone); this module only decides.
//
// The policy, as specified by the owner:
//   TRIGGER — the ACTIVE account's remaining quota is low (its worst limit is at/above
//   `triggerPercent` used). When the account's snapshot is STALE (older than `staleAfterMs`)
//   the bar tightens to `staleTriggerPercent`: usage only grows while we're blind, so a
//   stale near-limit reading is a floor, not a fact — hop before the unseen burn crosses
//   the hard cutoff and kills the session mid-work.
//   ELIGIBLE — a candidate must still have at least `minSessionHeadroomPct` of its 5h
//   session window left, must not itself already be low (otherwise the switch would
//   immediately re-trigger), and must have a KNOWN future weekly reset — the weekly
//   clock is the budget, and we never hop toward an account whose budget we can't see.
//   CHOICE — the eligible account whose WEEKLY quota resets soonest, full stop. WEEKLY is
//   the budget; the 5h window is only a gate, never a ranking key. Quota expiring soonest gets burned first, so the least is wasted.
//
// GREEDY mode (opt-in) adds a second trigger: even when the
// active account is NOT low, hop whenever some eligible account's weekly quota expires
// MATERIALLY sooner than the active one's — always burn the soonest-expiring budget. This is
// what pulls us BACK after a low-trigger hop: A hits 94%, we hop to B; once A's 5h window
// resets (its stale session limit stops counting and the 25% headroom gate reopens), A's
// sooner weekly reset makes it the greedy target again, so B's budget is spared and A's
// expiring quota gets fully burned.
//
// "Materially" is the anti-flap guarantee, and it must be a TIME MARGIN, not strict `<`:
// live-observed, the usage endpoint re-computes `resets_at` per response with sub-second
// jitter (the same nominal Wednesday-05:00 reset arrives as 04:59:59.70 on one poll and
// 05:00:00.51 on the next). Between two accounts sharing a nominal reset, raw-millisecond
// ordering therefore flips at random every poll, and strict `<` executes a hop on every
// cooldown expiry — endless ping-pong between budget-equal accounts. Within
// `greedyResetMarginMs` the budgets are the same for scheduling purposes, so greedy stays
// put and lets the active account's 5h window be used to the full; the low-quota trigger
// still rotates windows across equal accounts once the active one genuinely nears the wall.

import { humanizeDuration, roundPct } from './format.js';
import type { AccountUsageInput, LimitInput } from './types.js';

/** Knobs governing the auto-switch decision. Defaults live in this module. */
export interface AutoSwitchPolicy {
  /** The active account is "low" when its worst limit is at/above this percent used. */
  triggerPercent?: number;
  /** The tightened "low" threshold applied to an account whose snapshot is STALE (older
   *  than `staleAfterMs`). Usage only grows while we can't see it, so a stale near-limit
   *  reading must be assumed worse than it says: hop away from (and never toward) such an
   *  account earlier than the fresh-data trigger would. Clamped to never exceed
   *  `triggerPercent` — stale data can only tighten the bar, never raise it. */
  staleTriggerPercent?: number;
  /** Snapshot age at/above which an account's data counts as stale. */
  staleAfterMs?: number;
  /** Candidates must have at least this percent of the 5h session window unused. */
  minSessionHeadroomPct?: number;
  /** Also hop (even when the active account is healthy) to any eligible account whose
   *  weekly quota expires materially sooner — burn the expiring budget first. Off by
   *  default: it trades more account hops for less wasted quota. */
  greedy?: boolean;
  /** Greedy only hops when the target's weekly reset beats the active one's by MORE than
   *  this margin. Resets closer together than this count as the same budget deadline —
   *  see the module header for why raw ordering can't be trusted (per-poll jitter). */
  greedyResetMarginMs?: number;
}

// 94: hop only when the account is genuinely near the wall — fewer premature hops, still
// ahead of the hard 100% cutoff.
export const DEFAULT_TRIGGER_PERCENT = 94;
// 85 on stale data: a snapshot that old says "at LEAST this much used" — real usage has kept
// growing unseen, and waiting for a fresh 94% that may never arrive risks riding the account
// into the hard cutoff mid-session (lost work). 15% of assumed headroom buys the hop.
export const DEFAULT_STALE_TRIGGER_PERCENT = 85;
// 15 minutes: a healthy poller refreshes every ~3, so this is several consecutive failed
// live polls — genuine blindness, not one bad cycle. Cache-served snapshots carry their own
// original stamp, so hours-old fallback data lands here immediately.
export const DEFAULT_STALE_AFTER_MS = 15 * 60_000;
export const DEFAULT_MIN_SESSION_HEADROOM_PCT = 25;
// 15 minutes: orders of magnitude above the endpoint's observed sub-second reset jitter,
// far below any reset gap that would make burn order actually matter within a week.
export const DEFAULT_GREEDY_RESET_MARGIN_MS = 15 * 60_000;

/** A concrete "switch now" verdict. `null` from `decideAutoSwitch` means "do nothing". */
export interface AutoSwitchDecision {
  targetAccountId: string;
  targetLabel: string;
  /** One human sentence explaining the hop — shipped verbatim to the phone. */
  reason: string;
}

/**
 * Decide whether to auto-switch, and to which account. Returns `null` unless ALL of:
 * an active account exists, a trigger fires (its remaining quota is low, or greedy mode
 * spots a sooner-expiring weekly budget elsewhere), and at least one eligible candidate
 * exists. Limits whose reset time is already past are ignored everywhere — their
 * percents describe a window that no longer exists (stale cached snapshots routinely
 * carry them).
 */
export function decideAutoSwitch(
  accounts: AccountUsageInput[],
  now = Date.now(),
  policy: AutoSwitchPolicy = {},
): AutoSwitchDecision | null {
  const triggerPercent = policy.triggerPercent ?? DEFAULT_TRIGGER_PERCENT;
  const minSessionHeadroomPct = policy.minSessionHeadroomPct ?? DEFAULT_MIN_SESSION_HEADROOM_PCT;
  const staleAfterMs = policy.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
  // Stale data can only TIGHTEN the bar — a misconfigured stale threshold above the fresh
  // one would make blindness a reason to relax, which is never right.
  const staleTriggerPercent = Math.min(
    policy.staleTriggerPercent ?? DEFAULT_STALE_TRIGGER_PERCENT,
    triggerPercent,
  );
  /** Snapshot age, or 0 for accounts that never carried a stamp (treated as fresh). */
  const snapshotAge = (a: AccountUsageInput): number =>
    a.fetchedAtMs === undefined ? 0 : Math.max(0, now - a.fetchedAtMs);
  /** The "low" threshold this account is judged against, given its snapshot's age. */
  const lowThreshold = (a: AccountUsageInput): number =>
    snapshotAge(a) >= staleAfterMs ? staleTriggerPercent : triggerPercent;

  const active = accounts.find((a) => a.active);
  if (!active) return null;

  // No limit data at all means we know nothing — never act on ignorance.
  const activeWorst = worstPercent(active, now);
  if (activeWorst === undefined) return null;

  const candidates = accounts.filter(
    (a) =>
      !a.active &&
      !a.quarantined &&
      100 - sessionUsedPct(a, now) >= minSessionHeadroomPct &&
      // Never hop to an account that would itself immediately count as low — judged by ITS
      // OWN snapshot's age, so a stale near-limit candidate (whose true usage may already
      // be past the wall) is no safer a target than it would be to keep...
      (worstPercent(a, now) ?? 0) < lowThreshold(a) &&
      // ...or whose weekly budget clock we can't see — the choice is BY weekly reset,
      // so an unknown reset is not a lesser candidate, it's not a candidate at all.
      weeklyResetAt(a, now) !== undefined,
  );
  if (candidates.length === 0) return null;

  // Soonest weekly reset wins — weekly is the budget. Ties (same reset moment) go to the
  // account with MORE weekly budget remaining (the larger expiring asset), then label so
  // the decision is deterministic. The 5h window deliberately never ranks.
  candidates.sort((a, b) => {
    const resetDelta = (weeklyResetAt(a, now) as number) - (weeklyResetAt(b, now) as number);
    if (resetDelta !== 0) return resetDelta;
    const weeklyDelta = weeklyUsedPct(a, now) - weeklyUsedPct(b, now);
    if (weeklyDelta !== 0) return weeklyDelta;
    return a.label.localeCompare(b.label);
  });
  const target = candidates[0] as AccountUsageInput;
  const targetReset = weeklyResetAt(target, now) as number;
  const targetBudget =
    `in ${humanizeDuration(targetReset - now)}, ` +
    `${roundPct(100 - weeklyUsedPct(target, now))}% weekly budget left`;

  // Primary trigger: the active account is nearly out of quota. On a stale snapshot the
  // tightened threshold applies; a hop that ONLY the derate explains says so in its reason
  // (the fresh-data phrasing would claim a certainty the numbers don't have).
  if (activeWorst >= lowThreshold(active)) {
    const reason =
      activeWorst < triggerPercent
        ? `${active.label} is at ${roundPct(activeWorst)}% used on usage data ` +
          `${humanizeDuration(snapshotAge(active))} old — hopping preemptively — ` +
          `${target.label} has the soonest weekly reset (${targetBudget})`
        : `${active.label} is at ${roundPct(activeWorst)}% used — ${target.label} has the ` +
          `soonest weekly reset (${targetBudget})`;
    return { targetAccountId: target.accountId, targetLabel: target.label, reason };
  }

  // Greedy trigger: the active account is fine, but someone else's weekly budget expires
  // MATERIALLY sooner (beyond the anti-flap margin) — burn that first. An active account
  // with NO known weekly reset never outranks a known one (its budget clock is invisible,
  // so any known expiry is "sooner").
  if (policy.greedy) {
    const marginMs = policy.greedyResetMarginMs ?? DEFAULT_GREEDY_RESET_MARGIN_MS;
    const activeReset = weeklyResetAt(active, now);
    if (activeReset === undefined || targetReset < activeReset - marginMs) {
      const reason =
        `greedy: ${target.label}'s weekly quota expires soonest (${targetBudget})` +
        (activeReset === undefined
          ? ` while ${active.label}'s weekly reset is unknown`
          : ` — ${humanizeDuration(activeReset - targetReset)} before ${active.label}'s`);
      return { targetAccountId: target.accountId, targetLabel: target.label, reason };
    }
  }

  return null;
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

/** Percent of the weekly budget used — the max across live weekly limits (the binding
 *  one). No live weekly limit = 0 (only reachable in reason text, since eligibility
 *  already requires a known weekly reset). */
function weeklyUsedPct(account: AccountUsageInput, now: number): number {
  const weekly = effectiveLimits(account, now).filter(
    (l) => l.kind === 'weekly_all' || l.kind === 'weekly_scoped',
  );
  if (weekly.length === 0) return 0;
  return Math.max(...weekly.map((l) => l.percent));
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
