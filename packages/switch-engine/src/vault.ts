// The encrypted account vault + non-secret registry.
//
// Layout under `vaultDir`:
//   accounts.json        registry: active id + StoredAccount[] (non-secret metadata)
//   <id>/cred.enc        DPAPI-encrypted CredentialBundle for one account
//   .rollback.enc        DPAPI-encrypted snapshot of the previous live creds (mid-switch only)
//
// The registry is plaintext by design so the CLI can list accounts cheaply; it never holds
// a token. Secrets exist only inside the .enc blobs, which are useless off this machine/user.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CredentialBundle, OauthAccount, Registry, StoredAccount } from './types.js';
import type { Protector } from './dpapi.js';
import { atomicWriteFile, ensureDir, readJsonIfExists, removeIfExists } from './fsutil.js';
import { UnknownAccountError, VaultError } from './errors.js';
import { noopLogger, type Logger } from './logger.js';

/** A fresh empty registry. MUST be a factory, not a shared constant — callers mutate the
 *  `accounts` array in place, and a shared array would leak accounts between vaults. */
function emptyRegistry(): Registry {
  return { activeId: null, accounts: [] };
}

/** Registry fields that identify WHICH account a row is. Never removed by a bundle write, and
 *  only written at all once the block carrying them is accepted — see `identityMatches`. */
type IdentityKey = 'accountUuid' | 'emailAddress' | 'organizationUuid';

/** Registry fields describing an account's CURRENT plan/billing state — mutable, and meaningful
 *  by their absence. See `setOrDelete`. */
type PlanKey =
  | 'subscriptionType'
  | 'rateLimitTier'
  | 'organizationRateLimitTier'
  | 'billingType'
  | 'subscriptionCreatedAt'
  | 'claudeCodeTrialEndsAt';

/** Every field below is copied out of upstream JSON that nothing validates (`oauthAccount` is an
 *  open index-signature block read straight off `~/.claude.json`), so a value of any JSON type
 *  can arrive. The registry rows are typed as strings and rendered as strings, so a non-string
 *  is dropped at the boundary rather than persisted — otherwise one odd upstream value is stored
 *  permanently and throws in the renderer on every later `cctl accounts list`.
 *  `claudeCodeTrialEndsAt` rides the same guard: it is `string | null` upstream, and null (no
 *  active trial) must clear the field, which is exactly what "not a string" already means. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Set an identity anchor, or leave it alone when the block does not carry one. NEVER deletes.
 *
 *  These anchors gate correctness checks elsewhere — relogin attribution (a mismatch is fatal),
 *  `getActiveId()` reconciliation, usage-cache attribution, poll token ownership — and every one
 *  of those is written as "if present", so a missing anchor does not fail loudly, it silently
 *  turns the check off. Live config blocks legitimately arrive partial, so "not reported on this
 *  write" must never be read as "no longer true about this account".
 *
 *  Whether the block may be believed AT ALL is decided once, before any of these run — see
 *  `identityMatches`. Past that gate a changed value is a legitimately changed fact, not an
 *  intruder, so it is applied. Returns whether the row changed. */
function setIfPresent(account: StoredAccount, key: IdentityKey, value: unknown): boolean {
  const next = asString(value);
  if (next === undefined || account[key] === next) return false;
  account[key] = next;
  return true;
}

/** Whether a bundle's `oauthAccount` block may update this registry row at all.
 *
 *  Identity is validated ONCE, here, and on `accountUuid` alone, because that is the only field
 *  the guards downstream key on. A block whose uuid contradicts the stored one is not this
 *  account's, so NOTHING it carries may be believed: absorbing it would re-key the very row
 *  those guards compare a bundle AGAINST, and the contaminated bundle would then agree with its
 *  own row — turning a detectable mis-attribution into a permanently invisible one. Deciding
 *  this per field instead would also refuse a legitimately changed `emailAddress`, which is
 *  display metadata, not an identity gate; past this check the block is provably this account's
 *  and a renamed address should render, not be held back as if it were an intrusion.
 *
 *  An unproven block — either side missing a uuid — passes: live blocks legitimately arrive
 *  partial, and the writers that could hand over someone else's block are guarded where the
 *  handover happens (`adoptRotationIfNeeded`'s identity precedence, the relogin verb's fatal
 *  mismatch), not here.
 *
 *  The conflict is logged, not thrown: bundle writes carry rotated single-use tokens that must
 *  land no matter what, and turning a recoverable attribution problem into a failed refresh
 *  would lose one. */
function identityMatches(account: StoredAccount, acct: OauthAccount, log: Logger): boolean {
  const incoming = asString(acct.accountUuid);
  if (incoming === undefined || account.accountUuid === undefined) return true;
  if (account.accountUuid === incoming) return true;
  log.warn(
    { accountId: account.id, stored: account.accountUuid, refused: incoming },
    'bundle write carries a different account identity; leaving the registry row unchanged',
  );
  return false;
}

