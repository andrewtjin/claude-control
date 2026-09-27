// Alias scopes in groups.json: a group may be bound by session aliases (one title in one exact
// folder) beside or instead of folders. A file holding any alias scope is written as schemaVersion
// 2, which a folder-only build refuses (rather than dropping the aliases on its next write); a file
// without one stays schemaVersion 1. The load rules pinned here are what keep an old file readable,
// a corrupt one refused (closed, file untouched), and every write loadable by the next read.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, MAX_GROUP_ALIASES, MAX_ALIAS_LENGTH } from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { VaultError } from './errors.js';
import type { CredentialBundle } from './types.js';

// Pinned to the Windows case rule (folder keys fold case) so the assertions are host-independent.
let dirs: string[] = [];
async function vaultAt() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-group-aliases-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, undefined, 'win32'),
    vaultDir,
    groupsPath: join(vaultDir, 'groups.json'),
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

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function withGroupsFile(content: unknown) {
  const ctx = await vaultAt();
  await mkdir(ctx.vaultDir, { recursive: true });
  await writeFile(
    ctx.groupsPath,
    typeof content === 'string' ? content : JSON.stringify(content),
    'utf8',
  );
  return ctx;
}

const member = (id: string) => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 1,
  updatedAtMs: 1,
});
const file = (groups: unknown[]) => ({ schemaVersion: 1, generation: 3, groups });
const aliasGroup = (id: string, aliases: unknown, over: Record<string, unknown> = {}) => ({
  id,
  label: id,
  members: [member(`m-${id}`)],
  activeId: null,
  folders: [],
  aliases,
  createdAtMs: 1,
  updatedAtMs: 1,
  ...over,
});

/** Loading must refuse by name AND leave the file exactly as it was (fail closed). */
async function expectLoadRefusal(content: unknown, pattern: RegExp): Promise<void> {
  const { v, groupsPath } = await withGroupsFile(content);
  const before = await readFile(groupsPath, 'utf8');
  await expect(v.listGroups()).rejects.toThrow(VaultError);
  await expect(v.listGroups()).rejects.toThrow(pattern);
  expect(await readFile(groupsPath, 'utf8')).toBe(before);
}

