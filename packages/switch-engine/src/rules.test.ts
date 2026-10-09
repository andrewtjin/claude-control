// The reserved side of the registry and the folder rules over it, at the vault level: the moves
// between accounts.json and groups.json (and their crash-safe order), the strict schema-2 loader,
// the schema-1 migration, and the downgrade fence an older build meets.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Vault,
  MAX_RULES,
  MAX_RULE_ACCOUNTS,
  MAX_RULE_FOLDERS,
  MAX_RESERVED_ACCOUNTS,
} from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { UnknownAccountError, VaultError } from './errors.js';
import type { CredentialBundle } from './types.js';

// Folder keys fold case on Windows, so every vault is pinned to 'win32' — the box this runs on is
// win32 anyway, but pinning keeps the folder assertions deterministic on any host.
let dirs: string[] = [];
async function vaultAt(platform: NodeJS.Platform = 'win32') {
  const dir = await mkdtemp(join(tmpdir(), 'ce-rules-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, undefined, platform),
    vaultDir,
    accountsPath: join(vaultDir, 'accounts.json'),
    rulesPath: join(vaultDir, 'groups.json'),
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

/** Read a JSON file as an object. */
async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

describe('createRule — including reserves, excluding does not', () => {
  it('moves included rows out of accounts.json into the reserved side and tags the unified view', async () => {
    const { v, accountsPath, rulesPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const shared = await v.addAccount('personal', bundle('c'));

    const rule = await v.createRule({
      folders: ['C:\\work'],
      include: [a.id, b.id],
      label: 'Work rule',
    });

    // The shared list (the global pool) no longer holds the reserved accounts.
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([shared.id]);
    // The unified view holds all three, and only the reserved two carry rule ids.
    const all = await v.listAllAccounts();
    expect(all.map((r) => r.id).sort()).toEqual([a.id, b.id, shared.id].sort());
    expect(all.find((r) => r.id === a.id)?.ruleIds).toEqual([rule.id]);
    expect(all.find((r) => r.id === shared.id)?.ruleIds).toBeUndefined();
    // getAccount reaches a reserved row by id.
    expect((await v.getAccount(b.id))?.label).toBe('client');

    // accounts.json no longer lists the reserved rows.
    const accounts = await readJson(accountsPath);
    expect(accounts.schemaVersion).toBe(2);
    expect((accounts.accounts as { id: string }[]).map((r) => r.id)).toEqual([shared.id]);

    // groups.json is schema 2: the moved rows under `reserved`, the rule naming them by id in order.
    const file = await readJson(rulesPath);
    expect(file.schemaVersion).toBe(2);
    expect(file.generation).toBe(1);
    expect((file.reserved as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    const persisted = (file.rules as Record<string, unknown>[])[0]!;
    expect(persisted.include).toEqual([a.id, b.id]);
    expect(persisted.exclude).toEqual([]);
    expect(persisted.folders).toEqual(['C:\\work']);
    expect(persisted.activeId).toBeNull();
  });

  it('excluding leaves the excluded account shared and moves nothing', async () => {
    const { v, accountsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const before = await readFile(accountsPath, 'utf8');
    const rule = await v.createRule({ folders: ['C:\\x'], exclude: [b.id] });
    expect(rule.include).toEqual([]);
    expect(rule.exclude).toEqual([b.id]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id, b.id]);
    // An exclude-only rule writes groups.json alone.
    expect(await readFile(accountsPath, 'utf8')).toBe(before);
  });

  it('defaults the label to the folder', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const rule = await v.createRule({ folders: ['C:\\proj'], include: [a.id] });
    expect(rule.label).toBe('C:\\proj');
  });

  it('clears the global active id when the account being reserved was live in the global slot', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    await v.setActive(a.id);
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    expect(await v.getActiveId()).toBeNull();
  });

  it('refuses an empty rule, an unknown id, and an account both included and excluded', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    await expect(v.createRule({ folders: ['C:\\w'] })).rejects.toThrow(/at least one account/);
    await expect(v.createRule({ folders: ['C:\\w'], include: ['nope'] })).rejects.toThrow(
      UnknownAccountError,
    );
    await expect(v.createRule({ folders: ['C:\\w'], exclude: ['nope'] })).rejects.toThrow(
      UnknownAccountError,
    );
    await expect(
      v.createRule({ folders: ['C:\\w'], include: [a.id], exclude: [a.id] }),
    ).rejects.toThrow(/cannot also be excluded/);
    // Nothing was written by any refusal.
    expect(await v.listRules()).toEqual([]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
  });

  it('an account another rule reserves is shared by reference, not moved again', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    const r2 = await v.createRule({ folders: ['C:\\two'], include: [a.id] });
    const file = await readJson(rulesPath);
    expect((file.reserved as unknown[]).length).toBe(1);
    const all = await v.listAllAccounts();
    expect(all.find((r) => r.id === a.id)?.ruleIds).toEqual([r1.id, r2.id]);
  });

  it('refuses to exclude a reserved account, naming the folder that reserves it', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    await expect(v.createRule({ folders: ['C:\\two'], exclude: [a.id] })).rejects.toThrow(
      /"alpha" is reserved to C:\\one; only a shared account can be excluded/,
    );
  });

  it('refuses a folder another rule already holds, but allows a nested subfolder', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    await v.createRule({ folders: ['C:\\work'], include: [a.id] });
    await expect(v.createRule({ folders: ['c:\\WORK'], include: [b.id] })).rejects.toThrow(
      /already has a folder rule/,
    );
    await expect(v.createRule({ folders: ['C:/work'], include: [b.id] })).rejects.toThrow(
      /already has a folder rule/,
    );
    const nested = await v.createRule({ folders: ['C:\\work\\client'], include: [b.id] });
    expect(nested.folders).toEqual(['C:\\work\\client']);
  });

  it('checkCreateRule runs every refusal and writes nothing', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    await expect(v.checkCreateRule({ folders: ['C:\\w'], include: ['ghost'] })).rejects.toThrow(
      UnknownAccountError,
    );
    await v.checkCreateRule({ folders: ['C:\\w'], include: [a.id] });
    await expect(readFile(rulesPath, 'utf8')).rejects.toThrow();
  });
});

