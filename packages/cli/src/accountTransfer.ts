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
  LockTimeoutError,
  SwitchEngineError,
  canonicalizeFolder,
  defaultPaths,
  sanitizeTerminalText,
  type AccountView,
  type CredentialBundle,
  type FolderRule,
  type ImportRuleSpec,
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
  describeMembers,
  describeRuleExtras,
  describeRuleStep,
  keptSettingLine,
  leftOutScopeLines,
  planImport,
  renderImportPlan,
  scopeRef,
  type FolderLookup,
  type ImportPlan,
  type MemberTarget,
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
  | 'importRules'
  | 'removeAccount'
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
 * it — UTF-16 by its byte-order mark, a UTF-8 byte-order mark dropped — so the passphrase is the
 * one the person typed into it, not one with an invisible mark or NUL bytes sealed in (which no
 * one could type on the other machine). Bytes that are not text are refused.
 */
export function passphraseFromFile(bytes: Buffer, path: string): string {
  const text = decodeExportText(bytes);
  if (text.includes('\u0000') || text.includes('\ufffd')) {
    fail(
      `the passphrase file ${path} is not plain text; save it as UTF-8 (or UTF-16 with its ` +
        'byte-order mark)',
    );
  }
  return text.split(/\r?\n/)[0] ?? '';
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
  if (passphraseFile !== undefined) {
    let bytes: Buffer | undefined;
    try {
      bytes = await readFileCapped(passphraseFile, MAX_PASSPHRASE_FILE_BYTES);
    } catch (err) {
      fail(`could not read the passphrase file ${passphraseFile}: ${errorText(err)}`);
    }
    if (bytes === undefined) fail(`the passphrase file ${passphraseFile} is too large`);
    passphrase = passphraseFromFile(bytes, passphraseFile);
  } else if ((deps.env[PASSPHRASE_ENV] ?? '') !== '') {
    passphrase = deps.env[PASSPHRASE_ENV]!;
  } else if (!deps.interactive || mode.stdinBusy) {
    fail(
      'no passphrase: pass --passphrase-file <file>, or set ' +
        `${PASSPHRASE_ENV}${mode.stdinBusy ? '' : ', or run this in a terminal to be asked'}`,
    );
  } else {
    passphrase = await deps.promptHidden(
      mode.sealing ? 'Passphrase for the file: ' : 'Passphrase: ',
    );
    if (mode.sealing) {
      const again = await deps.promptHidden('The same passphrase again: ');
      if (again !== passphrase) fail('the two passphrases differ; nothing was written');
    }
  }
  if (passphrase === '') fail('the passphrase is empty');
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

/** The ids targets have here once the accounts step has run: an account of the file by the id it
 *  got (or already had), an account of this machine by its own. A member whose account could not
 *  be imported has none. */
function memberIds(
  targets: readonly MemberTarget[],
  localIds: ReadonlyMap<number, string>,
): Map<MemberTarget, string> {
  const out = new Map<MemberTarget, string>();
  for (const t of targets) {
    const id = t.existingId ?? (t.entry !== undefined ? localIds.get(t.entry) : undefined);
    if (id !== undefined && ![...out.values()].includes(id)) out.set(t, id);
  }
  return out;
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
 * machine, and with `--dry-run` prints the plan and stops. Otherwise it carries the plan out:
 * accounts first (one engine call each), then rules (one engine call for all of them; see
 * importRules), then settings. A step that is refused is reported and the rest still run.
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
  const plan = planImport({
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
    globalLive: await engine.getActiveId('global'),
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
  lines.push('Settings:');
  const changed = await importSettings(plan, deps.configPath, report);

  if (changed.length > 0) {
    await deps.afterSettings(changed);
    lines.push(
      `Changed settings apply when the daemon next starts: cctl daemon restart. ${ENV_WINS_NOTE}`,
    );
  }
  if (accounts.pending.length > 0) {
    lines.push('Log in to each account that came without tokens:');
    for (const label of accounts.pending) {
      lines.push(`  cctl accounts relogin ${shellQuote(safe(label), deps.platform)}`);
    }
  }
  const usable = accounts.addedWithTokens[0];
  if (usable !== undefined && (await engine.getActiveId('global')) === null) {
    lines.push(
      "Nothing is live on this machine's main login yet; to start using an account here: " +
        `cctl switch ${shellQuote(safe(usable), deps.platform)}`,
    );
  }
  if (accounts.tokensArrived) lines.push(ONE_MACHINE_WARNING);
  deps.out(lines.join('\n') + '\n');
  return { failed };
}

/** Carry out the account steps. Returns the id each entry has here, the accounts that wait for a
 *  login, the ones added with their tokens, and whether any tokens arrived. */
async function importAccounts(
  plan: ImportPlan,
  payload: ExportPayload,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<{
  localIds: Map<number, string>;
  pending: string[];
  addedWithTokens: string[];
  tokensArrived: boolean;
}> {
  const localIds = new Map<number, string>();
  const pending: string[] = [];
  const addedWithTokens: string[] = [];
  let tokensArrived = false;
  for (const step of plan.accounts) {
    const entry = payload.accounts[step.entry]!;
    const name = safe(step.kind === 'add' ? step.label : step.existing.label);
    try {
      if (step.kind === 'skip') {
        localIds.set(step.entry, step.existing.id);
        report(`${name}: ${step.reason} - left as it is`, true);
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
        // two writes would leave it stored in the pool auto-switch draws on.
        const identity = {
          ...(entry.accountUuid !== undefined ? { accountUuid: entry.accountUuid } : {}),
          ...(entry.emailAddress !== undefined ? { emailAddress: entry.emailAddress } : {}),
          ...(entry.organizationUuid !== undefined
            ? { organizationUuid: entry.organizationUuid }
            : {}),
        };
        const account = step.withTokens
          ? await engine.addAccount(step.label, entry.bundle!, {
              autoSwitchExcluded: step.autoSwitchExcluded,
              identity,
            })
          : await engine.addPendingAccount(step.label, identity, {
              autoSwitchExcluded: step.autoSwitchExcluded,
            });
        localIds.set(step.entry, account.id);
        if (step.withTokens) {
          tokensArrived = true;
          addedWithTokens.push(account.label);
        } else {
          pending.push(account.label);
        }
        report(
          `${safe(account.label)}: added${step.withTokens ? '' : ', waiting for a login'}` +
            autoSwitchPhrase(step) +
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
  return { localIds, pending, addedWithTokens, tokensArrived };
}

/** A rule step narrowed to the members that have an id here, with those ids. */
interface RuleWrite {
  step: RuleStep;
  include: Map<MemberTarget, string>;
  exclude: Map<MemberTarget, string>;
}

/** The line a rule step gets when it was carried out, naming the members actually written. */
function doneLine(write: RuleWrite, verb: string): string {
  const members = { include: [...write.include.keys()], exclude: [...write.exclude.keys()] };
  return `${describeRuleStep(write.step)}: ${verb}, ${describeMembers(members)}${describeRuleExtras(write.step)}`;
}

/**
 * Carry out the rule steps, all in one engine call (see SwitchEngine.importRules for why one call:
 * a rule is rebuilt whole, every exclusion before any inclusion, and no slot is seated until every
 * reservation is in place). A rule whose included accounts all failed to import is not made — with
 * only its exclusions it would open its folders to every shared account. The report says, per rule,
 * what was written (the members that made it), the slots moved first, and the rules the engine
 * refused. Returns whether anything was written.
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
  const lines = new Map<RuleStep, { text: string[]; ok: boolean }>();
  const writes: RuleWrite[] = [];
  for (const step of plan.rules) {
    const where = describeRuleStep(step);
    if (step.skip !== undefined) {
      lines.set(step, { text: [`${where}: skipped - ${safe(step.skip)}`], ok: true });
      continue;
    }
    const write = {
      step,
      include: memberIds(step.include, localIds),
      exclude: memberIds(step.exclude, localIds),
    };
    if (step.include.length > 0 && write.include.size === 0) {
      lines.set(step, {
        text: [`${where}: not created - none of the accounts it includes could be imported`],
        ok: false,
      });
    } else if (write.include.size + write.exclude.size === 0) {
      lines.set(step, {
        text: [`${where}: skipped - none of its accounts were imported`],
        ok: true,
      });
    } else {
      writes.push(write);
    }
  }

  let changed = false;
  const handOffLines: string[] = [];
  if (writes.length > 0) {
    const specs: ImportRuleSpec[] = writes.map(({ step, include, exclude }) => ({
      scopes: step.scopes.filter((s) => s.skip === undefined).map(scopeRef),
      include: [...include.values()],
      exclude: [...exclude.values()],
      ...(step.label !== undefined ? { label: step.label } : {}),
      ...(step.into !== undefined ? { intoRuleId: step.into.id } : {}),
    }));
    try {
      const result = await engine.importRules(specs);
      changed = result.handedOff.length > 0;
      const rules = await engine.listRules();
      const accounts = await engine.listAllAccounts();
      const labelOf = (id: string): string => safe(accounts.find((a) => a.id === id)?.label ?? id);
      for (const [i, write] of writes.entries()) {
        const outcome = result.rules[i]!;
        const where = describeRuleStep(write.step);
        if (!outcome.ok) {
          if (outcome.partial !== undefined) changed = true;
          lines.set(write.step, {
            text: [
              outcome.partial !== undefined
                ? `${where}: written only in part - ${safe(outcome.message)}; run the import ` +
                  'again to finish it'
                : `${where}: not ${write.step.into !== undefined ? 'changed' : 'created'} - ${safe(outcome.message)}`,
            ],
            ok: false,
          });
          continue;
        }
        changed = true;
        lines.set(write.step, {
          text: [
            doneLine(write, outcome.created ? 'created' : 'added to the rule here'),
            ...leftOutScopeLines(write.step),
            ...slotLines(
              outcome.rule,
              outcome.live?.liveAccount ?? null,
              outcome.runningSessions.length,
            ),
          ],
          ok: true,
        });
      }
      for (const h of result.handedOff) {
        handOffLines.push(
          `${safe(slotName(h.slot, rules))} switched off ${labelOf(h.from)} (now reserved) and is ` +
            `on ${labelOf(h.to)}`,
        );
      }
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      for (const write of writes) {
        lines.set(write.step, {
          text: [`${describeRuleStep(write.step)}: not created - ${safe(err.message)}`],
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

/** The lines under a rule the import wrote: a slot with no working account, and sessions that keep
 *  their account until relaunched. */
function slotLines(rule: FolderRule, liveAccount: string | null, sessions: number): string[] {
  const out: string[] = [];
  if (liveAccount === null) {
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
      report(`${step.name}=${safe(step.value)}: already set`, true);
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

/**
 * The keys of a hidden prompt, as typed in raw mode. Enter ends it, Backspace removes the last
 * character, Ctrl-C abandons it. A terminal sends a cursor or editing key (an arrow, Home, End,
 * Delete) as an escape sequence; with nothing echoed the prompt cannot honor it, so the whole
 * sequence is dropped — never typed into the passphrase as invisible `[D` or `[3~`. A sequence may
 * arrive split across reads, so where one stands is kept between them.
 */
export class HiddenInput {
  value = '';
  state: 'typing' | 'done' | 'cancelled' = 'typing';
  /** Where in an escape sequence the input stands: none, just after ESC, in a CSI sequence (ESC
   *  `[` parameters, then one final byte), or in an SS3 one (ESC `O`, then one byte). */
  private escape: 'none' | 'start' | 'csi' | 'ss3' = 'none';

  feed(chunk: string): void {
    for (const ch of chunk) {
      if (this.state !== 'typing') return;
      if (this.escape === 'start') {
        this.escape = ch === '[' ? 'csi' : ch === 'O' ? 'ss3' : 'none';
        continue;
      }
      if (this.escape === 'ss3') {
        this.escape = 'none';
        continue;
      }
      if (this.escape === 'csi') {
        if (ch >= '@' && ch <= '~') this.escape = 'none';
        continue;
      }
      if (ch === ESC) this.escape = 'start';
      else if (ch === '\r' || ch === '\n') this.state = 'done';
      else if (ch === ETX) this.state = 'cancelled';
      else if (ch === BACKSPACE || ch === DELETE)
        this.value = [...this.value].slice(0, -1).join('');
      else if (ch >= ' ') this.value += ch;
    }
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
      'add the accounts, rules and settings of a file written by cctl export (- for standard input)',
    )
    .option('--dry-run', 'print what would be done, and change nothing')
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
