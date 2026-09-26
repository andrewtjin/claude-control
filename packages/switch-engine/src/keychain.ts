// macOS credential-at-rest protection and live-credential access via the login Keychain.
//
// Two distinct jobs live here because both talk to `security(1)` and share its hygiene rules:
//
//  1. VAULT protection (our storage): a random 256-bit key is kept as a generic password in
//     the user's login Keychain, and vault blobs are AES-256-GCM encrypted with it in-process
//     (aesgcm.ts — the sealing primitive shared with the POSIX file-key protector). Same
//     threat model as DPAPI on Windows: a stolen vault directory is useless without the
//     owner's login keychain.
//
//  2. LIVE credentials (Claude Code's storage): on macOS the CLI keeps its `claudeAiOauth`
//     block in the login Keychain — NOT in `<claudeDir>/.credentials.json` — so an account
//     switch must content-swap the Keychain item instead of the file. The current CLI stores it
//     via its secure-storage layer under a fixed account and a service name derived from the
//     config directory, and it splits values over ~2400 bytes into a metadata item plus numbered
//     base64 chunks. We read and write that exact layout so the CLI reads back what we write, and
//     keep a plain read of the older un-suffixed-service item (same fixed account) as a fallback
//     for pre-`-credentials` CLIs.
//
// Hygiene rule shared with dpapi.ts: SECRETS NEVER APPEAR ON ARGV. Reads are safe (`security
// find-generic-password -w` takes only service/account on argv and prints the secret on
// stdout). Writes go through `security -i`, which reads whole commands from STDIN — the
// secret rides inside the stdin line, never in the process table.
//
// Shelling out is ASYNC end-to-end for the same reason dpapi.ts is: a child-process spawn
// behind a synchronous call sits on the daemon's event loop and stalls every concurrent hook
// request for the spawn's lifetime.
//
// ⚠ Everything touching the REAL `security(1)` or the REAL mac CLI is unverified until it
// runs on an actual Mac. The logic below is unit-tested against a fake runner only.

import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { AesGcmProtector } from './aesgcm.js';
import { VaultError } from './errors.js';
import type { Protector } from './dpapi.js';
import type { ClaudeOauth } from './types.js';
import type { LiveCredentialChannel } from './credentialStore.js';

/** How this module shells out. Injected so every code path unit-tests on any platform.
 *  Resolves with stdout; MUST reject on a non-zero exit, with the process's stderr text
 *  reachable via the error's `stderr` field (isNotFound relies on it). */
export type ExecRunner = (file: string, args: string[], input?: string) => Promise<string>;

/** Production runner. stderr is captured so `security`'s error text lands in rejected errors
 *  (same rationale as dpapi.ts's runPowerShell) and never on the parent console. */
export const defaultExecRunner: ExecRunner = (file, args, input) =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errOut.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(out).toString('utf8'));
        return;
      }
      const stderr = Buffer.concat(errOut).toString('utf8');
      const err = new Error(`${file} exited with code ${code ?? 'null'}: ${stderr.slice(0, 2000)}`);
      // Mirror execFile's error shape: isNotFound inspects `stderr` to tell "item missing"
      // from a real failure.
      (err as Error & { stderr: string }).stderr = stderr;
      reject(err);
    });
    child.stdin.on('error', () => {}); // a dead child surfaces via 'close', not the write
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });

/** `security -i` tokenizes stdin lines like a shell: to pass an arbitrary string as one
 *  argument it must be double-quoted with `\` and `"` escaped. (Assumed to match the real
 *  parser — exercise on a real Mac before the first real switch.) */
