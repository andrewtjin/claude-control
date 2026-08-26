// Construction of the switch engine for CLI use, plus tiny shared helpers.
//
// The CLI runs one-shot commands against the same vault the daemon uses, so it builds a
// SwitchEngine on the real default paths. `createLogger` builds the engine's tiny Logger
// interface on top of pino; the CLI keeps it quiet by default (warn+) and leaves the stream it
// renders to up to the caller (see `buildEngine`).

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger, type LogSink } from '@claude-control/shared-protocol';
import { SwitchEngine, defaultPaths, type Logger, type Paths } from '@claude-control/switch-engine';

/** The daemon's sqlite database — a sibling of the vault under the claude-control data dir.
 *  The CLI reads it (e.g. `cctl usage`) without needing the daemon process to be running.
 *  Ensures the parent directory exists so opening a not-yet-created db does not fail (sqlite
 *  cannot create a file under a missing directory). */
export function daemonDbPath(paths: Paths = defaultPaths()): string {
  const dir = dirname(paths.vaultDir);
  mkdirSync(dir, { recursive: true });
  return join(dir, 'daemon.db');
}

/**
 * Where the engine renders its diagnostics — a decision that belongs to the caller, because the
 * two composition roots that build engines want opposite answers and neither can be defaulted
 * into the other's.
 *
 * A one-shot command (the default, STDERR) owns its stdout: the accounts table, the `--json`
 * document, whatever the caller is piping into `jq` or a script. The engine can emit a warn line
 * at any point during a plain read (a metadata repair that could not complete, for instance); on
 * stdout it lands in the middle of that output and corrupts it for every non-human consumer,
 * while being no more visible to the operator than it is on stderr.
 *
 * `cctl daemon run` has no output of its own — everything it writes is log — so it passes the
 * SAME sink its own logger renders to (see daemonRun.ts's `DAEMON_LOG_SINK`). Both loggers in
 * that process must land in one place or `cctl daemon run > daemon.log` captures only half the
 * daemon's log and quietly leaves the rest on the terminal.
 *
 * Nothing is silenced either way: the level is unchanged, CCTL_LOG_FILE still receives the same
 * lines, and CCTL_LOG_LEVEL still turns more of them on.
 *
 * `env` defaults to the real `process.env`; `cctl daemon run` overrides just CCTL_LOG_FILE on
 * it (its resolved default-or-explicit log path) so this engine's logger writes to the SAME
 * file its own logger does, without disturbing every other env-driven knob this reads.
 */
export function buildEngine(
  paths: Paths = defaultPaths(),
  logSink: LogSink = process.stderr,
  env: NodeJS.ProcessEnv = process.env,
): SwitchEngine {
  const adapter: Logger = createLogger({ defaultLevel: 'warn', sink: logSink, env });
  // The switch-cadence guard defaults to 60s; operators can tune (or 0-disable) it via env.
  const intervalEnv = Number(process.env.CCTL_SWITCH_MIN_INTERVAL_MS);
  // The same adapter reaches the OAuth retry loop, which is otherwise the one part of a token
  // refresh that can spend seconds without saying anything: a 529 storm against the token
  // endpoint would surface only as the eventual failure message. At the default `warn` level
  // these lines stay quiet; CCTL_LOG_LEVEL=info is what turns the incident on.
  const options: ConstructorParameters<typeof SwitchEngine>[0] = {
    paths,
    logger: adapter,
    refreshDeps: { overload: { logger: adapter } },
  };
  if (Number.isFinite(intervalEnv) && intervalEnv >= 0) {
    options.minSwitchIntervalMs = intervalEnv;
  }
  // Refresh-below-this-lifetime window (default 5 min). Setting it huge forces a refresh on
  // the next activate — how oauth.ts's live refresh path (docs/VERIFICATION.md §2) is exercised.
  const skewEnv = Number(process.env.CCTL_REFRESH_SKEW_MS);
  if (Number.isFinite(skewEnv) && skewEnv >= 0) {
    options.refreshSkewMs = skewEnv;
  }
  return new SwitchEngine(options);
}

/** The CLI's "stop here, with this message" signal. Its message is the whole error — already
 *  phrased for a human — so the entry point prints that and never a stack. */
export class CliFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliFailure';
  }
}

/**
 * End the current command with an error line and a non-zero exit — the single failure path for
 * command actions.
 *
 * It THROWS rather than calling `process.exit`, and that is load-bearing. A command that failed
 * mid-network still has sockets closing when it gives up; exiting on top of them asks libuv to
 * finish closing a handle whose loop is already gone, which it refuses with an assertion — so a
 * caller checking for exit code 1 intermittently gets a crash code instead. The entry point
 * catches this, prints the line, and sets `process.exitCode`, letting the loop drain on its own.
 *
 * The `never` return that callers narrow on is preserved by the throw. One behavior does change:
 * `finally` blocks on the way out now RUN, where `process.exit` skipped them — which is what the
 * flows holding token-bearing temporary directories wanted in the first place.
 */
export function fail(message: string): never {
  throw new CliFailure(message);
}

/** Report a fatal error and ask for a non-zero exit without tearing the loop down. Split out of
 *  the entry point so the exit path is testable; the race it exists to avoid is not. */
export function reportFatal(
  err: unknown,
  sink: { write(text: string): unknown } = process.stderr,
): void {
  sink.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
