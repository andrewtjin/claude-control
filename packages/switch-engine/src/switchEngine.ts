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
//      locked operation settles a slot's pending switch before it reads that slot.
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
  SlotError,
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
import { folderBindingsPath, groupProfileDir, profilesRoot, type Paths } from './paths.js';
import { atomicWriteFile, removeIfExists } from './fsutil.js';
import {
  canonicalizeFolder,
  checkBindTarget,
  exactBinding,
  folderKey,
  isWithin,
  resolveBinding,
} from './folderPath.js';
import { createNodeProfileFs, ensureGroupProfile, planGroupProfile } from './profile.js';
import {
  buildFolderBindingSnapshot,
  folderBindingSnapshotContentEqual,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
} from './folderBindings.js';
import { readdir, readFile, rm } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { groupSlotId } from './types.js';
import type {
  AccountView,
  ActivateResult,
  BindResult,
  ClaudeOauth,
  CredentialBundle,
  FolderBindingSnapshot,
  GroupLiveResult,
  OauthAccount,
  RecoverResult,
  RefreshTokenResult,
  ReloginResult,
  RepairResult,
  RunningSession,
  SlotId,
  SlotLiveToken,
  SlotViolation,
  StoredAccount,
  StoredGroup,
  SwitchIntent,
  UnbindResult,
} from './types.js';
import { needsMetadataBackfill, Vault, type DedupeReport } from './vault.js';
import type { StoredTokens } from './tokenPrints.js';

/** The filesystem seam {@link SwitchEngine.bindFolder} / {@link SwitchEngine.unbindFolder} use to
 *  canonicalize a folder and check it is a real directory. Injected (never read from `node:*`
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
  /** The user's home directory (`os.homedir()`), refused as a bind target. */
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
   *  to tell groups apart, the profiles-root containment check that refuses a capture inside a
   *  profile, and the macOS refusal of group slots (per-config-dir Keychain slots are not built
   *  yet). A parameter rather than a `process.platform` read so a test can drive either OS. */
  platform?: NodeJS.Platform;
  /** Filesystem seam for folder canonicalization in bind/unbind. Defaults to a `node:fs`-backed
   *  one; tests inject a sandbox-aware version (notably a controlled home dir). */
  bindFs?: BindFs;
  /** Process-liveness probe for the running-session scan. Defaults to a signal-0 check; tests inject
   *  a deterministic one. */
  isProcessAlive?: (pid: number) => boolean;
  /** The enforcement mode stamped into the guard snapshot written after every group mutation.
   *  Defaults to `'block'`. Pass a plain mode for a one-shot CLI process; pass a RESOLVER for a
   *  long-lived process (the daemon), which is called at each snapshot write so a live
   *  `cctl settings set bind-enforce <mode>` takes effect without a restart. A cached value would let
   *  a daemon-side snapshot rewrite (e.g. from repairSlots) revert an operator's live change. */
  bindEnforce?: BindEnforceMode | (() => BindEnforceMode);
  /** Fault-injection seam for the multi-step group mutations, called at labeled checkpoints so a
   *  test can throw partway through and prove the next `ensureGroupLive`/`repairSlots` converges.
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
  /** The slot this activation must land in. OMITTED is the norm: the slot is derived from the
   *  target's membership (a reserved account → its group's slot, a shared account → global), and
   *  the derived slot always wins. Passing one that DISAGREES with membership is refused rather
   *  than silently overridden — it is how a caller asserts "activate this account in THIS slot"
   *  and gets told when that is impossible (a reserved account can never be global; a non-member
   *  can never be a group). It cannot force a different slot; it can only fail fast on a mismatch. */
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

/** Whether two credential blocks are the same grant: both absent, or the same pair of tokens. */
function sameGrant(a: ClaudeOauth | undefined, b: ClaudeOauth | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.accessToken === b.accessToken && a.refreshToken === b.refreshToken;
}

/** What a slot's live files physically hold (see {@link SwitchEngine}'s `physicalLiveId`). */
interface PhysicalOccupant {
  /** The stored account the live login belongs to, or null (nobody, or a login not stored here). */
  id: string | null;
  hasCreds: boolean;
  /** The identity's uuid when it names no stored account. */
  foreignUuid?: string;
  /** Set when the credentials are provably `id`'s stored token while the identity block names a
   *  different account (`identityId`, or null for a login this vault does not know). */
  mismatch?: { identityId: string | null; identityUuid: string };
}

/** A profile dir no group owns that still holds a live login (see `orphanProfileLogins`). */
interface OrphanLogin {
  /** The dir's name — the id of the group that once owned it. */
  name: string;
  dir: string;
  store: CredentialStore;
  occupant: PhysicalOccupant;
}

/** The refusal of a capture whose config dir is a group profile: a {@link RefreshError} with a stable
 *  code, so the CLI can render guidance ("onboard in a throwaway dir") rather than a raw message. */
function captureInProfileError(configDir: string): RefreshError {
  return new RefreshError(
    `"${configDir}" is inside the folder-bound profiles area; onboard a new account in a ` +
      'throwaway config dir instead of a group profile',
    'capture_in_profile',
  );
}

