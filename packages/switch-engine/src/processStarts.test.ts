// Process identity for parallel sessions: the start parsers, the /proc reads, and the one judgment of
// whether a recorded holder still runs. Everything here is pure or reads an injected fixture, so a
// Windows box tests the Linux rules and the other way round.

import { describe, it, expect } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LEASE_START_TOLERANCE_MS,
  childHolder,
  createProcFs,
  holderState,
  isClaudeCodeProcess,
  parseProcessTable,
  readProcessTable,
  runQuery,
  selfHolder,
  windowsStartMs,
  type HolderEvidence,
  type ProcFsIo,
} from './processStarts.js';
import type { LeaseHolder, ProcFs } from './types.js';

/** A fixture /proc: files and links by path under `/proc`. */
function fixtureIo(files: Record<string, string>, links: Record<string, string> = {}): ProcFsIo {
  return {
    readFile: (p) => {
      const key = p.replace(/\\/g, '/');
      const text = files[key];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    readlink: (p) => {
      const key = p.replace(/\\/g, '/');
      const target = links[key];
      if (target === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return target;
    },
    readdir: () => [
      ...new Set(
        Object.keys(files)
          .map((k) => k.split('/')[2]!)
          .filter((n) => n !== undefined),
      ),
    ],
  };
}

/** A /proc stat line with the given name (field 2), ppid (4) and start ticks (22). */
function statLine(pid: number, comm: string, ppid: number, start: number): string {
  // Fields 3..21 then 22: state, ppid, then 17 filler fields, then starttime, then more.
  const filler = Array.from({ length: 17 }, (_, i) => String(i)).join(' ');
  return `${pid} (${comm}) S ${ppid} ${filler} ${start} 0 0 0\n`;
}

describe('windowsStartMs', () => {
  it('reads a FILETIME as epoch ms', () => {
    // 2026-01-01T00:00:00Z as a FILETIME.
    const ms = Date.UTC(2026, 0, 1);
    const filetime = BigInt(ms) * 10_000n + 116_444_736_000_000_000n;
    expect(windowsStartMs(filetime.toString())).toBe(ms);
  });

  it('reads .NET ticks as epoch ms', () => {
    const ms = Date.UTC(2026, 0, 1, 12, 30);
    const ticks = BigInt(ms) * 10_000n + 621_355_968_000_000_000n;
    expect(windowsStartMs(ticks.toString())).toBe(ms);
  });

  it('refuses garbage', () => {
    for (const raw of ['', 'abc', '-5', '12.5', '1e17', '99999999999999999999999']) {
      expect(windowsStartMs(raw)).toBeUndefined();
    }
  });
});

describe('parseProcessTable', () => {
  it('reads pid, parent and creation time per line, skipping anything else', () => {
    const ms = Date.UTC(2026, 3, 2);
    const ft = (BigInt(ms) * 10_000n + 116_444_736_000_000_000n).toString();
    expect(parseProcessTable([`10 4 ${ft}`, 'junk', '', `11 10 ${ft}\r`])).toEqual([
      { pid: 10, ppid: 4, startMs: ms },
      { pid: 11, ppid: 10, startMs: ms },
    ]);
  });
});

describe('createProcFs', () => {
  const io = fixtureIo(
    {
      '/proc/812/stat': statLine(812, 'claude (main) x', 700, 5512345),
      '/proc/812/environ': ['HOME=/home/u', 'CLAUDE_CONFIG_DIR=/data/profiles/session-a', ''].join(
        '\u0000',
      ),
      '/proc/900/stat': statLine(900, 'bash', 1, 42),
      '/proc/sys/kernel/random/boot_id': '6c1e0000-aaaa\n',
    },
    { '/proc/self/ns/pid': 'pid:[4026531836]' },
  );
  const fs = createProcFs('/proc', io);

  it('reads fields 4 and 22 past a name holding spaces and parentheses', () => {
    expect(fs.stat(812)).toEqual({ ppid: 700, startTicks: 5512345, state: 'S' });
    expect(fs.stat(900)).toEqual({ ppid: 1, startTicks: 42, state: 'S' });
    expect(fs.stat(1234)).toBeUndefined();
  });

  it('reads the boot id and the pid namespace', () => {
    expect(fs.bootId()).toBe('6c1e0000-aaaa');
    expect(fs.pidNs()).toBe('pid:[4026531836]');
  });

  it('reads CLAUDE_CONFIG_DIR out of a NUL-separated environ; unreadable is undefined', () => {
    expect(fs.configDirOf(812)).toBe('/data/profiles/session-a');
    expect(fs.configDirOf(900)).toBeUndefined();
    expect(fs.configDirOf(4)).toBeUndefined();
  });

  it('lists the numeric entries only', () => {
    expect(fs.pids().sort((a, b) => a - b)).toEqual([812, 900]);
  });
});

/** A Linux /proc stand-in with fixed answers. */
function linuxFs(over: Partial<ProcFs> & { starts?: Record<number, number> } = {}): ProcFs {
  const starts = over.starts ?? {};
  return {
    stat:
      over.stat ??
      ((pid) => (starts[pid] === undefined ? undefined : { ppid: 1, startTicks: starts[pid] })),
    bootId: over.bootId ?? (() => 'boot-1'),
    pidNs: over.pidNs ?? (() => 'pid:[1]'),
    configDirOf: over.configDirOf ?? (() => undefined),
    pids: over.pids ?? (() => Object.keys(starts).map(Number)),
    ...(over.machineId !== undefined ? { machineId: over.machineId } : {}),
    ...(over.pidNsOf !== undefined ? { pidNsOf: over.pidNsOf } : {}),
  };
}

const linuxHolder = (over: Partial<LeaseHolder> = {}): LeaseHolder => ({
  pid: 812,
  start: 5000,
  host: 'box',
  platform: 'linux',
  bootId: 'boot-1',
  pidNs: 'pid:[1]',
  role: 'launcher',
  ...over,
});

const winHolder = (over: Partial<LeaseHolder> = {}): LeaseHolder => ({
  pid: 4120,
  start: 1_760_000_000_000,
  host: 'BOX',
  platform: 'win32',
  role: 'launcher',
  ...over,
});

const linuxEvidence = (over: Partial<HolderEvidence> = {}): HolderEvidence => ({
  host: 'box',
  platform: 'linux',
  mode: 'quick',
  isAlive: () => true,
  procFs: linuxFs({ starts: { 812: 5000 } }),
  ...over,
});

const winEvidence = (over: Partial<HolderEvidence> = {}): HolderEvidence => ({
  host: 'BOX',
  platform: 'win32',
  mode: 'full',
  isAlive: () => true,
  table: new Map([[4120, { pid: 4120, ppid: 1, startMs: 1_760_000_000_400 }]]),
  ...over,
});

describe('holderState', () => {
  it('another host, platform or pid namespace is foreign, never judged', () => {
    expect(holderState(linuxHolder({ host: 'other' }), linuxEvidence())).toBe('foreign');
    expect(holderState(linuxHolder(), winEvidence({ host: 'box' }))).toBe('foreign');
    expect(holderState(linuxHolder({ pidNs: 'pid:[2]' }), linuxEvidence())).toBe('foreign');
  });

  it('another boot is dead without asking whether the pid runs', () => {
    let asked = false;
    const ev = linuxEvidence({
      isAlive: () => {
        asked = true;
        return true;
      },
    });
    expect(holderState(linuxHolder({ bootId: 'boot-0' }), ev)).toBe('dead');
    expect(asked).toBe(false);
  });

  it('ESRCH is dead; EPERM (alive but not ours) is alive', () => {
    expect(holderState(linuxHolder(), linuxEvidence({ isAlive: () => false }))).toBe('dead');
    expect(holderState(linuxHolder(), linuxEvidence({ isAlive: () => true }))).toBe('alive');
  });

  it('linux compares boot ticks exactly', () => {
    expect(holderState(linuxHolder({ start: 5000 }), linuxEvidence())).toBe('alive');
    expect(holderState(linuxHolder({ start: 5001 }), linuxEvidence())).toBe('dead');
  });

  it('linux with an unreadable stat is unverifiable', () => {
    const ev = linuxEvidence({ procFs: linuxFs({ starts: {} }) });
    expect(holderState(linuxHolder(), ev)).toBe('unverifiable');
  });

  it('win32 full compares within the tolerance', () => {
    const at = (offset: number) =>
      winEvidence({
        table: new Map([[4120, { pid: 4120, ppid: 1, startMs: 1_760_000_000_000 + offset }]]),
      });
    expect(holderState(winHolder(), at(LEASE_START_TOLERANCE_MS - 1))).toBe('alive');
    expect(holderState(winHolder(), at(-LEASE_START_TOLERANCE_MS + 1))).toBe('alive');
    expect(holderState(winHolder(), at(LEASE_START_TOLERANCE_MS + 1))).toBe('dead');
  });

  it('win32 full with no table row is unverifiable', () => {
    expect(holderState(winHolder(), winEvidence({ table: new Map() }))).toBe('unverifiable');
  });

  it('win32 quick never reads a start: kill-0 alive is alive', () => {
    const reused = winEvidence({
      mode: 'quick',
      table: new Map([[4120, { pid: 4120, ppid: 1, startMs: 1 }]]),
    });
    expect(holderState(winHolder(), reused)).toBe('alive');
  });

  it('a start never known is unverifiable', () => {
    expect(holderState(winHolder({ start: 0 }), winEvidence())).toBe('unverifiable');
    expect(holderState(linuxHolder({ start: 0 }), linuxEvidence())).toBe('unverifiable');
  });

  it("a holder on this process's pid with another start is dead (this process owns the pid now)", () => {
    const ev = winEvidence({ self: { pid: 4120, start: 1_760_000_999_000 } });
    expect(holderState(winHolder(), ev)).toBe('dead');
    const same = winEvidence({ self: { pid: 4120, start: 1_760_000_000_000 } });
    expect(holderState(winHolder(), same)).toBe('alive');
  });

  it('a wall-clock step moves nothing: a linux holder stays alive an hour either way', () => {
    const realNow = Date.now;
    try {
      for (const shift of [3_600_000, -3_600_000]) {
        Date.now = () => realNow() + shift;
        expect(holderState(linuxHolder(), linuxEvidence())).toBe('alive');
      }
    } finally {
      Date.now = realNow;
    }
  });
});

describe('selfHolder and childHolder', () => {
  it('win32: the launcher start is the time origin, the child start the spawn moment', () => {
    const me = selfHolder('launcher', {
      platform: 'win32',
      hostname: () => 'BOX',
      timeOrigin: () => 1000.6,
      pid: 7,
    });
    expect(me).toEqual({ pid: 7, start: 1001, host: 'BOX', platform: 'win32', role: 'launcher' });
    const child = childHolder(8, 7, { platform: 'win32', hostname: () => 'BOX', now: () => 2000 });
    expect(child).toEqual({
      pid: 8,
      start: 2000,
      host: 'BOX',
      platform: 'win32',
      role: 'claude',
      parent: 7,
    });
  });

  it('linux: boot ticks, boot id and pid namespace from /proc', () => {
    const fs = linuxFs({ starts: { 7: 300, 8: 301 } });
    const me = selfHolder('launcher', {
      platform: 'linux',
      hostname: () => 'box',
      procFs: fs,
      pid: 7,
    });
    expect(me).toMatchObject({ pid: 7, start: 300, bootId: 'boot-1', pidNs: 'pid:[1]' });
    const child = childHolder(8, 7, { platform: 'linux', hostname: () => 'box', procFs: fs });
    expect(child).toMatchObject({ pid: 8, start: 301, parent: 7, role: 'claude' });
  });

  it('the host comes from os.hostname, not the environment', () => {
    const before = process.env.HOSTNAME;
    try {
      process.env.HOSTNAME = 'from-env';
      const a = selfHolder('launcher', { platform: 'win32', timeOrigin: () => 1 });
      delete process.env.HOSTNAME;
      const b = selfHolder('launcher', { platform: 'win32', timeOrigin: () => 1 });
      expect(a.host).toBe(b.host);
      expect(a.host).not.toBe('from-env');
    } finally {
      if (before === undefined) delete process.env.HOSTNAME;
      else process.env.HOSTNAME = before;
    }
  });
});

describe('reading /proc the way the kernel stores it', () => {
  it('decodes an environment as UTF-8, so a profile under a non-ASCII path matches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ce-proc-'));
    try {
      await mkdir(join(root, '812'));
      const profile = '/home/jos\u00e9/.local/share/claude-control/profiles/session-a';
      // The bytes the kernel holds: node wrote the child's environment as UTF-8.
      await writeFile(
        join(root, '812', 'environ'),
        Buffer.from(`HOME=/home/jos\u00e9\u0000CLAUDE_CONFIG_DIR=${profile}\u0000`, 'utf8'),
      );
      expect(createProcFs(root).configDirOf(812)).toBe(profile);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reads a process's state, and a zombie holder is dead", () => {
    const io = fixtureIo(
      {
        '/proc/812/stat': statLine(812, 'claude', 1, 5000).replace(') S ', ') Z '),
        '/proc/sys/kernel/random/boot_id': 'boot-1',
      },
      { '/proc/self/ns/pid': 'pid:[1]' },
    );
    const fs = createProcFs('/proc', io);
    expect(fs.stat(812)).toMatchObject({ state: 'Z', startTicks: 5000 });
    // kill-0 succeeds on a zombie and its start still matches: only the state says it exited.
    expect(holderState(linuxHolder(), linuxEvidence({ procFs: fs }))).toBe('dead');
  });
});

