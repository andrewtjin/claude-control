// Public surface of @claude-control/daemon — the per-user background process. It owns local
// state (sqlite), polls usage across every account without switching, computes the burn-down
// plan, journals which account was active when, receives Claude Code hooks on loopback, and
// holds the outbound control-plane connection to the bot. Local Claude use must never depend
// on it.

export {
  Store,
  type UsageSnapshotRow,
  type ActivationIntervalRow,
  type PendingPermissionRow,
  type SessionRow,
  type OutboxRow,
} from './store.js';

export {
  parseUsageEndpointResponse,
  parseCachedUsage,
  type ParsedUsage,
  type ParseUsageOptions,
} from './usageParse.js';

export {
  UsagePoller,
  toUsageSnapshotPayload,
  USAGE_ENDPOINT,
  ANTHROPIC_BETA_HEADER,
  POLL_FLOOR_MS,
  POLL_JITTER_MS,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  type FetchLike,
  type FetchLikeResponse,
  type PollAccount,
  type UsagePollerOptions,
  type AccountPollResult,
  type SnapshotResult,
} from './usagePoller.js';

export { AttributionJournal, type AttributionJournalOptions } from './attributionJournal.js';

export {
  HookReceiver,
  DEFAULT_HOOK_EVENT_NAMES,
  type HookEventNames,
  type HookReceiverOptions,
  type ResolvePermissionResult,
  type HookReceiverCliHandlers,
  type SessionCommandBase,
  type SessionRegisterInput,
  type SessionLabelInput,
  type SessionWatchInput,
  type SessionCommandResult,
  type TrackedSessionView,
} from './hookReceiver.js';

export {
  hookEndpointPath,
  readHookEndpoint,
  writeHookEndpoint,
  type HookEndpoint,
} from './hookEndpoint.js';

export {
  ControlPlaneClient,
  type ConnectionState,
  type ControlPlaneClientOptions,
  type ControlPlaneHandlers,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';

export {
  installHooks,
  buildDaemonHookSpecs,
  type HookCommandSpec,
  type InstallHooksOptions,
  type BuildDaemonHookSpecsOptions,
} from './hookInstaller.js';

export {
  hookSecretPath,
  loadHookSecret,
  loadOrCreateHookSecret,
  type HookSecretOptions,
} from './hookSecret.js';

export {
  AutoSwitcher,
  DEFAULT_AUTOSWITCH_COOLDOWN_MS,
  type AutoSwitcherOptions,
  type AutoSwitchActivateResult,
} from './autoSwitcher.js';

export {
  Daemon,
  type AutoSwitcherLike,
  type DaemonOptions,
  type SwitchEngineLike,
} from './daemon.js';
