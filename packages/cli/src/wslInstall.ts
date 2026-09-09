// WSL autostart: a WINDOWS logon Scheduled Task, registered from inside the distro.
//
// Nothing inside a WSL distro can autostart the daemon reliably: WSL stops a distro a few
// seconds after its last `wsl.exe` session ends, so a systemd user unit or a shell-profile job
// dies with it, and neither exists before someone opens a terminal. What does work is a task
// on the Windows side whose action is
//
//   wsl.exe -d <distro> --exec /bin/bash -lc "'<shim>' daemon run"
//
// It fires at Windows logon like the native task, its `wsl.exe` session keeps the distro alive
// for as long as the daemon runs, and Task Scheduler restarts it with the same settings. The
// login shell (`-l`) loads the user's profile so the daemon can spawn `claude` by name; the
// shim's own bin directory is pinned onto PATH as well, because the profile alone does not
// reliably reach an nvm-installed `node` (see `wslTaskAction`).
//
// Registration goes through Windows interop: the Windows PowerShell binary named by its
// `/mnt` path (a distro's PATH need not carry the Windows entries at all) running the very
// same scripts as the native backend in daemonInstall.ts. Only the action, the task name and
// the binary differ.

import { existsSync } from 'node:fs';
import { posix } from 'node:path';
import {
  DAEMON_TASK_ARGUMENTS,
  powerShellRunner,
  queryDaemonTask,
  registerLogonTask,
  startDaemonTaskNow,
  uninstallDaemonTask,
  type DaemonTaskOutcome,
  type DaemonTaskQuery,
  type DaemonUninstallOutcome,
  type LogonTaskAction,
  type PowerShellRunner,
} from './daemonInstall.js';

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Present (as a binfmt registration) exactly when WSL can launch Windows executables. */
export const WSL_INTEROP_FLAG = '/proc/sys/fs/binfmt_misc/WSLInterop';

/** Where WSL mounts the Windows system drive by default; PowerShell 5.1 ships with Windows at
 *  this fixed location. Checked before any PATH lookup so a stripped PATH still works. */
export const WSL_POWERSHELL_PATH = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';

export interface WslHost {
  /** The distro name `wsl.exe -d` wants — `WSL_DISTRO_NAME`, set for every process inside. */
  distro: string;
  /** Absolute path of the Windows PowerShell binary, or undefined when the Windows side is out
   *  of reach (interop disabled, or PowerShell not where WSL mounts it and not on PATH). */
  powerShell?: string;
}

export interface DetectWslOptions {
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
}

/** The WSL facts the backend needs, or undefined outside WSL. A distro whose Windows side is
 *  unreachable still reports its name, so the caller can say WHY there is no backend. */
export function detectWsl(options: DetectWslOptions = {}): WslHost | undefined {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const distro = env.WSL_DISTRO_NAME?.trim();
  if (!distro) return undefined;
  if (!exists(WSL_INTEROP_FLAG)) return { distro };
  // PATH inside a distro is colon-separated regardless of where this code's tests run.
  const pathCandidates = (env.PATH ?? '')
    .split(':')
    .filter((dir) => dir.length > 0)
    .map((dir) => posix.join(dir, 'powershell.exe'));
  const powerShell = [WSL_POWERSHELL_PATH, ...pathCandidates].find(exists);
  return powerShell ? { distro, powerShell } : { distro };
}

// ---------------------------------------------------------------------------
// Task identity and action
// ---------------------------------------------------------------------------

export const WSL_TASK_NAME_PREFIX = 'ClaudeControlDaemon-WSL-';

/** One task per distro, so two distros each running cctl coexist with each other and with a
 *  native Windows install. Characters Task Scheduler refuses in a name are replaced. */
export function wslTaskName(distro: string): string {
  return `${WSL_TASK_NAME_PREFIX}${distro.replace(/[\\/:*?"<>|]/g, '_')}`;
}

