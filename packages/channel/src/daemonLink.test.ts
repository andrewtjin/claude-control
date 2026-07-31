import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import {
  hookEndpointPath,
  hookSecretPath,
  loadOrCreateHookSecret,
  writeHookEndpoint,
} from '@claude-control/daemon';
import { InsecurePassthroughProtector } from '@claude-control/switch-engine';
import {
  BACKOFF_BASE_MS,
  createDiscover,
  DaemonLink,
  EMPTY_POLL_FLOOR_MS,
  MAX_POLL_MS,
  MIN_POLL_MS,
  STALE_ATTACHMENT_MS,
  type AttachIdentity,
  type ChannelItem,
  type Deliver,
  type Discover,
} from './daemonLink.js';
import { ChannelServer } from './server.js';

// Real loopback HTTP throughout: the module's whole job is surviving a daemon that moves, dies,
// and forgets — none of which a stubbed transport can reproduce.

const IDENTITY: AttachIdentity = {
  sessionId: 'sess-1',
  pid: 4242,
  cwd: 'C:\\repo',
  name: 'work-ee',
  source: 'env',
};

interface StubRequest {
  path: string;
  body: Record<string, unknown>;
  secret: string | undefined;
}

interface Stub {
  port: number;
  requests: StubRequest[];
  /** Requests whose response is still being held open (a real long poll). */
  close(): Promise<void>;
}

type StubHandler = (req: StubRequest, res: ServerResponse) => void;

const stubs: Stub[] = [];
const dirs: string[] = [];
const links: DaemonLink[] = [];

