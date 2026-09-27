// Domain types for the switch engine.
//
// A deliberate split runs through this package: *metadata* about an account (label,
// email, org, quarantine state) is non-secret and lives in a plaintext registry so the
// CLI can list accounts without touching DPAPI; *credential material* (tokens) is secret
// and lives only inside the DPAPI-encrypted vault. Nothing here carries a token in a
// registry type — that separation is load-bearing, not cosmetic.

/** The `claudeAiOauth` block as stored in `~/.claude/.credentials.json`. */
export interface ClaudeOauth {
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the access token, epoch ms. */
  expiresAt: number;
  /** Absolute expiry of the refresh token, epoch ms (if the provider reports it). */
  refreshTokenExpiresAt?: number;
  scopes?: string[];
  subscriptionType?: string;
  rateLimitTier?: string;
}

/**
 * The `oauthAccount` block from the CLI config file (`~/.claude.json`, or
 * `<CLAUDE_CONFIG_DIR>/.claude.json` when that env var is set).
 * The file holds far more than auth, so unknown keys are preserved verbatim on
 * write — we only ever replace this one block. Hence the index signature.
 */
export interface OauthAccount {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationRole?: string;
  organizationName?: string;
  organizationRateLimitTier?: string;
  /** e.g. `"stripe_subscription"` — how the account is billed. The set of values is
   *  undocumented, so only that one is understood to recur monthly; anything else (or absent)
   *  must render as unknown, never a guessed default. */
  billingType?: string;
  /** ISO timestamp of when the paid subscription started. The only anchor available for
   *  estimating a monthly billing date — there is no authoritative next-invoice-date field. */
  subscriptionCreatedAt?: string;
  /** ISO timestamp a live trial ends, or `null` when the account isn't (or is no longer) on
   *  a trial. */
  claudeCodeTrialEndsAt?: string | null;
  [key: string]: unknown;
}

/** Everything secret about one account — the unit the vault encrypts. */
export interface CredentialBundle {
  claudeAiOauth: ClaudeOauth;
  /** Present once the account has been logged in and its `~/.claude.json` block captured. */
  oauthAccount?: OauthAccount;
}

