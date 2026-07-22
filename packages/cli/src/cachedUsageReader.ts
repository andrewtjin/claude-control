// Tier-0 cached-usage reader for the daemon's poller.
//
// The live `~/.claude.json`'s `cachedUsageUtilization` is written by the CLI as WHOEVER was
// logged in at write time — and a switch content-swaps the credentials + `oauthAccount` but
// deliberately leaves this cache behind (it is the CLI's own file, not ours to rewrite). So
// "the active account's cache" is only trustworthy when the cache's own `accountUuid` matches
// the account being reported. Otherwise a two-minute hop to another account leaves THAT
// account's barely-used cache in place, and the phone confidently shows the busy active
// account at 3% for hours. Wrong data is worse than no data — on any PROVABLE
// owner mismatch this reader returns `undefined` (= "no cache for this account").

import { readFile } from 'node:fs/promises';
import type { Vault } from '@claude-control/switch-engine';

export interface CachedUsageReaderOptions {
  /** Peek-only vault reads: who is active, and each account's captured `accountUuid`. */
  vault: Pick<Vault, 'getActiveId' | 'getAccount'>;
  /** The live `~/.claude.json` (CLAUDE_CONFIG_DIR-aware — pass `paths.claudeJsonPath`). */
  claudeJsonPath: string;
  /** Injectable for tests; defaults to the real filesystem. */
  readFileFn?: (path: string, encoding: 'utf8') => Promise<string>;
}

/** Narrow an unknown value to a plain object without throwing. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the `getCachedUsage` function the daemon's `UsagePoller` is wired with. Returns the
 * raw `cachedUsageUtilization` value only when it plausibly describes the requested account:
 * the account must be the ACTIVE one (the live config never describes anyone else), and the
 * cache's `accountUuid` — when both sides carry one — must match the vault's record of that
 * account. Anything unreadable or provably foreign degrades to `undefined`, never a throw.
 */
export function createCachedUsageReader(
  options: CachedUsageReaderOptions,
): (accountId: string) => Promise<unknown> {
  const read = options.readFileFn ?? readFile;
  return async (accountId: string): Promise<unknown> => {
    // The cache lives in the LIVE config, which only ever describes the active account.
    if ((await options.vault.getActiveId()) !== accountId) return undefined;

    let cache: unknown;
    try {
      const parsed = JSON.parse(await read(options.claudeJsonPath, 'utf8')) as Record<
        string,
        unknown
      >;
      cache = parsed['cachedUsageUtilization'];
    } catch {
      return undefined;
    }

    // Owner check — but only a PROVABLE mismatch disqualifies: an old cache without an
    // `accountUuid`, or a vault entry that never captured one, cannot be checked, and
    // serving it preserves behavior for legacy setups instead of blinding them.
    if (isRecord(cache) && typeof cache['accountUuid'] === 'string') {
      const account = await options.vault.getAccount(accountId);
      if (
        typeof account?.accountUuid === 'string' &&
        cache['accountUuid'] !== account.accountUuid
      ) {
        return undefined;
      }
    }
    return cache;
  };
}
