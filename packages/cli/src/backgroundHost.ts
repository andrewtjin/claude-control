// The seam to Claude Code's background service: the real {@link BackgroundSessionHost} the daemon's
// background mover drives (see the daemon's backgroundMover.ts for when and why a session moves), and
// the wider {@link ClaudeBackgroundHost} `cctl claude` reads to find where a session it is asked to
// open lives (see backgroundAttach.ts).
//
// Claude Code runs one background service per config dir (keyed on CLAUDE_CONFIG_DIR, or on
// ~/.claude when it is unset), and keeps that service's state under the config dir:
//   - `daemon/roster.json`: the workers the service hosts right now, by job id, each with the
//     conversation it was started on, its working directory and the pid of its terminal host. That
//     conversation is the id its job started with, until a job /clear moved on is woken again: its
//     worker then records the conversation it was woken into, under the same job id (measured), so
//     a worker is known by its job id alone. It also holds attach secrets; only the four fields
//     above are ever read out of it, and nothing from it is logged;
//   - `jobs/<short>/state.json`: the session's job row, with its state (`running`, `stopped`,
//     `failed`...), its name, the launch options it saved (`respawnFlags`, see {@link replayOptions}),
//     the permission rules granted while it ran (`sessionPermissionRules`), the worktree Claude Code
//     made for it (`worktreePath`), the conversation it runs now after /clear (`resumeSessionId`) and
//     the work it holds between turns (`inFlight`: a scheduled wakeup, a background task). One session
//     can have a row in several config dirs, each with its own state, name and options;
//   - `daemon/attach-journal/*.json`: one entry per terminal opening a session of the service
//     (`claude attach`, or the agent view), naming that terminal's process; Claude Code clears it
//     when the terminal leaves the session. It does not say which session.
// One file is shared instead: `sessions/<pid>.json`, the registry of every live session process,
// which every folder profile shares with the main config dir. Each entry says whether the session is
// a background one (`kind: bg`, with its job's short id) or open in a terminal (`interactive`), and
// what it is doing (`status`: `idle` between turns, `busy` in one, `waiting` on a prompt), whichever
// service hosts it. Registry and roster entries record their process's start time (`procStart`, a
// FILETIME on Windows), so a file a hard-killed process left behind is not taken for a live session
// when its pid is reused: a decision reads them verified against the operating system's start time,
// as Claude Code does. A session's conversation is `projects/<project>/<session id>.jsonl`, shared too;
// its title (what `claude --resume <name>` matches) is its last `custom-title` line, else its last
// `ai-title` line.
// Everything else is asked of Claude Code itself, run as the operator's own `claude` on PATH (the
// binary that started the service), with CLAUDE_CONFIG_DIR naming the service to talk to:
//   - `claude agents --json`: every session with its status; the listing spans every working
//     directory;
//   - `claude stop <short>`: stops it. It returns a moment before the session has exited, so the
//     host waits until the registry and the roster no longer hold it;
//   - `claude --bg --resume <session id> [options]` with no prompt: resumes it idle under that
//     config dir's service ("idle — send a prompt to start"), or prints that it started a copy;
//   - `claude rm <short>`: deletes the job row and keeps the conversation (measured: the transcript is
//     unchanged), but also deletes a worktree recorded on the row, and kills the session when it is
//     live or starting (a wake shows its worker in the roster a moment before its registry entry).
//     So it is run only on a row that records no worktree, for a session no registry entry and no
//     roster holds, read verified right before it runs.
// These shapes were measured against Claude Code 2.1.295 and again against 2.1.296; anything else
// is read defensively, and an unexpected answer fails the operation rather than guessing. Every
// command runs detached from the operator's terminal, so a Ctrl-C there cannot cut one off half way.
// What cctl keeps of its own beside the move locks: one recovery per move that has committed and not
// yet seen the session run again (see the daemon's ResumeRecovery), so `cctl claude --resume <id>`
// can bring back a session whose move was cut off, its process gone with it. One is read back only
// when it names a config dir of cctl's and options as a move saves them, and for a week at most.

import { randomUUID } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve as resolvePath } from 'node:path';
import {
  JOB_ID_PATTERN,
  SESSION_ID_PATTERN,
  reasonOf,
  sameConfigDir,
  type BackgroundSession,
  type BackgroundSessionHost,
  type JobRow,
  type LiveSession,
  type ResumeRecovery,
  type RowRead,
  type SavedLaunch,
  type SessionActivity,
  type SessionLock,
} from '@claude-control/daemon';
import {
  LockTimeoutError,
  acquireLock,
  profilesRoot,
  type Paths,
} from '@claude-control/switch-engine';
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

export type { JobRow, LiveSession } from '@claude-control/daemon';

/** The host `cctl claude` reads to find where a background session lives (see
 *  backgroundAttach.ts): the daemon's seam, plus what only an operator's launch needs. */
