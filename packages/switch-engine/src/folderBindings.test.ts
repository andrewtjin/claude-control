import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.js';
import { createHash } from 'node:crypto';
import {
  buildFolderBindingSnapshot,
  folderBindingSnapshotContentEqual,
  readFolderBindingSnapshot,
  snapshotIdentityKey,
} from './folderBindings.js';
import { resolveFolderRule, resolveSessionRule } from './folderRules.js';
import { resolveSessionBinding } from './folderPath.js';
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
/** Where the fixtures say the global slot's identity block lives. */
const ID_FILE = 'C:/Users/me/.claude.json';

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
      shared: [],
      rules: [rule('g1', ['m1', 'm2'])],
      reserved: [row('m1', 'A', { accountUuid: 'uuid-1' }), row('m2', 'B')],
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    expect(snapshot).toEqual({
      schemaVersion: 1,
      generation: 7,
      enforce: 'block',
      mainConfigDir: 'C:\\Users\\me\\.claude',
      mainIdentityFile: ID_FILE,
      accounts: [
        { label: 'A', accountKey: snapshotIdentityKey('uuid-1'), ruleIds: ['g1'] },
        { label: 'B', ruleIds: ['g1'] },
      ],
      groups: [
        {
          id: 'g1',
          label: 'Work',
          profileDir: 'C:\\profiles\\g1',
          folders: ['C:\\work'],
          members: ['A', 'B'],
          excluded: [],
        },
      ],
    });
  });

  it('names each excluded SHARED account by label and identity keys, and leaves an inert id out', () => {
    // The guard refuses a global-slot session in the folder while the global slot holds one of
    // these, so it needs the identity to recognize the login; an id naming no shared row is inert
    // (the pool ignores it too), so it is not listed.
    const snapshot = buildFolderBindingSnapshot({
      shared: [
        row('s1', 'D', { accountUuid: 'uuid-d', organizationUuid: 'org-d' }),
        row('s2', 'E', { accountUuid: 'uuid-e' }),
      ],
      rules: [rule('g1', ['m1'], ['s1', 'gone', 'm1'])],
      reserved: [row('m1', 'A', { accountUuid: 'uuid-a' })],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.excluded).toEqual([
      {
        label: 'D',
        accountKey: snapshotIdentityKey('uuid-d'),
        organizationKey: snapshotIdentityKey('org-d'),
      },
    ]);
    // Every stored account is listed once, shared first, with the rules that include it.
    expect(snapshot.accounts).toEqual([
      {
        label: 'D',
        accountKey: snapshotIdentityKey('uuid-d'),
        organizationKey: snapshotIdentityKey('org-d'),
        ruleIds: [],
      },
      { label: 'E', accountKey: snapshotIdentityKey('uuid-e'), ruleIds: [] },
      { label: 'A', accountKey: snapshotIdentityKey('uuid-a'), ruleIds: ['g1'] },
    ]);
  });

  it('keys an identity one way, in its own namespace', () => {
    // Stable for the guard to recompute, and not the bare hash of the uuid.
    expect(snapshotIdentityKey('uuid-1')).toBe(snapshotIdentityKey('uuid-1'));
    expect(snapshotIdentityKey('uuid-1')).not.toBe(snapshotIdentityKey('uuid-2'));
    expect(snapshotIdentityKey('uuid-1')).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshotIdentityKey('uuid-1')).toBe(
      createHash('sha256').update('cctl-guard-identity:uuid-1').digest('hex'),
    );
  });

  it('lists members in INCLUDE order, not the order the reserved rows are stored in', () => {
    // The include list is the folder's preference order, which is what the guard's message should
    // show; the reserved side is ordered by when each row happened to be moved there.
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m2', 'm1'])],
      reserved: [row('m1', 'A'), row('m2', 'B')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['B', 'A']);
  });

  it('gives an exclude-only rule a row with an empty member list, never the labels it excludes', () => {
    // The folder still runs in its own slot, so the guard needs its row; but an excluded account is
    // one the folder must NOT use, and naming it as a member would say the opposite.
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', [], ['s1'])],
      reserved: [],
      generation: 1,
      enforce: 'warn',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    expect(snapshot.groups).toEqual([
      {
        id: 'g1',
        label: 'Work',
        profileDir: 'C:\\profiles\\g1',
        folders: ['C:\\work'],
        members: [],
        excluded: [],
      },
    ]);
  });

  it('labels only the included accounts of a rule that both includes and excludes', () => {
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m1'], ['s1'])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['A']);
  });

  it('names an account several rules include in every one of their rows', () => {
    // Folders may share an included account; each folder's row must still say it uses it.
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m1'], [], ['C:\\work']), rule('g2', ['m1', 'm2'], [], ['C:\\client'])],
      reserved: [row('m1', 'A'), row('m2', 'B')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups.map((g) => g.members)).toEqual([['A'], ['A', 'B']]);
  });

  it('drops an included id with no reserved row rather than printing a raw id', () => {
    // Members are labels only: an id with no row has no label, and the snapshot carries no ids.
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m1', 'gone'])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\m',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => id,
    });
    expect(snapshot.groups[0]?.members).toEqual(['A']);
  });

  it('carries no account ids, no emails and no token material', () => {
    // Identities ride as one-way keys only: the snapshot is a plainly readable file.
    const text = JSON.stringify(
      buildFolderBindingSnapshot({
        shared: [
          row('excluded-id', 'D', {
            accountUuid: 'uuid-excluded',
            organizationUuid: 'org-excluded',
            emailAddress: 'd\\example.test',
          }),
        ],
        rules: [rule('g1', ['secret-id'], ['excluded-id'])],
        reserved: [
          row('secret-id', 'A', { accountUuid: 'uuid-secret', emailAddress: 'a\\example.test' }),
        ],
        generation: 1,
        enforce: 'warn',
        mainConfigDir: 'C:\\m',
        mainIdentityFile: ID_FILE,
        profileDirOf: (id) => id,
      }),
    );
    expect(text).not.toContain('secret-id');
    expect(text).not.toContain('excluded-id');
    expect(text).not.toContain('uuid-secret');
    expect(text).not.toContain('uuid-excluded');
    expect(text).not.toContain('org-excluded');
    expect(text).not.toContain('example.test');
    expect(text).toContain('"A"');
    expect(text).toContain(snapshotIdentityKey('uuid-excluded'));
  });
});

