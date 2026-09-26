// Profile directory materialization.
//
// A group's account lives in its own config dir (its "profile dir"). That dir must look enough
// like the main `~/.claude` config dir that a Claude Code session launched inside it behaves the
// same — same projects, plugins, skills, settings, memory, history — while keeping the two account
// identities strictly apart. This module builds and re-verifies that dir. It is idempotent and is
// meant to be run on every relevant event (bind, launch, spawn, daemon start, every poll cycle):
// a second run over an already-correct profile mutates nothing.
//
// Two shaping decisions come straight from measured Claude Code behavior (see the profile-evidence
// notes that accompany this feature):
//
//  1. WHAT MAY BE SHARED. A config-dir child is shared with main only when its contents are neither
//     account/organization-scoped nor process/machine-local — otherwise mixing two accounts through
//     one directory would corrupt caches keyed to a login (statsig exposures, usage counters,
//     `.claude.json` backups that carry `oauthAccount`) or collide process state. The two lists
//     below encode that classification; each carries a why-comment.
//
//  2. HOW IT IS SHARED. Directories are shared with a filesystem link (a junction on Windows, a
//     directory symlink on POSIX) so both config dirs resolve to one set of files. Root files are
//     shared with a HARD link so the two names are one inode. The distinction matters because Claude
//     Code writes most root files with a temp-file-plus-rename, which replaces the inode and so
//     BREAKS a hard link (the other name keeps the stale inode); only `history.jsonl` is written in
//     place and survives. A broken hard link is therefore expected and is repaired on the next run,
//     newest-content-wins, with a bounded backup of the losing copy.
//
// The profile's own identity files (`.credentials.json`, `.claude.json`) are never linked — the
// slot engine owns them. `.claude.json` is instead merged: onboarding/migration bookkeeping is
// mirrored from main every sweep so the profile never re-runs onboarding, while user-scoped MCP
// servers and UI preferences are seeded from main only once (so a fresh profile skips the theme
// picker) and thereafter belong to the profile. The profile's `oauthAccount` and every account/usage
// cache are always left untouched.

import { dirname, join, normalize } from 'node:path';
import {
  closeSync,
  copyFileSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeSync,
  linkSync,
  chmodSync,
} from 'node:fs';
import { ProfileError } from './errors.js';
import { type Logger, noopLogger } from './logger.js';

// ---------------------------------------------------------------------------------------------
// Classification — which config-dir children are shared with main, and which stay profile-local.
// ---------------------------------------------------------------------------------------------

/**
 * Directories shared with main (linked to the main config dir's entry, created there if absent).
 *
 * Every entry here holds content that is account-agnostic — keyed by cwd, by session, or by
 * machine, never by the logged-in account/org — so two accounts reading it through one directory is
 * safe and desirable (one set of plugins, one memory of projects, one shell-snapshot cache):
 *   projects, file-history, shell-snapshots  — machine-local, keyed by cwd/session
 *   plugins, skills, hooks, agents, commands, output-styles, plans, ide  — content/config
 *   todos, paste-cache  — per-session / content-addressed
 *   sessions  — the roster `sessions/<pid>.json`; its contents carry cwd+sessionId but NO config
 *               dir, and pids do not collide across slots, so one shared roster is correct.
 */
export const SHARED_PROFILE_DIRS: readonly string[] = [
  'projects',
  'plugins',
  'skills',
  'agents',
  'commands',
  'output-styles',
  'hooks',
  'todos',
  'plans',
  'file-history',
  'shell-snapshots',
  'ide',
  'paste-cache',
  'sessions',
];

/**
 * Directories that MUST stay profile-local (never linked to main). Listed for documentation and so
 * a doctor/report can explain a directory it deliberately did not touch. These are either
 * account/org-scoped (mixing accounts corrupts them) or process/machine runtime state:
 *   statsig  — gate/experiment cache keyed to the logged-in user/org
 *   telemetry, metrics  — per-account usage attribution
 *   backups  — rotated `.claude.json` snapshots that embed `oauthAccount`
 *   state  — runtime + per-session state
 *   session-env  — per-session captured environment
 *   logs, debug, cache, daemon, jobs, chrome, tmp, feedback, bin  — process/machine runtime
 */
export const PROFILE_LOCAL_DIRS: readonly string[] = [
  'statsig',
  'state',
  'telemetry',
  'metrics',
  'logs',
  'debug',
  'backups',
  'cache',
  'daemon',
  'jobs',
  'chrome',
  'session-env',
  'tmp',
  'feedback',
  'bin',
];

/**
 * Root files shared with main by HARD link, in addition to every root `*.md` (discovered at run
 * time). CLAUDE.md is picked up by the `*.md` scan; its `@import`s resolve relative to the config
 * dir, so sharing it as one inode keeps both slots on one memory. keybindings.json is read-only to
 * Claude Code (no writer in the binary), so its hard link never breaks. history.jsonl is written in
 * place, so its hard link survives writes; the others are rewritten with temp+rename and are
 * repaired newest-wins on the next run.
 */
export const SHARED_PROFILE_FILES: readonly string[] = [
  'settings.json',
  'settings.local.json',
  'keybindings.json',
  'history.jsonl',
];

/**
 * `.claude.json` keys MIRRORED main -> profile on every sweep. These are onboarding, migration and
 * update/nag bookkeeping: a session never sets them per profile, and keeping them equal to main is
 * the whole point of the copy — a fresh (or re-verified) profile must not re-run onboarding, re-apply
 * a migration, or re-show a one-time prompt. Overwriting them on every run is therefore correct.
 */
