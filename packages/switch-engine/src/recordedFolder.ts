// The folder a Claude Code transcript's conversation belongs to — the ONE reading every consumer of
// an alias binding's folder key uses: the launcher (which binding `cctl claude` routes a session
// to), the enforcement guard (which embeds this source verbatim: it is a dependency-free script and
// cannot import this module), the daemon's session catalog (`cctl session show|aliases`) and the
// running-session scan that guards an unbind. If any two of them read a transcript differently, a
// legitimately bound session is blocked on the very command the block tells the operator to run, or
// a bound conversation silently leaves its binding — so none of them may read it any other way.
//
// THE POLICY (measured on Claude Code 2.1.283 and on a real transcript corpus):
//   - the launch folder: the FIRST line with a top-level `cwd` within the first 1 MiB. Claude Code
//     writes a first prompt twice before that line (a queue-operation line, then the user line whose
//     cwd follows the message), so a 70 KiB prompt already puts it past 144 KB: a small window would
//     miss it. Only complete lines count; a cwd further out is not read at all;
//   - a relocation: the LAST complete `{"type":"relocated","relocatedCwd":…}` line within the last
//     64 KiB (Claude Code's own tail window — it re-appends the relocation with its title metadata,
//     so the current one stays in it). Claude Code writes one when a session enters or leaves a
//     `.claude/worktrees/<name>` checkout; it never moves the transcript file;
//   - consistency: Claude Code files a transcript under the project directory named after the folder
//     it launched in (every non-alphanumeric character -> `-`; see projectDirMatches) — true of
//     resumed sessions (their file stays where it was), forks (a new file in the launch folder's
//     directory with every cwd rewritten), junctions (Claude Code resolves them before naming the
//     directory), a folder spelled in another case, and paths past 200 characters. So a launch
//     folder that does not encode to its own directory's name can only come from an edit, and is
//     not trusted; nor is a relocation outside the launch folder's worktree root (the folder the
//     `.claude/worktrees/<name>` checkout belongs to);
//   - fallback: when no launch folder is accepted (none within the window, an inconsistent one, or
//     the file is missing or unreadable), the transcript belongs to the folder the session RUNS in
//     only when the project-directory name can stand for that folder, and otherwise to no folder an
//     alias rule can name. The name is lossy (`C:\a_b` and `C:\a-b` share one), so it is never used
//     to pick a bound folder the session does not run in.
//
// EMBEDDING CONTRACT (as folderPath.ts): every function here the guard embeds references only its
// parameters, its own nested helpers, node's global Buffer, and the other functions of THIS module
// (a call into another module is rewritten by some loaders and would not resolve in the guard). Do
// not move a nested helper to module scope: the guard would throw on every prompt, failing open.

import { embedFunctionAs } from './embed.js';

/**
 * Claude Code's project-directory name for a session launched in `cwd` (its transcripts live in
 * `<config dir>/projects/<name>/`): every character that is not an ASCII letter or digit becomes
 * `-`, per UTF-16 code unit, exactly as Claude Code's own sanitizer does. Past 200 characters
 * Claude Code truncates and appends a hash cctl does not reproduce, so this returns the truncated
 * STEM; {@link projectDirMatches} accounts for the suffix. Lossy by construction (`C:\a_b` and
 * `C:\a-b` share one name), so a name only narrows where a session can live — its recorded cwd
 * decides.
 *
 * SELF-CONTAINED BY CONTRACT (the guard embeds it): references nothing at module scope.
 */
export function projectDirStem(cwd: string): string {
  const max = 200;
  const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  return name.length <= max ? name : name.slice(0, max);
}

/**
 * Whether project directory `name` can hold sessions launched in `cwd`: its exact encoding, or, for
 * a long cwd, the truncated stem plus Claude Code's hash suffix. Case-insensitive, because Windows
 * drive letters and folders reach Claude Code in whatever case the shell used (and Claude Code
 * compares these names case-insensitively itself). A true answer is only a candidate.
 *
 * SELF-CONTAINED BY CONTRACT: calls only {@link projectDirStem}, which the embedding places in the
 * same scope.
 */
export function projectDirMatches(name: string, cwd: string): boolean {
  const stem = projectDirStem(cwd).toLowerCase();
  const n = name.toLowerCase();
  if (stem.length < 200) return n === stem;
  return n === stem || n.startsWith(stem + '-');
}

/** The bytes at a transcript's start searched for its launch folder (the first top-level cwd). */
export const RECORDED_FOLDER_HEAD_BYTES = 1024 * 1024;

