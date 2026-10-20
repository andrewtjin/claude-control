// The full-screen view's frame, as a pure function of its state.
//
// `renderFrame(state, cols, rows, palette)` returns exactly `rows` lines, none wider than `cols`
// visible columns. The runtime writes them over the previous frame whole, so there is no diffing
// to get wrong, and the same state always draws the same screen (which is what the snapshot tests
// hold it to).
//
// The Accounts pane is drawn here, cell by cell, because it is a selectable list with columns
// that drop as the terminal narrows. The other panes reuse the renderers behind `cctl session
// status`, `cctl folders` and `cctl outages`, so a pane and its command can never disagree.
//
// Layout: header, pane tabs, body, status line, key hints. Every cell is measured and padded as
// plain text first and painted after (paint codes are zero-width), as render.ts does.

import type { AccountUsage } from '@claude-control/shared-protocol';
import { humanizeDuration, roundPct } from '@claude-control/usage-advisor';
import { renderFolders, shellQuote } from '../folderRender.js';
import { renderOutages } from '../outagesView.js';
import { renderSessionStatus } from '../sessionRender.js';
import { sanitizeForTerminal, severityPaint, type Palette } from '../ansi.js';
import { plainPunctuation } from '../textWidth.js';
import { accountsOf, lastMessage, selectedAccount } from './state.js';
import {
  clip,
  cutTail,
  displayWidth,
  fit,
  keepColorOnly,
  truncateAnsi,
  visibleWidth,
  wrap,
  wrapWithin,
} from './text.js';
import { PANES, type PaneId, type TuiAccount, type TuiState, type TuiTag } from './types.js';

/** Narrower than this, the columns cannot hold an account row worth reading. */
export const MIN_COLS = 40;
/** Shorter than this, there is no room for one body line between the header and the hints. */
export const MIN_ROWS = 6;
/** Header, tabs, status line and hints: the rows that are not body. */
const CHROME_ROWS = 4;
/** A long status message wraps onto at most this many rows (taken from the body) rather than
 *  being cut at the edge, where its remedy usually sits. */
const MAX_STATUS_ROWS = 3;
/** Body rows a long status message never takes: the accounts' column header and one account row
 *  under it, so the selected account (the one Enter would switch to) stays on screen however
 *  short the terminal. */
const BODY_ROWS_KEPT = 2;
/** Separator between header parts and between key hints. ASCII: a middle dot is ambiguous width,
 *  two columns on a terminal set up for CJK text, and would push the hints past the edge. */
const SEP = ' | ';

/** A message (a refusal, an error, an outcome) as the view draws it: only printable text, and its
 *  typographic punctuation in ASCII, for the same reason as {@link SEP}. Messages only: a label in
 *  its own cell is drawn as stored, since a person may type it back (a removal asks for it). */
function messageText(text: string): string {
  return plainPunctuation(sanitizeForTerminal(text));
}

/** Pane names as the tabs show them. */
const PANE_TITLES: Readonly<Record<PaneId, string>> = {
  accounts: 'Accounts',
  sessions: 'Sessions',
  folders: 'Folders',
  outages: 'Outages',
};

/** The key table the help overlay shows (and docs/CLI.md repeats). */
export const KEY_HELP: ReadonlyArray<readonly [string, string]> = [
  ['up/down or k/j', 'move the selection (Accounts) or scroll (other panes)'],
  ['PgUp/PgDn, Home/End', 'move or scroll further'],
  ['Tab / Shift-Tab', 'next / previous pane'],
  ['Enter', 'switch to the selected account'],
  ['e', 'exclude the selected account from auto-switch, or include it again'],
  ['r', 'rename the selected account'],
  ['a', 'add an account (opens a Claude login window, then comes back)'],
  ['d', 'remove the selected account (asks you to type its label)'],
  ['u', 'ask the daemon to refresh usage now'],
  ['l', 'show the command that runs Claude as the selected account'],
  ['m', 'show the last message in full (a long one is cut on the status line)'],
  ['?', 'this help'],
  ['q or Esc', 'quit'],
];

// ---------------------------------------------------------------------------
// Accounts pane columns
// ---------------------------------------------------------------------------

