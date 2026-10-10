// The seam to Claude Code's background service: the real {@link BackgroundSessionHost} the daemon's
// background mover drives (see the daemon's backgroundMover.ts for when and why a session moves).
//
// Claude Code runs one background service per config dir (keyed on CLAUDE_CONFIG_DIR, or on
// ~/.claude when it is unset), and keeps that service's state under the config dir:
//   - `daemon/roster.json`: the workers the service hosts right now, by short id, each with its full
//     session id, working directory and the pid of its terminal host. It also holds attach secrets;
//     only the four fields above are ever read out of it, and nothing from it is logged;
//   - `jobs/<short>/state.json`: the session's job row, with its state (`running`, `stopped`,
//     `failed`...), its name, the launch options it saved (`respawnFlags`, see {@link replayOptions})
//     and the permission rules granted while it ran (`sessionPermissionRules`). One session can have
//     a row in several config dirs, each with its own state, name and options;
//   - `daemon/attach-journal/*.json`: one entry per terminal opening a session of the service
//     (`claude attach`, or the agent view), naming that terminal's process; Claude Code clears it
//     when the terminal leaves the session. It does not say which session.
// One file is shared instead: `sessions/<pid>.json`, the registry of every live session process,
// which every folder profile shares with the main config dir. Each entry says whether the session is
// a background one (`kind: bg`, with its job's short id) or open in a terminal (`interactive`), and
// what it is doing (`status`: `idle` between turns, `busy` in one, `waiting` on a prompt), whichever
// service hosts it.
// Everything else is asked of Claude Code itself, run as the operator's own `claude` on PATH (the
// binary that started the service), with CLAUDE_CONFIG_DIR naming the service to talk to:
//   - `claude agents --json`: every session with its status; the listing spans every working
//     directory;
//   - `claude stop <short>`: stops it. It returns a moment before the session has exited, so the
//     host waits until the registry and the roster no longer hold it;
//   - `claude --bg --resume <session id> [options]` with no prompt: resumes it idle under that
//     config dir's service ("idle — send a prompt to start"), or prints that it started a copy.
// `claude rm` is never run: it deletes the session's worktree and branch along with its job row.
// These shapes were measured against Claude Code 2.1.295; anything else is read defensively, and an
// unexpected answer fails the operation rather than guessing.

import { spawn as nodeSpawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BackgroundSession,
  BackgroundSessionHost,
  SavedLaunch,
  SessionActivity,
  SessionLock,
} from '@claude-control/daemon';
import { LockTimeoutError, acquireLock } from '@claude-control/switch-engine';
import { findClaudeOnPath, resolveLaunchTarget } from './launcher.js';

/** One finished Claude Code command. */
export interface ClaudeRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs Claude Code with these arguments, environment and working directory. */
export type RunClaude = (
  args: string[],
  opts: { env: NodeJS.ProcessEnv; cwd?: string },
) => Promise<ClaudeRunResult>;

/** One live entry of Claude Code's shared session registry (`sessions/<pid>.json`). */
export interface LiveSession {
  /** The session process. Only entries whose process is alive are ever returned. */
  pid: number;
  /** The full, lowercase session id. */
  sessionId: string;
  /** `bg` for a session a background service hosts, `interactive` for one open in a terminal. */
  kind: string;
  /** `idle` between turns, `busy` in one, `waiting` on a prompt; absent while it starts. */
  status?: string;
  /** A background session's short id. */
  jobId?: string;
  name?: string;
  cwd?: string;
}

export interface ClaudeBackgroundHostOptions {
  /** The main config dir: the global slot's, which a `null` config dir names. */
  mainConfigDir: string;
  /** Where the cross-process move locks live, one per session (see {@link moveLocksDir}). */
  moveLockDir: string;
  /** The environment Claude Code is run with (default: this process's). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How Claude Code is run (default: the `claude` on PATH, without a shell). */
  run?: RunClaude;
  readFile?: (path: string) => string;
  /** The names in a directory; throws (ENOENT) for one that does not exist. */
  readDir?: (path: string) => string[];
  isProcessAlive?: (pid: number) => boolean;
  /** Pause between reads while waiting for a stopped session to exit. Injectable so tests need not
   *  wait. */
  sleep?: (ms: number) => Promise<void>;
  /** A monotonic clock in ms, for that wait (default `performance.now`). */
  clock?: () => number;
  /** How long a stopped session may take to exit before the stop counts as not seen through. */
  stopExitTimeoutMs?: number;
}

