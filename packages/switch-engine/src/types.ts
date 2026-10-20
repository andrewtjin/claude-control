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

/** The quarantine reason of an account stored without tokens (an import of a file made with
 *  `--no-tokens`): it has never been logged in on this machine, which a view says rather than
 *  calling its login expired. */
export const PENDING_LOGIN_REASON = 'imported without tokens - log in with cctl accounts relogin';

/** The registry index persisted at `vault/accounts.json`.
 *
 *  Holds only SHARED (global-pool) rows. A reserved account's row is MOVED out of here into
 *  `groups.json` (see {@link RulesFile}) so that an older cctl — which rewrites this file knowing
 *  only `{activeId, accounts}` — never sees, refreshes, or switches to a reserved account, and its
 *  writes can never drop a rule. That downgrade fence is the whole reason for the split. */
export interface Registry {
  /** Schema tag, `2` once the reserved split exists. ABSENT means a file written by a build that
   *  predates the feature; it is read as the pre-split shape (all rows shared) and upgraded on the
   *  next write. Never fail a load purely because this is missing — that is the legacy path. */
  schemaVersion?: number;
  /** Id of the SHARED account whose credentials are currently written to the global live files.
   *  A reserved account is never live here (a rule slot holds it); see {@link FolderRule}. */
  activeId: string | null;
  accounts: StoredAccount[];
}

/** Identifies one credential slot. `global` is today's config dir; a folder rule gets its own
 *  profile dir addressed as `group:<ruleId>`. The `group:` spelling predates folder rules and is
 *  kept because slot ids are recorded (the audit trail, the daemon's session slots, the wire), so a
 *  rule migrated from a group keeps one slot id across the upgrade. A template-literal type so a
 *  slot id and an ordinary string are not silently interchangeable at call sites. */
export type SlotId = 'global' | `group:${string}`;

/** The prefix of a rule slot's {@link SlotId}. Spelled once, here and in the type above. */
const RULE_SLOT_PREFIX = 'group:';

/** Build the {@link SlotId} for a folder rule. The one place a rule slot id is built, so callers
 *  never hand-concatenate the prefix. */
export function ruleSlotId(ruleId: string): SlotId {
  return `${RULE_SLOT_PREFIX}${ruleId}`;
}

/** The rule id a slot belongs to, or `undefined` for the global slot. The inverse of
 *  {@link ruleSlotId}. */
