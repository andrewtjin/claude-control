// The live token is what a session actually spends; the identity block beside it is only a statement
// about whose token it is, and that statement can be wrong (a switch torn between its two live writes
// that nothing recorded, a copy made by hand). Every write that stores a live token in a bundle —
// rotation adoption, a capture — and every network refresh must therefore be refused when the files
// themselves show the token is not the named account's. These tests pin that:
//
//   - rotation adoption never stores a live token that is another stored account's, and never adopts
//     one whose owner the live login no longer names;
//   - refreshToken never spends a stored token that sits live, whatever the identity says;
//   - `accounts add` never stores a live token another account already holds;
//   - findTokenConflicts reports live files whose token and identity disagree, and a token stored
//     under two accounts (what the adoption defect leaves behind in a vault);
//   - a token two accounts store is never seated live, and never credited to one of the two;
//   - a bundle the check cannot read is skipped and reported, never thrown, and never decrypted
//     again until it changes.

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector, type Protector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { LOCK_STALE_MS } from './lock.js';
import { Vault } from './vault.js';
import { sandboxPaths, type Paths } from './paths.js';
import type { ClaudeOauth, CredentialBundle, OauthAccount, SwitchIntent } from './types.js';

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
  mk: () => SwitchEngine;
  vault: Vault;
  /** The live files. */
  live: CredentialStore;
  refresh: ReturnType<typeof vi.fn>;
}

async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-owner-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const refreshImpl: RefreshFn = (c: ClaudeOauth) =>
    Promise.resolve({
      ...c,
      accessToken: 'refreshed-' + c.accessToken,
      refreshToken: 'rotated-' + c.refreshToken,
      expiresAt: NOW + 9 * HOUR,
    });
  const refresh = vi.fn(refreshImpl);
  const mk = (): SwitchEngine =>
    new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh,
      clock: () => NOW,
      refreshSkewMs: 5 * 60_000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
    });
  return {
    paths,
    mk,
    vault: new Vault(paths.vaultDir, protector, () => NOW),
    live: new CredentialStore(paths),
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

/** Seed P (live), T and R — all far from expiry. */
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

/** What an older build's mis-attributed adoption leaves in a vault: `holder`'s bundle holding
 *  `owner`'s token, under `holder`'s own identity. */
async function contaminate(h: Harness, holderId: string, holder: string, ownerId: string) {
  await h.vault.writeBundle(holderId, {
    claudeAiOauth: (await h.vault.readBundle(ownerId)).claudeAiOauth,
    oauthAccount: identity(holder),
  });
}

/** A throwaway config dir holding a fresh login of `name`, as `cctl accounts relogin` captures it. */
async function loginDir(h: Harness, name: string): Promise<string> {
  const dir = join(h.paths.vaultDir, '..', `login-${name}`);
  await mkdir(dir, { recursive: true });
  writeFileSync(
    join(dir, '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: `at-${name}9`,
        refreshToken: `rt-${name}9`,
        expiresAt: NOW + 9 * HOUR,
      },
    }),
  );
  writeFileSync(join(dir, '.claude.json'), JSON.stringify({ oauthAccount: identity(name) }));
  return dir;
}

/** Make an account's bundle file unreadable as a file (a directory in its place: EISDIR). Any
 *  read failure other than a missing file takes the same path. */
async function breakBundleFile(h: Harness, id: string): Promise<void> {
  const path = join(h.paths.vaultDir, id, 'cred.enc');
  await rm(path, { force: true });
  await mkdir(join(path, 'x'), { recursive: true });
}

describe.each<{ phase: SwitchIntent['phase'] }>([{ phase: 'writing' }, { phase: 'refreshed' }])(
  'a torn switch (phase "$phase") whose live token rotated before anything settled it',
  ({ phase }) => {
    it('keeps the token live, removes the identity that cannot be trusted, and adopts it nowhere', async () => {
      const h = await harness();
      const { P, T, R } = await seed(h);
      await h.vault.writeRollback(await h.vault.readBundle(P.id));
      // The switch to T died between its writes, and a running session then rotated the live
      // token. Whose token it now is cannot be told from the files: the identity still names P.
      await h.live.writeLiveCredentials({
        accessToken: 'at-X2',
        refreshToken: 'rt-X2',
        expiresAt: NOW + 9 * HOUR,
      });
      await new IntentStore(h.paths.vaultDir).write({
        phase,
        targetId: T.id,
        prevActiveId: P.id,
        hasRollback: true,
        startedAtMs: NOW,
      });

      const e = h.mk();
      await e.recover();

      expect((await h.live.readLiveCredentials())?.refreshToken).toBe('rt-X2');
      expect(await h.live.readOauthAccount()).toBeUndefined();
      await e.activate(R.id, { force: true, origin: 'auto' });
      expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
    });
  },
);