/** Where the move locks live under cctl's data dir (the vault dir's parent). */
export function moveLocksDir(dataDir: string): string {
  return join(dataDir, 'background-moves');
}

/** How long one Claude Code command may run. A resume returns once the session is dispatched, in
 *  about a second when the service is up and a few when it has to start. */
const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

/** Measured: a stopped session leaves the registry about a second after `claude stop` returns, and
 *  its terminal host leaves the roster a moment later. Ten seconds is far past that on a loaded box,
 *  and short of anything the operator would wait out. */
const DEFAULT_STOP_EXIT_TIMEOUT_MS = 10_000;
const STOP_EXIT_POLL_MS = 100;
/** A move lock whose holder is older than this is presumed dead even when its process looks alive
 *  (a reused pid). Well above the longest move: a stop, a resume, its confirm window and the tries
 *  of a way back, each bounded by the command timeout. A holder that died is noticed at once. */
const MOVE_LOCK_STALE_MS = 10 * 60_000;
const MOVE_LOCK_POLL_MS = 250;

const SHORT_ID = /^[0-9a-f]{8}$/;
/** How Claude Code says a resume started a copy instead (every reason it gives ends this way). */
const COPY_STARTED = /started a (?:restricted )?copy(?: of that conversation)? as ([0-9a-f]{8})/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The launch options Claude Code saves in a job row (`respawnFlags`), by how it reads them: options
 * taking a value, those of them taking several, and switches. These are Claude Code 2.1.295's own
 * lists of what it saves, so a row holds only these and their values. Claude Code drops every other
 * word when it saves, the session's first prompt among them, except that every word after an option
 * taking several values is saved as one of its values: that is how Claude Code read them at launch
 * too, so they ARE its values, and a replay keeps them so.
 */
const SAVED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--model',
  '--permission-mode',
  '--inherit-permission-mode',
  '--proactivity',
  '--agent',
  '--agents',
  '--routine',
  '--effort',
  '--add-dir',
  '--mcp-config',
  '--settings',
  '--setting-sources',
  '--managed-settings',
  '--client-data-url',
  '--system-prompt',
  '--system-prompt-file',
  '--append-system-prompt',
  '--append-system-prompt-file',
  '--system-prompt-snapshot',
  '--append-subagent-system-prompt',
  '--append-subagent-system-prompt-file',
  '--fallback-model',
  '--advisor',
  '--channels',
  '--watch-artifact',
  '--watch-artifact-no-autoreact',
  '--permission-prompt-tool',
  '--permission-prompts',
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--tools',
  '--debug-file',
  '--name',
  '--autocompact',
  '--betas',
  '--max-budget-usd',
  '--max-thinking-tokens',
  '--max-turns',
  '--task-budget',
  '--plan-mode-instructions',
  '--plugin-dir',
  '--plugin-dir-no-mcp',
  '--plugin-url',
  '--thinking',
  '--thinking-display',
  '--remote-control-session-name-prefix',
  '--json-schema',
]);
const SAVED_LIST_OPTIONS: ReadonlySet<string> = new Set([
  '--allowed-tools',
  '--allowedTools',
  '--disallowed-tools',
  '--disallowedTools',
  '--tools',
  '--mcp-config',
  '--betas',
  '--add-dir',
  '--channels',
]);
const SAVED_SWITCH_OPTIONS: ReadonlySet<string> = new Set([
  '--dangerously-skip-permissions',
  '--allow-dangerously-skip-permissions',
  '--strict-mcp-config',
  '--dangerously-allow-browser-network-access',
  '--restricted',
  '--disable-slash-commands',
  '--verbose',
  '--ide',
  '--chrome',
  '--no-chrome',
  '--bare',
  '--brief',
  '--remote-control',
  '--rc',
  '--local',
]);
/** Short spellings Claude Code saves as given, replayed by their long name. */
const SHORT_OPTIONS: ReadonlyMap<string, string> = new Map([['-n', '--name']]);
/**
 * Saved options a move never replays, so a session saved with one is not moved: replayed on a
 * resume, each would act again at startup (rewind files, download files, run a command, answer on
 * resume, which spends a turn) or name a new session id rather than resume this one. Claude Code
 * also saves `-m` and `--exec`, which it reads before its options and documents nowhere.
 */
