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
//     removed so every later event takes the no-network fast path. Exit 0. The removal is
//     GUARDED: the file is re-read at failure time and deleted only if it still names the
//     port that failed — a daemon restarting mid-flight re-publishes the file for its new
//     port, and an unguarded unlink would hide that healthy receiver from every later hook
//     (live-observed; the daemon's periodic re-publish is the second layer of defense).
//   - Connected: what happens next depends on WHETHER THE EVENT'S RESPONSE CARRIES ANYTHING.
//     PermissionRequest answers are long-poll decisions and Stop answers deliver operator
//     steering ({"decision":"block","reason":…}), so those two ride the response with NO
//     deadline and print it to stdout verbatim. Notification and PostToolUse answers are
//     always an ignored {ok:true} — for those the script exits as soon as the request body
//     has been handed to the connected socket (fire-and-forget), so a daemon whose event
//     loop is momentarily busy can NEVER stall a tool call: the kernel owns delivery from
//     that point and the daemon reads the event when it gets there. An unrecognized or
//     unparsable event rides the response — correctness over speed for anything unknown.
//
// Reading the receiver's CURRENT port from the endpoint file at fire time also makes the
// installed command port-independent: a running session's hook snapshot keeps working across
// daemon restarts instead of pointing at a dead port forever. Events that fire while the
// daemon is down are dropped by design; while it is up, delivery stays complete, ordered
// (the session serializes its own hook events; connections are accepted in arrival order),
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
// to the local daemon's loopback receiver. PermissionRequest/Stop responses are
// awaited and printed (decisions and steering ride them); everything else is
// fire-and-forget once the body reaches the socket. No daemon (no endpoint
// file, or nothing listening) => exit 0 quickly.
const fs = require('fs');
const path = require('path');
const http = require('http');

// Bounds the CONNECT only, never the response wait: permission answers are
// long-polls and steering rides the response body.
const CONNECT_TIMEOUT_MS = 400;

// Events whose RESPONSE carries a decision back into the session. Every other
// event's response is an ignored ack, so waiting for it would only re-couple
// tool-call latency to daemon responsiveness.
const RESPONSE_EVENTS = ['PermissionRequest', 'Stop'];

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

// The whole payload is buffered (hook payloads are small) so the event name can
// pick the mode before the request is sent.
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('error', bail);
process.stdin.on('data', (chunk) => {
  body += chunk;
});
process.stdin.on('end', () => {
  let event;
  try {
    event = JSON.parse(body).hook_event_name;
  } catch {}
  // Unknown/unparsable events ride the response: never guess that an answer is ignorable.
  const awaitResponse = typeof event !== 'string' || RESPONSE_EVENTS.indexOf(event) >= 0;

  const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/', headers });
  let connected = false;
  let flushed = false;
  const connectTimer = setTimeout(() => {
    if (!connected) req.destroy(new Error('connect timeout'));
  }, CONNECT_TIMEOUT_MS);
  // Fire-and-forget completes when BOTH hold: the socket is connected and the body has been
  // flushed to it. From there the kernel owns delivery — a busy daemon reads the event when
  // its loop frees up, and this process's exit cannot lose gracefully-closed TCP data.
  function maybeDone() {
    if (!awaitResponse && connected && flushed) process.exit(0);
  }
  req.on('socket', (socket) => {
    socket.on('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      maybeDone();
    });
  });
  req.on('finish', () => {
    flushed = true;
    maybeDone();
  });
  req.on('error', () => {
    clearTimeout(connectTimer);
    if (!connected) {
      // Nothing listening behind a published endpoint: crash leftover. Drop the
      // stale file so later events skip straight to the no-network fast path —
      // but ONLY if it still names the port that just failed. A daemon restart
      // between our startup read and this failure re-publishes the file for the
      // NEW receiver; deleting that would hide a healthy daemon from every
      // later hook (live-observed). Unreadable/changed file: leave it alone.
      try {
        const current = JSON.parse(fs.readFileSync(endpointFile, 'utf8'));
        if (current.port === port) fs.unlinkSync(endpointFile);
      } catch {}
    }
    bail();
  });
  if (awaitResponse) {
    req.on('response', (res) => {
      res.pipe(process.stdout);
      res.on('end', () => process.exit(0));
      res.on('error', bail);
    });
  }
  req.end(body);
});
`;

/** Write (or refresh) the forwarder script. Called on daemon start, before hook install, so
 *  the command `buildDaemonHookSpecs` points at always has a current script behind it. */
export async function writeHookForwarder(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, HOOK_FORWARDER_SOURCE, 'utf8');
}
