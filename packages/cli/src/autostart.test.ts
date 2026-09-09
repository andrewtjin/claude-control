import { describe, it, expect } from 'vitest';
import {
  AUTOSTART_BACKEND_ENV,
  AUTOSTART_UNSUPPORTED_NOTE,
  AutostartUnsupportedError,
  autostartBackend,
  autostartNoun,
  autostartUnsupportedNote,
  detectAutostartHost,
  installAutostart,
  queryAutostart,
  readAutostartState,
  uninstallAutostart,
  type AutostartBackend,
  type AutostartBackends,
  type AutostartHost,
} from './autostart.js';

// --- fixtures --------------------------------------------------------------------------------------

const host = (facts: Partial<AutostartHost> & { platform: NodeJS.Platform }): AutostartHost => ({
  systemdUser: false,
  ...facts,
});

const WSL_OK = {
  distro: 'Ubuntu',
  powerShell: '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe',
};
const WSL_NO_INTEROP = { distro: 'Ubuntu' };

/** Fake backends that record every call as `<backend>.<verb>`, so each test proves not only
 *  what the dispatch returned but which backend it reached — the defect this module exists to
 *  prevent is a call reaching the WRONG one, and "no call at all" on a host without a backend
 *  is as much the contract as the return value. */
function fakeBackends() {
  const calls: string[] = [];
  const impl = (name: Exclude<AutostartBackend, 'none'>, withStart: boolean) => ({
    install: (shimPath: string) => {
      calls.push(`${name}.install ${shimPath}`);
      return { outcome: 'created' as const };
    },
    ...(withStart
      ? {
          startNow: () => {
            calls.push(`${name}.startNow`);
          },
        }
      : {}),
    query: () => {
      calls.push(`${name}.query`);
      return { registered: true, state: 'Ready' };
    },
    uninstall: () => {
      calls.push(`${name}.uninstall`);
      return 'removed' as const;
    },
  });
  const backends: AutostartBackends = {
    'scheduled-task': impl('scheduled-task', true),
    'launch-agent': impl('launch-agent', false),
    'wsl-task': impl('wsl-task', true),
    'systemd-user': impl('systemd-user', true),
  };
  return { backends, calls };
}

// --- detectAutostartHost ---------------------------------------------------------------------------

describe('detectAutostartHost', () => {
  const never = () => {
    throw new Error('probed off Linux');
  };

  it('probes nothing off Linux', () => {
    expect(
      detectAutostartHost({ platform: 'win32', env: {}, wsl: never, systemdUser: never }),
    ).toEqual({ platform: 'win32', systemdUser: false });
  });

  it('gathers the WSL and systemd facts on Linux', () => {
    expect(
      detectAutostartHost({
        platform: 'linux',
        env: {},
        wsl: () => WSL_OK,
        systemdUser: () => true,
      }),
    ).toEqual({ platform: 'linux', wsl: WSL_OK, systemdUser: true });
  });

  it('keeps a recognized override and drops an unrecognized one', () => {
    const probes = { wsl: () => undefined, systemdUser: () => false };
    expect(
      detectAutostartHost({
        platform: 'linux',
        env: { [AUTOSTART_BACKEND_ENV]: 'none' },
        ...probes,
      }).override,
    ).toBe('none');
    expect(
      detectAutostartHost({
        platform: 'linux',
        env: { [AUTOSTART_BACKEND_ENV]: 'cron' },
        ...probes,
      }).override,
    ).toBeUndefined();
  });

  it('defaults to the running platform', () => {
    expect(detectAutostartHost().platform).toBe(process.platform);
  });
});

// --- autostartBackend ------------------------------------------------------------------------------

