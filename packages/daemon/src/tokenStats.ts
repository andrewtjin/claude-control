// Pure aggregation of transcript turns into the `stats.snapshot` payload.
//
// The reader (transcriptTokens.ts) does the IO; this file does the arithmetic, so every rule that
// decides what a number MEANS — which account a turn belongs to, what happens to a turn that
// belongs to none, which day it lands on — is unit-testable without touching a disk.
//
// It emits the wire payload directly rather than an intermediate daemon-local shape, following
// `toUsageSnapshotPayload`: one shape means the CLI renderer and the Discord embed can never
// disagree about what they are showing, and there is no conversion layer to keep honest.

import type {
  TokenBucketRow,
  TokenStatsCoverage,
  TokenStatsSnapshot,
  TokenTotals,
} from '@claude-control/shared-protocol';
import type { TranscriptScan, TranscriptTurn } from './transcriptTokens.js';

/** The slice of an activation interval attribution needs. `ActivationIntervalRow` (store.ts)
 *  satisfies it structurally, so callers pass `store.listActivationIntervals()` unchanged while
 *  tests build two-field literals. */
export interface ActivationWindow {
  accountId: string;
  startedAtMs: number;
  /** `null` while the interval is still open — it then covers every timestamp from its start on. */
  endedAtMs: number | null;
}

export interface AggregateTokenStatsOptions {
  scan: TranscriptScan;
  /** Activation intervals in ANY order; sorted here so callers cannot break attribution by
   *  handing over an unsorted set. */
  intervals: readonly ActivationWindow[];
  windowStartMs: number;
  windowEndMs: number;
  /** accountId -> registry label. An id with no entry renders as the raw id rather than being
   *  hidden: an account removed from the registry still spent real tokens. */
  labelById: ReadonlyMap<string, string>;
}

/** The label for turns no account can be claimed for. A visible bucket, never a silent drop —
 *  see the wire type's note. */
export const UNATTRIBUTED_LABEL = 'unattributed';

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, turns: 0 };
}

function addTurn(totals: TokenTotals, turn: TranscriptTurn): void {
  totals.input += turn.inputTokens;
  totals.output += turn.outputTokens;
  totals.cacheCreation += turn.cacheCreationTokens;
  totals.cacheRead += turn.cacheReadTokens;
  totals.turns += 1;
}

/** Every token kind summed — the single number the by-* tables sort on and the CLI prints last. */
export function totalTokens(totals: TokenTotals): number {
  return totals.input + totals.output + totals.cacheCreation + totals.cacheRead;
}

/**
 * Which account was live at `tsMs`, or `null` if none was.
 *
 * Binary search over the start-ascending intervals rather than a `Store` query per turn: a week's
 * scan produces tens of thousands of turns, and one sqlite round trip each would dominate the
 * whole command. Semantics match `Store.findActivationIntervalAt` exactly — the newest interval
 * that started at or before `tsMs`, and only if it has not already closed by then.
 */
function accountAt(sorted: readonly ActivationWindow[], tsMs: number): string | null {
  let lo = 0;
  let hi = sorted.length - 1;
  let candidate: ActivationWindow | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = sorted[mid];
    if (interval === undefined) break;
    if (interval.startedAtMs <= tsMs) {
      candidate = interval;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (candidate === undefined) return null;
  if (candidate.endedAtMs !== null && candidate.endedAtMs <= tsMs) return null;
  return candidate.accountId;
}

/** `YYYY-MM-DD` in the machine's LOCAL time. Deliberately local, not UTC: the operator asking
 *  "what did I burn yesterday" means their own yesterday, and a UTC day boundary would split an
 *  evening's work across two rows for most of the world. Built by hand rather than through
 *  `toLocaleDateString` so the format is fixed and sortable in every locale. */
export function localDayKey(tsMs: number): string {
  const date = new Date(tsMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** Bucket rows sorted biggest-first — the order every "where did it go?" reading wants. */
function bucketRowsByTotal(totals: Map<string, TokenTotals>): TokenBucketRow[] {
  return [...totals.entries()]
    .map(([label, t]) => ({ label, totals: t }))
    .sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals));
}

/** Aggregate one scan into the wire payload. Pure: same inputs, same output, no clock read. */
export function aggregateTokenStats(options: AggregateTokenStatsOptions): TokenStatsSnapshot {
  const sorted = [...options.intervals].sort((a, b) => a.startedAtMs - b.startedAtMs);

  const overall = emptyTotals();
  // `null` keys the unattributed bucket. A Map (not two variables) so it sorts alongside the
  // real accounts and can never be forgotten by a later edit to the rendering order.
  const byAccount = new Map<string | null, TokenTotals>();
  const byModel = new Map<string, TokenTotals>();
  const byDay = new Map<string, TokenTotals>();

  for (const turn of options.scan.turns) {
    addTurn(overall, turn);
    const accountId = accountAt(sorted, turn.tsMs);
    addTurn(getOrCreate(byAccount, accountId), turn);
    addTurn(getOrCreate(byModel, turn.model), turn);
    addTurn(getOrCreate(byDay, localDayKey(turn.tsMs)), turn);
  }

  const coverage: TokenStatsCoverage = {
    filesScanned: options.scan.filesScanned,
    filesSkippedByMtime: options.scan.filesSkippedByMtime,
    filesUnreadable: options.scan.filesUnreadable,
    dirsUnreadable: options.scan.dirsUnreadable,
    malformedLines: options.scan.malformedLines,
    duplicateTurns: options.scan.duplicateTurns,
  };

  return {
    windowStartMs: options.windowStartMs,
    windowEndMs: options.windowEndMs,
    overall,
    byAccount: [...byAccount.entries()]
      .map(([accountId, totals]) => ({
        accountId,
        label:
          accountId === null ? UNATTRIBUTED_LABEL : (options.labelById.get(accountId) ?? accountId),
        totals,
      }))
      // Biggest first, unattributed included: if most of the spend cannot be attributed, that
      // belongs at the TOP of the table, not politely at the bottom.
      .sort((a, b) => totalTokens(b.totals) - totalTokens(a.totals)),
    byModel: bucketRowsByTotal(byModel),
    // Chronological, not by size — a day table is read as a trend.
    byDay: [...byDay.entries()]
      .map(([label, totals]) => ({ label, totals }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    coverage,
  };
}

function getOrCreate<K>(map: Map<K, TokenTotals>, key: K): TokenTotals {
  let totals = map.get(key);
  if (totals === undefined) {
    totals = emptyTotals();
    map.set(key, totals);
  }
  return totals;
}
