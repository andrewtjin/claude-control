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
 */
export function buildEngine(
  paths: Paths = defaultPaths(),
  logSink: LogSink = process.stderr,
): SwitchEngine {
  const adapter: Logger = createLogger({ defaultLevel: 'warn', sink: logSink });
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

/** Print an error line and exit non-zero — the single failure path for command actions. */
export function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
