import { describe, it, expect } from 'vitest';
import {
  DAEMON_UNIT_NAME,
  daemonUnitPath,
  installDaemonUnit,
  queryDaemonUnit,
  renderDaemonUnit,
  startDaemonUnitNow,
  systemdUserAvailable,
  uninstallDaemonUnit,
  type LoginctlRunner,
  type SystemctlRunner,
} from './systemdInstall.js';
import type { TextFileStore } from './textFileStore.js';

// --- fakes ---------------------------------------------------------------------------------------

function memFs(initial: Record<string, string> = {}) {
  const files = new Map(Object.entries(initial));
  const fs: TextFileStore = {
    read: (path) => files.get(path),
    write: (path, content) => void files.set(path, content),
    remove: (path) => void files.delete(path),
  };
  return { fs, files };
}

/** Records every `systemctl --user` / `loginctl` call; `activeState` answers the query and
 *  `failOn` injects a failure for one verb. */
function fakeSystemd(
  options: { activeState?: string; failOn?: (args: string[]) => Error | undefined } = {},
) {
  const calls: string[][] = [];
  const lingerCalls: string[][] = [];
  const run: SystemctlRunner = (args) => {
    calls.push(args);
    const failure = options.failOn?.(args);
    if (failure) throw failure;
    if (args[0] === 'show') return options.activeState ?? 'inactive';
    return '';
  };
  const loginctl: LoginctlRunner = (args) => {
    lingerCalls.push(args);
    return '';
  };
  return { run, loginctl, calls, lingerCalls };
}

const UNIT = '/home/u/.config/systemd/user/claude-control-daemon.service';
const shimPath = '/home/u/.nvm/versions/node/v24.20.0/bin/cctl';

// --- daemonUnitPath ------------------------------------------------------------------------------

describe('daemonUnitPath', () => {
  it('lives in the per-user systemd dir, POSIX-joined wherever the tests run', () => {
    expect(daemonUnitPath({}, '/home/u')).toBe(UNIT);
  });

  it('honors XDG_CONFIG_HOME', () => {
    expect(daemonUnitPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/u')).toBe(
      `/cfg/systemd/user/${DAEMON_UNIT_NAME}`,
    );
  });
});

// --- renderDaemonUnit ----------------------------------------------------------------------------

describe('renderDaemonUnit', () => {
  it('runs the shim by absolute path with PATH rooted at its bin dir, bounded restarts, and a default.target install', () => {
    const unit = renderDaemonUnit(shimPath);
    expect(unit).toContain(`ExecStart="${shimPath}" daemon run`);
    expect(unit).toContain(
      'Environment="PATH=/home/u/.nvm/versions/node/v24.20.0/bin:/usr/local/bin:/usr/bin:/bin"',
    );
    expect(unit).toContain('Restart=on-failure');
    expect(unit).toContain('StartLimitBurst=3');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('cctl daemon uninstall');
  });

  it('escapes double quotes and backslashes per systemd syntax', () => {
    expect(renderDaemonUnit('/opt/we"ird\\x/cctl')).toContain(
      'ExecStart="/opt/we\\"ird\\\\x/cctl" daemon run',
    );
  });
});

// --- installDaemonUnit ---------------------------------------------------------------------------

describe('installDaemonUnit', () => {
  it('writes the unit, reloads, enables, and requests linger on a first install', () => {
    const { fs, files } = memFs();
    const { run, loginctl, calls, lingerCalls } = fakeSystemd();
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toBe('created');
    expect(files.get(UNIT)).toBe(renderDaemonUnit(shimPath));
    expect(calls).toEqual([['daemon-reload'], ['enable', DAEMON_UNIT_NAME]]);
    expect(lingerCalls).toEqual([['enable-linger']]);
  });

  it('is unchanged for identical content and runs nothing at all', () => {
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, loginctl, calls, lingerCalls } = fakeSystemd();
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toBe('unchanged');
    expect(calls).toEqual([]);
    expect(lingerCalls).toEqual([]);
  });

  it('rewrites and reloads when the shim moves', () => {
    const { fs, files } = memFs({ [UNIT]: renderDaemonUnit('/old/bin/cctl') });
    const { run, loginctl, calls } = fakeSystemd();
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toBe('updated');
    expect(files.get(UNIT)).toContain(shimPath);
    expect(calls[0]).toEqual(['daemon-reload']);
  });

  it('keeps the install when linger is refused — the unit still starts at login', () => {
    const { fs } = memFs();
    const { run, calls } = fakeSystemd();
    const loginctl: LoginctlRunner = () => {
      throw new Error('Could not enable linger: Access denied');
    };
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toBe('created');
    expect(calls).toContainEqual(['enable', DAEMON_UNIT_NAME]);
  });

  it('propagates an enable failure', () => {
    const { fs } = memFs();
    const { run, loginctl } = fakeSystemd({
      failOn: (args) => (args[0] === 'enable' ? new Error('Failed to enable unit') : undefined),
    });
    expect(() => installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toThrow(
      'Failed to enable unit',
    );
  });
});

