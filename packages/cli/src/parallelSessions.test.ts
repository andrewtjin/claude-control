// The CLI's pure pieces of parallel sessions (`cctl claude --account`): the older-build fence (the
// daemon's report row, the installs that would next touch the vault), the arguments a parallel
// session cannot run, the child-holder retry, the held signals, the background-worker probe, and
// the doctor's checks.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FolderRule, LeaseHolder, LeaseView } from '@claude-control/switch-engine';
import {
  SESSION_LEASES_REPORT_ROW,
  FOLDER_RULES_SUPPORTED,
  olderDaemonScopeReason,
  olderInstallReason,
  reportSupportsScope,
  type InstallLookup,
} from './folderRulesSupport.js';
import { resolveDaemonConfig, type SettingsReport } from './settings.js';
import { leaseArgRefusal, startsBackgroundSession } from './backgroundAttach.js';
import { holdLeaseSignals, terminalsOf, trackChildHolder } from './leaseCli.js';
import { createLeaseOccupancyProbe } from './leaseProbe.js';
import { cctlVersionOf, findCctlOnPath } from './installLookup.js';
import { checkDaemonScopeSupport, checkRuleScopes, checkSessionLeases } from './doctor.js';

const report = (rows: { name: string; value: string }[]): SettingsReport => ({
  startedAtMs: 1,
  settings: rows.map((r) => ({ ...r, source: 'default' as const })),
});
const alive = { state: 'alive', writtenAtMs: 1, ageMs: 1 } as const;
const older = report([{ name: 'daemon build', value: 'v1.0.0' }]);
const current = report([{ name: SESSION_LEASES_REPORT_ROW, value: FOLDER_RULES_SUPPORTED }]);

describe('the daemon fence', () => {
  it('a daemon of this build writes the row the refusal reads', () => {
    const settings = resolveDaemonConfig({}).rows;
    expect(reportSupportsScope({ startedAtMs: 1, settings }, 'lease')).toBe(true);
  });

  it('names an older live daemon, its build and the fix', () => {
    expect(olderDaemonScopeReason('lease', older, alive)).toBe(
      'the running daemon (v1.0.0) predates parallel sessions: it cannot read a rules file that ' +
        'holds one, and would stop maintaining every slot until restarted on this build. Restart it ' +
        'first: cctl daemon restart',
    );
  });

  it('has nothing to say about a daemon with the row, or none running', () => {
    expect(olderDaemonScopeReason('lease', current, alive)).toBeUndefined();
    expect(olderDaemonScopeReason('lease', older, { state: 'never' })).toBeUndefined();
  });

  it('treats a live daemon with no readable report as older', () => {
    expect(olderDaemonScopeReason('lease', undefined, alive)).toContain(
      'predates parallel sessions',
    );
  });
});

describe('the install fence', () => {
  /** An install lookup with fixed answers; records whether the autostart was asked. */
  function lookup(
    over: Partial<{ onPath: string; auto: { noun: string; execute: string } }>,
    versions: Record<string, string>,
  ) {
    let askedAutostart = false;
    const l: InstallLookup = {
      onPath: () => over.onPath,
      autostart: () => {
        askedAutostart = true;
        return over.auto;
      },
      versionOf: (p) => versions[p],
    };
    return { l, asked: () => askedAutostart };
  }

  it('an older cctl on PATH refuses, naming it', () => {
    const { l } = lookup({ onPath: 'C:/npm/cctl.cmd' }, { 'C:/npm/cctl.cmd': '1.0.0' });
    expect(olderInstallReason({ cliBuild: '1.1.0', daemonAlive: true }, l)).toBe(
      'the cctl at C:/npm/cctl.cmd (v1.0.0) predates parallel sessions: while one runs it cannot ' +
        'read the rules file, so every command it runs (including claude through the shell wrapper) ' +
        'would fail. Update that install first (npm i -g @andrewtjin/cctl)',
    );
  });

  it('with no daemon alive, an older install the autostart starts refuses', () => {
    const { l } = lookup(
      { auto: { noun: 'logon task', execute: 'C:/old/cctl.cmd' } },
      { 'C:/old/cctl.cmd': '0.5.2' },
    );
    expect(olderInstallReason({ cliBuild: '1.1.0', daemonAlive: false }, l)).toContain(
      'the logon task starts the cctl at C:/old/cctl.cmd (v0.5.2), which predates parallel sessions',
    );
  });

  it('a daemon alive skips the autostart query', () => {
    const { l, asked } = lookup(
      { auto: { noun: 'logon task', execute: 'C:/old/cctl.cmd' } },
      { 'C:/old/cctl.cmd': '0.5.2' },
    );
    expect(olderInstallReason({ cliBuild: '1.1.0', daemonAlive: true }, l)).toBeUndefined();
    expect(asked()).toBe(false);
  });

  it('a version that cannot be read refuses nothing; the same or a newer version neither', () => {
    expect(
      olderInstallReason({ cliBuild: '1.1.0', daemonAlive: true }, lookup({ onPath: 'x' }, {}).l),
    ).toBeUndefined();
    expect(
      olderInstallReason(
        { cliBuild: '1.1.0', daemonAlive: true },
        lookup({ onPath: 'x' }, { x: '1.1.0' }).l,
      ),
    ).toBeUndefined();
    expect(
      olderInstallReason(
        { cliBuild: '1.1.0', daemonAlive: true },
        lookup({ onPath: 'x' }, { x: '1.2.0' }).l,
      ),
    ).toBeUndefined();
  });
});

