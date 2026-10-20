// `cctl export` / `cctl import` end to end: two sandboxed "machines" (each its own vault, config
// and main config dir, with a real engine over a pass-through protector), a sealed file between
// them, and the registry, rules and settings compared on both sides.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  CredentialStore,
  FileCredentialChannel,
  ImportInterruptedError,
  InsecurePassthroughProtector,
  LockTimeoutError,
  SwitchEngine,
  Vault,
  VaultError,
  acquireLock,
  groupProfileDir,
  ruleSlotId,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { CliFailure } from './context.js';
import { SCRYPT_LIMITS, sealExport } from './exportEnvelope.js';
import { shellQuote } from './folderRender.js';
import { renderAccountsTable } from './render.js';
import {
  ONE_MACHINE_WARNING,
  readCapped,
  resolveFolderHere,
  runExport,
  runImport,
  writeNewFileDurably,
  type ExportOptions,
  type TransferDeps,
  type TransferEngine,
} from './accountTransfer.js';

const HOUR = 3_600_000;
const PASS = 'a long enough passphrase';

let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

interface Machine {
  root: string;
  paths: Paths;
  engine: SwitchEngine;
  vault: Vault;
  configPath: string;
  /** Everything the commands reported. */
  out: string[];
  /** What `-` wrote to standard output. */
  stdout: string[];
  guardRuns: number;
  deps: TransferDeps;
}

/** A sandboxed machine. Token refreshes are marked, so a test can tell one happened. */
async function machine(overrides: Partial<TransferDeps> = {}): Promise<Machine> {
  const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-xfer-')));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const protector = new InsecurePassthroughProtector();
  const engine = new SwitchEngine({
    paths,
    protector,
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) =>
      Promise.resolve({ ...cur, accessToken: 'NETWORK-' + cur.accessToken }),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 15_000, pollMs: 20 },
  });
  const m: Machine = {
    root,
    paths,
    engine,
    vault: new Vault(paths.vaultDir, protector),
    configPath: join(root, 'config.json'),
    out: [],
    stdout: [],
    guardRuns: 0,
    deps: undefined as unknown as TransferDeps,
  };
  m.deps = {
    engine,
    configPath: m.configPath,
    out: (text) => void m.out.push(text),
    writeStdout: (text) => void m.stdout.push(text),
    writeExportFile: (path, text) => writeFile(path, text, { flag: 'wx', mode: 0o600 }),
    readExportFile: (path) => readFile(path, 'utf8'),
    readStdin: () => Promise.reject(new Error('no stdin in this test')),
    env: { CCTL_EXPORT_PASSPHRASE: PASS },
    interactive: false,
    promptHidden: () => Promise.reject(new Error('no prompt in this test')),
    confirm: () => Promise.resolve(false),
    reconcileGuard: () => {
      m.guardRuns += 1;
      return Promise.resolve();
    },
    rulesBlocked: () => Promise.resolve({}),
    resolveFolder: (folder) => resolveFolderHere(folder, process.platform),
    afterSettings: () => Promise.resolve(),
    platform: process.platform,
    clock: Date.now,
    scrypt: { N: SCRYPT_LIMITS.minN, r: 8, p: 1 },
    ...overrides,
  };
  return m;
}

function bundle(
  access: string,
  uuid: string,
  expiresAt = Date.now() + 10 * HOUR,
): CredentialBundle {
  return {
    claudeAiOauth: { accessToken: access, refreshToken: 'r-' + access, expiresAt },
    oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com` },
  };
}

/** A real folder under the machine's sandbox. */
async function folder(m: Machine, name: string): Promise<string> {
  const p = join(m.root, 'work', name);
  await mkdir(p, { recursive: true });
  return realpathSync.native(p);
}

const exportAll: ExportOptions = { tokens: true, move: false, yes: false };

/** Machine A's fleet: three accounts (one excluded from auto-switch), a folder rule with a chosen
 *  name, an exclude-only folder rule, a session-alias rule, and persisted settings. */
async function seedSource(a: Machine): Promise<{ proj: string; other: string }> {
  const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
  const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
  const spare = await a.engine.addAccount('spare', bundle('S1', 'u-spare'));
  await a.engine.setAutoSwitchExcluded(spare.id, true);
  const proj = await folder(a, 'proj');
  const other = await folder(a, 'other');
  await a.engine.includeInFolder(proj, [work.id], { label: 'Client' });
  await a.engine.includeInAlias(proj, 'Big Job', [spare.id]);
  await a.engine.excludeInFolder(other, [home.id]);
  await writeFile(
    a.configPath,
    JSON.stringify({
      relayUrl: 'wss://relay.example',
      env: { CCTL_AUTOSWITCH: 'off', CCTL_LOG_FILE: join(a.root, 'd.log') },
    }),
  );
  return { proj, other };
}

/** The registry as a comparable picture: accounts by label with their identity, flags and access
 *  token, and rules with their scopes and members by label — no ids. */
async function picture(m: Machine): Promise<unknown> {
  const accounts = await m.engine.listAllAccounts();
  const labelOf = (id: string): string => accounts.find((a) => a.id === id)?.label ?? `?${id}`;
  const rows = await Promise.all(
    accounts.map(async (a) => ({
      label: a.label,
      accountUuid: a.accountUuid,
      emailAddress: a.emailAddress,
      excluded: a.autoSwitchExcluded === true,
      quarantined: a.quarantined,
      token: await m.vault
        .readBundle(a.id)
        .then((b) => b.claudeAiOauth.accessToken)
        .catch(() => null),
    })),
  );
  const rules = (await m.engine.listRules()).map((r) => ({
    label: r.label,
    folders: r.folders,
    aliases: r.aliases ?? [],
    include: r.include.map(labelOf),
    exclude: r.exclude.map(labelOf),
  }));
  const sort = <T extends { label: string }>(xs: T[]): T[] =>
    [...xs].sort((x, y) => x.label.localeCompare(y.label));
  return { accounts: sort(rows), rules: sort(rules) };
}

/** The message a run is refused with. */
async function refusal(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (err) {
    expect(err).toBeInstanceOf(CliFailure);
    return (err as Error).message;
  }
  throw new Error('expected a refusal');
}

describe('export then import', () => {
  it('rebuilds the same registry, rules and settings on an empty machine', async () => {
    const a = await machine();
    await seedSource(a);
    const file = join(a.root, 'fleet.cctl');
    expect(await runExport(file, exportAll, a.deps)).toEqual({ failed: 0 });
    expect(a.out.join('')).toContain(
      'Exported 3 accounts (3 with tokens), 3 rules and 1 setting(s)',
    );
    expect(a.out.join('')).toContain(ONE_MACHINE_WARNING);
    // The file holds no token in the clear.
    expect(await readFile(file, 'utf8')).not.toContain('r-W1');

    const b = await machine();
    expect(await runImport(file, { dryRun: false, replace: false }, b.deps)).toEqual({ failed: 0 });
    expect(await picture(b)).toEqual(await picture(a));
    expect(b.guardRuns).toBe(1);
    const config = JSON.parse(await readFile(b.configPath, 'utf8')) as {
      relayUrl?: string;
      env?: Record<string, string>;
    };
    // The relay stays behind: it is paired to the machine that exported.
    expect(config).toEqual({ env: { CCTL_AUTOSWITCH: 'off' } });
    const report = b.out.join('');
    expect(report).toContain(
      'Changed settings apply when the daemon next starts: cctl daemon restart',
    );
    expect(report).toContain(ONE_MACHINE_WARNING);
    expect(report).not.toContain('CCTL_LOG_FILE');
  });

  it('is a no-op the second time', async () => {
    const a = await machine();
    await seedSource(a);
    const file = join(a.root, 'fleet.cctl');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    const once = await picture(b);
    const rulesFile = await readFile(join(b.paths.vaultDir, 'groups.json'), 'utf8');

    b.out.length = 0;
    expect(await runImport(file, { dryRun: false, replace: false }, b.deps)).toEqual({ failed: 0 });
    expect(await picture(b)).toEqual(once);
    expect(await readFile(join(b.paths.vaultDir, 'groups.json'), 'utf8')).toBe(rulesFile);
    const report = b.out.join('');
    expect(report).toContain('work: already stored here - left as it is');
    expect(report).toContain('this machine already has this rule, with these accounts');
    expect(report).toContain('CCTL_AUTOSWITCH=off: already set');
    expect(report).not.toContain('cctl daemon restart');
    expect(report).not.toContain(ONE_MACHINE_WARNING);
  });

  it('prints the plan and changes nothing on a dry run', async () => {
    const a = await machine();
    await seedSource(a);
    const file = join(a.root, 'fleet.cctl');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await runImport(file, { dryRun: true, replace: false }, b.deps);
    expect(await b.engine.listAllAccounts()).toEqual([]);
    expect(existsSync(b.configPath)).toBe(false);
    const report = b.out.join('');
    expect(report).toContain('work: add, with its tokens');
    expect(report).toContain('Nothing was changed (dry run).');
  });

  it('skips rules whose folders do not exist on the importing machine, and says so', async () => {
    const a = await machine();
    const { other } = await seedSource(a);
    const file = join(a.root, 'fleet.cctl');
    await runExport(file, exportAll, a.deps);
    await rm(other, { recursive: true, force: true });
    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    expect((await b.engine.listRules()).map((r) => r.label).sort()).toEqual(
      ['Client', `session "Big Job" in ${join(a.root, 'work', 'proj')}`].sort(),
    );
    expect(b.out.join('')).toContain('skipped - the folder does not exist on this machine');
  });

  it('exports only the named accounts, with their rule memberships', async () => {
    const a = await machine();
    await seedSource(a);
    const file = join(a.root, 'some.cctl');
    await runExport(file, { ...exportAll, accounts: 'work, u-home@x.com' }, a.deps);
    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    expect((await b.engine.listAllAccounts()).map((x) => x.label).sort()).toEqual(['home', 'work']);
    // The alias rule's only member (spare) did not travel, so neither did the rule.
    expect((await b.engine.listRules()).length).toBe(2);
  });

  it('writes to standard output and reads from standard input', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    await runExport('-', exportAll, a.deps);
    expect(a.stdout).toHaveLength(1);
    const b = await machine({ readStdin: () => Promise.resolve(a.stdout[0]!) });
    await runImport('-', { dryRun: false, replace: false }, b.deps);
    expect((await b.engine.listAllAccounts()).map((x) => x.label)).toEqual(['work']);
  });
});

describe('without tokens', () => {
  it('stores accounts waiting for a login and lists the relogin for each', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'bare.cctl');
    await runExport(file, { ...exportAll, tokens: false }, a.deps);
    expect(a.out.join('')).not.toContain(ONE_MACHINE_WARNING);

    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    const [row] = await b.engine.listAllAccounts();
    expect(row).toMatchObject({ label: 'work', accountUuid: 'u-work', quarantined: true });
    await expect(b.vault.readBundle(row!.id)).rejects.toThrow();
    const report = b.out.join('');
    expect(report).toContain(
      `Log in to each account that came without tokens:\n  cctl accounts relogin ${shellQuote('work')}`,
    );
    expect(report).not.toContain(ONE_MACHINE_WARNING);
  });

  it('carries a quarantined account without its dead tokens', async () => {
    const a = await machine();
    const dead = await a.engine.addAccount('dead', bundle('D1', 'u-dead'));
    await a.vault.quarantine(dead.id, 'refresh token died');
    const file = join(a.root, 'q.cctl');
    await runExport(file, exportAll, a.deps);
    expect(a.out.join('')).toContain('Quarantined here, so exported without tokens');
    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    expect(b.out.join('')).toContain(`cctl accounts relogin ${shellQuote('dead')}`);
  });
});

describe('collisions', () => {
  it('numbers a label taken by another login', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f.cctl');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await b.engine.addAccount('work', bundle('B1', 'u-b-work'));
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    expect((await b.engine.listAllAccounts()).map((x) => x.label).sort()).toEqual([
      'work',
      'work (2)',
    ]);
    expect(b.out.join('')).toContain('work (2): added (the label "work" is taken here)');
  });

  it('--replace takes newer tokens, keeps newer stored ones, and repairs a quarantined login', async () => {
    const a = await machine();
    const now = Date.now();
    await a.engine.addAccount('newer', bundle('A-new', 'u-1', now + 9 * HOUR));
    await a.engine.addAccount('older', bundle('A-old', 'u-2', now + 1 * HOUR));
    await a.engine.addAccount('fixme', bundle('A-fix', 'u-3', now + 1 * HOUR));
    const file = join(a.root, 'f.cctl');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    await b.engine.addAccount('newer', bundle('B-new', 'u-1', now + 2 * HOUR));
    await b.engine.addAccount('older', bundle('B-old', 'u-2', now + 5 * HOUR));
    const q = await b.engine.addAccount('fixme', bundle('B-fix', 'u-3', now + 5 * HOUR));
    await b.vault.quarantine(q.id, 'refresh token died');

    // Without --replace nothing stored is touched.
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    const tokens = async (): Promise<Record<string, string | null>> => {
      const pic = (await picture(b)) as { accounts: { label: string; token: string | null }[] };
      return Object.fromEntries(pic.accounts.map((x) => [x.label, x.token]));
    };
    expect(await tokens()).toEqual({ newer: 'B-new', older: 'B-old', fixme: 'B-fix' });

    b.out.length = 0;
    expect(await runImport(file, { dryRun: false, replace: true }, b.deps)).toEqual({ failed: 0 });
    expect(await tokens()).toEqual({ newer: 'A-new', older: 'B-old', fixme: 'A-fix' });
    expect((await b.vault.getAccount(q.id))?.quarantined).toBe(false);
    const report = b.out.join('');
    expect(report).toContain("newer: tokens replaced (the file's were newer)");
    expect(report).toContain('older: kept - the tokens stored here are as new');
    expect(report).toContain('fixme: tokens replaced (the stored login was quarantined)');
  });
});

describe('rules', () => {
  it('keeps exclusions the source keeps on record for accounts its other rules reserve', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const spare = await a.engine.addAccount('spare', bundle('S1', 'u-spare'));
    const other = await folder(a, 'other');
    const both = await folder(a, 'both');
    const proj = await folder(a, 'proj');
    // Excluded first, reserved after: the exclusion stays on record, inert until home is released.
    await a.engine.excludeInFolder(other, [home.id]);
    await a.engine.excludeInFolder(both, [home.id]);
    await a.engine.includeInFolder(both, [spare.id]);
    await a.engine.includeInFolder(proj, [home.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    expect(await runImport(file, { dryRun: false, replace: false }, b.deps)).toEqual({ failed: 0 });
    const report = b.out.join('');
    expect(report).toContain(`folder ${other}: created, exclude home`);
    expect(report).toContain(`folder ${both}: created, include spare; exclude home`);
    expect(report).toContain(`folder ${proj}: created, include home`);
    expect(await picture(b)).toEqual(await picture(a));
  });
});

describe('refusals', () => {
  it('a wrong passphrase imports nothing', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f.cctl');
    await runExport(file, exportAll, a.deps);
    const b = await machine({ env: { CCTL_EXPORT_PASSPHRASE: 'not the passphrase' } });
    expect(await refusal(runImport(file, { dryRun: false, replace: false }, b.deps))).toBe(
      'the passphrase does not open this file, or its key settings were changed; nothing was imported',
    );
    expect(await b.engine.listAllAccounts()).toEqual([]);
  });

  it('a changed file imports nothing', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f.cctl');
    await runExport(file, exportAll, a.deps);
    const env = JSON.parse(await readFile(file, 'utf8')) as { ct: string };
    const ct = Buffer.from(env.ct, 'base64');
    ct[3] = ct[3]! ^ 0xff;
    await writeFile(file, JSON.stringify({ ...env, ct: ct.toString('base64') }));
    const b = await machine();
    expect(await refusal(runImport(file, { dryRun: false, replace: false }, b.deps))).toContain(
      'changed after it was written',
    );
    expect(await b.engine.listAllAccounts()).toEqual([]);
  });

  it('never overwrites an existing file', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f.cctl');
    await writeFile(file, 'keep me');
    expect(await refusal(runExport(file, exportAll, a.deps))).toContain('already exists');
    expect(await readFile(file, 'utf8')).toBe('keep me');
  });

  it('asks for a passphrase it can use', async () => {
    const a = await machine({ env: {} });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    expect(await refusal(runExport(join(a.root, 'f'), exportAll, a.deps))).toContain(
      'no passphrase',
    );
    const short = await machine({ env: { CCTL_EXPORT_PASSPHRASE: 'short' } });
    await short.engine.addAccount('work', bundle('W1', 'u-work'));
    expect(await refusal(runExport(join(short.root, 'f'), exportAll, short.deps))).toContain(
      'at least 8',
    );
  });

  it('reads the passphrase from a file, and asks twice on a terminal', async () => {
    const a = await machine({ env: {} });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const passFile = join(a.root, 'pass.txt');
    await writeFile(passFile, PASS + '\r\nignored second line');
    await runExport(join(a.root, 'f1'), { ...exportAll, passphraseFile: passFile }, a.deps);

    const answers = [PASS, PASS + 'x'];
    const tty = await machine({
      env: {},
      interactive: true,
      promptHidden: () => Promise.resolve(answers.shift()!),
    });
    await tty.engine.addAccount('work', bundle('W1', 'u-work'));
    expect(await refusal(runExport(join(tty.root, 'f2'), exportAll, tty.deps))).toContain(
      'the two passphrases differ',
    );
    expect(existsSync(join(tty.root, 'f2'))).toBe(false);

    const b = await machine({ env: {} });
    await runImport(
      join(a.root, 'f1'),
      { dryRun: false, replace: false, passphraseFile: passFile },
      b.deps,
    );
    expect((await b.engine.listAllAccounts()).map((x) => x.label)).toEqual(['work']);
  });
});

describe('--move', () => {
  it('removes the exported accounts only after the file reads back, with their rules', async () => {
    const a = await machine({ confirm: () => Promise.resolve(true), interactive: true });
    await seedSource(a);
    const file = join(a.root, 'm.cctl');
    await runExport(file, { ...exportAll, move: true }, a.deps);
    expect(await a.engine.listAllAccounts()).toEqual([]);
    expect(await a.engine.listRules()).toEqual([]);
    expect(a.guardRuns).toBe(1);
    expect(a.out.join('')).toContain('Removed home, work, spare from this machine.');

    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    expect((await b.engine.listAllAccounts()).length).toBe(3);
  });

  it('removes nothing when the file does not read back as written', async () => {
    // A disk that does not keep what it was given: the ciphertext's first character changes.
    const a = await machine({
      writeExportFile: (path, text) =>
        writeFile(
          path,
          text.replace(/"ct": "(.)/, (_m, c: string) => `"ct": "${c === 'A' ? 'B' : 'A'}`),
          {
            flag: 'wx',
          },
        ),
    });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const msg = await refusal(
      runExport(join(a.root, 'm'), { ...exportAll, move: true, yes: true }, a.deps),
    );
    expect(msg).toContain('nothing was removed');
    expect((await a.engine.listAllAccounts()).map((x) => x.label)).toEqual(['work']);
  });

  it('removes nothing when the answer is no', async () => {
    const a = await machine({ interactive: true, confirm: () => Promise.resolve(false) });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'm');
    await runExport(file, { ...exportAll, move: true }, a.deps);
    expect(existsSync(file)).toBe(true);
    expect(a.out.join('')).toContain('Nothing was removed; the file is kept.');
    expect((await a.engine.listAllAccounts()).length).toBe(1);
  });

  it('refuses before writing anything when it cannot finish', async () => {
    const a = await machine();
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    await a.engine.addAccount('home', bundle('H1', 'u-home'));
    expect(await refusal(runExport('-', { ...exportAll, move: true }, a.deps))).toContain(
      '--move needs a file',
    );
    expect(
      await refusal(runExport(join(a.root, 'm'), { ...exportAll, move: true }, a.deps)),
    ).toContain('pass --yes');
    await a.engine.activate(work.id);
    const msg = await refusal(
      runExport(join(a.root, 'm'), { ...exportAll, move: true, yes: true }, a.deps),
    );
    expect(msg).toContain('"work" is the live account');
    expect(msg).toContain('cctl switch <account>');
    expect(existsSync(join(a.root, 'm'))).toBe(false);
    expect((await a.engine.listAllAccounts()).length).toBe(2);
  });
});

