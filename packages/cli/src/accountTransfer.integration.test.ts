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
  FileCredentialChannel,
  InsecurePassthroughProtector,
  LockTimeoutError,
  SwitchEngine,
  Vault,
  VaultError,
  acquireLock,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { CliFailure } from './context.js';
import { SCRYPT_LIMITS, sealExport } from './exportEnvelope.js';
import { shellQuote } from './folderRender.js';
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
    await importInto(b, file, { dryRun: true });
    expect(b.out.join('')).toContain("this machine's main login moves off client");
    b.out.length = 0;
    expect(await importInto(b, file)).toEqual({ failed: 0 });
    expect(b.out.join('')).toContain(
      'the global slot switched off client (now reserved) and is on other',
    );

    const c = await machine();
    const only = await c.engine.addAccount('client', bundle('C3', 'u-client'));
    await c.engine.activate(only.id);
    const why = "including client would leave this machine's main login with no shared account";
    await importInto(c, file, { dryRun: true });
    expect(c.out.join('')).toContain(why);
    c.out.length = 0;
    expect(await importInto(c, file)).toEqual({ failed: 0 });
    expect(c.out.join('')).toContain(why);
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
          { label: 'anon', autoSwitchExcluded: false },
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
