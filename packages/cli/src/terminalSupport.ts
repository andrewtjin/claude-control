// Whether this terminal can host the full-screen view.
//
// Two things are needed: a person at both ends (keys in, a screen out), and a terminal that
// understands what the view draws with (cursor addressing, the alternate screen). A terminal that
// passes the first and fails the second (an Emacs shell buffer, the legacy Windows console) is
// still a terminal, and gets the plain output a pipe gets rather than a screen of escape codes.

const ESC = String.fromCharCode(27);
/** "Where is the cursor?" (DSR 6), answered with ESC [ row ; col R by any terminal that processes
 *  escape sequences. */
const CURSOR_QUERY = `${ESC}[6n`;
const CURSOR_REPORT = new RegExp(`${ESC}\\[\\d+;\\d+R`);
/** How long to wait for the answer. A console that processes escape sequences answers within a
 *  few milliseconds (measured: 2-11 ms under ConPTY and winpty); this leaves a loaded machine
 *  plenty of room, and is only ever waited out in full on a console that will never answer. */
export const CURSOR_QUERY_TIMEOUT_MS = 1_000;

/** Whether a person is at both ends of this process: input and output are both a terminal. The
 *  full-screen view needs both — keys in, a screen out — and anything less (a pipe, a file, CI)
 *  gets plain output. */
export function isInteractiveTerminal(
  stdin: { isTTY?: boolean | undefined } = process.stdin,
  stdout: { isTTY?: boolean | undefined } = process.stdout,
): boolean {
  return stdin.isTTY === true && stdout.isTTY === true;
}

/** The input side of a terminal, as the cursor query uses it. */
export interface ProbeInput {
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/**
 * Why this terminal cannot draw the full-screen view, or undefined when it can.
 *
 * - `TERM=dumb` is a terminal that says it cannot move the cursor: an Emacs `M-x shell` buffer
 *   runs its shell on a pseudo-terminal with that setting, so both ends are TTYs, yet every frame
 *   would be appended to the buffer as text.
 * - The legacy Windows console has no VT processing; Node emulates a few sequences, but not the
 *   alternate screen, so the view would wipe the visible console and leave its last frame behind
 *   on exit. Nothing outside the console can say which kind this process is attached to: no
 *   environment variable does (Git Bash sets `TERM` inside a plain console window, and
 *   `WT_SESSION` or `TERM_PROGRAM` are inherited by a console window started from Windows
 *   Terminal or VS Code), and the "Use legacy console" setting is only read when a window
 *   starts, so a window opened before it was changed is still the other kind. So the console is
 *   asked directly (`answersCursorQuery`): one that processes escape sequences answers a cursor
 *   position query, and the legacy console, which does not, stays silent.
 *
 * Only Windows is asked: every other terminal that reaches here processes escape sequences.
 */
export async function fullScreenBlocker(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  answersCursorQuery: () => Promise<boolean> = () =>
    consoleAnswersCursorQuery(process.stdin, process.stdout),
): Promise<string | undefined> {
  if (env.TERM === 'dumb') {
    return 'this terminal (TERM=dumb) cannot move the cursor, which the full-screen view needs';
  }
  if (platform !== 'win32') return undefined;
  if (await answersCursorQuery()) return undefined;
  return (
    'this Windows console does not process terminal escape sequences (the legacy console does ' +
    'not), so it has no alternate screen for the full-screen view; if "Use legacy console" is ' +
    "ticked in the window's properties, untick it and open a new console window"
  );
}

/**
 * Ask the console where its cursor is and wait up to `timeoutMs` for the answer. True when it
 * answers. Input is raw only while asking; keys typed meanwhile are dropped with the answer, as
 * they arrived before any screen was there to act on them. The console is left as it was found:
 * cooked, nobody listening, not reading. An input that cannot go raw counts as no answer, since
 * the view cannot run on it either.
 */
export function consoleAnswersCursorQuery(
  stdin: ProbeInput,
  stdout: { write(chunk: string): unknown },
  timeoutMs: number = CURSOR_QUERY_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let heard = '';
    // Only ever called once the timer below exists: data arrives no sooner than the next tick.
    const done = (answered: boolean): void => {
      clearTimeout(timer);
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // An input that is already closed has no mode left to restore.
      }
      stdin.pause();
      resolve(answered);
    };
    const onData = (chunk: string | Buffer): void => {
      heard += String(chunk);
      if (CURSOR_REPORT.test(heard)) done(true);
    };
    try {
      stdin.setRawMode(true);
    } catch {
      resolve(false);
      return;
    }
    const timer = setTimeout(() => done(false), timeoutMs);
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
    stdin.resume();
    stdout.write(CURSOR_QUERY);
  });
}
