// `defaultPaths()` sees a group profile's CLAUDE_CONFIG_DIR through to the main config dir, so a cctl
// command run inside a bound session acts on the main dir. Capturing "the current login" is the one
// command that must NOT follow it there: after a `/login` inside the bound session the new login is
// in the profile, and capturing the main dir's login instead stores (or refuses as a duplicate) an
// account the operator never asked for. The capture refuses by the session's own config dir.
// Real files, a profile materialized by a real bind, the production defaultPaths().

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { FileCredentialChannel } from './credentialStore.js';
import { defaultPaths, groupProfileDir, type Paths } from './paths.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

function engineFor(paths: Paths, root: string): SwitchEngine {
  const bindFs: BindFs = {
    realpath: (p) => realpathSync.native(p),
    isDirectory: (p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    cwd: () => root,
    homedir: () => join(root, 'home'),
  };
  return new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (c: ClaudeOauth) => Promise.resolve(c),
    clock: () => NOW,
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 5 },
    platform: process.platform,
    bindFs,
    isProcessAlive: () => false,
    bindEnforce: 'block',
  });
}

const bundle = (t: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt: NOW + 8 * HOUR },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' },
});

describe('capturing the current login from inside a bound session', () => {
  it('refuses as capture_in_profile instead of capturing the main dir login', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-seethru-'));
    dirs.push(root);
    await mkdir(join(root, 'home'), { recursive: true });
    await mkdir(join(root, 'repo'), { recursive: true });
    const main = join(root, 'claude');
    await mkdir(join(main, 'projects'), { recursive: true });
    const mainEnv = { CLAUDE_CONFIG_DIR: main, LOCALAPPDATA: root, XDG_DATA_HOME: root };
    const mainPaths = defaultPaths(mainEnv, process.platform, {
      readlink: (p) => readlinkSync(p),
      readFile: (p) => readFileSync(p, 'utf8'),
      home: join(root, 'home'),
    });
    const e = engineFor(mainPaths, root);
    const P = await e.addAccount('main', bundle('P'));
    const W = await e.addAccount('work', bundle('W'));
    await e.activate(P.id, { force: true });
    const g = (await e.bindFolder(realpathSync.native(join(root, 'repo')), [W.id])).group;
    const profile = groupProfileDir(mainPaths.vaultDir, g.id);

    // Inside the bound session the operator runs `/login` as a NEW account N; Claude Code writes it
    // into the session's config dir, the profile. Then they ask cctl to store it.
    await writeFile(
      join(profile, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: bundle('N').claudeAiOauth }),
    );
    await writeFile(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: bundle('N').oauthAccount }),
    );
    const sessionPaths = defaultPaths(
      { ...mainEnv, CLAUDE_CONFIG_DIR: profile },
      process.platform,
      {
        readlink: (p) => readlinkSync(p),
        readFile: (p) => readFileSync(p, 'utf8'),
        home: join(root, 'home'),
      },
    );
    // The see-through still points every other command at the main dir.
    expect(realpathSync.native(sessionPaths.claudeDir)).toBe(realpathSync.native(main));

    await expect(engineFor(sessionPaths, root).captureCurrentLogin('fresh')).rejects.toMatchObject({
      code: 'capture_in_profile',
    });
    // Nothing was stored.
    expect((await e.listAllAccounts()).map((a) => a.label).sort()).toEqual(['main', 'work']);
  });

  it('still captures normally from the main config dir', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-seethru-'));
    dirs.push(root);
    await mkdir(join(root, 'home'), { recursive: true });
    const main = join(root, 'claude');
    await mkdir(main, { recursive: true });
    const paths = defaultPaths(
      { CLAUDE_CONFIG_DIR: main, LOCALAPPDATA: root, XDG_DATA_HOME: root },
      process.platform,
      {
        readlink: (p) => readlinkSync(p),
        readFile: (p) => readFileSync(p, 'utf8'),
        home: join(root, 'home'),
      },
    );
    await writeFile(
      paths.credentialsPath,
      JSON.stringify({ claudeAiOauth: bundle('M').claudeAiOauth }),
    );
    await writeFile(
      paths.claudeJsonPath,
      JSON.stringify({ oauthAccount: bundle('M').oauthAccount }),
    );

    const account = await engineFor(paths, root).captureCurrentLogin('m');

    expect(account.accountUuid).toBe('uuid-M');
  });
});
