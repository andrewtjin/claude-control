import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  KeychainKeySource,
  KeychainProtector,
  KeychainCredentialChannel,
  VAULT_KEY_SERVICE,
  VAULT_KEY_ACCOUNT,
  type ExecRunner,
} from './keychain.js';
import { VaultError } from './errors.js';
import type { ClaudeOauth } from './types.js';

// --- Fake `security(1)` --------------------------------------------------------------------
// Simulates the two subcommands we use, including the exit-44 "not found" stderr shape and
// the `-i` stdin command mode, while recording every argv and stdin payload for hygiene
// assertions.

interface SecurityCall {
  args: string[];
  input?: string | undefined;
}

/** The token following a flag, '' when absent — keeps the strict indexer happy. */
function argAfter(tokens: string[], flag: string): string {
  return tokens[tokens.indexOf(flag) + 1] ?? '';
}

function fakeSecurity(store: Map<string, string>): { run: ExecRunner; calls: SecurityCall[] } {
  const calls: SecurityCall[] = [];
  const keyOf = (service: string, account: string) => `${service} ${account}`;
  // Sync body wrapped into the async ExecRunner contract: throws become rejections.
  const run: ExecRunner = (file, args, input) => {
    try {
      return Promise.resolve(runSync(file, args, input));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };
  const runSync = (file: string, args: string[], input?: string): string => {
    calls.push({ args, input });
    if (file !== 'security') throw new Error(`unexpected binary: ${file}`);
    if (args[0] === 'find-generic-password') {
      const service = argAfter(args, '-s');
      const account = argAfter(args, '-a');
      const value = store.get(keyOf(service, account));
      if (value === undefined) {
        const err = new Error('security failed') as Error & { stderr: string };
        err.stderr = 'security: SecKeychainSearchCopyNext: The specified item could not be found.';
        throw err;
      }
      return value + '\n';
    }
    if (args[0] === '-i') {
      // Parse the one stdin command line the way `security -i` tokenizes: whitespace-split
      // with double-quoted segments honoring \" and \\ escapes.
      const line = (input ?? '').trim();
      const tokens = tokenize(line);
      if (tokens[0] !== 'add-generic-password') throw new Error(`unexpected: ${tokens[0]}`);
      const service = argAfter(tokens, '-s');
      const account = argAfter(tokens, '-a');
      const value = argAfter(tokens, '-w');
      store.set(keyOf(service, account), value);
      return '';
    }
    throw new Error(`unexpected security args: ${args.join(' ')}`);
  };
  return { run, calls };
}

/** Minimal shell-style tokenizer matching the quoting quoteSecurityArg produces. */
function tokenize(line: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (line[i] === ' ') i++;
    if (i >= line.length) break;
    let token = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\') i++;
        token += line[i++];
      }
      i++; // closing quote
    } else {
      while (i < line.length && line[i] !== ' ') token += line[i++];
    }
    tokens.push(token);
  }
  return tokens;
}

// --- KeychainKeySource ---------------------------------------------------------------------

describe('KeychainKeySource', () => {
  it('returns an existing key without writing', async () => {
    const hex = randomBytes(32).toString('hex');
    const store = new Map([[`${VAULT_KEY_SERVICE} ${VAULT_KEY_ACCOUNT}`, hex]]);
    const { run, calls } = fakeSecurity(store);

    const key = await new KeychainKeySource(run).getOrCreateKey();
    expect(key.toString('hex')).toBe(hex);
    expect(calls.every((c) => c.args[0] === 'find-generic-password')).toBe(true);
  });

  it('creates a key on first run and the SECRET RIDES STDIN, never argv', async () => {
    const store = new Map<string, string>();
    const { run, calls } = fakeSecurity(store);

    const key = await new KeychainKeySource(run).getOrCreateKey();
    expect(key.length).toBe(32);
    // The stored value round-trips through a subsequent read.
    expect((await new KeychainKeySource(run).getOrCreateKey()).equals(key)).toBe(true);

    const writes = calls.filter((c) => c.args[0] === '-i');
    expect(writes).toHaveLength(1);
    const hex = key.toString('hex');
    expect(writes[0]?.input).toContain(hex); // secret went via stdin...
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(hex); // ...and NEVER via argv
    }
  });

  it('rejects a malformed key found in the keychain instead of using it', async () => {
    const store = new Map([[`${VAULT_KEY_SERVICE} ${VAULT_KEY_ACCOUNT}`, 'not-hex!']]);
    const { run } = fakeSecurity(store);
    await expect(new KeychainKeySource(run).getOrCreateKey()).rejects.toThrow(VaultError);
  });

  it('propagates non-not-found keychain failures as VaultError', async () => {
    const run: ExecRunner = () => {
      const err = new Error('security failed') as Error & { stderr: string };
      err.stderr = 'security: SecKeychainCopyDefault: A keychain cannot be found.';
      return Promise.reject(err);
    };
    await expect(new KeychainKeySource(run).getOrCreateKey()).rejects.toThrow(VaultError);
  });
});

