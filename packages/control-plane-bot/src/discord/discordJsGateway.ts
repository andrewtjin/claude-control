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
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type EmbedBuilder,
  type Message,
  type MessageActionRowComponentBuilder,
  type SendableChannels,
  SlashCommandBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isType, type Envelope } from '@claude-control/shared-protocol';
import type { DiscordGateway } from './gateway.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import { DaemonStateCache } from './stateCache.js';
import { emojiTrack, layeredBar, UNICODE_TRACK_STYLE } from './richFormat.js';
import {
  ensureProgressEmojis,
  emojiResolverFrom,
  renderEmojiBar,
  renderEmojiTrack,
} from './emojiBars.js';
import { renderPush, type RenderedPush } from './pushRender.js';
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
  type PlanResult,
  type SessionRoute,
} from './sessionPlanner.js';
import { PersistentThreadRegistry, type DeliveryTarget } from './threadRegistry.js';
import * as commands from './commands.js';
import type { CommandDeps, CommandResult } from './commands.js';

/** A channel-like object that can host per-session threads. Kept structural (not a discord.js
 *  channel class) so wiring a real per-user text channel later needs no change here, and so the
 *  gateway compiles today with the default resolver that returns `undefined` (pure-DM deployment
 *  until channel-per-user lands — every session then falls back to DM, which is the sanctioned
 *  fallback path, not a failure). */
export interface SessionThreadParent {
  threads: { create(options: { name: string }): Promise<{ id: string }> };
}

/** Where a user's per-session threads should be created. Returns `undefined` (the default) when no
 *  channel is available, in which case delivery falls back to the user's DM and remembers it. */
export type SessionChannelResolver = (
  discordUserId: string,
) => Promise<SessionThreadParent | undefined>;

/** The content/embeds/components subset common to `channel.send` and `message.edit`, so one built
 *  payload drives both the initial card send and every subsequent in-place edit. */
interface SessionMessagePayload {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ActionRowBuilder<MessageActionRowComponentBuilder>[];
}

