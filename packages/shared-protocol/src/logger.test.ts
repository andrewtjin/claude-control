import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLogger } from './logger.js';

/** A stand-in for stdout that just records every chunk written to it, so tests can assert on
 *  exactly what a real terminal (or a real pipe) would have received — no real process I/O
 *  touched. */
class CapturingStdout {
  chunks: string[] = [];
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
    const stdout = new CapturingStdout();
    const logger = createLogger({ defaultLevel: 'info', env: {}, isTTY: true, stdout });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]?.startsWith('{')).toBe(false);
    expect(stdout.chunks[0]).toContain('started');
    expect(stdout.chunks[0]).toContain('sessionId=s1');
  });

  it('defaults to NDJSON off a TTY (piped to a file, a service manager, a log collector)', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({ defaultLevel: 'info', env: {}, isTTY: false, stdout });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks).toHaveLength(1);
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed.msg).toBe('started');
    expect(parsed.sessionId).toBe('s1');
    expect(typeof parsed.level).toBe('number');
  });

  it('CCTL_LOG_FORMAT=json forces NDJSON even on a TTY', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'json' },
      isTTY: true,
      stdout,
    });
    logger.info({}, 'x');
    expect(() => JSON.parse(stdout.chunks[0]!)).not.toThrow();
  });

  it('CCTL_LOG_FORMAT=pretty forces pretty even off a TTY', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FORMAT: 'pretty' },
      isTTY: false,
      stdout,
    });
    logger.info({}, 'x');
    expect(stdout.chunks[0]?.startsWith('{')).toBe(false);
    expect(stdout.chunks[0]).toContain('x');
  });
});

describe('createLogger: level', () => {
  it('honors CCTL_LOG_LEVEL over the caller-supplied default', () => {
    const stdout = new CapturingStdout();
    // defaultLevel is 'info' but the env override should win, silencing info entirely.
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_LEVEL: 'error' },
      isTTY: true,
      stdout,
    });
    logger.info({}, 'quiet');
    logger.warn({}, 'still quiet');
    logger.error({}, 'loud');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]).toContain('loud');
  });

  it('falls back to the caller-supplied default when CCTL_LOG_LEVEL is unset', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({ defaultLevel: 'warn', env: {}, isTTY: true, stdout });
    logger.info({}, 'quiet');
    logger.warn({}, 'loud');
    expect(stdout.chunks).toHaveLength(1);
    expect(stdout.chunks[0]).toContain('loud');
  });
});

describe('createLogger: pretty rendering of a real failure', () => {
  it('renders the ECONNREFUSED shape from a real Error the same way the daemon would log it', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({ defaultLevel: 'info', env: {}, isTTY: true, stdout });
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
    // The whole point: no pid, no hostname, no inline stack at error level.
    expect(content).not.toMatch(/\bpid=/);
    expect(content).not.toMatch(/\bhostname=/);
    expect(content.split('\n')).toHaveLength(1);
    // Message comes before the field tail, not after it.
    expect(content.indexOf('control-plane socket error')).toBeLessThan(content.indexOf('err='));
  });

  it('still prints pid/hostname in NDJSON mode — pretty output is the only thing that drops them', () => {
    const stdout = new CapturingStdout();
    const logger = createLogger({ defaultLevel: 'info', env: {}, isTTY: false, stdout });
    logger.error({ err: new Error('boom') }, 'failed');
    const parsed = JSON.parse(stdout.chunks[0]!) as Record<string, unknown>;
    expect(parsed).toHaveProperty('pid');
    expect(parsed).toHaveProperty('hostname');
  });
});

/** The file sink writes through a real `fs.createWriteStream`, whose underlying disk write is
 *  asynchronous even though our `LogDestination.write()` call into it is synchronous — so
 *  tests poll for the content to land rather than guessing at a fixed delay. Bounded so a
 *  genuine regression fails the test instead of hanging it. */
async function waitForFileContent(path: string, timeoutMs = 2000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try {
      const content = readFileSync(path, 'utf8');
      if (content.trim() !== '') return content;
    } catch {
      // Not created yet — keep polling.
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for content in ${path}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('createLogger: file sink', () => {
  it('appends NDJSON to CCTL_LOG_FILE in addition to pretty stdout output', async () => {
    const dir = freshTempDir();
    const filePath = join(dir, 'daemon.log');
    const stdout = new CapturingStdout();
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      isTTY: true,
      stdout,
    });
    logger.info({ sessionId: 's1' }, 'started');
    expect(stdout.chunks[0]).not.toMatch(/^\{/); // stdout stayed pretty
    const fileContents = await waitForFileContent(filePath);
    const parsed = JSON.parse(fileContents.trim()) as Record<string, unknown>;
    expect(parsed.msg).toBe('started');
    expect(parsed.sessionId).toBe('s1');
  });

  it('degrades to stdout-only with exactly one warning when CCTL_LOG_FILE cannot be opened', async () => {
    const dir = freshTempDir();
    // A path whose parent directory does not exist: createWriteStream fails with ENOENT.
    const filePath = join(dir, 'missing-parent', 'daemon.log');
    const stdout = new CapturingStdout();
    const warnings: string[] = [];
    let resolveWarned: (() => void) | undefined;
    const warned = new Promise<void>((resolve) => {
      resolveWarned = resolve;
    });
    const logger = createLogger({
      defaultLevel: 'info',
      env: { CCTL_LOG_FILE: filePath },
      isTTY: true,
      stdout,
      warn: (message) => {
        warnings.push(message);
        resolveWarned?.();
      },
    });
    await warned;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(filePath);
    // The daemon must keep working: logging still reaches stdout, never throws.
    expect(() => logger.info({}, 'still alive')).not.toThrow();
    expect(stdout.chunks.some((c) => c.includes('still alive'))).toBe(true);
  });
});
