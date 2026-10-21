// Removing an account clears its live seat in any folder rule's profile. The order is the
// crash-safety contract: the seat is emptied (after adopting any rotation made in it) BEFORE the
// registry drops the row, the same order a reset's dissolve uses. The other order leaves the removed
// login live in the profile when the process dies between the two — and when the removal dissolved
// the rule, that profile is no slot any more, so nothing ever checks or clears it.
//
// A rule slot can hold an included account or an inherited shared one, and a rule can reference an
// account only by excluding it; every one of those removals is covered. A profile no rule owns that
// still holds a live login (left by an older build) is reported by checkSlots and cleared by
// repairSlots.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { AccountLabelChangedError } from './errors.js';
import { acquireLock } from './lock.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { groupProfileDir, profilesRoot, sandboxPaths, type Paths } from './paths.js';
import { ruleSlotId } from './types.js';
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

describe("removing a rule's only included account", () => {
  it('a process that dies right after the registry drop never leaves the login live in the profile', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    const rule = (await e.includeInFolder(h.repo, [W.id])).rule;
    const profileCreds = join(groupProfileDir(h.paths.vaultDir, rule.id), '.credentials.json');
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

describe('removing a live included account dies after the seat is cleared', () => {
  it('keeps the account whole with its rotated token, and a rerun completes the removal', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    const V = await e.addAccount('V', bundle('V'));
    await e.activate(P.id, { force: true });
    const rule = (await e.includeInFolder(h.repo, [W.id, V.id])).rule;
    const slot = ruleSlotId(rule.id);
    await e.activate(W.id, { force: true, slot });
    // A session in the ruled folder rotated W's token inside the profile.
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, rule.id));
    await profile.writeLiveCredentials({
      accessToken: 'at-W2',
      refreshToken: 'rt-W2',
      expiresAt: NOW + 9 * HOUR,
    });

    const dying = h.mk((cp) => {
      if (cp === 'remove:after-clear-live') throw new Error('process died');
    });
    await expect(dying.removeAccount(W.id)).rejects.toThrow('process died');

    // The removal had not happened yet: W is still included, with the rotation adopted, and the seat
    // it held is empty rather than holding a login nothing will remove.
    expect((await h.vault.getRule(rule.id))?.include).toContain(W.id);
    expect((await h.vault.readBundle(W.id)).claudeAiOauth.refreshToken).toBe('rt-W2');
    expect(await profile.readLiveCredentials()).toBeUndefined();

    const e2 = h.mk();
    await e2.removeAccount(W.id);
    expect((await h.vault.getRule(rule.id))?.include).toEqual([V.id]);
    // The remaining included account is seated first; shared P stays in the global slot alone.
    await e2.ensureRuleLive(rule.id);
    expect((await profile.readLiveCredentials())?.refreshToken).toBe('rt-V');
    expect(await refreshTokenIn(h.paths.credentialsPath)).toBe('rt-P');
    expect(await e2.checkSlots()).toEqual([]);
  });
});

describe("removing the rule's only included account dies after the registry drop", () => {
  it('leaves the dissolved profile empty, and the next repair converges the guard snapshot', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    const rule = (await e.includeInFolder(h.repo, [W.id])).rule;
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, rule.id));

    const dying = h.mk((cp) => {
      if (cp === 'remove:after-registry-drop') throw new Error('process died');
    });
    await expect(dying.removeAccount(W.id)).rejects.toThrow('process died');

    expect(await h.vault.getRule(rule.id)).toBeUndefined();
    expect(await profile.readLiveCredentials()).toBeUndefined();
    const e2 = h.mk();
    expect(await e2.checkSlots()).toEqual([]);
    await e2.repairSlots();
    expect((await e2.getGuardSnapshotFreshness()).fresh).toBe(true);
  });
});