describe('include / exclude / remove — moving rows between the two files', () => {
  it('includeAccounts grows a rule, reserving shared rows and only referencing reserved ones', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const c = await v.addAccount('c', bundle('c'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    const r2 = await v.createRule({ folders: ['C:\\two'], include: [c.id] });
    const res = await v.includeAccounts(r1.id, [b.id, c.id, a.id]);
    expect(res.rule.include).toEqual([a.id, b.id, c.id]);
    // Only b moved: c was already reserved (to r2), a already included.
    expect(res.reserved).toEqual([b.id]);
    expect((await v.listAccounts()).length).toBe(0);
    expect((await v.getRule(r2.id))?.include).toEqual([c.id]);
  });

  it('including an excluded account moves it from the exclude list to the include list', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\one'], exclude: [a.id, b.id] });
    const res = await v.includeAccounts(rule.id, [a.id]);
    expect(res.unexcluded).toEqual([a.id]);
    expect(res.rule.include).toEqual([a.id]);
    expect(res.rule.exclude).toEqual([b.id]);
  });

  it('is a no-op (no write) when everything is already included or excluded', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\one'], include: [a.id], exclude: [b.id] });
    const before = await readFile(rulesPath, 'utf8');
    await v.includeAccounts(rule.id, [a.id]);
    await v.excludeAccounts(rule.id, [b.id]);
    expect(await readFile(rulesPath, 'utf8')).toBe(before);
  });

  it('refuses an include past the per-rule cap, writing nothing', async () => {
    const { v } = await vaultAt();
    const ids: string[] = [];
    for (let i = 0; i <= MAX_RULE_ACCOUNTS; i += 1) {
      ids.push((await v.addAccount(`m${i}`, bundle(`m${i}`))).id);
    }
    const rule = await v.createRule({ folders: ['C:\\one'], include: ids.slice(0, 1) });
    await expect(v.includeAccounts(rule.id, ids)).rejects.toThrow(
      `more than ${MAX_RULE_ACCOUNTS} accounts`,
    );
    await expect(v.checkInclude(rule.id, ids)).rejects.toThrow(VaultError);
    expect((await v.getRule(rule.id))?.include).toEqual(ids.slice(0, 1));
  });

  it('excludeAccounts refuses an account this rule includes, naming it', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    const rule = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    await expect(v.excludeAccounts(rule.id, [a.id])).rejects.toThrow(
      /"alpha" is included by this folder rule/,
    );
    await expect(v.checkExclude(rule.id, [a.id])).rejects.toThrow(VaultError);
  });

  it('removeFromRule releases an account no other rule includes', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id, b.id] });
    const res = await v.removeFromRule(r1.id, [a.id]);
    expect(res.released).toEqual([a.id]);
    expect(res.rule.include).toEqual([b.id]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
  });

  it('removeFromRule keeps an account another rule still includes reserved', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id, b.id] });
    await v.createRule({ folders: ['C:\\two'], include: [b.id] });
    const res = await v.removeFromRule(r1.id, [b.id]);
    expect(res.released).toEqual([]);
    expect(res.rule.include).toEqual([a.id]);
    expect((await v.listAllAccounts()).find((r) => r.id === b.id)?.ruleIds).toHaveLength(1);
  });

  it('removeFromRule drops an exclusion without moving any row', async () => {
    const { v, accountsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\one'], exclude: [a.id, b.id] });
    const before = await readFile(accountsPath, 'utf8');
    const res = await v.removeFromRule(rule.id, [a.id]);
    expect(res.rule.exclude).toEqual([b.id]);
    expect(res.released).toEqual([]);
    expect(await readFile(accountsPath, 'utf8')).toBe(before);
  });

  it('removeFromRule refuses an id the rule does not name, and a removal that empties the rule', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    const b = await v.addAccount('beta', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    await expect(v.removeFromRule(rule.id, [b.id])).rejects.toThrow(
      /"beta" is neither included nor excluded/,
    );
    await expect(v.removeFromRule(rule.id, [a.id])).rejects.toThrow(/remove the rule instead/);
    expect((await v.getRule(rule.id))?.include).toEqual([a.id]);
  });

  it('removeRule releases only the accounts no other rule includes', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id, b.id] });
    await v.createRule({ folders: ['C:\\two'], include: [b.id] });
    const res = await v.removeRule(r1.id);
    expect(res.released).toEqual([a.id]);
    expect(await v.getRule(r1.id)).toBeUndefined();
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
    expect(((await readJson(rulesPath)).reserved as { id: string }[]).map((r) => r.id)).toEqual([
      b.id,
    ]);
  });

  it('bumps the generation on every reserved-side write', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    expect((await readJson(rulesPath)).generation).toBe(1);
    await v.includeAccounts(rule.id, [b.id]);
    expect((await readJson(rulesPath)).generation).toBe(2);
    await v.setRuleActive(rule.id, a.id);
    expect(await v.getRulesGeneration()).toBe(3);
  });
});

