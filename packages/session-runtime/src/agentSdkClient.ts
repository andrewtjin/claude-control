// The real `AgentSdkClient` — adapts `@anthropic-ai/claude-agent-sdk`'s `query()` onto the
// minimal domain interface managedSession.ts depends on.
//
// WET-GATED: this file is the ONLY one in the package that calls the real `sdkQuery()` /
// hands the SDK a live `canUseTool` callback, so it is the only one that would spawn a
// Claude Code subprocess and consume API/plan quota. It is checked for type-shape
// plausibility against the SDK's published `.d.ts` but is NOT exercised by the unit suite.
//
// Everything that CAN be tested without a real subprocess has been extracted so that it is:
//   - message/options translation   -> agentSdkMapping.ts   (pure, unit-tested)
//   - the blocking permission logic  -> permissionGate.ts     (pure, unit-tested)
//   - the session state machine      -> managedSession.ts     (fake-client unit-tested)
// What remains here is the irreducible wiring: merge the SDK message stream with
// canUseTool-originated permission events, and route decisions back into the in-flight call.
//
// The three historical gaps are now closed:
//   1. `canUseTool` IS wired — a prompt becomes a `permission_required` event and the tool
//      blocks on `permissionGate.register()` until `resolvePermission()` (never a timer).
//   2. `tool_result` names the real tool via the id->name map mapSdkMessage keeps per turn.
//   3. `accountId` is threaded via `buildSdkQueryOptions` (config-dir bind) or made LOUD —
//      see agentSdkMapping.ts's BuildSdkQueryOptionsDeps for the full finding.

