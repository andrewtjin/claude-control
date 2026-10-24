// The CLI side of parallel sessions outside `cctl claude`: the checks a command runs before a
// parallel session may block it, and how a session's terminals are counted for display.
//
// A parallel session whose processes are gone is ended by the daemon at its next check. With no daemon
// running, nothing else would end it, so every command a parallel session can refuse (`cctl switch`,
// `cctl accounts remove`, `cctl folder exclude`, `cctl session exclude`, a join by `cctl claude
// --account`) first runs the full check on that one session: the user is already blocked there, so
// the process query it costs is acceptable.

import {
  childHolder,
  isLeaseRule,
  leaseOccupants,
  occupantsPhrase,
  type FolderRule,
  type LeaseHolder,
  type LeaseOccupancyProbe,
  type LeaseView,
  type Paths,
} from '@claude-control/switch-engine';
import { backgroundHostOptions, createClaudeBackgroundHost } from './backgroundHost.js';
import type { buildEngine } from './context.js';
import { createLeaseOccupancyProbe } from './leaseProbe.js';

type Engine = ReturnType<typeof buildEngine>;

/** The probe this process reads a parallel session's background workers with: the background host
 *  `cctl claude` reads, built the way the daemon builds its own. None on macOS, where parallel
 *  sessions do not exist. */
export function cliLeaseProbe(paths: Paths): LeaseOccupancyProbe | undefined {
  if (process.platform === 'darwin') return undefined;
  return createLeaseOccupancyProbe(createClaudeBackgroundHost(backgroundHostOptions(paths)));
}

/** The probe of a platform with no parallel sessions: nothing hosted. */
const NO_WORKERS: LeaseOccupancyProbe = () => Promise.resolve([]);

/**
 * Before a command an account's parallel session would block: end the parallel sessions whose
 * processes are gone. A quick check of every session (on Windows a process query only when one has
 * no holder left), then, when `accountId` has one, the full check of that one. Costs one rules read
 * when no parallel session exists. A check that fails is not the command's failure: the session's
 * own refusal follows.
 */
export async function sweepBeforeLeaseRefusal(
  engine: Engine,
  paths: Paths,
  accountId: string,
): Promise<void> {
  const rules = await engine.listRules().catch(() => [] as FolderRule[]);
  const leases = rules.filter(isLeaseRule);
  if (leases.length === 0) return;
  const probe = cliLeaseProbe(paths) ?? NO_WORKERS;
  await engine.sweepLeases({ mode: 'quick', probe }).catch(() => undefined);
  if (leases.some((r) => r.include[0] === accountId)) {
    await engine.sweepLeases({ mode: 'full', only: accountId, probe }).catch(() => undefined);
  }
}

/** What a parallel session is in use by right now, as `cctl status` and `cctl accounts list` say
 *  it: its running terminals and background sessions (a quick judgment of its holders), or, when
 *  none of its recorded processes runs any more, that it ends at the next check. */
export function leaseInUse(view: Pick<LeaseView, 'holders'>): { phrase: string; running: boolean } {
  const running = view.holders.filter((h) => h.state !== 'dead');
  if (running.length === 0) {
    return { phrase: 'no process of it runs; it ends at the next check', running: false };
  }
  return { phrase: occupantsPhrase(leaseOccupants(running)), running: true };
}

/** The minimal signal seam, so holding signals is testable without signalling the test runner. */
export interface LeaseSignalSeam {
  on(signal: NodeJS.Signals, handler: () => void): void;
  off(signal: NodeJS.Signals, handler: () => void): void;
}

/**
 * Hold the signals that would end this process while a parallel session is claimed or released:
 * Ctrl-C, and on Windows Ctrl-Break and a closing console (SIGHUP, which Windows follows with a
 * short grace before ending the process). Claude Code's own launch holds Ctrl-C only while it runs;
 * these outlive it, so an extra Ctrl-C after it exits, or closing the tab, does not end this process
 * between adopting the session's login and clearing it. Linux keeps its default SIGHUP: a write to a
 * hung-up terminal could fault, and the daemon's sweep recovers a release cut off there.
 */
