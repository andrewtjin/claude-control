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
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { sandboxPaths, type Paths } from './paths.js';
import type { ClaudeOauth, CredentialBundle, OauthAccount } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];

afterEach(async () => {
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