describe('crash-safe order between the two files', () => {
  it('a reservation interrupted after groups.json: the row in both files reads as reserved', async () => {
    const { v, accountsPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const before = await readJson(accountsPath);
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    // Put accounts.json back as it was before its (second) write — the state a crash between leaves
    // — with the global active id still naming the account.
    before.activeId = a.id;
    await writeFile(accountsPath, JSON.stringify(before), 'utf8');
    expect((await v.listAccounts()).length).toBe(0);
    expect((await v.listAllAccounts()).filter((r) => r.id === a.id)).toHaveLength(1);
    expect(await v.getActiveId()).toBeNull();
    expect(await v.heal()).toBe(true);
    expect(((await readJson(accountsPath)).accounts as unknown[]).length).toBe(0);
    expect(await v.heal()).toBe(false);
  });

  it('a release interrupted after accounts.json: groups.json still wins, so the release reverts and reruns', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const rule = await v.createRule({ folders: ['C:\\w'], include: [a.id, b.id] });
    const rulesBefore = await readFile(rulesPath, 'utf8');
    await v.removeFromRule(rule.id, [a.id]);
    // Restore groups.json to its pre-release content: accounts.json (written first) has the row.
    await writeFile(rulesPath, rulesBefore, 'utf8');
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([]);
    expect((await v.getRule(rule.id))?.include).toEqual([a.id, b.id]);
    // The rerun completes the release.
    const res = await v.removeFromRule(rule.id, [a.id]);
    expect(res.released).toEqual([a.id]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([a.id]);
  });
});

describe('folder + active mutations on a rule', () => {
  it('removes a folder stored under a non-canonical spelling when queried canonically', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const rule = await v.createRule({ folders: ['C:\\keep'], include: [a.id] });
    // A migrated rule can hold several folders; give this one a second, non-canonical spelling.
    const file = await readJson(rulesPath);
    (file.rules as { folders: string[] }[])[0]!.folders.push('C:/g/8');
    await writeFile(rulesPath, JSON.stringify(file), 'utf8');
    await v.removeFolderFromRule(rule.id, 'C:\\g\\8');
    expect((await v.getRule(rule.id))?.folders).toEqual(['C:\\keep']);
    await expect(v.removeFolderFromRule(rule.id, 'C:\\nope')).rejects.toThrow(/not in folder rule/);
  });

  it('sets and clears the live account: an included one or a non-excluded shared one, never another', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    const excluded = await v.addAccount('excluded', bundle('e'));
    const other = await v.addAccount('other', bundle('o'));
    const rule = await v.createRule({
      folders: ['C:\\w'],
      include: [a.id],
      exclude: [excluded.id],
    });
    await v.createRule({ folders: ['C:\\v'], include: [other.id] });
    await v.setRuleActive(rule.id, a.id);
    expect((await v.getRule(rule.id))?.activeId).toBe(a.id);
    // An inherited shared account may hold the slot.
    await v.setRuleActive(rule.id, shared.id);
    expect((await v.getRule(rule.id))?.activeId).toBe(shared.id);
    // An excluded one, or one reserved only to another rule, may not.
    await expect(v.setRuleActive(rule.id, excluded.id)).rejects.toThrow(/not in the pool/);
    await expect(v.setRuleActive(rule.id, other.id)).rejects.toThrow(/not in the pool/);
    await expect(v.setRuleActive(rule.id, 'ghost')).rejects.toThrow(UnknownAccountError);
    await v.setRuleActive(rule.id, null);
    expect((await v.getRule(rule.id))?.activeId).toBeNull();
  });

  it('setActive (the global slot) refuses a reserved account', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    await expect(v.setActive(a.id)).rejects.toThrow(UnknownAccountError);
  });
});

