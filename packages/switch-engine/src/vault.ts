// The encrypted account vault + non-secret registry.
//
// Layout under `vaultDir`:
//   accounts.json        registry: active id + StoredAccount[] (non-secret metadata)
//   <id>/cred.enc        DPAPI-encrypted CredentialBundle for one account
//   .rollback.enc        DPAPI-encrypted snapshot of the previous live creds (mid-switch only)
//
// The registry is plaintext by design so the CLI can list accounts cheaply; it never holds
// a token. Secrets exist only inside the .enc blobs, which are useless off this machine/user.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AccountView,
  CredentialBundle,
  GroupsFile,
  OauthAccount,
  Registry,
  StoredAccount,
  StoredGroup,
} from './types.js';
import type { FolderBindingSnapshot } from './types.js';
import type { Protector } from './dpapi.js';
import { folderUniquenessKey } from './folderPath.js';
import { sanitizeTerminalText } from './terminalSafe.js';
import {
  buildFolderBindingSnapshot,
  readFolderBindingSnapshot,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
} from './folderBindings.js';
import { folderBindingsPath, groupProfileDir } from './paths.js';
import { atomicWriteFile, ensureDir, readJsonIfExists, removeIfExists } from './fsutil.js';
import { UnknownAccountError, VaultError } from './errors.js';
import { noopLogger, type Logger } from './logger.js';

/** What {@link Vault.dedupeAccounts} did, for the CLI to say out loud. */
export interface DedupeReport {
  /** Rows removed because another row already stored the same login. */
  merged: Array<{ label: string; keptId: string; removedId: string }>;
  /** Rows relabelled because they shared a label with a different login. */
  relabelled: Array<{ id: string; from: string; to: string }>;
}

/** Refuse a label another row already answers to (any case) or that spells an account id:
 *  `resolveAccountRef` matches id first, then exact label, then case-insensitive label, so
 *  either collision would leave one of the two accounts unreachable by name. `exceptId` is
 *  the row being renamed, whose own label is not a collision with itself.
 *
 *  Checked across ALL rows — shared AND reserved — because `resolveAccountRef` resolves a name
 *  against the one logical registry: a label a group member already carries must be as off-limits
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
 *  each group's members — every set of rows that answers to one logical registry must be internally
 *  consistent under the same rules (one row per login, one name per row). Mutates and returns `rows`
 *  in place; the caller persists only the sets that actually {@link DedupeCoreResult.changed}.
 *  `activeId` (the shared active id, or a group's) picks the survivor when the same login is stored
 *  twice, exactly as the single-file version did. */
