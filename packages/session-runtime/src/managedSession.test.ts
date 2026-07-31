import { describe, it, expect } from 'vitest';
import { startManagedSession } from './managedSession.js';
import type { AgentSdkClient, AgentSdkEvent, AgentSdkQueryOptions } from './managedSession.js';
import type {
  PermissionDecision,
  PermissionRequest,
  QuestionAnswer,
  QuestionPrompt,
  QuestionRequest,
  SessionEvent,
} from './types.js';

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

  it('stop() still reaches done when end() rejects (dead transport)', async () => {
    const { client, counts } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    client.end = () => {
      counts.end++;
      return Promise.reject(new Error('transport already closed'));
    };
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();
    expect(handle.getState()).toBe('waiting_input');

    // A rejecting teardown must not leave the session immortal: stop() resolves and the
    // state is terminal regardless, so a registry restart can never resurrect it.
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

  it('surfaces a structured question request via onQuestionRequest and enters waiting_permission', async () => {
    const questions: QuestionPrompt[] = [
      {
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [{ label: 'teal' }, { label: 'red' }],
      },
    ];
    const { client } = fakeClient([
      [
        { type: 'question_required', requestId: 'q-1', questions, permissionMode: 'default' },
        { type: 'turn_result', ok: true, summary: 'done' },
      ],
    ]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(typeof handle.onQuestionRequest).toBe('function');
    const reqs: QuestionRequest[] = [];
    handle.onQuestionRequest!((r) => reqs.push(r));
    const events = collectEvents(handle);
    await tick();

    expect(reqs).toEqual([{ requestId: 'q-1', questions, permissionMode: 'default' }]);
    // Reuses waiting_permission (a question is a blocked-on-human wait); the display shows the
    // first question as the milestone preview.
    expect(events).toContainEqual({ kind: 'status', state: 'waiting_permission' });
    expect(events).toContainEqual({ kind: 'milestone', text: 'Question: Which color?' });
  });

  it('resolveQuestion delegates to the client and returns its outcome', () => {
    const resolveCalls: Array<{ requestId: string; answers: QuestionAnswer[] }> = [];
    const client: AgentSdkClient = {
      query: () => ({
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          yield { type: 'turn_result', ok: true, summary: 'done' };
        },
      }),
      interrupt: () => Promise.resolve(),
      end: () => Promise.resolve(),
      resolveQuestion: (requestId, answers) => {
        resolveCalls.push({ requestId, answers });
        return 'resolved';
      },
    };
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const answers: QuestionAnswer[] = [{ question: 'Which color?', selected: ['teal'] }];
    expect(handle.resolveQuestion!('q-1', answers)).toBe('resolved');
    expect(resolveCalls).toEqual([{ requestId: 'q-1', answers }]);
  });

  it('resolveQuestion returns unknown when the client cannot resolve questions', () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    expect(handle.resolveQuestion!('whatever', [{ question: 'q', selected: [] }])).toBe('unknown');
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

// ---------------------------------------------------------------------------
// Auto-continue: transient API failures retry instead of going terminal
// ---------------------------------------------------------------------------

/** Deterministic stand-in for the policy's timer seam: retries queue here and fire only
 *  when the test says so, with the requested delay recorded for backoff assertions. */
function manualSchedule(): {
  schedule: (fn: () => void, delayMs: number) => () => void;
  pending: Array<{ fn: () => void; delayMs: number; canceled: boolean; fired: boolean }>;
  fire: () => Promise<void>;
} {
  const pending: Array<{ fn: () => void; delayMs: number; canceled: boolean; fired: boolean }> = [];
  return {
    pending,
    schedule(fn, delayMs) {
      const entry = { fn, delayMs, canceled: false, fired: false };
      pending.push(entry);
      return () => {
        entry.canceled = true;
      };
    },
    async fire() {
      const next = pending.find((p) => !p.canceled && !p.fired);
      if (!next) throw new Error('manualSchedule: nothing pending to fire');
      next.fired = true;
      next.fn();
      await tick();
    },
  };
}

const SERVER_500 =
  'API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again in a moment.';

describe('startManagedSession auto-continue', () => {
  it('retries a transient mid-turn failure with `continue`, suppressing the failure card, then completes cleanly', async () => {
    const { client, calls } = fakeClient([
      [
        { type: 'session_init', sessionId: 'sdk-1' },
        { type: 'assistant_text', text: 'partial work' },
        { type: 'turn_result', ok: false, summary: SERVER_500 },
      ],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    const events = collectEvents(handle);
    await tick();

    // Non-terminal during the backoff wait; the milestone replaced the failure card.
    expect(handle.getState()).toBe('running');
    expect(events.some((e) => e.kind === 'summary' && e.text.startsWith('Session failed'))).toBe(
      false,
    );
    const milestones = events.flatMap((e) =>
      e.kind === 'milestone' && e.text.startsWith('Auto-continue') ? [e.text] : [],
    );
    expect(milestones).toHaveLength(1);
    expect(milestones[0]).toContain('attempt 1/5');
    expect(timers.pending[0]?.delayMs).toBe(15_000);

    await timers.fire();
    // The dead turn produced output, so the retry is the CLI's documented `continue`,
    // resuming the SDK session captured at session_init.
    expect(calls[1]?.prompt).toBe('continue');
    expect(calls[1]?.opts.resumeSessionId).toBe('sdk-1');
    expect(handle.getState()).toBe('waiting_input');
  });

  it('re-asks the prompt when output flowed but no session_init ever arrived (nothing to continue INTO)', async () => {
    const { client, calls } = fakeClient([
      [
        // The CLI's synthetic "API Error: ..." text streams as assistant output, so a turn
        // can look output-ful while having no resume anchor at all.
        { type: 'assistant_text', text: 'API Error: 500 Internal server error.' },
        { type: 'turn_result', ok: false, summary: SERVER_500 },
      ],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();
    await timers.fire();
    expect(calls[1]?.prompt).toBe('go');
    expect(calls[1]?.opts.resumeSessionId).toBeUndefined();
  });

  it('re-asks the turn prompt verbatim when the dead turn produced nothing', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: 'API Error: 529 Overloaded' }],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();
    await timers.fire();
    expect(calls[1]?.prompt).toBe('go');
  });

  it('retries a thrown stream whose message classifies transient (a mid-stream disconnect)', async () => {
    const { client, calls } = fakeClient([
      () => ({
        // eslint-disable-next-line require-yield -- a stream that dies before its first event
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentSdkEvent> {
          await Promise.resolve();
          throw new Error('fetch failed');
        },
      }),
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('starting'); // never produced output, never went terminal
    expect(events.some((e) => e.kind === 'error')).toBe(false); // "Error:" text suppressed too
    await timers.fire();
    expect(calls[1]?.prompt).toBe('go');
    expect(handle.getState()).toBe('waiting_input');
  });

  it('leaves non-transient failures exactly as terminal as before', async () => {
    const { client } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: 'the tool exploded' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('failed');
    expect(events).toContainEqual({ kind: 'summary', text: 'Session failed: the tool exploded' });
    expect(timers.pending).toHaveLength(0);
  });

  it('without a policy, a transient failure stays terminal (pre-existing behavior)', async () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: false, summary: SERVER_500 }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();
    expect(handle.getState()).toBe('failed');
  });

  it('doubles the backoff per consecutive failure, honors the cap, and gives up past the budget', async () => {
    const failing: Turn = [{ type: 'turn_result', ok: false, summary: SERVER_500 }];
    const { client, calls } = fakeClient([failing, failing, failing]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: {
        schedule: timers.schedule,
        maxAttempts: 2,
        baseDelayMs: 100,
        maxDelayMs: 150,
      },
    });
    const events = collectEvents(handle);
    await tick();

    expect(timers.pending[0]?.delayMs).toBe(100);
    await timers.fire();
    expect(timers.pending[1]?.delayMs).toBe(150); // 200 capped to 150
    await timers.fire();

    // Third consecutive failure exceeds maxAttempts=2: the failure card finally fires.
    expect(handle.getState()).toBe('failed');
    expect(calls).toHaveLength(3);
    expect(events).toContainEqual({ kind: 'summary', text: `Session failed: ${SERVER_500}` });
    expect(
      events.filter((e) => e.kind === 'milestone' && e.text.startsWith('Auto-continue')),
    ).toHaveLength(2);
  });

  it('counts an error event and the failed turn_result behind it as ONE failure', async () => {
    const { client } = fakeClient([
      [
        { type: 'error', message: SERVER_500 },
        { type: 'turn_result', ok: false, summary: SERVER_500 },
      ],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    const events = collectEvents(handle);
    await tick();

    expect(timers.pending).toHaveLength(1);
    expect(
      events.filter((e) => e.kind === 'milestone' && e.text.startsWith('Auto-continue')),
    ).toHaveLength(1);
    await timers.fire();
    expect(handle.getState()).toBe('waiting_input');
  });

  it('a human send() during the backoff wait cancels the retry and wins', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: SERVER_500 }],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    await handle.send('actually, do this instead');
    await tick();
    expect(timers.pending[0]?.canceled).toBe(true);
    expect(calls[1]?.prompt).toBe('actually, do this instead');
    expect(handle.getState()).toBe('waiting_input');
  });

  it('interrupt() during the backoff wait cancels the retry and settles waiting_input', async () => {
    const { client, calls, counts } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: SERVER_500 }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    await handle.interrupt();
    expect(timers.pending[0]?.canceled).toBe(true);
    expect(handle.getState()).toBe('waiting_input');
    // No turn was in flight — the client's interrupt must not fire for a canceled wait.
    expect(counts.interrupt).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it('stop() during the backoff wait cancels the retry before tearing down', async () => {
    const { client, calls, counts } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: SERVER_500 }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    await handle.stop();
    expect(timers.pending[0]?.canceled).toBe(true);
    expect(handle.getState()).toBe('done');
    expect(counts.end).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it('a clean turn completion resets the failure streak', async () => {
    const failing: Turn = [{ type: 'turn_result', ok: false, summary: SERVER_500 }];
    const succeeding: Turn = [{ type: 'turn_result', ok: true, summary: 'done' }];
    const { client, calls } = fakeClient([failing, succeeding, failing, succeeding]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      // maxAttempts 1: WITHOUT the reset, the second failure would exhaust the budget.
      autoContinue: { schedule: timers.schedule, maxAttempts: 1 },
    });
    await tick();
    await timers.fire(); // retry -> clean completion resets the streak

    await handle.send('next task');
    await tick();
    // The new failure retries again — proof the counter reset on the clean turn.
    expect(handle.getState()).not.toBe('failed');
    await timers.fire();
    expect(calls).toHaveLength(4);
    expect(handle.getState()).toBe('waiting_input');
  });
});

// ---------------------------------------------------------------------------
// Usage-limit stall: park on an exhausted account, resume after a switch
// ---------------------------------------------------------------------------

const USAGE_LIMIT_529 = 'Claude usage limit reached. Your limit will reset at 3pm.';

describe('startManagedSession usage-limit stall', () => {
  it('parks on a usage-limit death: waiting_input, no failure card, no retry timer', async () => {
    const { client } = fakeClient([
      [
        { type: 'session_init', sessionId: 'sdk-1' },
        { type: 'assistant_text', text: 'partial work' },
        { type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 },
      ],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('waiting_input');
    expect(events.some((e) => e.kind === 'summary' && e.text.startsWith('Session failed'))).toBe(
      false,
    );
    // Parked means WAITING, not retrying: no backoff timer may be pending.
    expect(timers.pending).toHaveLength(0);
    const milestones = events.flatMap((e) =>
      e.kind === 'milestone' && e.text.startsWith('Usage limit reached') ? [e.text] : [],
    );
    expect(milestones).toHaveLength(1);
  });

  it('resumeFromUsageLimitStall kicks `continue` into the resumed conversation, once', async () => {
    const { client, calls } = fakeClient([
      [
        { type: 'session_init', sessionId: 'sdk-1' },
        { type: 'assistant_text', text: 'partial work' },
        { type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 },
      ],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    expect(handle.resumeFromUsageLimitStall!()).toBe(true);
    await tick();
    // The dead turn produced output and captured a resume anchor, so the kick is the CLI's
    // documented `continue` into the same conversation — on whatever account is now active.
    expect(calls[1]?.prompt).toBe('continue');
    expect(calls[1]?.opts.resumeSessionId).toBe('sdk-1');
    expect(handle.getState()).toBe('waiting_input');
    // The park is consumed: a second kick (a second /switch) has nothing to resume.
    expect(handle.resumeFromUsageLimitStall!()).toBe(false);
  });

  it('the kick re-asks the turn prompt verbatim when the dead turn produced nothing', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: 'API Error: 429 Rate limit exceeded' }],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    expect(handle.resumeFromUsageLimitStall!()).toBe(true);
    await tick();
    expect(calls[1]?.prompt).toBe('go');
    expect(calls[1]?.opts.resumeSessionId).toBeUndefined();
  });

  it('a usage-limit death re-parks after a kick — self-limiting, one request per switch', async () => {
    const dying: Turn = [{ type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 }];
    const { client, calls } = fakeClient([dying, dying]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    expect(handle.resumeFromUsageLimitStall!()).toBe(true);
    await tick();
    // The kicked turn hit another exhausted account: parked again, no timer, not failed.
    expect(handle.getState()).toBe('waiting_input');
    expect(timers.pending).toHaveLength(0);
    expect(calls).toHaveLength(2);
    // ...and a later switch can kick it again.
    expect(handle.resumeFromUsageLimitStall!()).toBe(true);
  });

  it('without an autoContinue policy, a usage-limit failure stays terminal (pre-existing behavior)', async () => {
    const { client } = fakeClient([[{ type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    const events = collectEvents(handle);
    await tick();

    expect(handle.getState()).toBe('failed');
    expect(events).toContainEqual({
      kind: 'summary',
      text: `Session failed: ${USAGE_LIMIT_529}`,
    });
    expect(handle.resumeFromUsageLimitStall!()).toBe(false);
  });

  it('a human send() while parked wins and consumes the park', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 }],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    await handle.send('actually, do this instead');
    await tick();
    expect(calls[1]?.prompt).toBe('actually, do this instead');
    // The human's turn ended the park: a switch arriving later must not replay anything.
    expect(handle.resumeFromUsageLimitStall!()).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it('is a no-op on a session that never stalled', async () => {
    const { client, calls } = fakeClient([[{ type: 'turn_result', ok: true, summary: 'done' }]]);
    const handle = startManagedSession({ id: 's1', client, prompt: 'go' });
    await tick();

    expect(handle.resumeFromUsageLimitStall!()).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it('a usage-limit park does not corrupt the transient-failure streak bookkeeping', async () => {
    const { client, calls } = fakeClient([
      [{ type: 'turn_result', ok: false, summary: USAGE_LIMIT_529 }],
      [{ type: 'turn_result', ok: false, summary: SERVER_500 }],
      [{ type: 'turn_result', ok: true, summary: 'done' }],
    ]);
    const timers = manualSchedule();
    const handle = startManagedSession({
      id: 's1',
      client,
      prompt: 'go',
      autoContinue: { schedule: timers.schedule },
    });
    await tick();

    // Park -> kick -> the kicked turn dies of a TRANSIENT failure: auto-continue's retry
    // loop takes over exactly as if the park had never happened.
    expect(handle.resumeFromUsageLimitStall!()).toBe(true);
    await tick();
    expect(timers.pending).toHaveLength(1);
    await timers.fire();
    expect(calls).toHaveLength(3);
    expect(handle.getState()).toBe('waiting_input');
  });
});
