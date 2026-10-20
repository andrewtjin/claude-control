// `cctl export` and `cctl import`: carry accounts, their rules and the persisted settings from one
// machine to another in a passphrase-sealed file.
//
// The pure parts live elsewhere — the seal (exportEnvelope.ts), what the file carries
// (exportPayload.ts) and what an import will do (importPlan.ts). This module runs them against
// the engine and the disk: it reads the freshest credentials one account at a time, writes the
// file through to the disk and (for `--move`) re-reads it, carries out an import plan, and says
// what happened. Every outside effect comes in through {@link TransferDeps}, so the integration
// tests drive both commands against a temporary vault with no terminal and no real home.

import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import { open, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { readHeartbeat } from '@claude-control/daemon';
import {
  ImportInterruptedError,
  LockTimeoutError,
  SwitchEngineError,
  canonicalizeFolder,
  defaultPaths,
  isWellFormedText,
  sanitizeTerminalText,
  type AccountView,
  type CredentialBundle,
  type FolderRule,
  type ImportRuleSpec,
  type RuleLiveResult,
  type SlotHandOff,
  type SlotSeat,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { buildEngine, fail } from './context.js';
import {
  ExportFileError,
  MAX_EXPORT_FILE_BYTES,
  decodeExportText,
  openExport,
  sealExport,
  type ScryptParams,
} from './exportEnvelope.js';
import { buildExportPayload, parseExportPayload, type ExportPayload } from './exportPayload.js';
import {
  parseAccountList,
  reconcileFolderGuard,
  resolveAccountRefOrEmail,
  slotName,
} from './folderCommands.js';
import { shellQuote } from './folderRender.js';
import { olderDaemonAliasReason, olderDaemonReason } from './folderRulesSupport.js';
import {
  OVERRIDDEN_CLAUSE,
  autoSwitchPhrase,
  describeRuleStep,
  handOffLine,
  includeCommand,
  keptSettingLine,
  planImport,
  planNames,
  renderImportPlan,
  ruleLines,
  ruleSpec,
  sameSettingLine,
  seatLine,
  type FolderLookup,
  type ImportPlan,
  type MemberTarget,
  type ReportNames,
  type RuleStep,
} from './importPlan.js';
import {
  ENV_WINS_NOTE,
  VERSION,
  daemonConfigPath,
  daemonHeartbeatPath,
  daemonSettingsPath,
  findDaemonEnvSetting,
  persistDaemonSetting,
  readDaemonConfigFile,
  readSettingsReport,
} from './settings.js';

/** The env var a script passes the passphrase in. */
export const PASSPHRASE_ENV = 'CCTL_EXPORT_PASSPHRASE';
/** The shortest passphrase an export is sealed with. */
export const MIN_PASSPHRASE_LENGTH = 8;
/** The largest passphrase file read: a passphrase is one line, so anything bigger is the wrong file. */
const MAX_PASSPHRASE_FILE_BYTES = 64 * 1024;

/** The engine calls these commands make — the whole surface, so a test can see what they touch. */
export type TransferEngine = Pick<
  SwitchEngine,
  | 'listAllAccounts'
  | 'listRules'
  | 'getActiveId'
  | 'exportBundle'
  | 'addAccount'
  | 'addPendingAccount'
  | 'importBundle'
  | 'checkRuleScope'
  | 'planImportRules'
  | 'importRules'
  | 'setAutoSwitchExcluded'
  | 'removeAccount'
  | 'liveSlots'
>;

/** What writing the export file found out about it. */
export interface WrittenFile {
  /** False when the file system keeps no per-user permissions, so only the passphrase guards it. */
  ownerOnly: boolean;
}

/** Every outside effect of the two commands. */
export interface TransferDeps {
  engine: TransferEngine;
  /** config.json, where the persisted settings live. */
  configPath: string;
  /** Where the report goes. */
  out: (text: string) => void;
  /** Where the export itself goes when the file is `-`. */
  writeStdout: (text: string) => void;
  /** Create the export file, never over an existing one, and only return once it is on the disk. */
  writeExportFile: (path: string, text: string) => Promise<WrittenFile | void>;
  /** Read a file back (the export, for `--move`'s check). */
  readExportFile: (path: string) => Promise<string>;
  /** The whole of standard input, when the file is `-`. */
  readStdin: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  /** Whether a person can answer a prompt (standard input is a terminal). */
  interactive: boolean;
  /** Ask for a secret without echoing it. */
  promptHidden: (question: string) => Promise<string>;
  /** Ask a yes/no question; true only for yes. */
  confirm: (question: string) => Promise<boolean>;
  /** Install or refresh the enforcement guard after rules changed. */
  reconcileGuard: () => Promise<void>;
  /** Why rules cannot be written right now (an older daemon runs), by scope kind. */
  rulesBlocked: () => Promise<{ folder?: string; alias?: string }>;
  /** A folder from a file as canonically spelled here, or why it cannot be used here. */
  resolveFolder: (folder: string) => FolderLookup;
  /** Run after settings were written, with the names that changed. */
  afterSettings: (changed: readonly string[]) => Promise<void>;
  platform: NodeJS.Platform;
  clock: () => number;
  /** The seal's scrypt parameters; tests lower them, real exports use the default. */
  scrypt?: ScryptParams;
}

/** `cctl export` options, as commander parses them (`--no-tokens` makes `tokens` false). */
export interface ExportOptions {
  accounts?: string;
  tokens: boolean;
  move: boolean;
  yes: boolean;
  passphraseFile?: string;
}

/** `cctl import` options. */
export interface ImportOptions {
  dryRun: boolean;
  replace: boolean;
  passphraseFile?: string;
}

/** What a run did, for the exit code. */
export interface TransferResult {
  /** Accounts, rules or settings that could not be carried out. */
  failed: number;
}

/** Terminal-safe text from a file, an account row or an engine message (which can quote either). */
const safe = (text: string): string => sanitizeTerminalText(text);

/** The line every run that moved tokens ends with: a refresh token is single-use, so a login only
 *  survives on one machine. */
export const ONE_MACHINE_WARNING =
  'A login works on one machine at a time: its refresh token is single-use, so once either ' +
  "machine refreshes it, the other machine's copy stops working. Keep each account on one " +
  'machine: remove it from the other with cctl accounts remove <account>, or export with --move.';

/**
 * A passphrase file's first line. The file is decoded the way a shell or editor may have written
 * it — UTF-16 by its byte-order mark, a UTF-8 byte-order mark dropped — and its first line ends at
 * any line ending (CRLF, LF or a bare CR), so the passphrase is the one the person typed into it,
 * not one with an invisible mark, a carriage return or NUL bytes sealed in (which no one could type
 * on the other machine). Bytes that are not text are refused; what the line itself may hold is
 * {@link passphraseProblem}'s to say.
 */
export function passphraseFromFile(bytes: Buffer, path: string): string {
  const text = decodeExportText(bytes);
  if (text.includes('\u0000') || text.includes('\ufffd')) {
    fail(
      `the passphrase file ${path} is not plain text; save it as UTF-8 (or UTF-16 with its ` +
        'byte-order mark)',
    );
  }
  return text.split(/\r\n|\r|\n/)[0] ?? '';
}

/**
 * Why `passphrase` cannot seal or open a file, as a phrase, or undefined when it can. A passphrase
 * has to be one a person can type again on the other machine, so it may not hold a control or
 * invisible character (a carriage return, a second byte-order mark), text that is not well formed
 * (a lone surrogate, which the key derivation reads as a replacement character, so different ones
 * collapse into the same key), or a space at either end: `echo secret > file` in cmd.exe writes
 * "secret " and that space cannot be seen. Nothing is trimmed silently, so a passphrase read from a
 * file, the environment or the prompt means the same everywhere; the person is told to fix the
 * source instead. Applied to every source, sealing and opening alike.
 */
export function passphraseProblem(passphrase: string): string | undefined {
  if (passphrase === '') return 'is empty';
  if (!isWellFormedText(passphrase)) return 'is not valid text';
  if (sanitizeTerminalText(passphrase) !== passphrase) {
    return 'holds a control or invisible character (a carriage return or a byte-order mark, say)';
  }
  if (/^\s|\s$/u.test(passphrase)) return 'starts or ends with a space';
  return undefined;
}

/**
 * The passphrase, from the first source that has one: `--passphrase-file` (its first line), the
 * env var, or a prompt (twice when sealing, so a typo is not sealed in). A prompt needs a person at
 * a terminal, and standard input free — an import reading the file from standard input cannot
 * also read a typed passphrase from it.
 */
async function readPassphrase(
  deps: TransferDeps,
  passphraseFile: string | undefined,
  mode: { sealing: boolean; stdinBusy: boolean },
): Promise<string> {
  let passphrase: string;
  let source: string;
  if (passphraseFile !== undefined) {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFileCapped(passphraseFile, MAX_PASSPHRASE_FILE_BYTES);
    } catch (err) {
      fail(`could not read the passphrase file ${passphraseFile}: ${errorText(err)}`);
    }
    if (bytes === undefined) fail(`the passphrase file ${passphraseFile} is too large`);
    passphrase = passphraseFromFile(bytes, passphraseFile);
    source = `the passphrase in ${passphraseFile}`;
  } else if ((deps.env[PASSPHRASE_ENV] ?? '') !== '') {
    passphrase = deps.env[PASSPHRASE_ENV]!;
    source = PASSPHRASE_ENV;
  } else if (!deps.interactive || mode.stdinBusy) {
    fail(
      'no passphrase: pass --passphrase-file <file>, or set ' +
        `${PASSPHRASE_ENV}${mode.stdinBusy ? '' : ', or run this in a terminal to be asked'}`,
    );
  } else {
    passphrase = await deps.promptHidden(
      mode.sealing ? 'Passphrase for the file: ' : 'Passphrase: ',
    );
    source = 'the passphrase';
    if (mode.sealing) {
      const again = await deps.promptHidden('The same passphrase again: ');
      if (again !== passphrase) fail('the two passphrases differ; nothing was written');
    }
  }
  const problem = passphraseProblem(passphrase);
  if (problem !== undefined) {
    fail(
      `${source} ${problem}; nothing was ${mode.sealing ? 'written' : 'imported'}` +
        (problem === 'is empty' ? '' : ' (no passphrase that can be typed again holds one)'),
    );
  }
  if (mode.sealing && passphrase.length < MIN_PASSPHRASE_LENGTH) {
    fail(`the passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters`);
  }
  return passphrase;
}

/** An error's message, for a report line. */
function errorText(err: unknown): string {
  return safe(err instanceof Error ? err.message : String(err));
}

/** Pick the accounts to export: the ones `--accounts` names (comma-separated labels, emails or
 *  ids), else all of them. */
function selectAccounts(all: readonly AccountView[], arg: string | undefined): AccountView[] {
  if (arg === undefined) return [...all];
  const refs = parseAccountList(arg);
  if (refs.length === 0) fail('--accounts needs at least one account, e.g. --accounts work,home');
  const out: AccountView[] = [];
  for (const ref of refs) {
    const resolved = resolveAccountRefOrEmail([...all], ref);
    if (!resolved.ok) fail(resolved.message);
    const view = all.find((a) => a.id === resolved.account.id)!;
    if (!out.includes(view)) out.push(view);
  }
  return out;
}

/** A list of labels as one phrase. */
function labelList(accounts: readonly Pick<AccountView, 'label'>[]): string {
  return accounts.map((a) => safe(a.label)).join(', ');
}

/** The credentials of each selected account that carries its tokens: the freshest copy, one engine
 *  call each. A quarantined account travels without them. */
async function readBundles(
  selected: readonly AccountView[],
  tokens: boolean,
  engine: TransferEngine,
): Promise<{ bundles: Map<string, CredentialBundle>; deadLogins: AccountView[] }> {
  const bundles = new Map<string, CredentialBundle>();
  const deadLogins: AccountView[] = [];
  if (!tokens) return { bundles, deadLogins };
  for (const account of selected) {
    if (account.quarantined) {
      deadLogins.push(account);
      continue;
    }
    try {
      bundles.set(account.id, await engine.exportBundle(account.id));
    } catch (err) {
      // The lock is the whole vault's, so leaving one account out cannot help.
      if (err instanceof LockTimeoutError) {
        fail(
          'the vault is busy: another cctl process (the daemon, or a command in another ' +
            'terminal) holds its lock. Nothing was written; try again in a moment, or stop the ' +
            'daemon first with cctl daemon stop',
        );
      }
      if (err instanceof SwitchEngineError) {
        fail(
          `could not read the credentials of "${safe(account.label)}": ${safe(err.message)}. ` +
            'Nothing was written; leave it out with --accounts, or export with --no-tokens',
        );
      }
      throw err;
    }
  }
  return { bundles, deadLogins };
}

/**
 * Seal the payload, refusing first what the import would refuse: a file no import can read is not
 * worth writing, and for `--move` it would be the only copy of the logins it removed here.
 */
async function sealPayload(
  payload: ExportPayload,
  passphrase: string,
  deps: TransferDeps,
): Promise<{ plaintext: string; sealed: string }> {
  const plaintext = JSON.stringify(payload);
  try {
    parseExportPayload(plaintext);
    return { plaintext, sealed: await sealExport(plaintext, passphrase, deps.scrypt) };
  } catch (err) {
    if (err instanceof ExportFileError) {
      fail(`this export would not import: ${safe(err.message)}. Nothing was written`);
    }
    throw err;
  }
}

/**
 * `cctl export <file|->`. Refuses before anything is read or written when it cannot finish: an
 * existing file (never overwritten), `--move` to standard output (nothing to read back), `--move`
 * of the account live on this machine's main login (removing it would leave its login live here),
 * or `--move` with nobody to answer its question and no `--yes`.
 *
 * The credentials of each account are read one call at a time, each the freshest copy (a live
 * rotation is adopted first). A quarantined account travels without them.
 *
 * With `--move`, the file is on the disk (synced) and reads back, opened with the same passphrase,
 * as exactly the payload written before anything is removed here. An account whose tokens did not
 * travel (quarantined) stays: its stored login may still work. Each removal is checked under the
 * engine's lock against what was exported — the account must still hold the refresh token in the
 * file (the daemon may have refreshed it since) and must not have become the main login's — and an
 * account failing either stays here, said so.
 */
export async function runExport(
  file: string,
  opts: ExportOptions,
  deps: TransferDeps,
): Promise<TransferResult> {
  const toStdout = file === '-';
  if (opts.move && toStdout) {
    fail(
      '--move needs a file: the export is read back and checked before anything is removed, ' +
        'and standard output cannot be read back',
    );
  }
  if (!toStdout && existsSync(file)) {
    fail(`${file} already exists; choose another name or remove it first`);
  }
  const { engine } = deps;
  const all = await engine.listAllAccounts();
  const selected = selectAccounts(all, opts.accounts);
  if (selected.length === 0) fail('there are no accounts to export');
  if (opts.move) {
    const live = await engine.getActiveId('global');
    const liveHere = selected.find((a) => a.id === live);
    if (liveHere !== undefined) {
      fail(
        `"${safe(liveHere.label)}" is the live account of this machine's main login, and removing ` +
          'it would leave that login live here; switch to another account first ' +
          '(cctl switch <account>) or leave it out with --accounts',
      );
    }
    if (!opts.yes && !deps.interactive) {
      fail('--move asks before removing anything; with no terminal to ask on, pass --yes');
    }
  }
  const passphrase = await readPassphrase(deps, opts.passphraseFile, {
    sealing: true,
    stdinBusy: false,
  });

  const { bundles, deadLogins } = await readBundles(selected, opts.tokens, engine);
  const payload = buildExportPayload({
    accounts: selected,
    allAccounts: all,
    bundles,
    rules: await engine.listRules(),
    config: await readDaemonConfigFile(deps.configPath),
    nowMs: deps.clock(),
    cctlVersion: VERSION,
    platform: deps.platform,
  });
  const { plaintext, sealed } = await sealPayload(payload, passphrase, deps);
  let written: WrittenFile | void = undefined;
  if (toStdout) deps.writeStdout(sealed);
  else written = await deps.writeExportFile(file, sealed);

  const lines: string[] = [];
  const target = toStdout ? 'standard output' : file;
  const settingCount = Object.keys(payload.settings.env).length;
  lines.push(
    `Exported ${selected.length} account${selected.length === 1 ? '' : 's'} ` +
      `(${bundles.size} with tokens), ${payload.rules.length} rule${payload.rules.length === 1 ? '' : 's'} ` +
      `and ${settingCount} setting(s) to ${target}.`,
  );
  if (written !== undefined && !written.ownerOnly) {
    lines.push(
      'This file system keeps no per-user permissions: the passphrase alone protects the file.',
    );
  }
  if (deadLogins.length > 0) {
    lines.push(
      `Quarantined here, so exported without tokens (log in on the other machine): ${labelList(deadLogins)}.`,
    );
  }

  let failed = 0;
  if (opts.move) {
    failed = await moveOut(
      file,
      plaintext,
      passphrase,
      selected,
      bundles,
      deadLogins,
      opts,
      deps,
      lines,
    );
  }
  if (bundles.size > 0) lines.push(ONE_MACHINE_WARNING);
  deps.out(lines.join('\n') + '\n');
  return { failed };
}

/** `--move`'s second half: check the file, ask, and remove each account it can (see runExport).
 *  Returns how many could not be removed. */
async function moveOut(
  file: string,
  plaintext: string,
  passphrase: string,
  selected: readonly AccountView[],
  bundles: ReadonlyMap<string, CredentialBundle>,
  deadLogins: readonly AccountView[],
  opts: ExportOptions,
  deps: TransferDeps,
  lines: string[],
): Promise<number> {
  let reopened: string;
  try {
    reopened = await openExport(await deps.readExportFile(file), passphrase);
  } catch (err) {
    fail(`the file could not be read back (${errorText(err)}); nothing was removed`);
  }
  if (reopened !== plaintext)
    fail('the file read back differs from what was written; nothing was removed');
  if (deadLogins.length > 0) {
    lines.push(
      `Kept ${labelList(deadLogins)} here: quarantined, so their tokens were not exported, and ` +
        'the login stored here may still work. Remove each with cctl accounts remove once it is ' +
        'logged in on the other machine.',
    );
  }
  const removable = selected.filter((a) => !deadLogins.includes(a));
  if (removable.length === 0) return 0;
  const go =
    opts.yes ||
    (await deps.confirm(`Remove ${labelList(removable)} from this machine now? [y/N] `));
  if (!go) {
    lines.push('Nothing was removed; the file is kept.');
    return 0;
  }
  let failed = 0;
  const removed: AccountView[] = [];
  for (const account of removable) {
    const bundle = bundles.get(account.id);
    try {
      await deps.engine.removeAccount(account.id, {
        refuseIfGloballyLive: true,
        ...(bundle !== undefined ? { expectRefreshToken: bundle.claudeAiOauth.refreshToken } : {}),
      });
      removed.push(account);
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      failed += 1;
      lines.push(`Could not remove ${safe(account.label)}: ${safe(err.message)}`);
    }
  }
  if (removed.length > 0) {
    lines.push(`Removed ${labelList(removed)} from this machine.`);
    await deps.reconcileGuard();
  }
  return failed;
}

/**
 * Read up to `max` bytes from `source`, or return undefined as soon as it holds more — reading no
 * further, so an input that never ends (a pipe, a device) costs at most `max` bytes.
 */
export async function readCapped(
  source: AsyncIterable<unknown>,
  max: number,
): Promise<Buffer | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of source) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    // Leaving the loop closes the stream.
    if (size > max) return undefined;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** A file's bytes, up to `max` (see {@link readCapped}). A size on disk is no bound: a pipe or a
 *  device reports none. */
