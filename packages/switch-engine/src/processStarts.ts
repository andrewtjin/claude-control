// Process identity for parallel sessions: who holds one, and whether that process still runs.
//
// A parallel session (`cctl claude --account`) is held by processes: the launcher and its Claude
// Code child. A pid alone is no identity — Windows reuses pids quickly, and a session must never be
// ended under a live process nor kept forever by a dead one's reused pid. So a holder records the
// process's start too, taken where it cannot move with the wall clock:
//   - Linux: field 22 of /proc/<pid>/stat, clock ticks since boot, compared exactly, plus the boot id
//     (another boot = every recorded process is gone, whatever namespace it ran in), the pid
//     namespace (another WSL distro or a container is foreign: its pids mean nothing here) and the
//     machine id (which survives a rename of the machine). All synchronous file reads, no spawn.
//   - Windows: the creation time in epoch ms. The recorded side is the moment this process learned
//     it (node's time origin, or the spawn), the checked side an absolute FILETIME read in one
//     process-table query, so the two are compared within a tolerance.
// Every doubt (an unreadable start, an unknown one) counts as alive: ending a live session's slot
// logs that session out, while keeping a dead one only delays the account rejoining the pool.

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { LeaseHolder, LeaseHolderState, ProcessRow, ProcFs } from './types.js';

/** How long one process query may take before it is abandoned (it then reads as nothing). */
const START_QUERY_TIMEOUT_MS = 10_000;

/**
 * How far a Windows holder's recorded start may sit from the creation time the OS reports and still
 * be the same process. The recorded side trails the real creation by node's startup (a launcher) or
 * by the spawn call's return (a child). A pid reused within this window of the original start is not
 * detected, and the session then lingers until that process exits — the safe direction.
 */
export const LEASE_START_TOLERANCE_MS = 10_000;

/** 100 ns ticks between 1601-01-01 (FILETIME epoch) and 1970-01-01. */
const FILETIME_UNIX_EPOCH = 116_444_736_000_000_000n;
/** 100 ns ticks between 0001-01-01 (.NET ticks epoch) and 1970-01-01. */
const DOTNET_UNIX_EPOCH = 621_355_968_000_000_000n;
/** A raw Windows start above this is .NET ticks, below it a FILETIME (the two epochs are far apart,
 *  the same split the background host's own start comparison uses). */
const TICKS_SPLIT = 300_000_000_000_000_000n;

/**
 * A raw Windows start string as epoch ms: a FILETIME (what `ToFileTimeUtc()` prints) or .NET ticks,
 * told apart by size. Undefined for anything that is not a plain non-negative integer.
 */
export function windowsStartMs(raw: string): number | undefined {
  const text = raw.trim();
  if (!/^\d{1,20}$/.test(text)) return undefined;
  const value = BigInt(text);
  const epoch = value > TICKS_SPLIT ? DOTNET_UNIX_EPOCH : FILETIME_UNIX_EPOCH;
  if (value < epoch) return undefined;
  return Number((value - epoch) / 10_000n);
}

/** What one query printed, and whether it ran to a clean exit. A query killed at its timeout, or
 *  one that exited non-zero, may have printed only part of its answer. */
export interface QueryResult {
  lines: string[];
  complete: boolean;
}

/** Run one query and collect its stdout lines. `complete` is false when it could not run, timed
 *  out or failed: a caller that reads the output as a whole answer (the process table) must not
 *  take a cut-off one for it. `detached` is the start-time reader's historical spawn, kept as it
 *  was; the process table is read attached, because a detached PowerShell on Windows was measured
 *  to print nothing to the pipe. */
export function runQuery(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  detached: boolean,
  timeoutMs = START_QUERY_TIMEOUT_MS,
): Promise<QueryResult> {
  return new Promise((resolve) => {
    let text = '';
    let timedOut = false;
    let child;
    try {
      child = nodeSpawn(command, args, {
        env,
        stdio: ['ignore', 'pipe', 'ignore'],
        shell: false,
        windowsHide: true,
        detached,
      });
    } catch {
      resolve({ lines: [], complete: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (c: string) => (text += c));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ lines: [], complete: false });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ lines: text.split(/\r?\n/), complete: !timedOut && code === 0 });
    });
  });
}

/** How {@link readProcessTable} runs its query (a seam for tests). */
export type QueryRunner = (
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  detached: boolean,
) => Promise<QueryResult>;

