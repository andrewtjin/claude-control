import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { AesGcmProtector } from './aesgcm.js';
import { VaultError } from './errors.js';

// Pure crypto, provable on any platform.

describe('AesGcmProtector', () => {
  const key = randomBytes(32);

  it('round-trips arbitrary bytes and never emits plaintext', async () => {
    const p = new AesGcmProtector(key);
    const secret = Buffer.from('refresh-token-🔐-value', 'utf8');
    const blob = await p.protect(secret);
    expect(blob.startsWith('aesgcm:')).toBe(true);
    expect(blob).not.toContain('refresh-token');
    expect((await p.unprotect(blob)).equals(secret)).toBe(true);
  });

  it('uses a fresh IV per call (same plaintext, different blobs)', async () => {
    const p = new AesGcmProtector(key);
    const secret = Buffer.from('same');
    expect(await p.protect(secret)).not.toBe(await p.protect(secret));
  });

  it('rejects a tampered blob via GCM authentication, not garbage output', async () => {
    const p = new AesGcmProtector(key);
    const blob = await p.protect(Buffer.from('payload-payload-payload'));
    const raw = Buffer.from(blob.slice('aesgcm:'.length), 'base64');
    raw.writeUInt8(raw.readUInt8(raw.length - 1) ^ 0xff, raw.length - 1); // flip one bit
    await expect(p.unprotect(`aesgcm:${raw.toString('base64')}`)).rejects.toThrow(VaultError);
  });

  it('rejects a blob encrypted under a different key', async () => {
    const blob = await new AesGcmProtector(randomBytes(32)).protect(Buffer.from('x'));
    await expect(new AesGcmProtector(key).unprotect(blob)).rejects.toThrow(VaultError);
  });

  it('rejects foreign and truncated blobs', async () => {
    const p = new AesGcmProtector(key);
    await expect(p.unprotect('insecure:abc')).rejects.toThrow(VaultError);
    await expect(p.unprotect('aesgcm:AAAA')).rejects.toThrow(VaultError);
  });

  it('requires a 32-byte key', () => {
    expect(() => new AesGcmProtector(randomBytes(16))).toThrow(VaultError);
  });
});
