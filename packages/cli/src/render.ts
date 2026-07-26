// Pure rendering helpers for the CLI.
//
// Kept free of IO so the exact output is unit-tested. Output is plain text by DEFAULT —
// color comes only from an injected palette (identity unless the program edge detected a
// TTY; see ansi.ts), and layout is always computed on plain text before painting, so
// styled and plain output align identically.

import type { StoredAccount } from '@claude-control/switch-engine';
import type {
  AccountUsage,
  TokenBucketRow,
  TokenStatsSnapshot,
  TokenTotals,
} from '@claude-control/shared-protocol';
import type { HeartbeatReading } from '@claude-control/daemon';
import { localDayKey, totalTokens } from '@claude-control/daemon';
import {
  computeOutlook,
  computePacing,
  formatTokens,
  planWeight,
  renderPacingSummary,
  timelineInputFromWire,
  type AccountUsageInput,
  type PacingOptions,
} from '@claude-control/usage-advisor';
import { PLAIN_PALETTE, severityPaint, type Palette } from './ansi.js';

/** Short month names for date cells — spelled out manually rather than via `Intl` so the
 *  format is locale-independent and deterministic under test (matches `humanizeDuration`'s
 *  Intl-free precedent in usage-advisor). */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Longest a passthrough upstream string may be in a table cell, with an ellipsis marking the
 *  cut. Bounds a value we do not control so one long string can't dominate the table's width. */
const MAX_CELL_CHARS = 24;

function truncateCell(value: string): string {
  return value.length <= MAX_CELL_CHARS ? value : `${value.slice(0, MAX_CELL_CHARS - 3)}...`;
}

