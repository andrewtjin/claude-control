// The pure pieces of `cctl export` / `cctl import` that face a person or a disk: the hidden
// passphrase prompt's key handling and the passphrase file's decoding.

import { describe, it, expect } from 'vitest';
import { CliFailure } from './context.js';
import { HiddenInput, passphraseFromFile } from './accountTransfer.js';

const ESC = String.fromCharCode(27);

/** Feed `chunks` to a fresh prompt and return it. */
function typed(...chunks: string[]): HiddenInput {
  const input = new HiddenInput();
  for (const chunk of chunks) input.feed(chunk);
  return input;
}

describe('HiddenInput', () => {
  it('ignores cursor and editing keys rather than typing their codes', () => {
    const input = typed(
      'correct hors',
      `${ESC}[D`,
      'e',
      `${ESC}[3~`,
      `${ESC}OH`,
      `${ESC}[1;5C`,
      ' battery',
      '\r',
    );
    expect(input.state).toBe('done');
    expect(input.value).toBe('correct horse battery');
  });

  it('follows a key code split across two reads', () => {
    const input = typed('abc', ESC, '[', '3', '~', 'd\n');
    expect(input.value).toBe('abcd');
    expect(input.state).toBe('done');
  });

  it('removes a character on Backspace and gives up on Ctrl-C', () => {
    expect(typed('abx', String.fromCharCode(127), 'c\r').value).toBe('abc');
    expect(typed('ab', String.fromCharCode(3)).state).toBe('cancelled');
  });
});

describe('passphraseFromFile', () => {
  it('reads the first line of a UTF-8, BOM-marked or UTF-16 file the same way', () => {
    const pass = 'correct horse';
    for (const bytes of [
      Buffer.from(pass + '\nnext'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(pass + '\r\n')]),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(pass + '\r\n', 'utf16le')]),
    ]) {
      expect(passphraseFromFile(bytes, 'p.txt')).toBe(pass);
    }
  });

  it('refuses bytes that are not plain text', () => {
    expect(() => passphraseFromFile(Buffer.from('correct horse', 'utf16le'), 'p.txt')).toThrow(
      CliFailure,
    );
    expect(() => passphraseFromFile(Buffer.from([0x63, 0xff, 0x64]), 'p.txt')).toThrow(
      'not plain text',
    );
  });
});