/**
 * Read live processes' start times in one call, as Claude Code records them: `Get-Process` on Windows
 * (each a FILETIME), `ps -o lstart` elsewhere (in UTC and the C locale). A process that cannot be
 * read, or a query that fails, is left out. The background host compares these raw strings with the
 * ones Claude Code wrote; parallel sessions use {@link readProcessTable} and {@link procFs} instead.
 */
export function readProcessStarts(
  platform: NodeJS.Platform,
): (pids: readonly number[]) => Promise<Map<number, string>> {
  return async (pids) => {
    const out = new Map<number, string>();
    const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(',');
    if (list === '') return out;
    // A process missing from a cut-off answer reads as "nothing read now", which the background
    // host's own rule counts as the same process, so a partial answer is still usable here.
    const { lines } =
      platform === 'win32'
        ? await runQuery(
            'powershell.exe',
            [
              '-NoProfile',
              '-NonInteractive',
              '-Command',
              `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ` +
                'ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }',
            ],
            process.env,
            true,
          )
        : await runQuery(
            'ps',
            ['-o', 'pid=,lstart=', '-p', list],
            { ...process.env, LC_ALL: 'C', TZ: 'UTC' },
            true,
          );
    for (const line of lines) {
      const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (m !== null) out.set(Number(m[1]), m[2]!);
    }
    return out;
  };
}

/**
 * Windows only: every process with its parent, creation time, image name and command line, in one
 * `Get-CimInstance Win32_Process` query. The parent link is kept after the parent exits, which is
 * how a full check finds a dead launcher's Claude Code still running; the name and command line say
 * whether a process found that way is a Claude Code at all. A query that timed out or failed rejects
 * rather than answer with the rows it printed before it stopped: a cut-off table would read as
 * positive evidence that a process missing from it is gone. An empty table is a failure too.
 */
export async function readProcessTable(run: QueryRunner = runQuery): Promise<ProcessRow[]> {
  const { lines, complete } = await run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      // One line per process: `<pid> <ppid> <filetime> <name>|<command line>`. An image name
      // cannot hold `|`, so the first one ends it; line breaks in a command line become spaces.
      'Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { ' +
        '"$($_.ProcessId) $($_.ParentProcessId) $(if ($_.CreationDate) { $_.CreationDate.ToFileTimeUtc() } else { 0 }) ' +
        "$($_.Name)|$($_.CommandLine -replace '[\\r\\n]+', ' ')\" }",
    ],
    process.env,
    false,
  );
  const rows = parseProcessTable(lines);
  if (!complete || rows.length === 0) throw new Error('the process table could not be read');
  return rows;
}

/** The rows of a process-table query's output (`<pid> <ppid> <filetime>`, then optionally
 *  ` <name>|<command line>`, per line). An empty command line is left out: it could not be read. */
export function parseProcessTable(lines: readonly string[]): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of lines) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)(?:\s(.*))?$/.exec(line);
    if (m === null) continue;
    const startMs = windowsStartMs(m[3]!);
    if (startMs === undefined) continue;
    const rest = m[4] ?? '';
    const bar = rest.indexOf('|');
    const name = (bar < 0 ? rest : rest.slice(0, bar)).trim();
    const commandLine = bar < 0 ? '' : rest.slice(bar + 1).trim();
    rows.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      startMs,
      ...(name !== '' ? { name } : {}),
      ...(commandLine !== '' ? { commandLine } : {}),
    });
  }
  return rows;
}

/** The last segment of a path written with either separator, lower-cased, without `.exe`. */
function programName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.exe$/, '');
}

/** Paths only a Claude Code runs from: the npm package, and the native installer's version store
 *  (whose binaries are named by version, not `claude`). Compared with `/` separators, lower-cased. */
const CLAUDE_CODE_PATH_MARKS = ['/@anthropic-ai/claude-code/', '/claude/versions/'];

/** The runtimes a script-installed Claude Code runs under. */
const SCRIPT_HOSTS: ReadonlySet<string> = new Set(['node', 'nodejs', 'bun']);

/**
 * Whether a process is a Claude Code (the CLI, its background service, the copy an Agent SDK
 * bundles), by how it was started: a program named `claude` (the native binary, a symlink to it, or
 * the title Claude Code gives its own process), or a command line that runs it from where Claude
 * Code is installed (`node .../@anthropic-ai/claude-code/cli.js`, the native version store). Only a
 * Claude Code reads a profile's login, so only one holds a parallel session; a dev server or an
 * editor that merely inherited the profile's CLAUDE_CONFIG_DIR does not. A process whose command
 * line cannot be read counts as one: a doubt keeps the session, as everywhere else here.
 */
