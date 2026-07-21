// macOS credential-at-rest protection and live-credential access via the login Keychain.
//
// Two distinct jobs live here because both talk to `security(1)` and share its hygiene rules:
//
//  1. VAULT protection (our storage): a random 256-bit key is kept as a generic password in
//     the user's login Keychain, and vault blobs are AES-256-GCM encrypted with it in-process
//     (node:crypto). Same threat model as DPAPI on Windows: a stolen vault directory is
//     useless without the owner's login keychain.
//
//  2. LIVE credentials (Claude Code's storage): on macOS the CLI keeps its `claudeAiOauth`
//     block in the login Keychain — NOT in `<claudeDir>/.credentials.json` — so an account
//     switch must content-swap the Keychain item instead of the file.
//
// Hygiene rule shared with dpapi.ts: SECRETS NEVER APPEAR ON ARGV. Reads are safe (`security
// find-generic-password -w` takes only service/account on argv and prints the secret on
// stdout). Writes go through `security -i`, which reads whole commands from STDIN — the
// secret rides inside the stdin line, never in the process table.
//
// ⚠ WET-GATE NOTICE: everything touching the REAL `security(1)` or the REAL mac CLI is
// unverified until `claude-control-orchestrator/tasks/mac-wet-gate-runbook.md` (sibling repo)
// runs on an actual Mac (assumptions A1-A4 in the mac-compatibility plan). The logic below is
// unit-tested against a fake runner only.

import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import { VaultError } from './errors.js';
import type { Protector } from './dpapi.js';
import type { ClaudeOauth } from './types.js';
import type { LiveCredentialChannel } from './credentialStore.js';

/** How this module shells out. Injected so every code path unit-tests on any platform.
 *  Returns stdout; MUST throw on a non-zero exit (execFileSync's native behavior). */
export type ExecRunner = (file: string, args: string[], input?: string) => string;

/** Production runner. stderr is piped so `security`'s error text lands in thrown errors
 *  (same rationale as dpapi.ts's runPowerShell) and never on the parent console. */
