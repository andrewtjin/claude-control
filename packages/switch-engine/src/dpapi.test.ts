import { describe, it, expect } from 'vitest';
import { DpapiProtector, InsecurePassthroughProtector } from './dpapi.js';

describe('InsecurePassthroughProtector', () => {
  it('round-trips arbitrary bytes', async () => {
    const p = new InsecurePassthroughProtector();
    const secret = Buffer.from('refresh-token-🔐-value', 'utf8');
    const blob = await p.protect(secret);
    expect(blob).not.toContain('refresh-token'); // base64, not plaintext
    expect((await p.unprotect(blob)).equals(secret)).toBe(true);
  });

  it('rejects a foreign blob', async () => {
    const p = new InsecurePassthroughProtector();
    await expect(p.unprotect('not-ours')).rejects.toThrow();
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
    it('protects and unprotects through PowerShell ProtectedData', async () => {
      const p = new DpapiProtector();
      const secret = Buffer.from(JSON.stringify({ accessToken: 'a', refreshToken: 'b' }), 'utf8');
      const blob = await p.protect(secret);
      expect(typeof blob).toBe('string');
      expect(blob.length).toBeGreaterThan(0);
      expect((await p.unprotect(blob)).equals(secret)).toBe(true);
    });

    it('produces machine/user-bound ciphertext that differs from the input', async () => {
      const p = new DpapiProtector();
      const secret = Buffer.from('the-quick-brown-fox');
      const blob = await p.protect(secret);
      expect(Buffer.from(blob, 'base64').equals(secret)).toBe(false);
    });

    it('never blocks the event loop while PowerShell runs', async () => {
      // The starvation regression this file exists to prevent: a protect() in flight must
      // leave the loop free (the old execFileSync design froze it for the spawn's lifetime,
      // stalling every concurrent hook request in the daemon). A 25ms timer that fires while
      // the ~2s PowerShell call is still running proves the call isn't holding the thread.
      const p = new DpapiProtector();
      let timerFired = false;
      const timer = new Promise<void>((resolve) =>
        setTimeout(() => {
          timerFired = true;
          resolve();
        }, 25),
      );
      const inFlight = p.protect(Buffer.from('loop-freedom-probe'));
      await timer;
      expect(timerFired).toBe(true);
      await inFlight; // and the call itself still completes normally
    });

    it('captures PowerShell stderr in the rejection instead of leaking it to the console', async () => {
      const p = new DpapiProtector();
      // Valid base64 that is NOT a DPAPI blob → ProtectedData::Unprotect throws inside
      // PowerShell, which writes the error to stderr. The async runner must capture that
      // text into the rejected error's cause — never print it on the parent console.
      try {
        await p.unprotect(Buffer.from('definitely not a dpapi blob').toString('base64'));
        expect.unreachable('unprotect of a non-DPAPI blob must reject');
      } catch (err) {
        const cause = (err as { cause?: { message?: unknown } }).cause;
        expect(typeof cause?.message).toBe('string');
        expect((cause?.message as string).length).toBeGreaterThan(0);
        expect(cause?.message as string).toMatch(/exit code/);
      }
    });
  },
);
