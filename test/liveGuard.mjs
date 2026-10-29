// A tripwire that stops a test process from changing the real user's Claude login, cctl state, or
// the machine-wide state cctl manages, whatever path or tool the test arrived at.
//
// The test sandbox (sandbox.mjs) already points HOME, LOCALAPPDATA and friends at a throwaway
// folder and removes CLAUDE_CONFIG_DIR, so code that resolves paths from the environment is safe by
// construction. This guard covers what that cannot: a path computed before the sandbox existed, a
// home dir read from the OS account instead of the environment, or a mock that moves one path and
// leaves the rest on the real profile. Any of those once wrote a fake login over the machine's
// live one. So it refuses, when they reach a protected location:
//
//  - every node fs call that creates, changes, links or removes a file, in its sync, callback,
//    promise and stream forms (a hard link counts by both names: a link to a protected file is a
//    second name for it, and a write through that name changes it);
//  - a SQLite database opened there (node:sqlite writes from native code, not through fs);
//  - a child process that is not node, handed a protected path (by its text), since nothing
//    guards it inside;
//    and any child process at all that would change state no home folder redirects: the Task
//    Scheduler (cctl's autostart on Windows), launchd and systemd user services, the macOS
//    Keychain (the login and the vault key live there), the Windows Run keys, and an elevated
//    process (Claude Code's machine-wide managed settings need one).
//
// It arms itself in every node child (preloaded through NODE_OPTIONS, which it also puts back into
// a child given an environment of its own) and every worker thread (preloaded through the worker's
// execArgv, since a worker does not read NODE_OPTIONS).
//
// It is plain JavaScript with no dependencies so the same file runs in the vitest worker (imported
// by sandbox.mjs), in every node child the tests spawn, and in worker threads.

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

/** The protected locations, as JSON `[{ path, kind }]`: `tree` guards a folder and everything in
 *  it; `prefix` guards every file whose path starts with it (`~/.claude.json` and the temp and
 *  backup files written beside it). */
export const PROTECTED_ENV = 'CCTL_TEST_PROTECTED_PATHS';
/** A file each refused write is appended to, so a refusal inside a child process (or one the code
 *  under test caught and swallowed) still fails the test file that caused it. */
export const TRIP_LOG_ENV = 'CCTL_TEST_GUARD_LOG';
/** Set to `1` by the one test that is meant to run the real macOS Keychain tool, on a throwaway
 *  keychain in CI. */
export const REAL_KEYCHAIN_ENV = 'CCTL_TEST_REAL_KEYCHAIN';

const INSTALLED = Symbol.for('cctl.liveGuard.installed');
/** This file, as a worker's `--require` preload names it, and as a node child's `--import` one. */
const GUARD_PATH = fileURLToPath(import.meta.url);
const NODE_PRELOAD = `--import=${import.meta.url}`;

// The unpatched functions, captured before any wrapping so the guard's own checks and logging
// can never recurse into it.
const realExistsSync = fs.existsSync;
const realRealpathSync = fs.realpathSync.native;
const realReadlinkSync = fs.readlinkSync;
const realLstatSync = fs.lstatSync;
const realStatSync = fs.statSync;
const realReaddirSync = fs.readdirSync;
const realAppendFileSync = fs.appendFileSync;

/** The most dangling links {@link canonical} follows in one path: as many as Linux follows (macOS
 *  follows 32). A path that needs more fails in the OS, and the guard refuses it. */
const MAX_LINK_HOPS = 40;

/** `parts` joined onto `base` as an absolute path, the way the OS will read it. Windows steps back
 *  over a `..` by name before it follows any link, so a lexical join is exact there. A POSIX
 *  kernel follows a link before it steps back out of it (`link/..` is the parent of the link's
 *  target), so the `..` is kept as written for the existence checks and realpath below to read. */
function joinAsRead(base, ...parts) {
  if (process.platform === 'win32') return path.resolve(base, ...parts);
  let out = path.isAbsolute(base) ? base : `${process.cwd()}/${base}`;
  for (const part of parts) {
    out = path.isAbsolute(part) ? part : `${out.replace(/\/+$/, '')}/${part}`;
  }
  return out;
}

