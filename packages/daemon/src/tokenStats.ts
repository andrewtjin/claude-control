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
  /** The slot this interval belongs to — `'global'` or `'group:<id>'`. `null`/absent reads as the
   *  global slot (a legacy row, or a caller that predates slots). A turn is attributed against the
   *  intervals of ITS session's slot only, so a group hop never claims a global turn. */
  slot?: string | null;
}

/** The slot every turn/interval with no slot of its own belongs to. */
const GLOBAL_SLOT = 'global';

export interface AggregateTokenStatsOptions {
  scan: TranscriptScan;
  /** Activation intervals in ANY order; sorted (and grouped by slot) here so callers cannot break
   *  attribution by handing over an unsorted set. */
  intervals: readonly ActivationWindow[];
  windowStartMs: number;
  windowEndMs: number;
  /** accountId -> registry label. An id with no entry renders as the raw id rather than being
   *  hidden: an account removed from the registry still spent real tokens. */
  labelById: ReadonlyMap<string, string>;
  /** sessionId -> slot (`'global'` / `'group:<id>'`). A turn whose session is here is attributed
   *  against that slot's timeline; a turn with no session id, or a session absent from this map,
   *  falls to the global timeline. Optional and empty by default, so a caller that does not track
   *  slots gets exactly the pre-slot, global-only behavior. */
  slotBySession?: ReadonlyMap<string, string>;
  /** Recorded slot spans (store `session_slot_spans`), any order. A turn inside a span of its
   *  session is attributed against that span's slot; a turn before its session's first span (or of
   *  a session with none) falls back to {@link slotBySession}. See {@link buildSlotAt}. */
  slotSpans?: readonly SessionSlotSpan[];
}

/** One recorded span: from `startedAtMs` on, `sessionId` ran in `slot`. The store's
 *  `SessionSlotSpanRow` satisfies it structurally. */
export interface SessionSlotSpan {
  sessionId: string;
  slot: string;
  startedAtMs: number;
}

/** Which slot a session's turn at `tsMs` ran in. */
export type SlotAt = (sessionId: string | null | undefined, tsMs: number) => string;

/**
 * Build the turn -> slot resolver attribution uses, from the two records that know a session's
 * slot: the recorded spans (every hook-reporting session, precise in time) and the sessions mirror
 * (registered and daemon-spawned sessions, one slot each).
 *
 * The span in force at the turn's time wins. A turn BEFORE the session's first span keeps the
 * mirror's answer (else global) rather than borrowing the first span's slot: an old session
 * resumed under a group profile would otherwise bill its whole pre-binding history to the group,
 * and the earlier run's config dir is simply not known. Pure.
 */
export function buildSlotAt(
  spans: readonly SessionSlotSpan[],
  slotBySession: ReadonlyMap<string, string> = new Map(),
): SlotAt {
  const bySession = new Map<string, SessionSlotSpan[]>();
  for (const span of spans) {
    let list = bySession.get(span.sessionId);
    if (list === undefined) {
      list = [];
      bySession.set(span.sessionId, list);
    }
    list.push(span);
  }
  for (const list of bySession.values()) list.sort((a, b) => a.startedAtMs - b.startedAtMs);

  return (sessionId, tsMs) => {
    if (sessionId == null) return GLOBAL_SLOT;
    const list = bySession.get(sessionId);
    if (list !== undefined) {
      // Latest span that started at or before the turn (lists are short: one per slot change).
      for (let i = list.length - 1; i >= 0; i--) {
        const span = list[i];
        if (span !== undefined && span.startedAtMs <= tsMs) return span.slot;
      }
    }
    return slotBySession.get(sessionId) ?? GLOBAL_SLOT;
  };
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

/** The records that decide which account a turn is billed to. */
export interface TurnAttributionInputs {
  /** Activation intervals in ANY order; sorted and grouped by slot here. */
  intervals: readonly ActivationWindow[];
  slotBySession?: ReadonlyMap<string, string>;
  slotSpans?: readonly SessionSlotSpan[];
}

/**
 * Build the turn -> account function every per-account view shares (`cctl stats`, the phone's
 * stats card, `cctl session show`), so they can never disagree about who a turn belongs to.
 *
 * One start-ascending interval list PER slot: a turn is attributed only against the timeline of
 * its own slot (at the turn's time, see {@link buildSlotAt}), so a group hop never truncates or
 * claims the global account's spend (and vice versa). A legacy/absent interval slot reads as the
 * global slot. `null` = no account can be claimed for the turn. Pure.
 */
export function buildTurnAttributor(
  inputs: TurnAttributionInputs,
): (turn: Pick<TranscriptTurn, 'sessionId' | 'tsMs'>) => string | null {
  const intervalsBySlot = new Map<string, ActivationWindow[]>();
  for (const interval of inputs.intervals) {
    const slot = interval.slot ?? GLOBAL_SLOT;
    let list = intervalsBySlot.get(slot);
    if (list === undefined) {
      list = [];
      intervalsBySlot.set(slot, list);
    }
    list.push(interval);
  }
  for (const list of intervalsBySlot.values()) list.sort((a, b) => a.startedAtMs - b.startedAtMs);
  const noIntervals: ActivationWindow[] = [];
  const slotAt = buildSlotAt(inputs.slotSpans ?? [], inputs.slotBySession);
  return (turn) =>
    accountAt(intervalsBySlot.get(slotAt(turn.sessionId, turn.tsMs)) ?? noIntervals, turn.tsMs);
}

/** Aggregate one scan into the wire payload. Pure: same inputs, same output, no clock read. */
export function aggregateTokenStats(options: AggregateTokenStatsOptions): TokenStatsSnapshot {
  const accountFor = buildTurnAttributor(options);

  const overall = emptyTotals();
  // `null` keys the unattributed bucket. A Map (not two variables) so it sorts alongside the
  // real accounts and can never be forgotten by a later edit to the rendering order.
  const byAccount = new Map<string | null, TokenTotals>();
  const byModel = new Map<string, TokenTotals>();
  const byDay = new Map<string, TokenTotals>();

  for (const turn of options.scan.turns) {
    addTurn(overall, turn);
    const accountId = accountFor(turn);
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