describe('row-level mutations route to the file that holds the row', () => {
  it('quarantine / exclude / rename / metadata land in groups.json for a reserved account', async () => {
    const { v, accountsPath } = await vaultAt();
    const a = await v.addAccount('reserved', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    const accountsBefore = await readFile(accountsPath, 'utf8');

    await v.quarantine(a.id, 'dead token');
    await v.setAutoSwitchExcluded(a.id, true);
    await v.renameAccount(a.id, 'reserved-renamed');

    // The shared file did not move; every mutation of the reserved row went to groups.json.
    expect(await readFile(accountsPath, 'utf8')).toBe(accountsBefore);
    const row = (await v.readPicture()).reserved.find((r) => r.id === a.id)!;
    expect(row.quarantined).toBe(true);
    expect(row.quarantineReason).toBe('dead token');
    expect(row.autoSwitchExcluded).toBe(true);
    expect(row.label).toBe('reserved-renamed');
    expect((await v.getAccount(shared.id))?.label).toBe('shared');
  });

  it('rename refuses a label a reserved account already carries (union namespace)', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    await expect(v.renameAccount(shared.id, 'alpha')).rejects.toThrow(/already refers to account/);
  });

  it('addAccount refuses a login already reserved', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('alpha', bundle('a'));
    await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    await expect(v.addAccount('again', bundle('a'))).rejects.toThrow(/already stored/);
  });

  it('removeAccount drops a reserved account from every rule and dissolves a rule left empty', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id, b.id] });
    const r2 = await v.createRule({ folders: ['C:\\two'], include: [a.id] });
    await v.setRuleActive(r1.id, a.id);
    await v.removeAccount(a.id);
    expect((await v.getRule(r1.id))?.include).toEqual([b.id]);
    expect((await v.getRule(r1.id))?.activeId).toBeNull();
    // r2 included only a: nothing is left, so it is gone.
    expect(await v.getRule(r2.id)).toBeUndefined();
    await expect(v.readBundle(a.id)).rejects.toThrow();
  });

  it('removeAccount of a shared account drops it from exclude lists, dissolving an emptied rule', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const b = await v.addAccount('b', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], exclude: [a.id, b.id] });
    const r2 = await v.createRule({ folders: ['C:\\two'], exclude: [a.id] });
    await v.removeAccount(a.id);
    expect((await v.getRule(r1.id))?.exclude).toEqual([b.id]);
    expect(await v.getRule(r2.id)).toBeUndefined();
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([b.id]);
  });

  it('removeAccount clears a rule live account that was an inherited shared account', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('a', bundle('a'));
    const s = await v.addAccount('s', bundle('s'));
    const rule = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    await v.setRuleActive(rule.id, s.id);
    await v.removeAccount(s.id);
    expect((await v.getRule(rule.id))?.activeId).toBeNull();
    expect((await v.getRule(rule.id))?.include).toEqual([a.id]);
  });

  it('dedupes reserved rows using the rules live accounts, and re-points every rule at the survivor', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('dup', bundle('a'));
    const rule = await v.createRule({ folders: ['C:\\w'], include: [a.id] });
    await v.setRuleActive(rule.id, a.id);
    // Smuggle a second row with the same login into the reserved side, included by a second rule.
    const file = await readJson(rulesPath);
    (file.reserved as Record<string, unknown>[]).push({
      id: 'dup-2',
      label: 'dup',
      accountUuid: 'uuid-a',
      quarantined: false,
      createdAtMs: 5000,
      updatedAtMs: 5000,
    });
    (file.rules as Record<string, unknown>[]).push({
      id: 'r2',
      label: 'r2',
      folders: ['C:\\v'],
      include: ['dup-2'],
      exclude: [],
      activeId: 'dup-2',
      createdAtMs: 1,
      updatedAtMs: 1,
    });
    await writeFile(rulesPath, JSON.stringify(file), 'utf8');
    const report = await v.dedupeAccounts();
    expect(report.merged).toEqual([{ label: 'dup', keptId: a.id, removedId: 'dup-2' }]);
    const r2 = await v.getRule('r2');
    expect(r2?.include).toEqual([a.id]);
    expect(r2?.activeId).toBe(a.id);
    expect((await v.readPicture()).reserved.map((r) => r.id)).toEqual([a.id]);
  });
});