/** Selection mark and active mark. */
const PREFIX_WIDTH = 2;
/** The bar inside a usage window cell. */
const BAR_WIDTH = 5;
/** A usage window without its reset: bar, space, percent ("100%"). */
const WINDOW_WIDTH = BAR_WIDTH + 1 + 4;
/** A reset countdown: "6d 23h", or "~6d 23h" when predicted. */
const RESET_WIDTH = 7;
/** Data age: "now", "59m", "23h", "12d". */
const AGE_WIDTH = 3;
/** Gap between columns. */
const GAP = 1;
/** Labels shrink to this before anything else gives way, and never further. */
const MIN_LABEL = 5;
/** The widest a label column grows; longer labels end in an ellipsis. */
const MAX_LABEL = 20;
/** Tags keep at least this much room (or what they need, if less) before optional columns go. */
const MIN_TAGS = 12;

/** Which optional columns are drawn, and how wide each column is. */
export interface AccountColumns {
  plan: boolean;
  resets: boolean;
  perModel: boolean;
  labelWidth: number;
  planWidth: number;
  modelWidth: number;
  /** 0 when there is no room (or nothing) to show. */
  tagsWidth: number;
}

/** The optional columns, in the order they give way as the terminal narrows. */
export const COLUMN_DROP_ORDER = ['perModel', 'resets', 'plan'] as const;

/**
 * Fit the account columns to `cols`. Optional columns drop in {@link COLUMN_DROP_ORDER} (per-model
 * windows, then reset times, then the plan) until the rest fits beside a little room for tags;
 * then the label column narrows; the tags take whatever is left.
 */
export function planAccountColumns(
  accounts: readonly TuiAccount[],
  cols: number,
  nowMs: number,
): AccountColumns {
  const labelNatural = Math.min(
    MAX_LABEL,
    Math.max(7, ...accounts.map((a) => displayWidth(sanitizeForTerminal(a.label)))),
  );
  const planNatural = Math.max(4, ...accounts.map((a) => displayWidth(a.plan)));
  const modelNatural = (resets: boolean): number =>
    Math.max(0, ...accounts.map((a) => displayWidth(modelCellText(a, resets, nowMs))));
  const tagsNatural = Math.max(0, ...accounts.map((a) => displayWidth(tagsText(accountTags(a)))));
  const tagsFloor = Math.min(MIN_TAGS, tagsNatural);

  const shown = { perModel: modelNatural(true) > 0, resets: true, plan: true };
  const fixed = (label: number): number => {
    const window = WINDOW_WIDTH + (shown.resets ? GAP + RESET_WIDTH : 0);
    const model = shown.perModel ? modelNatural(shown.resets) : 0;
    return (
      PREFIX_WIDTH +
      GAP +
      label +
      (shown.plan ? GAP + planNatural : 0) +
      2 * (GAP + window) +
      (shown.perModel && model > 0 ? GAP + model : 0) +
      GAP +
      AGE_WIDTH
    );
  };
  const needs = (label: number): number => fixed(label) + (tagsFloor > 0 ? GAP + tagsFloor : 0);
  for (const column of COLUMN_DROP_ORDER) {
    if (needs(labelNatural) <= cols) break;
    shown[column] = false;
  }
  let labelWidth = labelNatural;
  while (labelWidth > MIN_LABEL && needs(labelWidth) > cols) labelWidth -= 1;
  const room = cols - fixed(labelWidth) - GAP;
  const modelWidth = shown.perModel ? modelNatural(shown.resets) : 0;
  return {
    plan: shown.plan,
    resets: shown.resets,
    perModel: shown.perModel && modelWidth > 0,
    labelWidth,
    planWidth: planNatural,
    modelWidth,
    tagsWidth: tagsNatural > 0 ? Math.max(0, Math.min(room, Math.max(4, tagsNatural))) : 0,
  };
}

/** The tags an account row carries, in the order they read: folders, the operator's settings,
 *  faults, then anything another part of cctl contributes. */
