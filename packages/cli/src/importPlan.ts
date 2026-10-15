// The import planner: given an opened export and what this machine already holds, decide what
// `cctl import` will do with every account, rule scope and setting — before anything is written.
//
// Pure. It reads only its inputs (the folder check is passed in), so every collision rule is
// testable without a vault, and `--dry-run` prints exactly the plan the real run then executes.
// The executor (accountTransfer.ts) carries the plan out one engine call at a time and reports
// what actually happened; the one decision deferred to it is `--replace`'s "is the file's copy
// newer", which needs the decrypted stored bundle and so is made by the engine under its lock.

import {
  aliasScopeUniquenessKey,
  exactAliasRule,
  exactFolderRule,
  folderUniquenessKey,
  sanitizeTerminalText,
  type AccountView,
  type FolderRule,
} from '@claude-control/switch-engine';
import type { ExportPayload, ExportedAccount } from './exportPayload.js';
import { checkSettingValue, findDaemonEnvSetting, type DaemonFileConfig } from './settings.js';

/** What the import does with one account of the file. */
export type AccountStep =
  /** Store it as a new account under `label` (the file's label, numbered when taken here). With
   *  `withTokens` false it is stored waiting for a login. */
  | { kind: 'add'; entry: number; label: string; renamedFrom?: string; withTokens: boolean }
  /** The same login is already stored here as `existing`; it is left as it is. */
  | { kind: 'skip'; entry: number; existing: AccountView; reason: string }
  /** The same login is already stored here as `existing`; its credentials are replaced by the
   *  file's when the file's are newer or the stored login is quarantined (`--replace`). */
  | { kind: 'replace'; entry: number; existing: AccountView };

/** A rule member as the plan resolved it: an account of the file (by index) or one already stored
 *  here (by id), with the label it is shown by. */
export interface MemberTarget {
  label: string;
  entry?: number;
  existingId?: string;
}

/** One scope of a rule from the file, and what the import does with it. */
export interface ScopeStep {
  kind: 'folder' | 'alias';
  /** The folder as the file names it. */
  sourceFolder: string;
  /** The folder as it is canonically spelled here; absent when it does not exist here. */
  folder?: string;
  alias?: string;
  /** The rule's display name, passed when this scope creates the first rule from its source rule
   *  and the name is not just the default. */
  ruleLabel?: string;
  include: MemberTarget[];
  exclude: MemberTarget[];
  /** Members of the source rule that name no account of the file nor of this machine. */
  dropped: string[];
  /** Why the scope is not created, when it is not. */
  skip?: string;
}

/** What the import does with one setting. */
export type SettingStep =
  | { kind: 'set'; name: string; value: string; previous?: string }
  | { kind: 'same'; name: string; value: string }
  | { kind: 'skip'; name: string; reason: string };

/** The whole plan. */
export interface ImportPlan {
  accounts: AccountStep[];
  scopes: ScopeStep[];
  settings: SettingStep[];
  /** Facts about the file worth saying before the plan (another platform, and so on). */
  notes: string[];
}

/** Everything the planner reads. */
export interface PlanInput {
  payload: ExportPayload;
  /** Every account stored here, shared and reserved. */
  accounts: readonly AccountView[];
  /** Every rule here. */
  rules: readonly FolderRule[];
  /** The persisted settings here. */
  config: DaemonFileConfig | undefined;
  /** `--replace`. */
  replace: boolean;
  platform: NodeJS.Platform;
  /** The folder as canonically spelled here when it exists as a directory, else undefined. */
  resolveFolder: (folder: string) => string | undefined;
  /** Why rules cannot be written right now (an older daemon is running), by scope kind. */
  rulesBlocked?: { folder?: string; alias?: string };
}

/** The relay's setting name; its value lives in its own field of config.json. */
const RELAY = 'CCTL_RELAY_URL';

/** The login an entry belongs to: the uuid recorded with it, else the one its tokens name. */
function loginOf(entry: ExportedAccount): string | undefined {
  const fromBundle = entry.bundle?.oauthAccount?.accountUuid;
  return entry.accountUuid ?? (typeof fromBundle === 'string' ? fromBundle : undefined);
}

