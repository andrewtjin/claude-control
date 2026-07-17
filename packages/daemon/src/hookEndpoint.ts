// Publishes the loopback port the HookReceiver is currently bound to, so a separate `cctl
// session` CLI process can find the running daemon and POST to its CLI endpoints.
//
// WHY A FILE (and why not DPAPI): the HookReceiver binds an OS-assigned ephemeral port
// (`listen(0)`) that changes every daemon run, so the port is not derivable — the daemon must
// publish it and the CLI must read it. Unlike the hook SECRET, a loopback port number is not a
// secret (knowing it grants nothing without the secret, and the server is 127.0.0.1-only), so
// this is plaintext JSON, matching the vault registry's "non-secret metadata is plaintext"
// posture. The secret file (hookSecret.ts) remains DPAPI-encrypted and is the actual auth gate;
// this file only answers "where do I connect".
//
// The daemon rewrites this on every start (current port wins); a stale file left by a crashed
// daemon simply yields a connection-refused the CLI turns into an actionable "start the daemon"
// message — never a wrong action, because the secret still guards the endpoint.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** The published endpoint descriptor. Only the port matters today (host is always 127.0.0.1);
 *  kept as an object so a future field (e.g. a pid for liveness) is an additive change. */
export interface HookEndpoint {
  port: number;
}

/** Stable on-disk location: a sibling of the vault / daemon-identity / hook-secret under the
 *  claude-control data dir. Both the daemon (writer) and the CLI (reader) derive `dataDir` as
 *  `dirname(paths.vaultDir)` and call this — the shared derivation is what lets the CLI find
 *  it, exactly as {@link hookSecretPath} does for the secret. */
export function hookEndpointPath(dataDir: string): string {
  return join(dataDir, 'hook-endpoint.json');
}

/** Persist the currently-bound loopback port. Creates the parent dir on first run so a clean
 *  machine doesn't ENOENT. A torn write on crash is self-correcting: the next daemon start
 *  overwrites it, and a reader that gets half a file degrades to `undefined` (see
 *  {@link readHookEndpoint}) → "start the daemon", never a crash. */
export async function writeHookEndpoint(filePath: string, endpoint: HookEndpoint): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(endpoint), 'utf8');
}

/** Read the published endpoint, or `undefined` when the daemon has never published one (never
 *  run) or the file is unreadable/corrupt. READ-ONLY, and tolerant for the same reason
 *  loadHookSecret is: the recovery path is "start the daemon", not a thrown error. A
 *  non-positive/absent port is treated as "no endpoint". */
export async function readHookEndpoint(filePath: string): Promise<HookEndpoint | undefined> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return undefined; // never published on this machine yet
  }
  try {
    const parsed = JSON.parse(raw) as Partial<HookEndpoint>;
    if (typeof parsed.port !== 'number' || !Number.isInteger(parsed.port) || parsed.port <= 0) {
      return undefined;
    }
    return { port: parsed.port };
  } catch {
    return undefined; // corrupt / half-written blob
  }
}
