import { describe, it, expect } from 'vitest';
import { KeychainProtector } from './keychain.js';

// The repo's only test that talks to a REAL `security(1)`. It runs ONLY on darwin (skipIf) — where
// a genuine login Keychain and /usr/bin/security exist; on Windows and ubuntu the whole block is
// skipped (0 tests), so it can never fail a non-mac leg. It covers the automatable half of macOS
// verification: OUR OWN vault-key item (service=claude-control) through the real binary — NEVER
// the CLI's cross-app `Claude Code-credentials` item — so it needs no logged-in Claude account,
// and because `security` created the item itself the read matches the item's own ACL principal
// and raises no GUI prompt. The cross-app read, which is the part that may prompt, cannot be
// exercised from a test and stays owner-run on hardware (docs/VERIFICATION.md gate 13).
//
// NON-DESTRUCTIVE: it uses the idempotent get-or-create key path, reusing an existing vault-key or
// creating one exactly as cctl's first run would. It never deletes a key, so running it on a
// developer's Mac cannot orphan a real vault.
describe.skipIf(process.platform !== 'darwin')(
  'KeychainProtector — real security(1) round-trip (darwin)',
  () => {
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