export function isClaudeCodeProcess(p: {
  /** The image name or executable path (Windows: Win32_Process.Name). */
  image?: string;
  /** The arguments, the program first (Linux: /proc/<pid>/cmdline). */
  argv?: readonly string[];
  /** The whole command line as one string (Windows). */
  commandLine?: string;
}): boolean {
  const argv = p.argv ?? [];
  // The program, or the script a JavaScript runtime runs: an npm install's `claude` is a script
  // that `node` runs under the name it was started by (`node /usr/local/bin/claude`).
  const script =
    argv[0] !== undefined && SCRIPT_HOSTS.has(programName(argv[0])) ? argv[1] : undefined;
  const named = [p.image, argv[0], script].filter((w): w is string => w !== undefined);
  if (named.some((w) => programName(w) === 'claude')) return true;
  const line = p.commandLine ?? (argv.length > 0 ? argv.join(' ') : undefined);
  if (line === undefined || line.trim() === '') return true;
  const flat = line.toLowerCase().replace(/\\/g, '/');
  return CLAUDE_CODE_PATH_MARKS.some((mark) => flat.includes(mark));
}

/** The file reads {@link createProcFs} makes, injectable so a fixture tree stands in for `/proc`. */
export interface ProcFsIo {
  readFile(path: string): string;
  readlink(path: string): string;
  readdir(path: string): string[];
}

/** Node's own file reads under `/proc`. UTF-8, the encoding node writes a child's environment in: a
 *  profile path holding a non-ASCII character must read back as the same string the engine compares
 *  it with. Any other byte decodes to a replacement character and never swallows an ASCII one, so
 *  the stat fields after the name still split as before. */
const nodeProcIo: ProcFsIo = {
  readFile: (p) => readFileSync(p, 'utf8'),
  readlink: (p) => readlinkSync(p),
  readdir: (p) => readdirSync(p),
};

/** One read that answers undefined instead of throwing: every `/proc` read can race the process
 *  exiting, or be denied for another user's process. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * The Linux `/proc` reads (see {@link ProcFs}) under `root`, and the machine id at `machineIdPath`.
 * `stat` parses after the LAST `)`, since a process's name (field 2) may itself hold spaces and
 * parentheses.
 */
export function createProcFs(
  root = '/proc',
  io: ProcFsIo = nodeProcIo,
  machineIdPath = '/etc/machine-id',
): ProcFs {
  return {
    stat(pid) {
      const text = attempt(() => io.readFile(join(root, String(pid), 'stat')));
      if (text === undefined) return undefined;
      const close = text.lastIndexOf(')');
      if (close < 0) return undefined;
      // Fields from 3 on: [0] is field 3 (state), so field N is at index N - 3.
      const fields = text
        .slice(close + 1)
        .trim()
        .split(/\s+/);
      const ppid = Number(fields[1]);
      const startTicks = Number(fields[19]);
      if (!Number.isInteger(ppid) || !Number.isInteger(startTicks)) return undefined;
      return { ppid, startTicks, state: fields[0] ?? '' };
    },
    machineId() {
      const text = attempt(() => io.readFile(machineIdPath));
      const id = text?.trim();
      return id === undefined || id === '' ? undefined : id;
    },
    pidNsOf(pid) {
      const link = attempt(() => io.readlink(join(root, String(pid), 'ns', 'pid')));
      return link === undefined || link === '' ? undefined : link;
    },
    bootId() {
      const text = attempt(() => io.readFile(join(root, 'sys', 'kernel', 'random', 'boot_id')));
      const id = text?.trim();
      return id === undefined || id === '' ? undefined : id;
    },
    pidNs() {
      const link = attempt(() => io.readlink(join(root, 'self', 'ns', 'pid')));
      return link === undefined || link === '' ? undefined : link;
    },
    configDirOf(pid) {
      const environ = attempt(() => io.readFile(join(root, String(pid), 'environ')));
      if (environ === undefined) return undefined;
      const prefix = 'CLAUDE_CONFIG_DIR=';
      const entry = environ.split('\u0000').find((e) => e.startsWith(prefix));
      return entry === undefined ? undefined : entry.slice(prefix.length);
    },
    cmdlineOf(pid) {
      const text = attempt(() => io.readFile(join(root, String(pid), 'cmdline')));
      if (text === undefined) return undefined;
      // NUL-separated, with a NUL after the last argument (none when a process rewrote its title).
      const words = text.split('\u0000');
      if (words.at(-1) === '') words.pop();
      return words;
    },
    pids() {
      const names = attempt(() => io.readdir(root)) ?? [];
      return names.filter((n) => /^\d+$/.test(n)).map(Number);
    },
  };
}

