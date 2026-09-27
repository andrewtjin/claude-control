// The launcher's read of Claude Code's session store: which sessions `claude --resume <text>`,
// `--continue`, `--resume <id>` and `--resume <file>` can open from a folder, reproduced from Claude
// Code 2.1.283's own search so `cctl claude` routes the session Claude Code will actually open (see
// launcher.ts resolveLaunchSessions for how the answers are used). Read-only, offline, and never
// fatal: an unreadable directory or transcript is simply not a candidate.
//
// HOW A TRANSCRIPT IS READ. Claude Code's session listings never parse a whole transcript: they read
// its first and last 64 KiB and take the last custom / generated title in the tail (else in the
// head), the last relocation in the tail, and the first recorded cwd in the head. This module reads
// exactly those windows with exactly those rules, so it sees what Claude Code's search sees — and
// shares its one blind spot: a title written only in the middle of a transcript longer than 128 KiB
// (a /rename deep into a long session that has not exited since; titles are re-appended at exit) is
// invisible to both. The payoff is a bounded cost of two small reads per transcript however long it
// grows. When the session that opens carries a title this read missed, the enforcement guard, which
// checks every prompt against the live title, still has the last word.
//
// WHERE IT LOOKS (`--resume <text>`). Claude Code searches from the launch folder with the git
// worktrees of its repository: with at most one worktree, the folder's own project directory plus
// every `<folder-or-its-worktree>--claude-worktrees-*` directory; with two or more, every project
// directory named after a worktree or starting with that name plus '-' (which reaches subfolders and
// prefix siblings: `C--repo-sub`, `C--repo-other`), plus the folder's own directory when it is inside
// no worktree. When one of those folders has a lossy name (any character the project-directory name
// flattens) and none of its sessions is recorded in it, Claude Code widens the search to every
// project directory whose newest session was recorded there (or, with worktrees, beneath it) — this
// module does the same. Title matches are NOT filtered by recorded folder, and a project directory
// shared by two folders (`C:\a_b` and `C:\a-b` both flatten to `C--a-b`) contributes sessions of
// both, each with its own recorded folder: the launcher routes only when every candidate agrees.
//
// WHAT IT DOES NOT REPRODUCE. Claude Code's session-storage backends other than local files, and
// its `--continue` skips of sessions that are running in the background or superseded. Where those
// would change the pick, the launcher's pick can differ, and the guard judges the session that opens.

import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { aliasKey, projectDirMatches, projectDirStem } from '@claude-control/switch-engine';
import { sameFolder } from '@claude-control/daemon';
import type { LaunchSessionDeps, LaunchSessionFacts } from './launcher.js';

/** Claude Code's head and tail window for a transcript's quick read (its own constant). */
export const TRANSCRIPT_WINDOW_BYTES = 64 * 1024;

/** How long `git worktree list` may take before the launch gives up on it (and searches as if the
 *  folder had no worktrees). A launch must never hang on git. */
const GIT_TIMEOUT_MS = 3000;

/** How many directory listings / transcript reads run at once. Bounded so a store with thousands of
 *  transcripts cannot exhaust file handles. */
const IO_CONCURRENCY = 16;

/** Claude Code's project-directory name keeps only these characters; a folder with any other one
 *  has a lossy name, which is what lets its search widen (see the file header). */
const LOSSY_NAME_CHAR = /[^a-zA-Z0-9/\\:-]/;

/** No title, no folder: an empty transcript, or one whose windows record neither. */
const NOTHING_RECORDED: LaunchSessionFacts = { customTitle: null, aiTitle: null, folder: null };

// ---------------------------------------------------------------------------
// Reading one transcript (Claude Code's quick read)
// ---------------------------------------------------------------------------

/** Claude Code's decoding of a JSON string body: only a body with an escape needs parsing, and one
 *  that does not parse is kept as written. */
function decodeJsonStringBody(body: string): string {
  if (!body.includes('\\')) return body;
  try {
    return JSON.parse(`"${body}"`) as string;
  } catch {
    return body;
  }
}

