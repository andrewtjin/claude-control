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
import { createLogger } from '@claude-control/shared-protocol';
import {
  Vault,
  defaultPaths,
  defaultProtector,
  type Logger,
  type Paths,
  type Protector,
} from '@claude-control/switch-engine';
import {
  AccountProbe,
  AttributionJournal,
  AutoSwitcher,
  ControlPlaneClient,
  ControlPlaneRejectionError,
  DEFAULT_SECRET_HEADER,
  Daemon,
  HeartbeatWriter,
  HookReceiver,
  Store,
  UsagePoller,
  buildDaemonHookSpecs,
  hookEndpointPath,
  hookForwarderPath,
  hookSecretPath,
  installHooks,
  readHookEndpoint,
  readTranscriptTurns,
  writeHookForwarder,
  loadOrCreateHookSecret,
  writeHookEndpoint,
  type DaemonIdentity,
  type IdentityStore,
} from '@claude-control/daemon';
import { createAgentSdkClient, createSessionManager } from '@claude-control/session-runtime';
import type { AgentSdkClient } from '@claude-control/session-runtime';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { createCachedUsageReader } from './cachedUsageReader.js';
import { createPollTokenGetter } from './pollTokenGetter.js';
import {
  daemonConfigPath,
  daemonSettingsPath,
  readDaemonConfigFile,
  resolveDaemonConfig,
  writeSettingsReport,
} from './settings.js';
import { crashLogPath, installCrashLogging } from './daemonSupervise.js';
import {
  acquireInstanceLock,
  probePredecessorEndpoint,
  releaseInstanceLock,
  DaemonAlreadyRunningError,
} from './daemonInstanceLock.js';

/** Token considered unusable for polling within this window before expiry — the poller then
 *  falls back to tier-0 rather than racing the expiry mid-request. */
const POLL_TOKEN_MIN_TTL_MS = 60_000;

/** The one stream every logger in this process renders to.
 *
 *  A foreground daemon writes nothing but log — it has no command output to keep a pipe clean
 *  for — and `cctl daemon run > daemon.log` is a documented way to capture it, so ALL of it has
 *  to be on the redirected stream. This process builds two loggers (its own, below, and the
 *  switch engine's, through `buildEngine`); naming their destination once is what stops them
 *  drifting onto different streams and splitting the log in half. */
const DAEMON_LOG_SINK = process.stdout;

export interface DaemonRunOptions {
  pair?: string;
  relay?: string;
  /** Hop accounts automatically when the active one runs low. ON by default; false is the
   *  explicit `--no-auto-switch` opt-out and undefined means no flag (CCTL_AUTOSWITCH or the
   *  default decides). Tunables via env: CCTL_AUTOSWITCH_TRIGGER_PCT,
   *  CCTL_AUTOSWITCH_MIN_SESSION_LEFT_PCT, CCTL_AUTOSWITCH_COOLDOWN_MS. */
  autoSwitch?: boolean;
  /** With auto-switch: also hop toward whichever account's weekly quota expires soonest,
   *  even while the active one is healthy. ON by default; false is `--no-greedy`, undefined
   *  means no flag (CCTL_AUTOSWITCH_GREEDY or the default decides). */
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
        const json = (await protector.unprotect(encrypted.trim())).toString('utf8');
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
      await writeFile(filePath, await protector.protect(plaintext), 'utf8');
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
            'active account - confirm the switch engine activated it before spawn',
        ),
    });
}

/** Assemble and start the daemon; resolves once the process-level guards (crash log, instance
 *  lock) and the heartbeat are up and `daemon.start()` has been launched. Local readiness —
 *  receiver bind, endpoint publish, hook install — completes asynchronously inside start(),
 *  all BEFORE its control-plane connect(), which by design can hang indefinitely and is
 *  deliberately never awaited here. The process then stays alive on the hook receiver's
 *  server + the control-plane socket until Ctrl+C. */