describe('strict validation of a schema-2 groups.json fails CLOSED, naming the field, leaving the file', () => {
  async function withRulesFile(content: string) {
    const ctx = await vaultAt();
    await mkdir(ctx.vaultDir, { recursive: true });
    await writeFile(ctx.rulesPath, content, 'utf8');
    return ctx;
  }
  async function expectRefusal(content: string, pattern: RegExp) {
    const { v, rulesPath } = await withRulesFile(content);
    const before = await readFile(rulesPath, 'utf8');
    await expect(v.listRules()).rejects.toThrow(VaultError);
    await expect(v.listRules()).rejects.toThrow(pattern);
    expect(await readFile(rulesPath, 'utf8')).toBe(before);
  }
  const row = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    label: id,
    quarantined: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  });
  const rule = (over: Record<string, unknown> = {}) => ({
    id: 'r1',
    label: 'r',
    folders: [],
    include: ['m1'],
    exclude: [],
    activeId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  });
  const file = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      schemaVersion: 2,
      generation: 0,
      reserved: [row('m1')],
      rules: [rule()],
      ...over,
    });

  it('accepts a well-formed file', async () => {
    const { v } = await withRulesFile(file());
    expect((await v.listRules()).map((r) => r.id)).toEqual(['r1']);
  });

  it('refuses an unsupported schemaVersion', () =>
    expectRefusal(file({ schemaVersion: 99 }), /schemaVersion/));

  it('refuses a non-integer generation', () =>
    expectRefusal(file({ generation: 1.5 }), /generation/));

  it('refuses reserved or rules that are not arrays', async () => {
    await expectRefusal(file({ reserved: {} }), /reserved is not an array/);
    await expectRefusal(file({ rules: {} }), /rules is not an array/);
  });

  it('refuses a reserved row without an id, and one reserved twice', async () => {
    await expectRefusal(
      file({ reserved: [{ label: 'x', quarantined: false, createdAtMs: 1, updatedAtMs: 1 }] }),
      /no string id/,
    );
    await expectRefusal(file({ reserved: [row('m1'), row('m1')] }), /reserved twice/);
  });

  it('refuses a reserved row no rule includes', () =>
    expectRefusal(file({ reserved: [row('m1'), row('m2')] }), /m2 is included by no rule/));

  it('refuses an include that is not a reserved row', () =>
    expectRefusal(file({ rules: [rule({ include: ['m1', 'ghost'] })] }), /includes ghost/));

  it('refuses an account both included and excluded by one rule', () =>
    expectRefusal(file({ rules: [rule({ exclude: ['m1'] })] }), /both includes and excludes m1/));

  it('refuses an id listed twice in include or exclude', async () => {
    await expectRefusal(file({ rules: [rule({ include: ['m1', 'm1'] })] }), /twice/);
    await expectRefusal(file({ rules: [rule({ exclude: ['s1', 's1'] })] }), /twice/);
  });

  it('refuses a non-string activeId and a duplicate rule id', async () => {
    await expectRefusal(file({ rules: [rule({ activeId: 7 })] }), /activeId/);
    await expectRefusal(file({ rules: [rule(), rule()] }), /rule id r1 appears twice/);
  });

  it('refuses the same folder in two rules, under any spelling', async () => {
    const two = (f1: string, f2: string) =>
      file({
        reserved: [row('m1'), row('m2')],
        rules: [rule({ folders: [f1] }), rule({ id: 'r2', include: ['m2'], folders: [f2] })],
      });
    await expectRefusal(two('C:\\shared', 'c:\\SHARED'), /more than one rule/);
    await expectRefusal(two('C:\\research', 'C:/research'), /more than one rule/);
    await expectRefusal(two('C:\\research', 'C:\\research\\'), /more than one rule/);
  });

  it('refuses a __proto__ key at the top level, inside a rule, or inside a reserved row', async () => {
    await expectRefusal(
      `{"schemaVersion":2,"generation":0,"reserved":[],"rules":[],"__proto__":{"polluted":true}}`,
      /forbidden key/,
    );
    await expectRefusal(
      `{"schemaVersion":2,"generation":0,"reserved":[${JSON.stringify(row('m1'))}],"rules":[{"id":"r1","label":"r","folders":[],"include":["m1"],"exclude":[],"activeId":null,"createdAtMs":1,"updatedAtMs":1,"__proto__":{"x":1}}]}`,
      /forbidden key/,
    );
    await expectRefusal(
      `{"schemaVersion":2,"generation":0,"reserved":[{"id":"m1","label":"m","quarantined":false,"createdAtMs":1,"updatedAtMs":1,"__proto__":{"x":1}}],"rules":[]}`,
      /forbidden key/,
    );
  });

  it('accepts an exclude or activeId naming no stored account: inert, not corrupt', async () => {
    // A build that does not know rules can remove a shared account a rule excludes; refusing the
    // whole file over that would brick every command.
    const { v } = await withRulesFile(
      file({ rules: [rule({ exclude: ['removed-elsewhere'], activeId: 'removed-elsewhere' })] }),
    );
    expect((await v.listRules())[0]?.exclude).toEqual(['removed-elsewhere']);
  });

  it('accepts a login repeated within reserved (the dedupe-able duplicate)', async () => {
    const { v } = await withRulesFile(
      file({
        reserved: [
          row('m1', { accountUuid: 'login-dup' }),
          row('m2', { accountUuid: 'login-dup' }),
        ],
        rules: [rule({ include: ['m1', 'm2'] })],
      }),
    );
    expect(await v.listRules()).toHaveLength(1);
  });

  it('refuses more than the cap of rules / included / excluded / folders / reserved', async () => {
    const many = <T>(n: number, make: (i: number) => T): T[] =>
      Array.from({ length: n }, (_, i) => make(i));
    await expectRefusal(
      file({
        reserved: many(MAX_RULES + 1, (i) => row(`m${i}`)),
        rules: many(MAX_RULES + 1, (i) => rule({ id: `r${i}`, include: [`m${i}`] })),
      }),
      new RegExp(`max ${MAX_RULES}`),
    );
    await expectRefusal(
      file({
        reserved: many(MAX_RULE_ACCOUNTS + 1, (i) => row(`m${i}`)),
        rules: [rule({ include: many(MAX_RULE_ACCOUNTS + 1, (i) => `m${i}`) })],
      }),
      new RegExp(`max ${MAX_RULE_ACCOUNTS}`),
    );
    await expectRefusal(
      file({ rules: [rule({ exclude: many(MAX_RULE_ACCOUNTS + 1, (i) => `s${i}`) })] }),
      new RegExp(`max ${MAX_RULE_ACCOUNTS}`),
    );
    await expectRefusal(
      file({ rules: [rule({ folders: many(MAX_RULE_FOLDERS + 1, (i) => `C:\\f${i}`) })] }),
      new RegExp(`max ${MAX_RULE_FOLDERS}`),
    );
    await expectRefusal(
      file({ reserved: many(MAX_RESERVED_ACCOUNTS + 1, (i) => row(`m${i}`)) }),
      new RegExp(`max ${MAX_RESERVED_ACCOUNTS}`),
    );
  });
});

