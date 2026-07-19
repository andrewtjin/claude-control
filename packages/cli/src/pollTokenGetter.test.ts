// Tests for the poller's refresh-for-polling token getter, against a FAKE engine and a
// FAKE vault — proving the rate limit, the failure backoff, and the retry-read-once contract
// without any network or real credential machinery.

import { describe, it, expect, vi } from 'vitest';
import type { CredentialBundle, RefreshTokenResult } from '@claude-control/switch-engine';
import {
  createPollTokenGetter,
  POLL_REFRESH_MIN_INTERVAL_MS,
  PROFILE_ENDPOINT,
  type AccountIdentityRow,
  type PollIdentityOptions,
  type PollRefreshEngine,
  type ProfileFetch,
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

// --- identity invariant --------------------------------------------------------------------
// The getter must never hand out a token it cannot attribute to the account it is filed
// under: a contaminated bundle once made the poller silently report one account's usage as
// another's. Local check = registry row uuid vs bundle uuid; network check = profile
// endpoint's account.uuid vs registry row uuid, asked with the very token about to be used.

/** A bundle whose captured identity block names `uuid`. */
function bundleOwnedBy(access: string, expiresAt: number, uuid: string): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt },
    oauthAccount: { accountUuid: uuid },
  };
}

/** A profile endpoint fake answering 200 with `account.uuid = uuid`, recording every call. */
function profileAnswering(uuid: string): { fetchFn: ProfileFetch; calls: string[] } {
  const calls: string[] = [];
  const fetchFn: ProfileFetch = (url) => {
    calls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ account: { uuid } }) });
  };
  return { fetchFn, calls };
}

/** Identity wiring over a one-row fake registry + a quarantine recorder. */
function fakeIdentity(
  row: AccountIdentityRow | undefined,
  fetchFn: ProfileFetch,
): { identity: PollIdentityOptions; quarantined: Array<{ id: string; reason: string }> } {
  const quarantined: Array<{ id: string; reason: string }> = [];
  return {
    quarantined,
    identity: {
      lookupAccount: () => Promise.resolve(row),
      quarantine: (id, reason) => {
        quarantined.push({ id, reason });
        return Promise.resolve();
      },
      fetchFn,
    },
  };
}

