import { describe, it, expect } from 'vitest';
import { escalateStop } from './stopEscalation.js';
import type { SessionEvent, SessionHandle, SessionState } from './types.js';

async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface FakeHandleApi {
  handle: SessionHandle;
  counts: { interrupt: number; stop: number };
  setState(s: SessionState): void;
  emit(e: SessionEvent): void;
}

/** A controllable SessionHandle. `onInterrupt` lets a test simulate the common real case where
 *  interrupting the in-flight turn causes it to settle (e.g. the SDK query ends -> waiting_input);
 *  `emit` lets a test drive the reactive status path; `stop()` forces a terminal state like the
 *  real backends do. */
function fakeHandle(
  opts: { initialState?: SessionState; onInterrupt?: (api: FakeHandleApi) => void } = {},
): FakeHandleApi {
  let state: SessionState = opts.initialState ?? 'running';
  const listeners = new Set<(e: SessionEvent) => void>();
  const counts = { interrupt: 0, stop: 0 };

  const api: FakeHandleApi = {
    handle: {
      id: 'h1',
      getState: () => state,
      onEvent(cb) {
        listeners.add(cb);
        return () => listeners.delete(cb);
      },
      send: () => Promise.resolve(),
      interrupt: () => {
        counts.interrupt++;
        opts.onInterrupt?.(api);
        return Promise.resolve();
      },
      stop: () => {
        counts.stop++;
        if (state !== 'done' && state !== 'failed' && state !== 'orphaned') state = 'done';
        return Promise.resolve();
      },
    },
    counts,
    setState(s) {
      state = s;
    },
    emit(e) {
      if (e.kind === 'status') state = e.state;
      for (const cb of listeners) cb(e);
    },
  };
  return api;
}

describe('escalateStop', () => {
  it('short-circuits at already_terminal without interrupting or stopping', async () => {
    const fake = fakeHandle({ initialState: 'done' });
    const result = await escalateStop(fake.handle);
    expect(result).toEqual({ rung: 'already_terminal', state: 'done' });
    expect(fake.counts).toEqual({ interrupt: 0, stop: 0 });
  });

  it('reports interrupted when the interrupt settles the turn (via state) inside the grace window', async () => {
    // Simulate interrupt() winding the turn down to waiting_input, as the real SDK does.
    const fake = fakeHandle({ onInterrupt: (api) => api.setState('waiting_input') });
    const result = await escalateStop(fake.handle, {
      graceMs: 1000,
      sleep: () => Promise.resolve(),
    });
    expect(result.rung).toBe('interrupted');
    // Still torn down: interrupt then a finalizing stop.
    expect(fake.counts).toEqual({ interrupt: 1, stop: 1 });
    expect(result.state).toBe('done');
  });

  it('reports interrupted when a settled status arrives reactively after subscription', async () => {
    const fake = fakeHandle(); // stays 'running' after interrupt
    // Grace timer we control so the reactive event, not the timeout, decides the race.
    let releaseGrace: () => void = () => undefined;
    const sleep = (): Promise<void> => new Promise<void>((r) => (releaseGrace = r));

    const p = escalateStop(fake.handle, { graceMs: 1000, sleep });
    await tick(); // let interrupt() run and waitUntilSettled subscribe
    fake.emit({ kind: 'status', state: 'waiting_input' }); // reactive settle
    const result = await p;

    expect(result.rung).toBe('interrupted');
    expect(fake.counts.stop).toBe(1);
    // Prove the grace timeout did not decide it (releasing it now is a harmless no-op).
    releaseGrace();
  });

  it('reports hard_stopped when the grace window elapses with the turn still running', async () => {
    const fake = fakeHandle(); // never settles on its own
    const result = await escalateStop(fake.handle, { graceMs: 5, sleep: () => Promise.resolve() });
    expect(result.rung).toBe('hard_stopped');
    expect(fake.counts).toEqual({ interrupt: 1, stop: 1 });
  });
});
