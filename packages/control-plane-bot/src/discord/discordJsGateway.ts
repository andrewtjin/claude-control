// Real discord.js wiring: login, slash-command registration, interaction routing, and
// pushing daemon-originated envelopes to the owning user's DMs.
//
// WET-GATED: `start()` opens a real Discord gateway connection and `deliver()` makes real
// Discord API calls — neither can be exercised headlessly, so neither is unit-tested. Every
// piece of actual LOGIC (which handler a command maps to, what an embed looks like) lives in
// commands.ts / embeds.ts and IS unit-tested; this file is deliberately thin glue so the
// untestable surface is as small as it can be.

import {
  Client,
  GatewayIntentBits,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Interaction,
  SlashCommandBuilder,
} from 'discord.js';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { isType, type Envelope } from '@claude-control/shared-protocol';
import type { DiscordGateway } from './gateway.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { Logger } from '../logger.js';
import { noopLogger } from '../logger.js';
import { DaemonStateCache } from './stateCache.js';
import { buildPermissionRequestEmbed, buildSwitchResultEmbed } from './embeds.js';
import { emojiTrack, layeredBar, UNICODE_TRACK_STYLE } from './richFormat.js';
import {
  ensureProgressEmojis,
  emojiResolverFrom,
  renderEmojiBar,
  renderEmojiTrack,
} from './emojiBars.js';
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
}

/** One rendered push: text, an embed, or both. `undefined` from `renderPush` means
 *  "cache-only" — the envelope updates DaemonStateCache but is not worth interrupting the
 *  user's phone for (e.g. raw stdout, or a snapshot they can pull with `/usage`). */
interface RenderedPush {
  content?: string;
  embeds?: EmbedBuilder[];
}

/** discord.js-backed DiscordGateway: DMs the bound user for daemon-originated pushes, and
 *  registers/handles the slash-command + button surface, delegating all mapping logic to
 *  commands.ts so this class stays free of protocol knowledge beyond wiring. */
export class DiscordJsGateway implements DiscordGateway {
  private readonly client: Client;
  private readonly cache = new DaemonStateCache();
  private readonly deps: CommandDeps;
  private readonly logger: Logger;
  private readonly token: string | undefined;

  constructor(options: DiscordJsGatewayOptions) {
    this.logger = options.logger ?? noopLogger;
    this.token = options.token ?? process.env.DISCORD_BOT_TOKEN;
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

  /** DiscordGateway.deliver — push one daemon-originated envelope to the owning user. */
  async deliver(discordUserId: string, envelope: Envelope): Promise<void> {
    this.cache.record(discordUserId, envelope);
    const push = this.renderPush(envelope);
    if (!push) return; // cache-only: not worth a DM
    try {
      const user = await this.client.users.fetch(discordUserId);
      await user.send(push);
    } catch (err) {
      this.logger.warn({ err, discordUserId }, 'discord: failed to DM user');
    }
  }

  /** Which pushes are worth a DM, and how to render them. `undefined` means cache-only. */
  private renderPush(envelope: Envelope): RenderedPush | undefined {
    if (isType(envelope, 'permission.request')) {
      const detail = envelope.payload.detail ?? undefined;
      return { embeds: [buildPermissionRequestEmbed(envelope.payload.summary, detail)] };
    }
    if (isType(envelope, 'hook.notification')) {
      return { content: `**${envelope.payload.title}**\n${envelope.payload.body}` };
    }
    if (isType(envelope, 'switch.result')) {
      return { embeds: [buildSwitchResultEmbed(envelope.payload.ok, envelope.payload.message)] };
    }
    if (isType(envelope, 'session.output')) {
      // Raw stdout is far too high-volume to DM; milestones/summaries/errors are worth it.
      if (envelope.payload.kind === 'stdout') return undefined;
      return { content: envelope.payload.text };
    }
    return undefined; // usage.snapshot / session.status / pair.result / etc: cache-only
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

  private async onButton(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    const idempotencyKey = randomUUID();
    // customId encodes "<action>:<argument>", e.g. "switch:acct-123" or "approve:req-456" —
    // set when the button was attached to a pushed embed (see renderPush's callers).
    const [action, arg] = interaction.customId.split(':');
    let result: CommandResult;
    if (action === 'switch' && arg) {
      result = commands.handleSwitch(this.deps, userId, arg, randomUUID(), idempotencyKey);
    } else if (action === 'approve' && arg) {
      result = commands.handleApprove(this.deps, userId, arg, 'once', idempotencyKey);
    } else if (action === 'deny' && arg) {
      result = commands.handleDeny(this.deps, userId, arg, 'once', idempotencyKey);
    } else {
      result = { kind: 'error', message: `unrecognized button: ${interaction.customId}` };
    }
    await this.reply(interaction, result);
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