describe('finding the installs', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  it('finds the first cctl on PATH and reads the version of the package beside its shim', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cctl-install-'));
    dirs.push(root);
    const first = join(root, 'a');
    const second = join(root, 'b');
    await mkdir(join(first, 'node_modules', '@andrewtjin', 'cctl'), { recursive: true });
    await mkdir(second, { recursive: true });
    const shim = process.platform === 'win32' ? 'cctl.cmd' : 'cctl';
    await writeFile(join(first, shim), 'shim');
    await writeFile(join(second, shim), 'shim');
    await writeFile(
      join(first, 'node_modules', '@andrewtjin', 'cctl', 'package.json'),
      JSON.stringify({ name: '@andrewtjin/cctl', version: '1.0.0' }),
    );
    const path = [join(root, 'missing'), first, second].join(
      process.platform === 'win32' ? ';' : ':',
    );
    const found = findCctlOnPath({ PATH: path });
    expect(found).toBe(join(first, shim));
    expect(cctlVersionOf(found!)).toBe('1.0.0');
    expect(cctlVersionOf(join(second, shim))).toBeUndefined();
  });

  it('reads the version of an entry script from the package above it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cctl-install-'));
    dirs.push(root);
    const pkg = join(root, 'node_modules', '@andrewtjin', 'cctl');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@andrewtjin/cctl', version: '0.5.2' }),
    );
    await writeFile(join(pkg, 'dist', 'bin.js'), '');
    expect(cctlVersionOf(join(pkg, 'dist', 'bin.js'))).toBe('0.5.2');
  });
});

describe('arguments a parallel session cannot run', () => {
  const refused = (args: string[]): string | undefined => leaseArgRefusal(args, 'work');

  it('refuses a new background session, the background verbs and every other subcommand', () => {
    expect(refused(['--bg'])).toContain('"--bg" starts a background session that outlives it');
    expect(refused(['--background', 'x'])).toContain('cctl session include <name> work');
    for (const verb of ['attach', 'stop', 'rm', 'kill', 'respawn']) {
      expect(refused([verb, 'abc12345'])).toBe(
        `"${verb}" opens a background session, which runs on the account its service holds; ` +
          '--account cannot choose one for it. Run it without --account.',
      );
    }
    expect(refused(['auth', 'login'])).toBe(
      '"claude auth" is not a session; run it without --account.',
    );
    expect(refused(['setup-token'])).toBe(
      '"claude setup-token" is not a session; run it without --account.',
    );
    expect(refused(['mcp', 'list'])).toBe(
      '"claude mcp" is not a session; run it without --account.',
    );
  });

  it('allows sessions: a resume, a continue, a print run, a prompt, an unknown option before a resume', () => {
    for (const args of [
      ['--resume', 'x'],
      ['-c'],
      ['-p', 'hi'],
      ['fix the build'],
      ['--new-cc-flag', '--resume', 'x'],
    ]) {
      expect(refused(args)).toBeUndefined();
    }
  });

  it('a verb run first is the verb, not a new background session', () => {
    expect(startsBackgroundSession(['--bg', 'x'])).toBe(true);
    expect(startsBackgroundSession(['attach', 'abc12345', '--bg'])).toBe(false);
  });
});