/** The bytes at a transcript's end searched for its last relocation (Claude Code's tail window). */
export const RECORDED_FOLDER_TAIL_BYTES = 64 * 1024;

/** The synchronous file operations {@link readRecordedFolder} needs — `node:fs` satisfies it. A
 *  seam rather than an import so the function stays embeddable (the guard passes its own `fs`). */
export interface RecordedFolderFs {
  statSync(path: string): { isFile(): boolean; size: number };
  openSync(path: string, flags: string): number;
  readSync(
    fd: number,
    buffer: NodeJS.ArrayBufferView,
    offset: number,
    length: number,
    position: number,
  ): number;
  closeSync(fd: number): void;
}

/** What a transcript records about the folder its conversation belongs to. */
export interface RecordedFolderRead {
  /** `read`: the file was read; `missing`: it does not exist (yet — a new session's transcript is
   *  written after its first prompt); `unreadable`: it exists but could not be read (locked, not a
   *  regular file, an IO error). */
  status: 'read' | 'missing' | 'unreadable';
  /** The name of the project directory the transcript lives in — the fallback. */
  dirName: string;
  /** The launch folder (first top-level cwd), as Claude Code spelled it, when accepted; else null. */
  launchFolder: string | null;
  /** Where the conversation belongs: an accepted relocation, else {@link launchFolder}; null when
   *  no launch folder is accepted (the caller then applies the fallback, {@link recordedFolderFor}). */
  folder: string | null;
  /** Whether the window held a top-level cwd at all, accepted or not. False for a transcript that
   *  records no conversation (only bookkeeping lines) — or whose first cwd lies past the window. */
  sawCwd: boolean;
}

/**
 * Read where a transcript's conversation belongs (see the file header for the policy). Never throws:
 * every filesystem error becomes `missing` (ENOENT, ENOTDIR) or `unreadable`. A path that is not a
 * regular file (a directory, a FIFO, a device) is never opened. Synchronous: the guard is a
 * synchronous script, and every other caller reads a handful of transcripts, bounded by the windows.
 *
 * SELF-CONTAINED BY CONTRACT (the guard embeds it): see the file header.
 */
