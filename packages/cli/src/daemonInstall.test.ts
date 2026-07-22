import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  resolveCctlShimPath,
  queryDaemonTask,
  installDaemonTask,
  uninstallDaemonTask,
  startDaemonTaskNow,
  decodePowerShellStderr,
  DAEMON_TASK_NAME,
  DAEMON_TASK_ARGUMENTS,
  type PowerShellRunner,
} from './daemonInstall.js';

// --- fake Task Scheduler ---------------------------------------------------------------------
// Interprets the exact PowerShell verbs this module emits (Get/Register/Unregister/Start-
// ScheduledTask) against in-memory state, so installDaemonTask's check-then-update decisions
// and the exact invocation shape are provable without a real Task Scheduler.

interface FakeRegistration {
  execute: string;
  arguments: string;
  state: string;
}

function fakeTaskScheduler(initial?: FakeRegistration) {
  let registered: FakeRegistration | undefined = initial;
  const scripts: string[] = [];
  let startCalls = 0;

  const extractQuoted = (script: string, flag: string): string => {
    const match = new RegExp(`-${flag} '((?:[^']|'')*)'`).exec(script);
    return (match?.[1] ?? '').replace(/''/g, "'");
  };

  const run: PowerShellRunner = (script) => {
    scripts.push(script);
    if (script.includes('Register-ScheduledTask')) {
      registered = {
        execute: extractQuoted(script, 'Execute'),
        arguments: extractQuoted(script, 'Argument'),
        state: 'Ready',
      };
      return '';
    }
    if (script.includes('Unregister-ScheduledTask')) {
      registered = undefined;
      return '';
    }
    if (script.includes('Start-ScheduledTask')) {
      startCalls++;
      return '';
    }
    if (script.includes('Get-ScheduledTask')) {
      return registered
        ? JSON.stringify({ registered: true, ...registered })
        : '{"registered":false}';
    }
    throw new Error(`fake task scheduler: unrecognized script: ${script}`);
  };

  return { run, scripts, startCalls: () => startCalls, current: () => registered };
}

// --- resolveCctlShimPath ----------------------------------------------------------------------

describe('resolveCctlShimPath', () => {
  it('resolves to <prefix>\\cctl.cmd on Windows — npm places shims directly in the prefix', () => {
    const path = resolveCctlShimPath({
      platform: 'win32',
      npmPrefix: () => 'C:\\Users\\tester\\AppData\\Roaming\\npm',
    });
    expect(path).toBe(join('C:\\Users\\tester\\AppData\\Roaming\\npm', 'cctl.cmd'));
  });

  it('resolves to <prefix>/bin/cctl off Windows', () => {
    const path = resolveCctlShimPath({ platform: 'linux', npmPrefix: () => '/usr/local' });
    expect(path).toBe(join('/usr/local', 'bin', 'cctl'));
  });
});

// --- queryDaemonTask ---------------------------------------------------------------------------

describe('queryDaemonTask', () => {
  it('reports not registered as the normal first-run state, never throwing', () => {
    const { run } = fakeTaskScheduler(undefined);
    expect(queryDaemonTask(run)).toEqual({ registered: false });
  });

  it('reports the full registration when one exists', () => {
    const { run } = fakeTaskScheduler({
      execute: 'C:\\npm\\cctl.cmd',
      arguments: 'daemon run',
      state: 'Ready',
    });
    expect(queryDaemonTask(run)).toEqual({
      registered: true,
      execute: 'C:\\npm\\cctl.cmd',
      arguments: 'daemon run',
      state: 'Ready',
    });
  });

  it('queries the task by the exact name passed', () => {
    const { run, scripts } = fakeTaskScheduler(undefined);
    queryDaemonTask(run, 'SomeOtherTaskName');
    expect(scripts[0]).toContain("'SomeOtherTaskName'");
  });

  it('throws on output that is not valid JSON', () => {
    const run: PowerShellRunner = () => 'not json';
    expect(() => queryDaemonTask(run)).toThrow(/could not parse/);
  });
});

// --- installDaemonTask --------------------------------------------------------------------------

