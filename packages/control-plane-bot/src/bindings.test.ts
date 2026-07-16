import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BindingStore } from './bindings.js';
import { hashToken, mintToken } from './tokens.js';

describe('BindingStore', () => {
  it('binds and returns the binding from both directions', async () => {
    const store = new BindingStore();
    const hash = await hashToken(mintToken());
    const binding = await store.bind('user-a', 'daemon-1', hash, 'laptop', 1000);

    expect(store.byUser('user-a')).toEqual(binding);
    expect(store.byDaemon('daemon-1')).toEqual(binding);
  });

  it('never returns user A binding for user B (cross-user isolation)', async () => {
    const store = new BindingStore();
    const hashA = await hashToken(mintToken());
    const hashB = await hashToken(mintToken());
    await store.bind('user-a', 'daemon-1', hashA, 'laptop-a', 1000);
    await store.bind('user-b', 'daemon-2', hashB, 'laptop-b', 1000);

    expect(store.byUser('user-a')?.daemonId).toBe('daemon-1');
    expect(store.byUser('user-b')?.daemonId).toBe('daemon-2');
    // The critical assertion: looking up user B never yields user A's daemon, and vice versa.
    expect(store.byUser('user-a')?.discordUserId).not.toBe('user-b');
    expect(store.byDaemon('daemon-1')?.discordUserId).toBe('user-a');
    expect(store.byDaemon('daemon-2')?.discordUserId).toBe('user-b');
  });

  it('unknown user or daemon id resolves to undefined, not a wrong binding', async () => {
    const store = new BindingStore();
    await store.bind('user-a', 'daemon-1', await hashToken(mintToken()), 'laptop', 1000);
    expect(store.byUser('nobody')).toBeUndefined();
    expect(store.byDaemon('no-such-daemon')).toBeUndefined();
  });

  it('re-binding a user to a new daemon evicts the old daemon-side mapping', async () => {
    const store = new BindingStore();
    await store.bind('user-a', 'daemon-1', await hashToken(mintToken()), 'old-host', 1000);
    await store.bind('user-a', 'daemon-2', await hashToken(mintToken()), 'new-host', 2000);

    expect(store.byUser('user-a')?.daemonId).toBe('daemon-2');
    // The old daemon id must no longer resolve to anything — it was superseded, not aliased.
    expect(store.byDaemon('daemon-1')).toBeUndefined();
    expect(store.byDaemon('daemon-2')?.discordUserId).toBe('user-a');
  });

  it('SECURITY: refuses to bind a daemon id already owned by a different user (no hijack/DoS)', async () => {
    const store = new BindingStore();
    await store.bind('user-a', 'daemon-1', await hashToken(mintToken()), 'host', 1000);

    // A second user must not be able to seize daemon-1 — doing so would evict user-a and
    // could route user-a's daemon traffic to user-b. The primitive fails closed.
    await expect(
      store.bind('user-b', 'daemon-1', await hashToken(mintToken()), 'host', 2000),
    ).rejects.toThrow(/already bound to another account/);

    // user-a's binding is untouched.
    expect(store.byDaemon('daemon-1')?.discordUserId).toBe('user-a');
    expect(store.byUser('user-a')?.daemonId).toBe('daemon-1');
    expect(store.byUser('user-b')).toBeUndefined();
  });

  it('allows the same user to re-pair (a new daemon id for that user evicts their old one)', async () => {
    const store = new BindingStore();
    await store.bind('user-a', 'daemon-1', await hashToken(mintToken()), 'host', 1000);
    await store.bind('user-a', 'daemon-2', await hashToken(mintToken()), 'host', 2000);

    // The user's old daemon mapping is gone; only the new one remains.
    expect(store.byUser('user-a')?.daemonId).toBe('daemon-2');
    expect(store.byDaemon('daemon-1')).toBeUndefined();
    expect(store.byDaemon('daemon-2')?.discordUserId).toBe('user-a');
  });

  describe('verifyDaemon', () => {
    it('resolves the binding when the token matches', async () => {
      const token = mintToken();
      const store = new BindingStore();
      await store.bind('user-a', 'daemon-1', await hashToken(token), 'host', 1000);
      const result = await store.verifyDaemon('daemon-1', token);
      expect(result?.discordUserId).toBe('user-a');
    });

    it('rejects a wrong token for a known daemon', async () => {
      const store = new BindingStore();
      await store.bind('user-a', 'daemon-1', await hashToken(mintToken()), 'host', 1000);
      expect(await store.verifyDaemon('daemon-1', mintToken())).toBeUndefined();
    });

    it('rejects an unknown daemon id entirely (no throw, no crash)', async () => {
      const store = new BindingStore();
      expect(await store.verifyDaemon('ghost-daemon', mintToken())).toBeUndefined();
    });
  });

  describe('persistence', () => {
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'cpb-bindings-'));
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('round-trips bindings across a fresh store instance', async () => {
      const path = join(dir, 'bindings.json');
      const token = mintToken();
      const writer = new BindingStore(path);
      await writer.bind('user-a', 'daemon-1', await hashToken(token), 'host', 1000);

      const reader = new BindingStore(path);
      await reader.load();
      expect(reader.byUser('user-a')?.daemonId).toBe('daemon-1');
      expect(await reader.verifyDaemon('daemon-1', token)).toBeDefined();
    });

    it('load() is a no-op when the file does not exist yet', async () => {
      const store = new BindingStore(join(dir, 'missing.json'));
      await expect(store.load()).resolves.toBeUndefined();
      expect(store.byUser('anyone')).toBeUndefined();
    });
  });
});