/**
 * The value of the LAST `"field":"..."` in `text`, found by position rather than by parsing lines —
 * Claude Code's own title extraction, so a line cut in half by a window edge still yields its value
 * when the closing quote is inside the window. A needle inside a JSON string value never matches:
 * there the quotes are escaped.
 */
export function lastStringValue(text: string, field: string): string | undefined {
  let best: string | undefined;
  let bestAt = -1;
  for (const needle of [`"${field}":"`, `"${field}": "`]) {
    let from = 0;
    for (;;) {
      const at = text.indexOf(needle, from);
      if (at < 0) break;
      const start = at + needle.length;
      let end = start;
      let closed = false;
      while (end < text.length) {
        if (text[end] === '\\') {
          end += 2;
          continue;
        }
        if (text[end] === '"') {
          closed = true;
          break;
        }
        end += 1;
      }
      if (closed && at > bestAt) {
        best = decodeJsonStringBody(text.slice(start, end));
        bestAt = at;
      }
      from = end + 1;
    }
  }
  return best;
}

/** The string `field` of the LAST whole line in `text` that parses as a `{"type": type}` record —
 *  how Claude Code reads a relocation from the tail. */
export function lastTypedLineValue(text: string, field: string, type: string): string | undefined {
  const fieldNeedle = `"${field}":`;
  const typeNeedle = `"type":"${type}"`;
  let end = text.length;
  while (end > 0) {
    const newline = text.lastIndexOf('\n', end - 1);
    const line = text.slice(newline + 1, end);
    end = newline;
    if (line.includes(fieldNeedle) && line.includes(typeNeedle)) {
      const record = parseRecord(line);
      const value = record?.[field];
      if (record !== null && record.type === type && typeof value === 'string') return value;
    }
    if (newline < 0) break;
  }
  return undefined;
}

/** The top-level string `field` of the FIRST line in `text` that parses and has one — how Claude
 *  Code reads a session's recorded cwd from the head. */
