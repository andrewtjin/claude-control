import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { userInfo } from 'node:os';
import {
  KeychainKeySource,
  KeychainProtector,
  KeychainCredentialChannel,
  resolveClaudeCliKeychainTarget,
  resolveClaudeCliLegacyKeychainTarget,
  readChunkedValue,
  writeChunkedValue,
  CHUNK_THRESHOLD_BYTES,
  CLAUDE_CLI_KEYCHAIN_SERVICE,
  CLAUDE_CLI_KEYCHAIN_ACCOUNT,
  CLAUDE_CLI_LEGACY_KEYCHAIN_SERVICE,
  VAULT_KEY_SERVICE,
  VAULT_KEY_ACCOUNT,
  type ExecRunner,
} from './keychain.js';
import { VaultError } from './errors.js';
import type { ClaudeOauth } from './types.js';

// --- Fake `security(1)` --------------------------------------------------------------------
// Simulates the subcommands we use — find-generic-password (read), `-i` add-generic-password
// (upsert), delete-generic-password (delete) — including the exit-44 "not found" stderr shape and
// the `-i` stdin command mode, while recording every argv and stdin payload for hygiene assertions.
// The store is keyed by "<service> <account>", the same pair Keychain generic passwords key on
// (kSecAttrService / kSecAttrAccount), so a chunk item ("<account>#<i>") is just another key.

interface SecurityCall {
  args: string[];
  input?: string | undefined;
}

/** The token following a flag, '' when absent — keeps the strict indexer happy. */
function argAfter(tokens: string[], flag: string): string {
  return tokens[tokens.indexOf(flag) + 1] ?? '';
}

