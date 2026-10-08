// A slot's live token is what a session actually spends; the identity block beside it is only a
// statement about whose token it is, and that statement can be wrong (a switch torn between its two
// live writes that nothing recorded, a copy made by hand). Every write that stores a live token in a
// bundle — rotation adoption, a capture — and every network refresh must therefore be refused when the
// files themselves show the token is not the named account's. These tests pin that:
//
//   - rotation adoption never stores a live token that is another stored account's, and never adopts
//     one whose owner the live login no longer names;
//   - checkSlots reports a slot whose token and identity disagree, and a token stored under two
//     accounts, and repairSlots re-seats the slot on the account the token belongs to;
//   - refreshToken never spends a stored token that sits live in some slot, whatever its identity says;
//   - `accounts add` never stores a live token another account already holds.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector, type Protector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { groupProfileDir, sandboxPaths, type Paths } from './paths.js';
import { groupSlotId } from './types.js';
import type { ClaudeOauth, CredentialBundle, OauthAccount } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  /** A fresh engine over the same on-disk state — the daemon, another CLI, or a restart. */
  mk: (faultAt?: (checkpoint: string) => void) => SwitchEngine;
  vault: Vault;
  /** The GLOBAL slot's live files. */
  global: CredentialStore;
  folder: (name: string) => Promise<string>;
  refresh: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-torn-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
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
  const refreshImpl: RefreshFn = (c: ClaudeOauth) =>
    Promise.resolve({
      ...c,
      accessToken: 'refreshed-' + c.accessToken,
      refreshToken: 'rotated-' + c.refreshToken,
      expiresAt: NOW + 9 * HOUR,
    });
  const refresh = vi.fn(refreshImpl);
  const mk = (faultAt?: (checkpoint: string) => void): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock: () => NOW,
      refreshSkewMs: 5 * 60_000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      bindFs,
      isProcessAlive: () => false,
      bindEnforce: 'block',
      ...(faultAt ? { faultAt } : {}),
    });
  return {
    paths,
    mk,
    vault: new Vault(paths.vaultDir, protector, () => NOW, undefined, process.platform),
    global: new CredentialStore(paths),
    folder: async (name) => {
      const p = join(root, name);
      await mkdir(p, { recursive: true });
      return realpathSync.native(p);
    },
    refresh,
  };
}

function identity(t: string): OauthAccount {
  return { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' };
}

/** P's token expires earlier than T's (T was minted later) — the ordinary case after a refresh, and
 *  the one where rotation adoption's direction guard lets a wrong token through. */
function bundle(t: string, expiresAt: number): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt },
    oauthAccount: identity(t),
  };
}

/** Seed P (live in global), T and R — all shared, all far from expiry. */
async function seed(h: Harness) {
  const e = h.mk();
  const P = await e.addAccount('P', bundle('P', NOW + 2 * HOUR));
  const T = await e.addAccount('T', bundle('T', NOW + 8 * HOUR));
  const R = await e.addAccount('R', bundle('R', NOW + 8 * HOUR));
  await e.activate(P.id, { force: true });
  return { P, T, R };
}

/** The refresh tokens each seeded account's bundle holds. */
async function storedTokens(
  h: Harness,
  ids: Record<string, string>,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const [name, id] of Object.entries(ids)) {
    out[name] = (await h.vault.readBundle(id)).claudeAiOauth.refreshToken;
  }
  return out;
}

/** Who the global slot's two live files name: the refresh token's suffix and the identity's. */
async function globalLive(h: Harness): Promise<{ creds?: string; identity?: string }> {
  const creds = (await h.global.readLiveCredentials())?.refreshToken;
  const uuid = (await h.global.readOauthAccount())?.accountUuid;
  return {
    ...(creds !== undefined ? { creds: creds.replace(/^rt-/, '') } : {}),
    ...(uuid !== undefined ? { identity: uuid.replace(/^uuid-/, '') } : {}),
  };
}

