// Slash-command and button -> protocol envelope mapping.
//
// Every handler takes `discordUserId` as an explicit parameter, sourced by the caller
// (discordJsGateway.ts) ONLY from `interaction.user.id`, and passes it straight into
// RelaySender.sendToUser — the daemon id is never touched directly here, so a handler is
// structurally incapable of addressing a daemon the invoking user doesn't own (RelayServer
// resolves and injects the real daemon id; see relay.ts). This module has no discord.js
// dependency beyond the EmbedBuilder return type, so it is testable with a fake relay.

import type { EmbedBuilder } from 'discord.js';
import type { PayloadOf } from '@claude-control/shared-protocol';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { DaemonStateCache } from './stateCache.js';
import {
  buildUsageEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildSettingsEmbed,
  buildStatsEmbed,
  buildTimelineEmbed,
} from './embeds.js';
import type { BarRenderer } from './emojiBars.js';
import type { TimelineTrackStyle } from './richFormat.js';
import { pruneButtons, type ButtonSpec } from './buttons.js';
import type { SessionChannelSource } from './sessionChannels.js';

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
  /** `components` lets a reply carry buttons (e.g. `/prune`'s armed confirm control); plain
   *  ButtonSpecs so this module stays free of discord.js component types — the gateway inflates. */
  | { kind: 'text'; text: string; components?: ButtonSpec[][] }
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

/** `/stats` — absolute token counts, from the last `stats.snapshot` the daemon pushed. Same
 *  cache-answer pattern as `/usage`, but the snapshots arrive far less often (each one costs the
 *  host a transcript scan), so the "not reported yet" copy says what to wait for rather than
 *  implying something is broken. */
export function handleStats(deps: CommandDeps, discordUserId: string): CommandResult {
  const stats = deps.cache.getStats(discordUserId);
  if (!stats) {
    return {
      kind: 'text',
      text: 'No token stats yet — the daemon reports these every 15 minutes once it is running.',
    };
  }
  return { kind: 'embed', embed: buildStatsEmbed(stats) };
}

/** `/stats days:N` — ask the daemon to scan its transcripts over an explicitly chosen window.
 *
 *  The cached-snapshot answer above cannot serve this: the cache holds ONE window (the 7 days the
 *  daemon pushes), and the per-account/per-model breakdowns are aggregates that cannot be re-sliced
 *  into a different window after the fact. So an explicit `days` is a real round trip to the host.
 *
 *  This function only SENDS. The answer arrives later on the delivery path and is matched back to
 *  the waiting interaction by `requestId` (see PendingStatsScans) — so a caller must register its
 *  wait before calling this, and the returned result reports only whether the request got out. */
export function handleStatsScan(
  deps: CommandDeps,
  discordUserId: string,
  days: number,
  requestId: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'stats.request',
    payload: { requestId, days },
  }));
  return result.ok
    ? { kind: 'text', text: `Scanning the last ${days} day${days === 1 ? '' : 's'} on the host…` }
    : { kind: 'error', message: result.error };
}

/** `/settings` — the daemon's effective configuration, from the settings.snapshot it pushes
 *  alongside every usage snapshot (same cache-answer pattern as `/usage`). */
export function handleSettings(deps: CommandDeps, discordUserId: string): CommandResult {
  const settings = deps.cache.getSettings(discordUserId);
  if (!settings) return { kind: 'text', text: 'No settings yet — the daemon has not reported in.' };
  return { kind: 'embed', embed: buildSettingsEmbed(settings) };
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

/** `/say <sessionId|label> <text>` — inject a message into a running session. `sessionId` is
 *  passed through verbatim; a registered session's label resolves to its real id daemon-side
 *  (Daemon.resolveInteractiveRef), so the bot itself stays oblivious to the distinction. */
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

/** The gateway's assembled answer for a question.request — the wire `answers` (each keyed by
 *  question text, per the protocol) plus the deterministic idempotencyKey. Kept as a plain struct
 *  so this module needs no knowledge of how the answers were collected across the card's selects
 *  and modals. */
export interface QuestionAnswerResponse {
  requestId: string;
  answers: PayloadOf<'question.response'>['answers'];
  idempotencyKey: string;
}

/** The answer to an AskUserQuestion card — send `question.response` to the invoking user's daemon,
 *  the same ACL-safe path as every other command (the caller never chooses a daemon id). An
 *  offline daemon returns an error result unchanged: the gateway leaves the card answerable so the
 *  user can retry once the daemon returns, rather than falsely marking it answered. */
export function handleQuestionAnswer(
  deps: CommandDeps,
  discordUserId: string,
  response: QuestionAnswerResponse,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'question.response',
    payload: {
      requestId: response.requestId,
      answers: response.answers,
      idempotencyKey: response.idempotencyKey,
    },
  }));
  return result.ok
    ? { kind: 'text', text: 'Answer sent to the session.' }
    : { kind: 'error', message: result.error };
}

