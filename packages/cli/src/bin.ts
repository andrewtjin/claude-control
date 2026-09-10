#!/usr/bin/env node
// The `cctl` entry point. Kept to a single responsibility: parse argv and surface any
// unhandled error as a clean non-zero exit rather than a stack trace — through `fail`, so the
// line looks like every other error the CLI prints.
import { fail } from './context.js';
import { buildProgram } from './program.js';

buildProgram()
  .parseAsync(process.argv)
  .catch((err: unknown) => fail(err instanceof Error ? err.message : String(err)));
