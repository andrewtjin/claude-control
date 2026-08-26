import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

/** A stand-in for the console stream that just records every chunk written to it, so tests can
 *  assert on exactly what a real terminal (or a real pipe) would have received — no real process
 *  I/O touched. `isTTY` is part of the sink for the same reason it is on `process.stdout`: it is
 *  what the format default keys off. */
class CapturingSink {
  chunks: string[] = [];
  constructor(readonly isTTY = false) {}
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
}

const tempDirs: string[] = [];
function freshTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cctl-logger-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('createLogger: format mode selection', () => {
  it('defaults to pretty on a TTY', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.info({ sessionId: 's1' }, 'started');
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]?.startsWith('{')).toBe(false);
    expect(sink.chunks[0]).toContain('started');
    expect(sink.chunks[0]).toContain('sessionId=s1');
  });

  it('defaults to NDJSON off a TTY (piped to a file, a service manager, a log collector)', () => {
    const sink = new CapturingSink(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.info({ sessionId: 's1' }, 'started');
    expect(sink.chunks).toHaveLength(1);
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('started');
    expect(parsed.sessionId).toBe('s1');
    expect(typeof parsed.level).toBe('number');
  });

  it('CCTL_LOG_FORMAT=json forces NDJSON even on a TTY', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'json' },
      sink,
    });
    logger.info({}, 'x');
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('x');
  });

  it('CCTL_LOG_FORMAT=pretty forces pretty even off a TTY', () => {
    const sink = new CapturingSink(false);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'pretty' },
      sink,
    });
    logger.info({}, 'x');
    expect(sink.chunks[0]?.startsWith('{')).toBe(false);
    expect(sink.chunks[0]).toContain('x');
  });
});

describe('createLogger: level', () => {
  it('honors CCTL_LOG_LEVEL over the caller-supplied default', () => {
    const sink = new CapturingSink(true);
    // defaultLevel is 'info' but the env override should win, silencing info entirely.
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_LEVEL: 'error' },
      sink,
    });
    logger.info({}, 'quiet');
    logger.warn({}, 'still quiet');
    logger.error({}, 'loud');
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toContain('loud');
  });

  it('falls back to the caller-supplied default when CCTL_LOG_LEVEL is unset', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'warn', env: {}, sink });
    logger.info({}, 'quiet');
    logger.warn({}, 'loud');
    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toContain('loud');
  });
});

describe('createLogger: pretty rendering of a real failure', () => {
  it('renders the ECONNREFUSED shape from a real Error the same way the daemon would log it', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    const err = new Error('connect ECONNREFUSED 127.0.0.1:8765') as Error & {
      errno: number;
      code: string;
      syscall: string;
      address: string;
      port: number;
    };
    err.errno = -4078;
    err.code = 'ECONNREFUSED';
    err.syscall = 'connect';
    err.address = '127.0.0.1';
    err.port = 8765;
    logger.error({ err }, 'control-plane socket error');

    // Every written chunk is one terminated line (the destination appends '\n' the same way
    // pino's own destination convention does); strip it before asserting there is exactly one
    // rendered line of content, not two.
    const line = sink.chunks[0]!;
    expect(line.endsWith('\n')).toBe(true);
    const content = line.slice(0, -1);
    expect(content).toContain('ERROR');
    expect(content).toContain('control-plane socket error');
    expect(content).toContain('err="connect ECONNREFUSED 127.0.0.1:8765"');
    // The identifying scalars survive the collapse; only the stack is held back.
    expect(content).toContain('code=ECONNREFUSED');
    expect(content).toContain('syscall=connect');
    // The whole point: no pid, no hostname, no inline stack at the default level.
    expect(content).not.toMatch(/\bpid=/);
    expect(content).not.toMatch(/\bhostname=/);
    expect(content.split('\n')).toHaveLength(1);
    // Message comes before the field tail, not after it.
    expect(content.indexOf('control-plane socket error')).toBeLessThan(content.indexOf('err='));
  });

  it('prints the stack of an error line once CCTL_LOG_LEVEL=debug asks for verbose output', () => {
    // The stack must be reachable from the CONFIGURED level. Nothing in this codebase logs an
    // error at debug level, so a gate on the line's own level would hide every stack forever.
    const sink = new CapturingSink(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_LEVEL: 'debug' },
      sink,
    });
    logger.error({ err: new Error('boom') }, 'daemon failed to start');
    const content = sink.chunks[0]!;
    expect(content).toContain('err=boom');
    expect(content).toMatch(/\n {4}Error: boom/);
    expect(content).toContain('logger.test.ts');
  });

  it('still prints pid/hostname in NDJSON mode — pretty output is the only thing that drops them', () => {
    const sink = new CapturingSink(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.error({ err: new Error('boom') }, 'failed');
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('pid');
    expect(parsed).toHaveProperty('hostname');
  });
});

