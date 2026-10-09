// The non-secret folder-bindings snapshot.
//
// The enforcement guard (a dependency-free hook Claude Code spawns on every prompt) cannot open the
// encrypted vault or import this package; it decides whether a session's config dir matches the
// folder it runs in by reading ONE small JSON file. This module builds that file from the folder
// rules and reads it back for cctl-side consumers (the doctor's freshness check).
//
// It carries NO tokens, NO emails and NO account ids beyond a rule's own id — only what the guard's
// decisions and messages need: the ruled folders, the rule's profile dir, the LABELS of the accounts
// it includes, and, so the guard can tell which account a session on the global slot runs on, each
// stored account's label with one-way keys of the identity Claude Code records for a login
// (`oauthAccount.accountUuid` / `organizationUuid` in `.claude.json`), plus where that identity
// block lives for the global slot. The guard keys the live identity block the same way and compares
// keys, so recognizing a login never needs its ids written anywhere new. The guard's own reader lives in the hook script and is
// deliberately separate (it fails OPEN on any error); this reader is for trusted callers and
// validates strictly.

import type {
  FolderBindingSnapshot,
  FolderBindingSnapshotAccount,
  FolderBindingSnapshotGroup,
  FolderBindingSnapshotIdentity,
  FolderRule,
  StoredAccount,
} from './types.js';
import { createHash } from 'node:crypto';
import { atomicWriteFile, readJsonIfExists } from './fsutil.js';
import { VaultError } from './errors.js';

/** Schema tag for `folder-bindings.json`. The guard treats an unknown value as "fail open"; this
 *  trusted reader treats it as a corrupt file and refuses it by name. */
const SNAPSHOT_SCHEMA_VERSION = 1;

/** How the guard should act on a session/folder mismatch. Mirrors the daemon's current policy and
 *  is copied into the snapshot so the guard never has to reach back into cctl's config. */
export type BindEnforceMode = 'block' | 'warn' | 'off';

/** Everything the pure {@link buildFolderBindingSnapshot} needs; kept as inputs (not read from the
 *  vault directly) so the builder stays testable and the caller controls the profile-dir mapping. */
export interface BuildSnapshotInput {
  rules: readonly FolderRule[];
  /** The shared rows — what the global slot may hold, and what a rule's exclude list names. */
  shared: readonly StoredAccount[];
  /** The reserved rows the rules' include lists name — the source of the member labels. */
  reserved: readonly StoredAccount[];
  /** The `groups.json` generation these rules came from — carried so a stale snapshot is
   *  detectable against the live registry. */
  generation: number;
  enforce: BindEnforceMode;
  /** The main Claude Code config dir the global slot runs in (canonical). */
  mainConfigDir: string;
  /** The `.claude.json` the global slot's identity block lives in (`Paths.claudeJsonPath`). */
  mainIdentityFile: string;
  /** Maps a rule id to its on-disk profile dir; the guard matches a session's config dir against
   *  the value. Injected so the vault's path convention stays in one place (see `paths.ts`). */
  profileDirOf: (ruleId: string) => string;
}

/** The namespace every identity key is taken in, so a key is useless anywhere but here. The guard
 *  embeds the same string (see bindGuard.ts); a test proves the two agree end to end. */
export const SNAPSHOT_IDENTITY_KEY_PREFIX = 'cctl-guard-identity:';

/** The one-way key of an identity value (an account or organization uuid) as the snapshot carries
 *  it: hex SHA-256 of the namespaced value. */
export function snapshotIdentityKey(value: string): string {
  return createHash('sha256')
    .update(SNAPSHOT_IDENTITY_KEY_PREFIX + value, 'utf8')
    .digest('hex');
}

/** An account's label and identity keys, as the guard matches a live login against it. */
function identityOf(a: StoredAccount): FolderBindingSnapshotIdentity {
  return {
    label: a.label,
    ...(a.accountUuid !== undefined ? { accountKey: snapshotIdentityKey(a.accountUuid) } : {}),
    ...(a.organizationUuid !== undefined
      ? { organizationKey: snapshotIdentityKey(a.organizationUuid) }
      : {}),
  };
}

/**
 * Build the guard snapshot from the folder rules. Pure: no IO, so it is trivially testable and the
 * caller decides when to persist it. Every rule becomes a row of {folders, profileDir, LABELS of its
 * included accounts in include order, the identities of the shared accounts it excludes} — no tokens.
 * A rule that only excludes has an empty member list; the guard words its message for that case. An
 * excluded id naming no shared row is inert (see `FolderRule.exclude`) and is left out, exactly as
 * the pool leaves it out. Every stored account is listed once with the rules including it, so the
 * guard can name the account the global slot holds and tell a reserved one from a shared one.
 */
