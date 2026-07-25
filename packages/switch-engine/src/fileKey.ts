// Credential-at-rest protection for platforms WITHOUT an OS-run secret store the daemon
// can rely on: Linux (including WSL2), the BSDs, and anything else that isn't win32/darwin.
//
// Windows seals the vault with DPAPI and macOS with a login-Keychain-held key. The obvious
// Linux analog (libsecret) is structurally wrong for this daemon: it needs an unlocked
// keyring on a D-Bus session bus, which WSL2, SSH sessions, servers, and autostarted
// daemons don't have — and a vault sealed via a desktop keyring would become undecryptable
// the moment the same machine's daemon runs headless. So the key source here is
// DETERMINISTIC instead: a random 256-bit key in a file readable only by the owner (0600,
// dir 0700), kept as a SIBLING of the vault directory — never inside it — with vault blobs
// AES-256-GCM sealed in-process by the same primitive (and thus the same blob format) as
// macOS.
//
// Threat model, stated honestly: this defeats a copied VAULT DIRECTORY (backups, sync
// clients, a tar of `vault/`) but not an attacker who can read the whole home directory —
// they get the key file too. That matches the platform's own baseline: on Linux the Claude
// CLI keeps the LIVE credentials as plaintext in `<claudeDir>/.credentials.json`, so the
// vault never rests on a weaker story than the box it runs on. Protection beyond that is
// full-disk encryption's job; a keyring-backed key source can slot in behind the same
// Protector seam if a desktop-only deployment ever wants one.

import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, open, readFile, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { AesGcmProtector } from './aesgcm.js';
import { VaultError } from './errors.js';
import type { Protector } from './dpapi.js';

/** Mode enforcement is keyed off the REAL platform, not the injected dispatch platform:
 *  on Windows, Node's chmod/stat modes are a fiction over NTFS ACLs, so "repairing" a mode
 *  there would either no-op or fail forever — while tests that exercise the linux dispatch
 *  path on a Windows dev box must still be able to run the pure-logic parts. */
const ENFORCE_MODES = process.platform !== 'win32';

/**
 * Get-or-create a 32-byte vault key in a file, hex-encoded like the Keychain source stores
 * it. Mirrors KeychainKeySource's contract, including the first-run race: the key is fully
 * written + fsync'd to a private temp file, then PUBLISHED with `link()` — which fails
 * EEXIST atomically if a concurrent creator won. Losers re-read the winner's key, so
 * everyone seals with the same bytes (the Keychain analog converges via `-U` + re-read),
 * and because only complete temp files are ever linked, a reader can never observe a
 * half-written key — an exclusive `open('wx')` would expose exactly that window.
 */
export class FileKeySource {
  constructor(private readonly keyPath: string) {}

  async getOrCreateKey(): Promise<Buffer> {
    const existing = await this.readKey();
    if (existing) return existing;
    const tmp = `${this.keyPath}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`;
    try {
      // The key is born 0600 inside a 0700 dir — never written wide and tightened later.
      // The dir may pre-exist wider (vault/ creation uses the default mode), so tighten
      // it here at key birth, where a failure is loud once at setup, not on every poll.
      await mkdir(dirname(this.keyPath), { recursive: true, mode: 0o700 });
      if (ENFORCE_MODES) await chmod(dirname(this.keyPath), 0o700);
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.writeFile(`${randomBytes(32).toString('hex')}\n`);
        await handle.sync(); // a torn key surviving a crash would orphan every future blob
      } finally {
        await handle.close();
      }
      try {
        await link(tmp, this.keyPath);
      } catch (err) {
        // EEXIST = lost the publish race and the winner's (complete) key is on disk —
        // fall through to the re-read below. Anything else is a real failure.
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
    } catch (err) {
      throw new VaultError(`failed to create vault key file at ${this.keyPath}`, {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    } finally {
      // The temp name is ours alone; after a successful link the target holds the inode.
      await rm(tmp, { force: true });
    }
    const stored = await this.readKey();
    if (!stored) throw new VaultError('vault key file vanished after creation');
    return stored;
  }

  /** Read + validate the key file, or `undefined` when absent. Every OTHER failure —
   *  permissions, malformed content — is loud: silently minting a replacement key would
   *  orphan every blob sealed under the real one. */
  private async readKey(): Promise<Buffer | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.keyPath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw new VaultError(`failed to read vault key file at ${this.keyPath}`, {
        cause: err instanceof Error ? err : new Error(String(err)),
      });
    }
    const hex = raw.trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new VaultError(
        `vault key file at ${this.keyPath} is not a 32-byte hex key - refusing to use or ` +
          `replace it (a fresh key would make existing vault blobs undecryptable)`,
      );
    }
    await this.repairMode();
    return Buffer.from(hex, 'hex');
  }

  /** A key file that drifted group/other-readable gets tightened back to 0600. Repair
   *  beats refuse-and-die: the daemon is often the only thing looking, and a dead vault
   *  helps nobody while the fix is a chmod we can just do. */
  private async repairMode(): Promise<void> {
    if (!ENFORCE_MODES) return;
    const mode = (await stat(this.keyPath)).mode & 0o777;
    if ((mode & 0o077) !== 0) await chmod(this.keyPath, 0o600);
  }
}

/** File-key vault protector: file-held key + in-process AES-GCM. Guarded OFF win32/darwin
 *  — those platforms have strictly stronger OS stores and must never silently downgrade to
 *  a file key — the same way DpapiProtector and KeychainProtector guard their platforms.
 *  Key resolution is lazy (first use), so merely constructing one never touches the disk. */
export class FileKeyProtector implements Protector {
  private inner: AesGcmProtector | undefined;

  constructor(
    private readonly keySource: FileKeySource,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  private async delegate(): Promise<AesGcmProtector> {
    if (this.platform === 'win32' || this.platform === 'darwin') {
      throw new VaultError(
        `file-key protection is for platforms without an OS secret store - ` +
          `${this.platform} has one (use defaultProtector)`,
      );
    }
    this.inner ??= new AesGcmProtector(await this.keySource.getOrCreateKey());
    return this.inner;
  }

  async protect(plaintext: Buffer): Promise<string> {
    return (await this.delegate()).protect(plaintext);
  }

  async unprotect(blob: string): Promise<Buffer> {
    return (await this.delegate()).unprotect(blob);
  }
}
