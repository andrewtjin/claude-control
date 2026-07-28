// Correlates a `stats.request` sent for one Discord interaction with the `stats.result` that
// answers it.
//
// WHY this exists: every other slash command in this bot answers from the state cache and replies
// synchronously. `/stats days:N` cannot — the number does not exist until the HOST re-reads its
// transcripts, which is seconds of disk IO, well past Discord's 3s acknowledgement limit. So the
// interaction is deferred and the reply is edited in later, which means something has to hold the
// waiting interaction from the moment the request goes out until the daemon's answer arrives on a
// completely different code path (`deliver()`). This registry is that something: the request side
// awaits a promise, the delivery side settles it by requestId, and neither has to know about the
// other.
//
// Every wait ends, deliberately. A daemon that dies mid-scan, a relay that drops the frame, or a
// scan that simply outlives its bound would otherwise leave a spinner on the phone until Discord
// expires the interaction with no explanation. The timeout converts all of those into one honest
// message the user can act on.

import type { PayloadOf } from '@claude-control/shared-protocol';

/** How a wait ended. `busy` is refused BEFORE any frame is sent — see {@link MAX_IN_FLIGHT}. */
export type StatsScanOutcome =
  { kind: 'result'; payload: PayloadOf<'stats.result'> } | { kind: 'timeout' } | { kind: 'busy' };

/** Ceiling on concurrently awaited scans. The daemon runs exactly one scan at a time and answers
 *  the rest with "already scanning", so in practice this is never approached; it exists so a user
 *  holding down `/stats` cannot grow this map for the length of the timeout window. Refusing at
 *  the cap (rather than evicting the oldest) keeps the promise contract honest: an entry that
 *  exists is always settled by exactly one of result/timeout, never dropped mid-wait. */
const MAX_IN_FLIGHT = 16;

interface Pending {
  settle: (outcome: StatsScanOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PendingStatsScans {
  private readonly byRequestId = new Map<string, Pending>();

  /**
   * Wait for the result of `requestId`, or give up after `timeoutMs`.
   *
   * MUST be called before the `stats.request` frame is sent, not after: the daemon's answer can
   * arrive on the delivery path before the caller's next line runs, and a result that lands with
   * nobody registered is dropped (see {@link settle}). The returned promise never rejects — every
   * failure mode is a value, so the caller has exactly one thing to render.
   */
  awaitResult(requestId: string, timeoutMs: number): Promise<StatsScanOutcome> {
    if (this.byRequestId.size >= MAX_IN_FLIGHT) return Promise.resolve({ kind: 'busy' });
    return new Promise<StatsScanOutcome>((resolve) => {
      const timer = setTimeout(() => {
        // Drop the entry FIRST: a late result must then take the no-waiter path rather than
        // resolving an already-resolved promise.
        this.byRequestId.delete(requestId);
        resolve({ kind: 'timeout' });
      }, timeoutMs);
      // Never hold the process open for a scan nobody is waiting on any more — the bot's
      // lifetime is owned by its gateway connection, not by a pending reply. Guarded because
      // `unref` exists on Node's Timeout but not in every timer typing this may compile under.
      timer.unref?.();
      this.byRequestId.set(requestId, { settle: resolve, timer });
    });
  }

  /**
   * Hand a delivered `stats.result` to whoever is waiting for it.
   *
   * Returns false when no one is — a result for a requestId this bot never registered, or whose
   * wait already timed out, or that arrived after a bot restart. That is a normal outcome, not an
   * error: the caller's contract is to drop it silently. Never a new message, because the only
   * surface this payload was ever meant for is an interaction that no longer exists.
   */
  settle(requestId: string, payload: PayloadOf<'stats.result'>): boolean {
    const pending = this.byRequestId.get(requestId);
    if (pending === undefined) return false;
    this.byRequestId.delete(requestId);
    clearTimeout(pending.timer);
    pending.settle({ kind: 'result', payload });
    return true;
  }

  /**
   * Stop waiting for `requestId` because the request never got out (an offline daemon, a relay
   * that refused the frame). No result can ever arrive, so holding the entry would do nothing but
   * burn the full timeout before telling the user something the caller already knows.
   *
   * Settles the pending promise as a timeout: the caller that registered the wait has, by the
   * time it abandons, already replied with the real send error, so the value is never rendered —
   * the settle exists only so the promise cannot be left dangling forever.
   */
  abandon(requestId: string): void {
    const pending = this.byRequestId.get(requestId);
    if (pending === undefined) return;
    this.byRequestId.delete(requestId);
    clearTimeout(pending.timer);
    pending.settle({ kind: 'timeout' });
  }

  /** Currently awaited scans — exposed for tests and diagnostics. */
  size(): number {
    return this.byRequestId.size;
  }
}
