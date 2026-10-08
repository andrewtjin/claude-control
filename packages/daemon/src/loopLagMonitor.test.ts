import { describe, expect, it, vi } from 'vitest';
import { startLoopLagMonitor } from './loopLagMonitor.js';

/** Block the event loop synchronously for ~ms — the exact pathology the monitor exists to
 *  catch (a sync child-process wait, a huge JSON.parse, a sync fs call). */
function blockLoop(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // spin
  }
}

describe('startLoopLagMonitor', () => {
  it('reports a synchronous stall with roughly its duration', async () => {
    const stalls: number[] = [];
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 50,
      thresholdMs: 100,
    });
    try {
      // Let the timer establish its cadence, then block well past the threshold.
      await new Promise((resolve) => setTimeout(resolve, 120));
      blockLoop(300);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(stalls.length).toBeGreaterThanOrEqual(1);
      // Drift ≈ block duration (minus up to one interval); assert the right magnitude.
      expect(Math.max(...stalls)).toBeGreaterThanOrEqual(150);
    } finally {
      stop();
    }
  });

  it('by default, reports a block shorter than half a second', async () => {
    // With a 500ms tick, a block that started just after a tick and ended before the next one
    // never delayed it; a 589ms WAL checkpoint went unreported that way.
    const stalls: number[] = [];
    // No floor, so a scheduling stall on a loaded box before the block can't use up the one
    // report and hide it; only the default interval is under test.
    const stop = startLoopLagMonitor({ onStall: (lagMs) => stalls.push(lagMs), reportFloorMs: 0 });
    try {
      // Block soon after a tick, ending well before a 500ms tick would be due.
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(400);
      await new Promise((resolve) => setTimeout(resolve, 700));
      // At least the block minus one default interval (100ms), with a margin for the
      // millisecond clock the block spins on.
      expect(Math.max(0, ...stalls)).toBeGreaterThanOrEqual(290);
    } finally {
      stop();
    }
  });

  it('ignores wall-clock steps: an idle loop whose clock jumps forward is not a stall', async () => {
    // Live on WSL2: two time services corrected the VM clock, which stepped about +2s every
    // ~34s while the daemon sat idle in epoll_wait, and every step was logged as a 2s stall.
    const stalls: number[] = [];
    let offsetMs = 0;
    const realNow = Date.now.bind(Date);
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offsetMs);
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 50,
      thresholdMs: 100,
    });
    try {
      for (let i = 0; i < 4; i++) {
        await new Promise((resolve) => setTimeout(resolve, 80));
        offsetMs += 2_000;
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(stalls).toEqual([]);
    } finally {
      stop();
      nowSpy.mockRestore();
    }
  });

  it('reports a stall in the first moments of the process (monotonic clock starts near 0)', async () => {
    const stalls: number[] = [];
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 50,
      thresholdMs: 100,
      // A clock that has only just started, as performance.now() has in a fresh daemon.
      clock: (() => {
        const base = performance.now();
        return () => performance.now() - base;
      })(),
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(300);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(stalls.length).toBeGreaterThanOrEqual(1);
    } finally {
      stop();
    }
  });

  it('stays silent on a healthy loop', async () => {
    const stalls: number[] = [];
    // Generous threshold: under full-suite parallel load the test worker's own loop can
    // legitimately stall for tens of ms, which is exactly what the monitor exists to report —
    // this test only proves an UNBLOCKED loop produces no reports, so give scheduling noise
    // room without weakening that claim.
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 50,
      thresholdMs: 1_000,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(stalls).toEqual([]);
    } finally {
      stop();
    }
  });

  it('inside the floor, still reports a stall at least twice the largest one so far', async () => {
    // A short stall used to spend the floor and hide a multi-second one right behind it.
    const stalls: number[] = [];
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 25,
      thresholdMs: 60,
      reportFloorMs: 60_000,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(120);
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(600);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalls.length).toBe(2);
      expect(stalls[1]).toBeGreaterThanOrEqual(500);
    } finally {
      stop();
    }
  });

  it('floors repeated reports during a sustained stall (heartbeat, not flood)', async () => {
    const stalls: number[] = [];
    const stop = startLoopLagMonitor({
      onStall: (lagMs) => stalls.push(lagMs),
      intervalMs: 25,
      thresholdMs: 60,
      reportFloorMs: 60_000, // one report allowed in this test's lifetime
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(150);
      await new Promise((resolve) => setTimeout(resolve, 60));
      blockLoop(150);
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(stalls.length).toBe(1);
    } finally {
      stop();
    }
  });
});
