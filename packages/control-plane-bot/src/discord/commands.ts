// Slash-command and button -> protocol envelope mapping.
//
// Every handler takes `discordUserId` as an explicit parameter, sourced by the caller
// (discordJsGateway.ts) ONLY from `interaction.user.id`, and passes it straight into
// RelaySender.sendToUser — the daemon id is never touched directly here, so a handler is
// structurally incapable of addressing a daemon the invoking user doesn't own (RelayServer
// resolves and injects the real daemon id; see relay.ts). This module has no discord.js
// dependency beyond the EmbedBuilder return type, so it is testable with a fake relay.

import type { EmbedBuilder } from 'discord.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { DaemonStateCache } from './stateCache.js';
import {
  buildUsageEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildTimelineEmbed,
} from './embeds.js';
import type { BarRenderer } from './emojiBars.js';
import type { TimelineTrackStyle } from './richFormat.js';

export interface CommandDeps {
  relay: RelaySender;
  pairing: PairingService;
  cache: DaemonStateCache;
  /** How to draw usage bars. Optional so tests (and the pre-`ready` gateway) omit it and get
   *  the unicode default; the gateway sets it to the emoji renderer once app emojis upload. */
  barRenderer?: BarRenderer;
  /** How to draw `/timeline` reset tracks + marker glyphs — same lifecycle as `barRenderer`:
   *  omitted → unicode default, upgraded by the gateway once the sprites upload. */
  trackStyle?: TimelineTrackStyle;
}

export type CommandResult =
  | { kind: 'embed'; embed: EmbedBuilder }
  | { kind: 'text'; text: string }
  | { kind: 'error'; message: string };

/** `/pair` — issue a fresh pairing code for the invoking user. No envelope is sent here;
 *  nothing reaches a daemon until one later redeems the code over its own socket. */
export function handlePair(deps: CommandDeps, discordUserId: string): CommandResult {
  const code = deps.pairing.createCode(discordUserId);
  return {
    kind: 'text',
    text: `Pairing code: **${code}** — run \`cctl daemon run --pair ${code}\` on the host within 10 minutes.`,
  };
}

/** `/usage` — render the last usage.snapshot pushed for this user's daemon. There is no
 *  request/response round trip for usage: the daemon pushes on its own schedule, and this
 *  always answers from the cache DiscordGateway.deliver() has been fed. */
export function handleUsage(deps: CommandDeps, discordUserId: string): CommandResult {
  const usage = deps.cache.getUsage(discordUserId);
  if (!usage) return { kind: 'text', text: 'No usage data yet — the daemon has not reported in.' };
  // nowMs left to its default; barRenderer may be undefined → buildUsageEmbed uses unicode.
  return { kind: 'embed', embed: buildUsageEmbed(usage, undefined, deps.barRenderer) };
}

/** `/timeline` — the 5h-window budget + reset timeline, from the same cached snapshot as
 *  `/usage` (the daemon pushes; the bot only renders). */
export function handleTimeline(deps: CommandDeps, discordUserId: string): CommandResult {
  const usage = deps.cache.getUsage(discordUserId);
  if (!usage) return { kind: 'text', text: 'No usage data yet — the daemon has not reported in.' };
  return {
    kind: 'embed',
    embed: buildTimelineEmbed(usage, undefined, deps.barRenderer, deps.trackStyle),
  };
}

/** `/accounts` — same cache, a lighter view. */
export function handleAccounts(deps: CommandDeps, discordUserId: string): CommandResult {
  const usage = deps.cache.getUsage(discordUserId);
  if (!usage)
    return { kind: 'text', text: 'No account data yet — the daemon has not reported in.' };
  return { kind: 'embed', embed: buildAccountsEmbed(usage.accounts) };
}

/** `/sessions` — every session the daemon has reported a status for. */
export function handleSessions(deps: CommandDeps, discordUserId: string): CommandResult {
  return { kind: 'embed', embed: buildSessionListEmbed(deps.cache.getSessions(discordUserId)) };
}

/** `/status` — is this user's daemon currently connected at all. */
export function handleStatus(deps: CommandDeps, discordUserId: string): CommandResult {
  const online = deps.relay.isOnline(discordUserId);
  return { kind: 'text', text: online ? 'Daemon is online.' : 'Daemon is offline or not paired.' };
}