/** The real `/proc`. */
export const procFs: ProcFs = createProcFs();

/** The platform tag a holder records, or undefined where parallel sessions do not exist. */
function leasePlatform(platform: NodeJS.Platform): LeaseHolder['platform'] | undefined {
  return platform === 'win32' || platform === 'linux' ? platform : undefined;
}

/** What identifies a holder recorded by this process, injectable for tests. */
export interface HolderSource {
  platform?: NodeJS.Platform;
  hostname?: () => string;
  procFs?: ProcFs;
  /** This process's start on win32 (default: node's time origin, epoch ms). */
  timeOrigin?: () => number;
  /** The wall clock (default `Date.now`): a child's start on win32 is the moment of its spawn. */
  now?: () => number;
  pid?: number;
}

/**
 * The holder record of this process, a `cctl claude` launcher (see {@link LeaseHolder}). Windows: its
 * start is node's time origin; Linux: its own boot-tick start, boot id and pid namespace.
 */
export function selfHolder(role: 'launcher', source: HolderSource = {}): LeaseHolder {
  const platform = leasePlatform(source.platform ?? process.platform) ?? 'linux';
  const pid = source.pid ?? process.pid;
  const host = (source.hostname ?? hostname)();
  if (platform === 'win32') {
    return {
      pid,
      start: Math.round((source.timeOrigin ?? (() => performance.timeOrigin))()),
      host,
      platform,
      role,
    };
  }
  const fs = source.procFs ?? procFs;
  return {
    pid,
    start: fs.stat(pid)?.startTicks ?? 0,
    host,
    platform,
    role,
    ...linuxTags(fs),
  };
}

/**
 * The holder record of a Claude Code child this launcher just spawned, built synchronously in the
 * spawn callback. Windows: the moment of the spawn. Linux: the child's own boot-tick start, fixed at
 * fork, so it is exact even before the child execs.
 */
export function childHolder(pid: number, parent: number, source: HolderSource = {}): LeaseHolder {
  const platform = leasePlatform(source.platform ?? process.platform) ?? 'linux';
  const host = (source.hostname ?? hostname)();
  if (platform === 'win32') {
    return { pid, start: (source.now ?? Date.now)(), host, platform, role: 'claude', parent };
  }
  const fs = source.procFs ?? procFs;
  return {
    pid,
    start: fs.stat(pid)?.startTicks ?? 0,
    host,
    platform,
    role: 'claude',
    parent,
    ...linuxTags(fs),
  };
}

/** The boot id, pid namespace and machine id a Linux holder carries, each only when readable. */
export function linuxTags(fs: ProcFs): { bootId?: string; pidNs?: string; machineId?: string } {
  const bootId = fs.bootId();
  const pidNs = fs.pidNs();
  const machineId = fs.machineId?.();
  return {
    ...(bootId !== undefined ? { bootId } : {}),
    ...(pidNs !== undefined ? { pidNs } : {}),
    ...(machineId !== undefined ? { machineId } : {}),
  };
}

/** Everything {@link holderState} judges a holder by, read once per check. */
export interface HolderEvidence {
  host: string;
  platform: NodeJS.Platform;
  /** quick: no process query (kill-0 on Windows); full: the Windows process table too. */
  mode: 'quick' | 'full';
  /** "alive unless ESRCH": EPERM is a live process that is not ours. */
  isAlive: (pid: number) => boolean;
  /** Linux. */
  procFs?: ProcFs;
  /** Windows, full mode: the process table by pid. Undefined or empty: the query failed. */
  table?: ReadonlyMap<number, ProcessRow> | undefined;
  /** This process: a holder on its pid with another start is a reused record, provably dead. */
  self?: { pid: number; start: number };
  /** Linux: the pid namespaces of the processes visible from here (default: read from `procFs` on
   *  each call). The engine passes one read once per check. */
  visibleNamespaces?: () => ReadonlySet<string>;
}