export function accountTags(account: TuiAccount): TuiTag[] {
  const tags: TuiTag[] = account.folders.map((f) => ({
    text: `folder: ${sanitizeForTerminal(f)}`,
    tone: 'info' as const,
  }));
  if (account.excluded) tags.push({ text: 'excluded', tone: 'dim' });
  if (account.quarantined) tags.push({ text: 'quarantined', tone: 'error' });
  if (account.usage?.error) {
    tags.push({ text: `error: ${messageText(account.usage.error)}`, tone: 'error' });
  }
  return [...tags, ...account.extraTags];
}

function tagsText(tags: readonly TuiTag[]): string {
  return tags.map((t) => t.text).join(', ');
}

/** The tags painted into exactly `width` columns: whole tags while they fit, the next one cut. */
function paintTags(tags: readonly TuiTag[], width: number, palette: Palette): string {
  const paint = (tag: TuiTag): ((t: string) => string) =>
    tag.tone === 'error' ? palette.red : tag.tone === 'dim' ? palette.dim : palette.cyan;
  let out = '';
  let used = 0;
  for (const [i, tag] of tags.entries()) {
    const sep = i === 0 ? '' : ', ';
    const room = width - used - sep.length;
    if (room <= 0) break;
    const text = clip(tag.text, room);
    out += sep + paint(tag)(text);
    used += sep.length + displayWidth(text);
    if (text !== tag.text) break;
  }
  return out + ' '.repeat(Math.max(0, width - used));
}

/** "3d 4h" until `atMs`, "now" once passed. */
function countdown(atMs: number, nowMs: number): string {
  return humanizeDuration(atMs - nowMs);
}

/** A limit's reset time in epoch ms, when it has a parseable one. */
function resetMs(limit: AccountUsage['limits'][number] | undefined): number | undefined {
  if (!limit?.resetsAt) return undefined;
  const ms = Date.parse(limit.resetsAt);
  return Number.isFinite(ms) ? ms : undefined;
}

/** How the per-model weekly windows read in plain text: "fable 45% 2d 3h". */
function modelCellText(account: TuiAccount, resets: boolean, nowMs: number): string {
  const scoped = account.usage?.limits.filter((l) => l.kind === 'weekly_scoped') ?? [];
  return scoped
    .map((l) => {
      const at = resetMs(l);
      const name = l.scope ? sanitizeForTerminal(l.scope) : 'fable';
      return `${name} ${roundPct(l.percent)}%${resets && at !== undefined ? ` ${countdown(at, nowMs)}` : ''}`;
    })
    .join('  ');
}

/** One usage window cell: a bar, the percent, and (when shown) the reset. `predictedAt` stands in
 *  for a reset the endpoint stopped reporting, marked "~" so a projection never reads as a
 *  reading. */
function windowCell(
  limit: AccountUsage['limits'][number] | undefined,
  resets: boolean,
  predictedAt: number | undefined,
  nowMs: number,
  palette: Palette,
): string {
  const width = WINDOW_WIDTH + (resets ? GAP + RESET_WIDTH : 0);
  if (limit === undefined) return palette.dim(fit('-', width));
  const pct = roundPct(limit.percent);
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const paint = severityPaint(palette, pct);
  const bar = paint('#'.repeat(filled)) + palette.dim('.'.repeat(BAR_WIDTH - filled));
  const percent = paint(`${pct}%`.padStart(4));
  if (!resets) return `${bar} ${percent}`;
  const at = resetMs(limit);
  const reset =
    at !== undefined
      ? countdown(at, nowMs)
      : predictedAt !== undefined
        ? `~${countdown(predictedAt, nowMs)}`
        : '';
  return `${bar} ${percent} ${palette.dim(fit(reset, RESET_WIDTH))}`;
}

