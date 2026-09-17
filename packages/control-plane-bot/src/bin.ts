#!/usr/bin/env node
// Composition root for the shared control-plane bot: the ONLY runnable in this package.
//
// Assembles the tested pieces — BindingStore (persisted), PairingService, DiscordJsGateway,
// RelayServer — reading config exclusively from the environment:
//   DISCORD_BOT_TOKEN        (required) the Discord application's bot token
//   CCTL_RELAY_PORT          (default 8765) WebSocket port daemons connect to
//   CCTL_BOT_STATE_DIR       (default ~/.claude-control-bot) where bindings.json,
//                            session-threads.json, session-channel-pins.json and uptime.json
//                            (the availability history behind the status page at `/`) live
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
//   CCTL_MAX_PENDING_PER_PEER  (optional) cap on how many of those one source address may hold,
//                            so no single source can fill the pool. Raise it for a self-host whose
//                            daemons all arrive from one address (a NAT or a proxy that does not
//                            set x-forwarded-for), where they otherwise share one peer's slice.
//
// Discord application prerequisite WHEN CCTL_SESSION_CHANNEL_ID or CCTL_SESSION_CHANNELS is
// set: the privileged MESSAGE CONTENT intent must be enabled in the developer portal — replies
// typed in session threads are read as messages, and requesting the intent without the portal
// toggle rejects the gateway login outright. A DM-only deployment (neither env set) requests
// no privileged intent and needs no portal change; threads a user pins with `/thread-here` on
// such a deployment still deliver output but cannot read replies (see gatewayIntents).
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
import { loadStatusPage } from './statusPage.js';
import { UptimeRecorder } from './uptime.js';
import type { Logger } from './logger.js';

/** Print an error and exit non-zero — the single failure path for startup problems. */
function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** An optional positive-integer knob from the environment, or `undefined` when the operator set
 *  nothing (which means "use the built-in default"). An unset value and a mistyped one are
 *  deliberately NOT the same thing: silently falling back on a typo would leave the operator
 *  believing a ceiling they raised is in force. */
function positiveIntEnv(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    fail(`${name} must be a positive integer, got "${raw}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    fail(
      'DISCORD_BOT_TOKEN is not set. Create a Discord application, add a bot, and export its token.',
    );
  }
  const port = Number(process.env.CCTL_RELAY_PORT ?? 8765);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    fail(`CCTL_RELAY_PORT must be a port number, got "${process.env.CCTL_RELAY_PORT}"`);
  }
  // Optional caps on unauthenticated daemon sockets (see relay.ts): the total, and how many one
  // peer may hold. Unset = the relay's built-in defaults; validated here like the port so a typo
  // fails loudly at startup rather than silently reverting to a default the operator did not pick.
  const maxPendingConnections = positiveIntEnv('CCTL_MAX_PENDING_CONNECTIONS');
  const maxPendingPerPeer = positiveIntEnv('CCTL_MAX_PENDING_PER_PEER');
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
  const gateway = new DiscordJsGateway({
    relay: relayRef,
    pairing,
    logger,
    token,
    stateDir,
    ...(sessionChannelId ? { sessionChannelId } : {}),
    ...(sessionChannels.entries.size > 0 ? { sessionChannelsByUser: sessionChannels.entries } : {}),
  });
  // Loaded before anything listens: a bot whose status page is missing from the image is
  // mis-packaged, and that should fail the start, not surface as a 404 later.
  const statusPage = loadStatusPage();
  // The relay's own availability, served at `/`. It reads the gateway's readiness on every tick,
  // so the Discord component reflects the live connection, not whether login ever succeeded.
  const uptime = new UptimeRecorder({
    path: join(stateDir, 'uptime.json'),
    isDiscordReady: () => gateway.isReady(),
    logger,
  });
  const relay = new RelayServer({
    bindings,
    pairing,
    gateway,
    port,
    logger,
    status: { page: statusPage, report: (live) => uptime.report(live) },
    ...(maxPendingConnections !== undefined ? { maxPendingConnections } : {}),
    ...(maxPendingPerPeer !== undefined ? { maxPendingPerPeer } : {}),
  });
  holder.relay = relay;

  const boundPort = await relay.listen();
  // Availability counts from here: the relay is accepting daemon sockets. The Discord component
  // is sampled only on the recorder's ticks, so the login below has one sample interval of grace
  // before a slow login would open a Discord incident; an ordinary deploy books none.
  await uptime.start();

  const shutdown = (): void => {
    logger.info({}, 'shutting down');
    // The recorder's final tick samples the gateway, so it runs BEFORE the gateway is torn down:
    // client.destroy() flips readiness to false synchronously, and a final tick after that would
    // book a phantom Discord drop against every planned restart. The tick also leaves the
    // clean-shutdown marker, so the next start dates this gap exactly and shows it as planned.
    void uptime
      .stop()
      .catch((err: unknown) => {
        logger.warn({ err }, 'uptime: final tick failed');
      })
      .then(() => Promise.allSettled([gateway.stop(), relay.close()]))
      .then(() => process.exit(0));
  };
  // Registered before the login so a stop signal during it still ends the run cleanly.
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await gateway.start();
  logger.info({ port: boundPort, stateDir }, 'control-plane bot is up');
}

main().catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
