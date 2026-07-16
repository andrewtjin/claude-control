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
import { dirname, join } from 'node:path';
import {
  CadenceError,
  QuarantineError,
  SwitchEngineError,
  UnknownAccountError,
  defaultPaths,
  resolveAccountRef,
} from '@claude-control/switch-engine';
import { Store } from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { runDaemon } from './daemonRun.js';
import { renderAccountsTable, renderUsage, type UsageRow } from './render.js';
import { renderDoctor, runDoctor, summarize } from './doctor.js';

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
      const engine = buildEngine();
      const [accounts, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
      // Read-only view of the daemon's persisted snapshots; works whether or not the daemon is
      // currently running (it shows the last poll). Opening a not-yet-created db just yields an
      // empty one, which renders as "no usage data yet".
      const store = new Store(daemonDbPath());
      try {
        const rows: UsageRow[] = accounts.map((a) => {
          const row = store.latestUsageSnapshot(a.id);
          let usage: AccountUsage | undefined;
          if (row) {
            try {
              usage = JSON.parse(row.json) as AccountUsage;
            } catch {
              usage = undefined; // a corrupt row must not crash the whole view
            }
          }
          return { label: a.label, active: a.id === activeId, usage };
        });
        process.stdout.write(renderUsage(rows, Date.now()) + '\n');
      } finally {
        store.close();
      }
    });

  program
    .command('doctor')
    .description('check the local environment')
    .action(() => {
      const checks = runDoctor(defaultPaths());
      process.stdout.write(renderDoctor(checks) + '\n');
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
    .action(async (opts: { pair?: string; relay?: string }) => {
      await runDaemon(opts);
    });

  // Remote-control features that require the running daemon connected to the hosted bot —
  // an inherently on-machine (wet) step. Surfaced now so the command set is discoverable and
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

function buildAccountCommands(program: Command): void {
  const accounts = program.command('accounts').description('manage stored accounts');

  accounts
    .command('list')
    .alias('ls')
    .description('list stored accounts')
    .action(async () => {
      const engine = buildEngine();
      const [list, activeId] = await Promise.all([engine.listAccounts(), engine.getActiveId()]);
      process.stdout.write(renderAccountsTable(list, activeId) + '\n');
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