/** On Windows, `p` with a path that reaches a local drive by another route (an admin share such
 *  as `\\localhost\C$\x`, its `\\?\UNC\` form, or the `\\?\C:\x` and `\\.\C:\x` device forms)
 *  rewritten as the plain drive path, so it is compared as one. Anything else unchanged. */
function asDrivePath(p) {
  if (process.platform !== 'win32') return p;
  const device = /^\\\\[?.]\\([a-z]):/i.exec(p);
  if (device) return `${device[1]}:${p.slice(device[0].length) || '\\'}`;
  // Any host's admin share, not only the names in LOCAL_HOSTS: a LAN address or an alias of this
  // machine reaches its drive too, and tests never touch another machine's, so reading one as a
  // local drive can only refuse more.
  const share = /^\\\\(?:\?\\UNC\\)?[^\\]+\\([a-z])\$(?=\\|$)/i.exec(p);
  if (!share) return p;
  return `${share[1]}:${p.slice(share[0].length) || '\\'}`;
}

/** The name the link at `p` (whose bigint lstat is `stat`) has on disk. Windows also answers to a
 *  short name (`CLAUDE~1`), and Windows and macOS to another case; such a spelling is matched to
 *  the folder entry it names by file identity. A name that cannot be listed is kept. */
function nameOnDisk(p, stat) {
  const dir = path.dirname(p);
  const name = path.basename(p);
  let names;
  try {
    names = realReaddirSync(dir);
  } catch {
    return name;
  }
  if (names.includes(name)) return name;
  return (
    names.find((n) => {
      try {
        // As bigints: an NTFS file id does not fit a Number, and two rounded ones can collide.
        const s = realLstatSync(path.join(dir, n), { bigint: true });
        return s.ino === stat.ino && s.dev === stat.dev;
      } catch {
        return false;
      }
    }) ?? name
  );
}

/** Fold a path to the form protected entries are compared in: absolute, resolved through any
 *  junction or symlink on its existing part, spelled as on disk, and case-folded where the disk
 *  ignores case. With `follow` false a link in the last component is kept by its own name, for
 *  calls that act on a link itself (removing or renaming it) rather than on what it points at.
 *  Null when reaching it takes more than {@link MAX_LINK_HOPS} dangling links (a loop, say): the
 *  guard cannot tell where that lands. */
