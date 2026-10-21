// The sealed file `cctl export` writes and `cctl import` reads.
//
// A vault is sealed to the machine that wrote it (DPAPI, a Keychain key, a local key file), so an
// account cannot travel as a copy of the vault. It travels as plaintext re-sealed under a
// passphrase instead, and this module is the whole of that seal: a JSON envelope around an
// AES-256-GCM ciphertext whose key comes from scrypt. There is deliberately no plaintext mode — the
// payload carries live refresh tokens.
//
// The envelope header is bound to the ciphertext as additional authenticated data, so editing any
// header field makes the file refuse to open rather than decrypt under different rules. A change
// to the IV fails the integrity check; a change to a field the key is derived from (the KDF
// parameters, the salt) or to the check value fails the passphrase check before that, since no key
// can tell such a change from a wrong passphrase. Reading is defensive throughout: the file may be
// cut short, edited, re-encoded by a shell, or made by someone else, and its KDF parameters decide
// how much memory and time a decode costs, so they are bounded before any key is derived.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
  type ScryptOptions,
} from 'node:crypto';

/** The `format` tag every export file carries; anything else is not ours. */
export const EXPORT_FORMAT = 'cctl-export';
/** The envelope version this build writes and the newest it reads. */
export const EXPORT_VERSION = 1;

/** scrypt cost parameters, as named in the scrypt paper (N = CPU/memory cost, r = block size,
 *  p = parallelism). */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** What an export is sealed with: about 128 MiB and a fraction of a second, which makes guessing a
 *  passphrase offline expensive while staying quick for the one honest decode. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

/**
 * The KDF parameters a file may ask for. The parameters come from the file, so without bounds a
 * hostile one could ask for gigabytes of memory or minutes of CPU before the passphrase is even
 * checked. The ceiling sits well above the default (room for a later build to raise it) and the
 * floor well below it (so a test can seal quickly), and memory (128 * N * r bytes) is capped on its
 * own because N and r multiply.
 */
export const SCRYPT_LIMITS = {
  minN: 2 ** 14,
  maxN: 2 ** 20,
  maxR: 16,
  maxP: 4,
  maxMemoryBytes: 256 * 1024 * 1024,
} as const;

/** The largest file `cctl import` will read. Far above any real export (a few KB per account), and
 *  low enough that a wrong file is refused before it is held in memory. */
export const MAX_EXPORT_FILE_BYTES = 16 * 1024 * 1024;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_BYTES = 16;
/** What the passphrase check value is computed over; it only has to differ from anything else the
 *  key is used for. */
const CHECK_LABEL = 'cctl-export passphrase check';

