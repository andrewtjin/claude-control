#!/usr/bin/env node
// The `cctl` entry point. Kept to a single responsibility: parse argv and surface any
// unhandled error as a clean non-zero exit rather than a stack trace.
import { reportFatal } from './context.js';
import { buildProgram } from './program.js';

/** How long a failed command may take to drain before the exit stops being polite. */
const EXIT_DRAIN_GRACE_MS = 2_000;

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    reportFatal(err);
    // A command that died mid-request leaves sockets closing behind it, and `process.exit` on
    // top of those is what makes libuv assert on a handle it is still finishing — an occasional
    // crash code where a caller expects 1. So the loop is left to drain, with a guard for the
    // case where something holds it open for good: unref'd, so a clean drain still exits the
    // instant it is done rather than waiting this timer out.
    const guard = setTimeout(() => process.exit(1), EXIT_DRAIN_GRACE_MS);
    guard.unref();
  });
