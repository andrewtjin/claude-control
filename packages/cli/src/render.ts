// Pure rendering helpers for the CLI.
//
// Kept free of IO so the exact output is unit-tested. The CLI stays deliberately plain
// text — no colors or spinners — so it is readable in any terminal and easy to assert on.

import type { StoredAccount } from '@claude-control/switch-engine';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { computeOutlook, timelineInputFromWire } from '@claude-control/usage-advisor';

/** Render the accounts registry as an aligned table. `activeId` is marked with `*`. */
export function renderAccountsTable(accounts: StoredAccount[], activeId: string | null): string {
  if (accounts.length === 0) return 'No accounts yet. Add one with: cctl accounts add <label>';

  const rows = accounts.map((a) => ({
    active: a.id === activeId ? '*' : ' ',
    label: a.label,
    email: a.emailAddress ?? '—',
    status: a.quarantined ? 'quarantined' : 'ok',
    id: a.id,
  }));

  const headers = { active: ' ', label: 'LABEL', email: 'EMAIL', status: 'STATUS', id: 'ID' };
  const widths = {
    active: 1,
    label: colWidth(rows, headers, 'label'),
    email: colWidth(rows, headers, 'email'),
    status: colWidth(rows, headers, 'status'),
    id: colWidth(rows, headers, 'id'),
  };

  const line = (r: typeof headers) =>
    [
      r.active.padEnd(widths.active),
      r.label.padEnd(widths.label),
      r.email.padEnd(widths.email),
      r.status.padEnd(widths.status),
      r.id.padEnd(widths.id),
    ].join('  ');

  return [line(headers), ...rows.map(line)].join('\n');
}

/** One account's row for the usage view. `usage` is absent until the daemon has polled it. */
export interface UsageRow {
  label: string;
  active: boolean;
  usage: AccountUsage | undefined;
}

/** Render cross-account usage from the daemon's latest persisted poll. Shows each account's
 *  source (live/cached), how stale the reading is, and the percent used per limit — so a
 *  cached (frozen) number is never mistaken for a fresh one. Pure. */
export function renderUsage(rows: UsageRow[], nowMs: number): string {
  if (rows.length === 0) return 'No accounts yet. Add one with: cctl accounts add <label>';
  return rows
    .map((r) => {
      const marker = r.active ? '*' : ' ';
      if (!r.usage) {
        return `${marker} ${r.label} — no usage data yet (start the daemon: cctl daemon start)`;
      }
      const age = ageLabel(nowMs - r.usage.fetchedAtMs);
      const limits = r.usage.limits.length
        ? r.usage.limits.map((l) => `${limitShort(l.kind)} ${Math.round(l.percent)}%`).join(' · ')
        : 'no limits reported';
      const err = r.usage.error ? `  [${r.usage.error}]` : '';
      return `${marker} ${r.label}  (${r.usage.source}, ${age})  ${limits}${windowsLeft(r.usage, nowMs)}${err}`;
    })
    .join('\n');
}

/** "· 15x5h left" — how many 5h session windows still fit before this account's weekly
 *  reset. Empty when no weekly reset time is known (full detail lives in `cctl timeline`). */
function windowsLeft(usage: AccountUsage, nowMs: number): string {
  const outlook = computeOutlook(timelineInputFromWire([usage]), nowMs);
  const budget = outlook.accounts[0]?.budget;
  return budget ? ` · ${budget.fullWindows}x5h left` : '';
}

function limitShort(kind: AccountUsage['limits'][number]['kind']): string {
  switch (kind) {
    case 'session':
      return '5h';
    case 'weekly_all':
      return 'week';
    case 'weekly_scoped':
      return 'week*';
  }
}

/** "just now" / "3m ago" / "2h ago" — a coarse staleness label for a poll timestamp. */
function ageLabel(ms: number): string {
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Width of a column = the longest of its header and any cell. */
function colWidth<K extends string>(
  rows: Record<K, string>[],
  headers: Record<K, string>,
  key: K,
): number {
  return Math.max(headers[key].length, ...rows.map((r) => r[key].length));
}
