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
//      first live write and the commit undoes the switch: the prior live login (credentials AND
//      identity) goes back, unless another writer's token has landed meanwhile, which is kept live
//      and credited to nobody.
//   5. A write-ahead intent per slot makes every step crash-recoverable: `recover()` at startup,
//      and every locked operation settles the pending switch of each slot it touches first. One
//      that cannot be settled yet refuses what depends on it, never everything.
//   6. A token two stored accounts hold is never seated in any slot, nor credited to either of them.
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
  SharedTokenError,
  SlotError,
  SwitchFailedError,
  UnknownAccountError,
  UnsettledSwitchError,
  type FailedSwitchOutcome,
  VaultError,
  VerifyError,
} from './errors.js';
import { IntentStore } from './intent.js';
import { LOCK_STALE_MS, acquireLock, type Lock, type LockOptions } from './lock.js';
import { noopLogger, type Logger } from './logger.js';
import {
  DEFAULT_REFRESH_SKEW_MS,
  exchangeAuthorizationCode as defaultExchange,
  refreshCredentials as defaultRefresh,
  type ExchangeDeps,
  type RefreshDeps,
} from './oauth.js';
import { folderBindingsPath, groupProfileDir, profilesRoot, type Paths } from './paths.js';
import { atomicWriteFile, removeIfExists } from './fsutil.js';
import { canonicalizeFolder, checkBindTarget, folderKey, isWithin } from './folderPath.js';
import { createNodeProfileFs, ensureGroupProfile, planGroupProfile } from './profile.js';
import {
  buildFolderBindingSnapshot,
  folderBindingSnapshotContentEqual,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
} from './folderBindings.js';
import {
  allSlots,
  assignDistinct,
  availableInOrder,
  exactFolderRule,
  legitimateOccupancy,
  liveElsewhere,
  resolveFolderRule,
  rulesIncluding,
  slotMayHold,
  slotPool,
  withRule,
  type RulesPicture,
} from './folderRules.js';
import { readdir, readFile, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { ruleIdOfSlot, ruleSlotId } from './types.js';
import type {
  AccountView,
  ActivateResult,
  ClaudeOauth,
  CredentialBundle,
  ExcludeResult,
  FolderBindingSnapshot,
  FolderRule,
  IncludeResult,
  OauthAccount,
  PoolEntry,
  RecoverResult,
  RefreshTokenResult,
  ReloginResult,
  RepairResult,
  ResetResult,
  RuleLiveResult,
  RunningSession,
  SlotHandOff,
  SlotId,
  SlotLiveToken,
  SlotViolation,
  StoredAccount,
  SwitchIntent,
} from './types.js';
import { needsMetadataBackfill, Vault, type DedupeReport, type RegistryPicture } from './vault.js';
import { tokenPrints, type StoredTokens } from './tokenPrints.js';

/** The filesystem seam the folder-rule verbs ({@link SwitchEngine.includeInFolder} and its
 *  siblings) use to canonicalize a folder and check it is a real directory. Injected (never read from `node:*`
 *  directly in the method bodies) so a test can bind a sandbox directory and control what counts as
 *  the home dir, exactly as the rest of the engine funnels IO through seams. */
export interface BindFs {
  /** `fs.realpathSync.native` equivalent: the true on-disk path (resolving junctions/symlinks/8.3/
   *  case), or THROWS when the path does not exist. */
  realpath: (path: string) => string;
  /** True when the path exists and is a directory. */
  isDirectory: (path: string) => boolean;
  /** Base dir a relative folder is resolved against (`process.cwd()`). */
  cwd: () => string;
  /** The user's home directory (`os.homedir()`), refused as a rule folder. */
  homedir: () => string;
}

/** The default {@link BindFs}, backed by `node:fs` / `node:os` / `process`. */
function defaultBindFs(): BindFs {
  return {
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    cwd: () => process.cwd(),
    homedir: () => homedir(),
  };
}

/** The default process-liveness probe: a signal-0 existence check (kills nothing). ESRCH means the
 *  pid is gone; EPERM means it exists but is not ours (still alive). Injected via
 *  {@link SwitchEngineOptions.isProcessAlive} so session detection is deterministic in tests. */
function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

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
  /** Selects the platform rules that differ across slots: the folder-key case fold the vault uses
   *  to tell rule folders apart, the profiles-root containment check that refuses a capture inside a
   *  profile, and the macOS refusal of rule slots (per-config-dir Keychain slots are not built
   *  yet). A parameter rather than a `process.platform` read so a test can drive either OS. */
  platform?: NodeJS.Platform;
  /** Filesystem seam for folder canonicalization in the rule verbs. Defaults to a `node:fs`-backed
   *  one; tests inject a sandbox-aware version (notably a controlled home dir). */
  bindFs?: BindFs;
  /** Process-liveness probe for the running-session scan. Defaults to a signal-0 check; tests inject
   *  a deterministic one. */
  isProcessAlive?: (pid: number) => boolean;
  /** The enforcement mode stamped into the guard snapshot written after every rule mutation.
   *  Defaults to `'block'`. Pass a plain mode for a one-shot CLI process; pass a RESOLVER for a
   *  long-lived process (the daemon), which is called at each snapshot write so a live
   *  `cctl settings set bind-enforce <mode>` takes effect without a restart. A cached value would let
   *  a daemon-side snapshot rewrite (e.g. from repairSlots) revert an operator's live change. */
  bindEnforce?: BindEnforceMode | (() => BindEnforceMode);
  /** Fault-injection seam for the multi-step rule mutations, called at labeled checkpoints so a
   *  test can throw partway through and prove the next `ensureRuleLive`/`repairSlots` converges.
   *  Undefined in production, where every checkpoint is a zero-cost no-op. */
  faultAt?: (checkpoint: string) => void;
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
  /** The slot this activation must land in. OMITTED, the slot follows from the registry (a shared
   *  account → global; a reserved account → the slot of the rule including it, or the one it is
   *  live in when several do). Named, it may be any slot whose pool holds the target — a rule's slot
   *  takes its included accounts and the shared accounts it does not exclude — and a slot whose pool
   *  does not is refused rather than silently replaced: it is how a caller asserts "activate this
   *  account in THIS slot" and gets told when that is impossible (a reserved account can never be
   *  global; an excluded or foreign account never in that rule's slot). */
  slot?: SlotId;
}

/** Default minimum interval between switches — see `minSwitchIntervalMs`. */
export const DEFAULT_MIN_SWITCH_INTERVAL_MS = 60_000;

/** A thrown value reduced to one loggable line. The message only — a stack in a log field says
 *  nothing an operator can act on about an IO failure, and a non-Error throw still has to render
 *  as something rather than `[object Object]`. */
function errorReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A slot's live login as it was before a switch wrote over it: what undoing that switch puts back. */
interface PriorLive {
  /** The credentials the slot held (`undefined`: it held none). */
  creds: ClaudeOauth | undefined;
  /** The identity block it held. `null` when it was not recorded — a slot that held no credentials
   *  leaves no snapshot to record it in — which an undo treats as "remove whatever is there now":
   *  with no credentials beside it, an absent block is the one statement that cannot be wrong. */
  identity: OauthAccount | undefined | null;
}

/** One attempt at settling whatever switch is pending in a slot (see `SwitchEngine.attemptSettleLocked`). */
type SettleAttempt =
  | { kind: 'none' }
  | { kind: 'settled'; result: RecoverResult }
  | {
      kind: 'unsettled';
      /** The pending switch, or `undefined` when its record itself could not be read. */
      pending: SwitchIntent | undefined;
      error: UnsettledSwitchError;
    };

/** The remedy for one login token stored under two accounts, shared by the refusal to seat it and
 *  by the slot check's report of it. */
const SHARED_TOKEN_REMEDY =
  'either one login was stored twice (remove the extra account) or one of them holds the ' +
  "other's token (re-login that one: cctl accounts relogin <label>)";

/** Labels of `ids` as a quoted list for a message, falling back to the id for an unknown row. */
function quotedLabels(ids: readonly string[], rows: readonly StoredAccount[]): string {
  return ids.map((id) => `"${rows.find((a) => a.id === id)?.label ?? id}"`).join(' and ');
}

/** Error codes of a write another program refused: on Windows a file some process holds open
 *  (EPERM/EBUSY, see fsutil's isTransientRenameError) or one marked read-only (EPERM/EACCES). */
const REFUSED_WRITE_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * The message of a {@link SwitchFailedError}, for the person who asked for the switch: what could
 * not be done (which file could not be written, or that another program wrote the live login
 * meanwhile), what the slot holds now, the likely cause and the next step. Nothing in it needs the
 * log to be understood — the underlying error stays on the error as its `cause`.
 */
function describeFailedSwitch(failure: {
  target: string;
  where: string;
  cause: unknown;
  file: string | undefined;
  outcome: FailedSwitchOutcome;
}): string {
  const { target, where, cause, file, outcome } = failure;
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  const refused = code !== undefined && REFUSED_WRITE_CODES.has(code);
  const what =
    cause instanceof VerifyError
      ? `another program wrote the live login of ${where} while the switch to "${target}" was being written`
      : file !== undefined
        ? `could not write ${file}${code !== undefined ? ` (${code})` : ''}` +
          (refused
            ? ': another program probably has it open (an editor, a backup or sync tool, ' +
              'antivirus), or it is read-only'
            : `: ${errorReason(cause)}`)
        : `the switch to "${target}" failed: ${errorReason(cause)}`;
  const now: Record<FailedSwitchOutcome, string> = {
    restored: `The switch to "${target}" was undone and the previous login was kept - nothing changed.`,
    kept_other_login:
      `The switch to "${target}" did not happen: the login written meanwhile was left in place, ` +
      'and nothing was stored from it.',
    pending:
      `The switch to "${target}" could not be undone either, so it is still pending: the next ` +
      `operation on ${where} finishes or undoes it, and \`cctl recover\` retries it now.`,
  };
  const next = refused
    ? outcome === 'pending'
      ? ' Close that program first.'
      : ' Close that program (or wait for it to finish) and try again.'
    : outcome === 'pending'
      ? ''
      : ' Try again.';
  return `${what}. ${now[outcome]}${next}`;
}

/** Whether a pending switch was between `accountId` and another account — the two accounts whose
 *  bundles settling it reads and may write. */
function involves(pending: SwitchIntent, accountId: string): boolean {
  return pending.targetId === accountId || pending.prevActiveId === accountId;
}

