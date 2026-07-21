// The `cctl` command tree.
//
// Deliberately lightweight: one-shot local commands over the switch engine, plus honest
// placeholders for the daemon-backed remote features so the surface is discoverable. Action
// bodies stay thin — the real logic lives in the engine and the pure render/resolve helpers,
// which are unit-tested; here we only wire and print.

import { Command } from 'commander';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import {
  CadenceError,
  QuarantineError,
  SwitchEngineError,
  UnknownAccountError,
  defaultPaths,
  defaultProtector,
  resolveAccountRef,
  type StoredAccount,
} from '@claude-control/switch-engine';
import {
  ControlPlaneClient,
  Store,
  buildDaemonHookSpecs,
  readHeartbeat,
} from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import {
  computeOutlook,
  computePlan,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
} from '@claude-control/usage-advisor';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { dpapiIdentityStore, runDaemon } from './daemonRun.js';
import {
  installDaemonTask,
  queryDaemonTask,
  resolveCctlShimPath,
  startDaemonTaskNow,
  uninstallDaemonTask,
} from './daemonInstall.js';
import { colorEnabled, detectPalette, outlookStyle } from './ansi.js';
import { renderAccountsTable, renderDaemonStatus, renderUsage, type UsageRow } from './render.js';
import { checkLiveLogin, probeRelay, renderDoctor, runDoctor, summarize } from './doctor.js';
import {
  connectWithTimeout,
  normalizePairingCode,
  renderSetupSummary,
  runSetup,
  PAIRING_TIMEOUT_MS,
  type AutostartResult,
  type PairResult,
  type SetupDeps,
  type SetupSummary,
  type WizardIo,
} from './setup.js';
import {
  daemonSettingsPath,
  DEFAULT_RELAY_URL,
  daemonConfigPath,
  readDaemonConfigFile,
  readSettingsReport,
  renderSettings,
  reportSaysGreedyActive,
  resolveCliSettings,
  resolveDaemonConfig,
  type SettingsSection,
} from './settings.js';

const VERSION = '0.1.0';