/** Set a plan/billing field, or DELETE it when the bundle no longer carries a value.
 *  Deleting matters as much as setting HERE and only here: a lapsed trial or a downgraded plan
 *  must disappear from the registry, not linger as a stale fact the CLI keeps rendering. Returns
 *  whether it changed, so callers can skip a pointless registry write. `exactOptionalPropertyTypes`
 *  forbids assigning an explicit `undefined`, hence the delete rather than a plain assignment. */
function setOrDelete(account: StoredAccount, key: PlanKey, value: unknown): boolean {
  const next = asString(value);
  if (next === undefined) {
    if (!(key in account)) return false;
    delete account[key];
    return true;
  }
  if (account[key] === next) return false;
  account[key] = next;
  return true;
}

/**
 * Copy the non-secret, bundle-DERIVED metadata onto a registry row so listing never has to
 * decrypt. Returns whether anything actually changed.
 *
 * Called on every path that rewrites a bundle, not just on account creation — otherwise the
 * registry is frozen at whatever the account looked like when it was added: accounts that
 * predate a newly captured field render as unknown forever (fixable only by remove + re-add),
 * and a plan upgrade or an expiring trial never shows up at all.
 *
 * `oauthAccount` is treated as authoritative ONLY when the bundle actually carries the block;
 * when it is absent the fields it feeds are left untouched rather than deleted, because some
 * write paths legitimately persist a credentials-only bundle and must not wipe good metadata.
 * Even when the block IS present it may not be this account's, so it is admitted or refused as
 * a whole by `identityMatches` before any of it is copied — a block that fails that check taints
 * the plan/billing fields alongside the identity ones, since the two arrive together.
 */
function applyBundleMetadata(
  account: StoredAccount,
  bundle: CredentialBundle,
  log: Logger,
): boolean {
  const acct = bundle.oauthAccount;
  if (acct !== undefined && !identityMatches(account, acct, log)) return false;

  let changed = false;
  const oauth = bundle.claudeAiOauth;
  changed = setOrDelete(account, 'subscriptionType', oauth.subscriptionType) || changed;
  changed = setOrDelete(account, 'rateLimitTier', oauth.rateLimitTier) || changed;

  if (acct === undefined) return changed;

  changed = setIfPresent(account, 'accountUuid', acct.accountUuid) || changed;
  changed = setIfPresent(account, 'emailAddress', acct.emailAddress) || changed;
  changed = setIfPresent(account, 'organizationUuid', acct.organizationUuid) || changed;
  changed =
    setOrDelete(account, 'organizationRateLimitTier', acct.organizationRateLimitTier) || changed;
  changed = setOrDelete(account, 'billingType', acct.billingType) || changed;
  changed = setOrDelete(account, 'subscriptionCreatedAt', acct.subscriptionCreatedAt) || changed;
  changed = setOrDelete(account, 'claudeCodeTrialEndsAt', acct.claudeCodeTrialEndsAt) || changed;
  return changed;
}

export class Vault {
  constructor(
    private readonly vaultDir: string,
    private readonly protector: Protector,
    private readonly clock: () => number = Date.now,
    /** Where a refused identity block is surfaced (see `identityMatches`). Defaults to
     *  discarding it, so read-only vault handles and tests stay one-liners; the engine passes
     *  its own. */
    private readonly log: Logger = noopLogger,
  ) {}

  // ---- registry (non-secret) ----

  async loadRegistry(): Promise<Registry> {
    const reg = await readJsonIfExists<Registry>(this.registryPath());
    if (!reg) return emptyRegistry();
    // Defensive: an older/corrupt file still yields a well-formed registry.
    return { activeId: reg.activeId ?? null, accounts: reg.accounts ?? [] };
  }

  private async saveRegistry(reg: Registry): Promise<void> {
    await atomicWriteFile(this.registryPath(), JSON.stringify(reg, null, 2));
  }

  async listAccounts(): Promise<StoredAccount[]> {
    return (await this.loadRegistry()).accounts;
  }

  async getAccount(id: string): Promise<StoredAccount | undefined> {
    return (await this.listAccounts()).find((a) => a.id === id);
  }

  /** The RAW registry record of the last committed switch. It can lag reality after a
   *  `/login` inside the Claude CLI — consumers who need "who is live right now" must use
   *  `SwitchEngine.getActiveId()`, which reconciles this against the live login identity. */
  async getActiveId(): Promise<string | null> {
    return (await this.loadRegistry()).activeId;
  }

  // ---- account lifecycle ----

  /**
   * Create a new account: persist its encrypted bundle and a metadata row derived from the
   * bundle. Returns the generated id. Metadata is copied out of the bundle so listing never
   * needs to decrypt.
   */
  async addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
    const reg = await this.loadRegistry();
    const now = this.clock();
    const account: StoredAccount = {
      id: randomUUID(),
      label,
      quarantined: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    // Plan/billing metadata is derived by the same helper every later bundle write uses, so a
    // freshly added account and a long-lived refreshed one can never disagree about how a
    // bundle maps onto a registry row. Every field is independently absent-safe: a provider
    // response missing one degrades to "unknown" in the CLI rather than crashing or forcing a
    // re-login (see planWeight() / `cctl accounts list` for how absence renders).
    applyBundleMetadata(account, bundle, this.log);
    // Writes the blob only — the row is not in the registry yet, so its metadata refresh is a
    // no-op here; `saveRegistry` below is what persists the row built above.
    await this.writeBundle(account.id, bundle);
    reg.accounts.push(account);
    await this.saveRegistry(reg);
    return account;
  }

