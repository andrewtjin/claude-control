// Public surface of the switch engine. Callers (daemon, CLI) depend only on these exports.
export * from './types.js';
export * from './errors.js';
export * from './paths.js';
export * from './logger.js';
export { type Protector, DpapiProtector, InsecurePassthroughProtector } from './dpapi.js';
export { AesGcmProtector } from './aesgcm.js';
export { FileKeyProtector, FileKeySource } from './fileKey.js';
export {
  KeychainKeySource,
  KeychainProtector,
  KeychainCredentialChannel,
  defaultExecRunner,
  quoteSecurityArg,
  VAULT_KEY_SERVICE,
  VAULT_KEY_ACCOUNT,
  CLAUDE_CLI_KEYCHAIN_SERVICE,
  type ExecRunner,
} from './keychain.js';
export { defaultProtector, defaultLiveCredentialChannel } from './protector.js';
export {
  refreshCredentials,
  exchangeAuthorizationCode,
  generatePkce,
  generateState,
  buildAuthorizeUrl,
  parsePastedCode,
  CLAUDE_CODE_CLIENT_ID,
  DEFAULT_TOKEN_ENDPOINT,
  DEFAULT_AUTHORIZE_ENDPOINT,
  DEFAULT_REDIRECT_URI,
  OAUTH_AUTHORIZE_SCOPES,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
  type ExchangeDeps,
  type PkcePair,
} from './oauth.js';
// The overload retry lives here rather than in each caller: the daemon's poller and the CLI's
// refresh path must agree on WHICH statuses are retried and on one shared status-page cache.
export {
  withOverloadRetry,
  probeClaudeStatus,
  describeStatus,
  isOverloadCode,
  createStatusProbeCache,
  OVERLOAD_STATUSES,
  CLAUDE_STATUS_URL,
  STATUS_INDICATOR_OK,
  STATUS_PROBE_TIMEOUT_MS,
  STATUS_CACHE_TTL_MS,
  SHORT_OVERLOAD_BUDGET,
  PATIENT_OVERLOAD_BUDGET,
  LOCKED_OVERLOAD_BUDGET_CAP_MS,
  OVERLOAD_BACKOFF_BASE_MS,
  OVERLOAD_BACKOFF_CAP_MS,
  RETRY_AFTER_CAP_MS,
  type OverloadAttemptContext,
  type OverloadBudget,
  type OverloadResponse,
  type OverloadRetryDeps,
  type OverloadRetryEvent,
  type OverloadRetryOutcome,
  type StatusFetchLike,
  type StatusProbeCache,
  type StatusVerdict,
} from './overload.js';
export {
  Vault,
  ACCOUNT_METADATA_REV,
  METADATA_BACKFILL_RETRY_MS,
  MAX_GROUPS,
  MAX_GROUP_MEMBERS,
  MAX_GROUP_FOLDERS,
  needsMetadataBackfill,
  type DedupeReport,
} from './vault.js';
// Folder canonicalization — shared verbatim between this package and the enforcement guard, which
// embeds the compiled source of the canonicalizer trio (see folderPath.ts).
export {
  canonicalizeFolder,
  folderKey,
  isWithin,
  resolveBinding,
  exactBinding,
  checkBindTarget,
  embeddableFolderPathSource,
  type CanonicalizeDeps,
  type CanonicalizeResult,
  type BindTargetDeps,
  type FolderBoundGroup,
} from './folderPath.js';
// The non-secret folder-bindings snapshot the guard reads.
export {
  buildFolderBindingSnapshot,
  readFolderBindingSnapshot,
  writeFolderBindingSnapshot,
  type BindEnforceMode,
  type BuildSnapshotInput,
} from './folderBindings.js';
export { resolveAccountRef, type ResolveResult } from './resolveAccount.js';
export {
  CredentialStore,
  FileCredentialChannel,
  type LiveCredentialChannel,
} from './credentialStore.js';
export { acquireLock, Lock, type LockOptions } from './lock.js';
export { IntentStore } from './intent.js';
export { AuditLog, type AuditEntry, type SwitchOrigin } from './audit.js';
export {
  SwitchEngine,
  DEFAULT_MIN_SWITCH_INTERVAL_MS,
  type SwitchEngineOptions,
  type ActivateOptions,
  type BindFs,
  type RefreshFn,
  type ExchangeFn,
  type ReauthResult,
} from './switchEngine.js';
// Not switch-engine domain logic, but the workspace's only fsync'd atomic writer. Exposed so
// other packages replace a state file the way this one already does, instead of hand-rolling a
// plain writeFile that a concurrent reader can catch half-written.
export { atomicWriteFile } from './fsutil.js';
// Profile directory materialization: builds/re-verifies a group's config dir against main.
export {
  ensureGroupProfile,
  planGroupProfile,
  computeClaudeJsonMerge,
  createNodeProfileFs,
  defaultProfilesRoot,
  groupProfileDir,
  SHARED_PROFILE_DIRS,
  PROFILE_LOCAL_DIRS,
  SHARED_PROFILE_FILES,
  CLAUDE_JSON_MERGE_ALLOWLIST,
  type ProfileFs,
  type ProfilePlatform,
  type EntryKind,
  type FileIdentity,
  type ProfilePlan,
  type DirPlan,
  type FilePlan,
  type ClaudeJsonPlan,
  type DirAction,
  type FileAction,
  type ClaudeJsonAction,
  type RepairWinner,
  type ProfileReport,
  type ProfileSkip,
  type EnsureProfileOptions,
} from './profile.js';
