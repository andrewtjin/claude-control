// The full-screen view's runtime: the terminal, the clock and the sources, wired to the pure
// reducer and renderer.
//
// It owns everything with a side effect: the alternate screen, the hidden cursor, raw input, the
// refresh timer, and the actions. Its first duty is giving the terminal back exactly as it found
// it, on every way out: q, Ctrl-C, a signal, an action that throws, a closed output, even a crash
// (the process `exit` hook is the last resort). A terminal left in raw mode with no cursor is the
// one failure a person cannot fix by reading an error message.
//
// Its second is never acting on a key the person did not mean for the view: keys typed while a
// login window had the terminal, a paste, an escape sequence split across reads, keys pressed
// while the terminal is too small to show what they would act on.

import type { LogSink } from '@claude-control/shared-protocol';
import { CadenceError, sanitizeTerminalText } from '@claude-control/switch-engine';
import { AccountActionError } from '../accountActions.js';
import type { Palette } from '../ansi.js';
import { shellQuote } from '../folderRender.js';
import { SessionClientError } from '../sessionClient.js';
import { ESCAPE_WAIT_MS, KeyDecoder } from './input.js';
import { isFrameTooSmall, renderFrame, settleScroll } from './render.js';
import { ambiguousWidth, setAmbiguousWidth, stripAnsi, visibleWidth } from './text.js';
import {
  accountsOf,
  applyLoadError,
  applySnapshot,
  describeRepoll,
  initialState,
  reduce,
  settleAction,
  withNotes,
  withStatus,
} from './state.js';
import type { Effect, Key, TuiSources, TuiState } from './types.js';

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
/** Alternate screen on, cursor hidden, line wrap off (so a full-width last line cannot scroll the
 *  frame), screen cleared, and pastes marked (so pasted text is never run as key commands). */
