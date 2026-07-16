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
    (v.toAccountId === null || typeof v.toAccountId === 'string')
  );
}

/** The subset of the audit log that actually changes which account is live: an `activated`
 *  event with a real target. (`quarantined`/`recovered`/`refresh_adopted` never flip the live
 *  account by themselves — `recovered` can report an already-settled state with no change.) */
interface ActivationEvent {
  ts: number;
  toAccountId: string;
}

function toActivationEvents(entries: AuditEntry[]): ActivationEvent[] {
  const events: ActivationEvent[] = [];
  for (const e of entries) {
    if (e.event === 'activated' && e.toAccountId !== null) {
      events.push({ ts: e.ts, toAccountId: e.toAccountId });
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
}

/** Turn the ts-sorted activation list into contiguous, non-overlapping intervals: each
 *  activation opens an interval that the NEXT activation closes. Because `activations` is
 *  sorted ascending, every `endedAtMs` is >= its `startedAtMs`, so intervals never overlap
 *  even if the raw audit log had an out-of-order (clock-skewed) timestamp. */
function deriveIntervals(activations: ActivationEvent[]): DerivedInterval[] {
  const intervals: DerivedInterval[] = [];
  for (let i = 0; i < activations.length; i++) {
    const activation = activations[i];
    if (!activation) continue;
    const next = activations[i + 1];
    intervals.push({
      accountId: activation.toAccountId,
      startedAtMs: activation.ts,
      endedAtMs: next ? next.ts : null,
    });
  }
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
      e.endedAtMs !== t.endedAtMs
    )
      return false;
  }
  return true;
}

export interface AttributionJournalOptions {
  store: Store;
  vaultDir: string;
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

  /** Which account was live at a given moment, or `null` if none was (before the first
   *  activation, or the log is empty). */
  accountActiveAt(tsMs: number): string | null {
    const interval = this.store.findActivationIntervalAt(tsMs);
    return interval?.accountId ?? null;
  }
}
