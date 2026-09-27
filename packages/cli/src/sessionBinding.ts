// `cctl session bind` / `cctl session unbind`: bind a session ALIAS — a custom title in one folder —
// to accounts, grow or shrink that account list, or drop the binding.
//
// The engine owns the state machine (bindAlias / unbindAlias / addGroupMembers / removeGroupMembers,
// each crash-safe under the credential lock); this module only decides WHAT to ask for: which alias
// and folder (default: this session's own custom title and folder), which accounts (default: the one
// this session runs on right now), and whether a bind is a new binding or growing an existing one.
// Then it says, plainly, what moved — including when THIS session is now outside its binding.
//
// Every alias, folder and label printed passes sanitizeForTerminal: titles come from transcripts and
// are untrusted text.

import { realpathSync } from 'node:fs';
import {
  SwitchEngineError,
  aliasKey,
  aliasScopeUniquenessKey,
  canonicalizeFolder,
  describeGroupScopes,
  exactAliasBinding,
  groupProfileDir,
  groupScopeCount,
  groupSlotId,
  resolveAccountRef,
  type AccountView,
  type StoredAccount,
  type StoredGroup,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { readSessionCatalog, type SessionMeta } from '@claude-control/daemon';
import { detectPalette, sanitizeForTerminal, type Palette } from './ansi.js';
import { buildEngine, fail } from './context.js';
import { reconcileBindGuard } from './bindCommands.js';
import { resumeCommand, resumeSessionCommand, shellQuote } from './render.js';
import { SESSION_ID_ENV, type SessionAliasDeps } from './sessionAliases.js';

export interface SessionBindOptions {
  /** The folder the alias lives in; default = this session's folder when binding this session's own
   *  alias, else the process cwd. */
  cwd?: string;
  /** Display name for a NEW binding's group (ignored when growing an existing one). */
  label?: string;
}

export interface SessionUnbindOptions {
  cwd?: string;
  /** Comma-separated account refs: shrink the list instead of dropping the binding. */
  accounts?: string;
  /** Dissolve even when sessions are observed running in the binding. */
  force?: boolean;
}

/** {@link SessionAliasDeps} plus the one extra edge a WRITE needs (defaulting to the real one). Tests
 *  also pass SessionAliasDeps.engine: an engine over a sandbox vault, which the default protector
 *  could not read. */
export interface SessionBindDeps extends SessionAliasDeps {
  /** Re-wire the enforcement guard after a change (installs it on the first binding). */
  reconcileGuard?: (engine: SwitchEngine) => Promise<void>;
}

/** The alias and folder a command acts on, and the current session if there is one. */
interface AliasTarget {
  alias: string;
  /** Canonical. */
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
 * Decide the alias and folder. With no alias argument the alias is THIS session's custom title —
 * refused outside a session, and refused (with the fix) when the session only has a generated title,
 * because only a custom title binds (a generated one changes under the operator). The folder is
 * `--cwd`, else — when the alias is this session's own — the session's recorded folder (the guard
 * judges a session by its project folder, not by wherever a tool has cd'ed), else the cwd.
 */
async function resolveAliasTarget(
  aliasArg: string | undefined,
  cwdOpt: string | undefined,
  verb: 'bind' | 'unbind',
  deps: SessionAliasDeps,
): Promise<AliasTarget> {
  const sessionId = deps.env[SESSION_ID_ENV]?.trim();
  const current = await currentSession(deps);
  const currentCustom = customTitleOf(current);
  let alias: string;
  if (aliasArg === undefined || aliasArg.trim() === '') {
    if (sessionId === undefined || sessionId === '') {
      fail(
        `no alias given, and this is not a Claude Code session (${SESSION_ID_ENV} is unset). ` +
          `Pass one: cctl session ${verb} <alias>`,
      );
    }
    if (current === null) {
      fail(
        `this session (${sanitizeForTerminal(sessionId)}) has no transcript yet, so its name is ` +
          `unknown; pass the alias: cctl session ${verb} <alias>`,
      );
    }
    if (currentCustom === null) {
      const generated = current.aiTitle !== null && current.aiTitle.trim() !== '';
      fail(
        'this session has no name of its own' +
          (generated
            ? ` (only the generated title "${sanitizeForTerminal(current.aiTitle!)}")`
            : '') +
          '; name it first: /rename <alias>',
      );
    }
    alias = currentCustom;
  } else {
    alias = aliasArg;
  }
  const aboutCurrent = currentCustom !== null && aliasKey(currentCustom) === aliasKey(alias);
  const folderInput =
    cwdOpt ?? (aboutCurrent && current?.folder != null ? current.folder : deps.cwd);
  const canon = canonicalizeFolder(folderInput, {
    platform: deps.platform,
    cwd: deps.cwd,
    realpath: (p) => realpathSync.native(p),
  });
  if (!canon.ok) {
    fail(`cannot use folder "${sanitizeForTerminal(folderInput)}": ${canon.reason}`);
  }
  return { alias, folder: canon.path, current };
}

/** Resolve comma-separated account refs across the whole registry (shared + reserved), de-duped. */
async function resolveRefs(engine: SwitchEngine, refsArg: string): Promise<string[]> {
  const refs = refsArg
    .split(',')
    .map((r) => r.trim())
    .filter((r) => r.length > 0);
  if (refs.length === 0) fail('no accounts given, e.g. work@me.com,client');
  const all = (await engine.listAllAccounts()) as StoredAccount[];
  const ids: string[] = [];
  for (const ref of refs) {
    const r = resolveAccountRef(all, ref);
    if (!r.ok) fail(r.message);
    if (!ids.includes(r.account.id)) ids.push(r.account.id);
  }
  return ids;
}

/** The account this session runs on RIGHT NOW: its slot (from the session's own, RAW
 *  CLAUDE_CONFIG_DIR — the main config dir or unset for the global slot, a live group profile for
 *  that group's) and that slot's reconciled live account. A config dir cctl does not manage is
 *  refused rather than guessed: its account is unknown, and defaulting to the global one would bind
 *  (and move the global slot off) an account this session is not on. */
async function currentAccountId(engine: SwitchEngine, deps: SessionAliasDeps): Promise<string> {
  const sessionId = deps.env[SESSION_ID_ENV]?.trim();
  if (sessionId === undefined || sessionId === '') {
    fail(
      'pass the accounts to bind: this is not a Claude Code session, so there is no current ' +
        'account to default to (cctl session bind <alias> <account>[,<account>...])',
    );
  }
  const configDir = deps.env.CLAUDE_CONFIG_DIR ?? null;
  const slot = await engine.recognizedSlotForConfigDir(configDir);
  if (slot === null) {
    fail(
      `cannot tell which account this session runs on: its CLAUDE_CONFIG_DIR ` +
        `(${sanitizeForTerminal(configDir ?? '')}) is neither the main config dir nor a bound ` +
        'profile. Pass the accounts: cctl session bind <alias> <account>[,<account>...]',
    );
  }
  const live = await engine.getActiveId(slot);
  if (live === null) {
    fail(
      'cannot tell which account this session runs on (its slot has no live account); pass the ' +
        'accounts: cctl session bind <alias> <account>[,<account>...]',
    );
  }
  return live;
}

function labelsOf(ids: readonly string[], all: readonly AccountView[]): string {
  return ids.map((id) => sanitizeForTerminal(all.find((a) => a.id === id)?.label ?? id)).join(', ');
}

function membersOf(group: StoredGroup): string {
  return group.members.map((m) => sanitizeForTerminal(m.label)).join(', ');
}

/** `session "<alias>" in <folder>`, sanitized for the terminal. */
function scopeText(alias: string, folder: string): string {
  return `session "${sanitizeForTerminal(alias)}" in ${sanitizeForTerminal(folder)}`;
}

/** The other scopes of a group (all but this alias scope, matched by its uniqueness key), for the
 *  "would change theirs too" refusal and the reuse notice. */
function otherScopes(
  group: StoredGroup,
  alias: string,
  folder: string,
  platform: NodeJS.Platform,
): string {
  const mine = aliasScopeUniquenessKey(folder, alias, platform);
  const others: StoredGroup = {
    ...group,
    aliases: (group.aliases ?? []).filter(
      (a) => aliasScopeUniquenessKey(a.folder, a.alias, platform) !== mine,
    ),
  };
  return sanitizeForTerminal(describeGroupScopes(others));
}

/** Lines describing the global hand-off and the slot's readiness, shared by bind and grow. */
async function slotLines(
  engine: SwitchEngine,
  deps: SessionAliasDeps,
  palette: Palette,
  group: StoredGroup,
  moved: { movedOffGlobal: string | null; globalSwitchedTo: string | null },
  live: { liveMember: string | null; noWorkingAccount: boolean },
): Promise<string[]> {
  const all = await engine.listAllAccounts();
  const lines: string[] = [];
  if (moved.movedOffGlobal !== null) {
    lines.push(
      `  global slot switched off ${labelsOf([moved.movedOffGlobal], all)} (it is now reserved to ` +
        `this binding); global is now on ${moved.globalSwitchedTo ? labelsOf([moved.globalSwitchedTo], all) : 'none'}.`,
    );
  }
  if (live.noWorkingAccount) {
    lines.push(
      palette.red(
        '  the binding has no working account (all quarantined); re-login one: ' +
          'cctl accounts relogin <ref>',
      ),
    );
  } else {
    const profile = sanitizeForTerminal(groupProfileDir(deps.paths.vaultDir, group.id));
    lines.push(
      `  profile ready on ${live.liveMember ? labelsOf([live.liveMember], all) : 'a member'}: ${profile}`,
    );
  }
  return lines;
}

/**
 * When THIS command runs inside a Claude Code session that is now outside its binding (its slot is
 * not the one the precedence rule names for it), say so plainly: it stays on its slot until it exits
 * (following whatever account is live there — a running session picks up its slot's current login
 * on its next request), the guard will flag its next prompt, and how to resume it on the bound
 * account. Nothing is said for a session on a config dir cctl does not manage (its slot is unknown).
 */
async function currentSessionNote(
  engine: SwitchEngine,
  deps: SessionAliasDeps,
  current: SessionMeta | null,
  palette: Palette,
): Promise<string | null> {
  if (current === null || current.folder === null) return null;
  const title = customTitleOf(current);
  const required = await engine.resolveSessionBinding(current.folder, title);
  const requiredSlot = required === null ? 'global' : groupSlotId(required.groupId);
  const slot = await engine.recognizedSlotForConfigDir(deps.env.CLAUDE_CONFIG_DIR ?? null);
  if (slot === null || slot === requiredSlot) return null;
  const all = await engine.listAllAccounts();
  const liveNow = await engine.getActiveId(slot);
  const where = slot === 'global' ? 'the global slot' : 'its binding’s slot';
  const on = liveNow === null ? where : `${where} (now ${labelsOf([liveNow], all)})`;
  const resume =
    title === null
      ? 'start it again here with: cctl claude'
      : `resume it on the bound account with: ${resumeSessionCommand(current.sessionId, title)}`;
  return palette.yellow(
    `This session is now outside its binding: it stays on ${on} until it exits, and the guard ` +
      `will flag its next prompt. Exit and ${resume}`,
  );
}

/** Run an engine call, turning its refusals into CLI failures (their messages are operator-facing). */
async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SwitchEngineError) fail(err.message);
    throw err;
  }
}

