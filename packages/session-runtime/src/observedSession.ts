// An observed session watches a real terminal (a user's own `claude` CLI process) through
// a ConPTY pseudo-terminal instead of driving the Agent SDK directly. There is no
// structured message stream here — only bytes — so classification leans entirely on the
// shared summarizer's text heuristics, and the only reliable lifecycle signal is the
// process's own exit.
//
// `node-pty` is intentionally not a declared dependency of this package (see package.json
// and CLAUDE.md) — it's a native module the host process may or may not have installed.
// The injectable `PtyFactory` seam below is what makes that optional: tests exercise the
// real logic with a fake, and `createNodePtyFactory()` is the one place that touches the
// optional real thing.

import type { SessionEvent, SessionHandle, SessionState } from './types.js';
import { splitCompleteLines, stripAnsi, collapseRepeats, classifyLine } from './summarizer.js';

// ---------------------------------------------------------------------------
// The seam: our own minimal PTY contract, independent of node-pty's actual API
// ---------------------------------------------------------------------------

export interface PtySpawnOptions {
  cwd?: string;
  cols?: number;
  rows?: number;
}

/** Info reported by a PTY-backed process on exit. */
export interface PtyExitInfo {
  exitCode: number;
  signal?: number;
}

/** One running PTY-backed process, in our own vocabulary (not node-pty's IPty/IDisposable
 *  shapes) — `onData`/`onExit` return plain unsubscribe functions, matching SessionHandle's
 *  own `onEvent` convention instead of introducing a second disposal pattern. */
export interface PtyHandle {
  onData(cb: (chunk: string) => void): () => void;
  onExit(cb: (info: PtyExitInfo) => void): () => void;
  /** Write raw bytes as if typed at the keyboard. Callers decide on line endings — this
   *  lets interrupt() send a bare Ctrl+C without an implied newline. */
  write(data: string): void;
  kill(): void;
}

export interface PtyFactory {
  /** Spawn `command` with `args` under a PTY. May throw only for genuine spawn failures
   *  (bad cwd, missing binary) — "node-pty isn't installed" is a separate, earlier failure
   *  mode signaled by `createNodePtyFactory()`'s result, not by this. */
  spawn(command: string, args: string[], opts: PtySpawnOptions): PtyHandle;
}

// ---------------------------------------------------------------------------
// attachObservedSession
// ---------------------------------------------------------------------------

export interface ObservedSessionOptions {
  id: string;
  ptyFactory: PtyFactory;
  command: string;
  args?: string[];
  cwd?: string;
  accountId?: string;
}

/**
 * Attach to a freshly-spawned PTY process and turn its byte stream into `SessionEvent`s.
 * Unlike managedSession, lifecycle is driven entirely by the process itself: `starting`
 * flips to `running` on first output, and the terminal states come only from the process
 * exiting (exit code 0 -> `done`, anything else -> `failed`) — text heuristics here only
 * ever produce informational milestone/error/summary events, never a state transition, on
 * the principle that guessing "the shell looks idle" from prose is not reliable enough to
 * drive control flow the way a structured SDK signal is.
 */
