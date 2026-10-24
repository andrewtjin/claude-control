// Whether this terminal can host the full-screen view: a person at both ends, and a terminal that
// understands cursor addressing and the alternate screen.

import { describe, it, expect, vi } from 'vitest';
import {
  consoleAnswersCursorQuery,
  fullScreenBlocker,
  isInteractiveTerminal,
  type ProbeInput,
} from './terminalSupport.js';

const ESC = String.fromCharCode(27);

describe('isInteractiveTerminal', () => {
  it('needs a terminal at both ends', () => {
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: true })).toBe(true);
    expect(isInteractiveTerminal({ isTTY: true }, { isTTY: false })).toBe(false);
    expect(isInteractiveTerminal({}, { isTTY: true })).toBe(false);
  });
});

describe('fullScreenBlocker', () => {
  const answers = () => vi.fn(() => Promise.resolve(true));
  const silent = () => vi.fn(() => Promise.resolve(false));

  it('blocks a dumb terminal (an Emacs shell buffer), which cannot move the cursor', async () => {
    for (const platform of ['linux', 'win32'] as const) {
      const ask = answers();
      expect(await fullScreenBlocker({ TERM: 'dumb' }, platform, ask)).toMatch(/TERM=dumb/);
      expect(ask).not.toHaveBeenCalled();
    }
    expect(await fullScreenBlocker({ TERM: 'xterm-256color' }, 'linux', answers())).toBe(undefined);
  });

  it('blocks a Windows console that does not answer, and says to open a new window', async () => {
    const blocker = await fullScreenBlocker({}, 'win32', silent());
    expect(blocker).toMatch(/legacy console/);
    expect(blocker).toMatch(/open a new console window/);
    expect(await fullScreenBlocker({}, 'win32', answers())).toBeUndefined();
  });

  it('asks the console itself on Windows, whatever the environment or the setting says', async () => {
    // TERM is set by Git Bash, MSYS2 and Cygwin running in a plain console window; WT_SESSION and
    // TERM_PROGRAM are inherited by a console window started from Windows Terminal or VS Code. A
    // window opened before "Use legacy console" was unticked is still legacy. Only the console
    // under this process can say what it is.
    for (const env of [
      { TERM: 'xterm-256color' },
      { TERM: 'cygwin' },
      { WT_SESSION: 'x' },
      { TERM_PROGRAM: 'vscode' },
      {},
    ]) {
      const ask = silent();
      expect(await fullScreenBlocker(env, 'win32', ask), JSON.stringify(env)).toMatch(
        /legacy console/,
      );
      expect(ask).toHaveBeenCalledTimes(1);
    }
  });

  it('never asks off Windows', async () => {
    for (const platform of ['linux', 'darwin'] as const) {
      const ask = silent();
      expect(await fullScreenBlocker({}, platform, ask)).toBeUndefined();
      expect(ask).not.toHaveBeenCalled();
    }
  });
});

/** A console input whose replies the test types, recording what the probe did to it. */
function fakeConsole() {
  let listener: ((chunk: string | Buffer) => void) | undefined;
  const input = {
    raw: false,
    paused: true,
    setRawMode: vi.fn((mode: boolean) => {
      input.raw = mode;
    }),
    setEncoding: vi.fn(),
    on: vi.fn((_event: 'data', l: (chunk: string | Buffer) => void) => {
      listener = l;
    }),
    removeListener: vi.fn(() => {
      listener = undefined;
    }),
    resume: vi.fn(() => {
      input.paused = false;
    }),
    pause: vi.fn(() => {
      input.paused = true;
    }),
  };
  const written: string[] = [];
  const output = { write: vi.fn((s: string) => written.push(s)) };
  const type = (s: string): void => listener?.(s);
  return { input: input satisfies ProbeInput, output, written, type, listening: () => !!listener };
}

describe('consoleAnswersCursorQuery', () => {
  it('asks for the cursor position and takes a reply, even in pieces after typed keys', async () => {
    const c = fakeConsole();
    const asked = consoleAnswersCursorQuery(c.input, c.output, 5_000);
    expect(c.written).toEqual([`${ESC}[6n`]);
    expect(c.input.raw).toBe(true);
    c.type('jk');
    c.type(`${ESC}[12;`);
    c.type('40R');
    expect(await asked).toBe(true);
    // The console is left as found: cooked, nobody listening, not reading.
    expect(c.input.raw).toBe(false);
    expect(c.listening()).toBe(false);
    expect(c.input.paused).toBe(true);
  });

  it('gives up on a console that never answers, leaving it as found', async () => {
    const c = fakeConsole();
    c.type('x');
    expect(await consoleAnswersCursorQuery(c.input, c.output, 20)).toBe(false);
    expect(c.input.raw).toBe(false);
    expect(c.listening()).toBe(false);
    expect(c.input.paused).toBe(true);
  });

  it('counts a console whose input cannot go raw as one that cannot host the view', async () => {
    const c = fakeConsole();
    c.input.setRawMode.mockImplementationOnce(() => {
      throw new Error('EBADF');
    });
    expect(await consoleAnswersCursorQuery(c.input, c.output, 5_000)).toBe(false);
    expect(c.written).toEqual([]);
  });
});
