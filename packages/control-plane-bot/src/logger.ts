// Minimal logger seam, mirroring switch-engine's.
//
// This package logs through a tiny structural interface rather than importing pino
// directly everywhere — keeps the core relay/binding/pairing logic dependency-light and
// trivially testable with a no-op. The real Discord wiring (discordJsGateway.ts) is free to
// construct a real pino logger and pass it in; that construction is the only place pino is
// actually touched outside of `package.json`.

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