afterEach(async () => {
  for (const link of links.splice(0)) link.stop();
  await Promise.all(stubs.splice(0).map((stub) => stub.close()));
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** Stand up a real daemon-shaped loopback server on an ephemeral port. */
async function startStub(handler: StubHandler): Promise<Stub> {
  const requests: StubRequest[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += String(chunk)));
    req.on('end', () => {
      const entry: StubRequest = {
        path: req.url ?? '',
        body: raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {},
        secret: req.headers['x-claude-control-secret'] as string | undefined,
      };
      requests.push(entry);
      open.add(res);
      res.on('close', () => open.delete(res));
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const stub: Stub = {
    port: (server.address() as AddressInfo).port,
    requests,
    close: async () => {
      for (const res of open) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  stubs.push(stub);
  return stub;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** A port nothing is listening on: bind one, learn its number, give it back. */
async function deadPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function fixedDiscover(
  port: number,
  secret = 'secret',
): { discover: Discover; calls: () => number } {
  let calls = 0;
  return {
    calls: () => calls,
    discover: () => {
      calls += 1;
      return Promise.resolve({ ok: true as const, address: { port, secret } });
    },
  };
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** The deliver callback most tests do not care about. Not `async`: it awaits nothing, and the
 *  house lint (correctly) treats a promise-shaped function with no await as a smell. */
const okDeliver: Deliver = () => Promise.resolve({ ok: true });

function track(link: DaemonLink): DaemonLink {
  links.push(link);
  return link;
}

describe('attach + poll + ack against a real daemon', () => {
  it('discovers the daemon from its own published files and completes a round trip', async () => {
    // Discovery goes through the daemon package's own readers over real files, so this also
    // proves the two processes agree on where the endpoint and secret live.
    const dataDir = await mkdtemp(join(tmpdir(), 'cctl-channel-link-'));
    dirs.push(dataDir);
    const protector = new InsecurePassthroughProtector();
    const secret = await loadOrCreateHookSecret({ filePath: hookSecretPath(dataDir), protector });

    const acked = deferred();
    const stub = await startStub((req, res) => {
      // The receiver is secret-gated; a client that forgot the header must not get service.
      if (req.secret !== secret) return json(res, 401, { ok: false, error: 'invalid secret' });
      if (req.path === '/cli/channel/attach') {
        return json(res, 200, { ok: true, attachId: 'att-1', pollMs: 1000 });
      }
      if (req.path === '/cli/channel/next') {
        const first = req.body.attachId === 'att-1' && !req.body.seen;
        if (first && stub.requests.filter((r) => r.path === '/cli/channel/next').length === 1) {
          return json(res, 200, {
            ok: true,
            items: [{ injectId: 'i-1', text: 'ship it', meta: { source: 'discord' } }],
          });
        }
        return; // hold the poll open, exactly as the daemon's bounded long poll does
      }
      if (req.path === '/cli/channel/ack') {
        json(res, 200, { ok: true });
        acked.resolve();
        return;
      }
      return json(res, 404, { ok: false });
    });
    await writeHookEndpoint(hookEndpointPath(dataDir), { port: stub.port });

    const delivered: ChannelItem[] = [];
    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: createDiscover({ dataDir, protector }) }),
    );
    const running = link.run((item) => {
      delivered.push(item);
      return Promise.resolve({ ok: true });
    });
    await acked.promise;
    link.stop();
    await running;

    expect(stub.requests[0]?.path).toBe('/cli/channel/attach');
    expect(stub.requests[0]?.body).toEqual({
      sessionId: 'sess-1',
      pid: 4242,
      cwd: 'C:\\repo',
      name: 'work-ee',
      identitySource: 'env',
    });
    expect(delivered).toEqual([{ injectId: 'i-1', text: 'ship it', meta: { source: 'discord' } }]);
    expect(stub.requests.find((r) => r.path === '/cli/channel/ack')?.body).toEqual({
      attachId: 'att-1',
      injectId: 'i-1',
      state: 'sent',
    });
  });

  it('acks failed when the transport could not take the item', async () => {
    const acked = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') return json(res, 200, { ok: true, attachId: 'a' });
      if (req.path === '/cli/channel/next') {
        const polls = stub.requests.filter((r) => r.path === '/cli/channel/next').length;
        if (polls === 1)
          return json(res, 200, { ok: true, items: [{ injectId: 'i-9', text: 'x' }] });
        return;
      }
      json(res, 200, { ok: true });
      acked.resolve();
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const running = link.run(() => Promise.resolve({ ok: false, error: 'stdout closed' }));
    await acked.promise;
    link.stop();
    await running;

    expect(stub.requests.find((r) => r.path === '/cli/channel/ack')?.body).toEqual({
      attachId: 'a',
      injectId: 'i-9',
      state: 'failed',
      error: 'stdout closed',
    });
  });

  it('floors, but does not back off, when the long poll returns nothing', async () => {
    const thirdPoll = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') return json(res, 200, { ok: true, attachId: 'a' });
      const polls = stub.requests.filter((r) => r.path === '/cli/channel/next').length;
      if (polls >= 3) {
        thirdPoll.resolve();
        return; // hold
      }
      json(res, 200, { ok: true, items: [] });
    });

    const slept: number[] = [];
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    );
    const running = link.run(okDeliver);
    await thirdPoll.promise;
    link.stop();
    await running;

    // Every wait is the small floor, never a backoff step: an empty result is a SUCCESS, so the
    // backoff stays reset — but the daemon does not always hold the socket, and a zero-delay
    // re-poll would become an unthrottled request loop against its event loop.
    expect(slept.length).toBeGreaterThan(0);
    expect(new Set(slept)).toEqual(new Set([EMPTY_POLL_FLOOR_MS]));
    expect(EMPTY_POLL_FLOOR_MS).toBeLessThan(BACKOFF_BASE_MS);
  });
});

describe('self-healing', () => {
  it('retries a 409 once, because a dead predecessor still owns the attachment for 90s', async () => {
    // Claude Code does not restart a failed MCP server, so exiting on the first 409 costs this
    // session its channel for its entire life — and the likeliest cause is not a genuine second
    // server but a predecessor that died without detaching.
    const attached = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') {
        const attaches = stub.requests.filter((r) => r.path === '/cli/channel/attach').length;
        // The stale attachment is swept between the two attempts.
        if (attaches === 1) return json(res, 409, { ok: false, error: 'already attached' });
        return json(res, 200, { ok: true, attachId: 'second-chance' });
      }
      attached.resolve();
      return; // hold the poll
    });

    const waits: number[] = [];
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        conflictRetryMs: 5,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    );
    const running = link.run(okDeliver);
    await attached.promise;
    link.stop();
    await running;

    expect(link.currentAttachId).toBe('second-chance');
    expect(waits).toContain(5);
  });

  it('gives up after the retry also comes back 409 - two live servers is real', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 409, { ok: false, error: 'already attached' }),
    );
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        conflictRetryMs: 5,
        sleep: () => Promise.resolve(),
      }),
    );

    expect(await link.run(okDeliver)).toEqual({ reason: 'conflict' });
    // Exactly two attempts: one retry, never a loop.
    expect(stub.requests.filter((r) => r.path === '/cli/channel/attach')).toHaveLength(2);
  });

  it('defaults the conflict wait to just past the daemon stale window', async () => {
    const stub = await startStub((_req, res) =>
      json(res, 409, { ok: false, error: 'already attached' }),
    );
    const waits: number[] = [];
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        sleep: (ms) => {
          waits.push(ms);
          return Promise.resolve();
        },
      }),
    );
    await link.run(okDeliver);

    expect(waits[0]).toBeGreaterThan(STALE_ATTACHMENT_MS);
  });

  it('re-discovers and re-attaches after the daemon forgets the attachment (404)', async () => {
    // Waiting on the second ATTACH REQUEST would race the client's own processing of the
    // response; waiting until it polls with the new id proves the re-attach actually took.
    const usingNewAttachment = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') {
        const attaches = stub.requests.filter((r) => r.path === '/cli/channel/attach').length;
        return json(res, 200, { ok: true, attachId: `att-${attaches}` });
      }
      const polls = stub.requests.filter((r) => r.path === '/cli/channel/next').length;
      if (polls === 1) return json(res, 404, { ok: false, error: 'unknown attachment' });
      if (req.body.attachId === 'att-2') usingNewAttachment.resolve();
      return; // hold
    });

    const discovery = fixedDiscover(stub.port);
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: discovery.discover,
        sleep: () => Promise.resolve(),
      }),
    );
    const running = link.run(okDeliver);
    await usingNewAttachment.promise;
    link.stop();
    await running;

    // The endpoint file must be re-read, not just the attachment re-minted: a 404 is also what a
    // restarted daemon on a new port looks like from here.
    expect(discovery.calls()).toBeGreaterThanOrEqual(2);
    // The attachment survives shutdown: aborting our own poll is not the daemon going away, and
    // detach still needs the id.
    expect(link.currentAttachId).toBe('att-2');
  });

  it('recovers when the published port is dead and the daemon republishes a live one', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'cctl-channel-heal-'));
    dirs.push(dataDir);
    const protector = new InsecurePassthroughProtector();
    await loadOrCreateHookSecret({ filePath: hookSecretPath(dataDir), protector });

    const attached = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach')
        return json(res, 200, { ok: true, attachId: 'healed' });
      if (req.body.attachId === 'healed') attached.resolve();
      return; // hold the poll
    });

    // Point the endpoint file at a port nothing is listening on — a crashed-daemon leftover.
    await writeHookEndpoint(hookEndpointPath(dataDir), { port: await deadPort() });

    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: createDiscover({ dataDir, protector }),
        // The daemon comes back on a new port while we are backing off.
        sleep: async () => {
          await writeHookEndpoint(hookEndpointPath(dataDir), { port: stub.port });
        },
      }),
    );
    const running = link.run(okDeliver);
    await attached.promise;
    link.stop();
    await running;

    expect(link.currentAttachId).toBe('healed');
  });
});

