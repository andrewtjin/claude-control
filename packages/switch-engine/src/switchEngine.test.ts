import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore } from './credentialStore.js';
import { Vault } from './vault.js';
import { IntentStore } from './intent.js';
import { sandboxPaths, type Paths } from './paths.js';
import { QuarantineError, UnknownAccountError, RefreshError } from './errors.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  refresh: ReturnType<typeof vi.fn>;
  credStore: CredentialStore;
  vault: Vault;
  intent: IntentStore;
  setNow: (n: number) => void;
}

async function harness(refreshImpl?: RefreshFn): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-eng-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });

  let now = NOW;
  const clock = () => now;
  const protector = new InsecurePassthroughProtector();
  const defaultRefresh: RefreshFn = (cur) =>
    Promise.resolve({
      ...cur,
      accessToken: 'refreshed-' + cur.accessToken,
      refreshToken: 'rotated-' + cur.refreshToken,
      expiresAt: now + HOUR,
    });
  const refresh = vi.fn(refreshImpl ?? defaultRefresh);

  const engine = new SwitchEngine({
    paths,
    protector,
    refresh: refresh,
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
  });

  return {
    paths,
    engine,
    refresh,
    credStore: new CredentialStore(paths),
    vault: new Vault(paths.vaultDir, protector, clock),
    intent: new IntentStore(paths.vaultDir),
    setNow: (n) => (now = n),
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

/** Seed account A as the live + active account, and add B (far from expiry). */
async function seedAActiveWithB(h: Harness, bExpiresAt = NOW + 10 * HOUR) {
  const a = bundleFor('A', NOW + 10 * HOUR);
  await h.credStore.writeLiveCredentials(a.claudeAiOauth);
  await h.credStore.writeOauthAccount(a.oauthAccount!);
  const accountA = await h.engine.captureCurrentLogin('A');
  const accountB = await h.engine.addAccount('B', bundleFor('B', bExpiresAt));
  return { accountA, accountB };
}

describe('captureCurrentLogin', () => {
  it('captures the live login as a new active account', async () => {
    const h = await harness();
    const a = bundleFor('A', NOW + HOUR);
    await h.credStore.writeLiveCredentials(a.claudeAiOauth);
    await h.credStore.writeOauthAccount(a.oauthAccount!);
    const account = await h.engine.captureCurrentLogin('work');
    expect(account.label).toBe('work');
    expect(await h.engine.getActiveId()).toBe(account.id);
    expect((await h.vault.readBundle(account.id)).claudeAiOauth.accessToken).toBe('A');
  });

  it('refuses when nothing is logged in', async () => {
    const h = await harness();
    await expect(h.engine.captureCurrentLogin('work')).rejects.toBeInstanceOf(RefreshError);
  });
});

describe('activate — happy path', () => {
  it('writes both live files, commits, and leaves no intent or rollback', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);

    const result = await h.engine.activate(accountB.id);

    expect(result).toMatchObject({
      ok: true,
      activeAccountId: accountB.id,
      refreshed: false,
      wroteCredentials: true,
    });
    // Live files now reflect B.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('B');
    expect((await h.credStore.readOauthAccount())?.accountUuid).toBe('uuid-B');
    // Registry active is B; no leftover intent/rollback.
    expect(await h.engine.getActiveId()).toBe(accountB.id);
    expect(await h.intent.read()).toBeUndefined();
    expect(await h.vault.readRollback()).toBeUndefined();
    // No refresh was needed.
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('rejects an unknown account id', async () => {
    const h = await harness();
    await expect(h.engine.activate('nope')).rejects.toBeInstanceOf(UnknownAccountError);
  });

  it('refuses to activate a quarantined account', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    await h.vault.quarantine(accountB.id, 'invalid_grant');
    await expect(h.engine.activate(accountB.id)).rejects.toBeInstanceOf(QuarantineError);
  });
});