function canonical(target, follow = true, hops = 0) {
  let resolved = asDrivePath(joinAsRead(target));
  // A trailing separator makes a POSIX kernel follow a link in the last component too, even for
  // a call that acts on the link itself (`rm -r link/` empties its target). Windows drops it
  // (path.resolve already has). Either way the separator goes, so the walk reads the bare name.
  const bare = resolved.replace(/(?<=[^/])\/+$/, '');
  if (bare !== resolved) {
    resolved = bare;
    follow = true;
  }
  const name = path.basename(resolved);
  // A last component of `.` or `..` names a folder reached through the rest, never a link itself.
  if (!follow && name !== '.' && name !== '..') {
    let stat;
    try {
      stat = realLstatSync(resolved, { bigint: true });
    } catch {
      // Nothing there yet: the name is all there is to compare.
    }
    // Only a link makes acting on the name differ from acting on what it reaches. Anything else
    // is resolved below like any path, which also spells it as the disk does (a Windows short
    // name, another case, an NTFS `::$INDEX_ALLOCATION` suffix).
    const parent = path.dirname(resolved);
    if ((!stat || stat.isSymbolicLink()) && parent !== resolved) {
      const base = canonical(parent);
      const own = stat ? nameOnDisk(resolved, stat) : name;
      return base === null ? null : path.join(base, foldCase(own));
    }
  }
  // Resolve links on the deepest part that exists, so a link planted inside the sandbox that
  // points at the real profile still lands on the protected side.
  let head = resolved;
  const tail = [];
  while (!realExistsSync(head)) {
    // A link whose target does not exist yet does not "exist" either, yet a write through it
    // creates that target: follow it rather than step past it to the lexical path.
    let link;
    try {
      link = realReadlinkSync(head);
    } catch {
      // Not a link: a part that is simply missing.
    }
    if (link !== undefined) {
      if (hops >= MAX_LINK_HOPS) return null;
      // A relative target is read from where the link really is, so a `..` in it climbs out of
      // the real folder, not the lexical one; a `\\?\` prefix is dropped, as the OS reads it.
      const from = canonical(path.dirname(head), true, hops + 1);
      if (from === null) return null;
      const to = joinAsRead(from, link.replace(/^\\\\\?\\/, ''));
      return canonical(joinAsRead(to, ...tail), true, hops + 1);
    }
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  try {
    // A mapped drive or a link to an admin share resolves to the share's path: read it as a drive.
    resolved = path.join(asDrivePath(realRealpathSync(head)), ...tail);
  } catch {
    // An unreadable ancestor leaves the lexical path, which is still compared.
    return foldCase(path.normalize(resolved));
  }
  // The missing part is created as real folders (a recursive mkdir makes each one), so a `..` in
  // it steps back by name. Where it steps back to may hold a link, so the shortened path is
  // walked again. That follows no link, so it spends no hop: the shortened path has no `..` left
  // and comes back here only through a dangling link, which does spend one.
  if (tail.some((part) => part === '..' || part === '.')) return canonical(resolved, true, hops);
  return foldCase(resolved);
}

/** Case-fold on Windows and macOS, whose filesystems ignore case by default. (On a macOS volume
 *  that does not, the guard refuses a little more than it must, never less.) */
function foldCase(p) {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/** Each path inside folder `source` that a recursive copy of it writes, relative to it. A linked
 *  folder is not entered: the copy writes the link itself there. Throws when a folder cannot be
 *  listed. */
function copiedPaths(source) {
  const out = [];
  const walk = (rel) => {
    for (const entry of realReaddirSync(path.join(source, rel), { withFileTypes: true })) {
      const inner = path.join(rel, entry.name);
      out.push(inner);
      if (entry.isDirectory()) walk(inner);
    }
  };
  walk('');
  return out;
}

/** Each link met on the way to `target`: a folder above it, the target itself, or a part of what
 *  one of those points at. Each is given as the path to the link itself. */
function linksOnTheWay(target, hops = 0) {
  const abs = path.resolve(target);
  const root = path.parse(abs).root;
  const parts = abs.slice(root.length).split(path.sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const at = path.join(root, ...parts.slice(0, i + 1));
    let text;
    try {
      if (realLstatSync(at).isSymbolicLink()) text = realReadlinkSync(at);
    } catch {
      return []; // Nothing past a missing part.
    }
    if (text === undefined) continue;
    const rest = parts.slice(i + 1);
    const next = path.resolve(path.dirname(at), text.replace(/^\\\\\?\\/, ''), ...rest);
    return [at, ...(hops < MAX_LINK_HOPS ? linksOnTheWay(next, hops + 1) : [])];
  }
  return [];
}

/** Turn an fs path argument into a string, or undefined for a file descriptor. */
function pathArg(value) {
  if (typeof value === 'string') return value;
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return undefined;
}

/** Whether `flags` (an fs open mode) can change the file. */
function opensForWrite(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') {
    const { O_WRONLY, O_RDWR, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & (O_WRONLY | O_RDWR | O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return !['r', 'rs', 'sr'].includes(String(flags));
}

/**
 * Read the protected list from the environment, canonicalised once, as `{ kind, path }`.
 *
 * A link on the way to an entry (a `~/.claude` kept in a dotfiles folder, or a folder above it
 * that is a link) is protected by its own name too: what the entry resolves to is reached
 * through it, so removing it, or renaming over it, and making a folder in its place moves the
 * protected path somewhere a test can then write. The entry's own link, and each link it leads
 * through to its target, keeps the entry's kind; one above it is kind `link`, matched like a
 * folder but left out of the check on what a child process is handed (a home folder that is a
 * link would otherwise refuse every command naming anything in it).
 *
 * Each entry is also kept as written, for that same child-process check: a command names a path
 * that way, not by where its links lead (macOS's /var is /private/var). No fs call is compared
 * against it by mistake, since a canonical path never passes through a link. One written with a
 * `..` is not kept so, since where that leads depends on the links before it.
 */
function loadProtected() {
  let entries;
  try {
    entries = JSON.parse(process.env[PROTECTED_ENV] ?? '[]');
  } catch {
    entries = [];
  }
  const out = new Map();
  const add = (kind, p) => out.set(`${kind}\0${p}`, { kind, path: p });
  for (const e of entries) {
    if (!e || typeof e.path !== 'string' || e.path.trim() === '') continue;
    const kind = e.kind === 'prefix' ? 'prefix' : 'tree';
    const typed = foldCase(path.resolve(e.path));
    // Protected paths are the user's own folders, never a chain of links too long to follow.
    add(kind, canonical(e.path) ?? typed);
    if (!e.path.split(/[\\/]/).includes('..')) add(kind, typed);
    const links = linksOnTheWay(e.path);
    if (links.length === 0) continue;
    // The entry's own link is told apart by where it is, not by how it is spelled: a link above
    // it changes the spelling linksOnTheWay reports it by. The links after it are its target's.
    const own = canonical(e.path, false);
    const named = links.map((link) => canonical(link, false) ?? foldCase(link));
    const ownAt = named.indexOf(own);
    named.forEach((p, i) => add(ownAt !== -1 && i >= ownAt ? kind : 'link', p));
  }
  return [...out.values()];
}

/** Whether canonical path `c` is protected entry `e` or lies inside it. */
function within(c, e) {
  if (e.kind === 'prefix') return c.startsWith(e.path);
  return c === e.path || c.startsWith(e.path.endsWith(path.sep) ? e.path : e.path + path.sep);
}

/** Whether protected entry `e` lies inside the folder at canonical path `c`. */
function holds(c, e) {
  return e.path.startsWith(c.endsWith(path.sep) ? c : c + path.sep);
}

/** Why a call on `target` would reach protected state, or undefined when it would not. With
 *  `whole` the call also acts on everything inside the target (a recursive remove, a rename),
 *  so a folder that holds a protected location is refused too. */
function protectedBy(target, entries, follow, whole) {
  const c = canonical(target, follow);
  if (c === null) {
    return `it goes through more than ${MAX_LINK_HOPS} links, so where it lands cannot be checked`;
  }
  const hit = entries.find((e) => within(c, e));
  if (hit) return `it is the real user's Claude login or cctl state (${hit.path})`;
  const held = whole ? entries.find((e) => holds(c, e)) : undefined;
  if (held) return `it holds the real user's Claude login or cctl state (${held.path})`;
  return undefined;
}

/**
 * Child-process commands that change state no home folder redirects, so the sandbox cannot keep a
 * test's copy apart from the real one. Matched, case-insensitively, against the command and its
 * arguments (with any PowerShell -EncodedCommand payload decoded). Reads are let through.
 */
const MACHINE_WIDE = [
  {
    what: "the Task Scheduler (cctl's autostart on Windows)",
    pattern:
      /\b(?:register|unregister|start|stop|set|enable|disable)-scheduledtask\b|\bschtasks(?:\.exe)?\b[\s\S]*[/-](?:create|delete|run|end|change)\b/i,
  },
  {
    what: 'a launchd service',
    pattern:
      /\blaunchctl\b[\s\S]*\b(?:load|unload|bootstrap|bootout|kickstart|enable|disable|start|stop|submit|remove)\b/i,
  },
  {
    what: 'a systemd user service',
    pattern:
      /\bsystemctl\b[\s\S]*--user\b[\s\S]*\b(?:enable|disable|start|stop|restart|reload|daemon-reload|link|mask|unmask|reenable|kill)\b|\bloginctl\b[\s\S]*\b(?:enable|disable)-linger\b/i,
  },
  {
    what: 'the Windows registry',
    pattern:
      /\breg(?:\.exe)?\s+(?:add|delete|import|copy|restore|load)\b|\b(?:new|set|remove)-item(?:property)?\b[\s\S]*\bhk(?:cu|lm|ey_current_user|ey_local_machine)\b/i,
  },
  {
    what: 'an elevated process (machine-wide settings, such as Claude Code managed settings)',
    pattern: /-verb\s+['"]?runas\b/i,
  },
];

/** A macOS Keychain tool subcommand, run directly or through a shell. */
const KEYCHAIN_COMMAND =
  /(?:^|[\s'"\\/])security\s+(?:-[a-z]+\s+)*(?:-i\b|[a-z-]*-password\b|[a-z-]*keychains?\b|import\b|export\b)/i;

/** Whether `file` names the macOS Keychain tool. */
function isKeychainTool(file) {
  return /^security$/i.test(path.basename(file));
}

/** Whether `file` is a node binary (whose children run this guard themselves). */
function isNode(file) {
  return file === process.execPath || /^node(?:\.exe)?$/i.test(path.basename(file));
}

/** Text that looks like base64 and decodes to UTF-16 text: a PowerShell -EncodedCommand body. */
function decodedPayloads(text, depth = 0) {
  if (depth > 3) return [];
  const out = [];
  for (const token of text.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
    if (token.length % 4 !== 0) continue;
    const decoded = Buffer.from(token, 'base64').toString('utf16le');
    // Script text is mostly ASCII; random base64 decodes to CJK noise and is skipped.
    const ascii = decoded.replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '').length;
    if (decoded.length === 0 || ascii / decoded.length < 0.9) continue;
    out.push(decoded, ...decodedPayloads(decoded, depth + 1));
  }
  return out;
}

/** `env` (a child's own environment) with the guard's variables added where it lacks them, so a
 *  child given an environment of its own is still guarded, and still logs to the same file. */
function withGuardEnv(env) {
  const out = { ...env };
  for (const name of [PROTECTED_ENV, TRIP_LOG_ENV]) {
    if (out[name] === undefined && process.env[name] !== undefined) out[name] = process.env[name];
  }
  const options = out.NODE_OPTIONS ?? '';
  if (!options.includes(NODE_PRELOAD)) {
    out.NODE_OPTIONS = [options, NODE_PRELOAD].filter(Boolean).join(' ');
  }
  return out;
}

/**
 * Wrap every way a test process writes a file, opens a database or starts a process so each
 * refuses a protected location (see the header). Idempotent, and a no-op when no protected paths
 * are configured. Refreshes the builtin ESM exports so modules that imported names directly see
 * the wrapped functions too.
 */
export function installLiveGuard() {
  if (globalThis[INSTALLED]) return;
  const entries = loadProtected();
  if (entries.length === 0) return;
  globalThis[INSTALLED] = true;

  /** Log a refusal where the test file's after-check finds it, and throw it. */
  const refuse = (call, why) => {
    const message =
      `test sandbox refused ${call}: ${why}. Tests must use the sandbox home and fakes; never ` +
      'real state.';
    const log = process.env[TRIP_LOG_ENV];
    if (log) {
      try {
        realAppendFileSync(log, message + '\n');
      } catch {
        // The refusal below still stops the call.
      }
    }
    process.stderr.write(message + '\n');
    const err = new Error(message);
    err.code = 'ELIVEGUARD';
    throw err;
  };

  /**
   * Refuse the call when any path argument it writes through is protected. `spec` says which
   * arguments those are (`at`), where the open flags are (`flags`, open only), whether the call
   * follows a link in the last component (`follow`, default true), which of them are also
   * read through such a link whatever `follow` says (`through`), whether it acts on everything
   * inside the target too (`whole`), and which argument is a folder it copies into the target
   * when given `recursive` (`from`).
   */
  const check = (name, args, { at, flags, follow = true, through = [], whole = false, from }) => {
    if (flags !== undefined && !opensForWrite(args[flags])) return;
    for (const i of at) {
      const p = pathArg(args[i]);
      if (p === undefined) continue;
      const why =
        protectedBy(p, entries, follow, whole) ??
        (through.includes(i) ? protectedBy(p, entries, true, false) : undefined);
      if (why) refuse(`${name}(${p})`, why);
    }
    // A recursive copy writes each source entry at the same place under the target, through any
    // link already there (and node's cpSync does it in native code, past every wrapper), so each
    // of those paths is checked as a write of its own.
    const options = args[at[0] + 1];
    if (from === undefined || typeof options !== 'object' || !options?.recursive) return;
    const source = pathArg(args[from]);
    const dest = pathArg(args[at[0]]);
    if (source === undefined || dest === undefined) return;
    let top;
    try {
      top = realStatSync(source);
    } catch {
      return; // Nothing to copy: the copy fails.
    }
    if (!top.isDirectory()) return; // A file: the target alone is written, checked above.
    let inside;
    try {
      inside = copiedPaths(source);
    } catch (err) {
      // A folder that cannot be listed could hide an entry that lands anywhere, and the copy may
      // still write the ones it can read, so the whole copy is refused.
      refuse(`${name}(${source}, ${dest})`, `its source cannot be listed to check (${err.code})`);
    }
    for (const rel of inside) {
      const why = protectedBy(joinAsRead(dest, rel), entries, true, false);
      if (why) refuse(`${name}(${source}, ${dest})`, `a copied entry lands there: ${why}`);
    }
  };

  const targets = {
    writeFile: { at: [0] },
    appendFile: { at: [0] },
    open: { at: [0], flags: 1 },
    rename: { at: [0, 1], follow: false, whole: true },
    copyFile: { at: [1] },
    // What a recursive copy writes is known entry by entry, so a target that merely holds a
    // protected location is fine unless something copied lands on it.
    cp: { at: [1], from: 0 },
    rm: { at: [0], follow: false, whole: true },
    rmdir: { at: [0], follow: false, whole: true },
    unlink: { at: [0], follow: false },
    mkdir: { at: [0] },
    mkdtemp: { at: [0] },
    symlink: { at: [1], follow: false },
    // Both names: the new one is created, and the existing one gains a second name to write by.
    // macOS links what a symlink given as the existing name points at, so that is checked too.
    link: { at: [0, 1], follow: false, through: [0] },
    truncate: { at: [0] },
    chmod: { at: [0] },
    utimes: { at: [0] },
  };

  // Each form reports a refusal the way it reports any other failure, so callers handling errors
  // see it where they look: thrown (sync), rejected (promise) or passed to the callback.
  const wrap = (holder, name, mode, spec) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    holder[name] = function guarded(...args) {
      try {
        check(name, args, spec);
      } catch (err) {
        if (mode === 'promise') return Promise.reject(err);
        const callback = args.at(-1);
        if (mode === 'callback' && typeof callback === 'function') {
          process.nextTick(callback, err);
          return undefined;
        }
        throw err;
      }
      return original.apply(this, args);
    };
  };

  for (const [name, spec] of Object.entries(targets)) {
    wrap(fs, name, 'callback', spec);
    wrap(fs, `${name}Sync`, 'sync', spec);
    wrap(fs.promises, name, 'promise', spec);
  }
  // Streams take the open flags from an options object (default 'w').
  const realCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guardedCreateWriteStream(target, options) {
    const flags = typeof options === 'object' && options?.flags ? options.flags : 'w';
    check('createWriteStream', [target, flags], { at: [0], flags: 1 });
    return realCreateWriteStream.call(this, target, options);
  };

  guardSqlite(check);
  guardChildProcesses(entries, refuse, (name, dir) => check(name, [dir], { at: [0] }));
  guardWorkers();
  syncBuiltinESMExports();
}

/** node:sqlite opens and writes its files from native code, so the database path is checked when
 *  a database is constructed. An in-memory database touches no file. */
function guardSqlite(check) {
  let sqlite;
  try {
    sqlite = process.getBuiltinModule('node:sqlite');
  } catch {
    return; // A node without SQLite has nothing to guard.
  }
  const Real = sqlite?.DatabaseSync;
  if (typeof Real !== 'function') return;
  class GuardedDatabaseSync extends Real {
    constructor(location, ...rest) {
      let target = pathArg(location);
      if (target !== undefined && target.startsWith('file:')) {
        try {
          target = fileURLToPath(target.split('?')[0]);
        } catch {
          // Not a file URL: compared as it is.
        }
      }
      if (target !== undefined && target !== '' && target !== ':memory:') {
        check('DatabaseSync', [target], { at: [0] });
      }
      super(location, ...rest);
    }
  }
  sqlite.DatabaseSync = GuardedDatabaseSync;
}

/**
 * Check every child process before it starts (see the header for what is refused), and keep the
 * guard in a node child given an environment of its own. A refusal is thrown at the call, for the
 * asynchronous forms too: the child never starts.
 */
function guardChildProcesses(entries, refuse, checkDir) {
  const childProcess = process.getBuiltinModule('node:child_process');
  /** Throw when `file` with `argv` (and `options.cwd`) would reach protected or machine-wide state. */
  const checkCommand = (name, file, argv, options, hasArgv) => {
    const call = `${name}(${[file, ...argv].join(' ')})`;
    if (typeof options?.cwd === 'string' || options?.cwd instanceof URL)
      checkDir(name, options.cwd);
    const raw = [file, ...argv].map(String).join(' ');
    const text = [raw, ...decodedPayloads(raw)].join('\n');
    // A command line run by a shell is a shell, whatever program it ends by calling.
    if (!(hasArgv && !options?.shell && isNode(file))) {
      // Nothing guards a child that is not node from the inside, so a protected path it is
      // handed is refused here. This matches text only: a path the shell builds itself (from a
      // variable, a relative name against the working folder, `~`) is not seen.
      const folded = foldCase(process.platform === 'win32' ? text.replace(/\//g, '\\') : text);
      const hit = entries.find((e) => e.kind !== 'link' && folded.includes(e.path));
      if (hit) refuse(call, `it hands a program that is not node a real location (${hit.path})`);
    }
    for (const { what, pattern } of MACHINE_WIDE) {
      if (pattern.test(text))
        refuse(call, `it would change ${what}, which the sandbox cannot redirect`);
    }
    if (
      process.env[REAL_KEYCHAIN_ENV] !== '1' &&
      (isKeychainTool(file) || KEYCHAIN_COMMAND.test(text))
    ) {
      refuse(call, 'it runs the macOS Keychain tool, which holds the real login and vault key');
    }
  };
  /** The call's arguments with the checks made and a child's own environment guarded. */
  const prepare = (name, hasArgv, args) => {
    const file = pathArg(args[0]) ?? String(args[0]);
    let argv = [];
    let at = 1;
    if (hasArgv && Array.isArray(args[1])) {
      argv = args[1];
      at = 2;
    }
    const options = typeof args[at] === 'object' && args[at] !== null ? args[at] : undefined;
    checkCommand(name, file, argv, options, hasArgv);
    if (options?.env === undefined || options.env === process.env) return args;
    const out = [...args];
    out[at] = { ...options, env: withGuardEnv(options.env) };
    return out;
  };
  for (const [name, hasArgv] of [
    ['spawn', true],
    ['spawnSync', true],
    ['execFile', true],
    ['execFileSync', true],
    ['fork', true],
    ['exec', false],
    ['execSync', false],
  ]) {
    const original = childProcess[name];
    if (typeof original !== 'function') continue;
    const guarded = function guardedChild(...args) {
      return original.apply(this, prepare(name, hasArgv, args));
    };
    const promised = original[util.promisify.custom];
    if (typeof promised === 'function') {
      guarded[util.promisify.custom] = (...args) => promised(...prepare(name, hasArgv, args));
    }
    childProcess[name] = guarded;
  }
}

/** A worker thread does not read NODE_OPTIONS, so this guard is preloaded into each one through
 *  its execArgv, and a worker given an environment of its own is given the guard's variables. */
function guardWorkers() {
  const workerThreads = process.getBuiltinModule('node:worker_threads');
  const Real = workerThreads?.Worker;
  if (typeof Real !== 'function') return;
  const preload = `--require=${GUARD_PATH}`;
  class GuardedWorker extends Real {
    constructor(filename, options = {}) {
      const execArgv = options.execArgv ?? process.execArgv;
      const env =
        typeof options.env === 'object' && options.env !== null && options.env !== process.env
          ? { env: withGuardEnv(options.env) }
          : {};
      super(filename, {
        ...options,
        ...env,
        execArgv: execArgv.includes(preload) ? execArgv : [...execArgv, preload],
      });
    }
  }
  workerThreads.Worker = GuardedWorker;
}

// Preloaded into a child (or a worker): arm at once.
installLiveGuard();
