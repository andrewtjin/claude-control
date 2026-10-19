// The login step of `cctl accounts relogin`: how a fresh login gets INTO the throwaway
// `CLAUDE_CONFIG_DIR` the command then captures from.
//
// Two ways exist, and this module picks between them:
//
//  - **`claude auth login`** (the default). A non-interactive subcommand that opens the browser,
//    waits for the callback (or a pasted code), writes `.credentials.json` + `.claude.json` into
//    the config dir and exits. It needs no TTY, so it works where an interactive window cannot —
//    under Claude Code's `!` prefix, for one, the CLI drops to `--print` and refuses to start.
//  - **The interactive window** (the fallback). Spawn a plain `claude`, have the user /login,
//    send a message and /exit. Kept for Claude Code builds that predate `auth login`, and
//    reachable explicitly through `--window`.
//
// Support is decided by asking the installed CLI (`claude auth login --help`), never by a
// version floor: a floor would have to be guessed, and a build that renames or drops the
// subcommand later would be misjudged by it.
//
// Everything that touches a process goes through an injected {@link ClaudeSpawner}, so the
// decision logic is testable without ever running the real `claude auth login` — which really
// logs in through the browser.

import { spawn, spawnSync, type StdioOptions } from 'node:child_process';

/** How one `claude` run is wired. */
export interface ClaudeRunOptions {
  env: NodeJS.ProcessEnv;
  /** True: stdin closed, stdout + stderr collected into {@link ClaudeRun.output} (the support
   *  probe reads its help text). False: all three inherited, so the user sees the login URL and
   *  a TTY user can paste a code or drive the window. */
  capture: boolean;
  /** Stop the run (its whole process tree) after this long. Absent: wait for as long as it takes. */
  timeoutMs?: number;
}

/** What one `claude` run came to. */
export interface ClaudeRun {
  status: number | null;
  signal: NodeJS.Signals | null;
  /** Collected stdout + stderr when `capture` was set, else empty. */
  output: string;
  /** True when the run was stopped by its `timeoutMs`. */
  timedOut: boolean;
  /** Set when the process could not be started at all. */
  error?: Error;
}

/** Runs `claude` with the given arguments. Production uses {@link spawnClaude}; tests stub it. */
export type ClaudeSpawner = (
  args: readonly string[],
  options: ClaudeRunOptions,
) => Promise<ClaudeRun>;

/**
 * Build a spawner for `command`. Exported (rather than only {@link spawnClaude}) so the process
 * mechanics can be tested against a harmless binary instead of the real `claude`.
 *
 * On Windows `claude` is a `.cmd` shim, which Node only starts through a shell. The command line
 * is joined here rather than handing Node an argument array with `shell: true`: Node would join
 * it the same way (it escapes nothing) and warns that it does. Every argument this module passes
 * is a fixed flag or an email that {@link safeLoginEmail} has already vetted, so the joined line
 * cannot carry anything cmd.exe would interpret. Elsewhere `claude` is a real executable and gets
 * its arguments as an array, with no shell at all.
 *
 * Asynchronous on purpose, even though callers just await it: a timeout has to stop the WHOLE
 * tree. Through the Windows shim the direct child is cmd.exe and the CLI is its grandchild, so
 * killing only the child (all `spawnSync`'s `timeout` can do) would leave the login running in
 * the background — still able to write fresh tokens into a config dir this command believes it
 * has already deleted. `taskkill /T` reaches the grandchild, but only while the child is alive,
 * which needs a handle to the child before it exits.
 */