export interface ClaudeBackgroundHost extends BackgroundSessionHost {
  /** A session's title, as `claude --resume <name>` matches it, or undefined when it has none or
   *  its conversation cannot be found. Reads the whole conversation. */
  sessionTitle(sessionId: string): Promise<string | undefined>;
  /** The title of every conversation filed under these folders' projects, by session id: what
   *  `claude --resume <name>` searches among. Read cheaply (the head and tail of each conversation,
   *  where Claude Code writes a title and re-writes it on exit), so a title set mid-conversation of
   *  a session that has not exited since can be missed. */
  titlesIn(folders: readonly string[]): Promise<Map<string, string>>;
  /** Whether the attach journal of a config dir's service shows the terminal of this process
   *  (the one `cctl claude` started) right now. */
  attachedBy(configDir: string | null, pid: number): Promise<boolean>;
  /** The CLAUDE_CONFIG_DIR that reaches a config dir's service, or undefined for none (the main
   *  config dir at its default place): a launch there is run with exactly this. */
  configEnv(configDir: string | null): string | undefined;
  /** The recovery a committed move saved for a conversation and has not dropped (see the daemon's
   *  saveRecovery), or undefined for none or one that cannot be read. */
  recoveryOf(sessionId: string): Promise<ResumeRecovery | undefined>;
}

/** How a host reaches the main config dir, from the paths cctl resolved: the dir itself, and
 *  whether Claude Code reaches it through CLAUDE_CONFIG_DIR, which is so exactly when its
 *  `.claude.json` lives inside it (the default `~/.claude` keeps it beside it, as `~/.claude.json`). */
export function mainConfigOf(paths: { claudeDir: string; claudeJsonPath: string }): {
  mainConfigDir: string;
  mainConfigDirInEnv: boolean;
} {
  return {
    mainConfigDir: paths.claudeDir,
    mainConfigDirInEnv: resolvePath(dirname(paths.claudeJsonPath)) === resolvePath(paths.claudeDir),
  };
}

export interface ClaudeBackgroundHostOptions {
  /** The main config dir: the global slot's, which a `null` config dir names. */
  mainConfigDir: string;
  /**
   * Whether Claude Code reaches the main config dir through CLAUDE_CONFIG_DIR (a main dir set by
   * that variable) rather than with it unset (the default `~/.claude`, whose `.claude.json` sits
   * beside it, not in it: naming it in CLAUDE_CONFIG_DIR would be another config). Default: whether
   * this process's environment sets it.
   */
  mainConfigDirInEnv?: boolean;
  /** Where the cross-process move locks live, one per session id (see {@link moveLocksDir}), and,
   *  in its `recovery` folder, each committed move's recovery. */
  moveLockDir: string;
  /** cctl's folder profiles root: every directory in it is a config dir with a service. */
  profilesRoot?: string;
  /** The environment Claude Code is run with (default: this process's). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How Claude Code is run (default: the `claude` on PATH, without a shell). */
  run?: RunClaude;
  readFile?: (path: string) => string;
  /** Write a file whole, so a reader never sees half of it (default: a temp file beside it renamed
   *  into place, its folder made first). */
  writeFile?: (path: string, text: string) => void;
  /** Remove a file; one that is not there is no error. */
  removeFile?: (path: string) => void;
  /** The head and the tail of a conversation, where its title lines are (default: read from disk,
   *  {@link TITLE_WINDOW_BYTES} of each end); undefined when it cannot be read. */
  readEnds?: (path: string) => string | undefined;
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
  /** The operating system's start time of each live process, as Claude Code records one
   *  (`procStart`); a process it cannot read is left out (default: one Get-Process call on Windows,
   *  one `ps` call elsewhere). */
  processStarts?: (pids: readonly number[]) => Promise<Map<number, string>>;
  /** How often a held move lock's claim is refreshed (default {@link MOVE_LOCK_REFRESH_MS}). */
  lockRefreshMs?: number;
  /** The wall clock in ms (default `Date.now`), for how old a saved recovery is: it outlives this
   *  process, so no clock of this process's own can tell. */
  now?: () => number;
}

/** Where the move locks live under cctl's data dir (the vault dir's parent). */
export function moveLocksDir(dataDir: string): string {
  return join(dataDir, 'background-moves');
}

/**
 * The options the daemon's host and `cctl claude`'s are both built with, from the paths cctl
 * resolved: the main config dir exactly as Claude Code reaches it (a CLAUDE_CONFIG_DIR naming a
 * folder profile, as inside a profile's session, already seen through to it, and never taken for
 * the main dir's own), the move locks and recoveries under cctl's data dir, and the profiles root,
 * which lists every config dir a session can hold a job row in. Both processes reading, locking and
 * removing rows alike is what keeps them from moving one session at once, or leaving a row behind.
 */
export function backgroundHostOptions(
  paths: Pick<Paths, 'claudeDir' | 'claudeJsonPath' | 'vaultDir'>,
): ClaudeBackgroundHostOptions {
  return {
    ...mainConfigOf(paths),
    moveLockDir: moveLocksDir(dirname(paths.vaultDir)),
    profilesRoot: profilesRoot(paths.vaultDir),
  };
}

/** How long one Claude Code command may run. A resume returns once the session is dispatched, in
 *  about a second when the service is up and a few when it has to start. */
const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

/** Measured: a stopped session leaves the registry about a second after `claude stop` returns, and
 *  its terminal host leaves the roster a moment later. Ten seconds is far past that on a loaded box,
 *  and short of anything the operator would wait out. */
const DEFAULT_STOP_EXIT_TIMEOUT_MS = 10_000;
const STOP_EXIT_POLL_MS = 100;
/** A move lock whose claim has not been refreshed for this long is presumed dead even when its
 *  process looks alive (a reused pid). A live holder refreshes its claim every
 *  {@link MOVE_LOCK_REFRESH_MS} for as long as it holds it, however long that is (a move that waits
 *  on Claude Code, then the hold until a terminal shows up), so no live holder ever outlives it; a
 *  holder that died is noticed at once by its pid. */
