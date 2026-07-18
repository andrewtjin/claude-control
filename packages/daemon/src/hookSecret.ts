// Shared secret the loopback hook receiver requires on every request (see hookReceiver.ts's
// `secretHeader`) so an arbitrary local process cannot forge hook events.
//
// The secret must be STABLE across daemon restarts: `hookInstaller.ts` bakes it verbatim into
// the curl command it writes into a Claude Code profile's settings.json, and that installed
// command keeps running long after this process restarts with a fresh in-memory value.
// Minting a new secret every run means every restart 401s the previously-installed hook until
// it happens to be reinstalled — this module exists so the daemon always has one value to
// both serve and (re)install.
//
// Persisted DPAPI-encrypted beside the daemon's control-plane identity file — same at-rest
// posture, same mint-once/corrupt-recovers shape as `dpapiIdentityStore`
// (packages/cli/src/daemonRun.ts). Kept as its own tiny module rather than shared with that
// one: the two stores protect different secrets for different callers, and duplicating the
// small amount of load/save plumbing is cheaper than coupling the two composition roots.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Protector } from '@claude-control/switch-engine';

/** 256 bits, hex-encoded — plenty for a bearer value that only ever travels over loopback. */
const SECRET_BYTES = 32;

/**
 * Load the persisted hook secret, minting and persisting a fresh one the first time — or
 * whenever the existing file is missing, corrupt, or undecryptable. Unlike an adopted daemon
 * identity (where corruption means "not paired, the user must re-pair"), a corrupt hook
 * secret has no external party to reconcile with: both sides that need to agree on it (this
 * receiver, and the curl command `installHooks` is about to (re)write) are ours, so silently
 * regenerating is safe as long as the caller re-runs `installHooks` afterward with the
 * returned value.
 */
export async function loadOrCreateHookSecret(
  filePath: string,
  protector: Protector,
): Promise<string> {
  const existing = await tryLoadHookSecret(filePath, protector);
  if (existing !== undefined) return existing;

  const secret = randomBytes(SECRET_BYTES).toString('hex');
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, protector.protect(Buffer.from(secret, 'utf8')), 'utf8');
  return secret;
}

async function tryLoadHookSecret(
  filePath: string,
  protector: Protector,
): Promise<string | undefined> {
  let encrypted: string;
  try {
    encrypted = await readFile(filePath, 'utf8');
  } catch {
    return undefined; // never minted on this machine
  }
  try {
    const secret = protector.unprotect(encrypted.trim()).toString('utf8');
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined; // corrupt/foreign blob — treat as never minted
  }
}
