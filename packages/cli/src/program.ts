// The `cctl` command tree.
//
// Deliberately lightweight: one-shot local commands over the switch engine, plus honest
// placeholders for the daemon-backed remote features so the surface is discoverable. Action
// bodies stay thin — the real logic lives in the engine and the pure render/resolve helpers,
// which are unit-tested; here we only wire and print.

import { Command } from 'commander';
import { QuarantineError, UnknownAccountError } from '@claude-control/switch-engine';
import { buildEngine, fail } from './context.js';
import { renderAccountsTable } from './render.js';
import { resolveAccountRef } from './resolve.js';
import { defaultPaths } from '@claude-control/switch-engine';
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
    .command('doctor')
    .description('check the local environment')
    .action(() => {
      const checks = runDoctor(defaultPaths());
      process.stdout.write(renderDoctor(checks) + '\n');
      const { passed, failed } = summarize(checks);
      process.stdout.write(`\n${passed} ok, ${failed} to look at.\n`);
    });

  // Daemon-backed remote features. Wired once the daemon ships (M1+); surfaced now so the
  // command set is discoverable and the guidance is honest rather than a silent absence.
  for (const [name, note] of [
    ['usage', 'cross-account usage needs the daemon poller'],
    ['pair', 'pairing binds this machine to the Discord bot'],
    ['run', 'remote sessions need the daemon'],
    ['daemon', 'start/stop the background daemon'],
  ] as const) {
    program
      .command(name)
      .description(`(requires daemon — coming with M1) ${note}`)
      .allowUnknownOption(true)
      .action(() => fail(`\`cctl ${name}\` requires the daemon, which is not built yet.`));
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