describe("recording a parallel session's Claude Code", () => {
  const holder = (pid: number): LeaseHolder => ({
    pid,
    start: 1,
    host: 'h',
    platform: 'win32',
    role: 'claude',
    parent: 7,
  });

  it('retries a failed record while the child runs, warning once, and stops when it exits', async () => {
    const said: string[] = [];
    const slept: number[] = [];
    let wake: (() => void) | undefined;
    let attempts = 0;
    const t = trackChildHolder({
      add: () => {
        attempts += 1;
        return Promise.reject(new Error('lock busy'));
      },
      say: (l) => said.push(l),
      label: 'work',
      holderOf: holder,
      sleep: (ms, w) => {
        slept.push(ms);
        // The first three waits pass at once; the fourth waits until the child exits.
        if (slept.length < 4) return Promise.resolve();
        return new Promise<void>((resolve) => {
          wake = resolve;
          w.on(resolve);
        });
      },
    });
    t.record(4242);
    await new Promise((r) => setTimeout(r, 20));
    expect(slept).toEqual([1000, 2000, 4000, 15000]);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain(
      "could not record this session's Claude Code process yet (lock busy)",
    );
    expect(wake).toBeDefined();
    t.stop();
    await t.settled();
    expect(attempts).toBe(4);
    expect(t.holders()).toEqual([holder(4242)]);
  });

  it('a record that lands is awaited by settled', async () => {
    const added: LeaseHolder[][] = [];
    const t = trackChildHolder({
      add: (h) => {
        added.push(h);
        return Promise.resolve();
      },
      say: () => {},
      label: 'work',
      holderOf: holder,
    });
    t.record(5);
    t.stop();
    await t.settled();
    expect(added).toEqual([[holder(5)]]);
  });
});

describe('holding signals around a parallel session', () => {
  it('holds Ctrl-C, Ctrl-Break and a closing console on Windows, and lets them go once', () => {
    const on: string[] = [];
    const off: string[] = [];
    const seam = { on: (s: string) => void on.push(s), off: (s: string) => void off.push(s) };
    const held = holdLeaseSignals(seam, 'win32');
    expect(on).toEqual(['SIGINT', 'SIGBREAK', 'SIGHUP']);
    held.release();
    held.release();
    expect(off).toEqual(['SIGINT', 'SIGBREAK', 'SIGHUP']);
  });

  it('holds only Ctrl-C on Linux', () => {
    const on: string[] = [];
    holdLeaseSignals({ on: (s) => void on.push(s), off: () => {} }, 'linux').release();
    expect(on).toEqual(['SIGINT']);
  });

  it('counts terminals by their launchers', () => {
    expect(terminalsOf([{ role: 'launcher' }, { role: 'claude' }, { role: 'launcher' }])).toBe(2);
    expect(terminalsOf([{ role: 'background' }])).toBe(1);
  });
});

describe('the background-worker probe', () => {
  it('turns roster workers into background holders, their recorded start read as epoch ms', async () => {
    const ms = Date.UTC(2026, 9, 1);
    const ft = (BigInt(ms) * 10_000n + 116_444_736_000_000_000n).toString();
    const probe = createLeaseOccupancyProbe(
      {
        hostedWorkerProcesses: () => Promise.resolve([{ pid: 6000, procStart: ft }, { pid: 6001 }]),
      },
      { platform: 'win32', hostname: () => 'BOX' },
    );
    expect(await probe('C:/p', { verify: false })).toEqual([
      { pid: 6000, start: ms, host: 'BOX', platform: 'win32', role: 'background' },
      { pid: 6001, start: 0, host: 'BOX', platform: 'win32', role: 'background' },
    ]);
  });

  it('a roster that cannot be read answers unreadable, never nothing hosted', async () => {
    const probe = createLeaseOccupancyProbe(
      { hostedWorkerProcesses: () => Promise.reject(new Error('mid-write')) },
      { platform: 'win32' },
    );
    expect(await probe('C:/p', { verify: true })).toBe('unreadable');
  });
});