export function quoteSecurityArg(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** True when `security` failed because the item does not exist (exit 44 / errSecItemNotFound
 *  prints "could not be found"). Everything else is a real error and must propagate. */
function isNotFound(err: unknown): boolean {
  const stderr = (err as { stderr?: unknown })?.stderr;
  const text = typeof stderr === 'string' ? stderr : String((err as Error)?.message ?? '');
  return /could not be found|SecKeychainSearchCopyNext/i.test(text);
}

// --- 1. Vault protection ---------------------------------------------------------------

/** Where the vault key lives in the login Keychain. Ours — free to name as we like. */
export const VAULT_KEY_SERVICE = 'claude-control';
export const VAULT_KEY_ACCOUNT = 'vault-key';

/**
 * Get-or-create the vault key in the login Keychain. Read path puts only service/account on
 * argv; create path generates 32 random bytes and stores them hex-encoded via `security -i`
 * (`-U` upserts, so a concurrent first-run race converges on one of the two keys — both
 * writers re-read afterwards, so both end up using whichever write won).
 */
export class KeychainKeySource {
  constructor(private readonly run: ExecRunner = defaultExecRunner) {}

  async getOrCreateKey(): Promise<Buffer> {
    const existing = await this.readKey();
    if (existing) return existing;
    const fresh = randomBytes(32).toString('hex');
    try {
      await this.run(
        'security',
        ['-i'],
        `add-generic-password -U -s ${VAULT_KEY_SERVICE} -a ${VAULT_KEY_ACCOUNT} -w ${fresh}\n`,
      );
    } catch (err) {
      throw new VaultError('failed to store vault key in the login Keychain', { cause: err });
    }
    // Re-read instead of trusting our value: if a concurrent creator won the -U upsert race,
    // the keychain's copy is the truth.
    const stored = await this.readKey();
    if (!stored) throw new VaultError('vault key vanished after Keychain write');
    return stored;
  }

  private async readKey(): Promise<Buffer | undefined> {
    let out: string;
    try {
      out = await this.run('security', [
        'find-generic-password',
        '-s',
        VAULT_KEY_SERVICE,
        '-a',
        VAULT_KEY_ACCOUNT,
        '-w',
      ]);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw new VaultError('failed to read vault key from the login Keychain', { cause: err });
    }
    const hex = out.trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new VaultError('vault key in Keychain is not a 32-byte hex string');
    }
    return Buffer.from(hex, 'hex');
  }
}

/** Real macOS vault protector: Keychain-held key + in-process AES-GCM. Guarded to darwin the
 *  same way DpapiProtector is guarded to win32. Key resolution is lazy (first use), so merely
 *  constructing one — e.g. in a composition root — never touches the Keychain. */
export class KeychainProtector implements Protector {
  private inner: AesGcmProtector | undefined;

