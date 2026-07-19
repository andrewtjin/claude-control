// The hook forwarder script: the single program every installed hook command runs.
//
// Claude Code executes hook commands synchronously — the session waits for the command to
// exit before continuing. The previous command shape (a curl one-liner with the receiver's
// per-run port baked in) made that wait expensive whenever the daemon wasn't running: on
// Windows, a POST to a dead loopback port does not fail fast (the connect can burn seconds
// before giving up, firewall policy permitting no RST), and with PostToolUse matching every
// tool, EVERY tool call in every session paid it. This module replaces the curl with a tiny
// self-contained Node script whose whole job is a fast, honest answer to "is the daemon
// there?":
//
//   - Endpoint file ABSENT (a clean daemon shutdown removes it): exit 0 immediately with no
//     network at all — the only cost is process startup.
//   - Endpoint file present but nothing listening (crash leftover): one connect attempt to
//     127.0.0.1 bounded by a short CONNECT-ONLY timeout, then the stale endpoint file is
//     removed so every later event takes the no-network fast path. Exit 0.
//   - Connected: the response is awaited WITHOUT any deadline, and its body is printed to
//     stdout verbatim. Held permission answers are long-polls (minutes) and Stop-hook
//     steering rides the response body — a total-time cap here would sever both channels.
//
// Reading the receiver's CURRENT port from the endpoint file at fire time also makes the
// installed command port-independent: a running session's hook snapshot keeps working across
// daemon restarts instead of pointing at a dead port forever. Events that fire while the
// daemon is down are dropped by design; while it is up, delivery stays synchronous, ordered,
// and unduplicated — exactly as before.
//
// The script must stay dependency-free CommonJS (any Node on PATH can run it, regardless of
// the surrounding repo) and must NEVER exit non-zero or write to stderr: a hook failure is
// the daemon's problem, never the session's.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Stable on-disk location beside `hook-endpoint.json` — the script finds the endpoint file
 *  by its own directory, so the two must stay colocated (both live in the daemon data dir). */
export function hookForwarderPath(dataDir: string): string {
  return join(dataDir, 'hook-forward.cjs');
}

/** The forwarder program. Kept as a source constant (not a shipped asset file) so the daemon
 *  can (re)write it on every start — upgrades apply on restart, and a deleted or hand-edited
 *  copy heals itself the same way settings.json entries do. */
export const HOOK_FORWARDER_SOURCE = `'use strict';
// claude-control hook forwarder (written by the daemon; safe to delete — it is
// re-created on daemon start). Forwards the Claude Code hook payload on stdin
// to the local daemon's loopback receiver and prints the response to stdout.
// No daemon (no endpoint file, or nothing listening) => exit 0 quickly.
const fs = require('fs');
const path = require('path');
const http = require('http');

// Bounds the CONNECT only, never the response wait: permission answers are
// long-polls and steering rides the response body.
const CONNECT_TIMEOUT_MS = 400;

const endpointFile = path.join(__dirname, 'hook-endpoint.json');

function bail() {
  process.exit(0);
}

let port;
try {
  const parsed = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
  if (Number.isInteger(parsed.port) && parsed.port > 0) port = parsed.port;
} catch {
  bail(); // no endpoint file (daemon stopped cleanly) or unreadable: no network, done
}
const flagIndex = process.argv.indexOf('--secret-header');
const headerArg = flagIndex >= 0 ? process.argv[flagIndex + 1] : undefined;
const sep = typeof headerArg === 'string' ? headerArg.indexOf(':') : -1;
if (port === undefined || sep <= 0) bail();

const headers = {
  'content-type': 'application/json',
};
headers[headerArg.slice(0, sep).trim()] = headerArg.slice(sep + 1).trim();

const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers });
let connected = false;
const connectTimer = setTimeout(() => {
  if (!connected) req.destroy(new Error('connect timeout'));
}, CONNECT_TIMEOUT_MS);
req.on('socket', (socket) => {
  socket.on('connect', () => {
    connected = true;
    clearTimeout(connectTimer);
  });
});
req.on('error', () => {
  clearTimeout(connectTimer);
  if (!connected) {
    // Nothing listening behind a published endpoint: crash leftover. Drop the
    // stale file so later events skip straight to the no-network fast path.
    try {
      fs.unlinkSync(endpointFile);
    } catch {}
  }
  bail();
});
req.on('response', (res) => {
  res.pipe(process.stdout);
  res.on('end', () => process.exit(0));
  res.on('error', bail);
});
process.stdin.on('error', bail);
process.stdin.pipe(req);
`;

/** Write (or refresh) the forwarder script. Called on daemon start, before hook install, so
 *  the command `buildDaemonHookSpecs` points at always has a current script behind it. */
export async function writeHookForwarder(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, HOOK_FORWARDER_SOURCE, 'utf8');
}
