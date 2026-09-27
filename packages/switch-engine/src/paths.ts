// Filesystem locations, resolved once and injectable everywhere.
//
// Every path the engine touches is funnelled through this object so tests can point the
// whole engine at a temp directory and never risk a real credential file. Production code
// calls `defaultPaths()`; tests build a `Paths` by hand.

import { readFileSync, readlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix, win32 } from 'node:path';

export interface Paths {
  /** The Claude config dir — honors `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir: string;
  /** `<claudeDir>/.credentials.json` — the live `claudeAiOauth` block (Windows: plaintext). */
  credentialsPath: string;
  /** The CLI config file holding `oauthAccount`: `~/.claude.json` normally, but when
   *  `CLAUDE_CONFIG_DIR` is set the CLI keeps it INSIDE that dir (observed on CLI 2.1.211). */
  claudeJsonPath: string;
  /** Root of our encrypted vault + registry + audit trail. */
  vaultDir: string;
}

/** The platform's convention for machine-local app state (the vault must NOT roam or sync:
 *  its blobs are bound to this machine's DPAPI/Keychain and are garbage anywhere else). */
function machineLocalDataRoot(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string {
  const home = homedir();
  switch (platform) {
    case 'win32':
      return env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
    case 'darwin':
      return join(home, 'Library', 'Application Support');
    default:
      // XDG convention covers Linux and the BSDs.
      return env.XDG_DATA_HOME?.trim() || join(home, '.local', 'share');
  }
}

/** The filesystem reads {@link defaultPaths} makes to see through a group profile; injectable so
 *  tests need no real junctions or home dir. */
export interface DefaultPathsDeps {
  readlink: (path: string) => string;
  readFile: (path: string) => string;
  /** The home dir; read per call when absent (os.homedir follows the environment). */
  home?: string;
}

const REAL_PATH_DEPS: DefaultPathsDeps = {
  readlink: (p) => readlinkSync(p),
  readFile: (p) => readFileSync(p, 'utf8'),
};

/**
 * Resolve the default production paths from the environment.
 *
 * `CLAUDE_CONFIG_DIR` names the MAIN config dir — except inside a folder-bound session, whose
 * `CLAUDE_CONFIG_DIR` is its group's profile under cctl's own profiles root. A cctl command run from
 * such a session's tools (the natural way to ask Claude to switch or bind) must still act on the
 * main dir: treating the profile as the global slot would write the global account's credentials
 * into a group's profile — one account live in two slots — and point the guard snapshot at it. So
 * a profile is seen through to the main dir it stands in for (see {@link mainConfigDirForProfile});
 * the session's own slot is read from the raw environment by the callers that need it.
 */
export function defaultPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  deps: DefaultPathsDeps = REAL_PATH_DEPS,
): Paths {
  const home = deps.home ?? homedir();
  const vaultDir = join(machineLocalDataRoot(env, platform), 'claude-control', 'vault');
  // Observed on CLI 2.1.211: CLAUDE_CONFIG_DIR relocates the whole config — .credentials.json
  // AND .claude.json both live inside it. Only the default (unset) case uses ~/.claude.json.
  // (Platform-independent per the CLI's docs; re-verify on macOS.)
  let configDir = env.CLAUDE_CONFIG_DIR?.trim() || undefined;
  if (configDir !== undefined) {
    const profileDir = profileDirContaining(configDir, profilesRoot(vaultDir), platform);
    if (profileDir !== undefined) {
      const main = mainConfigDirForProfile(profileDir, vaultDir, platform, deps);
      // The default layout's main dir is ~/.claude with ~/.claude.json beside it — the same shape
      // an unset CLAUDE_CONFIG_DIR gives. A main dir that cannot be found (a profile missing its
      // junction and no snapshot) falls back to that default rather than to the profile.
      configDir =
        main === undefined || samePath(main, join(home, '.claude'), platform) ? undefined : main;
    }
  }
  const claudeDir = configDir ?? join(home, '.claude');
  return {
    claudeDir,
    credentialsPath: join(claudeDir, '.credentials.json'),
    claudeJsonPath: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
    vaultDir,
  };
}

/** Path module for the target platform, so the logic is testable for either from either. */
function pathFor(platform: NodeJS.Platform): typeof win32 {
  return platform === 'win32' ? win32 : posix;
}

