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
  /** A quarantined account has a dead refresh token and must be re-logged-in before use. */
  quarantined: boolean;
  quarantineReason?: string;
  quarantinedAtMs?: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/** The registry index persisted at `vault/accounts.json`. */
export interface Registry {
  /** Id of the account whose credentials are currently written to the live files. */
  activeId: string | null;
  accounts: StoredAccount[];
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
