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
  AccountLabelChangedError,
  CadenceError,
  ImportInterruptedError,
  LeaseHolderCapError,
  LockTimeoutError,
  QuarantineError,
  RefreshError,
  SessionSlotError,
  SharedTokenError,
  SlotError,
  SwitchEngineError,
  SwitchFailedError,
  UnknownAccountError,
  UnsettledSwitchError,
  type FailedSwitchOutcome,
  VaultError,
  VerifyError,
} from './errors.js';
import { IntentStore } from './intent.js';
import { LOCK_STALE_MS, acquireLock, yieldLock, type Lock, type LockOptions } from './lock.js';
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
import {
  CLAUDE_CODE_TITLE_MAX_LENGTH,
  aliasFitsSessionTitle,
  aliasKey,
  aliasScopeUniquenessKey,
  canonicalizeFolder,
  checkAliasFolder,
  checkBindTarget,
  folderKey,
  folderUniquenessKey,
  isWellFormedText,
  isWithin,
  shellQuoteArg,
} from './folderPath.js';
import { projectDirMatches, recordedFolderFor } from './recordedFolder.js';
import { sanitizeTerminalText } from './terminalSafe.js';
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
  chooseSeat,
  withoutKeptOut,
  describeRuleScopes,
  isLeaseRule,
  leaseOccupants,
  leaseRuleId,
  leaseSessionPids,
  occupantCount,
  occupantsPhrase,
  operatorRules,
  sameHolder,
  sameHolderProcess,
  withHolders,
  withoutHolders,
  exactAliasRule,
  exactFolderRule,
  resolveFolderRule,
  resolveSessionRule,
  ruleOfSlot,
  ruleScopeCount,
  rulesIncluding,
  slotMayHold,
  slotPhrase,
  slotPool,
  slotWordsOf,
  withRule,
  type SeatOccupant,
  type RulesPicture,
} from './folderRules.js';
import { readdir, readFile, rename, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { PENDING_LOGIN_REASON, ruleIdOfSlot, ruleSlotId } from './types.js';
import type {
  AccountIdentity,
  AccountView,
  ActivateResult,
  AddAccountOptions,
  AddPendingAccountOptions,
  ClaudeOauth,
  CredentialBundle,
  ExcludeResult,
  FolderBindingSnapshot,
  FolderRule,
  ImportBundleResult,
  ImportConflict,
  ImportLeftOut,
  ImportRuleOutcome,
  ImportRuleSpec,
  ImportRuleVerdict,
  ImportRulesOptions,
  ImportRulesPlan,
  ImportRulesResult,
  IncludeResult,
  LeaseDeferReason,
  LeaseHolder,
  LeaseHolderState,
  LeaseOccupancyProbe,
  LeaseRelease,
  LeaseSweepReport,
  LeaseView,
  OauthAccount,
  PendingImportAccount,
  PlanImportRulesOptions,
  PoolEntry,
  ProcessRow,
  ProcFs,
  SessionLease,
  SessionSlotClaim,
  SessionSlotPlan,
  RecoverResult,
  RefreshTokenResult,
  ReloginResult,
  RemoveAccountOptions,
  RepairResult,
  ResetResult,
  RuleLiveResult,
  RuleScopeRef,
  RunningSession,
  SessionIdentity,
  SessionIdentityLookup,
  SlotHandOff,
  SlotSeat,
  SlotId,
  SlotLiveToken,
  SlotViolation,
  StoredAccount,
  SwitchIntent,
} from './types.js';
import {
  MAX_ALIAS_LENGTH,
  MAX_LEASE_HOLDERS,
  MAX_RESERVED_ACCOUNTS,
  MAX_RULES,
  needsMetadataBackfill,
  Vault,
  type DedupeReport,
  type RegistryPicture,
  type RuleWriter,
} from './vault.js';
import {
  LEASE_START_TOLERANCE_MS,
  claudeCodeIdentity,
  holderState,
  isClaudeCodeProcess,
  isExitedState,
  linuxTags,
  pidAlive,
  procFs as realProcFs,
  readProcessConfigDirs,
  readProcessTable,
  selfHolder,
  visibleNamespaces,
  type HolderEvidence,
} from './processStarts.js';
import { hostname } from 'node:os';
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
  /** Reads a running session's custom title and recorded folder from its transcript, for the alias
   *  half of the running-session scan. Claude Code's `sessions/<pid>.json` does not carry the title
   *  of a RESUMED session (it records a derived name), so without this seam the scan can only use a
   *  name the operator set at launch (`nameSource: "user"`). The CLI wires the daemon's session
   *  catalog here; absent, only that launch-time name is used. */
  sessionIdentity?: SessionIdentityLookup;
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
  /** How a parallel session's holders are judged (see processStarts.ts). Every field defaults to the
   *  real machine: `os.hostname()`, "alive unless ESRCH", the Windows process table, `/proc`, and
   *  this process's own pid and start. Tests inject them to stand in for processes. */
  leaseProcesses?: LeaseProcessSeams;
}

/** The process seams of parallel sessions (see {@link SwitchEngineOptions.leaseProcesses}). */
export interface LeaseProcessSeams {
  hostname?: () => string;
  isAlive?: (pid: number) => boolean;
  processTable?: () => Promise<ProcessRow[]>;
  /** Windows: the CLAUDE_CONFIG_DIR each process was started with (see `readProcessConfigDirs`). */
  processConfigDirs?: (pids: readonly number[]) => Promise<Map<number, string | null>>;
  procFs?: ProcFs;
  /** This process as a holder would record it. */
  self?: { pid: number; start: number };
}

/** What a sweep of parallel sessions does (see {@link SwitchEngine.sweepLeases}). */
export interface LeaseSweepOptions {
  /** full (the daemon, the CLI where a lease blocks the user, a join): the Windows start check of
   *  every holder via one process-table query. quick (the CLI on its way to something else): no
   *  start check on Windows (kill-0 only), and the process table is read only when a session's
   *  holders are all gone. Either way a session ends only once nothing runs on its profile: on Linux
   *  the start check and the search for processes on the profile are file reads in both modes. */
  mode: 'quick' | 'full';
  /** The profile's background workers; a sweep never ends a lease whose service still hosts some. */
  probe: LeaseOccupancyProbe;
  /** Only this account's parallel session (the refusal paths). */
  only?: string;
  /** Per-call stand-ins for the engine's process seams. */
  isAlive?: (pid: number) => boolean;
  processTable?: () => Promise<ProcessRow[]>;
  processConfigDirs?: (pids: readonly number[]) => Promise<Map<number, string | null>>;
  procFs?: ProcFs;
}

