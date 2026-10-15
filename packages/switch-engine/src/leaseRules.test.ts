// Parallel sessions as rules: the pure pool rules (pinned, never a fallback), the holder-list
// helpers, and the vault's side of the fence — schema 4 while one exists, strict validation on read,
// the same validation before every write, the one holder mutator, and the shared pool order restored
// when the session ends.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  availableInOrder,
  describeRuleScopes,
  isLeaseRule,
  leaseRuleId,
  operatorRules,
  slotMayHold,
  slotMembers,
  slotPool,
  withHolders,
  withoutHolders,
  type RulesPicture,
} from './folderRules.js';
import { Vault, assertReadableRulesSchema, MAX_LEASE_HOLDERS } from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { buildFolderBindingSnapshot, folderBindingSnapshotContentEqual } from './folderBindings.js';
import { LeaseHolderCapError, LeaseHoldersEmptyError, RulesWriteRefusedError } from './errors.js';
import { ruleSlotId } from './types.js';
import type {
  CredentialBundle,
  FolderRule,
  LeaseHolder,
  SlotId,
  StoredAccount,
} from './types.js';

const row = (id: string, over: Partial<StoredAccount> = {}): StoredAccount => ({
  id,
  label: id.toUpperCase(),
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const holder = (pid: number, over: Partial<LeaseHolder> = {}): LeaseHolder => ({
  pid,
  start: 1000 + pid,
  host: 'BOX',
  platform: 'win32',
  role: 'launcher',
  ...over,
});

const leaseOn = (accountId: string, over: Partial<FolderRule> = {}): FolderRule => ({
  id: leaseRuleId(accountId),
  label: accountId.toUpperCase(),
  folders: [],
  include: [accountId],
  exclude: [],
  activeId: accountId,
  createdAtMs: 0,
  updatedAtMs: 0,
  lease: { holders: [holder(10)], startedAtMs: 0 },
  ...over,
});

describe('pools around a parallel session', () => {
  // w is leased; a and b are shared; f is a folder rule that excludes nothing.
  const folderRule: FolderRule = {
    id: 'f',
    label: 'repo',
    folders: ['C:\\repo'],
    include: [],
    exclude: ['b'],
    activeId: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const picture: RulesPicture = {
    shared: [row('a'), row('b'), row('q', { quarantined: true })],
    reserved: [row('w')],
    rules: [folderRule, leaseOn('w')],
  };
  const leaseSlot = ruleSlotId(leaseRuleId('w'));

  it('a parallel-session slot may hold its own account and nothing else', () => {
    expect(slotMayHold(leaseSlot, 'w', picture)).toBe(true);
    expect(slotMayHold(leaseSlot, 'a', picture)).toBe(false);
    expect(slotMayHold(leaseSlot, 'b', picture)).toBe(false);
  });

  it('its pool is its account alone, never the shared pool; a quarantined account leaves it empty', () => {
    expect(slotMembers(leaseSlot, picture).map((e) => e.account.id)).toEqual(['w']);
    const q: RulesPicture = {
      ...picture,
      reserved: [row('w', { quarantined: true })],
    };
    expect(slotMembers(leaseSlot, q)).toEqual([]);
  });

  it('the leased account is in no other pool: not the global one, not a folder inheriting it', () => {
    const occupancy = new Map<SlotId, Set<string>>([
      ['global', new Set(['a'])],
      [ruleSlotId('f'), new Set<string>()],
      [leaseSlot, new Set(['w'])],
    ]);
    expect(availableInOrder(slotPool('global', picture, occupancy)).map((a) => a.id)).not.toContain(
      'w',
    );
    expect(
      availableInOrder(slotPool(ruleSlotId('f'), picture, occupancy)).map((a) => a.id),
    ).not.toContain('w');
    expect(slotMayHold('global', 'w', picture)).toBe(false);
  });

  it('is named as a parallel session, and left out of the operator rules', () => {
    expect(describeRuleScopes(leaseOn('w'))).toBe('a parallel session of W (until it exits)');
    expect(operatorRules(picture.rules).map((r) => r.id)).toEqual(['f']);
    expect(isLeaseRule(leaseOn('w'))).toBe(true);
    expect(isLeaseRule(folderRule)).toBe(false);
  });
});

describe('holder lists', () => {
  it('withHolders replaces a record on the same process (a reused pid), never appends a twin', () => {
    const old = holder(10);
    const reused = holder(10, { start: 9999 });
    expect(withHolders([old, holder(11)], [reused])).toEqual([holder(11), reused]);
  });

  it('withHolders keeps a same-pid record of another host or namespace', () => {
    const other = holder(10, { host: 'OTHER' });
    expect(withHolders([holder(10)], [other])).toHaveLength(2);
  });

  it('withoutHolders removes by full identity only', () => {
    const list = [holder(10), holder(11)];
    expect(withoutHolders(list, [holder(10)])).toEqual([holder(11)]);
    expect(withoutHolders(list, [holder(10, { start: 1 })])).toEqual(list);
  });
});

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: 1e13 },
  oauthAccount: { accountUuid: 'uuid-' + token },
});

