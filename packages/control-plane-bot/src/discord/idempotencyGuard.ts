// Bot-side double-click guard: a bounded set of already-seen idempotency keys.
//
// WHY at the bot at all when the daemon already single-resolves permissions: a double-tapped
// button (or the same tap arriving from two paired phones) should not even put a second command
// frame on the wire. This guard is that first line — `markIfNew` returns false the second time a
// key is seen, so the gateway can answer "already handled" without sending anything.
//
// Bounded on purpose: an unbounded set is a slow memory leak on a long-lived bot. We cap the
// entry count (FIFO eviction of the oldest key) and optionally age keys out by TTL, so the guard
// costs O(cap) memory forever. The clock is injected so eviction/TTL is testable without fake
// timers, matching the rest of the package.

export interface SeenKeysOptions {
  /** Hard ceiling on retained keys; the oldest is evicted once this is exceeded. */
  max: number;
  /** Optional age (ms) after which a key is considered forgotten. A tap re-seen past its TTL is
   *  treated as new — the double-tap window is long gone by then. Omit for no expiry. */
  ttlMs?: number;
  clock?: () => number;
}

export class SeenKeys {
  // Map keeps insertion order, which IS our FIFO eviction order; value = time first recorded.
  private readonly seen = new Map<string, number>();
  private readonly max: number;
  private readonly ttlMs: number | undefined;
  private readonly clock: () => number;

  constructor(options: SeenKeysOptions) {
    this.max = Math.max(1, options.max);
    this.ttlMs = options.ttlMs;
    this.clock = options.clock ?? (() => Date.now());
  }

  /**
   * Record `key` if it is new (or its prior record has aged past the TTL) and return true;
   * return false if it is a live duplicate. The common "first tap" path is a single Map write
   * plus at most one eviction.
   */
  markIfNew(key: string): boolean {
    const now = this.clock();
    const prev = this.seen.get(key);
    if (prev !== undefined && (this.ttlMs === undefined || now - prev <= this.ttlMs)) {
      return false; // still within the dedupe window → already handled
    }
    // New, or a TTL-expired resurrection: re-insert at the tail (delete first so the Map's order
    // reflects recency, keeping FIFO eviction meaningful for a refreshed key).
    this.seen.delete(key);
    this.seen.set(key, now);
    while (this.seen.size > this.max) {
      const oldest = this.seen.keys().next().value;
      if (oldest === undefined) break;
      this.seen.delete(oldest);
    }
    return true;
  }

  /** Current retained-key count — exposed for tests and diagnostics. */
  size(): number {
    return this.seen.size;
  }
}
