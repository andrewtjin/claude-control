// Width arithmetic for a screen drawn one full frame at a time.
//
// A frame line that runs one column past the terminal's edge corrupts every line below it, so
// every cell is measured in terminal columns (not UTF-16 units, see ../textWidth.ts) and cut
// before it is painted. Two helpers cover the two kinds of text the view draws: plain cells it
// builds itself (`fit`), and lines an existing renderer already painted (`truncateAnsi`), which
// must be cut without counting or breaking their escape sequences. Cutting is by grapheme cluster,
// so an emoji sequence or a letter with its marks is never split.

import { clusterWidth, clustersOf, displayWidth } from '../textWidth.js';

export { charWidth, displayWidth } from '../textWidth.js';

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
/** A CSI sequence (`ESC [` parameters, then one final byte). */
const CSI = new RegExp(`^${ESC}\\[[0-?]*[ -/]*[@-~]`);
/** An SGR sequence (color and weight): the only escape a frame line may carry. */
const SGR = new RegExp(`^${ESC}\\[[0-9;:]*m`);
/** An OSC sequence (a window title, a clipboard write, a hyperlink), ended by BEL or ST. */
const OSC = new RegExp(`^${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)?`);
/** The full reset a cut line ends with, so a style opened before the cut never bleeds on. */
const RESET = `${ESC}[0m`;
/**
 * What a cut cell ends with, so a shortened label never passes for the whole one. ASCII on
 * purpose: the typographic ellipsis is "ambiguous width", two columns on a terminal set up for CJK
 * text, and a glyph whose width depends on the terminal cannot be measured.
 */
export const ELLIPSIS = '..';

/** Cut plain text to at most `width` columns, never splitting a cluster. */
function cut(text: string, width: number): string {
  let out = '';
  let used = 0;
  for (const cluster of clustersOf(text)) {
    const w = clusterWidth(cluster);
    if (used + w > width) break;
    out += cluster;
    used += w;
  }
  return out;
}

/** The last at most `width` columns of plain text, never splitting a cluster. */
export function cutTail(text: string, width: number): string {
  const clusters = clustersOf(text);
  let out = '';
  let used = 0;
  for (let i = clusters.length - 1; i >= 0; i -= 1) {
    const w = clusterWidth(clusters[i]!);
    if (used + w > width) break;
    out = clusters[i]! + out;
    used += w;
  }
  return out;
}

/** Text shortened to at most `width` columns, ending with the ellipsis. Too narrow for the
 *  ellipsis to leave any text, it is a plain cut. */
function shorten(text: string, width: number): string {
  return width <= ELLIPSIS.length
    ? cut(text, width)
    : cut(text, width - ELLIPSIS.length) + ELLIPSIS;
}

/** Plain text in exactly `width` columns: padded with spaces, or cut and ended with an ellipsis
 *  when it does not fit. Zero or less gives the empty string. */
export function fit(text: string, width: number): string {
  if (width <= 0) return '';
  const w = displayWidth(text);
  if (w <= width) return text + ' '.repeat(width - w);
  const kept = shorten(text, width);
  return kept + ' '.repeat(Math.max(0, width - displayWidth(kept)));
}

/** Plain text cut to at most `width` columns (ellipsis when cut), without padding. */
export function clip(text: string, width: number): string {
  if (width <= 0) return '';
  return displayWidth(text) <= width ? text : shorten(text, width);
}

/**
 * Plain text broken into lines of at most `width` columns: at spaces where it can, mid-word where
 * a word (a long path) is wider than a line on its own. An empty text is one empty line.
 */
export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (displayWidth(candidate) <= width) {
      line = candidate;
      continue;
    }
    if (line !== '') lines.push(line);
    let rest = word;
    while (displayWidth(rest) > width) {
      const head = cut(rest, width);
      // A single cluster wider than the whole line: nothing more of this word can be placed.
      if (head === '') {
        rest = '';
        break;
      }
      lines.push(head);
      rest = rest.slice(head.length);
    }
    line = rest;
  }
  lines.push(line);
  return lines;
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
    const next = line.indexOf(ESC, i);
    const run = line.slice(i, next === -1 ? line.length : next);
    for (const cluster of clustersOf(run)) {
      const w = clusterWidth(cluster);
      if (used + w > width) return styled ? out + RESET : out;
      out += cluster;
      used += w;
    }
    i += run.length;
  }
  return out;
}

/**
 * A painted line made safe to write: SGR sequences (color, weight) are kept, and every other
 * escape (cursor moves, screen switches, OSC title or clipboard writes) and every control byte
 * (a carriage return that would overwrite the line, a BEL) is removed whole. Applied to every
 * frame line, so text from any renderer, sanitized at its source or not, cannot take over the
 * terminal.
 */
export function keepColorOnly(line: string): string {
  let out = '';
  let i = 0;
  while (i < line.length) {
    const code = line.charCodeAt(i);
    if (code === 27) {
      const rest = line.slice(i);
      const sgr = SGR.exec(rest);
      if (sgr) {
        out += sgr[0];
        i += sgr[0].length;
        continue;
      }
      const seq = CSI.exec(rest) ?? OSC.exec(rest);
      i += seq ? seq[0].length : 1;
      continue;
    }
    if (code < 0x20 || code === 0x7f || (code >= 0x80 && code < 0xa0)) {
      i += 1;
      continue;
    }
    out += line[i];
    i += 1;
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
