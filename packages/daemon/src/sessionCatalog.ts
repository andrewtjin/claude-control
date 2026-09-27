// A catalog of Claude Code sessions on this machine: each session's alias (its title), the folder
// it belongs to and when it was active, read out of Claude Code's own transcripts.
//
// WHAT AN ALIAS IS. A session's title: `{"type":"custom-title","customTitle":…}` (set by `/rename`
// or `claude --name`), else the generated `{"type":"ai-title","aiTitle":…}`. Both are LAST-WINS
// (Claude Code re-appends them on exit, and a later `/rename` supersedes an earlier one). This is
// exactly what `claude --resume <name>` matches — `(customTitle ?? aiTitle)`, lower-cased and
// trimmed, equal to the argument likewise normalized — so an alias here means what it means there.
//
// WHICH FOLDER. The launch cwd (the first `cwd` a transcript records), unless a `relocated` line
// moved the session (last-wins `relocatedCwd`). The project directory's NAME is not used for this:
// Claude Code builds it by replacing every non-alphanumeric character with `-` (plus a hash past
// 200 characters), so `C:\a_b` and `C:\a-b` share one directory. The name only narrows which
// directories are worth opening; the recorded cwd decides.
//
// Same reading discipline as transcriptTokens.ts: stream on bytes, decode only lines whose raw
// bytes can hold what is wanted, tolerate every malformed line.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  aliasKey,
  projectDirMatches,
  projectDirStem,
  type SessionIdentity,
} from '@claude-control/switch-engine';
import { forEachLine } from './transcriptTokens.js';

/** One session, as its transcript describes it. */
export interface SessionMeta {
  sessionId: string;
  /** The session's top-level transcript. */
  file: string;
  /** The project directory's name under `<claudeDir>/projects`. */
  projectDir: string;
  /** The first `cwd` the transcript records; `null` if it records none. */
  launchCwd: string | null;
  /** Where the session belongs now: the last `relocatedCwd`, else {@link launchCwd}. */
  folder: string | null;
  /** Last `customTitle` (`/rename`, `--name`); `null` if never set. */
  customTitle: string | null;
  /** Last `aiTitle`; `null` if never generated. */
  aiTitle: string | null;
  /** The first line timestamp, epoch ms; `null` if none parses. */
  firstActivityMs: number | null;
  /** The transcript's mtime: Claude Code appends on every turn and re-stamps on exit, so this is
   *  the session's last activity without reading the whole file's timestamps. */
  lastActivityMs: number;
}

export interface SessionCatalog {
  sessions: SessionMeta[];
  filesUnreadable: number;
  dirsUnreadable: number;
  malformedLines: number;
}

export interface ReadSessionCatalogOptions {
  /** The shared Claude config dir (`Paths.claudeDir`). Profiles junction `projects/` to it, so one
   *  read covers sessions of every slot. */
  claudeDir: string;
  /** Read only project directories this accepts (by name). Absent = all. */
  projectDirFilter?: (name: string) => boolean;
  /** Read only these sessions' transcripts (compared case-insensitively). Absent = all. */
  sessionIds?: ReadonlySet<string>;
}

/** The alias `claude --resume` would match for this session: `customTitle ?? aiTitle`. A session
 *  with an empty custom title has NO alias (the `??` does not fall through on ''), matching the
 *  resume search exactly. */
export function aliasOf(meta: Pick<SessionMeta, 'customTitle' | 'aiTitle'>): string | null {
  const alias = meta.customTitle ?? meta.aiTitle;
  return alias === null || alias.trim() === '' ? null : alias;
}

/** The comparison form of an alias: the resume search's `toLowerCase().trim()`. Re-exported from
 *  switch-engine, which owns it: an alias BINDING keys on the same function (and the enforcement
 *  guard embeds it), so the lookup here and the binding there can never compare titles differently. */
export { aliasKey };

/** Claude Code's project-directory naming (`projectDirStem`, `projectDirMatches`). Owned by
 *  switch-engine, because the enforcement guard embeds the same functions to tell which folder a
 *  prompt's transcript belongs to; re-exported here for the catalog's callers. */
export { projectDirMatches, projectDirStem };

// Byte needles. A needle containing quotes can only match STRUCTURE: inside a JSON string value
// the same characters are escaped (`\"type\":\"custom-title\"`), so a message that merely quotes
// one of these never matches and is never decoded.
const CUSTOM_TITLE_NEEDLE = Buffer.from('"type":"custom-title"');
const AI_TITLE_NEEDLE = Buffer.from('"type":"ai-title"');
const RELOCATED_NEEDLE = Buffer.from('"type":"relocated"');
const CWD_NEEDLE = Buffer.from('"cwd":');
const TIMESTAMP_NEEDLE = Buffer.from('"timestamp":');

/** A top-level transcript's session id: a `<id>.jsonl` directly in a project directory. */
function sessionIdOfName(name: string): string | null {
  if (!name.endsWith('.jsonl')) return null;
  const id = name.slice(0, -'.jsonl'.length);
  return id === '' ? null : id;
}