/**
 * The account already stored here that `entry` is: the same login (uuid). An entry with no login
 * recorded can only be matched by email, and only against a row that has no login either — two
 * rows with the same address but different logins are different accounts.
 */
function existingFor(
  entry: ExportedAccount,
  accounts: readonly AccountView[],
): AccountView | undefined {
  const login = loginOf(entry);
  if (login !== undefined) return accounts.find((a) => a.accountUuid === login);
  const email = entry.emailAddress?.toLowerCase();
  if (email === undefined) return undefined;
  return accounts.find(
    (a) => a.accountUuid === undefined && a.emailAddress?.toLowerCase() === email,
  );
}

/** The label as the vault will store it (stripped of terminal controls and trimmed), falling back
 *  to a placeholder when nothing printable is left. */
function storedLabel(label: string): string {
  return sanitizeTerminalText(label).trim() || 'imported';
}

/**
 * The account steps. A login already stored here is never stored twice: it is skipped, or with
 * `--replace` its credentials may be replaced. Every other entry is added, under its own label when
 * that is free here and otherwise under the next free `label (n)` — the numbering the vault's own
 * duplicate repair uses — never a name any account here (or any earlier entry) answers to, by label
 * in any case or by id.
 */
function planAccounts(input: PlanInput): AccountStep[] {
  const taken = new Set(input.accounts.map((a) => a.label.toLowerCase()));
  const ids = new Set(input.accounts.map((a) => a.id.toLowerCase()));
  const isTaken = (label: string): boolean =>
    taken.has(label.toLowerCase()) || ids.has(label.toLowerCase());
  return input.payload.accounts.map((entry, i): AccountStep => {
    const existing = existingFor(entry, input.accounts);
    if (existing !== undefined) {
      if (input.replace && entry.bundle !== undefined)
        return { kind: 'replace', entry: i, existing };
      return {
        kind: 'skip',
        entry: i,
        existing,
        reason:
          input.replace && entry.bundle === undefined
            ? 'already stored here, and the file has no tokens for it'
            : 'already stored here',
      };
    }
    const wanted = storedLabel(entry.label);
    let label = wanted;
    for (let n = 2; isTaken(label); n += 1) label = `${wanted} (${n})`;
    taken.add(label.toLowerCase());
    return {
      kind: 'add',
      entry: i,
      label,
      ...(label !== wanted ? { renamedFrom: wanted } : {}),
      withTokens: entry.bundle !== undefined,
    };
  });
}

/** The label each entry will be known by here, for showing rule members. */
function labelsByEntry(steps: readonly AccountStep[]): Map<number, string> {
  return new Map(steps.map((s) => [s.entry, s.kind === 'add' ? s.label : s.existing.label]));
}

/**
 * Resolve a member reference (`accountUuid ?? label` of the source account) to an account of the
 * file — by login first, then by label — or, failing that, to an account already stored here by
 * login. Undefined when it names neither.
 */
function resolveMember(
  ref: string,
  input: PlanInput,
  labels: ReadonlyMap<number, string>,
): MemberTarget | undefined {
  const accounts = input.payload.accounts;
  let entry = accounts.findIndex((a) => loginOf(a) === ref);
  if (entry < 0) entry = accounts.findIndex((a) => a.label === ref);
  if (entry >= 0) return { entry, label: labels.get(entry) ?? accounts[entry]!.label };
  const local = input.accounts.find((a) => a.accountUuid === ref);
  return local !== undefined ? { existingId: local.id, label: local.label } : undefined;
}

/** The name a rule gets by default from its first scope — the same default the vault uses — so
 *  that a default name is not carried across as if it had been chosen. */
function defaultRuleLabel(rule: ExportPayload['rules'][number]): string {
  const alias = rule.aliases[0];
  return (
    rule.folders[0] ?? (alias !== undefined ? `session "${alias.alias}" in ${alias.folder}` : '')
  );
}

/**
 * The scope steps. Each scope of a rule from the file becomes a rule of its own here (the engine's
 * rule verbs create a rule per scope), with the same members. A scope is skipped, with the reason,
 * when rules cannot be written here, its folder does not exist here, this machine already has a
 * rule on it (it is left as it is, which also makes a second import a no-op), the file lists it
 * twice, or none of its members came along.
 */
