// Reading who is live must stay cheap while the live login disagrees with the registry. A view that
// re-reads every couple of seconds asks it over and over in that state, and on Windows every bundle
// decrypt is a PowerShell spawn: the answer has to come from the token fingerprints once they are
// known, not from a fresh decrypt per call.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore } from './credentialStore.js';
import { InsecurePassthroughProtector, type Protector } from './dpapi.js';
import { noopLogger } from './logger.js';
import { sandboxPaths } from './paths.js';
import { SwitchEngine } from './switchEngine.js';
import type { CredentialBundle } from './types.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A protector that counts its decrypts. */
class CountingProtector implements Protector {
  decrypts = 0;
  private readonly inner = new InsecurePassthroughProtector();
  protect(plaintext: Buffer): Promise<string> {
    return this.inner.protect(plaintext);
  }
  unprotect(blob: string): Promise<Buffer> {
    this.decrypts += 1;
    return this.inner.unprotect(blob);
  }
}

function login(name: string): CredentialBundle {
  return {
    claudeAiOauth: {
      accessToken: `at-${name}`,
      refreshToken: `rt-${name}`,
      expiresAt: Date.now() + 24 * 60 * 60 * 1000,
    },
    oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.com` },
  };
}

describe('getActiveId while the live identity disagrees with the registry', () => {
  it('decrypts no bundle on repeated asks once the fingerprints are known', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-active-'));
    dirs.push(root);
    const paths = sandboxPaths(root);
    await mkdir(paths.claudeDir, { recursive: true });
    const protector = new CountingProtector();
    const engine = new SwitchEngine({ paths, protector, logger: noopLogger });

    // "work" is captured live, so the registry names it active; "home" is stored beside it.
    const credStore = new CredentialStore(paths);
    const work = login('work');
    await credStore.writeLiveCredentials(work.claudeAiOauth);
    await credStore.writeOauthAccount(work.oauthAccount!);
    const workRow = await engine.captureCurrentLogin('work');
    await engine.addAccount('home', login('home'));

    // A `/login` inside Claude Code as an account cctl never stored rewrites the identity block
    // (the token in this test stays work's, so the registry answer is corroborated).
    await credStore.writeOauthAccount({ accountUuid: 'uuid-stranger', emailAddress: 's@x.com' });

    expect(await engine.getActiveId()).toBe(workRow.id);
    const afterFirst = protector.decrypts;
    for (let i = 0; i < 5; i += 1) expect(await engine.getActiveId()).toBe(workRow.id);
    expect(protector.decrypts).toBe(afterFirst);

    // A fresh engine over the same vault starts warm from the fingerprint index on disk.
    const fresh = new SwitchEngine({ paths, protector, logger: noopLogger });
    const beforeFresh = protector.decrypts;
    for (let i = 0; i < 3; i += 1) expect(await fresh.getActiveId()).toBe(workRow.id);
    expect(protector.decrypts).toBe(beforeFresh);
  });
});
