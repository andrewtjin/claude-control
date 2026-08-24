import { describe, it, expect } from 'vitest';
import {
  DAEMON_AGENT_LABEL,
  daemonAgentPlistPath,
  renderDaemonAgentPlist,
  installDaemonAgent,
  queryDaemonAgent,
  uninstallDaemonAgent,
  type LaunchctlRunner,
  type PlistFs,
} from './launchdInstall.js';

// --- fake launchd ----------------------------------------------------------------------------
// Interprets the exact launchctl verbs this module emits (bootout/bootstrap/print) against an
// in-memory loaded flag, so installDaemonAgent's compare-then-rebootstrap decisions and the
// not-loaded swallowing are provable without a real launchd.

function fakeLaunchd(initiallyLoaded = false, bootoutError?: string) {
  let loaded = initiallyLoaded;
  const calls: string[][] = [];
  const run: LaunchctlRunner = (args) => {
    calls.push(args);
    switch (args[0]) {
      case 'bootout':
        if (bootoutError) throw new Error(bootoutError);
        if (!loaded)
          // What launchctl actually prints for an absent job — must be treated as benign.
          throw new Error('Boot-out failed: 5: Input/output error');
        loaded = false;
        return '';
      case 'bootstrap':
        loaded = true;
        return '';
      case 'print':
        if (!loaded)
          throw new Error(`Could not find service "${DAEMON_AGENT_LABEL}" in domain for user`);
        return 'state = running';
      default:
        throw new Error(`fake launchd: unrecognized verb ${String(args[0])}`);
    }
  };
  return { run, calls, isLoaded: () => loaded };
}

function memFs(initial?: Record<string, string>) {
  const files = new Map(Object.entries(initial ?? {}));
  const fs: PlistFs = {
    read: (path) => files.get(path),
    write: (path, content) => void files.set(path, content),
    remove: (path) => void files.delete(path),
  };
  return { fs, files };
}

const SHIM = '/usr/local/lib/node_modules/@andrewtjin/cctl/bin/cctl';
const PLIST = '/Users/u/Library/LaunchAgents/com.claude-control.daemon.plist';
const LOG = '/Users/u/Library/Logs/claude-control.log';
const UID = 501;

function install(fs: PlistFs, run: LaunchctlRunner, shimPath = SHIM) {
  return installDaemonAgent({ shimPath, run, fs, plistPath: PLIST, logPath: LOG, uid: UID });
}

describe('renderDaemonAgentPlist', () => {
  it('runs the shim by absolute path with the shim dir on PATH', () => {
    const plist = renderDaemonAgentPlist(SHIM, LOG);
    expect(plist).toContain(`<string>${SHIM}</string>`);
    expect(plist).toContain('<string>daemon</string>');
    expect(plist).toContain('<string>run</string>');
    expect(plist).toContain(
      '<string>/usr/local/lib/node_modules/@andrewtjin/cctl/bin:/usr/local/bin:/usr/bin:/bin</string>',
    );
    expect(plist).toContain(`<string>${DAEMON_AGENT_LABEL}</string>`);
  });

  it('escapes XML metacharacters in injected paths', () => {
    const plist = renderDaemonAgentPlist('/odd path/<x>&co/cctl', LOG);
    expect(plist).toContain('/odd path/&lt;x&gt;&amp;co/cctl');
    expect(plist).not.toContain('<x>&co');
  });
});

describe('installDaemonAgent', () => {
  it('first install writes the plist and bootstraps (bootout of the absent job swallowed)', () => {
    const { fs, files } = memFs();
    const launchd = fakeLaunchd();

    expect(install(fs, launchd.run)).toBe('created');

    expect(files.get(PLIST)).toContain(`<string>${SHIM}</string>`);
    expect(launchd.calls).toEqual([
      ['bootout', `gui/${UID}/${DAEMON_AGENT_LABEL}`],
      ['bootstrap', `gui/${UID}`, PLIST],
    ]);
    expect(launchd.isLoaded()).toBe(true);
  });

  it('repeat install with identical content is a no-op', () => {
    const { fs } = memFs();
    expect(install(fs, fakeLaunchd().run)).toBe('created');

    const launchd = fakeLaunchd(true);
    expect(install(fs, launchd.run)).toBe('unchanged');
    expect(launchd.calls).toEqual([]);
  });

  it('changed content re-bootstraps and reports updated', () => {
    const { fs, files } = memFs();
    expect(install(fs, fakeLaunchd().run)).toBe('created');

    const launchd = fakeLaunchd(true);
    const moved = '/opt/homebrew/lib/node_modules/@andrewtjin/cctl/bin/cctl';
    expect(install(fs, launchd.run, moved)).toBe('updated');
    expect(files.get(PLIST)).toContain(moved);
    expect(launchd.calls).toEqual([
      ['bootout', `gui/${UID}/${DAEMON_AGENT_LABEL}`],
      ['bootstrap', `gui/${UID}`, PLIST],
    ]);
  });

  it('a real bootout failure propagates instead of being swallowed', () => {
    const { fs } = memFs();
    expect(install(fs, fakeLaunchd().run)).toBe('created');
    const launchd = fakeLaunchd(true, 'Boot-out failed: 1: Operation not permitted');
    expect(() => install(fs, launchd.run, '/elsewhere/cctl')).toThrow('not permitted');
  });
});

describe('queryDaemonAgent', () => {
  it('reports unregistered when no plist exists', () => {
    const { fs } = memFs();
    expect(queryDaemonAgent(fakeLaunchd().run, fs, PLIST, UID)).toEqual({ registered: false });
  });

  it('recovers the execute path from the plist and reflects launchd load state', () => {
    const { fs } = memFs();
    install(fs, fakeLaunchd().run);

    expect(queryDaemonAgent(fakeLaunchd(true).run, fs, PLIST, UID)).toEqual({
      registered: true,
      execute: SHIM,
      arguments: 'daemon run',
      state: 'Loaded',
    });
    expect(queryDaemonAgent(fakeLaunchd(false).run, fs, PLIST, UID).state).toBe('NotLoaded');
  });
});

describe('uninstallDaemonAgent', () => {
  it('reports not_installed when no plist exists', () => {
    const { fs } = memFs();
    const launchd = fakeLaunchd();
    expect(uninstallDaemonAgent(launchd.run, fs, PLIST, UID)).toBe('not_installed');
    expect(launchd.calls).toEqual([]);
  });

  it('boots the job out and deletes the plist', () => {
    const { fs, files } = memFs();
    install(fs, fakeLaunchd().run);

    const launchd = fakeLaunchd(true);
    expect(uninstallDaemonAgent(launchd.run, fs, PLIST, UID)).toBe('removed');
    expect(files.has(PLIST)).toBe(false);
    expect(launchd.isLoaded()).toBe(false);
  });

  it('still removes the plist when the job was never loaded', () => {
    const { fs, files } = memFs();
    install(fs, fakeLaunchd().run);
    expect(uninstallDaemonAgent(fakeLaunchd(false).run, fs, PLIST, UID)).toBe('removed');
    expect(files.has(PLIST)).toBe(false);
  });
});

describe('daemonAgentPlistPath', () => {
  it('lives in the per-user LaunchAgents dir', () => {
    expect(daemonAgentPlistPath('/Users/u')).toBe(PLIST);
  });
});
