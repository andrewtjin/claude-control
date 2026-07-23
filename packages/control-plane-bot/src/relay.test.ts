// Real in-process ws round-trip tests. Deliberately avoids mocking the socket layer — the
// properties under test (handshake accept/reject, cross-user routing isolation, invalid-
// frame dropping, no fabricated approvals) are exactly the properties a mocked transport
// would be too forgiving to catch.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import {
  encode,
  stamp,
  decode,
  PROTOCOL_VERSION,
  type Envelope,
  type EnvelopeDraft,
} from '@claude-control/shared-protocol';
import { BindingStore } from './bindings.js';
import { PairingService } from './pairing.js';
import { hashToken, mintToken } from './tokens.js';
import { RelayServer, type DiscordGateway, type SendResult } from './relay.js';

/** Collects every envelope delivered to it and exposes a way to await N of them, so tests
 *  don't have to race the relay's internal async handling with a fixed sleep. Also records
 *  every `sendPrimer` call (the post-pairing DM), which fires from a fire-and-forget path in
 *  relay.ts, so tests need the same wait-for-count treatment to observe it deterministically. */
function createFakeGateway() {
  const deliveries: { discordUserId: string; envelope: Envelope }[] = [];
  const primers: string[] = [];
  let onDeliver: (() => void) | undefined;
  let onPrimer: (() => void) | undefined;
  const gateway: DiscordGateway = {
    deliver(discordUserId, envelope) {
      deliveries.push({ discordUserId, envelope });
      onDeliver?.();
    },
    sendPrimer(discordUserId) {
      primers.push(discordUserId);
      onPrimer?.();
    },
  };
  async function waitForCount(n: number, timeoutMs = 2000): Promise<void> {
    if (deliveries.length >= n) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('timed out waiting for delivery')),
        timeoutMs,
      );
      onDeliver = () => {
        if (deliveries.length >= n) {
          clearTimeout(timer);
          onDeliver = undefined;
          resolve();
        }
      };
    });
  }
  async function waitForPrimerCount(n: number, timeoutMs = 2000): Promise<void> {
    if (primers.length >= n) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for primer')), timeoutMs);
      onPrimer = () => {
        if (primers.length >= n) {
          clearTimeout(timer);
          onPrimer = undefined;
          resolve();
        }
      };
    });
  }
  return { gateway, deliveries, primers, waitForCount, waitForPrimerCount };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Envelope> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), timeoutMs);
    ws.once('message', (raw) => {
      clearTimeout(timer);
      // Buffer | ArrayBuffer | Buffer[] depending on framing — normalize before decoding.
      const text = Array.isArray(raw)
        ? Buffer.concat(raw).toString('utf8')
        : raw instanceof ArrayBuffer
          ? Buffer.from(raw).toString('utf8')
          : raw.toString('utf8');
      const decoded = decode(text);
      if (!decoded.ok) {
        reject(new Error(`received undecodable frame: ${decoded.error}`));
        return;
      }
      resolve(decoded.envelope);
    });
  });
}

/** Waits `ms` for a message to arrive and reports which happened first, WITHOUT leaving a
 *  dangling listener behind either way — a single timer, explicit removal on timeout, so a
 *  later `nextMessage()` call on the same socket can't be starved by an orphaned listener. */
function expectSilenceFor(ws: WebSocket, ms: number): Promise<'silence' | 'message'> {
  return new Promise((resolve) => {
    const onMessage = () => {
      clearTimeout(timer);
      resolve('message');
    };
    const timer = setTimeout(() => {
      ws.removeListener('message', onMessage);
      resolve('silence');
    }, ms);
    ws.once('message', onMessage);
  });
}