/** Build the full `cctl` program. Exported so tests can introspect the command tree. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('cctl')
    .description('claude-control — switch Claude accounts, see usage, control sessions')
    .version(VERSION);

  buildAccountCommands(program);

  program
    .command('switch <ref>')
    .description('activate an account by id or label')
    .option('--force', 'bypass the switch-cadence guard (deliberate override)')
    .action(async (ref: string, opts: { force?: boolean }) => {
      const engine = buildEngine();
      const resolved = resolveAccountRef(await engine.listAccounts(), ref);
      if (!resolved.ok) fail(resolved.message);
      try {
        const result = await engine.activate(resolved.account.id, { force: Boolean(opts.force) });
        const bits = [
          result.wroteCredentials ? 'credentials written' : 'no change',
          result.refreshed ? 'token refreshed' : null,
          result.adoptedPreviousRotation ? 'adopted previous rotation' : null,
        ].filter(Boolean);
        process.stdout.write(`Activated ${resolved.account.label} (${bits.join(', ')}).\n`);
      } catch (err) {
        if (err instanceof QuarantineError)
          fail(`${resolved.account.label} is quarantined; re-login required.`);
        if (err instanceof CadenceError) fail(`${err.message}. Use --force to override.`);
        if (err instanceof UnknownAccountError) fail(err.message);
        throw err;
      }
    });

  program
    .command('recover')
    .description('recover from an interrupted switch (run at startup)')
    .action(async () => {
      const result = await buildEngine().recover();
      process.stdout.write(
        result.recovered
          ? `Recovered: ${result.action}${result.detail ? ` — ${result.detail}` : ''}.\n`
          : 'Nothing to recover.\n',
      );
    });

  program
    .command('usage')
    .description("show usage across all accounts (from the daemon's latest poll)")
    .action(async () => {
      const { accounts, activeId, usageFor } = await readUsageState();
      const rows: UsageRow[] = accounts.map((a) => ({
        label: a.label,
        active: a.id === activeId,
        usage: usageFor(a.id),
      }));
      process.stdout.write(renderUsage(rows, Date.now(), detectPalette()) + '\n');
    });

  program
    .command('timeline')
    .description('5h-session budget per account + when every limit resets, with a usage plan')
    .action(async () => {
      const { accounts, activeId, usageFor } = await readUsageState();
      // Registry data (label/active/quarantined) is authoritative and current; the persisted
      // snapshot only contributes the limits, so a stale snapshot can't misreport which
      // account is live. Accounts without a snapshot still appear (as "unknown").
      const inputs = timelineInputFromWire(
        accounts.map((a) => ({
          accountId: a.id,
          label: a.label,
          active: a.id === activeId,
          quarantined: a.quarantined,
          limits: usageFor(a.id)?.limits ?? [],
        })),
      );
      const outlook = computeOutlook(inputs);
      let text = renderOutlook(outlook, { style: outlookStyle(detectPalette()) });
      // The burn-down plan turns the timeline into advice: what to burn first and what to
      // hold. When the last-started daemon runs greedy auto-switch, the advice matches its
      // descriptive phrasing (the daemon executes the plan; the user doesn't have to).
      if (inputs.length > 0) {
        const greedy = reportSaysGreedyActive(await readSettingsReport(daemonSettingsPath()));
        text +=
          '\n\n' + renderPlanSummary(computePlan(inputs, greedy ? { greedyAutoSwitch: true } : {}));
      }
      process.stdout.write(text + '\n');
    });

  program
    .command('settings')
    .description('show every configurable setting: effective value and where it came from')
    .action(async () => {
      const sections: SettingsSection[] = [
        { title: 'cli (this shell)', rows: resolveCliSettings(process.env, colorEnabled()) },
      ];
      // Prefer the report the daemon persisted at its last start — those are the values it
      // is ACTUALLY running with. Without one, preview what a daemon started from this
      // shell would resolve (flags absent, env + defaults only).
      const report = await readSettingsReport(daemonSettingsPath());
      if (report) {
        const since = new Date(report.startedAtMs).toLocaleString();
        sections.push({ title: `daemon (effective since ${since})`, rows: report.settings });
      } else {
        // The preview must honor config.json too — otherwise it would report 'default' for a
        // relay the daemon will actually take from the file.
        const fileConfig = (await readDaemonConfigFile(daemonConfigPath())) ?? {};
        sections.push({
          title: 'daemon (no daemon has run yet — what `cctl daemon run` would use)',
          rows: resolveDaemonConfig(process.env, {}, fileConfig).rows,
        });
      }
      process.stdout.write(renderSettings(sections, detectPalette()) + '\n');
    });

  program
    .command('doctor')
    .description('check the local environment')
    .action(async () => {
      const checks = await runDoctor(defaultPaths());
      process.stdout.write(renderDoctor(checks, detectPalette()) + '\n');
      const { passed, failed } = summarize(checks);
      process.stdout.write(`\n${passed} ok, ${failed} to look at.\n`);
    });

  program
    .command('setup')
    .description('guided first-run setup: accounts, hooks, relay, Discord pairing, autostart')
    .option('--reconfigure', 're-run every step even when setup already looks complete')
    .option(
      '--relay <url>',
      'relay WebSocket url to pair against (else CCTL_RELAY_URL or the built-in)',
    )
    .action(async (opts: { reconfigure?: boolean; relay?: string }) => {
      const { io, close } = createWizardIo();
      try {
        const outcome = await runSetup(buildSetupDeps(io, opts.relay), {
          reconfigure: Boolean(opts.reconfigure),
        });
        // The wizard prints its own refusal line; only the exit code is set here.
        if (outcome === 'not-interactive') process.exitCode = 1;
      } finally {
        close();
      }
    });

  program
    .command('status')
    .description('at-a-glance: accounts, hooks, relay, daemon, pairing')
    .action(async () => {
      process.stdout.write(renderSetupSummary(await readStatusSummary(), detectPalette()) + '\n');
    });

  // The daemon: the one long-running local process (usage poller, hook receiver, attribution
  // journal, control-plane connection). `--pair` is the first-run on-ramp: run /pair in
  // Discord for a code, then `cctl daemon run --pair <code>`.
  const daemon = program.command('daemon').description('the background daemon');
  daemon
    .command('run')
    .description('run the daemon in the foreground (Ctrl+C to stop)')
    .option('--pair <code>', 'pairing code from Discord /pair (adopts a new identity)')
    .option(
      '--relay <url>',
      // Derived from the constant, never restated, so help text cannot drift from behavior.
      `control-plane WebSocket url (default CCTL_RELAY_URL, relayUrl in config.json, or ${DEFAULT_RELAY_URL})`,
    )
    .option(
      '--auto-switch',
      'when the active account runs low, auto-switch to the account with >=25% of a 5h window left whose weekly quota resets soonest',
    )
    .option(
      '--greedy',
      "with --auto-switch: also hop toward whichever account's weekly quota expires soonest, even while the active one is healthy (burns expiring budget first; env: CCTL_AUTOSWITCH_GREEDY)",
    )
    .action(
      async (opts: { pair?: string; relay?: string; autoSwitch?: boolean; greedy?: boolean }) => {
        // Greedy is a refinement of auto-switch, not a standalone mode — fail loudly rather
        // than let the flag silently do nothing.
        if (opts.greedy && !opts.autoSwitch) fail('--greedy requires --auto-switch.');
        try {
          await runDaemon(opts);
        } catch (err) {
          // A second daemon instance (see daemonRun.ts's instance lock) is the expected
          // failure mode here — surfaced as `error: ...`, never a raw stack trace.
          fail((err as Error).message);
        }
      },
    );

  daemon
    .command('install')
    .description('register a logon Scheduled Task that starts the daemon automatically')
    .action(() => {
      let shimPath: string;
      try {
        shimPath = resolveCctlShimPath();
      } catch (err) {
        fail(`could not resolve the installed cctl location: ${(err as Error).message}`);
      }
      let outcome: ReturnType<typeof installDaemonTask>;
      try {
        outcome = installDaemonTask({ shimPath });
      } catch (err) {
        fail(`could not register the logon task: ${(err as Error).message}`);
      }
      const verb = { created: 'Registered', updated: 'Updated', unchanged: 'Already registered' }[
        outcome
      ];
      process.stdout.write(`${verb} the logon task to run "${shimPath} daemon run" at logon.\n`);
      // Best-effort: get the daemon running now rather than making the user wait for the next
      // logon. A failure here does not undo the (successful) registration above — Task
      // Scheduler will still bring the daemon up next time.
      try {
        startDaemonTaskNow();
        process.stdout.write('Daemon starting now.\n');
      } catch (err) {
        process.stdout.write(
          `Could not start it immediately (${(err as Error).message}); ` +
            'it will start at your next logon.\n',
        );
      }
    });

  daemon
    .command('uninstall')
    .description('remove the logon Scheduled Task (does not stop an already-running daemon)')
    .action(() => {
      let outcome: ReturnType<typeof uninstallDaemonTask>;
      try {
        outcome = uninstallDaemonTask();
      } catch (err) {
        fail(`could not remove the logon task: ${(err as Error).message}`);
      }
      process.stdout.write(
        outcome === 'removed'
          ? 'Removed the logon task. A daemon already running keeps running until stopped.\n'
          : 'No logon task was registered.\n',
      );
    });

  daemon
    .command('status')
    .description('at-a-glance daemon health: logon task, heartbeat, pairing, relay')
    .action(async () => {
      const paths = defaultPaths();
      const dataDir = dirname(paths.vaultDir);

      // Each source is queried independently and degrades on its own — a PowerShell failure
      // here must not hide the heartbeat/pairing lines, which are still meaningful without it.
      let task: ReturnType<typeof queryDaemonTask>;
      try {
        task = queryDaemonTask();
      } catch {
        task = { registered: false };
      }

      const heartbeat = await readHeartbeat(join(dataDir, 'daemon-heartbeat.json'));
      const identity = await dpapiIdentityStore(
        join(dataDir, 'daemon-identity.enc'),
        defaultProtector(),
      ).load();
      // Same reason as `cctl settings`: status must show the relay the daemon would dial,
      // which means honoring config.json rather than env + defaults alone.
      const statusFileConfig = (await readDaemonConfigFile(daemonConfigPath())) ?? {};
      const relayUrl = resolveDaemonConfig(process.env, {}, statusFileConfig).values.relayUrl;

      process.stdout.write(
        renderDaemonStatus(
          { task, heartbeat, paired: identity !== undefined, relayUrl },
          detectPalette(),
        ) + '\n',
      );
    });

  // Bind this machine to the bot with a one-time `/pair` code. Adopts (and persists) the
  // daemon identity now; the daemon reconnects with it on its next start. The wizard runs this
  // same flow as step 6 — this standalone command is for re-pairing later.
  program
    .command('pair')
    .description('bind this machine to the Discord bot using a /pair code')
    .argument('[code]', 'the one-time code from Discord /pair (prompted if omitted)')
    .option('--relay <url>', 'relay WebSocket url to pair against')
    .action(async (codeArg: string | undefined, opts: { relay?: string }) => {
      const relayUrl = resolveRelayUrl(opts.relay);
      let raw = codeArg;
      if (raw === undefined) {
        if (!(process.stdin.isTTY && process.stdout.isTTY)) {
          fail('no code given and this is not a terminal — pass it: cctl pair <code>');
        }
        const { io, close } = createWizardIo();
        try {
          raw = await io.ask('Pairing code from Discord /pair: ');
        } finally {
          close();
        }
      }
      const code = normalizePairingCode(raw);
      if (!code) fail('empty pairing code.');
      process.stdout.write(`Pairing against ${relayUrl} ...\n`);
      const result = await attemptPair(code, relayUrl);
      if (result.ok) {
        process.stdout.write(
          'Paired. Start the daemon to connect: `cctl daemon install` (or `cctl setup`).\n',
        );
        return;
      }
      if (result.reason === 'timeout') {
        fail(
          `could not reach the relay (${result.detail}) — check a firewall/proxy, or pass --relay <url>.`,
        );
      }
      if (result.reason === 'rejected') {
        fail(
          `the relay refused that code (${result.detail}) — codes are one-time; run /pair again.`,
        );
      }
      fail(`pairing failed: ${result.detail}`);
    });

  program
    .command('run')
    .description(
      '(needs the running daemon + hosted bot) start a remote session (drive it from Discord)',
    )
    .allowUnknownOption(true)
    .action(() =>
      fail(
        '`cctl run` needs the daemon connected to the bot — an on-machine step; see docs/VERIFICATION.md.',
      ),
    );

  // Bare `cctl` (no subcommand): a short status summary once there are accounts, otherwise a
  // single nudge to run setup — never Commander's raw usage dump. `--help`/`--version` are
  // handled by Commander before this ever runs.
  program.action(async () => {
    const summary = await readStatusSummary();
    if (summary.accounts.length === 0) {
      process.stdout.write('Not set up yet. Run: cctl setup\n');
      return;
    }
    process.stdout.write(renderSetupSummary(summary, detectPalette()) + '\n');
    process.stdout.write(
      '\nCommands: cctl usage · cctl timeline · cctl switch <account> · cctl setup\n',
    );
  });

  return program;
}

// ---------------------------------------------------------------------------
// Setup wizard assembly (composition root — untested, like daemonRun.ts)
//
// These wire the real subsystems behind the wizard's injected `SetupDeps` seam: the switch
// engine, the live-login probe, the hooks-marker reader, the relay health probe, the pairing
// socket (with the wizard's own timeout), and the Scheduled Task lifecycle. The ORCHESTRATION
// that uses them — step order, re-entry, pauses, retries — lives (and is tested) in setup.ts.
// ---------------------------------------------------------------------------

/** A readline-backed `WizardIo`. Returns a `close` the caller must run (a live readline keeps
 *  the process alive). `isInteractive` requires BOTH streams to be TTYs — the wizard refuses
 *  otherwise, so it never hangs waiting on input that can't come. */
