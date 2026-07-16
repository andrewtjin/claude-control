// Minimal logger seam.
//
// switch-engine stays dependency-free, so it does not import pino directly — it logs
// through this tiny interface. The daemon and CLI adapt their real logger to it; tests pass
// a no-op. Keeping the surface this small means any logger satisfies it.

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** A logger that discards everything — the default when a caller supplies none. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