describe('a torn slot whose live token rotated before anything settled it', () => {
  it('keeps the token live, removes the identity that cannot be trusted, and adopts it nowhere', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await h.vault.writeRollback(await h.vault.readBundle(P.id));
    // The switch to T died between its writes, and a running session then rotated the live token.
    // Whose token it now is cannot be told from the files: the identity still names P.
    await h.global.writeLiveCredentials({
      accessToken: 'at-X2',
      refreshToken: 'rt-X2',
      expiresAt: NOW + 9 * HOUR,
    });
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'writing',
      targetId: T.id,
      prevActiveId: P.id,
      hasRollback: true,
      startedAtMs: NOW,
    });

    const e = h.mk();
    await e.recover();

    expect((await h.global.readLiveCredentials())?.refreshToken).toBe('rt-X2');
    expect(await h.global.readOauthAccount()).toBeUndefined();
    await e.activate(R.id, { force: true, origin: 'auto' });
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});

describe('rotation adoption refuses a token it cannot attribute', () => {
  it("never stores a live token that is another account's under the account the identity names", async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    // Something outside any intent left T's stored credentials live under P's identity.
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const res = await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(res.adoptedPreviousRotation).toBe(false);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });

  it('never adopts when the live identity block is gone and the previous account has one', async () => {
    const h = await harness();
    const { P, R } = await seed(h);
    await h.global.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });
    await writeFile(h.paths.claudeJsonPath, JSON.stringify({ someOtherKey: true }));

    const res = await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(res.adoptedPreviousRotation).toBe(false);
    expect((await h.vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P');
  });

  it('still adopts an ordinary rotation of the live account', async () => {
    const h = await harness();
    const { P, R } = await seed(h);
    await h.global.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });

    const res = await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(res.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P2');
  });
});

describe('checkSlots and repairSlots see a slot whose token and identity disagree', () => {
  it('reports it, and the repair re-seats the account the token belongs to', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const e = h.mk();
    const found = await e.checkSlots();
    expect(found).toContainEqual(
      expect.objectContaining({ kind: 'live_identity_mismatch', accountId: T.id, slot: 'global' }),
    );

    const res = await e.repairSlots();

    expect(res.remaining).toEqual([]);
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'T' });
    expect(await e.getActiveId('global')).toBe(T.id);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });

  it('reports a token stored under two accounts', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // What the adoption defect leaves behind: P's bundle holding T's token under P's identity.
    await h.vault.writeBundle(P.id, {
      claudeAiOauth: (await h.vault.readBundle(T.id)).claudeAiOauth,
      oauthAccount: identity('P'),
    });

    const found = await h.mk().checkSlots();

    const dup = found.find((v) => v.kind === 'duplicate_stored_token');
    expect(dup).toBeDefined();
    expect(dup?.detail).toContain('"P"');
    expect(dup?.detail).toContain('"T"');
  });
});

describe('refreshToken never spends a token that is live somewhere', () => {
  it('adopts instead of refreshing when the stored token sits live under another identity', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P', NOW + 8 * HOUR));
    // T's token is inside the refresh window, so an idle T would be refreshed over the network.
    const T = await e.addAccount('T', bundle('T', NOW + 60_000));
    await e.activate(P.id, { force: true });
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const res = await h.mk().refreshToken(T.id);

    expect(res.refreshed).toBe(false);
    expect(h.refresh).not.toHaveBeenCalled();
    expect((await h.vault.readBundle(T.id)).claudeAiOauth.refreshToken).toBe('rt-T');
  });
});

describe('capturing the current login', () => {
  it('never stores a live token another account already holds, whatever identity sits beside it', async () => {
    const h = await harness();
    const { T } = await seed(h);
    // T's stored token is live under an identity no stored account has.
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await h.global.writeOauthAccount(identity('N'));

    await expect(h.mk().captureCurrentLogin('N')).rejects.toThrow(/already stored/);

    expect((await h.vault.listAllAccounts()).map((a) => a.label).sort()).toEqual(['P', 'R', 'T']);
  });
});

