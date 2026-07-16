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
// genuine encryption round-trip on the developer's own machine, not a mock.
describe.skipIf(process.platform !== 'win32')('DpapiProtector (real DPAPI)', () => {
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
});
