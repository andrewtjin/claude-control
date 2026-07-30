// Public surface of the wire contract. Everything the daemon, bot, and CLI need to
// speak the protocol is re-exported here; nothing else in this package is importable.
export * from './version.js';
export * from './messages.js';
export * from './codec.js';
export * from './logger.js';
export * from './ansiColor.js';
// `Paint`/`LogLineColors` are the CLI's palette primitives too (see ansi.ts) — exported here so
// the CLI imports them instead of redeclaring structurally-identical copies that could drift.
export * from './logFormat.js';