export function createClaudeSpawner(
  command: string,
  platform: NodeJS.Platform = process.platform,
): ClaudeSpawner {
  const windows = platform === 'win32';
  return (args, options) =>
    new Promise<ClaudeRun>((resolve) => {
      const stdio: StdioOptions = options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit';
      const child = windows
        ? spawn([command, ...args].join(' '), { stdio, env: options.env, shell: true })
        : spawn(command, [...args], { stdio, env: options.env });
      // While an inherited-stdio child runs, Ctrl+C reaches the whole console group. Left to its
      // default, Node would exit this process at once, before the child exits and before the
      // caller's cleanup of the throwaway dir runs. Swallowing it here lets the child own the
      // Ctrl+C; its exit then resolves this run as a failure, and cleanup happens as usual. The
      // same reasoning as the launcher's spawnClaude. A captured (piped) run needs none of this.
      const watched: NodeJS.Signals[] = options.capture
        ? []
        : windows
          ? ['SIGINT', 'SIGBREAK']
          : ['SIGINT'];
      const ignore = (): void => {
        // Intentionally empty: the child handles the signal and its exit settles the run.
      };
      for (const sig of watched) process.on(sig, ignore);
      const settle = (run: ClaudeRun): void => {
        if (timer !== undefined) clearTimeout(timer);
        for (const sig of watched) process.off(sig, ignore);
        resolve(run);
      };

      let output = '';
      child.stdout?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));
      child.stderr?.on('data', (chunk: Buffer) => (output += chunk.toString('utf8')));

      let timedOut = false;
      const timer =
        options.timeoutMs === undefined
          ? undefined
          : setTimeout(() => {
              timedOut = true;
              stopTree(child.pid, windows, () => child.kill('SIGTERM'));
            }, options.timeoutMs);
      // `error` (could not start) and `close` (exited, streams drained) can both fire for one
      // run; the first one settles the promise and the second is a no-op.
      child.on('error', (error) => settle({ status: null, signal: null, output, timedOut, error }));
      child.on('close', (status, signal) => settle({ status, signal, output, timedOut }));
    });
}

/** Stop a run's whole process tree — see {@link createClaudeSpawner} for why the tree, not the
 *  child. Off Windows there is no shell in between, so the child IS the CLI. */
function stopTree(pid: number | undefined, windows: boolean, killChild: () => void): void {
  if (windows && pid !== undefined) {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  killChild();
}

/** The production spawner: the `claude` on PATH. */
export const spawnClaude: ClaudeSpawner = createClaudeSpawner('claude');

/** How long `claude auth login` may wait for the browser before it is stopped. It waits forever
 *  on its own, which on a run with no TTY (nobody there to paste a code, or to notice) would hang
 *  the command indefinitely. Generous, because a person may need to find the right browser
 *  window, switch claude.ai accounts and sign in with a second factor before it returns. */
export const AUTH_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

/** How long the support probe (`claude auth login --help`) may take. It only prints help, but a
 *  cold CLI start on Windows takes seconds, so this leaves a wide margin before calling the
 *  installed CLI unresponsive. */
const PROBE_TIMEOUT_MS = 30 * 1000;

/** The email shapes trusted onto a command line. Deliberately narrower than what RFC 5322
 *  allows: ASCII letters and digits plus `.`, `_`, `+` and `-`, a local part and every domain
 *  label starting with a letter or digit (so the value can never read as a flag), one `@`, and at
 *  least one dot in the domain. `%` is excluded too — cmd.exe expands `%NAME%` before it parses
 *  the line, so a percent sign is the one "ordinary" email character that is not inert there. */
const SAFE_EMAIL =
  /^[A-Za-z0-9][A-Za-z0-9._+-]*@[A-Za-z0-9][A-Za-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9-]*)+$/;

/** The longest address the SMTP spec allows; anything longer is not a real stored email. */
const MAX_EMAIL_LENGTH = 254;

/**
 * The account's stored email when it is safe to put on a `claude` command line, else undefined.
 * Undefined just means the login page opens without the hint: `--email` only pre-fills the page,
 * so leaving it off costs a little typing, while a value that reached cmd.exe unvetted could run
 * arbitrary commands.
 */
export function safeLoginEmail(email: string | undefined): string | undefined {
  if (email === undefined || email.length > MAX_EMAIL_LENGTH) return undefined;
  return SAFE_EMAIL.test(email) ? email : undefined;
}

