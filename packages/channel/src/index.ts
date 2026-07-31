// Public surface of @claude-control/channel — the per-session MCP stdio server that bridges
// cctl channel injections into a running Claude Code session, and the model's replies back out.
// The executable is `dist/bin.js` (bin name `cctl-channel`); everything exported here exists so
// the daemon, the CLI, and tests can compose or drive the same pieces the binary composes.

export {
  resolveIdentity,
  readSessionRegistry,
  createParentOf,
  pidIsLive,
  MAX_ANCESTOR_HOPS,
  MAX_ANCESTOR_WALK_MS,
  REGISTRY_READ_ATTEMPTS,
  REGISTRY_RETRY_DELAY_MS,
  type IdentityResult,
  type ResolvedIdentity,
  type UnresolvedIdentity,
  type IdentityDeps,
  type SessionRegistryEntry,
  type ParentOf,
} from './identity.js';

export {
  DaemonLink,
  createDiscover,
  BACKOFF_BASE_MS,
  BACKOFF_CAP_MS,
  DEFAULT_POLL_MS,
  MIN_POLL_MS,
  MAX_POLL_MS,
  EMPTY_POLL_FLOOR_MS,
  STALE_ATTACHMENT_MS,
  type AttachIdentity,
  type ChannelItem,
  type DaemonAddress,
  type DaemonLinkOptions,
  type Deliver,
  type DeliverResult,
  type Discover,
  type DiscoverOptions,
  type FetchLike,
  type FetchLikeResponse,
  type RunOutcome,
} from './daemonLink.js';

export {
  ChannelServer,
  sanitizeMetaKeys,
  SERVER_NAME,
  type ChannelServerOptions,
} from './server.js';

export { noopLogger, type Logger } from './logger.js';

// The whole server, composed. `cctl channel serve` calls this so the CLI-hosted channel and the
// standalone `cctl-channel` binary are the same program rather than two that must be kept in step.
//
// Importing THIS barrel eagerly loads identity + daemonLink, which the composition itself is
// careful to defer. A caller that only needs to run the server should import the `./run` subpath
// instead and keep that saving.
export { runChannelServer } from './run.js';
