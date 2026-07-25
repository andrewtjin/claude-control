import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileKeyProtector, FileKeySource } from './fileKey.js';
import { VaultError } from './errors.js';

// Mode (permission-bit) assertions only mean something on a POSIX filesystem — Windows
// fakes them over NTFS ACLs — so those specific tests skip on win32. Everything else
// (creation, races, validation, round-trips) is pure logic and runs everywhere; CI's
// ubuntu runner exercises the full set.
const posix = process.platform !== 'win32';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-filekey-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Key path inside a not-yet-existing subdir, so creation also proves dir handling. */
const keyPath = () => join(root, 'data', 'vault.key');

describe('FileKeySource', () => {
  it('creates a key on first use and returns the same key afterwards', async () => {
    const src = new FileKeySource(keyPath());
    const first = await src.getOrCreateKey();
    expect(first.length).toBe(32);
    expect((await src.getOrCreateKey()).equals(first)).toBe(true);
  });

  it('two sources over one path share the key (daemon and CLI interoperate)', async () => {
    const a = await new FileKeySource(keyPath()).getOrCreateKey();
    const b = await new FileKeySource(keyPath()).getOrCreateKey();
    expect(b.equals(a)).toBe(true);
  });

  it('stores the key as 64 hex chars (same format the Keychain source stores)', async () => {
    await new FileKeySource(keyPath()).getOrCreateKey();
    expect((await readFile(keyPath(), 'utf8')).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('adopts a pre-existing key file (externally provisioned keys keep working)', async () => {
    await mkdir(join(root, 'data'), { recursive: true });
    const hex = 'ab'.repeat(32);
    await writeFile(keyPath(), `${hex}\n`);
    expect((await new FileKeySource(keyPath()).getOrCreateKey()).toString('hex')).toBe(hex);
  });

  it('refuses a malformed key file and leaves it untouched for inspection', async () => {
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(keyPath(), 'not-a-key');
    await expect(new FileKeySource(keyPath()).getOrCreateKey()).rejects.toThrow(VaultError);
    // Clobbering the file would orphan any blobs sealed under whatever it used to hold.
    expect(await readFile(keyPath(), 'utf8')).toBe('not-a-key');
  });

  it('surfaces a non-ENOENT key read failure as VaultError (never mints a replacement)', async () => {
    // The key path IS a directory, so readFile fails EISDIR — which must be loud, not
    // treated as "absent" (that would mint a fresh key and orphan every existing blob).
    // Mirrors keychain.test.ts's 'propagates non-not-found keychain failures'.
    await mkdir(keyPath(), { recursive: true });
    await expect(new FileKeySource(keyPath()).getOrCreateKey()).rejects.toThrow(VaultError);
  });

  it('concurrent first runs converge on a single key (link-publish race)', async () => {
    const keys = await Promise.all(
      Array.from({ length: 8 }, () => new FileKeySource(keyPath()).getOrCreateKey()),
    );
    const hex = keys[0]?.toString('hex');
    for (const k of keys) expect(k.toString('hex')).toBe(hex);
  });

  it.skipIf(!posix)('creates the key 0600 inside a 0700 dir', async () => {
    await new FileKeySource(keyPath()).getOrCreateKey();
    expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, 'data'))).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)('tightens a pre-existing wider dir at key birth', async () => {
    await mkdir(join(root, 'data'), { recursive: true, mode: 0o755 });
    await new FileKeySource(keyPath()).getOrCreateKey();
    expect((await stat(join(root, 'data'))).mode & 0o777).toBe(0o700);
  });

  it.skipIf(!posix)('repairs a key file that drifted group/other-readable', async () => {
    const src = new FileKeySource(keyPath());
    await src.getOrCreateKey();
    await chmod(keyPath(), 0o644);
    await src.getOrCreateKey();
    expect((await stat(keyPath())).mode & 0o777).toBe(0o600);
  });
});

describe('FileKeyProtector', () => {
  it('refuses to run where the OS has a stronger secret store', async () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const p = new FileKeyProtector(new FileKeySource(keyPath()), platform);
      await expect(p.protect(Buffer.from('x'))).rejects.toThrow(/OS secret store/);
      await expect(p.unprotect('aesgcm:AAAA')).rejects.toThrow(/OS secret store/);
    }
  });

  it('round-trips through the file-held key under linux dispatch', async () => {
    const p = new FileKeyProtector(new FileKeySource(keyPath()), 'linux');
    const secret = Buffer.from('refresh-token-🔐', 'utf8');
    const blob = await p.protect(secret);
    expect(blob.startsWith('aesgcm:')).toBe(true);
    expect((await p.unprotect(blob)).equals(secret)).toBe(true);
  });

  it('two protectors sharing one key file interoperate (daemon seals, CLI opens)', async () => {
    const sealer = new FileKeyProtector(new FileKeySource(keyPath()), 'linux');
    const opener = new FileKeyProtector(new FileKeySource(keyPath()), 'linux');
    const blob = await sealer.protect(Buffer.from('cross-process'));
    expect((await opener.unprotect(blob)).toString()).toBe('cross-process');
  });
});
