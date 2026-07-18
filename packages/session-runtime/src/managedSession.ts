// A managed session drives the Agent SDK directly: this process owns the query loop, so
// interrupt/send/stop are real method calls rather than terminal keystrokes.
//
// The SDK boundary is the injectable `AgentSdkClient` interface below — a small domain
// type this package owns, deliberately narrower than the real SDK's ~30-variant message
// union (see agentSdkClient.ts, which is the live-boundary adapter that maps one onto the
// other). Tests here use a fake client and never touch a real process.

import type {
  PermissionDecision,
  PermissionRequest,
  PermissionResolveOutcome,
  SessionEvent,
  SessionHandle,
  SessionState,
} from './types.js';
import { summarizeText } from './summarizer.js';

/**
 * The events managedSession's state machine understands. This is our own vocabulary, not
 * the Agent SDK's — `agentSdkClient.ts` is responsible for translating real SDK messages
 * into these before they ever reach this file.
 */
export type AgentSdkEvent =
  | { type: 'session_init'; sessionId: string }
  | { type: 'assistant_text'; text: string }
  | { type: 'tool_use'; name: string; input?: unknown }
  | { type: 'tool_result'; name: string; ok: boolean; text?: string }
  /** A tool is blocked awaiting a permission decision. `requestId` is the SDK's own
   *  control-request id — the anchor the daemon echoes back into `resolvePermission` to
   *  unblock the tool. `permissionMode` is the mode the query is running under, when known. */
  | {
      type: 'permission_required';
      requestId: string;
      tool: string;
      summary: string;
      permissionMode?: string;
    }
  /** One turn finished. `ok` is whether the turn itself succeeded; `false` is terminal
   *  (the session cannot continue), `true` leaves the session idle in `waiting_input`
   *  until `send()` starts another turn or `stop()` ends it. */
  | { type: 'turn_result'; ok: boolean; summary: string }
  | { type: 'error'; message: string };

export interface AgentSdkQueryOptions {
  /** Resume the underlying SDK session captured from a prior turn's `session_init`. */
  resumeSessionId?: string;
  cwd?: string;
  accountId?: string;
  /** Claude Code permission mode to run the query under (e.g. 'default'). Controls whether
   *  the SDK prompts (fires `canUseTool`) at all, and is echoed onto the emitted
   *  `permission_required` events so the bot can render mode-aware cards. */
  permissionMode?: string;
}

/** The seam managedSession depends on instead of the real SDK. */
export interface AgentSdkClient {
  /** Run one turn. The returned iterable completes when the turn is over (normally after
   *  a `turn_result` event) — it does not represent the whole multi-turn session. */
  query(prompt: string, opts: AgentSdkQueryOptions): AsyncIterable<AgentSdkEvent>;
  /** Cancel whatever turn is currently in flight, if any. */
  interrupt(): Promise<void>;
  /** Release any resources held for the session. */
  end(): Promise<void>;
  /** Resolve a pending SDK permission surfaced via a `permission_required` event. OPTIONAL so
   *  minimal fakes and non-permission clients stay valid; the real adapter implements it. The
   *  decision flows back into the in-flight `canUseTool` and unblocks (or denies) the tool.
   *  Single-resolve (see `PermissionResolveOutcome`); never blocks, never times out. */
  resolvePermission?(requestId: string, decision: PermissionDecision): PermissionResolveOutcome;
}

export interface ManagedSessionOptions {
  id: string;
  client: AgentSdkClient;
  prompt: string;
  resumeSessionId?: string;
  cwd?: string;
  accountId?: string;
  /** See AgentSdkQueryOptions.permissionMode — threaded into every turn's query. */
  permissionMode?: string;
  /** Called with the SDK's own session id whenever a turn initializes (from `session_init`).
   *  Lets a registry persist it as the resume anchor so a session can be re-attached after a
   *  crash even if it was never itself started with a resume id. Fired once per turn init;
   *  the value can change across a resume, so the last one wins. */
  onSessionId?: (sdkSessionId: string) => void;
}