describe('freshest tokens and the lock', () => {
  it('exports the rotation a live session made, not the older vault copy', async () => {
    const a = await machine();
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    await a.engine.activate(work.id);
    const live = new FileCredentialChannel(a.paths.credentialsPath);
    await live.writeLiveCredentials({
      accessToken: 'W2',
      refreshToken: 'r-W2',
      expiresAt: Date.now() + 20 * HOUR,
    });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await runImport(file, { dryRun: false, replace: false }, b.deps);
    const [row] = await b.engine.listAllAccounts();
    expect((await b.vault.readBundle(row!.id)).claudeAiOauth.refreshToken).toBe('r-W2');
  });

  it('waits for a lock another process holds, then imports intact', async () => {
    const a = await machine();
    await seedSource(a);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    // A daemon holding the credential lock for five seconds.
    const lock = await acquireLock(join(b.paths.vaultDir, '.lock'), Date.now);
    const started = Date.now();
    const release = setTimeout(() => lock.release(), 5_000);
    try {
      expect(await runImport(file, { dryRun: false, replace: false }, b.deps)).toEqual({
        failed: 0,
      });
    } finally {
      clearTimeout(release);
      lock.release();
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
    expect(await picture(b)).toEqual(await picture(a));
  }, 30_000);
});

describe('the commands', () => {
  it('are registered with the documented options', async () => {
    const { buildProgram } = await import('./program.js');
    const program = buildProgram();
    const flags = (name: string): string[] =>
      program.commands.find((c) => c.name() === name)!.options.map((o) => o.long ?? '');
    expect(flags('export')).toEqual([
      '--accounts',
      '--no-tokens',
      '--move',
      '--yes',
      '--passphrase-file',
    ]);
    expect(flags('import')).toEqual(['--dry-run', '--replace', '--passphrase-file']);
  });
});

// ---------------------------------------------------------------------------
// Files someone else wrote, and the edges of moving a fleet
// ---------------------------------------------------------------------------

const FAST_SCRYPT = { N: SCRYPT_LIMITS.minN, r: 8, p: 1 };

/** A payload as a file from another machine could carry it, with the defaults filled in. */
function filePayload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    exportedAtMs: Date.now(),
    cctlVersion: '1.1.0',
    platform: process.platform,
    accounts: [],
    rules: [],
    settings: { env: {} },
    ...extra,
  };
}

/** Seal a hand-made payload under the test passphrase into a file of `m`. */
async function sealedFile(m: Machine, payload: unknown, name = 'crafted.cctl'): Promise<string> {
  const file = join(m.root, name);
  await writeFile(file, await sealExport(JSON.stringify(payload), PASS, FAST_SCRYPT));
  return file;
}

/** Import `file` into `m`. */
function importInto(
  m: Machine,
  file: string,
  opts: { dryRun?: boolean; replace?: boolean } = {},
): ReturnType<typeof runImport> {
  return runImport(file, { dryRun: false, replace: false, ...opts }, m.deps);
}

/** The engine with some verbs swapped, every other one bound to the real engine. */
function engineWith(engine: SwitchEngine, over: Partial<SwitchEngine>): TransferEngine {
  return new Proxy(engine, {
    get(target, prop) {
      if (prop in over) return over[prop as keyof SwitchEngine];
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
    },
  });
}

/** The config.json `m` holds. */
async function configOf(m: Machine): Promise<{ relayUrl?: string; env?: Record<string, string> }> {
  return JSON.parse(await readFile(m.configPath, 'utf8')) as {
    relayUrl?: string;
    env?: Record<string, string>;
  };
}

/** The rules of a machine's picture. */
async function rulesOf(m: Machine): Promise<{ include: string[]; exclude: string[] }[]> {
  return ((await picture(m)) as { rules: { include: string[]; exclude: string[] }[] }).rules;
}

describe('machine-local settings', () => {
  it('never takes the relay from the file', async () => {
    const b = await machine();
    await writeFile(b.configPath, JSON.stringify({ relayUrl: 'wss://mine.example', env: {} }));
    const file = await sealedFile(
      b,
      filePayload({
        settings: {
          relayUrl: 'ws://evil.example:80',
          env: { CCTL_RELAY_URL: 'ws://evil.example:81' },
        },
      }),
    );
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect((await configOf(b)).relayUrl).toBe('wss://mine.example');
    expect(b.out.join('')).toContain('CCTL_RELAY_URL: skipped');
  });

  it('keeps a setting this machine already has, unless --replace', async () => {
    const b = await machine();
    await writeFile(b.configPath, JSON.stringify({ env: { CCTL_BIND_ENFORCE: 'off' } }));
    const file = await sealedFile(
      b,
      filePayload({ settings: { env: { CCTL_BIND_ENFORCE: 'warn', CCTL_AUTOSWITCH: 'off' } } }),
    );
    await importInto(b, file);
    expect((await configOf(b)).env).toEqual({ CCTL_BIND_ENFORCE: 'off', CCTL_AUTOSWITCH: 'off' });
    expect(b.out.join('')).toContain('CCTL_BIND_ENFORCE=warn: skipped - this machine has off');
    await importInto(b, file, { replace: true });
    expect((await configOf(b)).env).toEqual({ CCTL_BIND_ENFORCE: 'warn', CCTL_AUTOSWITCH: 'off' });
  });

  it('says that a value set in the environment still wins over the saved one', async () => {
    const b = await machine({ env: { CCTL_EXPORT_PASSPHRASE: PASS, CCTL_AUTOSWITCH: '1' } });
    const file = await sealedFile(
      b,
      filePayload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
    );
    await importInto(b, file);
    const report = b.out.join('');
    expect(report).toContain('CCTL_AUTOSWITCH=off: saved (the environment here sets it, and wins)');
    expect(report).toContain('A value set in the environment still wins over the file.');
  });
});

describe('folders named by a file', () => {
  it('never looks up a network folder or a path from another platform', () => {
    const touched: string[] = [];
    const fs = {
      realpath: (p: string): string => {
        touched.push(p);
        return p;
      },
      isDirectory: (p: string): boolean => {
        touched.push(p);
        return true;
      },
    };
    for (const f of [
      '\\\\attacker.example\\share\\x',
      '//attacker.example/share/x',
      '\\\\?\\UNC\\attacker.example\\share\\x',
      '/srv/app',
    ]) {
      expect(resolveFolderHere(f, 'win32', fs).ok).toBe(false);
    }
    expect(resolveFolderHere('C:\\work', 'linux', fs).ok).toBe(false);
    expect(touched).toEqual([]);
    expect(resolveFolderHere('C:\\work', 'win32', fs)).toEqual({ ok: true, folder: 'C:\\work' });
  });

  it('has a dry run that names the folders the real run refuses', async () => {
    const b = await machine();
    // The machine's own root holds its vault: no rule may cover it.
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [{ label: 'f', accountUuid: 'u-f', autoSwitchExcluded: false }],
        rules: [{ label: 'r', folders: [b.root], aliases: [], include: ['u-f'], exclude: [] }],
      }),
    );
    const why = `folder ${b.root}: skipped - cannot give "${b.root}" a folder rule: overlaps the cctl vault directory`;
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain(why);
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain(why);
  });

  it('has a dry run whose rule lines the real run then reports as done', async () => {
    const a = await machine();
    await seedSource(a);
    // home, excluded from "other" first, is reserved here after: that exclusion stays on record.
    const home = (await a.engine.listAllAccounts()).find((r) => r.label === 'home')!;
    await a.engine.includeInFolder(await folder(a, 'proj2'), [home.id]);
    const file = join(a.root, 'fleet.cctl');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await importInto(b, file, { dryRun: true });
    const planned = b.out
      .join('')
      .split('\n')
      .filter((l) => l.includes(': create, '));
    expect(planned.length).toBe(4);
    b.out.length = 0;
    await importInto(b, file);
    const report = b.out.join('');
    for (const line of planned) expect(report).toContain(line.replace(': create, ', ': created, '));
  });

  it('prints a plan for a large file without multiplying its members by its scopes', async () => {
    const b = await machine();
    const there = await folder(b, 'many');
    const label = 'L'.repeat(1000);
    const rules = Array.from({ length: 4 }, (_, r) => ({
      label: `r${r}`,
      folders: [],
      aliases: Array.from({ length: 256 }, (_x, j) => ({ folder: there, alias: `s${r}_${j}` })),
      include: Array.from({ length: 32 }, () => 'u-a'),
      exclude: [],
    }));
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [{ label, accountUuid: 'u-a', autoSwitchExcluded: false }],
        rules,
      }),
    );
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('').length).toBeLessThan(2_000_000);
  });
});

