import { describe, it, expect } from 'vitest';
import {
  AUTOSTART_UNSUPPORTED_NOTE,
  AutostartUnsupportedError,
  autostartBackend,
  autostartNoun,
  installAutostart,
  queryAutostart,
  readAutostartState,
  uninstallAutostart,
  type AutostartBackends,
} from './autostart.js';

// --- fake backends ----------------------------------------------------------------------------
// Every call is recorded so each test proves not only what the dispatch returned but which
// backend it reached — the defect this module exists to prevent is a call reaching the WRONG
// one (Linux in the Windows backend), and "no call at all" on a platform without a backend is
// as much the contract as the return value.

type Overrides = {
  scheduledTask?: Partial<AutostartBackends['scheduledTask']>;
  launchAgent?: Partial<AutostartBackends['launchAgent']>;
};

function fakeBackends(overrides: Overrides = {}) {
  const calls: string[] = [];
  const backends: AutostartBackends = {
    scheduledTask: {
      install: (shimPath) => {
        calls.push(`task.install ${shimPath}`);
        return 'created';
      },
      startNow: () => {
        calls.push('task.startNow');
      },
      query: () => {
        calls.push('task.query');
        return { registered: true, state: 'Ready' };
      },
      uninstall: () => {
        calls.push('task.uninstall');
        return 'removed';
      },
      ...overrides.scheduledTask,
    },
    launchAgent: {
      install: (shimPath) => {
        calls.push(`agent.install ${shimPath}`);
        return 'updated';
      },
      query: () => {
        calls.push('agent.query');
        return { registered: true, state: 'Loaded' };
      },
      uninstall: () => {
        calls.push('agent.uninstall');
        return 'not_installed';
      },
      ...overrides.launchAgent,
    },
  };
  return { backends, calls };
}

// --- platform → backend -----------------------------------------------------------------------

describe('autostartBackend', () => {
  it('maps Windows and macOS to their backends and everything else to none', () => {
    expect(autostartBackend('win32')).toBe('scheduled-task');
    expect(autostartBackend('darwin')).toBe('launch-agent');
    // Linux covers WSL2 too: `process.platform` is 'linux' there even with Windows interop on
    // PATH, and the Windows backend would register a task pointing at a Linux path.
    for (const platform of ['linux', 'freebsd', 'openbsd', 'sunos', 'aix', 'android'] as const) {
      expect(autostartBackend(platform)).toBe('none');
    }
  });

  it('defaults to the running platform', () => {
    expect(autostartBackend()).toBe(autostartBackend(process.platform));
  });

  it('names the mechanism the way the surfaces print it', () => {
    expect(autostartNoun('scheduled-task')).toBe('logon task');
    expect(autostartNoun('launch-agent')).toBe('LaunchAgent');
  });
});

// --- a platform without a backend --------------------------------------------------------------

describe('dispatch on a platform without a backend', () => {
  it('install throws the unsupported error without touching either backend', () => {
    const { backends, calls } = fakeBackends();
    expect(() => installAutostart('/usr/local/bin/cctl', { platform: 'linux', backends })).toThrow(
      AutostartUnsupportedError,
    );
    expect(() => installAutostart('/usr/local/bin/cctl', { platform: 'linux', backends })).toThrow(
      AUTOSTART_UNSUPPORTED_NOTE,
    );
    expect(calls).toEqual([]);
  });

  it('the unsupported note tells the reader how to run the daemon instead', () => {
    expect(AUTOSTART_UNSUPPORTED_NOTE).toContain('cctl daemon supervise');
    // Never names a platform: the wizard and renderers print it from injected state, so their
    // tests must not depend on the host they run on.
    expect(AUTOSTART_UNSUPPORTED_NOTE).toContain('this platform');
  });

  it('uninstall reports unsupported as an outcome, not an error, and calls nothing', () => {
    const { backends, calls } = fakeBackends();
    expect(uninstallAutostart({ platform: 'linux', backends })).toBe('unsupported');
    expect(calls).toEqual([]);
  });

  it('query and the folded state say unsupported and call nothing', () => {
    const { backends, calls } = fakeBackends();
    expect(queryAutostart({ platform: 'linux', backends })).toEqual({ supported: false });
    expect(readAutostartState({ platform: 'linux', backends })).toBe('unsupported');
    expect(calls).toEqual([]);
  });
});

