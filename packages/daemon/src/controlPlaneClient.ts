// The daemon's outbound connection to the control-plane bot.
//
// IDENTITY: the bot MINTS the daemon id at pairing (see relay.ts `handlePairClaim`) — a
// daemon never chooses its own id, which is what closes the cross-user daemonId-hijack. This
// client therefore has two lifecycles:
//   1. First run (no adopted identity persisted yet): connect, send `pair.claim` with a
//      throwaway placeholder daemonId (the envelope needs SOME value to be well-formed, but
//      the bot ignores it for identity), await `pair.result`, and ADOPT the assigned
//      `daemonId` + `daemonToken` — persisted via the injectable `identityStore` — as this
//      daemon's permanent identity.
//   2. Every run after that: connect and send `hello` stamped with the ADOPTED daemonId.
//
// Outbound envelopes are buffered in the sqlite outbox while disconnected (bounded, drop-
// oldest) and flushed in order on reconnect, with reconnect backoff. Every inbound frame is
// decode()'d before it reaches a handler; an invalid frame is dropped, never crashes the
// connection — same posture as the bot's own relay.

import { WebSocket, type RawData } from 'ws';
import {
  decode,
  encode,
  stamp,
  isType,
  PROTOCOL_VERSION,
  type Envelope,
  type EnvelopeDraft,
  type MessageOf,
} from '@claude-control/shared-protocol';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import type { Store } from './store.js';

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface DaemonIdentity {
  daemonId: string;
  daemonToken: string;
}

/** Where the adopted identity lives between runs. Injectable so tests never touch disk. */
export interface IdentityStore {
  load(): Promise<DaemonIdentity | undefined>;
  save(identity: DaemonIdentity): Promise<void>;
}

// ---------------------------------------------------------------------------
// Inbound dispatch
// ---------------------------------------------------------------------------

export interface ControlPlaneHandlers {
  onSwitchCommand?: (msg: MessageOf<'switch.command'>) => void;
  onPermissionResponse?: (msg: MessageOf<'permission.response'>) => void;
  onPromptInject?: (msg: MessageOf<'prompt.inject'>) => void;
  onSessionSpawn?: (msg: MessageOf<'session.spawn'>) => void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface ControlPlaneClientOptions {
  url: string;
  identityStore: IdentityStore;
  store: Store;
  handlers?: ControlPlaneHandlers;
  hostLabel: string;
  /** Only used on the very first (pairing) run. */
  pairingCode?: string;
  clock?: () => number;
  /** Injectable WebSocket constructor — defaults to `ws`'s, tests point it at a real
   *  in-process server via a plain `ws://127.0.0.1:<port>` url instead of swapping this. */
  createSocket?: (url: string) => WebSocket;
  /** Max envelopes retained in the outbox while disconnected; oldest are dropped past this. */
  outboxBound?: number;
  /** ms between app-level heartbeat pings once connected. */
  heartbeatMs?: number;
  /** ms to wait for a pong before deciding the connection is dead. */
  heartbeatTimeoutMs?: number;
  /** Base/cap for reconnect backoff. */
  reconnectBaseMs?: number;
  reconnectCapMs?: number;
  /** Jitter source, injectable for deterministic tests. */
  random?: () => number;
  /** Where socket errors and terminal rejections are surfaced; defaults to a no-op. */
  logger?: Logger;
}

const DEFAULT_OUTBOX_BOUND = 500;
const DEFAULT_HEARTBEAT_MS = 30_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_CAP_MS = 60_000;

/** Connection lifecycle, exposed for tests/observability. `'rejected'` is terminal: the bot
 *  refused the hello (revoked token / unsupported version), so retrying is pointless and the
 *  client stops reconnecting until it is re-paired. */
export type ConnectionState =
  'idle' | 'connecting' | 'pairing' | 'open' | 'reconnecting' | 'closed' | 'rejected';

export class ControlPlaneClient {
  private readonly opts: Required<Omit<ControlPlaneClientOptions, 'pairingCode' | 'handlers'>> & {
    pairingCode?: string;
    handlers: ControlPlaneHandlers;
  };
  private socket: WebSocket | undefined;
  private identity: DaemonIdentity | undefined;
  private state: ConnectionState = 'idle';
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private heartbeatTimeoutTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  /** Set once the bot terminally rejects our hello. Like `stopped`, it suppresses reconnect —
   *  but it is NOT caused by our own `close()`, so the end state is `'rejected'`, not
   *  `'closed'`, to distinguish "the bot refused us" from "we shut ourselves down". */
  private terminalRejection = false;
  /** Resolves the in-flight `connect()` promise once hello succeeds (or pairing completes and
   *  the follow-up hello succeeds) — lets tests/daemon.ts `await client.connect()`. */
  private connectedResolvers: { resolve: () => void; reject: (err: Error) => void }[] = [];

