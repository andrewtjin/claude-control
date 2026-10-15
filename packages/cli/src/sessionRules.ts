// `cctl session include | exclude | reset`: a rule of its own for one named session — a session
// ALIAS (its custom title, as `claude --resume` matches it) in one folder.
//
// A session alias's rule is a folder rule in every other way: it includes accounts (reserved to it,
// used first), excludes shared ones, inherits the rest of the shared pool, and has its own slot and
// profile. It applies to the sessions titled so whose conversation was RECORDED in that exact folder
// (wherever they are resumed from), and it outranks every folder rule — including the one of its
// own folder, whose rules it does not merge with. The engine owns the state machine (includeInAlias
// / excludeInAlias / resetAlias, the folder verbs' twins); this module only decides WHICH alias and
// folder, resolves the accounts — always named, never the account in use, as for folders — and says
// what changed, reusing the folder verbs' reports. When THIS command runs inside a session that is
// now on another slot than its rule names, it says so, with the command that resumes it.
//
// Every alias, folder and label printed passes sanitizeForTerminal: titles come from transcripts and
// are untrusted text.

import {
  canonicalizeFolder,
  exactAliasRule,
  ruleSlotId,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { readSessionCatalog, type SessionMeta } from '@claude-control/daemon';
import { detectPalette, sanitizeForTerminal, type Palette } from './ansi.js';
import { buildEngine, fail } from './context.js';
import {
  changeContext,
  describeExclude,
  describeInclude,
  describeReset,
  engineCall,
  reconcileFolderGuard,
  refuseOnOlderDaemonForAliases,
  resolveAccountArg,
} from './folderCommands.js';
import { resumeSessionCommand } from './folderRender.js';
import { SESSION_ID_ENV, type SessionAliasDeps } from './sessionAliases.js';

export interface SessionRuleOptions {
  /** The folder the alias lives in; default = this session's recorded folder when the alias is this
   *  session's own, else the process cwd. */
  cwd?: string;
  /** Display name for a rule this command creates (ignored for an existing one). */
  label?: string;
  /** Go ahead although running sessions would lose the slot's account. */
  force?: boolean;
}

/** {@link SessionAliasDeps} plus the edges a WRITE needs (defaulting to the real ones). Tests also
 *  pass SessionAliasDeps.engine: an engine over a sandbox vault. */
export interface SessionRuleDeps extends SessionAliasDeps {
  /** Re-wire the enforcement guard after a change (installs it with the first rule). */
  reconcileGuard?: (engine: SwitchEngine) => Promise<void>;
  /** Refuse while a daemon that cannot honor alias rules runs (see folderRulesSupport.ts). */
  refuseOnOlderDaemon?: () => Promise<void>;
}

/** The alias and folder a command acts on, and the current session if there is one. */
interface AliasTarget {
  alias: string;
  /** Absolute and normalized, as spelled: links are NOT resolved here. The engine resolves them,
   *  and keeps this spelling to find the rule of a folder since moved and replaced by a link. */
  folder: string;
  current: SessionMeta | null;
}

/** A custom title that counts as a name: non-blank (a blank custom title hides the generated one
 *  from `claude --resume` and names nothing). */
function customTitleOf(meta: SessionMeta | null): string | null {
  const t = meta?.customTitle ?? null;
  return t !== null && t.trim() !== '' ? t : null;
}

/** The session this command runs inside (`CLAUDE_CODE_SESSION_ID` -> its transcript), or null when
 *  not in a session or its transcript is not written yet. Reads only that one transcript. */
async function currentSession(deps: SessionAliasDeps): Promise<SessionMeta | null> {
  const id = deps.env[SESSION_ID_ENV]?.trim();
  if (id === undefined || id === '') return null;
  const catalog = await readSessionCatalog({
    claudeDir: deps.paths.claudeDir,
    sessionIds: new Set([id]),
  });
  return catalog.sessions.find((s) => s.sessionId.toLowerCase() === id.toLowerCase()) ?? null;
}

/**
 * Decide the alias and folder. The alias is always named (a session's title changes under the
 * operator, so nothing stands in for it). The folder is `--cwd`, else — when the alias is THIS
 * session's own custom title — the folder its conversation was recorded in (the guard judges a
 * session by that folder, not by wherever a tool has cd'ed), else the cwd. The engine applies each
 * verb's own checks to it (a reset may name a folder since deleted, or moved and replaced by a
 * link).
 */
async function resolveAliasTarget(
  alias: string,
  cwdOpt: string | undefined,
  deps: SessionAliasDeps,
): Promise<AliasTarget> {
  if (alias.trim() === '')
    fail('name the session alias, e.g. cctl session include "auth work" work');
  const current = await currentSession(deps);
  const currentCustom = customTitleOf(current);
  const aboutCurrent =
    currentCustom !== null && currentCustom.toLowerCase().trim() === alias.toLowerCase().trim();
  const folderInput =
    cwdOpt ?? (aboutCurrent && current?.folder != null ? current.folder : deps.cwd);
  const spelled = canonicalizeFolder(folderInput, { platform: deps.platform, cwd: deps.cwd });
  if (!spelled.ok) {
    fail(`cannot use folder "${sanitizeForTerminal(folderInput)}": ${spelled.reason}`);
  }
  return { alias, folder: spelled.path, current };
}

/**
 * When THIS command runs inside a Claude Code session that is now on another slot than the one its
 * rule names, say so plainly: it stays on its slot until it exits (following whatever account is
 * live there), and how to resume it on its rule's accounts. Nothing is said for a session on a
 * config dir cctl does not manage (its slot is unknown), nor for one on the global slot whose rule
 * accepts it (the guard tells it once, on its next prompt).
 */
async function currentSessionNote(
  engine: SwitchEngine,
  deps: SessionAliasDeps,
  current: SessionMeta | null,
  palette: Palette,
): Promise<string | null> {
  if (current === null || current.folder === null) return null;
  const title = customTitleOf(current);
  const required = await engine.resolveSessionRule(current.folder, title);
  const requiredSlot = required === null ? 'global' : ruleSlotId(required.ruleId);
  const slot = await engine.recognizedSlotForConfigDir(deps.env.CLAUDE_CONFIG_DIR ?? null);
  if (slot === null || slot === requiredSlot) return null;
  const resume =
    title === null
      ? 'start it again here with: cctl claude'
      : `resume it with: ${resumeSessionCommand(current.sessionId, title)}`;
  if (slot === 'global') {
    return palette.yellow(
      `This session runs on the global slot, which its rule accepts unless it excludes that ` +
        `account; to use the rule's own accounts, exit and ${resume}`,
    );
  }
  return palette.yellow(
    `This session now runs on another rule's slot: it stays there until it exits, and the guard ` +
      `will flag its next prompt. Exit and ${resume}`,
  );
}

/** What every write ends with: the current session's note, the report, and the guard re-wired. */
async function finish(
  engine: SwitchEngine,
  deps: SessionRuleDeps,
  target: AliasTarget,
  report: string,
): Promise<void> {
  const note = await currentSessionNote(engine, deps, target.current, detectPalette());
  deps.write(report + (note !== null ? '\n' + note : '') + '\n');
  // Wire the guard now (installed with the first rule, refreshed into every profile), so the rule
  // is enforced without waiting for a daemon restart.
  await (deps.reconcileGuard ?? ((e) => reconcileFolderGuard(e, deps.paths)))(engine);
}

/** `cctl session include <alias> <accounts>`: reserve accounts to a named session and use them
 *  there first, creating its rule when it has none. */
export async function runSessionInclude(
  alias: string,
  accountsArg: string,
  options: SessionRuleOptions,
  deps: SessionRuleDeps,
): Promise<void> {
  await (deps.refuseOnOlderDaemon ?? refuseOnOlderDaemonForAliases)();
  const engine = deps.engine ?? buildEngine(deps.paths);
  const target = await resolveAliasTarget(alias, options.cwd, deps);
  const ids = await resolveAccountArg(engine, 'include', accountsArg, 'session');
  const result = await engineCall(() =>
    engine.includeInAlias(
      target.folder,
      target.alias,
      ids,
      options.label !== undefined ? { label: options.label } : {},
    ),
  );
  const ctx = await changeContext(engine, deps.paths.vaultDir);
  await finish(engine, deps, target, describeInclude(result, ids, ctx, options.label));
}

/** `cctl session exclude <alias> <accounts>`: keep a named session off shared accounts, in a slot
 *  of its own. */
export async function runSessionExclude(
  alias: string,
  accountsArg: string,
  options: SessionRuleOptions,
  deps: SessionRuleDeps,
): Promise<void> {
  await (deps.refuseOnOlderDaemon ?? refuseOnOlderDaemonForAliases)();
  const engine = deps.engine ?? buildEngine(deps.paths);
  const target = await resolveAliasTarget(alias, options.cwd, deps);
  const ids = await resolveAccountArg(engine, 'exclude', accountsArg, 'session');
  const result = await engineCall(() =>
    engine.excludeInAlias(target.folder, target.alias, ids, {
      ...(options.label !== undefined ? { label: options.label } : {}),
      ...(options.force === true ? { force: true } : {}),
    }),
  );
  const ctx = await changeContext(engine, deps.paths.vaultDir);
  await finish(engine, deps, target, describeExclude(result, ids, ctx, options.label));
}

/** `cctl session reset <alias> [accounts]`: drop named accounts from a named session's rule, or —
 *  with none named — remove the rule, so the session runs under its folder's rule again. Removing the
 *  whole rule is left open beside an older daemon (it is how an operator backs out of an alias rule
 *  such a daemon cannot read); dropping accounts is not. */
export async function runSessionReset(
  alias: string,
  accountsArg: string | undefined,
  options: SessionRuleOptions,
  deps: SessionRuleDeps,
): Promise<void> {
  if (accountsArg !== undefined) {
    await (deps.refuseOnOlderDaemon ?? refuseOnOlderDaemonForAliases)();
  }
  const engine = deps.engine ?? buildEngine(deps.paths);
  const target = await resolveAliasTarget(alias, options.cwd, deps);
  const ids =
    accountsArg === undefined
      ? undefined
      : await resolveAccountArg(engine, 'reset', accountsArg, 'session');
  const rulesBefore = await engine.listRules();
  const result = await engineCall(() =>
    engine.resetAlias(
      target.folder,
      target.alias,
      ids,
      options.force === true ? { force: true } : {},
    ),
  );
  const before = exactAliasRule(
    result.folder,
    result.alias ?? target.alias,
    rulesBefore,
    deps.platform,
  );
  const liveAfter =
    result.rule === undefined
      ? null
      : ((await engine.liveSlots()).get(ruleSlotId(result.rule.id)) ?? null);
  const ctx = await changeContext(engine, deps.paths.vaultDir);
  await finish(engine, deps, target, describeReset(result, before, liveAfter, ctx, ids));
}
