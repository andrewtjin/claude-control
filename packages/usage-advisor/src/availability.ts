// Which accounts can take work right now and, when none can, why each one is out and when the
// first one comes back.
//
// "Can take work" is ONE rule shared by every surface that asks: the advisor's exhausted bar,
// the daemon's post-switch resume of stalled sessions, and the exhaustion log the daemon keeps
// of the times no account could take work at all. Two definitions would let the log say "every
// account is out" while the resume kicked a session onto one of them. Pure, like the rest of
// this package: the caller supplies the snapshot and the moment.

import { humanizeDuration, roundPct } from './format.js';
import { effectiveLimits, LIMIT_NOUN, worstLimit } from './limits.js';
import type { AccountUsageInput, LimitInput } from './types.js';

/** Headroom at/below this is "effectively exhausted" — the one definition shared by the
 *  advisor's scoring (its `minUsableHeadroomPct` default) and the daemon's post-switch
 *  stalled-session kick, so "has usage left" can never mean two different things. */
export const MIN_USABLE_HEADROOM_PCT = 2;

/** Why an account cannot take work: a dead login, or the kind of limit it hit. */
export type UnavailableReason = 'quarantined' | LimitInput['kind'];

/** One account's verdict, with what a log entry needs to explain it. */
export interface AccountAvailability {
  accountId: string;
  label: string;
  /** Can this account take work right now? */
  usable: boolean;
  /** Whether live numbers back the verdict. False when the account reported no live limit and
   *  counts as usable only because unknown is not exhausted: never polled, a poll that came
   *  back empty, or every window it had has since reset. A caller that must not be fooled by a
   *  failed poll reads this before trusting a `usable`. */
  measured: boolean;
  /** Why it cannot take work. Absent when usable. */
  reason?: UnavailableReason;
  /** Percent used on the binding (worst) limit, when any live limit is known. */
  percent?: number;
  /** The live limits at the wall (headroom under {@link MIN_USABLE_HEADROOM_PCT}): every one
   *  of them must reset before the account is back. Empty when the quota is fine. */
  spent: LimitInput[];
  /** When the account can take work again: the moment the LAST limit at the wall resets.
   *  Absent when a limit at the wall has no known reset, and for a dead login, which a
   *  re-login brings back rather than a clock. */
  backAt?: number;
  /** True when `backAt` leans on the history-derived weekly prediction. */
  backAtPredicted?: boolean;
}

/** The whole fleet's verdict. */
export interface FleetAvailability {
  /** True when there is at least one account and none of them can take work. */
  exhausted: boolean;
  accounts: AccountAvailability[];
  /** The unavailable account expected back soonest, among those with a known `backAt`. */
  firstBack?: { accountId: string; label: string; at: number; predicted: boolean };
}

export interface AvailabilityOptions {
  /** Whether the Fable weekly cap counts as a wall. Pass the auto-switch policy's
   *  `fableCapTriggers`, so "out of usage" means exactly what auto-switch treats as out.
   *  Default true, as there. */
  countFableCap?: boolean;
}

/**
 * Judge one account. Quarantined = out (dead refresh token, unusable regardless of quota). No
 * live limit = usable: unknown is not exhausted, and the account with no snapshot at all
 * (dormant, never polled) is exactly the one holding a full untouched allowance. Otherwise
 * every live limit must clear the exhausted bar.
 */
export function assessAccount(
  account: AccountUsageInput,
  now: number,
  options: AvailabilityOptions = {},
): AccountAvailability {
  const visible =
    (options.countFableCap ?? true)
      ? account.limits
      : account.limits.filter((l) => l.kind !== 'weekly_scoped');
  const live = effectiveLimits(visible, now);
  const binding = worstLimit(visible, now);
  const spent = live.filter((l) => 100 - l.percent < MIN_USABLE_HEADROOM_PCT);
  const base = {
    accountId: account.accountId,
    label: account.label,
    measured: live.length > 0,
    spent,
    ...(binding !== undefined ? { percent: binding.percent } : {}),
  };
  if (account.quarantined) return { ...base, usable: false, reason: 'quarantined' };
  // `binding` is the worst live limit, so whenever anything is at the wall it is too.
  if (binding === undefined || spent.length === 0) return { ...base, usable: true };
  return { ...base, usable: false, reason: binding.kind, ...backAtOf(spent, account, now) };
}

