// Shared contract for the Slack surface modules.
//
// WHY this file exists: the Slack surface is several sibling modules that all hang off one
// Bolt App — slackGateway.ts (composition root: socket lifecycle + envelope dispatch),
// slackCommands.ts (`/cctl` slash dispatch), slackBlocks.ts (Block Kit cards + interactivity),
// slackSessionDelivery.ts (per-session DM threads). Pinning the types they exchange here keeps
// the runtime module graph acyclic: slackGateway imports the siblings' register functions,
// while the siblings import ONLY these types (type-only edges are erased at compile time).
//
// Division of labour the types below encode:
//   - Modules deal in RAW Slack user ids (`U…`). The gateway parses the namespaced principal
//     (`slack:<teamId>:<userId>`, see ../principal.ts) once, at the deliver() boundary, and
//     modules call principalOf() to go back to the namespaced form whenever they talk to the
//     relay, pairing, or a reused command handler — those layers only ever see opaque
//     principal strings, which is what keeps bindings.json migration-free.
//   - deliver() dispatch order is: session delivery → cards → built-ins (stats waiters,
//     state-cache feed) → plain-text fallback. First taker wins; each handler returns whether
//     it owned the envelope kind.
//   - Outbound pacing is a SURFACE-WIDE concern, not a per-module one: Slack throttles per
//     channel, and on Slack one DM channel carries every session thread plus every direct send
//     to that user. The composition root owns the one queue per channel and hands it to the
//     modules that post series of messages (see {@link PacedChannelSend}).

import type { App } from '@slack/bolt';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { Logger } from '../logger.js';
import type { PendingStatsScans } from '../discord/pendingStatsScans.js';
import type { DaemonStateCache } from '../discord/stateCache.js';

/** Bolt's own WebClient, named via the App type rather than imported from @slack/web-api —
 *  a direct import would add a dependency edge this package never declares. */
export type SlackWebClient = App['client'];

/** Everything a Slack surface module may need from the composition root. Constructed once by
 *  SlackGateway.start() (teamId comes from auth.test, so it cannot exist earlier) and handed
 *  to every register function. */
export interface SlackContext {
  web: SlackWebClient;
  logger: Logger;
  relay: RelaySender;
  pairing: PairingService;
  /** Workspace (team) id from auth.test; the first segment of every Slack principal. A
   *  single-workspace deployment still checks it on inbound principals so a stale binding
   *  from another workspace can never be delivered across workspaces. */
  teamId: string;
  /** Daemon-pushed state, fed by deliver() and read by status/usage commands — the same
   *  cache-answers-commands shape the Discord surface uses. */
  cache: DaemonStateCache;
  /** stats.result waiters. Waiters MUST be registered before the request frame is sent to the
   *  daemon (see pendingStatsScans.ts): a result that arrives with no waiter is dropped by
   *  design, so register-then-send ordering is a correctness requirement, not a style choice. */
  statsScans: PendingStatsScans;
  /** Open (or return the cached) IM conversation with a workspace user → channel id. Cached
   *  because conversations.open is rate-limited and every deliver() needs the channel. */
  openDm(slackUserId: string): Promise<string>;
  /** The namespaced principal (`slack:<teamId>:<userId>`) for relay/pairing-facing calls. */
  principalOf(slackUserId: string): string;
}

/**
 * Run one outbound Slack call through the surface's shared per-channel pacer.
 *
 * Slack's ~1 msg/sec ceiling is per CHANNEL (see slackFormat.ts's MIN_CHANNEL_SEND_INTERVAL_MS),
 * and a Slack DM channel is shared by every session thread for that user, the plain-text
 * fallback, and the pairing primer — so the queue that enforces it must be one per channel for
 * the whole surface, not one per module. Calls for a channel run in submission order, each
 * waiting out whatever is left of the interval since the previous one; the result (and any
 * failure) is the wrapped call's own. Every module that posts a SERIES of messages into a
 * channel routes them through this.
 */
export type PacedChannelSend = <T>(channelId: string, call: () => Promise<T>) => Promise<T>;

/** Constructor options for SlackGateway — kept here so bin.ts can be written against the
 *  contract without importing the implementation's module graph at type-check time. */
export interface SlackGatewayOptions {
  relay: RelaySender;
  pairing: PairingService;
  logger: Logger;
  /** Bot User OAuth token (xoxb-…). */
  botToken: string;
  /** App-level token with connections:write (xapp-…) — Socket Mode's WebSocket credential. */
  appToken: string;
  /** Durable home for the session→thread registry; same directory bin.ts hands the Discord
   *  gateway, so one deployment keeps all its routing state together. */
  stateDir: string;
}
