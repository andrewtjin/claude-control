#!/usr/bin/env node
// The `cctl` entry point. Kept to a single responsibility: parse argv and surface any
// unhandled error as a clean non-zero exit rather than a stack trace.
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => {
    process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
