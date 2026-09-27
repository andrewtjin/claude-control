// Pure rendering helpers for the CLI.
//
// Kept free of IO so the exact output is unit-tested. Output is plain text by DEFAULT —
// color comes only from an injected palette (identity unless the program edge detected a
// TTY; see ansi.ts), and layout is always computed on plain text before painting, so
// styled and plain output align identically.

import type { DedupeReport, StoredAccount } from '@claude-control/switch-engine';
import type {
  AccountUsage,
  TokenBucketRow,
  TokenStatsSnapshot,
  TokenTotals,
} from '@claude-control/shared-protocol';
import type { HeartbeatReading, SessionAccountUse, SessionMeta } from '@claude-control/daemon';
import { localDayKey, totalTokens } from '@claude-control/daemon';
import {
  billingLabel,
  computeOutlook,
  computePacing,
  formatTokens,
  humanizeDaysUntil,
  PLAIN_PACING_STYLE,
  planLabel,
  renderPacingSummary,
  timelineInputFromWire,
  type AccountUsageInput,
  type PacingOptions,
  type PacingStyle,
} from '@claude-control/usage-advisor';
import { PLAIN_PALETTE, sanitizeForTerminal, severityPaint, type Palette } from './ansi.js';
import { MANUAL_START_HINT, type AutostartQuery } from './autostart.js';

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
    plan: planLabel(a),
    billing: billingLabel(a, nowMs),
    // Quarantine wins when both apply: it is the reason the account CANNOT be used, which
    // outranks the operator's choice about where auto-switch may go.
    status: a.quarantined ? 'quarantined' : a.autoSwitchExcluded ? 'excluded' : 'ok',
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
    // Red is reserved for a fault. Exclusion is a deliberate setting, so it reads as quiet
    // (dim) — visible without implying anything is wrong with the account.
    const paintStatus =
      r.status === 'quarantined'
        ? palette.red
        : r.status === 'excluded'
          ? palette.dim
          : (t: string) => t;
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
  /** The history-derived next weekly reset, when the caller measured one. It does NOT ride the
   *  usage snapshot — the endpoint stops publishing a reset once the weekly window closes,
   *  which is precisely when the prediction is the only clock there is — so the row has to
   *  carry it or this view alone goes silent about a reset the other surfaces are counting
   *  down to. Absent, never `undefined`-valued, so "not measured" stays distinguishable. */
  predictedResetAt?: number;
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
      return `${marker} ${label}  ${source}  ${limits}${resetLeft(r, nowMs)}${err}`;
    })
    .join('\n');
}

/** "Pacing: [ok] 67u/80u (84%) - burn 2u/d < 5u/d - 14d" — the cross-account pacing block
 *  appended after `cctl usage` and `cctl timeline`'s own output: the fleet verdict, then
 *  whatever is actionable beyond it. Shares the same AccountUsageInput view the burn plan is
 *  computed from, so the two never disagree on what counts as "an account". `computePacing`
 *  also feeds the Discord embed's own (separately-rendered, prose) pacing field from the same
 *  snapshot — only the compact CLI presentation lives here. Takes an already-adapted
 *  `PacingStyle` (see `ansi.ts`'s `pacingStyle`), the same shape `renderOutlook` takes for its
 *  own `OutlookStyle` — one adaptation convention, not two. */
export function renderPacingLine(
  inputs: AccountUsageInput[],
  options: PacingOptions,
  style: PacingStyle = PLAIN_PACING_STYLE,
): string {
  return renderPacingSummary(computePacing(inputs, options), options.nowMs, style);
}

/** "· 3d left", or "· 3d left (predicted)" — whole days until this account's weekly reset.
 *  Empty when no weekly reset time is known at all. The 5h-window count this used to print
 *  belongs to `cctl timeline`, which is the view for planning around windows; the at-a-glance
 *  question here is how many days of runway remain, and a window count made the reader convert
 *  to answer it.
 *
 *  The reset itself comes from the shared weekly rule, prediction included, so this line cannot
 *  disagree with the timeline or the phone about when the week turns over. A prediction is
 *  always marked with the same " (predicted)" the other two surfaces use — the runway is real
 *  either way, but a projection must never be read as an endpoint reading. */
