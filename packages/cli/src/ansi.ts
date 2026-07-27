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

import { severityOf, type OutlookStyle, type PacingStyle } from '@claude-control/usage-advisor';

/** A text decorator. Must not change the visible width of its input. */
export type Paint = (text: string) => string;

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

/** SGR wrapper: every paint resets fully afterwards so styles never bleed across segments. */
const sgr =
  (code: string): Paint =>
  (text) =>
    `\u001b[${code}m${text}\u001b[0m`;

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

/** Should output to `stream` be colored? True only on a TTY with NO_COLOR unset — the
 *  no-color.org convention: NO_COLOR set to any non-empty value disables color. */
export function colorEnabled(
  stream: { isTTY?: boolean | undefined } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return stream.isTTY === true;
}

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
  };
}
