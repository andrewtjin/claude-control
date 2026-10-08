// Turns the switch engine's append-only switch-audit.jsonl into queryable activation
// intervals: "account X was live from T1 to T2". This is the daemon's only source of truth
// for "who was active when" — usage snapshots and session records get attributed against it.
//
// PURE parsing of the audit log's lines plus sqlite writes through `Store` — no network, no
// switch-engine calls. Reads the file fresh each time `sync()` runs rather than tailing it,
// which is simple and correct for the audit log's size (one line per switch, not per second).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditEntry } from '@claude-control/switch-engine';
import type { ActivationIntervalRow, Store } from './store.js';

/** Read and parse `switch-audit.jsonl`, tolerating a missing file (nothing switched yet)
 *  and skipping any line that isn't valid JSON (a torn write from a crash mid-append) rather
 *  than failing the whole read over one bad line. */
async function readAuditLog(vaultDir: string): Promise<AuditEntry[]> {
  const path = join(vaultDir, 'switch-audit.jsonl');
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }

  const entries: AuditEntry[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue; // torn/partial line — skip rather than abort the whole sync
    }
    if (isAuditEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

function isAuditEntry(value: unknown): value is AuditEntry {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.ts === 'number' &&
    typeof v.event === 'string' &&
    (v.fromAccountId === null || typeof v.fromAccountId === 'string') &&
    (v.toAccountId === null || typeof v.toAccountId === 'string') &&
    (v.origin === undefined || typeof v.origin === 'string') &&
    (v.slot === undefined || typeof v.slot === 'string')
  );
}

/** The slot an activation names, defaulting to the global slot for a pre-slot audit line. */
const GLOBAL_SLOT = 'global';

/** The subset of the audit log that actually changes which account is live: an `activated`
 *  event with a real target. (`quarantined`/`recovered`/`refresh_adopted` never flip the live
 *  account by themselves — `recovered` can report an already-settled state with no change.) */
interface ActivationEvent {
  ts: number;
  toAccountId: string;
  /** `null` for an entry written before the audit trail carried `origin` — see
   *  `ActivationIntervalRow.origin` (store.ts) for why that stays null rather than a guess. */
  origin: string | null;
  /** The slot this activation was for; a pre-slot audit line is the global slot. */
  slot: string;
}

function toActivationEvents(entries: AuditEntry[]): ActivationEvent[] {
  const events: ActivationEvent[] = [];
  for (const e of entries) {
    if (e.event === 'activated' && e.toAccountId !== null) {
      events.push({
        ts: e.ts,
        toAccountId: e.toAccountId,
        origin: e.origin ?? null,
        slot: e.slot ?? GLOBAL_SLOT,
      });
    }
  }
  // Oldest-first — the order intervals must be derived in.
  return events.sort((a, b) => a.ts - b.ts);
}

/** One derived activation interval (no store id yet): account X was live from `startedAtMs`
 *  until the next activation's timestamp, or open-ended (`null`) if it is the latest. */
interface DerivedInterval {
  accountId: string;
  startedAtMs: number;
  endedAtMs: number | null;
  origin: string | null;
  slot: string;
}

/**
 * Turn the ts-sorted activation list into contiguous, non-overlapping intervals — PER SLOT. Each
 * slot has its own live account at any instant (the global slot and each group slot switch
 * independently), so an activation closes only the previous activation OF THE SAME SLOT: a group
 * hop must not truncate the global account's interval, and vice versa. Within a slot, because the
 * activations are ts-sorted, every `endedAtMs` is >= its `startedAtMs`, so intervals never overlap
 * even if the raw audit log had an out-of-order (clock-skewed) timestamp. The combined result is
 * sorted by (startedAtMs, slot, accountId) so it compares positionally against the store's ordering.
 */
function deriveIntervals(activations: ActivationEvent[]): DerivedInterval[] {
  // Group the ts-sorted activations by slot, preserving order within each slot.
  const bySlot = new Map<string, ActivationEvent[]>();
  for (const activation of activations) {
    let list = bySlot.get(activation.slot);
    if (list === undefined) {
      list = [];
      bySlot.set(activation.slot, list);
    }
    list.push(activation);
  }
  const intervals: DerivedInterval[] = [];
  for (const [slot, slotActivations] of bySlot) {
    for (let i = 0; i < slotActivations.length; i++) {
      const activation = slotActivations[i];
      if (!activation) continue;
      const next = slotActivations[i + 1];
      intervals.push({
        accountId: activation.toAccountId,
        startedAtMs: activation.ts,
        endedAtMs: next ? next.ts : null,
        origin: activation.origin,
        slot,
      });
    }
  }
  intervals.sort(
    (a, b) =>
      a.startedAtMs - b.startedAtMs ||
      a.slot.localeCompare(b.slot) ||
      a.accountId.localeCompare(b.accountId),
  );
  return intervals;
}

