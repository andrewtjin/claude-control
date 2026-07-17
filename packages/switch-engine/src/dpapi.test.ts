import { describe, it, expect } from 'vitest';
import { DpapiProtector, InsecurePassthroughProtector } from './dpapi.js';

describe('InsecurePassthroughProtector', () => {
  it('round-trips arbitrary bytes', () => {
    const p = new InsecurePassthroughProtector();
    const secret = Buffer.from('refresh-token-🔐-value', 'utf8');
    const blob = p.protect(secret);
    expect(blob).not.toContain('refresh-token'); // base64, not plaintext
    expect(p.unprotect(blob).equals(secret)).toBe(true);
  });

  it('rejects a foreign blob', () => {
    const p = new InsecurePassthroughProtector();
    expect(() => p.unprotect('not-ours')).toThrow();
  });
});

// Real DPAPI is Windows-only and exercises PowerShell ProtectedData end-to-end. This is a
// genuine encryption round-trip on the developer's own machine, not a mock. Each test spawns
// a real powershell.exe (~2s alone, slower when the whole suite runs in parallel), so the
// default 5s timeout flakes under load — give these a generous budget.
describe.skipIf(process.platform !== 'win32')(
  'DpapiProtector (real DPAPI)',
  { timeout: 30_000 },
  () => {
    it('protects and unprotects through PowerShell ProtectedData', () => {
      const p = new DpapiProtector();
      const secret = Buffer.from(JSON.stringify({ accessToken: 'a', refreshToken: 'b' }), 'utf8');
      const blob = p.protect(secret);
      expect(typeof blob).toBe('string');
      expect(blob.length).toBeGreaterThan(0);
      expect(p.unprotect(blob).equals(secret)).toBe(true);
    });

    it('produces machine/user-bound ciphertext that differs from the input', () => {
      const p = new DpapiProtector();
      const secret = Buffer.from('the-quick-brown-fox');
      const blob = p.protect(secret);
      expect(Buffer.from(blob, 'base64').equals(secret)).toBe(false);
    });

    it('captures PowerShell stderr in the thrown error instead of leaking it to the console', () => {
      const p = new DpapiProtector();
      // Valid base64 that is NOT a DPAPI blob → ProtectedData::Unprotect throws inside
      // PowerShell, which writes the error to stderr. With stderr piped (the fix), that text
      // lands on the error's `stderr` field; execFileSync's default 'inherit' — the CLIXML
      // console-spam regression this guards against — would leave it null and print instead.
      try {
        p.unprotect(Buffer.from('definitely not a dpapi blob').toString('base64'));
        expect.unreachable('unprotect of a non-DPAPI blob must throw');
      } catch (err) {
        const cause = (err as { cause?: { stderr?: unknown } }).cause;
        expect(typeof cause?.stderr).toBe('string');
        expect((cause?.stderr as string).length).toBeGreaterThan(0);
      }
    });
  },
);
