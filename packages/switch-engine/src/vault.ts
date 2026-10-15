// The encrypted account vault + non-secret registry.
//
// Layout under `vaultDir`:
//   accounts.json        registry: active id + StoredAccount[] (non-secret metadata)
//   groups.json          the reserved side of the registry and the folder rules over it
//   <id>/cred.enc        DPAPI-encrypted CredentialBundle for one account
//   .rollback.enc        DPAPI-encrypted snapshot of the previous live creds (mid-switch only)
//   token-prints.json    one-way fingerprints of each bundle's tokens, a cache (see tokenPrints.ts)
//
// The registry is plaintext by design so the CLI can list accounts cheaply; it never holds
// a token. Secrets exist only inside the .enc blobs, which are useless off this machine/user.

import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { ruleSlotId } from './types.js';
import type {
  AccountIdentity,
  AccountView,
  AddAccountOptions,
  CredentialBundle,
  FolderRule,
  OauthAccount,
  Registry,
  RulesFile,
  StoredAccount,
  StoredAliasScope,
} from './types.js';
import type { FolderBindingSnapshot } from './types.js';
import type { Protector } from './dpapi.js';
import {
  CLAUDE_CODE_TITLE_MAX_LENGTH,
  aliasFitsSessionTitle,
  aliasKey,
  aliasScopeUniquenessKey,
  folderUniquenessKey,
} from './folderPath.js';
import {
  describeRuleScopes,
  rulesIncluding,
  slotMayHold,
  type RulesPicture,
} from './folderRules.js';
import { sanitizeTerminalText } from './terminalSafe.js';
import {
  buildFolderBindingSnapshot,
  readFolderBindingSnapshot,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
} from './folderBindings.js';
import { folderBindingsPath, groupProfileDir } from './paths.js';
import { atomicWriteFile, ensureDir, readJsonIfExists, removeIfExists } from './fsutil.js';
import {
  StoredTokens,
  blobDigest,
  readPrintIndex,
  tokenPrints,
  writePrintIndex,
  type TokenPrints,
} from './tokenPrints.js';
import { UnknownAccountError, VaultError } from './errors.js';
import { noopLogger, type Logger } from './logger.js';

/** What {@link Vault.dedupeAccounts} did, for the CLI to say out loud. */
export interface DedupeReport {
  /** Rows removed because another row already stored the same login. */
  merged: Array<{ label: string; keptId: string; removedId: string }>;
  /** Rows relabelled because they shared a label with a different login. */
  relabelled: Array<{ id: string; from: string; to: string }>;
}

/** One consistent read of the registry ({@link Vault.readPicture}): the {@link RulesPicture} every
 *  pool decision takes, plus the global slot's recorded account and the rules generation. */
export interface RegistryPicture extends RulesPicture {
  activeId: string | null;
  generation: number;
}

/** What a new folder rule is made of ({@link Vault.createRule}). */
export interface NewRuleOptions {
  /** Canonical folders the rule applies to (the engine passes exactly one, or none for an alias
   *  rule). */
  folders: readonly string[];
  /** Session-alias scopes (the engine passes exactly one for an alias rule, none for a folder
   *  rule). */
  aliases?: readonly StoredAliasScope[];
  /** Accounts to include, in preference order. */
  include?: readonly string[];
  /** Shared accounts to exclude. */
  exclude?: readonly string[];
  /** Display name; defaults to the first folder. */
  label?: string;
}

/** The scopes of some rules as a display list, for "reserved to <folders>" messages. */
function describeRuleFolders(rules: readonly FolderRule[]): string {
  return rules.length > 0 ? rules.map(describeRuleScopes).join(', ') : 'a folder rule';
}

/** Refuse a label another row already answers to (any case) or that spells an account id:
 *  `resolveAccountRef` matches id first, then exact label, then case-insensitive label, so
 *  either collision would leave one of the two accounts unreachable by name. `exceptId` is
 *  the row being renamed, whose own label is not a collision with itself.
 *
 *  Checked across ALL rows — shared AND reserved — because `resolveAccountRef` resolves a name
 *  against the one logical registry: a label a reserved account already carries must be as off-limits
 *  to a shared account as another shared account's is, or `cctl switch <name>` could not tell the
 *  two apart. */
function assertLabelFree(rows: StoredAccount[], label: string, exceptId: string | undefined): void {
  const lower = label.toLowerCase();
  const taken = rows.find(
    (a) => a.id === label || (a.id !== exceptId && a.label.toLowerCase() === lower),
  );
  if (taken) {
    throw new VaultError(
      `"${label}" already refers to account ${taken.id} ("${taken.label}"); ` +
        'two accounts answering to one name could not be told apart on switch',
    );
  }
}

/** The reusable core of {@link Vault.dedupeAccounts}, run once over the shared rows and once over
 *  the reserved rows — every set of rows that answers to one logical registry must be internally
 *  consistent under the same rules (one row per login, one name per row). Mutates and returns `rows`
 *  in place; the caller persists only the sets that actually {@link DedupeCoreResult.changed}.
 *  `preferred` (every slot's live account) picks the survivor when the same login is stored twice:
 *  the row that is live keeps its seat. */
interface DedupeCoreResult {
  removedIds: Set<string>;
  merged: DedupeReport['merged'];
  relabelled: DedupeReport['relabelled'];
  changed: boolean;
}
function dedupeRows(
  rows: StoredAccount[],
  preferred: ReadonlySet<string>,
  clock: () => number,
): { rows: StoredAccount[]; result: DedupeCoreResult } {
  const merged: DedupeReport['merged'] = [];
  const relabelled: DedupeReport['relabelled'] = [];

  const byLogin = new Map<string, StoredAccount[]>();
  for (const a of rows) {
    if (a.accountUuid === undefined) continue;
    byLogin.set(a.accountUuid, [...(byLogin.get(a.accountUuid) ?? []), a]);
  }
  const removedIds = new Set<string>();
  for (const group of byLogin.values()) {
    if (group.length < 2) continue;
    // The active row wins; absent one, the most recently CAPTURED (largest createdAtMs) — a capture
    // always writes fresh tokens, whereas updatedAtMs also moves on a metadata touch.
    const keep =
      group.find((r) => preferred.has(r.id)) ??
      group.reduce((best, r) => (r.createdAtMs > best.createdAtMs ? r : best));
    for (const r of group) {
      if (r === keep) continue;
      removedIds.add(r.id);
      merged.push({ label: r.label, keptId: keep.id, removedId: r.id });
    }
  }
  const next = rows.filter((a) => !removedIds.has(a.id));

  // Earlier rows keep their label; every label already on record (any case) and every id is off
  // limits for the suffix, so the result is unique under the same rules a rename obeys.
  const taken = new Set(next.map((a) => a.label.toLowerCase()));
  const seen = new Set<string>();
  for (const a of [...next].sort((x, y) => x.createdAtMs - y.createdAtMs)) {
    const lower = a.label.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      continue;
    }
    let n = 2;
    let candidate = `${a.label} (${n})`;
    while (taken.has(candidate.toLowerCase()) || next.some((o) => o.id === candidate)) {
      n += 1;
      candidate = `${a.label} (${n})`;
    }
    relabelled.push({ id: a.id, from: a.label, to: candidate });
    a.label = candidate;
    a.updatedAtMs = clock();
    taken.add(candidate.toLowerCase());
    seen.add(candidate.toLowerCase());
  }

  const changed = merged.length > 0 || relabelled.length > 0;
  return { rows: next, result: { removedIds, merged, relabelled, changed } };
}

/** The registry file's shape: an object whose `accounts`, when present, is an array of rows
 *  that each carry a string id — the one field every reader indexes by. */
function isRegistryShape(value: unknown): value is { activeId?: unknown; accounts?: unknown[] } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const accounts = (value as { accounts?: unknown }).accounts;
  return (
    accounts === undefined ||
    (Array.isArray(accounts) &&
      accounts.every(
        (a) =>
          typeof a === 'object' && a !== null && typeof (a as { id?: unknown }).id === 'string',
      ))
  );
}

/** A fresh empty registry. MUST be a factory, not a shared constant — callers mutate the
 *  `accounts` array in place, and a shared array would leak accounts between vaults. */
function emptyRegistry(): Registry {
  return { activeId: null, accounts: [] };
}

/** Registry schema tag written into `accounts.json` from this build on. Its presence marks a file
 *  the reserved split is aware of; its ABSENCE is the legacy pre-split shape (see {@link Registry}). */
const ACCOUNTS_SCHEMA_VERSION = 2;
/** Schema tag `groups.json` is written with: folder rules over the inherited pool. */
const RULES_SCHEMA_VERSION = 2;
/** Schema tag of a `groups.json` in which some rule carries a session-alias scope. A build that
 *  knows only folder rules refuses any tag but 1 and 2 (failing closed on every command) — which is
 *  the point: such a build would otherwise load the file, keep the `aliases` it does not know as an
 *  opaque field, and route every alias-bound session by its folder alone (an alias-only rule would
 *  apply to nothing while still holding its reserved accounts). So a file is stamped 3 exactly while
 *  an alias scope exists, and 2 again once none is left, which those builds read as before. This
 *  build reads both. */
const RULES_SCHEMA_VERSION_ALIASES = 3;
/** Schema tag of the set-bound groups `groups.json` held before folder rules. Still READ, and
 *  migrated to {@link RULES_SCHEMA_VERSION} in memory (written back as such on the next write). Any
 *  other value fails closed rather than being read as a shape this build does not understand. */
const LEGACY_GROUPS_SCHEMA_VERSION = 1;

/**
 * Upper bounds on the rules registry, enforced on every load and every mutation.
 *
 * These are refusal points, not capacity targets: the files are read into memory, parsed, and
 * (for the guard snapshot) copied around, so an unbounded count turns one hostile or corrupt file
 * into an out-of-memory or a wedged daemon. The numbers are far above any real fleet — dozens of
 * folders per rule, dozens of rules — so a legitimate operator never meets them.
 */
export const MAX_RULES = 64;
/** Per rule, the most accounts its include list may name, and separately its exclude list. */
export const MAX_RULE_ACCOUNTS = 32;
export const MAX_RULE_FOLDERS = 256;
/** Alias scopes per rule — same order of magnitude as folders, same reasoning. */
export const MAX_RULE_ALIASES = 256;
/** Longest alias a rules file may carry when LOADED. A session title is free text, and every alias
 *  is copied into the guard snapshot the hook reads on each prompt, so an unbounded one would let a
 *  single pasted blob bloat every prompt's read. A NEW alias rule is held to Claude Code's own title
 *  length (CLAUDE_CODE_TITLE_MAX_LENGTH), since a longer alias can never match a session; this larger
 *  cap only keeps a hand-edited file loadable, so its rule can be seen (flagged as never matching)
 *  and reset. */
export const MAX_ALIAS_LENGTH = 512;
/** The most reserved rows `groups.json` may hold across all rules. */
export const MAX_RESERVED_ACCOUNTS = 256;

/** Property names that, if copied onto an object literal or used as a plain-object map key, reach
 *  through to `Object.prototype` (prototype pollution). Registry files are operator-editable and,
 *  for `groups.json`, part of the downgrade-fence contract with older builds, so a file bearing one
 *  of these is refused rather than parsed. */
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/** Throw if `obj` carries any {@link FORBIDDEN_KEYS} as an OWN property. `JSON.parse` materializes
 *  a literal `"__proto__"` key as a real own property (it uses define-semantics, not assignment),
 *  so this catches it where a plain `obj.__proto__` read would not. `where` names the offending
 *  location for the closed-fail message. */
function assertNoForbiddenKeys(obj: object, where: string): void {
  for (const key of Object.getOwnPropertyNames(obj)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new VaultError(`${where} contains a forbidden key "${key}"`);
    }
  }
}

/** Whether a value is a plain (non-null, non-array) object worth validating field by field. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate one row that `groups.json` claims is a reserved account, failing CLOSED (a named
 * {@link VaultError}, nothing written) on anything malformed.
 *
 * Stricter than the shared-registry shape check: a shared row an older build wrote may legitimately
 * lack derived fields, but every reserved row was moved out of a row this build created, so the full
 * required shape must be intact — a row missing its id or timestamps is corruption, not an old
 * file, and reading it loosely would let a broken row flow into a live credential decision.
 */
function validateMember(value: unknown, where: string): StoredAccount {
  if (!isPlainObject(value)) throw new VaultError(`${where} is not an object`);
  assertNoForbiddenKeys(value, where);
  const id = value.id;
  if (typeof id !== 'string' || id === '') throw new VaultError(`${where} has no string id`);
  if (typeof value.label !== 'string') throw new VaultError(`${where} (${id}) has no string label`);
  if (typeof value.quarantined !== 'boolean') {
    throw new VaultError(`${where} (${id}) has no boolean quarantined flag`);
  }
  if (typeof value.createdAtMs !== 'number' || typeof value.updatedAtMs !== 'number') {
    throw new VaultError(`${where} (${id}) has non-numeric timestamps`);
  }
  return value as unknown as StoredAccount;
}

