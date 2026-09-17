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
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  SessionEvent,
  SessionHandle,
  SessionState,
} from './types.js';
import { summarizeText } from './summarizer.js';
import { classifyFailureText } from './apiFailure.js';

/**
 * Policy for riding out TRANSIENT API failures (5xx/529/dropped connections — see
 * apiFailure.ts for exactly what qualifies) instead of stamping the session `failed`.
 * Presence of this object on {@link ManagedSessionOptions} is what enables the behavior;
 * the daemon simply omits it when the operator turned auto-continue off. Presence also
 * enables the usage-limit STALL — the same survive-API-errors umbrella, different
 * mechanism: a 429/usage-limit death parks the session idle instead of failing it, to be
 * resumed via {@link SessionHandle.resumeFromUsageLimitStall} after an account switch.
 *
 * Retrying happens at the TURN level because that is the only retry primitive the Agent
 * SDK offers: the CLI has already retried the raw request internally (~10x with backoff)
 * before the failure ever reaches this file, so what's left is "start a new turn that
 * picks up where the dead one stopped" — `continue` when the dead turn produced partial
 * output (the CLI's documented recovery), or the turn's own prompt again when it produced
 * nothing (re-asking is exact; `continue` into an unanswered prompt is a guess).
 */
export interface AutoContinuePolicy {
  /** Transient failures tolerated before giving up as `failed`, counted per RETRY LINEAGE:
   *  every retry of the same original turn spends one, and a turn a human (or the post-switch
   *  kick) starts begins a new lineage with a full budget. Partial progress does not refill it
   *  — a flapping API that always dies mid-turn must exhaust the budget rather than retry
   *  forever — and a failure reported by a turn some later turn has already superseded spends
   *  nothing, because it is not a failure of the work the session is doing now. Default 5. */
  maxAttempts?: number;
  /** First retry delay; doubles per consecutive failure. Default 15s. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 4min. */
  maxDelayMs?: number;
  /** Injectable timer seam (returns a cancel function), so tests drive the backoff wait
   *  deterministically. Default: real setTimeout/clearTimeout. */
  schedule?: (fn: () => void, delayMs: number) => () => void;
}

export const DEFAULT_AUTO_CONTINUE_MAX_ATTEMPTS = 5;
export const DEFAULT_AUTO_CONTINUE_BASE_DELAY_MS = 15_000;
export const DEFAULT_AUTO_CONTINUE_MAX_DELAY_MS = 240_000;

/** Real-timer default for {@link AutoContinuePolicy.schedule}. */
function defaultSchedule(fn: () => void, delayMs: number): () => void {
  const timer = setTimeout(fn, delayMs);
  return () => clearTimeout(timer);
}

