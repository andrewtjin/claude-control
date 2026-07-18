// Tests for the daemon composition root's own logic. Only `dpapiIdentityStore` carries
// testable behavior — the rest of daemonRun.ts is assembly of subsystems tested in their own
// packages (and daemon.test.ts proves the composition shape against a live loopback relay).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsecurePassthroughProtector } from '@claude-control/switch-engine';
import { dpapiIdentityStore, waitForHookPort } from './daemonRun.js';

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

// waitForHookPort backs runDaemon's decoupling of hook install from the control-plane
// connect() — proving it here (rather than only via daemonRun's untested assembly) is what
// actually verifies a hung connect() no longer starves hook install/heartbeat.
describe('waitForHookPort', () => {
  it('resolves immediately when the port is already bound', async () => {
    const port = await waitForHookPort(() => 5173);
    expect(port).toBe(5173);
  });

  it('polls until the port becomes bound, without waiting on anything else', async () => {
    let calls = 0;
    const getPort = (): number | undefined => {
      calls += 1;
      return calls >= 3 ? 4321 : undefined;
    };
    const port = await waitForHookPort(getPort, { pollMs: 5, timeoutMs: 1_000 });
    expect(port).toBe(4321);
    expect(calls).toBeGreaterThanOrEqual(3);
  });

  it('gives up and resolves undefined once the deadline passes, instead of hanging forever', async () => {
    const port = await waitForHookPort(() => undefined, { timeoutMs: 30, pollMs: 10 });
    expect(port).toBeUndefined();
  });
});
