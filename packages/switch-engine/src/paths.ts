// Filesystem locations, resolved once and injectable everywhere.
//
// Every path the engine touches is funnelled through this object so tests can point the
// whole engine at a temp directory and never risk a real credential file. Production code
// calls `defaultPaths()`; tests build a `Paths` by hand.

import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Paths {
  /** The Claude config dir — honors `CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  claudeDir: string;
  /** `<claudeDir>/.credentials.json` — the live `claudeAiOauth` block (Windows: plaintext). */
  credentialsPath: string;
  /** The CLI config file holding `oauthAccount`: `~/.claude.json` normally, but when
   *  `CLAUDE_CONFIG_DIR` is set the CLI keeps it INSIDE that dir (wet-verified, WT-1). */
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
  // WT-1 (CLI 2.1.211): CLAUDE_CONFIG_DIR relocates the whole config — .credentials.json
  // AND .claude.json both live inside it. Only the default (unset) case uses ~/.claude.json.
  // (Platform-independent per the CLI's docs; the mac wet gate re-verifies — assumption A3.)
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  const claudeDir = configDir || join(home, '.claude');
  return {
    claudeDir,
    credentialsPath: join(claudeDir, '.credentials.json'),
    claudeJsonPath: configDir ? join(configDir, '.claude.json') : join(home, '.claude.json'),
    vaultDir: join(machineLocalDataRoot(env, platform), 'claude-control', 'vault'),
  };
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