describe('schema 1 (set-bound groups) is migrated on read', () => {
  async function withLegacyFile(content: unknown) {
    const ctx = await vaultAt();
    await mkdir(ctx.vaultDir, { recursive: true });
    await writeFile(ctx.rulesPath, JSON.stringify(content), 'utf8');
    return ctx;
  }
  const member = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    label: id,
    accountUuid: 'uuid-' + id,
    quarantined: false,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  });
  const group = (over: Record<string, unknown> = {}) => ({
    id: 'g1',
    label: 'Work',
    members: [member('m1'), member('m2')],
    activeId: 'm2',
    folders: ['C:\\work', 'C:\\client'],
    createdAtMs: 10,
    updatedAtMs: 20,
    ...over,
  });

  it('reads one group as one rule with the same id, folders, live account and include order', async () => {
    const { v, rulesPath } = await withLegacyFile({
      schemaVersion: 1,
      generation: 7,
      groups: [group()],
    });
    const before = await readFile(rulesPath, 'utf8');
    expect(await v.listRules()).toEqual([
      {
        id: 'g1',
        label: 'Work',
        folders: ['C:\\work', 'C:\\client'],
        include: ['m1', 'm2'],
        exclude: [],
        activeId: 'm2',
        createdAtMs: 10,
        updatedAtMs: 20,
      },
    ]);
    const all = await v.listAllAccounts();
    expect(all.filter((r) => r.ruleIds !== undefined).map((r) => r.id)).toEqual(['m1', 'm2']);
    expect(await v.getRulesGeneration()).toBe(7);
    // A read migrates in memory only: the file is untouched until the next write.
    expect(await readFile(rulesPath, 'utf8')).toBe(before);
  });

  it('is written back as schema 2 on the next write, continuing the generation', async () => {
    const { v, rulesPath } = await withLegacyFile({
      schemaVersion: 1,
      generation: 7,
      groups: [group()],
    });
    await v.setRuleActive('g1', 'm1');
    const file = await readJson(rulesPath);
    expect(file.schemaVersion).toBe(2);
    expect(file.generation).toBe(8);
    expect(file.groups).toBeUndefined();
    expect((file.reserved as { id: string }[]).map((r) => r.id)).toEqual(['m1', 'm2']);
    expect((file.rules as Record<string, unknown>[])[0]).toMatchObject({
      id: 'g1',
      include: ['m1', 'm2'],
      exclude: [],
      activeId: 'm1',
    });
    // And the rewritten file loads as schema 2 with the same picture.
    expect((await v.getRule('g1'))?.include).toEqual(['m1', 'm2']);
  });

  it('migrates several groups, and the migrated rules sit beside the shared pool', async () => {
    const { v, accountsPath } = await withLegacyFile({
      schemaVersion: 1,
      generation: 1,
      groups: [
        group({ members: [member('m1')], activeId: null, folders: ['C:\\one'] }),
        group({ id: 'g2', members: [member('m2')], activeId: null, folders: ['C:\\two'] }),
      ],
    });
    await writeFile(
      accountsPath,
      JSON.stringify({ schemaVersion: 2, activeId: null, accounts: [member('s1')] }),
      'utf8',
    );
    const picture = await v.readPicture();
    expect(picture.rules.map((r) => [r.id, r.include])).toEqual([
      ['g1', ['m1']],
      ['g2', ['m2']],
    ]);
    expect(picture.shared.map((r) => r.id)).toEqual(['s1']);
    expect(picture.reserved.map((r) => r.id)).toEqual(['m1', 'm2']);
  });

  it('still refuses an account in two groups (never valid in schema 1), leaving the file', async () => {
    const { v, rulesPath } = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      groups: [
        group({ members: [member('m1')], activeId: null, folders: ['C:\\one'] }),
        group({ id: 'g2', members: [member('m1')], activeId: null, folders: ['C:\\two'] }),
      ],
    });
    const before = await readFile(rulesPath, 'utf8');
    await expect(v.listRules()).rejects.toThrow(/appears in more than one group/);
    expect(await readFile(rulesPath, 'utf8')).toBe(before);
  });

  it('still refuses one login in two groups under different ids', async () => {
    const { v } = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      groups: [
        group({ members: [member('m1', { accountUuid: 'login-x' })], activeId: null, folders: [] }),
        group({
          id: 'g2',
          members: [member('m2', { accountUuid: 'login-x' })],
          activeId: null,
          folders: [],
        }),
      ],
    });
    await expect(v.listRules()).rejects.toThrow(/login login-x appears in more than one group/);
  });

  it('still refuses a schema-1 group with no members, a foreign activeId, or a folder bound twice', async () => {
    const empty = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      groups: [group({ members: [], activeId: null })],
    });
    await expect(empty.v.listRules()).rejects.toThrow(/no members/);
    const foreign = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      groups: [group({ activeId: 'ghost' })],
    });
    await expect(foreign.v.listRules()).rejects.toThrow(/activeId is not one of its members/);
    const twice = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      groups: [
        group({ members: [member('m1')], activeId: null, folders: ['C:\\one'] }),
        group({ id: 'g2', members: [member('m2')], activeId: null, folders: ['c:\\ONE'] }),
      ],
    });
    await expect(twice.v.listRules()).rejects.toThrow(/more than one rule/);
  });

  it('carries unknown fields of a schema-1 file across the migration', async () => {
    const { v, rulesPath } = await withLegacyFile({
      schemaVersion: 1,
      generation: 0,
      futureTopLevel: { keep: true },
      groups: [group({ futureScopes: ['branch'] })],
    });
    await v.setRuleActive('g1', null);
    const file = await readJson(rulesPath);
    expect(file.futureTopLevel).toEqual({ keep: true });
    expect((file.rules as Record<string, unknown>[])[0]!.futureScopes).toEqual(['branch']);
  });
});