describe('rotation adoption refuses a token it cannot attribute', () => {
  it("never stores a live token that is another account's under the account the identity names", async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    // Something outside any intent (an older build's cleared intent, a hand copy) left T's stored
    // credentials live under P's identity.
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const res = await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(res.adoptedPreviousRotation).toBe(false);
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });

  it('never adopts when the live identity block is gone and the previous account has one', async () => {
    const h = await harness();
    const { P, R } = await seed(h);
    await h.live.writeLiveCredentials({
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
    await h.live.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });

    const res = await h.mk().activate(R.id, { force: true, origin: 'auto' });

    expect(res.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P2');
  });

  it('refuses the same token in the background refresh of the account the identity names', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const res = await h.mk().refreshToken(P.id);

    expect(res).toMatchObject({ refreshed: false, adoptedLiveRotation: false });
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P', T: 'rt-T' });
  });
});

describe('refreshToken never spends a token that is live', () => {
  it('skips the refresh when the stored token sits live under another identity', async () => {
    const h = await harness();
    const e = h.mk();
    const P = await e.addAccount('P', bundle('P', NOW + 8 * HOUR));
    // T's token is inside the refresh window, so an idle T would be refreshed over the network.
    const T = await e.addAccount('T', bundle('T', NOW + 60_000));
    await e.activate(P.id, { force: true });
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

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
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await h.live.writeOauthAccount(identity('N'));

    await expect(h.mk().captureCurrentLogin('N')).rejects.toThrow(/already stored/);

    expect((await h.vault.listAccounts()).map((a) => a.label).sort()).toEqual(['P', 'R', 'T']);
  });
});

describe('findTokenConflicts', () => {
  it('finds nothing in a healthy vault', async () => {
    const h = await harness();
    await seed(h);

    expect(await h.mk().findTokenConflicts()).toEqual([]);
  });

  it("reports live credentials that are one account's token under another's identity", async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const found = await h.mk().findTokenConflicts();

    expect(found).toEqual([
      expect.objectContaining({ kind: 'live_identity_mismatch', accountIds: [T.id, P.id] }),
    ]);
    expect(found[0]?.detail).toContain('"T"');
    expect(found[0]?.detail).toContain('"P"');
  });

  it('reports a token stored under two accounts', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // What the adoption defect leaves behind: P's bundle holding T's token under P's identity.
    await h.vault.writeBundle(P.id, {
      claudeAiOauth: (await h.vault.readBundle(T.id)).claudeAiOauth,
      oauthAccount: identity('P'),
    });

    const found = await h.mk().findTokenConflicts();

    const dup = found.find((c) => c.kind === 'duplicate_stored_token');
    expect(dup?.accountIds.sort()).toEqual([P.id, T.id].sort());
    expect(dup?.detail).toContain('"P"');
    expect(dup?.detail).toContain('"T"');
  });

  it('leaves live files alone while a switch is pending: the next operation settles those', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'writing',
      targetId: T.id,
      prevActiveId: P.id,
      hasRollback: false,
      startedAtMs: NOW,
    });

    expect(await h.mk().findTokenConflicts()).toEqual([]);
    expect((await new IntentStore(h.paths.vaultDir).read())?.phase).toBe('writing');
  });

  it('reports a switch interrupted longer ago than any switch can still be running', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await new IntentStore(h.paths.vaultDir).write({
      phase: 'writing',
      targetId: T.id,
      prevActiveId: P.id,
      hasRollback: false,
      startedAtMs: NOW - LOCK_STALE_MS - 1,
    });

    const found = await h.mk().findTokenConflicts();

    expect(found).toEqual([
      expect.objectContaining({ kind: 'unsettled_switch', accountIds: [T.id, P.id] }),
    ]);
    expect(found[0]?.detail).toContain('"T"');
    expect(found[0]?.detail).toContain('cctl recover');
  });

  it('reports a switch record that cannot be read, instead of throwing', async () => {
    const h = await harness();
    await seed(h);
    await writeFile(join(h.paths.vaultDir, '.switch-intent.json'), '{"phase":');

    const found = await h.mk().findTokenConflicts();

    expect(found).toEqual([expect.objectContaining({ kind: 'unsettled_switch', accountIds: [] })]);
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
    await h.live.writeLiveCredentials({
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
    });

    const res = await cold.activate(R.id, { force: true });

    expect(res.adoptedPreviousRotation).toBe(true);
    // Under the lock: the previous account's bundle (adoption) and the target's — never all six.
    expect(decryptsUnderLock).toBeLessThanOrEqual(2);
  });
});

