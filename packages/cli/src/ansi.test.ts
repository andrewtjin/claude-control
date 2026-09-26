import { describe, expect, it } from 'vitest';
import {
  ANSI_PALETTE,
  colorEnabled,
  detectPalette,
  outlookStyle,
  pacingStyle,
  PLAIN_PALETTE,
  sanitizeForTerminal,
  severityPaint,
  type Palette,
} from './ansi.js';

const ESC = '\u001b';

describe('colorEnabled', () => {
  it('is on only for a TTY with NO_COLOR unset', () => {
    expect(colorEnabled({ isTTY: true }, {})).toBe(true);
    expect(colorEnabled({ isTTY: false }, {})).toBe(false);
    expect(colorEnabled({}, {})).toBe(false); // piped: isTTY undefined
  });

  it('honors the NO_COLOR convention (any non-empty value disables)', () => {
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '1' })).toBe(false);
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: 'anything' })).toBe(false);
    // The convention treats an empty string as unset.
    expect(colorEnabled({ isTTY: true }, { NO_COLOR: '' })).toBe(true);
  });
});

describe('detectPalette', () => {
  it('yields ANSI on a TTY and the identity palette otherwise', () => {
    expect(detectPalette({ isTTY: true }, {})).toBe(ANSI_PALETTE);
    expect(detectPalette({ isTTY: false }, {})).toBe(PLAIN_PALETTE);
    expect(detectPalette({ isTTY: true }, { NO_COLOR: '1' })).toBe(PLAIN_PALETTE);
  });
});

describe('ANSI_PALETTE', () => {
  it('wraps text in SGR codes and always resets', () => {
    expect(ANSI_PALETTE.red('x')).toBe(`${ESC}[31mx${ESC}[0m`);
    expect(ANSI_PALETTE.bold('x')).toBe(`${ESC}[1mx${ESC}[0m`);
    expect(ANSI_PALETTE.orange('x')).toBe(`${ESC}[38;5;208mx${ESC}[0m`);
  });

  it('PLAIN_PALETTE is the identity on every paint', () => {
    for (const key of Object.keys(PLAIN_PALETTE) as (keyof Palette)[]) {
      expect(PLAIN_PALETTE[key]('same')).toBe('same');
    }
  });
});

describe('sanitizeForTerminal', () => {
  it('strips an ANSI/OSC escape injected into a label (the ESC that leads a CSI/OSC sequence)', () => {
    // A label an attacker set to recolor the terminal and hide the rest of the line.
    const evil = `${ESC}[31mroot${ESC}[0m${ESC}]0;pwned\u0007`;
    const clean = sanitizeForTerminal(evil);
    expect(clean).toBe('[31mroot[0m]0;pwned');
    expect(clean).not.toContain(ESC);
    expect(clean).not.toContain('\u0007'); // BEL, a C0 control
  });

  it('strips C0, C1, and DEL control characters', () => {
    expect(sanitizeForTerminal('a\u0000b\u0008c\u007fd\u009fe')).toBe('abcde');
    // A newline/carriage-return injected to forge extra output lines is C0 and goes too.
    expect(sanitizeForTerminal('one\r\ntwo')).toBe('onetwo');
  });

  it('strips the Unicode bidi/format controls that reorder a folder path', () => {
    // RLO makes a terminal render the tail reversed — what the eye reads is not the real path.
    const spoofed = `C:\\repos\\${'\u202e'}gpj.evil\u202c`;
    const clean = sanitizeForTerminal(spoofed);
    expect(clean).toBe('C:\\repos\\gpj.evil');
    for (const cc of ['\u200e', '\u200f', '\u202a', '\u202b', '\u202c', '\u202d', '\u202e']) {
      expect(clean).not.toContain(cc);
    }
  });

  it('strips isolates (U+2066–2069) and the BOM (U+FEFF)', () => {
    expect(sanitizeForTerminal('\u2066a\u2067b\u2068c\u2069d\ufeff')).toBe('abcd');
  });

  it('leaves ordinary labels and Windows drive paths untouched, and is idempotent', () => {
    const label = 'work (main)';
    const folder = 'C:\\Users\\me\\repos\\research';
    expect(sanitizeForTerminal(label)).toBe(label);
    expect(sanitizeForTerminal(folder)).toBe(folder);
    // Non-ASCII printable text (accents, CJK) is not a control and must survive.
    const unicode = 'café — 研究';
    expect(sanitizeForTerminal(unicode)).toBe(unicode);
    expect(sanitizeForTerminal(sanitizeForTerminal(unicode))).toBe(unicode);
  });
});