// --- Windows: Scheduled Task ------------------------------------------------------------------

describe('dispatch on win32', () => {
  it('installs through the Scheduled Task backend and then starts the task', () => {
    const { backends, calls } = fakeBackends();
    const result = installAutostart('C:\\npm\\cctl.cmd', { platform: 'win32', backends });
    expect(result).toEqual({ task: 'created', started: true });
    expect(calls).toEqual(['task.install C:\\npm\\cctl.cmd', 'task.startNow']);
  });

  it('reports a failed start as started:false with the detail, keeping the registration', () => {
    const { backends } = fakeBackends({
      scheduledTask: {
        startNow: () => {
          throw new Error('already running');
        },
      },
    });
    expect(installAutostart('C:\\npm\\cctl.cmd', { platform: 'win32', backends })).toEqual({
      task: 'created',
      started: false,
      detail: 'already running',
    });
  });

  it('lets a registration failure propagate (nothing to start)', () => {
    const { backends, calls } = fakeBackends({
      scheduledTask: {
        install: () => {
          throw new Error('Register-ScheduledTask : Access is denied.');
        },
      },
    });
    expect(() => installAutostart('C:\\npm\\cctl.cmd', { platform: 'win32', backends })).toThrow(
      'Access is denied',
    );
    expect(calls).not.toContain('task.startNow');
  });

  it('queries, uninstalls, and folds state through the Scheduled Task backend', () => {
    const { backends, calls } = fakeBackends();
    expect(queryAutostart({ platform: 'win32', backends })).toEqual({
      supported: true,
      registered: true,
      state: 'Ready',
    });
    expect(readAutostartState({ platform: 'win32', backends })).toBe('registered');
    expect(uninstallAutostart({ platform: 'win32', backends })).toBe('removed');
    expect(calls).toEqual(['task.query', 'task.query', 'task.uninstall']);
  });

  it('reads a backend that cannot even be asked as not registered rather than throwing', () => {
    // `cctl daemon status` and the summaries must keep rendering their other lines.
    const { backends } = fakeBackends({
      scheduledTask: {
        query: () => {
          throw new Error('spawnSync powershell.exe ENOENT');
        },
      },
    });
    expect(queryAutostart({ platform: 'win32', backends })).toEqual({
      supported: true,
      registered: false,
    });
    expect(readAutostartState({ platform: 'win32', backends })).toBe('unregistered');
  });

  it('omits state when the backend reports none', () => {
    const { backends } = fakeBackends({
      scheduledTask: { query: () => ({ registered: false }) },
    });
    expect(queryAutostart({ platform: 'win32', backends })).toEqual({
      supported: true,
      registered: false,
    });
  });
});

// --- macOS: LaunchAgent -----------------------------------------------------------------------

describe('dispatch on darwin', () => {
  it('installs through the LaunchAgent backend, which starts as part of registering', () => {
    const { backends, calls } = fakeBackends();
    const result = installAutostart('/usr/local/bin/cctl', { platform: 'darwin', backends });
    expect(result).toEqual({ task: 'updated', started: true });
    // No separate start call exists on this backend — and no Scheduled Task call ever happens.
    expect(calls).toEqual(['agent.install /usr/local/bin/cctl']);
  });

  it('treats an unchanged (already loaded) agent as started', () => {
    const { backends } = fakeBackends({ launchAgent: { install: () => 'unchanged' } });
    expect(installAutostart('/usr/local/bin/cctl', { platform: 'darwin', backends })).toEqual({
      task: 'unchanged',
      started: true,
    });
  });

  it('queries, uninstalls, and folds state through the LaunchAgent backend', () => {
    const { backends, calls } = fakeBackends();
    backends.launchAgent.query = () => {
      calls.push('agent.query');
      return { registered: false };
    };
    expect(queryAutostart({ platform: 'darwin', backends })).toEqual({
      supported: true,
      registered: false,
    });
    expect(readAutostartState({ platform: 'darwin', backends })).toBe('unregistered');
    expect(uninstallAutostart({ platform: 'darwin', backends })).toBe('not_installed');
    expect(calls).toEqual(['agent.query', 'agent.query', 'agent.uninstall']);
  });
});