  constructor(options: ControlPlaneClientOptions) {
    this.opts = {
      url: options.url,
      identityStore: options.identityStore,
      store: options.store,
      handlers: options.handlers ?? {},
      hostLabel: options.hostLabel,
      ...(options.pairingCode !== undefined ? { pairingCode: options.pairingCode } : {}),
      clock: options.clock ?? Date.now,
      createSocket: options.createSocket ?? ((url) => new WebSocket(url)),
      outboxBound: options.outboxBound ?? DEFAULT_OUTBOX_BOUND,
      heartbeatMs: options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
      reconnectBaseMs: options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS,
      reconnectCapMs: options.reconnectCapMs ?? DEFAULT_RECONNECT_CAP_MS,
      random: options.random ?? Math.random,
      logger: options.logger ?? noopLogger,
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  getIdentity(): DaemonIdentity | undefined {
    return this.identity;
  }

  /** Replace the inbound-dispatch handlers. Lets a composing owner (daemon.ts) construct this
   *  client once, up front, and wire the actual handler logic afterward once its OTHER
   *  collaborators (switch engine, hook receiver, session manager) exist — without those two
   *  construction orders having to be entangled. */
  setHandlers(handlers: ControlPlaneHandlers): void {
    this.opts.handlers = handlers;
  }

  /** Load any persisted identity, then open the socket. Resolves once the connection is
   *  fully live (hello.result ok, or pairing completed and the follow-up hello succeeded).
   *  Rejects only for a failure with no retry path (e.g. first-run pairing with no code). */
  async connect(): Promise<void> {
    this.stopped = false;
    // A fresh connect() (e.g. after re-pairing) clears any prior terminal rejection.
    this.terminalRejection = false;
    this.identity = await this.opts.identityStore.load();
    return new Promise((resolve, reject) => {
      this.connectedResolvers.push({ resolve, reject });
      this.openSocket();
    });
  }

  /** Tear down cleanly — no further reconnect attempts. */
  close(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stopHeartbeat();
    this.socket?.close(1000, 'client closing');
    this.state = 'closed';
  }

  /**
   * Send an envelope. If connected, it goes out immediately; either way it is first durably
   * queued in the outbox and only removed once actually written to the socket — so a send
   * that races a disconnect is never silently lost.
   */
  send(draft: EnvelopeDraft): void {
    const envelope = stamp(draft);
    const id = this.opts.store.enqueueOutbox(encode(envelope), this.opts.clock());
    this.opts.store.trimOutboxOldest(this.opts.outboxBound);
    this.trySendRow(id, envelope);
  }

  // ---- connection setup ----

  private openSocket(): void {
    if (this.stopped) return;
    this.state = this.identity ? 'connecting' : 'pairing';
    const socket = this.opts.createSocket(this.opts.url);
    this.socket = socket;

    socket.on('open', () => {
      if (this.identity) {
        this.sendHello(this.identity);
      } else {
        this.sendPairClaim();
      }
    });
    socket.on('message', (raw: RawData) => {
      this.onMessage(rawToString(raw));
    });
    socket.on('close', () => {
      this.onDisconnect();
    });
    socket.on('error', (err: Error) => {
      // 'close' always follows 'error' for ws client sockets, so reconnect logic lives there —
      // but log the reason here first so a disconnect isn't left undiagnosable by an empty
      // handler that silently swallows the error.
      this.opts.logger.error({ err }, 'control-plane socket error');
    });
    socket.on('pong', () => {
      this.clearHeartbeatTimeout();
    });
  }

  private sendPairClaim(): void {
    if (!this.socket) return;
    const draft: EnvelopeDraft = {
      // Placeholder — the bot ignores this field for identity on pair.claim (see class doc).
      daemonId: 'unpaired',
      type: 'pair.claim',
      payload: { pairingCode: this.opts.pairingCode ?? '', hostLabel: this.opts.hostLabel },
    };
    this.socket.send(encode(stamp(draft)));
  }

  private sendHello(identity: DaemonIdentity): void {
    if (!this.socket) return;
    const draft: EnvelopeDraft = {
      daemonId: identity.daemonId,
      type: 'hello',
      payload: { protocolVersion: PROTOCOL_VERSION, daemonToken: identity.daemonToken },
    };
    this.socket.send(encode(stamp(draft)));
  }

  // ---- inbound dispatch ----

  private onMessage(raw: string): void {
    const decoded = decode(raw);
    if (!decoded.ok) return; // invalid frame — drop, never crash the connection
    const envelope = decoded.envelope;

    if (isType(envelope, 'pair.result')) {
      // Fire-and-forget: onMessage is a synchronous ws event handler, and a failed identity
      // save here surfaces the same way a failed hello would — the next reconnect retries.
      void this.handlePairResult(envelope);
      return;
    }
    if (isType(envelope, 'hello.result')) {
      this.handleHelloResult(envelope);
      return;
    }
    if (isType(envelope, 'pong')) {
      this.clearHeartbeatTimeout();
      return;
    }
    if (isType(envelope, 'ping')) {
      this.socket?.send(
        encode(
          stamp({ daemonId: this.identity?.daemonId ?? 'unknown', type: 'pong', payload: {} }),
        ),
      );
      return;
    }

    if (isType(envelope, 'switch.command')) this.opts.handlers.onSwitchCommand?.(envelope);
    else if (isType(envelope, 'permission.response'))
      this.opts.handlers.onPermissionResponse?.(envelope);
    else if (isType(envelope, 'prompt.inject')) this.opts.handlers.onPromptInject?.(envelope);
    else if (isType(envelope, 'session.spawn')) this.opts.handlers.onSessionSpawn?.(envelope);
    // Any other type (usage.snapshot, session.output, etc.) is bot->phone traffic the daemon
    // itself never receives from the relay; silently ignored rather than treated as an error.
  }

  private async handlePairResult(envelope: MessageOf<'pair.result'>): Promise<void> {
    const { ok, daemonId, daemonToken, error } = envelope.payload;
    if (
      !ok ||
      daemonId === undefined ||
      daemonId === null ||
      daemonToken === undefined ||
      daemonToken === null
    ) {
      this.failConnect(new Error(error ?? 'pairing failed'));
      return;
    }
    const identity: DaemonIdentity = { daemonId, daemonToken };
    await this.opts.identityStore.save(identity);
    this.identity = identity;
    // Pairing is one-shot: the bot closes this socket after pair.result (see relay.ts). The
    // 'close' handler's normal reconnect path will pick up and send `hello` with the freshly
    // adopted identity — nothing further to do here.
  }

  private handleHelloResult(envelope: MessageOf<'hello.result'>): void {
    if (!envelope.payload.ok) {
      // A hello rejection is TERMINAL: a revoked token or an unsupported protocol version will
      // reject again on every reconnect, so spinning the reconnect loop forever is pointless
      // and hides the real problem. Mark it terminal so `onDisconnect` does NOT reconnect,
      // surface the reason, and require re-pairing rather than retrying.
      const reason = envelope.payload.error ?? 'hello rejected';
      this.terminalRejection = true;
      this.state = 'rejected';
      this.opts.logger.error(
        { reason },
        'control-plane rejected hello — stopping; re-pairing required',
      );
      this.stopHeartbeat();
      this.failConnect(new Error(reason));
      this.socket?.close(4002, 'hello rejected');
      return;
    }
    this.state = 'open';
    this.reconnectAttempt = 0;
    this.startHeartbeat();
    this.flushOutbox();
    this.resolveConnect();
  }

  // ---- reconnect / outbox / heartbeat ----

  private onDisconnect(): void {
    this.stopHeartbeat();
    // Either a deliberate local shutdown (`stopped`) or a terminal bot rejection suppresses
    // reconnect. They differ only in the resting state they report.
    if (this.stopped || this.terminalRejection) {
      this.state = this.terminalRejection ? 'rejected' : 'closed';
      return;
    }
    this.state = 'reconnecting';
    const attempt = this.reconnectAttempt++;
    const backoff = Math.min(this.opts.reconnectBaseMs * 2 ** attempt, this.opts.reconnectCapMs);
    const jitter = Math.floor(this.opts.random() * this.opts.reconnectBaseMs);
    this.reconnectTimer = setTimeout(() => {
      this.openSocket();
    }, backoff + jitter);
  }

  /**
   * Replay every buffered envelope, oldest first, on reconnect. A row is deleted only after
   * `socket.send()` buffers it (not after a peer ack), so delivery is AT-LEAST-ONCE across a
   * process crash — a crash between send and delete re-sends on restart — and exactly-once
   * only for an in-process reconnect. Every envelope carries the protocol's stable `id`
   * (stamped once at `send()` time and persisted with the row), so the bot can dedupe replays
   * on it; we deliberately do not add a two-phase ack here.
   *
   * Drains the ENTIRE backlog, not just the first `listOutbox()` page: a backlog larger than
   * the page bound would otherwise sit undelivered until the next disconnect. Each pass
   * deletes what it sent, advancing the next page; it stops when a page comes back empty or no
   * rows drained (the socket closed mid-flush) so it never spins on the same undelivered page.
   */
  private flushOutbox(): void {
    for (;;) {
      const rows = this.opts.store.listOutbox(this.opts.outboxBound);
      if (rows.length === 0) break;
      const remainingBefore = this.opts.store.countOutbox();
      for (const row of rows) {
        this.trySendRow(row.id, undefined, row.envelopeJson);
      }
      if (this.opts.store.countOutbox() >= remainingBefore) break; // no progress — stop
    }
  }

  /** Send one outbox row over the live socket (if open) and delete it once written. Accepts
   *  either an already-stamped `envelope` (a fresh `send()`) or a pre-serialized
   *  `envelopeJson` (a flush replay) — never both are needed at once. */
  private trySendRow(id: number, envelope?: Envelope, envelopeJson?: string): void {
    if (this.state !== 'open' || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    const json = envelopeJson ?? (envelope ? encode(envelope) : undefined);
    if (json === undefined) return;
    this.socket.send(json);
    this.opts.store.deleteOutbox(id);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      this.socket.send(
        encode(
          stamp({ daemonId: this.identity?.daemonId ?? 'unknown', type: 'ping', payload: {} }),
        ),
      );
      this.heartbeatTimeoutTimer = setTimeout(() => {
        // No pong within the timeout — treat the connection as dead and force a reconnect.
        this.socket?.terminate();
      }, this.opts.heartbeatTimeoutMs);
    }, this.opts.heartbeatMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    this.clearHeartbeatTimeout();
  }

  private clearHeartbeatTimeout(): void {
    if (this.heartbeatTimeoutTimer) clearTimeout(this.heartbeatTimeoutTimer);
    this.heartbeatTimeoutTimer = undefined;
  }

  // ---- connect() promise plumbing ----

  private resolveConnect(): void {
    const resolvers = this.connectedResolvers;
    this.connectedResolvers = [];
    for (const r of resolvers) r.resolve();
  }

  private failConnect(err: Error): void {
    const resolvers = this.connectedResolvers;
    this.connectedResolvers = [];
    for (const r of resolvers) r.reject(err);
  }
}

/** `ws` delivers message payloads as `Buffer | ArrayBuffer | Buffer[]` depending on framing. */
function rawToString(raw: Buffer | ArrayBuffer | Buffer[]): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}
