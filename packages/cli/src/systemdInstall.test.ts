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

/** Records every `systemctl --user` / `loginctl` call; `activeState` and `unitFileState` answer
 *  the two `show -p … --value` queries (an enabled unit is the default, since that is what a
 *  successful install leaves behind) and `failOn` injects a failure for one verb. */
function fakeSystemd(
  options: {
    activeState?: string;
    unitFileState?: string;
    failOn?: (args: string[]) => Error | undefined;
  } = {},
) {
  const calls: string[][] = [];
  const lingerCalls: string[][] = [];
  const run: SystemctlRunner = (args) => {
    calls.push(args);
    const failure = options.failOn?.(args);
    if (failure) throw failure;
    if (args[0] === 'show') {
      return args[2] === 'UnitFileState'
        ? (options.unitFileState ?? 'enabled')
        : (options.activeState ?? 'inactive');
    }
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
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toEqual({
      outcome: 'created',
      notes: [],
    });
    expect(files.get(UNIT)).toBe(renderDaemonUnit(shimPath));
    expect(calls).toEqual([['daemon-reload'], ['enable', DAEMON_UNIT_NAME]]);
    expect(lingerCalls).toEqual([['enable-linger']]);
  });

  it('is unchanged for identical content that is already enabled, asking only that', () => {
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, loginctl, calls, lingerCalls } = fakeSystemd();
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toEqual({
      outcome: 'unchanged',
      notes: [],
    });
    expect(calls).toEqual([['show', '-p', 'UnitFileState', '--value', DAEMON_UNIT_NAME]]);
    expect(lingerCalls).toEqual([]);
  });

  it('re-enables a unit whose file is current but which the manager never enabled', () => {
    // The state a failed `enable` used to leave behind: the file is exactly right, so a
    // content-only check calls it 'unchanged' forever while nothing starts it at login.
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, loginctl, calls } = fakeSystemd({ unitFileState: 'disabled' });
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT }).outcome).toBe(
      'updated',
    );
    expect(calls).toContainEqual(['enable', DAEMON_UNIT_NAME]);
  });

  it('leaves a current unit alone when the manager will not say whether it is enabled', () => {
    // `show` exits 0 with an EMPTY value for a unit the manager has never been told about. That
    // is not a "disabled" — it is no answer at all — and reading it as one rewrites and
    // re-enables an already-correct unit on every install, reporting each no-op as work done.
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, loginctl, calls, lingerCalls } = fakeSystemd({ unitFileState: '' });
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toEqual({
      outcome: 'unchanged',
      notes: [],
    });
    expect(calls).toEqual([['show', '-p', 'UnitFileState', '--value', DAEMON_UNIT_NAME]]);
    expect(lingerCalls).toEqual([]);
  });

  it('leaves a current unit alone when the manager cannot be asked at all', () => {
    // The same non-answer by a different route: no bus, no systemctl, nothing to ask.
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run, loginctl } = fakeSystemd({
      failOn: (args) => (args[0] === 'show' ? new Error('Failed to connect to bus') : undefined),
    });
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT }).outcome).toBe(
      'unchanged',
    );
  });

  it('rewrites and reloads when the shim moves', () => {
    const { fs, files } = memFs({ [UNIT]: renderDaemonUnit('/old/bin/cctl') });
    const { run, loginctl, calls } = fakeSystemd();
    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT }).outcome).toBe(
      'updated',
    );
    expect(files.get(UNIT)).toContain(shimPath);
    expect(calls[0]).toEqual(['daemon-reload']);
  });

  it('keeps the install when linger is refused and says so in a note — the unit still starts at login', () => {
    // WSL has no logind to grant linger, and some polkit setups refuse it for the user's own
    // account; either way the operator should hear "at login, not at boot" rather than nothing.
    const { fs } = memFs();
    const { run, calls } = fakeSystemd();
    const loginctl: LoginctlRunner = () => {
      throw new Error('Could not enable linger: No such device or address');
    };
    const result = installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT });
    expect(result.outcome).toBe('created');
    expect(result.notes).toHaveLength(1);
    expect(result.notes[0]).toContain('No such device or address');
    expect(result.notes[0]).toContain('loginctl enable-linger');
    expect(calls).toContainEqual(['enable', DAEMON_UNIT_NAME]);
  });

  it('propagates an enable failure and takes the unregistered file back out', () => {
    const { fs, files } = memFs();
    const { run, loginctl } = fakeSystemd({
      failOn: (args) => (args[0] === 'enable' ? new Error('Failed to enable unit') : undefined),
    });
    expect(() => installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toThrow(
      'Failed to enable unit',
    );
    // A file the manager never linked is not a registration; leaving it behind is what made the
    // next install a no-op.
    expect(files.has(UNIT)).toBe(false);
  });

  it('restores the previous unit when a rewrite cannot be enabled, and re-reads it to the manager', () => {
    const previous = renderDaemonUnit('/old/bin/cctl');
    const { fs, files } = memFs({ [UNIT]: previous });
    const { run, loginctl, calls } = fakeSystemd({
      failOn: (args) => (args[0] === 'enable' ? new Error('Failed to connect to bus') : undefined),
    });
    expect(() => installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toThrow(
      'Failed to connect to bus',
    );
    // The still-registered old unit outlives a failed upgrade rather than being replaced by one
    // that was never enabled.
    expect(files.get(UNIT)).toBe(previous);
    // …and the manager is told, because the reload before the failed enable already handed it
    // the NEW text: without this it holds a parsed definition for content no longer on disk, and
    // a `systemctl --user start` in between would run the unit nobody has.
    expect(calls).toEqual([['daemon-reload'], ['enable', DAEMON_UNIT_NAME], ['daemon-reload']]);
  });

  it('does not let a failing rollback reload replace the failure the caller has to see', () => {
    const previous = renderDaemonUnit('/old/bin/cctl');
    const { fs, files } = memFs({ [UNIT]: previous });
    let reloads = 0;
    const { run, loginctl } = fakeSystemd({
      failOn: (args) => {
        if (args[0] === 'enable') return new Error('Failed to connect to bus');
        // The bus is gone, so the rollback's own reload cannot work either — which must not
        // become the error the operator reads, nor abandon the restored file.
        if (args[0] === 'daemon-reload' && ++reloads > 1) return new Error('reload also failed');
        return undefined;
      },
    });
    expect(() => installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toThrow(
      'Failed to connect to bus',
    );
    expect(files.get(UNIT)).toBe(previous);
  });

  it('retries and enables on the next install after a failed one', () => {
    const { fs, files } = memFs();
    let allowEnable = false;
    const { run, loginctl, calls } = fakeSystemd({
      failOn: (args) =>
        args[0] === 'enable' && !allowEnable ? new Error('Failed to connect to bus') : undefined,
    });
    expect(() => installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT })).toThrow(
      'Failed to connect to bus',
    );
    allowEnable = true;
    calls.length = 0;

    expect(installDaemonUnit({ shimPath, run, loginctl, fs, unitPath: UNIT }).outcome).toBe(
      'created',
    );
    expect(calls).toContainEqual(['enable', DAEMON_UNIT_NAME]);
    expect(files.get(UNIT)).toBe(renderDaemonUnit(shimPath));
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

  it("reports the manager's ActiveState and UnitFileState for an enabled unit", () => {
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({ activeState: 'active' });
    expect(queryDaemonUnit({ run, fs, unitPath: UNIT })).toEqual({
      registered: true,
      state: 'active',
      enabled: 'enabled',
    });
  });

  it('does not call a present-but-disabled unit registered', () => {
    // It will not start at the next login, so a green "registered" line would hide the only
    // thing wrong with this host — and `cctl daemon install`, which the unregistered line
    // recommends, is exactly the fix.
    const { fs } = memFs({ [UNIT]: renderDaemonUnit(shimPath) });
    const { run } = fakeSystemd({ activeState: 'active', unitFileState: 'disabled' });
    expect(queryDaemonUnit({ run, fs, unitPath: UNIT })).toEqual({
      registered: false,
      state: 'active',
      enabled: 'disabled',
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
