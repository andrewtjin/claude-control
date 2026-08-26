import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type ExchangeFn, type RefreshFn } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore } from './credentialStore.js';
import { METADATA_BACKFILL_RETRY_MS, Vault } from './vault.js';
import { IntentStore } from './intent.js';
import { sandboxPaths, type Paths } from './paths.js';
import {
  CadenceError,
  QuarantineError,
  UnknownAccountError,
  RefreshError,
  LockTimeoutError,
} from './errors.js';
import { acquireLock } from './lock.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';
import type { Logger } from './logger.js';

// A seam to make one atomic write's `rename` fail the way a Windows sharing violation does — the
// registry is open in another process, so the replace is refused until that handle closes. Keyed
// to the SOURCE path (unique per `atomicWriteFile` call), so arming it fails exactly one write and
// all of its retries while every other write proceeds normally. Disarmed except in the test that
// needs it, so every other test here sees the real `rename`.
const renameFault = vi.hoisted(() => ({ armed: false, source: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: ((from: string, to: string): Promise<void> => {
      if (renameFault.armed) {
        if (renameFault.source === '') renameFault.source = String(from);
        if (renameFault.source === String(from)) {
          const err: NodeJS.ErrnoException = new Error('EPERM: operation not permitted, rename');
          err.code = 'EPERM';
          return Promise.reject(err);
        }
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];

/** One line the engine logged, flattened enough to assert on. */
interface LogLine {
  level: 'debug' | 'info' | 'warn' | 'error';
  obj: unknown;
  msg: string | undefined;
}

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  refresh: ReturnType<typeof vi.fn>;
  /** The injected authorization-code exchange (reauth). Defaults to a login for account 'A'. */
  exchange: ReturnType<typeof vi.fn>;
  credStore: CredentialStore;
  vault: Vault;
  intent: IntentStore;
  setNow: (n: number) => void;
  /** Everything the engine logged, in order — the only place a best-effort repair can report
   *  that it failed, since by contract it does not fail its caller. */
  logs: LogLine[];
}

async function harness(refreshImpl?: RefreshFn, exchangeImpl?: ExchangeFn): Promise<Harness> {
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
  // Default: a successful re-login as A, with a fresh token pair and A's own identity — the
  // "user logged back into the right account" case every reauth test varies from.
  const defaultExchange: ExchangeFn = () =>
    Promise.resolve({
      claudeAiOauth: oauth('reauthed-A', now + HOUR, 'reauthed-r-A'),
      oauthAccount: { accountUuid: 'uuid-A', emailAddress: 'A@x.com' },
    });
  const exchange = vi.fn(exchangeImpl ?? defaultExchange);

  const logs: LogLine[] = [];
  const record =
    (level: LogLine['level']) =>
    (obj: unknown, msg?: string): void => {
      logs.push({ level, obj, msg });
    };
  const logger: Logger = {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
  };

  const engine = new SwitchEngine({
    paths,
    protector,
    refresh: refresh,
    exchange: exchange,
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    logger,
  });

  return {
    paths,
    engine,
    refresh,
    exchange,
    credStore: new CredentialStore(paths),
    vault: new Vault(paths.vaultDir, protector, clock),
    intent: new IntentStore(paths.vaultDir),
    setNow: (n) => (now = n),
    logs,
  };
}

afterEach(async () => {
  renameFault.armed = false;
  renameFault.source = '';
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

/** Every line of `switch-audit.jsonl`, parsed — the ground truth `origin` threading writes to. */
async function readAuditLines(paths: Paths): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(paths.vaultDir, 'switch-audit.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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

    // Simulate a `claude` run under CLAUDE_CONFIG_DIR=<dir> leaving BOTH files there.
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

describe('keychain-delta capture (darwin flows)', () => {
  /**
   * Simulate the throwaway window's leftovers on darwin: the NEW login lands in the SHARED
   * live channel (the mac CLI writes its one Keychain item regardless of CLAUDE_CONFIG_DIR —
   * the harness's file channel plays that role here; the engine methods are channel-blind),
   * and the transient dir carries only `.claude.json` identity, never `.credentials.json`.
   */
  async function windowLogin(h: Harness, access: string, uuid = 'uuid-' + access) {
    const dir = join(h.paths.claudeDir, '..', 'kc-window-' + access);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${access}@x.com` } }),
    );
    await h.credStore.writeLiveCredentials(oauth(access, NOW + 10 * HOUR));
    return dir;
  }

  it('captureFromKeychainDelta vaults the new login and restores the prior live one', async () => {
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = await windowLogin(h, 'FRESH');

    const account = await h.engine.captureFromKeychainDelta('fresh', dir, prior);

    expect(account.label).toBe('fresh');
    expect(account.accountUuid).toBe('uuid-FRESH');
    expect((await h.vault.readBundle(account.id)).claudeAiOauth.accessToken).toBe('FRESH');
    // The pre-window login is live again, and the active id never moved.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('captureFromKeychainDelta refuses when the live login never changed', async () => {
    const h = await harness();
    await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = join(h.paths.claudeDir, '..', 'kc-window-none');
    await mkdir(dir, { recursive: true });
    await expect(h.engine.captureFromKeychainDelta('x', dir, prior)).rejects.toMatchObject({
      code: 'no_capture_login',
    });
  });

  it('captureFromKeychainDelta records the captured account active when nothing was logged in before', async () => {
    const h = await harness();
    const dir = await windowLogin(h, 'FIRST');
    const account = await h.engine.captureFromKeychainDelta('first', dir, undefined);
    expect(await h.engine.getActiveId()).toBe(account.id);
    // No prior to restore: the captured login IS the live one.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('FIRST');
  });

  it('captureFromKeychainDelta restores the prior login even when vaulting fails', async () => {
    const h = await harness();
    await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = await windowLogin(h, 'FRESH');
    // A protector whose seal always fails makes vault.addAccount throw AFTER the window
    // already overwrote the live login — the restore must still happen on that path.
    const failing = new SwitchEngine({
      paths: h.paths,
      protector: {
        protect: () => Promise.reject(new Error('keychain sealed')),
        unprotect: () => Promise.reject(new Error('keychain sealed')),
      },
      lockOptions: { timeoutMs: 2000, pollMs: 10 },
    });
    await expect(failing.captureFromKeychainDelta('fresh', dir, prior)).rejects.toThrow(
      'keychain sealed',
    );
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
  });

  it('reloginFromKeychainDelta overwrites in place and restores the prior live login', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = await windowLogin(h, 'B2', 'uuid-B');

    const updated = await h.engine.reloginFromKeychainDelta(accountB.id, dir, prior);

    expect(updated.id).toBe(accountB.id);
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.accessToken).toBe('B2');
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('reloginFromKeychainDelta restores the prior login when the identity guard trips', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = await windowLogin(h, 'C', 'uuid-C');

    await expect(h.engine.reloginFromKeychainDelta(accountB.id, dir, prior)).rejects.toMatchObject({
      code: 'relogin_identity_mismatch',
    });
    // The wrong-account login is NOT left live, and B's vault entry is untouched.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.accessToken).toBe('B');
  });

  it('reloginFromKeychainDelta refuses when the live login never changed', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    const prior = await h.engine.readLiveOauth();
    const dir = join(h.paths.claudeDir, '..', 'kc-window-samey');
    await mkdir(dir, { recursive: true });
    await expect(h.engine.reloginFromKeychainDelta(accountB.id, dir, prior)).rejects.toMatchObject({
      code: 'no_capture_login',
    });
  });
});

describe('reloginFromConfigDir', () => {
  /** A bundle whose account uuid is set explicitly, so a test can make the existing account and
   *  the captured login share (or deliberately NOT share) an identity. */
  function bundleWithUuid(access: string, uuid: string, expiresAt: number): CredentialBundle {
    return {
      claudeAiOauth: oauth(access, expiresAt),
      oauthAccount: { accountUuid: uuid, emailAddress: `${access}@x.com` },
    };
  }

  /** Write a transient-config-dir login (what a `claude` run under CLAUDE_CONFIG_DIR leaves). */
  async function writeCapture(h: Harness, dir: string, bundle: CredentialBundle): Promise<void> {
    await mkdir(dir, { recursive: true });
    const store = new CredentialStore({
      claudeDir: dir,
      credentialsPath: join(dir, '.credentials.json'),
      claudeJsonPath: join(dir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials(bundle.claudeAiOauth);
    await store.writeOauthAccount(bundle.oauthAccount!);
  }

  it('rewrites the SAME account id in place and clears quarantine (attribution preserved)', async () => {
    const h = await harness();
    const existing = await h.engine.addAccount(
      'work',
      bundleWithUuid('OLD', 'uuid-work', NOW + HOUR),
    );
    await h.vault.quarantine(existing.id, 'refresh token died');

    const captureDir = join(h.paths.claudeDir, '..', 'relogin-capture');
    await writeCapture(h, captureDir, bundleWithUuid('NEW', 'uuid-work', NOW + 10 * HOUR));

    const result = await h.engine.reloginFromConfigDir(existing.id, captureDir);

    // The id is preserved — every activation_intervals / usage_snapshots row keyed to it stays
    // valid, which is the whole reason this verb exists instead of add --fresh.
    expect(result.account.id).toBe(existing.id);
    expect(result.account.quarantined).toBe(false);
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('NEW');
    // Still exactly one account — no new id was minted.
    expect(await h.engine.listAccounts()).toHaveLength(1);
    // The account was never the live one, so there were no live files to heal.
    expect(result.healedLiveLogin).toBe(false);
  });

  it('also rewrites the live files when the re-logged account is the LIVE one', async () => {
    // The state this exists for: the live account's grant dies (the CLI reports an expired
    // login), so the user re-logs THAT account. Repairing only the vault leaves the dead token
    // in the live files — the listing says healthy while every session keeps failing auth.
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);
    // The daemon quarantines a dying active account (invalid_grant on refresh) — model that too
    // so the test proves quarantine and live state heal together.
    await h.vault.quarantine(accountA.id, 'refresh token died');

    const captureDir = join(h.paths.claudeDir, '..', 'live-relogin');
    await writeCapture(h, captureDir, {
      claudeAiOauth: oauth('NEW-A', NOW + 10 * HOUR),
      oauthAccount: { accountUuid: 'uuid-A', emailAddress: 'A@x.com' },
    });

    const result = await h.engine.reloginFromConfigDir(accountA.id, captureDir);

    expect(result.healedLiveLogin).toBe(true);
    expect(result.account.quarantined).toBe(false);
    // Live credentials AND identity now carry the fresh grant — a running/new session
    // authenticates without any switch.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('NEW-A');
    expect((await h.credStore.readOauthAccount())?.accountUuid).toBe('uuid-A');
    // Vault and live agree, so the next switch has no rotation to adopt.
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.accessToken).toBe('NEW-A');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('leaves the live files alone when a DIFFERENT account is live', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);

    const captureDir = join(h.paths.claudeDir, '..', 'idle-relogin');
    await writeCapture(h, captureDir, {
      claudeAiOauth: oauth('NEW-B', NOW + 10 * HOUR),
      oauthAccount: { accountUuid: 'uuid-B', emailAddress: 'B@x.com' },
    });

    const result = await h.engine.reloginFromConfigDir(accountB.id, captureDir);

    expect(result.healedLiveLogin).toBe(false);
    // A's live login is untouched; only B's vault entry changed.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    expect((await h.credStore.readOauthAccount())?.accountUuid).toBe('uuid-A');
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.accessToken).toBe('NEW-B');
  });

  it('refuses (and changes nothing) when the captured login is a DIFFERENT account', async () => {
    const h = await harness();
    const existing = await h.engine.addAccount(
      'work',
      bundleWithUuid('OLD', 'uuid-work', NOW + HOUR),
    );
    await h.vault.quarantine(existing.id, 'refresh token died');

    const captureDir = join(h.paths.claudeDir, '..', 'wrong-account');
    await writeCapture(
      h,
      captureDir,
      bundleWithUuid('WRONG', 'uuid-someone-else', NOW + 10 * HOUR),
    );

    await expect(h.engine.reloginFromConfigDir(existing.id, captureDir)).rejects.toBeInstanceOf(
      RefreshError,
    );
    // The vault bundle and quarantine flag are untouched — a wrong-account capture must never
    // corrupt the entry it was meant to heal.
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('OLD');
    expect((await h.engine.listAccounts())[0]?.quarantined).toBe(true);
  });

  it('refuses when the transient dir has no credentials (login never completed)', async () => {
    const h = await harness();
    const existing = await h.engine.addAccount(
      'work',
      bundleWithUuid('OLD', 'uuid-work', NOW + HOUR),
    );
    const emptyDir = join(h.paths.claudeDir, '..', 'relogin-empty');
    await mkdir(emptyDir, { recursive: true });
    await expect(h.engine.reloginFromConfigDir(existing.id, emptyDir)).rejects.toBeInstanceOf(
      RefreshError,
    );
  });

  it('refuses for an unknown account id', async () => {
    const h = await harness();
    const someDir = join(h.paths.claudeDir, '..', 'unused-capture');
    await mkdir(someDir, { recursive: true });
    await expect(h.engine.reloginFromConfigDir('no-such-id', someDir)).rejects.toBeInstanceOf(
      UnknownAccountError,
    );
  });
});

describe('reauthenticate (authorization-code re-login)', () => {
  function bundleWithUuid(access: string, uuid: string, expiresAt: number): CredentialBundle {
    return {
      claudeAiOauth: oauth(access, expiresAt),
      oauthAccount: { accountUuid: uuid, emailAddress: `${access}@x.com` },
    };
  }

  const params = { code: 'the-code', state: 'st-1', verifier: 'ver-1' };

  it('rewrites the SAME account id in place and clears quarantine (attribution preserved)', async () => {
    const h = await harness();
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));
    await h.vault.quarantine(existing.id, 'refresh token died');

    const { account, identityVerified } = await h.engine.reauthenticate(existing.id, params);

    expect(account.id).toBe(existing.id);
    expect(account.quarantined).toBe(false);
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('reauthed-A');
    expect(await h.engine.listAccounts()).toHaveLength(1);
    // Both sides reported a uuid and they matched, so the guard genuinely ran.
    expect(identityVerified).toBe(true);
    // The exchange got exactly the code/state/verifier the caller held — the verifier is the
    // caller's secret and the engine must not substitute or drop it.
    expect(h.exchange).toHaveBeenCalledWith(params, expect.anything());
  });

  it('re-logs in a HEALTHY account too (rotation is a legitimate use, like relogin)', async () => {
    const h = await harness();
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));

    const { account } = await h.engine.reauthenticate(existing.id, params);

    expect(account.quarantined).toBe(false);
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('reauthed-A');
  });

  it('also rewrites the live files when the re-authed account is the LIVE one', async () => {
    // The case that motivates the whole verb: the LIVE account's grant died. Repairing only the
    // vault would leave every running CLI session failing auth while the registry calls the
    // account healthy. Same heal (and same honest report) `reloginFromConfigDir` performs.
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);

    const { healedLiveLogin } = await h.engine.reauthenticate(accountA.id, params);

    expect(healedLiveLogin).toBe(true);
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('reauthed-A');
    expect((await h.credStore.readOauthAccount())?.accountUuid).toBe('uuid-A');
  });

  it('leaves the live files alone when a DIFFERENT account is live', async () => {
    // Re-authing a stored-but-not-live account must not disturb whoever holds the live seat.
    // The exchange returns B's own identity, or the attribution guard would (correctly) refuse.
    const bLogin: ExchangeFn = () =>
      Promise.resolve({
        claudeAiOauth: oauth('reauthed-B', NOW + HOUR, 'r-reauthed-B'),
        oauthAccount: { accountUuid: 'uuid-B', emailAddress: 'B@x.com' },
      });
    const h = await harness(undefined, bLogin);
    const { accountB } = await seedAActiveWithB(h);

    const { healedLiveLogin } = await h.engine.reauthenticate(accountB.id, params);

    expect(healedLiveLogin).toBe(false);
    // A still holds the live seat, untouched.
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    // B's vault entry did get the fresh grant — the heal is the only part that was skipped.
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.accessToken).toBe('reauthed-B');
  });

  it('refuses (and changes nothing) when the login was a DIFFERENT account', async () => {
    const wrongAccount: ExchangeFn = () =>
      Promise.resolve({
        claudeAiOauth: oauth('WRONG', NOW + HOUR, 'r-WRONG'),
        oauthAccount: { accountUuid: 'uuid-someone-else', emailAddress: 'other@x.com' },
      });
    const h = await harness(undefined, wrongAccount);
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));
    await h.vault.quarantine(existing.id, 'refresh token died');

    const err = await h.engine.reauthenticate(existing.id, params).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RefreshError);
    expect((err as RefreshError).code).toBe('relogin_identity_mismatch');
    // Nothing written: a wrong-account login must never corrupt the entry it meant to heal, and
    // must not lift the quarantine either.
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('OLD');
    expect((await h.engine.listAccounts())[0]?.quarantined).toBe(true);
  });

  it('reports identityVerified:false when the login response names no account', async () => {
    // The check is structurally skipped here (nothing to compare), and callers must be able to
    // tell that apart from a check that passed — otherwise the phone claims a verification that
    // never happened.
    const anonymous: ExchangeFn = () =>
      Promise.resolve({ claudeAiOauth: oauth('NEW', NOW + HOUR, 'r-NEW') });
    const h = await harness(undefined, anonymous);
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));

    const { identityVerified } = await h.engine.reauthenticate(existing.id, params);

    expect(identityVerified).toBe(false);
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('NEW');
  });

  it('never carries the OLD identity block forward when the login reports none', async () => {
    // The stale-identity-block failure class: a block that survives a credential replacement can
    // shadow the new login forever (a MISSING block self-heals; a stale one does not). The bundle
    // must therefore describe only the fresh login.
    const anonymous: ExchangeFn = () =>
      Promise.resolve({ claudeAiOauth: oauth('NEW', NOW + HOUR, 'r-NEW') });
    const h = await harness(undefined, anonymous);
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));

    await h.engine.reauthenticate(existing.id, params);

    expect((await h.vault.readBundle(existing.id)).oauthAccount).toBeUndefined();
  });

  /** A fully-described account: the plan facts a host capture knows and a code exchange does
   *  not, spread across both halves of the bundle exactly as the live files carry them. */
  function richBundle(access: string, uuid: string): CredentialBundle {
    return {
      claudeAiOauth: {
        ...oauth(access, NOW + HOUR),
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      oauthAccount: {
        accountUuid: uuid,
        emailAddress: 'old@x.com',
        organizationUuid: 'org-old',
        organizationName: 'Old Org',
        organizationRateLimitTier: 'default_claude_max_20x',
        billingType: 'stripe_subscription',
        subscriptionCreatedAt: '2024-01-05T00:00:00Z',
        claudeCodeTrialEndsAt: '2024-02-05T00:00:00Z',
      },
    };
  }

  it('keeps the plan and billing metadata the exchange never reports', async () => {
    // The exchange answers with tokens and four identity fields and nothing else. Writing that
    // answer verbatim would blank every plan field on the registry row, demoting a Max account
    // to an unknown plan for anything that weights capacity by it.
    const h = await harness();
    const existing = await h.engine.addAccount('A', richBundle('OLD', 'uuid-A'));

    const { account } = await h.engine.reauthenticate(existing.id, params);

    expect(account).toMatchObject({
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
      organizationRateLimitTier: 'default_claude_max_20x',
      billingType: 'stripe_subscription',
      subscriptionCreatedAt: '2024-01-05T00:00:00Z',
      claudeCodeTrialEndsAt: '2024-02-05T00:00:00Z',
    });
    // The bundle itself keeps them too, so the next row recompute has something to read.
    const bundle = await h.vault.readBundle(existing.id);
    expect(bundle.claudeAiOauth.accessToken).toBe('reauthed-A');
    expect(bundle.claudeAiOauth.subscriptionType).toBe('max');
    expect(bundle.oauthAccount?.billingType).toBe('stripe_subscription');
  });

  it('still applies the identity fields the exchange DID report', async () => {
    // The other half of the merge: preserving the stored block must not freeze it. A renamed
    // address or a moved organization is a legitimately changed fact and has to land.
    const moved: ExchangeFn = () =>
      Promise.resolve({
        claudeAiOauth: oauth('reauthed-A', NOW + HOUR, 'reauthed-r-A'),
        oauthAccount: {
          accountUuid: 'uuid-A',
          emailAddress: 'new@x.com',
          organizationUuid: 'org-new',
          organizationName: 'New Org',
        },
      });
    const h = await harness(undefined, moved);
    const existing = await h.engine.addAccount('A', richBundle('OLD', 'uuid-A'));

    const { account } = await h.engine.reauthenticate(existing.id, params);

    expect(account.emailAddress).toBe('new@x.com');
    expect(account.organizationUuid).toBe('org-new');
    expect((await h.vault.readBundle(existing.id)).oauthAccount?.organizationName).toBe('New Org');
    // ...while the fields it stayed silent about are still the stored ones.
    expect(account.billingType).toBe('stripe_subscription');
  });

  it('completes on an UNREADABLE stored bundle, keeping the exchange data alone', async () => {
    // Losing the metadata is cosmetic; refusing to persist a rotated single-use token is not.
    // An unreadable blob therefore degrades the merge instead of failing the re-login.
    const h = await harness();
    const existing = await h.engine.addAccount('A', richBundle('OLD', 'uuid-A'));
    await writeFile(join(h.paths.vaultDir, existing.id, 'cred.enc'), 'not-a-bundle', 'utf8');

    const { account } = await h.engine.reauthenticate(existing.id, params);

    const bundle = await h.vault.readBundle(existing.id);
    expect(bundle.claudeAiOauth.accessToken).toBe('reauthed-A');
    expect(bundle.claudeAiOauth.subscriptionType).toBeUndefined();
    expect(account.emailAddress).toBe('A@x.com');
    expect(h.logs.some((l) => l.level === 'warn' && l.msg?.includes('stored bundle'))).toBe(true);
  });

  it('propagates an exchange failure WITHOUT quarantining a healthy account', async () => {
    // The load-bearing negative: only the refresh path may quarantine. A bad paste says nothing
    // about the stored refresh token, so it must not mark the account dead.
    const rejected: ExchangeFn = () =>
      Promise.reject(new RefreshError('authorization code rejected', 'invalid_code'));
    const h = await harness(undefined, rejected);
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));

    await expect(h.engine.reauthenticate(existing.id, params)).rejects.toBeInstanceOf(RefreshError);

    expect((await h.engine.listAccounts())[0]?.quarantined).toBe(false);
    expect((await h.vault.readBundle(existing.id)).claudeAiOauth.accessToken).toBe('OLD');
  });

  it('propagates an exchange failure leaving an ALREADY quarantined account quarantined', async () => {
    const rejected: ExchangeFn = () =>
      Promise.reject(new RefreshError('authorization code rejected', 'invalid_code'));
    const h = await harness(undefined, rejected);
    const existing = await h.engine.addAccount('A', bundleWithUuid('OLD', 'uuid-A', NOW + HOUR));
    await h.vault.quarantine(existing.id, 'refresh token died');

    await expect(h.engine.reauthenticate(existing.id, params)).rejects.toBeInstanceOf(RefreshError);

    // Still quarantined: a failed recovery attempt must not silently look like a success.
    expect((await h.engine.listAccounts())[0]?.quarantined).toBe(true);
  });

  it('refuses for an unknown account id, before ever exchanging the code', async () => {
    const h = await harness();
    await expect(h.engine.reauthenticate('no-such-id', params)).rejects.toBeInstanceOf(
      UnknownAccountError,
    );
    // The single-use code is not spent on a request that could never have been applied.
    expect(h.exchange).not.toHaveBeenCalled();
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

  it('stamps the audit entry with the caller-supplied origin/reason, defaulting to manual', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);

    await h.engine.activate(accountB.id); // no origin — every pre-existing call site
    h.setNow(NOW + 61_000); // past the cadence guard — this is a second, distinct hop
    await h.engine.activate(accountA.id, { origin: 'auto', reason: 'B is at 96% used' });

    const activations = (await readAuditLines(h.paths)).filter((l) => l.event === 'activated');
    expect(activations).toMatchObject([
      { toAccountId: accountB.id, origin: 'manual' },
      { toAccountId: accountA.id, origin: 'auto', detail: 'B is at 96% used' },
    ]);
  });

  it('refuses to activate a quarantined account', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    await h.vault.quarantine(accountB.id, 'invalid_grant');
    await expect(h.engine.activate(accountB.id)).rejects.toBeInstanceOf(QuarantineError);
  });
});

describe('derived account metadata is repaired from the stored bundle', () => {
  // The registry is a cache of what a bundle says, and the only thing that used to refresh it was
  // WRITING that bundle — an event tied to token rotation, not to metadata. So an account stored
  // by a build that captured fewer fields rendered "?" / "unknown" indefinitely, even though its
  // vaulted bundle had carried the answer since the day it was captured.
  const PLAN_TIER = 'default_claude_max_20x';
  const planBundle = (access: string, expiresAt: number): CredentialBundle => ({
    claudeAiOauth: { ...oauth(access, expiresAt), subscriptionType: 'max' },
    oauthAccount: {
      accountUuid: 'uuid-' + access,
      emailAddress: access + '@x.com',
      organizationRateLimitTier: PLAN_TIER,
      billingType: 'stripe_subscription',
      subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
    },
  });

  /** Rewrite the registry the way a build predating these fields left it on disk: derived keys
   *  absent, no revision stamp — while the encrypted bundles keep carrying the values. */
  async function degradeRegistry(paths: Paths): Promise<void> {
    const path = join(paths.vaultDir, 'accounts.json');
    const reg = JSON.parse(await readFile(path, 'utf8')) as {
      accounts: Record<string, unknown>[];
    };
    for (const account of reg.accounts) {
      delete account.metadataRev;
      delete account.organizationRateLimitTier;
      delete account.billingType;
      delete account.subscriptionCreatedAt;
    }
    await writeFile(path, JSON.stringify(reg, null, 2));
  }

  it('repairs the target during a switch that needs no token refresh', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);
    expect(await h.vault.getAccount(accountB.id)).not.toHaveProperty('organizationRateLimitTier');

    await h.engine.activate(accountB.id);

    // B's token was nowhere near expiry, so nothing rewrote its bundle — the row is repaired
    // from the copy the switch already had to decrypt.
    expect(h.refresh).not.toHaveBeenCalled();
    const b = await h.vault.getAccount(accountB.id);
    expect(b?.organizationRateLimitTier).toBe(PLAN_TIER);
    expect(b?.billingType).toBe('stripe_subscription');
    // The account NOT being switched to is untouched by the switch — that is what the sweep is
    // for, and asserting it keeps the two mechanisms from being confused for one another.
    expect(await h.vault.getAccount(accountA.id)).not.toHaveProperty('billingType');
  });

  it('sweeps every stale account once, then costs nothing', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountA.id, planBundle('A', NOW + 10 * HOUR));
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);

    expect(await h.engine.backfillAccountMetadata()).toBe(2);
    for (const id of [accountA.id, accountB.id]) {
      expect((await h.vault.getAccount(id))?.organizationRateLimitTier).toBe(PLAN_TIER);
    }
    // Stamped rows are skipped, so a listing does not pay for a decrypt on every run.
    expect(await h.engine.backfillAccountMetadata()).toBe(0);
  });

  it('skips an account whose bundle cannot be read instead of failing the sweep', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);
    // A missing blob is a real state (a half-removed account, a vault restored without it); one
    // unreadable account must not deny every other account its metadata.
    await rm(join(h.paths.vaultDir, accountA.id), { recursive: true, force: true });

    expect(await h.engine.backfillAccountMetadata()).toBe(1);
    expect((await h.vault.getAccount(accountB.id))?.organizationRateLimitTier).toBe(PLAN_TIER);
    expect(await h.vault.getAccount(accountA.id)).not.toHaveProperty('billingType');
  });

  it('backs a permanently unreadable row off, then retries it once the window passes', async () => {
    // Skipping an unreadable row without recording the attempt leaves it selected forever, so the
    // stale set never empties and every later listing takes the credential lock again. Recording
    // it must not become a tombstone either: the blob can come back.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountA.id, planBundle('A', NOW + 10 * HOUR));
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);
    // Keep A's blob so it can be put back the way a restored vault or a re-paired machine would —
    // out of band, without any write path running to heal the row as a side effect.
    const blobPath = join(h.paths.vaultDir, accountA.id, 'cred.enc');
    const blob = await readFile(blobPath, 'utf8');
    await rm(join(h.paths.vaultDir, accountA.id), { recursive: true, force: true });

    expect(await h.engine.backfillAccountMetadata()).toBe(1);

    // Even with the blob back, the row waits out its back-off rather than being retried per call.
    await mkdir(join(h.paths.vaultDir, accountA.id), { recursive: true });
    await writeFile(blobPath, blob);
    expect(await h.engine.backfillAccountMetadata()).toBe(0);
    expect(await h.vault.getAccount(accountA.id)).not.toHaveProperty('billingType');

    h.setNow(NOW + METADATA_BACKFILL_RETRY_MS);
    expect(await h.engine.backfillAccountMetadata()).toBe(1);
    expect((await h.vault.getAccount(accountA.id))?.organizationRateLimitTier).toBe(PLAN_TIER);
  });

  it('skips the sweep while another process holds the credential lock', async () => {
    // The sweep runs inside `cctl accounts list`, a read command. Queueing behind an in-flight
    // switch would make a listing sit out the whole acquire timeout for repair nobody asked for.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountA.id, planBundle('A', NOW + 10 * HOUR));
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);

    const held = await acquireLock(join(h.paths.vaultDir, '.lock'), () => NOW);
    try {
      expect(await h.engine.backfillAccountMetadata()).toBe(0);
      expect(await h.vault.getAccount(accountA.id)).not.toHaveProperty('billingType');
    } finally {
      held.release();
    }
    // Skipping gives nothing up — the rows are untouched, so the next call still repairs them.
    expect(await h.engine.backfillAccountMetadata()).toBe(2);
  });

  it('repairs the remaining rows after one of them cannot be written, and says which', async () => {
    // Every row is repaired by its own registry write, so a write that loses a race with a
    // concurrent reader says nothing about the next row. Stopping there would make which accounts
    // get repaired depend on their position in the list — and leave every row after the failure
    // waiting on a later sweep that hits the same wall in the same place.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.vault.writeBundle(accountA.id, planBundle('A', NOW + 10 * HOUR));
    await h.vault.writeBundle(accountB.id, planBundle('B', NOW + 10 * HOUR));
    await degradeRegistry(h.paths);

    // The sweep's first registry write is A's; nothing between arming and it renames anything.
    renameFault.armed = true;
    expect(await h.engine.backfillAccountMetadata()).toBe(1);
    renameFault.armed = false;

    expect(await h.vault.getAccount(accountA.id)).not.toHaveProperty('billingType');
    expect((await h.vault.getAccount(accountB.id))?.organizationRateLimitTier).toBe(PLAN_TIER);
    // A failed write must not leave its temp copy of the registry in the vault directory.
    const left = (await readdir(h.paths.vaultDir)).filter((f) => f.startsWith('.tmp-'));
    expect(left).toEqual([]);
    // Best-effort does not mean unaccountable: the row that could not be repaired is named.
    const warned = h.logs.filter((l) => l.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]?.obj).toMatchObject({ accountId: accountA.id });
    // A is untouched, so the next sweep repairs it too — nothing is permanently skipped.
    expect(await h.engine.backfillAccountMetadata()).toBe(1);
    expect((await h.vault.getAccount(accountA.id))?.organizationRateLimitTier).toBe(PLAN_TIER);
  });

  it('logs rather than throws when the sweep cannot run at all', async () => {
    // The sweep runs ahead of a read command the user DID ask for, so it must never fail that
    // command. Reporting best-effort by throwing forces every call site into a bare `catch`, and a
    // discarded reason makes a self-heal that has stopped healing look exactly like one with
    // nothing left to do.
    const h = await harness();
    await seedAActiveWithB(h);
    await writeFile(join(h.paths.vaultDir, 'accounts.json'), '{ not json');

    await expect(h.engine.backfillAccountMetadata()).resolves.toBe(0);
    expect(h.logs.filter((l) => l.level === 'warn')).toHaveLength(1);
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
    // now differs from the vault's stored copy for A. A real rotation issues a new access
    // token with a LATER expiry — the adoption guard reads that recency as proof of direction,
    // so every rotation simulated in this file extends `expiresAt` alongside the token swap.
    const liveA = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({
      ...liveA,
      refreshToken: 'cli-rotated',
      expiresAt: liveA.expiresAt + HOUR,
    });

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

  it('does not adopt a live token OLDER than the vault copy (in-place re-login left the vault newer)', async () => {
    // The inverse of rotation: the live account's grant died, the user re-logged it in place,
    // and only the vault took the fresh grant (say the live heal could not complete). The live
    // files still hold the dead token — different from the vault, but STALE. Adopting it would
    // overwrite the fresh grant with the dead one, and the refresh that follows would
    // quarantine the account the user just repaired.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);

    // Live: A's original token, now expired. Vault: A freshly re-logged (newer grant).
    const liveA = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({ ...liveA, expiresAt: NOW - HOUR });
    await h.vault.writeBundle(accountA.id, {
      claudeAiOauth: oauth('RELOGGED-A', NOW + 10 * HOUR, 'r-relogged-A'),
      oauthAccount: { accountUuid: 'uuid-A', emailAddress: 'A@x.com' },
    });

    const away = await h.engine.activate(accountB.id);
    expect(away.adoptedPreviousRotation).toBe(false);
    // The fresh re-login survived the switch.
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.accessToken).toBe('RELOGGED-A');

    // Switching back to A lands the fresh grant live, with no refresh (it is nowhere near
    // expiry) and no quarantine — the re-login actually recovered the account.
    h.setNow(NOW + 61_000);
    const back = await h.engine.activate(accountA.id);
    expect(back).toMatchObject({ ok: true, refreshed: false });
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('RELOGGED-A');
    expect((await h.engine.listAccounts()).find((a) => a.id === accountA.id)?.quarantined).toBe(
      false,
    );
    expect(h.refresh).not.toHaveBeenCalled();
  });

  it('adopts the rotated token without taking an unprovable live identity with it', async () => {
    // The live identity block is unvalidated and can be partial — here it reports no uuid, so
    // nothing proves it describes A. Adoption exists to save a rotated TOKEN; carrying that
    // block into A's bundle would re-identify A off evidence that does not name it, and the
    // identity in a bundle is what every attribution check downstream keys on.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    const liveA = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({
      ...liveA,
      refreshToken: 'cli-rotated',
      expiresAt: liveA.expiresAt + HOUR,
    });
    await h.credStore.writeOauthAccount({ emailAddress: 'stranger@x.com' });

    const result = await h.engine.activate(accountB.id);

    expect(result.adoptedPreviousRotation).toBe(true);
    const adopted = await h.vault.readBundle(accountA.id);
    expect(adopted.claudeAiOauth.refreshToken).toBe('cli-rotated');
    expect(adopted.oauthAccount?.accountUuid).toBe('uuid-A');
    expect(adopted.oauthAccount?.emailAddress).toBe('A@x.com');
    expect((await h.vault.getAccount(accountA.id))?.emailAddress).toBe('A@x.com');
  });
});

describe('activate — a target whose bundle carries no identity block', () => {
  /** Seed A live+active, plus an account captured CREDENTIALS-ONLY: no `~/.claude.json` block
   *  was readable when it was captured, so its bundle has no identity to make live. */
  async function seedBlocklessTarget(h: Harness) {
    const { accountA } = await seedAActiveWithB(h);
    const blockless = await h.engine.addAccount('C', {
      claudeAiOauth: oauth('C', NOW + 10 * HOUR),
    });
    return { accountA, blockless };
  }

  it('removes the live identity rather than leaving it naming the previous account', async () => {
    const h = await harness();
    const { blockless } = await seedBlocklessTarget(h);

    await h.engine.activate(blockless.id);

    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('C');
    // Leaving uuid-A here would be a live statement that A is logged in while C's token is.
    expect(await h.credStore.readOauthAccount()).toBeUndefined();
  });

  it('leaves nothing that reconciles the active account back to the previous one', async () => {
    const h = await harness();
    const { blockless } = await seedBlocklessTarget(h);
    await h.engine.activate(blockless.id);
    expect(await h.engine.getActiveId()).toBe(blockless.id);
  });

  it('adopts a later CLI rotation into the account that owns it, not the previous one', async () => {
    // The full cascade this guards: a live identity left naming A makes A the "previous active"
    // for the NEXT switch, and the adoption guard there compares that block against itself and
    // agrees — so the rotated token of whoever is really live lands in A's bundle, and only a
    // network ownership check much later can see it.
    const h = await harness();
    const { accountA, blockless } = await seedBlocklessTarget(h);
    await h.engine.activate(blockless.id);

    // The CLI rotates the live (C's) refresh token, then the operator switches back to A.
    const live = (await h.credStore.readLiveCredentials())!;
    await h.credStore.writeLiveCredentials({
      ...live,
      refreshToken: 'cli-rotated-C',
      expiresAt: live.expiresAt + HOUR,
    });
    h.setNow(NOW + 61_000);

    const result = await h.engine.activate(accountA.id);

    expect(result.adoptedPreviousRotation).toBe(true);
    expect((await h.vault.readBundle(blockless.id)).claudeAiOauth.refreshToken).toBe(
      'cli-rotated-C',
    );
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.refreshToken).toBe('r-A');
  });
});

describe('active-id reconciliation (external /login inside the Claude CLI)', () => {
  /** Simulate a `/login` done INSIDE the Claude CLI: the live credential + identity files
   *  change hands entirely outside this engine, so the registry is never told. */
  async function externalLogin(h: Harness, bundle: CredentialBundle): Promise<void> {
    await h.credStore.writeLiveCredentials(bundle.claudeAiOauth);
    await h.credStore.writeOauthAccount(bundle.oauthAccount!);
  }

  it('getActiveId follows the live login to the stored account that owns it', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);

    await externalLogin(h, bundleFor('B', NOW + 10 * HOUR));

    expect(await h.engine.getActiveId()).toBe(accountB.id);
    // The registry itself is NOT rewritten — reconciliation is a read-side judgment.
    expect(await h.vault.getActiveId()).toBe(accountA.id);
  });

  it('getActiveId returns null when the live login was never captured here', async () => {
    const h = await harness();
    await seedAActiveWithB(h);

    await externalLogin(h, bundleFor('STRANGER', NOW + 10 * HOUR));

    expect(await h.engine.getActiveId()).toBeNull();
  });

  it('getActiveId keeps the registry when a stale identity is contradicted by the live token', async () => {
    // The disk state this bug left behind: the identity block still names A while B's
    // credentials are live and the registry records B. The block is the only evidence pointing
    // at A, and the token it sits beside contradicts it — believing the block would hand B's
    // live token to A everywhere downstream.
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    await h.engine.activate(accountB.id);
    await h.credStore.writeOauthAccount({ accountUuid: 'uuid-A', emailAddress: 'A@x.com' });

    expect(await h.engine.getActiveId()).toBe(accountB.id);

    // A genuine /login as A rewrites the token as well, and then the block is believed again —
    // this must stay a reconcile-by-reading engine, not a registry-only one.
    await h.credStore.writeLiveCredentials(oauth('A-fresh', NOW + 10 * HOUR));
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('getActiveId falls back to the registry when no live identity is readable', async () => {
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);

    // ~/.claude.json lost its oauthAccount block — the registry is the best remaining evidence.
    await writeFile(h.paths.claudeJsonPath, JSON.stringify({ someOtherKey: true }));
    expect(await h.engine.getActiveId()).toBe(accountA.id);
    // Same for an outright corrupt file: degrade, never throw on a read path.
    await writeFile(h.paths.claudeJsonPath, 'not json at all');
    expect(await h.engine.getActiveId()).toBe(accountA.id);
  });

  it('refreshToken protects the ACTUALLY-live account after an external login', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    // The user /login'd as B in the CLI, which then rotated B's token: the vault copy is stale.
    // The rotation minted a new access token, so the live expiry is later than the vault's —
    // the recency the adoption guard requires before believing the live side is newer.
    const b = bundleFor('B', NOW + 11 * HOUR);
    await externalLogin(h, {
      ...b,
      claudeAiOauth: { ...b.claudeAiOauth, refreshToken: 'cli-rotated-B' },
    });

    const result = await h.engine.refreshToken(accountB.id);

    // Adopt-only, never a network refresh — consuming B's single-use refresh token here would
    // strand the live session the user is sitting in (the registry still names A, but A's
    // credentials are no longer the live ones).
    expect(result).toMatchObject({
      refreshed: false,
      skippedReason: 'active_account',
      adoptedLiveRotation: true,
    });
    expect(h.refresh).not.toHaveBeenCalled();
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.refreshToken).toBe(
      'cli-rotated-B',
    );
  });

  it('activate after an external login adopts the live rotation into the account that owns it', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    // As above: the rotation extends the live expiry past the vault copy's.
    const b = bundleFor('B', NOW + 11 * HOUR);
    await externalLogin(h, {
      ...b,
      claudeAiOauth: { ...b.claudeAiOauth, refreshToken: 'cli-rotated-B' },
    });

    // The registry still says A — but B owns the live token, so this is a heal of the live
    // account and the CLI's rotation must land in B's bundle, never A's.
    const result = await h.engine.activate(accountB.id);

    expect(result).toMatchObject({
      ok: true,
      activeAccountId: accountB.id,
      adoptedPreviousRotation: true,
    });
    expect((await h.vault.readBundle(accountB.id)).claudeAiOauth.refreshToken).toBe(
      'cli-rotated-B',
    );
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.refreshToken).toBe('r-A');
    // The committed switch heals the registry record.
    expect(await h.vault.getActiveId()).toBe(accountB.id);
  });

  it('never adopts live credentials into a bundle that provably belongs to someone else', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    // Corrupt-state seam: A's registry row still carries uuid-A, but its BUNDLE was replaced
    // by one with a different identity (e.g. a hand-restored backup). The live login (uuid-A,
    // rotated) reconciles to A by row — adoption must still refuse to write into a bundle
    // whose own identity disagrees.
    await h.vault.writeBundle(accountA.id, {
      claudeAiOauth: oauth('A2', NOW + 10 * HOUR),
      oauthAccount: { accountUuid: 'uuid-ELSE', emailAddress: 'a2@x.com' },
    });
    const liveA = bundleFor('A', NOW + 10 * HOUR);
    await externalLogin(h, {
      ...liveA,
      claudeAiOauth: { ...liveA.claudeAiOauth, refreshToken: 'cli-rotated' },
    });

    const result = await h.engine.activate(accountB.id);

    expect(result.adoptedPreviousRotation).toBe(false);
    expect((await h.vault.readBundle(accountA.id)).claudeAiOauth.refreshToken).toBe('r-A2');
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
    // recover()'s own audit entries are always origin 'recovery' — never the caller-supplied
    // origins `activate()` threads, since nothing here was a deliberate switch request.
    const recovered = (await readAuditLines(h.paths)).find((l) => l.event === 'recovered');
    expect(recovered).toMatchObject({ origin: 'recovery' });
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

  it('rolls forward a target with no identity block by clearing the stale one', async () => {
    // Roll-forward FINISHES the interrupted live write, and the write it finishes is now a
    // removal when the target has no block — skipping it would commit the switch on top of the
    // previous account's identity, which is the state this engine refuses to leave behind.
    const h = await harness();
    const { accountA } = await seedAActiveWithB(h);
    const blockless = await h.engine.addAccount('C', {
      claudeAiOauth: oauth('C', NOW + 10 * HOUR),
    });
    await h.credStore.writeLiveCredentials(oauth('C', NOW + 10 * HOUR));
    await h.intent.write({
      phase: 'written',
      targetId: blockless.id,
      prevActiveId: accountA.id,
      hasRollback: false,
      startedAtMs: NOW,
    });

    expect((await h.engine.recover()).action).toBe('rolled_forward');
    expect(await h.engine.getActiveId()).toBe(blockless.id);
    expect(await h.credStore.readOauthAccount()).toBeUndefined();
  });

  it('rolls back the live identity too, removing one the snapshot never carried', async () => {
    const h = await harness();
    const { accountA, accountB } = await seedAActiveWithB(h);
    // The live files had no identity block when the switch began, so the snapshot has none
    // either; the switch then wrote B's identity before its credential write went wrong.
    const a = await h.vault.readBundle(accountA.id);
    await h.vault.writeRollback({ claudeAiOauth: a.claudeAiOauth });
    await h.credStore.writeLiveCredentials(oauth('CORRUPT', NOW + HOUR));
    await h.credStore.writeOauthAccount({ accountUuid: 'uuid-B', emailAddress: 'B@x.com' });
    await h.intent.write({
      phase: 'written',
      targetId: accountB.id,
      prevActiveId: accountA.id,
      hasRollback: true,
      startedAtMs: NOW,
    });

    expect((await h.engine.recover()).action).toBe('rolled_back');
    expect((await h.credStore.readLiveCredentials())?.accessToken).toBe('A');
    // Restoring A's credentials under B's identity would recreate the exact mismatch the
    // forward path refuses to create.
    expect(await h.credStore.readOauthAccount()).toBeUndefined();
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
    await h.credStore.writeLiveCredentials({
      ...liveA,
      refreshToken: 'cli-rotated',
      expiresAt: liveA.expiresAt + HOUR,
    });

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

describe('setAutoSwitchExcluded', () => {
  it('round-trips the flag through the registry and clears it again', async () => {
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    const flagOf = async () =>
      (await h.engine.listAccounts()).find((a) => a.id === accountB.id)?.autoSwitchExcluded;

    expect(await flagOf()).toBeUndefined();
    await h.engine.setAutoSwitchExcluded(accountB.id, true);
    expect(await flagOf()).toBe(true);
    await h.engine.setAutoSwitchExcluded(accountB.id, false);
    expect(await flagOf()).toBeUndefined();
  });

  it('never leaves the account unusable — an excluded account still activates', async () => {
    // Exclusion governs where AUTO-switch may go; a deliberate switch must be unaffected.
    const h = await harness();
    const { accountB } = await seedAActiveWithB(h);
    await h.engine.setAutoSwitchExcluded(accountB.id, true);
    await expect(h.engine.activate(accountB.id)).resolves.toMatchObject({ ok: true });
  });

  it('rejects an unknown account id', async () => {
    const h = await harness();
    await expect(h.engine.setAutoSwitchExcluded('nope', true)).rejects.toBeInstanceOf(
      UnknownAccountError,
    );
  });
});

describe('registry mutators serialize against the credential lock', () => {
  /** An engine on `paths` whose registry mutators give up quickly under contention, so the test
   *  observes the lock-contention error without waiting out a long timeout. */
  function shortLockEngine(paths: Paths): SwitchEngine {
    return new SwitchEngine({
      paths,
      protector: new InsecurePassthroughProtector(),
      refresh: vi.fn(),
      clock: Date.now,
      lockOptions: { timeoutMs: 150, pollMs: 10 },
    });
  }

  /** Hold the engine's credential lock (as a concurrent process would), run `call`, and require
   *  it to fail with LockTimeoutError — proving the mutator waits on the same mutex activate()
   *  uses instead of racing straight into an unlocked registry read-modify-write. */
  async function expectBlockedWhileLocked(
    paths: Paths,
    call: (engine: SwitchEngine) => Promise<unknown>,
  ): Promise<void> {
    const engine = shortLockEngine(paths);
    const lock = await acquireLock(join(paths.vaultDir, '.lock'), Date.now, {});
    try {
      await expect(call(engine)).rejects.toBeInstanceOf(LockTimeoutError);
    } finally {
      lock.release();
    }
  }

  it('addAccount waits on the lock', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) => e.addAccount('X', bundleFor('X', NOW + HOUR)));
  });

  it('removeAccount waits on the lock', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) => e.removeAccount('any-id'));
  });

  it('clearQuarantine waits on the lock', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) => e.clearQuarantine('any-id'));
  });

  it('setAutoSwitchExcluded waits on the lock', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) => e.setAutoSwitchExcluded('any-id', true));
  });

  it('captureCurrentLogin waits on the lock (the add + setActive path)', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) => e.captureCurrentLogin('X'));
  });

  it('captureFromConfigDir waits on the lock', async () => {
    const h = await harness();
    // Seed a transient capture dir so the method reaches its registry write rather than failing
    // earlier — though it blocks on lock acquisition before it even reads the dir.
    const captureDir = join(h.paths.claudeDir, '..', 'locked-capture');
    await mkdir(captureDir, { recursive: true });
    const store = new CredentialStore({
      claudeDir: captureDir,
      credentialsPath: join(captureDir, '.credentials.json'),
      claudeJsonPath: join(captureDir, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    const fresh = bundleFor('FRESH', NOW + 10 * HOUR);
    await store.writeLiveCredentials(fresh.claudeAiOauth);
    await store.writeOauthAccount(fresh.oauthAccount!);
    await expectBlockedWhileLocked(h.paths, (e) => e.captureFromConfigDir('fresh', captureDir));
  });

  it('reloginFromConfigDir waits on the lock', async () => {
    const h = await harness();
    await expectBlockedWhileLocked(h.paths, (e) =>
      e.reloginFromConfigDir('any-id', join(h.paths.claudeDir, '..', 'relogin-unused')),
    );
  });

  it('a mutator succeeds once the lock is released', async () => {
    const h = await harness();
    const engine = shortLockEngine(h.paths);
    const lock = await acquireLock(join(h.paths.vaultDir, '.lock'), Date.now, {});
    // While held, the add is refused; after release it goes through and commits to the registry.
    await expect(engine.addAccount('X', bundleFor('X', NOW + HOUR))).rejects.toBeInstanceOf(
      LockTimeoutError,
    );
    lock.release();
    const account = await engine.addAccount('X', bundleFor('X', NOW + HOUR));
    expect((await engine.listAccounts()).map((a) => a.id)).toContain(account.id);
  });
});