export function attachObservedSession(opts: ObservedSessionOptions): SessionHandle {
  let state: SessionState = 'starting';
  const listeners = new Set<(e: SessionEvent) => void>();
  // Carries an unterminated line fragment across chunk boundaries — PTY data arrives in
  // arbitrary byte chunks that can split a line (or an ANSI escape) anywhere.
  let buffer = '';

  function emit(e: SessionEvent): void {
    for (const cb of listeners) cb(e);
  }

  function setState(next: SessionState): void {
    if (state === next) return;
    state = next;
    emit({ kind: 'status', state: next });
  }

  const pty = opts.ptyFactory.spawn(
    opts.command,
    opts.args ?? [],
    opts.cwd !== undefined ? { cwd: opts.cwd } : {},
  );

  const unsubscribeData = pty.onData((chunk) => {
    setState('running');
    buffer += chunk;
    const { lines, rest } = splitCompleteLines(buffer);
    buffer = rest;
    // Strip ANSI before dedup: two visually-identical progress redraws can carry
    // different cursor-movement codes, and only look like duplicates once those are gone.
    const clean = collapseRepeats(lines.map((l) => stripAnsi(l)));
    for (const line of clean) {
      const event = classifyLine(line);
      if (event) emit(event);
    }
  });

  const unsubscribeExit = pty.onExit(({ exitCode }) => {
    setState(exitCode === 0 ? 'done' : 'failed');
    emit({
      kind: 'summary',
      text: `Process exited with code ${exitCode}`,
    });
  });

  function teardown(): void {
    unsubscribeData();
    unsubscribeExit();
  }

  return {
    id: opts.id,
    getState: () => state,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    // None of these three need `async`: every effect (pty.write/kill, state transition) is
    // synchronous, and keeping them plain functions returning Promise.resolve()/reject()
    // avoids an unnecessary microtask hop while still satisfying the SessionHandle contract.
    send(text: string): Promise<void> {
      if (state === 'done' || state === 'failed') {
        return Promise.reject(
          new Error(`cannot send to session '${opts.id}' in terminal state '${state}'`),
        );
      }
      pty.write(text);
      return Promise.resolve();
    },
    interrupt(): Promise<void> {
      // A PTY has no separate cancel API — Ctrl+C (ETX, 0x03) is the mechanism, exactly
      // as if a human at the keyboard pressed it.
      pty.write('\x03');
      return Promise.resolve();
    },
    stop(): Promise<void> {
      pty.kill();
      teardown();
      if (state !== 'done' && state !== 'failed') {
        setState('done');
      }
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Real node-pty adapter — WET-GATED
// ---------------------------------------------------------------------------
//
// node-pty is a native module and is deliberately not installed for this package (see the
// task brief). It's loaded via a dynamic import behind a runtime try/catch so that a host
// without it can still use managed sessions — only observed-session support degrades, and
// it degrades to a clear error result rather than a crash at module load time.
//
// The import specifier is read from a variable rather than a string literal so tsc does
// not attempt to resolve `node-pty`'s type declarations at compile time (there are none
// available in this workspace); the loaded module is narrowed to `NodePtyModule` by an
// explicit cast immediately after, so nothing downstream of loadNodePtyModule() touches
// `any`. This whole section is unverified against the real native binding — it has been
// checked for type-shape plausibility against node-pty's published API, not exercised.

interface NodePtyDisposable {
  dispose(): void;
}
interface NodePtyProcess {
  onData(cb: (data: string) => void): NodePtyDisposable;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): NodePtyDisposable;
  write(data: string): void;
  kill(signal?: string): void;
}
interface NodePtyModule {
  spawn(file: string, args: string[], opts: Record<string, unknown>): NodePtyProcess;
}

async function loadNodePtyModule(): Promise<NodePtyModule | undefined> {
  try {
    const specifier = 'node-pty';
    const mod = (await import(specifier)) as NodePtyModule;
    return mod;
  } catch {
    return undefined;
  }
}

function adaptNodePtyProcess(proc: NodePtyProcess): PtyHandle {
  return {
    onData(cb) {
      const sub = proc.onData(cb);
      return () => sub.dispose();
    },
    onExit(cb) {
      const sub = proc.onExit((e) =>
        cb({ exitCode: e.exitCode, ...(e.signal !== undefined ? { signal: e.signal } : {}) }),
      );
      return () => sub.dispose();
    },
    write(data) {
      proc.write(data);
    },
    kill() {
      proc.kill();
    },
  };
}

export type PtyFactoryResult = { ok: true; factory: PtyFactory } | { ok: false; error: string };

/** Build a real, node-pty-backed `PtyFactory`. Never throws: an absent/failed native
 *  module surfaces as `{ ok: false, error }` so callers (sessionManager) can report
 *  "observed sessions unavailable: node-pty not installed" instead of crashing. */
export async function createNodePtyFactory(): Promise<PtyFactoryResult> {
  const mod = await loadNodePtyModule();
  if (!mod) {
    return { ok: false, error: 'observed sessions unavailable: node-pty not installed' };
  }
  const factory: PtyFactory = {
    spawn(command, args, opts) {
      const proc = mod.spawn(command, args, {
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.cols !== undefined ? { cols: opts.cols } : {}),
        ...(opts.rows !== undefined ? { rows: opts.rows } : {}),
      });
      return adaptNodePtyProcess(proc);
    },
  };
  return { ok: true, factory };
}