describe('folderBindingSnapshotContentEqual (pure)', () => {
  const base = () =>
    buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m1'])],
      reserved: [row('m1', 'A')],
      generation: 5,
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      mainIdentityFile: ID_FILE,
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

  it('is unequal when an excluded identity, an account label or the identity file changes', () => {
    const a = base();
    const excluded = base();
    excluded.groups[0]!.excluded = [{ label: 'D', accountKey: 'k' }];
    expect(folderBindingSnapshotContentEqual(a, excluded)).toBe(false);
    const relabeled = base();
    relabeled.accounts = [{ label: 'renamed', ruleIds: ['g1'] }];
    expect(folderBindingSnapshotContentEqual(a, relabeled)).toBe(false);
    const moved = { ...base(), mainIdentityFile: 'D:/elsewhere/.claude.json' };
    expect(folderBindingSnapshotContentEqual(a, moved)).toBe(false);
  });

  it('is unequal against a snapshot written before the identity fields existed', () => {
    // An older build's snapshot lacks them; the daemon must see it as stale and rewrite it, or the
    // guard would keep reading "cannot tell" for every excluding folder.
    const a = base();
    const older = base();
    delete older.accounts;
    delete older.mainIdentityFile;
    for (const g of older.groups) delete g.excluded;
    expect(folderBindingSnapshotContentEqual(a, older)).toBe(false);
  });

  it('is unequal when a rule is left with no included account', () => {
    const a = base();
    const b = base();
    b.groups[0]!.members = [];
    expect(folderBindingSnapshotContentEqual(a, b)).toBe(false);
  });
});

