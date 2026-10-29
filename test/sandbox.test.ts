// Proves the test sandbox holds: every test file runs with a throwaway home, and a write aimed at
// the real Claude login or cctl state is refused in this process and in node children.
//
// Every refusal is probed with a new, harmless file name inside a protected folder, never with the
// real credential files, so a broken guard leaves at most a stray probe file (removed below)
// rather than a damaged login.

import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { powerShellRunner, startDaemonTaskNow } from '../packages/cli/src/daemonInstall.js';
import { managedDropInDir } from '../packages/cli/src/managedSettings.js';
import {
  CLAUDE_CLI_KEYCHAIN_SERVICE,
  resolveClaudeCliKeychainTarget,
} from '../packages/switch-engine/src/keychain.js';
import { defaultPaths } from '../packages/switch-engine/src/paths.js';

const realHome = userInfo().homedir;
const probes: string[] = [];

/** A fresh probe path inside a protected location, removed after the test either way. */
function probe(dir: string, name = 'cctl-guard-probe'): string {
  const p = join(dir, `${name}-${process.pid}-${probes.length}.tmp`);
  probes.push(p);
  return p;
}

afterEach(() => {
  // The deliberate refusals below are logged like real ones; clear them so the sandbox's own
  // after-file check only fails on writes this file did not mean to make.
  const log = process.env.CCTL_TEST_GUARD_LOG;
  if (log && existsSync(log)) fs.truncateSync(log, 0);
  for (const p of probes.splice(0)) {
    if (existsSync(p)) {
      fs.rmSync(p, { force: true, recursive: true });
      throw new Error(`guard let a probe through: ${p}`);
    }
  }
});

/** The guard's refusal, as thrown. */
const refused = expect.objectContaining({ code: 'ELIVEGUARD' });