export const MOVE_LOCK_STALE_MS = 2 * 60_000;
export const MOVE_LOCK_REFRESH_MS = 20_000;
const MOVE_LOCK_POLL_MS = 250;
/** How long a process's start time is taken as read (Claude Code keeps its own reads a minute). */
const START_TIME_TTL_MS = 60_000;
/** How long the start-time query may take before every start it was to read counts as unknown. */
const START_QUERY_TIMEOUT_MS = 10_000;
/** How much of each end of a conversation a title search reads. */
const TITLE_WINDOW_BYTES = 64 * 1024;
/** How long a committed move's recovery is kept. A move cut off is brought back within days if at
 *  all; an older recovery may name a config dir, a row or options the session has long left, and
 *  without one `cctl claude --resume <id>` resumes the conversation as Claude Code does, which loses
 *  nothing of it. */
const RECOVERY_LIFETIME_MS = 7 * 24 * 60 * 60_000;

const SHORT_ID = JOB_ID_PATTERN;
const SESSION_ID = SESSION_ID_PATTERN;
/** How Claude Code says a resume started a copy instead (every reason it gives ends this way). */
const COPY_STARTED = /started a (?:restricted )?copy(?: of that conversation)? as ([0-9a-f]{8})/;

/**
 * The launch options Claude Code saves in a job row (`respawnFlags`), by how it reads them: options
 * taking a value, those of them taking several, and switches. These are Claude Code 2.1.295's own
 * lists of what it saves, so a row holds only these and their values. Claude Code drops every other
 * word when it saves, the session's first prompt among them, except that every word after an option
 * taking several values is saved as one of its values: that is how Claude Code read them at launch
 * too, so they ARE its values, and a replay keeps them so. `cctl claude` reads its arguments by the
 * value options too (see backgroundAttach.ts).
 */
export const SAVED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
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
export const SAVED_LIST_OPTIONS: ReadonlySet<string> = new Set([
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
export const SHORT_OPTIONS: ReadonlyMap<string, string> = new Map([['-n', '--name']]);
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

/**
 * Whether a row's `inFlight` record holds work between turns: a scheduled wakeup, a background task
 * or monitor, a queued prompt. Claude Code writes an empty record (`tasks: 0`, no `wake`) for a
 * session holding none; anything else, read or not, counts as work a stop would drop.
 */
export function holdsPendingWork(inFlight: unknown): boolean {
  if (inFlight === undefined || inFlight === null) return false;
  if (typeof inFlight !== 'object' || Array.isArray(inFlight)) return true;
  const f = inFlight as Record<string, unknown>;
  const count = (v: unknown): boolean => v !== undefined && v !== 0;
  const kinds = f.kinds;
  return (
    count(f.tasks) ||
    count(f.queued) ||
    count(f.drainableMonitors) ||
    f.wake !== undefined ||
    (kinds !== undefined && (!Array.isArray(kinds) || kinds.length > 0))
  );
}

/**
 * Whether a process's start time, as the operating system reports it now, is the one Claude Code
 * recorded for it, by Claude Code's own rule: equal, or not comparable (nothing read now; or, on
 * Windows, one a FILETIME and the other .NET ticks, told apart by size), which counts as the same.
 */
export function sameProcessStart(
  recorded: string,
  actual: string | undefined,
  platform: NodeJS.Platform,
): boolean {
  if (actual === undefined || actual === recorded) return true;
  if (platform !== 'win32') return false;
  const r = Number(recorded);
  const a = Number(actual);
  return Number.isFinite(r) && Number.isFinite(a) && r > 3e17 !== a > 3e17;
}

/** Read live processes' start times in one call: `Get-Process` on Windows (each a FILETIME, as
 *  Claude Code records it there), `ps -o lstart` elsewhere (as Claude Code reads it, in UTC and the
 *  C locale). A process that cannot be read, or a query that fails, is left out. */
function defaultProcessStarts(
  platform: NodeJS.Platform,
): (pids: readonly number[]) => Promise<Map<number, string>> {
  return (pids) =>
    new Promise((resolve) => {
      const out = new Map<number, string>();
      const list = pids.filter((pid) => Number.isInteger(pid) && pid > 0).join(',');
      if (list === '') {
        resolve(out);
        return;
      }
      const [command, args, env]: [string, string[], NodeJS.ProcessEnv] =
        platform === 'win32'
          ? [
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                `Get-Process -Id ${list} -ErrorAction SilentlyContinue | ` +
                  'ForEach-Object { "$($_.Id) $($_.StartTime.ToFileTimeUtc())" }',
              ],
              process.env,
            ]
          : ['ps', ['-o', 'pid=,lstart=', '-p', list], { ...process.env, LC_ALL: 'C', TZ: 'UTC' }];
      let text = '';
      let child;
      try {
        child = nodeSpawn(command, args, {
          env,
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: false,
          windowsHide: true,
          detached: true,
        });
      } catch {
        resolve(out);
        return;
      }
      const timer = setTimeout(() => child.kill(), START_QUERY_TIMEOUT_MS);
      child.stdout.setEncoding('utf8').on('data', (c: string) => (text += c));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(out);
      });
      child.on('close', () => {
        clearTimeout(timer);
        for (const line of text.split(/\r?\n/)) {
          const m = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
          if (m !== null) out.set(Number(m[1]), m[2]!);
        }
        resolve(out);
      });
    });
}