export const CLAUDE_JSON_MIRROR_KEYS: readonly string[] = [
  'hasCompletedOnboarding',
  'lastOnboardingVersion',
  'installMethod',
  'autoUpdates',
  'autoUpdatesProtectedForNative',
  'migrationVersion',
  'lastReleaseNotesSeen',
  'hasIdeOnboardingBeenShown',
  'officialMarketplaceAutoInstallAttempted',
  'officialMarketplaceAutoInstalled',
  'bypassPermissionsModeAccepted',
  'hasAcknowledgedCostThreshold',
];

/**
 * `.claude.json` keys SEEDED main -> profile only when the profile has no value of its own. These are
 * user-scoped configuration and UI preferences — MCP servers and editor/theme choices — that a
 * session running inside the profile may legitimately change. Copying from main gives a fresh profile
 * a working set (and skips the theme picker), but once the profile owns a value the user's own choice
 * must persist: this materialization re-runs on every daemon poll, so mirroring these each time would
 * silently revert a folder-bound session's user-scoped MCP servers and UI prefs to main's on the next
 * cycle — a config data loss with no backup, unlike the shared files' newest-wins repair path.
 */
export const CLAUDE_JSON_SEED_KEYS: readonly string[] = [
  'mcpServers',
  'githubRepoPaths',
  'theme',
  'editorMode',
  'verbose',
  'autoCompactEnabled',
  'preferredNotifChannel',
  'diffTool',
  'showSpinnerTree',
  'diffSidebarOpen',
];

/**
 * Every allowlisted `.claude.json` key copied main -> profile: the union of the always-mirrored
 * bookkeeping keys and the seed-once user preferences. Everything NOT here is left to the profile —
 * crucially `oauthAccount` and the usage/subscription caches, which are the account identity itself.
 * The copy RULE differs by list (mirror every sweep vs. seed only when absent); this is the combined
 * roster of names that may ever be copied.
 */
export const CLAUDE_JSON_MERGE_ALLOWLIST: readonly string[] = [
  ...CLAUDE_JSON_MIRROR_KEYS,
  ...CLAUDE_JSON_SEED_KEYS,
];

/** Set forms for O(1) classification in the merge loop. */
const MIRROR_KEY_SET: ReadonlySet<string> = new Set(CLAUDE_JSON_MIRROR_KEYS);
const SEED_KEY_SET: ReadonlySet<string> = new Set(CLAUDE_JSON_SEED_KEYS);

/** Key-name patterns whose matching `.claude.json` keys are MIRRORED main -> profile every sweep:
 *  migration bookkeeping and the per-launch "unpin ... launch effort" flags, all of which would
 *  otherwise make a fresh profile re-run a migration or re-show a one-time prompt. */
const CLAUDE_JSON_MIRROR_PATTERNS: readonly RegExp[] = [
  /MigrationComplete$/,
  /MigrationTimestamp$/,
  /^unpin\w+LaunchEffort$/,
];

/** Object keys that are never copied or assigned, on any object, at any depth we assign into: the
 *  three that reach `Object.prototype`. Targets are null-prototype, so an assignment could not
 *  pollute in any case, but refusing the key outright is the explicit, auditable guarantee. */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Per-project `.claude.json` fields that are trust grants. Trust flows main -> profile only, so
 *  these are OR-merged (never removed from the profile by a main that lacks them). */
const PROJECT_TRUST_KEYS: readonly string[] = ['hasTrustDialogAccepted'];

/**
 * Root files that must NEVER be linked, whatever a list or scan produces — a defensive backstop.
 * Linking any of these would either leak one account's live credentials into another slot or link
 * a file Claude Code rewrites through a lock in a way a shared inode would corrupt.
 */
function isNeverLinkFile(name: string): boolean {
  return (
    name === '.credentials.json' ||
    name.startsWith('.claude.json') ||
    /^policy-limits.*\.json$/.test(name) ||
    /^remote-settings.*\.json$/.test(name) ||
    name === '.session_ingress_token' ||
    name.endsWith('.lock') ||
    name.endsWith('.key')
  );
}

// ---------------------------------------------------------------------------------------------
// The filesystem seam. Every syscall the module makes goes through this interface so a test can
// simulate either platform's link primitives (a POSIX symlink cannot be created on a Windows CI
// box without privilege) and inject faults like EXDEV, while the default node-backed implementation
// exercises real junctions and real hard links on a real Windows box.
// ---------------------------------------------------------------------------------------------

export type ProfilePlatform = 'win32' | 'posix';

/** What `lstat` finds at a path, reduced to what this module branches on. A junction and a symlink
 *  both report as `'symlink'` — both are links whose target this module then reads and verifies. */
export type EntryKind = 'file' | 'dir' | 'symlink';

/** The identity fields this module compares to decide hard-link sameness and repair direction. On
 *  Windows the 64-bit file id only survives in the bigint `ino`, and `dev` is the volume serial, so
 *  both are bigints; `mtimeMs` is a bigint under bigint-stat and is compared as one. */
export interface FileIdentity {
  dev: bigint;
  ino: bigint;
  mtimeMs: bigint;
}