/** A vault with shared accounts A, B, C (in that order). */
async function vaultWithThree() {
  const root = await mkdtemp(join(tmpdir(), 'ce-lease-'));
  dirs.push(root);
  const vaultDir = join(root, 'vault');
  await mkdir(vaultDir, { recursive: true });
  const vault = new Vault(
    vaultDir,
    new InsecurePassthroughProtector(),
    () => 5,
    undefined,
    'win32',
  );
  const A = await vault.addAccount('A', bundle('a'));
  const B = await vault.addAccount('B', bundle('b'));
  const C = await vault.addAccount('C', bundle('c'));
  const groups = join(vaultDir, 'groups.json');
  const rulesFile = async (): Promise<Record<string, unknown>> =>
    JSON.parse(await readFile(groups, 'utf8')) as Record<string, unknown>;
  return { vault, vaultDir, groups, rulesFile, A, B, C };
}

describe('the vault: schema 4 while a parallel session exists', () => {
  it('stamps 2 with nothing, 3 with an alias rule, 4 with a lease, and 4 with both', async () => {
    const { vault, A, B, C, rulesFile } = await vaultWithThree();
    await vault.createRule({ folders: ['C:\\repo'], include: [A.id] });
    expect((await rulesFile()).schemaVersion).toBe(2);
    await vault.createRule({
      folders: [],
      aliases: [{ folder: 'C:\\repo', alias: 'x' }],
      exclude: [B.id],
    });
    expect((await rulesFile()).schemaVersion).toBe(3);
    const lease = await vault.createRule({
      folders: [],
      include: [C.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect(lease.id).toBe(leaseRuleId(C.id));
    expect((await rulesFile()).schemaVersion).toBe(4);
    await vault.removeRule(lease.id);
    expect((await rulesFile()).schemaVersion).toBe(3);
  });

  it('drops back to 2 when the last parallel session ends', async () => {
    const { vault, A, rulesFile } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect((await rulesFile()).schemaVersion).toBe(4);
    await vault.removeRule(lease.id);
    const file = await rulesFile();
    expect(file.schemaVersion).toBe(2);
    expect(file.rules).toEqual([]);
  });

  it('the loader accepts 4 and refuses 5; an older build accepting only 2 and 3 refuses 4', async () => {
    const { vault, A, groups } = await vaultWithThree();
    await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect(await vault.listRules()).toHaveLength(1);
    const file = JSON.parse(await readFile(groups, 'utf8')) as Record<string, unknown>;
    expect(() => assertReadableRulesSchema(file.schemaVersion, [2, 3])).toThrow(
      /unsupported schemaVersion \(4\)/,
    );
    await writeFile(groups, JSON.stringify({ ...file, schemaVersion: 5 }));
    await expect(vault.listRules()).rejects.toThrow(/unsupported schemaVersion \(5\)/);
  });

  it('a removed lease is not resurrected from the carried-forward extras', async () => {
    const { vault, A, B, groups } = await vaultWithThree();
    await vault.createRule({ folders: ['C:\\repo'], include: [B.id] });
    const lease = await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    await vault.removeRule(lease.id);
    // Another write after the removal: the rule must not come back.
    await vault.setRuleActive((await vault.listRules())[0]!.id, B.id);
    const text = await readFile(groups, 'utf8');
    expect(text).not.toContain('"lease"');
    expect(text).not.toContain(lease.id);
  });
});

describe('the vault: a lease that does not validate is refused on read', () => {
  /** Write a good lease, then edit the file and expect the read to refuse it. */
  async function refusedAfter(
    edit: (file: { rules: Array<Record<string, unknown>> }) => void,
    message: RegExp,
  ): Promise<void> {
    const { vault, A, B, groups } = await vaultWithThree();
    await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10), holder(11, { role: 'claude', parent: 10 })], startedAtMs: 7 },
    });
    const file = JSON.parse(await readFile(groups, 'utf8')) as {
      rules: Array<Record<string, unknown>>;
      reserved: unknown[];
    };
    // Some edits need a second reserved account to point at.
    file.reserved.push({ ...row(B.id), label: 'B' });
    edit(file);
    await writeFile(groups, JSON.stringify(file));
    await expect(vault.listRules()).rejects.toThrow(message);
  }
  const lease = (f: { rules: Array<Record<string, unknown>> }) =>
    f.rules[0]!.lease as { holders: Array<Record<string, unknown>>; [k: string]: unknown };

  it('with folders', () =>
    refusedAfter((f) => (f.rules[0]!.folders = ['C:\\x']), /folders or aliases/));
  it('with a second include', () =>
    refusedAfter(
      (f) =>
        (f.rules[0]!.include = [
          ...(f.rules[0]!.include as string[]),
          (f as unknown as { reserved: Array<{ id: string }> }).reserved[1]!.id,
        ]),
      /does not name exactly one account/,
    ));
  it('with the wrong id', () =>
    refusedAfter((f) => (f.rules[0]!.id = 'session-someone-else'), /id does not name its account/));
  it('naming one process twice', () =>
    refusedAfter(
      (f) => lease(f).holders.push({ ...lease(f).holders[0]! }),
      /names process 10 twice/,
    ));
  it('with no holders', () => refusedAfter((f) => (lease(f).holders = []), /has no holders/));
  it('with 33 holders', () =>
    refusedAfter(
      (f) =>
        (lease(f).holders = Array.from({ length: 33 }, (_, i) => ({ ...holder(100 + i) }))),
      /33 processes/,
    ));
  it('with a bad role', () =>
    refusedAfter((f) => (lease(f).holders[0]!.role = 'visitor'), /role is not/));
  it('with a darwin platform', () =>
    refusedAfter((f) => (lease(f).holders[0]!.platform = 'darwin'), /platform is not/));
  it('with an unknown key in the lease', () =>
    refusedAfter((f) => (lease(f).owner = 'x'), /unknown field "owner"/));
  it('with an unknown key in a holder', () =>
    refusedAfter((f) => (lease(f).holders[0]!.tty = 'x'), /unknown field "tty"/));
  it('live on another account', () =>
    refusedAfter((f) => (f.rules[0]!.activeId = 'other'), /live on another account/));
});