import { query as sdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { PermissionResult, Query as SdkQuery } from '@anthropic-ai/claude-agent-sdk';
import type { AgentSdkClient, AgentSdkEvent } from './managedSession.js';
import type { PermissionDecision, PermissionResolveOutcome } from './types.js';
import { createPermissionGate, type PermissionGate } from './permissionGate.js';
import {
  buildSdkQueryOptions,
  mapSdkMessage,
  type BuildSdkQueryOptionsDeps,
  type ToolNameMap,
} from './agentSdkMapping.js';

/** Construction-time dependencies. Identical to the option-builder's deps — how `accountId`
 *  binds to credentials is a policy the daemon injects (a real config-dir resolver + a
 *  logger-backed `onUnboundAccountId`); omitting them keeps the safe, loud defaults below. */
export type CreateAgentSdkClientDeps = BuildSdkQueryOptionsDeps;

/** Loud default so a dropped accountId is never silent even if the daemon injects nothing. */
function defaultOnUnboundAccountId(accountId: string): void {
  // Deliberate: the drop must be observable; a daemon with a real logger overrides this via
  // deps.onUnboundAccountId.
  console.warn(
    `[agentSdkClient] accountId '${accountId}' is not bound to a config dir — this session ` +
      `runs under whichever account the switch engine last activated globally. Confirm it was ` +
      `activated before spawn (see agentSdkMapping.ts for the credential-selection finding).`,
  );
}

/** Map our domain decision onto the SDK's `PermissionResult`. `deny` requires a message; an
 *  `allow` may carry a narrowed `updatedInput`. Trivial, but SDK-typed, so it stays here in
 *  the WET-gated file rather than in the pure mapping module. */
function decisionToPermissionResult(decision: PermissionDecision): PermissionResult {
  if (decision.behavior === 'allow') {
    return {
      behavior: 'allow',
      ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
    };
  }
  return { behavior: 'deny', message: decision.message ?? 'denied by remote operator' };
}

/** An async iterable a producer can push into and close. Used to interleave the SDK's own
 *  message stream (pumped by a background loop) with `permission_required` events that arise
 *  out-of-band inside the `canUseTool` callback — the two can't share a single `for await`
 *  over the SDK query because canUseTool is a callback, not a message. */
interface EventChannel<T> extends AsyncIterable<T> {
  push(item: T): void;
  close(): void;
}

function createEventChannel<T>(): EventChannel<T> {
  const queue: T[] = [];
  const waiters: Array<(r: IteratorResult<T>) => void> = [];
  let closed = false;
  return {
    push(item: T): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) waiter({ value: item, done: false });
      else queue.push(item);
    },
    close(): void {
      if (closed) return;
      closed = true;
      for (let waiter = waiters.shift(); waiter; waiter = waiters.shift()) {
        waiter({ value: undefined as never, done: true });
      }
    },
    async *[Symbol.asyncIterator](): AsyncGenerator<T> {
      for (;;) {
        // Items are never `undefined` (they are AgentSdkEvent objects), so a `shift()` of
        // undefined unambiguously means "queue empty".
        const item = queue.shift();
        if (item !== undefined) {
          yield item;
          continue;
        }
        if (closed) return;
        const result = await new Promise<IteratorResult<T>>((resolve) => waiters.push(resolve));
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

/** Build a real `AgentSdkClient`. `interrupt()`/`end()`/`resolvePermission()` target whichever
 *  `query()` call is currently in flight — managedSession never has two turns running
 *  concurrently (see its `busy` guard), so "the current one" is unambiguous. */
export function createAgentSdkClient(deps: CreateAgentSdkClientDeps = {}): AgentSdkClient {
  const buildDeps: BuildSdkQueryOptionsDeps = {
    onUnboundAccountId: deps.onUnboundAccountId ?? defaultOnUnboundAccountId,
    ...(deps.configDirForAccount !== undefined
      ? { configDirForAccount: deps.configDirForAccount }
      : {}),
    ...(deps.baseEnv !== undefined ? { baseEnv: deps.baseEnv } : {}),
  };

  let current: SdkQuery | undefined;
  // Gate for the in-flight turn's permission prompts. Recreated per query; denied wholesale
  // on end() so a stop with a prompt outstanding fails closed (no dangling canUseTool).
  let currentGate: PermissionGate | undefined;

  return {
    query(prompt, opts) {
      const channel = createEventChannel<AgentSdkEvent>();
      const gate = createPermissionGate();
      // Fresh per turn: tool_use ids are only unique within a turn's message sequence.
      const toolNames: ToolNameMap = new Map();
      const sdkOptions = buildSdkQueryOptions(opts, buildDeps);

      const q = sdkQuery({
        prompt,
        options: {
          ...sdkOptions,
          // The permission prompt hook. Emitting a `permission_required` event and then
          // awaiting the gate is exactly "block the tool until the phone answers" — the SDK
          // keeps the tool parked for as long as this promise is unresolved, with no deadline.
          canUseTool: async (toolName, _input, o): Promise<PermissionResult> => {
            const { requestId } = o;
            channel.push({
              type: 'permission_required',
              requestId,
              tool: toolName,
              summary: o.title ?? o.displayName ?? toolName,
              ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
            });
            // If the SDK aborts this request (interrupt/cancel), fail it closed rather than
            // leave the awaited promise hanging. A later resolve() is a no-op by then.
            o.signal.addEventListener('abort', () => {
              gate.resolve(requestId, { behavior: 'deny', message: 'request aborted' });
            });
            const decision = await gate.register(requestId);
            return decisionToPermissionResult(decision);
          },
        },
      });

      current = q;
      currentGate = gate;

      // Pump the SDK's message stream into the channel in the background; on the way out
      // (normal end, error, or abort) deny any still-pending prompt so nothing dangles, then
      // close the channel so managedSession's `for await` completes.
      void (async () => {
        try {
          for await (const msg of q) {
            for (const event of mapSdkMessage(msg, toolNames)) channel.push(event);
          }
        } catch (err) {
          channel.push({
            type: 'error',
            message: err instanceof Error ? err.message : String(err),
          });
        } finally {
          gate.denyAll('turn ended before this permission was answered');
          channel.close();
        }
      })();

      return channel;
    },

    async interrupt(): Promise<void> {
      if (current) await current.interrupt();
    },

    end(): Promise<void> {
      // Fail closed before tearing down: any prompt still parked in canUseTool is denied so
      // the SDK subprocess is never left blocked on a decision that will never come.
      currentGate?.denyAll('session ended');
      current?.close();
      return Promise.resolve();
    },

    resolvePermission(requestId: string, decision: PermissionDecision): PermissionResolveOutcome {
      return currentGate?.resolve(requestId, decision) ?? 'unknown';
    },
  };
}
