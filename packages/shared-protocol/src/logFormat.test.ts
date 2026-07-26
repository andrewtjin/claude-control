import { describe, it, expect } from 'vitest';
import { formatLogLine } from './logFormat.js';

/** A fixed instant with distinct H/M/S so every test asserts on the same, unambiguous time
 *  text — built from local Date components so the test passes in any timezone the CI runner
 *  happens to be in, not just UTC. */
function localTime(h: number, m: number, s: number): { ms: number; text: string } {
  const d = new Date();
  d.setHours(h, m, s, 0);
  const pad2 = (n: number): string => String(n).padStart(2, '0');
  return { ms: d.getTime(), text: `${pad2(h)}:${pad2(m)}:${pad2(s)}` };
}

/** Mirrors `formatLogLine`'s own level-padding rule (5-char column, uppercased) so exact-match
 *  assertions below build their expectation the same way production does, rather than a
 *  hand-typed literal whose space count is easy to get subtly wrong. */
function pad5(level: string): string {
  const upper = level.toUpperCase();
  return upper.length >= 5 ? upper.slice(0, 5) : upper.padEnd(5);
}

describe('formatLogLine', () => {
  it('renders time, level, and message with no fields', () => {
    const { ms, text } = localTime(9, 5, 3);
    expect(formatLogLine('info', ms, {}, 'hello')).toBe(`${text} ${pad5('info')}  hello`);
  });

  it('pads level words so the message always starts at the same column', () => {
    const { ms } = localTime(0, 0, 0);
    const col = formatLogLine('info', ms, {}, 'm').indexOf('m');
    expect(formatLogLine('warn', ms, {}, 'm').indexOf('m')).toBe(col);
    expect(formatLogLine('error', ms, {}, 'm').indexOf('m')).toBe(col);
    expect(formatLogLine('debug', ms, {}, 'm').indexOf('m')).toBe(col);
  });

  it('is case-insensitive on the level and uppercases it', () => {
    const { ms } = localTime(1, 1, 1);
    expect(formatLogLine('Info', ms, {}, 'x')).toContain('INFO ');
  });

  it('puts the message right after the level, before any fields', () => {
    const { ms } = localTime(12, 0, 0);
    const line = formatLogLine('info', ms, { sessionId: 'abc' }, 'started');
    const msgIndex = line.indexOf('started');
    const fieldIndex = line.indexOf('sessionId=');
    expect(msgIndex).toBeGreaterThan(0);
    expect(fieldIndex).toBeGreaterThan(msgIndex);
  });

  it('orders headline keys first, in the fixed allowlist order, regardless of input order', () => {
    const { ms } = localTime(3, 3, 3);
    const line = formatLogLine(
      'info',
      ms,
      { customField: 1, rung: 'hard_stopped', sessionId: 's1', decision: 'go' },
      'msg',
    );
    const tail = line.split('msg')[1]?.trim() ?? '';
    expect(tail).toBe('sessionId=s1 decision=go rung=hard_stopped customField=1');
  });

  it('keeps non-headline keys in their original insertion order after the headline keys', () => {
    const { ms } = localTime(4, 4, 4);
    const line = formatLogLine('info', ms, { zeta: 1, alpha: 2, sessionId: 's1' }, 'msg');
    const tail = line.split('msg')[1]?.trim() ?? '';
    expect(tail).toBe('sessionId=s1 zeta=1 alpha=2');
  });

  it('omits the message segment entirely when msg is undefined', () => {
    const { ms, text } = localTime(5, 5, 5);
    const line = formatLogLine('warn', ms, { sessionId: 's1' }, undefined);
    expect(line).toBe(`${text} ${pad5('warn')}  sessionId=s1`);
  });

  it('renders just time+level for an empty object and no message', () => {
    const { ms, text } = localTime(6, 6, 6);
    expect(formatLogLine('debug', ms, {}, undefined)).toBe(`${text} ${pad5('debug')}`);
  });

  it('degrades non-object obj (null, array, primitive) to no fields instead of throwing', () => {
    const { ms } = localTime(7, 7, 7);
    expect(() => formatLogLine('info', ms, null, 'm')).not.toThrow();
    expect(() => formatLogLine('info', ms, [1, 2, 3], 'm')).not.toThrow();
    expect(() => formatLogLine('info', ms, 'not an object', 'm')).not.toThrow();
    expect(formatLogLine('info', ms, null, 'm')).not.toContain('=');
  });

  describe('err collapsing', () => {
    it('collapses a real Error to its message, with no stack by default', () => {
      const { ms } = localTime(8, 8, 8);
      const err = new Error('connect ECONNREFUSED 127.0.0.1:8765');
      const line = formatLogLine('error', ms, { err }, 'control-plane socket error');
      // The message contains spaces, so it renders quoted like any other space-containing value.
      expect(line).toContain('err="connect ECONNREFUSED 127.0.0.1:8765"');
      expect(line).not.toContain(err.stack!.split('\n')[1] ?? '__unreachable__');
    });

    it('keeps the scalar diagnostics of a pino-serialized err on the summary line', () => {
      const { ms } = localTime(9, 9, 9);
      const err = {
        type: 'Error',
        message: 'connect ECONNREFUSED 127.0.0.1:8765',
        stack: 'Error: connect ECONNREFUSED 127.0.0.1:8765\n    at TCPConnectWrap...',
        errno: -4078,
        code: 'ECONNREFUSED',
        syscall: 'connect',
      };
      const line = formatLogLine('warn', ms, { err }, 'control-plane socket error');
      expect(line).toContain(
        'err="connect ECONNREFUSED 127.0.0.1:8765" code=ECONNREFUSED errno=-4078 syscall=connect',
      );
      // The stack is the only part held back; the identifying detail stays on the line.
      expect(line).not.toContain('TCPConnectWrap');
    });

    it('prints the stack on an indented line when includeStack asks for it', () => {
      const { ms } = localTime(10, 10, 10);
      const err = { message: 'boom', stack: 'Error: boom\n    at somewhere.js:1:1' };
      const withStack = formatLogLine('debug', ms, { err }, 'failed', { includeStack: true });
      const withoutStack = formatLogLine('debug', ms, { err }, 'failed');
      expect(withStack).toContain('\n    Error: boom');
      expect(withStack).toContain('\n        at somewhere.js:1:1');
      expect(withoutStack).not.toContain('at somewhere.js:1:1');
      expect(withoutStack.split('\n')).toHaveLength(1);
    });

    it('prints the stack of an error-level line too: the gate is the caller, not the level', () => {
      // Errors are never logged at debug in this codebase, so gating the stack on the LINE's
      // own level would make it unreachable however the operator configures logging.
      const { ms } = localTime(10, 10, 11);
      const err = { message: 'boom', stack: 'Error: boom\n    at somewhere.js:1:1' };
      const line = formatLogLine('error', ms, { err }, 'failed', { includeStack: true });
      expect(line).toContain('\n        at somewhere.js:1:1');
    });

    it('never throws on a malformed err value (string, number, undefined)', () => {
      const { ms } = localTime(11, 11, 11);
      expect(() => formatLogLine('error', ms, { err: 'plain string' }, 'm')).not.toThrow();
      expect(() => formatLogLine('error', ms, { err: 42 }, 'm')).not.toThrow();
      expect(() => formatLogLine('error', ms, { err: undefined }, 'm')).not.toThrow();
      expect(formatLogLine('error', ms, { err: 'plain string' }, 'm')).toContain(
        // 'plain string' contains a space, so it renders quoted like any other value.
        'err="plain string"',
      );
    });
  });

  describe('quoting', () => {
    it('leaves a bare token unquoted', () => {
      const { ms } = localTime(0, 1, 2);
      expect(formatLogLine('info', ms, { sessionId: 'abc-123' }, 'm')).toContain(
        'sessionId=abc-123',
      );
    });

    it('quotes a value containing whitespace', () => {
      const { ms } = localTime(0, 1, 3);
      expect(formatLogLine('info', ms, { reason: 'two words' }, 'm')).toContain(
        'reason="two words"',
      );
    });

    it('quotes and escapes a value containing a double quote', () => {
      const { ms } = localTime(0, 1, 4);
      const line = formatLogLine('info', ms, { reason: 'say "hi"' }, 'm');
      expect(line).toContain('reason="say \\"hi\\""');
    });

    it('renders the empty string visibly as quotes rather than nothing', () => {
      const { ms } = localTime(0, 1, 5);
      expect(formatLogLine('info', ms, { reason: '' }, 'm')).toContain('reason=""');
    });

    it('escapes a newline so a multi-line err message stays on one physical line', () => {
      // Third-party error text (zod's ZodError.message, a JSON.parse failure on a large body)
      // is routinely multi-line, unlike every msg literal in this codebase — an unescaped `\n`
      // would let a continuation line masquerade as a fresh log record to any line-based reader.
      const { ms } = localTime(0, 1, 6);
      const err = new Error('Invalid input:\n  - field a required\n  - field b required');
      const line = formatLogLine('error', ms, { err }, 'validation failed');
      expect(line.split('\n')).toHaveLength(1);
      expect(line).toContain('err="Invalid input:\\n  - field a required\\n  - field b required"');
    });

    it('escapes a carriage return the same way as a newline', () => {
      const { ms } = localTime(0, 1, 7);
      const line = formatLogLine('info', ms, { reason: 'a\r\nb' }, 'm');
      expect(line.split('\n')).toHaveLength(1);
      expect(line).toContain('reason="a\\r\\nb"');
    });

    it('escapes a literal backslash so the quoted value round-trips unambiguously', () => {
      // Without this, a source backslash immediately followed by a real `"` would be
      // indistinguishable from the `\"` this function itself emits to escape a quote — the
      // round trip is the actual invariant that matters, so this test reverses the escaping
      // instead of asserting one hand-typed literal.
      const { ms } = localTime(0, 1, 8);
      const raw = 'C:\\logs\\daemon.log with "quote"\nand a newline';
      const line = formatLogLine('info', ms, { reason: raw }, 'm');
      const match = /reason="([\s\S]*)"$/.exec(line);
      expect(match).not.toBeNull();
      const unescaped = match![1]!.replace(/\\\\|\\"|\\r|\\n/g, (token) => {
        if (token === '\\\\') return '\\';
        if (token === '\\"') return '"';
        if (token === '\\r') return '\r';
        return '\n';
      });
      expect(unescaped).toBe(raw);
    });
  });

  describe('truncation', () => {
    it('truncates a long string value with a visible marker, never silently', () => {
      const { ms } = localTime(0, 2, 0);
      const long = 'x'.repeat(500);
      const line = formatLogLine('info', ms, { detail: long }, 'm');
      expect(line).toContain('…(+');
      expect(line).toContain('more chars)');
      expect(line.length).toBeLessThan(long.length);
    });

    it('leaves a short value untouched', () => {
      const { ms } = localTime(0, 2, 1);
      const line = formatLogLine('info', ms, { detail: 'short' }, 'm');
      expect(line).toContain('detail=short');
      expect(line).not.toContain('…');
    });
  });

  describe('value rendering', () => {
    it('renders numbers and booleans bare', () => {
      const { ms } = localTime(0, 3, 0);
      const line = formatLogLine('info', ms, { count: 5, active: true }, 'm');
      expect(line).toContain('count=5');
      expect(line).toContain('active=true');
    });

    it('renders null and undefined visibly', () => {
      const { ms } = localTime(0, 3, 1);
      const line = formatLogLine('info', ms, { a: null, b: undefined }, 'm');
      expect(line).toContain('a=null');
      expect(line).toContain('b=undefined');
    });

    it('JSON-stringifies plain objects and arrays, quoting the result since it contains quotes', () => {
      const { ms } = localTime(0, 3, 2);
      const line = formatLogLine('info', ms, { route: { kind: 'dm' } }, 'm');
      expect(line).toContain('route="{\\"kind\\":\\"dm\\"}"');
    });

    it('never throws on a circular reference, and renders a visible marker instead', () => {
      const circular: Record<string, unknown> = { a: 1 };
      circular.self = circular;
      const { ms } = localTime(0, 3, 3);
      expect(() => formatLogLine('info', ms, { circular }, 'm')).not.toThrow();
      expect(formatLogLine('info', ms, { circular }, 'm')).toContain('[unserializable');
    });

    it('marks a value JSON cannot represent instead of dumping its source', () => {
      const { ms } = localTime(0, 3, 5);
      const line = formatLogLine(
        'info',
        ms,
        {
          cb: function named(a: number) {
            return a;
          },
        },
        'm',
      );
      expect(line).toContain('[unserializable');
      expect(line).not.toContain('return a');
    });

    it('never throws on a BigInt value and renders it via a safe replacer', () => {
      const { ms } = localTime(0, 3, 4);
      const line = formatLogLine('info', ms, { big: 10n }, 'm');
      expect(line).toContain('big=10');
    });
  });
});