describe('holderState across a reboot, a rename and a restarted namespace', () => {
  it('another boot is dead even when the pid namespace changed with it', () => {
    const ev = linuxEvidence({
      procFs: linuxFs({ bootId: () => 'boot-2', pidNs: () => 'pid:[9]' }),
    });
    expect(holderState(linuxHolder(), ev)).toBe('dead');
  });

  it('linux: a renamed machine is recognised by its machine id; another machine stays foreign', () => {
    const fs = linuxFs({ bootId: () => 'boot-2', machineId: () => 'mid-1' });
    const renamed = linuxHolder({ host: 'old-name', machineId: 'mid-1' });
    expect(holderState(renamed, linuxEvidence({ procFs: fs }))).toBe('dead');
    const other = linuxHolder({ host: 'old-name', machineId: 'mid-2' });
    expect(holderState(other, linuxEvidence({ procFs: fs }))).toBe('foreign');
  });

  it('linux, same machine and boot: a namespace still visible from here is foreign, a gone one is dead', () => {
    const gone = linuxFs({
      pidNs: () => 'pid:[9]',
      machineId: () => 'mid-1',
      pids: () => [900],
      pidNsOf: () => 'pid:[9]',
    });
    const holder = linuxHolder({ machineId: 'mid-1', pidNs: 'pid:[1]' });
    expect(holderState(holder, linuxEvidence({ procFs: gone }))).toBe('dead');
    const nested = linuxFs({
      pidNs: () => 'pid:[9]',
      machineId: () => 'mid-1',
      pids: () => [900, 901],
      pidNsOf: (pid) => (pid === 901 ? 'pid:[1]' : 'pid:[9]'),
    });
    expect(holderState(holder, linuxEvidence({ procFs: nested }))).toBe('foreign');
    // Without a machine id nothing says the namespace belongs to this machine: foreign.
    expect(holderState(linuxHolder({ pidNs: 'pid:[1]' }), linuxEvidence({ procFs: gone }))).toBe(
      'foreign',
    );
  });

  it('win32: a holder recorded under an earlier machine name is judged here', () => {
    expect(
      holderState(winHolder({ host: 'OLD-NAME' }), winEvidence({ isAlive: () => false })),
    ).toBe('dead');
    expect(holderState(winHolder({ host: 'OLD-NAME' }), winEvidence())).toBe('alive');
  });
});

