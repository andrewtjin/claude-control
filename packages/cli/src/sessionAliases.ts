// `cctl session show` / `cctl session aliases`: a Claude Code session's alias (its title) and the
// accounts it has run on.
//
// Everything is read offline from files this machine already has — the transcripts Claude Code
// writes (alias, folder, turns) and the daemon's database (which account was live in which slot,
// and when; which slot each session ran in). No daemon needs to be running and nothing touches
// the network. Per-turn attribution is the SAME function `cctl stats` uses, so the two can never
// name different accounts for one turn.

import { readdirSync, realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  Store,
  aliasedSessions,
  accountsBySession,
  dropInheritedTurns,
  buildTurnAttributor,
  projectDirMatches,
  readSessionCatalog,
  readTranscriptTurns,
  resolveSessionRef,
  slotBySessionMap,
  type SessionAccountUse,
  type SessionLookupFolder,
  type SessionMeta,
  type SessionRefResolution,
  type SessionSlotSpanRow,
  type TranscriptTurn,
} from '@claude-control/daemon';
import {
  aliasKey,
  canonicalizeFolder,
  describeRuleScopes,
  recordedFolderFor,
  resolveSessionRule,
  ruleSlotId,
  type FolderRule,
  type Paths,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { detectPalette, sanitizeForTerminal } from './ansi.js';
import { buildEngine, daemonDbPath, fail } from './context.js';
import {
  renderAmbiguousAlias,
  renderSessionAliasList,
  renderSessionDetails,
  sessionViewJson,
  type SessionBindingView,
  type SessionView,
} from './render.js';

/** The env var Claude Code sets in a session's tool environment: the current session's id. */
export const SESSION_ID_ENV = 'CLAUDE_CODE_SESSION_ID';

/** What a Claude Code session id looks like (a UUID) — the transcript file's base name. */
const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionShowOptions {
  /** The folder whose sessions an alias resolves in; default = the process cwd. */
  cwd?: string;
  json?: boolean;
}

export interface SessionAliasesOptions {
  cwd?: string;
  /** Every folder, not just `cwd`. */
  all?: boolean;
  /** Include sessions whose only title is the generated one. */
  auto?: boolean;
  json?: boolean;
}

/** Injectable edges, so the commands are testable against a temp config dir. */
export interface SessionAliasDeps {
  paths: Paths;
  env: NodeJS.ProcessEnv;
  cwd: string;
  platform: NodeJS.Platform;
  write: (text: string) => void;
  /** Progress notes for a slow scan; only shown on a terminal. */
  note: (text: string) => void;
  /** The engine to read (and, for the rule commands, write) through; default = one over `paths`. Tests
   *  pass one built over a sandbox vault. */
  engine?: SwitchEngine;
}

/** Sessions' per-account use, plus the slot each was last RECORDED in (a slot span from a hook
 *  event, else its registered slot) — what `session show` judges "in scope" by for a session that
 *  is not the one running this command. */
interface AccountsRead {
  views: SessionView[];
  recordedSlot: Map<string, string>;
}

/** The latest recorded slot per session id (lower-cased): its last span, else its registered slot.
 *  Spans come ordered by session, then time, so the last one seen per session is its latest. */
function lastRecordedSlots(
  spans: readonly SessionSlotSpanRow[],
  registered: ReadonlyMap<string, string>,
): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, slot] of registered) out.set(id.toLowerCase(), slot);
  for (const span of spans) out.set(span.sessionId.toLowerCase(), span.slot);
  return out;
}

/**
 * The turns of the sessions beside the shown ones that may have made a shown fork's copied turns. A
 * fork's file sits beside its parent's, and a copy is only known as one once its maker is read too.
 * Only a turn before its own session's first recorded span can be a copy, and only a session with a
 * span can be known as its maker (from that span on), so an ordinary session, or one older than
 * every span, reads nothing more, and a fork reads only its recorded siblings, from its earliest
 * such turn on.
 */