function resetLeft(row: UsageRow, nowMs: number): string {
  if (!row.usage) return '';
  const outlook = computeOutlook(
    timelineInputFromWire([
      {
        ...row.usage,
        ...(row.predictedResetAt !== undefined ? { predictedResetAt: row.predictedResetAt } : {}),
      },
    ]),
    nowMs,
  );
  const budget = outlook.accounts[0]?.budget;
  if (!budget) return '';
  const mark = budget.resetPredicted ? ' (predicted)' : '';
  return ` · ${humanizeDaysUntil(budget.weeklyResetAt - nowMs)} left${mark}`;
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
 *  independent sources (a live autostart query, the heartbeat file, the identity file) joined
 *  here only for display; each source degrades on its own (see autostart.ts, heartbeat.ts,
 *  dpapiIdentityStore) so a missing piece never blocks the other lines. */
export interface DaemonStatusView {
  task: AutostartQuery;
  heartbeat: HeartbeatReading;
  paired: boolean;
  relayUrl: string;
}

/** The command a reader runs to get the daemon up: install autostart where a backend exists,
 *  otherwise run it by hand — `cctl daemon install` would only print the same hint and exit. */
function startCommand(task: AutostartQuery): string {
  return task.supported ? 'run: cctl daemon install' : 'run: cctl daemon supervise';
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

function taskLine(task: AutostartQuery, palette: Palette): string {
  if (!task.supported) {
    // A platform fact, not something to fix — so no "run: cctl daemon install" here.
    return `${palette.yellow('[--]')} autostart not available on this platform — ${MANUAL_START_HINT}`;
  }
  if (!task.registered) {
    return `${palette.yellow('[--]')} ${task.noun} not registered — run: cctl daemon install`;
  }
  const state = task.state ? ` (${task.state})` : '';
  return `${palette.green('[ok]')} ${task.noun} registered${state}`;
}

/** The heartbeat line additionally reads the autostart query: a stale heartbeat backed by a
 *  registered logon task will self-heal at the next logon, which is worth saying outright
 *  rather than leaving the reader to infer it from a bare timestamp. */
function heartbeatLine(view: DaemonStatusView, palette: Palette): string {
  const { heartbeat, task } = view;
  if (heartbeat.state === 'never') {
    // Yellow, not dim: the line hands the reader a command, and the mark colors say so (ansi.ts).
    return `${palette.yellow('[--]')} daemon has never run on this machine — ${startCommand(task)}`;
  }
  const age = ageLabel(heartbeat.ageMs);
  if (heartbeat.state === 'alive') {
    return `${palette.green('[ok]')} daemon alive (heartbeat ${age})`;
  }
  // A clean stop is a state the operator chose, not a fault: no red mark, and the command that
  // brings the daemon back is the one its registration answers to.
  if (heartbeat.state === 'stopped') {
    const command =
      task.supported && task.registered ? 'run: cctl daemon start' : startCommand(task);
    return `${palette.yellow('[--]')} daemon stopped cleanly (${age}) — ${command}`;
  }
  const nextStep =
    task.supported && task.registered
      ? 'will restart at next logon (or run: cctl daemon install to start it now)'
      : `not scheduled to restart — ${startCommand(task)}`;
  return `${palette.red('[!!]')} daemon not responding (last heartbeat ${age}) — ${nextStep}`;
}

// ---------------------------------------------------------------------------
// Duplicate-account resolution notice
// ---------------------------------------------------------------------------

/** One line per repair the vault made before an account listing, so a row that vanished or
 *  changed its name is explained on the spot; empty when nothing happened. Plain by default;
 *  the palette marks the lines as notices, never as errors — nothing failed. */
export function renderAccountHeal(report: DedupeReport, palette: Palette = PLAIN_PALETTE): string {
  const lines = [
    ...report.merged.map(
      (m) =>
        `${palette.yellow('merged')} duplicate account ${m.label}: kept ${m.keptId}, removed ` +
        `${m.removedId} (the same login was stored twice)`,
    ),
    ...report.relabelled.map(
      (r) =>
        `${palette.yellow('renamed')} account ${r.from} (${r.id}) to "${r.to}": another account ` +
        'already had that label',
    ),
  ];
  return lines.length === 0 ? '' : lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------
// Folder-bound accounts (bindings / where)
// ---------------------------------------------------------------------------
//
// Every folder path and account label rendered here is operator- or filesystem-supplied, so both go
// through sanitizeForTerminal before they reach the terminal (see ansi.ts) — a label carrying an
// ANSI/bidi escape can neither recolor the surface nor reorder a path.

/** One member of a folder-bound group, as shown in the bindings views. */
export interface BindingMemberView {
  label: string;
  /** The member currently live in the group's slot (reconciled, not just the recorded activeId). */
  live: boolean;
  quarantined: boolean;
  excluded: boolean;
}

/** One folder-bound group for display. */
export interface BindingGroupView {
  label: string;
  folders: string[];
  members: BindingMemberView[];
  profileDir: string;
  /** True when no member could be made live (all quarantined) — the folder has no working account. */
  noWorkingAccount: boolean;
}

/** Render the per-group listing (folders, members with the live one marked, profile dir). Shared by
 *  `cctl bindings`, and appended to `cctl accounts list` / `cctl usage` so a binding is always
 *  visible alongside the shared pool. Returns '' when there are no groups. */
export function renderBindingGroups(
  groups: BindingGroupView[],
  palette: Palette = PLAIN_PALETTE,
): string {
  if (groups.length === 0) return '';
  const blocks = groups.map((g) => {
    const header = palette.bold(sanitizeForTerminal(g.label));
    const folderLines = g.folders.map((f) => `  folder:  ${sanitizeForTerminal(f)}`);
    const memberLine =
      '  accounts: ' +
      g.members
        .map((m) => {
          const name = sanitizeForTerminal(m.label);
          const marks: string[] = [];
          if (m.quarantined) marks.push('quarantined');
          else if (m.excluded) marks.push('excluded');
          const suffix = marks.length > 0 ? ` (${marks.join(', ')})` : '';
          // The live member is marked with * and painted green, matching the accounts table.
          return m.live ? palette.green(`*${name}${suffix}`) : `${name}${suffix}`;
        })
        .join(', ');
    const liveLine = g.noWorkingAccount
      ? '  ' + palette.red('live:    none usable (re-login a member: cctl accounts relogin <ref>)')
      : null;
    const profileLine = '  profile: ' + palette.dim(sanitizeForTerminal(g.profileDir));
    return [header, ...folderLines, memberLine, ...(liveLine ? [liveLine] : []), profileLine].join(
      '\n',
    );
  });
  return blocks.join('\n\n');
}

/** The freshness + enforce footer for `cctl bindings`. Freshness is judged by the guard-relevant
 *  CONTENT of the snapshot the guard reads (bound folders, profile dirs, member labels, enforce), not
 *  the groups generation — the generation also bumps on a routine group member switch the guard never
 *  sees, which must not read as stale. A genuine STALE means a bound folder/profile/member/enforce
 *  changed without the snapshot being rewritten (a bind/unbind or a daemon restart rewrites it). */
export interface BindingsFooterView {
  /** Whether a guard snapshot exists at all. */
  present: boolean;
  /** Whether the snapshot's guard-relevant content matches the live registry. */
  fresh: boolean;
  enforce: 'block' | 'warn' | 'off';
}

export function renderBindingsFooter(
  view: BindingsFooterView,
  palette: Palette = PLAIN_PALETTE,
): string {
  const enforceLine = `enforcement: ${view.enforce}`;
  let freshness: string;
  if (!view.present) {
    freshness = palette.yellow(
      'guard snapshot: missing (the guard cannot enforce until the daemon writes it, or a bind does)',
    );
  } else if (view.fresh) {
    freshness = 'guard snapshot: fresh';
  } else {
    freshness = palette.yellow(
      'guard snapshot: STALE (the guard is enforcing an out-of-date binding view); ' +
        'run cctl bind/unbind again or restart the daemon to refresh it',
    );
  }
  return `${enforceLine}\n${freshness}`;
}

/** The full `cctl bindings` view: the group listing plus the footer. */
export function renderBindings(
  input: { groups: BindingGroupView[]; footer: BindingsFooterView },
  palette: Palette = PLAIN_PALETTE,
): string {
  if (input.groups.length === 0) {
    return 'No folder-bound accounts. Bind one with: cctl bind <folder> <account>[,<account>...]';
  }
  return (
    renderBindingGroups(input.groups, palette) +
    '\n\n' +
    renderBindingsFooter(input.footer, palette)
  );
}

/** The resolution `cctl where` explains for a folder. */
export interface WhereView {
  /** The canonical folder queried. */
  folder: string;
  /** The group it resolves to, or null when it runs on the global (shared) account. */
  bound: {
    groupLabel: string;
    matchedFolder: string;
    members: string[];
    profileDir: string;
    liveMemberLabel: string | null;
  } | null;
}

/** Explain which account a folder runs on, print the env line a session needs, and a VS Code
 *  `.vscode/settings.json` snippet (claudeCode.environmentVariables) for that folder. */
export function renderWhere(view: WhereView, palette: Palette = PLAIN_PALETTE): string {
  const folder = sanitizeForTerminal(view.folder);
  if (view.bound === null) {
    return [
      `${palette.bold(folder)}`,
      '  runs on: the global (shared) account — no folder binding applies here',
      '  env:     CLAUDE_CONFIG_DIR is not set (the global slot)',
      '',
      'Bind this folder to an account with: cctl bind ' + folder + ' <account>[,<account>...]',
    ].join('\n');
  }
  const b = view.bound;
  const members = b.members.map((m) => sanitizeForTerminal(m)).join(', ');
  const live = b.liveMemberLabel ? sanitizeForTerminal(b.liveMemberLabel) : 'none usable';
  const profile = sanitizeForTerminal(b.profileDir);
  // The Claude Code extension's setting is an ARRAY of {name, value} pairs (its default is []),
  // not an object map; an object here would be ignored and the extension would launch on the
  // global account.
  const vscodeSnippet = JSON.stringify(
    { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: b.profileDir }] },
    null,
    2,
  );
  return [
    `${palette.bold(folder)}`,
    `  runs on: ${palette.bold(sanitizeForTerminal(b.groupLabel))} (${members})`,
    `  live:    ${live}`,
    `  matched: ${sanitizeForTerminal(b.matchedFolder)}`,
    `  env:     CLAUDE_CONFIG_DIR=${profile}`,
    '',
    'Start Claude Code here with the right account using: cctl claude',
    '(or install the wrapper once: cctl shell-init powershell)',
    '',
    'For VS Code, put this in ' + folder + '\\.vscode\\settings.json:',
    vscodeSnippet,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Session aliases (`cctl session show` / `cctl session aliases`)
// ---------------------------------------------------------------------------

/** One session with the accounts its turns were billed to. */
export interface SessionView {
  meta: SessionMeta;
  accounts: SessionAccountUse[];
}

/** `YYYY-MM-DD HH:MM` in local time — the operator reads their own clock. */
function localStamp(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${localDayKey(ms)} ${hh}:${mm}`;
}

/** Where a session's alias came from: `custom` (`/rename`, `--name`) or `auto` (generated). Mirrors
 *  `aliasOf`: a custom title that is present but blank hides the generated one, as it does for
 *  `claude --resume`. */
function aliasSource(meta: SessionMeta): 'custom' | 'auto' | null {
  if (meta.customTitle !== null) return meta.customTitle.trim() === '' ? null : 'custom';
  return meta.aiTitle !== null && meta.aiTitle.trim() !== '' ? 'auto' : null;
}

/** The session's alias as `claude --resume` sees it (`customTitle ?? aiTitle`), or null. */
function aliasText(meta: SessionMeta): string | null {
  const source = aliasSource(meta);
  return source === 'custom' ? meta.customTitle : source === 'auto' ? meta.aiTitle : null;
}

/** The `--json` shape of one session. Stable field names; timestamps as ISO strings. Titles and
 *  paths go out verbatim — JSON escapes control characters itself. */
export function sessionViewJson(view: SessionView): Record<string, unknown> {
  const m = view.meta;
  return {
    sessionId: m.sessionId,
    alias: aliasText(m),
    aliasSource: aliasSource(m),
    customTitle: m.customTitle,
    aiTitle: m.aiTitle,
    folder: m.folder,
    launchCwd: m.launchCwd,
    firstActivity: m.firstActivityMs === null ? null : new Date(m.firstActivityMs).toISOString(),
    lastActivity: new Date(m.lastActivityMs).toISOString(),
    transcript: m.file,
    accounts: view.accounts.map((a) => ({
      accountId: a.accountId,
      label: a.label,
      turns: a.turns,
      tokens: a.tokens,
      first: new Date(a.firstMs).toISOString(),
      last: new Date(a.lastMs).toISOString(),
    })),
  };
}

/** One account's line: label, turns, tokens and when. */
function accountUseLine(use: SessionAccountUse, palette: Palette): string {
  const label = sanitizeForTerminal(use.label);
  const when =
    localDayKey(use.firstMs) === localDayKey(use.lastMs)
      ? localStamp(use.lastMs)
      : `${localStamp(use.firstMs)} -> ${localStamp(use.lastMs)}`;
  const turns = `${use.turns} turn${use.turns === 1 ? '' : 's'}`;
  const name = use.accountId === null ? palette.dim(label) : palette.bold(label);
  return `${name}  ${turns}, ${formatTokens(use.tokens)} tokens  ${palette.dim(when)}`;
}

/** Whether `meta` is the session this command runs inside. */
function isCurrentSession(meta: SessionMeta, currentSessionId: string | undefined): boolean {
  return (
    currentSessionId !== undefined &&
    currentSessionId.toLowerCase() === meta.sessionId.toLowerCase()
  );
}

export interface SessionDetailsContext {
  folder: string;
  matchedBy: 'id' | 'alias';
  /** For an alias match: whether it was found in `folder` (false = in the one other folder). */
  inScope?: boolean;
  currentSessionId?: string | undefined;
}

/** `cctl session show`: one block per session. */
export function renderSessionDetails(
  views: SessionView[],
  ctx: SessionDetailsContext,
  palette: Palette = PLAIN_PALETTE,
): string {
  const out: string[] = [];
  const first = views[0];
  if (ctx.matchedBy === 'alias' && ctx.inScope === false && first?.meta.folder != null) {
    out.push(
      palette.yellow(
        `No session with that alias in ${sanitizeForTerminal(ctx.folder)}; ` +
          `showing the one in ${sanitizeForTerminal(first.meta.folder)}.`,
      ),
      '',
    );
  }
  if (views.length > 1) {
    out.push(
      `${views.length} sessions share this alias in this folder; "claude --resume <alias>" opens ` +
        'a picker for them instead of resuming one.',
      '',
    );
  }
  views.forEach((view, i) => {
    if (i > 0) out.push('');
    const m = view.meta;
    const alias = aliasText(m);
    out.push(
      `Alias     ${alias === null ? palette.dim('(none)') : palette.bold(sanitizeForTerminal(alias))}` +
        (aliasSource(m) === 'auto' ? palette.dim('  (generated title; /rename sets one)') : '') +
        (isCurrentSession(m, ctx.currentSessionId) ? palette.cyan('  <- this session') : ''),
    );
    out.push(
      `Folder    ${m.folder === null ? palette.dim('(unknown)') : sanitizeForTerminal(m.folder)}`,
    );
    if (m.launchCwd !== null && m.folder !== null && m.launchCwd !== m.folder) {
      out.push(`          ${palette.dim('(started in ' + sanitizeForTerminal(m.launchCwd) + ')')}`);
    }
    out.push(`Session   ${sanitizeForTerminal(m.sessionId)}`);
    const since = m.firstActivityMs === null ? '?' : localStamp(m.firstActivityMs);
    out.push(`Active    ${since} -> ${localStamp(m.lastActivityMs)}`);
    if (view.accounts.length === 0) {
      out.push(`Accounts  ${palette.dim('(no turns recorded yet)')}`);
    } else {
      view.accounts.forEach((use, j) => {
        out.push(`${j === 0 ? 'Accounts  ' : '          '}${accountUseLine(use, palette)}`);
      });
    }
  });
  return out.join('\n');
}

export interface SessionAliasListContext {
  /** The folder listed, or null for every folder. */
  folder: string | null;
  currentSessionId?: string | undefined;
}

/** `cctl session aliases`: one row per named session. */
export function renderSessionAliasList(
  views: SessionView[],
  ctx: SessionAliasListContext,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (views.length === 0) {
    const where = ctx.folder === null ? 'on this machine' : `in ${sanitizeForTerminal(ctx.folder)}`;
    return `No named sessions ${where}. Name one with /rename <alias> (or claude --name <alias>).`;
  }
  let anyAuto = false;
  let anyCurrent = false;
  const rows = views.map((v) => {
    const auto = aliasSource(v.meta) === 'auto';
    const current = isCurrentSession(v.meta, ctx.currentSessionId);
    anyAuto ||= auto;
    anyCurrent ||= current;
    return {
      alias:
        sanitizeForTerminal(aliasText(v.meta) ?? '') + (auto ? ' ~' : '') + (current ? ' *' : ''),
      last: localStamp(v.meta.lastActivityMs),
      accounts:
        v.accounts.length === 0
          ? '-'
          : v.accounts.map((a) => sanitizeForTerminal(a.label)).join(', '),
      session: sanitizeForTerminal(v.meta.sessionId.slice(0, 8)),
      folder: v.meta.folder === null ? '' : sanitizeForTerminal(v.meta.folder),
    };
  });
  type Col = keyof (typeof rows)[number];
  const headers: Record<Col, string> = {
    alias: 'ALIAS',
    last: 'LAST ACTIVE',
    accounts: 'ACCOUNTS',
    session: 'SESSION',
    folder: 'FOLDER',
  };
  const cols: Col[] =
    ctx.folder === null
      ? ['alias', 'last', 'accounts', 'session', 'folder']
      : ['alias', 'last', 'accounts', 'session'];
  const widths = new Map(
    cols.map((c) => [c, Math.max(headers[c].length, ...rows.map((r) => r[c].length))] as const),
  );
  const line = (r: Record<Col, string>): string =>
    cols
      .map((c, i) => (i === cols.length - 1 ? r[c] : r[c].padEnd(widths.get(c) ?? 0)))
      .join('  ')
      .trimEnd();
  const out = [palette.bold(line(headers)), ...rows.map(line)];
  if (ctx.folder !== null) out.unshift(palette.dim(sanitizeForTerminal(ctx.folder)), '');
  const notes: string[] = [];
  if (anyAuto) notes.push('~ generated title');
  if (anyCurrent) notes.push('* this session');
  if (notes.length > 0) out.push('', palette.dim(notes.join('   ')));
  return out.join('\n');
}

/** An alias found in several other folders: list them, and say how to pick. */
export function renderAmbiguousAlias(
  alias: string,
  folders: { folder: string; sessions: SessionMeta[] }[],
  palette: Palette = PLAIN_PALETTE,
): string {
  const out = [
    palette.yellow(
      `"${sanitizeForTerminal(alias)}" is not a session in this folder, and ${folders.length} ` +
        'other folders use it:',
    ),
  ];
  for (const f of folders) {
    const n = f.sessions.length;
    const latest = f.sessions[0];
    const last = latest === undefined ? '' : `  last active ${localStamp(latest.lastActivityMs)}`;
    out.push(`  ${sanitizeForTerminal(f.folder)}  (${n} session${n === 1 ? '' : 's'})${last}`);
  }
  out.push('', 'Run it from one of those folders, or pass --cwd <folder>.');
  return out.join('\n');
}