describe('createLogger: color', () => {
  /** The literal CSI (`\u001b[`) every real ANSI paint opens with — asserted on directly rather
   *  than a specific code, since the point of these tests is presence/absence of *any* escape
   *  sequence, not which one. */
  const ESC = '\u001b[';

  it('colors pretty output on a TTY with NO_COLOR unset (the daemon-run default)', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.error({}, 'boom');
    expect(sink.chunks[0]).toContain(ESC);
  });

  it('never colors NDJSON output, even on a colorable TTY — machine format stays plain', () => {
    // json mode is chosen when isTTY is false, so force pretty conditions (TTY, no NO_COLOR)
    // and pin CCTL_LOG_FORMAT=json explicitly: this is the one combination where a caller who
    // conflated "colorable" with "pretty" would leak escape codes into a machine-parsed stream.
    const sink = new CapturingSink(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'json' },
      sink,
    });
    logger.error({}, 'boom');
    expect(sink.chunks[0]).not.toContain(ESC);
    // And it must still be valid, parseable JSON — not merely escape-free by accident.
    expect(() => {
      JSON.parse(sink.chunks[0]!);
    }).not.toThrow();
  });

  it('never colors NDJSON appended to CCTL_LOG_FILE, even while sink renders pretty+color', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: { CCTL_LOG_FILE: filePath }, sink });
    logger.error({}, 'boom');
    // sink got color (pretty + TTY + no NO_COLOR)...
    expect(sink.chunks[0]).toContain(ESC);
    // ...but the file sink — which always receives pino's raw NDJSON regardless of sink's
    // mode — must not, since it exists for later machine consumption.
    const fileContents = readFileSync(filePath, 'utf8');
    expect(fileContents).not.toContain(ESC);
    expect(() => {
      JSON.parse(fileContents.trim());
    }).not.toThrow();
  });

  it('respects NO_COLOR even on a TTY', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { NO_COLOR: '1' },
      sink,
    });
    logger.error({}, 'boom');
    expect(sink.chunks[0]).not.toContain(ESC);
    expect(sink.chunks[0]).toContain('boom'); // still fully readable, just plain
  });

  it('never colors when pretty is forced off a real TTY (CCTL_LOG_FORMAT=pretty piped to a file)', () => {
    // Forcing pretty format does not fabricate a terminal: escape codes written into a redirected
    // file/pipe would be a regression identical in kind to leaking them into NDJSON.
    const sink = new CapturingSink(false);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'pretty' },
      sink,
    });
    logger.error({}, 'boom');
    expect(sink.chunks[0]).not.toContain(ESC);
    expect(sink.chunks[0]).toContain('boom');
  });

  it('colors the ERROR level token red and the WARN level token yellow', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.error({}, 'e');
    logger.warn({}, 'w');
    expect(sink.chunks[0]).toContain('\u001b[31mERROR\u001b[0m');
    expect(sink.chunks[1]).toContain('\u001b[33mWARN \u001b[0m');
  });

  it('never colors the level token for a non-error, non-warn level, only error/fatal/warn earn one', () => {
    // The two tests above pin what DOES get a color; this pins what must NOT — a level with no
    // matching branch in ansiLogColors must render as bare padded text.
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'debug', env: {}, sink });
    logger.info({}, 'i');
    logger.debug({}, 'd');
    // The level token's own 5-char padded form (`INFO `/`DEBUG`) is bounded only by ordinary
    // spaces (the header's own join, then the segment join before the message) — a colored
    // token would insert an SGR escape between those spaces and the letters, breaking this
    // exact substring match even though a blanket "no ESC anywhere" assertion would not (the
    // timestamp on the same line is legitimately dimmed).
    expect(sink.chunks[0]).toContain(' INFO   i');
    expect(sink.chunks[1]).toContain(' DEBUG  d');
  });

  it('dims the timestamp and the key=val tail, but leaves the message unpainted', () => {
    const sink = new CapturingSink(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.info({ sessionId: 's1' }, 'started');
    const line = sink.chunks[0]!;
    // The line opens already dim-wrapped: the timestamp is the very first thing on it.
    expect(line.startsWith(`${ESC}2m`)).toBe(true);
    // The message string appears with no dim-open code immediately before it — it stands out
    // in the terminal default color while everything around it is dimmed.
    expect(line).not.toContain(`${ESC}2mstarted`);
    // The tail is wrapped in one dim span covering the whole key=val list.
    expect(line).toContain(`${ESC}2msessionId=s1${ESC}0m`);
  });
});