/** Set equality by membership — the two account-id sets compare identical. */
function setsEqual(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/** A group's members as a display list for a refusal/violation message ("<label> + <label>"). */
function describeMembers(group: StoredGroup): string {
  const labels = group.members.map((m) => m.label);
  return labels.length > 0 ? labels.join(' + ') : group.label;
}

/** A group's bound folders as a display list, for "already reserved to <folders>" messages. */
function describeFolders(group: StoredGroup): string {
  return group.folders.length > 0 ? group.folders.join(', ') : describeMembers(group);
}

/** The order {@link SwitchEngine.ensureGroupLiveLocked} tries members in: the recorded active member
 *  first (continuity), then eligible members (not quarantined, not excluded), then quarantine-free but
 *  excluded members as a last resort — a quarantined member is never a candidate (its token is dead).
 *  De-duplicated so the recorded active member is not tried twice. */
function orderedGroupCandidates(group: StoredGroup): StoredAccount[] {
  const alive = group.members.filter((m) => !m.quarantined);
  const active = group.activeId !== null ? alive.filter((m) => m.id === group.activeId) : [];
  const eligible = alive.filter((m) => m.id !== group.activeId && m.autoSwitchExcluded !== true);
  const excludedFallback = alive.filter(
    (m) => m.id !== group.activeId && m.autoSwitchExcluded === true,
  );
  return [...active, ...eligible, ...excludedFallback];
}

/** Structural equality of two violations — enough to tell whether a breach the repair set out to fix
 *  is still present afterward (its kind, the account/group/slot it named). */
function sameViolation(a: SlotViolation, b: SlotViolation): boolean {
  return (
    a.kind === b.kind && a.accountId === b.accountId && a.groupId === b.groupId && a.slot === b.slot
  );
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
 * pre-upgrade build recovers unchanged; a group slot lives in the group's own profile dir with its
 * state under `<vaultDir>/slots/<groupId>/`. ONE lock (the vault-dir lock) still serialises every
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
  /** A group slot's config dir (materialised by {@link ensureGroupProfile} before a write); absent
   *  for the global slot. */
  profileDir?: string;
  /** The group id backing a group slot; absent for the global slot. */
  groupId?: string;
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
  /** Kept so per-slot rollback snapshots encrypt with the same protector the vault uses — a group
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
  // ---- read-only group / snapshot accessors (for the CLI's bindings / where / accounts views) ----
  //
  // The vault is private to the engine, but the CLI must read the folder-bound groups to render
  // `bindings`, tag `accounts`/`usage` with a binding, and resolve `where`. These are thin
  // pass-throughs (metadata reads, no decryption, no lock) so the CLI reaches the SAME configured
  // vault the engine already holds instead of constructing a second one with a duplicated protector.
  /** All folder-bound groups (full member rows). */
  listGroups(): Promise<StoredGroup[]> {
    return this.vault.listGroups();
  }
  /** One folder-bound group by id, or undefined. */
  getGroup(id: string): Promise<StoredGroup | undefined> {
    return this.vault.getGroup(id);
  }
  /** The shared pool AND every reserved member in one view; each reserved row carries its groupId. */
  listAllAccounts(): Promise<AccountView[]> {
    return this.vault.listAllAccounts();
  }
  /** The groups.json generation the snapshot is derived from — used to judge snapshot freshness. */
  getGroupsGeneration(): Promise<number> {
    return this.vault.getGroupsGeneration();
  }
  /** The non-secret guard snapshot as last written, or undefined when none exists yet. */
  readSnapshot(): Promise<FolderBindingSnapshot | undefined> {
    return this.vault.readFolderBindings();
  }
  addAccount(label: string, bundle: CredentialBundle): Promise<StoredAccount> {
    return this.withCredentialLock(() => this.vault.addAccount(label, bundle));
  }
  /**
   * Remove an account wherever it lives, and clean the group slot it occupied.
   *
   * The vault drops the row (dissolving an emptied group) and its bundle. On top of that, a member
   * that was LIVE in its group slot must not leave its credentials behind in the profile: a removed
   * account whose `.credentials.json` still sits live in a group's config dir is the stale live seat
   * the reservation fence exists to prevent. So its live files are cleared, failing that slot closed
   * (an empty config dir = not logged in — measured). The global slot is deliberately NOT cleared
   * this way: removing the global active account leaves its live files for the historical reasons the
   * vault's own active-id clearing already encodes. Removing a member rewrites the guard snapshot,
   * which names members and — when the removal dissolves the group — enforces its folders.
   *
   * ORDER is the crash-safety contract, and it is the one an unbind's dissolve uses: adopt the seat's
   * rotation, clear the seat, THEN drop the row. Dying after the clear leaves the account whole (row,
   * bundle holding its latest token) with an empty seat the group re-fills, and a rerun completes the
   * removal. The reverse order leaves the removed login live in the profile — and when the removal
   * dissolved the group, in a profile no slot owns, which nothing else would ever clear.
   */
  removeAccount(id: string): Promise<void> {
    return this.withCredentialLock(async () => {
      await this.settlePendingSwitchesLocked();
      const { slotId, group } = await this.slotForAccount(id);
      if (group === undefined) {
        await this.vault.removeAccount(id);
        return;
      }
      const rt = this.slotRuntime(slotId);
      // Only a member live in its own group slot has a seat to clear — or every seat of a group this
      // removal dissolves.
      const liveMember = await this.getActiveId(slotId);
      const dissolves = group.members.length === 1;
      if (liveMember === id || dissolves) {
        // Whatever rotation the seat holds reaches the vault first, so dying between here and the row
        // drop never costs the account its latest token.
        const liveNow = await rt.credStore.readLiveCredentials().catch(() => undefined);
        const liveOauth = await rt.credStore.readOauthAccount().catch(() => undefined);
        await this.adoptRotationIfNeeded(liveMember, liveNow, liveOauth);
        await this.clearSlotLive(rt);
        this.fault('remove:after-clear-live');
      }
      await this.vault.removeAccount(id);
      this.fault('remove:after-registry-drop');
      // A dissolved group's slot no longer exists: drop its recovery state too, so no intent is left
      // behind for a slot nothing will ever walk again (the same cleanup an unbind's dissolve does).
      if (dissolves) await this.clearSlotState(rt);
      // The guard names a group's members and enforces its folders; a removal changed one or both.
      // Written LAST, like every other group mutation.
      await this.writeSnapshotLocked();
    });
  }
  renameAccount(id: string, label: string): Promise<StoredAccount> {
    return this.withCredentialLock(async () => {
      const renamed = await this.vault.renameAccount(id, label);
      // A reserved member's label is part of what the guard's block reason shows.
      if ((await this.slotForAccount(id)).group !== undefined) await this.writeSnapshotLocked();
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
        // A merge or a relabel can change a reserved member's label, which the guard names.
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
   * the engine's own credential store and the vault dir (historical file names); a group slot is
   * addressed by the profile dir its id names, with its recovery state under `<vaultDir>/slots/<id>`.
   */
  private slotRuntime(slotId: SlotId): SlotRuntime {
    if (slotId === 'global') {
      return {
        id: slotId,
        credStore: this.credStore,
        intent: this.intent,
        stateDir: this.paths.vaultDir,
      };
    }
    const groupId = slotId.slice('group:'.length);
    const profileDir = groupProfileDir(this.paths.vaultDir, groupId);
    // A group slot is always FILE-based: it never uses the darwin Keychain channel (group slots are
    // refused on macOS), so a plain CredentialStore over the profile dir is the whole story.
    const credStore = this.configDirStore(profileDir);
    const stateDir = join(this.paths.vaultDir, 'slots', groupId);
    return {
      id: slotId,
      credStore,
      intent: new IntentStore(stateDir),
      stateDir,
      profileDir,
      groupId,
    };
  }

  /**
   * The slot an account BELONGS to, derived from membership: a reserved account's own group slot,
   * else the global slot. This is the routing authority for {@link activate} — a reserved account
   * is never live globally and a shared account never in a group, so the slot is a fact about the
   * account, not a caller's choice.
   */
  private async slotForAccount(id: string): Promise<{ slotId: SlotId; group?: StoredGroup }> {
    for (const g of await this.vault.listGroups()) {
      if (g.members.some((m) => m.id === id)) return { slotId: groupSlotId(g.id), group: g };
    }
    return { slotId: 'global' };
  }

  /** The registry side of one slot: the id it last recorded as active, and the accounts that may be
   *  active in it. Global = `{ vault.activeId, shared pool }`; a group = `{ group.activeId, members }`.
   *  A group that no longer exists yields `{ null, [] }` — nothing can be live in a slot with no
   *  registry backing. */
  private async slotRegistry(
    slotId: SlotId,
  ): Promise<{ registryId: string | null; candidates: StoredAccount[] }> {
    if (slotId === 'global') {
      const [registryId, candidates] = await Promise.all([
        this.vault.getActiveId(),
        this.vault.listAccounts(),
      ]);
      return { registryId, candidates };
    }
    const group = await this.vault.getGroup(slotId.slice('group:'.length));
    if (!group) return { registryId: null, candidates: [] };
    return { registryId: group.activeId, candidates: group.members };
  }

  /** Every slot that has a registry backing: the global slot plus one per group. The set
   *  {@link liveSlots}, {@link recover}, and {@link liveSlotOf} walk. */
  private async allSlotIds(): Promise<SlotId[]> {
    const ids: SlotId[] = ['global'];
    for (const g of await this.vault.listGroups()) ids.push(groupSlotId(g.id));
    return ids;
  }

  /**
   * The slot an account is live in RIGHT NOW (reconciled), or undefined when it is live nowhere.
   *
   * Walks every slot rather than only the account's own group slot: the whole point is to catch an
   * account that is live where it should not be, so that {@link refreshToken} never network-refreshes
   * a token some session is holding and a re-login heals the seat the account actually occupies.
   * Short-circuits on the first hit — the invariant is that there is at most one.
   */
  private async liveSlotOf(accountId: string): Promise<SlotId | undefined> {
    for (const slotId of await this.allSlotIds()) {
      if ((await this.getActiveId(slotId)) === accountId) return slotId;
    }
    return undefined;
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
   * Clear a GROUP slot's live seat: remove its `.credentials.json` and drop the `oauthAccount`
   * block, so the slot fails closed (an empty config dir is "not logged in" — measured). A no-op for
   * the global slot, which is never cleared this way. The profile dir itself is kept (its shared
   * links and history survive a member's removal or a group's dissolution).
   */
  private async clearSlotLive(rt: SlotRuntime): Promise<void> {
    if (rt.profileDir === undefined) return;
    await removeIfExists(join(rt.profileDir, '.credentials.json'));
    await rt.credStore.clearOauthAccount();
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
   * getter uses this so a group-live member is polled with its own fresh token instead of falling back
   * to the global tier-0 cache, which only ever describes the global account.
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

  /**
   * The config dir a managed spawn should run in for `accountId`, or `undefined` for a shared
   * account (which runs in the global/main config dir and inherits the global live login). This is
   * the `configDirForAccount` seam the daemon wires into the Agent SDK client: a reserved member
   * binds to its group's profile dir, so its session's per-request credential reads come from that
   * slot rather than the shared `~/.claude`.
   */
  async configDirForAccount(accountId: string): Promise<string | undefined> {
    const { group } = await this.slotForAccount(accountId);
    if (group === undefined) return undefined;
    return groupProfileDir(this.paths.vaultDir, group.id);
  }

  /**
   * The slot a session's launch-time `CLAUDE_CONFIG_DIR` names: the group whose profile dir the
   * config dir canonically equals, else the global slot. An absent, main, or unrecognized dir maps
   * to global. Canonicalized so a case difference or trailing separator still matches on Windows.
   */
  async slotForConfigDir(configDir: string | null | undefined): Promise<SlotId> {
    if (configDir === undefined || configDir === null || configDir === '') return 'global';
    const key = folderKey(this.canonReserved(configDir), this.platform);
    for (const g of await this.vault.listGroups()) {
      const profileKey = folderKey(
        this.canonReserved(groupProfileDir(this.paths.vaultDir, g.id)),
        this.platform,
      );
      if (key === profileKey) return groupSlotId(g.id);
    }
    return 'global';
  }

  /**
   * Resolve a spawn's working directory to the group it is bound to, or `null` for an unbound cwd
   * (which runs on the global slot). Canonicalizes leniently — an unresolvable cwd is simply
   * unbound, never an error — and applies §5's longest-match rule.
   */
  async resolveCwdBinding(cwd: string): Promise<{ groupId: string } | null> {
    const groups = await this.vault.listGroups();
    if (groups.length === 0) return null;
    const match = resolveBinding(
      this.canonReserved(cwd),
      groups.map((g) => ({ id: g.id, folders: g.folders })),
      this.platform,
    );
    return match === null ? null : { groupId: match.groupId };
  }

  // ---- group lifecycle (bind / unbind / ensure-live) ----
  //
  // These are the operator-facing verbs that create, tear down, and self-heal a folder-bound group.
  // Each runs the WHOLE operation under one credential lock (so nothing else moves a member mid-way)
  // and reaches the vault + slot internals directly, exactly as the switch state machine does — it
  // must NOT call the public `activate()`, which re-acquires the (non-reentrant) lock and would
  // deadlock. The step ORDER is the crash-safety contract (see each method) and every step is
  // idempotent, so a crash anywhere leaves a state the next `ensureGroupLive`/`repairSlots`
  // converges from without an account ever being live in two slots.

  /**
   * Bind a folder to a set of accounts, creating (or reusing) their group. The exact §7 order:
   *   1. canonicalize + validate the folder; resolve the members; refuse a member reserved to a
   *      DIFFERENT group (named), and refuse the folder if it is already bound to a group whose
   *      member set differs (unbind first); refuse a new group the registry caps would reject. Every
   *      refusal happens here, before step 2 has moved anything.
   *   2. if a to-be-member is live in the GLOBAL slot, move global OFF it first (adopting its
   *      rotation), refusing when no shared account remains to hold the global slot.
   *   3. move the member rows out of `accounts.json` into the group (groups.json first — the vault's
   *      crash-safe order).
   *   4. materialize the profile and make the group's slot live (iterating members).
   *   5. write the guard snapshot LAST.
   * Returns what moved plus the running sessions under the folder (the CLI warns they keep their old
   * account until relaunched).
   */
  async bindFolder(
    folder: string,
    accountIds: readonly string[],
    opts: { label?: string } = {},
  ): Promise<BindResult> {
    // A group slot is a second config dir; macOS has no per-config-dir credential slot yet, so
    // creating one there would silently share the global Keychain item. Refuse up front.
    if (this.platform === 'darwin') {
      throw new RefreshError(
        'folder-bound accounts are not supported on macOS yet (per-config-dir Keychain slots)',
        'group_slot_unsupported',
      );
    }
    const canonicalFolder = this.canonicalizeBindFolder(folder);
    // De-dupe the request but keep it non-empty and every id real; a bind of nothing, or of a
    // typo'd id, is a mistake to reject before anything moves.
    const requestedIds = [...new Set(accountIds)];
    if (requestedIds.length === 0)
      throw new RefreshError('bind needs at least one account', 'bind_no_accounts');

    return this.withCredentialLock(async () => {
      // Who is live where decides the global hand-off below, so no slot may be left mid-switch.
      await this.settlePendingSwitchesLocked();
      const requested: StoredAccount[] = [];
      for (const id of requestedIds) {
        const row = await this.vault.getAccount(id);
        if (!row) throw new UnknownAccountError(id);
        requested.push(row);
      }
      const requestedSet = new Set(requestedIds);
      const groups = await this.vault.listGroups();

      // Refuse any requested account already reserved to a group whose member set differs from this
      // request — that account belongs to another folder's set and must be unbound there first.
      for (const req of requested) {
        const owner = groups.find((g) => g.members.some((m) => m.id === req.id));
        if (owner && !setsEqual(new Set(owner.members.map((m) => m.id)), requestedSet)) {
          throw new RefreshError(
            `account "${req.label}" is already reserved to ${describeFolders(owner)}; unbind it there first`,
            'account_reserved_elsewhere',
          );
        }
      }

      // The group whose member set is EXACTLY the request (if any) is the one we reuse.
      const matching = groups.find((g) =>
        setsEqual(new Set(g.members.map((m) => m.id)), requestedSet),
      );
      // If this folder is already bound, it must be bound to that same group — otherwise the request
      // is trying to point one folder at two different account sets.
      const exactOwnerId = exactBinding(canonicalFolder, groups, this.platform);
      if (exactOwnerId !== null && exactOwnerId !== matching?.id) {
        const owner = groups.find((g) => g.id === exactOwnerId)!;
        throw new RefreshError(
          `"${canonicalFolder}" is already bound to ${describeMembers(owner)}; unbind it first`,
          'folder_bound_elsewhere',
        );
      }

      let group: StoredGroup;
      let created: boolean;
      let movedOffGlobal: string | null = null;
      let globalSwitchedTo: string | null = null;

      if (matching !== undefined) {
        // Reuse: the members are already reserved to this group, so only the folder is new. A member
        // of an existing group can never be globally live, so step 2 does not apply here.
        group =
          exactOwnerId === matching.id
            ? matching
            : await this.vault.addFolderToGroup(matching.id, canonicalFolder);
        created = false;
      } else {
        // Every refusal the group creation below can make (group count, member count, folder
        // conflicts) is checked NOW, before the global hand-off: a bind that was always going to be
        // refused must not first move the global slot off an account and then leave it moved.
        await this.vault.checkCreateGroup({ memberIds: requestedIds, folders: [canonicalFolder] });
        // New group: a requested member may be the GLOBAL live account. Move global off it FIRST
        // (while it is still a shared account activate() can route to global), so it is live nowhere
        // at the instant its row moves into the group.
        const globalLive = await this.getActiveId('global');
        if (globalLive !== null && requestedSet.has(globalLive)) {
          const replacement = this.pickGlobalReplacement(
            await this.vault.listAccounts(),
            requestedSet,
          );
          if (replacement === undefined) {
            throw new RefreshError(
              `cannot bind: "${requested.find((r) => r.id === globalLive)!.label}" is the only usable ` +
                'shared account, so moving it into a folder would leave the global slot with none',
              'no_shared_account_remains',
            );
          }
          // Deliberate operator move: force past the cadence guard (a bind should never be blocked by
          // a recent hop) and adopt the outgoing account's rotation, which activateInSlot does for the
          // previous live account automatically.
          const globalRt = this.slotRuntime('global');
          const res = await this.activateInSlot(globalRt, replacement.id, {
            force: true,
            origin: 'manual',
            reason: 'freeing the global slot for a folder bind',
          });
          movedOffGlobal = globalLive;
          globalSwitchedTo = res.activeAccountId;
        }
        this.fault('bind:after-global-switch');
        group = await this.vault.createGroup({
          memberIds: requestedIds,
          folders: [canonicalFolder],
          ...(opts.label !== undefined ? { label: opts.label } : {}),
        });
        created = true;
      }

      this.fault('bind:after-row-move');
      // Materialize the profile and make the slot live (iterating members). ensureGroupLiveLocked
      // runs ensureGroupProfile itself, so the profile exists before any live write.
      const live = await this.ensureGroupLiveLocked(group);
      this.fault('bind:after-ensure-live');

      // The snapshot the guard reads is written LAST, from the freshly-loaded group set.
      await this.writeSnapshotLocked();

      const runningSessions = await this.runningSessionsUnder([canonicalFolder]);
      return { group, created, movedOffGlobal, globalSwitchedTo, live, runningSessions };
    });
  }

  /**
   * Unbind a folder. Removing a group's LAST folder dissolves it; removing one of several just drops
   * that binding. A dissolve refuses (without `force`) when a session is observed running under the
   * group's folders — the profile's live credentials are about to be cleared, and a running session
   * would lose its account. On dissolve: adopt the profile's rotation into the vault, clear the
   * profile's live credentials (so the slot fails closed), move the member rows back to the shared
   * pool, discard the slot's crash-recovery state, and keep the profile dir (its history). The
   * snapshot is rewritten LAST.
   */
  async unbindFolder(folder: string, opts: { force?: boolean } = {}): Promise<UnbindResult> {
    const canonicalFolder = this.canonicalizeBindFolder(folder, { mustExist: false });
    return this.withCredentialLock(async () => {
      await this.settlePendingSwitchesLocked();
      const groups = await this.vault.listGroups();
      const ownerId = exactBinding(canonicalFolder, groups, this.platform);
      if (ownerId === null) {
        throw new RefreshError(
          `"${canonicalFolder}" is not bound to any folder-bound account`,
          'not_bound',
        );
      }
      const group = groups.find((g) => g.id === ownerId)!;

      // Removing one of several folders keeps the group (and its live slot) intact — no session
      // concern, no member move.
      if (group.folders.length > 1) {
        const updated = await this.vault.removeFolderFromGroup(group.id, canonicalFolder);
        await this.writeSnapshotLocked();
        return {
          folder: canonicalFolder,
          dissolved: false,
          group: updated,
          releasedMembers: [],
          adoptedRotation: false,
          runningSessions: [],
        };
      }

      // Last folder: dissolve. Observed sessions block a non-forced dissolve.
      const runningSessions = await this.runningSessionsUnder(group.folders);
      if (runningSessions.length > 0 && opts.force !== true) {
        throw new RefreshError(
          `"${canonicalFolder}" (${describeMembers(group)}) has ${runningSessions.length} running ` +
            'session(s) under it; exit them or rerun with --force',
          'sessions_running',
        );
      }

      const slotId = groupSlotId(group.id);
      const rt = this.slotRuntime(slotId);
      // Adopt any CLI-side rotation of the profile's live token before it is discarded — the same
      // reconcile-by-reading a switch does, so a token minted inside the profile is never lost.
      const currentLive = await this.getActiveId(slotId);
      const liveNow = await rt.credStore.readLiveCredentials();
      const liveOauth = await rt.credStore.readOauthAccount();
      const adoptedRotation = await this.adoptRotationIfNeeded(currentLive, liveNow, liveOauth);
      this.fault('unbind:after-adopt');

      // Clear the profile's live seat (fails the slot closed) and drop its crash-recovery state; the
      // profile dir itself stays for history.
      await this.clearSlotLive(rt);
      await this.clearSlotState(rt);
      this.fault('unbind:after-clear-live');

      const releasedMembers = group.members.map((m) => m.id);
      await this.vault.releaseAccounts(group.id, releasedMembers);
      this.fault('unbind:after-release');

      await this.writeSnapshotLocked();
      return {
        folder: canonicalFolder,
        dissolved: true,
        releasedMembers,
        adoptedRotation,
        runningSessions,
      };
    });
  }

  /**
   * Ensure a group's slot has a working live member — the self-healing verb launch, managed spawn,
   * and the daemon poll all call. Acquires the lock; see {@link ensureGroupLiveLocked} for the
   * mechanism. Throws {@link UnknownAccountError} if the group no longer exists.
   */
  async ensureGroupLive(groupId: string): Promise<GroupLiveResult> {
    return this.withCredentialLock(async () => {
      const group = await this.vault.getGroup(groupId);
      if (!group) throw new UnknownAccountError(groupId);
      return this.ensureGroupLiveLocked(group);
    });
  }

  /**
   * Make a group's slot live, assuming the caller holds the credential lock. Idempotent: if a member
   * is already correctly live (identity present AND live credentials on disk) it only heals a drifted
   * `activeId`; otherwise it activates the first usable member — preferring the recorded `activeId`,
   * then eligible members (not quarantined, not excluded), finally a quarantine-free but excluded
   * member so a group whose only members are all excluded still comes up rather than sitting dead
   * (exclusion governs UNATTENDED targeting, not whether an account may hold its own group's slot).
   * When every attempt fails the binding still stands, and the result says the folder has no working
   * account.
   */
  private async ensureGroupLiveLocked(group: StoredGroup): Promise<GroupLiveResult> {
    const slotId = groupSlotId(group.id);
    const rt = this.slotRuntime(slotId);
    // The profile must exist before any live read/write; idempotent, so it costs nothing steady-state.
    if (rt.profileDir !== undefined) {
      ensureGroupProfile(rt.profileDir, this.paths.claudeDir, {
        logger: this.log,
        mainClaudeJsonPath: this.paths.claudeJsonPath,
      });
    }
    // A switch left unfinished in this slot is settled before the slot is read (a no-op when none).
    await this.recoverSlot(rt);

    const liveMember = await this.getActiveId(slotId);
    const liveCreds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    if (liveMember !== null && group.members.some((m) => m.id === liveMember) && liveCreds) {
      // A member is genuinely live. If the registry drifted from it (an external /login), commit the
      // reconciled member — a same-account heal, cadence-exempt and adoption-safe.
      if (group.activeId !== liveMember) {
        await this.activateInSlot(rt, liveMember, {
          force: true,
          origin: 'recovery',
          reason: 'reconciling group active id with the live login',
        });
      }
      return { groupId: group.id, liveMember, activated: false, noWorkingAccount: false };
    }

    // No usable member is live: try members in priority order until one activates.
    for (const member of orderedGroupCandidates(group)) {
      try {
        await this.activateInSlot(rt, member.id, {
          force: true,
          origin: 'recovery',
          reason: 'ensuring the group slot has a live member',
        });
        return {
          groupId: group.id,
          liveMember: member.id,
          activated: true,
          noWorkingAccount: false,
        };
      } catch (err) {
        // A process that died mid-activation does not go on to the next member.
        if (this.isSimulatedDeath(err)) throw err;
        // A dead token (quarantine) or a transient failure on one member must not stop the others.
        this.log.warn(
          { groupId: group.id, memberId: member.id, reason: errorReason(err) },
          'group member failed to activate; trying the next',
        );
      }
    }

    // No member could be seated. Any credentials still physically live in the profile at this point
    // belong to a non-member or an unrecognized login: a rightful member would have been reconciled
    // by the early return above (getActiveId recognizes a live member — quarantined or not — and its
    // credentials, so it never reaches here). Fail the slot closed by clearing that squatter, so a
    // session started in the bound folder is "not logged in" rather than silently running as an
    // account the folder does not reserve. This mirrors the global slot's clear-when-no-replacement
    // fallback (see repairGlobalSlot / clearGlobalLive) and preserves the "at most one slot" and
    // reserved-fence invariants that repairSlots is contracted to heal.
    const squatterCreds = await rt.credStore.readLiveCredentials().catch(() => undefined);
    if (squatterCreds) {
      await this.clearSlotLive(rt);
      return {
        groupId: group.id,
        liveMember: null,
        activated: false,
        noWorkingAccount: true,
        clearedSquatter: true,
      };
    }
    return { groupId: group.id, liveMember: null, activated: false, noWorkingAccount: true };
  }

  // ---- invariant checker (checkSlots / repairSlots) ----

  /**
   * The single authority for "is any slot in an illegal state", read by both `cctl doctor` and the
   * daemon watchdog. Read-only, apart from keeping the token-fingerprint cache current (see
   * tokenPrints.ts). Reports the §7 (a)-(e) violations, a slot whose live token and
   * identity name different accounts, a profile no group owns that is still logged in, and a token
   * stored under two accounts; {@link repairSlots} fixes all but (e) and the last.
   *
   * Slot occupancy is read PHYSICALLY here (the live token, then the live identity block, matched
   * against the WHOLE registry — see {@link physicalLiveId}), not through {@link getActiveId} —
   * because getActiveId only recognizes an account that is a candidate for the slot and goes by the
   * identity block alone, and the whole point of the check is to catch an account living where it is
   * NOT a candidate (a reserved account squatting in global, a non-member in a group profile) or
   * where the identity block misnames it.
   */
  async checkSlots(): Promise<SlotViolation[]> {
    return this.computeViolations();
  }

  /**
   * Repair the invariant breaches {@link checkSlots} finds, under the lock. Fixes (a)-(d):
   *   - adopt the freshest live token (identity-guarded) for every KNOWN account that is live
   *     anywhere, so a rotation is preserved before any slot is overwritten;
   *   - move the global slot off a reserved account onto a shared one (or clear it if none remains);
   *   - re-seat a slot whose live token and identity name different accounts;
   *   - re-activate each group slot's rightful member, evicting a non-member;
   *   - clear the live login of a profile no group owns (after adopting its rotation).
   * Unrecognized logins are never adopted (alert only), broken profile links (e) are left to
   * `ensureGroupProfile`, and a token stored under two accounts cannot be told apart from the files;
   * all three are reported in `remaining`. A hostile registry cannot widen access: every write only
   * ever makes a slot hold an account that is RIGHTFULLY its own.
   */
  async repairSlots(): Promise<RepairResult> {
    return this.withCredentialLock(async () => {
      // An unfinished switch is settled by its own intent, which knows more than any repair below.
      await this.settlePendingSwitchesLocked();
      const before = await this.computeViolations();
      if (before.length === 0) {
        // No slot to move — but the snapshot can still lag the registry (a crash between a group
        // write and its snapshot write leaves every slot legal). Converge that too, or the guard
        // keeps enforcing a binding set that no longer exists until something else rewrites it.
        const rewrote = await this.refreshSnapshotIfStaleLocked();
        return {
          repaired: [],
          remaining: [],
          actions: rewrote ? ['rewrote the stale folder-bindings snapshot'] : [],
        };
      }

      const actions: string[] = [];
      const allRows = await this.vault.listAllAccounts();
      const groups = await this.vault.listGroups();
      const stored = await this.vault.readStoredTokens();

      // Step 1: adopt the freshest rotation for every known account that is live in any slot. Applied
      // per (account, slot); adoption only replaces the vault copy when the live token is newer, so
      // running it across all slots lands the freshest regardless of order.
      for (const slotId of await this.allSlotIds()) {
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

      // Step 2: a slot whose token and identity name different accounts is re-seated before anything
      // below reads it, because everything below goes by the identity block.
      for (const slotId of await this.allSlotIds()) {
        const rt = this.slotRuntime(slotId);
        const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
        if (phys.mismatch !== undefined && phys.id !== null) {
          await this.reseatMismatchedSlot(rt, phys.id, allRows, groups, actions);
        }
      }

      // Step 3: reconcile the global slot to a SHARED account (evict any reserved squatter).
      await this.repairGlobalSlot(allRows, stored, actions);

      // Step 4: reconcile each group slot to its rightful member (evicting a non-member).
      for (const group of groups) {
        const res = await this.ensureGroupLiveLocked(group);
        if (res.activated) actions.push(`re-activated a member in ${describeMembers(group)}`);
        else if (res.clearedSquatter)
          actions.push(`cleared a non-member login from ${describeMembers(group)}`);
      }

      // Step 5: a profile no group owns may not keep a login live.
      await this.clearOrphanProfileLogins(allRows, groups, stored, actions);

      // Snapshot LAST — an activeId may have moved (its generation is what freshness checks read).
      await this.writeSnapshotLocked();

      const after = await this.computeViolations();
      const repaired = before.filter((b) => !after.some((a) => sameViolation(a, b)));
      return { repaired, remaining: after, actions };
    });
  }

  /** Compute the current slot violations. Shared by {@link checkSlots} (unlocked read) and
   *  {@link repairSlots} (already under the lock), so the repair decides against the same picture it
   *  will report. */
  private async computeViolations(): Promise<SlotViolation[]> {
    const violations: SlotViolation[] = [];
    const allRows = await this.vault.listAllAccounts();
    const groups = await this.vault.listGroups();
    const stored = await this.vault.readStoredTokens();
    const labelOf = (id: string): string => allRows.find((r) => r.id === id)?.label ?? id;
    const groupIdOf = (id: string): string | undefined => allRows.find((r) => r.id === id)?.groupId;
    const slotLabel = (slotId: SlotId): string => {
      const group = groups.find((g) => groupSlotId(g.id) === slotId);
      return group === undefined ? 'the global slot' : describeMembers(group);
    };

    // Physical occupancy of every slot.
    const physical = new Map<SlotId, PhysicalOccupant>();
    for (const slotId of await this.allSlotIds()) {
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
      if (phys.mismatch === undefined || phys.id === null) continue;
      const named =
        phys.mismatch.identityId !== null
          ? `"${labelOf(phys.mismatch.identityId)}"`
          : `an unrecognized login (${phys.mismatch.identityUuid})`;
      trailing.push({
        kind: 'live_identity_mismatch',
        accountId: phys.id,
        slot: slotId,
        ...(slotId !== 'global' ? { groupId: slotId.slice('group:'.length) } : {}),
        detail: `${slotLabel(slotId)} holds the credentials of "${labelOf(phys.id)}" but its identity names ${named}`,
      });
    }

    // One token stored under two accounts: the state a mis-attributed adoption leaves behind.
    for (const ids of stored.sharedTokens()) {
      trailing.push({
        kind: 'duplicate_stored_token',
        accountId: ids[0]!,
        detail:
          `accounts ${ids.map((id) => `"${labelOf(id)}"`).join(' and ')} store the same login ` +
          'token: either one login was stored twice (remove the extra account) or one of them holds ' +
          "the other's token (re-login that one: cctl accounts relogin <label>)",
      });
    }

    // A profile no group owns that is still logged in.
    for (const orphan of await this.orphanProfileLogins(allRows, groups, stored)) {
      trailing.push({
        kind: 'orphan_profile_login',
        ...(orphan.occupant.id !== null ? { accountId: orphan.occupant.id } : {}),
        groupId: orphan.name,
        detail:
          `${orphan.dir}, a profile no binding owns any more, still holds a live login` +
          (orphan.occupant.id !== null ? ` of "${labelOf(orphan.occupant.id)}"` : ''),
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
          detail: `account "${labelOf(id)}" is live in ${slots.join(' and ')}`,
        });
      }
    }

    // (b) a reserved account live in the global slot.
    const globalPhys = physical.get('global')!;
    if (globalPhys.id !== null) {
      const gid = groupIdOf(globalPhys.id);
      if (gid !== undefined) {
        violations.push({
          kind: 'reserved_live_in_global',
          accountId: globalPhys.id,
          slot: 'global',
          groupId: gid,
          detail: `reserved account "${labelOf(globalPhys.id)}" is live in the global slot`,
        });
      }
    }

    for (const group of groups) {
      const slotId = groupSlotId(group.id);
      const phys = physical.get(slotId)!;
      if (phys.id !== null) {
        const isMember = group.members.some((m) => m.id === phys.id);
        if (!isMember) {
          // (c) a known account that is not a member is live in this profile.
          violations.push({
            kind: 'nonmember_live_in_group',
            accountId: phys.id,
            slot: slotId,
            groupId: group.id,
            detail: `non-member "${labelOf(phys.id)}" is live in ${describeMembers(group)}`,
          });
        } else if (group.activeId !== phys.id) {
          // (d) the profile's live identity is a different member than the group recorded.
          violations.push({
            kind: 'group_active_mismatch',
            accountId: phys.id,
            slot: slotId,
            groupId: group.id,
            detail: `${describeMembers(group)} records ${group.activeId === null ? 'no member' : `"${labelOf(group.activeId)}"`} live, but "${labelOf(phys.id)}" is`,
          });
        }
      } else if (phys.hasCreds && phys.foreignUuid !== undefined) {
        // (c') an unrecognized login is live in a group profile — alert only (never adopted).
        violations.push({
          kind: 'nonmember_live_in_group',
          slot: slotId,
          groupId: group.id,
          detail: `an unrecognized login (${phys.foreignUuid}) is live in ${describeMembers(group)}`,
        });
      }

      // (e) broken profile links — a read-only plan tells us without touching anything.
      for (const v of this.brokenLinkViolations(group)) violations.push(v);
    }

    violations.push(...trailing);
    return violations;
  }

  /** Read-only detection of §7 (e): any shared file in the group's profile whose hard link to main
   *  is broken (`ensureGroupProfile` rebuilds these; `repairSlots` does not). Best-effort — a fault
   *  probing the profile is swallowed, since the check must never throw on the doctor's read path. */
  private brokenLinkViolations(group: StoredGroup): SlotViolation[] {
    const rt = this.slotRuntime(groupSlotId(group.id));
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
          slot: groupSlotId(group.id),
          groupId: group.id,
          detail: `${describeMembers(group)} has broken profile links: ${broken.join(', ')}`,
        },
      ];
    } catch (err) {
      this.log.debug({ groupId: group.id, reason: errorReason(err) }, 'broken-link probe failed');
      return [];
    }
  }

  /** Move the global slot off a reserved account, if one is squatting there. Adoption already ran
   *  (repairSlots step 1), so the squatter's rotation is safe; here we only re-seat global onto a
   *  shared account, or clear it (fail closed) when none remains. A shared account in global, an
   *  empty global, or an unrecognized login in global are all left alone — none breaches the fence. */
  private async repairGlobalSlot(
    allRows: AccountView[],
    stored: StoredTokens,
    actions: string[],
  ): Promise<void> {
    const rt = this.slotRuntime('global');
    const phys = await this.physicalLiveId(rt.credStore, allRows, stored);
    if (phys.id === null) return; // empty or unrecognized login — not a fence breach.
    const squatter = allRows.find((r) => r.id === phys.id);
    if (squatter?.groupId === undefined) return; // a shared account belongs in global.

    const replacement = this.pickGlobalReplacement(
      allRows.filter((r) => r.groupId === undefined),
      new Set(),
    );
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
   * against the WHOLE registry so a reserved/non-member login is recognized.
   *
   * The token decides first: a live token equal to a stored account's token IS that account's login,
   * whatever the identity block beside it says — the token is the one artifact that cannot be stale.
   * When it also contradicts the identity block, provably (the block names a different stored
   * account, or the owner's recorded uuid differs from the one named), the result carries a
   * `mismatch`: a switch torn between its two writes that no intent describes. An owner with no
   * recorded uuid beside an unknown one is not treated as a contradiction: that is most likely Claude
   * Code's own re-derived block for that very login.
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
    const oauth = await credStore.readOauthAccount().catch(() => undefined);
    const uuid = anchorValue(oauth?.accountUuid);
    const named = uuid !== undefined ? allRows.find((r) => r.accountUuid === uuid) : undefined;
    const holders = stored.holdersOf(live);
    if (holders.length > 0) {
      const owner = named !== undefined && holders.includes(named.id) ? named.id : holders[0]!;
      const ownerUuid = allRows.find((r) => r.id === owner)?.accountUuid;
      const contradicted =
        uuid !== undefined && (named !== undefined ? named.id !== owner : ownerUuid !== undefined);
      if (!contradicted) return { id: owner, hasCreds: true };
      return {
        id: owner,
        hasCreds: true,
        mismatch: { identityId: named?.id ?? null, identityUuid: uuid },
      };
    }
    if (named !== undefined) return { id: named.id, hasCreds: true };
    if (uuid !== undefined) return { id: null, hasCreds: true, foreignUuid: uuid };
    // Credentials with no identity block name nobody we can attribute — not a violation we can act on.
    return { id: null, hasCreds: true };
  }

  /**
   * Re-seat a slot whose live token belongs to `ownerId` while its identity block names someone else
   * (see {@link physicalLiveId}). When the owner may hold this slot it is activated there: its own
   * token is what is live, so this rewrites the identity to match and commits it — nothing is
   * adopted, because adoption refuses a token another account stores. When it may not, the slot's
   * rightful account is put back: for a group, a member here (the per-group step that follows goes by
   * the identity block and would take the member it names for live); for the global slot the reserved
   * owner is evicted by {@link repairGlobalSlot}, which reads the token the same way.
   */
  private async reseatMismatchedSlot(
    rt: SlotRuntime,
    ownerId: string,
    allRows: AccountView[],
    groups: StoredGroup[],
    actions: string[],
  ): Promise<void> {
    const owner = allRows.find((r) => r.id === ownerId);
    const group = rt.groupId === undefined ? undefined : groups.find((g) => g.id === rt.groupId);
    const where = group === undefined ? 'the global slot' : describeMembers(group);
    const reason = "re-seating a slot whose credentials were under another account's identity";
    if (owner !== undefined && owner.groupId === rt.groupId) {
      await this.activateInSlot(rt, owner.id, { force: true, origin: 'recovery', reason });
      actions.push(
        `re-seated "${owner.label}" in ${where}; its credentials were under another identity`,
      );
      return;
    }
    if (group === undefined) return; // a reserved owner in global: repairGlobalSlot evicts it
    for (const member of orderedGroupCandidates(group)) {
      try {
        await this.activateInSlot(rt, member.id, { force: true, origin: 'recovery', reason });
        actions.push(`restored "${member.label}" in ${where} over another account's credentials`);
        return;
      } catch (err) {
        if (this.isSimulatedDeath(err)) throw err;
        this.log.warn(
          { groupId: group.id, memberId: member.id, reason: errorReason(err) },
          'group member failed to activate over a mismatched login; trying the next',
        );
      }
    }
    await this.clearSlotLive(rt);
    actions.push(`cleared another account's credentials from ${where} (no member could take it)`);
  }

  /**
   * Profile dirs no group owns that still hold a live login (`orphan_profile_login`). A dissolved
   * group's profile is kept for its history with its live seat cleared; one still logged in is what
   * an interrupted removal by an older build leaves, and it is no slot — nothing else reads it, so the
   * login would sit there, a second live copy of an account's token, for good. Cheap: one directory
   * listing, and one read of a missing file per dissolved profile.
   */
  private async orphanProfileLogins(
    allRows: AccountView[],
    groups: StoredGroup[],
    stored: StoredTokens,
  ): Promise<OrphanLogin[]> {
    const root = profilesRoot(this.paths.vaultDir);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return []; // no profiles root yet: nothing was ever bound
    }
    const fold = (name: string): string => (this.platform === 'win32' ? name.toLowerCase() : name);
    const owned = new Set(
      groups.map((g) => fold(basename(groupProfileDir(this.paths.vaultDir, g.id)))),
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

  /** Clear the live login of every orphaned profile (see {@link orphanProfileLogins}), adopting its
   *  rotation first when it provably belongs to a stored account — the adopt-then-clear order a
   *  dissolve uses, so clearing never costs an account its latest token. */
  private async clearOrphanProfileLogins(
    allRows: AccountView[],
    groups: StoredGroup[],
    stored: StoredTokens,
    actions: string[],
  ): Promise<void> {
    for (const orphan of await this.orphanProfileLogins(allRows, groups, stored)) {
      if (orphan.occupant.id !== null && orphan.occupant.mismatch === undefined) {
        const liveNow = await orphan.store.readLiveCredentials().catch(() => undefined);
        const liveOauth = await orphan.store.readOauthAccount().catch(() => undefined);
        await this.adoptRotationIfNeeded(orphan.occupant.id, liveNow, liveOauth);
      }
      await orphan.store.clearLiveCredentials();
      await orphan.store.clearOauthAccount();
      const who = allRows.find((r) => r.id === orphan.occupant.id)?.label;
      actions.push(
        `cleared ${who !== undefined ? `"${who}"'s` : 'a'} login from ${orphan.dir}, a profile no binding owns`,
      );
    }
  }

  // ---- group-lifecycle helpers ----

  /** Canonicalize an operator-supplied folder for a bind/unbind, refusing the same targets §5
   *  reserves. `mustExist` is relaxed for unbind (the folder may since have been deleted, but its
   *  binding still needs clearing). Throws a `bind_refused` {@link RefreshError} on any refusal. */
  private canonicalizeBindFolder(folder: string, opts: { mustExist?: boolean } = {}): string {
    const canon = canonicalizeFolder(folder, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
      realpath: this.bindFs.realpath,
    });
    if (!canon.ok) {
      throw new RefreshError(`cannot use folder "${folder}": ${canon.reason}`, 'bind_refused');
    }
    // The reserved-target rules (root/home/overlaps-cctl) apply to a bind, where a real directory is
    // required. For unbind we skip the existence check but keep the structural refusals meaningless
    // to re-check (a non-bound folder is caught later by exactBinding).
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
        throw new RefreshError(`cannot bind "${canon.path}": ${check.reason}`, 'bind_refused');
      }
    }
    return canon.path;
  }

  /** Canonicalize a cctl-internal reserved path for containment checks — same rules as a bind target,
   *  but falling back to the raw path when it does not exist yet (the profiles root has no directory
   *  until the first bind). */
  private canonReserved(path: string): string {
    const canon = canonicalizeFolder(path, {
      platform: this.platform,
      cwd: this.bindFs.cwd(),
      realpath: this.bindFs.realpath,
    });
    return canon.ok ? canon.path : path;
  }

  /** Pick the best shared account to hold the global slot, excluding a set of ids (the members being
   *  reserved). Prefers a non-excluded, non-quarantined account, then any non-quarantined one — a
   *  deliberate global move may land on an auto-switch-excluded account, since exclusion governs only
   *  unattended targeting. `undefined` when no usable shared account remains. */
  private pickGlobalReplacement(
    shared: readonly StoredAccount[],
    exclude: ReadonlySet<string>,
  ): StoredAccount | undefined {
    const usable = shared.filter((a) => !exclude.has(a.id) && !a.quarantined);
    return usable.find((a) => a.autoSwitchExcluded !== true) ?? usable[0];
  }

  /** Clear the GLOBAL slot's live seat (remove `.credentials.json`, drop the identity block) so it
   *  fails closed. Reached only by repair when a reserved account squats in global and no shared
   *  account remains — never on the darwin Keychain path, which has no group slots to trigger it. */
  private async clearGlobalLive(): Promise<void> {
    await removeIfExists(this.paths.credentialsPath);
    await this.credStore.clearOauthAccount();
  }

  /** Discard a group slot's crash-recovery state (intent WAL, rollback snapshot, cadence clock) on
   *  dissolution — the slot is going away, so leaving `slots/<groupId>/` behind would strand an
   *  orphaned intent that a later `recover()` could act on. */
  private async clearSlotState(rt: SlotRuntime): Promise<void> {
    if (rt.groupId === undefined) return; // never wipe the global slot's historical state
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
    const [groups, generation] = await Promise.all([
      this.vault.listGroups(),
      this.vault.getGroupsGeneration(),
    ]);
    return buildFolderBindingSnapshot({
      groups,
      generation,
      enforce: this.resolveBindEnforce(),
      mainConfigDir: this.canonReserved(this.paths.claudeDir),
      profileDirOf: (groupId) => this.canonReserved(groupProfileDir(this.paths.vaultDir, groupId)),
    });
  }

  /** Rewrite the guard snapshot from the current registry, assuming the lock is held. Called LAST in
   *  every group mutation. */
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
   * maintenance calls, so a snapshot left stale — a crash between a group write and its snapshot
   * write, an offline registry edit — is healed within one cycle rather than at the next restart or
   * the next group mutation. The steady-state check is lock-free; the lock is taken only to rewrite,
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
   * CONTENT, not by the groups generation: a routine group member switch bumps the generation on
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
   *  profile would capture (and could overwrite) a group slot's live seat. */
  private isInsideProfilesRoot(configDir: string): boolean {
    return isWithin(configDir, profilesRoot(this.paths.vaultDir), this.platform);
  }

  /** Refuse a capture whose config dir sits inside the profiles root (see
   *  {@link isInsideProfilesRoot}). A {@link RefreshError} with a stable code so the CLI can render
   *  guidance ("onboard in a throwaway dir, not a group profile") rather than a raw message. */
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
    // this is a read path callers hit on every listing and poll cycle. For a group slot the block
    // read is the profile's own `.claude.json`, so each slot reconciles against ITS OWN identity.
    const live = await rt.credStore.readOauthAccount().catch(() => undefined);
    const liveUuid = live?.accountUuid;
    if (liveUuid === undefined) return registryId;
    // Only this slot's candidates can be live in it: a group reconciles against its members, global
    // against the shared pool. A uuid that matches no candidate is a login this slot never owned.
    const matches = candidates.filter((a) => a.accountUuid === liveUuid);
    if (matches.some((m) => m.id === registryId)) return registryId;
    if (registryId !== null && (await this.liveTokenBelongsTo(registryId, rt.credStore)))
      return registryId;
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
  private async liveTokenBelongsTo(
    accountId: string,
    credStore: CredentialStore,
  ): Promise<boolean> {
    const live = await credStore.readLiveCredentials().catch(() => undefined);
    if (!live) return false;
    const bundle = await this.vault.readBundle(accountId).catch(() => undefined);
    return bundle?.claudeAiOauth.refreshToken === live.refreshToken;
  }

  /**
   * Capture whatever is currently logged in as a new stored account. Used by
   * `cctl accounts add` right after an interactive login populated the live files.
   */
  async captureCurrentLogin(label: string): Promise<StoredAccount> {
    // A capture reads whoever is live in THIS config dir. Run inside a group profile, that seat is a
    // group's live credentials — onboarding always uses a throwaway dir, so a config dir pointing
    // into the profiles root is a mistake to refuse, not a login to capture. The session's OWN config
    // dir is checked too: inside a bound session the paths are seen through to the main dir, so
    // `claudeDir` alone would capture the main dir's login instead of the one just made in the
    // profile — and report it as if it were the new one.
    this.refuseCaptureInProfile(this.paths.claudeDir);
    // Set only when the environment's config dir IS a group profile (defaultPaths decided that by
    // the same profiles-root rule), so it is refused outright rather than re-derived here.
    if (this.paths.profileConfigDir !== undefined) {
      throw captureInProfileError(this.paths.profileConfigDir);
    }
    // Locked for the whole capture: the add + setActive pair below are two registry writes that
    // must land as one atomic unit, and reading the live login while a switch is mid-flight would
    // otherwise see a torn set of credential files.
    return this.withCredentialLock(async () => {
      // A switch left between its two live writes would be captured as one account's token under
      // another's identity; it is settled first.
      await this.settlePendingSwitchesLocked(['global']);
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
    // A transient onboarding dir is never inside the profiles root; one that is would be a group
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

  /** A file-based CredentialStore over one config dir — a group profile, an orphaned profile, or a
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
      // Which slot the account is live in is read below; no slot may be left mid-switch for it.
      await this.settlePendingSwitchesLocked();
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
    // the fresh capture and could never corroborate. A group member heals its group's profile, not
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
    if (liveSlot !== undefined) {
      // Heal the seat the account actually occupies: a group member's fresh grant is written into
      // its group profile, never the global files. The profile dir already exists (the account is
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
      await this.settlePendingSwitchesLocked();
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
   * Make `targetId` the live account IN ITS OWN SLOT. See the class comment for the guarantees.
   *
   * The slot is derived from membership, not chosen by the caller: a reserved account activates in
   * its group's slot, a shared account in the global slot. A group activation materialises the
   * profile dir first ({@link ensureGroupProfile}) and commits by moving the group's live member,
   * leaving the global slot untouched. `options.slot`, when given, may only AGREE with the derived
   * slot — a disagreement is the "reserved account can't be global / non-member can't be a group"
   * refusal ({@link SlotError} `slot_mismatch`), made explicit rather than silently overridden.
   *
   * Everything that decides WHERE the target goes is read UNDER the lock. Membership is a fact another
   * process changes (a bind reserves an account, an unbind dissolves a group); a slot derived before
   * the lock can name a slot the target no longer belongs to by the time it is written — putting one
   * account live in two slots, or seeding a dissolved group's profile nothing checks any more. A
   * caller that decided against an older picture (the daemon's per-slot auto-switch, a phone
   * `/switch`) passes the slot it decided for, so a changed picture fails the switch rather than
   * landing it somewhere the caller never meant.
   */
  async activate(targetId: string, options: ActivateOptions = {}): Promise<ActivateResult> {
    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const target = await this.vault.getAccount(targetId);
      if (!target) throw new UnknownAccountError(targetId);
      if (target.quarantined) {
        throw new QuarantineError(`account "${target.label}" is quarantined; re-login required`);
      }

      const { slotId, group } = await this.slotForAccount(targetId);
      if (options.slot !== undefined && options.slot !== slotId) {
        // The caller asserted a slot membership forbids. Name which invariant it hit.
        const why =
          group !== undefined
            ? `account "${target.label}" is reserved to a folder-bound group and can only be live in its group slot, not ${options.slot}`
            : `account "${target.label}" is a shared account and can only be live in the global slot, not ${options.slot}`;
        throw new SlotError(why, 'slot_mismatch');
      }
      if (group !== undefined && this.platform === 'darwin') {
        throw new RefreshError(
          'folder-bound group slots are not supported on macOS yet (per-config-dir Keychain slots)',
          'group_slot_unsupported',
        );
      }

      const rt = this.slotRuntime(slotId);
      // A group slot must exist before its live files are written. Idempotent: a no-op when the
      // profile is already materialised, so running it on every activation costs nothing
      // steady-state. Reached only for a group read under this lock, so it can never re-create the
      // profile of a group an unbind already dissolved.
      if (group !== undefined && rt.profileDir !== undefined) {
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

  /**
   * Whether `targetId` may be live in `rt`'s slot RIGHT NOW, read from the registry: a shared account
   * for the global slot; a member of a still-existing group for a group slot. Returns the slot's
   * group (undefined for the global slot) when it may, or the {@link SlotError} naming why it may not.
   * The caller holds the credential lock, so the answer stays true until it releases it.
   *
   * The one authority both {@link activateInSlot} (refuse before writing) and {@link recoverSlot}
   * (roll back rather than commit) consult, so the two can never disagree about who belongs where.
   */
  private async slotCandidacy(
    rt: SlotRuntime,
    targetId: string,
  ): Promise<{ ok: true; group: StoredGroup | undefined } | { ok: false; error: SlotError }> {
    const labelOf = async (): Promise<string> =>
      (await this.vault.getAccount(targetId))?.label ?? targetId;
    if (rt.groupId === undefined) {
      if ((await this.vault.listAccounts()).some((a) => a.id === targetId)) {
        return { ok: true, group: undefined };
      }
      return {
        ok: false,
        error: new SlotError(
          `account "${await labelOf()}" is not a shared account, so it cannot be live in the global slot`,
          'not_slot_candidate',
        ),
      };
    }
    const group = await this.vault.getGroup(rt.groupId);
    if (!group) {
      return {
        ok: false,
        error: new SlotError(
          `the folder-bound group ${rt.groupId} no longer exists, so nothing can be made live in its slot`,
          'group_gone',
        ),
      };
    }
    if (!group.members.some((m) => m.id === targetId)) {
      return {
        ok: false,
        error: new SlotError(
          `account "${await labelOf()}" is not a member of ${describeMembers(group)}, so it cannot be live in that group's slot`,
          'not_slot_candidate',
        ),
      };
    }
    return { ok: true, group };
  }

  /**
   * The switch state machine for one slot — the historical `activate` body, parameterised by the
   * slot it operates on. Every live read/write, the intent WAL, the rollback snapshot and the
   * cadence clock are the SLOT's; the commit is `setActive` for global and `setGroupActive` for a
   * group. The single credential lock (held by the caller) still serialises all slots.
   *
   * A switch this slot was left in the middle of (a crash, or an undo that failed) is settled FIRST,
   * before anything here reads the slot: every read below — who is live, whose rotation to adopt —
   * goes by the live identity block, which such a switch may have left naming the wrong account.
   *
   * The target's right to the slot is checked next, against the registry as it stands under the
   * lock ({@link slotCandidacy}), before the cadence clock, the rollback snapshot, the intent, or any
   * live write. The commit at the end refuses an illegitimate target too, but only after the live
   * files already hold it; refusing here is what keeps a refused switch from leaving an account live
   * where it does not belong.
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
    await this.recoverSlot(rt);
    const candidacy = await this.slotCandidacy(rt, targetId);
    if (!candidacy.ok) throw candidacy.error;
    const group = candidacy.group;

    // Live-reconciled, not the raw registry: `prevActiveId` names who OWNS the live token below
    // (rotation adoption, audit) IN THIS SLOT, and after an external `/login` the registry's record
    // points at an account whose credentials are no longer the live ones.
    const prevActiveId = await this.getActiveId(rt.id);

    // Cadence guard (ToS posture): switching ACCOUNTS faster than a human plausibly would is
    // refused. Each slot keeps its OWN clock, so a group hop never spends the global slot's budget
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
    try {
      await rt.credStore.writeLiveCredentials(bundle.claudeAiOauth);
      this.fault('activate:after-credentials-write');
      await this.writeLiveIdentity(bundle.oauthAccount, rt.credStore);
      await rt.intent.write(intentAt('written'));
      recorded = 'written';
      this.fault('activate:after-live-write');

      // Verify the write actually landed; a mismatch is undone like any other failure here.
      const check = await rt.credStore.readLiveCredentials();
      if (!check || check.accessToken !== bundle.claudeAiOauth.accessToken) {
        throw new VerifyError('credential read-back did not match after write; rolled back');
      }

      // Commit into the slot's own registry side — the last step that can still be undone.
      if (group !== undefined) await this.vault.setGroupActive(group.id, targetId);
      else await this.vault.setActive(targetId);
    } catch (err) {
      // A process that died here runs nothing more; its intent is what recovers it.
      if (!this.isSimulatedDeath(err))
        await this.undoFailedSwitch(rt, intentAt(recorded), prior, err);
      throw err;
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
      // The slot this activation landed in, so attribution can build one timeline per slot: a group
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
   * slot settles it ({@link recoverSlot}) — rather than replacing the error the caller must see.
   */
  private async undoFailedSwitch(
    rt: SlotRuntime,
    pending: SwitchIntent,
    prior: PriorLive,
    cause: unknown,
  ): Promise<void> {
    try {
      const result = await this.settleSwitch(rt, pending, 'undo', prior);
      this.log.warn(
        {
          slot: rt.id,
          targetId: pending.targetId,
          reason: errorReason(cause),
          undo: result.action,
        },
        'switch failed after its live write; the previous login was put back',
      );
    } catch (undoErr) {
      this.log.error(
        {
          slot: rt.id,
          targetId: pending.targetId,
          reason: errorReason(cause),
          undoReason: errorReason(undoErr),
        },
        'switch failed after its live write and could not be undone; it stays pending until the ' +
          'next operation on this slot settles it',
      );
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
      // Who is live where is read across every slot below; none may be left mid-switch.
      await this.settlePendingSwitchesLocked();
      // Live-reconciled for the same reason as `activate()`, and across EVERY slot: the adopt-only
      // protection below must shield the account whose token is ACTUALLY live wherever it is live —
      // network-refreshing a token some session (global OR a group profile) is holding would strand
      // it. An account is live in at most one slot, so the first hit is the whole answer.
      const liveSlot = await this.liveSlotOf(targetId);

      if (liveSlot !== undefined) {
        // Live account: adopt-only (see the method comment for why we never refresh it). Read and
        // adopt from the slot the account is actually live in.
        const credStore = this.slotRuntime(liveSlot).credStore;
        const liveNow = await credStore.readLiveCredentials();
        const liveOauthAccount = await credStore.readOauthAccount();
        const adopted = await this.adoptRotationIfNeeded(targetId, liveNow, liveOauthAccount);
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
   * Recover from a switch that crashed mid-flight, IN EVERY SLOT. Called on daemon/CLI startup.
   *
   * Each slot keeps its own intent WAL, so a crash can leave one pending per slot. This walks the
   * global slot (whose WAL is the historical vault-dir `.switch-intent.json`, so a pre-upgrade
   * intent recovers unchanged) and every group slot, recovering each: rolls the operation forward if
   * that slot's new credentials are already live and valid, otherwise restores the previous account
   * from that slot's encrypted snapshot. The single lock serialises the whole sweep.
   *
   * The return preserves the historical single-slot contract: with one pending intent (the common
   * case, and every global-only path) it returns exactly that slot's result; only a genuine
   * multi-slot recovery collapses to a summary.
   */
  async recover(): Promise<RecoverResult> {
    // Fast path: peek every currently-known slot's intent without locking. Most startups have none.
    // A group created between this peek and the lock cannot have a crashed switch yet, so missing it
    // here is harmless; the authoritative walk re-derives the slot set under the lock.
    let anyPending = false;
    for (const slotId of await this.allSlotIds()) {
      if (await this.slotRuntime(slotId).intent.read()) {
        anyPending = true;
        break;
      }
    }
    if (!anyPending) return { recovered: false, action: 'none' };

    const lock = await acquireLock(this.lockDir(), this.clock, this.lockOptions);
    try {
      const results: RecoverResult[] = [];
      for (const slotId of await this.allSlotIds()) {
        const result = await this.recoverSlot(this.slotRuntime(slotId));
        if (result) results.push(result);
      }
      return this.summariseRecovery(results);
    } finally {
      lock.release();
    }
  }

  /**
   * Settle every pending switch in these slots (every slot by default), for a caller that holds the
   * credential lock and is about to read or write slots. A switch left between its live writes and
   * its commit — by a crash, or by an undo that failed — must not wait for a restart: until it is
   * settled, the slot's identity block may name the wrong account, and everything that reads a slot
   * goes by that block. Cheap when nothing is pending, which is nearly every call: one read of an
   * absent intent file per slot. See {@link settleSwitch}.
   */
  private async settlePendingSwitchesLocked(slotIds?: readonly SlotId[]): Promise<void> {
    for (const slotId of slotIds ?? (await this.allSlotIds())) {
      await this.recoverSlot(this.slotRuntime(slotId));
    }
  }

  /** Recover one slot from its own intent WAL ({@link settleSwitch}), or `undefined` when it has
   *  none pending. */
  private async recoverSlot(rt: SlotRuntime): Promise<RecoverResult | undefined> {
    const pending = await rt.intent.read();
    if (!pending) return undefined;
    return this.settleSwitch(rt, pending, 'recover');
  }

  /**
   * Bring a slot whose switch did not finish to a state where both live files name one account, and
   * clear its intent. Two callers: recovery of a switch a crash (or a failed undo) left pending
   * (`recover`), and a switch undoing its own failure (`undo`, handed the in-memory snapshot).
   *
   * Nothing is assumed from the phase beyond `begin` (nothing live written — cleared; a refresh or an
   * adoption that reached the vault is kept). From `writing` on — and at an older build's `refreshed`,
   * recorded just before its first live write — the files are LOOKED AT, because the credentials may
   * be the target's while the identity block still names the previous account. In order:
   *
   *   1. The target's credentials are live. Recovery rolls FORWARD when the target may still hold the
   *      slot: the credentials are provably complete (one atomically written file), so writing the
   *      target's identity completes the switch, which is then committed. An undo — or a target that
   *      has lost its right to the slot since ({@link slotCandidacy}) — rolls BACK to the previous
   *      login instead (a slot that held none before is emptied).
   *   2. The previous credentials are live: the credentials write never landed, or has been undone.
   *      Only the identity can still be off, and it is put back.
   *   3. Neither, but the identity names the target: both writes landed and a running session has
   *      since rotated the target's token, so the live token is the target's. Recovery rolls forward
   *      (nothing to rewrite); an undo, or a target that lost the slot, first adopts it into the
   *      target's own bundle, then rolls back.
   *   4. Neither, and the identity does not name the target: the live token moved on after the
   *      switch touched it. It is left live — overwriting it would destroy whichever login it is — and
   *      no bundle is changed. At `written` the switch had already written its identity block, so the
   *      one there now was written later, by whoever wrote the live login (a `/login`), and is left
   *      standing. Before that, the block may be the previous account's, left over from before the
   *      switch, beside a token that may be the previous account's rotation or the target's: the files
   *      cannot say which, so the block, the one statement that may be false, is removed. Claude Code
   *      re-derives it from the token itself, and until it does, rotation adoption refuses to credit
   *      the token to anyone (see adoptRotationIfNeeded).
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
      if (mayForward) return this.rollForward(rt, pending, target, candidacy.group, true);
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

    // 3. The identity names the target: the live token is the target's, rotated since.
    if (
      target !== undefined &&
      targetUuid !== undefined &&
      liveIdentity?.accountUuid === targetUuid
    ) {
      if (mayForward) return this.rollForward(rt, pending, target, candidacy.group, false);
      await this.adoptRotationIfNeeded(pending.targetId, live, liveIdentity);
      return this.rollBack(rt, pending, prior, mode);
    }

    // 4. A login written after the switch touched the slot: keep it, change no bundle, and withdraw
    //    the identity block unless it too post-dates the switch's own identity write.
    const identityPostdates = pending.phase === 'written';
    if (!identityPostdates) await rt.credStore.clearOauthAccount();
    await this.finishIntent(rt);
    this.log.warn(
      { slot: rt.id, targetId: pending.targetId, prevActiveId: pending.prevActiveId },
      identityPostdates
        ? 'the slot holds a login written after an unfinished switch; it was left in place'
        : 'the live login after an unfinished switch could not be attributed; its identity block ' +
            'was removed so Claude Code re-derives it, and no bundle was changed',
    );
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

  /** Complete a pending switch whose target's credentials are live: its identity (unless the live
   *  one already names it), then the registry commit — what the switch itself would have done next. */
  private async rollForward(
    rt: SlotRuntime,
    pending: SwitchIntent,
    target: CredentialBundle,
    group: StoredGroup | undefined,
    writeIdentity: boolean,
  ): Promise<RecoverResult> {
    if (writeIdentity) await this.writeLiveIdentity(target.oauthAccount, rt.credStore);
    if (group !== undefined) await this.vault.setGroupActive(group.id, pending.targetId);
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
  // a group: `<vaultDir>/slots/<groupId>/.rollback.enc`). Sealed with the same protector the vault
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