describe('severityPaint', () => {
  it('maps the shared severity bands to green/yellow/orange/red', () => {
    expect(severityPaint(ANSI_PALETTE, 10)('x')).toBe(ANSI_PALETTE.green('x'));
    expect(severityPaint(ANSI_PALETTE, 70)('x')).toBe(ANSI_PALETTE.yellow('x'));
    expect(severityPaint(ANSI_PALETTE, 90)('x')).toBe(ANSI_PALETTE.orange('x'));
    expect(severityPaint(ANSI_PALETTE, 97)('x')).toBe(ANSI_PALETTE.red('x'));
  });
});

describe('outlookStyle', () => {
  it('adapts a palette to the renderOutlook hooks without changing visible text', () => {
    const style = outlookStyle(ANSI_PALETTE);
    // Strip codes → the original text, every hook (the width-preservation contract).
    // eslint-disable-next-line no-control-regex -- matching ESC codes is the whole point
    const strip = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');
    expect(strip(style.heading('h'))).toBe('h');
    expect(strip(style.session('s'))).toBe('s');
    expect(strip(style.percent('42% used', 42))).toBe('42% used');
    // Percent severity flows through: 97% paints red.
    expect(style.percent('97%', 97)).toBe(ANSI_PALETTE.red('97%'));
  });

  it('is the identity end-to-end over the plain palette', () => {
    const style = outlookStyle(PLAIN_PALETTE);
    expect(style.heading('h')).toBe('h');
    expect(style.alert('a')).toBe('a');
    expect(style.percent('42%', 42)).toBe('42%');
  });
});

describe('pacingStyle', () => {
  it('colors the verdict marker by what it says: green sustainable, red runs-dry, dim unknown', () => {
    const style = pacingStyle(ANSI_PALETTE);
    expect(style.marker('[ok]', 'sustainable')).toBe(ANSI_PALETTE.green('[ok]'));
    expect(style.marker('[!!]', 'runs-dry')).toBe(ANSI_PALETTE.red('[!!]'));
    expect(style.marker('[--]', 'unknown')).toBe(ANSI_PALETTE.dim('[--]'));
  });

  it('grades headroom by severity and marks waste yellow, never changing the visible text', () => {
    const style = pacingStyle(ANSI_PALETTE);
    // eslint-disable-next-line no-control-regex -- matching ESC codes is the whole point
    const strip = (s: string) => s.replace(/\[[0-9;]*m/g, '');
    expect(strip(style.percent('50%', 50))).toBe('50%');
    expect(style.percent('critical', 97)).toBe(ANSI_PALETTE.red('critical'));
    expect(style.waste('waste 1u: a in 5d')).toBe(ANSI_PALETTE.yellow('waste 1u: a in 5d'));
  });

  it('separates `warn` from `dim`: a mark with a command to run is never quiet', () => {
    const style = pacingStyle(ANSI_PALETTE);
    expect(style.warn('[--]')).toBe(ANSI_PALETTE.yellow('[--]'));
    expect(style.warn('[--]')).not.toBe(style.dim('[--]'));
  });

  it('is the identity end-to-end over the plain palette', () => {
    const style = pacingStyle(PLAIN_PALETTE);
    expect(style.marker('[ok]', 'sustainable')).toBe('[ok]');
    expect(style.percent('50%', 50)).toBe('50%');
    expect(style.waste('w')).toBe('w');
    expect(style.warn('w')).toBe('w');
    expect(style.dim('d')).toBe('d');
  });
});
