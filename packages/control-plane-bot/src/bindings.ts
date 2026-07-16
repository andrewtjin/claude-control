// Discord-user <-> daemon bindings — the single source of truth for routing authorization.
//
// A binding is the ONLY thing that lets the relay move an envelope between a socket and a
// Discord user. It is intentionally 1:1 in both directions: one daemon has exactly one
// owning user, and one user has exactly one bound daemon. Re-binding either side (a re-pair)
// atomically evicts the stale reverse mapping so a lookup can never return two answers, or a
// dangling answer, for one key — that property is what makes cross-user isolation provable
// rather than "probably fine".

import { verifyToken } from './tokens.js';
import { atomicWriteFile, readJsonIfExists } from './fsutil.js';

export interface Binding {
  discordUserId: string;
  daemonId: string;
  /** scrypt hash of the daemon's token — never the plaintext token. */
  tokenHash: string;
  hostLabel: string;
  boundAtMs: number;
}

interface PersistedShape {
  bindings: Binding[];
}

// A structurally valid but unattainable stored hash, used to pay the same scrypt cost for an
// unknown daemon id as for a known one with a wrong token. Without this, `verifyDaemon` would
// return in microseconds for an unknown id and ~tens of ms for a known one — a clean timing
// oracle for enumerating which daemon ids are registered.
const DUMMY_STORED_HASH = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

/**
 * In-memory binding table with optional JSON persistence. Persistence is entirely opt-in:
 * construct without a path for a pure in-memory store (tests); pass `persistPath` so a real
 * bot's bindings survive a restart without re-pairing every daemon.
 */
export class BindingStore {
  private readonly byUserMap = new Map<string, Binding>();
  private readonly byDaemonMap = new Map<string, Binding>();

  constructor(private readonly persistPath?: string) {}

  /** Load persisted bindings from disk, if a path was configured. Call once at startup; a
   *  missing file is not an error — it just means no daemon has ever paired yet. */
  async load(): Promise<void> {
    if (!this.persistPath) return;
    const data = await readJsonIfExists<PersistedShape>(this.persistPath);
    for (const binding of data?.bindings ?? []) {
      this.index(binding);
    }
  }

  /** Create or replace a binding. Enforces 1:1 in both directions by evicting whichever
   *  existing binding(s) would otherwise collide with the new one before inserting it. */
  async bind(
    discordUserId: string,
    daemonId: string,
    tokenHash: string,
    hostLabel: string,
    now: number = Date.now(),
  ): Promise<Binding> {
    // Fail closed on cross-user daemon-id reuse: binding an id that already belongs to a
    // DIFFERENT user would evict that user (DoS) and could route their daemon's traffic to the
    // new binder. The bot mints ids server-side (PairingService) so this never legitimately
    // happens, but the primitive refuses it regardless — isolation must not depend on the
    // caller behaving. Same-user re-pair of the same id is fine.
    const staleByDaemon = this.byDaemonMap.get(daemonId);
    if (staleByDaemon && staleByDaemon.discordUserId !== discordUserId) {
      throw new Error(`daemon id "${daemonId}" is already bound to another account`);
    }
    // Drop this user's previous daemon mapping (a re-pair to a new id) so a stale reverse
    // lookup can't resolve to a dangling owner.
    const staleByUser = this.byUserMap.get(discordUserId);
    if (staleByUser) this.byDaemonMap.delete(staleByUser.daemonId);
    if (staleByDaemon) this.byUserMap.delete(staleByDaemon.discordUserId);

    const binding: Binding = { discordUserId, daemonId, tokenHash, hostLabel, boundAtMs: now };
    this.index(binding);
    await this.persist();
    return binding;
  }

  /** The one daemon bound to this Discord user, if any. Isolation guarantee: this can never
   *  return a binding whose `discordUserId` differs from the argument. */
  byUser(discordUserId: string): Binding | undefined {
    return this.byUserMap.get(discordUserId);
  }

  /** The owning binding for this daemon id, if any. */
  byDaemon(daemonId: string): Binding | undefined {
    return this.byDaemonMap.get(daemonId);
  }

  /** Verify a daemon's presented token against its stored hash, at constant time whether or
   *  not the daemon id is known. Returns the binding on success (so callers get
   *  `discordUserId` without a second lookup) or `undefined` on any failure — unknown daemon
   *  and wrong token are deliberately indistinguishable to the caller. */
  async verifyDaemon(daemonId: string, token: string): Promise<Binding | undefined> {
    const binding = this.byDaemonMap.get(daemonId);
    const ok = await verifyToken(token, binding?.tokenHash ?? DUMMY_STORED_HASH);
    return binding && ok ? binding : undefined;
  }

  private index(binding: Binding): void {
    this.byUserMap.set(binding.discordUserId, binding);
    this.byDaemonMap.set(binding.daemonId, binding);
  }

  private async persist(): Promise<void> {
    if (!this.persistPath) return;
    const bindings = [...this.byDaemonMap.values()];
    await atomicWriteFile(this.persistPath, JSON.stringify({ bindings }, null, 2));
  }
}
