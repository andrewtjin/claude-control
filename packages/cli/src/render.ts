// Pure rendering helpers for the CLI.
//
// Kept free of IO so the exact output is unit-tested. The CLI stays deliberately plain
// text — no colors or spinners — so it is readable in any terminal and easy to assert on.

import type { StoredAccount } from '@claude-control/switch-engine';

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

/** Width of a column = the longest of its header and any cell. */
function colWidth<K extends string>(
  rows: Record<K, string>[],
  headers: Record<K, string>,
  key: K,
): number {
  return Math.max(headers[key].length, ...rows.map((r) => r[key].length));
}
