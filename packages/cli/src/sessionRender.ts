// Pure renderer for `cctl session status`.
//
// Reads nothing itself — the command action gathers the rows (from the daemon's display-only
// `sessions` mirror in daemon.db) plus an optional active-account header, and hands them here.
// Kept IO-free so the exact output is unit-tested, and plain-by-default (color only via an
// injected palette), matching render.ts's contract: pad on plain text, paint after.

import { PLAIN_PALETTE, type Palette } from './ansi.js';

/** One row of the session table. `watch` is `undefined` for kinds with no streaming concept
 *  (managed/observed) and a boolean for interactive sessions. `accountLabel` is the resolved
 *  label (falling back to the raw id) so the table shows human names, not uuids. */
export interface SessionStatusRow {
  id: string;
  kind: string;
  state: string;
  label?: string;
  watch?: boolean;
  accountLabel?: string;
}

/** Optional header context shown above the table: which account is live and its 5h budget. */
export interface SessionStatusHeader {
  activeLabel?: string;
  /** Whole 5h session windows left before the active account's weekly reset, when known. */
  fullWindowsLeft?: number;
}

/** Short display id for a session that has no label — the first 8 chars, enough to disambiguate
 *  by eye without printing a full uuid. */
function shortId(id: string): string {
  return id.length <= 8 ? id : id.slice(0, 8);
}

function watchCell(watch: boolean | undefined): string {
  if (watch === undefined) return '-';
  return watch ? 'on' : 'off';
}

/** Render the active-account header line, or a gentle "no data yet" when nothing is known. */
function renderHeader(header: SessionStatusHeader | undefined, palette: Palette): string {
  if (!header || header.activeLabel === undefined) {
    return palette.dim('Active account: (none - start the daemon: cctl daemon run)');
  }
  const budget =
    header.fullWindowsLeft !== undefined ? `  ·  ${header.fullWindowsLeft}x5h left` : '';
  return `Active account: ${palette.bold(header.activeLabel)}${palette.dim(budget)}`;
}

/**
 * Render the session status view: an active-account header, then a table of tracked sessions
 * (interactive ones the user registered + managed ones spawned from the phone). Empty state is a
 * helpful nudge, never a bare blank.
 */
export function renderSessionStatus(
  rows: SessionStatusRow[],
  header?: SessionStatusHeader,
  palette: Palette = PLAIN_PALETTE,
): string {
  const headerLine = renderHeader(header, palette);
  if (rows.length === 0) {
    return (
      `${headerLine}\n\n` +
      'No sessions tracked yet. Inside a Claude Code session, run /cctl:register ' +
      '(or `cctl session register --session <id>`).'
    );
  }

  const table = rows.map((r) => ({
    session: r.label ?? shortId(r.id),
    kind: r.kind,
    state: r.state,
    watch: watchCell(r.watch),
    account: r.accountLabel ?? '-',
  }));

  const headers = {
    session: 'SESSION',
    kind: 'KIND',
    state: 'STATE',
    watch: 'WATCH',
    account: 'ACCOUNT',
  };
  const widths = {
    session: colWidth(table, headers, 'session'),
    kind: colWidth(table, headers, 'kind'),
    state: colWidth(table, headers, 'state'),
    watch: colWidth(table, headers, 'watch'),
    account: colWidth(table, headers, 'account'),
  };

  // Pad first, paint after — ANSI codes are zero-width, so alignment survives styling.
  const cells = (r: typeof headers): string[] => [
    r.session.padEnd(widths.session),
    r.kind.padEnd(widths.kind),
    r.state.padEnd(widths.state),
    r.watch.padEnd(widths.watch),
    r.account.padEnd(widths.account),
  ];
  const rowLine = (r: (typeof table)[number]): string => {
    const [session, kind, state, watch, account] = cells(r);
    return [
      palette.bold(session ?? ''),
      palette.dim(kind ?? ''),
      state ?? '',
      watch ?? '',
      account ?? '',
    ].join('  ');
  };

  return [headerLine, '', palette.dim(cells(headers).join('  ')), ...table.map(rowLine)].join('\n');
}

/** Width of a column = the longest of its header and any cell. */
function colWidth<K extends string>(
  rows: Record<K, string>[],
  headers: Record<K, string>,
  key: K,
): number {
  return Math.max(headers[key].length, ...rows.map((r) => r[key].length));
}
