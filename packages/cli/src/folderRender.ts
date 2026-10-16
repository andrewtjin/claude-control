// Pure rendering for the folder-rule views: `cctl folders`, `cctl where`, the per-folder section of
// `cctl usage` / `cctl timeline`, and the reserved-accounts section of `cctl accounts list`.
//
// Kept apart from the IO in folderCommands.ts so the exact output is unit-tested. Every folder path
// and account label rendered here is operator- or filesystem-supplied, so each goes through
// sanitizeForTerminal before it reaches the terminal (see ansi.ts): a label carrying an ANSI or bidi
// escape can neither recolor the surface nor reorder a path.

import {
  CLAUDE_CODE_TITLE_MAX_LENGTH,
  aliasFitsSessionTitle,
  shellQuoteArg,
} from '@claude-control/switch-engine';
import { PLAIN_PALETTE, sanitizeForTerminal, type Palette } from './ansi.js';

/** Where an account of a folder's pool comes from: the rule's own included accounts, or the shared
 *  pool every folder inherits. */
export type PoolSourceView = 'include' | 'inherited';

/** One account of a slot's effective pool, in pool order, as the folder views show it. */
export interface PoolEntryView {
  label: string;
  source: PoolSourceView;
  /** Live in THIS slot right now. */
  live: boolean;
  /** The other slot it is live in, already worded ("the global slot"), or null. An account live
   *  elsewhere is in the pool but cannot be taken: no account is live in two places. */
  liveElsewhere: string | null;
  /** A dead login: never used until re-logged in. */
  quarantined: boolean;
  /** False for a shared account excluded from auto-switch: usable by hand, never picked unattended. */
  autoTarget: boolean;
}

/** The account live in a slot and how it got there. `outside` is a login the slot's pool does not
 *  hold (left behind by an older build, or a rule edited under it); the daemon moves it off. */
export interface SlotLiveView {
  label: string;
  source: PoolSourceView | 'outside';
  quarantined: boolean;
}

/** One folder rule for display. */
export interface FolderRuleView {
  label: string;
  folders: string[];
  /** Session-alias scopes (the alias as the rule holds it, in its exact folder); absent when none. */
  aliases?: { folder: string; alias: string }[];
  /** Labels of the included (reserved) accounts, in preference order. */
  include: string[];
  /** Labels of the shared accounts the folder must not use. */
  exclude: string[];
  /** The account live in the rule's slot, or null when the slot holds none. */
  live: SlotLiveView | null;
  pool: PoolEntryView[];
  profileDir: string;
}

/** The global slot, which every folder without a rule runs on. */
export interface GlobalSlotView {
  live: SlotLiveView | null;
  pool: PoolEntryView[];
}

/** The guard snapshot's freshness and the enforcement mode, shown under `cctl folders`. Freshness is
 *  judged by the guard-relevant CONTENT of the snapshot (folders, profile dirs, included labels,
 *  enforce), not the rules generation, which also bumps on a routine switch the guard never sees. */
export interface FolderGuardFooterView {
  /** Whether a guard snapshot exists at all. */
  present: boolean;
  /** Whether the snapshot's guard-relevant content matches the live registry. */
  fresh: boolean;
  enforce: 'block' | 'warn' | 'off';
}

/** The words after a pool entry: where it comes from (in a folder's pool only: the global pool is
 *  all shared accounts, so there it would say nothing), then everything that limits it. */
function poolEntryNotes(e: PoolEntryView, showSource: boolean): string[] {
  const notes: string[] = showSource ? [e.source === 'include' ? 'included' : 'inherited'] : [];
  if (e.live) notes.push('live here');
  if (e.liveElsewhere !== null) notes.push(`live in ${sanitizeForTerminal(e.liveElsewhere)}`);
  // A dead login is never a target anyway; saying so twice adds nothing.
  if (e.quarantined) notes.push('quarantined');
  else if (!e.autoTarget) notes.push('not an auto-switch target');
  return notes;
}

/** Paint an entry by what it means for the slot: green live here, red dead, dim unavailable. */
function paintEntry(e: PoolEntryView, palette: Palette): (text: string) => string {
  if (e.live) return palette.green;
  if (e.quarantined) return palette.red;
  if (e.liveElsewhere !== null) return palette.dim;
  return (t) => t;
}

