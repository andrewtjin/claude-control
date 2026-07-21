import { describe, it, expect } from 'vitest';
import { KeychainProtector } from './keychain.js';

// The repo's FIRST real-`security(1)` test. It runs ONLY on darwin (skipIf) — where a genuine login
// Keychain and /usr/bin/security exist; on Windows and ubuntu the whole block is skipped (0 tests),
// so it can never fail a non-mac CI leg. It is the automatable half of the macOS wet gate: it
// exercises OUR OWN vault-key item (service=claude-control) through the real binary — NEVER the
// CLI's cross-app `Claude Code-credentials` item — so it needs no logged-in Claude account and,
// per the corrected A4 model (security created our item, so the ACL principal matches on read),
// raises no GUI prompt. The cross-app A4 probe stays owner-run on hardware (docs/VERIFICATION.md §12
// and claude-control-orchestrator/tasks/mac-wet-gate-runbook.md).
//
// NON-DESTRUCTIVE: it uses the idempotent get-or-create key path, reusing an existing vault-key or
// creating one exactly as cctl's first run would. It never deletes a key, so running it on a
// developer's Mac cannot orphan a real vault.
describe.skipIf(process.platform !== 'darwin')(
  'KeychainProtector — real security(1) round-trip (darwin)',
  () => {
    it('round-trips AES-GCM through a real login-Keychain-held key', () => {
      const protector = new KeychainProtector(); // real KeychainKeySource + real defaultExecRunner
      const secret = Buffer.from('cctl real-keychain round-trip check');

      const blob = protector.protect(secret);
      // The blob's shape is node:crypto (platform-independent); what's mac-unique here is that
      // getOrCreateKey just WROTE the key via real `security -i` and READ it back. (The vault-key
      // write uses raw interpolation, not quoteSecurityArg — the arg-quoting assumption is exercised
      // only by KeychainCredentialChannel, which the owner-run wet gate covers, not this test.)
      expect(blob.startsWith('aesgcm:')).toBe(true);
      expect(protector.unprotect(blob).equals(secret)).toBe(true);

      // A SECOND protector re-reads the SAME persisted key from the Keychain and decrypts the first
      // one's blob — proving the key actually round-tripped through real `security`, not just memory.
      expect(new KeychainProtector().unprotect(blob).equals(secret)).toBe(true);
    });
  },
);