function createWizardIo(): { io: WizardIo; close: () => void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io: WizardIo = {
    write: (text) => void process.stdout.write(text),
    ask: (prompt) => new Promise<string>((resolve) => rl.question(prompt, resolve)),
    isInteractive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    palette: detectPalette(),
  };
  return { io, close: () => rl.close() };
}

/** Resolve the effective relay url with the standard flag > env > default precedence (the same
 *  resolution the daemon uses, so a `cctl pair`/`cctl setup` targets exactly what the daemon
 *  will later connect to). */
function resolveRelayUrl(relayFlag?: string): string {
  return resolveDaemonConfig(process.env, relayFlag !== undefined ? { relay: relayFlag } : {})
    .values.relayUrl;
}

/** The marker header every daemon-installed hook command carries (see `buildDaemonHookSpecs`).
 *  Recovered from a throwaway spec rather than hardcoded so this reader can't silently drift
 *  from the daemon's literal — its presence in settings.json is how setup/status tell that
 *  hooks are wired, without re-deriving the live loopback port or secret. */
function managedHookMarker(): string {
  const probe = buildDaemonHookSpecs({ port: 0, secret: 'probe' })[0]?.command ?? '';
  return /x-[\w-]*managed:\s*\S+/i.exec(probe)?.[0] ?? 'x-claude-control-managed: 1';
}

