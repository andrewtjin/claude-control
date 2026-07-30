#!/usr/bin/env node
// Composition root for the shared control-plane bot: the ONLY runnable in this package.
//
// Assembles the tested pieces — BindingStore (persisted), PairingService, DiscordJsGateway
// and/or SlackGateway wrapped in a CompositeGateway, RelayServer — reading config exclusively
// from the environment:
//   DISCORD_BOT_TOKEN        (optional) the Discord application's bot token — set to run the
//                            Discord surface
//   SLACK_BOT_TOKEN          (optional) the Slack app's Bot User OAuth token (xoxb-…) — set
//                            together with SLACK_APP_TOKEN to run the Slack surface
//   SLACK_APP_TOKEN          (optional) the Slack app's app-level token with connections:write
//                            (xapp-…), Socket Mode's WebSocket credential — set together with
//                            SLACK_BOT_TOKEN
//                            At least one surface must be configured: either DISCORD_BOT_TOKEN
//                            alone, or both Slack vars together. Setting only one half of the
//                            Slack pair fails fast naming the half that's missing, rather than
//                            starting a surface that can authenticate but never open its socket
//                            (or vice versa). Both surfaces may be set at once — a deployment
//                            can run Discord and Slack side by side, routed by principal (see
//                            compositeGateway.ts).
//   CCTL_RELAY_PORT          (default 8765) WebSocket port daemons connect to
//   CCTL_BOT_STATE_DIR       (default ~/.claude-control-bot) where bindings.json,
//                            session-threads.json and session-channel-pins.json live
//   CCTL_SESSION_CHANNEL_ID  (optional) text channel that hosts per-session private threads
//                            for every paired user WITHOUT a CCTL_SESSION_CHANNELS entry;
//                            unset → those users' session output is delivered by DM
//   CCTL_SESSION_CHANNELS    (optional) per-user overrides, as a comma-separated
//                            <discordUserId>:<channelId> list. Named users get threads in
//                            their own channel; everyone else falls back to
//                            CCTL_SESSION_CHANNEL_ID, or to DM when that is unset. Setting
//                            only this one is the mixed deployment: threads for the operator,
//                            DMs for every other paired user.
//                            Both of these are DEFAULTS: a user's own `/thread-here` outranks
//                            them in both directions (their own channel, or back to DMs), and
//                            that choice lives in session-channel-pins.json. Neither env var
//                            is an access control — they cannot stop someone reading their own
//                            session output — so the operator's real lever over where the bot
//                            may post is the channel's Discord permissions.
//   CCTL_LOG_LEVEL           (default info)
//   CCTL_LOG_FORMAT          (default: pretty on a TTY, json otherwise) 'pretty' or 'json'
//                            overrides the auto-detection either way; see shared-protocol's
//                            createLogger.
//   CCTL_LOG_FILE            (optional) path to also append NDJSON logs to, regardless of
//                            CCTL_LOG_FORMAT — useful since this process's stdout is not a TTY
//                            when run under Docker/Compose and it defaults to json anyway.
//   CCTL_MAX_PENDING_CONNECTIONS  (optional) cap on concurrent unauthenticated daemon sockets;
//                            unset uses the relay's built-in default. Raise it for a self-host
//                            serving many daemons that may reconnect at once.
//
// This file preserves the package's structural zero-credential guarantee (see index.ts): it
// imports only this package's own modules and declared deps — never switch-engine — so the
// bot process remains physically incapable of touching an OAuth token.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from '@claude-control/shared-protocol';
import { BindingStore } from './bindings.js';
import { PairingService } from './pairing.js';
import { RelayServer, type RelaySender } from './relay.js';
import { DiscordJsGateway } from './discord/discordJsGateway.js';
import { parseSessionChannelMap } from './discord/sessionChannels.js';
import { CompositeGateway, type StartableGateway } from './compositeGateway.js';
import { SlackGateway } from './slack/slackGateway.js';
import type { SlackGatewayOptions } from './slack/context.js';
import type { Logger } from './logger.js';
import { resolveSurfaces } from './surfaceConfig.js';