/** Linux: the pid namespaces the processes visible from here run in. A namespace nested in this
 *  one shows up; one that is gone (or a sibling's) does not. */
export function visibleNamespaces(fs: ProcFs): Set<string> {
  const seen = new Set<string>();
  if (fs.pidNsOf === undefined) return seen;
  for (const pid of fs.pids()) {
    const ns = fs.pidNsOf(pid);
    if (ns !== undefined) seen.add(ns);
  }
  return seen;
}

/** The states a Linux process has exited in but still shows under `/proc`: a zombie (not yet
 *  reaped by its parent) and a dead one being torn down. kill-0 succeeds on both. */
const EXITED_STATES: ReadonlySet<string> = new Set(['Z', 'X', 'x']);

/**
 * Whether a Linux holder was recorded on this machine: the same host name, or the same machine id
 * (a renamed machine keeps its machine id, and its old name would otherwise make every holder it
 * recorded foreign forever).
 */
function sameLinuxMachine(h: LeaseHolder, now: HolderEvidence): boolean {
  if (h.host === now.host) return true;
  const machine = now.procFs?.machineId?.();
  return h.machineId !== undefined && machine !== undefined && h.machineId === machine;
}

/**
 * Whether one holder's process still runs, judged from this process:
 *   1. another platform: `foreign`, never judged from here. On linux another machine (host name and
 *      machine id both differ) is foreign too. On win32 the host name is not checked: the vault is
 *      tied to this machine and user, so a holder of another name was recorded here before a rename;
 *   2. (linux) another boot: `dead`, without a process query, whatever namespace it ran in (no
 *      namespace of an earlier boot still exists);
 *   3. (linux) another pid namespace in this boot: `foreign` while a process visible from here runs
 *      in it (a nested one, whose pids this check cannot read) or while nothing ties it to this
 *      machine (no matching machine id: another container's or distro's); `dead` when it is this
 *      machine's and no visible process runs in it (a WSL distro that restarted in the same VM);
 *   4. this process's own pid with another start: `dead` (this process owns that pid now);
 *   5. kill-0 says no such process: `dead`;
 *   6. start 0 (never known): `unverifiable`;
 *   7. the start check: linux compares boot ticks exactly (unreadable: `unverifiable`; a zombie, which
 *      kill-0 still finds, is `dead`); win32, full only, compares the table's creation time within
 *      {@link LEASE_START_TOLERANCE_MS} (no row: `unverifiable`); win32 quick makes none;
 *   8. otherwise `alive`.
 * Nothing here reads the wall clock, so a clock step cannot change the answer.
 */
export function holderState(h: LeaseHolder, now: HolderEvidence): LeaseHolderState {
  if (h.platform !== now.platform) return 'foreign';
  const linux = h.platform === 'linux';
  if (linux) {
    if (!sameLinuxMachine(h, now)) return 'foreign';
    const boot = now.procFs?.bootId();
    if (h.bootId !== undefined && boot !== undefined && h.bootId !== boot) return 'dead';
    const ns = now.procFs?.pidNs();
    if ((h.pidNs ?? null) !== (ns ?? null)) {
      const machine = now.procFs?.machineId?.();
      const ours = h.machineId !== undefined && h.machineId === machine;
      if (!ours || h.pidNs === undefined || now.procFs === undefined) return 'foreign';
      const visible = (now.visibleNamespaces ?? (() => visibleNamespaces(now.procFs!)))();
      return visible.has(h.pidNs) ? 'foreign' : 'dead';
    }
  }
  if (now.self !== undefined && h.pid === now.self.pid && h.start !== now.self.start) {
    return 'dead';
  }
  if (!now.isAlive(h.pid)) return 'dead';
  if (h.start === 0) return 'unverifiable';
  if (linux) {
    const stat = now.procFs?.stat(h.pid);
    if (stat === undefined) return 'unverifiable';
    if (stat.state !== undefined && EXITED_STATES.has(stat.state)) return 'dead';
    return stat.startTicks === h.start ? 'alive' : 'dead';
  }
  if (now.mode === 'quick') return 'alive';
  const row = now.table?.get(h.pid);
  if (row === undefined) return 'unverifiable';
  return Math.abs(row.startMs - h.start) > LEASE_START_TOLERANCE_MS ? 'dead' : 'alive';
}

/** The default liveness probe for holders: "alive unless ESRCH", as the credential lock judges its
 *  owner. EPERM is a live process that is not ours. */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}
