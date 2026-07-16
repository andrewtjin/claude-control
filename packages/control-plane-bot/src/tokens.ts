// Daemon-token minting, hashing, and constant-time verification.
//
// The bot never stores a daemon token in plaintext — only a scrypt hash survives to disk
// (via BindingStore). scrypt is deliberately slow/memory-hard, which blunts offline brute
// forcing of a leaked bindings file; the verify path uses a timing-safe comparison so a
// mismatch never leaks *how much* of the hash matched via a response-time side channel.

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt cost parameters. Daemon tokens are 256-bit CSPRNG values, not user-chosen
// passwords, so this is deliberately lighter than a login KDF: it only needs to blunt
// offline cracking of a stolen hash, not resist a targeted attack on a weak secret. N=16384
// (2^14) keeps a single hash under ~100ms on modest hardware without starving the relay's
// event loop when a hello arrives during a hot path.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;

/** Mint a fresh 256-bit daemon token as base64url text — high entropy, URL/JSON safe, and
 *  short enough to paste into a daemon's local config during pairing. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash a token for at-rest storage. The stored format is `<saltHex>:<hashHex>` so verify
 *  can recover the salt without a separate column in the bindings store. */
export async function hashToken(token: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scryptDerive(token, salt, KEY_LEN);
  return `${salt.toString('hex')}:${derived.toString('hex')}`;
}

/** Verify a candidate token against a stored `hashToken()` value. Constant-time: a wrong
 *  token always costs exactly one scrypt derivation plus one `timingSafeEqual`, regardless
 *  of where the candidate first diverges from the truth. */
export async function verifyToken(token: string, stored: string): Promise<boolean> {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false; // malformed stored value can never verify
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = await scryptDerive(token, salt, expected.length);
  // timingSafeEqual throws on a length mismatch rather than returning false; guard first so
  // a corrupted/foreshortened stored hash is a clean "no" instead of an unhandled throw.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

// `node:crypto`'s scrypt has two overloads (with and without an options bag) that
// `util.promisify` cannot disambiguate cleanly under our TS config, so this wraps the
// callback form directly rather than fighting the overload resolution.
function scryptDerive(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  const options: ScryptOptions = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}