describe('passphrase files and re-encoded files', () => {
  it('reads a passphrase file written with a byte-order mark or as UTF-16', async () => {
    const forms = [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(PASS + '\r\n')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PASS + '\r\n', 'utf16le')]),
    ];
    for (const bytes of forms) {
      const a = await machine({ env: {} });
      await a.engine.addAccount('work', bundle('W1', 'u-work'));
      const passFile = join(a.root, 'pass.txt');
      await writeFile(passFile, bytes);
      const file = join(a.root, 'f');
      await runExport(file, { ...exportAll, passphraseFile: passFile }, a.deps);
      const b = await machine();
      expect(await importInto(b, file)).toEqual({ failed: 0 });
    }
  });

  it('refuses a passphrase file that is not text', async () => {
    const a = await machine({ env: {} });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const passFile = join(a.root, 'pass.txt');
    await writeFile(passFile, Buffer.from(PASS, 'utf16le'));
    const msg = await refusal(
      runExport(join(a.root, 'f'), { ...exportAll, passphraseFile: passFile }, a.deps),
    );
    expect(msg).toContain('not plain text');
    expect(existsSync(join(a.root, 'f'))).toBe(false);
  });

  it('imports an export a shell re-encoded as UTF-16', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    await runExport('-', exportAll, a.deps);
    const file = join(a.root, 'utf16.cctl');
    await writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(a.stdout[0]!, 'utf16le')]),
    );
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect((await b.engine.listAllAccounts()).map((x) => x.label)).toEqual(['work']);
  });

  it('stops reading an input that never ends', async () => {
    const endless = new Readable({
      read() {
        this.push(Buffer.alloc(1024 * 1024));
      },
    });
    expect(await readCapped(endless, 4 * 1024 * 1024)).toBeUndefined();
  });
});

describe('--move hands over only what it can', () => {
  it('keeps an account whose tokens changed after they were exported', async () => {
    const a = await machine({ interactive: true });
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    a.deps.confirm = async () => {
      // The daemon refreshes the idle account while the question waits.
      await a.vault.writeBundle(work.id, bundle('W2', 'u-work'));
      return true;
    };
    const res = await runExport(join(a.root, 'm'), { ...exportAll, move: true }, a.deps);
    expect(res.failed).toBe(1);
    expect((await a.engine.listAllAccounts()).map((x) => x.label)).toEqual(['work']);
    expect(a.out.join('')).toContain('Could not remove work: its tokens changed');
  });

  it("keeps an account that became this machine's main login while it asked", async () => {
    const a = await machine({ interactive: true });
    await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const alt = await a.engine.addAccount('alt', bundle('A1', 'u-alt'));
    a.deps.confirm = async () => {
      await a.engine.activate(alt.id);
      return true;
    };
    const res = await runExport(
      join(a.root, 'm'),
      { ...exportAll, move: true, accounts: 'alt' },
      a.deps,
    );
    expect(res.failed).toBe(1);
    expect((await a.engine.listAllAccounts()).map((x) => x.label).sort()).toEqual(['alt', 'home']);
    expect(a.out.join('')).toContain(
      "Could not remove alt: it is the live account of this machine's main login",
    );
  });

  it('keeps a quarantined account, whose tokens did not travel', async () => {
    const a = await machine();
    const dead = await a.engine.addAccount('dead', bundle('D1', 'u-dead'));
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    await a.vault.quarantine(dead.id, 'refresh token died');
    await runExport(join(a.root, 'm'), { ...exportAll, move: true, yes: true }, a.deps);
    expect((await a.engine.listAllAccounts()).map((x) => x.label)).toEqual(['dead']);
    expect(a.out.join('')).toContain('Kept dead here');
  });

  it('refuses before writing anything an export the import would refuse', async () => {
    const a = await machine();
    const odd = bundle('O1', 'u-odd');
    odd.oauthAccount!.emailAddress = 'x' + String.fromCharCode(27) + '[2J@x.com';
    await a.engine.addAccount('odd', odd);
    const msg = await refusal(
      runExport(join(a.root, 'm'), { ...exportAll, move: true, yes: true }, a.deps),
    );
    expect(msg).toContain('control or bidirectional');
    expect(existsSync(join(a.root, 'm'))).toBe(false);
    expect((await a.engine.listAllAccounts()).length).toBe(1);
  });

  it('writes the file through to the disk before anything is removed', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-durable-')));
    dirs.push(root);
    const calls: string[] = [];
    const recordingOpen: typeof open = async (...args) => {
      const handle = await open(...args);
      return new Proxy(handle, {
        get(target, prop) {
          const value: unknown = Reflect.get(target, prop, target);
          if (typeof value !== 'function') return value;
          return (...rest: unknown[]) => {
            calls.push(String(prop));
            return (value as (...x: unknown[]) => unknown).apply(target, rest);
          };
        },
      });
    };
    await writeNewFileDurably(join(root, 'f'), 'sealed', {
      open: recordingOpen,
      platform: 'linux',
    });
    expect(await readFile(join(root, 'f'), 'utf8')).toBe('sealed');
    expect(calls).toContain('sync');
    expect(calls.indexOf('sync')).toBeLessThan(calls.lastIndexOf('close'));
  });

  it.skipIf(process.platform !== 'win32')('makes the file readable by its owner only', async () => {
    const root = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-acl-')));
    dirs.push(root);
    // A folder every signed-in user may read, as a new folder at a drive root is.
    execFileSync('icacls', [root, '/grant', '*S-1-5-11:(OI)(CI)R']);
    const file = join(root, 'f.cctl');
    await writeNewFileDurably(file, 'sealed', { platform: 'win32' });
    const acl = execFileSync('icacls', [file], { encoding: 'utf8' });
    expect(acl).not.toContain('Authenticated Users');
    expect(acl).not.toContain('(I)');
  });
});

describe('rules travel whole', () => {
  it('rebuilds a rule with several folders as one rule, on its included account', async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const p1 = await folder(a, 'p1');
    const p2 = await folder(a, 'p2');
    await a.vault.createRule({ folders: [p1, p2], include: [x.id], label: 'Client' });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(await picture(b)).toEqual(await picture(a));
    const [rule] = await b.engine.listRules();
    const xb = (await b.engine.listAllAccounts()).find((r) => r.label === 'x')!;
    expect(rule!.activeId).toBe(xb.id);
  });

  it("does not let one new rule's slot take an account a later rule includes", async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const y = await a.engine.addAccount('y', bundle('Y1', 'u-y'));
    await a.engine.includeInFolder(await folder(a, 'fa'), [x.id]);
    await a.engine.includeInFolder(await folder(a, 'fb'), [y.id]);
    await a.vault.quarantine(x.id, 'refresh token died');
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(await rulesOf(b)).toEqual(await rulesOf(a));
  });

  it('keeps an exclusion the source keeps on record for an account another rule reserves', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const other = await folder(a, 'other');
    const proj = await folder(a, 'proj');
    await a.engine.excludeInFolder(other, [home.id]);
    await a.engine.includeInFolder(proj, [home.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain(`folder ${other}: create, exclude home`);
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(await picture(b)).toEqual(await picture(a));
  });

  it('finishes a rule an earlier import left half-applied', async () => {
    const a = await machine();
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const proj = await folder(a, 'proj');
    await a.engine.excludeInFolder(proj, [home.id]);
    await a.engine.includeInFolder(proj, [work.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await importInto(b, file);
    // As if the run had died between the rule's inclusions and its exclusions.
    const homeB = (await b.engine.listAllAccounts()).find((r) => r.label === 'home')!;
    await b.engine.resetFolder(proj, [homeB.id]);
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain(`folder ${proj}: added to the rule here, exclude home`);
    expect(await picture(b)).toEqual(await picture(a));
  });

  it('rebuilds a rule whose accounts came over in two files', async () => {
    for (const order of [
      [0, 1],
      [1, 0],
    ]) {
      const a = await machine();
      const beta = await a.engine.addAccount('beta', bundle('B1', 'u-beta'));
      const eps = await a.engine.addAccount('eps', bundle('E1', 'u-eps'));
      const proj = await folder(a, 'proj');
      await a.engine.excludeInFolder(proj, [eps.id]);
      await a.engine.includeInFolder(proj, [beta.id]);
      const files = [join(a.root, 'f1'), join(a.root, 'f2')];
      await runExport(files[0]!, { ...exportAll, accounts: 'beta' }, a.deps);
      await runExport(files[1]!, { ...exportAll, accounts: 'eps' }, a.deps);
      const b = await machine();
      for (const i of order) expect(await importInto(b, files[i]!)).toEqual({ failed: 0 });
      expect(await picture(b)).toEqual(await picture(a));
    }
  });

  it('names rule members that stay behind, so a login already here keeps its place', async () => {
    const a = await machine();
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const proj = await folder(a, 'proj');
    await a.engine.includeInFolder(proj, [work.id, home.id]);
    const file = join(a.root, 'f');
    await runExport(file, { ...exportAll, accounts: 'work' }, a.deps);
    const b = await machine();
    await b.engine.addAccount('home', bundle('H2', 'u-home'));
    await importInto(b, file);
    const [rule] = await rulesOf(b);
    expect([...rule!.include].sort()).toEqual(['home', 'work']);
  });

  it('skips a rule none of whose included accounts is here, rather than loosening it', async () => {
    const a = await machine();
    const acct = await a.engine.addAccount('A', bundle('A1', 'u-a'));
    const other = await a.engine.addAccount('B', bundle('B1', 'u-b'));
    const w = await folder(a, 'w');
    await a.engine.excludeInFolder(w, [other.id]);
    await a.engine.includeInFolder(w, [acct.id]);
    const file = join(a.root, 'f');
    await runExport(file, { ...exportAll, accounts: 'B' }, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(await b.engine.listRules()).toEqual([]);
    expect(b.out.join('')).toContain(
      `folder ${w}: skipped - none of the accounts it includes is in the file or on this machine`,
    );
  });

  it('does not create a rule whose included accounts could not be imported', async () => {
    const a = await machine();
    const acct = await a.engine.addAccount('A', bundle('A1', 'u-a'));
    const other = await a.engine.addAccount('B', bundle('B1', 'u-b'));
    const w = await folder(a, 'w');
    await a.engine.excludeInFolder(w, [other.id]);
    await a.engine.includeInFolder(w, [acct.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    b.deps.engine = engineWith(b.engine, {
      addAccount: (label, ...rest) =>
        label === 'A'
          ? Promise.reject(new LockTimeoutError('could not acquire credential lock'))
          : b.engine.addAccount(label, ...rest),
    });
    expect((await importInto(b, file)).failed).toBeGreaterThan(0);
    expect(await b.engine.listRules()).toEqual([]);
    expect(b.out.join('')).toContain(
      `folder ${w}: not created - none of the accounts it includes could be imported`,
    );
  });

  it("says when a rule moves this machine's main login, and predicts a move it cannot make", async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    const proj = await folder(a, 'proj');
    await a.engine.includeInFolder(proj, [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    await b.engine.addAccount('other', bundle('O1', 'u-other'));
    const live = await b.engine.addAccount('client', bundle('C2', 'u-client'));
    await b.engine.activate(live.id);
    const moved = await dryThenReal(b, file);
    expect(moved.failed).toBe(0);
    expect(moved.dry).toContain('  the global slot moves off client onto other');
    expect(moved.real).toContain(
      '  the global slot switched off client (now reserved) and is on other',
    );
    expectSameVerdicts(moved);

    const c = await machine();
    const only = await c.engine.addAccount('client', bundle('C3', 'u-client'));
    await c.engine.activate(only.id);
    const refused = await dryThenReal(c, file);
    expect(refused.failed).toBe(1);
    expect(refused.dry.join('\n')).toContain(
      'not imported - cannot include "client": it is the only usable shared account, so ' +
        'reserving it would leave the global slot with none',
    );
    expectSameVerdicts(refused);
    expect(await c.engine.listRules()).toEqual([]);
  });

  it('keeps out of auto-switch an account whose rule could not be made here', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    const proj = await folder(a, 'proj');
    await a.engine.includeInFolder(proj, [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    await rm(proj, { recursive: true, force: true });
    const b = await machine();
    await importInto(b, file);
    const row = (await b.engine.listAllAccounts()).find((r) => r.label === 'client')!;
    expect(row.autoSwitchExcluded).toBe(true);
    expect(b.out.join('')).toContain('kept out of auto-switch');
  });
});

describe('accounts brought by a file', () => {
  it('quotes the relogin command for a label that needs it', async () => {
    const a = await machine();
    await a.engine.addAccount('alpha', bundle('A1', 'u-a'));
    const file = join(a.root, 'f');
    await runExport(file, { ...exportAll, tokens: false }, a.deps);
    const b = await machine();
    await b.engine.addAccount('alpha', bundle('B1', 'u-other'));
    await importInto(b, file);
    expect(b.out.join('')).toContain(`cctl accounts relogin ${shellQuote('alpha (2)')}`);
  });

  it('applies the auto-switch exclusion in the same write that adds the account', async () => {
    const a = await machine();
    const spare = await a.engine.addAccount('spare', bundle('S1', 'u-spare'));
    await a.engine.setAutoSwitchExcluded(spare.id, true);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    b.deps.engine = engineWith(b.engine, {
      setAutoSwitchExcluded: () =>
        Promise.reject(new LockTimeoutError('could not acquire credential lock')),
    });
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const [row] = await b.engine.listAllAccounts();
    expect(row!.autoSwitchExcluded).toBe(true);
    expect(b.out.join('')).toContain('spare: added, excluded from auto-switch');
  });

  it('is a no-op the second time for an account whose tokens name no login', async () => {
    const b = await machine();
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'nb',
            id: '0b0b0b0b-0000-4000-8000-000000000001',
            accountUuid: 'u-nb',
            autoSwitchExcluded: false,
            bundle: {
              claudeAiOauth: {
                accessToken: 'N1',
                refreshToken: 'r-N1',
                expiresAt: Date.now() + HOUR,
              },
            },
          },
          { label: 'anon', id: '0b0b0b0b-0000-4000-8000-000000000002', autoSwitchExcluded: false },
        ],
      }),
    );
    await importInto(b, file);
    await importInto(b, file);
    expect((await b.engine.listAllAccounts()).map((r) => r.label).sort()).toEqual(['anon', 'nb']);
  });

  it('does not let tokens that name no login replace a stored account', async () => {
    const b = await machine();
    const x = await b.engine.addAccount('x', bundle('X1', 'u-x', Date.now() + HOUR));
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'x',
            accountUuid: 'u-x',
            autoSwitchExcluded: false,
            bundle: {
              claudeAiOauth: {
                accessToken: 'Y1',
                refreshToken: 'r-Y1',
                expiresAt: Date.now() + 9 * HOUR,
              },
            },
          },
        ],
      }),
    );
    await importInto(b, file, { replace: true });
    expect((await b.vault.readBundle(x.id)).claudeAiOauth.accessToken).toBe('X1');
    expect(b.out.join('')).toContain('do not say which login they belong to');
  });

  it('keeps terminal controls in an engine refusal out of the report', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    b.deps.engine = engineWith(b.engine, {
      addAccount: () =>
        Promise.reject(new VaultError('bad ' + String.fromCharCode(27) + '[2J thing')),
    });
    await importInto(b, file);
    expect(b.out.join('')).toContain('bad [2J thing');
    expect(b.out.join('')).not.toContain(String.fromCharCode(27));
  });

  it('says how to start using an account when nothing is live, and keeps an organization', async () => {
    const a = await machine();
    const withOrg = bundle('W1', 'u-work');
    withOrg.oauthAccount!.organizationUuid = 'org-1';
    await a.engine.addAccount('work', withOrg);
    const full = join(a.root, 'full');
    const bare = join(a.root, 'bare');
    await runExport(full, exportAll, a.deps);
    await runExport(bare, { ...exportAll, tokens: false }, a.deps);
    const b = await machine();
    await importInto(b, full);
    expect(b.out.join('')).toContain(`cctl switch ${shellQuote('work')}`);
    const c = await machine();
    await importInto(c, bare);
    const [row] = await c.engine.listAllAccounts();
    expect(row!.organizationUuid).toBe('org-1');
  });

  it('carries an account whose identity block holds nested values', async () => {
    const a = await machine();
    const nested = bundle('W1', 'u-work');
    (nested.oauthAccount as Record<string, unknown>)['ccOnboardingFlags'] = { seen: true };
    (nested.oauthAccount as Record<string, unknown>)['seatTier'] = null;
    await a.engine.addAccount('work', nested);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const [row] = await b.engine.listAllAccounts();
    expect((await b.vault.readBundle(row!.id)).oauthAccount).toMatchObject({
      ccOnboardingFlags: { seen: true },
    });
  });

  it('says the vault is busy when the credential lock is held, not that one account is at fault', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    a.deps.engine = engineWith(a.engine, {
      exportBundle: () => Promise.reject(new LockTimeoutError('could not acquire credential lock')),
    });
    const msg = await refusal(runExport(join(a.root, 'f'), exportAll, a.deps));
    expect(msg).toContain('another cctl process');
    expect(msg).not.toContain('--accounts');
  });
});

