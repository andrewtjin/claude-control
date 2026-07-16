// Construction of the switch engine for CLI use, plus tiny shared helpers.
//
// The CLI runs one-shot commands against the same vault the daemon uses, so it builds a
// SwitchEngine on the real default paths. A `pino` logger is adapted to the engine's tiny
// Logger interface; the CLI keeps it quiet by default (warn+).

import pino from 'pino';
import { SwitchEngine, defaultPaths, type Logger, type Paths } from '@claude-control/switch-engine';

/** Build a SwitchEngine on the real, production paths. */
export function buildEngine(paths: Paths = defaultPaths()): SwitchEngine {
  const logger = pino({ level: process.env.CCTL_LOG_LEVEL ?? 'warn' });
  const adapter: Logger = {
    debug: (obj, msg) => logger.debug(obj, msg),
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  };
  return new SwitchEngine({ paths, logger: adapter });
}

/** Print an error line and exit non-zero — the single failure path for command actions. */
export function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}
