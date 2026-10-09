// The daemon's seam to Claude Code's background service: the real {@link BackgroundSessionHost}
// the daemon's background mover drives (see the daemon's backgroundMover.ts for when and why a
// session moves).
//
// Claude Code runs one background service per config dir (keyed on CLAUDE_CONFIG_DIR, or on
// ~/.claude when it is unset), and keeps that service's state under the config dir:
//   - `daemon/roster.json`: the workers the service hosts right now, by short id, each with its full
//     session id, working directory and the pid of its terminal host. It also holds attach secrets;
//     only the four fields above are ever read out of it, and nothing from it is logged;
//   - `jobs/<short>/state.json`: the session's job row, with the launch options it saved
//     (`respawnFlags`) — which, measured, can also hold the session's first prompt.
// Everything else is asked of Claude Code itself, run as the operator's own `claude` on PATH (the
// binary that started the service), with CLAUDE_CONFIG_DIR naming the service to talk to:
//   - `claude agents --json`: every session with its status (`idle` between turns, `busy` in one,
//     `waiting` on a prompt or a permission); the listing spans every working directory;
//   - `claude stop <short>`: stops it, synchronously;
//   - `claude rm <short>`: drops that config dir's job row only (the conversation is kept);
//   - `claude --bg --resume <session id> [options]` with no prompt: resumes it idle under that
//     config dir's service ("idle — send a prompt to start"), or prints that it started a copy.
// These shapes were measured against Claude Code 2.1.295; anything else is read defensively, and an
// unexpected answer fails the operation rather than guessing.

import { spawn as nodeSpawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BackgroundSession,
  BackgroundSessionHost,
  SessionActivity,
} from '@claude-control/daemon';
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

export interface ClaudeBackgroundHostOptions {
  /** The main config dir: the global slot's, which a `null` config dir names. */
  mainConfigDir: string;
  /** The environment Claude Code is run with (default: this process's). */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** How Claude Code is run (default: the `claude` on PATH, without a shell). */
  run?: RunClaude;
  readFile?: (path: string) => string;
  isProcessAlive?: (pid: number) => boolean;
}

/** How long one Claude Code command may run. A resume returns once the session is dispatched, in
 *  about a second when the service is up and a few when it has to start. */
const CLAUDE_COMMAND_TIMEOUT_MS = 60_000;

const SHORT_ID = /^[0-9a-f]{8}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The saved launch options a move replays, by flag: those taking a value, and those standing alone.
 * Only these: a job row's saved list can also hold the session's first prompt, which replayed would
 * start a turn, and an option this build does not know could mean anything. What is left out is the
 * session's default for it under the new config dir.
 */
const REPLAYED_VALUE_OPTIONS: ReadonlySet<string> = new Set([
  '--model',
  '--permission-mode',
  '--add-dir',
  '--fallback-model',
  '--agent',
]);
const REPLAYED_SWITCH_OPTIONS: ReadonlySet<string> = new Set(['--dangerously-skip-permissions']);

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

/** Keep only the replayable options of a saved list (see {@link REPLAYED_VALUE_OPTIONS}). Accepts
 *  both `--flag value` and `--flag=value`. */
export function replayableOptions(saved: unknown): string[] {
  if (!Array.isArray(saved)) return [];
  const out: string[] = [];
  for (let i = 0; i < saved.length; i++) {
    const arg: unknown = saved[i];
    if (typeof arg !== 'string') continue;
    const eq = arg.indexOf('=');
    const flag = arg.startsWith('--') && eq > 0 ? arg.slice(0, eq) : arg;
    if (REPLAYED_SWITCH_OPTIONS.has(flag) && flag === arg) {
      out.push(arg);
    } else if (REPLAYED_VALUE_OPTIONS.has(flag)) {
      if (flag !== arg) {
        out.push(arg);
      } else {
        const value: unknown = saved[i + 1];
        if (typeof value === 'string' && !value.startsWith('--')) {
          out.push(arg, value);
          i++;
        }
      }
    }
  }
  return out;
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

/** Build the host for the daemon. */
export function createClaudeBackgroundHost(
  options: ClaudeBackgroundHostOptions,
): BackgroundSessionHost {
  const baseEnv = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? defaultRunClaude(platform, baseEnv);
  const readFile = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const isAlive = options.isProcessAlive ?? pidIsAlive;

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

  /** A config dir's job row for a session, or undefined when it holds none (or an unreadable one). */
  const jobRow = (configDir: string | null, short: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(
        readFile(join(home(configDir), 'jobs', short, 'state.json')),
      );
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
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

  return {
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

    async stop(configDir, short) {
      if (!SHORT_ID.test(short)) throw new Error(`not a background session id: ${short}`);
      await runOk(configDir, ['stop', short]);
    },

    savedOptions(configDir, short) {
      if (!SHORT_ID.test(short)) return Promise.resolve([]);
      return Promise.resolve(replayableOptions(jobRow(configDir, short)?.respawnFlags));
    },

    async resumeIdle(input) {
      if (!SESSION_ID.test(input.sessionId) || !input.sessionId.startsWith(input.short)) {
        throw new Error(`not a background session id: ${input.sessionId}`);
      }
      const args = ['--bg', '--resume', input.sessionId];
      if (input.options !== undefined) {
        // A row this config dir already holds for the session keeps its own saved options and
        // starts a copy when others are passed; dropping it first lets these apply to the same id.
        if (jobRow(input.configDir, input.short) !== undefined) {
          await runOk(input.configDir, ['rm', input.short]);
        }
        args.push(...input.options);
      }
      const result = await runOk(input.configDir, args, input.cwd);
      const copy = /started a copy as ([0-9a-f]{8})/.exec(`${result.stdout}\n${result.stderr}`);
      if (copy !== null) {
        // Claude Code saw the session as still live, or kept other saved options, and forked it
        // under a new id. The copy is not the session being moved: stop it and fail the move.
        await runOk(input.configDir, ['stop', copy[1]!]).catch(() => undefined);
        throw new Error(`claude started a copy (${copy[1]!}) instead of resuming it`);
      }
    },
  };
}
