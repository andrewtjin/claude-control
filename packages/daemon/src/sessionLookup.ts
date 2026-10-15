// Pure lookup over a session catalog: find sessions by id or alias (the working directory breaking
// ties between folders that reuse one alias), and total which accounts each session's turns were
// billed to. No IO — the catalog, the turns and the attribution function are all passed in.

import { folderUniquenessKey, recordedFolderFor } from '@claude-control/switch-engine';
import { aliasKey, aliasOf, type SessionMeta } from './sessionCatalog.js';
import type { TranscriptTurn } from './transcriptTokens.js';

/** How a reference resolved. */
export type SessionRefResolution =
  /** Matched by session id. */
  | { kind: 'id'; session: SessionMeta }
  /** Matched by alias in the given folder (possibly several sessions sharing it). */
  | { kind: 'alias'; folder: string; sessions: SessionMeta[]; inScope: boolean }
  /** The alias exists only in OTHER folders, more than one of them: the caller must pick. */
  | { kind: 'ambiguous'; folders: { folder: string; sessions: SessionMeta[] }[] }
  | { kind: 'none' };

/** Whether two session folders are the same directory, however spelled. */
export function sameFolder(a: string, b: string, platform: NodeJS.Platform): boolean {
  return folderUniquenessKey(a, platform) === folderUniquenessKey(b, platform);
}

/**
 * The folder a lookup runs in. A session records its folder as Claude Code spelled it — through a
 * junction or symlink, when that is where it was launched — so a recorded folder is compared only
 * after `canonicalize` puts it in the same canonical form as {@link canonical}; compared as written,
 * a session recorded under a link would never be found from the folder the link points at, nor
 * from the link itself.
 */
export interface SessionLookupFolder {
  /** The folder as given, made absolute: a project directory may be named after this spelling. */
  spelled: string;
  /** The same folder canonically (realpath when it exists): what folders are compared on. */
  canonical: string;
  /** Puts a recorded folder in canonical form by the caller's rule (the one folder rules use). */
  canonicalize: (folder: string) => string;
}

/** The folder a session's conversation belongs to, canonically, looked at from `here`: its trusted
 *  recorded folder, else `here` when the session's project directory can stand for it (by either
 *  spelling), else null — the fallback every reader of an alias rule's folder applies
 *  (switch-engine recordedFolderFor). */
function folderSeenFrom(s: SessionMeta, here: SessionLookupFolder): string | null {
  return recordedFolderFor({ folder: s.folder, dirName: s.projectDir }, here, here.canonicalize);
}

/**
 * Resolve `ref` against the catalog from `here` (normally the cwd).
 *
 * 1. An exact session id wins (case-insensitive: ids are UUIDs, and a pasted id may be upper-case).
 * 2. Otherwise `ref` is an alias, compared the way `claude --resume` compares titles. Sessions in
 *    `here` win outright — that is what `claude --resume <alias>` would search from here.
 * 3. No match in `here`: if every match lives in ONE other folder, that folder's sessions are the
 *    answer (flagged `inScope: false` so the caller says where they are); matches spread over
 *    several folders are ambiguous, and the working directory is what picks between them.
 *
 * A session with no trusted folder counts for `here` when its project directory can stand for
 * it (the shared fallback); otherwise it can match by id only. Folders are compared canonically
 * ({@link SessionLookupFolder}), and reported in their canonical spelling.
 */
export function resolveSessionRef(
  catalog: readonly SessionMeta[],
  ref: string,
  here: SessionLookupFolder,
  platform: NodeJS.Platform,
): SessionRefResolution {
  const trimmed = ref.trim();
  if (trimmed === '') return { kind: 'none' };
  const idKey = trimmed.toLowerCase();
  const byId = catalog.find((s) => s.sessionId.toLowerCase() === idKey);
  if (byId !== undefined) return { kind: 'id', session: byId };

  const key = aliasKey(trimmed);
  // Each alias match with the folder it belongs to, worked out once.
  const matches: { session: SessionMeta; folder: string }[] = [];
  for (const s of catalog) {
    const alias = aliasOf(s);
    if (alias === null || aliasKey(alias) !== key) continue;
    const folder = folderSeenFrom(s, here);
    if (folder !== null) matches.push({ session: s, folder });
  }
  if (matches.length === 0) return { kind: 'none' };

  const inHere = matches.filter((m) => sameFolder(m.folder, here.canonical, platform));
  if (inHere.length > 0) {
    return {
      kind: 'alias',
      folder: here.canonical,
      sessions: sortByRecent(inHere.map((m) => m.session)),
      inScope: true,
    };
  }

  const groups = groupByFolder(matches, platform);
  const only = groups[0];
  if (groups.length === 1 && only !== undefined) {
    return { kind: 'alias', folder: only.folder, sessions: only.sessions, inScope: false };
  }
  return { kind: 'ambiguous', folders: groups };
}

