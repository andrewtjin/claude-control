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
//  - a child process that is not node, handed a protected path, since nothing guards it inside;
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
const realAppendFileSync = fs.appendFileSync;

/** How many dangling links {@link canonical} follows before it stops, as the OS stops a loop. */
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

/** Fold a path to the form protected entries are compared in: absolute, resolved through any
 *  junction or symlink on its existing part, and case-folded on Windows. With `follow` false the
 *  last component is kept as named, for calls that act on a link itself (removing or renaming
 *  it) rather than on what it points at. */
function canonical(target, follow = true, hops = 0) {
  let resolved = joinAsRead(target);
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
    const parent = path.dirname(resolved);
    if (parent !== resolved) return path.join(canonical(parent), foldCase(name));
  }
  // Resolve links on the deepest part that exists, so a link planted inside the sandbox that
  // points at the real profile still lands on the protected side.
  let head = resolved;
  const tail = [];
  while (!realExistsSync(head)) {
    // A link whose target does not exist yet does not "exist" either, yet a write through it
    // creates that target: follow it rather than step past it to the lexical path.
    if (hops < MAX_LINK_HOPS) {
      let link;
      try {
        link = realReadlinkSync(head);
      } catch {
        // Not a link: a part that is simply missing.
      }
      if (link !== undefined) {
        // A relative target is read from where the link really is, so a `..` in it climbs out of
        // the real folder, not the lexical one; a `\\?\` prefix is dropped, as the OS reads it.
        const from = canonical(path.dirname(head), true, hops + 1);
        const to = joinAsRead(from, link.replace(/^\\\\\?\\/, ''));
        return canonical(joinAsRead(to, ...tail), true, hops + 1);
      }
    }
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  try {
    resolved = path.join(realRealpathSync(head), ...tail);
  } catch {
    // An unreadable ancestor leaves the lexical path, which is still compared.
    return foldCase(path.normalize(resolved));
  }
  // The missing part is created as real folders (a recursive mkdir makes each one), so a `..` in
  // it steps back by name. Where it steps back to may hold a link, so the shortened path is
  // walked again. It has no `..` left, though a dangling link on it can bring one back from its
  // target text; each such round spends hops, so a chain of them ends at the lexical path.
  if (hops < MAX_LINK_HOPS && tail.some((part) => part === '..' || part === '.')) {
    return canonical(resolved, true, hops + 1);
  }
  return foldCase(resolved);
}

/** Case-fold on Windows, whose filesystems ignore case. */
function foldCase(p) {
  return process.platform === 'win32' ? p.toLowerCase() : p;
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

/** Read the protected list from the environment, canonicalised once. */
function loadProtected() {
  let entries;
  try {
    entries = JSON.parse(process.env[PROTECTED_ENV] ?? '[]');
  } catch {
    entries = [];
  }
  return entries
    .filter((e) => e && typeof e.path === 'string' && e.path.trim() !== '')
    .map((e) => ({ kind: e.kind === 'prefix' ? 'prefix' : 'tree', path: canonical(e.path) }));
}

/** The protected entry `target` falls under, if any. */
function protectedBy(target, entries, follow) {
  const c = canonical(target, follow);
  return entries.find((e) =>
    e.kind === 'prefix' ? c.startsWith(e.path) : c === e.path || c.startsWith(e.path + path.sep),
  );
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

  /** Refuse the call when any path argument it writes through is protected. */
  const check = (name, args, positions, flagsAt, follow = true) => {
    if (flagsAt !== undefined && !opensForWrite(args[flagsAt])) return;
    for (const i of positions) {
      const p = pathArg(args[i]);
      if (p === undefined) continue;
      const hit = protectedBy(p, entries, follow);
      if (hit) {
        refuse(`${name}(${p})`, `it is the real user's Claude login or cctl state (${hit.path})`);
      }
    }
  };

  // name -> [indexes of path arguments it writes through, index of open flags (open only),
  //          whether it follows a link in the last component]
  const targets = {
    writeFile: [[0]],
    appendFile: [[0]],
    open: [[0], 1],
    rename: [[0, 1], undefined, false],
    copyFile: [[1]],
    cp: [[1]],
    rm: [[0], undefined, false],
    rmdir: [[0], undefined, false],
    unlink: [[0], undefined, false],
    mkdir: [[0]],
    mkdtemp: [[0]],
    symlink: [[1], undefined, false],
    // Both names: the new one is created, and the existing one gains a second name to write by.
    link: [[0, 1], undefined, false],
    truncate: [[0]],
    chmod: [[0]],
    utimes: [[0]],
  };

  // Each form reports a refusal the way it reports any other failure, so callers handling errors
  // see it where they look: thrown (sync), rejected (promise) or passed to the callback.
  const wrap = (holder, name, mode, positions, flagsAt, follow) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    holder[name] = function guarded(...args) {
      try {
        check(name, args, positions, flagsAt, follow);
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

  for (const [name, [positions, flagsAt, follow]] of Object.entries(targets)) {
    wrap(fs, name, 'callback', positions, flagsAt, follow);
    wrap(fs, `${name}Sync`, 'sync', positions, flagsAt, follow);
    wrap(fs.promises, name, 'promise', positions, flagsAt, follow);
  }
  // Streams take the open flags from an options object (default 'w').
  const realCreateWriteStream = fs.createWriteStream;
  fs.createWriteStream = function guardedCreateWriteStream(target, options) {
    const flags = typeof options === 'object' && options?.flags ? options.flags : 'w';
    check('createWriteStream', [target, flags], [0], 1);
    return realCreateWriteStream.call(this, target, options);
  };

  guardSqlite(check);
  guardChildProcesses(entries, refuse, (name, dir) => check(name, [dir], [0]));
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
        check('DatabaseSync', [target], [0]);
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
  const checkCommand = (name, file, argv, options) => {
    const call = `${name}(${[file, ...argv].join(' ')})`;
    if (typeof options?.cwd === 'string' || options?.cwd instanceof URL)
      checkDir(name, options.cwd);
    const raw = [file, ...argv].map(String).join(' ');
    const text = [raw, ...decodedPayloads(raw)].join('\n');
    if (!isNode(file)) {
      // Nothing guards a child that is not node from the inside, so a protected path it is
      // handed is refused here.
      const folded = process.platform === 'win32' ? text.toLowerCase().replace(/\//g, '\\') : text;
      const hit = entries.find((e) => folded.includes(e.path));
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
    checkCommand(name, file, argv, options);
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
