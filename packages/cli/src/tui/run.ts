// The full-screen view's runtime: the terminal, the clock and the sources, wired to the pure
// reducer and renderer.
//
// It owns everything with a side effect: the alternate screen, the hidden cursor, raw input, the
// refresh timer, and the actions. Its first duty is giving the terminal back exactly as it found
// it, on every way out: q, Ctrl-C, a signal, an action that throws, a closed output, even a crash
// (the process `exit` hook is the last resort). A terminal left in raw mode with no cursor is the
// one failure a person cannot fix by reading an error message.

import type { LogSink } from '@claude-control/shared-protocol';
import { sanitizeTerminalText } from '@claude-control/switch-engine';
import { AccountActionError } from '../accountActions.js';
import type { Palette } from '../ansi.js';
import { SessionClientError } from '../sessionClient.js';
import { parseKeys } from './input.js';
import { renderFrame, settleScroll } from './render.js';
import { stripAnsi } from './text.js';
import {
  accountsOf,
  applyLoadError,
  applySnapshot,
  describeRepoll,
  initialState,
  reduce,
  settleAction,
  withStatus,
} from './state.js';
import type { Effect, TuiSources, TuiState } from './types.js';

const ESC = String.fromCharCode(27);
/** Alternate screen on, cursor hidden, line wrap off (so a full-width last line cannot scroll the
 *  frame), screen cleared. */
export const ENTER_SCREEN = `${ESC}[?1049h${ESC}[?25l${ESC}[?7l${ESC}[2J`;
/** Line wrap back on, cursor shown, back to the main screen and what was on it. */
export const LEAVE_SCREEN = `${ESC}[?7h${ESC}[?25h${ESC}[?1049l`;
const HOME = `${ESC}[H`;
const CLEAR_TO_EOL = `${ESC}[K`;
const CLEAR_BELOW = `${ESC}[J`;

/** How often the view re-reads the vault and the daemon's database. */
export const DEFAULT_REFRESH_MS = 2_000;

/** The exit code a signal asks for (128 + its number), as a shell reports it. */
const SIGNAL_EXIT: Readonly<Record<string, number>> = { SIGHUP: 129, SIGINT: 130, SIGTERM: 143 };

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

/** The terminal size, with a conventional fallback for a stream that does not report one. */
function sizeOf(stdout: TuiOutput): { cols: number; rows: number } {
  return { cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 };
}

/**
 * Run the view until the person quits (or something ends it), then give the terminal back.
 * Resolves with the exit code to report; rejects with a fault an action threw, after the terminal
 * has been restored, so the caller's error line lands on the normal screen.
 */