async function makerTurns(
  deps: SessionAliasDeps,
  sessions: SessionMeta[],
  turns: readonly TranscriptTurn[],
  spans: readonly SessionSlotSpanRow[],
): Promise<TranscriptTurn[]> {
  const firstSpan = new Map<string, number>();
  // A maker is only known from its first span on, so a turn older than every span has none to find.
  let earliestSpan = Infinity;
  for (const span of spans) {
    firstSpan.set(
      span.sessionId,
      Math.min(span.startedAtMs, firstSpan.get(span.sessionId) ?? Infinity),
    );
    earliestSpan = Math.min(earliestSpan, span.startedAtMs);
  }
  let sinceMs = Infinity;
  for (const turn of turns) {
    if (
      turn.sessionId != null &&
      turn.tsMs >= earliestSpan &&
      turn.tsMs < (firstSpan.get(turn.sessionId) ?? Infinity)
    ) {
      sinceMs = Math.min(sinceMs, turn.tsMs);
    }
  }
  if (sinceMs === Infinity) return [];
  const shown = new Set(sessions.map((s) => s.sessionId));
  const siblings = new Set<string>();
  for (const dir of new Set(sessions.map((s) => dirname(s.file)))) {
    try {
      for (const name of readdirSync(dir)) {
        const id = name.slice(0, -'.jsonl'.length);
        if (name.endsWith('.jsonl') && !shown.has(id) && firstSpan.has(id)) siblings.add(id);
      }
    } catch {
      // Unlistable: the shown sessions are still read, their copies kept as before.
    }
  }
  if (siblings.size === 0) return [];
  const scan = await readTranscriptTurns({
    claudeDir: deps.paths.claudeDir,
    sinceMs,
    sessionIds: siblings,
    dedupe: 'session',
  });
  return scan.turns;
}

/** Attach each session's per-account use (the expensive half: only these sessions' turns are
 *  read, plus a shown fork's possible makers). */
async function withAccounts(
  deps: SessionAliasDeps,
  sessions: SessionMeta[],
): Promise<AccountsRead> {
  if (sessions.length === 0) return { views: [], recordedSlot: new Map() };
  const sessionIds = new Set(sessions.map((s) => s.sessionId));
  const [accounts, scan] = await Promise.all([
    // Reserved accounts included: an account a folder rule holds must show its name, not its id.
    (deps.engine ?? buildEngine(deps.paths)).listAllAccounts(),
    // Per-session de-dup, so a fork's inherited turns survive whichever file is read first; the
    // copies whose maker is known are dropped below.
    readTranscriptTurns({
      claudeDir: deps.paths.claudeDir,
      sinceMs: 0,
      sessionIds,
      dedupe: 'session',
    }),
  ]);
  const store = new Store(daemonDbPath(deps.paths));
  let accountFor;
  let recordedSlot: Map<string, string>;
  let slotSpans: SessionSlotSpanRow[];
  try {
    const slotBySession = slotBySessionMap(store.listSessions());
    slotSpans = store.listSessionSlotSpans();
    accountFor = buildTurnAttributor({
      intervals: store.listActivationIntervals(),
      slotBySession,
      slotSpans,
    });
    recordedSlot = lastRecordedSlots(slotSpans, slotBySession);
  } finally {
    store.close();
  }
  const turns = [...scan.turns, ...(await makerTurns(deps, sessions, scan.turns, slotSpans))];
  const uses = accountsBySession(
    dropInheritedTurns(turns, slotSpans),
    accountFor,
    new Map(accounts.map((a) => [a.id, a.label] as const)),
  );
  const none: SessionAccountUse[] = [];
  return {
    views: sessions.map((meta) => ({ meta, accounts: uses.get(meta.sessionId) ?? none })),
    recordedSlot,
  };
}

/** A custom title that names the session (non-blank), or null. */
function customTitleOf(meta: SessionMeta): string | null {
  return meta.customTitle !== null && meta.customTitle.trim() !== '' ? meta.customTitle : null;
}

/**
 * Attach each session's rule by THE precedence rule (the same pure function the guard embeds): its
 * folder and custom title -> the required slot; and whether it runs there. Its folder is the one the
 * shared recorded-folder reading trusts, else — the same fallback the guard and the launcher apply —
 * `folder` (the one this lookup runs in) when its project directory can stand for it. The current
 * session's slot is read from this process's own CLAUDE_CONFIG_DIR (it runs inside it); any other
 * session's is the slot the daemon last recorded for it, or unknown.
 */
