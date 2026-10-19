// The background workers of a parallel session's profile, as the session's holders: what keeps a
// parallel session from being ended while its profile's background service still hosts a session
// (see the engine's releaseLease and sweepLeases). Built on the background host `cctl claude` and the
// daemon already share, so both read a roster the same way. Shared by the CLI and the daemon.

import { hostname } from 'node:os';
import {
  linuxTags,
  procFs as realProcFs,
  windowsStartMs,
  type LeaseHolder,
  type LeaseOccupancyProbe,
  type ProcFs,
} from '@claude-control/switch-engine';
import type { ClaudeBackgroundHost } from './backgroundHost.js';

/** What the probe needs besides the host; each defaults to this machine. */
export interface LeaseProbeDeps {
  platform?: NodeJS.Platform;
  hostname?: () => string;
  procFs?: ProcFs;
}

/**
 * A {@link LeaseOccupancyProbe} over a background host: every worker its roster lists (verified when
 * asked) becomes a `background` holder on this machine, its start read the way a holder records one
 * (Windows: the FILETIME Claude Code recorded, as epoch ms; Linux: `/proc` boot ticks). A start that
 * cannot be read is 0, which keeps the session (unverifiable counts as alive). A roster that cannot
 * be read answers `'unreadable'`, which never ends a session.
 *
 * On Linux the roster is always verified, even when the caller asks only for the file: the start a
 * holder records there is read from `/proc` now, so a roster entry whose pid another process took
 * over (a service that died and left its roster) would become a holder matching that unrelated
 * process exactly, and keep the session for as long as it runs. Verifying there is a `ps` call, not
 * the PowerShell query the file-only read spares Windows.
 */
export function createLeaseOccupancyProbe(
  host: Pick<ClaudeBackgroundHost, 'hostedWorkerProcesses'>,
  deps: LeaseProbeDeps = {},
): LeaseOccupancyProbe {
  const platform = deps.platform ?? process.platform;
  const host_ = deps.hostname ?? hostname;
  const fs = deps.procFs ?? realProcFs;
  return async (profileDir, opts) => {
    let workers: Array<{ pid: number; procStart?: string }>;
    try {
      workers = await host.hostedWorkerProcesses(
        profileDir,
        platform === 'linux' ? { ...opts, verify: true } : opts,
      );
    } catch {
      return 'unreadable';
    }
    if (platform !== 'win32' && platform !== 'linux') return [];
    return workers.map((w): LeaseHolder => {
      if (platform === 'win32') {
        const start = w.procStart === undefined ? undefined : windowsStartMs(w.procStart);
        return { pid: w.pid, start: start ?? 0, host: host_(), platform, role: 'background' };
      }
      return {
        pid: w.pid,
        start: fs.stat(w.pid)?.startTicks ?? 0,
        host: host_(),
        platform,
        role: 'background',
        ...linuxTags(fs),
      };
    });
  };
}
