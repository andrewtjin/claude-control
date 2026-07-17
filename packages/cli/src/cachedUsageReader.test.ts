import { describe, it, expect } from 'vitest';
import { createCachedUsageReader } from './cachedUsageReader.js';

/** A fake of the two vault reads the reader needs. */
function fakeVault(activeId: string | null, accountUuid?: string) {
  return {
    getActiveId: () => Promise.resolve(activeId),
    getAccount: (id: string) =>
      Promise.resolve(
        id === activeId
          ? {
              id,
              label: 'legoboy',
              quarantined: false,
              createdAtMs: 0,
              updatedAtMs: 0,
              ...(accountUuid !== undefined ? { accountUuid } : {}),
            }
          : undefined,
      ),
  };
}

function readerWith(
  claudeJson: unknown,
  vault: ReturnType<typeof fakeVault>,
): (accountId: string) => Promise<unknown> {
  return createCachedUsageReader({
    vault,
    claudeJsonPath: 'ignored',
    readFileFn: () => Promise.resolve(JSON.stringify(claudeJson)),
  });
}

describe('createCachedUsageReader', () => {
  const cache = { accountUuid: 'uuid-A', limits: [{ kind: 'session', percent: 3 }] };

  it('serves the cache when it belongs to the active account being polled', async () => {
    const read = readerWith({ cachedUsageUtilization: cache }, fakeVault('acct-1', 'uuid-A'));
    await expect(read('acct-1')).resolves.toEqual(cache);
  });

  it('returns undefined for any non-active account (the live config never describes them)', async () => {
    const read = readerWith({ cachedUsageUtilization: cache }, fakeVault('acct-1', 'uuid-A'));
    await expect(read('acct-2')).resolves.toBeUndefined();
  });

  it('refuses a cache written by a DIFFERENT account (the 2026-07-17 wrong-3% incident)', async () => {
    // The cache was written while another account was live; a switch back leaves it behind.
    const read = readerWith({ cachedUsageUtilization: cache }, fakeVault('acct-1', 'uuid-B'));
    await expect(read('acct-1')).resolves.toBeUndefined();
  });

  it('serves an UNPROVABLE mismatch: cache without accountUuid, or vault without one', async () => {
    const unstamped = { limits: [{ kind: 'session', percent: 3 }] };
    const noCacheUuid = readerWith(
      { cachedUsageUtilization: unstamped },
      fakeVault('acct-1', 'uuid-A'),
    );
    await expect(noCacheUuid('acct-1')).resolves.toEqual(unstamped);

    const noVaultUuid = readerWith({ cachedUsageUtilization: cache }, fakeVault('acct-1'));
    await expect(noVaultUuid('acct-1')).resolves.toEqual(cache);
  });

  it('degrades to undefined on unreadable or unparseable ~/.claude.json', async () => {
    const unreadable = createCachedUsageReader({
      vault: fakeVault('acct-1', 'uuid-A'),
      claudeJsonPath: 'ignored',
      readFileFn: () => Promise.reject(new Error('ENOENT')),
    });
    await expect(unreadable('acct-1')).resolves.toBeUndefined();

    const garbage = createCachedUsageReader({
      vault: fakeVault('acct-1', 'uuid-A'),
      claudeJsonPath: 'ignored',
      readFileFn: () => Promise.resolve('{not json'),
    });
    await expect(garbage('acct-1')).resolves.toBeUndefined();
  });
});
