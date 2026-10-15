// Width arithmetic for a screen drawn one full frame at a time.
//
// A frame line that runs one column past the terminal's edge corrupts every line below it, so
// every cell is measured in terminal columns (not UTF-16 units) and cut before it is painted. Two
// helpers cover the two kinds of text the view draws: plain cells it builds itself (`fit`), and
// lines an existing renderer already painted (`truncateAnsi`), which must be cut without counting
// or breaking their escape sequences.

const ESC = String.fromCharCode(27);
/** A CSI sequence (`ESC [` parameters, then one final byte), the only escapes the renderers emit. */
const CSI = new RegExp(`^${ESC}\\[[0-?]*[ -/]*[@-~]`);
/** The full reset a cut line ends with, so a style opened before the cut never bleeds on. */
const RESET = `${ESC}[0m`;
/** What a cut cell ends with, so a shortened label never passes for the whole one. */
export const ELLIPSIS = '…';

/** Wide (two-column) code point ranges: CJK, Hangul, full-width forms and the emoji blocks. An
 *  approximation of East Asian Width, enough to keep labels in those scripts aligned. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff],
  [0x20000, 0x3fffd],
];

/** Columns one code point takes: 0 for combining marks and zero-width joiners, 2 for wide
 *  characters, 1 otherwise. */
export function charWidth(codePoint: number): number {
  if (
    (codePoint >= 0x300 && codePoint <= 0x36f) ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }
  for (const [lo, hi] of WIDE) {
    if (codePoint >= lo && codePoint <= hi) return 2;
  }
  return 1;
}

/** Columns a plain (escape-free) string takes. */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** Cut plain text to at most `width` columns, never splitting a wide character. */
function cut(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > width) break;
    out += ch;
    used += w;
  }
  return out;
}

/** Plain text in exactly `width` columns: padded with spaces, or cut and ended with an ellipsis
 *  when it does not fit. Zero or less gives the empty string. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const w = displayWidth(text);
  if (w <= width) return text + ' '.repeat(width - w);
  const kept = cut(text, width - 1) + ELLIPSIS;
  return kept + ' '.repeat(Math.max(0, width - displayWidth(kept)));
}

/** Plain text cut to at most `width` columns (ellipsis when cut), without padding. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  return displayWidth(text) <= width ? text : cut(text, width - 1) + ELLIPSIS;
}

/**
 * Cut an already-painted line to at most `width` visible columns. Escape sequences are kept and
 * cost nothing; a line that was cut and had opened a style ends with a full reset.
 */
export function truncateAnsi(line: string, width: number): string {
  let out = '';
  let used = 0;
  let styled = false;
  let i = 0;
  while (i < line.length) {
    if (line[i] === ESC) {
      const seq = CSI.exec(line.slice(i));
      if (seq) {
        out += seq[0];
        styled = true;
        i += seq[0].length;
        continue;
      }
      // A lone or unknown escape is dropped rather than counted or passed to the terminal.
      i += 1;
      continue;
    }
    const cp = line.codePointAt(i) ?? 0;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (used + w > width) return styled ? out + RESET : out;
    out += ch;
    used += w;
    i += ch.length;
  }
  return out;
}

/** Every CSI sequence in a line. */
const CSI_ALL = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');

/** A painted line with its CSI sequences removed whole. Stripping only the ESC byte (what a
 *  generic control-character filter does) would leave their visible tails, like "[31m". */
export function stripAnsi(line: string): string {
  return line.replace(CSI_ALL, '');
}

/** Visible columns of a painted line (escapes cost nothing). */
export function visibleWidth(line: string): number {
  return displayWidth(stripAnsi(line));
}
