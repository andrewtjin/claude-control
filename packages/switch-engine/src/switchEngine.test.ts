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
import { CadenceError, QuarantineError, UnknownAccountError, RefreshError } from './errors.js';
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

describe('captureFromConfigDir', () => {
  it('vaults a transient-dir login without touching the live login or active id', async () => {
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);

    // Simulate WT-1: a `claude` run under CLAUDE_CONFIG_DIR=<dir> left BOTH files there.
    const captureDir = join(h.paths.claudeDir, '..', 'capture');
    await mkdir(captureDir, { recursive: true });
    const fresh = bundleFor('FRESH', NOW + 10 * HOUR);
    const store = new CredentialStore({
      claudeDir: captureDir,
      credentialsPath: join(captureDir, '.credentials.json'),
      claudeJsonPath: join(captureDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials(fresh.claudeAiOauth);
    await store.writeOauthAccount(fresh.oauthAccount!);

    const account = await h.engine.captureFromConfigDir('fresh', captureDir);

    expect(account.label).toBe('fresh');
    expect(account.accountUuid).toBe('uuid-FRESH');
    expect((await h.vault.readBundle(account.id)).claudeAiOauth.accessToken).toBe('FRESH');
    // The real login is untouched: A stays live AND active.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('refuses when the transient dir has no credentials (login never completed)', async () => {
    const h = await harness();
    const emptyDir = join(h.paths.claudeDir, '..', 'empty-capture');
    await mkdir(emptyDir, { recursive: true });
    await expect(h.engine.captureFromConfigDir('x', emptyDir)).rejects.toBeInstanceOf(RefreshError);
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

describe('activate — cadence guard', () => {
  /** Seed A (live+active) plus B and C, then hop to B to arm the cadence clock. */
  async function armedHarness() {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    const accountC = await h.engine.addAccount('C', bundleFor('C', NOW + 10 * HOUR));
    await h.engine.activate(accountB.id); // first hop always allowed (no prior state)
    return { h, accountA, accountB, accountC };
  }

  it('blocks a second account hop inside the minimum interval', async () => {
    const { h, accountC } = await armedHarness();
    h.setNow(NOW + 10_000); // 10s after the hop — inside the 60s default window
    const err = await h.engine.activate(accountC.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CadenceError);
    expect((err as CadenceError).retryAfterMs).toBe(50_000);
    // The blocked hop changed nothing: B is still live and active.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('B');
  });

  it('allows the hop once the interval has elapsed', async () => {
    const { h, accountC } = await armedHarness();
    h.setNow(NOW + 61_000);
    await expect(h.engine.activate(accountC.id)).resolves.toMatchObject({ ok: true });
  });

  it('force bypasses the guard but still restarts the cadence clock', async () => {
    const { h, accountA, accountC } = await armedHarness();
    h.setNow(NOW + 10_000);
    await expect(h.engine.activate(accountC.id, { force: true })).resolves.toMatchObject({
      ok: true,
    });
    // The forced hop armed the clock at NOW+10s — an unforced hop right after is refused.
    h.setNow(NOW + 20_000);
    await expect(h.engine.activate(accountA.id)).rejects.toBeInstanceOf(CadenceError);
  });

  it('exempts re-activating the already-active account (heal, not hop)', async () => {
    const { h, accountB } = await armedHarness();
    h.setNow(NOW + 10_000);
    await expect(h.engine.activate(accountB.id)).resolves.toMatchObject({ ok: true });
  });

  it('can be disabled with minSwitchIntervalMs: 0', async () => {
    const h = await harness();
    // Rebuild the engine on the same paths with the guard off.
    const engine = new SwitchEngine({
      paths: h.paths,
      protector: new InsecurePassthroughProtector(),
      refresh: h.refresh,
      clock: () => NOW,
      refreshSkewMs: 5 * 60 * 1000,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 2000, pollMs: 10 },
    });
    const a = bundleFor('A', NOW + 10 * HOUR);
    await h.credStore.writeLiveCredentials(a.claudeAiOauth);
    await h.credStore.writeOauthAccount(a.oauthAccount!);
    const accountA = await engine.captureCurrentLogin('A');
    const accountB = await engine.addAccount('B', bundleFor('B', NOW + 10 * HOUR));
    await expect(engine.activate(accountB.id)).resolves.toMatchObject({ ok: true });
    await expect(engine.activate(accountA.id)).resolves.toMatchObject({ ok: true });
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

describe('refreshToken — background refresh for polling', () => {
  it('refreshes an expired idle account in the vault without touching live files or active id', async () => {
    const h = await harness();
    // B's token expired an hour ago — exactly the blind-poller case.
    const { accountA, accountB } = await seedAActiveWithB(h, NOW - HOUR);

    const result = await h.engine.refreshToken(accountB.id);

    expect(result).toMatchObject({ accountId: accountB.id, refreshed: true });
    expect(result.expiresAt).toBe(NOW + HOUR);
    expect(h.refresh).toHaveBeenCalledOnce();
    // The rotated (single-use) token is persisted in the vault...
    const vaulted = await h.vault.readBundle(accountB.id);
    expect(vaulted.claudeAiOauth.accessToken).toBe('refreshed-B');
    expect(vaulted.claudeAiOauth.refreshToken).toBe('rotated-r-B');
    // ...and NOTHING live changed: A is still the live and active account.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect((await h.credStore.readOauthAccount())?.accountUuid).toBe('uuid-A');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
    // No leftover switch machinery either.
    expect(await h.intent.read()).toBeUndefined();
    expect(await h.vault.readRollback()).toBeUndefined();
  });

  it('is a no-op when the token is still fresh', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h, NOW + 10 * HOUR);

    const result = await h.engine.refreshToken(accountB.id);

    expect(result).toMatchObject({ refreshed: false, skippedReason: 'token_fresh' });
    expect(result.expiresAt).toBe(NOW + 10 * HOUR);
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('never network-refreshes the ACTIVE account; adopts a CLI-side rotation instead', async () => {
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);
    // The CLI rotated A's token while live; the vault copy is stale AND (say) expired.
    const liveA = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({ ...liveA, refreshToken: 'cli-rotated' });

    const result = await h.engine.refreshToken(accountA.id);

    // A refresh here would consume the single-use token the live session still holds.
    expect(result).toMatchObject({
      refreshed: false,
      skippedReason: 'active_account',
      adoptedLiveRotation: true,
    });
    expect(h.refresh).not.toHaveBeenCalled();
    // The rotation was adopted into the vault, so the vault copy is current again.
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.refreshToken).toBe('cli-rotated');
  });

  it('quarantines the account when its refresh token is permanently dead', async () => {
    const dead: RefreshFn = () => Promise.reject(new QuarantineError('invalid_grant'));
    const h = await harness(dead);
    const { accountB } = await seedAActiveWithB(h, NOW - HOUR);

    await expect(h.engine.refreshToken(accountB.id)).rejects.toBeInstanceOf(QuarantineError);
    expect((await h.engine.listAccounts()).find((a) => a.id === accountB.id)?.quarantined).toBe(
      true,
    );
    // A quarantined account is then refused outright (no further refresh attempts).
    await expect(h.engine.refreshToken(accountB.id)).rejects.toBeInstanceOf(QuarantineError);
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it('propagates a transient refresh failure without quarantining', async () => {
    const flaky: RefreshFn = () => Promise.reject(new RefreshError('network', 'network'));
    const h = await harness(flaky);
    const { accountB } = await seedAActiveWithB(h, NOW - HOUR);

    await expect(h.engine.refreshToken(accountB.id)).rejects.toBeInstanceOf(RefreshError);
    expect((await h.engine.listAccounts()).find((a) => a.id === accountB.id)?.quarantined).toBe(
      false,
    );
  });

  it('rejects an unknown account id', async () => {
    const h = await harness();
    await expect(h.engine.refreshToken('nope')).rejects.toBeInstanceOf(UnknownAccountError);
  });
});