function readFileCapped(path: string, max: number): Promise<Buffer | undefined> {
  return readCapped(createReadStream(path), max);
}

/** Read the file (or standard input), refusing one too large to be an export before holding it. */
async function readExportText(file: string, deps: TransferDeps): Promise<string> {
  if (file === '-') return deps.readStdin();
  let bytes: Buffer | undefined;
  try {
    bytes = await readFileCapped(file, MAX_EXPORT_FILE_BYTES);
  } catch (err) {
    fail(`could not read ${file}: ${errorText(err)}`);
  }
  if (bytes === undefined) fail(`${file} is too large to be a cctl export`);
  return decodeExportText(bytes);
}

/**
 * `cctl import <file|->`. Opens the file (a wrong passphrase, a changed or cut-short file, or a
 * newer format is refused before anything is read from it), plans the import against this
 * machine (the rules' part decided by the engine itself, see SwitchEngine.planImportRules), and
 * with `--dry-run` prints the plan and stops. Otherwise it carries the plan out: accounts first
 * (one engine call each), then rules (one engine call for all of them, which decides again and
 * applies that decision; see importRules), then settings. A step that is refused is reported, and
 * counted as a failure, and the rest still run.
 */
export async function runImport(
  file: string,
  opts: ImportOptions,
  deps: TransferDeps,
): Promise<TransferResult> {
  const text = await readExportText(file, deps);
  const passphrase = await readPassphrase(deps, opts.passphraseFile, {
    sealing: false,
    stdinBusy: file === '-',
  });
  let payload: ExportPayload;
  try {
    payload = parseExportPayload(await openExport(text, passphrase));
  } catch (err) {
    if (err instanceof ExportFileError) fail(`${err.message}; nothing was imported`);
    throw err;
  }
  const { engine } = deps;
  const plan = await planImport({
    payload,
    accounts: await engine.listAllAccounts(),
    rules: await engine.listRules(),
    config: await readDaemonConfigFile(deps.configPath),
    replace: opts.replace,
    platform: deps.platform,
    resolveFolder: deps.resolveFolder,
    checkScope: (scope) => {
      const check = engine.checkRuleScope(scope);
      return check.ok ? undefined : check.reason;
    },
    planRules: (specs, opts) => engine.planImportRules(specs, opts),
    env: deps.env,
    ...(payload.rules.length > 0 ? { rulesBlocked: await deps.rulesBlocked() } : {}),
  });
  const header =
    `From an export of ${payload.accounts.length} account(s) made by cctl ` +
    `${safe(payload.cctlVersion)} on ${safe(payload.platform)}, ${new Date(payload.exportedAtMs).toISOString()}.\n`;
  if (opts.dryRun) {
    deps.out(header + renderImportPlan(plan) + 'Nothing was changed (dry run).\n');
    return { failed: 0 };
  }
  const lines: string[] = [header.trimEnd()];
  let failed = 0;
  const report = (line: string, ok: boolean): void => {
    lines.push(`  ${line}`);
    if (!ok) failed += 1;
  };

  lines.push('Accounts:');
  const accounts = await importAccounts(plan, payload, engine, report);
  lines.push('Rules:');
  const rulesChanged = await importRules(plan, accounts.localIds, engine, report);
  if (rulesChanged) await deps.reconcileGuard();
  await settleAwaitingAccounts(plan, accounts.localIds, engine, report);
  lines.push('Settings:');
  const changed = await importSettings(plan, deps.configPath, report);

  if (changed.length > 0) {
    await deps.afterSettings(changed);
    lines.push(
      `Changed settings apply when the daemon next starts: cctl daemon restart. ${ENV_WINS_NOTE}`,
    );
  } else if (plan.settings.some((s) => 'overridden' in s && s.overridden === true)) {
    lines.push(ENV_WINS_NOTE);
  }
  if (accounts.pending.length > 0) {
    lines.push('Log in to each account that came without tokens:');
    for (const label of accounts.pending) {
      lines.push(`  cctl accounts relogin ${shellQuote(safe(label), deps.platform)}`);
    }
  }
  lines.push(...(await mainLoginHint(accounts, deps)));
  if (accounts.tokensArrived) lines.push(ONE_MACHINE_WARNING);
  deps.out(lines.join('\n') + '\n');
  return { failed };
}