export function buildFolderBindingSnapshot(input: BuildSnapshotInput): FolderBindingSnapshot {
  const labelOf = (id: string): string | undefined =>
    input.reserved.find((a) => a.id === id)?.label;
  const groups: FolderBindingSnapshotGroup[] = input.rules.map((r) => ({
    id: r.id,
    label: r.label,
    profileDir: input.profileDirOf(r.id),
    folders: r.folders.slice(),
    members: r.include.map(labelOf).filter((l): l is string => l !== undefined),
    excluded: r.exclude
      .map((id) => input.shared.find((a) => a.id === id))
      .filter((a): a is StoredAccount => a !== undefined)
      .map(identityOf),
  }));
  const accounts: FolderBindingSnapshotAccount[] = [...input.shared, ...input.reserved].map(
    (a) => ({
      ...identityOf(a),
      ruleIds: input.rules.filter((r) => r.include.includes(a.id)).map((r) => r.id),
    }),
  );
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generation: input.generation,
    enforce: input.enforce,
    mainConfigDir: input.mainConfigDir,
    mainIdentityFile: input.mainIdentityFile,
    accounts,
    groups,
  };
}

/**
 * Whether two snapshots are equal in the fields the guard actually reads — enforce mode, main config
 * dir and identity file, the stored accounts' identities, and every rule's
 * id/label/profileDir/folders/members/excluded. The `generation` is DELIBERATELY
 * ignored: it bumps on registry writes the guard never sees (a rule's live account, metadata), and
 * comparing it would report a snapshot as stale after a routine switch even though nothing the guard
 * enforces changed. Pure.
 */
export function folderBindingSnapshotContentEqual(
  a: FolderBindingSnapshot,
  b: FolderBindingSnapshot,
): boolean {
  return guardRelevantKey(a) === guardRelevantKey(b);
}

/** A deterministic string of only the guard-relevant fields, for content comparison. */
function guardRelevantKey(s: FolderBindingSnapshot): string {
  return JSON.stringify({
    enforce: s.enforce,
    mainConfigDir: s.mainConfigDir,
    mainIdentityFile: s.mainIdentityFile ?? null,
    accounts:
      s.accounts?.map((a) => [
        a.label,
        a.accountKey ?? null,
        a.organizationKey ?? null,
        a.ruleIds,
      ]) ?? null,
    groups: s.groups.map((g) => ({
      id: g.id,
      label: g.label,
      profileDir: g.profileDir,
      folders: g.folders,
      members: g.members,
      excluded:
        g.excluded?.map((e) => [e.label, e.accountKey ?? null, e.organizationKey ?? null]) ?? null,
    })),
  });
}

/** Atomically write the snapshot. Non-secret, so it uses the ordinary 0o644 file mode rather than
 *  the vault's 0o600 — the guard runs as the same user, but the file is meant to be plainly
 *  readable and carries nothing sensitive. */
export async function writeFolderBindingSnapshot(
  path: string,
  snapshot: FolderBindingSnapshot,
): Promise<void> {
  await atomicWriteFile(path, JSON.stringify(snapshot, null, 2), 0o644);
}

/**
 * Read and validate the snapshot for a TRUSTED caller (returns undefined when absent). Strict on
 * shape and schema version — a malformed or newer-schema file is refused by name rather than acted
 * on. The guard does NOT use this: its own reader fails open on the same conditions, because a
 * missing or unreadable snapshot must never block a prompt.
 */
export async function readFolderBindingSnapshot(
  path: string,
): Promise<FolderBindingSnapshot | undefined> {
  const raw = await readJsonIfExists<unknown>(path);
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new VaultError(`${path} is not an object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new VaultError(
      `${path} has an unsupported schemaVersion (${JSON.stringify(obj.schemaVersion)})`,
    );
  }
  if (typeof obj.generation !== 'number' || !Number.isInteger(obj.generation)) {
    throw new VaultError(`${path} generation is not an integer`);
  }
  if (obj.enforce !== 'block' && obj.enforce !== 'warn' && obj.enforce !== 'off') {
    throw new VaultError(`${path} enforce is not block|warn|off`);
  }
  if (typeof obj.mainConfigDir !== 'string') {
    throw new VaultError(`${path} mainConfigDir is not a string`);
  }
  if (!Array.isArray(obj.groups)) throw new VaultError(`${path} groups is not an array`);
  // The rows are shaped by our own writer; a trusted reader trusts their inner shape once the
  // envelope validates, so no per-field re-check here (the guard, reading an untrusted file, does
  // its own defensive parse).
  return obj as unknown as FolderBindingSnapshot;
}