/** How old a reading is, in at most three columns. */
function ageShort(ms: number): string {
  if (ms < 60_000) return 'now';
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.min(99, Math.floor(hours / 24))}d`;
}

/** The column titles above the account rows. */
function accountHeader(c: AccountColumns, palette: Palette): string {
  const window = WINDOW_WIDTH + (c.resets ? GAP + RESET_WIDTH : 0);
  const cells = [
    ' '.repeat(PREFIX_WIDTH),
    fit('ACCOUNT', c.labelWidth),
    ...(c.plan ? [fit('PLAN', c.planWidth)] : []),
    fit('5H', window),
    fit('7D', window),
    ...(c.perModel ? [fit('MODELS', c.modelWidth)] : []),
    ...(c.tagsWidth > 0 ? [fit('TAGS', c.tagsWidth)] : []),
    fit('AGE', AGE_WIDTH),
  ];
  return palette.dim(cells.join(' '));
}

/** One account row. */
function accountRow(
  account: TuiAccount,
  selected: boolean,
  c: AccountColumns,
  nowMs: number,
  palette: Palette,
): string {
  const usage = account.usage;
  const limit = (kind: AccountUsage['limits'][number]['kind']) =>
    usage?.limits.find((l) => l.kind === kind);
  const label = fit(sanitizeForTerminal(account.label), c.labelWidth);
  const cells = [
    (selected ? palette.bold('>') : ' ') + (account.active ? palette.green('*') : ' '),
    selected ? palette.bold(label) : label,
    ...(c.plan ? [fit(account.plan, c.planWidth)] : []),
    windowCell(limit('session'), c.resets, undefined, nowMs, palette),
    windowCell(limit('weekly_all'), c.resets, account.predictedResetAt, nowMs, palette),
    ...(c.perModel ? [fit(modelCellText(account, c.resets, nowMs), c.modelWidth)] : []),
    ...(c.tagsWidth > 0 ? [paintTags(accountTags(account), c.tagsWidth, palette)] : []),
    palette.dim(fit(usage ? ageShort(nowMs - usage.fetchedAtMs) : '-', AGE_WIDTH)),
  ];
  return cells.join(' ');
}

/** The Accounts pane body: the column titles, then as many rows as fit, scrolled so the
 *  selection is always on screen. */
function accountsBody(state: TuiState, cols: number, height: number, palette: Palette): string[] {
  const section = state.snapshot?.accounts;
  if (section === undefined) return [palette.dim('Reading accounts...')];
  // The Accounts pane does not scroll, so a failure taller than the body keeps its start and its
  // end (the file, and what to do about it) rather than running off the bottom.
  if (!section.ok) return failedLines('the accounts', section.error, cols, palette, height);
  const accounts = section.value;
  if (accounts.length === 0) {
    return [
      'No accounts yet.',
      'Press a to log one in, or run `cctl setup` for the guided first run.',
    ];
  }
  const columns = planAccountColumns(accounts, cols, state.nowMs);
  // The accounts come from the vault; when only their usage could not be read they are still
  // listed (and still act), with a line saying why the numbers are missing.
  const usageError = state.snapshot?.usageError;
  const note =
    usageError === undefined
      ? []
      : wrap(`Usage could not be read: ${messageText(usageError)}`, cols).map((l) =>
          palette.yellow(l),
        );
  const visible = Math.max(1, height - 1 - note.length);
  const selectedId = selectedAccount(state)?.id;
  const selectedIndex = Math.max(
    0,
    accounts.findIndex((a) => a.id === selectedId),
  );
  const offset = selectedIndex < visible ? 0 : selectedIndex - visible + 1;
  return [
    accountHeader(columns, palette),
    ...accounts
      .slice(offset, offset + visible)
      .map((a) => accountRow(a, a.id === selectedId, columns, state.nowMs, palette)),
    ...note,
  ];
}

/** A pane read failure, wrapped over the body (at most `rows` rows, keeping its start and end):
 *  the end of such a message (the file, what to do about it) is the part that matters, and a
 *  single line cut at the edge would hide it. */
function failedLines(
  what: string,
  error: string,
  cols: number,
  palette: Palette,
  rows = Number.POSITIVE_INFINITY,
): string[] {
  const text = `Could not read ${what}: ${messageText(error)}`;
  return wrapWithin(text, cols, rows).lines.map((l) => palette.red(l));
}

// ---------------------------------------------------------------------------
// Text panes
// ---------------------------------------------------------------------------

/** The lines of a text pane, from the renderer behind its command. A read failure is wrapped to
 *  `cols`. */
export function paneLines(
  state: TuiState,
  pane: Exclude<PaneId, 'accounts'>,
  palette: Palette,
  cols = Number.POSITIVE_INFINITY,
): string[] {
  const snapshot = state.snapshot;
  if (snapshot === undefined) return [palette.dim('Reading...')];
  const failed = (what: string, error: string): string[] => failedLines(what, error, cols, palette);
  switch (pane) {
    case 'sessions': {
      const s = snapshot.sessions;
      if (!s.ok) return failed('the sessions', s.error);
      return renderSessionStatus(s.value.rows, s.value.header, palette).split('\n');
    }
    case 'folders': {
      const s = snapshot.folders;
      if (!s.ok) return failed('the folder rules', s.error);
      return renderFolders(s.value, palette).split('\n');
    }
    case 'outages': {
      const s = snapshot.outages;
      if (!s.ok) return failed('the outage log', s.error);
      return renderOutages(s.value.episodes, {
        now: state.nowMs,
        logPath: s.value.logPath,
        open: s.value.open,
        palette,
      }).split('\n');
    }
  }
}

/** How far a text pane may scroll: its last line at the bottom of the body, never past it. */
export function maxScroll(lineCount: number, bodyHeight: number): number {
  return Math.max(0, lineCount - bodyHeight);
}

/** Pull the current text pane's scroll (or the help overlay's) back inside its content, so End
 *  then Up moves at once instead of first unwinding scroll past the last line. The runtime applies
 *  it before drawing. */
export function settleScroll(
  state: TuiState,
  rows: number,
  palette: Palette,
  cols = Number.POSITIVE_INFINITY,
): TuiState {
  const body = bodyHeight(rows) - (statusLines(state, cols, rows, palette).lines.length - 1);
  const mode = state.mode;
  if (mode.kind === 'help' || mode.kind === 'message') {
    const lines = mode.kind === 'help' ? helpBody(palette, cols) : messageBody(state, cols);
    const limit = maxScroll(lines.length, body);
    return mode.scroll <= limit ? state : { ...state, mode: { kind: mode.kind, scroll: limit } };
  }
  if (state.pane === 'accounts') return state;
  const pane = state.pane;
  const limit = maxScroll(paneLines(state, pane, palette, cols).length, body);
  return state.scroll[pane] <= limit
    ? state
    : { ...state, scroll: { ...state.scroll, [pane]: limit } };
}

/** The body height for a terminal `rows` tall, with a one-row status line. */
export function bodyHeight(rows: number): number {
  return Math.max(0, rows - CHROME_ROWS);
}

/** Whether a terminal this size is below what the view can draw (it shows a notice instead, and
 *  the runtime then acts on no key but the ones that quit). */
export function isFrameTooSmall(cols: number, rows: number): boolean {
  return cols < MIN_COLS || rows < MIN_ROWS;
}

// ---------------------------------------------------------------------------
// Chrome
// ---------------------------------------------------------------------------

/** "cctl  daemon up | auto-switch on | last poll 2m ago". */
function headerLine(state: TuiState, palette: Palette): string {
  const parts: string[] = [];
  const daemon = state.snapshot?.daemon;
  const heartbeat = daemon?.heartbeat;
  if (heartbeat === undefined) parts.push(palette.dim('reading...'));
  else if (heartbeat.state === 'alive') parts.push(palette.green('daemon up'));
  else if (heartbeat.state === 'stale') parts.push(palette.red('daemon not answering'));
  else if (heartbeat.state === 'stopped') parts.push(palette.yellow('daemon stopped'));
  else parts.push(palette.yellow('daemon not running'));
  if (heartbeat?.state === 'alive' && daemon?.autoSwitch !== undefined) {
    parts.push(`auto-switch ${daemon.autoSwitch ? 'on' : 'off'}`);
  }
  if (state.snapshot !== undefined) {
    const polled = accountsOf(state)
      .map((a) => a.usage?.fetchedAtMs)
      .filter((t): t is number => t !== undefined);
    parts.push(
      polled.length > 0
        ? `last poll ${humanizeElapsedShort(state.nowMs - Math.max(...polled))}`
        : 'no poll yet',
    );
  }
  return `${palette.bold('cctl')}  ${parts.join(palette.dim(SEP))}`;
}

/** "2m ago" / "just now" for the header. */
function humanizeElapsedShort(ms: number): string {
  return ms < 60_000 ? 'just now' : `${humanizeDuration(ms)} ago`;
}

/** The pane tabs, the current one bracketed (and bold where there is color). */
function tabsLine(state: TuiState, palette: Palette): string {
  return PANES.map((p) =>
    p === state.pane ? palette.bold(`[${PANE_TITLES[p]}]`) : palette.dim(` ${PANE_TITLES[p]} `),
  ).join(' ');
}

/** The text the status line says and how it is painted: what is running, else the last message,
 *  else a read that failed. */
function statusText(
  state: TuiState,
  palette: Palette,
): { text: string; paint: (t: string) => string } {
  if (state.busy !== undefined) {
    const quitting = state.quitWhenIdle
      ? ' - quitting when this finishes (Ctrl-C again to quit now)'
      : '';
    return { text: messageText(state.busy + quitting), paint: palette.yellow };
  }
  const text = lastMessage(state);
  if (text === undefined) return { text: '', paint: (t) => t };
  const safe = messageText(text);
  switch (state.status?.tone ?? 'error') {
    case 'error':
      return { text: safe, paint: palette.red };
    case 'warn':
      return { text: safe, paint: palette.yellow };
    case 'ok':
      return { text: safe, paint: palette.green };
    case 'info':
      return { text: safe, paint: (t) => t };
  }
}

/**
 * The status line's rows, and whether the message had to be cut to fit them. It wraps onto as
 * many as {@link MAX_STATUS_ROWS} rows while {@link BODY_ROWS_KEPT} body rows are left; a message
 * longer than that keeps its start (what happened) and its end (what to do about it), and the
 * message overlay (m) shows it whole. An open prompt is its last row, under the note saying why its last
 * Enter did not go through.
 */
function statusLines(
  state: TuiState,
  cols: number,
  rows: number,
  palette: Palette,
): { lines: string[]; cut: boolean } {
  const allowed = Math.min(MAX_STATUS_ROWS, 1 + Math.max(0, rows - CHROME_ROWS - BODY_ROWS_KEPT));
  const mode = state.mode;
  if (mode.kind === 'prompt') {
    const label = mode.account ? sanitizeForTerminal(mode.account.label) : '';
    const ask =
      mode.purpose === 'add'
        ? 'Label for the new account: '
        : mode.purpose === 'rename'
          ? `New label for ${label}: `
          : `Type ${label} to remove it: `;
    const prompt = promptLine(ask, sanitizeForTerminal(mode.input), cols, palette);
    if (mode.note === undefined) return { lines: [prompt], cut: false };
    // The prompt line above keeps the label as stored; the note is a message.
    const note = wrapWithin(messageText(mode.note), cols, Math.max(1, allowed - 1));
    return { lines: [...note.lines.map((l) => palette.yellow(l)), prompt], cut: note.cut };
  }
  const { text, paint } = statusText(state, palette);
  if (text === '') return { lines: [''], cut: false };
  const { lines, cut } = wrapWithin(text, cols, allowed);
  return { lines: lines.map((l) => paint(l)), cut };
}

/**
 * A prompt and its input in `cols` columns. The end of the input and the cursor are what the
 * person is typing, so they stay in view: a long input shows its tail (marked as cut), and an ask
 * too long for the line (a long label to confirm on a narrow terminal) gives way first.
 */
function promptLine(ask: string, input: string, cols: number, palette: Palette): string {
  const inputWidth = displayWidth(input) + 1; // the cursor
  const askWidth = displayWidth(ask);
  if (askWidth + inputWidth <= cols) return `${palette.bold(ask)}${input}_`;
  const reserve = Math.min(inputWidth, Math.max(10, Math.floor(cols / 3)));
  const askShown = clip(ask, Math.max(0, Math.min(askWidth, cols - reserve)));
  const room = cols - displayWidth(askShown) - 1;
  const inputShown =
    displayWidth(input) <= room ? input : `..${cutTail(input, Math.max(0, room - 2))}`;
  return `${palette.bold(askShown)}${inputShown}_`;
}

/** Key hints, each with how much it matters when the line is short: 1 always shows (help and
 *  quit, the way to everything else), higher numbers give way first. */
const ACCOUNT_HINTS: ReadonlyArray<readonly [string, number]> = [
  ['k/j move', 3],
  ['Enter switch', 2],
  ['e exclude', 4],
  ['r rename', 5],
  ['a add', 4],
  ['d remove', 5],
  ['u refresh', 3],
  ['l launch', 6],
  ['Tab pane', 2],
  ['? help', 1],
  ['q quit', 1],
];
const TEXT_PANE_HINTS: ReadonlyArray<readonly [string, number]> = [
  ['k/j scroll', 3],
  ['Tab pane', 2],
  ['a add', 4],
  ['u refresh', 3],
  ['? help', 1],
  ['q quit', 1],
];
const HINT_SEP = SEP;

/** The hints that fit in `cols`, most important first, shown in their usual order. */
function fittedHints(hints: ReadonlyArray<readonly [string, number]>, cols: number): string {
  const byPriority = [...hints.keys()].sort((a, b) => hints[a]![1] - hints[b]![1] || a - b);
  const kept = new Set<number>();
  let width = 0;
  for (const i of byPriority) {
    const add = displayWidth(hints[i]![0]) + (kept.size > 0 ? HINT_SEP.length : 0);
    if (width + add > cols) break;
    kept.add(i);
    width += add;
  }
  return hints
    .filter((_, i) => kept.has(i))
    .map(([text]) => text)
    .join(HINT_SEP);
}

/** Offered first when the status line had to cut its message. */
const CUT_MESSAGE_HINT: readonly [string, number] = ['m message', 1];
/** A prompt's hints; with a refusal cut short above it, how to read the refusal whole comes
 *  before the plain cancel, which gives way first on a narrow line. */
const PROMPT_HINTS: ReadonlyArray<readonly [string, number]> = [
  ['Enter confirm', 1],
  ['Esc cancel', 1],
];
const PROMPT_CUT_HINTS: ReadonlyArray<readonly [string, number]> = [
  ['Enter confirm', 1],
  ['Esc cancel', 2],
  ['Esc, then m: full note', 1],
];

/** The key hints for what the screen is doing now. `overflow`: an overlay is taller than the
 *  body, so it says how to scroll it. `cut`: the status line cut its message, so the key that
 *  shows it whole comes first. */
function hintsLine(
  state: TuiState,
  cols: number,
  palette: Palette,
  overflow: boolean,
  cut: boolean,
): string {
  const mode = state.mode;
  if (mode.kind === 'prompt') {
    if (mode.gone === true) return palette.dim('Esc close');
    // m types into the prompt, so a refusal cut short here is read whole after Esc, which leaves
    // it on the status line (see the reducer).
    const refusalCut = cut && mode.refusal !== undefined && mode.note === mode.refusal;
    return palette.dim(fittedHints(refusalCut ? PROMPT_CUT_HINTS : PROMPT_HINTS, cols));
  }
  // Enter does not close an overlay (see the reducer), so the hint names the key that does.
  const overlay = mode.kind === 'help' || mode.kind === 'message';
  if (overlay && overflow) return palette.dim(`k/j scroll${SEP}Esc: back`);
  if (overlay || mode.kind === 'launch') return palette.dim('Esc: back');
  const hints = state.pane === 'accounts' ? ACCOUNT_HINTS : TEXT_PANE_HINTS;
  // While an action runs every key but Ctrl-C waits, m included, so it is not offered then.
  const offerMessage = cut && state.busy === undefined;
  return palette.dim(fittedHints(offerMessage ? [CUT_MESSAGE_HINT, ...hints] : hints, cols));
}

/** The message overlay: the last message whole, wrapped to `cols`. */
function messageBody(state: TuiState, cols: number): string[] {
  return wrap(messageText(lastMessage(state) ?? ''), cols);
}

/** The help overlay, wrapped to `cols` (a description continues under itself rather than being
 *  cut at the edge). Taller than the body, it scrolls. */
function helpBody(palette: Palette, cols: number): string[] {
  const width = Math.max(...KEY_HELP.map(([k]) => k.length));
  const room = Math.max(10, cols - width - 4);
  const keys = KEY_HELP.flatMap(([key, what]) =>
    wrap(what, room).map((line, i) =>
      i === 0 ? `  ${palette.bold(key.padEnd(width))}  ${line}` : `  ${' '.repeat(width)}  ${line}`,
    ),
  );
  const notes = [
    'Usage is read from the daemon (it polls); nothing here calls Anthropic directly.',
    'A reset marked ~ is predicted from history, not reported by the endpoint.',
  ].flatMap((n) => wrap(n, cols).map((l) => palette.dim(l)));
  return [palette.bold('Keys'), ...keys, '', ...notes];
}

/** The launch overlay: the line that runs Claude as `label`, to paste in another terminal. The
 *  label is quoted the way every command cctl prints quotes one, for this platform's shell. */
function launchBody(
  label: string,
  platform: NodeJS.Platform,
  palette: Palette,
  cols: number,
): string[] {
  const quoted = shellQuote(label, platform);
  // A command is pasted whole or not at all: one too wide for the terminal is marked as cut (and
  // said so), never left to look complete with its closing quote gone.
  const room = cols - 2;
  const commands = [`claude --account ${quoted}`, `cctl claude --account ${quoted}`];
  const cut = commands.some((c) => displayWidth(c) > room);
  const [plain, wrapped] = commands.map((c) => (displayWidth(c) > room ? clip(c, room) : c));
  return [
    `To run Claude as ${palette.bold(sanitizeForTerminal(label))}, paste this in another terminal:`,
    '',
    `  ${palette.bold(plain!)}`,
    '',
    palette.dim('That form needs the claude wrapper from `cctl shell-init`. Without it:'),
    `  ${wrapped!}`,
    ...(cut ? ['', palette.yellow('Cut short - widen the terminal to copy the whole line.')] : []),
  ];
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

/**
 * Draw the whole screen. Below {@link MIN_COLS} columns or {@link MIN_ROWS} rows the frame is one
 * line saying so (and blank lines under it), since no layout fits.
 */
export function renderFrame(
  state: TuiState,
  cols: number,
  rows: number,
  palette: Palette,
): string[] {
  const height = Math.max(0, rows);
  if (isFrameTooSmall(cols, rows)) {
    const notice =
      cols < MIN_COLS
        ? `Terminal too narrow: widen it to ${MIN_COLS} columns (q quits).`
        : `Terminal too short: make it ${MIN_ROWS} rows tall (q quits).`;
    // Wrapped, so the way out (q) is never cut off; in a terminal too small even for that, the
    // short form, and then the way out alone.
    let lines = wrap(notice, cols);
    if (lines.length > height) lines = wrap('Too small: q quits', cols);
    if (lines.length > height) lines = wrap('q quits', cols);
    const shown = lines.slice(0, height);
    return [...shown, ...Array<string>(Math.max(0, height - shown.length)).fill('')];
  }
  const status = statusLines(state, cols, rows, palette);
  const bodyRows = bodyHeight(rows) - (status.lines.length - 1);
  let body: string[];
  let overflow = false;
  if (state.mode.kind === 'help' || state.mode.kind === 'message') {
    const lines = state.mode.kind === 'help' ? helpBody(palette, cols) : messageBody(state, cols);
    overflow = lines.length > bodyRows;
    const start = Math.min(state.mode.scroll, maxScroll(lines.length, bodyRows));
    body = lines.slice(start, start + bodyRows);
  } else if (state.mode.kind === 'launch') {
    body = launchBody(state.mode.label, state.platform, palette, cols);
  } else if (state.pane === 'accounts') body = accountsBody(state, cols, bodyRows, palette);
  else {
    const lines = paneLines(state, state.pane, palette, cols);
    const start = Math.min(state.scroll[state.pane], maxScroll(lines.length, bodyRows));
    body = lines.slice(start, start + bodyRows);
  }
  const padded = [...body.slice(0, bodyRows)];
  while (padded.length < bodyRows) padded.push('');
  return [
    headerLine(state, palette),
    tabsLine(state, palette),
    ...padded,
    ...status.lines,
    hintsLine(state, cols, palette, overflow, status.cut),
  ].map((line) => {
    // Whatever a pane renderer was handed (a session label, an error from a file), only color
    // reaches the terminal: no cursor move, screen switch, title write or carriage return.
    const safe = keepColorOnly(line);
    return visibleWidth(safe) > cols ? truncateAnsi(safe, cols) : safe;
  });
}
