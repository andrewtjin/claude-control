// The import planner: given an opened export and what this machine already holds, decide what
// `cctl import` will do with every account, rule and setting — before anything is written.
//
// Accounts and settings are planned here, from the inputs alone. Rules are not: what a rule of the
// file does here — created, grown, left unchanged or refused, and every slot it moves — is the
// engine's decision (SwitchEngine.planImportRules), made under the engine's lock from the slots as
// they are, by the same code the real run then carries out (SwitchEngine.importRules). This module
// only turns the file's rules into the specs the engine decides on (each rule whole: its members
// resolved, the scopes that cannot be used here dropped with a note) and shows the verdicts. The
// engine call is injected, so the planner stays testable without a vault.
//
// So `--dry-run` prints what the real run does, line for line, but for what the dry run cannot know:
// what changes on this machine between the two runs (a session starting or stopping in a slot a
// rule would empty, a switch left unfinished in a slot, an account, rule or login changed in
// between), an account a slot is moved onto that cannot be switched to then (its login will not
// refresh), which account each slot ends up running, and `--replace`'s "is the file's copy newer"
// (it needs the decrypted stored bundle; either way the rules are decided alike).

import {
  aliasScopeUniquenessKey,
  folderUniquenessKey,
  importIdentityRefusal,
  sanitizeTerminalText,
  shellQuoteArg,
  type AccountView,
  type FolderRule,
  type ImportConflict,
  type ImportRuleSpec,
  type ImportRuleVerdict,
  type ImportRulesPlan,
  type PendingImportAccount,
  type PlanImportRulesOptions,
  type RuleScopeRef,
  type SlotHandOff,
  type SlotSeat,
} from '@claude-control/switch-engine';
import { createHash } from 'node:crypto';
import { loginOf, type ExportPayload, type ExportedAccount } from './exportPayload.js';
import { slotName } from './folderRender.js';
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
  /** Why this scope cannot be used here, when it cannot: the rule is sent without it, and a
   *  later import, once it can be used, adds it to the rule an earlier import made. */
  skip?: string;
}

/**
 * What the import does with one rule of the file. A rule lands WHOLE or not at all: it grows the one
 * rule here that carries its identity (an earlier import of it), it is created on every scope that
 * can be used here when no rule here holds any of them, or it fails, naming the rule here in the
 * way. That decision is the engine's (`verdict`); a rule the planner can tell is not worth sending
 * (`skip`) never reaches it.
 */
export interface RuleStep {
  /** The rule's display name, when it is not just the default, for a rule this creates. */
  label?: string;
  /** The rule's identity across machines (see ExportedRule.origin). */
  origin?: string;
  scopes: ScopePlan[];
  /** The members as the file names them, resolved here. */
  include: MemberTarget[];
  exclude: MemberTarget[];
  /** Members of the rule in the file that name no account of the file nor of this machine. */
  dropped: string[];
  /** Why the rule is not sent to the engine, when it is not. */
  skip?: string;
  /** The engine's verdict, for a rule sent to it. */
  verdict?: ImportRuleVerdict;
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
  /** The slots the rules move off an account they reserve, as the engine chose them. */
  handOffs: SlotHandOff[];
  /** The folder slots holding a login that seating the rules puts on another account, or none. */
  seats: SlotSeat[];
  settings: SettingStep[];
  /** Facts about the file worth saying before the plan (another platform, and so on). */
  notes: string[];
  /** The platform the commands the plan prints are quoted for. */
  platform: NodeJS.Platform;
  /** The label each account id the verdicts name is shown by: the accounts here, and the ones the
   *  import adds under the ids the plan gave them. */
  labels: ReadonlyMap<string, string>;
  /** The rules here, which name the slots a move is in. */
  rulesHere: readonly FolderRule[];
}

/** A folder from the file, looked up here. */
export type FolderLookup = { ok: true; folder: string } | { ok: false; reason: string };