/** The injectable filesystem. Kept deliberately small: only the operations the sweep performs. */
export interface ProfileFs {
  readonly platform: ProfilePlatform;
  /** `lstat` without following links; `null` when the path does not exist. */
  lstatKind(path: string): EntryKind | null;
  /** `stat` following links, bigint fields; throws if the path is missing. */
  statIdentity(path: string): FileIdentity;
  /** The (absolute) target a link points at. */
  readlinkTarget(path: string): string;
  readFileBuffer(path: string): Buffer;
  /** File contents as text, or `null` if the file does not exist. Other read faults throw. */
  readTextIfExists(path: string): string | null;
  /** Directory entry names, or `[]` if the directory does not exist. */
  readdirNames(path: string): string[];
  mkdirp(path: string, mode?: number): void;
  chmodPath(path: string, mode: number): void;
  /** Create a directory link (junction on Windows, directory symlink on POSIX). */
  createDirLink(target: string, link: string): void;
  /** Create a hard link. May throw with code `EXDEV` when target and link are on different volumes. */
  createHardLink(target: string, link: string): void;
  /** Create a file symlink (the POSIX cross-volume fallback). */
  createFileSymlink(target: string, link: string): void;
  /** Copy file contents to a fresh, independent file. */
  copyFileContents(src: string, dst: string): void;
  /** Write via temp-file-plus-rename in the target's own directory (a fresh inode). */
  writeFileAtomic(path: string, data: Buffer, mode: number): void;
  /** Truncate-and-write the SAME inode, so hard links to it keep pointing at the new content. */
  writeFileInPlace(path: string, data: Buffer): void;
  /** Remove a single file or link (never recursive; never used on a real directory). */
  removePath(path: string): void;
}

// Non-cryptographic temp-name disambiguator for concurrent atomic writes.
let tempCounter = 0;
function tempSuffix(): string {
  tempCounter = (tempCounter + 1) % Number.MAX_SAFE_INTEGER;
  return `${process.pid}-${Date.now()}-${tempCounter.toString(36)}`;
}

/** The production seam, backed by `node:fs`. `platform` defaults to the host but is a parameter so
 *  the default implementation can also drive the Windows junction path deterministically in a test. */
