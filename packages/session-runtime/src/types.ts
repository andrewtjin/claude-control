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

/**
 * A decision on a pending permission request, in THIS package's own vocabulary. The
 * WET-gated Agent SDK adapter maps it onto the SDK's `PermissionResult`; keeping our own
 * type means callers (daemon, tests) never depend on the SDK's shape. `deny` is the
 * fail-closed default the runtime falls back to when a session ends with a request still
 * outstanding — a permission is never auto-allowed on our side (see the M4 non-negotiable:
 * no timeout-based auto-allow/deny).
 */
export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  /** Reason surfaced to the model on a deny — the SDK requires a message for a deny result;
   *  ignored for an allow. */
  message?: string;
  /** Optional replacement tool input for an allow (maps to the SDK's `updatedInput`), e.g. a
   *  narrowed shell command the operator approved instead of the original. */
  updatedInput?: Record<string, unknown>;
}

/**
 * Outcome of resolving a pending permission. Single-resolve is the whole point: only the
 * FIRST decision for a given requestId `resolved`s and is ever applied; a repeat (a
 * double-tapped phone button, a second device) is `already_handled` — an idempotent no-op,
 * never re-applied — and an id we hold no pending request for is `unknown`.
 */
export type PermissionResolveOutcome = 'resolved' | 'already_handled' | 'unknown';

/**
 * A structured permission request surfaced by a managed session. Deliberately separate from
 * the `SessionEvent` stream: a `SessionEvent` is for DISPLAY (the summarized "Permission
 * required: …" milestone line the phone shows), and carries no id, whereas THIS carries the
 * `requestId` the daemon must echo back into `resolvePermission` to actually unblock the
 * tool. Routing the two on the same channel would force the daemon to parse an id back out
 * of display text.
 */
export interface PermissionRequest {
  requestId: string;
  tool: string;
  summary: string;
  /** The session's Claude Code permission mode (e.g. 'default'), when known — the bot shows
   *  approve/deny buttons only for 'default', an informational card otherwise. */
  permissionMode?: string;
}

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
  /**
   * Subscribe to STRUCTURED permission requests (managed sessions only). Optional because an
   * observed terminal has no structured permission seam — its permissions surface through the
   * CLI's own local prompt / hooks, not this handle. Separate from `onEvent` on purpose: the
   * request carries the `requestId` that `resolvePermission` needs, which the display-only
   * `SessionEvent` milestone deliberately does not. Returns an unsubscribe function; subscribe
   * synchronously right after obtaining the handle for the same reason `onEvent` says to.
   */
  onPermissionRequest?(cb: (req: PermissionRequest) => void): () => void;
  /**
   * Record a decision for a pending permission request this session surfaced (managed only).
   * Single-resolve: the first decision wins and is applied; a repeat returns `already_handled`
   * without re-applying; an unknown/expired id returns `unknown`. Optional for the same reason
   * as `onPermissionRequest`. NEVER blocks and NEVER times out — the decision comes from a
   * human via the phone, and an unanswered request simply stays pending until the session ends
   * (at which point it is denied, fail-closed) — it is never auto-allowed.
   */
  resolvePermission?(requestId: string, decision: PermissionDecision): PermissionResolveOutcome;
}
