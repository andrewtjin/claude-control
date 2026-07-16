// Credential-at-rest protection.
//
// The vault encrypts every token bundle with Windows DPAPI (CurrentUser scope) so a stolen
// vault directory is useless on another machine or under another account. We reach DPAPI
// through PowerShell's ProtectedData rather than a native addon — no node-gyp, no build
// tools, works on a stock Windows box. Secrets are passed on stdin (never argv) so they do
// not appear in the process table, and the PowerShell body is delivered via -EncodedCommand
// to avoid any quoting/injection surface.

import { execFileSync } from 'node:child_process';
import { VaultError } from './errors.js';

/** Pluggable protector so tests can substitute an in-memory fake for logic that doesn't
 *  specifically exercise DPAPI. Both directions round-trip base64 <-> base64. */
export interface Protector {
  /** Encrypt raw bytes, returning an opaque base64 blob. */
  protect(plaintext: Buffer): string;
  /** Decrypt a base64 blob produced by {@link protect}, returning the original bytes. */
  unprotect(blob: string): Buffer;
}

// PowerShell bodies. Input and output are base64 on stdin/stdout to keep binary safe.
// $ProgressPreference silences Windows PowerShell 5.1's progress records ("Preparing
// modules for first use."), which it serializes as `#< CLIXML ...` noise on stderr whenever
// stderr is redirected — otherwise every DPAPI call spams the daemon/CLI console with it.
const PROTECT_PS = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$prot=[System.Security.Cryptography.ProtectedData]::Protect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($prot))
`;

const UNPROTECT_PS = `
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
Add-Type -AssemblyName System.Security
$in=[Console]::In.ReadToEnd().Trim()
$bytes=[Convert]::FromBase64String($in)
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

/** PowerShell wants -EncodedCommand as base64 of the UTF-16LE script text. */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function runPowerShell(script: string, inputBase64: string): string {
  try {
    const out = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      {
        input: inputBase64,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        // Pipe stderr instead of execFileSync's default inherit: whatever PowerShell still
        // writes there (CLIXML chatter, real error text) must land in the thrown error's
        // `stderr` field for diagnostics — never on the parent process's console.
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    return out.trim();
  } catch (err) {
    throw new VaultError('DPAPI operation failed', { cause: err });
  }
}

/** Real DPAPI protector backed by PowerShell ProtectedData (Windows only). */
export class DpapiProtector implements Protector {
  protect(plaintext: Buffer): string {
    if (process.platform !== 'win32') {
      throw new VaultError('DPAPI is only available on Windows');
    }
    return runPowerShell(PROTECT_PS, plaintext.toString('base64'));
  }

  unprotect(blob: string): Buffer {
    if (process.platform !== 'win32') {
      throw new VaultError('DPAPI is only available on Windows');
    }
    return Buffer.from(runPowerShell(UNPROTECT_PS, blob), 'base64');
  }
}

/**
 * NON-SECURE protector for tests and non-Windows logic runs. It merely base64-encodes,
 * providing the same round-trip contract without real encryption. Never use in production;
 * the name is deliberately alarming so it cannot be selected by accident.
 */
export class InsecurePassthroughProtector implements Protector {
  protect(plaintext: Buffer): string {
    return `insecure:${plaintext.toString('base64')}`;
  }

  unprotect(blob: string): Buffer {
    if (!blob.startsWith('insecure:')) {
      throw new VaultError('blob was not produced by InsecurePassthroughProtector');
    }
    return Buffer.from(blob.slice('insecure:'.length), 'base64');
  }
}
