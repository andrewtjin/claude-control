import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import {
  decode,
  encode,
  stamp,
  isType,
  negotiateVersion,
  type Envelope,
  type EnvelopeDraft,
  type MessageOf,
} from '@claude-control/shared-protocol';
import { Store } from './store.js';
import {
  ControlPlaneClient,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';

// ---------------------------------------------------------------------------
// A minimal stand-in for the bot's relay: enough of pair.claim/hello/ping semantics to
// exercise the client for real, over a real loopback socket — deliberately NOT the actual
// control-plane-bot package (that's the daemon's own dependency-direction rule: the daemon
// must never need to import the bot to test itself). Mints ids the same way the real relay
// does (server-assigned, never trusting the client's placeholder).
// ---------------------------------------------------------------------------

interface FakeRelayOptions {
  /** Pairing codes this relay will accept, mapped to the daemonId it assigns. */
  validCodes?: Map<string, string>;
  /** When true, hello always fails (simulates a version mismatch). */
  rejectHello?: boolean;
}

class FakeRelay {
  private readonly wss: WebSocketServer;
  private readonly validCodes: Map<string, string>;
  private readonly rejectHello: boolean;
  private nextDaemonSeq = 1;
  readonly tokensByDaemonId = new Map<string, string>();
  /** Every envelope any connected socket has sent us, in receipt order — lets tests assert on
   *  what the client actually put on the wire (e.g. outbox replay order). */
  readonly received: Envelope[] = [];
  private sockets: WebSocket[] = [];

  constructor(options: FakeRelayOptions = {}) {
    this.validCodes = options.validCodes ?? new Map([['code-1', 'assigned-daemon-1']]);
    this.rejectHello = options.rejectHello ?? false;
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (socket) => this.onConnection(socket));
  }

  async listen(): Promise<number> {
    if (this.wss.address()) return this.port();
    await new Promise<void>((resolve) => this.wss.once('listening', resolve));
    return this.port();
  }

  port(): number {
    const addr = this.wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    return addr.port;
  }

  url(): string {
    return `ws://127.0.0.1:${this.port()}`;
  }

  /** Forcibly drop every live connection — simulates the daemon losing its link to the bot. */
  disconnectAll(): void {
    for (const s of this.sockets) s.terminate();
    this.sockets = [];
  }

  /** Push a server->client envelope to every currently-open socket (there is normally exactly
   *  one — the daemon under test). Mirrors how the real relay routes a bot->daemon command. */
  broadcastToClient(draft: EnvelopeDraft): void {
    const raw = encode(stamp(draft));
    for (const s of this.sockets) if (s.readyState === WebSocket.OPEN) s.send(raw);
  }

  /** Push a raw (possibly-invalid) frame — for testing that garbage on the wire is dropped. */
  sendRawToClient(raw: string): void {
    for (const s of this.sockets) if (s.readyState === WebSocket.OPEN) s.send(raw);
  }

  async close(): Promise<void> {
    this.disconnectAll();
    await new Promise<void>((resolve, reject) =>
      this.wss.close((err) => (err ? reject(err) : resolve())),
    );
  }

  private onConnection(socket: WebSocket): void {
    this.sockets.push(socket);
    socket.on('message', (raw: RawData) => {
      const decoded = decode(rawToString(raw));
      if (!decoded.ok) return;
      this.received.push(decoded.envelope);
      this.onEnvelope(socket, decoded.envelope);
    });
  }

  private onEnvelope(socket: WebSocket, envelope: Envelope): void {
    if (isType(envelope, 'pair.claim')) {
      this.handlePairClaim(socket, envelope);
    } else if (isType(envelope, 'hello')) {
      this.handleHello(socket, envelope);
    } else if (isType(envelope, 'ping')) {
      socket.send(encode(stamp({ daemonId: envelope.daemonId, type: 'pong', payload: {} })));
    }
  }

  private handlePairClaim(socket: WebSocket, envelope: MessageOf<'pair.claim'>): void {
    const assigned = this.validCodes.get(envelope.payload.pairingCode);
    if (!assigned) {
      socket.send(
        encode(
          stamp({
            daemonId: envelope.daemonId,
            type: 'pair.result',
            payload: { ok: false, error: 'bad code' },
          }),
        ),
      );
      socket.close(1000, 'pairing failed');
      return;
    }
    const daemonId = assigned || `daemon-${this.nextDaemonSeq++}`;
    const daemonToken = `token-for-${daemonId}`;
    this.tokensByDaemonId.set(daemonId, daemonToken);
    socket.send(
      encode(
        stamp({
          daemonId,
          type: 'pair.result',
          payload: { ok: true, daemonId, daemonToken, discordUserId: 'user-1' },
        }),
      ),
    );
    socket.close(1000, 'pairing complete');
  }

  private handleHello(socket: WebSocket, envelope: MessageOf<'hello'>): void {
    const negotiated = negotiateVersion(envelope.payload.protocolVersion);
    const expectedToken = this.tokensByDaemonId.get(envelope.daemonId);
    if (this.rejectHello || negotiated === null || expectedToken !== envelope.payload.daemonToken) {
      socket.send(
        encode(
          stamp({
            daemonId: envelope.daemonId,
            type: 'hello.result',
            payload: { ok: false, error: 'rejected' },
          }),
        ),
      );
      socket.close(4003, 'rejected');
      return;
    }
    socket.send(
      encode(
        stamp({
          daemonId: envelope.daemonId,
          type: 'hello.result',
          payload: { ok: true, negotiatedVersion: negotiated },
        }),
      ),
    );
  }
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

/** In-memory identity store — a real daemon persists this to disk; tests don't need to. */
function memoryIdentityStore(
  initial?: DaemonIdentity,
): IdentityStore & { current: () => DaemonIdentity | undefined } {
  let stored = initial;
  return {
    load: () => Promise.resolve(stored),
    save: (identity) => {
      stored = identity;
      return Promise.resolve();
    },
    current: () => stored,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('ControlPlaneClient', () => {
  let relay: FakeRelay;
  let store: Store;
  let client: ControlPlaneClient | undefined;

  beforeEach(async () => {
    relay = new FakeRelay();
    await relay.listen();
    store = new Store(':memory:');
  });

  afterEach(async () => {
    client?.close();
    store.close();
    await relay.close();
  });

  it('first-run pairing: adopts the bot-assigned daemonId + token and persists both', async () => {
    const identityStore = memoryIdentityStore();
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'test-host',
      pairingCode: 'code-1',
      reconnectBaseMs: 10,
    });

    await client.connect();
    expect(client.getState()).toBe('open');
    expect(client.getIdentity()).toEqual({
      daemonId: 'assigned-daemon-1',
      daemonToken: 'token-for-assigned-daemon-1',
    });
    expect(identityStore.current()).toEqual(client.getIdentity());
  });

  it('steady state: hello handshake uses the ADOPTED daemonId from a persisted identity', async () => {
    const identity: DaemonIdentity = {
      daemonId: 'assigned-daemon-1',
      daemonToken: 'preexisting-token',
    };
    relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken);
    const identityStore = memoryIdentityStore(identity);
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      reconnectBaseMs: 10,
    });

    await client.connect();
    expect(client.getState()).toBe('open');

    const helloFrame = relay.received.find((e) => e.type === 'hello');
    expect(helloFrame?.daemonId).toBe('assigned-daemon-1');
  });

  it('rejects on a bad pairing code without adopting an identity', async () => {
    const identityStore = memoryIdentityStore();
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      pairingCode: 'wrong-code',
      reconnectBaseMs: 10,
    });
    await expect(client.connect()).rejects.toThrow();
    expect(identityStore.current()).toBeUndefined();
  });

  it('rejects on a hello version/token mismatch', async () => {
    const badRelay = new FakeRelay({ rejectHello: true });
    await badRelay.listen();
    try {
      const identity: DaemonIdentity = { daemonId: 'd1', daemonToken: 't1' };
      const identityStore = memoryIdentityStore(identity);
      client = new ControlPlaneClient({
        url: badRelay.url(),
        identityStore,
        store,
        hostLabel: 'h',
        reconnectBaseMs: 10,
      });
      await expect(client.connect()).rejects.toThrow();
    } finally {
      await badRelay.close();
    }
  });

  it('a permanently-rejecting hello is terminal: exactly one hello attempt, ends in rejected state', async () => {
    const badRelay = new FakeRelay({ rejectHello: true });
    await badRelay.listen();
    const rejectionLogs: string[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: (_obj: unknown, msg?: string) => {
        if (msg) rejectionLogs.push(msg);
      },
    };
    try {
      const identity: DaemonIdentity = { daemonId: 'd1', daemonToken: 't1' };
      relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken); // token valid; relay still rejects
      const identityStore = memoryIdentityStore(identity);
      client = new ControlPlaneClient({
        url: badRelay.url(),
        identityStore,
        store,
        hostLabel: 'h',
        reconnectBaseMs: 10, // small: a reconnect LOOP would fire many hellos quickly
        reconnectCapMs: 20,
        logger,
      });

      await expect(client.connect()).rejects.toThrow();
      // Give any (buggy) reconnect loop ample time to fire more hello attempts.
      await new Promise((r) => setTimeout(r, 200));

      const helloCount = badRelay.received.filter((e) => e.type === 'hello').length;
      expect(helloCount).toBe(1); // exactly once — no reconnect spin
      expect(client.getState()).toBe('rejected'); // terminal, not 'reconnecting'/'closed'
      expect(rejectionLogs.some((m) => /rejected hello/.test(m))).toBe(true);
    } finally {
      await badRelay.close();
    }
  });

  it('sends an application-level heartbeat and clears the timeout on pong', async () => {
    const identity: DaemonIdentity = { daemonId: 'assigned-daemon-1', daemonToken: 'tok' };
    relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken);
    const identityStore = memoryIdentityStore(identity);
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      heartbeatMs: 20,
      heartbeatTimeoutMs: 500,
      reconnectBaseMs: 10,
    });
    await client.connect();
    await waitFor(() => relay.received.some((e) => e.type === 'ping'));
    expect(relay.received.some((e) => e.type === 'ping')).toBe(true);
    // The client is still open (didn't self-terminate) because the fake relay answers pongs.
    await new Promise((r) => setTimeout(r, 50));
    expect(client.getState()).toBe('open');
  });

  it('buffers sends while disconnected and flushes exactly once (in order, no dupes) on reconnect', async () => {
    const identity: DaemonIdentity = { daemonId: 'assigned-daemon-1', daemonToken: 'tok' };
    relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken);
    const identityStore = memoryIdentityStore(identity);
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      heartbeatMs: 100_000, // effectively off for this test
      reconnectBaseMs: 10,
      reconnectCapMs: 50,
    });
    await client.connect();
    relay.disconnectAll();
    await waitFor(
      () => client!.getState() === 'reconnecting' || client!.getState() === 'connecting',
    );

    // Sent while disconnected — must be queued, not lost, not sent yet.
    const draft = (i: number): EnvelopeDraft => ({
      daemonId: identity.daemonId,
      type: 'hook.notification',
      payload: { event: 'notification', title: `n${i}`, body: 'x', level: 'info' },
    });
    client.send(draft(1));
    client.send(draft(2));
    client.send(draft(3));
    expect(store.countOutbox()).toBe(3);

    await waitFor(() => client!.getState() === 'open', 5000);
    await waitFor(
      () => relay.received.filter((e) => e.type === 'hook.notification').length >= 3,
      5000,
    );

    const notifications = relay.received.filter((e) => e.type === 'hook.notification');
    expect(notifications).toHaveLength(3); // exactly once each, no dupes
    if (notifications[0]?.type === 'hook.notification')
      expect(notifications[0].payload.title).toBe('n1');
    if (notifications[1]?.type === 'hook.notification')
      expect(notifications[1].payload.title).toBe('n2');
    if (notifications[2]?.type === 'hook.notification')
      expect(notifications[2].payload.title).toBe('n3');
    expect(store.countOutbox()).toBe(0);
  });

  it('bounds the outbox by dropping the oldest entries past the configured limit', () => {
    const identityStore = memoryIdentityStore(); // never connects — outbox math only
    client = new ControlPlaneClient({
      url: 'ws://127.0.0.1:1', // unreachable; irrelevant, we never connect() in this test
      identityStore,
      store,
      hostLabel: 'h',
      outboxBound: 3,
    });
    for (let i = 0; i < 5; i++) {
      client.send({
        daemonId: 'x',
        type: 'hook.notification',
        payload: { event: 'notification', title: `n${i}`, body: '', level: 'info' },
      });
    }
    expect(store.countOutbox()).toBe(3);
    const remaining = store.listOutbox().map((r) => JSON.parse(r.envelopeJson) as Envelope);
    const titles = remaining.map((e) =>
      e.type === 'hook.notification' ? e.payload.title : undefined,
    );
    expect(titles).toEqual(['n2', 'n3', 'n4']); // oldest (n0, n1) dropped
  });

  it('dispatches inbound switch.command / permission.response / prompt.inject / session.spawn / session.stop to handlers', async () => {
    const identity: DaemonIdentity = { daemonId: 'assigned-daemon-1', daemonToken: 'tok' };
    relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken);
    const identityStore = memoryIdentityStore(identity);

    const onSwitchCommand = vi.fn();
    const onPermissionResponse = vi.fn();
    const onPromptInject = vi.fn();
    const onSessionSpawn = vi.fn();
    const onSessionStop = vi.fn();

    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      reconnectBaseMs: 10,
      handlers: {
        onSwitchCommand,
        onPermissionResponse,
        onPromptInject,
        onSessionSpawn,
        onSessionStop,
      },
    });
    await client.connect();

    const send = (draft: EnvelopeDraft) => relay.broadcastToClient(draft);
    send({
      daemonId: identity.daemonId,
      type: 'switch.command',
      payload: { requestId: 'r1', targetAccountId: 'a', reason: 'manual', idempotencyKey: 'k1' },
    });
    send({
      daemonId: identity.daemonId,
      type: 'permission.response',
      payload: { requestId: 'r2', decision: 'allow', scope: 'once', idempotencyKey: 'k2' },
    });
    send({
      daemonId: identity.daemonId,
      type: 'prompt.inject',
      payload: { sessionId: 's1', text: 'hi', idempotencyKey: 'k3' },
    });
    send({
      daemonId: identity.daemonId,
      type: 'session.spawn',
      payload: { requestId: 'r3', prompt: 'do it', idempotencyKey: 'k4' },
    });
    send({
      daemonId: identity.daemonId,
      type: 'session.stop',
      payload: { sessionId: 's1', idempotencyKey: 'k5' },
    });

    await waitFor(() => onSessionStop.mock.calls.length > 0);
    expect(onSwitchCommand).toHaveBeenCalledTimes(1);
    expect(onPermissionResponse).toHaveBeenCalledTimes(1);
    expect(onPromptInject).toHaveBeenCalledTimes(1);
    expect(onSessionSpawn).toHaveBeenCalledTimes(1);
    expect(onSessionStop).toHaveBeenCalledTimes(1);
  });

  it('drops an invalid/undecodable inbound frame without crashing the connection', async () => {
    const identity: DaemonIdentity = { daemonId: 'assigned-daemon-1', daemonToken: 'tok' };
    relay.tokensByDaemonId.set(identity.daemonId, identity.daemonToken);
    const identityStore = memoryIdentityStore(identity);
    const onSwitchCommand = vi.fn();
    client = new ControlPlaneClient({
      url: relay.url(),
      identityStore,
      store,
      hostLabel: 'h',
      reconnectBaseMs: 10,
      handlers: { onSwitchCommand },
    });
    await client.connect();

    relay.sendRawToClient('not valid json {{{');
    relay.sendRawToClient(JSON.stringify({ totally: 'not an envelope' }));
    // Follow up with a VALID frame to prove the connection survived the garbage above.
    relay.broadcastToClient({
      daemonId: identity.daemonId,
      type: 'switch.command',
      payload: { requestId: 'r1', targetAccountId: 'a', reason: 'manual', idempotencyKey: 'k1' },
    });
    await waitFor(() => onSwitchCommand.mock.calls.length > 0);
    expect(client.getState()).toBe('open');
  });
});