const NOT_REPLAYED_OPTIONS: ReadonlySet<string> = new Set([
  '--session-id',
  '--rewind-files',
  '--file',
  '--exec',
  '-m',
  '--reply-on-resume',
]);

/** A saved option list as a move would replay it: every option in a canonical spelling, or why it
 *  cannot be replayed. */
export type OptionReplay = { ok: true; options: string[] } | { ok: false; reason: string };

/** A word that names an option, safe to repeat in a reason: never a prompt or a value. */
const OPTION_NAME = /^--?[A-Za-z][A-Za-z0-9-]*$/;

/** Environment variables that mark a process as running inside a Claude Code session, or carry
 *  cctl's per-launch guard relaxations. A daemon started from a session would otherwise hand them to
 *  the background service it starts, and so to every session that service hosts. */
const SESSION_MARKERS: readonly string[] = [
  'CLAUDECODE',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_KIND',
  'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_JOB_DIR',
  'CLAUDE_PROJECT_DIR',
  'CCTL_LAUNCH_EXPLICIT',
  'CCTL_BIND_OVERRIDE',
  'CCTL_BIND_ENFORCE',
];

/**
 * A saved option list (`respawnFlags`) as a move replays it: ALL of it, read the way Claude Code
 * saved it (see {@link SAVED_VALUE_OPTIONS}), or not at all. Leaving out what this build cannot place
 * would resume the session without it, and the options a session is saved with include its
 * restrictions (a tool deny list, a settings file, a budget). Every value is replayed attached to its
 * option (`--flag=value`, one per value of a list option), so no word can ever reach the resume as a
 * prompt; two lists saved with the same options give the same words however each was spelled.
 */
export function replayOptions(saved: unknown): OptionReplay {
  if (saved === undefined) return { ok: true, options: [] };
  const unreadable: OptionReplay = {
    ok: false,
    reason: 'its saved launch options could not be read',
  };
  if (!Array.isArray(saved)) return unreadable;
  const words: unknown[] = saved;
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    if (typeof word !== 'string') return unreadable;
    const eq = word.startsWith('--') ? word.indexOf('=') : -1;
    const spelled = eq > 0 ? word.slice(0, eq) : word;
    const flag = SHORT_OPTIONS.get(spelled) ?? spelled;
    if (NOT_REPLAYED_OPTIONS.has(flag)) {
      return { ok: false, reason: `it was started with ${flag}, which a move does not replay` };
    }
    if (eq > 0 && SAVED_VALUE_OPTIONS.has(flag)) {
      out.push(`${flag}=${word.slice(eq + 1)}`);
    } else if (eq < 0 && SAVED_SWITCH_OPTIONS.has(flag)) {
      out.push(flag);
    } else if (eq < 0 && SAVED_VALUE_OPTIONS.has(flag) && typeof words[i + 1] === 'string') {
      // Claude Code takes the next word as the value whatever it looks like, and for a list option
      // every word after it up to the next option.
      out.push(`${flag}=${words[++i] as string}`);
      while (SAVED_LIST_OPTIONS.has(flag) && i + 1 < words.length) {
        const next = words[i + 1];
        if (typeof next !== 'string' || next.startsWith('-')) break;
        out.push(`${flag}=${next}`);
        i++;
      }
    } else {
      // An option this build does not know, or a word Claude Code would not have saved here. Only an
      // option's name is repeated: any other word could be the session's own text.
      return {
        ok: false,
        reason: OPTION_NAME.test(spelled)
          ? `it was started with ${spelled}, which this cctl cannot carry over`
          : 'its saved launch options hold a word this cctl cannot place',
      };
    }
  }
  return { ok: true, options: out };
}

/** Whether a job row holds permission rules granted while the session ran. They live in the row,
 *  not in its options, so no option carries them over, and a deny rule among them is a restriction
 *  the session would lose. Anything but an absent or empty set counts, read or not. */
function holdsPermissionRules(rules: unknown): boolean {
  if (rules === undefined || rules === null) return false;
  if (typeof rules !== 'object' || Array.isArray(rules)) return true;
  return Object.values(rules as Record<string, unknown>).some(
    (list) => !Array.isArray(list) || list.length > 0,
  );
}

/** The first line of a command's output, trimmed, for an error message. */
function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0]?.trim() ?? '';
}