describe('test sandbox environment', () => {
  it('moves every home and data variable into a temp folder', () => {
    const sandboxRoot = tmpdir();
    for (const name of [
      'HOME',
      'USERPROFILE',
      'LOCALAPPDATA',
      'APPDATA',
      'XDG_DATA_HOME',
      'XDG_CONFIG_HOME',
    ]) {
      expect(process.env[name], name).toContain(sandboxRoot);
      expect(process.env[name], name).toContain('cctl-test-home-');
    }
    expect(homedir()).not.toBe(realHome);
    expect(process.env.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it("resolves cctl's real paths into the sandbox", () => {
    const paths = defaultPaths();
    for (const p of [
      paths.claudeDir,
      paths.credentialsPath,
      paths.claudeJsonPath,
      paths.vaultDir,
    ]) {
      expect(p).toContain('cctl-test-home-');
      expect(p.toLowerCase().startsWith(join(realHome, '.claude').toLowerCase())).toBe(false);
    }
  });
});

describe('live-state guard', () => {
  it('refuses sync, promise, callback, stream and named-import writes into the real Claude dir', async () => {
    const claudeDir = join(realHome, '.claude');
    expect(() => fs.writeFileSync(probe(claudeDir), 'x')).toThrow(refused);
    expect(() => writeFileSync(probe(claudeDir), 'x')).toThrow(refused);
    expect(() => fs.mkdirSync(probe(claudeDir))).toThrow(refused);
    await expect(fs.promises.writeFile(probe(claudeDir), 'x')).rejects.toThrow(refused);
    expect(() => fs.createWriteStream(probe(claudeDir))).toThrow(refused);
    const viaCallback = await new Promise((resolve) =>
      fs.writeFile(probe(claudeDir), 'x', (err) => resolve(err)),
    );
    expect(viaCallback).toEqual(refused);
  });

  it('refuses the temp and backup files written beside ~/.claude.json', () => {
    expect(() => fs.writeFileSync(probe(realHome, '.claude.json.guard'), 'x')).toThrow(refused);
  });

  it('refuses a rename into a protected folder', () => {
    const src = join(tmpdir(), `cctl-guard-src-${process.pid}.tmp`);
    fs.writeFileSync(src, 'x');
    try {
      expect(() => fs.renameSync(src, probe(join(realHome, '.claude')))).toThrow(refused);
    } finally {
      fs.rmSync(src, { force: true });
    }
  });

  it("refuses writes into cctl's real data folder", () => {
    const dataDir = join(realHome, 'AppData', 'Local', 'claude-control');
    expect(() => fs.writeFileSync(probe(dataDir), 'x')).toThrow(refused);
  });

  it('lets reads of protected files through', () => {
    // Opening for read is not a write: a missing file reports ENOENT, not a refusal.
    expect(() => fs.openSync(probe(join(realHome, '.claude')), 'r')).toThrow(
      expect.objectContaining({ code: 'ENOENT' }),
    );
  });

  it('follows a link planted in the sandbox back to the real folder', () => {
    const link = join(tmpdir(), `cctl-guard-link-${process.pid}`);
    fs.symlinkSync(join(realHome, '.claude'), link, 'junction');
    try {
      const target = probe(link);
      // Track the real-side name too, so a leak is caught and removed under its real path.
      probes.push(join(realHome, '.claude', target.slice(link.length + 1)));
      expect(() => fs.writeFileSync(target, 'x')).toThrow(refused);
    } finally {
      // Remove the link itself; never a recursive delete, which must not walk into the target. A
      // junction goes as a directory; a POSIX symlink is a file entry.
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    }
  });

  it('follows a planted link to a protected folder that does not exist yet', () => {
    const link = join(tmpdir(), `cctl-guard-dangling-${process.pid}`);
    const missing = join(realHome, '.claude', `cctl-guard-missing-${process.pid}`);
    probes.push(missing);
    fs.symlinkSync(missing, link, 'junction');
    try {
      expect(() => fs.mkdirSync(link, { recursive: true })).toThrow(refused);
      expect(() => fs.writeFileSync(join(link, 'probe.tmp'), 'x')).toThrow(refused);
    } finally {
      if (process.platform === 'win32') fs.rmdirSync(link);
      else fs.unlinkSync(link);
    }
  });

  it('is preloaded into node children, which refuse the same writes', () => {
    const target = probe(join(realHome, '.claude'));
    const child = spawnSync(
      process.execPath,
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'x')`],
      { encoding: 'utf8' },
    );
    expect(child.status).not.toBe(0);
    expect(child.stderr).toContain('test sandbox refused');
  });
});

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * Run `code` (an ES module) in a node child whose guard also protects a fresh scratch folder (or
 * what `protect` names in it), passing that folder and a second, unprotected one as argv[1] and
 * argv[2]. The real locations stay protected in the child too. Returns what the child printed,
 * and the two folders.
 */
function inGuardedChild(
  code: string,
  setUp: (prot: string) => void = () => undefined,
  protect: (prot: string) => { kind: string; path: string }[] = (prot) => [
    { kind: 'tree', path: prot },
  ],
): { out: string; prot: string; free: string } {
  const prot = fs.mkdtempSync(join(tmpdir(), 'cctl-guard-prot-'));
  const free = fs.mkdtempSync(join(tmpdir(), 'cctl-guard-free-'));
  scratch.push(prot, free);
  setUp(prot);
  const protectedList = [
    ...(JSON.parse(process.env.CCTL_TEST_PROTECTED_PATHS ?? '[]') as unknown[]),
    ...protect(prot),
  ];
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code, prot, free], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CCTL_TEST_PROTECTED_PATHS: JSON.stringify(protectedList),
      CCTL_TEST_GUARD_LOG: join(free, 'trips.log'),
    },
  });
  return { out: child.stdout, prot, free };
}

describe('live-state guard: ways around the fs functions', () => {
  it('refuses a hard link to a protected file, which a later write would go through', () => {
    const run = inGuardedChild(
      `import fs from 'node:fs';
       const [prot, free] = process.argv.slice(1);
       try {
         fs.linkSync(prot + '/real.txt', free + '/link.txt');
         fs.writeFileSync(free + '/link.txt', 'OVERWRITTEN');
         console.log('WROTE');
       } catch (err) { console.log(err.code); }`,
      (prot) => fs.writeFileSync(join(prot, 'real.txt'), 'original'),
    );
    expect(run.out.trim()).toBe('ELIVEGUARD');
    expect(fs.readFileSync(join(run.prot, 'real.txt'), 'utf8')).toBe('original');
  });

  it('refuses a SQLite database opened in a protected folder, by either import', () => {
    const run = inGuardedChild(
      `import { DatabaseSync } from 'node:sqlite';
       import sqlite from 'node:sqlite';
       const [prot] = process.argv.slice(1);
       for (const Db of [DatabaseSync, sqlite.DatabaseSync]) {
         try {
           const db = new Db(prot + '/daemon.db');
           db.exec('create table t(x)');
           db.close();
           console.log('WROTE');
         } catch (err) { console.log(err.code); }
       }`,
    );
    expect(run.out.trim().split(/\s+/)).toEqual(['ELIVEGUARD', 'ELIVEGUARD']);
    expect(fs.readdirSync(run.prot)).toEqual([]);
  });

  it('arms the guard in the worker threads of a node child', () => {
    const run = inGuardedChild(
      `import { Worker } from 'node:worker_threads';
       const [prot] = process.argv.slice(1);
       const target = JSON.stringify(prot + '/worker.txt');
       const w = new Worker("process.getBuiltinModule('node:fs').writeFileSync(" + target + ", 'x')", { eval: true });
       w.on('error', (err) => console.log(err.code ?? err.message));`,
    );
    expect(run.out.trim()).toBe('ELIVEGUARD');
    expect(fs.readdirSync(run.prot)).toEqual([]);
  });

  it('arms the guard in the worker threads of the test process itself', async () => {
    // The worker is told to protect a scratch folder as well, so a guard that is not armed there
    // writes only into scratch.
    const prot = fs.mkdtempSync(join(tmpdir(), 'cctl-guard-prot-'));
    scratch.push(prot);
    const protectedList = [
      ...(JSON.parse(process.env.CCTL_TEST_PROTECTED_PATHS ?? '[]') as unknown[]),
      { kind: 'tree', path: prot },
    ];
    const target = JSON.stringify(join(prot, 'worker.txt'));
    const worker = new Worker(`process.getBuiltinModule('node:fs').writeFileSync(${target}, 'x')`, {
      eval: true,
      env: { ...process.env, CCTL_TEST_PROTECTED_PATHS: JSON.stringify(protectedList) },
    });
    const failure = await new Promise((resolve) => {
      worker.on('error', resolve);
      worker.on('exit', () => resolve(undefined));
    });
    expect(failure).toEqual(refused);
    expect(fs.readdirSync(prot)).toEqual([]);
  });

  it('refuses a shell child handed a protected path', () => {
    const run = inGuardedChild(
      `import { spawnSync } from 'node:child_process';
       import { join } from 'node:path';
       const [prot] = process.argv.slice(1);
       const target = join(prot, 'c.txt');
       try {
         const res = process.platform === 'win32'
           ? spawnSync('cmd.exe', ['/c', 'echo hi> ' + target])
           : spawnSync('sh', ['-c', 'echo hi > ' + target]);
         console.log(res.error?.code ?? 'RAN');
       } catch (err) { console.log(err.code); }`,
    );
    expect(run.out.trim()).toBe('ELIVEGUARD');
    expect(fs.readdirSync(run.prot)).toEqual([]);
  });

  it('steps back over a `..` after a planted link the way the OS does', () => {
    // free/lnk points at prot/sub. A POSIX kernel follows the link before it steps back, so
    // free/lnk/../up.txt is prot/up.txt; Windows steps back by name first, so it is free/up.txt.
    // The second path steps back inside a folder the recursive mkdir creates, then through the
    // link: prot/sub/deep on every OS.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       const [prot, free] = process.argv.slice(1);
       const sep = process.platform === 'win32' ? '\\\\' : '/';
       fs.symlinkSync(prot + sep + 'sub', free + sep + 'lnk', 'junction');
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       console.log([
         attempt(() => fs.writeFileSync([free, 'lnk', '..', 'up.txt'].join(sep), 'x')),
         attempt(() => fs.mkdirSync([free, 'new', '..', 'lnk', 'deep'].join(sep), { recursive: true })),
       ].join(' '));`,
      (prot) => fs.mkdirSync(join(prot, 'sub')),
    );
    if (process.platform === 'win32') {
      expect(run.out.trim()).toBe('OK ELIVEGUARD');
      expect(existsSync(join(run.free, 'up.txt'))).toBe(true);
    } else {
      expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD');
    }
    expect(fs.readdirSync(run.prot)).toEqual(['sub']);
    expect(fs.readdirSync(join(run.prot, 'sub'))).toEqual([]);
  });

  it('reads a trailing separator after a planted link the way the OS does', () => {
    // free/dang points at prot/new, which does not exist yet: `dang/` names prot/new, so a folder
    // made through it is refused. free/lnk points at prot/sub: a POSIX kernel follows it for
    // `lnk/`, so a recursive remove empties prot/sub; Windows drops the separator and removes
    // only the link.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       const [prot, free] = process.argv.slice(1);
       const sep = process.platform === 'win32' ? '\\\\' : '/';
       fs.symlinkSync(prot + sep + 'new', free + sep + 'dang', 'junction');
       fs.symlinkSync(prot + sep + 'sub', free + sep + 'lnk', 'junction');
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       console.log([
         attempt(() => fs.mkdirSync(free + sep + 'dang' + sep, { recursive: true })),
         attempt(() => fs.rmSync(free + sep + 'lnk' + sep, { recursive: true, force: true })),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'sub'));
        fs.writeFileSync(join(prot, 'sub', 'keep.txt'), 'x');
      },
    );
    expect(run.out.trim()).toBe(
      process.platform === 'win32' ? 'ELIVEGUARD OK' : 'ELIVEGUARD ELIVEGUARD',
    );
    expect(fs.readdirSync(run.prot)).toEqual(['sub']);
    expect(fs.readdirSync(join(run.prot, 'sub'))).toEqual(['keep.txt']);
  });

  it('refuses removing, moving or copying over a folder that holds a protected location', () => {
    // prot/home stands in for the real home, holding a protected .claude folder; prot/home2 holds
    // a protected .claude.json file.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { join } from 'node:path';
       const [prot, free] = process.argv.slice(1);
       const home = join(prot, 'home');
       fs.mkdirSync(join(free, 'src', '.claude'), { recursive: true });
       fs.writeFileSync(join(free, 'src', '.claude', 'creds.json'), 'fake');
       fs.mkdirSync(join(free, 'notes'));
       fs.writeFileSync(join(free, 'notes', 'notes.txt'), 'x');
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       console.log([
         attempt(() => fs.rmSync(home, { recursive: true, force: true })),
         attempt(() => fs.rmSync(prot, { recursive: true, force: true })),
         attempt(() => fs.renameSync(home, join(free, 'moved'))),
         attempt(() => fs.cpSync(join(free, 'src'), home, { recursive: true })),
         attempt(() => fs.rmSync(join(prot, 'home2'), { recursive: true, force: true })),
         attempt(() => fs.rmSync(join(home, 'other'), { recursive: true })),
         attempt(() => fs.cpSync(join(free, 'notes'), join(prot, 'home2'), { recursive: true })),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'home', '.claude'), { recursive: true });
        fs.writeFileSync(join(prot, 'home', '.claude', 'keep.txt'), 'x');
        fs.mkdirSync(join(prot, 'home', 'other'));
        fs.mkdirSync(join(prot, 'home2'));
        fs.writeFileSync(join(prot, 'home2', '.claude.json'), '{}');
      },
      (prot) => [
        { kind: 'tree', path: join(prot, 'home', '.claude') },
        { kind: 'prefix', path: join(prot, 'home2', '.claude.json') },
      ],
    );
    // A copy that only puts files beside a protected one is let through.
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD ELIVEGUARD ELIVEGUARD ELIVEGUARD OK OK');
    expect(fs.readdirSync(join(run.prot, 'home'))).toEqual(['.claude']);
    expect(fs.readdirSync(join(run.prot, 'home', '.claude'))).toEqual(['keep.txt']);
    expect(fs.readdirSync(join(run.prot, 'home2')).sort()).toEqual(['.claude.json', 'notes.txt']);
  });

  it('guards a protected folder that is itself a link by both its names', () => {
    // prot/home/.claude is a link into prot/dot, as a dotfiles setup keeps it. A write through it
    // reaches prot/dot/claude; removing it or renaming over it replaces the link.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { join } from 'node:path';
       const [prot, free] = process.argv.slice(1);
       const login = join(prot, 'home', '.claude');
       fs.mkdirSync(join(free, 'fake'));
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       console.log([
         attempt(() => fs.writeFileSync(join(login, 'probe.tmp'), 'x')),
         attempt(() => fs.rmSync(login, { recursive: true, force: true })),
         attempt(() => fs.renameSync(join(free, 'fake'), login)),
         attempt(() => fs.rmSync(join(prot, 'dot'), { recursive: true, force: true })),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'dot', 'claude'), { recursive: true });
        fs.writeFileSync(join(prot, 'dot', 'claude', 'keep.txt'), 'x');
        fs.mkdirSync(join(prot, 'home'));
        fs.symlinkSync(join(prot, 'dot', 'claude'), join(prot, 'home', '.claude'), 'junction');
      },
      (prot) => [{ kind: 'tree', path: join(prot, 'home', '.claude') }],
    );
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD ELIVEGUARD ELIVEGUARD');
    expect(fs.lstatSync(join(run.prot, 'home', '.claude')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(join(run.prot, 'dot', 'claude'))).toEqual(['keep.txt']);
  });

  it('guards a protected folder reached through a link above it', () => {
    // prot/home/.claude is a link to prot/home/dotfiles/claude, and prot/home/dotfiles is itself
    // a link to prot/store/dotfiles. Removing that middle link and making a folder in its place
    // would move the protected path somewhere a test could then write.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { join } from 'node:path';
       const [prot] = process.argv.slice(1);
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       console.log([
         attempt(() => fs.rmSync(join(prot, 'home', 'dotfiles'), { recursive: true, force: true })),
         attempt(() => fs.renameSync(join(prot, 'home', 'dotfiles'), join(prot, 'moved'))),
         attempt(() => fs.writeFileSync(join(prot, 'home', '.claude', 'probe.tmp'), 'x')),
         attempt(() => fs.writeFileSync(join(prot, 'home', 'dotfiles', 'other.txt'), 'x')),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'store', 'dotfiles', 'claude'), { recursive: true });
        fs.writeFileSync(join(prot, 'store', 'dotfiles', 'claude', 'keep.txt'), 'x');
        fs.mkdirSync(join(prot, 'home'));
        fs.symlinkSync(join(prot, 'store', 'dotfiles'), join(prot, 'home', 'dotfiles'), 'junction');
        const target = join(prot, 'home', 'dotfiles', 'claude');
        fs.symlinkSync(target, join(prot, 'home', '.claude'), 'junction');
      },
      (prot) => [{ kind: 'tree', path: join(prot, 'home', '.claude') }],
    );
    // A write beside the protected folder, through the same link, is not refused.
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD ELIVEGUARD OK');
    expect(fs.lstatSync(join(run.prot, 'home', 'dotfiles')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(join(run.prot, 'store', 'dotfiles', 'claude'))).toEqual(['keep.txt']);
  });

  it('guards each link a protected link leads through to its folder', () => {
    // prot/home/.claude -> prot/mid -> prot/dot/claude: prot/mid is part of the login's own
    // chain, so a command handed it is refused like one handed the login.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { spawnSync } from 'node:child_process';
       import { join } from 'node:path';
       const [prot] = process.argv.slice(1);
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       const viaMid = join(prot, 'mid', 'c.txt');
       console.log([
         attempt(() => fs.rmSync(join(prot, 'mid'), { recursive: true, force: true })),
         attempt(() => process.platform === 'win32'
           ? spawnSync('cmd.exe', ['/c', 'echo hi> ' + viaMid])
           : spawnSync('sh', ['-c', 'echo hi > ' + viaMid])),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'dot', 'claude'), { recursive: true });
        fs.writeFileSync(join(prot, 'dot', 'claude', 'keep.txt'), 'x');
        fs.symlinkSync(join(prot, 'dot', 'claude'), join(prot, 'mid'), 'junction');
        fs.mkdirSync(join(prot, 'home'));
        fs.symlinkSync(join(prot, 'mid'), join(prot, 'home', '.claude'), 'junction');
      },
      (prot) => [{ kind: 'tree', path: join(prot, 'home', '.claude') }],
    );
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD');
    expect(fs.readdirSync(join(run.prot, 'dot', 'claude'))).toEqual(['keep.txt']);
  });

  it('guards a linked protected folder whose home is itself reached through a link', () => {
    // prot/home is a link to prot/realhome, and the protected prot/home/.claude is a link to
    // prot/dot/claude: the folder is named through one link and is another.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { spawnSync } from 'node:child_process';
       import { join } from 'node:path';
       const [prot] = process.argv.slice(1);
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       const typed = join(prot, 'home', '.claude', 'c.txt');
       console.log([
         attempt(() => fs.rmSync(join(prot, 'realhome', '.claude'), { recursive: true, force: true })),
         attempt(() => fs.rmSync(join(prot, 'home', '.claude'), { recursive: true, force: true })),
         attempt(() => process.platform === 'win32'
           ? spawnSync('cmd.exe', ['/c', 'echo hi> ' + typed])
           : spawnSync('sh', ['-c', 'echo hi > ' + typed])),
       ].join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'dot', 'claude'), { recursive: true });
        fs.writeFileSync(join(prot, 'dot', 'claude', 'keep.txt'), 'x');
        fs.mkdirSync(join(prot, 'realhome'));
        fs.symlinkSync(join(prot, 'realhome'), join(prot, 'home'), 'junction');
        const login = join(prot, 'realhome', '.claude');
        fs.symlinkSync(join(prot, 'dot', 'claude'), login, 'junction');
      },
      (prot) => [{ kind: 'tree', path: join(prot, 'home', '.claude') }],
    );
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD ELIVEGUARD');
    expect(fs.lstatSync(join(run.prot, 'realhome', '.claude')).isSymbolicLink()).toBe(true);
    expect(fs.readdirSync(join(run.prot, 'dot', 'claude'))).toEqual(['keep.txt']);
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a recursive copy whose source cannot be listed in full',
    () => {
      // A folder the copy cannot list could hide an entry that lands anywhere; free/dst/j points
      // at prot, and the copy would write j/data.txt there before reaching the locked folder.
      const run = inGuardedChild(
        `import fs from 'node:fs';
         import { join } from 'node:path';
         const [prot, free] = process.argv.slice(1);
         fs.mkdirSync(join(free, 'src', 'j'), { recursive: true });
         fs.writeFileSync(join(free, 'src', 'j', 'data.txt'), 'fake');
         fs.mkdirSync(join(free, 'src', 'zz-locked'), { mode: 0o000 });
         fs.mkdirSync(join(free, 'dst'));
         fs.symlinkSync(prot, join(free, 'dst', 'j'));
         let out;
         try {
           fs.cpSync(join(free, 'src'), join(free, 'dst'), {
             recursive: true,
             filter: (s) => !s.endsWith('zz-locked'),
           });
           out = 'OK';
         } catch (err) { out = err.code; }
         fs.chmodSync(join(free, 'src', 'zz-locked'), 0o700);
         console.log(out);`,
        (prot) => fs.writeFileSync(join(prot, 'data.txt'), 'real'),
      );
      expect(run.out.trim()).toBe('ELIVEGUARD');
      expect(fs.readFileSync(join(run.prot, 'data.txt'), 'utf8')).toBe('real');
    },
  );

  it('refuses a protected folder named another way the OS accepts', () => {
    // prot/LongProtectedName is protected. Windows also answers to its short name, any case and
    // an NTFS stream suffix, and to the admin share and device forms of its path; macOS to any
    // case. Linux reads none of these as the same folder.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { execFileSync } from 'node:child_process';
       import os from 'node:os';
       import { join } from 'node:path';
       const [prot, free] = process.argv.slice(1);
       const long = join(prot, 'LongProtectedName');
       const attempt = (label, write) => {
         try { write(); return label + '=OK'; } catch (err) { return label + '=' + err.code; }
       };
       const out = [attempt('case', () => fs.rmSync(join(prot, 'LONGPROTECTEDNAME'), { recursive: true }))];
       if (process.platform === 'win32') {
         const listing = execFileSync('cmd', ['/c', 'dir', '/x', prot], { encoding: 'utf8' });
         const short = /\\s(\\S+~\\d+)\\s+LongProtectedName\\s*$/m.exec(listing)?.[1];
         if (short) out.push(attempt('short', () => fs.rmSync(join(prot, short), { recursive: true })));
         // Only NTFS reads the suffix; a ReFS Dev Drive has no such name.
         if (fs.existsSync(long + '::$INDEX_ALLOCATION')) {
           out.push(attempt('stream', () => fs.renameSync(long + '::$INDEX_ALLOCATION', join(free, 'moved'))));
         }
         const share = '\\\\\\\\localhost\\\\' + long[0] + '$' + long.slice(2);
         out.push(attempt('share', () => fs.rmSync(share, { recursive: true })));
         const lan = Object.values(os.networkInterfaces()).flat()
           .find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
         if (lan) {
           const viaLan = '\\\\\\\\' + lan + '\\\\' + long[0] + '$' + long.slice(2);
           out.push(attempt('lan', () => fs.rmSync(viaLan, { recursive: true })));
         }
         out.push(attempt('device', () => fs.rmSync('\\\\\\\\?\\\\' + long, { recursive: true })));
       }
       console.log(out.join(' '));`,
      (prot) => {
        fs.mkdirSync(join(prot, 'LongProtectedName'));
        fs.writeFileSync(join(prot, 'LongProtectedName', 'keep.txt'), 'x');
      },
      (prot) => [{ kind: 'tree', path: join(prot, 'LongProtectedName') }],
    );
    const results = run.out.trim().split(' ');
    if (process.platform === 'linux') {
      // No such folder: Linux does not read another case as this one.
      expect(results).toEqual(['case=ENOENT']);
    } else {
      expect(results.every((r) => r.endsWith('=ELIVEGUARD'))).toBe(true);
      expect(results[0]).toBe('case=ELIVEGUARD');
    }
    if (process.platform === 'win32') {
      expect(results.map((r) => r.split('=')[0])).toEqual(
        expect.arrayContaining(['case', 'share', 'device']),
      );
    }
    expect(fs.readdirSync(join(run.prot, 'LongProtectedName'))).toEqual(['keep.txt']);
  });

  it('refuses a recursive copy that would write through a link already in its destination', () => {
    // free/dst/j points at prot; copying free/src (which holds j/data.txt) over free/dst writes
    // prot/data.txt, in native code for the sync form.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { join } from 'node:path';
       const [prot, free] = process.argv.slice(1);
       fs.mkdirSync(join(free, 'src', 'j'), { recursive: true });
       fs.writeFileSync(join(free, 'src', 'j', 'data.txt'), 'fake');
       fs.mkdirSync(join(free, 'dst'));
       fs.symlinkSync(prot, join(free, 'dst', 'j'), 'junction');
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       const src = join(free, 'src');
       const dst = join(free, 'dst');
       const out = [
         attempt(() => fs.cpSync(src, dst, { recursive: true })),
         attempt(() => fs.cpSync(src, dst, { recursive: true, dereference: true })),
         await fs.promises.cp(src, dst, { recursive: true }).then(() => 'OK', (err) => err.code),
         attempt(() => fs.cpSync(src, join(free, 'copy'), { recursive: true })),
       ];
       console.log(out.join(' '));`,
      (prot) => fs.writeFileSync(join(prot, 'data.txt'), 'real'),
    );
    expect(run.out.trim()).toBe('ELIVEGUARD ELIVEGUARD ELIVEGUARD OK');
    expect(fs.readFileSync(join(run.prot, 'data.txt'), 'utf8')).toBe('real');
  });

  it('refuses a path through more links than the OS follows', () => {
    // free/a and free/b point at each other. On POSIX, a chain of as many dangling links as the
    // OS follows (40 on Linux, 32 on macOS) still resolves, and one of 41 is refused.
    const run = inGuardedChild(
      `import fs from 'node:fs';
       import { join } from 'node:path';
       // The real path, so no link above the folder (macOS's /var) counts toward the limit.
       const free = fs.realpathSync(process.argv[2]);
       fs.symlinkSync(join(free, 'b'), join(free, 'a'), 'junction');
       fs.symlinkSync(join(free, 'a'), join(free, 'b'), 'junction');
       const chain = (name, length) => {
         for (let i = 0; i < length - 1; i++) fs.symlinkSync(name + (i + 1), join(free, name + i));
         fs.symlinkSync(name + '-end.txt', join(free, name + (length - 1)));
         return join(free, name + 0);
       };
       const attempt = (write) => { try { write(); return 'OK'; } catch (err) { return err.code; } };
       const out = [attempt(() => fs.writeFileSync(join(free, 'a', 'probe.tmp'), 'x'))];
       if (process.platform !== 'win32') {
         const followed = process.platform === 'darwin' ? 32 : 40;
         out.push(attempt(() => fs.writeFileSync(chain('p', followed), 'x')));
         out.push(attempt(() => fs.writeFileSync(chain('q', 41), 'x')));
       }
       console.log(out.join(' '));`,
    );
    if (process.platform === 'win32') {
      expect(run.out.trim()).toBe('ELIVEGUARD');
    } else {
      expect(run.out.trim()).toBe('ELIVEGUARD OK ELIVEGUARD');
      expect(existsSync(join(run.free, 'p-end.txt'))).toBe(true);
      expect(existsSync(join(run.free, 'q-end.txt'))).toBe(false);
    }
  });

  it('keeps the guard in a node child spawned with an environment of its own', () => {
    // A child given only PATH would resolve the real home from the OS account.
    const run = inGuardedChild(
      `import { spawnSync } from 'node:child_process';
       import { join } from 'node:path';
       const [prot] = process.argv.slice(1);
       const write = "require('node:fs').writeFileSync(" + JSON.stringify(join(prot, 'g.txt')) + ", 'x')";
       const res = spawnSync(process.execPath, ['-e', write], {
         encoding: 'utf8',
         env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
       });
       console.log(res.stderr.includes('test sandbox refused') ? 'REFUSED' : 'RAN');`,
    );
    expect(run.out.trim()).toBe('REFUSED');
    expect(fs.readdirSync(run.prot)).toEqual([]);
  });
});