export function runTui(deps: TuiDeps): Promise<TuiExit> {
  const { stdin, stdout, sources, palette } = deps;
  const now = deps.now ?? Date.now;
  const timers: TuiTimers = deps.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  };
  const proc: TuiProcess = deps.process ?? process;
  const refreshMs = deps.refreshMs ?? DEFAULT_REFRESH_MS;

  return new Promise<TuiExit>((resolve, reject) => {
    let state: TuiState = initialState(now(), deps.platform ?? process.platform);
    let screenUp = false;
    let finished = false;
    let outputBroken = false;
    let loading = false;
    let drawing = false;
    /** Bumped by every action, so a read that started before it is not applied after it. */
    let generation = 0;
    let timer: unknown;
    let savedStderrWrite: TuiStderr['write'] | undefined;

    const write = (text: string): void => {
      if (outputBroken) return;
      try {
        stdout.write(text);
      } catch {
        outputBroken = true;
      }
    };

    // Every redraw funnels through here, from keys, timers, reads and resizes alike, so a fault in
    // drawing ends the view (terminal restored, fault reported) wherever it was triggered from.
    const draw = (): void => {
      if (!screenUp || drawing) return;
      drawing = true;
      try {
        const { cols, rows } = sizeOf(stdout);
        state = settleScroll(state, rows, palette);
        const lines = renderFrame(state, cols, rows, palette);
        write(HOME + lines.join(`${CLEAR_TO_EOL}\r\n`) + CLEAR_TO_EOL + CLEAR_BELOW);
      } catch (err) {
        finish({ error: err });
      } finally {
        drawing = false;
      }
    };

    /** A line someone wrote while the screen is up: shown on the status line, never over it. */
    const divert = (text: string): void => {
      const line = text
        .split('\n')
        .map((l) => sanitizeTerminalText(stripAnsi(l)).trim())
        .filter((l) => l !== '')
        .pop();
      if (line === undefined) return;
      state = withStatus(state, line, 'warn');
      draw();
    };

    const onData = (chunk: string | Buffer): void => {
      try {
        for (const key of parseKeys(String(chunk))) {
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
    const onResize = (): void => draw();
    const onOutputError = (): void => {
      // The terminal is gone (EPIPE and the like): nothing more can be written to it, but raw mode
      // still has to come off the input side.
      outputBroken = true;
      finish({ code: 1 });
    };
    const signalHandlers = Object.entries(SIGNAL_EXIT).map(([signal, code]) => {
      const handler = (): void => {
        // While a login window owns the terminal, Ctrl-C there is meant for that window; the view
        // is not what the person is cancelling.
        if (signal === 'SIGINT' && !screenUp && !finished) return;
        finish({ code });
      };
      return [signal, handler] as const;
    });
    // Last resort for a crash nobody caught: put the terminal back on the way out.
    const onProcessExit = (): void => hideScreen();

    function showScreen(): void {
      if (screenUp || finished) return;
      write(ENTER_SCREEN);
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
        void load();
      }, refreshMs);
      screenUp = true;
      draw();
    }

    function hideScreen(): void {
      if (!screenUp) return;
      screenUp = false;
      timers.clearInterval(timer);
      deps.log?.stop();
      if (deps.stderr !== undefined && savedStderrWrite !== undefined) {
        deps.stderr.write = savedStderrWrite;
        savedStderrWrite = undefined;
      }
      stdout.removeListener('resize', onResize);
      stdin.removeListener('data', onData);
      try {
        stdin.setRawMode(false);
      } catch {
        // An input that is already closed has no mode left to restore.
      }
      stdin.pause();
      write(LEAVE_SCREEN);
    }

    function finish(result: { code: number } | { error: unknown }): void {
      if (finished) return;
      hideScreen();
      finished = true;
      stdout.removeListener('error', onOutputError);
      for (const [signal, handler] of signalHandlers) proc.removeListener(signal, handler);
      proc.removeListener('exit', onProcessExit);
      if ('error' in result) {
        reject(result.error instanceof Error ? result.error : new Error(String(result.error)));
      } else resolve({ code: result.code });
    }

    async function load(): Promise<void> {
      if (loading || finished || state.busy !== undefined) return;
      loading = true;
      const startedAt = generation;
      try {
        const snapshot = await sources.load(now());
        if (!finished && startedAt === generation) state = applySnapshot(state, snapshot);
      } catch (err) {
        if (!finished)
          state = applyLoadError(state, err instanceof Error ? err.message : String(err));
      } finally {
        loading = false;
      }
      draw();
    }

    function handle(effect: Effect): void {
      if (effect.kind === 'quit') {
        finish({ code: 0 });
        return;
      }
      generation += 1;
      void runAction(effect);
    }

    /** Carry out one action, then report how it went and re-read. */
    async function runAction(effect: Exclude<Effect, { kind: 'quit' }>): Promise<void> {
      draw();
      let outcome: { ok: true; message: string } | { ok: false; message: string };
      try {
        outcome = { ok: true, message: await perform(effect) };
      } catch (err) {
        if (finished) return;
        if (err instanceof AccountActionError || err instanceof SessionClientError) {
          outcome = { ok: false, message: err.message };
        } else {
          finish({ error: err });
          return;
        }
      } finally {
        // An add steps the screen aside for its login window; it comes back whatever happened,
        // unless the view is ending anyway.
        if (effect.kind === 'add' && !finished) showScreen();
      }
      if (finished) return;
      state = settleAction(state, outcome);
      if (state.quitWhenIdle) {
        finish({ code: 0 });
        return;
      }
      draw();
      await load();
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
          return (await sources.removeAccount(effect.id)).message;
        case 'add':
          // The login window needs the real terminal: cooked input, the main screen, a cursor.
          hideScreen();
          return (await sources.addAccount(effect.label)).message;
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
    void load();
  });
}