/** The envelope as it is stored. Binary fields are base64. */
export interface ExportEnvelope {
  format: typeof EXPORT_FORMAT;
  version: number;
  kdf: { name: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: 'aes-256-gcm';
  iv: string;
  /** A short MAC of a fixed label under a key derived alongside the cipher key. It tells a wrong
   *  passphrase apart from a changed ciphertext, IV or tag: those fail only the GCM tag, while a
   *  wrong passphrase fails this first. A change to the salt, the KDF parameters or this value also
   *  fails it, and is indistinguishable from a wrong passphrase without the right key. It gives a
   *  guesser nothing the GCM tag does not already give them. */
  check: string;
  tag: string;
  ct: string;
}

/** Why a file could not be opened. Each one is phrased for the operator and names no secret. */
export type ExportFileErrorCode =
  | 'not_an_export'
  | 'unsupported_version'
  | 'malformed'
  | 'bad_kdf'
  | 'wrong_passphrase'
  | 'tampered'
  | 'too_large';

/** A file that cannot be opened, with a stable code for tests and callers. */
export class ExportFileError extends Error {
  constructor(
    message: string,
    readonly code: ExportFileErrorCode,
  ) {
    super(message);
    this.name = 'ExportFileError';
  }
}

/** scrypt as a promise, with the memory ceiling raised to exactly what these parameters need (node's
 *  default ceiling of 32 MiB is below the default parameters). */
function deriveKeys(
  passphrase: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<{ cipherKey: Buffer; checkKey: Buffer }> {
  const options: ScryptOptions = {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * params.p + 1024 * 1024,
  };
  return new Promise((resolve, reject) => {
    scrypt(passphrase.normalize('NFC'), salt, 64, options, (err, key) => {
      if (err) reject(err);
      else resolve({ cipherKey: key.subarray(0, 32), checkKey: key.subarray(32) });
    });
  });
}

/** The passphrase check value for a derived check key. */
function checkValue(checkKey: Buffer): Buffer {
  return createHmac('sha256', checkKey).update(CHECK_LABEL).digest().subarray(0, CHECK_BYTES);
}

/** The header fields the ciphertext is bound to, in a fixed order, so the bytes are the same on
 *  both sides whatever order the JSON was written in. */
function headerAad(env: Omit<ExportEnvelope, 'tag' | 'ct'>): Buffer {
  return Buffer.from(
    JSON.stringify([
      env.format,
      env.version,
      env.kdf.name,
      env.kdf.N,
      env.kdf.r,
      env.kdf.p,
      env.kdf.salt,
      env.cipher,
      env.iv,
      env.check,
    ]),
    'utf8',
  );
}

/** Why scrypt parameters are refused, or undefined when they are within {@link SCRYPT_LIMITS}. */
export function scryptParamsProblem(params: ScryptParams): string | undefined {
  const { N, r, p } = params;
  if (!Number.isSafeInteger(N) || N < SCRYPT_LIMITS.minN || N > SCRYPT_LIMITS.maxN) {
    return `N must be between ${SCRYPT_LIMITS.minN} and ${SCRYPT_LIMITS.maxN}`;
  }
  if ((N & (N - 1)) !== 0) return 'N must be a power of two';
  if (!Number.isSafeInteger(r) || r < 1 || r > SCRYPT_LIMITS.maxR) {
    return `r must be between 1 and ${SCRYPT_LIMITS.maxR}`;
  }
  if (!Number.isSafeInteger(p) || p < 1 || p > SCRYPT_LIMITS.maxP) {
    return `p must be between 1 and ${SCRYPT_LIMITS.maxP}`;
  }
  if (128 * N * r > SCRYPT_LIMITS.maxMemoryBytes) {
    return `N and r together ask for more than ${SCRYPT_LIMITS.maxMemoryBytes / (1024 * 1024)} MiB`;
  }
  return undefined;
}

/**
 * Seal `plaintext` under `passphrase` and return the file's text. A fresh salt and IV every time,
 * so two exports of the same accounts under the same passphrase share nothing. `params` exists for
 * tests; the default is what real exports use.
 */
export async function sealExport(
  plaintext: string,
  passphrase: string,
  params: ScryptParams = DEFAULT_SCRYPT,
): Promise<string> {
  const problem = scryptParamsProblem(params);
  if (problem !== undefined)
    throw new Error(`refusing to seal with these scrypt parameters: ${problem}`);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const { cipherKey, checkKey } = await deriveKeys(passphrase, salt, params);
  const header: Omit<ExportEnvelope, 'tag' | 'ct'> = {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    kdf: { name: 'scrypt', N: params.N, r: params.r, p: params.p, salt: salt.toString('base64') },
    cipher: 'aes-256-gcm',
    iv: iv.toString('base64'),
    check: checkValue(checkKey).toString('base64'),
  };
  const cipher = createCipheriv('aes-256-gcm', cipherKey, iv);
  cipher.setAAD(headerAad(header));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const envelope: ExportEnvelope = {
    ...header,
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  const text = JSON.stringify(envelope, null, 2) + '\n';
  // A file the import would refuse unread is not worth writing (and, for --move, not worth
  // removing anything for).
  if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_FILE_BYTES) {
    throw new ExportFileError(
      `the export would be larger than ${MAX_EXPORT_FILE_BYTES / (1024 * 1024)} MiB, more than ` +
        'cctl import reads; export fewer accounts at a time with --accounts',
      'too_large',
    );
  }
  return text;
}

/**
 * A file's bytes as text, whatever a shell or editor did to its encoding: UTF-16 (little- or
 * big-endian, as Windows PowerShell 5.1 writes a `>` redirect) is decoded by its byte-order mark,
 * and a UTF-8 byte-order mark is dropped. Anything else is read as UTF-8.
 */
export function decodeExportText(bytes: Buffer): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const body = Buffer.from(bytes.subarray(2, 2 + ((bytes.length - 2) & ~1)));
    return body.swap16().toString('utf16le');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString('utf8');
  }
  return bytes.toString('utf8');
}

/** The base64 alphabet with at most two padding characters at the end. Strictness comes from this
 *  plus a whole number of quads (see {@link isStrictBase64}); the pattern has no repeated group,
 *  because a repeated group backtracks once per quad and overflows the regex stack on a field of a
 *  few million characters. */
const BASE64_CHARS = /^[A-Za-z0-9+/]*={0,2}$/;

/** Strict base64: the alphabet, whole quads, padding only at the end, and nothing else
 *  (Buffer.from would silently skip junk, so a damaged field could decode to fewer bytes without
 *  complaint). */
function isStrictBase64(value: string): boolean {
  return value.length % 4 === 0 && BASE64_CHARS.test(value);
}