describe('a process query that does not finish', () => {
  it('a query killed at its timeout is incomplete, with what it printed so far', async () => {
    const hang = await runQuery(
      process.execPath,
      ['-e', "console.log('1 2 3'); setTimeout(() => {}, 60000)"],
      process.env,
      false,
      1500,
    );
    expect(hang.complete).toBe(false);
    expect(hang.lines).toContain('1 2 3');
    const done = await runQuery(
      process.execPath,
      ['-e', "console.log('4 5 6')"],
      process.env,
      false,
    );
    expect(done).toMatchObject({ complete: true });
    const failed = await runQuery(process.execPath, ['-e', 'process.exit(3)'], process.env, false);
    expect(failed.complete).toBe(false);
  });

  it('a process table from an incomplete query is refused, never read as the whole table', async () => {
    const partial = () => Promise.resolve({ lines: ['4 1 133000000000000000'], complete: false });
    await expect(readProcessTable(partial)).rejects.toThrow();
    const whole = () => Promise.resolve({ lines: ['4 1 133000000000000000'], complete: true });
    expect(await readProcessTable(whole)).toHaveLength(1);
  });
});

describe('telling a Claude Code from anything else that inherited its profile', () => {
  it('a program named claude, or one run from where Claude Code is installed, is one', () => {
    for (const argv of [
      ['/home/u/.local/bin/claude', '-p', 'hi'],
      ['claude'],
      ['node', '/usr/local/bin/claude', '-p', 'hi'],
      ['node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '--resume', 'x'],
      ['/home/u/.local/share/claude/versions/2.1.301', '--bg'],
    ]) {
      expect(isClaudeCodeProcess({ argv })).toBe(true);
    }
    expect(isClaudeCodeProcess({ image: 'claude.exe', commandLine: 'claude.exe -p hi' })).toBe(
      true,
    );
    expect(
      isClaudeCodeProcess({
        image: 'node.exe',
        commandLine: String.raw`"C:\Program Files\nodejs\node.exe" C:\Users\u\AppData\Roaming\npm\node_modules\@anthropic-ai\claude-code\cli.js`,
      }),
    ).toBe(true);
  });

  it('a dev server, an editor or a shell is not, even when its arguments mention claude', () => {
    for (const argv of [
      ['node', '/home/u/app/node_modules/.bin/vite'],
      ['sleep', '900'],
      ['bash', '-c', 'claude -p hi'],
      ['/usr/bin/code', '/home/u/claude'],
    ]) {
      expect(isClaudeCodeProcess({ argv })).toBe(false);
    }
    expect(
      isClaudeCodeProcess({ image: 'node.exe', commandLine: 'node.exe C:/repo/server.js' }),
    ).toBe(false);
  });

  it('a process whose command line cannot be read counts as one: a doubt keeps the session', () => {
    expect(isClaudeCodeProcess({})).toBe(true);
    expect(isClaudeCodeProcess({ argv: [] })).toBe(true);
    expect(isClaudeCodeProcess({ image: 'node.exe' })).toBe(true);
  });

  it('the process table carries each name and command line; /proc gives each argument list', () => {
    const ms = Date.UTC(2026, 3, 2);
    const ft = (BigInt(ms) * 10_000n + 116_444_736_000_000_000n).toString();
    expect(
      parseProcessTable([
        `10 4 ${ft} claude.exe|C:/u/claude.exe -p a|b`,
        `11 10 ${ft} System Idle Process|`,
      ]),
    ).toEqual([
      { pid: 10, ppid: 4, startMs: ms, name: 'claude.exe', commandLine: 'C:/u/claude.exe -p a|b' },
      { pid: 11, ppid: 10, startMs: ms, name: 'System Idle Process' },
    ]);
    const fs = createProcFs(
      '/proc',
      fixtureIo({
        '/proc/812/cmdline': ['node', '/opt/claude-code/cli.js', '-p', ''].join(
          String.fromCharCode(0),
        ),
        '/proc/813/cmdline': 'claude',
      }),
    );
    expect(fs.cmdlineOf?.(812)).toEqual(['node', '/opt/claude-code/cli.js', '-p']);
    expect(fs.cmdlineOf?.(813)).toEqual(['claude']);
    expect(fs.cmdlineOf?.(814)).toBeUndefined();
  });
});
