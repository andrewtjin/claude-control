#!/usr/bin/env node
// Entry point for the per-session channel server. Claude Code spawns this as an MCP stdio
// server; the cctl daemon talks to it over loopback.
//
// The composition lives in run.ts so `cctl channel serve` hosts exactly the same server — the
// shipped plugin's .mcp.json invokes the CLI rather than this binary, and the two must not drift.

import { runChannelServer } from './run.js';

runChannelServer()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((err: unknown) => {
    process.stderr.write(`channel: fatal: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
