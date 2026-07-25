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

import { createWriteStream, type WriteStream } from 'node:fs';
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

export interface CreateLoggerOptions {
  /** Level to use when CCTL_LOG_LEVEL is unset. Composition roots differ on purpose: the
   *  daemon defaults to 'info', the quieter one-shot CLI commands default to 'warn'. */
  defaultLevel: string;
  /** Injectable seams for tests; default to the real process environment/stdout. */
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  /** Where fallback warnings (e.g. an unopenable CCTL_LOG_FILE) are printed. Defaults to
   *  stderr; overridable so tests don't spam real stderr. */
  warn?: (message: string) => void;
  /** Where rendered lines are written. Defaults to real stdout; overridable so tests can
   *  capture output without touching the process's actual stdout. */
  stdout?: { write(chunk: string): unknown };
}

type LogFormat = 'pretty' | 'json';

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
 * watching pretty output live in the terminal.
 */
class LogDestination {
  private fileStream: WriteStream | undefined;
  private fileSinkWarned = false;

  constructor(
    private readonly mode: LogFormat,
    filePath: string | undefined,
    private readonly warn: (message: string) => void,
    private readonly stdout: { write(chunk: string): unknown },
  ) {
    if (filePath === undefined || filePath === '') return;
    try {
      this.fileStream = createWriteStream(filePath, { flags: 'a' });
      this.fileStream.on('error', (err) => this.degradeToStdoutOnly(filePath, err));
    } catch (err) {
      this.degradeToStdoutOnly(filePath, err);
    }
  }

  /** A bad CCTL_LOG_FILE (missing parent directory, no permission, disk full, ...) must never
   *  crash the daemon over logging — degrade to stdout-only with exactly one warning. */
  private degradeToStdoutOnly(filePath: string, err: unknown): void {
    this.fileStream = undefined;
    if (this.fileSinkWarned) return;
    this.fileSinkWarned = true;
    const reason = err instanceof Error ? err.message : String(err);
    this.warn(`CCTL_LOG_FILE=${filePath} could not be opened (${reason}); logging to stdout only`);
  }

  write(chunk: string): boolean {
    this.fileStream?.write(chunk);
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
    return formatLogLine(levelLabel, timeMs, rest, typeof msg === 'string' ? msg : undefined);
  }
}

/**
 * Build a logger for one composition root. Reads CCTL_LOG_LEVEL (unchanged behavior),
 * CCTL_LOG_FORMAT, and CCTL_LOG_FILE from the environment, and returns the tiny adapter every
 * call site already builds by hand today — this just centralizes it.
 */
export function createLogger(options: CreateLoggerOptions): LoggerLike {
  const env = options.env ?? process.env;
  const level = env.CCTL_LOG_LEVEL ?? options.defaultLevel;
  const isTTY = options.isTTY ?? process.stdout.isTTY === true;
  const format = resolveFormat(env, isTTY);
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warn: ${message}\n`));
  const stdout = options.stdout ?? process.stdout;

  const destination = new LogDestination(format, env.CCTL_LOG_FILE, warn, stdout);
  const p = pino({ level }, destination);
  return {
    debug: (obj, msg) => p.debug(obj, msg),
    info: (obj, msg) => p.info(obj, msg),
    warn: (obj, msg) => p.warn(obj, msg),
    error: (obj, msg) => p.error(obj, msg),
  };
}