describe('installDaemonTask', () => {
  const shimPath = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\cctl.cmd';

  it('creates the task when none is registered', () => {
    const { run, current } = fakeTaskScheduler(undefined);
    const outcome = installDaemonTask({ shimPath, run });
    expect(outcome).toBe('created');
    expect(current()).toEqual({
      execute: shimPath,
      arguments: DAEMON_TASK_ARGUMENTS,
      state: 'Ready',
    });
  });

  it('the created task points at the resolved shim path with logon-triggered restart-on-failure settings', () => {
    const { run, scripts } = fakeTaskScheduler(undefined);
    installDaemonTask({ shimPath, run });
    const registerScript = scripts.find((s) => s.includes('Register-ScheduledTask'));
    expect(registerScript).toBeDefined();
    expect(registerScript).toContain(`-Execute '${shimPath}'`);
    expect(registerScript).toContain(`-Argument '${DAEMON_TASK_ARGUMENTS}'`);
    // The trigger must be scoped to the registering user: an un-scoped -AtLogOn is an
    // all-users trigger, and registering that needs elevation (Access is denied from a
    // normal shell).
    expect(registerScript).toContain(
      'New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)',
    );
    expect(registerScript).toContain('RestartCount');
    expect(registerScript).toContain('RestartInterval');
    expect(registerScript).toContain(`'${DAEMON_TASK_NAME}'`);
  });

  it('is a no-op (unchanged) when the registered action already matches — never blind-creates', () => {
    const { run, scripts } = fakeTaskScheduler({
      execute: shimPath,
      arguments: DAEMON_TASK_ARGUMENTS,
      state: 'Ready',
    });
    const outcome = installDaemonTask({ shimPath, run });
    expect(outcome).toBe('unchanged');
    // Only the query ran — no Register-ScheduledTask call for an already-correct task.
    expect(scripts).toHaveLength(1);
    expect(scripts[0]).toContain('Get-ScheduledTask');
  });

  it('updates the task when the registered shim path has drifted (e.g. npm reinstalled elsewhere)', () => {
    const { run, current } = fakeTaskScheduler({
      execute: 'C:\\old\\location\\cctl.cmd',
      arguments: DAEMON_TASK_ARGUMENTS,
      state: 'Ready',
    });
    const outcome = installDaemonTask({ shimPath, run });
    expect(outcome).toBe('updated');
    expect(current()?.execute).toBe(shimPath);
  });

  it('updates the task when the arguments have drifted, even if the path matches', () => {
    const { run } = fakeTaskScheduler({
      execute: shimPath,
      arguments: 'daemon run --something-old',
      state: 'Ready',
    });
    expect(installDaemonTask({ shimPath, run })).toBe('updated');
  });

  it('honors a custom task name end to end', () => {
    const { run, current } = fakeTaskScheduler(undefined);
    installDaemonTask({ shimPath, run, taskName: 'CustomName' });
    expect(current()).toBeDefined();
    expect(() => queryDaemonTask(run, 'CustomName')).not.toThrow();
  });
});

// --- uninstallDaemonTask ------------------------------------------------------------------------

describe('uninstallDaemonTask', () => {
  it('reports not_installed and makes no removal call when nothing is registered', () => {
    const { run, scripts } = fakeTaskScheduler(undefined);
    expect(uninstallDaemonTask(run)).toBe('not_installed');
    expect(scripts.some((s) => s.includes('Unregister-ScheduledTask'))).toBe(false);
  });

  it('removes an existing registration', () => {
    const { run, current } = fakeTaskScheduler({
      execute: 'C:\\npm\\cctl.cmd',
      arguments: DAEMON_TASK_ARGUMENTS,
      state: 'Ready',
    });
    expect(uninstallDaemonTask(run)).toBe('removed');
    expect(current()).toBeUndefined();
  });
});

// --- decodePowerShellStderr ---------------------------------------------------------------------

describe('decodePowerShellStderr', () => {
  it('extracts readable error lines from a CLIXML error stream', () => {
    // Trimmed from a real non-elevated Register-ScheduledTask failure.
    const clixml =
      '#< CLIXML\n' +
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<S S="Error">Register-ScheduledTask : Access is denied._x000D__x000A_</S>' +
      '<S S="Error">At line:6 char:1_x000D__x000A_</S>' +
      '<S S="Error">    + FullyQualifiedErrorId : HRESULT 0x80070005,Register-ScheduledTask_x000D__x000A_</S>' +
      '<S S="Error"> _x000D__x000A_</S>' +
      '</Objs>';
    const decoded = decodePowerShellStderr(clixml);
    expect(decoded).toContain('Register-ScheduledTask : Access is denied.');
    expect(decoded).toContain('HRESULT 0x80070005');
    expect(decoded).not.toContain('CLIXML');
    expect(decoded).not.toContain('_x000D_');
  });

  it('undoes XML entities in the error text', () => {
    const decoded = decodePowerShellStderr(
      '<S S="Error">path &apos;C:\\a &amp; b&apos; &lt;not found&gt;</S>',
    );
    expect(decoded).toBe("path 'C:\\a & b' <not found>");
  });

  it('passes non-CLIXML stderr through untouched', () => {
    expect(decodePowerShellStderr('  plain error text\n')).toBe('plain error text');
  });
});

// --- startDaemonTaskNow --------------------------------------------------------------------------

describe('startDaemonTaskNow', () => {
  it('asks Task Scheduler to run the named task immediately', () => {
    const { run, startCalls } = fakeTaskScheduler({
      execute: 'C:\\npm\\cctl.cmd',
      arguments: DAEMON_TASK_ARGUMENTS,
      state: 'Ready',
    });
    startDaemonTaskNow(run);
    expect(startCalls()).toBe(1);
  });

  it('propagates a failure (e.g. the task is already running) rather than swallowing it', () => {
    const run: PowerShellRunner = () => {
      throw new Error('start failed');
    };
    expect(() => startDaemonTaskNow(run)).toThrow('start failed');
  });
});