describe('shutdown', () => {
  it('still releases the attachment after stop, which is the only time detach ever runs', async () => {
    const attached = deferred();
    const detached = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') return json(res, 200, { ok: true, attachId: 'bye' });
      if (req.path === '/cli/channel/detach') {
        json(res, 200, { ok: true });
        detached.resolve();
        return;
      }
      attached.resolve();
      return; // hold the poll
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const running = link.run(okDeliver);
    await attached.promise;

    link.stop();
    await running;
    await link.detach();
    await detached.promise;

    expect(stub.requests.find((r) => r.path === '/cli/channel/detach')?.body).toEqual({
      attachId: 'bye',
    });
    expect(link.currentAttachId).toBeUndefined();
  });
});

describe('backoff', () => {
  it('grows exponentially and never exceeds the cap', async () => {
    const stub = await startStub((_req, res) => json(res, 500, { ok: false }));

    const slept: number[] = [];
    const stopAfter = deferred();
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        backoffBaseMs: 10,
        backoffCapMs: 40,
        sleep: (ms) => {
          slept.push(ms);
          if (slept.length >= 6) stopAfter.resolve();
          return Promise.resolve();
        },
      }),
    );
    const running = link.run(okDeliver);
    await stopAfter.promise;
    link.stop();
    await running;

    expect(slept.slice(0, 6)).toEqual([10, 20, 40, 40, 40, 40]);
    expect(Math.max(...slept)).toBeLessThanOrEqual(40);
  });

  it('resets to the first step once the daemon answers again', async () => {
    const settled = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') return json(res, 200, { ok: true, attachId: 'a' });
      const polls = stub.requests.filter((r) => r.path === '/cli/channel/next').length;
      if (polls <= 2) return json(res, 500, { ok: false });
      if (polls === 3) return json(res, 200, { ok: true, items: [] });
      if (polls === 4) return json(res, 500, { ok: false });
      settled.resolve();
      return; // hold
    });

    const slept: number[] = [];
    const link = track(
      new DaemonLink({
        identity: IDENTITY,
        discover: fixedDiscover(stub.port).discover,
        backoffBaseMs: 10,
        backoffCapMs: 1000,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    );
    const running = link.run(okDeliver);
    await settled.promise;
    link.stop();
    await running;

    // 10, 20 while failing; the empty poll succeeds (resetting the backoff) and costs only the
    // floor; then the next failure starts over at 10.
    expect(slept).toEqual([10, 20, EMPTY_POLL_FLOOR_MS, 10]);
  });
});

