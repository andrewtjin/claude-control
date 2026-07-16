// Tests for the poller's refresh-for-polling token getter, against a FAKE engine and a
// FAKE vault — proving the rate limit, the failure backoff, and the retry-read-once contract
// without any network or real credential machinery.

import { describe, it, expect, vi } from 'vitest';
import type { CredentialBundle, RefreshTokenResult } from '@claude-control/switch-engine';
import {
  createPollTokenGetter,
  POLL_REFRESH_MIN_INTERVAL_MS,
  type PollRefreshEngine,
} from './pollTokenGetter.js';

const MIN_TTL_MS = 60_000;
const HOUR = 3_600_000;

/** A mutable in-memory "vault" holding one bundle per account. */
function fakeVault(bundles: Map<string, CredentialBundle>) {
  return {
    readBundle: (id: string): Promise<CredentialBundle> => {
      const bundle = bundles.get(id);
      return bundle ? Promise.resolve(bundle) : Promise.reject(new Error(`no bundle for ${id}`));
    },
  };
}

/** A fake engine whose `refreshToken` mock is exposed separately, so assertions never touch
 *  the (lint-guarded) unbound method off the engine object. */
function fakeEngine(impl: (accountId: string) => Promise<RefreshTokenResult>): {
  engine: PollRefreshEngine;
  refreshToken: ReturnType<typeof vi.fn>;
} {
  const refreshToken = vi.fn(impl);
  return { engine: { refreshToken }, refreshToken };
}

function bundle(access: string, expiresAt: number): CredentialBundle {
  return { claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt } };
}

function refreshedResult(accountId: string, expiresAt: number): RefreshTokenResult {
  return { accountId, refreshed: true, expiresAt };
}

