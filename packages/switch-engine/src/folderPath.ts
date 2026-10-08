// Folder canonicalization — the single authority for turning an operator-supplied path into the
// stable key a folder binding is stored and compared under.
//
// There are TWO consumers that must agree byte-for-byte: this package (bind/unbind, resolution)
// and the enforcement hook script, which runs as a dependency-free CommonJS file spawned by
// Claude Code. The hook cannot import this module, so it embeds the COMPILED source of
// `canonicalizeFolder` (plus `folderKey`/`isWithin`) via `fn.toString()`. That embedding is only
// sound if those functions reference nothing at module scope — no imports, no module constants,
// no sibling helpers. Hence the deliberate shape below: `canonicalizeFolder` takes every platform
// and filesystem dependency as a parameter and declares its own helpers INSIDE its body, and a
// test evals the embedded copy and proves it agrees with the live function on the full case table.
// Do not "tidy" a nested helper up to module scope; that silently breaks the hook.

/** Platform + filesystem seam for {@link canonicalizeFolder}. Passed in (never read from
 *  `process`/`node:*`) so the function stays self-contained and embeddable. */
export interface CanonicalizeDeps {
  /** `process.platform`. Selects Windows vs POSIX path rules. */
  platform: NodeJS.Platform;
  /** Absolute base directory a relative input is resolved against (e.g. `process.cwd()`). */
  cwd: string;
  /** `fs.realpathSync.native` equivalent: returns the true on-disk path (resolving junctions,
   *  symlinks, 8.3 short names and true case) or THROWS when the path does not exist. */
  realpath: (path: string) => string;
}

/** Success carries the canonical path; failure carries a human reason (surfaced by the CLI and,
 *  for the guard, kept internal). A failure caused by a character no canonical path may hold (a
 *  control, or a bidi/format control) also carries that character's index in the input: everything
 *  before the separator preceding it is still an ordinary path, which is what lets the guard judge a
 *  real folder with such a name by its nearest clean ancestor instead of giving up on it. */
export type CanonicalizeResult =
  { ok: true; path: string } | { ok: false; reason: string; unsafeCharIndex?: number };

/**
 * Canonicalize a folder path to the stable form a binding is keyed on.
 *
 * SELF-CONTAINED BY CONTRACT (see file header): references only its parameters and its own nested
 * helpers, so `canonicalizeFolder.toString()` is a complete, embeddable program.
 *
 * Steps, in order: reject empty / control chars; NFC; on Windows strip `\\?\` / `\\?\UNC\` and
 * reject `\\.\` device paths, drive-relative `C:foo`, and any NTFS ADS colon; resolve to absolute
 * against `cwd`; prefer `realpath.native` when the path exists (the only thing that resolves
 * junctions/symlinks/8.3/true-case), else a pure-string normalization; collapse separators and
 * `.`/`..`; strip trailing separators (keeping the root); on Windows strip each segment's trailing
 * dots and spaces (the NTFS layer ignores them).
 */
