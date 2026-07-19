// The `cctl` command tree.
//
// Deliberately lightweight: one-shot local commands over the switch engine, plus honest
// placeholders for the daemon-backed remote features so the surface is discoverable. Action
// bodies stay thin — the real logic lives in the engine and the pure render/resolve helpers,
// which are unit-tested; here we only wire and print.

import { Command } from 'commander';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  CadenceError,
  QuarantineError,
  SwitchEngineError,
  UnknownAccountError,
  defaultPaths,
  resolveAccountRef,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { Store, type SessionRow } from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import {
  computeOutlook,
  computePlan,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
} from '@claude-control/usage-advisor';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { runDaemon } from './daemonRun.js';
import {
  appendCrashLine,
  buildDefaultProbeFn,
  crashLogPath,
  superviseDaemon,
} from './daemonSupervise.js';
import { colorEnabled, detectPalette, outlookStyle } from './ansi.js';
import { renderAccountsTable, renderUsage, type UsageRow } from './render.js';
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
import { renderDoctor, runDoctor, summarize } from './doctor.js';
import {
  daemonSettingsPath,
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
  buildSessionCommands(program);

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
        sections.push({
          title: 'daemon (no daemon has run yet — what `cctl daemon run` would use)',
          rows: resolveDaemonConfig(process.env).rows,
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
      'control-plane WebSocket url (default CCTL_RELAY_URL or ws://127.0.0.1:8765)',
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
        await runDaemon(opts);
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
    .option('--auto-switch', 'forwarded to `daemon run` — see its help')
    .option('--greedy', 'forwarded to `daemon run` — see its help')
    .action(
      async (opts: { pair?: string; relay?: string; autoSwitch?: boolean; greedy?: boolean }) => {
        if (opts.greedy && !opts.autoSwitch) fail('--greedy requires --auto-switch.');
        // Reconstruct the child argv from the parsed flags: the supervisor and `daemon run`
        // deliberately share an option surface so nothing can be forwarded wrong.
        const childArgs = [
          'daemon',
          'run',
          ...(opts.pair !== undefined ? ['--pair', opts.pair] : []),
          ...(opts.relay !== undefined ? ['--relay', opts.relay] : []),
          ...(opts.autoSwitch ? ['--auto-switch'] : []),
          ...(opts.greedy ? ['--greedy'] : []),
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

  // Remote-control features that require the running daemon connected to the hosted bot —
  // an inherently on-machine step. Surfaced now so the command set is discoverable and
  // the guidance is honest rather than a silent absence. See docs/VERIFICATION.md.
  program
    .command('pair')
    .description('bind this machine to the Discord bot')
    .action(() =>
      fail(
        'run /pair in Discord for a code, then `cctl daemon run --pair <code>` — pairing happens on the daemon connection.',
      ),
    );
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

  return program;
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
 * The `--fresh` capture flow: run an interactive `claude` inside a
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
      shell: true, // `claude` is a .cmd shim on Windows
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
  const captureDir = join(dirname(paths.vaultDir), `relogin-${randomUUID()}`);
  mkdirSync(captureDir, { recursive: true });
  try {
    process.stdout.write(
      `Re-logging in "${account.label}" (${account.id}). A throwaway Claude window will open.\n` +
        '  1. /login — pick the SAME account this entry belongs to (attribution is preserved).\n' +
        '  2. Send one short message so the login completes.\n' +
        '  3. /exit\n\n',
    );
    const run = spawnSync('claude', [], {
      stdio: 'inherit',
      env: { ...process.env, CLAUDE_CONFIG_DIR: captureDir },
      shell: true, // `claude` is a .cmd shim on Windows
    });
    if (run.error) fail(`could not launch \`claude\`: ${run.error.message}`);
    const updated = await engine.reloginFromConfigDir(account.id, captureDir);
    process.stdout.write(
      `Re-logged in ${updated.label} (${updated.id}). Quarantine cleared; usage history kept — ` +
        `\`cctl switch ${updated.label}\` to use it.\n`,
    );
  } catch (err) {
    // no_capture_login (login never completed) and relogin_identity_mismatch (wrong account) are
    // expected, actionable failures — print the engine's message, don't stack-trace.
    if (err instanceof SwitchEngineError) fail(err.message);
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
    .command('relogin <ref>')
    .description('re-login an existing (usually quarantined) account in place, keeping its id')
    .action(async (ref: string) => {
      await reloginAccount(ref);
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
function buildSessionCommands(program: Command): void {
  const session = program
    .command('session')
    .description('track/label/stream the current Claude Code session, and show tracked sessions');

  const sessionIdOption = '--session <id>';
  const sessionIdHelp =
    'session id (Claude Code does not reliably expose it to slash commands — pass it explicitly)';

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
    .option(sessionIdOption, sessionIdHelp)
    .action(async (name: string, opts: { session?: string }) => {
      await runSessionCommand('label', opts, { label: name });
    });

  session
    .command('watch')
    .description('stream this session to Discord (use --off to stop streaming it)')
    .option(sessionIdOption, sessionIdHelp)
    .option('--off', 'turn per-session streaming OFF (default is on)')
    .action(async (opts: { session?: string; off?: boolean }) => {
      await runSessionCommand('watch', opts, { watch: !opts.off });
    });

  session
    .command('unregister')
    .description("remove a session from the daemon's tracking (undo register, e.g. a mistyped id)")
    .option(sessionIdOption, sessionIdHelp)
    .action(async (opts: { session?: string }) => {
      await runSessionCommand('unregister', opts, {});
    });

  session
    .command('status')
    .description('show tracked sessions and the active account (reads the daemon db offline)')
    .action(async () => {
      const { accounts, activeId, usageFor } = await readUsageState();
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
        ...(activeId ? fullWindowsFor(usageFor(activeId)) : {}),
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

/** The active account's whole-5h-windows-left, for the status header — same computation `cctl
 *  usage` shows inline. Empty when there is no usage snapshot or no known weekly reset. */
function fullWindowsFor(usage: AccountUsage | undefined): { fullWindowsLeft?: number } {
  if (!usage) return {};
  const outlook = computeOutlook(timelineInputFromWire([usage]), Date.now());
  const budget = outlook.accounts[0]?.budget;
  return budget ? { fullWindowsLeft: budget.fullWindows } : {};
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
      'could not determine the session id. Pass --session <id> — Claude Code does not reliably ' +
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
    process.stdout.write(`Session ${s.id} is already registered — ${bits}. Nothing changed.\n`);
    return;
  }
  const already = result.status === 'already_handled' ? ' (already handled)' : '';
  process.stdout.write(`${SESSION_VERB_PAST[verb]} session ${s.id}${already} — ${bits}.\n`);
}