describe('downgrade fence — an older cctl cannot see or drop reserved accounts', () => {
  it('reads a pre-feature accounts.json (no schemaVersion) as all-shared', async () => {
    const { v, accountsPath, vaultDir } = await vaultAt();
    await mkdir(vaultDir, { recursive: true });
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
    expect(await v.listRules()).toEqual([]);
  });

  it('a legacy rewrite of accounts.json cannot drop the rules in groups.json', async () => {
    const { v, accountsPath } = await vaultAt();
    const reserved = await v.addAccount('reserved', bundle('a'));
    const shared = await v.addAccount('shared', bundle('s'));
    const rule = await v.createRule({ folders: ['C:\\w'], include: [reserved.id] });

    // An older cctl knows only {activeId, accounts}: it rewrites accounts.json, never groups.json,
    // and cannot mention the reserved account it never saw.
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
    expect((await v.getRule(rule.id))?.include).toEqual([reserved.id]);
    expect((await v.listAllAccounts()).find((r) => r.id === reserved.id)?.ruleIds).toEqual([
      rule.id,
    ]);
    expect((await v.listAccounts()).map((r) => r.id)).toEqual([shared.id]);
    expect(await v.getActiveId()).toBe(shared.id);
  });

  it('an older `accounts add` of a reserved login (fresh id, same accountUuid) is healed out of the shared pool', async () => {
    const { v, accountsPath } = await vaultAt();
    const reserved = await v.addAccount('work', bundle('a'));
    await v.createRule({ folders: ['C:\\w'], include: [reserved.id] });
    // An older build cannot see the reserved row, so its `accounts add` of the same login writes a
    // fresh shared row under a new id carrying the same accountUuid.
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

    expect((await v.listAccounts()).map((r) => r.id)).toEqual([]);
    expect(await v.getActiveId()).toBeNull();
    expect(await v.getAccount('stray-dup')).toBeUndefined();
    expect((await v.listAllAccounts()).filter((r) => r.accountUuid === 'uuid-a')).toHaveLength(1);
    expect(await v.heal()).toBe(true);
    expect(((await readJson(accountsPath)).accounts as unknown[]).length).toBe(0);
    expect(await v.heal()).toBe(false);
  });
});

