// Bounded requestId -> Discord message reference for permission cards.
//
// WHY this exists at all: the plain DM send path (deliver() for permission.request) has no
// other memory of what it sent — unlike the managed-session surface, which keeps a per-route
// `cardMessages` map because a session's card is edited repeatedly over its lifetime. A
// permission card is edited exactly once, on a much later `permission.lapsed` push, so nothing
// else in the gateway holds a reference by the time that push arrives. This registry is that
// reference, deliberately just {channelId, messageId} (not a live discord.js Message) so it
// stays a plain, restart-legible mapping like the rest of this file's bounded structures.
//
// Bounded for the same reason as `SeenKeys` (idempotencyGuard.ts): an unbounded map is a slow
// leak on a long-lived bot. Unlike SeenKeys there is no TTL — a permission hold's own TTL is
// tens of minutes at most, comfortably inside a FIFO cap sized for a bot that is not receiving
// dozens of concurrent permission requests — so plain FIFO eviction (oldest entry dropped once
// the cap is exceeded) is enough; a request whose entry gets evicted before its lapse just
// falls into the same "unmapped card" drop path a bot restart would also produce.

export interface CardRef {
  channelId: string;
  messageId: string;
}

/** Hard ceiling on retained entries. Generous relative to how many permission requests could
 *  plausibly be in flight (unresolved AND unlapsed) at once — the daemon holds each request
 *  open for at most `permissionHoldMs`, so the live set this needs to cover is bounded by
 *  concurrent hooks, not by total requests ever sent. */
const MAX_ENTRIES = 64;

export class PermissionCardRegistry {
  // Map keeps insertion order, which IS FIFO eviction order.
  private readonly byRequestId = new Map<string, CardRef>();

  /** Remember where a just-sent permission card landed. Called once, right after the send. */
  record(requestId: string, ref: CardRef): void {
    if (this.byRequestId.size >= MAX_ENTRIES) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest !== undefined) this.byRequestId.delete(oldest);
    }
    this.byRequestId.set(requestId, ref);
  }

  /** Look up and drop in one step. A `permission.lapsed` edits its card at most once (the
   *  daemon emits the envelope exactly once per hold), so there is nothing to gain from
   *  keeping the entry after it is used — dropping it keeps the map smaller sooner. Returns
   *  `undefined` for a requestId this registry never saw (evicted, or a bot restart since the
   *  card was sent) — the caller's contract is to drop that case silently, never send a new
   *  message for a card it can no longer edit. */
  take(requestId: string): CardRef | undefined {
    const ref = this.byRequestId.get(requestId);
    if (ref !== undefined) this.byRequestId.delete(requestId);
    return ref;
  }

  /** Current retained-entry count — exposed for tests and diagnostics. */
  size(): number {
    return this.byRequestId.size;
  }
}