function notFoundError(): Error & { stderr: string } {
  const err = new Error('security failed') as Error & { stderr: string };
  err.stderr = 'security: SecKeychainSearchCopyNext: The specified item could not be found.';
  return err;
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
      const value = store.get(keyOf(argAfter(args, '-s'), argAfter(args, '-a')));
      if (value === undefined) throw notFoundError();
      return value + '\n';
    }
    if (args[0] === 'delete-generic-password') {
      const key = keyOf(argAfter(args, '-s'), argAfter(args, '-a'));
      if (!store.has(key)) throw notFoundError();
      store.delete(key);
      return '';
    }
    if (args[0] === '-i') {
      // Parse the one stdin command line the way `security -i` tokenizes: whitespace-split
      // with double-quoted segments honoring \" and \\ escapes.
      const tokens = tokenize((input ?? '').trim());
      if (tokens[0] !== 'add-generic-password') throw new Error(`unexpected: ${tokens[0]}`);
      store.set(keyOf(argAfter(tokens, '-s'), argAfter(tokens, '-a')), argAfter(tokens, '-w'));
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

// --- resolveClaudeCliKeychainTarget --------------------------------------------------------
// The CLI derives the credential service as `Claude Code` + OAUTH_FILE_SUFFIX("") + `-credentials`
// + a config-dir suffix, and stores under the fixed account `claude-code-user`. From the CLI:
//   kJ(n="")=`Claude Code${OAUTH_FILE_SUFFIX}${n}${o}`, o = configDir customized
//     ? `-${sha256(NFC(configDir)).hex.slice(0,8)}` : "";   DN()="claude-code-user"
// CLAUDE_SECURESTORAGE_CONFIG_DIR wins when set (empty string => default, no suffix); otherwise
// CLAUDE_CONFIG_DIR both selects and supplies the path to hash.

describe('resolveClaudeCliKeychainTarget', () => {
  it('defaults to the un-suffixed service and the fixed account when no config dir is set', () => {
    const t = resolveClaudeCliKeychainTarget({});
    expect(t.service).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(t.account).toBe(CLAUDE_CLI_KEYCHAIN_ACCOUNT);
  });

  it('hashes CLAUDE_CONFIG_DIR into the service suffix', () => {
    const dir = '/Users/x/.claude-alt';
    const suffix = createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
    const t = resolveClaudeCliKeychainTarget({ CLAUDE_CONFIG_DIR: dir });
    expect(t.service).toBe(`${CLAUDE_CLI_KEYCHAIN_SERVICE}-${suffix}`);
  });

  it('prefers CLAUDE_SECURESTORAGE_CONFIG_DIR for the hash; empty string means default', () => {
    const dir = '/opt/secure-claude';
    const suffix = createHash('sha256').update(dir.normalize('NFC')).digest('hex').slice(0, 8);
    // Set-non-empty wins over CLAUDE_CONFIG_DIR entirely.
    expect(
      resolveClaudeCliKeychainTarget({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: dir,
        CLAUDE_CONFIG_DIR: '/somewhere/else',
      }).service,
    ).toBe(`${CLAUDE_CLI_KEYCHAIN_SERVICE}-${suffix}`);
    // Set-but-empty means "default config dir": no suffix, and it suppresses CLAUDE_CONFIG_DIR too.
    expect(
      resolveClaudeCliKeychainTarget({
        CLAUDE_SECURESTORAGE_CONFIG_DIR: '',
        CLAUDE_CONFIG_DIR: '/somewhere/else',
      }).service,
    ).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
  });

  it('honors explicit CLAUDE_CLI_KEYCHAIN_SERVICE/_ACCOUNT overrides, trimming blanks to defaults', () => {
    const overridden = resolveClaudeCliKeychainTarget({
      CLAUDE_CLI_KEYCHAIN_SERVICE: '  Custom-Item  ',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: 'alt-user',
      CLAUDE_CONFIG_DIR: '/ignored/when/service/is/overridden',
    });
    expect(overridden.service).toBe('Custom-Item');
    expect(overridden.account).toBe('alt-user');
    // A blank override is an operator slip, not an empty item name: fall back to the derived value.
    const blank = resolveClaudeCliKeychainTarget({
      CLAUDE_CLI_KEYCHAIN_SERVICE: '   ',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: '',
    });
    expect(blank.service).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(blank.account).toBe(CLAUDE_CLI_KEYCHAIN_ACCOUNT);
  });
});

// --- chunk layout: writeChunkedValue / readChunkedValue ------------------------------------
// The CLI's storage layer stores a value at/under 2400 UTF-8 bytes as one item holding the raw
// value; a larger value is base64-encoded and split into 2400-char chunk items ("<account>#<i>")
// plus a metadata item ("<account>#m") holding {n: chunkCount, l: base64Length}, written LAST so a
// reader keying off "#m" never sees a half-written set. A shrink deletes the stale chunks/metadata.

const TARGET = { service: 'svc', account: 'acct' };
const metaKey = `${TARGET.service} ${TARGET.account}#m`;
const plainKey = `${TARGET.service} ${TARGET.account}`;
const chunkKey = (i: number) => `${TARGET.service} ${TARGET.account}#${i}`;

/** One shared store + its runner, for layout assertions after a write. */
function rig(): { run: ExecRunner; store: Map<string, string> } {
  const store = new Map<string, string>();
  return { run: fakeSecurity(store).run, store };
}

describe('writeChunkedValue / readChunkedValue', () => {
  // The five sizes the layout must be exercised at: empty, just under, exactly at, just over the
  // threshold, and several chunks' worth.
  for (const bytes of [0, CHUNK_THRESHOLD_BYTES - 1, CHUNK_THRESHOLD_BYTES]) {
    it(`stores a ${bytes}-byte value UNCHUNKED and reads it back`, async () => {
      const { run, store } = rig();
      const value = 'x'.repeat(bytes);
      await writeChunkedValue(run, TARGET, value);
      // Unchunked: the plain item holds the raw value, and there is no metadata.
      expect(store.get(plainKey)).toBe(value);
      expect(store.has(metaKey)).toBe(false);
      expect(await readChunkedValue(run, TARGET)).toBe(value);
    });
  }

  for (const bytes of [CHUNK_THRESHOLD_BYTES + 1, CHUNK_THRESHOLD_BYTES * 3]) {
    it(`stores a ${bytes}-byte value CHUNKED (base64, metadata last) and reads it back`, async () => {
      const { run, store } = rig();
      const value = 'x'.repeat(bytes);
      await writeChunkedValue(run, TARGET, value);

      const encoded = Buffer.from(value, 'utf8').toString('base64');
      const count = Math.ceil(encoded.length / CHUNK_THRESHOLD_BYTES);
      // Metadata records the base64 length and chunk count; the unchunked item is gone.
      expect(JSON.parse(store.get(metaKey)!)).toEqual({ n: count, l: encoded.length });
      expect(store.has(plainKey)).toBe(false);
      // Chunks reassemble to the base64 of the value, none missing, no stray #p marker.
      const joined = Array.from({ length: count }, (_unused, i) => store.get(chunkKey(i))).join('');
      expect(joined).toBe(encoded);
      expect(store.has(`${TARGET.service} ${TARGET.account}#p`)).toBe(false);
      expect(await readChunkedValue(run, TARGET)).toBe(value);
    });
  }

  it('reads undefined when no item exists', async () => {
    const { run } = rig();
    expect(await readChunkedValue(run, TARGET)).toBeUndefined();
  });

  it('cleans up the old chunk set when a value shrinks below the threshold', async () => {
    const { run, store } = rig();
    const big = 'y'.repeat(CHUNK_THRESHOLD_BYTES * 3);
    await writeChunkedValue(run, TARGET, big);
    const bigCount = Math.ceil(
      Buffer.from(big, 'utf8').toString('base64').length / CHUNK_THRESHOLD_BYTES,
    );
    expect(store.has(metaKey)).toBe(true);

    const small = 'z'.repeat(10);
    await writeChunkedValue(run, TARGET, small);
    // The plain item is now authoritative; metadata, every old chunk and the #p marker are gone.
    expect(store.get(plainKey)).toBe(small);
    expect(store.has(metaKey)).toBe(false);
    for (let i = 0; i < bigCount; i++) expect(store.has(chunkKey(i))).toBe(false);
    expect(store.has(`${TARGET.service} ${TARGET.account}#p`)).toBe(false);
    expect(await readChunkedValue(run, TARGET)).toBe(small);
  });

  it('drops stale higher-index chunks when a chunked value shrinks to fewer chunks', async () => {
    const { run, store } = rig();
    await writeChunkedValue(run, TARGET, 'y'.repeat(CHUNK_THRESHOLD_BYTES * 3));
    const largeCount = Math.ceil(
      Buffer.from('y'.repeat(CHUNK_THRESHOLD_BYTES * 3), 'utf8').toString('base64').length /
        CHUNK_THRESHOLD_BYTES,
    );

    const smaller = 'w'.repeat(CHUNK_THRESHOLD_BYTES + 1);
    await writeChunkedValue(run, TARGET, smaller);
    const smallerCount = Math.ceil(
      Buffer.from(smaller, 'utf8').toString('base64').length / CHUNK_THRESHOLD_BYTES,
    );
    expect(smallerCount).toBeLessThan(largeCount);
    // Only the new chunks survive; the tail of the previous, larger set is deleted.
    for (let i = smallerCount; i < largeCount; i++) expect(store.has(chunkKey(i))).toBe(false);
    expect(await readChunkedValue(run, TARGET)).toBe(smaller);
  });

  // Corruption cases: each surfaces as a typed VaultError, never a crash or a silent "logged out".
  it('throws on corrupt (non-JSON) metadata', async () => {
    const { run, store } = rig();
    store.set(metaKey, 'not json');
    await expect(readChunkedValue(run, TARGET)).rejects.toThrow(VaultError);
  });

  it('throws on non-numeric chunk count in metadata', async () => {
    const { run, store } = rig();
    store.set(metaKey, JSON.stringify({ n: 'two', l: 8 }));
    await expect(readChunkedValue(run, TARGET)).rejects.toThrow(VaultError);
  });

  it('throws when a chunk is missing', async () => {
    const { run, store } = rig();
    store.set(metaKey, JSON.stringify({ n: 2, l: 8 }));
    store.set(chunkKey(0), 'YWJj'); // only #0, #1 absent
    await expect(readChunkedValue(run, TARGET)).rejects.toThrow(VaultError);
  });

  it('throws when the reassembled length disagrees with the metadata', async () => {
    const { run, store } = rig();
    store.set(metaKey, JSON.stringify({ n: 1, l: 10 }));
    store.set(chunkKey(0), 'YWJj'); // 4 chars, not 10
    await expect(readChunkedValue(run, TARGET)).rejects.toThrow(VaultError);
  });

  it('throws when the reassembled chunks are not valid base64', async () => {
    const { run, store } = rig();
    store.set(metaKey, JSON.stringify({ n: 1, l: 4 }));
    store.set(chunkKey(0), '!!!!'); // right length, not base64
    await expect(readChunkedValue(run, TARGET)).rejects.toThrow(VaultError);
  });
});

// --- KeychainCredentialChannel ---------------------------------------------------------------

const OAUTH: ClaudeOauth = { accessToken: 'at-1', refreshToken: 'rt-1', expiresAt: 123 };
const SERVICE = CLAUDE_CLI_KEYCHAIN_SERVICE;
const itemKey = `${SERVICE} tester`;

function channelWith(store: Map<string, string>) {
  const fake = fakeSecurity(store);
  return {
    channel: new KeychainCredentialChannel({ service: SERVICE, account: 'tester', run: fake.run }),
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

  it('reads a large chunked credential the CLI would have written', async () => {
    // A refresh token long enough to push the wrapped JSON past the threshold, forcing chunking.
    const big: ClaudeOauth = { ...OAUTH, refreshToken: 'r'.repeat(CHUNK_THRESHOLD_BYTES * 2) };
    const value = JSON.stringify({ claudeAiOauth: big });
    const store = new Map<string, string>();
    const write = fakeSecurity(store);
    await writeChunkedValue(write.run, { service: SERVICE, account: 'tester' }, value);
    const { channel } = channelWith(store);
    expect(await channel.readLiveCredentials()).toEqual(big);
  });

  it('round-trips a credential that grows past the threshold, then back', async () => {
    const { channel, store } = channelWith(new Map());
    const big: ClaudeOauth = { ...OAUTH, refreshToken: 'r'.repeat(CHUNK_THRESHOLD_BYTES * 2) };
    await channel.writeLiveCredentials(big);
    expect(store.has(`${itemKey}#m`)).toBe(true); // chunked
    expect(await channel.readLiveCredentials()).toEqual(big);

    await channel.writeLiveCredentials(OAUTH); // shrink back
    expect(store.has(`${itemKey}#m`)).toBe(false); // unchunked again
    expect(await channel.readLiveCredentials()).toEqual(OAUTH);
  });

  it('surfaces a corrupt chunked item as a VaultError (never a silent logout)', async () => {
    const store = new Map([[`${itemKey}#m`, JSON.stringify({ n: 2, l: 8 })]]); // metadata, no chunks
    const { channel } = channelWith(store);
    await expect(channel.readLiveCredentials()).rejects.toThrow(VaultError);
  });

  it('falls back to the legacy un-suffixed item (fixed account, never the login username)', async () => {
    // No CLI ever keyed the item by the login username. The pre-`-credentials` item lived at the
    // un-suffixed service under the same fixed claude-code-user account, and the CLI's own legacy
    // read is `security find-generic-password -a claude-code-user -w -s <un-suffixed service>`.
    // With the primary absent, the channel must resolve through that legacy target.
    const legacy = resolveClaudeCliLegacyKeychainTarget();
    const store = new Map([
      [`${legacy.service} ${legacy.account}`, JSON.stringify({ claudeAiOauth: OAUTH })],
    ]);
    const fake = fakeSecurity(store);
    // No service/account override: the channel derives both the primary and the legacy target.
    const channel = new KeychainCredentialChannel({ run: fake.run });
    expect(await channel.readLiveCredentials()).toEqual(OAUTH);
    // The legacy account is the CLI's fixed one, not the OS login user — the whole point of the fix.
    expect(legacy.account).toBe(CLAUDE_CLI_KEYCHAIN_ACCOUNT);
    expect(legacy.account).not.toBe(userInfo().username);
    // The legacy read hits the fixed account, and never the login username, on argv.
    const reads = fake.calls.filter((c) => c.args[0] === 'find-generic-password');
    expect(reads.some((c) => c.args.includes(CLAUDE_CLI_KEYCHAIN_ACCOUNT))).toBe(true);
    expect(reads.some((c) => c.args.includes(userInfo().username))).toBe(false);
  });

  it('derives the legacy service as the un-suffixed base plus the SAME config-dir suffix', () => {
    // The legacy item shares the primary's config-dir hash suffix; only the `-credentials` segment
    // is absent (the CLI's kJ("") vs kJ("-credentials")).
    const dir = '/Users/x/.config/claude';
    const suffix = createHash('sha256').update(dir).digest('hex').slice(0, 8);
    const legacy = resolveClaudeCliLegacyKeychainTarget({ CLAUDE_CONFIG_DIR: dir });
    const primary = resolveClaudeCliKeychainTarget({ CLAUDE_CONFIG_DIR: dir });
    expect(legacy.service).toBe(`${CLAUDE_CLI_LEGACY_KEYCHAIN_SERVICE}-${suffix}`);
    expect(primary.service).toBe(`${CLAUDE_CLI_KEYCHAIN_SERVICE}-${suffix}`);
    expect(legacy.account).toBe(CLAUDE_CLI_KEYCHAIN_ACCOUNT);
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
