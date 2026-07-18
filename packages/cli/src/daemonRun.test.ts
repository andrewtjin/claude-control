// Tests for the daemon composition root's own logic. `dpapiIdentityStore` and
// `makeAgentSdkClientFactory` carry testable behavior — the rest of daemonRun.ts is assembly
// of subsystems tested in their own packages (and daemon.test.ts proves the composition
// shape against a live loopback relay).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsecurePassthroughProtector, noopLogger } from '@claude-control/switch-engine';
import { dpapiIdentityStore, makeAgentSdkClientFactory } from './daemonRun.js';

describe('dpapiIdentityStore', () => {
  let dir: string;
  let path: string;
  const protector = new InsecurePassthroughProtector();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-identity-'));
    path = join(dir, 'daemon-identity.enc');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads undefined when no identity has ever been saved', async () => {
    const store = dpapiIdentityStore(path, protector);
    expect(await store.load()).toBeUndefined();
  });

  it('round-trips an identity through protect/unprotect', async () => {
    const store = dpapiIdentityStore(path, protector);
    const identity = { daemonId: 'daemon-1', daemonToken: 'tok-secret' };
    await store.save(identity);
    expect(await store.load()).toEqual(identity);
  });

  it('degrades a corrupt file to undefined (unpaired) instead of throwing', async () => {
    await writeFile(path, 'not-base64-not-json-garbage', 'utf8');
    const store = dpapiIdentityStore(path, protector);
    expect(await store.load()).toBeUndefined();
  });

  it('rejects a structurally wrong (but decryptable) payload as unpaired', async () => {
    // A valid encrypted blob whose JSON lacks the required fields must not be adopted.
    const blob = protector.protect(Buffer.from(JSON.stringify({ some: 'other-shape' }), 'utf8'));
    await writeFile(path, blob, 'utf8');
    const store = dpapiIdentityStore(path, protector);
    expect(await store.load()).toBeUndefined();
  });
});

describe('makeAgentSdkClientFactory', () => {
  // Constructing the real client is unit-safe: the live boundary sits on `query()` (that is what
  // spawns a Claude Code subprocess), not on client construction — so this proves the
  // composition-root wiring shape without ever touching the real SDK runtime.
  it('builds a fresh, fully-featured SDK client per call (one client per managed session)', () => {
    const factory = makeAgentSdkClientFactory(noopLogger);
    const first = factory();
    const second = factory();
    // Distinct instances: sessions must never share a client, or interrupt/resolvePermission
    // would cross-wire between concurrently running sessions.
    expect(first).not.toBe(second);
    expect(typeof first.query).toBe('function');
    expect(typeof first.interrupt).toBe('function');
    expect(typeof first.end).toBe('function');
    // Remote approve/deny depends on the client exposing the permission-resolution seam.
    expect(typeof first.resolvePermission).toBe('function');
  });
});
