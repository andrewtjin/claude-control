// How many terminal columns text takes, for every renderer that lines text up in columns.
//
// A column counted by UTF-16 length (`String.length`, `padEnd`) is wrong for anything outside
// ASCII: a CJK character or an emoji takes two columns and one unit or two, a combining mark takes
// none. Text is measured here one grapheme cluster (what a person sees as one character) at a
// time, so an emoji sequence, a flag or a base letter with its marks is measured as the single
// glyph a terminal draws.
//
// The widths follow what wcwidth-based terminals (Windows Terminal, iTerm2, VTE, kitty) draw: East
// Asian Wide and emoji-presentation characters take two columns, nonspacing marks and format
// characters none. Ambiguous-width characters (Greek and Cyrillic letters, many accented Latin
// ones, typographic punctuation; see ./eastAsianAmbiguous.ts) take one column on most terminals
// and two on one set up for CJK text. Nothing in the text says which, so they are counted as one
// until the terminal itself has been asked (`setAmbiguousWidth`): the full-screen view measures a
// probe glyph when it starts and sets the answer here, so every label, path and error it draws is
// measured as that terminal draws it. Renderers keep their own glyphs ASCII, and the view spells
// cctl's own messages through `plainPunctuation`, so a terminal that never answers still gets
// lines as wide as they were measured wherever cctl wrote the text.

import { EAST_ASIAN_AMBIGUOUS } from './eastAsianAmbiguous.js';

/** Wide (two-column) code point ranges: CJK, Hangul syllables, full-width forms. Emoji are found
 *  by their Unicode property instead, so a new emoji block needs no new range here. */
const WIDE: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd],
];

/** Nonspacing and enclosing marks and format characters (the zero-width joiner, the variation
 *  selectors' neighbours): drawn on the character before them or not at all. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
/** Characters a terminal draws as a two-column emoji by default. */
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /^\p{Regional_Indicator}$/u;
/** An emoji that takes a skin tone, then the tone: drawn as one toned emoji, joiner or not. */
const TONED = /^\p{Emoji_Modifier_Base}\p{Emoji_Modifier}/u;
// Written as escapes: as literal characters these are invisible in an editor or a diff.
const VS15 = '\uFE0E';
const VS16 = '\uFE0F';
const ZWJ = '\u200D';
/** Plain printable ASCII: one column per character, the case worth a fast path. */
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Columns an ambiguous-width character takes on the terminal this process draws on. A process
 *  has one terminal, so this is set once for every renderer rather than passed to each. */
let ambiguousColumns: 1 | 2 = 1;

/** Say how wide the terminal draws ambiguous-width characters, once it has been measured. */
export function setAmbiguousWidth(columns: 1 | 2): void {
  ambiguousColumns = columns;
}

/** How wide ambiguous-width characters are counted now: 1 until the terminal says otherwise. */
export function ambiguousWidth(): 1 | 2 {
  return ambiguousColumns;
}

/** Whether a code point is East Asian Ambiguous: a binary search of the sorted ranges. */
function isAmbiguous(codePoint: number): boolean {
  let lo = 0;
  let hi = EAST_ASIAN_AMBIGUOUS.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [from, to] = EAST_ASIAN_AMBIGUOUS[mid]!;
    if (codePoint < from) hi = mid - 1;
    else if (codePoint > to) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Columns a character that is neither wide nor zero-width takes: one, or the terminal's
 *  ambiguous width for an ambiguous one. The table is only searched when that width is not 1. */
function narrowWidth(codePoint: number): number {
  return ambiguousColumns !== 1 && isAmbiguous(codePoint) ? ambiguousColumns : 1;
}

/** Columns one code point takes on its own: 0 for controls, marks and joiners (and the Hangul
 *  vowel and final jamo that join a leading one), 2 for wide and emoji-presentation characters,
 *  the terminal's ambiguous width for an ambiguous one, 1 otherwise. */
export function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint < 0x300) return narrowWidth(codePoint);
  const ch = String.fromCodePoint(codePoint);
  if (
    ZERO_WIDTH.test(ch) ||
    (codePoint >= 0x1160 && codePoint <= 0x11ff) ||
    (codePoint >= 0xd7b0 && codePoint <= 0xd7ff)
  ) {
    return 0;
  }
  for (const [lo, hi] of WIDE) {
    if (codePoint >= lo && codePoint <= hi) return 2;
  }
  return EMOJI_PRESENTATION.test(ch) ? 2 : narrowWidth(codePoint);
}

