// The switch engine: the safety-critical core of the whole system.
//
// `activate(id)` makes an account's credentials the live ones, with these guarantees:
//   1. Mutual exclusion with our other processes (file lock).
//   2. The previous account's live token, if the CLI rotated it under us, is ADOPTED into
//      the vault before we overwrite anything (reconcile-by-reading) — never lost, and never
//      stored under an account the live files cannot prove it belongs to.
//   3. The target's token is refreshed if near expiry, and the rotated (single-use) token is
//      persisted to the vault IMMEDIATELY, before it can be lost.
//   4. Live files are written atomically, then read back and verified; any failure between the
//      first live write and the commit puts the prior live login (credentials AND identity) back.
//   5. A write-ahead intent makes every step crash-recoverable: `recover()` at startup, and every
//      locked operation that reads or writes the live login settles a pending switch first.
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
  VaultError,
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
import { isDeepStrictEqual } from 'node:util';
import type {
  ActivateResult,
  ClaudeOauth,
  CredentialBundle,
  OauthAccount,
  RecoverResult,
  RefreshTokenResult,
  ReloginResult,
  StoredAccount,
  SwitchIntent,
  TokenConflict,
} from './types.js';
import { needsMetadataBackfill, Vault, type DedupeReport } from './vault.js';
import type { StoredTokens } from './tokenPrints.js';

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

/** The live login as it was before a switch wrote over it: what undoing that switch puts back. */
interface PriorLive {
  /** The credentials that were live (`undefined`: nobody was logged in). */
  creds: ClaudeOauth | undefined;
  /** The identity block that was live. `null` when it was not recorded — a switch that found no
   *  credentials leaves no snapshot to record it in — which an undo treats as "remove whatever is
   *  there now": with no credentials beside it, an absent block is the one statement that cannot be
   *  wrong. */
  identity: OauthAccount | undefined | null;
}

