// The pure pieces of `cctl export` / `cctl import` that face a person or a disk: the hidden
// passphrase prompt's key handling and the passphrase file's decoding.

import { describe, it, expect } from 'vitest';
import { CliFailure } from './context.js';
import {
  ESCAPE_SEQUENCE_GAP_MS,
  HiddenInput,
  passphraseFromFile,
  passphraseProblem,
} from './accountTransfer.js';

const ESC = String.fromCharCode(27);
const ETX = String.fromCharCode(3);

/** A read of the prompt: its text and how many milliseconds after the read before it arrived. */
type Read = string | { text: string; afterMs: number };

/** Feed `reads` to a fresh prompt and return it. A bare string arrives as a person types, well
 *  after the read before it; `burst(...)` gives reads a terminal sent at once. */
function typed(...reads: Read[]): HiddenInput {
  let now = 1_000;
  const input = new HiddenInput(() => now);
  for (const read of reads) {
    const { text, afterMs } = typeof read === 'string' ? { text: read, afterMs: 200 } : read;
    now += afterMs;
    input.feed(text);
  }
  return input;
}

/** Reads that follow one another at once: one key's sequence, split. */
function burst(...texts: string[]): Read[] {
  return texts.map((text) => ({ text, afterMs: 1 }));
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

  it('follows a key code split across reads that come at once', () => {
    const input = typed('abc', ...burst(ESC, '[', '3', '~'), 'd\n');
    expect(input.value).toBe('abcd');
    expect(input.state).toBe('done');
    expect(typed('ab', ...burst(ESC, '['), ...burst('D'), 'c\r').value).toBe('abc');
    expect(typed('ab', ...burst(ESC, 'O'), ...burst('H'), 'c\r').value).toBe('abc');
  });

  it('removes a character on Backspace and gives up on Ctrl-C', () => {
    expect(typed('abx', String.fromCharCode(127), 'c\r').value).toBe('abc');
    expect(typed('ab', String.fromCharCode(3)).state).toBe('cancelled');
  });

  it('drops a cursor key sent after an ESC of its own: Esc then an arrow, or Alt with one', () => {
    expect(typed('ab', ESC, `${ESC}[D`, 'c\r').value).toBe('abc');
    expect(typed('ab', `${ESC}${ESC}[D`, 'c\r').value).toBe('abc');
    expect(typed('pass', `${ESC}${ESC}[D`, 'word\r').value).toBe('password');
  });

  it('types the key that follows Esc pressed on its own, Enter and Ctrl-C included', () => {
    expect(typed('ab', ESC, 'c\r').value).toBe('abc');
    const enter = typed('ab', ESC, '\r');
    expect(enter.state).toBe('done');
    expect(enter.value).toBe('ab');
    expect(typed('ab', ESC, ETX).state).toBe('cancelled');
    expect(typed('pass', ESC, 'xword\r').value).toBe('passxword');
  });

  // The keys that also start a sequence: after Esc on its own, a person typing `[` or a capital `O`
  // means that character, and the key after it is typed too.
  it('types [ and O when they follow Esc pressed on its own, and the keys after them', () => {
    expect(typed(ESC, 'O', 'r', 'a', 'n', 'g', 'e', '\r').value).toBe('Orange');
    expect(typed(ESC, '[', 'a', 'b', 'c', '\r').value).toBe('[abc');
    expect(typed('p', ESC, 'O', '1', 'x', '\r').value).toBe('pO1x');
    expect(typed('p', ESC, 'O1x\r').value).toBe('pO1x');
    expect(typed('p', ESC, '[[Ax\r').value).toBe('p[[Ax');
    expect(typed('p', ESC, 'E', ESC, 'Oq\r').value).toBe('pEOq');
  });

  it('drops a sequence a pause cut short, and types what comes after it', () => {
    // ESC [ in one read is a terminal's (or Alt+[); a key typed later is not its final byte.
    expect(typed('a', `${ESC}[`, 'b', '\r').value).toBe('ab');
    expect(typed('a', `${ESC}[1;`, '5', 'C', '\r').value).toBe('a5C');
    expect(typed('a', `${ESC}O`, 'b\r').value).toBe('ab');
  });

  it('drops an Alt chord whole (ESC and a key sent together)', () => {
    expect(typed('ab', `${ESC}x`, 'c\r').value).toBe('abc');
    expect(typed('ab', ...burst(ESC, 'x'), 'c\r').value).toBe('abc');
  });

  it('drops the Linux console function keys F1 to F5 whole', () => {
    for (const letter of ['A', 'B', 'C', 'D', 'E']) {
      expect(typed('pass', `${ESC}[[${letter}`, 'word\r').value).toBe('password');
    }
  });

  it('drops the 8-bit CSI and SS3 forms, and other keys with parameters', () => {
    const csi8 = String.fromCharCode(0x9b);
    const ss38 = String.fromCharCode(0x8f);
    expect(typed('a', `${csi8}3~`, `${ss38}P`, `${ESC}[11^`, `${ESC}[Z`, 'b\r').value).toBe('ab');
  });

  it('ends a sequence at any byte that is not a parameter, as rxvt ends its shifted keys', () => {
    // rxvt: Shift+Insert, Shift+Delete, Shift+Home, Shift+End end in `$`; Ctrl+Shift ones in `@`.
    for (const key of ['[2$', '[3$', '[7$', '[8$', '[23$', '[2@', '[7^', '[a', 'Oa', '[2;5~']) {
      expect(typed('pass', `${ESC}${key}`, 'w', 'o', 'r', 'd', '\r').value).toBe('password');
      expect(typed('pass', ...burst(...`${ESC}${key}`), 'word\r').value).toBe('password');
    }
  });

  it('never swallows Enter, Ctrl-C or Backspace inside a broken sequence', () => {
    const enter = typed('ab', ...burst(`${ESC}[1;`, '\r'));
    expect(enter.state).toBe('done');
    expect(enter.value).toBe('ab');
    expect(typed('ab', ...burst(`${ESC}[`, ETX)).state).toBe('cancelled');
    expect(typed('abc', ...burst(`${ESC}O`, String.fromCharCode(127)), '\r').value).toBe('ab');
  });

  it('types pasted text between the bracketed-paste markers', () => {
    expect(typed(`${ESC}[200~`, 'pasted secret', `${ESC}[201~`, '\r').value).toBe('pasted secret');
  });

  it('reads the gap on the clock it is given, by default one that never steps back', () => {
    expect(ESCAPE_SEQUENCE_GAP_MS).toBeLessThan(200);
    const input = new HiddenInput();
    input.feed('ab');
    input.feed(`${ESC}[D`);
    input.feed('c\r');
    expect(input.value).toBe('abc');
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

  it('ends the first line at a bare carriage return too', () => {
    expect(passphraseFromFile(Buffer.from('correct horse\rnext'), 'p.txt')).toBe('correct horse');
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

describe('passphraseProblem', () => {
  const ch = (code: number): string => String.fromCharCode(code);

  it('takes a passphrase a person can type again', () => {
    expect(passphraseProblem('correct horse')).toBeUndefined();
    expect(passphraseProblem(`caf${ch(0xe9)} pass`)).toBeUndefined();
  });

  it('refuses a space at either end (cmd.exe echo writes one before the redirect)', () => {
    expect(passphraseProblem('correct horse ')).toBe('starts or ends with a space');
    expect(passphraseProblem(' correct horse')).toBe('starts or ends with a space');
  });

  it('refuses a stray carriage return, a second byte-order mark and other invisible characters', () => {
    for (const p of [
      `correct horse${ch(13)}`,
      `${ch(0xfeff)}correct horse`,
      `correct${ch(0x200b)}horse`,
      `correct${ch(0x202e)}horse`,
      `correct horse${ch(9)}`,
    ]) {
      expect(passphraseProblem(p)).toContain('control or invisible character');
    }
  });

  it('refuses a lone surrogate, which the key derivation would collapse with others', () => {
    expect(passphraseProblem(`correct horse${ch(0xd800)}`)).toBe('is not valid text');
    expect(passphraseProblem(`correct horse${ch(0xdfff)}`)).toBe('is not valid text');
  });

  it('refuses an empty one', () => {
    expect(passphraseProblem('')).toBe('is empty');
  });
});
