// Public surface of the switch engine. Callers (daemon, CLI) depend only on these exports.
export * from './types.js';
export * from './errors.js';
export * from './paths.js';
export * from './logger.js';
export { type Protector, DpapiProtector, InsecurePassthroughProtector } from './dpapi.js';
export {
  refreshCredentials,
  CLAUDE_CODE_CLIENT_ID,
  DEFAULT_TOKEN_ENDPOINT,
  DEFAULT_REFRESH_SKEW_MS,
  type RefreshDeps,
} from './oauth.js';
export { Vault } from './vault.js';
export { CredentialStore } from './credentialStore.js';
export { acquireLock, Lock, type LockOptions } from './lock.js';
export { IntentStore } from './intent.js';
export { AuditLog, type AuditEntry } from './audit.js';
export { SwitchEngine, type SwitchEngineOptions, type RefreshFn } from './switchEngine.js';
