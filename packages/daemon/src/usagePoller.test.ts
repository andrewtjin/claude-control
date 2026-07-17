import { describe, it, expect, vi } from 'vitest';
import {
  UsagePoller,
  POLL_FLOOR_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type FetchLike,
  type FetchLikeResponse,
  type PollAccount,
} from './usagePoller.js';

function jsonResponse(status: number, body: unknown): FetchLikeResponse {
  return { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) };
}

const liveBody = (percent: number) => ({ utilization: { limits: [{ kind: 'session', percent }] } });
const cachedBody = (percent: number) => ({ limits: [{ kind: 'session', percent }] });

const account: PollAccount = {
  accountId: 'acct-1',
  label: 'Work',
  active: true,
  quarantined: false,
};
const account2: PollAccount = {
  accountId: 'acct-2',
  label: 'Alt',
  active: false,
  quarantined: false,
};

describe('UsagePoller', () => {
  it('tier-1 success: fetches with the right headers and parses a live snapshot', async () => {
    let seenUrl = '';
    let seenHeaders: Record<string, string> = {};
    const fetchFn: FetchLike = vi.fn((url: string, init: { headers: Record<string, string> }) => {
      seenUrl = url;
      seenHeaders = init.headers;
      return Promise.resolve(jsonResponse(200, liveBody(33)));
    });
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok-abc'),
      getCachedUsage: () => Promise.resolve(cachedBody(0)),
      clock: () => 1000,
    });

    const snapshot = await poller.pollAll([account]);
    expect(seenUrl).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(seenHeaders.authorization).toBe('Bearer tok-abc');
    expect(seenHeaders['anthropic-beta']).toBe('oauth-2025-04-20');
    expect(seenHeaders['user-agent']).toBeDefined();

    expect(snapshot.results[0]?.outcome).toBe('live');
    expect(snapshot.accounts[0]?.source).toBe('live');
    expect(snapshot.accounts[0]?.limits[0]?.percent).toBe(33);
  });

  it('falls back to tier-0 cached usage when getToken yields no token', async () => {
    const fetchFn: FetchLike = vi.fn();
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve(undefined),
      getCachedUsage: () => Promise.resolve(cachedBody(50)),
      clock: () => 1000,
    });
    const snapshot = await poller.pollAll([account]);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(snapshot.results[0]?.outcome).toBe('cached');
    expect(snapshot.accounts[0]?.source).toBe('cached');
    expect(snapshot.accounts[0]?.limits[0]?.percent).toBe(50);
  });

  it('a throwing getToken falls back to tier-0 AND surfaces the failure on the account', async () => {
    const fetchFn: FetchLike = vi.fn();
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.reject(new Error('token refresh failed: endpoint returned 503')),
      getCachedUsage: () => Promise.resolve(cachedBody(50)),
      clock: () => 1000,
    });
    const snapshot = await poller.pollAll([account]);
    // Same fallback as an undefined token — the cycle survives, tier-0 answers...
    expect(fetchFn).not.toHaveBeenCalled();
    expect(snapshot.results[0]?.outcome).toBe('cached');
    expect(snapshot.accounts[0]?.limits[0]?.percent).toBe(50);
    // ...but the WHY reaches the snapshot instead of being swallowed.
    expect(snapshot.accounts[0]?.error).toMatch(/token refresh failed: endpoint returned 503/);
  });

  it('429 triggers cached fallback; the floor is a hard minimum wait even under backoff', async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(429, {})));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(10)),
      clock: () => now,
      random: () => 0, // no jitter, deterministic
    });

    const first = await poller.pollAll([account]);
    expect(first.results[0]?.outcome).toBe('cached');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Immediately re-polling must not re-fetch: neither the floor nor the (smaller) first
    // backoff window has elapsed yet.
    now += 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // The first 429's backoff (BACKOFF_BASE_MS) is smaller than the floor, so the floor is
    // what actually governs the wait — advancing past only the backoff must NOT retry yet.
    now = BACKOFF_BASE_MS + 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Advancing past the floor retries and gets 429 again.
    now = POLL_FLOOR_MS + 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('exponential backoff overtakes the floor after enough consecutive 429s', async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(429, {})));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(10)),
      clock: () => now,
      random: () => 0,
    });

    // Drive 4 consecutive 429s, each time advancing `now` by exactly the wait the PRIOR call
    // computed (floor dominates through the 3rd; the 4th's backoff, base*2^3=240s, is the
    // first to exceed the floor) so every call in the loop actually re-fetches.
    const waits = [POLL_FLOOR_MS, POLL_FLOOR_MS, POLL_FLOOR_MS, BACKOFF_BASE_MS * 2 ** 3];
    for (const wait of waits) {
      await poller.pollAll([account]);
      now += wait + 1;
    }
    expect(fetchFn).toHaveBeenCalledTimes(4);

    // The 4th 429 set a wait of base*2^3=240s (> floor). Advancing by only floor+1 must NOT
    // be enough to retry — proof the backoff, not the floor, now governs.
    now = now - (BACKOFF_BASE_MS * 2 ** 3 + 1) + (POLL_FLOOR_MS + 1);
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });

  it('backoff plateaus at the 30-minute cap instead of growing unbounded', async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(429, {})));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(10)),
      clock: () => now,
      random: () => 0,
    });

    // Drive 8 consecutive 429s with a generously large jump each time (always clears
    // whatever the wait was, capped or not) so backoff has long since saturated at the cap.
    for (let i = 0; i < 8; i++) {
      await poller.pollAll([account]);
      now += BACKOFF_CAP_MS + 1;
    }
    expect(fetchFn).toHaveBeenCalledTimes(8);

    // One more 429 at the (now-saturated) cap: advancing by exactly cap-1 must NOT be due...
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(9);
    now += BACKOFF_CAP_MS - 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(9);
    // ...but the remaining 1ms to reach the cap makes it due — proving the wait held steady
    // at exactly the cap rather than continuing to grow past it.
    now += 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(10);
  });

  it('a network error falls back to tier-0 without applying 429-style backoff', async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => {
      throw new Error('ECONNRESET');
    });
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(5)),
      clock: () => now,
      random: () => 0,
    });

    const result = await poller.pollAll([account]);
    expect(result.results[0]?.outcome).toBe('cached');
    expect(result.accounts[0]?.error).toMatch(/ECONNRESET/);

    // Because network errors don't back off, the ONLY gate on the next poll is the floor —
    // advancing past it should retry, not stay silenced by backoff.
    now = POLL_FLOOR_MS + 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a non-2xx, non-429 status falls back to tier-0 and reports the status', async () => {
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(500, {})));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(1)),
      clock: () => 0,
    });
    const result = await poller.pollAll([account]);
    expect(result.results[0]?.outcome).toBe('cached');
    expect(result.accounts[0]?.error).toMatch(/500/);
  });

  it('enforces the per-account poll floor (>=180s) between live fetches', async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(200, liveBody(1))));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(0)),
      clock: () => now,
      random: () => 0,
    });

    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    now = POLL_FLOOR_MS - 1;
    const skipped = await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(skipped.results[0]?.outcome).toBe('skipped');

    now = POLL_FLOOR_MS + 1;
    await poller.pollAll([account]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it("polls a never-before-seen account immediately regardless of another account's floor", async () => {
    let now = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(200, liveBody(1))));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(cachedBody(0)),
      clock: () => now,
    });
    await poller.pollAll([account]);
    now += 1; // well within account's floor, but account2 has never been polled
    await poller.pollAll([account, account2]);
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('a skipped cycle returns the retained live result unchanged (original fetchedAtMs, not now)', async () => {
    let now = 1000;
    let cachedReads = 0;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(200, liveBody(42))));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => {
        cachedReads++;
        return Promise.resolve(cachedBody(0));
      },
      clock: () => now,
      random: () => 0,
    });

    const live = await poller.pollAll([account]);
    expect(live.results[0]?.outcome).toBe('live');
    const liveUsage = live.results[0]!.usage;
    expect(liveUsage.accountUsage.fetchedAtMs).toBe(1000);
    expect(liveUsage.accountUsage.source).toBe('live');

    // Within the floor → this cycle is skipped. It must return the retained POLLED DATA
    // unchanged (ORIGINAL fetchedAtMs/source/limits), and must NOT re-read tier-0 (which
    // would report frozen cache stamped fetchedAtMs:now as if freshly fetched).
    now = POLL_FLOOR_MS - 1;
    const skipped = await poller.pollAll([account]);
    expect(skipped.results[0]?.outcome).toBe('skipped');
    expect(skipped.results[0]?.usage.accountUsage.fetchedAtMs).toBe(1000);
    expect(skipped.results[0]?.usage.accountUsage.source).toBe('live');
    expect(skipped.results[0]?.usage.accountUsage.limits).toEqual(liveUsage.accountUsage.limits);
    expect(cachedReads).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('a skipped cycle re-stamps identity flags — a switch during the poll floor is visible at once', async () => {
    let now = 1000;
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(200, liveBody(42))));
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: () => Promise.resolve('tok'),
      getCachedUsage: () => Promise.resolve(undefined),
      clock: () => now,
    });

    const live = await poller.pollAll([account]); // polled while ACTIVE
    expect(live.results[0]?.usage.accountUsage.active).toBe(true);

    // The user switches away before the account is due again: the skipped result must
    // carry active:false (and current quarantine/label) even though its usage numbers and
    // fetchedAtMs are still the retained ones — otherwise the advisor and the auto-switcher
    // reason about who WAS active for up to a whole poll floor.
    now = POLL_FLOOR_MS - 1;
    const flipped: PollAccount = { ...account, active: false, quarantined: true, label: 'Renamed' };
    const skipped = await poller.pollAll([flipped]);
    expect(skipped.results[0]?.outcome).toBe('skipped');
    expect(skipped.results[0]?.usage.accountUsage.active).toBe(false);
    expect(skipped.results[0]?.usage.accountUsage.label).toBe('Renamed');
    expect(skipped.results[0]?.usage.advisorInput.active).toBe(false);
    expect(skipped.results[0]?.usage.advisorInput.quarantined).toBe(true);
    expect(skipped.results[0]?.usage.accountUsage.fetchedAtMs).toBe(1000); // data still aged
  });

  it('one account failing to read tier-0 cache degrades only that account, not the whole cycle', async () => {
    const fetchFn: FetchLike = vi.fn(() => Promise.resolve(jsonResponse(200, liveBody(20))));
    const poller = new UsagePoller({
      fetch: fetchFn,
      // acct-2 has no token, forcing it down the tier-0 path where the disk read rejects.
      getToken: (id: string) => Promise.resolve(id === 'acct-2' ? undefined : 'tok'),
      getCachedUsage: (id: string) =>
        id === 'acct-2'
          ? Promise.reject(new Error('EIO disk error'))
          : Promise.resolve(cachedBody(0)),
      clock: () => 0,
      advisorOptions: { now: () => 0 },
    });

    const snapshot = await poller.pollAll([account, account2]);
    // The failing account does not sink the cycle: every account is still reported + planned.
    expect(snapshot.accounts).toHaveLength(2);
    expect(snapshot.plan.ranking).toHaveLength(2);

    const r1 = snapshot.results.find((r) => r.accountId === 'acct-1');
    expect(r1?.outcome).toBe('live');
    expect(r1?.usage.accountUsage.limits[0]?.percent).toBe(20);

    const r2 = snapshot.results.find((r) => r.accountId === 'acct-2');
    expect(r2?.usage.accountUsage.error).toMatch(/EIO disk error/);
    expect(r2?.usage.accountUsage.limits).toHaveLength(0);
  });

  it('assembles a UsagePlan from the polled accounts via the advisor', async () => {
    const fetchFn: FetchLike = vi.fn((_url: string, init: { headers: Record<string, string> }) => {
      const auth = init.headers.authorization;
      return Promise.resolve(
        auth === 'Bearer tok-1' ? jsonResponse(200, liveBody(90)) : jsonResponse(200, liveBody(5)),
      );
    });
    const poller = new UsagePoller({
      fetch: fetchFn,
      getToken: (id: string) => Promise.resolve(id === 'acct-1' ? 'tok-1' : 'tok-2'),
      getCachedUsage: () => Promise.resolve(cachedBody(0)),
      clock: () => 0,
      advisorOptions: { now: () => 0 },
    });
    const snapshot = await poller.pollAll([
      { ...account, active: true },
      { ...account2, active: false },
    ]);
    // acct-2 has far more headroom (95%) than acct-1 (10%), so it should be recommended.
    expect(snapshot.plan.recommendedAccountId).toBe('acct-2');
    expect(snapshot.plan.ranking).toHaveLength(2);
  });
});
