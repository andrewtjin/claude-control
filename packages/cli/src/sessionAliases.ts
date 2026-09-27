// `cctl session show` / `cctl session aliases`: a Claude Code session's alias (its title) and the
// accounts it has run on.
//
// Everything is read offline from files this machine already has — the transcripts Claude Code
// writes (alias, folder, turns) and the daemon's database (which account was live in which slot,
// and when; which slot each session ran in). No daemon needs to be running and nothing touches
// the network. Per-turn attribution is the SAME function `cctl stats` uses, so the two can never
// name different accounts for one turn.

import { realpathSync } from 'node:fs';
import {
  Store,
  aliasedSessions,
  accountsBySession,
  buildTurnAttributor,
  projectDirMatches,
  readSessionCatalog,
  readTranscriptTurns,
  resolveSessionRef,
  sameFolder,
  slotBySessionMap,
  type SessionAccountUse,
  type SessionMeta,
  type SessionRefResolution,
  type SessionSlotSpanRow,
} from '@claude-control/daemon';
import {
  aliasKey,
  canonicalizeFolder,
  groupSlotId,
  resolveSessionBinding,
  scopedGroupOf,
  type Paths,
  type StoredGroup,
  type SwitchEngine,
} from '@claude-control/switch-engine';
import { detectPalette, sanitizeForTerminal } from './ansi.js';
import { buildEngine, daemonDbPath, fail } from './context.js';
import type { LaunchAliasDeps } from './launcher.js';
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
  /** The engine to read (and, for bind/unbind, write) through; default = one over `paths`. Tests
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

/** Attach each session's per-account use (the expensive half: only these sessions' turns are
 *  read). */
async function withAccounts(
  deps: SessionAliasDeps,
  sessions: SessionMeta[],
): Promise<AccountsRead> {
  if (sessions.length === 0) return { views: [], recordedSlot: new Map() };
  const sessionIds = new Set(sessions.map((s) => s.sessionId));
  const [accounts, scan] = await Promise.all([
    // Reserved group members included: a bound account must show its name, not its id.
    (deps.engine ?? buildEngine(deps.paths)).listAllAccounts(),
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
  let recordedSlot: Map<string, string>;
  try {
    const slotBySession = slotBySessionMap(store.listSessions());
    const slotSpans = store.listSessionSlotSpans();
    accountFor = buildTurnAttributor({
      intervals: store.listActivationIntervals(),
      slotBySession,
      slotSpans,
    });
    recordedSlot = lastRecordedSlots(slotSpans, slotBySession);
  } finally {
    store.close();
  }
  const uses = accountsBySession(
    scan.turns,
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
 * Attach each session's binding by THE precedence rule (the same pure function the guard embeds):
 * its folder and custom title -> the required slot; and whether it runs there. The current session's
 * slot is read from this process's own CLAUDE_CONFIG_DIR (it runs inside it); any other session's
 * is the slot the daemon last recorded for it, or unknown.
 */
async function withBindings(deps: SessionAliasDeps, read: AccountsRead): Promise<SessionView[]> {
  if (read.views.length === 0) return read.views;
  const engine = deps.engine ?? buildEngine(deps.paths);
  const groups = await engine.listGroups();
  const scoped = groups.map((g) => scopedGroupOf(g, deps.platform));
  const currentId = deps.env[SESSION_ID_ENV]?.trim().toLowerCase();
  // This session's own slot, from the RAW CLAUDE_CONFIG_DIR it runs with (deps.paths is the main
  // config dir, seen through a group profile). A config dir cctl does not manage is an unknown slot,
  // never a guess of 'global'.
  const isSession = currentId !== undefined && currentId !== '';
  const currentSlot = isSession
    ? await engine.recognizedSlotForConfigDir(deps.env.CLAUDE_CONFIG_DIR ?? null)
    : null;
  const slotLabel = (slot: string): string => {
    if (slot === 'global') return 'the shared account';
    const g = groups.find((x) => groupSlotId(x.id) === slot);
    return g === undefined ? 'a binding that no longer exists' : `the ${g.label} binding`;
  };
  return read.views.map((view) => {
    const m = view.meta;
    const title = customTitleOf(m);
    const folder = m.folder === null ? null : canonicalOrRaw(m.folder, deps);
    const required =
      folder === null ? null : resolveSessionBinding(folder, title, scoped, deps.platform);
    const group: StoredGroup | undefined =
      required === null ? undefined : groups.find((g) => g.id === required.groupId);
    const requiredSlot = required === null ? 'global' : groupSlotId(required.groupId);
    const isCurrent = currentId !== undefined && m.sessionId.toLowerCase() === currentId;
    const slot = isCurrent
      ? currentSlot
      : (read.recordedSlot.get(m.sessionId.toLowerCase()) ?? null);
    const binding: SessionBindingView = {
      via: required?.via ?? null,
      folder: required?.folder ?? null,
      alias:
        required?.via === 'alias'
          ? ((group?.aliases ?? []).find((a) => aliasKey(a.alias) === required.aliasKey)?.alias ??
            title)
          : null,
      groupId: required?.groupId ?? null,
      groupLabel: group?.label ?? null,
      members: group?.members.map((mm) => mm.label) ?? [],
      requiredSlot,
      slot,
      slotSource: isCurrent ? 'env' : slot === null ? null : 'recorded',
      slotLabel: slot === null ? null : slotLabel(slot),
      inScope: slot === null ? null : slot === requiredSlot,
    };
    return { ...view, binding };
  });
}

/** Canonicalize a recorded session folder the way a binding stores folders (realpath when it
 *  exists), falling back to the recorded text for a path that cannot be canonicalized. */
function canonicalOrRaw(folder: string, deps: SessionAliasDeps): string {
  const r = canonicalizeFolder(folder, {
    platform: deps.platform,
    cwd: deps.cwd,
    realpath: (p) => realpathSync.native(p),
  });
  return r.ok ? r.path : folder;
}

/**
 * The session-catalog lookups the launcher needs to learn which ALIAS a `cctl claude` launch opens
 * (see launcher.ts resolveLaunchAlias). Only custom titles count. `rawCwd` is the launch cwd exactly
 * as Claude Code will see it — the project directory it records sessions under is derived from that
 * spelling, not from the canonical path.
 */
export function catalogLaunchAliasDeps(
  claudeDir: string,
  rawCwd: string,
  platform: NodeJS.Platform,
): LaunchAliasDeps {
  return {
    customTitleById: async (sessionId) => {
      const catalog = await readSessionCatalog({ claudeDir, sessionIds: new Set([sessionId]) });
      const meta = catalog.sessions.find(
        (s) => s.sessionId.toLowerCase() === sessionId.toLowerCase(),
      );
      return meta === undefined ? null : customTitleOf(meta);
    },
    latestCustomTitleInFolder: async () => {
      const catalog = await readSessionCatalog({
        claudeDir,
        projectDirFilter: (name) => projectDirMatches(name, rawCwd),
      });
      const here = catalog.sessions
        .filter((s) => s.folder !== null && sameFolder(s.folder, rawCwd, platform))
        .sort((a, b) => b.lastActivityMs - a.lastActivityMs);
      const latest = here[0];
      return latest === undefined ? null : customTitleOf(latest);
    },
  };
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
  const views = await withBindings(deps, await withAccounts(deps, sessions));
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