export function canonicalizeFolder(input: string, deps: CanonicalizeDeps): CanonicalizeResult {
  const platform = deps.platform;
  const cwd = deps.cwd;
  const realpath = deps.realpath;
  const win = platform === 'win32';
  const sep = win ? '\\' : '/';

  // A separator for this platform. Windows accepts both slashes; POSIX only '/'.
  function isSep(ch: string): boolean {
    return ch === '/' || (win && ch === '\\');
  }
  function isLetter(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }
  // Windows ignores trailing dots/spaces on a name, so "foo. " and "foo" are the same directory.
  function stripTrailingDotsSpaces(segment: string): string {
    let end = segment.length;
    while (end > 0 && (segment[end - 1] === '.' || segment[end - 1] === ' ')) end -= 1;
    return segment.slice(0, end);
  }

  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, reason: 'path is empty' };
  }
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    // C0 (incl. NUL) and C1/DEL control ranges: never legal in a folder name, and a NUL is a
    // truncation/injection hazard once the value flows into a hook or shell.
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return { ok: false, reason: 'path contains a control character', unsafeCharIndex: i };
    }
    // Unicode bidirectional/format controls (LRM/RLM, the embeddings/overrides U+202A-202E, the
    // isolates U+2066-2069, and the BOM U+FEFF). A canonicalizer has no reason to accept them, and
    // on a terminal a right-to-left override reorders a rendered path so the eye reads a different
    // folder than the one matched. Rejecting keeps every bound folder's canonical key — and the
    // guard snapshot built from it — plain left-to-right printable text.
    if (
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return {
        ok: false,
        reason: 'path contains a bidirectional or format control character',
        unsafeCharIndex: i,
      };
    }
  }

  // NFC up front so every later comparison and the emitted name are in one canonical form; NFD and
  // NFC spell the same directory but compare unequal as code points.
  let s = input.normalize('NFC');

  if (win) {
    // Windows accepts either slash as a separator. Fold forward slashes to backslashes up front so a
    // device, extended-length, drive-relative or alternate-data-stream path spelled with mixed or
    // forward separators (e.g. "/\.\PhysicalDrive0") is caught by the checks below, instead of
    // slipping past a single-spelling check and normalizing back into the very form they reject.
    s = s.replace(/\//g, '\\');

    // Device namespace addresses a raw device, never a directory.
    if (s.startsWith('\\\\.\\')) {
      return { ok: false, reason: 'device namespace path is not a folder' };
    }
    // Extended-length prefixes: fold them away so \\?\C:\x and C:\x canonicalize identically.
    if (s.length >= 8 && s.startsWith('\\\\?\\UNC\\')) {
      s = '\\\\' + s.slice(8);
    } else if (s.length >= 4 && s.startsWith('\\\\?\\')) {
      s = s.slice(4);
      // \\?\ wrapping a device path reduces to a device path.
      if (s.startsWith('.\\')) {
        return { ok: false, reason: 'device namespace path is not a folder' };
      }
    }

    // The only legal colon in a Windows path is the drive designator at index 1.
    const colon = s.indexOf(':');
    if (colon !== -1) {
      if (colon !== 1 || !isLetter(s[0] ?? '')) {
        return { ok: false, reason: 'alternate data stream or invalid colon in path' };
      }
      if (s.indexOf(':', 2) !== -1) {
        return { ok: false, reason: 'alternate data stream in path' };
      }
      const after = s[2];
      // "C:foo"/"C:" are drive-RELATIVE (each drive has its own working dir) — a different place
      // per process. Refuse rather than guess a base.
      if (after === undefined || !isSep(after)) {
        return { ok: false, reason: 'drive-relative path is ambiguous' };
      }
    }
  }

  // Resolve to an absolute path.
  function toAbsolute(p: string): string {
    if (!win) {
      if (p.length > 0 && p[0] === '/') return p;
      return cwd + '/' + p;
    }
    if (p.length >= 3 && isLetter(p[0] ?? '') && p[1] === ':' && isSep(p[2] ?? '')) return p;
    if (p.length >= 2 && isSep(p[0] ?? '') && isSep(p[1] ?? '')) return p; // UNC
    if (p.length >= 1 && isSep(p[0] ?? '')) {
      // Rooted but drive-less ("\foo"): inherit the base dir's drive.
      const drive = cwd.length >= 2 && cwd[1] === ':' ? cwd.slice(0, 2) : '';
      return drive + p;
    }
    return cwd + sep + p;
  }

  const abs = toAbsolute(s);

  // Prefer the real on-disk path — the ONLY step that resolves junctions, symlinks, 8.3 short names
  // and true case. When the leaf does not exist yet, realpath the DEEPEST existing ancestor and
  // re-attach the missing tail, so a not-yet-created folder reached through a junctioned/symlinked
  // ancestor still resolves to the same key as an existing one (enforcement must not be existence-
  // dependent). Only when nothing up to the root resolves do we fall back to the unresolved string.
  function resolvePreferReal(p: string): { path: string; real: boolean } {
    const tail: string[] = []; // stripped leaf segments, deepest first
    let head = p;
    for (;;) {
      try {
        const real = realpath(head);
        let out = real;
        for (let k = tail.length - 1; k >= 0; k -= 1) out = out + sep + tail[k];
        return { path: out, real: true };
      } catch {
        // Locate the last segment (ignoring any trailing separators).
        let end = head.length;
        while (end > 0 && isSep(head[end - 1] ?? '')) end -= 1;
        let start = end;
        while (start > 0 && !isSep(head[start - 1] ?? '')) start -= 1;
        const seg = head.slice(start, end);
        // No strippable segment (reached the root or a bare drive) — cannot resolve further.
        if (seg === '' || start === 0) return { path: p, real: false };
        // Parent = everything before the segment, trailing separators removed.
        let pe = start;
        while (pe > 0 && isSep(head[pe - 1] ?? '')) pe -= 1;
        let parent = head.slice(0, pe);
        // A bare drive ("C:") is drive-relative, not the drive root; restore the root separator so
        // the next probe targets "C:\" rather than a per-drive working directory.
        if (win && parent.length === 2 && isLetter(parent[0] ?? '') && parent[1] === ':') {
          parent = parent + '\\';
        }
        if (parent === '') return { path: p, real: false };
        tail.push(seg);
        head = parent;
      }
    }
  }

  const pref = resolvePreferReal(abs);
  let resolved = pref.path;
  const usedRealpath = pref.real;
  if (usedRealpath) {
    resolved = resolved.normalize('NFC');
    if (win) {
      if (resolved.startsWith('\\\\?\\UNC\\')) resolved = '\\\\' + resolved.slice(8);
      else if (resolved.startsWith('\\\\?\\')) resolved = resolved.slice(4);
    }
  }

  // Peel off the root prefix; everything after it is ordinary segments.
  let root = '';
  let rest = resolved;
  if (!win) {
    if (rest.length > 0 && rest[0] === '/') {
      root = '/';
      rest = rest.slice(1);
    }
  } else if (rest.length >= 2 && isSep(rest[0] ?? '') && isSep(rest[1] ?? '')) {
    // UNC: the root is \\server\share (two segments), which no '..' may escape.
    let j = 2;
    while (j < rest.length && !isSep(rest[j] ?? '')) j += 1; // server
    while (j < rest.length && isSep(rest[j] ?? '')) j += 1;
    while (j < rest.length && !isSep(rest[j] ?? '')) j += 1; // share
    root = '\\\\' + rest.slice(2, j).split('/').join('\\');
    rest = rest.slice(j);
  } else if (rest.length >= 2 && isLetter(rest[0] ?? '') && rest[1] === ':') {
    root = (rest[0] ?? '').toUpperCase() + ':\\';
    rest = rest.slice(2);
  }

  // Segment processing: drop ''/'.'; '..' pops the previous real segment but never past the root.
  const rawSegs = win ? rest.split(/[\\/]+/) : rest.split('/');
  const segs: string[] = [];
  for (const raw of rawSegs) {
    let seg = raw;
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (segs.length > 0) segs.pop();
      continue;
    }
    if (win) {
      seg = stripTrailingDotsSpaces(seg);
      if (seg === '') continue;
    }
    segs.push(seg);
  }

  // Reassemble. A drive/POSIX root already ends in a separator; a UNC root does not, so it needs
  // one inserted before the first segment. A bare root (no segments) stays exactly the root.
  let out: string;
  if (!win) {
    out = '/' + segs.join('/');
  } else if (root === '') {
    out = segs.join('\\');
  } else if (root.endsWith('\\')) {
    out = root + segs.join('\\');
  } else {
    out = segs.length > 0 ? root + '\\' + segs.join('\\') : root;
  }

  if (out === '') {
    return { ok: false, reason: 'path resolved to empty' };
  }
  return { ok: true, path: out };
}