/** "Aug 15" from an epoch ms, in UTC (the source timestamps are all UTC ISO strings). */
function formatMonthDay(ms: number): string {
  const d = new Date(ms);
  return `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The compact plan-tier cell for `cctl accounts list`: the relative capacity weight from
 *  `planWeight()`, e.g. "20x", or "?" when no signal let us derive one — the account still
 *  gets weight 1 in any aggregate math, but the table must say so rather than implying we
 *  KNOW it's 1x (silent equal-weighting is exactly the bug `planWeight` exists to fix). */
function planCell(account: StoredAccount): string {
  // Conditionally spread rather than assigning each field directly: exactOptionalPropertyTypes
  // forbids passing an explicit `undefined` for an optional string field.
  const result = planWeight({
    ...(account.organizationRateLimitTier !== undefined
      ? { organizationRateLimitTier: account.organizationRateLimitTier }
      : {}),
    ...(account.rateLimitTier !== undefined ? { rateLimitTier: account.rateLimitTier } : {}),
    ...(account.subscriptionType !== undefined
      ? { subscriptionType: account.subscriptionType }
      : {}),
  });
  return result.known ? `${result.weight}x` : '?';
}

/** Days in a given UTC month. Day 0 of the NEXT month is the last day of this one. */
function daysInUtcMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

/**
 * Estimate the next monthly billing anniversary from `subscriptionCreatedAt`, rolled forward
 * to the first occurrence strictly after `nowMs`. This is a DERIVATION, not an authoritative
 * invoice date — no endpoint exposes one — so every caller must render it with an "est."/"~"
 * marker, never as a bare fact.
 *
 * Each candidate is built from the ORIGINAL date plus a month offset, never by mutating the
 * previous candidate. Cumulative `setUTCMonth` would let a short month permanently corrupt the
 * day: a Jan 31 subscription overflows to Mar 3 crossing February, and every later step then
 * rolls from the 3rd, so the estimate drifts weeks away from the true anniversary and never
 * recovers. The day is clamped to the target month's length instead (Jan 31 -> Feb 28), which
 * is also what a monthly subscription actually does.
 */
function estimateNextBillingMs(
  subscriptionCreatedAtIso: string,
  nowMs: number,
): number | undefined {
  const created = new Date(subscriptionCreatedAtIso);
  if (Number.isNaN(created.getTime())) return undefined;
  // The loop below terminates by walking candidates PAST `nowMs`; a non-finite one makes that
  // comparison unsatisfiable and would hang the CLI rather than fail. `nowMs` is a public
  // parameter of `renderAccountsTable`, so guard it here instead of trusting every caller.
  if (!Number.isFinite(nowMs)) return undefined;

  const year = created.getUTCFullYear();
  const month = created.getUTCMonth();
  const day = created.getUTCDate();

  // Bounded: each step advances one month from a fixed origin, so this terminates as soon as
  // the candidate passes `nowMs` regardless of how old the subscription is.
  for (let offset = 0; ; offset++) {
    const target = new Date(Date.UTC(year, month + offset, 1));
    const clampedDay = Math.min(day, daysInUtcMonth(target.getUTCFullYear(), target.getUTCMonth()));
    const candidate = Date.UTC(
      target.getUTCFullYear(),
      target.getUTCMonth(),
      clampedDay,
      created.getUTCHours(),
      created.getUTCMinutes(),
      created.getUTCSeconds(),
      created.getUTCMilliseconds(),
    );
    if (candidate > nowMs) return candidate;
  }
}

/** The compact billing cell for `cctl accounts list`: a live trial's end date takes priority
 *  (there's no subscription to bill yet), then a `stripe_subscription`-derived estimate, then
 *  an honest "unknown" for any other or absent `billingType` — never a fabricated date for a
 *  billing type we haven't seen. */
function billingCell(account: StoredAccount, nowMs: number): string {
  if (account.claudeCodeTrialEndsAt !== undefined) {
    const trialEndMs = Date.parse(account.claudeCodeTrialEndsAt);
    if (!Number.isNaN(trialEndMs) && trialEndMs > nowMs) {
      return `trial->${formatMonthDay(trialEndMs)}`;
    }
  }
  if (account.billingType === undefined) return 'unknown';
  // Anything other than the known recurring type is shown verbatim rather than guessed at,
  // since we don't know how (or whether) it recurs monthly — but it is upstream text of
  // unbounded length, so it is truncated to keep one odd value from stretching the column.
  if (account.billingType !== 'stripe_subscription') return truncateCell(account.billingType);
  if (account.subscriptionCreatedAt === undefined) return 'unknown';
  const nextMs = estimateNextBillingMs(account.subscriptionCreatedAt, nowMs);
  return nextMs === undefined ? 'unknown' : `~${formatMonthDay(nextMs)} (est.)`;
}

/** Render the accounts registry as an aligned table. `activeId` is marked with `*`. `nowMs`
 *  drives the PLAN/BILLING columns' estimates and defaults to the real clock; tests pin it. */
export function renderAccountsTable(
  accounts: StoredAccount[],
  activeId: string | null,
  palette: Palette = PLAIN_PALETTE,
  nowMs: number = Date.now(),
): string {
  if (accounts.length === 0) return 'No accounts yet. Add one with: cctl accounts add <label>';

  const rows = accounts.map((a) => ({
    active: a.id === activeId ? '*' : ' ',
    label: a.label,
    email: a.emailAddress ?? '-',
    plan: planCell(a),
    billing: billingCell(a, nowMs),
    status: a.quarantined ? 'quarantined' : 'ok',
    id: a.id,
  }));

  const headers = {
    active: ' ',
    label: 'LABEL',
    email: 'EMAIL',
    plan: 'PLAN',
    billing: 'BILLING',
    status: 'STATUS',
    id: 'ID',
  };
  const widths = {
    active: 1,
    label: colWidth(rows, headers, 'label'),
    email: colWidth(rows, headers, 'email'),
    plan: colWidth(rows, headers, 'plan'),
    billing: colWidth(rows, headers, 'billing'),
    status: colWidth(rows, headers, 'status'),
    id: colWidth(rows, headers, 'id'),
  };

  // Pad first, paint after — ANSI codes are zero-width, so alignment survives.
  const cells = (r: typeof headers) => [
    r.active.padEnd(widths.active),
    r.label.padEnd(widths.label),
    r.email.padEnd(widths.email),
    r.plan.padEnd(widths.plan),
    r.billing.padEnd(widths.billing),
    r.status.padEnd(widths.status),
    r.id.padEnd(widths.id),
  ];
  const rowLine = (r: (typeof rows)[number]) => {
    const [active, label, email, plan, billing, status, id] = cells(r);
    const paintStatus = r.status === 'quarantined' ? palette.red : (t: string) => t;
    return [
      palette.green(active ?? ''),
      palette.bold(label ?? ''),
      email ?? '',
      plan ?? '',
      palette.dim(billing ?? ''),
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

/** "Pacing: 67u of 80u available ..." — the cross-account pacing block appended after `cctl
 *  usage` and `cctl timeline`'s own output: the fleet verdict, then whatever the model had to
 *  assume. Shares the same AccountUsageInput view the burn plan is computed from, so the two
 *  never disagree on what counts as "an account", and the same renderer the Discord embed
 *  reads its headline and notes from. */
export function renderPacingLine(inputs: AccountUsageInput[], options: PacingOptions): string {
  return renderPacingSummary(computePacing(inputs, options));
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
      // The scoped weekly cap is the Fable-tier limit — name the model, not the wire kind.
      return 'fable';
  }
}

/** "just now" / "3m ago" / "2h ago" — a coarse staleness label for a poll timestamp. */
function ageLabel(ms: number): string {
  if (ms < 60_000) return 'just now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

// ---------------------------------------------------------------------------
// cctl stats — absolute token counts read from local Claude Code transcripts
// ---------------------------------------------------------------------------

/** The numeric columns every stats table shares, in print order. Declared once so the three
 *  tables (account / model / day) cannot drift apart in column set or order. */
const STATS_COLUMNS: { header: string; of: (t: TokenTotals) => number }[] = [
  { header: 'TURNS', of: (t) => t.turns },
  { header: 'INPUT', of: (t) => t.input },
  { header: 'OUTPUT', of: (t) => t.output },
  { header: 'CACHE W', of: (t) => t.cacheCreation },
  { header: 'CACHE R', of: (t) => t.cacheRead },
  { header: 'TOTAL', of: totalTokens },
];

/** One aligned table: a left-aligned label column plus the shared numeric columns, right-aligned.
 *  Every width is measured on PLAIN text and the padding applied before any paint, so a colored
 *  render lines up byte-identically with an uncolored one. */
function renderStatsTable(
  heading: string,
  labelHeader: string,
  rows: readonly TokenBucketRow[],
  palette: Palette,
  /** Row indexes whose label should read as a caveat rather than a peer (the unattributed
   *  bucket). By index, so this helper needs no knowledge of what makes a row exceptional. */
  isCaveat: (index: number) => boolean = () => false,
): string {
  const cells = rows.map((r) => [
    r.label,
    ...STATS_COLUMNS.map((c) => formatTokens(c.of(r.totals))),
  ]);
  const headers = [labelHeader, ...STATS_COLUMNS.map((c) => c.header)];
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...cells.map((row) => (row[i] ?? '').length)),
  );
  const pad = (text: string, i: number): string =>
    i === 0 ? text.padEnd(widths[i] ?? 0) : text.padStart(widths[i] ?? 0);

  const bodyLines = cells.map((row, r) =>
    row
      .map((text, i) => {
        const padded = pad(text, i);
        if (i === 0) return isCaveat(r) ? palette.yellow(padded) : palette.bold(padded);
        // The total is the number a reader's eye goes to; the rest stay plain so it can.
        return i === headers.length - 1 ? palette.bold(padded) : padded;
      })
      .join('  '),
  );
  return [palette.bold(heading), palette.dim(headers.map(pad).join('  ')), ...bodyLines].join('\n');
}

/**
 * Render `cctl stats`: absolute token counts for a window, by account, by model, and by day.
 *
 * The footer is not decoration. These counts come from the turn records Claude Code writes on
 * THIS machine, so anything done from the web app, the phone app or another computer is simply
 * absent, and turns older than the first switch cctl ever recorded cannot be attributed to an
 * account at all. A number that looks authoritative but is not is worse than no number, so the
 * limits ship with the table, every time, not just in the docs.
 */
export function renderTokenStats(
  stats: TokenStatsSnapshot,
  palette: Palette = PLAIN_PALETTE,
): string {
  const days = Math.max(1, Math.round((stats.windowEndMs - stats.windowStartMs) / 86_400_000));
  const heading =
    `Token usage - last ${days} day${days === 1 ? '' : 's'} ` +
    `(${localDayKey(stats.windowStartMs)} to ${localDayKey(stats.windowEndMs)})`;

  if (stats.overall.turns === 0) {
    return [
      palette.bold(heading),
      'No Claude Code turns recorded on this machine in this window.',
      '',
      ...coverageLines(stats, palette),
    ].join('\n');
  }

  const summary =
    `${formatTokens(totalTokens(stats.overall))} tokens over ` +
    `${formatTokens(stats.overall.turns)} turns`;

  return [
    palette.bold(heading),
    summary,
    '',
    renderStatsTable(
      'By account',
      'ACCOUNT',
      stats.byAccount,
      palette,
      // The unattributed bucket is the one row that is a statement about the DATA rather than
      // about an account, so it is marked as such instead of blending into the list.
      (index) => stats.byAccount[index]?.accountId == null,
    ),
    '',
    renderStatsTable('By model', 'MODEL', stats.byModel, palette),
    '',
    renderStatsTable('By day', 'DAY', stats.byDay, palette),
    '',
    ...coverageLines(stats, palette),
  ].join('\n');
}

/** The honesty footer: what was read, what was not, and what these numbers are not. */
function coverageLines(stats: TokenStatsSnapshot, palette: Palette): string[] {
  const c = stats.coverage;
  const notes = [
    `${c.filesScanned} transcript file${c.filesScanned === 1 ? '' : 's'} read`,
    `${c.filesSkippedByMtime} untouched since the window opened`,
  ];
  // Only surface the failure counts when there ARE failures — but never hide one.
  if (c.filesUnreadable > 0) notes.push(`${c.filesUnreadable} could not be read`);
  if (c.dirsUnreadable > 0) {
    notes.push(
      `${c.dirsUnreadable} project folder${c.dirsUnreadable === 1 ? '' : 's'} could not be read`,
    );
  }
  if (c.malformedLines > 0) notes.push(`${c.malformedLines} malformed lines skipped`);
  // The one number that lets an operator sanity-check the de-duplication the whole module is
  // built around (rule 1: summing lines instead of responses over-counts by ~3.3x).
  if (c.duplicateTurns > 0) notes.push(`${c.duplicateTurns} duplicate turns skipped`);
  return [
    palette.dim(`${notes.join(', ')}.`),
    palette.dim(
      'Counts are the turns Claude Code recorded on THIS machine: work from the web app, the ' +
        'phone, or another computer is not here.',
    ),
    palette.dim(
      'Turns from before cctl recorded its first switch cannot be attributed to an account. ' +
        'These are local records, not an Anthropic billing figure.',
    ),
  ];
}

/** Width of a column = the longest of its header and any cell. */
function colWidth<K extends string>(
  rows: Record<K, string>[],
  headers: Record<K, string>,
  key: K,
): number {
  return Math.max(headers[key].length, ...rows.map((r) => r[key].length));
}

/** What `cctl daemon status` has gathered before rendering — one snapshot from three
 *  independent sources (a live Scheduled Task query, the heartbeat file, the identity file)
 *  joined here only for display; each source degrades on its own (see daemonInstall.ts,
 *  heartbeat.ts, dpapiIdentityStore) so a missing piece never blocks the other lines. */
export interface DaemonStatusView {
  task: { registered: boolean; state?: string };
  heartbeat: HeartbeatReading;
  paired: boolean;
  relayUrl: string;
}

/** Render an at-a-glance daemon health report: logon task, heartbeat, pairing, relay. Pure —
 *  every value is gathered by the caller (`cctl daemon status`'s action). */
export function renderDaemonStatus(
  view: DaemonStatusView,
  palette: Palette = PLAIN_PALETTE,
): string {
  return [
    taskLine(view.task, palette),
    heartbeatLine(view, palette),
    view.paired
      ? `${palette.green('[ok]')} paired with the relay`
      : `${palette.yellow('[--]')} not paired — see: cctl pair`,
    `${palette.dim('relay:')} ${view.relayUrl}`,
  ].join('\n');
}

function taskLine(task: DaemonStatusView['task'], palette: Palette): string {
  if (!task.registered) {
    return `${palette.yellow('[--]')} logon task not registered — run: cctl daemon install`;
  }
  const state = task.state ? ` (${task.state})` : '';
  return `${palette.green('[ok]')} logon task registered${state}`;
}

/** The heartbeat line additionally reads `task.registered`: a stale heartbeat backed by a
 *  registered logon task will self-heal at the next logon, which is worth saying outright
 *  rather than leaving the reader to infer it from a bare timestamp. */
function heartbeatLine(view: DaemonStatusView, palette: Palette): string {
  const { heartbeat, task } = view;
  if (heartbeat.state === 'never') {
    return `${palette.dim('[--]')} daemon has never run on this machine — run: cctl daemon install`;
  }
  const age = ageLabel(heartbeat.ageMs);
  if (heartbeat.state === 'alive') {
    return `${palette.green('[ok]')} daemon alive (heartbeat ${age})`;
  }
  const nextStep = task.registered
    ? 'will restart at next logon (or run: cctl daemon install to start it now)'
    : 'not scheduled to restart — run: cctl daemon install';
  return `${palette.red('[!!]')} daemon not responding (last heartbeat ${age}) — ${nextStep}`;
}