/** Whether our managed hooks are present in a profile's settings.json. A missing/unreadable
 *  file simply means "not installed", never an error. */
async function hooksInstalledAt(settingsPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(settingsPath, 'utf8');
  } catch {
    return false;
  }
  return raw.includes(managedHookMarker());
}

/** One pairing attempt against `relayUrl`, bounded by the wizard's own deadline (connect()
 *  reconnects forever, so without this it would hang on an unreachable relay). Adopts and
 *  persists the daemon identity on success; the transient client is always torn down. */
async function attemptPair(code: string, relayUrl: string): Promise<PairResult> {
  const paths = defaultPaths();
  const dataDir = dirname(paths.vaultDir);
  const store = new Store(daemonDbPath(paths));
  const identityStore = dpapiIdentityStore(
    join(dataDir, 'daemon-identity.enc'),
    defaultProtector(),
  );
  const client = new ControlPlaneClient({
    url: relayUrl,
    identityStore,
    store,
    hostLabel: hostname(),
    pairingCode: code,
  });
  try {
    return await connectWithTimeout(
      { connect: () => client.connect(), close: () => client.close() },
      PAIRING_TIMEOUT_MS,
    );
  } finally {
    // The wizard only needed to adopt the identity; the daemon owns the durable connection.
    client.close();
    store.close();
  }
}

