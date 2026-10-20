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
// characters none. Ambiguous-width characters are counted as one column, which is how most
// terminals are set up. So that nothing cctl draws depends on that setting, renderers keep their
// own glyphs ASCII, and the full-screen view draws cctl's own messages through `plainPunctuation`.

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

/** Columns one code point takes on its own: 0 for controls, marks and joiners (and the Hangul
 *  vowel and final jamo that join a leading one), 2 for wide and emoji-presentation characters, 1
 *  otherwise. */
export function charWidth(codePoint: number): number {
  if (codePoint < 0x20 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (codePoint < 0x300) return 1;
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
  return EMOJI_PRESENTATION.test(ch) ? 2 : 1;
}

/** Columns one grapheme cluster takes. An emoji sequence (a presentation selector, a joined
 *  family, a flag, a skin tone) is one two-column glyph; anything else is the sum of its code
 *  points, so a letter with its marks takes the letter's width. */
export function clusterWidth(cluster: string): number {
  if (cluster.length === 1) return charWidth(cluster.charCodeAt(0));
  const codePoints = [...cluster];
  if (codePoints.length > 1) {
    if (cluster.includes(VS15)) return charWidth(codePoints[0]!.codePointAt(0) ?? 0) > 0 ? 1 : 0;
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
 *  width: one column on most terminals, two on one set up for CJK text, so a line cut to the
 *  terminal's width that holds one can run past the edge there. Every non-ASCII character that
 *  takes a column in the string literals of the packages whose text reaches the view is in this
 *  table (the test reads their sources to hold that), so a new one in a message is caught when it
 *  is written. */
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
 * punctuation spelled in ASCII, so a terminal set up for CJK text draws it as wide as it is
 * measured. Only for messages: a label is shown as it is stored, since a person types it back.
 */
export function plainPunctuation(text: string): string {
  return text.replace(TYPOGRAPHIC, (ch) => PLAIN_PUNCTUATION.get(ch) ?? ch);
}
