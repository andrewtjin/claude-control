// Proves the test sandbox holds: every test file runs with a throwaway home, and a write aimed at
// the real Claude login or cctl state is refused in this process and in node children.
//
// Every refusal is probed with a new, harmless file name inside a protected folder, never with the
// real credential files, so a broken guard leaves at most a stray probe file (removed below)
// rather than a damaged login.

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { existsSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
      // Remove the link itself; never a recursive delete, which must not walk into the target.
      fs.rmdirSync(link);
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