/** Whether anything in the pool could be seated right now. */
function anyAvailable(pool: readonly PoolEntryView[]): boolean {
  return pool.some((e) => !e.quarantined && e.liveElsewhere === null);
}

/** An empty pool in words. A folder's pool is emptied by its own excludes or by other folders
 *  reserving what it inherits; the global pool only by folders reserving every account. */
function emptyPoolWords(slot: 'global' | 'rule'): string {
  return slot === 'global'
    ? 'nothing (every account is reserved to a folder)'
    : 'nothing (every account it could use is excluded by its rule or reserved to other folders)';
}

/**
 * Why a slot has no account it can use, from its pool, ending in the fix that applies: a pool that
 * is empty, accounts live in another slot (free that slot), or logins that expired (re-login one).
 * A re-login is suggested only for a login that actually expired.
 */
export function nothingUsableReason(
  pool: readonly PoolEntryView[],
  slot: 'global' | 'rule' = 'rule',
): string {
  if (pool.length === 0) {
    return slot === 'global'
      ? 'its pool is empty: every account is reserved to a folder'
      : 'its pool is empty: every account it could use is excluded by its rule or reserved to ' +
          'other folders (cctl folder reset <folder> <account> lets an excluded one back in)';
  }
  const parts: string[] = [];
  const held = pool.filter((e) => !e.quarantined && e.liveElsewhere !== null);
  if (held.length > 0) {
    const where = held.map(
      (e) =>
        `${sanitizeForTerminal(e.label)} is live in ${sanitizeForTerminal(e.liveElsewhere ?? '')}`,
    );
    parts.push(`${where.join(', ')}; switch that slot to another account to free it`);
  }
  const dead = pool.filter((e) => e.quarantined);
  if (dead.length > 0) {
    const names = dead.map((e) => sanitizeForTerminal(e.label));
    parts.push(
      `the login of ${names.join(', ')} expired; re-login one: ` +
        `cctl accounts relogin ${shellQuote(names[0]!)}`,
    );
  }
  return parts.join('; ');
}

/** The pool in order, one numbered account per line, every limit spelled out. `indent` is the
 *  column the first line's label is already at, so continuation lines align under it. The global
 *  slot's pool names no sources: every account in it is shared. */
function poolLines(
  pool: readonly PoolEntryView[],
  palette: Palette,
  indent: number,
  slot: 'global' | 'rule' = 'rule',
): string[] {
  const showSource = slot === 'rule';
  if (pool.length === 0) return [emptyPoolWords(slot)];
  const width = String(pool.length).length;
  return pool.map((e, i) => {
    const n = `${String(i + 1).padStart(width)}.`;
    const notes = poolEntryNotes(e, showSource);
    const text = `${n} ${sanitizeForTerminal(e.label)}${notes.length > 0 ? `  ${notes.join(', ')}` : ''}`;
    return (i === 0 ? '' : ' '.repeat(indent)) + paintEntry(e, palette)(text);
  });
}

/** The pool on one line, for the compact per-folder section: the live one starred, and only the
 *  limits that make an account unavailable named. */
function poolInline(pool: readonly PoolEntryView[], palette: Palette): string {
  if (pool.length === 0) return emptyPoolWords('rule');
  return pool
    .map((e) => {
      const notes: string[] = [];
      if (e.liveElsewhere !== null) notes.push(`live in ${sanitizeForTerminal(e.liveElsewhere)}`);
      if (e.quarantined) notes.push('quarantined');
      else if (!e.autoTarget) notes.push('not an auto-switch target');
      const name = (e.live ? '*' : '') + sanitizeForTerminal(e.label);
      const text = notes.length > 0 ? `${name} (${notes.join(', ')})` : name;
      return paintEntry(e, palette)(text);
    })
    .join(', ');
}

/** Which kind of slot a live line describes: the global slot, or a folder slot with or without
 *  included accounts (an inherited account there means something different in each). */
export type SlotKind = 'global' | 'rule-with-includes' | 'rule';

/** The slot kind of a rule view. */
function ruleSlotKind(view: Pick<FolderRuleView, 'include'>): SlotKind {
  return view.include.length > 0 ? 'rule-with-includes' : 'rule';
}

/** The live line's value: who is live and why, or why nobody is. An empty slot with something
 *  available is merely not seated yet (the daemon or `cctl claude` seats it); with nothing available
 *  it is a real outage for that folder. */