// --- KeychainProtector ---------------------------------------------------------------------

describe('KeychainProtector', () => {
  it('refuses to run off macOS (mirror of DpapiProtector win32 guard)', async () => {
    const { run } = fakeSecurity(new Map());
    const p = new KeychainProtector(new KeychainKeySource(run), 'win32');
    await expect(p.protect(Buffer.from('x'))).rejects.toThrow(/only available on macOS/);
    await expect(p.unprotect('aesgcm:AAAA')).rejects.toThrow(/only available on macOS/);
  });

  it('round-trips through the keychain-held key on darwin', async () => {
    const { run } = fakeSecurity(new Map());
    const p = new KeychainProtector(new KeychainKeySource(run), 'darwin');
    const secret = Buffer.from(JSON.stringify({ accessToken: 'a', refreshToken: 'b' }));
    expect((await p.unprotect(await p.protect(secret))).equals(secret)).toBe(true);
  });

  it('two protectors sharing one keychain interoperate (same stored key)', async () => {
    const store = new Map<string, string>();
    const a = new KeychainProtector(new KeychainKeySource(fakeSecurity(store).run), 'darwin');
    const b = new KeychainProtector(new KeychainKeySource(fakeSecurity(store).run), 'darwin');
    const secret = Buffer.from('shared');
    expect((await b.unprotect(await a.protect(secret))).equals(secret)).toBe(true);
  });
});

// --- KeychainCredentialChannel ---------------------------------------------------------------

const OAUTH: ClaudeOauth = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 123 };
const SERVICE = 'Claude Code-credentials';
const itemKey = `${SERVICE} tester`;

function channelWith(store: Map<string, string>) {
  const fake = fakeSecurity(store);
  return {
    channel: new KeychainCredentialChannel({ account: 'tester', run: fake.run }),
    calls: fake.calls,
    store,
  };
}

describe('KeychainCredentialChannel', () => {
  it('reads the wrapped (.credentials.json-shaped) payload', async () => {
    const { channel } = channelWith(
      new Map([[itemKey, JSON.stringify({ claudeAiOauth: OAUTH, other: 1 })]]),
    );
    expect(await channel.readLiveCredentials()).toEqual(OAUTH);
  });

  it('reads a bare oauth-block payload', async () => {
    const { channel } = channelWith(new Map([[itemKey, JSON.stringify(OAUTH)]]));
    expect(await channel.readLiveCredentials()).toEqual(OAUTH);
  });

  it('tolerates hex output from find-generic-password', async () => {
    const hex = Buffer.from(JSON.stringify({ claudeAiOauth: OAUTH }), 'utf8').toString('hex');
    const { channel } = channelWith(new Map([[itemKey, hex]]));
    expect(await channel.readLiveCredentials()).toEqual(OAUTH);
  });

  it('reads undefined when the item does not exist (= nobody logged in)', async () => {
    const { channel } = channelWith(new Map());
    expect(await channel.readLiveCredentials()).toBeUndefined();
  });

  it('write preserves sibling keys in a wrapped payload (surgical rule)', async () => {
    const { channel, store } = channelWith(
      new Map([[itemKey, JSON.stringify({ claudeAiOauth: OAUTH, scopes: ['x'] })]]),
    );
    const next: ClaudeOauth = { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 456 };
    await channel.writeLiveCredentials(next);
    expect(JSON.parse(store.get(itemKey)!)).toEqual({ claudeAiOauth: next, scopes: ['x'] });
  });

  it('write preserves the bare shape when the CLI used one', async () => {
    const { channel, store } = channelWith(new Map([[itemKey, JSON.stringify(OAUTH)]]));
    const next: ClaudeOauth = { accessToken: 'at-2', refreshToken: 'rt-2', expiresAt: 456 };
    await channel.writeLiveCredentials(next);
    expect(JSON.parse(store.get(itemKey)!)).toEqual(next);
  });

  it('write survives the quoting round-trip: JSON with quotes/spaces goes via stdin only', async () => {
    const { channel, calls, store } = channelWith(new Map());
    await channel.writeLiveCredentials(OAUTH);
    // The fake's tokenizer applies `security -i` quoting rules — the stored payload parsing
    // back exactly proves quoteSecurityArg's escaping is self-consistent.
    expect(JSON.parse(store.get(itemKey)!)).toEqual({ claudeAiOauth: OAUTH });
    const writes = calls.filter((c) => c.args[0] === '-i');
    expect(writes).toHaveLength(1);
    for (const call of calls) {
      expect(call.args.join(' ')).not.toContain(OAUTH.accessToken); // tokens never on argv
    }
  });

  it('surfaces a non-JSON keychain item as a VaultError, never silently', async () => {
    const { channel } = channelWith(new Map([[itemKey, 'not json at all']]));
    await expect(channel.readLiveCredentials()).rejects.toThrow(VaultError);
  });
});
