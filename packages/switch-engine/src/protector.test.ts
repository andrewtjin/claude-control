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
});
