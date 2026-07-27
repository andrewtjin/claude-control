// Minimal ANSI helpers shared by every process that renders pretty log lines to a real
// terminal: `cctl daemon run`'s own logger and the credential-firewalled control-plane bot (see
// control-plane-bot/bin.ts's module comment — it may import ONLY this package, never the CLI's
// packages/cli/src/ansi.ts, which pulls in usage-advisor and beyond). `colorEnabled` here is the
// SINGLE source of truth for "is this stream colorable" — the CLI re-exports it rather than
// re-deriving the same NO_COLOR/TTY check, so its tables/summaries and its pretty logs can never
// disagree about a given stream. Kept intentionally tiny: just the gate plus the one palette
// `formatLogLine` renders with, not a general styling kit.

import type { LogLineColors, Paint } from './logFormat.js';

/** SGR wrapper: every paint resets fully afterwards so styles never bleed across segments. */
const sgr =
  (code: string): Paint =>
  (text) =>
    `[${code}m${text}[0m`;

const RED = sgr('31');
const YELLOW = sgr('33');
const DIM = sgr('2');
/** Identity paint: used for level words that don't earn a color (see `ansiLogColors`). */
const PLAIN: Paint = (text) => text;

/** Should output to `stream` be colored? True only on a real TTY with NO_COLOR unset — the
 *  no-color.org convention: NO_COLOR set to any non-empty value disables color regardless of
 *  its value. */
export function colorEnabled(
  stream: { isTTY?: boolean | undefined } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return false;
  return stream.isTTY === true;
}

/** The palette `formatLogLine` renders with when color is enabled: red for error/fatal (pino's
 *  two "something is broken" levels), yellow for warn, no color for anything quieter — so only
 *  the levels an operator actually needs to catch while scrolling get a color at all. */
export function ansiLogColors(): LogLineColors {
  return {
    level: (level) => {
      const normalized = level.toLowerCase();
      if (normalized === 'error' || normalized === 'fatal') return RED;
      if (normalized === 'warn') return YELLOW;
      return PLAIN;
    },
    dim: DIM,
  };
}
