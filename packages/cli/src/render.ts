// Pure rendering helpers for the CLI.
//
// Kept free of IO so the exact output is unit-tested. Output is plain text by DEFAULT —
// color comes only from an injected palette (identity unless the program edge detected a
// TTY; see ansi.ts), and layout is always computed on plain text before painting, so
// styled and plain output align identically.

import type { StoredAccount } from '@claude-control/switch-engine';
import type { AccountUsage } from '@claude-control/shared-protocol';
import {
  computeOutlook,
  computePacing,
  timelineInputFromWire,
  type AccountUsageInput,
} from '@claude-control/usage-advisor';
import { PLAIN_PALETTE, severityPaint, type Palette } from './ansi.js';

/** Render the accounts registry as an aligned table. `activeId` is marked with `*`. */
export function renderAccountsTable(
  accounts: StoredAccount[],
  activeId: string | null,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (accounts.length === 0) return 'No accounts yet. Add one with: cctl accounts add <label>';

  const rows = accounts.map((a) => ({
    active: a.id === activeId ? '*' : ' ',
    label: a.label,
    email: a.emailAddress ?? '-',
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

  // Pad first, paint after — ANSI codes are zero-width, so alignment survives.
  const cells = (r: typeof headers) => [
    r.active.padEnd(widths.active),
    r.label.padEnd(widths.label),
    r.email.padEnd(widths.email),
    r.status.padEnd(widths.status),
    r.id.padEnd(widths.id),
  ];
  const rowLine = (r: (typeof rows)[number]) => {
    const [active, label, email, status, id] = cells(r);
    const paintStatus = r.status === 'quarantined' ? palette.red : (t: string) => t;
    return [
      palette.green(active ?? ''),
      palette.bold(label ?? ''),
      email ?? '',
      paintStatus(status ?? ''),
      palette.dim(id ?? ''),
    ].join('  ');
  };

  return [palette.dim(cells(headers).join('  ')), ...rows.map(rowLine)].join('\n');
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
export function renderUsage(
  rows: UsageRow[],
  nowMs: number,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (rows.length === 0) return 'No accounts yet. Add one with: cctl accounts add <label>';
  return rows
    .map((r) => {
      const marker = r.active ? palette.green('*') : ' ';
      const label = palette.bold(r.label);
      if (!r.usage) {
        return `${marker} ${label} - no usage data yet (start the daemon: cctl daemon start)`;
      }
      const age = ageLabel(nowMs - r.usage.fetchedAtMs);
      const limits = r.usage.limits.length
        ? r.usage.limits
            .map((l) => {
              const pct = Math.round(l.percent);
              return `${limitShort(l.kind)} ${severityPaint(palette, pct)(`${pct}%`)}`;
            })
            .join(' · ')
        : 'no limits reported';
      const err = r.usage.error ? `  ${palette.red(`[${r.usage.error}]`)}` : '';
      const source = palette.dim(`(${r.usage.source}, ${age})`);
      return `${marker} ${label}  ${source}  ${limits}${windowsLeft(r.usage, nowMs)}${err}`;
    })
    .join('\n');
}

/** "Pacing: 38% of the combined week elapsed, ..." — the one-line cross-account pacing
 *  verdict appended after `cctl usage` and `cctl timeline`'s own output. Shares the same
 *  AccountUsageInput view the burn plan is computed from, so the two never disagree on what
 *  counts as "an account". */
export function renderPacingLine(inputs: AccountUsageInput[], nowMs: number): string {
  return `Pacing: ${computePacing(inputs, nowMs).headline}`;
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
