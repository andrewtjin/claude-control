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

// Inside a folder-bound session CLAUDE_CONFIG_DIR is the group's profile. A cctl command run from
// that session's tools must still act on the MAIN config dir, or it writes the global account into
// the profile (one account live in two slots) and points the guard snapshot at the profile.
describe('defaultPaths from inside a group profile', () => {
  const lad = join('C:', 'Users', 'me', 'AppData', 'Local');
  const home = join('C:', 'Users', 'me');
  const vaultDir = join(lad, 'claude-control', 'vault');
  const profile = join(lad, 'claude-control', 'profiles', 'g-123');
  // The logic resolves with win32 path rules; compare separator-blind so this runs on any host.
  const norm = (s: string): string => s.replace(/[\\/]+/g, '/').replace(/\/$/, '');
  const noSnapshot = (): string => {
    throw new Error('ENOENT');
  };

  it('sees through to the main dir the profile links its projects to (explicit main dir)', () => {
    const main = join('D:', 'claude-main');
    const paths = defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: profile }, 'win32', {
      home,
      readlink: (p) => {
        expect(norm(p)).toBe(norm(join(profile, 'projects')));
        // How Windows reports a junction target: long-path prefix and a trailing separator.
        return '\\\\?\\' + join(main, 'projects') + '\\';
      },
      readFile: noSnapshot,
    });
    expect(norm(paths.claudeDir)).toBe(norm(main));
    expect(norm(paths.credentialsPath)).toBe(norm(join(main, '.credentials.json')));
    expect(norm(paths.claudeJsonPath)).toBe(norm(join(main, '.claude.json')));
    expect(norm(paths.vaultDir)).toBe(norm(vaultDir));
    // The profile the session really runs in is kept, for the capture that must refuse there.
    expect(paths.profileConfigDir).toBe(profile);
  });

  it('records no profile when CLAUDE_CONFIG_DIR is not one', () => {
    const dir = join('D:', 'claude-main');
    expect(
      defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: dir }, 'win32').profileConfigDir,
    ).toBe(undefined);
    expect(defaultPaths({ LOCALAPPDATA: lad }, 'win32').profileConfigDir).toBe(undefined);
  });

  it('maps a profile of the default layout back to ~/.claude and ~/.claude.json', () => {
    const paths = defaultPaths(
      { LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: profile.toUpperCase() + '\\' },
      'win32',
      { home, readlink: () => join(home, '.claude', 'projects'), readFile: noSnapshot },
    );
    expect(norm(paths.claudeDir)).toBe(norm(join(home, '.claude')));
    expect(norm(paths.claudeJsonPath)).toBe(norm(join(home, '.claude.json')));
  });

  it('falls back to the guard snapshot when the projects link cannot be read', () => {
    const main = join('E:', 'cfg');
    const paths = defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: profile }, 'win32', {
      home,
      readlink: () => {
        throw new Error('EINVAL');
      },
      readFile: (p) => {
        expect(norm(p)).toBe(norm(join(lad, 'claude-control', 'folder-bindings.json')));
        return JSON.stringify({ schemaVersion: 1, mainConfigDir: main });
      },
    });
    expect(norm(paths.claudeDir)).toBe(norm(main));
  });

  it('falls back to the default layout, never the profile, when nothing names the main dir', () => {
    const paths = defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: profile }, 'win32', {
      home,
      readlink: () => {
        throw new Error('EINVAL');
      },
      readFile: () => '{not json',
    });
    expect(norm(paths.claudeDir)).toBe(norm(join(home, '.claude')));
    expect(paths.profileConfigDir).toBe(profile);
  });

  it('leaves a CLAUDE_CONFIG_DIR outside the profiles root untouched, with no filesystem read', () => {
    const touch = (): string => {
      throw new Error('must not read');
    };
    const dir = join(lad, 'claude-control', 'profiles-not');
    const paths = defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: dir }, 'win32', {
      home,
      readlink: touch,
      readFile: touch,
    });
    expect(norm(paths.claudeDir)).toBe(norm(dir));
  });

  it('treats the profiles root itself as outside any profile', () => {
    const root = join(lad, 'claude-control', 'profiles');
    const paths = defaultPaths({ LOCALAPPDATA: lad, CLAUDE_CONFIG_DIR: root }, 'win32', {
      home,
      readlink: () => {
        throw new Error('must not read');
      },
      readFile: noSnapshot,
    });
    expect(norm(paths.claudeDir)).toBe(norm(root));
  });
});