function waitForClose(ws: WebSocket, timeoutMs = 2000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.once('close', (code) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function sendEnvelope(ws: WebSocket, draft: EnvelopeDraft): void {
  ws.send(encode(stamp(draft)));
}

describe('RelayServer', () => {
  let bindings: BindingStore;
  let pairing: PairingService;
  let fake: ReturnType<typeof createFakeGateway>;
  let relay: RelayServer;
  let port: number;

  beforeEach(async () => {
    bindings = new BindingStore();
    pairing = new PairingService({ bindings });
    fake = createFakeGateway();
    relay = new RelayServer({ bindings, pairing, gateway: fake.gateway, heartbeatMs: 0, port: 0 });
    port = await relay.listen();
  });

  afterEach(async () => {
    await relay.close();
  });

  /** Convenience: bind a daemon directly (bypassing the /pair flow) for tests that only
   *  care about post-handshake behavior. */
  async function bindDaemon(discordUserId: string, daemonId: string, hostLabel = 'host') {
    const token = mintToken();
    await bindings.bind(discordUserId, daemonId, await hashToken(token), hostLabel, Date.now());
    return token;
  }

  describe('handshake', () => {
    it('accepts a hello with a valid token and negotiated version', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      const result = await nextMessage(ws);
      expect(result.type).toBe('hello.result');
      if (result.type !== 'hello.result') throw new Error('unreachable');
      expect(result.payload).toEqual({ ok: true, negotiatedVersion: PROTOCOL_VERSION });
      ws.close();
    });

    it('a reconnect stays reachable: a late close from the superseded socket does not evict the new one', async () => {
      // Reproduces the self-eviction race: daemon connects, then reconnects (same id); the old
      // socket's async 'close' arrives AFTER the new socket is registered. The identity-scoped
      // cleanup must leave the new connection in place so user->daemon commands still route.
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws1 = await connect(port);
      sendEnvelope(ws1, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws1); // hello.result ok

      const ws2 = await connect(port);
      sendEnvelope(ws2, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws2); // new socket authenticated; server terminates ws1
      await waitForClose(ws1);
      // Give the server's close handler for the old socket time to run (it must be a no-op).
      await new Promise((r) => setTimeout(r, 100));

      // The daemon is still reachable for user->daemon commands via the NEW socket.
      const sent = relay.sendToUser('user-a', (daemonId) => ({
        daemonId,
        type: 'ping',
        payload: {},
      }));
      expect(sent).toEqual({ ok: true });
      const received = await nextMessage(ws2);
      expect(received.type).toBe('ping');
      ws2.close();
    });

    it('rejects a hello with a wrong token and closes the socket', async () => {
      await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: mintToken() },
      });
      const [result, closeCode] = await Promise.all([nextMessage(ws), waitForClose(ws)]);
      expect(result.type).toBe('hello.result');
      if (result.type !== 'hello.result') throw new Error('unreachable');
      expect(result.payload.ok).toBe(false);
      expect(closeCode).toBe(4003);
    });

    it('rejects a hello for a daemon id with no binding at all', async () => {
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'never-paired',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: mintToken() },
      });
      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(4003);
    });

    it('refuses any first frame that is not hello or pair.claim', async () => {
      await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, { daemonId: 'daemon-1', type: 'ping', payload: {} });
      const closeCode = await waitForClose(ws);
      expect(closeCode).toBe(4001);
    });

    it('drops an undecodable frame instead of crashing the connection', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      ws.send('not even json');
      // The connection must still be usable afterward — a bad frame is dropped, not fatal.
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      const result = await nextMessage(ws);
      expect(result.type).toBe('hello.result');
      if (result.type !== 'hello.result') throw new Error('unreachable');
      expect(result.payload.ok).toBe(true);
      ws.close();
    });
  });

  describe('routing', () => {
    it('delivers a daemon-originated envelope to the ONE bound user, with discordUserId stamped', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws); // hello.result

      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hook.notification',
        payload: { event: 'notification', title: 'hi', body: 'there', level: 'info' },
      });
      await fake.waitForCount(1);
      expect(fake.deliveries).toHaveLength(1);
      expect(fake.deliveries[0]?.discordUserId).toBe('user-a');
      expect(fake.deliveries[0]?.envelope.discordUserId).toBe('user-a');
      ws.close();
    });

    it('never delivers user A daemon traffic under user B identity (cross-user isolation)', async () => {
      const tokenA = await bindDaemon('user-a', 'daemon-1');
      const tokenB = await bindDaemon('user-b', 'daemon-2');
      const wsA = await connect(port);
      const wsB = await connect(port);
      sendEnvelope(wsA, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: tokenA },
      });
      sendEnvelope(wsB, {
        daemonId: 'daemon-2',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: tokenB },
      });
      await Promise.all([nextMessage(wsA), nextMessage(wsB)]);

      sendEnvelope(wsA, {
        daemonId: 'daemon-1',
        type: 'hook.notification',
        payload: { event: 'stop', title: 'A', body: 'from A', level: 'info' },
      });
      await fake.waitForCount(1);

      expect(fake.deliveries).toHaveLength(1);
      expect(fake.deliveries[0]?.discordUserId).toBe('user-a');
      expect(fake.deliveries[0]?.envelope.discordUserId).not.toBe('user-b');
      wsA.close();
      wsB.close();
    });

    it('sendToUser only ever reaches the daemon owned by that user', async () => {
      const tokenA = await bindDaemon('user-a', 'daemon-1');
      const tokenB = await bindDaemon('user-b', 'daemon-2');
      const wsA = await connect(port);
      const wsB = await connect(port);
      sendEnvelope(wsA, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: tokenA },
      });
      sendEnvelope(wsB, {
        daemonId: 'daemon-2',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: tokenB },
      });
      await Promise.all([nextMessage(wsA), nextMessage(wsB)]);

      const bMessage = nextMessage(wsB);
      const result = relay.sendToUser('user-b', (daemonId) => ({
        daemonId,
        type: 'switch.command',
        payload: {
          requestId: 'r1',
          targetAccountId: 'acct-1',
          reason: 'manual',
          idempotencyKey: 'k1',
        },
      }));
      expect(result).toEqual({ ok: true });
      const received = await bMessage;
      expect(received.type).toBe('switch.command');
      expect(received.daemonId).toBe('daemon-2'); // never daemon-1, which user-b does not own

      wsA.close();
      wsB.close();
    });

    it('sendToUser fails cleanly for a user with no bound daemon', () => {
      const result = relay.sendToUser('nobody', (daemonId) => ({
        daemonId,
        type: 'ping',
        payload: {},
      }));
      expect(result).toEqual({ ok: false, error: 'no daemon is paired to this account' });
    });

    it('drops an invalid frame from an authenticated daemon without delivering anything', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws);

      ws.send(JSON.stringify({ garbage: true }));
      // Prove the socket is still alive and routes normally afterward.
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hook.notification',
        payload: { event: 'notification', title: 'still alive', body: 'ok', level: 'info' },
      });
      await fake.waitForCount(1);
      expect(fake.deliveries).toHaveLength(1);
      ws.close();
    });

    it('never synthesizes a permission.response — it only forwards what a caller sends', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws);

      // The daemon reports a permission.request; nobody ever answers it via sendToUser.
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'permission.request',
        payload: {
          requestId: 'unanswered-req',
          sessionId: 's1',
          tool: 'bash',
          summary: 'run a command',
        },
      });
      await fake.waitForCount(1);

      // Nothing further should ever arrive at the daemon on its own — the relay has no
      // notion of "pending requests" and cannot invent an approval or denial for one.
      expect(await expectSilenceFor(ws, 300)).toBe('silence');

      // A real permission.response, when a caller does send one, is forwarded verbatim.
      const forwarded = nextMessage(ws);
      const sent = relay.sendToUser('user-a', (daemonId) => ({
        daemonId,
        type: 'permission.response',
        payload: {
          requestId: 'unrelated-request-id',
          decision: 'allow',
          scope: 'once',
          idempotencyKey: 'k',
        },
      }));
      expect(sent).toEqual({ ok: true });
      const received = await forwarded;
      expect(received.type).toBe('permission.response');
      if (received.type !== 'permission.response') throw new Error('unreachable');
      expect(received.payload.requestId).toBe('unrelated-request-id');
      ws.close();
    });

    it('replies to ping with pong, preserving the nonce', async () => {
      const token = await bindDaemon('user-a', 'daemon-1');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-1',
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
      });
      await nextMessage(ws);

      const pong = nextMessage(ws);
      sendEnvelope(ws, { daemonId: 'daemon-1', type: 'ping', payload: { nonce: 'abc123' } });
      const received = await pong;
      expect(received.type).toBe('pong');
      if (received.type !== 'pong') throw new Error('unreachable');
      expect(received.payload.nonce).toBe('abc123');
      ws.close();
    });
  });

  describe('pairing over the socket', () => {
    it('claims a code, mints a token, and the daemon can then reconnect with hello', async () => {
      const code = pairing.createCode('user-a');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-new',
        type: 'pair.claim',
        payload: { pairingCode: code, hostLabel: 'fresh-host' },
      });
      const [result, closeCode] = await Promise.all([nextMessage(ws), waitForClose(ws)]);
      expect(result.type).toBe('pair.result');
      if (result.type !== 'pair.result') throw new Error('unreachable');
      expect(result.payload.ok).toBe(true);
      expect(result.payload.discordUserId).toBe('user-a');
      const token = result.payload.daemonToken;
      expect(typeof token).toBe('string');
      // The bot MINTS the daemon id; it is not the 'daemon-new' the client proposed. The
      // daemon must adopt this assigned id for its real connection.
      const assignedId = result.payload.daemonId;
      expect(typeof assignedId).toBe('string');
      expect(assignedId).not.toBe('daemon-new');
      expect(closeCode).toBe(1000); // pairing closes the socket; the daemon must reconnect

      const ws2 = await connect(port);
      sendEnvelope(ws2, {
        daemonId: assignedId as string,
        type: 'hello',
        payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token as string },
      });
      const helloResult = await nextMessage(ws2);
      expect(helloResult.type).toBe('hello.result');
      if (helloResult.type !== 'hello.result') throw new Error('unreachable');
      expect(helloResult.payload.ok).toBe(true);
      ws2.close();
    });

    it('rejects an invalid pairing code and closes', async () => {
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-x',
        type: 'pair.claim',
        payload: { pairingCode: '000000', hostLabel: 'host' },
      });
      const [result, closeCode] = await Promise.all([nextMessage(ws), waitForClose(ws)]);
      expect(result.type).toBe('pair.result');
      if (result.type !== 'pair.result') throw new Error('unreachable');
      expect(result.payload.ok).toBe(false);
      expect(closeCode).toBe(1000);
    });

    it('DMs the pairing primer to the owning user on a successful claim', async () => {
      const code = pairing.createCode('user-a');
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-new',
        type: 'pair.claim',
        payload: { pairingCode: code, hostLabel: 'fresh-host' },
      });
      await nextMessage(ws);
      await fake.waitForPrimerCount(1);
      expect(fake.primers).toEqual(['user-a']);
      ws.close();
    });

    it('never sends a primer for a rejected claim', async () => {
      const ws = await connect(port);
      sendEnvelope(ws, {
        daemonId: 'daemon-x',
        type: 'pair.claim',
        payload: { pairingCode: '000000', hostLabel: 'host' },
      });
      await nextMessage(ws);
      // No successful pairing occurred, so nothing should ever arrive — give the
      // fire-and-forget primer path a beat to run before asserting silence.
      await new Promise((r) => setTimeout(r, 100));
      expect(fake.primers).toEqual([]);
      ws.close();
    });
  });

  describe('/health', () => {
    it('responds 200 with a JSON body on GET /health', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body: unknown = await res.json();
      expect(body).toEqual({ ok: true });
    });

    it('responds 404 for any other path', async () => {
      const res = await fetch(`http://127.0.0.1:${port}/nope`);
      expect(res.status).toBe(404);
    });

    it('never requires daemon credentials — no auth header, no pairing state needed', async () => {
      // Nothing was paired or bound in this test at all; the probe must still answer.
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
    });
  });
});