describe('rule labels are stored terminal-safe', () => {
  it('strips escape sequences, controls and bidi overrides from a given label', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const rule = await v.createRule({
      folders: ['C:\\work'],
      include: [a.id],
      label: 'x\u001b[2Jy\u202eevil\u0007',
    });
    expect(rule.label).toBe('x[2Jyevil');
    expect((await v.getRule(rule.id))?.label).toBe('x[2Jyevil');
  });

  it('falls back to the folder when nothing printable is left', async () => {
    const { v } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const rule = await v.createRule({
      folders: ['C:\\w'],
      include: [a.id],
      label: ' \u001b\u0007\u202e\n ',
    });
    expect(rule.label).toBe('C:\\w');
  });
});

describe('groups.json keeps fields this build does not know', () => {
  it('carries unknown top-level and rule-level fields through a rewrite', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const rule = await v.createRule({ folders: ['C:\\work'], include: [a.id] });
    const file = await readJson(rulesPath);
    file.futureTopLevel = { keep: true };
    (file.rules as Record<string, unknown>[])[0]!.futureScopes = [{ kind: 'branch' }];
    await writeFile(rulesPath, JSON.stringify(file), 'utf8');

    await v.setRuleActive(rule.id, a.id);

    const after = await readJson(rulesPath);
    expect(after.futureTopLevel).toEqual({ keep: true });
    const r = (after.rules as Record<string, unknown>[])[0]!;
    expect(r.futureScopes).toEqual([{ kind: 'branch' }]);
    expect(r.activeId).toBe(a.id);
    // This build's own fields win, and the unknown ones never leak into what it hands out.
    expect(Object.keys((await v.getRule(rule.id))!)).not.toContain('futureScopes');
  });

  it('drops the unknown fields of a rule that no longer exists', async () => {
    const { v, rulesPath } = await vaultAt();
    const a = await v.addAccount('work', bundle('a'));
    const b = await v.addAccount('client', bundle('b'));
    const r1 = await v.createRule({ folders: ['C:\\one'], include: [a.id] });
    await v.createRule({ folders: ['C:\\two'], include: [b.id] });
    const file = await readJson(rulesPath);
    for (const r of file.rules as Record<string, unknown>[]) r.futureScopes = [r.id];
    await writeFile(rulesPath, JSON.stringify(file), 'utf8');

    await v.removeRule(r1.id);

    const rules = (await readJson(rulesPath)).rules as Record<string, unknown>[];
    expect(rules).toHaveLength(1);
    expect(rules[0]!.futureScopes).toEqual([rules[0]!.id]);
  });
});
