// One composable "the phone asked to stop this session" operation, built from the pieces
// SessionHandle already exposes (interrupt + stop) so there is a single, tested entry point
// the daemon calls instead of re-implementing the escalation ladder inline.
//
// The ladder: try a graceful `interrupt()` of whatever turn is in flight, give it a grace
// window to wind down on its own, and only then force `stop()`. The result reports which
// rung it ended on so the daemon can tell the phone (and the logs) whether the work stopped
// cleanly or had to be killed.
//
// Works for any SessionHandle (managed or observed), so it lives as a free function rather
// than a method — no interface bloat, no per-backend duplication.

import type { SessionHandle, SessionState } from './types.js';

/** Which rung the escalation ended on. */
export type StopRung =
  /** The session was already done/failed/orphaned — nothing to stop. */
  | 'already_terminal'
  /** The in-flight work wound down within the grace window (or there was none), so no forced
   *  kill was needed; the session was then torn down cleanly. */
  | 'interrupted'
  /** The grace window elapsed with work still in flight; `stop()` forced it down. */
  | 'hard_stopped';

export interface StopEscalationResult {
  rung: StopRung;
  /** The session's state after the escalation (terminal unless a backend refuses to stop). */
  state: SessionState;
}

export interface EscalateStopOptions {
  /** How long to let an interrupted turn wind down before forcing a hard stop. */
  graceMs?: number;
  /** Injectable delay primitive — tests pass a controllable one so the grace window is
   *  deterministic without real timers. Injecting the WAIT (not just a `() => number` clock)
   *  is the honest primitive here: the operation genuinely has to pause, not merely read the
   *  time. Defaults to a real `setTimeout`-backed sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_GRACE_MS = 5_000;

/** States from which no further turn is running: safe to consider the interrupt "settled". */
const SETTLED_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'waiting_input',
  'done',
  'failed',
  'orphaned',
]);

/** States that mean the session is already over — nothing to interrupt or stop. */
const TERMINAL_STATES: ReadonlySet<SessionState> = new Set<SessionState>([
  'done',
  'failed',
  'orphaned',
]);

/**
 * Wait until the handle leaves its busy (`starting`/`running`) states, or the grace window
 * elapses — whichever comes first. Reactive (subscribes to status events) rather than
 * polling, with an immediate re-check to close the gap between the guard and the
 * subscription. Resolves `true` if it settled, `false` if the grace window won the race.
 */
function waitUntilSettled(
  handle: SessionHandle,
  graceMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  if (SETTLED_STATES.has(handle.getState())) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let done = false;
    let unsubscribe: () => void = () => undefined;
    const finish = (settled: boolean): void => {
      if (done) return;
      done = true;
      unsubscribe();
      resolve(settled);
    };
    unsubscribe = handle.onEvent((e) => {
      if (e.kind === 'status' && SETTLED_STATES.has(e.state)) finish(true);
    });
    // It may have settled between the guard above and this subscription.
    if (SETTLED_STATES.has(handle.getState())) {
      finish(true);
      return;
    }
    void sleep(graceMs).then(() => finish(false));
  });
}

/**
 * Escalate a stop request: interrupt -> grace window -> hard stop, reporting the rung. The
 * end state is always terminal (the session is torn down) regardless of rung — "stop" means
 * the session ends; the rung only records HOW. Idempotent-friendly: a session that is already
 * terminal short-circuits at `already_terminal` without touching it.
 */
export async function escalateStop(
  handle: SessionHandle,
  opts: EscalateStopOptions = {},
): Promise<StopEscalationResult> {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  if (TERMINAL_STATES.has(handle.getState())) {
    return { rung: 'already_terminal', state: handle.getState() };
  }

  // Rung 1: ask the in-flight turn to cancel, then give it room to wind down.
  await handle.interrupt();
  const settled = await waitUntilSettled(handle, graceMs, sleep);

  // Rung 2: tear the session down regardless — a graceful interrupt still needs a stop() to
  // release the underlying query/PTY. `stop()` is idempotent and forces a terminal state.
  await handle.stop();
  return { rung: settled ? 'interrupted' : 'hard_stopped', state: handle.getState() };
}