describe('RelayServer frame-size limit', () => {
  // A dedicated server with a tiny cap so the bound can be exercised without allocating a
  // multi-MiB payload. The default is 4 MiB (MAX_FRAME_BYTES) in production; the property under
  // test is that an oversized frame is refused at the protocol layer BEFORE it is buffered and
  // parsed — the pre-auth memory-amplification guard.
  let bindings: BindingStore;
  let pairing: PairingService;
  let fake: ReturnType<typeof createFakeGateway>;
  let relay: RelayServer;
  let port: number;

  beforeEach(async () => {
    bindings = new BindingStore();
    pairing = new PairingService({ bindings });
    fake = createFakeGateway();
    relay = new RelayServer({
      bindings,
      pairing,
      gateway: fake.gateway,
      heartbeatMs: 0,
      port: 0,
      maxFrameBytes: 1024,
    });
    port = await relay.listen();
  });

  afterEach(async () => {
    await relay.close();
  });

  it('closes the socket with 1009 when an unauthenticated frame exceeds the cap', async () => {
    const ws = await connect(port);
    const closed = waitForClose(ws);
    // 2 KiB > the 1 KiB cap; the frame is over-limit before any hello/pair.claim is even parsed.
    ws.send('x'.repeat(2048));
    // 1009 = "message too big" (ws refuses the frame at the protocol layer).
    expect(await closed).toBe(1009);
  });

  it('still accepts a normal, well-under-cap frame', async () => {
    const token = mintToken();
    await bindings.bind('user-a', 'daemon-1', await hashToken(token), 'host', Date.now());
    const ws = await connect(port);
    sendEnvelope(ws, {
      daemonId: 'daemon-1',
      type: 'hello',
      payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
    });
    const result = await nextMessage(ws);
    expect(result.type).toBe('hello.result');
    ws.close();
  });
});

