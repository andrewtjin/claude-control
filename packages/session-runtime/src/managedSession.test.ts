import { describe, it, expect } from 'vitest';
import { startManagedSession } from './managedSession.js';
import type { AgentSdkClient, AgentSdkEvent, AgentSdkQueryOptions } from './managedSession.js';
import type { PermissionDecision, PermissionRequest, SessionEvent } from './types.js';

/** Let every currently-queued microtask (queueMicrotask kickoff, async generator steps)
 *  drain before assertions run. setTimeout is a macrotask, so it always runs after the
 *  microtask queue is empty. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

type Turn = AgentSdkEvent[] | (() => AsyncIterable<AgentSdkEvent>);

function turnIterable(turn: Turn): AsyncIterable<AgentSdkEvent> {
  if (typeof turn === 'function') return turn();
  return {
    async *[Symbol.asyncIterator]() {
      // A real async generator always resolves each step through a microtask; this
      // matches that instead of pretending the loop itself needs no await.
      await Promise.resolve();
      for (const e of turn) yield e;
    },
  };
}

/** A scripted fake AgentSdkClient: each call to query() consumes the next entry in
 *  `turns`, in order. Records every call's prompt/opts and every interrupt()/end(). */
function fakeClient(turns: Turn[]): {
  client: AgentSdkClient;
  calls: Array<{ prompt: string; opts: AgentSdkQueryOptions }>;
  counts: { interrupt: number; end: number };
} {
  const calls: Array<{ prompt: string; opts: AgentSdkQueryOptions }> = [];
  const counts = { interrupt: 0, end: 0 };
  let index = 0;
  const client: AgentSdkClient = {
    query(prompt, opts) {
      calls.push({ prompt, opts });
      const turn = turns[index];
      index++;
      if (!turn) throw new Error('fakeClient: no scripted turn left');
      return turnIterable(turn);
    },
    interrupt() {
      counts.interrupt++;
      return Promise.resolve();
    },
    end() {
      counts.end++;
      return Promise.resolve();
    },
  };
  return { client, calls, counts };
}

function collectEvents(handle: {
  onEvent: (cb: (e: SessionEvent) => void) => () => void;
}): SessionEvent[] {
  const events: SessionEvent[] = [];
  handle.onEvent((e) => events.push(e));
  return events;
}

