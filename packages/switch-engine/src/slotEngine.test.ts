// Slot-aware switch engine: the folder-bound group slots layered on top of the global slot.
//
// These cover the behaviour that only exists once an account can be reserved to a group: routing an
// activation by membership, per-slot cadence/intent/rollback, reconciling each slot against its own
// profile identity, and the refusals that keep an account live in at most one slot. The global-slot
// behaviour itself is exercised in switchEngine.test.ts and is only touched here where a group and
// the global slot must be shown not to interfere.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { IntentStore } from './intent.js';
import { sandboxPaths, groupProfileDir, type Paths } from './paths.js';
import { groupSlotId } from './types.js';
import { CadenceError } from './errors.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';
import type { Protector } from './dpapi.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

interface Harness {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  protector: Protector;
  /** The GLOBAL slot's live credential store, for asserting global stays untouched. */
  credStore: CredentialStore;
  setNow: (n: number) => void;
  clock: () => number;
}

/** A default refresh that rotates the token an hour out — matches switchEngine.test.ts's shape so a
 *  near-expiry account can be refreshed deterministically. */
function makeRefresh(clock: () => number) {
  return (cur: ClaudeOauth): Promise<ClaudeOauth> =>
    Promise.resolve({
      ...cur,
      accessToken: 'refreshed-' + cur.accessToken,
      refreshToken: 'rotated-' + cur.refreshToken,
      expiresAt: clock() + HOUR,
    });
}

async function harness(platform: NodeJS.Platform = 'win32'): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-slot-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });

  let now = NOW;
  const clock = (): number => now;
  const protector = new InsecurePassthroughProtector();
  const engine = new SwitchEngine({
    paths,
    protector,
    // Always a file channel so the darwin refusal test never reaches the real Keychain.
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: makeRefresh(clock),
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    minSwitchIntervalMs: 60_000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    platform,
  });
  const vault = new Vault(paths.vaultDir, protector, clock, undefined, platform);
  return {
    root,
    paths,
    engine,
    vault,
    protector,
    credStore: new CredentialStore(paths),
    setNow: (n) => (now = n),
    clock,
  };
}

afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function oauth(access: string, expiresAt: number, refresh = 'r-' + access): ClaudeOauth {
  return { accessToken: access, refreshToken: refresh, expiresAt };
}
function bundleFor(access: string, expiresAt: number): CredentialBundle {
  return {
    claudeAiOauth: oauth(access, expiresAt),
    oauthAccount: { accountUuid: 'uuid-' + access, emailAddress: access + '@x.com' },
  };
}

