// `cctl export` / `cctl import` end to end: two sandboxed "machines" (each its own vault, config
// and main config dir, with a real engine over a pass-through protector), a sealed file between
// them, and the registry, rules and settings compared on both sides.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  Vault,
  acquireLock,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { CliFailure } from './context.js';
import { SCRYPT_LIMITS } from './exportEnvelope.js';
import {
  ONE_MACHINE_WARNING,
  resolveFolderHere,
  runExport,
  runImport,
  type ExportOptions,
  type TransferDeps,
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
    resolveFolder: (folder) => resolveFolderHere(folder),
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
      'Exported 3 accounts (3 with tokens), 3 rules and 2 setting(s)',
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
    expect(config).toEqual({ env: { CCTL_AUTOSWITCH: 'off' }, relayUrl: 'wss://relay.example' });
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
    expect(report).toContain('this machine already has a rule there');
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
      'Log in to each account that came without tokens:\n  cctl accounts relogin work',
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
    expect(b.out.join('')).toContain('cctl accounts relogin dead');
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
  it('leaves out an exclusion of an account the file reserves to another rule', async () => {
    const a = await machine();
    await a.engine.addAccount('work', bundle('W1', 'u-work'));
    const home = await a.engine.addAccount('home', bundle('H1', 'u-home'));
    const spare = await a.engine.addAccount('spare', bundle('S1', 'u-spare'));
    const other = await folder(a, 'other');
    const both = await folder(a, 'both');
    const proj = await folder(a, 'proj');
    // Excluded first, reserved after: the exclusion stays on record, inert.
    await a.engine.excludeInFolder(other, [home.id]);
    await a.engine.excludeInFolder(both, [home.id]);
    await a.engine.includeInFolder(both, [spare.id]);
    await a.engine.includeInFolder(proj, [home.id]);
    const file = join(a.root, 'f');
    await runExport(file, exportAll, a.deps);

    const b = await machine();
    expect(await runImport(file, { dryRun: false, replace: false }, b.deps)).toEqual({ failed: 0 });
    const report = b.out.join('');
    expect(report).toContain(
      `folder ${other}: skipped - another rule reserves every account it excludes, so it would change nothing`,
    );
    expect(report).toContain(
      `folder ${both}: created, include spare; exclude home (not excluded, as another rule reserves them: home)`,
    );
    expect(report).toContain(`folder ${proj}: created, include home`);
    const rules = await b.engine.listRules();
    expect(rules.map((r) => r.folders[0]).sort()).toEqual([both, proj].sort());
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
      'the passphrase does not open this file; nothing was imported',
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
