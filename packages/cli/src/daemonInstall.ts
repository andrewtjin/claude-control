// Windows Scheduled Task lifecycle for `cctl daemon install|uninstall`.
//
// A logon-triggered Scheduled Task is how the daemon autostarts without a login shell staying
// open: DPAPI vault access is CurrentUser-scoped, so the daemon must run as the logged-in
// user, which rules out a Windows service (services run as SYSTEM/a service account by
// default). Every PowerShell invocation goes through one injected runner so this module's
// logic — what gets asked for, in what order, only when something actually needs to change —
// is unit-tested without ever touching a real Task Scheduler.
//
// Idempotent by construction: `installDaemonTask` always queries the current registration
// first and only calls `Register-ScheduledTask` when the resolved action differs from what's
// already there, so a repeated `cctl daemon install` (e.g. re-entering the setup wizard) is a
// fast no-op instead of an unconditional overwrite.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Shelling out to PowerShell
// ---------------------------------------------------------------------------

/** How this module runs PowerShell. Injected so every code path unit-tests without a real
 *  Task Scheduler (mirrors switch-engine's `ExecRunner` pattern for `security`/DPAPI — kept
 *  as its own small copy rather than a cross-package dependency on that private plumbing). */
export type PowerShellRunner = (script: string) => string;

/** PowerShell wants -EncodedCommand as base64 of the UTF-16LE script text — same reasoning as
 *  switch-engine's DPAPI calls: it sidesteps quoting/injection surface entirely rather than
 *  trying to escape a script body for the outer shell. */