/** Print an error and exit non-zero — the single failure path for startup problems. */
function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  // The env→surface decision — which token(s) are usable, and the exact wording naming a
  // missing half of the Slack pair — lives in surfaceConfig.ts as a pure function, so its full
  // matrix (none/Discord-only/Slack-only/both/half-a-pair, each crossed with an absent vs. an
  // empty-or-whitespace value) is unit-tested without spawning this process. This file's job is
  // only to act on the verdict.
  const surfaces = resolveSurfaces(process.env);
  if ('error' in surfaces) fail(surfaces.error);
  const { discordToken, slack } = surfaces;
  const port = Number(process.env.CCTL_RELAY_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`CCTL_RELAY_PORT must be a port number, got "${process.env.CCTL_RELAY_PORT}"`);
  }
  // Optional cap on concurrent unauthenticated daemon sockets (see relay.ts). Unset = the relay's
  // built-in default; validated here like the port so a typo fails loudly at startup.
  let maxPendingConnections: number | undefined;
  const rawMaxPending = process.env.CCTL_MAX_PENDING_CONNECTIONS;
  if (rawMaxPending !== undefined && rawMaxPending !== '') {
    const parsed = Number(rawMaxPending);
    if (!Number.isInteger(parsed) || parsed < 1) {
      fail(`CCTL_MAX_PENDING_CONNECTIONS must be a positive integer, got "${rawMaxPending}"`);
    }
    maxPendingConnections = parsed;
  }
  const stateDir = process.env.CCTL_BOT_STATE_DIR ?? join(homedir(), '.claude-control-bot');
  mkdirSync(stateDir, { recursive: true });

  const logger: Logger = createLogger({ defaultLevel: 'info' });

  const bindings = new BindingStore(join(stateDir, 'bindings.json'));
  await bindings.load();
  const pairing = new PairingService({ bindings });

  // Gateway and relay reference each other (gateway sends commands through the relay; the
  // relay delivers daemon pushes through the gateway). Break the construction cycle with a
  // late-bound holder: by the time any Discord interaction can fire (after gateway.start(),
  // below), the holder is filled.
  const holder: { relay?: RelayServer } = {};
  const relayRef: RelaySender = {
    sendToUser: (userId, build) =>
      holder.relay
        ? holder.relay.sendToUser(userId, build)
        : { ok: false, error: 'relay not started yet' },
    isOnline: (userId) => holder.relay?.isOnline(userId) ?? false,
  };
  // stateDir makes the session→thread registry durable; omitting it would silently park
  // session-threads.json under the OS temp dir and lose thread routing on reboot.
  // Spread the optional values in only when set: exactOptionalPropertyTypes forbids passing an
  // explicit `undefined` for an optional property, so an unset env must omit the key entirely
  // and let each constructor apply its own default.
  const sessionChannelId = process.env.CCTL_SESSION_CHANNEL_ID;
  // Every malformed pair is reported at once: an operator editing a multi-user map in a .env
  // should not have to restart the bot per typo. Failing at all matters more than it looks —
  // a mistyped id does not crash anything, it just never matches, and that user silently keeps
  // getting DMs, which is precisely the symptom this map exists to fix.
  const sessionChannels = parseSessionChannelMap(process.env.CCTL_SESSION_CHANNELS);
  if (sessionChannels.errors.length > 0) {
    fail(
      `CCTL_SESSION_CHANNELS is malformed (expected "<userId>:<channelId>" pairs separated by commas): ${sessionChannels.errors.join('; ')}`,
    );
  }
  // Built only when its token(s) are set, then always wrapped in a CompositeGateway (even for
  // a Discord-only or Slack-only deployment) so RelayServer has exactly one construction path
  // to depend on — see compositeGateway.ts for why routing lives there instead of as a special
  // case here or in relay.ts. A bare (un-namespaced) id still routes to Discord, so a
  // Discord-only deployment behaves exactly as it would with the gateway passed in directly.
  let discordGateway: StartableGateway | undefined;
  if (discordToken) {
    discordGateway = new DiscordJsGateway({
      relay: relayRef,
      pairing,
      logger,
      token: discordToken,
      stateDir,
      ...(sessionChannelId ? { sessionChannelId } : {}),
      ...(sessionChannels.entries.size > 0
        ? { sessionChannelsByUser: sessionChannels.entries }
        : {}),
    });
  }
  let slackGateway: StartableGateway | undefined;
  if (slack) {
    const slackOptions: SlackGatewayOptions = {
      relay: relayRef,
      pairing,
      logger,
      botToken: slack.botToken,
      appToken: slack.appToken,
      stateDir,
    };
    slackGateway = new SlackGateway(slackOptions);
  }
  const gateway = new CompositeGateway({
    logger,
    ...(discordGateway ? { discord: discordGateway } : {}),
    ...(slackGateway ? { slack: slackGateway } : {}),
  });
  const relay = new RelayServer({
    bindings,
    pairing,
    gateway,
    port,
    logger,
    ...(maxPendingConnections !== undefined ? { maxPendingConnections } : {}),
  });
  holder.relay = relay;

  const boundPort = await relay.listen();
  await gateway.start();
  logger.info({ port: boundPort, stateDir }, 'control-plane bot is up');

  const shutdown = (): void => {
    logger.info({}, 'shutting down');
    void Promise.allSettled([gateway.stop(), relay.close()]).then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
