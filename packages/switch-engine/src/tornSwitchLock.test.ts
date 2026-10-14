// The failed identity write of tornSwitch.test.ts, produced for real rather than injected: another
// process holds the live `.claude.json` open with read sharing only (what an indexer, a backup agent
// or an antivirus scanner does). Windows then refuses to replace the file, the rename retry ladder
// runs out, and the switch fails after its credentials landed. Nothing is mocked. Windows only — POSIX
// renames are not blocked by an open handle, so there is nothing to reproduce there.

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwitchEngine } from './switchEngine.js';
import { InsecurePassthroughProtector } from './dpapi.js';
import { CredentialStore, FileCredentialChannel } from './credentialStore.js';
import { IntentStore } from './intent.js';
import { Vault } from './vault.js';
import { sandboxPaths } from './paths.js';
import type { ClaudeOauth, CredentialBundle } from './types.js';

const NOW = 100_000_000;
const HOUR = 3_600_000;
let dirs: string[] = [];
let holder: ChildProcess | undefined;

afterEach(async () => {
  holder?.kill();
  holder = undefined;
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })),
  );
  dirs = [];
});

const bundle = (t: string, expiresAt: number): CredentialBundle => ({
  claudeAiOauth: { accessToken: 'at-' + t, refreshToken: 'rt-' + t, expiresAt },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@x.com' },
});

/** Hold `path` open for reading with FileShare.Read, resolving once the handle is open. */
async function holdOpenForReading(path: string): Promise<ChildProcess> {
  const child = spawn('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `$f=[System.IO.File]::Open('${path.replace(/'/g, "''")}','Open','Read','Read'); ` +
      'Write-Output held; Start-Sleep -Seconds 60',
  ]);
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve());
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`holder exited early (${String(code)})`)));
  });
  return child;
}

describe.skipIf(process.platform !== 'win32')('an identity write refused by a sharing lock', () => {
  it('fails the switch with the previous login whole, and the next switch keeps every bundle its own', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-tornlock-'));
    dirs.push(root);
    const paths = sandboxPaths(root);
    await mkdir(paths.claudeDir, { recursive: true });
    await mkdir(join(root, 'home'), { recursive: true });
    const protector = new InsecurePassthroughProtector();
    const engine = new SwitchEngine({
      paths,
      protector,
      liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
      refresh: (c: ClaudeOauth) => Promise.resolve(c),
      clock: () => NOW,
      minSwitchIntervalMs: 0,
      lockOptions: { timeoutMs: 5000, pollMs: 5 },
      platform: process.platform,
      isProcessAlive: () => false,
    });
    const P = await engine.addAccount('P', bundle('P', NOW + 2 * HOUR));
    const T = await engine.addAccount('T', bundle('T', NOW + 8 * HOUR));
    const R = await engine.addAccount('R', bundle('R', NOW + 8 * HOUR));
    await engine.activate(P.id, { force: true });

    holder = await holdOpenForReading(paths.claudeJsonPath);
    const hop = await engine.activate(T.id, { force: true, origin: 'auto' }).then(
      () => undefined,
      (err: unknown) => err,
    );
    const store = new CredentialStore(paths);
    const creds = (await store.readLiveCredentials())?.refreshToken;
    const ident = (await store.readOauthAccount())?.accountUuid;
    const closed = new Promise((resolve) => holder!.once('exit', resolve));
    holder.kill();
    await closed;
    holder = undefined;

    // The real rename error underneath, said the way a person reads it: which file, why, what now.
    expect(hop).toMatchObject({
      code: 'switch_failed',
      outcome: 'restored',
      cause: { code: 'EPERM', dest: paths.claudeJsonPath },
    });
    expect((hop as Error).message).toMatch(
      /^could not write .*\.claude\.json \(EPERM\): another program probably has it open .* nothing changed\. Close that program/,
    );
    expect({ creds, ident }).toEqual({ creds: 'rt-P', ident: 'uuid-P' });
    expect(await new IntentStore(paths.vaultDir).read()).toBeUndefined();

    // The handle closes; the daemon's next switch goes through.
    await engine.activate(R.id, { force: true, origin: 'auto' });
    const vault = new Vault(paths.vaultDir, protector, () => NOW, undefined, process.platform);
    expect((await vault.readBundle(P.id)).claudeAiOauth.refreshToken).toBe('rt-P');
    expect((await vault.readBundle(T.id)).claudeAiOauth.refreshToken).toBe('rt-T');
  }, 60_000);
});
