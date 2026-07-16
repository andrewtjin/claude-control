import { describe, it, expect } from 'vitest';
import { attachObservedSession, createNodePtyFactory } from './observedSession.js';
import type { PtyFactory, PtyHandle, PtyExitInfo, PtySpawnOptions } from './observedSession.js';
import type { SessionEvent } from './types.js';

/** A fake PtyFactory whose single spawned handle is fully test-controlled: emitData()/
 *  emitExit() simulate the underlying process, and writes/kill are recorded for assertion. */
function createFakePtyFactory(): {
  factory: PtyFactory;
  spawnCalls: Array<{ command: string; args: string[]; opts: PtySpawnOptions }>;
  writes: string[];
  isKilled: () => boolean;
  emitData: (chunk: string) => void;
  emitExit: (info: PtyExitInfo) => void;
  dataListenerCount: () => number;
} {
  const spawnCalls: Array<{ command: string; args: string[]; opts: PtySpawnOptions }> = [];
  const writes: string[] = [];
  let killed = false;
  const dataListeners = new Set<(chunk: string) => void>();
  const exitListeners = new Set<(info: PtyExitInfo) => void>();

  const handle: PtyHandle = {
    onData(cb) {
      dataListeners.add(cb);
      return () => dataListeners.delete(cb);
    },
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    write(data) {
      writes.push(data);
    },
    kill() {
      killed = true;
    },
  };

  const factory: PtyFactory = {
    spawn(command, args, opts) {
      spawnCalls.push({ command, args, opts });
      return handle;
    },
  };

  return {
    factory,
    spawnCalls,
    writes,
    isKilled: () => killed,
    emitData: (chunk) => {
      for (const cb of dataListeners) cb(chunk);
    },
    emitExit: (info) => {
      for (const cb of exitListeners) cb(info);
    },
    dataListenerCount: () => dataListeners.size,
  };
}

function collectEvents(handle: {
  onEvent: (cb: (e: SessionEvent) => void) => () => void;
}): SessionEvent[] {
  const events: SessionEvent[] = [];
  handle.onEvent((e) => events.push(e));
  return events;
}

describe('attachObservedSession', () => {
  it('spawns immediately with the given command/args/cwd', () => {
    const fake = createFakePtyFactory();
    attachObservedSession({
      id: 's1',
      ptyFactory: fake.factory,
      command: 'claude',
      args: ['--resume', 'abc'],
      cwd: '/work',
    });
    expect(fake.spawnCalls).toEqual([
      { command: 'claude', args: ['--resume', 'abc'], opts: { cwd: '/work' } },
    ]);
  });

  it('defaults args to [] and omits cwd from opts when not given', () => {
    const fake = createFakePtyFactory();
    attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    expect(fake.spawnCalls).toEqual([{ command: 'claude', args: [], opts: {} }]);
  });

  it('starts in starting and flips to running on the first data chunk', () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    expect(handle.getState()).toBe('starting');
    fake.emitData('hello\n');
    expect(handle.getState()).toBe('running');
  });

  it('splits, dedupes, classifies, and emits events from streamed data', () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    const events = collectEvents(handle);

    fake.emitData('Wrote 10 lines to out.ts\nWrote 10 lines to out.ts\nplain text\n');

    // status(running) from the first chunk, then the deduped milestone, then output.
    expect(events).toEqual([
      { kind: 'status', state: 'running' },
      { kind: 'milestone', text: 'Wrote 10 lines to out.ts' },
      { kind: 'output', text: 'plain text' },
    ]);
  });

  it('buffers a partial line across chunk boundaries', () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    const events = collectEvents(handle);

    fake.emitData('Running: py');
    fake.emitData('test\n');

    expect(events).toEqual([
      { kind: 'status', state: 'running' },
      { kind: 'milestone', text: 'Running: pytest' },
    ]);
  });

  it('goes to done with a summary event on a zero exit code', () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    const events = collectEvents(handle);

    fake.emitExit({ exitCode: 0 });

    expect(handle.getState()).toBe('done');
    expect(events).toEqual([
      { kind: 'status', state: 'done' },
      { kind: 'summary', text: 'Process exited with code 0' },
    ]);
  });

  it('goes to failed with a summary event on a nonzero exit code', () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    const events = collectEvents(handle);

    fake.emitExit({ exitCode: 1, signal: 0 });

    expect(handle.getState()).toBe('failed');
    expect(events).toEqual([
      { kind: 'status', state: 'failed' },
      { kind: 'summary', text: 'Process exited with code 1' },
    ]);
  });

  it('send() writes the raw text to the pty without modification', async () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    await handle.send('ls -la\n');
    expect(fake.writes).toEqual(['ls -la\n']);
  });

  it('send() rejects once the session is terminal', async () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    fake.emitExit({ exitCode: 0 });
    await expect(handle.send('x')).rejects.toThrow(/terminal state 'done'/);
  });

  it('interrupt() writes a Ctrl+C byte', async () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    await handle.interrupt();
    expect(fake.writes).toEqual(['\x03']);
  });

  it('stop() kills the process, unsubscribes, and forces done if not already terminal', async () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    const events = collectEvents(handle);

    await handle.stop();

    expect(fake.isKilled()).toBe(true);
    expect(handle.getState()).toBe('done');
    expect(events).toContainEqual({ kind: 'status', state: 'done' });
    expect(fake.dataListenerCount()).toBe(0);

    // Further data after stop() must not produce more events — the subscription was torn down.
    const countBefore = events.length;
    fake.emitData('late output\n');
    expect(events.length).toBe(countBefore);
  });

  it('stop() does not downgrade a session that already exited failed', async () => {
    const fake = createFakePtyFactory();
    const handle = attachObservedSession({ id: 's1', ptyFactory: fake.factory, command: 'claude' });
    fake.emitExit({ exitCode: 1 });
    expect(handle.getState()).toBe('failed');

    await handle.stop();
    expect(handle.getState()).toBe('failed');
  });
});

describe('createNodePtyFactory', () => {
  it('resolves to a clear unavailable error when node-pty is not installed', async () => {
    // The task brief specifies node-pty is intentionally absent from this workspace, so
    // this exercises the real "not installed" path rather than a simulated one.
    const result = await createNodePtyFactory();
    expect(result).toEqual({
      ok: false,
      error: 'observed sessions unavailable: node-pty not installed',
    });
  });
});
