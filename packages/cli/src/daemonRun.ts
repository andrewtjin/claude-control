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
// OAuth tokens, useless if copied off this machine/user. The hook secret (see hookSecret.ts)
// gets the identical treatment for the identical reason.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import pino from 'pino';
import {
  Vault,
  acquireLock,
  defaultPaths,
  defaultProtector,
  LockTimeoutError,
  type Lock,
  type Logger,
  type Paths,
  type Protector,
} from '@claude-control/switch-engine';
import {
  AttributionJournal,
  AutoSwitcher,
  ControlPlaneClient,
  Daemon,
  HeartbeatWriter,
  HookReceiver,
  Store,
  UsagePoller,
  buildDaemonHookSpecs,
  installHooks,
  loadOrCreateHookSecret,
  type DaemonIdentity,
  type IdentityStore,
} from '@claude-control/daemon';
import { createSessionManager } from '@claude-control/session-runtime';
import { buildEngine, daemonDbPath } from './context.js';
import { createCachedUsageReader } from './cachedUsageReader.js';
import { createPollTokenGetter } from './pollTokenGetter.js';
import { daemonSettingsPath, resolveDaemonConfig, writeSettingsReport } from './settings.js';

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

  // Second-instance guard, acquired before any other IO (in particular, before the sqlite
  // store below is opened): the daemon is a per-machine singleton — its Scheduled Task, hook
  // receiver, and control-plane identity all assume exactly one running copy, and two writers
  // on the same daemon.db would otherwise fail unpredictably at the FIRST concurrent write
  // rather than up front with a clear reason. This is a SEPARATE lock directory from
  // switch-engine's credential lock (held only for the duration of one activate()/recover()
  // call) — reusing that one for the daemon's whole lifetime would starve every `cctl switch`
  // while the daemon is up. Reusing `acquireLock`'s mkdir-atomic + stale-pid-reclaim primitive
  // here means a crashed daemon's lock self-heals exactly like the credential lock does. A
  // short timeout: a live holder is not going to let go, so waiting out the credential lock's
  // ~15s default would just make a doomed second launch feel hung.
  let instanceLock: Lock;
  try {
    instanceLock = await acquireLock(join(dataDir, 'daemon-instance.lock'), Date.now, {
      timeoutMs: 1_000,
      pollMs: 100,
    });
  } catch (err) {
    if (err instanceof LockTimeoutError) {
      throw new Error(
        'a cctl daemon is already running on this machine (see `cctl daemon status`); ' +
          'stop it before starting another.',
      );
    }
    throw err;
  }

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

  // One resolution feeds BOTH behavior (the values wired below) and visibility (the rows
  // shipped to the phone and persisted for `cctl settings`) — they cannot drift apart.
  const config = resolveDaemonConfig(process.env, {
    autoSwitch: options.autoSwitch === true,
    greedy: options.greedy === true,
    ...(options.relay !== undefined ? { relay: options.relay } : {}),
  });
  const { relayUrl, triggerPercent, minSessionHeadroomPct, cooldownMs, greedy } = config.values;
  const settingsReport = { startedAtMs: Date.now(), settings: config.rows };
  // Best-effort: the report is purely informational, so a write failure must not stop the
  // daemon from starting.
  await writeSettingsReport(daemonSettingsPath(paths), settingsReport).catch((err: unknown) => {
    logger.warn({ err }, 'could not persist the effective-settings report');
  });

  // An explicit --pair means "adopt a NEW identity", so any previously adopted one is
  // discarded first — otherwise the client would see a stored identity and skip pairing.
  const identityPath = join(dataDir, 'daemon-identity.enc');
  if (options.pair) await rm(identityPath, { force: true });
  const identityStore = dpapiIdentityStore(identityPath, protector);

  // Stable across restarts (see hookSecret.ts) — minted once, then reused for as long as this
  // file decrypts, so the curl command `installHooks` writes into settings.json keeps working
  // after every future daemon restart instead of 401ing until it's reinstalled.
  const hookSecretPath = join(dataDir, 'hook-secret.enc');
  const hookSecret = await loadOrCreateHookSecret(hookSecretPath, protector);

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
    // Tier-0 cache lives in the live ~/.claude.json — served only when it provably belongs
    // to the account being polled (active + accountUuid match; see cachedUsageReader.ts).
    getCachedUsage: createCachedUsageReader({
      vault: pollVault,
      claudeJsonPath: paths.claudeJsonPath,
    }),
    // Greedy-aware advice: when the daemon itself executes the burn plan, the plan's
    // wording turns descriptive instead of telling the user to do it by hand.
    ...(options.autoSwitch && greedy ? { advisorOptions: { greedyAutoSwitch: true } } : {}),
  });

  const attributionJournal = new AttributionJournal({ store, vaultDir: paths.vaultDir });
  const sessionManager = createSessionManager({ stateDir: join(dataDir, 'sessions') });

  const controlPlaneClient = new ControlPlaneClient({
    url: relayUrl,
    identityStore,
    store,
    hostLabel: hostname(),
    logger,
    ...(options.pair ? { pairingCode: options.pair } : {}),
  });

  // The receiver forwards hook envelopes out through the client (which buffers to its outbox
  // while disconnected). The secret is the stable one loaded above, not minted per run — see
  // hookSecret.ts for why that matters.
  const hookReceiver = new HookReceiver({
    store,
    secret: hookSecret,
    emit: (draft) => controlPlaneClient.send(draft),
    daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
  });

  // Auto-switch is strictly opt-in (`--auto-switch`): unattended account hops are a policy
  // decision the owner makes explicitly, never a default. It calls the engine's normal
  // activate() path, so the human-plausible cadence guard applies to auto-hops too, and it
  // reports every attempt to the phone through the same switch.result push as /switch.
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
    settingsReport,
    logger,
  });

  // Liveness signal for `cctl daemon status` (see heartbeat.ts) — a separate process, possibly
  // reading this long after the daemon that wrote it has exited, so a file is the only channel
  // that survives a hard crash. Started once the daemon is actually up, stopped on shutdown.
  const heartbeat = new HeartbeatWriter(join(dataDir, 'daemon-heartbeat.json'), {
    onError: (err) => logger.warn({ err }, 'could not write the daemon heartbeat'),
  });

  await daemon.start();
  heartbeat.start();

  // Installed AFTER start() (not before) because `daemon.start()` is what actually binds the
  // hook receiver's port — an OS-assigned ephemeral port that's different on every run, so
  // this has to happen every start, not just first-run setup. installHooks' managed-marker
  // pruning (see hookInstaller.ts) makes repeating it idempotent and self-healing: it replaces
  // last run's now-dead port/secret without touching any other tool's hooks. Best-effort — a
  // profile the daemon can't write to must not stop an otherwise-healthy daemon from serving
  // already-connected clients; the setup wizard surfaces install failures explicitly.
  const hookPort = hookReceiver.getPort();
  if (hookPort !== undefined) {
    await installHooks({
      settingsPath: join(paths.claudeDir, 'settings.json'),
      hooks: buildDaemonHookSpecs({ port: hookPort, secret: hookSecret }),
    }).catch((err: unknown) => {
      logger.warn({ err }, 'could not install hooks into settings.json');
    });
  } else {
    logger.warn('hook receiver has no bound port after start(); skipped installing hooks');
  }

  process.stdout.write(
    `Daemon running (relay: ${relayUrl}${autoSwitcher ? `, auto-switch: on${greedy ? ' (greedy)' : ''}` : ''}). Ctrl+C to stop.\n`,
  );

  const shutdown = (): void => {
    process.stdout.write('Stopping daemon...\n');
    heartbeat.stop();
    void daemon
      .stop()
      .catch(() => {})
      .then(() => instanceLock.release())
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
