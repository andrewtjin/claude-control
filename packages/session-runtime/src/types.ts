// Domain types shared by every session backend (managed + observed) and by the registry
// that tracks them. Deliberately independent of `@claude-control/shared-protocol` — this
// package knows nothing about Discord, envelopes, or the wire format; the daemon is the
// only place that translates a `SessionEvent`/`SessionRecord` into a protocol frame.

/**
 * Lifecycle of one session. Both backends share the enum even though not every state is
 * reachable from every backend:
 *  - `starting` -> `running` -> ... -> `done` | `failed` is common to both.
 *  - `waiting_input` is managed-only: the Agent SDK query for the current turn has
 *    finished and the session is idle until `send()` starts the next turn. An observed
 *    terminal has no reliable structured signal for "idle between turns", so it never
 *    reports this state.
 *  - `waiting_permission` is managed-only for the same reason (it comes from a structured
 *    SDK signal, not text heuristics).
 *  - `orphaned` is registry-only: `sessionManager.recover()` stamps it onto a persisted
 *    record whose owning process is gone (e.g. after a daemon crash) — no live
 *    `SessionHandle` ever reports it directly.
 */
export type SessionState =
  'starting' | 'running' | 'waiting_input' | 'waiting_permission' | 'done' | 'failed' | 'orphaned';

/** Which backend is driving the session. */
export type SessionKind = 'managed' | 'observed';

/** The persisted, non-live view of a session — what survives a daemon restart. */
export interface SessionRecord {
  id: string;
  kind: SessionKind;
  state: SessionState;
  /** Account the session is running under, when known. */
  accountId?: string;
  /** Underlying Agent SDK session id to resume from (managed sessions only). */
  resumeId?: string;
  cwd?: string;
  startedAtMs: number;
  /** Last summary line surfaced by the session, if any — cheap "what's it doing" preview. */
  summary?: string;
}

/**
 * A single unit of output a session backend hands to its subscribers. The five kinds map
 * directly onto what a phone UI needs to render: `output` is raw pass-through text,
 * `milestone` is a heuristically-detected notable step (tool call, file write), `status`
 * mirrors a `SessionState` transition, `error` flags a detected failure line, and
 * `summary` flags a detected completion/wrap-up line. See summarizer.ts for how
 * `output`/`milestone`/`error`/`summary` get classified from raw text.
 */
export type SessionEvent =
  | { kind: 'output'; text: string }
  | { kind: 'milestone'; text: string }
  | { kind: 'status'; state: SessionState }
  | { kind: 'error'; text: string }
  | { kind: 'summary'; text: string };

/**
 * The one interface both backends implement. Callers (sessionManager, the daemon) never
 * need to know whether they are holding a managed or an observed session — that's the
 * whole point of the abstraction.
 */
export interface SessionHandle {
  readonly id: string;
  getState(): SessionState;
  /** Subscribe to events. Returns an unsubscribe function. Subscribe synchronously right
   *  after obtaining the handle — the first turn/data starts on its own microtask, but
   *  nothing guarantees a subscriber added after that point sees earlier events. */
  onEvent(cb: (e: SessionEvent) => void): () => void;
  /** Feed more input into a running session (a phone-typed reply). Rejects if the
   *  session cannot currently accept input (mid-turn, or already terminal). */
  send(text: string): Promise<void>;
  /** Best-effort cancellation of whatever the session is doing right now. Does not by
   *  itself end the session — it is the async equivalent of pressing Ctrl+C. */
  interrupt(): Promise<void>;
  /** Tear the session down. Idempotent. */
  stop(): Promise<void>;
}