// A vault an older build already contaminated: one refresh token stored under two accounts. Whichever
// copy is refreshed first kills the other, so it must not be put live, where a session refreshes it.
describe('an account whose stored token another account also stores', () => {
  it('is never seated live: the switch is refused, naming both accounts and the fix', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await contaminate(h, P.id, 'P', T.id);
    await h.mk().activate(R.id, { force: true });

    for (const id of [P.id, T.id]) {
      const refusal = h.mk().activate(id, { force: true });
      await expect(refusal).rejects.toMatchObject({ code: 'shared_token' });
      await expect(refusal).rejects.toThrow(/"P".*"T"|"T".*"P"/);
      await expect(refusal).rejects.toThrow(/relogin/);
    }

    expect((await h.live.readLiveCredentials())?.refreshToken).toBe('rt-R');
    expect((await h.live.readOauthAccount())?.accountUuid).toBe('uuid-R');
    expect(await new IntentStore(h.paths.vaultDir).read()).toBeUndefined();
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-T', T: 'rt-T' });
  });

  it('is seated again once one of the two is re-logged', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await contaminate(h, P.id, 'P', T.id);

    await h.mk().reloginFromConfigDir(P.id, await loginDir(h, 'P'));
    await h.mk().activate(T.id, { force: true });

    expect((await h.live.readLiveCredentials())?.refreshToken).toBe('rt-T');
    expect(await storedTokens(h, { P: P.id, T: T.id })).toEqual({ P: 'rt-P9', T: 'rt-T' });
  });
});

// The files cannot say which of two holders a token really belongs to. Picking one by registry order
// (or by "the registry's account holds it") can hand the token, and everything keyed on it, to the
// account whose copy is the contamination.
describe('a live token that two stored accounts hold', () => {
  it('is reported with both holders, and with no switch that would seat one of them', async () => {
    const h = await harness();
    const { P, T, R } = await seed(h);
    await contaminate(h, P.id, 'P', T.id); // P is first in registry order
    await h.mk().activate(R.id, { force: true });
    // An older build's torn switch R -> T left T's credentials under R's identity.
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);

    const found = await h.mk().findTokenConflicts();

    const mismatch = found.find((c) => c.kind === 'live_identity_mismatch');
    expect(mismatch?.accountIds.slice().sort()).toEqual([P.id, T.id, R.id].sort());
    expect(mismatch?.detail).toContain('"P"');
    expect(mismatch?.detail).toContain('"T"');
    expect(mismatch?.detail).not.toContain('cctl switch');
  });

  it("does not make the registry's account the live one because it is one of the holders", async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    // The registry names P, P's bundle holds T's token, and T's login is live under T's identity.
    await contaminate(h, P.id, 'P', T.id);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await h.live.writeOauthAccount(identity('T'));

    expect(await h.mk().getActiveId()).toBe(T.id);
  });

  it('is refused by a capture that names every holder, not one', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    await contaminate(h, P.id, 'P', T.id);
    await h.live.writeLiveCredentials((await h.vault.readBundle(T.id)).claudeAiOauth);
    await h.live.writeOauthAccount(identity('N'));

    const capture = h.mk().captureCurrentLogin('N');
    await expect(capture).rejects.toThrow(/"P"/);
    await expect(capture).rejects.toThrow(/"T"/);
  });
});

describe('a stored bundle the check cannot read', () => {
  it('is skipped and reported, and does not stop the doctor or a switch that must adopt', async () => {
    const h = await harness();
    const { P, T } = await seed(h);
    const Z = await h.mk().addAccount('Z', bundle('Z', NOW + 8 * HOUR));
    await breakBundleFile(h, Z.id);

    const found = await h.mk().findTokenConflicts();
    expect(found).toEqual([
      expect.objectContaining({ kind: 'unreadable_bundle', accountIds: [Z.id] }),
    ]);
    expect(found[0]?.detail).toContain('"Z"');

    // P's token rotated while live: the next switch adopts it, which checks every stored token.
    await h.live.writeLiveCredentials({
      accessToken: 'at-P2',
      refreshToken: 'rt-P2',
      expiresAt: NOW + 9 * HOUR,
    });
    await expect(h.mk().activate(T.id, { force: true })).resolves.toMatchObject({
      ok: true,
      adoptedPreviousRotation: true,
    });
    expect((await h.vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P2');
  });

  it('is decrypted once per version when it cannot be decrypted, not on every check', async () => {
    const h = await harness();
    await seed(h);
    const Z = await h.mk().addAccount('Z', bundle('Z', NOW + 8 * HOUR));
    // A bundle this machine can no longer decrypt (a DPAPI master-key change, a restored backup).
    await writeFile(join(h.paths.vaultDir, Z.id, 'cred.enc'), 'dpapi:unreadable-on-this-machine');
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
    });

    const first = await daemon.findTokenConflicts();
    const afterFirst = decrypts;
    for (let i = 0; i < 5; i += 1) await daemon.findTokenConflicts();

    expect(decrypts - afterFirst).toBe(0);
    expect(first).toEqual([
      expect.objectContaining({ kind: 'unreadable_bundle', accountIds: [Z.id] }),
    ]);
    // A new version of the bundle is a new blob, and is decrypted again.
    await h.vault.writeBundle(Z.id, bundle('Z', NOW + 8 * HOUR));
    expect(await daemon.findTokenConflicts()).toEqual([]);
  });
});
