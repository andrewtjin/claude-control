// A session alias must be text a real session could carry. Claude Code 2.1.283 stores an unpaired
// (lone) surrogate in a --name as the Unicode replacement character U+FFFD (measured: `ab\uD800cd` is
// recorded with the title `ab\uFFFDcd`), so an alias holding a lone surrogate can never equal any
// session's stored title. Binding it would reserve accounts to a scope nothing ever matches, and
// nothing would flag it. So the bind is refused (like an alias too long for a session name), and an
// alias that reached the vault another way is reported as never matching, so it can be released.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine, type BindFs } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { FileCredentialChannel } from './credentialStore.js';
import { sandboxPaths } from './paths.js';
import { aliasFitsSessionTitle, isWellFormedText } from './folderPath.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

async function mkEngine() {
  const root = await mkdtemp(join(tmpdir(), 'alias-lonesurrogate-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  const clock = () => NOW;
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
  const refresh = (cur: ClaudeOauth): Promise<ClaudeOauth> => Promise.resolve(cur);
  const engine = new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh,
    clock,
    refreshSkewMs: 5 * 60 * 1000,
    minSwitchIntervalMs: 60_000,
    lockOptions: { timeoutMs: 2000, pollMs: 10 },
    platform: 'win32',
    bindFs,
    isProcessAlive: () => false,
    bindEnforce: 'block',
  });
  return { engine, root };
}
const bundleFor = (a: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: a, refreshToken: 'r-' + a, expiresAt: NOW + 10 * HOUR },
  oauthAccount: { accountUuid: 'uuid-' + a, emailAddress: a + '@x.com' },
});

const LONE = 'ab\uD800cd'; // one unpaired high surrogate

describe('a lone-surrogate alias can never match a real session', () => {
  it('isWellFormedText rejects a lone surrogate but keeps valid pairs and plain text', () => {
    expect(isWellFormedText(LONE)).toBe(false);
    expect(isWellFormedText('ab\uDC00cd')).toBe(false); // a lone low surrogate too
    expect(isWellFormedText('plain')).toBe(true);
    expect(isWellFormedText('emoji \u{1F600}')).toBe(true); // a valid surrogate pair
  });

  it('aliasFitsSessionTitle reports it as never matchable', () => {
    // No session's recorded title can equal it: Claude Code substitutes U+FFFD (measured), so the
    // matchable form would be 'ab\uFFFDcd', a different key.
    expect(aliasFitsSessionTitle(LONE)).toBe(false);
    expect(LONE.toLowerCase().trim()).not.toBe('ab\uFFFDcd'.toLowerCase().trim());
    // A plain alias still fits.
    expect(aliasFitsSessionTitle('auth work')).toBe(true);
  });

  it('bindAlias refuses a lone-surrogate alias', async () => {
    const { engine, root } = await mkEngine();
    const a = await engine.addAccount('A', bundleFor('A'));
    const folder = join(root, 'repo');
    await mkdir(folder, { recursive: true });
    const canon = realpathSync.native(folder);
    await expect(engine.bindAlias(canon, LONE, [a.id])).rejects.toThrow(/surrogate/i);
    // Nothing was reserved: no group survives the refusal.
    expect(await engine.listGroups()).toEqual([]);
  });
});
