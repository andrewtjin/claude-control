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
// late by however much of the block fell after it was due. A block that starts just after a
// tick shows up as its length minus one interval, so a block shorter than
// `thresholdMs + intervalMs` can go unreported, and the interval is kept short for that reason:
// at 500ms, a 589ms WAL checkpoint went unreported. (`monitorEventLoopDelay` is no better:
// resetting its histogram also forgets its last sample, so a block right after each read is
// lost.)
//
// Drift is measured on a MONOTONIC clock. The wall clock can step: on WSL2 the Hyper-V time
// sync and systemd-timesyncd both correct the VM clock, and every forward step read as a
// stall of the step's size (about 2s every ~34s on one box, thousands of phantom stalls a day
// while the loop sat idle).

/** Options for {@link startLoopLagMonitor}. All injectable for tests. */
export interface LoopLagMonitorOptions {
  /** Called with the observed stall length whenever drift exceeds the threshold. */
  onStall: (lagMs: number) => void;
  /** Drift above this is a stall worth reporting. Defaults to {@link LOOP_LAG_THRESHOLD_MS}. */
  thresholdMs?: number;
  /** Probe cadence. Default 50ms: every block longer than `thresholdMs + intervalMs` is
   *  reported, as at least its length minus one interval. The idle cost is one timer tick per
   *  interval. */
  intervalMs?: number;
  /** Floor between reports so a sustained stall logs a heartbeat, not a flood. Default 10s. */
  reportFloorMs?: number;
  /** Must be monotonic (never steps); a wall clock turns every clock correction into a
   *  reported stall. Default `performance.now()`. */
  clock?: () => number;
}

/**
 * What counts as a stall, in milliseconds of drift. Comfortably above timer jitter and GC pauses,
 * well below the multi-second stalls that tax hook latency.
 *
 * Exported because the poll cycle's own per-phase timing warns at the same bar (see
 * `POLL_PHASE_BLOCK_MS` in daemon.ts). One number, so a phase can never be "slow" by one
 * definition and fine by the other — which is exactly the confusion that makes an attributed
 * stall hard to read.
 */
export const LOOP_LAG_THRESHOLD_MS = 150;
const DEFAULT_INTERVAL_MS = 50;
const DEFAULT_REPORT_FLOOR_MS = 10_000;

/**
 * Start watching the event loop for stalls. Returns a stop function. The timer is unref'd:
 * a monitor must never keep the process alive on its own.
 */
export function startLoopLagMonitor(options: LoopLagMonitorOptions): () => void {
  const thresholdMs = options.thresholdMs ?? LOOP_LAG_THRESHOLD_MS;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const reportFloorMs = options.reportFloorMs ?? DEFAULT_REPORT_FLOOR_MS;
  const clock = options.clock ?? (() => performance.now());

  let lastTickAt = clock();
  // Not 0: a monotonic clock counts from process start, and a stall in the first
  // `reportFloorMs` of the process must still be reported.
  let lastReportAt = Number.NEGATIVE_INFINITY;
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
