// Platform dispatch for the two platform-dependent seams: how vault blobs are encrypted at
// rest, and where the live `claudeAiOauth` block lives. Composition roots (engine default,
// daemon, doctor) call these instead of hardcoding a platform's implementation, so adding a
// platform is one new case here — callers never change.

import { DpapiProtector, type Protector } from './dpapi.js';
import {
  KeychainCredentialChannel,
  KeychainProtector,
  resolveClaudeCliKeychainTarget,
} from './keychain.js';
import { FileCredentialChannel, type LiveCredentialChannel } from './credentialStore.js';
import { VaultError } from './errors.js';
import type { Paths } from './paths.js';

/** The credential-at-rest protector for this platform:
 *  win32 → DPAPI (PowerShell ProtectedData) · darwin → login-Keychain key + AES-256-GCM.
 *  Anything else throws a VaultError naming the gap — `cctl doctor` surfaces this as the
 *  platform report instead of failing silently (README "Platform" contract). */
export function defaultProtector(platform: NodeJS.Platform = process.platform): Protector {
  switch (platform) {
    case 'win32':
      return new DpapiProtector();
    case 'darwin':
      return new KeychainProtector();
    default:
      throw new VaultError(
        `no credential-at-rest protector for platform "${platform}" — supported: win32 (DPAPI), darwin (Keychain)`,
      );
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
  if (platform === 'darwin') {
    // Operator env overrides (documented in the mac wet-gate runbook) let an A1 item-name/account
    // miss be corrected without a code change; unset → the shipped defaults, identical to before.
    const { service, account } = resolveClaudeCliKeychainTarget();
    return new KeychainCredentialChannel({ service, account });
  }
  return new FileCredentialChannel(paths.credentialsPath);
}
