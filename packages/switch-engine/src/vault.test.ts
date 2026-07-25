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

  it('captures plan-tier and billing fields from the bundle', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', {
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r-a',
        expiresAt: 999,
        subscriptionType: 'max',
        rateLimitTier: 'default_claude_max_20x',
      },
      oauthAccount: {
        accountUuid: 'uuid-a',
        organizationRateLimitTier: 'default_claude_max_20x',
        billingType: 'stripe_subscription',
        subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
        claudeCodeTrialEndsAt: null,
      },
    });
    expect(acct.rateLimitTier).toBe('default_claude_max_20x');
    expect(acct.organizationRateLimitTier).toBe('default_claude_max_20x');
    expect(acct.billingType).toBe('stripe_subscription');
    expect(acct.subscriptionCreatedAt).toBe('2026-07-15T20:35:34.215673Z');
    // A null trial-end (no active trial) must never surface as the literal string "null".
    expect(acct).not.toHaveProperty('claudeCodeTrialEndsAt');
  });

  it('captures a live trial end date when present', async () => {
    const v = await vault();
    const acct = await v.addAccount('work', {
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r-a', expiresAt: 999 },
      oauthAccount: { claudeCodeTrialEndsAt: '2026-08-01T00:00:00.000Z' },
    });
    expect(acct.claudeCodeTrialEndsAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('degrades cleanly when the bundle carries none of the plan-tier fields', async () => {
    // An account captured before this field existed (or from a provider response that omits
    // them) must read back fine, with the fields simply absent — never a crash, never a
    // forced re-login.
    const v = await vault();
    const acct = await v.addAccount('work', {
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r-a', expiresAt: 999 },
    });
    expect(acct.rateLimitTier).toBeUndefined();
    expect(acct.organizationRateLimitTier).toBeUndefined();
    expect(acct.billingType).toBeUndefined();
    expect(acct.subscriptionCreatedAt).toBeUndefined();
    expect(acct.claudeCodeTrialEndsAt).toBeUndefined();
    expect(await v.listAccounts()).toHaveLength(1);
  });

  describe('writeBundle refreshes the registry metadata row', () => {
    // Without this, plan/billing metadata is frozen at whatever the account looked like the day
    // it was added: every pre-existing account renders as unknown forever (fixable only by
    // remove + re-add), and a Pro -> Max upgrade shows the OLD plan indefinitely, which is worse
    // than showing nothing because it is confidently wrong.
    const withOauth = (oauthAccount: Record<string, unknown>): CredentialBundle => ({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999 },
      oauthAccount,
    });

    it('backfills fields onto an account that was added without them', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', {
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999 },
      });
      expect(acct.billingType).toBeUndefined();

      await v.writeBundle(acct.id, {
        claudeAiOauth: {
          accessToken: 'a2',
          refreshToken: 'r2',
          expiresAt: 999,
          rateLimitTier: 'default_claude_max_20x',
        },
        oauthAccount: {
          billingType: 'stripe_subscription',
          subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
        },
      });

      const after = await v.getAccount(acct.id);
      expect(after?.rateLimitTier).toBe('default_claude_max_20x');
      expect(after?.billingType).toBe('stripe_subscription');
      expect(after?.subscriptionCreatedAt).toBe('2026-07-15T20:35:34.215673Z');
    });

    it('reflects a plan upgrade rather than serving the stale tier forever', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 999,
          rateLimitTier: 'default_claude_pro',
        },
      });
      expect(acct.rateLimitTier).toBe('default_claude_pro');

      await v.writeBundle(acct.id, {
        claudeAiOauth: {
          accessToken: 'a',
          refreshToken: 'r',
          expiresAt: 999,
          rateLimitTier: 'default_claude_max_20x',
        },
      });
      expect((await v.getAccount(acct.id))?.rateLimitTier).toBe('default_claude_max_20x');
    });

    it('clears a trial that has ended instead of leaving it rendering as live', async () => {
      const v = await vault();
      const acct = await v.addAccount(
        'work',
        withOauth({ claudeCodeTrialEndsAt: '2026-08-01T00:00:00.000Z' }),
      );
      expect(acct.claudeCodeTrialEndsAt).toBe('2026-08-01T00:00:00.000Z');

      await v.writeBundle(acct.id, withOauth({ claudeCodeTrialEndsAt: null }));
      expect(await v.getAccount(acct.id)).not.toHaveProperty('claudeCodeTrialEndsAt');
    });

    it('leaves oauthAccount-derived metadata alone when the bundle carries no oauthAccount', async () => {
      // Some write paths legitimately persist a credentials-only bundle (a token rotation with
      // no captured config block). Treating that as "the fields are gone" would wipe good
      // metadata on a routine refresh.
      const v = await vault();
      const acct = await v.addAccount(
        'work',
        withOauth({ emailAddress: 'w@x.com', billingType: 'stripe_subscription' }),
      );
      await v.writeBundle(acct.id, {
        claudeAiOauth: { accessToken: 'a2', refreshToken: 'r2', expiresAt: 999 },
      });
      const after = await v.getAccount(acct.id);
      expect(after?.emailAddress).toBe('w@x.com');
      expect(after?.billingType).toBe('stripe_subscription');
    });

    it('keeps identity anchors when the bundle carries a PARTIAL oauthAccount block', async () => {
      // The live `~/.claude.json` block is unvalidated and legitimately arrives without a uuid —
      // the switch engine designs for exactly that case. Treating "not reported" as "no longer
      // true" would erase the anchors that relogin attribution, active-account reconciliation,
      // usage-cache attribution and token-ownership all gate on. Each of those reads "if
      // present", so losing an anchor turns the check off silently instead of failing.
      const v = await vault();
      const acct = await v.addAccount(
        'work',
        withOauth({
          accountUuid: 'uuid-1',
          emailAddress: 'me@x.com',
          organizationUuid: 'org-1',
        }),
      );

      await v.writeBundle(acct.id, withOauth({ organizationRole: 'admin' }));

      const after = await v.getAccount(acct.id);
      expect(after?.accountUuid).toBe('uuid-1');
      expect(after?.emailAddress).toBe('me@x.com');
      expect(after?.organizationUuid).toBe('org-1');
    });

    it('adopts a CHANGED identity anchor, since set-only must not mean write-once', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', withOauth({ emailAddress: 'old@x.com' }));
      await v.writeBundle(acct.id, withOauth({ emailAddress: 'new@x.com' }));
      expect((await v.getAccount(acct.id))?.emailAddress).toBe('new@x.com');
    });

    it('drops non-string upstream values instead of persisting them for the renderer to hit', async () => {
      // `oauthAccount` is an open JSON block, so any type can arrive. A non-string reaching the
      // registry is stored permanently and throws in the accounts-list renderer on every later
      // run — unrecoverable without hand-editing the registry file.
      const v = await vault();
      const acct = await v.addAccount(
        'work',
        withOauth({ billingType: 12345, subscriptionCreatedAt: 1700000000000 }),
      );
      expect(acct).not.toHaveProperty('billingType');
      expect(acct).not.toHaveProperty('subscriptionCreatedAt');

      // Same guard on the refresh path, and a bad value must also clear a previously good one
      // rather than leaving a stale fact rendering.
      const ok = await v.addAccount('other', withOauth({ billingType: 'stripe_subscription' }));
      await v.writeBundle(ok.id, withOauth({ billingType: { nested: true } }));
      expect(await v.getAccount(ok.id)).not.toHaveProperty('billingType');
    });

    it('ignores a non-string identity anchor rather than adopting or erasing it', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', withOauth({ accountUuid: 'uuid-1' }));
      await v.writeBundle(acct.id, withOauth({ accountUuid: 42 }));
      expect((await v.getAccount(acct.id))?.accountUuid).toBe('uuid-1');
    });

    it('never writes token material into the registry while refreshing', async () => {
      // The registry is plaintext by design. The refresh path reads a decrypted bundle, so it
      // is exactly where a token could leak into it by accident.
      const v = await vault();
      const acct = await v.addAccount('work', bundle('v1'));
      await v.writeBundle(acct.id, {
        claudeAiOauth: {
          accessToken: 'ACCESS-TOKEN-SECRET',
          refreshToken: 'REFRESH-TOKEN-SECRET',
          expiresAt: 999,
        },
        oauthAccount: { accountUuid: 'uuid-v1', emailAddress: 'v1@x.com' },
      });
      const registry = JSON.stringify(await v.listAccounts());
      expect(registry).not.toContain('ACCESS-TOKEN-SECRET');
      expect(registry).not.toContain('REFRESH-TOKEN-SECRET');
    });

    it('leaves updatedAtMs untouched when nothing about the metadata changed', async () => {
      // A token refresh rewrites the bundle constantly; rewriting the registry each time would
      // churn the file and make updatedAtMs meaningless as a "something changed" signal.
      const v = await vault();
      const acct = await v.addAccount('work', bundle('v1'));
      const before = (await v.getAccount(acct.id))?.updatedAtMs;
      await v.writeBundle(acct.id, {
        ...bundle('v1'),
        claudeAiOauth: { accessToken: 'rotated', refreshToken: 'r-v1', expiresAt: 12345 },
      });
      expect((await v.getAccount(acct.id))?.updatedAtMs).toBe(before);
    });

    it('writes the bundle for an id with no registry row without throwing', async () => {
      // addAccount calls writeBundle BEFORE the row exists, and an account can be removed
      // concurrently mid-refresh. Neither is an error: writeBundle is not a lifecycle method.
      const v = await vault();
      await expect(v.writeBundle('no-such-id', bundle('v1'))).resolves.toBeUndefined();
      expect(await v.listAccounts()).toEqual([]);
    });
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
