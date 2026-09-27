import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault, MAX_GROUPS, MAX_GROUP_MEMBERS, MAX_GROUP_FOLDERS } from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { UnknownAccountError, VaultError } from './errors.js';
import type { CredentialBundle } from './types.js';

// The group split lives entirely on the Windows case rule here (folder keys fold case), so every
// vault is pinned to 'win32' — the box this runs on is win32 anyway, but pinning keeps the folder
// assertions deterministic on any host.
let dirs: string[] = [];
async function vaultAt(platform: NodeJS.Platform = 'win32') {
  const dir = await mkdtemp(join(tmpdir(), 'ce-groups-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, undefined, platform),
    vaultDir,
    accountsPath: join(vaultDir, 'accounts.json'),
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

/** A fresh folder for a group the test does not care about the scope of: a group must hold at least
 *  one scope (a folder or a session alias) to be written or loaded, and folders are unique across
 *  groups, so each call hands out a distinct one. */
let scopeSeq = 0;
function scopeFolder(): string {
  scopeSeq += 1;
  return `C:\\scope-${scopeSeq}`;
}

/** Read a JSON file as an object. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('createGroup — reserving shared accounts', () => {
  it('moves rows out of accounts.json into groups.json and tags the unified view', async () => {
    const { v, accountsPath, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const shared = await v.addAccount('personal', bundle('c'));

    const group = await v.createGroup({
      memberIds: [a.id, b.id],
      folders: ['C:\\work'],
      label: 'Work group',
    });

    // Shared list (the global pool) no longer holds the reserved accounts.
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([shared.id]);
    // The unified view holds all three, and only the reserved two carry a groupId.
    const all = await v.listAllAccounts();
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id, shared.id].sort());
    expect(all.find((r) => r.id === a.id)?.groupId).toBe(group.id);
    expect(all.find((r) => r.id === shared.id)?.groupId).toBeUndefined();

    // getAccount reaches a reserved row by id.
    expect((await v.getAccount(b.id))?.label).toBe('client');

    // accounts.json is stamped with the new schema version and no longer lists the reserved rows.
    const accounts = await readJson(accountsPath);
    expect(accounts.schemaVersion).toBe(2);
    expect((accounts.accounts as { id: string }[]).map((r) => r.id)).toEqual([shared.id]);

    // groups.json holds the moved rows and a first-generation stamp.
    const groups = await readJson(groupsPath);
    expect(groups.schemaVersion).toBe(1);
    expect(groups.generation).toBe(1);
    const persisted = (groups.groups as { members: { id: string }[]; folders: string[] }[])[0]!;
    expect(persisted.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect(persisted.folders).toEqual(['C:\\work']);
  });

  it('defaults the label to the joined member labels', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id, b.id], folders: [scopeFolder()] });
    expect(group.label).toBe('work, client');
  });

  it('clears the global active id when the account being reserved was live in the global slot', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    await v.setActive(a.id);
    expect(await v.getActiveId()).toBe(a.id);
    await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    expect(await v.getActiveId()).toBeNull();
  });

  it('refuses an empty member set, an unknown id, and an already-reserved id', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    await expect(v.createGroup({ memberIds: [], folders: [scopeFolder()] })).rejects.toThrow(
      /at least one member/,
    );
    await expect(v.createGroup({ memberIds: ['nope'], folders: [scopeFolder()] })).rejects.toThrow(
      UnknownAccountError,
    );
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    const b = await v.addAccount('other', bundle('b'));
    await expect(
      v.createGroup({ memberIds: [a.id, b.id], folders: [scopeFolder()] }),
    ).rejects.toThrow(new RegExp(`already reserved to group ${group.id}`));
  });

  it('refuses a folder already bound to another group, but allows a nested subfolder', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    await v.createGroup({ memberIds: [a.id], folders: ['C:\\work'] });
    // Same folder (case-folded) → refused.
    await expect(v.createGroup({ memberIds: [b.id], folders: ['c:\\WORK'] })).rejects.toThrow(
      /already bound to another group/,
    );
    // A nested subfolder is a different key → allowed.
    const nested = await v.createGroup({ memberIds: [b.id], folders: ['C:\\work\\client'] });
    expect(nested.folders).toEqual(['C:\\work\\client']);
  });
});

describe('reserve / release — moving rows between the two files', () => {
  it('reserveAccounts grows an existing group', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    await v.reserveAccounts(group.id, [b.id]);
    const g = await v.getGroup(group.id);
    expect(g?.members.map((m) => m.id).sort()).toEqual([a.id, b.id].sort());
    expect((await v.listAccounts()).length).toBe(0);
  });

  it('releaseAccounts moves a member back to the shared pool', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id, b.id], folders: [scopeFolder()] });
    await v.releaseAccounts(group.id, [a.id]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
    expect((await v.getGroup(group.id))?.members.map((m) => m.id)).toEqual([b.id]);
  });

  it('dissolves a group when its last member is released', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const group = await v.createGroup({ memberIds: [a.id], folders: ['C:\\work'] });
    await v.releaseAccounts(group.id, [a.id]);
    expect(await v.getGroup(group.id)).toBeUndefined();
    expect((await v.listGroups()).length).toBe(0);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
    // The empty groups list is still a valid file.
    expect((await readJson(groupsPath)).groups).toEqual([]);
  });

  it('clears a group active id when the live member is released', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id, b.id], folders: [scopeFolder()] });
    await v.setGroupActive(group.id, a.id);
    await v.releaseAccounts(group.id, [a.id]);
    expect((await v.getGroup(group.id))?.activeId).toBeNull();
  });

  it('bumps the generation on every reserved-side write', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    expect((await readJson(groupsPath)).generation).toBe(1);
    await v.reserveAccounts(group.id, [b.id]);
    expect((await readJson(groupsPath)).generation).toBe(2);
    await v.addFolderToGroup(group.id, 'C:\\work');
    expect((await readJson(groupsPath)).generation).toBe(3);
    expect(await v.getGroupsGeneration()).toBe(3);
  });
});

describe('folder + active mutations on a group', () => {
  it('adds and removes folders, refusing a cross-group duplicate and an unknown removal', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const g1 = await v.createGroup({ memberIds: [a.id], folders: ['C:\\one'] });
    const g2 = await v.createGroup({ memberIds: [b.id], folders: ['C:\\two'] });
    await v.addFolderToGroup(g1.id, 'C:\\three');
    expect((await v.getGroup(g1.id))?.folders).toEqual(['C:\\one', 'C:\\three']);
    await expect(v.addFolderToGroup(g1.id, 'c:\\TWO')).rejects.toThrow(/already bound/);
    await v.removeFolderFromGroup(g1.id, 'c:\\ONE');
    expect((await v.getGroup(g1.id))?.folders).toEqual(['C:\\three']);
    await expect(v.removeFolderFromGroup(g1.id, 'C:\\nope')).rejects.toThrow(/not bound/);
    expect(g2.folders).toEqual(['C:\\two']);
  });

  // The write-time folder guards must key a folder EXACTLY as the load validator does, or a write
  // can persist a groups.json the next load rejects (fail-closed brick). These pin that agreement.
  it('refuses re-adding a folder the group already holds, leaving the file loadable', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const g1 = await v.createGroup({ memberIds: [a.id], folders: ['C:\\proj'] });
    // Re-adding the group's OWN folder is refused, not silently duplicated.
    await expect(v.addFolderToGroup(g1.id, 'C:\\proj')).rejects.toThrow(
      /already bound to this group/,
    );
    // A case- or separator-variant of the same directory is refused just the same.
    await expect(v.addFolderToGroup(g1.id, 'c:/PROJ')).rejects.toThrow(
      /already bound to this group/,
    );
    expect((await v.getGroup(g1.id))?.folders).toEqual(['C:\\proj']);
    // No duplicate reached the file, so a fresh load succeeds.
    expect((await readJson(groupsPath)).groups).toHaveLength(1);
    await expect(v.listGroups()).resolves.toHaveLength(1);
  });

  it('refuses a cross-group folder collision under a different separator spelling', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const g1 = await v.createGroup({ memberIds: [a.id], folders: ['C:/g/8'] });
    const g2 = await v.createGroup({ memberIds: [b.id], folders: ['C:\\other'] });
    // The backslash spelling is the same physical dir g1 already holds → refused.
    await expect(v.addFolderToGroup(g2.id, 'C:\\g\\8')).rejects.toThrow(
      /already bound to another group/,
    );
    expect((await v.getGroup(g1.id))?.folders).toEqual(['C:/g/8']);
  });

  it('removes a folder stored under a non-canonical spelling when queried canonically', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const g1 = await v.createGroup({ memberIds: [a.id], folders: ['C:/g/8', 'C:\\keep'] });
    // Stored with forward slashes; removal keys canonically, so the backslash form still matches.
    await v.removeFolderFromGroup(g1.id, 'C:\\g\\8');
    expect((await v.getGroup(g1.id))?.folders).toEqual(['C:\\keep']);
  });

  it('sets and clears the live member, refusing a non-member', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    await v.setGroupActive(group.id, a.id);
    expect((await v.getGroup(group.id))?.activeId).toBe(a.id);
    await expect(v.setGroupActive(group.id, shared.id)).rejects.toThrow(UnknownAccountError);
    await v.setGroupActive(group.id, null);
    expect((await v.getGroup(group.id))?.activeId).toBeNull();
  });
});

describe('row-level mutations route to the file that holds the row', () => {
  it('quarantine / exclude / rename / metadata land in groups.json for a reserved member', async () => {
    const { v, accountsPath, groupsPath } = await vaultAt();
    const a = await v.addAccount('reserved', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    const accountsBefore = await readFile(accountsPath, 'utf8');

    await v.quarantine(a.id, 'dead token');
    await v.setAutoSwitchExcluded(a.id, true);
    await v.renameAccount(a.id, 'reserved-renamed');

    // The shared file did not move; every mutation of the reserved row went to groups.json.
    expect(await readFile(accountsPath, 'utf8')).toBe(accountsBefore);
    const member = (await v.getGroup(group.id))!.members[0]!;
    expect(member.quarantined).toBe(true);
    expect(member.quarantineReason).toBe('dead token');
    expect(member.autoSwitchExcluded).toBe(true);
    expect(member.label).toBe('reserved-renamed');
    // Sanity: the shared row is still reachable and untouched.
    expect((await v.getAccount(shared.id))?.label).toBe('shared');
    expect((await readJson(groupsPath)).generation).toBeGreaterThan(1);
  });

  it('rename refuses a label a reserved member already carries (union namespace)', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    await expect(v.renameAccount(shared.id, 'alpha')).rejects.toThrow(/already refers to account/);
  });

  it('addAccount refuses a login already reserved to a group', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    // Same accountUuid as the reserved account.
    await expect(v.addAccount('again', bundle('a'))).rejects.toThrow(/already stored/);
  });

  it('removeAccount drops a member and dissolves the group when it was the last', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id, b.id], folders: [scopeFolder()] });
    await v.removeAccount(a.id);
    expect((await v.getGroup(group.id))?.members.map((m) => m.id)).toEqual([b.id]);
    await expect(v.readBundle(a.id)).rejects.toThrow();
    await v.removeAccount(b.id);
    expect(await v.getGroup(group.id)).toBeUndefined();
  });

  it('dedupes within a group using that group active id', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('dup', bundle('a'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    await v.setGroupActive(group.id, a.id);
    // Smuggle a second row with the same login directly into the member list.
    const groups = await readJson(groupsPath);
    (groups.groups as { members: Record<string, unknown>[] }[])[0]!.members.push({
      id: 'dup-2',
      label: 'dup',
      accountUuid: 'uuid-a',
      quarantined: false,
      createdAtMs: 5000,
      updatedAtMs: 5000,
    });
    await writeFile(groupsPath, JSON.stringify(groups), 'utf8');
    const report = await v.dedupeAccounts();
    expect(report.merged).toEqual([{ label: 'dup', keptId: a.id, removedId: 'dup-2' }]);
    expect((await v.getGroup(group.id))?.members.map((m) => m.id)).toEqual([a.id]);
  });
});

describe('crash-mid-move healing (groups.json wins)', () => {
  it('a row lingering in BOTH files is treated as reserved and healed out of accounts.json', async () => {
    const { v, accountsPath, groupsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const group = await v.createGroup({ memberIds: [a.id], folders: [scopeFolder()] });
    // Simulate a crash after groups.json was written but before accounts.json lost the row: put the
    // reserved row back into accounts.json (and point the global active at it).
    const accounts = await readJson(accountsPath);
    accounts.activeId = a.id;
    (accounts.accounts as Record<string, unknown>[]).push({
      id: a.id,
      label: 'a',
      accountUuid: 'uuid-a',
      quarantined: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await writeFile(accountsPath, JSON.stringify(accounts), 'utf8');

    // The healed view: the shared pool excludes it, the unified view shows it once (reserved), and
    // the stale global active id is dropped.
    expect((await v.listAccounts()).length).toBe(0);
    const all = await v.listAllAccounts();
    expect(all.filter((r) => r.id === a.id)).toHaveLength(1);
    expect(all[0]?.groupId).toBe(group.id);
    expect(await v.getActiveId()).toBeNull();

    // heal() flushes the fix so an older cctl reading accounts.json never sees the reserved row.
    expect(await v.heal()).toBe(true);
    const afterHeal = await readJson(accountsPath);
    expect((afterHeal.accounts as unknown[]).length).toBe(0);
    expect(afterHeal.activeId).toBeNull();
    // A second heal has nothing to do.
    expect(await v.heal()).toBe(false);
    void groupsPath;
  });
});

describe('strict validation of groups.json fails CLOSED, naming the field, leaving the file', () => {
  async function withGroupsFile(content: string) {
    const ctx = await vaultAt();
    await mkdir(ctx.vaultDir, { recursive: true });
    await writeFile(ctx.groupsPath, content, 'utf8');
    return ctx;
  }
  async function expectRefusal(content: string, pattern: RegExp) {
    const { v, groupsPath } = await withGroupsFile(content);
    const before = await readFile(groupsPath, 'utf8');
    await expect(v.listGroups()).rejects.toThrow(VaultError);
    await expect(v.listGroups()).rejects.toThrow(pattern);
    expect(await readFile(groupsPath, 'utf8')).toBe(before);
  }
  const member = {
    id: 'm1',
    label: 'm',
    quarantined: false,
    createdAtMs: 1,
    updatedAtMs: 1,
  };
  // Each fixture group gets its own folder by default (named after its id): a scope-less group is
  // itself refused on load, and two groups sharing one folder would be too — neither may mask the
  // refusal a test is actually about.
  const group = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    label: 'g',
    members: [member],
    activeId: null,
    folders: [`C:\\fixture-${typeof over.id === 'string' ? over.id : 'g1'}`],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  });

  it('refuses an unsupported schemaVersion', () =>
    expectRefusal(
      JSON.stringify({ schemaVersion: 99, generation: 0, groups: [] }),
      /schemaVersion/,
    ));

  it('refuses a non-integer generation', () =>
    expectRefusal(JSON.stringify({ schemaVersion: 1, generation: 1.5, groups: [] }), /generation/));

  it('refuses groups that are not an array', () =>
    expectRefusal(JSON.stringify({ schemaVersion: 1, generation: 0, groups: {} }), /not an array/));

  it('refuses a group with no members', () =>
    expectRefusal(
      JSON.stringify({ schemaVersion: 1, generation: 0, groups: [group({ members: [] })] }),
      /no members/,
    ));

  it('refuses a member without an id', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ members: [{ label: 'x', quarantined: false, createdAtMs: 1, updatedAtMs: 1 }] }),
        ],
      }),
      /no string id/,
    ));

  it('refuses a __proto__ key at the top level', () =>
    expectRefusal(
      '{"schemaVersion":1,"generation":0,"groups":[],"__proto__":{"polluted":true}}',
      /forbidden key/,
    ));

  it('refuses a __proto__ key inside a group', () =>
    expectRefusal(
      `{"schemaVersion":1,"generation":0,"groups":[{"id":"g1","label":"g","members":[${JSON.stringify(
        member,
      )}],"activeId":null,"folders":[],"createdAtMs":1,"updatedAtMs":1,"__proto__":{"x":1}}]}`,
      /forbidden key/,
    ));

  it('refuses the same member id in two groups', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [group(), group({ id: 'g2' })],
      }),
      /appears in more than one group/,
    ));

  it('refuses the same login (accountUuid) in two groups', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ members: [{ ...member, accountUuid: 'login-x' }] }),
          group({ id: 'g2', members: [{ ...member, id: 'm2', accountUuid: 'login-x' }] }),
        ],
      }),
      /login login-x appears in more than one group/,
    ));

  it('accepts a login repeated WITHIN one group (a dedupe-able duplicate, not a cross-group one)', async () => {
    // Two members of ONE group sharing a login is what dedupeAccounts collapses; failing the load
    // closed would make it unrepairable, so validation must accept it.
    const { v } = await withGroupsFile(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({
            members: [
              { ...member, accountUuid: 'login-dup' },
              { ...member, id: 'm2', accountUuid: 'login-dup' },
            ],
          }),
        ],
      }),
    );
    await expect(v.listGroups()).resolves.toHaveLength(1);
  });

  it('accepts distinct logins and rows that carry no accountUuid', async () => {
    const { v } = await withGroupsFile(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ members: [{ ...member, accountUuid: 'login-a' }] }),
          group({ id: 'g2', members: [{ ...member, id: 'm2', accountUuid: 'login-b' }] }),
          // A pre-metadata row (no accountUuid) is keyed by id alone and must not collide on undefined.
          group({ id: 'g3', members: [{ ...member, id: 'm3' }] }),
          group({ id: 'g4', members: [{ ...member, id: 'm4' }] }),
        ],
      }),
    );
    await expect(v.listGroups()).resolves.toHaveLength(4);
  });

  it('refuses the same folder bound by two groups', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ folders: ['C:\\shared'] }),
          group({ id: 'g2', members: [{ ...member, id: 'm2' }], folders: ['c:\\SHARED'] }),
        ],
      }),
      /bound by more than one group/,
    ));

  it('refuses the same folder bound by two groups under different separator spellings', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ folders: ['C:\\research'] }),
          group({ id: 'g2', members: [{ ...member, id: 'm2' }], folders: ['C:/research'] }),
        ],
      }),
      /bound by more than one group/,
    ));

  it('refuses one folder spelled with a trailing separator against its plain form', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ folders: ['C:\\research'] }),
          group({ id: 'g2', members: [{ ...member, id: 'm2' }], folders: ['C:\\research\\'] }),
        ],
      }),
      /bound by more than one group/,
    ));

  it('refuses an activeId that is not a member', () =>
    expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [group({ activeId: 'ghost' })],
      }),
      /activeId is not one of its members/,
    ));

  it('refuses more than the cap of groups / members / folders', async () => {
    const many = (n: number, make: (i: number) => unknown) =>
      Array.from({ length: n }, (_, i) => make(i));
    await expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: many(MAX_GROUPS + 1, (i) =>
          group({ id: `g${i}`, members: [{ ...member, id: `m${i}` }] }),
        ),
      }),
      new RegExp(`max ${MAX_GROUPS}`),
    );
    await expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [
          group({ members: many(MAX_GROUP_MEMBERS + 1, (i) => ({ ...member, id: `m${i}` })) }),
        ],
      }),
      new RegExp(`max ${MAX_GROUP_MEMBERS}`),
    );
    await expectRefusal(
      JSON.stringify({
        schemaVersion: 1,
        generation: 0,
        groups: [group({ folders: many(MAX_GROUP_FOLDERS + 1, (i) => `C:\\f${i}`) })],
      }),
      new RegExp(`max ${MAX_GROUP_FOLDERS}`),
    );
  });
});

describe('downgrade fence — an older cctl cannot see or drop reserved accounts', () => {
  it('reads a pre-feature accounts.json (no schemaVersion) as all-shared', async () => {
    const { v, accountsPath, vaultDir } = await vaultAt();
    await mkdir(vaultDir, { recursive: true });
    // The exact shape an older build wrote: no schemaVersion, no groups.json at all.
    await writeFile(
      accountsPath,
      JSON.stringify({
        activeId: 'old-1',
        accounts: [
          { id: 'old-1', label: 'legacy', quarantined: false, createdAtMs: 1, updatedAtMs: 1 },
        ],
      }),
      'utf8',
    );
    expect((await v.listAccounts()).map((r) => r.id)).toEqual(['old-1']);
    expect(await v.getActiveId()).toBe('old-1');
    expect(await v.listGroups()).toEqual([]);
  });

  it('a legacy rewrite of accounts.json cannot drop the group bindings in groups.json', async () => {
    const { v, accountsPath } = await vaultAt();
    const reserved = await v.addAccount('reserved', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    const group = await v.createGroup({ memberIds: [reserved.id], folders: [scopeFolder()] });

    // Simulate an older cctl that knows only {activeId, accounts} and rewrites accounts.json — it
    // never touches groups.json, and it cannot mention the reserved account it never saw.
    await writeFile(
      accountsPath,
      JSON.stringify({
        activeId: shared.id,
        accounts: [
          {
            id: shared.id,
            label: 'shared',
            accountUuid: 'uuid-s',
            quarantined: false,
            createdAtMs: 1,
            updatedAtMs: 1,
          },
        ],
      }),
      'utf8',
    );

    // The binding survives untouched: the reserved account is still a member of its group.
    const g = await v.getGroup(group.id);
    expect(g?.members.map((m) => m.id)).toEqual([reserved.id]);
    expect((await v.listAllAccounts()).find((r) => r.id === reserved.id)?.groupId).toBe(group.id);
    // And the shared pool is exactly what the old writer left.
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([shared.id]);
    expect(await v.getActiveId()).toBe(shared.id);
  });

  it('an older `accounts add` of a reserved login (fresh id, same accountUuid) is healed out of the shared pool', async () => {
    const { v, accountsPath } = await vaultAt();
    const reserved = await v.addAccount('work', bundle('a')); // accountUuid 'uuid-a'
    await v.createGroup({ memberIds: [reserved.id], folders: [scopeFolder()] });

    // An OLDER cctl predates groups.json, so it cannot see the reserved row. Running `accounts add`
    // of that same login writes a NEW shared row under a fresh id carrying the SAME accountUuid — the
    // duplicate that a heal keyed on id alone would miss, leaving the reserved login back in the
    // global pool (an auto-switch candidate and a network-refresh target for its single-use token).
    const accounts = await readJson(accountsPath);
    (accounts.accounts as Record<string, unknown>[]).push({
      id: 'stray-dup',
      label: 'work-again',
      accountUuid: 'uuid-a',
      quarantined: false,
      createdAtMs: 5,
      updatedAtMs: 5,
    });
    accounts.activeId = 'stray-dup';
    await writeFile(accountsPath, JSON.stringify(accounts), 'utf8');

    // The healed view: the reserved login is absent from the shared/global pool, and the stale global
    // active id pointing at the stray copy is dropped.
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([]);
    expect(await v.getActiveId()).toBeNull();
    // getAccount by the stray id no longer resolves — refreshToken() would refuse it as unknown
    // rather than network-refreshing (and rotating) the reserved login's token.
    expect(await v.getAccount('stray-dup')).toBeUndefined();
    // The unified view still holds the reserved login exactly once, on its group.
    const all = await v.listAllAccounts();
    expect(all.filter((r) => r.accountUuid === 'uuid-a')).toHaveLength(1);
    expect(all.find((r) => r.accountUuid === 'uuid-a')?.groupId).toBeDefined();

    // heal() flushes the drop so an older cctl reading accounts.json never sees the reserved login.
    expect(await v.heal()).toBe(true);
    const afterHeal = await readJson(accountsPath);
    expect((afterHeal.accounts as unknown[]).length).toBe(0);
    expect(afterHeal.activeId).toBeNull();
    expect(await v.heal()).toBe(false);
  });
});

describe('group labels are stored terminal-safe', () => {
  it('strips escape sequences, controls and bidi overrides from a given label, as account labels are', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));

    const group = await v.createGroup({
      memberIds: [a.id],
      folders: ['C:\\work'],
      label: 'x\u001b[2Jy\u202eevil\u0007',
    });

    // The same stripping addAccount applies: the controls go, the now-inert printable text stays.
    expect(group.label).toBe('x[2Jyevil');
    expect((await v.getGroup(group.id))?.label).toBe('x[2Jyevil');
  });

  it('falls back to the member labels when nothing printable is left', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));

    const group = await v.createGroup({
      memberIds: [a.id],
      folders: ['C:\\w'],
      label: ' \u001b\u0007\u202e\n ',
    });

    expect(group.label).toBe('work');
  });

  it('strips an alias-only binding label the same way', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));

    const group = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'feature' }],
      label: 'x\u001b]0;owned\u0007y\u202e',
    });

    expect(group.label).toBe('x]0;ownedy');
    expect((await v.getGroup(group.id))?.label).toBe('x]0;ownedy');
  });
});

describe('groups.json keeps fields this build does not know', () => {
  it('carries unknown top-level and group-level fields through a rewrite', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const group = await v.createGroup({ memberIds: [a.id, b.id], folders: ['C:\\work'] });
    // A later build of the same schema adds a field at each level.
    const file = await readJson(groupsPath);
    file.futureTopLevel = { keep: true };
    (file.groups as Record<string, unknown>[])[0]!.futureScopes = [
      { kind: 'branch', name: 'main' },
    ];
    await writeFile(groupsPath, JSON.stringify(file), 'utf8');

    // An ordinary group write by this build.
    await v.setGroupActive(group.id, a.id);

    const after = await readJson(groupsPath);
    expect(after.futureTopLevel).toEqual({ keep: true });
    const g = (after.groups as Record<string, unknown>[])[0]!;
    expect(g.futureScopes).toEqual([{ kind: 'branch', name: 'main' }]);
    expect(g.activeId).toBe(a.id);
    // This build's own fields still win, and the unknown ones never leak into what it hands out.
    expect(Object.keys((await v.getGroup(group.id))!)).not.toContain('futureScopes');
  });

  it('drops the unknown fields of a group that no longer exists', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const g1 = await v.createGroup({ memberIds: [a.id], folders: ['C:\\one'] });
    await v.createGroup({ memberIds: [b.id], folders: ['C:\\two'] });
    const file = await readJson(groupsPath);
    for (const g of file.groups as Record<string, unknown>[]) g.futureScopes = [g.id];
    await writeFile(groupsPath, JSON.stringify(file), 'utf8');

    await v.releaseAccounts(g1.id, [a.id]);

    const after = await readJson(groupsPath);
    const groups = after.groups as Record<string, unknown>[];
    expect(groups).toHaveLength(1);
    expect(groups[0]!.futureScopes).toEqual([groups[0]!.id]);
  });
});

describe('alias scopes beside the groups.json fields this build does not know', () => {
  it('writes aliases as its own field at schema 2, keeping the unknown ones beside them', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const group = await v.createGroup({
      memberIds: [a.id],
      aliases: [{ folder: 'C:\\repo', alias: 'Feature' }],
    });
    const file = await readJson(groupsPath);
    file.futureTopLevel = 1;
    (file.groups as Record<string, unknown>[])[0]!.futureScopes = ['kept'];
    await writeFile(groupsPath, JSON.stringify(file), 'utf8');

    // An ordinary group write by this build.
    await v.setGroupActive(group.id, a.id);

    const after = await readJson(groupsPath);
    expect(after.schemaVersion).toBe(2);
    expect(after.futureTopLevel).toBe(1);
    const g = (after.groups as Record<string, unknown>[])[0]!;
    expect(g.aliases).toEqual([{ folder: 'C:\\repo', alias: 'Feature' }]);
    expect(g.futureScopes).toEqual(['kept']);
    // aliases is handed out (this build owns it); the unknown field is not.
    const view = (await v.getGroup(group.id))!;
    expect(view.aliases).toEqual([{ folder: 'C:\\repo', alias: 'Feature' }]);
    expect(Object.keys(view)).not.toContain('futureScopes');
  });

  it('drops aliases when the last alias scope goes, never writing them back from the unknown fields', async () => {
    const { v, vaultDir, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const group = await v.createGroup({
      memberIds: [a.id],
      folders: ['C:\\work'],
      aliases: [{ folder: 'C:\\repo', alias: 'feature' }],
    });
    const file = await readJson(groupsPath);
    (file.groups as Record<string, unknown>[])[0]!.futureScopes = ['kept'];
    await writeFile(groupsPath, JSON.stringify(file), 'utf8');

    await v.removeAliasFromGroup(group.id, { folder: 'C:\\repo', alias: 'feature' });

    const after = await readJson(groupsPath);
    // No alias left: the older shape again, which a folder-only build reads.
    expect(after.schemaVersion).toBe(1);
    const g = (after.groups as Record<string, unknown>[])[0]!;
    expect(Object.keys(g)).not.toContain('aliases');
    expect(g.futureScopes).toEqual(['kept']);
    // A fresh load (another process) sees the alias gone too.
    const fresh = new Vault(
      vaultDir,
      new InsecurePassthroughProtector(),
      () => 5000,
      undefined,
      'win32',
    );
    expect((await fresh.getGroup(group.id))?.aliases).toBeUndefined();
    // And the next write by that process keeps it gone.
    await fresh.setGroupActive(group.id, a.id);
    const again = (await readJson(groupsPath)).groups as Record<string, unknown>[];
    expect(Object.keys(again[0]!)).not.toContain('aliases');
  });

  it('refuses an unknown schema version still, whatever fields ride along', async () => {
    const { v, groupsPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    await v.createGroup({ memberIds: [a.id], aliases: [{ folder: 'C:\\repo', alias: 'x' }] });
    const file = await readJson(groupsPath);
    file.schemaVersion = 3;
    await writeFile(groupsPath, JSON.stringify(file), 'utf8');

    await expect(v.listGroups()).rejects.toThrow(/unsupported schemaVersion \(3\)/);
  });
});
