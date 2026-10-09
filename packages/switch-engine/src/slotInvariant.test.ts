// The slot invariant checker: checkSlots (read-only detection of §7 (a)-(e)) and repairSlots
// (fixes (a)-(d) under the lock). The scenarios are external `/login` accidents — a reserved account
// logged into the main config dir, an account outside a rule's pool (one it excludes, one reserved
// only to another rule) logged into its profile, one account live in two slots (the global slot and a
// rule slot, or two rule slots that include the same account) — plus a hostile registry that must
// never let repair widen access, and the unknown-login case that is alerted on but never adopted.
//
// The pool a rule slot may hold is its included accounts plus the shared accounts it does not
// exclude, so a shared account logged into a rule profile is NOT an intruder there: it is only a
// record that lags the live login, which the repair commits.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, profilesRoot, sandboxPaths, type Paths } from './paths.js';
import { ruleSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle, RulesFile, SlotId } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  credStore: CredentialStore;
  folder: (name: string) => Promise<string>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-inv-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const clock = (): number => NOW;
  const bindFs: BindFs = {
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    cwd: () => root,
    homedir: () => join(root, 'home'),
  };
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) => Promise.resolve(cur),
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    minSwitchIntervalMs: 60_000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    // Real sandbox dirs are canonicalized/containment-checked here, so path rules must match the
    // host filesystem (win32 on Windows, POSIX elsewhere). Win32-specific path semantics are
    // covered with a mock fs in folderPath.test.ts.
    platform: process.platform,
    bindFs,
    isProcessAlive: () => false,
  });
  return {
    root,
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector, clock, undefined, process.platform),
    credStore: new CredentialStore(paths),
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function oauth(access: string, expiresAt: number, refresh = 'r-' + access): ClaudeOauth {
  return { accessToken: access, refreshToken: refresh, expiresAt };
}
function bundleFor(access: string): CredentialBundle {
  return {
    claudeAiOauth: oauth(access, NOW + 10 * HOUR),
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}
function ruleStore(paths: Paths, ruleId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, ruleId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}
/** Write live credentials + matching identity block into a slot's config dir — a simulated `/login`. */
async function login(store: CredentialStore, access: string, o: ClaudeOauth): Promise<void> {
  await store.writeLiveCredentials(o);
  await store.writeOauthAccount({ accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' });
}
/** Every account id live in some slot, by the reconciled view the daemon reads. */
async function liveIds(engine: SwitchEngine): Promise<string[]> {
  return [...(await engine.liveSlots()).values()].filter((v): v is string => v !== null);
}
/** Rewrite one rule's recorded `activeId` straight into groups.json — a hand edit, or a file another
 *  program wrote — bypassing every check the vault's own writer makes. */
async function forgeRuleActive(paths: Paths, ruleId: string, activeId: string): Promise<void> {
  const file = join(paths.vaultDir, 'groups.json');
  const parsed = JSON.parse(await readFile(file, 'utf8')) as RulesFile;
  const rule = parsed.rules.find((r) => r.id === ruleId);
  if (rule === undefined) throw new Error(`no rule ${ruleId} to forge`);
  rule.activeId = activeId;
  await writeFile(file, JSON.stringify(parsed, null, 2));
}

async function seed(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A'));
  const B = await h.engine.addAccount('B', bundleFor('B'));
  const C = await h.engine.addAccount('C', bundleFor('C'));
  const D = await h.engine.addAccount('D', bundleFor('D'));
  return { A, B, C, D };
}

describe('checkSlots', () => {
  it('reports nothing for a healthy system', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(C.id);
    await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    // An exclude-only rule inherits a shared account that is live nowhere else.
    const excluded = await h.engine.excludeInFolder(await h.folder('client'), [C.id]);
    expect(excluded.live.liveAccount).toBe(D.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — reserved account live in global (b) + freshest token wins', () => {
  it('evicts the reserved account onto a shared one and adopts its freshest token', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in the rule slot

    // Simulate a /login of reserved A into the MAIN config dir, with a NEWER token than the vault's.
    await login(h.credStore, 'A', oauth('A', NOW + 20 * HOUR, 'rot-global-A'));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'reserved_live_in_global',
        accountId: A.id,
        slot: 'global',
        ruleId: included.rule.id,
      }),
    );

    const res = await h.engine.repairSlots();

    // Global now holds a SHARED account (C or D), never a reserved one.
    const globalLive = await h.engine.getActiveId('global');
    expect(globalLive).not.toBe(A.id);
    expect(globalLive).not.toBe(B.id);
    // A is live in its own rule slot, and its freshest token was adopted before the eviction.
    expect(await h.engine.getActiveId(ruleSlotId(included.rule.id))).toBe(A.id);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-global-A');
    expect(res.actions.some((a) => /rotated token for "A"/.test(a))).toBe(true);
    // The invariant is restored.
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('clears the global slot when no shared account is available to replace the reserved one', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    // Every shared account is out: C and D quarantined, so the global pool has nothing to seat.
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    await h.vault.quarantine(C.id, 'dead');
    await h.vault.quarantine(D.id, 'dead');
    await login(h.credStore, 'B', oauth('B', NOW + 10 * HOUR));

    const res = await h.engine.repairSlots();

    // A reserved account's rotating token is never left live in the global slot, even at the cost
    // of an empty global slot.
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
    expect(res.actions.some((a) => /cleared reserved "B" from the global slot/.test(a))).toBe(true);
    expect(await h.engine.getActiveId(ruleSlotId(included.rule.id))).toBe(A.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('leaves the rule slot that keeps the account holding its freshest token', async () => {
    // A copy of A's login in the global slot was refreshed there, which spent the token the rule
    // slot's copy holds. The repair adopts the rotation and evicts the global copy; the rule slot,
    // which keeps A, must then hold the rotated token rather than the spent one.
    const h = await harness();
    const { A, B } = await seed(h);
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    const store = ruleStore(h.paths, included.rule.id);
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-A');
    await login(h.credStore, 'A', oauth('A2', NOW + 20 * HOUR, 'r-A2'));

    await h.engine.repairSlots();

    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('r-A2');
    expect(await h.engine.getActiveId(ruleSlotId(included.rule.id))).toBe(A.id);
    expect((await store.readLiveCredentials())?.refreshToken).toBe('r-A2');
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — an account outside the rule pool live in its slot (c)', () => {
  it('evicts an account the rule excludes and re-seats one from its pool', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in the rule slot
    await h.engine.excludeInFolder(work, [C.id]);

    // Simulate a /login of excluded C inside the RULE profile.
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'outside_pool_live_in_rule',
        accountId: C.id,
        slot: ruleSlotId(included.rule.id),
        ruleId: included.rule.id,
        detail: expect.stringMatching(/"C", which that folder excludes/) as unknown,
      }),
    );

    await h.engine.repairSlots();

    // A rightful included account is live again; excluded C is not the rule's active account.
    const live = await h.engine.getActiveId(ruleSlotId(included.rule.id));
    expect([A.id, B.id]).toContain(live);
    expect((await h.vault.getRule(included.rule.id))?.activeId).not.toBe(C.id);
    expect(
      (await ruleStore(h.paths, included.rule.id).readLiveCredentials())?.refreshToken,
    ).not.toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('evicts an account reserved only to another rule and re-seats one from its pool', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    const work = await h.folder('work');
    const client = await h.folder('client');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in work's slot
    // D is reserved to the client folder only; that rule's slot is left empty, so D is live nowhere.
    const other = await h.vault.createRule({ folders: [client], include: [D.id] });

    await login(ruleStore(h.paths, included.rule.id), 'D', oauth('D', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'outside_pool_live_in_rule',
        accountId: D.id,
        ruleId: included.rule.id,
        detail: expect.stringMatching(/"D", which is reserved to other folders/) as unknown,
      }),
    );

    await h.engine.repairSlots();

    expect([A.id, B.id]).toContain(await h.engine.getActiveId(ruleSlotId(included.rule.id)));
    expect((await h.vault.getRule(included.rule.id))?.activeId).not.toBe(D.id);
    // The repair ensures every rule slot is live, so D may now be seated in its own folder's slot,
    // but in that one alone.
    expect([null, D.id]).toContain(await h.engine.getActiveId(ruleSlotId(other.id)));
    const ids = await liveIds(h.engine);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — an inherited shared account logged into a rule profile', () => {
  it('is in the pool, so it is reported only as a lagging record (d) and the repair commits it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    const slot = ruleSlotId(included.rule.id);

    // A /login of shared C inside the rule profile: the rule inherits C, so this is legal.
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before.map((v) => v.kind)).toEqual(['rule_active_mismatch']);
    expect(before[0]).toMatchObject({ accountId: C.id, slot, ruleId: included.rule.id });

    await h.engine.repairSlots();

    // The live login is kept (the repair never evicts a legitimate account) and recorded.
    expect(await h.engine.getActiveId(slot)).toBe(C.id);
    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — one account live in two slots (a)', () => {
  it('keeps a shared account in global and moves the rule slot off it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);
    await h.engine.activate(C.id); // C live in global

    // Copy C's live login into the rule profile too (C now appears in two slots).
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'account_in_multiple_slots',
        accountId: C.id,
        slots: ['global', ruleSlotId(included.rule.id)],
      }),
    );

    await h.engine.repairSlots();

    // C stays in global (the global slot keeps the shared account); the rule profile holds one of
    // its included accounts again.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect([A.id, B.id]).toContain(await h.engine.getActiveId(ruleSlotId(included.rule.id)));
    const ids = await liveIds(h.engine);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('keeps a shared account in global and clears the rule slot when its pool has nothing free', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(C.id); // C live in global
    // A and B are reserved to another folder; work excludes D; so work's pool is C alone.
    await h.engine.includeInFolder(await h.folder('client'), [A.id, B.id]);
    const work = await h.engine.excludeInFolder(await h.folder('work'), [D.id]);
    expect(work.live.noWorkingAccount).toBe(true);

    // C is /logged into work's profile as well.
    const store = ruleStore(h.paths, work.rule.id);
    await login(store, 'C', oauth('C', NOW + 10 * HOUR));
    expect(
      (await h.engine.checkSlots()).some(
        (v) => v.kind === 'account_in_multiple_slots' && v.accountId === C.id,
      ),
    ).toBe(true);

    const res = await h.engine.repairSlots();

    // The global slot keeps C; the folder's slot fails closed rather than share C's token.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect(await store.readLiveCredentials()).toBeUndefined();
    expect(res.actions.some((a) => /cleared a login that does not belong/.test(a))).toBe(true);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('two rule slots that include the same account: the later one in file order keeps it', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const S = await h.engine.addAccount('S', bundleFor('S'));
    await h.engine.activate(A.id); // A live in global
    const work = await h.engine.includeInFolder(await h.folder('work'), [S.id]);
    const client = await h.engine.includeInFolder(await h.folder('client'), [S.id]);
    const workSlot = ruleSlotId(work.rule.id);
    const clientSlot = ruleSlotId(client.rule.id);
    // S was seated in the first folder; the second inherited a shared account instead.
    expect(work.live.liveAccount).toBe(S.id);
    expect([B.id, C.id]).toContain(client.live.liveAccount);

    // S is /logged into the second folder's profile too: a shared include live in two slots.
    await login(ruleStore(h.paths, client.rule.id), 'S', oauth('S', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'account_in_multiple_slots',
        accountId: S.id,
        slots: [workSlot, clientSlot],
      }),
    );

    await h.engine.repairSlots();

    // S is live in exactly one of its including slots again, and the other runs on another account
    // of its own pool; nobody is live twice.
    expect(await h.engine.getActiveId(clientSlot)).toBe(S.id);
    const workLive = await h.engine.getActiveId(workSlot);
    expect(workLive).not.toBeNull();
    expect(workLive).not.toBe(S.id);
    expect(workLive).not.toBe(A.id);
    const ids = await liveIds(h.engine);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('the slot that keeps the account ends up holding its freshest token', async () => {
    // Two live copies of one login rotate independently, and the first refresh consumes the token
    // the other copy holds. When the copy the repair evicts is the newer one, its rotation reaches
    // the vault (step 1) — and the slot that keeps the account must then hold it too, or that slot
    // is left with a refresh token that is already spent.
    const h = await harness();
    const { A, B, C } = await seed(h);
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    await h.engine.activate(C.id); // C live in global with its stored token

    // A session in the folder refreshed a copy of C's login there: a newer token than global's.
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C2', NOW + 20 * HOUR, 'r-C2'));

    await h.engine.repairSlots();

    expect((await h.vault.readBundle(C.id)).claudeAiOauth.refreshToken).toBe('r-C2');
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect((await h.credStore.readLiveCredentials())?.refreshToken).toBe('r-C2');
    expect([A.id, B.id]).toContain(await h.engine.getActiveId(ruleSlotId(included.rule.id)));
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — rule active id disagrees with the live login (d)', () => {
  it('heals the registry toward the included account that is actually live', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]); // A live, activeId = A

    // A /login to included B inside the profile: B's token is live while the registry still says A.
    await login(ruleStore(h.paths, included.rule.id), 'B', oauth('B', NOW + 10 * HOUR, 'r-B'));

    const before = await h.engine.checkSlots();
    expect(before).toContainEqual(
      expect.objectContaining({
        kind: 'rule_active_mismatch',
        accountId: B.id,
        ruleId: included.rule.id,
        detail: expect.stringMatching(/records "A" live, but "B" is/) as unknown,
      }),
    );

    await h.engine.repairSlots();

    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(B.id);
    expect(await h.engine.getActiveId(ruleSlotId(included.rule.id))).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('reports a rule that records an account while its profile holds none as nothing to fix', async () => {
    // An empty seat whose record lags is not a breach: nothing can be spent there, and the next
    // self-heal re-seats it.
    const h = await harness();
    const { A, B } = await seed(h);
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id, B.id]);
    await rm(join(groupProfileDir(h.paths.vaultDir, included.rule.id), '.credentials.json'));

    expect(await h.engine.checkSlots()).toEqual([]);
    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(A.id);
  });
});

describe('repairSlots — a hostile registry never widens access', () => {
  it('never leaves a reserved account in global and never seats an excluded account it records', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);
    await h.engine.excludeInFolder(work, [C.id]);

    // Three accidents at once: reserved A live in global, excluded C live in the profile, and the
    // rule's own record forged to name C.
    await login(h.credStore, 'A', oauth('A', NOW + 10 * HOUR));
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C', NOW + 10 * HOUR));
    await forgeRuleActive(h.paths, included.rule.id, C.id);

    await h.engine.repairSlots();

    // Reserved A is not live in global; the rule's active account is an included one, never C.
    expect(await h.engine.getActiveId('global')).not.toBe(A.id);
    const ruleActive = (await h.vault.getRule(included.rule.id))?.activeId;
    expect([A.id, B.id]).toContain(ruleActive);
    expect(ruleActive).not.toBe(C.id);
    expect(
      (await ruleStore(h.paths, included.rule.id).readLiveCredentials())?.refreshToken,
    ).not.toBe('r-C');
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('the self-heal never seats a recorded account reserved only to another rule', async () => {
    const h = await harness();
    const { A, B, D } = await seed(h);
    const work = await h.folder('work');
    const client = await h.folder('client');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);
    const other = await h.vault.createRule({ folders: [client], include: [D.id] });
    // Work's seat is emptied, and its record forged to name D, which only the client folder may use.
    await rm(join(groupProfileDir(h.paths.vaultDir, included.rule.id), '.credentials.json'));
    await forgeRuleActive(h.paths, included.rule.id, D.id);

    const res = await h.engine.ensureRuleLive(included.rule.id);

    expect([A.id, B.id]).toContain(res.liveAccount);
    expect((await h.vault.getRule(included.rule.id))?.activeId).toBe(res.liveAccount);
    expect(await h.engine.getActiveId(ruleSlotId(other.id))).toBeNull();
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — an unrecognized login is alerted on but never adopted', () => {
  it('reports the unknown login and re-activates the rightful included account without storing it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);

    // A login for an account cctl has never stored (foreign uuid) inside the profile.
    const store = ruleStore(h.paths, included.rule.id);
    await store.writeLiveCredentials(oauth('Z', NOW + 10 * HOUR, 'r-Z'));
    await store.writeOauthAccount({ accountUuid: 'uuid-Z', emailAddress: 'Z@x.com' });

    const before = await h.engine.checkSlots();
    const unknown = before.find((v) => v.kind === 'outside_pool_live_in_rule');
    expect(unknown?.accountId).toBeUndefined();
    expect(unknown?.ruleId).toBe(included.rule.id);
    expect(unknown?.detail).toMatch(/unrecognized login/);

    const countBefore = (await h.vault.listAllAccounts()).length;
    const res = await h.engine.repairSlots();

    // The unknown login is never turned into a stored account; a rightful account is live again.
    expect((await h.vault.listAllAccounts()).length).toBe(countBefore);
    expect(res.actions.some((a) => /uuid-Z/.test(a))).toBe(false);
    expect([A.id, B.id]).toContain(await h.engine.getActiveId(ruleSlotId(included.rule.id)));
  });
});

describe('repairSlots — a rule with nothing seatable fails the slot closed', () => {
  it('evicts an excluded squatter when every account of the pool is out (c, fail closed)', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    await h.engine.activate(D.id); // D live in global, so the rule cannot inherit it
    const included = await h.engine.includeInFolder(work, [A.id, B.id]); // A live in the rule slot
    await h.engine.excludeInFolder(work, [C.id]);

    // Both included accounts lose their tokens (invalid_grant -> quarantined), so none can be seated.
    await h.vault.quarantine(A.id, 'dead');
    await h.vault.quarantine(B.id, 'dead');

    // Accident: excluded C is /logged into the rule profile.
    await login(ruleStore(h.paths, included.rule.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'outside_pool_live_in_rule' && v.accountId === C.id)).toBe(
      true,
    );

    const res = await h.engine.repairSlots();

    // The squatter is physically gone: an empty profile is "not logged in", never C's live token.
    const store = ruleStore(h.paths, included.rule.id);
    expect(await store.readLiveCredentials().catch(() => undefined)).toBeUndefined();
    expect(await store.readOauthAccount().catch(() => undefined)).toBeUndefined();
    // The eviction is reported (it does not seat an account, so it must be surfaced explicitly).
    expect(res.actions.some((a) => /cleared a login that does not belong/.test(a))).toBe(true);
    // The global slot kept its shared account; the invariant is restored.
    expect(await h.engine.getActiveId('global')).toBe(D.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('evicts an unrecognized login when every account of the pool is out (c′, fail closed)', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);
    await h.engine.excludeInFolder(work, [C.id, D.id]);
    await h.vault.quarantine(A.id, 'dead');
    await h.vault.quarantine(B.id, 'dead');

    // A login for an account cctl has never stored (foreign uuid) inside the profile.
    const store = ruleStore(h.paths, included.rule.id);
    await store.writeLiveCredentials(oauth('Z', NOW + 10 * HOUR, 'r-Z'));
    await store.writeOauthAccount({ accountUuid: 'uuid-Z', emailAddress: 'Z@x.com' });

    const countBefore = (await h.vault.listAllAccounts()).length;
    await h.engine.repairSlots();

    // The unknown login is cleared (fail closed), never turned into a stored account.
    expect((await h.vault.listAllAccounts()).length).toBe(countBefore);
    expect(await store.readLiveCredentials().catch(() => undefined)).toBeUndefined();
    expect(await h.engine.checkSlots()).toEqual([]);
  });

  it('does not let a reserved account squat in a second rule with nothing seatable (a, fail closed)', async () => {
    const h = await harness();
    const W1 = await h.engine.addAccount('W1', bundleFor('W1'));
    const W2 = await h.engine.addAccount('W2', bundleFor('W2'));
    const S = await h.engine.addAccount('S', bundleFor('S'));
    await h.engine.activate(S.id); // global = shared S, so no rule can inherit it

    const f1 = await h.folder('research1');
    const f2 = await h.folder('research2');
    const r1 = await h.engine.includeInFolder(f1, [W1.id]); // W1 live in r1's slot
    const r2 = await h.engine.includeInFolder(f2, [W2.id]); // W2 live in r2's slot

    await h.vault.quarantine(W2.id, 'invalid_grant'); // r2 has nothing seatable

    // Accident: W1, reserved to r1 only, is /logged into r2's profile — W1 is now in two slots.
    await login(ruleStore(h.paths, r2.rule.id), 'W1', oauth('W1', NOW + 15 * HOUR, 'rot-W1-r2'));

    const before = await h.engine.checkSlots();
    expect(
      before.some((v) => v.kind === 'account_in_multiple_slots' && v.accountId === W1.id),
    ).toBe(true);
    expect(
      before.some(
        (v) =>
          v.kind === 'outside_pool_live_in_rule' &&
          v.accountId === W1.id &&
          v.ruleId === r2.rule.id,
      ),
    ).toBe(true);

    await h.engine.repairSlots();

    // W1 is live in exactly ONE slot again (its own r1, which it never had to leave); r2 is failed
    // closed. Read physically: a cleared profile with a lagging record must not pass for a seat.
    const r1store = ruleStore(h.paths, r1.rule.id);
    expect(await r1store.readLiveCredentials().catch(() => undefined)).toBeDefined();
    expect((await r1store.readOauthAccount().catch(() => undefined))?.accountUuid).toBe('uuid-W1');
    expect(await h.engine.getActiveId(ruleSlotId(r1.rule.id))).toBe(W1.id);
    const r2store = ruleStore(h.paths, r2.rule.id);
    expect(await r2store.readLiveCredentials().catch(() => undefined)).toBeUndefined();
    const ids = await liveIds(h.engine);
    expect(new Set(ids).size).toBe(ids.length);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('checkSlots — broken profile links (e)', () => {
  it('detects a broken hard link and repairSlots heals it via the profile ensure', async () => {
    const h = await harness();
    // A shared root file in main so the include hard-links it into the profile.
    await writeFile(join(h.paths.claudeDir, 'settings.json'), '{"a":1}');
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const included = await h.engine.includeInFolder(work, [A.id, B.id]);

    // Break the profile's hard link: replace it with an independent file (new inode, same volume).
    const link = join(groupProfileDir(h.paths.vaultDir, included.rule.id), 'settings.json');
    await rm(link, { force: true });
    await writeFile(link, '{"a":2}');

    const before = await h.engine.checkSlots();
    expect(
      before.some((v) => v.kind === 'broken_profile_link' && v.ruleId === included.rule.id),
    ).toBe(true);

    await h.engine.repairSlots();
    // ensureGroupProfile (invoked by repair) rebuilds the link, so the breach is gone.
    expect((await h.engine.checkSlots()).some((v) => v.kind === 'broken_profile_link')).toBe(false);
  });

  it('checks the profile of an exclude-only rule too', async () => {
    const h = await harness();
    await writeFile(join(h.paths.claudeDir, 'settings.json'), '{"a":1}');
    const { C } = await seed(h);
    const excluded = await h.engine.excludeInFolder(await h.folder('work'), [C.id]);

    const link = join(groupProfileDir(h.paths.vaultDir, excluded.rule.id), 'settings.json');
    await rm(link, { force: true });
    await writeFile(link, '{"a":2}');

    expect(await h.engine.checkSlots()).toContainEqual(
      expect.objectContaining({ kind: 'broken_profile_link', ruleId: excluded.rule.id }),
    );
  });
});

describe('checkSlots — a profile no rule owns, beside live rule profiles', () => {
  it('reports and clears only the orphan, never a rule-owned profile', async () => {
    const h = await harness();
    const { A, B, C, D } = await seed(h);
    await h.engine.activate(C.id);
    const included = await h.engine.includeInFolder(await h.folder('work'), [A.id]);
    const excluded = await h.engine.excludeInFolder(await h.folder('client'), [C.id]);
    expect(excluded.live.liveAccount).toBe(B.id);
    // A dissolved rule's profile an older build left logged in as D, which no slot holds.
    const orphanDir = join(profilesRoot(h.paths.vaultDir), '0b1c2d3e-0000-4000-8000-000000000000');
    await mkdir(orphanDir, { recursive: true });
    const orphan = new CredentialStore({
      claudeDir: orphanDir,
      credentialsPath: join(orphanDir, '.credentials.json'),
      claudeJsonPath: join(orphanDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await login(orphan, 'D', oauth('D', NOW + 10 * HOUR));

    const found = await h.engine.checkSlots();
    expect(found).toEqual([
      expect.objectContaining({ kind: 'orphan_profile_login', accountId: D.id }),
    ]);

    const res = await h.engine.repairSlots();

    expect(res.remaining).toEqual([]);
    expect(await orphan.readLiveCredentials()).toBeUndefined();
    // Both rule-owned profiles kept their logins.
    const slots: Array<[SlotId, string]> = [
      [ruleSlotId(included.rule.id), A.id],
      [ruleSlotId(excluded.rule.id), B.id],
    ];
    for (const [slot, id] of slots) expect(await h.engine.getActiveId(slot)).toBe(id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});