describe('what a file cannot plant in the accounts list', () => {
  const ESC = String.fromCharCode(27);

  it('refuses a billing type, or any identity field, holding terminal controls', async () => {
    for (const [key, value] of [
      ['billingType', `${ESC}]52;c;QUE=${String.fromCharCode(7)}`],
      ['billingType', `${ESC}[2J${ESC}[3J`],
      ['organizationName', `${String.fromCharCode(0x202e)}evil`],
    ] as const) {
      const b = await machine();
      const entry = {
        label: 'w',
        accountUuid: 'u-w',
        autoSwitchExcluded: false,
        bundle: { ...bundle('W1', 'u-w'), oauthAccount: { accountUuid: 'u-w', [key]: value } },
      };
      const file = await sealedFile(b, filePayload({ accounts: [entry] }));
      expect(await refusal(importInto(b, file))).toContain(
        `accounts[0].bundle.oauthAccount.${key} holds a control or bidirectional character`,
      );
      expect(await b.engine.listAllAccounts()).toEqual([]);
    }
  });
});

describe('--replace takes only tokens that prove the login', () => {
  /** Machine b with 'x' (a full identity) live on its main login, and a file whose entry for x
   *  carries later tokens with `block` as their identity. */
  async function setUp(
    block: Record<string, unknown>,
  ): Promise<{ b: Machine; id: string; file: string }> {
    const b = await machine();
    const full = bundle('X1', 'u-x', Date.now() + HOUR);
    full.oauthAccount!.organizationUuid = 'org-x';
    const x = await b.engine.addAccount('x', full);
    await b.engine.activate(x.id);
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'x',
            accountUuid: 'u-x',
            autoSwitchExcluded: false,
            bundle: {
              claudeAiOauth: {
                accessToken: 'Y1',
                refreshToken: 'r-Y1',
                expiresAt: Date.now() + 9 * HOUR,
              },
              oauthAccount: block,
            },
          },
        ],
      }),
    );
    return { b, id: x.id, file };
  }

  it('leaves the stored and live login alone for a block that does not name it', async () => {
    for (const block of [
      {},
      { accountUuid: 42 },
      { emailAddress: 'u-x@x.com' },
      { displayName: 'Y' },
    ]) {
      const { b, id, file } = await setUp(block);
      expect(await importInto(b, file, { replace: true })).toEqual({ failed: 0 });
      expect(b.out.join('')).toContain("the file's tokens do not name the login they belong to");
      const stored = await b.vault.readBundle(id);
      expect(stored.claudeAiOauth.accessToken).toBe('X1');
      expect(stored.oauthAccount).toMatchObject({ accountUuid: 'u-x', organizationUuid: 'org-x' });
      expect(await b.engine.getActiveId('global')).toBe(id);
      const live = JSON.parse(await readFile(b.paths.claudeJsonPath, 'utf8')) as {
        oauthAccount?: { accountUuid?: string };
      };
      expect(live.oauthAccount?.accountUuid).toBe('u-x');
    }
  });

  it('replaces for a block naming the login, keeping the identity stored and live', async () => {
    const { b, id, file } = await setUp({ accountUuid: 'u-x' });
    expect(await importInto(b, file, { replace: true })).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain("x: tokens replaced (the file's were newer)");
    expect((await b.vault.readBundle(id)).oauthAccount).toMatchObject({
      accountUuid: 'u-x',
      emailAddress: 'u-x@x.com',
      organizationUuid: 'org-x',
    });
    const live = JSON.parse(await readFile(b.paths.claudeJsonPath, 'utf8')) as {
      oauthAccount?: Record<string, unknown>;
    };
    expect(live.oauthAccount).toMatchObject({ accountUuid: 'u-x', organizationUuid: 'org-x' });
  });
});

describe('a passphrase that cannot be typed again', () => {
  it('refuses a passphrase file with a space before its line ending, so --move removes nothing', async () => {
    const a = await machine({ env: {}, confirm: () => Promise.resolve(true), interactive: true });
    await a.engine.addAccount('spare', bundle('S1', 'u-s'));
    const work = await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const passFile = join(a.root, 'pass.txt');
    // What `echo a long enough passphrase > pass.txt` writes in cmd.exe.
    await writeFile(passFile, PASS + ' \r\n');
    const file = join(a.root, 'm.cctl');
    const msg = await refusal(
      runExport(file, { ...exportAll, move: true, yes: true, passphraseFile: passFile }, a.deps),
    );
    expect(msg).toContain(`the passphrase in ${passFile} starts or ends with a space`);
    expect(existsSync(file)).toBe(false);
    expect((await a.engine.listAllAccounts()).map((r) => r.id)).toContain(work.id);
  });

  it('refuses one from the environment with a stray carriage return, sealing or opening', async () => {
    const a = await machine({ env: { CCTL_EXPORT_PASSPHRASE: PASS + '\r' } });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const file = join(a.root, 'f');
    expect(await refusal(runExport(file, exportAll, a.deps))).toContain(
      'CCTL_EXPORT_PASSPHRASE holds a control or invisible character',
    );
    expect(existsSync(file)).toBe(false);
    const b = await machine({ env: { CCTL_EXPORT_PASSPHRASE: ' ' + PASS } });
    const sealed = await sealedFile(b, filePayload());
    expect(await refusal(importInto(b, sealed))).toContain(
      'CCTL_EXPORT_PASSPHRASE starts or ends with a space; nothing was imported',
    );
  });

  it('refuses a doubled byte-order mark, and reads a file whose line ends in a bare CR', async () => {
    const a = await machine({ env: {} });
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const doubled = join(a.root, 'doubled.txt');
    await writeFile(
      doubled,
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf, 0xef, 0xbb, 0xbf]), Buffer.from(PASS)]),
    );
    expect(
      await refusal(
        runExport(join(a.root, 'f1'), { ...exportAll, passphraseFile: doubled }, a.deps),
      ),
    ).toContain('holds a control or invisible character');
    const cr = join(a.root, 'cr.txt');
    await writeFile(cr, PASS + '\r');
    const file = join(a.root, 'f2');
    await runExport(file, { ...exportAll, passphraseFile: cr }, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
  });
});