export function describeSlotLive(
  live: SlotLiveView | null,
  pool: readonly PoolEntryView[],
  slot: SlotKind,
  palette: Palette = PLAIN_PALETTE,
): string {
  if (live === null) {
    return anyAvailable(pool)
      ? 'none yet (cctl claude or the daemon seats the first available account)'
      : palette.red(
          `none usable (${nothingUsableReason(pool, slot === 'global' ? 'global' : 'rule')})`,
        );
  }
  const name = sanitizeForTerminal(live.label);
  if (live.quarantined) {
    return palette.red(
      `${name} (quarantined; re-login it: cctl accounts relogin ${shellQuote(name)})`,
    );
  }
  if (live.source === 'outside') {
    return palette.yellow(`${name} (not in this pool any more; the daemon moves the slot off it)`);
  }
  if (live.source === 'include') return palette.green(`${name} (included)`);
  if (slot === 'global') return palette.green(name);
  // An inherited account in a folder that includes some means every included one is out.
  return palette.green(
    slot === 'rule-with-includes'
      ? `${name} (inherited from the shared pool: no included account is available)`
      : `${name} (inherited from the shared pool)`,
  );
}

/** The labels as a list, or what an empty list means for the rule. */
function labelList(labels: readonly string[], empty: string): string {
  return labels.length === 0 ? empty : labels.map((l) => sanitizeForTerminal(l)).join(', ');
}

/** The lines every full rule view shares (`cctl folders`, `cctl where`): includes, excludes, live,
 *  pool. Labels are padded to one column. */
function ruleBodyLines(view: FolderRuleView, palette: Palette): string[] {
  return [
    `  includes: ${labelList(view.include, 'nothing (no account is reserved to it)')}`,
    `  excludes: ${labelList(view.exclude, 'nothing')}`,
    `  live:     ${describeSlotLive(view.live, view.pool, ruleSlotKind(view), palette)}`,
    `  pool:     ${poolLines(view.pool, palette, 12).join('\n')}`,
  ];
}

/** A rule's session-alias scope lines. An alias scope covers one named session recorded in exactly
 *  that folder (not its subfolders). One no session title can carry — longer than Claude Code keeps
 *  a session name, or not well-formed text (only a hand edit stores one) — can never match a
 *  session: said so, since it silently applies to nothing. */
function aliasScopeLines(view: Pick<FolderRuleView, 'aliases'>, palette: Palette): string[] {
  return (view.aliases ?? []).map(
    (a) =>
      `  session:  "${sanitizeForTerminal(a.alias)}" in ${sanitizeForTerminal(a.folder)}` +
      (aliasFitsSessionTitle(a.alias)
        ? ''
        : '  ' +
          palette.yellow(
            `(never matches: no session title can carry it — longer than ` +
              `${CLAUDE_CODE_TITLE_MAX_LENGTH} characters, or not well-formed text; reset it)`,
          )),
  );
}

/** One rule in full: its folders and session aliases, what it includes and excludes, the live
 *  account, the effective pool in order with availability, and its profile dir. */
export function renderFolderRule(view: FolderRuleView, palette: Palette = PLAIN_PALETTE): string {
  return [
    palette.bold(sanitizeForTerminal(view.label)),
    ...view.folders.map((f) => `  folder:   ${sanitizeForTerminal(f)}`),
    ...aliasScopeLines(view, palette),
    ...ruleBodyLines(view, palette),
    `  profile:  ${palette.dim(sanitizeForTerminal(view.profileDir))}`,
  ].join('\n');
}

/** The global slot in the same shape, so `cctl folders` also says what every other folder runs on. */
export function renderGlobalSlot(view: GlobalSlotView, palette: Palette = PLAIN_PALETTE): string {
  return [
    palette.bold('every other folder (the global slot)'),
    `  live:     ${describeSlotLive(view.live, view.pool, 'global', palette)}`,
    `  pool:     ${poolLines(view.pool, palette, 12, 'global').join('\n')}`,
  ].join('\n');
}

/** What each enforcement mode does, in the few words `cctl folders` and `cctl doctor` print beside
 *  it. In a ruled folder the guard judges only a session on the wrong slot for that folder: the
 *  global slot's account is accepted unless the rule rules it out (excluded, or reserved to other
 *  folders), and a session on another folder's slot is out of place. */
