// Pure renderer for `cctl session status`.
//
// Reads nothing itself — the command action gathers the rows (from the daemon's display-only
// `sessions` mirror in daemon.db) plus an optional active-account header, and hands them here.
// Kept IO-free so the exact output is unit-tested, and plain-by-default (color only via an
// injected palette), matching render.ts's contract: pad on plain text, paint after.
//
// The header's DERIVATION lives here too (`weeklyResetHeader`), not in the command action: it
// is a pure snapshot->display decision, and keeping it beside the renderer is what lets a test
// hold this header and `cctl usage`'s line to the same input and prove they agree.

import type { AccountUsage } from '@claude-control/shared-protocol';
import {
  computeOutlook,
  humanizeDaysUntil,
  timelineInputFromWire,
} from '@claude-control/usage-advisor';
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

/** Optional header context shown above the table: which account is live and how much of its
 *  weekly budget is left in time. */
export interface SessionStatusHeader {
  activeLabel?: string;
  /** Milliseconds until the active account's weekly reset, when known. Passed as a duration
   *  rather than a formatted string so this renderer stays the single place that decides how a
   *  countdown reads, and as a duration rather than a timestamp so it stays clock-free. */
  weeklyResetInMs?: number;
  /** True when that countdown is derived from stored history rather than reported by the
   *  endpoint. Carried separately from the duration because the runway is equally real either
   *  way — what changes is whether the header may present it as an observation. */
  weeklyResetPredicted?: boolean;
}

/**
 * Derive the header's weekly countdown from one account's latest usage snapshot.
 *
 * Takes the history-derived `predictedResetAt` alongside the snapshot because the endpoint
 * STOPS publishing a weekly reset once that window closes — precisely when the prediction is
 * the only clock there is. Without it this header alone goes silent about a reset `cctl usage`
 * and the timeline are both still counting down to. The prediction rides its own flag rather
 * than being folded into the duration, so nothing downstream can pass it off as observed.
 *
 * Returns the fields to spread into a {@link SessionStatusHeader}: empty when there is no
 * snapshot or no weekly clock at all. `nowMs` is a parameter — the subtraction happens where a
 * real clock is in hand, and this module stays clock-free.
 */
export function weeklyResetHeader(
  usage: AccountUsage | undefined,
  predictedResetAt: number | undefined,
  nowMs: number,
): { weeklyResetInMs?: number; weeklyResetPredicted?: boolean } {
  if (!usage) return {};
  const outlook = computeOutlook(
    timelineInputFromWire([
      { ...usage, ...(predictedResetAt !== undefined ? { predictedResetAt } : {}) },
    ]),
    nowMs,
  );
  const budget = outlook.accounts[0]?.budget;
  if (!budget) return {};
  return {
    weeklyResetInMs: budget.weeklyResetAt - nowMs,
    weeklyResetPredicted: budget.resetPredicted,
  };
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

/** Render the active-account header line, or a gentle "no data yet" when nothing is known.
 *  A predicted countdown carries the same " (predicted)" mark `cctl usage` and the timeline
 *  print, so one surface can never read as an endpoint reading while another calls the same
 *  number a projection. */
function renderHeader(header: SessionStatusHeader | undefined, palette: Palette): string {
  if (!header || header.activeLabel === undefined) {
    return palette.dim('Active account: (none - start the daemon: cctl daemon run)');
  }
  const mark = header.weeklyResetPredicted === true ? ' (predicted)' : '';
  const budget =
    header.weeklyResetInMs !== undefined
      ? `  ·  ${humanizeDaysUntil(header.weeklyResetInMs)} left${mark}`
      : '';
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
