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

/** What a switch that failed after its first live write left in its slot (see {@link SwitchFailedError}):
 *  - `restored`: the switch was undone and the previous login is live again — nothing changed;
 *  - `kept_other_login`: another program wrote the live login while the switch ran; that login was
 *    left in place and nothing was stored from it;
 *  - `pending`: the undo failed too, so the switch stays pending until the next operation on the
 *    slot (or `cctl recover`) finishes or undoes it. */
export type FailedSwitchOutcome = 'restored' | 'kept_other_login' | 'pending';

/** A switch failed after it had begun writing the live login. Its message is the whole story in
 *  plain language — what could not be done, what the live login is now, the likely cause and the
 *  next step — because a person reads it (a CLI error line, a phone reply); the underlying failure is
 *  its `cause`, and `outcome` says the same about the slot for code. */
export class SwitchFailedError extends SwitchEngineError {
  constructor(
    message: string,
    readonly outcome: FailedSwitchOutcome,
    options?: { cause?: unknown },
  ) {
    super(message, 'switch_failed', options);
  }
}

/** A switch that was interrupted (a crash, or an undo that itself failed) could not be finished or
 *  undone yet — typically because another process keeps a live file open — so that slot's live
 *  login may be one account's credentials under another's identity. What writes that slot, or
 *  depends on the two accounts the switch was between, is refused until it is settled, and every
 *  such operation retries the settle first. */
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

/** Why an activation was refused for its slot (see {@link SlotError}):
 *  - `slot_mismatch`: the caller named a slot whose pool does not hold the target (a reserved account
 *    asked for the global slot, an account a rule excludes asked for that rule's slot) — typically a
 *    decision made against a picture that changed before the switch reached the lock;
 *  - `not_slot_candidate`: the target is not a legitimate occupant of the slot being written;
 *  - `rule_gone`: the folder rule whose slot was to be written no longer exists;
 *  - `live_elsewhere`: the target is live in another slot, and no account is live in two;
 *  - `slot_ambiguous`: no slot was named and the target could legitimately go to more than one (an
 *    account several rules include, live in none of them);
 *  - `leased`: the account runs a parallel session (`cctl claude --account`), so nothing else may
 *    seat it, place a session on it or remove it until that session exits. */
export type SlotErrorCode =
  | 'slot_mismatch'
  | 'not_slot_candidate'
  | 'rule_gone'
  | 'live_elsewhere'
  | 'slot_ambiguous'
  | 'leased';

/** An activation was refused because its target may not be live in the slot it was headed for.
 *  Always raised BEFORE anything live is written, so a refused switch changes nothing. */
export class SlotError extends SwitchEngineError {
  constructor(message: string, code: SlotErrorCode) {
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

/** A parallel session's holder list was about to be written empty. Ending a parallel session is
 *  removing its rule in one write; an empty list on disk is a file every reader refuses, so asking for
 *  one is a programming error, refused before anything is written. */
export class LeaseHoldersEmptyError extends SwitchEngineError {
  constructor(ruleId: string) {
    super(`the parallel session ${ruleId} would be left with no holder`, 'lease_holders_empty');
  }
}

/** A parallel session already holds as many processes as a rules file may record. Refused before
 *  anything is written. */
export class LeaseHolderCapError extends SwitchEngineError {
  constructor(
    message: string,
    /** The cap that was reached. */
    readonly max: number,
  ) {
    super(message, 'lease_holders_full');
  }
}

/** A write of `groups.json` was refused because the file it would produce does not pass this
 *  build's own reader. Readers fail closed, so writing it would stop every command and the daemon;
 *  refusing the write keeps the file on disk as it was. */
export class RulesWriteRefusedError extends SwitchEngineError {
  constructor(
    /** What the reader would have refused. */
    readonly reason: string,
  ) {
    super(
      `refused to write a rules file this build could not read back (${reason})`,
      'rules_write_refused',
    );
  }
}

/** Why `cctl claude --account` cannot run an account from here (see `SwitchEngine.claimSessionSlot`):
 *  - `live_twice`: the account is live in two slots at once (a breach the doctor reports);
 *  - `live_in_other_rule`: a shared account live in a rule slot this launch does not run under;
 *  - `session_slot_unsupported`: a parallel session would be needed, and macOS has none yet;
 *  - `lease_unsettled`: the parallel-session slot holds an interrupted switch that cannot be settled;
 *  - `lease_seat_failed`: joining a parallel session needed its slot seated, and that failed;
 *  - `rules_full`: the rules registry has no room for another rule. */
export type SessionSlotErrorCode =
  | 'live_twice'
  | 'live_in_other_rule'
  | 'session_slot_unsupported'
  | 'lease_unsettled'
  | 'lease_seat_failed'
  | 'rules_full';

/** A refusal of `cctl claude --account`, raised before anything is written (or after a rollback). */
export class SessionSlotError extends SwitchEngineError {
  constructor(message: string, code: SessionSlotErrorCode, options?: { cause?: unknown }) {
    super(message, code, options);
  }
}