async function withBindings(
  deps: SessionAliasDeps,
  read: AccountsRead,
  folder: SessionLookupFolder,
): Promise<SessionView[]> {
  if (read.views.length === 0) return read.views;
  const engine = deps.engine ?? buildEngine(deps.paths);
  const [rules, accounts] = await Promise.all([engine.listRules(), engine.listAllAccounts()]);
  const labelOf = (id: string): string => accounts.find((a) => a.id === id)?.label ?? id;
  const currentId = deps.env[SESSION_ID_ENV]?.trim().toLowerCase();
  // This session's own slot, from the RAW CLAUDE_CONFIG_DIR it runs with (deps.paths is the main
  // config dir, seen through a rule's profile). A config dir cctl does not manage is an unknown slot,
  // never a guess of 'global'.
  const isSession = currentId !== undefined && currentId !== '';
  const currentSlot = isSession
    ? await engine.recognizedSlotForConfigDir(deps.env.CLAUDE_CONFIG_DIR ?? null)
    : null;
  const slotLabel = (slot: string): string => {
    if (slot === 'global') return 'the global slot';
    const r = rules.find((x) => ruleSlotId(x.id) === slot);
    return r === undefined
      ? 'a folder slot whose rule no longer exists'
      : `the folder slot of ${describeRuleScopes(r)}`;
  };
  return read.views.map((view) => {
    const m = view.meta;
    const title = customTitleOf(m);
    const recorded = recordedFolderFor(
      { folder: m.folder, dirName: m.projectDir },
      folder,
      folder.canonicalize,
    );
    const required =
      recorded === null ? null : resolveSessionRule(recorded, title, rules, deps.platform);
    const rule: FolderRule | undefined = required?.rule;
    const requiredSlot = rule === undefined ? 'global' : ruleSlotId(rule.id);
    const isCurrent = currentId !== undefined && m.sessionId.toLowerCase() === currentId;
    const slot = isCurrent
      ? currentSlot
      : (read.recordedSlot.get(m.sessionId.toLowerCase()) ?? null);
    const binding: SessionBindingView = {
      via: required?.via ?? null,
      folder: required?.folder ?? null,
      alias:
        required?.via === 'alias'
          ? ((rule?.aliases ?? []).find((a) => aliasKey(a.alias) === required.aliasKey)?.alias ??
            title)
          : null,
      ruleId: rule?.id ?? null,
      ruleLabel: rule?.label ?? null,
      members: rule?.include.map(labelOf) ?? [],
      requiredSlot,
      slot,
      slotSource: isCurrent ? 'env' : slot === null ? null : 'recorded',
      slotLabel: slot === null ? null : slotLabel(slot),
      inScope: slot === null ? null : slot === requiredSlot,
    };
    return { ...view, binding };
  });
}

/** Canonicalize a recorded session folder the way a rule stores folders (realpath when it
 *  exists), falling back to the recorded text for a path that cannot be canonicalized. A recorded
 *  folder is data, not operator input, so this never fails. Shared with the launcher, which matches
 *  a resumed session's recorded folder against alias scopes the same way. */
export function canonicalOrRaw(
  folder: string,
  deps: { platform: NodeJS.Platform; cwd: string },
): string {
  const r = canonicalizeFolder(folder, {
    platform: deps.platform,
    cwd: deps.cwd,
    realpath: (p) => realpathSync.native(p),
  });
  return r.ok ? r.path : folder;
}

/**
 * The folder `--cwd` names, or the current directory: a relative path is taken against the current
 * directory, and a junction or link is resolved, as every other folder input is. Both spellings are
 * kept, since Claude Code may have named a project directory after either. A session's recorded
 * folder is canonicalized the same way before it is compared (`canonicalize`): Claude Code records
 * the folder as it was spelled at launch, a junction or link included. Fails on a path with no
 * canonical form, rather than silently looking in another folder.
 */
function lookupFolderOf(cwdOpt: string | undefined, deps: SessionAliasDeps): SessionLookupFolder {
  const input = cwdOpt ?? deps.cwd;
  const spelled = canonicalizeFolder(input, { platform: deps.platform, cwd: deps.cwd });
  if (!spelled.ok) fail(`cannot use folder "${sanitizeForTerminal(input)}": ${spelled.reason}`);
  const canonicalize = (f: string): string => canonicalOrRaw(f, deps);
  return { spelled: spelled.path, canonical: canonicalize(spelled.path), canonicalize };
}

/**
 * Whether project directory `name` can hold sessions launched in `folder`, by either spelling of
 * `folder` itself. Claude Code names a project directory after the folder as spelled at launch, so
 * a session started through a junction lives in the junction's directory: it is read from the
 * junction, but not from the folder the junction points at, whose spellings name another
 * directory. That mirrors `claude --resume`, which scopes by the same directory.
 */
function projectDirMatchesFolder(name: string, folder: SessionLookupFolder): boolean {
  return projectDirMatches(name, folder.canonical) || projectDirMatches(name, folder.spelled);
}