/**
 * What to say when nothing is live on this machine's main login after the import: the account to
 * switch it to — a shared, working account auto-switch may use that is live in no folder's slot,
 * one this import added first — or, when there is none, that the main login needs one. An account
 * a rule reserves is never named:
 * switching to it would only seat it in its rule's slot and leave the main login as it was, and an
 * account kept out of auto-switch (one the file reserves to a rule that was not made) is not named
 * either, so the hint does not spend a client's account on the main login.
 */
async function mainLoginHint(
  accounts: { addedIds: readonly string[]; tokensArrived: boolean },
  deps: TransferDeps,
): Promise<string[]> {
  if ((await deps.engine.getActiveId('global')) !== null) return [];
  // An account live in a folder's slot is refused by `cctl switch` (an account is live in one slot
  // at a time), so it is no answer either.
  const live = new Set((await deps.engine.liveSlots()).values());
  const free = (await deps.engine.listAllAccounts()).filter(
    (a) =>
      (a.ruleIds ?? []).length === 0 &&
      !a.quarantined &&
      a.autoSwitchExcluded !== true &&
      !live.has(a.id),
  );
  const pick = free.find((a) => accounts.addedIds.includes(a.id)) ?? free[0];
  if (pick !== undefined) {
    return [
      "Nothing is live on this machine's main login yet; to start using an account here: " +
        `cctl switch ${shellQuote(safe(pick.label), deps.platform)}`,
    ];
  }
  if (!accounts.tokensArrived) return [];
  return [
    "Nothing is live on this machine's main login yet, and no shared account here can take it " +
      '(the accounts this import brought are reserved to folder rules or kept out of ' +
      'auto-switch); log in one for it with: cctl accounts add <label>',
  ];
}

