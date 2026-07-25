// Real token counts for work done on THIS machine, read out of Claude Code's own transcripts.
//
// Everything else cctl measures is a PERCENT of an opaque limit reported by the usage endpoint.
// Claude Code additionally writes one JSON line per assistant turn into
// `<claudeDir>/projects/<encoded-cwd>/<session>.jsonl`, and every one of those lines carries the
// turn's real `usage` block. Reading those and joining their timestamps against the attribution
// journal's activation intervals is what turns "account A sits at 62% of its weekly cap" into
// "account A burned 1.2B tokens" — an absolute number, not a percentage of an unknown.
//
// WHY THIS LIVES IN THE DAEMON PACKAGE: the two things these turns must be joined with — the
// activation intervals and the `Store` holding them — are here, and the daemon is the process
// that ships the aggregate to the phone. The CLI already depends on this package for `Store`, so
// `cctl stats` gets the reader for free; putting it in the CLI would instead force the daemon to
// depend on the CLI. It reads only local files and makes no network call of any kind.
//
// This module does IO. The aggregation it feeds is pure and lives in tokenStats.ts.
//
// THREE THINGS THIS FILE GETS RIGHT, EACH LEARNED FROM THE REAL CORPUS ON A DEVELOPMENT MACHINE
// (874 files, 6.3 GB, 101k turn lines):
//
//  1. DEDUPLICATION BY `message.id`. One API response is written as SEVERAL `assistant` lines
//     (one per content block: text, thinking, each tool_use) and every one of them repeats the
//     SAME `usage` object. Summing lines instead of responses over-counts by ~3.3x. The same key
//     also absorbs the other two duplication sources for free: a resumed/forked session copies
//     earlier turns into a new session file (158 message ids appear in more than one file), and
//     any Claude Code version that inlines a sub-agent turn into its parent transcript would
//     repeat that turn's id. `message.id` is present on 100% of turn lines where `requestId` is
//     missing on 11%, so it — not `requestId` — is the key.
//
//  2. SUB-AGENT TRANSCRIPTS COUNT, ONCE. Sub-agent turns live in their own files under
//     `<session>/subagents/**/agent-*.jsonl` (all flagged `isSidechain: true`) and are NOT
//     repeated in the parent session's file. Their tokens are real spend, so they are scanned
//     like any other file; rule 1 is what guarantees they can never be counted twice, whichever
//     layout a future CLI version writes.
//
//  3. STREAMING, ON BYTES. The largest single transcript here is 657 MB — past the 512 MB cap on
//     a JS string, so `readFile` throws outright. Lines are split on the newline BYTE and only
//     the ones whose raw bytes contain `"usage"` are decoded and parsed; decoding every
//     multi-megabyte attachment line into a JS string first costs ~3.5x the whole scan.

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** One assistant turn's recorded token usage. `cacheCreation`/`cacheRead` are kept SEPARATE from
 *  `input` deliberately: they are separate wire fields, they dominate the totals in practice
 *  (cache reads outweigh plain input by ~3 orders of magnitude on a real machine), and they are
 *  billed differently — folding them together would quietly destroy the only interesting signal. */
export interface TranscriptTurn {
  /** Epoch ms of the turn, from the line's `timestamp`. Lines without a parseable one are skipped
   *  (an unattributable, undatable turn cannot be placed in a window or against an account). */
  tsMs: number;
  /** `message.model`, verbatim. Never normalized or filtered: model ids change without notice, and
   *  silently dropping an unrecognized one would understate the totals. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** The outcome of one scan, including what it could NOT read. Every count here is rendered by the
 *  callers rather than logged and forgotten: a total computed over 40 of 442 files is a different
 *  claim from the same total over all 442, and the reader is the only layer that knows. */
export interface TranscriptScan {
  turns: TranscriptTurn[];
  /** Files opened and read to the end. */
  filesScanned: number;
  /** Files skipped without opening because their mtime predates the window (see below). */
  filesSkippedByMtime: number;
  /** Files that could not be read at all (deleted mid-scan, permission denied, IO error). */
  filesUnreadable: number;
  /** Lines that looked like a turn but would not parse — a torn write from a crash mid-append. */
  malformedLines: number;
  /** Turn lines dropped as a repeat of an already-counted `message.id` (see rule 1 above). */
  duplicateTurns: number;
}

export interface ReadTranscriptTurnsOptions {
  /** The Claude config dir — ALWAYS from `Paths.claudeDir`, never a hardcoded `~/.claude`, so
   *  `CLAUDE_CONFIG_DIR` is honored and tests can point the whole scan at a temp dir. */
  claudeDir: string;
  /** Only turns at or after this instant are returned. */
  sinceMs: number;
}

/** The byte prefilter (rule 3): a line without these bytes cannot be a turn line, and skipping it
 *  before `toString` is what keeps a 6 GB scan to a few seconds. */
const USAGE_NEEDLE = Buffer.from('"usage"');
const NEWLINE = 0x0a;

/** Read chunk size. 1 MiB is large enough that a single multi-megabyte attachment line rarely
 *  needs more than a few concatenations, without holding a meaningful amount of memory. */
const READ_CHUNK_BYTES = 1 << 20;

/**
 * Every `*.jsonl` under `<claudeDir>/projects`, at any depth — top-level session transcripts AND
 * the nested `subagents/**` sub-agent transcripts (see rule 2). A missing projects dir means
 * "Claude Code has never run under this config dir", which is an empty result, not an error; any
 * other directory-level failure is likewise swallowed per-directory so one unreadable project
 * folder cannot blind the whole scan.
 */
async function discoverTranscriptFiles(claudeDir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // missing / unreadable directory — nothing to contribute
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.jsonl')) found.push(path);
    }
  };
  await walk(join(claudeDir, 'projects'));
  return found;
}

