// Filesystem locations, resolved once and injectable everywhere.
//
// Every path the engine touches is funnelled through this object so tests can point the
// whole engine at a temp directory and never risk a real credential file. Production code
// calls `defaultPaths()`; tests build a `Paths` by hand.

import { homedir } from 'node:os';
import { basename, join } from 'node:path';

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

/** Resolve the default production paths from the environment. */
export function defaultPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Paths {
  const home = homedir();
  // Observed on CLI 2.1.211: CLAUDE_CONFIG_DIR relocates the whole config — .credentials.json
  // AND .claude.json both live inside it. Only the default (unset) case uses ~/.claude.json.
  // (Platform-independent per the CLI's docs; re-verify on macOS.)
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const claudeDir = configDir || join(home, '.claude');
  return {
    claudeDir,
    credentialsPath: join(claudeDir, '.credentials.json'),
    claudeJsonPath: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
    vaultDir: join(machineLocalDataRoot(env, platform), 'claude-control', 'vault'),
  };
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
