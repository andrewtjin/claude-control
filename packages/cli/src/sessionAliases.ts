// `cctl session show` / `cctl session aliases`: a Claude Code session's alias (its title) and the
// accounts it has run on.
//
// Everything is read offline from files this machine already has — the transcripts Claude Code
// writes (alias, folder, turns) and the daemon's database (which account was live in which slot,
// and when; which slot each session ran in). No daemon needs to be running and nothing touches
// the network. Per-turn attribution is the SAME function `cctl stats` uses, so the two can never
// name different accounts for one turn.

import {
  Store,
  aliasedSessions,
  accountsBySession,
  buildTurnAttributor,
  projectDirMatches,
  readSessionCatalog,
  readTranscriptTurns,
  resolveSessionRef,
  slotBySessionMap,
  type SessionAccountUse,
  type SessionMeta,
  type SessionRefResolution,
} from '@claude-control/daemon';
import type { Paths } from '@claude-control/switch-engine';
import { detectPalette } from './ansi.js';
import { buildEngine, daemonDbPath, fail } from './context.js';
import {
  renderAmbiguousAlias,
  renderSessionAliasList,
  renderSessionDetails,
  sessionViewJson,
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
}

/** Attach each session's per-account use (the expensive half: only these sessions' turns are
 *  read). */
async function withAccounts(
  deps: SessionAliasDeps,
  sessions: SessionMeta[],
): Promise<SessionView[]> {
  if (sessions.length === 0) return [];
  const sessionIds = new Set(sessions.map((s) => s.sessionId));
  const [accounts, scan] = await Promise.all([
    // Reserved group members included: a bound account must show its name, not its id.
    buildEngine(deps.paths).listAllAccounts(),
    // Per-session de-dup: a forked session's inherited turns belong to its history too.
    readTranscriptTurns({
      claudeDir: deps.paths.claudeDir,
      sinceMs: 0,
      sessionIds,
      dedupe: 'session',
    }),
  ]);
  const store = new Store(daemonDbPath(deps.paths));
  let accountFor;
  try {
    accountFor = buildTurnAttributor({
      intervals: store.listActivationIntervals(),
      slotBySession: slotBySessionMap(store.listSessions()),
      slotSpans: store.listSessionSlotSpans(),
    });
  } finally {
    store.close();
  }
  const uses = accountsBySession(
    scan.turns,
    accountFor,
    new Map(accounts.map((a) => [a.id, a.label] as const)),
  );
  const none: SessionAccountUse[] = [];
  return sessions.map((meta) => ({ meta, accounts: uses.get(meta.sessionId) ?? none }));
}

/** `cctl session show [ref]`. */
export async function runSessionShow(
  ref: string | undefined,
  options: SessionShowOptions,
  deps: SessionAliasDeps,
): Promise<void> {
  const folder = options.cwd ?? deps.cwd;
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
    resolution = resolveSessionRef(byId.sessions, target, folder, deps.platform);
  }
  // Then cheap: only the project directories this folder's sessions can live in. A miss there
  // widens to every folder, because an alias used elsewhere can be anywhere.
  if (resolution.kind === 'none') {
    const inScope = await readSessionCatalog({
      claudeDir: deps.paths.claudeDir,
      projectDirFilter: (name) => projectDirMatches(name, folder),
    });
    resolution = resolveSessionRef(inScope.sessions, target, folder, deps.platform);
  }
  if (resolution.kind === 'none' || (resolution.kind === 'alias' && !resolution.inScope)) {
    deps.note(`Searching every project under ${deps.paths.claudeDir} ...`);
    const everywhere = await readSessionCatalog({ claudeDir: deps.paths.claudeDir });
    resolution = resolveSessionRef(everywhere.sessions, target, folder, deps.platform);
  }

  if (resolution.kind === 'none') {
    fail(`no session with id or alias "${target}" — cctl session aliases lists the aliases here`);
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
  const views = await withAccounts(deps, sessions);
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

/** `cctl session aliases`. */
export async function runSessionAliases(
  options: SessionAliasesOptions,
  deps: SessionAliasDeps,
): Promise<void> {
  const folder = options.all === true ? null : (options.cwd ?? deps.cwd);
  if (folder === null) deps.note(`Reading every project under ${deps.paths.claudeDir} ...`);
  const catalog = await readSessionCatalog({
    claudeDir: deps.paths.claudeDir,
    ...(folder !== null
      ? { projectDirFilter: (name: string) => projectDirMatches(name, folder) }
      : {}),
  });
  const sessions = aliasedSessions(catalog.sessions, folder, deps.platform).filter(
    (s) => options.auto === true || (s.customTitle !== null && s.customTitle.trim() !== ''),
  );
  const views = await withAccounts(deps, sessions);
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
