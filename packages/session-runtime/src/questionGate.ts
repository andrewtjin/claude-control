// The question gate: the AskUserQuestion analog of permissionGate.ts. It makes an SDK-parked
// AskUserQuestion BLOCK a tool until a human answers — no timeout, single-resolve semantics, and
// a fail-closed teardown so nothing ever leaks.
//
// Same mechanism as the permission gate (a promise the SDK's `canUseTool` awaits, resolved only
// when an answer arrives), and the same NON-NEGOTIABLE: there is deliberately no timer here. An
// abandoned question is bounded ONLY by the session/turn ending — `denyAll()` — never by an
// auto-answer. It is a SEPARATE gate rather than the permission gate reused because a question
// "resolution" is a set of structured answers, not an allow/deny decision.

import type { PermissionResolveOutcome, QuestionAnswer, QuestionResolution } from './types.js';

/** One outstanding question: the resolver for the promise `canUseTool` is awaiting, plus a
 *  `settled` latch so a second answer (or a teardown after an answer) is a no-op rather than a
 *  double-resolve. The promise is kept so a duplicate `register` of the same still-pending id
 *  returns the SAME promise instead of forking a second block. */
interface GateEntry {
  promise: Promise<QuestionResolution>;
  resolve: (resolution: QuestionResolution) => void;
  settled: boolean;
}

export interface QuestionGate {
  /**
   * Register a pending question and return the promise the SDK's `canUseTool` awaits. It
   * resolves when an answer arrives (`resolve`) or the gate is torn down (`denyAll` →
   * fail-closed deny). Registering an id already pending returns the SAME promise — the SDK can
   * re-deliver a control_request for an in-flight id, and forking a second block would strand
   * the first.
   */
  register(requestId: string): Promise<QuestionResolution>;
  /**
   * Apply a human's answers to a pending question. Returns `resolved` for the first answer set
   * (the only one ever applied), `already_handled` for any later answer on the same id, and
   * `unknown` for an id with no pending question. This is the single point that makes a
   * double-tapped answer safe at the runtime layer.
   */
  resolve(requestId: string, answers: QuestionAnswer[]): PermissionResolveOutcome;
  /**
   * Fail-closed teardown: resolve every still-pending question as a `denied` so no `canUseTool`
   * promise is ever left dangling when the turn/session ends. Idempotent. `reason` becomes the
   * deny message. This is the ONLY thing that bounds an abandoned question; there is no timer.
   */
  denyAll(reason: string): void;
  /** requestIds still awaiting an answer — for introspection and tests. */
  pending(): string[];
}

/** Build a fresh gate. One is created per query/turn in the adapter (a managed session runs one
 *  turn at a time, so "the current gate" is unambiguous), torn down with `denyAll` at turn end. */
export function createQuestionGate(): QuestionGate {
  const entries = new Map<string, GateEntry>();

  return {
    register(requestId: string): Promise<QuestionResolution> {
      const existing = entries.get(requestId);
      // Re-registering a still-pending id (SDK re-delivery) returns the same block; a settled
      // entry shouldn't linger, but if one somehow does, start a fresh block.
      if (existing && !existing.settled) return existing.promise;

      let resolve!: (resolution: QuestionResolution) => void;
      const promise = new Promise<QuestionResolution>((res) => {
        resolve = res;
      });
      entries.set(requestId, { promise, resolve, settled: false });
      return promise;
    },

    resolve(requestId: string, answers: QuestionAnswer[]): PermissionResolveOutcome {
      const entry = entries.get(requestId);
      if (!entry) return 'unknown';
      // Settled entries are KEPT (not deleted) so a repeat returns 'already_handled' rather than
      // 'unknown' — the double-tap idempotency the design requires. The gate is per-turn and
      // discarded at turn end, so retained settled entries never accumulate.
      if (entry.settled) return 'already_handled';
      entry.settled = true;
      entry.resolve({ kind: 'answers', answers });
      return 'resolved';
    },

    denyAll(reason: string): void {
      for (const entry of entries.values()) {
        if (entry.settled) continue;
        entry.settled = true;
        entry.resolve({ kind: 'denied', message: reason });
      }
    },

    pending(): string[] {
      const ids: string[] = [];
      for (const [requestId, entry] of entries) {
        if (!entry.settled) ids.push(requestId);
      }
      return ids;
    },
  };
}