/**
 * `cctl session bind [alias] [accounts]`.
 *
 * (folder, alias) unbound -> bind it to a group with exactly those accounts (reusing the group with
 * that exact set, else creating one: the V1 rules, refusals included). Already bound to a group A ->
 * ADD the accounts to A ("add this session to the list of accounts used by that alias") — unless A
 * also carries other scopes, where growing A would silently grow those too: refused, with the fix.
 */
export async function runSessionBind(
  aliasArg: string | undefined,
  accountsArg: string | undefined,
  options: SessionBindOptions,
  deps: SessionBindDeps,
): Promise<void> {
  const engine = deps.engine ?? buildEngine(deps.paths);
  const palette = detectPalette();
  const target = await resolveAliasTarget(aliasArg, options.cwd, 'bind', deps);
  const ids =
    accountsArg !== undefined
      ? await resolveRefs(engine, accountsArg)
      : [await currentAccountId(engine, deps)];
  const scope = scopeText(target.alias, target.folder);
  const groups = await engine.listGroups();
  const ownerId = exactAliasBinding(target.folder, target.alias, groups, deps.platform);
  const lines: string[] = [];

  if (ownerId === null) {
    const res = await engineCall(() =>
      engine.bindAlias(
        target.folder,
        target.alias,
        ids,
        options.label !== undefined ? { label: options.label } : {},
      ),
    );
    lines.push(
      res.created
        ? `Bound ${scope} to ${membersOf(res.group)}.`
        : `Bound ${scope} to the existing binding ${sanitizeForTerminal(res.group.label)} ` +
            `(${membersOf(res.group)}), which also covers ` +
            `${otherScopes(res.group, target.alias, target.folder, deps.platform)}.`,
    );
    lines.push(...(await slotLines(engine, deps, palette, res.group, res, res.live)));
    if (res.runningSessions.length > 0) {
      lines.push(
        palette.yellow(
          `  ${res.runningSessions.length} running session(s) named "${sanitizeForTerminal(target.alias)}" ` +
            'here stay on the slot they started on (following whatever account is live there) ' +
            `until relaunched with: ${resumeCommand(target.alias)}`,
        ),
      );
    }
  } else {
    const owner = groups.find((g) => g.id === ownerId)!;
    const toAdd = ids.filter((id) => !owner.members.some((m) => m.id === id));
    if (toAdd.length === 0) {
      deps.write(`${scope} is already bound to ${membersOf(owner)}; nothing changed.\n`);
      return;
    }
    if (groupScopeCount(owner) > 1) {
      fail(
        `${scope} is bound to ${membersOf(owner)} together with ` +
          `${otherScopes(owner, target.alias, target.folder, deps.platform)}; adding accounts there would add ` +
          `them to those too. Unbind it first (cctl session unbind ` +
          `${shellQuote(sanitizeForTerminal(target.alias), deps.platform)}` +
          `${options.cwd !== undefined ? ' --cwd <folder>' : ''}), then bind it to the full list.`,
      );
    }
    // The engine re-checks, under its lock, that this alias is still the group's only scope — the
    // check above is advisory (a bind elsewhere with the same accounts can reuse the group).
    const res = await engineCall(() =>
      engine.addGroupMembers(owner.id, toAdd, {
        soleScope: { kind: 'alias', folder: target.folder, alias: target.alias },
      }),
    );
    const all = await engine.listAllAccounts();
    lines.push(
      `Added ${labelsOf(res.added, all)} to ${scope}; it is now bound to ${membersOf(res.group)}.`,
    );
    lines.push(...(await slotLines(engine, deps, palette, res.group, res, res.live)));
  }

  const note = await currentSessionNote(engine, deps, target.current, palette);
  if (note !== null) lines.push(note);
  deps.write(lines.join('\n') + '\n');
  // Wire the guard now (it is installed on the first binding and refreshed into every profile), so
  // the binding is enforced without waiting for a daemon restart.
  await (deps.reconcileGuard ?? ((e) => reconcileBindGuard(e, deps.paths)))(engine);
}