export const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[2J${ESC}[?2004h`;
/** Paste marking off, line wrap back on, cursor shown, back to the main screen and what was on
 *  it. */
export const LEAVE_SCREEN = `${ESC}[?2004l${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
const HOME = `${ESC}[H`;
/** The row the ambiguous-width probe is drawn on. Not the first: a modified F3 key arrives as a
 *  cursor report from row 1, and must not be taken for the answer. */
const PROBE_ROW = 2;
/**
 * How wide this terminal draws an ambiguous-width character, asked the only way that works for
 * every terminal: draw one (an ellipsis) at the start of a row, then ask where the cursor is. The
 * answer's column is one past the glyph. The frame drawn right after paints over it.
 */
export const AMBIGUOUS_WIDTH_PROBE = `${ESC}[${PROBE_ROW};1H\u2026${ESC}[6n`;
const CLEAR_TO_EOL = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[J`;

/** How often the view re-reads the vault and the daemon's database. */
export const DEFAULT_REFRESH_MS = 2_000;

/** How long input is discarded once the screen comes back from a login window: long enough for
 *  what the terminal queued meanwhile to be delivered, short enough not to eat a deliberate key. */
const DRAIN_MS = 150;

/** The exit code a signal asks for (128 + its number), as a shell reports it. */
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };
/** Ctrl+Break on Windows: delivered as a signal even in raw mode, and fatal unless handled. */
const WINDOWS_SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGBREAK: 149 };

/** The input side of a terminal: what `process.stdin` offers that the view uses. */
export interface TuiInput {
  isTTY?: boolean | undefined;
  setRawMode(mode: boolean): unknown;
  setEncoding(encoding: BufferEncoding): unknown;
  on(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  removeListener(event: 'data', listener: (chunk: string | Buffer) => void): unknown;
  resume(): unknown;
  pause(): unknown;
}

/** The output side of a terminal: what `process.stdout` offers that the view uses. */
export interface TuiOutput {
  isTTY?: boolean | undefined;
  columns?: number | undefined;
  rows?: number | undefined;
  write(chunk: string): unknown;
  on(event: 'resize' | 'error', listener: (err?: unknown) => void): unknown;
  removeListener(event: 'resize' | 'error', listener: (err?: unknown) => void): unknown;
}

/** Where signals and the process `exit` event come from (the real `process` by default). */
export interface TuiProcess {
  on(event: string, listener: () => void): unknown;
  removeListener(event: string, listener: () => void): unknown;
}

/** Timers, injectable so a test can tick the refresh by hand. */
export interface TuiTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** A stream whose direct writes are diverted to the status line while the screen is drawn. */
export interface TuiStderr {
  write: (...args: never[]) => boolean;
}

/**
 * A log sink for an engine that runs under the view: while the view is listening each line goes
 * to the status line, and otherwise (before the screen is up, or while it is stepped aside for a
 * login window) to `fallback`, as a one-shot command's would. It reports itself as a terminal so
 * the logger writes human lines rather than JSON.
 */
export class StatusLog implements LogSink {
  readonly isTTY = true;
  private listener: ((line: string) => void) | undefined;

  constructor(private readonly fallback: { write(chunk: string): unknown }) {}

  write(chunk: string): boolean {
    if (this.listener === undefined) {
      this.fallback.write(chunk);
      return true;
    }
    for (const line of chunk.split('\n')) {
      if (line.trim() !== '') this.listener(line);
    }
    return true;
  }

  /** Send lines to `listener` until {@link stop}. */
  listen(listener: (line: string) => void): void {
    this.listener = listener;
  }

  stop(): void {
    this.listener = undefined;
  }
}

/** What {@link runTui} needs. */
export interface TuiDeps {
  stdin: TuiInput;
  stdout: TuiOutput;
  sources: TuiSources;
  palette: Palette;
  platform?: NodeJS.Platform;
  now?: () => number;
  refreshMs?: number;
  timers?: TuiTimers;
  process?: TuiProcess;
  /** The engine's log sink, listened to while the screen is up. */
  log?: StatusLog;
  /** Diverted to the status line while the screen is up (process.stderr in production): anything
   *  that writes there directly would otherwise land on top of the frame. */
  stderr?: TuiStderr;
}

/** How the view ended. */
export interface TuiExit {
  code: number;
}

/** The terminal size, with a conventional fallback for a stream that does not report one. A
 *  terminal whose size was never set reports 0x0, which is no more a size than none is. */
function sizeOf(stdout: TuiOutput): { cols: number; rows: number } {
  const positive = (n: number | undefined, fallback: number): number =>
    n !== undefined && n > 0 ? n : fallback;
  return { cols: positive(stdout.columns, 80), rows: positive(stdout.rows, 24) };
}

/**
 * The bytes that draw `lines` over the previous frame: each line from the top, erased to its end
 * only when it stops short of the edge. A line that fills the width leaves the cursor on the last
 * column (line wrap is off), and erasing from there would wipe its last character.
 */
export function paintFrame(lines: readonly string[], cols: number): string {
  const full = (line: string): boolean => visibleWidth(line) >= cols;
  const body = lines.map((line) => (full(line) ? line : line + CLEAR_TO_EOL)).join('\r\n');
  const last = lines[lines.length - 1];
  return HOME + body + (last !== undefined && full(last) ? '' : CLEAR_BELOW);
}

/** The label an action names, for words about it. */
function effectLabel(effect: Exclude<Effect, { kind: 'quit' }>): string | undefined {
  switch (effect.kind) {
    case 'rename':
      return effect.from;
    case 'refresh':
      return undefined;
    default:
      return effect.label;
  }
}

/** The keys the view still acts on while the terminal is too small to show it: only the ways
 *  out, since anything else would act on a selection and say how it went where nobody can see. */
function quitsTheView(key: Key): boolean {
  return (
    key.name === 'ctrl-c' || key.name === 'escape' || (key.name === 'char' && key.char === 'q')
  );
}

type Outcome = { ok: true; message: string } | { ok: false; message: string };

/**
 * Run the view until the person quits (or something ends it), then give the terminal back.
 * Resolves with the exit code to report; rejects with a fault an action threw, after the terminal
 * has been restored, so the caller's error line lands on the normal screen.
 *
 * Quitting while an action runs never cuts it off: the screen is given back at once, the process
 * stays until the action has finished (a switch stopped part way would leave its recovery to the
 * next command), and how it ended is printed on the normal screen, with a refusal making the exit
 * code non-zero.
 */
export function runTui(deps: TuiDeps): Promise<TuiExit> {
  const { stdin, stdout, sources, palette } = deps;
  const now = deps.now ?? Date.now;
  const timers: TuiTimers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  };
  const proc: TuiProcess = deps.process ?? process;
  const platform = deps.platform ?? process.platform;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;

  return new Promise<TuiExit>((resolve, reject) => {
    let state: TuiState = initialState(now(), platform);
    /** The alternate screen is up and input is raw. */
    let screenUp = false;
    /** The view has ended: the screen is given back for good. */
    let finished = false;
    /** The promise is settled (after `finished`, once no action is left running). */
    let settled = false;
    let outputBroken = false;
    let loading = false;
    /** An action asked for a re-read while one was already running: read again after it. */
    let reloadWanted = false;
    let drawing = false;
    /** Bumped by every action, so a read that started before it is not applied after it. */
    let generation = 0;
    let timer: unknown;
    let escapeTimer: unknown;
    let savedStderrWrite: TuiStderr['write'] | undefined;
    /** Whether the ambiguous-width probe has been sent and its answer is awaited. A terminal
     *  that never answers leaves it waiting, and the width at one column. */
    let widthProbe: 'unsent' | 'waiting' | 'answered' = 'unsent';
    /** The width counted before the view measured its terminal, put back when it ends. */
    const ambiguousBefore = ambiguousWidth();
    /** The probe's answer: from then on, every cell is measured as this terminal draws it. Each
     *  read is followed by a redraw, which picks the new width up. */
    const onCursorReport = (row: number, col: number): void => {
      if (widthProbe !== 'waiting' || row !== PROBE_ROW) return;
      const columns = col - 1;
      if (columns !== 1 && columns !== 2) return;
      widthProbe = 'answered';
      setAmbiguousWidth(columns);
    };
    let decoder = new KeyDecoder(onCursorReport);
    /** An action is running (its promise has not settled). */
    let actionRunning = false;
    /** Warnings logged while the current action ran, said with its outcome. */
    let actionNotes: string[] = [];
    /** Input is being discarded: the screen just came back from a login window. */
    let draining = false;
    let drained: Promise<void> | undefined;
    let endDrain: (() => void) | undefined;
    let drainTimer: unknown;
    /** How the view will exit once the running action finishes, when it ended during one. */
    let pendingExit: { code: number } | undefined;
    let toldWaiting = false;

    const write = (text: string): void => {
      if (outputBroken) return;
      try {
        stdout.write(text);
      } catch {
        outputBroken = true;
      }
    };

    /** A line on the normal screen, once the view has given it back. */
    const say = (text: string): void => {
      if (screenUp) return;
      write(`${sanitizeTerminalText(text)}\n`);
    };

    // Every redraw funnels through here, from keys, timers, reads and resizes alike, so a fault in
    // drawing ends the view (terminal restored, fault reported) wherever it was triggered from.
    const draw = (): void => {
      if (!screenUp || drawing) return;
      drawing = true;
      try {
        const { cols, rows } = sizeOf(stdout);
        state = settleScroll(state, rows, palette, cols);
        write(paintFrame(renderFrame(state, cols, rows, palette), cols));
      } catch (err) {
        finish({ error: err });
      } finally {
        drawing = false;
      }
    };

    /** What someone wrote while the screen is up: shown on the status line, never over it, and
     *  each of its lines kept with the outcome of an action it was written during. */
    const divert = (text: string): void => {
      const lines = text
        .split('\n')
        .map((l) => sanitizeTerminalText(stripAnsi(l)).trim())
        .filter((l) => l !== '');
      if (lines.length === 0) return;
      if (actionRunning) actionNotes.push(...lines);
      state = withStatus(state, lines.join(' '), 'warn');
      draw();
    };

    const handleKeys = (keys: Key[]): void => {
      try {
        for (const key of keys) {
          if (!screenUp) return;
          const { cols, rows } = sizeOf(stdout);
          if (isFrameTooSmall(cols, rows) && !quitsTheView(key)) continue;
          const transition = reduce(state, key);
          state = transition.state;
          if (transition.effect !== undefined) handle(transition.effect);
          if (finished) return;
        }
        draw();
      } catch (err) {
        finish({ error: err });
      }
    };

    const onData = (chunk: string | Buffer): void => {
      if (draining) {
        // Input is still arriving (a key held down repeats): the drain lasts until it stops. A
        // Ctrl-C byte can only have been typed since the screen came back (the login window had
        // cooked input, where Ctrl-C is a signal, not a byte), so it is the person's and is kept.
        armDrainEnd();
        if (String(chunk).includes(CTRL_C)) handleKeys([{ name: 'ctrl-c' }]);
        return;
      }
      if (escapeTimer !== undefined) {
        timers.clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      handleKeys(decoder.feed(String(chunk)));
      // A lone ESC (or the start of a sequence) waits briefly for the rest, then is a key.
      if (!finished && decoder.pending) {
        escapeTimer = timers.setTimeout(() => {
          escapeTimer = undefined;
          handleKeys(decoder.flush());
        }, ESCAPE_WAIT_MS);
      }
    };
    const onResize = (): void => draw();
    // Never removed: a restore write that fails after the view ended (EIO on a terminal that hung
    // up) still reports here, and an 'error' with no listener would crash the process.
    const onOutputError = (): void => {
      // The terminal is gone (EPIPE and the like): nothing more can be written to it, but raw mode
      // still has to come off the input side.
      outputBroken = true;
      finish({ code: 1 });
    };
    const signalCodes = {
      ...SIGNAL_EXIT,
      ...(platform === 'win32' ? WINDOWS_SIGNAL_EXIT : {}),
    };
    const signalHandlers = Object.entries(signalCodes).map(([signal, code]) => {
      const handler = (): void => {
        // While a login window owns the terminal, Ctrl-C (or Ctrl+Break) there is meant for that
        // window; the view is not what the person is cancelling.
        if ((signal === 'SIGINT' || signal === 'SIGBREAK') && !screenUp && !finished) return;
        if (finished) {
          // The view is gone and an action it started is finishing: the signal changes the exit
          // code, not the action, which is not cut off part way.
          pendingExit = { code };
          if (!toldWaiting) {
            toldWaiting = true;
            say('Still finishing the running action; cctl exits as soon as it is done.');
          }
          return;
        }
        finish({ code });
      };
      return [signal, handler] as const;
    });
    // Last resort for a crash nobody caught: put the terminal back on the way out.
    const onProcessExit = (): void => hideScreen();

    function showScreen(): void {
      if (screenUp || finished) return;
      write(ENTER_SCREEN);
      // From here on the way out restores the screen just entered, whatever below fails.
      screenUp = true;
      if (widthProbe === 'unsent') {
        write(AMBIGUOUS_WIDTH_PROBE);
        widthProbe = 'waiting';
      }
      decoder = new KeyDecoder(onCursorReport);
      stdin.setRawMode(true);
      stdin.setEncoding('utf8');
      stdin.on('data', onData);
      stdin.resume();
      stdout.on('resize', onResize);
      if (deps.stderr !== undefined) {
        savedStderrWrite = deps.stderr.write;
        // Accepts write's whole signature (chunk, encoding, callback) and calls the callback, so a
        // writer awaiting it is not left hanging.
        deps.stderr.write = (chunk: unknown, ...rest: unknown[]) => {
          divert(String(chunk));
          const done = rest.find((r) => typeof r === 'function');
          done?.();
          return true;
        };
      }
      deps.log?.listen(divert);
      timer = timers.setInterval(() => {
        state = { ...state, nowMs: now() };
        void load('tick');
      }, refreshMs);
      draw();
    }

    function hideScreen(): void {
      if (!screenUp) return;
      screenUp = false;
      timers.clearInterval(timer);
      timer = undefined;
      if (escapeTimer !== undefined) {
        timers.clearTimeout(escapeTimer);
        escapeTimer = undefined;
      }
      deps.log?.stop();
      if (deps.stderr !== undefined && savedStderrWrite !== undefined) {
        deps.stderr.write = savedStderrWrite;
        savedStderrWrite = undefined;
      }
      stdout.removeListener('resize', onResize);
      stdin.removeListener('data', onData);
      // The screen goes back first, while input is still raw. Turning raw mode off first and only
      // then leaving the alternate screen broke the console on Windows (conhost and ConPTY): the
      // next write failed with EPIPE and a login window started after it could not initialize.
      write(LEAVE_SCREEN);
      try {
        stdin.setRawMode(false);
      } catch {
        // An input that is already closed has no mode left to restore.
      }
      stdin.pause();
    }

    /** End the view: give the screen back, then resolve, or (while an action is still running)
     *  wait for it to finish first. */
    function finish(result: { code: number } | { error: unknown }): void {
      if (finished) return;
      hideScreen();
      finished = true;
      if (actionRunning && !('error' in result)) {
        pendingExit = result;
        say(
          `${state.busy ?? 'An action is running.'} cctl exits once it has finished, since ` +
            'stopping it part way could leave it half done.',
        );
        return;
      }
      settle(result);
    }

    function settle(result: { code: number } | { error: unknown }): void {
      if (settled) return;
      settled = true;
      setAmbiguousWidth(ambiguousBefore);
      for (const [signal, handler] of signalHandlers) proc.removeListener(signal, handler);
      proc.removeListener('exit', onProcessExit);
      if ('error' in result) {
        reject(result.error instanceof Error ? result.error : new Error(String(result.error)));
      } else resolve({ code: result.code });
    }

    /**
     * Read everything again. A timed read (`tick`) is skipped while another read or an action is
     * running; an action's own re-read is never skipped: asked for while a timed read is still
     * running (whose picture predates the action, and is dropped), it runs once that one is done.
     */
    async function load(reason: 'tick' | 'action'): Promise<void> {
      if (finished) return;
      if (loading || state.busy !== undefined) {
        if (reason === 'action') reloadWanted = true;
        return;
      }
      loading = true;
      reloadWanted = false;
      const startedAt = generation;
      try {
        const snapshot = await sources.load(now());
        if (!finished) {
          if (startedAt === generation) state = applySnapshot(state, snapshot);
          else reloadWanted = true;
        }
      } catch (err) {
        if (!finished)
          state = applyLoadError(state, err instanceof Error ? err.message : String(err));
      } finally {
        loading = false;
      }
      draw();
      if (reloadWanted && !finished && state.busy === undefined) void load('action');
    }

    function handle(effect: Effect): void {
      if (effect.kind === 'quit') {
        finish({ code: 0 });
        return;
      }
      generation += 1;
      actionRunning = true;
      actionNotes = [];
      runAction(effect).catch((err: unknown) => {
        // A fault outside the action itself (bringing the screen back after a login window).
        actionRunning = false;
        hideScreen();
        for (const note of actionNotes) say(`Warning: ${note}`);
        actionNotes = [];
        if (finished) settle({ error: err });
        else finish({ error: err });
      });
    }

    /**
     * Bring the screen back after a login window, and discard the input the terminal queued while
     * the window had it: an Enter pressed at what looked like a hung screen is still waiting in
     * the terminal and would arrive as soon as the view reads again, after it is idle, and switch
     * the live login. The discarding lasts until no input has arrived for {@link DRAIN_MS}.
     */
    function comeBack(): void {
      if (screenUp || finished) return;
      showScreen();
      draining = true;
      drained = new Promise<void>((resolve) => {
        endDrain = resolve;
      });
      armDrainEnd();
    }

    /**
     * (Re)start the wait that ends the drain. When it runs out the drain does not end there and
     * then: it ends in the loop turn's check phase, after that turn has read whatever input was
     * already waiting. Ending it from the timer itself would let a stall longer than the wait (a
     * descheduled process, a long collection) pass the queued keys to a view that is idle again:
     * after a stall the timers run before the input is read.
     */
    function armDrainEnd(): void {
      if (drainTimer !== undefined) timers.clearTimeout(drainTimer);
      drainTimer = timers.setTimeout(() => {
        drainTimer = undefined;
        setImmediate(() => {
          // Input read in this turn started the wait again.
          if (drainTimer !== undefined || !draining) return;
          draining = false;
          endDrain?.();
          endDrain = undefined;
        });
      }, DRAIN_MS);
    }

    /** Carry out one action, then report how it went and re-read. */
    async function runAction(effect: Exclude<Effect, { kind: 'quit' }>): Promise<void> {
      draw();
      let outcome: Outcome | undefined;
      let fault: { error: unknown } | undefined;
      try {
        outcome = { ok: true, message: await perform(effect) };
      } catch (err) {
        const refusal = refusalText(err, effect);
        if (refusal === undefined) fault = { error: err };
        else outcome = { ok: false, message: refusal };
      }
      if (effect.kind === 'add' && fault === undefined) {
        // The login window is done: the view comes back whatever the add said.
        comeBack();
        if (drained !== undefined) await drained;
      }
      actionRunning = false;
      const notes = actionNotes;
      actionNotes = [];
      if (fault !== undefined) {
        // The fault ends the view, and the warnings logged on the way to it (a login not saved,
        // a file left behind) matter most here: said on the normal screen, before the fault is.
        hideScreen();
        for (const note of notes) say(`Warning: ${note}`);
        if (finished) settle(fault);
        else finish(fault);
        return;
      }
      const result = outcome!;
      if (finished) {
        // The view ended while this ran (a second Ctrl-C, a signal): say how it went on the
        // normal screen, and let a refusal make the exit code say so too.
        say(withNotes(result.message, notes));
        const exit = pendingExit ?? { code: 0 };
        settle(!result.ok && exit.code === 0 ? { code: 1 } : exit);
        return;
      }
      state = settleAction(state, result, notes);
      if (state.quitWhenIdle) {
        finish({ code: result.ok ? 0 : 1 });
        say(withNotes(result.message, notes));
        return;
      }
      draw();
      await load('action');
    }

    /** A refusal as the view words it, or undefined for a fault. Account actions are sent by id,
     *  so a refusal that would quote the id (an account removed elsewhere) names it by its label
     *  instead, and the cadence guard's remedy is a command, since the view has no force key. */
    function refusalText(
      err: unknown,
      effect: Exclude<Effect, { kind: 'quit' }>,
    ): string | undefined {
      if (err instanceof SessionClientError) return err.message;
      if (!(err instanceof AccountActionError)) return undefined;
      const label = effectLabel(effect);
      if (label === undefined) return err.message;
      if (err.code === 'not_found' || err.code === 'unknown_account') {
        return `${label} is no longer stored; nothing was changed.`;
      }
      if (err.code === 'cadence' && err.cause instanceof CadenceError) {
        return (
          `${err.cause.message}. To switch now anyway, quit and run: ` +
          `cctl switch ${shellQuote(label, platform)} --force`
        );
      }
      return err.message;
    }

    async function perform(effect: Exclude<Effect, { kind: 'quit' }>): Promise<string> {
      switch (effect.kind) {
        case 'switch':
          return (await sources.switchAccount(effect.id)).message;
        case 'exclude':
          return (await sources.setExcluded(effect.id, effect.excluded)).message;
        case 'rename':
          return (await sources.renameAccount(effect.id, effect.to)).message;
        case 'remove':
          return (await sources.removeAccount(effect.id, effect.label)).message;
        case 'add': {
          // The login window needs the real terminal: cooked input, the main screen, a cursor.
          drained = undefined;
          hideScreen();
          const result = await sources.addAccount(effect.label, (message) => {
            // Stored: the rest is cleanup (deleting the throwaway dir, which can take seconds on
            // Windows), which the person should not watch a blank terminal through.
            comeBack();
            if (finished) return;
            state = { ...state, busy: `${message} Cleaning up after the login window...` };
            draw();
          });
          return result.message;
        }
        case 'refresh': {
          const result = await sources.repoll();
          const labels = new Map(accountsOf(state).map((a) => [a.id, a.label] as const));
          return describeRepoll(result, (id) => labels.get(id) ?? id, now());
        }
      }
    }

    stdout.on('error', onOutputError);
    for (const [signal, handler] of signalHandlers) proc.on(signal, handler);
    proc.on('exit', onProcessExit);
    try {
      showScreen();
    } catch (err) {
      finish({ error: err });
      return;
    }
    void load('action');
  });
}
