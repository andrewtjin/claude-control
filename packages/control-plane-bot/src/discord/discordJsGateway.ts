// Real discord.js wiring: login, slash-command registration, interaction routing, and
// pushing daemon-originated envelopes to the owning user's DMs.
//
// WET-GATED: `start()` opens a real Discord gateway connection and `deliver()` makes real
// Discord API calls — neither can be exercised headlessly, so neither is unit-tested. Every
// piece of actual LOGIC (which handler a command maps to, what an embed looks like) lives in
// commands.ts / embeds.ts and IS unit-tested; this file is deliberately thin glue so the
// untestable surface is as small as it can be.

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  GatewayIntentBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type MessageActionRowComponentBuilder,
  SlashCommandBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Envelope } from '@claude-control/shared-protocol';
import type { DiscordGateway } from './gateway.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import { DaemonStateCache } from './stateCache.js';
import { layeredBar } from './richFormat.js';
import { ensureProgressEmojis, emojiResolverFrom, renderEmojiBar } from './emojiBars.js';
import { renderPush, type RenderedPush } from './pushRender.js';
import {
  buttonIdempotencyKey,
  resolveTap,
  type ButtonSpec,
  type ButtonStyle as ButtonSpecStyle,
  type TapOutcome,
} from './buttons.js';
import { SeenKeys } from './idempotencyGuard.js';
import * as commands from './commands.js';
import type { CommandDeps, CommandResult } from './commands.js';

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
  /** Injectable time source for the two-tap confirm TTL and the idempotency guard's eviction.
   *  Defaults to `Date.now`; overridden in wet-debugging only. */
  clock?: () => number;
}

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
  /** Executed-button dedupe (deliverable 5): a double-tap hits the same key and is dropped. */
  private readonly seenKeys: SeenKeys;

  constructor(options: DiscordJsGatewayOptions) {
    this.logger = options.logger ?? noopLogger;
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
    this.clock = options.clock ?? (() => Date.now());
    this.seenKeys = new SeenKeys({
      max: SEEN_KEYS_MAX,
      ttlMs: SEEN_KEYS_TTL_MS,
      clock: this.clock,
    });
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
   *  connection to Discord's gateway. */
  async start(): Promise<void> {
    if (!this.token) {
      throw new Error('DISCORD_BOT_TOKEN is not set and no token was provided');
    }
    await this.client.login(this.token);
  }

  async stop(): Promise<void> {
    await this.client.destroy();
  }

  /** DiscordGateway.deliver — push one daemon-originated envelope to the owning user. The render
   *  DECISION lives in the pure `renderPush` (pushRender.ts); here we only inflate the plain
   *  ButtonSpecs into discord.js rows and put it on the wire. */
  async deliver(discordUserId: string, envelope: Envelope): Promise<void> {
    this.cache.record(discordUserId, envelope);
    const push = renderPush(envelope);
    if (!push) return; // cache-only: not worth a DM
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(this.toSendOptions(push));
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: failed to DM user');
    }
  }

  /** Inflate a RenderedPush into discord.js send options (content + embeds + component rows).
   *  Return type is inferred from the conditional spreads so no key is ever present-and-undefined
   *  — `exactOptionalPropertyTypes` rejects `embeds: undefined` at the `user.send` boundary. */
  private toSendOptions(push: RenderedPush) {
    return {
      ...(push.content !== undefined ? { content: push.content } : {}),
      ...(push.embeds !== undefined ? { embeds: push.embeds } : {}),
      ...(push.components !== undefined ? { components: this.toRows(push.components) } : {}),
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
      case 'restore':
        // First tap of a destructive action (confirm) or a Cancel/expired one (restore): swap the
        // message's button row in place — no command is sent either way.
        await interaction.update({ components: this.toRows(outcome.rows) });
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
