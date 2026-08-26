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

import { AuditLog, type SwitchOrigin } from './audit.js';
import { CredentialStore, type LiveCredentialChannel } from './credentialStore.js';
import { type Protector } from './dpapi.js';
import { defaultLiveCredentialChannel, defaultProtector } from './protector.js';
import {
  CadenceError,
  LockTimeoutError,
  QuarantineError,
  RefreshError,
  UnknownAccountError,
  VerifyError,
} from './errors.js';
import { IntentStore } from './intent.js';
import { acquireLock, type Lock, type LockOptions } from './lock.js';
import { noopLogger, type Logger } from './logger.js';
import {
  DEFAULT_REFRESH_SKEW_MS,
  exchangeAuthorizationCode as defaultExchange,
  refreshCredentials as defaultRefresh,
  type ExchangeDeps,
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
  ReloginResult,
  StoredAccount,
} from './types.js';
import { needsMetadataBackfill, Vault } from './vault.js';

/** Signature of the refresh function, so tests can inject a fake. */
export type RefreshFn = (current: ClaudeOauth, deps?: RefreshDeps) => Promise<ClaudeOauth>;

/** Signature of the authorization-code exchange, so tests can inject a fake (same seam
 *  discipline as {@link RefreshFn} — reauthenticate() never hits the network in tests). */
export type ExchangeFn = (
  params: { code: string; state: string; verifier: string },
  deps?: ExchangeDeps,
) => Promise<{ claudeAiOauth: ClaudeOauth; oauthAccount?: OauthAccount }>;

/** What {@link SwitchEngine.reauthenticate} did — {@link ReloginResult} plus the one fact only
 *  this verb can report. `identityVerified` is true ONLY when both the stored account and the
 *  exchange response carried an accountUuid and they were actually compared; false means the
 *  check was structurally skipped (identity missing on a side), so callers must render "match
 *  unverified" rather than imply a passed check. */
export interface ReauthResult extends ReloginResult {
  identityVerified: boolean;
}

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
  /** Defaults to the real authorization-code exchange. Tests pass a fake. */
  exchange?: ExchangeFn;
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
  /** Who/what initiated this switch, stamped on the audit trail's `activated` entry (and, via
   *  the daemon's attribution journal, onto the `activation_intervals` row it opens) — a fleet's
   *  history can then tell a human's `/switch` apart from a policy hop. Defaults to 'manual':
   *  every call site that predates this option (a script, a test) was always a human-initiated
   *  switch and keeps reading as one. */
  origin?: SwitchOrigin;
  /** Human-readable context for `origin` (e.g. the auto-switch policy's decision reason).
   *  Recorded as the audit entry's existing `detail` field — the origin needs no new column of
   *  its own to carry a "why". */
  reason?: string;
}

/** Default minimum interval between switches — see `minSwitchIntervalMs`. */
export const DEFAULT_MIN_SWITCH_INTERVAL_MS = 60_000;

/** A thrown value reduced to one loggable line. The message only — a stack in a log field says
 *  nothing an operator can act on about an IO failure, and a non-Error throw still has to render
 *  as something rather than `[object Object]`. */