describe('createPollTokenGetter', () => {
  it('returns a valid vault token without ever touching the engine', async () => {
    const bundles = new Map([['a1', bundle('tok-fresh', 10 * HOUR)]]);
    const { engine, refreshToken } = fakeEngine(() => Promise.reject(new Error('unused')));
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
    });

    expect(await getToken('a1')).toBe('tok-fresh');
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('degrades an unreadable bundle to undefined (tier-0) without an engine call', async () => {
    const { engine, refreshToken } = fakeEngine(() => Promise.reject(new Error('unused')));
    const getToken = createPollTokenGetter({
      vault: fakeVault(new Map()),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
    });

    expect(await getToken('missing')).toBeUndefined();
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it('refresh succeeds: refreshes via the engine and returns the re-read token', async () => {
    const bundles = new Map([['a1', bundle('tok-old', -HOUR)]]); // expired
    // The fake engine does what the real one does: rotates the vault bundle in place.
    const { engine, refreshToken } = fakeEngine((id) => {
      bundles.set(id, bundle('tok-new', 10 * HOUR));
      return Promise.resolve(refreshedResult(id, 10 * HOUR));
    });
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
    });

    expect(await getToken('a1')).toBe('tok-new');
    expect(refreshToken).toHaveBeenCalledExactlyOnceWith('a1');
  });

  it('rate-limits: at most one refresh attempt per account per interval', async () => {
    let now = 0;
    // The engine "succeeds" but the token stays expired (e.g. an active-account skip).
    const bundles = new Map([['a1', bundle('tok-old', -HOUR)]]);
    const { engine, refreshToken } = fakeEngine((id) =>
      Promise.resolve(refreshedResult(id, -HOUR)),
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => now,
    });

    expect(await getToken('a1')).toBeUndefined(); // attempt 1, still no usable token
    // Every poll inside the interval falls back quietly WITHOUT another engine call.
    now = POLL_REFRESH_MIN_INTERVAL_MS - 1;
    expect(await getToken('a1')).toBeUndefined();
    expect(refreshToken).toHaveBeenCalledTimes(1);
    // Past the interval, one more attempt is allowed.
    now = POLL_REFRESH_MIN_INTERVAL_MS + 1;
    expect(await getToken('a1')).toBeUndefined();
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it('the rate limit is per-account, not global', async () => {
    const bundles = new Map([
      ['a1', bundle('t1', -HOUR)],
      ['a2', bundle('t2', -HOUR)],
    ]);
    const { engine, refreshToken } = fakeEngine((id) =>
      Promise.resolve(refreshedResult(id, -HOUR)),
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
    });

    await getToken('a1');
    await getToken('a2'); // a1's spent attempt must not block a2's first one
    expect(refreshToken).toHaveBeenCalledTimes(2);
    expect(refreshToken).toHaveBeenCalledWith('a2');
  });

  it('refresh fails: throws a reportable error and keeps it visible while backing off', async () => {
    let now = 0;
    const bundles = new Map([['a1', bundle('tok-old', -HOUR)]]);
    const { engine, refreshToken } = fakeEngine(() =>
      Promise.reject(new Error('endpoint returned 503')),
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => now,
    });

    // The failing attempt itself surfaces the reason (the poller stamps it on the snapshot).
    await expect(getToken('a1')).rejects.toThrow(/token refresh failed: endpoint returned 503/);
    // While rate-limited, the standing failure stays visible — but the engine is NOT re-hit.
    now += 60_000;
    await expect(getToken('a1')).rejects.toThrow(/endpoint returned 503/);
    expect(refreshToken).toHaveBeenCalledTimes(1);
  });

  it('backs off exponentially on consecutive failures', async () => {
    let now = 0;
    const bundles = new Map([['a1', bundle('tok-old', -HOUR)]]);
    const { engine, refreshToken } = fakeEngine(() => Promise.reject(new Error('boom')));
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => now,
    });

    await expect(getToken('a1')).rejects.toThrow(); // failure 1 → wait 1×interval
    now = POLL_REFRESH_MIN_INTERVAL_MS + 1;
    await expect(getToken('a1')).rejects.toThrow(); // failure 2 → wait 2×interval
    expect(refreshToken).toHaveBeenCalledTimes(2);

    // 1×interval later is now INSIDE the doubled window — no third attempt yet.
    now += POLL_REFRESH_MIN_INTERVAL_MS + 1;
    await expect(getToken('a1')).rejects.toThrow();
    expect(refreshToken).toHaveBeenCalledTimes(2);
    // Another interval clears the doubled window — attempt 3 goes through.
    now += POLL_REFRESH_MIN_INTERVAL_MS;
    await expect(getToken('a1')).rejects.toThrow();
    expect(refreshToken).toHaveBeenCalledTimes(3);
  });

  it('a success after failures resets the backoff and clears the standing error', async () => {
    let now = 0;
    const bundles = new Map([['a1', bundle('tok-old', -HOUR)]]);
    let fail = true;
    const { engine, refreshToken } = fakeEngine((id) => {
      if (fail) return Promise.reject(new Error('boom'));
      bundles.set(id, bundle('tok-new', now + 10 * HOUR));
      return Promise.resolve(refreshedResult(id, now + 10 * HOUR));
    });
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => now,
    });

    await expect(getToken('a1')).rejects.toThrow(/boom/);
    fail = false;
    now = POLL_REFRESH_MIN_INTERVAL_MS + 1;
    expect(await getToken('a1')).toBe('tok-new');
    // Subsequent polls just read the (now fresh) vault token — no error, no engine call.
    now += 60_000;
    expect(await getToken('a1')).toBe('tok-new');
    expect(refreshToken).toHaveBeenCalledTimes(2);
  });

  it('never leaks token material into thrown error messages', async () => {
    const bundles = new Map([['a1', bundle('SECRET-ACCESS', -HOUR)]]);
    const { engine } = fakeEngine(() => Promise.reject(new Error('refresh_failed')));
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
    });

    const err = await getToken('a1').catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/SECRET-ACCESS/);
  });
});