function planScopes(input: PlanInput, steps: readonly AccountStep[]): ScopeStep[] {
  const labels = labelsByEntry(steps);
  const out: ScopeStep[] = [];
  const planned = new Set<string>();
  for (const rule of input.payload.rules) {
    const include: MemberTarget[] = [];
    const exclude: MemberTarget[] = [];
    const dropped: string[] = [];
    for (const [refs, into] of [
      [rule.include, include],
      [rule.exclude, exclude],
    ] as const) {
      for (const ref of refs) {
        const target = resolveMember(ref, input, labels);
        if (target === undefined) dropped.push(ref);
        else into.push(target);
      }
    }
    const scopes = [
      ...rule.folders.map((folder) => ({ kind: 'folder' as const, sourceFolder: folder })),
      ...rule.aliases.map((a) => ({
        kind: 'alias' as const,
        sourceFolder: a.folder,
        alias: a.alias,
      })),
    ];
    let labelUsed = rule.label.trim() === '' || rule.label === defaultRuleLabel(rule);
    for (const scope of scopes) {
      const step: ScopeStep = { ...scope, include, exclude, dropped };
      const folder = input.resolveFolder(scope.sourceFolder);
      if (folder !== undefined) step.folder = folder;
      const skip = scopeSkipReason(input, step, planned);
      if (skip !== undefined) step.skip = skip;
      else if (!labelUsed) {
        step.ruleLabel = rule.label;
        labelUsed = true;
      }
      out.push(step);
    }
  }
  return out;
}

/** Why a scope is not created, or undefined when it is. Records the scope in `planned` when it is,
 *  so a scope the file lists twice is created once. */
function scopeSkipReason(
  input: PlanInput,
  step: ScopeStep,
  planned: Set<string>,
): string | undefined {
  if (input.platform === 'darwin') return 'folder rules are not supported on macOS yet';
  const blocked =
    step.kind === 'alias'
      ? (input.rulesBlocked?.alias ?? input.rulesBlocked?.folder)
      : input.rulesBlocked?.folder;
  if (blocked !== undefined) return blocked;
  if (step.folder === undefined) return 'the folder does not exist on this machine';
  if (step.include.length + step.exclude.length === 0) return 'none of its accounts came along';
  const key =
    step.kind === 'folder'
      ? folderUniquenessKey(step.folder, input.platform)
      : aliasScopeUniquenessKey(step.folder, step.alias!, input.platform);
  const here =
    step.kind === 'folder'
      ? exactFolderRule(step.folder, input.rules, input.platform)
      : exactAliasRule(step.folder, step.alias!, input.rules, input.platform);
  if (here !== undefined) return 'this machine already has a rule there; it is left as it is';
  if (planned.has(`${step.kind}\u0000${key}`)) return 'the file lists it twice';
  planned.add(`${step.kind}\u0000${key}`);
  return undefined;
}

/**
 * The setting steps. Each name must be a setting this build persists, must not name a path (a
 * path on another machine means nothing here), and its value must pass the same check
 * `cctl settings set` makes. A value equal to the one already stored is left alone.
 */
function planSettings(input: PlanInput): SettingStep[] {
  const wanted: [string, string][] = Object.entries(input.payload.settings.env);
  if (input.payload.settings.relayUrl !== undefined) {
    wanted.push([RELAY, input.payload.settings.relayUrl]);
  }
  return wanted.map(([name, raw]): SettingStep => {
    const setting = findDaemonEnvSetting(name);
    if (setting === undefined)
      return { kind: 'skip', name, reason: 'not a setting this cctl knows' };
    if (setting.kind === 'path') {
      return { kind: 'skip', name: setting.name, reason: 'it names a path on the other machine' };
    }
    const checked = checkSettingValue(setting, raw);
    if (!checked.ok) return { kind: 'skip', name: setting.name, reason: checked.message };
    const previous =
      setting.name === RELAY ? input.config?.relayUrl : input.config?.env?.[setting.name];
    if (previous === checked.value)
      return { kind: 'same', name: setting.name, value: checked.value };
    return {
      kind: 'set',
      name: setting.name,
      value: checked.value,
      ...(previous !== undefined ? { previous } : {}),
    };
  });
}