export function ruleIdOfSlot(slot: SlotId): string | undefined {
  return slot === 'global' ? undefined : slot.slice(RULE_SLOT_PREFIX.length);
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
 * One session-alias scope of a rule: sessions whose CUSTOM title matches `alias` (compared by
 * `aliasKey`, the `claude --resume` rule: lower-cased and trimmed) in a conversation recorded in
 * EXACTLY `folder` (canonical; not its subfolders) run under the rule. `alias` is kept as the
 * operator entered it, for display.
 */
export interface StoredAliasScope {
  folder: string;
  alias: string;
}

/**
 * A per-folder rule over the inherited global pool, persisted in `groups.json`.
 *
 * A rule applies to its folders and everything beneath them (the longest matching folder wins, with
 * no merging between nested rules). Sessions there run in the rule's own slot, whose pool is the
 * rule's included accounts first, then the shared pool minus the rule's exclusions (see
 * `folderRules.ts`). Rows are not held here: an included account's full row lives in
 * {@link RulesFile.reserved}, and a shared row stays in `accounts.json`.
 */
export interface FolderRule {
  /** Random UUID. Unguessable because it also names the on-disk profile dir. A rule migrated from a
   *  1.0.0 group keeps the group's id, and so its profile dir and its slot id. */
  id: string;
  /** Display name. Defaults to the folder the rule was created on. */
  label: string;
  /** Which rule this one is on the machine an import brought it from: that rule's own origin, else
   *  its id. Set on a rule an import made. Absent on a rule made here by hand, which an import never
   *  grows. A later import finds the rule by it whatever changed since on either machine (members,
   *  folders, name), so a rule brought over part way is grown rather than made again beside itself.
   *  A lower-case uuid; unlike the id it names nothing on disk. */
  origin?: string;
  /** Canonical folder paths this rule applies to (see `folderPath.ts`). Unique across all rules.
   *  Empty for a rule that applies only to a session alias. */
  folders: string[];
  /** Session-alias scopes (see {@link StoredAliasScope}). Absent (never an empty array on disk) when
   *  the rule has none, so a rules file without alias rules keeps the exact shape older builds read.
   *  A (folder, alias key) pair is unique across all rules, and outranks every folder rule: a
   *  session titled so, recorded in that folder, runs under this rule wherever it is resumed from. */
  aliases?: StoredAliasScope[];
  /** Ids of the accounts positively assigned to these folders, in preference order. Each is a
   *  RESERVED account (its row is in {@link RulesFile.reserved}); several rules may include the same
   *  account, and those folders share it. Including an account overrides its global auto-switch
   *  exclusion inside these folders. */
  include: string[];
  /** Ids of SHARED accounts these folders must not use; they stay usable everywhere else. An id that
   *  names no shared account right now (reserved since, or removed by a build that does not know
   *  rules) is inert: it takes effect again only if that account is shared again. */
  exclude: string[];
  /** The account currently live in this rule's slot, or `null` when none is: an included account, or
   *  an inherited shared one while every included account is out. */
  activeId: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The `groups.json` file: the reserved side of the one logical registry plus the folder rules over
 *  it. An account is in `reserved` (and absent from `accounts.json`) exactly while at least one rule
 *  includes it. Schema 1 (set-bound groups) is migrated on read. `schemaVersion` is 3 exactly while
 *  some rule carries an alias scope, so a build that knows only folder rules refuses the file instead
 *  of ignoring the alias rules it cannot honor; else 2. */
export interface RulesFile {
  schemaVersion: 2 | 3;
  /** Bumped on every write; the guard snapshot (see {@link FolderBindingSnapshot}) carries it so a
   *  stale snapshot can be detected. */
  generation: number;
  /** The FULL rows of every account some rule includes, moved out of `accounts.json`. */
  reserved: StoredAccount[];
  rules: FolderRule[];
}

/** A row as the unified listing returns it: a {@link StoredAccount} plus, for a reserved account,
 *  the ids of the rules that include it. The tag is VIEW-ONLY — it is derived from which file the
 *  row was found in and is never written back into `accounts.json`. */
export interface AccountView extends StoredAccount {
  /** Present iff the account is reserved: the ids of the rules including it, in rule order. */
  ruleIds?: string[];
}

/** Where an account in a slot's effective pool comes from: one of the rule's own included accounts,
 *  or the shared pool the slot inherits. */
export type PoolSource = 'include' | 'inherited';

/** One account of a slot's effective pool, in pool order (see `folderRules.ts`). */
export interface PoolEntry {
  account: StoredAccount;
  source: PoolSource;
  /** Whether an unattended choice (auto-switch, the self-heal) may pick it: false for a shared
   *  account the operator excluded from auto-switch globally. An included account is always a
   *  target in its rule's slot — the inclusion overrides the global exclusion there. */
  autoTarget: boolean;
  /** Another slot the account is live in right now (token-aware), or `null`. An account live
   *  elsewhere is in the pool but not AVAILABLE to this slot: no account is live in two slots. */
  liveElsewhere: SlotId | null;
}

/**
 * The non-secret snapshot the enforcement guard reads: `<vaultDir>/../folder-bindings.json`.
 *
 * Written LAST in every rule mutation and on daemon start, atomically. It carries no tokens — only
 * what the guard needs to decide whether a session's config dir matches the folder it is running in.
 */
export interface FolderBindingSnapshot {
  schemaVersion: 1;
  /** The {@link RulesFile} generation this snapshot was derived from. */
  generation: number;
  /** How the guard should act on a mismatch. Mirrors the daemon's current policy. */
  enforce: 'block' | 'warn' | 'off';
  /** The main Claude Code config dir the global slot runs in (canonical). */
  mainConfigDir: string;
  /** The `.claude.json` holding the global slot's identity block (`oauthAccount`): where the guard
   *  reads which account a session on the global slot runs on, without touching credentials.
   *  Absent in a snapshot written by a build that predates it. */
  mainIdentityFile?: string;
  /** Every stored account Claude Code can name by identity, so the guard can tell which one the
   *  global slot holds and say it by label. Absent in a snapshot written by an older build. */
  accounts?: FolderBindingSnapshotAccount[];
  /** One row per folder rule (the key predates rules and is kept for the guard's reader). */
  groups: FolderBindingSnapshotGroup[];
}

/** An account as the guard snapshot names it: its label and one-way keys of the identity Claude
 *  Code records for a login in `.claude.json` (`oauthAccount.accountUuid` / `organizationUuid`; see
 *  `snapshotIdentityKey`), so the guard can recognize the login live in the global slot while the
 *  snapshot carries no account ids, no email and no tokens. */
export interface FolderBindingSnapshotIdentity {
  label: string;
  accountKey?: string;
  organizationKey?: string;
}

/** A stored account in the guard snapshot: its identity plus the rules that include (reserve) it —
 *  empty for a shared account. */
export interface FolderBindingSnapshotAccount extends FolderBindingSnapshotIdentity {
  ruleIds: string[];
}

/** One folder rule as the guard snapshot describes it. Members are LABELS only (for the block
 *  message); no ids, no tokens. */
export interface FolderBindingSnapshotGroup {
  id: string;
  label: string;
  /** The rule's profile dir; the guard matches a session's canonical config dir against it. */
  profileDir: string;
  folders: string[];
  /** Labels of the rule's INCLUDED accounts, in include order — empty for a rule that only
   *  excludes. */
  members: string[];
  /** The shared accounts the rule excludes, by identity: a session on the global slot in this
   *  folder is refused while the global slot holds one of them. Absent in a snapshot written by a
   *  build that predates it, which the guard reads as "cannot tell". */
  excluded?: FolderBindingSnapshotIdentity[];
  /** Alias scopes: the canonical folder, the key the guard compares a prompt's session title
   *  against (lower-cased, trimmed), and the alias as entered, for the guard's messages (an alias is
   *  printable text: the engine refuses control and bidi characters). Absent in a snapshot written by
   *  a build that predates alias rules, which the guard reads as none. */
  aliases?: { folder: string; aliasKey: string; alias?: string }[];
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

/** The identity a registry row is known by, as a caller states it (an import, from its file). */
export type AccountIdentity = Pick<
  StoredAccount,
  'accountUuid' | 'emailAddress' | 'organizationUuid'
>;

/** The plan and billing facts a registry row keeps, copied from a login's bundle. */
export const ACCOUNT_PLAN_KEYS = [
  'subscriptionType',
  'rateLimitTier',
  'organizationRateLimitTier',
  'billingType',
  'subscriptionCreatedAt',
  'claudeCodeTrialEndsAt',
] as const;

/** A row's plan and billing facts (see {@link ACCOUNT_PLAN_KEYS}). */
export type AccountPlanFacts = Pick<StoredAccount, (typeof ACCOUNT_PLAN_KEYS)[number]>;

/** What a caller adding an account knows beyond its bundle (see `Vault.addAccount`). */
export interface AddAccountOptions {
  /** Store the account excluded from auto-switch, in the same write that adds it. */
  autoSwitchExcluded?: boolean;
  /** The identity to record for each anchor the bundle's identity block does not carry. */
  identity?: AccountIdentity;
  /** The id to store the account under: an import keeps the id the account has on the machine it
   *  came from, so importing it again finds it. A uuid no row here has; absent, one is made. */
  id?: string;
}

/** What a caller adding an account that has no login yet knows (see `Vault.addPendingAccount`). */
export interface AddPendingAccountOptions extends Pick<
  AddAccountOptions,
  'autoSwitchExcluded' | 'id'
> {
  /** The plan facts the account had where it came from, shown until its first login replaces
   *  them. */
  plan?: AccountPlanFacts;
}

/** What a removal that follows handing an account to another machine checks first (see
 *  `SwitchEngine.removeAccount`). */
export interface RemoveAccountOptions {
  /** Refuse while the account is live on this machine's main login. */
  refuseIfGloballyLive?: boolean;
  /** Refuse unless the vault still holds this refresh token for the account. */
  expectRefreshToken?: string;
}

/** One rule an import asks {@link SwitchEngine.importRules} for: one rule of the machine the file
 *  came from, applied whole or not at all. */
export interface ImportRuleSpec {
  /** Every scope of the ONE rule this makes (or grows), as the operator would name them. */
  scopes: RuleScopeRef[];
  /** Scopes of the same rule that cannot be used here (a folder that does not exist here, a
   *  network folder), as the file names them. Nothing is made on them, but a rule here that holds
   *  one still keeps the rule from landing: made on the rest, it would be split in two. */
  absent?: RuleScopeRef[];
  include: string[];
  exclude: string[];
  /** The display name of a rule this creates. */
  label?: string;
  /** The rule's identity across machines (see {@link FolderRule.origin}). The rule here carrying it
   *  (an earlier import of the same rule), or whose own id it is, is grown rather than a second one
   *  made; a rule this creates stores it. A spec without one can only create. */
  origin?: string;
}

/** An account an import has not stored yet, which {@link SwitchEngine.planImportRules} counts as
 *  stored (shared, under this id) when it decides what the rules would do. It has no tokens here
 *  yet, so it is live in a slot only when the login it names runs there unrecognized. */
export interface PendingImportAccount {
  /** The id rule specs name it by; any string no stored account has. */
  id: string;
  label: string;
  /** Its login, by which a slot already running that login recognizes it once it is stored. */
  accountUuid?: string;
  /** Whether it arrives with tokens; without, it is stored quarantined (no slot can move to it). */
  withTokens: boolean;
  autoSwitchExcluded?: boolean;
}

/** What a {@link SwitchEngine.importRules} batch is told beyond its specs. */
export interface ImportRulesOptions {
  /** Accounts no slot may be moved to or seated with unless their own rule includes them. */
  keepOut?: readonly string[];
}

/** What {@link SwitchEngine.planImportRules} is told about the import around the rules. */
export interface PlanImportRulesOptions extends ImportRulesOptions {
  /** The accounts the import stores before it writes the rules. */
  pending?: readonly PendingImportAccount[];
  /** Logins the import gives accounts already stored that record none yet: a slot running such a
   *  login unrecognized holds that account once the import has run. */
  logins?: ReadonlyArray<{ id: string; accountUuid: string }>;
  /** Accounts stored here quarantined that the import gives new tokens before it writes the rules
   *  (a replaced login is always taken over a quarantined one): usable once it has run. */
  revived?: readonly string[];
}

/** A member of a rule an import leaves out, and why: the rule here it grows excludes (or
 *  includes) the account already, or another rule here reserves an account to be excluded (only a
 *  shared account can be excluded). */
export interface ImportLeftOut {
  id: string;
  why: 'excluded-here' | 'included-here' | 'reserved-here';
}

/** The scope that keeps a rule of the file from landing whole: held by a rule of this machine (a
 *  different rule from the file's, or one with no identity), or by an earlier rule of the same
 *  batch (`rule` absent). */
export interface ImportConflict {
  scope: RuleScopeRef;
  /** The rule here holding it, with every scope it holds (all of which a by-hand merge removes). */
  rule?: { id: string; label: string; scopes: RuleScopeRef[] };
}

/**
 * What an import does with one {@link ImportRuleSpec}, decided before anything is written:
 * `create` a new rule on every scope, `grow` the rule here that carries its identity (with the
 * scopes and members it lacks), leave it `unchanged` (the rule here already has all of it), or
 * `refused` with the engine's own refusal. Never a rule on part of the spec's scopes.
 */
export type ImportRuleVerdict =
  | {
      kind: 'create';
      scopes: RuleScopeRef[];
      include: string[];
      exclude: string[];
      leftOut: ImportLeftOut[];
    }
  | {
      kind: 'grow';
      /** The rule grown, as it stands before the import. */
      rule: FolderRule;
      /** The scopes it gains. */
      scopes: RuleScopeRef[];
      /** The members it gains. */
      include: string[];
      exclude: string[];
      leftOut: ImportLeftOut[];
    }
  | { kind: 'unchanged'; reason: string; rule?: FolderRule; leftOut: ImportLeftOut[] }
  | { kind: 'refused'; message: string; conflict?: ImportConflict };

/** Everything an import of rules would do: the verdict on each spec, in spec order, and every slot
 *  it would move off an account it reserves. */
export interface ImportRulesPlan {
  rules: ImportRuleVerdict[];
  handOffs: SlotHandOff[];
}

/** What {@link SwitchEngine.importRules} did with one spec it wrote (a `create` or `grow`). */
export type ImportRuleOutcome =
  | {
      ok: true;
      rule: FolderRule;
      /** True when the rule was created, false when the members were added to an existing one. */
      created: boolean;
      /** The outcome of making the rule's slot live, or null when that failed (the rule stands). */
      live: RuleLiveResult | null;
      runningSessions: RunningSession[];
    }
  | {
      ok: false;
      message: string;
      /** Set when part of the rule was written before the failure. */
      partial?: FolderRule;
    };

/** What {@link SwitchEngine.importRules} decided (`plan`, the same decision
 *  {@link SwitchEngine.planImportRules} reports), what it then did with each spec it wrote
 *  (`outcomes`, undefined for one it did not write), and the slots it moved first. */
export interface ImportRulesResult {
  plan: ImportRulesPlan;
  outcomes: Array<ImportRuleOutcome | undefined>;
  handedOff: SlotHandOff[];
}

/** What {@link SwitchEngine.importBundle} did with a credential bundle brought from another
 *  machine for an account already stored here. */
export interface ImportBundleResult {
  /** True when the brought bundle was written over the stored one. */
  replaced: boolean;
  /** Why it was or was not written:
   *  - `newer`: the brought grant was minted after the stored one (its access token expires later),
   *    so the stored refresh token is the one that has been spent.
   *  - `quarantined`: the stored login is known dead, so anything is better.
   *  - `missing`: the account has no stored bundle at all here.
   *  - `stored_newer`: the copy here (after adopting any live rotation) is as new or newer, so its
   *    tokens were kept. The login the brought identity names is still recorded on a row that
   *    recorded none, so a slot running that login is known to run this account. */
  reason: 'newer' | 'quarantined' | 'missing' | 'stored_newer';
  /** True when the account was live in a slot here and the brought credentials were written there
   *  too (verified by read-back), as a re-login does. */
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

/** A Claude Code session observed running under a ruled folder, from `<mainConfigDir>/sessions/*.json`.
 *  The engine cannot see a session's config dir (it is set at launch, not recorded), so a match is by
 *  a LIVE pid whose recorded cwd sits within the folder — enough to warn "these will be blocked until
 *  relaunched", never a hard guarantee that the session actually ran on the shared account. */
export interface RunningSession {
  /** The OS process id recorded in the session file, confirmed alive at scan time. */
  pid: number;
  /** The session's working directory, canonical, within the ruled folder. */
  cwd: string;
  /** The session file it was read from, for diagnostics. */
  sessionFile: string;
  /** Set when the session was counted for an alias scope although its title could not be learned
   *  (its transcript cannot be read, or it has none yet — a fork or a new session before its first
   *  prompt), because it runs in that scope's folder: it MAY be that conversation. */
  unidentified?: true;
}

/** What a rule change acts on, as an operator names it: a folder (the folder and every subfolder),
 *  or one session alias in one exact folder. Both are scopes of a rule, and every rule verb treats
 *  them alike. */
export type RuleScopeRef =
  { kind: 'folder'; folder: string } | { kind: 'alias'; folder: string; alias: string };

/** What Claude Code's transcript says about one session: its custom title (`/rename`, `--name`;
 *  null = unnamed — a generated title never counts) and the folder it was recorded in, as the one
 *  shared reading decides it (recordedFolder.ts readRecordedFolder: its first recorded cwd, or a
 *  later relocation, each trusted only when consistent with the transcript's project directory;
 *  null = none trusted, when `dirName` is the fallback — see recordedFolderFor). */
export interface SessionIdentity {
  customTitle: string | null;
  folder: string | null;
  /** The name of the project directory the transcript lives in. */
  dirName?: string;
  /** Set when the transcript exists but could not be read (locked, an IO error): its title is then
   *  UNKNOWN, not absent — `customTitle` null does not mean unnamed. */
  unreadable?: boolean;
}

/** Look sessions up by id in Claude Code's transcripts under `claudeDir` (the main config dir): a
 *  map from the LOWER-CASED session id to what its transcript records — or, for a transcript that
 *  exists but cannot be read, an entry marked `unreadable`. An id with no transcript yet is simply
 *  absent. Injected into the engine because the transcript reader lives with the daemon's session
 *  catalog; see `SwitchEngineOptions.sessionIdentity`. */
export type SessionIdentityLookup = (
  claudeDir: string,
  sessionIds: readonly string[],
) => Promise<ReadonlyMap<string, SessionIdentity>>;

/** What {@link SwitchEngine.ensureRuleLive} settled a rule's slot to — reported at the mechanism
 *  level like {@link ActivateResult}: `liveAccount` is the account whose credentials are now written
 *  to the profile, never a claim that a running session picked them up. */
export interface RuleLiveResult {
  ruleId: string;
  /** The account now live in the rule's slot, or `null` when none could be made live. */
  liveAccount: string | null;
  /** True when this call wrote an account's credentials into the profile (as opposed to finding one
   *  already correctly live). */
  activated: boolean;
  /** True when no account of the rule's pool could be made live — every one is quarantined, live in
   *  another slot, or failed to activate — or the only one live is a quarantined account kept for want
   *  of another (`liveAccount` names it then). The rule stands; its folders have no working account
   *  until one frees up or is re-logged in. */
  noWorkingAccount: boolean;
  /** True when nothing could be seated AND a login that does not belong in the slot (outside its
   *  pool, live elsewhere, or unrecognized) was cleared to fail the slot closed. Lets the
   *  repair/doctor report the eviction (an eviction leaves `activated` false, so it would otherwise
   *  be silent). */
  clearedSquatter?: boolean;
}

/** A slot moved off an account because the account could no longer be live there (see
 *  {@link IncludeResult.handedOff}). */
export interface SlotHandOff {
  slot: SlotId;
  /** The account the slot was moved off. */
  from: string;
  /** The account the slot now holds. */
  to: string;
}

/** What {@link SwitchEngine.includeInFolder} / {@link SwitchEngine.includeInAlias} did — reported so
 *  the CLI can tell the operator exactly what moved. */
export interface IncludeResult {
  /** The scope's rule after the change (created or updated). */
  rule: FolderRule;
  /** True when the folder had no rule and one was created. */
  created: boolean;
  /** The accounts this call moved from the shared pool into the reserved side. An account already
   *  reserved to another rule is only added to this rule's include list, and is not named here. */
  reserved: string[];
  /** The account ids removed from this rule's exclude list because they are now included. */
  unexcluded: string[];
  /** Slots that were moved off a newly reserved account first, because it could no longer be live
   *  there: the global slot (it never holds a reserved account), or another rule's slot whose pool
   *  no longer has it. */
  handedOff: SlotHandOff[];
  /** The outcome of making the rule's slot live (see {@link RuleLiveResult}). */
  live: RuleLiveResult;
  /** Running sessions found under the folder that keep their current account until relaunched. */
  runningSessions: RunningSession[];
}

/** What {@link SwitchEngine.excludeInFolder} / {@link SwitchEngine.excludeInAlias} did. */
export interface ExcludeResult {
  /** The scope's rule after the change (created or updated). */
  rule: FolderRule;
  /** True when the folder had no rule and one was created. */
  created: boolean;
  /** The account the rule's slot was moved off (or cleared of) because it is now excluded, or
   *  `null` when no excluded account was live there. */
  movedOff: string | null;
  /** The outcome of making the rule's slot live afterwards. */
  live: RuleLiveResult;
  /** Running sessions found under the rule's folders when the change was made. */
  runningSessions: RunningSession[];
}

/** What {@link SwitchEngine.resetFolder} / {@link SwitchEngine.resetAlias} did. */
export interface ResetResult {
  /** The canonical folder of the scope that was reset, as the rule stored it. */
  folder: string;
  /** For an alias scope: the alias as the rule stored it; absent for a folder. */
  alias?: string;
  /** True when the rule was removed entirely (no accounts named, or nothing left in it); false when
   *  only some accounts were removed, or only this folder left a rule that keeps other folders. */
  dissolved: boolean;
  /** The surviving rule when it was not dissolved. */
  rule?: FolderRule;
  /** Account ids returned to the shared pool because no rule includes them any more. */
  released: string[];
  /** True when the slot's live token had rotated under us and was adopted into the vault before the
   *  slot was cleared (only on dissolve). */
  adoptedRotation: boolean;
  /** Sessions observed running under the rule's folders — non-empty is what a non-forced dissolve
   *  (or a non-forced change that would leave the slot empty) refuses on. */
  runningSessions: RunningSession[];
}

/** The invariant {@link SwitchEngine.checkSlots} found broken. The kinds mirror §7's (a)-(e):
 *  - `account_in_multiple_slots` (a): one account's credentials are live in more than one slot —
 *    the single invariant the whole slot model exists to protect (a rotating refresh token can only
 *    survive in one place).
 *  - `reserved_live_in_global` (b): an account some rule includes is live in the global slot.
 *  - `outside_pool_live_in_rule` (c): an account that is not in a rule's pool (excluded there,
 *    reserved only to other rules, or an unrecognized login) is live in that rule's slot.
 *  - `rule_active_mismatch` (d): a rule's recorded `activeId` names a different account than the
 *    one whose identity is actually live in its profile.
 *  - `broken_profile_link` (e): a shared file/dir in a profile is no longer correctly linked to
 *    main (repaired by `ensureGroupProfile`, not by `repairSlots`).
 *  - `live_identity_mismatch`: a slot's live credentials are one stored account's token while its
 *    identity block names a different account — a switch torn between its two live writes that no
 *    pending intent describes. Every reader that goes by the identity block misjudges who is live, so
 *    it is repaired by re-seating the account the token belongs to (or the slot's rightful one).
 *  - `orphan_profile_login`: a profile dir no rule owns still holds a live login. It is no slot, so
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
  | 'outside_pool_live_in_rule'
  | 'rule_active_mismatch'
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
  /** The rule the breach concerns, when it is a rule slot. For `orphan_profile_login`, the name of
   *  the profile dir (the id of the rule that once owned it). */
  ruleId?: string;
}

/** What {@link SwitchEngine.repairSlots} did: the violations it fixed, those it could only alert on
 *  (unrecognized logins, broken profile links), and a human log of the corrective actions taken. */
export interface RepairResult {
  repaired: SlotViolation[];
  remaining: SlotViolation[];
  actions: string[];
}
