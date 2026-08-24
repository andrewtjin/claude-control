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
  OVERLOAD_BACKOFF_BASE_MS,
  OVERLOAD_BACKOFF_CAP_MS,
  RETRY_AFTER_CAP_MS,
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
  needsMetadataBackfill,
} from './vault.js';
export { resolveAccountRef, type ResolveResult } from './resolveAccount.js';
export {
  CredentialStore,
  FileCredentialChannel,
  type LiveCredentialChannel,
} from './credentialStore.js';
export { acquireLock, Lock, type LockOptions } from './lock.js';
export { IntentStore } from './intent.js';
export { AuditLog, type AuditEntry } from './audit.js';
export {
  SwitchEngine,
  DEFAULT_MIN_SWITCH_INTERVAL_MS,
  type SwitchEngineOptions,
  type ActivateOptions,
  type RefreshFn,
  type ExchangeFn,
  type ReauthResult,
} from './switchEngine.js';
// Not switch-engine domain logic, but the workspace's only fsync'd atomic writer. Exposed so
// other packages replace a state file the way this one already does, instead of hand-rolling a
// plain writeFile that a concurrent reader can catch half-written.
export { atomicWriteFile } from './fsutil.js';