/** Whether two credential blocks are the same grant: both absent, or the same pair of tokens. */
function sameGrant(a: ClaudeOauth | undefined, b: ClaudeOauth | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/** What a slot's live files physically hold (see {@link SwitchEngine}'s `physicalLiveId`). */
interface PhysicalOccupant {
  /** The stored account the live login belongs to, or null (nobody, a login not stored here, or a
   *  token two stored accounts hold that the identity does not settle — see `ambiguous`). */
  id: string | null;
  hasCreds: boolean;
  /** The fingerprint of the live refresh token, when there is one: what tells the same token live in
   *  two slots apart from two logins, whoever each slot's identity names. */
  refreshPrint?: string;
  /** The identity's uuid when it names no stored account. */
  foreignUuid?: string;
  /** Set when the credentials are provably `id`'s stored token while the identity block names a
   *  different account (`identityId`, or null for a login this vault does not know). */
  mismatch?: { identityId: string | null; identityUuid: string };
  /** Set when the live token is stored under two or more accounts (`holders`) and the identity block
   *  names none of them (`identityId`, or null for an unknown or absent identity): whose token it is
   *  cannot be told from the files, so no holder is taken for the owner. */
  ambiguous?: { holders: string[]; identityId: string | null; identityUuid?: string };
}

/** A profile dir no rule owns that still holds a live login (see `orphanProfileLogins`). */
interface OrphanLogin {
  /** The dir's name — the id of the rule that once owned it. */
  name: string;
  dir: string;
  store: CredentialStore;
  occupant: PhysicalOccupant;
}

/** The refusal of a capture whose config dir is a folder profile: a {@link RefreshError} with a
 *  stable code, so the CLI can render guidance ("onboard in a throwaway dir") rather than a raw
 *  message. */
function captureInProfileError(configDir: string): RefreshError {
  return new RefreshError(
    `"${configDir}" is inside the folder profiles area; onboard a new account in a ` +
      'throwaway config dir instead of a folder profile',
    'capture_in_profile',
  );
}

/** A rule's folders as a display list, for messages ("the folder slot of <folders>"). Falls back to
 *  the rule's label for a rule that somehow holds no folder. */
function describeRule(rule: FolderRule): string {
  return rule.folders.length > 0 ? rule.folders.join(', ') : rule.label;
}

/** Structural equality of two violations — enough to tell whether a breach the repair set out to fix
 *  is still present afterward (its kind, the account/rule/slot it named). */
function sameViolation(a: SlotViolation, b: SlotViolation): boolean {
  return (
    a.kind === b.kind && a.accountId === b.accountId && a.ruleId === b.ruleId && a.slot === b.slot
  );
}

/** The rule id a slot belongs to as a violation's `ruleId` field, spread into the violation (empty
 *  for the global slot). */
function ruleField(slotId: SlotId): { ruleId?: string } {
  const ruleId = ruleIdOfSlot(slotId);
  return ruleId === undefined ? {} : { ruleId };
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

/**
 * The per-slot IO surface, derived purely from a {@link SlotId} (no vault read).
 *
 * A slot is one credential seat: a live-credential location, plus the crash-recovery state that
 * describes an in-flight switch of that seat (cadence clock, intent WAL, rollback snapshot). The
 * GLOBAL slot keeps the historical file names in the vault dir so a switch interrupted by a
 * pre-upgrade build recovers unchanged; a rule slot lives in the rule's own profile dir with its
 * state under `<vaultDir>/slots/<ruleId>/`. ONE lock (the vault-dir lock) still serialises every
 * slot — the state dirs only separate the on-disk records, never the mutual exclusion.
 */
interface SlotRuntime {
  id: SlotId;
  /** Where this slot's live `.credentials.json` / `.claude.json` are read and written. */
  credStore: CredentialStore;
  /** This slot's write-ahead switch intent. */
  intent: IntentStore;
  /** Directory holding this slot's `last-switch.json` and `.rollback.enc`. */
  stateDir: string;
  /** A rule slot's config dir (materialised by {@link ensureGroupProfile} before a write); absent
   *  for the global slot. */
  profileDir?: string;
  /** The rule id backing a rule slot; absent for the global slot. */
  ruleId?: string;
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
  /** Kept so per-slot rollback snapshots encrypt with the same protector the vault uses — a rule
   *  slot's `.rollback.enc` is as sensitive as the global one and must be sealed the same way. */
  private readonly protector: Protector;
  /** See {@link SwitchEngineOptions.platform}. Also handed to the {@link Vault} so the engine and
   *  its registry agree on the folder-key case rule. */
  private readonly platform: NodeJS.Platform;
  /** See {@link SwitchEngineOptions.bindFs}. */
  private readonly bindFs: BindFs;
  /** See {@link SwitchEngineOptions.isProcessAlive}. */
  private readonly isProcessAlive: (pid: number) => boolean;
  /** Resolves the enforcement mode at snapshot-write time. See {@link SwitchEngineOptions.bindEnforce}
   *  — a plain mode is wrapped in a constant function; a resolver is read on every write so a live
   *  settings change is honored by daemon-side writers too. */
  private readonly resolveBindEnforce: () => BindEnforceMode;
  /** See {@link SwitchEngineOptions.faultAt}. */
  private readonly faultAt: ((checkpoint: string) => void) | undefined;
  /** Per slot, the last reason a pending switch there could not be settled that this engine logged.
   *  Every operation on the slot retries the settle, so without this a long-lived process (the
   *  daemon's pollers) would log the same failure on every call; a changed reason, or a settle in
   *  between, logs again. */
  private readonly unsettledLogged = new Map<SlotId, string>();

  constructor(options: SwitchEngineOptions) {
    this.paths = options.paths;
    this.clock = options.clock ?? Date.now;
    this.log = options.logger ?? noopLogger;
    this.platform = options.platform ?? process.platform;
    this.protector = options.protector ?? defaultProtector();
    this.vault = new Vault(
      this.paths.vaultDir,
      this.protector,
      this.clock,
      this.log,
      this.platform,
    );
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
    this.bindFs = options.bindFs ?? defaultBindFs();
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
    this.resolveBindEnforce =
      typeof options.bindEnforce === 'function'
        ? options.bindEnforce
        : (
            (mode) => () =>
              mode
          )(options.bindEnforce ?? 'block');
    this.faultAt = options.faultAt;
  }

  /** Errors thrown by the fault-injection seam. See {@link fault}. */
  private readonly simulatedDeaths = new WeakSet<object>();

  /**
   * Fire the fault-injection seam at a labeled checkpoint (a no-op in production).
   *
   * A checkpoint stands for the process dying at that point, so nothing a dead process could not
   * have run may run after it: the thrown error is remembered, and every in-process undo lets such an
   * error through untouched (see {@link isSimulatedDeath}). Without that, a crash test would exercise
   * the undo instead of the crash recovery it exists to prove.
   */
  private fault(checkpoint: string): void {
    try {
      this.faultAt?.(checkpoint);
    } catch (err) {
      if (typeof err === 'object' && err !== null) this.simulatedDeaths.add(err);
      throw err;
    }
  }

  /** Whether `err` came from the fault-injection seam, i.e. stands for the process having died. */
  private isSimulatedDeath(err: unknown): boolean {
    return typeof err === 'object' && err !== null && this.simulatedDeaths.has(err);
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
  // ---- read-only rule / snapshot accessors (for the CLI's and the daemon's views) ----
  //
  // The vault is private to the engine, but the CLI and the daemon must read the folder rules to
  // render them, tag `accounts`/`usage` with them, resolve `where`, and decide per slot. These are
  // thin pass-throughs (metadata reads, no decryption, no lock) so callers reach the SAME configured
  // vault the engine already holds instead of constructing a second one with a duplicated protector.
  /** Every folder rule, in file order. */
  listRules(): Promise<FolderRule[]> {
    return this.vault.listRules();
  }
  /** One folder rule by id, or undefined. */
  getRule(id: string): Promise<FolderRule | undefined> {
    return this.vault.getRule(id);
  }
  /** The shared pool AND every reserved account in one view; each reserved row carries the ids of
   *  the rules including it. */
  listAllAccounts(): Promise<AccountView[]> {
    return this.vault.listAllAccounts();
  }
  /** The groups.json generation the snapshot is derived from — used to judge snapshot freshness. */
  getRulesGeneration(): Promise<number> {
    return this.vault.getRulesGeneration();
  }
  /** The non-secret guard snapshot as last written, or undefined when none exists yet. */
  readSnapshot(): Promise<FolderBindingSnapshot | undefined> {
    return this.vault.readFolderBindings();
  }

  /**
   * The effective pool of a slot, in pool order, with each account's liveness elsewhere: what the
   * daemon chooses a slot's account from and what the CLI shows for a folder. For the global slot,
   * the shared pool; for a rule's slot, its included accounts first, then the shared pool minus its
   * exclusions (see `folderRules.ts` for every rule of membership and order). An entry whose
   * `liveElsewhere` is set is in the pool but NOT available to this slot right now.
   *
   * An unlocked read, like {@link liveSlots}: a concurrent switch can make the answer stale by the
   * time it is used, which is why every switch re-checks candidacy under the lock.
   */
  async slotPool(slotId: SlotId): Promise<PoolEntry[]> {
    const picture = await this.vault.readPicture();
    const occupancy = await this.slotOccupancy(picture);
    return slotPool(slotId, picture, occupancy);
  }

  /** The folder rule a directory runs under — the longest rule folder containing it, no merging
   *  between nested rules — or `null` for a directory that runs on the global slot. Canonicalizes
   *  leniently: an unresolvable path simply has no rule, never an error. */
  async resolveFolderRule(cwd: string): Promise<{ ruleId: string; folder: string } | null> {
    const rules = await this.vault.listRules();
    if (rules.length === 0) return null;
    const match = resolveFolderRule(this.canonReserved(cwd), rules, this.platform);
    return match === null ? null : { ruleId: match.rule.id, folder: match.folder };
  }

  addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const account = await this.vault.addAccount(label, bundle);
      await this.refreshSnapshotForAccountsLocked();
      return account;
    });
  }
  /**
   * Remove an account wherever it lives, and clean every rule slot it occupied.
   *
   * The vault drops the row and every rule's reference to it (dissolving a rule left with nothing
   * to include or exclude) and its bundle. On top of that, an account LIVE in a rule's slot must not
   * leave its credentials behind in the profile: a removed account whose `.credentials.json` still
   * sits live in a folder's config dir is a stale live seat nothing would ever clear. So its live
   * files are cleared, failing that slot closed (an empty config dir = not logged in — measured) until
   * the rule's self-heal seats another account; a rule this removal dissolves has its seat cleared
   * whoever holds it. The global slot is deliberately NOT cleared this way: removing the global active
   * account leaves its live files for the historical reasons the vault's own active-id clearing
   * already encodes. Removing a reserved account, or dissolving a rule, rewrites the guard snapshot.
   *
   * ORDER is the crash-safety contract, and it is the one a dissolve uses: adopt the seat's rotation,
   * clear the seat, THEN drop the row. Dying after the clear leaves the account whole (row, bundle
   * holding its latest token) with an empty seat the rule re-fills, and a rerun completes the
   * removal. The reverse order leaves the removed login live in the profile — and when the removal
   * dissolved the rule, in a profile no slot owns, which nothing else would ever clear.
   */
  removeAccount(id: string): Promise<void> {
    return this.withCredentialLock(async () => {
      // A pending switch to or from this account needs its bundle to be settled correctly; one that
      // cannot be settled yet refuses the removal.
      const untrusted = await this.settleForAccountsLocked([id]);
      const picture = await this.vault.readPicture();
      const reserved = picture.reserved.some((a) => a.id === id);
      const dissolving = picture.rules.filter(
        (r) =>
          (r.include.includes(id) || r.exclude.includes(id)) &&
          r.include.every((x) => x === id) &&
          r.exclude.every((x) => x === id),
      );
      const stored = await this.vault.readStoredTokens();
      let cleared = false;
      for (const rule of picture.rules) {
        const slotId = ruleSlotId(rule.id);
        // Live by its token as much as by the identity block: a seat holding its token under another
        // account's identity is still its seat.
        const owners = await this.possibleLiveOwners(slotId, stored);
        if (!owners.has(id) && !dissolving.includes(rule)) continue;
        const rt = this.slotRuntime(slotId);
        // Whatever rotation the seat holds reaches the vault first, so dying between here and the
        // row drop never costs an account its latest token — unless a switch left there unsettled
        // makes the live login untrustworthy, when nothing is adopted from it.
        if (!untrusted.has(slotId)) await this.adoptSlotRotation(rt);
        await this.clearSlotLive(rt);
        cleared = true;
      }
      if (cleared) this.fault('remove:after-clear-live');
      await this.vault.removeAccount(id);
      this.fault('remove:after-registry-drop');
      // A dissolved rule's slot no longer exists: drop its recovery state too, so no intent is left
      // behind for a slot nothing will ever walk again (the same cleanup a reset's dissolve does).
      for (const rule of dissolving)
        await this.clearSlotState(this.slotRuntime(ruleSlotId(rule.id)));
      // The guard names a rule's included accounts and enforces its folders; a removal changed one or
      // both. Written LAST, like every other rule mutation. Any other removal still drops an account
      // the guard can name the global slot by.
      if (reserved || dissolving.length > 0) await this.writeSnapshotLocked();
      else await this.refreshSnapshotForAccountsLocked();
    });
  }
  renameAccount(id: string, label: string): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const renamed = await this.vault.renameAccount(id, label);
      // Every stored account's label is part of what the guard's messages show.
      await this.refreshSnapshotForAccountsLocked();
      return renamed;
    });
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
      const report = await this.withCredentialLockIfFree(async () => {
        const r = await this.vault.dedupeAccounts();
        // A merge or a relabel can change a reserved account's label, which the guard names.
        if (r.merged.length > 0 || r.relabelled.length > 0)
          await this.refreshSnapshotIfStaleLocked();
        return r;
      });
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

  // ---- slots ----

  /**
   * The per-slot IO surface for a {@link SlotId}. PURE — no vault read, so it is safe to build
   * anywhere (inside or outside the lock) and cannot itself change state. The global slot reuses
   * the engine's own credential store and the vault dir (historical file names); a rule slot is
   * addressed by the profile dir its id names, with its recovery state under `<vaultDir>/slots/<id>`.
   */
  private slotRuntime(slotId: SlotId): SlotRuntime {
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined) {
      return {
        id: slotId,
        credStore: this.credStore,
        intent: this.intent,
        stateDir: this.paths.vaultDir,
      };
    }
    const profileDir = groupProfileDir(this.paths.vaultDir, ruleId);
    // A rule slot is always FILE-based: it never uses the darwin Keychain channel (rule slots are
    // refused on macOS), so a plain CredentialStore over the profile dir is the whole story.
    const credStore = this.configDirStore(profileDir);
    const stateDir = join(this.paths.vaultDir, 'slots', ruleId);
    return {
      id: slotId,
      credStore,
      intent: new IntentStore(stateDir),
      stateDir,
      profileDir,
      ruleId,
    };
  }

  /**
   * The slot an activation that names none goes to. A shared account goes to the global slot — the
   * historical meaning of "switch to it"; a rule's slot takes a shared account only when the caller
   * names that slot. A reserved account goes to its rule's slot; one several rules include goes to
   * the slot it is live in, and with none of them live there is no single answer, so the caller is
   * told to name the folder rather than have one picked for it.
   */
  private async defaultSlotFor(target: StoredAccount, picture: RulesPicture): Promise<SlotId> {
    const including = rulesIncluding(target.id, picture.rules);
    if (including.length === 0) return 'global';
    if (including.length === 1) return ruleSlotId(including[0]!.id);
    for (const rule of including) {
      const slotId = ruleSlotId(rule.id);
      if ((await this.getActiveId(slotId)) === target.id) return slotId;
    }
    throw new SlotError(
      `account "${target.label}" is included by several folder rules ` +
        `(${including.map(describeRule).join('; ')}); name the folder slot to switch it in`,
      'slot_ambiguous',
    );
  }

  /** The registry side of one slot: the id it last recorded as active, and the accounts a live login
   *  there is recognized as. Global = `{ vault.activeId, shared pool }`. A rule slot recognizes ANY
   *  stored account (shared or reserved): an account outside the rule's pool that is live there is
   *  still that account, and naming it is what lets its rotation be adopted before it is moved off and
   *  the slot check report it. Its recorded id counts only while it names a stored account. A rule
   *  that no longer exists yields `{ null, [] }` — nothing can be live in a slot with no registry
   *  backing. */
  private async slotRegistry(
    slotId: SlotId,
  ): Promise<{ registryId: string | null; candidates: StoredAccount[] }> {
    const picture = await this.vault.readPicture();
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined)
      return { registryId: picture.activeId, candidates: [...picture.shared] };
    const rule = picture.rules.find((r) => r.id === ruleId);
    if (!rule) return { registryId: null, candidates: [] };
    const candidates = [...picture.shared, ...picture.reserved];
    const registryId = candidates.some((a) => a.id === rule.activeId) ? rule.activeId : null;
    return { registryId, candidates };
  }

  /** Every slot that has a registry backing: the global slot plus one per rule. The set
   *  {@link liveSlots}, {@link recover}, and {@link liveSlotOf} walk. */
  private async allSlotIds(): Promise<SlotId[]> {
    return allSlots(await this.vault.listRules());
  }

  /**
   * The slot an account is live in RIGHT NOW (reconciled), or undefined when it is live nowhere.
   *
   * Walks every slot: an account may legitimately be live in the global slot or any rule slot whose
   * pool holds it, and the whole point is also to catch one live where it should not be, so that
   * {@link refreshToken} never network-refreshes a token some session is holding and a re-login heals
   * the seat the account actually occupies. Short-circuits on the first hit — the invariant is that
   * there is at most one.
   */
  private async liveSlotOf(accountId: string): Promise<SlotId | undefined> {
    for (const slotId of await this.allSlotIds()) {
      if ((await this.getActiveId(slotId)) === accountId) return slotId;
    }
    return undefined;
  }

  /**
   * Every account a slot's live login may belong to: the one {@link getActiveId} names (the identity
   * block, reconciled with the registry) and every stored account whose bundle holds the live token.
   * The two disagree exactly when the slot is torn — one account's token under another's identity,
   * which a switch nothing recorded (an older build's failed identity write, a copy made by hand)
   * leaves behind — and a decision about whom to move off a slot, or whose seat to clear, must then
   * treat both as live: the token is what a session spends, the identity is what every reader
   * believes. A token no bundle stores (rotated since it was stored) leaves the identity as the best
   * evidence there is. A slot with no live credentials holds nobody, whatever its records say.
   *
   * `stored` lets a caller walking every slot read the stored tokens once.
   */
  private async possibleLiveOwners(slotId: SlotId, stored?: StoredTokens): Promise<Set<string>> {
    const owners = new Set<string>();
    const live = await this.slotRuntime(slotId)
      .credStore.readLiveCredentials()
      .catch(() => undefined);
    if (live === undefined) return owners;
    const byIdentity = await this.getActiveId(slotId);
    if (byIdentity !== null) owners.add(byIdentity);
    const tokens = stored ?? (await this.vault.readStoredTokens());
    for (const id of tokens.holdersOf(live)) owners.add(id);
    return owners;
  }

  /**
   * Who is live in every slot right now ({@link possibleLiveOwners}), in slot order — the
   * {@link SlotOccupancy} every "available to this slot" decision reads. The stored tokens are read
   * once for the whole walk.
   */
  private async slotOccupancy(picture: RulesPicture): Promise<Map<SlotId, Set<string>>> {
    const stored = await this.vault.readStoredTokens();
    const occupancy = new Map<SlotId, Set<string>>();
    for (const slotId of allSlots(picture.rules)) {
      occupancy.set(slotId, await this.possibleLiveOwners(slotId, stored));
    }
    return occupancy;
  }

  /** The slot whose live credentials hold exactly this refresh token, whoever its identity block
   *  names, or undefined. A plain read of each slot's credentials file — no decrypt. */
  private async slotHoldingRefreshToken(refreshToken: string): Promise<SlotId | undefined> {
    for (const slotId of await this.allSlotIds()) {
      const live = await this.slotRuntime(slotId)
        .credStore.readLiveCredentials()
        .catch(() => undefined);
      if (live?.refreshToken === refreshToken) return slotId;
    }
    return undefined;
  }

  /**
   * Clear a RULE slot's live seat: remove its `.credentials.json` and drop the `oauthAccount`
   * block, so the slot fails closed (an empty config dir is "not logged in" — measured). A no-op for
   * the global slot, which is never cleared this way. The profile dir itself is kept (its shared
   * links and history survive an account's removal or a rule's dissolution).
   */
  private async clearSlotLive(rt: SlotRuntime): Promise<void> {
    if (rt.profileDir === undefined) return;
    await removeIfExists(join(rt.profileDir, '.credentials.json'));
    await rt.credStore.clearOauthAccount();
  }

  /** Adopt into the vault whatever rotation the account live in `rt` holds — the reconcile-by-reading
   *  a switch does — ahead of clearing that seat, so clearing never costs an account its latest token.
   *  Returns whether it adopted. The caller has settled the slot (an untrusted one is never read). */
  private async adoptSlotRotation(rt: SlotRuntime): Promise<boolean> {
    const liveAccount = await this.getActiveId(rt.id);
    const liveNow = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const liveOauth = await rt.credStore.readOauthAccount().catch(() => undefined);
    return this.adoptRotationIfNeeded(liveAccount, liveNow, liveOauth);
  }

  /** The reconciled live account of every slot — the doctor/daemon view of "who is where". */
  async liveSlots(): Promise<Map<SlotId, string | null>> {
    const out = new Map<SlotId, string | null>();
    for (const slotId of await this.allSlotIds()) {
      out.set(slotId, await this.getActiveId(slotId));
    }
    return out;
  }

  /**
   * The LIVE token from the slot an account is currently live in, or `undefined` when the account is
   * not live in any slot. The live `.credentials.json` is the freshest copy of a slot-live account's
   * token — a running session rotates it ahead of the vault bundle — and it must never be
   * network-refreshed (its single-use refresh token belongs to that session). The daemon's poll-token
   * getter uses this so an account live in a rule slot is polled with its own fresh token instead of
   * falling back to the global tier-0 cache, which only ever describes the global account.
   */
  async liveSlotToken(accountId: string): Promise<SlotLiveToken | undefined> {
    let slotId: SlotId | undefined;
    for (const [sid, live] of await this.liveSlots()) {
      if (live === accountId) {
        slotId = sid;
        break;
      }
    }
    if (slotId === undefined) return undefined;
    const rt = this.slotRuntime(slotId);
    const creds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    if (!creds) return undefined;
    const oauth = await rt.credStore.readOauthAccount().catch(() => undefined);
    return {
      slot: slotId,
      accessToken: creds.accessToken,
      expiresAt: creds.expiresAt,
      ...(oauth?.accountUuid !== undefined ? { accountUuid: oauth.accountUuid } : {}),
    };
  }

  /** The config dir sessions of a slot run in: a rule slot's profile dir, or `undefined` for the
   *  global slot (the main config dir and its live login). Pure. */
  configDirForSlot(slotId: SlotId): string | undefined {
    const ruleId = ruleIdOfSlot(slotId);
    return ruleId === undefined ? undefined : groupProfileDir(this.paths.vaultDir, ruleId);
  }

  /**
   * The config dir a managed spawn should run in for `accountId`: the profile of the rule slot it is
   * live in; else, for an account exactly one rule includes, that rule's profile (where it belongs);
   * else `undefined` — a shared account runs in the global/main config dir and inherits the global
   * live login. This is the `configDirForAccount` seam the daemon wires into the Agent SDK client, so
   * a session's per-request credential reads come from the slot the account is in.
   */
  async configDirForAccount(accountId: string): Promise<string | undefined> {
    const live = await this.liveSlotOf(accountId);
    if (live !== undefined) return this.configDirForSlot(live);
    const including = rulesIncluding(accountId, await this.vault.listRules());
    return including.length === 1 ? this.configDirForSlot(ruleSlotId(including[0]!.id)) : undefined;
  }

  /**
   * The slot a session's launch-time `CLAUDE_CONFIG_DIR` names: the rule whose profile dir the config
   * dir canonically equals, else the global slot. An absent, main, or unrecognized dir maps to
   * global. Canonicalized so a case difference or trailing separator still matches on Windows.
   */
  async slotForConfigDir(configDir: string | null | undefined): Promise<SlotId> {
    if (configDir === undefined || configDir === null || configDir === '') return 'global';
    const key = folderKey(this.canonReserved(configDir), this.platform);
    for (const rule of await this.vault.listRules()) {
      const profileKey = folderKey(
        this.canonReserved(groupProfileDir(this.paths.vaultDir, rule.id)),
        this.platform,
      );
      if (key === profileKey) return ruleSlotId(rule.id);
    }
    return 'global';
  }

  // ---- folder rules (include / exclude / reset / ensure-live) ----
  //
  // These are the operator-facing verbs that create, edit, tear down, and self-heal a folder rule.
  // Each runs the WHOLE operation under one credential lock (so nothing else moves an account
  // mid-way) and reaches the vault + slot internals directly, exactly as the switch state machine
  // does — it must NOT call the public `activate()`, which re-acquires the (non-reentrant) lock and
  // would deadlock. Every refusal happens before anything moves; past that, the step ORDER is the
  // crash-safety contract (see each method) and every step is idempotent, so a crash anywhere leaves
  // a state a rerun, the next `ensureRuleLive` or `repairSlots` converges from, without an account
  // ever being live in two slots.
  //
  // No verb ever defaults an account to the one in use: every call names its accounts. A default
  // would silently reserve the account currently live, and halt every other folder using it.

  /**
   * Include accounts in a folder's rule, creating the rule (and its profile and slot) when the folder
   * has none. In order:
   *   1. canonicalize + validate the folder; resolve the accounts; run every refusal the registry
   *      write would make (caps, folder conflicts, unknown accounts) — nothing has moved yet.
   *   2. hand off: an account this moves from the shared pool to the reserved side must be live in no
   *      slot that may not hold it afterwards. The global slot never holds a reserved account, and
   *      another rule's slot holds it only if that rule includes it — each such slot is moved onto
   *      the best account still available to it, refusing (nothing changed) when one has none.
   *   3. write the rule (groups.json first, then accounts.json — the vault's reservation order).
   *   4. materialize the profile and make the slot live, preferring an included account: a
   *      deliberate include puts the folder on its own account at once, as a new rule would.
   *   5. write the guard snapshot LAST.
   * An account another rule already reserves is just added (those folders share it); one this rule
   * excluded moves from its exclude list to its include list.
   */
  async includeInFolder(
    folder: string,
    accountIds: readonly string[],
    opts: { label?: string } = {},
  ): Promise<IncludeResult> {
    this.refuseRuleSlotsOnDarwin();
    const canonicalFolder = this.canonicalizeBindFolder(folder);
    const requestedIds = this.requireAccountIds(accountIds, 'include');
    const label = opts.label !== undefined ? { label: opts.label } : {};
    // Fingerprint the stored bundles before the lock, as activate() does: the hand-off below checks
    // every slot's live token against every stored one under it.
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const requested = await this.resolveRequested(requestedIds);
      // Who is live where decides the hand-off, so a switch left in a slot these accounts may be in
      // is settled first — and the include refused while one to or from them cannot be.
      await this.settleForAccountsLocked(requestedIds);
      const picture = await this.vault.readPicture();
      const existing = exactFolderRule(canonicalFolder, picture.rules, this.platform);
      if (existing) {
        await this.vault.checkInclude(existing.id, requestedIds);
        // The rule's own slot is written last (ensure-live); a switch stuck there would refuse that
        // only after the registry and the other slots had moved, so it refuses here instead.
        await this.requireSettledLocked(this.slotRuntime(ruleSlotId(existing.id)));
      } else {
        await this.vault.checkCreateRule({
          folders: [canonicalFolder],
          include: requestedIds,
          ...label,
        });
      }

      const reserving = requested.filter((a) => picture.shared.some((s) => s.id === a.id));
      const ownSlot = existing !== undefined ? ruleSlotId(existing.id) : undefined;
      const handedOff = await this.handOffLocked(reserving, picture, ownSlot);
      this.fault('include:after-hand-off');

      let rule: FolderRule;
      let unexcluded: string[] = [];
      if (existing) {
        const res = await this.vault.includeAccounts(existing.id, requestedIds);
        rule = res.rule;
        unexcluded = res.unexcluded;
      } else {
        rule = await this.vault.createRule({
          folders: [canonicalFolder],
          include: requestedIds,
          ...label,
        });
      }
      this.fault('include:after-row-move');

      const live = await this.ensureRuleLiveLocked(rule, { preferIncluded: true });
      this.fault('include:after-ensure-live');
      await this.writeSnapshotLocked();
      return {
        rule: (await this.vault.getRule(rule.id)) ?? rule,
        created: existing === undefined,
        reserved: reserving.map((a) => a.id),
        unexcluded,
        handedOff,
        live,
        runningSessions: await this.runningSessionsUnder([canonicalFolder]),
      };
    });
  }

  /**
   * Exclude shared accounts from a folder's pool, creating the rule (with nothing included) when the
   * folder has none: the folder then gets its own slot, so it can avoid the global live account when
   * that is one it excludes. Only a shared account can be excluded (a reserved one is refused by
   * name). When an excluded account is live in the folder's slot, the slot moves to the next account
   * available in its pool; with none left, the same rule as a dissolve applies — refused while a
   * session runs under the folder unless `force`, otherwise its rotation is adopted and the slot is
   * cleared. The rule is written before the slot moves: dying between leaves an excluded account
   * live there, which the slot check reports and the next ensure-live moves.
   */
  async excludeInFolder(
    folder: string,
    accountIds: readonly string[],
    opts: { force?: boolean; label?: string } = {},
  ): Promise<ExcludeResult> {
    this.refuseRuleSlotsOnDarwin();
    const canonicalFolder = this.canonicalizeBindFolder(folder);
    const requestedIds = this.requireAccountIds(accountIds, 'exclude');
    const label = opts.label !== undefined ? { label: opts.label } : {};
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const requested = await this.resolveRequested(requestedIds);
      await this.settleForAccountsLocked(requestedIds);
      const picture = await this.vault.readPicture();
      const existing = exactFolderRule(canonicalFolder, picture.rules, this.platform);
      if (existing) {
        await this.vault.checkExclude(existing.id, requestedIds);
        // Refused here, not after the rule write: ensure-live writes this slot (see include).
        await this.requireSettledLocked(this.slotRuntime(ruleSlotId(existing.id)));
      } else {
        await this.vault.checkCreateRule({
          folders: [canonicalFolder],
          exclude: requestedIds,
          ...label,
        });
      }

      // A new rule's slot is empty, so only an existing rule can have an excluded account live.
      let movedOff: string | null = null;
      let runningSessions: RunningSession[] = [];
      if (existing) {
        const slotId = ruleSlotId(existing.id);
        const occupancy = await this.slotOccupancy(picture);
        const owners = occupancy.get(slotId) ?? new Set<string>();
        movedOff = requested.find((a) => owners.has(a.id))?.id ?? null;
        if (movedOff !== null) {
          const after = withRule(picture, {
            ...existing,
            exclude: [...new Set([...existing.exclude, ...requestedIds])],
          });
          runningSessions = await this.refuseEmptyingWhileRunning(
            existing,
            availableInOrder(slotPool(slotId, after, occupancy)),
            `excluding "${requested.find((a) => a.id === movedOff)!.label}"`,
            opts.force === true,
          );
        }
      }

      const rule = existing
        ? (await this.vault.excludeAccounts(existing.id, requestedIds)).rule
        : await this.vault.createRule({
            folders: [canonicalFolder],
            exclude: requestedIds,
            ...label,
          });
      this.fault('exclude:after-rule-write');
      const live = await this.ensureRuleLiveLocked(rule);
      this.fault('exclude:after-ensure-live');
      await this.writeSnapshotLocked();
      return {
        rule: (await this.vault.getRule(rule.id)) ?? rule,
        created: existing === undefined,
        movedOff,
        live,
        runningSessions:
          runningSessions.length > 0
            ? runningSessions
            : await this.runningSessionsUnder(rule.folders),
      };
    });
  }

  /**
   * Remove accounts from a folder's rule, or the rule itself.
   *
   * With no accounts named, the folder leaves its rule: a rule that keeps other folders just drops
   * this one; the rule's last folder DISSOLVES it (see {@link dissolveRuleLocked}). With accounts
   * named, each must be one the rule includes or excludes. An account no rule includes any more
   * returns to the shared pool (accounts.json first, then groups.json — an interrupted release
   * reverts and a rerun completes it). A rule left with nothing to include or exclude dissolves.
   * When the slot's live account can no longer be held there (un-included while another rule still
   * reserves it), the slot moves to the next available account, or — with none — follows the dissolve
   * rule for running sessions and is cleared.
   */
  async resetFolder(
    folder: string,
    accountIds?: readonly string[],
    opts: { force?: boolean } = {},
  ): Promise<ResetResult> {
    // The folder may since have been deleted, but its rule still needs clearing.
    const canonicalFolder = this.canonicalizeBindFolder(folder, { mustExist: false });
    const requestedIds =
      accountIds === undefined ? undefined : this.requireAccountIds(accountIds, 'reset');
    return this.withCredentialLock(async () => {
      const picture = await this.vault.readPicture();
      const rule = exactFolderRule(canonicalFolder, picture.rules, this.platform);
      if (rule === undefined) {
        throw new RefreshError(`"${canonicalFolder}" has no folder rule`, 'not_ruled');
      }
      const force = opts.force === true;

      if (requestedIds === undefined) {
        if (rule.folders.length > 1) {
          // One of several folders leaves; the rule and its live slot stay intact.
          const updated = await this.vault.removeFolderFromRule(rule.id, canonicalFolder);
          await this.writeSnapshotLocked();
          return {
            folder: canonicalFolder,
            dissolved: false,
            rule: updated,
            released: [],
            adoptedRotation: false,
            runningSessions: [],
          };
        }
        return this.dissolveRuleLocked(rule, canonicalFolder, force);
      }

      const requested = await this.resolveRequested(requestedIds);
      for (const a of requested) {
        if (!rule.include.includes(a.id) && !rule.exclude.includes(a.id)) {
          throw new RefreshError(
            `account "${a.label}" is neither included nor excluded by the rule on ${describeRule(rule)}`,
            'not_in_rule',
          );
        }
      }
      const include = rule.include.filter((id) => !requestedIds.includes(id));
      const exclude = rule.exclude.filter((id) => !requestedIds.includes(id));
      if (include.length === 0 && exclude.length === 0) {
        return this.dissolveRuleLocked(rule, canonicalFolder, force);
      }

      await this.settleForAccountsLocked(requestedIds);
      const slotId = ruleSlotId(rule.id);
      // Refused here, not after the rule write: ensure-live writes this slot (see include).
      await this.requireSettledLocked(this.slotRuntime(slotId));
      const occupancy = await this.slotOccupancy(picture);
      const owners = occupancy.get(slotId) ?? new Set<string>();
      // The registry as it will be: what this rule's slot may still hold afterwards.
      const others = picture.rules.filter((r) => r.id !== rule.id);
      const released = picture.reserved.filter(
        (a) =>
          requestedIds.includes(a.id) &&
          rule.include.includes(a.id) &&
          !others.some((r) => r.include.includes(a.id)),
      );
      const after = withRule(
        {
          shared: [...picture.shared, ...released],
          reserved: picture.reserved.filter((a) => !released.includes(a)),
          rules: picture.rules,
        },
        { ...rule, include, exclude },
      );
      const leaving = requested.find((a) => owners.has(a.id) && !slotMayHold(slotId, a.id, after));
      let runningSessions: RunningSession[] = [];
      if (leaving !== undefined) {
        runningSessions = await this.refuseEmptyingWhileRunning(
          rule,
          availableInOrder(slotPool(slotId, after, occupancy)),
          `removing "${leaving.label}" from it`,
          force,
        );
      }

      const res = await this.vault.removeFromRule(rule.id, requestedIds);
      this.fault('reset:after-rule-write');
      await this.ensureRuleLiveLocked(res.rule);
      await this.writeSnapshotLocked();
      return {
        folder: canonicalFolder,
        dissolved: false,
        rule: (await this.vault.getRule(rule.id)) ?? res.rule,
        released: res.released,
        adoptedRotation: false,
        runningSessions,
      };
    });
  }

  /**
   * Remove a rule entirely. Refused (without `force`) when a session is observed running under the
   * rule's folders — the slot's live credentials are about to be cleared, and a running session would
   * lose its account. Then: adopt the slot's rotation into the vault, clear its live credentials (so
   * the slot fails closed), discard its crash-recovery state, release every account only it included
   * back to the shared pool, and keep the profile dir (its history). The snapshot is rewritten LAST.
   * A switch left in the slot that cannot be settled does not stop the dissolve — its seat and its
   * recovery state are cleared either way, which retires it — but nothing is adopted from it.
   */
  private async dissolveRuleLocked(
    rule: FolderRule,
    canonicalFolder: string,
    force: boolean,
  ): Promise<ResetResult> {
    const runningSessions = await this.runningSessionsUnder(rule.folders);
    if (runningSessions.length > 0 && !force) {
      throw new RefreshError(
        `"${canonicalFolder}" (${describeRule(rule)}) has ${runningSessions.length} running ` +
          'session(s) under it; exit them or rerun with --force',
        'sessions_running',
      );
    }
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    const untrusted = (await this.settleSlotsLocked([slotId])).has(slotId);
    const adoptedRotation = untrusted ? false : await this.adoptSlotRotation(rt);
    this.fault('reset:after-adopt');

    await this.clearSlotLive(rt);
    await this.clearSlotState(rt);
    this.fault('reset:after-clear-live');

    const { released } = await this.vault.removeRule(rule.id);
    this.fault('reset:after-release');

    await this.writeSnapshotLocked();
    return {
      folder: canonicalFolder,
      dissolved: true,
      released,
      adoptedRotation,
      runningSessions,
    };
  }

  /**
   * Ensure a rule's slot holds a working account — the self-healing verb launch, managed spawn, and
   * the daemon poll all call. Acquires the lock; see {@link ensureRuleLiveLocked} for the mechanism.
   */
  async ensureRuleLive(ruleId: string): Promise<RuleLiveResult> {
    return this.withCredentialLock(async () => {
      const rule = await this.vault.getRule(ruleId);
      if (!rule) throw new RefreshError(`no folder rule with id "${ruleId}"`, 'rule_gone');
      return this.ensureRuleLiveLocked(rule);
    });
  }

  /**
   * Make a rule's slot live, assuming the caller holds the credential lock. Idempotent.
   *
   * The account live there is KEPT when the slot may hold it (an included account, or a shared one the
   * rule does not exclude) and it is live in no other slot; only a drifted `activeId` is healed then.
   * Two cases still move a kept account: a quarantined one (a dead login, though a legitimate one) is
   * replaced by any available account and kept only when none is — reported as `noWorkingAccount`,
   * since a dead login is no working account; and `preferIncluded` (a deliberate include) moves an
   * inherited account aside for an available included one.
   *
   * Otherwise the slot is seated with the first account available in pool order — the recorded
   * `activeId` first for continuity, then the pool's auto targets, then a globally excluded shared
   * account as a last resort (see `availableInOrder`). Usage-based choice is the daemon's; this is
   * the engine's usable default. When nothing can be seated, a login that does not belong (outside
   * the pool, live in another slot too, or unrecognized) is cleared after its rotation is adopted,
   * failing the slot closed, and the rule's recorded account is cleared with it — a record naming an
   * account the slot no longer holds would have every reader that falls back on it (who is live,
   * which profile an account's session runs in) place that account in an empty slot. The rule still
   * stands, and the result says the folder has no working account.
   */
  private async ensureRuleLiveLocked(
    rule: FolderRule,
    opts: { preferIncluded?: boolean } = {},
  ): Promise<RuleLiveResult> {
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    // The profile must exist before any live read/write; idempotent, so it costs nothing steady-state.
    if (rt.profileDir !== undefined) {
      ensureGroupProfile(rt.profileDir, this.paths.claudeDir, {
        logger: this.log,
        mainClaudeJsonPath: this.paths.claudeJsonPath,
      });
    }
    // A switch left unfinished in this slot is settled before the slot is read (a no-op when none);
    // one that cannot be settled yet refuses this, since every path below may write the slot.
    await this.requireSettledLocked(rt);

    const picture = await this.vault.readPicture();
    const current = picture.rules.find((r) => r.id === rule.id) ?? rule;
    const occupancy = await this.slotOccupancy(picture);
    const pool = slotPool(slotId, picture, occupancy);
    const available = availableInOrder(pool);
    const live = await this.getActiveId(slotId);
    const liveCreds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const seated = (liveAccount: string, activated: boolean): RuleLiveResult => ({
      ruleId: rule.id,
      liveAccount,
      activated,
      noWorkingAccount: false,
    });

    // Whether the occupant may stay is judged against the other slots' LEGITIMATE copies only: a copy
    // squatting where its pool does not have it is evicted by that slot's own repair, and must not
    // cost this slot the account. A new account, below, is still chosen against every copy.
    const legitimate =
      live !== null &&
      liveCreds !== undefined &&
      slotMayHold(slotId, live, picture) &&
      liveElsewhere(slotId, live, legitimateOccupancy(occupancy, picture)) === null;
    if (legitimate) {
      const entry = pool.find((e) => e.account.id === live);
      const better =
        entry === undefined
          ? available.filter((a) => a.id !== live)
          : opts.preferIncluded === true && entry.source === 'inherited'
            ? pool
                .filter((e) => e.source === 'include' && e.liveElsewhere === null)
                .map((e) => e.account)
            : [];
      const moved = await this.seatFirst(rt, better, 'moving the folder slot to a better account');
      if (moved !== null) return seated(moved, true);
      // The live account stays. If the registry drifted from it (an external /login), commit it: adopt
      // its rotation, then record it. Not a switch — nothing live changes, and a switch's candidacy
      // checks every copy, so a squatter's copy elsewhere (the one judged irrelevant above, which its
      // own slot's repair evicts) would refuse the very account just kept.
      if (current.activeId !== live) {
        await this.adoptSlotRotation(rt);
        await this.vault.setRuleActive(rule.id, live);
      }
      // A quarantined account kept for want of any other is live, but not working.
      return { ...seated(live, false), noWorkingAccount: entry === undefined };
    }

    // Nothing legitimate is live: seat the recorded account first (continuity), then pool order.
    const recorded = available.find((a) => a.id === current.activeId);
    const order = recorded ? [recorded, ...available.filter((a) => a !== recorded)] : available;
    const filled = await this.seatFirst(rt, order, 'ensuring the folder slot has a live account');
    if (filled !== null) return seated(filled, true);

    // Nothing could be seated. Credentials still in the profile belong to an account the slot may not
    // hold, one live in another slot too, or an unrecognized login: a legitimate occupant would have
    // been kept above. Fail the slot closed rather than let a session in the folder run as an account
    // it may not use — but adopt the occupant's rotation first, so clearing costs it nothing.
    let clearedSquatter = false;
    if (liveCreds !== undefined) {
      await this.adoptSlotRotation(rt);
      await this.clearSlotLive(rt);
      clearedSquatter = true;
    }
    // The slot holds nobody now; neither may its record.
    if (current.activeId !== null) await this.vault.setRuleActive(rule.id, null);
    return {
      ruleId: rule.id,
      liveAccount: null,
      activated: false,
      noWorkingAccount: true,
      ...(clearedSquatter ? { clearedSquatter } : {}),
    };
  }

  /** Activate the first of `candidates` that will go live in `rt`'s slot, returning its id, or null
   *  when none would. One account's failure (a dead token, a transient error, a candidacy that
   *  changed) must not stop the next; a process that died mid-activation does not go on. */
  private async seatFirst(
    rt: SlotRuntime,
    candidates: readonly StoredAccount[],
    reason: string,
  ): Promise<string | null> {
    for (const account of candidates) {
      try {
        await this.activateInSlot(rt, account.id, { force: true, origin: 'recovery', reason });
        return account.id;
      } catch (err) {
        if (this.isSimulatedDeath(err)) throw err;
        this.log.warn(
          { slot: rt.id, accountId: account.id, reason: errorReason(err) },
          'account failed to activate in a folder slot; trying the next',
        );
      }
    }
    return null;
  }

  /**
   * Move every slot off the accounts an include is about to reserve, where that slot may not hold
   * them afterwards: the global slot (never a reserved account) and every other rule's slot that does
   * not include them. Each slot is moved onto an account AVAILABLE to it once the rows have moved
   * (live nowhere else), best in pool order, and no two slots onto the same one — the replacements
   * are assigned together (`assignDistinct`), so a slot is refused only when no assignment leaves it
   * one, not because an earlier slot took the account it needed while it had another to spare.
   * Every replacement is chosen, and every slot to be moved is settled, before the first one is
   * made, so a slot left with none — or one a stuck switch blocks — refuses the whole include with
   * nothing moved. `ownSlot` — the rule being edited — keeps its account: the account is included
   * there.
   */
  private async handOffLocked(
    reserving: readonly StoredAccount[],
    picture: RegistryPicture,
    ownSlot: SlotId | undefined,
  ): Promise<SlotHandOff[]> {
    if (reserving.length === 0) return [];
    const ids = new Set(reserving.map((a) => a.id));
    const after: RulesPicture = {
      shared: picture.shared.filter((a) => !ids.has(a.id)),
      reserved: [...picture.reserved, ...reserving],
      rules: picture.rules,
    };
    const occupancy = await this.slotOccupancy(picture);
    const moving: Array<{ slotId: SlotId; from: StoredAccount; options: StoredAccount[] }> = [];
    for (const [slotId, owners] of occupancy) {
      if (slotId === ownSlot) continue;
      const from = reserving.find((a) => owners.has(a.id));
      if (from === undefined) continue;
      moving.push({ slotId, from, options: availableInOrder(slotPool(slotId, after, occupancy)) });
    }
    const assigned = assignDistinct(moving.map((m) => m.options.map((a) => a.id)));
    if (!assigned.ok) {
      const short = moving[assigned.unserved]!;
      throw this.noReplacementError(short.slotId, short.from, picture);
    }
    const plan = moving.map((m, i) => ({
      slotId: m.slotId,
      from: m.from,
      to: assigned.chosen[i]!,
    }));
    // A slot whose switch is stuck would refuse its move only after the slots before it had moved.
    for (const step of plan) await this.requireSettledLocked(this.slotRuntime(step.slotId));
    const handedOff: SlotHandOff[] = [];
    for (const step of plan) {
      // A deliberate operator move: forced past the cadence guard (an include should never be blocked
      // by a recent hop), and the outgoing account's rotation is adopted by the switch itself.
      const res = await this.activateInSlot(this.slotRuntime(step.slotId), step.to, {
        force: true,
        origin: 'manual',
        reason: 'freeing the slot for a folder include',
      });
      handedOff.push({ slot: step.slotId, from: step.from.id, to: res.activeAccountId });
    }
    return handedOff;
  }

  /** The refusal of an include that would leave a slot holding a newly reserved account with no
   *  other account to move to. The global slot keeps its historical code. */
  private noReplacementError(
    slotId: SlotId,
    from: StoredAccount,
    picture: RulesPicture,
  ): RefreshError {
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined) {
      return new RefreshError(
        `cannot include "${from.label}": it is the only usable shared account, so reserving it ` +
          'would leave the global slot with none',
        'no_shared_account_remains',
      );
    }
    const rule = picture.rules.find((r) => r.id === ruleId);
    return new RefreshError(
      `cannot include "${from.label}": it is live in the folder slot of ` +
        `${rule ? describeRule(rule) : slotId}, and that folder has no other account to switch to`,
      'no_account_remains',
    );
  }

  /**
   * The running-session rule for a change that leaves a rule's slot with nothing to seat (`next` is
   * empty): refused while a session runs under the rule's folders, unless `force`. Returns the
   * sessions found (empty when `next` has an account and nothing needed checking).
   */
  private async refuseEmptyingWhileRunning(
    rule: FolderRule,
    next: readonly StoredAccount[],
    what: string,
    force: boolean,
  ): Promise<RunningSession[]> {
    if (next.length > 0) return [];
    const sessions = await this.runningSessionsUnder(rule.folders);
    if (sessions.length > 0 && !force) {
      throw new RefreshError(
        `${what} leaves ${describeRule(rule)} with no account to switch to, and ${sessions.length} ` +
          'running session(s) are using it; exit them or rerun with --force',
        'sessions_running',
      );
    }
    return sessions;
  }

  /** Refuse a verb that creates or fills a rule slot on macOS: a rule slot is a second config dir,
   *  and macOS has no per-config-dir credential slot yet, so it would silently share the global
   *  Keychain item. */
  private refuseRuleSlotsOnDarwin(): void {
    if (this.platform === 'darwin') {
      throw new RefreshError(
        'folder rules are not supported on macOS yet (per-config-dir Keychain slots)',
        'group_slot_unsupported',
      );
    }
  }

  /** De-duplicate the accounts a verb names and refuse an empty list. Nothing ever stands in for a
   *  missing account — least of all the one in use. */
  private requireAccountIds(accountIds: readonly string[], verb: string): string[] {
    const ids = [...new Set(accountIds)];
    if (ids.length === 0) {
      throw new RefreshError(
        `${verb} needs at least one account, named explicitly`,
        'no_accounts_named',
      );
    }
    return ids;
  }

  /** The rows of the named accounts, refusing an unknown id by name before anything moves. */
  private async resolveRequested(ids: readonly string[]): Promise<StoredAccount[]> {
    const rows: StoredAccount[] = [];
    for (const id of ids) {
      const row = await this.vault.getAccount(id);
      if (!row) throw new UnknownAccountError(id);
      rows.push(row);
    }
    return rows;
  }

  // ---- invariant checker (checkSlots / repairSlots) ----

  /**
   * The single authority for "is any slot in an illegal state", read by both `cctl doctor` and the
   * daemon watchdog. Read-only, apart from keeping the token-fingerprint cache current (see
   * tokenPrints.ts). Reports the §7 (a)-(e) violations — an account live in two slots, a reserved
   * account live in the global slot, an account live in a rule slot outside that rule's pool, a
   * rule whose recorded account is not the one live, broken profile links — plus a slot whose live
   * token and identity name different accounts, a profile no rule owns that is still logged in, and
   * a token stored under two accounts; {@link repairSlots} fixes all but (e) and the last.
   *
   * Slot occupancy is read PHYSICALLY here (the live token, then the live identity block, matched
   * against the WHOLE registry — see {@link physicalLiveId}), not through {@link getActiveId} —
   * because getActiveId goes by the identity block alone, and the whole point of the check is to
   * catch an account living where it may not (a reserved account squatting in global, an excluded
   * one in a rule profile) or where the identity block misnames it.
   */
  async checkSlots(): Promise<SlotViolation[]> {
    return this.computeViolations({ locked: false });
  }

  /**
   * Repair the invariant breaches {@link checkSlots} finds, under the lock. Fixes (a)-(d):
   *   - adopt the freshest live token (identity-guarded) for every KNOWN account that is live
   *     anywhere, so a rotation is preserved before any slot is overwritten;
   *   - re-seat a slot whose live token and identity name different accounts;
   *   - move the global slot off a reserved account onto an available shared one (or clear it if
   *     none remains);
   *   - re-seat each rule slot from its pool, evicting an account outside it or live elsewhere too
   *     (the global slot, repaired first, keeps a shared account both hold — the global slot keeps
   *     the last shared account; between two rule slots the later one in file order keeps it);
   *   - clear the live login of a profile no rule owns (after adopting its rotation).
   * Unrecognized logins are never adopted (alert only), broken profile links (e) are left to
   * `ensureGroupProfile`, and a token stored under two accounts cannot be told apart from the files;
   * all three are reported in `remaining`. A hostile registry cannot widen access: every write only
   * ever makes a slot hold an account its pool RIGHTFULLY contains.
   */
  async repairSlots(): Promise<RepairResult> {
    return this.withCredentialLock(async () => {
      // An unfinished switch is settled by its own intent, which knows more than any repair below. A
      // slot where that fails is left alone by every step below (each would only fail on it again,
      // or act on the half-written state its switch left) and is reported instead.
      const unsettled = await this.settleSlotsLocked(await this.allSlotIds());
      const before = await this.computeViolations({ locked: true });
      if (before.length === 0) {
        // No slot to move — but the snapshot can still lag the registry (a crash between a rule
        // write and its snapshot write leaves every slot legal). Converge that too, or the guard
        // keeps enforcing a rule set that no longer exists until something else rewrites it.
        const rewrote = await this.refreshSnapshotIfStaleLocked();
        return {
          repaired: [],
          remaining: [],
          actions: rewrote ? ['rewrote the stale folder-bindings snapshot'] : [],
        };
      }

      const actions: string[] = [];
      const allRows = await this.vault.listAllAccounts();
      const picture = await this.vault.readPicture();
      const stored = await this.vault.readStoredTokens();
      const slotIds = allSlots(picture.rules).filter((slotId) => !unsettled.has(slotId));

      // Step 1: adopt the freshest rotation for every known account that is live in any slot. Applied
      // per (account, slot); adoption only replaces the vault copy when the live token is newer, so
      // running it across all slots lands the freshest regardless of order.
      for (const slotId of slotIds) {
        const rt = this.slotRuntime(slotId);
        const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
        if (phys.id !== null) {
          const liveNow = await rt.credStore.readLiveCredentials().catch(() => undefined);
          const liveOauth = await rt.credStore.readOauthAccount().catch(() => undefined);
          if (await this.adoptRotationIfNeeded(phys.id, liveNow, liveOauth)) {
            const label = allRows.find((r) => r.id === phys.id)?.label ?? phys.id;
            actions.push(`adopted a rotated token for "${label}" from ${slotId}`);
          }
        }
      }

      // Steps 2-4 each re-seat one slot, and one slot's refusal (an account whose stored token another
      // account also holds, say) must not leave every other slot unrepaired: it is logged, and the
      // violation it left stays in `remaining`.
      const perSlot = async (slotId: SlotId, step: () => Promise<void>): Promise<void> => {
        try {
          await step();
        } catch (err) {
          if (this.isSimulatedDeath(err)) throw err;
          this.log.warn({ slot: slotId, reason: errorReason(err) }, 'could not repair a slot');
        }
      };

      // Step 2: a slot whose token and identity name different accounts is re-seated before anything
      // below reads it, because everything below goes by the identity block.
      for (const slotId of slotIds) {
        const rt = this.slotRuntime(slotId);
        const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
        if (phys.mismatch !== undefined && phys.id !== null) {
          const owner = phys.id;
          await perSlot(slotId, () => this.reseatMismatchedSlot(rt, owner, allRows, actions));
        }
      }

      // Step 3: reconcile the global slot to a SHARED account (evict any reserved squatter).
      if (!unsettled.has('global')) {
        await perSlot('global', () => this.repairGlobalSlot(allRows, stored, actions));
      }

      // Step 4: reconcile each rule slot from its pool (evicting what may not, or cannot, be there).
      for (const rule of picture.rules) {
        const slotId = ruleSlotId(rule.id);
        if (unsettled.has(slotId)) continue;
        await perSlot(slotId, async () => {
          const res = await this.ensureRuleLiveLocked(rule);
          if (res.activated) actions.push(`re-seated the folder slot of ${describeRule(rule)}`);
          else if (res.clearedSquatter)
            actions.push(`cleared a login that does not belong from ${describeRule(rule)}`);
        });
      }

      // Step 5: an account that was live in two slots kept the one the steps above left it in — but
      // when the evicted copy was the newer one, step 1 adopted that into the vault, and the copy that
      // stayed holds a token the other session already spent. Re-seat it with the vault's.
      const rowsNow = await this.vault.listAllAccounts();
      const storedNow = await this.vault.readStoredTokens();
      for (const slotId of slotIds) {
        await perSlot(slotId, () =>
          this.reseatSpentLiveToken(this.slotRuntime(slotId), rowsNow, storedNow, actions),
        );
      }

      // Step 6: a profile no rule owns may not keep a login live.
      await this.clearOrphanProfileLogins(allRows, picture.rules, stored, actions);

      // Snapshot LAST — an activeId may have moved (its generation is what freshness checks read).
      await this.writeSnapshotLocked();

      const after = await this.computeViolations({ locked: true });
      const repaired = before.filter((b) => !after.some((a) => sameViolation(a, b)));
      return { repaired, remaining: after, actions };
    });
  }

  /** Compute the current slot violations. Shared by {@link checkSlots} (unlocked read) and
   *  {@link repairSlots} (already under the lock, `locked`), so the repair decides against the same
   *  picture it will report. */
  private async computeViolations(opts: { locked: boolean }): Promise<SlotViolation[]> {
    const violations: SlotViolation[] = [];
    const allRows = await this.vault.listAllAccounts();
    const picture = await this.vault.readPicture();
    const rules = picture.rules;
    const stored = await this.vault.readStoredTokens();
    const labelOf = (id: string): string => allRows.find((r) => r.id === id)?.label ?? id;
    const slotLabel = (slotId: SlotId): string => {
      const rule = rules.find((r) => ruleSlotId(r.id) === slotId);
      return rule === undefined ? 'the global slot' : `the folder slot of ${describeRule(rule)}`;
    };

    // Physical occupancy of every slot.
    const physical = new Map<SlotId, PhysicalOccupant>();
    for (const slotId of allSlots(rules)) {
      physical.set(
        slotId,
        await this.physicalLiveId(this.slotRuntime(slotId).credStore, allRows, stored),
      );
    }

    // Checks added after (a)-(e) are reported after them, so the long-standing order is kept.
    const trailing: SlotViolation[] = [];

    // A slot holding one account's token under another account's identity: everything that goes by
    // the identity block (who is live, whose rotation to adopt) is wrong about it.
    for (const [slotId, phys] of physical) {
      if (phys.ambiguous !== undefined) {
        const { holders, identityId, identityUuid } = phys.ambiguous;
        const named =
          identityId !== null
            ? `"${labelOf(identityId)}"`
            : `an account that is not stored here (${identityUuid ?? 'no uuid'})`;
        trailing.push({
          kind: 'live_identity_mismatch',
          slot: slotId,
          ...ruleField(slotId),
          detail:
            `${slotLabel(slotId)} holds a login token stored under ${quotedLabels(holders, allRows)} ` +
            `at once, under the identity of ${named}, so whose it is cannot be told: ${SHARED_TOKEN_REMEDY}`,
        });
        continue;
      }
      if (phys.mismatch === undefined || phys.id === null) continue;
      const named =
        phys.mismatch.identityId !== null
          ? `"${labelOf(phys.mismatch.identityId)}"`
          : `an unrecognized login (${phys.mismatch.identityUuid})`;
      trailing.push({
        kind: 'live_identity_mismatch',
        accountId: phys.id,
        slot: slotId,
        ...ruleField(slotId),
        detail: `${slotLabel(slotId)} holds the credentials of "${labelOf(phys.id)}" but its identity names ${named}`,
      });
    }

    // One token stored under two accounts: the state a mis-attributed adoption leaves behind.
    for (const ids of stored.sharedTokens()) {
      trailing.push({
        kind: 'duplicate_stored_token',
        accountId: ids[0]!,
        detail: `accounts ${quotedLabels(ids, allRows)} store the same login token: ${SHARED_TOKEN_REMEDY}`,
      });
    }

    // A profile no rule owns that is still logged in. An unlocked read can pair a rule list read
    // before a concurrent include committed with a profile that include has since logged in, so a
    // finding there is confirmed under the lock first (see confirmedOrphanLogins).
    const orphans = opts.locked
      ? await this.orphanProfileLogins(allRows, rules, stored)
      : await this.confirmedOrphanLogins(allRows, rules, stored);
    for (const orphan of orphans) {
      trailing.push({
        kind: 'orphan_profile_login',
        ...(orphan.occupant.id !== null ? { accountId: orphan.occupant.id } : {}),
        ruleId: orphan.name,
        detail:
          `${orphan.dir}, a profile no folder rule owns any more, still holds a live login` +
          (orphan.occupant.id !== null ? ` of "${labelOf(orphan.occupant.id)}"` : ''),
      });
    }

    // A bundle none of the token checks could include.
    for (const [id, reason] of stored.unreadable) {
      trailing.push({
        kind: 'unreadable_bundle',
        accountId: id,
        detail: `the stored login of "${labelOf(id)}" could not be read (${reason}), so the token checks could not include it`,
      });
    }

    // A switch that was interrupted and could not be settled since (see settleSlotsLocked), or whose
    // record cannot be read. Under the lock every pending switch is one: the repair has just tried to
    // settle it. Unlocked, one may be in flight, so only a switch older than any lock holder is
    // allowed to run is counted.
    const staleMs = this.lockOptions.staleMs ?? LOCK_STALE_MS;
    for (const slotId of physical.keys()) {
      let pending: SwitchIntent | undefined;
      try {
        pending = await this.slotRuntime(slotId).intent.read();
      } catch (err) {
        trailing.push({
          kind: 'unsettled_switch',
          slot: slotId,
          ...ruleField(slotId),
          detail:
            `the record of an interrupted switch of ${slotLabel(slotId)} could not be read ` +
            `(${errorReason(err)}); that slot stays blocked until the file is deleted - check first ` +
            "that its live login is one account's",
        });
        continue;
      }
      if (pending === undefined) continue;
      if (!opts.locked && this.clock() - pending.startedAtMs <= staleMs) continue;
      trailing.push({
        kind: 'unsettled_switch',
        accountId: pending.targetId,
        slot: slotId,
        ...ruleField(slotId),
        detail:
          `a switch of ${slotLabel(slotId)} to "${labelOf(pending.targetId)}" was interrupted and ` +
          'has not been finished or undone; that slot is not written until it is (`cctl recover` ' +
          'retries it and says why)',
      });
    }

    // (a) one account live in more than one slot — the core invariant.
    const slotsByAccount = new Map<string, SlotId[]>();
    for (const [slotId, phys] of physical) {
      if (phys.id !== null) {
        const list = slotsByAccount.get(phys.id) ?? [];
        list.push(slotId);
        slotsByAccount.set(phys.id, list);
      }
    }
    for (const [id, slots] of slotsByAccount) {
      if (slots.length > 1) {
        violations.push({
          kind: 'account_in_multiple_slots',
          accountId: id,
          slots,
          detail: `account "${labelOf(id)}" is live in ${slots.map(slotLabel).join(' and ')}`,
        });
      }
    }
    // The same invariant keyed by the TOKEN: one refresh token live in two slots under identities
    // naming different accounts (one token stored under two accounts, and each seated in a slot) is
    // exactly as fatal — whichever side refreshes first kills the other — and the account-keyed check
    // above cannot see it. Reported unless that check already named the same slots.
    const slotsByToken = new Map<string, SlotId[]>();
    for (const [slotId, phys] of physical) {
      if (phys.refreshPrint === undefined) continue;
      slotsByToken.set(phys.refreshPrint, [...(slotsByToken.get(phys.refreshPrint) ?? []), slotId]);
    }
    for (const slots of slotsByToken.values()) {
      if (slots.length < 2) continue;
      const ids = new Set(slots.map((s) => physical.get(s)!.id));
      if (ids.size === 1 && !ids.has(null)) continue; // reported above as account_in_multiple_slots
      const live = await this.slotRuntime(slots[0]!)
        .credStore.readLiveCredentials()
        .catch(() => undefined);
      const holders = live === undefined ? [] : stored.holdersOf(live);
      violations.push({
        kind: 'token_in_multiple_slots',
        ...(holders.length === 1 ? { accountId: holders[0]! } : {}),
        slots,
        detail:
          `one login token is live in ${slots.map(slotLabel).join(' and ')}` +
          (holders.length > 0 ? ` (stored for ${quotedLabels(holders, allRows)})` : '') +
          `; whichever refreshes it first logs the other out: ${SHARED_TOKEN_REMEDY}`,
      });
    }

    // (b) a reserved account live in the global slot.
    const globalPhys = physical.get('global')!;
    if (globalPhys.id !== null) {
      const ruleIds = allRows.find((r) => r.id === globalPhys.id)?.ruleIds;
      if (ruleIds !== undefined) {
        violations.push({
          kind: 'reserved_live_in_global',
          accountId: globalPhys.id,
          slot: 'global',
          ...(ruleIds[0] !== undefined ? { ruleId: ruleIds[0] } : {}),
          detail: `reserved account "${labelOf(globalPhys.id)}" is live in the global slot`,
        });
      }
    }

    for (const rule of rules) {
      const slotId = ruleSlotId(rule.id);
      const phys = physical.get(slotId)!;
      if (phys.id !== null) {
        if (!slotMayHold(slotId, phys.id, picture)) {
          // (c) a known account outside the rule's pool is live in its profile: one the rule
          // excludes, or one reserved only to other rules.
          const why = rule.exclude.includes(phys.id)
            ? 'which that folder excludes'
            : 'which is reserved to other folders';
          violations.push({
            kind: 'outside_pool_live_in_rule',
            accountId: phys.id,
            slot: slotId,
            ruleId: rule.id,
            detail: `"${labelOf(phys.id)}", ${why}, is live in ${slotLabel(slotId)}`,
          });
        } else if (rule.activeId !== phys.id) {
          // (d) the profile's live identity is a different account than the rule recorded.
          violations.push({
            kind: 'rule_active_mismatch',
            accountId: phys.id,
            slot: slotId,
            ruleId: rule.id,
            detail: `${slotLabel(slotId)} records ${rule.activeId === null ? 'no account' : `"${labelOf(rule.activeId)}"`} live, but "${labelOf(phys.id)}" is`,
          });
        }
      } else if (phys.hasCreds && phys.foreignUuid !== undefined) {
        // (c') an unrecognized login is live in a rule profile — alert only (never adopted).
        violations.push({
          kind: 'outside_pool_live_in_rule',
          slot: slotId,
          ruleId: rule.id,
          detail: `an unrecognized login (${phys.foreignUuid}) is live in ${slotLabel(slotId)}`,
        });
      }

      // (e) broken profile links — a read-only plan tells us without touching anything.
      for (const v of this.brokenLinkViolations(rule)) violations.push(v);
    }

    violations.push(...trailing);
    return violations;
  }

  /**
   * Re-seat an account whose live token in `rt`'s slot is older than the one its vault bundle holds.
   * A login has one live refresh token: when two copies were live and the other one rotated (its
   * rotation adopted into the vault by repair's first step), the copy left here is spent, and the
   * first refresh in this slot would fail as a dead login. Same-account, so it is a heal — no hop
   * for the cadence clock, and nothing to adopt (the live token is not the newer one). "Older" is
   * judged the way rotation adoption judges it: a different refresh token whose grant expires later.
   */
  private async reseatSpentLiveToken(
    rt: SlotRuntime,
    allRows: AccountView[],
    stored: StoredTokens,
    actions: string[],
  ): Promise<void> {
    const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
    if (phys.id === null || phys.mismatch !== undefined || phys.ambiguous !== undefined) return;
    const live = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const vaultCopy = (await this.vault.readBundle(phys.id).catch(() => undefined))?.claudeAiOauth;
    if (live === undefined || vaultCopy === undefined) return;
    if (vaultCopy.refreshToken === live.refreshToken || vaultCopy.expiresAt <= live.expiresAt)
      return;
    await this.activateInSlot(rt, phys.id, {
      force: true,
      origin: 'recovery',
      reason: 'replacing a live token another copy of the login already spent',
    });
    const label = allRows.find((r) => r.id === phys.id)?.label ?? phys.id;
    actions.push(
      `re-seated "${label}" in ${await this.slotLabelOf(rt.id)} with its freshest token; ` +
        'the one live there was already spent',
    );
  }

  /** Read-only detection of §7 (e): any shared file in the rule's profile whose hard link to main
   *  is broken (`ensureGroupProfile` rebuilds these; `repairSlots` does not). Best-effort — a fault
   *  probing the profile is swallowed, since the check must never throw on the doctor's read path. */
  private brokenLinkViolations(rule: FolderRule): SlotViolation[] {
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    if (rt.profileDir === undefined) return [];
    try {
      const plan = planGroupProfile(
        rt.profileDir,
        this.paths.claudeDir,
        createNodeProfileFs(),
        this.paths.claudeJsonPath,
      );
      const broken = plan.files.filter((f) => f.action === 'repair').map((f) => f.name);
      if (broken.length === 0) return [];
      return [
        {
          kind: 'broken_profile_link',
          slot: slotId,
          ruleId: rule.id,
          detail: `the folder slot of ${describeRule(rule)} has broken profile links: ${broken.join(', ')}`,
        },
      ];
    } catch (err) {
      this.log.debug({ ruleId: rule.id, reason: errorReason(err) }, 'broken-link probe failed');
      return [];
    }
  }

  /** Move the global slot off a reserved account, if one is squatting there. Adoption already ran
   *  (repairSlots step 1), so the squatter's rotation is safe; here we only re-seat global onto the
   *  best shared account still available to it (live in no rule slot), or clear it (fail closed) when
   *  none remains. A shared account in global, an empty global, or an unrecognized login in global
   *  are all left alone — none breaches the fence. */
  private async repairGlobalSlot(
    allRows: AccountView[],
    stored: StoredTokens,
    actions: string[],
  ): Promise<void> {
    const rt = this.slotRuntime('global');
    const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
    if (phys.id === null) return; // empty or unrecognized login — not a fence breach.
    const squatter = allRows.find((r) => r.id === phys.id);
    if (squatter?.ruleIds === undefined) return; // a shared account belongs in global.

    const picture = await this.vault.readPicture();
    const occupancy = await this.slotOccupancy(picture);
    const replacement = availableInOrder(slotPool('global', picture, occupancy))[0];
    if (replacement !== undefined) {
      await this.activateInSlot(rt, replacement.id, {
        force: true,
        origin: 'recovery',
        reason: 'evicting a reserved account from the global slot',
      });
      actions.push(
        `moved the global slot off reserved "${squatter.label}" onto "${replacement.label}"`,
      );
    } else {
      // No shared account to fall back to: clearing global is safer than leaving a reserved
      // account's rotating token live there, which is exactly what the fence forbids.
      await this.clearGlobalLive();
      actions.push(
        `cleared reserved "${squatter.label}" from the global slot (no shared account available)`,
      );
    }
  }

  /**
   * The physical live account of a set of live files (a slot's, or an orphaned profile's), matched
   * against the WHOLE registry so a reserved or out-of-pool login is recognized.
   *
   * The token decides first: a live token equal to a stored account's token IS that account's login,
   * whatever the identity block beside it says — the token is the one artifact that cannot be stale.
   * When it also contradicts the identity block, provably (the block names a different stored
   * account, or the owner's recorded uuid differs from the one named), the result carries a
   * `mismatch`: a switch torn between its two writes that no intent describes. An owner with no
   * recorded uuid beside an unknown one is not treated as a contradiction: that is most likely Claude
   * Code's own re-derived block for that very login.
   *
   * A token two or more stored accounts hold (a vault an older build contaminated) has no owner the
   * files can show. The identity block settles it only when it names one of the holders; otherwise
   * no holder is taken for the owner — picking one (the first in registry order, say) and re-seating
   * it would be a guess with a single-use token — and a contradicting block is reported as
   * `ambiguous`, for a re-login to resolve.
   *
   * A token no bundle stores (rotated since it was stored, or never captured) falls back to the
   * identity block: the uuid matched against the registry, or a foreign-uuid marker when it names no
   * known account. Token matching reads fingerprints and does not decrypt in the steady state (see
   * tokenPrints.ts), so this stays cheap on the doctor's and the daemon's read paths.
   */
  private async physicalLiveId(
    credStore: CredentialStore,
    allRows: AccountView[],
    stored: StoredTokens,
  ): Promise<PhysicalOccupant> {
    const live = await credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return { id: null, hasCreds: false };
    const refreshPrint = tokenPrints(live).refresh;
    const oauth = await credStore.readOauthAccount().catch(() => undefined);
    const uuid = anchorValue(oauth?.accountUuid);
    const named = uuid !== undefined ? allRows.find((r) => r.accountUuid === uuid) : undefined;
    const holders = stored.holdersOf(live);
    const uuidOf = (id: string): string | undefined =>
      allRows.find((r) => r.id === id)?.accountUuid;
    if (named !== undefined && holders.includes(named.id)) {
      return { id: named.id, hasCreds: true, refreshPrint };
    }
    if (holders.length > 1) {
      const contradicted =
        uuid !== undefined && (named !== undefined || holders.some((h) => uuidOf(h) !== undefined));
      return {
        id: null,
        hasCreds: true,
        refreshPrint,
        ...(contradicted
          ? {
              ambiguous: {
                holders,
                identityId: named?.id ?? null,
                ...(uuid !== undefined ? { identityUuid: uuid } : {}),
              },
            }
          : {}),
      };
    }
    if (holders.length === 1) {
      const owner = holders[0]!;
      const contradicted =
        uuid !== undefined && (named !== undefined || uuidOf(owner) !== undefined);
      if (!contradicted) return { id: owner, hasCreds: true, refreshPrint };
      return {
        id: owner,
        hasCreds: true,
        refreshPrint,
        mismatch: { identityId: named?.id ?? null, identityUuid: uuid },
      };
    }
    if (named !== undefined) return { id: named.id, hasCreds: true, refreshPrint };
    if (uuid !== undefined) return { id: null, hasCreds: true, refreshPrint, foreignUuid: uuid };
    // Credentials with no identity block name nobody we can attribute — not a violation we can act on.
    return { id: null, hasCreds: true, refreshPrint };
  }

  /**
   * Re-seat a slot whose live token belongs to `ownerId` while its identity block names someone else
   * (see {@link physicalLiveId}). When the slot's pool holds the owner it is activated there: its own
   * token is what is live, so this rewrites the identity to match and commits it — nothing is
   * adopted, because adoption refuses a token another account stores. When it may not, the slot's
   * rightful account is put back: for a rule slot, the first available account of its pool (the
   * per-rule step that follows goes by the identity block and would take the account it names for
   * live); for the global slot the reserved owner is evicted by {@link repairGlobalSlot}, which reads
   * the token the same way.
   */
  private async reseatMismatchedSlot(
    rt: SlotRuntime,
    ownerId: string,
    allRows: AccountView[],
    actions: string[],
  ): Promise<void> {
    const picture = await this.vault.readPicture();
    const owner = allRows.find((r) => r.id === ownerId);
    const rule =
      rt.ruleId === undefined ? undefined : picture.rules.find((r) => r.id === rt.ruleId);
    const where =
      rule === undefined ? 'the global slot' : `the folder slot of ${describeRule(rule)}`;
    const reason = "re-seating a slot whose credentials were under another account's identity";
    if (owner !== undefined && slotMayHold(rt.id, owner.id, picture)) {
      await this.activateInSlot(rt, owner.id, { force: true, origin: 'recovery', reason });
      actions.push(
        `re-seated "${owner.label}" in ${where}; its credentials were under another identity`,
      );
      return;
    }
    if (rule === undefined) return; // a reserved owner in global: repairGlobalSlot evicts it
    const occupancy = await this.slotOccupancy(picture);
    const seated = await this.seatFirst(
      rt,
      availableInOrder(slotPool(rt.id, picture, occupancy)),
      reason,
    );
    if (seated !== null) {
      const label = allRows.find((r) => r.id === seated)?.label ?? seated;
      actions.push(`restored "${label}" in ${where} over another account's credentials`);
      return;
    }
    await this.clearSlotLive(rt);
    // The slot holds nobody now; neither may its record (see ensureRuleLiveLocked).
    if (rule.activeId !== null) await this.vault.setRuleActive(rule.id, null);
    actions.push(`cleared another account's credentials from ${where} (no account could take it)`);
  }

  /**
   * Profile dirs no rule owns that still hold a live login (`orphan_profile_login`). A dissolved
   * rule's profile is kept for its history with its live seat cleared; one still logged in is what
   * an interrupted removal by an older build leaves, and it is no slot — nothing else reads it, so the
   * login would sit there, a second live copy of an account's token, for good. Cheap: one directory
   * listing, and one read of a missing file per dissolved profile.
   */
  private async orphanProfileLogins(
    allRows: AccountView[],
    rules: readonly FolderRule[],
    stored: StoredTokens,
  ): Promise<OrphanLogin[]> {
    const root = profilesRoot(this.paths.vaultDir);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return []; // no profiles root yet: no rule ever existed
    }
    const fold = (name: string): string => (this.platform === 'win32' ? name.toLowerCase() : name);
    const owned = new Set(
      rules.map((r) => fold(basename(groupProfileDir(this.paths.vaultDir, r.id)))),
    );
    const out: OrphanLogin[] = [];
    for (const name of names) {
      if (owned.has(fold(name))) continue;
      const dir = join(root, name);
      const store = this.configDirStore(dir);
      const occupant = await this.physicalLiveId(store, allRows, stored);
      if (occupant.hasCreds) out.push({ name, dir, store, occupant });
    }
    return out;
  }

  /**
   * {@link orphanProfileLogins} for a reader that does not hold the lock, found and then CONFIRMED
   * under it. Unlocked, the rule list and the profile dirs are read at different moments, and an
   * include committing in between (its rule written, then its profile logged in) makes the new rule's
   * own profile look like one no rule owns. Orphans are rare, so the lock is taken only when one is
   * found, and only if it is free right now: a finding that cannot be confirmed is left for the next
   * check rather than reported (a real orphan is still there then; a new rule's profile is not one).
   */
  private async confirmedOrphanLogins(
    allRows: AccountView[],
    rules: readonly FolderRule[],
    stored: StoredTokens,
  ): Promise<OrphanLogin[]> {
    const found = await this.orphanProfileLogins(allRows, rules, stored);
    if (found.length === 0) return found;
    const confirmed = await this.withCredentialLockIfFree(async () =>
      this.orphanProfileLogins(
        await this.vault.listAllAccounts(),
        await this.vault.listRules(),
        await this.vault.readStoredTokens(),
      ),
    );
    return confirmed ?? [];
  }

  /** Clear the live login of every orphaned profile (see {@link orphanProfileLogins}), adopting its
   *  rotation first when it provably belongs to a stored account — the adopt-then-clear order a
   *  dissolve uses, so clearing never costs an account its latest token. */
  private async clearOrphanProfileLogins(
    allRows: AccountView[],
    rules: readonly FolderRule[],
    stored: StoredTokens,
    actions: string[],
  ): Promise<void> {
    for (const orphan of await this.orphanProfileLogins(allRows, rules, stored)) {
      if (orphan.occupant.id !== null && orphan.occupant.mismatch === undefined) {
        const liveNow = await orphan.store.readLiveCredentials().catch(() => undefined);
        const liveOauth = await orphan.store.readOauthAccount().catch(() => undefined);
        await this.adoptRotationIfNeeded(orphan.occupant.id, liveNow, liveOauth);
      }
      await orphan.store.clearLiveCredentials();
      await orphan.store.clearOauthAccount();
      const who = allRows.find((r) => r.id === orphan.occupant.id)?.label;
      actions.push(
        `cleared ${who !== undefined ? `"${who}"'s` : 'a'} login from ${orphan.dir}, a profile no folder rule owns`,
      );
    }
  }

  // ---- folder-rule helpers ----

  /** Canonicalize an operator-supplied folder for a rule verb, refusing the same targets §5
   *  reserves (a filesystem root, the home dir, cctl's own dirs). `mustExist` is relaxed for a reset
   *  (the folder may since have been deleted, but its rule still needs clearing). Throws a
   *  `bind_refused` {@link RefreshError} on any refusal. */
  private canonicalizeBindFolder(folder: string, opts: { mustExist?: boolean } = {}): string {
    const canon = canonicalizeFolder(folder, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
      realpath: this.bindFs.realpath,
    });
    if (!canon.ok) {
      throw new RefreshError(`cannot use folder "${folder}": ${canon.reason}`, 'bind_refused');
    }
    // The reserved-target rules (root/home/overlaps-cctl) apply where a rule is made or edited, and
    // a real directory is required. A reset skips them: a folder without a rule is caught later.
    if (opts.mustExist !== false) {
      const check = checkBindTarget(canon.path, {
        platform: this.platform,
        isDirectory: this.bindFs.isDirectory,
        homeDir: this.canonReserved(this.bindFs.homedir()),
        vaultDir: this.canonReserved(this.paths.vaultDir),
        profilesRoot: this.canonReserved(profilesRoot(this.paths.vaultDir)),
        mainConfigDir: this.canonReserved(this.paths.claudeDir),
      });
      if (!check.ok) {
        throw new RefreshError(
          `cannot give "${canon.path}" a folder rule: ${check.reason}`,
          'bind_refused',
        );
      }
    }
    return canon.path;
  }

  /** Canonicalize a cctl-internal reserved path for containment checks — same rules as a rule
   *  folder, but falling back to the raw path when it does not exist yet (the profiles root has no
   *  directory until the first rule). */
  private canonReserved(path: string): string {
    const canon = canonicalizeFolder(path, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
      realpath: this.bindFs.realpath,
    });
    return canon.ok ? canon.path : path;
  }

  /** Clear the GLOBAL slot's live seat (remove `.credentials.json`, drop the identity block) so it
   *  fails closed. Reached only by repair when a reserved account squats in global and no shared
   *  account remains — never on the darwin Keychain path, which has no rule slots to trigger it. */
  private async clearGlobalLive(): Promise<void> {
    await removeIfExists(this.paths.credentialsPath);
    await this.credStore.clearOauthAccount();
  }

  /** Discard a rule slot's crash-recovery state (intent WAL, rollback snapshot, cadence clock) on
   *  dissolution — the slot is going away, so leaving `slots/<ruleId>/` behind would strand an
   *  orphaned intent that a later `recover()` could act on. */
  private async clearSlotState(rt: SlotRuntime): Promise<void> {
    if (rt.ruleId === undefined) return; // never wipe the global slot's historical state
    await rm(rt.stateDir, { recursive: true, force: true });
  }

  /** Scan `<mainConfigDir>/sessions/*.json` for Claude Code sessions whose recorded pid is alive and
   *  whose cwd is within one of `folders`. Defensive: a missing dir, an unreadable or malformed file,
   *  or a session with no usable pid/cwd is simply skipped, never thrown — this only feeds a warning. */
  private async runningSessionsUnder(folders: readonly string[]): Promise<RunningSession[]> {
    const dir = join(this.paths.claudeDir, 'sessions');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const out: RunningSession[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const file = join(dir, name);
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(file, 'utf8'));
      } catch {
        continue;
      }
      if (typeof parsed !== 'object' || parsed === null) continue;
      const rec = parsed as { pid?: unknown; cwd?: unknown };
      const pid = typeof rec.pid === 'number' && Number.isInteger(rec.pid) ? rec.pid : undefined;
      const rawCwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
      if (pid === undefined || rawCwd === undefined) continue;
      if (!this.isProcessAlive(pid)) continue;
      const canonCwd = this.canonReserved(rawCwd);
      if (folders.some((f) => isWithin(canonCwd, f, this.platform))) {
        out.push({ pid, cwd: canonCwd, sessionFile: file });
      }
    }
    return out;
  }

  /** Build the guard snapshot object from the current registry (no IO beyond the vault reads). The
   *  enforce mode is resolved HERE, at build time, so a long-lived daemon honors a live settings
   *  change instead of a value cached at construction. */
  private async buildSnapshotObject(): Promise<FolderBindingSnapshot> {
    const picture = await this.vault.readPicture();
    return buildFolderBindingSnapshot({
      rules: picture.rules,
      shared: picture.shared,
      reserved: picture.reserved,
      generation: picture.generation,
      enforce: this.resolveBindEnforce(),
      mainConfigDir: this.canonReserved(this.paths.claudeDir),
      mainIdentityFile: this.paths.claudeJsonPath,
      profileDirOf: (ruleId) => this.canonReserved(groupProfileDir(this.paths.vaultDir, ruleId)),
    });
  }

  /** Bring the guard snapshot up to date after an account change it names (a label or an identity),
   *  when folder rules exist: the guard reads accounts only in a ruled folder, and a vault without
   *  rules keeps no snapshot current. Assumes the lock is held. Without it the guard would name the
   *  global slot's account by a stale label, or not recognize a new one, until the daemon's next
   *  cycle rewrote the snapshot. */
  private async refreshSnapshotForAccountsLocked(): Promise<void> {
    if ((await this.vault.listRules()).length === 0) return;
    await this.refreshSnapshotIfStaleLocked();
  }

  /** Rewrite the guard snapshot from the current registry, assuming the lock is held. Called LAST in
   *  every rule mutation. */
  private async writeSnapshotLocked(): Promise<void> {
    const snapshot = await this.buildSnapshotObject();
    await writeFolderBindingSnapshot(folderBindingsPath(this.paths.vaultDir), snapshot);
  }

  /** Rewrite the guard snapshot under the lock — what the daemon calls on start (§4.3) so the guard
   *  always reads a snapshot consistent with the live registry. */
  async refreshSnapshot(): Promise<void> {
    await this.withCredentialLock(() => this.writeSnapshotLocked());
  }

  /**
   * Rewrite the guard snapshot only when it no longer matches the registry (see
   * {@link getGuardSnapshotFreshness}); returns whether it rewrote. What the daemon's periodic
   * maintenance calls, so a snapshot left stale — a crash between a rule write and its snapshot
   * write, an offline registry edit — is healed within one cycle rather than at the next restart or
   * the next rule mutation. The steady-state check is lock-free; the lock is taken only to rewrite,
   * and the check is repeated under it so a concurrent writer's fresh snapshot is not rewritten.
   */
  async refreshSnapshotIfStale(): Promise<boolean> {
    if (await this.snapshotIsFresh()) return false;
    return this.withCredentialLock(() => this.refreshSnapshotIfStaleLocked());
  }

  /** {@link refreshSnapshotIfStale} for a caller that already holds the credential lock. */
  private async refreshSnapshotIfStaleLocked(): Promise<boolean> {
    if (await this.snapshotIsFresh()) return false;
    await this.writeSnapshotLocked();
    return true;
  }

  /** Whether the on-disk snapshot matches the registry. A missing or unreadable (corrupt) snapshot
   *  is simply not fresh — the rewrite is exactly what heals it. */
  private async snapshotIsFresh(): Promise<boolean> {
    try {
      return (await this.getGuardSnapshotFreshness()).fresh;
    } catch {
      return false;
    }
  }

  /**
   * Whether the guard snapshot on disk still reflects the guard-relevant registry (bound folders,
   * profile dirs, member labels, enforce mode) — the ONLY inputs the guard reads. Freshness is by
   * CONTENT, not by the rules generation: a routine rule-slot switch bumps the generation on
   * fields the snapshot does not carry (activeId, metadata), which must not read as stale, and a real
   * change to a bound folder always changes the content compared here. Returns what a health surface
   * needs: whether a snapshot exists, whether it is fresh, its enforce mode and its generation.
   */
  async getGuardSnapshotFreshness(): Promise<{
    present: boolean;
    fresh: boolean;
    enforce: BindEnforceMode;
    generation: number | null;
  }> {
    const stored = await this.vault.readFolderBindings();
    if (stored === undefined) {
      return { present: false, fresh: false, enforce: this.resolveBindEnforce(), generation: null };
    }
    const current = await this.buildSnapshotObject();
    return {
      present: true,
      fresh: folderBindingSnapshotContentEqual(stored, current),
      enforce: stored.enforce,
      generation: stored.generation,
    };
  }

  /** Whether a config dir points at (or into) the profiles root — the one place a capture must
   *  refuse to run, because onboarding always uses a throwaway dir and a login performed inside a
   *  profile would capture (and could overwrite) a rule slot's live seat. */
  private isInsideProfilesRoot(configDir: string): boolean {
    return isWithin(configDir, profilesRoot(this.paths.vaultDir), this.platform);
  }

  /** Refuse a capture whose config dir sits inside the profiles root (see
   *  {@link isInsideProfilesRoot}). A {@link RefreshError} with a stable code so the CLI can render
   *  guidance ("onboard in a throwaway dir, not a folder profile") rather than a raw message. */
  private refuseCaptureInProfile(configDir: string): void {
    if (this.isInsideProfilesRoot(configDir)) throw captureInProfileError(configDir);
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
  async getActiveId(slot: SlotId = 'global'): Promise<string | null> {
    const rt = this.slotRuntime(slot);
    const { registryId, candidates } = await this.slotRegistry(slot);
    // A corrupt/unreadable .claude.json must degrade to the registry answer, never throw —
    // this is a read path callers hit on every listing and poll cycle. For a rule slot the block
    // read is the profile's own `.claude.json`, so each slot reconciles against ITS OWN identity.
    const live = await rt.credStore.readOauthAccount().catch(() => undefined);
    const liveUuid = live?.accountUuid;
    if (liveUuid === undefined) return registryId;
    // Only this slot's candidates are recognized in it: a rule slot recognizes any stored account, global
    // against the shared pool. A uuid that matches no candidate is a login this slot never owned.
    const matches = candidates.filter((a) => a.accountUuid === liveUuid);
    if (matches.some((m) => m.id === registryId)) return registryId;
    if (registryId !== null && (await this.liveTokenBelongsTo(registryId, rt.credStore)))
      return registryId;
    return matches[0]?.id ?? null;
  }

  /**
   * Whether the live refresh token is the one stored for `accountId`, and for no other account. A
   * refresh token is issued to exactly one account, so a match is proof of ownership — unless
   * another stored account holds the same token (a vault an older build contaminated), which makes
   * it proof of neither: the files cannot say which copy is the contamination, and crediting the
   * token to the registry's account because it happens to be one of the two would be a pick.
   * Anything else (no live token, no bundle, an unreadable one) is simply not proof and answers
   * false — this corroborates an override, it does not gate one.
   *
   * Deliberately asked ONLY from `getActiveId()`'s disagreement branch: it decrypts a bundle,
   * which on Windows is a PowerShell spawn (see dpapi.ts), and the agreeing case is every normal
   * call. The disagreement branch means the live login is out of step with the last committed
   * switch, which a switch heals. The other-holder check runs only once the bundle matched.
   */
  private async liveTokenBelongsTo(
    accountId: string,
    credStore: CredentialStore,
  ): Promise<boolean> {
    const live = await credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return false;
    const bundle = await this.vault.readBundle(accountId).catch(() => undefined);
    if (bundle?.claudeAiOauth.refreshToken !== live.refreshToken) return false;
    const holders = await this.vault.readStoredTokens().then(
      (stored) => stored.holdersOf(live),
      () => undefined,
    );
    return holders !== undefined && holders.every((id) => id === accountId);
  }

  /**
   * Capture whatever is currently logged in as a new stored account. Used by
   * `cctl accounts add` right after an interactive login populated the live files.
   */
  async captureCurrentLogin(label: string): Promise<StoredAccount> {
    // A capture reads whoever is live in THIS config dir. Run inside a folder profile, that seat is a
    // rule slot's live credentials — onboarding always uses a throwaway dir, so a config dir pointing
    // into the profiles root is a mistake to refuse, not a login to capture. The session's OWN config
    // dir is checked too: inside a bound session the paths are seen through to the main dir, so
    // `claudeDir` alone would capture the main dir's login instead of the one just made in the
    // profile — and report it as if it were the new one.
    this.refuseCaptureInProfile(this.paths.claudeDir);
    // Set only when the environment's config dir IS a folder profile (defaultPaths decided that by
    // the same profiles-root rule), so it is refused outright rather than re-derived here.
    if (this.paths.profileConfigDir !== undefined) {
      throw captureInProfileError(this.paths.profileConfigDir);
    }
    // Locked for the whole capture: the add + setActive pair below are two registry writes that
    // must land as one atomic unit, and reading the live login while a switch is mid-flight would
    // otherwise see a torn set of credential files.
    return this.withCredentialLock(async () => {
      // A switch left between its two live writes would be captured as one account's token under
      // another's identity; it is settled first, and the capture refused while it cannot be.
      await this.requireSettledLocked(this.slotRuntime('global'));
      const live = await this.credStore.readLiveCredentials();
      if (!live)
        throw new RefreshError('no live credentials to capture; log in first', 'no_live_login');
      // A live token an account already stores IS that account's login, whatever identity block sits
      // beside it — refused like a login stored twice, since storing it again would put one
      // single-use token in two bundles. (The identity-based duplicate check in the vault cannot see
      // this when the block beside the token names someone else.)
      const holders = (await this.vault.readStoredTokens()).holdersOf(live);
      if (holders.length === 1) {
        const holder = holders[0]!;
        const row = await this.vault.getAccount(holder);
        throw new VaultError(
          `this login is account ${holder} ("${row?.label ?? holder}"), which is already stored; ` +
            `switch to it with \`cctl switch ${row?.label ?? holder}\` instead of adding it again`,
        );
      }
      if (holders.length > 1) {
        // Two holders: which one it really belongs to cannot be told, so neither is offered.
        throw new VaultError(
          `this login's token is already stored under ` +
            `${quotedLabels(holders, await this.vault.listAllAccounts())}; ${SHARED_TOKEN_REMEDY}`,
        );
      }
      const oauthAccount = await this.credStore.readOauthAccount();
      const bundle: CredentialBundle = oauthAccount
        ? { claudeAiOauth: live, oauthAccount }
        : { claudeAiOauth: live };
      const account = await this.vault.addAccount(label, bundle);
      // The just-captured account IS the live one; record that so the first switch reconciles.
      await this.vault.setActive(account.id);
      await this.refreshSnapshotForAccountsLocked();
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
    // A transient onboarding dir is never inside the profiles root; one that is would be a rule
    // slot's live seat, which this flow must not vault as a fresh account.
    this.refuseCaptureInProfile(configDir);
    // Deliberately FILE-based on every platform: the transient dir's contents are what we
    // capture. Whether the mac CLI honors CLAUDE_CONFIG_DIR with files (or still writes its
    // Keychain item, which would make this flow read nothing) is unverified on a real Mac.
    const store = this.configDirStore(configDir);
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
    return this.withCredentialLock(async () => {
      const account = await this.vault.addAccount(label, bundle);
      await this.refreshSnapshotForAccountsLocked();
      return account;
    });
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
    const oauthAccount = await this.configDirStore(configDir).readOauthAccount();
    const bundle: CredentialBundle = oauthAccount
      ? { claudeAiOauth: creds, oauthAccount }
      : { claudeAiOauth: creds };
    // A switch left pending in the global slot is deliberately NOT settled here (nor in
    // reloginFromKeychainDelta): `prior` was read before the window opened, and settling in between
    // could change the live login that the restore below then overwrites with `prior` again. The
    // restore puts the live credentials back exactly as this flow found them, the state the pending
    // intent describes, so the next operation on the slot settles it as if this flow had never run.
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

        const oauthAccount = await this.configDirStore(configDir).readOauthAccount();

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

  /** A file-based CredentialStore over one config dir — a rule profile, an orphaned profile, or a
   *  transient `CLAUDE_CONFIG_DIR` a login was performed in (the darwin flows read only the latter's
   *  `.claude.json`; its `.credentials.json` never exists there). Always file-based: only the global
   *  slot ever uses the platform's live-credential channel. */
  private configDirStore(configDir: string): CredentialStore {
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
      // Which slot the account is live in is read below, and the live heal writes it; no switch that
      // slot depends on may be left mid-flight. One to or from this account that cannot be settled
      // yet refuses the re-login; one elsewhere only keeps the heal out of its slot — a re-login of
      // any account it does not involve is the operator's way out of a dead account meanwhile.
      await this.settleForAccountsLocked([accountId]);
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

    // WHICH slot this account is live in, decided BEFORE the bundle overwrite below: getActiveId()'s
    // stale-identity corroboration compares the live token against the STORED bundle, and this
    // method is about to replace that bundle — asked afterwards, the comparison would run against
    // the fresh capture and could never corroborate. An account live in a rule slot heals that profile, not
    // the global files (see {@link applyReloginBundle}).
    const liveSlot = await this.liveSlotOf(existing.id);

    // File-based capture on every platform (the mac Keychain caveat above applies here too):
    // the transient dir is a plain CLAUDE_CONFIG_DIR the CLI populated with
    // `.credentials.json` + `.claude.json`. Same seam add --fresh reads from.
    const store = this.configDirStore(configDir);
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
    return this.applyReloginBundle(existing, creds, oauthAccount, liveSlot, oauthAccount);
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
    liveSlot: SlotId | undefined,
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
    // A slot with a switch still pending is left alone: that switch's settling reads these files
    // against what it wrote, and a login written under it would be taken for someone else's.
    const pendingThere =
      liveSlot !== undefined &&
      (await this.slotRuntime(liveSlot)
        .intent.read()
        .catch(() => undefined)) !== undefined;
    if (pendingThere) {
      this.log.warn(
        { accountId: existing.id, slot: liveSlot },
        'relogin left the live login alone: a switch in that slot is still unsettled',
      );
    }
    if (liveSlot !== undefined && !pendingThere) {
      // Heal the seat the account actually occupies: the fresh grant of an account live in a rule
      // slot is written into that profile, never the global files. The profile dir already exists (the account is
      // live there), so no ensureGroupProfile is needed on this repair path.
      const credStore = this.slotRuntime(liveSlot).credStore;
      try {
        await credStore.writeLiveCredentials(bundle.claudeAiOauth);
        await this.writeLiveIdentity(bundle.oauthAccount, credStore);
        const check = await credStore.readLiveCredentials();
        healedLiveLogin = check?.accessToken === bundle.claudeAiOauth.accessToken;
      } catch (err) {
        this.log.warn(
          { accountId: existing.id, slot: liveSlot, reason: errorReason(err) },
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
      // The same rules as reloginFromConfigDir for a switch that cannot be settled yet.
      await this.settleForAccountsLocked([accountId]);
      const existing = await this.vault.getAccount(accountId);
      if (!existing) throw new UnknownAccountError(accountId);
      // Read BEFORE the overwrite, for the same reason reloginFromConfigDirLocked does.
      const liveSlot = await this.liveSlotOf(existing.id);
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
        liveSlot,
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
   * Make `targetId` the live account in a slot whose pool holds it. See the class comment for the
   * guarantees.
   *
   * With no `options.slot`, the slot follows from the registry (see {@link defaultSlotFor}): a shared
   * account goes to the global slot, a reserved one to the slot of the rule including it. Naming a
   * slot is how a caller puts an account in a particular slot — a rule's slot may hold its included
   * accounts and the shared accounts it does not exclude — and a slot whose pool does not hold the
   * target is refused ({@link SlotError} `slot_mismatch`) rather than silently replaced: a reserved
   * account can never be global, and an excluded or foreign account never in a rule's slot. Either
   * way the target must be live in no other slot (`live_elsewhere`). A rule-slot activation
   * materialises the profile dir first ({@link ensureGroupProfile}) and commits the rule's live
   * account, leaving the global slot untouched.
   *
   * Everything that decides WHERE the target goes is read UNDER the lock. The rules are a fact
   * another process changes (an include reserves an account, a reset dissolves a rule); a slot
   * decided before the lock can name a slot the target may no longer be in by the time it is written
   * — putting one account live in two slots, or seeding a dissolved rule's profile nothing checks any
   * more. A caller that decided against an older picture (the daemon's per-slot auto-switch, a phone
   * `/switch`) passes the slot it decided for, so a changed picture fails the switch rather than
   * landing it somewhere the caller never meant.
   */
  async activate(targetId: string, options: ActivateOptions = {}): Promise<ActivateResult> {
    // Fingerprint the stored bundles BEFORE taking the lock. Rotation adoption, under the lock, checks
    // the live token against every stored one; with a cold fingerprint cache (a process that has not
    // seen the current bundles, the first run after an upgrade) that is a decrypt per bundle — a
    // PowerShell spawn each on Windows. Paid here it delays only this caller; paid under the lock it
    // eats into the time every holder must finish within (see LOCK_STALE_MS). Best-effort: the check
    // under the lock stays authoritative, and a failure here only means it does the work itself.
    await this.vault.readStoredTokens().catch(() => undefined);
    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const target = await this.vault.getAccount(targetId);
      if (!target) throw new UnknownAccountError(targetId);
      if (target.quarantined) {
        throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
      }

      const picture = await this.vault.readPicture();
      const slotId = options.slot ?? (await this.defaultSlotFor(target, picture));
      if (options.slot !== undefined && !slotMayHold(slotId, targetId, picture)) {
        // The caller asserted a slot whose pool does not hold the target. Name which rule it hit.
        throw new SlotError(this.notInPoolReason(target, slotId, picture), 'slot_mismatch');
      }
      if (slotId !== 'global') this.refuseRuleSlotsOnDarwin();

      const rt = this.slotRuntime(slotId);
      // A rule slot must exist before its live files are written. Idempotent: a no-op when the
      // profile is already materialised, so running it on every activation costs nothing
      // steady-state. Reached only for a rule read under this lock, so it can never re-create the
      // profile of a rule a reset already dissolved.
      if (rt.profileDir !== undefined && picture.rules.some((r) => r.id === rt.ruleId)) {
        ensureGroupProfile(rt.profileDir, this.paths.claudeDir, {
          logger: this.log,
          mainClaudeJsonPath: this.paths.claudeJsonPath,
        });
      }
      return await this.activateInSlot(rt, targetId, options);
    } finally {
      lock.release();
    }
  }

  /** Why `target` may not be live in `slotId` by the registry alone, as a refusal message. */
  private notInPoolReason(
    target: Pick<StoredAccount, 'id' | 'label'>,
    slotId: SlotId,
    picture: RulesPicture,
  ): string {
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined) {
      return picture.reserved.some((a) => a.id === target.id)
        ? `account "${target.label}" is reserved to a folder rule and can only be live in its folders' slots, not the global slot`
        : `account "${target.label}" is not a shared account, so it cannot be live in the global slot`;
    }
    const rule = picture.rules.find((r) => r.id === ruleId);
    if (rule === undefined) {
      return `the folder rule ${ruleId} no longer exists, so nothing can be made live in its slot`;
    }
    const why = rule.exclude.includes(target.id)
      ? 'that folder excludes it'
      : picture.reserved.some((a) => a.id === target.id)
        ? 'it is reserved to other folders'
        : 'it is not a stored account';
    return `account "${target.label}" cannot be live in the folder slot of ${describeRule(rule)}: ${why}`;
  }

  /**
   * Whether `targetId` may be live in `rt`'s slot RIGHT NOW: the slot's pool holds it (read from the
   * registry — see `slotMayHold`), its rule still exists, and it is live in no OTHER slot (token-aware;
   * no account is ever live in two). Returns the slot's rule (undefined for the global slot) when it
   * may, or the {@link SlotError} naming why it may not. The caller holds the credential lock, so the
   * answer stays true until it releases it.
   *
   * The one authority both {@link activateInSlot} (refuse before writing) and {@link settleSwitch}
   * (roll back rather than commit) consult, so the two can never disagree about who belongs where.
   */
  private async slotCandidacy(
    rt: SlotRuntime,
    targetId: string,
  ): Promise<{ ok: true; rule: FolderRule | undefined } | { ok: false; error: SlotError }> {
    const picture = await this.vault.readPicture();
    const target = [...picture.shared, ...picture.reserved].find((a) => a.id === targetId) ?? {
      id: targetId,
      label: targetId,
    };
    const rule =
      rt.ruleId === undefined ? undefined : picture.rules.find((r) => r.id === rt.ruleId);
    if (rt.ruleId !== undefined && rule === undefined) {
      return {
        ok: false,
        error: new SlotError(
          `the folder rule ${rt.ruleId} no longer exists, so nothing can be made live in its slot`,
          'rule_gone',
        ),
      };
    }
    if (!slotMayHold(rt.id, targetId, picture)) {
      return {
        ok: false,
        error: new SlotError(this.notInPoolReason(target, rt.id, picture), 'not_slot_candidate'),
      };
    }
    const stored = await this.vault.readStoredTokens();
    for (const other of allSlots(picture.rules)) {
      if (other === rt.id) continue;
      if ((await this.possibleLiveOwners(other, stored)).has(targetId)) {
        return {
          ok: false,
          error: new SlotError(
            `account "${target.label}" is live in ${await this.slotLabelOf(other)}, and an account ` +
              'is live in one slot at a time',
            'live_elsewhere',
          ),
        };
      }
    }
    return { ok: true, rule };
  }

  /**
   * The switch state machine for one slot — the historical `activate` body, parameterised by the
   * slot it operates on. Every live read/write, the intent WAL, the rollback snapshot and the
   * cadence clock are the SLOT's; the commit is `setActive` for global and `setRuleActive` for a
   * rule. The single credential lock (held by the caller) still serialises all slots.
   *
   * A switch this slot was left in the middle of (a crash, or an undo that failed) is settled FIRST,
   * before anything here reads the slot: every read below — who is live, whose rotation to adopt —
   * goes by the live identity block, which such a switch may have left naming the wrong account.
   * While it cannot be settled, the switch is refused ({@link UnsettledSwitchError}).
   *
   * The target's right to the slot is checked next, against the registry as it stands under the
   * lock ({@link slotCandidacy}), before the cadence clock, the rollback snapshot, the intent, or any
   * live write. The commit at the end refuses an illegitimate target too, but only after the live
   * files already hold it; refusing here is what keeps a refused switch from leaving an account live
   * where it does not belong. So is a target whose stored refresh token another stored account also
   * holds ({@link SharedTokenError}): seated live, that token is refreshed by every session, which
   * kills the other copy, and nothing can say which of the two accounts it really belongs to.
   *
   * The live login is two files, written credentials first and identity second, and the intent says
   * `writing` BEFORE the first of them. Anything that fails from there to the registry commit — the
   * identity write (another process holding `.claude.json` open is enough), the `written` record, the
   * read-back, the commit itself — puts the previous login back, identity and credentials, before
   * the error surfaces ({@link settleSwitch} in undo mode). A slot must never be left holding the
   * target's credentials under the previous account's identity: every reader would take the target's
   * token for the previous account's, and the next switch would store it in that account's bundle.
   * When the undo itself fails, the intent stays, and the next operation on this slot settles it.
   */
  private async activateInSlot(
    rt: SlotRuntime,
    targetId: string,
    options: ActivateOptions,
  ): Promise<ActivateResult> {
    await this.requireSettledLocked(rt);
    const candidacy = await this.slotCandidacy(rt, targetId);
    if (!candidacy.ok) throw candidacy.error;
    const rule = candidacy.rule;
    await this.refuseSharedToken(targetId);

    // Live-reconciled, not the raw registry: `prevActiveId` names who OWNS the live token below
    // (rotation adoption, audit) IN THIS SLOT, and after an external `/login` the registry's record
    // points at an account whose credentials are no longer the live ones.
    const prevActiveId = await this.getActiveId(rt.id);

    // Cadence guard (ToS posture): switching ACCOUNTS faster than a human plausibly would is
    // refused. Each slot keeps its OWN clock, so a rule-slot hop never spends the global slot's budget
    // (and vice versa). Re-activating the already-active account is a heal, not a hop — exempt.
    if (!options.force && this.minSwitchIntervalMs > 0 && targetId !== prevActiveId) {
      const last = await this.readLastSwitchAtMs(rt);
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

    // Snapshot this slot's current live login so a failed write can be rolled back — to disk for a
    // crash, and in memory for this process's own undo (which then needs no decrypt, and knows the
    // identity block even of a slot that held no credentials).
    const liveNow = await rt.credStore.readLiveCredentials();
    const liveOauthAccount = await rt.credStore.readOauthAccount();
    const prior: PriorLive = { creds: liveNow, identity: liveOauthAccount };
    let hasRollback = false;
    if (liveNow) {
      await this.writeSlotRollback(
        rt,
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
    await rt.intent.write(intentAt('begin'));

    // Reconcile-by-reading: if the CLI rotated the previous account's refresh token while it was
    // live in THIS slot, the vault's copy is now stale. Adopt the live token before overwriting.
    // A stale live token left by an in-place re-login is NOT adopted — see the direction guard
    // inside adoptRotationIfNeeded.
    const adoptedPreviousRotation = await this.adoptRotationIfNeeded(
      prevActiveId,
      liveNow,
      liveOauthAccount,
    );

    // Load the target and refresh it if the access token is near expiry. The rotated token is
    // persisted to the vault the instant we get it — single-use tokens die if dropped.
    let bundle = await this.vault.readBundle(targetId);
    // Reconcile the target's derived row from the bundle just decrypted. A switch is the one moment
    // this account's bundle is guaranteed to be open, and the refresh below runs only when the token
    // is near expiry — so without this a fresh-token switch leaves plan/billing metadata frozen at
    // whatever mapping first wrote the row.
    await this.vault.syncMetadata(targetId, bundle);
    let refreshed = false;
    if (bundle.claudeAiOauth.expiresAt - this.clock() < this.refreshSkewMs) {
      bundle = await this.refreshTarget(rt, targetId, bundle, hasRollback);
      refreshed = true;
    }

    // The live files are about to change: say so before the first write, never after it.
    await rt.intent.write(intentAt('writing'));
    let recorded: SwitchIntent['phase'] = 'writing';
    // Which file each step writes, so a failure can say which one could not be written.
    let writing: string | undefined = this.liveFileOf(rt, 'credentials');
    try {
      await rt.credStore.writeLiveCredentials(bundle.claudeAiOauth);
      this.fault('activate:after-credentials-write');
      writing = this.liveFileOf(rt, 'identity');
      await this.writeLiveIdentity(bundle.oauthAccount, rt.credStore);
      writing = join(rt.stateDir, '.switch-intent.json');
      await rt.intent.write(intentAt('written'));
      recorded = 'written';
      this.fault('activate:after-live-write');

      // Verify the write actually landed; a mismatch is undone like any other failure here.
      writing = undefined;
      const check = await rt.credStore.readLiveCredentials();
      if (!check || check.accessToken !== bundle.claudeAiOauth.accessToken) {
        throw new VerifyError(
          'credential read-back did not match after write; the switch was undone',
        );
      }

      // Commit into the slot's own registry side — the last step that can still be undone.
      writing = join(this.paths.vaultDir, rule !== undefined ? 'groups.json' : 'accounts.json');
      if (rule !== undefined) await this.vault.setRuleActive(rule.id, targetId);
      else await this.vault.setActive(targetId);
    } catch (err) {
      // A process that died here runs nothing more; its intent is what recovers it.
      if (this.isSimulatedDeath(err)) throw err;
      const outcome = await this.undoFailedSwitch(rt, intentAt(recorded), prior, err);
      const failedFile = (err as NodeJS.ErrnoException & { dest?: unknown }).dest;
      throw new SwitchFailedError(
        describeFailedSwitch({
          target: (await this.vault.getAccount(targetId))?.label ?? targetId,
          where: await this.slotLabelOf(rt.id),
          cause: err,
          file: typeof failedFile === 'string' ? failedFile : writing,
          outcome,
        }),
        outcome,
        { cause: err },
      );
    }

    // A real account hop (not a same-account heal) restarts THIS slot's cadence clock — forced
    // switches too, so an override doesn't grant a free follow-up switch.
    if (targetId !== prevActiveId) await this.writeLastSwitchAtMs(rt, this.clock());
    this.audit.append({
      ts: this.clock(),
      event: 'activated',
      fromAccountId: prevActiveId,
      toAccountId: targetId,
      origin: options.origin ?? 'manual',
      // The slot this activation landed in, so attribution can build one timeline per slot: a rule
      // hop must not appear on the global account's timeline (and vice versa).
      slot: rt.id,
      ...(options.reason !== undefined ? { detail: options.reason } : {}),
    });
    await this.finishIntent(rt);
    this.log.info(
      { targetId, slot: rt.id, refreshed, adoptedPreviousRotation },
      'account activated',
    );
    return {
      ok: true,
      activeAccountId: targetId,
      refreshed,
      adoptedPreviousRotation,
      wroteCredentials: true,
    };
  }

  /**
   * Put a slot back after a switch failed between its first live write and its commit, then let the
   * caller rethrow the original error. Uses the in-memory snapshot, so the undo needs no decrypt. An
   * undo that fails too is logged and leaves the intent in place — the next locked operation on this
   * slot settles it ({@link attemptSettleLocked}) — rather than replacing the error the caller must
   * see.
   *
   * The intent is marked `undo` first, so whoever settles it later finishes the undo instead of
   * completing a switch its caller was told failed — and does not take the target's identity block,
   * which this switch wrote itself, for evidence of whose token is live. A mark that cannot be
   * written only leaves the intent as it was.
   */
  private async undoFailedSwitch(
    rt: SlotRuntime,
    pending: SwitchIntent,
    prior: PriorLive,
    cause: unknown,
  ): Promise<FailedSwitchOutcome> {
    // Logged at info: the caller is handed the whole story as a SwitchFailedError, and a one-shot
    // command's stderr is for that plain line, not a structured copy of it. The daemon's log, at
    // info, keeps every one.
    const undoing: SwitchIntent = { ...pending, undo: true };
    await rt.intent
      .write(undoing)
      .catch((err: unknown) =>
        this.log.info(
          { slot: rt.id, targetId: pending.targetId, reason: errorReason(err) },
          'could not record that a failed switch is being undone',
        ),
      );
    try {
      const result = await this.settleSwitch(rt, undoing, 'undo', prior);
      const live = await rt.credStore.readLiveCredentials().catch(() => undefined);
      const outcome: FailedSwitchOutcome = sameGrant(live, prior.creds)
        ? 'restored'
        : 'kept_other_login';
      this.log.info(
        {
          slot: rt.id,
          targetId: pending.targetId,
          reason: errorReason(cause),
          undo: result.action,
          detail: result.detail,
        },
        'switch failed after its live write and was undone',
      );
      return outcome;
    } catch (undoErr) {
      this.log.info(
        {
          slot: rt.id,
          targetId: pending.targetId,
          reason: errorReason(cause),
          undoReason: errorReason(undoErr),
        },
        'switch failed after its live write and could not be undone; it stays pending until the ' +
          'next operation on this slot settles it',
      );
      return 'pending';
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
      // Who is live where is read below; a switch left in this account's own slot, or to or from it
      // anywhere, is settled first — and refuses this refresh while it cannot be. A stuck slot that
      // does not involve it lets it run, without adopting anything from that slot's live login.
      // Nothing here can spend a live token regardless: the last check before a network refresh
      // reads the tokens themselves.
      const untrusted = await this.settleForAccountsLocked([targetId]);
      // Live-reconciled for the same reason as `activate()`, and across EVERY slot: the adopt-only
      // protection below must shield the account whose token is ACTUALLY live wherever it is live —
      // network-refreshing a token some session (global OR a rule profile) is holding would strand
      // it. An account is live in at most one slot, so the first hit is the whole answer.
      const liveSlot = await this.liveSlotOf(targetId);

      if (liveSlot !== undefined) {
        // Live account: adopt-only (see the method comment for why we never refresh it). Read and
        // adopt from the slot the account is actually live in — and not even that from a live login
        // an unsettled switch may have left half-written.
        const credStore = this.slotRuntime(liveSlot).credStore;
        const liveNow = await credStore.readLiveCredentials();
        const liveOauthAccount = await credStore.readOauthAccount();
        const adopted = untrusted.has(liveSlot)
          ? false
          : await this.adoptRotationIfNeeded(targetId, liveNow, liveOauthAccount);
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

      // The last word before spending the token: whatever the identity blocks say, a slot whose live
      // refresh token IS this stored one has sessions holding it, and a network refresh would strand
      // them. (A slot left holding one account's token under another's identity, with nothing
      // recorded that could settle it, is how the reconciled reading above can miss it.)
      if ((await this.slotHoldingRefreshToken(bundle.claudeAiOauth.refreshToken)) !== undefined) {
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
   * Recover from a switch that did not finish (a crash, or an undo that failed), IN EVERY SLOT.
   * Called on daemon/CLI startup; every locked operation that reads or writes a slot also settles
   * that slot first (see {@link settleSlotsLocked}). See {@link settleSwitch} for what it does.
   *
   * Each slot keeps its own intent WAL, so a crash can leave one pending per slot. This walks the
   * global slot (whose WAL is the historical vault-dir `.switch-intent.json`, so a pre-upgrade
   * intent recovers unchanged) and every rule slot. The single lock serialises the whole sweep.
   *
   * The return preserves the historical single-slot contract: with one pending intent (the common
   * case, and every global-only path) it returns exactly that slot's result; only a genuine
   * multi-slot recovery collapses to a summary.
   *
   * Never throws for a switch it cannot settle — that would take the daemon's startup down over a
   * file another process happens to hold open. It settles every other slot, then answers
   * `unsettled` with the reason, and leaves that switch pending for the next operation on its slot
   * to retry.
   */
  async recover(): Promise<RecoverResult> {
    // Fast path: peek every currently-known slot's intent without locking. Most startups have none.
    // A rule created between this peek and the lock cannot have a crashed switch yet, so missing it
    // here is harmless; the authoritative walk re-derives the slot set under the lock. A record that
    // cannot be read counts as pending: the locked attempt below reports it.
    let anyPending = false;
    for (const slotId of await this.allSlotIds()) {
      const pending = await this.slotRuntime(slotId)
        .intent.read()
        .catch(() => null);
      if (pending !== undefined) {
        anyPending = true;
        break;
      }
    }
    if (!anyPending) return { recovered: false, action: 'none' };

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const results: RecoverResult[] = [];
      const reasons: string[] = [];
      for (const slotId of await this.allSlotIds()) {
        const attempt = await this.attemptSettleLocked(slotId);
        if (attempt.kind === 'settled') results.push(attempt.result);
        else if (attempt.kind === 'unsettled') reasons.push(attempt.error.message);
      }
      if (reasons.length > 0) {
        return { recovered: false, action: 'unsettled', detail: reasons.join('; ') };
      }
      return this.summariseRecovery(results);
    } finally {
      lock.release();
    }
  }

  /**
   * Settle the pending switches of these slots, for a caller that holds the credential lock and is
   * about to read them. A switch left between its live writes and its commit — by a crash, or by an
   * undo that failed — must not wait for a restart: until it is settled, the slot's identity block
   * may name the wrong account, and everything that reads a slot goes by that block. Cheap when
   * nothing is pending, which is nearly every call: one read of an absent intent file per slot.
   *
   * Callers name the slots they touch, never every slot, and this never throws: a slot whose switch
   * cannot be finished or undone right now (a live file another program keeps open) is left pending
   * and returned, with its attempt, so one stuck slot cannot fail operations on the others. What the
   * caller may then do with such a slot: never write it (a write settles strictly first, see
   * {@link requireSettledLocked}), never adopt from its live login, never trust its identity block.
   */
  private async settleSlotsLocked(
    slotIds: readonly SlotId[],
  ): Promise<Map<SlotId, Extract<SettleAttempt, { kind: 'unsettled' }>>> {
    const unsettled = new Map<SlotId, Extract<SettleAttempt, { kind: 'unsettled' }>>();
    for (const slotId of new Set(slotIds)) {
      const attempt = await this.attemptSettleLocked(slotId);
      if (attempt.kind === 'unsettled') unsettled.set(slotId, attempt);
    }
    return unsettled;
  }

  /**
   * Settle the slot `rt` before a write to it, and refuse the write with the reason
   * ({@link UnsettledSwitchError}) while a switch pending there cannot be settled: whatever was
   * written would sit beside a half-written login, and settling it later would read the files
   * against what that switch wrote.
   */
  private async requireSettledLocked(rt: SlotRuntime): Promise<void> {
    const attempt = await this.attemptSettleLocked(rt.id);
    if (attempt.kind === 'unsettled') throw attempt.error;
  }

  /**
   * Settle what an operation on these accounts' bundles depends on, and refuse the operation
   * ({@link UnsettledSwitchError}) when a switch to or from one of them cannot be settled yet:
   * settling it reads and may write exactly these bundles. An account may legitimately be live in the
   * global slot or in any rule slot whose pool holds it, so every slot is settled — one read of an
   * absent intent file per slot when nothing is pending. A stuck slot whose switch involves none of
   * these accounts lets the operation run; the slots returned are the stuck ones it must neither
   * adopt from nor write.
   */
  private async settleForAccountsLocked(accountIds: readonly string[]): Promise<Set<SlotId>> {
    const unsettled = await this.settleSlotsLocked(await this.allSlotIds());
    for (const { pending, error } of unsettled.values()) {
      if (pending !== undefined && accountIds.some((id) => involves(pending, id))) throw error;
    }
    return new Set(unsettled.keys());
  }

  /**
   * One attempt at settling whatever switch is pending in a slot, for a caller holding the lock.
   * Never throws: a switch that cannot be settled, or a record of one that cannot be read, comes back
   * as `unsettled` with the error that says why — logged here, once per reason per slot (see
   * {@link unsettledLogged}). A switch recorded as being undone is finished as an undo.
   */
  private async attemptSettleLocked(slotId: SlotId): Promise<SettleAttempt> {
    const rt = this.slotRuntime(slotId);
    let pending: SwitchIntent | undefined;
    try {
      pending = await rt.intent.read();
      if (!pending) return { kind: 'none' };
      const mode = pending.undo === true ? 'undo' : 'recover';
      const result = await this.settleSwitch(rt, pending, mode);
      this.unsettledLogged.delete(slotId);
      return { kind: 'settled', result };
    } catch (err) {
      const error = await this.unsettledError(slotId, pending, err);
      if (this.unsettledLogged.get(slotId) !== error.message) {
        this.unsettledLogged.set(slotId, error.message);
        this.log.info(
          {
            slot: slotId,
            targetId: pending?.targetId,
            prevActiveId: pending?.prevActiveId,
            reason: errorReason(err),
          },
          'an interrupted switch could not be finished or undone; it stays pending and is retried',
        );
      }
      return { kind: 'unsettled', pending, error };
    }
  }

  /** The error that tells an operator a pending switch could not be settled, where, and why. */
  private async unsettledError(
    slotId: SlotId,
    pending: SwitchIntent | undefined,
    cause: unknown,
  ): Promise<UnsettledSwitchError> {
    const reason = errorReason(cause);
    const where = await this.slotLabelOf(slotId);
    if (pending === undefined) {
      // Nothing can ever settle a record nobody can read; saying so is the whole remedy.
      return new UnsettledSwitchError(
        `the record of an interrupted switch of ${where} could not be read (${reason}); ${where} ` +
          'stays blocked until it can - check its live login with `cctl doctor`, then delete ' +
          join(this.slotRuntime(slotId).stateDir, '.switch-intent.json'),
        { cause },
      );
    }
    const target = await this.vault.getAccount(pending.targetId).catch(() => undefined);
    return new UnsettledSwitchError(
      `a switch of ${where} to "${target?.label ?? pending.targetId}" was interrupted and could ` +
        `not be finished or undone yet (${reason}); until it is, nothing writes ${where}. Every ` +
        'operation on it and `cctl recover` retries it - if a program keeps its .claude.json or ' +
        '.credentials.json open, closing it lets it finish',
      { cause },
    );
  }

  /** Where a slot's live credentials or identity block is written, as a message names it: the
   *  file, or on macOS the Keychain item that holds the global slot's credentials. */
  private liveFileOf(rt: SlotRuntime, which: 'credentials' | 'identity'): string {
    const dir = rt.profileDir;
    if (which === 'identity') {
      return dir === undefined ? this.paths.claudeJsonPath : join(dir, '.claude.json');
    }
    if (dir !== undefined) return join(dir, '.credentials.json');
    return this.platform === 'darwin'
      ? "Claude Code's login Keychain item"
      : this.paths.credentialsPath;
  }

  /** A slot as a message names it: "the global slot", or the folder slot of a rule's folders. */
  private async slotLabelOf(slotId: SlotId): Promise<string> {
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined) return 'the global slot';
    const rule = await this.vault.getRule(ruleId).catch(() => undefined);
    return rule === undefined
      ? `the folder slot ${slotId}`
      : `the folder slot of ${describeRule(rule)}`;
  }

  /**
   * Bring a slot whose switch did not finish to a state where both live files name one account, and
   * clear its intent. Two modes: recovery of a switch a crash left pending (`recover`), and undoing a
   * switch that failed (`undo`) — by the switch itself, handed the in-memory snapshot, or later, for
   * an undo that failed too (the intent then carries `undo`, and the snapshot is read from disk).
   *
   * Nothing is assumed from the phase beyond `begin` (nothing live written — cleared; a refresh or an
   * adoption that reached the vault is kept). From `writing` on — and at an older build's `refreshed`,
   * recorded just before its first live write — the files are LOOKED AT, because the credentials may
   * be the target's while the identity block still names the previous account. In order:
   *
   *   1. The target's credentials are live. Recovery rolls FORWARD when the target may still hold the
   *      slot: the credentials are provably complete (one atomically written file), so writing the
   *      target's identity completes the switch, which is then committed. When that identity write
   *      cannot be made (another process keeps `.claude.json` open), or on an undo, or for a target
   *      that has lost its right to the slot since ({@link slotCandidacy}), it rolls BACK to the
   *      previous login instead (a slot that held none before is emptied) — which, with the previous
   *      identity still in place, needs only the credentials file.
   *   2. The previous credentials are live: the credentials write never landed, or has been undone.
   *      Only the identity can still be off, and it is put back.
   *   3. Neither, but the identity names the target, in recovery: both writes landed and a running
   *      session has since rotated the target's token, so the live token is the target's. Recovery
   *      rolls forward (nothing to rewrite); for a target that lost the slot it first adopts it into
   *      the target's own bundle, then rolls back. An undo never gets here: there the target's
   *      identity is the failed switch's own write moments earlier, which says nothing about the
   *      token beside it — typically the previous account's rotation, landed by a session that had
   *      begun refreshing just before the switch (the very write that failed its read-back).
   *   4. Otherwise the live token moved on after the switch touched it. It is left live — overwriting
   *      it would destroy whichever login it is — and no bundle is changed. In recovery at `written`
   *      the switch had already written its identity block, so one that does not name the target was
   *      written later, by whoever wrote the live login (a `/login`), and is left standing. In every
   *      other case the block is either left over from before the switch or the switch's own, beside
   *      a token the files cannot attribute, so the block, the one statement that may be false, is
   *      removed. Claude Code re-derives it from the token itself, and until it does, rotation
   *      adoption refuses to credit the token to anyone (see adoptionRefusal).
   */
  private async settleSwitch(
    rt: SlotRuntime,
    pending: SwitchIntent,
    mode: 'recover' | 'undo',
    knownPrior?: PriorLive,
  ): Promise<RecoverResult> {
    if (pending.phase === 'begin') {
      await this.finishIntent(rt);
      this.auditRecovery(pending.prevActiveId, null, `cleared at phase begin (${rt.id})`);
      return {
        recovered: true,
        action: 'cleared',
        detail: 'no live write had occurred (phase begin)',
      };
    }

    const candidacy = await this.slotCandidacy(rt, pending.targetId);
    const target = await this.vault.readBundle(pending.targetId).catch(() => undefined);
    const prior = knownPrior ?? (await this.readPriorLive(rt, pending));
    const live = await rt.credStore.readLiveCredentials();
    const liveIdentity = await rt.credStore.readOauthAccount();
    const targetUuid = target?.oauthAccount?.accountUuid;
    const mayForward = mode === 'recover' && candidacy.ok;
    if (!candidacy.ok) {
      this.log.warn(
        { slot: rt.id, targetId: pending.targetId, reason: candidacy.error.message },
        'interrupted switch target no longer belongs to its slot; rolling back instead of forward',
      );
    }

    // 1. The target's credentials are live.
    if (target !== undefined && live !== undefined && sameGrant(live, target.claudeAiOauth)) {
      if (mayForward) {
        // Finishing needs the identity write; undoing, with the previous identity still in place,
        // needs only the credentials. Both leave the live files naming one account. Only this write
        // falls back: past it, a failed commit is the registry's, which undoing cannot fix.
        const identityLanded = await this.writeLiveIdentity(target.oauthAccount, rt.credStore).then(
          () => true,
          (err: unknown) => {
            this.log.info(
              { slot: rt.id, targetId: pending.targetId, reason: errorReason(err) },
              'could not finish an interrupted switch; undoing it instead',
            );
            return false;
          },
        );
        if (identityLanded) return this.rollForward(rt, pending, candidacy.rule);
      }
      return this.rollBack(rt, pending, prior, mode);
    }

    // 2. The previous credentials are live: at most the identity is left to put back.
    if (prior !== undefined && sameGrant(live, prior.creds)) {
      let changed = false;
      if (prior.identity !== null) {
        changed = !isDeepStrictEqual(liveIdentity, prior.identity);
        if (changed) await this.writeLiveIdentity(prior.identity, rt.credStore);
      } else if (targetUuid !== undefined && liveIdentity?.accountUuid === targetUuid) {
        // Unrecorded prior identity, no credentials then or now: the target's block is removed.
        await rt.credStore.clearOauthAccount();
        changed = true;
      }
      await this.finishIntent(rt);
      this.auditRecovery(
        pending.targetId,
        pending.prevActiveId,
        `${mode === 'undo' ? 'undid' : 'recovered'} a switch whose live write had not landed (${rt.id})`,
      );
      return changed
        ? { recovered: true, action: 'rolled_back', detail: 'restored the previous live identity' }
        : { recovered: true, action: 'cleared', detail: 'the live write had not landed' };
    }

    // 3. In recovery, the identity names the target: the live token is the target's, rotated since.
    //    (In an undo that identity is the failed switch's own write, and proves nothing.)
    if (
      mode === 'recover' &&
      target !== undefined &&
      targetUuid !== undefined &&
      liveIdentity?.accountUuid === targetUuid
    ) {
      if (mayForward) return this.rollForward(rt, pending, candidacy.rule);
      await this.adoptRotationIfNeeded(pending.targetId, live, liveIdentity);
      return this.rollBack(rt, pending, prior, mode);
    }

    // 4. A login written after the switch touched the slot: keep it, change no bundle, and withdraw
    //    the identity block unless it provably post-dates the switch's own identity write.
    const identityPostdates = mode === 'recover' && pending.phase === 'written';
    if (!identityPostdates) await rt.credStore.clearOauthAccount();
    await this.finishIntent(rt);
    const fields = { slot: rt.id, targetId: pending.targetId, prevActiveId: pending.prevActiveId };
    const message = identityPostdates
      ? 'the slot holds a login written after an unfinished switch; it was left in place'
      : 'the live login after an unfinished switch could not be attributed; its identity block ' +
        'was removed so Claude Code re-derives it, and no bundle was changed';
    // An undo's caller is told this in its SwitchFailedError; only a recovery has no one to tell.
    if (mode === 'undo') this.log.info(fields, message);
    else this.log.warn(fields, message);
    this.auditRecovery(
      pending.prevActiveId,
      null,
      `left a later live login in place${identityPostdates ? '' : ' and removed its identity block'} (${rt.id})`,
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
   *  credentials recorded none: the slot held no credentials, identity unknown. A snapshot that should
   *  exist but is missing or cannot be decrypted is `undefined` — nothing is known — and is logged:
   *  settling must not fail every later operation on a snapshot it can never read. */
  private async readPriorLive(
    rt: SlotRuntime,
    pending: SwitchIntent,
  ): Promise<PriorLive | undefined> {
    if (!pending.hasRollback) return { creds: undefined, identity: null };
    try {
      const snapshot = await this.readSlotRollback(rt);
      if (snapshot === undefined) return undefined;
      return { creds: snapshot.claudeAiOauth, identity: snapshot.oauthAccount };
    } catch (err) {
      this.log.error(
        { slot: rt.id, reason: errorReason(err) },
        'the rollback snapshot of an unfinished switch could not be read',
      );
      return undefined;
    }
  }

  /**
   * Complete a pending switch whose target's login is live under the target's identity: the
   * registry commit, what the switch itself would have done next.
   */
  private async rollForward(
    rt: SlotRuntime,
    pending: SwitchIntent,
    rule: FolderRule | undefined,
  ): Promise<RecoverResult> {
    if (rule !== undefined) await this.vault.setRuleActive(rule.id, pending.targetId);
    else await this.vault.setActive(pending.targetId);
    this.auditRecovery(pending.prevActiveId, pending.targetId, `rolled forward (${rt.id})`);
    await this.finishIntent(rt);
    return { recovered: true, action: 'rolled_forward', detail: `committed ${pending.targetId}` };
  }

  /**
   * Put a slot's previous login back and clear the intent. Identity FIRST, then credentials — the
   * reverse of the switch's own order, so failing part way leaves the half-state the switch itself
   * passes through (the target's credentials under the previous identity), which the still-pending
   * intent settles next time. The other order could leave the previous account's token under the
   * TARGET's identity, a state nothing recorded describes. A previous login that is not known (its
   * snapshot missing or unreadable) is treated as an empty slot: the target is taken out, which loses
   * nothing, since both accounts' vault copies are current.
   */
  private async rollBack(
    rt: SlotRuntime,
    pending: SwitchIntent,
    prior: PriorLive | undefined,
    mode: 'recover' | 'undo',
  ): Promise<RecoverResult> {
    const identity = prior === undefined || prior.identity === null ? undefined : prior.identity;
    await this.writeLiveIdentity(identity, rt.credStore);
    if (prior?.creds !== undefined) await rt.credStore.writeLiveCredentials(prior.creds);
    else await rt.credStore.clearLiveCredentials();
    await this.finishIntent(rt);
    const what = prior?.creds !== undefined ? 'rolled back' : 'removed the target login';
    this.auditRecovery(
      pending.targetId,
      pending.prevActiveId,
      `${mode === 'undo' ? 'undid a failed switch: ' : ''}${what} (${rt.id})`,
    );
    return prior?.creds !== undefined
      ? { recovered: true, action: 'rolled_back', detail: 'restored previous live credentials' }
      : {
          recovered: true,
          action: 'rolled_back',
          detail: 'removed the target credentials from a slot that held no login before',
        };
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

  /** Collapse per-slot recovery outcomes into one {@link RecoverResult}. A single recovery (the
   *  common case, and every global-only path) is returned verbatim, so the historical contract is
   *  preserved; several at once report the most consequential action and a count. */
  private summariseRecovery(results: RecoverResult[]): RecoverResult {
    const [first, ...rest] = results;
    if (first === undefined) return { recovered: false, action: 'none' };
    if (rest.length === 0) return first;
    const action: RecoverResult['action'] = results.some((r) => r.action === 'rolled_forward')
      ? 'rolled_forward'
      : results.some((r) => r.action === 'rolled_back')
        ? 'rolled_back'
        : 'cleared';
    return { recovered: true, action, detail: `recovered ${results.length} slots` };
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

  /**
   * Refuse to seat `targetId` in any slot when another stored account's bundle holds the same
   * refresh token — the contamination an older build's mis-attributed adoption left in a vault. Live,
   * the token is refreshed by every session, which kills the other copy, and the files cannot say
   * which of the two accounts it belongs to; seated in a second slot it is live twice. The
   * fingerprints come from the cache warmed before the lock.
   */
  private async refuseSharedToken(targetId: string): Promise<void> {
    const sharers = (await this.vault.readStoredTokens()).refreshSharers(targetId);
    if (sharers.length === 0) return;
    const rows = await this.vault.listAllAccounts();
    throw new SharedTokenError(
      `accounts ${quotedLabels([targetId, ...sharers], rows)} store the same login token, so ` +
        `neither is switched to until that is fixed: ${SHARED_TOKEN_REMEDY}`,
    );
  }

  /** Refresh the target's token for an in-flight `activate()` — the shared refresh core plus
   *  the switch-specific cleanup (this slot's intent + rollback snapshot) on failure. */
  private async refreshTarget(
    rt: SlotRuntime,
    targetId: string,
    bundle: CredentialBundle,
    hasRollback: boolean,
  ): Promise<CredentialBundle> {
    try {
      return await this.refreshAndPersist(targetId, bundle);
    } catch (err) {
      // Nothing live has been written yet, so cleanup is just this slot's intent + snapshot.
      await rt.intent.clear();
      if (hasRollback) await this.clearSlotRollback(rt);
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
  private async writeLiveIdentity(
    oauthAccount: OauthAccount | undefined,
    credStore: CredentialStore,
  ): Promise<void> {
    if (oauthAccount) await credStore.writeOauthAccount(oauthAccount);
    else await credStore.clearOauthAccount();
  }

  /** Clear a slot's intent and rollback snapshot together — the switch is finished either way. */
  private async finishIntent(rt: SlotRuntime): Promise<void> {
    await rt.intent.clear();
    await this.clearSlotRollback(rt);
  }

  // ---- per-slot rollback snapshot (secret; mid-switch only) ----
  //
  // A slot's rollback lives beside its intent WAL (global: the vault dir's historical `.rollback.enc`;
  // a rule: `<vaultDir>/slots/<ruleId>/.rollback.enc`). Sealed with the same protector the vault
  // uses for account bundles, because a rollback snapshot holds the previous live credentials.

  private slotRollbackPath(rt: SlotRuntime): string {
    return join(rt.stateDir, '.rollback.enc');
  }

  private async writeSlotRollback(rt: SlotRuntime, bundle: CredentialBundle): Promise<void> {
    const blob = await this.protector.protect(Buffer.from(JSON.stringify(bundle), 'utf8'));
    await atomicWriteFile(this.slotRollbackPath(rt), blob);
  }

  private async readSlotRollback(rt: SlotRuntime): Promise<CredentialBundle | undefined> {
    let blob: string;
    try {
      blob = await readFile(this.slotRollbackPath(rt), 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    try {
      const plain = await this.protector.unprotect(blob);
      return JSON.parse(plain.toString('utf8')) as CredentialBundle;
    } catch (err) {
      throw new VaultError('failed to decrypt or parse rollback snapshot', { cause: err });
    }
  }

  private async clearSlotRollback(rt: SlotRuntime): Promise<void> {
    await removeIfExists(this.slotRollbackPath(rt));
  }

  // ---- cadence state (non-secret), per slot ----

  /** Epoch ms of a slot's last committed account hop, or `undefined` if none recorded. */
  private async readLastSwitchAtMs(rt: SlotRuntime): Promise<number | undefined> {
    try {
      const raw = await readFile(this.lastSwitchPath(rt), 'utf8');
      const parsed = JSON.parse(raw) as { lastSwitchAtMs?: unknown };
      return typeof parsed.lastSwitchAtMs === 'number' ? parsed.lastSwitchAtMs : undefined;
    } catch {
      // Missing or corrupt state must never block a switch — the guard just doesn't apply.
      return undefined;
    }
  }

  private async writeLastSwitchAtMs(rt: SlotRuntime, atMs: number): Promise<void> {
    await atomicWriteFile(this.lastSwitchPath(rt), JSON.stringify({ lastSwitchAtMs: atMs }));
  }

  private lastSwitchPath(rt: SlotRuntime): string {
    return join(rt.stateDir, 'last-switch.json');
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
