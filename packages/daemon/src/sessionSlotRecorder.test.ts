// SessionSlotRecorder tests. The store and the slot resolver are fakes: what is under test is WHEN
// the recorder resolves and writes (once per session + config dir, retried after a failure, again
// after a change) and WHAT time it stamps, not sqlite or the switch engine.

import { describe, it, expect } from 'vitest';
import { SessionSlotRecorder, type SlotForConfigDir } from './sessionSlotRecorder.js';

/** Let every pending promise callback run. The recorder's work is detached from `observe`. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** A resolver whose answers the test releases by hand, so ordering and clock reads are explicit. */
function manualResolver() {
  const calls: {
    configDir: string | null;
    resolve: (slot: string) => void;
    reject: (err: Error) => void;
  }[] = [];
  const slotForConfigDir: SlotForConfigDir = (configDir) =>
    new Promise<string>((resolve, reject) => {
      calls.push({ configDir, resolve, reject });
    });
  return { calls, slotForConfigDir };
}

/** A recorder over a recording fake store, a settable clock and a capturing logger. */
function harness(options: { slotForConfigDir?: SlotForConfigDir; maxTracked?: number } = {}) {
  const writes: { sessionId: string; slot: string; atMs: number }[] = [];
  const warns: unknown[] = [];
  let now = 1000;
  let storeThrows = false;
  const resolverCalls: (string | null)[] = [];
  const slotForConfigDir: SlotForConfigDir =
    options.slotForConfigDir ??
    ((configDir) => {
      resolverCalls.push(configDir);
      return Promise.resolve(configDir === null ? 'global' : `group:${configDir}`);
    });
  const recorder = new SessionSlotRecorder({
    store: {
      recordSessionSlot: (sessionId, slot, atMs) => {
        if (storeThrows) throw new Error('database is locked');
        writes.push({ sessionId, slot, atMs });
        return true;
      },
    },
    slotForConfigDir,
    clock: () => now,
    logger: { warn: (obj) => warns.push(obj) },
    ...(options.maxTracked !== undefined ? { maxTracked: options.maxTracked } : {}),
  });
  return {
    recorder,
    writes,
    warns,
    resolverCalls,
    setNow: (ms: number) => {
      now = ms;
    },
    setStoreThrows: (value: boolean) => {
      storeThrows = value;
    },
  };
}