/** Map a structured SDK event straight to its display event. The kind is already known here,
 *  so routing through the line classifier would be a lossy detour: it splits on newlines and
 *  re-guesses each line, stranding every line after the first in the transcript (a multi-line
 *  turn summary kept only its "Session complete:" head). Assistant prose is the one genuinely
 *  unstructured event — it stays on the shared classifier (see handleEvent). The fixed
 *  prefixes ("Tool: ", "Session complete: ", …) match what classifyLine recognizes, so
 *  managed sessions and observed-terminal output still speak one vocabulary. */
function agentEventToDisplay(event: AgentSdkEvent): SessionEvent | undefined {
  switch (event.type) {
    case 'session_init':
    case 'assistant_text':
      return undefined; // init is internal bookkeeping; prose goes through the classifier
    case 'tool_use':
      return { kind: 'milestone', text: `Tool: ${event.name}` };
    case 'tool_result':
      return {
        kind: 'milestone',
        text: event.ok
          ? `Tool result: ${event.name} ok`
          : `Tool result: ${event.name} failed${event.text ? `: ${event.text}` : ''}`,
      };
    case 'permission_required':
      return { kind: 'milestone', text: `Permission required: ${event.tool} - ${event.summary}` };
    case 'turn_result':
      return {
        kind: 'summary',
        text: event.ok ? `Session complete: ${event.summary}` : `Session failed: ${event.summary}`,
      };
    case 'error':
      return { kind: 'error', text: `Error: ${event.message}` };
  }
}

/**
 * Start a managed session and immediately kick off its first turn. Callers must subscribe
 * via `onEvent` synchronously (before yielding to the event loop) to be guaranteed not to
 * miss the earliest events — the first turn starts on a microtask, not before this
 * function returns, precisely so a same-tick subscriber never races it.
 */
