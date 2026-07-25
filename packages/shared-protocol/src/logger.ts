// Shared logger factory: the one place pino gets wired up for real (as opposed to the
// dependency-free `Logger` seam each of switch-engine/control-plane-bot declares for their own
// libraries to log through). Lives here — not in the CLI or switch-engine — because
// control-plane-bot may import ONLY shared-protocol (see index.ts's module comment on the
// zero-credential guarantee); this is the only workspace package all three composition roots
// (`cctl daemon run`, the CLI's other commands, the control-plane bot) can reach.
//
// Pretty-vs-JSON is handled entirely at the DESTINATION, not by touching pino's own
// formatting: pino always builds its normal NDJSON internally (so its default `err`
// serializer, level numbers, etc. stay exactly as every pino consumer expects), and the
// destination below either passes that line straight through (json mode) or parses it back
// out and re-renders it with `formatLogLine` (pretty mode). Deliberately NOT pino-pretty: that
// package runs as a worker-thread transport, which is a bundling hazard for cctl-publish's
// single-file CLI bundle — this destination is a plain synchronous object.

import { closeSync, openSync, writeSync } from 'node:fs';
import pino from 'pino';
import { formatLogLine } from './logFormat.js';

/** Structural shape both switch-engine's and control-plane-bot's `Logger` interfaces satisfy.
 *  Declared locally rather than imported from either — importing switch-engine's would give
 *  shared-protocol a dependency it must never have, and the two interfaces are deliberately
 *  kept as separate declarations (see control-plane-bot/src/logger.ts's comment), so picking
 *  one to import here would be arbitrary. Every caller assigns this to its own `Logger` type;
 *  TypeScript's structural typing accepts it because the shapes are identical. */
export interface LoggerLike {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Where rendered lines go. `process.stdout` satisfies this, and so does a test double — which
 *  is why the TTY flag is read from here rather than passed separately: pretty-vs-JSON is a
 *  property of the thing being written to, and a double that claims to be a terminal cannot
 *  then contradict itself. */
export interface LogSink {
  write(chunk: string): unknown;
  isTTY?: boolean | undefined;
}

export interface CreateLoggerOptions {
  /** Level to use when CCTL_LOG_LEVEL is unset. Composition roots differ on purpose: the
   *  daemon defaults to 'info', the quieter one-shot CLI commands default to 'warn'. */
  defaultLevel: string;
  /** Defaults to the real process environment; overridable so tests can pin CCTL_LOG_* without
   *  mutating global state. */
  env?: NodeJS.ProcessEnv;
  /** Defaults to real stdout; overridable so tests can capture output and simulate a terminal. */
  stdout?: LogSink;
  /** Where fallback warnings (e.g. an unopenable CCTL_LOG_FILE) are printed. Defaults to
   *  stderr; overridable so tests can assert on them without spamming real stderr. */
  warn?: (message: string) => void;
}

type LogFormat = 'pretty' | 'json';

/** pino serializes its own `level`/`time`/`msg` first and appends the call site's payload
 *  after, so a payload field with one of those names emits a DUPLICATE JSON key — and every
 *  parser (including this file's pretty renderer) keeps the last one. Left alone, such a field
 *  would silently overwrite the line's own level/timestamp/message and then vanish from the
 *  output entirely. Renaming the collision keeps both. */
const RESERVED_KEYS = ['level', 'time', 'msg'];

function renameReservedKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const record = obj as Record<string, unknown>;
  if (!RESERVED_KEYS.some((key) => key in record)) return obj;
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    renamed[RESERVED_KEYS.includes(key) ? `${key}Field` : key] = value;
  }
  return renamed;
}

/** Resolves pretty vs JSON: CCTL_LOG_FORMAT wins outright when set to a recognized value;
 *  otherwise a real terminal gets pretty output and anything else (piped to a file, a service
 *  manager, a log collector) gets NDJSON it can actually parse. */
function resolveFormat(env: NodeJS.ProcessEnv, isTTY: boolean): LogFormat {
  if (env.CCTL_LOG_FORMAT === 'json') return 'json';
  if (env.CCTL_LOG_FORMAT === 'pretty') return 'pretty';
  return isTTY ? 'pretty' : 'json';
}

/**
 * The pino destination: a plain object with a synchronous `write`, which is all pino requires
 * (see pino's DestinationStream docs) — no stream machinery, no worker thread.
 *
 * Every line reaches the file sink verbatim as NDJSON regardless of stdout's mode, since the
 * file exists for later machine consumption (log collectors, `grep`) even when a human is
 * watching pretty output live in the terminal — which also means the full stack of every error
 * is always in the file even when pretty stdout is showing only the summary.
 *
 * The file is written with `writeSync` to a raw fd rather than through `fs.createWriteStream`.
 * A write stream buffers, and the lines that matter most are the ones emitted immediately
 * before `process.exit` (`daemon failed to start`) — a buffered stream drops those on the
 * floor, since `process.exit` runs no flush of its own.
 */
