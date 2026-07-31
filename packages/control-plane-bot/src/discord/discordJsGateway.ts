// Real discord.js wiring: login, slash-command registration, interaction routing, and
// pushing daemon-originated envelopes to the owning user's DMs.
//
// LIVE BOUNDARY: `start()` opens a real Discord gateway connection and `deliver()` makes real
// Discord API calls — neither can be exercised headlessly, so neither is unit-tested. Every
// piece of actual LOGIC (which handler a command maps to, what an embed looks like) lives in
// commands.ts / embeds.ts and IS unit-tested; this file is deliberately thin glue so the
// untestable surface is as small as it can be.

import {
  ActionRowBuilder,
  ApplicationIntegrationType,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  InteractionContextType,
  Client,
  Events,
  GatewayIntentBits,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type Channel,
  type ChatInputCommandInteraction,
  type Interaction,
  type EmbedBuilder,
  type Message,
  type MessageActionRowComponentBuilder,
  type ModalSubmitInteraction,
  type PermissionsBitField,
  type SendableChannels,
  type StringSelectMenuInteraction,
  SlashCommandBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isType, type Envelope, type PayloadOf } from '@claude-control/shared-protocol';
import {
  DEFAULT_STATS_DAYS,
  MAX_STATS_DAYS,
  MIN_STATS_DAYS,
} from '@claude-control/shared-protocol';
import type { DiscordGateway } from './gateway.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import { DaemonStateCache } from './stateCache.js';
import { chunkMessage } from './messageChunks.js';
import { emojiTrack, layeredBar, UNICODE_TRACK_STYLE } from './richFormat.js';
import {
  ensureProgressEmojis,
  emojiResolverFrom,
  renderEmojiBar,
  renderEmojiTrack,
} from './emojiBars.js';
import { renderPush, type RenderedPush } from './pushRender.js';
import {
  buildAnsweredQuestionEmbed,
  buildLapsedPermissionEmbed,
  buildLapsedQuestionEmbed,
  buildStatsEmbed,
} from './embeds.js';
import { PermissionCardRegistry, type CardRef } from './permissionCards.js';
import { PendingStatsScans } from './pendingStatsScans.js';
import {
  QuestionCardRegistry,
  QuestionAnswerCollector,
  decodeQuestionModal,
  decodeQuestionSelect,
  encodeQuestionModal,
  questionIdempotencyKey,
  questionSubmitDedupeKey,
  OTHER_VALUE,
  QUESTION_MODAL_INPUT_ID,
  type SelectSpec,
} from './questionCards.js';
import {
  buttonIdempotencyKey,
  resolveTap,
  type ButtonSpec,
  type ButtonStyle as ButtonSpecStyle,
  type TapOutcome,
} from './buttons.js';
import { SeenKeys } from './idempotencyGuard.js';
import {
  SessionPlanner,
  sessionRouteKey,
  type GatewayOp,
  type PlanMode,
  type PlanResult,
  type SessionRoute,
} from './sessionPlanner.js';
import { PersistentThreadRegistry, type DeliveryTarget } from './threadRegistry.js';
import * as commands from './commands.js';
import type {
  CommandDeps,
  CommandResult,
  ThreadHereAction,
  ThreadHereChannelFacts,
  ThreadHereChannelHealth,
  ThreadHereStatus,
} from './commands.js';
import {
  chooseSessionChannel,
  createSessionChannelResolver,
  type SessionChannelResolver,
} from './sessionChannels.js';
import { PersistentSessionChannelPinStore } from './sessionChannelPins.js';

/** Threads auto-archive after Discord's 3-day tier (minutes). Deliberately the LONGEST practical
 *  window: a finished session's thread is a conversation the user can re-enter by typing (which
 *  resumes it), so it should linger, not vanish behind the next morning's archive sweep. Archive
 *  is Discord-side housekeeping only — the bot never archives, locks, or deletes a thread. */
const THREAD_AUTO_ARCHIVE_MINUTES = 4320;

/** Bot→daemon frames sent on behalf of a message TYPED in a session thread, keyed by the sent
 *  envelope's id — the value a daemon `error` reply's `relatesTo` carries. Lets a refusal land in
 *  the thread the user is looking at (not their DMs), and lets a 'session_ended' refusal escalate
 *  to a resume-spawn without the user retyping. Bounded FIFO: a reply correlates within seconds;
 *  anything older has lost its audience. */
interface ThreadSendContext {
  discordUserId: string;
  threadId: string;
  /** The triggering user message — failure reactions ride the exact message that failed. */
  messageId: string;
  sessionId: string;
  text: string;
  kind: 'inject' | 'spawn';
  /** For `spawn` sends: the spawn's requestId, so a failure reply can release exactly the
   *  single-flight resume guard it belongs to. */
  spawnRequestId?: string;
}

/** Bound for both thread-send correlation maps (sends awaiting a possible error reply, and spawn
 *  requestIds awaiting their first correlated session.status). */
const PENDING_THREAD_SENDS_MAX = 256;

/** How long a thread's resume-spawn holds its single-flight guard with no answer before a new
 *  message may try again. Generous against a slow SDK cold-start; short enough that a daemon
 *  that silently died mid-resume does not wedge the thread until a bot restart. */
const RESUME_IN_FLIGHT_TTL_MS = 2 * 60_000;

/** Messages parked behind one in-flight resume. Mirrors the daemon's own steering-queue cap:
 *  past this, the queue is a symptom (the resume is not coming up), not a buffer. */
const RESUME_QUEUE_CAP = 8;

/** The gateway intents a deployment needs. GuildMessages + MessageContent exist for exactly
 *  one purpose — reading replies typed in per-session threads — and MessageContent is a
 *  PRIVILEGED intent: requesting it without the developer-portal toggle rejects the login
 *  outright, killing the whole bot at boot. A deployment with no session channel configured
 *  has no threads to read, so it keeps the exact non-privileged intent set it had before
 *  threads existed and keeps booting; only opting into threads takes on the portal toggle.
 *  A `/thread-here` pin can still create threads on a deployment that configured none — those
 *  threads stay deliver-only (replies unread) until the operator opts in, because intents are
 *  fixed at construction and requesting the privileged one on the strength of a USER action
 *  would gamble the whole bot's next boot on a portal toggle only the operator can set. */
export function gatewayIntents(threadingEnabled: boolean): GatewayIntentBits[] {
  return threadingEnabled
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
    : [GatewayIntentBits.Guilds];
}

/** The content/embeds/components subset common to `channel.send` and `message.edit`, so one built
 *  payload drives both the initial card send and every subsequent in-place edit. */
interface SessionMessagePayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

/** How long a `/stats days:N` reply waits for the host's scan before saying so.
 *
 *  Sized against the WORST legitimate case, not the typical one: a 90-day window on a machine with
 *  real history re-reads a lot of transcript. Well inside Discord's 15-minute edit window for a
 *  deferred reply, so the bound that fires first is always this one — which means the user gets a
 *  written explanation rather than an interaction that silently expires. */
const STATS_SCAN_TIMEOUT_MS = 120_000;

// Where the committed progress-bar sprites live, relative to this compiled file
// (dist/discord/discordJsGateway.js → ../../assets/progress-bar → the package's assets dir).
const PROGRESS_ASSETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../assets/progress-bar',
);

// Sent once, right after a daemon successfully claims a pairing code. Lists every command that
// actually reaches the daemon, grouped so a brand-new user can find the one they want rather
// than reading a flat wall of sixteen. {@link PRIMER_OMITTED_COMMANDS} records the ones
// deliberately absent and why. A hand-written list beside a separately-declared command surface
// drifts the moment someone adds a command and forgets this file, so a unit test holds the two to
// each other rather than trusting the next author to remember.
export const PAIRING_PRIMER_MESSAGE = [
  "Paired. Here's what works right now:",
  '',
  '**Usage**',
  '`/usage` — usage across accounts',
  '`/timeline` — 5h-session budget and reset timeline',
  '`/stats` — token counts per account, model and day (add `days:30` for a longer window)',
  '`/accounts` — the accounts this daemon can switch between',
  '',
  '**Sessions**',
  '`/run <prompt>` — start a Claude Code session',
  '`/say <session> <text>` — send a message into a running session',
  '`/stop <session>` — stop a running session',
  '`/sessions` — every session this daemon has reported',
  '`/prune` — clear out dormant session records (asks first)',
  '`/thread-here` — send your session threads to this channel, or back to your DMs',
  '',
  '**Daemon**',
  '`/switch <account>` — switch the active account',
  '`/status` — daemon connection status',
  '`/settings` — effective settings and where each came from',
  '`/approve <request>` · `/deny <request>` — answer a pending permission request',
  '',
  'Permission prompts and questions arrive here as cards — tap the buttons, no command needed.',
].join('\n');

/** Registered commands deliberately left out of {@link PAIRING_PRIMER_MESSAGE}, each for a reason
 *  that outlives the current command list. `pair` is the command the reader just finished using.
 *  `reauth` cannot do what its name implies — the bot holds no credentials by design, so it only
 *  replies with the host-side CLI command to run (see commands.ts) — and the primer's entire job
 *  is telling a new user what to try first. Read by the test that keeps the primer and the
 *  registered list in step, so dropping a name from here is what makes that command required. */
export const PRIMER_OMITTED_COMMANDS = new Set(['pair', 'reauth']);

export interface DiscordJsGatewayOptions {
  relay: RelaySender;
  pairing: PairingService;
  logger?: Logger;
  /** Defaults to `process.env.DISCORD_BOT_TOKEN`; pass explicitly to override (tests that
   *  construct this class without calling `start()` never need a token at all). */
  token?: string;
  /** Injectable time source for the two-tap confirm TTL, the idempotency guard's eviction, and the
   *  session card's coalescing window. Defaults to `Date.now`; overridden in live debugging only. */
  clock?: () => number;
  /** Directory for the persisted session→thread registry. Defaults under the OS temp dir so the
   *  bot works out of the box; a real deployment points this at its state dir. */
  stateDir?: string;
  /** How to obtain the channel a user's session threads are created in. Omitted → pure-DM
   *  deployment (thread creation always falls back to DM, which is remembered per session). */
  sessionChannelResolver?: SessionChannelResolver;
  /** Channel id whose text channel hosts per-session private threads, for deployments that want
   *  threads without supplying a full resolver. Applies to every user WITHOUT a
   *  {@link DiscordJsGatewayOptions.sessionChannelsByUser} entry. Ignored when
   *  `sessionChannelResolver` is given; omitted (with no resolver, no map) → pure-DM deployment. */
  sessionChannelId?: string;
  /** Per-user channel overrides (discordUserId → channelId), taking precedence over
   *  `sessionChannelId`. This is what makes a MIXED deployment possible: name the users who should
   *  get threads, leave `sessionChannelId` unset, and everyone else keeps getting DMs. Ignored when
   *  `sessionChannelResolver` is given. */
  sessionChannelsByUser?: ReadonlyMap<string, string>;
}

/** How long after a session goes terminal its in-memory streaming state is retained before being
 *  dropped, so a long-lived bot does not accumulate every finished session forever. Comfortably
 *  past any late trailing frame; the persisted thread mapping outlives it regardless. */
const SESSION_FORGET_MS = 5 * 60_000;

/** discord.js styles keyed by our plain ButtonSpec style — the gateway is the one place that
 *  translates the render structs into real components. */
const BUTTON_STYLE: Record<ButtonSpecStyle, ButtonStyle> = {
  primary: ButtonStyle.Primary,
  secondary: ButtonStyle.Secondary,
  success: ButtonStyle.Success,
  danger: ButtonStyle.Danger,
};

/** Exactly what {@link DiscordJsGateway.ensureTarget}'s create-then-add needs from a channel, in
 *  the order a reader should fix them.
 *
 *  `ManageThreads` is the non-obvious one and the reason this preflight exists at all: session
 *  threads are created with `invitable: false`, and admitting a non-member to a non-invitable
 *  private thread requires it. Without it the create SUCCEEDS and the add throws, so delivery lands
 *  on DMs with nothing but a log line to show for it — a channel that looks correctly configured
 *  from every angle except the one that matters. `SendMessagesInThreads` fails later still: the
 *  thread exists, the user is in it, and every frame the bot tries to post into it is refused. */