export function firstLineValue(text: string, field: string): string | undefined {
  const needle = `"${field}":`;
  let start = 0;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const line = newline < 0 ? text.slice(start) : text.slice(start, newline);
    start = newline < 0 ? text.length : newline + 1;
    if (!line.includes(needle)) continue;
    const value = parseRecord(line)?.[field];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** A line parsed as a JSON object, or null (malformed, cut by a window edge, or not an object). */
function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A session's titles and folder from its transcript's head and tail windows (see the file header).
 *  Pure: the IO is {@link readTranscriptFacts}. A blank recorded folder counts as none. */
export function transcriptFacts(head: string, tail: string): LaunchSessionFacts {
  if (head === '') return NOTHING_RECORDED;
  const folder =
    lastTypedLineValue(tail, 'relocatedCwd', 'relocated') ?? firstLineValue(head, 'cwd');
  return {
    customTitle:
      lastStringValue(tail, 'customTitle') ?? lastStringValue(head, 'customTitle') ?? null,
    aiTitle: lastStringValue(tail, 'aiTitle') ?? lastStringValue(head, 'aiTitle') ?? null,
    folder: folder === undefined || folder === '' ? null : folder,
  };
}

/** Read a transcript's head and tail windows (one read when the file fits in one) and extract its
 *  facts. Null when the file cannot be opened or read — never a throw. */
export async function readTranscriptFacts(file: string): Promise<LaunchSessionFacts | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }
  try {
    const info = await handle.stat();
    if (!info.isFile()) return null;
    const buffer = Buffer.alloc(TRANSCRIPT_WINDOW_BYTES);
    const first = await handle.read(buffer, 0, TRANSCRIPT_WINDOW_BYTES, 0);
    const head = buffer.toString('utf8', 0, first.bytesRead);
    const tailStart = Math.max(0, info.size - TRANSCRIPT_WINDOW_BYTES);
    let tail = head;
    if (tailStart > 0) {
      const last = await handle.read(buffer, 0, TRANSCRIPT_WINDOW_BYTES, tailStart);
      tail = buffer.toString('utf8', 0, last.bytesRead);
    }
    return transcriptFacts(head, tail);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Where Claude Code looks
// ---------------------------------------------------------------------------

/** Claude Code's folder comparison form: forward slashes, lower case. */
function comparablePath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** Whether a folder's project-directory name loses information (see {@link LOSSY_NAME_CHAR}). */
export function hasLossyProjectName(folder: string): boolean {
  return LOSSY_NAME_CHAR.test(folder);
}

/** Which project directories `claude --resume <text>` searches, and for which folder. */
export interface ResumeSearchPlan {
  /** Each searched directory with the folder whose own sessions it holds — the folder its sessions
   *  count for when deciding whether to widen the search — or null for a `--claude-worktrees-`
   *  directory that no such decision counts. */
  dirs: Array<{ name: string; owner: string | null }>;
  /** Folders whose search Claude Code may widen (see the file header). */
  owners: string[];
  /** Whether a widened search also takes sessions recorded beneath an owner (the worktree case). */
  widenToSubfolders: boolean;
}

/**
 * Claude Code's resume search scope from `cwd`, over the project-directory names that exist. Pure.
 * Names compare case-insensitively. Past 200 characters Claude Code appends a hash to a directory
 * name that cctl does not reproduce, so a truncated name matches ANY hash — a superset, which can
 * only add candidates, never hide one.
 */
export function resumeSearchPlan(
  dirNames: readonly string[],
  cwd: string,
  worktrees: readonly string[],
): ResumeSearchPlan {
  const here = comparablePath(cwd);
  // The longest worktree that is, or contains, the launch folder.
  const containing = worktrees
    .filter((w) => {
      const path = comparablePath(w);
      return here === path || here.startsWith(`${path}/`);
    })
    .sort((a, b) => b.length - a.length)[0];

  if (worktrees.length <= 1) {
    const own = dirNames.filter((name) => projectDirMatches(name, cwd));
    const stem = projectDirStem(containing ?? cwd).toLowerCase();
    const prefix = stem.length < 200 ? `${stem}--claude-worktrees-` : `${stem}-`;
    const dirs: ResumeSearchPlan['dirs'] = own.map((name) => ({ name, owner: cwd }));
    for (const name of dirNames) {
      if (!own.includes(name) && name.toLowerCase().startsWith(prefix)) {
        dirs.push({ name, owner: null });
      }
    }
    return { dirs, owners: [cwd], widenToSubfolders: false };
  }

  const dirs: ResumeSearchPlan['dirs'] = [];
  const taken = new Set<string>();
  if (containing === undefined) {
    for (const name of dirNames) {
      if (!projectDirMatches(name, cwd)) continue;
      taken.add(name.toLowerCase());
      dirs.push({ name, owner: cwd });
    }
  }
  // Longest name first, so a directory belongs to the most specific worktree it matches.
  const specs = worktrees
    .map((path) => ({ path, stem: projectDirStem(path).toLowerCase() }))
    .sort((a, b) => b.stem.length - a.stem.length);
  for (const name of dirNames) {
    const lower = name.toLowerCase();
    if (taken.has(lower)) continue;
    const spec = specs.find((s) => lower === s.stem || lower.startsWith(`${s.stem}-`));
    if (spec === undefined) continue;
    taken.add(lower);
    dirs.push({ name, owner: spec.path });
  }
  return {
    dirs,
    owners: containing === undefined ? [cwd, ...worktrees] : [...worktrees],
    widenToSubfolders: true,
  };
}

/** The worktree paths in `git worktree list --porcelain` output (its `worktree <path>` lines). */
export function parseWorktreeList(porcelain: string): string[] {
  return porcelain
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.slice('worktree '.length))
    .filter((path) => path.length > 0);
}

/** The git worktrees of the repository `cwd` is in — `[]` when git is missing, fails, times out,
 *  or `cwd` is not in a repository (Claude Code then searches as for a single worktree). */
export function gitWorktreeList(cwd: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['worktree', 'list', '--porcelain'],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => resolve(err ? [] : parseWorktreeList(String(stdout))),
    );
  });
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/** One transcript file in a project directory. */
interface SessionFile {
  sessionId: string;
  file: string;
  mtimeMs: number;
}