/** The comparison key for a canonical path: Windows folds case (its filesystems are
 *  case-insensitive), POSIX keeps it verbatim. Self-contained for the same embedding reason as
 *  {@link canonicalizeFolder}. */
export function folderKey(path: string, platform: NodeJS.Platform): string {
  return platform === 'win32' ? path.toLowerCase() : path;
}

/**
 * The cross-group uniqueness key for a folder: the SAME physical directory must map to one key
 * however it is spelled. {@link folderKey} alone only folds case, so two spellings of one directory
 * (a `C:/x` vs `C:\x` separator difference, a trailing separator, an embedded `.`/`..`) would slip
 * past it and let two groups silently "own" the same folder — with only one reachable.
 *
 * So the folder is run through {@link canonicalizeFolder} FIRST (string-only: `realpath` always
 * throws, since this must not touch the filesystem — the load validator keys stored folders with it
 * and load must not stat per-folder), then keyed. A folder that bind stored is already canonical, so
 * this is a no-op for it; it only additionally collapses a NON-canonical spelling that reached the
 * operator-editable file some other way (a hand-edit, a vault copied under a different separator
 * convention). A path canonicalization rejects (device/ADS/drive-relative/control chars) has no
 * canonical form, so it falls back to its raw key — still detecting identical bad spellings.
 *
 * This is the SINGLE key both the write-time binding guards (`checkNewFolders`, `exactBinding`,
 * `removeFolderFromGroup`) and the load-time validator (`validateGroupsFile`) must use: keying the
 * two sides differently lets a write persist a `groups.json` the next load rejects (a fail-closed
 * brick). It is NOT part of the embeddable trio, so it may reference the module's other functions.
 */
