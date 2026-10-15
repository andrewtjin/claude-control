// The import planner: given an opened export and what this machine already holds, decide what
// `cctl import` will do with every account, rule and setting — before anything is written.
//
// Pure. It reads only its inputs (the folder lookup and the engine's scope check are passed in), so
// every collision rule is testable without a vault, and `--dry-run` prints the plan the real run
// then executes: the same skips, for the same reasons, including the refusals the engine would
// make (a folder no rule may cover, the rule cap, a reservation that would leave this machine's
// main login with nothing). What a plan cannot know is decided at run time and reported then: which
// account each slot ends up running, and `--replace`'s "is the file's copy newer", which needs the
// decrypted stored bundle and so is decided by the engine under its lock.

import {
  MAX_RULES,
  aliasScopeUniquenessKey,
  describeRuleScopes,
  exactAliasRule,
  exactFolderRule,
  folderUniquenessKey,
  sanitizeTerminalText,
  type AccountView,
  type FolderRule,
  type RuleScopeRef,
} from '@claude-control/switch-engine';
import { loginOf, type ExportPayload, type ExportedAccount } from './exportPayload.js';
import { checkSettingValue, findDaemonEnvSetting, type DaemonFileConfig } from './settings.js';

/** What the import does with one account of the file. */
export type AccountStep =
  /** Store it as a new account under `label` (the file's label, numbered when taken here). With
   *  `withTokens` false it is stored waiting for a login. `autoSwitchExcluded` is stored with it;
   *  `heldBack` says it was set because the rule the account is reserved to on the other machine
   *  is not made here, so the account would otherwise land in the shared pool auto-switch draws on. */
  | {
      kind: 'add';
      entry: number;
      label: string;
      renamedFrom?: string;
      withTokens: boolean;
      autoSwitchExcluded: boolean;
      heldBack?: true;
    }
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

/** One scope of a rule from the file. */
export interface ScopePlan {
  kind: 'folder' | 'alias';
  /** The folder as the file names it. */
  sourceFolder: string;
  /** The folder as it is canonically spelled here; absent when it cannot be used here. */
  folder?: string;
  alias?: string;
  /** Why this scope is left out of the rule, when it is. */
  skip?: string;
}

/**
 * What the import does with one rule of the file. A rule is rebuilt WHOLE — one rule here with
 * every scope that can be used here — or, when this machine already has a rule on exactly those
 * scopes (an earlier import of the same rule, or of another file from the same machine), the
 * members it lacks are added to that rule. It is never split: a rule is one slot, so a split would
 * change which account each of its folders runs on.
 */
export interface RuleStep {
  /** The rule's display name, for a rule this creates, when it is not just the default. */
  label?: string;
  scopes: ScopePlan[];
  /** The members to include and exclude: for a rule this adds to, only the ones it lacks. */
  include: MemberTarget[];
  exclude: MemberTarget[];
  /** Members of the rule in the file that name no account of the file nor of this machine. */
  dropped: string[];
  /** Members the import leaves out, each with why (a phrase for the report). */
  leftOut: string[];
  /** The rule here the members are added to. */
  into?: FolderRule;
  /** What the rule changes beyond itself (a slot it moves), for the report. */
  notes: string[];
  /** Why the rule is not made, when it is not. */
  skip?: string;
}

/** What the import does with one setting. */
export type SettingStep =
  /** Saved. `overridden` says the environment here sets it too, and the environment wins. */
  | { kind: 'set'; name: string; value: string; previous?: string; overridden?: true }
  | { kind: 'same'; name: string; value: string }
  /** This machine already has another value, which it keeps (`--replace` takes the file's). */
  | { kind: 'kept'; name: string; value: string; here: string }
  | { kind: 'skip'; name: string; reason: string };

/** The whole plan. */
export interface ImportPlan {
  accounts: AccountStep[];
  rules: RuleStep[];
  settings: SettingStep[];
  /** Facts about the file worth saying before the plan (another platform, and so on). */
  notes: string[];
}