describe('loading alias scopes', () => {
  it('loads a file written before alias scopes existed (no aliases field anywhere)', async () => {
    const { v } = await withGroupsFile(
      file([
        {
          id: 'g1',
          label: 'g1',
          members: [member('m1')],
          activeId: null,
          folders: ['C:\\work'],
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      ]),
    );
    const groups = await v.listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]!.aliases).toBeUndefined();
    expect(groups[0]!.folders).toEqual(['C:\\work']);
  });

  it('loads an alias-only group and normalizes an empty aliases list away', async () => {
    const { v } = await withGroupsFile(
      file([
        aliasGroup('g1', [{ folder: 'C:\\repo', alias: 'Auth Work' }]),
        aliasGroup('g2', [], { folders: ['C:\\other'] }),
      ]),
    );
    const [g1, g2] = await v.listGroups();
    expect(g1!.folders).toEqual([]);
    expect(g1!.aliases).toEqual([{ folder: 'C:\\repo', alias: 'Auth Work' }]);
    // An empty list reads as "none" and is not echoed back as a field.
    expect(g2!.aliases).toBeUndefined();
  });

  // A scope-less group is what a folder-only build leaves when it rewrites a file holding an
  // alias-only group. It used to be refused, which failed EVERY command on the machine; it now loads
  // (routing nothing, its members still reserved) so it can be seen and released.
  it('loads a group with no scope at all (no folder, no alias), keeping its members reserved', async () => {
    for (const aliases of [[], undefined]) {
      const { v } = await withGroupsFile(file([aliasGroup('g1', aliases)]));
      const [g] = await v.listGroups();
      expect(g!.folders).toEqual([]);
      expect(g!.aliases).toBeUndefined();
      expect(g!.members.map((m) => m.id)).toEqual(['m-g1']);
      expect((await v.listAllAccounts()).find((a) => a.id === 'm-g1')?.groupId).toBe('g1');
      expect(await v.listAccounts()).toEqual([]);
    }
  });

  it('refuses the same (folder, alias) pair in two groups, by alias key and folder key', () =>
    expectLoadRefusal(
      file([
        aliasGroup('g1', [{ folder: 'C:\\repo', alias: 'Auth Work' }]),
        // Different case, extra spaces and a different separator spelling: the same scope.
        aliasGroup('g2', [{ folder: 'c:/REPO', alias: '  auth WORK ' }]),
      ]),
      /bound more than once/,
    ));

  it('refuses the same pair twice within ONE group', () =>
    expectLoadRefusal(
      file([
        aliasGroup('g1', [
          { folder: 'C:\\repo', alias: 'x' },
          { folder: 'C:\\repo', alias: 'X' },
        ]),
      ]),
      /bound more than once/,
    ));

  it('accepts one alias in two different folders, and two aliases in one folder', async () => {
    const { v } = await withGroupsFile(
      file([
        aliasGroup('g1', [{ folder: 'C:\\a', alias: 'x' }]),
        aliasGroup('g2', [
          { folder: 'C:\\b', alias: 'x' },
          { folder: 'C:\\a', alias: 'y' },
        ]),
      ]),
    );
    await expect(v.listGroups()).resolves.toHaveLength(2);
  });

  it('refuses malformed alias entries by name', async () => {
    await expectLoadRefusal(file([aliasGroup('g1', 'nope')]), /aliases is not an array/);
    await expectLoadRefusal(file([aliasGroup('g1', ['x'])]), /aliases\[0\] is not an object/);
    await expectLoadRefusal(
      file([aliasGroup('g1', [{ folder: '', alias: 'x' }])]),
      /has no string folder/,
    );
    await expectLoadRefusal(
      file([aliasGroup('g1', [{ folder: 'C:\\a', alias: '   ' }])]),
      /has no alias/,
    );
    await expectLoadRefusal(
      file([aliasGroup('g1', [{ folder: 'C:\\a', alias: 7 }])]),
      /has no alias/,
    );
    await expectLoadRefusal(
      file([aliasGroup('g1', [{ folder: 'C:\\a', alias: 'x'.repeat(MAX_ALIAS_LENGTH + 1) }])]),
      /longer than/,
    );
    // The uniqueness key joins folder and alias with a NUL, so a NUL in either half is refused
    // rather than allowed to make two scopes collide on one key.
    await expectLoadRefusal(
      file([aliasGroup('g1', [{ folder: 'C:\\a', alias: 'a\u0000b' }])]),
      /NUL/,
    );
  });

  it('refuses a __proto__ key inside an alias entry', async () => {
    const raw =
      '{"schemaVersion":1,"generation":0,"groups":[{"id":"g1","label":"g","members":[' +
      JSON.stringify(member('m1')) +
      '],"activeId":null,"folders":[],"aliases":[{"folder":"C:\\\\a","alias":"x",' +
      '"__proto__":{"p":1}}],"createdAtMs":1,"updatedAtMs":1}]}';
    await expectLoadRefusal(raw, /forbidden key/);
  });

  it('refuses more aliases than the cap', () =>
    expectLoadRefusal(
      file([
        aliasGroup(
          'g1',
          Array.from({ length: MAX_GROUP_ALIASES + 1 }, (_, i) => ({
            folder: 'C:\\a',
            alias: `a${i}`,
          })),
        ),
      ]),
      new RegExp(`max ${MAX_GROUP_ALIASES}`),
    ));
});

