// The CLI's pure pieces of parallel sessions (`cctl claude --account`): the older-build fence (the
// daemon's report row, the installs that would next touch the vault), the arguments a parallel
// session cannot run, the child-holder retry, the held signals, the background-worker probe, and
// the doctor's checks.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FolderRule, LeaseHolder, LeaseView, ProcFs } from '@claude-control/switch-engine';
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
import { holdLeaseSignals, leaseInUse, trackChildHolder } from './leaseCli.js';
import { createLeaseOccupancyProbe } from './leaseProbe.js';
import { cctlVersionOf, findCctlOnPath, wrapperEntriesOf } from './installLookup.js';
import { POWERSHELL_WRAPPER_MARKER, readPowerShellWrappers, renderShellInit } from './shellInit.js';
import {
  checkDaemonScopeSupport,
  checkRuleScopes,
  checkSessionLeases,
  gatherSessionLeases,
} from './doctor.js';
import { renderSetupSummary } from './setup.js';
import { queryWslDaemonTask, wslTaskAction } from './wslInstall.js';
import { queryDaemonUnit, renderDaemonUnit } from './systemdInstall.js';

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
    over: Partial<{ onPath: string; wrapper: string; auto: { noun: string; execute: string } }>,
    versions: Record<string, string>,
  ) {
    let askedAutostart = false;
    const l: InstallLookup = {
      onPath: () => over.onPath,
      wrapperEntries: () => (over.wrapper === undefined ? [] : [over.wrapper]),
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
    expect(olderInstallReason(l)).toBe(
      'the cctl at C:/npm/cctl.cmd (v1.0.0) predates parallel sessions: while one runs it cannot ' +
        'read the rules file, so every command it runs would fail. Update that install first ' +
        '(npm i -g @andrewtjin/cctl)',
    );
  });

  it('an older install the autostart starts refuses', () => {
    const { l } = lookup(
      { auto: { noun: 'logon task', execute: 'C:/old/cctl.cmd' } },
      { 'C:/old/cctl.cmd': '0.5.2' },
    );
    expect(olderInstallReason(l)).toContain(
      'the logon task starts the cctl at C:/old/cctl.cmd (v0.5.2), which predates parallel sessions',
    );
  });

  it('the autostart is asked even while a daemon runs: the next logon starts what it names', () => {
    const { l, asked } = lookup(
      { auto: { noun: 'logon task', execute: 'C:/old/cctl.cmd' } },
      { 'C:/old/cctl.cmd': '0.5.2' },
    );
    expect(olderInstallReason(l)).toContain('C:/old/cctl.cmd (v0.5.2)');
    expect(asked()).toBe(true);
  });

  it('an older cctl the PowerShell wrapper runs refuses, though PATH has a newer one', () => {
    const { l } = lookup(
      { onPath: 'C:/new/cctl.cmd', wrapper: 'C:/old/node_modules/@andrewtjin/cctl/dist/bin.js' },
      { 'C:/new/cctl.cmd': '1.1.0', 'C:/old/node_modules/@andrewtjin/cctl/dist/bin.js': '1.0.0' },
    );
    expect(olderInstallReason(l)).toContain(
      'the PowerShell claude wrapper runs the cctl at C:/old/node_modules/@andrewtjin/cctl/dist/bin.js (v1.0.0)',
    );
  });

  it('an install that already reads parallel sessions is no risk, whatever this build is', () => {
    // 1.1.0 is the first to read them: a newer build beside it (a candidate run from its own
    // dist, a second prefix) must not refuse it.
    for (const v of ['1.1.0', '1.1.1', '1.2.0']) {
      expect(olderInstallReason(lookup({ onPath: 'x' }, { x: v }).l)).toBeUndefined();
    }
    expect(olderInstallReason(lookup({ onPath: 'x' }, { x: '1.0.9' }).l)).toContain('(v1.0.9)');
  });

  it('a version that cannot be read refuses nothing', () => {
    expect(olderInstallReason(lookup({ onPath: 'x' }, {}).l)).toBeUndefined();
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
    expect(refused(['attach', 'abc12345'])).toBe(
      '"attach" opens a background session, which runs on the account its service holds; ' +
        '--account cannot choose one for it. Run it without --account.',
    );
    // The control verbs open nothing: they stop, remove or restart a session.
    for (const verb of ['stop', 'rm', 'kill', 'respawn']) {
      expect(refused([verb, 'abc12345'])).toBe(
        `"${verb}" acts on a background session, which runs on the account its service holds; ` +
          '--account cannot choose one for it. Run it without --account.',
      );
    }
    // Flags may stand between the verb and the session it names: the verb is still what is quoted.
    expect(refused(['kill', '--force', 'abc12345'])).toMatch(
      /^"kill" acts on a background session/,
    );
    expect(refused(['stop', '--verbose', 'abc12345'])).toMatch(
      /^"stop" acts on a background session/,
    );
    expect(refused(['attach', '--verbose', 'abc12345'])).toMatch(
      /^"attach" opens a background session/,
    );
    expect(refused(['--', 'rm', '--verbose', 'abc12345'])).toMatch(/^"rm" acts on/);
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

  it('says what a session is in use by: running terminals and background sessions, never exited ones', () => {
    type Judged = LeaseView['holders'][number];
    const h = (pid: number, role: LeaseHolder['role'], state: Judged['state'], parent?: number) =>
      ({
        pid,
        start: 1,
        host: 'BOX',
        platform: 'win32',
        role,
        state,
        ...(parent !== undefined ? { parent } : {}),
      }) as Judged;
    // Two launchers, one with its Claude Code: two terminals.
    expect(
      leaseInUse({
        holders: [h(1, 'launcher', 'alive'), h(2, 'claude', 'alive', 1), h(3, 'launcher', 'alive')],
      }),
    ).toEqual({ phrase: '2 terminals', running: true });
    // Only a background worker: no terminal holds it.
    expect(leaseInUse({ holders: [h(6, 'background', 'unverifiable')] })).toEqual({
      phrase: '1 background session',
      running: true,
    });
    // A Claude Code whose terminal was killed still runs where that terminal was.
    expect(leaseInUse({ holders: [h(1, 'launcher', 'dead'), h(2, 'claude', 'alive', 1)] })).toEqual(
      { phrase: '1 terminal', running: true },
    );
    // Every process exited: not in use by them.
    expect(leaseInUse({ holders: [h(1, 'launcher', 'dead'), h(2, 'claude', 'dead', 1)] })).toEqual({
      phrase: 'no process of it runs; it ends at the next check',
      running: false,
    });
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

  it('names the processes holding a session that no terminal runs', () => {
    const found = h(900, 'alive', { role: 'claude', parent: 812, found: true });
    const c = checkSessionLeases([view([found])]);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('W is held only by process(es) 900 that no terminal runs');
  });

  it('background sessions its profile still hosts keep it: never promised to be freed', async () => {
    const engine = {
      listLeases: () => Promise.resolve([view([h(4120, 'dead')])]),
      checkSlots: () => Promise.resolve([]),
    };
    const worker = {
      pid: 6000,
      start: 0,
      host: 'h',
      platform: 'win32' as const,
      role: 'background' as const,
    };
    const { leases, facts } = await gatherSessionLeases(engine, () => Promise.resolve([worker]));
    expect(facts.get('session-w')?.workers).toEqual([6000]);
    const c = checkSessionLeases(leases, facts);
    expect(c.detail).toContain(
      "its profile's background service still hosts session(s) (pids 6000)",
    );
    expect(c.detail).not.toContain('frees it');
  });

  it('names a process list that could not be read, and a login that could not be saved', () => {
    const unreadable = checkSessionLeases([view([h(1, 'dead')], { processesUnreadable: true })]);
    expect(unreadable.detail).toContain(
      'the process list that shows what still runs on its profile',
    );
    const login = checkSessionLeases(
      [view([h(1, 'dead')])],
      new Map([['session-w', { unstoredLogin: true }]]),
    );
    expect(login.detail).toContain('Log in again with cctl accounts relogin W');
    expect(login.detail).not.toContain('frees it within one poll');
  });
});

describe('the background-worker probe on Linux', () => {
  /** A `/proc` with one process, pid 2345, an unrelated program that took the pid over unless the
   *  test says otherwise: its start ticks, its state and its environment's config dir. */
  function proc(over: { state?: string; configDir?: string; argv?: string[] } = {}): ProcFs {
    return {
      stat: (pid) =>
        pid === 2345 ? { ppid: 1, startTicks: 99999, state: over.state ?? 'S' } : undefined,
      bootId: () => 'boot-1',
      pidNs: () => 'pid:[1]',
      configDirOf: (pid) => (pid === 2345 ? over.configDir : undefined),
      pids: () => [2345],
      // No arguments given: they cannot be read, which counts as a doubt everywhere.
      ...(over.argv !== undefined
        ? { cmdlineOf: (pid: number) => (pid === 2345 ? over.argv : undefined) }
        : {}),
    };
  }
  /** A probe over a roster naming pid 2345 as given, whatever verification is asked for. */
  function probeOf(
    worker: { pid: number; procStart?: string },
    fs: ProcFs,
    starts: Map<number, string> = new Map(),
  ) {
    return createLeaseOccupancyProbe(
      { hostedWorkerProcesses: () => Promise.resolve([worker]) },
      {
        platform: 'linux',
        hostname: () => 'box',
        procFs: fs,
        readStarts: () => Promise.resolve(starts),
      },
    );
  }
  const PROFILE = '/home/u/.local/share/claude-control/profiles/session-w';

  it('a roster entry with no recorded start whose environment names nothing is not a holder', async () => {
    expect(await probeOf({ pid: 2345 }, proc())('/p', { verify: false })).toEqual([]);
  });

  it("a recorded start that ps cannot read now decides nothing: unreadable, never the reuser's", async () => {
    expect(
      await probeOf({ pid: 2345, procStart: 'Mon Oct 19 10:00:00 2026' }, proc())(PROFILE, {
        verify: false,
      }),
    ).toBe('unreadable');
  });

  it('a recorded start that differs from the one read fresh now is another process', async () => {
    const probe = probeOf(
      { pid: 2345, procStart: 'Mon Oct 19 10:00:00 2026' },
      proc(),
      new Map([[2345, 'Mon Oct 19 11:30:00 2026']]),
    );
    expect(await probe(PROFILE, { verify: true })).toEqual([]);
  });

  it('a worker proven by its start, or by its environment naming the profile, holds it', async () => {
    const byStart = probeOf(
      { pid: 2345, procStart: 'Mon Oct 19 10:00:00 2026' },
      proc(),
      new Map([[2345, 'Mon Oct 19 10:00:00 2026']]),
    );
    expect(await byStart(PROFILE, { verify: false })).toMatchObject([
      { pid: 2345, start: 99999, role: 'background', platform: 'linux' },
    ]);
    const byEnvironment = probeOf({ pid: 2345 }, proc({ configDir: `${PROFILE}/` }));
    expect(await byEnvironment(PROFILE, { verify: false })).toMatchObject([
      { pid: 2345, start: 99999, role: 'background' },
    ]);
  });

  it('a dev server that took over the pid and inherited the profile holds nothing, recorded start or not', async () => {
    // Left running from the session's shell, so its environment names the profile; it never reads
    // the login, and its start is not the one the roster recorded.
    const devServer = proc({
      configDir: PROFILE,
      argv: ['node', '/home/u/app/node_modules/.bin/vite'],
    });
    const recorded = probeOf(
      { pid: 2345, procStart: 'Mon Oct 19 10:00:00 2026' },
      devServer,
      new Map([[2345, 'Mon Oct 19 11:30:00 2026']]),
    );
    expect(await recorded(PROFILE, { verify: false })).toEqual([]);
    expect(await recorded(PROFILE, { verify: true })).toEqual([]);
    expect(await probeOf({ pid: 2345 }, devServer)(PROFILE, { verify: false })).toEqual([]);
  });

  it('a Claude Code on the profile holds it by its environment, even when the clock moved its start', async () => {
    // A wall-clock step moves what `ps` prints for a process's start; its environment still says
    // it reads this profile's login.
    const worker = proc({ configDir: PROFILE, argv: ['claude', '--bg-worker'] });
    const probe = probeOf(
      { pid: 2345, procStart: 'Mon Oct 19 10:00:00 2026' },
      worker,
      new Map([[2345, 'Mon Oct 19 10:00:07 2026']]),
    );
    expect(await probe(PROFILE, { verify: false })).toMatchObject([
      { pid: 2345, start: 99999, role: 'background' },
    ]);
  });

  it('a worker that exited but was not reaped is gone', async () => {
    for (const state of ['Z', 'X']) {
      const probe = probeOf({ pid: 2345 }, proc({ state, configDir: PROFILE }));
      expect(await probe(PROFILE, { verify: true })).toEqual([]);
    }
  });
});

describe("the PowerShell wrappers' installs, read from the profiles", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  /** A cctl install at `version` under `root`, and the path of its entry script. */
  async function install(root: string, version: string): Promise<string> {
    const pkg = join(root, `v${version}`, 'node_modules', '@andrewtjin', 'cctl');
    await mkdir(join(pkg, 'dist'), { recursive: true });
    await writeFile(
      join(pkg, 'package.json'),
      JSON.stringify({ name: '@andrewtjin/cctl', version }),
    );
    await writeFile(join(pkg, 'dist', 'bin.js'), '');
    return join(pkg, 'dist', 'bin.js');
  }
  const wrapper = (entry: string): string =>
    renderShellInit('powershell', { nodePath: 'C:/node/node.exe', cctlEntry: entry });

  /** The older-install refusal as a real lookup gives it for these profiles, PATH and autostart
   *  aside. */
  const refusal = (env: NodeJS.ProcessEnv): string | undefined =>
    olderInstallReason({
      onPath: () => undefined,
      wrapperEntries: () => wrapperEntriesOf(env),
      autostart: () => undefined,
      versionOf: cctlVersionOf,
    });

  async function setup(): Promise<{ root: string; old: string; next: string }> {
    const root = await mkdtemp(join(tmpdir(), 'cctl-wrappers-'));
    dirs.push(root);
    return { root, old: await install(root, '1.0.0'), next: await install(root, '1.1.0') };
  }

  async function profile(path: string, text: string): Promise<void> {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, text);
  }

  it('the last wrapper a profile defines is the one in effect: an old one appended refuses', async () => {
    const { root, old, next } = await setup();
    const env = { USERPROFILE: root };
    const ps5 = join(root, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1');
    await profile(ps5, wrapper(next) + '\n' + wrapper(old));
    expect(readPowerShellWrappers(env).map((w) => w.profile)).toEqual([ps5]);
    expect(refusal(env)).toContain(
      `the PowerShell claude wrapper runs the cctl at ${old} (v1.0.0)`,
    );
    // Upgraded by appending: the new one is in effect, nothing refuses.
    await profile(ps5, wrapper(old) + '\n' + wrapper(next));
    expect(refusal(env)).toBeUndefined();
  });

  it("every host's profile counts: PowerShell 7's own, and a OneDrive Documents beside a local one", async () => {
    const { root, old, next } = await setup();
    await profile(
      join(root, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      wrapper(next),
    );
    await profile(
      join(root, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
      wrapper(old),
    );
    expect(refusal({ USERPROFILE: root })).toContain('(v1.0.0)');
    const drive = join(root, 'OneDrive');
    const local = await mkdtemp(join(tmpdir(), 'cctl-wrappers-'));
    dirs.push(local);
    await profile(
      join(local, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      wrapper(next),
    );
    await profile(
      join(drive, 'Documents', 'WindowsPowerShell', 'Microsoft.PowerShell_profile.ps1'),
      wrapper(old),
    );
    expect(refusal({ USERPROFILE: local, OneDrive: drive })).toContain('(v1.0.0)');
  });

  it('a profile whose last wrapper is the shim form runs PATH, which is checked on its own', async () => {
    const { root, old } = await setup();
    await profile(
      join(root, 'Documents', 'WindowsPowerShell', 'profile.ps1'),
      wrapper(old) + '\n' + renderShellInit('powershell'),
    );
    expect(readPowerShellWrappers({ USERPROFILE: root }).map((w) => w.wrapper.kind)).toEqual([
      'shim',
    ]);
    expect(refusal({ USERPROFILE: root })).toBeUndefined();
    expect(POWERSHELL_WRAPPER_MARKER).toBe('cctl claude wrapper (PowerShell)');
  });
});

describe('what a parallel session is in use by', () => {
  it('a Claude Code left running after its terminals exited is said as such, not as a terminal', () => {
    const left: LeaseView['holders'][number] = {
      pid: 900,
      start: 1,
      host: 'h',
      platform: 'win32',
      role: 'claude',
      parent: 812,
      found: true,
      state: 'alive',
    };
    expect(leaseInUse({ holders: [left] })).toEqual({
      phrase: '1 Claude Code process left running',
      running: true,
    });
  });
});

describe('cctl status and parallel sessions', () => {
  const base = {
    accounts: [{ label: 'A', active: true }],
    hooksInstalled: true,
    hooksProfilePath: 'settings.json',
    relayUrl: 'wss://x',
    autostart: 'registered' as const,
    daemonAlive: true,
    paired: true,
  };

  it('a session in use says by what; one whose processes all exited is a warning, not ok', () => {
    const running = renderSetupSummary({
      ...base,
      parallelSessions: [{ label: 'V', inUse: '1 background session', running: true }],
    });
    expect(running).toContain('parallel sessions: V (in use by 1 background session)');
    const stale = renderSetupSummary({
      ...base,
      parallelSessions: [
        { label: 'V', inUse: 'no process of it runs; it ends at the next check', running: false },
      ],
    });
    expect(stale).not.toContain('[ok] parallel sessions');
    expect(stale).toContain(
      '[--] parallel sessions: V (no process of it runs; it ends at the next check)',
    );
  });
});

describe('what the autostart registration starts, on WSL and on Linux', () => {
  it('the WSL task names the shim inside its bash script, not wsl.exe', () => {
    for (const shim of ['/home/u/.nvm/versions/node/v20/bin/cctl', "/home/o'brien/bin/cctl"]) {
      const action = wslTaskAction('Ubuntu', shim);
      const q = queryWslDaemonTask({
        host: { distro: 'Ubuntu' },
        run: () =>
          JSON.stringify({
            registered: true,
            execute: action.execute,
            arguments: action.arguments,
            state: 'Ready',
          }),
      });
      expect(q.execute).toBe(shim);
    }
  });

  it('the systemd unit names the shim its ExecStart runs', () => {
    const shim = '/home/u/.local/bin/cctl';
    const q = queryDaemonUnit({
      unitPath: '/u/claude-control-daemon.service',
      fs: { read: () => renderDaemonUnit(shim) } as never,
      run: () => 'enabled',
    });
    expect(q.execute).toBe(shim);
  });
});