/** `/stop <sessionId>` and the Stop button — request an orderly stop of a managed session. The
 *  `session.stop` wire type exists in the protocol; escalation (interrupt → grace →
 *  hard stop) is the daemon's policy and the acknowledgment rides on the `session.status`
 *  transitions the daemon already emits, so there is no dedicated stop.result to wait on here.
 *  `idempotencyKey` lets a double-tapped Stop resolve to "already handled" (daemon-side too). */
export function handleStop(
  deps: CommandDeps,
  discordUserId: string,
  sessionId: string,
  idempotencyKey: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'session.stop',
    payload: { sessionId, idempotencyKey },
  }));
  return result.ok
    ? { kind: 'text', text: 'Stop requested.' }
    : { kind: 'error', message: result.error };
}

/** Session states a prune ALWAYS removes — the registry's terminal states. The daemon also
 *  prunes non-terminal leftovers it holds no live handle for (records an earlier daemon run
 *  abandoned), which this cache cannot distinguish from live sessions, so the preview counts
 *  only the certain set; the daemon's registry is the authority on what actually gets
 *  pruned. */
const DORMANT_STATES = new Set(['done', 'failed', 'orphaned']);

/** `/prune` — the confirmation card. Nothing is sent to the daemon here: the reply carries an
 *  ARMED Prune button (two-tap confirm, like every destructive control) and only the confirmed
 *  tap sends the actual `session.prune` (see {@link handlePruneConfirm}). The preview counts the
 *  BOT's cached view; the daemon may know dormant records this cache never saw (e.g. after a bot
 *  restart), so the copy promises "all dormant records", not the listed count. */
export function handlePruneRequest(
  deps: CommandDeps,
  discordUserId: string,
  requestId: string,
): CommandResult {
  if (!deps.relay.isOnline(discordUserId)) {
    return { kind: 'error', message: 'Daemon is offline or not paired.' };
  }
  const dormant = deps.cache.getSessions(discordUserId).filter((s) => DORMANT_STATES.has(s.state));
  const listed = dormant.map((s) => `\`${s.sessionId.slice(0, 8)}\` (${s.state})`).join(', ');
  const preview =
    dormant.length > 0
      ? `${dormant.length} dormant here: ${listed}.`
      : 'None known here (the daemon may still hold some).';
  return {
    kind: 'text',
    text:
      `Prune removes ALL dormant session records (done / failed / orphaned, plus records ` +
      `left behind by an earlier daemon run) from the daemon's registry. ${preview}\nA ` +
      `pruned session can no longer be revived with \`/say\` — the conversation itself ` +
      `stays on the host. Live sessions are untouched.`,
    components: pruneButtons({ requestId }),
  };
}

/** The confirmed Prune tap — the only place a `session.prune` frame is actually sent. */
export function handlePruneConfirm(
  deps: CommandDeps,
  discordUserId: string,
  requestId: string,
  idempotencyKey: string,
): CommandResult {
  const result = deps.relay.sendToUser(discordUserId, (daemonId) => ({
    daemonId,
    type: 'session.prune',
    payload: { requestId, idempotencyKey },
  }));
  return result.ok
    ? { kind: 'text', text: 'Prune requested.' }
    : { kind: 'error', message: result.error };
}

/** `/reauth <accountId>` — re-authenticating a quarantined account is an interactive OAuth
 *  flow that must run on the host (the bot holds zero credentials by design — see the
 *  package-level architecture rule); there is no protocol message for it because the bot
 *  structurally cannot perform it. Point the user at `cctl accounts relogin <label>`, which
 *  re-logs into the EXISTING vault entry in place (same account id — usage attribution survives,
 *  quarantine cleared). This copy is kept in lockstep with the quarantine card's `RELOGIN_COMMAND`. */
export function handleReauth(
  _deps: CommandDeps,
  _discordUserId: string,
  accountId: string,
): CommandResult {
  return {
    kind: 'text',
    text:
      `Re-auth must run on the host (the bot holds no credentials). Run ` +
      `\`cctl accounts relogin <label>\` to re-login in place (usage history kept), then ` +
      `\`cctl switch <label>\`. (quarantined account: ${accountId})`,
  };
}

