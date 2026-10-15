// Decoding raw-mode terminal input into key presses.
//
// In raw mode the terminal hands over bytes, not keys: an arrow is a three-byte escape sequence,
// Enter is a carriage return, Ctrl-C is byte 3 (raw mode turns off the signal it would raise). One
// read can carry several keys (a fast typist, a paste) or a key's sequence alone. This module is
// the one place that knows those spellings; the reducer only ever sees named keys.

import type { Key } from './types.js';

const ESC = String.fromCharCode(27);

/** The escape sequences the view understands, by what follows `ESC [` or `ESC O`. Both CSI and
 *  SS3 forms are listed: terminals in application-cursor mode send `ESC O A` for up. */
const SEQUENCES: Readonly<Record<string, Key['name']>> = {
  A: 'up',
  B: 'down',
  C: 'right',
  D: 'left',
  H: 'home',
  F: 'end',
  Z: 'backtab',
  '1~': 'home',
  '4~': 'end',
  '7~': 'home',
  '8~': 'end',
  '5~': 'pageup',
  '6~': 'pagedown',
};

/** A CSI/SS3 body: parameter bytes, then one final byte. */
const SEQUENCE_BODY = /^[0-?]*[ -/]*[@-~]/;

/**
 * Decode one chunk of raw input into the keys it holds, in order. Unknown escape sequences and
 * control bytes are dropped. A lone ESC (nothing after it in the chunk) is the Escape key; ESC
 * followed by anything but `[` or `O` is Escape followed by that key, since an Alt chord is not
 * something the view binds.
 */
export function parseKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i]!;
    if (ch === ESC) {
      const intro = chunk[i + 1];
      if (intro === '[' || intro === 'O') {
        const body = SEQUENCE_BODY.exec(chunk.slice(i + 2));
        if (body) {
          const name = SEQUENCES[body[0]] ?? SEQUENCES[body[0].replace(/^1;\d+/, '')];
          if (name !== undefined) keys.push({ name } as Key);
          i += 2 + body[0].length;
          continue;
        }
        // An incomplete sequence at the end of the chunk: nothing a person meant to type.
        i = chunk.length;
        continue;
      }
      keys.push({ name: 'escape' });
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      keys.push({ name: 'enter' });
      // A CRLF pair is one Enter.
      i += ch === '\r' && chunk[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (ch === '\t') keys.push({ name: 'tab' });
    else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
    else if (ch === '\x03') keys.push({ name: 'ctrl-c' });
    else {
      const cp = chunk.codePointAt(i) ?? 0;
      const char = String.fromCodePoint(cp);
      // Printable only: other control bytes (Ctrl-letters, NUL) are not bound to anything.
      if (cp >= 0x20) keys.push({ name: 'char', char });
      i += char.length;
      continue;
    }
    i += 1;
  }
  return keys;
}