/** Validate a list of folders one rule (or legacy group) claims, against every folder an earlier one
 *  already claimed (`seenKeys`, updated in place). Keyed on {@link folderUniquenessKey} — the same
 *  key the write guards use — so two spellings of one directory can never both load. */
function validateFolders(
  raw: unknown,
  where: string,
  seenKeys: Set<string>,
  platform: NodeJS.Platform,
): string[] {
  if (!Array.isArray(raw)) throw new VaultError(`${where} folders is not an array`);
  if (raw.length > MAX_RULE_FOLDERS) {
    throw new VaultError(`${where} holds ${raw.length} folders (max ${MAX_RULE_FOLDERS})`);
  }
  const folders: string[] = [];
  for (const folder of raw) {
    if (typeof folder !== 'string' || folder === '') {
      throw new VaultError(`${where} has a non-string folder`);
    }
    const key = folderUniquenessKey(folder, platform);
    if (seenKeys.has(key)) throw new VaultError(`folder ${folder} has more than one rule`);
    seenKeys.add(key);
    folders.push(folder);
  }
  return folders;
}

/** Validate a rule's include or exclude list: an array of distinct non-empty ids within the cap. */
function validateIdList(raw: unknown, where: string, field: 'include' | 'exclude'): string[] {
  if (!Array.isArray(raw)) throw new VaultError(`${where} ${field} is not an array`);
  if (raw.length > MAX_RULE_ACCOUNTS) {
    throw new VaultError(
      `${where} ${field} names ${raw.length} accounts (max ${MAX_RULE_ACCOUNTS})`,
    );
  }
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || id === '') {
      throw new VaultError(`${where} ${field} has a non-string account id`);
    }
    if (ids.includes(id)) throw new VaultError(`${where} ${field} names account ${id} twice`);
    ids.push(id);
  }
  return ids;
}

/** The fields of a rule (or legacy group) every schema shares: a plain object without forbidden keys,
 *  a string id and label, numeric timestamps. Returns the object for the caller's own fields. */
function validateEntryBase(
  value: unknown,
  where: string,
): Record<string, unknown> & {
  id: string;
  label: string;
  createdAtMs: number;
  updatedAtMs: number;
} {
  if (!isPlainObject(value)) throw new VaultError(`${where} is not an object`);
  assertNoForbiddenKeys(value, where);
  if (typeof value.id !== 'string' || value.id === '') {
    throw new VaultError(`${where} has no string id`);
  }
  if (typeof value.label !== 'string')
    throw new VaultError(`${where} (${value.id}) has no string label`);
  if (typeof value.createdAtMs !== 'number' || typeof value.updatedAtMs !== 'number') {
    throw new VaultError(`${where} (${value.id}) has non-numeric timestamps`);
  }
  return value as Record<string, unknown> & {
    id: string;
    label: string;
    createdAtMs: number;
    updatedAtMs: number;
  };
}

/**
 * Parse and STRICTLY validate `groups.json` in either schema, healing nothing and writing nothing.
 * A schema-1 file (set-bound groups) is validated by its own rules first — which still refuse what
 * they always refused — and then migrated in memory (see {@link migrateLegacyGroups}); the next write
 * persists it as schema 2. Any other schema version fails closed.
 */
function parseRulesFile(
  value: unknown,
  platform: NodeJS.Platform,
): { file: RulesFile; extras: RulesExtras } {
  if (!isPlainObject(value)) throw new VaultError('groups.json is not an object');
  assertNoForbiddenKeys(value, 'groups.json');
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation)) {
    throw new VaultError('groups.json generation is not an integer');
  }
  if (value.schemaVersion === LEGACY_GROUPS_SCHEMA_VERSION) {
    return migrateLegacyGroups(validateLegacyGroups(value, platform), value.generation);
  }
  if (
    value.schemaVersion !== RULES_SCHEMA_VERSION &&
    value.schemaVersion !== RULES_SCHEMA_VERSION_ALIASES
  ) {
    throw new VaultError(
      `groups.json has an unsupported schemaVersion (${JSON.stringify(value.schemaVersion)}); ` +
        'a newer build wrote it — this one refuses to read it rather than drop the rules it holds',
    );
  }
  return validateRulesFile(value, platform);
}

/**
 * Validate a schema-2 `groups.json`. Fails closed (named {@link VaultError}) on: a malformed
 * `reserved` list or row (see {@link validateMember}), a reserved id repeated, or more rows than the
 * cap; a rule that is not an object, carries a forbidden key, lacks its id/label/timestamps, or
 * repeats another rule's id; folders, include or exclude lists that are malformed or over the cap; a
 * folder held by two rules (after canonicalization); an include id that is not a reserved row; an
 * account both included and excluded by one rule; an `activeId` that is not null or a string; and
 * a reserved row no rule includes (an account is reserved exactly while some rule includes it, and
 * the move order never leaves one behind — a hand edit or corruption does).
 *
 * Deliberately NOT checked here: whether an exclude id or an `activeId` names an existing shared
 * account. A build that predates rules can remove a shared account without knowing any rule names
 * it; refusing the whole file for that would brick every command over an inert reference. Such an
 * exclude simply has no effect, and a stale `activeId` is reconciled by the slot logic.
 *
 * A login (`accountUuid`) repeated within `reserved` is accepted: it is the dedupe-able duplicate
 * {@link Vault.dedupeAccounts} collapses, and failing the load would make it unrepairable.
 */
function validateRulesFile(
  value: Record<string, unknown>,
  platform: NodeJS.Platform,
): { file: RulesFile; extras: RulesExtras } {
  const rawReserved = value.reserved;
  if (!Array.isArray(rawReserved)) throw new VaultError('groups.json reserved is not an array');
  if (rawReserved.length > MAX_RESERVED_ACCOUNTS) {
    throw new VaultError(
      `groups.json holds ${rawReserved.length} reserved accounts (max ${MAX_RESERVED_ACCOUNTS})`,
    );
  }
  const reserved: StoredAccount[] = [];
  for (let i = 0; i < rawReserved.length; i += 1) {
    const row = validateMember(rawReserved[i], `reserved[${i}]`);
    if (reserved.some((r) => r.id === row.id)) {
      throw new VaultError(`account ${row.id} is reserved twice`);
    }
    reserved.push(row);
  }

  const rawRules = value.rules;
  if (!Array.isArray(rawRules)) throw new VaultError('groups.json rules is not an array');
  if (rawRules.length > MAX_RULES) {
    throw new VaultError(`groups.json holds ${rawRules.length} rules (max ${MAX_RULES})`);
  }
  const seenFolderKeys = new Set<string>();
  const seenAliasKeys = new Set<string>();
  const rules: FolderRule[] = [];
  const extras: RulesExtras = {
    top: unownedFields(value, RULES_FILE_KEYS),
    byRule: new Map(),
    byAliasScope: new Map(),
  };
  for (let i = 0; i < rawRules.length; i += 1) {
    const where = `rules[${i}]`;
    const r = validateEntryBase(rawRules[i], where);
    if (rules.some((x) => x.id === r.id)) throw new VaultError(`rule id ${r.id} appears twice`);
    const ruleExtras = unownedFields(r, RULE_KEYS);
    if (Object.keys(ruleExtras).length > 0) extras.byRule.set(r.id, ruleExtras);
    const folders = validateFolders(r.folders, `${where} (${r.id})`, seenFolderKeys, platform);
    const aliases = validateAliasScopes(
      r.aliases,
      `${where} (${r.id})`,
      platform,
      seenAliasKeys,
      extras.byAliasScope,
    );
    const include = validateIdList(r.include, `${where} (${r.id})`, 'include');
    const exclude = validateIdList(r.exclude, `${where} (${r.id})`, 'exclude');
    for (const id of include) {
      if (!reserved.some((a) => a.id === id)) {
        throw new VaultError(`${where} (${r.id}) includes ${id}, which is not a reserved account`);
      }
      if (exclude.includes(id)) {
        throw new VaultError(`${where} (${r.id}) both includes and excludes ${id}`);
      }
    }
    const activeId = r.activeId;
    if (activeId !== null && (typeof activeId !== 'string' || activeId === '')) {
      throw new VaultError(`${where} (${r.id}) activeId is not an account id or null`);
    }
    rules.push({
      id: r.id,
      label: r.label,
      folders,
      // Kept only when non-empty, so a rule without alias scopes keeps the older file shape.
      ...(aliases.length > 0 ? { aliases } : {}),
      include,
      exclude,
      activeId,
      createdAtMs: r.createdAtMs,
      updatedAtMs: r.updatedAtMs,
    });
  }
  for (const row of reserved) {
    if (!rules.some((r) => r.include.includes(row.id))) {
      throw new VaultError(`reserved account ${row.id} is included by no rule`);
    }
  }
  return {
    file: {
      schemaVersion: rulesSchemaVersionFor(rules),
      generation: value.generation as number,
      reserved,
      rules,
    },
    extras,
  };
}

/** The schema tag a `groups.json` holding `rules` is written with (see
 *  {@link RULES_SCHEMA_VERSION_ALIASES}). */
function rulesSchemaVersionFor(rules: readonly FolderRule[]): RulesFile['schemaVersion'] {
  return rules.some((r) => (r.aliases?.length ?? 0) > 0)
    ? RULES_SCHEMA_VERSION_ALIASES
    : RULES_SCHEMA_VERSION;
}

/**
 * Validate one rule's optional `aliases` list, failing CLOSED like the rest of the file. Absent
 * reads as none. Each entry must be a plain object (no forbidden key) with a non-empty string folder
 * and a string alias whose {@link aliasKey} is non-empty and which is no longer than
 * {@link MAX_ALIAS_LENGTH}; its (folder, alias key) pair must not already be claimed by any rule —
 * `seen` carries the pairs across the whole file, keyed by {@link aliasScopeUniquenessKey}, the SAME
 * key the write guards use (so a write can never persist a file the next load rejects). An entry's
 * fields this build does not own go into `extras` under that key (see {@link RulesExtras}).
 */
function validateAliasScopes(
  raw: unknown,
  where: string,
  platform: NodeJS.Platform,
  seen: Set<string>,
  extras: Map<string, Record<string, unknown>>,
): StoredAliasScope[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new VaultError(`${where} aliases is not an array`);
  if (raw.length > MAX_RULE_ALIASES) {
    throw new VaultError(`${where} holds ${raw.length} session aliases (max ${MAX_RULE_ALIASES})`);
  }
  const out: StoredAliasScope[] = [];
  for (let k = 0; k < raw.length; k += 1) {
    const entry: unknown = raw[k];
    const at = `${where} aliases[${k}]`;
    if (!isPlainObject(entry)) throw new VaultError(`${at} is not an object`);
    assertNoForbiddenKeys(entry, at);
    const { folder, alias } = entry;
    if (typeof folder !== 'string' || folder === '') {
      throw new VaultError(`${at} has no string folder`);
    }
    if (typeof alias !== 'string' || aliasKey(alias) === '') {
      throw new VaultError(`${at} has no alias`);
    }
    if (alias.length > MAX_ALIAS_LENGTH) {
      throw new VaultError(`${at} alias is longer than ${MAX_ALIAS_LENGTH} characters`);
    }
    // The uniqueness key joins the two halves with a NUL, so a NUL inside either would let two
    // different scopes produce one key. The write path never stores one (the engine refuses control
    // characters); a hand-edited file carrying one is refused rather than keyed ambiguously.
    if (folder.includes('\u0000') || alias.includes('\u0000')) {
      throw new VaultError(`${at} contains a NUL character`);
    }
    const key = aliasScopeUniquenessKey(folder, alias, platform);
    if (seen.has(key)) {
      throw new VaultError(`session alias "${alias}" in ${folder} has more than one rule`);
    }
    seen.add(key);
    const entryExtras = unownedFields(entry, ALIAS_SCOPE_KEYS);
    if (Object.keys(entryExtras).length > 0) extras.set(key, entryExtras);
    out.push({ folder, alias });
  }
  return out;
}

/** A schema-1 group: a set of reserved rows bound to a set of folders. Only read, to migrate. */
interface LegacyGroup {
  id: string;
  label: string;
  members: StoredAccount[];
  activeId: string | null;
  folders: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

/** The top-level keys of a schema-1 file this build understood. */
const LEGACY_FILE_KEYS: ReadonlySet<string> = new Set(['schemaVersion', 'generation', 'groups']);
/** The keys of one schema-1 group this build understood. */
const LEGACY_GROUP_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'members',
  'activeId',
  'folders',
  'createdAtMs',
  'updatedAtMs',
]);

