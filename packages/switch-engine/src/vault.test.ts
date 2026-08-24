import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCOUNT_METADATA_REV,
  METADATA_BACKFILL_RETRY_MS,
  needsMetadataBackfill,
  Vault,
} from './vault.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { UnknownAccountError } from './errors.js';
import { noopLogger, type Logger } from './logger.js';
import type { CredentialBundle } from './types.js';

let dirs: string[] = [];
/** A vault plus the directory its registry lives in, so a test can rewrite `accounts.json` the
 *  way an older build left it on disk. */
async function vaultAt(log: Logger = noopLogger) {
  const dir = await mkdtemp(join(tmpdir(), 'ce-vault-'));
  dirs.push(dir);
  let t = 1000;
  const vaultDir = join(dir, 'vault');
  return {
    v: new Vault(vaultDir, new InsecurePassthroughProtector(), () => t++, log),
    registryPath: join(vaultDir, 'accounts.json'),
  };
}
async function vault(log: Logger = noopLogger) {
  return (await vaultAt(log)).v;
}

/** Rewrite the registry as a build predating a metadata field would have left it: the derived
 *  keys absent and no revision stamp. This is the exact on-disk shape the backfill exists to
 *  repair, so tests reproduce it rather than approximating it. */
async function degradeRegistryRow(registryPath: string, drop: string[]): Promise<void> {
  const reg = JSON.parse(await readFile(registryPath, 'utf8')) as {
    accounts: Record<string, unknown>[];
  };
  for (const account of reg.accounts) {
    delete account.metadataRev;
    for (const key of drop) delete account[key];
  }
  await writeFile(registryPath, JSON.stringify(reg, null, 2));
}

/** A logger that keeps every warning, so a refused identity block can be asserted as
 *  SURFACED rather than merely not-applied. */