function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Production runner. stderr is piped so PowerShell's error text lands in the thrown error
 *  rather than on the parent console (same rationale as dpapi.ts's runner). */
export const defaultPowerShellRunner: PowerShellRunner = (script) =>
  execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
    {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();

/** Escape a value for interpolation into a PowerShell single-quoted string literal. */
function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

// ---------------------------------------------------------------------------
// Resolving the absolute cctl shim path
// ---------------------------------------------------------------------------

export interface ResolveCctlShimPathOptions {
  /** Returns npm's global install prefix. Injected for tests; production runs the real npm
   *  CLI (`npm prefix -g`). */
  npmPrefix?: () => string;
  platform?: NodeJS.Platform;
}

const defaultNpmPrefix = (): string =>
  execFileSync('npm', ['prefix', '-g'], {
    encoding: 'utf8',
    shell: true, // npm is a .cmd shim on Windows, same as `claude` in program.ts's addFreshAccount
    windowsHide: true,
  }).trim();

/**
 * Absolute path to the `cctl` command shim npm generated for this machine's global install.
 * A Scheduled Task action does not inherit an interactive shell's PATH, so the task must name
 * this file outright rather than the bare `cctl` command — resolved once, at install time.
 */
export function resolveCctlShimPath(options: ResolveCctlShimPathOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const prefix = (options.npmPrefix ?? defaultNpmPrefix)();
  // Windows: npm places command shims (`<name>.cmd`) directly in the global prefix directory.
  // Unix: they live under `<prefix>/bin/<name>` — kept here for completeness even though the
  // daemon itself is Windows-only this round (macOS stays on its own gated port).
  return platform === 'win32' ? join(prefix, 'cctl.cmd') : join(prefix, 'bin', 'cctl');
}

// ---------------------------------------------------------------------------
// Scheduled Task query
// ---------------------------------------------------------------------------

export const DAEMON_TASK_NAME = 'ClaudeControlDaemon';

/** The arguments the task always runs the shim with — a plain, un-flagged `cctl daemon run`.
 *  Exported so install/uninstall and their tests share one literal instead of two. */
export const DAEMON_TASK_ARGUMENTS = 'daemon run';

export interface DaemonTaskQuery {
  registered: boolean;
  execute?: string;
  arguments?: string;
  state?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseQueryOutput(out: string): DaemonTaskQuery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(out.trim());
  } catch (err) {
    throw new Error(`could not parse scheduled-task query output: ${out}`, { cause: err });
  }
  if (!isRecord(parsed) || parsed.registered !== true) return { registered: false };
  return {
    registered: true,
    ...(typeof parsed.execute === 'string' ? { execute: parsed.execute } : {}),
    ...(typeof parsed.arguments === 'string' ? { arguments: parsed.arguments } : {}),
    ...(typeof parsed.state === 'string' ? { state: parsed.state } : {}),
  };
}

/** Query the current registration, if any. A missing task is the normal, expected first-run
 *  state — reported as `{ registered: false }`, never thrown. */
export function queryDaemonTask(
  run: PowerShellRunner = defaultPowerShellRunner,
  taskName: string = DAEMON_TASK_NAME,
): DaemonTaskQuery {
  const script = `
$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName '${psSingleQuote(taskName)}' -ErrorAction SilentlyContinue
if ($null -eq $task) {
  Write-Output '{"registered":false}'
} else {
  $action = $task.Actions | Select-Object -First 1
  $obj = [ordered]@{
    registered = $true
    execute = $action.Execute
    arguments = $action.Arguments
    state = $task.State.ToString()
  }
  Write-Output ($obj | ConvertTo-Json -Compress)
}
`;
  return parseQueryOutput(run(script));
}

// ---------------------------------------------------------------------------
// Register / update
// ---------------------------------------------------------------------------

// The daemon's own control-plane connection already retries forever (see
// controlPlaneClient.ts) — Task Scheduler's restart setting exists only to relaunch the whole
// PROCESS after it dies outright (an uncaught exception, an OOM kill), a few times, rather than
// restart-loop indefinitely if something is fundamentally broken; the next logon is the
// natural next attempt after that.
const RESTART_COUNT = 3;
const RESTART_INTERVAL_MINUTES = 1;

export type DaemonTaskOutcome = 'created' | 'updated' | 'unchanged';

export interface InstallDaemonTaskOptions {
  /** Absolute path to the cctl shim the task should invoke (see `resolveCctlShimPath`). */
  shimPath: string;
  run?: PowerShellRunner;
  taskName?: string;
}

/**
 * Register (or update) the logon Scheduled Task that runs `<shimPath> daemon run`. Checks the
 * current registration first and calls `Register-ScheduledTask` only when the resolved action
 * actually differs — an unregistered task is 'created', a registered one whose command line
 * changed (e.g. npm reinstalled to a new location) is 'updated', and an already-correct one is
 * 'unchanged' and does no further PowerShell work.
 *
 * `-MultipleInstances IgnoreNew` is defense in depth alongside `runDaemon`'s own instance
 * lock: Task Scheduler will refuse to start a second copy of an already-running task, so a
 * stray `Start-ScheduledTask` call never even reaches the point where the lock would have to
 * reject it.
 */
export function installDaemonTask(options: InstallDaemonTaskOptions): DaemonTaskOutcome {
  const run = options.run ?? defaultPowerShellRunner;
  const taskName = options.taskName ?? DAEMON_TASK_NAME;

  const existing = queryDaemonTask(run, taskName);
  if (
    existing.registered &&
    existing.execute === options.shimPath &&
    existing.arguments === DAEMON_TASK_ARGUMENTS
  ) {
    return 'unchanged';
  }

  const script = `
$ErrorActionPreference = 'Stop'
$Action = New-ScheduledTaskAction -Execute '${psSingleQuote(options.shimPath)}' -Argument '${psSingleQuote(DAEMON_TASK_ARGUMENTS)}'
$Trigger = New-ScheduledTaskTrigger -AtLogOn
$Settings = New-ScheduledTaskSettingsSet -RestartCount ${RESTART_COUNT} -RestartInterval (New-TimeSpan -Minutes ${RESTART_INTERVAL_MINUTES}) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName '${psSingleQuote(taskName)}' -Action $Action -Trigger $Trigger -Settings $Settings -Description 'claude-control daemon (managed by cctl; see: cctl daemon uninstall)' -Force | Out-Null
`;
  run(script);
  return existing.registered ? 'updated' : 'created';
}

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

export type DaemonUninstallOutcome = 'removed' | 'not_installed';

/** Remove the logon Scheduled Task. Does not touch an already-running daemon process — that
 *  is a separate, explicit stop, not implied by removing the autostart registration. */
export function uninstallDaemonTask(
  run: PowerShellRunner = defaultPowerShellRunner,
  taskName: string = DAEMON_TASK_NAME,
): DaemonUninstallOutcome {
  const existing = queryDaemonTask(run, taskName);
  if (!existing.registered) return 'not_installed';
  run(`
$ErrorActionPreference = 'Stop'
Unregister-ScheduledTask -TaskName '${psSingleQuote(taskName)}' -Confirm:$false
`);
  return 'removed';
}

// ---------------------------------------------------------------------------
// Start now
// ---------------------------------------------------------------------------

/** Ask Task Scheduler to run the task immediately, so `cctl daemon install` leaves the daemon
 *  actually running rather than only scheduled for the next logon. Callers treat this as
 *  best-effort: the task is correctly registered either way, and a failure here (e.g. the
 *  task is already running — see `-MultipleInstances IgnoreNew` above) must not undo that. */
export function startDaemonTaskNow(
  run: PowerShellRunner = defaultPowerShellRunner,
  taskName: string = DAEMON_TASK_NAME,
): void {
  run(`
$ErrorActionPreference = 'Stop'
Start-ScheduledTask -TaskName '${psSingleQuote(taskName)}'
`);
}
