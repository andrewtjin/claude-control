// The export seal: a round trip, and every way a file is refused before or while it is opened.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SCRYPT,
  EXPORT_VERSION,
  ExportFileError,
  MAX_EXPORT_FILE_BYTES,
  SCRYPT_LIMITS,
  openExport,
  parseEnvelope,
  scryptParamsProblem,
  sealExport,
  type ExportEnvelope,
} from './exportEnvelope.js';

/** The cheapest parameters the reader accepts, so the suite does not pay the real cost each time. */
const FAST = { N: SCRYPT_LIMITS.minN, r: 8, p: 1 };
const PASS = 'correct horse battery';

/** The code a promise (or a call) is refused with. */
async function codeOf(work: () => unknown): Promise<string> {
  try {
    await work();
  } catch (err) {
    expect(err).toBeInstanceOf(ExportFileError);
    return (err as ExportFileError).code;
  }
  throw new Error('expected a refusal');
}

/** Seal, then hand back the envelope as an object to edit. */
async function sealedObject(plaintext = '{"hello":"world"}'): Promise<ExportEnvelope> {
  return JSON.parse(await sealExport(plaintext, PASS, FAST)) as ExportEnvelope;
}

/** Flip one bit of a base64 field. */
function flip(b64: string, byte = 0): string {
  const buf = Buffer.from(b64, 'base64');
  buf[byte] = buf[byte]! ^ 1;
  return buf.toString('base64');
}