describe('RelayServer pending-connection cap', () => {
  // A dedicated server with a tiny cap (2) so the unauthenticated-socket bound can be exercised
  // without opening dozens of connections. The property under test: a flood of sockets that connect
  // but never authenticate is shed once the cap is reached, and the slot returns when one leaves.
  let bindings: BindingStore;
  let pairing: PairingService;
  let fake: ReturnType<typeof createFakeGateway>;
  let relay: RelayServer;
  let port: number;

  beforeEach(async () => {
    bindings = new BindingStore();
    pairing = new PairingService({ bindings });
    fake = createFakeGateway();
    relay = new RelayServer({
      bindings,
      pairing,
      gateway: fake.gateway,
      heartbeatMs: 0,
      port: 0,
      maxPendingConnections: 2,
    });
    port = await relay.listen();
  });

  afterEach(async () => {
    await relay.close();
  });

  it('accepts up to the cap of unauthenticated sockets, then sheds the next with 1013', async () => {
    // Two sockets that connect but never say hello fill the cap; both stay open (not shed)...
    const a = await connect(port);
    const b = await connect(port);
    expect(await expectSilenceFor(a, 150)).toBe('silence');
    // ...and the third, over the cap, is closed immediately with 1013 ("try again later").
    const c = await connect(port);
    expect(await waitForClose(c)).toBe(1013);
    a.close();
    b.close();
  });

  it('frees a slot when a pending socket disconnects, so the cap self-heals', async () => {
    const a = await connect(port);
    const b = await connect(port);
    // Cap reached; drop one and let the server's close handler return its slot to the pending pool.
    a.close();
    await waitForClose(a);
    // A fresh connection is now back under the cap and must NOT be shed — it stays open. (A shed
    // socket is closed, not sent a message, so we assert readyState rather than listen for silence.)
    const c = await connect(port);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(c.readyState).toBe(WebSocket.OPEN);
    b.close();
    c.close();
  });
});