/** Whether the currently-stored intervals already equal the freshly-derived ones, so a
 *  re-sync can skip rewriting the table (and churning row ids) when nothing changed. Both
 *  lists are start-ascending, so a positional compare is sufficient. */
function intervalsEqual(existing: ActivationIntervalRow[], target: DerivedInterval[]): boolean {
  if (existing.length !== target.length) return false;
  for (let i = 0; i < existing.length; i++) {
    const e = existing[i];
    const t = target[i];
    if (!e || !t) return false;
    if (
      e.accountId !== t.accountId ||
      e.startedAtMs !== t.startedAtMs ||
      e.endedAtMs !== t.endedAtMs ||
      e.origin !== t.origin ||
      // A legacy row's NULL slot reads as the global slot, matching the target derived for it.
      (e.slot ?? GLOBAL_SLOT) !== t.slot
    )
      return false;
  }
  return true;
}

export interface AttributionJournalOptions {
  store: Store;
  vaultDir: string;
}

/** Whether an audit entry moved the live account to another account: every activation, and the
 *  two crash-recovery outcomes that finish or undo a torn switch ("rolled forward", "rolled
 *  back"). A recovery that only cleared a record, or found nothing to restore, moved nothing. */
function movedLiveAccount(e: AuditEntry): e is AuditEntry & { toAccountId: string } {
  if (e.toAccountId === null) return false;
  if (e.event === 'activated') return true;
  return (
    e.event === 'recovered' &&
    (e.detail === 'rolled forward' || e.detail === 'rolled back') &&
    e.toAccountId !== e.fromAccountId
  );
}

/** One switch of the live account, as the audit log recorded it. */
export interface SwitchStep {
  at: number;
  fromAccountId: string | null;
  toAccountId: string;
  /** Who made it: auto-switch, a CLI or phone switch, or crash recovery. Absent on entries
   *  written before the audit log carried it. */
  origin?: string;
  /** Why, when the caller said (auto-switch always does: which limit fired). */
  reason?: string;
}

/**
 * Rebuilds `activation_intervals` from the switch-audit log. `sync()` is safe to call
 * repeatedly (e.g. once per poll cycle): it re-derives EVERY interval from the whole,
 * freshly-read audit log each time, then replaces the stored set only when it actually
 * changed. This is deliberately NOT an append-from-a-tail-cursor: an out-of-order audit
 * timestamp (clock skew / NTP step-back) sorts into the middle of the activation list, so a
 * `existing.length`-as-cursor scheme would open the wrong interval and corrupt history. A
 * full re-derive is cheap for the audit log's size (one line per switch, not per second).
 */
export class AttributionJournal {
  private readonly store: Store;
  private readonly vaultDir: string;

  constructor(options: AttributionJournalOptions) {
    this.store = options.store;
    this.vaultDir = options.vaultDir;
  }

  async sync(): Promise<void> {
    const entries = await readAuditLog(this.vaultDir);
    this.rebuild(toActivationEvents(entries));
  }

  private rebuild(activations: ActivationEvent[]): void {
    // Re-derive the complete interval set from the full (ts-sorted) activation list rather
    // than assuming new events append to the tail — the only scheme that stays correct when a
    // clock-skewed timestamp sorts into the middle.
    const target = deriveIntervals(activations);
    const existing = this.store.listActivationIntervals();
    if (intervalsEqual(existing, target)) return; // nothing changed — don't rewrite/churn rows
    this.store.replaceActivationIntervals(target);
  }

  /** The switches that changed the live account between two moments (inclusive), oldest first,
   *  with who made each and why — the walk the exhaustion log shows leading up to the moment no
   *  account was left. Read fresh from the audit log, like {@link sync}: it runs once per
   *  exhaustion episode, never per cycle. */
  async switchesBetween(fromMs: number, toMs: number): Promise<SwitchStep[]> {
    const entries = await readAuditLog(this.vaultDir);
    return entries
      .filter(movedLiveAccount)
      .filter((e) => e.ts >= fromMs && e.ts <= toMs)
      .sort((a, b) => a.ts - b.ts)
      .map((e) => ({
        at: e.ts,
        fromAccountId: e.fromAccountId,
        toAccountId: e.toAccountId,
        ...(e.origin !== undefined ? { origin: e.origin } : {}),
        ...(e.detail !== undefined ? { reason: e.detail } : {}),
      }));
  }

  /** Which account was live at a given moment, or `null` if none was (before the first
   *  activation, or the log is empty). */
  accountActiveAt(tsMs: number): string | null {
    const interval = this.store.findActivationIntervalAt(tsMs);
    return interval?.accountId ?? null;
  }
}