/** Decode one base64 field, refusing a malformed one or one of the wrong length by name. */
function field(
  value: unknown,
  name: string,
  bytes: { exact?: number; min?: number; max?: number },
): Buffer {
  if (typeof value !== 'string' || !isStrictBase64(value)) {
    throw new ExportFileError(`the file's ${name} is not valid base64`, 'malformed');
  }
  const buf = Buffer.from(value, 'base64');
  const tooShort =
    bytes.exact !== undefined ? buf.length !== bytes.exact : buf.length < (bytes.min ?? 0);
  const tooLong = bytes.max !== undefined && buf.length > bytes.max;
  if (tooShort || tooLong) {
    throw new ExportFileError(`the file's ${name} has the wrong length`, 'malformed');
  }
  return buf;
}

/** A plain JSON object (not null, not an array). */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse and check the envelope's shape and bounds, without deriving any key. Exported so the
 *  cheap refusals (not an export, a newer version, hostile KDF parameters) are testable on their
 *  own. */
export function parseEnvelope(text: string): ExportEnvelope {
  if (Buffer.byteLength(text, 'utf8') > MAX_EXPORT_FILE_BYTES) {
    throw new ExportFileError(
      `the file is larger than ${MAX_EXPORT_FILE_BYTES / (1024 * 1024)} MiB, so it is not a cctl export`,
      'too_large',
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new ExportFileError(
      'the file is not a complete cctl export (it is not valid JSON - it may have been cut short)',
      'malformed',
    );
  }
  if (!isObject(raw) || raw['format'] !== EXPORT_FORMAT) {
    throw new ExportFileError('the file is not a cctl export', 'not_an_export');
  }
  const version = raw['version'];
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    throw new ExportFileError('the file has no valid version', 'malformed');
  }
  if (version > EXPORT_VERSION) {
    throw new ExportFileError(
      `the file was written by a newer cctl (export version ${version}; this build reads up to ` +
        `${EXPORT_VERSION}) - update cctl here first: npm i -g @andrewtjin/cctl`,
      'unsupported_version',
    );
  }
  const kdf = raw['kdf'];
  if (!isObject(kdf) || kdf['name'] !== 'scrypt') {
    throw new ExportFileError('the file names a key derivation this build does not use', 'bad_kdf');
  }
  const params = { N: kdf['N'], r: kdf['r'], p: kdf['p'] };
  if (
    typeof params.N !== 'number' ||
    typeof params.r !== 'number' ||
    typeof params.p !== 'number'
  ) {
    throw new ExportFileError('the file has incomplete key derivation parameters', 'bad_kdf');
  }
  const problem = scryptParamsProblem(params as ScryptParams);
  if (problem !== undefined) {
    throw new ExportFileError(
      `the file's key derivation parameters are refused: ${problem}`,
      'bad_kdf',
    );
  }
  if (raw['cipher'] !== 'aes-256-gcm') {
    throw new ExportFileError('the file names a cipher this build does not use', 'malformed');
  }
  field(kdf['salt'], 'salt', { min: SALT_BYTES, max: 64 });
  field(raw['iv'], 'iv', { exact: IV_BYTES });
  field(raw['check'], 'check value', { exact: CHECK_BYTES });
  field(raw['tag'], 'tag', { exact: TAG_BYTES });
  field(raw['ct'], 'ciphertext', { min: 1 });
  return {
    format: EXPORT_FORMAT,
    version,
    kdf: {
      name: 'scrypt',
      N: params.N,
      r: params.r,
      p: params.p,
      salt: kdf['salt'] as string,
    },
    cipher: 'aes-256-gcm',
    iv: raw['iv'] as string,
    check: raw['check'] as string,
    tag: raw['tag'] as string,
    ct: raw['ct'] as string,
  };
}

/**
 * Open a file's text with `passphrase` and return the plaintext. Refuses, by code: not an export, a
 * newer version, refused KDF parameters, a damaged or cut-short file, a wrong passphrase, and a file
 * changed after it was written. Nothing is returned unless the whole ciphertext authenticated.
 */
export async function openExport(text: string, passphrase: string): Promise<string> {
  const env = parseEnvelope(text);
  const { cipherKey, checkKey } = await deriveKeys(
    passphrase,
    Buffer.from(env.kdf.salt, 'base64'),
    env.kdf,
  );
  const expected = Buffer.from(env.check, 'base64');
  if (!timingSafeEqual(checkValue(checkKey), expected)) {
    throw new ExportFileError(
      'the passphrase does not open this file, or its key settings were changed',
      'wrong_passphrase',
    );
  }
  const decipher = createDecipheriv('aes-256-gcm', cipherKey, Buffer.from(env.iv, 'base64'));
  decipher.setAAD(headerAad(env));
  decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(env.ct, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new ExportFileError(
      'the file was changed after it was written (it fails its integrity check)',
      'tampered',
    );
  }
}