const REQUIRED_THREAD_PERMISSIONS: readonly (readonly [bigint, string])[] = [
  [PermissionFlagsBits.ViewChannel, 'View Channel'],
  [PermissionFlagsBits.CreatePrivateThreads, 'Create Private Threads'],
  [PermissionFlagsBits.SendMessagesInThreads, 'Send Messages in Threads'],
  [PermissionFlagsBits.ManageThreads, 'Manage Threads'],
];

/** Name of the throwaway thread `/thread-here` creates to prove a channel really works. Self-
 *  describing on purpose: if the cleanup delete ever fails, what is left behind says what it is. */
const THREAD_HERE_PROBE_NAME = 'cctl channel check';

/** How much of a Discord rejection to quote back to the user. Long enough to be diagnosable, short
 *  enough that a stack-trace-shaped message cannot swallow the actionable half of the reply. */
const PROBE_DETAIL_MAX_CHARS = 150;

/** Which of the thread permissions the bot lacks, as the names shown in Discord's own permission
 *  editor — the reply is an instruction to go and tick boxes, so it has to use the box labels.
 *  A null permission set (no computed permissions for this context at all) reports every one as
 *  missing rather than none: unknown is not the same as granted. Exported for its own unit test —
 *  it is a bit filter, and the bit that matters most is the one nobody expects to need. */
export function missingThreadPermissionLabels(
  permissions: Readonly<PermissionsBitField> | null,
): string[] {
  if (!permissions) return REQUIRED_THREAD_PERMISSIONS.map(([, label]) => label);
  return REQUIRED_THREAD_PERMISSIONS.filter(([flag]) => !permissions.has(flag)).map(
    ([, label]) => label,
  );
}

/** Flatten a thrown Discord error into one quotable line. Newlines collapse because the reply is a
 *  sentence with the detail in parentheses, and a multi-line message would break it apart. */
function describeProbeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const flattened = message.replace(/\s+/g, ' ').trim();
  return flattened.length > PROBE_DETAIL_MAX_CHARS
    ? `${flattened.slice(0, PROBE_DETAIL_MAX_CHARS - 1)}…`
    : flattened;
}

/** Bot-side dedupe bounds: keep the last 2000 executed button keys for 15 minutes — comfortably
 *  longer than the daemon's permission TTL, so a double-tap is caught for as long as the original
 *  request could still be live, without unbounded growth. */
const SEEN_KEYS_MAX = 2000;
const SEEN_KEYS_TTL_MS = 15 * 60_000;

/** discord.js-backed DiscordGateway: DMs the bound user for daemon-originated pushes, and
 *  registers/handles the slash-command + button surface, delegating all mapping logic to
 *  commands.ts so this class stays free of protocol knowledge beyond wiring. */
