// Locks in the CLAUDE_CONFIG_DIR semantics observed on CLI 2.1.211: the env var
// relocates the ENTIRE config — both .credentials.json and .claude.json — while the
// default (unset) case keeps .claude.json in the home dir.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPaths, groupProfileDir, profilesRoot } from './paths.js';
import { groupProfileDir as indexGroupProfileDir } from './index.js';

describe('defaultPaths', () => {
  it('uses ~/.claude and ~/.claude.json when CLAUDE_CONFIG_DIR is unset', () => {
    const paths = defaultPaths({});
    expect(paths.claudeDir).toBe(join(homedir(), '.claude'));
    expect(paths.credentialsPath).toBe(join(homedir(), '.claude', '.credentials.json'));
    expect(paths.claudeJsonPath).toBe(join(homedir(), '.claude.json'));
  });

  it('relocates BOTH credential files into CLAUDE_CONFIG_DIR when set', () => {
    const dir = join('C:', 'somewhere', 'transient');
    const paths = defaultPaths({ CLAUDE_CONFIG_DIR: dir });
    expect(paths.claudeDir).toBe(dir);
    expect(paths.credentialsPath).toBe(join(dir, '.credentials.json'));
    expect(paths.claudeJsonPath).toBe(join(dir, '.claude.json'));
  });

  it('treats a whitespace-only CLAUDE_CONFIG_DIR as unset', () => {
    const paths = defaultPaths({ CLAUDE_CONFIG_DIR: '   ' });
    expect(paths.claudeJsonPath).toBe(join(homedir(), '.claude.json'));
  });

  it('roots the vault under each platform machine-local data convention', () => {
    expect(defaultPaths({ LOCALAPPDATA: join('D:', 'lad') }, 'win32').vaultDir).toBe(
      join('D:', 'lad', 'claude-control', 'vault'),
    );
    expect(defaultPaths({}, 'win32').vaultDir).toBe(
      join(homedir(), 'AppData', 'Local', 'claude-control', 'vault'),
    );
    expect(defaultPaths({}, 'darwin').vaultDir).toBe(
      join(homedir(), 'Library', 'Application Support', 'claude-control', 'vault'),
    );
    expect(defaultPaths({ XDG_DATA_HOME: join('/', 'xdg') }, 'linux').vaultDir).toBe(
      join('/', 'xdg', 'claude-control', 'vault'),
    );
    expect(defaultPaths({}, 'linux').vaultDir).toBe(
      join(homedir(), '.local', 'share', 'claude-control', 'vault'),
    );
  });

  it('keeps claude config locations platform-independent (only the vault root moves)', () => {
    const mac = defaultPaths({}, 'darwin');
    expect(mac.claudeDir).toBe(join(homedir(), '.claude'));
    expect(mac.claudeJsonPath).toBe(join(homedir(), '.claude.json'));
  });
});

describe('groupProfileDir', () => {
  it('names a group dir under the profiles root derived from the vault dir', () => {
    const vaultDir = join('C:', 'sandbox', 'claude-control', 'vault');
    expect(groupProfileDir(vaultDir, 'g1')).toBe(join(profilesRoot(vaultDir), 'g1'));
  });

  it('stays anchored to the vault dir, never a real-system profiles root', () => {
    // The dir must be derived from the passed vault dir so a sandboxed vault never materializes
    // profiles or reserved credentials under the real machine-local data root.
    const vaultDir = join('C:', 'sandbox', 'vault');
    expect(groupProfileDir(vaultDir, 'g1').startsWith(join('C:', 'sandbox'))).toBe(true);
  });

  it('reduces an id carrying separators to a single directory name (no escape)', () => {
    const vaultDir = join('C:', 'sandbox', 'vault');
    const root = profilesRoot(vaultDir);
    expect(groupProfileDir(vaultDir, '../../etc')).toBe(join(root, 'etc'));
  });

  it('the package barrel exports exactly the vault-dir-based function', () => {
    // Guards against re-introducing a second `groupProfileDir` whose signature or default differs
    // (a shadowing barrel re-export once defaulted to the real-system profiles root).
    expect(indexGroupProfileDir).toBe(groupProfileDir);
    expect(indexGroupProfileDir.length).toBe(2);
  });
});