describe('startManagedSession', () => {
  it('drives starting -> running -> waiting_input across a successful turn, emitting classified events in order', async () => {
    const { client } = fakeClient([
      [
        { type: 'assistant_text', text: 'Hello' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'tool_result', name: 'Bash', ok: true },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(handle.getState()).toBe('starting');
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('waiting_input');
    expect(events).toEqual([
      { kind: 'output', text: 'Hello' },
      { kind: 'status', state: 'running' },
      { kind: 'milestone', text: 'Tool: Bash' },
      { kind: 'milestone', text: 'Tool result: Bash ok' },
      { kind: 'summary', text: 'Session complete: done' },
      { kind: 'status', state: 'waiting_input' },
    ]);
  });

  it('keeps a multi-line turn summary whole — one summary event, no lines stranded as output', async () => {
    const { client } = fakeClient([
      [{ type: 'turn_result', ok: true, summary: 'My cwd is:\nC:\\repos\\proj\nAll good.' }],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    // Exactly one summary carrying every line — re-classifying per line would keep only the
    // "Session complete:" head and demote the rest to transcript-only output.
    expect(events).toEqual([
      { kind: 'summary', text: 'Session complete: My cwd is:\nC:\\repos\\proj\nAll good.' },
      { kind: 'status', state: 'waiting_input' },
    ]);
  });

  it('keeps a multi-line tool failure whole in its milestone', async () => {
    const { client } = fakeClient([
      [
        { type: 'tool_result', name: 'Bash', ok: false, text: 'exit 1\nstderr says no' },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    expect(events[0]).toEqual({
      kind: 'milestone',
      text: 'Tool result: Bash failed: exit 1\nstderr says no',
    });
  });

  it('captures the resume session id from session_init and threads it into the next query', async () => {
    const { client, calls } = fakeClient([
      [
        { type: 'session_init', sessionId: 'sdk-session-1' },
        { type: 'turn_result', ok: true, summary: 'first' },
      ],
      [{ type: 'turn_result', ok: true, summary: 'second' }],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go', cwd: '/work' });
    await tick();
    expect(calls[0]).toEqual({ prompt: 'go', opts: { cwd: '/work' } });

    await handle.send('more');
    await tick();
    expect(calls[1]).toEqual({
      prompt: 'more',
      opts: { resumeSessionId: 'sdk-session-1', cwd: '/work' },
    });
  });

  it('passes accountId through to query options when provided', async () => {
    const { client, calls } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    startManagedSession({ id: 's1', client, prompt: 'go', accountId: 'acct-1' });
    await tick();
    expect(calls[0]?.opts.accountId).toBe('acct-1');
  });

  it('transitions to waiting_permission on permission_required and back to running on the next activity event', async () => {
    const { client } = fakeClient([
      [
        { type: 'permission_required', requestId: 'req-1', tool: 'Bash', summary: 'run tests' },
        { type: 'tool_use', name: 'Bash' },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    const statusEvents = events.filter((e) => e.kind === 'status');
    expect(statusEvents).toEqual([
      { kind: 'status', state: 'waiting_permission' },
      { kind: 'status', state: 'running' },
      { kind: 'status', state: 'waiting_input' },
    ]);
    expect(events).toContainEqual({
      kind: 'milestone',
      text: 'Permission required: Bash - run tests',
    });
  });

  it('goes to failed on a turn_result with ok: false and stays terminal', async () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: false, summary: 'build broke' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('failed');
    expect(events).toContainEqual({ kind: 'summary', text: 'Session failed: build broke' });
    await expect(handle.send('anything')).rejects.toThrow(/terminal state 'failed'/);
  });

  it('goes to failed on an explicit error event', async () => {
    const { client } = fakeClient([[{ type: 'error', message: 'transport lost' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('failed');
    expect(events).toContainEqual({ kind: 'error', text: 'Error: transport lost' });
  });

  it('goes to failed when the query iterator itself rejects mid-turn, without losing earlier events', async () => {
    const { client } = fakeClient([
      async function* (): AsyncGenerator<AgentSdkEvent> {
        await Promise.resolve();
        yield { type: 'assistant_text', text: 'hi' };
        throw new Error('boom');
      },
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('failed');
    expect(events[0]).toEqual({ kind: 'output', text: 'hi' });
    expect(events).toContainEqual({ kind: 'error', text: 'Error: boom' });
  });

  it('rejects send() while a turn is still in flight (busy guard)', async () => {
    const gate = deferred<void>();
    const { client } = fakeClient([
      async function* (): AsyncGenerator<AgentSdkEvent> {
        await gate.promise;
        yield { type: 'turn_result', ok: true, summary: 'first' };
      },
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick(); // let the first turn start and block on the gate

    await expect(handle.send('more')).rejects.toThrow(/busy/);

    gate.resolve();
    await tick();
    expect(handle.getState()).toBe('waiting_input');
  });

  it('forwards interrupt() to the client', async () => {
    const { client, counts } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();
    await handle.interrupt();
    expect(counts.interrupt).toBe(1);
  });

  it('stop() calls end() and forces a terminal done state even mid-turn', async () => {
    const gate = deferred<void>();
    const { client, counts } = fakeClient([
      async function* (): AsyncGenerator<AgentSdkEvent> {
        await gate.promise;
        // Never reached in this test — the gate is never resolved — but a generator
        // function must contain a yield to be one; this satisfies that without changing
        // the test's actual (blocked-forever) behavior.
        yield { type: 'turn_result', ok: true, summary: 'unused' };
      },
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();
    // The turn is blocked before yielding anything (awaiting the gate), so no activity
    // event has fired yet — state is still 'starting', not 'running'.
    expect(handle.getState()).toBe('starting');

    await handle.stop();
    expect(counts.end).toBe(1);
    expect(handle.getState()).toBe('done');
  });

  it('stop() does not downgrade a session that already reached failed', async () => {
    const { client, counts } = fakeClient([[{ type: 'error', message: 'boom' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();
    expect(handle.getState()).toBe('failed');

    await handle.stop();
    expect(counts.end).toBe(1);
    expect(handle.getState()).toBe('failed');
  });

  it('onEvent returns a working unsubscribe function', async () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events: SessionEvent[] = [];
    const unsubscribe = handle.onEvent((e) => events.push(e));
    unsubscribe();
    await tick();
    expect(events).toEqual([]);
  });

  it('surfaces a structured permission request (requestId + mode) via onPermissionRequest', async () => {
    const { client } = fakeClient([
      [
        {
          type: 'permission_required',
          requestId: 'req-9',
          tool: 'Bash',
          summary: 'run tests',
          permissionMode: 'default',
        },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(typeof handle.onPermissionRequest).toBe('function');
    const reqs: PermissionRequest[] = [];
    handle.onPermissionRequest!((r) => reqs.push(r));
    await tick();
    expect(reqs).toEqual([
      { requestId: 'req-9', tool: 'Bash', summary: 'run tests', permissionMode: 'default' },
    ]);
  });

  it('resolvePermission delegates to the client and returns its outcome', () => {
    const resolveCalls: Array<{ requestId: string; decision: PermissionDecision }> = [];
    const client: AgentSdkClient = {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'turn_result', ok: true, summary: 'done' };
        },
      }),
      interrupt: () => Promise.resolve(),
      end: () => Promise.resolve(),
      resolvePermission: (requestId, decision) => {
        resolveCalls.push({ requestId, decision });
        return 'resolved';
      },
    };
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(handle.resolvePermission!('req-1', { behavior: 'allow' })).toBe('resolved');
    expect(resolveCalls).toEqual([{ requestId: 'req-1', decision: { behavior: 'allow' } }]);
  });

  it('resolvePermission returns unknown when the client cannot resolve permissions', () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(handle.resolvePermission!('whatever', { behavior: 'deny', message: 'no' })).toBe(
      'unknown',
    );
  });

  it('threads permissionMode into every query', async () => {
    const { client, calls } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    startManagedSession({ id: 's1', client, prompt: 'go', permissionMode: 'default' });
    await tick();
    expect(calls[0]?.opts.permissionMode).toBe('default');
  });

  it('reports the SDK session id via onSessionId when a turn initializes', async () => {
    const seen: string[] = [];
    const { client } = fakeClient([
      [
        { type: 'session_init', sessionId: 'sdk-77' },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    startManagedSession({ id: 's1', client, prompt: 'go', onSessionId: (sid) => seen.push(sid) });
    await tick();
    expect(seen).toEqual(['sdk-77']);
  });
});