export class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private readonly cache = new DaemonStateCache();
  private readonly deps: CommandDeps;
  private readonly logger: Logger;
  private readonly token: string | undefined;
  private readonly clock: () => number;
  /** Executed-button dedupe: a double-tap hits the same key and is dropped. */
  private readonly seenKeys: SeenKeys;
  /** Pure planner that turns session.output/session.status envelopes into thread ops. */
  private readonly planner = new SessionPlanner();
  /** Persisted sessionId→thread map; loaded on start(), survives restart. */
  private readonly threadReg: PersistentThreadRegistry;
  /** Persisted per-user `/thread-here` choices; loaded on start(), survives restart. `protected`
   *  (not `private`), same seam rationale as {@link sinkFor}: the command tests assert what a
   *  `/thread-here` invocation actually WROTE, which is the only way to prove a rejected pin left
   *  routing untouched. */
  protected readonly sessionChannelPins: PersistentSessionChannelPinStore;
  /** The deployment's own session-channel configuration, kept so `/thread-here action:show` can
   *  name the channel a user would fall back to and say it came from the deployment rather than
   *  from them. Routing itself reads these through the resolver; these fields exist for the
   *  explanation, not the decision. A deployment that injects its own `sessionChannelResolver`
   *  bypasses both, and its routing is correspondingly not introspectable here. */
  private readonly deploymentChannelsByUser: ReadonlyMap<string, string> | undefined;
  private readonly deploymentChannelId: string | undefined;
  /** How this deployment answers "which channel hosts this user's session threads?", or
   *  `undefined` for a pure-DM deployment. `protected` (not `private`) for the same reason as
   *  {@link sinkFor}: a test subclass can read back what the constructor wired, so the mixed
   *  per-user/fallback/DM config is verified through the real construction path rather than by
   *  re-deriving it. */
  protected readonly sessionChannelResolver: SessionChannelResolver | undefined;
  /** Live-card message per session route, so `editMessage ref:'card'` targets the right message.
   *  In-memory only: after a restart the card id is gone and the first edit posts a fresh card
   *  (a benign visual re-anchor, not a lost update). */
  private readonly cardMessages = new Map<string, Message>();
  /** requestId -> {channelId, messageId} for a just-sent permission card, so a LATER
   *  `permission.lapsed` push can find and edit it. Unlike `cardMessages` this is not keyed by
   *  session route (a permission card belongs to no session route) and holds a plain ref, not a
   *  live discord.js Message — the entry can easily outlive any local object cache lifetime
   *  reasoning, and re-resolving through the client on the (rare) lapse edit is cheap. `protected`
   *  (not `private`), same seam rationale as {@link sinkFor}: it lets a test subclass seed a
   *  known ref without opening a real Discord connection. */
  protected readonly permissionCards = new PermissionCardRegistry();
  /** requestId -> card ref for a sent AskUserQuestion card, so a later question.lapsed can edit it
   *  and a completed answer can find the card to mark answered. Same bounded, one-shot-on-resolve
   *  shape and `protected` test-seam rationale as {@link permissionCards}. */
  protected readonly questionCards = new QuestionCardRegistry();
  /** Partial answers accumulated across a question card's several selects/modals, until every
   *  question is answered. In-memory and bounded; an abandoned card's state ages out by FIFO or is
   *  dropped when the card lapses. */
  private readonly questionAnswers = new QuestionAnswerCollector();
  /** One pending coalesced-flush timer per session route; rescheduled, never stacked. */
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Thread-originated sends awaiting a possible daemon error reply, keyed by sent envelope id
   *  (see {@link ThreadSendContext}). Insertion-ordered; pruned FIFO at the bound. */
  private readonly pendingThreadSends = new Map<string, ThreadSendContext>();
  /** Thread-originated resume spawns awaiting their first correlated `session.status` (which
   *  carries `spawnRequestId`), keyed by that requestId. The stored thread is what the NEW
   *  sessionId gets bound to, keeping the resumed conversation in the thread it started in. */
  private readonly pendingSpawnRebinds = new Map<
    string,
    { discordUserId: string; threadId: string }
  >();
  /** Threads with a resume-spawn in flight. A second message racing the resume round-trip
   *  must not fork a SECOND live session from the same conversation — it queues here and
   *  delivers into the resumed session the moment its first status binds the thread (see
   *  {@link drainResumeQueue}). Entries clear on rebind, on spawn failure, or via TTL. */
  private readonly resumesInFlight = new Map<
    string,
    {
      requestId: string;
      discordUserId: string;
      startedAtMs: number;
      queued: Array<{ text: string; messageId: string }>;
    }
  >();
  /** Per-session-route serialization chain for EVERY card mutation: managed-session frames
   *  (status/output), the coalesced-flush timer, and the stop nudge. relay.ts fires `deliver()`
   *  from an un-awaited `socket.on('message')` handler, and the flush timer / stop nudge fire on
   *  their own schedules, so any two of them for ONE session would otherwise interleave across
   *  the awaits inside executeOps: the second's editMessage can run before the first's
   *  `await sink.send()` has stored the card id in {@link cardMessages}, posting a DUPLICATE
   *  card (and later edits then target whichever send resolved last). Chaining each route's
   *  work onto the previous unit forces in-order, run-to-completion mutation of the card
   *  surface — see {@link chainOnRoute}. The entry is deleted once it drains (bounded by LIVE
   *  routes) and the chain NEVER rejects, so one bad unit can't stall the route. */
  private readonly deliverChains = new Map<string, Promise<void>>();
  /** requestId -> the `/stats days:N` interaction waiting on a host transcript scan. The only
   *  command whose answer does not exist at reply time (see {@link runStatsScan}). */
  private readonly pendingStats = new PendingStatsScans();

  constructor(options: DiscordJsGatewayOptions) {
    this.logger = options.logger ?? noopLogger;
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
    this.clock = options.clock ?? (() => Date.now());
    this.seenKeys = new SeenKeys({
      max: SEEN_KEYS_MAX,
      ttlMs: SEEN_KEYS_TTL_MS,
      clock: this.clock,
    });
    const stateDir = options.stateDir ?? join(tmpdir(), 'claude-control-bot');
    this.threadReg = new PersistentThreadRegistry(stateDir);
    this.sessionChannelPins = new PersistentSessionChannelPinStore(stateDir);
    this.deploymentChannelsByUser = options.sessionChannelsByUser;
    this.deploymentChannelId = options.sessionChannelId;
    // An explicit resolver wins; otherwise the users' own pins, the per-user map and/or the shared
    // channel id build one (see createSessionChannelResolver for the precedence and the
    // undefined-means-DM contract). Only the discord.js fetch-and-narrow lives here — the channel a
    // fetch is issued FOR is a pure decision, and keeping it that way is what makes the mixed
    // deployment testable headlessly.
    this.sessionChannelResolver =
      options.sessionChannelResolver ??
      createSessionChannelResolver({
        fetchParent: async (channelId) => {
          const channel = await this.client.channels.fetch(channelId);
          return channel?.type === ChannelType.GuildText ? channel : undefined;
        },
        // Bound to the store's live read rather than a snapshot of it: this resolver is built once
        // and never rebuilt, so a pin set by /thread-here has to be observable through the accessor
        // or it would not apply until the next restart.
        resolvePin: (discordUserId) => this.sessionChannelPins.get(discordUserId),
        ...(options.sessionChannelsByUser ? { byUser: options.sessionChannelsByUser } : {}),
        ...(options.sessionChannelId ? { fallbackChannelId: options.sessionChannelId } : {}),
      });
    this.deps = { relay: options.relay, pairing: options.pairing, cache: this.cache };
    // `allowedMentions: { parse: [] }` is a process-wide default that neutralizes every
    // @everyone/@here/role/user mention parsed from message CONTENT. Card and session text is
    // built verbatim from wire payloads (e.g. a session's own output), which can carry mention
    // syntax from untrusted material the session processed — so no wire-derived string may ever
    // trigger a ping. A future path that legitimately needs to mention someone sets the `users`/
    // `roles` array explicitly on that one message rather than relying on content parsing.
    this.client = new Client({
      // Privileged intents only when the DEPLOYMENT configures channel threads (resolver or env
      // routes) — see gatewayIntents. The resolver alone can't be the signal anymore: it always
      // exists now (it also serves /thread-here pins), and a pin is a user action that must never
      // decide whether the next boot requests a privileged intent.
      // Truthiness on purpose, matching how bin.ts spreads the option in: an empty-string
      // channel id configures no threads and must not request a privileged intent.
      intents: gatewayIntents(
        options.sessionChannelResolver !== undefined ||
          Boolean(options.sessionChannelId) ||
          (options.sessionChannelsByUser !== undefined && options.sessionChannelsByUser.size > 0),
      ),
      allowedMentions: { parse: [] },
    });

    // `clientReady`, not `ready`: the latter is deprecated and stops firing in discord.js v15,
    // which would leave slash commands unregistered and the emoji bars never upgraded — a
    // silent degradation, since nothing throws when an event simply never arrives.
    this.client.once(Events.ClientReady, () => {
      this.registerCommands().catch((err: unknown) => {
        this.logger.error({ err }, 'discord: failed to register slash commands');
      });
      // Upload the progress-bar sprites and, if that yields any emojis, upgrade the injected
      // bar renderer from unicode to slim emoji bars. Best-effort: never blocks the bot.
      this.setupProgressEmojis().catch((err: unknown) => {
        this.logger.error({ err }, 'discord: failed to set up progress emojis');
      });
    });
    this.client.on('interactionCreate', (interaction) => {
      this.onInteraction(interaction).catch((err: unknown) => {
        this.logger.error({ err }, 'discord: unhandled interaction error');
      });
    });
    // Free-text typed in a per-session thread is session input — the reverse direction of the
    // thread-per-session surface. Routing/auth decisions live in onThreadMessage.
    this.client.on(Events.MessageCreate, (message) => {
      this.onThreadMessage(message).catch((err: unknown) => {
        this.logger.error({ err }, 'discord: unhandled thread message error');
      });
    });
  }

  /** Log in and start handling interactions. Never call from a test — it opens a real
   *  connection to Discord's gateway. Loads both persisted maps first: the session→thread map so
   *  sessions streamed before a restart keep delivering to their existing threads, and the
   *  `/thread-here` pins so users keep the channel they chose. Neither load may be skipped for the
   *  same reason — an unloaded store reads as empty, which is not a crash and not a log line, just
   *  every user quietly reverted to the deployment's defaults. */
  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('DISCORD_BOT_TOKEN is not set and no token was provided');
    }
    await this.threadReg.load();
    await this.sessionChannelPins.load();
    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** DiscordGateway.deliver — push one daemon-originated envelope to the owning user.
   *
   *  Three paths. Managed-session frames (session.status/session.output) go to the thread-per-
   *  session surface: the pure `SessionPlanner` turns them into thread ops (create/send/edit/upload)
   *  which this class executes. `permission.lapsed` EDITS an already-sent permission card rather
   *  than sending anything new (see {@link applyPermissionLapse}). Everything else keeps the card
   *  behaviour — the pure `renderPush` decides the DM card and this class only inflates
   *  ButtonSpecs and sends it, recording where a permission card landed so a later lapse can find
   *  it. Card content is chunked because Discord rejects an over-long message outright rather
   *  than truncating it: without this, the longest and most valuable summaries are exactly the
   *  ones that never arrive; embeds/buttons/files ride the first chunk so the notification still
   *  leads with its rich card. The state cache is fed on EVERY envelope regardless, so
   *  `/usage`/`/sessions` keep answering from it. */
  async deliver(discordUserId: string, envelope: Envelope): Promise<void> {
    this.cache.record(discordUserId, envelope);
    // Managed-session frames mutate shared per-route state (the planner view AND cardMessages), so
    // they are serialized per route to defeat the interleaving that duplicates cards. Everything
    // else is stateless w.r.t. that surface and keeps the direct path.
    if (isType(envelope, 'session.status') || isType(envelope, 'session.output')) {
      const route: SessionRoute = { discordUserId, sessionId: envelope.payload.sessionId };
      // No await between here and the enqueue: deliver() is called un-awaited, and yielding
      // first would let another chain writer (a flush timer, a stop nudge) append AHEAD of
      // this frame — the exact reordering chainOnRoute exists to prevent.
      return this.enqueueSessionDelivery(route, envelope);
    }
    if (isType(envelope, 'permission.lapsed')) {
      return this.applyPermissionLapse(envelope.payload);
    }
    if (isType(envelope, 'question.lapsed')) {
      return this.applyQuestionLapse(envelope.payload);
    }
    if (isType(envelope, 'stats.result')) {
      // Answers a specific waiting interaction rather than the user in general, so it is handed
      // to that waiter and never DM'd. An unmatched result (the wait timed out, or this bot
      // restarted since the request) is dropped: its only intended surface no longer exists, and
      // a stray "here are your token stats" DM for a question the user asked minutes ago and
      // already got a timeout for is worse than nothing.
      if (!this.pendingStats.settle(envelope.payload.requestId, envelope.payload)) {
        this.logger.debug(
          { requestId: envelope.payload.requestId },
          'discord: stats.result with no waiting interaction (timed out, or a restart since)',
        );
      }
      return;
    }
    // An error reply to a frame a thread message originated goes back to THAT thread (and a
    // "session ended" refusal escalates to a resume) instead of the generic DM card path.
    if (isType(envelope, 'error') && (await this.routeThreadSendError(envelope.payload))) {
      return;
    }
    const push = renderPush(envelope);
    if (!push) return; // cache-only: not worth a DM
    try {
      const user = await this.client.users.fetch(discordUserId);
      const parts = push.content === undefined ? [undefined] : chunkMessage(push.content);
      for (const [index, content] of parts.entries()) {
        // Sent in sequence, not in parallel: Discord orders by arrival, and a summary that
        // lands out of order is worse than one that takes an extra moment.
        const message = await user.send({
          ...(content === undefined ? {} : { content }),
          ...(index === 0 ? this.toSendExtras(push) : {}),
        });
        // Remember where THIS permission card landed so a later permission.lapsed push (the hold
        // ending without a phone decision) can find and edit it — the only place this envelope
        // type's requestId->message mapping is populated. The card rides the first chunk, so
        // that is the message a lapse must edit.
        if (index === 0 && isType(envelope, 'permission.request')) {
          this.permissionCards.record(envelope.payload.requestId, {
            channelId: message.channelId,
            messageId: message.id,
          });
        }
        // Same mapping for a question card, plus the collector registration that lets its selects
        // resolve option indices back to labels and carry each answer's question text.
        if (index === 0 && isType(envelope, 'question.request')) {
          this.questionCards.record(envelope.payload.requestId, {
            channelId: message.channelId,
            messageId: message.id,
          });
          this.questionAnswers.register(envelope.payload.requestId, envelope.payload.questions);
        }
      }
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: failed to DM user');
    }
  }

  /** DiscordGateway.sendPrimer — DM the working-commands primer to a freshly paired user. */
  async sendPrimer(discordUserId: string): Promise<void> {
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(PAIRING_PRIMER_MESSAGE);
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: failed to send pairing primer DM');
    }
  }

  /** permission.lapsed: the hold ended without a phone decision (local terminal answer, TTL
   *  expiry, or a daemon shutdown) — the card must stop claiming its Approve/Deny buttons still
   *  work. Edits the ORIGINAL card in place (found via `permissionCards`): keeps the embed's
   *  content but retitles/recolors it for the reason, and strips every button. If this bot never
   *  saw the original send (restarted since, or the ref aged out of the bounded map) there is
   *  nothing to edit — dropped silently (debug log only): never crash, and never send a NEW
   *  message in place of a card the reader can no longer act on anyway. */
  private async applyPermissionLapse(payload: PayloadOf<'permission.lapsed'>): Promise<void> {
    const ref = this.permissionCards.take(payload.requestId);
    if (!ref) {
      this.logger.debug(
        { requestId: payload.requestId },
        'discord: permission.lapsed for a card this bot never tracked (restart, or already evicted)',
      );
      return;
    }
    try {
      const message = await this.resolveCardMessage(ref);
      if (!message) return;
      const original = message.embeds[0]?.toJSON();
      const embed = buildLapsedPermissionEmbed(payload.reason, original);
      await message.edit({ embeds: [embed], components: [] });
    } catch (err) {
      this.logger.warn(
        { err, requestId: payload.requestId },
        'discord: failed to edit a lapsed permission card',
      );
    }
  }

  /** question.lapsed: the hold ended without a phone answer, so the card must stop claiming its
   *  pickers still work. Mirrors {@link applyPermissionLapse} — edit the ORIGINAL card (found via
   *  `questionCards`) to the muted, reason-titled lapsed embed and strip every select; drop the
   *  accumulated answer state too. An untracked requestId (restart, eviction, or a card already
   *  answered) is dropped silently: never crash, never post a new message for a dead card. */
  private async applyQuestionLapse(payload: PayloadOf<'question.lapsed'>): Promise<void> {
    const ref = this.questionCards.take(payload.requestId);
    this.questionAnswers.forget(payload.requestId);
    if (!ref) {
      this.logger.debug(
        { requestId: payload.requestId },
        'discord: question.lapsed for a card this bot never tracked (restart, or already evicted)',
      );
      return;
    }
    try {
      const message = await this.resolveCardMessage(ref);
      if (!message) return;
      const original = message.embeds[0]?.toJSON();
      const embed = buildLapsedQuestionEmbed(payload.reason, original);
      await message.edit({ embeds: [embed], components: [] });
    } catch (err) {
      this.logger.warn(
        { err, requestId: payload.requestId },
        'discord: failed to edit a lapsed question card',
      );
    }
  }

  /** Resolve a stored {channelId, messageId} ref to the live discord.js Message to edit — the
   *  one seam {@link applyPermissionLapse} needs from the real connection. `protected` (not
   *  `private`), same rationale as {@link sinkFor}: a test subclass can return a fake message
   *  without opening a real gateway connection. Returns `undefined` (never throws) for a channel
   *  that is gone or not text-based — the caller's contract from there is the same silent drop as
   *  an untracked requestId. */
  protected async resolveCardMessage(ref: CardRef): Promise<Message | undefined> {
    const channel = await this.client.channels.fetch(ref.channelId);
    if (!channel?.isTextBased()) return undefined;
    return channel.messages.fetch(ref.messageId);
  }

  /** Append one unit of card work to its route's serialization chain, returning a promise that
   *  resolves when THIS unit has fully run. EVERY mutation of a route's card surface (envelope
   *  processing, the coalesced-flush timer, the stop nudge) must come through here: any of them
   *  can hit the empty-`cardMessages` re-anchor branch in {@link executeOp}, and two doing so
   *  concurrently each post a fresh card — the later `cardMessages.set` wins and the earlier
   *  card is orphaned, taking no further edits, forever stuck on its last state. Both branches
   *  of the `.then` run the work so a (never-expected) prior rejection can't skip a unit; the
   *  entry is dropped once it drains, but only if it is still the tail (a later append may have
   *  replaced it), keeping the map bounded by live routes. `work` must never reject — every
   *  caller wraps its own failure handling — so the chain itself can never stall a route. */
  private chainOnRoute(route: SessionRoute, work: () => Promise<void>): Promise<void> {
    const key = sessionRouteKey(route);
    const prior = this.deliverChains.get(key) ?? Promise.resolve();
    const next = prior.then(work, work);
    this.deliverChains.set(key, next);
    void next.finally(() => {
      if (this.deliverChains.get(key) === next) this.deliverChains.delete(key);
    });
    return next;
  }

  /** Append one managed-session envelope to its route's serialization chain. */
  private enqueueSessionDelivery(route: SessionRoute, envelope: Envelope): Promise<void> {
    return this.chainOnRoute(route, () => this.processSessionEnvelope(route, envelope));
  }

  /** Process one managed-session envelope: run its plan (create/edit the card, upload, etc.) and,
   *  for a terminal status, schedule the forget grace. Never rejects — a throw here (executeOps
   *  already swallows per-op failures, so this guards only against a planner bug) is logged so it
   *  can't reject the route chain and stall every later frame for the session. */
  private async processSessionEnvelope(route: SessionRoute, envelope: Envelope): Promise<void> {
    try {
      // FIRST, still inside this route's chain unit: a spawn born from a thread message must
      // bind its new sessionId to that thread before the target is resolved, or ensureTarget
      // would mint a second thread for it.
      if (isType(envelope, 'session.status')) {
        await this.maybeRebindSpawnedSession(route.discordUserId, envelope.payload);
      }
      // Presentation follows where the frames actually land: thread → append-stream, DM → card.
      // Resolved BEFORE planning (the registry pins it after the first call) so the planner's
      // first-frame mode decision is made with the target known, never guessed.
      const target = await this.ensureTarget(route);
      const mode: PlanMode = target.kind === 'thread' ? 'stream' : 'card';
      if (isType(envelope, 'session.status')) {
        await this.runPlan(
          route,
          this.planner.onStatus(route, envelope.payload, this.clock(), mode),
        );
        this.scheduleForget(route, envelope.payload.state);
        return;
      }
      if (isType(envelope, 'session.output')) {
        await this.runPlan(
          route,
          this.planner.onOutput(route, envelope.payload, this.clock(), mode),
        );
      }
    } catch (err) {
      this.logger.warn({ err, route }, 'discord: session envelope processing failed');
    }
  }

  /** Execute a plan's ops in order, then (re)schedule its coalesced-flush timer. The single entry
   *  point every planner interaction funnels through so op execution and timer management stay in
   *  one place. */
  private async runPlan(route: SessionRoute, plan: PlanResult): Promise<void> {
    await this.executeOps(plan.ops);
    if (plan.flushAtMs !== undefined) this.scheduleFlush(route, plan.flushAtMs);
  }

  /** Execute one batch of planner ops. Every discord.js side effect the session surface needs lives
   *  here (thread resolution, send, edit, attachment upload) — live-boundary, mirroring the rest of this
   *  file; all the DECISIONS were already made by the pure planner. A failed op is logged and
   *  skipped, never thrown: one bad send must not abort the batch or crash the relay. */
  private async executeOps(ops: GatewayOp[]): Promise<void> {
    for (const op of ops) {
      try {
        await this.executeOp(op);
      } catch (err) {
        this.logger.warn({ err, op: op.kind }, 'discord: session op failed');
      }
    }
  }

  private async executeOp(op: GatewayOp): Promise<void> {
    const sink = await this.sinkFor(op.route);
    if (!sink) return; // no deliverable target (should not happen — DM is the ultimate fallback)
    const key = sessionRouteKey(op.route);
    if (op.kind === 'sendMessage') {
      const message = await sink.send(this.toSessionSendOptions(op));
      if (op.role === 'card') this.cardMessages.set(key, message);
      return;
    }
    if (op.kind === 'editMessage') {
      const existing = this.cardMessages.get(key);
      const payload = this.toSessionSendOptions(op);
      if (existing) {
        await existing.edit(payload);
      } else {
        // No remembered card (fresh process): re-anchor by posting a new card rather than dropping
        // the update.
        this.cardMessages.set(key, await sink.send(payload));
      }
      return;
    }
    // uploadAttachment
    const attachment = new AttachmentBuilder(Buffer.from(op.text, 'utf8'), { name: op.filename });
    await sink.send({
      files: [attachment],
      ...(op.content !== undefined ? { content: op.content } : {}),
    });
  }

  /** Inflate a session op into a payload valid for BOTH `channel.send` and `message.edit` (the
   *  common content/embeds/components subset). Conditional spreads keep any optional key from being
   *  present-and-undefined (rejected under exactOptionalPropertyTypes). */
  private toSessionSendOptions(
    op: Extract<GatewayOp, { kind: 'sendMessage' | 'editMessage' }>,
  ): SessionMessagePayload {
    return {
      ...('content' in op && op.content !== undefined ? { content: op.content } : {}),
      ...(op.embed !== undefined ? { embeds: [op.embed] } : {}),
      ...(op.components !== undefined ? { components: this.toRows(op.components) } : {}),
    };
  }

  /** Resolve a session route to a sendable channel: its recorded thread, or the user's DM as the
   *  remembered fallback. Creates the thread on first use (persisting the mapping), and if a
   *  previously-created thread has since vanished, pins the DM fallback so we stop re-fetching it.
   *  `protected` (not `private`) is the ONE seam the otherwise live-boundary per-session op execution
   *  exposes: it lets a test subclass return a controllable fake sink so the pure serialization of
   *  {@link deliver} can be exercised without a real Discord connection. */
  protected async sinkFor(route: SessionRoute): Promise<SendableChannels | undefined> {
    const target = await this.ensureTarget(route);
    if (target.kind === 'thread') {
      const channel = await this.client.channels.fetch(target.threadId);
      if (channel?.isSendable()) return channel;
      // Thread gone → fall back to DM for the rest of the session and remember it.
      await this.threadReg.record(route.discordUserId, route.sessionId, { kind: 'dm' });
    }
    const user = await this.client.users.fetch(route.discordUserId);
    return user.createDM();
  }

  /** The persisted delivery target for a route, creating a thread the first time (or pinning a DM
   *  fallback when no channel is available / creation fails). Never throws — the DM fallback is the
   *  never-crash, never-drop guarantee.
   *
   *  The early return on an existing registry entry is not just a cache: it is what makes a session
   *  keep the thread it started in when the user later moves their channel, because the resolver is
   *  consulted at most ONCE per session, on its first frame. `protected` (not `private`), same seam
   *  rationale as {@link sinkFor}: a test drives it directly with a fake parent channel to hold that
   *  invariant down, since removing the guard would look like a harmless refactor and would silently
   *  start re-resolving live sessions. */
  protected async ensureTarget(route: SessionRoute): Promise<DeliveryTarget> {
    const existing = this.threadReg.get(route.discordUserId, route.sessionId);
    if (existing) return existing;
    let target: DeliveryTarget = { kind: 'dm' };
    try {
      const parent = await this.sessionChannelResolver?.(route.discordUserId);
      if (parent) {
        // Session output is for the bound user only: a private, non-invitable thread keeps it
        // out of the channel's public thread list. The bot must then add the user explicitly —
        // a private thread is invisible even to its subject until they're a member — and that
        // add stays inside the try so a failure still lands on the DM fallback, not a thread
        // the user can never see.
        const thread = await parent.threads.create({
          name: `session ${route.sessionId.slice(0, 8)}`,
          type: ChannelType.PrivateThread,
          invitable: false,
          autoArchiveDuration: THREAD_AUTO_ARCHIVE_MINUTES,
        });
        await thread.members.add(route.discordUserId);
        target = { kind: 'thread', threadId: thread.id };
      }
    } catch (err) {
      this.logger.warn({ err, route }, 'discord: thread creation failed, falling back to DM');
      target = { kind: 'dm' };
    }
    // Write-behind: `record` updates the in-memory map synchronously (the authority for this
    // process's routing) and only the durability write is async. Delivery must not queue behind
    // disk I/O — this now runs ahead of EVERY frame's planning, not just the first send.
    this.threadReg.record(route.discordUserId, route.sessionId, target).catch((err: unknown) => {
      this.logger.warn({ err, route }, 'discord: failed to persist a session delivery target');
    });
    return target;
  }

  /** (Re)schedule the single coalesced-flush timer for a route. Clearing any prior timer first is
   *  what enforces "≤1 edit per window": a burst of updates keeps moving one timer, never stacking. */
  private scheduleFlush(route: SessionRoute, atMs: number): void {
    const key = sessionRouteKey(route);
    const prior = this.flushTimers.get(key);
    if (prior) clearTimeout(prior);
    const delay = Math.max(0, atMs - this.clock());
    const timer = setTimeout(() => {
      this.flushTimers.delete(key);
      // Through the route chain, never directly: the timer fires on its own schedule, so a
      // direct runPlan would race whatever chained delivery is mid-flight and can duplicate
      // the live card (see chainOnRoute). The catch keeps the chain's never-rejects contract.
      void this.chainOnRoute(route, async () => {
        try {
          await this.runPlan(route, this.planner.flush(route, this.clock()));
        } catch (err) {
          this.logger.warn({ err, route }, 'discord: session flush failed');
        }
      });
    }, delay);
    // Do not keep the event loop alive solely for a pending card edit.
    if (typeof timer.unref === 'function') timer.unref();
    this.flushTimers.set(key, timer);
  }

  /** Drop a terminal session's in-memory state (planner + card handle + any timer) after a grace. */
  private scheduleForget(route: SessionRoute, state: string): void {
    if (state !== 'done' && state !== 'failed' && state !== 'orphaned') return;
    const key = sessionRouteKey(route);
    const timer = setTimeout(() => {
      this.planner.forget(route);
      this.cardMessages.delete(key);
      const pending = this.flushTimers.get(key);
      if (pending) {
        clearTimeout(pending);
        this.flushTimers.delete(key);
      }
    }, SESSION_FORGET_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }

  /** Optimistically flip a session card to "stopping…" the moment a stop is requested (from `/stop`
   *  or the card's Stop button), before the daemon's terminal status confirms it. Through the
   *  route chain like every other card mutation — a direct edit here races in-flight chained
   *  deliveries for the same card (see chainOnRoute); the catch keeps the chain's
   *  never-rejects contract. `protected` (not `private`), same seam rationale as
   *  {@link sinkFor}: the serialization test drives the nudge directly, without the full fake
   *  interaction its production caller would need. */
  protected async nudgeStop(route: SessionRoute): Promise<void> {
    await this.chainOnRoute(route, async () => {
      try {
        await this.executeOps(this.planner.onStopRequested(route, this.clock()).ops);
      } catch (err) {
        this.logger.warn({ err, route }, 'discord: stop nudge failed');
      }
    });
  }

  // -------------------------------------------------------------------------
  // Thread messages → session input (the reverse direction of thread-per-session)
  // -------------------------------------------------------------------------

  /** A message posted anywhere the bot can read. Only messages typed by the BOUND user inside one
   *  of their session threads go anywhere: they become session input — `prompt.inject` while the
   *  session can still hear (live or orphaned, which re-attaches), or a resume spawn once it has
   *  ended, continuing the conversation in the same thread with a fresh sessionId. Everything else
   *  is ignored without a ripple. Structural parameter type (not discord.js `Message`) +
   *  `protected`, the same seam pattern as {@link sinkFor}: unit tests drive routing/auth with a
   *  plain object and no gateway connection. */
  protected async onThreadMessage(message: {
    author: { id: string; bot: boolean };
    channelId: string;
    channel: { isThread(): boolean };
    content: string;
    id: string;
  }): Promise<void> {
    if (message.author.bot) return; // includes our own streamed output
    if (!message.channel.isThread()) return;
    const binding = this.threadReg.latestForThread(message.channelId);
    if (!binding) return; // not a session thread this bot owns
    // Only the bound user steers their sessions. A private non-invitable thread should make this
    // unreachable for anyone else; if membership leaks anyway (admin tooling, future config), the
    // wrong author is ignored rather than answered — replying would confirm the thread is live.
    if (binding.discordUserId !== message.author.id) return;
    const text = message.content.trim();
    if (text.length === 0) {
      // Attachment/sticker-only: nothing forwardable. A visible shrug beats a silent drop.
      await this.reactInThread(message.channelId, message.id, '⚠️');
      return;
    }
    const cached = this.cache
      .getSessions(binding.discordUserId)
      .find((s) => s.sessionId === binding.sessionId);
    // done/failed → resume-spawn. Everything else — live, orphaned (prompt.inject re-attaches
    // it), or absent from the cache (bot restarted; the daemon still knows more than we do) —
    // goes as an inject, and a 'session_ended' refusal escalates to the resume automatically.
    const ended = cached !== undefined && (cached.state === 'done' || cached.state === 'failed');
    if (ended) {
      await this.resumeFromThread({
        discordUserId: binding.discordUserId,
        sessionId: binding.sessionId,
        threadId: message.channelId,
        messageId: message.id,
        text,
      });
      return;
    }
    const result = this.deps.relay.sendToUser(binding.discordUserId, (daemonId) => ({
      daemonId,
      type: 'prompt.inject',
      payload: {
        sessionId: binding.sessionId,
        text,
        // Deterministic per Discord message: this frame exists because THIS message exists.
        idempotencyKey: `thread:${message.id}`,
      },
    }));
    if (!result.ok) {
      await this.reactInThread(message.channelId, message.id, '⚠️');
      await this.sendInThread(message.channelId, `⚠️ ${result.error}`);
      return;
    }
    this.rememberThreadSend(result.id, {
      discordUserId: binding.discordUserId,
      threadId: message.channelId,
      messageId: message.id,
      sessionId: binding.sessionId,
      text,
      kind: 'inject',
    });
    await this.reactInThread(message.channelId, message.id, '📨');
  }

  /** Continue an ENDED session's conversation from its thread: `session.spawn` with the old wire
   *  sessionId as the resume ref (the daemon translates it to the SDK anchor) and the typed text
   *  as the resumed turn's prompt. The spawn's requestId is parked so the first correlated
   *  `session.status` binds the NEW sessionId to this same thread — see
   *  {@link maybeRebindSpawnedSession}. */
  private async resumeFromThread(opts: {
    discordUserId: string;
    sessionId: string;
    threadId: string;
    messageId: string;
    text: string;
  }): Promise<void> {
    // Single-flight per thread: both entry points (the ended-session branch and the
    // session_ended escalation) can race one resume's round-trip, and each would otherwise
    // fork its own live session from the same conversation. The loser queues; its text
    // delivers into the resumed session once the rebind lands. The TTL covers a daemon that
    // never answers — a wedged entry would otherwise leave the thread permanently
    // unresumable until a bot restart.
    const inFlight = this.resumesInFlight.get(opts.threadId);
    if (inFlight && this.clock() - inFlight.startedAtMs <= RESUME_IN_FLIGHT_TTL_MS) {
      if (inFlight.queued.length >= RESUME_QUEUE_CAP) {
        await this.reactInThread(opts.threadId, opts.messageId, '⚠️');
        await this.sendInThread(
          opts.threadId,
          '⚠️ too many messages queued while the session resumes — resend this one once it is up.',
        );
        return;
      }
      inFlight.queued.push({ text: opts.text, messageId: opts.messageId });
      await this.reactInThread(opts.threadId, opts.messageId, '📨');
      return;
    }
    const requestId = randomUUID();
    this.resumesInFlight.set(opts.threadId, {
      requestId,
      discordUserId: opts.discordUserId,
      startedAtMs: this.clock(),
      queued: [],
    });
    const result = this.deps.relay.sendToUser(opts.discordUserId, (daemonId) => ({
      daemonId,
      type: 'session.spawn',
      payload: {
        requestId,
        prompt: opts.text,
        resumeSessionId: opts.sessionId,
        idempotencyKey: `thread:${opts.messageId}`,
      },
    }));
    if (!result.ok) {
      this.resumesInFlight.delete(opts.threadId);
      await this.reactInThread(opts.threadId, opts.messageId, '⚠️');
      await this.sendInThread(opts.threadId, `⚠️ ${result.error}`);
      return;
    }
    this.rememberSpawnRebind(requestId, {
      discordUserId: opts.discordUserId,
      threadId: opts.threadId,
    });
    this.rememberThreadSend(result.id, {
      discordUserId: opts.discordUserId,
      threadId: opts.threadId,
      messageId: opts.messageId,
      sessionId: opts.sessionId,
      text: opts.text,
      kind: 'spawn',
      spawnRequestId: requestId,
    });
    await this.reactInThread(opts.threadId, opts.messageId, '🔄');
  }

  /** First correlated `session.status` for a phone-spawned session: when the spawn continued
   *  a conversation that lives in a thread, bind the NEW sessionId to that thread (before the
   *  frame is planned — see the deliver() call site), post a one-line seam so the reader can
   *  tell where the continuation begins (and which id `/stop` now wants), then deliver any
   *  messages typed while the resume was in flight. The thread is found via the parked
   *  requestId when this bot sent the spawn, or via the wire-echoed `resumedFrom` origin when
   *  it holds no memory of the spawn (restarted mid-resume, or a `/run` with a resume ref).
   *  Frames matching neither are the overwhelmingly common case and return immediately. */
  private async maybeRebindSpawnedSession(
    discordUserId: string,
    payload: PayloadOf<'session.status'>,
  ): Promise<void> {
    const requestId = payload.spawnRequestId ?? undefined;
    if (requestId === undefined) return;
    let threadId: string | undefined;
    const pending = this.pendingSpawnRebinds.get(requestId);
    if (pending && pending.discordUserId === discordUserId) {
      this.pendingSpawnRebinds.delete(requestId);
      threadId = pending.threadId;
    } else if (this.threadReg.get(discordUserId, payload.sessionId) === undefined) {
      const resumedFrom = payload.resumedFrom ?? undefined;
      if (resumedFrom !== undefined) {
        const origin = this.threadReg.get(discordUserId, resumedFrom);
        if (origin?.kind === 'thread') threadId = origin.threadId;
      }
    }
    if (threadId === undefined) return;
    try {
      await this.threadReg.record(discordUserId, payload.sessionId, {
        kind: 'thread',
        threadId,
      });
    } catch (err) {
      // The in-memory binding took effect before persistence — delivery still routes to the
      // thread for this bot's lifetime; only a restart would fall back to a fresh thread.
      this.logger.warn({ err, requestId }, 'discord: failed to persist a resumed-session rebind');
    }
    await this.sendInThread(threadId, `🔄 resumed as session \`${payload.sessionId.slice(0, 8)}\``);
    await this.drainResumeQueue(discordUserId, requestId, threadId, payload.sessionId);
  }

  /** Deliver the messages queued behind an in-flight resume (see {@link resumeFromThread}'s
   *  guard) into the session that resume produced, in arrival order. A failure surfaces in
   *  the thread — a queued message must never vanish silently. */
  private async drainResumeQueue(
    discordUserId: string,
    requestId: string,
    threadId: string,
    sessionId: string,
  ): Promise<void> {
    const inFlight = this.resumesInFlight.get(threadId);
    if (!inFlight || inFlight.requestId !== requestId) return;
    this.resumesInFlight.delete(threadId);
    for (const queued of inFlight.queued) {
      const result = this.deps.relay.sendToUser(discordUserId, (daemonId) => ({
        daemonId,
        type: 'prompt.inject',
        payload: { sessionId, text: queued.text, idempotencyKey: `thread:${queued.messageId}` },
      }));
      if (result.ok) {
        this.rememberThreadSend(result.id, {
          discordUserId,
          threadId,
          messageId: queued.messageId,
          sessionId,
          text: queued.text,
          kind: 'inject',
        });
      } else {
        await this.sendInThread(
          threadId,
          `⚠️ ${result.error} — a queued message was not delivered; resend it.`,
        );
      }
    }
  }

  /** Route a daemon `error` reply to the thread whose typed message caused the refused frame.
   *  Returns false when the error correlates to nothing thread-originated (caller falls through
   *  to the generic push path). A 'session_ended' inject refusal escalates straight to the resume
   *  spawn — the user's intent ("continue this conversation") is unambiguous, so making them
   *  retype the same text would be pure ceremony. */
  private async routeThreadSendError(payload: PayloadOf<'error'>): Promise<boolean> {
    const relatesTo = payload.relatesTo ?? undefined;
    if (relatesTo === undefined) return false;
    const ctx = this.pendingThreadSends.get(relatesTo);
    if (!ctx) return false;
    this.pendingThreadSends.delete(relatesTo);
    if (ctx.kind === 'inject' && payload.code === 'session_ended') {
      await this.resumeFromThread({
        discordUserId: ctx.discordUserId,
        sessionId: ctx.sessionId,
        threadId: ctx.threadId,
        messageId: ctx.messageId,
        text: ctx.text,
      });
      return true;
    }
    if (ctx.kind === 'spawn') {
      // The resume died — release the thread's single-flight guard so the next message can
      // try again, and account for anything queued behind it (never a silent loss).
      const inFlight = this.resumesInFlight.get(ctx.threadId);
      if (
        inFlight &&
        (ctx.spawnRequestId === undefined || inFlight.requestId === ctx.spawnRequestId)
      ) {
        this.resumesInFlight.delete(ctx.threadId);
        if (inFlight.queued.length > 0) {
          await this.sendInThread(
            ctx.threadId,
            `⚠️ ${inFlight.queued.length} queued message${
              inFlight.queued.length === 1 ? ' was' : 's were'
            } not delivered — resend after the next attempt.`,
          );
        }
      }
    }
    await this.reactInThread(ctx.threadId, ctx.messageId, '❗');
    await this.sendInThread(ctx.threadId, `⚠️ ${payload.message}`);
    return true;
  }

  /** Remember a thread-originated send for error correlation, FIFO-bounded. */
  private rememberThreadSend(envelopeId: string, ctx: ThreadSendContext): void {
    this.pendingThreadSends.set(envelopeId, ctx);
    if (this.pendingThreadSends.size > PENDING_THREAD_SENDS_MAX) {
      const oldest = this.pendingThreadSends.keys().next().value;
      if (oldest !== undefined) this.pendingThreadSends.delete(oldest);
    }
  }

  /** Remember a pending resume spawn for thread rebinding, FIFO-bounded like its sibling. */
  private rememberSpawnRebind(
    requestId: string,
    pending: { discordUserId: string; threadId: string },
  ): void {
    this.pendingSpawnRebinds.set(requestId, pending);
    if (this.pendingSpawnRebinds.size > PENDING_THREAD_SENDS_MAX) {
      const oldest = this.pendingSpawnRebinds.keys().next().value;
      if (oldest !== undefined) this.pendingSpawnRebinds.delete(oldest);
    }
  }

  /** Best-effort reaction on a thread message — feedback, never load-bearing; a failure is
   *  logged and swallowed. `protected` seam so unit tests observe reactions without discord.js. */
  protected async reactInThread(threadId: string, messageId: string, emoji: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(messageId);
      await message.react(emoji);
    } catch (err) {
      this.logger.debug({ err, threadId, messageId }, 'discord: failed to react in thread');
    }
  }

  /** Best-effort plain message into a thread — same contract and seam as {@link reactInThread}. */
  protected async sendInThread(threadId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isSendable()) await channel.send({ content });
    } catch (err) {
      this.logger.warn({ err, threadId }, 'discord: failed to send into thread');
    }
  }

  /** Inflate a RenderedPush's NON-content payload (embeds + component rows + file attachments)
   *  into discord.js send options — content travels separately because it may be chunked across
   *  several messages while these ride only the first. Return type is inferred from the
   *  conditional spreads so no key is ever present-and-undefined — `exactOptionalPropertyTypes`
   *  rejects `embeds: undefined` at the `user.send` boundary. */
  private toSendExtras(push: RenderedPush) {
    // Buttons and selects both live in the message's single `components` array; a card carries one
    // or the other (permission buttons vs. question selects), but merging is the honest way to
    // model "all this push's action rows" regardless.
    const rows = [
      ...(push.components !== undefined ? this.toRows(push.components) : []),
      ...(push.selects !== undefined ? this.toSelectRows(push.selects) : []),
    ];
    return {
      ...(push.embeds !== undefined ? { embeds: push.embeds } : {}),
      ...(rows.length > 0 ? { components: rows } : {}),
      ...(push.files !== undefined
        ? {
            files: push.files.map(
              (f) => new AttachmentBuilder(Buffer.from(f.text, 'utf8'), { name: f.filename }),
            ),
          }
        : {}),
    };
  }

  /** SelectSpec list → discord.js ActionRows, one select per row (a string select occupies a whole
   *  row). The only spot that touches StringSelectMenuBuilder, keeping the select DECISIONS
   *  (questionCards.ts) discord.js-free and unit-tested. */
  private toSelectRows(
    selects: SelectSpec[],
  ): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
    return selects.map((spec) => {
      const menu = new StringSelectMenuBuilder()
        .setCustomId(spec.customId)
        .setPlaceholder(spec.placeholder)
        .setMinValues(spec.minValues)
        .setMaxValues(spec.maxValues)
        .addOptions(
          spec.options.map((option) => {
            const built = new StringSelectMenuOptionBuilder()
              .setLabel(option.label)
              .setValue(option.value);
            if (option.description !== undefined) built.setDescription(option.description);
            return built;
          }),
        );
      return new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(menu);
    });
  }

  /** ButtonSpec rows → discord.js ActionRows. The only spot in the package that touches
   *  ButtonBuilder, keeping the button DECISIONS (buttons.ts) discord.js-free and unit-tested. */
  private toRows(rows: ButtonSpec[][]): ActionRowBuilder<MessageActionRowComponentBuilder>[] {
    return rows.map((row) => {
      const builder = new ActionRowBuilder<MessageActionRowComponentBuilder>();
      for (const spec of row) {
        builder.addComponents(
          new ButtonBuilder()
            .setCustomId(spec.customId)
            .setLabel(spec.label)
            .setStyle(BUTTON_STYLE[spec.style]),
        );
      }
      return builder;
    });
  }

  /** Publish the slash-command list to Discord on every start.
   *
   *  Both outcomes are logged, because the two failure modes here are invisible from the outside.
   *  A registration that never ran and one that ran successfully look identical to an operator —
   *  the commands simply are not there — and the list is published GLOBALLY (`commands.set` with
   *  no guild argument), so Discord can take up to an hour to surface a newly added one. Without
   *  a success line naming what was published, a missing command is indistinguishable from a
   *  command that is merely still propagating, and the only way to tell them apart is to wait. */
  private async registerCommands(): Promise<void> {
    const application = this.client.application;
    if (!application) {
      // Reachable whenever the gateway hands us a client whose application is not resolved yet.
      // Silently returning would leave Discord serving whatever list it stored on a previous run,
      // which reads as a stale deploy rather than as the no-op it actually is.
      this.logger.warn('discord: no application on the client, slash commands not registered');
      return;
    }
    const definitions = commandDefinitions();
    await application.commands.set(definitions);
    this.logger.info(
      { count: definitions.length, commands: definitions.map((d) => d.name).join(' ') },
      'discord: slash commands registered globally (new ones can take up to an hour to appear)',
    );
  }

  /** Ensure the progress-bar application emojis exist, then swap the injected bar renderer
   *  over to the emoji renderer. Falls through to unicode (no swap) whenever no emoji is
   *  available — `ensureProgressEmojis` never throws, and `renderEmojiBar` returns `undefined`
   *  per-bar if a sprite is still missing, at which point we render the unicode bar instead. */
  private async setupProgressEmojis(): Promise<void> {
    const application = this.client.application;
    if (!application) return;
    const byName = await ensureProgressEmojis(application, PROGRESS_ASSETS_DIR, this.logger);
    if (byName.size === 0) return; // nothing uploaded → keep the unicode default
    const resolve = emojiResolverFrom(byName);
    // Per-bar fallback: if any sprite this particular bar needs is absent, use unicode.
    this.deps.barRenderer = (percent, width) =>
      renderEmojiBar(percent, resolve, width) ?? layeredBar(percent, width);
    // Same deal for the `/timeline` track: sprite-backed when possible, unicode per-track
    // (and per-marker) when not.
    this.deps.trackStyle = {
      track: (events, nowMs, spanMs, width) =>
        renderEmojiTrack(events, nowMs, spanMs, resolve, width) ??
        emojiTrack(events, nowMs, spanMs, width),
      session: resolve('tl_ms') ?? UNICODE_TRACK_STYLE.session,
      weekly: resolve('tl_mw') ?? UNICODE_TRACK_STYLE.weekly,
      both: resolve('tl_mb') ?? UNICODE_TRACK_STYLE.both,
    };
    this.logger.info({ count: byName.size }, 'discord: progress emoji bars enabled');
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.onSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await this.onButton(interaction);
    } else if (interaction.isStringSelectMenu()) {
      await this.onQuestionSelect(interaction);
    } else if (interaction.isModalSubmit()) {
      await this.onQuestionModal(interaction);
    }
  }

  /** `protected` (not `private`), same seam rationale as {@link sinkFor}: a test drives a whole
   *  command through this method with a stand-in interaction, which is the only place the
   *  acknowledgement discipline below is observable — every handler returns a `CommandResult` and
   *  none of them knows whether the interaction was deferred first. */
  protected async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // The ONLY identity source for every handler below — never a command option, never
    // anything the interaction's author could spoof.
    const userId = interaction.user.id;
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    let result: CommandResult;

    // `/stats days:N` owns its whole reply lifecycle (defer now, edit in when the host answers),
    // so it is handled before the switch rather than folded into the shared synchronous reply
    // below. Without an explicit `days` it falls through to the cached snapshot like every other
    // command — the fast path stays exactly as it was.
    if (interaction.commandName === 'stats') {
      const days = interaction.options.getInteger('days');
      if (days !== null) {
        await this.runStatsScan(interaction, userId, days, requestId);
        return;
      }
    }

    switch (interaction.commandName) {
      case 'pair':
        result = commands.handlePair(this.deps, userId);
        break;
      case 'usage':
        result = commands.handleUsage(this.deps, userId);
        break;
      case 'timeline':
        result = commands.handleTimeline(this.deps, userId);
        break;
      case 'stats':
        result = commands.handleStats(this.deps, userId);
        break;
      case 'accounts':
        result = commands.handleAccounts(this.deps, userId);
        break;
      case 'sessions':
        result = commands.handleSessions(this.deps, userId);
        break;
      case 'prune':
        result = commands.handlePruneRequest(this.deps, userId, requestId);
        break;
      case 'settings':
        result = commands.handleSettings(this.deps, userId);
        break;
      case 'status':
        result = commands.handleStatus(this.deps, userId);
        break;
      case 'switch':
        result = commands.handleSwitch(
          this.deps,
          userId,
          interaction.options.getString('account', true),
          requestId,
          idempotencyKey,
        );
        break;
      case 'run': {
        const cwd = interaction.options.getString('cwd');
        const resume = interaction.options.getString('resume');
        result = commands.handleRun(
          this.deps,
          userId,
          interaction.options.getString('prompt', true),
          requestId,
          idempotencyKey,
          {
            ...(cwd !== null ? { cwd } : {}),
            ...(resume !== null ? { resumeSessionId: resume } : {}),
          },
        );
        break;
      }
      case 'say':
        result = commands.handleSay(
          this.deps,
          userId,
          interaction.options.getString('session', true),
          interaction.options.getString('text', true),
          idempotencyKey,
        );
        break;
      case 'stop':
        result = commands.handleStop(
          this.deps,
          userId,
          interaction.options.getString('session', true),
          idempotencyKey,
        );
        break;
      case 'approve':
        result = commands.handleApprove(
          this.deps,
          userId,
          interaction.options.getString('request', true),
          'once',
          idempotencyKey,
        );
        break;
      case 'deny':
        result = commands.handleDeny(
          this.deps,
          userId,
          interaction.options.getString('request', true),
          'once',
          idempotencyKey,
        );
        break;
      case 'reauth':
        result = commands.handleReauth(
          this.deps,
          userId,
          interaction.options.getString('account', true),
        );
        break;
      case 'thread-here': {
        // Parsed against the known values rather than cast: an unrecognised string can then only
        // ever mean the default, never a fourth behaviour arriving through a command definition
        // Discord still has registered from an older deploy.
        const raw = interaction.options.getString('action');
        const action: ThreadHereAction =
          raw === 'clear' ? 'clear' : raw === 'show' ? 'show' : 'pin';
        // The one command here that talks to Discord before it can answer: reading the channel,
        // minting a probe thread, admitting the user, deleting it, then persisting — each a round
        // trip, and thread creation is among the more aggressively rate-limited endpoints. Discord
        // gives an unacknowledged interaction three seconds, and overrunning it would show "The
        // application did not respond" over a pin that DID persist: the exact inverse of the
        // guarantee every reply on this path makes. Deferring buys fifteen minutes and costs a
        // thinking indicator. Every other branch is synchronous and needs none of this.
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        result = await this.onThreadHere(interaction, userId, action);
        break;
      }
      default:
        result = { kind: 'error', message: `unknown command: ${interaction.commandName}` };
    }
    await this.reply(interaction, result);
    // A successful /stop should flip the live session card to "stopping…" at once, not wait for the
    // daemon's terminal status. No-op when that session was never streamed to a card here.
    if (interaction.commandName === 'stop' && result.kind !== 'error') {
      await this.nudgeStop({
        discordUserId: userId,
        sessionId: interaction.options.getString('session', true),
      });
    }
  }

  /**
   * `/stats days:N` — the one command that round-trips to the host before it can answer.
   *
   * The shape is forced by two hard limits pulling opposite ways: Discord invalidates an
   * interaction that goes 3 seconds without acknowledgement, and re-reading the host's transcripts
   * over an arbitrary window takes far longer than that. So the reply is DEFERRED immediately and
   * edited in when the daemon's `stats.result` arrives on the delivery path (see {@link deliver}),
   * matched back here by requestId.
   *
   * Every path ends in exactly one edited reply, including the failures — a deferred interaction
   * that is never edited leaves the user watching a spinner with no explanation until Discord
   * quietly expires it.
   */
  private async runStatsScan(
    interaction: ChatInputCommandInteraction,
    userId: string,
    days: number,
    requestId: string,
  ): Promise<void> {
    // Ephemeral for the same reason every other reply here is: these carry account labels and
    // real token figures, which do not belong in a shared channel's history.
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    // Registered BEFORE the frame goes out. The daemon's answer arrives through `deliver()` on the
    // relay's socket, entirely independently of this method, and a result that lands with no
    // waiter registered is dropped — so the wait must exist first, not merely be created "soon".
    const waiting = this.pendingStats.awaitResult(requestId, STATS_SCAN_TIMEOUT_MS);
    const sent = commands.handleStatsScan(this.deps, userId, days, requestId);
    if (sent.kind === 'error') {
      // The request never left the bot (offline daemon, no binding) — nothing will ever answer it.
      this.pendingStats.abandon(requestId);
      await interaction.editReply({ content: `Error: ${sent.message}` });
      return;
    }

    const outcome = await waiting;
    if (outcome.kind === 'busy') {
      await interaction.editReply({
        content: 'Too many stats scans are already running — try again in a moment.',
      });
      return;
    }
    if (outcome.kind === 'timeout') {
      await interaction.editReply({
        content:
          `The host did not finish scanning within ${Math.round(STATS_SCAN_TIMEOUT_MS / 1000)}s. ` +
          `It may still be working — try a smaller \`days\` value, or \`/stats\` for the last ` +
          `pushed snapshot.`,
      });
      return;
    }
    const { ok, snapshot, error } = outcome.payload;
    // `ok` and a snapshot are sent together by every daemon that answers at all; the null check
    // is what keeps a truncated or older-daemon reply from rendering as an empty table.
    if (!ok || snapshot === undefined || snapshot === null) {
      await interaction.editReply({ content: `Error: ${error ?? 'the host could not scan'}` });
      return;
    }
    await interaction.editReply({ embeds: [buildStatsEmbed(snapshot)] });
  }

  /** `/thread-here` — where this user's future session threads are created, chosen by the user.
   *
   *  Orchestration only: the live seams below gather facts, probe and inspect; commands.ts decides
   *  and renders; this store is what gets written. The one thing that lives here and nowhere else
   *  is the ORDER — nothing is persisted until every preflight stage has passed — which is what
   *  makes each rejection's "nothing was changed" a statement rather than a hope.
   *
   *  `discordUserId` is the caller's own `interaction.user.id` and the command declares no user
   *  option, so a user can only read or write THEIR OWN routing: structurally, not by a check that
   *  a later edit could drop. `protected` (not `private`), same seam rationale as {@link sinkFor} —
   *  a test drives the whole tree, the write and the resolver end to end with no Discord
   *  connection.
   *
   *  Deliberately NOT gated on being paired, unlike every daemon-facing command here. This one
   *  reaches no daemon and reads no binding: it records a preference in the bot's own state, and
   *  choosing where your output should land before you own anything that produces output is a
   *  reasonable order to do things in. Refusing an unpaired user would also mean the first thing a
   *  new user is told about their routing is that they may not have an opinion on it yet. */
  protected async onThreadHere(
    interaction: ChatInputCommandInteraction,
    discordUserId: string,
    action: ThreadHereAction,
  ): Promise<CommandResult> {
    if (action === 'show') {
      return commands.buildThreadHereResult({
        kind: 'status',
        status: await this.threadHereStatus(discordUserId),
      });
    }
    if (action === 'clear') return this.clearThreadHere(discordUserId);
    return this.pinThreadHere(interaction, discordUserId);
  }

  /** Pin the invoking channel, after proving the bot can really use it. */
  private async pinThreadHere(
    interaction: ChatInputCommandInteraction,
    discordUserId: string,
  ): Promise<CommandResult> {
    const facts = await this.gatherThreadHereFacts(interaction);
    const rejection = commands.rejectThreadHereChannel(facts);
    if (rejection) return commands.buildThreadHereResult({ kind: 'rejected', rejection });
    // Stage two. The bits above can NAME what is wrong, which is what makes the reply actionable,
    // but only a real create-and-add can show that nothing else is: a guild's active-thread
    // ceiling, a rate limit and an overwrite subtlety are all invisible to a permission check.
    const probe = await this.probeThreadHere(interaction);
    if (!probe.ok) {
      return commands.buildThreadHereResult({
        kind: 'rejected',
        rejection: { kind: 'probe-failed', detail: probe.detail },
      });
    }
    const channelId = interaction.channelId;
    const existing = this.sessionChannelPins.get(discordUserId);
    // Re-pinning the same channel still runs the full preflight above rather than short-circuiting
    // on the stored value: permissions get revoked after the fact, and "it is already pinned" is
    // only worth saying once it has been rechecked.
    if (existing?.kind === 'channel' && existing.channelId === channelId) {
      return commands.buildThreadHereResult({ kind: 'already-pinned', channelId });
    }
    try {
      await this.sessionChannelPins.record(discordUserId, { kind: 'channel', channelId });
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: thread-here pin write failed');
      return commands.buildThreadHereResult({
        kind: 'rejected',
        rejection: { kind: 'save-failed' },
      });
    }
    this.logger.info({ discordUserId, channelId }, 'discord: thread-here pin updated');
    return commands.buildThreadHereResult({
      kind: 'pinned',
      channelId,
      ...(existing?.kind === 'channel' ? { previousChannelId: existing.channelId } : {}),
    });
  }

  /** Send this user's future session threads back to their DMs. No channel is involved, so this
   *  works from a DM as well as a server — the way out must not require standing anywhere.
   *
   *  A user who is already on DMs still gets the `{dm}` choice RECORDED, even on a deployment that
   *  configures no session channel at all and where the write therefore changes nothing today. The
   *  reason is tomorrow: an operator who later sets `CCTL_SESSION_CHANNEL_ID` would otherwise sweep
   *  that user into a channel they had explicitly asked not to be in, while a user who happened to
   *  pin-then-clear stays on DMs — two people who performed the same visible action getting
   *  different futures out of an edit neither of them saw. `already-dm` is reserved for the case
   *  where the decision is already on disk, so it is a true no-op rather than a silent one. */
  private async clearThreadHere(discordUserId: string): Promise<CommandResult> {
    const existing = this.sessionChannelPins.get(discordUserId);
    if (existing?.kind === 'dm') return commands.buildThreadHereResult({ kind: 'already-dm' });
    const overridden =
      existing === undefined ? this.deploymentChannelFor(discordUserId) : undefined;
    try {
      await this.sessionChannelPins.record(discordUserId, { kind: 'dm' });
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: thread-here pin write failed');
      return commands.buildThreadHereResult({
        kind: 'rejected',
        rejection: { kind: 'save-failed' },
      });
    }
    this.logger.info({ discordUserId }, 'discord: thread-here pin cleared');
    return commands.buildThreadHereResult({
      kind: 'cleared',
      ...(overridden !== undefined ? { overriddenChannelId: overridden } : {}),
    });
  }

  /** Where this user's next session thread would go, why, and whether that is currently possible.
   *  Runs the SAME precedence function routing does, so the answer cannot drift from the behaviour
   *  it describes — a status reply that confidently reports routing the bot no longer performs is
   *  worse than no status reply. */
  private async threadHereStatus(discordUserId: string): Promise<ThreadHereStatus> {
    const choice = chooseSessionChannel(discordUserId, {
      pin: this.sessionChannelPins.get(discordUserId),
      byUser: this.deploymentChannelsByUser,
      fallbackChannelId: this.deploymentChannelId,
    });
    if (choice.destination === 'dm') return { destination: 'dm', source: choice.source };
    return {
      destination: 'channel',
      channelId: choice.channelId,
      source: choice.source,
      health: await this.inspectChannelHealth(choice.channelId, discordUserId),
    };
  }

  /** The channel this user would fall back to with no pin of their own, or `undefined` for a
   *  deployment that configures none — what a clear is overriding, and only ever used to SAY so. */
  private deploymentChannelFor(discordUserId: string): string | undefined {
    const choice = chooseSessionChannel(discordUserId, {
      pin: undefined,
      byUser: this.deploymentChannelsByUser,
      fallbackChannelId: this.deploymentChannelId,
    });
    return choice.destination === 'channel' ? choice.channelId : undefined;
  }

  /** Live seam: everything about the invoking channel the pin decision needs, as plain data.
   *  `appPermissions` is computed by Discord and delivered on the interaction payload, so the
   *  ordinary case costs no API call; the channel fetch is only for one the client has not cached.
   *  `protected` so a test can supply the facts directly and exercise the decision tree. */
  protected async gatherThreadHereFacts(
    interaction: ChatInputCommandInteraction,
  ): Promise<ThreadHereChannelFacts> {
    const channel = await this.resolveInteractionChannel(interaction);
    return {
      inGuild: interaction.guildId !== null,
      // Null `guild` with a non-null `guildId` is the user-installed app in a server the bot was
      // never added to. Discord cannot compute channel-overwrite permissions for a bot with no
      // presence there, so the permission list would be a fixed baseline and "ask an admin to grant
      // these" would be advice that cannot work — hence its own rejection, not a permissions one.
      botInGuild: interaction.guild !== null,
      channelResolved: channel !== undefined,
      isThread: channel?.isThread() ?? false,
      // The same narrowing thread creation itself applies, so a channel that passes here is a
      // channel `ensureTarget` will accept later.
      isGuildText: channel?.type === ChannelType.GuildText,
      missingPermissions: missingThreadPermissionLabels(interaction.appPermissions),
    };
  }

  /** Live seam: create a private thread here, admit the user, delete it. The project's standing
   *  rule is to verify in the real target rather than a convenient proxy, and a permission check is
   *  exactly a convenient proxy — every argument matches {@link ensureTarget}'s real create,
   *  because the argument that would otherwise differ (`invitable: false`) is precisely what makes
   *  the member add require Manage Threads. Costs one thread created and deleted per pin, on a
   *  manually-invoked command. `protected` so a test can stand in for it. */
  protected async probeThreadHere(
    interaction: ChatInputCommandInteraction,
  ): Promise<{ ok: true } | { ok: false; detail: string }> {
    const channel = await this.resolveInteractionChannel(interaction);
    if (channel === undefined || channel.type !== ChannelType.GuildText) {
      // The fact-gathering pass already rejected everything but a text channel, so getting here
      // means the channel stopped resolving between the two reads.
      return { ok: false, detail: 'the channel could not be read' };
    }
    // Reap anything an earlier probe failed to delete before minting another, so a channel whose
    // cleanup keeps failing accumulates one leftover rather than one per invocation. Only the
    // client's own thread cache is consulted (no extra API call), and only threads this bot owns
    // under the probe's exact name are touched — a human's identically-named thread is not ours to
    // delete. Best-effort by design: a channel the bot cannot tidy is still a channel it can prove.
    for (const stale of channel.threads.cache.values()) {
      if (stale.name !== THREAD_HERE_PROBE_NAME || stale.ownerId !== this.client.user?.id) continue;
      await stale.delete().catch((err: unknown) => {
        this.logger.warn({ err }, 'discord: thread-here stale probe cleanup failed');
      });
    }
    try {
      const thread = await channel.threads.create({
        name: THREAD_HERE_PROBE_NAME,
        type: ChannelType.PrivateThread,
        invitable: false,
      });
      await thread.members.add(interaction.user.id);
      // A failed cleanup does not fail the command: the thing under test already succeeded, and the
      // leftover thread announces what it is by name.
      await thread.delete().catch((err: unknown) => {
        this.logger.warn({ err }, 'discord: thread-here probe cleanup failed');
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, detail: describeProbeFailure(err) };
    }
  }

  /** Live seam: can this user's session threads still be delivered to an already-chosen channel?
   *  Unlike the pin path this channel is not the one the command was invoked in, so the
   *  interaction's `appPermissions` says nothing about it and permissions have to be computed
   *  against the channel itself. Read-only — no thread is created, because `show` must stay safe to
   *  run at any time.
   *
   *  BOTH sides are checked, in the order a reader should act on them. The bot's own permissions
   *  come first because they block delivery for everyone in the channel and only an admin can fix
   *  them. The user's own access comes second and is the half a bot-only check would miss entirely:
   *  {@link ensureTarget} creates the thread AND admits the user to it, and that add fails once the
   *  user has left the server or lost sight of the channel — bot permissions unchanged, pin intact,
   *  every session silently on DMs. That is the likeliest cause of "why am I suddenly getting DMs?",
   *  so it is exactly what this must be able to name. */
  protected async inspectChannelHealth(
    channelId: string,
    discordUserId: string,
  ): Promise<ThreadHereChannelHealth> {
    const channel = await this.client.channels.fetch(channelId).catch(() => null);
    if (channel === null || channel.type !== ChannelType.GuildText) return { kind: 'unreachable' };
    const me =
      channel.guild.members.me ?? (await channel.guild.members.fetchMe().catch(() => null));
    if (!me) return { kind: 'unreachable' };
    const missing = missingThreadPermissionLabels(channel.permissionsFor(me));
    if (missing.length > 0) return { kind: 'missing-permissions', missing };
    // A failed member fetch and a member who cannot see the channel collapse to one answer on
    // purpose: "you have left the server" and "you can no longer see that channel" have the same
    // consequence, the same repair, and the bot cannot always distinguish them anyway.
    const member = await channel.guild.members.fetch(discordUserId).catch(() => null);
    if (!member || channel.permissionsFor(member)?.has(PermissionFlagsBits.ViewChannel) !== true) {
      return { kind: 'user-cannot-access' };
    }
    return { kind: 'ok' };
  }

  /** The channel an interaction fired in. Cached for anything the bot can see with the Guilds
   *  intent; the fetch covers the case where it is not, using the id the interaction always
   *  carries. Both failure modes collapse to `undefined` — the caller reports "could not read this
   *  channel", which is true either way and actionable in the same way (try again). */
  private async resolveInteractionChannel(
    interaction: ChatInputCommandInteraction,
  ): Promise<Channel | undefined> {
    if (interaction.channel) return interaction.channel;
    const fetched = await this.client.channels.fetch(interaction.channelId).catch(() => null);
    return fetched ?? undefined;
  }

  /** Button routing is the whole two-tap + dedupe surface, but every DECISION is made by the pure
   *  `resolveTap`; this method only performs the discord.js side effect each outcome names. */
  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const outcome = resolveTap(interaction.customId, this.clock());
    switch (outcome.kind) {
      case 'ignore':
        await interaction.reply({
          content: `Error: ${outcome.reason}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      case 'confirm':
        // First tap of a destructive action: swap in Confirm/Cancel — the new buttons ARE the
        // feedback, no extra message needed.
        await interaction.update({ components: this.toRows(outcome.rows) });
        return;
      case 'restore':
        // A restore visibly undoes the row with no other signal — say WHY, ephemerally: an
        // expired Confirm silently resetting to the original buttons reads as a bug, not a
        // timeout. Ephemeral keeps it feedback for the tapper, not card clutter.
        await interaction.update({ components: this.toRows(outcome.rows) });
        await interaction.followUp({ content: outcome.note, flags: MessageFlags.Ephemeral });
        return;
      case 'execute':
        await this.executeButton(interaction, userId, outcome);
        return;
    }
  }

  /** Run a confirmed/single-tap button, guarded by the bot-side dedupe so a double-tap collapses
   *  to "already handled" without a second command frame. */
  private async executeButton(
    interaction: ButtonInteraction,
    userId: string,
    outcome: Extract<TapOutcome, { kind: 'execute' }>,
  ): Promise<void> {
    const key = buttonIdempotencyKey(userId, outcome);
    if (!this.seenKeys.markIfNew(key)) {
      await interaction.reply({ content: 'Already handled.', flags: MessageFlags.Ephemeral });
      return;
    }
    const result = this.dispatchButton(userId, outcome, key);
    // Clear the card's buttons so it can't be tapped again, then report the outcome ephemerally.
    await interaction.update({ components: [] });
    await this.followUp(interaction, result);
    // A confirmed Stop from the card flips it to "stopping…" immediately (same as /stop), composing
    // the two-tap confirm + dedupe path above with the live-card state.
    if (outcome.action === 'stop' && result.kind !== 'error') {
      await this.nudgeStop({ discordUserId: userId, sessionId: outcome.id });
    }
  }

  /** Map an executed button to its command handler. `switch` needs a fresh requestId per attempt;
   *  the idempotency `key` is the deterministic dedupe key so a daemon-side resend is also idempotent. */
  private dispatchButton(
    userId: string,
    outcome: Extract<TapOutcome, { kind: 'execute' }>,
    key: string,
  ): CommandResult {
    const scope: 'once' | 'session' = outcome.scope === 'session' ? 'session' : 'once';
    switch (outcome.action) {
      case 'approve':
        return commands.handleApprove(this.deps, userId, outcome.id, scope, key);
      case 'deny':
        return commands.handleDeny(this.deps, userId, outcome.id, scope, key);
      case 'switch':
        return commands.handleSwitch(this.deps, userId, outcome.id, randomUUID(), key);
      case 'stop':
        return commands.handleStop(this.deps, userId, outcome.id, key);
      case 'prune':
        // The armed button carries the /prune invocation's requestId as its id (see
        // pruneButtons) — reuse it so the frame correlates back to that invocation.
        return commands.handlePruneConfirm(this.deps, userId, outcome.id, key);
    }
  }

  /** A select tap on a question card: record the chosen options, open the Other modal when Other
   *  was picked, otherwise try to finalize. All DECISIONS (decode, resolve indices→labels,
   *  completeness) are the pure questionCards module's; this method only performs the discord.js
   *  side effects each names. */
  private async onQuestionSelect(interaction: StringSelectMenuInteraction): Promise<void> {
    const decoded = decodeQuestionSelect(interaction.customId);
    if (!decoded) {
      await interaction.reply({
        content: 'Error: unrecognized selection.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { requestId, qIndex } = decoded;
    if (this.questionAnswers.expectedCount(requestId) === undefined) {
      await this.replyQuestionGone(interaction);
      return;
    }
    this.questionAnswers.setSelection(requestId, qIndex, interaction.values);
    if (interaction.values.includes(OTHER_VALUE)) {
      // A modal can ONLY be shown from the select interaction that requested it — so the modal is
      // the acknowledgment here, and the typed answer arrives later on its own submit.
      await interaction.showModal(this.buildOtherModal(requestId, qIndex));
      return;
    }
    await this.finalizeQuestion(interaction, interaction.user.id, requestId);
  }

  /** The Other modal's submit: record the typed free-text answer, then try to finalize the card. */
  private async onQuestionModal(interaction: ModalSubmitInteraction): Promise<void> {
    const decoded = decodeQuestionModal(interaction.customId);
    if (!decoded) {
      await interaction.reply({
        content: 'Error: unrecognized submission.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    const { requestId, qIndex } = decoded;
    if (this.questionAnswers.expectedCount(requestId) === undefined) {
      await this.replyQuestionGone(interaction);
      return;
    }
    this.questionAnswers.setOther(
      requestId,
      qIndex,
      interaction.fields.getTextInputValue(QUESTION_MODAL_INPUT_ID),
    );
    await this.finalizeQuestion(interaction, interaction.user.id, requestId);
  }

  /** Given an updated collector, either quietly acknowledge (more questions still to answer) or —
   *  once every question is answered — relay the `question.response`, mark the ORIGINAL card
   *  answered, and confirm ephemerally. Offline daemon: report the error and leave the card AND the
   *  accumulated answers intact so the user can retry when it returns (the dedupe mark is rolled
   *  back for the same reason). Consumes the card synchronously on success so a concurrent second
   *  completion finds nothing and cannot double-post. */
  private async finalizeQuestion(
    interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
    userId: string,
    requestId: string,
  ): Promise<void> {
    const count = this.questionAnswers.expectedCount(requestId);
    if (count === undefined) {
      await this.replyQuestionGone(interaction);
      return;
    }
    if (!this.questionAnswers.isComplete(requestId, count)) {
      // Quiet ack — the card keeps its remaining pickers for the user to fill.
      await interaction.deferUpdate();
      return;
    }
    const dedupeKey = questionSubmitDedupeKey(userId, requestId);
    if (!this.seenKeys.markIfNew(dedupeKey)) {
      await interaction.reply({ content: 'Already answered.', flags: MessageFlags.Ephemeral });
      return;
    }
    const ref = this.questionCards.get(requestId);
    if (!ref) {
      await this.replyQuestionGone(interaction);
      return;
    }
    const answers = this.questionAnswers.answersOf(requestId);
    const result = commands.handleQuestionAnswer(this.deps, userId, {
      requestId,
      answers,
      idempotencyKey: questionIdempotencyKey(requestId),
    });
    if (result.kind === 'error') {
      // Daemon offline / relay failure: keep everything answerable and roll back the dedupe mark
      // so a retry once the daemon returns is not swallowed as a duplicate.
      this.seenKeys.forget(dedupeKey);
      await interaction.reply({
        content: `Error: ${result.message}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Success: consume the card and its state right away (before any await), so a concurrent second
    // completion sees no ref and bails instead of editing/answering twice.
    this.questionCards.take(requestId);
    this.questionAnswers.forget(requestId);
    await interaction.reply({
      content: 'Answer sent to the session.',
      flags: MessageFlags.Ephemeral,
    });
    await this.markQuestionAnswered(ref, answers);
  }

  /** Edit the original question card to its answered state (chosen answers shown, selects removed).
   *  Best-effort like the lapse edit: a card that has since vanished is logged, never thrown. */
  private async markQuestionAnswered(
    ref: CardRef,
    answers: PayloadOf<'question.response'>['answers'],
  ): Promise<void> {
    try {
      const message = await this.resolveCardMessage(ref);
      if (!message) return;
      await message.edit({ embeds: [buildAnsweredQuestionEmbed(answers)], components: [] });
    } catch (err) {
      this.logger.warn({ err }, 'discord: failed to edit an answered question card');
    }
  }

  /** The Other free-text modal: one required paragraph input, its customId encoding which held
   *  question it answers so the submit routes back to the right card. */
  private buildOtherModal(requestId: string, qIndex: number): ModalBuilder {
    const input = new TextInputBuilder()
      .setCustomId(QUESTION_MODAL_INPUT_ID)
      .setLabel('Your answer')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true);
    return new ModalBuilder()
      .setCustomId(encodeQuestionModal(requestId, qIndex))
      .setTitle('Your answer')
      .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }

  /** Ephemeral "this card is no longer answerable" — for a select/modal whose card was already
   *  answered, lapsed, evicted, or lost to a restart. */
  private async replyQuestionGone(
    interaction: StringSelectMenuInteraction | ModalSubmitInteraction,
  ): Promise<void> {
    await interaction.reply({
      content: 'This question is no longer active.',
      flags: MessageFlags.Ephemeral,
    });
  }

  /** Report a command result on a button interaction that has already been acknowledged via
   *  `update` — must use `followUp`, not `reply`. */
  private async followUp(interaction: ButtonInteraction, result: CommandResult): Promise<void> {
    // Same non-deprecated `flags: Ephemeral` spelling as reply() below, for the same reason:
    // these can carry account labels and usage figures.
    const ephemeral = { flags: MessageFlags.Ephemeral } as const;
    if (result.kind === 'embed') {
      await interaction.followUp({ embeds: [result.embed], ...ephemeral });
    } else if (result.kind === 'text') {
      await interaction.followUp({
        content: result.text,
        ...ephemeral,
        ...(result.components !== undefined ? { components: this.toRows(result.components) } : {}),
      });
    } else {
      await interaction.followUp({ content: `Error: ${result.message}`, ...ephemeral });
    }
  }

  private async reply(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    result: CommandResult,
  ): Promise<void> {
    const body =
      result.kind === 'embed'
        ? { embeds: [result.embed] }
        : result.kind === 'text'
          ? {
              content: result.text,
              // A text result may carry buttons (e.g. /prune's armed confirm control) — inflate
              // them exactly like every other ButtonSpec surface.
              ...(result.components !== undefined
                ? { components: this.toRows(result.components) }
                : {}),
            }
          : { content: `Error: ${result.message}` };
    // A deferred interaction has already been acknowledged, so its placeholder must be EDITED —
    // `reply` on it is rejected as "already acknowledged" and the user is left watching the
    // thinking indicator forever. The deferral already carried the ephemeral flag; repeating it
    // here is not possible and not needed, since a reply's visibility is fixed at acknowledgement.
    if (interaction.deferred) {
      await interaction.editReply(body);
      return;
    }
    // `flags: Ephemeral` rather than the deprecated `ephemeral: true`. These replies can carry
    // account labels and usage figures, so if the option ever stopped being honored they would
    // post visibly in a shared channel — worth not relying on a deprecated spelling.
    await interaction.reply({ ...body, flags: MessageFlags.Ephemeral });
  }
}

/** The full slash-command surface this bot publishes to Discord, as REST payloads. Module-level
 *  and exported rather than a method: it reads no gateway state, and the primer's drift test needs
 *  the registered names without opening a Discord connection. Adding a command here is what makes
 *  {@link PAIRING_PRIMER_MESSAGE} require a matching line (or an entry in
 *  {@link PRIMER_OMITTED_COMMANDS}). */
export function commandDefinitions() {
  const account = (name: string, description: string) =>
    new SlashCommandBuilder()
      .setName(name)
      .setDescription(description)
      .addStringOption((o) => o.setName('account').setDescription('Account id').setRequired(true));

  return [
    new SlashCommandBuilder().setName('pair').setDescription('Pair a new daemon to your account'),
    new SlashCommandBuilder().setName('usage').setDescription('Show usage across accounts'),
    new SlashCommandBuilder()
      .setName('timeline')
      .setDescription('5h-session budget and reset timeline across accounts'),
    new SlashCommandBuilder()
      .setName('stats')
      .setDescription(
        `Token counts per account, model and day (last ${DEFAULT_STATS_DAYS} days by default)`,
      )
      // Optional on purpose: omitting it answers instantly from the snapshot the daemon already
      // pushed, while supplying it costs a live scan on the host. The min/max are declared here so
      // Discord rejects an out-of-range value in the client — no round trip, no wasted scan — but
      // they are only the FIRST of three checks: a frame that never passed through this
      // declaration is still bounded by the wire schema at decode, and clamped again by the daemon
      // that actually pays the disk IO.
      .addIntegerOption((o) =>
        o
          .setName('days')
          .setDescription(
            `How many days back to count (${MIN_STATS_DAYS}-${MAX_STATS_DAYS}); scans the host live`,
          )
          .setMinValue(MIN_STATS_DAYS)
          .setMaxValue(MAX_STATS_DAYS)
          .setRequired(false),
      ),
    new SlashCommandBuilder().setName('accounts').setDescription('List paired accounts'),
    new SlashCommandBuilder().setName('sessions').setDescription('List known sessions'),
    new SlashCommandBuilder()
      .setName('prune')
      .setDescription('Remove dormant session records (asks to confirm)'),
    new SlashCommandBuilder()
      .setName('settings')
      .setDescription("Show the daemon's effective settings and where each came from"),
    // Routing sits beside configuration. Verb-less like /usage and /settings because it names a
    // place rather than an action, and one command with an action option rather than a pair of
    // commands so pinning and un-pinning stay visibly the same setting.
    new SlashCommandBuilder()
      .setName('thread-here')
      .setDescription('Send your session threads to this channel, or back to your DMs')
      .addStringOption((o) =>
        o
          .setName('action')
          .setDescription('Default: pin this channel')
          .setRequired(false)
          .addChoices(
            { name: 'pin this channel', value: 'pin' },
            { name: 'clear — send my session threads back to my DMs', value: 'clear' },
            { name: 'show — where do my session threads go right now?', value: 'show' },
          ),
      ),
    new SlashCommandBuilder().setName('status').setDescription('Show daemon connection status'),
    account('switch', 'Switch the active account'),
    new SlashCommandBuilder()
      .setName('run')
      .setDescription('Start a Claude Code session')
      .addStringOption((o) =>
        o.setName('prompt').setDescription('Initial prompt').setRequired(true),
      )
      .addStringOption((o) =>
        o.setName('cwd').setDescription('Working directory').setRequired(false),
      )
      .addStringOption((o) =>
        o.setName('resume').setDescription('Session id to resume').setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName('say')
      .setDescription('Send a message into a running session')
      .addStringOption((o) =>
        o.setName('session').setDescription('Session id or label').setRequired(true),
      )
      .addStringOption((o) => o.setName('text').setDescription('Message').setRequired(true)),
    new SlashCommandBuilder()
      .setName('stop')
      .setDescription('Stop a running session')
      .addStringOption((o) => o.setName('session').setDescription('Session id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('approve')
      .setDescription('Approve a pending permission request')
      .addStringOption((o) => o.setName('request').setDescription('Request id').setRequired(true)),
    new SlashCommandBuilder()
      .setName('deny')
      .setDescription('Deny a pending permission request')
      .addStringOption((o) => o.setName('request').setDescription('Request id').setRequired(true)),
    account('reauth', 'Re-authenticate a quarantined account'),
    // Every command works identically from a server or from a DM with a user-installed
    // app (handlers key solely off interaction.user.id, and delivery defaults to DM), so
    // both contexts are declared on all of them. Without these, the commands stay
    // guild-install-only and the portal's "User Install" toggle does nothing.
  ].map((c) =>
    c
      .setIntegrationTypes(
        ApplicationIntegrationType.GuildInstall,
        ApplicationIntegrationType.UserInstall,
      )
      .setContexts(InteractionContextType.Guild, InteractionContextType.BotDM)
      .toJSON(),
  );
}