export function startManagedSession(opts: ManagedSessionOptions): SessionHandle {
  let state: SessionState = 'starting';
  // The Agent SDK session id to resume from. Starts as whatever the caller passed in
  // (continuing a previous session) and gets overwritten by the SDK's own `session_init`
  // once the first turn actually starts one.
  let resumeId: string | undefined = opts.resumeSessionId;
  // True while a turn's async iteration is in flight — the authoritative guard against
  // starting a second overlapping turn. Set synchronously at the top of runTurn (before
  // any await), so a caller who calls send() twice without awaiting between still gets a
  // deterministic accept/reject in call order.
  let busy = false;
  const listeners = new Set<(e: SessionEvent) => void>();
  // Structured permission-request listeners, kept separate from the display `listeners` above
  // because a permission request carries the `requestId` needed to resolve it — see the
  // PermissionRequest doc in types.ts for why this is a second channel, not another
  // SessionEvent kind.
  const permissionListeners = new Set<(req: PermissionRequest) => void>();

  function emit(e: SessionEvent): void {
    for (const cb of listeners) cb(e);
  }

  function emitPermissionRequest(req: PermissionRequest): void {
    for (const cb of permissionListeners) cb(req);
  }

  function setState(next: SessionState): void {
    if (state === next) return;
    state = next;
    emit({ kind: 'status', state: next });
  }

  function emitText(text: string): void {
    for (const e of summarizeText(text)) emit(e);
  }

  function handleEvent(event: AgentSdkEvent): void {
    // A turn's own `client.interrupt()`/close race can deliver a straggler after we've
    // already gone terminal; ignore it rather than resurrect a finished session.
    if (state === 'done' || state === 'failed') return;

    if (event.type === 'session_init') {
      resumeId = event.sessionId;
      // Surface the SDK's session id so a registry can persist it as the resume anchor. Done
      // here (not via a SessionEvent) so it never pollutes the phone-facing output stream.
      opts.onSessionId?.(event.sessionId);
      return;
    }

    if (event.type === 'assistant_text') {
      emitText(event.text);
    } else {
      const display = agentEventToDisplay(event);
      if (display !== undefined) emit(display);
    }

    switch (event.type) {
      case 'assistant_text':
      case 'tool_use':
      case 'tool_result':
        setState('running');
        break;
      case 'permission_required':
        // Fire the structured request (with its requestId) BEFORE flipping state, so a
        // subscriber that reacts to `waiting_permission` already has the request in hand.
        emitPermissionRequest({
          requestId: event.requestId,
          tool: event.tool,
          summary: event.summary,
          ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
        });
        setState('waiting_permission');
        break;
      case 'turn_result':
        setState(event.ok ? 'waiting_input' : 'failed');
        break;
      case 'error':
        setState('failed');
        break;
    }
  }

  async function runTurn(prompt: string): Promise<void> {
    busy = true;
    try {
      const queryOpts: AgentSdkQueryOptions = {
        ...(resumeId !== undefined ? { resumeSessionId: resumeId } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      };
      for await (const event of opts.client.query(prompt, queryOpts)) {
        handleEvent(event);
      }
    } catch (err) {
      // A rejected iterator (transport failure, SDK crash) is still just "the session
      // failed" from a caller's point of view — never let it escape as an unhandled
      // rejection out of the fire-and-forget kickoff below.
      const message = err instanceof Error ? err.message : String(err);
      if (state !== 'done' && state !== 'failed') {
        emitText(`Error: ${message}`);
        setState('failed');
      }
    } finally {
      busy = false;
    }
  }

  // Deferred to a microtask so any caller that subscribes right after this function
  // returns is guaranteed to be registered before the first event fires.
  queueMicrotask(() => {
    void runTurn(opts.prompt);
  });

  return {
    id: opts.id,
    getState: () => state,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    onPermissionRequest(cb) {
      permissionListeners.add(cb);
      return () => permissionListeners.delete(cb);
    },
    resolvePermission(requestId: string, decision: PermissionDecision): PermissionResolveOutcome {
      // Pure delegation to the client, which owns the actual blocking `canUseTool` promise
      // (only the client talks to the SDK). A client that doesn't support permissions (a
      // minimal fake, or a backend that never prompts) yields 'unknown' — never a throw, so a
      // stale/duplicate phone response is a safe no-op, exactly like the hook path's contract.
      return opts.client.resolvePermission?.(requestId, decision) ?? 'unknown';
    },
    // Not `async` deliberately: the busy/terminal guards must reject *synchronously
    // relative to each other* (see the busy-flag note on runTurn) rather than after an
    // implicit microtask hop, so the check-then-kick sequence stays a single atomic tick.
    send(text: string): Promise<void> {
      if (busy) {
        return Promise.reject(
          new Error(
            `session '${opts.id}' is busy with an in-flight turn — wait for 'waiting_input' or call interrupt() first`,
          ),
        );
      }
      if (state === 'done' || state === 'failed') {
        return Promise.reject(
          new Error(`cannot send to session '${opts.id}' in terminal state '${state}'`),
        );
      }
      void runTurn(text);
      return Promise.resolve();
    },
    async interrupt(): Promise<void> {
      await opts.client.interrupt();
    },
    async stop(): Promise<void> {
      // Client teardown is best-effort: end() can reject when the transport is already dead
      // (the SDK subprocess died out from under us), and the session is no less over for it.
      // What MUST happen is the terminal state stamp — without it the registry keeps this
      // record non-terminal and a later daemon run would treat a session the operator
      // explicitly ended as still alive.
      try {
        await opts.client.end();
      } catch {
        // A dead transport cannot be torn down twice; there is nothing left to release.
      }
      if (state !== 'done' && state !== 'failed') {
        setState('done');
      }
    },
  };
}