/** `cctl session show [ref]`. */
export async function runSessionShow(
  ref: string | undefined,
  options: SessionShowOptions,
  deps: SessionAliasDeps,
): Promise<void> {
  const lookup = lookupFolderOf(options.cwd, deps);
  const folder = lookup.canonical;
  const target = ref ?? deps.env[SESSION_ID_ENV];
  if (target === undefined || target.trim() === '') {
    fail(
      `no session given, and this is not a Claude Code session (${SESSION_ID_ENV} is unset). ` +
        'Pass a session id or alias: cctl session show <id|alias>',
    );
  }

  // A session id wins over any alias anywhere, so an id-shaped ref is looked up machine-wide
  // first — that reads only the one transcript whose file name matches, so it stays cheap.
  let resolution: SessionRefResolution = { kind: 'none' };
  if (SESSION_ID_SHAPE.test(target.trim())) {
    const byId = await readSessionCatalog({
      claudeDir: deps.paths.claudeDir,
      sessionIds: new Set([target.trim()]),
    });
    resolution = resolveSessionRef(byId.sessions, target, lookup, deps.platform);
  }
  // Then cheap: only the project directories this folder's sessions can live in. A miss there
  // widens to every folder, because an alias used elsewhere can be anywhere.
  if (resolution.kind === 'none') {
    const inScope = await readSessionCatalog({
      claudeDir: deps.paths.claudeDir,
      projectDirFilter: (name) => projectDirMatchesFolder(name, lookup),
    });
    resolution = resolveSessionRef(inScope.sessions, target, lookup, deps.platform);
  }
  if (resolution.kind === 'none' || (resolution.kind === 'alias' && !resolution.inScope)) {
    deps.note(`Searching every project under ${deps.paths.claudeDir} ...`);
    const everywhere = await readSessionCatalog({ claudeDir: deps.paths.claudeDir });
    resolution = resolveSessionRef(everywhere.sessions, target, lookup, deps.platform);
  }

  if (resolution.kind === 'none') {
    fail(
      `no session with id or alias "${sanitizeForTerminal(target)}" — cctl session aliases lists ` +
        'the aliases here',
    );
  }
  if (resolution.kind === 'ambiguous') {
    if (options.json === true) {
      deps.write(
        JSON.stringify(
          {
            ambiguous: true,
            alias: target,
            folders: resolution.folders.map((f) => ({
              folder: f.folder,
              sessionIds: f.sessions.map((s) => s.sessionId),
            })),
          },
          null,
          2,
        ) + '\n',
      );
    } else {
      deps.write(renderAmbiguousAlias(target, resolution.folders, detectPalette()) + '\n');
    }
    process.exitCode = 1;
    return;
  }

  const sessions = resolution.kind === 'id' ? [resolution.session] : resolution.sessions;
  const views = await withBindings(deps, await withAccounts(deps, sessions), lookup);
  const context = {
    matchedBy: resolution.kind,
    ...(resolution.kind === 'alias' ? { inScope: resolution.inScope } : {}),
    currentSessionId: deps.env[SESSION_ID_ENV],
  };
  if (options.json === true) {
    deps.write(
      JSON.stringify({ ...context, sessions: views.map(sessionViewJson) }, null, 2) + '\n',
    );
    return;
  }
  deps.write(renderSessionDetails(views, { ...context, folder }, detectPalette()) + '\n');
}

/**
 * `cctl session aliases`: the named sessions of one folder (the current directory or `--cwd`), or
 * of every folder with `--all`. Only the project directories named after the folder's own spellings
 * are read ({@link projectDirMatchesFolder}), as `claude --resume` reads them: a session recorded
 * under a junction is listed from the junction, but not from the folder it points at. `session
 * show <alias>` still finds it there, since a miss widens its search to every project.
 */
export async function runSessionAliases(
  options: SessionAliasesOptions,
  deps: SessionAliasDeps,
): Promise<void> {
  const lookup = options.all === true ? null : lookupFolderOf(options.cwd, deps);
  const folder = lookup === null ? null : lookup.canonical;
  if (folder === null) deps.note(`Reading every project under ${deps.paths.claudeDir} ...`);
  const catalog = await readSessionCatalog({
    claudeDir: deps.paths.claudeDir,
    ...(lookup !== null
      ? { projectDirFilter: (name: string) => projectDirMatchesFolder(name, lookup) }
      : {}),
  });
  const sessions = aliasedSessions(catalog.sessions, lookup, deps.platform).filter(
    (s) => options.auto === true || (s.customTitle !== null && s.customTitle.trim() !== ''),
  );
  const { views } = await withAccounts(deps, sessions);
  if (options.json === true) {
    deps.write(JSON.stringify({ folder, sessions: views.map(sessionViewJson) }, null, 2) + '\n');
    return;
  }
  deps.write(
    renderSessionAliasList(
      views,
      { folder, currentSessionId: deps.env[SESSION_ID_ENV] },
      detectPalette(),
    ) + '\n',
  );
}
