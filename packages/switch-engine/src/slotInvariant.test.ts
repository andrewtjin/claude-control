// The slot invariant checker: checkSlots (read-only detection of §7 (a)-(e)) and repairSlots
// (fixes (a)-(d) under the lock). The scenarios are external `/login` accidents — a reserved account
// logged into the main config dir, a non-member logged into a group profile, one account live in two
// slots — plus a hostile registry that must never let repair widen access, and the unknown-login case
// that is alerted on but never adopted.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { groupSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

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
    platform: 'win32',
    bindFs,
    isProcessAlive: () => false,
  });
  return {
    root,
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector, clock, undefined, 'win32'),
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
function groupStore(paths: Paths, groupId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, groupId);
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
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    await h.engine.bindFolder(work, [A.id, B.id]);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — reserved account live in global (b) + freshest token wins', () => {
  it('evicts the reserved account onto a shared one and adopts its freshest token', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]); // A live in group

    // Simulate a /login of reserved A into the MAIN config dir, with a NEWER token than the vault's.
    await login(h.credStore, 'A', oauth('A', NOW + 20 * HOUR, 'rot-global-A'));

    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'reserved_live_in_global' && v.accountId === A.id)).toBe(
      true,
    );

    const res = await h.engine.repairSlots();

    // Global now holds a SHARED account (C or D), never a reserved member.
    const globalLive = await h.engine.getActiveId('global');
    expect(globalLive).not.toBe(A.id);
    expect(globalLive).not.toBe(B.id);
    // A is live in its own group slot, and its freshest token was adopted before the eviction.
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(A.id);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rot-global-A');
    expect(res.actions.some((a) => /rotated token for "A"/.test(a))).toBe(true);
    // The invariant is restored.
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — non-member live in a group profile (c)', () => {
  it('evicts the non-member and re-activates the rightful member', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]); // A live in group

    // Simulate a /login of shared C inside the GROUP profile.
    await login(groupStore(h.paths, bind.group.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'nonmember_live_in_group' && v.accountId === C.id)).toBe(
      true,
    );

    await h.engine.repairSlots();

    // A rightful member is live again; the non-member C is not the group's active member.
    const live = await h.engine.getActiveId(groupSlotId(bind.group.id));
    expect([A.id, B.id]).toContain(live);
    expect(live).not.toBe(C.id);
    expect((await h.vault.getGroup(bind.group.id))?.activeId).not.toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — one account live in two slots (a)', () => {
  it('keeps a shared account in global and evicts its copy from a group profile', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);
    await h.engine.activate(C.id); // C live in global

    // Copy C's live login into the group profile too (C now appears in two slots).
    await login(groupStore(h.paths, bind.group.id), 'C', oauth('C', NOW + 10 * HOUR));

    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'account_in_multiple_slots' && v.accountId === C.id)).toBe(
      true,
    );

    await h.engine.repairSlots();

    // C stays in global (its rightful slot); the group profile holds a member again.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect([A.id, B.id]).toContain(await h.engine.getActiveId(groupSlotId(bind.group.id)));
    const liveIds = [...(await h.engine.liveSlots()).values()].filter(
      (v): v is string => v !== null,
    );
    expect(new Set(liveIds).size).toBe(liveIds.length);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — group active id disagrees with the live login (d)', () => {
  it('heals the registry toward the member that is actually live', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]); // A live, activeId = A

    // A /login to member B inside the profile: B's token is now live while the registry still says A.
    await login(groupStore(h.paths, bind.group.id), 'B', oauth('B', NOW + 10 * HOUR, 'r-B'));

    const before = await h.engine.checkSlots();
    expect(before.some((v) => v.kind === 'group_active_mismatch' && v.accountId === B.id)).toBe(
      true,
    );

    await h.engine.repairSlots();

    expect((await h.vault.getGroup(bind.group.id))?.activeId).toBe(B.id);
    expect(await h.engine.getActiveId(groupSlotId(bind.group.id))).toBe(B.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — a hostile registry never widens access', () => {
  it('never leaves a reserved account in global and never makes a non-member a group active', async () => {
    const h = await harness();
    const { A, B, C } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);

    // Two accidents at once: reserved A live in global, and non-member C live in the profile.
    await login(h.credStore, 'A', oauth('A', NOW + 10 * HOUR));
    await login(groupStore(h.paths, bind.group.id), 'C', oauth('C', NOW + 10 * HOUR));

    await h.engine.repairSlots();

    // Reserved A is not live in global; the group's active member is a real member, never C.
    expect(await h.engine.getActiveId('global')).not.toBe(A.id);
    const groupActive = (await h.vault.getGroup(bind.group.id))?.activeId;
    expect([A.id, B.id]).toContain(groupActive);
    expect(groupActive).not.toBe(C.id);
    expect(await h.engine.checkSlots()).toEqual([]);
  });
});

describe('repairSlots — an unrecognized login is alerted on but never adopted', () => {
  it('reports the unknown login and re-activates the rightful member without storing it', async () => {
    const h = await harness();
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);

    // A login for an account cctl has never stored (foreign uuid) inside the profile.
    const store = groupStore(h.paths, bind.group.id);
    await store.writeLiveCredentials(oauth('Z', NOW + 10 * HOUR, 'r-Z'));
    await store.writeOauthAccount({ accountUuid: 'uuid-Z', emailAddress: 'Z@x.com' });

    const before = await h.engine.checkSlots();
    const unknown = before.find((v) => v.kind === 'nonmember_live_in_group');
    expect(unknown?.accountId).toBeUndefined();
    expect(unknown?.detail).toMatch(/unrecognized login/);

    const countBefore = (await h.vault.listAllAccounts()).length;
    const res = await h.engine.repairSlots();

    // The unknown login is never turned into a stored account; a rightful member is live again.
    expect((await h.vault.listAllAccounts()).length).toBe(countBefore);
    expect(res.actions.some((a) => /uuid-Z/.test(a))).toBe(false);
    expect([A.id, B.id]).toContain(await h.engine.getActiveId(groupSlotId(bind.group.id)));
  });
});

describe('checkSlots — broken profile links (e)', () => {
  it('detects a broken hard link and repairSlots heals it via the profile ensure', async () => {
    const h = await harness();
    // A shared root file in main so bind hard-links it into the profile.
    await writeFile(join(h.paths.claudeDir, 'settings.json'), '{"a":1}');
    const { A, B } = await seed(h);
    const work = await h.folder('work');
    const bind = await h.engine.bindFolder(work, [A.id, B.id]);

    // Break the profile's hard link: replace it with an independent file (new inode, same volume).
    const link = join(groupProfileDir(h.paths.vaultDir, bind.group.id), 'settings.json');
    await rm(link, { force: true });
    await writeFile(link, '{"a":2}');

    const before = await h.engine.checkSlots();
    expect(
      before.some((v) => v.kind === 'broken_profile_link' && v.groupId === bind.group.id),
    ).toBe(true);

    await h.engine.repairSlots();
    // ensureGroupProfile (invoked by repair) rebuilds the link, so the breach is gone.
    expect((await h.engine.checkSlots()).some((v) => v.kind === 'broken_profile_link')).toBe(false);
  });
});
