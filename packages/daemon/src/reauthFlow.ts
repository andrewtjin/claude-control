// Pending phone-reauth flows: the daemon-memory half of the OAuth authorization-code+PKCE
// re-login (see shared-protocol's reauth.* frames).
//
// One entry per outstanding login link. The PKCE verifier lives ONLY here (process memory) —
// never on the wire, never on disk, never in logs — which is the entire security posture that
// makes relaying the pasted code through Discord acceptable. Deliberately unpersisted: a
// daemon restart forgets every pending flow, and a late paste then gets an honest "run /reauth
// again" instead of a resurrection path for stale verifiers.
//
// Pure and clock-injected so every lifecycle rule (TTL, one-shot take, same-account
// replacement, FIFO bound) is unit-testable without a daemon.

/** One minted-but-unconsumed login link. */
export interface PendingReauth {
  /** The RESOLVED account id (never the raw ref the user typed). */
  accountId: string;
  label: string;
  /** PKCE verifier — see the module comment; this field must never be logged. */
  verifier: string;
  /** The `state` we minted into the authorize URL; the pasted "code#state" must echo it. */
  state: string;
  /** The authorize URL, kept so a duplicate start could re-show it without re-minting. */
  url: string;
  expiresAtMs: number;
}

export type ReauthLookup =
  | { kind: 'ok'; entry: PendingReauth }
  /** Unknown requestId — expired-and-swept, already consumed, superseded by a newer /reauth
   *  for the same account, or a pre-restart flow. Deliberately ONE bucket: the user's remedy
   *  is identical in every case, and distinguishing them would leak nothing but confusion. */
  | { kind: 'not_found' }
  | { kind: 'expired' };

/** How long a minted link stays consumable. Generous — the user has to switch to a browser,
 *  log in, copy, and switch back — but NOT a claim about the provider's own authorize-page or
 *  code lifetime, which is unverified (docs/VERIFICATION.md). */
export const DEFAULT_REAUTH_TTL_MS = 10 * 60_000;

/** Bound on concurrently pending flows. One daemon serves one paired user, so this is pure
 *  insurance against a runaway caller — FIFO-evicted like every other bounded set here. */
export const MAX_PENDING_REAUTHS = 32;

export class PendingReauths {
  /** Keyed by requestId — the bot-minted correlation id the paste modal carries back. A JS Map
   *  iterates in insertion order, so the first key is always the oldest (FIFO eviction). */
  private readonly byRequestId = new Map<string, PendingReauth>();

  constructor(private readonly bound = MAX_PENDING_REAUTHS) {}

  /**
   * Record a freshly minted flow. Evicts any existing flow for the SAME account first — at
   * most one live link per account, so a second /reauth immediately deadens the first link's
   * verifier instead of leaving two consumable flows outstanding. Then FIFO-evicts past the
   * bound.
   */
  start(requestId: string, entry: PendingReauth): void {
    for (const [rid, pending] of this.byRequestId) {
      if (pending.accountId === entry.accountId) this.byRequestId.delete(rid);
    }
    this.byRequestId.set(requestId, entry);
    while (this.byRequestId.size > this.bound) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest === undefined) break;
      this.byRequestId.delete(oldest);
    }
  }

  /**
   * One-shot consume: the entry is deleted BEFORE the caller does anything async, so a second
   * racing submit for the same requestId always sees not_found — the daemon-side analog of
   * "the authorization code is single-use", independent of any client-side dedupe.
   */
  take(requestId: string, nowMs: number): ReauthLookup {
    const entry = this.byRequestId.get(requestId);
    if (!entry) return { kind: 'not_found' };
    this.byRequestId.delete(requestId);
    if (nowMs >= entry.expiresAtMs) return { kind: 'expired' };
    return { kind: 'ok', entry };
  }

  /**
   * Put a taken entry back after a LOCAL validation failure (garbled paste, state mismatch) —
   * the network was never touched, the code is not burned, and the user deserves to just
   * re-paste rather than redo the whole browser login. The original expiry is kept (a stream
   * of typos must not extend a link's life). Only valid synchronously after take(), before
   * any await — past an await a concurrent start() for the same account may have minted a
   * fresh flow this restore would then sit beside as a stale zombie.
   */
  restore(requestId: string, entry: PendingReauth): void {
    this.byRequestId.set(requestId, entry);
  }

  /** Drop expired entries. Piggybacked on the daemon's poll cycle — lazy expiry in take()
   *  already guarantees correctness; this just keeps abandoned verifiers from idling in
   *  memory for the daemon's whole lifetime. */
  sweep(nowMs: number): void {
    for (const [rid, pending] of this.byRequestId) {
      if (nowMs >= pending.expiresAtMs) this.byRequestId.delete(rid);
    }
  }

  size(): number {
    return this.byRequestId.size;
  }
}