export async function runDaemon(options: DaemonRunOptions): Promise<void> {
  const paths: Paths = defaultPaths();
  const dataDir = dirname(paths.vaultDir);
  // Last-breath crash visibility: the daemon died silently once and nothing said why or
  // restarted it. Whatever kills this process from here on leaves a line in daemon-crash.log
  // and a non-zero exit for `cctl daemon supervise` to answer with a respawn.
  installCrashLogging(crashLogPath(dataDir));
  // Single-instance guard: a second concurrent `daemon run` (a manual run while `daemon
  // supervise` already has one, or two supervisors) would otherwise fight the first over
  // hook-endpoint.json, the settings.json hook installs, the hook secret, and daemon.db — all
  // four get corrupted by the loser writing over the winner mid-run. Acquired before any of
  // that state is touched, and specifically BEFORE the refusal case ever reaches pino/log
  // setup, so a refused start prints one clean line and exits rather than looking like it
  // partially started. `cctl daemon supervise` needs no equivalent: its child process is the
  // one that holds this lock.
  try {
    await acquireInstanceLock(dataDir);
  } catch (err) {
    if (err instanceof DaemonAlreadyRunningError) fail(err.message);
    throw err; // an unexpected IO error here is a real failure, not a clean refusal
  }
  // Fail-open backstop behind the lock: a daemon that holds NO lock (started before the
  // lock existed, or its lock file was hand-deleted) is invisible to acquireInstanceLock,
  // and running beside it corrupts the same four shared surfaces the lock protects. Its
  // published hook endpoint is the one trace it cannot help leaving — probe it, and refuse
  // to start beside a live answer. See probePredecessorEndpoint for the classification.
  const publishedEndpoint = await readHookEndpoint(hookEndpointPath(dataDir));
  if (publishedEndpoint !== undefined) {
    const probe = await probePredecessorEndpoint(publishedEndpoint.port);
    if (probe === 'serving') {
      await releaseInstanceLock(dataDir);
      fail(
        `another daemon is already serving on port ${publishedEndpoint.port} even though it ` +
          `holds no instance lock (likely started before the lock existed). Stop that ` +
          `process first; if you are sure no daemon is running, delete ` +
          `${hookEndpointPath(dataDir)} and retry.`,
      );
    }
  }
  // The operator's persisted overrides, read here (the edge) so the resolution below stays
  // pure. A missing or malformed file degrades to no overrides, never to a failed start.
  const fileConfig = (await readDaemonConfigFile(daemonConfigPath(paths))) ?? {};

  // One resolution feeds BOTH behavior (the values wired below) and visibility (the rows
  // shipped to the phone and persisted for `cctl settings`) — they cannot drift apart. Resolved
  // BEFORE either logger below, because its `logFilePath` (an explicit CCTL_LOG_FILE, or the
  // resolved `<dataDir>/daemon.log` default — see settings.ts) is the path both loggers must
  // actually write to, not a second default independently guessed here.
  const config = resolveDaemonConfig(
    process.env,
    {
      // Tri-state: an absent flag stays absent so the resolver's env/default chain decides,
      // while an explicit --no- opt-out passes through as false.
      ...(options.autoSwitch !== undefined ? { autoSwitch: options.autoSwitch } : {}),
      ...(options.greedy !== undefined ? { greedy: options.greedy } : {}),
      ...(options.relay !== undefined ? { relay: options.relay } : {}),
    },
    fileConfig,
    dataDir,
  );
  const {
    relayUrl,
    triggerPercent,
    staleTriggerPercent,
    staleAfterMs,
    minSessionHeadroomPct,
    greedyResetMarginMs,
    cooldownMs,
    autoSwitch,
    greedy,
    logFilePath,
    probeUnknown,
    probeTimeoutMs,
  } = config.values;

  // Both loggers this process builds (this one, plus the switch-engine adapter inside
  // buildEngine) must read the SAME CCTL_LOG_FILE, or `cctl daemon run > daemon.log` captures
  // only half the log while the rest silently goes to a file nobody redirected (see
  // buildEngine's own comment). Overriding just that one key on a copy of process.env is what
  // lets the resolved default take effect without every OTHER env-driven knob in this process
  // reading from a stale snapshot instead of the live environment.
  const loggingEnv: NodeJS.ProcessEnv = { ...process.env, CCTL_LOG_FILE: logFilePath };
  const logger: Logger = createLogger({
    defaultLevel: 'info',
    sink: DAEMON_LOG_SINK,
    env: loggingEnv,
  });

  const engine = buildEngine(paths, DAEMON_LOG_SINK, loggingEnv);
  const store = new Store(daemonDbPath(paths));
  const protector = defaultProtector();

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
    // The status-page probe an overloaded (529) usage endpoint triggers, passed explicitly for
    // the same reason `fetch` is: the poller's contract is that every outbound call it can make
    // was handed to it, so a test that wires none can never reach the network by accident. The
    // daemon's own logger rides along because the retry loop is where an upstream outage is
    // visible AT ALL — without a sink here the whole incident happens silently and the log
    // shows nothing but frozen usage numbers.
    overload: { statusFetch: (url, init) => globalThis.fetch(url, init), logger },
    getToken: createPollTokenGetter({
      vault: pollVault,
      engine,
      minTtlMs: POLL_TOKEN_MIN_TTL_MS,
      // Identity invariant: never hand the poller a token that cannot be attributed to the
      // account it is filed under. Registry truth + quarantine go straight to the vault
      // (StoredAccount satisfies the row shape structurally); a quarantine here surfaces
      // through the existing notice reconciler as the guided re-login card.
      identity: {
        lookupAccount: (id) => pollVault.getAccount(id),
        quarantine: (id, reason) => pollVault.quarantine(id, reason),
        verifyOwnership: config.values.identityCheck,
      },
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
    ...(autoSwitch && greedy ? { advisorOptions: { greedyAutoSwitch: true } } : {}),
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
  // while disconnected). The secret is the stable one loaded above, not minted per run — see
  // hookSecret.ts for why that matters.
  const hookReceiver = new HookReceiver({
    store,
    secret: hookSecret,
    emit: (draft) => controlPlaneClient.send(draft),
    daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
    logger,
    forwardNotificationCards: config.values.waitingCards,
    commandOutputCards: config.values.commandOutputCards,
    fullToolOutput: config.values.fullToolOutput,
    // StopFailure warn cards ride the same umbrella switch as the managed sessions' retry
    // loop: both are "survive transient API errors" behavior (CCTL_AUTO_CONTINUE).
    apiErrorCards: config.values.autoContinue,
    // A managed session is recognized by either its record id or the SDK session id its hooks
    // report (persisted as the record's resume anchor on session_init).
    isManagedSession: (sessionId) =>
      sessionManager.list().some((r) => r.id === sessionId || r.resumeId === sessionId),
    ...(config.values.permissionHoldMs !== undefined
      ? { permissionHoldMs: config.values.permissionHoldMs }
      : {}),
    ...(config.values.questionHoldMs !== undefined
      ? { questionHoldMs: config.values.questionHoldMs }
      : {}),
  });

  // Auto-switch (greedy) is the DEFAULT: a flag-less daemon — including the installed logon
  // task, which carries no flags — hops before the wall without any setup. Opt out per run
  // with --no-auto-switch, or persistently with CCTL_AUTOSWITCH=0. It calls the engine's
  // normal activate() path, so the human-plausible cadence guard applies to auto-hops too,
  // and it reports every attempt to the phone through the same switch.result push as /switch.
  const autoSwitcher = autoSwitch
    ? new AutoSwitcher({
        activate: (accountId, options) => engine.activate(accountId, options),
        notify: (payload) =>
          controlPlaneClient.send({
            type: 'switch.result',
            payload,
            daemonId: controlPlaneClient.getIdentity()?.daemonId ?? 'unpaired',
          }),
        policy: {
          ...(triggerPercent !== undefined ? { triggerPercent } : {}),
          ...(staleTriggerPercent !== undefined ? { staleTriggerPercent } : {}),
          ...(staleAfterMs !== undefined ? { staleAfterMs } : {}),
          ...(minSessionHeadroomPct !== undefined ? { minSessionHeadroomPct } : {}),
          ...(greedyResetMarginMs !== undefined ? { greedyResetMarginMs } : {}),
          ...(greedy ? { greedy } : {}),
        },
        ...(cooldownMs !== undefined ? { cooldownMs } : {}),
        logger,
      })
    : undefined;

  // The eager activation probe. Only built alongside the auto-switcher: it spends a real turn
  // purely to make an account TARGETABLE, which is worth nothing when nothing is choosing
  // targets. This is the ONE path that binds an account to its own CLAUDE_CONFIG_DIR — the
  // opposite of the activate-before-spawn model every managed session uses (see
  // makeAgentSdkClientFactory) — and deliberately so: it must run a turn as an account WITHOUT
  // making it live, which is exactly what the config-dir bind buys and what activation cannot.
  // A fresh client per probe, for the same reason sessions get one.
  //
  // NOT ON DARWIN. The whole mechanism rests on the CLI reading credentials out of
  // CLAUDE_CONFIG_DIR, and on macOS it does not — it reads its login Keychain item instead
  // (the same platform fact the keychain-delta capture flows exist for). A probe there would
  // seed files nothing reads and run its turn under whichever account is LIVE, spending that
  // account's quota and attributing it to another. Off is the only honest posture until the
  // per-account bind is verified on a real Mac.
  const accountProbe =
    autoSwitcher && probeUnknown && process.platform !== 'darwin'
      ? new AccountProbe({
          vault: pollVault,
          engine,
          configDirRoot: join(dataDir, 'probe'),
          createClient: (configDir) =>
            createAgentSdkClient({ configDirForAccount: () => configDir }),
          ...(probeTimeoutMs !== undefined ? { timeoutMs: probeTimeoutMs } : {}),
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
    installHooks: async () => {
      // The forwarder script is (re)written before the hook entries that point at it, so the
      // installed command always has a current script behind it. The command itself is
      // port-independent (the forwarder reads the endpoint file at fire time) and therefore
      // stable across restarts; the secret-header name still fingerprints our entries so the
      // installer replaces earlier generations — including the previous port-embedding curl
      // shape — instead of accumulating them.
      const forwarderPath = hookForwarderPath(dataDir);
      await writeHookForwarder(forwarderPath);
      await installHooks({
        settingsPath,
        hooks: buildDaemonHookSpecs({ secret: hookSecret, forwarderPath }),
        ownedCommandMarker: DEFAULT_SECRET_HEADER,
      });
    },
    // Publish the receiver's actual loopback port so `cctl session register|label|watch` can
    // find this daemon (the port is OS-assigned per run, so it must be published, not derived).
    // Rewritten every start; the shutdown handler removes it so a stopped daemon leaves no
    // stale pointer. The secret file is the auth gate — this only answers "where".
    publishHookEndpoint: (port) => writeHookEndpoint(hookEndpointPath(dataDir), { port }),
    // Absolute token counts for `/stats` on the phone, read from the transcripts Claude Code
    // writes under this same config dir. Local file reads only; the bot receives only the sums.
    scanTranscripts: (sinceMs) => readTranscriptTurns({ claudeDir: paths.claudeDir, sinceMs }),
    // Real SDK adapter with the daemon's logger on the accountId fall-through — see
    // makeAgentSdkClientFactory for the shared-config/hot-swap tradeoff behind its deps.
    createAgentSdkClient: makeAgentSdkClientFactory(logger),
    // Present only when the operator hasn't opted out — the Daemon stamps it onto every
    // managed spawn/resume, and its absence IS the off switch (no policy, no retries).
    ...(config.values.autoContinue
      ? {
          autoContinue: {
            ...(config.values.autoContinueMaxAttempts !== undefined
              ? { maxAttempts: config.values.autoContinueMaxAttempts }
              : {}),
          },
        }
      : {}),
    ...(autoSwitcher ? { autoSwitcher } : {}),
    ...(accountProbe ? { accountProbe } : {}),
    settingsReport,
    logger,
  });

  // Liveness signal for `cctl daemon status` (see heartbeat.ts) — a separate process, possibly
  // reading this long after the daemon that wrote it has exited, so a file is the only channel
  // that survives a hard crash. Started as soon as this process is up (not gated on the
  // control-plane connection — see the comment below), stopped on shutdown.
  const heartbeat = new HeartbeatWriter(join(dataDir, 'daemon-heartbeat.json'), {
    onError: (err) => logger.warn({ err }, 'could not write the daemon heartbeat'),
  });

  // `daemon.start()` awaits the control-plane connect(), which on a down/silent relay never
  // resolves nor rejects (it reconnects internally forever). Heartbeat, endpoint publish, hook
  // install, and the poll loop (which drives auto-switching) are this process's own local work
  // and must not wait behind the remote promise — start() runs ALL of them before its connect()
  // await, so kicking it off in the background keeps a local-only daemon fully functional:
  // accounts keep being polled and auto-switched even while the relay is unreachable or has
  // refused us. A rejection is one of two very different things:
  //   - A TERMINAL control-plane rejection (not paired, refused pairing code, revoked token /
  //     protocol mismatch — see ControlPlaneRejectionError): the daemon itself is healthy and
  //     all its local surfaces already came up, so it keeps running local-only with the
  //     operator-facing reason logged. Exiting here would make `cctl daemon supervise`
  //     respawn-storm against a rejection no restart can fix — the client marks these
  //     terminal precisely so nothing retries them.
  //   - Anything else is a pre-connect subsystem failure (recovery, receiver bind, sqlite) —
  //     that daemon is a zombie the healthz probe may never flag (no endpoint file reads as
  //     vacuously healthy), so it must DIE loudly for supervise to answer with a respawn,
  //     exactly as a synchronous startup failure always did.
  void daemon.start().catch((err: unknown) => {
    if (err instanceof ControlPlaneRejectionError) {
      logger.error({ err }, 'control plane refused this daemon; running local-only');
      return;
    }
    logger.error({ err }, 'daemon failed to start');
    process.exit(1);
  });

  heartbeat.start();

  process.stdout.write(
    `Daemon running (relay: ${relayUrl}${autoSwitcher ? `, auto-switch: on${greedy ? ' (greedy)' : ''}` : ''}). Ctrl+C to stop.\n`,
  );

  const shutdown = (): void => {
    process.stdout.write('Stopping daemon...\n');
    heartbeat.stop();
    void daemon
      .stop()
      .catch(() => {})
      // Remove the published endpoint so a `cctl session` command run against a stopped daemon
      // fails fast with "start the daemon" rather than racing a dead port. Best-effort.
      .then(() => rm(hookEndpointPath(dataDir), { force: true }).catch(() => {}))
      // Free the instance lock so a subsequent `daemon run` doesn't have to wait for the
      // liveness check to notice this pid is gone. Best-effort, and guarded internally (only
      // deletes if it still records OUR pid) — a crash instead of a clean Ctrl+C skips this,
      // which is fine: the next start's liveness check treats the leftover file as stale.
      .then(() => releaseInstanceLock(dataDir).catch(() => {}))
      .then(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
