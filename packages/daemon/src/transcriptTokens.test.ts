// Transcript reader tests. Every fixture is written into a temp dir that stands in for
// `Paths.claudeDir`, so nothing here reads the developer's real ~/.claude — which is exactly why
// the reader takes the directory as an argument instead of resolving it itself.
//
// The shapes exercised below are not invented: multi-line responses sharing one `message.id`,
// forked sessions repeating turns in a second file, torn final lines, and `assistant` lines with
// no `usage` all occur in a real transcript corpus, and each one silently corrupts a total if
// mishandled.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTranscriptTurns } from './transcriptTokens.js';

// A directory listing failure has to be simulated rather than triggered with real OS
// permissions: chmod does not reliably deny a folder's own owner on every platform CI runs on,
// so a flaky permission-based test would prove nothing. Mocking `readdir` by path keeps the
// failure deterministic while every other directory still goes through the real filesystem.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readdir: vi.fn((path: string, options: { withFileTypes: true }) => {
      if (path.endsWith('locked')) {
        const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      // discoverTranscriptFiles only ever calls readdir with { withFileTypes: true }, so the
      // mock only needs to support that one shape.
      return actual.readdir(path, options);
    }),
  };
});

let root: string;
let claudeDir: string;
let projectsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-transcripts-'));
  claudeDir = join(root, 'claude');
  projectsDir = join(claudeDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One assistant turn line in Claude Code's on-disk shape. */
function turnLine(options: {
  id: string;
  ts: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
}): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp: options.ts,
    sessionId: 'session-1',
    message: {
      id: options.id,
      model: options.model ?? 'claude-sonnet-5',
      usage: {
        input_tokens: options.input ?? 1,
        output_tokens: options.output ?? 2,
        cache_creation_input_tokens: options.cacheCreation ?? 4,
        cache_read_input_tokens: options.cacheRead ?? 8,
      },
    },
  });
}

/** Write a transcript and force its mtime far into the future of the window, so a test only
 *  exercises the mtime shortcut when it deliberately sets an old one. */