/** "15s" / "2m" for the auto-continue milestone line — phone-card sized, not precise. */
function humanizeDelay(ms: number): string {
  return ms < 60_000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60_000)}m`;
}

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
  /** An AskUserQuestion is blocked awaiting the human's answers. `requestId` is the SDK's own
   *  control-request id — the anchor the daemon echoes back into `resolveQuestion` to unblock
   *  the tool. `questions` carries the full structured prompts so the phone renders real pickers.
   *  `permissionMode` is the mode the query is running under, when known. */
  | {
      type: 'question_required';
      requestId: string;
      questions: QuestionPrompt[];
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
  /** Model id for this turn. Absent — the case for every human-facing session — leaves the
   *  CLI's own default in place, which is the only honest answer when a person is going to
   *  read the output. Set it only when the turn's CONTENT is irrelevant and its cost is not. */
  model?: string;
  /** Hard ceiling on turns before the query stops. Absent = the SDK's default (unbounded for
   *  our purposes); a caller that wants exactly one exchange must say so. */
  maxTurns?: number;
  /** Tool allowlist. An EMPTY array is meaningful and is preserved: it says "this turn may use
   *  no tools at all", which only makes sense paired with a permission mode that denies rather
   *  than prompts — a prompting mode would park the tool on `canUseTool` forever instead. */
  allowedTools?: string[];
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
  /** Answer a pending AskUserQuestion surfaced via a `question_required` event. OPTIONAL for the
   *  same reason as `resolvePermission`. The answers flow back into the in-flight `canUseTool`,
   *  which composes them into the tool's `updatedInput` and unblocks it. Single-resolve; never
   *  blocks, never times out. */
  resolveQuestion?(requestId: string, answers: QuestionAnswer[]): PermissionResolveOutcome;
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
  /** Ride out transient API failures instead of going `failed` — see {@link AutoContinuePolicy}.
   *  Omitted = today's behavior (any failed turn is terminal). */
  autoContinue?: AutoContinuePolicy;
  /** Called whenever the session PARKS on a usage limit (`true`) or leaves the park because a
   *  turn started (`false`). A registry-facing side channel like {@link onSessionId}, and for
   *  the same reason: the park is the one idle state a session can be in that a restart cannot
   *  infer from the record, because shutdown stamps a parked session terminal exactly like a
   *  finished one — and the operator was told it resumes after a switch. Fires only on a
   *  CHANGE, so a listener can persist it without debouncing. */
  onUsageLimitPark?: (parked: boolean) => void;
}

/**
 * One turn's identity and its private bookkeeping.
 *
 * Turns need identity because a turn's stream can outlive the turn's OUTCOME: the SDK reports
 * a failure and keeps the iterator open, so events (a straggler `turn_result`, a late throw)
 * can arrive after the session has already moved on to a retry, a human's reply, or a
 * post-switch resume. Held in session-level variables — as the failure latch and the output
 * flag once were — those stragglers decide things for a turn that is no longer running: a
 * second failure gets handled, a second retry gets scheduled, and the budget meant to bound
 * the loop is spent on the wrong lineage. Attributing every event to the turn that produced it
 * makes "is this still the session's current work?" a one-line question with one answer.
 */
interface TurnContext {
  /** Monotonic within a session; only the LATEST turn's events are acted on. */
  id: number;
  /** What started this turn — re-asked verbatim if it dies having produced nothing. */
  prompt: string;
  /** How many auto-continue retries have already run for the original turn this one descends
   *  from. 0 for a turn started by the kickoff, a human `send()` or the stall kick. */
  attempt: number;
  /** Whether this turn produced real output, which is what makes `continue` meaningful. */
  producedOutput: boolean;
  /** Exactly one failure decision per turn: an `error`, the failed `turn_result` behind it and
   *  a stream throw after either are all the same death. */
  failureHandled: boolean;
}

/** A retry that has come due: the prompt to run, the budget it spends, and the turn whose
 *  failure it answers (so a retry can tell it has been superseded). */
interface PendingRetry {
  prompt: string;
  attempt: number;
  forTurnId: number;
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
    case 'question_required':
      // The first question is the "what's being asked" preview; the full set rides the
      // structured QuestionRequest channel (with its requestId), never this display line.
      return {
        kind: 'milestone',
        text: `Question: ${event.questions[0]?.question ?? 'AskUserQuestion'}`,
      };
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
 * `send()` refused because a turn is already running.
 *
 * A distinct type, not a message, because the two ways `send()` can refuse call for opposite
 * responses: a terminal session will never accept this text and the sender must be told, while a
 * busy one will accept it a moment from now, so the right answer is to wait rather than to fail.
 * Callers that cannot tell them apart have to either drop text that would have delivered or
 * retry text that never will — and matching on the message string to avoid that is a contract
 * nobody can see.
 */
export class SessionBusyError extends Error {
  readonly sessionId: string;

  constructor(sessionId: string) {
    super(
      `session '${sessionId}' is busy with an in-flight turn - wait for 'waiting_input' or call interrupt() first`,
    );
    this.name = 'SessionBusyError';
    this.sessionId = sessionId;
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
  // The turn the session is currently doing, by id. Everything a turn reports is checked
  // against this: a stream that keeps delivering after its turn was superseded is talking
  // about work the session has already replaced (see TurnContext).
  let latestTurnId = 0;
  let turnSeq = 0;
  // ---- auto-continue (see AutoContinuePolicy) ----
  const autoContinue = opts.autoContinue;
  const acMaxAttempts = autoContinue?.maxAttempts ?? DEFAULT_AUTO_CONTINUE_MAX_ATTEMPTS;
  const acBaseDelayMs = autoContinue?.baseDelayMs ?? DEFAULT_AUTO_CONTINUE_BASE_DELAY_MS;
  const acMaxDelayMs = autoContinue?.maxDelayMs ?? DEFAULT_AUTO_CONTINUE_MAX_DELAY_MS;
  const schedule = autoContinue?.schedule ?? defaultSchedule;
  // Cancels the scheduled retry turn; present only during a backoff wait. Anyone who
  // starts different work (send/interrupt/stop, or a surprise successful turn_result)
  // must cancel it so a stale retry can never fire into their session.
  let cancelRetry: (() => void) | undefined;
  // A retry whose backoff already elapsed but whose failed turn was STILL streaming, so it
  // waits for that turn's teardown instead of running beside it (see startRetry). Cancelled
  // by the same callers that cancel the timer — once due, a retry is no less stale.
  let pendingRetry: PendingRetry | undefined;
  // ---- usage-limit stall (rides the same autoContinue umbrella) ----
  // True while the session is PARKED on a usage-limit death: not failed (a different
  // account fixes it), not retrying on a timer (waiting doesn't help within the window) —
  // idle in `waiting_input` until the daemon's post-switch kick (resumeFromUsageLimitStall)
  // or a human send() starts a turn. `stallRetryPrompt` is what the kick replays, derived
  // by the same rule as auto-continue's retry prompt (see handleTurnFailure).
  let stalledOnUsageLimit = false;
  let stallRetryPrompt = opts.prompt;
  const listeners = new Set<(e: SessionEvent) => void>();
  // Structured permission-request listeners, kept separate from the display `listeners` above
  // because a permission request carries the `requestId` needed to resolve it — see the
  // PermissionRequest doc in types.ts for why this is a second channel, not another
  // SessionEvent kind.
  const permissionListeners = new Set<(req: PermissionRequest) => void>();
  // Structured AskUserQuestion listeners, kept separate from `listeners`/`permissionListeners`
  // for the same reason the permission channel is separate: the request carries the `requestId`
  // needed to resolve it (see the QuestionRequest doc in types.ts).
  const questionListeners = new Set<(req: QuestionRequest) => void>();

  function emit(e: SessionEvent): void {
    for (const cb of listeners) cb(e);
  }

  function emitPermissionRequest(req: PermissionRequest): void {
    for (const cb of permissionListeners) cb(req);
  }

  function emitQuestionRequest(req: QuestionRequest): void {
    for (const cb of questionListeners) cb(req);
  }

  function setState(next: SessionState): void {
    if (state === next) return;
    state = next;
    emit({ kind: 'status', state: next });
  }

  function emitText(text: string): void {
    for (const e of summarizeText(text)) emit(e);
  }

  /** Park or un-park the session on a usage limit, telling the registry when the fact CHANGES.
   *  The park is the only idle state that is a PROMISE ("it resumes after a switch"), and the
   *  record is the only place that promise can survive the process — see
   *  {@link ManagedSessionOptions.onUsageLimitPark}. */
  function setStalled(parked: boolean): void {
    if (stalledOnUsageLimit === parked) return;
    stalledOnUsageLimit = parked;
    opts.onUsageLimitPark?.(parked);
  }

  /** Drop every retry that has not started yet: the pending backoff timer AND a retry already
   *  due but waiting on a still-streaming turn. Both are equally stale once the session starts
   *  different work, so every caller that cancels one must cancel the other. Reports whether
   *  there was anything to cancel, which is how `interrupt()` tells "stop the auto-continue"
   *  apart from "interrupt the turn in flight". */
  function cancelPendingRetry(): boolean {
    const had = cancelRetry !== undefined || pendingRetry !== undefined;
    if (cancelRetry !== undefined) {
      cancelRetry();
      cancelRetry = undefined;
    }
    pendingRetry = undefined;
    return had;
  }

  /**
   * Run a retry that has come due — or decline to, which is the whole point of routing every
   * retry through here.
   *
   * A retry is only ever correct for the session state it was scheduled against. Superseded
   * (some later turn started in the meantime): the failure it answers is not what the session
   * is doing any more, so it is dropped outright. Terminal: there is nothing to continue.
   * BUSY: the failed turn reported its death but its stream is still open, so the client is
   * still driving it — a second `query()` alongside it makes the client drive two turns at
   * once, where in the live adapter the newer one takes over the permission gate and orphans
   * whatever the older had parked. The retry rides that turn's teardown instead (runTurn's
   * `finally`), which is the first moment the session is genuinely idle.
   */
  function startRetry(retry: PendingRetry): void {
    if (retry.forTurnId !== latestTurnId) return;
    if (state === 'done' || state === 'failed') return;
    if (busy) {
      pendingRetry = retry;
      return;
    }
    void runTurn(retry.prompt, retry.attempt);
  }

  /**
   * The one failure decision point for a turn, wherever the death was reported from (a
   * failed `turn_result`, an `error` event, or a thrown stream). Transient + budget left →
   * schedule a continuation turn after a backoff and say so with a milestone INSTEAD of
   * the failure display (the session is not failing — a "Session failed" card followed by
   * more output would read as a contradiction). Anything else → exactly the pre-existing
   * terminal behavior, via the caller-supplied `displayGiveUp`.
   */
  function handleTurnFailure(text: string, turn: TurnContext, displayGiveUp: () => void): void {
    if (turn.failureHandled) return;
    turn.failureHandled = true;

    const classification = autoContinue === undefined ? undefined : classifyFailureText(text);

    // A usage-limit death parks the session instead of failing it: no backoff timer can fix
    // an exhausted window, but an account switch can — so the session settles idle exactly
    // where a clean turn end would have left it, holding the prompt to replay, and the
    // daemon kicks it after a switch to an account with usage left. Deliberately outside
    // the consecutive-failure budget: every kick is operator-triggered (a /switch), and a
    // kick that hits another exhausted account just re-parks here — self-limiting, one
    // request per switch.
    if (classification?.usageLimit === true) {
      // Same rule as the retry prompt below: `continue` only means something when the dead
      // turn advanced a resumable conversation; otherwise re-asking is exact.
      stallRetryPrompt = turn.producedOutput && resumeId !== undefined ? 'continue' : turn.prompt;
      setStalled(true);
      const failureNote = text.length > 160 ? `${text.slice(0, 157)}...` : text;
      emit({
        kind: 'milestone',
        text: `Usage limit reached — session parked; it resumes after a switch to an account with usage left (${failureNote})`,
      });
      setState('waiting_input');
      return;
    }

    const transient = classification?.transient === true;
    // The budget belongs to the lineage, not the session: `turn.attempt` is how many retries
    // of this same original turn already ran, so a chain that keeps dying ends at exactly
    // maxAttempts however many clean turns happened before it started.
    if (!transient || turn.attempt >= acMaxAttempts) {
      displayGiveUp();
      setState('failed');
      return;
    }

    const attempt = turn.attempt + 1;
    const delayMs = Math.min(acBaseDelayMs * 2 ** (attempt - 1), acMaxDelayMs);
    // `continue` is the CLI's documented recovery for a turn that got partway ("the
    // response above may be incomplete"); a turn that produced nothing is re-asked
    // verbatim instead — nothing advanced, so re-asking is exact, while `continue` into
    // an unanswered prompt would make the model guess what to continue. The resumeId
    // guard covers the death-before-session_init corner (live-observed shape): without a
    // resume anchor the retry starts a FRESH conversation, where a bare `continue` has
    // nothing to refer to — re-asking is the only prompt that means anything there.
    const retryPrompt = turn.producedOutput && resumeId !== undefined ? 'continue' : turn.prompt;
    const failureNote = text.length > 160 ? `${text.slice(0, 157)}...` : text;
    emit({
      kind: 'milestone',
      text: `Auto-continue: retrying in ${humanizeDelay(delayMs)} (attempt ${attempt}/${acMaxAttempts}) after: ${failureNote}`,
    });
    cancelRetry = schedule(() => {
      cancelRetry = undefined;
      startRetry({ prompt: retryPrompt, attempt, forTurnId: turn.id });
    }, delayMs);
  }

  function handleEvent(event: AgentSdkEvent, turn: TurnContext): void {
    // A turn's own `client.interrupt()`/close race can deliver a straggler after we've
    // already gone terminal; ignore it rather than resurrect a finished session.
    if (state === 'done' || state === 'failed') return;
    // Likewise for a turn the session has moved past: its stream is still delivering, but
    // whatever it says is about work that has already been retried, answered or resumed. Acting
    // on it re-decides a settled failure and starts turns nobody asked for (see TurnContext).
    if (turn.id !== latestTurnId) return;

    if (event.type === 'session_init') {
      resumeId = event.sessionId;
      // Surface the SDK's session id so a registry can persist it as the resume anchor. Done
      // here (not via a SessionEvent) so it never pollutes the phone-facing output stream.
      opts.onSessionId?.(event.sessionId);
      return;
    }

    // Failure signals divert BEFORE the generic display block: when a retry is about to be
    // scheduled, the failure display must not fire at all (see handleTurnFailure).
    if (event.type === 'turn_result' && !event.ok) {
      handleTurnFailure(event.summary, turn, () => {
        const display = agentEventToDisplay(event);
        if (display !== undefined) emit(display);
      });
      return;
    }
    if (event.type === 'error') {
      handleTurnFailure(event.message, turn, () => {
        const display = agentEventToDisplay(event);
        if (display !== undefined) emit(display);
      });
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
        turn.producedOutput = true;
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
      case 'question_required':
        // Fire the structured request (with its requestId) BEFORE flipping state, so a
        // subscriber reacting to the state change already has the request in hand. Reuses the
        // 'waiting_permission' state deliberately: a question is a blocked-on-human wait just
        // like a permission, and adding a distinct SessionState would have to widen the wire's
        // status enum (which we must not touch) — questions are distinguished purely by which
        // request channel fired, never by a new state value.
        emitQuestionRequest({
          requestId: event.requestId,
          questions: event.questions,
          ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
        });
        setState('waiting_permission');
        break;
      case 'turn_result':
        // Failures diverted above, so this is a CLEAN completion: nothing is left to retry.
        // The cancel is defensive — a success after an `error` event already scheduled a retry
        // would otherwise fire a phantom turn later.
        cancelPendingRetry();
        setState('waiting_input');
        break;
    }
  }

  /** Run one turn to completion. `attempt` carries the retry lineage (see TurnContext): the
   *  kickoff, a human `send()` and the stall kick all start a fresh one at 0, while an
   *  auto-continue retry inherits and extends the chain it belongs to. */
  async function runTurn(prompt: string, attempt = 0): Promise<void> {
    const turn: TurnContext = {
      id: ++turnSeq,
      prompt,
      attempt,
      producedOutput: false,
      failureHandled: false,
    };
    // Claim the session before the first await, so anything still streaming from an older
    // turn is a straggler from this instant on, and a synchronous send()/kick sees `busy`.
    latestTurnId = turn.id;
    busy = true;
    // Any turn starting also ends a usage-limit park — whether it's the kick replaying the
    // stalled prompt or a human send() choosing their own continuation.
    setStalled(false);
    try {
      const queryOpts: AgentSdkQueryOptions = {
        ...(resumeId !== undefined ? { resumeSessionId: resumeId } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
        ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
      };
      for await (const event of opts.client.query(prompt, queryOpts)) {
        handleEvent(event, turn);
      }
    } catch (err) {
      // A rejected iterator (transport failure, SDK crash) is still just "the turn
      // failed" from a caller's point of view — never let it escape as an unhandled
      // rejection out of the fire-and-forget kickoff below. Routed through the same
      // single failure decision as event-reported deaths (auto-continue applies here
      // too: a mid-stream disconnect often surfaces as a throw, not a result message).
      const message = err instanceof Error ? err.message : String(err);
      // Superseded turns are skipped for the same reason their events are (see handleEvent):
      // a dead turn's transport giving up is not a failure of the work running now.
      if (state !== 'done' && state !== 'failed' && turn.id === latestTurnId) {
        handleTurnFailure(message, turn, () => {
          emitText(`Error: ${message}`);
        });
      }
    } finally {
      // Only the turn that still owns the session releases it: a superseded turn's stream
      // closing late must never advertise an idle session while its successor is mid-query.
      if (turn.id === latestTurnId) {
        busy = false;
        // The session is idle for the first time since a due retry was held back — this is
        // the moment it was waiting for (see startRetry).
        const due = pendingRetry;
        if (due !== undefined) {
          pendingRetry = undefined;
          startRetry(due);
        }
      }
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
    onQuestionRequest(cb) {
      questionListeners.add(cb);
      return () => questionListeners.delete(cb);
    },
    resolveQuestion(requestId: string, answers: QuestionAnswer[]): PermissionResolveOutcome {
      // Same pure delegation and same safe-no-op contract as resolvePermission: a client that
      // never surfaces questions yields 'unknown' rather than throwing, so a stale/duplicate
      // phone answer is harmless.
      return opts.client.resolveQuestion?.(requestId, answers) ?? 'unknown';
    },
    // Not `async` deliberately: the busy/terminal guards must reject *synchronously
    // relative to each other* (see the busy-flag note on runTurn) rather than after an
    // implicit microtask hop, so the check-then-kick sequence stays a single atomic tick.
    send(text: string): Promise<void> {
      if (busy) {
        return Promise.reject(new SessionBusyError(opts.id));
      }
      if (state === 'done' || state === 'failed') {
        return Promise.reject(
          new Error(`cannot send to session '${opts.id}' in terminal state '${state}'`),
        );
      }
      // A human reply outranks a scheduled auto-continue: their text IS the continuation, and
      // the turn it starts begins a fresh lineage with a full budget — their intervention is
      // exactly the "someone is handling this" the streak was counting the absence of.
      cancelPendingRetry();
      void runTurn(text);
      return Promise.resolve();
    },
    isParkedOnUsageLimit: () => stalledOnUsageLimit,
    resumeFromUsageLimitStall(): boolean {
      // Only a session actually parked on a usage limit reacts — everything else reports
      // false so the daemon can blind-fire this across the whole registry after a switch.
      // The busy/terminal guards are defensive: a parked session is idle by construction,
      // but a human send() racing the kick must win (runTurn already cleared the flag).
      if (!stalledOnUsageLimit || busy || state === 'done' || state === 'failed') return false;
      emit({ kind: 'milestone', text: 'Account switched — resuming from usage-limit stall' });
      void runTurn(stallRetryPrompt);
      return true;
    },
    async interrupt(): Promise<void> {
      const hadRetry = cancelPendingRetry();
      // During a backoff wait there is no in-flight turn — the interrupt's meaning is
      // "stop the pending auto-continue". The session settles idle awaiting input, the
      // same place a clean turn end would have left it. A retry held back by a turn that is
      // STILL streaming is the other case: that turn is real in-flight work, so cancelling
      // the retry is not enough and the client interrupt below still applies.
      if (hadRetry && !busy) {
        setState('waiting_input');
        return;
      }
      await opts.client.interrupt();
    },
    async stop(): Promise<void> {
      // A pending retry must die with the session — a timer firing after teardown would
      // start a turn on a client that has already been end()ed.
      cancelPendingRetry();
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
