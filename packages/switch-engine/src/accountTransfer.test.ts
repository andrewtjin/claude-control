// The engine side of moving accounts between machines: reading the freshest credentials of an
// account (exportBundle), storing an account that comes without credentials (addPendingAccount),
// and writing brought credentials over a stored account only when they are the better copy
// (importBundle).

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { Vault } from './vault.js';
import { sandboxPaths, type Paths } from './paths.js';
import { RefreshError, UnknownAccountError, VaultError } from './errors.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Harness {
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  live: CredentialStore;
}

/** A sandboxed engine over a fresh vault, with a refresh that would show up in any token it
 *  touched (none of these verbs may refresh over the network). */
async function harness(): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), 'ce-transfer-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const clock = (): number => NOW;
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) =>
      Promise.resolve({ ...cur, accessToken: 'NETWORK-' + cur.accessToken, expiresAt: NOW + HOUR }),
    clock,
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
  });
  return {
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector, clock),
    live: new CredentialStore(paths),
  };
}

function bundle(
  access: string,
  uuid: string,
  expiresAt: number,
  refresh = 'r-' + access,
): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: refresh, expiresAt },
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com` },
  };
}

/** Plant a later rotation of `uuid`'s login in the global live files, as a running session
 *  refreshing it would. */
async function rotateLive(
  h: Harness,
  access: string,
  uuid: string,
  expiresAt: number,
): Promise<void> {
  await h.live.writeLiveCredentials({
    accessToken: access,
    refreshToken: 'r-' + access,
    expiresAt,
  });
  await h.live.writeOauthAccount({ accountUuid: uuid, emailAddress: `${uuid}@x.com` });
}

describe('exportBundle', () => {
  it('returns the stored credentials of an account that is not live', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('A1');
    expect(out.oauthAccount?.accountUuid).toBe('u-work');
  });

  it('adopts a live rotation first, so the copy does not carry a spent refresh token', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    await rotateLive(h, 'A2', 'u-work', NOW + 5 * HOUR);

    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('A2');
    expect(out.claudeAiOauth.refreshToken).toBe('r-A2');
    // Adopted into the vault too, not just handed out.
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A2');
  });

  it('never refreshes over the network, even an expired token', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('OLD', 'u-work', NOW - HOUR));
    const out = await h.engine.exportBundle(a.id);
    expect(out.claudeAiOauth.accessToken).toBe('OLD');
  });

  it('refuses an unknown account', async () => {
    const h = await harness();
    await expect(h.engine.exportBundle('nope')).rejects.toBeInstanceOf(UnknownAccountError);
  });
});

describe('addPendingAccount', () => {
  it('stores a quarantined row with its identity and no bundle', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', {
      accountUuid: 'u-home',
      emailAddress: 'home@x.com',
    });
    expect(row).toMatchObject({
      label: 'home',
      accountUuid: 'u-home',
      emailAddress: 'home@x.com',
      quarantined: true,
    });
    expect(row.quarantineReason).toContain('cctl accounts relogin');
    expect(existsSync(join(h.paths.vaultDir, row.id, 'cred.enc'))).toBe(false);
    await expect(h.vault.readBundle(row.id)).rejects.toBeInstanceOf(VaultError);
    // Never a switch target while it has no login.
    await expect(h.engine.activate(row.id)).rejects.toThrow(/quarantined/);
  });

  it('refuses a label or a login already stored', async () => {
    const h = await harness();
    await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await expect(h.engine.addPendingAccount('WORK', { accountUuid: 'u-other' })).rejects.toThrow(
      /already refers to/,
    );
    await expect(h.engine.addPendingAccount('other', { accountUuid: 'u-work' })).rejects.toThrow(
      /already stored/,
    );
  });

  it('is filled by a re-login of the same account, and refuses a different one', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', { accountUuid: 'u-home' });
    const capture = join(h.paths.claudeDir, '..', 'capture');
    await mkdir(capture, { recursive: true });
    const store = new CredentialStore({
      claudeDir: capture,
      credentialsPath: join(capture, '.credentials.json'),
      claudeJsonPath: join(capture, '.claude.json'),
      vaultDir: h.paths.vaultDir,
    });
    await store.writeLiveCredentials(bundle('X', 'u-intruder', NOW + HOUR).claudeAiOauth);
    await store.writeOauthAccount({ accountUuid: 'u-intruder' });
    await expect(h.engine.reloginFromConfigDir(row.id, capture)).rejects.toBeInstanceOf(
      RefreshError,
    );

    await store.writeLiveCredentials(bundle('H1', 'u-home', NOW + HOUR).claudeAiOauth);
    await store.writeOauthAccount({ accountUuid: 'u-home', emailAddress: 'home@x.com' });
    const { account } = await h.engine.reloginFromConfigDir(row.id, capture);
    expect(account.id).toBe(row.id);
    expect(account.quarantined).toBe(false);
    expect((await h.vault.readBundle(row.id)).claudeAiOauth.accessToken).toBe('H1');
  });
});

describe('importBundle', () => {
  it('replaces the stored credentials with newer ones, keeping the id', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res).toEqual({ replaced: true, reason: 'newer', healedLiveLogin: false });
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('B1');
    expect((await h.engine.listAllAccounts()).map((x) => x.id)).toEqual([a.id]);
  });

  it('keeps stored credentials that are as new or newer, writing nothing', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + 3 * HOUR));
    for (const expiresAt of [NOW + HOUR, NOW + 3 * HOUR]) {
      const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', expiresAt));
      expect(res).toEqual({ replaced: false, reason: 'stored_newer', healedLiveLogin: false });
    }
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A1');
  });

  it('replaces the credentials of a quarantined account even when they are older, and lifts the quarantine', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + 3 * HOUR));
    await h.vault.quarantine(a.id, 'refresh token died');
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + HOUR));
    expect(res.replaced).toBe(true);
    expect(res.reason).toBe('quarantined');
    expect((await h.vault.getAccount(a.id))?.quarantined).toBe(false);
  });

  it('fills an account that waits for a login', async () => {
    const h = await harness();
    const row = await h.engine.addPendingAccount('home', { accountUuid: 'u-home' });
    const res = await h.engine.importBundle(row.id, bundle('H1', 'u-home', NOW + HOUR));
    expect(res.reason).toBe('quarantined');
    expect((await h.vault.readBundle(row.id)).claudeAiOauth.accessToken).toBe('H1');
  });

  it('compares against a live rotation, not the older vault copy', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    await rotateLive(h, 'A2', 'u-work', NOW + 6 * HOUR);
    // Newer than the vault's copy, older than the live one: the live one wins.
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res.replaced).toBe(false);
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A2');
  });

  it('writes newer credentials live too when the account is in use here', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await h.engine.activate(a.id);
    const res = await h.engine.importBundle(a.id, bundle('B1', 'u-work', NOW + 3 * HOUR));
    expect(res).toEqual({ replaced: true, reason: 'newer', healedLiveLogin: true });
    expect((await h.live.readLiveCredentials())?.accessToken).toBe('B1');
  });

  it('refuses credentials of another login, writing nothing', async () => {
    const h = await harness();
    const a = await h.engine.addAccount('work', bundle('A1', 'u-work', NOW + HOUR));
    await expect(
      h.engine.importBundle(a.id, bundle('EVIL', 'u-other', NOW + 9 * HOUR)),
    ).rejects.toThrow(/different account/);
    expect((await h.vault.readBundle(a.id)).claudeAiOauth.accessToken).toBe('A1');
  });
});