describe('a rule an earlier import made part way', () => {
  it('grows into the whole rule once its missing folder exists, never a second rule', async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const alpha = await a.engine.addAccount('alpha', bundle('A1', 'u-alpha'));
    const eps = await a.engine.addAccount('eps', bundle('E1', 'u-eps'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const f1 = await folder(a, 'f1');
    const f2 = await folder(a, 'f2');
    await a.vault.createRule({
      folders: [f1, f2],
      aliases: [{ folder: f1, alias: 'deploy' }],
      include: [x.id, alpha.id],
      exclude: [eps.id],
      label: 'work-rule',
    });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    // Machine b has the same folders (the same paths), but f2 only after the first import.
    const b = await machine();
    await rm(f2, { recursive: true, force: true });
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain(`folder ${f2}: left out - the folder does not exist`);
    expect(await b.engine.listRules()).toHaveLength(1);

    await mkdir(f2, { recursive: true });
    b.out.length = 0;
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain(`folder ${f2}: joins the rule here`);
    expect(b.out.join('')).not.toContain(': create');
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ label: 'work-rule' });
    expect(rules[0]!.folders).toHaveLength(2);
    expect(rules[0]!.aliases).toHaveLength(1);
    const xb = (await b.engine.listAllAccounts()).find((r) => r.label === 'x')!;
    expect(rules[0]!.activeId).toBe(xb.id);
    expect(await picture(b)).toEqual(await picture(a));
  });

  it('grows the rule though the source dropped an exclusion of it since the first import', async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const t = await a.engine.addAccount('t', bundle('T1', 'u-t'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const p1 = await folder(a, 'p1');
    const p2 = await folder(a, 'p2');
    const rule = await a.vault.createRule({
      folders: [p1, p2],
      include: [x.id],
      exclude: [t.id],
    });
    const first = join(a.root, 'first');
    await runExport(first, exportAll, a.deps);

    const b = await machine();
    await rm(p2, { recursive: true, force: true });
    expect(await importInto(b, first)).toEqual({ failed: 0 });
    expect(await b.engine.listRules()).toHaveLength(1);

    await a.vault.removeFromRule(rule.id, [t.id]);
    const second = join(a.root, 'second');
    await runExport(second, exportAll, a.deps);
    await mkdir(p2, { recursive: true });
    b.out.length = 0;
    await importInto(b, second, { dryRun: true });
    const dry = b.out.join('');
    expect(dry).toContain(`folder ${p2}: joins the rule here`);
    expect(dry).not.toContain(': create');
    expect(dry).not.toContain('another rule there');
    expect(await importInto(b, second)).toEqual({ failed: 0 });
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.folders).toHaveLength(2);
    const xb = (await b.engine.listAllAccounts()).find((r) => r.label === 'x')!;
    expect(rules[0]!.activeId).toBe(xb.id);
  });

  it("fails, in every import, a rule beside a rule of this machine's own on one of its folders", async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const alpha = await a.engine.addAccount('alpha', bundle('A1', 'u-alpha'));
    const eps = await a.engine.addAccount('eps', bundle('E1', 'u-eps'));
    const f1 = await folder(a, 'f1');
    const f2 = await folder(a, 'f2');
    await a.vault.createRule({
      folders: [f1, f2],
      aliases: [{ folder: f1, alias: 'deploy' }],
      include: [x.id, alpha.id],
      exclude: [eps.id],
      label: 'work-rule',
    });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    // Machine b has its own account and its own rule on f1.
    const b = await machine();
    const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
    await b.engine.includeInFolder(f1, [other.id], { label: 'mine' });
    const before = await b.engine.listRules();
    await rm(f2, { recursive: true, force: true });
    const first = await dryThenReal(b, file);
    expect(first.failed).toBe(1);
    expect(first.dry.join('\n')).toContain(`folder ${f1} already has a rule here ("mine")`);
    expectSameVerdicts(first);
    expect(await b.engine.listRules()).toEqual(before);

    await mkdir(f2, { recursive: true });
    const second = await dryThenReal(b, file);
    expect(second.failed).toBe(1);
    expect(second.dry.join('\n')).not.toContain(': create');
    expectSameVerdicts(second);
    expect(await b.engine.listRules()).toEqual(before);
  });

  /** A source rule on two folders including x, exported while only the first exists on `b`, then
   *  imported there; returns both machines and what the second export needs. */
  async function partWay(): Promise<{
    a: Machine;
    b: Machine;
    rule: Awaited<ReturnType<Vault['createRule']>>;
    ids: Record<'x' | 'y', string>;
    f1: string;
    f2: string;
  }> {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const y = await a.engine.addAccount('y', bundle('Y1', 'u-y'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const f1 = await folder(a, 'w1');
    const f2 = await folder(a, 'w2');
    const rule = await a.vault.createRule({ folders: [f1, f2], include: [x.id], label: 'work' });
    const first = join(a.root, 'first');
    await runExport(first, exportAll, a.deps);
    const b = await machine();
    await rm(f2, { recursive: true, force: true });
    expect(await importInto(b, first)).toEqual({ failed: 0 });
    await mkdir(f2, { recursive: true });
    b.out.length = 0;
    return { a, b, rule, ids: { x: x.id, y: y.id }, f1, f2 };
  }

  it('grows the rule though every member changed on the source since the first import', async () => {
    const { a, b, rule, ids, f2 } = await partWay();
    await a.engine.includeInFolder(rule.folders[0]!, [ids.y]);
    await a.vault.removeFromRule(rule.id, [ids.x]);
    const second = join(a.root, 'second');
    await runExport(second, exportAll, a.deps);

    await importInto(b, second, { dryRun: true });
    const dry = b.out.join('');
    expect(dry).toContain(`folder ${f2}: joins the rule here`);
    expect(dry).not.toContain(': create');
    expect(dry).not.toContain('another rule there');
    expect(await importInto(b, second)).toEqual({ failed: 0 });
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.folders).toHaveLength(2);
    const labels = await b.engine.listAllAccounts();
    const idOf = (l: string): string => labels.find((r) => r.label === l)!.id;
    expect(rules[0]!.include.sort()).toEqual([idOf('x'), idOf('y')].sort());
  });

  it('grows the rule though this machine changed it since: a folder added, a member swapped', async () => {
    const { a, b, f1, f2 } = await partWay();
    const here = (await b.engine.listRules())[0]!;
    const extra = await folder(b, 'w3');
    await b.vault.addScopesToRule(here.id, { folders: [extra] });
    const z = await b.engine.addAccount('z', bundle('Z1', 'u-z'));
    await b.engine.includeInFolder(f1, [z.id]);
    await b.vault.removeFromRule(here.id, [here.include.find((id) => id !== z.id)!]);
    expect(await importInto(b, join(a.root, 'first'))).toEqual({ failed: 0 });
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.folders.sort()).toEqual([f1, f2, extra].sort());
  });

  it("never takes a rule of this machine's own for the file's because they share accounts", async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    const eps = await a.engine.addAccount('eps', bundle('E1', 'u-eps'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const f1 = await folder(a, 'o1');
    const f3 = await folder(a, 'o3');
    await a.vault.createRule({ folders: [f1, f3], include: [x.id], exclude: [eps.id] });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    // b's own rule on o3 excludes the same account and includes the same one the file's does.
    const b = await machine();
    const xb = await b.engine.addAccount('x', bundle('X2', 'u-x'));
    const q = await b.engine.addAccount('q', bundle('Q1', 'u-q'));
    const epsb = await b.engine.addAccount('eps', bundle('E2', 'u-eps'));
    await b.engine.addAccount('s2', bundle('S2', 'u-s2'));
    await b.engine.includeInFolder(f3, [q.id, xb.id], { label: 'mine' });
    await b.engine.excludeInFolder(f3, [epsb.id]);
    const before = (await b.engine.listRules())[0]!;

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.join('\n')).toContain(`folder ${f3} already has a rule here ("mine")`);
    expect(run.dry.join('\n')).not.toContain('joins the rule here');
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual([before]);
  });

  it("never takes a rule of its own on exactly the file rule's folders, before or after the source adds one", async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const f1 = await folder(a, 'e1');
    const rule = await a.vault.createRule({ folders: [f1], include: [x.id] });
    const first = join(a.root, 'first');
    await runExport(first, exportAll, a.deps);

    // b's own rule on exactly e1, with every member the file's has: still b's own rule.
    const b = await machine();
    const xb = await b.engine.addAccount('x', bundle('X2', 'u-x'));
    await b.engine.addAccount('s2', bundle('S2', 'u-s2'));
    await b.engine.includeInFolder(f1, [xb.id]);
    const before = await b.engine.listRules();
    const once = await dryThenReal(b, first);
    expect(once.failed).toBe(1);
    expectSameVerdicts(once);
    expect(await b.engine.listRules()).toEqual(before);

    const f2 = await folder(a, 'e2');
    await a.vault.addScopesToRule(rule.id, { folders: [f2] });
    const second = join(a.root, 'second');
    await runExport(second, exportAll, a.deps);
    const again = await dryThenReal(b, second);
    expect(again.failed).toBe(1);
    expect(again.dry.join('\n')).not.toContain('joins the rule here');
    expectSameVerdicts(again);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('finds the rule again on the machine it came from, and on a third machine', async () => {
    const { a, b, rule, f2 } = await partWay();
    expect(await importInto(b, join(a.root, 'first'))).toEqual({ failed: 0 });
    const onB = (await b.engine.listRules())[0]!;
    expect(onB.origin).toBe(rule.id);

    // b adds a folder; its export carries the source rule's identity, so a finds its own rule.
    const extra = await folder(b, 'w4');
    await b.vault.addScopesToRule(onB.id, { folders: [extra] });
    const back = join(b.root, 'back');
    await runExport(back, exportAll, b.deps);
    a.out.length = 0;
    expect(await importInto(a, back)).toEqual({ failed: 0 });
    const onA = await a.engine.listRules();
    expect(onA).toHaveLength(1);
    expect(onA[0]!.id).toBe(rule.id);
    expect(onA[0]!.folders).toContain(extra);
    expect(onA[0]!.origin).toBeUndefined();

    // A third machine that took the rule from b, then the file from a: still one rule.
    const c = await machine();
    await rm(f2, { recursive: true, force: true });
    expect(await importInto(c, back)).toEqual({ failed: 0 });
    await mkdir(f2, { recursive: true });
    expect(await importInto(c, join(a.root, 'first'))).toEqual({ failed: 0 });
    const onC = await c.engine.listRules();
    expect(onC).toHaveLength(1);
    expect(onC[0]!.origin).toBe(rule.id);
    expect(onC[0]!.folders).toContain(f2);
  });
});

describe('importing the same file again', () => {
  /** A bundle whose tokens name no login. */
  function bare(access: string): CredentialBundle {
    return {
      claudeAiOauth: {
        accessToken: access,
        refreshToken: 'r-' + access,
        expiresAt: Date.now() + HOUR,
      },
    };
  }

  it('finds an account it stored under a numbered label, though it names no login', async () => {
    const a = await machine();
    await a.engine.addAccount('anon', bare('F1'));
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await b.engine.addAccount('anon', bundle('L1', 'u-local'));
    for (let i = 0; i < 3; i += 1) expect(await importInto(b, file)).toEqual({ failed: 0 });
    const rows = await b.engine.listAllAccounts();
    expect(rows.map((r) => r.label).sort()).toEqual(['anon', 'anon (2)']);
  });

  it('finds an account whose tokens name only part of its identity', async () => {
    const b = await machine();
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'p',
            accountUuid: 'u-p',
            autoSwitchExcluded: false,
            bundle: { ...bare('P1'), oauthAccount: { emailAddress: 'p@x.com' } },
          },
        ],
      }),
    );
    await importInto(b, file);
    await importInto(b, file);
    const rows = await b.engine.listAllAccounts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: 'p', accountUuid: 'u-p', emailAddress: 'p@x.com' });
  });

  it('adds an account that only shares a label with one here, rather than skipping it', async () => {
    const a = await machine();
    await a.engine.addAccount('main', bare('FROMFILE'));
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await b.engine.addAccount('main', bare('LOCAL'));
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const rows = await b.engine.listAllAccounts();
    expect(rows.map((r) => r.label).sort()).toEqual(['main', 'main (2)']);
    const added = rows.find((r) => r.label === 'main (2)')!;
    expect((await b.vault.readBundle(added.id)).claudeAiOauth.accessToken).toBe('FROMFILE');
  });
});

/** The engine's refusal of a rule whose reservation would leave the main login with nothing. */
const MAIN_LOGIN_LEFT_EMPTY =
  'not imported - cannot include "client": it is the only usable shared account, so reserving ' +
  'it would leave the global slot with none';

describe('what the dry run promises, the real run does', () => {
  it("fails a rule that would leave another rule's slot with no account, in both runs", async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
    await b.engine.addAccount('client', bundle('C2', 'u-client'));
    await b.engine.activate(other.id);
    const side = await folder(b, 'side');
    // The side rule excludes 'other', so its slot runs 'client', the one account left to it.
    await b.engine.excludeInFolder(side, [other.id]);
    const why =
      `not imported - cannot include "client": it is live in the folder slot of ${side}, and ` +
      'that folder has no other account to switch to';
    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.join('\n')).toContain(why);
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toHaveLength(1);
  });

  it('fails adding accounts past what one rule may include, in both runs', async () => {
    const b = await machine();
    const proj = await folder(b, 'proj');
    const held: string[] = [];
    for (let i = 0; i < 31; i += 1) {
      held.push((await b.vault.addPendingAccount(`h${i}`, { accountUuid: `u-h${i}` }, 'w')).id);
    }
    const here = await b.vault.createRule({ folders: [proj], include: held });
    const file = await sealedFile(
      b,
      filePayload({
        accounts: ['n0', 'n1', 'n2'].map((l) => ({
          label: l,
          accountUuid: `u-${l}`,
          autoSwitchExcluded: false,
          bundle: bundle(l.toUpperCase(), `u-${l}`),
        })),
        rules: [
          {
            label: 'r',
            // The file came from this machine: its rule is the one here.
            origin: here.id,
            folders: [proj],
            aliases: [],
            include: ['u-n0', 'u-n1', 'u-n2'],
            exclude: [],
          },
        ],
      }),
    );
    const why = `folder ${proj}: not imported - a folder rule cannot include more than 32 accounts`;
    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry).toContain(`  ${why}`);
    expectSameVerdicts(run);
    expect((await b.engine.listRules())[0]!.include).toHaveLength(31);
  });

  it('skips a rule that names one account on both sides under two names, in both runs', async () => {
    const b = await machine();
    const proj = await folder(b, 'proj');
    const file = await sealedFile(
      b,
      filePayload({
        accounts: ['f', 'g'].map((l) => ({
          label: l,
          accountUuid: `u-${l}`,
          autoSwitchExcluded: false,
          bundle: bundle(l.toUpperCase(), `u-${l}`),
        })),
        rules: [
          { label: 'r', folders: [proj], aliases: [], include: ['u-f', 'u-g'], exclude: ['f'] },
        ],
      }),
    );
    const why = `folder ${proj}: skipped - it both includes and excludes f`;
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain(why);
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain(why);
    expect(await b.engine.listRules()).toEqual([]);
  });

  it('sees the main login moving when the account a rule includes runs there unstored', async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    const withTokens = join(a.root, 'tokens');
    await runExport(withTokens, exportAll, a.deps);
    const without = join(a.root, 'none');
    await runExport(without, { ...exportAll, tokens: false }, a.deps);

    /** A machine whose main login is client's, logged in before cctl stored it. */
    async function target(spare: boolean): Promise<Machine> {
      const b = await machine();
      if (spare) {
        const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
        await b.engine.activate(other.id);
      }
      const live = new CredentialStore(b.paths);
      await live.writeLiveCredentials(bundle('C-LIVE', 'u-client').claudeAiOauth);
      await live.writeOauthAccount({ accountUuid: 'u-client', emailAddress: 'u-client@x.com' });
      expect(await b.engine.getActiveId('global')).toBeNull();
      return b;
    }

    // Nothing else here can take the main login: both runs refuse the rule.
    const b = await target(false);
    const refused = await dryThenReal(b, withTokens);
    expect(refused.failed).toBe(1);
    expect(refused.dry.join('\n')).toContain(MAIN_LOGIN_LEFT_EMPTY);
    expectSameVerdicts(refused);
    expect(await b.engine.listRules()).toEqual([]);

    // With another account here, both runs say the main login moves, with tokens or without.
    for (const file of [withTokens, without]) {
      const c = await target(true);
      const moved = await dryThenReal(c, file);
      expect(moved.failed).toBe(0);
      expect(moved.dry).toContain('  the global slot moves off client onto other');
      expectSameVerdicts(moved);
      expect(await c.engine.listRules()).toHaveLength(1);
    }
  });

  it('sees the main login moving when --replace gives a stored row the login running there', async () => {
    const CID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    const tokens = (access: string, hours: number): Record<string, unknown> => ({
      accessToken: access,
      refreshToken: 'r-' + access,
      expiresAt: Date.now() + hours * HOUR,
    });
    /** A machine holding client from an export made before its login was known, whose main login
     *  then runs that login, which no row here is recognized as. */
    async function target(spare: boolean): Promise<Machine> {
      const b = await machine();
      const first = await sealedFile(
        b,
        filePayload({
          accounts: [
            {
              label: 'client',
              id: CID,
              emailAddress: 'c@x.com',
              autoSwitchExcluded: false,
              bundle: {
                claudeAiOauth: tokens('C0', 10),
                oauthAccount: { emailAddress: 'c@x.com' },
              },
            },
          ],
        }),
        'first.cctl',
      );
      expect(await importInto(b, first)).toEqual({ failed: 0 });
      expect((await b.engine.listAllAccounts())[0]).toMatchObject({ id: CID });
      if (spare) {
        const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
        await b.engine.activate(other.id);
      }
      const live = new CredentialStore(b.paths);
      await live.writeLiveCredentials(bundle('C-LIVE', 'u-c').claudeAiOauth);
      await live.writeOauthAccount({ accountUuid: 'u-c', emailAddress: 'c@x.com' });
      expect(await b.engine.getActiveId('global')).toBeNull();
      b.out.length = 0;
      return b;
    }
    async function second(m: Machine): Promise<string> {
      return sealedFile(
        m,
        filePayload({
          accounts: [
            {
              label: 'client',
              id: CID,
              accountUuid: 'u-c',
              emailAddress: 'c@x.com',
              autoSwitchExcluded: false,
              bundle: {
                claudeAiOauth: tokens('C1', 20),
                oauthAccount: { accountUuid: 'u-c', emailAddress: 'c@x.com' },
              },
            },
          ],
          rules: [
            {
              label: 'r',
              folders: [await folder(m, 'proj')],
              aliases: [],
              include: ['u-c'],
              exclude: [],
            },
          ],
        }),
        'second.cctl',
      );
    }

    const b = await target(false);
    const file = await second(b);
    await importInto(b, file, { dryRun: true, replace: true });
    const dry = ruleSection(b.out.join(''));
    expect(dry.join('\n')).toContain(MAIN_LOGIN_LEFT_EMPTY);
    b.out.length = 0;
    expect(await importInto(b, file, { replace: true })).toEqual({ failed: 1 });
    expectSameVerdicts({ dry, real: ruleSection(b.out.join('')) });
    expect(await b.engine.listRules()).toEqual([]);
    expect(await b.engine.getActiveId('global')).toBe(CID);

    const c = await target(true);
    const fileC = await second(c);
    await importInto(c, fileC, { dryRun: true, replace: true });
    const dryC = ruleSection(c.out.join(''));
    expect(dryC).toContain('  the global slot moves off client onto other');
    c.out.length = 0;
    expect(await importInto(c, fileC, { replace: true })).toEqual({ failed: 0 });
    expectSameVerdicts({ dry: dryC, real: ruleSection(c.out.join('')) });
    expect(await c.engine.listRules()).toHaveLength(1);
  });

  it('makes the rule it promised when one account is labelled with the id another keeps', async () => {
    // Written by a build whose vault let an import keep an id that a label here already spelled:
    // the label and the id travel together, and either order would make the vault refuse one.
    const ID_Q = '6a1f0c3e-2b4d-4e6f-8a9b-0c1d2e3f4a5b';
    const ID_P = '7b2e1d4f-3c5e-4f70-9bac-1d2e3f4a5b6c';
    for (const order of [0, 1]) {
      const b = await machine();
      const proj = await folder(b, 'proj');
      const q = {
        label: ID_P,
        id: ID_Q,
        accountUuid: 'u-q',
        autoSwitchExcluded: false,
        bundle: bundle('Q1', 'u-q'),
      };
      const p = {
        label: 'p',
        id: ID_P,
        accountUuid: 'u-p',
        autoSwitchExcluded: false,
        bundle: bundle('P1', 'u-p'),
      };
      const file = await sealedFile(
        b,
        filePayload({
          accounts: order === 0 ? [q, p] : [p, q],
          rules: [{ label: 'r', folders: [proj], aliases: [], include: ['u-q'], exclude: [] }],
        }),
      );
      await importInto(b, file, { dryRun: true });
      expect(b.out.join('')).toContain(`folder ${proj}: create, include ${ID_P} (2)`);
      b.out.length = 0;
      expect(await importInto(b, file)).toEqual({ failed: 0 });
      expect(b.out.join('')).toContain(`folder ${proj}: created, include ${ID_P} (2)`);
      const rows = await b.engine.listAllAccounts();
      expect(rows.map((r) => r.label).sort()).toEqual([`${ID_P} (2)`, 'p']);
      expect(rows.find((r) => r.label === 'p')!.id).toBe(ID_P);
      expect(await b.engine.listRules()).toHaveLength(1);
    }
  });
});

