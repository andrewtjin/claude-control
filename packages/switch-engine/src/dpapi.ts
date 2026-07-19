// Credential-at-rest protection.
//
// The vault encrypts every token bundle with Windows DPAPI (CurrentUser scope) so a stolen
// vault directory is useless on another machine or under another account. We reach DPAPI
// through PowerShell's ProtectedData rather than a native addon — no node-gyp, no build
// tools, works on a stock Windows box. Secrets are passed on stdin (never argv) so they do
// not appear in the process table, and the PowerShell body is delivered via -EncodedCommand
// to avoid any quoting/injection surface.
//
// The Protector contract is ASYNC and must stay async: a PowerShell spawn costs hundreds of
// milliseconds to whole seconds on a loaded Windows box, and the daemon calls unprotect on
// every usage poll. Run synchronously (the original execFileSync design), each call froze the
// daemon's entire event loop for the spawn's lifetime — live-measured as 0.5–3.8s stalls on
// EVERY concurrent hook request, taxing every Claude Code tool call on the machine. Nothing
// that shells out may ever sit behind a synchronous interface here.

import { spawn } from 'node:child_process';
import { VaultError } from './errors.js';

/** Pluggable protector so tests can substitute an in-memory fake for logic that doesn't
 *  specifically exercise DPAPI. Both directions round-trip base64 <-> base64. */
export interface Protector {
  /** Encrypt raw bytes, returning an opaque base64 blob. */
  protect(plaintext: Buffer): Promise<string>;
  /** Decrypt a base64 blob produced by {@link protect}, returning the original bytes. */
  unprotect(blob: string): Promise<Buffer>;
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

/** Bound on captured stdout/stderr — a DPAPI blob for a token bundle is a few KB; anything
 *  approaching this is a malfunction, not data. */
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Spawn PowerShell asynchronously, feed `inputBase64` on stdin, and resolve with trimmed
 *  stdout. Rejects with a VaultError carrying the exit code and stderr text (PowerShell's
 *  CLIXML chatter or real error text) — never lets either land on the parent console. */
function runPowerShell(script: string, inputBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => {
      outBytes += chunk.length;
      if (outBytes <= MAX_OUTPUT_BYTES) out.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errOut.length < 64) errOut.push(chunk);
    });
    child.on('error', (err) => {
      reject(new VaultError('DPAPI operation failed', { cause: err }));
    });
    child.on('close', (code) => {
      if (code === 0 && outBytes <= MAX_OUTPUT_BYTES) {
        resolve(Buffer.concat(out).toString('utf8').trim());
        return;
      }
      const stderr = Buffer.concat(errOut).toString('utf8').slice(0, 2000);
      const detail =
        outBytes > MAX_OUTPUT_BYTES
          ? 'output exceeded sanity bound'
          : `exit code ${code ?? 'null'}`;
      reject(
        new VaultError('DPAPI operation failed', {
          cause: new Error(`powershell ${detail}${stderr ? `: ${stderr}` : ''}`),
        }),
      );
    });
    // A crashed child can close stdin before we finish writing — that surfaces via 'close'
    // above with the real cause, so the write error itself is deliberately swallowed.
    child.stdin.on('error', () => {});
    child.stdin.end(inputBase64);
  });
}

/** Real DPAPI protector backed by PowerShell ProtectedData (Windows only). */
export class DpapiProtector implements Protector {
  protect(plaintext: Buffer): Promise<string> {
    if (process.platform !== 'win32') {
      return Promise.reject(new VaultError('DPAPI is only available on Windows'));
    }
    return runPowerShell(PROTECT_PS, plaintext.toString('base64'));
  }

  async unprotect(blob: string): Promise<Buffer> {
    if (process.platform !== 'win32') {
      throw new VaultError('DPAPI is only available on Windows');
    }
    return Buffer.from(await runPowerShell(UNPROTECT_PS, blob), 'base64');
  }
}

/**
 * NON-SECURE protector for tests and non-Windows logic runs. It merely base64-encodes,
 * providing the same round-trip contract without real encryption. Never use in production;
 * the name is deliberately alarming so it cannot be selected by accident.
 */
export class InsecurePassthroughProtector implements Protector {
  protect(plaintext: Buffer): Promise<string> {
    return Promise.resolve(`insecure:${plaintext.toString('base64')}`);
  }

  unprotect(blob: string): Promise<Buffer> {
    if (!blob.startsWith('insecure:')) {
      return Promise.reject(
        new VaultError('blob was not produced by InsecurePassthroughProtector'),
      );
    }
    return Promise.resolve(Buffer.from(blob.slice('insecure:'.length), 'base64'));
  }
}
