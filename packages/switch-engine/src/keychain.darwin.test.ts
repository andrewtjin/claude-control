import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { KeychainProtector } from './keychain.js';

// The repo's only test that talks to a REAL `security(1)`. It runs ONLY on darwin (skipIf) — where
// a genuine login Keychain and /usr/bin/security exist; on Windows and ubuntu the whole block is
// skipped (0 tests), so it can never fail a non-mac leg. It covers the automatable half of macOS
// verification: OUR OWN vault-key item (service=claude-control) through the real binary — NEVER
// the CLI's cross-app `Claude Code-credentials` item — so it needs no logged-in Claude account,
// and because `security` created the item itself the read matches the item's own ACL principal
// and raises no GUI prompt. The cross-app read, which is the part that may prompt, cannot be
// exercised from a test and stays maintainer-run on hardware (docs/VERIFICATION.md gate 13).
//
// NON-DESTRUCTIVE: it uses the idempotent get-or-create key path, reusing an existing vault-key or
// creating one exactly as cctl's first run would. It never deletes a key.
//
// It runs only in CI, where the job makes a throwaway default keychain first. On a developer's Mac
// the default keychain holds the real vault key, which no test may read, so the test sandbox's
// guard refuses the Keychain tool unless this test opts in, and it opts in only under CI.
describe.skipIf(process.platform !== 'darwin' || process.env.CI !== 'true')(
  'KeychainProtector — real security(1) round-trip (darwin)',
  () => {
    beforeAll(() => {
      process.env.CCTL_TEST_REAL_KEYCHAIN = '1';
    });
    afterAll(() => {
      delete process.env.CCTL_TEST_REAL_KEYCHAIN;
    });

    it('round-trips AES-GCM through a real login-Keychain-held key', async () => {
      const protector = new KeychainProtector(); // real KeychainKeySource + real defaultExecRunner
      const secret = Buffer.from('cctl real-keychain round-trip check');

      const blob = await protector.protect(secret);
      // The blob's shape is node:crypto (platform-independent); what's mac-unique here is that
      // getOrCreateKey just WROTE the key via real `security -i` and READ it back. (The vault-key
      // write uses raw interpolation, not quoteSecurityArg, so the arg-quoting assumption is NOT
      // exercised here — only KeychainCredentialChannel uses it, and that path needs hardware.)
      expect(blob.startsWith('aesgcm:')).toBe(true);
      expect((await protector.unprotect(blob)).equals(secret)).toBe(true);

      // A SECOND protector re-reads the SAME persisted key from the Keychain and decrypts the first
      // one's blob — proving the key actually round-tripped through real `security`, not just memory.
      expect((await new KeychainProtector().unprotect(blob)).equals(secret)).toBe(true);
    });
  },
);