export function folderUniquenessKey(folder: string, platform: NodeJS.Platform): string {
  const canon = canonicalizeFolder(folder, {
    platform,
    cwd: platform === 'win32' ? 'C:\\' : '/',
    realpath: () => {
      throw new Error('no filesystem access when keying a stored folder');
    },
  });
  return folderKey(canon.ok ? canon.path : folder, platform);
}

/** Whether `child` is `parent` itself or lives beneath it. Compares on {@link folderKey} and only
 *  on a `parent + separator` boundary, so `C:\research` never "contains" `C:\research2`.
 *  Self-contained (calls only `folderKey`, which the embedding puts in the same scope). */
export function isWithin(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const sep = platform === 'win32' ? '\\' : '/';
  const c = folderKey(child, platform);
  const p = folderKey(parent, platform);
  if (c === p) return true;
  const prefix = p.endsWith(sep) ? p : p + sep;
  return c.startsWith(prefix);
}

/** Minimal shape {@link resolveBinding}/{@link exactBinding} need from a group: an id and its
 *  canonical folders. Kept structural so both the vault's `StoredGroup` and the snapshot's group
 *  rows satisfy it without conversion. */
export interface FolderBoundGroup {
  id: string;
  folders: readonly string[];
}

/** Resolve which group (if any) a folder runs under: the LONGEST bound folder that contains it
 *  wins (a nested binding overrides its ancestor); no match means the global slot (`null`). */
export function resolveBinding(
  folder: string,
  groups: readonly FolderBoundGroup[],
  platform: NodeJS.Platform,
): { groupId: string; folder: string } | null {
  let best: { groupId: string; folder: string } | null = null;
  for (const g of groups) {
    for (const f of g.folders) {
      if (isWithin(folder, f, platform)) {
        if (best === null || f.length > best.folder.length) best = { groupId: g.id, folder: f };
      }
    }
  }
  return best;
}

/** The group holding this EXACT folder (same key), if any. Used to refuse re-binding a folder to a
 *  second group while still allowing a nested subfolder to bind elsewhere (that is a different key
 *  and is handled by {@link resolveBinding}'s longest-match). */