describe('the stored-token check under the lock', () => {
  it('costs no per-bundle decrypt there when the fingerprint cache is cold', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P', NOW + 2 * HOUR));
    const R = await e.addAccount('R', bundle('R', NOW + 8 * HOUR));
    for (const t of ['A', 'B', 'C', 'D']) await e.addAccount(t, bundle(t, NOW + 8 * HOUR));
    await e.activate(P.id, { force: true });
    // P's token rotated while live, so the next switch adopts it — and checks it against every bundle.
    await h.global.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });
    // A process that has never seen these bundles, with no fingerprint file to start from.
    await rm(join(h.paths.vaultDir, 'token-prints.json'), { force: true });
    const lockDir = join(h.paths.vaultDir, '.lock');
    const inner = new InsecurePassthroughProtector();
    let decryptsUnderLock = 0;
    const counting: Protector = {
      protect: (plain) => inner.protect(plain),
      unprotect: (blob) => {
        if (existsSync(lockDir)) decryptsUnderLock += 1;
        return inner.unprotect(blob);
      },
    };
    const cold = new SwitchEngine({
      paths: h.paths,
      protector: counting,
      liveCredentialChannel: new FileCredentialChannel(h.paths.credentialsPath),
      refresh: (c: ClaudeOauth) => Promise.resolve(c),
      clock: () => NOW,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      isProcessAlive: () => false,
    });

    const res = await cold.activate(R.id, { force: true });

    expect(res.adoptedPreviousRotation).toBe(true);
    // Under the lock: the previous account's bundle (adoption) and the target's — never all six.
    expect(decryptsUnderLock).toBeLessThanOrEqual(2);
  });
});

describe('a stored bundle that cannot be used', () => {
  /** Z's bundle file cannot be read at all (a directory where the file should be: EISDIR; any read
   *  error other than a missing file behaves the same). */
  async function unreadableBundle(h: Harness): Promise<string> {
    const Z = await h.mk().addAccount('Z', bundle('Z', NOW + 8 * HOUR));
    const path = join(h.paths.vaultDir, Z.id, 'cred.enc');
    await rm(path, { force: true });
    await mkdir(join(path, 'x'), { recursive: true });
    return Z.id;
  }

  it('an unreadable one is reported by the slot check instead of failing it', async () => {
    const h = await harness();
    await seed(h);
    const Z = await unreadableBundle(h);
    const unreadable = [
      {
        kind: 'unreadable_bundle',
        accountId: Z,
        detail: expect.stringContaining(
          'the stored login of "Z" could not be read (EISDIR',
        ) as unknown,
      },
    ];

    const e = h.mk();
    await expect(e.checkSlots()).resolves.toEqual(unreadable);
    await expect(e.repairSlots()).resolves.toMatchObject({ remaining: unreadable });
  });

  it('an unreadable one does not stop a switch from adopting the live rotation', async () => {
    const h = await harness();
    const { P, R } = await seed(h);
    await unreadableBundle(h);
    await h.global.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });

    const res = await h.mk().activate(R.id, { force: true });

    expect(res.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P2');
  });

  it('an undecryptable one is reported, and tried once rather than on every check', async () => {
    const h = await harness();
    await seed(h);
    const Z = await h.mk().addAccount('Z', bundle('Z', NOW + 8 * HOUR));
    // A blob this machine can no longer decrypt (a changed DPAPI master key, a restored backup).
    await writeFile(join(h.paths.vaultDir, Z.id, 'cred.enc'), 'not-a-blob-this-machine-can-open');
    const inner = new InsecurePassthroughProtector();
    let decrypts = 0;
    const counting: Protector = {
      protect: (plain) => inner.protect(plain),
      unprotect: (blob) => {
        decrypts += 1;
        return inner.unprotect(blob);
      },
    };
    const daemon = new SwitchEngine({
      paths: h.paths,
      protector: counting,
      liveCredentialChannel: new FileCredentialChannel(h.paths.credentialsPath),
      refresh: (c: ClaudeOauth) => Promise.resolve(c),
      clock: () => NOW,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      isProcessAlive: () => false,
    });

    // The reason is the wrapper's own words: a parse error of decrypted text could quote it.
    const unreadable = [
      {
        kind: 'unreadable_bundle',
        accountId: Z.id,
        detail:
          'the stored login of "Z" could not be read (failed to decrypt or parse credential ' +
          'bundle), so the token checks could not include it',
      },
    ];
    expect(await daemon.checkSlots()).toEqual(unreadable);
    const afterFirst = decrypts;
    expect(afterFirst).toBeGreaterThan(0);
    for (let i = 0; i < 5; i += 1) expect(await daemon.checkSlots()).toEqual(unreadable);

    expect(decrypts).toBe(afterFirst);
  });
});

