// Tests for the hook forwarder script — the program every installed hook command runs.
//
// The forwarder is a standalone child process by design (Claude Code spawns it per hook
// event), so these tests exercise it exactly that way: write the real script to a temp data
// dir, spawn it under the real node binary, and speak to it over real loopback sockets. The
// policies under test are the ones the module exists for: no-network fast path when the
// endpoint file is absent, connect-ONLY timeout (a slow response must still be delivered —
// permission answers are long-polls), stale-endpoint self-healing, and verbatim response
// passthrough on stdout (hook answers ride it).

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hookEndpointPath, writeHookEndpoint } from './hookEndpoint.js';
import { HOOK_FORWARDER_SOURCE, hookForwarderPath, writeHookForwarder } from './hookForwarder.js';

const SECRET_ARG = 'x-claude-control-secret: shh';

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the forwarder the way Claude Code's hook runner does: payload on stdin, answer on
 *  stdout. The secret header travels as the single `--secret-header` argument. */
function runForwarder(scriptPath: string, payload: string, args?: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      scriptPath,
      ...(args ?? ['--secret-header', SECRET_ARG]),
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    // The child may exit before stdin is written (the no-daemon fast path) — that EPIPE is
    // the runner's to swallow, exactly as Claude Code does.
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(payload);
  });
}

interface CapturedRequest {
  headers: IncomingMessage['headers'];
  body: string;
}

/** A real loopback receiver stand-in: captures every request, answers with `responseBody`
 *  after `delayMs`. */
function startServer(
  responseBody: string,
  delayMs = 0,
): Promise<{ server: Server; port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      requests.push({ headers: req.headers, body });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(responseBody);
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('unreachable');
      resolve({ server, port: address.port, requests });
    });
  });
}

describe('hook forwarder script', () => {
  let dataDir: string;
  let scriptPath: string;

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'cctl-fwd-'));
    scriptPath = hookForwarderPath(dataDir);
    await writeHookForwarder(scriptPath);
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 });
  });

  it('writeHookForwarder writes the script verbatim', async () => {
    expect(await readFile(scriptPath, 'utf8')).toBe(HOOK_FORWARDER_SOURCE);
  });

  it('no endpoint file → exits 0 silently without any network', async () => {
    const result = await runForwarder(scriptPath, '{"hook_event_name":"PostToolUse"}');
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('daemon up → forwards the payload with the secret header and prints the response verbatim', async () => {
    const { server, port, requests } = await startServer('{"decision":"block","reason":"go"}');
    try {
      await writeHookEndpoint(hookEndpointPath(dataDir), { port });
      const payload = '{"hook_event_name":"Stop","session_id":"s-1"}';
      const result = await runForwarder(scriptPath, payload);
      expect(result).toEqual({
        code: 0,
        stdout: '{"decision":"block","reason":"go"}',
        stderr: '',
      });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.body).toBe(payload);
      expect(requests[0]?.headers['x-claude-control-secret']).toBe('shh');
      expect(requests[0]?.headers['content-type']).toBe('application/json');
    } finally {
      server.close();
    }
  });

  it('a response slower than the connect timeout is still delivered — the timeout bounds the CONNECT only', async () => {
    // 1s delay ≫ the script's 400ms connect timeout; a total-time cap would sever this
    // (and with it every held-permission long-poll).
    const { server, port } = await startServer('{"ok":true}', 1000);
    try {
      await writeHookEndpoint(hookEndpointPath(dataDir), { port });
      const result = await runForwarder(scriptPath, '{"hook_event_name":"PermissionRequest"}');
      expect(result).toEqual({ code: 0, stdout: '{"ok":true}', stderr: '' });
    } finally {
      server.close();
    }
  }, 15_000);

  it('endpoint file pointing at a dead port → exits 0 silently and removes the stale file', async () => {
    // Grab a real ephemeral port, then close the listener so nothing answers on it.
    const { server, port } = await startServer('unused');
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await writeHookEndpoint(hookEndpointPath(dataDir), { port });

    const result = await runForwarder(scriptPath, '{"hook_event_name":"PostToolUse"}');
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    expect(existsSync(hookEndpointPath(dataDir))).toBe(false);
  }, 15_000);

  it('a corrupt endpoint file behaves like no daemon — exit 0, no crash', async () => {
    await writeFile(hookEndpointPath(dataDir), '{not json', 'utf8');
    const result = await runForwarder(scriptPath, '{}');
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('missing --secret-header argument → exits 0 without contacting the daemon', async () => {
    const { server, port, requests } = await startServer('{"ok":true}');
    try {
      await writeHookEndpoint(hookEndpointPath(dataDir), { port });
      const result = await runForwarder(scriptPath, '{}', []);
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
      expect(requests).toHaveLength(0);
    } finally {
      server.close();
    }
  });
});
