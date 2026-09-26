// Terminal color for the CLI.
//
// The render helpers stay pure and plain-by-default (their tests assert exact strings);
// color is opt-in via an injected palette, chosen once at the program edge. Two rules keep
// this safe everywhere:
//  - a Paint never changes the VISIBLE width of its input (ANSI codes are zero-width), so
//    padding computed on plain text stays aligned when styled afterwards;
//  - color is only enabled on a real TTY with NO_COLOR unset, so piped/redirected output
//    and CI logs remain byte-for-byte plain.
//
// The CLI's status marks read as one vocabulary: the glyph carries the state, the color carries
// how much the reader owes it.
//   [ok] green   - fine, nothing to do.
//   [!!] red     - broken now.
//   [--] yellow  - no positive signal, and the reader is expected to act on it.
//   [--] dim     - no positive signal, but there is nothing to act on; it resolves itself once
//                  the daemon has been up long enough to measure.
// On the steady-state surfaces (`status` and the pacing line) the one glyph with two colors
// splits on whether a command is offered, so a dim line never leaves the reader hunting for one.
// `setup` is deliberately not held to that split: mid-first-run every unfinished step is yellow,
// because there the incomplete step IS what the reader is working through even when no single
// command clears it. Do not read setup's yellow as a promise that a command follows.

import { colorEnabled, sgr, type Paint } from '@claude-control/shared-protocol';
import { severityOf, type OutlookStyle, type PacingStyle } from '@claude-control/usage-advisor';

// Every account label and folder path that reaches the terminal is operator- or filesystem-
// controlled text, and both can carry bytes a terminal INTERPRETS rather than prints: SGR/OSC
// escapes (an attacker-set label could recolor or retitle the window, or hide text), C0/C1/DEL
// control codes, and the Unicode bidirectional/format controls that let a right-to-left run
// reorder a path so what the eye reads is not what the binding matched. A folder name comes from
// the filesystem and a label from `accounts add`, so neither is trustworthy on a shared box. This
// strips all of it to plain, left-to-right, printable text before anything is styled or padded.
//
// Colon at index-1 aside (kept — it's the sole legal Windows drive designator), nothing here is a
// path operation; it is purely "make this string safe to write to a TTY". Width is preserved for
// everything it KEEPS (removed controls were zero-width or interpreted, never columns), so a value
// sanitized here still aligns under the render helpers' plain-text padding.
//
// The set matches folderPath.ts's control-char refusal (C0/C1/DEL) plus the bidi/format controls
// a path canonicalizer has no reason to reject but a terminal must never honor.
const TERMINAL_UNSAFE = new RegExp(
  [
    '[\\u0000-\\u001f\\u007f-\\u009f]', // C0 controls + DEL + C1 controls (incl. ESC, the CSI/OSC lead-in)
    '[\\u200e\\u200f]', // LRM / RLM
    '[\\u202a-\\u202e]', // LRE RLE PDF LRO RLO
    '[\\u2066-\\u2069]', // LRI RLI FSI PDI
    '\\ufeff', // ZERO WIDTH NO-BREAK SPACE / BOM
  ].join('|'),
  'gu',
);

/**
 * Strip every terminal-interpreted control from a label or folder path: C0/C1/DEL (which includes
 * the ESC that begins an SGR/OSC sequence) and the Unicode bidi/format controls
 * (U+200E/F, U+202A–202E, U+2066–2069, U+FEFF). The result is plain, left-to-right, printable text
 * safe to color, pad, and write to any terminal surface. Removals are all zero-width or interpreted
 * bytes, so a kept value's visible width is unchanged. Idempotent.
 */
export function sanitizeForTerminal(value: string): string {
  return value.replace(TERMINAL_UNSAFE, '');
}

// `colorEnabled` (the NO_COLOR/TTY gate) and `sgr` (the SGR wrapper every paint below is built
// from) are defined once in shared-protocol and re-exported/reused here rather than redeclared:
// shared-protocol's own pretty-log renderer (`createLogger`) makes the identical decisions for
// the exact same reason, and the two must never disagree — on colorability, or on how a reset
// code is written — about output hitting the same terminal. See shared-protocol's ansiColor.ts.
export { colorEnabled };

