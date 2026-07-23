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
  buildQuestionEmbed,
  buildAnsweredQuestionEmbed,
  buildLapsedQuestionEmbed,
  buildSwitchResultEmbed,
  buildDoneEmbed,
  buildWaitingEmbed,
  buildQuarantineEmbed,
  buildSessionCardEmbed,
  buildSessionSummaryEmbed,
  type SessionCardModel,
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
  handleQuestionAnswer,
  handleStop,
  handleReauth,
  type CommandDeps,
  type CommandResult,
  type QuestionAnswerResponse,
  type RunOptions,
} from './discord/commands.js';
export { renderPush, RELOGIN_COMMAND, type RenderedPush } from './discord/pushRender.js';
export {
  QuestionCardRegistry,
  QuestionAnswerCollector,
  questionSelectSpecs,
  encodeQuestionSelect,
  encodeQuestionModal,
  decodeQuestionSelect,
  decodeQuestionModal,
  encodeOptionValue,
  questionSubmitDedupeKey,
  questionIdempotencyKey,
  OTHER_VALUE,
  QUESTION_MODAL_INPUT_ID,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  type SelectSpec,
  type SelectOptionSpec,
  type ParsedQuestionId,
  type CardRef as QuestionCardRef,
} from './discord/questionCards.js';
export {
  encodeButton,
  decodeButton,
  resolveTap,
  isDestructive,
  permissionButtons,
  sessionCardButtons,
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
export {
  OrderedOutput,
  type OutputChunk,
  type OutputKind,
  type CommittedItem,
  type OrderedOutputOptions,
} from './discord/sessionOutput.js';
export {
  SessionPlanner,
  sessionRouteKey,
  type SessionRoute,
  type GatewayOp,
  type PlanResult,
  type SessionPlannerConfig,
} from './discord/sessionPlanner.js';
export {
  ThreadRegistry,
  PersistentThreadRegistry,
  type DeliveryTarget,
} from './discord/threadRegistry.js';
export {
  DiscordJsGateway,
  type DiscordJsGatewayOptions,
  type SessionChannelResolver,
  type SessionThreadParent,
} from './discord/discordJsGateway.js';
