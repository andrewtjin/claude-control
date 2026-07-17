// Locks in the wet-verified (WT-1, CLI 2.1.211) CLAUDE_CONFIG_DIR semantics: the env var
// relocates the ENTIRE config — both .credentials.json and .claude.json — while the
// default (unset) case keeps .claude.json in the home dir.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultPaths } from './paths.js';

describe('defaultPaths', () => {
  it('uses ~/.claude and ~/.claude.json when CLAUDE_CONFIG_DIR is unset', () => {
    const paths = defaultPaths({});
    expect(paths.claudeDir).toBe(join(homedir(), '.claude'));
    expect(paths.credentialsPath).toBe(join(homedir(), '.claude', '.credentials.json'));
    expect(paths.claudeJsonPath).toBe(join(homedir(), '.claude.json'));
  });

  it('relocates BOTH credential files into CLAUDE_CONFIG_DIR when set (WT-1)', () => {
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
