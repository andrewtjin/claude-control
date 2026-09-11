import { describe, expect, it } from 'vitest';
import {
  DaemonControlError,
  renderRestartOutcome,
  renderStartOutcome,
  renderStopOutcome,
  restartDaemon,
  startDaemon,
  stopDaemon,
  type DaemonControlDeps,
  type StartOutcome,
} from './daemonControl.js';
import type { SettingsReport } from './settings.js';
import { ANSI_PALETTE } from './ansi.js';

const ESC = String.fromCharCode(27);

/** A scripted daemon world: which pids are alive, what the endpoint answers, what the report
 *  says, and a call log. Time is a counter the sleep advances, so timeouts are exact. */
interface World {
  deps: DaemonControlDeps;
  calls: string[];
  alive: Set<number>;
  report: SettingsReport | undefined;
}

type Answer = { status: number; body?: unknown } | { throws: string } | { hang: true };

function world(
  options: {
    lockPid?: number;
    endpointPort?: number;
    secret?: string | undefined;
    answer?: Answer;
    /** What the stop route does to the alive set when it answers 200 (a real daemon exits). */
    exitsOnAck?: boolean;
    autostart?: { supported: boolean; registered?: boolean };
    /** How many queries report the task instance still Running before it reads Ready. */
    taskRunningPolls?: number;
    startFails?: string;
    /** The report a started daemon publishes; `undefined` = it never reports. */
    reportOnStart?: SettingsReport | undefined;
    /** The started daemon writes its report and then exits before serving. */
    diesAfterReport?: boolean;
    /** How many probes answer dead before the started daemon's endpoint serves. */
    servesAfterProbes?: number;
    timeoutMs?: number;
  } = {},
): World {
  const calls: string[] = [];
  const alive = new Set<number>(options.lockPid !== undefined ? [options.lockPid] : []);
  let now = 1_000;
  let runningLeft = options.taskRunningPolls ?? 0;
  let deadProbesLeft = options.servesAfterProbes ?? 0;
  /** The daemon a start brought up: pid 90 on port 6000, once it has "started". */
  let started: { pid: number; port: number } | undefined;
  const w: World = { calls, alive, report: undefined, deps: undefined as never };
  const answer: Answer = options.answer ?? {
    status: 200,
    body: { ok: true, pid: options.lockPid },
  };
  const startNew = (): void => {
    w.report = options.reportOnStart;
    if (options.reportOnStart === undefined) return;
    started = { pid: 90, port: 6000 };
    if (!options.diesAfterReport) alive.add(90);
  };
  w.deps = {
    loadSecret: () => Promise.resolve('secret' in options ? options.secret : 's3cret'),
    readEndpoint: () =>
      Promise.resolve(
        started
          ? { port: started.port }
          : options.endpointPort !== undefined
            ? { port: options.endpointPort }
            : undefined,
      ),
    probeEndpoint: (port) => {
      calls.push(`probe ${port}`);
      if (deadProbesLeft > 0) {
        deadProbesLeft -= 1;
        return Promise.resolve('dead');
      }
      return Promise.resolve(
        started && port === started.port && alive.has(started.pid) ? 'serving' : 'dead',
      );
    },
    readLiveLock: () => {
      if (options.lockPid !== undefined && alive.has(options.lockPid)) {
        return Promise.resolve({ pid: options.lockPid, startedAt: '2026-01-01T00:00:00.000Z' });
      }
      if (started && alive.has(started.pid)) {
        return Promise.resolve({ pid: started.pid, startedAt: '2026-01-01T00:00:01.000Z' });
      }
      return Promise.resolve(undefined);
    },
    isPidAlive: (pid) => alive.has(pid),
    kill: (pid) => {
      calls.push(`kill ${pid}`);
      alive.delete(pid);
    },
    fetch: ((url: string, init?: RequestInit) => {
      calls.push(
        `POST ${url} secret=${String((init?.headers as Record<string, string>)['x-claude-control-secret'])}`,
      );
      if ('throws' in answer) return Promise.reject(new Error(answer.throws));
      if ('hang' in answer) {
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      if (answer.status === 200 && options.exitsOnAck !== false) {
        const pid = (answer.body as { pid?: number } | undefined)?.pid;
        if (pid !== undefined) alive.delete(pid);
      }
      return Promise.resolve({
        ok: answer.status >= 200 && answer.status < 300,
        status: answer.status,
        json: () => Promise.resolve(answer.body),
      } as Response);
    }) as typeof fetch,
    queryAutostart: () => {
      calls.push('autostart.query');
      const a = options.autostart ?? { supported: true, registered: true };
      if (!a.supported) return { supported: false };
      const state = runningLeft > 0 ? 'Running' : 'Ready';
      if (runningLeft > 0) runningLeft -= 1;
      return { supported: true, registered: a.registered ?? false, state };
    },
    startAutostart: () => {
      calls.push('autostart.start');
      if (options.startFails) throw new Error(options.startFails);
      startNew();
    },
    spawnDetached: () => {
      calls.push('spawn');
      startNew();
    },
    readReport: () => Promise.resolve(w.report),
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
    timeoutMs: options.timeoutMs ?? 2_000,
    requestTimeoutMs: 500,
  };
  return w;
}

const report = (startedAtMs: number, extra: SettingsReport['settings'] = []): SettingsReport => ({
  startedAtMs,
  settings: [
    { name: 'daemon build', value: 'v0.4.6', source: 'default', detail: null },
    { name: 'auto-switch', value: 'on', source: 'default', detail: null },
    ...extra,
  ],
});

describe('stopDaemon', () => {
  it('asks the daemon over its endpoint and returns once the acknowledged pid is gone', async () => {
    const w = world({ lockPid: 41, endpointPort: 5000 });
    await expect(stopDaemon(w.deps)).resolves.toEqual({
      outcome: 'stopped',
      how: 'graceful',
      pid: 41,
    });
    expect(w.calls).toEqual(['POST http://127.0.0.1:5000/cli/daemon/stop secret=s3cret']);
  });

  it('watches the pid the daemon reported, not the lock, when they disagree', async () => {
    // A daemon started before the lock existed leaves no lock; the route still names it.
    const w = world({ endpointPort: 5000, answer: { status: 200, body: { ok: true, pid: 77 } } });
    w.alive.add(77);
    await expect(stopDaemon(w.deps)).resolves.toEqual({
      outcome: 'stopped',
      how: 'graceful',
      pid: 77,
    });
    expect(w.calls).not.toContainEqual(expect.stringMatching(/^kill/));
  });

  it('terminates the locked pid when a live daemon has no stop route (older build)', async () => {
    const w = world({
      lockPid: 41,
      endpointPort: 5000,
      answer: { status: 404, body: { ok: false } },
    });
    await expect(stopDaemon(w.deps)).resolves.toEqual({
      outcome: 'stopped',
      how: 'terminated',
      pid: 41,
    });
    expect(w.calls).toEqual([
      'POST http://127.0.0.1:5000/cli/daemon/stop secret=s3cret',
      'kill 41',
    ]);
  });

  it('terminates the locked pid when the daemon accepts the request but never answers', async () => {
    const w = world({ lockPid: 41, endpointPort: 5000, answer: { hang: true } });
    await expect(stopDaemon(w.deps)).resolves.toEqual({
      outcome: 'stopped',
      how: 'terminated',
      pid: 41,
    });
    expect(w.calls).toContain('kill 41');
  });

  it('never kills on a stale endpoint: a live locked pid nobody answers for is reported, not shot', async () => {
    // After a crash the lock can name a pid the OS handed to an unrelated process.
    const w = world({ lockPid: 41, endpointPort: 5000, answer: { throws: 'ECONNREFUSED' } });
    await expect(stopDaemon(w.deps)).rejects.toThrow(
      /a daemon \(pid 41\) holds the instance lock but nothing answers on its endpoint; it may still be starting up/,
    );
    expect(w.calls).not.toContain('kill 41');
  });

  it('names the port when an older, lockless daemon answers but cannot be asked', async () => {
    const w = world({ endpointPort: 5000, answer: { status: 404, body: { ok: false } } });
    await expect(stopDaemon(w.deps)).rejects.toThrow(
      /a daemon answers on 127\.0\.0\.1:5000 but cannot be asked to stop \(an older build\) and records no pid/,
    );
    expect(w.calls).not.toContainEqual(expect.stringMatching(/^kill/));
  });

  it('says so when a locked daemon has published no endpoint yet', async () => {
    const w = world({ lockPid: 41 });
    await expect(stopDaemon(w.deps)).rejects.toThrow(/\(none is published\)/);
    expect(w.calls).toEqual([]);
  });

  it('reports not running when there is neither a live lock nor an answering endpoint', async () => {
    await expect(stopDaemon(world().deps)).resolves.toEqual({ outcome: 'not_running' });
    const stale = world({ endpointPort: 5000, answer: { throws: 'ECONNREFUSED' } });
    await expect(stopDaemon(stale.deps)).resolves.toEqual({ outcome: 'not_running' });
  });

  it('falls back to the pid when the secret is missing, only if the daemon is provably there', async () => {
    // No secret → the route cannot be asked → nothing proves a daemon is behind the endpoint.
    const w = world({ lockPid: 41, endpointPort: 5000, secret: undefined });
    await expect(stopDaemon(w.deps)).rejects.toThrow(DaemonControlError);
    expect(w.calls).toEqual([]);
  });

  it('gives up honestly when an acknowledged daemon keeps running past the timeout', async () => {
    const w = world({ lockPid: 41, endpointPort: 5000, exitsOnAck: false, timeoutMs: 1_000 });
    await expect(stopDaemon(w.deps)).rejects.toThrow(
      /the daemon \(pid 41\) acknowledged the stop but is still running/,
    );
    expect(w.calls).not.toContain('kill 41');
  });
});

describe('startDaemon', () => {
  it('starts through the logon registration and returns the fresh report once it serves', async () => {
    const w = world({ reportOnStart: report(1_000) });
    const out = await startDaemon(w.deps);
    expect(out).toEqual({ outcome: 'started', how: 'autostart', report: report(1_000) });
    expect(w.calls).toEqual(['autostart.query', 'autostart.start', 'probe 6000']);
  });

  it('waits for the task instance to be over before starting through it', async () => {
    // The scheduler still counts a terminated instance as Running for a moment; a start
    // issued then is ignored without an error (MultipleInstances IgnoreNew).
    const w = world({ reportOnStart: report(1_000), taskRunningPolls: 2 });
    expect((await startDaemon(w.deps)).outcome).toBe('started');
    expect(w.calls.slice(0, 4)).toEqual([
      'autostart.query',
      'autostart.query',
      'autostart.query',
      'autostart.start',
    ]);
  });

  it('gives up when the task instance never ends, naming the task', async () => {
    const w = world({ reportOnStart: report(1_000), taskRunningPolls: 1_000, timeoutMs: 1_000 });
    await expect(startDaemon(w.deps)).rejects.toThrow(
      /the logon task still shows its previous instance as running/,
    );
    expect(w.calls).not.toContain('autostart.start');
  });

  it('spawns a detached daemon run when nothing is registered, or on a platform without autostart', async () => {
    const unregistered = world({
      autostart: { supported: true, registered: false },
      reportOnStart: report(1_000),
    });
    expect((await startDaemon(unregistered.deps)).outcome).toBe('started');
    expect(unregistered.calls).toEqual(['autostart.query', 'spawn', 'probe 6000']);
    const linux = world({ autostart: { supported: false }, reportOnStart: report(1_000) });
    const out = await startDaemon(linux.deps);
    expect(out.outcome === 'started' && out.how).toBe('background');
    expect(linux.calls).toEqual(['autostart.query', 'spawn', 'probe 6000']);
  });

  it('counts the daemon as up only once its endpoint answers, not on the report alone', async () => {
    // After a terminated stop the old endpoint file lingers and its port is dead until the
    // new daemon listens and rewrites it.
    const w = world({ reportOnStart: report(1_000), servesAfterProbes: 3 });
    expect((await startDaemon(w.deps)).outcome).toBe('started');
    expect(w.calls.filter((c) => c.startsWith('probe'))).toHaveLength(4);
  });

  it('does not announce a daemon that wrote its report and then died before serving', async () => {
    const w = world({ reportOnStart: report(1_000), diesAfterReport: true });
    await expect(startDaemon(w.deps)).rejects.toThrow(
      /the daemon started but is no longer running; check daemon-crash.log/,
    );
  });

  it('refuses to count the previous daemon’s report as the new one', async () => {
    // The stopped daemon's report predates the start; the new one never lands.
    const w = world({ reportOnStart: report(999), timeoutMs: 1_000 });
    await expect(startDaemon(w.deps)).rejects.toThrow(
      /started through its logon registration but is not serving yet/,
    );
    const bg = world({
      autostart: { supported: false },
      reportOnStart: undefined,
      timeoutMs: 1_000,
    });
    await expect(startDaemon(bg.deps)).rejects.toThrow(
      /started in the background but is not serving yet/,
    );
  });

  it('reports an already-running daemon as an outcome, starting nothing', async () => {
    const w = world({ lockPid: 41 });
    await expect(startDaemon(w.deps)).resolves.toEqual({ outcome: 'already_running', pid: 41 });
    expect(w.calls).toEqual([]);
  });

  it('phrases a backend failure to start as the registration, not a stack trace', async () => {
    const w = world({ startFails: 'Start-ScheduledTask : No such task' });
    await expect(startDaemon(w.deps)).rejects.toThrow(
      'could not start the daemon through its logon registration: Start-ScheduledTask : No such task',
    );
  });
});

describe('restartDaemon', () => {
  it('stops, then starts, and returns both outcomes', async () => {
    const w = world({ lockPid: 41, endpointPort: 5000, reportOnStart: report(1_200) });
    const out = await restartDaemon(w.deps);
    expect(out.stop).toEqual({ outcome: 'stopped', how: 'graceful', pid: 41 });
    expect(out.start).toEqual({ outcome: 'started', how: 'autostart', report: report(1_200) });
    expect(w.calls).toEqual([
      'POST http://127.0.0.1:5000/cli/daemon/stop secret=s3cret',
      'autostart.query',
      'autostart.start',
      'probe 6000',
    ]);
  });

  it('is a plain start when nothing was running', async () => {
    const w = world({ reportOnStart: report(1_000) });
    const out = await restartDaemon(w.deps);
    expect(out.stop).toEqual({ outcome: 'not_running' });
    expect(out.start.outcome).toBe('started');
  });
});

describe('rendering', () => {
  const started: StartOutcome = {
    outcome: 'started',
    how: 'autostart',
    report: report(1, [
      { name: 'fable cap trigger', value: 'off', source: 'config', detail: null },
    ]),
  };

  it('names the outcome, the pid, the route, the build, and what config.json supplied', () => {
    expect(renderStopOutcome({ outcome: 'not_running' })).toBe('No daemon is running.\n');
    expect(renderStopOutcome({ outcome: 'stopped', how: 'graceful', pid: 41 })).toBe(
      'Stopped the daemon (pid 41).\n',
    );
    expect(renderStopOutcome({ outcome: 'stopped', how: 'terminated', pid: 41 })).toBe(
      'Terminated the daemon (pid 41): it was running but could not be asked to stop (an older ' +
        'build, or it had stopped answering).\n',
    );
    expect(renderStartOutcome(started, 'logon task')).toBe(
      'Started the daemon via the logon task (build v0.4.6).\n' +
        'Settings from config.json: fable cap trigger off.\n',
    );
    expect(
      renderStartOutcome({ ...started, how: 'background', report: report(1) }, 'logon task'),
    ).toBe(
      'Started the daemon in the background (build v0.4.6).\nSettings from config.json: none.\n',
    );
    expect(renderStartOutcome({ outcome: 'already_running', pid: 9 }, 'LaunchAgent')).toBe(
      'The daemon is already running (pid 9).\n',
    );
    expect(
      renderRestartOutcome(
        { stop: { outcome: 'stopped', how: 'graceful', pid: 41 }, start: started },
        'logon task',
      ),
    ).toBe(
      'Stopped the daemon (pid 41).\nStarted the daemon via the logon task (build v0.4.6).\n' +
        'Settings from config.json: fable cap trigger off.\n',
    );
  });

  it('paints only the outcome words on a terminal', () => {
    expect(renderStopOutcome({ outcome: 'stopped', how: 'graceful', pid: 41 }, ANSI_PALETTE)).toBe(
      `${ESC}[32mStopped the daemon${ESC}[0m (pid 41).\n`,
    );
    expect(
      renderStopOutcome({ outcome: 'stopped', how: 'terminated', pid: 41 }, ANSI_PALETTE),
    ).toContain(`${ESC}[33mTerminated the daemon${ESC}[0m (pid 41)`);
    expect(renderStartOutcome(started, 'logon task', ANSI_PALETTE)).toContain(
      `${ESC}[32mStarted the daemon${ESC}[0m via the logon task`,
    );
  });
});
