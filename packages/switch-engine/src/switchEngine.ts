// The switch engine: the safety-critical core of the whole system (milestone M0).
//
// `activate(id)` makes an account's credentials the live ones, with these guarantees:
//   1. Mutual exclusion with our other processes (file lock).
//   2. The previous account's live token, if the CLI rotated it under us, is ADOPTED into
//      the vault before we overwrite anything (reconcile-by-reading) — never lost.
//   3. The target's token is refreshed if near expiry, and the rotated (single-use) token is
//      persisted to the vault IMMEDIATELY, before it can be lost.
//   4. Live files are written atomically, then read back and verified; a mismatch rolls back
//      to an encrypted snapshot of the prior live credentials.
//   5. A write-ahead intent makes every step crash-recoverable via `recover()`.
//
// What it deliberately does NOT do: claim that a *running* interactive session picked up the
// new credentials. That is an empirical, per-platform fact (see docs/VERIFICATION.md); this
// engine reports only what it mechanically did.

import { AuditLog } from './audit.js';
import { CredentialStore } from './credentialStore.js';
import { DpapiProtector, type Protector } from './dpapi.js';
import { QuarantineError, RefreshError, UnknownAccountError, VerifyError } from './errors.js';
import { IntentStore } from './intent.js';
import { acquireLock, type LockOptions } from './lock.js';
import { noopLogger, type Logger } from './logger.js';
import {
  DEFAULT_REFRESH_SKEW_MS,
  refreshCredentials as defaultRefresh,
  type RefreshDeps,
} from './oauth.js';
import type { Paths } from './paths.js';
import { join } from 'node:path';
import type {
  ActivateResult,
  ClaudeOauth,
  CredentialBundle,
  OauthAccount,
  RecoverResult,
  StoredAccount,
} from './types.js';
import { Vault } from './vault.js';

/** Signature of the refresh function, so tests can inject a fake. */
export type RefreshFn = (current: ClaudeOauth, deps?: RefreshDeps) => Promise<ClaudeOauth>;

export interface SwitchEngineOptions {
  paths: Paths;
  /** Defaults to real DPAPI. Tests pass an insecure passthrough. */
  protector?: Protector;
  /** Defaults to the real OAuth refresh. Tests pass a fake. */
  refresh?: RefreshFn;
  refreshDeps?: RefreshDeps;
  clock?: () => number;
  /** Refresh the target's access token when its remaining lifetime is below this. */
  refreshSkewMs?: number;
  lockOptions?: LockOptions;
  logger?: Logger;
}

export class SwitchEngine {
  private readonly paths: Paths;
  private readonly vault: Vault;
  private readonly credStore: CredentialStore;
  private readonly intent: IntentStore;
  private readonly audit: AuditLog;
  private readonly refresh: RefreshFn;
  private readonly refreshDeps: RefreshDeps;
  private readonly clock: () => number;
  private readonly refreshSkewMs: number;
  private readonly lockOptions: LockOptions;
  private readonly log: Logger;

  constructor(options: SwitchEngineOptions) {
    this.paths = options.paths;
    this.clock = options.clock ?? Date.now;
    const protector = options.protector ?? new DpapiProtector();
    this.vault = new Vault(this.paths.vaultDir, protector, this.clock);
    this.credStore = new CredentialStore(this.paths);
    this.intent = new IntentStore(this.paths.vaultDir);
    this.audit = new AuditLog(this.paths.vaultDir);
    this.refresh = options.refresh ?? defaultRefresh;
    this.refreshDeps = options.refreshDeps ?? {};
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.lockOptions = options.lockOptions ?? {};
    this.log = options.logger ?? noopLogger;
  }

  // ---- registry passthroughs ----

