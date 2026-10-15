// `cctl export` and `cctl import`: carry accounts, their rules and the persisted settings from one
// machine to another in a passphrase-sealed file.
//
// The pure parts live elsewhere — the seal (exportEnvelope.ts), what the file carries
// (exportPayload.ts) and what an import will do (importPlan.ts). This module runs them against
// the engine and the disk: it reads the freshest credentials one account at a time, writes and
// (for `--move`) re-reads the file, carries out an import plan one engine call at a time, and says
// what happened. Every outside effect comes in through {@link TransferDeps}, so the integration
// tests drive both commands against a temporary vault with no terminal and no real home.

import { existsSync, realpathSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { createInterface } from 'node:readline';
import type { Command } from 'commander';
import { readHeartbeat } from '@claude-control/daemon';
import {
  SwitchEngineError,
  canonicalizeFolder,
  defaultPaths,
  sanitizeTerminalText,
  type AccountView,
  type CredentialBundle,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { buildEngine, fail } from './context.js';
import {
  ExportFileError,
  MAX_EXPORT_FILE_BYTES,
  openExport,
  sealExport,
  type ScryptParams,
} from './exportEnvelope.js';
import { buildExportPayload, parseExportPayload, type ExportPayload } from './exportPayload.js';
import {
  parseAccountList,
  reconcileFolderGuard,
  resolveAccountRefOrEmail,
} from './folderCommands.js';
import { olderDaemonAliasReason, olderDaemonReason } from './folderRulesSupport.js';
import {
  describeMembers,
  describeScope,
  planImport,
  renderImportPlan,
  type ImportPlan,
  type MemberTarget,
  type ScopeStep,
} from './importPlan.js';
import {
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
  | 'setAutoSwitchExcluded'
  | 'includeInFolder'
  | 'includeInAlias'
  | 'excludeInFolder'
  | 'excludeInAlias'
  | 'removeAccount'
>;

/** Every outside effect of the two commands. */
export interface TransferDeps {
  engine: TransferEngine;
  /** config.json, where the persisted settings live. */
  configPath: string;
  /** Where the report goes. */
  out: (text: string) => void;
  /** Where the export itself goes when the file is `-`. */
  writeStdout: (text: string) => void;
  /** Create the export file, never over an existing one. */
  writeExportFile: (path: string, text: string) => Promise<void>;
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
  /** A folder as canonically spelled here when it exists as a directory, else undefined. */
  resolveFolder: (folder: string) => string | undefined;
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

/** Terminal-safe text from a file or an account row. */
const safe = (text: string): string => sanitizeTerminalText(text);

/** The line every run that moved tokens ends with: a refresh token is single-use, so a login only
 *  survives on one machine. */
export const ONE_MACHINE_WARNING =
  'A login works on one machine at a time: its refresh token is single-use, so once either ' +
  "machine refreshes it, the other machine's copy stops working. Keep each account on one " +
  'machine: remove it from the other with cctl accounts remove <account>, or export with --move.';

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
    let text: string;
    try {
      text = await readFile(passphraseFile, 'utf8');
    } catch (err) {
      fail(`could not read the passphrase file ${passphraseFile}: ${errorText(err)}`);
    }
    passphrase = text.split(/\r?\n/)[0] ?? '';
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
  return err instanceof Error ? err.message : String(err);
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

/**
 * `cctl export <file|->`. Refuses before anything is read or written when it cannot finish: an
 * existing file (never overwritten), `--move` to standard output (nothing to read back), `--move`
 * of the account live on this machine's main login (removing it would leave its login live here),
 * or `--move` with nobody to answer its question and no `--yes`.
 *
 * The credentials of each account are read one call at a time, each the freshest copy (a live
 * rotation is adopted first). A quarantined account travels without them: its login is dead.
 * With `--move`, the file is read back and opened with the same passphrase, and only a payload
 * identical to the one written lets the accounts be removed here.
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
  const selected = selectAccounts(await engine.listAllAccounts(), opts.accounts);
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

  const bundles = new Map<string, CredentialBundle>();
  const deadLogins: AccountView[] = [];
  for (const account of selected) {
    if (!opts.tokens) continue;
    if (account.quarantined) {
      deadLogins.push(account);
      continue;
    }
    try {
      bundles.set(account.id, await engine.exportBundle(account.id));
    } catch (err) {
      if (err instanceof SwitchEngineError) {
        fail(
          `could not read the credentials of "${safe(account.label)}": ${err.message}. Nothing was ` +
            'written; leave it out with --accounts, or export with --no-tokens',
        );
      }
      throw err;
    }
  }

  const payload = buildExportPayload({
    accounts: selected,
    bundles,
    rules: await engine.listRules(),
    config: await readDaemonConfigFile(deps.configPath),
    nowMs: deps.clock(),
    cctlVersion: VERSION,
    platform: deps.platform,
  });
  const plaintext = JSON.stringify(payload);
  const sealed = await sealExport(plaintext, passphrase, deps.scrypt);
  if (toStdout) deps.writeStdout(sealed);
  else await deps.writeExportFile(file, sealed);

  const lines: string[] = [];
  const target = toStdout ? 'standard output' : file;
  lines.push(
    `Exported ${selected.length} account${selected.length === 1 ? '' : 's'} ` +
      `(${bundles.size} with tokens), ${payload.rules.length} rule${payload.rules.length === 1 ? '' : 's'} ` +
      `and ${Object.keys(payload.settings.env).length + (payload.settings.relayUrl !== undefined ? 1 : 0)} ` +
      `setting(s) to ${target}.`,
  );
  if (deadLogins.length > 0) {
    lines.push(
      `Quarantined here, so exported without tokens (log in on the other machine): ${labelList(deadLogins)}.`,
    );
  }

  let failed = 0;
  if (opts.move) {
    let reopened: string;
    try {
      reopened = await openExport(await deps.readExportFile(file), passphrase);
    } catch (err) {
      fail(`the file could not be read back (${errorText(err)}); nothing was removed`);
    }
    if (reopened !== plaintext)
      fail('the file read back differs from what was written; nothing was removed');
    const go =
      opts.yes ||
      (await deps.confirm(`Remove ${labelList(selected)} from this machine now? [y/N] `));
    if (!go) {
      lines.push('Nothing was removed; the file is kept.');
    } else {
      const removed: AccountView[] = [];
      for (const account of selected) {
        try {
          await engine.removeAccount(account.id);
          removed.push(account);
        } catch (err) {
          if (!(err instanceof SwitchEngineError)) throw err;
          failed += 1;
          lines.push(`Could not remove ${safe(account.label)}: ${err.message}`);
        }
      }
      if (removed.length > 0) {
        lines.push(`Removed ${labelList(removed)} from this machine.`);
        await deps.reconcileGuard();
      }
    }
  }
  if (bundles.size > 0) lines.push(ONE_MACHINE_WARNING);
  deps.out(lines.join('\n') + '\n');
  return { failed };
}

/** The ids a scope's members have here once the accounts step has run: an account of the file by
 *  the id it got (or already had), an account of this machine by its own. A member whose account
 *  could not be imported is left out. */
function memberIds(
  targets: readonly MemberTarget[],
  localIds: ReadonlyMap<number, string>,
): string[] {
  const ids = targets.flatMap(
    (t) => t.existingId ?? (t.entry !== undefined ? localIds.get(t.entry) : undefined) ?? [],
  );
  return [...new Set(ids)];
}

/** Read the file (or standard input), refusing one too large to be an export before holding it. */
async function readExportText(file: string, deps: TransferDeps): Promise<string> {
  if (file === '-') return deps.readStdin();
  let size: number;
  try {
    size = statSync(file).size;
  } catch (err) {
    fail(`could not read ${file}: ${errorText(err)}`);
  }
  if (size > MAX_EXPORT_FILE_BYTES) fail(`${file} is too large to be a cctl export`);
  return readFile(file, 'utf8');
}

/**
 * `cctl import <file|->`. Opens the file (a wrong passphrase, a changed or cut-short file, or a
 * newer format is refused before anything is read from it), plans the import against this
 * machine, and with `--dry-run` prints the plan and stops. Otherwise it carries the plan out:
 * accounts first (one engine call each), then rules (every inclusion before any exclusion; see
 * importScopes), then settings. A step that is refused is reported and the rest still run.
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
    ...(payload.rules.length > 0 ? { rulesBlocked: await deps.rulesBlocked() } : {}),
  });
  const header =
    `From an export of ${payload.accounts.length} account(s) made by cctl ` +
    `${safe(payload.cctlVersion)} on ${safe(payload.platform)}, ${new Date(payload.exportedAtMs).toISOString()}.\n`;
  if (opts.dryRun) {
    deps.out(header + renderImportPlan(plan, payload) + 'Nothing was changed (dry run).\n');
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
  const rulesChanged = await importScopes(plan, accounts.localIds, engine, report);
  if (rulesChanged) await deps.reconcileGuard();
  lines.push('Settings:');
  const changed = await importSettings(plan, deps.configPath, report);

  if (changed.length > 0) {
    await deps.afterSettings(changed);
    lines.push('Changed settings apply when the daemon next starts: cctl daemon restart');
  }
  if (accounts.pending.length > 0) {
    lines.push('Log in to each account that came without tokens:');
    for (const label of accounts.pending) lines.push(`  cctl accounts relogin ${safe(label)}`);
  }
  if (accounts.tokensArrived) lines.push(ONE_MACHINE_WARNING);
  deps.out(lines.join('\n') + '\n');
  return { failed };
}

/** Carry out the account steps. Returns the id each entry has here, the accounts that wait for a
 *  login, and whether any tokens arrived. */
async function importAccounts(
  plan: ImportPlan,
  payload: ExportPayload,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<{ localIds: Map<number, string>; pending: string[]; tokensArrived: boolean }> {
  const localIds = new Map<number, string>();
  const pending: string[] = [];
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
                    : 'the stored ones could not be read'
              })${res.healedLiveLogin ? ', and written live where it is in use' : ''}`
            : `${name}: kept - the tokens stored here are as new as the file's or newer`,
          true,
        );
      } else {
        const account = step.withTokens
          ? await engine.addAccount(step.label, entry.bundle!)
          : await engine.addPendingAccount(step.label, {
              ...(entry.accountUuid !== undefined ? { accountUuid: entry.accountUuid } : {}),
              ...(entry.emailAddress !== undefined ? { emailAddress: entry.emailAddress } : {}),
            });
        localIds.set(step.entry, account.id);
        if (entry.autoSwitchExcluded) await engine.setAutoSwitchExcluded(account.id, true);
        if (step.withTokens) tokensArrived = true;
        else pending.push(account.label);
        report(
          `${safe(account.label)}: added${step.withTokens ? '' : ', waiting for a login'}` +
            (entry.autoSwitchExcluded ? ', excluded from auto-switch' : '') +
            (step.renamedFrom !== undefined
              ? ` (the label "${safe(step.renamedFrom)}" is taken here)`
              : ''),
          true,
        );
      }
    } catch (err) {
      if (!(err instanceof SwitchEngineError)) throw err;
      report(`${name}: not imported - ${err.message}`, false);
    }
  }
  if (plan.accounts.length === 0) report('(none in the file)', true);
  return { localIds, pending, tokensArrived };
}