describe('live-state guard: machine-wide state no home folder redirects', () => {
  it("refuses a change to the Task Scheduler, cctl's autostart on Windows", () => {
    // The executables do not exist, so a guard that lets a call through fails with ENOENT instead
    // of touching any task.
    const run = powerShellRunner('cctl-guard-no-such-powershell.exe');
    expect(() => startDaemonTaskNow(run, 'cctl-guard-no-such-task')).toThrow(refused);
    expect(() =>
      execFileSync('cctl-guard-no-such-schtasks.exe', ['/Delete', '/TN', 'cctl-guard-none', '/F']),
    ).toThrow(refused);
  });

  it('refuses the macOS Keychain tool unless a test opts in', () => {
    expect(() =>
      execFileSync('security', ['find-generic-password', '-s', 'cctl-guard-no-such-item'], {
        stdio: 'ignore',
      }),
    ).toThrow(refused);
  });

  it("points the CLI's Keychain item at the sandbox, never the real login's", () => {
    const { service } = resolveClaudeCliKeychainTarget();
    expect(service).not.toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(service.startsWith(`${CLAUDE_CLI_KEYCHAIN_SERVICE}-`)).toBe(true);
  });

  it("refuses writes into Claude Code's machine-wide managed settings", () => {
    expect(() => fs.writeFileSync(probe(managedDropInDir()), 'x')).toThrow(refused);
  });
});
