// Construction of the switch engine for CLI use, plus tiny shared helpers.
//
// The CLI runs one-shot commands against the same vault the daemon uses, so it builds a
// SwitchEngine on the real default paths. `createLogger` builds the engine's tiny Logger
// interface on top of pino; the CLI keeps it quiet by default (warn+).

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

/** Build a SwitchEngine on the real, production paths. */
export function buildEngine(paths: Paths = defaultPaths()): SwitchEngine {
  const adapter: Logger = createLogger({ defaultLevel: 'warn' });
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
