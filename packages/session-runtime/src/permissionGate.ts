// The permission gate: the small, pure piece of machinery that makes SDK-originated
// permission prompts BLOCK a tool until a human decides — with no timeout, single-resolve
// semantics, and a fail-closed teardown so nothing ever leaks.
//
// The real Agent SDK exposes permission prompts through a `canUseTool` callback that must
// return a `Promise<PermissionResult>`; the tool stays blocked for exactly as long as that
// promise is unresolved (the SDK has NO park deadline — see its own d.ts note). So "block
// the tool until the phone answers" is implemented by handing the SDK a promise this gate
// owns and only resolving it when a decision arrives. That mechanism is the whole reason
// this module exists as its own pure unit: the gate can be exhaustively tested (blocking,
// single-resolve, deny-on-teardown, no-leak) without ever spawning a real SDK process,
// while the WET-gated adapter (agentSdkClient.ts) just wires the SDK's canUseTool onto it.
//
// NON-NEGOTIABLE (plan §4 / M4): there is deliberately no timer here. An abandoned request
// is bounded ONLY by the session/turn ending — `denyAll()` — never by an auto-decision.

import type { PermissionDecision, PermissionResolveOutcome } from './types.js';

/** One outstanding request: the resolver for the promise `canUseTool` is awaiting, plus a
 *  `settled` latch so a second decision (or a teardown after a decision) is a no-op rather
 *  than a double-resolve. The promise itself is kept so a duplicate `register` of the same
 *  still-pending id returns the SAME promise instead of forking a second block. */
interface GateEntry {
  promise: Promise<PermissionDecision>;
  resolve: (decision: PermissionDecision) => void;
  settled: boolean;
}

export interface PermissionGate {
  /**
   * Register a pending request and return the promise the SDK's `canUseTool` awaits. It
   * resolves when a decision arrives (`resolve`) or the gate is torn down (`denyAll` →
   * fail-closed deny). Registering an id that is already pending returns the SAME promise —
   * the SDK can re-deliver a control_request for an in-flight id, and forking a second block
   * would strand the first.
   */
  register(requestId: string): Promise<PermissionDecision>;
  /**
   * Apply a decision to a pending request. Returns `resolved` for the first decision (the
   * only one ever applied), `already_handled` for any later decision on the same id, and
   * `unknown` for an id with no pending request. This is the single point that makes a
   * double-tapped approve/deny safe at the runtime layer.
   */
  resolve(requestId: string, decision: PermissionDecision): PermissionResolveOutcome;
  /**
   * Fail-closed teardown: resolve every still-pending request as a `deny` so no `canUseTool`
   * promise is ever left dangling when the turn/session ends (that would block the SDK
   * subprocess forever). Idempotent — safe to call from both the normal turn-end path and an
   * explicit stop. `reason` becomes the deny message. This is the ONLY thing that bounds an
   * abandoned request; there is no timer.
   */
  denyAll(reason: string): void;
  /** requestIds still awaiting a decision — for introspection and tests. */
  pending(): string[];
}

/** Build a fresh gate. One gate is created per query/turn in the adapter (a managed session
 *  runs one turn at a time, so "the current gate" is unambiguous), and torn down with
 *  `denyAll` when that turn ends. */
export function createPermissionGate(): PermissionGate {
  const entries = new Map<string, GateEntry>();

  return {
    register(requestId: string): Promise<PermissionDecision> {
      const existing = entries.get(requestId);
      // Re-registering a still-pending id (SDK re-delivery) returns the same block; a
      // settled entry shouldn't linger, but if one somehow does, start a fresh block.
      if (existing && !existing.settled) return existing.promise;

      let resolve!: (decision: PermissionDecision) => void;
      const promise = new Promise<PermissionDecision>((res) => {
        resolve = res;
      });
      entries.set(requestId, { promise, resolve, settled: false });
      return promise;
    },

    resolve(requestId: string, decision: PermissionDecision): PermissionResolveOutcome {
      const entry = entries.get(requestId);
      if (!entry) return 'unknown';
      // Settled entries are KEPT (not deleted) precisely so a repeat returns 'already_handled'
      // rather than 'unknown' — the double-tap idempotency the M4 contract requires. The gate
      // is per-turn and discarded at turn end, so retained settled entries never accumulate.
      if (entry.settled) return 'already_handled';
      entry.settled = true;
      entry.resolve(decision);
      return 'resolved';
    },

    denyAll(reason: string): void {
      for (const entry of entries.values()) {
        if (entry.settled) continue;
        entry.settled = true;
        entry.resolve({ behavior: 'deny', message: reason });
      }
    },

    pending(): string[] {
      // Only requests still awaiting a decision — settled entries are retained for idempotency
      // but are not "pending".
      const ids: string[] = [];
      for (const [requestId, entry] of entries) {
        if (!entry.settled) ids.push(requestId);
      }
      return ids;
    },
  };
}
