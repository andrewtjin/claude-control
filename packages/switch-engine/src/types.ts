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
 * A set of accounts reserved to a set of folders, persisted in `groups.json` beside the registry.
 *
 * The members' FULL rows live here, not in `accounts.json` — see {@link Registry} for why. Sessions
 * started under one of `folders` run on this group's slot; auto-switch rotates only among `members`;
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
  /** Canonical folder paths bound to this group (see `folderPath.ts`). Unique across all groups. */
  folders: string[];
  createdAtMs: number;
  updatedAtMs: number;
}

/** The `groups.json` file: the reserved side of the one logical registry. */
export interface GroupsFile {
  schemaVersion: 1;
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
  /** Member display labels, for the "bound to <members>" message. */
  members: string[];
}

/** Write-ahead record of an in-progress switch, for crash recovery. Carries NO secrets.
 *
 *  `phase` says how far the switch got, and so what the slot's live files may hold:
 *  - `begin`: nothing live has been written (the previous account's rotation may have been adopted
 *    into the vault, and the target refreshed there — both are kept).
 *  - `writing`: recorded BEFORE the first live write, so the credentials, the identity block, both
 *    or neither may be the target's. Recovery must look at the files; it can never assume either.
 *  - `written`: both live files were written; the registry commit had not happened.
 *  - `refreshed`: written only by older builds, immediately before their first live write — so it
 *    means exactly what `writing` means and is recovered the same way. This build never writes it. */
export interface SwitchIntent {
  phase: 'begin' | 'refreshed' | 'writing' | 'written';
  targetId: string;
  prevActiveId: string | null;
  /** Whether a DPAPI rollback snapshot of the prior live credentials exists on disk. */
  hasRollback: boolean;
  startedAtMs: number;
  /** Set when the switch failed and is being undone. Whoever settles it later (after that undo
   *  failed too) must finish the undo, never complete the switch: the caller was told it failed, and
   *  the target's identity block in the live files is then the switch's own write, not evidence of
   *  whose token sits beside it. */
  undo?: boolean;
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

/** Outcome of a startup recovery sweep. `unsettled` (with `recovered: false`): a switch is pending
 *  in some slot that could not be finished or undone yet; `detail` says which and why (every other
 *  slot was recovered regardless). It stays pending, and every operation on that slot retries it
 *  (see `UnsettledSwitchError`). */
export interface RecoverResult {
  recovered: boolean;
  action: 'none' | 'rolled_forward' | 'rolled_back' | 'cleared' | 'unsettled';
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

/** What {@link SwitchEngine.bindFolder} did — reported so the CLI can tell the operator exactly what
 *  moved (the whole point of the verb's chattiness in §10). */
export interface BindResult {
  /** The group the folder is now bound to (created or reused). */
  group: StoredGroup;
  /** True when a new group was created; false when the folder joined an existing group of the same
   *  member set. */
  created: boolean;
  /** The account that was live in the GLOBAL slot and had to be moved off it (because it became a
   *  reserved member), or `null` when no member was globally live. */
  movedOffGlobal: string | null;
  /** The shared account the global slot was switched to when a member was moved off it, or `null`
   *  when no global switch was needed. */
  globalSwitchedTo: string | null;
  /** The outcome of making the group's slot live (see {@link GroupLiveResult}). */
  live: GroupLiveResult;
  /** Running sessions found under the folder that will keep running on their current account until
   *  relaunched (the CLI warns about these). */
  runningSessions: RunningSession[];
}

/** What {@link SwitchEngine.unbindFolder} did. */
export interface UnbindResult {
  /** The canonical folder that was unbound. */
  folder: string;
  /** True when removing this folder was the group's LAST binding, dissolving the group (members
   *  returned to the shared pool); false when the group kept other folders. */
  dissolved: boolean;
  /** The surviving group when the folder was removed but the group persisted; absent on dissolve. */
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
 *    main (repaired by `ensureGroupProfile`, not by `repairSlots`).
 *  - `live_identity_mismatch`: a slot's live credentials are one stored account's token while its
 *    identity block names a different account — a switch torn between its two live writes that no
 *    pending intent describes. Every reader that goes by the identity block misjudges who is live, so
 *    it is repaired by re-seating the account the token belongs to (or the slot's rightful one).
 *  - `orphan_profile_login`: a profile dir no group owns still holds a live login. It is no slot, so
 *    nothing else would ever notice or clear it; `repairSlots` clears it (after adopting its rotation).
 *  - `duplicate_stored_token`: two accounts' bundles store the same token — either the same login
 *    stored twice, or one account holding another's token. Nothing can tell which bundle is wrong
 *    from the files, so it is only alerted on (a re-login of the wrong one fixes it).
 *  - `unreadable_bundle`: an account's stored bundle could not be read or decrypted, so none of the
 *    token checks could include it. Alert only.
 *  - `unsettled_switch`: a slot's switch was interrupted longer ago than any switch can still be
 *    running and nothing has been able to finish or undo it (another program holding the slot's
 *    live files open), or its record cannot be read. Every operation on that slot retries it; until
 *    one succeeds, writes to that slot are refused. Alert only.
 *  - `token_in_multiple_slots`: one refresh token is live in two or more slots whose live logins
 *    name different accounts (or none) — a token stored under two accounts, each seated somewhere.
 *    The same breach as (a), which is keyed by account and cannot see it; nothing can tell which
 *    slot is wrong, so it is alerted on (a re-login of the wrong account fixes it). */
export type SlotViolationKind =
  | 'account_in_multiple_slots'
  | 'reserved_live_in_global'
  | 'nonmember_live_in_group'
  | 'group_active_mismatch'
  | 'broken_profile_link'
  | 'live_identity_mismatch'
  | 'orphan_profile_login'
  | 'duplicate_stored_token'
  | 'unreadable_bundle'
  | 'unsettled_switch'
  | 'token_in_multiple_slots';

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
  /** The group the breach concerns, when it is a group slot. For `orphan_profile_login`, the name of
   *  the profile dir (the id of the group that once owned it). */
  groupId?: string;
}

/** What {@link SwitchEngine.repairSlots} did: the violations it fixed, those it could only alert on
 *  (unrecognized logins, broken profile links), and a human log of the corrective actions taken. */
export interface RepairResult {
  repaired: SlotViolation[];
  remaining: SlotViolation[];
  actions: string[];
}