describe('RelayServer outbound backpressure cap', () => {
  // A dedicated server with a small outbound-buffer cap so a single oversized frame pushes one
  // daemon socket over it. The property under test: a daemon that has stopped draining its socket
  // is dropped as unreachable instead of letting ws buffer without bound.
  let bindings: BindingStore;
  let pairing: PairingService;
  let fake: ReturnType<typeof createFakeGateway>;
  let relay: RelayServer;
  let port: number;

  beforeEach(async () => {
    bindings = new BindingStore();
    pairing = new PairingService({ bindings });
    fake = createFakeGateway();
    relay = new RelayServer({
      bindings,
      pairing,
      gateway: fake.gateway,
      heartbeatMs: 0,
      port: 0,
      maxSocketBufferBytes: 256 * 1024,
    });
    port = await relay.listen();
  });

  afterEach(async () => {
    await relay.close();
  });

  it('drops a daemon socket whose outbound buffer exceeds the cap and reports it offline', async () => {
    const token = mintToken();
    await bindings.bind('user-a', 'daemon-1', await hashToken(token), 'host', Date.now());
    const ws = await connect(port);
    sendEnvelope(ws, {
      daemonId: 'daemon-1',
      type: 'hello',
      payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: token },
    });
    expect((await nextMessage(ws)).type).toBe('hello.result');

    // Push frames in a SYNCHRONOUS loop: sendToUser never awaits, so the event loop can't run
    // between iterations and neither the client nor the OS can drain the socket. Once cumulative
    // output overruns the kernel send/receive buffers, ws's bufferedAmount climbs past the cap and
    // the next send's guard drops the socket. A single send can't be relied on — a large loopback
    // socket buffer may absorb several MiB synchronously — so we accumulate instead, bounded so a
    // pathologically large buffer can't loop forever.
    const chunk = 'x'.repeat(4 * 1024 * 1024);
    let result: SendResult = { ok: true };
    for (let i = 0; i < 32 && result.ok; i++) {
      result = relay.sendToUser('user-a', (daemonId) => ({
        daemonId,
        type: 'session.spawn',
        payload: { requestId: `r${i}`, prompt: chunk, idempotencyKey: `i${i}` },
      }));
    }
    // The guard tripped: the stuck socket was terminated and evicted, so the daemon reads offline.
    expect(result.ok).toBe(false);
    expect(relay.isOnline('user-a')).toBe(false);
    ws.close();
  });
});
