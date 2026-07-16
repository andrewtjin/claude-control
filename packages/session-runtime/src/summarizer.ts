// Pure text -> SessionEvent classification, shared by both backends. managedSession turns
// each Agent SDK message into one or more plain-text lines first (see agentEventToLines in
// managedSession.ts); observedSession feeds raw ConPTY output straight in. Routing both
// through the same classifier means "what counts as a milestone" is defined exactly once.
//
// Every function here is pure (no IO, no mutable module state) so the heuristics can be
// exhaustively table-tested without faking a session, a process, or a clock.

import type { SessionEvent } from './types.js';

// ---------------------------------------------------------------------------
// ANSI / terminal noise stripping
// ---------------------------------------------------------------------------

// Matches CSI sequences (cursor movement, color, clear-line: ESC [ ... letter) and OSC
// sequences (window title, hyperlinks: ESC ] ... BEL or ESC\). Covers the escape codes a
// real terminal (ConPTY, xterm) actually emits; it is not a full VT100 parser, but a
// human-readable line never needs one to be readable.
const ANSI_PATTERN =
  // eslint-disable-next-line no-control-regex -- deliberately matching ESC (0x1b) to strip it
  /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

/** Strip ANSI escape sequences a terminal would render but a phone screen never should. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

// A line that, once ANSI codes are gone, is either empty or is only a spinner glyph
// (braille/box-drawing frames CLIs use for "working…" animations) carries no information —
// it is the definition of terminal noise.
const SPINNER_ONLY_PATTERN = /^[\s⠀-⣿■-◿.]*$/;

// ---------------------------------------------------------------------------
// Line splitting for streamed output
// ---------------------------------------------------------------------------

/**
 * Split a streaming buffer into complete lines plus a trailing partial fragment. Terminal
 * output (and Agent SDK text deltas) can arrive in arbitrary-sized chunks that split a
 * line anywhere — mid-escape-sequence, mid-word — so a caller must carry `rest` forward
 * into the next chunk rather than treat one chunk as one line. Recognizes `\n`, `\r\n`,
 * and bare `\r` (carriage-return redraws, the mechanism progress bars use) as terminators.
 */
export function splitCompleteLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < buffer.length; i++) {
    const ch = buffer[i];
    if (ch === '\n' || ch === '\r') {
      lines.push(buffer.slice(start, i));
      // \r\n is one terminator, not two empty lines.
      if (ch === '\r' && buffer[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  return { lines, rest: buffer.slice(start) };
}

// ---------------------------------------------------------------------------
// Noise collapsing
// ---------------------------------------------------------------------------

/**
 * Drop consecutive exact-duplicate lines, keeping only the first. Progress bars and
 * "Thinking…" polls redraw the identical line over and over (especially once ANSI cursor
 * codes are stripped, several visually-different redraws collapse to the same text) — a
 * phone should see that once, not fifty times.
 */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = [];
  let prev: string | undefined;
  for (const line of lines) {
    if (line === prev) continue;
    out.push(line);
    prev = line;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Line classification
// ---------------------------------------------------------------------------

// Lines managedSession itself emits (see agentEventToLines) use these fixed prefixes, so
// they classify deterministically rather than by fuzzy content matching. Observed-terminal
// output obviously won't use these prefixes, which is fine — it falls through to the
// generic heuristics below.
const TOOL_PREFIX_PATTERN = /^Tool: /;
const TOOL_RESULT_PREFIX_PATTERN = /^Tool result: /;
const PERMISSION_PREFIX_PATTERN = /^Permission required: /;
const COMPLETION_PREFIX_PATTERN = /^Session (complete|failed): /;

// Generic heuristics for arbitrary terminal/process output (observed sessions, or
// managed-session assistant prose that happens to describe what it did). The `\w+Error\b`
// / `\w+Exception\b` arms exist so language-specific exception class names (TypeError,
// NullPointerException) match even though "error"/"exception" aren't standalone words
// there; the tradeoff is a rare false positive on an unrelated word that happens to end
// in "...error" (e.g. "terror") — acceptable for a heuristic that only affects display.
const GENERIC_ERROR_PATTERN =
  /\berror\b|\bexception\b|\btraceback\b|\bfatal\b|\w+Error\b|\w+Exception\b/i;
const GENERIC_FILE_WRITE_PATTERN =
  /\b(wrote|created|updated|deleted|modified)\b.*[\w./\\-]+\.[a-zA-Z0-9]+/i;
const GENERIC_SHELL_PROMPT_PATTERN = /^\s*[$#>]\s+\S/;
const GENERIC_RUNNING_PATTERN = /^(Running|Executing):/i;

/**
 * Classify a single already-split line into a `SessionEvent`, or `null` when the line is
 * pure noise (blank, spinner-only). Order matters: our own structured prefixes are checked
 * before the generic fuzzy heuristics so a line like "Tool result: Bash failed: exit 1"
 * classifies as the tool-result milestone it is, not a generic error line.
 */
export function classifyLine(line: string): SessionEvent | null {
  const clean = stripAnsi(line).trimEnd();
  if (clean.trim().length === 0) return null;
  if (SPINNER_ONLY_PATTERN.test(clean)) return null;

  if (COMPLETION_PREFIX_PATTERN.test(clean)) return { kind: 'summary', text: clean };
  if (
    TOOL_PREFIX_PATTERN.test(clean) ||
    TOOL_RESULT_PREFIX_PATTERN.test(clean) ||
    PERMISSION_PREFIX_PATTERN.test(clean)
  ) {
    return { kind: 'milestone', text: clean };
  }

  if (GENERIC_ERROR_PATTERN.test(clean)) return { kind: 'error', text: clean };
  if (
    GENERIC_FILE_WRITE_PATTERN.test(clean) ||
    GENERIC_SHELL_PROMPT_PATTERN.test(clean) ||
    GENERIC_RUNNING_PATTERN.test(clean)
  ) {
    return { kind: 'milestone', text: clean };
  }

  return { kind: 'output', text: clean };
}

/**
 * Convenience wrapper for callers with a whole finished chunk of text (managedSession's
 * self-generated lines, always `\n`-terminated): strip ANSI, split, dedupe, classify, and
 * drop noise. Streaming callers with partial lines to buffer should use
 * `splitCompleteLines` + `classifyLine` directly instead — see observedSession.ts.
 */
export function summarizeText(text: string): SessionEvent[] {
  const lines = collapseRepeats(text.split('\n'));
  const events: SessionEvent[] = [];
  for (const line of lines) {
    const event = classifyLine(line);
    if (event) events.push(event);
  }
  return events;
}