// ---------------------------------------------------------------------------
// `/thread-here` — a user pinning their own session-thread channel from inside Discord.
//
// Unlike every other command here, this one reaches no daemon: it decides where the BOT delivers a
// user's future session threads. What it shares with the rest of the module is the split — the
// decision tree and every reply string are pure and live here; the three things that need a live
// Discord connection (reading the invoking channel, probing that a private thread can actually be
// created in it, and checking a channel's health for the status reply) stay behind seams in the
// gateway and arrive here as plain data. That is what makes the tree exhaustively testable, and it
// is the tree — not the Discord calls — that carries the guarantees.

/** What the user asked for. `pin` is the default because the command names a place. */
export type ThreadHereAction = 'pin' | 'clear' | 'show';

/** Everything about the invoking channel that the pin decision depends on, gathered by the gateway
 *  from the interaction. Deliberately booleans-and-labels rather than a discord.js channel: the
 *  decision must be reproducible in a test without a Discord connection, and every one of these
 *  facts is either present on the interaction payload or one cached lookup away. */
export interface ThreadHereChannelFacts {
  /** The command ran in a server, not a DM. */
  inGuild: boolean;
  /** The bot itself is a member of that server. False when a user-installed app is used in a server
   *  the bot was never added to — Discord then reports only a fixed baseline for the bot's
   *  permissions, so "grant these permissions" would be advice that cannot work. */
  botInGuild: boolean;
  /** The channel could be read at all (from the interaction, or a fetch by id). */
  channelResolved: boolean;
  /** The command ran inside a thread. Threads cannot host threads of their own. */
  isThread: boolean;
  /** An ordinary guild text channel — the same narrowing session-thread creation itself applies, so
   *  anything else would be pinned and then silently unusable. */
  isGuildText: boolean;
  /** Human-readable names of the thread permissions the bot lacks here, in fix order. */
  missingPermissions: readonly string[];
}

/** Why a `/thread-here` invocation changed nothing. Every one of these is reported to the user with
 *  what to do about it — the point of the command's preflight is that a channel the bot cannot post
 *  in fails LOUDLY at command time instead of silently at delivery time hours later. */
export type ThreadHereRejection =
  | { kind: 'not-in-guild' }
  | { kind: 'bot-not-in-guild' }
  | { kind: 'channel-unresolved' }
  | { kind: 'inside-thread' }
  | { kind: 'not-text-channel' }
  | { kind: 'missing-permissions'; missing: readonly string[] }
  /** A real thread create + member add was attempted here and Discord refused it. */
  | { kind: 'probe-failed'; detail: string }
  /** The choice could not be written to disk, so it would not survive a restart. */
  | { kind: 'save-failed' };

/** The subset {@link rejectThreadHereChannel} can return: everything decidable from the interaction
 *  alone, before anything live is attempted and long before anything is written. */
export type ThreadHereChannelRejection = Exclude<
  ThreadHereRejection,
  { kind: 'probe-failed' } | { kind: 'save-failed' }
>;

/** Whether a pinned channel is actually usable right now, for the status reply. Separated from the
 *  rejection union because these are observations about a channel the user is NOT currently
 *  standing in — nothing is being changed, so nothing is being refused.
 *
 *  `user-cannot-access` exists because a session thread is only half the bot's doing: it creates a
 *  private thread and then admits the USER to it, and that second half fails the moment the user
 *  leaves the server or loses sight of the channel — with the bot's own permissions untouched. That
 *  is the likeliest reason someone's output quietly reverts to DMs long after they pinned, so a
 *  status reply that only inspected the bot's side would answer "all fine" to the very question it
 *  exists to answer. */
export type ThreadHereChannelHealth =
  | { kind: 'ok' }
  | { kind: 'unreachable' }
  | { kind: 'missing-permissions'; missing: readonly string[] }
  | { kind: 'user-cannot-access' };

/** Where this user's next session thread would go, and why. `source` is what turns the status reply
 *  from an answer into an explanation — "pinned by you" and "this deployment's default" call for
 *  completely different next steps. */
export type ThreadHereStatus =
  | {
      destination: 'channel';
      channelId: string;
      source: SessionChannelSource;
      health: ThreadHereChannelHealth;
    }
  | { destination: 'dm'; source: SessionChannelSource };