/** Pull a turn out of one already-parsed line, or `undefined` when the line is not a turn we can
 *  count. Tolerant by construction: an unknown `type`, a missing `message`, a missing `usage`, a
 *  missing/unparseable `timestamp` and a non-numeric token field are all normal shapes in a real
 *  transcript, and each one means "skip this line", never "abort this file". */
function turnFromLine(parsed: unknown): { turn: TranscriptTurn; messageId: string | null } | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const line = parsed as Record<string, unknown>;
  if (line.type !== 'assistant') return null;

  const message = line.message;
  if (typeof message !== 'object' || message === null) return null;
  const usage = (message as Record<string, unknown>).usage;
  if (typeof usage !== 'object' || usage === null) return null;

  const tsMs = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
  if (!Number.isFinite(tsMs)) return null;

  const u = usage as Record<string, unknown>;
  const model = (message as Record<string, unknown>).model;
  const messageId = (message as Record<string, unknown>).id;
  return {
    turn: {
      tsMs,
      model: typeof model === 'string' && model !== '' ? model : 'unknown',
      inputTokens: countOf(u.input_tokens),
      outputTokens: countOf(u.output_tokens),
      cacheCreationTokens: countOf(u.cache_creation_input_tokens),
      cacheReadTokens: countOf(u.cache_read_input_tokens),
    },
    messageId: typeof messageId === 'string' && messageId !== '' ? messageId : null,
  };
}

/** A token count from an untrusted field: anything that is not a finite non-negative number reads
 *  as zero. Negative/NaN values would otherwise silently corrupt every total above them. */
function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Scan every local transcript for assistant turns at or after `sinceMs`.
 *
 * Files whose mtime predates the window are skipped WITHOUT being opened: a JSONL transcript is
 * append-only, so its last write time bounds the newest turn it can possibly hold. That is the
 * difference between reading 2.8 GB and 6.3 GB on a real machine. The reverse shortcut — stopping
 * a scan early once an old turn appears — is deliberately NOT taken: it would assume the file is
 * strictly time-ordered, and a wrong assumption there silently undercounts.
 */
export async function readTranscriptTurns(
  options: ReadTranscriptTurnsOptions,
): Promise<TranscriptScan> {
  const files = await discoverTranscriptFiles(options.claudeDir);
  const scan: TranscriptScan = {
    turns: [],
    filesScanned: 0,
    filesSkippedByMtime: 0,
    filesUnreadable: 0,
    malformedLines: 0,
    duplicateTurns: 0,
  };
  // Global across ALL files, not per file — a forked/resumed session copies earlier turns into a
  // new file, so a per-file set would let those through (see rule 1).
  const seenMessageIds = new Set<string>();

  for (const file of files) {
    try {
      const stats = await stat(file);
      if (stats.mtimeMs < options.sinceMs) {
        scan.filesSkippedByMtime++;
        continue;
      }
    } catch {
      scan.filesUnreadable++;
      continue;
    }
    try {
      await scanFile(file, options.sinceMs, seenMessageIds, scan);
      scan.filesScanned++;
    } catch {
      // Deleted mid-scan, locked, or an IO error: one unreadable file is reported in the counts
      // and the scan continues. Failing the whole command over it would be the worse trade.
      scan.filesUnreadable++;
    }
  }
  return scan;
}

/** Stream one file, appending its in-window turns to `scan`. Splits on the newline BYTE and only
 *  decodes lines whose raw bytes contain the usage needle (rule 3). */
async function scanFile(
  file: string,
  sinceMs: number,
  seenMessageIds: Set<string>,
  scan: TranscriptScan,
): Promise<void> {
  const handleLine = (bytes: Buffer): void => {
    if (bytes.length === 0 || !bytes.includes(USAGE_NEEDLE)) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      scan.malformedLines++; // torn/partial line — skip it, never abort the file
      return;
    }
    const found = turnFromLine(parsed);
    if (!found || found.turn.tsMs < sinceMs) return;
    if (found.messageId !== null) {
      if (seenMessageIds.has(found.messageId)) {
        scan.duplicateTurns++;
        return;
      }
      seenMessageIds.add(found.messageId);
    }
    scan.turns.push(found.turn);
  };

  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(file, { highWaterMark: READ_CHUNK_BYTES });
    // Bytes of the final, still-incomplete line of the previous chunk. Annotated `Buffer` (the
    // ArrayBufferLike-generic default) because `subarray` widens the backing store's type.
    let pending: Buffer = Buffer.alloc(0);
    stream.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      const buffer = pending.length > 0 ? Buffer.concat([pending, bytes]) : bytes;
      let start = 0;
      for (;;) {
        const end = buffer.indexOf(NEWLINE, start);
        if (end === -1) break;
        handleLine(buffer.subarray(start, end));
        start = end + 1;
      }
      pending = buffer.subarray(start);
    });
    stream.on('end', () => {
      if (pending.length > 0) handleLine(pending); // a final line with no trailing newline
      resolve();
    });
    stream.on('error', reject);
  });
}
