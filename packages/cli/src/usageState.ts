// The usage picture every usage-reading view starts from: the registry, the daemon's latest
// persisted snapshot per account, and the history-derived measurements the pure advisor cannot
// make for itself.
//
// Read locally (the vault and daemon.db), never from Anthropic: it works whether or not the daemon
// is running, showing its last poll. Shared by the one-shot commands (`usage`, `timeline`,
// `session status`, the outage judgement) and the full-screen view, so the numbers on every
// surface come from one reader. A one-shot command reads once; the view keeps one reader open for
// as long as it runs (see {@link UsageReader}).

import type { StoredAccount } from '@claude-control/switch-engine';
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
  accounts: StoredAccount[];
  activeId: string | null;
  usageFor: (accountId: string) => AccountUsage | undefined;
  /** Next weekly reset predicted from stored history, for accounts the endpoint has stopped
   *  publishing one for. Absent when the account has no observed reset in history at all. */
  predictedResetFor: (accountId: string) => number | undefined;
  /** Fleet burn in Pro-equivalent units/day, or undefined when history cannot measure one (or
   *  the reader was built not to measure it). */
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
    private readonly engine: Pick<Engine, 'listAccounts' | 'getActiveId'>,
    options: UsageReaderOptions = {},
  ) {
    this.dbPath = options.dbPath ?? daemonDbPath();
    this.readHistory = options.readHistory ?? readFleetHistory;
    this.burn = options.burn ?? true;
  }

  /** The usage picture now. `only` names the accounts to read instead of the shared pool;
   *  `activeId` is the live account when the caller already knows it (asking the engine again
   *  costs another read of the live login). */
  async read(nowMs: number, only?: StoredAccount[], activeId?: string | null): Promise<UsageState> {
    const [accounts, active] = await Promise.all([
      only !== undefined ? Promise.resolve(only) : this.engine.listAccounts(),
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
   *  poll cycle (so a number the CLI prints never disagrees with the one the phone got), or only
   *  the reset predictions, from the newest reported reset per account. */
  private historyFor(
    store: Store,
    accounts: StoredAccount[],
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
    const inputs = accounts.map((a) => ({ accountId: a.id, ...resolvedWeight(a) }));
    const history = this.readHistory(store, inputs, nowMs);
    return {
      predictedResetByAccount: history.predictedResetByAccount,
      burnUnitsPerDay: history.burnUnitsPerDay,
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

/** The usage view's state: the shared accounts, the global live account and each account's latest
 *  snapshot. `only` names the accounts to read instead (the outage judgement reads the whole fleet,
 *  reserved accounts included). `engine` is the one to read through; a caller drawing its own
 *  screen passes one whose diagnostics land somewhere other than stderr. */
export async function readUsageState(
  nowMs: number,
  only?: StoredAccount[],
  engine: Engine = buildEngine(),
): Promise<UsageState> {
  const reader = new UsageReader(engine);
  try {
    return await reader.read(nowMs, only);
  } finally {
    reader.close();
  }
}

/** `{ weight }` when the account's plan tier resolves, `{}` when it does not — the same
 *  present-or-absent contract `timelineInputFromWire` relies on to tell a real 1x Pro account
 *  from one whose tier nothing could read. */
export function resolvedWeight(account: StoredAccount): { weight?: number } {
  const result = planWeight(account);
  return result.known ? { weight: result.weight } : {};
}
