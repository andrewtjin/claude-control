// The usage picture every usage-reading view starts from: the registry, the daemon's latest
// persisted snapshot per account, and the history-derived measurements the pure advisor cannot
// make for itself.
//
// Read locally (the vault and daemon.db), never from Anthropic: it works whether or not the daemon
// is running, showing its last poll. Shared by the one-shot commands (`usage`, `timeline`,
// `session status`, the outage judgement) and the full-screen view, so the numbers on every
// surface come from one reader. A one-shot command reads once; the view keeps one reader open for
// as long as it runs (see {@link UsageReader}).

import type { AccountView, StoredAccount } from '@claude-control/switch-engine';
import { Store, readFleetHistory, readFleetResets, type SessionRow } from '@claude-control/daemon';
import { AccountUsage } from '@claude-control/shared-protocol';
import { planWeight } from '@claude-control/usage-advisor';
import { buildEngine, daemonDbPath } from './context.js';

type Engine = ReturnType<typeof buildEngine>;

/** What `usage` and `timeline` read before rendering: the registry, the daemon's latest
 *  persisted snapshot per account, and the two history-derived measurements the pure advisor
 *  cannot make for itself (each account's predicted weekly reset and the fleet's burn rate).
 *  Works whether or not the daemon is currently running (it shows the last poll), and opening
 *  a not-yet-created db just yields an empty one. A corrupt snapshot row (one that does not parse,
 *  or parses to something other than a usage reading) is skipped, never fatal. */
export interface UsageState {
  accounts: AccountView[];
  activeId: string | null;
  usageFor: (accountId: string) => AccountUsage | undefined;
  /** Next weekly reset predicted from stored history, for accounts the endpoint has stopped
   *  publishing one for. Absent when the account has no observed reset in history at all. */
  predictedResetFor: (accountId: string) => number | undefined;
  /** The shared accounts' burn in Pro-equivalent units/day, or undefined when history cannot
   *  measure one (or the reader was built not to measure it). Accounts reserved to rules are left
   *  out: no global session can spend what they hold. */
  burnUnitsPerDay: number | undefined;
}

/** How a {@link UsageReader} is set up; every field has a production default. */
export interface UsageReaderOptions {
  /** The daemon's database. */
  dbPath?: string;
  /** The history measurement (injectable so a test can count it). */
  readHistory?: typeof readFleetHistory;
  /** Whether to measure the fleet's burn rate (default true). Measuring it reads every reading of
   *  the last days; without it a reset prediction reads one row per account. */
  burn?: boolean;
}

/**
 * Reads the usage picture, keeping the daemon's database open between reads. Opening the store
 * runs its migration (a scan of the snapshot table), so a caller that reads every couple of
 * seconds (the full-screen view) opens it once, not on every read. Such a caller also builds it
 * without the burn rate (see {@link UsageReaderOptions.burn}), which it never shows and which is
 * the one costly part of a read. A read that fails drops the connection, so the next one starts
 * fresh (a database replaced or repaired meanwhile is picked up). All of it is synchronous SQLite
 * on the caller's thread.
 */
export class UsageReader {
  private store: Store | undefined;
  private closed = false;
  private readonly dbPath: string;
  private readonly readHistory: typeof readFleetHistory;
  private readonly burn: boolean;

  constructor(
    private readonly engine: Pick<Engine, 'listAllAccounts' | 'getActiveId'>,
    options: UsageReaderOptions = {},
  ) {
    this.dbPath = options.dbPath ?? daemonDbPath();
    this.readHistory = options.readHistory ?? readFleetHistory;
    this.burn = options.burn ?? true;
  }