describe('sealExport / openExport', () => {
  it('round-trips the plaintext, unicode included', async () => {
    const text = JSON.stringify({ label: 'trabajo ✓', n: 1 });
    expect(await openExport(await sealExport(text, PASS, FAST), PASS)).toBe(text);
  });

  it('writes the documented envelope, and never the plaintext', async () => {
    const env = await sealedObject('{"secret":"refresh-token-value"}');
    expect(env.format).toBe('cctl-export');
    expect(env.version).toBe(EXPORT_VERSION);
    expect(env.cipher).toBe('aes-256-gcm');
    expect(env.kdf).toMatchObject({ name: 'scrypt', N: FAST.N, r: 8, p: 1 });
    expect(JSON.stringify(env)).not.toContain('refresh-token-value');
  });

  it('uses a fresh salt and iv every time', async () => {
    const a = await sealedObject();
    const b = await sealedObject();
    expect(a.kdf.salt).not.toBe(b.kdf.salt);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it('seals with the real default parameters by default', async () => {
    const env = JSON.parse(await sealExport('{}', PASS)) as ExportEnvelope;
    expect(env.kdf).toMatchObject(DEFAULT_SCRYPT);
    expect(await openExport(JSON.stringify(env), PASS)).toBe('{}');
  });

  it('names a wrong passphrase', async () => {
    const text = await sealExport('{}', PASS, FAST);
    expect(await codeOf(() => openExport(text, PASS + '!'))).toBe('wrong_passphrase');
  });

  it('refuses a changed ciphertext, tag or iv as changed, not as a wrong passphrase', async () => {
    const env = await sealedObject();
    expect(await codeOf(() => openExport(JSON.stringify({ ...env, ct: flip(env.ct) }), PASS))).toBe(
      'tampered',
    );
    expect(
      await codeOf(() => openExport(JSON.stringify({ ...env, tag: flip(env.tag) }), PASS)),
    ).toBe('tampered');
    expect(await codeOf(() => openExport(JSON.stringify({ ...env, iv: flip(env.iv) }), PASS))).toBe(
      'tampered',
    );
  });

  it('refuses a changed check value or salt (the key no longer matches)', async () => {
    const env = await sealedObject();
    expect(
      await codeOf(() => openExport(JSON.stringify({ ...env, check: flip(env.check) }), PASS)),
    ).toBe('wrong_passphrase');
    expect(
      await codeOf(() =>
        openExport(JSON.stringify({ ...env, kdf: { ...env.kdf, salt: flip(env.kdf.salt) } }), PASS),
      ),
    ).toBe('wrong_passphrase');
  });

  it('refuses KDF parameters changed after sealing', async () => {
    const env = await sealedObject();
    const code = await codeOf(() =>
      openExport(JSON.stringify({ ...env, kdf: { ...env.kdf, N: FAST.N * 2 } }), PASS),
    );
    expect(['wrong_passphrase', 'tampered']).toContain(code);
  });

  it('refuses a file cut short', async () => {
    const text = await sealExport('{"a":1}', PASS, FAST);
    for (const cut of [1, 10, Math.floor(text.length / 2), text.length - 3]) {
      expect(await codeOf(() => openExport(text.slice(0, cut), PASS))).toBe('malformed');
    }
  });

  it('refuses a ciphertext cut short inside an intact envelope', async () => {
    const env = await sealedObject('{"a":"' + 'x'.repeat(100) + '"}');
    const ct = Buffer.from(env.ct, 'base64').subarray(0, 40).toString('base64');
    expect(await codeOf(() => openExport(JSON.stringify({ ...env, ct }), PASS))).toBe('tampered');
  });
});

describe('parseEnvelope', () => {
  it('refuses what is not an export', async () => {
    expect(await codeOf(() => parseEnvelope('[]'))).toBe('not_an_export');
    expect(await codeOf(() => parseEnvelope('{"format":"zip"}'))).toBe('not_an_export');
    expect(await codeOf(() => parseEnvelope('not json at all'))).toBe('malformed');
  });

  it('refuses a newer version and says to update', async () => {
    const env = await sealedObject();
    let message = '';
    try {
      parseEnvelope(JSON.stringify({ ...env, version: EXPORT_VERSION + 1 }));
    } catch (err) {
      message = (err as Error).message;
      expect((err as ExportFileError).code).toBe('unsupported_version');
    }
    expect(message).toContain('newer cctl');
    expect(message).toContain('npm i -g @andrewtjin/cctl');
  });

  it('refuses a missing or nonsense version', async () => {
    const env = await sealedObject();
    for (const version of [0, -1, 1.5, '1', null]) {
      expect(await codeOf(() => parseEnvelope(JSON.stringify({ ...env, version })))).toBe(
        'malformed',
      );
    }
  });

  it('bounds the KDF parameters before deriving anything', async () => {
    const env = await sealedObject();
    const hostile = [
      { N: 2 ** 30 }, // gigabytes of memory
      { N: SCRYPT_LIMITS.maxN * 2 },
      { N: 2 ** 10 }, // below the floor
      { N: 3 * 2 ** 14 }, // not a power of two
      { r: 64 },
      { r: 0 },
      { p: 1000 },
      { N: SCRYPT_LIMITS.maxN, r: 16 }, // each in range, together 2 GiB
      { N: '16384' },
      { name: 'argon2id' },
    ];
    for (const change of hostile) {
      const kdf = { ...env.kdf, ...change };
      expect(await codeOf(() => parseEnvelope(JSON.stringify({ ...env, kdf })))).toBe('bad_kdf');
    }
  });

  it('refuses fields of the wrong length or not base64', async () => {
    const env = await sealedObject();
    const bad: Partial<Record<keyof ExportEnvelope, unknown>>[] = [
      { iv: Buffer.alloc(8).toString('base64') },
      { tag: Buffer.alloc(4).toString('base64') },
      { check: 'not*base64' },
      { ct: '' },
      { cipher: 'aes-128-cbc' },
    ];
    for (const change of bad) {
      expect(await codeOf(() => parseEnvelope(JSON.stringify({ ...env, ...change })))).toBe(
        'malformed',
      );
    }
  });

  it('refuses a file too large to be an export without parsing it', async () => {
    expect(await codeOf(() => parseEnvelope(' '.repeat(MAX_EXPORT_FILE_BYTES + 1)))).toBe(
      'too_large',
    );
  });

  it('accepts a byte-order mark an editor added', async () => {
    const text = await sealExport('{}', PASS, FAST);
    expect(await openExport('﻿' + text, PASS)).toBe('{}');
  });
});

describe('scryptParamsProblem', () => {
  it('accepts the default and the floor', () => {
    expect(scryptParamsProblem(DEFAULT_SCRYPT)).toBeUndefined();
    expect(scryptParamsProblem(FAST)).toBeUndefined();
  });

  it('refuses to seal with parameters a reader would refuse', async () => {
    await expect(sealExport('{}', PASS, { N: 2 ** 10, r: 8, p: 1 })).rejects.toThrow(/refusing/);
  });
});