/** When every limit at the wall has reset. A weekly budget whose window the endpoint stopped
 *  describing falls back to the caller's prediction, labelled as such; any other unknown reset
 *  makes the whole answer unknown, since the account is not back until all of them have. */
function backAtOf(
  spent: LimitInput[],
  account: AccountUsageInput,
  now: number,
): { backAt?: number; backAtPredicted?: boolean } {
  let backAt = Number.NEGATIVE_INFINITY;
  let predicted = false;
  for (const limit of spent) {
    let resetsAt = limit.resetsAt;
    if (
      resetsAt === undefined &&
      limit.kind === 'weekly_all' &&
      account.predictedResetAt !== undefined &&
      account.predictedResetAt > now
    ) {
      resetsAt = account.predictedResetAt;
      predicted = true;
    }
    if (resetsAt === undefined) return {};
    backAt = Math.max(backAt, resetsAt);
  }
  return { backAt, ...(predicted ? { backAtPredicted: true } : {}) };
}

/** Judge every account, and say whether none of them can take work. */
export function assessFleet(
  accounts: AccountUsageInput[],
  now: number,
  options: AvailabilityOptions = {},
): FleetAvailability {
  const judged = accounts.map((a) => assessAccount(a, now, options));
  let firstBack: FleetAvailability['firstBack'];
  for (const a of judged) {
    if (a.usable || a.backAt === undefined) continue;
    // Ties break by label, so the same fleet always names the same account.
    if (
      firstBack === undefined ||
      a.backAt < firstBack.at ||
      (a.backAt === firstBack.at && a.label < firstBack.label)
    ) {
      firstBack = {
        accountId: a.accountId,
        label: a.label,
        at: a.backAt,
        predicted: a.backAtPredicted === true,
      };
    }
  }
  return {
    exhausted: judged.length > 0 && judged.every((a) => !a.usable),
    accounts: judged,
    ...(firstBack !== undefined ? { firstBack } : {}),
  };
}

/**
 * Does this account have usage left to run work on right now? The fleet rule above for one
 * account, with every limit counted (the post-switch resume has no auto-switch policy to
 * defer to). Same pure-function posture as `decideAutoSwitch`: the caller supplies the
 * snapshot and the moment.
 */
export function hasUsableHeadroom(account: AccountUsageInput, now = Date.now()): boolean {
  return assessAccount(account, now).usable;
}

/** One unavailable account in words, shared by the log, the phone card and the CLI so they
 *  never describe the same account differently: "work2 (5-hour window 99%, back in 2h 13m)". */
export function describeUnavailable(a: AccountAvailability, now: number): string {
  if (a.reason === 'quarantined') return `${a.label} (login expired)`;
  const limit =
    a.reason !== undefined && a.percent !== undefined
      ? `${LIMIT_NOUN[a.reason]} ${roundPct(a.percent)}%`
      : 'out of usage';
  const back =
    a.backAt === undefined
      ? 'reset time unknown'
      : `back in ${humanizeDuration(a.backAt - now)}${a.backAtPredicted === true ? ' (predicted)' : ''}`;
  return `${a.label} (${limit}, ${back})`;
}

/** The "when is it over" sentence for an exhausted fleet. */
export function describeFirstBack(fleet: FleetAvailability, now: number): string {
  const first = fleet.firstBack;
  if (first === undefined) {
    return fleet.accounts.every((a) => a.reason === 'quarantined')
      ? 'Every login has expired: run cctl accounts reauth <name> to bring one back.'
      : 'No reset time is known for any of them.';
  }
  return (
    `First back: ${first.label} in ${humanizeDuration(first.at - now)}` +
    `${first.predicted ? ' (predicted)' : ''}.`
  );
}