function warnCapturingLogger(): { logger: Logger; warnings: string[] } {
  const warnings: string[] = [];
  const logger: Logger = {
    ...noopLogger,
    warn: (obj, msg) => warnings.push(`${msg ?? ''} ${JSON.stringify(obj)}`),
  };
  return { logger, warnings };
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

    it('fills an identity anchor the registry does not have yet', async () => {
      // An account added before a field was captured otherwise stays unattributable forever.
      const v = await vault();
      const acct = await v.addAccount('work', withOauth({ accountUuid: 'uuid-1' }));
      expect(acct.emailAddress).toBeUndefined();

      await v.writeBundle(acct.id, withOauth({ accountUuid: 'uuid-1', emailAddress: 'me@x.com' }));

      const after = await v.getAccount(acct.id);
      expect(after?.emailAddress).toBe('me@x.com');
      expect(after?.accountUuid).toBe('uuid-1');
    });

    it('does not rewrite the registry when the anchors merely repeat what is stored', async () => {
      // Every token refresh replays the same identity block; rewriting the row for it would
      // churn the file and make updatedAtMs meaningless as a "something changed" signal.
      const v = await vault();
      const acct = await v.addAccount('work', withOauth({ accountUuid: 'uuid-1' }));
      const before = (await v.getAccount(acct.id))?.updatedAtMs;
      await v.writeBundle(acct.id, withOauth({ accountUuid: 'uuid-1' }));
      expect((await v.getAccount(acct.id))?.updatedAtMs).toBe(before);
    });

    it('applies a changed emailAddress once the uuid proves the block is this account', async () => {
      // The uuid is the identity; the address is display metadata that legitimately changes.
      // Holding a renamed address back would leave `cctl accounts list` rendering one the user
      // no longer has, with nothing to fix it short of remove + re-add.
      const { logger, warnings } = warnCapturingLogger();
      const v = await vault(logger);
      const acct = await v.addAccount(
        'work',
        withOauth({ accountUuid: 'uuid-1', emailAddress: 'old@x.com' }),
      );

      await v.writeBundle(acct.id, withOauth({ accountUuid: 'uuid-1', emailAddress: 'new@x.com' }));

      expect((await v.getAccount(acct.id))?.emailAddress).toBe('new@x.com');
      expect(warnings).toEqual([]);
    });

    it('refuses the WHOLE metadata update when the block names another account', async () => {
      // A different uuid means the bundle picked up someone else's block, and the plan/billing
      // fields rode in on that same block. Absorbing any of it would re-key the registry row
      // that relogin attribution, active-id reconciliation, usage-cache attribution and poll
      // token ownership all compare a bundle AGAINST, so the contaminated bundle would start
      // agreeing with its own row and the mis-attribution would go permanently undetectable.
      // Refusing keeps it visible; logging keeps it from being silent.
      const { logger, warnings } = warnCapturingLogger();
      const v = await vault(logger);
      const acct = await v.addAccount(
        'work',
        withOauth({
          accountUuid: 'uuid-1',
          emailAddress: 'old@x.com',
          billingType: 'stripe_subscription',
        }),
      );

      await v.writeBundle(acct.id, {
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999, rateLimitTier: 'x' },
        oauthAccount: { accountUuid: 'uuid-2', emailAddress: 'new@x.com', billingType: 'other' },
      });

      const after = await v.getAccount(acct.id);
      expect(after?.accountUuid).toBe('uuid-1');
      expect(after?.emailAddress).toBe('old@x.com');
      expect(after?.billingType).toBe('stripe_subscription');
      expect(after?.rateLimitTier).toBeUndefined();
      // One refusal for the block, naming both the kept and the rejected identity.
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('uuid-1');
      expect(warnings[0]).toContain('uuid-2');
    });

    it('still persists the bundle when the identity block is refused', async () => {
      // The refusal must never cost a token: bundle writes carry rotated single-use refresh
      // tokens, so a conflicting identity block is logged and dropped, not thrown.
      const v = await vault();
      const acct = await v.addAccount('work', withOauth({ accountUuid: 'uuid-1' }));
      await v.writeBundle(acct.id, {
        claudeAiOauth: { accessToken: 'rotated', refreshToken: 'r-rotated', expiresAt: 999 },
        oauthAccount: { accountUuid: 'uuid-2' },
      });
      const stored = await v.readBundle(acct.id);
      expect(stored.claudeAiOauth.refreshToken).toBe('r-rotated');
      expect((await v.getAccount(acct.id))?.accountUuid).toBe('uuid-1');
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

  describe('syncMetadata reconciles a row without rewriting the bundle', () => {
    // Tying the row's freshness to a bundle WRITE means a field added after an account was
    // stored never reaches its row: nothing rewrites a bundle except a token rotation, and the
    // data was already inside the stored bundle the whole time.
    const full: CredentialBundle = {
      claudeAiOauth: {
        accessToken: 'a',
        refreshToken: 'r',
        expiresAt: 999,
        subscriptionType: 'max',
      },
      oauthAccount: {
        accountUuid: 'uuid-1',
        emailAddress: 'me@x.com',
        organizationRateLimitTier: 'default_claude_max_20x',
        billingType: 'stripe_subscription',
        subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
      },
    };

    it('recovers plan and billing fields an older build never wrote to the row', async () => {
      const { v, registryPath } = await vaultAt();
      const acct = await v.addAccount('work', full);
      await degradeRegistryRow(registryPath, [
        'organizationRateLimitTier',
        'billingType',
        'subscriptionCreatedAt',
      ]);

      const stale = await v.getAccount(acct.id);
      expect(stale).toBeDefined();
      expect(needsMetadataBackfill(stale!, 0)).toBe(true);
      expect(stale).not.toHaveProperty('organizationRateLimitTier');

      expect(await v.syncMetadata(acct.id, await v.readBundle(acct.id))).toBe(true);
      const after = await v.getAccount(acct.id);
      expect(after?.organizationRateLimitTier).toBe('default_claude_max_20x');
      expect(after?.billingType).toBe('stripe_subscription');
      expect(after?.subscriptionCreatedAt).toBe('2026-07-15T20:35:34.215673Z');
      expect(after?.metadataRev).toBe(ACCOUNT_METADATA_REV);
      expect(needsMetadataBackfill(after!, 0)).toBe(false);
    });

    it('leaves the encrypted bundle exactly as it was', async () => {
      // The whole point of a separate verb: reconciling a row must never re-encrypt, because the
      // bundle holds a single-use refresh token and a stray write is how one gets lost.
      const v = await vault();
      const acct = await v.addAccount('work', full);
      await v.syncMetadata(acct.id, {
        ...full,
        claudeAiOauth: { ...full.claudeAiOauth, refreshToken: 'r-not-persisted' },
      });
      expect((await v.readBundle(acct.id)).claudeAiOauth.refreshToken).toBe('r');
    });

    it('refuses a block naming another account, exactly as a bundle write does', async () => {
      // The reconcile runs on read paths that never validated a bundle before, so it must carry
      // the same identity guard — a foreign block would otherwise re-key the row that every
      // attribution check compares a bundle against.
      const { logger, warnings } = warnCapturingLogger();
      const v = await vault(logger);
      const acct = await v.addAccount('work', full);
      expect(
        await v.syncMetadata(acct.id, {
          claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999 },
          oauthAccount: { accountUuid: 'uuid-2', billingType: 'other' },
        }),
      ).toBe(false);
      const after = await v.getAccount(acct.id);
      expect(after?.accountUuid).toBe('uuid-1');
      expect(after?.billingType).toBe('stripe_subscription');
      expect(warnings).toHaveLength(1);
    });

    it('reports no change when the row already matches the bundle', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', full);
      const before = (await v.getAccount(acct.id))?.updatedAtMs;
      expect(await v.syncMetadata(acct.id, full)).toBe(false);
      expect((await v.getAccount(acct.id))?.updatedAtMs).toBe(before);
    });

    it('is a no-op for an id with no registry row', async () => {
      const v = await vault();
      expect(await v.syncMetadata('no-such-id', full)).toBe(false);
    });

    it('stamps the revision even when the bundle carries no identity block', async () => {
      // A credentials-only bundle has already given up everything this mapping can derive, so
      // leaving it unstamped would make the backfill re-decrypt it on every single listing.
      const { v, registryPath } = await vaultAt();
      const acct = await v.addAccount('work', {
        claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 999 },
      });
      await degradeRegistryRow(registryPath, []);
      expect(await v.syncMetadata(acct.id, await v.readBundle(acct.id))).toBe(true);
      expect((await v.getAccount(acct.id))?.metadataRev).toBe(ACCOUNT_METADATA_REV);
    });
  });

  describe('backfill back-off for rows that cannot be repaired', () => {
    it('stops selecting a row for a while after a failed attempt, then selects it again', async () => {
      // A row nothing can advance (its blob is gone) keeps the stale set non-empty forever if a
      // failed attempt leaves no trace, so the sweep — and the credential lock it takes — runs on
      // every listing. The back-off is a TIMER, not a tombstone: the same row must come back.
      const { v, registryPath } = await vaultAt();
      const acct = await v.addAccount('work', bundle('a'));
      await degradeRegistryRow(registryPath, []);
      await v.markMetadataBackfillFailed(acct.id);

      const failed = await v.getAccount(acct.id);
      const at = failed?.metadataBackfillFailedAtMs;
      expect(at).toBeDefined();
      expect(needsMetadataBackfill(failed!, at!)).toBe(false);
      expect(needsMetadataBackfill(failed!, at! + METADATA_BACKFILL_RETRY_MS - 1)).toBe(false);
      expect(needsMetadataBackfill(failed!, at! + METADATA_BACKFILL_RETRY_MS)).toBe(true);
    });

    it('does not present a failed repair attempt as an update to the account', async () => {
      const v = await vault();
      const acct = await v.addAccount('work', bundle('a'));
      const before = (await v.getAccount(acct.id))?.updatedAtMs;
      await v.markMetadataBackfillFailed(acct.id);
      expect((await v.getAccount(acct.id))?.updatedAtMs).toBe(before);
    });

    it('is a no-op for an id with no registry row', async () => {
      const v = await vault();
      await expect(v.markMetadataBackfillFailed('no-such-id')).resolves.toBeUndefined();
      expect(await v.listAccounts()).toEqual([]);
    });

    it('drops the back-off as soon as a recompute succeeds', async () => {
      // A restored blob or a re-paired machine must heal on the spot rather than serve out a
      // timer that describes a failure which no longer applies.
      const { v, registryPath } = await vaultAt();
      const acct = await v.addAccount('work', bundle('a'));
      await degradeRegistryRow(registryPath, []);
      await v.markMetadataBackfillFailed(acct.id);

      expect(await v.syncMetadata(acct.id, await v.readBundle(acct.id))).toBe(true);
      const healed = await v.getAccount(acct.id);
      expect(healed).not.toHaveProperty('metadataBackfillFailedAtMs');
      expect(needsMetadataBackfill(healed!, 0)).toBe(false);
    });

    it('ignores a back-off stamped in the future by a clock that has since moved back', async () => {
      const { v, registryPath } = await vaultAt();
      const acct = await v.addAccount('work', bundle('a'));
      await degradeRegistryRow(registryPath, []);
      await v.markMetadataBackfillFailed(acct.id);
      const failed = await v.getAccount(acct.id);
      expect(needsMetadataBackfill(failed!, failed!.metadataBackfillFailedAtMs! - 1)).toBe(true);
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

  it('round-trips the auto-switch exclusion flag, and clearing it removes the key', async () => {
    const { v, registryPath } = await vaultAt();
    const acct = await v.addAccount('work', bundle('a'));
    expect((await v.getAccount(acct.id))?.autoSwitchExcluded).toBeUndefined();

    await v.setAutoSwitchExcluded(acct.id, true);
    expect((await v.getAccount(acct.id))?.autoSwitchExcluded).toBe(true);

    // Read the file, not just the parsed row: `false` must be stored as an ABSENT key so the
    // registry only ever carries the accounts an operator actually excluded.
    await v.setAutoSwitchExcluded(acct.id, false);
    expect((await v.getAccount(acct.id))?.autoSwitchExcluded).toBeUndefined();
    const reg = JSON.parse(await readFile(registryPath, 'utf8')) as {
      accounts: Record<string, unknown>[];
    };
    expect(reg.accounts[0]).not.toHaveProperty('autoSwitchExcluded');
  });

  it('refuses to set the exclusion flag on an account that does not exist', async () => {
    const v = await vault();
    await expect(v.setAutoSwitchExcluded('does-not-exist', true)).rejects.toBeInstanceOf(
      UnknownAccountError,
    );
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
