import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Vault } from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { UnknownAccountError } from './errors.js';
import type { CredentialBundle } from './types.js';

let dirs: string[] = [];
async function vault() {
  const dir = await mkdtemp(join(tmpdir(), 'ce-vault-'));
  dirs.push(dir);
  let t = 1000;
  return new Vault(join(dir, 'vault'), new InsecurePassthroughProtector(), () => t++);
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const bundle = (accessToken: string): CredentialBundle => ({
  claudeAiOauth: { accessToken, refreshToken: 'r-' + accessToken, expiresAt: 999 },
  oauthAccount: { accountUuid: 'uuid-' + accessToken, emailAddress: accessToken + '@x.com' },
});

describe('Vault registry + bundles', () => {
  it('starts empty', async () => {
    const v = await vault();
    expect(await v.listAccounts()).toEqual([]);
    expect(await v.getActiveId()).toBeNull();
  });

  it('adds an account, copying metadata out of the bundle without leaking tokens', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('a'));
    expect(acct.label).toBe('work');
    expect(acct.emailAddress).toBe('a@x.com');
    expect(acct.accountUuid).toBe('uuid-a');
    // The registry row must not contain token material.
    expect(JSON.stringify(acct)).not.toContain('r-a');
    expect(await v.listAccounts()).toHaveLength(1);
  });

  it('round-trips an encrypted bundle', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('secret-access'));
    const read = await v.readBundle(acct.id);
    expect(read.claudeAiOauth.accessToken).toBe('secret-access');
    expect(read.oauthAccount?.accountUuid).toBe('uuid-secret-access');
  });

  it('updates an existing bundle in place', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('v1'));
    await v.writeBundle(acct.id, bundle('v2'));
    expect((await v.readBundle(acct.id)).claudeAiOauth.accessToken).toBe('v2');
  });

  it('sets and rejects the active account', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('a'));
    await v.setActive(acct.id);
    expect(await v.getActiveId()).toBe(acct.id);
    await expect(v.setActive('does-not-exist')).rejects.toBeInstanceOf(UnknownAccountError);
  });

  it('quarantines and clears quarantine', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('a'));
    await v.quarantine(acct.id, 'invalid_grant');
    let stored = await v.getAccount(acct.id);
    expect(stored?.quarantined).toBe(true);
    expect(stored?.quarantineReason).toBe('invalid_grant');
    await v.clearQuarantine(acct.id);
    stored = await v.getAccount(acct.id);
    expect(stored?.quarantined).toBe(false);
    expect(stored?.quarantineReason).toBeUndefined();
  });

  it('removes an account and its bundle, clearing active if needed', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', bundle('a'));
    await v.setActive(acct.id);
    await v.removeAccount(acct.id);
    expect(await v.listAccounts()).toEqual([]);
    expect(await v.getActiveId()).toBeNull();
    await expect(v.readBundle(acct.id)).rejects.toThrow();
  });

  it('stores and clears a rollback snapshot', async () => {
    const v = await vault();
    expect(await v.readRollback()).toBeUndefined();
    await v.writeRollback(bundle('prev'));
    expect((await v.readRollback())?.claudeAiOauth.accessToken).toBe('prev');
    await v.clearRollback();
    expect(await v.readRollback()).toBeUndefined();
  });
});