/**
 * Validate a schema-1 `groups.json` exactly as strictly as the build that wrote it did, failing
 * closed on: a group with no members (or over the cap); a member that fails {@link validateMember};
 * a member id or login (`accountUuid`) in two groups — one account placed in two slots, which the
 * set model never allowed and which this build refuses to guess its way out of; an `activeId` that
 * is not one of the group's own members; a folder bound twice. A login repeated WITHIN one group is
 * the dedupe-able duplicate and is accepted.
 */
function validateLegacyGroups(
  value: Record<string, unknown>,
  platform: NodeJS.Platform,
): { groups: LegacyGroup[]; extras: RulesExtras } {
  const rawGroups = value.groups;
  if (!Array.isArray(rawGroups)) throw new VaultError('groups.json groups is not an array');
  if (rawGroups.length > MAX_RULES) {
    throw new VaultError(`groups.json holds ${rawGroups.length} groups (max ${MAX_RULES})`);
  }
  const seenMemberIds = new Set<string>();
  const seenAccountUuids = new Set<string>();
  const seenFolderKeys = new Set<string>();
  const groups: LegacyGroup[] = [];
  const extras: RulesExtras = {
    top: unownedFields(value, LEGACY_FILE_KEYS),
    byRule: new Map(),
    byAliasScope: new Map(),
  };
  for (let i = 0; i < rawGroups.length; i += 1) {
    const where = `groups[${i}]`;
    const g = validateEntryBase(rawGroups[i], where);
    const groupExtras = unownedFields(g, LEGACY_GROUP_KEYS);
    if (Object.keys(groupExtras).length > 0) extras.byRule.set(g.id, groupExtras);
    if (!Array.isArray(g.members) || g.members.length === 0) {
      throw new VaultError(`${where} (${g.id}) has no members`);
    }
    if (g.members.length > MAX_RULE_ACCOUNTS) {
      throw new VaultError(
        `${where} (${g.id}) holds ${g.members.length} members (max ${MAX_RULE_ACCOUNTS})`,
      );
    }
    const members: StoredAccount[] = [];
    // Logins this group carries. A login repeated WITHIN one group is a dedupe-able duplicate, so it
    // is accepted; one that ALSO appears in an EARLIER group is not, so the cross-group check compares
    // against `seenAccountUuids` (prior groups only) and this set is merged in afterward.
    const thisGroupUuids = new Set<string>();
    for (let j = 0; j < g.members.length; j += 1) {
      const member = validateMember(g.members[j], `${where}.members[${j}]`);
      if (seenMemberIds.has(member.id)) {
        throw new VaultError(`account ${member.id} appears in more than one group`);
      }
      seenMemberIds.add(member.id);
      // Rows predating metadata capture carry no accountUuid; those are keyed by id alone (nothing to
      // compare) rather than colliding on `undefined`.
      if (member.accountUuid !== undefined) {
        if (seenAccountUuids.has(member.accountUuid)) {
          throw new VaultError(
            `account login ${member.accountUuid} appears in more than one group`,
          );
        }
        thisGroupUuids.add(member.accountUuid);
      }
      members.push(member);
    }
    for (const uuid of thisGroupUuids) seenAccountUuids.add(uuid);
    const activeId = g.activeId;
    if (activeId !== null) {
      if (typeof activeId !== 'string' || !members.some((m) => m.id === activeId)) {
        throw new VaultError(`${where} (${g.id}) activeId is not one of its members`);
      }
    }
    const folders = validateFolders(g.folders, `${where} (${g.id})`, seenFolderKeys, platform);
    groups.push({
      id: g.id,
      label: g.label,
      members,
      activeId,
      folders,
      createdAtMs: g.createdAtMs,
      updatedAtMs: g.updatedAtMs,
    });
  }
  return { groups, extras };
}

/**
 * Read a validated schema-1 file as folder rules: each group becomes ONE rule with the same id (so
 * its profile dir and slot id carry over), the same label, folders and live account, `include` = its
 * members in their stored order and `exclude` = []. Every member row moves to `reserved`. The
 * binding therefore keeps working unchanged, and now also inherits the shared pool once its members
 * are out. Unknown fields carry over at both levels, exactly as a schema-1 rewrite kept them.
 */
function migrateLegacyGroups(
  legacy: { groups: LegacyGroup[]; extras: RulesExtras },
  generation: number,
): { file: RulesFile; extras: RulesExtras } {
  const reserved: StoredAccount[] = [];
  const rules: FolderRule[] = [];
  for (const g of legacy.groups) {
    for (const m of g.members) if (!reserved.some((r) => r.id === m.id)) reserved.push(m);
    rules.push({
      id: g.id,
      label: g.label,
      folders: g.folders,
      include: g.members.map((m) => m.id),
      exclude: [],
      activeId: g.activeId,
      createdAtMs: g.createdAtMs,
      updatedAtMs: g.updatedAtMs,
    });
  }
  return {
    file: { schemaVersion: RULES_SCHEMA_VERSION, generation, reserved, rules },
    extras: legacy.extras,
  };
}

/**
 * The fields of `groups.json` this build does not own, carried forward on every rewrite — the same
 * forward-compatibility `accounts.json` already has for its top-level keys and rows. A build of the
 * same schema version that adds an optional field must not lose it the moment an older build touches
 * a rule (an ordinary switch rewrites the file). A change older builds must NOT carry forward blindly
 * bumps the schema version instead, which this build refuses to read at all.
 *
 * Kept beside the typed rules rather than on them, so nothing this build hands out (the CLI views,
 * the guard snapshot, the wire) ever carries a field it does not understand. A rule this build
 * removes takes its unknown fields with it; reserved rows keep theirs on the row, as shared rows do.
 */
interface RulesExtras {
  top: Record<string, unknown>;
  byRule: Map<string, Record<string, unknown>>;
  /** By the scope's {@link aliasScopeUniquenessKey} (unique across the file), so an entry's fields
   *  follow the scope wherever this build writes it. */
  byAliasScope: Map<string, Record<string, unknown>>;
}

/** The top-level keys of `groups.json` this build writes itself. */
const RULES_FILE_KEYS: ReadonlySet<string> = new Set([
  'schemaVersion',
  'generation',
  'reserved',
  'rules',
]);
/** The keys of one alias scope entry this build writes itself (see {@link StoredAliasScope}). */
const ALIAS_SCOPE_KEYS: ReadonlySet<string> = new Set(['folder', 'alias']);

/** The keys of one rule this build writes itself (see {@link FolderRule}). `aliases` is one of them
 *  although it is optional: this build owns it, so a rule whose last alias scope is removed loses the
 *  field — it must never be written back from the carried-forward extras. */
const RULE_KEYS: ReadonlySet<string> = new Set([
  'id',
  'label',
  'folders',
  'aliases',
  'include',
  'exclude',
  'activeId',
  'createdAtMs',
  'updatedAtMs',
]);

/** Every own field of `obj` whose key is not in `owned`, copied. (Forbidden prototype keys never
 *  reach here: the file is refused on them before this runs.) */
function unownedFields(
  obj: Record<string, unknown>,
  owned: ReadonlySet<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) if (!owned.has(key)) out[key] = obj[key];
  return out;
}

/**
 * Revision of the bundle -> registry-row mapping implemented by `applyBundleMetadata`, stamped
 * onto every row it accepts.
 *
 * Bump it whenever a field joins (or changes meaning in) `PlanKey`/`IdentityKey`. The registry is
 * a CACHE of what a bundle says, and it is only ever recomputed as a side effect of WRITING that
 * bundle — which happens on a token rotation and nowhere else, so a stored bundle can sit unread
 * for weeks. Without a stamp, a row written by a build that captured fewer fields is
 * indistinguishable from a row whose bundle genuinely carries none, so the missing fields can
 * never be backfilled and the account renders as unknown forever. With it, `needsMetadataBackfill`
 * names exactly the rows to recompute, once each.
 */
export const ACCOUNT_METADATA_REV = 1;

/**
 * How long the sweep leaves a row alone after an attempt to recompute it FAILED.
 *
 * Some rows can never be advanced by any amount of retrying — a half-removed account whose blob
 * is gone, or a vault copied from another machine whose blobs this one holds no key for. Those
 * rows stay behind `ACCOUNT_METADATA_REV` permanently, so a sweep gated on the revision alone
 * rescans them (and takes the credential lock to do it) on every single listing.
 *
 * Backing off on a TIMER rather than giving up permanently is deliberate: "cannot decrypt today"
 * is not "cannot decrypt ever". A restored blob or a re-paired machine makes the same row
 * repairable, and a permanent tombstone would leave it rendering as unknown with no way back
 * short of remove-and-re-add. An hour is short enough that such a repair is picked up within the
 * session that performed it, and long enough that a scripted listing loop cannot turn a broken
 * row into a stream of registry writes. A DELIBERATE repair does not wait for it at all:
 * `accounts add`/`relogin`/a switch all write the bundle, and any successful recompute clears the
 * back-off immediately.
 */
export const METADATA_BACKFILL_RETRY_MS = 60 * 60 * 1000;

/** Whether this row's derived metadata predates the current mapping and should be recomputed
 *  from its stored bundle now. Recomputation costs a decrypt and the credential lock, so this
 *  gate is what keeps the repair a one-time cost per row instead of a per-listing one — both for
 *  rows that repair successfully (stamped with the current revision) and for rows that cannot
 *  (stamped with a failure time, retried once `METADATA_BACKFILL_RETRY_MS` has passed).
 *
 *  A failure time in the FUTURE is treated as no back-off at all rather than one that expires
 *  after the wait: it can only come from a clock that has since moved backwards, and honouring it
 *  would suspend the repair for however far ahead the old clock ran. */
export function needsMetadataBackfill(account: StoredAccount, nowMs: number): boolean {
  if (account.metadataRev === ACCOUNT_METADATA_REV) return false;
  const failedAtMs = account.metadataBackfillFailedAtMs;
  if (failedAtMs === undefined) return true;
  return !(failedAtMs <= nowMs && nowMs - failedAtMs < METADATA_BACKFILL_RETRY_MS);
}

/** Registry fields that identify WHICH account a row is. Never removed by a bundle write, and
 *  only written at all once the block carrying them is accepted — see `identityMatches`. */
type IdentityKey = 'accountUuid' | 'emailAddress' | 'organizationUuid';

/** Registry fields describing an account's CURRENT plan/billing state — mutable, and meaningful
 *  by their absence. See `setOrDelete`. */
type PlanKey =
  | 'subscriptionType'
  | 'rateLimitTier'
  | 'organizationRateLimitTier'
  | 'billingType'
  | 'subscriptionCreatedAt'
  | 'claudeCodeTrialEndsAt';

/** Every field below is copied out of upstream JSON that nothing validates (`oauthAccount` is an
 *  open index-signature block read straight off `~/.claude.json`), so a value of any JSON type
 *  can arrive. The registry rows are typed as strings and rendered as strings, so a non-string
 *  is dropped at the boundary rather than persisted — otherwise one odd upstream value is stored
 *  permanently and throws in the renderer on every later `cctl accounts list`.
 *  `claudeCodeTrialEndsAt` rides the same guard: it is `string | null` upstream, and null (no
 *  active trial) must clear the field, which is exactly what "not a string" already means. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Set an identity anchor, or leave it alone when the block does not carry one. NEVER deletes.
 *
 *  These anchors gate correctness checks elsewhere — relogin attribution (a mismatch is fatal),
 *  `getActiveId()` reconciliation, usage-cache attribution, poll token ownership — and every one
 *  of those is written as "if present", so a missing anchor does not fail loudly, it silently
 *  turns the check off. Live config blocks legitimately arrive partial, so "not reported on this
 *  write" must never be read as "no longer true about this account".
 *
 *  Whether the block may be believed AT ALL is decided once, before any of these run — see
 *  `identityMatches`. Past that gate a changed value is a legitimately changed fact, not an
 *  intruder, so it is applied. Returns whether the row changed. */
function setIfPresent(account: StoredAccount, key: IdentityKey, value: unknown): boolean {
  const next = asString(value);
  if (next === undefined || account[key] === next) return false;
  account[key] = next;
  return true;
}