/** Quote one word for bash inside single quotes; an apostrophe uses the `'\''` idiom. */
function bashQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The task action. Task Scheduler hands `arguments` to `wsl.exe` as one Windows command line,
 * split by the usual Windows rules (double quotes group, single quotes do not), and everything
 * after `--exec` reaches the distro verbatim as argv — so the whole `bash -lc` script must be
 * ONE double-quoted Windows token. Inside it every path is single-quoted for bash, so spaces
 * survive the second split and an apostrophe rides bash's `'\''` idiom (the backslash is
 * literal to the Windows splitter, which only treats one before a double quote specially). A
 * double quote anywhere would end the Windows token early, so it is refused outright rather
 * than mis-quoted into a task that silently runs the wrong thing.
 *
 * The script pins the shim's own bin directory ahead of PATH before exec'ing the shim. The
 * login shell alone is not enough: on Linux the npm shim is a symlink to a `#!/usr/bin/env
 * node` script, and an nvm-installed `node` lives beside the shim but only reaches PATH from
 * `~/.bashrc` — which Ubuntu's stock profile exits early for non-interactive shells, before
 * nvm's lines at its end ever run. (`$PATH` is safe unquoted inside an `export` assignment:
 * bash gives it assignment semantics, no word splitting.)
 */
export function wslTaskAction(distro: string, shimPath: string): LogonTaskAction {
  if (shimPath.includes('"') || distro.includes('"')) {
    throw new Error(
      `cannot build a wsl.exe command line for a path or distro name containing a double quote: ${shimPath.includes('"') ? shimPath : distro}`,
    );
  }
  const binDir = posix.dirname(shimPath);
  const bashScript =
    `export PATH=${bashQuote(binDir)}:$PATH; ` +
    `exec ${bashQuote(shimPath)} ${DAEMON_TASK_ARGUMENTS}`;
  const distroArg = /\s/.test(distro) ? `"${distro}"` : distro;
  return {
    execute: 'wsl.exe',
    arguments: `-d ${distroArg} --exec /bin/bash -lc "${bashScript}"`,
  };
}

function wslTaskDescription(distro: string): string {
  return `claude-control daemon in WSL distro ${distro} (managed by cctl; see: cctl daemon uninstall)`;
}

// ---------------------------------------------------------------------------
// Lifecycle — thin wrappers over the shared Scheduled Task mechanics
// ---------------------------------------------------------------------------

export interface WslTaskOptions {
  host: WslHost;
  /** Injected for tests; production runs the distro's Windows PowerShell by absolute path. */
  run?: PowerShellRunner;
}

function runnerFor(options: WslTaskOptions): PowerShellRunner {
  if (options.run) return options.run;
  if (!options.host.powerShell) {
    throw new Error(
      'Windows PowerShell is not reachable from this distro (WSL interop is off, or ' +
        `${WSL_POWERSHELL_PATH} is missing), so the logon task cannot be registered from here`,
    );
  }
  return powerShellRunner(options.host.powerShell);
}

export function installWslDaemonTask(
  options: WslTaskOptions & { shimPath: string },
): DaemonTaskOutcome {
  const { distro } = options.host;
  return registerLogonTask({
    action: wslTaskAction(distro, options.shimPath),
    taskName: wslTaskName(distro),
    description: wslTaskDescription(distro),
    run: runnerFor(options),
  });
}

export function startWslDaemonTaskNow(options: WslTaskOptions): void {
  startDaemonTaskNow(runnerFor(options), wslTaskName(options.host.distro));
}

export function queryWslDaemonTask(options: WslTaskOptions): DaemonTaskQuery {
  return queryDaemonTask(runnerFor(options), wslTaskName(options.host.distro));
}

export function uninstallWslDaemonTask(options: WslTaskOptions): DaemonUninstallOutcome {
  return uninstallDaemonTask(runnerFor(options), wslTaskName(options.host.distro));
}
