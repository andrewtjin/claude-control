// Stable, DPAPI-encrypted secret shared between the daemon and the CLI to authenticate hook
// (and, later, CLI) requests to the loopback HookReceiver.
//
// WHY STABLE: the receiver authenticates every inbound POST with a shared secret (see
// hookReceiver.ts's `secretHeader`), and that secret is baked verbatim into the curl command
// hookInstaller.ts writes into `settings.json`. A fresh per-run secret (the earlier behaviour,
// `randomUUID()` each start) would therefore 401 every hook the *previous* run installed until
// the next self-heal re-install, and worse, each run would append a NEW curl command carrying
// its own secret — settings.json would accrue one dead hook per restart. Persisting the secret
// once fixes both: the installed hooks keep working across restarts, and re-installing is a
// no-op (installHooks dedupes on the identical command string).
//
// SHARING CONTRACT (why this lives in the daemon package rather than in daemonRun.ts next to
// dpapiIdentityStore): a later commit adds `cctl session` subcommands that authenticate to the
// same loopback receiver with this secret. Both the daemon and that CLI must read the SAME
// bytes, so:
//   - Both derive the file location from the same rule — `hookSecretPath(dataDir)` where
//     `dataDir = dirname(paths.vaultDir)` — a sibling of the vault and daemon-identity.enc.
//   - The blob is DPAPI-encrypted (CurrentUser scope), matching the at-rest posture of the
//     OAuth vault and the daemon identity: it decrypts only for the same Windows user on the
//     same machine, and is useless if copied off the box.
//   - The DAEMON is the sole author. `loadOrCreateHookSecret` mints-and-persists on first ever
//     run; the CLI uses read-only `loadHookSecret`, which returns `undefined` (rather than
//     minting a competing secret the receiver would reject) when the daemon has never run. That
//     asymmetry is what guarantees the two processes can never disagree on the secret.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Protector } from '@claude-control/switch-engine';

/** The stable on-disk location of the encrypted hook secret: a sibling of the vault and the
 *  daemon identity under the claude-control data dir. Both the daemon and the CLI compute
 *  `dataDir` as `dirname(paths.vaultDir)` and call this — that shared derivation is precisely
 *  what lets a separate CLI process find the daemon's secret. */
export function hookSecretPath(dataDir: string): string {
  return join(dataDir, 'hook-secret.enc');
}

export interface HookSecretOptions {
  /** Absolute path to the encrypted secret file (see {@link hookSecretPath}). */
  filePath: string;
  /** The at-rest protector — `DpapiProtector` in production, `InsecurePassthroughProtector`
   *  in cross-platform tests. Must be the SAME protector both writer and reader use. */
  protector: Protector;
  /** Injectable secret source so tests can pin a deterministic value; defaults to a v4 UUID
   *  (128 bits of entropy — a loopback-only bearer token, not a password). */
  generate?: () => string;
}

/**
 * Read the persisted hook secret, or `undefined` when none exists or the file is unreadable.
 * READ-ONLY — never writes. This is the CLI-side entry point: a CLI invoked before the daemon
 * has ever started legitimately has no secret to read, and must NOT invent one (an invented
 * secret would simply be rejected by the receiver the daemon later brings up with a different
 * secret). Degrades a corrupt/foreign blob to `undefined` for the same reason
 * dpapiIdentityStore does: the recovery path is "let the daemon regenerate", not a crash.
 */
export async function loadHookSecret(
  opts: Pick<HookSecretOptions, 'filePath' | 'protector'>,
): Promise<string | undefined> {
  let blob: string;
  try {
    blob = await readFile(opts.filePath, 'utf8');
  } catch {
    return undefined; // never generated on this machine yet
  }
  try {
    const secret = (await opts.protector.unprotect(blob.trim())).toString('utf8');
    return secret.length > 0 ? secret : undefined;
  } catch {
    return undefined; // corrupt / foreign / wrong-user blob
  }
}

/**
 * Load the stable hook secret, generating and persisting one on the first ever run. The
 * DAEMON's entry point (it is the sole author — see the sharing contract at the top of this
 * file). A corrupt/foreign file is treated as "never generated" and replaced; the only cost is
 * re-installing hooks with the new secret on the next self-heal, never a crash.
 */
export async function loadOrCreateHookSecret(opts: HookSecretOptions): Promise<string> {
  const existing = await loadHookSecret(opts);
  if (existing !== undefined) return existing;
  const secret = (opts.generate ?? randomUUID)();
  // temp-free write is fine here: the secret is idempotently regenerable, so a torn write on
  // crash is self-correcting on the next start (unreadable → regenerate). Ensure the parent
  // dir exists so the very first run on a clean machine doesn't ENOENT.
  await mkdir(dirname(opts.filePath), { recursive: true });
  await writeFile(opts.filePath, await opts.protector.protect(Buffer.from(secret, 'utf8')), 'utf8');
  return secret;
}
