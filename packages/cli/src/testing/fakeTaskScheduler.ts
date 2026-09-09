// Test-only: an in-memory Task Scheduler. Interprets the exact PowerShell verbs
// daemonInstall.ts emits (Get/Register/Unregister/Start-ScheduledTask) against in-memory state,
// so the check-then-update decisions and the exact invocation shape of every backend built on
// those scripts (the native Windows task, the WSL task) are provable without a real Task
// Scheduler. Shared by their test files; never imported by production code.

import type { PowerShellRunner } from '../daemonInstall.js';

export interface FakeRegistration {
  execute: string;
  arguments: string;
  state: string;
  description?: string;
}

export function fakeTaskScheduler(initial?: FakeRegistration) {
  let registered: FakeRegistration | undefined = initial;
  const scripts: string[] = [];
  let startCalls = 0;

  // Reads the value of a `-Flag '...'` parameter, undoing PowerShell's `''` escape.
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
        description: extractQuoted(script, 'Description'),
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
      if (registered === undefined) return '{"registered":false}';
      const { description: _description, ...visible } = registered;
      return JSON.stringify({ registered: true, ...visible });
    }
    throw new Error(`fake task scheduler: unrecognized script: ${script}`);
  };

  return { run, scripts, startCalls: () => startCalls, current: () => registered };
}
