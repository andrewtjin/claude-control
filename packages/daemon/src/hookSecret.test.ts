import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsecurePassthroughProtector } from '@claude-control/switch-engine';
import { loadOrCreateHookSecret } from './hookSecret.js';

describe('loadOrCreateHookSecret', () => {
  let dir: string;
  let path: string;
  const protector = new InsecurePassthroughProtector();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-hook-secret-'));
    path = join(dir, 'hook-secret.enc');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mints a 32-byte hex secret the first time', async () => {
    const secret = await loadOrCreateHookSecret(path, protector);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns the SAME secret on a subsequent load (stable across restarts)', async () => {
    const first = await loadOrCreateHookSecret(path, protector);
    const second = await loadOrCreateHookSecret(path, protector);
    expect(second).toBe(first);
  });

  it('creates the parent directory when it does not exist yet', async () => {
    const nested = join(dir, 'nested', 'hook-secret.enc');
    const secret = await loadOrCreateHookSecret(nested, protector);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    // A second load through the same (now-existing) path proves the write actually landed.
    expect(await loadOrCreateHookSecret(nested, protector)).toBe(secret);
  });

  it('regenerates instead of throwing when the persisted blob is corrupt', async () => {
    await writeFile(path, 'not-base64-not-json-garbage', 'utf8');
    const secret = await loadOrCreateHookSecret(path, protector);
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });

  it('regenerates when the persisted blob decrypts to an empty string', async () => {
    const blob = protector.protect(Buffer.from('', 'utf8'));
    await writeFile(path, blob, 'utf8');
    const secret = await loadOrCreateHookSecret(path, protector);
    expect(secret.length).toBeGreaterThan(0);
  });

  it('two different secret files never collide', async () => {
    const otherPath = join(dir, 'other-hook-secret.enc');
    const a = await loadOrCreateHookSecret(path, protector);
    const b = await loadOrCreateHookSecret(otherPath, protector);
    expect(a).not.toBe(b);
  });
});