/** Columns one grapheme cluster takes. An emoji sequence (a presentation selector, a joined
 *  family, a flag, a skin tone) is one two-column glyph; anything else is the sum of its code
 *  points, so a letter with its marks takes the letter's width. */
export function clusterWidth(cluster: string): number {
  if (cluster.length === 1) return charWidth(cluster.charCodeAt(0));
  const codePoints = [...cluster];
  if (codePoints.length > 1) {
    if (cluster.includes(VS15)) {
      // Text presentation: an emoji drawn as a narrow glyph, which an ambiguous one still is.
      const base = codePoints[0]!.codePointAt(0) ?? 0;
      return charWidth(base) > 0 ? narrowWidth(base) : 0;
    }
    if (
      cluster.includes(VS16) ||
      (cluster.includes(ZWJ) && PICTOGRAPHIC.test(cluster)) ||
      REGIONAL_INDICATOR.test(codePoints[0]!) ||
      TONED.test(cluster)
    ) {
      return 2;
    }
  }
  let width = 0;
  for (const ch of codePoints) width += charWidth(ch.codePointAt(0) ?? 0);
  return width;
}

/** The grapheme clusters of `text`, in order. */
export function clustersOf(text: string): string[] {
  return Array.from(graphemes.segment(text), (s) => s.segment);
}

/** Columns a plain (escape-free) string takes. */
export function displayWidth(text: string): number {
  if (PRINTABLE_ASCII.test(text)) return text.length;
  let width = 0;
  for (const cluster of clustersOf(text)) width += clusterWidth(cluster);
  return width;
}

/** `text` padded with spaces to `width` columns: `padEnd`, counted in columns. Text already as
 *  wide or wider is returned as it is. */
export function padEndColumns(text: string, width: number): string {
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

/** Typographic punctuation and the ASCII each is spelled with on screen. Every one is ambiguous
 *  width: one column on most terminals, two on one set up for CJK text, so on a terminal that did
 *  not say which, a line cut to its width that holds one can run past the edge. Every non-ASCII
 *  character that takes a column in the string literals of the packages whose text reaches the
 *  view is in this table (the test reads their sources to hold that), so a new one in a message
 *  is caught when it is written. */
const PLAIN_PUNCTUATION: ReadonlyMap<string, string> = new Map([
  ['–', '-'], // en dash
  ['—', '-'], // em dash
  ['…', '...'], // ellipsis
  ['·', '-'], // middle dot
  ['•', '-'], // bullet
  ['‘', "'"],
  ['’', "'"],
  ['“', '"'],
  ['”', '"'],
  ['→', '->'],
]);
const TYPOGRAPHIC = new RegExp(`[${[...PLAIN_PUNCTUATION.keys()].join('')}]`, 'gu');

/**
 * A message of cctl's own (an auto-switch reason, a refusal, an error) with its typographic
 * punctuation spelled in ASCII, so it is as wide on every terminal, including one that never
 * says how it draws ambiguous-width characters. Only for messages: a label is shown as it is
 * stored, since a person types it back, and is measured with the terminal's ambiguous width.
 */
export function plainPunctuation(text: string): string {
  return text.replace(TYPOGRAPHIC, (ch) => PLAIN_PUNCTUATION.get(ch) ?? ch);
}