/** `/switch <accountId>` — request a hot-swap. `reason` is always 'manual' here (a human
 *  explicitly asked); the daemon's own 'near_cap' triggers go through a different path. */
export function handleSwitch(
  deps: CommandDeps,
  discordUserId: string,
  targetAccountId: string,
  requestId: string,
  idempotencyKey: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'switch.command',
    payload: { requestId, targetAccountId, reason: 'manual', idempotencyKey },
  }));
  return result.ok
    ? { kind: 'text', text: `Switch requested → ${targetAccountId}` }
    : { kind: 'error', message: result.error };
}

export interface RunOptions {
  resumeSessionId?: string;
  cwd?: string;
  accountId?: string;
}

/** `/run <prompt>` — start (or resume) a Claude Code session. Optional fields are only
 *  included in the payload when actually supplied — exactOptionalPropertyTypes forbids
 *  assigning an explicit `undefined`, and conditionally spreading is the clean way around it. */
export function handleRun(
  deps: CommandDeps,
  discordUserId: string,
  prompt: string,
  requestId: string,
  idempotencyKey: string,
  opts: RunOptions = {},
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'session.spawn',
    payload: {
      requestId,
      prompt,
      idempotencyKey,
      ...(opts.resumeSessionId !== undefined ? { resumeSessionId: opts.resumeSessionId } : {}),
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
    },
  }));
  return result.ok
    ? { kind: 'text', text: 'Session spawn requested.' }
    : { kind: 'error', message: result.error };
}

/** `/say <sessionId> <text>` — inject a message into a running session. */
export function handleSay(
  deps: CommandDeps,
  discordUserId: string,
  sessionId: string,
  text: string,
  idempotencyKey: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'prompt.inject',
    payload: { sessionId, text, idempotencyKey },
  }));
  return result.ok ? { kind: 'text', text: 'Sent.' } : { kind: 'error', message: result.error };
}

function handlePermissionResponse(
  deps: CommandDeps,
  discordUserId: string,
  requestId: string,
  decision: 'allow' | 'deny',
  scope: 'once' | 'session',
  idempotencyKey: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'permission.response',
    payload: { requestId, decision, scope, idempotencyKey },
  }));
  return result.ok
    ? { kind: 'text', text: decision === 'allow' ? 'Approved.' : 'Denied.' }
    : { kind: 'error', message: result.error };
}

/** `/approve <requestId>` and the "approve" button. */
export function handleApprove(
  deps: CommandDeps,
  discordUserId: string,
  requestId: string,
  scope: 'once' | 'session',
  idempotencyKey: string,
): CommandResult {
  return handlePermissionResponse(deps, discordUserId, requestId, 'allow', scope, idempotencyKey);
}

/** `/deny <requestId>` and the "deny" button. */
export function handleDeny(
  deps: CommandDeps,
  discordUserId: string,
  requestId: string,
  scope: 'once' | 'session',
  idempotencyKey: string,
): CommandResult {
  return handlePermissionResponse(deps, discordUserId, requestId, 'deny', scope, idempotencyKey);
}

/** `/stop <sessionId>` — protocol v1 has no dedicated "stop a session" payload (see
 *  shared-protocol/messages.ts): the only session-directed message is `prompt.inject`, which
 *  talks TO a running turn, not to the process supervisor. Misusing it as a stop signal
 *  would silently invent session-runtime behavior that package does not implement yet.
 *  Surface that honestly instead of guessing at semantics we don't control. */
export function handleStop(
  _deps: CommandDeps,
  _discordUserId: string,
  _sessionId: string,
): CommandResult {
  return { kind: 'error', message: 'stopping a session is not wired in protocol v1 yet.' };
}

/** `/reauth <accountId>` — re-authenticating a quarantined account is an interactive OAuth
 *  flow that must run on the host (the bot holds zero credentials by design — see the
 *  package-level architecture rule); there is no protocol message for it because the bot
 *  structurally cannot perform it. Point the user at the local command instead of pretending
 *  a Discord button could complete an OAuth login. */
export function handleReauth(
  _deps: CommandDeps,
  _discordUserId: string,
  accountId: string,
): CommandResult {
  return { kind: 'text', text: `Re-auth must run on the host: \`cctl login ${accountId}\`.` };
}
