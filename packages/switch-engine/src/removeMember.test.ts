// Removing a group member clears the member's live seat in the group's profile. The order is the
// crash-safety contract: the seat is emptied (after adopting any rotation made in it) BEFORE the
// registry drops the row, the same order an unbind's dissolve uses. The other order leaves the removed
// login live in the profile when the process dies between the two — and when the removal dissolved
// the group, that profile is no slot any more, so nothing ever checks or clears it.
//
// A profile no group owns that still holds a live login (left by an older build) is reported by
// checkSlots and cleared by repairSlots.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, profilesRoot, sandboxPaths, type Paths } from './paths.js';
import { groupSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

// Fail the write that follows a groups.json write — the instant right after the registry dropped the
// row, which is where a removal that clears the seat second leaves a live login behind.
const faults = vi.hoisted(() => ({ afterGroupsWrite: false }));
vi.mock('./fsutil.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./fsutil.js')>();
  return {
    ...real,
    atomicWriteFile: async (...a: Parameters<typeof real.atomicWriteFile>) => {
      await real.atomicWriteFile(...a);
      if (faults.afterGroupsWrite && basename(a[0]) === 'groups.json') {
        faults.afterGroupsWrite = false;
        throw new Error('process died after groups.json');
      }
    },
  };
});

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(async () => {
  faults.afterGroupsWrite = false;
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const bundle = (t: string, expiresAt = NOW + 8 * HOUR): CredentialBundle => ({
  claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' },
});

interface Harness {
  root: string;
  paths: Paths;
  mk: (faultAt?: (checkpoint: string) => void) => SwitchEngine;
  vault: Vault;
  repo: string;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-rmmember-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  await mkdir(join(root, 'repo'), { recursive: true });
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
  const protector = new InsecurePassthroughProtector();
  const mk = (faultAt?: (checkpoint: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh: (c: ClaudeOauth) => Promise.resolve(c),
      clock: () => NOW,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    root,
    paths,
    mk,
    vault: new Vault(paths.vaultDir, protector, () => NOW, undefined, process.platform),
    repo: realpathSync.native(join(root, 'repo')),
  };
}

function profileStore(paths: Paths, dir: string): CredentialStore {
  return new CredentialStore({
    claudeDir: dir,
    credentialsPath: join(dir, '.credentials.json'),
    claudeJsonPath: join(dir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

async function refreshTokenIn(path: string): Promise<string | undefined> {
  return readFile(path, 'utf8').then(
    (t) => (JSON.parse(t) as { claudeAiOauth: ClaudeOauth }).claudeAiOauth.refreshToken,
    () => undefined,
  );
}

describe('removing the only member of a bound group', () => {
  it('a process that dies right after the registry drop never leaves the login live in the profile', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    const g = (await e.bindFolder(h.repo, [W.id])).group;
    const profileCreds = join(groupProfileDir(h.paths.vaultDir, g.id), '.credentials.json');
    expect(await refreshTokenIn(profileCreds)).toBe('rt-W');

    faults.afterGroupsWrite = true;
    await expect(e.removeAccount(W.id)).rejects.toThrow('process died');

    // Restart, then what the operator is told to do after a removal: add the login back, use it.
    const e2 = h.mk();
    await e2.recover();
    await e2.repairSlots();
    const W2 = await e2.addAccount('W', bundle('W'));
    await e2.activate(W2.id, { force: true });

    expect(await refreshTokenIn(profileCreds)).toBeUndefined();
    expect(await refreshTokenIn(h.paths.credentialsPath)).toBe('rt-W');
    expect(await e2.checkSlots()).toEqual([]);
  });
});

describe('removing a live group member dies after the seat is cleared', () => {
  it('keeps the account whole with its rotated token, and a rerun completes the removal', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    const V = await e.addAccount('V', bundle('V'));
    await e.activate(P.id, { force: true });
    const g = (await e.bindFolder(h.repo, [W.id, V.id])).group;
    const slot = groupSlotId(g.id);
    await e.activate(W.id, { force: true, slot });
    // A session in the bound folder rotated W's token inside the profile.
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, g.id));
    await profile.writeLiveCredentials({
      accessToken: 'at-W2',
      refreshToken: 'rt-W2',
      expiresAt: NOW + 9 * HOUR,
    });

    const dying = h.mk((cp) => {
      if (cp === 'remove:after-clear-live') throw new Error('process died');
    });
    await expect(dying.removeAccount(W.id)).rejects.toThrow('process died');

    // The removal had not happened yet: W is still a member, with the rotation adopted, and the seat
    // it held is empty rather than holding a login nothing will remove.
    expect((await h.vault.getGroup(g.id))?.members.map((m) => m.id)).toContain(W.id);
    expect((await h.vault.readBundle(W.id)).claudeAiOauth.refreshToken).toBe('rt-W2');
    expect(await profile.readLiveCredentials()).toBeUndefined();

    const e2 = h.mk();
    await e2.removeAccount(W.id);
    expect((await h.vault.getGroup(g.id))?.members.map((m) => m.id)).toEqual([V.id]);
    await e2.ensureGroupLive(g.id);
    expect((await profile.readLiveCredentials())?.refreshToken).toBe('rt-V');
    expect(await e2.checkSlots()).toEqual([]);
  });
});

describe('removing the only member dies after the registry drop', () => {
  it('leaves the dissolved profile empty, and the next repair converges the guard snapshot', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    const g = (await e.bindFolder(h.repo, [W.id])).group;
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, g.id));

    const dying = h.mk((cp) => {
      if (cp === 'remove:after-registry-drop') throw new Error('process died');
    });
    await expect(dying.removeAccount(W.id)).rejects.toThrow('process died');

    expect(await h.vault.getGroup(g.id)).toBeUndefined();
    expect(await profile.readLiveCredentials()).toBeUndefined();
    const e2 = h.mk();
    expect(await e2.checkSlots()).toEqual([]);
    await e2.repairSlots();
    expect((await e2.getGuardSnapshotFreshness()).fresh).toBe(true);
  });
});

describe('a profile no group owns', () => {
  it('holding a live login is reported by checkSlots and cleared by repairSlots', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    // What an older build's interrupted removal leaves: a dissolved group's profile still logged in.
    const orphanDir = join(profilesRoot(h.paths.vaultDir), '0b1c2d3e-0000-4000-8000-000000000000');
    await mkdir(orphanDir, { recursive: true });
    const orphan = profileStore(h.paths, orphanDir);
    await orphan.writeLiveCredentials(bundle('W').claudeAiOauth);
    await writeFile(
      join(orphanDir, '.claude.json'),
      JSON.stringify({ oauthAccount: bundle('W').oauthAccount }),
    );

    const found = await e.checkSlots();
    expect(found).toContainEqual(
      expect.objectContaining({ kind: 'orphan_profile_login', accountId: W.id }),
    );

    const res = await e.repairSlots();

    expect(res.remaining).toEqual([]);
    expect(await orphan.readLiveCredentials()).toBeUndefined();
    expect(await orphan.readOauthAccount()).toBeUndefined();
    expect((await h.vault.readBundle(W.id)).claudeAiOauth.refreshToken).toBe('rt-W');
    expect(await e.checkSlots()).toEqual([]);
  });

  it('a dissolved group whose profile was left empty is not reported', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    await e.bindFolder(h.repo, [W.id]);
    await e.unbindFolder(h.repo);

    expect(await e.checkSlots()).toEqual([]);
  });
});