export function exactBinding(
  folder: string,
  groups: readonly FolderBoundGroup[],
  platform: NodeJS.Platform,
): string | null {
  // Key on {@link folderUniquenessKey}, the same key the store's write guards and load validator
  // use — folderKey alone would MISS a stored folder held under a non-canonical spelling (a
  // hand-edit, or a vault copied under a different separator convention), reporting a bound folder
  // as free and letting bind point a second group at it.
  const key = folderUniquenessKey(folder, platform);
  for (const g of groups) {
    for (const f of g.folders) {
      if (folderUniquenessKey(f, platform) === key) return g.id;
    }
  }
  return null;
}

/** Reserved paths a bind target may not touch: resolved once and passed to {@link checkBindTarget}
 *  so the refusal logic stays pure. All four are expected already-canonical. */
export interface BindTargetDeps {
  platform: NodeJS.Platform;
  /** False when the path does not exist or is not a directory. */
  isDirectory: (path: string) => boolean;
  /** The user's home directory (canonical). */
  homeDir: string;
  /** The encrypted vault directory (canonical). */
  vaultDir: string;
  /** The root under which group profile dirs are materialized (canonical). */
  profilesRoot: string;
  /** The main Claude Code config dir the global slot runs in (canonical). */
  mainConfigDir: string;
}

/** Whether a canonical path is a filesystem/volume root (POSIX `/`, a Windows drive root `C:\`,
 *  or a UNC share root `\\server\share`). Binding a whole volume is refused. */
function isFilesystemRoot(path: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return path === '/';
  if (/^[A-Za-z]:\\$/.test(path)) return true;
  return /^\\\\[^\\]+\\[^\\]+$/.test(path);
}

/** Decide whether a canonical folder is an allowable bind target. Refuses a nonexistent /
 *  non-directory path, a volume root, the home dir, and anything that is an ancestor OR descendant
 *  of the vault, the profiles root, or the main config dir — binding inside cctl's own state (or a
 *  parent of it) would let a session's writes reach the machinery that manages it. It does NOT
 *  check for an existing conflicting binding; that needs the group set and lives in the engine
 *  (see {@link exactBinding}). */
export function checkBindTarget(
  folder: string,
  deps: BindTargetDeps,
): { ok: true } | { ok: false; reason: string } {
  if (!deps.isDirectory(folder)) {
    return { ok: false, reason: 'not an existing directory' };
  }
  if (isFilesystemRoot(folder, deps.platform)) {
    return { ok: false, reason: 'a filesystem root cannot be bound' };
  }
  if (folderKey(folder, deps.platform) === folderKey(deps.homeDir, deps.platform)) {
    return { ok: false, reason: 'the home directory cannot be bound' };
  }
  const reserved: Array<{ path: string; name: string }> = [
    { path: deps.vaultDir, name: 'the cctl vault directory' },
    { path: deps.profilesRoot, name: 'the cctl profiles directory' },
    { path: deps.mainConfigDir, name: 'the Claude Code config directory' },
  ];
  for (const r of reserved) {
    if (isWithin(folder, r.path, deps.platform) || isWithin(r.path, folder, deps.platform)) {
      return { ok: false, reason: `overlaps ${r.name}` };
    }
  }
  return { ok: true };
}

/**
 * The embeddable source of the canonicalizer trio, for the enforcement hook script.
 *
 * Returns a program string that, when run in an empty scope (e.g. via `new Function`), defines
 * `canonicalizeFolder`, `folderKey` and `isWithin` as locals. The hook appends its own
 * `return {...}` (or the caller does). Because each function is self-contained, the emitted text
 * carries everything it needs; the colocated test proves the embedded `canonicalizeFolder` still
 * agrees with the live one across the whole case table, which is what stops the two copies drifting.
 */
export function embeddableFolderPathSource(): string {
  // `folderKey` must precede `isWithin` (which calls it) so both resolve in the emitted scope.
  return [
    `const folderKey = ${folderKey.toString()};`,
    `const isWithin = ${isWithin.toString()};`,
    `const canonicalizeFolder = ${canonicalizeFolder.toString()};`,
  ].join('\n');
}