export function describeEnforceMode(mode: 'block' | 'warn' | 'off'): string {
  switch (mode) {
    case 'block':
      return "refuses a session on an account a folder's rule rules out, or on another folder's slot";
    case 'warn':
      return 'flags those sessions, refuses none';
    case 'off':
      return 'no check';
  }
}

export function renderFolderGuardFooter(
  view: FolderGuardFooterView,
  palette: Palette = PLAIN_PALETTE,
): string {
  const enforceLine = `enforcement: ${view.enforce} (${describeEnforceMode(view.enforce)})`;
  let freshness: string;
  if (!view.present) {
    freshness = palette.yellow(
      'guard snapshot: missing (the guard cannot enforce until the daemon writes it, or a ' +
        'cctl folder change does)',
    );
  } else if (view.fresh) {
    freshness = 'guard snapshot: fresh';
  } else {
    freshness = palette.yellow(
      'guard snapshot: STALE (the guard is enforcing an out-of-date view of the folder rules); ' +
        'restart the daemon to refresh it: cctl daemon restart',
    );
  }
  return `${enforceLine}\n${freshness}`;
}

/** The hint every empty view ends on: both ways to give a folder a rule, and the way to give a named
 *  session one. */
export const ADD_FOLDER_RULE_HINT =
  'Add one with: cctl folder include <folder> <account>[,<account>...]\n' +
  '          or: cctl folder exclude <folder> <account>[,<account>...]\n' +
  'For one named session: cctl session include <alias> <account>[,<account>...]';

/** The full `cctl folders` view: every rule, the global slot, then the guard footer. */
export function renderFolders(
  input: { rules: FolderRuleView[]; global: GlobalSlotView; footer: FolderGuardFooterView },
  palette: Palette = PLAIN_PALETTE,
): string {
  if (input.rules.length === 0) {
    return (
      'No folder rules: every folder uses the global slot and the shared pool.\n' +
      ADD_FOLDER_RULE_HINT
    );
  }
  return [
    ...input.rules.map((r) => renderFolderRule(r, palette)),
    renderGlobalSlot(input.global, palette),
    renderFolderGuardFooter(input.footer, palette),
  ].join('\n\n');
}

/** The compact per-folder section `cctl usage` and `cctl timeline` end on: each rule's folders, the
 *  account live in its slot, and its pool on one line. '' when there are no rules. */
export function renderFolderRulesSection(
  rules: readonly FolderRuleView[],
  palette: Palette = PLAIN_PALETTE,
): string {
  if (rules.length === 0) return '';
  const blocks = rules.map((r) =>
    [
      `${palette.bold(sanitizeForTerminal(r.label))}  ${palette.dim(
        [
          ...r.folders.map((f) => sanitizeForTerminal(f)),
          ...(r.aliases ?? []).map(
            (a) => `session "${sanitizeForTerminal(a.alias)}" in ${sanitizeForTerminal(a.folder)}`,
          ),
        ].join(', '),
      )}`,
      `  live: ${describeSlotLive(r.live, r.pool, ruleSlotKind(r), palette)}`,
      `  pool: ${poolInline(r.pool, palette)}`,
    ].join('\n'),
  );
  return 'Folder rules (cctl folders for detail):\n' + blocks.join('\n');
}

/** One account reserved to folder rules, for the section under `cctl accounts list`. */
export interface ReservedAccountView {
  id: string;
  label: string;
  email: string | undefined;
  /** The PLAN cell, as the shared table renders it (`planLabel`). */
  plan: string;
  /** The BILLING cell, as the shared table renders it (`billingLabel`). */
  billing: string;
  quarantined: boolean;
  /** Live in one of its folders' slots right now. */
  live: boolean;
  /** The folders of each rule that includes it, one string per rule. */
  includedBy: string[];
}

/** The reserved accounts as an aligned table: they are not in the shared table above it, and each
 *  is usable only in the folders that include it, which the last-but-one column names. Its first
 *  columns match the shared table's, so a reserved account shows its plan and billing as any other
 *  account does. '' when no account is reserved. */