/** Every aliased session in `here`, or in all folders when `here` is `null`, most recent first.
 *  Sessions with no alias are left out: this is the alias listing. Folders are compared
 *  canonically ({@link SessionLookupFolder}). */
export function aliasedSessions(
  catalog: readonly SessionMeta[],
  here: SessionLookupFolder | null,
  platform: NodeJS.Platform,
): SessionMeta[] {
  return sortByRecent(
    catalog.filter((s) => {
      if (aliasOf(s) === null) return false;
      if (here === null) return s.folder !== null;
      const seen = folderSeenFrom(s, here);
      return seen !== null && sameFolder(seen, here.canonical, platform);
    }),
  );
}

function sortByRecent(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

/** Alias matches grouped by the (canonical) folder each belongs to, so one folder recorded under
 *  two spellings is one group; groups ordered by their most recent session. */
function groupByFolder(
  matches: readonly { session: SessionMeta; folder: string }[],
  platform: NodeJS.Platform,
): { folder: string; sessions: SessionMeta[] }[] {
  const groups = new Map<string, { folder: string; sessions: SessionMeta[] }>();
  for (const m of matches) {
    const k = folderUniquenessKey(m.folder, platform);
    let g = groups.get(k);
    if (g === undefined) {
      g = { folder: m.folder, sessions: [] };
      groups.set(k, g);
    }
    g.sessions.push(m.session);
  }
  return [...groups.values()]
    .map((g) => ({ folder: g.folder, sessions: sortByRecent(g.sessions) }))
    .sort((a, b) => (b.sessions[0]?.lastActivityMs ?? 0) - (a.sessions[0]?.lastActivityMs ?? 0));
}

/** One account's share of a session's turns. `accountId` null = turns no account can be claimed
 *  for (before cctl tracked switches, or a gap in the journal) — shown, never dropped. */
export interface SessionAccountUse {
  accountId: string | null;
  label: string;
  turns: number;
  tokens: number;
  firstMs: number;
  lastMs: number;
}

/** The label for turns no account can be claimed for. */
export const UNATTRIBUTED_SESSION_LABEL = 'unattributed';

/**
 * Total each session's turns per account. Accounts come out in the order the session first used
 * them — the natural reading of "which accounts has this session run on" — with the unattributed
 * bucket wherever its first turn falls. Pure.
 */
export function accountsBySession(
  turns: readonly TranscriptTurn[],
  accountFor: (turn: TranscriptTurn) => string | null,
  labelById: ReadonlyMap<string, string>,
): Map<string, SessionAccountUse[]> {
  const bySession = new Map<string, Map<string | null, SessionAccountUse>>();
  const ordered = [...turns].sort((a, b) => a.tsMs - b.tsMs);
  for (const turn of ordered) {
    if (turn.sessionId == null) continue;
    let uses = bySession.get(turn.sessionId);
    if (uses === undefined) {
      uses = new Map();
      bySession.set(turn.sessionId, uses);
    }
    const accountId = accountFor(turn);
    let use = uses.get(accountId);
    if (use === undefined) {
      use = {
        accountId,
        label:
          accountId === null ? UNATTRIBUTED_SESSION_LABEL : (labelById.get(accountId) ?? accountId),
        turns: 0,
        tokens: 0,
        firstMs: turn.tsMs,
        lastMs: turn.tsMs,
      };
      uses.set(accountId, use);
    }
    use.turns += 1;
    use.tokens +=
      turn.inputTokens + turn.outputTokens + turn.cacheCreationTokens + turn.cacheReadTokens;
    use.lastMs = turn.tsMs;
  }
  const out = new Map<string, SessionAccountUse[]>();
  for (const [sessionId, uses] of bySession) out.set(sessionId, [...uses.values()]);
  return out;
}