/** The engine's decision on a batch of rules (SwitchEngine.planImportRules). */
export type PlanRules = (
  specs: ImportRuleSpec[],
  opts: PlanImportRulesOptions,
) => Promise<ImportRulesPlan>;

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
  /** What the engine would do with the rules; called only when some rule is sent to it. */
  planRules: PlanRules;
  /** Why rules cannot be written right now (an older daemon is running), by scope kind. */
  rulesBlocked?: { folder?: string; alias?: string };
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

/** The id the plan names an account the import adds by, until it is stored: no account here can
 *  have it (it holds a NUL, which no stored id does). */
function pendingId(entry: number): string {
  return `entry\u0000${entry}`;
}

/** One id per account, however a member names it: its id here, or — for an account the import
 *  adds, which has no id here yet — the id the plan gives it. Two references to one account (its
 *  login and its label, say) get the same id. */
function memberKey(target: MemberTarget, steps: readonly AccountStep[]): string {
  return localIdOf(target, steps) ?? pendingId(target.entry!);
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
 *  the rule lists twice is used once. A scope another rule of the file holds too is left to the
 *  engine, which refuses the later rule whole. */
function lookUpScopes(rule: ExportPayload['rules'][number], input: PlanInput): ScopePlan[] {
  const scopes = sourceScopes(rule);
  const seen = new Set<string>();
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
    if (seen.has(key)) scope.skip = 'the rule lists it twice';
    else seen.add(key);
  }
  return scopes;
}