export function renderReservedAccounts(
  rows: readonly ReservedAccountView[],
  palette: Palette = PLAIN_PALETTE,
): string {
  if (rows.length === 0) return '';
  const cells = rows.map((r) => ({
    live: r.live ? '*' : ' ',
    label: sanitizeForTerminal(r.label),
    email: sanitizeForTerminal(r.email ?? '-'),
    plan: sanitizeForTerminal(r.plan),
    billing: sanitizeForTerminal(r.billing),
    status: r.quarantined ? 'quarantined' : 'ok',
    includedBy: r.includedBy.map((f) => sanitizeForTerminal(f)).join('; '),
    id: sanitizeForTerminal(r.id),
  }));
  const headers = {
    live: ' ',
    label: 'LABEL',
    email: 'EMAIL',
    plan: 'PLAN',
    billing: 'BILLING',
    status: 'STATUS',
    includedBy: 'INCLUDED BY',
    id: 'ID',
  };
  type Cells = typeof headers;
  const keys = Object.keys(headers) as (keyof Cells)[];
  const width = (k: keyof Cells): number =>
    Math.max(headers[k].length, ...cells.map((c) => c[k].length));
  const padded = (c: Cells): string[] => keys.map((k) => c[k].padEnd(width(k)));
  // Pad first, paint after: ANSI codes are zero-width, so alignment survives.
  const line = (c: Cells): string => {
    const [live, label, email, plan, billing, status, includedBy, id] = padded(c);
    return [
      palette.green(live ?? ''),
      palette.bold(label ?? ''),
      email ?? '',
      plan ?? '',
      palette.dim(billing ?? ''),
      c.status === 'quarantined' ? palette.red(status ?? '') : (status ?? ''),
      includedBy ?? '',
      palette.dim(id ?? ''),
    ]
      .join('  ')
      .trimEnd();
  };
  return [
    'Reserved to folder rules (used only in the folders that include them; * = live there):',
    palette.dim(padded(headers).join('  ').trimEnd()),
    ...cells.map(line),
  ].join('\n');
}

/** What `cctl where` explains for a folder: the rule that applies (longest match, no merging) or,
 *  without one, the global slot. */
export interface WhereView {
  /** The canonical folder queried. */
  folder: string;
  /** The rule it resolves to and the rule folder that matched, or null for the global slot, with
   *  the VS Code profile it gets among every rule (see {@link vscodeProfileNames}; absent, the
   *  name its label alone gives). */
  rule: (FolderRuleView & { matchedFolder: string; vscodeProfile?: string }) | null;
  global: GlobalSlotView;
  /** Named sessions with a rule of their own in EXACTLY this folder: they outrank the folder's rule
   *  above. */
  aliases?: WhereAliasView[];
  /** The folder asked about is not the current directory. `cctl claude` finds a named session in
   *  the folder it runs in, so a command printed for one here must change to this folder first. */
  elsewhere?: boolean;
}

/** One named session with a rule of its own in the queried folder, for `cctl where`. */
export interface WhereAliasView {
  /** The alias as the rule holds it. */
  alias: string;
  ruleLabel: string;
  /** Labels of the rule's included accounts. */
  include: string[];
  /** Labels of the shared accounts it excludes. */
  exclude: string[];
  /** The account live in the rule's slot, or null. */
  liveLabel: string | null;
}

/** The `cctl where` section naming the sessions with a rule of their own in the folder, or [] when
 *  none. */
function whereAliasLines(view: WhereView, palette: Palette, platform: NodeJS.Platform): string[] {
  const aliases = view.aliases ?? [];
  if (aliases.length === 0) return [];
  const cd =
    view.elsewhere === true ? `cd ${shellQuote(sanitizeForTerminal(view.folder), platform)}; ` : '';
  const lines = [
    '',
    'Named sessions with a rule of their own here (they outrank any folder rule):',
  ];
  for (const a of aliases) {
    const alias = sanitizeForTerminal(a.alias);
    const uses =
      a.include.length > 0
        ? `uses ${a.include.map((m) => sanitizeForTerminal(m)).join(', ')} first`
        : 'uses the shared pool';
    const excludes =
      a.exclude.length > 0
        ? `, excludes ${a.exclude.map((m) => sanitizeForTerminal(m)).join(', ')}`
        : '';
    const live = a.liveLabel ? sanitizeForTerminal(a.liveLabel) : 'none usable';
    lines.push(
      `  "${alias}" -> ${palette.bold(sanitizeForTerminal(a.ruleLabel))} (${uses}${excludes}), live: ${live}`,
    );
    lines.push(`    resume it with: ${cd}${resumeCommand(a.alias, { platform })}`);
    const start = startCommand(a.alias, platform);
    if (start !== null) lines.push(`    start it with:  ${cd}${start}`);
  }
  return lines;
}

