// Decoding raw-mode terminal input into key presses.
//
// In raw mode the terminal hands over bytes, not keys: an arrow is a three-byte escape sequence,
// Enter is a carriage return, Ctrl-C is byte 3 (raw mode turns off the signal it would raise). One
// read can carry several keys (a fast typist, a paste) or only part of one: over SSH or a slow
// pseudo-terminal an arrow can arrive as ESC in one read and `[A` in the next. This module is the
// one place that knows those spellings; the reducer only ever sees named keys.
//
// A pasted block arrives between the bracketed-paste markers the view asks the terminal for, and
// comes out as one `paste` key, so pasted text is never run as key commands.

import type { Key } from './types.js';

const ESC = String.fromCharCode(27);

/** How long a lone ESC waits for the rest of a sequence before it is read as the Escape key. Long
 *  enough for a sequence split by a laggy link, short enough that Escape still feels immediate. */
export const ESCAPE_WAIT_MS = 100;

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
/** The body of a cursor position report (`ESC [ row ; col R`), the terminal's answer to a cursor
 *  position query. A modified F3 key is spelled the same way with row 1. */
const CURSOR_REPORT = /^(\d+);(\d+)R$/;
/** The bracketed-paste markers (the body after `ESC [`). */
const PASTE_START = '200~';
const PASTE_END = `${ESC}[201~`;

/**
 * Decodes raw input into keys across reads. Bytes that may be the start of a longer sequence (a
 * trailing ESC, an unfinished CSI, a paste whose end marker has not come yet) are held for the
 * next read instead of being guessed at; {@link pending} says so, and {@link flush} settles them
 * once the caller has waited long enough for nothing more to come.
 *
 * ESC followed by a printable key is an Alt chord (Meta sends ESC first), which the view does not
 * bind: both bytes are dropped, so Alt+b does not quit the view as a stray Escape would.
 */
export class KeyDecoder {
  private held = '';
  /** Text of a paste whose end marker has not arrived; undefined when not inside a paste. */
  private paste: string | undefined;

  /** `onCursorReport` hears each cursor position report, which is the terminal answering a
   *  query, not a key, and so never comes out as one. */
  constructor(private readonly onCursorReport?: (row: number, col: number) => void) {}

  /** Whether held bytes are waiting on more input (not counting an open paste, which waits for
   *  its end marker however long it takes). */
  get pending(): boolean {
    return this.held !== '' && this.paste === undefined;
  }

  /** Decode one read, returning the keys it completes, in order. */
  feed(chunk: string): Key[] {
    this.held += chunk;
    const keys: Key[] = [];
    let i = 0;
    const text = this.held;
    while (i < text.length) {
      if (this.paste !== undefined) {
        const end = text.indexOf(PASTE_END, i);
        if (end === -1) {
          // Keep any tail that could be the start of the end marker; the rest is pasted text.
          const keep = partialSuffix(text.slice(i), PASTE_END);
          this.paste += text.slice(i, text.length - keep);
          i = text.length - keep;
          break;
        }
        keys.push({ name: 'paste', text: this.paste + text.slice(i, end) });
        this.paste = undefined;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = text[i]!;
      if (ch === ESC) {
        const intro = text[i + 1];
        if (intro === undefined) break; // maybe the start of a sequence: wait for the next read
        if (intro === '[' || intro === 'O') {
          const body = SEQUENCE_BODY.exec(text.slice(i + 2));
          if (!body) break; // an unfinished sequence: wait for the rest
          i += 2 + body[0].length;
          if (intro === '[' && body[0] === PASTE_START) {
            this.paste = '';
            continue;
          }
          const report = intro === '[' ? CURSOR_REPORT.exec(body[0]) : null;
          if (report) {
            this.onCursorReport?.(Number(report[1]), Number(report[2]));
            continue;
          }
          const name = SEQUENCES[body[0]] ?? SEQUENCES[body[0].replace(/^1;\d+/, '')];
          if (name !== undefined) keys.push({ name } as Key);
          continue;
        }
        if (intro === ESC || intro.charCodeAt(0) < 0x20) {
          // ESC ESC, or ESC then a control key: the first is Escape on its own.
          keys.push({ name: 'escape' });
          i += 1;
          continue;
        }
        // An Alt chord: ESC and the key it modified, neither bound.
        i += 1 + String.fromCodePoint(text.codePointAt(i + 1) ?? 0).length;
        continue;
      }
      i += decodePlain(text, i, keys);
    }
    this.held = text.slice(i);
    return keys;
  }

  /** Settle what is held now that nothing more came: a lone ESC is the Escape key, an unfinished
   *  sequence is dropped (nothing a person meant to type). An open paste is left alone. */
  flush(): Key[] {
    if (this.paste !== undefined) return [];
    const held = this.held;
    this.held = '';
    return held === ESC ? [{ name: 'escape' }] : [];
  }
}

/** Decode the plain (non-escape) key at `text[i]` into `keys`; returns how many units it used. */
function decodePlain(text: string, i: number, keys: Key[]): number {
  const ch = text[i]!;
  if (ch === '\r' || ch === '\n') {
    keys.push({ name: 'enter' });
    // A CRLF pair is one Enter.
    return ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
  }
  if (ch === '\t') keys.push({ name: 'tab' });
  else if (ch === '\x7f' || ch === '\b') keys.push({ name: 'backspace' });
  else if (ch === '\x03') keys.push({ name: 'ctrl-c' });
  else {
    const cp = text.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(cp);
    // Printable only: other control bytes (Ctrl-letters, NUL) are not bound to anything.
    if (cp >= 0x20) keys.push({ name: 'char', char });
    return char.length;
  }
  return 1;
}

/** How many trailing characters of `text` are a proper prefix of `marker`. */
function partialSuffix(text: string, marker: string): number {
  for (let n = Math.min(text.length, marker.length - 1); n > 0; n -= 1) {
    if (marker.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/**
 * Decode one self-contained chunk into the keys it holds, in order: a decoder fed the chunk and
 * flushed. Unknown escape sequences and control bytes are dropped, a lone ESC is the Escape key.
 */
export function parseKeys(chunk: string): Key[] {
  const decoder = new KeyDecoder();
  return [...decoder.feed(chunk), ...decoder.flush()];
}