/** Whether two absolute paths name the same location: resolved, trailing separators dropped, and
 *  case-folded on Windows (its filesystems are case-insensitive). */
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const p = pathFor(platform);
  const norm = (x: string): string => {
    const r = p.resolve(x);
    return platform === 'win32' ? r.toLowerCase() : r;
  };
  return norm(a) === norm(b);
}

/** The group profile dir (`<profilesRoot>/<id>`) that `configDir` is or lies within, or undefined
 *  when it is outside cctl's profiles root. */
function profileDirContaining(
  configDir: string,
  root: string,
  platform: NodeJS.Platform,
): string | undefined {
  const p = pathFor(platform);
  const rel = p.relative(p.resolve(root), p.resolve(configDir));
  if (rel === '' || rel.startsWith('..') || p.isAbsolute(rel)) return undefined;
  const first = rel.split(/[\\/]/)[0];
  return first === undefined || first === '' ? undefined : p.join(p.resolve(root), first);
}

/**
 * The main config dir a group profile stands in for. First from the profile's `projects` link
 * (every profile junctions/symlinks its `projects/` to the main dir's, so sessions share history and
 * memory); else from the guard snapshot's `mainConfigDir`, which the engine writes from its own
 * main dir. Undefined when neither can be read. Never throws.
 */
export function mainConfigDirForProfile(
  profileDir: string,
  vaultDir: string,
  platform: NodeJS.Platform = process.platform,
  deps: Pick<DefaultPathsDeps, 'readlink' | 'readFile'> = REAL_PATH_DEPS,
): string | undefined {
  const p = pathFor(platform);
  try {
    // A junction's target may come back with the `\\?\` long-path prefix or a trailing separator.
    const raw = deps.readlink(p.join(profileDir, 'projects')).replace(/^\\\\\?\\/, '');
    const target = p.resolve(profileDir, raw);
    if (p.basename(target).toLowerCase() === 'projects') return p.dirname(target);
  } catch {
    // Not a link (or unreadable): try the snapshot.
  }
  try {
    const snapshot = JSON.parse(deps.readFile(folderBindingsPath(vaultDir))) as {
      mainConfigDir?: unknown;
    };
    if (typeof snapshot.mainConfigDir === 'string' && snapshot.mainConfigDir.trim() !== '') {
      return snapshot.mainConfigDir;
    }
  } catch {
    // No usable snapshot.
  }
  return undefined;
}

/** Where the POSIX file-key protector (fileKey.ts) keeps the vault key: a SIBLING of
 *  `vaultDir`, deliberately never inside it, so a copied vault directory doesn't carry its
 *  own decryption key. Resolved here so filesystem locations keep a single authority; only
 *  meaningful on platforms without an OS secret store (the file-key dispatch branch). */
export function defaultVaultKeyPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  return join(machineLocalDataRoot(env, platform), 'claude-control', 'vault.key');
}

/** Root under which a folder-bound group's private profile dir is materialized — a SIBLING of the
 *  vault dir (`<machineLocalDataRoot>/claude-control/profiles`), derived from `vaultDir` so the two
 *  never disagree about where they sit. The group profile holds live credentials like `~/.claude`
 *  does, so it must be as machine-local as the vault. */
export function profilesRoot(vaultDir: string): string {
  return join(vaultDir, '..', 'profiles');
}

/** The profile dir for one group: `<profilesRoot>/<groupId>`. The id is an unguessable UUID, so it
 *  is safe to name a directory after; `basename` still reduces it to a single directory name so an id
 *  carrying separators can never escape the profiles root. */
export function groupProfileDir(vaultDir: string, groupId: string): string {
  return join(profilesRoot(vaultDir), basename(groupId));
}

/** The non-secret snapshot the enforcement guard reads — a SIBLING of the vault dir
 *  (`<machineLocalDataRoot>/claude-control/folder-bindings.json`), not inside it: the guard is a
 *  dependency-free hook that must read it without any knowledge of the vault's internals. */
export function folderBindingsPath(vaultDir: string): string {
  return join(vaultDir, '..', 'folder-bindings.json');
}

/** Build a `Paths` rooted entirely inside `root` — used by tests to sandbox all IO. */
export function sandboxPaths(root: string): Paths {
  const claudeDir = join(root, 'claude');
  return {
    claudeDir,
    credentialsPath: join(claudeDir, '.credentials.json'),
    claudeJsonPath: join(root, 'home', '.claude.json'),
    vaultDir: join(root, 'vault'),
  };
}
