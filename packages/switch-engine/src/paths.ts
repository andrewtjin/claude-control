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
  /** `~/.claude.json` — holds `oauthAccount`. Lives in the HOME dir, NOT under claudeDir. */
  claudeJsonPath: string;
  /** Root of our encrypted vault + registry + audit trail. */
  vaultDir: string;
}

/** Resolve the default production paths from the environment. */
export function defaultPaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const home = homedir();
  // CLAUDE_CONFIG_DIR relocates .credentials.json but NOT ~/.claude.json — mirror that.
  const claudeDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  // On Windows LOCALAPPDATA is the right home for machine-local encrypted state.
  const localAppData = env.LOCALAPPDATA?.trim() || join(home, 'AppData', 'Local');
  return {
    claudeDir,
    credentialsPath: join(claudeDir, '.credentials.json'),
    claudeJsonPath: join(home, '.claude.json'),
    vaultDir: join(localAppData, 'claude-control', 'vault'),
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
