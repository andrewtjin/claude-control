// Public surface of the switch engine. Callers (daemon, CLI) depend only on these exports.
export * from './types.js';
export * from './errors.js';
export * from './paths.js';
export * from './logger.js';
export { type Protector, DpapiProtector, InsecurePassthroughProtector } from './dpapi.js';
export {
  AesGcmProtector,
  KeychainKeySource,
  KeychainProtector,
  KeychainCredentialChannel,
  defaultExecRunner,
  VAULT_KEY_SERVICE,
  VAULT_KEY_ACCOUNT,
  CLAUDE_CLI_KEYCHAIN_SERVICE,
  resolveClaudeCliKeychainTarget,
  type ExecRunner,
} from './keychain.js';
export { defaultProtector, defaultLiveCredentialChannel } from './protector.js';
export {
  refreshCredentials,
  CLAUDE_CODE_CLIENT_ID,
  DEFAULT_TOKEN_ENDPOINT,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
} from './oauth.js';
export { Vault } from './vault.js';
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
} from './switchEngine.js';
// Not switch-engine domain logic, but the workspace's only fsync'd atomic writer. Exposed so
// other packages replace a state file the way this one already does, instead of hand-rolling a
// plain writeFile that a concurrent reader can catch half-written.
export { atomicWriteFile } from './fsutil.js';
