// Pure lookup over a session catalog: find sessions by id or alias (the working directory breaking
// ties between folders that reuse one alias), and total which accounts each session's turns were
// billed to. No IO — the catalog, the turns and the attribution function are all passed in.

import { folderUniquenessKey } from '@claude-control/switch-engine';
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
 * Resolve `ref` against the catalog from `folder` (normally the cwd).
 *
 * 1. An exact session id wins (case-insensitive: ids are UUIDs, and a pasted id may be upper-case).
 * 2. Otherwise `ref` is an alias, compared the way `claude --resume` compares titles. Sessions in
 *    `folder` win outright — that is what `claude --resume <alias>` would search from here.
 * 3. No match in `folder`: if every match lives in ONE other folder, that folder's sessions are the
 *    answer (flagged `inScope: false` so the caller says where they are); matches spread over
 *    several folders are ambiguous, and the working directory is what picks between them.
 *
 * Sessions whose folder is unknown (no recorded cwd) can match by id only.
 */
export function resolveSessionRef(
  catalog: readonly SessionMeta[],
  ref: string,
  folder: string,
  platform: NodeJS.Platform,
): SessionRefResolution {
  const trimmed = ref.trim();
  if (trimmed === '') return { kind: 'none' };
  const idKey = trimmed.toLowerCase();
  const byId = catalog.find((s) => s.sessionId.toLowerCase() === idKey);
  if (byId !== undefined) return { kind: 'id', session: byId };

  const key = aliasKey(trimmed);
  const matches = catalog.filter((s) => {
    const alias = aliasOf(s);
    return alias !== null && s.folder !== null && aliasKey(alias) === key;
  });
  if (matches.length === 0) return { kind: 'none' };

  const here = matches.filter((s) => s.folder !== null && sameFolder(s.folder, folder, platform));
  if (here.length > 0)
    return { kind: 'alias', folder, sessions: sortByRecent(here), inScope: true };

  const groups = groupByFolder(matches, platform);
  const only = groups[0];
  if (groups.length === 1 && only !== undefined) {
    return { kind: 'alias', folder: only.folder, sessions: only.sessions, inScope: false };
  }
  return { kind: 'ambiguous', folders: groups };
}

/** Every aliased session in `folder`, or in all folders when `folder` is `null`, most recent
 *  first. Sessions with no alias are left out: this is the alias listing. */
export function aliasedSessions(
  catalog: readonly SessionMeta[],
  folder: string | null,
  platform: NodeJS.Platform,
): SessionMeta[] {
  return sortByRecent(
    catalog.filter(
      (s) =>
        aliasOf(s) !== null &&
        s.folder !== null &&
        (folder === null || sameFolder(s.folder, folder, platform)),
    ),
  );
}

function sortByRecent(sessions: SessionMeta[]): SessionMeta[] {
  return [...sessions].sort((a, b) => b.lastActivityMs - a.lastActivityMs);
}

function groupByFolder(
  sessions: readonly SessionMeta[],
  platform: NodeJS.Platform,
): { folder: string; sessions: SessionMeta[] }[] {
  const groups = new Map<string, { folder: string; sessions: SessionMeta[] }>();
  for (const s of sessions) {
    if (s.folder === null) continue;
    const k = folderUniquenessKey(s.folder, platform);
    let g = groups.get(k);
    if (g === undefined) {
      g = { folder: s.folder, sessions: [] };
      groups.set(k, g);
    }
    g.sessions.push(s);
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