describe('autostartBackend', () => {
  it('maps Windows and macOS by platform alone', () => {
    expect(autostartBackend(host({ platform: 'win32' }))).toBe('scheduled-task');
    expect(autostartBackend(host({ platform: 'darwin', systemdUser: true }))).toBe('launch-agent');
  });

  it('gives a plain Linux box the systemd user unit, and nothing without a user manager', () => {
    expect(autostartBackend(host({ platform: 'linux', systemdUser: true }))).toBe('systemd-user');
    expect(autostartBackend(host({ platform: 'linux' }))).toBe('none');
  });

  it('prefers the Windows task inside WSL even when systemd is also running there', () => {
    // A unit inside the distro dies with WSL's idle shutdown; the Windows task keeps it alive.
    expect(autostartBackend(host({ platform: 'linux', wsl: WSL_OK, systemdUser: true }))).toBe(
      'wsl-task',
    );
  });

  it('falls back to systemd inside WSL only when the Windows side is unreachable', () => {
    expect(
      autostartBackend(host({ platform: 'linux', wsl: WSL_NO_INTEROP, systemdUser: true })),
    ).toBe('systemd-user');
    expect(autostartBackend(host({ platform: 'linux', wsl: WSL_NO_INTEROP }))).toBe('none');
  });

  it('honors the override, and an ask the host cannot meet becomes none, not the other backend', () => {
    expect(autostartBackend(host({ platform: 'linux', wsl: WSL_OK, override: 'none' }))).toBe(
      'none',
    );
    expect(
      autostartBackend(host({ platform: 'linux', wsl: WSL_OK, override: 'systemd-user' })),
    ).toBe('systemd-user');
    expect(
      autostartBackend(host({ platform: 'linux', systemdUser: true, override: 'wsl-task' })),
    ).toBe('none');
    expect(autostartBackend(host({ platform: 'linux', wsl: WSL_OK, override: 'wsl-task' }))).toBe(
      'wsl-task',
    );
  });

  it('ignores the override off Linux', () => {
    expect(autostartBackend(host({ platform: 'win32', override: 'none' }))).toBe('scheduled-task');
  });

  it('has no backend for the other platforms', () => {
    for (const platform of ['freebsd', 'openbsd', 'sunos', 'aix', 'android'] as const) {
      expect(autostartBackend(host({ platform, systemdUser: true }))).toBe('none');
    }
  });

  it('defaults to the detected host', () => {
    expect(autostartBackend()).toBe(autostartBackend(detectAutostartHost()));
  });

  it('names the mechanism the way the surfaces print it', () => {
    expect(autostartNoun('scheduled-task')).toBe('logon task');
    expect(autostartNoun('wsl-task')).toBe('logon task');
    expect(autostartNoun('launch-agent')).toBe('LaunchAgent');
    expect(autostartNoun('systemd-user')).toBe('systemd user service');
  });
});

// --- autostartUnsupportedNote ------------------------------------------------------------------------

describe('autostartUnsupportedNote', () => {
  it('always carries the manual start, and no platform name in the generic form', () => {
    expect(AUTOSTART_UNSUPPORTED_NOTE).toContain('cctl daemon supervise');
    expect(AUTOSTART_UNSUPPORTED_NOTE).toContain('this platform');
    expect(autostartUnsupportedNote(host({ platform: 'freebsd' }))).toBe(
      AUTOSTART_UNSUPPORTED_NOTE,
    );
  });

  it('names the WSL distro and interop when the Windows side is unreachable', () => {
    const note = autostartUnsupportedNote(host({ platform: 'linux', wsl: WSL_NO_INTEROP }));
    expect(note).toContain('Ubuntu');
    expect(note).toContain('interop');
  });

  it('names the missing user manager on a plain Linux box', () => {
    expect(autostartUnsupportedNote(host({ platform: 'linux' }))).toContain('systemctl --user');
  });

  it('names the opt-out, and a wsl-task ask outside WSL', () => {
    expect(autostartUnsupportedNote(host({ platform: 'linux', override: 'none' }))).toContain(
      `${AUTOSTART_BACKEND_ENV}=none`,
    );
    expect(
      autostartUnsupportedNote(
        host({ platform: 'linux', systemdUser: true, override: 'wsl-task' }),
      ),
    ).toContain('not a WSL distro');
  });
});

// --- dispatch on a host without a backend -------------------------------------------------------------

describe('dispatch on a host without a backend', () => {
  const none = host({ platform: 'linux' });

  it('install throws the unsupported error with the reason, touching no backend', () => {
    const { backends, calls } = fakeBackends();
    expect(() => installAutostart('/usr/local/bin/cctl', { host: none, backends })).toThrow(
      AutostartUnsupportedError,
    );
    expect(() => installAutostart('/usr/local/bin/cctl', { host: none, backends })).toThrow(
      'systemctl --user',
    );
    expect(calls).toEqual([]);
  });

  it('uninstall and query report the fact rather than an error, and call nothing', () => {
    const { backends, calls } = fakeBackends();
    expect(uninstallAutostart({ host: none, backends })).toBe('unsupported');
    expect(queryAutostart({ host: none, backends })).toEqual({ supported: false });
    expect(readAutostartState({ host: none, backends })).toBe('unsupported');
    expect(calls).toEqual([]);
  });
});