describe('createLogger: reserved payload keys', () => {
  it("renames a payload field that would collide with pino's own level/time/msg", () => {
    // Without the rename both the header and the field would be wrong: the duplicate JSON key
    // wins the parse, so the payload silently rewrites the timestamp and then disappears.
    const sink = new CapturingSink(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.info({ level: 'shadow', time: 5, msg: 'hijack', sessionId: 's1' }, 'real message');
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('real message');
    expect(typeof parsed.level).toBe('number');
    expect(parsed.time).not.toBe(5);
    expect(parsed.levelField).toBe('shadow');
    expect(parsed.timeField).toBe(5);
    expect(parsed.msgField).toBe('hijack');
    expect(parsed.sessionId).toBe('s1');
  });

  it('leaves an ordinary payload untouched', () => {
    const sink = new CapturingSink(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    logger.info({ sessionId: 's1' }, 'started');
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    expect(parsed.sessionId).toBe('s1');
    expect(parsed).not.toHaveProperty('levelField');
  });

  it('leaves a bare Error payload untouched instead of gutting it via the rename rebuild', () => {
    // message/stack are own-but-non-enumerable on Error, so a rebuild via Object.entries (which
    // only sees own enumerable keys) would silently drop them along with the prototype pino's
    // `instanceof Error` special-case (and its err serializer) rely on — even though this Error
    // also carries an enumerable `level` field that would otherwise trip the reserved-key guard.
    const sink = new CapturingSink(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, sink });
    const err = new Error('kaboom') as Error & { level: string };
    err.level = 'critical';
    logger.error(err);
    const parsed = JSON.parse(sink.chunks[0]!) as Record<string, unknown>;
    // pino's own numeric error level, untouched — the Error's OWN `level` field lives nested
    // under `err.level` below, so it never collides with this one.
    expect(parsed.level).toBe(50);
    expect(parsed.msg).toBe('kaboom');
    const serializedErr = parsed.err as Record<string, unknown>;
    expect(serializedErr.message).toBe('kaboom');
    expect(serializedErr.stack).toContain('Error: kaboom');
    expect(serializedErr.level).toBe('critical');
  });
});

describe('createLogger: file sink', () => {
  it('appends NDJSON to CCTL_LOG_FILE in addition to the pretty console output', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const sink = new CapturingSink(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink,
    });
    logger.info({ sessionId: 's1' }, 'started');
    expect(sink.chunks[0]).not.toMatch(/^\{/); // the console sink stayed pretty
    const parsed = JSON.parse(readFileSync(filePath, 'utf8').trim()) as Record<string, unknown>;
    expect(parsed.msg).toBe('started');
    expect(parsed.sessionId).toBe('s1');
  });

  it('has the line on disk the instant the log call returns, so process.exit cannot drop it', () => {
    // `daemon failed to start` is logged and then the process exits immediately. A buffered
    // write stream loses exactly that line, because process.exit flushes nothing.
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
    });
    logger.error({ err: new Error('port in use') }, 'daemon failed to start');
    // No await, no polling: if this needs either, the line would not survive an exit.
    const contents = readFileSync(filePath, 'utf8');
    expect(contents).toContain('daemon failed to start');
    expect(contents).toContain('port in use');
  });

  it('degrades to console-only with exactly one warning when CCTL_LOG_FILE cannot be opened', () => {
    const dir = freshTempDir();
    // A path whose parent directory does not exist: opening it fails with ENOENT.
    const filePath = join(dir, 'missing-parent', 'daemon.log');
    const sink = new CapturingSink(true);
    const warnings: string[] = [];
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(filePath);
    // The daemon must keep working: logging still reaches the console, never throws.
    expect(() => logger.info({}, 'still alive')).not.toThrow();
    expect(sink.chunks.some((c) => c.includes('still alive'))).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it('shares one file sink across every logger a single process builds for the same path', () => {
    // `cctl daemon run` builds two loggers (its own, plus the switch-engine adapter inside
    // buildEngine) that both read the same CCTL_LOG_FILE — this is the invariant that actually
    // matters: one process, one CCTL_LOG_FILE, one fd, one warning, no matter how many loggers
    // it builds, not "one warning per logger instance".
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    const first = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
      warn,
    });
    const second = createLogger({
      defaultLevel: 'warn',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
      warn,
    });
    first.info({ sessionId: 's1' }, 'from the daemon logger');
    second.warn({ sessionId: 's2' }, 'from the engine logger');
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('from the daemon logger');
    expect(lines[1]).toContain('from the engine logger');
    // Neither logger's file sink ever failed, so no degradation warning fires at all — proving
    // the sink is genuinely shared rather than each logger silently opening (and leaking) its
    // own fd on the same path.
    expect(warnings).toHaveLength(0);
  });

  it('degrading one logger onto an unopenable path warns exactly once for every logger sharing it', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'missing-parent', 'daemon.log');
    const warnings: string[] = [];
    const warn = (message: string): void => {
      warnings.push(message);
    };
    const first = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
      warn,
    });
    const second = createLogger({
      defaultLevel: 'warn',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
      warn,
    });
    expect(() => first.info({}, 'still alive (first)')).not.toThrow();
    expect(() => second.warn({}, 'still alive (second)')).not.toThrow();
    // One shared sink, one shared warning latch: two loggers on the same broken path still
    // produce exactly one warning for the whole process, not one apiece.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(filePath);
  });
});

