// The non-secret folder-bindings snapshot.
//
// The enforcement guard (a dependency-free hook Claude Code spawns on every prompt) cannot open the
// encrypted vault or import this package; it decides whether a session's config dir matches the
// folder it runs in by reading ONE small JSON file. This module builds that file from the reserved
// side of the registry and reads it back for cctl-side consumers (the doctor's freshness check).
//
// It carries NO tokens and NO account ids beyond a group's own id — only what a mismatch message
// needs: the bound folders, the group's profile dir, and the member LABELS. The guard's own reader
// lives in the hook script and is deliberately separate (it fails OPEN on any error); this reader is
// for trusted callers and validates strictly.

import type { FolderBindingSnapshot, FolderBindingSnapshotGroup, StoredGroup } from './types.js';
import { atomicWriteFile, readJsonIfExists } from './fsutil.js';
import { VaultError } from './errors.js';
import { aliasKey, canonicalStoredFolder, type ScopedGroup } from './folderPath.js';

/** A vault group's scopes in the shape the precedence rule (`resolveSessionBinding`) reads: its
 *  folders and alias folders in their canonical spelling ({@link canonicalStoredFolder}: a hand-edited
 *  `C:/x` is the same folder as `C:\x`), and its alias scopes reduced to their comparison keys. The
 *  one place a stored scope is turned into what matching compares, so the snapshot, the launcher and
 *  `where` cannot key it differently. `platform` selects the path rules. Pure. */
export function scopedGroupOf(
  group: StoredGroup,
  platform: NodeJS.Platform = process.platform,
): ScopedGroup {
  return {
    id: group.id,
    folders: group.folders.map((f) => canonicalStoredFolder(f, platform)),
    aliases: (group.aliases ?? []).map((a) => ({
      folder: canonicalStoredFolder(a.folder, platform),
      aliasKey: aliasKey(a.alias),
    })),
  };
}

/** How many scopes (folders + alias scopes) a group holds — the count that decides whether removing
 *  one dissolves it. */
export function groupScopeCount(group: StoredGroup): number {
  return group.folders.length + (group.aliases?.length ?? 0);
}

/**
 * A group's scopes as one display list: its folders, then `session "<alias>" in <folder>` per alias
 * scope. What refusals, alerts and the phone name a group by — a folder the operator acts on, not
 * the group label (which defaults to the member labels). Falls back to the label for a group with no
 * scope at all (the validator refuses one; this is only defensive). Unsanitized: every caller that
 * prints it to a terminal passes it through its own sink sanitizer.
 */
export function describeGroupScopes(group: StoredGroup): string {
  const parts = [
    ...group.folders,
    ...(group.aliases ?? []).map((a) => `session "${a.alias}" in ${a.folder}`),
  ];
  return parts.length > 0 ? parts.join(', ') : group.label;
}

/** Schema tag for `folder-bindings.json`. The guard treats an unknown value as "fail open"; this
 *  trusted reader treats it as a corrupt file and refuses it by name. */
const SNAPSHOT_SCHEMA_VERSION = 1;

/** How the guard should act on a session/folder mismatch. Mirrors the daemon's current policy and
 *  is copied into the snapshot so the guard never has to reach back into cctl's config. */
export type BindEnforceMode = 'block' | 'warn' | 'off';

/** Everything the pure {@link buildFolderBindingSnapshot} needs; kept as inputs (not read from the
 *  vault directly) so the builder stays testable and the caller controls the profile-dir mapping. */
export interface BuildSnapshotInput {
  groups: readonly StoredGroup[];
  /** Selects the path rules the stored folders are canonicalized under (default: this host's). */
  platform?: NodeJS.Platform;
  /** The `groups.json` generation these groups came from — carried so a stale snapshot is
   *  detectable against the live registry. */
  generation: number;
  enforce: BindEnforceMode;
  /** The main Claude Code config dir the global slot runs in (canonical). */
  mainConfigDir: string;
  /** Maps a group id to its on-disk profile dir; the guard matches a session's config dir against
   *  the value. Injected so the vault's path convention stays in one place (see `paths.ts`). */
  profileDirOf: (groupId: string) => string;
}

/**
 * Build the guard snapshot from the reserved side of the registry. Pure: no IO, so it is trivially
 * testable and the caller decides when to persist it. Every group becomes a row of
 * {folders, profileDir, member LABELS} — no member ids, no tokens.
 */
export function buildFolderBindingSnapshot(input: BuildSnapshotInput): FolderBindingSnapshot {
  const groups: FolderBindingSnapshotGroup[] = input.groups.map((g) => {
    // Canonical folders (the guard compares them by case-folded equality and containment only), and
    // alias keys only: the guard compares a lower-cased, trimmed title and never shows the typed alias.
    const scoped = scopedGroupOf(g, input.platform);
    return {
      id: g.id,
      label: g.label,
      profileDir: input.profileDirOf(g.id),
      folders: scoped.folders.slice(),
      aliases: (scoped.aliases ?? []).map((a) => ({ folder: a.folder, aliasKey: a.aliasKey })),
      members: g.members.map((m) => m.label),
    };
  });
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    generation: input.generation,
    enforce: input.enforce,
    mainConfigDir: input.mainConfigDir,
    groups,
  };
}

/**
 * Whether two snapshots are equal in the fields the guard actually reads — enforce mode, main config
 * dir, and every group's id/label/profileDir/folders/aliases/members. The `generation` is DELIBERATELY
 * ignored: it bumps on registry writes the guard never sees (a group's active member, metadata), and
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
    groups: s.groups.map((g) => ({
      id: g.id,
      label: g.label,
      profileDir: g.profileDir,
      folders: g.folders,
      // A snapshot written before alias scopes existed has no field; it means "none".
      aliases: g.aliases ?? [],
      members: g.members,
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
