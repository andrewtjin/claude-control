// A bound folder that was MOVED and replaced by a link (a junction on Windows, a directory symlink
// elsewhere) to its new home — the usual way to move a repository to another drive without breaking
// its paths. The binding still names the old path, while every lookup that resolves links lands on
// the new home, where nothing is bound. Unbinding by the old path must still find and remove it:
// otherwise the binding (and its reserved accounts) can never be released by folder. Real
// filesystem, real engine, real `cctl session unbind` / `cctl unbind` bodies.

import { mkdir, mkdtemp, rename, rm, symlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { runSessionUnbind } from './sessionBinding.js';
import type { SessionAliasDeps } from './sessionAliases.js';

const NOW = Date.now();
const bundle = (t: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt: NOW + 36e5 * 8 },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' },
});

let root: string;
let paths: Paths;
let engine: SwitchEngine;
let work: StoredAccount;
let oldPath: string;

beforeEach(async () => {
  root = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-moved-')));
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  engine = new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (c: ClaudeOauth) => Promise.resolve(c),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 5 },
    isProcessAlive: () => false,
    bindEnforce: 'block',
  });
  const main = await engine.addAccount('main', bundle('main'));
  work = await engine.addAccount('work', bundle('work'));
  await engine.activate(main.id, { force: true });
  oldPath = join(root, 'repo');
  await mkdir(oldPath, { recursive: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

/** Move the bound folder to another place and leave a link at the old path. */
async function moveAndLink(): Promise<string> {
  const newHome = join(root, 'D', 'repo');
  await mkdir(join(root, 'D'), { recursive: true });
  await rename(oldPath, newHome);
  await symlink(newHome, oldPath, process.platform === 'win32' ? 'junction' : 'dir');
  expect(realpathSync.native(oldPath)).toBe(realpathSync.native(newHome));
  return newHome;
}

describe('unbinding a folder that was moved and replaced by a link', () => {
  it('cctl session unbind by the old path removes the alias binding', async () => {
    await engine.bindAlias(oldPath, 'auth', [work.id]);
    await moveAndLink();
    const written: string[] = [];
    const deps: SessionAliasDeps & { reconcileGuard: () => Promise<void> } = {
      paths,
      env: {},
      cwd: root,
      platform: process.platform,
      write: (t) => written.push(t),
      note: () => {},
      engine,
      reconcileGuard: () => Promise.resolve(),
    };

    await runSessionUnbind('auth', { cwd: oldPath }, deps);

    expect(written.join('')).toContain(`Unbound session "auth" in ${oldPath} and dissolved`);
    expect(await engine.listGroups()).toEqual([]);
  });

  it('the engine finds an alias or a folder binding by the old path', async () => {
    await engine.bindAlias(oldPath, 'auth', [work.id]);
    await moveAndLink();
    const alias = await engine.unbindAlias(oldPath, 'auth');
    expect({ folder: alias.folder, dissolved: alias.dissolved }).toEqual({
      folder: oldPath,
      dissolved: true,
    });

    // A V1 folder binding the same way (bound at the new home's old path before the move).
    await rm(oldPath, { recursive: true, force: true });
    await rename(join(root, 'D', 'repo'), oldPath);
    await engine.bindFolder(oldPath, [work.id]);
    await moveAndLink();
    expect((await engine.unbindFolder(oldPath)).dissolved).toBe(true);
    expect(await engine.listGroups()).toEqual([]);
  });

  it('a path bound under neither spelling is still refused', async () => {
    await engine.bindAlias(oldPath, 'auth', [work.id]);
    await expect(engine.unbindAlias(join(root, 'elsewhere'), 'auth')).rejects.toMatchObject({
      code: 'not_bound',
    });
    await expect(engine.unbindAlias(oldPath, 'other')).rejects.toMatchObject({
      code: 'not_bound',
    });
  });
});
