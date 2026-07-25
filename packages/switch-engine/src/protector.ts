// Platform dispatch for the two platform-dependent seams: how vault blobs are encrypted at
// rest, and where the live `claudeAiOauth` block lives. Composition roots (engine default,
// daemon, doctor) call these instead of hardcoding a platform's implementation, so adding a
// platform is one new case here — callers never change.

import { DpapiProtector, type Protector } from './dpapi.js';
import { KeychainCredentialChannel, KeychainProtector } from './keychain.js';
import { FileKeyProtector, FileKeySource } from './fileKey.js';
import { FileCredentialChannel, type LiveCredentialChannel } from './credentialStore.js';
import { defaultVaultKeyPath, type Paths } from './paths.js';

/** The credential-at-rest protector for this platform:
 *  win32 → DPAPI (PowerShell ProtectedData) · darwin → login-Keychain key + AES-256-GCM ·
 *  everything else (linux incl. WSL2, the BSDs) → machine-local key file + AES-256-GCM
 *  (fileKey.ts explains why no OS secret store can be assumed off win32/darwin).
 *  `vaultKeyPath` matters only on the file-key branch: production takes the default,
 *  tests inject a sandbox path so no real key file is ever touched. */
export function defaultProtector(
  platform: NodeJS.Platform = process.platform,
  vaultKeyPath: string = defaultVaultKeyPath(process.env, platform),
): Protector {
  switch (platform) {
    case 'win32':
      return new DpapiProtector();
    case 'darwin':
      return new KeychainProtector();
    default:
      // The dispatch platform rides along so the protector's own win32/darwin downgrade
      // guard judges the platform this factory chose, not the machine tests run on.
      return new FileKeyProtector(new FileKeySource(vaultKeyPath), platform);
  }
}

/** Where this platform's LIVE credentials live: darwin → the CLI's Keychain item; everywhere
 *  else → `<claudeDir>/.credentials.json`. Unknown platforms get the file channel too — the
 *  file location is the CLI's documented Linux behavior, and reading it can't destroy
 *  anything (the protector above is the load-bearing platform gate). */
export function defaultLiveCredentialChannel(
  paths: Paths,
  platform: NodeJS.Platform = process.platform,
): LiveCredentialChannel {
  return platform === 'darwin'
    ? new KeychainCredentialChannel()
    : new FileCredentialChannel(paths.credentialsPath);
}