/** Non-secret account metadata. Safe to render in `cctl accounts list`. */
export interface StoredAccount {
  /** Stable internal id, independent of any provider identifier. */
  id: string;
  label: string;
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  subscriptionType?: string;
  /** From `claudeAiOauth.rateLimitTier` (`.credentials.json`) — carries a plan multiplier
   *  (e.g. `default_claude_max_20x`) that `subscriptionType` alone does not. See
   *  `usage-advisor`'s `planWeight()` for how this is turned into a capacity weight. */
  rateLimitTier?: string;
  /** From `oauthAccount.organizationRateLimitTier` (`.claude.json`) — the org-wide counterpart
   *  of `rateLimitTier`, preferred over it when both are present (see `planWeight()`). */
  organizationRateLimitTier?: string;
  /** From `oauthAccount.billingType`. Only `"stripe_subscription"` is understood to recur
   *  monthly; render anything else (or absent) as unknown rather than assuming that value. */
  billingType?: string;
  /** From `oauthAccount.subscriptionCreatedAt`. A DERIVATION anchor only — CLI rendering uses
   *  it to estimate a monthly billing anniversary; it is never an authoritative invoice date
   *  and must never be presented as one. */
  subscriptionCreatedAt?: string;
  /** From `oauthAccount.claudeCodeTrialEndsAt`, captured only when non-null (a live trial). */
  claudeCodeTrialEndsAt?: string;
  /** Which revision of the bundle -> row mapping last computed the derived fields above (see
   *  `ACCOUNT_METADATA_REV`). Absent on rows written before the stamp existed. Rows behind the
   *  current revision are recomputed once from their stored bundle; without the stamp there is
   *  no way to tell "this build captured everything it could" from "this row predates the
   *  field", and a row frozen by an older build would render as unknown forever. */
  metadataRev?: number;
  /** When the last attempt to recompute this row from its stored bundle FAILED — an absent or
   *  undecryptable blob. Rows behind `metadataRev` that no attempt can advance would otherwise be
   *  rescanned on every listing forever, so this timestamp backs the sweep off (see
   *  `METADATA_BACKFILL_RETRY_MS`). Cleared the moment a recompute succeeds. */
  metadataBackfillFailedAtMs?: number;
  /** A quarantined account has a dead refresh token and must be re-logged-in before use. */
  quarantined: boolean;
  /** True when the operator has taken this account out of the daemon's auto-switch TARGET pool.
   *  Deliberate switches still reach it (`cctl switch`, the phone's `/switch`), and it can still
   *  be hopped AWAY from while it is live — only the unattended choice of WHERE to hop skips it.
   *  A chosen setting, not an incident, so unlike quarantine it carries no reason or timestamp.
   *  Absent means "not excluded", which is what every row written before this field says: old
   *  registries need no migration. */
  autoSwitchExcluded?: boolean;
  quarantineReason?: string;
  quarantinedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The registry index persisted at `vault/accounts.json`.
 *
 *  Holds only SHARED (global-pool) rows. A reserved account's row is MOVED out of here into
 *  `groups.json` (see {@link StoredGroup}) so that an older cctl — which rewrites this file knowing
 *  only `{activeId, accounts}` — never sees, refreshes, or switches to a reserved account, and its
 *  writes can never drop a binding. That downgrade fence is the whole reason for the split. */
export interface Registry {
  /** Schema tag, `2` once the group split exists. ABSENT means a file written by a build that
   *  predates the feature; it is read as the pre-split shape (all rows shared) and upgraded on the
   *  next write. Never fail a load purely because this is missing — that is the legacy path. */
  schemaVersion?: number;
  /** Id of the SHARED account whose credentials are currently written to the global live files.
   *  A reserved account is never live here (its group slot holds it); see {@link StoredGroup}. */
  activeId: string | null;
  accounts: StoredAccount[];
}

/** Identifies one credential slot. `global` is today's config dir; a group gets its own profile
 *  dir addressed as `group:<groupId>`. A template-literal type so a slot id and an ordinary string
 *  are not silently interchangeable at call sites. */
export type SlotId = 'global' | `group:${string}`;

/** Build the {@link SlotId} for a group. The one place the `group:` prefix is spelled, so callers
 *  never hand-concatenate it (and a rename of the scheme stays a one-line change). */
export function groupSlotId(groupId: string): SlotId {
  return `group:${groupId}`;
}

/** The live token read from the slot an account is currently live in (see
 *  {@link SwitchEngine.liveSlotToken}). Carries no refresh token — the daemon's poller uses the
 *  access token as-is and never refreshes a slot-live account. */
export interface SlotLiveToken {
  /** The slot the account is live in. */
  slot: SlotId;
  accessToken: string;
  /** Epoch ms the access token expires. */
  expiresAt: number;
  /** The identity block's account uuid for that slot, when readable — used for the local
   *  bundle-vs-registry identity check before the token is handed to the poller. */
  accountUuid?: string;
}

/**
 * One alias scope of a group: sessions whose CUSTOM title matches `alias` (compared by `aliasKey`,
 * the `claude --resume` rule: lower-cased and trimmed) in EXACTLY `folder` (canonical; not its
 * subfolders) run on the group's slot. `alias` is kept as the operator entered it, for display.
 */
export interface StoredAliasScope {
  folder: string;
  alias: string;
}

/**
 * A set of accounts reserved to a set of scopes, persisted in `groups.json` beside the registry.
 * A scope is a folder (the folder and its subfolders) or a session alias in one folder; a group
 * holds at least one of either, and dissolves when its last scope goes.
 *
 * The members' FULL rows live here, not in `accounts.json` — see {@link Registry} for why. Sessions
 * in one of the group's scopes run on this group's slot; auto-switch rotates only among `members`;
 * the members are never used anywhere else.
 */
export interface StoredGroup {
  /** Random UUID. Unguessable because it also names the on-disk profile dir. */
  id: string;
  /** Display name. Defaults to the joined member labels when the operator gives none. */
  label: string;
  /** The FULL rows of the reserved accounts, moved out of the registry into this group. */
  members: StoredAccount[];
  /** The member currently live in this group's slot, or `null` when none is. Always a member id
   *  (or null); validated on load. */
  activeId: string | null;
  /** Canonical folder paths bound to this group (see `folderPath.ts`). Unique across all groups.
   *  May be empty when the group is bound only by session aliases. */
  folders: string[];
  /** Session-alias scopes (see {@link StoredAliasScope}). Absent (never an empty array on disk) when
   *  the group has none, so a file with no alias bindings is byte-for-byte the shape a build without
   *  them wrote and reads. A (folder, alias key) pair is unique across all groups. */
  aliases?: StoredAliasScope[];
  createdAtMs: number;
  updatedAtMs: number;
}

/** The `groups.json` file: the reserved side of the one logical registry. `schemaVersion` is 2
 *  exactly when some group carries an alias scope (so a folder-only build refuses the file rather
 *  than dropping the aliases on its next write), else 1. */
export interface GroupsFile {
  schemaVersion: 1 | 2;
  /** Bumped on every write; the guard snapshot (see {@link FolderBindingSnapshot}) carries it so a
   *  stale snapshot can be detected. */
  generation: number;
  groups: StoredGroup[];
}

/** A row as the unified listing returns it: a {@link StoredAccount} plus, for a reserved account,
 *  the id of the group holding it. The tag is VIEW-ONLY — it is derived from which file the row was
 *  found in and is never written back into `accounts.json`. */
export interface AccountView extends StoredAccount {
  /** Present iff the account is reserved to a group; the group's id. */
  groupId?: string;
}

/**
 * The non-secret snapshot the enforcement guard reads: `<vaultDir>/../folder-bindings.json`.
 *
 * Written LAST in every group mutation and on daemon start, atomically. It carries no tokens — only
 * what the guard needs to decide whether a session's config dir matches the folder it is running in.
 */
export interface FolderBindingSnapshot {
  schemaVersion: 1;
  /** The {@link GroupsFile} generation this snapshot was derived from. */
  generation: number;
  /** How the guard should act on a mismatch. Mirrors the daemon's current policy. */
  enforce: 'block' | 'warn' | 'off';
  /** The main Claude Code config dir the global slot runs in (canonical). */
  mainConfigDir: string;
  groups: FolderBindingSnapshotGroup[];
}

/** One group as the guard snapshot describes it. Members are LABELS only (for the block message);
 *  no ids, no tokens. */
export interface FolderBindingSnapshotGroup {
  id: string;
  label: string;
  /** The group's profile dir; the guard matches a session's canonical config dir against it. */
  profileDir: string;
  folders: string[];
  /** Alias scopes: the canonical folder, the key the guard compares a prompt's session title
   *  against (lower-cased, trimmed), and the alias as bound, for the guard's messages and the
   *  resume command it prints (a bound alias is printable text: bind refuses control and bidi
   *  characters). Always present (possibly empty) in a snapshot this build writes; a guard reading
   *  an older snapshot treats a missing list as empty and a missing `alias` as unknown. */
  aliases: { folder: string; aliasKey: string; alias?: string }[];
  /** Member display labels, for the "bound to <members>" message. */
  members: string[];
}

/** Write-ahead record of an in-progress switch, for crash recovery. Carries NO secrets. */
export interface SwitchIntent {
  phase: 'begin' | 'refreshed' | 'written';
  targetId: string;
  prevActiveId: string | null;
  /** Whether a DPAPI rollback snapshot of the prior live credentials exists on disk. */
  hasRollback: boolean;
  startedAtMs: number;
}

/** What `activate()` actually did — reported honestly at the mechanism level.
 *  Whether a *running* session hot-applies the new credentials is a separate, empirically
 *  verified fact the caller layers on top; this type never claims it. */
export interface ActivateResult {
  ok: boolean;
  activeAccountId: string;
  /** True if the target's access token was refreshed (and the rotated token persisted). */
  refreshed: boolean;
  /** True if the previously-active account's live token had rotated under us and we adopted it. */
  adoptedPreviousRotation: boolean;
  /** Whether the live credential files were (re)written this call. */
  wroteCredentials: boolean;
}

/** What `reloginFromConfigDir()` did. Same honesty contract as {@link ActivateResult}:
 *  `healedLiveLogin` reports a mechanical live-file write (verified by read-back), never that a
 *  running session applied it. */
export interface ReloginResult {
  /** The account's registry row after the in-place bundle overwrite. */
  account: StoredAccount;
  /** True when the re-logged account was the live one and the fresh credentials (and identity)
   *  were written to the live files. False for a non-live account — its live files were
   *  deliberately untouched — or when the live write failed/could not be verified. */
  healedLiveLogin: boolean;
}

/** Outcome of a startup recovery sweep. */
export interface RecoverResult {
  recovered: boolean;
  action: 'none' | 'rolled_forward' | 'rolled_back' | 'cleared';
  detail?: string;
}

/** What `refreshToken()` did for a background (non-switching) token refresh. */
export interface RefreshTokenResult {
  accountId: string;
  /** True if a network refresh happened and the rotated token was persisted to the vault. */
  refreshed: boolean;
  /** Why no refresh happened, when `refreshed` is false:
   *  - `token_fresh`: the access token's remaining lifetime is above the skew — nothing to do.
   *  - `active_account`: the account is the live one; its single-use refresh token is shared
   *    with the live files, so consuming it here would strand the running CLI with a dead
   *    token. The engine only ADOPTS a CLI-side rotation into the vault, never refreshes. */
  skippedReason?: 'token_fresh' | 'active_account';
  /** True if the active account's live-file rotation was adopted into the vault. */
  adoptedLiveRotation?: boolean;
  /** Expiry (epoch ms) of the vault's access token after this call. */
  expiresAt: number;
}

/** A Claude Code session observed running under a bound folder, from `<mainConfigDir>/sessions/*.json`.
 *  The engine cannot see a session's config dir (it is set at launch, not recorded), so a match is by
 *  a LIVE pid whose recorded cwd sits within the folder — enough to warn "these will be blocked until
 *  relaunched", never a hard guarantee that the session actually ran on the shared account. */
export interface RunningSession {
  /** The OS process id recorded in the session file, confirmed alive at scan time. */
  pid: number;
  /** The session's working directory, canonical, within the bound folder. */
  cwd: string;
  /** The session file it was read from, for diagnostics. */
  sessionFile: string;
}

/** One scope of a group, as an operator names it: a folder (the folder and every subfolder), or one
 *  session alias in one exact folder. Both are scopes of a group; the lifecycle around them is
 *  identical. */
export type GroupScopeRef =
  { kind: 'folder'; folder: string } | { kind: 'alias'; folder: string; alias: string };

/** What Claude Code's transcript says about one session: its custom title (`/rename`, `--name`;
 *  null = unnamed — a generated title never counts) and the folder it was recorded in (its first
 *  recorded cwd, or a later relocation; null = unknown). */
export interface SessionIdentity {
  customTitle: string | null;
  folder: string | null;
}

/** Look sessions up by id in Claude Code's transcripts under `claudeDir` (the main config dir): a
 *  map from the LOWER-CASED session id to what its transcript records. An id with no transcript yet
 *  is simply absent. Injected into the engine because the transcript reader lives with the daemon's
 *  session catalog; see {@link SwitchEngineOptions.sessionIdentity}. */
export type SessionIdentityLookup = (
  claudeDir: string,
  sessionIds: readonly string[],
) => Promise<ReadonlyMap<string, SessionIdentity>>;

/** What {@link SwitchEngine.ensureGroupLive} settled a group's slot to — reported at the mechanism
 *  level like {@link ActivateResult}: `liveMember` is the member whose credentials are now written to
 *  the profile, never a claim that a running session picked them up. */
export interface GroupLiveResult {
  groupId: string;
  /** The member now live in the group's slot, or `null` when none could be made live. */
  liveMember: string | null;
  /** True when this call wrote a member's credentials into the profile (as opposed to finding one
   *  already correctly live). */
  activated: boolean;
  /** True when every eligible member failed to activate — the binding exists but has no working
   *  account. */
  noWorkingAccount: boolean;
  /** True when no member could be seated AND a non-member/unrecognized login squatting in the profile
   *  was cleared to fail the slot closed. Lets the repair/doctor report the eviction (an eviction
   *  leaves `activated` false, so it would otherwise be silent). */
  clearedSquatter?: boolean;
}

/** What {@link SwitchEngine.bindFolder} / {@link SwitchEngine.bindAlias} did — reported so the CLI
 *  can tell the operator exactly what moved (the whole point of the verb's chattiness in §10). */
export interface BindResult {
  /** The group the scope is now bound to (created or reused). */
  group: StoredGroup;
  /** The canonical folder of the scope that was bound. */
  folder: string;
  /** For an alias bind: the alias as bound; absent for a folder bind. */
  alias?: string;
  /** True when a new group was created; false when the scope joined an existing group of the same
   *  member set (or was already bound to it). */
  created: boolean;
  /** The account that was live in the GLOBAL slot and had to be moved off it (because it became a
   *  reserved member), or `null` when no member was globally live. */
  movedOffGlobal: string | null;
  /** The shared account the global slot was switched to when a member was moved off it, or `null`
   *  when no global switch was needed. */
  globalSwitchedTo: string | null;
  /** The outcome of making the group's slot live (see {@link GroupLiveResult}). */
  live: GroupLiveResult;
  /** Running sessions found in the scope that will keep running on their current account until
   *  relaunched (the CLI warns about these). */
  runningSessions: RunningSession[];
}

/** What {@link SwitchEngine.unbindFolder} / {@link SwitchEngine.unbindAlias} did. */
export interface UnbindResult {
  /** The canonical folder of the scope that was unbound. */
  folder: string;
  /** For an alias unbind: the alias as it was stored; absent for a folder unbind. */
  alias?: string;
  /** True when removing this scope was the group's LAST binding, dissolving the group (members
   *  returned to the shared pool); false when the group kept other scopes. */
  dissolved: boolean;
  /** The surviving group when the scope was removed but the group persisted; absent on dissolve. */
  group?: StoredGroup;
  /** Member ids returned to the shared pool (only on dissolve). */
  releasedMembers: string[];
  /** True when the profile's live token had rotated under us and was adopted into the vault before
   *  the profile's live credentials were cleared (only on dissolve). */
  adoptedRotation: boolean;
  /** Sessions observed running under the group's folders at unbind time — non-empty is what a
   *  non-forced dissolve refuses on. */
  runningSessions: RunningSession[];
}

/** What {@link SwitchEngine.addGroupMembers} did. */
export interface GroupGrowResult {
  /** The group after growing. */
  group: StoredGroup;
  /** Account ids newly reserved into the group (requested ids already members are skipped). */
  added: string[];
  /** A to-be-member that was live in the GLOBAL slot and had to be moved off it first, or null. */
  movedOffGlobal: string | null;
  /** The shared account the global slot was switched to when one was moved off, or null. */
  globalSwitchedTo: string | null;
  /** The group's slot after the grow (normally unchanged: the live member keeps the slot). */
  live: GroupLiveResult;
}

/** What {@link SwitchEngine.removeGroupMembers} did. */
export interface GroupShrinkResult {
  /** The surviving group; absent when removing the last member dissolved it. */
  group?: StoredGroup;
  /** Account ids returned to the shared pool. */
  removed: string[];
  /** True when the removal took the group's last member, dissolving it (V1 unbind semantics). */
  dissolved: boolean;
  /** When a removed member was LIVE in the slot: the member that took the slot over, or null when
   *  no remaining member could (the slot was then cleared, failing closed). Undefined when no
   *  removed member was live. */
  switchedTo?: string | null;
  /** True when the outgoing live member's rotated token was adopted into the vault before it left
   *  the slot (on a switch this happens inside the activation; reported here for the clear/dissolve
   *  paths). */
  adoptedRotation: boolean;
  /** Sessions observed in the group's scopes (what a non-forced dissolve refuses on). */
  runningSessions: RunningSession[];
}

/** The invariant {@link SwitchEngine.checkSlots} found broken. The kinds mirror §7's (a)-(e):
 *  - `account_in_multiple_slots` (a): one account's credentials are live in more than one slot —
 *    the single invariant the whole reservation fence exists to protect (a rotating refresh token
 *    can only survive in one place).
 *  - `reserved_live_in_global` (b): a group member's credentials are live in the global slot.
 *  - `nonmember_live_in_group` (c): an account that is not a member (a shared account, another
 *    group's member, or an unrecognized login) is live in a group's slot.
 *  - `group_active_mismatch` (d): a group's recorded `activeId` names a different member than the
 *    one whose identity is actually live in the profile.
 *  - `broken_profile_link` (e): a shared file/dir in a profile is no longer correctly linked to
 *    main (repaired by `ensureGroupProfile`, not by `repairSlots`). */
export type SlotViolationKind =
  | 'account_in_multiple_slots'
  | 'reserved_live_in_global'
  | 'nonmember_live_in_group'
  | 'group_active_mismatch'
  | 'broken_profile_link';

/** One invariant breach, with enough context to alert on and to repair. Every message names the
 *  offending account and/or folder (a hard requirement of the verb). */
export interface SlotViolation {
  kind: SlotViolationKind;
  /** Human-readable, naming the offending account/folder. */
  detail: string;
  /** The offending account, when one is identifiable (absent for an unrecognized login). */
  accountId?: string;
  /** The slot the breach is about (absent for `account_in_multiple_slots`, which uses `slots`). */
  slot?: SlotId;
  /** For `account_in_multiple_slots`: every slot the account is live in. */
  slots?: SlotId[];
  /** The group the breach concerns, when it is a group slot. */
  groupId?: string;
}

/** What {@link SwitchEngine.repairSlots} did: the violations it fixed, those it could only alert on
 *  (unrecognized logins, broken profile links), and a human log of the corrective actions taken. */
export interface RepairResult {
  repaired: SlotViolation[];
  remaining: SlotViolation[];
  actions: string[];
}