  async removeAccount(id: string): Promise<void> {
    const reg = await this.loadRegistry();
    reg.accounts = reg.accounts.filter((a) => a.id !== id);
    if (reg.activeId === id) reg.activeId = null;
    await this.saveRegistry(reg);
    await removeIfExists(this.bundlePath(id));
  }

  /** Mark an account's active-flag in the registry (after a committed switch). */
  async setActive(id: string): Promise<void> {
    const reg = await this.loadRegistry();
    if (!reg.accounts.some((a) => a.id === id)) throw new UnknownAccountError(id);
    reg.activeId = id;
    await this.saveRegistry(reg);
  }

  /** Quarantine an account whose refresh token is dead; it stays listed but unusable. */
  async quarantine(id: string, reason: string): Promise<void> {
    await this.patchAccount(id, (a) => {
      a.quarantined = true;
      a.quarantineReason = reason;
      a.quarantinedAtMs = this.clock();
    });
  }

  /** Clear quarantine after a successful re-login. */
  async clearQuarantine(id: string): Promise<void> {
    await this.patchAccount(id, (a) => {
      a.quarantined = false;
      delete a.quarantineReason;
      delete a.quarantinedAtMs;
    });
  }

  private async patchAccount(id: string, mutate: (a: StoredAccount) => void): Promise<void> {
    const reg = await this.loadRegistry();
    const account = reg.accounts.find((a) => a.id === id);
    if (!account) throw new UnknownAccountError(id);
    mutate(account);
    account.updatedAtMs = this.clock();
    await this.saveRegistry(reg);
  }

  // ---- secret bundles (DPAPI) ----

  /** Decrypt and return an account's credential bundle. */
  async readBundle(id: string): Promise<CredentialBundle> {
    let blob: string;
    try {
      blob = await readFile(this.bundlePath(id), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new VaultError(`no encrypted bundle for account "${id}"`);
      }
      throw err;
    }
    return this.decodeBundle(blob);
  }

  /** Encrypt and persist an account's credential bundle, and refresh its metadata row so
   *  the registry stays consistent with the bundle (e.g. after a token refresh). A bundle whose
   *  identity block names a different account refreshes nothing (see `identityMatches`).
   *
   *  The metadata refresh is best-effort and secondary: the encrypted blob is written FIRST
   *  and unconditionally, because losing a rotated single-use token is unrecoverable whereas a
   *  stale derived metadata row is cosmetic and self-heals on the next write. An id with no
   *  registry row (an account mid-creation, or removed concurrently) simply skips the refresh
   *  rather than erroring — this is not a lifecycle method. The registry is only rewritten when
   *  a value actually changed, so routine token refreshes don't churn the file.
   *
   *  Because of that refresh this method is a registry read-modify-write, so like the other
   *  registry writers it MUST be called with the credential lock held (see the "registry
   *  mutators" note in switchEngine.ts) or a concurrent writer's update is silently lost. */
  async writeBundle(id: string, bundle: CredentialBundle): Promise<void> {
    ensureDir(join(this.vaultDir, id));
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.bundlePath(id), blob);

    const reg = await this.loadRegistry();
    const account = reg.accounts.find((a) => a.id === id);
    if (!account) return;
    if (!applyBundleMetadata(account, bundle, this.log)) return;
    account.updatedAtMs = this.clock();
    await this.saveRegistry(reg);
  }

  // ---- rollback snapshot (mid-switch only) ----

  /** Encrypt and stash the current live credentials so a failed switch can restore them. */
  async writeRollback(bundle: CredentialBundle): Promise<void> {
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.rollbackPath(), blob);
  }

  async readRollback(): Promise<CredentialBundle | undefined> {
    let blob: string;
    try {
      blob = await readFile(this.rollbackPath(), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return this.decodeBundle(blob);
  }

  async clearRollback(): Promise<void> {
    await removeIfExists(this.rollbackPath());
  }

  private async decodeBundle(blob: string): Promise<CredentialBundle> {
    try {
      const plain = await this.protector.unprotect(blob);
      return JSON.parse(plain.toString('utf8')) as CredentialBundle;
    } catch (err) {
      throw new VaultError('failed to decrypt or parse credential bundle', { cause: err });
    }
  }

  private registryPath(): string {
    return join(this.vaultDir, 'accounts.json');
  }
  private bundlePath(id: string): string {
    return join(this.vaultDir, id, 'cred.enc');
  }
  private rollbackPath(): string {
    return join(this.vaultDir, '.rollback.enc');
  }
}