/** What the installed CLI says about `claude auth login`. */
export type AuthLoginSupport =
  | { kind: 'supported'; email: boolean }
  | { kind: 'unsupported' }
  | { kind: 'error'; message: string };

/**
 * Ask the installed CLI whether it has `claude auth login`. A build without the subcommand
 * answers `--help` with its general help (which has no `--claudeai`), so "exit 0 and the help
 * names `--claudeai`" is the test. `--email` is passed later only if this same help lists it.
 *
 * `env` must point `CLAUDE_CONFIG_DIR` at the throwaway dir like every other run here: even a
 * help request starts the CLI, and nothing about it should touch the real config.
 */
export async function detectAuthLogin(
  spawner: ClaudeSpawner,
  env: NodeJS.ProcessEnv,
): Promise<AuthLoginSupport> {
  const run = await spawner(['auth', 'login', '--help'], {
    env,
    capture: true,
    timeoutMs: PROBE_TIMEOUT_MS,
  });
  if (run.error)
    return { kind: 'error', message: `could not launch \`claude\`: ${run.error.message}` };
  if (run.timedOut) {
    return {
      kind: 'error',
      message: `\`claude auth login --help\` did not answer within ${PROBE_TIMEOUT_MS / 1000} seconds`,
    };
  }
  if (run.status !== 0 && notLaunched(run)) {
    return { kind: 'error', message: 'could not launch `claude` (is it on PATH?)' };
  }
  if (run.status !== 0 || !run.output.includes('--claudeai')) return { kind: 'unsupported' };
  return { kind: 'supported', email: run.output.includes('--email') };
}

/**
 * True when a run that did start reports that the SHELL could not find `claude`. Through the
 * Windows shim the spawned process is cmd.exe, so a missing CLI is not a spawn error: cmd itself
 * exits 1 (9009 from some callers) and prints "is not recognized as an internal or external
 * command". Read as "this CLI has no `auth login`", that would open a window that cannot start
 * either. Any other non-zero probe still counts as an older CLI, which is the back-compat case
 * the window fallback exists for.
 */
function notLaunched(run: ClaudeRun): boolean {
  return (
    run.status === 9009 || /is not recognized as an internal or external command/i.test(run.output)
  );
}

/** The account a re-login is for — just what the login step prints and passes on. */
export interface ReloginTarget {
  id: string;
  label: string;
  emailAddress?: string;
}

/** Which login ran, and its failure message when it did not end in a login to capture. The flow
 *  matters after the capture too: only a browser login earns {@link reloginRecoveryHint}. */
export interface ReloginLogin {
  flow: 'browser' | 'window';
  failure?: string;
}

/** The login step's collaborators. `timeoutMs` exists so a test can exercise expiry without
 *  waiting {@link AUTH_LOGIN_TIMEOUT_MS}. */
export interface ReloginLoginDeps {
  spawner: ClaudeSpawner;
  write: (text: string) => void;
  timeoutMs?: number;
}

/**
 * Put a fresh login into the throwaway config dir `env` points at. `claude auth login` when the
 * installed CLI has it, the interactive window when it does not or when `forceWindow` is set.
 *
 * Once `auth login` is known to exist, a failed run is reported, never followed by a window: the
 * user has just watched one login attempt, and a second, different one opening on its own would
 * hide why the first failed. The failure says how to get the window deliberately instead.
 */
export async function loginForRelogin(
  target: ReloginTarget,
  env: NodeJS.ProcessEnv,
  forceWindow: boolean,
  deps: ReloginLoginDeps,
): Promise<ReloginLogin> {
  if (!forceWindow) {
    const support = await detectAuthLogin(deps.spawner, env);
    if (support.kind === 'error') {
      return { flow: 'browser', failure: `${support.message}.\n${alternatives(target.label)}` };
    }
    if (support.kind === 'supported') return browserLogin(target, env, support.email, deps);
    deps.write(
      'This Claude Code has no `claude auth login`; falling back to an interactive window.\n',
    );
  }
  return windowLogin(target, env, deps);
}