/** Whether a pid names a live process (kill 0 sends nothing; EPERM means alive but not ours). */
function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Run the `claude` found on PATH directly (no shell), with stdin closed — a background launch
 *  given an open stdin could read it as a prompt — and a timeout that kills a hung command. */
function defaultRunClaude(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): RunClaude {
  let target: { command: string; prefixArgs: string[] } | undefined;
  const resolveTarget = (): { command: string; prefixArgs: string[] } => {
    if (target !== undefined) return target;
    const found = findClaudeOnPath({
      platform,
      ...(env.PATH !== undefined ? { pathEnv: env.PATH } : {}),
      ...(env.PATHEXT !== undefined ? { pathExt: env.PATHEXT } : {}),
    });
    if (found === undefined) throw new Error('claude is not on the PATH the daemon runs with');
    const resolved = resolveLaunchTarget(found, { platform });
    if (resolved.kind === 'refused') throw new Error(resolved.reason);
    target = { command: resolved.command, prefixArgs: resolved.prefixArgs };
    return target;
  };
  return (args, opts) =>
    new Promise<ClaudeRunResult>((resolve, reject) => {
      let t: { command: string; prefixArgs: string[] };
      try {
        t = resolveTarget();
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const child = nodeSpawn(t.command, [...t.prefixArgs, ...args], {
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8').on('data', (c: string) => (stdout += c));
      child.stderr.setEncoding('utf8').on('data', (c: string) => (stderr += c));
      const timer = setTimeout(() => child.kill(), CLAUDE_COMMAND_TIMEOUT_MS);
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, stdout, stderr });
      });
    });
}