describe('activate — refresh on near-expiry', () => {
  it('refreshes the target and persists the rotated token before use', async () => {
    const h = await harness();
    // B expires in 60s — inside the 5-minute skew, so a refresh is required.
    const { accountB } = await seedAActiveWithB(h, NOW + 60_000);

    const result = await h.engine.activate(accountB.id);

    expect(result.refreshed).toBe(true);
    expect(h.refresh).toHaveBeenCalledOnce();
    // The rotated token is both live AND persisted in the vault (single-use safety).
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('refreshed-B');
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.refreshToken).toBe('rotated-r-B');
  });

  it('quarantines the target and does not touch live files when its refresh token is dead', async () => {
    const dead: RefreshFn = () => Promise.reject(new QuarantineError('invalid_grant'));
    const h = await harness(dead);
    const { accountB } = await seedAActiveWithB(h, NOW + 60_000);

    await expect(h.engine.activate(accountB.id)).rejects.toBeInstanceOf(QuarantineError);

    // B is quarantined; A is still the live + active account; no dangling intent.
    expect((await h.engine.listAccounts()).find((a) => a.id === accountB.id)?.quarantined).toBe(
      true,
    );
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.engine.getActiveId()).toBe(
      (await h.engine.listAccounts()).find((a) => a.label === 'A')?.id,
    );
    expect(await h.intent.read()).toBeUndefined();
    expect(await h.vault.readRollback()).toBeUndefined();
  });

  it('propagates a transient refresh failure without quarantining', async () => {
    const flaky: RefreshFn = () => Promise.reject(new RefreshError('network', 'network'));
    const h = await harness(flaky);
    const { accountB } = await seedAActiveWithB(h, NOW + 60_000);

    await expect(h.engine.activate(accountB.id)).rejects.toBeInstanceOf(RefreshError);
    expect((await h.engine.listAccounts()).find((a) => a.id === accountB.id)?.quarantined).toBe(
      false,
    );
  });
});

describe('activate — reconcile-by-reading', () => {
  it('adopts the previous account token when the CLI rotated it under us', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);

    // Simulate the Claude CLI refreshing A's token while it was live: the live refresh token
    // now differs from the vault's stored copy for A.
    const liveA = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({ ...liveA, refreshToken: 'cli-rotated' });

    const result = await h.engine.activate(accountB.id);

    expect(result.adoptedPreviousRotation).toBe(true);
    // The vault's copy of A was updated to the live (rotated) token — not lost.
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.refreshToken).toBe('cli-rotated');
  });

  it('does not adopt when the live token already matches the vault', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    const result = await h.engine.activate(accountB.id);
    expect(result.adoptedPreviousRotation).toBe(false);
  });
});

describe('recover', () => {
  it('is a no-op when no switch was in flight', async () => {
    const h = await harness();
    expect(await h.engine.recover()).toEqual({ recovered: false, action: 'none' });
  });

  it('clears an intent that crashed before any live write', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    await h.intent.write({
      phase: 'begin',
      targetId: accountB.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const result = await h.engine.recover();

    expect(result.action).toBe('cleared');
    expect(await h.intent.read()).toBeUndefined();
    // Live untouched — still A.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
  });

  it('rolls forward when the target credentials are already live', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    // Simulate a crash right after the live files were written to B but before commit.
    const b = await h.vault.readBundle(accountB.id);
    await h.credStore.writeLiveCredentials(b.claudeAiOauth);
    await h.intent.write({
      phase: 'written',
      targetId: accountB.id,
      prevActiveId: null,
      hasRollback: false,
      startedAtMs: NOW,
    });

    const result = await h.engine.recover();

    expect(result.action).toBe('rolled_forward');
    expect(await h.engine.getActiveId()).toBe(accountB.id);
    expect(await h.intent.read()).toBeUndefined();
  });

  it('rolls back to the snapshot when the live write is inconsistent', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    // Snapshot A as the rollback target, corrupt the live files, and leave a 'written' intent.
    const a = await h.vault.readBundle(accountA.id);
    await h.vault.writeRollback(a);
    await h.credStore.writeLiveCredentials(oauth('CORRUPT', NOW + HOUR));
    await h.intent.write({
      phase: 'written',
      targetId: accountB.id,
      prevActiveId: accountA.id,
      hasRollback: true,
      startedAtMs: NOW,
    });

    const result = await h.engine.recover();

    expect(result.action).toBe('rolled_back');
    // Live restored to A from the encrypted snapshot.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.intent.read()).toBeUndefined();
    expect(await h.vault.readRollback()).toBeUndefined();
  });
});
