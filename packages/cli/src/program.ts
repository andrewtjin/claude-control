// The `cctl` command tree.
//
// Deliberately lightweight: one-shot local commands over the switch engine, plus honest
// placeholders for the daemon-backed remote features so the surface is discoverable. Action
// bodies stay thin — the real logic lives in the engine and the pure render/resolve helpers,
// which are unit-tested; here we only wire and print.

import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import {
  CadenceError,
  QuarantineError,
  SwitchEngineError,
  UnknownAccountError,
  buildAuthorizeUrl,
  defaultPaths,
  defaultProtector,
  generatePkce,
  generateState,
  parsePastedCode,
  resolveAccountRef,
  type StoredAccount,
} from '@claude-control/switch-engine';
import {
  ControlPlaneClient,
  Store,
  aggregateTokenStats,
  buildDaemonHookSpecs,
  readFleetHistory,
  readHeartbeat,
  readTranscriptTurns,
  uninstallHooks,
  type SessionRow,
} from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { DEFAULT_STATS_DAYS } from '@claude-control/shared-protocol';
import {
  computeOutlook,
  computePlan,
  planWeight,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
  type AccountUsageInput,
} from '@claude-control/usage-advisor';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { withCaptureDir } from './captureDir.js';
import { dpapiIdentityStore, runDaemon } from './daemonRun.js';
import {
  appendCrashLine,
  buildDefaultProbeFn,
  crashLogPath,
  superviseDaemon,
} from './daemonSupervise.js';
import {
  installDaemonTask,
  queryDaemonTask,
  resolveCctlShimPath,
  startDaemonTaskNow,
  uninstallDaemonTask,
} from './daemonInstall.js';
import {
  canWriteManagedDir,
  cctlDropInPath,
  renderCctlDropInPlan,
  diffCctlDropIn,
  managedDropInDir,
  readCctlDropIn,
  removeCctlDropIn,
  verifyManagedSettingsEffective,
  writeCctlDropIn,
  writeCctlDropInElevated,
} from './managedSettings.js';
import { installDaemonAgent, queryDaemonAgent, uninstallDaemonAgent } from './launchdInstall.js';
import { colorEnabled, detectPalette, outlookStyle, pacingStyle } from './ansi.js';
import {
  renderAccountsTable,
  renderDaemonStatus,
  renderPacingLine,
  renderTokenStats,
  renderUsage,
  type UsageRow,
} from './render.js';
import {
  renderSessionStatus,
  type SessionStatusHeader,
  type SessionStatusRow,
} from './sessionRender.js';
import {
  callDaemonSession,
  resolveSessionId,
  SessionClientError,
  type SessionCommandSuccess,
  type SessionVerb,
} from './sessionClient.js';
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
  renderVersionInfo,
  reportSaysGreedyActive,
  resolveCliSettings,
  resolveDaemonConfig,
  VERSION,
  type SettingsSection,
} from './settings.js';

// The default `cctl stats` window is DEFAULT_STATS_DAYS from the wire contract rather than a copy
// declared here. A week is the span the weekly limits themselves run on, so it is the window a
// "did I overspend?" reading is actually asked in — and the terminal, the daemon's pushed snapshot
// and Discord's `/stats` are only comparable for as long as all three mean the same week.

