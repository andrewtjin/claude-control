// Column widths, and the ASCII spelling of cctl's own messages that keeps their width the same on
// every terminal.

import { afterEach, describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { EAST_ASIAN_AMBIGUOUS } from './eastAsianAmbiguous.js';
import {
  ambiguousWidth,
  charWidth,
  displayWidth,
  plainPunctuation,
  setAmbiguousWidth,
} from './textWidth.js';

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
/** The packages whose text can reach the full-screen view: its own, and every package whose
 *  refusals, errors, warnings and reasons it shows. The phone bot and the session channel write
 *  only to Discord and to Claude Code, never to the view. */
const VIEW_SOURCES = [
  'cli',
  'switch-engine',
  'daemon',
  'usage-advisor',
  'session-runtime',
  'shared-protocol',
];

/** Every non-test source file under `dir`. Test fixtures are data, not messages. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'testing' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') ? [path] : [];
  });
}

/** Each non-ASCII character in a string or template literal of `file`, with where it is.
 *  Comments are not shown to anyone, and a regular expression only matches text. */
function literalCharacters(file: string): Array<{ char: string; at: string }> {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: Array<{ char: string; at: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      for (const char of node.text) {
        // A character that takes no column (a joiner, a presentation selector) has no width to
        // disagree on.
        const code = char.codePointAt(0) ?? 0;
        if (code > 0x7e && charWidth(code) > 0) {
          found.push({ char, at: `${relative(PACKAGES_DIR, file)}:${line}` });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('plainPunctuation', () => {
  it('spells typographic punctuation in ASCII, measured as it is drawn everywhere', () => {
    const said = plainPunctuation(
      'work is at 96% weekly — home resets sooner – “next”… a · b ' + '• c → d ‘e’',
    );
    expect(said).toBe(
      'work is at 96% weekly - home resets sooner - "next"... a - b - c -> d \'e\'',
    );
    expect(displayWidth(said)).toBe(said.length);
  });

  it('leaves everything else as it is: letters, CJK, emoji', () => {
    for (const text of ['plain', 'café', '日本語', '\u{1F680}ops', '']) {
      expect(plainPunctuation(text)).toBe(text);
    }
  });

  it('covers every non-ASCII character in the messages of the packages the view shows', () => {
    // A message written with a character this table does not spell would reach the screen as a
    // glyph a terminal set up for CJK text draws one column wider than it was measured.
    const found = VIEW_SOURCES.flatMap((pkg) =>
      sourceFiles(join(PACKAGES_DIR, pkg, 'src')).flatMap(literalCharacters),
    );
    // The messages do use such characters (an em dash in a refusal), so the scan is seeing them.
    expect(found.some(({ char }) => char === '—')).toBe(true);
    const unspelled = found.filter(({ char }) => plainPunctuation(char) === char);
    expect(
      unspelled.map(
        ({ char, at }) => `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase()} at ${at}`,
      ),
    ).toEqual([]);
  });
});

describe('ambiguous-width characters', () => {
  afterEach(() => setAmbiguousWidth(1));

  // Punctuation cctl writes, letters a label can hold, and symbols a foreign error carries.
  const AMBIGUOUS = ['…', '·', '—', '–', '→', '×', '§', '±', '°', '※', 'Ω', 'α', 'Я', 'é', '①'];

  it('count one column until the terminal says otherwise', () => {
    expect(ambiguousWidth()).toBe(1);
    for (const ch of AMBIGUOUS) expect(charWidth(ch.codePointAt(0)!), ch).toBe(1);
    expect(displayWidth('Fix auth — refresh flow…')).toBe(24);
  });

  it('count two columns on a terminal that draws them two wide, in every kind of text', () => {
    setAmbiguousWidth(2);
    for (const ch of AMBIGUOUS) expect(charWidth(ch.codePointAt(0)!), ch).toBe(2);
    // A session label a model wrote, an account label, a folder, a foreign error.
    expect(displayWidth('Fix auth — refresh flow…')).toBe(26);
    expect(displayWidth('Ωmega·α')).toBe(10);
    expect(displayWidth('C:/proj—client')).toBe(15);
    expect(displayWidth('HTTP 429 × 3 retries')).toBe(21);
    expect(displayWidth('§ ± ° ※')).toBe(11);
    // A letter with a combining accent takes its base letter's width; only é itself is ambiguous.
    expect(displayWidth('cafe\u0301')).toBe(4);
    expect(displayWidth('café')).toBe(5);
  });

  it('leave every other width as it was: ASCII, wide CJK, emoji, marks', () => {
    setAmbiguousWidth(2);
    expect(displayWidth('plain ascii')).toBe(11);
    expect(displayWidth('日本語')).toBe(6);
    expect(displayWidth('\u{1F680}')).toBe(2);
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0xfe0f)).toBe(0);
    // Characters outside the table that are neither wide nor zero-width.
    expect(displayWidth('çñ')).toBe(2);
  });

  it('keep an emoji forced to text presentation at the ambiguous width when it is one', () => {
    // U+2194 (left right arrow) is ambiguous; U+FE0E asks for its narrow text glyph.
    expect(displayWidth('\u2194\uFE0E')).toBe(1);
    setAmbiguousWidth(2);
    expect(displayWidth('\u2194\uFE0E')).toBe(2);
  });

  it('are listed as sorted, non-overlapping ranges, so the search finds each one', () => {
    let previous = -1;
    for (const [from, to] of EAST_ASIAN_AMBIGUOUS) {
      expect(from).toBeGreaterThan(previous);
      expect(to).toBeGreaterThanOrEqual(from);
      previous = to;
    }
    setAmbiguousWidth(2);
    for (const [from, to] of EAST_ASIAN_AMBIGUOUS) {
      for (const cp of [from, to]) expect(charWidth(cp), cp.toString(16)).toBe(2);
    }
  });
});
