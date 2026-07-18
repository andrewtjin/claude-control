// WebSocket relay: the only place a daemon socket and a Discord user are connected.
//
// Every inbound frame is decoded and validated before anything looks at its contents (an
// invalid frame is dropped, never crashes the connection). Every outbound route is resolved
// through BindingStore, so a daemon can only ever reach the ONE Discord user it is bound to,
// and a Discord user can only ever reach the ONE daemon they own — there is no code path
// that lets an envelope cross that boundary. The relay itself is a stateless pass-through:
// it never inspects payload semantics (e.g. it does not track pending permission requests),
// so it structurally cannot fabricate a response on a daemon's or a user's behalf.

import {
  createServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
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
  type PayloadOf,
} from '@claude-control/shared-protocol';
import type { BindingStore } from './bindings.js';
import type { PairingService } from './pairing.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';
import type { DiscordGateway } from './discord/gateway.js';

export type { DiscordGateway } from './discord/gateway.js';

/** The narrow surface command handlers get: address a bound user's daemon without ever
 *  learning or choosing a daemon id themselves (see `sendToUser`), and check reachability
 *  for `/status`. Kept as an interface so discord/commands.ts is testable with a fake. */
export interface RelaySender {
  sendToUser(discordUserId: string, build: (daemonId: string) => EnvelopeDraft): SendResult;
  isOnline(discordUserId: string): boolean;
}

export type SendResult = { ok: true } | { ok: false; error: string };

export interface RelayServerOptions {
  bindings: BindingStore;
  pairing: PairingService;
  gateway: DiscordGateway;
  logger?: Logger;
  /** Port the HTTP server (daemon websockets + the unauthenticated `/health` probe) listens
   *  on; 0 (default) picks an OS-assigned ephemeral port — use that in tests and read the
   *  real port back from `listen()`. */
  port?: number;
  /** ms between server-initiated ws pings; 0 disables the heartbeat entirely (tests). */
  heartbeatMs?: number;
  clock?: () => number;
}

/** One live, authenticated daemon connection. */
interface Connection {
  socket: WebSocket;
  alive: boolean;
}

/** Per-socket handshake state, tracked for the lifetime of one connection. */
interface SocketState {
  daemonId?: string;
  handshakeTimer: ReturnType<typeof setTimeout> | null;
}

const FIRST_FRAME_TIMEOUT_MS = 10_000;
const DEFAULT_HEARTBEAT_MS = 30_000;

export class RelayServer implements RelaySender {
  private readonly httpServer: HttpServer;
  private readonly wss: WebSocketServer;
  private readonly bindings: BindingStore;
  private readonly pairing: PairingService;
  private readonly gateway: DiscordGateway;
  private readonly logger: Logger;
  private readonly connectionsByDaemon = new Map<string, Connection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;

  constructor(options: RelayServerOptions) {
    this.bindings = options.bindings;
    this.pairing = options.pairing;
    this.gateway = options.gateway;
    this.logger = options.logger ?? noopLogger;
    // An explicit http.Server (rather than letting WebSocketServer's `port` option create one
    // implicitly) so a plain GET can be answered on the same port the daemon sockets use —
    // ws only ever attaches an 'upgrade' handler to it, never a 'request' handler of its own.
    this.httpServer = createServer((req, res) => {
      this.onHttpRequest(req, res);
    });
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on('connection', (socket) => {
      this.onConnection(socket);
    });
    this.httpServer.listen(options.port ?? 0);

    const heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    // A 0 (or otherwise falsy) heartbeat disables the interval entirely — real deployments
    // want it, but it only adds timer churn and flakiness to an in-process test suite.
    if (heartbeatMs > 0) {
      this.heartbeatTimer = setInterval(() => {
        this.heartbeat();
      }, heartbeatMs);
    }
  }

  /** Resolve once the underlying server is accepting connections; returns the bound port
   *  (the actual OS-assigned port when constructed with `port: 0`). */
  async listen(): Promise<number> {
    if (this.httpServer.listening) return this.currentPort();
    await new Promise<void>((resolve, reject) => {
      this.httpServer.once('listening', resolve);
      this.httpServer.once('error', reject);
    });
    return this.currentPort();
  }