/** The command that starts a NEW session under `alias` (`--resume` only opens an existing one), or
 *  null for an alias a terminal could not show verbatim, which cannot be printed as a working
 *  argument. */
function startCommand(alias: string, platform: NodeJS.Platform): string | null {
  const text = alias.trim();
  return text !== '' && sanitizeForTerminal(text) === text
    ? `cctl claude --name ${shellQuoteArg(text, platform)}`
    : null;
}

/** Quote one argument so it pastes into the operator's shell as a single literal word: PowerShell
 *  single quotes (every single-quote character doubled) on Windows, POSIX single quotes (`'\''`)
 *  elsewhere. Single quotes because nothing inside them expands in either shell — a folder, label or
 *  session alias may hold `$`, a backtick or a double quote. The rule itself is switch-engine's
 *  shellQuoteArg, the same function the enforcement guard embeds, so a command the CLI prints and one
 *  the guard prints can never quote differently. */
export function shellQuote(value: string, platform: NodeJS.Platform = process.platform): string {
  return shellQuoteArg(value, platform);
}

/**
 * The command that resumes a named session on the accounts its rule names, safe to paste: the FULL
 * alias as one single-quoted literal for the operator's shell (switch-engine's shellQuoteArg:
 * PowerShell on Windows, POSIX elsewhere — the same quoting the enforcement guard prints), trimmed
 * the way `claude --resume` trims it. Display text around it may be shortened; this never is. An
 * alias a terminal could not show verbatim (one carrying a control or bidi character — a title read
 * from a transcript, never an alias a rule holds, which the engine refuses) cannot be printed as a
 * working argument, so the session id is used instead when the caller has it, else the bare picker
 * form.
 */
export function resumeCommand(
  alias: string,
  opts: { sessionId?: string; platform?: NodeJS.Platform } = {},
): string {
  const platform = opts.platform ?? process.platform;
  const text = alias.trim();
  if (text !== '' && sanitizeForTerminal(text) === text) {
    return `cctl claude --resume ${shellQuoteArg(text, platform)}`;
  }
  const id = opts.sessionId;
  return id !== undefined && /^[0-9a-f-]{8,64}$/i.test(id)
    ? `cctl claude --resume ${id}`
    : 'cctl claude --resume';
}

/** A session id as Claude Code writes it (a UUID): paste-safe with no quoting at all. */
const SESSION_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The command that resumes ONE known session on its rule's accounts: by its id, which names exactly
 * that conversation — its alias may be shared by other sessions Claude Code's title search reaches,
 * and then `--resume <alias>` reopens the picker and the launcher can route the pick only by the
 * folder rule. The enforcement guard prints the same form. Falls back to {@link resumeCommand} when
 * the id is not a well-formed session id.
 */
export function resumeSessionCommand(
  sessionId: string,
  alias: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return SESSION_UUID.test(sessionId)
    ? `cctl claude --resume ${sessionId}`
    : resumeCommand(alias, { platform });
}

/** The VS Code profile name `cctl where` suggests for a folder rule: `cctl-<label>`, reduced to
 *  letters, digits, `.`, `_` and `-` so it is one plain word in any shell and in VS Code's UI. */
export function vscodeProfileName(ruleLabel: string): string {
  const slug = ruleLabel.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return `cctl-${slug === '' ? 'folder' : slug}`;
}

/**
 * The VS Code profile each rule gets, by rule id. Reducing labels to plain words can give two rules
 * one name (`my app` and `my-app`, or two labels of only non-ASCII letters), and one VS Code profile
 * holds one CLAUDE_CONFIG_DIR, so sharing it would point one folder's window at the other's slot.
 * The rule made first keeps the plain name (a profile already set up for it stays right); every
 * later rule with that name gets the first eight letters and digits of its id appended.
 */
