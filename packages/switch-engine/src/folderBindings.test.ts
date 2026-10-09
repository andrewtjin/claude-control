import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.js';
import {
  buildFolderBindingSnapshot,
  folderBindingSnapshotContentEqual,
  readFolderBindingSnapshot,
} from './folderBindings.js';
import { folderBindingsPath, groupProfileDir } from './paths.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { VaultError } from './errors.js';
import type { CredentialBundle, FolderRule, StoredAccount } from './types.js';

let dirs: string[] = [];
async function vaultAt() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-fb-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, undefined, 'win32'),
    vaultDir,
    snapshotPath: folderBindingsPath(vaultDir),
  };
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: 999 },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@x.com' },
});

/** A reserved row as `groups.json` holds it. Only its label may reach the snapshot. */
function row(id: string, label: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label, quarantined: false, createdAtMs: 1, updatedAtMs: 1, ...extra };
}

/** A folder rule with the given include/exclude lists; every other field is fixture noise. */
function rule(
  id: string,
  include: string[],
  exclude: string[] = [],
  folders: string[] = ['C:\\work'],
): FolderRule {
  return {
    id,
    label: 'Work',
    folders,
    include,
    exclude,
    activeId: include[0] ?? null,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
}

describe('buildFolderBindingSnapshot (pure)', () => {
  it('projects rules to {folders, profileDir, included LABELS} and carries the envelope fields', () => {
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', ['m1', 'm2'])],
      reserved: [row('m1', 'A', { accountUuid: 'uuid-1' }), row('m2', 'B')],
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      groups: [
        {
          id: 'g1',
          label: 'Work',
          profileDir: 'C:\\profiles\\g1',
          folders: ['C:\\work'],
          members: ['A', 'B'],
        },
      ],
    });
  });

  it('lists members in INCLUDE order, not the order the reserved rows are stored in', () => {
    // The include list is the folder's preference order, which is what the guard's message should
    // show; the reserved side is ordered by when each row happened to be moved there.
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', ['m2', 'm1'])],
      reserved: [row('m1', 'A'), row('m2', 'B')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['B', 'A']);
  });

  it('gives an exclude-only rule a row with an empty member list, never the labels it excludes', () => {
    // The folder still runs in its own slot, so the guard needs its row; but an excluded account is
    // one the folder must NOT use, and naming it as a member would say the opposite.
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', [], ['s1'])],
      reserved: [],
      generation: 1,
      enforce: 'warn',
      mainConfigDir: 'C:\\m',
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    expect(snapshot.groups).toEqual([
      {
        id: 'g1',
        label: 'Work',
        profileDir: 'C:\\profiles\\g1',
        folders: ['C:\\work'],
        members: [],
      },
    ]);
  });

  it('labels only the included accounts of a rule that both includes and excludes', () => {
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', ['m1'], ['s1'])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['A']);
  });

  it('names an account several rules include in every one of their rows', () => {
    // Folders may share an included account; each folder's row must still say it uses it.
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', ['m1'], [], ['C:\\work']), rule('g2', ['m1', 'm2'], [], ['C:\\client'])],
      reserved: [row('m1', 'A'), row('m2', 'B')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups.map((g) => g.members)).toEqual([['A'], ['A', 'B']]);
  });

  it('drops an included id with no reserved row rather than printing a raw id', () => {
    // Members are labels only: an id with no row has no label, and the snapshot carries no ids.
    const snapshot = buildFolderBindingSnapshot({
      rules: [rule('g1', ['m1', 'gone'])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['A']);
  });

  it('carries no account ids and no token material', () => {
    const text = JSON.stringify(
      buildFolderBindingSnapshot({
        rules: [rule('g1', ['secret-id'], ['excluded-id'])],
        reserved: [row('secret-id', 'A', { accountUuid: 'uuid-secret' })],
        generation: 1,
        enforce: 'warn',
        mainConfigDir: 'C:\\m',
        profileDirOf: (id) => id,
      }),
    );
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('excluded-id');
    expect(text).not.toContain('uuid-secret');
    expect(text).toContain('"A"');
  });
});

describe('folderBindingSnapshotContentEqual (pure)', () => {
  const base = () =>
    buildFolderBindingSnapshot({
      rules: [rule('g1', ['m1'])],
      reserved: [row('m1', 'A')],
      generation: 5,
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });

  it('is equal when ONLY the generation differs (a routine rule-slot switch bumps generation)', () => {
    const a = base();
    const b = { ...base(), generation: 99 };
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(true);
  });

  it('is unequal when a ruled folder changes', () => {
    const a = base();
    const b = base();
    b.groups[0]!.folders = ['C:\\work', 'C:\\extra'];
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(false);
  });

  it('is unequal when the enforce mode changes', () => {
    const a = base();
    const b = { ...base(), enforce: 'off' as const };
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(false);
  });

  it('is unequal when a member label changes', () => {
    const a = base();
    const b = base();
    b.groups[0]!.members = ['someone-else'];
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(false);
  });

  it('is unequal when a rule is left with no included account', () => {
    const a = base();
    const b = base();
    b.groups[0]!.members = [];
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(false);
  });
});

describe('Vault.writeFolderBindings / readFolderBindings', () => {
  it('writes the snapshot beside the vault and reads it back with the live generation', async () => {
    const { v, vaultDir, snapshotPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const included = await v.createRule({ folders: ['C:\\work'], include: [a.id] });
    const excludeOnly = await v.createRule({ folders: ['C:\\other'], exclude: [b.id] });

    const written = await v.writeFolderBindings({ enforce: 'block', mainConfigDir: 'C:\\main' });
    expect(written.generation).toBe(await v.getRulesGeneration());
    expect(written.groups[0]?.profileDir).toBe(groupProfileDir(vaultDir, included.id));
    expect(written.groups[0]?.members).toEqual(['a']);
    // The exclude-only rule gets its row too (its folder runs in its own slot), naming no one.
    expect(written.groups[1]).toMatchObject({
      profileDir: groupProfileDir(vaultDir, excludeOnly.id),
      folders: ['C:\\other'],
      members: [],
    });

    const readBack = await v.readFolderBindings();
    expect(readBack).toEqual(written);
    // The file really is at the sibling location, not inside the vault dir.
    expect(await readFile(snapshotPath, 'utf8')).toContain('"schemaVersion": 1');
  });

  it('returns undefined when the snapshot was never written', async () => {
    const { v } = await vaultAt();
    expect(await v.readFolderBindings()).toBeUndefined();
  });
});

describe('readFolderBindingSnapshot — strict for trusted callers', () => {
  it('refuses an unsupported schemaVersion', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 2,
        generation: 1,
        enforce: 'off',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(VaultError);
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/schemaVersion/);
  });

  it('refuses an unknown enforce mode', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generation: 1,
        enforce: 'nope',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/enforce/);
  });

  it('refuses a non-integer generation', async () => {
    const { snapshotPath } = await vaultAt();
    await writeFile(
      snapshotPath,
      JSON.stringify({
        schemaVersion: 1,
        generation: 'x',
        enforce: 'off',
        mainConfigDir: 'x',
        groups: [],
      }),
      'utf8',
    );
    await expect(readFolderBindingSnapshot(snapshotPath)).rejects.toThrow(/generation/);
  });
});