export function holdLeaseSignals(
  seam: LeaseSignalSeam = process,
  platform: NodeJS.Platform = process.platform,
): { release: () => void } {
  const ignore = (): void => {
    // Intentionally empty: the claim or the release finishes first.
  };
  const held: NodeJS.Signals[] =
    platform === 'win32' ? ['SIGINT', 'SIGBREAK', 'SIGHUP'] : ['SIGINT'];
  for (const sig of held) seam.on(sig, ignore);
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      for (const sig of held) seam.off(sig, ignore);
    },
  };
}

/** The retry delays of recording a Claude Code holder: quickly at first, then every 15 s. */
const CHILD_RETRY_MS = [1_000, 2_000, 4_000];
const CHILD_RETRY_STEADY_MS = 15_000;

/**
 * Record the Claude Code a parallel session's launcher starts as one of its holders, without holding
 * up the launch: the record waits on the credential lock, which another process may hold for seconds.
 * Built synchronously from the spawn (see childHolder), then added in the background; a failure says
 * so once and retries while the child runs (1 s, 2 s, 4 s, then every 15 s). `stop` (the child
 * exited) ends the retries at once; `settled` is what the release awaits, so a child that exits fast
 * is never recorded after its own release.
 */
export function trackChildHolder(opts: {
  add: (holders: LeaseHolder[]) => Promise<void>;
  say: (line: string) => void;
  /** The account's name, or how to read it when the warning is printed (it can be renamed while
   *  the session runs, and the command the warning suggests must resolve). */
  label: string | (() => Promise<string>);
  /** The holder of a just-spawned pid (default: childHolder of this process). */
  holderOf?: (pid: number) => LeaseHolder;
  /** Waits between attempts; resolves early when `wake` is called (default: a real timer). */
  sleep?: (ms: number, wake: { on: (fn: () => void) => void }) => Promise<void>;
}): {
  record: (pid: number) => void;
  stop: () => void;
  settled: () => Promise<void>;
  holders: () => LeaseHolder[];
} {
  const holderOf = opts.holderOf ?? ((pid: number) => childHolder(pid, process.pid));
  let holder: LeaseHolder | undefined;
  let pending: Promise<void> = Promise.resolve();
  let running = true;
  let warned = false;
  const wakers: Array<() => void> = [];
  const sleep =
    opts.sleep ??
    ((ms: number, wake: { on: (fn: () => void) => void }) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        wake.on(() => {
          clearTimeout(timer);
          resolve();
        });
      }));
  const attempt = async (h: LeaseHolder): Promise<void> => {
    for (let n = 0; ; n += 1) {
      try {
        await opts.add([h]);
        return;
      } catch (err) {
        if (!warned) {
          warned = true;
          const reason = err instanceof Error ? err.message : String(err);
          const label = typeof opts.label === 'string' ? opts.label : await opts.label();
          opts.say(
            `cctl: warning: could not record this session's Claude Code process yet (${reason}); ` +
              `retrying. If this terminal's cctl is killed first, ${label} stays reserved ` +
              "until a full check finds that process: the daemon's next poll, or the next cctl " +
              `switch ${label}.`,
          );
        }
        if (!running) return;
        await sleep(CHILD_RETRY_MS[n] ?? CHILD_RETRY_STEADY_MS, { on: (fn) => wakers.push(fn) });
        if (!running) return;
      }
    }
  };
  return {
    record(pid) {
      holder = holderOf(pid);
      pending = attempt(holder);
    },
    stop() {
      running = false;
      for (const wake of wakers.splice(0)) wake();
    },
    settled: () => pending,
    holders: () => (holder === undefined ? [] : [holder]),
  };
}