/** A group slot's live files, read the way Claude Code started in that profile reads them. */
function groupStore(paths: Paths, groupId: string): CredentialStore {
  const dir = groupProfileDir(paths.vaultDir, groupId);
  return new CredentialStore({
    claudeDir: dir,
    credentialsPath: join(dir, '.credentials.json'),
    claudeJsonPath: join(dir, '.claude.json'),
    vaultDir: paths.vaultDir,
  });
}

/** What an older build's mis-attributed adoption leaves: `holder`'s bundle storing `owner`'s token
 *  under `holder`'s own identity. */
async function storeTokenUnder(h: Harness, holder: string, owner: string, name: string) {
  await h.vault.writeBundle(holder, {
    claudeAiOauth: (await h.vault.readBundle(owner)).claudeAiOauth,
    oauthAccount: identity(name),
  });
}

describe('a slot torn outside any intent: one account token under another identity', () => {
  it('a bind of the token owner moves the global slot off it first', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // What an older build's failed identity write leaves once its own recovery cleared the intent.
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();

    const e = h.mk();
    const bound = await e.bindFolder(await h.folder('repo'), [T.id]);

    expect(bound.movedOffGlobal).toBe(T.id);
    expect((await groupStore(h.paths, bound.group.id).readLiveCredentials())?.refreshToken).toBe(
      'rt-T',
    );
    expect((await h.global.readLiveCredentials())?.refreshToken).not.toBe('rt-T');
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
    expect(await e.checkSlots()).toEqual([]);
  });

  it("removing a member clears its token from the group's seat even under another member's identity", async () => {
    const h = await harness();
    const { P } = await seed(h);
    const G1 = await h.mk().addAccount('G1', bundle('G1', NOW + 8 * HOUR));
    const G2 = await h.mk().addAccount('G2', bundle('G2', NOW + 8 * HOUR));
    const bound = await h.mk().bindFolder(await h.folder('repo'), [G1.id, G2.id]);
    const seat = groupStore(h.paths, bound.group.id);
    expect((await seat.readOauthAccount())?.accountUuid).toBe('uuid-G1');
    // G2's token live in the seat under G1's identity.
    await seat.writeLiveCredentials((await h.vault.readBundle(G2.id)).claudeAiOauth);

    await h.mk().removeAccount(G2.id);

    expect((await seat.readLiveCredentials())?.refreshToken).not.toBe('rt-G2');
    expect((await h.vault.readBundle(G1.id)).claudeAiOauth.refreshToken).toBe('rt-G1');
    expect(await globalLive(h)).toEqual({ creds: 'P', identity: 'P' });
    void P;
  });
});