export const defaultExecRunner: ExecRunner = (file, args, input) =>
  execFileSync(file, args, {
    input,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

/** `security -i` tokenizes stdin lines like a shell: to pass an arbitrary string as one
 *  argument it must be double-quoted with `\` and `"` escaped. (Wet-gate assumption: this
 *  matches the real parser — exercised by the runbook before first real switch.) */
function quoteSecurityArg(value: string): string {
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
 * AES-256-GCM protector over an injected 32-byte key. Pure node:crypto — unit-testable on
 * every platform. Blob format: `aesgcm:` + base64( iv(12) ‖ authTag(16) ‖ ciphertext ), so
 * tampering with ANY byte fails authentication rather than yielding garbage plaintext.
 */
export class AesGcmProtector implements Protector {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new VaultError('AES-256-GCM requires a 32-byte key');
  }

  protect(plaintext: Buffer): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    return `aesgcm:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64')}`;
  }

  unprotect(blob: string): Buffer {
    if (!blob.startsWith('aesgcm:')) {
      throw new VaultError('blob was not produced by AesGcmProtector');
    }
    const raw = Buffer.from(blob.slice('aesgcm:'.length), 'base64');
    if (raw.length < 12 + 16) throw new VaultError('AES-GCM blob too short');
    const decipher = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    try {
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    } catch (err) {
      // Wrong key or tampered blob — GCM authentication failed either way.
      throw new VaultError('AES-GCM authentication failed (wrong key or corrupted blob)', {
        cause: err,
      });
    }
  }
}

/**
 * Get-or-create the vault key in the login Keychain. Read path puts only service/account on
 * argv; create path generates 32 random bytes and stores them hex-encoded via `security -i`
 * (`-U` upserts, so a concurrent first-run race converges on one of the two keys — both
 * writers re-read afterwards, so both end up using whichever write won).
 */
export class KeychainKeySource {
  constructor(private readonly run: ExecRunner = defaultExecRunner) {}

  getOrCreateKey(): Buffer {
    const existing = this.readKey();
    if (existing) return existing;
    const fresh = randomBytes(32).toString('hex');
    try {
      this.run(
        'security',
        ['-i'],
        `add-generic-password -U -s ${VAULT_KEY_SERVICE} -a ${VAULT_KEY_ACCOUNT} -w ${fresh}\n`,
      );
    } catch (err) {
      throw new VaultError('failed to store vault key in the login Keychain', { cause: err });
    }
    // Re-read instead of trusting our value: if a concurrent creator won the -U upsert race,
    // the keychain's copy is the truth.
    const stored = this.readKey();
    if (!stored) throw new VaultError('vault key vanished after Keychain write');
    return stored;
  }

  private readKey(): Buffer | undefined {
    let out: string;
    try {
      out = this.run('security', [
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

  private delegate(): AesGcmProtector {
    if (this.platform !== 'darwin') {
      throw new VaultError('Keychain protection is only available on macOS');
    }
    this.inner ??= new AesGcmProtector(this.keySource.getOrCreateKey());
    return this.inner;
  }

  protect(plaintext: Buffer): string {
    return this.delegate().protect(plaintext);
  }

  unprotect(blob: string): Buffer {
    return this.delegate().unprotect(blob);
  }
}

// --- 2. Live credentials ---------------------------------------------------------------

/** The mac CLI's own Keychain item (wet-gate assumption A1). */
export const CLAUDE_CLI_KEYCHAIN_SERVICE = 'Claude Code-credentials';

/** Effective service/account for the CLI's live Keychain item, applying operator env overrides
 *  over the shipped defaults. Shared by the live-channel factory (`defaultLiveCredentialChannel`)
 *  and `cctl doctor` so both ACT ON and REPORT the same target — an A1 (item-name/account) miss
 *  becomes a config fix, not a code change. `env` is injected for testability; unset keys fall
 *  back to the default service and the login user, i.e. identical to constructing the channel
 *  with no options. These override names are the ones the mac wet-gate runbook documents. */
export function resolveClaudeCliKeychainTarget(env: NodeJS.ProcessEnv = process.env): {
  service: string;
  account: string;
} {
  // `||` (not `??`): a set-but-blank override (`export CLAUDE_CLI_KEYCHAIN_SERVICE=`) is an
  // operator slip, not an intentional empty item name — fall back to the default there too. An
  // empty service/account is never a valid `security(1)` target, so this can only help.
  return {
    service: env.CLAUDE_CLI_KEYCHAIN_SERVICE || CLAUDE_CLI_KEYCHAIN_SERVICE,
    account: env.CLAUDE_CLI_KEYCHAIN_ACCOUNT || userInfo().username,
  };
}

/**
 * Live-credential channel backed by the Claude CLI's macOS Keychain item. Behavior mirrors
 * the file channel's SURGICAL rule: read the existing payload, replace exactly the
 * `claudeAiOauth` block, write the rest back untouched — and additionally PRESERVE THE
 * CLI'S PAYLOAD SHAPE, whichever it turns out to be (wet-gate assumption A2):
 *   wrapped — `{"claudeAiOauth":{...}, ...}` (the `.credentials.json` shape), or
 *   bare    — the oauth block itself at top level.
 * A missing item reads as `undefined` ("nobody logged in"), exactly like a missing file.
 */
export class KeychainCredentialChannel implements LiveCredentialChannel {
  private readonly service: string;
  private readonly account: string;
  private readonly run: ExecRunner;

  constructor(options?: { service?: string; account?: string; run?: ExecRunner }) {
    this.service = options?.service ?? CLAUDE_CLI_KEYCHAIN_SERVICE;
    this.account = options?.account ?? userInfo().username;
    this.run = options?.run ?? defaultExecRunner;
  }

  // The channel contract is Promise-based (the file channel genuinely awaits IO) but
  // `security(1)` is invoked synchronously — hence explicit resolve/reject, not async
  // (which the require-await lint rightly flags). Failures must REJECT, never throw
  // synchronously, so callers' promise handling sees them.
  readLiveCredentials(): Promise<ClaudeOauth | undefined> {
    try {
      const payload = this.readPayload();
      if (payload === undefined) return Promise.resolve(undefined);
      const block =
        isObject(payload) && 'claudeAiOauth' in payload ? payload.claudeAiOauth : payload;
      return Promise.resolve(isOauthShape(block) ? block : undefined);
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  writeLiveCredentials(oauth: ClaudeOauth): Promise<void> {
    try {
      const existing = this.readPayload();
      // Preserve the CLI's shape: only wrap when the existing payload wraps (or nothing
      // exists yet, where the .credentials.json-compatible wrapped shape is the safer
      // canonical form).
      const next =
        existing === undefined || (isObject(existing) && 'claudeAiOauth' in existing)
          ? { ...(isObject(existing) ? existing : {}), claudeAiOauth: oauth }
          : oauth;
      const json = JSON.stringify(next);
      try {
        this.run(
          'security',
          ['-i'],
          `add-generic-password -U -s ${quoteSecurityArg(this.service)} -a ${quoteSecurityArg(this.account)} -w ${quoteSecurityArg(json)}\n`,
        );
      } catch (err) {
        throw new VaultError('failed to write live credentials to the login Keychain', {
          cause: err,
        });
      }
      return Promise.resolve();
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  }

  /** Raw item payload parsed as JSON, or `undefined` when the item does not exist. */
  private readPayload(): unknown {
    let out: string;
    try {
      out = this.run('security', [
        'find-generic-password',
        '-s',
        this.service,
        '-a',
        this.account,
        '-w',
      ]);
    } catch (err) {
      if (isNotFound(err)) return undefined;
      throw new VaultError('failed to read live credentials from the login Keychain', {
        cause: err,
      });
    }
    let text = out.trim();
    // `find-generic-password -w` prints hex instead of text when the payload contains bytes
    // it deems non-printable — tolerate both encodings.
    if (!text.startsWith('{') && /^[0-9a-f]+$/i.test(text) && text.length % 2 === 0) {
      text = Buffer.from(text, 'hex').toString('utf8');
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new VaultError('live-credential Keychain item is not JSON', { cause: err });
    }
  }
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