/** One engine rule verb for a scope: exclude or include its members. */
function scopeVerb(
  engine: TransferEngine,
  step: ScopeStep,
  verb: 'include' | 'exclude',
  ids: string[],
): Promise<unknown> {
  const folder = step.folder!;
  const label = step.ruleLabel !== undefined ? { label: step.ruleLabel } : {};
  if (step.kind === 'alias') {
    return verb === 'include'
      ? engine.includeInAlias(folder, step.alias!, ids, label)
      : engine.excludeInAlias(folder, step.alias!, ids, label);
  }
  return verb === 'include'
    ? engine.includeInFolder(folder, ids, label)
    : engine.excludeInFolder(folder, ids, label);
}

/**
 * Carry out the scope steps: every scope's inclusions first, then every scope's exclusions. An
 * inclusion moves an account out of whichever slot may no longer hold it, and refuses when that
 * slot has nothing else to run on; done first, no rule from the file has a slot yet, so the only
 * slots it can meet are the ones this machine already had. An exclusion names shared accounts
 * only, and an account the file reserves to another rule is out of every other pool already, so
 * such a member is left out of the exclusion (it would change nothing) and said so. Returns
 * whether any rule was written.
 */
async function importScopes(
  plan: ImportPlan,
  localIds: ReadonlyMap<number, string>,
  engine: TransferEngine,
  report: (line: string, ok: boolean) => void,
): Promise<boolean> {
  const failedScopes = new Map<ScopeStep, string>();
  const leftOut = new Map<ScopeStep, string[]>();
  const written = new Set<ScopeStep>();
  for (const verb of ['include', 'exclude'] as const) {
    const all = verb === 'exclude' ? await engine.listAllAccounts() : [];
    const reserved = new Set(all.filter((a) => (a.ruleIds ?? []).length > 0).map((a) => a.id));
    for (const step of plan.scopes) {
      if (step.skip !== undefined || failedScopes.has(step)) continue;
      let ids = memberIds(verb === 'include' ? step.include : step.exclude, localIds);
      if (verb === 'exclude') {
        const inert = ids.filter((id) => reserved.has(id));
        if (inert.length > 0) {
          leftOut.set(
            step,
            inert.map((id) => all.find((a) => a.id === id)?.label ?? id),
          );
        }
        ids = ids.filter((id) => !reserved.has(id));
      }
      if (ids.length === 0) continue;
      try {
        await scopeVerb(engine, step, verb, ids);
        written.add(step);
      } catch (err) {
        if (!(err instanceof SwitchEngineError)) throw err;
        failedScopes.set(step, err.message);
      }
    }
  }
  for (const step of plan.scopes) {
    const scope = describeScope(step);
    const inert = leftOut.get(step);
    const note =
      inert !== undefined
        ? ` (not excluded, as another rule reserves them: ${inert.map(safe).join(', ')})`
        : '';
    if (step.skip !== undefined) report(`${scope}: skipped - ${safe(step.skip)}`, true);
    else if (failedScopes.has(step))
      report(`${scope}: not created - ${failedScopes.get(step)!}`, false);
    else if (written.has(step)) report(`${scope}: created, ${describeMembers(step)}${note}`, true);
    else if (inert !== undefined)
      report(
        `${scope}: skipped - another rule reserves every account it excludes, so it would change nothing`,
        true,
      );
    else report(`${scope}: skipped - none of its accounts were imported`, true);
  }
  if (plan.scopes.length === 0) report('(none in the file)', true);
  return written.size > 0;
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
    } else {
      try {
        await persistDaemonSetting(configPath, findDaemonEnvSetting(step.name)!, step.value);
        changed.push(step.name);
        report(`${step.name}=${safe(step.value)}: saved`, true);
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

/** Read a secret from the terminal without echoing it. Raw mode, so each key is seen as typed:
 *  Enter ends it, Backspace removes the last character, Ctrl-C abandons the command. */
function promptHiddenTty(question: string): Promise<string> {
  const input = process.stdin;
  process.stderr.write(question);
  input.setRawMode(true);
  input.resume();
  input.setEncoding('utf8');
  const ETX = String.fromCharCode(3);
  const BACKSPACE = String.fromCharCode(8);
  const DELETE = String.fromCharCode(127);
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = (): void => {
      input.removeListener('data', onData);
      input.setRawMode(false);
      input.pause();
      process.stderr.write('\n');
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          finish();
          resolve(value);
          return;
        }
        if (ch === ETX) {
          finish();
          reject(new Error('cancelled'));
          return;
        }
        if (ch === BACKSPACE || ch === DELETE) value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
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

/** All of standard input. */
async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_EXPORT_FILE_BYTES) fail('standard input is too large to be a cctl export');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** A folder from the file as it is spelled here, when it is an absolute path to a directory that
 *  exists on this machine. A path from another platform is not absolute here, and is not resolved
 *  against the current directory. */
export function resolveFolderHere(
  folder: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isAbsolute(folder)) return undefined;
  const canon = canonicalizeFolder(folder, {
    platform,
    cwd: process.cwd(),
    realpath: (p) => realpathSync.native(p),
  });
  if (!canon.ok) return undefined;
  try {
    return statSync(canon.path).isDirectory() ? canon.path : undefined;
  } catch {
    return undefined;
  }
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
    // Created exclusively and readable by this user only: the file holds sealed logins.
    writeExportFile: (path, text) => writeFile(path, text, { flag: 'wx', mode: 0o600 }),
    readExportFile: (path) => readFile(path, 'utf8'),
    readStdin: readAllStdin,
    env: process.env,
    interactive: Boolean(process.stdin.isTTY),
    promptHidden: promptHiddenTty,
    confirm: confirmTty,
    reconcileGuard: () => reconcileFolderGuard(engine, paths),
    rulesBlocked: rulesBlockedHere,
    resolveFolder: (folder) => resolveFolderHere(folder),
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
      "replace a stored account's tokens when the file's are newer or the stored login is quarantined",
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