describe('createLogger: file sink rotation', () => {
  const ROTATE_BYTES = 10 * 1024 * 1024;

  it('rotates a file already at/over the threshold before the first line of a new run lands', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    writeFileSync(filePath, Buffer.alloc(ROTATE_BYTES, 'x'));
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
    });
    logger.info({}, 'first line of the new generation');

    expect(existsSync(`${filePath}.old`)).toBe(true);
    expect(statSync(`${filePath}.old`).size).toBeGreaterThanOrEqual(ROTATE_BYTES);
    const current = readFileSync(filePath, 'utf8');
    expect(current).toContain('first line of the new generation');
    expect(current.length).toBeLessThan(ROTATE_BYTES);
  });

  it('rotates mid-run once a write crosses the threshold, replacing any earlier .old', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    writeFileSync(`${filePath}.old`, 'stale generation from an earlier rotation\n');
    // Seeded just under the threshold, so this one small log line is what tips it over.
    writeFileSync(filePath, Buffer.alloc(ROTATE_BYTES - 10, 'x'));
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink: new CapturingSink(true),
    });
    logger.info({}, 'crossed the threshold');

    // The line that tipped the scale still lands in the generation it was appended to, which
    // is exactly the one that then gets rotated out — never dropped, never split mid-write.
    const oldContents = readFileSync(`${filePath}.old`, 'utf8');
    expect(oldContents).not.toContain('stale generation');
    expect(oldContents).toContain('crossed the threshold');
    // Rotation opens a fresh, empty file for whatever logs next.
    expect(readFileSync(filePath, 'utf8')).toBe('');
  });

  it('keeps working (console-only) if a rotation rename fails, rather than losing the sink', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    // A directory in the way of the rotated destination makes the rename fail — the same class
    // of unrecoverable IO fault an open failure represents.
    mkdirSync(`${filePath}.old`);
    writeFileSync(filePath, Buffer.alloc(ROTATE_BYTES, 'x'));
    const sink = new CapturingSink(true);
    const warnings: string[] = [];
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      sink,
      warn: (message) => warnings.push(message),
    });
    logger.info({}, 'still alive after a failed rotation');
    expect(warnings).toHaveLength(1);
    expect(sink.chunks.some((c) => c.includes('still alive after a failed rotation'))).toBe(true);
  });
});
