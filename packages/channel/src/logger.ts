// Minimal logger seam, declared locally rather than imported.
//
// WHY NOT switch-engine's: this package is spawned once per Claude Code session and its module
// graph sits directly in front of the MCP handshake. Importing a package barrel to obtain a
// four-method interface drags that package's whole runtime along — switch-engine's brings the
// vault, OAuth refresh, Keychain and DPAPI — for types that are erased at compile time anyway.
//
// The repo already treats this interface as something each package declares for itself (both
// switch-engine and control-plane-bot do, deliberately). shared-protocol's `createLogger`
// returns something structurally identical, which is what the composition root passes in.

export interface Logger {
  debug(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
}

/** Discards everything — the default when a caller supplies no logger. */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
