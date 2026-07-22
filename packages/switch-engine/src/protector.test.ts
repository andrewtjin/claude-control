import { describe, it, expect } from 'vitest';
import { defaultLiveCredentialChannel, defaultProtector } from './protector.js';
import { DpapiProtector } from './dpapi.js';
import { KeychainCredentialChannel, KeychainProtector } from './keychain.js';
import { FileKeyProtector } from './fileKey.js';
import { FileCredentialChannel } from './credentialStore.js';
import { sandboxPaths } from './paths.js';

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