export function vscodeProfileNames(
  rules: ReadonlyArray<{ id: string; label: string; createdAtMs: number }>,
): Map<string, string> {
  const byName = new Map<string, Array<{ id: string; createdAtMs: number }>>();
  for (const r of rules) {
    const name = vscodeProfileName(r.label);
    byName.set(name, [...(byName.get(name) ?? []), r]);
  }
  const out = new Map<string, string>();
  for (const [name, holders] of byName) {
    const first = [...holders].sort(
      (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id),
    )[0]!;
    for (const r of holders) {
      const suffix = r.id.replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
      out.set(r.id, r.id === first.id ? name : `${name}-${suffix}`);
    }
  }
  return out;
}

/** What happens to a session started here on the global slot (a plain `claude` without the
 *  wrapper): the folder accepts the global slot's account unless its rule excludes it, and a rule
 *  that includes accounts gets its background sessions moved onto its own slot. */
function globalSlotHere(rule: Pick<FolderRuleView, 'include' | 'exclude'>): string {
  const accepted =
    rule.exclude.length > 0
      ? `a session on the global slot is accepted unless it is on ${labelList(rule.exclude, '')}`
      : 'a session on the global slot is accepted';
  return rule.include.length > 0
    ? `${accepted}; cctl moves background sessions onto ${labelList(rule.include, '')} between turns`
    : accepted;
}

/** Explain which slot a folder runs on, its rule, live account and pool in order, print the env line
 *  a session needs, and how to point the VS Code Claude Code extension at that slot (a VS Code
 *  profile holding the claudeCode.environmentVariables setting). */
export function renderWhere(
  view: WhereView,
  palette: Palette = PLAIN_PALETTE,
  platform: NodeJS.Platform = process.platform,
): string {
  const folder = sanitizeForTerminal(view.folder);
  const quoted = shellQuote(folder, platform);
  if (view.rule === null) {
    return [
      `${palette.bold(folder)}`,
      '  runs on: the global slot and the shared pool (no folder rule applies here)',
      `  live:    ${describeSlotLive(view.global.live, view.global.pool, 'global', palette)}`,
      `  pool:    ${poolLines(view.global.pool, palette, 11, 'global').join('\n')}`,
      '  env:     CLAUDE_CONFIG_DIR is not set (the global slot)',
      '',
      // Quoted like the VS Code command below: these are pasted, and a folder may hold spaces.
      `Give this folder its own rule with: cctl folder include ${quoted} <account>[,<account>...]`,
      `                                or: cctl folder exclude ${quoted} <account>[,<account>...]`,
      ...whereAliasLines(view, palette, platform),
    ].join('\n');
  }
  const r = view.rule;
  const profile = sanitizeForTerminal(r.profileDir);
  // The extension's setting is declared as a list of {name, value} pairs (its default is []), so
  // that is the shape printed. The setting is MACHINE-scoped: VS Code ignores it in a folder's or
  // workspace's .vscode/settings.json (it only greys the line out), and reads it from user settings
  // only. Per-folder routing therefore needs a VS Code profile whose user settings carry it — one
  // profile per folder rule, opened on its folder.
  const vscodeSnippet = JSON.stringify(
    { 'claudeCode.environmentVariables': [{ name: 'CLAUDE_CONFIG_DIR', value: r.profileDir }] },
    null,
    2,
  );
  const profileName = r.vscodeProfile ?? vscodeProfileName(r.label);
  const openCommand = `code --profile ${shellQuote(profileName, platform)} ${quoted}`;
  return [
    `${palette.bold(folder)}`,
    `  runs on:  the folder rule ${palette.bold(sanitizeForTerminal(r.label))}, in its own slot`,
    `  matched:  ${sanitizeForTerminal(r.matchedFolder)} (the longest matching rule wins; rules do not merge)`,
    ...ruleBodyLines(r, palette),
    `  env:      CLAUDE_CONFIG_DIR=${profile}`,
    `  global:   ${globalSlotHere(r)}`,
    '',
    'Start Claude Code here with the right account using: cctl claude',
    '(or install the wrapper once: cctl shell-init powershell)',
    '',
    'For VS Code: the Claude Code extension reads its environment from USER settings only (a',
    "folder's .vscode/settings.json is ignored), so give this folder rule its own VS Code profile:",
    `  1. ${openCommand}`,
    '     (creates the profile the first time; install or enable Claude Code in it)',
    '  2. in that window run "Preferences: Open User Settings (JSON)" and add:',
    vscodeSnippet,
    `  3. open this folder with the same command from then on. Other windows keep the global slot.`,
    ...whereAliasLines(view, palette, platform),
  ].join('\n');
}