/** Whether two credential blocks are the same grant: both absent, or the same pair of tokens. */
function sameGrant(a: ClaudeOauth | undefined, b: ClaudeOauth | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/** The identity fields a registry row and a login's identity block BOTH carry — the only ones a
 *  re-login's attribution can be checked on. `organizationName` and the plan facts live in the
 *  bundle alone, so they can neither confirm a row nor contradict it. */
const IDENTITY_ANCHORS = ['accountUuid', 'emailAddress', 'organizationUuid'] as const;
type IdentityAnchor = (typeof IDENTITY_ANCHORS)[number];

/** An anchor read out of an identity block. The block is unvalidated upstream JSON (see
 *  vault.ts's `asString`), so a value that is not a string is not an anchor at all. */
function anchorValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Why the identity a login REPORTED may not be written under `existing` — as a clause for the
 * refusal message — or `undefined` when it may.
 *
 * The rule is "this login has to be provably, or at least consistently, the same account", and
 * it is deliberately not just a uuid comparison:
 *
 *   - Both sides name a uuid: the uuid alone decides. Past that proof a changed address or
 *     organization is a legitimately changed FACT (a rename, a moved org) that the re-login is
 *     meant to apply, so refusing on it would freeze the account's own metadata.
 *   - Only a partial identity was reported (no uuid — an exchange answers with whatever the
 *     provider felt like returning): it may not contradict any anchor the row already holds.
 *     Without this, another person's grant that happens to report no uuid passes unexamined.
 *   - The ROW has no uuid: there is nothing to prove sameness against, so a login must echo
 *     every anchor the row does have. A silent login would otherwise be adopted by any account
 *     whose identity was never captured. A row with no identity at all has nothing to
 *     contradict and nothing to lose, so it accepts and gains one.
 *
 * A login that named NOBODY is not checked: the bundle built from it carries no identity block
 * (see {@link mergeOverStoredBundle}), so it cannot mis-attribute anything, and the next capture
 * re-establishes the block.
 */
function reloginIdentityRefusal(
  existing: StoredAccount,
  reported: OauthAccount | undefined,
): string | undefined {
  if (reported === undefined) return undefined;
  const claimed = (key: IdentityAnchor): string | undefined => anchorValue(reported[key]);

  const storedUuid = existing.accountUuid;
  const claimedUuid = claimed('accountUuid');
  if (storedUuid !== undefined && claimedUuid !== undefined) {
    if (storedUuid === claimedUuid) return undefined;
    return `is a different account (${claimed('emailAddress') ?? claimedUuid}) than "${existing.label}"`;
  }

  // Unproven from here: one side or the other has no uuid, so the remaining anchors carry the
  // whole check.
  const contradicted = IDENTITY_ANCHORS.filter((key) => {
    const stored = existing[key];
    const value = claimed(key);
    return stored !== undefined && value !== undefined && stored !== value;
  });
  if (contradicted.length > 0) {
    const detail = contradicted
      .map((key) => `${key} is ${String(claimed(key))}, not ${String(existing[key])}`)
      .join('; ');
    return `is not "${existing.label}" (${detail})`;
  }
  // A row WITH a uuid has been checked as far as a partial identity allows: it contradicts
  // nothing this account knows about itself, so it is written.
  if (storedUuid !== undefined) return undefined;

  const unanswered = IDENTITY_ANCHORS.filter(
    (key) => existing[key] !== undefined && claimed(key) === undefined,
  );
  if (unanswered.length === 0) return undefined;
  return (
    `cannot be shown to be "${existing.label}": it reports no ${unanswered.join('/')} to match ` +
    'the stored one, and the account has no accountUuid to check against'
  );
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
    return this.withCredentialLock(async () => {
      // A pending switch to or from this account needs its bundle to be settled correctly.
      await this.settlePendingSwitchLocked();
      await this.vault.removeAccount(id);
    });
  }
  renameAccount(id: string, label: string): Promise<StoredAccount> {
    return this.withCredentialLock(() => this.vault.renameAccount(id, label));
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
      await this.reportRepairFailure(err, 'account metadata sweep did not run');
      return 0;
    }
  }

  /**
   * Report an opportunistic repair that could not run (see {@link backfillAccountMetadata} and
   * {@link dedupeAccounts} for why those never throw).
   *
   * A repair that failed on its own terms is a warning: it is the only evidence that a self-heal
   * has stopped healing. An unreadable REGISTRY is not that — it is the calling command's own
   * input being broken, and the read that command is about to do throws it as one clean,
   * phrased error. Warning about it first only puts raw log lines in front of that error for a
   * condition the operator is already being told about, once per repair. So it drops to debug,
   * where `CCTL_LOG_LEVEL=debug` still has it.
   *
   * The registry is re-read to classify, which costs nothing in the steady state: this runs only
   * after a repair has already failed.
   */
  private async reportRepairFailure(err: unknown, message: string): Promise<void> {
    const reason = errorReason(err);
    const registryBroken = await this.vault.listAccounts().then(
      () => false,
      () => true,
    );
    if (registryBroken) this.log.debug({ reason }, message);
    else this.log.warn({ reason }, message);
  }

  /**
   * Resolve duplicate accounts (see {@link Vault.dedupeAccounts}) ahead of any account-reading
   * command, under the same take-it-or-leave-it lock as the metadata sweep: a listing must not
   * stall behind an in-flight switch for a repair it did not ask for, and the next call
   * retries. Never throws — an empty report is "nothing to do or could not run", and the
   * reason for the latter is logged rather than handed to a caller that would drop it.
   */
  async dedupeAccounts(): Promise<DedupeReport> {
    const nothing: DedupeReport = { merged: [], relabelled: [] };
    try {
      const report = await this.withCredentialLockIfFree(() => this.vault.dedupeAccounts());
      if (report && (report.merged.length > 0 || report.relabelled.length > 0)) {
        this.log.info(
          { merged: report.merged, relabelled: report.relabelled },
          'resolved duplicate accounts',
        );
      }
      return report ?? nothing;
    } catch (err) {
      await this.reportRepairFailure(err, 'duplicate-account check did not run');
      return nothing;
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
    // Fingerprint the stored bundles before taking the lock, for the same reason activate() does:
    // the check below compares the live token against every stored one.
    await this.vault.readStoredTokens().catch(() => undefined);
    // Locked for the whole capture: the add + setActive pair below are two registry writes that
    // must land as one atomic unit, and reading the live login while a switch is mid-flight would
    // otherwise see a torn set of credential files.
    return this.withCredentialLock(async () => {
      // A switch left between its two live writes would be captured as one account's token under
      // another's identity; it is settled first.
      await this.settlePendingSwitchLocked();
      const live = await this.credStore.readLiveCredentials();
      if (!live)
        throw new RefreshError('no live credentials to capture; log in first', 'no_live_login');
      // A live token an account already stores IS that account's login, whatever identity block sits
      // beside it — refused like a login stored twice, since storing it again would put one
      // single-use token in two bundles. (The identity-based duplicate check in the vault cannot see
      // this when the block beside the token names someone else.)
      const [holder] = (await this.vault.readStoredTokens()).holdersOf(live);
      if (holder !== undefined) {
        const row = await this.vault.getAccount(holder);
        throw new VaultError(
          `this login is account ${holder} ("${row?.label ?? holder}"), which is already stored; ` +
            `switch to it with \`cctl switch ${row?.label ?? holder}\` instead of adding it again`,
        );
      }
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
    // A pending switch is deliberately NOT settled here (nor in reloginFromKeychainDelta): `prior`
    // was read before the window opened, and settling in between could change the live login that
    // the restore below then overwrites with `prior` again. The restore puts the live credentials
    // back exactly as this flow found them, the state the pending intent describes, so the next
    // operation settles it as if this flow had never run.
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
    return this.withCredentialLock(async () => {
      // Whether the account is the live one is read below; no switch may be left mid-flight.
      await this.settlePendingSwitchLocked();
      return this.reloginFromConfigDirLocked(accountId, configDir, expectedRefreshToken);
    });
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
    // A host capture reads the login's own files, so what gets stored and what the login
    // reported are the same block — the guard has nothing merged to see through.
    return this.applyReloginBundle(existing, creds, oauthAccount, liveAccountId, oauthAccount);
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
   *
   * `reportedIdentity` is that same rule made checkable: what the login ITSELF said about who
   * logged in, before any merge with what was already stored. The guard runs on that and never
   * on `oauthAccount`, because a merged block inherits the stored row's own anchors and would
   * only ever be compared against itself (see {@link reloginIdentityRefusal}).
   */
  private async applyReloginBundle(
    existing: StoredAccount,
    creds: ClaudeOauth,
    oauthAccount: OauthAccount | undefined,
    liveAccountId: string | null,
    reportedIdentity: OauthAccount | undefined,
  ): Promise<ReloginResult> {
    // Attribution guard — a refusal is fatal, not a warning: writing a different account's
    // tokens under this id would corrupt the very history this verb exists to protect. It runs
    // before ANY write, so a refused login leaves the vault bundle, the quarantine flag and the
    // live files exactly as they were.
    const refusal = reloginIdentityRefusal(existing, reportedIdentity);
    if (refusal !== undefined) {
      throw new RefreshError(
        `the captured login ${refusal} - re-login must use the SAME account to keep its ` +
          'usage history intact',
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
      // Whether the account is the live one is read below; no switch may be left mid-flight.
      await this.settlePendingSwitchLocked();
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
      // The merged block is what gets STORED; the raw response is what gets CHECKED. They are
      // not interchangeable: the merge folds the stored identity underneath the reported one, so
      // a guard given the merged block would compare this account's anchors against themselves
      // and pass any login that simply failed to mention who it belongs to.
      const { account, healedLiveLogin } = await this.applyReloginBundle(
        existing,
        merged.claudeAiOauth,
        merged.oauthAccount,
        liveAccountId,
        oauthAccount,
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

  /**
   * Make `targetId` the live account. See the file comment for the guarantees.
   *
   * A switch left in the middle (a crash, or an undo that failed) is settled FIRST, before anything
   * here reads the live login: every read below — who is live, whose rotation to adopt — goes by the
   * live identity block, which such a switch may have left naming the wrong account.
   *
   * The live login is two files, written credentials first and identity second, and the intent says
   * `writing` BEFORE the first of them. Anything that fails from there to the registry commit — the
   * identity write (another process holding `.claude.json` open is enough), the `written` record, the
   * read-back, the commit itself — puts the previous login back, identity and credentials, before
   * the error surfaces ({@link settleSwitch} in undo mode). The live files must never be left holding
   * the target's credentials under the previous account's identity: every reader would take the
   * target's token for the previous account's, and the next switch would store it in that account's
   * bundle. When the undo itself fails, the intent stays, and the next locked operation settles it.
   */
  async activate(targetId: string, options: ActivateOptions = {}): Promise<ActivateResult> {
    const target = await this.vault.getAccount(targetId);
    if (!target) throw new UnknownAccountError(targetId);
    if (target.quarantined) {
      throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
    }

    // Fingerprint the stored bundles BEFORE taking the lock. Rotation adoption, under the lock,
    // checks the live token against every stored one; with a cold fingerprint cache (a process that
    // has not seen the current bundles, the first run after an upgrade) that is a decrypt per bundle
    // — a PowerShell spawn each on Windows. Paid here it delays only this caller; paid under the lock
    // it eats into the time every holder must finish within (see LOCK_STALE_MS). Best-effort: the
    // check under the lock stays authoritative, and a failure here only means it does the work itself.
    await this.vault.readStoredTokens().catch(() => undefined);
    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      await this.settlePendingSwitchLocked();

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

      // Snapshot the current live login so a failed write can be rolled back — to disk for a crash,
      // and in memory for this process's own undo (which then needs no decrypt, and knows the
      // identity block even when no credentials were live).
      const liveNow = await this.credStore.readLiveCredentials();
      const liveOauthAccount = await this.credStore.readOauthAccount();
      const prior: PriorLive = { creds: liveNow, identity: liveOauthAccount };
      let hasRollback = false;
      if (liveNow) {
        await this.vault.writeRollback(
          liveOauthAccount
            ? { claudeAiOauth: liveNow, oauthAccount: liveOauthAccount }
            : { claudeAiOauth: liveNow },
        );
        hasRollback = true;
      }

      const intentAt = (phase: SwitchIntent['phase']): SwitchIntent => ({
        phase,
        targetId,
        prevActiveId,
        hasRollback,
        startedAtMs: this.clock(),
      });
      await this.intent.write(intentAt('begin'));

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

      // The live files are about to change: say so before the first write, never after it.
      await this.intent.write(intentAt('writing'));
      let recorded: SwitchIntent['phase'] = 'writing';
      try {
        await this.credStore.writeLiveCredentials(bundle.claudeAiOauth);
        await this.writeLiveIdentity(bundle.oauthAccount);
        await this.intent.write(intentAt('written'));
        recorded = 'written';

        // Verify the write actually landed; a mismatch is undone like any other failure here.
        const check = await this.credStore.readLiveCredentials();
        if (!check || check.accessToken !== bundle.claudeAiOauth.accessToken) {
          throw new VerifyError('credential read-back did not match after write; rolled back');
        }

        // Commit — the last step that can still be undone.
        await this.vault.setActive(targetId);
      } catch (err) {
        await this.undoFailedSwitch(intentAt(recorded), prior, err);
        throw err;
      }

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
      // Who is live is read below; no switch may be left mid-flight.
      await this.settlePendingSwitchLocked();
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

      // The last word before spending the token: whatever the identity block says, live
      // credentials holding this very refresh token have sessions using it, and a network refresh
      // would strand them. (Live files left holding one account's token under another's identity,
      // with nothing recorded that could settle them, are how the reconciled reading above can
      // miss it.) A plain read of the live credentials — no decrypt.
      const live = await this.credStore.readLiveCredentials().catch(() => undefined);
      if (live?.refreshToken === bundle.claudeAiOauth.refreshToken) {
        return {
          accountId: targetId,
          refreshed: false,
          skippedReason: 'active_account',
          adoptedLiveRotation: false,
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
   * Recover from a switch that did not finish (a crash, or an undo that failed). Called on
   * daemon/CLI startup; every locked operation that reads the live login also does this first (see
   * {@link settlePendingSwitchLocked}). See {@link settleSwitch} for what it does.
   */
  async recover(): Promise<RecoverResult> {
    if (!(await this.intent.read())) return { recovered: false, action: 'none' };

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      return (await this.settlePendingSwitchLocked()) ?? { recovered: false, action: 'none' };
    } finally {
      lock.release();
    }
  }

  /**
   * Settle a pending switch, for a caller that holds the credential lock and is about to read or
   * write the live login, or the bundles a pending switch involves. A switch left between its live
   * writes and its commit must not wait for a restart: until it is settled, the live identity block
   * may name the wrong account, and everything that reads the live login goes by that block. Cheap
   * when nothing is pending, which is nearly every call: one read of an absent intent file. Returns
   * what it did, or `undefined` when nothing was pending.
   */
  private async settlePendingSwitchLocked(): Promise<RecoverResult | undefined> {
    const pending = await this.intent.read();
    if (!pending) return undefined;
    return this.settleSwitch(pending, 'recover');
  }

  /**
   * Bring live files whose switch did not finish to a state where both name one account, and clear
   * the intent. Two callers: recovery of a switch a crash (or a failed undo) left pending
   * (`recover`), and a switch undoing its own failure (`undo`, handed the in-memory snapshot).
   *
   * Nothing is assumed from the phase beyond `begin` (nothing live written — cleared; a refresh or an
   * adoption that reached the vault is kept). From `writing` on — and at an older build's `refreshed`,
   * recorded just before its first live write — the files are LOOKED AT, because the credentials may
   * be the target's while the identity block still names the previous account. In order:
   *
   *   1. The target's credentials are live. Recovery rolls FORWARD when the target is still a stored
   *      account: the credentials are provably complete (one atomically written file), so writing the
   *      target's identity completes the switch, which is then committed. An undo — or a target that
   *      is no longer stored — rolls BACK to the previous login instead (emptied if there was none).
   *   2. The previous credentials are live: the credentials write never landed, or has been undone.
   *      Only the identity can still be off, and it is put back.
   *   3. Neither, but the identity names the target: both writes landed and a running session has
   *      since rotated the target's token, so the live token is the target's. Recovery rolls forward
   *      (nothing to rewrite); an undo, or a target that is no longer stored, first adopts it into
   *      the target's own bundle, then rolls back.
   *   4. Neither, and the identity does not name the target: the live token moved on after the
   *      switch touched it. It is left live — overwriting it would destroy whichever login it is — and
   *      no bundle is changed. At `written` the switch had already written its identity block, so the
   *      one there now was written later, by whoever wrote the live login (a `/login`), and is left
   *      standing. Before that, the block may be the previous account's, left over from before the
   *      switch, beside a token that may be the previous account's rotation or the target's: the files
   *      cannot say which, so the block, the one statement that may be false, is removed. Claude Code
   *      re-derives it from the token itself, and until it does, rotation adoption refuses to credit
   *      the token to anyone (see adoptionRefusal).
   */
  private async settleSwitch(
    pending: SwitchIntent,
    mode: 'recover' | 'undo',
    knownPrior?: PriorLive,
  ): Promise<RecoverResult> {
    if (pending.phase === 'begin') {
      await this.finishIntent();
      this.auditRecovery(pending.prevActiveId, null, 'cleared at phase begin');
      return {
        recovered: true,
        action: 'cleared',
        detail: 'no live write had occurred (phase begin)',
      };
    }

    const target = await this.vault.readBundle(pending.targetId).catch(() => undefined);
    const prior = knownPrior ?? (await this.readPriorLive(pending));
    const live = await this.credStore.readLiveCredentials();
    const liveIdentity = await this.credStore.readOauthAccount();
    const targetUuid = anchorValue(target?.oauthAccount?.accountUuid);
    const namesTarget =
      targetUuid !== undefined && anchorValue(liveIdentity?.accountUuid) === targetUuid;
    // Committing needs the target's registry row (setActive refuses an unknown id); a target whose
    // row is gone is rolled back rather than failing every later settle on the commit.
    const targetStored = (await this.vault.getAccount(pending.targetId)) !== undefined;
    const mayForward = mode === 'recover' && targetStored;
    if (mode === 'recover' && !targetStored) {
      this.log.warn(
        { targetId: pending.targetId },
        'unfinished switch target is no longer a stored account; rolling back instead of forward',
      );
    }

    // 1. The target's credentials are live.
    if (target !== undefined && live !== undefined && sameGrant(live, target.claudeAiOauth)) {
      if (mayForward) return this.rollForward(pending, target, true);
      return this.rollBack(pending, prior, mode);
    }

    // 2. The previous credentials are live: at most the identity is left to put back.
    if (prior !== undefined && sameGrant(live, prior.creds)) {
      let changed = false;
      if (prior.identity !== null) {
        changed = !isDeepStrictEqual(liveIdentity, prior.identity);
        if (changed) await this.writeLiveIdentity(prior.identity);
      } else if (namesTarget) {
        // Unrecorded prior identity, no credentials then or now: the target's block is removed.
        await this.credStore.clearOauthAccount();
        changed = true;
      }
      await this.finishIntent();
      this.auditRecovery(
        pending.targetId,
        pending.prevActiveId,
        `${mode === 'undo' ? 'undid' : 'recovered'} a switch whose live write had not landed`,
      );
      return changed
        ? { recovered: true, action: 'rolled_back', detail: 'restored the previous live identity' }
        : { recovered: true, action: 'cleared', detail: 'the live write had not landed' };
    }

    // 3. The identity names the target: the live token is the target's, rotated since.
    if (target !== undefined && namesTarget) {
      if (mayForward) return this.rollForward(pending, target, false);
      await this.adoptRotationIfNeeded(pending.targetId, live, liveIdentity);
      return this.rollBack(pending, prior, mode);
    }

    // 4. A login written after the switch touched the live files: keep it, change no bundle, and
    //    withdraw the identity block unless it too post-dates the switch's own identity write.
    const identityPostdates = pending.phase === 'written';
    if (!identityPostdates) await this.credStore.clearOauthAccount();
    await this.finishIntent();
    this.log.warn(
      { targetId: pending.targetId, prevActiveId: pending.prevActiveId },
      identityPostdates
        ? 'the live login was written after an unfinished switch; it was left in place'
        : 'the live login after an unfinished switch could not be attributed; its identity block ' +
            'was removed so Claude Code re-derives it, and no bundle was changed',
    );
    this.auditRecovery(
      pending.prevActiveId,
      null,
      `left a later live login in place${identityPostdates ? '' : ' and removed its identity block'}`,
    );
    return {
      recovered: true,
      action: 'cleared',
      detail: identityPostdates
        ? 'a login written after the switch was left in place'
        : 'the live login could not be attributed; its identity block was removed',
    };
  }

  /** The previous live login a pending switch recorded in its snapshot. A switch that found no
   *  credentials recorded none: no credentials, identity unknown. A snapshot that should exist but
   *  is missing or cannot be decrypted is `undefined` — nothing is known — and is logged: settling
   *  must not fail every later operation on a snapshot it can never read. */
  private async readPriorLive(pending: SwitchIntent): Promise<PriorLive | undefined> {
    if (!pending.hasRollback) return { creds: undefined, identity: null };
    try {
      const snapshot = await this.vault.readRollback();
      if (snapshot === undefined) return undefined;
      return { creds: snapshot.claudeAiOauth, identity: snapshot.oauthAccount };
    } catch (err) {
      this.log.error(
        { reason: errorReason(err) },
        'the rollback snapshot of an unfinished switch could not be read',
      );
      return undefined;
    }
  }

  /** Complete a pending switch whose target's credentials are live: its identity (unless the live
   *  one already names it), then the registry commit — what the switch itself would have done next. */
  private async rollForward(
    pending: SwitchIntent,
    target: CredentialBundle,
    writeIdentity: boolean,
  ): Promise<RecoverResult> {
    if (writeIdentity) await this.writeLiveIdentity(target.oauthAccount);
    await this.vault.setActive(pending.targetId);
    this.auditRecovery(pending.prevActiveId, pending.targetId, 'rolled forward');
    await this.finishIntent();
    return { recovered: true, action: 'rolled_forward', detail: `committed ${pending.targetId}` };
  }

  /**
   * Put the previous login back and clear the intent. Identity FIRST, then credentials — the reverse
   * of the switch's own order, so failing part way leaves the half-state the switch itself passes
   * through (the target's credentials under the previous identity), which the still-pending intent
   * settles next time. The other order could leave the previous account's token under the TARGET's
   * identity, a state nothing recorded describes. A previous login that is not known (its snapshot
   * missing or unreadable) is treated as nobody logged in: the target is taken out, which loses
   * nothing, since both accounts' vault copies are current.
   */
  private async rollBack(
    pending: SwitchIntent,
    prior: PriorLive | undefined,
    mode: 'recover' | 'undo',
  ): Promise<RecoverResult> {
    const identity = prior === undefined || prior.identity === null ? undefined : prior.identity;
    await this.writeLiveIdentity(identity);
    if (prior?.creds !== undefined) await this.credStore.writeLiveCredentials(prior.creds);
    else await this.credStore.clearLiveCredentials();
    await this.finishIntent();
    const what = prior?.creds !== undefined ? 'rolled back' : 'removed the target login';
    this.auditRecovery(
      pending.targetId,
      pending.prevActiveId,
      `${mode === 'undo' ? 'undid a failed switch: ' : ''}${what}`,
    );
    return prior?.creds !== undefined
      ? { recovered: true, action: 'rolled_back', detail: 'restored previous live credentials' }
      : {
          recovered: true,
          action: 'rolled_back',
          detail: 'removed the target credentials; no login was live before the switch',
        };
  }

  /**
   * Put the live login back after a switch failed between its first live write and its commit, then
   * let the caller rethrow the original error. Uses the in-memory snapshot, so the undo needs no
   * decrypt. An undo that fails too is logged and leaves the intent in place — the next locked
   * operation settles it ({@link settlePendingSwitchLocked}) — rather than replacing the error the
   * caller must see.
   */
  private async undoFailedSwitch(
    pending: SwitchIntent,
    prior: PriorLive,
    cause: unknown,
  ): Promise<void> {
    try {
      const result = await this.settleSwitch(pending, 'undo', prior);
      this.log.warn(
        { targetId: pending.targetId, reason: errorReason(cause), undo: result.action },
        'switch failed after its live write; the previous login was put back',
      );
    } catch (undoErr) {
      this.log.error(
        {
          targetId: pending.targetId,
          reason: errorReason(cause),
          undoReason: errorReason(undoErr),
        },
        'switch failed after its live write and could not be undone; it stays pending until the ' +
          'next locked operation settles it',
      );
    }
  }

  /** Append a recovery entry to the audit trail — always origin `recovery`, never the origin the
   *  interrupted switch was asked with, since nothing here was a deliberate switch request. */
  private auditRecovery(from: string | null, to: string | null, detail: string): void {
    this.audit.append({
      ts: this.clock(),
      event: 'recovered',
      fromAccountId: from,
      toAccountId: to,
      detail,
      origin: 'recovery',
    });
  }

  /**
   * Login tokens the files show are attributed to the wrong account — report-only, for `cctl doctor`.
   *
   *   - The live credentials are one stored account's token while the live identity block names
   *     another: everything that goes by the identity block misjudges who is live. The next switch
   *     rewrites both live files (and rotation adoption refuses the token meanwhile). Not reported
   *     while a switch is pending — the next locked operation settles that on its own.
   *   - A refresh token stored under two accounts: the state a mis-attributed rotation adoption
   *     leaves behind. The files cannot say which bundle is wrong, so the fix is a re-login of the one
   *     that is (or removing a login stored twice).
   *
   * Read-only apart from keeping the token-fingerprint cache current (see tokenPrints.ts), and
   * unlocked like the other reads: a switch landing mid-check can at worst produce a stale answer.
   */
  async findTokenConflicts(): Promise<TokenConflict[]> {
    const accounts = await this.vault.listAccounts();
    const stored = await this.vault.readStoredTokens();
    const labelOf = (id: string): string => accounts.find((a) => a.id === id)?.label ?? id;
    const out: TokenConflict[] = [];

    if ((await this.intent.read()) === undefined) {
      const mismatch = await this.liveTokenMismatch(accounts, stored);
      if (mismatch !== undefined) {
        const named =
          mismatch.namedId !== undefined
            ? `"${labelOf(mismatch.namedId)}"`
            : `an account that is not stored here (${mismatch.namedUuid})`;
        const owner = labelOf(mismatch.ownerId);
        out.push({
          kind: 'live_identity_mismatch',
          accountIds:
            mismatch.namedId !== undefined
              ? [mismatch.ownerId, mismatch.namedId]
              : [mismatch.ownerId],
          detail:
            `the live login is "${owner}"'s token under the identity of ${named}; ` +
            `\`cctl switch ${owner}\` rewrites both live files`,
        });
      }
    }

    for (const ids of stored.sharedTokens()) {
      out.push({
        kind: 'duplicate_stored_token',
        accountIds: ids,
        detail:
          `accounts ${ids.map((id) => `"${labelOf(id)}"`).join(' and ')} store the same login ` +
          'token: either one login was stored twice (remove the extra account) or one of them holds ' +
          "the other's token (re-login that one: cctl accounts relogin <label>)",
      });
    }
    return out;
  }

  /**
   * The stored account whose token is live, when the live identity block provably contradicts it:
   * the token decides, since it is the one artifact that cannot be stale. `undefined` when the live
   * token is no stored account's, or the identity agrees with it (or names no uuid). An owner with no
   * recorded uuid beside a block naming an account that is not stored is not treated as a
   * contradiction: that is most likely Claude Code's own re-derived block for that very login.
   */
  private async liveTokenMismatch(
    accounts: StoredAccount[],
    stored: StoredTokens,
  ): Promise<{ ownerId: string; namedId?: string; namedUuid: string } | undefined> {
    const live = await this.credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return undefined;
    const holders = stored.holdersOf(live);
    if (holders.length === 0) return undefined;
    const identity = await this.credStore.readOauthAccount().catch(() => undefined);
    const uuid = anchorValue(identity?.accountUuid);
    if (uuid === undefined) return undefined;
    const named = accounts.find((a) => a.accountUuid === uuid);
    const ownerId = named !== undefined && holders.includes(named.id) ? named.id : holders[0]!;
    const ownerUuid = accounts.find((a) => a.id === ownerId)?.accountUuid;
    const contradicted = named !== undefined ? named.id !== ownerId : ownerUuid !== undefined;
    if (!contradicted) return undefined;
    return named !== undefined
      ? { ownerId, namedId: named.id, namedUuid: uuid }
      : { ownerId, namedUuid: uuid };
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

    // Ownership guards, run only now that a write is otherwise decided (they are the expensive part).
    const refusal = await this.adoptionRefusal(prevActiveId, prevUuid, liveNow, liveOauthAccount);
    if (refusal !== undefined) {
      this.log.warn({ prevActiveId, reason: refusal }, 'refused to adopt the live token');
      this.audit.append({
        ts: this.clock(),
        event: 'adoption_refused',
        fromAccountId: prevActiveId,
        toAccountId: prevActiveId,
        detail: refusal,
      });
      return false;
    }

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

  /**
   * Why the live token must NOT be stored under `prevActiveId`, or `undefined` when nothing forbids
   * it. Adoption trusts the live identity block to say whose token is live; these are the cases where
   * the files themselves show that block cannot be trusted with it, and each refusal leaves every
   * bundle exactly as it was:
   *
   *   - The live token is another stored account's own token (either of its two tokens). A token is
   *     issued to one account, so it is that account's login, whatever the identity block says — the
   *     signature of a switch torn between its two live writes. Storing it here would put one
   *     single-use token in two bundles and destroy this account's own.
   *   - The live identity block is missing while this account's bundle carries an identity. Nothing
   *     then says whose token is live except the registry's record, and cctl removes the block
   *     precisely when it cannot tell (an unfinished switch it could not attribute) — Claude Code
   *     re-derives it from the token, after which adoption proceeds on the evidence. A block that is
   *     present but names no uuid is still a statement by the login and is judged as before.
   *
   * A rotation the refusal holds back is not lost for good: it stays live until the next switch
   * overwrites it, and a re-login recovers the account if that happens first. Crediting it to the
   * wrong account could never be undone.
   */
  private async adoptionRefusal(
    prevActiveId: string,
    prevUuid: string | undefined,
    liveNow: ClaudeOauth,
    liveOauthAccount: OauthAccount | undefined,
  ): Promise<string | undefined> {
    if (prevUuid !== undefined && liveOauthAccount === undefined) {
      return "the live login names no account, so its token cannot be shown to be this account's";
    }
    const others = (await this.vault.readStoredTokens())
      .holdersOf(liveNow)
      .filter((id) => id !== prevActiveId);
    if (others.length > 0) {
      return `the live token is stored for another account (${others.join(', ')})`;
    }
    return undefined;
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