// Where the committed progress-bar sprites live, relative to this compiled file
// (dist/discord/discordJsGateway.js → ../../assets/progress-bar → the package's assets dir).
const PROGRESS_ASSETS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../assets/progress-bar',
);

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
  private readonly sessionChannelResolver: SessionChannelResolver | undefined;
  /** Live-card message per session route, so `editMessage ref:'card'` targets the right message.
   *  In-memory only: after a restart the card id is gone and the first edit posts a fresh card
   *  (a benign visual re-anchor, not a lost update). */
  private readonly cardMessages = new Map<string, Message>();
  /** One pending coalesced-flush timer per session route; rescheduled, never stacked. */
  private readonly flushTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Per-session-route serialization chain for managed-session frames (status/output). relay.ts
   *  fires `deliver()` from an un-awaited `socket.on('message')` handler, so two frames for ONE
   *  session would otherwise interleave across the awaits inside executeOps: the second's
   *  editMessage can run before the first's `await sink.send()` has stored the card id in
   *  {@link cardMessages}, posting a DUPLICATE card (and later edits then target whichever send
   *  resolved last). Chaining each route's processing onto the previous one forces in-order,
   *  run-to-completion delivery. The entry is deleted once it drains (bounded by LIVE routes) and
   *  the chain NEVER rejects, so one bad frame can't stall every later frame for that session. */
  private readonly deliverChains = new Map<string, Promise<void>>();

  constructor(options: DiscordJsGatewayOptions) {
    this.logger = options.logger ?? noopLogger;
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
    this.clock = options.clock ?? (() => Date.now());
    this.seenKeys = new SeenKeys({
      max: SEEN_KEYS_MAX,
      ttlMs: SEEN_KEYS_TTL_MS,
      clock: this.clock,
    });
    this.threadReg = new PersistentThreadRegistry(
      options.stateDir ?? join(tmpdir(), 'claude-control-bot'),
    );
    this.sessionChannelResolver = options.sessionChannelResolver;
    this.deps = { relay: options.relay, pairing: options.pairing, cache: this.cache };
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

    this.client.once('ready', () => {
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
  }

  /** Log in and start handling interactions. Never call from a test — it opens a real
   *  connection to Discord's gateway. Loads the persisted session→thread map first so sessions
   *  streamed before a restart keep delivering to their existing threads. */
  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('DISCORD_BOT_TOKEN is not set and no token was provided');
    }
    await this.threadReg.load();
    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** DiscordGateway.deliver — push one daemon-originated envelope to the owning user.
   *
   *  Two paths. Managed-session frames (session.status/session.output) go to the thread-per-
   *  session surface: the pure `SessionPlanner` turns them into thread ops (create/send/edit/upload)
   *  which this class executes. Everything else keeps the card behaviour — the pure `renderPush`
   *  decides the DM card and this class only inflates ButtonSpecs and sends it. The state cache is
   *  fed on EVERY envelope regardless, so `/usage`/`/sessions` keep answering from it. */
  async deliver(discordUserId: string, envelope: Envelope): Promise<void> {
    this.cache.record(discordUserId, envelope);
    // Managed-session frames mutate shared per-route state (the planner view AND cardMessages), so
    // they are serialized per route to defeat the interleaving that duplicates cards. Everything
    // else is stateless w.r.t. that surface and keeps the direct path.
    if (isType(envelope, 'session.status') || isType(envelope, 'session.output')) {
      const route: SessionRoute = { discordUserId, sessionId: envelope.payload.sessionId };
      return this.enqueueSessionDelivery(route, envelope);
    }
    const push = renderPush(envelope);
    if (!push) return; // cache-only: not worth a DM
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(this.toSendOptions(push));
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: failed to DM user');
    }
  }

  /** Append one managed-session envelope to its route's serialization chain, returning a promise
   *  that resolves when THIS envelope has been fully processed. Both branches of the `.then` run
   *  the same processing so a (never-expected) prior rejection can't skip an envelope; the entry is
   *  dropped once it drains, but only if it is still the tail (a later enqueue may have replaced it),
   *  keeping the map bounded by live routes. */
  private enqueueSessionDelivery(route: SessionRoute, envelope: Envelope): Promise<void> {
    const key = sessionRouteKey(route);
    const prior = this.deliverChains.get(key) ?? Promise.resolve();
    const process = (): Promise<void> => this.processSessionEnvelope(route, envelope);
    const next = prior.then(process, process);
    this.deliverChains.set(key, next);
    void next.finally(() => {
      if (this.deliverChains.get(key) === next) this.deliverChains.delete(key);
    });
    return next;
  }

  /** Process one managed-session envelope: run its plan (create/edit the card, upload, etc.) and,
   *  for a terminal status, schedule the forget grace. Never rejects — a throw here (executeOps
   *  already swallows per-op failures, so this guards only against a planner bug) is logged so it
   *  can't reject the route chain and stall every later frame for the session. */
  private async processSessionEnvelope(route: SessionRoute, envelope: Envelope): Promise<void> {
    try {
      if (isType(envelope, 'session.status')) {
        await this.runPlan(route, this.planner.onStatus(route, envelope.payload, this.clock()));
        this.scheduleForget(route, envelope.payload.state);
        return;
      }
      if (isType(envelope, 'session.output')) {
        await this.runPlan(route, this.planner.onOutput(route, envelope.payload, this.clock()));
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
   *  never-crash, never-drop guarantee. */
  private async ensureTarget(route: SessionRoute): Promise<DeliveryTarget> {
    const existing = this.threadReg.get(route.discordUserId, route.sessionId);
    if (existing) return existing;
    let target: DeliveryTarget = { kind: 'dm' };
    try {
      const parent = await this.sessionChannelResolver?.(route.discordUserId);
      if (parent) {
        const thread = await parent.threads.create({
          name: `session ${route.sessionId.slice(0, 8)}`,
        });
        target = { kind: 'thread', threadId: thread.id };
      }
    } catch (err) {
      this.logger.warn({ err, route }, 'discord: thread creation failed, falling back to DM');
      target = { kind: 'dm' };
    }
    await this.threadReg.record(route.discordUserId, route.sessionId, target);
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
      void this.runPlan(route, this.planner.flush(route, this.clock())).catch((err: unknown) => {
        this.logger.warn({ err, route }, 'discord: session flush failed');
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
   *  or the card's Stop button), before the daemon's terminal status confirms it. */
  private async nudgeStop(route: SessionRoute): Promise<void> {
    await this.executeOps(this.planner.onStopRequested(route, this.clock()).ops);
  }

  /** Inflate a RenderedPush into discord.js send options (content + embeds + component rows +
   *  file attachments). Return type is inferred from the conditional spreads so no key is ever
   *  present-and-undefined — `exactOptionalPropertyTypes` rejects `embeds: undefined` at the
   *  `user.send` boundary. */
  private toSendOptions(push: RenderedPush) {
    return {
      ...(push.content !== undefined ? { content: push.content } : {}),
      ...(push.embeds !== undefined ? { embeds: push.embeds } : {}),
      ...(push.components !== undefined ? { components: this.toRows(push.components) } : {}),
      ...(push.files !== undefined
        ? {
            files: push.files.map(
              (f) => new AttachmentBuilder(Buffer.from(f.text, 'utf8'), { name: f.filename }),
            ),
          }
        : {}),
    };
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

  private async registerCommands(): Promise<void> {
    const application = this.client.application;
    if (!application) return;
    await application.commands.set(this.commandDefinitions());
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

  private commandDefinitions() {
    const account = (name: string, description: string) =>
      new SlashCommandBuilder()
        .setName(name)
        .setDescription(description)
        .addStringOption((o) =>
          o.setName('account').setDescription('Account id').setRequired(true),
        );

    return [
      new SlashCommandBuilder().setName('pair').setDescription('Pair a new daemon to your account'),
      new SlashCommandBuilder().setName('usage').setDescription('Show usage across accounts'),
      new SlashCommandBuilder()
        .setName('timeline')
        .setDescription('5h-session budget and reset timeline across accounts'),
      new SlashCommandBuilder().setName('accounts').setDescription('List paired accounts'),
      new SlashCommandBuilder().setName('sessions').setDescription('List known sessions'),
      new SlashCommandBuilder()
        .setName('settings')
        .setDescription("Show the daemon's effective settings and where each came from"),
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
        .addStringOption((o) => o.setName('session').setDescription('Session id').setRequired(true))
        .addStringOption((o) => o.setName('text').setDescription('Message').setRequired(true)),
      new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Stop a running session')
        .addStringOption((o) =>
          o.setName('session').setDescription('Session id').setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('approve')
        .setDescription('Approve a pending permission request')
        .addStringOption((o) =>
          o.setName('request').setDescription('Request id').setRequired(true),
        ),
      new SlashCommandBuilder()
        .setName('deny')
        .setDescription('Deny a pending permission request')
        .addStringOption((o) =>
          o.setName('request').setDescription('Request id').setRequired(true),
        ),
      account('reauth', 'Re-authenticate a quarantined account'),
    ].map((c) => c.toJSON());
  }

  private async onInteraction(interaction: Interaction): Promise<void> {
    if (interaction.isChatInputCommand()) {
      await this.onSlashCommand(interaction);
    } else if (interaction.isButton()) {
      await this.onButton(interaction);
    }
  }

  private async onSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    // The ONLY identity source for every handler below — never a command option, never
    // anything the interaction's author could spoof.
    const userId = interaction.user.id;
    const requestId = randomUUID();
    const idempotencyKey = randomUUID();
    let result: CommandResult;

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
      case 'accounts':
        result = commands.handleAccounts(this.deps, userId);
        break;
      case 'sessions':
        result = commands.handleSessions(this.deps, userId);
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

  /** Button routing is the whole two-tap + dedupe surface, but every DECISION is made by the pure
   *  `resolveTap`; this method only performs the discord.js side effect each outcome names. */
  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const outcome = resolveTap(interaction.customId, this.clock());
    switch (outcome.kind) {
      case 'ignore':
        await interaction.reply({ content: `Error: ${outcome.reason}`, ephemeral: true });
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
        await interaction.followUp({ content: outcome.note, ephemeral: true });
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
      await interaction.reply({ content: 'Already handled.', ephemeral: true });
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
    }
  }

  /** Report a command result on a button interaction that has already been acknowledged via
   *  `update` — must use `followUp`, not `reply`. */
  private async followUp(interaction: ButtonInteraction, result: CommandResult): Promise<void> {
    if (result.kind === 'embed') {
      await interaction.followUp({ embeds: [result.embed], ephemeral: true });
    } else if (result.kind === 'text') {
      await interaction.followUp({ content: result.text, ephemeral: true });
    } else {
      await interaction.followUp({ content: `Error: ${result.message}`, ephemeral: true });
    }
  }

  private async reply(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    result: CommandResult,
  ): Promise<void> {
    if (result.kind === 'embed') {
      await interaction.reply({ embeds: [result.embed], ephemeral: true });
    } else if (result.kind === 'text') {
      await interaction.reply({ content: result.text, ephemeral: true });
    } else {
      await interaction.reply({ content: `Error: ${result.message}`, ephemeral: true });
    }
  }
}