async function writeTranscript(relativePath: string, lines: string[]): Promise<string> {
  const path = join(projectsDir, relativePath);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

const SINCE = Date.parse('2026-07-01T00:00:00.000Z');
const IN_WINDOW = '2026-07-10T12:00:00.000Z';

describe('readTranscriptTurns', () => {
  it('returns an empty scan when the projects directory does not exist', async () => {
    const scan = await readTranscriptTurns({ claudeDir: join(root, 'nope'), sinceMs: SINCE });
    expect(scan.turns).toEqual([]);
    expect(scan.filesScanned).toBe(0);
    expect(scan.filesUnreadable).toBe(0);
    // A missing directory is "Claude Code never ran here" / "no subagents for this session" —
    // an empty result, not a failure, so it must NOT count toward dirsUnreadable.
    expect(scan.dirsUnreadable).toBe(0);
  });

  it('counts an unreadable project directory instead of silently omitting its turns', async () => {
    await writeTranscript('good/session.jsonl', [turnLine({ id: 'msg_good', ts: IN_WINDOW })]);
    await mkdir(join(projectsDir, 'locked'), { recursive: true });
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    // The readable sibling directory's turn must still surface — one locked project cannot
    // blind the whole scan.
    expect(scan.turns).toHaveLength(1);
    expect(scan.turns[0]?.tsMs).toBe(Date.parse(IN_WINDOW));
    expect(scan.dirsUnreadable).toBe(1);
    // Distinct failure mode from an unreadable FILE — must not be folded into that counter.
    expect(scan.filesUnreadable).toBe(0);
  });

  it('reads a turn and keeps the four token kinds separate', async () => {
    await writeTranscript('proj/session.jsonl', [
      turnLine({
        id: 'msg_1',
        ts: IN_WINDOW,
        model: 'claude-opus-5',
        input: 3,
        output: 5,
        cacheCreation: 700,
        cacheRead: 90_000,
      }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toEqual([
      {
        tsMs: Date.parse(IN_WINDOW),
        model: 'claude-opus-5',
        inputTokens: 3,
        outputTokens: 5,
        cacheCreationTokens: 700,
        cacheReadTokens: 90_000,
      },
    ]);
    expect(scan.filesScanned).toBe(1);
  });

  it('counts one API response once even though it spans several assistant lines', async () => {
    // Text block, thinking block and tool_use block are three lines repeating one usage object.
    const line = turnLine({ id: 'msg_dup', ts: IN_WINDOW, output: 100 });
    await writeTranscript('proj/session.jsonl', [line, line, line]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(1);
    expect(scan.turns[0]?.outputTokens).toBe(100);
    expect(scan.duplicateTurns).toBe(2);
  });

  it('deduplicates ACROSS files, so a forked session cannot double-count its history', async () => {
    const line = turnLine({ id: 'msg_shared', ts: IN_WINDOW, output: 42 });
    await writeTranscript('proj/original.jsonl', [line]);
    await writeTranscript('proj/forked.jsonl', [line, turnLine({ id: 'msg_new', ts: IN_WINDOW })]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(2);
    expect(scan.duplicateTurns).toBe(1);
  });

  it('counts sub-agent transcripts nested under subagents/', async () => {
    await writeTranscript('proj/session.jsonl', [turnLine({ id: 'msg_parent', ts: IN_WINDOW })]);
    await writeTranscript('proj/session/subagents/agent-abc.jsonl', [
      turnLine({ id: 'msg_agent', ts: IN_WINDOW }),
    ]);
    await writeTranscript('proj/session/subagents/workflows/wf_1/agent-def.jsonl', [
      turnLine({ id: 'msg_workflow_agent', ts: IN_WINDOW }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(3);
    expect(scan.filesScanned).toBe(3);
  });

  it('skips a malformed line and keeps reading the rest of the file', async () => {
    await writeTranscript('proj/session.jsonl', [
      turnLine({ id: 'msg_before', ts: IN_WINDOW }),
      '{"type":"assistant","message":{"usage":{"input_tokens":1', // torn write
      turnLine({ id: 'msg_after', ts: IN_WINDOW }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(2);
    expect(scan.malformedLines).toBe(1);
  });

  it('ignores lines that are not countable turns without calling them malformed', async () => {
    await writeTranscript('proj/session.jsonl', [
      JSON.stringify({ type: 'user', timestamp: IN_WINDOW, message: { usage: { a: 1 } } }),
      JSON.stringify({ type: 'assistant', timestamp: IN_WINDOW, message: { id: 'x' } }),
      // A turn with usage but no timestamp cannot be windowed or attributed, so it is dropped.
      JSON.stringify({ type: 'assistant', message: { id: 'y', usage: { output_tokens: 9 } } }),
      JSON.stringify({ type: 'attachment', content: 'no usage here' }),
      turnLine({ id: 'msg_real', ts: IN_WINDOW }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(1);
    expect(scan.malformedLines).toBe(0);
  });

  it('treats missing, negative and non-numeric token fields as zero', async () => {
    await writeTranscript('proj/session.jsonl', [
      JSON.stringify({
        type: 'assistant',
        timestamp: IN_WINDOW,
        message: {
          id: 'msg_weird',
          model: 'claude-sonnet-5',
          usage: { input_tokens: -5, output_tokens: 'lots', cache_read_input_tokens: 7 },
        },
      }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns[0]).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 7,
    });
  });

  it('labels a turn with no model rather than dropping it', async () => {
    await writeTranscript('proj/session.jsonl', [
      JSON.stringify({
        type: 'assistant',
        timestamp: IN_WINDOW,
        message: { id: 'msg_nomodel', usage: { output_tokens: 3 } },
      }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns[0]?.model).toBe('unknown');
  });

  it('excludes turns older than the window even inside a recently written file', async () => {
    await writeTranscript('proj/session.jsonl', [
      turnLine({ id: 'msg_old', ts: '2026-06-01T00:00:00.000Z' }),
      turnLine({ id: 'msg_new', ts: IN_WINDOW }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns.map((t) => t.tsMs)).toEqual([Date.parse(IN_WINDOW)]);
  });

  it('skips a file untouched since before the window without opening it', async () => {
    const stale = await writeTranscript('proj/stale.jsonl', [
      turnLine({ id: 'msg_stale', ts: IN_WINDOW }),
    ]);
    await writeTranscript('proj/fresh.jsonl', [turnLine({ id: 'msg_fresh', ts: IN_WINDOW })]);
    const staleSeconds = (SINCE - 86_400_000) / 1000;
    await utimes(stale, staleSeconds, staleSeconds);

    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    // The stale file's turn is INSIDE the window, so only the mtime shortcut can exclude it —
    // which is precisely what makes this assertion prove the shortcut ran.
    expect(scan.turns).toHaveLength(1);
    expect(scan.filesScanned).toBe(1);
    expect(scan.filesSkippedByMtime).toBe(1);
  });

  it('counts a final line that has no trailing newline', async () => {
    const path = join(projectsDir, 'proj', 'session.jsonl');
    await mkdir(join(projectsDir, 'proj'), { recursive: true });
    await writeFile(path, turnLine({ id: 'msg_tail', ts: IN_WINDOW }), 'utf8');
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(1);
  });

  it('splits lines correctly when one spans several read chunks', async () => {
    // A single multi-megabyte line (attachments really are this big) must not be mis-split at a
    // chunk boundary, which would turn one valid line into two malformed halves.
    const filler = 'x'.repeat(3_000_000);
    await writeTranscript('proj/session.jsonl', [
      JSON.stringify({ type: 'attachment', content: filler, note: 'no usage key' }),
      turnLine({ id: 'msg_after_big', ts: IN_WINDOW }),
    ]);
    const scan = await readTranscriptTurns({ claudeDir, sinceMs: SINCE });
    expect(scan.turns).toHaveLength(1);
    expect(scan.malformedLines).toBe(0);
  });
});
