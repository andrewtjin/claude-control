// The on-demand usage refresh: `POST /cli/usage/repoll` on the loopback CLI surface.
//
// A person looking at usage can ask for fresher numbers than the last cycle took. The answer is
// never "poll now, whatever": each account's poll floor and 429 backoff are there to keep the
// endpoint from being hammered, and a refresh key held down must not become the loop they exist to
// stop. So each requested account is either scheduled (it is due, and a cycle is started early to
// poll it) or skipped with the reason and, where there is one, the time it is next due. This
// module holds the wire contract, shared by the receiver and the CLI client, and the pure
// decision; the daemon starts the cycle.

import type { PollReadiness } from './usagePoller.js';

/** Why a requested account will not be polled by the refresh. */
export type UsageRepollSkipReason =
  /** Polled recently; the per-account floor holds it until `dueAtMs`. */
  | 'floor'
  /** The endpoint answered 429; the backoff holds it until `dueAtMs`. */
  | 'backoff'
  /** The daemon's last poll cycle failed before it could poll. The regular cycle keeps retrying;
   *  a refresh starts no extra one meanwhile, since it would only fail the same way. */
  | 'cycle_failed'
  /** No stored account has this id. */
  | 'unknown';

/** The verdict for one requested account. */
export type UsageRepollVerdict =
  | { id: string; outcome: 'scheduled' }
  | { id: string; outcome: 'skipped'; reason: 'floor' | 'backoff'; dueAtMs: number }
  | { id: string; outcome: 'skipped'; reason: 'cycle_failed' | 'unknown' };

/** The route's 200 body: one verdict per requested account, in request order (fleet order when
 *  the request named none). */
export interface UsageRepollResult {
  ok: true;
  results: UsageRepollVerdict[];
}

/** The logic the daemon installs on the receiver for the route. `ids` absent means every stored
 *  account. `'stopping'` means the daemon is shutting down and scheduled nothing; the receiver
 *  answers it with a 503. */
export interface HookReceiverUsageHandlers {
  repollUsage(ids: string[] | undefined): Promise<UsageRepollResult | 'stopping'>;
}

/** What the daemon knows beyond each account's own readiness. */
export interface UsageRepollContext {
  /** The last poll cycle failed. An account the floor or a backoff does not hold is then not
   *  scheduled: the failed cycle may never have reached the poll, so no state holds it, and
   *  starting a cycle per refresh would turn the refresh key into a loop of failing cycles. */
  cyclesFailing?: boolean;
}

/**
 * Decide, per requested account, whether a refresh polls it. Pure: the fleet and the poller's
 * readiness are passed in, so the decision is testable without a daemon.
 *
 * A repeated id is answered once (the first time it appears); asking twice for one account is
 * still one poll. An account held by its floor or backoff is reported held even while cycles are
 * failing: that answer is exact, and it says when to ask again.
 */
export function planUsageRepoll(
  ids: readonly string[] | undefined,
  fleetIds: readonly string[],
  readiness: (id: string) => PollReadiness,
  context: UsageRepollContext = {},
): UsageRepollVerdict[] {
  const known = new Set(fleetIds);
  const requested = [...new Set(ids ?? fleetIds)];
  return requested.map((id): UsageRepollVerdict => {
    if (!known.has(id)) return { id, outcome: 'skipped', reason: 'unknown' };
    const ready = readiness(id);
    if (!ready.due) {
      return { id, outcome: 'skipped', reason: ready.reason, dueAtMs: ready.dueAtMs };
    }
    return context.cyclesFailing === true
      ? { id, outcome: 'skipped', reason: 'cycle_failed' }
      : { id, outcome: 'scheduled' };
  });
}
