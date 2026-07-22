import { describe, expect, it } from 'vitest';
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