/** A text decorator. Must not change the visible width of its input. Re-exported from
 *  shared-protocol (see the import above) rather than redeclared, for the same reason as
 *  `colorEnabled`. */
export type { Paint };

/** The named paints the CLI renders with. Kept small on purpose — a palette is a THEME,
 *  not a general styling library. */
export interface Palette {
  bold: Paint;
  dim: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  blue: Paint;
  magenta: Paint;
  cyan: Paint;
  /** 256-color orange — the 'high' severity band (16-color ANSI has no orange). */
  orange: Paint;
}

/** Real ANSI colors. */
export const ANSI_PALETTE: Palette = {
  bold: sgr('1'),
  dim: sgr('2'),
  red: sgr('31'),
  green: sgr('32'),
  yellow: sgr('33'),
  blue: sgr('34'),
  magenta: sgr('35'),
  cyan: sgr('36'),
  orange: sgr('38;5;208'),
};

/** The identity palette — what every render helper defaults to. */
export const PLAIN_PALETTE: Palette = {
  bold: (t) => t,
  dim: (t) => t,
  red: (t) => t,
  green: (t) => t,
  yellow: (t) => t,
  blue: (t) => t,
  magenta: (t) => t,
  cyan: (t) => t,
  orange: (t) => t,
};

/** The palette for this process's stdout — the one call sites in program.ts make. */
export function detectPalette(
  stream: { isTTY?: boolean | undefined } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): Palette {
  return colorEnabled(stream, env) ? ANSI_PALETTE : PLAIN_PALETTE;
}

/** The paint for a usage percent: the same severity bands the Discord embeds color by
 *  (green → yellow → orange → red), from the shared banding in usage-advisor. */
export function severityPaint(palette: Palette, percent: number): Paint {
  switch (severityOf(percent)) {
    case 'ok':
      return palette.green;
    case 'warn':
      return palette.yellow;
    case 'high':
      return palette.orange;
    case 'critical':
      return palette.red;
  }
}

/** Adapt a palette to `renderOutlook`'s style hooks: headings/labels pop, track furniture
 *  recedes, the 's'/'w' marks take the same two-hue split as the Discord track's
 *  blurple/violet dots (cyan/magenta is the closest 16-color analogue), and percents are
 *  severity-colored. */
export function outlookStyle(palette: Palette): OutlookStyle {
  return {
    heading: palette.bold,
    label: palette.bold,
    active: palette.green,
    dim: palette.dim,
    session: palette.cyan,
    weekly: palette.magenta,
    both: palette.yellow,
    percent: (text, pct) => severityPaint(palette, pct)(text),
    alert: palette.red,
  };
}

/** Adapt a palette to `renderPacingSummary`'s style hooks. The verdict marker follows the
 *  status-mark convention above — green `[ok]` sustainable, red `[!!]` running dry, dim `[--]`
 *  merely not measurable yet — while a fleet locked behind expired logins is a yellow `[--]`,
 *  because that one waits on a command. Headroom reuses the shared severity bands,
 *  and the waste line gets yellow: it names a real loss, but one still inside the horizon, not
 *  an active problem (that's `alert`/red territory above). */
export function pacingStyle(palette: Palette): PacingStyle {
  return {
    marker: (text, verdict) => {
      if (verdict === 'runs-dry') return palette.red(text);
      if (verdict === 'sustainable') return palette.green(text);
      return palette.dim(text);
    },
    percent: (text, pct) => severityPaint(palette, pct)(text),
    waste: palette.yellow,
    warn: palette.yellow,
    dim: palette.dim,
    // Bold, not dim: the row labels are the block's index, and a reader scanning for "expires"
    // is scanning the label column. Dimming what you scan by is the wrong end of the contrast.
    label: palette.bold,
  };
}