/** Per-call options for {@link SwitchEngine.activate}. */
export interface ActivateOptions {
  /** Bypass the switch-cadence guard for a deliberate operator override. */
  force?: boolean;
  /** Internal: set only by the parallel-session claim, which seats the account it holds. Every
   *  other activation of an account a parallel session holds is refused (`leased`). */
  lease?: boolean;
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

/** A rule's scopes as a display list, for messages ("the folder slot of <folders>"): its folders,
 *  then its session aliases. Falls back to the rule's label for a rule that somehow holds none. */
function describeRule(rule: FolderRule): string {
  return describeRuleScopes(rule);
}

/**
 * Whether a slot is a parallel session's. Such a slot is never a hand-off's mover: it is switched
 * only by its own claim, never under its terminal. Another account logged in there (a /login inside
 * the session) stays until the session ends, and since it is live there, no other slot can take it
 * meanwhile, as repairLeaseSlotLocked leaves it.
 */
function isLeaseSlot(slotId: SlotId, rules: readonly FolderRule[]): boolean {
  const rule = ruleOfSlot(slotId, rules);
  return rule !== undefined && isLeaseRule(rule);
}

/** What {@link isClaudeCodeProcess} judges a Windows process-table row by. */
function rowIdentity(row: ProcessRow): { image?: string; commandLine?: string } {
  return {
    ...(row.name !== undefined ? { image: row.name } : {}),
    ...(row.commandLine !== undefined ? { commandLine: row.commandLine } : {}),
  };
}

/** A clock time as hh:mm, local. */
function clockTime(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Who holds an account's parallel session, for a refusal: `account "W" is in use by a parallel
 *  session (pid 4188, since 09:12)`, or, when several things hold it, what they are and every pid.
 *  `several` says which of the two it is, for the tail the caller adds. Counted the way
 *  {@link leaseOccupants} counts (terminals, background sessions, processes left running), never by
 *  how many processes happen to be recorded: one terminal is one session whatever it records. */
function leaseInUseBy(label: string, lease: SessionLease): { text: string; several: boolean } {
  const pids = leaseSessionPids(lease.holders);
  const since = clockTime(lease.startedAtMs);
  const occupants = leaseOccupants(lease.holders);
  if (occupantCount(occupants) <= 1) {
    const list = pids.length === 0 ? '?' : pids.join(', ');
    return {
      text: `account "${label}" is in use by a parallel session (pid${pids.length > 1 ? 's' : ''} ${list}, since ${since})`,
      several: false,
    };
  }
  return {
    text:
      `account "${label}" is in use by a parallel session on ${occupantsPhrase(occupants)} ` +
      `(pids ${pids.join(', ')}, since ${since})`,
    several: true,
  };
}

/** Why an account a parallel session holds is not available, as `cctl switch`, the phone and
 *  activate say it. Several terminals (or background sessions) on one account share one parallel
 *  session, which ends when the last of them exits. */
function leasedRefusal(label: string, lease: SessionLease): string {
  const by = leaseInUseBy(label, lease);
  return by.several
    ? `${by.text}; it rejoins the pool when the last of them exits`
    : `${by.text}; it rejoins the pool when that session exits`;
}

/** The parallel-session rule of an account, if it has one. */
function leaseRuleOf(
  accountId: string,
  rules: readonly FolderRule[],
): (FolderRule & { lease: SessionLease }) | undefined {
  return rules.find(
    (r): r is FolderRule & { lease: SessionLease } => isLeaseRule(r) && r.include[0] === accountId,
  );
}

/** A rule scope as a refusal names it: the quoted folder, or the alias in its folder. */
function describeScope(scope: RuleScopeRef): string {
  return scope.kind === 'folder'
    ? `"${scope.folder}"`
    : `session "${scope.alias}" in ${scope.folder}`;
}

/** The scope fields a new rule on `scopes` is created with: its folders, and its session aliases
 *  when it has any. */
function newRuleScopes(scopes: readonly RuleScopeRef[]): {
  folders: string[];
  aliases?: { folder: string; alias: string }[];
} {
  const folders = scopes.flatMap((s) => (s.kind === 'folder' ? [s.folder] : []));
  const aliases = scopes.flatMap((s) =>
    s.kind === 'alias' ? [{ folder: s.folder, alias: s.alias }] : [],
  );
  return aliases.length > 0 ? { folders, aliases } : { folders };
}

/** The scope fields a new rule on the one `scope` is created with. */
function newRuleScope(scope: RuleScopeRef): ReturnType<typeof newRuleScopes> {
  return newRuleScopes([scope]);
}

/** A rule scope as an import's refusal names it: `folder <path>` or `session "<alias>" in <path>`. */
function scopePhrase(scope: RuleScopeRef): string {
  return scope.kind === 'folder'
    ? `folder ${scope.folder}`
    : `session "${scope.alias}" in ${scope.folder}`;
}

/** Every account id a batch of import specs names, once. */
function memberIdsOf(specs: readonly ImportRuleSpec[]): string[] {
  return [...new Set(specs.flatMap((s) => [...s.include, ...s.exclude]))];
}

/** The rules that removing account `id` dissolves: the ones that name it and no other account. */
function rulesDissolvedBy(id: string, rules: readonly FolderRule[]): FolderRule[] {
  return rules.filter(
    (r) =>
      (r.include.includes(id) || r.exclude.includes(id)) &&
      r.include.every((x) => x === id) &&
      r.exclude.every((x) => x === id),
  );
}

/** What an import writes for one spec it applies: the spec's index, the rule it grows (absent for
 *  one it creates), the spec's scopes and the ones the grown rule gains, and the members it
 *  writes. */
interface ImportWrite {
  index: number;
  ruleId?: string;
  scopes: RuleScopeRef[];
  gains: RuleScopeRef[];
  include: string[];
  exclude: string[];
  label?: string;
  origin?: string;
}

/** What an import has got done so far (see SwitchEngine.importRules): the decision it carries out,
 *  once it starts writing, what each rule came to, whether every write landed, and the slots it
 *  moved. A run that stops part-way reports these. */
interface ImportProgress {
  plan?: ImportRulesPlan;
  outcomes: Array<ImportRuleOutcome | undefined>;
  allWritten: boolean;
  handedOff: SlotHandOff[];
  seated: SlotSeat[];
}

/** What the batch of an import (steps 1 to 3 of {@link SwitchEngine.importRules}) leaves its moves
 *  and its seat step, the state carried from one hold of the lock to the next: the decision, the
 *  rule each write landed in, the registry as it stood before the writes, the slots of the rules
 *  that did not land (`notLanded`), the moves still to be made, and the accounts no seat may take
 *  (`keepOut`, and `avoided`: found unable to go live, added to by a move that fails). */
interface ImportBatch {
  decision: ImportDecision;
  ruleIds: ReadonlyMap<ImportWrite, string>;
  before: RulesPicture;
  notLanded: () => Set<SlotId>;
  moves: readonly ImportMove[];
  keepOut: ReadonlySet<string>;
  avoided: Set<string>;
}

/** A slot an import's move switched: the account it held and the one it holds now (null: none). */
interface MadeMove {
  slot: SlotId;
  from: string | null;
  to: string | null;
}

/** The import decision ({@link SwitchEngine.importRules}): the plan as reported, the writes that
 *  carry it out, the moves it makes once they are written, the seats its seat step makes after
 *  them, and every account those put live somewhere. */
interface ImportDecision {
  plan: ImportRulesPlan;
  writes: ImportWrite[];
  /** Every slot holding a login that the import moves, in the order the moves are made. */
  moves: ImportMove[];
  /** The slots holding a login that the seat step after the moves puts elsewhere (see seatBatch). */
  seats: SlotSeat[];
  /** Every account the moves and the seat step put live: each has to be able to go live. */
  targets: string[];
}

/**
 * Carry out a batch of import writes through `writer` — the vault, or a draft of it that the
 * decision tries the batch against first — in the one order an import writes: the scopes each grown
 * rule gains, then every exclusion, then every inclusion (a created rule is made by the first of
 * these it has). A write the writer refuses is reported to `failed`, with the rule it had reached
 * when it may have written part of itself, and nothing more of it is written. Returns the rule each
 * write landed in.
 */
async function writeImportBatch(
  writer: RuleWriter,
  writes: readonly ImportWrite[],
  failed: (write: ImportWrite, err: SwitchEngineError, at: string | undefined) => unknown,
): Promise<Map<ImportWrite, string>> {
  const ruleIds = new Map<ImportWrite, string>();
  for (const write of writes) if (write.ruleId !== undefined) ruleIds.set(write, write.ruleId);
  const dead = new Set<ImportWrite>();
  const attempt = async (
    write: ImportWrite,
    step: () => Promise<unknown>,
    at: string | undefined,
  ): Promise<void> => {
    try {
      await step();
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      dead.add(write);
      await failed(write, err, at);
    }
  };
  for (const write of writes) {
    if (write.ruleId === undefined || write.gains.length === 0) continue;
    const ruleId = write.ruleId;
    await attempt(
      write,
      () => writer.addScopesToRule(ruleId, newRuleScopes(write.gains)),
      undefined,
    );
  }
  for (const verb of ['exclude', 'include'] as const) {
    for (const write of writes) {
      const ids = write[verb];
      if (dead.has(write) || ids.length === 0) continue;
      const ruleId = ruleIds.get(write);
      await attempt(
        write,
        async () => {
          if (ruleId !== undefined) {
            await (verb === 'exclude'
              ? writer.excludeAccounts(ruleId, ids)
              : writer.includeAccounts(ruleId, ids));
            return;
          }
          const rule = await writer.createRule({
            ...newRuleScopes(write.scopes),
            [verb]: ids,
            ...(write.label !== undefined ? { label: write.label } : {}),
            ...(write.origin !== undefined ? { origin: write.origin } : {}),
          });
          ruleIds.set(write, rule.id);
        },
        ruleId,
      );
    }
  }
  // The exclusions came first, so a rule with one was made before a rule with only inclusions;
  // the rules made are then listed in the order of the file.
  const created = writes.flatMap((w) => (w.ruleId === undefined ? (ruleIds.get(w) ?? []) : []));
  if (created.length > 1) await writer.orderRules(created);
  return ruleIds;
}

/** A hand-off plan ({@link SwitchEngine.planHandOffLocked}): the moves, or the slot left with no
 *  account to move to, the account it is stuck on, and the refusal. */
type HandOffPlan =
  | { ok: true; steps: Array<{ slotId: SlotId; from: StoredAccount; to: string }> }
  | { ok: false; slotId: SlotId; from: StoredAccount; error: RefreshError };

/** Who a slot an import moves holds: a stored account, or (id null) a login no account here is. */
type MoveFrom = Pick<StoredAccount, 'id' | 'label'> | { id: null; label: string };

/** A slot holding a login that an import moves onto another account, or clears (`to` null). A
 *  `handOff` frees an account the batch reserves, which the slot may not hold once the rules are
 *  written; a `seat` is a written rule's own slot put where seating it puts it (its occupant left
 *  the rule's pool, the batch newly includes an account there, the occupant's login is dead, or it
 *  is a login no account here is). A slot cleared is reported as a seat either way. */
interface ImportMove {
  slotId: SlotId;
  from: MoveFrom;
  to: string | null;
  kind: 'handOff' | 'seat';
}

/** An import's moves ({@link SwitchEngine.planImportMovesLocked}) in an order each can be made in,
 *  or the slot left with no account to move to, the account it is stuck on, and the refusal. */
type MovePlan =
  | { ok: true; moves: ImportMove[] }
  | {
      ok: false;
      slotId: SlotId;
      from: MoveFrom;
      kind: ImportMove['kind'];
      error: RefreshError;
    };

/** A slot an import's moves may change (see SwitchEngine.planImportMovesLocked): the account it
 *  holds, why it moves, the accounts its rule newly includes (which seating prefers), and what it
 *  does with nothing to move onto: keep its occupant, be cleared, or refuse the batch. */
interface ImportMover {
  slotId: SlotId;
  from: MoveFrom;
  kind: ImportMove['kind'];
  prefer?: ReadonlySet<string>;
  fallback: 'keep' | 'clear' | 'none';
}

/** The login no stored account is recognized as, as a moving slot holds it. */
const UNRECOGNIZED_LOGIN: MoveFrom = { id: null, label: 'the login of no account here' };

/** A moving slot's occupant as a refusal names it: the account quoted, or the unrecognized login. */
function moverName(from: MoveFrom): string {
  return from.id === null ? from.label : `"${from.label}"`;
}

/** What a mover with nothing to move onto falls back to, as one more candidate of its own for
 *  assignDistinct: its occupant (kept, which no other slot may then take), or a marker no account
 *  id can equal (cleared). Undefined when it has none. */
function moverFallback(m: ImportMover): string | undefined {
  if (m.fallback === 'keep') return m.from.id ?? undefined;
  return m.fallback === 'clear' ? `clear ${m.slotId}` : undefined;
}

/**
 * What an import's moves come to, one line per slot in the order the slots first moved: from the
 * account it held to the one it ends on. A slot moved off an account the rules now reserve, onto
 * another, is a hand-off ("now reserved"); every other slot, and one left with no account, is a
 * seat. A slot moved in two steps (cleared, then given its account) is one line.
 */
function netMoves(
  moves: ReadonlyArray<{
    slot: SlotId;
    from: string | null;
    to: string | null;
    kind: ImportMove['kind'];
  }>,
): { handOffs: SlotHandOff[]; seats: SlotSeat[] } {
  const bySlot = new Map<
    SlotId,
    { from: string | null; to: string | null; kind: ImportMove['kind'] }
  >();
  for (const m of moves) {
    const first = bySlot.get(m.slot);
    bySlot.set(m.slot, { from: first?.from ?? m.from, to: m.to, kind: m.kind });
  }
  const handOffs: SlotHandOff[] = [];
  const seats: SlotSeat[] = [];
  for (const [slot, { from, to, kind }] of bySlot) {
    if (kind === 'handOff' && from !== null && to !== null) handOffs.push({ slot, from, to });
    else seats.push({ slot, from, to });
  }
  return { handOffs, seats };
}

/** What the import tells the operator to do about sessions a rule's change would leave with no
 *  account: it has no override, so the sessions have to end first. */
const IMPORT_SESSIONS_REMEDY = 'exit them, then import again';

/** The refusal of a change (`what`) that leaves `rule`'s slot with no account while `sessions` run
 *  under it, with what to do about it (`remedy`, for the command making the change). */
function emptyingRefusal(
  rule: FolderRule,
  sessions: readonly RunningSession[],
  what: string,
  remedy: string,
): RefreshError {
  return new RefreshError(
    `${what} leaves ${describeRule(rule)} with no account to switch to, and ${sessions.length} ` +
      `running session(s) are using it${unidentifiedNote(sessions)}; ${remedy}`,
    'sessions_running',
  );
}

/** Who holds each slot as an import decides (see SwitchEngine.importStates): every account its live
 *  login may belong to, the one account it is recognized as (null when none, or no login), and the
 *  slots holding a login at all. */
interface SlotStates {
  owners: Map<SlotId, Set<string>>;
  active: Map<SlotId, string | null>;
  withLogin: Set<SlotId>;
}

/**
 * Hand-off moves in an order each can be made in: a slot that takes an account another slot of the
 * plan leaves moves after that slot, since no account is ever live in two slots. Undefined when the
 * moves wait on each other in a ring (two slots trading accounts), which no order can make.
 */
function orderedMoves<M extends { from: { id: string | null }; to: string | null }>(
  moves: readonly M[],
): M[] | undefined {
  const out: M[] = [];
  const done = new Set<number>();
  const visiting = new Set<number>();
  const visit = (i: number): boolean => {
    if (done.has(i)) return true;
    if (visiting.has(i)) return false;
    visiting.add(i);
    for (const [j, other] of moves.entries()) {
      const takes = moves[i]!.to;
      if (j !== i && takes !== null && other.from.id === takes && !visit(j)) return false;
    }
    visiting.delete(i);
    done.add(i);
    out.push(moves[i]!);
    return true;
  };
  for (let i = 0; i < moves.length; i += 1) if (!visit(i)) return undefined;
  return out;
}

/** The key {@link untradedMoves} bans a slot's move onto an account by. */
function bannedKey(slotId: SlotId, accountId: string): string {
  return `${slotId}\0${accountId}`;
}

/** The most assignments {@link untradedMoves} tries: a trade is a few slots, so a few bans each. */
const UNTRADE_ATTEMPTS = 32;

/**
 * Moves that some order can make, found from `moves` (an assignment holding slots that trade
 * accounts, which no order makes) by assigning the slots again (`reassign`) with one move of a
 * trade banned at a time, then one more, depth first, up to {@link UNTRADE_ATTEMPTS} assignments.
 * Undefined when none of them can be ordered.
 */
function untradedMoves(
  moves: readonly ImportMove[],
  reassign: (
    banned: ReadonlySet<string>,
  ) => { ok: true; moves: ImportMove[] } | { ok: false; unserved: unknown },
): ImportMove[] | undefined {
  const pending: Array<{ banned: Set<string>; moves: readonly ImportMove[] }> = [
    { banned: new Set(), moves },
  ];
  const seen = new Set<string>();
  for (let attempts = 0; pending.length > 0 && attempts < UNTRADE_ATTEMPTS;) {
    const { banned, moves: tried } = pending.pop()!;
    for (const move of tradeOf(tried)) {
      const next = new Set([...banned, bannedKey(move.slotId, move.to!)]);
      const key = [...next].sort().join('\n');
      if (seen.has(key)) continue;
      seen.add(key);
      attempts += 1;
      const again = reassign(next);
      if (!again.ok) continue;
      const ordered = orderedMoves(again.moves);
      if (ordered !== undefined) return ordered;
      pending.push({ banned: next, moves: again.moves });
    }
  }
  return undefined;
}

/** The moves of one trade among `moves`: slots each taking the account the next one leaves, round
 *  to the first. Empty when there is none. */
function tradeOf(moves: readonly ImportMove[]): ImportMove[] {
  const next = (m: ImportMove): ImportMove | undefined =>
    m.to === null ? undefined : moves.find((o) => o !== m && o.from.id === m.to);
  for (const start of moves) {
    const path: ImportMove[] = [];
    for (let m: ImportMove | undefined = start; m !== undefined; m = next(m)) {
      const at = path.indexOf(m);
      if (at >= 0) return path.slice(at);
      path.push(m);
    }
  }
  return [];
}

/** Import specs tried against a draft of the registry (see decideImportLocked): their writes, the
 *  ones the draft refused, the rule each write landed in, and the registry as they leave it. */
interface TriedBatch {
  writes: ImportWrite[];
  refused: Map<number, SwitchEngineError>;
  ruleIds: Map<ImportWrite, string>;
  after: RulesPicture;
}

/** `picture` with the rows of `ids` no longer quarantined: accounts an import gives new tokens
 *  before it writes its rules, usable by then. */
function withRevived<P extends RulesPicture>(picture: P, ids: ReadonlySet<string>): P {
  if (ids.size === 0) return picture;
  const lift = (rows: readonly StoredAccount[]): StoredAccount[] =>
    rows.map((a) => (ids.has(a.id) && a.quarantined ? { ...a, quarantined: false } : a));
  return { ...picture, shared: lift(picture.shared), reserved: lift(picture.reserved) };
}

/**
 * The rule cap and the reserved-account cap over the import specs of `indices`, counted in spec
 * order: each spec that would pass either, with its refusal. Counted afresh for every batch the
 * decision tries, so a spec refused for another reason never spends room a later one needs.
 */
function importCapRefusals(
  indices: readonly number[],
  targets: ReadonlyArray<FolderRule | undefined>,
  members: ReadonlyArray<{ include: readonly string[] }>,
  stored: RulesPicture,
  picture: RulesPicture,
): Map<number, SwitchEngineError> {
  const refused = new Map<number, SwitchEngineError>();
  let creates = 0;
  const reservedByBatch = new Set<string>();
  for (const i of indices) {
    const into = targets[i];
    if (into === undefined && stored.rules.length + creates >= MAX_RULES) {
      refused.set(i, new VaultError(`cannot create another folder rule (max ${MAX_RULES})`));
      continue;
    }
    const reserving = members[i]!.include.filter(
      (id) => picture.shared.some((a) => a.id === id) && !reservedByBatch.has(id),
    );
    if (stored.reserved.length + reservedByBatch.size + reserving.length > MAX_RESERVED_ACCOUNTS) {
      refused.set(i, new VaultError(`cannot reserve more than ${MAX_RESERVED_ACCOUNTS} accounts`));
      continue;
    }
    if (into === undefined) creates += 1;
    for (const id of reserving) reservedByBatch.add(id);
  }
  return refused;
}

/** Every scope of a rule, as the engine names scopes. */
function ruleScopeRefs(rule: FolderRule): RuleScopeRef[] {
  return [
    ...rule.folders.map((folder): RuleScopeRef => ({ kind: 'folder', folder })),
    ...(rule.aliases ?? []).map((a): RuleScopeRef => ({
      kind: 'alias',
      folder: a.folder,
      alias: a.alias,
    })),
  ];
}

/** A running Claude Code session as the scope matchers see it: the canonical cwd it runs in (what
 *  a FOLDER scope covers), and — for an ALIAS scope — its custom title and the canonical folder its
 *  conversation was recorded in (see `SwitchEngine.scanRunningSessions` for where each comes
 *  from). `title` null = unnamed; `titleKnown` false = the title could not be learned at all, so the
 *  session may carry any title. `recordedFolder` null = none an alias scope can name; `dirName` = the
 *  project directory its transcript lives in, when known. */
interface SessionRecordView {
  cwd: string;
  title: string | null;
  titleKnown: boolean;
  recordedFolder: string | null;
  dirName: string | undefined;
}

/** The clause a running-session refusal adds for sessions counted only because they MAY be the
 *  conversation (see {@link RunningSession.unidentified}), so the operator knows why. */
function unidentifiedNote(sessions: readonly RunningSession[]): string {
  const n = sessions.filter((s) => s.unidentified === true).length;
  if (n === 0) return '';
  return (
    ` (${n} of them could not be identified — a transcript that cannot be read, or a session ` +
    "that has not sent its first prompt yet, such as a fork — and run in the alias's folder, so " +
    'they may be its conversation)'
  );
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
 * Why credentials an import file brings may not replace the ones stored for `existing`, as a
 * clause, or undefined when they may. Stricter than a re-login's check
 * ({@link reloginIdentityRefusal}): there the provider has just answered for the tokens, so a
 * partial identity that contradicts nothing is believed; a file vouches only for itself, so the
 * tokens' own identity block has to PROVE they are this login. A row with a login (uuid) needs a
 * block naming that same login. A row without one needs a block that echoes every anchor the row
 * has, and a row with no anchor at all has nothing to check against, so it is refused too. The
 * import planner calls this as well, so its dry run skips exactly what this refuses.
 */
export function importIdentityRefusal(
  existing: Pick<StoredAccount, IdentityAnchor>,
  brought: OauthAccount | undefined,
): string | undefined {
  if (brought === undefined) return "the file's tokens do not say which login they belong to";
  const claimed = (key: IdentityAnchor): string | undefined => anchorValue(brought[key]);
  if (existing.accountUuid !== undefined) {
    const uuid = claimed('accountUuid');
    if (uuid === undefined) return "the file's tokens do not name the login they belong to";
    return uuid === existing.accountUuid
      ? undefined
      : `the file's tokens belong to another login (${uuid})`;
  }
  const anchors = IDENTITY_ANCHORS.filter((key) => existing[key] !== undefined);
  if (anchors.length === 0) {
    return "the account stored here records no login to check the file's tokens against";
  }
  const unmatched = anchors.filter((key) => claimed(key) !== existing[key]);
  if (unmatched.length === 0) return undefined;
  return `the file's tokens do not show the ${unmatched.join('/')} stored here`;
}

/**
 * The identity block an imported bundle is stored (and written live) with. The brought block is
 * laid over the stored one, so fields this machine never captured (a display name, a billing type)
 * arrive with the newer tokens. The anchors are different: what this machine knows of them is kept
 * whatever the file says. The file vouches only for itself, and the guard has checked the login
 * and nothing else, so a block naming the right login next to an email of `null`, a number, or
 * another address must not erase or rewrite the email and organization stored here — in the vault,
 * on the row, or in the live files. Each anchor is the first TEXT value among the row's, the stored
 * block's and the brought block's; an anchor none of them holds as text is left out rather than
 * carried as a non-string.
 */
function importedIdentity(
  row: Pick<StoredAccount, IdentityAnchor>,
  stored: OauthAccount | undefined,
  brought: OauthAccount | undefined,
): OauthAccount {
  const out: OauthAccount = { ...stored, ...brought };
  for (const key of IDENTITY_ANCHORS) {
    const value = row[key] ?? anchorValue(stored?.[key]) ?? anchorValue(brought?.[key]);
    if (value !== undefined) out[key] = value;
    else delete out[key];
  }
  return out;
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
  /** See {@link SwitchEngineOptions.sessionIdentity}. */
  private readonly sessionIdentity: SessionIdentityLookup | undefined;
  /** Resolves the enforcement mode at snapshot-write time. See {@link SwitchEngineOptions.bindEnforce}
   *  — a plain mode is wrapped in a constant function; a resolver is read on every write so a live
   *  settings change is honored by daemon-side writers too. */
  private readonly resolveBindEnforce: () => BindEnforceMode;
  /** See {@link SwitchEngineOptions.faultAt}. */
  private readonly faultAt: ((checkpoint: string) => void) | undefined;
  /** See {@link SwitchEngineOptions.leaseProcesses}. */
  private readonly leaseSeams: LeaseProcessSeams | undefined;
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
    this.sessionIdentity = options.sessionIdentity;
    this.resolveBindEnforce =
      typeof options.bindEnforce === 'function'
        ? options.bindEnforce
        : (
            (mode) => () =>
              mode
          )(options.bindEnforce ?? 'block');
    this.faultAt = options.faultAt;
    this.leaseSeams = options.leaseProcesses;
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

  /**
   * The rule a SESSION runs under, by the precedence rule (see `resolveSessionRule`): the alias rule
   * of the folder its conversation was recorded in (`recordedFolder`, default `folder`; null =
   * recorded in no folder an alias rule can name) and its custom title (`title`; null/blank =
   * unnamed), else the folder rule of `folder`, else `null` (the global slot). Canonicalizes leniently
   * like {@link resolveFolderRule}.
   */
  async resolveSessionRule(
    folder: string,
    title: string | null | undefined,
    recordedFolder?: string | null,
  ): Promise<{ ruleId: string; via: 'alias' | 'folder'; folder: string } | null> {
    const rules = await this.vault.listRules();
    if (rules.length === 0) return null;
    const match = resolveSessionRule(
      this.canonReserved(folder),
      title,
      rules,
      this.platform,
      recordedFolder === undefined || recordedFolder === null
        ? recordedFolder
        : this.canonReserved(recordedFolder),
    );
    return match === null ? null : { ruleId: match.rule.id, via: match.via, folder: match.folder };
  }

  /** Store a new shared account from a bundle. `opts` carries what an import knows beyond the
   *  bundle (see {@link Vault.addAccount}), written in the same registry write. */
  addAccount(
    label: string,
    bundle: CredentialBundle,
    opts: AddAccountOptions = {},
  ): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const account = await this.vault.addAccount(label, bundle, opts);
      await this.refreshSnapshotForAccountsLocked();
      return account;
    });
  }

  // ---- moving accounts between machines ----
  //
  // A vault is sealed to the machine that wrote it, so an account travels as its decrypted bundle,
  // re-sealed by the caller. Each of these takes and drops the credential lock on its own: a caller
  // moving many accounts makes one call per account, so a slow decrypt per account (a PowerShell
  // spawn on Windows) never stretches one lock hold toward the stale-lock reclaim.

  /**
   * The freshest credentials stored for an account, for carrying it to another machine. An account
   * live in a slot here may have rotated its token there since the vault last saw it, and a copy of
   * the older bundle would carry a refresh token that is already spent; so the live rotation is
   * adopted into the vault first, the same reconcile a switch does. Never refreshes over the
   * network: that would spend the token some session here may be holding.
   */
  async exportBundle(accountId: string): Promise<CredentialBundle> {
    // Fingerprint the stored bundles before the lock, as activate() does: adoption checks the live
    // token against every stored one under it.
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const untrusted = await this.settleForAccountsLocked([accountId]);
      if (!(await this.vault.getAccount(accountId))) throw new UnknownAccountError(accountId);
      await this.adoptLiveRotationOf(accountId, untrusted);
      return this.vault.readBundle(accountId);
    });
  }

  /**
   * Store an account that comes without credentials: a registry row carrying the identity it is
   * known by, quarantined until a re-login (`cctl accounts relogin`) writes its bundle. The re-login
   * is checked against that identity, so it has to be the same account. See
   * {@link Vault.addPendingAccount}.
   */
  addPendingAccount(
    label: string,
    identity: AccountIdentity,
    opts: AddPendingAccountOptions = {},
  ): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const account = await this.vault.addPendingAccount(
        label,
        identity,
        PENDING_LOGIN_REASON,
        opts,
      );
      await this.refreshSnapshotForAccountsLocked();
      return account;
    });
  }

  /**
   * Write credentials brought from another machine over an account already stored here, but only
   * when they are the better copy: the stored login is quarantined or has no stored bundle at all,
   * or the brought grant was minted later (its access token expires later — lifetimes are fixed per provider, so
   * expiry dates the mint, the same rule rotation adoption uses). A refresh token is single-use, so
   * of two copies of one login only the newer can still be alive.
   *
   * The comparison is against the freshest copy here: a live rotation is adopted first. The write
   * itself is a re-login's (see {@link applyReloginBundle}): the identity guard refuses a bundle
   * that names another account, the quarantine is lifted, and an account live in a slot here gets
   * the brought credentials written there too, and the guard snapshot is rewritten (the brought
   * identity can fill in fields the row lacked, such as its organization).
   *
   * A stored bundle that exists but cannot be read right now (a busy file, a failed decrypt) is
   * never taken as "unreadable, so anything is better": on Windows that is often a passing failure,
   * and writing an older copy over the newest grant would lose the only working token. The import is
   * refused instead, naming the cause.
   */
  async importBundle(accountId: string, bundle: CredentialBundle): Promise<ImportBundleResult> {
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const untrusted = await this.settleForAccountsLocked([accountId]);
      const existing = await this.vault.getAccount(accountId);
      if (!existing) throw new UnknownAccountError(accountId);
      const refusal = importIdentityRefusal(existing, bundle.oauthAccount);
      if (refusal !== undefined) {
        throw new RefreshError(
          `the tokens were not replaced: ${refusal}`,
          'relogin_identity_mismatch',
        );
      }
      // Read before anything is written, for the reason reloginFromConfigDirLocked gives. Found by
      // its token too, as an import's decision finds it: a slot that does not recognize the account
      // (a reserved account in the global slot, a slot with no identity block or another
      // account's) still runs its login, which then gets the new tokens rather than keep the old.
      const liveSlot = await this.possibleLiveSlotOf(accountId);
      await this.adoptLiveRotationOf(accountId, untrusted, liveSlot);
      let reason: ImportBundleResult['reason'];
      let stored: CredentialBundle | undefined;
      if (existing.quarantined) {
        reason = 'quarantined';
        // Read only for its identity block below: a dead login's copy that cannot be read costs
        // nothing, so it does not hold the import up.
        stored = await this.readStoredForImport(existing).catch(() => undefined);
      } else {
        stored = await this.readStoredForImport(existing);
        if (stored === undefined) reason = 'missing';
        else if (bundle.claudeAiOauth.expiresAt > stored.claudeAiOauth.expiresAt) reason = 'newer';
        else {
          // The copy here is kept. A row that records no login still learns the one the brought
          // identity names (the check above proved it is this account), as a replace would have
          // taught it: a slot running that login is then known to run this account. The stored
          // tokens are written back unchanged, with the fuller identity.
          if (existing.accountUuid === undefined) {
            const identity = importedIdentity(existing, stored.oauthAccount, bundle.oauthAccount);
            if (identity.accountUuid !== undefined) {
              await this.vault.writeBundle(existing.id, {
                claudeAiOauth: stored.claudeAiOauth,
                oauthAccount: identity,
              });
              await this.refreshSnapshotForAccountsLocked();
            }
          }
          return { replaced: false, reason: 'stored_newer', healedLiveLogin: false };
        }
      }
      const identity = importedIdentity(existing, stored?.oauthAccount, bundle.oauthAccount);
      // A slot running the account's token under another account's identity block keeps that block:
      // an import's plan, made before these tokens arrived, counted both accounts live there.
      const named = liveSlot === undefined ? null : await this.activeIdIn(liveSlot);
      const putBack =
        liveSlot !== undefined && named !== accountId
          ? await this.writeUnrecognizedLiveFirst(
              liveSlot,
              untrusted,
              existing,
              bundle.claudeAiOauth,
            )
          : undefined;
      let healedLiveLogin: boolean;
      let bundleStored = false;
      try {
        ({ healedLiveLogin } = await this.applyReloginBundle(
          existing,
          bundle.claudeAiOauth,
          identity,
          liveSlot,
          bundle.oauthAccount,
          named !== null && named !== accountId,
          () => {
            bundleStored = true;
          },
        ));
      } catch (err) {
        // Until the vault holds the new tokens, the slot written first goes back to its old copy.
        // Once it does, the slot keeps the new ones: they are what the account is now known by, so
        // the old copy put back would run there known as no account, and a later step of the
        // import could put the account live in a second slot. What is left undone is said.
        if (!bundleStored) await putBack?.();
        if (!bundleStored || this.isSimulatedDeath(err)) throw err;
        throw new SwitchEngineError(
          `the tokens were replaced, but the rest of this account's import failed ` +
            `(${errorReason(err)}); run the import again to finish it`,
          'import_unfinished',
          { cause: err },
        );
      }
      await this.refreshSnapshotForAccountsLocked();
      return { replaced: true, reason, healedLiveLogin: healedLiveLogin || putBack !== undefined };
    });
  }

  /**
   * For {@link importBundle}: write an account's new tokens into a slot that runs its login without
   * recognizing it as that account (found by its stored token or its identity block's login only),
   * before the stored tokens are replaced. Such a slot is known to run the account only through
   * what is stored now, so replacing that while the slot keeps the old copy would hide the login
   * from every later reader: an import's real run would then see the account live nowhere and
   * could put it live in a second slot, which its dry run, counting it live here, never planned. A
   * slot that cannot take the new tokens (a switch there is unsettled, the write fails) refuses
   * the replacement before anything is written. Returns how to put the slot's previous
   * credentials back, for a replacement that then fails.
   */
  private async writeUnrecognizedLiveFirst(
    slotId: SlotId,
    untrusted: ReadonlySet<SlotId>,
    account: StoredAccount,
    creds: ClaudeOauth,
  ): Promise<() => Promise<void>> {
    const where = slotPhrase(slotId, (await this.vault.readPicture()).rules);
    const notReplaced = `the tokens were not replaced: "${account.label}" runs in ${where}, which does not know it as that account, and`;
    if (untrusted.has(slotId)) {
      throw new UnsettledSwitchError(
        `${notReplaced} a switch there is still unsettled, so its new tokens could not be written there too; run the import again once it settles`,
      );
    }
    const credStore = this.slotRuntime(slotId).credStore;
    const prior = await credStore.readLiveCredentials().catch(() => undefined);
    try {
      await credStore.writeLiveCredentials(creds);
    } catch (err) {
      throw new SwitchEngineError(
        `${notReplaced} its new tokens could not be written there too (${errorReason(err)}); try again`,
        'switch_failed',
        { cause: err },
      );
    }
    return async () => {
      if (prior === undefined) return;
      await credStore.writeLiveCredentials(prior).catch((err: unknown) => {
        this.log.warn(
          { accountId: account.id, slot: slotId, reason: errorReason(err) },
          'an import could not put back the live login it wrote before its tokens were refused',
        );
      });
    };
  }

  /** The stored bundle {@link importBundle} compares against: undefined only when the account has
   *  no bundle on disk at all. Any other failure to read it refuses the import. Holds the lock. */
  private async readStoredForImport(
    existing: StoredAccount,
  ): Promise<CredentialBundle | undefined> {
    try {
      return await this.vault.readBundle(existing.id);
    } catch (err) {
      if (!(await this.vault.hasBundle(existing.id))) return undefined;
      throw new VaultError(
        `could not read the tokens stored for "${existing.label}" (${errorReason(err)}), so they ` +
          "were not compared with the file's; nothing was replaced - try again, or log it in again " +
          `with cctl accounts relogin ${shellQuoteArg(existing.label, this.platform)}`,
        { cause: err },
      );
    }
  }

  /** Adopt into the vault whatever rotation the slot an account is live in holds (`slot`, when the
   *  caller found it), unless that slot is one a switch left unsettled (its live login cannot be
   *  trusted). Holds the lock. */
  private async adoptLiveRotationOf(
    accountId: string,
    untrusted: Set<SlotId>,
    slot?: SlotId,
  ): Promise<void> {
    const liveSlot = slot ?? (await this.liveSlotOf(accountId));
    if (liveSlot === undefined || untrusted.has(liveSlot)) return;
    const credStore = this.slotRuntime(liveSlot).credStore;
    const liveNow = await credStore.readLiveCredentials().catch(() => undefined);
    const liveOauth = await credStore.readOauthAccount().catch(() => undefined);
    await this.adoptRotationIfNeeded(accountId, liveNow, liveOauth);
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
   *
   * `opts` is for a removal that follows handing the account to another machine (`cctl export
   * --move`), checked under the same lock as the removal so nothing can change between check and
   * act: `refuseIfGloballyLive` refuses while the account is the global slot's (whose live files a
   * removal leaves in place, so the login would stay live here); `refuseIfRunning` refuses while it
   * is live in a folder slot sessions run in (the removal would sign them out, and they would go on
   * spending the handed-over token); `expectRefreshToken` refuses unless
   * the vault, after adopting every rotation a rule slot holds, still has the refresh token that was
   * handed over — a refresh since then (the daemon's poller refreshes idle accounts) spent that
   * token, and the copy here is now the only working one.
   *
   * `opts.expectedLabel` is the label a person typed to confirm the removal. It is compared here,
   * under the lock, against the registry the lock protects: compared before the lock is taken, a
   * rename another process commits while this removal waits for the lock would go unseen, and the
   * account would be removed under a name nobody confirmed. A mismatch (or an account already gone)
   * throws {@link AccountLabelChangedError} before anything is touched.
   */
  removeAccount(id: string, opts: RemoveAccountOptions = {}): Promise<void> {
    return this.withCredentialLock(async () => {
      if (opts.expectedLabel !== undefined) {
        const current = (await this.vault.listAllAccounts()).find((a) => a.id === id);
        if (current?.label !== opts.expectedLabel) {
          throw new AccountLabelChangedError(id, opts.expectedLabel, current?.label ?? null);
        }
      }
      // An account a parallel session holds runs in a terminal right now; removing it would pull the
      // login out from under that session. (The CLI checks those processes first, so what is left
      // here is a session that still runs, or one nothing can tell is gone.)
      const lease = leaseRuleOf(id, await this.vault.listRules());
      if (lease !== undefined) {
        const label = (await this.vault.getAccount(id))?.label ?? id;
        const by = leaseInUseBy(label, lease.lease);
        throw new SlotError(`${by.text}; exit ${by.several ? 'them' : 'it'} first`, 'leased');
      }
      // A pending switch to or from this account needs its bundle to be settled correctly; one that
      // cannot be settled yet refuses the removal.
      const untrusted = await this.settleForAccountsLocked([id]);
      const picture = await this.vault.readPicture();
      await this.checkHandedOverLocked(id, picture, untrusted, opts);
      const reserved = picture.reserved.some((a) => a.id === id);
      const dissolving = rulesDissolvedBy(id, picture.rules);
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
  /** The `opts` checks of {@link removeAccount}, run under its lock before anything moves. */
  private async checkHandedOverLocked(
    id: string,
    picture: RulesPicture,
    untrusted: Set<SlotId>,
    opts: RemoveAccountOptions,
  ): Promise<void> {
    const label = (await this.vault.getAccount(id))?.label ?? id;
    if (opts.refuseIfGloballyLive === true) {
      const owners = await this.possibleLiveOwners('global');
      if (owners.has(id) || (await this.getActiveId('global')) === id) {
        throw new RefreshError(
          "it is the live account of this machine's main login, and removing it would leave that " +
            'login live here; switch to another account (cctl switch <account>), then remove it ' +
            'with cctl accounts remove',
          'account_live',
        );
      }
    }
    const stored = await this.vault.readStoredTokens();
    if (opts.refuseIfRunning === true) {
      // Every slot the removal clears: the ones the account is live in, and the slot of every rule
      // it dissolves, whoever that slot runs.
      const dissolving = rulesDissolvedBy(id, picture.rules);
      for (const rule of picture.rules) {
        const slotId = ruleSlotId(rule.id);
        const live = (await this.possibleLiveOwners(slotId, stored)).has(id);
        if (!live) {
          if (!dissolving.includes(rule)) continue;
          // An empty slot loses nothing by being cleared.
          const login = await this.slotRuntime(slotId)
            .credStore.readLiveCredentials()
            .catch(() => undefined);
          if (login === undefined) continue;
        }
        const sessions = await this.runningSessionsInRule(rule);
        if (sessions.length === 0) continue;
        const using = `${sessions.length} running session(s) are using it${unidentifiedNote(sessions)}`;
        throw new RefreshError(
          !live
            ? `removing it dissolves the rule on ${describeRule(rule)}, which signs its folder ` +
                `slot out, and ${using}; exit them, then remove it with cctl accounts remove`
            : `it is live in the folder slot of ${describeRule(rule)}, and ${using}, which would ` +
                'go on using a login the other machine now holds; exit them, then remove it with ' +
                'cctl accounts remove',
          'sessions_running',
        );
      }
    }
    if (opts.expectRefreshToken === undefined) return;
    for (const rule of picture.rules) {
      const slotId = ruleSlotId(rule.id);
      if (untrusted.has(slotId)) continue;
      if ((await this.possibleLiveOwners(slotId, stored)).has(id)) {
        await this.adoptSlotRotation(this.slotRuntime(slotId));
      }
    }
    const now = await this.vault.readBundle(id).catch(() => undefined);
    if (now?.claudeAiOauth.refreshToken !== opts.expectRefreshToken) {
      throw new RefreshError(
        'its tokens changed after they were exported (a refresh here spent the copy in the ' +
          `file), so "${label}" is kept here, where its login still works; export it again`,
        'tokens_changed',
      );
    }
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
    // Every row, reserved ones included: `accounts list` renders PLAN/BILLING for both tables, and
    // a reserved account is never in the shared list this would otherwise read.
    const stale = (await this.vault.listAllAccounts()).filter((a) => needsMetadataBackfill(a, now));
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
    registry?: RegistryPicture,
  ): Promise<{ registryId: string | null; candidates: StoredAccount[] }> {
    const picture = registry ?? (await this.vault.readPicture());
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
   * The slot a re-login of an account rewrites: the one it is live in, or else its parallel
   * session's slot while that holds a login ending the session cannot keep (a /login inside it as
   * an account cctl does not store, an identity that names nobody). Such a login keeps the session
   * from ending for good, and the slot is pinned to this account, so the re-login the release and
   * doctor advise replaces it. Another stored account's login there is left alone: ending the
   * session saves that one with its account.
   */
  private async reloginSlotOf(accountId: string): Promise<SlotId | undefined> {
    const live = await this.liveSlotOf(accountId);
    if (live !== undefined) return live;
    const lease = leaseRuleOf(accountId, await this.vault.listRules());
    if (lease === undefined) return undefined;
    const rt = this.slotRuntime(ruleSlotId(lease.id));
    return (await this.slotHoldsUnstoredLogin(rt)) ? rt.id : undefined;
  }

  /** The slot an account's login runs in as {@link possibleLiveOwners} finds it: by the identity
   *  block, or by the stored token where the slot does not recognize the account. */
  private async possibleLiveSlotOf(accountId: string): Promise<SlotId | undefined> {
    const stored = await this.vault.readStoredTokens();
    for (const slotId of await this.allSlotIds()) {
      if ((await this.possibleLiveOwners(slotId, stored)).has(accountId)) return slotId;
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
   * A login the slot recognizes no account as can still be a stored account the slot does not count
   * among its own (a reserved account in the global slot, which only knows the shared ones): its
   * identity block naming that account's login is evidence enough that it is live there, whatever
   * its stored tokens are now (an import may just have replaced them).
   *
   * `stored` and `registry` let a caller walking every slot read the stored tokens and the
   * registry once.
   */
  private async possibleLiveOwners(
    slotId: SlotId,
    stored?: StoredTokens,
    registry?: RegistryPicture,
  ): Promise<Set<string>> {
    const owners = new Set<string>();
    const credStore = this.slotRuntime(slotId).credStore;
    const live = await credStore.readLiveCredentials().catch(() => undefined);
    if (live === undefined) return owners;
    const picture = registry ?? (await this.vault.readPicture());
    const byIdentity = await this.activeIdIn(slotId, picture);
    if (byIdentity !== null) owners.add(byIdentity);
    else {
      const uuid = anchorValue(
        (await credStore.readOauthAccount().catch(() => undefined))?.accountUuid,
      );
      const named = [...picture.shared, ...picture.reserved].find(
        (a) => uuid !== undefined && a.accountUuid === uuid,
      );
      if (named !== undefined) owners.add(named.id);
    }
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
    const registry = await this.vault.readPicture();
    const occupancy = new Map<SlotId, Set<string>>();
    for (const slotId of allSlots(picture.rules)) {
      occupancy.set(slotId, await this.possibleLiveOwners(slotId, stored, registry));
    }
    return occupancy;
  }

  /** The slot whose live credentials hold exactly this refresh token, whoever its identity block
   *  names, or undefined. A plain read of each slot's credentials file — no decrypt. */
  private async slotHoldingRefreshToken(refreshToken: string): Promise<SlotId | undefined> {
    return (await this.liveRefreshTokens()).get(refreshToken);
  }

  /** The slot each live refresh token runs in, from one walk of every slot (the first slot, in
   *  slot order, for a token two hold), for a caller asking about many tokens at once. */
  private async liveRefreshTokens(): Promise<Map<string, SlotId>> {
    const holders = new Map<string, SlotId>();
    for (const slotId of await this.allSlotIds()) {
      const live = await this.slotRuntime(slotId)
        .credStore.readLiveCredentials()
        .catch(() => undefined);
      if (live !== undefined && !holders.has(live.refreshToken)) {
        holders.set(live.refreshToken, slotId);
      }
    }
    return holders;
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
    try {
      await rt.credStore.clearOauthAccount();
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
      // A `.claude.json` nothing can parse (a writer killed mid-write) names nobody, so there is no
      // block to drop, but left in place it would fail every later seat of this slot, which must
      // write one. Set aside, it is kept for inspection and the next seat starts a clean file.
      const path = join(rt.profileDir, '.claude.json');
      await rename(path, `${path}.corrupt`);
    }
  }

  /**
   * Before a re-login rewrites a slot's live login: a `.credentials.json` nothing can parse (a writer
   * killed mid-write) would fail that write, which keeps the file's other keys, and so leave the
   * slot torn for good (a parallel session on it can then never be ended, since ending it must not
   * delete a login it cannot read). Set aside as `.credentials.json.corrupt`, its bytes are kept for
   * inspection and the fresh grant is written to a clean file. Only the file channel tears; the
   * macOS Keychain of the global slot is left alone.
   */
  private async setAsideTornCredentials(rt: SlotRuntime): Promise<void> {
    if (rt.profileDir === undefined && this.platform === 'darwin') return;
    const torn = await rt.credStore.readLiveCredentials().then(
      () => false,
      (err: unknown) => err instanceof SyntaxError,
    );
    if (!torn) return;
    const path =
      rt.profileDir !== undefined
        ? join(rt.profileDir, '.credentials.json')
        : this.paths.credentialsPath;
    await rename(path, `${path}.corrupt`);
    this.log.warn(
      { path },
      'set aside a credentials file that could not be parsed before re-login',
    );
  }

  /** The accounts whose parallel sessions hold this one: its own session, and every session whose
   *  slot its login may be live in (a /login inside it). Removing it would pull that login out from
   *  under the session, so a command that would remove it refuses while any is listed. Read-only. */
  async parallelSessionsHolding(accountId: string): Promise<string[]> {
    const stored = await this.vault.readStoredTokens();
    const out: string[] = [];
    for (const rule of (await this.vault.listRules()).filter(isLeaseRule)) {
      const own = rule.include[0]!;
      const slot = ruleSlotId(rule.id);
      if (own === accountId || (await this.possibleLiveOwners(slot, stored)).has(accountId)) {
        out.push(own);
      }
    }
    return out;
  }

  /** Whether a parallel session's slot holds a login that ending it could not keep (see
   *  {@link slotHoldsUnstoredLogin}): what doctor names when such a session is not ended. Read-only. */
  async leaseHoldsUnstoredLogin(ruleId: string): Promise<boolean> {
    return this.slotHoldsUnstoredLogin(this.slotRuntime(ruleSlotId(ruleId)));
  }

  /**
   * Whether clearing a slot would lose a login: credentials that cannot be read at all (a torn file,
   * which may hold the only copy of a rotated token), or a token no stored account's bundle holds
   * that adoption refuses to store (see {@link adoptionPlan}). A token adoption would store is not
   * lost (ending the session adopts it first), and neither is one older than the stored login of the
   * account live there (the vault already holds a newer one). Nothing there loses nothing. Read-only:
   * doctor asks it of a session not ended yet, the teardown after its adoption.
   */
  private async slotHoldsUnstoredLogin(rt: SlotRuntime): Promise<boolean> {
    let live: ClaudeOauth | undefined;
    try {
      live = await rt.credStore.readLiveCredentials();
    } catch {
      return true;
    }
    if (live === undefined) return false;
    if ((await this.vault.readStoredTokens()).holdersOf(live).length > 0) return false;
    const owner = await this.getActiveId(rt.id);
    const oauth = await rt.credStore.readOauthAccount().catch(() => undefined);
    return (await this.adoptionPlan(owner, live, oauth)).kind === 'refused';
  }

  /** Adopt into the vault whatever rotation the account live in `rt` holds — the reconcile-by-reading
   *  a switch does — ahead of clearing that seat, so clearing never costs an account its latest token.
   *  `outgoing` names the account the caller knows is live there, for a slot that no longer
   *  recognizes it. Returns whether it adopted. The caller has settled the slot (an untrusted one is
   *  never read). */
  private async adoptSlotRotation(rt: SlotRuntime, outgoing?: string): Promise<boolean> {
    const liveAccount = (await this.getActiveId(rt.id)) ?? outgoing ?? null;
    const liveNow = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const liveOauth = await rt.credStore.readOauthAccount().catch(() => undefined);
    return this.adoptRotationIfNeeded(liveAccount, liveNow, liveOauth);
  }

  /** Clear a rule slot's login after adopting its rotation (see {@link adoptSlotRotation}), so
   *  clearing costs the account nothing: the slot then fails closed. */
  private async clearSlotLoginLocked(rt: SlotRuntime, outgoing?: string): Promise<void> {
    await this.adoptSlotRotation(rt, outgoing);
    await this.clearSlotLive(rt);
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
    // A parallel session's profile belongs to the terminal that started it: no managed session is
    // ever placed there, and the account is not to be used anywhere else meanwhile.
    const rules = await this.vault.listRules();
    const lease = leaseRuleOf(accountId, rules);
    if (lease !== undefined) {
      const label = (await this.vault.getAccount(accountId))?.label ?? accountId;
      throw new SlotError(leasedRefusal(label, lease.lease), 'leased');
    }
    const live = await this.liveSlotOf(accountId);
    if (live !== undefined) return this.configDirForSlot(live);
    const including = rulesIncluding(accountId, rules).filter((r) => !isLeaseRule(r));
    return including.length === 1 ? this.configDirForSlot(ruleSlotId(including[0]!.id)) : undefined;
  }

  /**
   * The slot a session's launch-time `CLAUDE_CONFIG_DIR` names: the rule whose profile dir the config
   * dir canonically equals, else the global slot. An absent, main, or unrecognized dir maps to
   * global. Canonicalized so a case difference or trailing separator still matches on Windows.
   */
  async slotForConfigDir(configDir: string | null | undefined): Promise<SlotId> {
    return (await this.recognizedSlotForConfigDir(configDir)) ?? 'global';
  }

  /**
   * {@link slotForConfigDir} without the guess: the global slot for an absent config dir or the main
   * one, a rule's slot for its profile, and `null` for anything else — a config dir cctl does not
   * manage (a removed rule's profile, a hand-made store), whose account is unknown. What a caller must
   * use before acting on "the account this session runs on".
   */
  async recognizedSlotForConfigDir(configDir: string | null | undefined): Promise<SlotId | null> {
    if (configDir === undefined || configDir === null || configDir === '') return 'global';
    const key = folderKey(this.canonReserved(configDir), this.platform);
    if (key === folderKey(this.canonReserved(this.paths.claudeDir), this.platform)) return 'global';
    for (const rule of await this.vault.listRules()) {
      const profileKey = folderKey(
        this.canonReserved(groupProfileDir(this.paths.vaultDir, rule.id)),
        this.platform,
      );
      if (key === profileKey) return ruleSlotId(rule.id);
    }
    return null;
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
   * Whether `scope` may hold a rule here, as a creating verb would canonicalize and check it (a
   * folder that exists, is no filesystem root or home directory, and does not overlap cctl's own
   * directories; an alias that a session title could carry). Writes nothing and takes no lock, so a
   * plan can show the refusal a real run would meet.
   */
  checkRuleScope(
    scope: RuleScopeRef,
  ): { ok: true; scope: RuleScopeRef } | { ok: false; reason: string } {
    try {
      return { ok: true, scope: this.canonicalizeEditScope(scope) };
    } catch (err) {
      if (err instanceof SwitchEngineError) return { ok: false, reason: err.message };
      throw err;
    }
  }

  /**
   * What importing these rules would do (`cctl import --dry-run`), writing nothing: the decision
   * {@link importRules} makes and then carries out, made by the same code under the same lock from
   * the same reads, so a dry run reports what the real run will do. `pending` are the accounts the
   * import stores before its rules (counted as stored, under the ids the specs name them by),
   * `logins` the logins it gives accounts stored here that record none yet, and `revived` the
   * quarantined accounts it gives new tokens (usable by the time it writes the rules).
   *
   * What it cannot foresee is what changes between it and the real run, and the run-time state the
   * real run settles first: a session that starts or stops in a slot a rule would empty, a switch
   * left unfinished in a slot (settled, or refused, only by the real run), an account a slot is
   * moved onto that cannot be switched to then (its token will not refresh), and any change to the
   * accounts, rules or live logins made in between.
   */
  async planImportRules(
    specs: readonly ImportRuleSpec[],
    opts: PlanImportRulesOptions = {},
  ): Promise<ImportRulesPlan> {
    this.refuseRuleSlotsOnDarwin();
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const pending = opts.pending ?? [];
      const pendingIds = new Set(pending.map((p) => p.id));
      await this.resolveRequested(memberIdsOf(specs).filter((id) => !pendingIds.has(id)));
      const decision = await this.decideImportLocked(specs, {
        keepOut: new Set(opts.keepOut ?? []),
        pending,
        logins: opts.logins ?? [],
        settle: false,
        revived: opts.revived ?? [],
      });
      return decision.plan;
    });
  }

  /**
   * Rebuild rules brought from another machine (`cctl import`). Each spec is one rule of the file,
   * applied WHOLE or not at all: it grows the one rule here that carries its identity (an earlier
   * import of it: the scopes and members it lacks are added), or it is created on every one of its
   * scopes when no rule here holds any of them; otherwise it is refused, naming the scope a rule of
   * this machine holds. A rule here with another identity, or none, is never grown by an import,
   * even on exactly the same scopes: it is this machine's own. No rule is ever made on part of a
   * spec's scopes, since a rule is one slot and a split would change which account its folders run
   * on.
   *
   * Done as one batch under one lock, because the per-scope verbs, run rule after rule, cannot
   * rebuild what the source had: each seats its slot at once, so an earlier rule's slot can take an
   * account a later rule includes (which that include then refuses), and an exclusion the source
   * keeps on record for an account another rule reserves can no longer be made once that
   * reservation exists. In order:
   *   1. decide ({@link decideImportLocked}, the decision {@link planImportRules} reports): every
   *      refusal, the batch tried against a draft of the registry, every slot it moves, chosen for
   *      all the slots together, and the seat step played out on the draft.
   *   2. make sure every account the decision puts live can go live ({@link readyImportTargets}):
   *      its stored tokens read, and refreshed now when near their end, each such refresh under a
   *      hold of the lock of its own, after which the batch is decided again. One that cannot is
   *      left out and the decision made again without it. Nothing is written or moved until every
   *      account of the decision is ready, so an account that fails never leaves a slot moved for a
   *      rule that then does not land.
   *   3. add the scopes a grown rule lacks, then write every exclusion, then every inclusion: an
   *      account a later rule reserves is still shared while the exclusions are written, as it was
   *      on the source when they were made.
   *   4. make the moves, now that every rule they are for is written (so a slot may take an account
   *      the batch newly includes in its rule): each slot holding an account a rule now reserves,
   *      and each written rule's slot the decision puts elsewhere, in an order that frees each
   *      account before the slot taking it. Each move is made under a hold of the lock of its own,
   *      as each seat is below (see makeImportMoves).
   *   5. seat each written rule's slot that is still to be seated (an empty slot), each under a
   *      hold of the lock of its own: once the rules are written and the moves made, each seat is
   *      independent of the others, so a switch or a daemon waiting on the lock is handed it
   *      between two seats (see yieldLock) rather than after the last. A slot sessions run under
   *      is moved only as the decision said, and never cleared (see ensureRuleLiveLocked's
   *      `guard`).
   *   6. write the guard snapshot LAST.
   * Each write is one of the vault's own crash-safe writes, and the batch was tried whole before
   * any of them, so a write fails part-way only when something changed under the lock's holder
   * (another process writing the files by hand) or the process dies; a run that dies part-way
   * leaves rules the next import grows to completion by their identity, and slots the daemon's
   * repair settles. Past the batch's local reads and writes, a hold makes one network refresh or
   * one switch (the batch refreshes only a token that ran short again since its own hold), so a
   * command or the daemon waiting for the lock gets it within what it waits, however large the
   * import; within each hold the lock is renewed, so no other process
   * takes it over mid-hold. A run stopped part-way once it has started writing (the lock taken over
   * all the same, a file that cannot be read) throws {@link ImportInterruptedError} carrying what
   * it got done, so it is still reported.
   *
   * `keepOut` names accounts no slot may be moved to or seated with unless its own rule includes
   * them (see withoutKeptOut): accounts the import brought for a rule of the machine they came
   * from. A slot that has no other account to move to refuses the specs that reserve its occupant,
   * as it would with no such account here at all.
   */
  async importRules(
    specs: readonly ImportRuleSpec[],
    opts: ImportRulesOptions = {},
  ): Promise<ImportRulesResult> {
    this.refuseRuleSlotsOnDarwin();
    await this.vault.readStoredTokens().catch(() => undefined);
    const done: ImportProgress = {
      outcomes: specs.map(() => undefined),
      allWritten: false,
      handedOff: [],
      seated: [],
    };
    try {
      // 1-3. The batch, under one hold. An account it would put live whose token must first be
      // refreshed over the network sends it back: each such account is refreshed under a hold of
      // its own, the lock handed first to whoever waits for it, and the batch decided again (see
      // importBatchLocked). Accounts that cannot go live (`avoid`) and the ones refreshed so
      // (`readied`) carry from one try of the batch to the next.
      const avoid = new Map<string, string>();
      const readied = new Set<string>();
      let batch: ImportBatch;
      for (;;) {
        const step = await this.withCredentialLock((renew) =>
          this.importBatchLocked(specs, opts, renew, done, { avoid, readied }),
        );
        if (!('stale' in step)) {
          batch = step;
          break;
        }
        for (const id of step.stale) {
          await yieldLock(this.lockDir());
          const failed = await this.withCredentialLock(async (renew) => {
            await this.settleForAccountsLocked([id]);
            const ready = await this.readyImportTargets([id], step.moves, renew);
            // A refresh that outlasted the lock's claim, another process taking it over meanwhile,
            // stops the import here, before anything is written, as it would in the batch.
            renew();
            return ready.failed;
          });
          readied.add(id);
          // The decision made without it may need none of the other refreshes.
          if (failed !== undefined) {
            this.noteUnready(avoid, failed);
            break;
          }
        }
      }
      // 4. Each move under its own hold, the lock handed first to whoever waits for it.
      const moved = await this.makeImportMoves(batch, done);
      // 5. Each seat the same way.
      for (const write of batch.decision.writes) {
        await yieldLock(this.lockDir());
        await this.withCredentialLock((renew) =>
          this.seatImportedLocked(write, batch, renew, done),
        );
      }
      // 6. The guard snapshot, last.
      if (batch.ruleIds.size > 0 || moved > 0) {
        await yieldLock(this.lockDir());
        await this.withCredentialLock(() => this.writeSnapshotLocked());
      }
      return {
        plan: batch.decision.plan,
        outcomes: done.outcomes,
        handedOff: done.handedOff,
        seated: done.seated,
      };
    } catch (err) {
      if (done.plan === undefined || this.isSimulatedDeath(err)) throw err;
      throw new ImportInterruptedError({ ...done, plan: done.plan }, err);
    }
  }

  /**
   * Steps 1 to 3 of {@link importRules}, under one hold of its lock: the decision and the writes.
   * What it gets done goes into `done` as it goes (`plan` once it starts writing), so a run that
   * stops part-way still reports it.
   *
   * A refresh over the network takes as long as the token endpoint does, and an export imported
   * after its tokens lapsed needs one for every account it puts live: done here, one after another,
   * they would keep the lock past what `cctl switch` and the daemon wait for it. So an account
   * whose token needs one sends the batch back before anything is written (`stale`, with the moves
   * that readying goes by), unless it was already refreshed under a hold of its own (`readied`),
   * which is then done here (a token that ran short again in between).
   */
  private async importBatchLocked(
    specs: readonly ImportRuleSpec[],
    opts: ImportRulesOptions,
    renew: () => void,
    done: ImportProgress,
    tried: { avoid: Map<string, string>; readied: ReadonlySet<string> },
  ): Promise<ImportBatch | { stale: string[]; moves: readonly ImportMove[] }> {
    const allIds = memberIdsOf(specs);
    await this.resolveRequested(allIds);
    await this.settleForAccountsLocked(allIds);

    // 1-2. Decide, and make sure every account the decision puts live can go live. One that cannot
    // (its token will not refresh, its stored tokens cannot be read) is left out, and the decision
    // made again without it: nothing has been written or moved yet.
    const keepOut = new Set(opts.keepOut ?? []);
    const { avoid, readied } = tried;
    let decision: ImportDecision;
    for (;;) {
      renew();
      decision = await this.decideImportLocked(specs, {
        keepOut,
        pending: [],
        logins: [],
        settle: true,
        avoid,
      });
      const ready = await this.readyImportTargets(decision.targets, decision.moves, renew, readied);
      if (ready.failed !== undefined) {
        this.noteUnready(avoid, ready.failed);
        continue;
      }
      if (ready.stale.length > 0) return { stale: ready.stale, moves: decision.moves };
      break;
    }

    // A slot whose switch is stuck would refuse its move only once the rules are written and the
    // moves before it made, so it refuses the import now, before anything is written.
    for (const move of decision.moves) {
      await this.requireSettledLocked(this.slotRuntime(move.slotId));
    }

    // 3. Scopes, then exclusions, then inclusions. The rules as they stand before, for whose
    // sessions run on each grown rule's slot now (a scope it gains ran on another slot).
    renew();
    const before = await this.vault.readPicture();
    done.plan = decision.plan;
    const outcomes = done.outcomes;
    const ruleIds = await writeImportBatch(this.vault, decision.writes, async (write, err, at) => {
      const partial = at !== undefined ? await this.vault.getRule(at) : undefined;
      outcomes[write.index] = {
        ok: false,
        message: err.message,
        ...(partial ? { partial } : {}),
      };
    });
    done.allWritten = true;

    // A write that failed leaves a move made for it pointless, so such moves are not made (see
    // movesStillNeeded).
    const notLanded = (): Set<SlotId> =>
      new Set(
        decision.writes.flatMap((w) => {
          const id = ruleIds.get(w);
          return id !== undefined && outcomes[w.index] !== undefined ? [ruleSlotId(id)] : [];
        }),
      );
    const moves = decision.writes.some((w) => outcomes[w.index] !== undefined)
      ? await this.movesStillNeeded(decision.moves, notLanded())
      : decision.moves;
    return {
      decision,
      ruleIds,
      before,
      notLanded,
      moves,
      keepOut,
      avoided: new Set(avoid.keys()),
    };
  }

  /** Leave an account the import found unable to go live out of its decision from now on. */
  private noteUnready(
    avoid: Map<string, string>,
    failed: { id: string; error: SwitchEngineError },
  ): void {
    avoid.set(failed.id, failed.error.message);
    this.log.warn(
      { accountId: failed.id, reason: errorReason(failed.error) },
      'an import cannot make an account live; deciding again without it',
    );
  }

  /**
   * Step 4 of {@link importRules}: the moves, each under a hold of the lock of its own, the lock
   * handed first to whoever waits for it (see yieldLock). One hold across every move would keep
   * `cctl switch` and the daemon waiting for as long as all the switches take, past what they wait.
   * The written rules and the moves still to be made are all that passes from one hold to the next;
   * each hold reads the slots again (see importMoveLocked). A move that fails puts back every rule
   * the slots, as they then stand, would run against (see putBackViolatedWrites), and the moves
   * still needed for the rules that stay are made; a move that stops the run puts back the same
   * way, and no move is made after it. Every slot moved is reported, as the net move it was, even
   * when the run then stops. Returns how many moves were made.
   */
  private async makeImportMoves(batch: ImportBatch, done: ImportProgress): Promise<number> {
    const made: MadeMove[] = [];
    let stopped: Error | undefined;
    try {
      let pending = batch.moves;
      while (pending.length > 0) {
        const left = pending;
        await yieldLock(this.lockDir());
        pending = await this.withCredentialLock((renew) =>
          this.importMoveLocked(left, batch, done, renew, made),
        );
      }
    } catch (err) {
      if (this.isSimulatedDeath(err)) throw err;
      stopped = err instanceof Error ? err : new Error(String(err));
    }
    // A slot moved off an account that a rule put back no longer reserves is reported as the seat it
    // is, never as "now reserved".
    const kindOf = (slotId: SlotId): ImportMove['kind'] =>
      batch.decision.moves.find((move) => move.slotId === slotId)?.kind ?? 'seat';
    const net = netMoves(made.map((m) => ({ ...m, kind: kindOf(m.slot) })));
    const now = await this.vault.readPicture();
    for (const hand of net.handOffs) {
      if (slotMayHold(hand.slot, hand.from, now)) done.seated.push(hand);
      else done.handedOff.push(hand);
    }
    done.seated.push(...net.seats);
    if (stopped !== undefined) throw stopped;
    return made.length;
  }

  /**
   * One move of {@link makeImportMoves} (the first of `pending`), under its own hold of the lock;
   * returns the moves still to be made after it, and adds the slot it moves to `made`. Another
   * process may have had the lock since the plan was made, so the move goes by the slots as this
   * hold reads them: a slot that already holds the account the move puts there needs nothing more,
   * and a slot that no longer holds what the move takes it off is not switched on a premise that
   * has gone, which counts as the move failing. The account it puts there is checked by the switch
   * itself (live in no other slot, one the slot may hold, its token usable).
   */
  private async importMoveLocked(
    pending: readonly ImportMove[],
    batch: ImportBatch,
    done: ImportProgress,
    renew: () => void,
    made: MadeMove[],
  ): Promise<ImportMove[]> {
    const [move, ...rest] = pending as [ImportMove, ...ImportMove[]];
    const putBack = {
      writes: batch.decision.writes,
      ruleIds: batch.ruleIds,
      outcomes: done.outcomes,
      before: batch.before,
      notLanded: batch.notLanded,
    };
    const occupancy = await this.slotOccupancy(await this.vault.readPicture());
    const owners = occupancy.get(move.slotId) ?? new Set<string>();
    if (move.to !== null && owners.has(move.to)) return rest;
    // What the slot should hold now: what the plan found there, or, for a slot this run already
    // moved (one cleared to break a trade, then given its account), where this run left it.
    const mine = made.findLast((m) => m.slot === move.slotId);
    const holds = mine === undefined ? move.from.id : mine.to;
    const switchedSince = holds === null ? owners.size > 0 : !owners.has(holds);
    let failed: { slot: SlotId; to: string | null; error: SwitchEngineError } | undefined;
    if (switchedSince) {
      const error = new SlotError(
        'another command switched it while the import ran',
        'slot_mismatch',
      );
      failed = { slot: move.slotId, to: move.to, error };
    } else {
      const step = { slotId: move.slotId, from: { id: holds }, to: move.to };
      const run = await this.executeHandOffLocked([step], renew, occupancy);
      made.push(...run.made);
      if (run.stopped !== undefined) {
        // No move after this one is made, but the lock is still this run's unless it was taken
        // over: the rules the slots, as they then stand, would run against are put back as for a
        // move that failed, so nothing (the daemon's repair, a launch) moves a running slot later
        // for a rule whose move this run never made.
        const stopped = run.stopped;
        if (!(stopped instanceof SwitchEngineError && stopped.code === 'lock_lost')) {
          const why =
            `the import stopped before the move this rule needs was made (${stopped.message}); ` +
            'it was left as it was before the import';
          await this.putBackViolatedWrites([], putBack, why, renew).catch((err: unknown) => {
            if (this.isSimulatedDeath(err)) throw err;
            this.log.warn(
              { reason: errorReason(err) },
              'a stopped import could not put rules back',
            );
          });
        }
        throw stopped;
      }
      failed = run.failed;
    }
    if (failed === undefined) return rest;
    const { slot, to, error } = failed;
    // An account is blamed only for a switch onto it that was tried.
    if (to !== null && !switchedSince) batch.avoided.add(to);
    const why =
      `${slotPhrase(slot, batch.before.rules)} could not be ` +
      (to === null
        ? 'signed out'
        : `switched to "${(await this.vault.getAccount(to))?.label ?? to}"`) +
      ` (${error.message}), which this rule needs; it was left as it was before the import`;
    const left = await this.putBackViolatedWrites(rest, putBack, why, renew);
    if (left === undefined) throw error;
    return left;
  }

  /**
   * Step 5 of {@link importRules} for one written rule, under a hold of the lock of its own: seat
   * its slot. Only an account the batch newly includes in the rule is a reason to move the slot off
   * an account it may keep. Who is live in every slot is read once, under this hold, and is what the
   * seat and the switch it makes go by (a seat changes only its own slot).
   */
  private async seatImportedLocked(
    write: ImportWrite,
    batch: ImportBatch,
    renew: () => void,
    done: ImportProgress,
  ): Promise<void> {
    const ruleId = batch.ruleIds.get(write);
    if (ruleId === undefined || done.outcomes[write.index] !== undefined) return;
    const rule = await this.vault.getRule(ruleId);
    if (!rule) return;
    const slotId = ruleSlotId(ruleId);
    const before = await this.seatOccupant(slotId);
    /** Report the slot as the seat left it, when it held a login and holds another now. */
    const report = async (): Promise<void> => {
      const now = await this.seatOccupant(slotId);
      if (!before.hasLogin || (now.hasLogin && now.id === before.id)) return;
      done.seated.push({ slot: slotId, from: before.id, to: now.hasLogin ? now.id : null });
    };
    let live: RuleLiveResult | null = null;
    try {
      live = await this.ensureRuleLiveLocked(rule, {
        ...(write.include.length > 0 ? { preferIncluded: new Set(write.include) } : {}),
        keepOut: batch.keepOut,
        avoid: batch.avoided,
        renew,
        occupancy: await this.slotOccupancy(await this.vault.readPicture()),
        guard: {
          move: batch.decision.seats.find((s) => s.slot === slotId),
          rule: batch.before.rules.find((r) => r.id === ruleId) ?? rule,
        },
      });
    } catch (err) {
      if (
        !(err instanceof SwitchEngineError) ||
        err.code === 'lock_lost' ||
        this.isSimulatedDeath(err)
      ) {
        if (!this.isSimulatedDeath(err)) await report();
        throw err;
      }
      this.log.warn({ ruleId, reason: errorReason(err) }, 'an imported rule could not be seated');
    }
    await report();
    done.outcomes[write.index] = {
      ok: true,
      rule: (await this.vault.getRule(ruleId)) ?? rule,
      created: write.ruleId === undefined,
      live,
      runningSessions: await this.runningSessionsInRule(rule),
    };
  }

  /**
   * Make sure each account an import is about to put live can go live, before anything is written
   * or moved: no other stored account holds the same token (a switch refuses that), its stored
   * tokens can be read, and a token near its end is refreshed now and stored at once, as the switch
   * would. An account live in a slot the decision moves off it (`moves`) is the one exception to
   * being live nowhere: the switch onto it would take that slot's rotation, so it is adopted first,
   * and a refresh it then needs writes the new tokens into that slot too, so the slot runs on them
   * until it moves rather than on a spent token. A token any other slot holds live is never
   * refreshed. The first account that cannot go live is returned with why (`failed`). A lock taken
   * over, or a process that died, stops the import instead.
   *
   * `refreshHere`, when given, names the accounts whose refresh is made here; any other account
   * that needs one is returned in `stale` instead, unrefreshed, for its caller to refresh under a
   * hold of the lock of its own (see importBatchLocked).
   */
  private async readyImportTargets(
    ids: readonly string[],
    moves: readonly ImportMove[],
    renew: () => void,
    refreshHere?: ReadonlySet<string>,
  ): Promise<{ failed?: { id: string; error: SwitchEngineError }; stale: string[] }> {
    const stale: string[] = [];
    // Read once for every account: a refresh below gives one account a token of its own, which
    // shares nothing with another's. Which slot runs each token is read once too, and again only
    // after a slot is written here (a switch settled there, refreshed tokens written into it), so
    // the whole check is a few walks of the slots rather than one per account.
    const stored = await this.vault.readStoredTokens();
    let holders: Map<string, SlotId> | undefined;
    for (const id of new Set(ids)) {
      renew();
      try {
        await this.refuseSharedToken(id, stored);
        const leaving = moves.find((m) => m.from.id === id)?.slotId;
        const left = leaving === undefined ? undefined : this.slotRuntime(leaving);
        if (left !== undefined) {
          await this.requireSettledLocked(left);
          holders = undefined;
          await this.adoptSlotRotation(left, id);
        }
        const bundle = await this.vault.readBundle(id);
        const expiring = bundle.claudeAiOauth.expiresAt - this.clock() < this.refreshSkewMs;
        holders ??= expiring ? await this.liveRefreshTokens() : undefined;
        const holder = expiring ? holders?.get(bundle.claudeAiOauth.refreshToken) : undefined;
        // Refreshed when no slot runs the token, or only the slot it is leaving (which then runs on
        // the new tokens until it moves); never when another slot runs it.
        if (!expiring || (holder !== undefined && holder !== leaving)) continue;
        if (refreshHere !== undefined && !refreshHere.has(id)) {
          stale.push(id);
          continue;
        }
        const next = await this.refreshAndPersist(id, bundle);
        if (holder !== undefined) {
          await left!.credStore.writeLiveCredentials(next.claudeAiOauth);
          holders = undefined;
        }
      } catch (err) {
        if (this.isSimulatedDeath(err)) throw err;
        if (err instanceof SwitchEngineError && err.code === 'lock_lost') throw err;
        const error =
          err instanceof SwitchEngineError
            ? err
            : new SwitchEngineError(errorReason(err), 'switch_failed', { cause: err });
        return { failed: { id, error }, stale };
      }
    }
    return { stale };
  }

  /**
   * The moves of an import still worth making once a rule of its batch did not land (its write
   * failed, or it was put back): a hand-off off an account the slot may hold as the rules now stand
   * was for a rule that did not land, and so is the seat of a rule that did not land (`notLanded`
   * names their slots), so both are dropped, and so is every move onto an account a dropped move
   * leaves where it is.
   */
  private async movesStillNeeded(
    moves: readonly ImportMove[],
    notLanded: ReadonlySet<SlotId>,
  ): Promise<ImportMove[]> {
    const picture = await this.vault.readPicture();
    let kept = moves.filter((m) =>
      m.kind === 'seat'
        ? !notLanded.has(m.slotId)
        : m.from.id === null || !slotMayHold(m.slotId, m.from.id, picture),
    );
    for (;;) {
      const staying = new Set(moves.filter((m) => !kept.includes(m)).map((m) => m.from.id));
      const next = kept.filter((m) => m.to === null || !staying.has(m.to));
      if (next.length === kept.length) return kept;
      kept = next;
    }
  }

  /**
   * After a planned move failed (`why` says how), put back every rule of the batch that a slot, as
   * the slots then stand, would run against: one holding an account that the rules as written
   * forbid it and that the rules before the import allowed it, with no move still to be made that
   * takes it elsewhere. The rules to blame are the ones the batch reserved that account in, and the
   * slot's own rule when the batch excluded it there; each is put back as it was (a rule the batch
   * made is removed) and reported as not imported, for `why`. Done until no such slot is left, so a
   * put-back that makes another move pointless is followed through. Returns the moves of `rest`
   * still to be made, or undefined when some slot runs against a rule that no put-back would mend.
   */
  private async putBackViolatedWrites(
    rest: readonly ImportMove[],
    batch: {
      writes: readonly ImportWrite[];
      ruleIds: ReadonlyMap<ImportWrite, string>;
      outcomes: Array<ImportRuleOutcome | undefined>;
      before: RulesPicture;
      notLanded: () => Set<SlotId>;
    },
    why: string,
    renew: () => void,
  ): Promise<ImportMove[] | undefined> {
    const { writes, ruleIds, outcomes, before } = batch;
    const landed = writes.filter((w) => ruleIds.has(w) && outcomes[w.index] === undefined);
    for (;;) {
      renew();
      const kept = await this.movesStillNeeded(rest, batch.notLanded());
      const picture = await this.vault.readPicture();
      const stored = await this.vault.readStoredTokens();
      const blamed = new Set<ImportWrite>();
      let mended = true;
      for (const slotId of allSlots(picture.rules)) {
        if (kept.some((m) => m.slotId === slotId)) continue;
        for (const id of await this.possibleLiveOwners(slotId, stored, picture)) {
          if (slotMayHold(slotId, id, picture) || !slotMayHold(slotId, id, before)) continue;
          const blame = landed.filter(
            (w) =>
              outcomes[w.index] === undefined &&
              ((w.include.includes(id) && before.shared.some((a) => a.id === id)) ||
                (w.exclude.includes(id) && ruleSlotId(ruleIds.get(w)!) === slotId)),
          );
          if (blame.length === 0) mended = false;
          for (const w of blame) blamed.add(w);
        }
      }
      if (blamed.size === 0) return mended ? kept : undefined;
      for (const write of blamed) {
        await this.putBackImportWrite(write, ruleIds.get(write)!);
        outcomes[write.index] = { ok: false, message: why };
      }
    }
  }

  /** Put a rule an import wrote back as it was before: the members and scopes the write added are
   *  taken off it again, or, for a rule it made, the rule is removed (its slot was never seated, so
   *  it holds no login). */
  private async putBackImportWrite(write: ImportWrite, ruleId: string): Promise<void> {
    if (write.ruleId === undefined) {
      await this.clearSlotState(this.slotRuntime(ruleSlotId(ruleId)));
      await this.vault.removeRule(ruleId);
      return;
    }
    const members = [...write.include, ...write.exclude];
    if (members.length > 0) await this.vault.removeFromRule(ruleId, members);
    for (const scope of write.gains) {
      if (scope.kind === 'folder') await this.vault.removeFolderFromRule(ruleId, scope.folder);
      else await this.vault.removeAliasFromRule(ruleId, scope);
    }
  }

  /**
   * THE import decision, shared by {@link planImportRules} and {@link importRules}: per spec, the
   * verdict a run would reach, the writes it would make, and every slot it would move, writing
   * nothing. Holds the lock. In order:
   *   1. each spec's scopes, canonicalized as the verbs canonicalize them.
   *   2. the rule it is: the one rule here carrying its identity (two such rules leave none to
   *      grow); any of its scopes held by another rule here, or by an earlier spec, refuses it whole
   *      (see {@link ImportConflict}), and so does a scope it cannot use here that a rule here
   *      holds (`absent`).
   *   3. its members as they would land: for a grown rule only the ones it lacks, leaving out one
   *      it holds on the other side, and never an exclusion of an account a rule here reserves
   *      (only a shared account can be excluded). A spec with nothing left to write is unchanged.
   * Then, until the batch holds (each spec refused below is out, and everything after step 3 is
   * decided again without it):
   *   4. the rule cap and the reserved-account cap, counted in spec order over the specs still in
   *      the batch, so room is never spent on a spec refused later.
   *   5. the batch tried against a draft of the registry, in the order it is written; a spec the
   *      draft refuses is refused, so the real batch meets no refusal the decision did not.
   *   6. the moves ({@link planImportMovesLocked}), chosen for all the slots together against the
   *      rules as the batch leaves them: every slot holding an account the batch reserves that it
   *      may not hold then, and every written rule's slot holding a login that seating it would move
   *      (its occupant left the rule's pool, the batch newly includes an account there, or it holds
   *      a login no account here is), so an account one slot leaves is one another can take, and no
   *      slot takes the only account another has while it could take another. When some slot is
   *      left with nothing, the spec refused is the last, in spec order, without which the rest of
   *      the batch fits (see specLeavingNoMove).
   *   7. the seat step played out on the draft ({@link seatBatch}): after the moves, each written
   *      rule's slot seated in turn by the same choice the real seat step makes, so every slot it
   *      moves is in the plan; a slot holding a login that it would clear while sessions run under
   *      the rule refuses the spec writing that rule.
   * Once the batch holds, each spec 6 or 7 refused is tried again against it, in spec order: one
   * refused only for what a spec refused after it took lands after all (the batch is decided again
   * with it), and one that still does not fit is refused for what this batch leaves it. So a spec
   * is refused only for what the specs that land leave it, which a second run of the file finds.
   * Who is live in each slot is read from the slots themselves ({@link possibleLiveOwners}), not
   * from what is recorded for them; an account in `pending` or `logins` counts as live where its
   * login runs unrecognized, and an account in `revived` as usable. `avoid` names accounts that
   * cannot go live in this run (see readyImportTargets), which no slot is moved onto or seated
   * with. `settle` says whether a slot with a switch left unfinished is settled first (the real
   * run), or left to the real run to settle (a plan writes nothing).
   */
  private async decideImportLocked(
    specs: readonly ImportRuleSpec[],
    opts: {
      keepOut: ReadonlySet<string>;
      pending: readonly PendingImportAccount[];
      logins: ReadonlyArray<{ id: string; accountUuid: string }>;
      settle: boolean;
      revived?: readonly string[];
      avoid?: ReadonlyMap<string, string>;
    },
  ): Promise<ImportDecision> {
    const verdicts: Array<ImportRuleVerdict | undefined> = specs.map(() => undefined);
    const refuse = (i: number, err: unknown, conflict?: ImportConflict): void => {
      if (!(err instanceof SwitchEngineError)) throw err;
      verdicts[i] = { kind: 'refused', message: err.message, ...(conflict ? { conflict } : {}) };
    };
    const open = (i: number): boolean => verdicts[i] === undefined;

    // 1. Scopes.
    const scopes: RuleScopeRef[][] = specs.map((spec, i) => {
      try {
        return spec.scopes.map((scope) => this.canonicalizeEditScope(scope));
      } catch (err) {
        refuse(i, err);
        return [];
      }
    });

    const stored = await this.vault.readPicture();
    const pendingRows: StoredAccount[] = opts.pending.map((p) => ({
      id: p.id,
      label: p.label,
      ...(p.accountUuid !== undefined ? { accountUuid: p.accountUuid } : {}),
      quarantined: !p.withTokens,
      ...(p.autoSwitchExcluded === true ? { autoSwitchExcluded: true } : {}),
      createdAtMs: 0,
      updatedAtMs: 0,
    }));
    const revived = new Set(opts.revived ?? []);
    const picture: RegistryPicture = withRevived(
      { ...stored, shared: [...stored.shared, ...pendingRows] },
      revived,
    );
    const states = await this.importStates(stored, [...opts.pending, ...opts.logins]);

    // 2. The rule each spec is, and the scopes no other rule may hold.
    const targets: Array<FolderRule | undefined> = specs.map(() => undefined);
    const claimed = new Set<string>();
    for (const [i, spec] of specs.entries()) {
      if (!open(i)) continue;
      // A parallel session is no rule of any machine's: it never carries a file's identity.
      const same =
        spec.origin === undefined
          ? []
          : operatorRules(stored.rules).filter(
              (r) => r.origin === spec.origin || r.id === spec.origin,
            );
      if (same.length > 1) {
        refuse(
          i,
          new VaultError(
            `this machine already has it split between rules on ${same.map(describeRule).join(' and ')}; ` +
              'it is left as it is (remove all but one with cctl folder reset, then import again)',
          ),
        );
        continue;
      }
      const into = same[0];
      if (into !== undefined && targets.includes(into)) {
        refuse(i, new VaultError('the file holds this rule twice; it is imported once'));
        continue;
      }
      const conflict = this.importConflict(
        scopes[i]!,
        spec.absent ?? [],
        into,
        stored.rules,
        claimed,
      );
      if (conflict !== undefined) {
        refuse(i, conflict.error, conflict.conflict);
        continue;
      }
      targets[i] = into;
      for (const scope of scopes[i]!) claimed.add(this.scopeKey(scope));
    }

    // 3. Members.
    const members = specs.map((spec, i) => {
      const into = targets[i];
      const leftOut: ImportLeftOut[] = [];
      const include = [...new Set(spec.include)].filter((id) => {
        if (into === undefined) return true;
        if (into.exclude.includes(id)) leftOut.push({ id, why: 'excluded-here' });
        return !into.include.includes(id) && !into.exclude.includes(id);
      });
      const exclude = [...new Set(spec.exclude)].filter((id) => {
        if (into?.exclude.includes(id) === true) return false;
        if (into?.include.includes(id) === true) {
          leftOut.push({ id, why: 'included-here' });
          return false;
        }
        if (stored.reserved.some((a) => a.id === id)) {
          // Reserved by nothing but its parallel session, it is shared again once that ends.
          const leased = rulesIncluding(id, stored.rules).every(isLeaseRule);
          leftOut.push({ id, why: leased ? 'leased-here' : 'reserved-here' });
          return false;
        }
        return true;
      });
      const gains = into !== undefined ? this.scopesLacking(into, scopes[i]!) : scopes[i]!;
      return { include, exclude, leftOut, gains };
    });
    for (const [i] of specs.entries()) {
      if (!open(i)) continue;
      const { include, exclude, leftOut, gains } = members[i]!;
      const into = targets[i];
      if (into !== undefined && gains.length + include.length + exclude.length === 0) {
        verdicts[i] = {
          kind: 'unchanged',
          reason: 'this machine already has this rule, with these accounts',
          rule: into,
          leftOut,
        };
      } else if (into === undefined && include.length + exclude.length === 0) {
        verdicts[i] = {
          kind: 'unchanged',
          reason: leftOut.every((l) => l.why === 'leased-here')
            ? 'a parallel session runs on every account it excludes, so it would change nothing ' +
              'now; import again once the session ends'
            : 'another rule here reserves every account it excludes, so it would change nothing',
          leftOut,
        };
      }
    }

    // A grown rule's slot is written to: a switch left unfinished there is settled first in the real
    // run (or refuses the spec), as before any write to it.
    if (opts.settle) {
      for (const [i] of specs.entries()) {
        const into = targets[i];
        if (!open(i) || into === undefined) continue;
        try {
          await this.requireSettledLocked(this.slotRuntime(ruleSlotId(into.id)));
        } catch (err) {
          refuse(i, err);
        }
      }
    }

    /** What the import writes for spec `i`. */
    const writeOf = (i: number): ImportWrite => {
      const spec = specs[i]!;
      return {
        index: i,
        ...(targets[i] !== undefined ? { ruleId: targets[i].id } : {}),
        scopes: scopes[i]!,
        gains: members[i]!.gains,
        include: members[i]!.include,
        exclude: members[i]!.exclude,
        ...(spec.label !== undefined ? { label: spec.label } : {}),
        ...(spec.origin !== undefined ? { origin: spec.origin } : {}),
      };
    };
    /** The specs of `indices` tried against a draft of the registry, in the order the batch is
     *  written: the specs the draft refuses, the rule each write landed in, and the registry as the
     *  batch leaves it (with the quarantine the import lifts lifted). */
    const tryBatch = async (indices: readonly number[]): Promise<TriedBatch> => {
      const draft = await this.vault.draftRules(pendingRows);
      const writes = indices.map(writeOf);
      const refused = new Map<number, SwitchEngineError>();
      const ruleIds = await writeImportBatch(draft, writes, (write, err) => {
        refused.set(write.index, err);
      });
      return { writes, refused, ruleIds, after: withRevived(draft.picture(), revived) };
    };
    /** The sessions running under each rule here, read once for the whole decision. */
    const sessionsRead = new Map<string, RunningSession[]>();
    const sessionsUnder = async (rule: FolderRule): Promise<RunningSession[]> => {
      let sessions = sessionsRead.get(rule.id);
      if (sessions === undefined) {
        sessions = await this.runningSessionsInRule(rule);
        sessionsRead.set(rule.id, sessions);
      }
      return sessions;
    };
    /** The moves a tried batch makes, judged against the rules as it leaves them. */
    const movesFor = (tried: TriedBatch): Promise<MovePlan> =>
      this.planImportMovesLocked(tried, picture, states, targets, {
        keepOut: opts.keepOut,
        sessionsUnder,
        ...(opts.avoid !== undefined ? { avoid: opts.avoid } : {}),
      });

    // 4-7, until the batch holds: the caps are counted over the specs still in it, the batch is tried
    // against a draft, the moves are chosen against the rules as it leaves them, and the slots it
    // leaves without an account are checked. A spec refused by any of these is out, and the whole
    // batch is decided again without it, so a cap is never spent by a spec refused later.
    /** The open specs in spec order, with `plus` among them, and the caps they hit. */
    const batchOf = (
      plus?: number,
    ): { batch: number[]; capped: Map<number, SwitchEngineError> } => {
      const capped = importCapRefusals(
        specs.flatMap((_, i) => (open(i) || i === plus ? [i] : [])),
        targets,
        members,
        stored,
        picture,
      );
      const batch = specs.flatMap((_, i) => ((open(i) || i === plus) && !capped.has(i) ? [i] : []));
      return { batch, capped };
    };
    /** The refusal of spec `i` for leaving a slot with nothing to move to (`short`). The spec the
     *  stuck slot's occupant is moved for gets the slot's own refusal; any other spec is refused for
     *  taking what that slot could have moved to. */
    const movesRefusal = (
      i: number,
      short: Extract<MovePlan, { ok: false }>,
    ): SwitchEngineError => {
      const own =
        short.kind === 'handOff'
          ? short.from.id !== null && members[i]!.include.includes(short.from.id)
          : targets[i] !== undefined && ruleSlotId(targets[i].id) === short.slotId;
      if (own) return short.error;
      const where = slotPhrase(short.slotId, picture.rules);
      return new RefreshError(
        short.kind === 'handOff'
          ? `it would leave ${where} with no account to switch to, once ` +
              `"${short.from.label}" moves off it for another rule of the file`
          : `it would leave ${where}, where sessions are running, with no account to ` +
              `switch to once ${moverName(short.from)} leaves it`,
        short.error.code,
      );
    };
    /** Why spec `i` does not fit in with the open specs (whose caps are `capped`), or undefined
     *  when it does: steps 4 to 7 for the batch with it. */
    const misfit = async (
      i: number,
      capped: ReadonlyMap<number, SwitchEngineError>,
    ): Promise<
      | { kind: 'moves'; plan: Extract<MovePlan, { ok: false }> }
      | { kind: 'error'; error: unknown }
      | undefined
    > => {
      const withIt = batchOf(i);
      const overCap = [...withIt.capped].find(([j]) => !capped.has(j));
      if (overCap !== undefined) return { kind: 'error', error: overCap[1] };
      const tried = await tryBatch(withIt.batch);
      const draft = tried.refused.get(i) ?? [...tried.refused.values()][0];
      if (draft !== undefined) return { kind: 'error', error: draft };
      const plan = await movesFor(tried);
      if (!plan.ok) return { kind: 'moves', plan };
      const seat = await this.seatBatch(tried, plan.moves, states, targets, picture, {
        ...opts,
        sessionsUnder,
      });
      return seat.ok ? undefined : { kind: 'error', error: seat.error };
    };
    /** Specs refused for what the rest of the batch took (steps 6 and 7), which a smaller batch,
     *  once later refusals have made it so, may have room for after all; each is let back in at
     *  most once, so the decision always ends. */
    const crowded = new Set<number>();
    const letBackIn = new Set<number>();
    let capped = new Map<number, SwitchEngineError>();
    let moves: ImportMove[] = [];
    let writes: ImportWrite[] = [];
    let seated: { seats: SlotSeat[]; targets: string[] } = { seats: [], targets: [] };
    for (;;) {
      // 4. The caps, in spec order.
      const next = batchOf();
      capped = next.capped;
      const batch = next.batch;

      // 5. The batch, tried against a draft.
      const tried = await tryBatch(batch);
      if (tried.refused.size > 0) {
        for (const [i, err] of tried.refused) refuse(i, err);
        continue;
      }

      // 6. The moves, chosen for the whole batch. When some slot is left with nothing, the spec
      //    refused is the one the rest of the batch fits without (see specLeavingNoMove).
      const plan = await movesFor(tried);
      if (!plan.ok) {
        const culprit = await this.specLeavingNoMove(batch, plan, tryBatch, movesFor);
        const i = culprit?.index ?? batch.at(-1)!;
        refuse(i, movesRefusal(i, culprit?.plan ?? plan));
        if (!letBackIn.has(i)) crowded.add(i);
        continue;
      }

      // 7. The seat step, played out on the draft; a slot it would clear while sessions run there
      //    refuses the spec writing that rule.
      const seat = await this.seatBatch(tried, plan.moves, states, targets, picture, {
        ...opts,
        sessionsUnder,
      });
      if (!seat.ok) {
        refuse(seat.index, seat.error);
        if (!letBackIn.has(seat.index)) crowded.add(seat.index);
        continue;
      }

      // A spec refused for what the rest of the batch took is tried again, in spec order, against
      // the batch that holds: one refused for a spec refused after it lands after all (and the
      // batch is decided again with it), so a second run of the same file lands nothing the first
      // refused. One that still does not fit is refused for what this batch leaves it.
      let readmitted = false;
      for (const i of [...crowded].sort((x, y) => x - y)) {
        const why = await misfit(i, capped);
        if (why === undefined) {
          verdicts[i] = undefined;
          crowded.delete(i);
          letBackIn.add(i);
          readmitted = true;
          break;
        }
        refuse(i, why.kind === 'moves' ? movesRefusal(i, why.plan) : why.error);
      }
      if (readmitted) continue;
      moves = plan.moves;
      writes = tried.writes;
      seated = seat;
      break;
    }
    for (const [i, err] of capped) refuse(i, err);

    for (const write of writes) {
      const { include, exclude, leftOut, gains } = members[write.index]!;
      const into = targets[write.index];
      verdicts[write.index] =
        into === undefined
          ? { kind: 'create', scopes: write.scopes, include, exclude, leftOut }
          : { kind: 'grow', rule: into, scopes: gains, include, exclude, leftOut };
    }
    const net = netMoves(
      moves.map((m) => ({ slot: m.slotId, from: m.from.id, to: m.to, kind: m.kind })),
    );
    return {
      plan: {
        rules: verdicts as ImportRuleVerdict[],
        handOffs: net.handOffs,
        seats: [...net.seats, ...seated.seats],
      },
      writes,
      moves,
      seats: seated.seats,
      targets: [...moves.flatMap((m) => (m.to === null ? [] : [m.to])), ...seated.targets],
    };
  }

  /**
   * The spec to refuse when `batch` as a whole leaves some slot with no account to move to (`plan`
   * says which): the last, in spec order, without which the rest of the batch fits. Each spec is
   * judged against everything else the file does, later specs included (a slot another spec's seat
   * moves off an account, an account another spec includes in the slot holding it), and earlier
   * specs keep their place. When no one spec is to blame, the first whose addition to the ones
   * before it leaves a slot so, with the plan that fails there.
   */
  private async specLeavingNoMove(
    batch: readonly number[],
    plan: Extract<MovePlan, { ok: false }>,
    tryBatch: (indices: readonly number[]) => Promise<TriedBatch>,
    movesFor: (tried: TriedBatch) => Promise<MovePlan>,
  ): Promise<{ index: number; plan: Extract<MovePlan, { ok: false }> } | undefined> {
    for (let k = batch.length - 1; k >= 0; k -= 1) {
      const rest = await tryBatch(batch.filter((_, j) => j !== k));
      if (rest.refused.size === 0 && (await movesFor(rest)).ok) return { index: batch[k]!, plan };
    }
    for (let k = 1; k <= batch.length; k += 1) {
      const plan = await movesFor(await tryBatch(batch.slice(0, k)));
      if (!plan.ok) return { index: batch[k - 1]!, plan };
    }
    return undefined;
  }

  /**
   * Every slot holding a login that an import's batch moves (step 6 of decideImportLocked), with
   * the account each moves to, chosen for all of them together against the rules as the batch
   * leaves them (`tried.after`):
   *   - a slot holding an account the batch reserves, which it may not hold then, must move (a
   *     `handOff`): onto an account available to it, best in pool order; the slot of a rule the
   *     batch writes, with no sessions running under it, is cleared when nothing is left for it,
   *     as seating it would clear it;
   *   - a written rule's slot that seating it would move (a `seat`, by {@link chooseSeat}'s own
   *     choice): its occupant left the rule's pool, or its login is dead, or the batch newly
   *     includes an account there. With nothing to move onto, a slot whose occupant may stay keeps
   *     it; one whose occupant may not is cleared, unless sessions run under the rule, when it must
   *     move like a hand-off.
   * An account a moving slot leaves is one another can take (the moves then come in the order that
   * frees it first), and the accounts are assigned together ({@link assignDistinct}): a slot is
   * left with nothing only when no assignment gives it an account, not because another took the
   * one it needed while it had another to spare, nor because the assignment had slots trade
   * accounts that another assignment frees in turn (see untradedMoves). A slot holding a login no
   * account here is, or an empty one, is the seat step's. `avoid` names accounts that cannot go
   * live in this run.
   */
  private async planImportMovesLocked(
    tried: TriedBatch,
    picture: RegistryPicture,
    states: SlotStates,
    targets: ReadonlyArray<FolderRule | undefined>,
    opts: {
      keepOut: ReadonlySet<string>;
      avoid?: ReadonlyMap<string, string>;
      sessionsUnder: (rule: FolderRule) => Promise<RunningSession[]>;
    },
  ): Promise<MovePlan> {
    const after = tried.after;
    const rows = [...picture.shared, ...picture.reserved];
    const avoid = new Set(opts.avoid?.keys() ?? []);
    const reserving = new Set(tried.writes.flatMap((w) => w.include));
    /** The rule here a slot belongs to, when the batch writes it. */
    const writtenRuleOf = (slotId: SlotId): FolderRule | undefined =>
      tried.writes
        .map((w) => targets[w.index])
        .find((r) => r !== undefined && ruleSlotId(r.id) === slotId);
    const movers: ImportMover[] = [];
    for (const [slotId, owners] of states.owners) {
      if (isLeaseSlot(slotId, picture.rules)) continue;
      const from = picture.shared.find(
        (a) => owners.has(a.id) && reserving.has(a.id) && !slotMayHold(slotId, a.id, after),
      );
      if (from === undefined) continue;
      // The slot of a rule the batch writes is cleared when nothing else is left for it, as seating
      // it would clear it, unless sessions run under it; any other slot must move.
      const into = writtenRuleOf(slotId);
      const clearable = into !== undefined && (await opts.sessionsUnder(into)).length === 0;
      movers.push({ slotId, from, kind: 'handOff', fallback: clearable ? 'clear' : 'none' });
    }
    for (const write of tried.writes) {
      const into = targets[write.index];
      if (into === undefined) continue;
      const slotId = ruleSlotId(into.id);
      if (!states.withLogin.has(slotId) || movers.some((m) => m.slotId === slotId)) continue;
      // A login no account here is recognized as is the seat's to move as much as any other: it
      // takes an account another moving slot may need, so it is assigned with them.
      const id = states.active.get(slotId) ?? null;
      const from: MoveFrom | undefined =
        id === null ? UNRECOGNIZED_LOGIN : rows.find((a) => a.id === id);
      if (from === undefined) continue;
      const prefer = write.include.length > 0 ? new Set(write.include) : undefined;
      const choice = chooseSeat(
        slotId,
        after,
        states.owners,
        { id: from.id, hasLogin: true },
        { ...(prefer !== undefined ? { prefer } : {}), keepOut: opts.keepOut, avoid },
      );
      if (choice.keeps !== null && choice.candidates.length === 0) continue;
      const fallback =
        choice.keeps !== null
          ? 'keep'
          : (await opts.sessionsUnder(into)).length > 0
            ? 'none'
            : 'clear';
      movers.push({
        slotId,
        from,
        kind: 'seat',
        fallback,
        ...(prefer !== undefined ? { prefer } : {}),
      });
    }
    if (movers.length === 0) return { ok: true, moves: [] };

    /** Each mover's accounts, best first, with the slots holding `occupancy`, then what it falls
     *  back to with none of them. */
    const candidatesOf = (
      m: ImportMover,
      occupancy: ReadonlyMap<SlotId, ReadonlySet<string>>,
    ): string[] => {
      const accounts =
        m.kind === 'handOff'
          ? availableInOrder(withoutKeptOut(slotPool(m.slotId, after, occupancy), opts.keepOut))
          : chooseSeat(
              m.slotId,
              after,
              occupancy,
              { id: m.from.id, hasLogin: true },
              { ...(m.prefer !== undefined ? { prefer: m.prefer } : {}), keepOut: opts.keepOut },
            ).candidates;
      const fallback = moverFallback(m);
      return [
        ...accounts.filter((a) => !avoid.has(a.id)).map((a) => a.id),
        ...(fallback !== undefined ? [fallback] : []),
      ];
    };
    // Movers that can fall back are placed first, so a slot that must move can still take an
    // account from one of them (which then falls back) rather than be refused.
    const order = [...movers.keys()].sort(
      (i, j) => Number(movers[i]!.fallback === 'none') - Number(movers[j]!.fallback === 'none'),
    );
    const assign = (
      occupancy: ReadonlyMap<SlotId, ReadonlySet<string>>,
      banned: ReadonlySet<string> = new Set(),
    ): { ok: true; moves: ImportMove[] } | { ok: false; unserved: ImportMover } => {
      const assigned = assignDistinct(
        order.map((i) =>
          candidatesOf(movers[i]!, occupancy).filter(
            (id) => !banned.has(bannedKey(movers[i]!.slotId, id)),
          ),
        ),
      );
      if (!assigned.ok) return { ok: false, unserved: movers[order[assigned.unserved]!]! };
      const chosen = new Map(order.map((i, k) => [i, assigned.chosen[k]!]));
      return {
        ok: true,
        moves: movers.flatMap((m, i) => {
          const to = chosen.get(i)!;
          if (to === m.from.id) return [];
          const cleared = to === moverFallback(m);
          return [{ slotId: m.slotId, from: m.from, kind: m.kind, to: cleared ? null : to }];
        }),
      };
    };
    const leaving = new Map(movers.map((m) => [m.slotId, m.from.id]));
    const freed = new Map(
      [...states.owners].map(([slotId, owners]) => [
        slotId,
        new Set([...owners].filter((id) => id !== leaving.get(slotId))),
      ]),
    );
    const withFreed = assign(freed);
    if (withFreed.ok) {
      const ordered = orderedMoves(withFreed.moves);
      if (ordered !== undefined) return { ok: true, moves: ordered };
      // Slots trading accounts, which no order makes. A slot that may be left empty for a moment
      // (a written rule's, with no sessions under it) breaks the trade: it is cleared first, and
      // takes its account once the others have moved off theirs.
      const breakable = withFreed.moves.filter(
        (m) => m.to !== null && movers.find((r) => r.slotId === m.slotId)?.fallback === 'clear',
      );
      const rest = orderedMoves(
        withFreed.moves.map((m, i) => ({
          i,
          from: { id: breakable.includes(m) ? '' : m.from.id },
          to: m.to,
        })),
      );
      if (breakable.length > 0 && rest !== undefined) {
        return {
          ok: true,
          moves: [
            ...breakable.map((m) => ({ ...m, to: null })),
            ...rest.map((m) => withFreed.moves[m.i]!),
          ],
        };
      }
    }
    // Slots trading accounts that nothing breaks: the trade may be only the assignment's choice,
    // with another that frees each account in turn (a chain through a slot outside the trade). The
    // moves of a trade are taken out one at a time, and the slots assigned again without it.
    if (withFreed.ok) {
      const chain = untradedMoves(withFreed.moves, (banned) => assign(freed, banned));
      if (chain !== undefined) return { ok: true, moves: chain };
    }
    // No order frees what the freed accounts' takers need, or nothing fits even with them: choose
    // among accounts no slot holds.
    const assigned = withFreed.ok ? assign(states.owners) : withFreed;
    if (assigned.ok) return { ok: true, moves: assigned.moves };
    const short = assigned.unserved;
    const refused = (error: RefreshError): MovePlan => ({
      ok: false,
      slotId: short.slotId,
      from: short.from,
      kind: short.kind,
      error,
    });
    if (short.kind === 'handOff') {
      return refused(this.noReplacementError(short.slotId, short.from, picture, opts.avoid, after));
    }
    // A written rule's slot, with sessions running under the rule, that has nothing to move onto.
    const into = ruleOfSlot(short.slotId, picture.rules)!;
    return refused(
      emptyingRefusal(
        into,
        await opts.sessionsUnder(into),
        short.from.id === null || slotMayHold(short.slotId, short.from.id, after)
          ? 'importing it'
          : `excluding "${short.from.label}"`,
        IMPORT_SESSIONS_REMEDY,
      ),
    );
  }

  /**
   * The seat step of a batch (step 5 of {@link importRules}) played out on the draft, so the
   * decision states what it will do: starting from who holds each slot with the moves made, each
   * written rule's slot is seated in write order by the choice the real step makes
   * ({@link chooseSeat}, with the same accounts preferred, kept out and avoided), each seat seeing
   * the ones before it, against the rules as the batch leaves them. A slot the moves settled keeps
   * what they gave it; what is left is an empty slot, or one holding a login no account here is.
   * Returns every slot holding a login that it moves or clears, with every account it seats
   * anywhere, or the refusal of the first spec whose rule's slot it would clear while sessions run
   * under the rule.
   */
  private async seatBatch(
    tried: TriedBatch,
    moves: readonly ImportMove[],
    states: SlotStates,
    targets: ReadonlyArray<FolderRule | undefined>,
    before: RulesPicture,
    opts: {
      keepOut: ReadonlySet<string>;
      avoid?: ReadonlyMap<string, string>;
      sessionsUnder: (rule: FolderRule) => Promise<RunningSession[]>;
    },
  ): Promise<
    | { ok: true; seats: SlotSeat[]; targets: string[] }
    | { ok: false; index: number; error: unknown }
  > {
    const owners = new Map([...states.owners].map(([slot, ids]) => [slot, new Set(ids)]));
    const active = new Map(states.active);
    const withLogin = new Set(states.withLogin);
    let picture: RulesPicture = tried.after;
    /** The slot now holds `id`, or nothing; a rule records whom its slot holds. */
    const hold = (slotId: SlotId, id: string | null): void => {
      owners.set(slotId, new Set(id === null ? [] : [id]));
      active.set(slotId, id);
      if (id === null) withLogin.delete(slotId);
      else withLogin.add(slotId);
      const rule = ruleOfSlot(slotId, picture.rules);
      if (rule !== undefined) picture = withRule(picture, { ...rule, activeId: id });
    };
    for (const move of moves) hold(move.slotId, move.to);
    const avoid = new Set(opts.avoid?.keys() ?? []);
    const seats: SlotSeat[] = [];
    const seatedWith: string[] = [];
    for (const write of tried.writes) {
      const ruleId = tried.ruleIds.get(write);
      if (ruleId === undefined) continue;
      const slotId = ruleSlotId(ruleId);
      const from: SeatOccupant = {
        id: active.get(slotId) ?? null,
        hasLogin: withLogin.has(slotId),
      };
      const choice = chooseSeat(slotId, picture, owners, from, {
        ...(write.include.length > 0 ? { prefer: new Set(write.include) } : {}),
        keepOut: opts.keepOut,
        avoid,
      });
      const to = choice.candidates[0]?.id ?? choice.keeps;
      // A login kept stays where it is: whatever else the slot's login may belong to (a slot torn
      // between two accounts) is still live there, as the real seat step finds it.
      const kept = from.hasLogin && to !== null && to === from.id;
      if (kept) {
        const rule = ruleOfSlot(slotId, picture.rules);
        if (rule !== undefined) picture = withRule(picture, { ...rule, activeId: to });
        continue;
      }
      hold(slotId, to);
      if (to !== null) seatedWith.push(to);
      // An empty slot seated moves nothing anyone runs on.
      if (!from.hasLogin) continue;
      seats.push({ slot: slotId, from: from.id, to });
      const into = targets[write.index];
      if (to !== null || into === undefined) continue;
      // Cleared. Sessions running under the rule now would lose their account: the import never
      // does that, so the spec writing the rule is refused.
      const movedOff =
        from.id !== null &&
        slotMayHold(slotId, from.id, before) &&
        !slotMayHold(slotId, from.id, picture)
          ? from.id
          : undefined;
      const label =
        movedOff === undefined
          ? undefined
          : ([...before.shared, ...before.reserved].find((a) => a.id === movedOff)?.label ??
            movedOff);
      const sessions = await opts.sessionsUnder(into);
      if (sessions.length > 0) {
        const what = label !== undefined ? `excluding "${label}"` : 'importing it';
        return {
          ok: false,
          index: write.index,
          error: emptyingRefusal(into, sessions, what, IMPORT_SESSIONS_REMEDY),
        };
      }
    }
    return { ok: true, seats, targets: seatedWith };
  }

  /**
   * Who holds each slot as an import decides ({@link SlotStates}): the accounts its live login may
   * belong to ({@link slotOccupancy}), the account it is recognized as, and whether it holds a login
   * at all. A slot whose live login no stored account is recognized as holds every account of
   * `named` with that login: once the import has stored it (or given it that login), it is the
   * account live there.
   */
  private async importStates(
    picture: RegistryPicture,
    named: ReadonlyArray<{ id: string; accountUuid?: string }>,
  ): Promise<SlotStates> {
    const owners = await this.slotOccupancy(picture);
    const active = new Map<SlotId, string | null>();
    const withLogin = new Set<SlotId>();
    for (const slotId of allSlots(picture.rules)) {
      const occupant = await this.seatOccupant(slotId, picture);
      let id = occupant.id;
      if (occupant.hasLogin) {
        withLogin.add(slotId);
        if (id === null && named.length > 0) {
          const login = anchorValue(
            (
              await this.slotRuntime(slotId)
                .credStore.readOauthAccount()
                .catch(() => undefined)
            )?.accountUuid,
          );
          const matches = login === undefined ? [] : named.filter((a) => a.accountUuid === login);
          for (const account of matches) owners.get(slotId)?.add(account.id);
          id = matches[0]?.id ?? null;
        }
      }
      active.set(slotId, id);
    }
    return { owners, active, withLogin };
  }

  /** Who holds a slot, as a seat is chosen for it ({@link chooseSeat}): the account its live login
   *  is recognized as, and whether it holds a login at all. A slot with none holds nobody. */
  private async seatOccupant(slotId: SlotId, registry?: RegistryPicture): Promise<SeatOccupant> {
    const creds = await this.slotRuntime(slotId)
      .credStore.readLiveCredentials()
      .catch(() => undefined);
    if (creds === undefined) return { id: null, hasLogin: false };
    return { id: await this.activeIdIn(slotId, registry), hasLogin: true };
  }

  /**
   * Why a spec's `scopes` may not land whole here, or undefined: one of them is held by a rule of
   * this machine other than `into` (the rule the spec grows), or by an earlier spec of the batch
   * (`claimed`). A scope of the spec that cannot be used here (`absent`) counts too when a rule here
   * holds it: made on the rest, the file's one rule would be split in two. The refusal names the
   * scope and the rule holding it, with every scope that rule holds.
   */
  private importConflict(
    scopes: readonly RuleScopeRef[],
    absent: readonly RuleScopeRef[],
    into: FolderRule | undefined,
    rules: readonly FolderRule[],
    claimed: ReadonlySet<string>,
  ): { error: VaultError; conflict: ImportConflict } | undefined {
    const usable = new Set(scopes);
    for (const scope of [...scopes, ...absent]) {
      const holder =
        scope.kind === 'folder'
          ? exactFolderRule(scope.folder, rules, this.platform)
          : exactAliasRule(scope.folder, scope.alias, rules, this.platform);
      if (holder !== undefined && holder !== into) {
        return {
          error: new VaultError(
            `${scopePhrase(scope)} already has a rule here ("${holder.label}"), which is not the ` +
              "file's rule; a rule is imported whole or not at all",
          ),
          conflict: {
            scope,
            rule: { id: holder.id, label: holder.label, scopes: ruleScopeRefs(holder) },
          },
        };
      }
      if (usable.has(scope) && claimed.has(this.scopeKey(scope))) {
        return {
          error: new VaultError(`${scopePhrase(scope)} is in an earlier rule of the file too`),
          conflict: { scope },
        };
      }
    }
    return undefined;
  }

  /** A scope's uniqueness key here, as the store compares scopes. */
  private scopeKey(scope: RuleScopeRef): string {
    return scope.kind === 'folder'
      ? `f\u0000${folderUniquenessKey(scope.folder, this.platform)}`
      : `a\u0000${aliasScopeUniquenessKey(scope.folder, scope.alias, this.platform)}`;
  }

  /** The scopes of `scopes` that `rule` does not hold yet, by the store's uniqueness keys. The rule
   *  may hold others: it is the file's rule (an earlier import of it, since changed on either
   *  machine), and the scopes it holds beyond the file's stay its own. */
  private scopesLacking(rule: FolderRule, scopes: readonly RuleScopeRef[]): RuleScopeRef[] {
    const have = new Set([
      ...rule.folders.map((folder) => this.scopeKey({ kind: 'folder', folder })),
      ...(rule.aliases ?? []).map((a) => this.scopeKey({ kind: 'alias', ...a })),
    ]);
    return scopes.filter((scope) => !have.has(this.scopeKey(scope)));
  }

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
    return this.includeInScope({ kind: 'folder', folder }, accountIds, opts);
  }

  /**
   * Include accounts in the rule of a session ALIAS in one exact folder, creating that rule when the
   * alias has none: sessions titled `alias` (the `claude --resume` rule: case-insensitive, trimmed)
   * whose conversation was recorded in `folder` run on the rule's slot, and that rule outranks every
   * folder rule. Everything else is {@link includeInFolder}'s contract, step for step and fault point
   * for fault point. The alias is stored as entered; one carrying a control or bidi character, or
   * longer than Claude Code keeps a session name, is refused (it flows into hook output and
   * terminals, and a longer one could never match).
   */
  async includeInAlias(
    folder: string,
    alias: string,
    accountIds: readonly string[],
    opts: { label?: string } = {},
  ): Promise<IncludeResult> {
    return this.includeInScope({ kind: 'alias', folder, alias }, accountIds, opts);
  }

  /** The shared body of {@link includeInFolder} and {@link includeInAlias}; see includeInFolder for
   *  the order. */
  private async includeInScope(
    target: RuleScopeRef,
    accountIds: readonly string[],
    opts: { label?: string },
  ): Promise<IncludeResult> {
    this.refuseRuleSlotsOnDarwin();
    const scope = this.canonicalizeEditScope(target);
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
      const existing = this.exactScopeRule(scope, picture.rules);
      if (existing) {
        await this.vault.checkInclude(existing.id, requestedIds);
        // The rule's own slot is written last (ensure-live); a switch stuck there would refuse that
        // only after the registry and the other slots had moved, so it refuses here instead.
        await this.requireSettledLocked(this.slotRuntime(ruleSlotId(existing.id)));
      } else {
        await this.vault.checkCreateRule({
          ...newRuleScope(scope),
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
          ...newRuleScope(scope),
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
        runningSessions: await this.runningSessionsInScope(scope),
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
    return this.excludeInScope({ kind: 'folder', folder }, accountIds, opts);
  }

  /** {@link excludeInFolder} for the rule of a session alias in one exact folder (see
   *  {@link includeInAlias}): the named sessions avoid these shared accounts, in a slot of their
   *  own. */
  async excludeInAlias(
    folder: string,
    alias: string,
    accountIds: readonly string[],
    opts: { force?: boolean; label?: string } = {},
  ): Promise<ExcludeResult> {
    return this.excludeInScope({ kind: 'alias', folder, alias }, accountIds, opts);
  }

  /** The shared body of {@link excludeInFolder} and {@link excludeInAlias}. */
  private async excludeInScope(
    target: RuleScopeRef,
    accountIds: readonly string[],
    opts: { force?: boolean; label?: string },
  ): Promise<ExcludeResult> {
    this.refuseRuleSlotsOnDarwin();
    const scope = this.canonicalizeEditScope(target);
    const requestedIds = this.requireAccountIds(accountIds, 'exclude');
    const label = opts.label !== undefined ? { label: opts.label } : {};
    await this.vault.readStoredTokens().catch(() => undefined);
    return this.withCredentialLock(async () => {
      const requested = await this.resolveRequested(requestedIds);
      await this.settleForAccountsLocked(requestedIds);
      const picture = await this.vault.readPicture();
      const existing = this.exactScopeRule(scope, picture.rules);
      if (existing) {
        await this.vault.checkExclude(existing.id, requestedIds);
        // Refused here, not after the rule write: ensure-live writes this slot (see include).
        await this.requireSettledLocked(this.slotRuntime(ruleSlotId(existing.id)));
      } else {
        await this.vault.checkCreateRule({
          ...newRuleScope(scope),
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
            ...newRuleScope(scope),
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
          runningSessions.length > 0 ? runningSessions : await this.runningSessionsInRule(rule),
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
    return this.resetScope({ kind: 'folder', folder }, accountIds, opts);
  }

  /** {@link resetFolder} for the rule of a session alias in one exact folder (see
   *  {@link includeInAlias}): drop named accounts from it, or remove it entirely. */
  async resetAlias(
    folder: string,
    alias: string,
    accountIds?: readonly string[],
    opts: { force?: boolean } = {},
  ): Promise<ResetResult> {
    return this.resetScope({ kind: 'alias', folder, alias }, accountIds, opts);
  }

  /** The shared body of {@link resetFolder} and {@link resetAlias}. */
  private async resetScope(
    target: RuleScopeRef,
    accountIds: readonly string[] | undefined,
    opts: { force?: boolean },
  ): Promise<ResetResult> {
    // The folder may since have been deleted, but its rule still needs clearing.
    const resolved = this.canonicalizeBindFolder(target.folder, { mustExist: false });
    // The folder as spelled, canonicalized WITHOUT resolving links. A ruled folder that was moved and
    // replaced by a link to its new home resolves to the new home, where no rule is, while the rule
    // still names the old path: this spelling is how that rule can still be found and removed.
    const spelled = canonicalizeFolder(target.folder, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
    });
    const requestedIds =
      accountIds === undefined ? undefined : this.requireAccountIds(accountIds, 'reset');
    return this.withCredentialLock(async () => {
      const picture = await this.vault.readPicture();
      const at = (folder: string): RuleScopeRef => ({ ...target, folder });
      let scope = at(resolved);
      let rule = this.exactScopeRule(scope, picture.rules);
      if (rule === undefined && spelled.ok && spelled.path !== resolved) {
        rule = this.exactScopeRule(at(spelled.path), picture.rules);
        if (rule !== undefined) scope = at(spelled.path);
      }
      if (rule === undefined) {
        throw new RefreshError(
          scope.kind === 'folder'
            ? `"${scope.folder}" has no folder rule`
            : `${describeScope(scope)} has no rule`,
          'not_ruled',
        );
      }
      // Report the scope as the rule STORED it — the operator may have typed another case, spacing
      // or separator spelling.
      scope = this.storedScope(rule, scope);
      const reported = {
        folder: scope.folder,
        ...(scope.kind === 'alias' ? { alias: scope.alias } : {}),
      };
      const force = opts.force === true;

      if (requestedIds === undefined) {
        if (ruleScopeCount(rule) > 1) {
          // One of several scopes leaves; the rule and its live slot stay intact.
          const updated =
            scope.kind === 'folder'
              ? await this.vault.removeFolderFromRule(rule.id, scope.folder)
              : await this.vault.removeAliasFromRule(rule.id, {
                  folder: scope.folder,
                  alias: scope.alias,
                });
          await this.writeSnapshotLocked();
          return {
            ...reported,
            dissolved: false,
            rule: updated,
            released: [],
            adoptedRotation: false,
            runningSessions: [],
          };
        }
        return { ...(await this.dissolveRuleLocked(rule, scope, force)), ...reported };
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
        return { ...(await this.dissolveRuleLocked(rule, scope, force)), ...reported };
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
        ...reported,
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
    scope: RuleScopeRef,
    force: boolean,
  ): Promise<ResetResult> {
    const runningSessions = await this.runningSessionsInRule(rule);
    if (runningSessions.length > 0 && !force) {
      throw new RefreshError(
        `${describeScope(scope)} (${describeRule(rule)}) has ${runningSessions.length} running ` +
          `session(s) under it${unidentifiedNote(runningSessions)}; exit them or rerun with --force`,
        'sessions_running',
      );
    }
    const torn = await this.teardownRuleSlotLocked(rule, { lease: false });
    return {
      folder: scope.folder,
      dissolved: true,
      released: torn.releasedIds,
      adoptedRotation: torn.adoptedRotation,
      runningSessions,
    };
  }

  /**
   * Take a rule's slot down and remove the rule, in the order that never costs an account its latest
   * token: settle the slot, adopt its rotation, clear its live login and its recovery state, then
   * remove the rule (one write, which also returns its accounts to the shared pool), then write the
   * snapshot. Dying anywhere leaves the rule standing over a slot that is at worst empty, which the
   * next teardown or seat converges from.
   *
   * One difference by kind. A folder or alias rule's slot whose switch cannot be settled is cleared
   * anyway without adopting (its dissolve retires that switch). A parallel session's slot is not:
   * there the live login is the only copy of a token a session may have rotated for hours, so nothing
   * is written and the result says `slot_untrusted`; the sweep retries it. For the same reason a
   * parallel session's slot whose login could not be adopted is kept (`login_unadopted`).
   */
  private async teardownRuleSlotLocked(
    rule: FolderRule,
    opts: { lease: boolean },
  ): Promise<{
    released: boolean;
    adoptedRotation: boolean;
    releasedIds: string[];
    deferred?: LeaseDeferReason;
  }> {
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    const untrusted = (await this.settleSlotsLocked([slotId])).has(slotId);
    if (untrusted && opts.lease) {
      return {
        released: false,
        adoptedRotation: false,
        releasedIds: [],
        deferred: 'slot_untrusted',
      };
    }
    const adoptedRotation = untrusted ? false : await this.adoptSlotRotation(rt);
    // A parallel session's slot whose login could not be adopted (unreadable, naming no account,
    // or refused) is not cleared: that login may be the only copy of a token the session rotated.
    // A re-login of the account rewrites the slot with a stored token, which the next sweep ends.
    if (opts.lease && (await this.slotHoldsUnstoredLogin(rt))) {
      this.log.warn(
        { ruleId: rule.id },
        `the parallel session of ${rule.label} holds a login that could not be adopted; it is ` +
          `kept until it can be (cctl accounts relogin ${rule.label} rewrites it)`,
      );
      return {
        released: false,
        adoptedRotation: false,
        releasedIds: [],
        deferred: 'login_unadopted',
      };
    }
    this.fault(opts.lease ? 'lease:after-adopt' : 'reset:after-adopt');

    await this.clearSlotLive(rt);
    await this.clearSlotState(rt);
    this.fault(opts.lease ? 'lease:after-clear' : 'reset:after-clear-live');

    const { released } = await this.vault.removeRule(rule.id);
    if (!opts.lease) this.fault('reset:after-release');

    await this.writeSnapshotLocked();
    return { released: true, adoptedRotation, releasedIds: released };
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
   * What it seats is {@link chooseSeat}'s choice: the account live there is KEPT when the slot may
   * hold it and it is live in no other slot (only a drifted `activeId` is healed then), except that
   * a quarantined occupant is replaced by any available account (kept only when none is, reported
   * as `noWorkingAccount`, since a dead login is no working account), and `preferIncluded` moves an
   * inherited occupant aside for an available included account (any one, or one of a set).
   * Otherwise the slot is seated with the first account available in pool order, the recorded
   * `activeId` first for continuity. Usage-based choice is the daemon's; this is the engine's
   * usable default. When nothing can be seated, a login that does not belong (outside the pool, live
   * in another slot too, or unrecognized) is cleared after its rotation is adopted, failing the slot
   * closed, and the rule's recorded account is cleared with it: a record naming an account the slot
   * no longer holds would have every reader that falls back on it (who is live, which profile an
   * account's session runs in) place that account in an empty slot. The rule still stands, and the
   * result says the folder has no working account.
   *
   * `guard` is an import's: the seat it decided on for this slot (`move`, undefined when it decided
   * the slot keeps what it holds), and the rule as it stood before the import wrote it, whose scopes
   * are the ones running on this slot now. While sessions run there, a slot holding a login is then
   * moved only by exactly that move and never cleared; when that move cannot be made, the slot is
   * left as it was and the result says so (`heldForSessions`), rather than moved somewhere no report
   * named. `renew` keeps the caller's lock claimed between the accounts it tries. `occupancy` is
   * who is live in every slot, for a caller seating rule after rule that keeps it up to date itself
   * (a seat changes only its own slot), so it is not read again for each.
   */
  private async ensureRuleLiveLocked(
    rule: FolderRule,
    opts: {
      preferIncluded?: true | ReadonlySet<string>;
      keepOut?: ReadonlySet<string>;
      avoid?: ReadonlySet<string>;
      renew?: () => void;
      guard?: { move: SlotSeat | undefined; rule: FolderRule };
      occupancy?: ReadonlyMap<SlotId, ReadonlySet<string>>;
    } = {},
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
    // A parallel session is pinned to its account and seated only by its own claim: nothing here
    // seats, replaces or clears it. A record that drifted from the account live there is healed, as a
    // kept occupant's is below; another account found there is the repair's (repairLeaseSlotLocked).
    if (isLeaseRule(current)) return this.leaseLiveResult(rt, current, picture);
    const occupancy = opts.occupancy ?? (await this.slotOccupancy(picture));
    const live = await this.activeIdIn(slotId, picture);
    const liveCreds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const choice = chooseSeat(
      slotId,
      picture,
      occupancy,
      { id: live, hasLogin: liveCreds !== undefined },
      {
        ...(opts.preferIncluded !== undefined ? { prefer: opts.preferIncluded } : {}),
        ...(opts.keepOut !== undefined ? { keepOut: opts.keepOut } : {}),
        ...(opts.avoid !== undefined ? { avoid: opts.avoid } : {}),
      },
    );
    const seated = (liveAccount: string, activated: boolean): RuleLiveResult => ({
      ruleId: rule.id,
      liveAccount,
      activated,
      noWorkingAccount: false,
    });

    // An import's seat step on a slot holding a login that sessions run under: only the move the
    // import decided on, and never a clear. Looked at only when the seat would change the slot.
    let candidates = choice.candidates;
    let sessions = 0;
    if (
      opts.guard !== undefined &&
      liveCreds !== undefined &&
      (candidates.length > 0 || choice.keeps === null)
    ) {
      sessions = (await this.runningSessionsInRule(opts.guard.rule)).length;
      if (sessions > 0) {
        const move = opts.guard.move;
        const planned = move !== undefined && move.from === live ? move.to : undefined;
        candidates = candidates.filter((a) => a.id === planned);
      }
    }
    // The slot is left as it was for its sessions when the seat would have moved it (or cleared it)
    // and the one move the import decided on, if any, could not be made.
    const held = sessions > 0 ? { heldForSessions: sessions } : {};

    if (choice.keeps !== null) {
      const moved = await this.seatFirst(
        rt,
        candidates,
        'moving the folder slot to a better account',
        opts.renew,
        opts.occupancy,
      );
      if (moved !== null) return seated(moved, true);
      // The live account stays. If the registry drifted from it (an external /login), commit it: adopt
      // its rotation, then record it. Not a switch — nothing live changes, and a switch's candidacy
      // checks every copy, so a squatter's copy elsewhere (the one judged irrelevant above, which its
      // own slot's repair evicts) would refuse the very account just kept.
      if (current.activeId !== choice.keeps) {
        opts.renew?.();
        await this.adoptSlotRotation(rt);
        await this.vault.setRuleActive(rule.id, choice.keeps);
      }
      // A quarantined account kept for want of any other is live, but not working.
      const working = slotPool(slotId, picture, occupancy).some(
        (e) => e.account.id === choice.keeps,
      );
      return {
        ...seated(choice.keeps, false),
        noWorkingAccount: !working,
        ...(choice.candidates.length > 0 ? held : {}),
      };
    }

    // Nothing legitimate is live: seat the recorded account first (continuity), then pool order.
    const filled = await this.seatFirst(
      rt,
      candidates,
      'ensuring the folder slot has a live account',
      opts.renew,
      opts.occupancy,
    );
    if (filled !== null) return seated(filled, true);
    if (sessions > 0) {
      // Sessions run on this login, and no move the import decided on could be made: leave it.
      return {
        ruleId: rule.id,
        liveAccount: live,
        activated: false,
        noWorkingAccount: true,
        ...held,
      };
    }

    // Nothing could be seated. Credentials still in the profile belong to an account the slot may not
    // hold, one live in another slot too, or an unrecognized login: a legitimate occupant would have
    // been kept above. Fail the slot closed rather than let a session in the folder run as an account
    // it may not use — but adopt the occupant's rotation first, so clearing costs it nothing.
    let clearedSquatter = false;
    if (liveCreds !== undefined) {
      opts.renew?.();
      await this.clearSlotLoginLocked(rt);
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
   *  changed) must not stop the next; a process that died mid-activation does not go on. `renew`
   *  restamps the caller's lock before each account, since each may refresh over the network.
   *  `occupancy` is who is live in every other slot, when the caller has read it under its hold. */
  private async seatFirst(
    rt: SlotRuntime,
    candidates: readonly StoredAccount[],
    reason: string,
    renew?: () => void,
    occupancy?: ReadonlyMap<SlotId, ReadonlySet<string>>,
  ): Promise<string | null> {
    for (const account of candidates) {
      renew?.();
      try {
        await this.activateInSlot(
          rt,
          account.id,
          { force: true, origin: 'recovery', reason },
          undefined,
          occupancy,
        );
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
    const plan = await this.planHandOffLocked(reserving, picture, (slotId) => slotId === ownSlot);
    if (!plan.ok) throw plan.error;
    const moves = await this.executeHandOffLocked(plan.steps);
    if (moves.stopped !== undefined) throw moves.stopped;
    if (moves.failed !== undefined) throw moves.failed.error;
    return moves.made;
  }

  /** Choose every hand-off {@link handOffLocked} would make, moving nothing: each slot that holds an
   *  account being reserved and may not keep it (`mayKeep` says which slot may keep which account),
   *  and the account it would move to. When some slot is left with none, says which account it is
   *  stuck on, with the refusal. Who is live where is read from the slots unless the caller passes
   *  what it already read (`occupancy`). A slot's replacements come from its pool once the accounts
   *  are reserved, or, for a caller that writes more than the reservations (an import batch), from
   *  the registry as it will leave it (`after`); `avoid` names accounts a slot could not be moved
   *  onto just now, and why, which are no replacement. An account another slot of the plan moves off
   *  is a replacement too (a grown rule's slot can take the account the batch newly includes in it
   *  from the slot that has to leave it); the moves then come in the order that frees it first. */
  private async planHandOffLocked(
    reserving: readonly StoredAccount[],
    picture: RegistryPicture,
    mayKeep: (slotId: SlotId, accountId: string) => boolean,
    keepOut?: ReadonlySet<string>,
    occupancy?: Map<SlotId, Set<string>>,
    leaves: { after?: RulesPicture; avoid?: ReadonlyMap<string, string> } = {},
  ): Promise<HandOffPlan> {
    if (reserving.length === 0) return { ok: true, steps: [] };
    const ids = new Set(reserving.map((a) => a.id));
    const after: RulesPicture = leaves.after ?? {
      shared: picture.shared.filter((a) => !ids.has(a.id)),
      reserved: [...picture.reserved, ...reserving],
      rules: picture.rules,
    };
    const live = occupancy ?? (await this.slotOccupancy(picture));
    const moving: Array<{ slotId: SlotId; from: StoredAccount }> = [];
    for (const [slotId, owners] of live) {
      if (isLeaseSlot(slotId, picture.rules)) continue;
      const from = reserving.find((a) => owners.has(a.id) && !mayKeep(slotId, a.id));
      if (from !== undefined) moving.push({ slotId, from });
    }
    /** Each moving slot's replacements, best first, with the slots holding `held` taken. */
    const assign = (
      held: ReadonlyMap<SlotId, ReadonlySet<string>>,
    ): ReturnType<typeof assignDistinct> =>
      assignDistinct(
        moving.map((m) =>
          availableInOrder(withoutKeptOut(slotPool(m.slotId, after, held), keepOut))
            .filter((a) => leaves.avoid?.has(a.id) !== true)
            .map((a) => a.id),
        ),
      );
    const leaving = new Map(moving.map((m) => [m.slotId, m.from.id]));
    const freed = new Map(
      [...live].map(([slotId, owners]) => [
        slotId,
        new Set([...owners].filter((id) => id !== leaving.get(slotId))),
      ]),
    );
    const steps = (
      chosen: readonly string[],
    ): Array<{
      slotId: SlotId;
      from: StoredAccount;
      to: string;
    }> => moving.map((m, i) => ({ slotId: m.slotId, from: m.from, to: chosen[i]! }));
    const withFreed = assign(freed);
    if (withFreed.ok) {
      const ordered = orderedMoves(steps(withFreed.chosen));
      if (ordered !== undefined) return { ok: true, steps: ordered };
    }
    // No order frees what the freed accounts' takers need (slots trading accounts), or nothing
    // fits even with them: choose among accounts no slot holds.
    const assigned = withFreed.ok ? assign(live) : withFreed;
    if (!assigned.ok) {
      const short = moving[assigned.unserved]!;
      return {
        ok: false,
        slotId: short.slotId,
        from: short.from,
        error: this.noReplacementError(short.slotId, short.from, picture, leaves.avoid),
      };
    }
    return { ok: true, steps: steps(assigned.chosen) };
  }

  /**
   * Make the moves {@link planHandOffLocked} or {@link planImportMovesLocked} chose, in order: each
   * slot switched to its account, or cleared (`to` null, only ever a rule's slot) after its
   * rotation is adopted. A move that fails (the account's token will not refresh, its stored tokens
   * cannot be read) is undone in its own slot by the switch, and stops the rest: the moves already
   * made are returned with the one that failed, so the caller reports every slot that moved and
   * decides what to do about the rest. A failure after which nothing more may run (the lock taken
   * over, or a switch that committed and then failed in its bookkeeping) is returned as `stopped`,
   * with every move made, that one included when it did move the slot. `renew` keeps the lock
   * claimed between moves. A step's `reason` is what the switch log records for it (by default,
   * freeing the slot for an include). The account a slot moves off is named to the switch
   * (`outgoing`), so its rotation is adopted even where the slot no longer recognizes it.
   * `occupancy`, when the caller passes who is live in every slot, is what each switch goes by, and
   * is kept up to date move by move (a move changes only its own slot).
   */
  private async executeHandOffLocked<To extends string | null, From extends string | null>(
    plan: ReadonlyArray<{ slotId: SlotId; from: { id: From }; to: To; reason?: string }>,
    renew?: () => void,
    occupancy?: Map<SlotId, Set<string>>,
  ): Promise<{
    made: Array<{ slot: SlotId; from: From; to: To }>;
    failed?: { slot: SlotId; to: To; error: SwitchEngineError };
    stopped?: Error;
  }> {
    // A slot whose switch is stuck would refuse its move only after the slots before it had moved.
    for (const step of plan) await this.requireSettledLocked(this.slotRuntime(step.slotId));
    const made: Array<{ slot: SlotId; from: From; to: To }> = [];
    for (const step of plan) {
      const rt = this.slotRuntime(step.slotId);
      try {
        renew?.();
        if (step.to === null) {
          await this.clearSlotLoginLocked(rt, step.from.id ?? undefined);
          if (rt.ruleId !== undefined) await this.vault.setRuleActive(rt.ruleId, null);
          made.push({ slot: step.slotId, from: step.from.id, to: step.to });
          occupancy?.set(step.slotId, new Set());
          continue;
        }
        // A deliberate operator move: forced past the cadence guard (an include should never be
        // blocked by a recent hop), and the outgoing account's rotation is adopted by the switch.
        await this.activateInSlot(
          rt,
          step.to,
          {
            force: true,
            origin: 'manual',
            reason: step.reason ?? 'freeing the slot for a folder include',
          },
          step.from.id ?? undefined,
          occupancy,
        );
        made.push({ slot: step.slotId, from: step.from.id, to: step.to });
        occupancy?.set(step.slotId, await this.possibleLiveOwners(step.slotId));
      } catch (err) {
        if (this.isSimulatedDeath(err)) throw err;
        const now = await this.getActiveId(step.slotId).catch(() => null);
        const moved = step.to !== null && now === step.to;
        if (moved) made.push({ slot: step.slotId, from: step.from.id, to: step.to });
        if (moved || (err instanceof SwitchEngineError && err.code === 'lock_lost')) {
          return { made, stopped: err instanceof Error ? err : new Error(String(err)) };
        }
        const error =
          err instanceof SwitchEngineError
            ? err
            : new SwitchEngineError(errorReason(err), 'switch_failed', { cause: err });
        return { made, failed: { slot: step.slotId, to: step.to, error } };
      }
    }
    return { made };
  }

  /** The refusal of an include that would leave a slot holding a newly reserved account with no
   *  other account to move to. The global slot keeps its historical code. */
  private noReplacementError(
    slotId: SlotId,
    from: { label: string },
    picture: RulesPicture,
    avoid?: ReadonlyMap<string, string>,
    after: RulesPicture = picture,
  ): RefreshError {
    // Accounts the slot could have moved to (as the rules will stand, `after`) but could not be
    // switched to just now, and why.
    const labelOf = (id: string): string =>
      [...picture.shared, ...picture.reserved].find((a) => a.id === id)?.label ?? id;
    const failed = [...(avoid ?? [])]
      .filter(([id]) => slotMayHold(slotId, id, after))
      .map(([id, why]) => `"${labelOf(id)}" (${why})`);
    const note = failed.length > 0 ? `; it could not be switched to ${failed.join(', ')}` : '';
    const ruleId = ruleIdOfSlot(slotId);
    if (ruleId === undefined) {
      return new RefreshError(
        `cannot include "${from.label}": it is the only usable shared account, so reserving it ` +
          `would leave the global slot with none${note}`,
        'no_shared_account_remains',
      );
    }
    return new RefreshError(
      `cannot include "${from.label}": it is live in ${slotPhrase(slotId, picture.rules)}, and ` +
        `that folder has no other account to switch to${note}`,
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
    const sessions = await this.runningSessionsInRule(rule);
    if (sessions.length > 0 && !force) {
      throw emptyingRefusal(rule, sessions, what, 'exit them or rerun with --force');
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
      // A parallel session's slot is never re-seated by a repair: it holds the one account its
      // terminal chose (see repairLeaseSlotLocked for another account found there).
      const leaseSlots = new Set(picture.rules.filter(isLeaseRule).map((r) => ruleSlotId(r.id)));
      for (const slotId of slotIds) {
        if (leaseSlots.has(slotId)) continue;
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
        if (isLeaseRule(rule)) {
          await perSlot(slotId, () => this.repairLeaseSlotLocked(rule, actions));
          continue;
        }
        await perSlot(slotId, async () => {
          const res = await this.ensureRuleLiveLocked(rule);
          if (res.activated) actions.push(`re-seated ${slotWordsOf(rule)}`);
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
        if (leaseSlots.has(slotId)) continue;
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
    const slotLabel = (slotId: SlotId): string => slotPhrase(slotId, rules);

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
          const why = isLeaseRule(rule)
            ? 'which is not the account that parallel session runs'
            : rule.exclude.includes(phys.id)
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
          detail: `${slotWordsOf(rule)} has broken profile links: ${broken.join(', ')}`,
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
    const rule = ruleOfSlot(rt.id, picture.rules);
    const where = slotPhrase(rt.id, picture.rules);
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

  // ---- parallel sessions (`cctl claude --account`) ----
  //
  // A parallel session is a rule with a `lease`: no folders, no aliases, one included account, the
  // id `session-<account>`. Being a rule gives it a slot, a profile, adopt-only refresh while live,
  // reservation out of the shared pool and every invariant check for free; the lease adds who holds
  // it. It is held by processes (the launcher and its Claude Code), never empty on disk, and ended
  // by one removal of its rule after its slot's rotation is adopted and its login cleared.

  /**
   * Where `cctl claude --account <id>` would run, read without the lock and without side effects.
   * `launchRuleId` is the rule the launch runs under in this folder (THE precedence rule), or null.
   * The claim decides again under the lock with the same function, so the two agree on every state.
   */
  async planSessionSlot(
    accountId: string,
    context: { launchRuleId: string | null },
  ): Promise<SessionSlotPlan> {
    const picture = await this.vault.readPicture();
    const live = await this.liveSlots();
    const seated = await this.leaseSeated(accountId, picture.rules);
    return this.decideSessionSlot(accountId, context.launchRuleId, picture, live, seated);
  }

  /**
   * Claim the slot `cctl claude --account <id>` runs in, under the credential lock, deciding again
   * there exactly as {@link planSessionSlot} does. Live in the global slot or in a rule slot the
   * launch may use: nothing is claimed (`global` / `rule`). Otherwise a parallel session is joined
   * (its slot seated first when it is empty or torn) or created with `holder` as its first holder;
   * a creation that fails part-way is torn down before the error is rethrown. Refusals are typed:
   * {@link QuarantineError}, {@link SessionSlotError}, {@link LeaseHolderCapError}, a
   * `session_slot_unsupported` {@link RefreshError} on macOS.
   */
  async claimSessionSlot(
    accountId: string,
    holder: LeaseHolder,
    opts: { launchRuleId: string | null },
  ): Promise<SessionSlotClaim> {
    // A join reports who else is on the session. On Windows only the process table tells a holder
    // from a later process that took over its pid, so it is read here, before the lock, when there
    // is a session to join.
    const joining =
      this.platform === 'win32' &&
      leaseRuleOf(accountId, await this.vault.listRules().catch(() => [])) !== undefined;
    const joinEvidence = joining ? await this.holderEvidence('full', {}) : undefined;
    return this.withCredentialLock(async () => {
      // A switch to or from this account must be settled before anything reads where it is live.
      await this.settleForAccountsLocked([accountId]);
      const before = await this.vault.readPicture();
      const existing = leaseRuleOf(accountId, before.rules);
      if (existing !== undefined) {
        const attempt = await this.attemptSettleLocked(ruleSlotId(existing.id));
        if (attempt.kind === 'unsettled') {
          throw new SessionSlotError(
            `${slotWordsOf(existing)} has an unfinished change that cannot be settled ` +
              `(${errorReason(attempt.error)}); run cctl doctor.`,
            'lease_unsettled',
          );
        }
      }
      const picture = await this.vault.readPicture();
      const live = await this.liveSlots();
      const seated = await this.leaseSeated(accountId, picture.rules);
      const plan = this.decideSessionSlot(accountId, opts.launchRuleId, picture, live, seated);
      switch (plan.kind) {
        case 'global':
          return { kind: 'global' };
        case 'rule':
          return { kind: 'rule', ruleId: plan.ruleId };
        case 'refused':
          throw this.sessionSlotRefusal(plan);
        case 'lease': {
          const rule = leaseRuleOf(accountId, picture.rules);
          return rule !== undefined
            ? this.joinLeaseLocked(rule, holder, seated, joinEvidence)
            : this.createLeaseLocked(accountId, holder, picture);
        }
      }
    });
  }

  /**
   * Record more holders of a parallel session (the launcher's Claude Code child, once spawned). A
   * record on the same process slot is replaced, never duplicated. A session that has ended is left
   * alone. Past the holder cap, {@link LeaseHolderCapError} and nothing is written.
   */
  async addLeaseHolders(ruleId: string, holders: readonly LeaseHolder[]): Promise<void> {
    await this.withCredentialLock(async () => {
      const rule = await this.vault.getRule(ruleId);
      if (rule === undefined || !isLeaseRule(rule)) return;
      const next = withHolders(rule.lease.holders, holders);
      if (next.length > MAX_LEASE_HOLDERS) {
        throw new LeaseHolderCapError(
          `the parallel session of ${rule.label} already records ${rule.lease.holders.length} ` +
            'processes, as many as it may',
          MAX_LEASE_HOLDERS,
        );
      }
      await this.vault.setLeaseHolders(ruleId, next);
      await this.writeSnapshotLocked();
    });
  }

  /**
   * Remove this terminal's holders from its parallel session, and any other holder that is provably
   * gone (judged without a process query: kill-0 on Windows, `/proc` on Linux; this terminal's own
   * are known to be leaving and need no check). So a terminal leaving while another runs reads no
   * process table at all, and one leaving after the others died needs no daemon. When none would
   * remain, end the session (its rotation adopted, its login cleared, the account back in the pool)
   * — unless something still runs on its profile, which then holds it: a Claude Code the session
   * started that outlived it (a backgrounded `claude -p`, a detached helper), found the way a full
   * sweep finds one (see {@link unrecordedProcesses}), or the background service's workers. The
   * roster is read before the lock, and so is the process evidence when this release looks like the
   * last one out. A Claude Code still on the profile holds the session whatever else could not be
   * read. Anything that leaves the question open (an unreadable roster or process table, a slot
   * whose switch cannot be settled, a login that could not be adopted) writes nothing: departing
   * holders stay on disk, dead after this exit, and the next sweep decides with fresh evidence.
   * Never writes an empty holder list.
   */
  async releaseLease(
    ruleId: string,
    holders: readonly LeaseHolder[],
    probe: LeaseOccupancyProbe,
  ): Promise<LeaseRelease> {
    const profileDir = this.configDirForSlot(ruleSlotId(ruleId))!;
    // Undefined: the roster read failed outright, which decides nothing either.
    const workers = await probe(profileDir, { verify: false }).catch(() => undefined);
    // The holders that stay: every other one not provably gone. A doubt keeps it.
    const quick = await this.holderEvidence('quick', {});
    const others = (all: readonly LeaseHolder[]): LeaseHolder[] =>
      withoutHolders(all, holders).filter((h) => holderState(h, quick) !== 'dead');
    // The process evidence a last holder out needs (on Windows the one process query a clean exit
    // makes: a Claude Code the session left running would otherwise lose its login), read without
    // the lock when this release is the last one by the rules on disk now; a concurrent release that
    // leaves this one last reads it under the lock instead.
    const before = await this.vault.getRule(ruleId).catch(() => undefined);
    const lastOut =
      before !== undefined && isLeaseRule(before) && others(before.lease.holders).length === 0;
    let found = lastOut ? await this.processEvidence('full', {}) : undefined;
    return this.withCredentialLock(async () => {
      const nothing: LeaseRelease = {
        ended: false,
        adoptedRotation: false,
        remaining: 0,
        deferredToBackground: false,
      };
      const rule = await this.vault.getRule(ruleId);
      if (rule === undefined || !isLeaseRule(rule)) return nothing;
      const remaining = others(rule.lease.holders);
      if (remaining.length > 0) {
        if (remaining.length !== rule.lease.holders.length) {
          await this.vault.setLeaseHolders(ruleId, remaining);
          await this.writeSnapshotLocked();
        }
        return { ...nothing, remaining: remaining.length };
      }
      found ??= await this.processEvidence('full', {});
      const left = this.unrecordedProcesses(rule, found.evidence, found.env);
      const roster = Array.isArray(workers) ? workers : [];
      // A Claude Code still running on the profile holds it first: whatever else could not be read,
      // the session cannot end while it runs, so this terminal can say exactly what holds it.
      if (left !== 'unreadable' && left.length > 0) {
        const kept = withHolders(left, roster).slice(0, MAX_LEASE_HOLDERS);
        await this.vault.setLeaseHolders(ruleId, kept);
        await this.writeSnapshotLocked();
        const pids = left.map((h) => h.pid).filter((pid) => kept.some((h) => h.pid === pid));
        this.log.info(
          { ruleId, pids },
          `parallel session of ${rule.label}: its terminals exited, but process(es) ` +
            `${pids.join(', ')} still run on its profile; now holding it`,
        );
        return {
          ...nothing,
          remaining: kept.length,
          deferredToBackground: roster.length > 0,
          heldBy: pids,
        };
      }
      if (workers === undefined) return { ...nothing, deferred: 'no_probe' };
      if (workers === 'unreadable') return { ...nothing, deferred: 'roster_unreadable' };
      if (workers.length > 0) {
        await this.vault.setLeaseHolders(ruleId, withHolders([], workers));
        await this.writeSnapshotLocked();
        return { ...nothing, remaining: workers.length, deferredToBackground: true };
      }
      if (left === 'unreadable') return { ...nothing, deferred: 'processes_unreadable' };
      const torn = await this.teardownRuleSlotLocked(rule, { lease: true });
      if (!torn.released)
        return { ...nothing, ...(torn.deferred ? { deferred: torn.deferred } : {}) };
      this.log.info(
        { ruleId, adoptedRotation: torn.adoptedRotation },
        `ended parallel session of ${rule.label} (its terminals exited)`,
      );
      return { ...nothing, ended: true, adoptedRotation: torn.adoptedRotation };
    });
  }

  /**
   * Drop the holders of parallel sessions whose processes are gone, record processes found running on
   * a session's profile that no holder records, and end the sessions left with none. Two passes:
   * everything that needs a process query or a roster read runs first without the lock; then, under
   * it, each session is re-read and written at most once. A process judged dead stays dead, so a
   * holder added between the passes (not in the dead set) survives. A session reaching no holder is
   * ended only on positive evidence that nothing runs on its profile, in either mode: the processes
   * found there (Linux: by environment, a file read; Windows: the live descendants of its holders in
   * the process table, which a quick sweep reads only once a session's holders are all gone), its
   * roster, and its slot's switch. A process table or roster that cannot be read, or a slot that
   * cannot be settled, defers the end. One session failing never stops the sweep of the others.
   */
  async sweepLeases(opts: LeaseSweepOptions): Promise<LeaseSweepReport> {
    const report: LeaseSweepReport = {
      droppedHolders: 0,
      adoptedHolders: 0,
      ended: [],
      deferred: [],
      adopted: [],
    };
    const leases = (await this.vault.listRules()).filter(
      (r): r is FolderRule & { lease: SessionLease } =>
        isLeaseRule(r) && (opts.only === undefined || r.include[0] === opts.only),
    );
    if (leases.length === 0) return report;

    // First pass, without the lock.
    const evidence = await this.holderEvidence(opts.mode, opts);
    // Windows: the environments of the Claude Code processes running, read once and only when a
    // session's holders are all gone.
    let env: ReadonlyMap<number, string | null> | undefined;
    let envRead = false;
    // `probe` undefined: the roster read itself failed, so there is no result to decide on.
    const judged = new Map<
      string,
      {
        dead: LeaseHolder[];
        adopted: LeaseHolder[] | 'unreadable';
        probe: LeaseHolder[] | 'unreadable' | undefined;
      }
    >();
    // A quick sweep reads the Windows process table only when it is about to decide that a session
    // has no process left, and then once for all of them.
    let tableRead = opts.mode === 'full';
    for (const rule of leases) {
      const profileDir = this.configDirForSlot(ruleSlotId(rule.id))!;
      const probe = await opts
        .probe(profileDir, { verify: opts.mode === 'full' })
        .catch(() => undefined);
      // A background holder is one of the workers the profile's service hosts: once a roster that
      // could be read no longer lists it as that same process, it is gone, whatever its pid runs
      // now (a pid reused, a worker that exited and was not reaped yet).
      const dead = rule.lease.holders.filter(
        (h) =>
          holderState(h, evidence) === 'dead' ||
          (h.role === 'background' && Array.isArray(probe) && !probe.some((w) => sameHolder(w, h))),
      );
      const allGone = dead.length === rule.lease.holders.length;
      if (allGone && !tableRead && this.platform === 'win32') {
        tableRead = true;
        evidence.table = await this.readTable(opts);
      }
      if (allGone && !envRead) {
        envRead = true;
        env = await this.profileEnvironments(evidence, opts);
      }
      const adopted = allGone ? this.unrecordedProcesses(rule, evidence, env) : [];
      judged.set(rule.id, { dead, adopted, probe });
    }

    // Second pass, under the lock: re-read each session, decide in memory, write at most once. Each
    // session is decided on its own: one whose teardown throws (a profile file another process left
    // torn, a rules write refused) is deferred and logged, and the sweep goes on to the next.
    await this.withCredentialLock(async () => {
      let changed = false;
      for (const seen of leases) {
        try {
          if (await this.sweepOneLeaseLocked(seen.id, judged.get(seen.id), report)) changed = true;
        } catch (err) {
          if (this.isSimulatedDeath(err)) throw err;
          this.log.warn(
            { ruleId: seen.id, err: errorReason(err) },
            `could not end the parallel session of ${seen.label}: ${errorReason(err)}`,
          );
          report.deferred.push({
            accountId: seen.include[0]!,
            label: seen.label,
            reason: 'teardown_failed',
          });
        }
      }
      if (changed) await this.writeSnapshotLocked();
    });
    return report;
  }

  /** One session of {@link sweepLeases}'s second pass, under the lock: drop its dead holders, record
   *  the processes found on its profile, or end it. Returns whether it wrote holders (the snapshot
   *  is then rewritten once for the whole pass). */
  private async sweepOneLeaseLocked(
    ruleId: string,
    facts:
      | {
          dead: LeaseHolder[];
          adopted: LeaseHolder[] | 'unreadable';
          probe: LeaseHolder[] | 'unreadable' | undefined;
        }
      | undefined,
    report: LeaseSweepReport,
  ): Promise<boolean> {
    const rule = await this.vault.getRule(ruleId);
    if (rule === undefined || !isLeaseRule(rule)) return false;
    const accountId = rule.include[0]!;
    const recorded = rule.lease.holders;
    const kept = withoutHolders(recorded, facts?.dead ?? []);
    const found = facts?.adopted === 'unreadable' ? [] : (facts?.adopted ?? []);
    const room = Math.max(0, MAX_LEASE_HOLDERS - kept.length);
    const adopted = found.slice(0, room);
    if (found.length > adopted.length) {
      this.log.warn(
        { ruleId: rule.id, dropped: found.length - adopted.length },
        'a parallel session holds as many processes as it may record; the rest are not recorded',
      );
    }
    const next = withHolders(kept, adopted);
    const defer = (reason: LeaseDeferReason): false => {
      report.deferred.push({ accountId, label: rule.label, reason });
      return false;
    };
    if (next.length > 0) {
      if (isDeepStrictEqual(next, recorded)) return false;
      await this.vault.setLeaseHolders(rule.id, next);
      report.droppedHolders += recorded.length - kept.length;
      report.adoptedHolders += adopted.length;
      for (const h of adopted) {
        report.adopted.push({ accountId, label: rule.label, pid: h.pid });
        this.log.info(
          { ruleId: rule.id, pid: h.pid },
          `parallel session of ${rule.label}: found running process ${h.pid} on its profile; now holding it`,
        );
      }
      return true;
    }
    if (facts === undefined || facts.probe === undefined) return defer('no_probe');
    if (facts.adopted === 'unreadable') return defer('processes_unreadable');
    if (facts.probe === 'unreadable') return defer('roster_unreadable');
    if (facts.probe.length > 0) {
      await this.vault.setLeaseHolders(rule.id, withHolders([], facts.probe));
      report.droppedHolders += recorded.length;
      return true;
    }
    const torn = await this.teardownRuleSlotLocked(rule, { lease: true });
    if (!torn.released) return defer(torn.deferred ?? 'slot_untrusted');
    report.droppedHolders += recorded.length;
    report.ended.push({ accountId, label: rule.label, adoptedRotation: torn.adoptedRotation });
    this.log.info(
      { ruleId: rule.id },
      `ended parallel session of ${rule.label} (holders exited); rotation adopted: ` +
        (torn.adoptedRotation ? 'yes' : 'no'),
    );
    return false;
  }

  /** Every parallel session with each holder judged (read-only; `mode` as in {@link sweepLeases}):
   *  what doctor, status and the TUI show. A dead holder whose pid now runs another process is marked
   *  `reused`. */
  async listLeases(opts: { mode: 'quick' | 'full' } = { mode: 'quick' }): Promise<LeaseView[]> {
    const leases = (await this.vault.listRules()).filter(isLeaseRule);
    if (leases.length === 0) return [];
    const evidence = await this.holderEvidence(opts.mode, {});
    let env: ReadonlyMap<number, string | null> | undefined;
    let envRead = false;
    const views: LeaseView[] = [];
    for (const rule of leases) {
      const view = this.leaseView(rule, evidence);
      if (opts.mode !== 'full' || view.holders.some((h) => h.state !== 'dead')) {
        views.push(view);
        continue;
      }
      if (!envRead) {
        envRead = true;
        env = await this.profileEnvironments(evidence, {});
      }
      const found = this.unrecordedProcesses(rule, evidence, env);
      if (found === 'unreadable') {
        views.push({ ...view, processesUnreadable: true });
        continue;
      }
      const unrecorded = found.map((h) => h.pid);
      views.push(unrecorded.length > 0 ? { ...view, unrecorded } : view);
    }
    return views;
  }

  /** The parallel session holding an account, if any (one rules read, a quick judgment of its
   *  holders): what the daemon refuses a spawn or a resume on. */
  async leaseOf(accountId: string): Promise<LeaseView | undefined> {
    const rule = leaseRuleOf(accountId, await this.vault.listRules());
    if (rule === undefined) return undefined;
    return this.leaseView(rule, await this.holderEvidence('quick', {}));
  }

  /**
   * Processes a parallel session's profile is in use by but that no holder records, or
   * `'unreadable'` when the evidence to find them is missing (a process table that could not be
   * read). Only asked once its recorded holders are all gone: while one runs, the session is held
   * anyway. Each is recorded `found` (see {@link LeaseHolder.found}).
   *
   * Only a Claude Code counts (see {@link isClaudeCodeProcess}): it is what reads the profile's
   * login, while a dev server or an editor the session started merely inherited its environment,
   * and keeping the account out of the pool for as long as one of those runs would gain nothing.
   * This process never counts (a cctl run from inside the session inherits its config dir too).
   *
   * Linux: every such process whose environment names the profile.
   *
   * Windows: every such process whose environment names the profile, read from the process itself
   * (`env`, see {@link profileEnvironments}). That needs no parentage, which Windows loses as soon
   * as a process in between exits (a backgrounded `claude -p` whose shell returned). A process whose
   * environment could not be read is judged by the process table instead, keeping the session on
   * any doubt: it counts when it descends from a recorded holder (see
   * {@link descendantsOfHolders}), or when its parent cannot be traced any more (gone, or its pid
   * taken by a later process) and it started after the session did.
   */
  private unrecordedProcesses(
    rule: FolderRule & { lease: SessionLease },
    evidence: HolderEvidence,
    env?: ReadonlyMap<number, string | null>,
  ): LeaseHolder[] | 'unreadable' {
    const host = evidence.host;
    const recorded = new Set(rule.lease.holders.map((h) => h.pid));
    if (this.platform === 'win32') {
      const table = evidence.table;
      if (table === undefined || table.size === 0) return 'unreadable';
      const profileKey = folderKey(
        this.canonReserved(this.configDirForSlot(ruleSlotId(rule.id))!),
        this.platform,
      );
      const tolerance = LEASE_START_TOLERANCE_MS;
      const descendants = this.descendantsOfHolders(rule.lease.holders, table);
      const holderStarts = rule.lease.holders
        .filter((h) => h.platform === 'win32')
        .map((h) => h.start);
      const since = Math.min(rule.lease.startedAtMs, ...holderStarts) - tolerance;
      const found: LeaseHolder[] = [];
      for (const row of table.values()) {
        if (recorded.has(row.pid) || row.pid === process.pid || !evidence.isAlive(row.pid)) {
          continue;
        }
        const identity = claudeCodeIdentity(rowIdentity(row));
        if (identity === 'no') continue;
        let ours: boolean;
        if (env?.has(row.pid) === true) {
          // Its own environment says which profile it reads: nothing else is needed.
          const dir = env.get(row.pid);
          ours =
            typeof dir === 'string' &&
            folderKey(this.canonReserved(dir), this.platform) === profileKey;
        } else {
          const parent = table.get(row.ppid);
          const untraceable = parent === undefined || parent.startMs > row.startMs + tolerance;
          // A descendant keeps the session even when nothing says what it runs. An untraceable
          // process anywhere on the machine does only when it is positively a Claude Code: every
          // process of another user (a service) has a command line that cannot be read.
          ours =
            descendants.has(row.pid) || (identity === 'yes' && untraceable && row.startMs >= since);
        }
        if (!ours) continue;
        found.push({
          pid: row.pid,
          start: row.startMs,
          host,
          platform: 'win32',
          role: 'claude',
          parent: row.ppid,
          found: true,
        });
      }
      return found;
    }
    if (this.platform !== 'linux') return [];
    const fs = evidence.procFs;
    if (fs === undefined) return 'unreadable';
    const profile = this.configDirForSlot(ruleSlotId(rule.id))!;
    const tags = linuxTags(fs);
    return this.processesOnProfile(profile, fs)
      .filter((pid) => !recorded.has(pid) && pid !== process.pid)
      .map((pid) => {
        const stat = fs.stat(pid);
        return {
          pid,
          start: stat?.startTicks ?? 0,
          host,
          platform: 'linux' as const,
          role: 'claude' as const,
          ...(stat !== undefined && stat.ppid > 0 ? { parent: stat.ppid } : {}),
          ...tags,
          found: true as const,
        };
      });
  }

  /**
   * Windows: every pid in the process table that descends from a recorded holder, by the parent ids
   * the table keeps after a parent exits. A child is followed only when it started no earlier than
   * its parent (within the tolerance): a process cannot start before its parent, so an earlier one
   * is the child of a previous owner of that pid. Under a holder whose pid another process took
   * over after it died (the table shows that pid with another start), only children older than the
   * takeover are followed: everything after it is the new owner's. A child whose parent pid was
   * taken over by a process that has itself exited cannot be told from a real one; that is what the
   * environment read (see {@link profileEnvironments}) settles instead.
   */
  private descendantsOfHolders(
    holders: readonly LeaseHolder[],
    table: ReadonlyMap<number, ProcessRow>,
  ): Set<number> {
    const tolerance = LEASE_START_TOLERANCE_MS;
    const children = new Map<number, ProcessRow[]>();
    for (const row of table.values()) {
      children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
    }
    const out = new Set<number>();
    for (const h of holders) {
      if (h.platform !== 'win32') continue;
      const now = table.get(h.pid);
      const reusedAt =
        now !== undefined && Math.abs(now.startMs - h.start) > tolerance ? now.startMs : undefined;
      const queue: Array<{ pid: number; start: number; before?: number }> = [
        { pid: h.pid, start: h.start, ...(reusedAt !== undefined ? { before: reusedAt } : {}) },
      ];
      while (queue.length > 0) {
        const parent = queue.shift()!;
        for (const row of children.get(parent.pid) ?? []) {
          if (row.pid === parent.pid || out.has(row.pid)) continue;
          if (row.startMs < parent.start - tolerance) continue;
          if (parent.before !== undefined && row.startMs >= parent.before) continue;
          out.add(row.pid);
          queue.push({ pid: row.pid, start: row.startMs });
        }
      }
    }
    return out;
  }

  /**
   * Windows: the CLAUDE_CONFIG_DIR every live Claude Code process in the table was started with, the
   * one tie between a process and a parallel session's profile that survives its parent exiting.
   * Read in one query, only when a decision needs it. Undefined when it could not be read at all;
   * a process left out of the answer could not be read. Either is judged by the table instead.
   */
  private async profileEnvironments(
    evidence: HolderEvidence,
    seams: Pick<LeaseSweepOptions, 'processConfigDirs'>,
  ): Promise<ReadonlyMap<number, string | null> | undefined> {
    if (this.platform !== 'win32' || evidence.table === undefined) return undefined;
    const pids = [...evidence.table.values()]
      .filter(
        (row) =>
          row.pid !== process.pid &&
          // One whose command line cannot be read is another user's (or elevated): its
          // environment cannot be read either, and it is judged by the table.
          claudeCodeIdentity(rowIdentity(row)) === 'yes' &&
          evidence.isAlive(row.pid),
      )
      .map((row) => row.pid);
    if (pids.length === 0) return new Map();
    const read =
      seams.processConfigDirs ?? this.leaseSeams?.processConfigDirs ?? readProcessConfigDirs;
    return read(pids).catch(() => undefined);
  }

  /** The holders' evidence and, on Windows, the environments {@link unrecordedProcesses} reads. */
  private async processEvidence(
    mode: 'quick' | 'full',
    seams: Pick<LeaseSweepOptions, 'isAlive' | 'processTable' | 'procFs' | 'processConfigDirs'>,
  ): Promise<{ evidence: HolderEvidence; env: ReadonlyMap<number, string | null> | undefined }> {
    const evidence = await this.holderEvidence(mode, seams);
    return { evidence, env: await this.profileEnvironments(evidence, seams) };
  }

  /** Linux: the Claude Code processes whose environment names `profileDir` as their
   *  CLAUDE_CONFIG_DIR (compared as folders). Anything else that inherited it from the session (a dev
   *  server, an editor, a shell) never reads its login, so it is not listed (see
   *  {@link isClaudeCodeProcess}). Processes of other users cannot be read and are not listed. */
  private processesOnProfile(profileDir: string, fs: ProcFs = this.leaseProcFs()): number[] {
    const key = folderKey(this.canonReserved(profileDir), this.platform);
    return fs.pids().filter((pid) => {
      const dir = fs.configDirOf(pid);
      if (dir === undefined || folderKey(this.canonReserved(dir), this.platform) !== key) {
        return false;
      }
      const argv = fs.cmdlineOf?.(pid);
      return isClaudeCodeProcess(argv === undefined ? {} : { argv });
    });
  }

  /** A parallel session as {@link listLeases} shows it. */
  private leaseView(
    rule: FolderRule & { lease: SessionLease },
    evidence: HolderEvidence,
  ): LeaseView {
    return {
      ruleId: rule.id,
      accountId: rule.include[0]!,
      label: rule.label,
      profileDir: this.configDirForSlot(ruleSlotId(rule.id))!,
      startedAtMs: rule.lease.startedAtMs,
      holders: rule.lease.holders.map((h) => {
        const state: LeaseHolderState = holderState(h, evidence);
        // A Linux process that exited but was not reaped yet still answers kill-0: it is not a
        // reused pid.
        const exited = h.platform === 'linux' && isExitedState(evidence.procFs?.stat(h.pid)?.state);
        const reused =
          state === 'dead' && !exited && evidence.isAlive(h.pid) && h.host === evidence.host;
        return { ...h, state, ...(reused ? { reused: true } : {}) };
      }),
    };
  }

  /** What holders are judged by, read once: this machine, its process table on Windows in full mode
   *  (one query), its `/proc` on Linux, and this process's own identity. */
  private async holderEvidence(
    mode: 'quick' | 'full',
    seams: Pick<LeaseSweepOptions, 'isAlive' | 'processTable' | 'procFs'>,
  ): Promise<HolderEvidence> {
    const own = this.leaseSeams;
    const procFsNow = seams.procFs ?? own?.procFs ?? realProcFs;
    const evidence: HolderEvidence = {
      host: (own?.hostname ?? hostname)(),
      platform: this.platform,
      mode,
      isAlive: seams.isAlive ?? own?.isAlive ?? pidAlive,
      ...(this.platform === 'linux' ? { procFs: procFsNow } : {}),
      self:
        own?.self ??
        (() => {
          const me = selfHolder('launcher', {
            platform: this.platform,
            procFs: procFsNow,
            ...(own?.hostname !== undefined ? { hostname: own.hostname } : {}),
          });
          return { pid: me.pid, start: me.start };
        })(),
    };
    if (this.platform === 'linux') {
      // The namespaces visible from here, read once per check and only if a holder needs them.
      let seen: Set<string> | undefined;
      evidence.visibleNamespaces = () => (seen ??= visibleNamespaces(procFsNow));
    }
    if (mode === 'full' && this.platform === 'win32') evidence.table = await this.readTable(seams);
    return evidence;
  }

  /** The Windows process table by pid, or undefined when it could not be read (a query that failed,
   *  timed out or came back empty): every use then reads it as no evidence, never as no process. */
  private async readTable(
    seams: Pick<LeaseSweepOptions, 'processTable'>,
  ): Promise<ReadonlyMap<number, ProcessRow> | undefined> {
    const read = seams.processTable ?? this.leaseSeams?.processTable ?? readProcessTable;
    const rows = await read().catch(() => [] as ProcessRow[]);
    return rows.length === 0 ? undefined : new Map(rows.map((r) => [r.pid, r]));
  }

  /** The `/proc` the engine reads (see {@link SwitchEngineOptions.leaseProcesses}). */
  private leaseProcFs(): ProcFs {
    return this.leaseSeams?.procFs ?? realProcFs;
  }

  /** Whether an account's parallel-session slot holds it with a login: its identity names it and
   *  credentials are there. False when it has no parallel session. */
  private async leaseSeated(accountId: string, rules: readonly FolderRule[]): Promise<boolean> {
    const rule = leaseRuleOf(accountId, rules);
    if (rule === undefined) return false;
    const slotId = ruleSlotId(rule.id);
    if ((await this.getActiveId(slotId)) !== accountId) return false;
    const creds = await this.slotRuntime(slotId)
      .credStore.readLiveCredentials()
      .catch(() => undefined);
    return creds !== undefined;
  }

  /**
   * The one decision behind {@link planSessionSlot} and {@link claimSessionSlot}, in this order:
   * live in two slots (refused); live in the global slot; live in this launch's rule slot, or
   * reserved and live in a rule including it; live in another rule's slot (refused); a parallel
   * session exists (join; a quarantined account only onto a seated slot); quarantined (refused); a
   * new parallel session. macOS refuses every parallel-session row. Pure over its inputs.
   */
  private decideSessionSlot(
    accountId: string,
    launchRuleId: string | null,
    picture: RulesPicture,
    live: ReadonlyMap<SlotId, string | null>,
    leaseSeated: boolean,
  ): SessionSlotPlan {
    const account = [...picture.shared, ...picture.reserved].find((a) => a.id === accountId);
    if (account === undefined) throw new UnknownAccountError(accountId);
    const label = account.label;
    const words = (slot: SlotId): string => slotPhrase(slot, picture.rules);
    const liveIn = [...live].filter(([, id]) => id === accountId).map(([slot]) => slot);
    if (liveIn.length > 1) {
      return {
        kind: 'refused',
        code: 'live_twice',
        message:
          `${label} is live in two slots at once (${liveIn.map(words).join('; ')}); ` +
          'run cctl doctor before launching on it.',
      };
    }
    const where = liveIn[0];
    if (where === 'global') {
      const launchRule = picture.rules.find((r) => r.id === launchRuleId);
      return {
        kind: 'global',
        overrides:
          launchRule !== undefined && !slotMayHold(ruleSlotId(launchRule.id), accountId, picture),
      };
    }
    if (where !== undefined) {
      const rule = picture.rules.find((r) => ruleSlotId(r.id) === where);
      if (rule !== undefined && !isLeaseRule(rule)) {
        const reserved = picture.reserved.some((a) => a.id === accountId);
        if (rule.id === launchRuleId || (reserved && rule.include.includes(accountId))) {
          // Seating a reserved account always refused a quarantined one; running on it where it is
          // already live must too, or the launch starts on a login known to be dead.
          if (reserved && account.quarantined) {
            return {
              kind: 'refused',
              code: 'quarantined',
              message:
                `${label} is quarantined (${account.quarantineReason ?? 're-login required'}); log ` +
                `in again with: cctl accounts relogin ${label}`,
            };
          }
          return { kind: 'rule', ruleId: rule.id };
        }
        // A folder rule's slot switches with --folder; a rule of named sessions only has no
        // command that switches its slot, so the way off it is keeping the account out of it.
        const firstAlias = rule.aliases?.[0];
        const free =
          rule.folders.length > 0
            ? `switch that slot to another account first (cctl switch <account> --folder ` +
              `${shellQuoteArg(rule.folders[0]!, this.platform)})`
            : firstAlias !== undefined
              ? 'keep it out of that rule first (cctl session exclude ' +
                `${shellQuoteArg(firstAlias.alias, this.platform)} ` +
                `${shellQuoteArg(label, this.platform)} --cwd ` +
                `${shellQuoteArg(firstAlias.folder, this.platform)})`
              : 'switch that slot to another account first';
        // Said by rules, never by "here" and "there": the slot it is live in can be this folder's
        // while the launch runs under the rule of a named session it opens, which has its own slot.
        const launchRule = picture.rules.find((r) => r.id === launchRuleId);
        const launch =
          launchRule === undefined
            ? 'this launch runs under no folder or session rule'
            : `this launch runs in ${slotWordsOf(launchRule)}`;
        const what = reserved ? 'reserved to other rules and' : 'a shared account';
        return {
          kind: 'refused',
          code: 'live_in_other_rule',
          message:
            `${label} is ${what} live in ${words(where)}, where it serves that slot's sessions, ` +
            `and ${launch}. Run claude where that slot applies instead, or ${free}, then run ` +
            `claude --account ${label} again.`,
        };
      }
    }
    const ruleId = leaseRuleId(accountId);
    const profileDir = this.configDirForSlot(ruleSlotId(ruleId))!;
    const unsupported: SessionSlotPlan = {
      kind: 'refused',
      code: 'session_slot_unsupported',
      message:
        `${label} is not live in the global slot, and parallel sessions (one account per ` +
        'terminal) are not available on macOS yet: each would need its own Keychain item. Switch ' +
        `to it first (cctl switch ${label}), then run claude.`,
    };
    const quarantined: SessionSlotPlan = {
      kind: 'refused',
      code: 'quarantined',
      message:
        `${label} is quarantined (${account.quarantineReason ?? 're-login required'}); log in ` +
        `again with: cctl accounts relogin ${label}`,
    };
    if (leaseRuleOf(accountId, picture.rules) !== undefined) {
      if (this.platform === 'darwin') return unsupported;
      if (account.quarantined && !leaseSeated) return quarantined;
      return { kind: 'lease', ruleId, profileDir, join: true };
    }
    if (account.quarantined) return quarantined;
    if (this.platform === 'darwin') return unsupported;
    return { kind: 'lease', ruleId, profileDir, join: false };
  }

  /** The typed error of a refused session-slot decision. */
  private sessionSlotRefusal(plan: Extract<SessionSlotPlan, { kind: 'refused' }>): Error {
    switch (plan.code) {
      case 'quarantined':
        return new QuarantineError(plan.message);
      case 'session_slot_unsupported':
        return new RefreshError(plan.message, 'session_slot_unsupported');
      default:
        return new SessionSlotError(plan.message, plan.code);
    }
  }

  /** Refuse a parallel-session slot on macOS, where it would share the global Keychain item. Its
   *  own words, not the folder-rule refusal's. */
  private refuseSessionSlotsOnDarwin(label: string): void {
    if (this.platform === 'darwin') {
      throw new RefreshError(
        `${label} cannot run as a parallel session: macOS has no per-config-dir Keychain item yet`,
        'session_slot_unsupported',
      );
    }
  }

  /**
   * Join an account's existing parallel session with `holder`, under the lock. A record on the
   * caller's own process slot is dropped first (the caller owns that pid now, so the record is a
   * reused pid's). When the slot does not hold the account with a login — a creation that died before
   * seating it, a teardown that died after clearing it — it is seated from the vault first: either no
   * session ever ran on that seat, or its rotation was adopted before it was cleared. A seat that
   * cannot be completed adds no holder.
   */
  private async joinLeaseLocked(
    rule: FolderRule & { lease: SessionLease },
    holder: LeaseHolder,
    seated: boolean,
    evidence?: HolderEvidence,
  ): Promise<SessionSlotClaim> {
    const accountId = rule.include[0]!;
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    this.refuseSessionSlotsOnDarwin(rule.label);
    const kept = rule.lease.holders.filter((h) => !sameHolderProcess(h, holder));
    // Every launcher records its Claude Code right after its claim: a join leaves room for the
    // Claude Code of every terminal that has not recorded one yet, its own included, or a terminal
    // that already joined would start a Claude Code that could never be recorded.
    const after = withHolders(kept, [holder]);
    const pendingChildren = after.filter(
      (l) =>
        l.role === 'launcher' &&
        !after.some((c) => c.role === 'claude' && c.found !== true && c.parent === l.pid),
    ).length;
    if (after.length + pendingChildren > MAX_LEASE_HOLDERS) {
      throw new LeaseHolderCapError(
        `cannot join the parallel session of ${rule.label}: it already records ${kept.length} ` +
          `processes, and each terminal on it needs room for its Claude Code. Exit a terminal on ` +
          `${rule.label} first.`,
        MAX_LEASE_HOLDERS,
      );
    }
    ensureGroupProfile(rt.profileDir!, this.paths.claudeDir, {
      logger: this.log,
      mainClaudeJsonPath: this.paths.claudeJsonPath,
    });
    if (!seated) {
      try {
        await this.activateInSlot(rt, accountId, {
          force: true,
          origin: 'manual',
          reason: 'seating a parallel session',
          lease: true,
        });
      } catch (err) {
        if (this.isSimulatedDeath(err)) throw err;
        throw new SessionSlotError(
          `could not log ${rule.label} in to its parallel-session slot: ${errorReason(err)}`,
          'lease_seat_failed',
          { cause: err },
        );
      }
      this.fault('lease:join-after-seat');
    }
    const next = withHolders(kept, [holder]);
    await this.vault.setLeaseHolders(rule.id, next);
    await this.writeSnapshotLocked();
    // Who else is on it now: the holders still running (a deferred end leaves dead ones on disk),
    // counted as terminals and background sessions. Windows judges them by the process table read
    // before the lock: kill-0 alone takes a pid another process took over for the holder.
    const judge = evidence ?? (await this.holderEvidence('quick', {}));
    const others = leaseOccupants(kept.filter((h) => holderState(h, judge) !== 'dead'));
    return {
      kind: 'lease',
      ruleId: rule.id,
      profileDir: rt.profileDir!,
      joined: true,
      holders: next.length,
      otherTerminals: others.terminals,
      otherBackground: others.background,
      ...(others.leftover > 0 ? { otherLeftover: others.leftover } : {}),
    };
  }

  /**
   * Start a parallel session for an account, under the lock: write the rule (groups.json first,
   * which reserves the account; accounts.json second), make its profile, seat the account there,
   * write the snapshot. Anything after the rule write that fails tears the new session down before
   * the error is rethrown. A crash instead leaves a session held by a dead launcher, which the next
   * sweep ends or the next join seats; no session ever starts on an empty or half-written seat.
   */
  private async createLeaseLocked(
    accountId: string,
    holder: LeaseHolder,
    picture: RulesPicture,
  ): Promise<SessionSlotClaim> {
    const account = [...picture.shared, ...picture.reserved].find((a) => a.id === accountId)!;
    this.refuseSessionSlotsOnDarwin(account.label);
    if (picture.rules.length >= MAX_RULES) {
      throw new SessionSlotError(
        `cannot start another parallel session: the rules registry is full (max ${MAX_RULES} ` +
          'rules, parallel sessions included).',
        'rules_full',
      );
    }
    const rule = await this.vault.createRule({
      folders: [],
      include: [accountId],
      label: account.label,
      lease: { holders: [holder], startedAtMs: this.clock() },
    });
    this.fault('lease:after-create');
    const rt = this.slotRuntime(ruleSlotId(rule.id));
    try {
      ensureGroupProfile(rt.profileDir!, this.paths.claudeDir, {
        logger: this.log,
        mainClaudeJsonPath: this.paths.claudeJsonPath,
      });
      await this.activateInSlot(rt, accountId, {
        force: true,
        origin: 'manual',
        reason: 'starting a parallel session',
        lease: true,
      });
      this.fault('lease:after-activate');
      await this.writeSnapshotLocked();
    } catch (err) {
      if (this.isSimulatedDeath(err)) throw err;
      try {
        await this.teardownRuleSlotLocked(rule, { lease: true });
      } catch (undoErr) {
        if (this.isSimulatedDeath(undoErr)) throw undoErr;
        this.log.warn(
          { ruleId: rule.id, reason: errorReason(undoErr) },
          'could not take down a parallel session that failed to start; the sweep ends it',
        );
      }
      throw err;
    }
    return {
      kind: 'lease',
      ruleId: rule.id,
      profileDir: rt.profileDir!,
      joined: false,
      holders: 1,
      otherTerminals: 0,
    };
  }

  /**
   * {@link ensureRuleLive} for a parallel session: never seats, replaces or clears. When its account
   * is live there with a login and the record drifted (an acquire interrupted after seating), the
   * record is healed after the rotation is adopted, as a kept occupant's is. Reports the slot as
   * having no working account when its account is not live there or is quarantined.
   */
  private async leaseLiveResult(
    rt: SlotRuntime,
    rule: FolderRule & { lease: SessionLease },
    picture: RulesPicture,
  ): Promise<RuleLiveResult> {
    const accountId = rule.include[0]!;
    const live = await this.getActiveId(rt.id);
    const creds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    if (live === accountId && creds !== undefined && rule.activeId !== accountId) {
      await this.adoptSlotRotation(rt);
      await this.vault.setRuleActive(rule.id, accountId);
    }
    const quarantined = picture.reserved.find((a) => a.id === accountId)?.quarantined === true;
    return {
      ruleId: rule.id,
      liveAccount: live,
      activated: false,
      noWorkingAccount: live !== accountId || creds === undefined || quarantined,
    };
  }

  /**
   * The repair of a parallel session's slot. Its own account (or nothing) there: only a drifted
   * record is healed. Another account Y there (a `/login` run inside the session): Y's rotation is
   * adopted into Y's own bundle; when Y may be live in another slot too, the copy here is cleared, so
   * Y is never live in two places; when it is live nowhere else it stays (no other slot can take it
   * while it is live here). Either way an alert says so. The session's own account is never seated,
   * re-seated or evicted here; a session whose holders are gone is the sweep's to end.
   */
  private async repairLeaseSlotLocked(
    rule: FolderRule & { lease: SessionLease },
    actions: string[],
  ): Promise<void> {
    const slotId = ruleSlotId(rule.id);
    const rt = this.slotRuntime(slotId);
    const rows = await this.vault.listAllAccounts();
    const stored = await this.vault.readStoredTokens();
    const phys = await this.physicalLiveId(rt.credStore, rows, stored);
    const own = rule.include[0]!;
    if (phys.id === null || phys.id === own) {
      await this.ensureRuleLiveLocked(rule);
      return;
    }
    const other = phys.id;
    const otherLabel = rows.find((r) => r.id === other)?.label ?? other;
    const liveNow = await rt.credStore.readLiveCredentials().catch(() => undefined);
    const liveOauth = await rt.credStore.readOauthAccount().catch(() => undefined);
    await this.adoptRotationIfNeeded(other, liveNow, liveOauth);
    let elsewhere = false;
    for (const slot of allSlots(await this.vault.listRules())) {
      if (slot === slotId) continue;
      if ((await this.possibleLiveOwners(slot, stored)).has(other)) elsewhere = true;
    }
    if (elsewhere) {
      await this.clearSlotLive(rt);
      if (rule.activeId !== null) await this.vault.setRuleActive(rule.id, null);
    }
    actions.push(
      `a parallel session of ${rule.label} was logged in as ${otherLabel}; that login's latest ` +
        `token was saved to ${otherLabel}` +
        (elsewhere ? ' and cleared from the session' : ' (the login stays in the session)'),
    );
  }

  /** The running sessions of a parallel session: its holders still running (a quick judgment), as
   *  running sessions on its profile, one per terminal. A launcher counts until it has recorded
   *  its Claude Code: before that the session is starting, and is about to read the slot's login. */
  private async leaseSessions(
    rule: FolderRule & { lease: SessionLease },
  ): Promise<RunningSession[]> {
    const evidence = await this.holderEvidence('quick', {});
    const profile = this.configDirForSlot(ruleSlotId(rule.id))!;
    const running = rule.lease.holders.filter((h) => holderState(h, evidence) !== 'dead');
    const pids = new Set(leaseSessionPids(running));
    return running
      .filter((h) => pids.has(h.pid))
      .map((h) => ({ pid: h.pid, cwd: profile, sessionFile: `parallel session holder ${h.pid}` }));
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

  /** Canonicalize the scope a creating or editing verb (include, exclude) names: a folder by
   *  {@link canonicalizeBindFolder}'s rules, an alias scope's folder by
   *  {@link canonicalizeAliasFolder}'s lighter ones, with its alias text checked. */
  private canonicalizeEditScope(scope: RuleScopeRef): RuleScopeRef {
    if (scope.kind === 'folder') {
      return { kind: 'folder', folder: this.canonicalizeBindFolder(scope.folder) };
    }
    this.checkAliasText(scope.alias);
    return {
      kind: 'alias',
      folder: this.canonicalizeAliasFolder(scope.folder),
      alias: scope.alias,
    };
  }

  /** The rule holding exactly this scope — a folder rule of the folder, or the alias rule of
   *  (folder, alias key) — if any. */
  private exactScopeRule(
    scope: RuleScopeRef,
    rules: readonly FolderRule[],
  ): FolderRule | undefined {
    return scope.kind === 'folder'
      ? exactFolderRule(scope.folder, rules, this.platform)
      : exactAliasRule(scope.folder, scope.alias, rules, this.platform);
  }

  /** `scope` as `rule` stores it (matched by the store's uniqueness key), so a report names the
   *  folder and alias as they were entered, not as the operator retyped them. */
  private storedScope(rule: FolderRule, scope: RuleScopeRef): RuleScopeRef {
    if (scope.kind === 'folder') {
      const key = folderUniquenessKey(scope.folder, this.platform);
      const stored = rule.folders.find((f) => folderUniquenessKey(f, this.platform) === key);
      return stored === undefined ? scope : { kind: 'folder', folder: stored };
    }
    const key = aliasScopeUniquenessKey(scope.folder, scope.alias, this.platform);
    const stored = (rule.aliases ?? []).find(
      (a) => aliasScopeUniquenessKey(a.folder, a.alias, this.platform) === key,
    );
    return stored === undefined ? scope : { kind: 'alias', ...stored };
  }

  /** Refuse an alias no session title could usefully carry here: blank (after the resume rule's
   *  trim), longer than Claude Code keeps a session's title (it stores the first
   *  {@link CLAUDE_CODE_TITLE_MAX_LENGTH} characters, so a longer alias would never match any
   *  session — a rule that silently applies to nothing), carrying an unpaired surrogate (which Claude
   *  Code stores as U+FFFD, so again no session could match it), or holding a control/bidi character
   *  — the alias is echoed into hook decisions and terminals, and a title that needs one is not worth
   *  the risk. */
  private checkAliasText(alias: string): void {
    if (typeof alias !== 'string' || aliasKey(alias) === '') {
      throw new RefreshError('a session alias cannot be empty', 'bind_refused');
    }
    if (!isWellFormedText(alias)) {
      throw new RefreshError(
        'a session alias cannot contain an unpaired surrogate: Claude Code stores it as the ' +
          'Unicode replacement character in a session name, so no session could match this alias',
        'bind_refused',
      );
    }
    if (alias.length > MAX_ALIAS_LENGTH || !aliasFitsSessionTitle(alias)) {
      throw new RefreshError(
        `a session alias cannot be longer than ${CLAUDE_CODE_TITLE_MAX_LENGTH} characters: ` +
          'Claude Code keeps only the first ' +
          `${CLAUDE_CODE_TITLE_MAX_LENGTH} characters of a session name, so no session could ` +
          'match a longer one',
        'bind_refused',
      );
    }
    if (sanitizeTerminalText(alias) !== alias) {
      throw new RefreshError(
        'a session alias cannot contain control or bidirectional characters',
        'bind_refused',
      );
    }
  }

  /** Canonicalize the folder of an alias scope, refusing only what {@link checkAliasFolder} refuses
   *  (a missing folder, or one inside cctl's state / the main config dir): an alias scope covers one
   *  exact folder, so the home dir or a volume root — refused for FOLDER rules because they would
   *  capture everything beneath — is a legitimate place for a named session. */
  private canonicalizeAliasFolder(folder: string): string {
    const canon = canonicalizeFolder(folder, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
      realpath: this.bindFs.realpath,
    });
    if (!canon.ok) {
      throw new RefreshError(`cannot use folder "${folder}": ${canon.reason}`, 'bind_refused');
    }
    const check = checkAliasFolder(canon.path, {
      platform: this.platform,
      isDirectory: this.bindFs.isDirectory,
      homeDir: this.canonReserved(this.bindFs.homedir()),
      vaultDir: this.canonReserved(this.paths.vaultDir),
      profilesRoot: this.canonReserved(profilesRoot(this.paths.vaultDir)),
      mainConfigDir: this.canonReserved(this.paths.claudeDir),
    });
    if (!check.ok) {
      throw new RefreshError(
        `cannot give a session in "${canon.path}" a rule: it ${check.reason}`,
        'bind_refused',
      );
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

  /** Running sessions whose cwd is within one of `folders` — what a folder scope covers. */
  private async runningSessionsUnder(folders: readonly string[]): Promise<RunningSession[]> {
    if (folders.length === 0) return [];
    return this.scanRunningSessions((rec) =>
      folders.some((f) => isWithin(rec.cwd, f, this.platform)),
    );
  }

  /** Running sessions an alias scope covers: a custom title matching `alias` by alias key, in a
   *  conversation RECORDED in exactly `folder` (the precedence rule's alias key — a session resumed
   *  from a parent folder still belongs to the folder it was recorded in). An unnamed session is not
   *  counted: it is outside the alias scope by definition. A session whose title could not be
   *  learned IS counted — marked {@link RunningSession.unidentified} — when it runs in `folder`, or
   *  its transcript's project directory can stand for `folder`: it may be that conversation, and
   *  emptying the slot must not strand it silently. */
  private async runningAliasSessions(folder: string, alias: string): Promise<RunningSession[]> {
    const here = folderUniquenessKey(folder, this.platform);
    const key = aliasKey(alias);
    return this.scanRunningSessions((rec) => {
      if (!rec.titleKnown) {
        return folderUniquenessKey(rec.cwd, this.platform) === here ||
          (rec.recordedFolder !== null &&
            folderUniquenessKey(rec.recordedFolder, this.platform) === here) ||
          (rec.dirName !== undefined && projectDirMatches(rec.dirName, folder))
          ? 'unidentified'
          : false;
      }
      return (
        rec.title !== null &&
        aliasKey(rec.title) === key &&
        rec.recordedFolder !== null &&
        folderUniquenessKey(rec.recordedFolder, this.platform) === here
      );
    });
  }

  /** Running sessions one scope covers. */
  private async runningSessionsInScope(scope: RuleScopeRef): Promise<RunningSession[]> {
    return scope.kind === 'folder'
      ? this.runningSessionsUnder([scope.folder])
      : this.runningAliasSessions(scope.folder, scope.alias);
  }

  /** Running sessions in ANY of a rule's scopes (folders and aliases), each reported once. What
   *  emptying the rule's slot refuses on: every session that could be running on it. */
  private async runningSessionsInRule(rule: FolderRule): Promise<RunningSession[]> {
    // A parallel session's sessions are its recorded processes, not sessions found by folder.
    if (isLeaseRule(rule)) return this.leaseSessions(rule);
    const found = await this.runningSessionsUnder(rule.folders);
    for (const a of rule.aliases ?? []) {
      for (const s of await this.runningAliasSessions(a.folder, a.alias)) {
        if (!found.some((f) => f.sessionFile === s.sessionFile)) found.push(s);
      }
    }
    // The session roster is shared by every profile and records no config dir, so a parallel
    // session working in this rule's folder shows up here too. It runs on its own slot, which
    // emptying this one cannot touch: a session proven to run on a parallel session's profile is
    // left out. Nothing short of proof is: a session wrongly left out loses its login.
    const leases = (await this.vault.listRules()).filter(isLeaseRule);
    if (leases.length === 0 || found.length === 0) return found;
    const onLeases = await this.pidsOnLeaseProfiles(
      leases,
      found.map((f) => f.pid),
    );
    return found.filter((f) => !onLeases.has(f.pid));
  }

  /**
   * Which of `pids` provably run on a parallel session's profile: their environment names it
   * (Linux: `/proc`; Windows: the process's own environment block). On Windows a process whose
   * environment cannot be read counts only when the process table shows it is a live holder (its
   * recorded start matches, not a later process on a reused pid) or a descendant of one. A holder
   * of another machine or platform never matches a pid here.
   */
  private async pidsOnLeaseProfiles(
    leases: ReadonlyArray<FolderRule & { lease: SessionLease }>,
    pids: readonly number[],
  ): Promise<Set<number>> {
    const key = (dir: string): string => folderKey(this.canonReserved(dir), this.platform);
    const profiles = new Set(leases.map((r) => key(this.configDirForSlot(ruleSlotId(r.id))!)));
    const onProfile = (dir: string | null | undefined): boolean =>
      typeof dir === 'string' && profiles.has(key(dir));
    const out = new Set<number>();
    if (this.platform === 'linux') {
      const fs = this.leaseProcFs();
      for (const pid of pids) if (onProfile(fs.configDirOf(pid))) out.add(pid);
      return out;
    }
    if (this.platform !== 'win32') return out;
    const evidence = await this.holderEvidence('full', {});
    const read = this.leaseSeams?.processConfigDirs ?? readProcessConfigDirs;
    const env = await read(pids).catch(() => undefined);
    const live = leases
      .flatMap((r) => r.lease.holders)
      .filter((h) => holderState(h, evidence) === 'alive');
    const descendants =
      evidence.table === undefined
        ? new Set<number>()
        : this.descendantsOfHolders(live, evidence.table);
    for (const pid of pids) {
      if (env?.has(pid) === true) {
        if (onProfile(env.get(pid))) out.add(pid);
        continue;
      }
      if (live.some((h) => h.pid === pid) || descendants.has(pid)) out.add(pid);
    }
    return out;
  }

  /**
   * Scan `<mainConfigDir>/sessions/*.json` for Claude Code sessions whose recorded pid is alive and
   * that `matches` accepts. Each file records `{pid, cwd, sessionId, name, nameSource}` (it is
   * removed on a clean exit and left stale by a hard kill, hence the pid check). The cwd is where the
   * session runs. Its title and recorded folder come from its TRANSCRIPT when
   * {@link sessionIdentity} is wired — the only source for a resumed session, whose `name` is derived
   * (`nameSource: "derived"`), never its title — the recorded folder decided as everywhere else
   * (recordedFolderFor over the shared reading, the session's cwd as the folder it runs in). A
   * session the transcript does not know yet (a `--name` launch before its first turn) falls back to
   * a `name` the operator set (`nameSource: "user"`, or no `nameSource` at all from an older Claude
   * Code), recorded where it runs. Anything else — an unreadable transcript, a session with no
   * transcript and no name of its own (a fork or a new session before its first prompt), a failed
   * lookup — has an UNKNOWN title (`titleKnown` false), which the matcher decides about. A matcher
   * answering 'unidentified' counts the session as possibly in scope. Defensive: a missing dir, an
   * unreadable or malformed session file, or a session with no usable pid/cwd is skipped — this only
   * feeds a warning or a refusal the operator can `--force`, never throws.
   */
  private async scanRunningSessions(
    matches: (rec: SessionRecordView) => boolean | 'unidentified',
  ): Promise<RunningSession[]> {
    const dir = join(this.paths.claudeDir, 'sessions');
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return [];
    }
    const live: {
      pid: number;
      rawCwd: string;
      cwd: string;
      file: string;
      sessionId: string | undefined;
      launchName: string | null;
    }[] = [];
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
      const rec = parsed as {
        pid?: unknown;
        cwd?: unknown;
        name?: unknown;
        nameSource?: unknown;
        sessionId?: unknown;
      };
      const pid = typeof rec.pid === 'number' && Number.isInteger(rec.pid) ? rec.pid : undefined;
      const rawCwd = typeof rec.cwd === 'string' ? rec.cwd : undefined;
      if (pid === undefined || rawCwd === undefined) continue;
      if (!this.isProcessAlive(pid)) continue;
      const userNamed = rec.nameSource === undefined || rec.nameSource === 'user';
      live.push({
        pid,
        rawCwd,
        cwd: this.canonReserved(rawCwd),
        file,
        sessionId:
          typeof rec.sessionId === 'string' && rec.sessionId !== '' ? rec.sessionId : undefined,
        launchName: userNamed && typeof rec.name === 'string' ? rec.name : null,
      });
    }
    const identities = await this.lookupSessionIdentities(
      live.flatMap((l) => (l.sessionId !== undefined ? [l.sessionId] : [])),
    );
    const out: RunningSession[] = [];
    for (const l of live) {
      const known: SessionIdentity | undefined =
        l.sessionId !== undefined ? identities.get(l.sessionId.toLowerCase()) : undefined;
      const readable = known !== undefined && known.unreadable !== true;
      const titleKnown = readable || (known === undefined && l.launchName !== null);
      const title = readable ? known.customTitle : titleKnown ? l.launchName : null;
      // The folder the conversation belongs to, decided exactly as the guard decides it: a known
      // transcript's trusted folder, else the folder it runs in when the transcript's project
      // directory can stand for it; a named launch before its first turn belongs where it runs.
      const recordedFolder =
        known !== undefined
          ? recordedFolderFor(
              { folder: readable ? known.folder : null, dirName: known.dirName ?? '' },
              { spelled: l.rawCwd, canonical: l.cwd },
              (f) => this.canonReserved(f),
            )
          : l.cwd;
      const verdict = matches({
        cwd: l.cwd,
        title,
        titleKnown,
        recordedFolder,
        dirName: known?.dirName,
      });
      if (verdict === false) continue;
      out.push({
        pid: l.pid,
        cwd: l.cwd,
        sessionFile: l.file,
        ...(verdict === 'unidentified' ? { unidentified: true as const } : {}),
      });
    }
    return out;
  }

  /** {@link sessionIdentity} for these ids, or an empty map when it is not wired, there is nothing to
   *  look up, or the lookup fails (the scan then falls back to what the session file records). */
  private async lookupSessionIdentities(
    sessionIds: readonly string[],
  ): Promise<ReadonlyMap<string, SessionIdentity>> {
    if (this.sessionIdentity === undefined || sessionIds.length === 0) return new Map();
    try {
      return await this.sessionIdentity(this.paths.claudeDir, sessionIds);
    } catch (err) {
      this.log.warn(
        { reason: errorReason(err) },
        "could not read running sessions' transcripts; using their session files only",
      );
      return new Map();
    }
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
      platform: this.platform,
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
    return this.activeIdIn(slot);
  }

  /** {@link getActiveId}, against `registry` when the caller has read it already (a walk over every
   *  slot reads it once, not once per slot). */
  private async activeIdIn(slot: SlotId, registry?: RegistryPicture): Promise<string | null> {
    const rt = this.slotRuntime(slot);
    const { registryId, candidates } = await this.slotRegistry(slot, registry);
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
   * Answered from the stored tokens' fingerprints (see tokenPrints.ts), not by decrypting the
   * bundle: a decrypt is a PowerShell spawn on Windows (see dpapi.ts), and the disagreement branch
   * that asks this can last indefinitely (a `/login` in Claude Code as an account never stored
   * here), with a live view asking it every couple of seconds. The fingerprints are kept in memory
   * and on disk keyed by each encrypted blob, so a bundle is decrypted at most once until it
   * changes. Asked only from `getActiveId()`'s disagreement branch.
   */
  private async liveTokenBelongsTo(
    accountId: string,
    credStore: CredentialStore,
  ): Promise<boolean> {
    const live = await credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return false;
    const stored = await this.vault.readStoredTokens().catch(() => undefined);
    if (stored === undefined || !stored.holdsRefresh(accountId, live)) return false;
    return stored.holdersOf(live).every((id) => id === accountId);
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
          { code: 'login_stored' },
        );
      }
      if (holders.length > 1) {
        // Two holders: which one it really belongs to cannot be told, so neither is offered.
        throw new VaultError(
          `this login's token is already stored under ` +
            `${quotedLabels(holders, await this.vault.listAllAccounts())}; ${SHARED_TOKEN_REMEDY}`,
          { code: 'login_stored' },
        );
      }
      const oauthAccount = await this.credStore.readOauthAccount();
      const bundle: CredentialBundle = oauthAccount
        ? { claudeAiOauth: live, oauthAccount }
        : { claudeAiOauth: live };
      const account = await this.vault.addAccount(label, bundle);
      // The just-captured account IS the live one; record that so the first switch reconciles.
      await this.adoptAsGlobalLiveLocked(account.id);
      await this.refreshSnapshotForAccountsLocked();
      return account;
    });
  }

  /**
   * Record that `accountId` is now the global slot's live account WITHOUT a switch — a login cctl
   * captured in place (`accounts add` of the current login, a first login with nothing live before
   * it). Sets the registry's active id AND appends the same `activated` audit entry a switch writes:
   * the attribution journal derives its activation timeline from that log alone, so without it a box
   * that never switched has no interval at all and every turn reads as unattributed. Caller holds the
   * credential lock.
   */
  private async adoptAsGlobalLiveLocked(accountId: string): Promise<void> {
    const previous = await this.vault.getActiveId();
    await this.vault.setActive(accountId);
    if (previous === accountId) return;
    this.audit.append({
      ts: this.clock(),
      event: 'activated',
      fromAccountId: previous,
      toAccountId: accountId,
      origin: 'manual',
      slot: 'global',
      detail: 'adopted the current login',
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
          await this.adoptAsGlobalLiveLocked(account.id);
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
        if (!prior) await this.adoptAsGlobalLiveLocked(accountId);
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
    const liveSlot = await this.reloginSlotOf(existing.id);

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
   *
   * `keepLiveIdentity` heals only the credentials of `liveSlot`, for a slot whose identity block
   * names another account: the slot stays torn as it was, so whoever reads it still counts both.
   * `onStored` is told once the vault holds the new bundle (its blob written, even when the registry
   * write after it then fails), so a caller that wrote a slot first knows whether a later failure
   * may still undo that write (see {@link importBundle}).
   */
  private async applyReloginBundle(
    existing: StoredAccount,
    creds: ClaudeOauth,
    oauthAccount: OauthAccount | undefined,
    liveSlot: SlotId | undefined,
    reportedIdentity: OauthAccount | undefined,
    keepLiveIdentity = false,
    onStored?: () => void,
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
    await this.vault.writeBundle(existing.id, bundle, onStored);
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
      const rt = this.slotRuntime(liveSlot);
      const credStore = rt.credStore;
      try {
        await this.setAsideTornCredentials(rt);
        await credStore.writeLiveCredentials(bundle.claudeAiOauth);
        if (!keepLiveIdentity) await this.writeLiveIdentity(bundle.oauthAccount, credStore);
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
      const liveSlot = await this.reloginSlotOf(existing.id);
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
      // An account a parallel session holds is pinned to that terminal. Checked before the slot is
      // chosen: the default slot of an account its parallel session includes would be that very slot,
      // and a switch there would read as a no-op.
      const leased = leaseRuleOf(targetId, picture.rules);
      if (leased !== undefined && options.lease !== true) {
        throw new SlotError(leasedRefusal(target.label, leased.lease), 'leased');
      }
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
    if (isLeaseRule(rule)) {
      return `account "${target.label}" cannot be live in ${slotWordsOf(rule)}: it holds only that account`;
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
    occupancy?: ReadonlyMap<SlotId, ReadonlySet<string>>,
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
    // Who is live in each other slot: as the caller read it under the lock it holds, or read now.
    const stored = occupancy === undefined ? await this.vault.readStoredTokens() : undefined;
    for (const other of allSlots(picture.rules)) {
      if (other === rt.id) continue;
      const owners =
        occupancy?.get(other) ?? (await this.possibleLiveOwners(other, stored, picture));
      if (owners.has(targetId)) {
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
    outgoing?: string,
    occupancy?: ReadonlyMap<SlotId, ReadonlySet<string>>,
  ): Promise<ActivateResult> {
    await this.requireSettledLocked(rt);
    const candidacy = await this.slotCandidacy(rt, targetId, occupancy);
    if (!candidacy.ok) throw candidacy.error;
    const rule = candidacy.rule;
    await this.refuseSharedToken(targetId);

    // Live-reconciled, not the raw registry: `prevActiveId` names who OWNS the live token below
    // (rotation adoption, audit) IN THIS SLOT, and after an external `/login` the registry's record
    // points at an account whose credentials are no longer the live ones.
    const prevActiveId = await this.getActiveId(rt.id);
    // Who the live login is, for adopting its rotation and for the switch log: the slot's own
    // reading, or, where the slot no longer recognizes it (an import moving the main login off an
    // account its rules now reserve), the account the caller is moving it off.
    const outgoingId = prevActiveId ?? outgoing ?? null;

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
      outgoingId,
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
      fromAccountId: outgoingId,
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

  /** A slot as a message names it (see slotPhrase). */
  private async slotLabelOf(slotId: SlotId): Promise<string> {
    return slotPhrase(slotId, await this.vault.listRules().catch(() => []));
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

  /**
   * What adoption would do with a live token of `prevActiveId`'s, read-only:
   *   - `none`: nothing to adopt (no live token, or the stored one);
   *   - `stale`: a token older than the stored one (see the direction guard), left alone;
   *   - `refused`: a token adoption must not store under this account, with why (silent: an
   *     identity that provably belongs to another account; logged: an ownership guard);
   *   - `adopt`: a later rotation of this account's, with the identity block to store beside it;
   *   - `capture`: the login of an account stored without one, provably its own (see
   *     {@link captureCheck}), with its identity block and whether a pending-login quarantine lifts.
   */
  private async adoptionPlan(
    prevActiveId: string | null,
    liveNow: ClaudeOauth | undefined,
    liveOauthAccount: OauthAccount | undefined,
  ): Promise<
    | { kind: 'none' | 'stale' }
    | { kind: 'refused'; reason: string; silent: boolean }
    | { kind: 'adopt'; oauthAccount: OauthAccount | undefined }
    | { kind: 'capture'; oauthAccount: OauthAccount; liftsQuarantine: boolean }
  > {
    if (!liveNow) return { kind: 'none' };
    if (!prevActiveId) {
      return { kind: 'refused', reason: 'no account is live there', silent: true };
    }
    const prevBundle = await this.vault.readBundle(prevActiveId).catch(() => undefined);
    if (!prevBundle) {
      // An account kept without a login (one an import brought without tokens) takes the live login
      // as its own only when it provably is that account's (see captureCheck).
      const capture = await this.captureCheck(prevActiveId, liveNow, liveOauthAccount);
      if (capture !== undefined) return { kind: 'capture', ...capture };
      return { kind: 'refused', reason: 'the live account has no stored login', silent: true };
    }
    // Identity guard: adoption WRITES the live credentials into this account's bundle, so a
    // provable owner mismatch must skip — persisting another account's tokens under this id
    // would corrupt both the bundle and every usage-attribution row keyed to it. Unprovable
    // (either side missing a uuid) falls through to the token comparison, as before.
    const prevUuid = prevBundle.oauthAccount?.accountUuid;
    const liveUuid = liveOauthAccount?.accountUuid;
    if (prevUuid !== undefined && liveUuid !== undefined && prevUuid !== liveUuid) {
      return { kind: 'refused', reason: 'the live login is another account', silent: true };
    }
    if (liveNow.refreshToken === prevBundle.claudeAiOauth.refreshToken) return { kind: 'none' };

    // Direction guard: "differs" is not "newer". Adoption exists to save a token the CLI
    // minted AFTER our stored copy, but an in-place re-login makes the VAULT the newer side —
    // with the live files still holding the dead grant the re-login replaced. Adopting then
    // writes that dead token back over the fresh bundle, and the very next refresh of it fails
    // as invalid_grant and quarantines the account: the recovery verb's work is undone by the
    // switch meant to complete it. `expiresAt` dates each grant's mint (access-token lifetimes
    // are fixed per provider), so a live token that expires no later than the stored one
    // cannot be a later rotation, and is left alone rather than adopted.
    if (liveNow.expiresAt <= prevBundle.claudeAiOauth.expiresAt) return { kind: 'stale' };

    // Ownership guards, run only now that a write is otherwise decided (they are the expensive part).
    const refusal = await this.adoptionRefusal(prevActiveId, prevUuid, liveNow, liveOauthAccount);
    if (refusal !== undefined) return { kind: 'refused', reason: refusal, silent: false };

    // Identity precedence: the live block goes into this account's bundle only when it PROVABLY
    // belongs to it — both sides report a uuid and they agree. Otherwise the bundle keeps its own
    // block, because an unprovable live block (partial, or belonging to whoever the CLI logged in
    // last) would stamp a foreign identity onto this bundle, and identity is what every
    // downstream attribution check keys on. Adoption exists to save a rotated TOKEN, so it has no
    // business re-identifying the account it saves it into; when neither side has a block the
    // write carries none rather than inventing one.
    const provenLive =
      liveUuid !== undefined && liveUuid === prevUuid ? liveOauthAccount : undefined;
    return { kind: 'adopt', oauthAccount: provenLive ?? prevBundle.oauthAccount };
  }

  /** If the live (previous-account) token rotated under us, adopt it into the vault. */
  private async adoptRotationIfNeeded(
    prevActiveId: string | null,
    liveNow: ClaudeOauth | undefined,
    liveOauthAccount: OauthAccount | undefined,
  ): Promise<boolean> {
    const plan = await this.adoptionPlan(prevActiveId, liveNow, liveOauthAccount);
    // Every plan but `none` names an account with a live token; the guard only narrows the types.
    if (prevActiveId === null || liveNow === undefined) return false;
    if (plan.kind === 'refused' && !plan.silent) {
      this.log.warn({ prevActiveId, reason: plan.reason }, 'refused to adopt the live token');
      this.audit.append({
        ts: this.clock(),
        event: 'adoption_refused',
        fromAccountId: prevActiveId,
        toAccountId: prevActiveId,
        detail: plan.reason,
      });
      return false;
    }
    if (plan.kind === 'capture') return this.captureLoginOf(prevActiveId, liveNow, plan);
    if (plan.kind !== 'adopt') return false;
    const oauthAccount = plan.oauthAccount;
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
   * Whether the live login may be stored as the bundle of an account stored without one (an account
   * an import brought without tokens): the live identity names the login the row records, and no
   * other stored account holds the token. Without this, switching the slot off such an account, or
   * clearing it, would throw away the only copy of a working login, and then ask for a re-login.
   * Returns what storing it needs (undefined when it may not), read-only.
   */
  private async captureCheck(
    accountId: string,
    liveNow: ClaudeOauth,
    liveOauthAccount: OauthAccount | undefined,
  ): Promise<{ oauthAccount: OauthAccount; liftsQuarantine: boolean } | undefined> {
    // A bundle that exists but cannot be read just now is not "none": never written over.
    if (await this.vault.hasBundle(accountId)) return undefined;
    const row = await this.vault.getAccount(accountId);
    const liveUuid = anchorValue(liveOauthAccount?.accountUuid);
    if (row?.accountUuid === undefined || liveOauthAccount === undefined) return undefined;
    if (liveUuid !== row.accountUuid) return undefined;
    const others = (await this.vault.readStoredTokens())
      .holdersOf(liveNow)
      .filter((id) => id !== accountId);
    if (others.length > 0) return undefined;
    return {
      oauthAccount: liveOauthAccount,
      liftsQuarantine: row.quarantined && row.quarantineReason === PENDING_LOGIN_REASON,
    };
  }

  /** Store the live login of an account stored without one, as {@link captureCheck} allowed; a
   *  quarantine for want of a login is lifted with it. Returns that it stored it. */
  private async captureLoginOf(
    accountId: string,
    liveNow: ClaudeOauth,
    capture: { oauthAccount: OauthAccount; liftsQuarantine: boolean },
  ): Promise<boolean> {
    await this.vault.writeBundle(accountId, {
      claudeAiOauth: liveNow,
      oauthAccount: capture.oauthAccount,
    });
    if (capture.liftsQuarantine) await this.vault.clearQuarantine(accountId);
    this.audit.append({
      ts: this.clock(),
      event: 'refresh_adopted',
      fromAccountId: accountId,
      toAccountId: accountId,
      detail: 'stored the live login of an account kept without one',
    });
    this.log.info({ accountId }, 'stored the live login of an account kept without one');
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
  private async refuseSharedToken(targetId: string, stored?: StoredTokens): Promise<void> {
    const sharers = (stored ?? (await this.vault.readStoredTokens())).refreshSharers(targetId);
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
   *
   * Another process takes the lock over from a holder older than LOCK_STALE_MS, alive or not, and
   * each locked network call is sized to fit in that once. Work that makes several such calls under
   * one hold (an import seating rule after rule) calls `renew` between them: the claim is
   * restamped, so every step gets the whole window, and a claim already taken over stops the work
   * there, before it writes over what the new holder does.
   */
  private async withCredentialLock<T>(mutate: (renew: () => void) => Promise<T>): Promise<T> {
    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    const renew = (): void => {
      if (!lock.refresh()) {
        throw new SwitchEngineError(
          'another cctl process took the credential lock over while this change was running, ' +
            'and it stopped there',
          'lock_lost',
        );
      }
    };
    try {
      return await mutate(renew);
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
