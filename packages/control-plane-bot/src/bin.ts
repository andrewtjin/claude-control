#!/usr/bin/env node
// Composition root for the shared control-plane bot: the ONLY runnable in this package.
//
// Assembles the tested pieces — BindingStore (persisted), PairingService, DiscordJsGateway,
// RelayServer — reading config exclusively from the environment:
//   DISCORD_BOT_TOKEN   (required) the Discord application's bot token
//   CCTL_RELAY_PORT     (default 8765) WebSocket port daemons connect to
//   CCTL_BOT_STATE_DIR  (default ~/.claude-control-bot) where bindings.json and
//                       session-threads.json live
//   CCTL_LOG_LEVEL      (default info)
//   CCTL_MAX_PENDING_CONNECTIONS  (optional) cap on concurrent unauthenticated daemon sockets;
//                       unset uses the relay's built-in default. Raise it for a self-host serving
//                       many daemons that may reconnect at once.
//
// This file preserves the package's structural zero-credential guarantee (see index.ts): it
// imports only this package's own modules and declared deps — never switch-engine — so the
// bot process remains physically incapable of touching an OAuth token.

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import { BindingStore } from './bindings.js';
import { PairingService } from './pairing.js';
import { RelayServer, type RelaySender } from './relay.js';
import { DiscordJsGateway } from './discord/discordJsGateway.js';
import type { Logger } from './logger.js';

/** Print an error and exit non-zero — the single failure path for startup problems. */
function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
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

  const p = pino({ level: process.env.CCTL_LOG_LEVEL ?? 'info' });
  const logger: Logger = {
    debug: (obj, msg) => p.debug(obj, msg),
    info: (obj, msg) => p.info(obj, msg),
    warn: (obj, msg) => p.warn(obj, msg),
    error: (obj, msg) => p.error(obj, msg),
  };

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
  const gateway = new DiscordJsGateway({ relay: relayRef, pairing, logger, token, stateDir });
  // Spread maxPendingConnections in only when set: exactOptionalPropertyTypes forbids passing an
  // explicit `undefined` for an optional property, so an unset env must omit the key entirely and
  // let RelayServer apply its own default.
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