  /** The usage picture now: of the whole fleet (shared accounts and those reserved to rules, the
   *  set the daemon polls, so each account's numbers match the phone's), or of `only` when the
   *  caller has already read the accounts. `activeId` is the live account when the caller already
   *  knows it (asking the engine again costs another read of the live login). */
  async read(nowMs: number, only?: AccountView[], activeId?: string | null): Promise<UsageState> {
    const [accounts, active] = await Promise.all([
      only !== undefined ? Promise.resolve(only) : this.engine.listAllAccounts(),
      activeId !== undefined ? Promise.resolve(activeId) : this.engine.getActiveId(),
    ]);
    return this.withStore((store) => {
      const byId = new Map<string, AccountUsage>();
      for (const a of accounts) {
        const row = store.latestUsageSnapshot(a.id);
        if (!row) continue;
        const usage = parseUsage(row.json);
        if (usage !== undefined) byId.set(a.id, usage);
      }
      const history = this.historyFor(store, accounts, nowMs);
      return {
        accounts,
        activeId: active,
        usageFor: (accountId) => byId.get(accountId),
        predictedResetFor: (accountId) => history.predictedResetByAccount.get(accountId),
        burnUnitsPerDay: history.burnUnitsPerDay,
      };
    });
  }

  /** The history-derived measurements: both, through the same measurement the daemon makes each
   *  poll cycle (so each account's predicted reset matches the phone's), or only the reset
   *  predictions, from the newest reported reset per account. The burn is the shared accounts'
   *  alone, the pool whose runway pacing judges; the reserved ones are read apart only for their
   *  resets. */
  private historyFor(
    store: Store,
    accounts: AccountView[],
    nowMs: number,
  ): { predictedResetByAccount: Map<string, number>; burnUnitsPerDay: number | undefined } {
    if (!this.burn) {
      return {
        predictedResetByAccount: readFleetResets(
          store,
          accounts.map((a) => a.id),
          nowMs,
        ),
        burnUnitsPerDay: undefined,
      };
    }
    const historyOf = (subset: AccountView[]) =>
      this.readHistory(
        store,
        subset.map((a) => ({ accountId: a.id, ...resolvedWeight(a) })),
        nowMs,
      );
    const pool = historyOf(accounts.filter((a) => !isReserved(a)));
    const reserved = historyOf(accounts.filter(isReserved));
    return {
      predictedResetByAccount: new Map([
        ...reserved.predictedResetByAccount,
        ...pool.predictedResetByAccount,
      ]),
      burnUnitsPerDay: pool.burnUnitsPerDay,
    };
  }

  /** The sessions the daemon tracks, through the same open database. */
  listSessions(): SessionRow[] {
    return this.withStore((store) => store.listSessions());
  }

  /** Close the database for good. A read still in flight when this is called (one awaiting the
   *  vault) fails rather than reopen a file its owner has let go of. */
  close(): void {
    this.closed = true;
    this.drop();
  }

  private drop(): void {
    this.store?.close();
    this.store = undefined;
  }

  private withStore<T>(body: (store: Store) => T): T {
    if (this.closed) throw new Error('the usage reader is closed');
    this.store ??= new Store(this.dbPath);
    try {
      return body(this.store);
    } catch (err) {
      this.drop();
      throw err;
    }
  }
}

/** A snapshot row's reading, or undefined for one that does not parse or is not a usage reading
 *  (a row from another build, a hand edit): one bad row must not take down every view of it. */
function parseUsage(json: string): AccountUsage | undefined {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }
  const parsed = AccountUsage.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** The usage view's state: the whole fleet (see {@link UsageReader.read}), the global live account
 *  and each account's latest snapshot. `only` is the registry's accounts when the caller has
 *  already read them. `engine` is the one to read through; a caller drawing its own screen passes
 *  one whose diagnostics land somewhere other than stderr. */
export async function readUsageState(
  nowMs: number,
  only?: AccountView[],
  engine: Engine = buildEngine(),
): Promise<UsageState> {
  const reader = new UsageReader(engine);
  try {
    return await reader.read(nowMs, only);
  } finally {
    reader.close();
  }
}

/** True for an account reserved to rules (a folder or alias rule, or a parallel session): only
 *  the sessions those rules run can use it. */
export function isReserved(account: AccountView): boolean {
  return (account.ruleIds ?? []).length > 0;
}

/** `{ weight }` when the account's plan tier resolves, `{}` when it does not — the same
 *  present-or-absent contract `timelineInputFromWire` relies on to tell a real 1x Pro account
 *  from one whose tier nothing could read. */
export function resolvedWeight(account: StoredAccount): { weight?: number } {
  const result = planWeight(account);
  return result.known ? { weight: result.weight } : {};
}
