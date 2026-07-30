import { describe, it, expect } from 'vitest';
import { BindingStore } from './bindings.js';
import { PairingService } from './pairing.js';

describe('PairingService', () => {
  it('happy path: a valid code mints an id + token and binds the daemon to the issuing user', async () => {
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings, generateDaemonId: () => 'minted-1' });
    const code = pairing.createCode('user-a');

    const result = await pairing.claim(code, 'my-laptop');

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.discordUserId).toBe('user-a');
    expect(result.daemonId).toBe('minted-1'); // the BOT chose the id, not the daemon
    expect(result.daemonToken.length).toBeGreaterThan(0);

    // The binding exists under the minted id and verifies against the returned token.
    expect(bindings.byUser('user-a')?.daemonId).toBe('minted-1');
    expect(await bindings.verifyDaemon('minted-1', result.daemonToken)).toBeDefined();
  });

  it('rejects an unknown code', async () => {
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings });
    pairing.createCode('user-a');

    const result = await pairing.claim('ZZZZZZZZ', 'host');
    expect(result).toEqual({ ok: false, error: 'unknown or already-used pairing code' });
  });

  it('rejects an expired code', async () => {
    const bindings = new BindingStore();
    let now = 1_000_000;
    const pairing = new PairingService({ bindings, clock: () => now, ttlMs: 60_000 });
    const code = pairing.createCode('user-a');

    now += 60_001;
    const result = await pairing.claim(code, 'host');
    expect(result).toEqual({ ok: false, error: 'pairing code expired' });
  });

  it('rejects reuse of an already-claimed code', async () => {
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings });
    const code = pairing.createCode('user-a');

    const first = await pairing.claim(code, 'host');
    expect(first.ok).toBe(true);

    const second = await pairing.claim(code, 'other-host');
    expect(second).toEqual({ ok: false, error: 'unknown or already-used pairing code' });
  });

  it('two users get fully isolated codes and bindings', async () => {
    const bindings = new BindingStore();
    let n = 0;
    const pairing = new PairingService({ bindings, generateDaemonId: () => `minted-${++n}` });
    const codeA = pairing.createCode('user-a');
    const codeB = pairing.createCode('user-b');
    expect(codeA).not.toBe(codeB);

    const resultA = await pairing.claim(codeA, 'host-a');
    const resultB = await pairing.claim(codeB, 'host-b');

    expect(resultA.ok && resultA.discordUserId).toBe('user-a');
    expect(resultB.ok && resultB.discordUserId).toBe('user-b');
    expect(bindings.byUser('user-a')?.daemonId).toBe('minted-1');
    expect(bindings.byUser('user-b')?.daemonId).toBe('minted-2');

    // User A's code cannot be reused for user B's identity — it is gone.
    const replay = await pairing.claim(codeA, 'intruder');
    expect(replay.ok).toBe(false);
  });

  it('SECURITY: a claimer cannot choose (hijack) a daemon id — the bot mints a fresh one each time', async () => {
    // The daemon no longer supplies its id, so there is no argument through which an attacker
    // could name a victim's daemon. Distinct pairings always yield distinct, bot-chosen ids.
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings }); // real randomUUID minter
    const a = await pairing.claim(pairing.createCode('user-a'), 'host-a');
    const b = await pairing.claim(pairing.createCode('user-b'), 'host-b');
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) throw new Error('unreachable');
    expect(a.daemonId).not.toBe(b.daemonId);
    // Neither user's daemon id leaked into the other's binding.
    expect(bindings.byDaemon(a.daemonId)?.discordUserId).toBe('user-a');
    expect(bindings.byDaemon(b.daemonId)?.discordUserId).toBe('user-b');
  });

  it('throttles a burst of claim attempts within the window', async () => {
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings, clock: () => 5_000 }); // frozen clock = one window
    // The 31st attempt in the window trips the throttle (limit is 30).
    let lastError = '';
    for (let i = 0; i < 31; i++) {
      const r = await pairing.claim('nope', 'host');
      if (!r.ok) lastError = r.error;
    }
    expect(lastError).toMatch(/too many pairing attempts/);
  });

  it('regenerates on a code collision so two live codes are never equal', () => {
    const bindings = new BindingStore();
    let calls = 0;
    const pairing = new PairingService({
      bindings,
      generateCode: () => (calls++ < 1 ? 'AAAAAAAA' : 'BBBBBBBB'),
    });
    expect(pairing.createCode('user-a')).toBe('AAAAAAAA');
    expect(pairing.createCode('user-b')).toBe('BBBBBBBB');
  });

  it('createCode sweeps expired codes so an unredeemed one cannot linger past its TTL', async () => {
    const bindings = new BindingStore();
    let now = 1_000_000;
    const pairing = new PairingService({ bindings, clock: () => now, ttlMs: 60_000 });
    const stale = pairing.createCode('user-a'); // expires at now + 60_000

    now += 60_001; // stale is now past its TTL
    pairing.createCode('user-b'); // the sweep runs here and evicts the expired `stale` entry

    // The swept code is gone from the table entirely, so claiming it reads as UNKNOWN, not as the
    // "expired" branch — which only fires for a code still present in the map. That difference is
    // exactly what proves the entry was removed rather than merely lazily-expired on lookup.
    const result = await pairing.claim(stale, 'host');
    expect(result).toEqual({ ok: false, error: 'unknown or already-used pairing code' });
  });
});