function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class SwitchEngine {
  private readonly paths: Paths;
  private readonly vault: Vault;
  private readonly credStore: CredentialStore;
  private readonly intent: IntentStore;
  private readonly audit: AuditLog;
  private readonly refresh: RefreshFn;
  private readonly exchange: ExchangeFn;
  private readonly refreshDeps: RefreshDeps;
  private readonly clock: () => number;
  private readonly refreshSkewMs: number;
  private readonly minSwitchIntervalMs: number;
  private readonly lockOptions: LockOptions;
  private readonly log: Logger;

  constructor(options: SwitchEngineOptions) {
    this.paths = options.paths;
    this.clock = options.clock ?? Date.now;
    this.log = options.logger ?? noopLogger;
    const protector = options.protector ?? defaultProtector();
    this.vault = new Vault(this.paths.vaultDir, protector, this.clock, this.log);
    this.credStore = new CredentialStore(
      this.paths,
      options.liveCredentialChannel ?? defaultLiveCredentialChannel(this.paths),
    );
    this.intent = new IntentStore(this.paths.vaultDir);
    this.audit = new AuditLog(this.paths.vaultDir);
    this.refresh = options.refresh ?? defaultRefresh;
    this.exchange = options.exchange ?? defaultExchange;
    this.refreshDeps = options.refreshDeps ?? {};
    this.refreshSkewMs = options.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
    this.minSwitchIntervalMs = options.minSwitchIntervalMs ?? DEFAULT_MIN_SWITCH_INTERVAL_MS;
    this.lockOptions = options.lockOptions ?? {};
  }

  // ---- registry mutators (lock-guarded) ----
  //
  // The registry (accounts.json) is a read-modify-write file. Every method that writes it MUST
  // hold the credential lock, or a separate CLI process mutating the registry (`cctl accounts
  // add`/`remove`/`relogin`) would race the daemon's activate()/refreshToken()/recover() — which
  // hold the lock across a multi-await sequence — and race other CLI writers, silently losing one
  // side's update on whichever save() commits last. `listAccounts`/`getActiveId` are pure reads
  // and intentionally stay unlocked (a torn read at worst returns slightly stale metadata, and
  // saveRegistry writes the whole file atomically). None of these mutators are called from a
  // context that already holds the lock — activate()/recover()/the capture verbs reach the vault
  // directly — so wrapping them here cannot deadlock the (non-reentrant) lock.

  listAccounts(): Promise<StoredAccount[]> {
    return this.vault.listAccounts();
  }
  addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
    return this.withCredentialLock(() => this.vault.addAccount(label, bundle));
  }
  removeAccount(id: string): Promise<void> {
    return this.withCredentialLock(() => this.vault.removeAccount(id));
  }
  clearQuarantine(id: string): Promise<void> {
    return this.withCredentialLock(() => this.vault.clearQuarantine(id));
  }
  setAutoSwitchExcluded(id: string, excluded: boolean): Promise<void> {
    return this.withCredentialLock(() => this.vault.setAutoSwitchExcluded(id, excluded));
  }

  /**
   * Recompute the derived (plan/billing/identity) row of every account whose metadata predates
   * the current bundle -> row mapping, reading each one's ALREADY STORED bundle. Returns how many
   * rows were repaired.
   *
   * The repair exists because nothing else can perform it. A row is refreshed only when its
   * bundle is rewritten, so an account added by a build that captured fewer fields keeps
   * rendering "unknown" until the day its token happens to rotate — and for fields the earlier
   * build never captured at all, that day never comes, because the data was in the bundle the
   * whole time and only the mapping was behind. Recomputing from the stored bundle (rather than
   * from the live `~/.claude.json`) is what makes this correct for EVERY account instead of only
   * whichever one is currently logged in.
   *
   * Cost is bounded and self-limiting: `needsMetadataBackfill` filters to rows that are actually
   * behind, and the lock is not taken at all when there is nothing to do — so the steady state is
   * a single registry read. EVERY selected row is stamped, whether or not it could be repaired: a
   * repaired one with the current revision, an unrepairable one (missing blob, a key this machine
   * cannot decrypt, an identity block that refuses the row) with a failure time that backs the
   * sweep off for `METADATA_BACKFILL_RETRY_MS`. Leaving an unrepairable row unstamped is what
   * turns "sweep once" into "sweep on every listing forever", because that row alone keeps the
   * stale set non-empty. An unreadable bundle is skipped rather than thrown: a listing must still
   * render for the accounts that ARE readable.
   *
   * Opportunistic by design: this is repair nobody asked for, running inside a read command, so
   * it SKIPS when another process holds the credential lock instead of queueing behind an
   * in-flight switch and stalling the caller for the whole acquire timeout. The lock is still
   * required when the work does run — `syncMetadata` is a registry read-modify-write, and doing
   * it unlocked would silently drop a concurrent switch's update. Returns 0 when it skipped;
   * nothing is lost, because the next invocation retries.
   *
   * NEVER THROWS, so a caller can run it ahead of a read without guarding it. Best-effort is a
   * property of this repair, not of the call sites, and expressing it here is what keeps the
   * reason for a failure visible: a caller reduced to `catch {}` discards the only evidence that
   * the self-heal has stopped healing, which is indistinguishable from having nothing left to do.
   * Every failure — one row's or the whole sweep's — is logged at warn instead.
   */
  async backfillAccountMetadata(): Promise<number> {
    try {
      return await this.sweepAccountMetadata();
    } catch (err) {
      this.log.warn({ reason: errorReason(err) }, 'account metadata sweep did not run');
      return 0;
    }
  }

  /** The sweep proper — see {@link backfillAccountMetadata}, which owns its no-throw contract. */
  private async sweepAccountMetadata(): Promise<number> {
    const now = this.clock();
    const stale = (await this.vault.listAccounts()).filter((a) => needsMetadataBackfill(a, now));
    if (stale.length === 0) return 0;
    const repaired = await this.withCredentialLockIfFree(async () => {
      let count = 0;
      for (const account of stale) {
        try {
          const bundle = await this.vault.readBundle(account.id).catch(() => undefined);
          // Both calls re-read the registry per account, so a row removed since the scan above is
          // a no-op. `syncMetadata` returning false for a row known to be behind the revision
          // means the bundle was refused (its identity block names a different account) —
          // unrepairable from here, so it backs off exactly like an unreadable blob.
          if (bundle && (await this.vault.syncMetadata(account.id, bundle))) {
            count += 1;
            continue;
          }
          await this.vault.markMetadataBackfillFailed(account.id);
        } catch (err) {
          // Each row is repaired by its own registry write, so one that cannot be written says
          // nothing about the next. Abandoning the remaining rows would make which accounts get
          // repaired depend on their position in the list, and leave the ones behind the failure
          // waiting for a later sweep that hits the same wall at the same place.
          this.log.warn(
            { accountId: account.id, reason: errorReason(err) },
            'could not repair account metadata',
          );
        }
      }
      if (count > 0) this.log.info({ repaired: count }, 'backfilled account metadata from vault');
      return count;
    });
    return repaired ?? 0;
  }

  // ---- active account (live-login reconciled) ----

  /**
   * The id of the stored account whose credentials are live RIGHT NOW.
   *
   * The registry's `activeId` only records the last switch THIS engine committed — a `/login`
   * inside the Claude CLI swaps the live login without telling us, and trusting the registry
   * afterwards misreports who is active everywhere downstream (the accounts listing, the
   * phone's active marker, usage attribution) and mis-routes the live-token protections in
   * `activate()` / `refreshToken()` at whichever account the registry still names. So the
   * registry answer is reconciled against the live login's identity (`oauthAccount.accountUuid`
   * from `~/.claude.json` — the same signal the re-login guard trusts). Only a PROVABLE
   * mismatch overrides the registry:
   *   - the live identity matches the registry's account → the registry answer stands;
   *   - it matches a DIFFERENT stored account → that account is the live one, UNLESS the live
   *     token still belongs to the registry's account (see below);
   *   - it matches no stored account (a login never captured here) → null, because claiming
   *     any stored account is active would be false;
   *   - no live identity is readable → the registry record, the best remaining evidence.
   *
   * The identity block and the credentials live in two different files, so they can disagree,
   * and the block is the one that goes stale: the CLI rewrites it only on a login, while the
   * token changes under every rotation. Believing a stale block here is not a cosmetic error —
   * it hands the live token's owner the wrong id, which then routes `adoptRotationIfNeeded()`
   * at the wrong bundle and lets `refreshToken()` network-refresh the token the live session is
   * holding. So an override is corroborated against the one artifact that cannot be stale: if
   * the live refresh token is still the registry account's stored token, that account is live
   * and the block is merely out of date.
   */
  async getActiveId(): Promise<string | null> {
    const registryId = await this.vault.getActiveId();
    // A corrupt/unreadable ~/.claude.json must degrade to the registry answer, never throw —
    // this is a read path callers hit on every listing and poll cycle.
    const live = await this.credStore.readOauthAccount().catch(() => undefined);
    const liveUuid = live?.accountUuid;
    if (liveUuid === undefined) return registryId;
    const matches = (await this.vault.listAccounts()).filter((a) => a.accountUuid === liveUuid);
    if (matches.some((m) => m.id === registryId)) return registryId;
    if (registryId !== null && (await this.liveTokenBelongsTo(registryId))) return registryId;
    return matches[0]?.id ?? null;
  }

  /**
   * Whether the live refresh token is the one stored for `accountId`. A refresh token is issued
   * to exactly one account, so a match is proof of ownership; anything else (no live token, no
   * bundle, an unreadable one) is simply not proof and answers false — this corroborates an
   * override, it does not gate one.
   *
   * Deliberately asked ONLY from `getActiveId()`'s disagreement branch: it decrypts a bundle,
   * which on Windows is a PowerShell spawn (see dpapi.ts), and the agreeing case is every normal
   * call. The disagreement branch means the live login is out of step with the last committed
   * switch, which a switch heals.
   */
  private async liveTokenBelongsTo(accountId: string): Promise<boolean> {
    const live = await this.credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return false;
    const bundle = await this.vault.readBundle(accountId).catch(() => undefined);
    return bundle?.claudeAiOauth.refreshToken === live.refreshToken;
  }

  /**
   * Capture whatever is currently logged in as a new stored account. Used by
   * `cctl accounts add` right after an interactive login populated the live files.
   */
  async captureCurrentLogin(label: string): Promise<StoredAccount> {
    // Locked for the whole capture: the add + setActive pair below are two registry writes that
    // must land as one atomic unit, and reading the live login while a switch is mid-flight would
    // otherwise see a torn set of credential files.
    return this.withCredentialLock(async () => {
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
    });
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
    // Unlike captureCurrentLogin, the live account is unchanged — do NOT touch activeId. The
    // transient-dir reads above touch no shared state; only the registry write needs the lock.
    return this.withCredentialLock(() => this.vault.addAccount(label, bundle));
  }

  /**
   * The live `claudeAiOauth` block, wherever this platform keeps it — a public snapshot
   * accessor for the darwin capture flow, which must record the pre-window live credentials
   * BEFORE spawning the throwaway `claude` (see {@link captureFromKeychainDelta}).
   */
  readLiveOauth(): Promise<ClaudeOauth | undefined> {
    return this.credStore.readLiveCredentials();
  }

  /**
   * Darwin counterpart of {@link captureFromConfigDir}. On macOS the CLI ignores
   * `CLAUDE_CONFIG_DIR` for credentials and writes every login to its single login-Keychain
   * item (verified on a real Mac, CLI 2.x) — so the transient dir never contains
   * `.credentials.json`, and a login in the "throwaway" window OVERWRITES the live login.
   * This flow embraces that instead of fighting it:
   *
   *   1. The caller snapshots the live oauth block BEFORE spawning the window (`prior`).
   *   2. After the window exits, the Keychain item is read again. Unchanged (same refresh
   *      token, or still absent) means the login never completed — the same
   *      `no_capture_login` failure the file flow reports.
   *   3. The NEW credentials are vaulted under `label`. Identity (`oauthAccount`) still comes
   *      from the transient dir's `.claude.json`, which the CLI DOES write file-based.
   *   4. The `prior` block is written back, restoring the pre-window live login — preserving
   *      this flow's documented contract that the live account is untouched. When there was
   *      no prior login, the new account simply IS the live one and is recorded active.
   *
   * The caller still owns the transient `configDir` and MUST delete it afterwards — its
   * `.claude.json` carries account identity even though no tokens land there on darwin.
   */
  async captureFromKeychainDelta(
    label: string,
    configDir: string,
    prior: ClaudeOauth | undefined,
  ): Promise<StoredAccount> {
    const creds = await this.credStore.readLiveCredentials();
    if (!creds || creds.refreshToken === prior?.refreshToken) {
      throw new RefreshError(
        'the throwaway window did not produce a new login in the Keychain; did the login complete?',
        'no_capture_login',
      );
    }
    const oauthAccount = await this.transientStore(configDir).readOauthAccount();
    const bundle: CredentialBundle = oauthAccount
      ? { claudeAiOauth: creds, oauthAccount }
      : { claudeAiOauth: creds };
    return this.withCredentialLock(async () => {
      try {
        const account = await this.vault.addAccount(label, bundle);
        if (!prior) {
          // Nothing to restore: the captured login is now the live one — record that.
          await this.vault.setActive(account.id);
        }
        return account;
      } finally {
        // Put the pre-window login back so "your live login was not touched" stays true — in
        // a `finally` because at this point the window HAS overwritten the live login: bailing
        // on a vault failure without restoring would silently leave the wrong account live.
        if (prior) await this.credStore.writeLiveCredentials(prior);
      }
    });
  }

  /**
   * Darwin counterpart of {@link reloginFromConfigDir} — same Keychain-delta read and live-login
   * restore as {@link captureFromKeychainDelta}, same in-place bundle overwrite + identity guard
   * as the file relogin (see that method for why the id must be preserved).
   */
  async reloginFromKeychainDelta(
    accountId: string,
    configDir: string,
    prior: ClaudeOauth | undefined,
  ): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const creds = await this.credStore.readLiveCredentials();
      if (!creds || creds.refreshToken === prior?.refreshToken) {
        throw new RefreshError(
          'the throwaway window did not produce a new login in the Keychain; did the login complete?',
          'no_capture_login',
        );
      }
      // Everything past the delta check restores `prior` on the way out, success or failure —
      // the window HAS overwritten the live login by now, so bailing on the identity guard (or
      // a vault failure) without restoring would silently leave the wrong account live.
      try {
        const existing = await this.vault.getAccount(accountId);
        if (!existing) throw new UnknownAccountError(accountId);

        const oauthAccount = await this.transientStore(configDir).readOauthAccount();

        // Attribution guard — see reloginFromConfigDir for why a mismatch is fatal, not a warning.
        if (
          existing.accountUuid !== undefined &&
          oauthAccount?.accountUuid !== undefined &&
          existing.accountUuid !== oauthAccount.accountUuid
        ) {
          throw new RefreshError(
            `the captured login is a different account (${oauthAccount.emailAddress ?? oauthAccount.accountUuid}) ` +
              `than "${existing.label}" - re-login must use the SAME account to keep its usage history intact`,
            'relogin_identity_mismatch',
          );
        }

        const bundle: CredentialBundle = oauthAccount
          ? { claudeAiOauth: creds, oauthAccount }
          : { claudeAiOauth: creds };
        await this.vault.writeBundle(accountId, bundle);
        await this.vault.clearQuarantine(accountId);
        if (!prior) await this.vault.setActive(accountId);
        const refreshed = await this.vault.getAccount(accountId);
        if (!refreshed) throw new UnknownAccountError(accountId);
        return refreshed;
      } finally {
        if (prior) await this.credStore.writeLiveCredentials(prior);
      }
    });
  }

  /** A file-based CredentialStore over a transient `CLAUDE_CONFIG_DIR` — the darwin flows read
   *  only its `.claude.json` (identity); its `.credentials.json` never exists there. */
  private transientStore(configDir: string): CredentialStore {
    return new CredentialStore({
      claudeDir: configDir,
      credentialsPath: join(configDir, '.credentials.json'),
      claudeJsonPath: join(configDir, '.claude.json'),
      vaultDir: this.paths.vaultDir,
    });
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
   * LIVE HEAL: when the account being re-logged is the one whose credentials are live RIGHT NOW,
   * the fresh grant is also written to the live files. Without this the verb repairs only the
   * vault: the live files keep the dead token, every running/new CLI session keeps failing
   * auth, and `cctl accounts list` — which reads the registry — reports the account healthy,
   * so the one account whose death the user can actually SEE is the one this verb couldn't fix.
   * The heal is best-effort: the vault write is the verb's contract, and a live-file failure
   * degrades to `healedLiveLogin: false` (the caller then points at `cctl switch`) rather than
   * failing a re-login that already succeeded.
   *
   * The caller owns the transient `configDir` and MUST delete it afterwards (token-bearing) —
   * same contract as {@link captureFromConfigDir}.
   *
   * `expectedRefreshToken`, when passed, guards against clobbering a write that landed on this
   * account WHILE the caller's capture was in flight (the activation probe's turn can run for
   * minutes between reading the vault and calling back in here). It must be the refresh token
   * the caller saw in the vault at the START of that capture; if the vault's bundle has since
   * moved on to a different token, someone else won the write and this capture is the stale one
   * — refuse rather than overwrite. Omit it for a login the operator/user is driving live, where
   * there is no earlier snapshot to compare against and last-writer-wins is the intended policy.
   */
  async reloginFromConfigDir(
    accountId: string,
    configDir: string,
    expectedRefreshToken?: string,
  ): Promise<ReloginResult> {
    // Locked end-to-end so the existence check, the in-place bundle overwrite, and the quarantine
    // clear cannot interleave with a concurrent registry writer — which could remove the account
    // between the check and the write, orphaning its freshly written bundle.
    return this.withCredentialLock(() =>
      this.reloginFromConfigDirLocked(accountId, configDir, expectedRefreshToken),
    );
  }

  /** The unlocked core of {@link reloginFromConfigDir}; the public wrapper holds the lock. */
  private async reloginFromConfigDirLocked(
    accountId: string,
    configDir: string,
    expectedRefreshToken?: string,
  ): Promise<ReloginResult> {
    const existing = await this.vault.getAccount(accountId);
    if (!existing) throw new UnknownAccountError(accountId);

    // Staleness guard: read the CURRENT bundle (not just the metadata row above) and compare its
    // token against the one the caller saw before its capture started. A mismatch means the
    // vault moved on under us — some other writer's bundle is the live truth now, and this
    // capture's credentials, however successfully obtained, are already behind it.
    if (expectedRefreshToken !== undefined) {
      const currentBundle = await this.vault.readBundle(accountId);
      if (currentBundle.claudeAiOauth.refreshToken !== expectedRefreshToken) {
        throw new RefreshError(
          `vault bundle for "${existing.label}" changed since this capture started; refusing to overwrite a newer write with a stale one`,
          'relogin_bundle_stale',
        );
      }
    }

    // Who owns the live seat, decided BEFORE the bundle overwrite below: getActiveId()'s
    // stale-identity corroboration compares the live token against the STORED bundle, and this
    // method is about to replace that bundle — asked afterwards, the comparison would run
    // against the fresh capture and could never corroborate.
    const liveAccountId = await this.getActiveId();

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
    return this.applyReloginBundle(existing, creds, oauthAccount, liveAccountId);
  }

  /**
   * The shared re-login core: identity guard → in-place bundle overwrite → quarantine clear →
   * LIVE HEAL. Used by {@link reloginFromConfigDir} (host capture) and {@link reauthenticate}
   * (code exchange) so the same-account attribution guarantee, and the heal that makes the fix
   * visible to a running CLI, each have exactly ONE implementation. Callers must hold the
   * credential lock and pass the `liveAccountId` they read BEFORE the overwrite (see
   * reloginFromConfigDirLocked for why the ordering matters).
   *
   * This core writes exactly the bundle it is handed and reads nothing of the account's own to
   * build it; assembling that bundle is the caller's job, because only the caller knows how
   * complete its source is (a host capture reads whole files, a code exchange gets a partial
   * answer — see {@link mergeOverStoredBundle}). The one rule every caller owes it: the identity
   * block must describe the login that just happened. A block carried forward past a login that
   * named nobody is the cross-account contamination class — a missing block self-heals on the
   * next activation, a wrong one never does.
   */
  private async applyReloginBundle(
    existing: StoredAccount,
    creds: ClaudeOauth,
    oauthAccount: OauthAccount | undefined,
    liveAccountId: string | null,
  ): Promise<ReloginResult> {
    // Attribution guard — a mismatch is fatal, not a warning: writing a different account's
    // tokens under this id would corrupt the very history this verb exists to protect.
    if (
      existing.accountUuid !== undefined &&
      oauthAccount?.accountUuid !== undefined &&
      existing.accountUuid !== oauthAccount.accountUuid
    ) {
      throw new RefreshError(
        `the captured login is a different account (${oauthAccount.emailAddress ?? oauthAccount.accountUuid}) ` +
          `than "${existing.label}" - re-login must use the SAME account to keep its usage history intact`,
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
    await this.vault.writeBundle(existing.id, bundle);
    await this.vault.clearQuarantine(existing.id);

    // Live heal (see the method comment). Writing credentials before identity mirrors
    // activate(); a crash between the two leaves the live identity naming the SAME account —
    // benign, unlike the cross-account torn write recover() exists for — so no intent record
    // is needed. The read-back is the same verification activate() does, but a mismatch here
    // degrades instead of rolling back: restoring the dead token it would roll back TO helps
    // nobody, and the vault-side re-login has already succeeded.
    let healedLiveLogin = false;
    if (liveAccountId === existing.id) {
      try {
        await this.credStore.writeLiveCredentials(bundle.claudeAiOauth);
        await this.writeLiveIdentity(bundle.oauthAccount);
        const check = await this.credStore.readLiveCredentials();
        healedLiveLogin = check?.accessToken === bundle.claudeAiOauth.accessToken;
      } catch (err) {
        this.log.warn(
          { accountId: existing.id, reason: errorReason(err) },
          'relogin could not rewrite the live credentials; vault entry is updated',
        );
      }
      if (healedLiveLogin) {
        this.audit.append({
          ts: this.clock(),
          event: 'relogin_live_heal',
          fromAccountId: existing.id,
          toAccountId: existing.id,
          detail: 're-login of the live account; fresh credentials written live',
        });
        this.log.info({ accountId: existing.id }, 'relogin healed the live credentials in place');
      }
    }

    const refreshed = await this.vault.getAccount(existing.id);
    // Only undefined if the account was removed concurrently mid-call — surface that as the
    // unknown-account error rather than returning a stale record.
    if (!refreshed) throw new UnknownAccountError(existing.id);
    return { account: refreshed, healedLiveLogin };
  }

  /**
   * Fold an authorization-code exchange's answer onto the account's STORED bundle, so the write
   * that follows describes the fresh grant without forgetting everything else.
   *
   * A host capture reads two whole files and therefore knows the account's plan, rate-limit
   * tier, org tier, billing type, subscription start and trial end. An exchange knows none of
   * that: it returns a token pair plus, at most, uuid / email / organization uuid / name. Writing
   * that answer verbatim drops the rest from the bundle AND from the registry row derived from
   * it, so a Max account silently renders — and is capacity-weighted — as an unknown plan until
   * a full re-capture repairs it. The fresh values therefore win, and every field the response is
   * silent about falls back to what is already stored.
   *
   * The identity block is merged ONLY when the exchange actually reported one. That block is what
   * the live heal writes as "who is logged in", and carrying one forward for a response that
   * named nobody is the stale-identity failure class: a MISSING block self-heals on the next
   * capture, a wrong one never does. When a block IS reported, the guard downstream has proven
   * it belongs to this account, so its fields overlay the stored ones and the untouched
   * plan/billing keys ride along.
   *
   * An unreadable stored bundle (no blob yet, a protector that cannot decrypt it) degrades to the
   * exchange's own data rather than failing a re-login that already succeeded — the metadata is
   * cosmetic next to the rotated single-use token this call is about to persist, and the next
   * capture recomputes it.
   */
  private async mergeOverStoredBundle(
    accountId: string,
    fresh: ClaudeOauth,
    identity: OauthAccount | undefined,
  ): Promise<CredentialBundle> {
    let stored: CredentialBundle | undefined;
    try {
      stored = await this.vault.readBundle(accountId);
    } catch (err) {
      this.log.warn(
        { accountId, reason: errorReason(err) },
        'could not read the stored bundle; re-login keeps only the exchanged credentials',
      );
    }
    // Spread order is the whole contract: the exchange only sets keys it actually reported (see
    // oauth.ts's tolerant mapping), so an absent key leaves the stored value standing instead of
    // blanking it — which is also why nothing here may assign an explicit undefined.
    const claudeAiOauth: ClaudeOauth = { ...stored?.claudeAiOauth, ...fresh };
    if (identity === undefined) return { claudeAiOauth };
    return { claudeAiOauth, oauthAccount: { ...stored?.oauthAccount, ...identity } };
  }

  /**
   * Re-login an EXISTING account via a completed OAuth authorization-code+PKCE exchange — the
   * headless counterpart to {@link reloginFromConfigDir} for callers with no browser on this
   * host (phone `/reauth`, `cctl accounts reauth`). Shares its identity-guard +
   * in-place-overwrite + quarantine-clear core, so the guarantees are identical: same account
   * id, usage attribution intact, quarantine lifted on success.
   *
   * Deliberately NOT gated on `quarantined` — the most common real trigger is the ACTIVE
   * account's refresh token dying, which this engine can never observe as quarantined
   * (refreshToken() refuses to network-refresh the active account), and rotating a healthy
   * login is as legitimate here as it is for relogin.
   *
   * Failure taxonomy: a failed exchange is always a {@link RefreshError} (the caller's paste
   * or the provider's rejection), NEVER a {@link QuarantineError} — this path must be unable
   * to (re)quarantine anything; only the refresh path may.
   *
   * METADATA: the exchange reports far less about an account than a host capture does, so its
   * answer is folded onto the stored bundle rather than replacing it ({@link
   * mergeOverStoredBundle}) — a re-login must not cost the account its known plan.
   *
   * LIVE HEAL: identical to {@link reloginFromConfigDir}'s — re-authenticating the account that
   * is live right now also rewrites the live files, reported as `healedLiveLogin`. Never touches
   * `activeId`: a re-login changes which credentials an account HAS, never which account is live.
   */
  async reauthenticate(
    accountId: string,
    params: { code: string; state: string; verifier: string },
  ): Promise<ReauthResult> {
    // Locked end-to-end for the same reason as relogin: the existence check, the overwrite,
    // and the quarantine clear must not interleave with a concurrent registry writer.
    return this.withCredentialLock(async () => {
      const existing = await this.vault.getAccount(accountId);
      if (!existing) throw new UnknownAccountError(accountId);
      // Read BEFORE the overwrite, for the same reason reloginFromConfigDirLocked does.
      const liveAccountId = await this.getActiveId();
      const { claudeAiOauth, oauthAccount } = await this.exchange(params, this.refreshDeps);
      // A code exchange answers with tokens and, at most, a four-field identity block; it never
      // echoes the plan facts the account already knows about itself. Fold it over the stored
      // bundle so a re-login rotates credentials without erasing them (see the helper), and keep
      // the RAW response for `identityVerified` below — the merged block can carry a uuid the
      // exchange itself never reported.
      const merged = await this.mergeOverStoredBundle(existing.id, claudeAiOauth, oauthAccount);
      const { account, healedLiveLogin } = await this.applyReloginBundle(
        existing,
        merged.claudeAiOauth,
        merged.oauthAccount,
        liveAccountId,
      );
      return {
        account,
        healedLiveLogin,
        // True only when both sides had a uuid and the guard actually compared them — a
        // provider response with no identity block must read as "unverified", never "passed".
        identityVerified:
          existing.accountUuid !== undefined && oauthAccount?.accountUuid !== undefined,
      };
    });
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
      // Live-reconciled, not the raw registry: `prevActiveId` names who OWNS the live token
      // below (rotation adoption, audit), and after an external `/login` the registry's
      // record points at an account whose credentials are no longer the live ones.
      const prevActiveId = await this.getActiveId();

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
      // A stale live token left by an in-place re-login is NOT adopted — see the direction
      // guard inside adoptRotationIfNeeded.
      const adoptedPreviousRotation = await this.adoptRotationIfNeeded(
        prevActiveId,
        liveNow,
        liveOauthAccount,
      );

      // Load the target and refresh it if the access token is near expiry. The rotated token
      // is persisted to the vault the instant we get it — single-use tokens die if dropped.
      let bundle = await this.vault.readBundle(targetId);
      // Reconcile the target's derived row from the bundle just decrypted. A switch is the one
      // moment this account's bundle is guaranteed to be open, and the refresh below runs only
      // when the token is near expiry — so without this a fresh-token switch leaves plan/billing
      // metadata frozen at whatever mapping first wrote the row.
      await this.vault.syncMetadata(targetId, bundle);
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
      await this.writeLiveIdentity(bundle.oauthAccount);
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
        origin: options.origin ?? 'manual',
        ...(options.reason !== undefined ? { detail: options.reason } : {}),
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
      // Live-reconciled for the same reason as `activate()`: the adopt-only protection below
      // must shield the account whose token is ACTUALLY live, not whichever one the registry
      // last recorded — network-refreshing the live account's token would strand its session.
      const activeId = await this.getActiveId();

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
          origin: 'recovery',
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
        // The target creds are already live and valid — roll forward and commit. Finish the
        // interrupted live write first: activate() lands the identity block AFTER the
        // credentials, so a crash between the two leaves a live identity that still names the
        // previous account (which would also mislead the live-login reconciliation).
        await this.writeLiveIdentity(target.oauthAccount);
        await this.vault.setActive(pending.targetId);
        this.audit.append({
          ts: this.clock(),
          event: 'recovered',
          fromAccountId: pending.prevActiveId,
          toAccountId: pending.targetId,
          detail: 'rolled forward',
          origin: 'recovery',
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
        origin: 'recovery',
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
    // Identity guard: adoption WRITES the live credentials into this account's bundle, so a
    // provable owner mismatch must skip — persisting another account's tokens under this id
    // would corrupt both the bundle and every usage-attribution row keyed to it. Unprovable
    // (either side missing a uuid) falls through to the token comparison, as before.
    const prevUuid = prevBundle.oauthAccount?.accountUuid;
    const liveUuid = liveOauthAccount?.accountUuid;
    if (prevUuid !== undefined && liveUuid !== undefined && prevUuid !== liveUuid) return false;
    if (liveNow.refreshToken === prevBundle.claudeAiOauth.refreshToken) return false;

    // Direction guard: "differs" is not "newer". Adoption exists to save a token the CLI
    // minted AFTER our stored copy, but an in-place re-login makes the VAULT the newer side —
    // with the live files still holding the dead grant the re-login replaced. Adopting then
    // writes that dead token back over the fresh bundle, and the very next refresh of it fails
    // as invalid_grant and quarantines the account: the recovery verb's work is undone by the
    // switch meant to complete it. `expiresAt` dates each grant's mint (access-token lifetimes
    // are fixed per provider), so a live token that expires no later than the stored one
    // cannot be a later rotation, and is left alone rather than adopted.
    if (liveNow.expiresAt <= prevBundle.claudeAiOauth.expiresAt) return false;

    // Identity precedence: the live block goes into this account's bundle only when it PROVABLY
    // belongs to it — both sides report a uuid and they agree. Otherwise the bundle keeps its own
    // block, because an unprovable live block (partial, or belonging to whoever the CLI logged in
    // last) would stamp a foreign identity onto this bundle, and identity is what every
    // downstream attribution check keys on. Adoption exists to save a rotated TOKEN, so it has no
    // business re-identifying the account it saves it into; when neither side has a block the
    // write carries none rather than inventing one.
    const provenLive =
      liveUuid !== undefined && liveUuid === prevUuid ? liveOauthAccount : undefined;
    const oauthAccount = provenLive ?? prevBundle.oauthAccount;
    await this.vault.writeBundle(prevActiveId, {
      claudeAiOauth: liveNow,
      ...(oauthAccount ? { oauthAccount } : {}),
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

  /**
   * Land `oauthAccount` as the live identity block — or REMOVE the one already there when the
   * credentials we just wrote came with none.
   *
   * The removal is the whole point. `~/.claude.json` is the only statement of who is logged in,
   * and a bundle legitimately carries no block (a credentials-only capture, or an account added
   * before its config block existed). Writing nothing in that case leaves the block naming the
   * PREVIOUS account, and it stays that way: `getActiveId()` then reads a live identity that
   * contradicts the switch that just committed, `adoptRotationIfNeeded()` inherits that wrong
   * owner, and the next CLI-side rotation is written into the wrong account's bundle — the
   * ownership mismatch surfacing later as a quarantine, far from the switch that caused it.
   * Removing the block cannot lie about who is live, and the CLI rebuilds it from the live
   * token (see `CredentialStore.clearOauthAccount`).
   *
   * Every path that writes live credentials goes through here — the switch itself, the
   * roll-forward, and the rollback — because leaving a stale identity behind is exactly as
   * wrong when undoing a switch as when committing one.
   */
  private async writeLiveIdentity(oauthAccount: OauthAccount | undefined): Promise<void> {
    if (oauthAccount) await this.credStore.writeOauthAccount(oauthAccount);
    else await this.credStore.clearOauthAccount();
  }

  /** Restore the previous live credentials from the encrypted rollback snapshot. */
  private async restoreRollback(): Promise<boolean> {
    const snapshot = await this.vault.readRollback();
    if (!snapshot) return false;
    await this.credStore.writeLiveCredentials(snapshot.claudeAiOauth);
    // The snapshot omits the block exactly when the live file had none, so restoring it means
    // removing whatever the failed switch wrote — not leaving the target's identity behind on
    // the previous account's credentials.
    await this.writeLiveIdentity(snapshot.oauthAccount);
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

  /**
   * Run a registry mutation while holding the credential lock, mirroring the acquire/try-finally
   * that activate()/refreshToken()/recover() use (same {@link lockOptions}). This is how every
   * registry writer — in-process and across separate CLI processes — funnels through one mutex.
   * The lock is NOT reentrant, so only callers that do not already hold it may use this; the
   * switch state machine holds the lock itself and reaches the vault directly instead.
   */
  private async withCredentialLock<T>(mutate: () => Promise<T>): Promise<T> {
    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      return await mutate();
    } finally {
      lock.release();
    }
  }

  /**
   * Same as {@link withCredentialLock}, but claims the lock only if it is free RIGHT NOW: a lock
   * someone else holds yields `undefined` and `mutate` never runs.
   *
   * For opportunistic work a user is waiting on. Waiting out the full acquire timeout is the
   * right trade for a mutation the caller explicitly asked for and nothing else can perform; it
   * is the wrong one for background self-healing, where queueing behind an in-flight switch turns
   * a fast read command into a stall for a result the caller never requested. A zero timeout
   * makes `acquireLock` attempt the claim exactly once — still reclaiming a dead holder's lock on
   * the way — and report contention as {@link LockTimeoutError}, which is a routine outcome here
   * rather than a failure. Any other acquisition error is a real fault and propagates.
   */
  private async withCredentialLockIfFree<T>(mutate: () => Promise<T>): Promise<T | undefined> {
    let lock: Lock;
    try {
      lock = await acquireLock(this.lockDir(), this.clock, { ...this.lockOptions, timeoutMs: 0 });
    } catch (err) {
      if (err instanceof LockTimeoutError) return undefined;
      throw err;
    }
    try {
      return await mutate();
    } finally {
      lock.release();
    }
  }
}
