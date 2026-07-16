// `cctl daemon run` — the daemon's composition root.
//
// Every subsystem here is a tested library (see packages/daemon); this file only assembles
// them over the real paths and real network config, mirroring daemon.test.ts's wiring with
// production collaborators instead of fakes. Config comes from flags first, env second:
//   --pair <code>    first-run pairing code from Discord's /pair (re-pairs if already paired)
//   --relay <url>    control-plane WebSocket url (or CCTL_RELAY_URL; default local bot)
//
// SECURITY: the daemon's control-plane identity (daemonId + daemonToken) is a bearer
// credential, so it is persisted DPAPI-encrypted beside the vault — same at-rest posture as
// OAuth tokens, useless if copied off this machine/user.

import { randomUUID } from 'node:crypto';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import {
  DpapiProtector,
  Vault,
  defaultPaths,
  type Logger,
  type Paths,
  type Protector,
} from '@claude-control/switch-engine';
import {
  AttributionJournal,
  ControlPlaneClient,
  Daemon,
  HookReceiver,
  Store,
  UsagePoller,
  type DaemonIdentity,
  type IdentityStore,
} from '@claude-control/daemon';
import { createSessionManager } from '@claude-control/session-runtime';
import { buildEngine, daemonDbPath } from './context.js';

const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8765';

/** Token considered unusable for polling within this window before expiry — the poller then
 *  falls back to tier-0 rather than racing the expiry mid-request. */
const POLL_TOKEN_MIN_TTL_MS = 60_000;

export interface DaemonRunOptions {
  pair?: string;
  relay?: string;
}

/**
 * DPAPI-encrypted identity persistence. Corrupt or unreadable state degrades to `undefined`
 * (= "not paired yet") rather than crashing: the recovery path for a broken identity file is
 * simply re-pairing, and the client reports that clearly.
 */
export function dpapiIdentityStore(filePath: string, protector: Protector): IdentityStore {
  return {
    async load(): Promise<DaemonIdentity | undefined> {
      let encrypted: string;
      try {
        encrypted = await readFile(filePath, 'utf8');
      } catch {
        return undefined; // never paired on this machine
      }
      try {
        const json = protector.unprotect(encrypted.trim()).toString('utf8');
        const parsed = JSON.parse(json) as Partial<DaemonIdentity>;
        if (typeof parsed.daemonId !== 'string' || typeof parsed.daemonToken !== 'string') {
          return undefined;
        }
        return { daemonId: parsed.daemonId, daemonToken: parsed.daemonToken };
      } catch {
        return undefined; // corrupt/foreign blob → treat as unpaired
      }
    },
    async save(identity: DaemonIdentity): Promise<void> {
      const plaintext = Buffer.from(JSON.stringify(identity), 'utf8');
      await writeFile(filePath, protector.protect(plaintext), 'utf8');
    },
  };
}

/** Assemble and start the daemon; resolves once it is up (the process then stays alive on
 *  the hook receiver's server + the control-plane socket until Ctrl+C). */
export async function runDaemon(options: DaemonRunOptions): Promise<void> {
  const paths: Paths = defaultPaths();
  const dataDir = dirname(paths.vaultDir);
  const p = pino({ level: process.env.CCTL_LOG_LEVEL ?? 'info' });
  const logger: Logger = {
    debug: (obj, msg) => p.debug(obj, msg),
    info: (obj, msg) => p.info(obj, msg),
    warn: (obj, msg) => p.warn(obj, msg),
    error: (obj, msg) => p.error(obj, msg),
  };

  const engine = buildEngine(paths);
  const store = new Store(daemonDbPath(paths));
  const protector = new DpapiProtector();

  // An explicit --pair means "adopt a NEW identity", so any previously adopted one is
  // discarded first — otherwise the client would see a stored identity and skip pairing.
  const identityPath = join(dataDir, 'daemon-identity.enc');
  if (options.pair) await rm(identityPath, { force: true });
  const identityStore = dpapiIdentityStore(identityPath, protector);

  // The poller reads tokens straight from the vault WITHOUT switching. Peek-only by design:
  // refreshing here would consume single-use refresh tokens outside the engine's locked
  // refresh-and-persist path, so a near-expiry/expired token just falls back to tier-0.
  const pollVault = new Vault(paths.vaultDir, protector);
  const poller = new UsagePoller({
    fetch: (url, init) => globalThis.fetch(url, init),
    getToken: async (accountId) => {
      try {
        const bundle = await pollVault.readBundle(accountId);
        const oauth = bundle.claudeAiOauth;
        if (oauth.expiresAt - Date.now() < POLL_TOKEN_MIN_TTL_MS) return undefined;
        return oauth.accessToken;
      } catch {
        return undefined; // unreadable bundle → tier-0 fallback, never a poll crash
      }
    },
    // Tier-0 cache lives in the live ~/.claude.json, which only ever describes the ACTIVE
    // account — any other account has no cache to fall back to.
    getCachedUsage: async (accountId) => {
      if ((await pollVault.getActiveId()) !== accountId) return undefined;
      try {
        const parsed = JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')) as Record<
          string,
          unknown
        >;
        return parsed['cachedUsageUtilization'];
      } catch {
        return undefined;
      }
    },
  });

  const attributionJournal = new AttributionJournal({ store, vaultDir: paths.vaultDir });
  const sessionManager = createSessionManager({ stateDir: join(dataDir, 'sessions') });

  const relayUrl = options.relay ?? process.env.CCTL_RELAY_URL ?? DEFAULT_RELAY_URL;
  const controlPlaneClient = new ControlPlaneClient({
    url: relayUrl,
    identityStore,
    store,
    hostLabel: hostname(),
    logger,
    ...(options.pair ? { pairingCode: options.pair } : {}),
  });

  // The receiver forwards hook envelopes out through the client (which buffers to its outbox
  // while disconnected). Secret is per-run: hooks are not installed until M3, and the
  // installer will persist a stable secret when it lands.
  const hookReceiver = new HookReceiver({
    store,
    secret: randomUUID(),
    emit: (draft) => controlPlaneClient.send(draft),
    daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
  });

  const daemon = new Daemon({
    store,
    switchEngine: engine,
    sessionManager,
    poller,
    attributionJournal,
    hookReceiver,
    controlPlaneClient,
    logger,
  });

  await daemon.start();
  process.stdout.write(`Daemon running (relay: ${relayUrl}). Ctrl+C to stop.\n`);

  const shutdown = (): void => {
    process.stdout.write('Stopping daemon...\n');
    void daemon
      .stop()
      .catch(() => {})
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
