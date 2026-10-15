// Raw-mode bytes to named keys: every spelling the view binds, and the junk it must drop.

import { describe, it, expect } from 'vitest';
import { parseKeys } from './input.js';

const ESC = String.fromCharCode(27);

describe('parseKeys', () => {
  it.each([
    [`${ESC}[A`, 'up'],
    [`${ESC}[B`, 'down'],
    [`${ESC}[C`, 'right'],
    [`${ESC}[D`, 'left'],
    [`${ESC}OA`, 'up'],
    [`${ESC}OB`, 'down'],
    [`${ESC}[1;5A`, 'up'],
    [`${ESC}[H`, 'home'],
    [`${ESC}[F`, 'end'],
    [`${ESC}[1~`, 'home'],
    [`${ESC}[4~`, 'end'],
    [`${ESC}[5~`, 'pageup'],
    [`${ESC}[6~`, 'pagedown'],
    [`${ESC}[Z`, 'backtab'],
    ['\r', 'enter'],
    ['\n', 'enter'],
    ['\r\n', 'enter'],
    ['\t', 'tab'],
    [String.fromCharCode(127), 'backspace'],
    ['\b', 'backspace'],
    [String.fromCharCode(3), 'ctrl-c'],
    [ESC, 'escape'],
  ])('reads %j as %s', (chunk, name) => {
    expect(parseKeys(chunk)).toEqual([{ name }]);
  });

  it('reads printable characters one key each, wide ones included', () => {
    expect(parseKeys('q?é漢')).toEqual([
      { name: 'char', char: 'q' },
      { name: 'char', char: '?' },
      { name: 'char', char: 'é' },
      { name: 'char', char: '漢' },
    ]);
  });

  it('keeps a character outside the basic plane whole', () => {
    expect(parseKeys('😀')).toEqual([{ name: 'char', char: '😀' }]);
  });

  it('splits one read holding several keys, in order', () => {
    expect(parseKeys(`jj${ESC}[A\rq`)).toEqual([
      { name: 'char', char: 'j' },
      { name: 'char', char: 'j' },
      { name: 'up' },
      { name: 'enter' },
      { name: 'char', char: 'q' },
    ]);
  });

  it('reads ESC followed by a plain key as Escape, then that key', () => {
    expect(parseKeys(`${ESC}q`)).toEqual([{ name: 'escape' }, { name: 'char', char: 'q' }]);
  });

  it('drops sequences it does not bind and control bytes nobody types on purpose', () => {
    expect(parseKeys(`${ESC}[2~${ESC}[15~`)).toEqual([]);
    expect(parseKeys(String.fromCharCode(0, 1, 26))).toEqual([]);
  });

  it('drops a sequence cut off at the end of the read', () => {
    expect(parseKeys(`a${ESC}[`)).toEqual([{ name: 'char', char: 'a' }]);
  });
});
