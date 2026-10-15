// The usage picture every usage-reading view starts from: the registry, the daemon's latest
// persisted snapshot per account, and the history-derived measurements the pure advisor cannot
// make for itself.
//
// Read locally (the vault and daemon.db), never from Anthropic: it works whether or not the daemon
// is running, showing its last poll. Shared by the one-shot commands (`usage`, `timeline`,
// `session status`, the outage judgement) and the full-screen view, so the numbers on every
// surface come from one reader.

import type { StoredAccount } from '@claude-control/switch-engine';
import { Store, readFleetHistory } from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { planWeight } from '@claude-control/usage-advisor';
import { buildEngine, daemonDbPath } from './context.js';

type Engine = ReturnType<typeof buildEngine>;

/** What `usage` and `timeline` read before rendering: the registry, the daemon's latest
 *  persisted snapshot per account, and the two history-derived measurements the pure advisor
 *  cannot make for itself (each account's predicted weekly reset and the fleet's burn rate).
 *  Works whether or not the daemon is currently running (it shows the last poll), and opening
 *  a not-yet-created db just yields an empty one. A corrupt snapshot row is skipped, never
 *  fatal. */
export interface UsageState {
  accounts: StoredAccount[];
  activeId: string | null;
  usageFor: (accountId: string) => AccountUsage | undefined;
  /** Next weekly reset predicted from stored history, for accounts the endpoint has stopped
   *  publishing one for. Absent when the account has no observed reset in history at all. */
  predictedResetFor: (accountId: string) => number | undefined;
  /** Fleet burn in Pro-equivalent units/day, or undefined when history cannot measure one. */
  burnUnitsPerDay: number | undefined;
}

/** The usage view's state: the shared accounts, the global live account and each account's latest
 *  snapshot. `only` names the accounts to read instead (the outage judgement reads the whole fleet,
 *  reserved accounts included). `engine` is the one to read through; a caller drawing its own
 *  screen passes one whose diagnostics land somewhere other than stderr. */
export async function readUsageState(
  nowMs: number,
  only?: StoredAccount[],
  engine: Engine = buildEngine(),
): Promise<UsageState> {
  const [accounts, activeId] = await Promise.all([
    only !== undefined ? Promise.resolve(only) : engine.listAccounts(),
    engine.getActiveId(),
  ]);
  const store = new Store(daemonDbPath());
  try {
    const byId = new Map<string, AccountUsage>();
    for (const a of accounts) {
      const row = store.latestUsageSnapshot(a.id);
      if (!row) continue;
      try {
        byId.set(a.id, JSON.parse(row.json) as AccountUsage);
      } catch {
        // a corrupt row must not crash the whole view
      }
    }
    // The same measurement the daemon makes each poll cycle, over the same store and the one
    // implementation — so a number the CLI prints can never disagree with the one the phone got.
    const history = readFleetHistory(
      store,
      accounts.map((a) => ({ accountId: a.id, ...resolvedWeight(a) })),
      nowMs,
    );
    return {
      accounts,
      activeId,
      usageFor: (accountId) => byId.get(accountId),
      predictedResetFor: (accountId) => history.predictedResetByAccount.get(accountId),
      burnUnitsPerDay: history.burnUnitsPerDay,
    };
  } finally {
    store.close();
  }
}

/** `{ weight }` when the account's plan tier resolves, `{}` when it does not — the same
 *  present-or-absent contract `timelineInputFromWire` relies on to tell a real 1x Pro account
 *  from one whose tier nothing could read. */
export function resolvedWeight(account: StoredAccount): { weight?: number } {
  const result = planWeight(account);
  return result.known ? { weight: result.weight } : {};
}