// --- startDaemonUnitNow --------------------------------------------------------------------------

describe('startDaemonUnitNow', () => {
  it('starts the unit as the separate run-now step', () => {
    const { run, calls } = fakeSystemd();
    startDaemonUnitNow({ run });
    expect(calls).toEqual([['start', DAEMON_UNIT_NAME]]);
  });
});

// --- queryDaemonUnit -----------------------------------------------------------------------------

describe('queryDaemonUnit', () => {
  it('is not registered without a unit file, asking the manager nothing', () => {
    const { fs } = memFs();
    const { run, calls } = fakeSystemd();
    expect(queryDaemonUnit({ run, fs, unitPath: UNIT })).toEqual({ registered: false });
    expect(calls).toEqual([]);
  });

  it("reports the manager's ActiveState for a registered unit", () => {
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({ activeState: 'active' });
    expect(queryDaemonUnit({ run, fs, unitPath: UNIT })).toEqual({
      registered: true,
      state: 'active',
    });
  });

  it('keeps the registration standing when the manager cannot be asked', () => {
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({ failOn: () => new Error('Failed to connect to bus') });
    expect(queryDaemonUnit({ run, fs, unitPath: UNIT })).toEqual({ registered: true });
  });
});

// --- uninstallDaemonUnit -------------------------------------------------------------------------

describe('uninstallDaemonUnit', () => {
  it('reports not_installed without a unit file and calls nothing', () => {
    const { fs } = memFs();
    const { run, calls } = fakeSystemd();
    expect(uninstallDaemonUnit({ run, fs, unitPath: UNIT })).toBe('not_installed');
    expect(calls).toEqual([]);
  });

  it('disables (without --now, so a running daemon keeps running), deletes, and reloads', () => {
    const { fs, files } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, calls } = fakeSystemd();
    expect(uninstallDaemonUnit({ run, fs, unitPath: UNIT })).toBe('removed');
    expect(files.has(UNIT)).toBe(false);
    expect(calls).toEqual([['disable', DAEMON_UNIT_NAME], ['daemon-reload']]);
  });

  it('still removes the file when the manager no longer knows the unit', () => {
    const { fs, files } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({
      failOn: (args) =>
        args[0] === 'disable'
          ? new Error(`Failed to disable unit: Unit file ${DAEMON_UNIT_NAME} does not exist.`)
          : undefined,
    });
    expect(uninstallDaemonUnit({ run, fs, unitPath: UNIT })).toBe('removed');
    expect(files.has(UNIT)).toBe(false);
  });

  it('propagates any other disable failure and leaves the file in place', () => {
    const { fs, files } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({
      failOn: (args) => (args[0] === 'disable' ? new Error('Access denied') : undefined),
    });
    expect(() => uninstallDaemonUnit({ run, fs, unitPath: UNIT })).toThrow('Access denied');
    expect(files.has(UNIT)).toBe(true);
  });
});

// --- systemdUserAvailable ------------------------------------------------------------------------

describe('systemdUserAvailable', () => {
  it('is true for a running manager', () => {
    expect(systemdUserAvailable(() => 'running')).toBe(true);
  });

  it('is true for a degraded manager, whose state arrives on a non-zero exit', () => {
    const run: SystemctlRunner = () => {
      throw Object.assign(new Error('exit 1'), { stdout: 'degraded\n' });
    };
    expect(systemdUserAvailable(run)).toBe(true);
  });

  it('is false when there is no manager or no systemctl', () => {
    const noBus: SystemctlRunner = () => {
      throw Object.assign(new Error('Failed to connect to bus'), { stdout: '' });
    };
    expect(systemdUserAvailable(noBus)).toBe(false);
    const noBinary: SystemctlRunner = () => {
      throw new Error('spawnSync systemctl ENOENT');
    };
    expect(systemdUserAvailable(noBinary)).toBe(false);
    expect(systemdUserAvailable(() => 'offline')).toBe(false);
  });
});
