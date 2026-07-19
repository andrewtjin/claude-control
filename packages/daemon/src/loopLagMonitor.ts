// Event-loop lag watchdog.
//
// The daemon's hook receiver shares one event loop with everything else in the process, so
// any synchronous work anywhere re-couples hook latency (which every Claude Code session on
// the machine pays, per tool call) to that work. The DPAPI-via-execFileSync starvation that
// motivated this file was invisible for weeks precisely because nothing measured the loop:
// hooks were slow, but no log said WHY. This monitor makes the class of regression visible —
// any future change that blocks the loop past the threshold produces a warning naming the
// stall's duration, so "hooks feel slow" becomes a grep instead of a forensic hunt.
//
// Detection is timer drift: a repeating interval that should fire every `intervalMs` fires
// late by exactly however long the loop was blocked. Cheap (one timer, no sampling
// machinery), and the drift measurement IS the stall duration.

/** Options for {@link startLoopLagMonitor}. All injectable for tests. */
export interface LoopLagMonitorOptions {
  /** Called with the observed stall length whenever drift exceeds the threshold. */
  onStall: (lagMs: number) => void;
  /** Drift above this is a stall worth reporting. Default 150ms — comfortably above timer
   *  jitter and GC pauses, well below the multi-second stalls that tax hook latency. */
  thresholdMs?: number;
  /** Probe cadence. Default 500ms — a stall shorter than this can still be caught (drift is
   *  measured against the wall clock), and the idle cost is one timer tick per interval. */
  intervalMs?: number;
  /** Floor between reports so a sustained stall logs a heartbeat, not a flood. Default 10s. */
  reportFloorMs?: number;
  clock?: () => number;
}

const DEFAULT_THRESHOLD_MS = 150;
const DEFAULT_INTERVAL_MS = 500;
const DEFAULT_REPORT_FLOOR_MS = 10_000;

/**
 * Start watching the event loop for stalls. Returns a stop function. The timer is unref'd:
 * a monitor must never keep the process alive on its own.
 */
export function startLoopLagMonitor(options: LoopLagMonitorOptions): () => void {
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reportFloorMs = options.reportFloorMs ?? DEFAULT_REPORT_FLOOR_MS;
  const clock = options.clock ?? Date.now;

  let lastTickAt = clock();
  let lastReportAt = 0;
  const timer = setInterval(() => {
    const now = clock();
    const lagMs = now - lastTickAt - intervalMs;
    lastTickAt = now;
    if (lagMs > thresholdMs && now - lastReportAt >= reportFloorMs) {
      lastReportAt = now;
      options.onStall(lagMs);
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
