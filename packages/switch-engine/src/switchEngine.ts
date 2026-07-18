// The switch engine: the safety-critical core of the whole system.
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
import { CredentialStore, type LiveCredentialChannel } from './credentialStore.js';
import { type Protector } from './dpapi.js';
import { defaultLiveCredentialChannel, defaultProtector } from './protector.js';
import {
  CadenceError,
  QuarantineError,
  RefreshError,
  UnknownAccountError,
  VerifyError,
} from './errors.js';
import { IntentStore } from './intent.js';
import { acquireLock, type LockOptions } from './lock.js';
import { noopLogger, type Logger } from './logger.js';
import {
  DEFAULT_REFRESH_SKEW_MS,
  refreshCredentials as defaultRefresh,
  type RefreshDeps,
} from './oauth.js';
import type { Paths } from './paths.js';
import { atomicWriteFile } from './fsutil.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ActivateResult,
  ClaudeOauth,
  CredentialBundle,
  OauthAccount,
  RecoverResult,
  RefreshTokenResult,
  StoredAccount,
} from './types.js';
import { Vault } from './vault.js';

/** Signature of the refresh function, so tests can inject a fake. */
export type RefreshFn = (current: ClaudeOauth, deps?: RefreshDeps) => Promise<ClaudeOauth>;

export interface SwitchEngineOptions {
  paths: Paths;
  /** Defaults to this platform's real protector (win32 DPAPI / darwin Keychain).
   *  Tests pass an insecure passthrough. */
  protector?: Protector;
  /** Where the LIVE `claudeAiOauth` block lives. Defaults per platform (darwin: the CLI's
   *  Keychain item; elsewhere: `.credentials.json`). Tests pass an in-memory fake. */
  liveCredentialChannel?: LiveCredentialChannel;
  /** Defaults to the real OAuth refresh. Tests pass a fake. */
  refresh?: RefreshFn;
  refreshDeps?: RefreshDeps;
  clock?: () => number;
  /** Refresh the target's access token when its remaining lifetime is below this. */
  refreshSkewMs?: number;
  /** Minimum time between committed account switches (ToS posture: human-plausible cadence).
   *  Defaults to 60s; 0 disables the guard. Bypass per-call with `activate(id, {force})`. */
  minSwitchIntervalMs?: number;
  lockOptions?: LockOptions;
  logger?: Logger;
}

/** Per-call options for {@link SwitchEngine.activate}. */
export interface ActivateOptions {
  /** Bypass the switch-cadence guard for a deliberate operator override. */
  force?: boolean;
}