describe('writing alias scopes', () => {
  it('round-trips: create with an alias only, add and remove scopes, the file stays loadable', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const g = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'Auth Work' }],
    });
    expect(g.folders).toEqual([]);
    expect(g.aliases).toEqual([{ folder: 'C:\\repo', alias: 'Auth Work' }]);

    await v.addAliasToGroup(g.id, { folder: 'C:\\repo', alias: 'second' });
    await v.addFolderToGroup(g.id, 'C:\\work');
    expect((await v.getGroup(g.id))?.aliases).toEqual([
      { folder: 'C:\\repo', alias: 'Auth Work' },
      { folder: 'C:\\repo', alias: 'second' },
    ]);

    // Removal keys by (folder key, alias key): another case/spelling still removes the scope.
    await v.removeAliasFromGroup(g.id, { folder: 'c:/REPO', alias: ' auth work ' });
    await v.removeAliasFromGroup(g.id, { folder: 'C:\\repo', alias: 'SECOND' });
    const after = await v.getGroup(g.id);
    // The last alias gone: the field is dropped entirely (the older file shape).
    expect(after?.aliases).toBeUndefined();
    expect(after?.folders).toEqual(['C:\\work']);
    const persisted = (await readJson(groupsPath)).groups as Record<string, unknown>[];
    expect('aliases' in persisted[0]!).toBe(false);
    await expect(v.listGroups()).resolves.toHaveLength(1);
  });

  it('persists an alias exactly as entered (display), keyed only for comparison', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: ' Mixed Case ' }],
    });
    const persisted = (await readJson(groupsPath)).groups as { aliases: unknown }[];
    expect(persisted[0]!.aliases).toEqual([{ folder: 'C:\\repo', alias: ' Mixed Case ' }]);
  });

  it('refuses a scope-less createGroup, and removing a group’s last scope of either kind', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    await expect(v.createGroup({ memberIds: [a.id] })).rejects.toThrow(
      /at least one folder or session alias/,
    );
    const byAlias = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'x' }],
    });
    await expect(
      v.removeAliasFromGroup(byAlias.id, { folder: 'C:\\repo', alias: 'x' }),
    ).rejects.toThrow(/last binding; dissolve it instead/);
    const byFolder = await v.createGroup({ memberIds: [b.id], folders: ['C:\\work'] });
    await expect(v.removeFolderFromGroup(byFolder.id, 'C:\\work')).rejects.toThrow(
      /last binding; dissolve it instead/,
    );
    // Nothing was written by the refusals.
    expect((await v.getGroup(byAlias.id))?.aliases).toHaveLength(1);
    expect((await v.getGroup(byFolder.id))?.folders).toEqual(['C:\\work']);
  });

  it('refuses removing an alias the group does not hold', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const g = await v.createGroup({
      memberIds: [a.id],
      folders: ['C:\\work'],
      aliases: [{ folder: 'C:\\repo', alias: 'x' }],
    });
    await expect(v.removeAliasFromGroup(g.id, { folder: 'C:\\repo', alias: 'y' })).rejects.toThrow(
      /is not bound to group/,
    );
    await expect(v.removeAliasFromGroup(g.id, { folder: 'C:\\other', alias: 'x' })).rejects.toThrow(
      /is not bound to group/,
    );
  });

  it('write guards key exactly like the load validator (no write the next load refuses)', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const g1 = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'Auth Work' }],
    });
    // Another group claiming a case/space/separator variant of the same scope is refused...
    await expect(
      v.createGroup({ memberIds: [b.id], aliases: [{ folder: 'c:/repo/', alias: 'AUTH work ' }] }),
    ).rejects.toThrow(/already bound to another group/);
    // ...as is the owner re-adding it...
    await expect(
      v.addAliasToGroup(g1.id, { folder: 'C:\\REPO', alias: 'auth work' }),
    ).rejects.toThrow(/already bound to this group/);
    // ...and a blank, over-long or NUL-carrying alias.
    await expect(v.addAliasToGroup(g1.id, { folder: 'C:\\repo', alias: '  ' })).rejects.toThrow(
      /cannot be empty/,
    );
    await expect(
      v.addAliasToGroup(g1.id, { folder: 'C:\\repo', alias: 'x'.repeat(MAX_ALIAS_LENGTH + 1) }),
    ).rejects.toThrow(/longer than/);
    await expect(
      v.addAliasToGroup(g1.id, { folder: 'C:\\repo', alias: 'a\u0000b' }),
    ).rejects.toThrow(/NUL/);
    // The same alias in a DIFFERENT folder is a different scope.
    await v.createGroup({
      memberIds: [b.id],
      aliases: [{ folder: 'C:\\other', alias: 'Auth Work' }],
    });
    await expect(v.listGroups()).resolves.toHaveLength(2);
  });

  it('alias scopes survive member moves and row-level writes of the group', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const g = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'x' }],
    });
    await v.reserveAccounts(g.id, [b.id]);
    await v.setGroupActive(g.id, b.id);
    await v.renameAccount(a.id, 'a-renamed');
    await v.quarantine(b.id, 'dead');
    await v.releaseAccounts(g.id, [a.id]);
    expect((await v.getGroup(g.id))?.aliases).toEqual([{ folder: 'C:\\repo', alias: 'x' }]);
  });

  it('dissolving via the last member removes the group and its alias scopes together', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const g = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'x' }],
    });
    await v.releaseAccounts(g.id, [a.id]);
    expect(await v.getGroup(g.id)).toBeUndefined();
    expect((await readJson(groupsPath)).groups).toEqual([]);
  });
});
