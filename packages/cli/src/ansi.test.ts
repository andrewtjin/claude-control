import { describe, expect, it } from 'vitest';
import {
  ANSI_PALETTE,
  colorEnabled,
  detectPalette,
  outlookStyle,
  PLAIN_PALETTE,
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
