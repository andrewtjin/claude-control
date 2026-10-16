// The import planner: given an opened export and what this machine already holds, decide what
// `cctl import` will do with every account, rule and setting — before anything is written.
//
// Pure. It reads only its inputs (the folder lookup and the engine's scope check are passed in), so
// every collision rule is testable without a vault, and `--dry-run` prints the plan the real run
// then executes: the same skips, for the same reasons, including the refusals the engine would
// make — a folder no rule may cover, the rule cap, a rule's account caps and the cap on reserved
// accounts, tokens that cannot be shown to be the stored login, and a reservation that would leave
// some slot here (this machine's main login or a rule's) with no account to move to, chosen for
// all the slots together the way the engine chooses. What a plan cannot know is decided at run
// time and reported then: which account each slot ends up running, `--replace`'s "is the file's
// copy newer" (it needs the decrypted stored bundle), a slot whose live login is not the one
// recorded for it, and an exclusion refused because sessions run in a slot it would empty.

import {
  MAX_RESERVED_ACCOUNTS,
  MAX_RULES,
  MAX_RULE_ACCOUNTS,
  aliasScopeUniquenessKey,
  allSlots,
  assignDistinct,
  availableInOrder,
  describeRuleScopes,
  exactAliasRule,
  exactFolderRule,
  folderUniquenessKey,
  importIdentityRefusal,
  ruleSlotId,
  sanitizeTerminalText,
  shellQuoteArg,
  slotPool,
  withoutKeptOut,
  type AccountView,
  type FolderRule,
  type RuleScopeRef,
  type RulesPicture,
  type SlotId,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { loginOf, type ExportPayload, type ExportedAccount } from './exportPayload.js';
import {
  blankAsUnset,
  checkSettingValue,
  findDaemonEnvSetting,
  type DaemonFileConfig,
} from './settings.js';

/** What the import does with one account of the file. */
export type AccountStep =
  /** Store it as a new account under `label` (the file's label, numbered when taken here), and
   *  under `id` (its id on the other machine) when no account here has that id. With `withTokens`
   *  false it is stored waiting for a login. `autoSwitchExcluded` is stored with it. `heldBack`
   *  says that was set because the rule the account is reserved to on the other machine is not
   *  made here, so the account would otherwise land in the shared pool auto-switch draws on.
   *  `awaitsRule` says the file reserves it to a rule this plan makes: it is stored kept out of
   *  auto-switch, and handed back once that rule includes it, so a rule refused at run time cannot
   *  leave it in the shared pool either. `forRule` says the file reserves it to a rule at all: no
   *  slot the import moves or seats may run it unless that rule's own (see withoutKeptOut). */
  | {
      kind: 'add';
      entry: number;
      label: string;
      id?: string;
      renamedFrom?: string;
      withTokens: boolean;
      autoSwitchExcluded: boolean;
      heldBack?: true;
      awaitsRule?: true;
      forRule?: true;
    }
  /** The same account is already stored here as `existing`; it is left as it is. */
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
  /** Set on a scope the rule here ({@link RuleStep.into}) does not hold yet and gains. */
  joins?: true;
}

/**
 * What the import does with one rule of the file. A rule is rebuilt WHOLE — one rule here with
 * every scope that can be used here — or added to the rule this machine already has that IS it:
 * the one an earlier import of it made or took (found by the rule's identity, whatever changed
 * since on either machine), which gains the scopes it lacks, or else one on exactly its scopes. It
 * is never split: a rule is one slot, so a split would change which account each of its folders
 * runs on. See intoRule.
 */
