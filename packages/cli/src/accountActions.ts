// The account actions behind `cctl switch` and `cctl accounts add|exclude|include|rename|remove`.
//
// Each action resolves its account, runs the engine call, and hands back a typed result whose
// `message` is the exact line the command prints on success. Every expected refusal is thrown as
// an {@link AccountActionError} whose message is the exact error line the command prints, so a
// caller that is not a one-shot command (a full-screen view, for one) can show the same words
// without going through `fail()` and the process exit it stands for. Anything else the engine
// throws is a real fault and escapes unchanged.
//
// The command handlers in program.ts are thin wrappers: run the action, print `message`, and turn
// an AccountActionError into the CLI's one error line (see `runAccountAction`).

import { spawnSync } from 'node:child_process';
import { dirname } from 'node:path';
import type { LogSink } from '@claude-control/shared-protocol';
import {
  CadenceError,
  QuarantineError,
  SharedTokenError,
  SlotError,
  SwitchEngineError,
  SwitchFailedError,
  UnknownAccountError,
  UnsettledSwitchError,
  VaultError,
  defaultPaths,
  isOverloadCode,
  resolveAccountRef,
  type AccountView,
  type ActivateResult,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { sanitizeForTerminal } from './ansi.js';
import { withCaptureDir } from './captureDir.js';
import { buildEngine, CliFailure, fail } from './context.js';
import {
  describeSlotRefusal,
  describeSwitchedGroup,
  refuseOnOlderDaemon,
  switchSlotForFolder,
  switchSlotOf,
} from './folderCommands.js';

type Engine = ReturnType<typeof buildEngine>;

/** Why an account action was refused. Stable names a caller can branch on; the words for a
 *  person are the error's `message`. */
export type AccountActionErrorCode =
  /** No account answers to the ref. */
  | 'not_found'
  /** Several accounts answer to the ref by label; the id is needed. */
  | 'ambiguous'
  /** A daemon that predates folder rules is running, and the switch could leave a shared account
   *  live in a folder slot that daemon cannot see. */
  | 'older_daemon'
  /** The `--folder` given to a switch is not a usable folder. */
  | 'bad_folder'
  /** The account's login is dead and needs a re-login before it can go live. */
  | 'quarantined'
  /** The switch-cadence guard refused a switch this soon after the last one. */
  | 'cadence'
  /** The account disappeared from the registry between resolving it and switching to it. */
  | 'unknown_account'
  /** The slot the switch targets cannot take this account. */
  | 'slot_refused'
  /** The switch failed part way, an earlier switch still blocks, or the login is stored twice;
   *  the message says what the live login is now. */
  | 'switch_failed'
  /** The token endpoint is shedding load; nothing changed. */
  | 'overloaded'
  /** The vault refused a label (a collision, an empty label) or a duplicate login. */
  | 'vault_refused'
  /** A plain add ran inside a folder profile, where the live login is a folder's seat. */
  | 'capture_in_profile'
  /** A plain add found no live login to store. */
  | 'no_live_login'
  /** A fresh add could not open the login window. */
  | 'launch_failed'
  /** A fresh add's window closed without a completed login in it. */
  | 'no_capture_login';

/** An expected refusal from an account action. `message` is the whole user-facing line, already
 *  phrased the way `cctl` prints it after `error: `; `code` lets a caller react without parsing
 *  words. */
export class AccountActionError extends Error {
  constructor(
    readonly code: AccountActionErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AccountActionError';
  }
}

/** How an action reaches the engine. A one-shot command passes nothing and gets the default
 *  engine logging to stderr; a long-lived caller passes the engine it already holds, or a sink so
 *  engine diagnostics land somewhere other than a screen it is drawing on. */
export interface AccountActionContext {
  /** An engine to reuse. When given, `logSink` is ignored (the engine already has its logger). */
  engine?: Engine;
  /** Where a freshly built engine writes its diagnostics. Defaults to stderr, as for every
   *  one-shot command. */
  logSink?: LogSink;
}

/** The engine an action runs against: the caller's, or one built on the default paths with the
 *  caller's log sink (stderr when none is given). */
function engineOf(ctx: AccountActionContext): Engine {
  return ctx.engine ?? buildEngine(undefined, ctx.logSink);
}

/** Resolve a ref across the WHOLE registry, reserved (folder-bound) members included, so every
 *  action reaches exactly the accounts `accounts list` shows. Accounts a folder rule reserves live
 *  in the group registry, not the shared pool, and the engine routes each write to the file that
 *  holds the row. Returns the fleet too, for the switch's slot decisions. */
async function resolveRef(
  engine: Engine,
  ref: string,
): Promise<{ account: StoredAccount; fleet: AccountView[] }> {
  const fleet = await engine.listAllAccounts();
  const resolved = resolveAccountRef(fleet, ref);
  if (!resolved.ok) throw new AccountActionError(resolved.reason, resolved.message);
  return { account: resolved.account, fleet };
}

/** Run a folder helper that refuses through `fail()` (a CliFailure), and re-throw its refusal as
 *  an AccountActionError with the same words. Those helpers are shared with the folder commands,
 *  which print the failure directly; an action has to hand it back typed instead. */
async function refusalAs<T>(code: AccountActionErrorCode, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (err) {
    if (err instanceof CliFailure) throw new AccountActionError(code, err.message, { cause: err });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// switch
// ---------------------------------------------------------------------------

/** What a switch did. `folderRule` is the folder rule whose slot the account is now live in, or
 *  null when it went to the global slot. */
export interface SwitchOutcome {
  account: StoredAccount;
  activation: ActivateResult;
  folderRule: { label: string; folders: string[]; scopes: string } | null;
  /** "Activated <label>... (<what changed>)." */
  message: string;
}

/** Options for {@link switchAccount}, matching `cctl switch`'s flags. */
export interface SwitchOptions {
  /** Bypass the switch-cadence guard. */
  force?: boolean;
  /** Put the account in that folder's slot (the slot of the rule it runs under, or the global
   *  slot when no rule applies there). */
  folder?: string;
}

/**
 * Make an account live, by id or label.
 *
 * Resolved across the whole registry so a switch reaches an account a folder rule includes. With
 * `folder`, the slot is the folder's; without it, the slot the account belonged to when it was
 * resolved — asserted on the switch, so a rule change landing in between fails the switch instead
 * of moving a slot it never named. An account several rules include has no single slot: the
 * engine picks the one it is live in, or refuses and says to name the folder.
 */
export async function switchAccount(
  ref: string,
  opts: SwitchOptions = {},
  ctx: AccountActionContext = {},
): Promise<SwitchOutcome> {
  const engine = engineOf(ctx);
  const { account, fleet } = await resolveRef(engine, ref);
  const folder = opts.folder;
  const target =
    folder !== undefined
      ? await refusalAs('bad_folder', () => switchSlotForFolder(engine, folder))
      : undefined;
  const row = fleet.find((a) => a.id === account.id);
  const slot = target?.slot ?? switchSlotOf(row);
  // A shared account switched into a folder slot is one a daemon that predates folder rules could
  // put live in the global slot as well.
  const shared = (row?.ruleIds ?? []).length === 0;
  if (slot !== undefined && slot !== 'global' && shared) {
    await refusalAs('older_daemon', () => refuseOnOlderDaemon());
  }

  let activation: ActivateResult;
  try {
    activation = await engine.activate(account.id, {
      force: Boolean(opts.force),
      origin: 'manual',
      ...(slot !== undefined ? { slot } : {}),
    });
  } catch (err) {
    throw switchRefusal(err, account.label) ?? err;
  }

  const bits = [
    activation.wroteCredentials ? 'credentials written' : 'no change',
    activation.refreshed ? 'token refreshed' : null,
    activation.adoptedPreviousRotation ? 'adopted previous rotation' : null,
  ].filter(Boolean);
  // A switch into a folder rule's slot moves that slot, not the global one — say which.
  const folderRule = await describeSwitchedGroup(engine, account.id);
  const where = folderRule
    ? ` in the folder slot of ${sanitizeForTerminal(folderRule.scopes)}`
    : target !== undefined
      ? ` in the global slot (no folder rule applies to ${sanitizeForTerminal(folder ?? '')})`
      : '';
  return {
    account,
    activation,
    folderRule,
    message: `Activated ${sanitizeForTerminal(account.label)}${where} (${bits.join(', ')}).`,
  };
}

/** Map an engine failure from `activate` onto the refusal a person reads, or undefined for a
 *  failure that is a real fault and must escape as itself. */
function switchRefusal(err: unknown, label: string): AccountActionError | undefined {
  const as = (code: AccountActionErrorCode, message: string): AccountActionError =>
    new AccountActionError(code, message, { cause: err });
  if (err instanceof QuarantineError)
    return as('quarantined', `${label} is quarantined; re-login required.`);
  if (err instanceof CadenceError) return as('cadence', `${err.message}. Use --force to override.`);
  if (err instanceof UnknownAccountError) return as('unknown_account', err.message);
  if (err instanceof SlotError) return as('slot_refused', describeSlotRefusal(err, label));
  // A switch that failed after it began writing the live login, one an earlier switch still
  // blocks, or a login stored under two accounts: the engine's message already says what the live
  // login is now and what to do, in words — it is the whole error line.
  if (
    err instanceof SwitchFailedError ||
    err instanceof UnsettledSwitchError ||
    err instanceof SharedTokenError
  ) {
    return as('switch_failed', err.message);
  }
  // The token endpoint shedding load is an outage, not a broken account: the engine has already
  // spent its retry budget and checked the status page, so its message is the whole story and
  // this switch simply did not happen.
  if (err instanceof SwitchEngineError && isOverloadCode(err.code)) {
    return as('overloaded', `${err.message}. Nothing was changed - try again shortly.`);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// exclude / include
// ---------------------------------------------------------------------------

/** What an exclude or include did. `changed` is false when the account was already in the asked
 *  state, in which case nothing was written. */
export interface ExclusionOutcome {
  account: StoredAccount;
  excluded: boolean;
  changed: boolean;
  message: string;
}

/**
 * Bar auto-switch from hopping TO an account, or lift the bar. Reports what the registry now says
 * rather than what was asked: asking for the state an account is already in is a no-op, and
 * "Excluded X" there would claim a change that did not happen.
 */
export async function setExcluded(
  ref: string,
  excluded: boolean,
  ctx: AccountActionContext = {},
): Promise<ExclusionOutcome> {
  const engine = engineOf(ctx);
  const { account } = await resolveRef(engine, ref);
  const label = account.label;
  if ((account.autoSwitchExcluded === true) === excluded) {
    return {
      account,
      excluded,
      changed: false,
      message: excluded
        ? `${label} is already excluded from auto-switch.`
        : `${label} is already available to auto-switch.`,
    };
  }
  await engine.setAutoSwitchExcluded(account.id, excluded);
  return {
    account,
    excluded,
    changed: true,
    message: excluded
      ? `Excluded ${label} from auto-switch (manual switches still work).`
      : `${label} is available to auto-switch again.`,
  };
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

/** What a rename did. `account` is the row as stored afterwards (the vault trims the label);
 *  `changed` is false when the new label was the current one and nothing was written. */
export interface RenameOutcome {
  previousLabel: string;
  account: StoredAccount;
  changed: boolean;
  message: string;
}

/** Give an account a new label; its id and usage history are unchanged. The vault asserts the
 *  label is unique across every row and non-empty, and its refusal is the error line. */
export async function renameAccount(
  ref: string,
  newLabel: string,
  ctx: AccountActionContext = {},
): Promise<RenameOutcome> {
  const engine = engineOf(ctx);
  const { account } = await resolveRef(engine, ref);
  // Answered here rather than written: nothing would change, so nothing should be saved or
  // reported as a rename.
  if (newLabel.trim() === account.label) {
    return {
      previousLabel: account.label,
      account,
      changed: false,
      message: `${account.label} already has that label.`,
    };
  }
  let updated: StoredAccount;
  try {
    updated = await engine.renameAccount(account.id, newLabel);
  } catch (err) {
    // A collision or an empty label is a user mistake carrying its own explanation; anything else
    // is a real fault and propagates.
    if (err instanceof VaultError) throw new AccountActionError('vault_refused', err.message);
    throw err;
  }
  return {
    previousLabel: account.label,
    account: updated,
    changed: true,
    message: `Renamed ${account.label} to ${updated.label} (${updated.id}).`,
  };
}

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

/** What a remove did: the row that was removed. */
export interface RemoveOutcome {
  account: StoredAccount;
  message: string;
}

/** Remove a stored account. A reserved member is dropped from its group, and a group left with no
 *  members is dissolved (the engine's job). */
export async function removeAccount(
  ref: string,
  ctx: AccountActionContext = {},
): Promise<RemoveOutcome> {
  const engine = engineOf(ctx);
  const { account } = await resolveRef(engine, ref);
  await engine.removeAccount(account.id);
  return { account, message: `Removed ${account.label}.` };
}

// ---------------------------------------------------------------------------
// add
// ---------------------------------------------------------------------------

/**
 * The interactive half of a fresh add: tell the person what to do, run a `claude` against the
 * throwaway config dir, and return once they have left it. Resolves to the launch error when the
 * window could not be opened at all, otherwise undefined (whether a login happened is read from
 * the dir afterwards). Injectable because the window owns the terminal while it runs: a caller
 * that draws its own screen must step aside first, and a test must not open one.
 */
export type LoginWindow = (captureDir: string) => Promise<Error | undefined>;

/** The default {@link LoginWindow}: the three steps on stdout, then an interactive `claude` on
 *  this terminal with `CLAUDE_CONFIG_DIR` pointed at the throwaway dir. */
export const claudeLoginWindow: LoginWindow = (captureDir) => {
  process.stdout.write(
    'Opening a throwaway Claude window. In it:\n' +
      '  1. /login - pick the NEW account in the browser (it may preselect the current one).\n' +
      '  2. Send one short message so the login completes.\n' +
      '  3. /exit\n\n',
  );
  const run = spawnSync('claude', [], {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: captureDir },
    shell: process.platform === 'win32', // `claude` is a .cmd shim on Windows; a real PATH exe on mac/linux
  });
  return Promise.resolve(run.error);
};

/** Options for {@link addAccount}, matching `cctl accounts add`'s flags. */
export interface AddOptions {
  /** Log in as a NEW account in a throwaway window instead of storing the current login. */
  fresh?: boolean;
  /** The window a fresh add runs; defaults to {@link claudeLoginWindow}. */
  loginWindow?: LoginWindow;
}

/** What an add did. `fresh` says which flow ran: a plain add also makes the account active, a
 *  fresh one leaves the live login untouched. */
export interface AddOutcome {
  account: StoredAccount;
  fresh: boolean;
  message: string;
}

/** Store a login under a label: the current live login, or (with `fresh`) a new one captured in
 *  a throwaway window. */
export async function addAccount(
  label: string,
  opts: AddOptions = {},
  ctx: AccountActionContext = {},
): Promise<AddOutcome> {
  if (opts.fresh) return addFreshAccount(label, opts.loginWindow ?? claudeLoginWindow, ctx);
  try {
    const account = await engineOf(ctx).captureCurrentLogin(label);
    return {
      account,
      fresh: false,
      message: `Added ${account.label} (${account.id}) and set it active.`,
    };
  } catch (err) {
    // A refused duplicate (label or login already stored) is the vault's own message.
    if (err instanceof VaultError) throw new AccountActionError('vault_refused', err.message);
    // Run inside a group profile, capture reads a folder-bound account's live seat — never a fresh
    // login to store. Surface the engine's own guidance instead of the no-login message.
    if (err instanceof SwitchEngineError && err.code === 'capture_in_profile') {
      throw new AccountActionError(
        'capture_in_profile',
        `${err.message}. Onboard a new account from a normal (non-folder-bound) shell, ` +
          `or use: cctl accounts add <label> --fresh.`,
      );
    }
    // Anything else is the capture finding no login to store.
    throw new AccountActionError(
      'no_live_login',
      'no live login to capture. Run `claude` and log in first, then retry.',
      { cause: err },
    );
  }
}

/**
 * The fresh capture: run the login window inside a throwaway `CLAUDE_CONFIG_DIR`, let the person
 * /login as the NEW account there, then vault what landed. The live login is never touched. The
 * throwaway dir holds real tokens, so it is deleted however the flow ends — refusals are thrown
 * from inside `withCaptureDir`, whose `finally` runs the cleanup before they escape.
 */
async function addFreshAccount(
  label: string,
  loginWindow: LoginWindow,
  ctx: AccountActionContext,
): Promise<AddOutcome> {
  const engine = engineOf(ctx);
  const paths = defaultPaths();
  let added: StoredAccount | undefined;
  await withCaptureDir(dirname(paths.vaultDir), 'capture', async (captureDir) => {
    // Darwin: the CLI writes every login to its single Keychain item regardless of
    // CLAUDE_CONFIG_DIR, so the capture must diff the Keychain around the window instead of
    // reading files from the throwaway dir — and restore the pre-window login afterwards. See
    // SwitchEngine.captureFromKeychainDelta.
    const prior = process.platform === 'darwin' ? await engine.readLiveOauth() : undefined;
    const launchError = await loginWindow(captureDir);
    if (launchError) {
      throw new AccountActionError(
        'launch_failed',
        `could not launch \`claude\`: ${launchError.message}`,
        { cause: launchError },
      );
    }
    try {
      added =
        process.platform === 'darwin'
          ? await engine.captureFromKeychainDelta(label, captureDir, prior)
          : await engine.captureFromConfigDir(label, captureDir);
    } catch (err) {
      if (err instanceof SwitchEngineError && err.code === 'no_capture_login') {
        throw new AccountActionError('no_capture_login', err.message, { cause: err });
      }
      throw err;
    }
    return undefined;
  });
  // withCaptureDir only returns after the body did, and the body only returns once `added` is set.
  const account = added!;
  return {
    account,
    fresh: true,
    message:
      `Added ${account.label} (${account.id}). Your current login was not touched - ` +
      `\`cctl switch ${account.label}\` to use it.`,
  };
}

// ---------------------------------------------------------------------------
// The command side
// ---------------------------------------------------------------------------

/** Run an action for a one-shot command: print its message as one stdout line, and turn an
 *  expected refusal into the CLI's error line and exit 1. Anything else escapes as itself. */
export async function runAccountAction(action: () => Promise<{ message: string }>): Promise<void> {
  let outcome: { message: string };
  try {
    outcome = await action();
  } catch (err) {
    if (err instanceof AccountActionError) fail(err.message);
    throw err;
  }
  process.stdout.write(`${outcome.message}\n`);
}