export function readRecordedFolder(
  file: string,
  fs: RecordedFolderFs,
  platform: NodeJS.Platform,
): RecordedFolderRead {
  const HEAD_MAX_BYTES = 1024 * 1024;
  const TAIL_BYTES = 64 * 1024;
  const CHUNK_BYTES = 64 * 1024;
  const NEWLINE = 10;
  const win = platform === 'win32';

  // The name of the directory holding `path` (its parent's last segment), split on this platform's
  // separators; '' when the path has no parent.
  function parentName(path: string): string {
    const parts = path.split(win ? /[\\/]+/ : /\/+/).filter((s) => s !== '');
    return parts.length >= 2 ? parts[parts.length - 2]! : '';
  }

  // One JSONL line parsed as an object, or null (malformed, torn, or not an object).
  function parseLine(line: Buffer): Record<string, unknown> | null {
    try {
      const parsed: unknown = JSON.parse(line.toString('utf8'));
      return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  // A line's top-level `cwd` (non-empty string), or null. The needle only skips lines that cannot
  // hold one without parsing them; a quoted needle inside a string value is escaped, never matched.
  function cwdOf(line: Buffer): string | null {
    if (line.indexOf('"cwd":') === -1) return null;
    const value = parseLine(line)?.cwd;
    return typeof value === 'string' && value !== '' ? value : null;
  }

  // A folder's worktree root, in a comparable form: the folder a `.claude/worktrees/<name>` checkout
  // belongs to, else the folder itself. Windows folds case and separators; trailing separators go.
  function worktreeRoot(path: string): string {
    let p = win ? path.replace(/\//g, '\\').toLowerCase() : path;
    p = p.replace(win ? /\\+$/ : /\/+$/, '');
    const m = (
      win ? /^(.*)\\\.claude\\worktrees\\[^\\]+$/ : /^(.*)\/\.claude\/worktrees\/[^/]+$/
    ).exec(p);
    return m !== null ? m[1]! : p;
  }

  const dirName = parentName(file);
  const nothing = (status: RecordedFolderRead['status']): RecordedFolderRead => ({
    status,
    dirName,
    launchFolder: null,
    folder: null,
    sawCwd: false,
  });

  let size: number;
  let fd: number;
  try {
    const info = fs.statSync(file);
    if (!info.isFile()) return nothing('unreadable');
    size = info.size;
    fd = fs.openSync(file, 'r');
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    return nothing(code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unreadable');
  }
  try {
    // HEAD: read in chunks, scanning each complete line as it arrives, and stop at the first cwd —
    // a typical transcript records it within its first kilobyte.
    const headLength = Math.min(size, HEAD_MAX_BYTES);
    const head = Buffer.alloc(headLength);
    let got = 0;
    let lineStart = 0;
    let launch: string | null = null;
    while (launch === null && got < headLength) {
      const n = fs.readSync(fd, head, got, Math.min(CHUNK_BYTES, headLength - got), got);
      if (n <= 0) break;
      got += n;
      const filled = head.subarray(0, got);
      let newline = filled.indexOf(NEWLINE, lineStart);
      while (launch === null && newline !== -1) {
        launch = cwdOf(filled.subarray(lineStart, newline));
        lineStart = newline + 1;
        if (launch === null) newline = filled.indexOf(NEWLINE, lineStart);
      }
    }
    // A last line with no newline is complete only when the window reached the end of the file.
    if (launch === null && got >= size && lineStart < got) {
      launch = cwdOf(head.subarray(lineStart, got));
    }
    const sawCwd = launch !== null;
    if (launch === null || !projectDirMatches(dirName, launch)) {
      return { status: 'read', dirName, launchFolder: null, folder: null, sawCwd };
    }

    // TAIL: the last TAIL_BYTES, read from one byte earlier so a line starting exactly at the
    // window's edge is known to be whole; the partial first line is dropped.
    const tailStart = Math.max(0, size - TAIL_BYTES);
    const from = tailStart > 0 ? tailStart - 1 : 0;
    const tail = Buffer.alloc(size - from);
    let tailGot = 0;
    while (tailGot < tail.length) {
      const n = fs.readSync(fd, tail, tailGot, tail.length - tailGot, from + tailGot);
      if (n <= 0) break;
      tailGot += n;
    }
    let text = tail.subarray(0, tailGot);
    if (tailStart > 0) {
      const newline = text.indexOf(NEWLINE);
      text = newline === -1 ? text.subarray(text.length) : text.subarray(newline + 1);
    }
    let relocated: string | null = null;
    let end = text.length;
    while (relocated === null && end > 0) {
      const newline = text.lastIndexOf(NEWLINE, end - 1);
      const line = text.subarray(newline + 1, end);
      if (line.indexOf('"relocatedCwd":') !== -1) {
        const record = parseLine(line);
        const value = record?.relocatedCwd;
        if (record?.type === 'relocated' && typeof value === 'string' && value !== '') {
          relocated = value;
        }
      }
      end = newline;
    }
    const folder =
      relocated !== null && worktreeRoot(relocated) === worktreeRoot(launch) ? relocated : launch;
    return { status: 'read', dirName, launchFolder: launch, folder, sawCwd };
  } catch {
    return nothing('unreadable');
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      // Nothing to do: the read already has its answer.
    }
  }
}

/**
 * The folder an alias binding is matched against for a transcript {@link readRecordedFolder} read,
 * given the folder the session RUNS in (as Claude Code spelled it — the name its project directory
 * is built from — and canonically): the accepted recorded folder, canonicalized by the caller's rule;
 * else the running folder, when the transcript's project-directory name can stand for it (a session
 * that runs where it was recorded); else null — no alias rule applies. See the file header.
 *
 * SELF-CONTAINED BY CONTRACT (the guard embeds it): calls only its parameters and projectDirMatches.
 */
export function recordedFolderFor(
  read: { folder: string | null; dirName: string },
  running: { spelled: string; canonical: string },
  canonicalize: (folder: string) => string,
): string | null {
  if (read.folder !== null) return canonicalize(read.folder);
  return projectDirMatches(read.dirName, running.spelled) ||
    projectDirMatches(read.dirName, running.canonical)
    ? running.canonical
    : null;
}

/**
 * The embeddable source of {@link readRecordedFolder} and {@link recordedFolderFor}, for the
 * enforcement guard. Emitted beside folderPath.ts's `embeddableFolderPathSource()`, which already
 * emits the project-directory naming they call; the colocated test evaluates the two together and
 * proves the embedded copies agree with the live functions on real files.
 */
export function embeddableRecordedFolderSource(): string {
  return [
    embedFunctionAs(readRecordedFolder, 'readRecordedFolder'),
    embedFunctionAs(recordedFolderFor, 'recordedFolderFor'),
  ].join('\n');
}