/**
 * `cctl session unbind [alias]`: drop the alias binding (dissolving its group when it was the last
 * scope, V1 semantics), or with `--accounts` shrink its account list (removing every account
 * dissolves it). Shrinking a group that also carries other scopes is refused, like growing one.
 */
export async function runSessionUnbind(
  aliasArg: string | undefined,
  options: SessionUnbindOptions,
  deps: SessionBindDeps,
): Promise<void> {
  const engine = deps.engine ?? buildEngine(deps.paths);
  const palette = detectPalette();
  const target = await resolveAliasTarget(aliasArg, options.cwd, 'unbind', deps);
  const scope = scopeText(target.alias, target.folder);
  const groups = await engine.listGroups();
  const ownerId = exactAliasBinding(target.folder, target.alias, groups, deps.platform);
  if (ownerId === null) {
    fail(`${scope} is not bound to any account (cctl bindings lists the bindings)`);
  }
  const owner = groups.find((g) => g.id === ownerId)!;
  const force = options.force === true ? { force: true } : {};
  const lines: string[] = [];

  if (options.accounts !== undefined) {
    const ids = await resolveRefs(engine, options.accounts);
    if (groupScopeCount(owner) > 1) {
      fail(
        `${scope} is bound to ${membersOf(owner)} together with ` +
          `${otherScopes(owner, target.alias, target.folder, deps.platform)}; removing accounts there would ` +
          'remove them from those too. Unbind the alias instead (without --accounts), then bind ' +
          'it to the accounts you want.',
      );
    }
    const all = await engine.listAllAccounts();
    // As for growing: the engine re-checks the sole-scope precondition under its lock.
    const res = await engineCall(() =>
      engine.removeGroupMembers(owner.id, ids, {
        ...force,
        soleScope: { kind: 'alias', folder: target.folder, alias: target.alias },
      }),
    );
    if (res.dissolved) {
      lines.push(`Removed every account from ${scope}, which dissolved its binding.`);
      lines.push(`  ${res.removed.length} account(s) returned to the shared pool.`);
    } else {
      lines.push(
        `Removed ${labelsOf(res.removed, all)} from ${scope}; it is now bound to ` +
          `${res.group ? membersOf(res.group) : 'nothing'}.`,
      );
      if (res.switchedTo !== undefined) {
        lines.push(
          res.switchedTo === null
            ? palette.red(
                '  no remaining account could take the slot, so it was cleared; re-login one: ' +
                  'cctl accounts relogin <ref>',
              )
            : `  the slot moved to ${labelsOf([res.switchedTo], all)}.`,
        );
      }
    }
  } else {
    const res = await engineCall(() => engine.unbindAlias(target.folder, target.alias, force));
    const shown = scopeText(res.alias ?? target.alias, res.folder);
    if (!res.dissolved) {
      lines.push(
        `Unbound ${shown}. Its accounts stay bound to ` +
          `${res.group ? sanitizeForTerminal(describeGroupScopes(res.group)) : 'their other scopes'}.`,
      );
    } else {
      lines.push(`Unbound ${shown} and dissolved its binding.`);
      lines.push(
        `  ${res.releasedMembers.length} account(s) returned to the shared pool` +
          (res.adoptedRotation ? ' (adopted the profile’s latest token first)' : '') +
          '.',
      );
      lines.push('  the profile dir is kept for history; its live credentials were cleared.');
    }
  }

  const note = await currentSessionNote(engine, deps, target.current, palette);
  if (note !== null) lines.push(note);
  deps.write(lines.join('\n') + '\n');
  await (deps.reconcileGuard ?? ((e) => reconcileBindGuard(e, deps.paths)))(engine);
}
