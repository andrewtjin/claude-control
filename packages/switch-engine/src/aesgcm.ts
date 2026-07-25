// AES-256-GCM sealing over an injected 32-byte key — the shared primitive for every
// platform whose protector keeps a key OUTSIDE the vault and encrypts in-process
// (darwin: login-Keychain-held key · linux/POSIX: 0600 key file). One implementation,
// one blob format, so vault blobs are byte-compatible across those platforms and the
// pure-node:crypto logic unit-tests anywhere.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { VaultError } from './errors.js';
import type { Protector } from './dpapi.js';

/**
 * AES-256-GCM protector over an injected 32-byte key. Pure node:crypto — unit-testable on
 * every platform. Blob format: `aesgcm:` + base64( iv(12) ‖ authTag(16) ‖ ciphertext ), so
 * tampering with ANY byte fails authentication rather than yielding garbage plaintext.
 * The crypto itself is fast in-process CPU; the async signatures exist to satisfy the
 * Protector contract, whose other implementations genuinely shell out.
 */
export class AesGcmProtector implements Protector {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new VaultError('AES-256-GCM requires a 32-byte key');
  }

  protect(plaintext: Buffer): Promise<string> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return Promise.resolve(
      `aesgcm:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`,
    );
  }

  unprotect(blob: string): Promise<Buffer> {
    try {
      if (!blob.startsWith('aesgcm:')) {
        throw new VaultError('blob was not produced by AesGcmProtector');
      }
      const raw = Buffer.from(blob.slice('aesgcm:'.length), 'base64');
      if (raw.length < 12 + 16) throw new VaultError('AES-GCM blob too short');
      const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      try {
        return Promise.resolve(
          Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]),
        );
      } catch (err) {
        // Wrong key or tampered blob — GCM authentication failed either way.
        throw new VaultError('AES-GCM authentication failed (wrong key or corrupted blob)', {
          cause: err,
        });
      }
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }
}