/** A transcript file with its facts (null when it could not be read). */
interface ReadSession extends SessionFile {
  facts: LaunchSessionFacts | null;
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapBounded<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      out[i] = await fn(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The directory names under `root` (none when it is missing or unreadable). */
async function listDirNames(root: string): Promise<string[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

/** The transcripts directly in `dir`, newest first (stat only — nothing is read). */
async function listSessionFiles(dir: string): Promise<SessionFile[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
  const files = await mapBounded(names, IO_CONCURRENCY, async (name) => {
    const file = join(dir, name);
    try {
      const { mtimeMs } = await stat(file);
      return { sessionId: name.slice(0, -'.jsonl'.length), file, mtimeMs };
    } catch {
      return null;
    }
  });
  return files.filter((f): f is SessionFile => f !== null).sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** Injectable edges of {@link launchSessionStore}, for tests. */
export interface LaunchSessionStoreOptions {
  /** The main Claude Code config dir; transcripts live under `<claudeDir>/projects`. */
  claudeDir: string;
  /** The launch cwd EXACTLY as Claude Code will see it: its project directory is named from this
   *  spelling, not from the canonical path. */
  cwd: string;
  platform: NodeJS.Platform;
  /** The git worktree list for a folder (default: `git worktree list --porcelain`). */
  gitWorktrees?: (cwd: string) => Promise<string[]>;
  /** One transcript's facts (default: {@link readTranscriptFacts}). */
  readTranscript?: (file: string) => Promise<LaunchSessionFacts | null>;
  /** A folder's real path, or the folder itself when it has none (default: fs realpath). */
  realpath?: (folder: string) => string;
}

/** The real path of `folder`, or `folder` itself when it cannot be resolved. */
function realpathOrSelf(folder: string): string {
  try {
    return realpathSync.native(folder);
  } catch {
    return folder;
  }
}

/**
 * The session lookups the launcher needs, read from `<claudeDir>/projects` the way Claude Code
 * searches it from `cwd` (see the file header). Nothing is read until a lookup is called, and each
 * lookup reads only what its answer needs.
 */
export function launchSessionStore(options: LaunchSessionStoreOptions): LaunchSessionDeps {
  const root = join(options.claudeDir, 'projects');
  const cwd = options.cwd;
  const platform = options.platform;
  const gitWorktrees = options.gitWorktrees ?? gitWorktreeList;
  const readTranscript = options.readTranscript ?? readTranscriptFacts;
  const realpath = options.realpath ?? realpathOrSelf;
  const recordedHere = (folder: string, target: string): boolean =>
    sameFolder(folder, target, platform);

  /** Every transcript of one project directory, read. */
  const readDir = async (name: string): Promise<ReadSession[]> => {
    const files = await listSessionFiles(join(root, name));
    return mapBounded(files, IO_CONCURRENCY, async (f) => ({
      ...f,
      facts: await readTranscript(f.file),
    }));
  };

  /** For each named directory, the folder its NEWEST transcript records (null when none) — what
   *  Claude Code's widened search keys directories by. */
  const newestFolders = (names: readonly string[]) =>
    mapBounded(names, IO_CONCURRENCY, async (name) => {
      const newest = (await listSessionFiles(join(root, name)))[0];
      const facts = newest === undefined ? null : await readTranscript(newest.file);
      return { name, folder: facts?.folder ?? null };
    });

  /** Whether a recorded folder is `owner` (or beneath it, when `subfolders`), compared the way
   *  Claude Code's widened search does — on the owner as spelled and on its real path. */
  const widenedMatch = (folder: string, owner: string, subfolders: boolean): boolean => {
    const recorded = comparablePath(folder);
    return [owner, realpath(owner)].some((o) => {
      const path = comparablePath(o);
      return recorded === path || (subfolders && recorded.startsWith(`${path}/`));
    });
  };

  return {
    async sessionById(sessionId) {
      // Every project directory, newest copy wins (a relocation can leave the id in two places).
      // Machine-wide is at least as wide as Claude Code's own lookup: an id it cannot open opens
      // nothing, so locating it here anyway cannot misroute a session.
      const spellings = [...new Set([sessionId, sessionId.toLowerCase()])];
      const hits = await mapBounded(await listDirNames(root), IO_CONCURRENCY, async (name) => {
        for (const id of spellings) {
          const file = join(root, name, `${id}.jsonl`);
          try {
            const info = await stat(file);
            if (info.isFile()) return { file, mtimeMs: info.mtimeMs };
          } catch {
            // Not in this directory.
          }
        }
        return null;
      });
      const newest = hits
        .filter((h): h is { file: string; mtimeMs: number } => h !== null)
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0];
      return newest === undefined ? null : readTranscript(newest.file);
    },

    sessionAtPath(file) {
      return readTranscript(file);
    },

    async sessionsTitled(text) {
      const key = aliasKey(text);
      const names = await listDirNames(root);
      // A worktree lookup that fails searches as for a lone worktree, exactly like Claude Code;
      // the default never rejects, and an injected one must not fail the launch either.
      const worktrees = await gitWorktrees(cwd).catch((): string[] => []);
      const plan = resumeSearchPlan(names, cwd, worktrees);
      const read = new Map<string, ReadSession[]>();
      for (const { name } of plan.dirs) read.set(name, await readDir(name));

      // Widen the search for each lossy owner none of whose sessions is recorded in it. (Claude
      // Code widens only when every such session belongs to a DIFFERENT folder of the same
      // project-directory name; widening on the looser test here only ever adds candidates.)
      const widened = plan.owners.filter(
        (owner) =>
          hasLossyProjectName(owner) &&
          !plan.dirs.some(
            (d) =>
              d.owner === owner &&
              (read.get(d.name) ?? []).some(
                (s) => s.facts?.folder != null && recordedHere(s.facts.folder, owner),
              ),
          ),
      );
      if (widened.length > 0) {
        const others = names.filter((name) => !read.has(name));
        for (const { name, folder } of await newestFolders(others)) {
          if (folder === null) continue;
          if (widened.some((owner) => widenedMatch(folder, owner, plan.widenToSubfolders))) {
            read.set(name, await readDir(name));
          }
        }
      }

      // Claude Code's match: `(customTitle ?? aiTitle)` compared by alias key — a blank custom
      // title matches nothing and does not fall through to the generated one. One entry per
      // session id, the newest copy winning.
      const byId = new Map<string, ReadSession>();
      for (const sessions of read.values()) {
        for (const s of sessions) {
          const title = s.facts === null ? null : (s.facts.customTitle ?? s.facts.aiTitle);
          if (title === null || aliasKey(title) === '' || aliasKey(title) !== key) continue;
          const id = s.sessionId.toLowerCase();
          const known = byId.get(id);
          if (known === undefined || s.mtimeMs > known.mtimeMs) byId.set(id, s);
        }
      }
      return [...byId.values()].map((s) => s.facts!);
    },

    async continueSessions() {
      // The launch folder's own project directory, newest transcript first, read one at a time:
      // `--continue` opens the newest session recorded HERE. Anything newer that belongs to another
      // folder is kept as a candidate too (Claude Code's own filter of those is finer than this
      // read can tell), and a transcript that records no folder holds no conversation to continue.
      const own = (await listDirNames(root)).filter((name) => projectDirMatches(name, cwd));
      const files = (await Promise.all(own.map((name) => listSessionFiles(join(root, name)))))
        .flat()
        .sort((a, b) => b.mtimeMs - a.mtimeMs);
      const candidates: LaunchSessionFacts[] = [];
      for (const f of files) {
        const facts = await readTranscript(f.file);
        if (facts === null || facts.folder === null) continue;
        candidates.push(facts);
        if (recordedHere(facts.folder, cwd)) return candidates;
      }
      // No session recorded here: what `--continue` opens (if anything) cannot be named.
      return [];
    },
  };
}