/**
 * Settle the accounts the plan stored kept out of auto-switch until their rule took them
 * (`awaitsRule`): one a rule here now reserves goes back to auto-switch, as it was on the other
 * machine; one whose rule was not made after all (the engine refused it, or the batch failed)
 * stays kept out, said so, rather than joining the shared pool unannounced. An account the plan
 * held back because its rule would not be made (`heldBack`) goes back too, said so, when the real
 * run made that rule after all (the machine changed between the plan and the run).
 */
async function settleAwaitingAccounts(
  plan: ImportPlan,
  localIds: ReadonlyMap<number, string>,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<void> {
  const waiting = plan.accounts.filter(
    (s) => s.kind === 'add' && (s.awaitsRule === true || s.heldBack === true),
  );
  if (waiting.length === 0) return;
  const stored = await engine.listAllAccounts();
  for (const step of waiting) {
    const account = stored.find((a) => a.id === localIds.get(step.entry));
    if (account === undefined) continue;
    const include = includeCommand(account.label, plan.platform);
    const heldBack = step.kind === 'add' && step.heldBack === true;
    if ((account.ruleIds ?? []).length === 0) {
      if (heldBack) continue;
      report(
        `${safe(account.label)}: kept out of auto-switch (the rule it is reserved to was not ` +
          `made here; ${include} lets auto-switch use it)`,
        true,
      );
      continue;
    }
    try {
      await engine.setAutoSwitchExcluded(account.id, false);
      if (heldBack) {
        report(
          `${safe(account.label)}: handed back to auto-switch (the rule it is reserved to was ` +
            'made after all)',
          true,
        );
      }
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      report(
        `${safe(account.label)}: still kept out of auto-switch - ${safe(err.message)}; ${include} ` +
          'lets auto-switch use it',
        false,
      );
    }
  }
}

/** Carry out the account steps. Returns the id each entry has here, the accounts that wait for a
 *  login, the ones added with their tokens (labels and ids), and whether any tokens arrived. */
async function importAccounts(
  plan: ImportPlan,
  payload: ExportPayload,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<{
  localIds: Map<number, string>;
  pending: string[];
  addedIds: string[];
  tokensArrived: boolean;
}> {
  const localIds = new Map<number, string>();
  const pending: string[] = [];
  const addedIds: string[] = [];
  let tokensArrived = false;
  for (const step of plan.accounts) {
    const entry = payload.accounts[step.entry]!;
    const name = safe(step.kind === 'add' ? step.label : step.existing.label);
    try {
      if (step.kind === 'skip') {
        localIds.set(step.entry, step.existing.id);
        report(`${name}: ${safe(step.reason)} - left as it is`, true);
      } else if (step.kind === 'replace') {
        localIds.set(step.entry, step.existing.id);
        const res = await engine.importBundle(step.existing.id, entry.bundle!);
        if (res.replaced) tokensArrived = true;
        report(
          res.replaced
            ? `${name}: tokens replaced (${
                res.reason === 'newer'
                  ? "the file's were newer"
                  : res.reason === 'quarantined'
                    ? 'the stored login was quarantined'
                    : 'none were stored here'
              })${res.healedLiveLogin ? ', and written live where it is in use' : ''}`
            : `${name}: kept - the tokens stored here are as new as the file's or newer`,
          true,
        );
      } else {
        // The exclusion goes into the same write as the account: a lock timeout or a crash between
        // two writes would leave it stored in the pool auto-switch draws on. An account the file
        // reserves to a rule is stored kept out too, until that rule has it (settleAwaitingAccounts).
        const autoSwitchExcluded = step.autoSwitchExcluded || step.awaitsRule === true;
        const kept = { autoSwitchExcluded, ...(step.id !== undefined ? { id: step.id } : {}) };
        const identity = {
          ...(entry.accountUuid !== undefined ? { accountUuid: entry.accountUuid } : {}),
          ...(entry.emailAddress !== undefined ? { emailAddress: entry.emailAddress } : {}),
          ...(entry.organizationUuid !== undefined
            ? { organizationUuid: entry.organizationUuid }
            : {}),
        };
        const account = step.withTokens
          ? await engine.addAccount(step.label, entry.bundle!, { ...kept, identity })
          : await engine.addPendingAccount(step.label, identity, {
              ...kept,
              ...(entry.plan !== undefined ? { plan: entry.plan } : {}),
            });
        localIds.set(step.entry, account.id);
        addedIds.push(account.id);
        if (step.withTokens) {
          tokensArrived = true;
        } else {
          pending.push(account.label);
        }
        report(
          `${safe(account.label)}: added${step.withTokens ? '' : ', waiting for a login'}` +
            autoSwitchPhrase(step, plan.platform) +
            (step.renamedFrom !== undefined
              ? ` (the label "${safe(step.renamedFrom)}" is taken here)`
              : ''),
          true,
        );
      }
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      report(`${name}: not imported - ${safe(err.message)}`, false);
    }
  }
  if (plan.accounts.length === 0) report('(none in the file)', true);
  return { localIds, pending, addedIds, tokensArrived };
}

/**
 * Carry out the rule steps, all in one engine call (see SwitchEngine.importRules for why one call:
 * a rule is applied whole, every exclusion before any inclusion, and no slot is seated until every
 * reservation is in place). The engine decides again, under its lock, what the plan showed, and its
 * verdicts are reported through the same lines the plan printed (see ruleLines), so a real run
 * says what its dry run said unless this machine changed in between. A rule whose included
 * accounts all failed to import is not sent — with only its exclusions it would open its folders to
 * every shared account. The report says, per rule, what was written, the rules refused (each a
 * failure), every slot moved, and a rule a run-time failure left unwritten or half written.
 * Returns whether anything was written.
 */
async function importRules(
  plan: ImportPlan,
  localIds: ReadonlyMap<number, string>,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<boolean> {
  if (plan.rules.length === 0) {
    report('(none in the file)', true);
    return false;
  }
  const idOf = (t: MemberTarget): string | undefined =>
    t.existingId ?? (t.entry !== undefined ? localIds.get(t.entry) : undefined);
  const lines = new Map<RuleStep, { text: string[]; ok: boolean }>();
  const sent: Array<{ step: RuleStep; spec: ImportRuleSpec }> = [];
  for (const step of plan.rules) {
    const where = describeRuleStep(step);
    if (step.skip !== undefined) {
      const shown = ruleLines(step, 'done', planNames(plan));
      lines.set(step, { text: shown.lines, ok: shown.ok });
      continue;
    }
    const spec = ruleSpec(step, idOf);
    if (step.include.length > 0 && spec.include.length === 0) {
      lines.set(step, {
        text: [`${where}: not created - none of the accounts it includes could be imported`],
        ok: false,
      });
    } else if (spec.include.length + spec.exclude.length === 0) {
      lines.set(step, {
        text: [`${where}: skipped - none of its accounts were imported`],
        ok: true,
      });
    } else {
      sent.push({ step, spec });
    }
  }

  let changed = false;
  const handOffLines: string[] = [];
  /** The lines every slot the run moved gets, whether it finished or not. */
  const moved = (
    moves: { handedOff: readonly SlotHandOff[]; seated: readonly SlotSeat[] },
    names: ReportNames,
  ): void => {
    for (const hand of moves.handedOff) handOffLines.push(handOffLine(hand, 'done', names));
    for (const seat of moves.seated) handOffLines.push(seatLine(seat, 'done', names));
  };
  if (sent.length > 0) {
    // A slot is named by its rule as it was when the slot moved (before the batch grew it), as
    // the dry run names it.
    const rulesBefore = await engine.listRules();
    const namesNow = async (): Promise<ReportNames> => {
      const accounts = await engine.listAllAccounts();
      return {
        labelOf: (id) => accounts.find((a) => a.id === id)?.label ?? id,
        slotName: (slot) => slotName(slot, rulesBefore),
        platform: plan.platform,
      };
    };
    // An account the file reserves to a rule runs in no slot here but that rule's: not as the
    // replacement for a slot a rule moves, nor as the seat of a rule the import makes.
    const keepOut = plan.accounts.flatMap((s) =>
      s.kind === 'add' && s.forRule === true ? (localIds.get(s.entry) ?? []) : [],
    );
    try {
      const result = await engine.importRules(
        sent.map((s) => s.spec),
        { keepOut },
      );
      const names = await namesNow();
      changed = result.handedOff.length + result.seated.length > 0;
      for (const [k, { step }] of sent.entries()) {
        const verdict = result.plan.rules[k]!;
        const outcome = result.outcomes[k];
        const where = describeRuleStep(step);
        if (outcome !== undefined && !outcome.ok) {
          if (outcome.partial !== undefined) changed = true;
          lines.set(step, {
            text: [
              outcome.partial !== undefined
                ? `${where}: written only in part - ${safe(outcome.message)}; run the import ` +
                  'again to finish it'
                : `${where}: not ${verdict.kind === 'grow' ? 'changed' : 'created'} - ${safe(outcome.message)}`,
            ],
            ok: false,
          });
          continue;
        }
        const shown = ruleLines({ ...step, verdict }, 'done', names);
        if (outcome !== undefined) changed = true;
        lines.set(step, {
          text: [
            ...shown.lines,
            ...(outcome !== undefined
              ? slotLines(outcome.rule, outcome.live, outcome.runningSessions.length, names)
              : []),
          ],
          ok: shown.ok,
        });
      }
      moved(result, names);
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      if (err instanceof ImportInterruptedError) {
        // It stopped part-way: what it wrote and moved is in place, the guard has to hear of it, and
        // every slot it moved is reported; the next run finishes the rest.
        changed = true;
        moved(err, await namesNow());
      }
      for (const { step } of sent) {
        lines.set(step, {
          text: [`${describeRuleStep(step)}: not imported - ${safe(err.message)}`],
          ok: false,
        });
      }
    }
  }
  for (const step of plan.rules) {
    const entry = lines.get(step)!;
    const [first, ...rest] = entry.text;
    report(first!, entry.ok);
    for (const line of rest) report(`  ${line}`, true);
  }
  for (const line of handOffLines) report(line, true);
  return changed;
}

/** The lines under a rule the import wrote: a slot with no working account, a slot left as it was
 *  for the sessions running on it, and sessions that keep their account until relaunched. */
function slotLines(
  rule: FolderRule,
  live: RuleLiveResult | null,
  sessions: number,
  names: ReportNames,
): string[] {
  const out: string[] = [];
  if (live?.heldForSessions !== undefined && live.liveAccount !== null) {
    out.push(
      `its slot was left on ${safe(names.labelOf(live.liveAccount))}: ${live.heldForSessions} ` +
        'running session(s) use it, and the move the import decided on could not be made ' +
        '(cctl folders shows the slot)',
    );
  } else if (live?.heldForSessions !== undefined) {
    out.push(
      `its slot was left as it was: ${live.heldForSessions} running session(s) use it, and the ` +
        'move the import decided on could not be made (cctl folders shows the slot)',
    );
  } else if ((live?.liveAccount ?? null) === null) {
    out.push(`no account is live in its slot yet (cctl folders shows why)`);
  }
  if (sessions > 0) {
    out.push(
      `${sessions} running session(s) under ${safe(rule.label)} keep their current account until ` +
        'relaunched with: cctl claude',
    );
  }
  return out;
}

/** Carry out the setting steps through the same writer `cctl settings set` uses. Returns the names
 *  that changed. */
async function importSettings(
  plan: ImportPlan,
  configPath: string,
  report: (line: string, ok: boolean) => void,
): Promise<string[]> {
  const changed: string[] = [];
  for (const step of plan.settings) {
    if (step.kind === 'skip') {
      report(`${safe(step.name)}: skipped - ${safe(step.reason)}`, true);
    } else if (step.kind === 'same') {
      report(sameSettingLine(step), true);
    } else if (step.kind === 'kept') {
      report(keptSettingLine(step), true);
    } else {
      try {
        await persistDaemonSetting(configPath, findDaemonEnvSetting(step.name)!, step.value);
        changed.push(step.name);
        report(
          `${step.name}=${safe(step.value)}: saved${step.overridden === true ? OVERRIDDEN_CLAUSE : ''}`,
          true,
        );
      } catch (err) {
        report(`${step.name}: not saved - ${errorText(err)}`, false);
      }
    }
  }
  if (plan.settings.length === 0) report('(none in the file)', true);
  return changed;
}

// ---------------------------------------------------------------------------
// Wiring for the real process
// ---------------------------------------------------------------------------

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3);
const BACKSPACE = String.fromCharCode(8);
const DELETE = String.fromCharCode(127);

/** The 8-bit forms of the CSI and SS3 introducers (ESC `[` and ESC `O` as one character). */
const CSI_8BIT = String.fromCharCode(0x9b);
const SS3_8BIT = String.fromCharCode(0x8f);

/**
 * How long after one read the next may still carry the rest of an escape sequence the first began.
 * A terminal writes a key's whole sequence at once, so its parts follow one another within a few
 * milliseconds when they are read apart at all; a person pressing Esc and then another key is far
 * slower than this.
 */
export const ESCAPE_SEQUENCE_GAP_MS = 50;

/**
 * The keys of a hidden prompt, as typed in raw mode. Enter ends it, Backspace removes the last
 * character, Ctrl-C abandons it. A terminal sends a cursor, editing or function key (an arrow,
 * Home, End, Delete, F1) as an escape sequence; with nothing echoed the prompt cannot honor it, so
 * the whole sequence is dropped — never typed into the passphrase as invisible `[D`, `[3~` or `A`,
 * and never ending early so that the key typed after it is taken for its last byte.
 *
 * Every form a terminal sends for a key is read whole: CSI (ESC `[`, parameter bytes, then one
 * final byte — and since no key's sequence carries intermediate bytes, any byte that is not a
 * parameter ends it, so rxvt's Shift+Home `ESC [ 7 $` ends at its `$`), the Linux console's function
 * keys (ESC `[` `[` and one letter), SS3 (ESC `O`, parameters, one byte), their 8-bit forms, an ESC
 * sent twice (Alt with an arrow), and an Alt chord (ESC and a key, sent together).
 *
 * What the bytes alone cannot say is time: Esc pressed on its own and then `[` typed reads exactly
 * like the start of an arrow key's sequence split across two reads. So a sequence left open at the
 * end of a read continues into the next only when that read follows within
 * {@link ESCAPE_SEQUENCE_GAP_MS}; later than that it was a key of its own, the open sequence is
 * dropped, and the new read is typed as it stands. Nothing typed is lost to a sequence: a byte no
 * sequence can hold (Enter, Ctrl-C, Backspace, a new ESC) ends it and counts as the key it is.
 */
export class HiddenInput {
  value = '';
  state: 'typing' | 'done' | 'cancelled' = 'typing';
  /** Where in an escape sequence the input stands: none, just after ESC, just after the CSI
   *  introducer, among a CSI sequence's parameters, in a Linux console function key (one letter
   *  to come), or in an SS3 sequence. */
  private escape: 'none' | 'start' | 'csi-first' | 'csi' | 'fkey' | 'ss3' = 'none';
  /** When the read that left a sequence open arrived. */
  private openedAt = 0;

  /** `now` reads a clock that never steps back (the default is the process's monotonic one). */
  constructor(private readonly now: () => number = () => performance.now()) {}

  feed(chunk: string): void {
    const at = this.now();
    if (this.escape !== 'none' && at - this.openedAt > ESCAPE_SEQUENCE_GAP_MS) this.escape = 'none';
    for (const ch of chunk) {
      if (this.state !== 'typing') return;
      if (!this.inSequence(ch)) this.key(ch);
    }
    this.openedAt = at;
  }

  /** Feed `ch` to the escape sequence in progress: true when it belonged to it, false when it is a
   *  key of its own (no sequence is in progress, or `ch` ended one it cannot be part of). */
  private inSequence(ch: string): boolean {
    const code = ch.codePointAt(0)!;
    const printable = code >= 0x20 && code <= 0x7e;
    const parameter = code >= 0x30 && code <= 0x3f;
    switch (this.escape) {
      case 'none':
        return false;
      case 'start':
        if (ch === '[') this.escape = 'csi-first';
        else if (ch === 'O') this.escape = 'ss3';
        else if (ch !== ESC) {
          // An Alt chord when it is a key; anything else (Enter, Ctrl-C) is a key of its own.
          this.escape = 'none';
          return printable;
        }
        return true;
      case 'csi-first':
        if (ch === '[') {
          this.escape = 'fkey';
          return true;
        }
        this.escape = 'csi';
        return this.inSequence(ch);
      case 'csi':
      case 'ss3':
        if (parameter) return true;
        this.escape = 'none';
        return printable;
      case 'fkey':
        this.escape = 'none';
        return printable;
    }
  }

  /** A key typed outside any escape sequence. */
  private key(ch: string): void {
    const code = ch.codePointAt(0)!;
    if (ch === ESC) this.escape = 'start';
    else if (ch === CSI_8BIT) this.escape = 'csi-first';
    else if (ch === SS3_8BIT) this.escape = 'ss3';
    else if (ch === '\r' || ch === '\n') this.state = 'done';
    else if (ch === ETX) this.state = 'cancelled';
    else if (ch === BACKSPACE || ch === DELETE) this.value = [...this.value].slice(0, -1).join('');
    else if (code >= 0x20 && !(code >= 0x80 && code <= 0x9f)) this.value += ch;
  }
}

/** Read a secret from the terminal without echoing it (see {@link HiddenInput}). */
function promptHiddenTty(question: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const keys = new HiddenInput();
    const onData = (chunk: string): void => {
      keys.feed(chunk);
      if (keys.state === 'typing') return;
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
      if (keys.state === 'done') resolve(keys.value);
      else reject(new Error('cancelled'));
    };
    input.on('data', onData);
  });
}

