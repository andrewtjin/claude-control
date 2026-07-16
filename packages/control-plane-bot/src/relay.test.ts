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
import { RelayServer, type DiscordGateway } from './relay.js';

/** Collects every envelope delivered to it and exposes a way to await N of them, so tests
 *  don't have to race the relay's internal async handling with a fixed sleep. */
function createFakeGateway() {
  const deliveries: { discordUserId: string; envelope: Envelope }[] = [];
  let onDeliver: (() => void) | undefined;
  const gateway: DiscordGateway = {
    deliver(discordUserId, envelope) {
      deliveries.push({ discordUserId, envelope });
      onDeliver?.();
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
  return { gateway, deliveries, waitForCount };
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
  });
});
