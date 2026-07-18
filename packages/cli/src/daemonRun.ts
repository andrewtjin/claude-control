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
  DEFAULT_SECRET_HEADER,
  Daemon,
  HookReceiver,
  Store,
  UsagePoller,
  buildDaemonHookSpecs,
  hookEndpointPath,
  hookSecretPath,
  installHooks,
  loadOrCreateHookSecret,
  writeHookEndpoint,
  type DaemonIdentity,
  type IdentityStore,
} from '@claude-control/daemon';
import { createAgentSdkClient, createSessionManager } from '@claude-control/session-runtime';
import type { AgentSdkClient } from '@claude-control/session-runtime';
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

/**
 * Factory for the real Agent SDK client (live boundary) — one FRESH client per managed session,
 * because each session owns its own query lifecycle (a shared instance would cross-wire
 * `interrupt`/`resolvePermission` between sessions; see session-runtime's
 * ResumeOrphanOptions). Exported for its colocated test; the rest of runDaemon is
 * untestable assembly.
 *
 * DECISION — no `configDirForAccount` is injected here, on purpose. Binding per-account
 * CLAUDE_CONFIG_DIRs would give per-session credential isolation, but it forgoes the
 * project's single-shared-~/.claude design (the CLI reads some config outside
 * CLAUDE_CONFIG_DIR, so per-account config dirs don't isolate) and with it credential
 * HOT-SWAP: a `cctl switch` on the PC rewrites the shared live credentials that running
 * sessions read per-request, whereas a
 * session pinned to its own config dir would never see the swap. So sessions inherit
 * whichever account the switch engine last ACTIVATED (activate-before-spawn model),
 * `accountId` stays an attribution tag rather than a credential selector, and a spawn whose
 * accountId was never activated is made LOUD through the daemon's logger instead of running
 * silently mis-attributed.
 */
export function makeAgentSdkClientFactory(logger: Logger): () => AgentSdkClient {
  return () =>
    createAgentSdkClient({
      onUnboundAccountId: (accountId) =>
        logger.warn(
          { accountId },
          'session accountId is not bound to a config dir; it runs under the globally ' +
            'active account — confirm the switch engine activated it before spawn',
        ),
    });
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
    // Active-id via the ENGINE, not the raw vault: the registry can lag an external `/login`
    // (see SwitchEngine.getActiveId), which would blind tier-0 for the truly-live account.
    getCachedUsage: createCachedUsageReader({
      vault: {
        getActiveId: () => engine.getActiveId(),
        getAccount: (id) => pollVault.getAccount(id),
      },
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

  // The hook secret must be STABLE across restarts: it is baked into the curl commands
  // installHooks() writes into settings.json, so a fresh per-run secret would 401 every
  // previously-installed hook and leave a dead curl line per restart. Generated once,
  // DPAPI-encrypted beside daemon-identity.enc, re-read every run. A later `cctl session` CLI
  // reads the SAME file (read-only) to authenticate to this receiver — hence the load/store
  // helper lives in the daemon package (see hookSecret.ts's sharing contract). Both processes
  // derive the path from `hookSecretPath(dataDir)`.
  const hookSecret = await loadOrCreateHookSecret({
    filePath: hookSecretPath(dataDir),
    protector,
  });

  // The receiver forwards hook envelopes out through the client (which buffers to its outbox
  // while disconnected).
  const hookReceiver = new HookReceiver({
    store,
    secret: hookSecret,
    emit: (draft) => controlPlaneClient.send(draft),
    daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
    logger,
    forwardNotificationCards: config.values.waitingCards,
    commandOutputCards: config.values.commandOutputCards,
    fullToolOutput: config.values.fullToolOutput,
    // A managed session is recognized by either its record id or the SDK session id its hooks
    // report (persisted as the record's resume anchor on session_init).
    isManagedSession: (sessionId) =>
      sessionManager.list().some((r) => r.id === sessionId || r.resumeId === sessionId),
    ...(config.values.permissionHoldMs !== undefined
      ? { permissionHoldMs: config.values.permissionHoldMs }
      : {}),
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

  // Which profile gets hooks installed: the design uses a SINGLE shared ~/.claude for every
  // account (per-account config dirs don't isolate — the CLI reads some config outside them),
  // so there is exactly ONE user-level settings.json and it covers every account the daemon
  // rotates through. `paths.claudeDir` honors CLAUDE_CONFIG_DIR, so this is the same file the
  // CLI actually reads settings from. The Daemon calls this AFTER binding the receiver, with
  // the real port, and swallows any failure (unwritable settings.json) so startup never dies.
  const settingsPath = join(paths.claudeDir, 'settings.json');

  const daemon = new Daemon({
    store,
    switchEngine: engine,
    sessionManager,
    poller,
    attributionJournal,
    hookReceiver,
    controlPlaneClient,
    installHooks: (port) =>
      installHooks({
        settingsPath,
        hooks: buildDaemonHookSpecs({ port, secret: hookSecret }),
        // The receiver's port is OS-assigned per run, so each restart rewrites the curl
        // commands. The secret-header name is the port-independent fingerprint that lets the
        // installer replace its own previous-run entry instead of appending one per restart.
        ownedCommandMarker: DEFAULT_SECRET_HEADER,
      }),
    // Publish the receiver's actual loopback port so `cctl session register|label|watch` can
    // find this daemon (the port is OS-assigned per run, so it must be published, not derived).
    // Rewritten every start; the shutdown handler removes it so a stopped daemon leaves no
    // stale pointer. The secret file is the auth gate — this only answers "where".
    publishHookEndpoint: (port) => writeHookEndpoint(hookEndpointPath(dataDir), { port }),
    // Real SDK adapter with the daemon's logger on the accountId fall-through — see
    // makeAgentSdkClientFactory for the shared-config/hot-swap tradeoff behind its deps.
    createAgentSdkClient: makeAgentSdkClientFactory(logger),
    ...(autoSwitcher ? { autoSwitcher } : {}),
    settingsReport,
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
      // Remove the published endpoint so a `cctl session` command run against a stopped daemon
      // fails fast with "start the daemon" rather than racing a dead port. Best-effort.
      .then(() => rm(hookEndpointPath(dataDir), { force: true }).catch(() => {}))
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