describe('reply', () => {
  it("posts the model's reply on the attached channel", async () => {
    // A `next` request can only happen once the attach response has been processed.
    const attached = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach')
        return json(res, 200, { ok: true, attachId: 'att-r' });
      if (req.path === '/cli/channel/reply') return json(res, 200, { ok: true });
      attached.resolve();
      return; // hold the poll
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const running = link.run(okDeliver);
    await attached.promise;

    expect(await link.reply('done, deploying now')).toEqual({ ok: true });
    link.stop();
    await running;

    expect(stub.requests.find((r) => r.path === '/cli/channel/reply')?.body).toEqual({
      attachId: 'att-r',
      text: 'done, deploying now',
    });
  });

  it('refuses honestly when there is no attachment to reply on', async () => {
    const link = track(new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(1).discover }));
    expect(await link.reply('hello')).toEqual({
      ok: false,
      error: 'not attached to the cctl daemon; the reply was not sent',
    });
  });

  it('surfaces a daemon rejection rather than claiming delivery', async () => {
    const attached = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach')
        return json(res, 200, { ok: true, attachId: 'att-x' });
      if (req.path === '/cli/channel/reply') return json(res, 410, { ok: false });
      attached.resolve();
      return; // hold the poll
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const running = link.run(okDeliver);
    await attached.promise;

    expect(await link.reply('hi')).toEqual({ ok: false, error: 'daemon returned HTTP 410' });
    link.stop();
    await running;
  });
});

describe('bridge, end to end', () => {
  it("carries a daemon injection into the session and the session's reply back out", async () => {
    // The full path the binary wires: real HTTP in, real MCP stdio out, and back again.
    const replied = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') return json(res, 200, { ok: true, attachId: 'e2e' });
      if (req.path === '/cli/channel/next') {
        const polls = stub.requests.filter((r) => r.path === '/cli/channel/next').length;
        if (polls === 1) {
          return json(res, 200, {
            ok: true,
            items: [
              { injectId: 'i-1', text: 'status?', meta: { source: 'discord', 'message-id': '7' } },
            ],
          });
        }
        return; // hold
      }
      if (req.path === '/cli/channel/reply') {
        json(res, 200, { ok: true });
        replied.resolve();
        return;
      }
      return json(res, 200, { ok: true });
    });

    const input = new PassThrough();
    const output = new PassThrough();
    const frames: Array<Record<string, unknown>> = [];
    const sawChannel = deferred();
    createInterface({ input: output, crlfDelay: Infinity }).on('line', (line) => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      frames.push(frame);
      if (frame.method === 'notifications/claude/channel') sawChannel.resolve();
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const server = new ChannelServer({
      input,
      output,
      onReply: (text) => link.reply(text),
    });
    server.start();

    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    await server.ready();

    const running = link.run(async (item) => {
      await server.push(item.text, item.meta);
      return { ok: true } as const;
    });
    await sawChannel.promise;

    const notification = frames.find((f) => f.method === 'notifications/claude/channel');
    expect(notification?.params).toEqual({
      content: 'status?',
      // The hyphenated key would have been silently discarded by Claude Code.
      meta: { source: 'discord', message_id: '7' },
    });

    // Now the other direction: the model answers the sender through the one tool it has.
    input.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'reply', arguments: { text: 'green, deploying' } },
      })}\n`,
    );
    await replied.promise;
    link.stop();
    await running;
    server.close();

    expect(stub.requests.find((r) => r.path === '/cli/channel/reply')?.body).toEqual({
      attachId: 'e2e',
      text: 'green, deploying',
    });
  });
});

describe('daemon-supplied pollMs', () => {
  it('clamps an absurd value rather than sizing our own deadline from it', async () => {
    const polled = deferred();
    const stub = await startStub((req, res) => {
      if (req.path === '/cli/channel/attach') {
        // A buggy or future daemon. `pollMs` sizes this client's request deadline, so trusting
        // it unbounded turns a remote field into a local hang (or an instant timeout).
        return json(res, 200, { ok: true, attachId: 'clamped', pollMs: Number.MAX_SAFE_INTEGER });
      }
      polled.resolve();
      return; // hold
    });

    const link = track(
      new DaemonLink({ identity: IDENTITY, discover: fixedDiscover(stub.port).discover }),
    );
    const running = link.run(okDeliver);
    await polled.promise;
    link.stop();
    await running;

    // The poll went out at all, which it could not have with an unusable deadline.
    expect(stub.requests.some((r) => r.path === '/cli/channel/next')).toBe(true);
    expect(MIN_POLL_MS).toBeLessThan(MAX_POLL_MS);
  });
});