/** Whether a bundle's `oauthAccount` block may update this registry row at all.
 *
 *  Identity is validated ONCE, here, and on `accountUuid` alone, because that is the only field
 *  the guards downstream key on. A block whose uuid contradicts the stored one is not this
 *  account's, so NOTHING it carries may be believed: absorbing it would re-key the very row
 *  those guards compare a bundle AGAINST, and the contaminated bundle would then agree with its
 *  own row — turning a detectable mis-attribution into a permanently invisible one. Deciding
 *  this per field instead would also refuse a legitimately changed `emailAddress`, which is
 *  display metadata, not an identity gate; past this check the block is provably this account's
 *  and a renamed address should render, not be held back as if it were an intrusion.
 *
 *  An unproven block — either side missing a uuid — passes: live blocks legitimately arrive
 *  partial, and the writers that could hand over someone else's block are guarded where the
 *  handover happens (`adoptRotationIfNeeded`'s identity precedence, the relogin verb's fatal
 *  mismatch), not here.
 *
 *  The conflict is logged, not thrown: bundle writes carry rotated single-use tokens that must
 *  land no matter what, and turning a recoverable attribution problem into a failed refresh
 *  would lose one. */
function identityMatches(account: StoredAccount, acct: OauthAccount, log: Logger): boolean {
  const incoming = asString(acct.accountUuid);
  if (incoming === undefined || account.accountUuid === undefined) return true;
  if (account.accountUuid === incoming) return true;
  log.warn(
    { accountId: account.id, stored: account.accountUuid, refused: incoming },
    'bundle write carries a different account identity; leaving the registry row unchanged',
  );
  return false;
}

/** Set a plan/billing field, or DELETE it when the bundle no longer carries a value.
 *  Deleting matters as much as setting HERE and only here: a lapsed trial or a downgraded plan
 *  must disappear from the registry, not linger as a stale fact the CLI keeps rendering. Returns
 *  whether it changed, so callers can skip a pointless registry write. `exactOptionalPropertyTypes`
 *  forbids assigning an explicit `undefined`, hence the delete rather than a plain assignment. */
function setOrDelete(account: StoredAccount, key: PlanKey, value: unknown): boolean {
  const next = asString(value);
  if (next === undefined) {
    if (!(key in account)) return false;
    delete account[key];
    return true;
  }
  if (account[key] === next) return false;
  account[key] = next;
  return true;
}

/**
 * Copy the non-secret, bundle-DERIVED metadata onto a registry row so listing never has to
 * decrypt. Returns whether anything actually changed.
 *
 * Called on every path that rewrites a bundle, not just on account creation — otherwise the
 * registry is frozen at whatever the account looked like when it was added: accounts that
 * predate a newly captured field render as unknown forever (fixable only by remove + re-add),
 * and a plan upgrade or an expiring trial never shows up at all.
 *
 * `oauthAccount` is treated as authoritative ONLY when the bundle actually carries the block;
 * when it is absent the fields it feeds are left untouched rather than deleted, because some
 * write paths legitimately persist a credentials-only bundle and must not wipe good metadata.
 * Even when the block IS present it may not be this account's, so it is admitted or refused as
 * a whole by `identityMatches` before any of it is copied — a block that fails that check taints
 * the plan/billing fields alongside the identity ones, since the two arrive together.
 */
function applyBundleMetadata(
  account: StoredAccount,
  bundle: CredentialBundle,
  log: Logger,
): boolean {
  const acct = bundle.oauthAccount;
  if (acct !== undefined && !identityMatches(account, acct, log)) return false;

  // Stamped before any copying so it lands on every ACCEPTED write, including the credentials-only
  // early return below — the stamp records which mapping ran, not how much it happened to find.
  // A refused block (above) never reaches here: that row was not recomputed, so claiming it was
  // would suppress the backfill that eventually repairs it.
  let changed = account.metadataRev !== ACCOUNT_METADATA_REV;
  account.metadataRev = ACCOUNT_METADATA_REV;
  // The row just recomputed, so any record of an earlier failed attempt describes a state that no
  // longer exists. Dropping it here — rather than only in the sweep — means every write path
  // (a switch, a relogin, a token rotation) heals a backed-off row immediately instead of leaving
  // it waiting out a timer it no longer needs.
  if (account.metadataBackfillFailedAtMs !== undefined) {
    delete account.metadataBackfillFailedAtMs;
    changed = true;
  }
  const oauth = bundle.claudeAiOauth;
  changed = setOrDelete(account, 'subscriptionType', oauth.subscriptionType) || changed;
  changed = setOrDelete(account, 'rateLimitTier', oauth.rateLimitTier) || changed;

  if (acct === undefined) return changed;

  changed = setIfPresent(account, 'accountUuid', acct.accountUuid) || changed;
  changed = setIfPresent(account, 'emailAddress', acct.emailAddress) || changed;
  changed = setIfPresent(account, 'organizationUuid', acct.organizationUuid) || changed;
  changed =
    setOrDelete(account, 'organizationRateLimitTier', acct.organizationRateLimitTier) || changed;
  changed = setOrDelete(account, 'billingType', acct.billingType) || changed;
  changed = setOrDelete(account, 'subscriptionCreatedAt', acct.subscriptionCreatedAt) || changed;
  changed = setOrDelete(account, 'claudeCodeTrialEndsAt', acct.claudeCodeTrialEndsAt) || changed;
  return changed;
}

/**
 * The whole registry as one in-memory picture: the shared side (`accounts.json`) and the reserved
 * side with its rules (`groups.json`), already healed of a crash-mid-move duplicate. Every vault
 * mutator loads one of these, mutates the relevant slice, and persists ONLY the file(s) it touched.
 */
interface RegistryState {
  /** The shared account rows — `accounts.json` minus any row that is really reserved. */
  shared: StoredAccount[];
  /** The GLOBAL slot's active account (a shared id), or null. Reserved ids are healed to null. */
  activeId: string | null;
  /** Top-level keys of `accounts.json` this build does not own, kept verbatim so a future field an
   *  older-but-newer-than-this build writes survives our rewrites (`schemaVersion`/`activeId`/
   *  `accounts` are excluded — those we own). */
  unknownKeys: Record<string, unknown>;
  /** The reserved rows: every account some rule includes. */
  reserved: StoredAccount[];
  /** The folder rules. */
  rules: FolderRule[];
  /** `groups.json`'s generation; the next rules write is `generation + 1`. */
  generation: number;
  /** The fields of `groups.json` this build does not own, re-emitted on every rules write. */
  rulesExtras: RulesExtras;
  /** True when a reserved id (or a reserved global active id) still lingered in `accounts.json` and
   *  the next shared write must drop it. See {@link Vault.heal}. */
  needsSharedRewrite: boolean;
}

/** Every row in the one logical registry — shared rows plus the reserved rows — as a flat list, for
 *  the checks (label uniqueness, login uniqueness) that must see the whole namespace at once. */
/** The fields of an identity that are set, ready to spread onto a row: an absent field stays
 *  absent rather than becoming an explicit `undefined` key. */
function definedIdentity(identity: AccountIdentity): AccountIdentity {
  return {
    ...(identity.accountUuid !== undefined ? { accountUuid: identity.accountUuid } : {}),
    ...(identity.emailAddress !== undefined ? { emailAddress: identity.emailAddress } : {}),
    ...(identity.organizationUuid !== undefined
      ? { organizationUuid: identity.organizationUuid }
      : {}),
  };
}

function allRowsOf(st: RegistryState): StoredAccount[] {
  return [...st.shared, ...st.reserved];
}

/** Locate a row by id across both files. `reserved` says which file holds it — exactly the signal a
 *  mutator needs to pick which file to persist. */
function findRowIn(
  st: RegistryState,
  id: string,
): { row: StoredAccount; reserved: boolean } | undefined {
  const shared = st.shared.find((a) => a.id === id);
  if (shared) return { row: shared, reserved: false };
  const reserved = st.reserved.find((a) => a.id === id);
  if (reserved) return { row: reserved, reserved: true };
  return undefined;
}

/** Fold one {@link dedupeRows} pass into the caller's running report and removed-id set. */
function collectDedupe(report: DedupeReport, removed: Set<string>, result: DedupeCoreResult): void {
  report.merged.push(...result.merged);
  report.relabelled.push(...result.relabelled);
  for (const id of result.removedIds) removed.add(id);
}

/** A rule with nothing left to include or exclude has no reason to exist: its slot would be the
 *  global pool under another name. Mutations dissolve such a rule instead of writing it. */
function ruleIsEmpty(rule: Pick<FolderRule, 'include' | 'exclude'>): boolean {
  return rule.include.length === 0 && rule.exclude.length === 0;
}

export class Vault {
  /** Token fingerprints by the digest of the blob they were read from (see {@link readStoredTokens}).
   *  Filled for free wherever a bundle is decrypted or written, pruned to the current bundles on
   *  every full read. */
  private readonly printsByBlob = new Map<string, TokenPrints>();
  /** Why each bundle blob that could not be decrypted failed, by the blob's digest, pruned the same
   *  way. A bundle this machine cannot decrypt (a DPAPI master-key change, a restored backup) would
   *  otherwise be retried on every check, a PowerShell spawn each on Windows, and fail the same way
   *  every time. Keyed by digest, a bundle that is rewritten is simply tried again, and a decrypt
   *  that later succeeds elsewhere (readBundle) lands in printsByBlob, which is consulted first. In
   *  memory only, so a failure that was transient costs a new process one more attempt, never a
   *  bundle left out for good. */
  private readonly undecryptable = new Map<string, string>();