  async close(): Promise<void> {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const conn of this.connectionsByDaemon.values()) conn.socket.terminate();
    this.connectionsByDaemon.clear();
    // wss.close() only tears down its own bookkeeping when constructed with an external
    // server — it deliberately does NOT close that server, so the http.Server needs its own
    // explicit close() or the process would leak an open listening socket.
    await new Promise<void>((resolve, reject) => {
      this.wss.close((err) => (err ? reject(err) : resolve()));
    });
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((err) => (err ? reject(err) : resolve()));
    });
  }

  /**
   * Send a command envelope from Discord to the daemon owned by `discordUserId`. Callers
   * (slash-command handlers) never supply a daemon id directly — `build` only receives one
   * after this method has already resolved it from the binding, so a handler is structurally
   * incapable of addressing a daemon its invoking user does not own.
   */
  sendToUser(discordUserId: string, build: (daemonId: string) => EnvelopeDraft): SendResult {
    const binding = this.bindings.byUser(discordUserId);
    if (!binding) return { ok: false, error: 'no daemon is paired to this account' };
    const conn = this.connectionsByDaemon.get(binding.daemonId);
    if (!conn || conn.socket.readyState !== WebSocket.OPEN) {
      return { ok: false, error: 'daemon is offline' };
    }
    conn.socket.send(encode(stamp(build(binding.daemonId))));
    return { ok: true };
  }

  isOnline(discordUserId: string): boolean {
    const binding = this.bindings.byUser(discordUserId);
    if (!binding) return false;
    const conn = this.connectionsByDaemon.get(binding.daemonId);
    return conn !== undefined && conn.socket.readyState === WebSocket.OPEN;
  }

  private currentPort(): number {
    const addr = this.httpServer.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('relay server has no network address');
    }
    return addr.port;
  }

  /** Unauthenticated GET /health on the same port daemons connect to — lets a setup wizard
   *  distinguish "the relay is unreachable" from "your network/firewall is broken" without
   *  needing any daemon credentials. Deliberately minimal: no auth, no request body, no
   *  binding/pairing state — a plain liveness probe, nothing that could leak user data. */
  private onHttpRequest(req: IncomingMessage, res: ServerResponse): void {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  }

  private onConnection(socket: WebSocket): void {
    const state: SocketState = { handshakeTimer: null };
    state.handshakeTimer = setTimeout(() => {
      if (!state.daemonId) socket.close(4008, 'handshake timeout');
    }, FIRST_FRAME_TIMEOUT_MS);

    socket.on('message', (raw: RawData) => {
      this.onMessage(socket, state, rawDataToString(raw)).catch((err: unknown) => {
        this.logger.error({ err }, 'relay: error handling frame');
      });
    });

    socket.on('close', () => {
      if (state.handshakeTimer) clearTimeout(state.handshakeTimer);
      // Only evict the mapping if it still points at THIS socket. On a reconnect, handleHello
      // has already replaced the entry with the new socket; a late 'close' from the old socket
      // must not delete the fresh connection (which would silently make the daemon unreachable
      // for user->daemon commands while still appearing connected).
      if (state.daemonId) {
        const conn = this.connectionsByDaemon.get(state.daemonId);
        if (conn && conn.socket === socket) this.connectionsByDaemon.delete(state.daemonId);
      }
    });

    socket.on('error', (err: Error) => {
      this.logger.warn({ err }, 'relay: socket error');
    });

    socket.on('pong', () => {
      const conn = state.daemonId ? this.connectionsByDaemon.get(state.daemonId) : undefined;
      // Same identity guard: a stray pong from a superseded socket must not revive the entry
      // belonging to the current one.
      if (conn && conn.socket === socket) conn.alive = true;
    });
  }

  private async onMessage(socket: WebSocket, state: SocketState, raw: string): Promise<void> {
    const decoded = decode(raw);
    if (!decoded.ok) {
      // A malformed frame from the network is an expected condition, not a crash: drop it
      // and keep the connection alive so one bad frame can't be used to sever it.
      this.logger.warn({ error: decoded.error }, 'relay: dropping invalid frame');
      return;
    }
    const envelope = decoded.envelope;

    if (!state.daemonId) {
      // Pre-authentication, only two frame types are legal: `hello` (an already-paired
      // daemon reconnecting) or `pair.claim` (a brand-new daemon redeeming its pairing
      // code). Anything else this early is a protocol violation — refuse rather than guess.
      if (isType(envelope, 'hello')) {
        await this.handleHello(socket, state, envelope);
      } else if (isType(envelope, 'pair.claim')) {
        await this.handlePairClaim(socket, envelope);
      } else {
        socket.close(4001, 'expected hello or pair.claim');
      }
      return;
    }

    // Authenticated. `ping` gets an in-band reply; everything else is routed to the bound
    // Discord user with `discordUserId` stamped server-side — a daemon's own envelope can
    // never carry (and therefore can never forge) another user's id.
    if (isType(envelope, 'ping')) {
      this.replyPong(socket, state.daemonId, envelope);
      return;
    }

    const binding = this.bindings.byDaemon(state.daemonId);
    if (!binding) {
      // The binding vanished mid-session (e.g. this daemon id was re-paired to someone
      // else). Refuse to relay under a now-stale identity rather than guess a recipient.
      socket.close(4003, 'binding no longer exists');
      return;
    }
    const routed: Envelope = { ...envelope, discordUserId: binding.discordUserId };
    await this.gateway.deliver(binding.discordUserId, routed);
  }

  private async handleHello(
    socket: WebSocket,
    state: SocketState,
    envelope: MessageOf<'hello'>,
  ): Promise<void> {
    const { daemonId } = envelope;
    const negotiated = negotiateVersion(envelope.payload.protocolVersion);
    if (negotiated === null) {
      this.sendHelloResult(socket, daemonId, { ok: false, error: 'unsupported protocol version' });
      socket.close(4002, 'unsupported protocol version');
      return;
    }
    const binding = await this.bindings.verifyDaemon(daemonId, envelope.payload.daemonToken);
    if (!binding) {
      this.sendHelloResult(socket, daemonId, { ok: false, error: 'invalid daemon credentials' });
      socket.close(4003, 'invalid daemon credentials');
      return;
    }

    // A second connection from the same daemon id replaces the first — only one live socket
    // per daemon is meaningful, and the prior one is almost certainly a dead/reconnecting peer.
    const existing = this.connectionsByDaemon.get(daemonId);
    if (existing) existing.socket.terminate();

    state.daemonId = daemonId;
    if (state.handshakeTimer) {
      clearTimeout(state.handshakeTimer);
      state.handshakeTimer = null;
    }
    this.connectionsByDaemon.set(daemonId, { socket, alive: true });
    this.sendHelloResult(socket, daemonId, { ok: true, negotiatedVersion: negotiated });
  }

  private async handlePairClaim(
    socket: WebSocket,
    envelope: MessageOf<'pair.claim'>,
  ): Promise<void> {
    // The daemon does NOT choose its id: the bot mints it inside claim(). The daemonId on the
    // inbound pair.claim envelope is ignored for identity — it exists only so the frame is a
    // valid envelope — which is exactly what closes the cross-user daemonId-hijack.
    const result = await this.pairing.claim(
      envelope.payload.pairingCode,
      envelope.payload.hostLabel,
    );
    const payload: PayloadOf<'pair.result'> = { ok: result.ok };
    // Echo the assigned id on success (the daemon adopts it as its identity), else the
    // client's proposed id purely so the reply envelope is well-formed.
    const replyDaemonId = result.ok ? result.daemonId : envelope.daemonId;
    if (result.ok) {
      payload.daemonId = result.daemonId;
      payload.daemonToken = result.daemonToken;
      payload.discordUserId = result.discordUserId;
      // First-run primer: the user's very first signal after pairing should be what to try
      // next, not silence until a daemon happens to push something. Best-effort — a DM
      // failure (e.g. the user has DMs closed) must never fail the pairing itself, which has
      // already succeeded by this point.
      Promise.resolve(this.gateway.sendPrimer(result.discordUserId)).catch((err: unknown) => {
        this.logger.warn(
          { err, discordUserId: result.discordUserId },
          'relay: failed to send pairing primer DM',
        );
      });
    } else {
      payload.error = result.error;
    }
    socket.send(encode(stamp({ daemonId: replyDaemonId, type: 'pair.result', payload })));
    // Pairing is a one-shot handshake, not a persistent session: the daemon must reconnect
    // with `hello` and its freshly minted token to open the socket it will actually use for
    // relay traffic. Closing here means there is never a socket sitting around authenticated
    // by pairing alone (which never negotiated a protocol version).
    socket.close(1000, 'pairing complete');
  }

  private replyPong(socket: WebSocket, daemonId: string, envelope: MessageOf<'ping'>): void {
    const payload: PayloadOf<'pong'> = {};
    if (envelope.payload.nonce !== undefined) payload.nonce = envelope.payload.nonce;
    socket.send(encode(stamp({ daemonId, type: 'pong', payload })));
  }

  private sendHelloResult(
    socket: WebSocket,
    daemonId: string,
    result: { ok: boolean; negotiatedVersion?: number; error?: string },
  ): void {
    const payload: PayloadOf<'hello.result'> = { ok: result.ok };
    if (result.negotiatedVersion !== undefined)
      payload.negotiatedVersion = result.negotiatedVersion;
    if (result.error !== undefined) payload.error = result.error;
    socket.send(encode(stamp({ daemonId, type: 'hello.result', payload })));
  }

  /** Application-level heartbeat: ping every live daemon connection, and drop any that did
   *  not answer the previous round. A ws-protocol ping (not an envelope) keeps this off the
   *  wire format the daemon otherwise has to parse. */
  private heartbeat(): void {
    for (const [daemonId, conn] of this.connectionsByDaemon) {
      if (!conn.alive) {
        conn.socket.terminate();
        this.connectionsByDaemon.delete(daemonId);
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }
}

/** `ws` delivers message payloads as `Buffer | ArrayBuffer | Buffer[]` depending on framing;
 *  a bare `.toString()` on the union isn't guaranteed a meaningful result (and trips
 *  no-base-to-string), so each shape is normalized explicitly. */
function rawDataToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}
