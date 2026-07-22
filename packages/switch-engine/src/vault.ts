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
import type { CredentialBundle, Registry, StoredAccount } from './types.js';
import type { Protector } from './dpapi.js';
import { atomicWriteFile, ensureDir, readJsonIfExists, removeIfExists } from './fsutil.js';
import { UnknownAccountError, VaultError } from './errors.js';

/** A fresh empty registry. MUST be a factory, not a shared constant — callers mutate the
 *  `accounts` array in place, and a shared array would leak accounts between vaults. */
function emptyRegistry(): Registry {
  return { activeId: null, accounts: [] };
}

export class Vault {
  constructor(
    private readonly vaultDir: string,
    private readonly protector: Protector,
    private readonly clock: () => number = Date.now,
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
    // Optional metadata is only set when present — exactOptionalPropertyTypes forbids
    // assigning an explicit `undefined` to an optional field.
    const account: StoredAccount = {
      id: randomUUID(),
      label,
      quarantined: false,
      createdAtMs: now,
      updatedAtMs: now,
    };
    if (bundle.oauthAccount?.accountUuid !== undefined)
      account.accountUuid = bundle.oauthAccount.accountUuid;
    if (bundle.oauthAccount?.emailAddress !== undefined)
      account.emailAddress = bundle.oauthAccount.emailAddress;
    if (bundle.oauthAccount?.organizationUuid !== undefined) {
      account.organizationUuid = bundle.oauthAccount.organizationUuid;
    }
    if (bundle.claudeAiOauth.subscriptionType !== undefined) {
      account.subscriptionType = bundle.claudeAiOauth.subscriptionType;
    }
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
   *  the registry stays consistent with the bundle (e.g. after a token refresh). */
  async writeBundle(id: string, bundle: CredentialBundle): Promise<void> {
    ensureDir(join(this.vaultDir, id));
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.bundlePath(id), blob);
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