/** A folder from the file, looked up here. */
export type FolderLookup = { ok: true; folder: string } | { ok: false; reason: string };

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
  /** The folder as canonically spelled here, or why it cannot be used here. */
  resolveFolder: (folder: string) => FolderLookup;
  /** Why a scope may not hold a rule here (the engine's own check), or undefined when it may. */
  checkScope?: (scope: RuleScopeRef) => string | undefined;
  /** Why rules cannot be written right now (an older daemon is running), by scope kind. */
  rulesBlocked?: { folder?: string; alias?: string };
  /** The account live on this machine's main login (the global slot), if any. */
  globalLive?: string | null;
  /** The environment the daemon is started from here, to say when it overrides a saved setting. */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The relay's setting name; it is never imported. */
const RELAY = 'CCTL_RELAY_URL';
const RELAY_REASON =
  "the relay is paired to each machine, and this machine's pairing belongs to its own relay; " +
  'change it here with cctl settings set relay <url> if you mean to';

/** The label as the vault will store it (stripped of terminal controls and trimmed), falling back
 *  to a placeholder when nothing printable is left. */
function storedLabel(label: string): string {
  return sanitizeTerminalText(label).trim() || 'imported';
}

/**
 * The account already stored here that `entry` is: the same login (uuid). An entry with no login
 * recorded can only be matched by email, and only against a row that has no login either — two
 * rows with the same address but different logins are different accounts. An entry with neither
 * is matched by label against a row with neither, so importing it twice does not store it twice.
 */
function existingFor(
  entry: ExportedAccount,
  accounts: readonly AccountView[],
): AccountView | undefined {
  const login = loginOf(entry);
  if (login !== undefined) return accounts.find((a) => a.accountUuid === login);
  const fromBundle = entry.bundle?.oauthAccount?.emailAddress;
  const email = entry.emailAddress ?? (typeof fromBundle === 'string' ? fromBundle : undefined);
  if (email !== undefined) {
    return accounts.find(
      (a) => a.accountUuid === undefined && a.emailAddress?.toLowerCase() === email.toLowerCase(),
    );
  }
  const label = storedLabel(entry.label).toLowerCase();
  return accounts.find(
    (a) =>
      a.accountUuid === undefined &&
      a.emailAddress === undefined &&
      a.label.toLowerCase() === label,
  );
}

/**
 * The account steps. A login already stored here is never stored twice: it is skipped, or with
 * `--replace` its credentials may be replaced — but only by tokens whose identity block names their
 * login, since nothing else in the file can be checked against them. Every other entry is added,
 * under its own label when that is free here and otherwise under the next free `label (n)` — the
 * numbering the vault's own duplicate repair uses — never a name any account here (or any earlier
 * entry) answers to, by label in any case or by id.
 */