  constructor(
    private readonly keySource: KeychainKeySource = new KeychainKeySource(),
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private async delegate(): Promise<AesGcmProtector> {
    if (this.platform !== 'darwin') {
      throw new VaultError('Keychain protection is only available on macOS');
    }
    this.inner ??= new AesGcmProtector(await this.keySource.getOrCreateKey());
    return this.inner;
  }

  async protect(plaintext: Buffer): Promise<string> {
    return (await this.delegate()).protect(plaintext);
  }

  async unprotect(blob: string): Promise<Buffer> {
    return (await this.delegate()).unprotect(blob);
  }
}

// --- 2. Live credentials ---------------------------------------------------------------
//
// The current CLI stores its live `claudeAiOauth` block through its secure-storage layer, which on
// macOS maps to a login-Keychain generic password (`kSecAttrService` = the item's service,
// `kSecAttrAccount` = its account/name). So `/usr/bin/security -s <service> -a <account>` addresses
// the very same item the CLI reads and writes. The value it stores (decoded) is the same wrapped
// `{"claudeAiOauth":{...}, ...}` JSON as `.credentials.json`, EXCEPT that a value over ~2400 bytes
// is base64-encoded and split into numbered chunk items plus a metadata item — see the layout in
// {@link readChunkedValue}/{@link writeChunkedValue}. We match that layout exactly so the CLI reads
// back what we write. Older, pre-`-credentials` CLIs kept a single unchunked item under the
// un-suffixed service (same fixed `claude-code-user` account); we still READ that as a fallback but
// never write it.

/** The base service name for the CLI's live-credential item (`Claude Code` + the prod-empty OAuth
 *  file suffix + `-credentials`). The current CLI appends a config-dir hash suffix on top of this
 *  when the config directory is customized; older CLIs used exactly this name. Kept exported for
 *  callers that report the base name. */
export const CLAUDE_CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** The fixed account the CLI stores its credential under (its secure-storage `name`). This has
 *  ALWAYS been the account — no CLI keyed the item by the login username, including the legacy
 *  un-suffixed item the channel below reads as a fallback. */
export const CLAUDE_CLI_KEYCHAIN_ACCOUNT = 'claude-code-user';

/** The base service name the CLI used BEFORE it moved the live credential under the `-credentials`
 *  service: the same `Claude Code` prefix without the `-credentials` segment (the CLI's `kJ("")`).
 *  A pre-`-credentials` CLI stored a single unchunked item here, under the same `claude-code-user`
 *  account. Read-only fallback; never written. */
export const CLAUDE_CLI_LEGACY_KEYCHAIN_SERVICE = 'Claude Code';

/** Values at or below this many UTF-8 bytes are stored in a single item; larger ones are base64ed
 *  and split into chunks of this many base64 characters each. Matches the CLI's threshold.
 *  Exported for the layout unit tests. */
export const CHUNK_THRESHOLD_BYTES = 2400;

/** The CLI's own ceiling on chunk count (guards a runaway value from spawning unbounded items). */
const MAX_KEYCHAIN_CHUNKS = 256;

/** Metadata for a chunked value: `n` chunks totalling `l` base64 characters. */
interface ChunkMeta {
  n: number;
  l: number;
}

/** The config-dir suffix the CLI appends to the credential service name: `-` + the first 8 hex
 *  chars of sha256(configDir), the config dir NFC-normalized. Empty when the default config dir is
 *  in use. Mirrors the CLI's derivation exactly: CLAUDE_SECURESTORAGE_CONFIG_DIR wins when it is
 *  set (an empty string means "default, no suffix"); otherwise CLAUDE_CONFIG_DIR both selects the
 *  suffix and supplies the path to hash. The CLI hashes the RESOLVED config dir; an absolute
 *  CLAUDE_CONFIG_DIR (the normal case) resolves to itself, so the raw NFC value is hashed here. */
function credentialServiceConfigSuffix(env: NodeJS.ProcessEnv): string {
  const secure = env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    if (secure.length === 0) return '';
    return `-${sha256Hex(secure.normalize('NFC')).slice(0, 8)}`;
  }
  const config = env.CLAUDE_CONFIG_DIR;
  if (!config) return '';
  return `-${sha256Hex(config.normalize('NFC')).slice(0, 8)}`;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** The default service name for the current CLI's item: the base name plus any config-dir suffix. */
function cliCredentialService(env: NodeJS.ProcessEnv): string {
  return `${CLAUDE_CLI_KEYCHAIN_SERVICE}${credentialServiceConfigSuffix(env)}`;
}

/** The legacy (pre-`-credentials`) service name: the un-suffixed base plus the SAME config-dir
 *  suffix the current item carries, matching the CLI's own legacy read
 *  (`security find-generic-password -a claude-code-user -w -s <un-suffixed service>`). */
function cliLegacyCredentialService(env: NodeJS.ProcessEnv): string {
  return `${CLAUDE_CLI_LEGACY_KEYCHAIN_SERVICE}${credentialServiceConfigSuffix(env)}`;
}

/** The legacy Keychain target the channel reads as a fallback: the un-suffixed service (with the
 *  same config-dir suffix as the primary) under the CLI's fixed `claude-code-user` account. There is
 *  no env override here — a pre-`-credentials` item only ever lived at this derived location, and the
 *  primary-target overrides address the CURRENT item, not the historical one. `env` is injected for
 *  testability. */
export function resolveClaudeCliLegacyKeychainTarget(env: NodeJS.ProcessEnv = process.env): {
  service: string;
  account: string;
} {
  return { service: cliLegacyCredentialService(env), account: CLAUDE_CLI_KEYCHAIN_ACCOUNT };
}

/** Effective service/account for the CLI's live Keychain item, applying operator env overrides over
 *  the derived defaults: if the CLI ever changes the item name, the operator corrects it with an
 *  env var instead of waiting on a code change. Used by the live-channel factory
 *  (`defaultLiveCredentialChannel`) to construct the channel; callers that need to REPORT the target
 *  (e.g. `cctl doctor`) read it off the constructed channel's `.target` instead of calling this a
 *  second time, so the two can never drift apart. `env` is injected for testability; unset keys
 *  fall back to the derived service and the CLI's fixed account. */
export function resolveClaudeCliKeychainTarget(env: NodeJS.ProcessEnv = process.env): {
  service: string;
  account: string;
} {
  // Trim first: a set-but-blank-or-whitespace override (`export CLAUDE_CLI_KEYCHAIN_SERVICE=`,
  // or a stray space from a copy-pasted config line) is an operator slip, not an intentional
  // empty item name — fall back to the default there too. `||` (not `??`) then treats the
  // trimmed-empty result the same as unset. An empty/blank service or account is never a valid
  // `security(1)` target, so this can only help.
  const service = env.CLAUDE_CLI_KEYCHAIN_SERVICE?.trim();
  const account = env.CLAUDE_CLI_KEYCHAIN_ACCOUNT?.trim();
  return {
    service: service || cliCredentialService(env),
    account: account || CLAUDE_CLI_KEYCHAIN_ACCOUNT,
  };
}

// --- item-level `security(1)` operations -----------------------------------------------
// One generic-password item each. The same hygiene rule as the vault key: reads take only
// service/account on argv, writes ride the value through `security -i` STDIN, deletes carry no
// secret so they go on argv directly.

/** Read one item's value (trimmed), or `undefined` when the item does not exist. */
async function readKeychainItem(
  run: ExecRunner,
  service: string,
  account: string,
): Promise<string | undefined> {
  try {
    const out = await run('security', [
      'find-generic-password',
      '-s',
      service,
      '-a',
      account,
      '-w',
    ]);
    return out.trim();
  } catch (err) {
    if (isNotFound(err)) return undefined;
    throw new VaultError('failed to read a live-credential Keychain item', { cause: err });
  }
}

/** Upsert one item's value. `-U` replaces an existing item so a rewrite never has to delete first. */
async function writeKeychainItem(
  run: ExecRunner,
  service: string,
  account: string,
  value: string,
): Promise<void> {
  try {
    await run(
      'security',
      ['-i'],
      `add-generic-password -U -s ${quoteSecurityArg(service)} -a ${quoteSecurityArg(account)} -w ${quoteSecurityArg(value)}\n`,
    );
  } catch (err) {
    throw new VaultError('failed to write a live-credential Keychain item', { cause: err });
  }
}

/** Delete one item; an item that is already gone is success, not a failure. */
async function deleteKeychainItem(
  run: ExecRunner,
  service: string,
  account: string,
): Promise<void> {
  try {
    await run('security', ['delete-generic-password', '-s', service, '-a', account]);
  } catch (err) {
    if (isNotFound(err)) return;
    throw new VaultError('failed to delete a live-credential Keychain item', { cause: err });
  }
}

// The chunk set names its parts by suffixing the base account: `#m` metadata, `#p` an in-progress
// marker, `#<i>` each chunk. These live under the SAME service as the base item.
const metadataAccount = (account: string): string => `${account}#m`;
const pendingAccount = (account: string): string => `${account}#p`;
const chunkAccount = (account: string, index: number): string => `${account}#${index}`;

/** Parse a metadata item's JSON into {@link ChunkMeta}, applying the CLI's exact bounds. Returns
 *  `undefined` for anything malformed (bad JSON, non-integer or out-of-range `n`/`l`). */
function parseChunkMeta(raw: string): ChunkMeta | undefined {
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof obj !== 'object' || obj === null) return undefined;
  const { n, l } = obj as { n?: unknown; l?: unknown };
  if (
    typeof n === 'number' &&
    typeof l === 'number' &&
    Number.isInteger(n) &&
    Number.isInteger(l) &&
    n > 0 &&
    n <= MAX_KEYCHAIN_CHUNKS &&
    l > 0 &&
    l <= n * CHUNK_THRESHOLD_BYTES
  ) {
    return { n, l };
  }
  return undefined;
}

