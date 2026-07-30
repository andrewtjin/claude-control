import { describe, it, expect } from 'vitest';
import { defaultLiveCredentialChannel, defaultProtector } from './protector.js';
import { DpapiProtector } from './dpapi.js';
import {
  KeychainCredentialChannel,
  KeychainProtector,
  resolveClaudeCliKeychainTarget,
  CLAUDE_CLI_KEYCHAIN_SERVICE,
} from './keychain.js';
import { FileKeyProtector } from './fileKey.js';
import { FileCredentialChannel } from './credentialStore.js';
import { sandboxPaths } from './paths.js';
import { userInfo } from 'node:os';

describe('defaultProtector', () => {
  it('dispatches win32 → DPAPI and darwin → Keychain', () => {
    expect(defaultProtector('win32')).toBeInstanceOf(DpapiProtector);
    expect(defaultProtector('darwin')).toBeInstanceOf(KeychainProtector);
  });

  it('gives every other platform the file-key protector (linux, the BSDs)', () => {
    // Construction is lazy — no key file is touched by the dispatch itself.
    expect(defaultProtector('linux')).toBeInstanceOf(FileKeyProtector);
    expect(defaultProtector('freebsd')).toBeInstanceOf(FileKeyProtector);
  });
});

describe('defaultLiveCredentialChannel', () => {
  const paths = sandboxPaths('root');

  it('uses the Keychain channel on darwin and the file channel elsewhere', () => {
    expect(defaultLiveCredentialChannel(paths, 'darwin')).toBeInstanceOf(KeychainCredentialChannel);
    expect(defaultLiveCredentialChannel(paths, 'win32')).toBeInstanceOf(FileCredentialChannel);
    expect(defaultLiveCredentialChannel(paths, 'linux')).toBeInstanceOf(FileCredentialChannel);
  });

  it('threads an env override all the way to the constructed channel', () => {
    // The wiring under test: defaultLiveCredentialChannel -> resolveClaudeCliKeychainTarget(env)
    // -> KeychainCredentialChannel's constructor -> its public `target`. Asserting only
    // `instanceof KeychainCredentialChannel` (above) cannot catch a broken link anywhere in that
    // chain — an operator's CLAUDE_CLI_KEYCHAIN_SERVICE override could silently fail to reach
    // the channel and every existing assertion would still pass. This one can't.
    const env = {
      CLAUDE_CLI_KEYCHAIN_SERVICE: 'Custom-Item',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: 'alt-user',
    };
    const channel = defaultLiveCredentialChannel(paths, 'darwin', env) as KeychainCredentialChannel;
    expect(channel.target).toEqual({ service: 'Custom-Item', account: 'alt-user' });
  });

  it('defaults the channel target to the shipped service and the login user with no env', () => {
    const channel = defaultLiveCredentialChannel(paths, 'darwin', {}) as KeychainCredentialChannel;
    expect(channel.target).toEqual({
      service: CLAUDE_CLI_KEYCHAIN_SERVICE,
      account: userInfo().username,
    });
  });
});

describe('resolveClaudeCliKeychainTarget', () => {
  it('defaults to the shipped service and the login user when env is unset', () => {
    const t = resolveClaudeCliKeychainTarget({});
    expect(t.service).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(t.account).toBe(userInfo().username);
  });

  it('applies CLAUDE_CLI_KEYCHAIN_SERVICE / _ACCOUNT overrides', () => {
    const t = resolveClaudeCliKeychainTarget({
      CLAUDE_CLI_KEYCHAIN_SERVICE: 'Custom-Item',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: 'alt-user',
    });
    expect(t).toEqual({ service: 'Custom-Item', account: 'alt-user' });
  });

  it('treats a set-but-blank override as unset (falls back to defaults)', () => {
    const t = resolveClaudeCliKeychainTarget({
      CLAUDE_CLI_KEYCHAIN_SERVICE: '',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: '',
    });
    expect(t.service).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(t.account).toBe(userInfo().username);
  });

  it('treats a whitespace-only override as unset too (not just a bare empty string)', () => {
    const t = resolveClaudeCliKeychainTarget({
      CLAUDE_CLI_KEYCHAIN_SERVICE: '   ',
      CLAUDE_CLI_KEYCHAIN_ACCOUNT: '\t',
    });
    expect(t.service).toBe(CLAUDE_CLI_KEYCHAIN_SERVICE);
    expect(t.account).toBe(userInfo().username);
  });
});