/** A credential store over one group's profile dir — how a test inspects a group slot's live files. */
function groupStore(paths: Paths, groupId: string): CredentialStore {
  const profileDir = groupProfileDir(paths.vaultDir, groupId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** Seed four shared accounts A/B/C/D, then reserve A+B into a group bound to one folder. C and D
 *  stay in the global pool. Every account is far from expiry so no activation triggers a refresh. */
async function setupGroup(h: Harness) {
  const A = await h.engine.addAccount('A', bundleFor('A', NOW + 10 * HOUR));
  const B = await h.engine.addAccount('B', bundleFor('B', NOW + 10 * HOUR));
  const C = await h.engine.addAccount('C', bundleFor('C', NOW + 10 * HOUR));
  const D = await h.engine.addAccount('D', bundleFor('D', NOW + 10 * HOUR));
  const group = await h.vault.createGroup({ memberIds: [A.id, B.id], folders: ['C:\\work'] });
  return { A, B, C, D, group, slotId: groupSlotId(group.id) };
}

describe('activate — routing by membership', () => {
  it('routes a reserved account to its group slot, leaving the global slot untouched', async () => {
    const h = await harness();
    const { A, group, slotId } = await setupGroup(h);

    const res = await h.engine.activate(A.id);

    expect(res.activeAccountId).toBe(A.id);
    // The group profile now holds A's live credentials; the global slot holds nothing.
    expect((await groupStore(h.paths, group.id).readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.credStore.readLiveCredentials()).toBeUndefined();
    expect((await h.vault.getGroup(group.id))?.activeId).toBe(A.id);
    expect(await h.engine.getActiveId(slotId)).toBe(A.id);
    expect(await h.engine.getActiveId('global')).toBeNull();
    // The global registry active id is never a reserved account.
    expect(await h.vault.getActiveId()).toBeNull();
  });

  it('routes a shared account to the global slot, never a group', async () => {
    const h = await harness();
    const { C, slotId } = await setupGroup(h);

    await h.engine.activate(C.id);

    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect(await h.engine.getActiveId(slotId)).toBeNull();
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });

  it('refuses an explicit global slot for a reserved account', async () => {
    const h = await harness();
    const { A } = await setupGroup(h);
    await expect(h.engine.activate(A.id, { slot: 'global' })).rejects.toMatchObject({
      code: 'slot_mismatch',
    });
  });

  it('refuses an explicit group slot for a shared (non-member) account', async () => {
    const h = await harness();
    const { C, slotId } = await setupGroup(h);
    await expect(h.engine.activate(C.id, { slot: slotId })).rejects.toMatchObject({
      code: 'slot_mismatch',
    });
  });

  it('refuses a group activation on macOS', async () => {
    const h = await harness('darwin');
    const { A, slotId } = await setupGroup(h);
    await expect(h.engine.activate(A.id)).rejects.toMatchObject({ code: 'group_slot_unsupported' });
    // Nothing was written to the profile — the refusal is before any live write.
    expect(await h.engine.getActiveId(slotId)).toBeNull();
  });
});

describe('the at-most-one-slot invariant', () => {
  it('keeps a global account and a group account in disjoint slots', async () => {
    const h = await harness();
    const { A, C, slotId } = await setupGroup(h);

    await h.engine.activate(C.id); // global
    await h.engine.activate(A.id); // group (same clock; different slot)

    const live = await h.engine.liveSlots();
    expect(live.get('global')).toBe(C.id);
    expect(live.get(slotId)).toBe(A.id);
    // No account is live in two slots.
    const liveIds = [...live.values()].filter((v): v is string => v !== null);
    expect(new Set(liveIds).size).toBe(liveIds.length);
  });

  it('a group switch moves the live member within the group and never the global slot', async () => {
    const h = await harness();
    const { A, B, C, group, slotId } = await setupGroup(h);

    await h.engine.activate(C.id);
    await h.engine.activate(A.id);
    h.setNow(NOW + 2 * 60_000); // clear both cadence windows
    await h.engine.activate(B.id);

    expect(await h.engine.getActiveId(slotId)).toBe(B.id);
    expect((await groupStore(h.paths, group.id).readLiveCredentials())?.accessToken).toBe('B');
    // The global slot is exactly where it was.
    expect(await h.engine.getActiveId('global')).toBe(C.id);
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });
});

describe('per-slot cadence independence', () => {
  it('a group hop and a global hop at the same instant both succeed, then each blocks its own next', async () => {
    const h = await harness();
    const { A, B, C, D } = await setupGroup(h);

    // Both slots hop at NOW. The group hop is NOT blocked by the global slot's just-set clock.
    await h.engine.activate(C.id); // global hop -> global clock = NOW
    await h.engine.activate(A.id); // group hop  -> group clock  = NOW (independent)

    // A second hop in either slot at the same instant is refused by THAT slot's clock.
    await expect(h.engine.activate(D.id)).rejects.toBeInstanceOf(CadenceError); // global
    await expect(h.engine.activate(B.id)).rejects.toBeInstanceOf(CadenceError); // group
  });
});

describe('getActiveId reconciliation is per slot', () => {
  it('follows a login inside the group profile to the member that owns it', async () => {
    const h = await harness();
    const { A, B, group, slotId } = await setupGroup(h);
    await h.engine.activate(A.id);

    // Simulate a `/login` to B performed inside the group profile: the profile's live token is now
    // B's (matching B's stored refresh token) while the group registry still records A.
    const gStore = groupStore(h.paths, group.id);
    await gStore.writeLiveCredentials(oauth('B', NOW + 10 * HOUR, 'r-B'));
    await gStore.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });

    expect(await h.engine.getActiveId(slotId)).toBe(B.id);
    expect((await h.vault.getGroup(group.id))?.activeId).toBe(A.id);
  });
});

describe('crash recovery per slot', () => {
  it('rolls a group slot forward from a written-phase intent', async () => {
    const h = await harness();
    const { A, group } = await setupGroup(h);
    const stateDir = join(h.paths.vaultDir, 'slots', group.id);
    const gStore = groupStore(h.paths, group.id);

    // The target's credentials are already live in the profile, but the switch never committed.
    const bundle = await h.vault.readBundle(A.id);
    await gStore.writeLiveCredentials(bundle.claudeAiOauth);
    await new IntentStore(stateDir).write({
      phase: 'written',
      targetId: A.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('rolled_forward');
    expect((await h.vault.getGroup(group.id))?.activeId).toBe(A.id);
    expect(await new IntentStore(stateDir).read()).toBeUndefined();
  });

  it('clears a group slot begin-phase intent without committing', async () => {
    const h = await harness();
    const { A, group } = await setupGroup(h);
    const stateDir = join(h.paths.vaultDir, 'slots', group.id);
    await new IntentStore(stateDir).write({
      phase: 'begin',
      targetId: A.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('cleared');
    expect((await h.vault.getGroup(group.id))?.activeId).toBeNull();
    expect(await new IntentStore(stateDir).read()).toBeUndefined();
  });

  it('recovers a legacy root intent as the global slot', async () => {
    const h = await harness();
    const { C, D } = await setupGroup(h);
    await h.engine.activate(C.id); // global live = C

    // A pre-upgrade intent lives at the vault-dir root (no slots/ path) and describes the global slot.
    const dBundle = await h.vault.readBundle(D.id);
    await h.credStore.writeLiveCredentials(dBundle.claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'written',
      targetId: D.id,
      prevActiveId: C.id,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const res = await h.engine.recover();

    expect(res.action).toBe('rolled_forward');
    expect(await h.vault.getActiveId()).toBe(D.id);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
  });
});

describe('rotation adoption per slot', () => {
  it('adopts a later CLI rotation from the group profile into the previous member', async () => {
    const h = await harness();
    const { A, B, group } = await setupGroup(h);
    await h.engine.activate(A.id);

    // The CLI rotated A's token inside the profile: a different refresh token, later expiry.
    const gStore = groupStore(h.paths, group.id);
    await gStore.writeLiveCredentials(oauth('A', NOW + 20 * HOUR, 'rotated-r-A'));
    await gStore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    h.setNow(NOW + 2 * 60_000);
    const res = await h.engine.activate(B.id);

    expect(res.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('rotated-r-A');
  });

  it('does not adopt a live token that is not newer (direction guard)', async () => {
    const h = await harness();
    const { A, B, group } = await setupGroup(h);
    await h.engine.activate(A.id);

    // A live token that expires no later than the stored one cannot be a later rotation.
    const gStore = groupStore(h.paths, group.id);
    await gStore.writeLiveCredentials(oauth('A', NOW + 5 * HOUR, 'stale-r-A'));
    await gStore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    h.setNow(NOW + 2 * 60_000);
    const res = await h.engine.activate(B.id, { force: true });

    expect(res.adoptedPreviousRotation).toBe(false);
    expect((await h.vault.readBundle(A.id)).claudeAiOauth.refreshToken).toBe('r-A');
  });
});

describe('refreshToken and slots', () => {
  it('refuses a network refresh for an account live in its group slot (adopt-only)', async () => {
    const h = await harness();
    const { A } = await setupGroup(h);
    await h.engine.activate(A.id);

    const r = await h.engine.refreshToken(A.id);

    expect(r.refreshed).toBe(false);
    expect(r.skippedReason).toBe('active_account');
  });

  it('network-refreshes a NON-live group member whose token is near expiry', async () => {
    const h = await harness();
    const { A, group } = await setupGroup(h);
    await h.engine.activate(A.id); // A is live; a different member is what we refresh

    // Reserve a fresh near-expiry member E into the same group.
    const E = await h.engine.addAccount('E', bundleFor('E', NOW + 60_000));
    await h.vault.reserveAccounts(group.id, [E.id]);

    const r = await h.engine.refreshToken(E.id);

    expect(r.refreshed).toBe(true);
    expect((await h.vault.readBundle(E.id)).claudeAiOauth.refreshToken).toBe('rotated-r-E');
  });
});

describe('relogin heals the slot where the account is live', () => {
  it('a group-live member re-login heals the profile, not the global files', async () => {
    const h = await harness();
    const { A, C, group } = await setupGroup(h);
    await h.engine.activate(C.id); // global live = C
    await h.engine.activate(A.id); // group live = A

    const tdir = join(h.root, 'relogin-A');
    await mkdir(tdir, { recursive: true });
    const tstore = new CredentialStore({
      claudeDir: tdir,
      credentialsPath: join(tdir, '.credentials.json'),
      claudeJsonPath: join(tdir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await tstore.writeLiveCredentials(oauth('A-fresh', NOW + 30 * HOUR, 'r-A-fresh'));
    await tstore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    const res = await h.engine.reloginFromConfigDir(A.id, tdir);

    expect(res.healedLiveLogin).toBe(true);
    // The group profile now holds the fresh grant; the global slot is untouched.
    expect((await groupStore(h.paths, group.id).readLiveCredentials())?.accessToken).toBe(
      'A-fresh',
    );
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
  });
});

describe('capture refuses inside a profile', () => {
  it('captureFromConfigDir refuses a config dir inside the profiles root', async () => {
    // This refusal compares REAL sandbox paths (the profile dir vs the profiles root), so the
    // engine's path rules must match the host filesystem rather than the harness's win32 default.
    const h = await harness(process.platform);
    const { group } = await setupGroup(h);
    const profileDir = groupProfileDir(h.paths.vaultDir, group.id);
    await mkdir(profileDir, { recursive: true });
    await expect(h.engine.captureFromConfigDir('x', profileDir)).rejects.toMatchObject({
      code: 'capture_in_profile',
    });
  });

  it('captureCurrentLogin refuses when the engine config dir is inside the profiles root', async () => {
    const h = await harness();
    // An engine whose CLAUDE_CONFIG_DIR points at a group profile — the onboarding-in-a-profile mistake.
    const profileDir = groupProfileDir(h.paths.vaultDir, 'some-group-id');
    const insidePaths: Paths = {
      claudeDir: profileDir,
      credentialsPath: join(profileDir, '.credentials.json'),
      claudeJsonPath: join(profileDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    };
    const inside = new SwitchEngine({
      paths: insidePaths,
      protector: h.protector,
      liveCredentialChannel: new FileCredentialChannel(insidePaths.credentialsPath),
      clock: h.clock,
      // Real sandbox paths (profile dir inside the profiles root): host path rules, not win32.
      platform: process.platform,
    });
    await expect(inside.captureCurrentLogin('x')).rejects.toMatchObject({
      code: 'capture_in_profile',
    });
  });
});

describe('removeAccount / quarantine of a member', () => {
  it('clears the group slot when the removed member was live in it', async () => {
    const h = await harness();
    const { A, B, group, slotId } = await setupGroup(h);
    await h.engine.activate(A.id);

    await h.engine.removeAccount(A.id);

    // The profile's live credentials are gone (the slot fails closed), the group keeps B, and its
    // active id is cleared.
    expect(await groupStore(h.paths, group.id).readLiveCredentials()).toBeUndefined();
    const g = await h.vault.getGroup(group.id);
    expect(g?.members.map((m) => m.id)).toEqual([B.id]);
    expect(g?.activeId).toBeNull();
    expect(await h.engine.getActiveId(slotId)).toBeNull();
  });

  it('quarantine and clear-quarantine work on a reserved member', async () => {
    const h = await harness();
    const { B } = await setupGroup(h);

    await h.vault.quarantine(B.id, 'dead token');
    expect((await h.vault.getAccount(B.id))?.quarantined).toBe(true);
    // A quarantined member cannot be activated.
    await expect(h.engine.activate(B.id)).rejects.toMatchObject({ code: 'invalid_grant' });

    await h.engine.clearQuarantine(B.id);
    expect((await h.vault.getAccount(B.id))?.quarantined).toBe(false);
  });
});

describe('liveSlots', () => {
  it('reports the reconciled live account of the global slot and every group', async () => {
    const h = await harness();
    const { A, C, slotId } = await setupGroup(h);
    await h.engine.activate(C.id);
    await h.engine.activate(A.id);

    const live = await h.engine.liveSlots();
    expect([...live.keys()].sort()).toEqual(['global', slotId].sort());
    expect(live.get('global')).toBe(C.id);
    expect(live.get(slotId)).toBe(A.id);
  });
});

describe('liveSlotToken', () => {
  it('reads the live token from a group member is live in, not the vault bundle', async () => {
    const h = await harness();
    const { A, group, slotId } = await setupGroup(h);
    await h.engine.activate(A.id); // A live in its group slot

    const tok = await h.engine.liveSlotToken(A.id);
    expect(tok?.slot).toBe(slotId);
    expect(tok?.accessToken).toBe('A');
    expect(tok?.accountUuid).toBe('uuid-A');
    // Even after the group profile's live token rotates (a running session refreshes it), the
    // getter reads the fresh slot copy, never the stale vault bundle.
    await groupStore(h.paths, group.id).writeLiveCredentials(oauth('A2', NOW + 9 * HOUR));
    expect((await h.engine.liveSlotToken(A.id))?.accessToken).toBe('A2');
  });

  it('reads the global slot token for a globally live account', async () => {
    const h = await harness();
    const { C } = await setupGroup(h);
    await h.engine.activate(C.id);
    const tok = await h.engine.liveSlotToken(C.id);
    expect(tok?.slot).toBe('global');
    expect(tok?.accessToken).toBe('C');
  });

  it('returns undefined for an account not live in any slot', async () => {
    const h = await harness();
    const { A, B } = await setupGroup(h);
    await h.engine.activate(A.id);
    // B is a member but not the live one.
    expect(await h.engine.liveSlotToken(B.id)).toBeUndefined();
  });
});

describe('spawn/session slot resolution helpers', () => {
  it('configDirForAccount returns the profile dir for a reserved member, undefined for shared', async () => {
    const h = await harness();
    const { A, C, group } = await setupGroup(h);
    expect(await h.engine.configDirForAccount(A.id)).toBe(
      groupProfileDir(h.paths.vaultDir, group.id),
    );
    expect(await h.engine.configDirForAccount(C.id)).toBeUndefined();
  });

  it('slotForConfigDir maps a profile dir to its group slot and everything else to global', async () => {
    const h = await harness();
    const { group, slotId } = await setupGroup(h);
    const profileDir = groupProfileDir(h.paths.vaultDir, group.id);
    expect(await h.engine.slotForConfigDir(profileDir)).toBe(slotId);
    // Absent / main / unrecognized dirs are global.
    expect(await h.engine.slotForConfigDir(null)).toBe('global');
    expect(await h.engine.slotForConfigDir(undefined)).toBe('global');
    expect(await h.engine.slotForConfigDir(h.paths.claudeDir)).toBe('global');
    expect(await h.engine.slotForConfigDir('C:\\nowhere')).toBe('global');
    // A trailing separator and a different drive-letter case still match on win32.
    expect(await h.engine.slotForConfigDir(profileDir + '\\')).toBe(slotId);
    expect(await h.engine.slotForConfigDir(profileDir.toUpperCase())).toBe(slotId);
  });

  it('resolveCwdBinding matches the longest bound folder, else null', async () => {
    const h = await harness();
    const { group } = await setupGroup(h); // bound folder: C:\work
    expect(await h.engine.resolveCwdBinding('C:\\work')).toEqual({ groupId: group.id });
    expect(await h.engine.resolveCwdBinding('C:\\work\\sub\\deeper')).toEqual({
      groupId: group.id,
    });
    expect(await h.engine.resolveCwdBinding('C:\\other')).toBeNull();
    // Never a bare string prefix: C:\work2 is not within C:\work.
    expect(await h.engine.resolveCwdBinding('C:\\work2')).toBeNull();
  });
});