describe('settings that guard something', () => {
  it('never saves from a file a value that weakens a guard, and says how to set it here', async () => {
    for (const replace of [false, true]) {
      const b = await machine();
      const file = await sealedFile(
        b,
        filePayload({
          settings: {
            env: { 'bind-enforce': 'off', CCTL_IDENTITY_CHECK: '0', CCTL_AUTOSWITCH: 'off' },
          },
        }),
      );
      expect(await importInto(b, file, { replace })).toEqual({ failed: 0 });
      expect((await configOf(b)).env).toEqual({ CCTL_AUTOSWITCH: 'off' });
      const report = b.out.join('');
      expect(report).toContain('to set it here: cctl settings set bind-enforce off');
      expect(report).toContain('to set it here: cctl settings set identity-check 0');
    }
  });
});

describe('the environment over a setting already set', () => {
  it('says the environment wins over a value the file and this machine agree on', async () => {
    const b = await machine({ env: { CCTL_EXPORT_PASSPHRASE: PASS, CCTL_AUTOSWITCH: '1' } });
    await writeFile(b.configPath, JSON.stringify({ env: { CCTL_AUTOSWITCH: 'off' } }));
    const file = await sealedFile(
      b,
      filePayload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
    );
    await importInto(b, file);
    const report = b.out.join('');
    expect(report).toContain(
      'CCTL_AUTOSWITCH=off: already set (the environment here sets it, and wins)',
    );
    expect(report).toContain('A value set in the environment still wins over the file.');
  });

  it('reads a blank environment value as unset', async () => {
    const b = await machine({ env: { CCTL_EXPORT_PASSPHRASE: PASS, CCTL_AUTOSWITCH: '  ' } });
    const file = await sealedFile(
      b,
      filePayload({ settings: { env: { CCTL_AUTOSWITCH: 'off' } } }),
    );
    await importInto(b, file);
    expect(b.out.join('')).toContain('CCTL_AUTOSWITCH=off: saved\n');
  });
});

describe('accounts a rule of the file reserves', () => {
  /** A file whose rule reserves 'client' and whose 'work' is shared. */
  async function clientFile(): Promise<string> {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    return file;
  }

  it('hands the account back to auto-switch once its rule is made', async () => {
    const b = await machine();
    await importInto(b, await clientFile());
    const row = (await b.engine.listAllAccounts()).find((r) => r.label === 'client')!;
    expect(row.ruleIds).toHaveLength(1);
    expect(row.autoSwitchExcluded).toBeUndefined();
  });

  it('keeps it out of auto-switch when the engine refuses its rule at run time', async () => {
    const b = await machine();
    b.deps.engine = engineWith(b.engine, {
      importRules: (specs) =>
        Promise.resolve({
          plan: {
            rules: specs.map(() => ({ kind: 'refused' as const, message: 'refused here' })),
            handOffs: [],
            seats: [],
          },
          outcomes: specs.map(() => undefined),
          handedOff: [],
          seated: [],
        }),
    });
    const file = await clientFile();
    expect((await importInto(b, file)).failed).toBe(1);
    const row = (await b.engine.listAllAccounts()).find((r) => r.label === 'client')!;
    expect(row.autoSwitchExcluded).toBe(true);
    expect(b.out.join('')).toContain(
      "client: kept out of auto-switch (the rule it is reserved to was not made here; cctl accounts include 'client' lets auto-switch use it)",
    );
    expect(b.out.join('')).not.toContain("cctl switch 'client'");
  });

  it('keeps it out of auto-switch when the whole batch of rules fails', async () => {
    const b = await machine();
    b.deps.engine = engineWith(b.engine, {
      importRules: () => Promise.reject(new LockTimeoutError('could not acquire credential lock')),
    });
    await importInto(b, await clientFile());
    const row = (await b.engine.listAllAccounts()).find((r) => r.label === 'client')!;
    expect(row.autoSwitchExcluded).toBe(true);
    expect(b.out.join('')).toContain('client: kept out of auto-switch');
  });

  it('never moves a slot onto it, nor seats a new rule with it, during the import', async () => {
    // Its rule's folder is gone here, so client arrives kept out of auto-switch. Another rule of
    // the file reserves z and w, live on the main login and in an exclude-only rule's slot here.
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    const az = await a.engine.addAccount('z', bundle('Z1', 'u-z'));
    const aw = await a.engine.addAccount('w', bundle('W1', 'u-w'));
    const projA = await folder(a, 'projA');
    await a.engine.includeInFolder(projA, [client.id]);
    await a.engine.includeInFolder(await folder(a, 'projB'), [az.id, aw.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    await rm(projA, { recursive: true, force: true });

    const b = await machine();
    const z = await b.engine.addAccount('z', bundle('Z2', 'u-z'));
    const w = await b.engine.addAccount('w', bundle('W2', 'u-w'));
    await b.engine.addAccount('s1', bundle('S1', 'u-s1'));
    const s2 = await b.engine.addAccount('s2', bundle('S2', 'u-s2'));
    await b.engine.activate(z.id);
    const q = await folder(b, 'q');
    await b.engine.excludeInFolder(q, [s2.id]);
    const qRule = (await b.engine.listRules())[0]!;
    expect(qRule.activeId).toBe(w.id);

    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain('client: add, with its tokens, kept out of auto-switch');
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const out = b.out.join('');
    expect(out).not.toMatch(/is on client/);
    const row = (await b.engine.listAllAccounts()).find((r) => r.label === 'client')!;
    expect(row.autoSwitchExcluded).toBe(true);
    const live = await b.engine.liveSlots();
    expect([...live.values()]).not.toContain(row.id);
    expect(live.get('global')).not.toBe(z.id);
    expect((await b.engine.listRules()).find((r) => r.id === qRule.id)!.activeId).not.toBe(w.id);
  });

  it('quotes the command that hands it back', async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    const proj = await folder(a, 'proj');
    await a.engine.includeInFolder(proj, [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    await rm(proj, { recursive: true, force: true });
    const b = await machine();
    await b.engine.addAccount('client', bundle('L1', 'u-local'));
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain("cctl accounts include 'client (2)' lets auto-switch use it");
    b.out.length = 0;
    await importInto(b, file);
    expect(b.out.join('')).toContain("cctl accounts include 'client (2)' lets auto-switch use it");
  });
});

describe("the main login's hint after an import", () => {
  it('never names an account a rule reserves', async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    const personal = await a.engine.addAccount('personal', bundle('P1', 'u-personal'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    await a.vault.quarantine(personal.id, 'refresh token died');
    const all = join(a.root, 'all');
    const one = join(a.root, 'one');
    await runExport(all, exportAll, a.deps);
    await runExport(one, { ...exportAll, accounts: 'client' }, a.deps);
    for (const file of [all, one]) {
      const b = await machine();
      await importInto(b, file);
      const report = b.out.join('');
      expect(report).not.toContain("cctl switch 'client'");
      expect(report).toContain(
        "Nothing is live on this machine's main login yet, and no shared account here can take it",
      );
      expect(report).toContain('cctl accounts add <label>');
    }
  });

  it('names a shared account already here when the import brought none', async () => {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    await b.vault.addAccount('mine', bundle('M1', 'u-mine'));
    await importInto(b, file);
    expect(b.out.join('')).toContain("cctl switch 'mine'");
  });
});

describe('an account that travels without tokens', () => {
  it('keeps its plan, shown until its first login', async () => {
    const a = await machine();
    const max = bundle('W1', 'u-work');
    max.claudeAiOauth.subscriptionType = 'max';
    max.claudeAiOauth.rateLimitTier = 'default_claude_max_20x';
    await a.engine.addAccount('work', max);
    const file = join(a.root, 'f');
    await runExport(file, { ...exportAll, tokens: false }, a.deps);
    const b = await machine();
    await importInto(b, file);
    const [row] = await b.engine.listAllAccounts();
    expect(row).toMatchObject({
      quarantined: true,
      subscriptionType: 'max',
      rateLimitTier: 'default_claude_max_20x',
    });
    expect(renderAccountsTable(await b.engine.listAllAccounts(), null)).toContain('20x');
  });
});

describe('a file larger than any setup', () => {
  it('refuses rules holding too many folders in all, before looking any up', async () => {
    let lookups = 0;
    const b = await machine({
      resolveFolder: (f) => {
        lookups += 1;
        return resolveFolderHere(f, process.platform);
      },
    });
    const there = await folder(b, 'many');
    const rules = Array.from({ length: 8 }, (_, r) => ({
      label: `r${r}`,
      folders: [],
      aliases: Array.from({ length: 200 }, (_x, j) => ({ folder: there, alias: `s${r}_${j}` })),
      include: ['u-a'],
      exclude: [],
    }));
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [{ label: 'a', accountUuid: 'u-a', autoSwitchExcluded: false }],
        rules,
      }),
    );
    expect(await refusal(importInto(b, file, { dryRun: true }))).toContain(
      'the rules hold more than 1024 folders and session aliases in all',
    );
    expect(lookups).toBe(0);
    expect(await b.engine.listAllAccounts()).toEqual([]);
  });

  // Every bound at once: the most rules a machine holds, the most scopes in all, the most members
  // per rule, each with the longest label. What the import prints and asks of the disk and the
  // engine grows with the sum of these (each scope and member once), never with their product.
  it('handles the largest file the bounds allow with output and work that add up, not multiply', async () => {
    const MAX_PLAN_TEXT = 6_000_000;
    let lookups = 0;
    let checks = 0;
    let batches = 0;
    const b = await machine({
      resolveFolder: (f) => {
        lookups += 1;
        return resolveFolderHere(f, process.platform);
      },
    });
    b.deps.engine = engineWith(b.engine, {
      checkRuleScope: (scope: Parameters<SwitchEngine['checkRuleScope']>[0]) => {
        checks += 1;
        return b.engine.checkRuleScope(scope);
      },
      importRules: (...args: Parameters<SwitchEngine['importRules']>) => {
        batches += 1;
        return b.engine.importRules(...args);
      },
    });
    const there = await folder(b, 'many');
    const accounts = Array.from({ length: 64 }, (_, i) => ({
      label: String(i).padStart(4, '0') + 'L'.repeat(1020),
      accountUuid: `u-${i}`,
      autoSwitchExcluded: false,
    }));
    const rules = Array.from({ length: 64 }, (_, r) => ({
      label: `r${r}`,
      folders: [],
      aliases: Array.from({ length: 16 }, (_x, j) => ({
        folder: there,
        alias: `${r}-${j}-` + 'a'.repeat(190),
      })),
      include: Array.from({ length: 32 }, (_x, i) => `u-${i}`),
      exclude: Array.from({ length: 32 }, (_x, i) => `u-${32 + i}`),
    }));
    const file = await sealedFile(b, filePayload({ accounts, rules }));

    await importInto(b, file, { dryRun: true });
    const dry = b.out.join('');
    // Each member is printed once per rule and each scope once in all: 64 rules x 64 labels of
    // 1 KB is 4 MB, and the 1024 scopes add their own length once more. A fixed ceiling whatever
    // the file holds, where a product of rules, scopes and members ran past any heap.
    expect(dry.length).toBeLessThan(MAX_PLAN_TEXT);
    expect(lookups).toBe(64 * 16);
    expect(checks).toBe(64 * 16);
    expect(batches).toBe(0);

    b.out.length = 0;
    lookups = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('').length).toBeLessThan(MAX_PLAN_TEXT);
    expect(lookups).toBe(64 * 16);
    expect(batches).toBe(1);
    const made = await b.engine.listRules();
    expect(made).toHaveLength(64);
    expect(made.every((r) => r.aliases?.length === 16)).toBe(true);
  }, 300_000);
});

// ---------------------------------------------------------------------------
// The dry run is the engine's own decision, and a file rule lands whole or not at all
// ---------------------------------------------------------------------------

/** The lines a report prints under "Rules:". */
function ruleSection(report: string): string[] {
  const lines = report.split('\n');
  const start = lines.indexOf('Rules:');
  const end = lines.indexOf('Settings:', start);
  return lines.slice(start + 1, end);
}