/** Standard (not URL-safe) base64: what the chunk set must decode from. Empty is allowed by the
 *  predicate but never reached because a chunk set always has `l > 0`. */
function isStandardBase64(value: string): boolean {
  return value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/** `find-generic-password -w` prints hex instead of text when the value has bytes it deems
 *  non-printable; the stored JSON shouldn't, but tolerate both. Convert only when the text cannot
 *  already be the JSON it should be — never applied to a base64 chunk, which is not JSON. */
function decodeKeychainJsonText(raw: string): string {
  if (!raw.startsWith('{') && /^[0-9a-f]+$/i.test(raw) && raw.length % 2 === 0) {
    return Buffer.from(raw, 'hex').toString('utf8');
  }
  return raw;
}

/**
 * Read the stored value for a target, reassembling the CLI's chunk layout. A metadata item present
 * but broken (corrupt JSON, missing chunk, wrong length, non-base64) is a corrupt credential and
 * surfaces as a typed {@link VaultError} rather than silently reading as "logged out". No metadata
 * item means the value, if any, is a single unchunked item holding the raw JSON.
 */
export async function readChunkedValue(
  run: ExecRunner,
  target: { service: string; account: string },
): Promise<string | undefined> {
  const { service, account } = target;
  const metaRaw = await readKeychainItem(run, service, metadataAccount(account));
  if (metaRaw === undefined) {
    const plain = await readKeychainItem(run, service, account);
    return plain === undefined ? undefined : decodeKeychainJsonText(plain);
  }
  const meta = parseChunkMeta(metaRaw);
  if (!meta) throw new VaultError('live-credential Keychain metadata is corrupt');
  const chunks = await Promise.all(
    Array.from({ length: meta.n }, (_unused, i) =>
      readKeychainItem(run, service, chunkAccount(account, i)),
    ),
  );
  if (chunks.some((chunk) => chunk === undefined)) {
    throw new VaultError('live-credential Keychain chunk set is missing a chunk');
  }
  const joined = chunks.join('');
  if (joined.length !== meta.l) {
    throw new VaultError(
      `live-credential Keychain chunk set is the wrong length (${joined.length} of ${meta.l})`,
    );
  }
  if (!isStandardBase64(joined)) {
    throw new VaultError('live-credential Keychain chunk set is not valid base64');
  }
  return Buffer.from(joined, 'base64').toString('utf8');
}

/** Read metadata leniently for the WRITE path: a corrupt (or absent) metadata item just means
 *  "no prior chunk set to clean up", so a fresh write is never blocked by old corruption. */
async function readChunkMetaLoose(
  run: ExecRunner,
  target: { service: string; account: string },
): Promise<ChunkMeta | undefined> {
  const raw = await readKeychainItem(run, target.service, metadataAccount(target.account));
  return raw === undefined ? undefined : parseChunkMeta(raw);
}

/**
 * Write a value in the CLI's layout, cleaning up any prior layout it replaces:
 *  - at/under the threshold → one unchunked item holding the raw JSON, then tear down a prior
 *    chunk set (metadata deleted first, so the plain item becomes authoritative, then the chunks);
 *  - over the threshold → base64 the value, write the chunks, then the metadata item LAST (a reader
 *    keys off the metadata, so it never observes a pointer to a half-written set), then delete the
 *    now-stale unchunked item and any higher-index chunks a larger previous set left behind.
 * The `#p` marker brackets a rewrite so a crash mid-cleanup leaves a breadcrumb rather than a
 * silently truncated set.
 */
export async function writeChunkedValue(
  run: ExecRunner,
  target: { service: string; account: string },
  value: string,
): Promise<void> {
  const { service, account } = target;
  const prior = await readChunkMetaLoose(run, target);
  const byteLength = Buffer.byteLength(value, 'utf8');

  if (byteLength <= CHUNK_THRESHOLD_BYTES) {
    await writeKeychainItem(run, service, account, value);
    if (prior) {
      await writeKeychainItem(run, service, pendingAccount(account), String(prior.n));
      await deleteKeychainItem(run, service, metadataAccount(account));
      await Promise.allSettled(
        Array.from({ length: prior.n }, (_unused, i) =>
          deleteKeychainItem(run, service, chunkAccount(account, i)),
        ),
      );
      await deleteKeychainItem(run, service, pendingAccount(account)).catch(() => {});
    }
    return;
  }

  const encoded = Buffer.from(value, 'utf8').toString('base64');
  const count = Math.ceil(encoded.length / CHUNK_THRESHOLD_BYTES);
  if (count > MAX_KEYCHAIN_CHUNKS) {
    throw new VaultError(`live credentials are too large for the Keychain (${byteLength} bytes)`);
  }
  await writeKeychainItem(
    run,
    service,
    pendingAccount(account),
    String(Math.max(prior?.n ?? 0, count)),
  );
  await Promise.all(
    Array.from({ length: count }, (_unused, i) =>
      writeKeychainItem(
        run,
        service,
        chunkAccount(account, i),
        encoded.slice(i * CHUNK_THRESHOLD_BYTES, (i + 1) * CHUNK_THRESHOLD_BYTES),
      ),
    ),
  );
  await writeKeychainItem(
    run,
    service,
    metadataAccount(account),
    JSON.stringify({ n: count, l: encoded.length }),
  );
  const cleanup = [deleteKeychainItem(run, service, account)];
  for (let i = count; i < (prior?.n ?? 0); i++) {
    cleanup.push(deleteKeychainItem(run, service, chunkAccount(account, i)));
  }
  await Promise.allSettled(cleanup);
  await deleteKeychainItem(run, service, pendingAccount(account)).catch(() => {});
}

/**
 * Live-credential channel backed by the Claude CLI's macOS Keychain item. Behavior mirrors the file
 * channel's SURGICAL rule: read the existing payload, replace exactly the `claudeAiOauth` block,
 * write the rest back untouched — and additionally preserve the CLI's payload SHAPE:
 *   wrapped — `{"claudeAiOauth":{...}, ...}` (the `.credentials.json` shape), or
 *   bare    — the oauth block itself at top level.
 * The primary item follows the current CLI's chunked layout; a missing item reads as `undefined`
 * ("nobody logged in"). If the primary is absent, a legacy item (older CLIs' unchunked item under
 * the un-suffixed service and the same fixed account) is read as a fallback.
 */
export class KeychainCredentialChannel implements LiveCredentialChannel {
  /** The exact service/account this instance reads and writes. Public (not just internal state) so
   *  a caller — `cctl doctor` in particular — can report the EXACT target that will actually be hit,
   *  instead of recomputing it via a second, independent call that could drift out of sync with
   *  what this channel was actually constructed with. */
  readonly target: { service: string; account: string };
  /** Read-only fallback for pre-`-credentials` CLIs: a single unchunked item under the un-suffixed
   *  service and the same fixed `claude-code-user` account as the primary. Never written to. */
  private readonly legacyTarget: { service: string; account: string };
  private readonly run: ExecRunner;

  constructor(options?: { service?: string; account?: string; run?: ExecRunner }) {
    const resolved = resolveClaudeCliKeychainTarget();
    this.target = {
      service: options?.service ?? resolved.service,
      account: options?.account ?? resolved.account,
    };
    // The legacy item was never keyed by the login username; it used the un-suffixed service with
    // the same fixed account. Derived from the process env directly (not the primary override), so
    // it points at the CLI's historical location regardless of any primary-target override.
    this.legacyTarget = resolveClaudeCliLegacyKeychainTarget();
    this.run = options?.run ?? defaultExecRunner;
  }

  async readLiveCredentials(): Promise<ClaudeOauth | undefined> {
    const primary = extractOauthBlock(await this.readObject(this.target));
    if (primary !== undefined) return primary;
    // Fall back to the legacy item only when the primary is genuinely absent — a corrupt primary
    // throws in readObject above and must not be masked. Skip the redundant read when overrides
    // made the two targets identical.
    if (!sameTarget(this.target, this.legacyTarget)) {
      const legacy = extractOauthBlock(await this.readObject(this.legacyTarget));
      if (legacy !== undefined) return legacy;
    }
    return undefined;
  }

  async writeLiveCredentials(oauth: ClaudeOauth): Promise<void> {
    // Read the primary first so a value that grows past the threshold reuses the existing siblings
    // and the chunk cleanup fires against the right prior layout. A CORRUPT existing item (bad
    // chunk metadata, a missing chunk, non-JSON) must never block this write: that is precisely the
    // state a heal needs to recover from, and the write is what heals it. readObject throws on any
    // such corruption, so treat a failed read as "no usable prior value" and fall through to the
    // canonical wrapped shape — matching the CLI's own write, which reads metadata leniently and
    // overwrites unconditionally. writeChunkedValue then re-derives and tears down the prior layout.
    let existing: unknown;
    try {
      existing = await this.readObject(this.target);
    } catch {
      existing = undefined;
    }
    // Preserve the CLI's shape: only wrap when the existing payload wraps (or nothing exists yet,
    // where the .credentials.json-compatible wrapped shape is the safer canonical form).
    const next =
      existing === undefined || (isObject(existing) && 'claudeAiOauth' in existing)
        ? { ...(isObject(existing) ? existing : {}), claudeAiOauth: oauth }
        : oauth;
    await writeChunkedValue(this.run, this.target, JSON.stringify(next));
  }

  /** The item's stored value parsed as JSON, or `undefined` when the item does not exist. */
  private async readObject(target: { service: string; account: string }): Promise<unknown> {
    const raw = await readChunkedValue(this.run, target);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw) as unknown;
    } catch (err) {
      throw new VaultError('live-credential Keychain item is not JSON', { cause: err });
    }
  }
}

/** Pull the `claudeAiOauth` block from either payload shape, or `undefined` when it is not a usable
 *  credential. */
function extractOauthBlock(payload: unknown): ClaudeOauth | undefined {
  if (payload === undefined) return undefined;
  const block = isObject(payload) && 'claudeAiOauth' in payload ? payload.claudeAiOauth : payload;
  return isOauthShape(block) ? block : undefined;
}

function sameTarget(
  a: { service: string; account: string },
  b: { service: string; account: string },
): boolean {
  return a.service === b.service && a.account === b.account;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOauthShape(value: unknown): value is ClaudeOauth {
  return (
    isObject(value) &&
    typeof value.accessToken === 'string' &&
    typeof value.refreshToken === 'string' &&
    typeof value.expiresAt === 'number'
  );
}