// --- dispatch per backend -------------------------------------------------------------------------------

describe('dispatch per backend', () => {
  const cases: {
    title: string;
    host: AutostartHost;
    backend: Exclude<AutostartBackend, 'none'>;
  }[] = [
    {
      title: 'Windows → Scheduled Task',
      host: host({ platform: 'win32' }),
      backend: 'scheduled-task',
    },
    { title: 'macOS → LaunchAgent', host: host({ platform: 'darwin' }), backend: 'launch-agent' },
    {
      title: 'WSL → Windows task',
      host: host({ platform: 'linux', wsl: WSL_OK }),
      backend: 'wsl-task',
    },
    {
      title: 'Linux → systemd user unit',
      host: host({ platform: 'linux', systemdUser: true }),
      backend: 'systemd-user',
    },
  ];

  for (const { title, host: h, backend } of cases) {
    it(`${title}: install, query, and uninstall reach exactly that backend`, () => {
      const { backends, calls } = fakeBackends();
      const result = installAutostart('/p/cctl', { host: h, backends });
      expect(result).toEqual({ task: 'created', started: true });
      expect(queryAutostart({ host: h, backends })).toEqual({
        supported: true,
        noun: autostartNoun(backend),
        registered: true,
        state: 'Ready',
      });
      expect(readAutostartState({ host: h, backends })).toBe('registered');
      expect(uninstallAutostart({ host: h, backends })).toBe('removed');
      const expected = [`${backend}.install /p/cctl`];
      if (backends[backend].startNow !== undefined) expected.push(`${backend}.startNow`);
      expected.push(`${backend}.query`, `${backend}.query`, `${backend}.uninstall`);
      expect(calls).toEqual(expected);
    });
  }

  it("passes a backend's notes through, and omits the field when there are none", () => {
    const { backends } = fakeBackends();
    const linux = host({ platform: 'linux', systemdUser: true });
    backends['systemd-user'].install = () => ({
      outcome: 'created',
      notes: ['could not enable linger (refused)'],
    });
    expect(installAutostart('/p/cctl', { host: linux, backends })).toEqual({
      task: 'created',
      started: true,
      notes: ['could not enable linger (refused)'],
    });
    backends['systemd-user'].install = () => ({ outcome: 'created', notes: [] });
    expect(installAutostart('/p/cctl', { host: linux, backends })).toEqual({
      task: 'created',
      started: true,
    });
  });

  it('reports a failed start as started:false with the detail, keeping the registration', () => {
    const { backends } = fakeBackends();
    backends['systemd-user'].startNow = () => {
      throw new Error('Failed to start: unit masked');
    };
    expect(
      installAutostart('/p/cctl', {
        host: host({ platform: 'linux', systemdUser: true }),
        backends,
      }),
    ).toEqual({ task: 'created', started: false, detail: 'Failed to start: unit masked' });
  });

  it('lets a registration failure propagate, starting nothing', () => {
    const { backends, calls } = fakeBackends();
    backends['wsl-task'].install = () => {
      throw new Error('Register-ScheduledTask : Access is denied.');
    };
    expect(() =>
      installAutostart('/p/cctl', { host: host({ platform: 'linux', wsl: WSL_OK }), backends }),
    ).toThrow('Access is denied');
    expect(calls).not.toContain('wsl-task.startNow');
  });

  it('treats an unchanged LaunchAgent as started — registering is what starts it', () => {
    const { backends } = fakeBackends();
    backends['launch-agent'].install = () => ({ outcome: 'unchanged' });
    expect(installAutostart('/p/cctl', { host: host({ platform: 'darwin' }), backends })).toEqual({
      task: 'unchanged',
      started: true,
    });
  });

  it('reads a backend that cannot even be asked as not registered rather than throwing', () => {
    const { backends } = fakeBackends();
    backends['scheduled-task'].query = () => {
      throw new Error('spawnSync powershell.exe ENOENT');
    };
    expect(queryAutostart({ host: host({ platform: 'win32' }), backends })).toEqual({
      supported: true,
      noun: 'logon task',
      registered: false,
    });
    expect(readAutostartState({ host: host({ platform: 'win32' }), backends })).toBe(
      'unregistered',
    );
  });

  it('omits state when the backend reports none', () => {
    const { backends } = fakeBackends();
    backends['scheduled-task'].query = () => ({ registered: false });
    expect(queryAutostart({ host: host({ platform: 'win32' }), backends })).toEqual({
      supported: true,
      noun: 'logon task',
      registered: false,
    });
  });
});