export interface RuleStep {
  /** The rule's display name, for a rule this creates, when it is not just the default. */
  label?: string;
  /** The rule's identity across machines (see ExportedRule.origin), stored on a rule this
   *  creates. */
  origin?: string;
  /** Set when {@link into} was taken for this rule by its scopes alone and has no identity yet:
   *  the import records `origin` on it, so a later import finds it after either side changed. */
  takesOrigin?: true;
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

/** What the import does with one setting. `overridden` says the environment here sets it too,
 *  and the environment wins, so the value from the file is not the one the daemon runs with. */
export type SettingStep =
  | { kind: 'set'; name: string; value: string; previous?: string; overridden?: true }
  | { kind: 'same'; name: string; value: string; overridden?: true }
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
  /** The platform the commands the plan prints are quoted for. */
  platform: NodeJS.Platform;
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
  /** The login (uuid) live in a slot that no account stored here is yet: an account of the file
   *  with that login is live there as soon as the import stores it (see unstoredLiveLogins). */
  unstoredLogins?: ReadonlyMap<SlotId, string>;
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
 * The account already stored here that `entry` is. First by id: an account keeps its id when it is
 * imported, so the id finds it again however it was relabelled here and whatever identity it
 * carries — unless the two name different logins, which no copy of one account can. Then by login
 * (uuid). An entry with no login recorded is matched by email, and only against a row that has no
 * login either: two rows with the same address but different logins are different accounts. A
 * label is never enough: two machines can each have a different account called "work".
 */
function existingFor(
  entry: ExportedAccount,
  accounts: readonly AccountView[],
): AccountView | undefined {
  const login = loginOf(entry);
  const byId = entry.id !== undefined ? accounts.find((a) => a.id === entry.id) : undefined;
  if (
    byId !== undefined &&
    (login === undefined || byId.accountUuid === undefined || byId.accountUuid === login)
  ) {
    return byId;
  }
  if (login !== undefined) return accounts.find((a) => a.accountUuid === login);
  const fromBundle = entry.bundle?.oauthAccount?.emailAddress;
  const email = entry.emailAddress ?? (typeof fromBundle === 'string' ? fromBundle : undefined);
  if (email === undefined) return undefined;
  return accounts.find(
    (a) => a.accountUuid === undefined && a.emailAddress?.toLowerCase() === email.toLowerCase(),
  );
}

/**
 * The account steps. An account already stored here is never stored twice: it is skipped, or with
 * `--replace` its credentials may be replaced — but only by tokens whose identity block proves
 * they are the stored login (the engine's own check, see importIdentityRefusal), since nothing
 * else in the file can be checked against them. Every other entry is added, under its own label
 * when that is free here and otherwise under the next free `label (n)` — the numbering the vault's
 * own duplicate repair uses — never a name any account here (or any earlier entry) answers to, by
 * label in any case or by id.
 */
function planAccounts(input: PlanInput): AccountStep[] {
  const matches = input.payload.accounts.map((entry) => existingFor(entry, input.accounts));
  const taken = new Set(input.accounts.map((a) => a.label.toLowerCase()));
  const idsHere = new Set(input.accounts.map((a) => a.id.toLowerCase()));
  // The ids this import keeps for the accounts it adds: an id no account here has, and that no
  // account here answers to as its label (the vault refuses both, since a name would then resolve
  // to two accounts). Every label the import gives must avoid these as much as the ids already
  // here — whichever of the two the vault stores first, it refuses the other.
  const keptIds = new Set(
    input.payload.accounts.flatMap((entry, i) =>
      matches[i] === undefined &&
      entry.id !== undefined &&
      !idsHere.has(entry.id.toLowerCase()) &&
      !taken.has(entry.id.toLowerCase())
        ? [entry.id.toLowerCase()]
        : [],
    ),
  );
  const isTaken = (label: string, ownId: string | undefined): boolean => {
    const lower = label.toLowerCase();
    return (
      taken.has(lower) ||
      idsHere.has(lower) ||
      (keptIds.has(lower) && lower !== ownId?.toLowerCase())
    );
  };
  return input.payload.accounts.map((entry, i): AccountStep => {
    const existing = matches[i];
    if (existing !== undefined) {
      if (input.replace && entry.bundle !== undefined) {
        const refusal = importIdentityRefusal(existing, entry.bundle.oauthAccount);
        if (refusal === undefined) return { kind: 'replace', entry: i, existing };
        return {
          kind: 'skip',
          entry: i,
          existing,
          reason: `already stored here, and ${refusal}, so they cannot replace the stored ones`,
        };
      }
      return {
        kind: 'skip',
        entry: i,
        existing,
        reason: input.replace
          ? 'already stored here, and the file has no tokens for it'
          : 'already stored here',
      };
    }
    const wanted = storedLabel(entry.label);
    let label = wanted;
    for (let n = 2; isTaken(label, entry.id); n += 1) label = `${wanted} (${n})`;
    taken.add(label.toLowerCase());
    // An id another account here already has, or spells as its label, stays behind (that account
    // is not this one: they name different logins); the vault then makes a new one.
    const keepId = entry.id !== undefined && keptIds.has(entry.id.toLowerCase());
    return {
      kind: 'add',
      entry: i,
      label,
      ...(keepId ? { id: entry.id } : {}),
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

/** One key per account, however a member names it: its id here, or — for an account the import
 *  adds, which has no id here yet — its entry in the file. Two references to one account (its login
 *  and its label, say) get the same key. */
function memberKey(target: MemberTarget, steps: readonly AccountStep[]): string {
  return localIdOf(target, steps) ?? `entry\u0000${target.entry}`;
}

/** `targets` with each account once (the first reference to it kept). */
function uniqueMembers(targets: MemberTarget[], steps: readonly AccountStep[]): MemberTarget[] {
  const seen = new Set<string>();
  return targets.filter((t) => {
    const key = memberKey(t, steps);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  steps: readonly AccountStep[],
): string | undefined {
  if (input.platform === 'darwin') return 'folder rules are not supported on macOS yet';
  const blocked =
    (rule.folders.length > 0 ? input.rulesBlocked?.folder : undefined) ??
    (rule.aliases.length > 0
      ? (input.rulesBlocked?.alias ?? input.rulesBlocked?.folder)
      : undefined);
  if (blocked !== undefined) return blocked;
  // The file named the same account on both sides under two names (its login and its label): no
  // vault can hold that, and dropping either side would change what the rule means.
  const both = step.include.find((t) =>
    step.exclude.some((x) => memberKey(x, steps) === memberKey(t, steps)),
  );
  if (both !== undefined) return `it both includes and excludes ${both.label}`;
  if (step.include.length + step.exclude.length === 0) return 'none of its accounts came along';
  // A rule that includes accounts and keeps only its exclusions would open its folders to every
  // shared account, where the source pinned them to its own.
  if (rule.include.length > 0 && step.include.length === 0) {
    return 'none of the accounts it includes is in the file or on this machine';
  }
  return undefined;
}

/**
 * Which rule here, if any, the file's rule IS — the one it is added to rather than made beside.
 *
 * First by identity: the rule an earlier import of it made, or took to be it (its origin is the
 * file rule's), or the rule itself when the file came from this machine (its id is). That holds
 * whatever changed since on either machine — members added, dropped or swapped, folders added or
 * removed, a folder of it taken by a rule of this machine's own — so a rule brought over part way
 * (before all its folders existed here) is grown, never made a second time beside itself, which
 * would split it into two slots. Failing that, a rule here holding exactly the file rule's usable
 * scopes, and nothing else, is that rule, whatever its members. A rule here that is neither is
 * this machine's own however many members it shares with the file's: the scopes it holds stay its
 * own. Two rules here with the one identity (only a hand edit makes them) leave no one rule to grow,
 * and making a third would split it further: `ambiguous` names them.
 */
function intoRule(
  usable: readonly ScopePlan[],
  holders: readonly (FolderRule | undefined)[],
  origin: string | undefined,
  rules: readonly FolderRule[],
): { rule?: FolderRule; ambiguous?: FolderRule[] } {
  if (origin !== undefined) {
    const same = rules.filter((r) => r.origin === origin || r.id === origin);
    if (same.length > 1) return { ambiguous: same };
    if (same.length === 1) return { rule: same[0]! };
  }
  const only = holders[0];
  if (
    only !== undefined &&
    holders.every((h) => h === only) &&
    usable.length === only.folders.length + (only.aliases?.length ?? 0)
  ) {
    return { rule: only };
  }
  return {};
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

/** Why a rule would break one of the vault's account caps — a rule's includes or excludes, or the
 *  accounts reserved to rules in all (`reserved`: what this machine and the rules planned before
 *  this one reserve) — or undefined when it would not. */
function accountCapRefusal(
  step: RuleStep,
  steps: readonly AccountStep[],
  reserved: ReadonlySet<string>,
): string | undefined {
  const including = (step.into?.include.length ?? 0) + step.include.length;
  if (including > MAX_RULE_ACCOUNTS) {
    return `the rule would include more than ${MAX_RULE_ACCOUNTS} accounts`;
  }
  if ((step.into?.exclude.length ?? 0) + step.exclude.length > MAX_RULE_ACCOUNTS) {
    return `the rule would exclude more than ${MAX_RULE_ACCOUNTS} accounts`;
  }
  const reserving = step.include.filter((t) => !reserved.has(memberKey(t, steps)));
  if (reserved.size + reserving.length > MAX_RESERVED_ACCOUNTS) {
    return `this machine would have more than ${MAX_RESERVED_ACCOUNTS} accounts reserved to rules`;
  }
  return undefined;
}

/**
 * The rule steps (see {@link RuleStep}). A rule is not made, with the reason, when rules cannot be
 * written here, it names one account on both sides, none of its scopes can be used here, none of
 * its members came along, it includes accounts of which none is in the file or here, it would pass
 * an account cap or the rule cap, or a rule here already holds its scopes and every member. A
 * scope a different rule here holds is left to that rule. The caps count what the rules before it
 * add, in file order, as the engine counts them.
 */
function planRules(input: PlanInput, steps: readonly AccountStep[]): RuleStep[] {
  const labels = labelsByEntry(steps);
  const planned = new Set<string>();
  let creates = 0;
  const reserved = new Set(
    input.accounts.filter((a) => reservedHere(input, a.id)).map((a) => a.id),
  );
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
    step.include = uniqueMembers(step.include, steps);
    step.exclude = uniqueMembers(step.exclude, steps);
    const early = earlySkip(rule, step, input, steps);
    if (early !== undefined) return { ...step, skip: early };

    step.scopes = lookUpScopes(rule, input, planned);
    const noScope = noScopeLeft(step.scopes);
    if (noScope !== undefined) return { ...step, skip: noScope };

    // The members are added to the rule here that is this rule (see intoRule), which gains any
    // scope no rule here holds; otherwise the rule is made on those. Either way a scope some other
    // rule here holds stays that rule's.
    const usable = step.scopes.filter((s) => s.skip === undefined);
    const holders = usable.map((s) => ruleHolding(s, input));
    const { rule: into, ambiguous } = intoRule(usable, holders, rule.origin, input.rules);
    if (ambiguous !== undefined) {
      return {
        ...step,
        skip:
          'this machine already has it split between rules on ' +
          ambiguous.map((r) => describeRuleScopes(r)).join(' and ') +
          '; it is left as it is (remove all but one with cctl folder reset, then import again)',
      };
    }
    if (rule.origin !== undefined) step.origin = rule.origin;
    if (into !== undefined) {
      step.into = into;
      if (rule.origin !== undefined && into.origin === undefined && into.id !== rule.origin) {
        step.takesOrigin = true;
      }
    }
    for (const [i, scope] of usable.entries()) {
      if (holders[i] === undefined) {
        if (into !== undefined) scope.joins = true;
      } else if (holders[i] !== into) {
        scope.skip = 'this machine has another rule there; it is left as it is';
      }
    }
    const left = noScopeLeft(step.scopes);
    if (left !== undefined) return { ...step, skip: left };

    narrowMembers(step, steps, input);
    const joins = step.scopes.some((s) => s.joins === true);
    if (step.include.length + step.exclude.length === 0 && !joins) {
      return {
        ...step,
        skip:
          step.into !== undefined
            ? 'this machine already has this rule, with these accounts'
            : 'another rule here reserves every account it excludes, so it would change nothing',
      };
    }
    if (step.into === undefined && input.rules.length + creates >= MAX_RULES) {
      return { ...step, skip: `this machine would have more than ${MAX_RULES} rules` };
    }
    const capped = accountCapRefusal(step, steps, reserved);
    if (capped !== undefined) return { ...step, skip: capped };
    for (const t of step.include) reserved.add(memberKey(t, steps));
    if (step.into === undefined) {
      creates += 1;
      if (rule.label.trim() !== '' && rule.label !== defaultRuleLabel(rule))
        step.label = rule.label;
    }
    return step;
  });
}

/**
 * Foresee what the rules do to the slots already here, the way the engine decides it (its
 * slotPool, availableInOrder and assignDistinct, over the same picture): every slot holding an
 * account some rule reserves, and that may not keep it, is moved to an account still available to
 * it, and the replacements are chosen for all those slots together, so two slots needing the one
 * spare account are seen as such. When some slot is left with none, every rule reserving the
 * account it is stuck on is skipped, saying why, and the choice is made again without them; the
 * engine refuses those same rules. Each move is noted on the rules that cause it. Who is live in
 * each slot is read from what is recorded for it, and an account the import adds counts as live
 * where its login already runs unstored (this machine's main login, typically: it was logged in
 * before cctl kept it). Which account each slot then runs is decided at run time.
 */
function foreseeHandOffs(input: PlanInput, steps: readonly AccountStep[], rules: RuleStep[]): void {
  const key = (t: MemberTarget): string => memberKey(t, steps);
  // The accounts the file reserves to a rule are never a slot's replacement (the engine is told the
  // same: see importRules' keepOut).
  const forRule = fileReserved(input, steps);
  const keptOut = new Set(
    steps.flatMap((s) => (s.kind === 'add' && forRule.has(s.entry) ? [key(s)] : [])),
  );
  // The accounts the import adds join the shared pool before the rules are written, as rows only
  // the plan knows (with tokens they can take a slot; without, they are quarantined).
  const added: StoredAccount[] = steps.flatMap((s) =>
    s.kind === 'add'
      ? [
          {
            id: key({ entry: s.entry, label: s.label }),
            label: s.label,
            quarantined: !s.withTokens,
            ...(s.autoSwitchExcluded ? { autoSwitchExcluded: true } : {}),
            createdAtMs: 0,
            updatedAtMs: 0,
          },
        ]
      : [],
  );
  const shared = [...input.accounts.filter((a) => !reservedHere(input, a.id)), ...added];
  const reserved = input.accounts.filter((a) => reservedHere(input, a.id));
  const occupancy = new Map<SlotId, Set<string>>();
  for (const slot of allSlots(input.rules)) {
    const live =
      slot === 'global'
        ? (input.globalLive ?? null)
        : (input.rules.find((r) => ruleSlotId(r.id) === slot)?.activeId ?? null);
    const owners = new Set(live !== null ? [live] : []);
    // A login this slot runs that no account here is recognized as, which the import gives to an
    // account: that account is live there once written.
    const login = input.unstoredLogins?.get(slot);
    for (const s of steps) {
      if (login !== undefined && newLoginOf(s, input) === login) {
        owners.add(s.kind === 'add' ? key({ entry: s.entry, label: s.label }) : s.existing.id);
      }
    }
    occupancy.set(slot, owners);
  }
  const made = (): RuleStep[] => rules.filter((r) => r.skip === undefined);
  const describeSlot = (slot: SlotId): string => {
    const rule = input.rules.find((r) => ruleSlotId(r.id) === slot);
    return rule !== undefined ? `the slot of ${describeRuleScopes(rule)}` : slot;
  };
  for (;;) {
    const reservingKeys = new Set(made().flatMap((r) => r.include.map(key)));
    const reserving = shared.filter((a) => reservingKeys.has(a.id));
    const after: RulesPicture = {
      shared: shared.filter((a) => !reservingKeys.has(a.id)),
      reserved: [...reserved, ...reserving],
      rules: input.rules,
    };
    const mayKeep = (slot: SlotId, id: string): boolean =>
      made().some(
        (r) =>
          r.into !== undefined &&
          ruleSlotId(r.into.id) === slot &&
          r.include.some((t) => key(t) === id),
      );
    const moving: Array<{ slot: SlotId; from: StoredAccount; options: string[] }> = [];
    for (const [slot, owners] of occupancy) {
      const from = reserving.find((a) => owners.has(a.id) && !mayKeep(slot, a.id));
      if (from === undefined) continue;
      const pool = withoutKeptOut(slotPool(slot, after, occupancy), keptOut);
      const options = availableInOrder(pool).map((a) => a.id);
      moving.push({ slot, from, options });
    }
    const assigned = assignDistinct(moving.map((m) => m.options));
    const reservers = (id: string): RuleStep[] =>
      made().filter((r) => r.include.some((t) => key(t) === id));
    if (assigned.ok) {
      for (const m of moving) {
        const which = m.slot === 'global' ? "this machine's main login" : describeSlot(m.slot);
        // Said once, on the first rule that reserves the account, as the real run reports each
        // move once: noted on every such rule, the plan would grow with slots times rules.
        reservers(m.from.id)[0]?.notes.push(
          `${which} moves off ${m.from.label}, which this rule reserves`,
        );
      }
      return;
    }
    const short = moving[assigned.unserved]!;
    const reason =
      short.slot === 'global'
        ? `including ${short.from.label} would leave this machine's main login with no shared ` +
          'account to run on; add or log in another account here first'
        : `including ${short.from.label} would leave ${describeSlot(short.slot)} with no other ` +
          'account to run on';
    for (const rule of reservers(short.from.id)) rule.skip = reason;
  }
}

/**
 * The login the import gives an account step's account, which it is recognized by from then on in
 * any slot running that login: an added account's entry's login, and, for a replaced row that
 * records no login yet, the login its new tokens prove (the engine lays the brought identity over
 * the stored one). A skipped row, or one that records a login already, is recognized as before.
 * A replace is foreseen as written: whether the file's copy is the newer one is known only at run
 * time, and assuming it is can make the plan cautious but never promises a rule the real run
 * refuses.
 */
function newLoginOf(step: AccountStep, input: PlanInput): string | undefined {
  const login = loginOf(input.payload.accounts[step.entry]!);
  if (step.kind === 'add') return login;
  if (step.kind === 'replace' && step.existing.accountUuid === undefined) return login;
  return undefined;
}

/** The entries of the file some rule of it includes: accounts reserved to a rule on the machine the
 *  file came from. */
function fileReserved(input: PlanInput, steps: readonly AccountStep[]): Set<number> {
  const labels = labelsByEntry(steps);
  return new Set(
    input.payload.rules.flatMap((r) =>
      r.include.flatMap((ref) => resolveMember(ref, input, labels)?.entry ?? []),
    ),
  );
}

/**
 * Keep out of auto-switch every account the file reserves to a rule (unless the file already
 * excludes it). On the other machine it ran only in that rule's folders; here, without the rule, it
 * would join the shared pool auto-switch draws on — spending, say, a client's quota on unrelated
 * work. When the plan does not make the rule, the account is held back for good (`heldBack`); it
 * is still listed and can be switched to by hand, and `cctl accounts include <account>` hands it
 * back to auto-switch. When the plan makes the rule, the account is still stored held back and only
 * handed back once that rule includes it (`awaitsRule`), so a rule the engine refuses at run time
 * leaves it held back too.
 */
function holdBackOrphans(input: PlanInput, steps: AccountStep[], rules: readonly RuleStep[]): void {
  const reservedOnSource = fileReserved(input, steps);
  const reservedByPlan = new Set(
    rules
      .filter((r) => r.skip === undefined)
      .flatMap((r) => r.include.flatMap((t) => (t.entry !== undefined ? [t.entry] : []))),
  );
  for (const step of steps) {
    if (step.kind !== 'add' || !reservedOnSource.has(step.entry)) continue;
    step.forRule = true;
    if (step.autoSwitchExcluded) continue;
    if (reservedByPlan.has(step.entry)) {
      step.awaitsRule = true;
    } else {
      step.autoSwitchExcluded = true;
      step.heldBack = true;
    }
  }
}

/**
 * The setting steps. Each name must be a setting this build persists, must not be the relay (it is
 * paired to each machine) or name a path (a path on another machine means nothing here), and its
 * value must pass the same check `cctl settings set` makes. A value equal to the one stored here is
 * left alone. A value that guards less than the one in force here (one that weakens a guard, or
 * sends more off this machine) is never taken from a file, with or without `--replace`: the report
 * names the command that sets it here. A
 * different value stored here is kept unless `--replace`, the way accounts and rules already here
 * are kept. A setting the environment here also sets (a blank value counts as unset, as the daemon
 * reads it) is marked overridden: the file's value is not the one the daemon runs with.
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
      // Said once, however many ways the file spells the relay.
      if (!steps.some((s) => s.name === RELAY)) {
        steps.push({ kind: 'skip', name: RELAY, reason: RELAY_REASON });
      }
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
    const overridden =
      blankAsUnset(input.env?.[setting.name]) !== undefined ? { overridden: true as const } : {};
    if (previous === checked.value) {
      steps.push({ kind: 'same', name: setting.name, value: checked.value, ...overridden });
    } else if (
      setting.guard !== undefined &&
      setting.guard.strength(checked.value) < setting.guard.strength(previous)
    ) {
      steps.push({
        kind: 'skip',
        name: setting.name,
        reason:
          `${setting.guard.what}, so it is not taken from a file; to set it here: ` +
          `cctl settings set ${setting.alias} ${checked.value}`,
      });
    } else if (previous !== undefined && !input.replace) {
      steps.push({ kind: 'kept', name: setting.name, value: checked.value, here: previous });
    } else {
      steps.push({
        kind: 'set',
        name: setting.name,
        value: checked.value,
        ...(previous !== undefined ? { previous } : {}),
        ...overridden,
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
  return { accounts, rules, settings: planSettings(input), notes, platform: input.platform };
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

/** The scopes of a rule that is made but left out of it, and the scopes a rule here gains, each
 *  as a line. */
export function scopeDetailLines(step: RuleStep): string[] {
  if (step.skip !== undefined) return [];
  return [
    ...step.scopes
      .filter((s) => s.joins === true)
      .map((s) => `${describeScope(s)}: joins the rule here`),
    ...step.scopes
      .filter((s) => s.skip !== undefined)
      .map((s) => `${describeScope(s)}: left out - ${safe(s.skip!)}`),
  ];
}

/** The lines under a rule's line in the plan: scopes left out of it or joining it, and what it
 *  moves. */
function ruleDetailLines(step: RuleStep): string[] {
  if (step.skip !== undefined) return [];
  return [...scopeDetailLines(step), ...step.notes.map(safe)].map((l) => `    ${l}`);
}

/** The command that hands an account kept out of auto-switch back to it, quoted for the shell. */
export function includeCommand(label: string, platform: NodeJS.Platform): string {
  return `cctl accounts include ${shellQuoteArg(safe(label), platform)}`;
}

/** How an added account stands with auto-switch, as a clause (empty when it is in the pool). */
export function autoSwitchPhrase(
  step: Extract<AccountStep, { kind: 'add' }>,
  platform: NodeJS.Platform,
): string {
  if (step.heldBack === true) {
    return (
      ', kept out of auto-switch (the rule it is reserved to is not made here; ' +
      `${includeCommand(step.label, platform)} lets auto-switch use it)`
    );
  }
  return step.autoSwitchExcluded ? ', excluded from auto-switch' : '';
}

/** What an account step will do, as a phrase. */
function describeAccountStep(step: AccountStep, platform: NodeJS.Platform): string {
  switch (step.kind) {
    case 'add':
      return (
        `${safe(step.label)}: add, ${step.withTokens ? 'with its tokens' : 'waiting for a login (no tokens in the file)'}` +
        autoSwitchPhrase(step, platform) +
        (step.renamedFrom !== undefined
          ? ` (the label "${safe(step.renamedFrom)}" is taken here)`
          : '')
      );
    case 'skip':
      return `${safe(step.existing.label)}: ${safe(step.reason)} - left as it is`;
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

/** The clause a setting the environment overrides gets. */
export const OVERRIDDEN_CLAUSE = ' (the environment here sets it, and wins)';

/** The line for a setting already set here to the file's value. */
export function sameSettingLine(step: Extract<SettingStep, { kind: 'same' }>): string {
  return (
    `${step.name}=${safe(step.value)}: already set` +
    (step.overridden === true ? OVERRIDDEN_CLAUSE : '')
  );
}

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
      return sameSettingLine(step);
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
  const members = describeMembers(step);
  return `${where}: ${verb}${members !== '' ? `, ${members}` : ''}${describeRuleExtras(step)}`;
}

/** The plan in full, as `--dry-run` prints it: one line per rule (however many scopes it has). */
export function renderImportPlan(plan: ImportPlan): string {
  const lines: string[] = plan.notes.map(safe);
  lines.push('Accounts:');
  if (plan.accounts.length === 0) lines.push('  (none in the file)');
  for (const step of plan.accounts) lines.push(`  ${describeAccountStep(step, plan.platform)}`);
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
