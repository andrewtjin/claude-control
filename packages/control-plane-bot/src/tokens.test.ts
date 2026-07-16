import { describe, it, expect } from 'vitest';
import { mintToken, hashToken, verifyToken } from './tokens.js';

describe('mintToken', () => {
  it('produces unique, high-entropy, URL-safe tokens', () => {
    const tokens = new Set(Array.from({ length: 50 }, () => mintToken()));
    expect(tokens.size).toBe(50); // no collisions across 50 mints
    for (const token of tokens) {
      expect(token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url alphabet only
      expect(token.length).toBeGreaterThanOrEqual(40); // 256 bits ~= 43 base64url chars
    }
  });
});

describe('hashToken / verifyToken', () => {
  it('accepts the correct token against its own hash', async () => {
    const token = mintToken();
    const hash = await hashToken(token);
    expect(await verifyToken(token, hash)).toBe(true);
  });

  it('rejects a wrong token', async () => {
    const hash = await hashToken(mintToken());
    expect(await verifyToken(mintToken(), hash)).toBe(false);
  });

  it('rejects an empty-string candidate', async () => {
    const hash = await hashToken(mintToken());
    expect(await verifyToken('', hash)).toBe(false);
  });

  it('produces a different hash each time (fresh salt)', async () => {
    const token = mintToken();
    const [hashA, hashB] = await Promise.all([hashToken(token), hashToken(token)]);
    expect(hashA).not.toBe(hashB);
    // Both still verify — the salt differs, the derived key does not represent the token.
    expect(await verifyToken(token, hashA)).toBe(true);
    expect(await verifyToken(token, hashB)).toBe(true);
  });

  it('rejects malformed stored values without throwing', async () => {
    const token = mintToken();
    await expect(verifyToken(token, '')).resolves.toBe(false);
    await expect(verifyToken(token, 'not-a-hash')).resolves.toBe(false);
    await expect(verifyToken(token, ':')).resolves.toBe(false);
    await expect(verifyToken(token, 'deadbeef:')).resolves.toBe(false);
  });

  it('never throws even when the stored hash length differs from a fresh derivation', async () => {
    // A stored hash with a short (but valid hex) hash half must be a clean "no", not a
    // timingSafeEqual length-mismatch throw.
    const token = mintToken();
    await expect(verifyToken(token, 'aabbccdd:1234')).resolves.toBe(false);
  });
});