/** Build the full `cctl` program. Exported so tests can introspect the command tree. */
export function buildProgram(): Command {
  const program = new Command();
  program
    .name('cctl')
    .description('claude-control - switch Claude accounts, see usage, control sessions')
    .version(VERSION);

  // Commander only auto-adds a `help` subcommand when the program itself has no action handler
  // of its own — ours does (the bare-`cctl` summary at the bottom of this function), which would
  // otherwise silently disable `cctl help`/`cctl help <command>` rather than dispatching them.
  // Force it on explicitly so both keep working regardless of that handler.
  program.helpCommand(true);

  buildAccountCommands(program);
  buildSessionCommands(program);
  buildChannelCommands(program);

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
          ? `Recovered: ${result.action}${result.detail ? ` - ${result.detail}` : ''}.\n`
          : 'Nothing to recover.\n',
      );
    });

  program
    .command('usage')
    .description("show usage across all accounts (from the daemon's latest poll)")
    .action(async () => {
      const nowMs = Date.now();
      const state = await readUsageState(nowMs);
      const rows: UsageRow[] = state.accounts.map((a) => {
        // The prediction is measured here, from the same history the pacing line below reads,
        // and handed to the row: an account whose endpoint reset has already passed has no
        // reset in its snapshot, so without this the runway would simply vanish from this one
        // view while every other surface still counted down to it.
        const predictedResetAt = state.predictedResetFor(a.id);
        return {
          label: a.label,
          active: a.id === state.activeId,
          usage: state.usageFor(a.id),
          ...(predictedResetAt !== undefined ? { predictedResetAt } : {}),
        };
      });
      let text = renderUsage(rows, nowMs, detectPalette());
      // Pacing needs the same weekly-limit view the burn plan uses (accountId + quarantine
      // state), which UsageRow doesn't carry — build it separately rather than widen UsageRow
      // for one trailing line.
      const inputs = buildAdvisorInputs(state);
      if (inputs.length > 0) {
        text +=
          '\n\n' +
          renderPacingLine(inputs, { nowMs, ...burnOption(state) }, pacingStyle(detectPalette()));
      }
      process.stdout.write(text + '\n');
    });

  program
    .command('timeline')
    .description('5h-session budget per account + when every limit resets, with a usage plan')
    .action(async () => {
      const nowMs = Date.now();
      const state = await readUsageState(nowMs);
      const inputs = buildAdvisorInputs(state);
      const outlook = computeOutlook(inputs, nowMs);
      let text = renderOutlook(outlook, { style: outlookStyle(detectPalette()) });
      // The burn-down plan turns the timeline into advice: what to burn first and what to
      // hold. When the last-started daemon runs greedy auto-switch, the advice matches its
      // descriptive phrasing (the daemon executes the plan; the user doesn't have to).
      if (inputs.length > 0) {
        const greedy = reportSaysGreedyActive(await readSettingsReport(daemonSettingsPath()));
        text +=
          '\n\n' + renderPlanSummary(computePlan(inputs, greedy ? { greedyAutoSwitch: true } : {}));
        text +=
          '\n\n' +
          renderPacingLine(inputs, { nowMs, ...burnOption(state) }, pacingStyle(detectPalette()));
      }
      process.stdout.write(text + '\n');
    });

  // `usage`/`timeline` answer "how much of my LIMIT is gone" (a percent from Anthropic's
  // endpoint). `stats` answers the different question "how many tokens did I actually spend, and
  // on which account" — read from the turn records Claude Code writes on this machine and joined
  // against the daemon's switch journal. Nothing here touches the network.
  program
    .command('stats')
    .description('absolute token counts per account, model and day (from local transcripts)')
    .option('--days <n>', 'how many days back to count', String(DEFAULT_STATS_DAYS))
    .action(async (opts: { days?: string }) => {
      const days = Number(opts.days);
      if (!Number.isFinite(days) || days <= 0) fail('--days must be a positive number.');
      const paths = defaultPaths();
      const windowEndMs = Date.now();
      const windowStartMs = windowEndMs - days * 86_400_000;

      // The scan reads every transcript touched inside the window, which is seconds of disk IO on
      // a machine with real history. Say so — but only to a terminal, so piping stdout still
      // yields nothing but the table.
      if (process.stderr.isTTY) {
        process.stderr.write(`Reading transcripts under ${paths.claudeDir} ...\n`);
      }
      const [accounts, scan] = await Promise.all([
        buildEngine(paths).listAccounts(),
        readTranscriptTurns({ claudeDir: paths.claudeDir, sinceMs: windowStartMs }),
      ]);

      // Attribution comes from the daemon's journal, read offline like `usage`/`timeline` do:
      // no running daemon is required, and an empty journal simply means every turn lands in the
      // unattributed bucket (which the renderer shows rather than hides).
      const store = new Store(daemonDbPath(paths));
      let intervals;
      try {
        intervals = store.listActivationIntervals();
      } finally {
        store.close();
      }

      const stats = aggregateTokenStats({
        scan,
        intervals,
        windowStartMs,
        windowEndMs,
        labelById: new Map(accounts.map((a) => [a.id, a.label] as const)),
      });
      process.stdout.write(renderTokenStats(stats, detectPalette()) + '\n');
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
    .command('version')
    .description("show this CLI's build and the running daemon's last-reported build")
    .action(async () => {
      const report = await readSettingsReport(daemonSettingsPath());
      process.stdout.write(renderVersionInfo(VERSION, report) + '\n');
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
      'when the active account runs low, auto-switch to the account with >=25% of a 5h window left whose weekly quota resets soonest (the default; env: CCTL_AUTOSWITCH)',
    )
    .option('--no-auto-switch', 'never hop accounts automatically this run')
    .option(
      '--greedy',
      "with auto-switch: also hop toward whichever account's weekly quota expires soonest, even while the active one is healthy (burns expiring budget first; the default; env: CCTL_AUTOSWITCH_GREEDY)",
    )
    .option('--no-greedy', 'hop only when the active account runs low')
    .action(
      async (opts: { pair?: string; relay?: string; autoSwitch?: boolean; greedy?: boolean }) => {
        // Greedy is a refinement of auto-switch, not a standalone mode — fail loudly rather
        // than let the pair silently contradict each other.
        if (opts.greedy === true && opts.autoSwitch === false)
          fail('--greedy conflicts with --no-auto-switch.');
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
    .command('supervise')
    .description(
      'run the daemon and restart it automatically if it crashes (a clean exit ends supervision)',
    )
    .option('--pair <code>', 'pairing code from Discord /pair (adopts a new identity)')
    .option(
      '--relay <url>',
      'control-plane WebSocket url (default CCTL_RELAY_URL or ws://127.0.0.1:8765)',
    )
    .option('--auto-switch', 'forwarded to `daemon run` - see its help')
    .option('--no-auto-switch', 'forwarded to `daemon run` - see its help')
    .option('--greedy', 'forwarded to `daemon run` - see its help')
    .option('--no-greedy', 'forwarded to `daemon run` - see its help')
    .action(
      async (opts: { pair?: string; relay?: string; autoSwitch?: boolean; greedy?: boolean }) => {
        if (opts.greedy === true && opts.autoSwitch === false)
          fail('--greedy conflicts with --no-auto-switch.');
        // Reconstruct the child argv from the parsed flags: the supervisor and `daemon run`
        // deliberately share an option surface so nothing can be forwarded wrong.
        const childArgs = [
          'daemon',
          'run',
          ...(opts.pair !== undefined ? ['--pair', opts.pair] : []),
          ...(opts.relay !== undefined ? ['--relay', opts.relay] : []),
          ...(opts.autoSwitch === true ? ['--auto-switch'] : []),
          ...(opts.autoSwitch === false ? ['--no-auto-switch'] : []),
          ...(opts.greedy === true ? ['--greedy'] : []),
          ...(opts.greedy === false ? ['--no-greedy'] : []),
        ];
        const dataDir = dirname(defaultPaths().vaultDir);
        const crashFile = crashLogPath(dataDir);
        const controller = new AbortController();
        process.once('SIGINT', () => controller.abort());
        process.once('SIGTERM', () => controller.abort());
        await superviseDaemon({
          // process.argv[1] is this CLI's own entry — the child is the same cctl, same node.
          spawnChild: () =>
            spawn(process.execPath, [process.argv[1] ?? '', ...childArgs], {
              stdio: 'inherit',
            }),
          log: (line) => process.stdout.write(line + '\n'),
          logCrash: (line) => appendCrashLine(crashFile, line),
          signal: controller.signal,
          // Catches a HUNG child (alive, unresponsive) that would otherwise stall every
          // hook until a human noticed — a plain exit-code check never sees it.
          probe: { probeFn: buildDefaultProbeFn(dataDir) },
        });
      },
    );

  daemon
    .command('install')
    .description(
      'register a logon task (Scheduled Task / LaunchAgent) that starts the daemon automatically',
    )
    .action(() => {
      let shimPath: string;
      try {
        shimPath = resolveCctlShimPath();
      } catch (err) {
        fail(`could not resolve the installed cctl location: ${(err as Error).message}`);
      }
      if (process.platform === 'darwin') {
        // launchd path: bootstrapping a RunAtLoad agent registers AND starts in one step.
        let outcome: ReturnType<typeof installDaemonAgent>;
        try {
          outcome = installDaemonAgent({ shimPath });
        } catch (err) {
          fail(`could not register the LaunchAgent: ${(err as Error).message}`);
        }
        const verb = { created: 'Registered', updated: 'Updated', unchanged: 'Already registered' }[
          outcome
        ];
        process.stdout.write(
          `${verb} the LaunchAgent to run "${shimPath} daemon run" at login.\n` +
            (outcome === 'unchanged' ? '' : 'Daemon starting now.\n'),
        );
        return;
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
    .description(
      'remove the logon Scheduled Task and the daemon hook entries ' +
        '(does not stop an already-running daemon)',
    )
    .action(async () => {
      let outcome: ReturnType<typeof uninstallDaemonTask>;
      try {
        outcome = process.platform === 'darwin' ? uninstallDaemonAgent() : uninstallDaemonTask();
      } catch (err) {
        fail(`could not remove the logon task: ${(err as Error).message}`);
      }
      process.stdout.write(
        outcome === 'removed'
          ? 'Removed the logon task. A daemon already running keeps running until stopped.\n'
          : 'No logon task was registered.\n',
      );

      // Same settings.json the daemon installs into (claudeDir honors CLAUDE_CONFIG_DIR).
      // Best-effort: the task removal above already succeeded, so a hook-removal failure
      // (e.g. a corrupt settings.json, which uninstallHooks refuses to touch) downgrades to
      // a warning instead of turning that success into a failure exit.
      const settingsPath = join(defaultPaths().claudeDir, 'settings.json');
      try {
        const hooks = await uninstallHooks({ settingsPath });
        process.stdout.write(
          hooks === 'removed'
            ? 'Removed the daemon hook entries from settings.json. A daemon still ' +
                'running reinstalls them on its next start.\n'
            : 'No daemon hook entries were installed in settings.json.\n',
        );
      } catch (err) {
        process.stdout.write(
          `Warning: could not remove the daemon hook entries from ${settingsPath}: ` +
            `${(err as Error).message}\n`,
        );
      }
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
        task = process.platform === 'darwin' ? queryDaemonAgent() : queryDaemonTask();
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
        '`cctl run` needs the daemon connected to the bot - an on-machine step; see docs/VERIFICATION.md.',
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

/** The marker header every daemon-installed hook command carries: the secret-header NAME
 *  (see `buildDaemonHookSpecs` — the name is unique to us and independent of the rotatable
 *  secret value). Recovered from a throwaway spec rather than hardcoded so this reader can't
 *  silently drift from the daemon's literal — its presence in settings.json is how
 *  setup/status tell that hooks are wired, without re-deriving the live secret. */
function managedHookMarker(): string {
  const probe = buildDaemonHookSpecs({ secret: 'probe', forwarderPath: 'probe' })[0]?.command ?? '';
  return /x-[\w-]*-secret/i.exec(probe)?.[0] ?? 'x-claude-control-secret';
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
  if (process.platform === 'darwin') {
    // Bootstrapping a RunAtLoad LaunchAgent registers and starts in one step.
    const task = installDaemonAgent({ shimPath: resolveCctlShimPath() });
    return Promise.resolve({ task, started: true });
  }
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
    channelEnabled: async () => {
      const status = await verifyManagedSettingsEffective({});
      // The wizard asks for the same administrator rights `cctl channel enable` does, so it must
      // show the same thing first. Rendered here, from the real on-disk state, rather than
      // described in the wizard's own words: the plan the operator reads is the plan that runs.
      const current = await readCctlDropIn(status.path).catch(() => ({ present: false }));
      return {
        effective: status.effective,
        detail: status.detail,
        path: status.path,
        plan: renderCctlDropInPlan(status.path, diffCctlDropIn(current)),
      };
    },
    enableChannel: async () => {
      // Already writable (an elevated shell, or a non-Windows box under sudo) — no need to ask
      // the OS for something the process already has.
      if (await canWriteManagedDir(managedDropInDir())) {
        const written = await writeCctlDropIn({});
        return { outcome: written.outcome, detail: `${written.outcome}: ${written.path}` };
      }
      const result = await writeCctlDropInElevated({});
      return {
        outcome: result.outcome,
        detail:
          result.outcome === 'unsupported'
            ? `cctl does not escalate privileges here. Run: ${result.manualCommand ?? ''}`
            : `${result.outcome}: ${result.path}${result.error !== undefined ? ` (${result.error})` : ''}`,
      };
    },
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

/** What `usage` and `timeline` read before rendering: the registry, the daemon's latest
 *  persisted snapshot per account, and the two history-derived measurements the pure advisor
 *  cannot make for itself (each account's predicted weekly reset and the fleet's burn rate).
 *  Works whether or not the daemon is currently running (it shows the last poll), and opening
 *  a not-yet-created db just yields an empty one. A corrupt snapshot row is skipped, never
 *  fatal. */
interface UsageState {
  accounts: StoredAccount[];
  activeId: string | null;
  usageFor: (accountId: string) => AccountUsage | undefined;
  /** Next weekly reset predicted from stored history, for accounts the endpoint has stopped
   *  publishing one for. Absent when the account has no observed reset in history at all. */
  predictedResetFor: (accountId: string) => number | undefined;
  /** Fleet burn in Pro-equivalent units/day, or undefined when history cannot measure one. */
  burnUnitsPerDay: number | undefined;
}

async function readUsageState(nowMs: number): Promise<UsageState> {
  const engine = buildEngine();
  const [accounts, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
  const store = new Store(daemonDbPath());
  try {
    const byId = new Map<string, AccountUsage>();
    for (const a of accounts) {
      const row = store.latestUsageSnapshot(a.id);
      if (!row) continue;
      try {
        byId.set(a.id, JSON.parse(row.json) as AccountUsage);
      } catch {
        // a corrupt row must not crash the whole view
      }
    }
    // The same measurement the daemon makes each poll cycle, over the same store and the one
    // implementation — so a number the CLI prints can never disagree with the one the phone got.
    const history = readFleetHistory(
      store,
      accounts.map((a) => ({ accountId: a.id, ...resolvedWeight(a) })),
      nowMs,
    );
    return {
      accounts,
      activeId,
      usageFor: (accountId) => byId.get(accountId),
      predictedResetFor: (accountId) => history.predictedResetByAccount.get(accountId),
      burnUnitsPerDay: history.burnUnitsPerDay,
    };
  } finally {
    store.close();
  }
}

/** Build the advisor's `AccountUsageInput` view shared by `timeline`'s outlook/plan and both
 *  commands' pacing line. Registry data (label/active/quarantined) is authoritative and
 *  current; the persisted snapshot only contributes the limits, so a stale snapshot can't
 *  misreport which account is live. Accounts without a snapshot still appear (as "unknown"). */
function buildAdvisorInputs(state: UsageState): AccountUsageInput[] {
  return timelineInputFromWire(
    state.accounts.map((a) => ({
      accountId: a.id,
      label: a.label,
      active: a.id === state.activeId,
      quarantined: a.quarantined,
      limits: state.usageFor(a.id)?.limits ?? [],
      predictedResetAt: state.predictedResetFor(a.id),
      // The registry row carries the exclusion, so pass it: `timeline` computes its OWN plan
      // with the daemon's greedy setting, and without this the terminal would promise a hop
      // the daemon's policy refuses to make.
      autoSwitchExcluded: a.autoSwitchExcluded,
      // The registry is right here, so resolve the tier from it rather than leaving the fleet
      // math equal-weighting a Max 20x against a Pro. Only a KNOWN weight is passed: an
      // unresolved one must stay absent so pacing reports the assumption instead of burying it.
      ...resolvedWeight(a),
    })),
  );
}

/** `{ weight }` when the account's plan tier resolves, `{}` when it does not — the same
 *  present-or-absent contract `timelineInputFromWire` relies on to tell a real 1x Pro account
 *  from one whose tier nothing could read. */
function resolvedWeight(account: StoredAccount): { weight?: number } {
  const result = planWeight(account);
  return result.known ? { weight: result.weight } : {};
}

/** Spread the measured burn into `PacingOptions` only when there IS one. `exactOptionalPropertyTypes`
 *  forbids passing an explicit `undefined`, and the distinction is load-bearing: an absent burn
 *  rate means "not measurable", which pacing reports rather than treating as zero. */
function burnOption(state: UsageState): { burnUnitsPerDay?: number } {
  return state.burnUnitsPerDay !== undefined ? { burnUnitsPerDay: state.burnUnitsPerDay } : {};
}

/**
 * The `--fresh` capture flow: run an interactive `claude` inside a
 * throwaway `CLAUDE_CONFIG_DIR`, let the user /login as the NEW account there, then vault
 * what landed. The live login is never touched. The transient dir holds real tokens, so it
 * is deleted no matter how the flow ends.
 */
async function addFreshAccount(label: string): Promise<void> {
  const paths = defaultPaths();
  // Failures are RETURNED, not `fail()`ed, so the dir is deleted before the process exits —
  // `fail()` is `process.exit`, which skips `finally`. See captureDir.ts.
  const failure = await withCaptureDir(dirname(paths.vaultDir), 'capture', async (captureDir) => {
    // Darwin: the CLI writes every login to its single Keychain item regardless of
    // CLAUDE_CONFIG_DIR, so the capture must diff the Keychain around the window instead of
    // reading files from the transient dir — and restore the pre-window login afterwards.
    // See SwitchEngine.captureFromKeychainDelta.
    const engine = buildEngine();
    const prior = process.platform === 'darwin' ? await engine.readLiveOauth() : undefined;
    process.stdout.write(
      'Opening a throwaway Claude window. In it:\n' +
        '  1. /login - pick the NEW account in the browser (it may preselect the current one).\n' +
        '  2. Send one short message so the login completes.\n' +
        '  3. /exit\n\n',
    );
    const run = spawnSync('claude', [], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: captureDir },
      shell: process.platform === 'win32', // `claude` is a .cmd shim on Windows; a real PATH exe on mac/linux
    });
    if (run.error) return `could not launch \`claude\`: ${run.error.message}`;
    try {
      const account =
        process.platform === 'darwin'
          ? await engine.captureFromKeychainDelta(label, captureDir, prior)
          : await engine.captureFromConfigDir(label, captureDir);
      process.stdout.write(
        `Added ${account.label} (${account.id}). Your current login was not touched - ` +
          `\`cctl switch ${account.label}\` to use it.\n`,
      );
    } catch (err) {
      if (err instanceof SwitchEngineError && err.code === 'no_capture_login') return err.message;
      throw err;
    }
    return undefined;
  });
  if (failure) fail(failure);
}

/**
 * `cctl accounts relogin <ref>` — re-login an EXISTING account in place. Same transient-config-dir
 * capture as `add --fresh`, but the captured credentials are written into the account's existing
 * vault entry (SAME id) and its quarantine is cleared — which is exactly what `add --fresh` must
 * NOT do (that mints a new id, orphaning the account's usage-attribution history). The engine's
 * identity guard refuses if the user logs into a different account in the window.
 */
async function reloginAccount(ref: string): Promise<void> {
  const engine = buildEngine();
  const resolved = resolveAccountRef(await engine.listAccounts(), ref);
  if (!resolved.ok) fail(resolved.message);
  const account = resolved.account;

  const paths = defaultPaths();
  // Same return-don't-fail contract as addFreshAccount: cleanup has to outlive every failure
  // path, and `fail()` (process.exit) would skip it. See captureDir.ts.
  const failure = await withCaptureDir(dirname(paths.vaultDir), 'relogin', async (captureDir) => {
    // Same darwin Keychain-diff-and-restore as addFreshAccount — see that flow's comment.
    const prior = process.platform === 'darwin' ? await engine.readLiveOauth() : undefined;
    process.stdout.write(
      `Re-logging in "${account.label}" (${account.id}). A throwaway Claude window will open.\n` +
        '  1. /login - pick the SAME account this entry belongs to (attribution is preserved).\n' +
        '  2. Send one short message so the login completes.\n' +
        '  3. /exit\n\n',
    );
    const run = spawnSync('claude', [], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: captureDir },
      shell: process.platform === 'win32', // `claude` is a .cmd shim on Windows; a real PATH exe on mac/linux
    });
    if (run.error) return `could not launch \`claude\`: ${run.error.message}`;
    try {
      // The Keychain path puts the pre-window login BACK on the way out (see that method), so
      // on darwin the live login is never healed by a re-login — the switch is always the honest
      // next step there, which is what `healedLiveLogin: false` says.
      const { account: updated, healedLiveLogin } =
        process.platform === 'darwin'
          ? {
              account: await engine.reloginFromKeychainDelta(account.id, captureDir, prior),
              healedLiveLogin: false,
            }
          : await engine.reloginFromConfigDir(account.id, captureDir);
      // Two truthful endings: a re-login of the LIVE account also rewrote the live files, so
      // sessions pick the fresh login up on their own and telling the user to switch would be
      // noise; any other outcome still needs the switch to put these credentials live.
      process.stdout.write(
        `Re-logged in ${updated.label} (${updated.id}). Quarantine cleared; usage history kept - ` +
          (healedLiveLogin
            ? 'this is the live account, so the fresh login is already in place.\n'
            : `\`cctl switch ${updated.label}\` to use it.\n`),
      );
    } catch (err) {
      // no_capture_login (login never completed) and relogin_identity_mismatch (wrong account) are
      // expected, actionable failures — print the engine's message, don't stack-trace.
      if (err instanceof SwitchEngineError) return err.message;
      throw err;
    }
    return undefined;
  });
  if (failure) fail(failure);
}

/**
 * `cctl accounts reauth <ref>` — re-login an EXISTING account through a browser login link,
 * with no browser needed on THIS host. Prints the authorize URL, reads back the "<code>#<state>"
 * the approval page displays, and exchanges it for tokens written into the account's existing
 * vault entry (same id — usage history kept, quarantine cleared).
 *
 * The headless sibling of the phone's `/reauth`, running the SAME engine call
 * (`reauthenticate`), which is what makes it the first place any OAuth-flow problem shows up:
 * any problem with the authorize URL, the paste format, or the exchange shows up here without
 * the daemon's pending-flow machinery in the way.
 *
 * Unlike `relogin`, nothing is spawned and no transient config dir exists — so there is no
 * token-bearing directory to clean up, and the verifier lives only in this function's scope.
 */
async function reauthAccount(ref: string): Promise<void> {
  const engine = buildEngine();
  const resolved = resolveAccountRef(await engine.listAccounts(), ref);
  if (!resolved.ok) fail(resolved.message);
  const account = resolved.account;

  const { verifier, challenge } = generatePkce();
  const state = generateState();
  const url = buildAuthorizeUrl({ challenge, state });

  process.stdout.write(
    `Re-authenticating "${account.label}" (${account.id}).\n` +
      '  1. Open this URL and log in as the SAME account (attribution is preserved):\n' +
      `     ${url}\n` +
      '  2. The page shows a code like `abc123#xyz` - copy the WHOLE thing.\n\n',
  );
  // Read from stdin rather than an argv option on purpose: an argument would put the code into
  // shell history and `ps`. Plain line read, so a piped (non-TTY) stdin works too.
  const { io, close } = createWizardIo();
  let pasted: string;
  try {
    pasted = (await io.ask('Paste the code here: ')).trim();
  } finally {
    close();
  }

  const parsed = parsePastedCode(pasted);
  // Both checks are local (no network), so a mistake here costs nothing but a re-run — and the
  // single-use code is not spent against the endpoint.
  if (!parsed) fail('that does not look like a pasted code (expected "<code>#<state>").');
  if (parsed.state !== state) {
    fail('that code was issued for a different login - re-run this command for a fresh link.');
  }
  try {
    const {
      account: updated,
      healedLiveLogin,
      identityVerified,
    } = await engine.reauthenticate(account.id, {
      code: parsed.code,
      state: parsed.state,
      verifier,
    });
    // Same two truthful endings `accounts relogin` prints: re-authing the LIVE account also
    // rewrote the live files, so telling the user to switch would be noise; anything else still
    // needs the switch to put these credentials live.
    process.stdout.write(
      `Re-authenticated ${updated.label} (${updated.id}). Quarantine cleared; usage history kept` +
        (identityVerified
          ? ''
          : ' (the login did not report which account was used, so the match is unverified -' +
            ' check `cctl accounts list` shows the email you expect)') +
        ' - ' +
        (healedLiveLogin
          ? 'this is the live account, so the fresh login is already in place.\n'
          : `\`cctl switch ${updated.label}\` to use it.\n`),
    );
  } catch (err) {
    // Expected, actionable failures (bad/expired code, identity mismatch) print their message
    // rather than a stack trace — same contract as reloginAccount.
    if (err instanceof SwitchEngineError) fail(err.message);
    throw err;
  }
}

/**
 * The shared body of `accounts exclude` / `accounts include`. Reports what the registry now says
 * rather than what the command asked for: running either verb on an account already in that
 * state is a no-op, and printing "Excluded X" there would claim a change that did not happen.
 */
async function setExclusion(ref: string, excluded: boolean): Promise<void> {
  const engine = buildEngine();
  const resolved = resolveAccountRef(await engine.listAccounts(), ref);
  if (!resolved.ok) fail(resolved.message);
  const already = resolved.account.autoSwitchExcluded === true;
  if (already === excluded) {
    process.stdout.write(
      excluded
        ? `${resolved.account.label} is already excluded from auto-switch.\n`
        : `${resolved.account.label} is already available to auto-switch.\n`,
    );
    return;
  }
  await engine.setAutoSwitchExcluded(resolved.account.id, excluded);
  process.stdout.write(
    excluded
      ? `Excluded ${resolved.account.label} from auto-switch (manual switches still work).\n`
      : `${resolved.account.label} is available to auto-switch again.\n`,
  );
}

function buildAccountCommands(program: Command): void {
  const accounts = program.command('accounts').description('manage stored accounts');

  accounts
    .command('list')
    .alias('ls')
    .description('list stored accounts')
    .action(async () => {
      const engine = buildEngine();
      // Self-heal before rendering. The PLAN/BILLING columns read fields that a row only gains
      // when its bundle is rewritten, so an account stored by an earlier build shows "?" and
      // "unknown" indefinitely even though its vaulted bundle has carried the answer all along.
      // This call IS the repair mechanism for every account that is never switched to — nothing
      // else reaches them. The sweep decrypts only rows that are actually behind, stamps each one
      // whether or not it could be repaired, and yields the credential lock instead of waiting on
      // it, so it costs nothing once healed and cannot stall a listing behind an in-flight switch.
      // Unguarded on purpose: the engine's contract is that this never throws and logs whatever
      // went wrong, so a listing the user asked for still renders whatever is already on record —
      // without a `catch` here throwing the reason away on the way past.
      await engine.backfillAccountMetadata();
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
    .command('relogin <ref>')
    .description('re-login an existing (usually quarantined) account in place, keeping its id')
    .action(async (ref: string) => {
      await reloginAccount(ref);
    });

  accounts
    .command('reauth <ref>')
    .description('re-login an existing account via a login link + pasted code, keeping its id')
    .action(async (ref: string) => {
      await reauthAccount(ref);
    });

  // Exclusion is a standing choice about UNATTENDED hops only, so the two verbs deliberately
  // change nothing else: `cctl switch` and the phone's /switch still activate an excluded
  // account, and auto-switch still hops away from one that is live.
  accounts
    .command('exclude <ref>')
    .description('stop auto-switch from ever hopping TO this account (manual switches still work)')
    .action(async (ref: string) => {
      await setExclusion(ref, true);
    });

  accounts
    .command('include <ref>')
    .description('let auto-switch consider this account again')
    .action(async (ref: string) => {
      await setExclusion(ref, false);
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

/**
 * `cctl session <register|label|watch|status>` — the in-session control surface the `/cctl`
 * plugin wraps.
 *   - status reads the daemon db OFFLINE (like `usage`/`timeline`): it needs no running daemon.
 *   - register/label/watch talk to the RUNNING daemon over its loopback CLI endpoints (see
 *     sessionClient.ts) — they require the daemon to be up, and fail with an actionable message
 *     otherwise (never silently no-op).
 */
/**
 * `cctl channel <serve|enable|disable|status>` — the surface that lets a prompt from the phone
 * reach a session sitting IDLE at its prompt.
 *
 * Without it, a `/say` waits for the session's next turn boundary, which never arrives if nobody
 * is at the keyboard — the exact case phone control exists for. Claude Code only loads a channel
 * whose plugin an administrator has approved, so `enable` writes one administrator-scoped file
 * and asks for consent once.
 */
function buildChannelCommands(program: Command): void {
  const channel = program
    .command('channel')
    .description('let prompts from your phone reach a session that is sitting idle');

  channel
    .command('serve')
    .description('run the per-session channel server (Claude Code spawns this; not for humans)')
    .action(async () => {
      // Imported lazily: this is the only command that needs the channel package, and every
      // other `cctl` invocation would otherwise pay for loading its module graph.
      const { runChannelServer } = await import('@claude-control/channel');
      const code = await runChannelServer();
      if (code !== 0) process.exit(code);
    });

  channel
    .command('status')
    .description('show whether idle-session prompts are enabled on this machine')
    .action(async () => {
      const status = await verifyManagedSettingsEffective({});
      const p = detectPalette();
      if (status.effective) {
        process.stdout.write(`${p.green('enabled')} — ${status.detail}\n`);
        return;
      }
      process.stdout.write(
        `${p.yellow('not enabled')} — ${status.detail}\n` +
          `Prompts sent from Discord will wait for the session's next turn boundary.\n` +
          `Run \`cctl channel enable\` to change that.\n`,
      );
    });

  channel
    .command('enable')
    .description('approve cctl as a Claude Code channel (writes one administrator-scoped file)')
    .option(
      '--no-elevate',
      'do not ask for administrator rights; print the file to place by hand instead',
    )
    .option('--print', 'only show what would be written, and where')
    .action(async (opts: { elevate?: boolean; print?: boolean }) => {
      const path = cctlDropInPath();
      const current = await readCctlDropIn(path).catch(() => ({ present: false }));
      const diff = diffCctlDropIn(current);

      // A file the operator cannot override is never written without showing it first.
      process.stdout.write(renderCctlDropInPlan(path, diff));
      if (opts.print === true) return;
      if (!diff.changed) {
        process.stdout.write('Already up to date; nothing to do.\n');
        return;
      }

      // Already writable (an elevated shell, or a non-Windows box running under sudo): just write.
      if (await canWriteManagedDir(managedDropInDir())) {
        const result = await writeCctlDropIn({ path });
        process.stdout.write(
          `${result.outcome === 'written' ? 'Written' : 'Unchanged'}: ${path}\n`,
        );
        await reportChannelNextSteps();
        return;
      }

      if (opts.elevate === false) {
        process.stdout.write(
          `\nThis file lives in an administrator-owned directory and cctl was told not to ask for\n` +
            `elevation. Place the JSON above at:\n  ${path}\n`,
        );
        return;
      }

      process.stdout.write('\nRequesting administrator rights to write it...\n');
      const result = await writeCctlDropInElevated({ path });
      switch (result.outcome) {
        case 'written':
          process.stdout.write(`Written: ${path}\n`);
          await reportChannelNextSteps();
          return;
        case 'unchanged':
          fail(`could not write ${path}${result.error !== undefined ? `: ${result.error}` : ''}`);
        // eslint-disable-next-line no-fallthrough -- fail() returns never
        case 'declined':
          fail(
            'administrator rights were declined, so nothing was written. ' +
              'Re-run and accept the prompt, or use `cctl channel enable --no-elevate` to place the file yourself.',
          );
        // eslint-disable-next-line no-fallthrough -- fail() returns never
        case 'unsupported':
          process.stdout.write(
            `\ncctl does not escalate privileges on this platform. Run:\n  ${result.manualCommand}\n` +
              `and paste the JSON above.\n`,
          );
          return;
      }
    });

  channel
    .command('disable')
    .description('withdraw cctl from the approved channel list')
    .action(async () => {
      const path = cctlDropInPath();
      if (!(await canWriteManagedDir(managedDropInDir()))) {
        fail(
          `${path} is in an administrator-owned directory. Delete it from an elevated shell to disable the channel.`,
        );
      }
      const result = await removeCctlDropIn({ path });
      process.stdout.write(
        result.outcome === 'removed'
          ? `Removed: ${path}\nSessions started from now on will not load the cctl channel.\n`
          : `Nothing to remove; ${path} was not present.\n`,
      );
    });
}

/** What the operator has to do next, said once and plainly: the approval only takes effect for
 *  sessions started AFTER it, because a channel cannot be attached to a session already running. */
async function reportChannelNextSteps(): Promise<void> {
  const status = await verifyManagedSettingsEffective({});
  if (!status.effective) {
    process.stdout.write(
      'warning: the file was written but does not read back as effective. Run `cctl doctor`.\n',
    );
    return;
  }
  process.stdout.write(
    'Sessions started from now on can receive prompts while idle. ' +
      'Sessions already running cannot — a channel is attached at launch and cannot be added later.\n',
  );
}

function buildSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('track/label/stream the current Claude Code session, and show tracked sessions');

  const sessionIdOption = '--session <id>';
  const sessionIdHelp =
    'session id (Claude Code does not reliably expose it to slash commands - pass it explicitly)';
  // label/watch/unregister run daemon-side against a session already known to the registry, so
  // (unlike register, which CREATES the row and must get the real id) they can also take that
  // session's label — the daemon resolves it, preferring an exact id match if both match.
  const sessionIdOrLabelHelp =
    'session id, or the label of a registered session (id wins if both match)';

  session
    .command('register')
    .description("opt this Claude Code session into the daemon's tracking + phone streaming")
    .option(sessionIdOption, sessionIdHelp)
    .option('--label <name>', 'set a human label at the same time')
    .action(async (opts: { session?: string; label?: string }) => {
      await runSessionCommand('register', opts, {
        ...(opts.label !== undefined ? { label: opts.label } : {}),
      });
    });

  session
    .command('label <name>')
    .description('name the current tracked session (shown in the phone session list)')
    .option(sessionIdOption, sessionIdOrLabelHelp)
    .action(async (name: string, opts: { session?: string }) => {
      await runSessionCommand('label', opts, { label: name });
    });

  session
    .command('watch')
    .description('stream this session to Discord (use --off to stop streaming it)')
    .option(sessionIdOption, sessionIdOrLabelHelp)
    .option('--off', 'turn per-session streaming OFF (default is on)')
    .action(async (opts: { session?: string; off?: boolean }) => {
      await runSessionCommand('watch', opts, { watch: !opts.off });
    });

  session
    .command('unregister')
    .description("remove a session from the daemon's tracking (undo register, e.g. a mistyped id)")
    .option(sessionIdOption, sessionIdOrLabelHelp)
    .option('--label <label>', 'remove by registered label instead of id')
    .action(async (opts: { session?: string; label?: string }) => {
      if (opts.session !== undefined && opts.label !== undefined) {
        fail('pass one of --session or --label, not both');
      }
      // Routing the label through the SAME `session` field (rather than a separate ref param)
      // bypasses runSessionCommand's env-var fallback: an explicit --label must always win, the
      // way an explicit --session already does.
      const ref = opts.label !== undefined ? { session: opts.label } : opts;
      await runSessionCommand('unregister', ref, {});
    });

  session
    .command('status')
    .description('show tracked sessions and the active account (reads the daemon db offline)')
    .action(async () => {
      const { accounts, activeId, usageFor } = await readUsageState(Date.now());
      const labelById = new Map(accounts.map((a) => [a.id, a.label] as const));

      // Read the display-only sessions mirror. Opening a not-yet-created db yields an empty one;
      // a corrupt row is skipped by sessionRowFromStore, never fatal.
      const store = new Store(daemonDbPath());
      let rows: SessionStatusRow[];
      try {
        rows = store.listSessions().map((s) => sessionRowFromStore(s, labelById));
      } finally {
        store.close();
      }

      const activeAccount = accounts.find((a) => a.id === activeId);
      const header: SessionStatusHeader = {
        ...(activeAccount ? { activeLabel: activeAccount.label } : {}),
        ...(activeId ? weeklyResetFor(usageFor(activeId)) : {}),
      };
      process.stdout.write(renderSessionStatus(rows, header, detectPalette()) + '\n');
    });
}

/** Turn one Store `sessions` row into a display row, resolving the account id to a label and
 *  tolerating a corrupt/foreign `json` blob (fields simply stay absent). */
function sessionRowFromStore(row: SessionRow, labelById: Map<string, string>): SessionStatusRow {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.json) as Record<string, unknown>;
  } catch {
    // keep the empty object — the row's top-level columns still render
  }
  const accountId =
    row.accountId ?? (typeof parsed.accountId === 'string' ? parsed.accountId : undefined);
  const out: SessionStatusRow = { id: row.id, kind: row.kind, state: row.state };
  if (typeof parsed.label === 'string') out.label = parsed.label;
  if (typeof parsed.watch === 'boolean') out.watch = parsed.watch;
  if (accountId !== undefined) out.accountLabel = labelById.get(accountId) ?? accountId;
  return out;
}

/** How long until the active account's weekly reset, for the status header — the same runway
 *  `cctl usage` shows inline. Empty when there is no usage snapshot or no known weekly reset.
 *  Returns the remaining duration, not the reset instant: the renderer is clock-free, so the
 *  subtraction has to happen here, where a real clock is already in hand. */
function weeklyResetFor(usage: AccountUsage | undefined): { weeklyResetInMs?: number } {
  if (!usage) return {};
  const nowMs = Date.now();
  const outlook = computeOutlook(timelineInputFromWire([usage]), nowMs);
  const budget = outlook.accounts[0]?.budget;
  return budget ? { weeklyResetInMs: budget.weeklyResetAt - nowMs } : {};
}

/** Shared driver for register/label/watch: resolve the session id, POST to the daemon with a
 *  fresh idempotency key, print the result — or fail with an actionable message. */
async function runSessionCommand(
  verb: SessionVerb,
  opts: { session?: string },
  extra: Record<string, unknown>,
): Promise<void> {
  const sessionId = resolveSessionId(opts);
  if (!sessionId) {
    fail(
      'could not determine the session id. Pass --session <id> - Claude Code does not reliably ' +
        'expose it to slash commands.',
    );
  }
  try {
    const result = await callDaemonSession(verb, {
      sessionId,
      idempotencyKey: randomUUID(),
      ...extra,
    });
    printSessionResult(verb, result);
  } catch (err) {
    // Every "can't reach the daemon" / daemon-4xx condition arrives as a SessionClientError with
    // a ready-to-print message; anything else is a real bug and should surface loudly.
    if (err instanceof SessionClientError) fail(err.message);
    throw err;
  }
}

/** Past-tense confirmation verb per command, for the one-line result print. */
const SESSION_VERB_PAST: Record<SessionVerb, string> = {
  register: 'Registered',
  label: 'Labeled',
  watch: 'Updated watch for',
  unregister: 'Unregistered',
};

/** Print a one-line confirmation of a session command result. */
function printSessionResult(verb: SessionVerb, result: SessionCommandSuccess): void {
  const s = result.session;
  const bits = [
    s.label !== undefined ? `label: ${s.label}` : undefined,
    `watch: ${s.watch ? 'on' : 'off'}`,
    s.accountId !== undefined ? `account: ${s.accountId}` : undefined,
  ]
    .filter((b): b is string => b !== undefined)
    .join(', ');
  // A no-change re-register must not read as if something just happened — say what IS.
  if (result.status === 'already_registered') {
    process.stdout.write(`Session ${s.id} is already registered - ${bits}. Nothing changed.\n`);
    return;
  }
  const already = result.status === 'already_handled' ? ' (already handled)' : '';
  process.stdout.write(`${SESSION_VERB_PAST[verb]} session ${s.id}${already} - ${bits}.\n`);
}