/** The `claude auth login` path. */
async function browserLogin(
  target: ReloginTarget,
  env: NodeJS.ProcessEnv,
  emailFlag: boolean,
  deps: ReloginLoginDeps,
): Promise<ReloginLogin> {
  const email = emailFlag ? safeLoginEmail(target.emailAddress) : undefined;
  // `--email` only pre-fills the login page. A browser already signed in to claude.ai offers that
  // account's Authorize button, whatever the email says, so the instructions say to check it; the
  // engine's identity guard refuses a wrong account afterwards, but only after the round trip.
  const who = target.emailAddress ?? 'the account this entry belongs to';
  deps.write(
    `Re-logging in "${target.label}" (${target.id}) through the browser.\n` +
      `  1. Sign in as ${who} - the SAME account (attribution is preserved).\n` +
      '     Check the account before you click Authorize; if it is another one, switch accounts on claude.ai first.\n' +
      '  2. If the browser does not open, visit the link printed below; paste the code here if asked.\n\n',
  );
  const timeoutMs = deps.timeoutMs ?? AUTH_LOGIN_TIMEOUT_MS;
  const run = await deps.spawner(
    ['auth', 'login', '--claudeai', ...(email !== undefined ? ['--email', email] : [])],
    { env, capture: false, timeoutMs },
  );
  const failure = (what: string): ReloginLogin => ({
    flow: 'browser',
    failure: `${what}.\n${alternatives(target.label)}`,
  });
  if (run.error) return failure(`could not launch \`claude auth login\`: ${run.error.message}`);
  if (run.timedOut) {
    return failure(
      `\`claude auth login\` did not finish within ${formatMinutes(timeoutMs)}, so it was stopped`,
    );
  }
  if (run.status !== 0) {
    const how =
      run.status !== null
        ? `exited with code ${run.status}`
        : `was stopped (${run.signal ?? 'unknown signal'})`;
    return failure(`\`claude auth login\` ${how}; the login did not complete`);
  }
  return { flow: 'browser' };
}

/** The interactive-window path — exactly what `relogin` did before `auth login` existed. Its exit
 *  status is not judged: /exit, a closed window and a crash all look alike from here, and the
 *  capture that follows is what tells a completed login from an abandoned one. */
async function windowLogin(
  target: ReloginTarget,
  env: NodeJS.ProcessEnv,
  deps: ReloginLoginDeps,
): Promise<ReloginLogin> {
  deps.write(
    `Re-logging in "${target.label}" (${target.id}). A throwaway Claude window will open.\n` +
      '  1. /login - pick the SAME account this entry belongs to (attribution is preserved).\n' +
      '  2. Send one short message so the login completes.\n' +
      '  3. /exit\n\n',
  );
  const run = await deps.spawner([], { env, capture: false });
  if (run.error)
    return { flow: 'window', failure: `could not launch \`claude\`: ${run.error.message}` };
  return { flow: 'window' };
}

/**
 * What to tell the user after a browser login that the capture then refused (`code` is the
 * engine error's). The identity guard itself stays exactly as strict; this only says how to get
 * past the usual cause, a browser signed in to a different claude.ai account than the entry's.
 */
export function reloginRecoveryHint(target: ReloginTarget, code: string): string {
  if (code === 'relogin_identity_mismatch') {
    const who = target.emailAddress ?? 'the right account';
    return (
      `The browser was signed in to a different claude.ai account. Switch it to ${who} on ` +
      `claude.ai and re-run.\n${alternatives(target.label, 'Or')}`
    );
  }
  return alternatives(target.label);
}

/** The two other ways in, offered whenever the browser login did not work out. */
function alternatives(label: string, lead = 'Re-run, or'): string {
  return (
    `${lead} log in through an interactive window: \`cctl accounts relogin ${label} --window\`, ` +
    `or with a pasted code: \`cctl accounts reauth ${label}\`.`
  );
}

/** `15 minutes`, `1 minute`, or seconds for the sub-minute values only tests use. */
function formatMinutes(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1000)} seconds`;
  const minutes = Math.round(ms / 60_000);
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}
