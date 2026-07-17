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
  Vault,
  defaultPaths,
  defaultProtector,
  type Logger,
  type Paths,
  type Protector,
} from '@claude-control/switch-engine';
import {
  AttributionJournal,
  AutoSwitcher,
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
import { createPollTokenGetter } from './pollTokenGetter.js';

const DEFAULT_RELAY_URL = 'ws://127.0.0.1:8765';

/** Token considered unusable for polling within this window before expiry — the poller then
 *  falls back to tier-0 rather than racing the expiry mid-request. */
const POLL_TOKEN_MIN_TTL_MS = 60_000;

export interface DaemonRunOptions {
  pair?: string;
  relay?: string;
  /** Opt-in `--auto-switch`: hop accounts automatically when the active one runs low.
   *  Tunables via env: CCTL_AUTOSWITCH_TRIGGER_PCT, CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT,
   *  CCTL_AUTOSWITCH_COOLDOWN_MS, CCTL_AUTOSWITCH_GREEDY. */
  autoSwitch?: boolean;
  /** Opt-in `--greedy` (requires --auto-switch): also hop toward whichever account's
   *  weekly quota expires soonest, even while the active one is healthy. */
  greedy?: boolean;
}

/** A positive number from the environment, or undefined when unset/unparseable — an env
 *  typo silently falling back to the default beats a daemon that refuses to start. */
function envNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** A boolean flag from the environment: 1/true/yes/on (any case) means on; anything else —
 *  including unset — means off. Same typo-tolerance stance as envNumber. */
function envFlag(name: string): boolean {
  const raw = process.env[name]?.trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
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
  const protector = defaultProtector();

  // An explicit --pair means "adopt a NEW identity", so any previously adopted one is
  // discarded first — otherwise the client would see a stored identity and skip pairing.
  const identityPath = join(dataDir, 'daemon-identity.enc');
  if (options.pair) await rm(identityPath, { force: true });
  const identityStore = dpapiIdentityStore(identityPath, protector);

  // The poller reads tokens straight from the vault WITHOUT switching. When an idle
  // account's vault token has expired, the getter asks the ENGINE to refresh it — inside the
  // same locked refresh-and-persist path activate() uses (single-use refresh tokens are never
  // consumed outside that lock) — then retries the read once. Attempts are rate-limited per
  // account (1h floor, backoff on failure); a failure still falls back to tier-0, with the
  // reason surfaced on that account's snapshot entry.
  const pollVault = new Vault(paths.vaultDir, protector);
  const poller = new UsagePoller({
    fetch: (url, init) => globalThis.fetch(url, init),
    getToken: createPollTokenGetter({
      vault: pollVault,
      engine,
      minTtlMs: POLL_TOKEN_MIN_TTL_MS,
    }),
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

  // Auto-switch is strictly opt-in (`--auto-switch`): unattended account hops are a policy
  // decision the owner makes explicitly, never a default. It calls the engine's normal
  // activate() path, so the human-plausible cadence guard applies to auto-hops too, and it
  // reports every attempt to the phone through the same switch.result push as /switch.
  const triggerPercent = envNumber('CCTL_AUTOSWITCH_TRIGGER_PCT');
  const minSessionHeadroomPct = envNumber('CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT');
  const cooldownMs = envNumber('CCTL_AUTOSWITCH_COOLDOWN_MS');
  // Greedy burn-back is on via the --greedy flag OR the env var — either signal opts in.
  const greedy = options.greedy === true || envFlag('CCTL_AUTOSWITCH_GREEDY');
  const autoSwitcher = options.autoSwitch
    ? new AutoSwitcher({
        activate: (accountId) => engine.activate(accountId),
        notify: (payload) =>
          controlPlaneClient.send({
            type: 'switch.result',
            payload,
            daemonId: controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
          }),
        policy: {
          ...(triggerPercent !== undefined ? { triggerPercent } : {}),
          ...(minSessionHeadroomPct !== undefined ? { minSessionHeadroomPct } : {}),
          ...(greedy ? { greedy } : {}),
        },
        ...(cooldownMs !== undefined ? { cooldownMs } : {}),
        logger,
      })
    : undefined;

  const daemon = new Daemon({
    store,
    switchEngine: engine,
    sessionManager,
    poller,
    attributionJournal,
    hookReceiver,
    controlPlaneClient,
    ...(autoSwitcher ? { autoSwitcher } : {}),
    logger,
  });

  await daemon.start();
  process.stdout.write(
    `Daemon running (relay: ${relayUrl}${autoSwitcher ? `, auto-switch: on${greedy ? ' (greedy)' : ''}` : ''}). Ctrl+C to stop.\n`,
  );

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