describe('createPollTokenGetter — identity invariant', () => {
  const ROW_UUID = 'uuid-own';
  const FOREIGN_UUID = 'uuid-foreign';
  const noEngine = () => fakeEngine(() => Promise.reject(new Error('unused'))).engine;

  it('hands out a token whose bundle and profile identity both match, hitting the profile endpoint once per call', async () => {
    const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, ROW_UUID)]]);
    const profile = profileAnswering(ROW_UUID);
    const { identity, quarantined } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: false },
      profile.fetchFn,
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    expect(await getToken('a1')).toBe('tok');
    expect(await getToken('a1')).toBe('tok');
    expect(profile.calls).toEqual([PROFILE_ENDPOINT, PROFILE_ENDPOINT]);
    expect(quarantined).toEqual([]);
  });

  it('a bundle filed under the wrong account quarantines with both uuids named and withholds the token', async () => {
    const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, FOREIGN_UUID)]]);
    const profile = profileAnswering(ROW_UUID);
    const { identity, quarantined } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: false },
      profile.fetchFn,
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    await expect(getToken('a1')).rejects.toThrow(/identity mismatch.*quarantined/);
    expect(quarantined).toEqual([
      {
        id: 'a1',
        reason: `vault bundle identity mismatch (bundle ${FOREIGN_UUID} != registry ${ROW_UUID})`,
      },
    ]);
    expect(profile.calls).toEqual([]); // the local check gates before any network use
  });

  it('a row-matching bundle whose TOKEN the profile attributes elsewhere quarantines and withholds', async () => {
    // The lie the local check cannot see: a refresh response carries no identity, so foreign
    // tokens can sit under an honest-looking identity block. Only the network answer counts.
    const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, ROW_UUID)]]);
    const profile = profileAnswering(FOREIGN_UUID);
    const { identity, quarantined } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: false },
      profile.fetchFn,
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    await expect(getToken('a1')).rejects.toThrow(/token ownership mismatch.*quarantined/);
    expect(quarantined).toEqual([
      {
        id: 'a1',
        reason: `token ownership mismatch (profile account ${FOREIGN_UUID} != registry ${ROW_UUID})`,
      },
    ]);
  });

  it('fails OPEN on profile unavailability: network error, non-2xx, and shape drift all hand out the token', async () => {
    const cases: ProfileFetch[] = [
      () => Promise.reject(new Error('offline')),
      () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }),
      () => Promise.resolve({ ok: true, json: () => Promise.resolve({ unexpected: true }) }),
    ];
    for (const fetchFn of cases) {
      const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, ROW_UUID)]]);
      const { identity, quarantined } = fakeIdentity(
        { accountUuid: ROW_UUID, quarantined: false },
        fetchFn,
      );
      const getToken = createPollTokenGetter({
        vault: fakeVault(bundles),
        engine: noEngine(),
        minTtlMs: MIN_TTL_MS,
        clock: () => 0,
        identity,
      });
      expect(await getToken('a1')).toBe('tok');
      expect(quarantined).toEqual([]);
    }
  });

  it('a quarantined account is not polled at all: no bundle read, no network, reason surfaced', async () => {
    const readBundle = vi.fn(() => Promise.reject(new Error('must not be called')));
    const profile = profileAnswering(ROW_UUID);
    const { identity } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: true, quarantineReason: 'refresh token died' },
      profile.fetchFn,
    );
    const getToken = createPollTokenGetter({
      vault: { readBundle },
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    await expect(getToken('a1')).rejects.toThrow(/quarantined \(refresh token died\)/);
    expect(readBundle).not.toHaveBeenCalled();
    expect(profile.calls).toEqual([]);
  });

  it('an uncaptured identity is unverifiable, not guilty: row without a uuid skips both checks', async () => {
    const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, FOREIGN_UUID)]]);
    const profile = profileAnswering(FOREIGN_UUID);
    const { identity, quarantined } = fakeIdentity({ quarantined: false }, profile.fetchFn);
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    expect(await getToken('a1')).toBe('tok');
    expect(profile.calls).toEqual([]); // nothing to compare against — no wasted call either
    expect(quarantined).toEqual([]);
  });

  it('verifyOwnership: false keeps the free local check but never touches the network', async () => {
    const bundles = new Map([['a1', bundleOwnedBy('tok', 10 * HOUR, FOREIGN_UUID)]]);
    const profile = profileAnswering(ROW_UUID);
    const { identity, quarantined } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: false },
      profile.fetchFn,
    );
    identity.verifyOwnership = false;
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine: noEngine(),
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    await expect(getToken('a1')).rejects.toThrow(/vault bundle identity mismatch/);
    expect(quarantined).toHaveLength(1);
    expect(profile.calls).toEqual([]);
  });

  it('the post-refresh re-read re-runs the checks — rotated contents earn no extra trust', async () => {
    // Refresh "succeeds" but rotates a FOREIGN bundle into place (the contamination shape).
    const bundles = new Map([['a1', bundleOwnedBy('tok-old', -HOUR, ROW_UUID)]]);
    const { engine } = fakeEngine((id) => {
      bundles.set(id, bundleOwnedBy('tok-new', 10 * HOUR, FOREIGN_UUID));
      return Promise.resolve(refreshedResult(id, 10 * HOUR));
    });
    const profile = profileAnswering(ROW_UUID);
    const { identity, quarantined } = fakeIdentity(
      { accountUuid: ROW_UUID, quarantined: false },
      profile.fetchFn,
    );
    const getToken = createPollTokenGetter({
      vault: fakeVault(bundles),
      engine,
      minTtlMs: MIN_TTL_MS,
      clock: () => 0,
      identity,
    });

    await expect(getToken('a1')).rejects.toThrow(/vault bundle identity mismatch/);
    expect(quarantined).toHaveLength(1);
  });
});