function parseObject(bytes: Buffer): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Read one transcript's metadata. Throws only on an IO failure (the caller counts it). */
async function readMeta(
  file: string,
  sessionId: string,
  projectDir: string,
  lastActivityMs: number,
  counters: { malformedLines: number },
): Promise<SessionMeta> {
  const meta: SessionMeta = {
    sessionId,
    file,
    projectDir,
    launchCwd: null,
    folder: null,
    customTitle: null,
    aiTitle: null,
    firstActivityMs: null,
    lastActivityMs,
  };
  let relocatedCwd: string | null = null;
  await forEachLine(file, (bytes) => {
    if (bytes.length === 0) return;
    const wantsCwd = meta.launchCwd === null && bytes.includes(CWD_NEEDLE);
    const wantsTs = meta.firstActivityMs === null && bytes.includes(TIMESTAMP_NEEDLE);
    const isCustom = bytes.includes(CUSTOM_TITLE_NEEDLE);
    const isAi = bytes.includes(AI_TITLE_NEEDLE);
    const isRelocated = bytes.includes(RELOCATED_NEEDLE);
    if (!wantsCwd && !wantsTs && !isCustom && !isAi && !isRelocated) return;
    const line = parseObject(bytes);
    if (line === null) {
      counters.malformedLines++;
      return;
    }
    // Top-level fields only: the needles can also match a nested object, which is not a record.
    if (wantsCwd && typeof line.cwd === 'string' && line.cwd !== '') meta.launchCwd = line.cwd;
    if (wantsTs && typeof line.timestamp === 'string') {
      const ts = Date.parse(line.timestamp);
      if (Number.isFinite(ts)) meta.firstActivityMs = ts;
    }
    if (line.type === 'custom-title' && typeof line.customTitle === 'string') {
      meta.customTitle = line.customTitle;
    } else if (line.type === 'ai-title' && typeof line.aiTitle === 'string') {
      meta.aiTitle = line.aiTitle;
    } else if (
      line.type === 'relocated' &&
      typeof line.relocatedCwd === 'string' &&
      line.relocatedCwd !== ''
    ) {
      relocatedCwd = line.relocatedCwd;
    }
  });
  meta.folder = relocatedCwd ?? meta.launchCwd;
  return meta;
}

/**
 * What the transcripts under `claudeDir` record about these sessions: each one's custom title (a
 * blank one names nothing) and its folder, keyed by LOWER-CASED id; an id with no transcript is
 * absent. The engine's `SessionIdentityLookup` — how the running-session scan learns the title of a
 * session whose `sessions/<pid>.json` only carries a derived name (every `--resume` launch). Reads
 * only these sessions' transcripts.
 */
export async function sessionIdentities(
  claudeDir: string,
  sessionIds: readonly string[],
): Promise<Map<string, SessionIdentity>> {
  const catalog = await readSessionCatalog({ claudeDir, sessionIds: new Set(sessionIds) });
  const out = new Map<string, SessionIdentity>();
  for (const meta of catalog.sessions) {
    const custom = meta.customTitle;
    out.set(meta.sessionId.toLowerCase(), {
      customTitle: custom !== null && custom.trim() !== '' ? custom : null,
      folder: meta.folder,
    });
  }
  return out;
}

/**
 * Read every session's metadata under `<claudeDir>/projects`. One entry per session id: when a
 * relocation left the same id in two project directories, the most recently written transcript
 * wins (the same rule `claude --resume` applies). A missing projects directory is an empty
 * catalog; an unreadable directory or file is counted, never fatal.
 */
export async function readSessionCatalog(
  options: ReadSessionCatalogOptions,
): Promise<SessionCatalog> {
  const root = join(options.claudeDir, 'projects');
  const catalog: SessionCatalog = {
    sessions: [],
    filesUnreadable: 0,
    dirsUnreadable: 0,
    malformedLines: 0,
  };
  let projectDirs;
  try {
    projectDirs = await readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') catalog.dirsUnreadable++;
    return catalog;
  }

  const wantedIds =
    options.sessionIds === undefined
      ? undefined
      : new Set([...options.sessionIds].map((id) => id.toLowerCase()));
  const byId = new Map<string, SessionMeta>();
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    if (options.projectDirFilter !== undefined && !options.projectDirFilter(dir.name)) continue;
    let entries;
    try {
      entries = await readdir(join(root, dir.name), { withFileTypes: true });
    } catch {
      catalog.dirsUnreadable++;
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const sessionId = sessionIdOfName(entry.name);
      if (sessionId === null) continue;
      if (wantedIds !== undefined && !wantedIds.has(sessionId.toLowerCase())) continue;
      const file = join(root, dir.name, entry.name);
      try {
        const { mtimeMs } = await stat(file);
        const known = byId.get(sessionId);
        if (known !== undefined && known.lastActivityMs >= mtimeMs) continue;
        byId.set(sessionId, await readMeta(file, sessionId, dir.name, mtimeMs, catalog));
      } catch {
        catalog.filesUnreadable++;
      }
    }
  }
  catalog.sessions = [...byId.values()];
  return catalog;
}
