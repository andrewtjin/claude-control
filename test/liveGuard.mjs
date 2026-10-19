// A tripwire that stops a test process from writing to the real user's Claude login or cctl
// state, whatever path the test arrived at.
//
// The test sandbox (sandbox.mjs) already points HOME, LOCALAPPDATA, CLAUDE_CONFIG_DIR and friends at
// a throwaway folder, so code that resolves paths from the environment is safe by construction.
// This guard covers what that cannot: a path computed before the sandbox existed, a home dir read
// from the OS account instead of the environment, or a mock that moves one path and leaves the
// rest on the real profile. Any of those once wrote a fake login over the machine's live one.
//
// It is plain JavaScript with no dependencies so the same file runs in the vitest worker (imported
// by sandbox.mjs) and in every node child the tests spawn (preloaded through NODE_OPTIONS).

import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** The protected locations, as JSON `[{ path, kind }]`: `tree` guards a folder and everything in
 *  it; `prefix` guards every file whose path starts with it (`~/.claude.json` and the temp and
 *  backup files written beside it). */
export const PROTECTED_ENV = 'CCTL_TEST_PROTECTED_PATHS';
/** A file each refused write is appended to, so a refusal inside a child process (or one the code
 *  under test caught and swallowed) still fails the test file that caused it. */
export const TRIP_LOG_ENV = 'CCTL_TEST_GUARD_LOG';

const INSTALLED = Symbol.for('cctl.liveGuard.installed');

// The unpatched functions, captured before any wrapping so the guard's own checks and logging
// can never recurse into it.
const realExistsSync = fs.existsSync;
const realRealpathSync = fs.realpathSync.native;
const realAppendFileSync = fs.appendFileSync;

/** Fold a path to the form protected entries are compared in: absolute, resolved through any
 *  junction or symlink on its existing part, and case-folded on Windows. With `follow` false the
 *  last component is kept as named, for calls that act on a link itself (removing or renaming
 *  it) rather than on what it points at. */
function canonical(target, follow = true) {
  let resolved = path.resolve(target);
  if (!follow) {
    const parent = path.dirname(resolved);
    if (parent !== resolved) return path.join(canonical(parent), foldCase(path.basename(resolved)));
  }
  // Resolve links on the deepest part that exists, so a link planted inside the sandbox that
  // points at the real profile still lands on the protected side.
  let head = resolved;
  const tail = [];
  while (!realExistsSync(head)) {
    const parent = path.dirname(head);
    if (parent === head) break;
    tail.unshift(path.basename(head));
    head = parent;
  }
  try {
    resolved = path.join(realRealpathSync(head), ...tail);
  } catch {
    // An unreadable ancestor leaves the lexical path, which is still compared.
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
 * Wrap every fs function that can create, change or remove a file so it refuses a protected
 * path. Idempotent, and a no-op when no protected paths are configured. Covers the sync,
 * callback and promise forms, and refreshes the `node:fs` ESM exports so modules that imported
 * names directly see the wrapped functions too.
 */
export function installLiveGuard() {
  if (globalThis[INSTALLED]) return;
  const entries = loadProtected();
  if (entries.length === 0) return;
  globalThis[INSTALLED] = true;

  /** Refuse the call when any path argument it writes through is protected. */
  const check = (name, args, positions, flagsAt, follow = true) => {
    if (flagsAt !== undefined && !opensForWrite(args[flagsAt])) return;
    for (const i of positions) {
      const p = pathArg(args[i]);
      if (p === undefined) continue;
      const hit = protectedBy(p, entries, follow);
      if (!hit) continue;
      const message =
        `test sandbox refused ${name}(${p}): it is the real user's Claude login or cctl state ` +
        `(${hit.path}). Tests must use the sandbox home; never a real path.`;
      const log = process.env[TRIP_LOG_ENV];
      if (log) {
        try {
          realAppendFileSync(log, message + '\n');
        } catch {
          // The refusal below still stops the write.
        }
      }
      process.stderr.write(message + '\n');
      const err = new Error(message);
      err.code = 'ELIVEGUARD';
      throw err;
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
    link: [[1], undefined, false],
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
  syncBuiltinESMExports();
}

// Preloaded into a child through NODE_OPTIONS: arm at once.
installLiveGuard();