/** The `projects/` dir name Claude Code files a folder's conversations under: every character that
 *  is not a letter or digit becomes `-`. Past 200 characters Claude Code keeps the first 200 and
 *  adds a hash of the rest, which is not reproduced here: such a folder is matched by that prefix. */
export function projectDirName(folder: string): { exact: string } | { prefix: string } {
  const name = folder.replace(/[^A-Za-z0-9]/g, '-');
  return name.length <= 200 ? { exact: name } : { prefix: `${name.slice(0, 200)}-` };
}

/** The head and the tail of a file, at most {@link TITLE_WINDOW_BYTES} each: where a conversation's
 *  title lines are. Undefined when it cannot be read. */
function headAndTail(path: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = statSync(path).size;
    const read = (at: number, length: number): string => {
      const buf = Buffer.alloc(length);
      const n = readSync(fd!, buf, 0, length, at);
      return buf.subarray(0, n).toString('utf8');
    };
    if (size <= 2 * TITLE_WINDOW_BYTES) return read(0, size);
    return `${read(0, TITLE_WINDOW_BYTES)}\n${read(size - TITLE_WINDOW_BYTES, TITLE_WINDOW_BYTES)}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
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
      // Detached: a Ctrl-C in the operator's terminal reaches the terminal's own process group (on
      // Windows, every process attached to its console), and must never cut a stop, a row removal
      // or a resume off half way.
      const child = nodeSpawn(t.command, [...t.prefixArgs, ...args], {
        env: opts.env,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
        detached: true,
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

/** Write a file whole: a temp file beside it, renamed into place, so a reader never sees half of
 *  it; its folder is made first. */
function writeFileWhole(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, text);
    renameSync(temp, path);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
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

/** A session's title from its conversation: the last `custom-title` line, else the last
 *  `ai-title` line (Claude Code re-appends both, and the last one wins). Only lines naming one are
 *  parsed: a conversation runs to megabytes. */
export function titleOfTranscript(transcript: string): string | undefined {
  let custom: string | undefined;
  let ai: string | undefined;
  for (const line of transcript.split('\n')) {
    if (!line.includes('-title"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry === null || typeof entry !== 'object') continue;
    const e = entry as { type?: unknown; customTitle?: unknown; aiTitle?: unknown };
    if (e.type === 'custom-title') custom = nonEmpty(e.customTitle) ?? custom;
    else if (e.type === 'ai-title') ai = nonEmpty(e.aiTitle) ?? ai;
  }
  return custom ?? ai;
}

/** Build the host for the daemon, or for `cctl claude`. */
export function createClaudeBackgroundHost(
  options: ClaudeBackgroundHostOptions,
): ClaudeBackgroundHost {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunClaude(platform, baseEnv);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const writeWhole = options.writeFile ?? writeFileWhole;
  const removeFile = options.removeFile ?? ((p: string) => rmSync(p, { force: true }));
  const readDir = options.readDir ?? ((p: string) => readdirSync(p));
  const readEnds = options.readEnds ?? headAndTail;
  const isAlive = options.isProcessAlive ?? pidIsAlive;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const clock = options.clock ?? (() => performance.now());
  const stopExitTimeoutMs = options.stopExitTimeoutMs ?? DEFAULT_STOP_EXIT_TIMEOUT_MS;
  const processStarts = options.processStarts ?? defaultProcessStarts(platform);
  const lockRefreshMs = options.lockRefreshMs ?? MOVE_LOCK_REFRESH_MS;
  const wallClock = options.now ?? Date.now;
  const mainInEnv = options.mainConfigDirInEnv ?? baseEnv.CLAUDE_CONFIG_DIR !== undefined;

  /** The names in a directory, or none for one that does not exist or cannot be listed. */
  const namesIn = (dir: string): string[] => {
    try {
      return readDir(dir);
    } catch {
      return [];
    }
  };

  /** The names in a directory: none for one that does not exist; a directory that exists but
   *  cannot be listed throws, so it is never read as empty. */
  const namesInStrict = (dir: string): string[] => {
    try {
      return readDir(dir);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw err instanceof Error ? err : new Error(String(err));
    }
  };

  /** The config dir whose files describe a service: the named one, or the main one. */
  const home = (configDir: string | null): string => configDir ?? options.mainConfigDir;

  /** The value of CLAUDE_CONFIG_DIR that reaches a config dir's service, or undefined for none:
   *  the main config dir is reached exactly as a plain `claude` reaches it (see
   *  {@link ClaudeBackgroundHostOptions.mainConfigDirInEnv}). */
  const configEnv = (configDir: string | null): string | undefined =>
    configDir ?? (mainInEnv ? options.mainConfigDir : undefined);

  /** The environment for a command against a config dir's service: this process's, minus session
   *  markers and any CLAUDE_CONFIG_DIR it inherited, with the one that names that service. One main
   *  config dir for every read and every command: the files read are the service talked to. */
  const envFor = (configDir: string | null): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...baseEnv };
    for (const key of SESSION_MARKERS) delete env[key];
    delete env.CLAUDE_CONFIG_DIR;
    const named = configEnv(configDir);
    if (named !== undefined) env.CLAUDE_CONFIG_DIR = named;
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

  /** A process's start time as last read, by pid, and when it was read. */
  const startCache = new Map<number, { at: number; start: string | undefined }>();
  /** The start time of each of these live processes now (cached a while, as Claude Code does);
   *  one that cannot be read is undefined. Reads past their time are dropped first, so a host that
   *  lives as long as the daemon keeps only the processes it read lately. */
  const startsOf = async (pids: readonly number[]): Promise<Map<number, string | undefined>> => {
    const now = clock();
    for (const [pid, hit] of startCache) {
      if (now - hit.at > START_TIME_TTL_MS) startCache.delete(pid);
    }
    const stale = pids.filter((pid) => {
      const hit = startCache.get(pid);
      return hit === undefined || now - hit.at > START_TIME_TTL_MS;
    });
    if (stale.length > 0) {
      const read = await processStarts(stale).catch(() => new Map<number, string>());
      for (const pid of stale) startCache.set(pid, { at: now, start: read.get(pid) });
    }
    return new Map(pids.map((pid) => [pid, startCache.get(pid)?.start]));
  };

  /** Of these records of live processes, the ones whose process is the one recorded: alive, and,
   *  when `verified`, started when Claude Code recorded it starting. */
  const stillTheirs = async <T extends { pid: number; procStart?: string }>(
    records: readonly T[],
    verified: boolean,
  ): Promise<T[]> => {
    const alive = records.filter((r) => isAlive(r.pid));
    if (!verified) return alive;
    const starts = await startsOf(alive.filter((r) => r.procStart !== undefined).map((r) => r.pid));
    return alive.filter(
      (r) =>
        r.procStart === undefined || sameProcessStart(r.procStart, starts.get(r.pid), platform),
    );
  };

  /** The start time Claude Code recorded for a process, as it reads one back. */
  const recordedStart = (e: { procStartFt?: unknown; procStart?: unknown }): string | undefined =>
    nonEmpty(e.procStartFt) ?? nonEmpty(e.procStart);

  /** A config dir's job row file for a short id, as written: none, one that cannot be read right
   *  now (caught mid-write, locked, or not a JSON object), or its fields. */
  const rawRow = (
    configDir: string | null,
    short: string,
  ): { kind: 'none' } | { kind: 'unreadable' } | { kind: 'raw'; raw: Record<string, unknown> } => {
    let text: string;
    try {
      text = readFile(join(home(configDir), 'jobs', short, 'state.json'));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOENT' || code === 'ENOTDIR' ? { kind: 'none' } : { kind: 'unreadable' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { kind: 'unreadable' };
    }
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { kind: 'raw', raw: parsed as Record<string, unknown> }
      : { kind: 'unreadable' };
  };

  /** A config dir's job row for a session: none, one that cannot be read right now (see
   *  {@link rawRow}, or one that is not a session's), or the row. */
  const jobRow = (configDir: string | null, short: string): RowRead => {
    const found = rawRow(configDir, short);
    if (found.kind !== 'raw') return found;
    const row = toJobRow(short, found.raw);
    return row === undefined ? { kind: 'unreadable' } : { kind: 'row', row };
  };

  /** A row's fields as cctl reads them, or undefined for a row that is not one of a session (a
   *  session id that is not this short's, or no state). */
  const toJobRow = (short: string, raw: Record<string, unknown>): JobRow | undefined => {
    const sessionId = raw.sessionId;
    const state = nonEmpty(raw.state);
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return undefined;
    if (!sessionId.startsWith(short) || state === undefined) return undefined;
    const resumeSessionId = nonEmpty(raw.resumeSessionId);
    const name = nonEmpty(raw.name);
    const cwd = nonEmpty(raw.cwd);
    const updatedAt = nonEmpty(raw.updatedAt);
    const worktreePath = nonEmpty(raw.worktreePath);
    return {
      short,
      sessionId,
      state,
      pending: holdsPendingWork(raw.inFlight),
      ...(resumeSessionId !== undefined && SESSION_ID.test(resumeSessionId)
        ? { resumeSessionId }
        : {}),
      ...(name !== undefined ? { name } : {}),
      ...(cwd !== undefined ? { cwd } : {}),
      ...(updatedAt !== undefined ? { updatedAt } : {}),
      ...(worktreePath !== undefined ? { worktreePath } : {}),
    };
  };

  /** The attach journal entries of a config dir's service that name a terminal still running, by
   *  that terminal's pid. Claude Code records the terminal's process before it writes an entry, and
   *  leaves `{}` where it cleared one, so an entry naming no process names no terminal. One that
   *  cannot be read (caught mid-write) is returned as `torn`: it may be anyone's. */
  const journal = (configDir: string | null): { pids: number[]; torn: boolean } => {
    const dir = join(home(configDir), 'daemon', 'attach-journal');
    const pids: number[] = [];
    let torn = false;
    // A journal that does not exist: no terminal has opened a session of this service. One that
    // exists but cannot be listed throws.
    for (const name of namesInStrict(dir)) {
      // Only `<id>.json` names an entry; Claude Code renames one it is retiring to another suffix.
      if (!name.endsWith('.json')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(readFile(join(dir, name)));
      } catch (err) {
        // Gone since the listing: that terminal has left.
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') torn = true;
        continue;
      }
      const pid =
        entry !== null && typeof entry === 'object' ? (entry as { pid?: unknown }).pid : undefined;
      if (typeof pid === 'number' && Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        pids.push(pid);
      }
    }
    return { pids, torn };
  };

  /** The sessions a config dir's service hosts, from its roster (see the header), each by its job id
   *  (the roster's key) with the conversation its worker records, which need not start with that id.
   *  No roster (no service ever ran there) is nothing hosted; one that cannot be read right now
   *  (caught mid-write) throws, so it is never read as nothing hosted. */
  const readHosted = async (
    configDir: string | null,
    verified: boolean,
  ): Promise<BackgroundSession[]> => {
    const path = join(home(configDir), 'daemon', 'roster.json');
    let text: string;
    try {
      text = readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw new Error(`the background service roster at ${path} could not be read`);
    }
    let roster: unknown;
    try {
      roster = JSON.parse(text);
    } catch {
      throw new Error(`the background service roster at ${path} could not be read`);
    }
    if (roster === null || typeof roster !== 'object' || Array.isArray(roster)) {
      throw new Error(`the background service roster at ${path} could not be read`);
    }
    const workers = (roster as { workers?: unknown }).workers;
    // A roster with no workers yet hosts nothing.
    if (workers === undefined) return [];
    if (workers === null || typeof workers !== 'object' || Array.isArray(workers)) {
      throw new Error(`the background service roster at ${path} could not be read`);
    }
    const found: Array<BackgroundSession & { pid: number; procStart?: string }> = [];
    for (const [short, raw] of Object.entries(workers as Record<string, unknown>)) {
      if (!SHORT_ID.test(short) || raw === null || typeof raw !== 'object') continue;
      const w = raw as Record<string, unknown>;
      const sessionId = w.sessionId;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) continue;
      const cwd = nonEmpty(w.cwd);
      if (cwd === undefined) continue;
      // A roster left behind by a service that died still names its workers; only a live terminal
      // host (the very process recorded, when verified) means the session is really hosted there.
      if (typeof w.pid !== 'number' || !Number.isInteger(w.pid) || w.pid <= 0) continue;
      const procStart = recordedStart(w);
      found.push({ short, sessionId, cwd, pid: w.pid, ...(procStart ? { procStart } : {}) });
    }
    return (await stillTheirs(found, verified)).map(({ short, sessionId, cwd }) => ({
      short,
      sessionId,
      cwd,
    }));
  };

  /** The live entries of the shared session registry (see the header). It sits in the main config
   *  dir, and every folder profile links its own `sessions/` there. An entry left by a process that
   *  has exited is skipped (Claude Code removes its own on a clean exit, not on a hard kill), and so
   *  is one naming no kind of session. An entry of a live process that cannot be read right now
   *  (caught mid-write) throws when `strict`: it could be the session asked about. */
  const readRegistry = async (verified: boolean, strict: boolean): Promise<LiveSession[]> => {
    const dir = join(options.mainConfigDir, 'sessions');
    const found: Array<LiveSession & { procStart?: string }> = [];
    for (const file of strict ? namesInStrict(dir) : namesIn(dir)) {
      const m = /^(\d+)\.json$/.exec(file);
      if (m === null) continue;
      const e = readObject(readFile, join(dir, file));
      if (e === undefined) {
        if (strict && isAlive(Number(m[1]))) {
          throw new Error('a live session registry entry could not be read right now');
        }
        continue;
      }
      const pid = e.pid;
      const sessionId = e.sessionId;
      const kind = nonEmpty(e.kind);
      if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) continue;
      if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || kind === undefined) {
        continue;
      }
      const jobId = nonEmpty(e.jobId);
      const status = nonEmpty(e.status);
      const name = nonEmpty(e.name);
      const cwd = nonEmpty(e.cwd);
      const procStart = recordedStart(e);
      found.push({
        pid,
        sessionId,
        kind,
        ...(status !== undefined ? { status } : {}),
        ...(jobId !== undefined && SHORT_ID.test(jobId) ? { jobId } : {}),
        ...(name !== undefined ? { name } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        ...(procStart !== undefined ? { procStart } : {}),
      });
    }
    return (await stillTheirs(found, verified)).map(({ procStart: _start, ...entry }) => entry);
  };

  /** Whether a session (by short id) still runs anywhere: in the registry, or in the roster of the
   *  service that hosted it. The registry entry goes first and the terminal host a moment later. A
   *  roster caught mid-write counts as still running: the wait goes on. Cheap, as it is polled. */
  const stillRunning = async (configDir: string | null, short: string): Promise<boolean> => {
    if (
      (await readRegistry(false, false)).some(
        (e) => e.jobId === short || e.sessionId.startsWith(short),
      )
    ) {
      return true;
    }
    return readHosted(configDir, false).then(
      (hosted) => hosted.some((s) => s.short === short),
      () => true,
    );
  };

  /** Every config dir with a service: the main one, then each folder profile. A profile is a
   *  directory named after its rule's id; anything else in the profiles root is not one. */
  const configDirsNow = (): Array<string | null> => {
    const root = options.profilesRoot;
    if (root === undefined) return [null];
    return [
      null,
      ...namesIn(root)
        .filter((name) => /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
        .map((name) => join(root, name)),
    ];
  };

  /** Refuse while a session runs or is starting anywhere, read verified: a background registry
   *  entry for its job id or either of its ids (what Claude Code's rm reaches it by), or a worker for
   *  it in any service's roster (a session being woken is listed there a moment before its registry
   *  entry is written). Anything that cannot be read right now refuses too. */
  const refuseWhileLive = async (short: string, ids: readonly string[]): Promise<void> => {
    const live = (await readRegistry(true, true)).some(
      (e) => e.kind === 'bg' && (e.jobId === short || ids.includes(e.sessionId)),
    );
    if (live) throw new Error('its session is live, and claude rm would kill it');
    for (const configDir of configDirsNow()) {
      const hosted = await readHosted(configDir, true);
      if (hosted.some((w) => w.short === short || ids.includes(w.sessionId))) {
        throw new Error(
          'its session is starting or live in a service, and claude rm would kill it',
        );
      }
    }
  };

  /** The row of a short id, as `claude rm` would find it, refused unless rm takes only the row: it
   *  must be readable, record no worktree, and not be one Claude Code is waking right now. */
  const removableRow = (configDir: string | null, short: string): JobRow | undefined => {
    const found = jobRow(configDir, short);
    if (found.kind === 'none') return undefined;
    if (found.kind === 'unreadable') throw new Error('its job row could not be read right now');
    // `claude rm` deletes a worktree recorded on the row.
    if (found.row.worktreePath !== undefined) {
      throw new Error('its job row records a git worktree, which claude rm would delete');
    }
    if (found.row.state === 'starting') {
      throw new Error('its session is starting, and claude rm would kill it');
    }
    return found.row;
  };

  /** Where a conversation's recovery is kept: one file per conversation, beside the move locks. */
  const recoveryDir = join(options.moveLockDir, 'recovery');
  const recoveryPath = (sessionId: string): string => join(recoveryDir, `${sessionId}.json`);

  /** A saved recovery for a conversation, as read back: every field what a move saves, or nothing.
   *  Its config dir must be one of cctl's (the main one, or a folder profile), and its options
   *  options exactly as a move saves them (see {@link replayOptions}): the way back resumes the
   *  session there with them, so no word of a record that is anything else may reach it. */
  const recoveryFrom = (
    r: Record<string, unknown>,
    sessionId: string,
  ): ResumeRecovery | undefined => {
    const { configDir, cwd, options } = r;
    const job = r.job as { short?: unknown; sessionId?: unknown } | null | undefined;
    if (r.sessionId !== sessionId || typeof cwd !== 'string' || cwd.length === 0) return undefined;
    const cctls =
      configDir === null ||
      (typeof configDir === 'string' &&
        configDirsNow().some((c) => c !== null && sameConfigDir(c, configDir, platform)));
    if (!cctls) return undefined;
    const replay = replayOptions(options);
    if (
      !Array.isArray(options) ||
      !replay.ok ||
      replay.options.length !== options.length ||
      replay.options.some((o, i) => o !== options[i])
    ) {
      return undefined;
    }
    if (
      typeof job !== 'object' ||
      job === null ||
      typeof job.short !== 'string' ||
      !SHORT_ID.test(job.short) ||
      typeof job.sessionId !== 'string' ||
      !SESSION_ID.test(job.sessionId) ||
      !job.sessionId.startsWith(job.short)
    ) {
      return undefined;
    }
    return {
      configDir,
      sessionId,
      job: { short: job.short, sessionId: job.sessionId },
      options: replay.options,
      cwd,
    };
  };

  return {
    configDirs() {
      return Promise.resolve(configDirsNow());
    },

    liveSessions() {
      return readRegistry(true, true);
    },

    jobRows(configDir, opts) {
      const jobs = join(home(configDir), 'jobs');
      const out: JobRow[] = [];
      try {
        for (const short of namesInStrict(jobs)) {
          if (!SHORT_ID.test(short)) continue;
          const found = rawRow(configDir, short);
          // A row that cannot be read right now, read strictly, could be any session's. One that
          // reads whole but is no session's row (no state, another id) is never one Claude Code
          // wakes, so it is skipped either way, rather than refuse every check for good.
          if (found.kind === 'unreadable' && opts?.strict === true) {
            throw new Error(`its job row ${short} there could not be read right now`);
          }
          const row = found.kind === 'raw' ? toJobRow(short, found.raw) : undefined;
          if (row !== undefined) out.push(row);
        }
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      return Promise.resolve(out);
    },

    jobRow(configDir, short) {
      if (!SHORT_ID.test(short)) return Promise.resolve({ kind: 'none' });
      return Promise.resolve(jobRow(configDir, short));
    },

    sessionTitle(sessionId) {
      if (!SESSION_ID.test(sessionId)) return Promise.resolve(undefined);
      const projects = join(options.mainConfigDir, 'projects');
      for (const project of namesIn(projects)) {
        let transcript: string;
        try {
          transcript = readFile(join(projects, project, `${sessionId}.jsonl`));
        } catch {
          continue;
        }
        return Promise.resolve(titleOfTranscript(transcript));
      }
      return Promise.resolve(undefined);
    },

    titlesIn(folders) {
      const projects = join(options.mainConfigDir, 'projects');
      const all = namesIn(projects);
      const dirs = new Set<string>();
      for (const folder of folders) {
        const name = projectDirName(folder);
        for (const dir of all) {
          if ('exact' in name ? dir === name.exact : dir.startsWith(name.prefix)) dirs.add(dir);
        }
      }
      const out = new Map<string, string>();
      for (const dir of dirs) {
        for (const file of namesIn(join(projects, dir))) {
          const sessionId = file.endsWith('.jsonl') ? file.slice(0, -'.jsonl'.length) : '';
          if (!SESSION_ID.test(sessionId)) continue;
          const text = readEnds(join(projects, dir, file));
          const title = text === undefined ? undefined : titleOfTranscript(text);
          if (title !== undefined) out.set(sessionId, title);
        }
      }
      return Promise.resolve(out);
    },

    async lockSession(sessionId, waitMs): Promise<SessionLock | undefined> {
      // The id names the lock's directory, so only a session id may.
      if (!SESSION_ID.test(sessionId)) throw new Error(`not a background session id: ${sessionId}`);
      let lock;
      try {
        lock = await acquireLock(join(options.moveLockDir, sessionId), Date.now, {
          timeoutMs: waitMs,
          pollMs: MOVE_LOCK_POLL_MS,
          staleMs: MOVE_LOCK_STALE_MS,
        });
      } catch (err) {
        if (err instanceof LockTimeoutError) return undefined;
        throw err;
      }
      // Kept fresh for as long as it is held, however long that is; unref'd so a held lock never
      // keeps the process alive on its own. A claim no longer this holder's (reclaimed, released)
      // is not refreshed again, so no timer outlives the lock it serves.
      const refresher = setInterval(() => {
        if (!lock.refresh()) clearInterval(refresher);
      }, lockRefreshMs);
      refresher.unref();
      return {
        release: () => {
          clearInterval(refresher);
          lock.release();
        },
      };
    },

    listHosted(configDir, opts) {
      return readHosted(configDir, opts?.verified === true);
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
      try {
        const { pids, torn } = journal(configDir);
        // An entry caught mid-write counts as open: a stop under someone cannot be taken back.
        return Promise.resolve(pids.length > 0 || torn);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    attachedBy(configDir, pid) {
      try {
        return Promise.resolve(journal(configDir).pids.includes(pid));
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    async stop(configDir, short) {
      if (!SHORT_ID.test(short)) throw new Error(`not a background session id: ${short}`);
      await runOk(configDir, ['stop', short]);
      // Claude Code returns before the session has exited; a resume in that moment would find it
      // still running and start a copy instead.
      const deadline = clock() + stopExitTimeoutMs;
      while (await stillRunning(configDir, short)) {
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
      const found = rawRow(configDir, short);
      if (found.kind !== 'raw') return Promise.resolve(found);
      const raw = found.raw;
      if (holdsPermissionRules(raw.sessionPermissionRules)) {
        return Promise.resolve({
          kind: 'unreplayable',
          reason: 'it holds permission rules granted while it ran, which a move cannot carry over',
        });
      }
      const replay = replayOptions(raw.respawnFlags);
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
        // a copy when others are passed: the caller removes it first, or wakes it with its own.
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
        // stop it, under the config dir that started it, and fail with Claude Code's own reason,
        // which is what tells the cases apart. A copy that cannot be stopped is said too: it would
        // otherwise run on unnoticed.
        const short = copy[1]!;
        const stopped = await runOk(input.configDir, ['stop', short]).then(
          () => '',
          (err: unknown) => `; the copy could not be stopped (${reasonOf(err)})`,
        );
        const note = output
          .split(/\r?\n/)
          .find((line) => COPY_STARTED.test(line))
          ?.trim()
          .replace(/^note:\s*/, '');
        throw new Error(
          `claude started a copy (${short}) instead of resuming it` +
            (note !== undefined && note.length > 0 ? `: ${note}` : '') +
            stopped,
        );
      }
    },

    async removeRow(configDir, short) {
      if (!SHORT_ID.test(short)) throw new Error(`not a background session id: ${short}`);
      const row = removableRow(configDir, short);
      if (row === undefined) return;
      const ids = [
        row.sessionId,
        ...(row.resumeSessionId !== undefined ? [row.resumeSessionId] : []),
      ];
      await refuseWhileLive(short, ids);
      // Read again right before the rm: a wake can land between the reads, and rm would kill what
      // it starts.
      if (removableRow(configDir, short) === undefined) return;
      await refuseWhileLive(short, ids);
      await runOk(configDir, ['rm', short]);
    },

    configEnv,

    saveRecovery(recovery) {
      if (!SESSION_ID.test(recovery.sessionId)) {
        return Promise.reject(new Error(`not a background session id: ${recovery.sessionId}`));
      }
      try {
        // When it was saved, so it is kept a bounded while (see RECOVERY_LIFETIME_MS).
        writeWhole(
          recoveryPath(recovery.sessionId),
          JSON.stringify({ ...recovery, savedAt: wallClock() }),
        );
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    dropRecovery(sessionId) {
      if (!SESSION_ID.test(sessionId)) return Promise.resolve();
      try {
        removeFile(recoveryPath(sessionId));
        return Promise.resolve();
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
    },

    recoveryOf(sessionId) {
      if (!SESSION_ID.test(sessionId)) return Promise.resolve(undefined);
      const path = recoveryPath(sessionId);
      const r = readObject(readFile, path);
      const recovery = r === undefined ? undefined : recoveryFrom(r, sessionId);
      if (r === undefined || recovery === undefined) return Promise.resolve(undefined);
      // Kept a bounded while either way of this clock (one saved "later" than now is as unknown as
      // one saved long ago); past it, it is forgotten. A record that does not read as one is left
      // in place: what made it so (a profiles root that cannot be listed) may pass.
      const savedAt = r.savedAt;
      if (
        typeof savedAt !== 'number' ||
        !(Math.abs(wallClock() - savedAt) <= RECOVERY_LIFETIME_MS)
      ) {
        if (typeof savedAt === 'number') {
          try {
            removeFile(path);
          } catch {
            // Read again, and refused again, next time.
          }
        }
        return Promise.resolve(undefined);
      }
      return Promise.resolve(recovery);
    },
  };
}