/** Everything a `/thread-here` invocation can end as. `already-pinned` and `already-dm` are
 *  distinct from `pinned`/`cleared` because a no-op that says "done" reads as a change that did not
 *  happen; naming them lets the reply say the preflight was re-run and the answer still holds.
 *
 *  `already-dm` means the DM choice is already RECORDED — not merely that the user's output happens
 *  to arrive by DM today. Clearing with no pin at all still writes one, so that a later operator
 *  edit cannot sweep up someone who explicitly asked for DMs. */
export type ThreadHereOutcome =
  | { kind: 'pinned'; channelId: string; previousChannelId?: string }
  | { kind: 'already-pinned'; channelId: string }
  | { kind: 'cleared'; overriddenChannelId?: string }
  | { kind: 'already-dm' }
  | { kind: 'status'; status: ThreadHereStatus }
  | { kind: 'rejected'; rejection: ThreadHereRejection };

/** Closing sentence on every rejection. The preflight's whole promise is that a refused pin leaves
 *  routing exactly as it was, and a user cannot verify that from the outside — so it is stated,
 *  every time, in the same words. */
const NOTHING_CHANGED = 'Nothing was changed.';

/** Decide whether the invoking channel can host this user's session threads, from the interaction
 *  alone.
 *
 *  The order is fixed and runs most-actionable-first, which matters because these overlap: a DM has
 *  no permissions at all, and a channel that failed to resolve has no type. Reporting "I am missing
 *  View Channel" to someone who ran the command in a DM would send them to edit permissions that
 *  were never the problem. */
export function rejectThreadHereChannel(
  facts: ThreadHereChannelFacts,
): ThreadHereChannelRejection | undefined {
  if (!facts.inGuild) return { kind: 'not-in-guild' };
  if (!facts.botInGuild) return { kind: 'bot-not-in-guild' };
  if (!facts.channelResolved) return { kind: 'channel-unresolved' };
  if (facts.isThread) return { kind: 'inside-thread' };
  if (!facts.isGuildText) return { kind: 'not-text-channel' };
  if (facts.missingPermissions.length > 0) {
    return { kind: 'missing-permissions', missing: facts.missingPermissions };
  }
  return undefined;
}

/** The reply text for each rejection: what went wrong, who can fix it, and that nothing changed. */
function threadHereRejectionMessage(rejection: ThreadHereRejection): string {
  switch (rejection.kind) {
    case 'not-in-guild':
      return (
        '`/thread-here` pins a server text channel, so run it in one. To send your session ' +
        `threads to your DMs instead, run \`/thread-here action:clear\` from anywhere. ${NOTHING_CHANGED}`
      );
    case 'bot-not-in-guild':
      return (
        'This server does not have the bot added, so I cannot create threads in it. Ask a ' +
        `server admin to add the bot, then run \`/thread-here\` again. ${NOTHING_CHANGED}`
      );
    case 'channel-unresolved':
      return `I could not read this channel just now. Try again in a moment. ${NOTHING_CHANGED}`;
    case 'inside-thread':
      return (
        'Run `/thread-here` in the channel itself, not inside a thread — a thread cannot host ' +
        `threads of its own. ${NOTHING_CHANGED}`
      );
    case 'not-text-channel':
      return (
        'I can only pin an ordinary server text channel. Voice, stage, forum, category and ' +
        `announcement channels cannot host private threads. ${NOTHING_CHANGED}`
      );
    case 'missing-permissions':
      return (
        `I cannot create private threads in this channel — I am missing: ${rejection.missing.join(', ')}. ` +
        `Ask a server admin to grant those to the bot here, then run \`/thread-here\` again. ${NOTHING_CHANGED}`
      );
    case 'probe-failed':
      return (
        `Discord refused a test thread in this channel (${rejection.detail}). Your session ` +
        'threads will keep going where they go now. Try again in a moment, or pick another ' +
        `channel. ${NOTHING_CHANGED}`
      );
    case 'save-failed':
      return `I could not save that just now — try again in a moment. ${NOTHING_CHANGED}`;
  }
}

/** The status reply. Every branch names the destination, the authority behind it, and the two ways
 *  out — a user reading this because their output turned up somewhere unexpected needs all three. */
