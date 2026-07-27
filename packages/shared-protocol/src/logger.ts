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
  /** Where rendered lines go. Defaults to `process.stdout`; a composition root whose stdout
   *  carries its OWN output (every one-shot CLI command) passes `process.stderr` instead, and
   *  tests pass a double to capture output and simulate a terminal. Named for the role, not for
   *  a stream, precisely because it is not always stdout. */
  sink?: LogSink;
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

/** True only for a plain `{}`-literal-shaped object (including `Object.create(null)`), never for
 *  an `Error`, `Map`, or other class instance. The rename below rebuilds its input via
 *  `Object.entries`, which only sees own ENUMERABLE keys — fine for a plain payload object, but
 *  for an `Error` it silently drops `message`/`stack` (own but non-enumerable) and the
 *  prototype, destroying the very thing pino's `err` serializer needs. Restricting the rename
 *  to plain objects means anything else (a bare Error passed as the whole payload) is returned
 *  untouched instead of being quietly gutted. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function renameReservedKeys(obj: unknown): unknown {
  if (!isPlainObject(obj)) return obj;
  // `Object.hasOwn` (own-enumerable-or-not) must agree with the `Object.entries` rebuild below
  // (own-enumerable-only) on which keys exist — using `in` here would trigger the rebuild for a
  // key that then never survives it (see the module comment above).
  if (!RESERVED_KEYS.some((key) => Object.hasOwn(obj, key))) return obj;
  const renamed: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    renamed[RESERVED_KEYS.includes(key) ? `${key}Field` : key] = value;
  }
  return renamed;
}

/** Resolves pretty vs JSON: CCTL_LOG_FORMAT wins outright when set to a recognized value;
 *  otherwise a real terminal gets pretty output and anything else (piped to a file, a service
 *  manager, a log collector) gets NDJSON it can actually parse. An unrecognized value (typo'd
 *  or wrong-cased) is exactly the same class of operator mistake as a bad CCTL_LOG_FILE, so it
 *  gets the same treatment: fall back safely AND warn, rather than silently auto-detecting
 *  while `cctl settings` goes on reporting the (unhonored) raw value. */
function resolveFormat(
  env: NodeJS.ProcessEnv,
  isTTY: boolean,
  warn: (message: string) => void,
): LogFormat {
  const raw = env.CCTL_LOG_FORMAT;
  if (raw === undefined || raw === '') return isTTY ? 'pretty' : 'json';
  if (raw === 'json') return 'json';
  if (raw === 'pretty') return 'pretty';
  warn(`CCTL_LOG_FORMAT=${raw} is not "json" or "pretty"; falling back to auto-detection`);
  return isTTY ? 'pretty' : 'json';
}

/** Per-process cache of open file sinks, keyed by the absolute CCTL_LOG_FILE path. A single
 *  process builds more than one logger through `createLogger` (the daemon's own plus the
 *  switch-engine adapter `buildEngine` builds alongside it — both target the SAME operator-
 *  configured file since both read the same env), so without this every logger would open its
 *  own fd on the same file and print its own copy of the degradation warning. Keyed by path
 *  (not a singleton) so unrelated file paths — as every test uses, via a fresh temp dir per
 *  test — stay fully independent. */
const fileSinks = new Map<string, FileSink>();

function getFileSink(filePath: string, warn: (message: string) => void): FileSink {
  const existing = fileSinks.get(filePath);
  if (existing !== undefined) return existing;
  const sink = new FileSink(filePath, warn);
  fileSinks.set(filePath, sink);
  return sink;
}

/**
 * Owns the raw fd for one CCTL_LOG_FILE path: opening it, writing to it, and degrading to
 * console-only (with exactly one warning) if it ever fails. Every line reaches this sink
 * verbatim as NDJSON regardless of the console sink's mode, since the file exists for later
 * machine consumption (log collectors, `grep`) even when a human is watching pretty output live
 * in the terminal — which also means the full stack of every error is always in the file even
 * when the pretty console output is showing only the summary.
 *
 * Written with `writeSync` to a raw fd rather than through `fs.createWriteStream`. A write
 * stream buffers, and the lines that matter most are the ones emitted immediately before
 * `process.exit` (`daemon failed to start`) — a buffered stream drops those on the floor, since
 * `process.exit` runs no flush of its own.
 */
class FileSink {
  private fd: number | undefined;
  private warned = false;

  constructor(
    private readonly filePath: string,
    private readonly warn: (message: string) => void,
  ) {
    try {
      this.fd = openSync(filePath, 'a');
    } catch (err) {
      this.degrade(err);
    }
  }

  /** A bad CCTL_LOG_FILE (missing parent directory, no permission, disk full, ...) must never
   *  crash the daemon over logging — degrade to console-only with exactly one warning, shared by
   *  every logger writing to this path. */
  private degrade(err: unknown): void {
    if (this.fd !== undefined) {
      try {
        closeSync(this.fd);
      } catch {
        // Already unusable; nothing left to salvage by reporting a second failure.
      }
    }
    this.fd = undefined;
    if (this.warned) return;
    this.warned = true;
    const reason = err instanceof Error ? err.message : String(err);
    this.warn(
      `CCTL_LOG_FILE=${this.filePath} could not be written (${reason}); logging to the console only`,
    );
  }

  write(chunk: string): void {
    if (this.fd === undefined) return;
    try {
      // `writeSync` is not guaranteed to write the whole buffer in one call (a pipe/FIFO can
      // accept less than it's given); looping on its return value is what `fs.createWriteStream`
      // did for us before and what this raw-fd replacement must keep doing, or a short write
      // truncates a log line with nothing to show for it.
      const buffer = Buffer.from(chunk, 'utf8');
      let offset = 0;
      while (offset < buffer.length) {
        offset += writeSync(this.fd, buffer, offset, buffer.length - offset);
      }
    } catch (err) {
      this.degrade(err);
    }
  }
}

class LogDestination {
  private readonly fileSink: FileSink | undefined;

  constructor(
    private readonly mode: LogFormat,
    private readonly includeStack: boolean,
    filePath: string | undefined,
    warn: (message: string) => void,
    private readonly sink: LogSink,
  ) {
    this.fileSink =
      filePath === undefined || filePath === '' ? undefined : getFileSink(filePath, warn);
  }

  write(chunk: string): boolean {
    this.fileSink?.write(chunk);
    if (this.mode === 'json') {
      this.sink.write(chunk);
    } else {
      this.sink.write(this.renderPretty(chunk) + '\n');
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
  const sink = options.sink ?? process.stdout;
  const warn = options.warn ?? ((message: string) => process.stderr.write(`warn: ${message}\n`));
  const format = resolveFormat(env, sink.isTTY === true, warn);

  const destination = new LogDestination(format, wantsStacks(level), env.CCTL_LOG_FILE, warn, sink);
  const p = pino({ level }, destination);
  return {
    debug: (obj, msg) => p.debug(renameReservedKeys(obj), msg),
    info: (obj, msg) => p.info(renameReservedKeys(obj), msg),
    warn: (obj, msg) => p.warn(renameReservedKeys(obj), msg),
    error: (obj, msg) => p.error(renameReservedKeys(obj), msg),
  };
}