describe('removing a shared account a rule slot inherited', () => {
  it('clears its seat in the rule slot (rotation adopted first), and the rule stands', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const S = await e.addAccount('S', bundle('S'));
    const T = await e.addAccount('T', bundle('T'));
    const X = await e.addAccount('X', bundle('X'));
    await e.activate(P.id, { force: true });
    // An exclude-only rule: its slot inherits the shared pool, so it seats a shared account that is
    // not live in the global slot.
    const res = await e.excludeInFolder(h.repo, [X.id]);
    const rule = res.rule;
    const inherited = res.live.liveAccount;
    expect([S.id, T.id]).toContain(inherited);
    const removed = inherited === S.id ? S : T;
    const remaining = removed === S ? T : S;
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, rule.id));
    // A session in the folder rotated the inherited account's token inside the profile.
    await profile.writeLiveCredentials({
      accessToken: 'at-rotated',
      refreshToken: 'rt-rotated',
      expiresAt: NOW + 9 * HOUR,
    });

    const dying = h.mk((cp) => {
      if (cp === 'remove:after-clear-live') throw new Error('process died');
    });
    await expect(dying.removeAccount(removed.id)).rejects.toThrow('process died');
    // The shared account's seat in a RULE slot is cleared like an included one's, never left behind,
    // and its rotation reached its own bundle first.
    expect(await profile.readLiveCredentials()).toBeUndefined();
    expect((await h.vault.readBundle(removed.id)).claudeAiOauth.refreshToken).toBe('rt-rotated');

    await h.mk().removeAccount(removed.id);
    // The rule only excluded X, so it stands; the global slot is untouched.
    expect((await h.vault.getRule(rule.id))?.exclude).toEqual([X.id]);
    expect(await refreshTokenIn(h.paths.credentialsPath)).toBe('rt-P');
    // The next self-heal seats the other shared account, never excluded X nor global P.
    await expect(h.mk().ensureRuleLive(rule.id)).resolves.toMatchObject({
      liveAccount: remaining.id,
    });
    expect(await h.mk().checkSlots()).toEqual([]);
  });
});

describe('removing the only account an exclude-only rule names', () => {
  it('dissolves the rule and clears its seat, whoever holds it', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const S = await e.addAccount('S', bundle('S'));
    const X = await e.addAccount('X', bundle('X'));
    await e.activate(P.id, { force: true });
    const res = await e.excludeInFolder(h.repo, [X.id]);
    expect(res.live.liveAccount).toBe(S.id);
    const profile = profileStore(h.paths, groupProfileDir(h.paths.vaultDir, res.rule.id));

    // X was never live in the slot, but removing it leaves the rule with nothing to include or
    // exclude: the rule dissolves, so the profile is no slot any more and S's login must not stay.
    await e.removeAccount(X.id);

    expect(await h.vault.getRule(res.rule.id)).toBeUndefined();
    expect(await profile.readLiveCredentials()).toBeUndefined();
    expect(await profile.readOauthAccount()).toBeUndefined();
    expect((await h.vault.getAccount(S.id))?.id).toBe(S.id);
    expect(await refreshTokenIn(h.paths.credentialsPath)).toBe('rt-P');
    expect(await e.checkSlots()).toEqual([]);
    expect((await e.getGuardSnapshotFreshness()).fresh).toBe(true);
  });
});

describe('a profile no rule owns', () => {
  it('holding a live login is reported by checkSlots and cleared by repairSlots', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    // What an older build's interrupted removal leaves: a dissolved rule's profile still logged in.
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

  it('a dissolved rule whose profile was left empty is not reported', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P'));
    const W = await e.addAccount('W', bundle('W'));
    await e.activate(P.id, { force: true });
    await e.includeInFolder(h.repo, [W.id]);
    await e.resetFolder(h.repo);

    expect(await e.checkSlots()).toEqual([]);
  });
});

describe('removing an account confirmed by its label', () => {
  /** Another process's hold on the credential lock, for as long as the test keeps it. */
  const holdLock = (h: Harness) =>
    acquireLock(join(h.paths.vaultDir, '.lock'), () => NOW, { timeoutMs: 5000, pollMs: 5 });

  it('removes nothing when another process renames it while the removal waits for the lock', async () => {
    const h = await harness();
    const e = h.mk();
    const A = await e.addAccount('alpha', bundle('A'));
    await e.addAccount('bravo', bundle('B'));
    const held = await holdLock(h);
    let settled = false;
    const removal = e.removeAccount(A.id, { expectedLabel: 'alpha' }).finally(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    // The other process commits a rename under its hold, then lets go.
    await h.vault.renameAccount(A.id, 'renamed');
    held.release();
    const err = await removal.then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(AccountLabelChangedError);
    expect(err).toMatchObject({ expectedLabel: 'alpha', currentLabel: 'renamed' });
    expect((await e.listAccounts()).map((a) => a.label).sort()).toEqual(['bravo', 'renamed']);
  });

  it('removes nothing when the account is gone by the time it holds the lock', async () => {
    const h = await harness();
    const e = h.mk();
    const A = await e.addAccount('alpha', bundle('A'));
    await h.vault.removeAccount(A.id);
    await expect(e.removeAccount(A.id, { expectedLabel: 'alpha' })).rejects.toMatchObject({
      currentLabel: null,
    });
  });

  it('removes it when the label still matches', async () => {
    const h = await harness();
    const e = h.mk();
    const A = await e.addAccount('alpha', bundle('A'));
    await e.removeAccount(A.id, { expectedLabel: 'alpha' });
    expect(await e.listAccounts()).toEqual([]);
  });
});