/** Why a whole rule is not made because of its scopes, or undefined while one is usable. */
function noScopeLeft(scopes: readonly ScopePlan[]): string | undefined {
  if (scopes.some((s) => s.skip === undefined)) return undefined;
  return [...new Set(scopes.map((s) => s.skip!))].join('; ');
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
 * The rule steps as the planner can make them on its own: each rule's members resolved, the rules
 * not worth sending to the engine skipped with why (rules cannot be written here, it names one
 * account on both sides, none of its members came along, it includes accounts of which none is in
 * the file or here, none of its scopes can be used here), and the scopes that cannot be used here
 * marked. The rest is the engine's to decide (see decideRules).
 */
function draftRules(input: PlanInput, steps: readonly AccountStep[]): RuleStep[] {
  const labels = labelsByEntry(steps);
  return input.payload.rules.map((rule): RuleStep => {
    const step: RuleStep = {
      scopes: sourceScopes(rule),
      include: [],
      exclude: [],
      dropped: [],
      origin: rule.origin ?? scopesOrigin(rule),
      ...(rule.label.trim() !== '' && rule.label !== defaultRuleLabel(rule)
        ? { label: rule.label }
        : {}),
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
    step.scopes = lookUpScopes(rule, input);
    const noScope = noScopeLeft(step.scopes);
    return noScope !== undefined ? { ...step, skip: noScope } : step;
  });
}

/**
 * The identity of a rule the file carries without one (exported from a rule whose id was not a
 * rule id, by hand-editing say): one made from its scopes as the file names them, so the rule the
 * first import makes is found again by every later import of the same file, rather than refused
 * as a rule of this machine's own. Shaped as a rule id, which is what the vault stores.
 */
function scopesOrigin(rule: ExportPayload['rules'][number]): string {
  const hex = createHash('sha256')
    .update(JSON.stringify({ folders: rule.folders, aliases: rule.aliases }))
    .digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-` +
    `${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

/**
 * The spec a rule step asks the engine for: the scopes usable here, the ones that are not (nothing
 * is made on them, but a rule here holding one keeps the rule from landing whole), and the members
 * by `idOf` — the plan's ids for a dry run, the ids the accounts got for the real run — each account
 * once. A member `idOf` has no id for (an account that could not be imported) is left out.
 */
export function ruleSpec(
  step: RuleStep,
  idOf: (target: MemberTarget) => string | undefined,
): ImportRuleSpec {
  const ids = (targets: readonly MemberTarget[]): string[] => [
    ...new Set(targets.flatMap((t) => idOf(t) ?? [])),
  ];
  const usable = step.scopes.filter((s) => s.skip === undefined).map(scopeRef);
  // A scope the rule lists twice is the usable one, not one missing here.
  const same = (a: RuleScopeRef, b: RuleScopeRef): boolean =>
    a.kind === b.kind &&
    a.folder === b.folder &&
    (a.kind === 'folder' || (b.kind === 'alias' && a.alias === b.alias));
  const absent = step.scopes
    .filter((s) => s.skip !== undefined)
    .map((s) => scopeRef({ ...s, folder: s.folder ?? s.sourceFolder }))
    .filter((ref) => !usable.some((u) => same(u, ref)));
  return {
    scopes: usable,
    ...(absent.length > 0 ? { absent } : {}),
    include: ids(step.include),
    exclude: ids(step.exclude),
    ...(step.label !== undefined ? { label: step.label } : {}),
    ...(step.origin !== undefined ? { origin: step.origin } : {}),
  };
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
 * The login the import gives a stored row that records none: the one the file's tokens name, which
 * they prove. The engine records it whether it takes the file's tokens or keeps the newer copy
 * stored here (see SwitchEngine.importBundle), so the plan counts it either way, as the real run
 * will. The login the file's entry states beside its tokens is not counted: the engine is given
 * only the tokens, so a login they do not name is never recorded.
 */
function newLoginOf(step: AccountStep, input: PlanInput): string | undefined {
  if (step.kind !== 'replace' || step.existing.accountUuid !== undefined) return undefined;
  const login = input.payload.accounts[step.entry]!.bundle?.oauthAccount?.accountUuid;
  return typeof login === 'string' && login !== '' ? login : undefined;
}

/**
 * Ask the engine what it would do with the rules not skipped, and put each verdict on its step.
 * The accounts the import adds are named by the plan's ids and told to the engine as accounts it
 * will have stored (with the auto-switch exclusion they will be stored with), the accounts the file
 * reserves to a rule as kept out of every slot but their rule's, and the logins `--replace` gives
 * stored rows. Returns the hand-offs and the labels the verdicts' ids are shown by.
 */
async function decideRules(
  input: PlanInput,
  steps: readonly AccountStep[],
  rules: readonly RuleStep[],
): Promise<{ handOffs: SlotHandOff[]; seats: SlotSeat[]; labels: Map<string, string> }> {
  const labels = new Map(input.accounts.map((a) => [a.id, a.label]));
  const forRule = fileReserved(input, steps);
  const pending: PendingImportAccount[] = steps.flatMap((s) => {
    if (s.kind !== 'add') return [];
    const login = loginOf(input.payload.accounts[s.entry]!);
    return [
      {
        id: pendingId(s.entry),
        label: s.label,
        ...(login !== undefined ? { accountUuid: login } : {}),
        withTokens: s.withTokens,
        // Stored kept out until its rule takes it, or for good when it has none here.
        autoSwitchExcluded: s.autoSwitchExcluded || forRule.has(s.entry),
      },
    ];
  });
  for (const p of pending) labels.set(p.id, p.label);
  const sent = rules.filter((r) => r.skip === undefined);
  if (sent.length === 0) return { handOffs: [], seats: [], labels };
  const logins = steps.flatMap((s) => {
    const login = newLoginOf(s, input);
    return s.kind === 'replace' && login !== undefined
      ? [{ id: s.existing.id, accountUuid: login }]
      : [];
  });
  const keepOut = steps.flatMap((s) =>
    s.kind === 'add' && forRule.has(s.entry) ? [pendingId(s.entry)] : [],
  );
  // A quarantined login --replace gives new tokens is always replaced, so it is usable by the time
  // the rules are written.
  const revived = steps.flatMap((s) =>
    s.kind === 'replace' && s.existing.quarantined ? [s.existing.id] : [],
  );
  const plan = await input.planRules(
    sent.map((r) => ruleSpec(r, (t) => memberKey(t, steps))),
    { keepOut, pending, logins, revived },
  );
  for (const [k, r] of sent.entries()) r.verdict = plan.rules[k]!;
  return { handOffs: plan.handOffs, seats: plan.seats, labels };
}

/** Whether a verdict writes the rule (creates or grows it). */
function writes(
  verdict: ImportRuleVerdict | undefined,
): verdict is Extract<ImportRuleVerdict, { kind: 'create' | 'grow' }> {
  return verdict?.kind === 'create' || verdict?.kind === 'grow';
}

/**
 * Keep out of auto-switch every account the file reserves to a rule (unless the file already
 * excludes it). On the other machine it ran only in that rule's folders; here, without the rule, it
 * would join the shared pool auto-switch draws on — spending, say, a client's quota on unrelated
 * work. When the engine would not make the rule, the account is held back for good (`heldBack`); it
 * is still listed and can be switched to by hand, and `cctl accounts include <account>` hands it
 * back to auto-switch. When it would, the account is still stored held back and only handed back
 * once that rule includes it (`awaitsRule`), so a rule the engine refuses at run time leaves it held
 * back too.
 */
function holdBackOrphans(input: PlanInput, steps: AccountStep[], rules: readonly RuleStep[]): void {
  const reservedOnSource = fileReserved(input, steps);
  const reservedByPlan = new Set(
    rules.flatMap((r) => (writes(r.verdict) ? r.verdict.include : [])),
  );
  for (const step of steps) {
    if (step.kind !== 'add' || !reservedOnSource.has(step.entry)) continue;
    step.forRule = true;
    if (step.autoSwitchExcluded) continue;
    if (reservedByPlan.has(pendingId(step.entry))) {
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
export async function planImport(input: PlanInput): Promise<ImportPlan> {
  const accounts = planAccounts(input);
  const notes: string[] = [];
  if (input.payload.platform !== input.platform && input.payload.rules.length > 0) {
    notes.push(
      `The file was written on ${input.payload.platform}; a folder of another platform is not ` +
        'looked up here, so rules on such folders are skipped.',
    );
  }
  const rules = draftRules(input, accounts);
  const { handOffs, seats, labels } = await decideRules(input, accounts, rules);
  holdBackOrphans(input, accounts, rules);
  return {
    accounts,
    rules,
    handOffs,
    seats,
    settings: planSettings(input),
    notes,
    platform: input.platform,
    labels,
    rulesHere: input.rules,
  };
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

/** A scope the engine names, as one phrase (see {@link describeScope}). */
function describeRef(scope: RuleScopeRef): string {
  return describeScope({
    kind: scope.kind,
    sourceFolder: scope.folder,
    ...(scope.kind === 'alias' ? { alias: scope.alias } : {}),
  });
}

/** The scopes a rule step is sent with (or, for a rule not sent, all of them), as one phrase. */
export function describeRuleStep(step: Pick<RuleStep, 'scopes' | 'skip'>): string {
  const shown =
    step.skip === undefined ? step.scopes.filter((s) => s.skip === undefined) : step.scopes;
  return shown.map(describeScope).join(', ');
}

/** How a report names what it shows: the label of an account id, the name of a slot, and the
 *  platform the commands it prints are quoted for. */
export interface ReportNames {
  labelOf: (id: string) => string;
  slotName: (slot: SlotHandOff['slot']) => string;
  platform: NodeJS.Platform;
}

/** The names a plan's own lines use. */
export function planNames(plan: ImportPlan): ReportNames {
  return {
    labelOf: (id) => plan.labels.get(id) ?? id,
    slotName: (slot) => slotName(slot, plan.rulesHere),
    platform: plan.platform,
  };
}

/** Members as `include a, b; exclude c`. */
function describeMembers(
  include: readonly string[],
  exclude: readonly string[],
  names: ReportNames,
): string {
  const parts: string[] = [];
  const list = (ids: readonly string[]): string =>
    ids.map((id) => safe(names.labelOf(id))).join(', ');
  if (include.length > 0) parts.push(`include ${list(include)}`);
  if (exclude.length > 0) parts.push(`exclude ${list(exclude)}`);
  return parts.join('; ');
}

/** Why the engine leaves a member out, as a phrase. */
const LEFT_OUT_WHY = {
  'excluded-here': 'the rule here excludes it',
  'included-here': 'the rule here includes it',
  'reserved-here': 'another rule here reserves it',
  'leased-here': 'a parallel session runs on it here; import again once it ends',
} as const;

/** What follows a rule's members on its line: its name (for a rule it creates), members the file
 *  names but that are nowhere, and members the engine leaves out. */
function describeRuleExtras(step: RuleStep, names: ReportNames): string {
  const verdict = step.verdict;
  const leftOut = verdict !== undefined && verdict.kind !== 'refused' ? verdict.leftOut : [];
  return (
    (verdict?.kind === 'create' && step.label !== undefined
      ? `, named "${safe(step.label)}"`
      : '') +
    (step.dropped.length > 0
      ? ` (not in the file or here: ${step.dropped.map(safe).join(', ')})`
      : '') +
    (leftOut.length > 0
      ? ` (left out: ${leftOut.map((l) => `${safe(names.labelOf(l.id))} (${LEFT_OUT_WHY[l.why]})`).join(', ')})`
      : '')
  );
}

/** How many of a rule's reset commands a merge hint spells out before it points at the rest. */
const HINT_RESETS = 4;

/**
 * How to bring a rule of the file and the rule here in its way together by hand: remove the rule
 * here, every scope of it (resetting a rule's last scope removes the rule), and import again, which
 * then makes the file's rule whole. Nothing else lands it: a rule here that the file did not make is
 * never grown by an import, so giving it the file's accounts by hand would leave the import failing.
 */
function mergeHint(conflict: ImportConflict, platform: NodeJS.Platform): string {
  if (conflict.rule === undefined) return '';
  const q = (text: string): string => shellQuoteArg(safe(text), platform);
  const resets = conflict.rule.scopes.map((scope) =>
    scope.kind === 'folder'
      ? `cctl folder reset ${q(scope.folder)}`
      : `cctl session reset ${q(scope.alias)} --cwd ${q(scope.folder)}`,
  );
  const shown = resets.slice(0, HINT_RESETS).join('; ');
  const more =
    resets.length > HINT_RESETS
      ? `; and ${resets.length - HINT_RESETS} more of its scopes (cctl folders lists them)`
      : '';
  return `; to bring them together, remove the rule here (${shown}${more}) and import again`;
}

/** The verb a rule written by the import gets, in the plan's tense or the report's. */
function writeVerb(kind: 'create' | 'grow', tense: 'plan' | 'done'): string {
  if (kind === 'create') return tense === 'plan' ? 'create' : 'created';
  return tense === 'plan' ? 'add to the rule here' : 'added to the rule here';
}

/**
 * The lines a rule gets — in the plan (`plan`) or in the real run's report (`done`), from the same
 * verdict, so the two differ only in the tense of the verb — and whether it counts as done: its
 * line (with its scopes, what it does, its members, name, and members left out), then the scopes it
 * gains or that cannot be used here. A rule the engine refuses is not done, and the line says why
 * (with, for a scope a rule here holds, how to bring the two together by hand).
 */
export function ruleLines(
  step: RuleStep,
  tense: 'plan' | 'done',
  names: ReportNames,
): { lines: string[]; ok: boolean } {
  const where = describeRuleStep(step);
  if (step.skip !== undefined)
    return { lines: [`${where}: skipped - ${safe(step.skip)}`], ok: true };
  const verdict = step.verdict!;
  const unusable = step.scopes
    .filter((s) => s.skip !== undefined)
    .map((s) => `${describeScope(s)}: left out - ${safe(s.skip!)}`);
  switch (verdict.kind) {
    case 'create':
    case 'grow': {
      const members = describeMembers(verdict.include, verdict.exclude, names);
      return {
        lines: [
          `${where}: ${writeVerb(verdict.kind, tense)}${members !== '' ? `, ${members}` : ''}` +
            describeRuleExtras(step, names),
          ...(verdict.kind === 'grow'
            ? verdict.scopes.map((s) => `${describeRef(s)}: joins the rule here`)
            : []),
          ...unusable,
        ],
        ok: true,
      };
    }
    case 'unchanged':
      return {
        lines: [`${where}: skipped - ${safe(verdict.reason)}${describeRuleExtras(step, names)}`],
        ok: true,
      };
    case 'refused':
      return {
        lines: [
          `${where}: not imported - ${safe(verdict.message)}` +
            (verdict.conflict !== undefined ? mergeHint(verdict.conflict, names.platform) : ''),
        ],
        ok: false,
      };
  }
}

/** The line a slot the rules move off an account they reserve gets: in the plan (`plan`), or as
 *  made (`done`). An import moves such a slot only once the rule reserving the account is written,
 *  so the account it left is reserved by then. */
export function handOffLine(hand: SlotHandOff, tense: 'plan' | 'done', names: ReportNames): string {
  const slot = safe(names.slotName(hand.slot));
  const from = safe(names.labelOf(hand.from));
  const to = safe(names.labelOf(hand.to));
  if (tense === 'plan') return `${slot} moves off ${from} onto ${to}`;
  return `${slot} switched off ${from} (now reserved) and is on ${to}`;
}

/** The line a folder slot the import puts on another account (or none) gets: in the plan
 *  (`plan`), or as made (`done`). A slot holding a login no account here is recognized as names it
 *  so. */
export function seatLine(seat: SlotSeat, tense: 'plan' | 'done', names: ReportNames): string {
  const slot = safe(names.slotName(seat.slot));
  const from = seat.from === null ? 'a login of no account here' : safe(names.labelOf(seat.from));
  if (seat.to === null) {
    return tense === 'plan'
      ? `${slot} will be left with no account (${from} is signed out of it)`
      : `${slot} was left with no account (${from} was signed out of it)`;
  }
  const to = safe(names.labelOf(seat.to));
  return tense === 'plan'
    ? `${slot} will run on ${to} instead of ${from}`
    : `${slot} now runs on ${to} instead of ${from}`;
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

/** The plan in full, as `--dry-run` prints it: one line per rule (however many scopes it has), the
 *  lines under it, and every slot the rules move. */
export function renderImportPlan(plan: ImportPlan): string {
  const names = planNames(plan);
  const lines: string[] = plan.notes.map(safe);
  lines.push('Accounts:');
  if (plan.accounts.length === 0) lines.push('  (none in the file)');
  for (const step of plan.accounts) lines.push(`  ${describeAccountStep(step, plan.platform)}`);
  lines.push('Rules:');
  if (plan.rules.length === 0) lines.push('  (none in the file)');
  for (const step of plan.rules) {
    const [first, ...rest] = ruleLines(step, 'plan', names).lines;
    lines.push(`  ${first!}`, ...rest.map((l) => `    ${l}`));
  }
  for (const hand of plan.handOffs) lines.push(`  ${handOffLine(hand, 'plan', names)}`);
  for (const seat of plan.seats) lines.push(`  ${seatLine(seat, 'plan', names)}`);
  lines.push('Settings:');
  if (plan.settings.length === 0) lines.push('  (none in the file)');
  for (const step of plan.settings) lines.push(`  ${describeSettingStep(step)}`);
  return lines.join('\n') + '\n';
}
