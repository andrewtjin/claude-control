// The background workers of a parallel session's profile, as the session's holders: what keeps a
// parallel session from being ended while its profile's background service still hosts a session
// (see the engine's releaseLease and sweepLeases). Built on the background host `cctl claude` and the
// daemon already share, so both read a roster the same way. Shared by the CLI and the daemon.

import { hostname } from 'node:os';
import { sameConfigDir } from '@claude-control/daemon';
import {
  isExitedState,
  linuxTags,
  procFs as realProcFs,
  readProcessStarts,
  windowsStartMs,
  type LeaseHolder,
  type LeaseOccupancyProbe,
  type ProcFs,
} from '@claude-control/switch-engine';
import { sameProcessStart, type ClaudeBackgroundHost } from './backgroundHost.js';

/** What the probe needs besides the host; each defaults to this machine. */
export interface LeaseProbeDeps {
  platform?: NodeJS.Platform;
  hostname?: () => string;
  procFs?: ProcFs;
  /** Linux: processes' start times as `ps -o lstart` prints them, read fresh on every call (default
   *  `readProcessStarts`); a pid missing from the answer could not be read. */
  readStarts?: (pids: readonly number[]) => Promise<Map<number, string>>;
}

/**
 * A {@link LeaseOccupancyProbe} over a background host: every worker its roster lists becomes a
 * `background` holder on this machine, its start read the way a holder records one. A roster that
 * cannot be read answers `'unreadable'`, which never ends a session.
 *
 * Windows: each listed worker (verified when asked), its start the FILETIME Claude Code recorded, as
 * epoch ms; one that cannot be read is 0, which keeps the session (unverifiable counts as alive).
 *
 * Linux: a holder's start there is the `/proc` start of whatever runs on that pid now, so a worker
 * becomes a holder only once it is proven to be the worker the roster names; a holder taken from
 * anything less would match an unrelated process that took over the pid exactly, and keep the
 * session for as long as that runs. Proof is one of: its environment names this profile (a worker
 * of this profile's service inherits its CLAUDE_CONFIG_DIR), or the start Claude Code recorded for
 * it equals the one `ps` reports now, read fresh here (never a cached read, which can predate a pid
 * being reused). A worker that has exited but was not reaped yet is gone. A worker with no recorded
 * start and an environment that does not name the profile is not proven, so it is not a holder. One
 * whose start `ps` could not read leaves the question open: the probe answers `'unreadable'`.
 */
export function createLeaseOccupancyProbe(
  host: Pick<ClaudeBackgroundHost, 'hostedWorkerProcesses'>,
  deps: LeaseProbeDeps = {},
): LeaseOccupancyProbe {
  const platform = deps.platform ?? process.platform;
  const host_ = deps.hostname ?? hostname;
  const fs = deps.procFs ?? realProcFs;
  const readStarts = deps.readStarts ?? readProcessStarts('linux');
  return async (profileDir, opts) => {
    let workers: Array<{ pid: number; procStart?: string }>;
    try {
      // Linux proves each worker below, so the host's own check is not asked for there.
      workers = await host.hostedWorkerProcesses(
        profileDir,
        platform === 'linux' ? { ...opts, verify: false } : opts,
      );
    } catch {
      return 'unreadable';
    }
    if (platform === 'win32') {
      return workers.map((w): LeaseHolder => {
        const start = w.procStart === undefined ? undefined : windowsStartMs(w.procStart);
        return { pid: w.pid, start: start ?? 0, host: host_(), platform, role: 'background' };
      });
    }
    if (platform !== 'linux') return [];
    const running = workers.filter((w) => {
      const stat = fs.stat(w.pid);
      return stat !== undefined && !isExitedState(stat.state);
    });
    const byEnvironment = running.filter((w) => {
      const dir = fs.configDirOf(w.pid);
      return dir !== undefined && sameConfigDir(dir, profileDir, platform);
    });
    const toCheck = running.filter((w) => !byEnvironment.includes(w) && w.procStart !== undefined);
    let starts = new Map<number, string>();
    if (toCheck.length > 0) {
      starts = await readStarts(toCheck.map((w) => w.pid)).catch(() => new Map<number, string>());
      if (toCheck.some((w) => !starts.has(w.pid))) return 'unreadable';
    }
    const byStart = toCheck.filter((w) =>
      sameProcessStart(w.procStart!, starts.get(w.pid), platform),
    );
    const holders: LeaseHolder[] = [];
    for (const w of running) {
      if (!byEnvironment.includes(w) && !byStart.includes(w)) continue;
      // Read again: one that exited since it was proven is not recorded at all.
      const stat = fs.stat(w.pid);
      if (stat === undefined || isExitedState(stat.state)) continue;
      holders.push({
        pid: w.pid,
        start: stat.startTicks,
        host: host_(),
        platform,
        role: 'background',
        ...linuxTags(fs),
      });
    }
    return holders;
  };
}
