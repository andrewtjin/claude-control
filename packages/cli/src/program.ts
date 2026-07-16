// The `cctl` command tree.
//
// Deliberately lightweight: one-shot local commands over the switch engine, plus honest
// placeholders for the daemon-backed remote features so the surface is discoverable. Action
// bodies stay thin — the real logic lives in the engine and the pure render/resolve helpers,
// which are unit-tested; here we only wire and print.

import { Command } from 'commander';
import { QuarantineError, UnknownAccountError, defaultPaths } from '@claude-control/switch-engine';
import { Store } from '@claude-control/daemon';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { buildEngine, daemonDbPath, fail } from './context.js';
import { renderAccountsTable, renderUsage, type UsageRow } from './render.js';
import { resolveAccountRef } from './resolve.js';
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
    .action(async (ref: string) => {
      const engine = buildEngine();
      const resolved = resolveAccountRef(await engine.listAccounts(), ref);
      if (!resolved.ok) fail(resolved.message);
      try {
        const result = await engine.activate(resolved.account.id);
        const bits = [
          result.wroteCredentials ? 'credentials written' : 'no change',
          result.refreshed ? 'token refreshed' : null,
          result.adoptedPreviousRotation ? 'adopted previous rotation' : null,
        ].filter(Boolean);
        process.stdout.write(`Activated ${resolved.account.label} (${bits.join(', ')}).\n`);
      } catch (err) {
        if (err instanceof QuarantineError)
          fail(`${resolved.account.label} is quarantined; re-login required.`);
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

  // Remote-control features that require the running daemon connected to the hosted bot —
  // an inherently on-machine (wet) step. Surfaced now so the command set is discoverable and
  // the guidance is honest rather than a silent absence. See docs/VERIFICATION.md.
  for (const [name, note] of [
    ['pair', 'bind this machine to the Discord bot (run /pair there for a code)'],
    ['run', 'start a remote session (drive it from Discord)'],
    ['daemon', 'run the background daemon (poller + control-plane connection)'],
  ] as const) {
    program
      .command(name)
      .description(`(needs the running daemon + hosted bot) ${note}`)
      .allowUnknownOption(true)
      .action(() =>
        fail(
          `\`cctl ${name}\` needs the daemon connected to the bot — an on-machine step; see docs/VERIFICATION.md.`,
        ),
      );
  }

  return program;
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
    .action(async (label: string) => {
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