describe('doctor and parallel sessions', () => {
  const leaseRule: FolderRule = {
    id: 'session-w',
    label: 'W',
    folders: [],
    include: ['w'],
    exclude: [],
    activeId: 'w',
    createdAtMs: 0,
    updatedAtMs: 0,
    lease: {
      holders: [{ pid: 1, start: 1, host: 'h', platform: 'win32', role: 'launcher' }],
      startedAtMs: 0,
    },
  };
  const view = (holders: LeaseView['holders'], over: Partial<LeaseView> = {}): LeaseView => ({
    ruleId: 'session-w',
    accountId: 'w',
    label: 'W',
    profileDir: 'C:/profiles/session-w',
    startedAtMs: 0,
    holders,
    ...over,
  });
  const h = (pid: number, state: LeaseView['holders'][number]['state'], extra = {}) => ({
    pid,
    start: 1,
    host: 'h',
    platform: 'win32' as const,
    role: 'launcher' as const,
    state,
    ...extra,
  });

  it('a parallel session is no rule that applies to nothing', () => {
    expect(checkRuleScopes([leaseRule]).ok).toBe(true);
  });

  it('daemon-parallel-sessions fails on an older daemon or an older install while one exists', () => {
    expect(checkDaemonScopeSupport('lease', older, alive, true)).toMatchObject({
      name: 'daemon-parallel-sessions',
      ok: false,
    });
    expect(
      checkDaemonScopeSupport('lease', current, alive, true, 'the cctl at x (v1.0.0) predates'),
    ).toMatchObject({
      ok: false,
      detail: 'the cctl at x (v1.0.0) predates',
    });
    expect(checkDaemonScopeSupport('lease', older, alive, false)).toMatchObject({
      ok: true,
      detail: 'no parallel session to check',
    });
    expect(checkDaemonScopeSupport('lease', current, alive, true)).toMatchObject({ ok: true });
  });

  it('passes with none, or with each held by a running process', () => {
    expect(checkSessionLeases([])).toMatchObject({ ok: true, detail: 'no parallel sessions' });
    expect(checkSessionLeases([view([h(1, 'alive')]), view([h(2, 'unverifiable')])])).toMatchObject(
      {
        ok: true,
        detail: '2 parallel session(s), each held by a running process',
      },
    );
  });

  it('names exited holders, and a pid another program now has', () => {
    const c = checkSessionLeases([view([h(4120, 'dead', { reused: true }), h(4188, 'dead')])]);
    expect(c.ok).toBe(false);
    expect(c.detail).toBe(
      'the parallel session of W is held only by exited processes (pids 4120, 4188; 4120 is now ' +
        'another program). The running daemon frees it within one poll; with no daemon running, the ' +
        'next cctl switch W or cctl claude --account W checks those processes and frees it.',
    );
  });

  it('names holders this machine cannot check', () => {
    const c = checkSessionLeases([view([{ ...h(812, 'foreign'), platform: 'linux' }])]);
    expect(c.detail).toContain(
      'the parallel session of W is held by processes this machine cannot check (pid 812 on linux',
    );
  });

  it('names an unreadable roster and an unsettled slot', () => {
    const roster = checkSessionLeases(
      [view([h(1, 'dead')])],
      new Map([['session-w', { rosterUnreadable: 'C:/profiles/session-w/daemon/roster.json' }]]),
    );
    expect(roster.detail).toContain(
      'the background-session roster of its profile could not be read (C:/profiles/session-w/daemon/roster.json)',
    );
    const untrusted = checkSessionLeases(
      [view([h(1, 'dead')])],
      new Map([['session-w', { untrusted: 'a file is held open' }]]),
    );
    expect(untrusted.detail).toContain(
      'its slot has an unfinished change that cannot be settled (a file is held open), and clearing it could lose its latest login',
    );
  });

  it('names a process found running on the profile', () => {
    const c = checkSessionLeases([view([h(1, 'dead')], { unrecorded: [9001] })]);
    expect(c.detail).toContain('process(es) 9001 run on its profile');
  });
});
