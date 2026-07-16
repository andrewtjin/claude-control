import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionManager } from './sessionManager.js';
import type { AgentSdkClient, AgentSdkEvent } from './managedSession.js';
import type { PtyFactory, PtyHandle, PtyExitInfo } from './observedSession.js';
import type { SessionRecord } from './types.js';

let dirs: string[] = [];
async function sandbox(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'sr-mgr-'));
  dirs.push(d);
  return d;
}
afterEach(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

/** Let queued microtasks (managed session's queueMicrotask kickoff) drain. */
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

/** A fake AgentSdkClient whose single turn yields exactly the given events, then ends. */
function fakeClient(events: AgentSdkEvent[]): AgentSdkClient {
  return {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          await Promise.resolve();
          for (const e of events) yield e;
        },
      };
    },
    interrupt: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
}

/** A fake AgentSdkClient whose turn blocks until `gate` resolves before yielding anything.
 *  Used where a test needs a deterministic window in which the session is guaranteed to
 *  still be mid-turn — without it, an instantly-resolving fake client can complete its
 *  whole turn during sessionManager's own `await`s (e.g. the real fs writes in persist()),
 *  making "still starting" assertions racy. */
function gatedFakeClient(gate: Promise<void>, events: AgentSdkEvent[]): AgentSdkClient {
  return {
    query() {
      return {
        async *[Symbol.asyncIterator]() {
          await gate;
          for (const e of events) yield e;
        },
      };
    },
    interrupt: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
}

/** A fake PtyFactory whose spawned handle is driven by the returned emit* functions. */
function fakePtyFactory(): {
  factory: PtyFactory;
  emitExit: (info: PtyExitInfo) => void;
} {
  const exitListeners = new Set<(info: PtyExitInfo) => void>();
  const handle: PtyHandle = {
    onData: () => () => undefined,
    onExit(cb) {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    write: () => undefined,
    kill: () => undefined,
  };
  const factory: PtyFactory = { spawn: () => handle };
  return {
    factory,
    emitExit: (info) => {
      for (const cb of exitListeners) cb(info);
    },
  };
}

async function readRegistryFile(dir: string): Promise<SessionRecord[]> {
  const raw = await readFile(join(dir, 'sessions.json'), 'utf8');
  return JSON.parse(raw) as SessionRecord[];
}

/** Poll the persisted registry until `predicate` is satisfied or `timeoutMs` elapses.
 *  sessionManager serializes writes onto a queue (see sessionManager.ts) so a burst of
 *  in-memory state changes lands on disk over a handful of real fs round-trips rather than
 *  instantly — the in-memory registry (`manager.list()`) is synchronous, but the file is
 *  not, so tests asserting on disk content after a burst need to wait for it to catch up
 *  rather than assume one microtask/macrotask tick is enough real I/O time.
 *
 *  The poll interval is deliberately not tight: a fast poll loop opens+reads the same file
 *  sessionManager is concurrently trying to rename over, and on Windows that read can
 *  itself make the production rename() transiently fail (EPERM) — a self-inflicted version
 *  of the exact contention renameWithRetry exists to tolerate. Spacing polls out gives the
 *  write its own quiet window instead of fighting it. */
async function waitForRegistry(
  dir: string,
  predicate: (records: SessionRecord[]) => boolean,
  timeoutMs = 2000,
): Promise<SessionRecord[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const records = await readRegistryFile(dir);
    if (predicate(records) || Date.now() > deadline) return records;
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
}

describe('createSessionManager', () => {
  it('spawnManaged persists a record and list()/get() reflect it immediately', async () => {
    const dir = await sandbox();
    const manager = createSessionManager({ stateDir: dir, now: () => 1000 });
    // Gated so the turn cannot complete during spawnManaged's own real fs awaits — without
    // this, an instantly-resolving fake client can race ahead of persist() and leave the
    // session already past 'starting' by the time this call returns.
    const gate = deferred<void>();
    const handle = await manager.spawnManaged({
      id: 'm1',
      client: gatedFakeClient(gate.promise, [{ type: 'turn_result', ok: true, summary: 'done' }]),
      prompt: 'go',
      cwd: '/work',
      accountId: 'acct-1',
    });

    expect(manager.get('m1')).toBe(handle);
    expect(manager.list()).toEqual([
      {
        id: 'm1',
        kind: 'managed',
        state: 'starting',
        startedAtMs: 1000,
        accountId: 'acct-1',
        cwd: '/work',
      },
    ]);

    const persisted = await readRegistryFile(dir);
    expect(persisted).toEqual(manager.list());

    // Deliberately never resolved: this test doesn't need the turn to finish, and letting
    // it finish would trigger another real fs write racing the sandbox's afterEach
    // cleanup. A permanently-pending promise here is inert — nothing is awaiting it once
    // the test returns, so it neither blocks completion nor leaks anything observable.
  });

  it('generates a random id when none is given', async () => {
    const dir = await sandbox();
    const manager = createSessionManager({ stateDir: dir });
    const handle = await manager.spawnManaged({
      client: fakeClient([{ type: 'turn_result', ok: true, summary: 'done' }]),
      prompt: 'go',
    });
    expect(handle.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(manager.get(handle.id)).toBe(handle);
  });

  it('mirrors status and summary events from a managed session into the record and disk', async () => {
    const dir = await sandbox();
    const manager = createSessionManager({ stateDir: dir, now: () => 2000 });
    await manager.spawnManaged({
      id: 'm1',
      client: fakeClient([
        { type: 'assistant_text', text: 'hi' },
        { type: 'turn_result', ok: true, summary: 'all done' },
      ]),
      prompt: 'go',
    });

    await tick(); // let the queued turn run to completion

    const record = manager.list().find((r) => r.id === 'm1');
    expect(record?.state).toBe('waiting_input');
    expect(record?.summary).toBe('Session complete: all done');

    const persisted = await waitForRegistry(
      dir,
      (list) => list.find((r) => r.id === 'm1')?.state === 'waiting_input',
    );
    expect(persisted.find((r) => r.id === 'm1')).toEqual(record);
  });

  it('attachObserved persists an observed record and mirrors exit state to disk', async () => {
    const dir = await sandbox();
    const manager = createSessionManager({ stateDir: dir, now: () => 3000 });
    const pty = fakePtyFactory();
    await manager.attachObserved({
      id: 'o1',
      ptyFactory: pty.factory,
      command: 'claude',
      cwd: '/work',
    });

    expect(manager.list()).toEqual([
      { id: 'o1', kind: 'observed', state: 'starting', startedAtMs: 3000, cwd: '/work' },
    ]);

    pty.emitExit({ exitCode: 0 });

    const record = manager.list().find((r) => r.id === 'o1');
    expect(record?.state).toBe('done');
    const persisted = await waitForRegistry(
      dir,
      (list) => list.find((r) => r.id === 'o1')?.state === 'done',
    );
    expect(persisted.find((r) => r.id === 'o1')?.state).toBe('done');
  });

  it('creates the state directory if it does not exist yet', async () => {
    const root = await sandbox();
    const dir = join(root, 'nested', 'state');
    const manager = createSessionManager({ stateDir: dir });
    await manager.spawnManaged({
      id: 'm1',
      client: fakeClient([{ type: 'turn_result', ok: true, summary: 'done' }]),
      prompt: 'go',
    });
    const persisted = await readRegistryFile(dir);
    expect(persisted).toHaveLength(1);
  });

  describe('recover', () => {
    it('marks a persisted non-terminal record with no live handle as orphaned', async () => {
      const dir = await sandbox();
      await mkdir(dir, { recursive: true });
      const stale: SessionRecord = {
        id: 'crashed-1',
        kind: 'managed',
        state: 'running',
        startedAtMs: 500,
      };
      await writeFile(join(dir, 'sessions.json'), JSON.stringify([stale]));

      const manager = createSessionManager({ stateDir: dir });
      const orphaned = await manager.recover();

      expect(orphaned).toEqual([{ ...stale, state: 'orphaned' }]);
      expect(manager.list()).toEqual([{ ...stale, state: 'orphaned' }]);
      const persisted = await readRegistryFile(dir);
      expect(persisted).toEqual([{ ...stale, state: 'orphaned' }]);
    });

    it('leaves terminal-state records alone', async () => {
      const dir = await sandbox();
      const done: SessionRecord = {
        id: 'done-1',
        kind: 'managed',
        state: 'done',
        startedAtMs: 500,
      };
      const failed: SessionRecord = {
        id: 'failed-1',
        kind: 'observed',
        state: 'failed',
        startedAtMs: 600,
      };
      await writeFile(join(dir, 'sessions.json'), JSON.stringify([done, failed]));

      const manager = createSessionManager({ stateDir: dir });
      const orphaned = await manager.recover();

      expect(orphaned).toEqual([]);
      expect(manager.list()).toEqual(expect.arrayContaining([done, failed]));
    });

    it('does not orphan a record that has a live handle in this process', async () => {
      const dir = await sandbox();
      const manager = createSessionManager({ stateDir: dir });
      // Gated so the session is still guaranteed non-terminal (mid-turn) when recover()
      // runs — what matters here is that recover() leaves it alone because a live handle
      // exists, not what its exact state happens to be.
      const gate = deferred<void>();
      await manager.spawnManaged({
        id: 'm1',
        client: gatedFakeClient(gate.promise, [{ type: 'turn_result', ok: true, summary: 'done' }]),
        prompt: 'go',
      });
      const stateBefore = manager.list().find((r) => r.id === 'm1')?.state;

      const orphaned = await manager.recover();

      expect(orphaned).toEqual([]);
      expect(manager.list().find((r) => r.id === 'm1')?.state).toBe(stateBefore);
      expect(stateBefore).not.toBe('orphaned');

      // Deliberately never resolved — see the equivalent note in the spawnManaged test above.
    });

    it('is idempotent — a second call finds nothing left to reconcile', async () => {
      const dir = await sandbox();
      const stale: SessionRecord = {
        id: 'crashed-1',
        kind: 'managed',
        state: 'running',
        startedAtMs: 500,
      };
      await writeFile(join(dir, 'sessions.json'), JSON.stringify([stale]));

      const manager = createSessionManager({ stateDir: dir });
      await manager.recover();
      const second = await manager.recover();

      expect(second).toEqual([]);
    });
  });
});