describe('SessionSlotRecorder', () => {
  it('resolves and records a new session once, however many events it sends', async () => {
    const h = harness();
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.resolverCalls).toEqual(['g1']);
    expect(h.writes).toEqual([{ sessionId: 's1', slot: 'group:g1', atMs: 1000 }]);
  });

  it('resolves a burst of events from a new session once, before the first resolve finishes', async () => {
    const manual = manualResolver();
    const h = harness({ slotForConfigDir: manual.slotForConfigDir });
    // Three events arrive while the first resolve is still in flight: the claim is taken
    // synchronously, so none of the later ones starts a second resolve.
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    expect(manual.calls).toHaveLength(1);
    manual.calls[0]?.resolve('group:g1');
    await flush();
    expect(h.writes).toHaveLength(1);
  });

  it('stamps the span with the time the event ARRIVED, not when the resolve finished', async () => {
    const manual = manualResolver();
    const h = harness({ slotForConfigDir: manual.slotForConfigDir });
    h.setNow(5000);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    // The resolve is slow; the clock moves on before it answers.
    h.setNow(9000);
    manual.calls[0]?.resolve('group:g1');
    await flush();
    expect(h.writes).toEqual([{ sessionId: 's1', slot: 'group:g1', atMs: 5000 }]);
  });

  it('returns immediately, before the slot is resolved', () => {
    const manual = manualResolver();
    const h = harness({ slotForConfigDir: manual.slotForConfigDir });
    // Nothing may hold up the hook: observe hands back control with the resolve still pending.
    expect(h.recorder.observe({ sessionId: 's1', configDir: 'g1' })).toBeUndefined();
    expect(h.writes).toEqual([]);
  });

  it('passes the shared config dir through as null', async () => {
    const h = harness();
    h.recorder.observe({ sessionId: 's1', configDir: null });
    await flush();
    expect(h.resolverCalls).toEqual([null]);
    expect(h.writes).toEqual([{ sessionId: 's1', slot: 'global', atMs: 1000 }]);
  });

  it('records again when the same session reports a different config dir', async () => {
    // `claude --resume` from another profile keeps the session id: a new run, a new slot.
    const h = harness();
    h.recorder.observe({ sessionId: 's1', configDir: null });
    await flush();
    h.setNow(2000);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.writes).toEqual([
      { sessionId: 's1', slot: 'global', atMs: 1000 },
      { sessionId: 's1', slot: 'group:g1', atMs: 2000 },
    ]);
  });

  it('treats a null config dir and a named one as different, in both directions', async () => {
    const h = harness();
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's1', configDir: null });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.resolverCalls).toEqual(['g1', null, 'g1']);
  });

  it('forgets a failed resolve, so the next event of the session retries it', async () => {
    let fail = true;
    const calls: (string | null)[] = [];
    const h = harness({
      slotForConfigDir: (configDir) => {
        calls.push(configDir);
        return fail
          ? Promise.reject(new Error('groups.json unreadable'))
          : Promise.resolve('group:g1');
      },
    });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.writes).toEqual([]);
    // Logged, never thrown: attribution is observability only.
    expect(h.warns).toHaveLength(1);
    expect(h.warns[0]).toMatchObject({ sessionId: 's1' });

    fail = false;
    h.setNow(2000);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(calls).toEqual(['g1', 'g1']);
    expect(h.writes).toEqual([{ sessionId: 's1', slot: 'group:g1', atMs: 2000 }]);
  });

  it("does not let a stale failure erase a newer config dir's claim", async () => {
    const manual = manualResolver();
    const h = harness({ slotForConfigDir: manual.slotForConfigDir });
    h.recorder.observe({ sessionId: 's1', configDir: 'old' });
    h.recorder.observe({ sessionId: 's1', configDir: 'new' });
    manual.calls[1]?.resolve('group:new');
    // The OLD resolve fails after the session already moved on: only its own claim may be dropped.
    manual.calls[0]?.reject(new Error('boom'));
    await flush();
    h.recorder.observe({ sessionId: 's1', configDir: 'new' });
    expect(manual.calls).toHaveLength(2);
    expect(h.writes.map((w) => w.slot)).toEqual(['group:new']);
  });

  it('treats a failing store write like a failed resolve: logged, forgotten, retried', async () => {
    const h = harness();
    h.setStoreThrows(true);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.warns).toHaveLength(1);

    h.setStoreThrows(false);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    await flush();
    expect(h.resolverCalls).toEqual(['g1', 'g1']);
    expect(h.writes).toHaveLength(1);
  });

  it('bounds memory: past maxTracked the oldest session is forgotten and resolves again', async () => {
    const h = harness({ maxTracked: 2 });
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's2', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's3', configDir: 'g1' });
    await flush();
    expect(h.resolverCalls).toHaveLength(3);
    // s3 and s2 are still remembered; s1 was evicted, so its next event costs one more resolve.
    h.recorder.observe({ sessionId: 's3', configDir: 'g1' });
    h.recorder.observe({ sessionId: 's2', configDir: 'g1' });
    expect(h.resolverCalls).toHaveLength(3);
    h.recorder.observe({ sessionId: 's1', configDir: 'g1' });
    expect(h.resolverCalls).toHaveLength(4);
  });

  it('counts a config dir change as recent use when choosing what to evict', async () => {
    const h = harness({ maxTracked: 2 });
    h.recorder.observe({ sessionId: 's1', configDir: 'a' });
    h.recorder.observe({ sessionId: 's2', configDir: 'a' });
    // s1 changes dir: it becomes the most recently claimed, so s2 is now the oldest.
    h.recorder.observe({ sessionId: 's1', configDir: 'b' });
    h.recorder.observe({ sessionId: 's3', configDir: 'a' });
    await flush();
    const before = h.resolverCalls.length;
    h.recorder.observe({ sessionId: 's1', configDir: 'b' });
    expect(h.resolverCalls).toHaveLength(before);
    h.recorder.observe({ sessionId: 's2', configDir: 'a' });
    expect(h.resolverCalls).toHaveLength(before + 1);
  });
});