/** A dry-run rule line as the real run reports the same verdict: the verb in the past tense, and a
 *  slot move as made rather than to be made. */
function asDone(line: string): string {
  return line
    .replace(/^(\s+\S.*?): create\b/, '$1: created')
    .replace(': add to the rule here', ': added to the rule here')
    .replace(/ moves off (.+) onto (.+)$/, ' switched off $1 (now reserved) and is on $2')
    .replace(/ will run on (.+) instead of (.+)$/, ' now runs on $1 instead of $2')
    .replace(
      / will be left with no account \((.+) is signed out of it\)$/,
      ' was left with no account ($1 was signed out of it)',
    );
}

/** Import `file` into `m` as a dry run and then for real, returning both runs' rule lines and the
 *  real run's failure count. */
async function dryThenReal(
  m: Machine,
  file: string,
): Promise<{ dry: string[]; real: string[]; failed: number }> {
  m.out.length = 0;
  expect(await importInto(m, file, { dryRun: true })).toEqual({ failed: 0 });
  const dry = ruleSection(m.out.join(''));
  m.out.length = 0;
  const { failed } = await importInto(m, file);
  return { dry, real: ruleSection(m.out.join('')), failed };
}

/** Lines only a real run prints under the rules, about what happened once they were written: a
 *  slot left with no working account, sessions that keep their account until relaunched, and an
 *  account the run kept out of, or handed back to, auto-switch. */
const AFTER_THE_WRITE = [
  /^ {4}no account is live in its slot yet/,
  /^ {4}its slot was left (?:on .+|as it was): \d+ running session\(s\) use it/,
  /^ {4}\d+ running session\(s\) under /,
  /^ {2}\S.*: (?:still )?kept out of auto-switch\b/,
  /^ {2}\S.*: handed back to auto-switch\b/,
];

/** The real run printed exactly the rule lines its dry run did, in the past tense and in the same
 *  order: no verdict, member, scope or slot move more or fewer, beside what only a real run can
 *  say about the rules it wrote. */
function expectSameVerdicts(run: { dry: string[]; real: string[] }): void {
  expect(run.dry.length).toBeGreaterThan(0);
  const real = run.real.filter((line) => !AFTER_THE_WRITE.some((re) => re.test(line)));
  expect(real).toEqual(run.dry.map(asDone));
}

/** The credential store over a rule's profile, to plant what a by-hand login there leaves. */
function ruleStore(m: Machine, ruleId: string): CredentialStore {
  const profileDir = groupProfileDir(m.paths.vaultDir, ruleId);
  return new CredentialStore({
    claudeDir: profileDir,
    credentialsPath: join(profileDir, '.credentials.json'),
    claudeJsonPath: join(profileDir, '.claude.json'),
    vaultDir: m.paths.vaultDir,
  });
}

describe('a file rule lands whole or not at all', () => {
  it('fails a rule one of whose folders holds a rule of this machine, making nothing on the rest', async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const o1 = await folder(a, 'o1');
    const o3 = await folder(a, 'o3');
    await a.vault.createRule({ folders: [o1, o3], include: [x.id], label: 'work' });
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    const xb = await b.engine.addAccount('x', bundle('X2', 'u-x'));
    await b.engine.addAccount('s2', bundle('S2', 'u-s2'));
    await b.engine.includeInFolder(o3, [xb.id], { label: 'mine' });
    const before = await b.engine.listRules();

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    const line = run.dry.find((l) => l.includes(': not imported - '));
    expect(line).toContain(`folder ${o3}`);
    expect(line).toContain('cctl folder reset');
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('fails, rather than making a second rule, when the source remade its rule under a new identity', async () => {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const p1 = await folder(a, 'p1');
    const first = await a.vault.createRule({ folders: [p1], include: [x.id], label: 'work' });
    const f1 = join(a.root, 'f1');
    await runExport(f1, exportAll, a.deps);
    const b = await machine();
    expect(await importInto(b, f1)).toEqual({ failed: 0 });
    const before = await b.engine.listRules();

    await a.vault.removeRule(first.id);
    const p2 = await folder(a, 'p2');
    await a.vault.createRule({ folders: [p1, p2], include: [x.id], label: 'work' });
    const f2 = join(a.root, 'f2');
    await runExport(f2, exportAll, a.deps);

    const run = await dryThenReal(b, f2);
    expect(run.failed).toBe(1);
    expect(run.dry.find((l) => l.includes(': not imported - '))).toContain(`folder ${p1}`);
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('fails a rule the file gives no identity when a folder of it holds a rule here', async () => {
    const b = await machine();
    const o1 = await folder(b, 'o1');
    const o3 = await folder(b, 'o3');
    const q = await b.engine.addAccount('q', bundle('Q1', 'u-q'));
    await b.engine.addAccount('s', bundle('S1', 'u-s'));
    await b.engine.includeInFolder(o3, [q.id]);
    const before = await b.engine.listRules();
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [{ label: 'x', accountUuid: 'u-x', autoSwitchExcluded: false }],
        rules: [{ label: 'r', folders: [o1, o3], aliases: [], include: ['u-x'], exclude: [] }],
      }),
    );
    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.find((l) => l.includes(': not imported - '))).toContain(`folder ${o3}`);
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('never grows a rule here that carries another identity, though it holds exactly the same folders', async () => {
    // b's rule on e1 came from machine c; a's rule on e1 is a different rule.
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const e1 = await folder(a, 'e1');
    const ruleA = await a.vault.createRule({ folders: [e1], include: [x.id], label: 'work' });
    const fromA = join(a.root, 'a1');
    await runExport(fromA, exportAll, a.deps);

    const c = await machine();
    const y = await c.engine.addAccount('y', bundle('Y1', 'u-y'));
    await c.engine.addAccount('t', bundle('T1', 'u-t'));
    await c.vault.createRule({ folders: [e1], include: [y.id], label: 'theirs' });
    const fromC = join(c.root, 'c1');
    await runExport(fromC, exportAll, c.deps);

    const b = await machine();
    expect(await importInto(b, fromC)).toEqual({ failed: 0 });
    const before = await b.engine.listRules();

    const run = await dryThenReal(b, fromA);
    expect(run.failed).toBe(1);
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);

    // The source adds a folder: still no second rule beside the one here.
    const e2 = await folder(a, 'e2');
    await a.vault.addScopesToRule(ruleA.id, { folders: [e2] });
    const again = join(a.root, 'a2');
    await runExport(again, exportAll, a.deps);
    const second = await dryThenReal(b, again);
    expect(second.failed).toBe(1);
    expectSameVerdicts(second);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('keeps one rule per source rule across three machines', async () => {
    const bm = await machine();
    const y = await bm.engine.addAccount('y', bundle('Y1', 'u-y'));
    await bm.engine.addAccount('t', bundle('T1', 'u-t'));
    const q1 = await folder(bm, 'q1');
    const q2 = await folder(bm, 'q2');
    await bm.vault.createRule({ folders: [q1, q2], include: [y.id], label: 'theirs' });
    const fromB = join(bm.root, 'b');
    await runExport(fromB, exportAll, bm.deps);

    const c = await machine();
    expect(await importInto(c, fromB)).toEqual({ failed: 0 });
    const before = await c.engine.listRules();

    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const ruleA = await a.vault.createRule({ folders: [q1, q2], include: [x.id], label: 'work' });
    const fromA = join(a.root, 'a1');
    await runExport(fromA, exportAll, a.deps);
    const run = await dryThenReal(c, fromA);
    expect(run.failed).toBe(1);
    expectSameVerdicts(run);
    expect(await c.engine.listRules()).toEqual(before);

    const q3 = await folder(a, 'q3');
    await a.vault.addScopesToRule(ruleA.id, { folders: [q3] });
    const again = join(a.root, 'a2');
    await runExport(again, exportAll, a.deps);
    const second = await dryThenReal(c, again);
    expect(second.failed).toBe(1);
    expectSameVerdicts(second);
    expect(await c.engine.listRules()).toEqual(before);
  });
});

describe('the dry run is the decision the real run makes', () => {
  /** A rule imported to `b` from `a`, and the source rule, so a test can grow either side. */
  async function imported(): Promise<{
    a: Machine;
    b: Machine;
    source: string;
    here: string;
    p: string;
  }> {
    const a = await machine();
    const x = await a.engine.addAccount('x', bundle('X1', 'u-x'));
    await a.engine.addAccount('s', bundle('S1', 'u-s'));
    const p = await folder(a, 'p');
    const rule = await a.vault.createRule({ folders: [p], include: [x.id], label: 'work' });
    const file = join(a.root, 'first');
    await runExport(file, exportAll, a.deps);
    const b = await machine();
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const here = (await b.engine.listRules())[0]!.id;
    return { a, b, source: rule.id, here, p };
  }

  it('foresees a grown rule passing the cap on session aliases', async () => {
    const { a, b, source, here, p } = await imported();
    await b.vault.addScopesToRule(here, {
      folders: [],
      aliases: Array.from({ length: 256 }, (_, i) => ({ folder: p, alias: `s${i}` })),
    });
    const before = await b.engine.listRules();
    await a.vault.addScopesToRule(source, {
      folders: [],
      aliases: [{ folder: p, alias: 'extra' }],
    });
    const file = join(a.root, 'second');
    await runExport(file, exportAll, a.deps);
    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.find((l) => l.includes(': not imported - '))).toContain(
      'a folder rule cannot hold more than 256 session aliases',
    );
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);
  });

  it('foresees a grown rule passing the cap on folders', async () => {
    const { a, b, source, here } = await imported();
    await b.vault.addScopesToRule(here, {
      folders: Array.from({ length: 255 }, (_, i) => join(b.root, 'nf', `f${i}`)),
    });
    const before = await b.engine.listRules();
    await a.vault.addScopesToRule(source, { folders: [await folder(a, 'p2')] });
    const file = join(a.root, 'second');
    await runExport(file, exportAll, a.deps);
    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.find((l) => l.includes(': not imported - '))).toContain(
      'a folder rule cannot hold more than 256 folders',
    );
    expectSameVerdicts(run);
    expect(await b.engine.listRules()).toEqual(before);
  });

  /** A file whose one rule, on its own folder, includes client. */
  async function clientFile(): Promise<string> {
    const a = await machine();
    const client = await a.engine.addAccount('client', bundle('C1', 'u-client'));
    await a.engine.includeInFolder(await folder(a, 'proj'), [client.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);
    return file;
  }

  /** Log `uuid`'s login in by hand inside a rule's profile, as `/login` there would. */
  async function loginInProfile(
    m: Machine,
    ruleId: string,
    access: string,
    uuid: string,
  ): Promise<void> {
    const store = ruleStore(m, ruleId);
    await store.writeLiveCredentials(bundle(access, uuid).claudeAiOauth);
    await store.writeOauthAccount({ accountUuid: uuid, emailAddress: `${uuid}@x.com` });
  }

  it('reads who is live in a slot recorded empty, and fails the rule in both runs', async () => {
    const file = await clientFile();
    const b = await machine();
    const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
    await b.engine.activate(other.id);
    const side = await folder(b, 'side');
    await b.engine.excludeInFolder(side, [other.id]);
    const sideRule = (await b.engine.listRules())[0]!;
    expect(sideRule.activeId).toBeNull();
    await loginInProfile(b, sideRule.id, 'C2', 'u-client');
    const client = await b.engine.addAccount('client', bundle('C2', 'u-client'));
    expect((await b.engine.listRules())[0]!.activeId).toBeNull();
    expect(await b.engine.getActiveId(ruleSlotId(sideRule.id))).toBe(client.id);

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(1);
    expect(run.dry.find((l) => l.includes(': not imported - '))).toContain(
      `it is live in the folder slot of ${side}`,
    );
    expectSameVerdicts(run);
    expect((await b.engine.listRules()).map((r) => r.id)).toEqual([sideRule.id]);
    expect(await b.engine.getActiveId(ruleSlotId(sideRule.id))).toBe(client.id);
  });

  it('reads who is live in a slot whose record names another account, and says it moves', async () => {
    const file = await clientFile();
    const b = await machine();
    const work = await b.engine.addAccount('work', bundle('W1', 'u-work'));
    const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
    await b.engine.activate(other.id);
    const side = await folder(b, 'side');
    await b.engine.excludeInFolder(side, [other.id]);
    const sideRule = (await b.engine.listRules())[0]!;
    expect(sideRule.activeId).toBe(work.id);
    const client = await b.engine.addAccount('client', bundle('C2', 'u-client'));
    await loginInProfile(b, sideRule.id, 'C2', 'u-client');
    expect((await b.engine.listRules())[0]!.activeId).toBe(work.id);
    expect(await b.engine.getActiveId(ruleSlotId(sideRule.id))).toBe(client.id);

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(0);
    expect(run.dry).toContain(`  the folder slot of ${side} moves off client onto work`);
    expectSameVerdicts(run);
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(2);
    expect(rules.find((r) => r.id !== sideRule.id)!.include).toEqual([client.id]);
    expect(await b.engine.getActiveId(ruleSlotId(sideRule.id))).toBe(work.id);
  });
});