function planAccounts(input: PlanInput): AccountStep[] {
  const taken = new Set(input.accounts.map((a) => a.label.toLowerCase()));
  const ids = new Set(input.accounts.map((a) => a.id.toLowerCase()));
  const isTaken = (label: string): boolean =>
    taken.has(label.toLowerCase()) || ids.has(label.toLowerCase());
  return input.payload.accounts.map((entry, i): AccountStep => {
    const existing = existingFor(entry, input.accounts);
    if (existing !== undefined) {
      if (input.replace && entry.bundle?.oauthAccount !== undefined)
        return { kind: 'replace', entry: i, existing };
      return {
        kind: 'skip',
        entry: i,
        existing,
        reason: !input.replace
          ? 'already stored here'
          : entry.bundle === undefined
            ? 'already stored here, and the file has no tokens for it'
            : "already stored here, and the file's tokens do not say which login they belong to, " +
              'so they cannot replace the stored ones',
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
      autoSwitchExcluded: entry.autoSwitchExcluded,
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

/** The id a member already has here (an account stored here, or a file entry that matched one),
 *  or undefined for an account the import adds. */
function localIdOf(target: MemberTarget, steps: readonly AccountStep[]): string | undefined {
  if (target.existingId !== undefined) return target.existingId;
  const step = steps.find((s) => s.entry === target.entry);
  return step !== undefined && step.kind !== 'add' ? step.existing.id : undefined;
}

/** The name a rule gets by default from its first scope — the same default the vault uses — so
 *  that a default name is not carried across as if it had been chosen. */
function defaultRuleLabel(rule: ExportPayload['rules'][number]): string {
  const alias = rule.aliases[0];
  return (
    rule.folders[0] ?? (alias !== undefined ? `session "${alias.alias}" in ${alias.folder}` : '')
  );
}

/** A usable scope as the engine names it. */
export function scopeRef(scope: ScopePlan): RuleScopeRef {
  return scope.kind === 'folder'
    ? { kind: 'folder', folder: scope.folder! }
    : { kind: 'alias', folder: scope.folder!, alias: scope.alias! };
}

/** A usable scope's uniqueness key here, as the vault compares scopes. */
function scopeKey(scope: ScopePlan, platform: NodeJS.Platform): string {
  return scope.kind === 'folder'
    ? `folder\u0000${folderUniquenessKey(scope.folder!, platform)}`
    : `alias\u0000${aliasScopeUniquenessKey(scope.folder!, scope.alias!, platform)}`;
}

/** The rule here holding exactly this usable scope, if any. */
function ruleHolding(scope: ScopePlan, input: PlanInput): FolderRule | undefined {
  return scope.kind === 'folder'
    ? exactFolderRule(scope.folder!, input.rules, input.platform)
    : exactAliasRule(scope.folder!, scope.alias!, input.rules, input.platform);
}

/** Whether `rule` holds exactly `scopes`, no more and no fewer. */
function holdsExactly(rule: FolderRule, scopes: readonly ScopePlan[], input: PlanInput): boolean {
  return (
    rule.folders.length + (rule.aliases?.length ?? 0) === scopes.length &&
    scopes.every((s) => ruleHolding(s, input)?.id === rule.id)
  );
}

/** The scopes of a rule from the file, as the file names them. */
function sourceScopes(rule: ExportPayload['rules'][number]): ScopePlan[] {
  return [
    ...rule.folders.map((folder) => ({ kind: 'folder' as const, sourceFolder: folder })),
    ...rule.aliases.map((a) => ({
      kind: 'alias' as const,
      sourceFolder: a.folder,
      alias: a.alias,
    })),
  ];
}

/** The scopes of a rule from the file, each looked up here and checked as the engine would. A scope
 *  the file lists twice (in this rule or an earlier one) is used once. Records each usable scope in
 *  `planned`. */
function lookUpScopes(
  rule: ExportPayload['rules'][number],
  input: PlanInput,
  planned: Set<string>,
): ScopePlan[] {
  const scopes = sourceScopes(rule);
  for (const scope of scopes) {
    const lookup = input.resolveFolder(scope.sourceFolder);
    if (!lookup.ok) {
      scope.skip = lookup.reason;
      continue;
    }
    scope.folder = lookup.folder;
    const refused = input.checkScope?.(scopeRef(scope));
    if (refused !== undefined) {
      scope.skip = refused;
      continue;
    }
    const key = scopeKey(scope, input.platform);
    if (planned.has(key)) scope.skip = 'the file lists it twice';
    else planned.add(key);
  }
  return scopes;
}

/** Why a whole rule is not made because of its scopes, or undefined while one is usable. */
function noScopeLeft(scopes: readonly ScopePlan[]): string | undefined {
  if (scopes.some((s) => s.skip === undefined)) return undefined;
  return [...new Set(scopes.map((s) => s.skip!))].join('; ');
}

/** Whether an account stored here is reserved to a rule here. */
function reservedHere(input: PlanInput, id: string): boolean {
  return (input.accounts.find((a) => a.id === id)?.ruleIds ?? []).length > 0;
}

/** The rule steps' refusals that need no folder lookup, so a folder a file names is not touched
 *  for a rule that is skipped anyway. */
function earlySkip(
  rule: ExportPayload['rules'][number],
  step: RuleStep,
  input: PlanInput,
): string | undefined {
  if (input.platform === 'darwin') return 'folder rules are not supported on macOS yet';
  const blocked =
    (rule.folders.length > 0 ? input.rulesBlocked?.folder : undefined) ??
    (rule.aliases.length > 0
      ? (input.rulesBlocked?.alias ?? input.rulesBlocked?.folder)
      : undefined);
  if (blocked !== undefined) return blocked;
  if (step.include.length + step.exclude.length === 0) return 'none of its accounts came along';
  // A rule that includes accounts and keeps only its exclusions would open its folders to every
  // shared account, where the source pinned them to its own.
  if (rule.include.length > 0 && step.include.length === 0) {
    return 'none of the accounts it includes is in the file or on this machine';
  }
  return undefined;
}

/**
 * Narrow a rule's members to what the import will write: for a rule it adds to, only the members
 * that rule lacks, leaving out one it holds on the other side; and never an exclusion of an
 * account a rule HERE reserves (only a shared account can be excluded). An exclusion of an account
 * a rule of the same file reserves is kept, as the source keeps it on record: the engine writes
 * every exclusion before any inclusion.
 */
function narrowMembers(step: RuleStep, steps: readonly AccountStep[], input: PlanInput): void {
  const into = step.into;
  step.include = step.include.filter((target) => {
    const id = localIdOf(target, steps);
    if (into === undefined || id === undefined) return true;
    if (into.exclude.includes(id)) step.leftOut.push(`${target.label} (the rule here excludes it)`);
    return !into.include.includes(id) && !into.exclude.includes(id);
  });
  step.exclude = step.exclude.filter((target) => {
    const id = localIdOf(target, steps);
    if (id === undefined) return true;
    if (into?.exclude.includes(id) === true) return false;
    if (into?.include.includes(id) === true) {
      step.leftOut.push(`${target.label} (the rule here includes it)`);
      return false;
    }
    if (reservedHere(input, id)) {
      step.leftOut.push(`${target.label} (another rule here reserves it)`);
      return false;
    }
    return true;
  });
}

/**
 * The rule steps (see {@link RuleStep}). A rule is not made, with the reason, when rules cannot be
 * written here, none of its scopes can be used here, none of its members came along, it includes
 * accounts of which none is in the file or here, this machine would pass the rule cap, or a rule
 * here already holds exactly its scopes and every member. A scope a different rule here holds is
 * left to that rule.
 */
function planRules(input: PlanInput, steps: readonly AccountStep[]): RuleStep[] {
  const labels = labelsByEntry(steps);
  const planned = new Set<string>();
  let creates = 0;
  return input.payload.rules.map((rule): RuleStep => {
    const step: RuleStep = {
      scopes: sourceScopes(rule),
      include: [],
      exclude: [],
      dropped: [],
      leftOut: [],
      notes: [],
    };
    for (const [refs, into] of [
      [rule.include, step.include],
      [rule.exclude, step.exclude],
    ] as const) {
      for (const ref of refs) {
        const target = resolveMember(ref, input, labels);
        if (target === undefined) step.dropped.push(ref);
        else into.push(target);
      }
    }
    const early = earlySkip(rule, step, input);
    if (early !== undefined) return { ...step, skip: early };

    step.scopes = lookUpScopes(rule, input, planned);
    const noScope = noScopeLeft(step.scopes);
    if (noScope !== undefined) return { ...step, skip: noScope };

    // The members are added to a rule here that holds exactly these scopes; otherwise a scope some
    // other rule here holds stays that rule's, and the rule is made on the rest.
    const usable = step.scopes.filter((s) => s.skip === undefined);
    const holders = usable.map((s) => ruleHolding(s, input));
    const first = holders[0];
    if (first !== undefined && holdsExactly(first, usable, input)) {
      step.into = first;
    } else {
      for (const [i, scope] of usable.entries()) {
        if (holders[i] !== undefined)
          scope.skip = 'this machine has another rule there; it is left as it is';
      }
      const left = noScopeLeft(step.scopes);
      if (left !== undefined) return { ...step, skip: left };
    }

    narrowMembers(step, steps, input);
    if (step.include.length + step.exclude.length === 0) {
      return {
        ...step,
        skip:
          step.into !== undefined
            ? 'this machine already has this rule, with these accounts'
            : 'another rule here reserves every account it excludes, so it would change nothing',
      };
    }
    if (step.into === undefined) {
      if (input.rules.length + creates >= MAX_RULES) {
        return { ...step, skip: `this machine would have more than ${MAX_RULES} rules` };
      }
      creates += 1;
      if (rule.label.trim() !== '' && rule.label !== defaultRuleLabel(rule))
        step.label = rule.label;
    }
    return step;
  });
}

/**
 * Foresee what the rules do to the slots already here, from who is recorded live in each: a rule
 * that reserves an account live on this machine's main login moves that login to another shared
 * account, and when none would be left the engine refuses the rule — so the plan skips it, saying
 * why, and the real run does the same. A rule slot here that runs an account a rule reserves is
 * moved too, which the plan notes. Which account each slot then runs is decided at run time.
 */
function foreseeHandOffs(input: PlanInput, steps: readonly AccountStep[], rules: RuleStep[]): void {
  const labelOf = (id: string): string => input.accounts.find((a) => a.id === id)?.label ?? id;
  const made = (): RuleStep[] => rules.filter((r) => r.skip === undefined);
  const reservedBy = (id: string): RuleStep[] =>
    made().filter((r) => r.include.some((t) => localIdOf(t, steps) === id));
  const live = input.globalLive ?? null;
  if (live !== null && !reservedHere(input, live) && reservedBy(live).length > 0) {
    const reserving = new Set(
      made().flatMap((r) => r.include.flatMap((t) => localIdOf(t, steps) ?? [])),
    );
    const inSlots = new Set(input.rules.flatMap((r) => (r.activeId !== null ? [r.activeId] : [])));
    const includedEntries = new Set(made().flatMap((r) => r.include.map((t) => t.entry)));
    const others =
      input.accounts.filter(
        (a) =>
          a.id !== live &&
          !reservedHere(input, a.id) &&
          !a.quarantined &&
          !reserving.has(a.id) &&
          !inSlots.has(a.id),
      ).length +
      steps.filter((s) => s.kind === 'add' && s.withTokens && !includedEntries.has(s.entry)).length;
    for (const rule of reservedBy(live)) {
      if (others === 0) {
        rule.skip =
          `including ${labelOf(live)} would leave this machine's main login with no shared ` +
          'account to run on; add or log in another account here first';
      } else {
        rule.notes.push(
          `this machine's main login moves off ${labelOf(live)}, which this rule reserves`,
        );
      }
    }
  }
  for (const here of input.rules) {
    const id = here.activeId;
    if (id === null || reservedHere(input, id) || here.include.includes(id)) continue;
    for (const rule of reservedBy(id)) {
      if (rule.into?.id === here.id) continue;
      rule.notes.push(
        `the slot of ${describeRuleScopes(here)} moves off ${labelOf(id)}, which this rule reserves`,
      );
    }
  }
}

/**
 * Hold back from auto-switch an account the file reserves to a rule that is not made here: on the
 * other machine it ran only in that rule's folders, and here, with the rule missing, it would join
 * the shared pool auto-switch draws on — spending, say, a client's quota on unrelated work. It is
 * still listed and can be switched to by hand; `cctl accounts include <account>` hands it back to
 * auto-switch.
 */
function holdBackOrphans(input: PlanInput, steps: AccountStep[], rules: readonly RuleStep[]): void {
  const labels = labelsByEntry(steps);
  const reservedOnSource = new Set(
    input.payload.rules.flatMap((r) =>
      r.include.flatMap((ref) => resolveMember(ref, input, labels)?.entry ?? []),
    ),
  );
  const reservedByPlan = new Set(
    rules
      .filter((r) => r.skip === undefined)
      .flatMap((r) => r.include.flatMap((t) => (t.entry !== undefined ? [t.entry] : []))),
  );
  for (const step of steps) {
    if (step.kind !== 'add' || step.autoSwitchExcluded) continue;
    if (reservedOnSource.has(step.entry) && !reservedByPlan.has(step.entry)) {
      step.autoSwitchExcluded = true;
      step.heldBack = true;
    }
  }
}

/**
 * The setting steps. Each name must be a setting this build persists, must not be the relay (it is
 * paired to each machine) or name a path (a path on another machine means nothing here), and its
 * value must pass the same check `cctl settings set` makes. A value equal to the one stored here is
 * left alone; a different one stored here is kept unless `--replace`, the way accounts and rules
 * already here are kept.
 */
function planSettings(input: PlanInput): SettingStep[] {
  const steps: SettingStep[] = [];
  if (input.payload.settings.relayUrl !== undefined) {
    steps.push({ kind: 'skip', name: RELAY, reason: RELAY_REASON });
  }
  for (const [name, raw] of Object.entries(input.payload.settings.env)) {
    const setting = findDaemonEnvSetting(name);
    if (setting === undefined) {
      steps.push({ kind: 'skip', name, reason: 'not a setting this cctl knows' });
      continue;
    }
    if (setting.name === RELAY) {
      steps.push({ kind: 'skip', name: RELAY, reason: RELAY_REASON });
      continue;
    }
    if (setting.kind === 'path') {
      steps.push({
        kind: 'skip',
        name: setting.name,
        reason: 'it names a path on the other machine',
      });
      continue;
    }
    const checked = checkSettingValue(setting, raw);
    if (!checked.ok) {
      steps.push({ kind: 'skip', name: setting.name, reason: checked.message });
      continue;
    }
    const previous = input.config?.env?.[setting.name];
    if (previous === checked.value) {
      steps.push({ kind: 'same', name: setting.name, value: checked.value });
    } else if (previous !== undefined && !input.replace) {
      steps.push({ kind: 'kept', name: setting.name, value: checked.value, here: previous });
    } else {
      const fromEnv = input.env?.[setting.name];
      steps.push({
        kind: 'set',
        name: setting.name,
        value: checked.value,
        ...(previous !== undefined ? { previous } : {}),
        ...(fromEnv !== undefined && fromEnv !== '' ? { overridden: true as const } : {}),
      });
    }
  }
  return steps;
}

/** Build the plan. See each part for its rules. */
export function planImport(input: PlanInput): ImportPlan {
  const accounts = planAccounts(input);
  const notes: string[] = [];
  if (input.payload.platform !== input.platform && input.payload.rules.length > 0) {
    notes.push(
      `The file was written on ${input.payload.platform}; a folder of another platform is not ` +
        'looked up here, so rules on such folders are skipped.',
    );
  }
  const rules = planRules(input, accounts);
  foreseeHandOffs(input, accounts, rules);
  holdBackOrphans(input, accounts, rules);
  return { accounts, rules, settings: planSettings(input), notes };
}

// ---------------------------------------------------------------------------
// Rendering (shared with the real run's report, so the two read alike)
// ---------------------------------------------------------------------------

/** Terminal-safe text from the file. */
const safe = (text: string): string => sanitizeTerminalText(text);

/** A scope as one phrase: `folder <path>` or `session "<alias>" in <path>`. */
export function describeScope(
  step: Pick<ScopePlan, 'kind' | 'sourceFolder' | 'folder' | 'alias'>,
): string {
  const folder = safe(step.folder ?? step.sourceFolder);
  return step.kind === 'folder'
    ? `folder ${folder}`
    : `session "${safe(step.alias ?? '')}" in ${folder}`;
}

/** The scopes a rule step is made on (or, for a rule not made, all of them), as one phrase. */
export function describeRuleStep(step: Pick<RuleStep, 'scopes' | 'skip'>): string {
  const shown =
    step.skip === undefined ? step.scopes.filter((s) => s.skip === undefined) : step.scopes;
  return shown.map(describeScope).join(', ');
}

/** Members as `include a, b; exclude c`. */
export function describeMembers(step: Pick<RuleStep, 'include' | 'exclude'>): string {
  const parts: string[] = [];
  if (step.include.length > 0)
    parts.push(`include ${step.include.map((m) => safe(m.label)).join(', ')}`);
  if (step.exclude.length > 0)
    parts.push(`exclude ${step.exclude.map((m) => safe(m.label)).join(', ')}`);
  return parts.join('; ');
}

/** What follows a rule's members on its line: its name, members the file names but that are
 *  nowhere, and members left out. */
export function describeRuleExtras(step: Pick<RuleStep, 'label' | 'dropped' | 'leftOut'>): string {
  return (
    (step.label !== undefined ? `, named "${safe(step.label)}"` : '') +
    (step.dropped.length > 0
      ? ` (not in the file or here: ${step.dropped.map(safe).join(', ')})`
      : '') +
    (step.leftOut.length > 0 ? ` (left out: ${step.leftOut.map(safe).join(', ')})` : '')
  );
}

/** The scopes of a rule that is made but left out of it, each as a line. */
export function leftOutScopeLines(step: RuleStep): string[] {
  if (step.skip !== undefined) return [];
  return step.scopes
    .filter((s) => s.skip !== undefined)
    .map((s) => `${describeScope(s)}: left out - ${safe(s.skip!)}`);
}

/** The lines under a rule's line in the plan: scopes left out of it, and what it moves. */
function ruleDetailLines(step: RuleStep): string[] {
  if (step.skip !== undefined) return [];
  return [...leftOutScopeLines(step), ...step.notes.map(safe)].map((l) => `    ${l}`);
}

/** How an added account stands with auto-switch, as a clause (empty when it is in the pool). */
export function autoSwitchPhrase(step: Extract<AccountStep, { kind: 'add' }>): string {
  if (step.heldBack === true) {
    return (
      ', kept out of auto-switch (the rule it is reserved to is not made here; ' +
      `cctl accounts include ${safe(step.label)} lets auto-switch use it)`
    );
  }
  return step.autoSwitchExcluded ? ', excluded from auto-switch' : '';
}

/** What an account step will do, as a phrase. */
function describeAccountStep(step: AccountStep): string {
  switch (step.kind) {
    case 'add':
      return (
        `${safe(step.label)}: add, ${step.withTokens ? 'with its tokens' : 'waiting for a login (no tokens in the file)'}` +
        autoSwitchPhrase(step) +
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

/** The line for a setting this machine keeps. */
export function keptSettingLine(step: Extract<SettingStep, { kind: 'kept' }>): string {
  return (
    `${step.name}=${safe(step.value)}: skipped - this machine has ${safe(step.here)} ` +
    "(--replace takes the file's)"
  );
}

/** The clause a saved setting the environment overrides gets. */
export const OVERRIDDEN_CLAUSE = ' (the environment here sets it, and wins)';

/** What a setting step will do, as a phrase. */
function describeSettingStep(step: SettingStep): string {
  switch (step.kind) {
    case 'set':
      return (
        `${step.name}=${safe(step.value)}` +
        (step.previous !== undefined ? ` (was ${safe(step.previous)})` : '') +
        (step.overridden === true ? OVERRIDDEN_CLAUSE : '')
      );
    case 'same':
      return `${step.name}=${safe(step.value)}: already set`;
    case 'kept':
      return keptSettingLine(step);
    case 'skip':
      return `${safe(step.name)}: skipped - ${safe(step.reason)}`;
  }
}

/** The line a rule step gets in the plan. */
function describeRulePlan(step: RuleStep): string {
  const where = describeRuleStep(step);
  if (step.skip !== undefined) return `${where}: skipped - ${safe(step.skip)}`;
  const verb = step.into !== undefined ? 'add to the rule here' : 'create';
  return `${where}: ${verb}, ${describeMembers(step)}${describeRuleExtras(step)}`;
}

/** The plan in full, as `--dry-run` prints it: one line per rule (however many scopes it has). */
export function renderImportPlan(plan: ImportPlan): string {
  const lines: string[] = plan.notes.map(safe);
  lines.push('Accounts:');
  if (plan.accounts.length === 0) lines.push('  (none in the file)');
  for (const step of plan.accounts) lines.push(`  ${describeAccountStep(step)}`);
  lines.push('Rules:');
  if (plan.rules.length === 0) lines.push('  (none in the file)');
  for (const step of plan.rules) {
    lines.push(`  ${describeRulePlan(step)}`);
    lines.push(...ruleDetailLines(step));
  }
  lines.push('Settings:');
  if (plan.settings.length === 0) lines.push('  (none in the file)');
  for (const step of plan.settings) lines.push(`  ${describeSettingStep(step)}`);
  return lines.join('\n') + '\n';
}