class LogDestination {
  private fileFd: number | undefined;
  private fileSinkWarned = false;

  constructor(
    private readonly mode: LogFormat,
    private readonly includeStack: boolean,
    private readonly filePath: string | undefined,
    private readonly warn: (message: string) => void,
    private readonly stdout: LogSink,
  ) {
    if (filePath === undefined || filePath === '') return;
    try {
      this.fileFd = openSync(filePath, 'a');
    } catch (err) {
      this.degradeToStdoutOnly(err);
    }
  }

  /** A bad CCTL_LOG_FILE (missing parent directory, no permission, disk full, ...) must never
   *  crash the daemon over logging — degrade to stdout-only with exactly one warning. */
  private degradeToStdoutOnly(err: unknown): void {
    if (this.fileFd !== undefined) {
      try {
        closeSync(this.fileFd);
      } catch {
        // Already unusable; nothing left to salvage by reporting a second failure.
      }
    }
    this.fileFd = undefined;
    if (this.fileSinkWarned) return;
    this.fileSinkWarned = true;
    const reason = err instanceof Error ? err.message : String(err);
    this.warn(
      `CCTL_LOG_FILE=${this.filePath ?? ''} could not be written (${reason}); logging to stdout only`,
    );
  }

  write(chunk: string): boolean {
    if (this.fileFd !== undefined) {
      try {
        writeSync(this.fileFd, chunk);
      } catch (err) {
        this.degradeToStdoutOnly(err);
      }
    }
    if (this.mode === 'json') {
      this.stdout.write(chunk);
    } else {
      this.stdout.write(this.renderPretty(chunk) + '\n');
    }
    return true;
  }

  /** Parses the NDJSON line pino just built and re-renders it with `formatLogLine`. pino's
   *  default `level` is numeric (30, 40, ...); `pino.levels.labels` is the same lookup pino
   *  itself uses to turn that back into 'info'/'warn'/etc. `pid`/`hostname` are dropped here
   *  (constant for the process's whole lifetime, pure noise on every pretty line) but stay in
   *  the file/JSON-mode output untouched, above. */
  private renderPretty(chunk: string): string {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(chunk) as Record<string, unknown>;
    } catch {
      // Should not happen (pino always emits valid JSON to its destination) but a log line
      // must never vanish silently just because it didn't look like what we expected.
      return chunk.replace(/\n$/, '');
    }
    const { level, time, msg, pid: _pid, hostname: _hostname, ...rest } = parsed;
    const levelLabel =
      typeof level === 'number'
        ? ((pino.levels.labels as Record<number, string>)[level] ?? String(level))
        : typeof level === 'string'
          ? level
          : 'info';
    const timeMs = typeof time === 'number' ? time : Date.now();
    return formatLogLine(levelLabel, timeMs, rest, typeof msg === 'string' ? msg : undefined, {
      includeStack: this.includeStack,
    });
  }
}

/** Verbose levels are the operator asking to see everything, which is the only situation where
 *  an inline stack trace is worth the vertical space it costs. */
function wantsStacks(level: string): boolean {
  const normalized = level.toLowerCase();
  return normalized === 'debug' || normalized === 'trace';
}

/**
 * Build a logger for one composition root. Reads CCTL_LOG_LEVEL (unchanged behavior),
 * CCTL_LOG_FORMAT, and CCTL_LOG_FILE from the environment, and returns the tiny adapter every
 * call site already builds by hand today — this just centralizes it.
 */
export function createLogger(options: CreateLoggerOptions): LoggerLike {
  const env = options.env ?? process.env;
  const level = env.CCTL_LOG_LEVEL ?? options.defaultLevel;
  const stdout = options.stdout ?? process.stdout;
  const format = resolveFormat(env, stdout.isTTY === true);
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warn: ${message}\n`));

  const destination = new LogDestination(
    format,
    wantsStacks(level),
    env.CCTL_LOG_FILE,
    warn,
    stdout,
  );
  const p = pino({ level }, destination);
  return {
    debug: (obj, msg) => p.debug(renameReservedKeys(obj), msg),
    info: (obj, msg) => p.info(renameReservedKeys(obj), msg),
    warn: (obj, msg) => p.warn(renameReservedKeys(obj), msg),
    error: (obj, msg) => p.error(renameReservedKeys(obj), msg),
  };
}
