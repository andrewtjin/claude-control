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
//
// AND async waiting alone is not enough. On Windows, `child_process.spawn` executes its
// CreateProcessW syscall on the CALLING thread's event loop — only the wait afterwards is
// async — and antivirus/AMSI inspection of powershell.exe inflates that syscall to hundreds
// of milliseconds and beyond (live-measured 32ms–2.3s PER SPAWN on a loaded box, on the
// exact cadence of the daemon's poll loop). So the spawn itself is exiled to a worker
// thread: the worker may block freely (execFileSync, deliberately), the main loop only ever
// awaits a message. The worker source is inline (`eval`) so bundlers need no separate file,
// and the worker is ref'd only while calls are in flight so a one-shot CLI process still
// exits promptly when idle and never exits early mid-call.

import { Worker } from 'node:worker_threads';
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

/** The worker's whole program (see the header for WHY a worker). It may block freely —
 *  that is the point: execFileSync's spawn + wait land on the worker's thread, never the
 *  main loop. A non-zero exit throws with `.status`/`.stderr`, which the worker relays so
 *  the main side can build the same VaultError shape the old in-process runner produced. */
const WORKER_SOURCE = `
const { parentPort } = require('node:worker_threads');
const { execFileSync } = require('node:child_process');
parentPort.on('message', (msg) => {
  try {
    const stdout = execFileSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', msg.encodedCommand],
      { input: msg.inputBase64, windowsHide: true, maxBuffer: msg.maxOutputBytes },
    );
    parentPort.postMessage({ id: msg.id, ok: true, stdout: stdout.toString('utf8').trim() });
  } catch (err) {
    const code = err && typeof err.status === 'number' ? err.status : null;
    const stderr = err && err.stderr ? err.stderr.toString('utf8').slice(0, 2000) : '';
    parentPort.postMessage({ id: msg.id, ok: false, code, stderr });
  }
});
`;

/** What the worker answers per call. */
interface WorkerReply {
  id: number;
  ok: boolean;
  stdout?: string;
  code?: number | null;
  stderr?: string;
}

interface PendingDpapiCall {
  resolve: (stdout: string) => void;
  reject: (err: VaultError) => void;
}

// One lazily-created worker per process, shared by every protector instance — DPAPI calls
// are short and effectively serial (the vault reads them account-by-account), so a single
// worker queue is the right shape and keeps thread count flat.
let dpapiWorker: Worker | undefined;
let nextDpapiCallId = 0;
const pendingDpapiCalls = new Map<number, PendingDpapiCall>();

/** Reject every in-flight call (worker crashed/exited) and drop the worker so the next
 *  call creates a fresh one — a dead worker must fail loudly, never wedge callers. */
function failAllPendingDpapiCalls(w: Worker, cause: unknown): void {
  if (dpapiWorker === w) dpapiWorker = undefined;
  for (const [id, call] of pendingDpapiCalls) {
    pendingDpapiCalls.delete(id);
    call.reject(
      new VaultError('DPAPI operation failed', {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      }),
    );
  }
}

/** The worker is unref'd while idle (a one-shot CLI must exit promptly when done) but MUST
 *  be ref'd while a call is in flight — an awaited promise alone does not keep the process
 *  alive, and an idle loop would otherwise exit mid-decrypt. */
function syncDpapiWorkerRef(): void {
  if (!dpapiWorker) return;
  if (pendingDpapiCalls.size > 0) dpapiWorker.ref();
  else dpapiWorker.unref();
}

function ensureDpapiWorker(): Worker {
  if (dpapiWorker) return dpapiWorker;
  const w = new Worker(WORKER_SOURCE, { eval: true });
  w.on('message', (msg: WorkerReply) => {
    const call = pendingDpapiCalls.get(msg.id);
    if (!call) return;
    pendingDpapiCalls.delete(msg.id);
    syncDpapiWorkerRef();
    if (msg.ok && msg.stdout !== undefined) {
      call.resolve(msg.stdout);
      return;
    }
    const stderr = msg.stderr ?? '';
    call.reject(
      new VaultError('DPAPI operation failed', {
        cause: new Error(
          `powershell exit code ${msg.code ?? 'null'}${stderr ? `: ${stderr}` : ''}`,
        ),
      }),
    );
  });
  w.on('error', (err) => failAllPendingDpapiCalls(w, err));
  w.on('exit', (code) => {
    if (pendingDpapiCalls.size > 0) {
      failAllPendingDpapiCalls(w, new Error(`DPAPI worker exited with code ${code}`));
    } else if (dpapiWorker === w) {
      dpapiWorker = undefined;
    }
  });
  dpapiWorker = w;
  return w;
}

/** Run one PowerShell DPAPI operation on the worker thread, feeding `inputBase64` on stdin,
 *  resolving with trimmed stdout. Rejects with a VaultError carrying the exit code and
 *  stderr text (PowerShell's CLIXML chatter or real error text) — never lets either land on
 *  the parent console, and never blocks the calling thread's event loop. */
function runPowerShell(script: string, inputBase64: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const id = nextDpapiCallId++;
    pendingDpapiCalls.set(id, { resolve, reject });
    ensureDpapiWorker().postMessage({
      id,
      encodedCommand: encodeCommand(script),
      inputBase64,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    syncDpapiWorkerRef();
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
