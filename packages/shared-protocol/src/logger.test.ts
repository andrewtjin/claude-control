import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

/** A stand-in for stdout that just records every chunk written to it, so tests can assert on
 *  exactly what a real terminal (or a real pipe) would have received — no real process I/O
 *  touched. `isTTY` is part of the sink for the same reason it is on `process.stdout`: it is
 *  what the format default keys off. */
class CapturingStdout {
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
    const stdout = new CapturingStdout(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.startsWith('{')).toBe(false);
    expect(stdout.chunks[0]).toContain('started');
    expect(stdout.chunks[0]).toContain('sessionId=s1');
  });

  it('defaults to NDJSON off a TTY (piped to a file, a service manager, a log collector)', () => {
    const stdout = new CapturingStdout(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks).toHaveLength(1);
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('started');
    expect(parsed.sessionId).toBe('s1');
    expect(typeof parsed.level).toBe('number');
  });

  it('CCTL_LOG_FORMAT=json forces NDJSON even on a TTY', () => {
    const stdout = new CapturingStdout(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'json' },
      stdout,
    });
    logger.info({}, 'x');
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('x');
  });

  it('CCTL_LOG_FORMAT=pretty forces pretty even off a TTY', () => {
    const stdout = new CapturingStdout(false);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'pretty' },
      stdout,
    });
    logger.info({}, 'x');
    expect(stdout.chunks[0]?.startsWith('{')).toBe(false);
    expect(stdout.chunks[0]).toContain('x');
  });
});

describe('createLogger: level', () => {
  it('honors CCTL_LOG_LEVEL over the caller-supplied default', () => {
    const stdout = new CapturingStdout(true);
    // defaultLevel is 'info' but the env override should win, silencing info entirely.
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_LEVEL: 'error' },
      stdout,
    });
    logger.info({}, 'quiet');
    logger.warn({}, 'still quiet');
    logger.error({}, 'loud');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]).toContain('loud');
  });

  it('falls back to the caller-supplied default when CCTL_LOG_LEVEL is unset', () => {
    const stdout = new CapturingStdout(true);
    const logger = createLogger({ defaultLevel: 'warn', env: {}, stdout });
    logger.info({}, 'quiet');
    logger.warn({}, 'loud');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]).toContain('loud');
  });
});

describe('createLogger: pretty rendering of a real failure', () => {
  it('renders the ECONNREFUSED shape from a real Error the same way the daemon would log it', () => {
    const stdout = new CapturingStdout(true);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
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
    const line = stdout.chunks[0]!;
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
    const stdout = new CapturingStdout(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_LEVEL: 'debug' },
      stdout,
    });
    logger.error({ err: new Error('boom') }, 'daemon failed to start');
    const content = stdout.chunks[0]!;
    expect(content).toContain('err=boom');
    expect(content).toMatch(/\n {4}Error: boom/);
    expect(content).toContain('logger.test.ts');
  });

  it('still prints pid/hostname in NDJSON mode — pretty output is the only thing that drops them', () => {
    const stdout = new CapturingStdout(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
    logger.error({ err: new Error('boom') }, 'failed');
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('pid');
    expect(parsed).toHaveProperty('hostname');
  });
});

describe('createLogger: reserved payload keys', () => {
  it("renames a payload field that would collide with pino's own level/time/msg", () => {
    // Without the rename both the header and the field would be wrong: the duplicate JSON key
    // wins the parse, so the payload silently rewrites the timestamp and then disappears.
    const stdout = new CapturingStdout(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
    logger.info({ level: 'shadow', time: 5, msg: 'hijack', sessionId: 's1' }, 'real message');
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('real message');
    expect(typeof parsed.level).toBe('number');
    expect(parsed.time).not.toBe(5);
    expect(parsed.levelField).toBe('shadow');
    expect(parsed.timeField).toBe(5);
    expect(parsed.msgField).toBe('hijack');
    expect(parsed.sessionId).toBe('s1');
  });

  it('leaves an ordinary payload untouched', () => {
    const stdout = new CapturingStdout(false);
    const logger = createLogger({ defaultLevel: 'info', env: {}, stdout });
    logger.info({ sessionId: 's1' }, 'started');
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed.sessionId).toBe('s1');
    expect(parsed).not.toHaveProperty('levelField');
  });
});

describe('createLogger: file sink', () => {
  it('appends NDJSON to CCTL_LOG_FILE in addition to pretty stdout output', () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const stdout = new CapturingStdout(true);
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      stdout,
    });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks[0]).not.toMatch(/^\{/); // stdout stayed pretty
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
      stdout: new CapturingStdout(true),
    });
    logger.error({ err: new Error('port in use') }, 'daemon failed to start');
    // No await, no polling: if this needs either, the line would not survive an exit.
    const contents = readFileSync(filePath, 'utf8');
    expect(contents).toContain('daemon failed to start');
    expect(contents).toContain('port in use');
  });

  it('degrades to stdout-only with exactly one warning when CCTL_LOG_FILE cannot be opened', () => {
    const dir = freshTempDir();
    // A path whose parent directory does not exist: opening it fails with ENOENT.
    const filePath = join(dir, 'missing-parent', 'daemon.log');
    const stdout = new CapturingStdout(true);
    const warnings: string[] = [];
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      stdout,
      warn: (message) => warnings.push(message),
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(filePath);
    // The daemon must keep working: logging still reaches stdout, never throws.
    expect(() => logger.info({}, 'still alive')).not.toThrow();
    expect(stdout.chunks.some((c) => c.includes('still alive'))).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});
