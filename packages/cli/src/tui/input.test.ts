// Raw-mode bytes to named keys: every spelling the view binds, and the junk it must drop.

import { describe, it, expect } from 'vitest';
import { KeyDecoder, parseKeys } from './input.js';

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

  it('drops an Alt chord (ESC then a printable key) whole: it is not Escape and then a key', () => {
    expect(parseKeys(`${ESC}q`)).toEqual([]);
    expect(parseKeys(`${ESC}jk`)).toEqual([{ name: 'char', char: 'k' }]);
  });

  it('reads ESC ESC as Escape, then whatever the second one starts', () => {
    expect(parseKeys(`${ESC}${ESC}[A`)).toEqual([{ name: 'escape' }, { name: 'up' }]);
  });

  it('drops sequences it does not bind and control bytes nobody types on purpose', () => {
    expect(parseKeys(`${ESC}[2~${ESC}[15~`)).toEqual([]);
    expect(parseKeys(String.fromCharCode(0, 1, 26))).toEqual([]);
  });

  it('drops a sequence cut off at the end of the read', () => {
    expect(parseKeys(`a${ESC}[`)).toEqual([{ name: 'char', char: 'a' }]);
  });
});

describe('KeyDecoder across reads', () => {
  it('holds a lone ESC at the end of a read instead of calling it Escape', () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed(ESC)).toEqual([]);
    expect(decoder.pending).toBe(true);
    expect(decoder.feed('[A')).toEqual([{ name: 'up' }]);
    expect(decoder.pending).toBe(false);
  });

  it('joins a sequence split inside its parameters', () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed(`${ESC}[5`)).toEqual([]);
    expect(decoder.feed('~j')).toEqual([{ name: 'pageup' }, { name: 'char', char: 'j' }]);
  });

  it('reads a held ESC as Escape once nothing followed it', () => {
    const decoder = new KeyDecoder();
    decoder.feed(`j${ESC}`);
    expect(decoder.flush()).toEqual([{ name: 'escape' }]);
    expect(decoder.pending).toBe(false);
  });

  it('drops a held, unfinished sequence on flush', () => {
    const decoder = new KeyDecoder();
    decoder.feed(`${ESC}[1;`);
    expect(decoder.flush()).toEqual([]);
  });
});

describe('bracketed paste', () => {
  it('reads a pasted block as one paste, newlines and all, never as keys', () => {
    expect(parseKeys(`${ESC}[200~rachel\n${ESC}[201~`)).toEqual([
      { name: 'paste', text: 'rachel\n' },
    ]);
  });

  it('joins a paste split over several reads, end marker included', () => {
    const decoder = new KeyDecoder();
    expect(decoder.feed(`${ESC}[200~ab`)).toEqual([]);
    expect(decoder.feed(`c\rd${ESC}[20`)).toEqual([]);
    expect(decoder.feed(`1~q`)).toEqual([
      { name: 'paste', text: 'abc\rd' },
      { name: 'char', char: 'q' },
    ]);
  });
});

describe('cursor position reports', () => {
  it('are handed to the listener, never read as keys, even split across reads', () => {
    const reports: Array<[number, number]> = [];
    const decoder = new KeyDecoder((row, col) => reports.push([row, col]));
    expect(decoder.feed(`j${ESC}[2;3Rk${ESC}[12;`)).toEqual([
      { name: 'char', char: 'j' },
      { name: 'char', char: 'k' },
    ]);
    expect(decoder.feed('40Rq')).toEqual([{ name: 'char', char: 'q' }]);
    expect(reports).toEqual([
      [2, 3],
      [12, 40],
    ]);
  });

  it('are dropped without a listener, as any sequence the view does not bind', () => {
    expect(parseKeys(`${ESC}[2;3Rq`)).toEqual([{ name: 'char', char: 'q' }]);
  });
});