describe('a vault holding one refresh token under two accounts', () => {
  it('never seats it: a switch to either account is refused with the re-login remedy', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await h.mk().activate(R.id, { force: true });
    await storeTokenUnder(h, P.id, T.id, 'P');

    for (const id of [T.id, P.id]) {
      const refused = h.mk().activate(id, { force: true });
      await expect(refused).rejects.toMatchObject({ code: 'shared_token' });
      await expect(refused).rejects.toThrow(/cctl accounts relogin/);
    }
    expect(await globalLive(h)).toEqual({ creds: 'R', identity: 'R' });
  });

  it('a bind of one of them never puts the token live in a second slot', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.mk().activate(T.id, { force: true });
    await storeTokenUnder(h, P.id, T.id, 'P');

    await expect(h.mk().bindFolder(await h.folder('repo'), [P.id])).rejects.toMatchObject({
      code: 'shared_token',
    });

    // Refused before anything moved: no group, and the token live only where it was.
    expect(await h.mk().listGroups()).toEqual([]);
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'T' });
    expect((await h.mk().checkSlots()).map((v) => v.kind)).toEqual(['duplicate_stored_token']);
  });

  it('checkSlots reports the token live in two slots, whatever account each slot names', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    const bound = await h.mk().bindFolder(await h.folder('repo'), [P.id]);
    await h.mk().activate(T.id, { force: true });
    // An older build seated P's contaminated bundle in the folder slot: T's token under P's name.
    await storeTokenUnder(h, P.id, T.id, 'P');
    await groupStore(h.paths, bound.group.id).writeLiveCredentials(
      (await h.vault.readBundle(T.id)).claudeAiOauth,
    );

    const found = await h.mk().checkSlots();

    expect(found).toContainEqual(
      expect.objectContaining({
        kind: 'token_in_multiple_slots',
        slots: ['global', groupSlotId(bound.group.id)],
      }),
    );
    expect(found).toContainEqual(expect.objectContaining({ kind: 'duplicate_stored_token' }));
  });

  it('the repair does not pick one of the two holders of a live token by registry order', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await h.mk().activate(R.id, { force: true });
    await storeTokenUnder(h, P.id, T.id, 'P'); // P is first in registry order
    // A torn switch R -> T that nothing recorded: T's token under R's identity.
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const res = await h.mk().repairSlots();

    // Nothing in the files says whether the token is P's or T's: neither is seated, both are named.
    expect(await globalLive(h)).toEqual({ creds: 'T', identity: 'R' });
    const mismatch = res.remaining.find((v) => v.kind === 'live_identity_mismatch');
    expect(mismatch?.accountId).toBeUndefined();
    expect(mismatch?.detail).toContain('"P" and "T"');
    expect(await storedTokens(h, { P: P.id, T: T.id, R: R.id })).toEqual({
      P: 'rt-T',
      T: 'rt-T',
      R: 'rt-R',
    });
  });

  it("the registry's account holding the live token is no proof it is live when another holds it too", async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // P is live and recorded; T's bundle holds P's token; the identity block names T.
    await storeTokenUnder(h, T.id, P.id, 'T');
    await h.global.writeOauthAccount(identity('T'));

    // The registry is not taken over the identity block on the strength of a token two accounts hold.
    expect(await h.mk().getActiveId('global')).toBe(T.id);
  });

  it('a capture of that token names both holders instead of offering one', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await storeTokenUnder(h, P.id, T.id, 'P');
    await h.global.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await h.global.writeOauthAccount(identity('N'));

    await expect(h.mk().captureCurrentLogin('N')).rejects.toThrow(/"P" and "T"/);
    void T;
  });
});

describe('the unlocked slot check racing a bind', () => {
  it("never reports the new binding's own profile as a login no binding owns", async () => {
    const h = await harness();
    await seed(h);
    const S = await h.mk().addAccount('S', bundle('S', NOW + 8 * HOUR));
    const repo = await h.folder('repo');
    const checker = h.mk();
    const cli = h.mk();
    // The check reads the group list, then the bind commits (its group, then its logged-in
    // profile), then the check lists the profile dirs. Only the check's first read is intercepted:
    // the spy is gone before the bind (and the check's own read) run.
    const spy = vi.spyOn(Vault.prototype, 'readStoredTokens');
    spy.mockImplementationOnce(async function (this: Vault) {
      spy.mockRestore();
      await cli.bindFolder(repo, [S.id]);
      return this.readStoredTokens();
    });

    const found = await checker.checkSlots();

    expect(await h.mk().listGroups()).toHaveLength(1);
    expect(found.filter((v) => v.kind === 'orphan_profile_login')).toEqual([]);
  });
});