  constructor(
    private readonly vaultDir: string,
    private readonly protector: Protector,
    private readonly clock: () => number = Date.now,
    /** Where a refused identity block is surfaced (see `identityMatches`). Defaults to
     *  discarding it, so read-only vault handles and tests stay one-liners; the engine passes
     *  its own. */
    private readonly log: Logger = noopLogger,
    /** Selects the folder-key case rule for validating that no folder has two rules.
     *  A parameter (not a `process.platform` read) so a test can drive either rule. */
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // ---- registry (non-secret) ----

  /**
   * Load and validate BOTH registry files into one healed picture.
   *
   * Reads `accounts.json` (the shared side, same tolerant shape check as before) and `groups.json`
   * (the reserved side and the rules, validated STRICTLY by {@link parseRulesFile}, which also
   * migrates a schema-1 file in memory); a malformed file is refused by name and left untouched.
   * Then it HEALS a crash mid-move: the move primitives write one file before the other, so a crash
   * between can leave a reserved row in BOTH — the groups.json copy always wins (the account is
   * reserved), and the shared copy is dropped here (and flushed by {@link heal} or the next shared
   * write). A global `activeId` pointing at a now-reserved account is likewise healed to null.
   */
  private async loadState(): Promise<RegistryState> {
    const raw = await readJsonIfExists<unknown>(this.registryPath());
    // An older file may lack fields (they default), but a file whose shape is wrong is refused by
    // name and left exactly as it is: reading it as empty would have the next write replace the
    // operator's account index with nothing.
    if (raw !== undefined && !isRegistryShape(raw)) {
      throw new VaultError(
        `the account registry at ${this.registryPath()} is malformed (expected ` +
          '{"activeId": ..., "accounts": [...]}); fix the file or move it aside - it was left untouched',
      );
    }
    const reg = (raw ?? emptyRegistry()) as Record<string, unknown>;
    if (raw !== undefined) assertNoForbiddenKeys(reg, 'accounts.json');
    const sharedRows = ((reg.accounts as StoredAccount[] | undefined) ?? []).slice();
    let activeId = typeof reg.activeId === 'string' ? reg.activeId : null;
    // Everything except the three keys this build owns is preserved across writes.
    const unknownKeys: Record<string, unknown> = {};
    for (const key of Object.keys(reg)) {
      if (key === 'schemaVersion' || key === 'activeId' || key === 'accounts') continue;
      unknownKeys[key] = reg[key];
    }

    const rawRules = await readJsonIfExists<unknown>(this.rulesPath());
    const { file: rulesFile, extras: rulesExtras } =
      rawRules === undefined
        ? {
            file: {
              schemaVersion: RULES_SCHEMA_VERSION,
              generation: 0,
              reserved: [],
              rules: [],
            } satisfies RulesFile,
            extras: {
              top: {},
              byRule: new Map<string, Record<string, unknown>>(),
              byAliasScope: new Map<string, Record<string, unknown>>(),
            },
          }
        : parseRulesFile(rawRules, this.platform);

    // Heal: no shared row may duplicate a reserved account (groups.json wins), and the global active
    // id must never be a reserved account. Uniqueness is enforced on BOTH keys a row is identified
    // by: its `id` AND its login (`accountUuid`). Id alone is not enough — an OLDER cctl that
    // predates groups.json cannot see a reserved row, so `accounts add` of that same login writes a
    // fresh shared row under a NEW random id carrying the same accountUuid. Dropping on id would miss
    // it, leaving the reserved login back in the global pool: a global auto-switch candidate and a
    // network-refresh target that would rotate the login's single-use token out from under the rule
    // slot. So a shared row whose login matches any reserved row is dropped here too.
    const reservedIds = new Set(rulesFile.reserved.map((r) => r.id));
    const reservedUuids = new Set<string>();
    for (const r of rulesFile.reserved) {
      if (r.accountUuid !== undefined) reservedUuids.add(r.accountUuid);
    }
    let needsSharedRewrite = false;
    const droppedIds = new Set<string>();
    const shared = sharedRows.filter((a) => {
      if (
        reservedIds.has(a.id) ||
        (a.accountUuid !== undefined && reservedUuids.has(a.accountUuid))
      ) {
        needsSharedRewrite = true;
        droppedIds.add(a.id);
        return false;
      }
      return true;
    });
    // A global active id pointing at a reserved row (by id) or at a dropped duplicate row (by id) is
    // stale — the row it named is gone from the shared side, so the global slot has no valid seat.
    if (activeId !== null && (reservedIds.has(activeId) || droppedIds.has(activeId))) {
      activeId = null;
      needsSharedRewrite = true;
    }

    return {
      shared,
      activeId,
      unknownKeys,
      reserved: rulesFile.reserved,
      rules: rulesFile.rules,
      generation: rulesFile.generation,
      rulesExtras,
      needsSharedRewrite,
    };
  }

  /** The SHARED registry as the pre-split callers know it: `{ activeId, accounts }`, healed of any
   *  reserved row. Reserved accounts have MOVED to `groups.json`, so — by design — the global pool
   *  this returns never includes one, which is exactly what the downgrade fence needs. */
  async loadRegistry(): Promise<Registry> {
    const st = await this.loadState();
    return { activeId: st.activeId, accounts: st.shared };
  }

  /** Persist the shared side. Stamps the current schema version and re-emits any preserved unknown
   *  top-level keys, so an old row this build could not name survives and the file always carries a
   *  version tag going forward. */
  private async saveShared(st: RegistryState): Promise<void> {
    const out = {
      ...st.unknownKeys,
      schemaVersion: ACCOUNTS_SCHEMA_VERSION,
      activeId: st.activeId,
      accounts: st.shared,
    };
    await atomicWriteFile(this.registryPath(), JSON.stringify(out, null, 2));
  }

  /** Persist the reserved side and the rules, as schema 2 — or 3 while an alias scope exists (see
   *  {@link RULES_SCHEMA_VERSION_ALIASES}); a migrated schema-1 file is rewritten here — incrementing `generation` (the guard snapshot carries it, so a bump is what
   *  lets a stale snapshot be detected). Mutates `st.generation` to the value written so a caller
   *  that then writes the snapshot reports the right number. Fields this build does not own are
   *  written back where they were read (see {@link RulesExtras}); this build's own fields are spread
   *  last, so an unknown field can never shadow one of them. */
  private async saveRules(st: RegistryState): Promise<void> {
    st.generation += 1;
    const file: RulesFile = {
      schemaVersion: rulesSchemaVersionFor(st.rules),
      generation: st.generation,
      reserved: st.reserved,
      rules: st.rules,
    };
    const out = {
      ...st.rulesExtras.top,
      ...file,
      rules: st.rules.map((r) => ({
        ...st.rulesExtras.byRule.get(r.id),
        ...r,
        ...(r.aliases !== undefined
          ? {
              aliases: r.aliases.map((a) => ({
                ...st.rulesExtras.byAliasScope.get(
                  aliasScopeUniquenessKey(a.folder, a.alias, this.platform),
                ),
                ...a,
              })),
            }
          : {}),
      })),
    };
    await atomicWriteFile(this.rulesPath(), JSON.stringify(out, null, 2));
  }

  /**
   * Flush a pending crash-mid-move heal: rewrite `accounts.json` without a row that has since become
   * reserved (and clear a global active id that points at one). Returns whether it wrote.
   *
   * The window it closes matters to the fence: while a reserved row lingers in `accounts.json`, an
   * OLDER cctl that only reads that file would see it, poll it, and rotate its token — corrupting the
   * rule slot. Callers run this under the engine lock on start so the window is closed proactively
   * rather than only on the next shared write.
   */
  async heal(): Promise<boolean> {
    const st = await this.loadState();
    if (!st.needsSharedRewrite) return false;
    await this.saveShared(st);
    return true;
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return (await this.loadState()).shared;
  }

  /**
   * The one logical registry as a unified list: shared rows first, then the reserved rows, each
   * reserved row tagged with the ids of the rules including it. This is what the CLI's `accounts
   * list`, `doctor`, and the name resolver read — {@link listAccounts} stays SHARED-only because that
   * is the global pool.
   */
  async listAllAccounts(): Promise<AccountView[]> {
    const st = await this.loadState();
    const views: AccountView[] = st.shared.map((a) => ({ ...a }));
    for (const r of st.reserved) {
      views.push({ ...r, ruleIds: rulesIncluding(r.id, st.rules).map((rule) => rule.id) });
    }
    return views;
  }

  /** Find an account by id ACROSS the whole registry (shared or reserved). Returns the row itself
   *  (no rule tag); callers needing the tag use {@link listAllAccounts}. */
  async getAccount(id: string): Promise<StoredAccount | undefined> {
    const st = await this.loadState();
    return findRowIn(st, id)?.row;
  }

  /** The RAW registry record of the last committed GLOBAL switch. It can lag reality after a
   *  `/login` inside the Claude CLI — consumers who need "who is live right now" must use
   *  `SwitchEngine.getActiveId()`, which reconciles this against the live login identity. */
  async getActiveId(): Promise<string | null> {
    return (await this.loadState()).activeId;
  }

  // ---- folder rules (the reserved side) ----

  /** One consistent read of everything a slot decision needs: both sides of the registry, the
   *  rules, the global active id and the rules generation, from a single load. */
  async readPicture(): Promise<RegistryPicture> {
    const st = await this.loadState();
    return {
      shared: st.shared,
      reserved: st.reserved,
      rules: st.rules,
      activeId: st.activeId,
      generation: st.generation,
    };
  }

  /** Every folder rule, in file order. */
  async listRules(): Promise<FolderRule[]> {
    return (await this.loadState()).rules;
  }

  /** One folder rule by id, or undefined. */
  async getRule(id: string): Promise<FolderRule | undefined> {
    return (await this.loadState()).rules.find((r) => r.id === id);
  }

  /** The current `groups.json` generation — for the doctor's snapshot-freshness check. */
  async getRulesGeneration(): Promise<number> {
    return (await this.loadState()).generation;
  }

  /**
   * Create a folder rule on `folders`, including and/or excluding accounts. An included account
   * that is still shared is RESERVED: its row moves out of `accounts.json` into the reserved side;
   * one another rule already reserved is only referenced (those folders share it).
   *
   * Crash-safe ORDER — groups.json is written FIRST, then accounts.json. A crash between leaves the
   * moved rows in both files, which {@link loadState} heals toward the groups.json copy, so the
   * reservation is effectively committed the instant groups.json lands. Every refusal (see
   * {@link checkCreateRule}) happens before anything is written.
   */
  async createRule(opts: NewRuleOptions): Promise<FolderRule> {
    const st = await this.loadState();
    const plan = this.planNewRule(st, opts);
    const now = this.clock();
    // Stored terminal-safe, exactly as an account label is (see addAccount): the rule label is
    // rendered on the CLI, in the doctor, in the guard's decision text and in phone alerts, and an
    // operator types it freely. A label with nothing printable left falls back to the default.
    const firstAlias = plan.aliases[0];
    const label =
      sanitizeTerminalText(opts.label ?? '').trim() ||
      sanitizeTerminalText(
        plan.folders[0] ??
          (firstAlias !== undefined ? `session "${firstAlias.alias}" in ${firstAlias.folder}` : ''),
      ).trim() ||
      'folder rule';
    const rule: FolderRule = {
      id: randomUUID(),
      label,
      folders: plan.folders,
      ...(plan.aliases.length > 0 ? { aliases: plan.aliases } : {}),
      include: plan.include,
      exclude: plan.exclude,
      activeId: null,
      createdAtMs: now,
      updatedAtMs: now,
    };
    st.rules.push(rule);
    st.reserved.push(...plan.moved);
    await this.saveRules(st); // groups.json FIRST
    if (plan.moved.length > 0) {
      this.removeSharedRows(st, plan.moved);
      await this.saveShared(st); // accounts.json SECOND
    }
    return rule;
  }

  /**
   * Run every refusal {@link createRule} would make — rule count, account caps, folder conflicts,
   * accounts that are unknown, an exclusion of a reserved account, an account both included and
   * excluded — WITHOUT writing anything. For a caller whose rule creation is preceded by its own side
   * effects (an include moves the global slot off an account first): a request that was always going
   * to be refused is refused before anything moved, not after.
   */
  async checkCreateRule(opts: NewRuleOptions): Promise<void> {
    this.planNewRule(await this.loadState(), opts);
  }

  /** The shared validation behind {@link createRule} and {@link checkCreateRule}: throws the named
   *  refusal, else returns what would be written. Pure over `st`. */
  private planNewRule(
    st: RegistryState,
    opts: NewRuleOptions,
  ): {
    folders: string[];
    aliases: StoredAliasScope[];
    include: string[];
    exclude: string[];
    moved: StoredAccount[];
  } {
    if (st.rules.length >= MAX_RULES) {
      throw new VaultError(`cannot create another folder rule (max ${MAX_RULES})`);
    }
    const include = [...new Set(opts.include ?? [])];
    const exclude = [...new Set(opts.exclude ?? [])];
    if (include.length === 0 && exclude.length === 0) {
      throw new VaultError('a folder rule needs at least one account to include or exclude');
    }
    const folders = this.checkNewFolders(st, opts.folders, null);
    const aliases = this.checkNewAliases(st, opts.aliases ?? []);
    const draft: Pick<FolderRule, 'include' | 'exclude'> = { include: [], exclude: [] };
    const inc = this.planInclude(st, draft, include);
    this.checkExcludable(st, { ...draft, include }, exclude);
    return { folders, aliases, include, exclude, moved: inc.moved };
  }

  /**
   * Include accounts in an existing rule. A shared account is reserved (its row moves, groups.json
   * FIRST, then accounts.json — the order {@link createRule} uses); an account another rule already
   * reserved is only referenced; one this rule already includes is a no-op. An account the rule
   * excluded is moved from its exclude list to its include list (the newer instruction wins), and
   * reported as `unexcluded`. Writes nothing when nothing changes.
   */
  async includeAccounts(
    ruleId: string,
    accountIds: readonly string[],
  ): Promise<{ rule: FolderRule; reserved: string[]; unexcluded: string[] }> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    const plan = this.planInclude(st, rule, accountIds);
    if (plan.added.length === 0) return { rule, reserved: [], unexcluded: [] };
    const unexcluded = rule.exclude.filter((id) => plan.added.includes(id));
    rule.exclude = rule.exclude.filter((id) => !plan.added.includes(id));
    rule.include.push(...plan.added);
    rule.updatedAtMs = this.clock();
    st.reserved.push(...plan.moved);
    await this.saveRules(st); // groups.json FIRST
    if (plan.moved.length > 0) {
      this.removeSharedRows(st, plan.moved);
      await this.saveShared(st); // accounts.json SECOND
    }
    return { rule, reserved: plan.moved.map((m) => m.id), unexcluded };
  }

  /** Run every refusal {@link includeAccounts} would make, writing nothing. */
  async checkInclude(ruleId: string, accountIds: readonly string[]): Promise<void> {
    const st = await this.loadState();
    this.planInclude(st, this.mustRule(st, ruleId), accountIds);
  }

  /** What including `accountIds` in `rule` would add (`added`, in request order, without the ones
   *  already included) and which shared rows it would move to the reserved side (`moved`). Refuses an
   *  unknown id and a breach of the include or reserved caps. Pure over `st`. */
  private planInclude(
    st: RegistryState,
    rule: Pick<FolderRule, 'include' | 'exclude'>,
    accountIds: readonly string[],
  ): { added: string[]; moved: StoredAccount[] } {
    const added: string[] = [];
    const moved: StoredAccount[] = [];
    for (const id of accountIds) {
      if (rule.include.includes(id) || added.includes(id)) continue;
      const shared = st.shared.find((a) => a.id === id);
      if (shared) moved.push(shared);
      else if (!st.reserved.some((a) => a.id === id)) throw new UnknownAccountError(id);
      added.push(id);
    }
    if (rule.include.length + added.length > MAX_RULE_ACCOUNTS) {
      throw new VaultError(`a folder rule cannot include more than ${MAX_RULE_ACCOUNTS} accounts`);
    }
    if (st.reserved.length + moved.length > MAX_RESERVED_ACCOUNTS) {
      throw new VaultError(`cannot reserve more than ${MAX_RESERVED_ACCOUNTS} accounts`);
    }
    return { added, moved };
  }