/** A JSON file's top-level object, or undefined for one that is missing, torn or not an object. */
function readObject(
  readFile: (path: string) => string,
  path: string,
): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFile(path));
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A field that is a non-empty string, or nothing. */
function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/** Build the host for the daemon. */
export function createClaudeBackgroundHost(
  options: ClaudeBackgroundHostOptions,
): BackgroundSessionHost {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunClaude(platform, baseEnv);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const readDir = options.readDir ?? ((p: string) => readdirSync(p));
  const isAlive = options.isProcessAlive ?? pidIsAlive;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => performance.now());
  const stopExitTimeoutMs = options.stopExitTimeoutMs ?? DEFAULT_STOP_EXIT_TIMEOUT_MS;

  /** The names in a directory, or none for one that does not exist or cannot be listed. */
  const namesIn = (dir: string): string[] => {
    try {
      return readDir(dir);
    } catch {
      return [];
    }
  };

  /** The config dir whose files describe a service: the named one, or the main one. */
  const home = (configDir: string | null): string => configDir ?? options.mainConfigDir;

  /** The environment for a command against a config dir's service: this process's, minus session
   *  markers, with CLAUDE_CONFIG_DIR naming a folder profile. The main config dir is reached exactly
   *  as the daemon itself resolves it (its own CLAUDE_CONFIG_DIR, or none), so the command finds the
   *  same service a plain `claude` started. */
  const envFor = (configDir: string | null): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    for (const key of SESSION_MARKERS) delete env[key];
    if (configDir !== null) env.CLAUDE_CONFIG_DIR = configDir;
    else if (env.CLAUDE_CONFIG_DIR !== undefined) env.CLAUDE_CONFIG_DIR = options.mainConfigDir;
    return env;
  };

  /** Run a command and require exit 0; otherwise fail with what Claude Code said. */
  const runOk = async (
    configDir: string | null,
    args: string[],
    cwd?: string,
  ): Promise<ClaudeRunResult> => {
    const result = await run(args, {
      env: envFor(configDir),
      ...(cwd !== undefined ? { cwd } : {}),
    });
    if (result.code !== 0) {
      const said = firstLine(result.stderr) || firstLine(result.stdout) || 'no output';
      throw new Error(`claude ${args[0] ?? ''} exited ${String(result.code)}: ${said}`);
    }
    return result;
  };

  /** A config dir's job row for a session: none, one that cannot be read right now (caught
   *  mid-write, or not what Claude Code writes), or the row. */
  const jobRow = (
    configDir: string | null,
    short: string,
  ): { kind: 'none' } | { kind: 'unreadable' } | { kind: 'row'; row: Record<string, unknown> } => {
    let text: string;
    try {
      text = readFile(join(home(configDir), 'jobs', short, 'state.json'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'unreadable' };
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? { kind: 'row', row: parsed as Record<string, unknown> }
        : { kind: 'unreadable' };
    } catch {
      return { kind: 'unreadable' };
    }
  };

  /** Whether an attach journal entry names a terminal that is still running. Claude Code records the
   *  terminal's process before it writes an entry, and leaves `{}` where it cleared one, so an entry
   *  naming no process names no terminal. One that cannot be read (caught mid-write) counts as open:
   *  a stop under someone cannot be taken back. */
  const attachLive = (path: string): boolean => {
    let entry: unknown;
    try {
      entry = JSON.parse(readFile(path));
    } catch (err) {
      // Gone since the listing: that terminal has left.
      return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
    const pid =
      entry !== null && typeof entry === 'object' ? (entry as { pid?: unknown }).pid : undefined;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isAlive(pid);
  };

  /** The sessions a config dir's service hosts, from its roster (see the header). */
  const readHosted = (configDir: string | null): BackgroundSession[] => {
    let roster: unknown;
    try {
      roster = JSON.parse(readFile(join(home(configDir), 'daemon', 'roster.json')));
    } catch {
      // No roster (no service ever ran there) or one caught mid-write: nothing hosted this read.
      return [];
    }
    const workers =
      roster !== null && typeof roster === 'object'
        ? (roster as { workers?: unknown }).workers
        : undefined;
    if (workers === null || typeof workers !== 'object') return [];
    const out: BackgroundSession[] = [];
    for (const [short, raw] of Object.entries(workers as Record<string, unknown>)) {
      if (!SHORT_ID.test(short) || raw === null || typeof raw !== 'object') continue;
      const w = raw as { sessionId?: unknown; cwd?: unknown; pid?: unknown };
      if (typeof w.sessionId !== 'string' || !SESSION_ID.test(w.sessionId)) continue;
      if (!w.sessionId.startsWith(short)) continue;
      if (typeof w.cwd !== 'string' || w.cwd.length === 0) continue;
      // A roster left behind by a service that died still names its workers; only a live
      // terminal host means the session is really hosted there.
      if (typeof w.pid !== 'number' || !Number.isInteger(w.pid) || !isAlive(w.pid)) continue;
      out.push({ short, sessionId: w.sessionId, cwd: w.cwd });
    }
    return out;
  };

  /** The live entries of the shared session registry (see the header). It sits in the main config
   *  dir, and every folder profile links its own `sessions/` there. An entry left by a process that
   *  has exited is skipped: Claude Code removes its own on a clean exit, not on a hard kill. */
  const readRegistry = (): LiveSession[] => {
    const dir = join(options.mainConfigDir, 'sessions');
    const out: LiveSession[] = [];
    for (const file of namesIn(dir)) {
      if (!/^\d+\.json$/.test(file)) continue;
      const e = readObject(readFile, join(dir, file));
      if (e === undefined) continue;
      const pid = e.pid;
      const sessionId = e.sessionId;
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || !isAlive(pid)) continue;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) continue;
      const jobId = nonEmpty(e.jobId);
      const status = nonEmpty(e.status);
      const name = nonEmpty(e.name);
      const cwd = nonEmpty(e.cwd);
      out.push({
        pid,
        sessionId,
        kind: nonEmpty(e.kind) ?? 'interactive',
        ...(status !== undefined ? { status } : {}),
        ...(jobId !== undefined && SHORT_ID.test(jobId) ? { jobId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
      });
    }
    return out;
  };

  /** Whether a session (by short id) still runs anywhere: in the registry, or in the roster of the
   *  service that hosted it. The registry entry goes first and the terminal host a moment later. */
  const stillRunning = (configDir: string | null, short: string): boolean =>
    readRegistry().some((e) => e.jobId === short || e.sessionId.startsWith(short)) ||
    readHosted(configDir).some((s) => s.short === short);

  return {
    async lockSession(sessionId, waitMs): Promise<SessionLock | undefined> {
      // The id names the lock's directory, so only a session id may.
      if (!SESSION_ID.test(sessionId)) throw new Error(`not a background session id: ${sessionId}`);
      try {
        return await acquireLock(join(options.moveLockDir, sessionId), Date.now, {
          timeoutMs: waitMs,
          pollMs: MOVE_LOCK_POLL_MS,
          staleMs: MOVE_LOCK_STALE_MS,
        });
      } catch (err) {
        if (err instanceof LockTimeoutError) return undefined;
        throw err;
      }
    },

    listHosted(configDir) {
      return Promise.resolve(readHosted(configDir));
    },

    async activity(configDir) {
      const result = await runOk(configDir, ['agents', '--json']);
      let rows: unknown;
      try {
        rows = JSON.parse(result.stdout);
      } catch {
        throw new Error('claude agents --json did not print JSON');
      }
      if (!Array.isArray(rows)) throw new Error('claude agents --json did not print a list');
      const out = new Map<string, SessionActivity>();
      for (const row of rows) {
        if (row === null || typeof row !== 'object') continue;
        const r = row as { id?: unknown; status?: unknown; name?: unknown };
        if (typeof r.id !== 'string' || !SHORT_ID.test(r.id)) continue;
        out.set(r.id, {
          idle: r.status === 'idle',
          ...(typeof r.name === 'string' ? { name: r.name } : {}),
        });
      }
      return out;
    },

    attachedNow(configDir) {
      const dir = join(home(configDir), 'daemon', 'attach-journal');
      let names: string[];
      try {
        names = readDir(dir);
      } catch (err) {
        // No journal: no terminal has opened a session of this service.
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return Promise.resolve(false);
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      // Only `<id>.json` names an entry; Claude Code renames one it is retiring to another suffix.
      return Promise.resolve(names.some((n) => n.endsWith('.json') && attachLive(join(dir, n))));
    },

    async stop(configDir, short) {
      if (!SHORT_ID.test(short)) throw new Error(`not a background session id: ${short}`);
      await runOk(configDir, ['stop', short]);
      // Claude Code returns before the session has exited; a resume in that moment would find it
      // still running and start a copy instead.
      const deadline = clock() + stopExitTimeoutMs;
      while (stillRunning(configDir, short)) {
        if (clock() >= deadline) {
          throw new Error(
            `it was still running ${Math.round(stopExitTimeoutMs / 1000)}s after claude stop`,
          );
        }
        await sleep(STOP_EXIT_POLL_MS);
      }
    },

    savedOptions(configDir, short): Promise<SavedLaunch> {
      if (!SHORT_ID.test(short)) return Promise.resolve({ kind: 'none' });
      const found = jobRow(configDir, short);
      if (found.kind !== 'row') return Promise.resolve(found);
      if (holdsPermissionRules(found.row.sessionPermissionRules)) {
        return Promise.resolve({
          kind: 'unreplayable',
          reason: 'it holds permission rules granted while it ran, which a move cannot carry over',
        });
      }
      const replay = replayOptions(found.row.respawnFlags);
      return Promise.resolve(
        replay.ok
          ? { kind: 'replayable', options: replay.options }
          : { kind: 'unreplayable', reason: replay.reason },
      );
    },

    async resumeIdle(input) {
      if (!SESSION_ID.test(input.sessionId) || !input.sessionId.startsWith(input.short)) {
        throw new Error(`not a background session id: ${input.sessionId}`);
      }
      const args = ['--bg', '--resume', input.sessionId];
      if (input.options !== undefined) {
        // A row this config dir already holds for the session keeps its own saved options and starts
        // a copy when others are passed. It is never dropped to make way: `claude rm` deletes the
        // session's worktree and branch along with it.
        if (jobRow(input.configDir, input.short).kind !== 'none') {
          throw new Error('that config dir already holds a job row for it');
        }
        args.push(...input.options);
      }
      const result = await runOk(input.configDir, args, input.cwd);
      const output = `${result.stdout}\n${result.stderr}`;
      const copy = COPY_STARTED.exec(output);
      if (copy !== null) {
        // Claude Code forked the session under a new id instead (it counted the session as still
        // running or open somewhere, or could not check). The copy is not the session being moved:
        // stop it and fail, with Claude Code's own reason, which is what tells the cases apart.
        const short = copy[1]!;
        await runOk(input.configDir, ['stop', short]).catch(() => undefined);
        const note = output
          .split(/\r?\n/)
          .find((line) => COPY_STARTED.test(line))
          ?.trim()
          .replace(/^note:\s*/, '');
        throw new Error(
          `claude started a copy (${short}) instead of resuming it` +
            (note !== undefined && note.length > 0 ? `: ${note}` : ''),
        );
      }
    },
  };
}