/** Register/update the logon task and kick it now. Starting is best-effort — a correctly
 *  registered task still comes up at the next logon. */
function installAutostart(): Promise<AutostartResult> {
  const task = installDaemonTask({ shimPath: resolveCctlShimPath() });
  try {
    startDaemonTaskNow();
    return Promise.resolve({ task, started: true });
  } catch (err) {
    return Promise.resolve({ task, started: false, detail: (err as Error).message });
  }
}

/** Poll the daemon heartbeat until it reports alive or a short deadline passes — the wizard's
 *  round-trip check that the just-started daemon actually came up. */
async function verifyDaemonAlive(): Promise<boolean> {
  const heartbeatPath = join(dirname(defaultPaths().vaultDir), 'daemon-heartbeat.json');
  const deadline = Date.now() + 10_000;
  for (;;) {
    if ((await readHeartbeat(heartbeatPath)).state === 'alive') return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Assemble the production `SetupDeps` for one wizard run. */
function buildSetupDeps(io: WizardIo, relayFlag?: string): SetupDeps {
  const paths = defaultPaths();
  const dataDir = dirname(paths.vaultDir);
  const settingsPath = join(paths.claudeDir, 'settings.json');
  const identityPath = join(dataDir, 'daemon-identity.enc');
  const relayUrl = resolveRelayUrl(relayFlag);
  const engine = buildEngine(paths);
  return {
    io,
    runDoctor: () => runDoctor(paths),
    isLoggedIn: async () => (await checkLiveLogin(paths)).ok,
    listAccounts: () => engine.listAccounts(),
    captureCurrentLogin: (label) => engine.captureCurrentLogin(label),
    addFreshAccount: (label) => addFreshAccount(label),
    hooksInstalled: () => hooksInstalledAt(settingsPath),
    hooksProfilePath: settingsPath,
    relayUrl,
    probeRelay: (url) => probeRelay(url),
    isPaired: async () =>
      (await dpapiIdentityStore(identityPath, defaultProtector()).load()) !== undefined,
    pair: (pairCode) => attemptPair(pairCode, relayUrl),
    taskRegistered: () => {
      try {
        return Promise.resolve(queryDaemonTask().registered);
      } catch {
        return Promise.resolve(false);
      }
    },
    installAutostart,
    verifyDaemon: verifyDaemonAlive,
  };
}

/** Gather the at-a-glance status the bare-`cctl` summary and `cctl status` both render. Every
 *  source degrades on its own (a PowerShell failure must not hide the account/pairing lines). */
async function readStatusSummary(): Promise<SetupSummary> {
  const paths = defaultPaths();
  const dataDir = dirname(paths.vaultDir);
  const settingsPath = join(paths.claudeDir, 'settings.json');
  const engine = buildEngine(paths);
  const [accounts, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
  const [hooksInstalled, identity] = await Promise.all([
    hooksInstalledAt(settingsPath),
    dpapiIdentityStore(join(dataDir, 'daemon-identity.enc'), defaultProtector()).load(),
  ]);
  let taskRegistered = false;
  try {
    taskRegistered = queryDaemonTask().registered;
  } catch {
    taskRegistered = false;
  }
  const heartbeat = await readHeartbeat(join(dataDir, 'daemon-heartbeat.json'));
  return {
    accounts: accounts.map((a) => ({ label: a.label, active: a.id === activeId })),
    hooksInstalled,
    hooksProfilePath: settingsPath,
    relayUrl: resolveRelayUrl(),
    taskRegistered,
    daemonAlive: heartbeat.state === 'alive',
    paired: identity !== undefined,
  };
}

/** Accounts + active id joined with the daemon's latest persisted usage snapshot per
 *  account. Read-only view shared by `usage` and `timeline`: it works whether or not the
 *  daemon is currently running (it shows the last poll), and opening a not-yet-created db
 *  just yields an empty one. A corrupt snapshot row is skipped, never fatal. */
async function readUsageState(): Promise<{
  accounts: StoredAccount[];
  activeId: string | null;
  usageFor: (accountId: string) => AccountUsage | undefined;
}> {
  const engine = buildEngine();
  const [accounts, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
  const store = new Store(daemonDbPath());
  const byId = new Map<string, AccountUsage>();
  try {
    for (const a of accounts) {
      const row = store.latestUsageSnapshot(a.id);
      if (!row) continue;
      try {
        byId.set(a.id, JSON.parse(row.json) as AccountUsage);
      } catch {
        // a corrupt row must not crash the whole view
      }
    }
  } finally {
    store.close();
  }
  return { accounts, activeId, usageFor: (accountId) => byId.get(accountId) };
}

/**
 * The `--fresh` capture flow (wet-verified WT-1): run an interactive `claude` inside a
 * throwaway `CLAUDE_CONFIG_DIR`, let the user /login as the NEW account there, then vault
 * what landed. The live login is never touched. The transient dir holds real tokens, so it
 * is deleted no matter how the flow ends.
 */
async function addFreshAccount(label: string): Promise<void> {
  const paths = defaultPaths();
  const captureDir = join(dirname(paths.vaultDir), `capture-${randomUUID()}`);
  mkdirSync(captureDir, { recursive: true });
  try {
    process.stdout.write(
      'Opening a throwaway Claude window. In it:\n' +
        '  1. /login — pick the NEW account in the browser (it may preselect the current one).\n' +
        '  2. Send one short message so the login completes.\n' +
        '  3. /exit\n\n',
    );
    const run = spawnSync('claude', [], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: captureDir },
      shell: process.platform === 'win32', // `claude` is a .cmd shim on Windows; a real PATH exe on mac/linux
    });
    if (run.error) fail(`could not launch \`claude\`: ${run.error.message}`);
    const account = await buildEngine().captureFromConfigDir(label, captureDir);
    process.stdout.write(
      `Added ${account.label} (${account.id}). Your current login was not touched — ` +
        `\`cctl switch ${account.label}\` to use it.\n`,
    );
  } catch (err) {
    if (err instanceof SwitchEngineError && err.code === 'no_capture_login') fail(err.message);
    throw err;
  } finally {
    // Token-bearing — must not outlive the capture, success or failure.
    rmSync(captureDir, { recursive: true, force: true });
  }
}

function buildAccountCommands(program: Command): void {
  const accounts = program.command('accounts').description('manage stored accounts');

  accounts
    .command('list')
    .alias('ls')
    .description('list stored accounts')
    .action(async () => {
      const engine = buildEngine();
      const [list, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
      process.stdout.write(renderAccountsTable(list, activeId, detectPalette()) + '\n');
    });

  accounts
    .command('add <label>')
    .description('capture the currently logged-in account under <label>')
    .option(
      '--fresh',
      'log in as a NEW account in a throwaway window, without touching the live login',
    )
    .action(async (label: string, opts: { fresh?: boolean }) => {
      if (opts.fresh) {
        await addFreshAccount(label);
        return;
      }
      try {
        const account = await buildEngine().captureCurrentLogin(label);
        process.stdout.write(`Added ${account.label} (${account.id}) and set it active.\n`);
      } catch {
        fail('no live login to capture. Run `claude` and log in first, then retry.');
      }
    });

  accounts
    .command('remove <ref>')
    .alias('rm')
    .description('remove a stored account by id or label')
    .action(async (ref: string) => {
      const engine = buildEngine();
      const resolved = resolveAccountRef(await engine.listAccounts(), ref);
      if (!resolved.ok) fail(resolved.message);
      await engine.removeAccount(resolved.account.id);
      process.stdout.write(`Removed ${resolved.account.label}.\n`);
    });
}