  listAccounts(): Promise<StoredAccount[]> {
    return this.vault.listAccounts();
  }
  getActiveId(): Promise<string | null> {
    return this.vault.getActiveId();
  }
  addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
    return this.vault.addAccount(label, bundle);
  }
  removeAccount(id: string): Promise<void> {
    return this.vault.removeAccount(id);
  }
  clearQuarantine(id: string): Promise<void> {
    return this.vault.clearQuarantine(id);
  }

  /**
   * Capture whatever is currently logged in as a new stored account. Used by
   * `cctl account add` right after an interactive login populated the live files.
   */
  async captureCurrentLogin(label: string): Promise<StoredAccount> {
    const live = await this.credStore.readLiveCredentials();
    if (!live)
      throw new RefreshError('no live credentials to capture; log in first', 'no_live_login');
    const oauthAccount = await this.credStore.readOauthAccount();
    const bundle: CredentialBundle = oauthAccount
      ? { claudeAiOauth: live, oauthAccount }
      : { claudeAiOauth: live };
    const account = await this.vault.addAccount(label, bundle);
    // The just-captured account IS the live one; record that so the first switch reconciles.
    await this.vault.setActive(account.id);
    return account;
  }

  // ---- the state machine ----

  /** Make `targetId` the live account. See the class comment for the guarantees. */
  async activate(targetId: string): Promise<ActivateResult> {
    const target = await this.vault.getAccount(targetId);
    if (!target) throw new UnknownAccountError(targetId);
    if (target.quarantined) {
      throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
    }

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const prevActiveId = await this.vault.getActiveId();

      // Snapshot the current live credentials so a failed write can be rolled back.
      const liveNow = await this.credStore.readLiveCredentials();
      const liveOauthAccount = await this.credStore.readOauthAccount();
      let hasRollback = false;
      if (liveNow) {
        await this.vault.writeRollback(
          liveOauthAccount
            ? { claudeAiOauth: liveNow, oauthAccount: liveOauthAccount }
            : { claudeAiOauth: liveNow },
        );
        hasRollback = true;
      }

      await this.intent.write({
        phase: 'begin',
        targetId,
        prevActiveId,
        hasRollback,
        startedAtMs: this.clock(),
      });

      // Reconcile-by-reading: if the CLI rotated the previous account's refresh token while
      // it was live, the vault's copy is now stale. Adopt the live token before overwriting.
      const adoptedPreviousRotation = await this.adoptRotationIfNeeded(
        prevActiveId,
        liveNow,
        liveOauthAccount,
      );

      // Load the target and refresh it if the access token is near expiry. The rotated token
      // is persisted to the vault the instant we get it — single-use tokens die if dropped.
      let bundle = await this.vault.readBundle(targetId);
      let refreshed = false;
      if (bundle.claudeAiOauth.expiresAt - this.clock() < this.refreshSkewMs) {
        bundle = await this.refreshTarget(targetId, bundle, hasRollback);
        refreshed = true;
      }
      await this.intent.write({
        phase: 'refreshed',
        targetId,
        prevActiveId,
        hasRollback,
        startedAtMs: this.clock(),
      });

      // Write the live files atomically, then record that the point of no easy return passed.
      await this.credStore.writeLiveCredentials(bundle.claudeAiOauth);
      if (bundle.oauthAccount) await this.credStore.writeOauthAccount(bundle.oauthAccount);
      await this.intent.write({
        phase: 'written',
        targetId,
        prevActiveId,
        hasRollback,
        startedAtMs: this.clock(),
      });

      // Verify the write actually landed; a mismatch rolls back to the snapshot.
      const check = await this.credStore.readLiveCredentials();
      if (!check || check.accessToken !== bundle.claudeAiOauth.accessToken) {
        await this.restoreRollback();
        await this.finishIntent();
        throw new VerifyError('credential read-back did not match after write; rolled back');
      }

      // Commit.
      await this.vault.setActive(targetId);
      this.audit.append({
        ts: this.clock(),
        event: 'activated',
        fromAccountId: prevActiveId,
        toAccountId: targetId,
      });
      await this.finishIntent();
      this.log.info({ targetId, refreshed, adoptedPreviousRotation }, 'account activated');
      return {
        ok: true,
        activeAccountId: targetId,
        refreshed,
        adoptedPreviousRotation,
        wroteCredentials: true,
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Recover from a switch that crashed mid-flight. Called on daemon/CLI startup. Rolls the
   * operation forward if the new credentials are already live and valid, otherwise restores
   * the previous account from the encrypted snapshot.
   */
  async recover(): Promise<RecoverResult> {
    if (!(await this.intent.read())) return { recovered: false, action: 'none' };

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const pending = await this.intent.read();
      if (!pending) return { recovered: false, action: 'none' };

      // Before the live files were touched, nothing to undo — just clear. Any token refresh
      // that reached the vault in the 'refreshed' phase is desirable and kept.
      if (pending.phase === 'begin' || pending.phase === 'refreshed') {
        await this.finishIntent();
        this.audit.append({
          ts: this.clock(),
          event: 'recovered',
          fromAccountId: pending.prevActiveId,
          toAccountId: null,
          detail: `cleared at phase ${pending.phase}`,
        });
        return {
          recovered: true,
          action: 'cleared',
          detail: `no live write had occurred (phase ${pending.phase})`,
        };
      }

      // phase 'written': the live files were changed but the switch never committed.
      const target = await this.vault.readBundle(pending.targetId).catch(() => undefined);
      const live = await this.credStore.readLiveCredentials();
      if (target && live && live.accessToken === target.claudeAiOauth.accessToken) {
        // The target creds are already live and valid — roll forward and commit.
        await this.vault.setActive(pending.targetId);
        this.audit.append({
          ts: this.clock(),
          event: 'recovered',
          fromAccountId: pending.prevActiveId,
          toAccountId: pending.targetId,
          detail: 'rolled forward',
        });
        await this.finishIntent();
        return {
          recovered: true,
          action: 'rolled_forward',
          detail: `committed ${pending.targetId}`,
        };
      }

      const restored = await this.restoreRollback();
      this.audit.append({
        ts: this.clock(),
        event: 'recovered',
        fromAccountId: pending.targetId,
        toAccountId: pending.prevActiveId,
        detail: restored ? 'rolled back' : 'no snapshot',
      });
      await this.finishIntent();
      return restored
        ? { recovered: true, action: 'rolled_back', detail: 'restored previous live credentials' }
        : { recovered: true, action: 'cleared', detail: 'no rollback snapshot was available' };
    } finally {
      lock.release();
    }
  }

  // ---- internals ----

  /** If the live (previous-account) token rotated under us, adopt it into the vault. */
  private async adoptRotationIfNeeded(
    prevActiveId: string | null,
    liveNow: ClaudeOauth | undefined,
    liveOauthAccount: OauthAccount | undefined,
  ): Promise<boolean> {
    if (!prevActiveId || !liveNow) return false;
    const prevBundle = await this.vault.readBundle(prevActiveId).catch(() => undefined);
    if (!prevBundle) return false;
    if (liveNow.refreshToken === prevBundle.claudeAiOauth.refreshToken) return false;

    await this.vault.writeBundle(prevActiveId, {
      claudeAiOauth: liveNow,
      ...((liveOauthAccount ?? prevBundle.oauthAccount)
        ? { oauthAccount: liveOauthAccount ?? prevBundle.oauthAccount }
        : {}),
    });
    this.audit.append({
      ts: this.clock(),
      event: 'refresh_adopted',
      fromAccountId: prevActiveId,
      toAccountId: prevActiveId,
      detail: 'CLI rotated token; adopted into vault',
    });
    this.log.info({ prevActiveId }, 'adopted CLI-rotated token into vault');
    return true;
  }

  /** Refresh the target's token, persist the rotated token, and handle dead-token quarantine. */
  private async refreshTarget(
    targetId: string,
    bundle: CredentialBundle,
    hasRollback: boolean,
  ): Promise<CredentialBundle> {
    try {
      const next = await this.refresh(bundle.claudeAiOauth, this.refreshDeps);
      const updated: CredentialBundle = { ...bundle, claudeAiOauth: next };
      // Persist the rotated (single-use) token BEFORE using it, so a later crash can't lose it.
      await this.vault.writeBundle(targetId, updated);
      return updated;
    } catch (err) {
      // Nothing live has been written yet, so cleanup is just intent + snapshot.
      await this.intent.clear();
      if (hasRollback) await this.vault.clearRollback();
      if (err instanceof QuarantineError) {
        await this.vault.quarantine(targetId, err.message);
        this.audit.append({
          ts: this.clock(),
          event: 'quarantined',
          fromAccountId: null,
          toAccountId: targetId,
          detail: err.message,
        });
        this.log.warn({ targetId }, 'target refresh token is dead; quarantined');
      }
      throw err;
    }
  }

  /** Restore the previous live credentials from the encrypted rollback snapshot. */
  private async restoreRollback(): Promise<boolean> {
    const snapshot = await this.vault.readRollback();
    if (!snapshot) return false;
    await this.credStore.writeLiveCredentials(snapshot.claudeAiOauth);
    if (snapshot.oauthAccount) await this.credStore.writeOauthAccount(snapshot.oauthAccount);
    return true;
  }

  /** Clear the intent and rollback snapshot together — the switch is finished either way. */
  private async finishIntent(): Promise<void> {
    await this.intent.clear();
    await this.vault.clearRollback();
  }

  private lockDir(): string {
    return join(this.paths.vaultDir, '.lock');
  }
}
