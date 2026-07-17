// Public surface of @claude-control/control-plane-bot — a credential-free control plane.
//
// STRUCTURAL GUARANTEE ("the bot holds zero credentials"): this package imports only
// '@claude-control/shared-protocol' plus its declared package.json dependencies (discord.js,
// ws, pino, node:*). It never imports '@claude-control/switch-engine',
// '@claude-control/session-runtime', or '@claude-control/daemon' — so it is physically
// incapable of touching an OAuth token or a vault. Verify at any time with:
//   grep -R "^import" packages/control-plane-bot/src | grep "@claude-control/"
// and confirm the only workspace package named is shared-protocol. Do not add a workspace
// dependency here without re-reading this comment first.

export { mintToken, hashToken, verifyToken } from './tokens.js';
export { BindingStore, type Binding } from './bindings.js';
export { PairingService, type ClaimResult, type PairingServiceOptions } from './pairing.js';
export {
  RelayServer,
  type DiscordGateway,
  type RelayServerOptions,
  type RelaySender,
  type SendResult,
} from './relay.js';
export { type Logger, noopLogger } from './logger.js';
export { atomicWriteFile, readJsonIfExists } from './fsutil.js';

export { DaemonStateCache, type SessionStatus } from './discord/stateCache.js';
export {
  buildUsageEmbed,
  buildTimelineEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildPermissionRequestEmbed,
  buildSwitchResultEmbed,
  buildDoneEmbed,
  buildWaitingEmbed,
  buildQuarantineEmbed,
} from './discord/embeds.js';
export {
  NOTIFICATION_COLOR,
  NOTIFICATION_ICON,
  truncateLabeled,
  EMBED_DESCRIPTION_LIMIT,
  EMBED_FIELD_VALUE_LIMIT,
  type NotificationKind,
} from './discord/richFormat.js';
export {
  handlePair,
  handleUsage,
  handleTimeline,
  handleAccounts,
  handleSessions,
  handleStatus,
  handleSwitch,
  handleRun,
  handleSay,
  handleApprove,
  handleDeny,
  handleStop,
  handleReauth,
  type CommandDeps,
  type CommandResult,
  type RunOptions,
} from './discord/commands.js';
export { renderPush, RELOGIN_COMMAND, type RenderedPush } from './discord/pushRender.js';
export {
  encodeButton,
  decodeButton,
  resolveTap,
  isDestructive,
  permissionButtons,
  buttonIdempotencyKey,
  CONFIRM_TTL_MS,
  type ButtonAction,
  type ButtonPhase,
  type ButtonScope,
  type ButtonStyle,
  type ButtonSpec,
  type ParsedButton,
  type TapOutcome,
} from './discord/buttons.js';
export { SeenKeys, type SeenKeysOptions } from './discord/idempotencyGuard.js';
export { DiscordJsGateway, type DiscordJsGatewayOptions } from './discord/discordJsGateway.js';