describe('what the dry run foresees of the accounts the import stores first', () => {
  const RULE = '8c8c8c8c-8c8c-4c8c-8c8c-8c8c8c8c8c8c';

  it('decides as the real run does when --replace gives a quarantined login new tokens', async () => {
    const b = await machine();
    const client = await b.engine.addAccount('client', bundle('C1', 'u-client'));
    await b.engine.activate(client.id);
    const spare = await b.engine.addAccount('spare', bundle('S1', 'u-spare'));
    await b.vault.quarantine(spare.id, 'invalid_grant');
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          { label: 'client', accountUuid: 'u-client', autoSwitchExcluded: false },
          {
            label: 'spare',
            accountUuid: 'u-spare',
            autoSwitchExcluded: false,
            bundle: bundle('S2', 'u-spare'),
          },
          {
            label: 'fresh',
            accountUuid: 'u-fresh',
            autoSwitchExcluded: false,
            bundle: bundle('F1', 'u-fresh'),
          },
        ],
        rules: [
          {
            label: 'r',
            origin: RULE,
            folders: [await folder(b, 'proj')],
            aliases: [],
            include: ['u-client', 'u-fresh'],
            exclude: [],
          },
        ],
      }),
    );

    b.out.length = 0;
    expect(await importInto(b, file, { dryRun: true, replace: true })).toEqual({ failed: 0 });
    const dry = ruleSection(b.out.join(''));
    expect(dry).toContain('  the global slot moves off client onto spare');
    b.out.length = 0;
    expect(await importInto(b, file, { replace: true })).toEqual({ failed: 0 });
    expectSameVerdicts({ dry, real: ruleSection(b.out.join('')) });
    expect(await b.engine.getActiveId('global')).toBe(spare.id);
    const fresh = (await b.engine.listAllAccounts()).find((a) => a.label === 'fresh')!;
    expect(fresh.autoSwitchExcluded).not.toBe(true);
  });

  it('decides as the real run does when --replace keeps a newer stored copy of a login it records', async () => {
    const CID = '5e5e5e5e-5e5e-4e5e-8e5e-5e5e5e5e5e5e';
    const b = await machine();
    const first = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'client',
            id: CID,
            emailAddress: 'c@x.com',
            autoSwitchExcluded: false,
            bundle: {
              claudeAiOauth: {
                accessToken: 'C0',
                refreshToken: 'r-C0',
                expiresAt: Date.now() + 10 * HOUR,
              },
              oauthAccount: { emailAddress: 'c@x.com' },
            },
          },
        ],
      }),
      'first.cctl',
    );
    expect(await importInto(b, first)).toEqual({ failed: 0 });
    const other = await b.engine.addAccount('other', bundle('O1', 'u-other'));
    await b.engine.activate(other.id);
    const live = new CredentialStore(b.paths);
    await live.writeLiveCredentials(bundle('C-LIVE', 'u-c').claudeAiOauth);
    await live.writeOauthAccount({ accountUuid: 'u-c', emailAddress: 'c@x.com' });
    const second = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'client',
            id: CID,
            accountUuid: 'u-c',
            emailAddress: 'c@x.com',
            autoSwitchExcluded: false,
            // Older than the copy stored here, which the real run keeps.
            bundle: {
              claudeAiOauth: {
                accessToken: 'C-OLD',
                refreshToken: 'r-C-OLD',
                expiresAt: Date.now() + HOUR,
              },
              oauthAccount: { accountUuid: 'u-c', emailAddress: 'c@x.com' },
            },
          },
        ],
        rules: [
          {
            label: 'r',
            folders: [await folder(b, 'proj')],
            aliases: [],
            include: ['u-c'],
            exclude: [],
          },
        ],
      }),
      'second.cctl',
    );

    b.out.length = 0;
    await importInto(b, second, { dryRun: true, replace: true });
    const dry = ruleSection(b.out.join(''));
    expect(dry).toContain('  the global slot moves off client onto other');
    b.out.length = 0;
    expect(await importInto(b, second, { replace: true })).toEqual({ failed: 0 });
    expectSameVerdicts({ dry, real: ruleSection(b.out.join('')) });
    expect(await b.engine.getActiveId('global')).toBe(other.id);
  });
});

describe('a rule of the file next to a rule of this machine', () => {
  it('fails whole when a rule here holds a folder of it that is gone from this machine', async () => {
    const b = await machine();
    const y = await b.engine.addAccount('y', bundle('Y1', 'u-y'));
    await b.engine.addAccount('s', bundle('S1', 'u-s'));
    const old = await folder(b, 'old');
    await b.vault.createRule({ folders: [old], include: [y.id], label: 'mine' });
    await rm(old, { recursive: true });
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'x',
            accountUuid: 'u-x',
            autoSwitchExcluded: false,
            bundle: bundle('X1', 'u-x'),
          },
        ],
        rules: [
          {
            label: 'theirs',
            origin: '9d9d9d9d-9d9d-4d9d-8d9d-9d9d9d9d9d9d',
            folders: [await folder(b, 'app'), old],
            aliases: [],
            include: ['u-x'],
            exclude: [],
          },
        ],
      }),
    );

    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 1 });
    expect(b.out.join('')).toContain('already has a rule here ("mine")');
    expect((await b.engine.listRules()).map((r) => r.label)).toEqual(['mine']);
  });

  it('names a merge by hand that lets the next import land, for a rule here on several folders', async () => {
    const b = await machine();
    const x = await b.engine.addAccount('x', bundle('X1', 'u-x'));
    const y = await b.engine.addAccount('y', bundle('Y1', 'u-y'));
    await b.engine.addAccount('s', bundle('S1', 'u-s'));
    const p = await folder(b, 'p');
    const q = await folder(b, 'q');
    await b.vault.createRule({ folders: [p, q], include: [x.id], label: 'mine' });
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          { label: 'x', accountUuid: 'u-x', autoSwitchExcluded: false },
          { label: 'y', accountUuid: 'u-y', autoSwitchExcluded: false },
        ],
        rules: [
          {
            label: 'theirs',
            origin: '7e7e7e7e-7e7e-4e7e-8e7e-7e7e7e7e7e7e',
            folders: [p, q],
            aliases: [],
            include: ['u-x', 'u-y'],
            exclude: [],
          },
        ],
      }),
    );

    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 1 });
    const report = b.out.join('');
    for (const f of [p, q]) {
      expect(report).toContain(`cctl folder reset ${shellQuote(f, process.platform)}`);
    }
    expect(report).not.toContain('cctl folder include');

    // Following the hint: every folder of the rule here reset, which removes it.
    for (const f of [p, q]) await b.engine.resetFolder(f);
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const rules = await b.engine.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0]!.include.sort()).toEqual([x.id, y.id].sort());
  });
});

describe('the lines a real run prints', () => {
  it("names a moved slot the way its dry run did, when the batch grows that slot's rule", async () => {
    const b = await machine();
    const eve = await b.engine.addAccount('eve', bundle('E1', 'u-eve'));
    const frank = await b.engine.addAccount('frank', bundle('F1', 'u-frank'));
    const gg = await b.engine.addAccount('gg', bundle('G1', 'u-gg'));
    await b.engine.activate(gg.id);
    const p5 = await folder(b, 'p5');
    const side = await b.engine.excludeInFolder(p5, [gg.id]);
    expect(await b.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(eve.id);
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          { label: 'eve', accountUuid: 'u-eve', autoSwitchExcluded: false },
          { label: 'frank', accountUuid: 'u-frank', autoSwitchExcluded: false },
          { label: 'gg', accountUuid: 'u-gg', autoSwitchExcluded: false },
        ],
        rules: [
          {
            label: p5,
            origin: side.rule.id,
            folders: [p5, await folder(b, 'q3')],
            aliases: [],
            include: [],
            exclude: ['u-gg'],
          },
          {
            label: 'p1',
            folders: [await folder(b, 'p1')],
            aliases: [],
            include: ['u-eve'],
            exclude: [],
          },
        ],
      }),
    );

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(0);
    expect(run.dry).toContain(`  the folder slot of ${p5} moves off eve onto frank`);
    expectSameVerdicts(run);
    expect(await b.engine.getActiveId(ruleSlotId(side.rule.id))).toBe(frank.id);
  });

  it('names an account for the main login that is free to take it', async () => {
    // The file's exclude-only rule is seated with dave, the first account the import adds; the
    // main login is left empty, and dave cannot take it while it runs that rule's folder.
    const b = await machine();
    const file = await sealedFile(
      b,
      filePayload({
        accounts: ['dave', 'frank', 'eve'].map((label) => ({
          label,
          accountUuid: `u-${label}`,
          autoSwitchExcluded: false,
          bundle: bundle(label.toUpperCase(), `u-${label}`),
        })),
        rules: [
          {
            label: 'p1',
            folders: [await folder(b, 'p1')],
            aliases: [],
            include: [],
            exclude: ['u-eve'],
          },
        ],
      }),
    );

    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const rule = (await b.engine.listRules())[0]!;
    const accounts = await b.engine.listAllAccounts();
    const dave = accounts.find((a) => a.label === 'dave')!;
    expect(await b.engine.getActiveId(ruleSlotId(rule.id))).toBe(dave.id);
    const hint = b.out
      .join('')
      .split('\n')
      .find((l) => l.includes('cctl switch'));
    expect(hint).toBeDefined();
    const named = accounts.find((a) => hint!.endsWith(shellQuote(a.label, process.platform)))!;
    expect(named.label).toBe('frank');
    await expect(b.engine.activate(named.id)).resolves.toBeDefined();
  });
});

describe('the comparison of a dry run with its real run', () => {
  it('fails a real run that printed a line its dry run did not, or left one out', () => {
    const dry = ['  folder /p: create, include x'];
    const created = '  folder /p: created, include x';
    const moved = '  the global slot switched off x (now reserved) and is on y';
    expect(() => expectSameVerdicts({ dry, real: [created] })).not.toThrow();
    expect(() => expectSameVerdicts({ dry, real: [created, moved] })).toThrow();
    expect(() =>
      expectSameVerdicts({
        dry: [...dry, '  the global slot moves off x onto y'],
        real: [created],
      }),
    ).toThrow();
    // What only a real run can say about a rule it wrote is not a difference.
    expect(() =>
      expectSameVerdicts({
        dry,
        real: [created, '    no account is live in its slot yet (cctl folders shows why)'],
      }),
    ).not.toThrow();
  });
});

describe('an account held back for a rule the plan would not make', () => {
  it('goes back to auto-switch, and says so, when the run makes that rule after all', async () => {
    const b = await machine();
    await b.engine.addAccount('other', bundle('O1', 'u-other'));
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          {
            label: 'fresh',
            accountUuid: 'u-fresh',
            autoSwitchExcluded: false,
            bundle: bundle('F1', 'u-fresh'),
          },
        ],
        rules: [
          {
            label: 'r',
            folders: [await folder(b, 'proj')],
            aliases: [],
            include: ['u-fresh'],
            exclude: [],
          },
        ],
      }),
    );
    // The plan is made before the accounts are stored; here it refuses the rule, as a plan would
    // that the machine then changed under.
    b.deps.engine = engineWith(b.engine, {
      planImportRules: (specs) =>
        Promise.resolve({
          rules: specs.map(() => ({ kind: 'refused' as const, message: 'not yet' })),
          handOffs: [],
          seats: [],
        }),
    });

    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    const fresh = (await b.engine.listAllAccounts()).find((a) => a.label === 'fresh')!;
    expect(fresh.ruleIds).toHaveLength(1);
    expect(fresh.autoSwitchExcluded).not.toBe(true);
    expect(b.out.join('')).toContain(
      'fresh: handed back to auto-switch (the rule it is reserved to was made after all)',
    );
  });
});

describe('slots the seat step moves, and an import stopped part-way', () => {
  it('names a running slot the seat step moves, in the dry run and the real run alike', async () => {
    const b = await machine();
    const g = await b.engine.addAccount('g', bundle('G1', 'u-g'));
    const a = await b.engine.addAccount('a', bundle('A1', 'u-a'));
    const was = await b.engine.addAccount('b', bundle('B1', 'u-b'));
    const d = await b.engine.addAccount('d', bundle('D1', 'u-d'));
    await b.engine.activate(g.id);
    const p1 = await folder(b, 'p1');
    const origin = '5c5c5c5c-5c5c-4c5c-8c5c-5c5c5c5c5c5c';
    const rule = await b.vault.createRule({ folders: [p1], include: [a.id], origin });
    // Auto-switch had moved the slot onto an inherited account; a session runs under the rule.
    await b.engine.activate(was.id, { slot: ruleSlotId(rule.id) });
    await mkdir(join(b.paths.claudeDir, 'sessions'), { recursive: true });
    await writeFile(
      join(b.paths.claudeDir, 'sessions', 'running.json'),
      JSON.stringify({ pid: process.pid, cwd: p1 }),
    );
    const file = await sealedFile(
      b,
      filePayload({
        accounts: ['a', 'b', 'd', 'g'].map((label) => ({
          label,
          accountUuid: `u-${label}`,
          autoSwitchExcluded: false,
        })),
        rules: [
          { label: 'p1', origin, folders: [p1], aliases: [], include: ['u-a', 'u-d'], exclude: [] },
        ],
      }),
    );

    const run = await dryThenReal(b, file);
    expect(run.failed).toBe(0);
    expect(run.dry).toContain(`  the folder slot of ${p1} will run on d instead of b`);
    expectSameVerdicts(run);
    expect(await b.engine.getActiveId(ruleSlotId(rule.id))).toBe(d.id);
  });

  it('finds the rule it made from a file rule with no identity, when the file comes again', async () => {
    const b = await machine();
    await b.engine.addAccount('x', bundle('X1', 'u-x'));
    await b.engine.addAccount('s', bundle('S1', 'u-s'));
    const p = await folder(b, 'p');
    const q = await folder(b, 'q');
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [{ label: 'x', accountUuid: 'u-x', autoSwitchExcluded: false }],
        rules: [{ label: 'theirs', folders: [p, q], aliases: [], include: [], exclude: ['u-x'] }],
      }),
    );

    expect(await importInto(b, file)).toEqual({ failed: 0 });
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain('skipped - this machine already has this rule');
    expect(await b.engine.listRules()).toHaveLength(1);
  });

  it('reports the slots an import moved before it stopped, and brings the guard up to date', async () => {
    const b = await machine();
    const x = await b.engine.addAccount('x', bundle('X1', 'u-x'));
    const y = await b.engine.addAccount('y', bundle('Y1', 'u-y'));
    await b.engine.activate(x.id);
    const file = await sealedFile(
      b,
      filePayload({
        accounts: [
          { label: 'x', accountUuid: 'u-x', autoSwitchExcluded: false },
          { label: 'y', accountUuid: 'u-y', autoSwitchExcluded: false },
        ],
        rules: [
          {
            label: 'p',
            folders: [await folder(b, 'p')],
            aliases: [],
            include: ['u-x'],
            exclude: [],
          },
        ],
      }),
    );
    b.deps.engine = engineWith(b.engine, {
      importRules: () =>
        Promise.reject(
          new ImportInterruptedError(
            [{ slot: 'global', from: x.id, to: y.id }],
            [],
            new Error('the disk went away'),
          ),
        ),
    });

    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 1 });
    const report = b.out.join('');
    expect(report).toContain('the global slot switched off x (now reserved) and is on y');
    expect(report).toContain('the import stopped part-way (the disk went away)');
    expect(b.guardRuns).toBe(1);
  });
});