/** Default minimum interval between switches — see `minSwitchIntervalMs`. */
export const DEFAULT_MIN_SWITCH_INTERVAL_MS = 60_000;

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
  private readonly minSwitchIntervalMs: number;
  private readonly lockOptions: LockOptions;
  private readonly log: Logger;

  constructor(options: SwitchEngineOptions) {
    this.paths = options.paths;
    this.clock = options.clock ?? Date.now;
    const protector = options.protector ?? defaultProtector();
    this.vault = new Vault(this.paths.vaultDir, protector, this.clock);
    this.credStore = new CredentialStore(
      this.paths,
      options.liveCredentialChannel ?? defaultLiveCredentialChannel(this.paths),
    );
    this.intent = new IntentStore(this.paths.vaultDir);
    this.audit = new AuditLog(this.paths.vaultDir);
    this.refresh = options.refresh ?? defaultRefresh;
    this.refreshDeps = options.refreshDeps ?? {};
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.minSwitchIntervalMs = options.minSwitchIntervalMs ?? DEFAULT_MIN_SWITCH_INTERVAL_MS;
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
   * `cctl accounts add` right after an interactive login populated the live files.
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

  /**
   * Capture a login that was performed inside a TRANSIENT config dir (`CLAUDE_CONFIG_DIR`)
   * as a new stored account — without touching the live login or the active id. This is the
   * verified (CLI 2.1.211) way to onboard extra accounts: the CLI writes both
   * `.credentials.json` and `.claude.json` inside the transient dir, leaving the real ones
   * alone. The caller owns the transient dir and MUST delete it afterwards (token-bearing).
   */
  async captureFromConfigDir(label: string, configDir: string): Promise<StoredAccount> {
    // Deliberately FILE-based on every platform: the transient dir's contents are what we
    // capture. Whether the mac CLI honors CLAUDE_CONFIG_DIR with files (or still writes its
    // Keychain item, which would make this flow read nothing) is unverified on a real Mac.
    const store = new CredentialStore({
      claudeDir: configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      claudeJsonPath: join(configDir, '.claude.json'),
      vaultDir: this.paths.vaultDir,
    });
    const creds = await store.readLiveCredentials();
    if (!creds) {
      throw new RefreshError(
        `no credentials found in "${configDir}"; did the login complete?`,
        'no_capture_login',
      );
    }
    const oauthAccount = await store.readOauthAccount();
    const bundle: CredentialBundle = oauthAccount
      ? { claudeAiOauth: creds, oauthAccount }
      : { claudeAiOauth: creds };
    // Unlike captureCurrentLogin, the live account is unchanged — do NOT touch activeId.
    return this.vault.addAccount(label, bundle);
  }

  /**
   * Re-login an EXISTING account in place. Reuses the same transient-config-dir capture the
   * `accounts add --fresh` flow uses, but writes the freshly captured credentials into the
   * account's EXISTING vault entry — SAME id — and lifts its quarantine flag on success.
   *
   * WHY a distinct verb from {@link captureFromConfigDir}: that one mints a NEW id via
   * `addAccount`, which is exactly wrong for recovering a quarantined account. A new id would
   * orphan every `activation_intervals` / `usage_snapshots` row keyed to the old id and split
   * that account's usage history in two. Re-login exists precisely to keep the id (and thus all
   * attribution) intact while swapping in a live token — so it overwrites the bundle in place.
   *
   * IDENTITY GUARD: if the existing account and the captured login BOTH report an `accountUuid`
   * and they disagree, refuse. Writing a different account's tokens under this id would corrupt
   * the very attribution this verb exists to protect (e.g. the user logged into the wrong
   * account in the transient window). A missing uuid on either side skips the check — an older
   * capture or a provider that doesn't report one shouldn't block recovery.
   *
   * The caller owns the transient `configDir` and MUST delete it afterwards (token-bearing) —
   * same contract as {@link captureFromConfigDir}.
   */
  async reloginFromConfigDir(accountId: string, configDir: string): Promise<StoredAccount> {
    const existing = await this.vault.getAccount(accountId);
    if (!existing) throw new UnknownAccountError(accountId);

    // File-based capture on every platform (the mac Keychain caveat above applies here too):
    // the transient dir is a plain CLAUDE_CONFIG_DIR the CLI populated with
    // `.credentials.json` + `.claude.json`. Same seam add --fresh reads from.
    const store = new CredentialStore({
      claudeDir: configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      claudeJsonPath: join(configDir, '.claude.json'),
      vaultDir: this.paths.vaultDir,
    });
    const creds = await store.readLiveCredentials();
    if (!creds) {
      throw new RefreshError(
        `no credentials found in "${configDir}"; did the login complete?`,
        'no_capture_login',
      );
    }
    const oauthAccount = await store.readOauthAccount();

    // Attribution guard — see the method comment for why a mismatch is fatal, not a warning.
    if (
      existing.accountUuid !== undefined &&
      oauthAccount?.accountUuid !== undefined &&
      existing.accountUuid !== oauthAccount.accountUuid
    ) {
      throw new RefreshError(
        `the captured login is a different account (${oauthAccount.emailAddress ?? oauthAccount.accountUuid}) ` +
          `than "${existing.label}" — re-login must use the SAME account to keep its usage history intact`,
        'relogin_identity_mismatch',
      );
    }

    const bundle: CredentialBundle = oauthAccount
      ? { claudeAiOauth: creds, oauthAccount }
      : { claudeAiOauth: creds };
    // Overwrite the encrypted bundle IN PLACE (same id) so every attribution row keyed to this
    // id stays valid, then lift quarantine: a successful capture means the account can
    // authenticate again. `clearQuarantine` is a no-op flag-wise if it was never quarantined
    // (re-login is also a legitimate way to rotate a still-valid login) and bumps updatedAtMs,
    // so the registry reflects the re-login.
    await this.vault.writeBundle(accountId, bundle);
    await this.vault.clearQuarantine(accountId);
    const refreshed = await this.vault.getAccount(accountId);
    // Only undefined if the account was removed concurrently mid-call — surface that as the
    // unknown-account error rather than returning a stale record.
    if (!refreshed) throw new UnknownAccountError(accountId);
    return refreshed;
  }

  // ---- the state machine ----

  /** Make `targetId` the live account. See the class comment for the guarantees. */
  async activate(targetId: string, options: ActivateOptions = {}): Promise<ActivateResult> {
    const target = await this.vault.getAccount(targetId);
    if (!target) throw new UnknownAccountError(targetId);
    if (target.quarantined) {
      throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
    }

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const prevActiveId = await this.vault.getActiveId();

      // Cadence guard (ToS posture): switching ACCOUNTS faster than a human plausibly would
      // is refused. Re-activating the already-active account is a heal, not a hop — exempt.
      if (!options.force && this.minSwitchIntervalMs > 0 && targetId !== prevActiveId) {
        const last = await this.readLastSwitchAtMs();
        const elapsed = last === undefined ? Infinity : this.clock() - last;
        if (elapsed < this.minSwitchIntervalMs) {
          const retryAfterMs = this.minSwitchIntervalMs - elapsed;
          throw new CadenceError(
            `switched ${Math.round(elapsed / 1000)}s ago; next switch allowed in ` +
              `${Math.ceil(retryAfterMs / 1000)}s`,
            retryAfterMs,
          );
        }
      }

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
      // A real account hop (not a same-account heal) restarts the cadence clock — forced
      // switches too, so an override doesn't grant a free follow-up switch.
      if (targetId !== prevActiveId) await this.writeLastSwitchAtMs(this.clock());
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
   * Refresh an account's access token in the VAULT without changing the active account or
   * touching the live credential files. Built for the daemon's usage poller, whose peek-only
   * vault reads go blind once an idle account's access token expires.
   *
   * Runs under the same credential lock as `activate()` and persists the rotated (single-use)
   * refresh token the instant it arrives — the one non-negotiable invariant of this engine.
   * Two deliberate refusals:
   *   - A fresh token (outside the skew window) is not refreshed: `skippedReason: 'token_fresh'`.
   *   - The ACTIVE account is never network-refreshed: its refresh token is the same single-use
   *     token the live files (and the running CLI) hold, so consuming it here would strand the
   *     live session with a dead token. Instead any CLI-side rotation is adopted into the vault
   *     (which may itself un-expire the vault copy): `skippedReason: 'active_account'`.
   *
   * @throws {UnknownAccountError} / {QuarantineError} as `activate()` does; a dead refresh
   *   token (invalid_grant) quarantines the account, a transient failure just propagates.
   */
  async refreshToken(targetId: string): Promise<RefreshTokenResult> {
    const target = await this.vault.getAccount(targetId);
    if (!target) throw new UnknownAccountError(targetId);
    if (target.quarantined) {
      throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
    }

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const activeId = await this.vault.getActiveId();

      if (targetId === activeId) {
        // Active account: adopt-only (see the method comment for why we never refresh it).
        const liveNow = await this.credStore.readLiveCredentials();
        const liveOauthAccount = await this.credStore.readOauthAccount();
        const adopted = await this.adoptRotationIfNeeded(activeId, liveNow, liveOauthAccount);
        const bundle = await this.vault.readBundle(targetId);
        return {
          accountId: targetId,
          refreshed: false,
          skippedReason: 'active_account',
          adoptedLiveRotation: adopted,
          expiresAt: bundle.claudeAiOauth.expiresAt,
        };
      }

      const bundle = await this.vault.readBundle(targetId);
      if (bundle.claudeAiOauth.expiresAt - this.clock() >= this.refreshSkewMs) {
        return {
          accountId: targetId,
          refreshed: false,
          skippedReason: 'token_fresh',
          expiresAt: bundle.claudeAiOauth.expiresAt,
        };
      }

      const updated = await this.refreshAndPersist(targetId, bundle);
      this.audit.append({
        ts: this.clock(),
        event: 'refreshed',
        fromAccountId: targetId,
        toAccountId: targetId,
        detail: 'background refresh (usage polling)',
      });
      this.log.info({ targetId }, 'background token refresh persisted');
      return { accountId: targetId, refreshed: true, expiresAt: updated.claudeAiOauth.expiresAt };
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

  /** Refresh the target's token for an in-flight `activate()` — the shared refresh core plus
   *  the switch-specific cleanup (intent + rollback snapshot) on failure. */
  private async refreshTarget(
    targetId: string,
    bundle: CredentialBundle,
    hasRollback: boolean,
  ): Promise<CredentialBundle> {
    try {
      return await this.refreshAndPersist(targetId, bundle);
    } catch (err) {
      // Nothing live has been written yet, so cleanup is just intent + snapshot.
      await this.intent.clear();
      if (hasRollback) await this.vault.clearRollback();
      throw err;
    }
  }

  /** The locked refresh core shared by `activate()` and `refreshToken()`: exchange the token,
   *  persist the rotated (single-use) result IMMEDIATELY, quarantine on permanent death.
   *  Callers must hold the credential lock. */
  private async refreshAndPersist(
    targetId: string,
    bundle: CredentialBundle,
  ): Promise<CredentialBundle> {
    try {
      const next = await this.refresh(bundle.claudeAiOauth, this.refreshDeps);
      const updated: CredentialBundle = { ...bundle, claudeAiOauth: next };
      // Persist the rotated (single-use) token BEFORE using it, so a later crash can't lose it.
      await this.vault.writeBundle(targetId, updated);
      return updated;
    } catch (err) {
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

  // ---- cadence state (non-secret) ----

  /** Epoch ms of the last committed account hop, or `undefined` if none recorded. */
  private async readLastSwitchAtMs(): Promise<number | undefined> {
    try {
      const raw = await readFile(this.lastSwitchPath(), 'utf8');
      const parsed = JSON.parse(raw) as { lastSwitchAtMs?: unknown };
      return typeof parsed.lastSwitchAtMs === 'number' ? parsed.lastSwitchAtMs : undefined;
    } catch {
      // Missing or corrupt state must never block a switch — the guard just doesn't apply.
      return undefined;
    }
  }

  private async writeLastSwitchAtMs(atMs: number): Promise<void> {
    await atomicWriteFile(this.lastSwitchPath(), JSON.stringify({ lastSwitchAtMs: atMs }));
  }

  private lastSwitchPath(): string {
    return join(this.paths.vaultDir, 'last-switch.json');
  }

  private lockDir(): string {
    return join(this.paths.vaultDir, '.lock');
  }
}
