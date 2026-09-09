import { describe, it, expect } from 'vitest';
import {
  detectWsl,
  installWslDaemonTask,
  queryWslDaemonTask,
  startWslDaemonTaskNow,
  uninstallWslDaemonTask,
  wslTaskAction,
  wslTaskName,
  WSL_INTEROP_FLAG,
  WSL_POWERSHELL_PATH,
  WSL_TASK_NAME_PREFIX,
} from './wslInstall.js';
import { fakeTaskScheduler } from './testing/fakeTaskScheduler.js';

const existsAmong = (present: string[]) => (path: string) => present.includes(path);

// --- detectWsl ---------------------------------------------------------------------------------

describe('detectWsl', () => {
  it('is undefined outside WSL, whatever else exists on disk', () => {
    expect(
      detectWsl({ env: {}, exists: existsAmong([WSL_INTEROP_FLAG, WSL_POWERSHELL_PATH]) }),
    ).toBeUndefined();
  });

  it('reports the distro with PowerShell at its /mnt/c location, PATH or not', () => {
    expect(
      detectWsl({
        env: { WSL_DISTRO_NAME: 'Ubuntu', PATH: '/usr/bin:/bin' },
        exists: existsAmong([WSL_INTEROP_FLAG, WSL_POWERSHELL_PATH]),
      }),
    ).toEqual({ distro: 'Ubuntu', powerShell: WSL_POWERSHELL_PATH });
  });

  it('falls back to a powershell.exe on the colon-separated PATH when the drive is mounted elsewhere', () => {
    const onPath = '/mnt/d/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
    expect(
      detectWsl({
        env: {
          WSL_DISTRO_NAME: 'Ubuntu',
          PATH: '/usr/bin:/mnt/d/Windows/System32/WindowsPowerShell/v1.0',
        },
        exists: existsAmong([WSL_INTEROP_FLAG, onPath]),
      }),
    ).toEqual({ distro: 'Ubuntu', powerShell: onPath });
  });

  it('reports the distro without PowerShell when interop is off — the reason, not silence', () => {
    expect(
      detectWsl({
        env: { WSL_DISTRO_NAME: 'Ubuntu' },
        exists: existsAmong([WSL_POWERSHELL_PATH]),
      }),
    ).toEqual({ distro: 'Ubuntu' });
  });

  it('reports the distro without PowerShell when no location has it', () => {
    expect(
      detectWsl({
        env: { WSL_DISTRO_NAME: 'Ubuntu', PATH: '/usr/bin' },
        exists: existsAmong([WSL_INTEROP_FLAG]),
      }),
    ).toEqual({ distro: 'Ubuntu' });
  });
});

// --- wslTaskName ---------------------------------------------------------------------------------

describe('wslTaskName', () => {
  it('is one task per distro under a fixed prefix', () => {
    expect(wslTaskName('Ubuntu-22.04')).toBe(`${WSL_TASK_NAME_PREFIX}Ubuntu-22.04`);
  });

  it('replaces characters Task Scheduler refuses in a name', () => {
    expect(wslTaskName('my/distro:x?')).toBe(`${WSL_TASK_NAME_PREFIX}my_distro_x_`);
  });
});

// --- wslTaskAction -------------------------------------------------------------------------------

describe('wslTaskAction', () => {
  it('pins the shim bin dir onto PATH and execs the shim through a login shell in the named distro, as one double-quoted Windows token', () => {
    // The pinned PATH is what reaches an nvm-installed node from a non-interactive login shell:
    // a real run without it died with `env: 'node': No such file or directory`.
    expect(wslTaskAction('Ubuntu', '/home/u/.nvm/versions/node/v24.20.0/bin/cctl')).toEqual({
      execute: 'wsl.exe',
      arguments:
        `-d Ubuntu --exec /bin/bash -lc "export PATH='/home/u/.nvm/versions/node/v24.20.0/bin':$PATH; ` +
        `exec '/home/u/.nvm/versions/node/v24.20.0/bin/cctl' daemon run"`,
    });
  });

  it('single-quotes paths with spaces for bash and double-quotes a distro with spaces for Windows', () => {
    expect(wslTaskAction('Ubuntu 24', '/home/some user/bin/cctl').arguments).toBe(
      `-d "Ubuntu 24" --exec /bin/bash -lc "export PATH='/home/some user/bin':$PATH; ` +
        `exec '/home/some user/bin/cctl' daemon run"`,
    );
  });

  it("escapes an apostrophe in the path with bash's '\\'' idiom, in both places it appears", () => {
    const { arguments: args } = wslTaskAction('Ubuntu', "/home/o'neil/bin/cctl");
    expect(args).toContain(`export PATH='/home/o'\\''neil/bin':$PATH`);
    expect(args).toContain(`exec '/home/o'\\''neil/bin/cctl' daemon run`);
  });

  it('refuses a double quote in the path or the distro instead of mis-quoting it', () => {
    expect(() => wslTaskAction('Ubuntu', '/home/we"ird/cctl')).toThrow(/double quote/);
    expect(() => wslTaskAction('Ubu"ntu', '/home/u/cctl')).toThrow(/double quote/);
  });
});

// --- lifecycle -----------------------------------------------------------------------------------

describe('WSL task lifecycle', () => {
  const host = { distro: 'Ubuntu', powerShell: WSL_POWERSHELL_PATH };
  const shimPath = '/home/u/.nvm/versions/node/v24.20.0/bin/cctl';

  it('installs under the per-distro name with the wsl.exe action and a distro-naming description', () => {
    const { run, current, scripts } = fakeTaskScheduler(undefined);
    expect(installWslDaemonTask({ host, shimPath, run })).toBe('created');
    expect(current()).toEqual({
      execute: 'wsl.exe',
      arguments: wslTaskAction('Ubuntu', shimPath).arguments,
      description: expect.stringContaining('Ubuntu') as string,
      state: 'Ready',
    });
    const register = scripts.find((s) => s.includes('Register-ScheduledTask'));
    expect(register).toContain("-TaskName 'ClaudeControlDaemon-WSL-Ubuntu'");
    // Never the native task's name: a Windows-side cctl must keep its own registration.
    expect(register).not.toContain("-TaskName 'ClaudeControlDaemon'");
  });

  it('is unchanged on a repeat install and updated when the shim moves', () => {
    const { run, scripts } = fakeTaskScheduler(undefined);
    installWslDaemonTask({ host, shimPath, run });
    expect(installWslDaemonTask({ host, shimPath, run })).toBe('unchanged');
    expect(installWslDaemonTask({ host, shimPath: '/usr/local/bin/cctl', run })).toBe('updated');
    expect(scripts.filter((s) => s.includes('Register-ScheduledTask'))).toHaveLength(2);
  });

  it('query, start, and uninstall all address the same per-distro task', () => {
    const { run, scripts, startCalls, current } = fakeTaskScheduler(undefined);
    installWslDaemonTask({ host, shimPath, run });
    expect(queryWslDaemonTask({ host, run })).toMatchObject({
      registered: true,
      execute: 'wsl.exe',
    });
    startWslDaemonTaskNow({ host, run });
    expect(startCalls()).toBe(1);
    expect(uninstallWslDaemonTask({ host, run })).toBe('removed');
    expect(current()).toBeUndefined();
    for (const script of scripts) expect(script).toContain("'ClaudeControlDaemon-WSL-Ubuntu'");
  });

  it('refuses to run without a reachable PowerShell, naming the fix', () => {
    expect(() => queryWslDaemonTask({ host: { distro: 'Ubuntu' } })).toThrow(/interop/);
  });
});
