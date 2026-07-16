import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from './credentialStore.js';
import { sandboxPaths } from './paths.js';
import type { ClaudeOauth } from './types.js';

let dirs: string[] = [];
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), 'ce-cred-'));
  dirs.push(root);
  const paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'home'), { recursive: true });
  return { root, paths, store: new CredentialStore(paths) };
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const oauth: ClaudeOauth = { accessToken: 'acc', refreshToken: 'ref', expiresAt: 123 };

describe('CredentialStore live credentials', () => {
  it('returns undefined when nobody is logged in', async () => {
    const { store } = await sandbox();
    expect(await store.readLiveCredentials()).toBeUndefined();
  });

  it('writes and reads back the claudeAiOauth block', async () => {
    const { store } = await sandbox();
    await store.writeLiveCredentials(oauth);
    expect(await store.readLiveCredentials()).toEqual(oauth);
  });

  it('preserves other keys in .credentials.json when replacing the oauth block', async () => {
    const { paths, store } = await sandbox();
    await writeFile(
      paths.credentialsPath,
      JSON.stringify({ claudeAiOauth: oauth, somethingElse: { keep: true } }),
    );
    await store.writeLiveCredentials({ ...oauth, accessToken: 'acc2' });
    const file = JSON.parse(await readFile(paths.credentialsPath, 'utf8')) as {
      somethingElse: unknown;
      claudeAiOauth: { accessToken: string };
    };
    expect(file.somethingElse).toEqual({ keep: true });
    expect(file.claudeAiOauth.accessToken).toBe('acc2');
  });

  it('ignores a structurally invalid oauth block', async () => {
    const { paths, store } = await sandbox();
    await writeFile(paths.credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: 5 } }));
    expect(await store.readLiveCredentials()).toBeUndefined();
  });
});

describe('CredentialStore oauthAccount (~/.claude.json)', () => {
  it('surgically replaces oauthAccount while preserving unrelated config', async () => {
    const { paths, store } = await sandbox();
    // Simulate a real, busy ~/.claude.json with lots of unrelated keys.
    await writeFile(
      paths.claudeJsonPath,
      JSON.stringify({
        numStartups: 42,
        projects: { 'C:/x': { history: [1, 2, 3] } },
        oauthAccount: { accountUuid: 'old', emailAddress: 'a@a.com' },
        cachedUsageUtilization: { limits: [] },
      }),
    );
    await store.writeOauthAccount({ accountUuid: 'new', emailAddress: 'b@b.com' });
    const file = JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')) as {
      oauthAccount: unknown;
      numStartups: number;
      projects: Record<string, { history: number[] }>;
      cachedUsageUtilization: unknown;
    };
    // The one block we own is replaced…
    expect(file.oauthAccount).toEqual({ accountUuid: 'new', emailAddress: 'b@b.com' });
    // …and everything else survives untouched.
    expect(file.numStartups).toBe(42);
    expect(file.projects['C:/x']!.history).toEqual([1, 2, 3]);
    expect(file.cachedUsageUtilization).toEqual({ limits: [] });
  });

  it('creates ~/.claude.json with just the block if it did not exist', async () => {
    const { paths, store } = await sandbox();
    await store.writeOauthAccount({ accountUuid: 'x' });
    const file = JSON.parse(await readFile(paths.claudeJsonPath, 'utf8')) as {
      oauthAccount: unknown;
    };
    expect(file.oauthAccount).toEqual({ accountUuid: 'x' });
  });
});
