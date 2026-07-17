import { describe, it, expect } from 'vitest';
import { defaultLiveCredentialChannel, defaultProtector } from './protector.js';
import { DpapiProtector } from './dpapi.js';
import { KeychainCredentialChannel, KeychainProtector } from './keychain.js';
import { FileCredentialChannel } from './credentialStore.js';
import { VaultError } from './errors.js';
import { sandboxPaths } from './paths.js';

describe('defaultProtector', () => {
  it('dispatches win32 → DPAPI and darwin → Keychain', () => {
    expect(defaultProtector('win32')).toBeInstanceOf(DpapiProtector);
    expect(defaultProtector('darwin')).toBeInstanceOf(KeychainProtector);
  });

  it('throws a named-gap VaultError on unsupported platforms', () => {
    expect(() => defaultProtector('linux')).toThrow(VaultError);
    expect(() => defaultProtector('linux')).toThrow(/linux/);
    expect(() => defaultProtector('linux')).toThrow(/win32 \(DPAPI\), darwin \(Keychain\)/);
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
