import { describe, it, expect } from 'vitest';
import {
  stripAnsi,
  splitCompleteLines,
  collapseRepeats,
  classifyLine,
  summarizeText,
} from './summarizer.js';

describe('stripAnsi', () => {
  it('removes CSI color/cursor sequences', () => {
    expect(stripAnsi('\x1b[31mhello\x1b[0m')).toBe('hello');
    expect(stripAnsi('\x1b[2K\x1b[1Gworking')).toBe('working');
  });

  it('removes OSC sequences terminated by BEL or ST', () => {
    expect(stripAnsi('\x1b]0;window title\x07plain')).toBe('plain');
    expect(stripAnsi('\x1b]8;;https://example.com\x1b\\link text')).toBe('link text');
  });

  it('leaves plain text untouched', () => {
    expect(stripAnsi('no escapes here')).toBe('no escapes here');
  });
});

describe('splitCompleteLines', () => {
  it('splits on \\n and keeps a trailing partial fragment', () => {
    const { lines, rest } = splitCompleteLines('one\ntwo\nthree-partial');
    expect(lines).toEqual(['one', 'two']);
    expect(rest).toBe('three-partial');
  });

  it('treats \\r\\n as a single terminator', () => {
    const { lines, rest } = splitCompleteLines('a\r\nb\r\n');
    expect(lines).toEqual(['a', 'b']);
    expect(rest).toBe('');
  });

  it('treats bare \\r as a terminator (progress-bar redraws)', () => {
    const { lines, rest } = splitCompleteLines('50%\r100%\r');
    expect(lines).toEqual(['50%', '100%']);
    expect(rest).toBe('');
  });

  it('returns the whole buffer as rest when there is no terminator', () => {
    const { lines, rest } = splitCompleteLines('no newline yet');
    expect(lines).toEqual([]);
    expect(rest).toBe('no newline yet');
  });

  it('handles a terminator split across two chunks by leaving rest empty then flushing on the next call', () => {
    // \r arrives alone at the end of chunk 1 (the \n hasn't arrived yet).
    const first = splitCompleteLines('line one\r');
    expect(first.lines).toEqual(['line one']);
    expect(first.rest).toBe('');
    // \n arrives at the start of chunk 2 with nothing before it — an empty line, which is
    // correct: the \r already closed "line one", so this \n closes an empty continuation.
    const second = splitCompleteLines('\nline two');
    expect(second.lines).toEqual(['']);
    expect(second.rest).toBe('line two');
  });
});

describe('collapseRepeats', () => {
  it('drops consecutive duplicates, keeping the first', () => {
    expect(collapseRepeats(['a', 'a', 'a', 'b', 'b', 'a'])).toEqual(['a', 'b', 'a']);
  });

  it('is a no-op when there are no duplicates', () => {
    expect(collapseRepeats(['a', 'b', 'c'])).toEqual(['a', 'b', 'c']);
  });

  it('handles an empty array', () => {
    expect(collapseRepeats([])).toEqual([]);
  });

  it('does not collapse non-adjacent duplicates', () => {
    expect(collapseRepeats(['a', 'b', 'a'])).toEqual(['a', 'b', 'a']);
  });
});

describe('classifyLine', () => {
  it('treats blank and whitespace-only lines as noise', () => {
    expect(classifyLine('')).toBeNull();
    expect(classifyLine('   ')).toBeNull();
    expect(classifyLine('\t')).toBeNull();
  });

  it('treats spinner-only lines as noise', () => {
    expect(classifyLine('⠋')).toBeNull();
    expect(classifyLine('  ⠙  ')).toBeNull();
  });

  it('classifies the managed-session tool-invocation prefix as a milestone', () => {
    expect(classifyLine('Tool: Bash')).toEqual({ kind: 'milestone', text: 'Tool: Bash' });
  });

  it('classifies the managed-session tool-result prefix as a milestone', () => {
    expect(classifyLine('Tool result: Bash ok')).toEqual({
      kind: 'milestone',
      text: 'Tool result: Bash ok',
    });
  });

  it('classifies the managed-session permission prefix as a milestone', () => {
    expect(classifyLine('Permission required: Bash - run tests')).toEqual({
      kind: 'milestone',
      text: 'Permission required: Bash - run tests',
    });
  });

  it('classifies the managed-session completion prefix as a summary, even when it contains "failed"', () => {
    expect(classifyLine('Session complete: all tests passed')).toEqual({
      kind: 'summary',
      text: 'Session complete: all tests passed',
    });
    expect(classifyLine('Session failed: build error')).toEqual({
      kind: 'summary',
      text: 'Session failed: build error',
    });
  });

  it('does not let a tool-result failure line get reclassified as a generic error', () => {
    // "Tool result: " prefix must win over the generic /error|failed/ heuristic.
    const event = classifyLine('Tool result: Bash failed: command not found');
    expect(event).toEqual({
      kind: 'milestone',
      text: 'Tool result: Bash failed: command not found',
    });
  });

  it('classifies generic error/exception/traceback lines as errors', () => {
    expect(classifyLine('TypeError: cannot read property of undefined')).toEqual({
      kind: 'error',
      text: 'TypeError: cannot read property of undefined',
    });
    expect(classifyLine('Traceback (most recent call last):')).toEqual({
      kind: 'error',
      text: 'Traceback (most recent call last):',
    });
    expect(classifyLine('fatal: not a git repository')).toEqual({
      kind: 'error',
      text: 'fatal: not a git repository',
    });
  });

  it('classifies generic file-write lines as milestones', () => {
    expect(classifyLine('Wrote 42 lines to src/index.ts')).toEqual({
      kind: 'milestone',
      text: 'Wrote 42 lines to src/index.ts',
    });
    expect(classifyLine('Created file notes.md')).toEqual({
      kind: 'milestone',
      text: 'Created file notes.md',
    });
  });

  it('classifies a shell prompt line as a milestone', () => {
    expect(classifyLine('$ npm test')).toEqual({ kind: 'milestone', text: '$ npm test' });
    expect(classifyLine('> git status')).toEqual({ kind: 'milestone', text: '> git status' });
  });

  it('classifies Running:/Executing: lines as milestones', () => {
    expect(classifyLine('Running: pytest')).toEqual({
      kind: 'milestone',
      text: 'Running: pytest',
    });
  });

  it('falls back to output for ordinary prose', () => {
    expect(classifyLine('I will now refactor the parser.')).toEqual({
      kind: 'output',
      text: 'I will now refactor the parser.',
    });
  });

  it('strips ANSI codes and trailing whitespace before classifying', () => {
    expect(classifyLine('\x1b[32mdone\x1b[0m  ')).toEqual({ kind: 'output', text: 'done' });
  });
});

describe('summarizeText', () => {
  it('splits, dedupes, classifies, and drops noise in one pass', () => {
    const text = ['Tool: Read', 'Tool: Read', '', 'plain output line', '⠋'].join('\n');
    expect(summarizeText(text)).toEqual([
      { kind: 'milestone', text: 'Tool: Read' },
      { kind: 'output', text: 'plain output line' },
    ]);
  });

  it('returns an empty array for all-noise input', () => {
    expect(summarizeText('\n\n   \n')).toEqual([]);
  });

  it('classifies a single line with no trailing newline', () => {
    expect(summarizeText('Session complete: done')).toEqual([
      { kind: 'summary', text: 'Session complete: done' },
    ]);
  });
});
