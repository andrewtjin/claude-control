import { describe, it, expect } from 'vitest';
import { SeenKeys } from './idempotencyGuard.js';

describe('SeenKeys.markIfNew', () => {
  it('returns true the first time a key is seen and false on a duplicate', () => {
    const seen = new SeenKeys({ max: 10 });
    expect(seen.markIfNew('k1')).toBe(true);
    expect(seen.markIfNew('k1')).toBe(false);
    expect(seen.markIfNew('k2')).toBe(true);
  });

  it('forget() rolls back a mark so a retry is treated as new again', () => {
    const seen = new SeenKeys({ max: 10 });
    expect(seen.markIfNew('k')).toBe(true);
    expect(seen.markIfNew('k')).toBe(false); // marked
    seen.forget('k'); // e.g. the marked action failed (daemon offline)
    expect(seen.markIfNew('k')).toBe(true); // retryable again
    expect(seen.size()).toBe(1);
  });

  it('evicts the oldest key once the cap is exceeded (bounded memory)', () => {
    const seen = new SeenKeys({ max: 2 });
    expect(seen.markIfNew('a')).toBe(true);
    expect(seen.markIfNew('b')).toBe(true);
    expect(seen.markIfNew('c')).toBe(true); // pushes 'a' out
    expect(seen.size()).toBe(2);
    // 'a' was evicted → seen as new again; 'b'/'c' are still live duplicates.
    expect(seen.markIfNew('a')).toBe(true);
    expect(seen.markIfNew('c')).toBe(false);
  });

  it('forgets a key once it ages past the TTL (injected clock, no fake timers)', () => {
    let now = 0;
    const seen = new SeenKeys({ max: 10, ttlMs: 1000, clock: () => now });
    expect(seen.markIfNew('k')).toBe(true);
    now = 1000; // exactly at the TTL boundary is still a duplicate
    expect(seen.markIfNew('k')).toBe(false);
    now = 1001; // past the window → treated as new again
    expect(seen.markIfNew('k')).toBe(true);
  });

  it('a refreshed key moves to the tail so it is not the next evicted', () => {
    let now = 0;
    const seen = new SeenKeys({ max: 2, ttlMs: 100, clock: () => now });
    seen.markIfNew('a'); // t=0
    seen.markIfNew('b'); // t=0
    now = 200; // both 'a' and 'b' now expired
    expect(seen.markIfNew('a')).toBe(true); // refreshes 'a' to the tail
    expect(seen.markIfNew('c')).toBe(true); // cap exceeded → evicts the oldest, which is 'b'
    now = 210;
    // 'a' survived (was refreshed), 'b' was evicted.
    expect(seen.markIfNew('a')).toBe(false);
  });
});