  /**
   * Exclude shared accounts from an existing rule's pool. Only a SHARED account can be excluded: a
   * reserved one is already out of every pool but its own rules', so excluding it here is either a
   * no-op (another rule reserves it) or a contradiction (this rule includes it) — both refused by
   * name. Writes groups.json only (no row moves); nothing when every account is already excluded.
   */
  async excludeAccounts(
    ruleId: string,
    accountIds: readonly string[],
  ): Promise<{ rule: FolderRule; added: string[] }> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    const added = this.checkExcludable(st, rule, accountIds);
    if (added.length === 0) return { rule, added };
    rule.exclude.push(...added);
    rule.updatedAtMs = this.clock();
    await this.saveRules(st);
    return { rule, added };
  }

  /** Run every refusal {@link excludeAccounts} would make, writing nothing. */
  async checkExclude(ruleId: string, accountIds: readonly string[]): Promise<void> {
    const st = await this.loadState();
    this.checkExcludable(st, this.mustRule(st, ruleId), accountIds);
  }

  /** Validate an exclusion against `rule`, returning the ids it would newly add (request order,
   *  without ones already excluded). Refuses an unknown id, a reserved account (naming whether this
   *  rule or another reserves it), and a breach of the exclude cap. Pure over `st`. */
  private checkExcludable(
    st: RegistryState,
    rule: Pick<FolderRule, 'include' | 'exclude'>,
    accountIds: readonly string[],
  ): string[] {
    const added: string[] = [];
    for (const id of accountIds) {
      if (rule.exclude.includes(id) || added.includes(id)) continue;
      if (rule.include.includes(id)) {
        const label = findRowIn(st, id)?.row.label ?? id;
        throw new VaultError(
          `account "${label}" is included by this folder rule, so it cannot also be excluded; ` +
            'reset it there first',
        );
      }
      if (!st.shared.some((a) => a.id === id)) {
        const reserved = st.reserved.find((a) => a.id === id);
        if (reserved === undefined) throw new UnknownAccountError(id);
        throw new VaultError(
          `account "${reserved.label}" is reserved to ${describeRuleFolders(rulesIncluding(id, st.rules))}; ` +
            'only a shared account can be excluded',
        );
      }
      added.push(id);
    }
    if (rule.exclude.length + added.length > MAX_RULE_ACCOUNTS) {
      throw new VaultError(`a folder rule cannot exclude more than ${MAX_RULE_ACCOUNTS} accounts`);
    }
    return added;
  }

  /**
   * Remove accounts from a rule's include and/or exclude lists. An account no rule includes any
   * more is RELEASED back to the shared pool. ORDER is the reverse of a reservation: accounts.json is
   * written FIRST, then groups.json. A crash between leaves the rows in both files, which
   * {@link loadState} heals toward the groups.json copy — so an interrupted release safely REVERTS to
   * reserved rather than half-completing, and a rerun completes it.
   *
   * Refuses an id the rule neither includes nor excludes, and a removal that would leave the rule
   * empty: that is {@link removeRule}, whose caller tears the slot down first.
   */
  async removeFromRule(
    ruleId: string,
    accountIds: readonly string[],
  ): Promise<{ rule: FolderRule; released: string[] }> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    const ids = new Set(accountIds);
    for (const id of ids) {
      if (!rule.include.includes(id) && !rule.exclude.includes(id)) {
        const label = findRowIn(st, id)?.row.label ?? id;
        throw new VaultError(
          `account "${label}" is neither included nor excluded by the rule on ${describeRuleFolders([rule])}`,
        );
      }
    }
    const include = rule.include.filter((id) => !ids.has(id));
    const exclude = rule.exclude.filter((id) => !ids.has(id));
    if (ruleIsEmpty({ include, exclude })) {
      throw new VaultError('that would leave the folder rule empty; remove the rule instead');
    }
    const released = this.releasable(st, rule, [...ids]);
    if (released.length > 0) {
      st.shared.push(...released);
      await this.saveShared(st); // accounts.json FIRST
    }
    rule.include = include;
    rule.exclude = exclude;
    rule.updatedAtMs = this.clock();
    this.dropReservedRows(st, released);
    await this.saveRules(st); // groups.json SECOND
    return { rule, released: released.map((r) => r.id) };
  }

  /**
   * Remove a whole rule, releasing every account only it included — the same accounts.json-FIRST
   * order as {@link removeFromRule}, so an interrupted removal reverts to the rule still standing.
   * The caller tears the rule's slot down BEFORE this (adopt its rotation, clear its seat), so no
   * login is left live in a profile no rule owns.
   */
  async removeRule(ruleId: string): Promise<{ released: string[] }> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    const released = this.releasable(st, rule, rule.include);
    if (released.length > 0) {
      st.shared.push(...released);
      await this.saveShared(st); // accounts.json FIRST
    }
    st.rules = st.rules.filter((r) => r !== rule);
    this.dropReservedRows(st, released);
    await this.saveRules(st); // groups.json SECOND
    return { released: released.map((r) => r.id) };
  }

  /** The reserved rows among `ids` that `rule` includes and NO OTHER rule does: what removing them
   *  from `rule` returns to the shared pool. */
  private releasable(st: RegistryState, rule: FolderRule, ids: readonly string[]): StoredAccount[] {
    return st.reserved.filter(
      (row) =>
        ids.includes(row.id) &&
        rule.include.includes(row.id) &&
        !st.rules.some((other) => other !== rule && other.include.includes(row.id)),
    );
  }

  /** Remove an alias scope from a rule, matched by (folder key, alias key). Refuses the rule's LAST
   *  scope — removing it is {@link removeRule}, a separate decision. Drops the field entirely when
   *  the rule has no alias left, keeping the older file shape. */
  async removeAliasFromRule(ruleId: string, scope: StoredAliasScope): Promise<FolderRule> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    const key = aliasScopeUniquenessKey(scope.folder, scope.alias, this.platform);
    const before = rule.aliases ?? [];
    const kept = before.filter(
      (a) => aliasScopeUniquenessKey(a.folder, a.alias, this.platform) !== key,
    );
    if (kept.length === before.length) {
      throw new VaultError(
        `session alias "${scope.alias}" in ${scope.folder} is not in folder rule ${ruleId}`,
      );
    }
    if (kept.length === 0 && rule.folders.length === 0) {
      throw new VaultError(
        `session alias "${scope.alias}" in ${scope.folder} is the last scope of folder rule ` +
          `${ruleId}; remove the rule instead`,
      );
    }
    if (kept.length > 0) rule.aliases = kept;
    else delete rule.aliases;
    rule.updatedAtMs = this.clock();
    await this.saveRules(st);
    return rule;
  }

  /** Remove another (already-canonical) folder from a rule, compared by key. A rule left with no
   *  folders stays in place — removing it is {@link removeRule}, a separate decision. */
  async removeFolderFromRule(ruleId: string, folder: string): Promise<FolderRule> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    // Key on folderUniquenessKey (canonicalize-then-fold), the same key the write guards and the
    // load validator use, so a canonical query still removes a folder stored under another spelling.
    const key = folderUniquenessKey(folder, this.platform);
    const before = rule.folders.length;
    rule.folders = rule.folders.filter((f) => folderUniquenessKey(f, this.platform) !== key);
    if (rule.folders.length === before) {
      throw new VaultError(`folder ${folder} is not in folder rule ${ruleId}`);
    }
    rule.updatedAtMs = this.clock();
    await this.saveRules(st);
    return rule;
  }

  /** Set (or clear) which account is live in a rule's slot. A non-null id must be an account the
   *  rule's slot may hold: one it includes, or a shared account it does not exclude. */
  async setRuleActive(ruleId: string, accountId: string | null): Promise<FolderRule> {
    const st = await this.loadState();
    const rule = this.mustRule(st, ruleId);
    if (accountId !== null) {
      const row = findRowIn(st, accountId);
      if (!row) throw new UnknownAccountError(accountId);
      if (!slotMayHold(ruleSlotId(rule.id), accountId, st)) {
        throw new VaultError(
          `account "${row.row.label}" is not in the pool of the rule on ${describeRuleFolders([rule])}`,
        );
      }
    }
    rule.activeId = accountId;
    rule.updatedAtMs = this.clock();
    await this.saveRules(st);
    return rule;
  }

  /** Resolve a rule by id or throw a named error. */
  private mustRule(st: RegistryState, ruleId: string): FolderRule {
    const rule = st.rules.find((r) => r.id === ruleId);
    if (!rule) throw new VaultError(`no folder rule with id "${ruleId}"`);
    return rule;
  }

  /** Validate a set of NEW folders against the current rules: each must be a non-empty string,
   *  unique within the set, not already held by a DIFFERENT rule, and not already held by the rule
   *  being grown (`ignoreRuleId`). Returns them unchanged.
   *
   *  Keys on {@link folderUniquenessKey} — the SAME key {@link validateRulesFile} enforces at load.
   *  folderKey alone (case-fold only) would let two non-canonical spellings of one directory (a
   *  `C:/x` vs `C:\x` separator difference) both pass here yet collapse to one key at load; either way
   *  the write persists a `groups.json` the next load rejects, bricking every command until the file
   *  is hand-repaired. */
  private checkNewFolders(
    st: RegistryState,
    folders: readonly string[],
    ignoreRuleId: string | null,
  ): string[] {
    const otherRules = new Set<string>();
    const ownRule = new Set<string>();
    for (const r of st.rules) {
      const bucket = r.id === ignoreRuleId ? ownRule : otherRules;
      for (const f of r.folders) bucket.add(folderUniquenessKey(f, this.platform));
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const folder of folders) {
      if (typeof folder !== 'string' || folder === '') throw new VaultError('a folder is empty');
      const key = folderUniquenessKey(folder, this.platform);
      if (otherRules.has(key)) throw new VaultError(`folder ${folder} already has a folder rule`);
      if (ownRule.has(key)) throw new VaultError(`folder ${folder} is already in this folder rule`);
      if (seen.has(key)) throw new VaultError(`folder ${folder} is listed twice`);
      seen.add(key);
      out.push(folder);
    }
    if (out.length > MAX_RULE_FOLDERS) {
      throw new VaultError(`a folder rule cannot hold more than ${MAX_RULE_FOLDERS} folders`);
    }
    return out;
  }

  /** Validate NEW alias scopes against the current rules, mirroring {@link checkNewFolders}: each
   *  needs a non-empty folder and an alias with a non-empty {@link aliasKey}, whose trimmed text fits
   *  Claude Code's title length (a longer one never matches a session), no NUL, unique within the
   *  set, and not already held by any rule. Keys on {@link aliasScopeUniquenessKey}, the SAME key
   *  {@link validateRulesFile} enforces at load. Returns copies of the scopes. */
  private checkNewAliases(
    st: RegistryState,
    scopes: readonly StoredAliasScope[],
  ): StoredAliasScope[] {
    const held = new Set<string>();
    for (const r of st.rules) {
      for (const a of r.aliases ?? []) {
        held.add(aliasScopeUniquenessKey(a.folder, a.alias, this.platform));
      }
    }
    const seen = new Set<string>();
    const out: StoredAliasScope[] = [];
    for (const scope of scopes) {
      if (typeof scope.folder !== 'string' || scope.folder === '') {
        throw new VaultError('a session alias needs a folder');
      }
      if (typeof scope.alias !== 'string' || aliasKey(scope.alias) === '') {
        throw new VaultError('a session alias cannot be empty');
      }
      if (scope.alias.length > MAX_ALIAS_LENGTH || !aliasFitsSessionTitle(scope.alias)) {
        throw new VaultError(
          `a session alias cannot be longer than ${CLAUDE_CODE_TITLE_MAX_LENGTH} characters ` +
            '(Claude Code keeps only that much of a session name)',
        );
      }
      if (scope.folder.includes('\u0000') || scope.alias.includes('\u0000')) {
        throw new VaultError('a session alias cannot contain a NUL character');
      }
      const key = aliasScopeUniquenessKey(scope.folder, scope.alias, this.platform);
      const name = `session alias "${scope.alias}" in ${scope.folder}`;
      if (held.has(key)) throw new VaultError(`${name} already has a folder rule`);
      if (seen.has(key)) throw new VaultError(`${name} is listed twice`);
      seen.add(key);
      out.push({ folder: scope.folder, alias: scope.alias });
    }
    if (out.length > MAX_RULE_ALIASES) {
      throw new VaultError(
        `a folder rule cannot hold more than ${MAX_RULE_ALIASES} session aliases`,
      );
    }
    return out;
  }

  /** Drop moved rows from the shared side and clear a global active id that pointed at one. */
  private removeSharedRows(st: RegistryState, rows: readonly StoredAccount[]): void {
    const ids = new Set(rows.map((r) => r.id));
    st.shared = st.shared.filter((a) => !ids.has(a.id));
    if (st.activeId !== null && ids.has(st.activeId)) st.activeId = null;
  }

  /** Drop released rows from the reserved side (after the shared side gained them). */
  private dropReservedRows(st: RegistryState, rows: readonly StoredAccount[]): void {
    const ids = new Set(rows.map((r) => r.id));
    st.reserved = st.reserved.filter((a) => !ids.has(a.id));
  }

  // ---- account lifecycle ----

  /**
   * Create a new SHARED account: persist its encrypted bundle and a metadata row derived from the
   * bundle. Returns the generated id. Metadata is copied out of the bundle so listing never needs
   * to decrypt.
   *
   * The label/login collision checks run against the WHOLE registry (shared + reserved): a login
   * already reserved, or a label a reserved account carries, is refused here too, or the name
   * resolver could not tell the two apart. A newly added account is always shared — including it in
   * a folder rule is a separate step.
   *
   * `opts` is for a caller that knows more than the bundle says (an import): the auto-switch
   * exclusion lands in this same write, so no crash or lock timeout can leave the account stored
   * without it; and when the bundle carries no identity block at all, the identity the caller states
   * is recorded instead, so the row can be recognized again (a second import of it is then a no-op,
   * and the login refusal below applies to it).
   */
  async addAccount(
    label: string,
    bundle: CredentialBundle,
    opts: AddAccountOptions = {},
  ): Promise<StoredAccount> {
    const st = await this.loadState();
    // Strip terminal-interpreted controls (ANSI escapes, newlines, bidi/format controls) before the
    // label is stored — it is later rendered on the CLI, in Discord, and in the enforcement guard's
    // decision text, and a label is the one field an operator types freely.
    const next = sanitizeTerminalText(label).trim();
    if (next === '') throw new VaultError('a label cannot be empty');
    const allRows = allRowsOf(st);
    assertLabelFree(allRows, next, undefined);
    // The same login stored twice is the other way two rows come to answer to one name (and
    // to poll one quota twice). The identity block names the login; when it names a row that
    // is already here, that row is the one to refresh, never a second copy.
    const stated = bundle.oauthAccount === undefined ? opts.identity : undefined;
    const uuid = bundle.oauthAccount?.accountUuid ?? stated?.accountUuid;
    const stored = uuid !== undefined ? allRows.find((a) => a.accountUuid === uuid) : undefined;
    if (stored) {
      throw new VaultError(
        `this login is account ${stored.id} ("${stored.label}"), which is already stored; run ` +
          `\`cctl accounts relogin ${stored.label}\` to refresh it instead of adding a duplicate`,
      );
    }
    const now = this.clock();
    const account: StoredAccount = {
      id: randomUUID(),
      label: next,
      quarantined: false,
      ...(opts.autoSwitchExcluded === true ? { autoSwitchExcluded: true } : {}),
      createdAtMs: now,
      updatedAtMs: now,
    };
    // Plan/billing metadata is derived by the same helper every later bundle write uses, so a
    // freshly added account and a long-lived refreshed one can never disagree about how a
    // bundle maps onto a registry row. Every field is independently absent-safe: a provider
    // response missing one degrades to "unknown" in the CLI rather than crashing or forcing a
    // re-login (see planWeight() / `cctl accounts list` for how absence renders).
    applyBundleMetadata(account, bundle, this.log);
    if (stated !== undefined) Object.assign(account, definedIdentity(stated));
    // Writes the blob only — the row is not in the registry yet, so its metadata refresh is a
    // no-op here; `saveShared` below is what persists the row built above.
    await this.writeBundle(account.id, bundle);
    st.shared.push(account);
    await this.saveShared(st);
    return account;
  }

  /**
   * Create a SHARED account that has no credentials yet: a registry row carrying the identity it is
   * known by, and no encrypted bundle. It is stored quarantined with `reason`, which is exactly what
   * an account without a working login is to every reader: never a switch, refresh, poll or
   * auto-switch target, listed with its reason, and brought back by a re-login, which writes the
   * bundle and lifts the quarantine. The identity is what that re-login is checked against, so the
   * login that fills the row has to be the account it names.
   *
   * The same label and login refusals as {@link addAccount} apply, across the whole registry. The
   * row is stamped with the current metadata revision: there is no bundle to recompute it from, and
   * the first bundle write fills in the plan fields anyway. `opts.autoSwitchExcluded` is written in
   * the same write, as {@link addAccount} does.
   */
  async addPendingAccount(
    label: string,
    identity: AccountIdentity,
    reason: string,
    opts: Pick<AddAccountOptions, 'autoSwitchExcluded'> = {},
  ): Promise<StoredAccount> {
    const st = await this.loadState();
    const next = sanitizeTerminalText(label).trim();
    if (next === '') throw new VaultError('a label cannot be empty');
    const allRows = allRowsOf(st);
    assertLabelFree(allRows, next, undefined);
    const uuid = identity.accountUuid;
    const stored = uuid !== undefined ? allRows.find((a) => a.accountUuid === uuid) : undefined;
    if (stored) {
      throw new VaultError(
        `this login is account ${stored.id} ("${stored.label}"), which is already stored`,
      );
    }
    const now = this.clock();
    const account: StoredAccount = {
      id: randomUUID(),
      label: next,
      ...definedIdentity(identity),
      ...(opts.autoSwitchExcluded === true ? { autoSwitchExcluded: true } : {}),
      metadataRev: ACCOUNT_METADATA_REV,
      quarantined: true,
      quarantineReason: reason,
      quarantinedAtMs: now,
      createdAtMs: now,
      updatedAtMs: now,
    };
    st.shared.push(account);
    await this.saveShared(st);
    return account;
  }

  /**
   * Remove an account wherever it lives, and every reference to it: a shared row is dropped from
   * `accounts.json` (clearing the global active id if it pointed at it), a reserved row from the
   * reserved side; either way it leaves every rule's include and exclude list, a rule's active id that
   * named it is cleared, and a rule left with nothing to include or exclude is DISSOLVED (the caller
   * clears that rule's slot first). The encrypted bundle is removed either way.
   *
   * A shared removal writes accounts.json first: dying before groups.json follows leaves an exclude
   * or an active id naming an account that no longer exists, which is inert by design (see
   * {@link validateRulesFile}).
   */
  async removeAccount(id: string): Promise<void> {
    const st = await this.loadState();
    let sharedChanged = false;
    if (st.shared.some((a) => a.id === id)) {
      st.shared = st.shared.filter((a) => a.id !== id);
      if (st.activeId === id) st.activeId = null;
      sharedChanged = true;
    }
    const wasReserved = st.reserved.some((a) => a.id === id);
    st.reserved = st.reserved.filter((a) => a.id !== id);
    let rulesChanged = wasReserved;
    for (const rule of st.rules) {
      if (!rule.include.includes(id) && !rule.exclude.includes(id) && rule.activeId !== id)
        continue;
      rule.include = rule.include.filter((x) => x !== id);
      rule.exclude = rule.exclude.filter((x) => x !== id);
      if (rule.activeId === id) rule.activeId = null;
      rule.updatedAtMs = this.clock();
      rulesChanged = true;
    }
    st.rules = st.rules.filter((r) => !ruleIsEmpty(r));
    // The id was neither shared nor referenced, but a crash-mid-move heal may still be pending; flush
    // it so a removal request never leaves a half-moved row behind.
    if (sharedChanged || st.needsSharedRewrite) await this.saveShared(st);
    if (rulesChanged) await this.saveRules(st);
    await removeIfExists(this.bundlePath(id));
  }

  /** Mark the GLOBAL slot's active account (after a committed global switch). The id must be a
   *  SHARED account — a reserved account is made live in a rule's slot via {@link setRuleActive},
   *  never here. */
  async setActive(id: string): Promise<void> {
    const st = await this.loadState();
    if (!st.shared.some((a) => a.id === id)) throw new UnknownAccountError(id);
    st.activeId = id;
    await this.saveShared(st);
  }

  /** Quarantine an account whose refresh token is dead; it stays listed but unusable. */
  async quarantine(id: string, reason: string): Promise<void> {
    await this.patchAccount(id, (a) => {
      a.quarantined = true;
      a.quarantineReason = reason;
      a.quarantinedAtMs = this.clock();
    });
  }

  /** Clear quarantine after a successful re-login. */
  async clearQuarantine(id: string): Promise<void> {
    await this.patchAccount(id, (a) => {
      a.quarantined = false;
      delete a.quarantineReason;
      delete a.quarantinedAtMs;
    });
  }

  /** Take an account out of (or back into) the daemon's auto-switch target pool. Setting it
   *  false DELETES the key rather than storing `false`: absent already means "not excluded"
   *  everywhere that reads it, so the registry keeps only the accounts an operator actually
   *  chose to exclude instead of accumulating a default on every row. */
  async setAutoSwitchExcluded(id: string, excluded: boolean): Promise<void> {
    await this.patchAccount(id, (a) => {
      if (excluded) a.autoSwitchExcluded = true;
      else delete a.autoSwitchExcluded;
    });
  }

  /**
   * Give an account a new label. The label is a human alias and nothing more — the id, the
   * encrypted bundle and every daemon record keyed on the id are untouched, so a rename never
   * costs usage history or a re-login.
   *
   * Refuses a label another account already carries under case-insensitive comparison, and one
   * that spells any account's id: `resolveAccountRef` matches id first, then exact label, then
   * case-insensitive label, so either collision would leave one of the two accounts unreachable
   * by name (reported as ambiguous, or shadowed by the id match). Only OTHER rows count, so
   * re-casing an account's own label ("Work" -> "work") is an ordinary rename.
   */
  async renameAccount(id: string, label: string): Promise<StoredAccount> {
    // Same stripping as addAccount: a rename is the other place a label is typed freely.
    const next = sanitizeTerminalText(label).trim();
    if (next === '') throw new VaultError('a label cannot be empty');
    return this.patchAccount(id, (account, st) => {
      // Uniqueness is checked across the WHOLE registry — a name the resolver could confuse with a
      // reserved account is as unusable as one it confuses with a shared account.
      assertLabelFree(allRowsOf(st), next, id);
      account.label = next;
    });
  }

  /**
   * Resolve duplicates that predate the refusals in {@link addAccount}: the same login stored
   * twice is merged onto one row (the live one, else the most recently captured: a capture
   * always writes fresh tokens, whereas the registry's updated clock also moves on metadata
   * touches and says nothing about which tokens are newer), and two logins under one label keep the
   * earlier row's label while the later ones get a numbered suffix. Both leave every account
   * reachable by exactly one name.
   *
   * Run separately over the shared rows and over the reserved rows — every set that answers to the
   * one logical registry must be internally consistent — and in both the survivor is the row live in
   * any slot: a shared account may be live in a folder slot as well as the global one. A merged
   * row's references in the rules (include, exclude, active id) are re-pointed at the survivor. Only the files that actually changed are
   * rewritten (a clean vault is left byte-identical); a merged row's bundle is removed with it.
   */
  async dedupeAccounts(): Promise<DedupeReport> {
    const st = await this.loadState();
    const report: DedupeReport = { merged: [], relabelled: [] };
    const removed = new Set<string>();

    // Every slot's live account: a shared account can be live in a folder slot too (inherited, or in
    // an exclude-only folder), and the copy in use is the one kept wherever it is live.
    const live = new Set(
      [st.activeId, ...st.rules.map((r) => r.activeId)].filter((x): x is string => x !== null),
    );
    const sharedResult = dedupeRows(st.shared, live, this.clock);
    st.shared = sharedResult.rows;
    collectDedupe(report, removed, sharedResult.result);
    const reservedResult = dedupeRows(st.reserved, live, this.clock);
    st.reserved = reservedResult.rows;
    collectDedupe(report, removed, reservedResult.result);

    // Re-point every rule reference at the surviving row, keeping each list free of repeats and an
    // account out of an exclude list once it is (through the survivor) included.
    const survivor = new Map(report.merged.map((m) => [m.removedId, m.keptId]));
    let rulesChanged = reservedResult.result.changed;
    if (survivor.size > 0) {
      const remap = (ids: readonly string[]): string[] => [
        ...new Set(ids.map((id) => survivor.get(id) ?? id)),
      ];
      for (const rule of st.rules) {
        const include = remap(rule.include);
        const exclude = remap(rule.exclude).filter((id) => !include.includes(id));
        const activeId =
          rule.activeId === null ? null : (survivor.get(rule.activeId) ?? rule.activeId);
        if (
          !isDeepStrictEqual(include, rule.include) ||
          !isDeepStrictEqual(exclude, rule.exclude) ||
          activeId !== rule.activeId
        ) {
          Object.assign(rule, { include, exclude, activeId, updatedAtMs: this.clock() });
          rulesChanged = true;
        }
      }
    }

    if (sharedResult.result.changed) await this.saveShared(st);
    if (rulesChanged) await this.saveRules(st);
    if (removed.size > 0) for (const id of removed) await removeIfExists(this.bundlePath(id));
    return report;
  }

  /** Apply `mutate` to one registry row wherever it lives and persist the file that holds it. The
   *  whole loaded state rides along so a mutation can be validated against the OTHER rows under the
   *  same load — a rename checks for a label collision this way — instead of a second read that
   *  could see a different file. */
  private async patchAccount(
    id: string,
    mutate: (a: StoredAccount, st: RegistryState) => void,
  ): Promise<StoredAccount> {
    const st = await this.loadState();
    const found = findRowIn(st, id);
    if (!found) throw new UnknownAccountError(id);
    mutate(found.row, st);
    found.row.updatedAtMs = this.clock();
    if (found.reserved) await this.saveRules(st);
    else await this.saveShared(st);
    return found.row;
  }

  // ---- secret bundles (DPAPI) ----

  /** Decrypt and return an account's credential bundle. The token fingerprints of the blob it read
   *  are remembered on the way (see {@link readStoredTokens}), since the decrypt is already paid. */
  /** Whether an account has an encrypted bundle on disk at all — the one fact about a stored copy
   *  that does not need it to be readable. */
  async hasBundle(id: string): Promise<boolean> {
    try {
      await stat(this.bundlePath(id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  async readBundle(id: string): Promise<CredentialBundle> {
    let blob: string;
    try {
      blob = await readFile(this.bundlePath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError(`no encrypted bundle for account "${id}"`);
      }
      throw err;
    }
    const bundle = await this.decodeBundle(blob);
    this.printsByBlob.set(blobDigest(blob), tokenPrints(bundle.claudeAiOauth));
    return bundle;
  }

  /**
   * Fingerprints of the tokens every stored account's bundle holds right now — the one place that
   * can say whether a live token is some OTHER account's (see tokenPrints.ts for why this is not a
   * plain decrypt of every bundle).
   *
   * Each bundle blob is read (cheap) and looked up by its digest: first in memory, then in the index
   * file; only a blob neither has seen is decrypted. The index is rewritten when what is current
   * differs from what it holds, so it follows every rotation and only ever describes bundles that
   * exist. An account with no bundle holds nothing.
   *
   * One bundle that cannot be read (a directory or a file this user may not open in its place) or
   * decrypted never fails the whole answer: every caller — the slot check, the repair, rotation
   * adoption inside a switch — needs the other accounts' tokens, and one broken bundle must not
   * block a switch that has nothing to do with it. It is left out, with a warning, and listed in the
   * answer's `unreadable` so a report on the whole vault can say so. Left out, it cannot be
   * recognized as a holder — the behavior a check over it had before it existed. A blob that failed
   * to decrypt is not tried again until it changes (see {@link undecryptable}).
   */
  async readStoredTokens(): Promise<StoredTokens> {
    const st = await this.loadState();
    const persisted = await readPrintIndex(this.printsPath());
    const current = new Map<string, TokenPrints>();
    const failed = new Map<string, string>();
    const byAccount = new Map<string, TokenPrints>();
    const unreadable = new Map<string, string>();
    for (const row of allRowsOf(st)) {
      let blob: string;
      try {
        blob = await readFile(this.bundlePath(row.id), 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        const reason = err instanceof Error ? err.message : String(err);
        this.log.warn(
          { accountId: row.id, reason },
          'could not read a stored bundle to fingerprint its token; it is left out of the check',
        );
        unreadable.set(row.id, reason);
        continue;
      }
      const digest = blobDigest(blob);
      let prints = this.printsByBlob.get(digest) ?? persisted.get(digest);
      if (prints === undefined) {
        const decoded = await this.printsOrFailure(row.id, digest, blob);
        if (typeof decoded === 'string') {
          failed.set(digest, decoded);
          unreadable.set(row.id, decoded);
          continue;
        }
        prints = decoded;
      }
      current.set(digest, prints);
      byAccount.set(row.id, prints);
    }
    // Only what describes a bundle that exists now is kept, in memory and on disk.
    this.printsByBlob.clear();
    for (const [digest, prints] of current) this.printsByBlob.set(digest, prints);
    this.undecryptable.clear();
    for (const [digest, reason] of failed) this.undecryptable.set(digest, reason);
    const stale =
      persisted.size !== current.size || [...current.keys()].some((d) => !persisted.has(d));
    if (stale) {
      // A cache write that fails (another process replacing the same file this instant) costs a
      // decrypt next time, never a wrong answer — so it is not allowed to fail the caller.
      await writePrintIndex(this.printsPath(), current).catch((err: unknown) =>
        this.log.debug(
          { reason: err instanceof Error ? err.message : String(err) },
          'could not update the token fingerprint index',
        ),
      );
    }
    return new StoredTokens(byAccount, unreadable);
  }

  /** Decrypt `blob` for its token fingerprints, or say why it cannot be — without trying again a
   *  blob that already failed (see {@link undecryptable}). */
  private async printsOrFailure(
    accountId: string,
    digest: string,
    blob: string,
  ): Promise<TokenPrints | string> {
    const known = this.undecryptable.get(digest);
    if (known !== undefined) return known;
    try {
      return tokenPrints((await this.decodeBundle(blob)).claudeAiOauth);
    } catch (err) {
      // The wrapper's message only: its cause can be a JSON parse error quoting the plaintext.
      const reason = err instanceof Error ? err.message : String(err);
      this.log.warn(
        { accountId, reason },
        'could not decrypt a stored bundle to fingerprint its token; it is left out of the check ' +
          'until it changes',
      );
      return reason;
    }
  }

  /** Encrypt and persist an account's credential bundle, then refresh its metadata row via
   *  {@link syncMetadata} so the registry stays consistent with the bundle (e.g. after a token
   *  refresh).
   *
   *  ORDER IS DELIBERATE: the encrypted blob is written FIRST and unconditionally, because losing
   *  a rotated single-use token is unrecoverable whereas a stale derived row is cosmetic and
   *  self-heals on the next reconcile. The registry is only rewritten when a value actually
   *  changed, so routine token refreshes don't churn the file.
   *
   *  Because of that refresh this method is a registry read-modify-write, so like the other
   *  registry writers it MUST be called with the credential lock held (see the "registry
   *  mutators" note in switchEngine.ts) or a concurrent writer's update is silently lost. */
  async writeBundle(id: string, bundle: CredentialBundle): Promise<void> {
    ensureDir(join(this.vaultDir, id));
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.bundlePath(id), blob);
    this.printsByBlob.set(blobDigest(blob), tokenPrints(bundle.claudeAiOauth));
    await this.syncMetadata(id, bundle);
  }

  /**
   * Reconcile a registry row with a bundle the caller ALREADY holds decrypted, without touching
   * the encrypted blob. Returns whether the row changed.
   *
   * Exists because {@link writeBundle} was the only thing that ever refreshed a row, which ties
   * the freshness of derived metadata to token rotation — an unrelated event. Every path that
   * merely READS a bundle (activating an account whose token is still fresh, polling one that
   * needs no refresh, the backfill sweep) left the row at whatever mapping first wrote it, so a
   * field added later never appeared for an existing account no matter how often it was switched
   * to. Splitting the reconcile out lets those paths fix the row at no extra cost: they have
   * already paid for the decrypt, and nothing here can disturb a rotated token because nothing
   * here re-encrypts.
   *
   * Same contracts as `writeBundle`: a bundle whose identity block names a different account
   * refreshes nothing (see `identityMatches`), an id with no registry row is a no-op rather than
   * an error, and — being a registry read-modify-write — the credential lock MUST be held.
   */
  async syncMetadata(id: string, bundle: CredentialBundle): Promise<boolean> {
    const st = await this.loadState();
    const found = findRowIn(st, id);
    if (!found) return false;
    if (!applyBundleMetadata(found.row, bundle, this.log)) return false;
    found.row.updatedAtMs = this.clock();
    if (found.reserved) await this.saveRules(st);
    else await this.saveShared(st);
    return true;
  }

  /**
   * Record that a recompute of this row from its stored bundle could not be performed, so
   * {@link needsMetadataBackfill} stops selecting it until the back-off expires.
   *
   * Without this the sweep has no memory of trying: a row it can never advance stays selected,
   * and every later listing pays the scan and the credential lock again. `updatedAtMs` is
   * deliberately NOT bumped — nothing about the account changed, and this is bookkeeping about a
   * repair attempt, not a fact a user should see rendered as a recent update.
   *
   * An id with no registry row is a no-op rather than an error (the row may have been removed
   * since the scan), and — being a registry read-modify-write — the credential lock MUST be held.
   */
  async markMetadataBackfillFailed(id: string): Promise<void> {
    const st = await this.loadState();
    const found = findRowIn(st, id);
    if (!found) return;
    // Deliberately does NOT bump updatedAtMs (see doc above) — but the row still moves to the file
    // that holds it. A reserved row's failed-backfill mark belongs in groups.json, not accounts.json.
    found.row.metadataBackfillFailedAtMs = this.clock();
    if (found.reserved) await this.saveRules(st);
    else await this.saveShared(st);
  }

  // ---- rollback snapshot (mid-switch only) ----

  /** Encrypt and stash the current live credentials so a failed switch can restore them. */
  async writeRollback(bundle: CredentialBundle): Promise<void> {
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.rollbackPath(), blob);
  }

  async readRollback(): Promise<CredentialBundle | undefined> {
    let blob: string;
    try {
      blob = await readFile(this.rollbackPath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return this.decodeBundle(blob);
  }

  async clearRollback(): Promise<void> {
    await removeIfExists(this.rollbackPath());
  }

  private async decodeBundle(blob: string): Promise<CredentialBundle> {
    try {
      const plain = await this.protector.unprotect(blob);
      return JSON.parse(plain.toString('utf8')) as CredentialBundle;
    } catch (err) {
      throw new VaultError('failed to decrypt or parse credential bundle', { cause: err });
    }
  }

  // ---- folder-bindings snapshot (non-secret, for the enforcement guard) ----

  /**
   * Rebuild and atomically write `folder-bindings.json` from the current rules, and return what was
   * written. Callers run this LAST in every rule mutation and on daemon start, so the guard always
   * reads a snapshot no older than the last committed change. `enforce`, `mainConfigDir` and
   * `mainIdentityFile` come from the caller's policy/config; the profile-dir mapping is the vault's
   * own path convention.
   */
  async writeFolderBindings(opts: {
    enforce: BindEnforceMode;
    mainConfigDir: string;
    mainIdentityFile: string;
  }): Promise<FolderBindingSnapshot> {
    const st = await this.loadState();
    const snapshot = buildFolderBindingSnapshot({
      rules: st.rules,
      shared: st.shared,
      reserved: st.reserved,
      generation: st.generation,
      enforce: opts.enforce,
      mainConfigDir: opts.mainConfigDir,
      mainIdentityFile: opts.mainIdentityFile,
      profileDirOf: (ruleId) => groupProfileDir(this.vaultDir, ruleId),
      // The rules were validated under the vault's platform; their folders are canonicalized under
      // the same one.
      platform: this.platform,
    });
    await writeFolderBindingSnapshot(folderBindingsPath(this.vaultDir), snapshot);
    return snapshot;
  }

  /** Read the snapshot for a trusted cctl-side caller (the doctor's freshness check), or undefined
   *  when it has never been written. Validates strictly; the guard has its own fail-open reader. */
  async readFolderBindings(): Promise<FolderBindingSnapshot | undefined> {
    return readFolderBindingSnapshot(folderBindingsPath(this.vaultDir));
  }

  private registryPath(): string {
    return join(this.vaultDir, 'accounts.json');
  }
  /** `groups.json`: the file name predates folder rules and is kept, so the downgrade fence and the
   *  migration both find it where every earlier build put it. */
  private rulesPath(): string {
    return join(this.vaultDir, 'groups.json');
  }
  private bundlePath(id: string): string {
    return join(this.vaultDir, id, 'cred.enc');
  }
  private rollbackPath(): string {
    return join(this.vaultDir, '.rollback.enc');
  }
  private printsPath(): string {
    return join(this.vaultDir, 'token-prints.json');
  }
}