function threadHereStatusMessage(status: ThreadHereStatus): string {
  if (status.destination === 'dm') {
    return status.source === 'pin'
      ? 'Your session threads go to your DMs, cleared by you. Run `/thread-here` in a channel to pin one.'
      : 'Your session threads go to your DMs. Run `/thread-here` in a channel to send them there instead.';
  }
  const where = `<#${status.channelId}>`;
  if (status.source === 'pin') {
    // A pin the bot cannot honour is the case worth spelling out: delivery has silently degraded to
    // DMs and the setting still says otherwise, so say both halves and how to repair either.
    if (status.health.kind === 'unreachable') {
      return (
        `Your session threads are pinned to ${where}, but I cannot use that channel right now — ` +
        'it may have been deleted, or I may have lost access to it. New sessions are going to ' +
        'your DMs until that is fixed. Run `/thread-here` in a working channel to move them, or ' +
        '`/thread-here action:clear` for DMs.'
      );
    }
    if (status.health.kind === 'missing-permissions') {
      return (
        `Your session threads are pinned to ${where}, but I am missing: ${status.health.missing.join(', ')}. ` +
        'New sessions are going to your DMs until a server admin grants those. Run ' +
        '`/thread-here` in another channel to move them, or `/thread-here action:clear` for DMs.'
      );
    }
    if (status.health.kind === 'user-cannot-access') {
      return (
        `Your session threads are pinned to ${where}, but you cannot see that channel any more — ` +
        'you may have left the server, or lost access to the channel. A session thread is private ' +
        'and I have to add you to it, so new sessions are going to your DMs until that changes. ' +
        'Run `/thread-here` in a channel you can see to move them, or `/thread-here action:clear` ' +
        'for DMs.'
      );
    }
    return (
      `Your session threads go to ${where}, pinned by you. Run \`/thread-here\` in another ` +
      'channel to move them, or `/thread-here action:clear` for DMs.'
    );
  }
  if (status.health.kind === 'unreachable') {
    return (
      `This deployment sends your session threads to ${where}, but I cannot use that channel ` +
      'right now, so new sessions are going to your DMs. Run `/thread-here` in a channel to pin ' +
      'your own.'
    );
  }
  if (status.health.kind === 'missing-permissions') {
    return (
      `This deployment sends your session threads to ${where}, but I am missing: ` +
      `${status.health.missing.join(', ')}, so new sessions are going to your DMs. Run ` +
      '`/thread-here` in a channel to pin your own.'
    );
  }
  if (status.health.kind === 'user-cannot-access') {
    return (
      `This deployment sends your session threads to ${where}, but you cannot see that channel, ` +
      'and a session thread is private so I have to add you to it — new sessions are going to ' +
      'your DMs. Run `/thread-here` in a channel you can see to pin your own.'
    );
  }
  return (
    `Your session threads go to ${where}, this deployment's default. Run \`/thread-here\` in a ` +
    'channel to pin your own, or `/thread-here action:clear` for DMs.'
  );
}

/** Render a settled `/thread-here` invocation.
 *
 *  Every success says what happens to sessions ALREADY running, because the honest answer is
 *  "nothing" — a session's thread is pinned for its life the moment it is created, and a user who
 *  expects their in-flight session to move would otherwise read the silence as a bug. */
export function buildThreadHereResult(outcome: ThreadHereOutcome): CommandResult {
  switch (outcome.kind) {
    case 'rejected':
      return { kind: 'error', message: threadHereRejectionMessage(outcome.rejection) };
    case 'status':
      return { kind: 'text', text: threadHereStatusMessage(outcome.status) };
    case 'pinned':
      return {
        kind: 'text',
        text:
          `Pinned. New session threads will be created in <#${outcome.channelId}>` +
          `${outcome.previousChannelId !== undefined ? ` instead of <#${outcome.previousChannelId}>` : ''}. ` +
          'Sessions already running keep the thread or DM they started in. Run ' +
          '`/thread-here action:clear` to go back to DMs.',
      };
    case 'already-pinned':
      return {
        kind: 'text',
        text:
          `Still pinned to <#${outcome.channelId}> — I rechecked, and I can still create threads ` +
          'here. Nothing changed.',
      };
    case 'cleared':
      return {
        kind: 'text',
        text:
          'Cleared. New session threads will be delivered to your DMs' +
          `${outcome.overriddenChannelId !== undefined ? ` instead of <#${outcome.overriddenChannelId}>` : ''}. ` +
          'Sessions already running keep the thread they started in. Run `/thread-here` in a ' +
          'channel to pin one again.',
      };
    case 'already-dm':
      return {
        kind: 'text',
        text: 'Your session threads already go to your DMs. Nothing changed.',
      };
  }
}
