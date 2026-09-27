// Typed errors so callers can branch on failure mode rather than string-matching.
// Each carries a stable `code` for logs and protocol mapping.

export class SwitchEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The refresh endpoint rejected the token in a way that means it is permanently dead
 *  (`invalid_grant`) — the account must be quarantined and re-logged-in. Distinct from a
 *  transient network/5xx failure, which is a plain {@link RefreshError}. */
export class QuarantineError extends SwitchEngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'invalid_grant', options);
  }
}

/** A transient failure refreshing a token (network, 5xx, timeout). Safe to retry later. */
export class RefreshError extends SwitchEngineError {
  constructor(message: string, code = 'refresh_failed', options?: { cause?: unknown }) {
    super(message, code, options);
  }
}

/** A switch was requested too soon after the previous one. Part of the ToS posture: keeps
 *  any caller (including a future auto-switcher) at a human-plausible cadence. Bypass with
 *  `activate(id, { force: true })` for deliberate operator overrides. */
export class CadenceError extends SwitchEngineError {
  constructor(
    message: string,
    /** How long until a switch would be allowed, ms. */
    readonly retryAfterMs: number,
  ) {
    super(message, 'cadence_blocked');
  }
}

/** Could not acquire the credential lock within the timeout — another process holds it. */
export class LockTimeoutError extends SwitchEngineError {
  constructor(message: string) {
    super(message, 'lock_timeout');
  }
}

/** Wrote the live credentials but read-back verification did not match — a rollback was attempted. */
export class VerifyError extends SwitchEngineError {
  constructor(message: string) {
    super(message, 'verify_failed');
  }
}

/** DPAPI protect/unprotect failed, or the vault is structurally corrupt. */
export class VaultError extends SwitchEngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'vault_error', options);
  }
}

/** An activation was refused because its target may not be live in the slot it was headed for:
 *  - `slot_mismatch`: the caller named a slot the target does not belong to (a reserved account
 *    asked for the global slot, a shared account for a group) — typically a decision made against a
 *    membership picture that changed before the switch reached the lock;
 *  - `not_slot_candidate`: the target is not a legitimate occupant of the slot being written;
 *  - `group_gone`: the group whose slot was to be written no longer exists.
 *  Always raised BEFORE anything live is written, so a refused switch changes nothing. */
export class SlotError extends SwitchEngineError {
  constructor(message: string, code: 'slot_mismatch' | 'not_slot_candidate' | 'group_gone') {
    super(message, code);
  }
}

/** Referenced an account id that is not in the registry. */
export class UnknownAccountError extends SwitchEngineError {
  constructor(id: string) {
    super(`no account with id "${id}"`, 'unknown_account');
  }
}

/** A profile directory could not be materialized because of a genuine IO fault (the profile root
 *  itself could not be created, a link/write syscall failed for a reason other than a foreign
 *  pre-existing entry). Foreign entries are never a fault — they are reported in the profile
 *  report's `skipped` list and left untouched — so this fires only when the sweep cannot proceed. */
export class ProfileError extends SwitchEngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'profile_error', options);
  }
}
