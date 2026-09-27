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

/** Wrote the live credentials but read-back verification did not match — the switch was undone. */
export class VerifyError extends SwitchEngineError {
  constructor(message: string) {
    super(message, 'verify_failed');
  }
}

/** A switch that was interrupted (a crash, or an undo that itself failed) could not be finished or
 *  undone yet — typically because another process keeps a live file open — so the live login may be
 *  one account's credentials under another's identity. What reads or writes the live login is
 *  refused until it is settled, and every such operation retries the settle first. */
export class UnsettledSwitchError extends SwitchEngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'switch_unsettled', options);
  }
}

/** The account's stored refresh token is also stored under another account. A refresh token is
 *  single-use, so whichever copy is refreshed first kills the other; seating it live (where every
 *  session refreshes it) is refused until one of the two accounts is re-logged. */
export class SharedTokenError extends SwitchEngineError {
  constructor(message: string) {
    super(message, 'shared_token');
  }
}

/** DPAPI protect/unprotect failed, or the vault is structurally corrupt. */
export class VaultError extends SwitchEngineError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, 'vault_error', options);
  }
}

/** Referenced an account id that is not in the registry. */
export class UnknownAccountError extends SwitchEngineError {
  constructor(id: string) {
    super(`no account with id "${id}"`, 'unknown_account');
  }
}
