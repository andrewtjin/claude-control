import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DpapiProtector, InsecurePassthroughProtector } from '@claude-control/switch-engine';
import { hookSecretPath, loadHookSecret, loadOrCreateHookSecret } from './hookSecret.js';

describe('hookSecretPath', () => {
  it('places the secret as a sibling of the vault under the data dir', () => {
    // The CLI derives the identical path from the same dataDir — this is the sharing contract.
    expect(hookSecretPath('/data/claude-control')).toBe(
      join('/data/claude-control', 'hook-secret.enc'),
    );
  });
});

describe('loadOrCreateHookSecret (daemon-side, cross-platform via passthrough)', () => {
  let dir: string;
  let filePath: string;
  const protector = new InsecurePassthroughProtector();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hook-secret-'));
    filePath = join(dir, 'hook-secret.enc');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('mints and persists a secret on first run', async () => {
    const secret = await loadOrCreateHookSecret({ filePath, protector, generate: () => 'minted' });
    expect(secret).toBe('minted');
    // Persisted encrypted, not plaintext.
    const onDisk = await readFile(filePath, 'utf8');
    expect(onDisk).not.toContain('minted');
    expect(protector.unprotect(onDisk).toString('utf8')).toBe('minted');
  });

  it('is STABLE across restarts — a second load returns the same secret, not a new one', async () => {
    const first = await loadOrCreateHookSecret({ filePath, protector, generate: () => 'first' });
    // Even though generate would produce a different value, the persisted secret wins.
    const second = await loadOrCreateHookSecret({ filePath, protector, generate: () => 'second' });
    expect(second).toBe(first);
    expect(second).toBe('first');
  });

  it('regenerates when the persisted blob is corrupt (never crashes)', async () => {
    await writeFile(filePath, 'not-a-valid-protected-blob', 'utf8');
    const secret = await loadOrCreateHookSecret({
      filePath,
      protector,
      generate: () => 'regenerated',
    });
    expect(secret).toBe('regenerated');
  });

  it('creates missing parent directories on the first-ever write', async () => {
    const nested = join(dir, 'a', 'b', 'hook-secret.enc');
    const secret = await loadOrCreateHookSecret({
      filePath: nested,
      protector,
      generate: () => 'deep',
    });
    expect(secret).toBe('deep');
    expect(protector.unprotect(await readFile(nested, 'utf8')).toString('utf8')).toBe('deep');
  });
});

describe('loadHookSecret (CLI-side, read-only)', () => {
  let dir: string;
  let filePath: string;
  const protector = new InsecurePassthroughProtector();

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'hook-secret-ro-'));
    filePath = join(dir, 'hook-secret.enc');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns undefined when the daemon has never generated a secret (does not mint one)', async () => {
    expect(await loadHookSecret({ filePath, protector })).toBeUndefined();
    // Crucially, calling the read-only loader must NOT have created the file.
    await expect(readFile(filePath, 'utf8')).rejects.toThrow();
  });

  it('reads exactly what loadOrCreateHookSecret persisted (round-trip across the contract)', async () => {
    const written = await loadOrCreateHookSecret({ filePath, protector, generate: () => 'shared' });
    expect(await loadHookSecret({ filePath, protector })).toBe(written);
  });

  it('degrades a corrupt blob to undefined instead of throwing', async () => {
    await writeFile(filePath, 'garbage', 'utf8');
    expect(await loadHookSecret({ filePath, protector })).toBeUndefined();
  });
});

// Real DPAPI is Windows-only and exercises PowerShell ProtectedData end-to-end — a genuine
// encryption round-trip on the developer's own machine, not a mock. Each protect/unprotect
// spawns a real powershell.exe (~2s), so give the block a generous budget (mirrors dpapi.test).
describe.skipIf(process.platform !== 'win32')(
  'hook secret with real DPAPI',
  { timeout: 30_000 },
  () => {
    let dir: string;
    let filePath: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'hook-secret-dpapi-'));
      filePath = join(dir, 'hook-secret.enc');
    });

    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('mints, persists (encrypted), and reloads the SAME secret via real DPAPI', async () => {
      const protector = new DpapiProtector();
      const minted = await loadOrCreateHookSecret({ filePath, protector });
      expect(minted.length).toBeGreaterThan(0);

      // On-disk bytes are ciphertext, not the secret.
      const onDisk = await readFile(filePath, 'utf8');
      expect(onDisk).not.toContain(minted);

      // The read-only (CLI) path decrypts the daemon's blob to the identical secret.
      const reloaded = await loadHookSecret({ filePath, protector });
      expect(reloaded).toBe(minted);

      // And loadOrCreate is idempotent — a "restart" returns the persisted value.
      const afterRestart = await loadOrCreateHookSecret({ filePath, protector });
      expect(afterRestart).toBe(minted);
    });
  },
);