export function createNodeProfileFs(
  platform: ProfilePlatform = process.platform === 'win32' ? 'win32' : 'posix',
): ProfileFs {
  return {
    platform,
    lstatKind(path) {
      const st = lstatSync(path, { throwIfNoEntry: false });
      if (!st) return null;
      // Order matters: a junction/symlink reports isSymbolicLink() true and must be caught first.
      if (st.isSymbolicLink()) return 'symlink';
      if (st.isDirectory()) return 'dir';
      return 'file';
    },
    statIdentity(path) {
      const st = statSync(path, { bigint: true });
      return { dev: st.dev, ino: st.ino, mtimeMs: st.mtimeMs };
    },
    readlinkTarget(path) {
      return readlinkSync(path);
    },
    readFileBuffer(path) {
      return readFileSync(path);
    },
    readTextIfExists(path) {
      try {
        return readFileSync(path, 'utf8');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },
    readdirNames(path) {
      try {
        return readdirSync(path);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    },
    mkdirp(path, mode) {
      mkdirSync(path, mode === undefined ? { recursive: true } : { recursive: true, mode });
    },
    chmodPath(path, mode) {
      chmodSync(path, mode);
    },
    createDirLink(target, link) {
      // 'junction' is the only directory-link type creatable on Windows without elevation; POSIX
      // takes a 'dir' symlink. Both store the absolute target, which is what verification reads back.
      symlinkSync(target, link, platform === 'win32' ? 'junction' : 'dir');
    },
    createHardLink(target, link) {
      linkSync(target, link);
    },
    createFileSymlink(target, link) {
      symlinkSync(target, link, 'file');
    },
    copyFileContents(src, dst) {
      copyFileSync(src, dst);
    },
    writeFileAtomic(path, data, mode) {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = join(dirname(path), `.cctl-tmp-${tempSuffix()}`);
      const fd = openSync(tmp, 'w', mode);
      try {
        writeSync(fd, data);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        renameSync(tmp, path);
      } catch (err) {
        // The rename is the only step that can fail with the temp still on disk; take it with us so
        // a failed write never leaks a partial copy next to the target.
        try {
          rmSync(tmp, { force: true });
        } catch {
          // The write error is the one the caller needs; a cleanup failure must not mask it.
        }
        throw err;
      }
    },
    writeFileInPlace(path, data) {
      // Same inode on purpose: this is how a hard link shared with main (and with sibling profiles)
      // receives new content without being severed. Not atomic against a concurrent reader, which is
      // acceptable — it runs under the engine lock and only on the rare repair path.
      const fd = openSync(path, 'r+');
      try {
        ftruncateSync(fd, 0);
        writeSync(fd, data, 0);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
    removePath(path) {
      rmSync(path, { force: false });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The plan (read-only) — what a run WOULD do. `ensureGroupProfile` computes it, then executes it;
// a doctor command computes it and stops. Sharing one description keeps the two in lockstep.
// ---------------------------------------------------------------------------------------------

/** What the sweep intends for one shared directory. */
export type DirAction =
  | 'link' // create the directory link (target created in main if absent)
  | 'ok' // already correctly linked to main
  | 'skip'; // a pre-existing entry we did not create — left untouched

/** What the sweep intends for one shared root file. */
export type FileAction =
  | 'hardlink' // create a hard link to main
  | 'symlink' // POSIX cross-volume fallback: a file symlink to main
  | 'copy' // Windows cross-volume fallback: copy main's content into the profile
  | 'ok' // already correctly linked (or an up-to-date cross-volume copy)
  | 'repair' // a broken hard link — rebuild newest-content-wins
  | 'skip'; // a pre-existing entry we did not create — left untouched

/** Which side wins when a broken hard link is repaired. */
export type RepairWinner = 'main' | 'profile';

export interface DirPlan {
  name: string;
  target: string; // <main>/<name>
  link: string; // <profile>/<name>
  action: DirAction;
  reason?: string;
}

export interface FilePlan {
  name: string;
  target: string; // <main>/<name>
  link: string; // <profile>/<name>
  action: FileAction;
  winner?: RepairWinner; // set only for 'repair'
  reason?: string;
}

export type ClaudeJsonAction =
  | 'write' // the merged content differs from what is on disk — write it
  | 'nochange' // the merge is already reflected on disk
  | 'skip'; // the profile's own file is unreadable/corrupt — never clobber the identity

export interface ClaudeJsonPlan {
  action: ClaudeJsonAction;
  reason?: string;
}

export interface ProfilePlan {
  profileDir: string;
  mainConfigDir: string;
  dirs: DirPlan[];
  files: FilePlan[];
  claudeJson: ClaudeJsonPlan;
}

// ---------------------------------------------------------------------------------------------
// The report (what a run actually did). Buckets are disjoint: a file appears in exactly one of
// linkedFiles / repaired / copiedFallback / skipped.
// ---------------------------------------------------------------------------------------------

/** A pre-existing entry the sweep refused to touch, with why — so nothing is silently overwritten. */
export interface ProfileSkip {
  path: string;
  reason: string;
}

export interface ProfileReport {
  /** Shared directories now correctly linked to main (created this run or verified). */
  linkedDirs: string[];
  /** Shared files now correctly hard-linked (or POSIX-symlinked) to main. */
  linkedFiles: string[];
  /** Files whose broken hard link was rebuilt this run. */
  repaired: string[];
  /** Files copied main -> profile this run because a hard link cannot cross the volume boundary. */
  copiedFallback: string[];
  /** Pre-existing / foreign entries left untouched, and any per-entry fault that did not abort. */
  skipped: ProfileSkip[];
  /** Whether the `.claude.json` allowlist merge changed the profile's file this run. */
  claudeJsonMerged: boolean;
}

export interface EnsureProfileOptions {
  /** The filesystem seam; defaults to a node-backed one for the host platform. */
  fs?: ProfileFs;
  logger?: Logger;
  /** How many backups of a repaired file to keep in `<profile>/.cctl-backup/`. Default 5. */
  maxBackupsPerFile?: number;
  /** Clock for backup filenames; injectable for deterministic tests. Default `Date.now`. */
  now?: () => number;
  /** Absolute path of MAIN's `.claude.json` — the CLI identity file whose onboarding/UI keys are
   *  merged into the profile so it skips onboarding, the theme picker and migrations. The CLI keeps
   *  this file OUTSIDE the config dir in the default layout (`~/.claude.json`, a sibling of
   *  `~/.claude`); it only lives inside the config dir when `CLAUDE_CONFIG_DIR` is set. Deriving it
   *  from `mainConfigDir` therefore misses the real file in the default layout, so callers pass the
   *  resolved path explicitly. Defaults to `<mainConfigDir>/.claude.json` for the colocated case. */
  mainClaudeJsonPath?: string;
}

const DEFAULT_MAX_BACKUPS = 5;
const PROFILE_ROOT_MODE = 0o700; // POSIX: owner-only. Ignored on Windows (ACL inherited).
const SHARED_FILE_MODE = 0o600;
const BACKUP_DIR_NAME = '.cctl-backup';

// ---------------------------------------------------------------------------------------------
// Path comparison. Link verification compares a link's stored target against the expected main
// path; on Windows that comparison is case-insensitive and separator-normalized.
// ---------------------------------------------------------------------------------------------

function pathKey(p: string, platform: ProfilePlatform): string {
  const n = normalize(p);
  return platform === 'win32' ? n.toLowerCase() : n;
}

function samePath(a: string, b: string, platform: ProfilePlatform): boolean {
  return pathKey(a, platform) === pathKey(b, platform);
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

// ---------------------------------------------------------------------------------------------
// Planning.
// ---------------------------------------------------------------------------------------------

/**
 * Describe what a materialization run would do, without changing anything. This is the doctor view;
 * `ensureGroupProfile` uses the same function so the two never diverge. When the profile root does
 * not yet exist, cross-volume detection (which needs the profile root's volume) is skipped and same
 * volume is assumed — a plan-only caller is reporting on a dir that a real run would create first.
 */
export function planGroupProfile(
  profileDir: string,
  mainConfigDir: string,
  fs: ProfileFs = createNodeProfileFs(),
  mainClaudeJsonPath: string = join(mainConfigDir, '.claude.json'),
): ProfilePlan {
  const profileDev = volumeOf(profileDir, fs);
  const dirs = SHARED_PROFILE_DIRS.map((name) => planDir(name, profileDir, mainConfigDir, fs));
  const files = sharedFileNames(mainConfigDir, fs).map((name) =>
    planFile(name, profileDir, mainConfigDir, fs, profileDev),
  );
  const claudeJson = planClaudeJson(profileDir, mainClaudeJsonPath, fs);
  return { profileDir, mainConfigDir, dirs, files, claudeJson };
}

/** The volume id of an existing path, or `null` when it does not exist (cross-volume unknown). */
function volumeOf(path: string, fs: ProfileFs): bigint | null {
  if (fs.lstatKind(path) === null) return null;
  try {
    return fs.statIdentity(path).dev;
  } catch {
    return null;
  }
}

/** Fixed shared files plus every root `*.md` in main, deduped, with the never-link backstop applied. */
function sharedFileNames(mainConfigDir: string, fs: ProfileFs): string[] {
  const names = new Set<string>(SHARED_PROFILE_FILES);
  for (const entry of fs.readdirNames(mainConfigDir)) {
    if (entry.endsWith('.md')) names.add(entry);
  }
  // Stable order: the fixed set in declaration order, then discovered `*.md` sorted, minus any name
  // the backstop forbids (none of the allowlisted names match it, but a scan is not a fixed list).
  const fixed = SHARED_PROFILE_FILES.filter((n) => names.has(n) && !isNeverLinkFile(n));
  const md = [...names]
    .filter((n) => !SHARED_PROFILE_FILES.includes(n) && !isNeverLinkFile(n))
    .sort();
  return [...fixed, ...md];
}

function planDir(name: string, profileDir: string, mainConfigDir: string, fs: ProfileFs): DirPlan {
  const target = join(mainConfigDir, name);
  const link = join(profileDir, name);
  const kind = fs.lstatKind(link);
  if (kind === null) return { name, target, link, action: 'link' };
  if (kind === 'symlink') {
    // A link already sits here. Accept it only if it points exactly at main's entry; a link aimed
    // anywhere else (a pre-planted junction escaping the main config dir, above all) is refused and
    // reported, never followed or removed.
    let actual: string;
    try {
      actual = fs.readlinkTarget(link);
    } catch {
      return { name, target, link, action: 'skip', reason: 'unreadable directory link' };
    }
    if (samePath(actual, target, fs.platform)) return { name, target, link, action: 'ok' };
    return {
      name,
      target,
      link,
      action: 'skip',
      reason: `directory link points outside main config dir: ${actual}`,
    };
  }
  // A real directory (or file) we did not create. Never delete it; leave it and report.
  return {
    name,
    target,
    link,
    action: 'skip',
    reason: `pre-existing ${kind} left as-is`,
  };
}

function planFile(
  name: string,
  profileDir: string,
  mainConfigDir: string,
  fs: ProfileFs,
  profileDev: bigint | null,
): FilePlan {
  const target = join(mainConfigDir, name);
  const link = join(profileDir, name);
  // Nothing in main to share: no action. (A file that exists only in the profile is left alone.)
  if (fs.lstatKind(target) === null) {
    return { name, target, link, action: 'ok', reason: 'absent in main' };
  }
  const crossVolume = isCrossVolume(target, profileDev, fs);
  const kind = fs.lstatKind(link);
  if (kind === null) {
    if (crossVolume)
      return { name, target, link, action: fs.platform === 'win32' ? 'copy' : 'symlink' };
    return { name, target, link, action: 'hardlink' };
  }
  if (kind === 'symlink') {
    // Either our own POSIX cross-volume fallback (target == main -> fine) or a foreign symlink.
    let actual: string;
    try {
      actual = fs.readlinkTarget(link);
    } catch {
      return { name, target, link, action: 'skip', reason: 'unreadable file link' };
    }
    if (samePath(actual, target, fs.platform)) return { name, target, link, action: 'ok' };
    return {
      name,
      target,
      link,
      action: 'skip',
      reason: `file symlink points elsewhere: ${actual}`,
    };
  }
  if (kind === 'dir') {
    return {
      name,
      target,
      link,
      action: 'skip',
      reason: 'pre-existing directory where a file is expected',
    };
  }
  // A regular file: a live hard link, a broken one, or a diverged cross-volume copy.
  let mainId: FileIdentity;
  let profId: FileIdentity;
  try {
    mainId = fs.statIdentity(target);
    profId = fs.statIdentity(link);
  } catch {
    return { name, target, link, action: 'skip', reason: 'file identity unreadable' };
  }
  if (sameFile(mainId, profId)) return { name, target, link, action: 'ok' };
  if (mainId.dev !== profId.dev) {
    // Different volumes: a hard link is impossible. POSIX re-points a symlink; Windows re-copies
    // main's current content only when it has drifted (so a steady state is a no-op).
    if (fs.platform !== 'win32') return { name, target, link, action: 'symlink' };
    return { name, target, link, action: 'copy' };
  }
  // Same volume, different inode: the hard link was broken by a temp+rename write. Rebuild it,
  // newest mtime wins; ties go to main (the shared source of truth).
  const winner: RepairWinner = profId.mtimeMs > mainId.mtimeMs ? 'profile' : 'main';
  return { name, target, link, action: 'repair', winner };
}

/** Cross-volume when main's file sits on a different volume than the profile root would. */
function isCrossVolume(target: string, profileDev: bigint | null, fs: ProfileFs): boolean {
  if (profileDev === null) return false;
  try {
    return fs.statIdentity(target).dev !== profileDev;
  } catch {
    return false;
  }
}

function planClaudeJson(
  profileDir: string,
  mainClaudeJsonPath: string,
  fs: ProfileFs,
): ClaudeJsonPlan {
  const profilePath = join(profileDir, '.claude.json');
  const mainPath = mainClaudeJsonPath;
  const merge = computeClaudeJsonMerge(
    fs.readTextIfExists(profilePath),
    fs.readTextIfExists(mainPath),
  );
  if (merge.profileCorrupt) {
    return {
      action: 'skip',
      reason: 'profile .claude.json is unparseable; identity left untouched',
    };
  }
  const current = fs.readTextIfExists(profilePath);
  if (current !== null && current === merge.serialized) return { action: 'nochange' };
  if (merge.mainUnreadable) {
    return { action: 'write', reason: 'main .claude.json unreadable; wrote profile-only merge' };
  }
  return { action: 'write' };
}

// ---------------------------------------------------------------------------------------------
// .claude.json merge (pure).
// ---------------------------------------------------------------------------------------------

interface ClaudeJsonMerge {
  /** The merged object, serialized exactly as it would be written (`null` if the merge was skipped). */
  serialized: string | null;
  /** The profile's own file could not be parsed — merge must be skipped (never clobber identity). */
  profileCorrupt: boolean;
  /** Main's file was missing or unparseable — the merge carried over nothing from main. */
  mainUnreadable: boolean;
}

/**
 * Merge the allowlist of onboarding/UI keys from main's `.claude.json` onto the profile's, purely.
 *
 * The profile's file is authoritative for everything it holds — above all `oauthAccount` and the
 * usage caches, which ARE the account identity — so the merge starts from the profile and overlays
 * only allowlisted keys from main. Targets are null-prototype and forbidden keys are dropped, so a
 * hostile `__proto__` in either file cannot reach `Object.prototype`. A corrupt profile file aborts
 * the merge (the identity must never be discarded); a corrupt/missing main file simply contributes
 * nothing and the profile is preserved.
 */
export function computeClaudeJsonMerge(
  profileText: string | null,
  mainText: string | null,
): ClaudeJsonMerge {
  const profileParsed = parseObject(profileText);
  if (profileParsed === 'corrupt') {
    return { serialized: null, profileCorrupt: true, mainUnreadable: false };
  }
  const mainParsed = parseObject(mainText);
  const mainUnreadable = mainParsed === 'corrupt' || mainParsed === null;
  const profileObj = profileParsed ?? emptyObject();
  const mainObj = mainUnreadable ? emptyObject() : mainParsed;

  const out = emptyObject();
  // 1. Everything the profile already had (its identity and its own settings), minus forbidden keys.
  for (const key of Object.keys(profileObj)) {
    if (!FORBIDDEN_KEYS.has(key)) out[key] = profileObj[key];
  }
  // 2. Overlay allowlisted keys from main. A MIRROR key (onboarding/migration/nag bookkeeping) is
  //    copied on every sweep so the profile never re-runs onboarding or a migration. A SEED key
  //    (user-scoped MCP servers and UI preferences) is copied only when the profile has no value of
  //    its own, so a preference the user set inside a folder-bound session survives the next poll
  //    instead of being reverted to main's on every cycle.
  for (const key of Object.keys(mainObj)) {
    if (FORBIDDEN_KEYS.has(key)) continue;
    if (key === 'projects') continue; // merged field-by-field below, not wholesale
    if (MIRROR_KEY_SET.has(key) || matchesMirrorPattern(key)) {
      out[key] = mainObj[key];
    } else if (SEED_KEY_SET.has(key) && !Object.hasOwn(profileObj, key)) {
      out[key] = mainObj[key];
    }
  }
  // 3. Per-project overlay: main overlays the profile, trust OR-merged (main -> profile only).
  out.projects = mergeProjects(profileObj.projects, mainObj.projects);

  return { serialized: JSON.stringify(out, null, 2), profileCorrupt: false, mainUnreadable };
}

/** Whether a key name matches one of the mirror patterns (migration/launch-effort bookkeeping). */
function matchesMirrorPattern(key: string): boolean {
  return CLAUDE_JSON_MIRROR_PATTERNS.some((re) => re.test(key));
}

/** Merge `projects` maps: union of project keys, main's entry overlaying the profile's, with each
 *  trust flag OR-ed so a trust granted in either place survives (never flowing profile -> main,
 *  which cannot happen here since main's file is never written by this module). */
function mergeProjects(profileProjects: unknown, mainProjects: unknown): Record<string, unknown> {
  const out = emptyObject();
  const prof = asObject(profileProjects);
  const main = asObject(mainProjects);
  if (prof) {
    for (const key of Object.keys(prof)) {
      if (!FORBIDDEN_KEYS.has(key)) out[key] = cloneProjectEntry(prof[key], undefined);
    }
  }
  if (main) {
    for (const key of Object.keys(main)) {
      if (FORBIDDEN_KEYS.has(key)) continue;
      out[key] = cloneProjectEntry(main[key], out[key]);
    }
  }
  return out;
}

/** Overlay a main project entry onto a profile one (or clone a lone entry), OR-merging trust. */
function cloneProjectEntry(mainEntry: unknown, profileEntry: unknown): unknown {
  const main = asObject(mainEntry);
  const prof = asObject(profileEntry);
  if (!main && !prof) return mainEntry ?? profileEntry;
  const merged = emptyObject();
  if (prof) for (const k of Object.keys(prof)) if (!FORBIDDEN_KEYS.has(k)) merged[k] = prof[k];
  if (main) for (const k of Object.keys(main)) if (!FORBIDDEN_KEYS.has(k)) merged[k] = main[k];
  for (const trustKey of PROJECT_TRUST_KEYS) {
    const fromMain = main ? main[trustKey] === true : false;
    const fromProfile = prof ? prof[trustKey] === true : false;
    if (fromMain || fromProfile) merged[trustKey] = true;
  }
  return merged;
}

/** Parse JSON expected to be an object: `null` when the text is absent, `'corrupt'` when it is not
 *  parseable or is not a plain object, otherwise the parsed object. */
function parseObject(text: string | null): Record<string, unknown> | null | 'corrupt' {
  if (text === null) return null;
  const trimmed = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return 'corrupt';
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'corrupt';
  return parsed as Record<string, unknown>;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function emptyObject(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Execution.
// ---------------------------------------------------------------------------------------------

/**
 * Materialize (or re-verify) a group's profile directory against the main config dir. Idempotent:
 * a run over an already-correct profile mutates nothing and returns empty repair/copy/skip lists.
 *
 * `profileDir` is the group's config dir; `mainConfigDir` is the account-shared config dir (usually
 * `~/.claude`). The returned report says exactly what was linked, repaired, copied, or left alone.
 * A genuine IO fault (the profile root cannot be created) throws {@link ProfileError}; a foreign
 * pre-existing entry never throws — it is reported in `skipped`.
 */
export function ensureGroupProfile(
  profileDir: string,
  mainConfigDir: string,
  opts: EnsureProfileOptions = {},
): ProfileReport {
  const fs = opts.fs ?? createNodeProfileFs();
  const log = opts.logger ?? noopLogger;
  const maxBackups = opts.maxBackupsPerFile ?? DEFAULT_MAX_BACKUPS;
  const now = opts.now ?? Date.now;
  const mainClaudeJsonPath = opts.mainClaudeJsonPath ?? join(mainConfigDir, '.claude.json');

  createProfileRoot(profileDir, fs);

  const report: ProfileReport = {
    linkedDirs: [],
    linkedFiles: [],
    repaired: [],
    copiedFallback: [],
    skipped: [],
    claudeJsonMerged: false,
  };

  const plan = planGroupProfile(profileDir, mainConfigDir, fs, mainClaudeJsonPath);

  for (const dir of plan.dirs) {
    try {
      applyDir(dir, fs, report);
    } catch (err) {
      // One unhealthy entry must not abort the sweep — it runs on every daemon poll cycle. Surface
      // the fault where a reader can see it, and keep going.
      log.warn({ err, path: dir.link }, 'profile: directory ensure failed');
      report.skipped.push({ path: dir.link, reason: `error: ${errText(err)}` });
    }
  }

  for (const file of plan.files) {
    try {
      applyFile(file, profileDir, fs, report, maxBackups, now);
    } catch (err) {
      log.warn({ err, path: file.link }, 'profile: file ensure failed');
      report.skipped.push({ path: file.link, reason: `error: ${errText(err)}` });
    }
  }

  try {
    applyClaudeJson(plan.claudeJson, profileDir, mainClaudeJsonPath, fs, report);
  } catch (err) {
    log.warn({ err }, 'profile: .claude.json merge failed');
    report.skipped.push({
      path: join(profileDir, '.claude.json'),
      reason: `error: ${errText(err)}`,
    });
  }

  return report;
}

/** Create the profile root user-private. On POSIX that is mode 0700 (and a chmod in case the dir
 *  already existed with looser bits); on Windows the mode is ignored and the ACL is inherited from
 *  LOCALAPPDATA, matching the vault. A failure here is fatal — nothing else can proceed. */
function createProfileRoot(profileDir: string, fs: ProfileFs): void {
  try {
    fs.mkdirp(profileDir, PROFILE_ROOT_MODE);
    if (fs.platform !== 'win32') fs.chmodPath(profileDir, PROFILE_ROOT_MODE);
  } catch (err) {
    throw new ProfileError(`could not create profile directory ${profileDir}: ${errText(err)}`, {
      cause: err,
    });
  }
}

function applyDir(dir: DirPlan, fs: ProfileFs, report: ProfileReport): void {
  switch (dir.action) {
    case 'ok':
      report.linkedDirs.push(dir.name);
      return;
    case 'skip':
      report.skipped.push({ path: dir.link, reason: dir.reason ?? 'left as-is' });
      return;
    case 'link':
      // Create main's entry if absent, then the link. Idempotency for the directory case rides on
      // the link: a second run sees a link pointing at main and reports 'ok'.
      if (fs.lstatKind(dir.target) === null) fs.mkdirp(dir.target);
      fs.createDirLink(dir.target, dir.link);
      report.linkedDirs.push(dir.name);
      return;
  }
}

function applyFile(
  file: FilePlan,
  profileDir: string,
  fs: ProfileFs,
  report: ProfileReport,
  maxBackups: number,
  now: () => number,
): void {
  switch (file.action) {
    case 'ok':
      // 'absent in main' carries a reason and is not a real link — do not list it as one.
      if (file.reason === undefined) report.linkedFiles.push(file.name);
      return;
    case 'skip':
      report.skipped.push({ path: file.link, reason: file.reason ?? 'left as-is' });
      return;
    case 'hardlink':
      try {
        fs.createHardLink(file.target, file.link);
        report.linkedFiles.push(file.name);
      } catch (err) {
        // The plan predicted same-volume from the profile root's device, but the target's own
        // device is the real authority; honor a late EXDEV with the platform's fallback.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
        applyCrossVolume(file, profileDir, fs, report, maxBackups, now);
      }
      return;
    case 'symlink':
      // POSIX cross-volume fallback. Replace a diverged entry first (never a real directory — the
      // planner routed those to 'skip').
      if (fs.lstatKind(file.link) !== null) fs.removePath(file.link);
      fs.createFileSymlink(file.target, file.link);
      report.linkedFiles.push(file.name);
      return;
    case 'copy':
      applyCrossVolume(file, profileDir, fs, report, maxBackups, now);
      return;
    case 'repair':
      repairHardLink(file, profileDir, fs, report, maxBackups, now);
      return;
  }
}

/** Windows cross-volume fallback: main's content copied into the profile, only when it has drifted,
 *  so the steady state is a no-op and the report stays quiet on an unchanged profile. A profile copy
 *  that has diverged from main is about to be overwritten with main's bytes; it is backed up first,
 *  giving the same bounded-backup guarantee the same-volume repair path provides — otherwise a
 *  profile-side edit to a shared file would be lost on the next sweep with no recovery. */
function applyCrossVolume(
  file: FilePlan,
  profileDir: string,
  fs: ProfileFs,
  report: ProfileReport,
  maxBackups: number,
  now: () => number,
): void {
  if (fs.platform !== 'win32') {
    // A POSIX EXDEV surfacing here (e.g. a late hardlink EXDEV) still wants the symlink fallback.
    if (fs.lstatKind(file.link) !== null) fs.removePath(file.link);
    fs.createFileSymlink(file.target, file.link);
    report.linkedFiles.push(file.name);
    return;
  }
  const mainData = fs.readFileBuffer(file.target);
  const current = fs.lstatKind(file.link) === 'file' ? fs.readFileBuffer(file.link) : null;
  if (current !== null && current.equals(mainData)) {
    report.linkedFiles.push(file.name); // up-to-date copy — counts as linked, no write
    return;
  }
  // A differing profile copy is the loser here (main is the shared source of truth on this path);
  // preserve it before the overwrite so the edit is recoverable, mirroring repairHardLink.
  if (current !== null) backupFile(file.name, file.link, profileDir, fs, maxBackups, now);
  fs.writeFileAtomic(file.link, mainData, SHARED_FILE_MODE);
  report.copiedFallback.push(file.name);
}

/**
 * Rebuild a broken hard link, newest-content-wins. The losing copy is preserved as a bounded backup
 * before anything is overwritten. When the profile's copy is newer it is written INTO main's inode
 * in place (severing nothing that other slots hard-link to main), then the profile is re-linked;
 * when main is newer the profile's stale copy is simply replaced by a fresh hard link.
 */
function repairHardLink(
  file: FilePlan,
  profileDir: string,
  fs: ProfileFs,
  report: ProfileReport,
  maxBackups: number,
  now: () => number,
): void {
  if (file.winner === 'profile') {
    const profileData = fs.readFileBuffer(file.link);
    // Back up main's losing content, then push the profile's newer bytes into main's own inode.
    backupFile(file.name, file.target, profileDir, fs, maxBackups, now);
    fs.writeFileInPlace(file.target, profileData);
  } else {
    // Main wins: back up the profile's losing content before it is replaced.
    backupFile(file.name, file.link, profileDir, fs, maxBackups, now);
  }
  fs.removePath(file.link);
  fs.createHardLink(file.target, file.link);
  report.repaired.push(file.name);
}

/** Copy `source`'s content to `<profile>/.cctl-backup/<name>.<ms>` and prune to the newest
 *  `maxBackups` for that file. The backup dir is created lazily so a profile that never repairs
 *  anything never grows one. */
function backupFile(
  name: string,
  source: string,
  profileDir: string,
  fs: ProfileFs,
  maxBackups: number,
  now: () => number,
): void {
  const backupDir = join(profileDir, BACKUP_DIR_NAME);
  fs.mkdirp(backupDir, PROFILE_ROOT_MODE);
  // A counter breaks a same-millisecond collision so a rapid double-repair keeps both copies.
  let stamp = `${now()}`;
  let dest = join(backupDir, `${name}.${stamp}`);
  let bump = 0;
  while (fs.lstatKind(dest) !== null) {
    bump += 1;
    stamp = `${now()}-${bump}`;
    dest = join(backupDir, `${name}.${stamp}`);
  }
  fs.copyFileContents(source, dest);
  pruneBackups(name, backupDir, fs, maxBackups);
}

/** Keep only the newest `maxBackups` backups of `name`, dropping the rest by their millisecond
 *  stamp (lexicographic on equal-width integers preserves numeric order; a `-N` collision suffix
 *  sorts after its base, i.e. as newer, which is correct). */
function pruneBackups(name: string, backupDir: string, fs: ProfileFs, maxBackups: number): void {
  const prefix = `${name}.`;
  const backups = fs
    .readdirNames(backupDir)
    .filter((entry) => entry.startsWith(prefix))
    .sort();
  // Newest last after the sort; remove from the front until only maxBackups remain.
  for (let i = 0; i < backups.length - maxBackups; i += 1) {
    const entry = backups[i];
    if (entry === undefined) continue;
    try {
      fs.removePath(join(backupDir, entry));
    } catch {
      // A backup that cannot be pruned is not worth failing a repair over.
    }
  }
}

function applyClaudeJson(
  plan: ClaudeJsonPlan,
  profileDir: string,
  mainClaudeJsonPath: string,
  fs: ProfileFs,
  report: ProfileReport,
): void {
  if (plan.action === 'skip') {
    report.skipped.push({
      path: join(profileDir, '.claude.json'),
      reason: plan.reason ?? 'left as-is',
    });
    return;
  }
  if (plan.action === 'nochange') return;
  const profilePath = join(profileDir, '.claude.json');
  const mainPath = mainClaudeJsonPath;
  const merge = computeClaudeJsonMerge(
    fs.readTextIfExists(profilePath),
    fs.readTextIfExists(mainPath),
  );
  if (merge.serialized === null) {
    // The profile file went corrupt between plan and apply — never clobber the identity.
    report.skipped.push({
      path: profilePath,
      reason: 'profile .claude.json is unparseable; identity left untouched',
    });
    return;
  }
  // Written with temp+rename (mode 0600) — the same "followAtomic" shape Claude Code uses for its
  // own `.claude.json`, and safe here because the profile's file is a regular file, never a link.
  fs.writeFileAtomic(profilePath, Buffer.from(merge.serialized, 'utf8'), SHARED_FILE_MODE);
  report.claudeJsonMerged = true;
  if (merge.mainUnreadable) {
    report.skipped.push({
      path: mainPath,
      reason: 'main .claude.json unreadable; wrote profile-only merge',
    });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