describe('the vault: no write produces a file this build refuses', () => {
  it('saveRules refuses a duplicate holder injected into memory; the file is unchanged', async () => {
    const { vault, A, B, groups } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    const before = await readFile(groups, 'utf8');
    // The mutator writes the list it is handed; a list naming one process twice reaches the writer,
    // whose own read-back refuses it before anything lands on disk.
    await expect(
      vault.setLeaseHolders(lease.id, [holder(10), holder(10, { start: 5 })]),
    ).rejects.toThrow(RulesWriteRefusedError);
    expect(await readFile(groups, 'utf8')).toBe(before);
    expect(await vault.listRules()).toHaveLength(1);
    // A plain rule edit still writes.
    await vault.createRule({ folders: ['C:\\repo'], include: [B.id] });
    expect(await vault.listRules()).toHaveLength(2);
  });

  it('saveRules refuses a new lease with an empty holder list or 33 holders; nothing is written', async () => {
    const { vault, A, B, groups } = await vaultWithThree();
    await vault.createRule({ folders: ['C:\repo'], include: [B.id] });
    const before = await readFile(groups, 'utf8');
    await expect(
      vault.createRule({ folders: [], include: [A.id], lease: { holders: [], startedAtMs: 7 } }),
    ).rejects.toThrow(RulesWriteRefusedError);
    const many = Array.from({ length: MAX_LEASE_HOLDERS + 1 }, (_, i) => holder(100 + i));
    await expect(
      vault.createRule({ folders: [], include: [A.id], lease: { holders: many, startedAtMs: 7 } }),
    ).rejects.toThrow(RulesWriteRefusedError);
    expect(await readFile(groups, 'utf8')).toBe(before);
    // The account the refused writes would have reserved is still shared.
    expect((await vault.listAccounts()).map((a) => a.id)).toContain(A.id);
  });

  it('setLeaseHolders refuses an empty list and 33 holders, writing nothing', async () => {
    const { vault, A, groups } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    const before = await readFile(groups, 'utf8');
    await expect(vault.setLeaseHolders(lease.id, [])).rejects.toThrow(LeaseHoldersEmptyError);
    const many = Array.from({ length: MAX_LEASE_HOLDERS + 1 }, (_, i) => holder(100 + i));
    await expect(vault.setLeaseHolders(lease.id, many)).rejects.toThrow(LeaseHolderCapError);
    expect(await readFile(groups, 'utf8')).toBe(before);
  });

  it('setLeaseHolders bumps the generation', async () => {
    const { vault, A } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [A.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    const before = await vault.getRulesGeneration();
    await vault.setLeaseHolders(lease.id, [holder(10), holder(11)]);
    expect(await vault.getRulesGeneration()).toBe(before + 1);
  });
});

describe('the vault: the shared pool order across a parallel session', () => {
  it('reserves a shared row, records its index, and puts it back there on removal', async () => {
    const { vault, B } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [B.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect(lease.lease?.restoreIndex).toBe(1);
    expect((await vault.listAccounts()).map((a) => a.label)).toEqual(['A', 'C']);
    await vault.removeRule(lease.id);
    expect((await vault.listAccounts()).map((a) => a.label)).toEqual(['A', 'B', 'C']);
  });

  it('clamps an index past the end of a pool that shrank', async () => {
    const { vault, A, B, C } = await vaultWithThree();
    const lease = await vault.createRule({
      folders: [],
      include: [C.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect(lease.lease?.restoreIndex).toBe(2);
    await vault.removeAccount(A.id);
    await vault.removeAccount(B.id);
    await vault.removeRule(lease.id);
    expect((await vault.listAccounts()).map((a) => a.label)).toEqual(['C']);
  });

  it('does not release a row another rule still includes', async () => {
    const { vault, B } = await vaultWithThree();
    const folder = await vault.createRule({ folders: ['C:\\repo'], include: [B.id] });
    const lease = await vault.createRule({
      folders: [],
      include: [B.id],
      lease: { holders: [holder(10)], startedAtMs: 7 },
    });
    expect(lease.lease?.restoreIndex).toBeUndefined();
    const { released } = await vault.removeRule(lease.id);
    expect(released).toEqual([]);
    expect((await vault.listAllAccounts()).find((a) => a.id === B.id)?.ruleIds).toEqual([
      folder.id,
    ]);
  });
});

describe('the guard snapshot of a parallel session', () => {
  const input = (rules: FolderRule[]) => ({
    rules,
    shared: [row('a')],
    reserved: [row('w')],
    generation: 3,
    enforce: 'block' as const,
    mainConfigDir: 'C:/main',
    mainIdentityFile: 'C:/main.json',
    profileDirOf: (id: string) => `C:/profiles/${id}`,
    platform: 'win32' as const,
  });

  it('marks the group kind lease, with no folders and the account as its member; schema stays 1', () => {
    const snap = buildFolderBindingSnapshot(input([leaseOn('w')]));
    expect(snap.schemaVersion).toBe(1);
    expect(snap.groups[0]).toMatchObject({ kind: 'lease', folders: [], members: ['W'] });
  });

  it('a change of kind alone is a change the guard must see', () => {
    const lease = buildFolderBindingSnapshot(input([leaseOn('w')]));
    const { kind: _kind, ...plain } = lease.groups[0]!;
    const stripped = { ...lease, groups: [plain] };
    expect(folderBindingSnapshotContentEqual(lease, stripped)).toBe(false);
    expect(folderBindingSnapshotContentEqual(lease, lease)).toBe(true);
  });
});