describe('buildFolderBindingSnapshot — session alias rules', () => {
  const aliasRule = (): FolderRule => ({
    ...rule('a1', ['m1'], [], []),
    aliases: [{ folder: 'C:/work/', alias: ' Auth Work ' }],
  });

  it('carries each alias scope as its canonical folder, its key and the alias as entered', () => {
    const snapshot = buildFolderBindingSnapshot({
      shared: [],
      rules: [aliasRule(), rule('f1', [])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => `C:\\profiles\\${id}`,
      platform: 'win32',
    });
    expect(snapshot.groups[0]).toMatchObject({
      id: 'a1',
      folders: [],
      members: ['A'],
      aliases: [{ folder: 'C:\\work', aliasKey: 'auth work', alias: ' Auth Work ' }],
    });
    // A rule with no alias scope carries no field: the shape older guards read.
    expect('aliases' in snapshot.groups[1]!).toBe(false);
  });

  it('is unequal when an alias scope is added, changed or removed (the guard enforces it)', () => {
    const build = (rules: FolderRule[]) =>
      buildFolderBindingSnapshot({
        shared: [],
        rules,
        reserved: [row('m1', 'A')],
        generation: 1,
        enforce: 'block',
        mainConfigDir: 'C:\\main',
        mainIdentityFile: ID_FILE,
        profileDirOf: (id) => `C:\\profiles\\${id}`,
        platform: 'win32',
      });
    const plain = build([rule('a1', ['m1'])]);
    const withAlias = build([aliasRule()]);
    expect(folderBindingSnapshotContentEqual(plain, withAlias)).toBe(false);
    const renamed = build([{ ...aliasRule(), aliases: [{ folder: 'C:/work', alias: 'Other' }] }]);
    expect(folderBindingSnapshotContentEqual(withAlias, renamed)).toBe(false);
    expect(folderBindingSnapshotContentEqual(withAlias, build([aliasRule()]))).toBe(true);
  });

  it('reads a snapshot written before alias rules existed as having none', () => {
    const now = buildFolderBindingSnapshot({
      shared: [],
      rules: [rule('g1', ['m1'])],
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => `C:\\profiles\\${id}`,
    });
    const older = structuredClone(now);
    for (const g of older.groups) delete g.aliases;
    expect(folderBindingSnapshotContentEqual(now, older)).toBe(true);
  });
});

describe('a hand-edited folder spelling', () => {
  // groups.json is operator-editable and its loader accepts any spelling of a folder, so the
  // launcher, `where`, the daemon and the guard must all compare the one canonical spelling.
  const handEdited = (): FolderRule => rule('r1', ['m1'], [], ['C:/work/']);
  const snapshotOf = (rules: FolderRule[]) =>
    buildFolderBindingSnapshot({
      shared: [],
      rules,
      reserved: [row('m1', 'A')],
      generation: 1,
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      mainIdentityFile: ID_FILE,
      profileDirOf: (id) => `C:\\profiles\\${id}`,
      platform: 'win32',
    });

  it('is written to the guard snapshot canonically', () => {
    expect(snapshotOf([handEdited()]).groups[0]?.folders).toEqual(['C:\\work']);
  });

  it('routes the same rule for the launcher, `where` and the guard', () => {
    const rules = [handEdited()];
    const guardRows = snapshotOf(rules).groups;
    for (const folder of ['C:\\work', 'C:\\work\\sub']) {
      expect(resolveSessionRule(folder, null, rules, 'win32')?.rule.id).toBe('r1');
      expect(resolveFolderRule(folder, rules, 'win32')?.rule.id).toBe('r1');
      expect(resolveSessionBinding(folder, null, guardRows, 'win32')?.groupId).toBe('r1');
    }
  });
});

describe('Vault.writeFolderBindings / readFolderBindings', () => {
  it('writes the snapshot beside the vault and reads it back with the live generation', async () => {
    const { v, vaultDir, snapshotPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const included = await v.createRule({ folders: ['C:\\work'], include: [a.id] });
    const excludeOnly = await v.createRule({ folders: ['C:\\other'], exclude: [b.id] });

    const written = await v.writeFolderBindings({
      enforce: 'block',
      mainConfigDir: 'C:\\main',
      mainIdentityFile: ID_FILE,
    });
    expect(written.generation).toBe(await v.getRulesGeneration());
    expect(written.groups[0]?.profileDir).toBe(groupProfileDir(vaultDir, included.id));
    expect(written.groups[0]?.members).toEqual(['a']);
    // The exclude-only rule gets its row too (its folder runs in its own slot), naming no one.
    expect(written.groups[1]).toMatchObject({
      profileDir: groupProfileDir(vaultDir, excludeOnly.id),
      folders: ['C:\\other'],
      members: [],
      excluded: [{ label: 'b', accountKey: snapshotIdentityKey('uuid-b') }],
    });
    expect(written.mainIdentityFile).toBe(ID_FILE);

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