/** Build the plan. See each part for its rules. */
export function planImport(input: PlanInput): ImportPlan {
  const accounts = planAccounts(input);
  const notes: string[] = [];
  if (input.payload.platform !== input.platform && input.payload.rules.length > 0) {
    notes.push(
      `The file was written on ${input.payload.platform}; its folders are ${input.payload.platform} ` +
        'paths, so rules whose folders do not exist here are skipped.',
    );
  }
  return { accounts, scopes: planScopes(input, accounts), settings: planSettings(input), notes };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Terminal-safe text from the file. */
const safe = (text: string): string => sanitizeTerminalText(text);

/** A scope as one phrase: `folder <path>` or `session "<alias>" in <path>`. */
export function describeScope(
  step: Pick<ScopeStep, 'kind' | 'sourceFolder' | 'folder' | 'alias'>,
): string {
  const folder = safe(step.folder ?? step.sourceFolder);
  return step.kind === 'folder'
    ? `folder ${folder}`
    : `session "${safe(step.alias ?? '')}" in ${folder}`;
}

/** A scope's members as `include a, b; exclude c`. */
export function describeMembers(step: Pick<ScopeStep, 'include' | 'exclude'>): string {
  const parts: string[] = [];
  if (step.include.length > 0)
    parts.push(`include ${step.include.map((m) => safe(m.label)).join(', ')}`);
  if (step.exclude.length > 0)
    parts.push(`exclude ${step.exclude.map((m) => safe(m.label)).join(', ')}`);
  return parts.join('; ');
}

/** What an account step will do, as a phrase. */
function describeAccountStep(step: AccountStep, payload: ExportPayload): string {
  const entry = payload.accounts[step.entry]!;
  const excluded = entry.autoSwitchExcluded ? ', excluded from auto-switch' : '';
  switch (step.kind) {
    case 'add':
      return (
        `${safe(step.label)}: add, ${step.withTokens ? 'with its tokens' : 'waiting for a login (no tokens in the file)'}` +
        excluded +
        (step.renamedFrom !== undefined
          ? ` (the label "${safe(step.renamedFrom)}" is taken here)`
          : '')
      );
    case 'skip':
      return `${safe(step.existing.label)}: ${step.reason} - left as it is`;
    case 'replace':
      return (
        `${safe(step.existing.label)}: already stored here - its tokens are replaced if the file's ` +
        'are newer or the stored login is quarantined'
      );
  }
}

/** What a setting step will do, as a phrase. */
function describeSettingStep(step: SettingStep): string {
  switch (step.kind) {
    case 'set':
      return `${step.name}=${safe(step.value)}${step.previous !== undefined ? ` (was ${safe(step.previous)})` : ''}`;
    case 'same':
      return `${step.name}=${safe(step.value)}: already set`;
    case 'skip':
      return `${safe(step.name)}: skipped - ${safe(step.reason)}`;
  }
}

/** The plan in full, as `--dry-run` prints it. */
export function renderImportPlan(plan: ImportPlan, payload: ExportPayload): string {
  const lines: string[] = [...plan.notes];
  lines.push('Accounts:');
  if (plan.accounts.length === 0) lines.push('  (none in the file)');
  for (const step of plan.accounts) lines.push(`  ${describeAccountStep(step, payload)}`);
  lines.push('Rules:');
  if (plan.scopes.length === 0) lines.push('  (none in the file)');
  for (const step of plan.scopes) {
    const members = describeMembers(step);
    const dropped =
      step.dropped.length > 0 ? ` (not in the file: ${step.dropped.map(safe).join(', ')})` : '';
    lines.push(
      step.skip !== undefined
        ? `  ${describeScope(step)}: skipped - ${safe(step.skip)}`
        : `  ${describeScope(step)}: create, ${members}${dropped}`,
    );
  }
  lines.push('Settings:');
  if (plan.settings.length === 0) lines.push('  (none in the file)');
  for (const step of plan.settings) lines.push(`  ${describeSettingStep(step)}`);
  return lines.join('\n') + '\n';
}
