// Pairing codes: the on-ramp from "a user runs /pair" to "a daemon has a bound token".
//
// A code is short enough for a human to type into a daemon prompt, and short-lived +
// single-use so a leaked code is worthless within minutes. `claim()` is the ONLY path that
// ever mints a daemon token — a daemon has no other way to acquire credentials.
//
// SECURITY (cross-user isolation): the bot MINTS the daemon id here, server-side. A daemon
// does not get to name itself. If the daemon could choose its own id, a second user could
// redeem their own valid code while naming a victim's daemon id and hijack the victim's
// binding (DoS + traffic interception). Minting a fresh random id per pairing makes that
// class of attack impossible — isolation no longer depends on any id staying secret.

import { randomInt, randomUUID } from 'node:crypto';
import { mintToken, hashToken } from './tokens.js';
import type { BindingStore, Binding } from './bindings.js';

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes: long enough to copy-paste, short enough to matter
const CODE_LENGTH = 8;
// Crockford-ish base32 without ambiguous chars (no I/L/O/U/0/1) — ~40 bits over 8 chars,
// so guessing a specific live code within its 10-minute window is infeasible even unthrottled.
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';

// Global brute-force throttle: cap total claim attempts in a sliding window. The relay closes
// the socket after every attempt, so the practical rate is already reconnect-bound; this makes
// an enumeration attempt observable and bounded rather than relying only on keyspace.
const ATTEMPT_WINDOW_MS = 10_000;
const MAX_ATTEMPTS_PER_WINDOW = 30;

interface PendingCode {
  discordUserId: string;
  expiresAtMs: number;
  used: boolean;
}

export type ClaimResult =
  | { ok: true; daemonId: string; daemonToken: string; discordUserId: string }
  | { ok: false; error: string };

export interface PairingServiceOptions {
  bindings: BindingStore;
  clock?: () => number;
  /** Injectable code generator so tests can pin the "random" code instead of scanning the
   *  keyspace for it. Defaults to a CSPRNG-uniform base32 code. */
  generateCode?: () => string;
  /** Injectable daemon-id minter so tests can assert a deterministic id. Defaults to a v4 uuid. */
  generateDaemonId?: () => string;
  ttlMs?: number;
}

export class PairingService {
  private readonly codes = new Map<string, PendingCode>();
  private readonly bindings: BindingStore;
  private readonly clock: () => number;
  private readonly generateCode: () => string;
  private readonly generateDaemonId: () => string;
  private readonly ttlMs: number;
  private attemptTimes: number[] = [];

  constructor(options: PairingServiceOptions) {
    this.bindings = options.bindings;
    this.clock = options.clock ?? Date.now;
    this.generateCode = options.generateCode ?? defaultCodeGenerator;
    this.generateDaemonId = options.generateDaemonId ?? (() => randomUUID());
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Issue a fresh code for a user (from the `/pair` slash command). Regenerates on
   *  collision so two live codes can never resolve to different users; a user who reruns
   *  `/pair` simply gets a new code (the old one stays valid until it expires or is claimed). */
  createCode(discordUserId: string): string {
    const now = this.clock();
    // Sweep expired codes before inserting. `claim()` only ever deletes a code that someone
    // presents, so a code nobody redeems would otherwise sit in the Map past its TTL forever —
    // and createCode is the one entry point with no throttle (unlike claim), so an unbounded
    // `/pair` loop is a slow memory leak in the same long-lived process that holds every binding.
    // (Deleting the current/visited key while iterating a Map is well-defined.)
    for (const [existing, pending] of this.codes) {
      if (now >= pending.expiresAtMs) this.codes.delete(existing);
    }
    let code = this.generateCode();
    while (this.codes.has(code)) code = this.generateCode();
    this.codes.set(code, { discordUserId, expiresAtMs: now + this.ttlMs, used: false });
    return code;
  }

  /**
   * A daemon redeems a code over its socket. Success MINTS a daemon id and a token, stores
   * only the token's hash (via BindingStore), and binds the new daemon to the code's owning
   * user. The plaintext token and the assigned id are returned exactly once, here.
   *
   * The daemon does not supply its own id — see the module comment for why that matters.
   */
  async claim(pairingCode: string, hostLabel: string): Promise<ClaimResult> {
    if (this.throttled()) {
      return { ok: false, error: 'too many pairing attempts; slow down and try again' };
    }
    const pending = this.codes.get(pairingCode);
    if (!pending || pending.used) {
      return { ok: false, error: 'unknown or already-used pairing code' };
    }
    if (this.clock() >= pending.expiresAtMs) {
      this.codes.delete(pairingCode);
      return { ok: false, error: 'pairing code expired' };
    }
    // Mark used before the first await so a second claim racing in during the scrypt hash
    // below observes `used: true` rather than both racing to bind successfully.
    pending.used = true;

    const daemonId = this.generateDaemonId();
    const token = mintToken();
    const tokenHash = await hashToken(token);
    const binding: Binding = await this.bindings.bind(
      pending.discordUserId,
      daemonId,
      tokenHash,
      hostLabel,
      this.clock(),
    );
    this.codes.delete(pairingCode);
    return { ok: true, daemonId, daemonToken: token, discordUserId: binding.discordUserId };
  }

  /** Record an attempt and report whether the window is already saturated. Prunes old marks. */
  private throttled(): boolean {
    const now = this.clock();
    this.attemptTimes = this.attemptTimes.filter((t) => now - t < ATTEMPT_WINDOW_MS);
    this.attemptTimes.push(now);
    return this.attemptTimes.length > MAX_ATTEMPTS_PER_WINDOW;
  }
}

function defaultCodeGenerator(): string {
  // A pairing code is a bearer secret for a short window, so each character is drawn from the
  // CSPRNG (randomInt) over an unambiguous base32 alphabet.
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}
