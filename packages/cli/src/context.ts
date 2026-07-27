// Construction of the switch engine for CLI use, plus tiny shared helpers.
//
// The CLI runs one-shot commands against the same vault the daemon uses, so it builds a
// SwitchEngine on the real default paths. `createLogger` builds the engine's tiny Logger
// interface on top of pino; the CLI keeps it quiet by default (warn+) and points it at stderr
// (see `commandLogger`).

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createLogger } from '@claude-control/shared-protocol';
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
 * The logger the engine writes its diagnostics through when it is driven by a command.
 *
 * Rendered to STDERR, never stdout. A command's stdout is its OUTPUT — the accounts table, the
 * `--json` document, whatever the caller is piping into `jq` or a script — and the engine can
 * emit a warn line at any point during a plain read (a metadata repair that could not complete,
 * for instance). On stdout those lines interleave with the output and corrupt it for every
 * non-human consumer; on stderr they stay visible to the operator and invisible to the pipe.
 * Nothing is silenced: the level is unchanged, CCTL_LOG_FILE still receives the same lines, and
 * CCTL_LOG_LEVEL still turns more of them on.
 *
 * `cctl daemon run` builds an engine through here too and has no output of its own, so its
 * engine diagnostics simply join the daemon's own log lines on the console it inherits; an
 * installed daemon has no console at all and is read through CCTL_LOG_FILE, which receives the
 * same lines whichever stream they were rendered to.
 */
function commandLogger(): Logger {
  return createLogger({ defaultLevel: 'warn', sink: process.stderr });
}

/** Build a SwitchEngine on the real, production paths. */
export function buildEngine(paths: Paths = defaultPaths()): SwitchEngine {
  const adapter: Logger = commandLogger();
  // The switch-cadence guard defaults to 60s; operators can tune (or 0-disable) it via env.
  const intervalEnv = Number(process.env.CCTL_SWITCH_MIN_INTERVAL_MS);
  const options: ConstructorParameters<typeof SwitchEngine>[0] = { paths, logger: adapter };
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