/** Ask a yes/no question on the terminal. */
async function confirmTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await new Promise<string>((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

/** All of standard input, decoded as {@link decodeExportText} does. */
async function readAllStdin(): Promise<string> {
  const bytes = await readCapped(process.stdin, MAX_EXPORT_FILE_BYTES);
  if (bytes === undefined) fail('standard input is too large to be a cctl export');
  return decodeExportText(bytes);
}

/** The file system calls a folder lookup makes, injectable so a test can see that none is made. */
export interface FolderFs {
  realpath: (path: string) => string;
  isDirectory: (path: string) => boolean;
}

const REAL_FOLDER_FS: FolderFs = {
  realpath: (p) => realpathSync.native(p),
  isDirectory: (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  },
};

/** A path that starts with two separators: a network share (`\\host\share`, `//host/share`) or a
 *  Windows device or long-path form (`\\?\`, `\\.\`). */
const NETWORK_OR_DEVICE = /^[\\/]{2}/;

/**
 * A folder from a file as it is spelled here, when it is an absolute path of THIS platform to a
 * directory that exists on this machine. Nothing else touches the file system: a network or device
 * path is refused before any lookup (looking one up from a file would make Windows connect to the
 * host it names, sending the user's credentials and stalling for each unreachable one), and so is a
 * path of another platform (a POSIX `/srv/app` is not resolved to `C:\srv\app`).
 */
export function resolveFolderHere(
  folder: string,
  platform: NodeJS.Platform,
  fs: FolderFs = REAL_FOLDER_FS,
): FolderLookup {
  if (platform === 'win32') {
    if (NETWORK_OR_DEVICE.test(folder)) {
      return {
        ok: false,
        reason:
          'a network or device folder is not looked up from a file; give it a rule here with ' +
          'cctl folder include',
      };
    }
    if (!/^[A-Za-z]:[\\/]/.test(folder)) {
      return { ok: false, reason: 'it is not a folder path of this platform' };
    }
  } else if (!folder.startsWith('/')) {
    return { ok: false, reason: 'it is not a folder path of this platform' };
  }
  const canon = canonicalizeFolder(folder, {
    platform,
    cwd: process.cwd(),
    realpath: fs.realpath,
  });
  if (!canon.ok || !fs.isDirectory(canon.path)) {
    return { ok: false, reason: 'the folder does not exist on this machine' };
  }
  return { ok: true, folder: canon.path };
}

/** OWNER RIGHTS: an access entry for it applies to whoever owns the file — the user who made it. */
const OWNER_RIGHTS_SID = '*S-1-3-4';

/** Make a file readable and writable by its owner alone (Windows): drop the access it inherited
 *  from its folder, which a folder at a drive root or on a share gives every signed-in user.
 *  Returns false when the file system keeps no such permissions (a FAT USB stick). */
function restrictToOwner(path: string): boolean {
  try {
    execFileSync('icacls', [path, '/inheritance:r', '/grant:r', `${OWNER_RIGHTS_SID}:F`], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Create `path` (never over an existing file) holding `text`, for this user only, and return once
 * it is on the disk. On Windows a file's mode bits mean nothing, so its inherited permissions are
 * replaced by the owner's alone before anything is written into it; elsewhere it is created 0600.
 * The data is synced, and on POSIX the folder too, before this returns: `--move` deletes the only
 * other copy of the logins next, and those deletions are synced, so a crash just after must not
 * find them durable and the file empty.
 */
export async function writeNewFileDurably(
  path: string,
  text: string,
  opts: { platform: NodeJS.Platform; open?: typeof open },
): Promise<WrittenFile> {
  const openFile = opts.open ?? open;
  const handle = await openFile(path, 'wx', 0o600);
  let ownerOnly = true;
  try {
    if (opts.platform === 'win32') ownerOnly = restrictToOwner(path);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } catch (err) {
    await handle.close();
    await rm(path, { force: true });
    throw err;
  }
  await handle.close();
  if (opts.platform !== 'win32') {
    // Best effort: a folder some file systems will not sync still holds a synced file.
    try {
      const dir = await openFile(dirname(path), 'r');
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    } catch {
      // The file itself is on the disk.
    }
  }
  return { ownerOnly };
}

/** Why the running daemon cannot take the rules right now, by scope kind (see folderRulesSupport). */
async function rulesBlockedHere(): Promise<{ folder?: string; alias?: string }> {
  const [report, heartbeat] = await Promise.all([
    readSettingsReport(daemonSettingsPath()),
    readHeartbeat(daemonHeartbeatPath()),
  ]);
  const folder = olderDaemonReason(report, heartbeat);
  const alias = olderDaemonAliasReason(report, heartbeat);
  return {
    ...(folder !== undefined ? { folder } : {}),
    ...(alias !== undefined ? { alias } : {}),
  };
}

/** The real process's deps. `reportToStderr` keeps standard output for the export itself. */
function processDeps(reportToStderr: boolean): TransferDeps {
  const engine = buildEngine();
  const paths = defaultPaths();
  return {
    engine,
    configPath: daemonConfigPath(),
    out: (text) => void (reportToStderr ? process.stderr : process.stdout).write(text),
    writeStdout: (text) => void process.stdout.write(text),
    writeExportFile: (path, text) =>
      writeNewFileDurably(path, text, { platform: process.platform }),
    readExportFile: async (path) => {
      const bytes = await readFileCapped(path, MAX_EXPORT_FILE_BYTES);
      if (bytes === undefined) fail(`${path} is too large to be a cctl export`);
      return decodeExportText(bytes);
    },
    readStdin: readAllStdin,
    env: process.env,
    interactive: Boolean(process.stdin.isTTY),
    promptHidden: promptHiddenTty,
    confirm: confirmTty,
    reconcileGuard: () => reconcileFolderGuard(engine, paths),
    rulesBlocked: rulesBlockedHere,
    resolveFolder: (folder) => resolveFolderHere(folder, process.platform),
    afterSettings: async (changed) => {
      // The guard snapshot carries the enforcement mode; rewrite it now, as `settings set` does.
      if (!changed.includes('CCTL_BIND_ENFORCE')) return;
      try {
        await buildEngine().refreshSnapshot();
      } catch {
        // The setting is saved; the daemon rewrites the snapshot on its next pass.
      }
    },
    platform: process.platform,
    clock: Date.now,
  };
}

/** Register `cctl export` and `cctl import`. */
export function buildTransferCommands(program: Command): void {
  program
    .command('export <file>')
    .description(
      'write accounts, their folder and session rules, and the persisted settings to a ' +
        'passphrase-sealed file for another machine (- for standard output)',
    )
    .option('--accounts <accounts>', 'only these accounts (comma-separated labels, emails or ids)')
    .option(
      '--no-tokens',
      'leave the logins out: each account is logged in again on the other machine',
    )
    .option('--move', 'remove the exported accounts here once the file is written and read back')
    .option('--yes', 'with --move, remove without asking')
    .option(
      '--passphrase-file <file>',
      `read the passphrase from a file (else ${PASSPHRASE_ENV}, else ask)`,
    )
    .action(
      async (
        file: string,
        opts: {
          accounts?: string;
          tokens: boolean;
          move?: boolean;
          yes?: boolean;
          passphraseFile?: string;
        },
      ) => {
        const result = await runExport(
          file,
          {
            tokens: opts.tokens,
            move: opts.move === true,
            yes: opts.yes === true,
            ...(opts.accounts !== undefined ? { accounts: opts.accounts } : {}),
            ...(opts.passphraseFile !== undefined ? { passphraseFile: opts.passphraseFile } : {}),
          },
          processDeps(file === '-'),
        );
        if (result.failed > 0) process.exitCode = 1;
      },
    );

  program
    .command('import <file>')
    .description(
      'add the accounts, rules and settings of a file written by cctl export (- for standard ' +
        'input); each rule lands whole, growing the rule an earlier import of it made, or fails ' +
        'naming the rule here in its way',
    )
    .option(
      '--dry-run',
      'print what the import would do, decided as the real run decides it, and change nothing',
    )
    .option(
      '--replace',
      "take the file's tokens for a stored account when they are newer or the stored login is " +
        "quarantined, and the file's settings where this machine has others",
    )
    .option(
      '--passphrase-file <file>',
      `read the passphrase from a file (else ${PASSPHRASE_ENV}, else ask)`,
    )
    .action(
      async (
        file: string,
        opts: { dryRun?: boolean; replace?: boolean; passphraseFile?: string },
      ) => {
        const result = await runImport(
          file,
          {
            dryRun: opts.dryRun === true,
            replace: opts.replace === true,
            ...(opts.passphraseFile !== undefined ? { passphraseFile: opts.passphraseFile } : {}),
          },
          processDeps(false),
        );
        if (result.failed > 0) process.exitCode = 1;
      },
    );
}