interface DedupeCoreResult {
  removedIds: Set<string>;
  merged: DedupeReport['merged'];
  relabelled: DedupeReport['relabelled'];
  changed: boolean;
}
function dedupeRows(
  rows: StoredAccount[],
  activeId: string | null,
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
      group.find((r) => r.id === activeId) ??
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
 *  the group split is aware of; its ABSENCE is the legacy pre-split shape (see {@link Registry}). */
const ACCOUNTS_SCHEMA_VERSION = 2;
/** Schema tag for `groups.json`. Only value ever accepted on load — an unknown one fails closed
 *  rather than being read as a shape this build does not understand. */
const GROUPS_SCHEMA_VERSION = 1;

/**
 * Upper bounds on the group registry, enforced on every load and every mutation.
 *
 * These are refusal points, not capacity targets: the files are read into memory, parsed, and
 * (for the guard snapshot) copied around, so an unbounded count turns one hostile or corrupt file
 * into an out-of-memory or a wedged daemon. The numbers are far above any real fleet — dozens of
 * folders per group, dozens of groups — so a legitimate operator never meets them.
 */
export const MAX_GROUPS = 64;
export const MAX_GROUP_MEMBERS = 32;
export const MAX_GROUP_FOLDERS = 256;

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
 * lack derived fields, but every member here was moved out of a row this build created, so the full
 * required shape must be intact — a member missing its id or timestamps is corruption, not an old
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

/**
 * Parse and STRICTLY validate `groups.json`, healing nothing and writing nothing.
 *
 * Fails closed (named {@link VaultError}) on: a wrong top-level shape or schema version; a group
 * that is not an object or carries a forbidden key; a missing id/label; an over-cap or empty member
 * list (an empty group has no reason to exist and would leave `activeId` unsatisfiable); a member
 * that fails {@link validateMember}; a member id repeated across the whole file (two rows answering
 * to one account); a member login (`accountUuid`) repeated across the whole file (one login placed in
 * two group slots — both slots would attribute to it, double-counting its usage and making
 * resolution ambiguous); an `activeId` that is neither null nor one of the group's own members; an
 * over-cap folder list; or a folder that collides (by {@link folderUniquenessKey}, i.e. after
 * canonicalization) with one already claimed by any group. The caller separately heals a member id
 * that ALSO lingers in `accounts.json`.
 */
function validateGroupsFile(value: unknown, platform: NodeJS.Platform): GroupsFile {
  if (!isPlainObject(value)) throw new VaultError('groups.json is not an object');
  assertNoForbiddenKeys(value, 'groups.json');
  if (value.schemaVersion !== GROUPS_SCHEMA_VERSION) {
    throw new VaultError(
      `groups.json has an unsupported schemaVersion (${JSON.stringify(value.schemaVersion)}); ` +
        'a newer build wrote it — this one refuses to read it rather than drop the bindings it holds',
    );
  }
  if (typeof value.generation !== 'number' || !Number.isInteger(value.generation)) {
    throw new VaultError('groups.json generation is not an integer');
  }
  const rawGroups = value.groups;
  if (!Array.isArray(rawGroups)) throw new VaultError('groups.json groups is not an array');
  if (rawGroups.length > MAX_GROUPS) {
    throw new VaultError(`groups.json holds ${rawGroups.length} groups (max ${MAX_GROUPS})`);
  }

  const seenMemberIds = new Set<string>();
  const seenAccountUuids = new Set<string>();
  const seenFolderKeys = new Set<string>();
  const groups: StoredGroup[] = [];
  for (let i = 0; i < rawGroups.length; i += 1) {
    const g: unknown = rawGroups[i];
    const where = `groups[${i}]`;
    if (!isPlainObject(g)) throw new VaultError(`${where} is not an object`);
    assertNoForbiddenKeys(g, where);
    if (typeof g.id !== 'string' || g.id === '') throw new VaultError(`${where} has no string id`);
    if (typeof g.label !== 'string') throw new VaultError(`${where} (${g.id}) has no string label`);
    if (typeof g.createdAtMs !== 'number' || typeof g.updatedAtMs !== 'number') {
      throw new VaultError(`${where} (${g.id}) has non-numeric timestamps`);
    }
    if (!Array.isArray(g.members) || g.members.length === 0) {
      throw new VaultError(`${where} (${g.id}) has no members`);
    }
    if (g.members.length > MAX_GROUP_MEMBERS) {
      throw new VaultError(
        `${where} (${g.id}) holds ${g.members.length} members (max ${MAX_GROUP_MEMBERS})`,
      );
    }
    const members: StoredAccount[] = [];
    // Logins this group carries. A login repeated WITHIN one group is a dedupe-able duplicate that
    // `dedupeAccounts` collapses per group, so it is accepted here (failing closed would make it
    // unrepairable); a login that ALSO appears in an EARLIER group is not, so the cross-group check
    // compares against `seenAccountUuids` (prior groups only) and this set is merged in afterward.
    const thisGroupUuids = new Set<string>();
    for (let j = 0; j < g.members.length; j += 1) {
      const member = validateMember(g.members[j], `${where}.members[${j}]`);
      if (seenMemberIds.has(member.id)) {
        throw new VaultError(`account ${member.id} appears in more than one group`);
      }
      seenMemberIds.add(member.id);
      // A login (accountUuid) may reserve to at most one group. The same login in two groups places
      // the one logical login in two slots: both attribute to it (double-counting its usage) and
      // resolveAccountRef becomes ambiguous. Rows predating metadata capture carry no accountUuid;
      // those are keyed by id alone (nothing to compare) rather than colliding on `undefined`.
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
    const rawFolders = g.folders;
    if (!Array.isArray(rawFolders))
      throw new VaultError(`${where} (${g.id}) folders is not an array`);
    if (rawFolders.length > MAX_GROUP_FOLDERS) {
      throw new VaultError(
        `${where} (${g.id}) holds ${rawFolders.length} folders (max ${MAX_GROUP_FOLDERS})`,
      );
    }
    const folders: string[] = [];
    for (const folder of rawFolders) {
      if (typeof folder !== 'string' || folder === '') {
        throw new VaultError(`${where} (${g.id}) has a non-string folder`);
      }
      const key = folderUniquenessKey(folder, platform);
      if (seenFolderKeys.has(key)) {
        throw new VaultError(`folder ${folder} is bound by more than one group`);
      }
      seenFolderKeys.add(key);
      folders.push(folder);
    }
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
  return { schemaVersion: GROUPS_SCHEMA_VERSION, generation: value.generation, groups };
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
 * side (`groups.json`), already healed of a crash-mid-move duplicate. Every vault mutator loads one
 * of these, mutates the relevant slice, and persists ONLY the file(s) it touched.
 */
interface RegistryState {
  /** The shared account rows — `accounts.json` minus any row that is really a group member. */
  shared: StoredAccount[];
  /** The GLOBAL slot's active account (a shared id), or null. Reserved ids are healed to null. */
  activeId: string | null;
  /** Top-level keys of `accounts.json` this build does not own, kept verbatim so a future field an
   *  older-but-newer-than-this build writes survives our rewrites (`schemaVersion`/`activeId`/
   *  `accounts` are excluded — those we own). */
  unknownKeys: Record<string, unknown>;
  /** The reserved side. */
  groups: StoredGroup[];
  /** `groups.json`'s generation; the next groups write is `generation + 1`. */
  generation: number;
  /** True when a member id (or a reserved active id) still lingered in `accounts.json` and the next
   *  shared write must drop it. See {@link Vault.heal}. */
  needsSharedRewrite: boolean;
}

/** Every row in the one logical registry — shared rows plus every group's members — as a flat list,
 *  for the checks (label uniqueness, login uniqueness) that must see the whole namespace at once. */
function allRowsOf(st: RegistryState): StoredAccount[] {
  const rows = st.shared.slice();
  for (const g of st.groups) rows.push(...g.members);
  return rows;
}

/** Locate a row by id across both files. `group` is the group holding it, or undefined when the row
 *  is shared — which is exactly the signal a mutator needs to pick which file to persist. */
function findRowIn(
  st: RegistryState,
  id: string,
): { row: StoredAccount; group?: StoredGroup } | undefined {
  const shared = st.shared.find((a) => a.id === id);
  if (shared) return { row: shared };
  for (const g of st.groups) {
    const m = g.members.find((a) => a.id === id);
    if (m) return { row: m, group: g };
  }
  return undefined;
}

/** Fold one {@link dedupeRows} pass into the caller's running report and removed-id set. */
function collectDedupe(report: DedupeReport, removed: Set<string>, result: DedupeCoreResult): void {
  report.merged.push(...result.merged);
  report.relabelled.push(...result.relabelled);
  for (const id of result.removedIds) removed.add(id);
}

export class Vault {
  constructor(
    private readonly vaultDir: string,
    private readonly protector: Protector,
    private readonly clock: () => number = Date.now,
    /** Where a refused identity block is surfaced (see `identityMatches`). Defaults to
     *  discarding it, so read-only vault handles and tests stay one-liners; the engine passes
     *  its own. */
    private readonly log: Logger = noopLogger,
    /** Selects the folder-key case rule for validating that no folder is bound by two groups.
     *  A parameter (not a `process.platform` read) so a test can drive either rule. */
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  // ---- registry (non-secret) ----

  /**
   * Load and validate BOTH registry files into one healed picture.
   *
   * Reads `accounts.json` (the shared side, same tolerant shape check as before) and `groups.json`
   * (the reserved side, validated STRICTLY by {@link validateGroupsFile}); a malformed file is
   * refused by name and left untouched. Then it HEALS a crash mid-move: the move primitives write
   * one file before the other, so a crash between can leave a member's row in BOTH — the groups.json
   * copy always wins (the account is reserved), and the shared copy is dropped here (and flushed by
   * {@link heal} or the next shared write). A global `activeId` pointing at a now-reserved account is
   * likewise healed to null.
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

    const rawGroups = await readJsonIfExists<unknown>(this.groupsPath());
    const groupsFile: GroupsFile =
      rawGroups === undefined
        ? { schemaVersion: GROUPS_SCHEMA_VERSION, generation: 0, groups: [] }
        : validateGroupsFile(rawGroups, this.platform);

    // Heal: no shared row may duplicate a reserved account (groups.json wins), and the global active
    // id must never be a reserved account. Uniqueness is enforced on BOTH keys a row is identified
    // by: its `id` AND its login (`accountUuid`). Id alone is not enough — an OLDER cctl that
    // predates groups.json cannot see a reserved row, so `accounts add` of that same login writes a
    // fresh shared row under a NEW random id carrying the same accountUuid. Dropping on id would miss
    // it, leaving the reserved login back in the global pool: a global auto-switch candidate and a
    // network-refresh target that would rotate the login's single-use token out from under the group
    // slot. So a shared row whose login matches any reserved member is dropped here too.
    const memberIds = new Set<string>();
    const reservedUuids = new Set<string>();
    for (const g of groupsFile.groups) {
      for (const m of g.members) {
        memberIds.add(m.id);
        if (m.accountUuid !== undefined) reservedUuids.add(m.accountUuid);
      }
    }
    let needsSharedRewrite = false;
    const droppedIds = new Set<string>();
    const shared = sharedRows.filter((a) => {
      if (
        memberIds.has(a.id) ||
        (a.accountUuid !== undefined && reservedUuids.has(a.accountUuid))
      ) {
        needsSharedRewrite = true;
        droppedIds.add(a.id);
        return false;
      }
      return true;
    });
    // A global active id pointing at a reserved member (by id) or at a dropped duplicate row (by id)
    // is stale — the row it named is gone from the shared side, so the global slot has no valid seat.
    if (activeId !== null && (memberIds.has(activeId) || droppedIds.has(activeId))) {
      activeId = null;
      needsSharedRewrite = true;
    }

    return {
      shared,
      activeId,
      unknownKeys,
      groups: groupsFile.groups,
      generation: groupsFile.generation,
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

  /** Persist the reserved side, incrementing `generation` (the guard snapshot carries it, so a
   *  bump is what lets a stale snapshot be detected). Mutates `st.generation` to the value written
   *  so a caller that then writes the snapshot reports the right number. */
  private async saveGroups(st: RegistryState): Promise<void> {
    st.generation += 1;
    const file: GroupsFile = {
      schemaVersion: GROUPS_SCHEMA_VERSION,
      generation: st.generation,
      groups: st.groups,
    };
    await atomicWriteFile(this.groupsPath(), JSON.stringify(file, null, 2));
  }

  /**
   * Flush a pending crash-mid-move heal: rewrite `accounts.json` without a row that has since become
   * a group member (and clear a global active id that points at one). Returns whether it wrote.
   *
   * The window it closes matters to the fence: while a reserved row lingers in `accounts.json`, an
   * OLDER cctl that only reads that file would see it, poll it, and rotate its token — corrupting the
   * group slot. Callers run this under the engine lock on start so the window is closed proactively
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
   * The one logical registry as a unified list: shared rows first, then every group's members, each
   * member tagged with its `groupId`. This is what the CLI's `accounts list`, `doctor`, and the
   * name resolver read — {@link listAccounts} stays SHARED-only because that is the global pool.
   */
  async listAllAccounts(): Promise<AccountView[]> {
    const st = await this.loadState();
    const views: AccountView[] = st.shared.map((a) => ({ ...a }));
    for (const g of st.groups) {
      for (const m of g.members) views.push({ ...m, groupId: g.id });
    }
    return views;
  }

  /** Find an account by id ACROSS the whole registry (shared or reserved). Returns the row itself
   *  (no group tag); callers needing the tag use {@link listAllAccounts}. */
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

  // ---- groups (the reserved side) ----

  /** Every group, reserved side of the one logical registry. */
  async listGroups(): Promise<StoredGroup[]> {
    return (await this.loadState()).groups;
  }

  /** One group by id, or undefined. */
  async getGroup(id: string): Promise<StoredGroup | undefined> {
    return (await this.loadState()).groups.find((g) => g.id === id);
  }

  /** The current `groups.json` generation — for the doctor's snapshot-freshness check. */
  async getGroupsGeneration(): Promise<number> {
    return (await this.loadState()).generation;
  }

  /**
   * Create a new group by RESERVING shared accounts into it: their rows move out of `accounts.json`
   * and into a fresh group in `groups.json`.
   *
   * Crash-safe ORDER — groups.json is written FIRST, then accounts.json. A crash between leaves the
   * moved rows in both files, which {@link loadState} heals toward the groups.json copy, so the
   * reservation is effectively committed the instant groups.json lands. Refuses an empty member set,
   * a member that is unknown or already reserved elsewhere, a folder already bound to another group,
   * and any cap breach.
   */
  async createGroup(opts: {
    memberIds: readonly string[];
    folders?: readonly string[];
    label?: string;
  }): Promise<StoredGroup> {
    const st = await this.loadState();
    const { folders, moved } = this.validateNewGroup(st, opts);
    const now = this.clock();
    const label = opts.label?.trim() || moved.map((m) => m.label).join(', ');
    const group: StoredGroup = {
      id: randomUUID(),
      label,
      members: moved,
      activeId: null,
      folders,
      createdAtMs: now,
      updatedAtMs: now,
    };
    st.groups.push(group);
    await this.saveGroups(st); // groups.json FIRST
    this.removeSharedRows(st, opts.memberIds);
    await this.saveShared(st); // accounts.json SECOND
    return group;
  }

  /**
   * Run every refusal {@link createGroup} would make — group count, member count, folder conflicts,
   * members that are unknown or already reserved — WITHOUT writing anything. For a caller whose
   * group creation is preceded by its own side effects (a bind moves the global slot off a
   * to-be-member first): checking here first means a request that was always going to be refused
   * is refused before anything moved, not after.
   */
  async checkCreateGroup(opts: {
    memberIds: readonly string[];
    folders?: readonly string[];
  }): Promise<void> {
    this.validateNewGroup(await this.loadState(), opts);
  }

  /** The shared validation behind {@link createGroup} and {@link checkCreateGroup}: throws the named
   *  refusal, else returns the checked folders and the shared rows that would move. Pure over `st`. */
  private validateNewGroup(
    st: RegistryState,
    opts: { memberIds: readonly string[]; folders?: readonly string[] },
  ): { folders: string[]; moved: StoredAccount[] } {
    if (st.groups.length >= MAX_GROUPS) {
      throw new VaultError(`cannot create another group (max ${MAX_GROUPS})`);
    }
    if (opts.memberIds.length === 0) throw new VaultError('a group needs at least one member');
    if (opts.memberIds.length > MAX_GROUP_MEMBERS) {
      throw new VaultError(`a group cannot hold more than ${MAX_GROUP_MEMBERS} members`);
    }
    const folders = this.checkNewFolders(st, opts.folders ?? [], null);
    const moved = this.takeSharedRows(st, opts.memberIds);
    return { folders, moved };
  }

  /**
   * Reserve already-shared accounts INTO an existing group (grow its member set). Same crash-safe
   * order as {@link createGroup}: groups.json first, then accounts.json.
   */
  async reserveAccounts(groupId: string, memberIds: readonly string[]): Promise<StoredGroup> {
    const st = await this.loadState();
    const group = this.mustGroup(st, groupId);
    if (memberIds.length === 0) throw new VaultError('no accounts to reserve');
    if (group.members.length + memberIds.length > MAX_GROUP_MEMBERS) {
      throw new VaultError(`a group cannot hold more than ${MAX_GROUP_MEMBERS} members`);
    }
    const moved = this.takeSharedRows(st, memberIds);
    group.members.push(...moved);
    group.updatedAtMs = this.clock();
    await this.saveGroups(st); // groups.json FIRST
    this.removeSharedRows(st, memberIds);
    await this.saveShared(st); // accounts.json SECOND
    return group;
  }

  /**
   * Release members of a group back to the shared pool (the reverse move). ORDER is reversed too:
   * accounts.json is written FIRST, then groups.json. A crash between leaves the rows in both files,
   * which {@link loadState} heals toward the groups.json copy — so an interrupted release safely
   * REVERTS to reserved rather than half-completing. Dissolves the group when its last member leaves.
   */
  async releaseAccounts(groupId: string, memberIds: readonly string[]): Promise<void> {
    const st = await this.loadState();
    const group = this.mustGroup(st, groupId);
    if (memberIds.length === 0) return;
    const ids = new Set(memberIds);
    const released: StoredAccount[] = [];
    for (const id of ids) {
      const member = group.members.find((m) => m.id === id);
      if (!member) throw new VaultError(`account ${id} is not a member of group ${groupId}`);
      released.push(member);
    }
    st.shared.push(...released);
    await this.saveShared(st); // accounts.json FIRST
    group.members = group.members.filter((m) => !ids.has(m.id));
    if (group.activeId !== null && ids.has(group.activeId)) group.activeId = null;
    if (group.members.length === 0) st.groups = st.groups.filter((g) => g !== group);
    else group.updatedAtMs = this.clock();
    await this.saveGroups(st); // groups.json SECOND
  }

  /** Bind another (already-canonical) folder to a group. Refuses a folder any group already holds
   *  by its exact key; a nested subfolder is a different key and is allowed (longest-match wins at
   *  resolution). */
  async addFolderToGroup(groupId: string, canonicalFolder: string): Promise<StoredGroup> {
    const st = await this.loadState();
    const group = this.mustGroup(st, groupId);
    const folders = this.checkNewFolders(st, [canonicalFolder], groupId);
    if (group.folders.length >= MAX_GROUP_FOLDERS) {
      throw new VaultError(`a group cannot hold more than ${MAX_GROUP_FOLDERS} folders`);
    }
    group.folders.push(...folders);
    group.updatedAtMs = this.clock();
    await this.saveGroups(st);
    return group;
  }

  /** Remove a folder binding from a group (compared by key). A no-op group with zero folders is
   *  left in place — moving its members back is {@link releaseAccounts}, a separate decision. */
  async removeFolderFromGroup(groupId: string, folder: string): Promise<StoredGroup> {
    const st = await this.loadState();
    const group = this.mustGroup(st, groupId);
    // Key on folderUniquenessKey (canonicalize-then-fold), the same key bind and the load validator
    // use, so a canonical query still removes a folder stored under a non-canonical spelling.
    const key = folderUniquenessKey(folder, this.platform);
    const before = group.folders.length;
    group.folders = group.folders.filter((f) => folderUniquenessKey(f, this.platform) !== key);
    if (group.folders.length === before) {
      throw new VaultError(`folder ${folder} is not bound to group ${groupId}`);
    }
    group.updatedAtMs = this.clock();
    await this.saveGroups(st);
    return group;
  }

  /** Set (or clear) which member is live in a group's slot. A non-null id must be a member. */
  async setGroupActive(groupId: string, memberId: string | null): Promise<StoredGroup> {
    const st = await this.loadState();
    const group = this.mustGroup(st, groupId);
    if (memberId !== null && !group.members.some((m) => m.id === memberId)) {
      throw new UnknownAccountError(memberId);
    }
    group.activeId = memberId;
    group.updatedAtMs = this.clock();
    await this.saveGroups(st);
    return group;
  }

  /** Resolve a group by id or throw a named error. */
  private mustGroup(st: RegistryState, groupId: string): StoredGroup {
    const group = st.groups.find((g) => g.id === groupId);
    if (!group) throw new VaultError(`no group with id "${groupId}"`);
    return group;
  }

  /** Validate a set of NEW folders against the current bindings: each must be a non-empty string,
   *  unique within the set, not already held by a DIFFERENT group, and not already held by the group
   *  being grown (`ignoreGroupId`). Returns them unchanged.
   *
   *  Keys on {@link folderUniquenessKey} — the SAME key {@link validateGroupsFile} enforces at load.
   *  folderKey alone (case-fold only) would let two non-canonical spellings of one directory (a
   *  `C:/x` vs `C:\x` separator difference) both pass here yet collapse to one key at load, and would
   *  let the target group re-add its OWN folder; either way the write persists a `groups.json` the
   *  next load rejects, bricking every command until the file is hand-repaired. `ignoreGroupId` is
   *  still honoured — a group's own folders are checked as a self-collision, not a cross-group one, so
   *  the error names the right cause — but re-adding is refused rather than silently duplicated. */
  private checkNewFolders(
    st: RegistryState,
    folders: readonly string[],
    ignoreGroupId: string | null,
  ): string[] {
    const otherGroups = new Set<string>();
    const ownGroup = new Set<string>();
    for (const g of st.groups) {
      const bucket = g.id === ignoreGroupId ? ownGroup : otherGroups;
      for (const f of g.folders) bucket.add(folderUniquenessKey(f, this.platform));
    }
    const seen = new Set<string>();
    const out: string[] = [];
    for (const folder of folders) {
      if (typeof folder !== 'string' || folder === '') throw new VaultError('a folder is empty');
      const key = folderUniquenessKey(folder, this.platform);
      if (otherGroups.has(key))
        throw new VaultError(`folder ${folder} is already bound to another group`);
      if (ownGroup.has(key))
        throw new VaultError(`folder ${folder} is already bound to this group`);
      if (seen.has(key)) throw new VaultError(`folder ${folder} is listed twice`);
      seen.add(key);
      out.push(folder);
    }
    if (out.length > MAX_GROUP_FOLDERS) {
      throw new VaultError(`a group cannot hold more than ${MAX_GROUP_FOLDERS} folders`);
    }
    return out;
  }

  /** Look up shared rows to move into a group: every id must currently be a SHARED account (an
   *  unknown id, or one already reserved elsewhere, is refused by name). Returns the rows; the
   *  caller writes groups.json before {@link removeSharedRows} drops them from the shared side. */
  private takeSharedRows(st: RegistryState, memberIds: readonly string[]): StoredAccount[] {
    const rows: StoredAccount[] = [];
    for (const id of memberIds) {
      const shared = st.shared.find((a) => a.id === id);
      if (shared) {
        rows.push(shared);
        continue;
      }
      const owner = st.groups.find((g) => g.members.some((m) => m.id === id));
      if (owner) {
        throw new VaultError(`account ${id} is already reserved to group ${owner.id}`);
      }
      throw new UnknownAccountError(id);
    }
    return rows;
  }

  /** Drop moved rows from the shared side and clear a global active id that pointed at one. */
  private removeSharedRows(st: RegistryState, memberIds: readonly string[]): void {
    const ids = new Set(memberIds);
    st.shared = st.shared.filter((a) => !ids.has(a.id));
    if (st.activeId !== null && ids.has(st.activeId)) st.activeId = null;
  }

  // ---- account lifecycle ----

  /**
   * Create a new SHARED account: persist its encrypted bundle and a metadata row derived from the
   * bundle. Returns the generated id. Metadata is copied out of the bundle so listing never needs
   * to decrypt.
   *
   * The label/login collision checks run against the WHOLE registry (shared + reserved): a login
   * already reserved to a group, or a label a group member carries, is refused here too, or the
   * name resolver could not tell the two apart. A newly added account is always shared — reserving
   * it into a group is a separate {@link reserveAccounts} step.
   */
  async addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
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
    const uuid = bundle.oauthAccount?.accountUuid;
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
      createdAtMs: now,
      updatedAtMs: now,
    };
    // Plan/billing metadata is derived by the same helper every later bundle write uses, so a
    // freshly added account and a long-lived refreshed one can never disagree about how a
    // bundle maps onto a registry row. Every field is independently absent-safe: a provider
    // response missing one degrades to "unknown" in the CLI rather than crashing or forcing a
    // re-login (see planWeight() / `cctl accounts list` for how absence renders).
    applyBundleMetadata(account, bundle, this.log);
    // Writes the blob only — the row is not in the registry yet, so its metadata refresh is a
    // no-op here; `saveShared` below is what persists the row built above.
    await this.writeBundle(account.id, bundle);
    st.shared.push(account);
    await this.saveShared(st);
    return account;
  }

  /**
   * Remove an account wherever it lives. A shared row is dropped from `accounts.json` (clearing the
   * global active id if it pointed at it); a member is dropped from its group (clearing that group's
   * active id, and DISSOLVING the group when its last member leaves — a memberless group is invalid).
   * The encrypted bundle is removed either way.
   */
  async removeAccount(id: string): Promise<void> {
    const st = await this.loadState();
    let wrote = false;
    if (st.shared.some((a) => a.id === id)) {
      st.shared = st.shared.filter((a) => a.id !== id);
      if (st.activeId === id) st.activeId = null;
      await this.saveShared(st);
      wrote = true;
    } else {
      const group = st.groups.find((g) => g.members.some((m) => m.id === id));
      if (group) {
        group.members = group.members.filter((m) => m.id !== id);
        if (group.activeId === id) group.activeId = null;
        if (group.members.length === 0) st.groups = st.groups.filter((g) => g !== group);
        else group.updatedAtMs = this.clock();
        await this.saveGroups(st);
        wrote = true;
      }
    }
    // The id was neither shared nor reserved, but a crash-mid-move heal may still be pending; flush
    // it so a removal request never leaves a half-moved row behind.
    if (!wrote && st.needsSharedRewrite) await this.saveShared(st);
    await removeIfExists(this.bundlePath(id));
  }

  /** Mark the GLOBAL slot's active account (after a committed global switch). The id must be a
   *  SHARED account — a reserved account is made live in its own group's slot via
   *  {@link setGroupActive}, never here. */
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
   * twice is merged onto one row (the active one, else the most recently captured: a capture
   * always writes fresh tokens, whereas the registry's updated clock also moves on metadata
   * touches and says nothing about which tokens are newer), and two logins under one label keep the
   * earlier row's label while the later ones get a numbered suffix. Both leave every account
   * reachable by exactly one name.
   *
   * Run separately over the shared rows and over EACH group's members — every set that answers to
   * the one logical registry must be internally consistent, and a member's survivor is chosen by
   * its own group's active id, not the global one. Only the files that actually changed are
   * rewritten (a clean vault is left byte-identical); a merged row's bundle is removed with it.
   */
  async dedupeAccounts(): Promise<DedupeReport> {
    const st = await this.loadState();
    const report: DedupeReport = { merged: [], relabelled: [] };
    const removed = new Set<string>();

    const sharedResult = dedupeRows(st.shared, st.activeId, this.clock);
    st.shared = sharedResult.rows;
    collectDedupe(report, removed, sharedResult.result);
    let groupsChanged = false;
    for (const group of st.groups) {
      const res = dedupeRows(group.members, group.activeId, this.clock);
      group.members = res.rows;
      if (res.result.changed) {
        group.updatedAtMs = this.clock();
        groupsChanged = true;
      }
      collectDedupe(report, removed, res.result);
    }

    if (sharedResult.result.changed) await this.saveShared(st);
    if (groupsChanged) await this.saveGroups(st);
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
    if (found.group) {
      found.group.updatedAtMs = this.clock();
      await this.saveGroups(st);
    } else {
      await this.saveShared(st);
    }
    return found.row;
  }

  // ---- secret bundles (DPAPI) ----

  /** Decrypt and return an account's credential bundle. */
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
    return this.decodeBundle(blob);
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
    if (found.group) {
      found.group.updatedAtMs = this.clock();
      await this.saveGroups(st);
    } else {
      await this.saveShared(st);
    }
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
    // that holds it. A group member's failed-backfill mark belongs in groups.json, not accounts.json.
    found.row.metadataBackfillFailedAtMs = this.clock();
    if (found.group) await this.saveGroups(st);
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
   * Rebuild and atomically write `folder-bindings.json` from the current reserved side of the
   * registry, and return what was written. Callers run this LAST in every group mutation and on
   * daemon start, so the guard always reads a snapshot no older than the last committed change.
   * `enforce` and `mainConfigDir` come from the caller's policy/config; the profile-dir mapping is
   * the vault's own path convention.
   */
  async writeFolderBindings(opts: {
    enforce: BindEnforceMode;
    mainConfigDir: string;
  }): Promise<FolderBindingSnapshot> {
    const st = await this.loadState();
    const snapshot = buildFolderBindingSnapshot({
      groups: st.groups,
      generation: st.generation,
      enforce: opts.enforce,
      mainConfigDir: opts.mainConfigDir,
      profileDirOf: (groupId) => groupProfileDir(this.vaultDir, groupId),
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
  private groupsPath(): string {
    return join(this.vaultDir, 'groups.json');
  }
  private bundlePath(id: string): string {
    return join(this.vaultDir, id, 'cred.enc');
  }
  private rollbackPath(): string {
    return join(this.vaultDir, '.rollback.enc');
  }
}
