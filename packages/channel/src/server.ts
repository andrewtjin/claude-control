// The MCP stdio server Claude Code spawns for this session.
//
// Newline-delimited JSON-RPC 2.0 on stdin/stdout, and stdout is the WIRE — nothing may ever be
// printed to it that is not a protocol frame. Every diagnostic goes to stderr, which Claude Code
// captures into `~/.claude/debug/<session-id>.txt`.
//
// The server has exactly two jobs, one in each direction:
//   inbound  — push `notifications/claude/channel` into a running session, which is what makes
//              an idle session start working on an operator's message.
//   outbound — expose ONE tool, `reply`, because the person who sent that message is reading a
//              chat client and cannot see this session's transcript at all.
//
// Everything else is refusal. An unknown request gets `-32601` immediately, never silence: a
// client left waiting on a response it will never receive is a hung session.

import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { noopLogger, type Logger } from './logger.js';
// Type-only, so it is erased at compile time and costs this module nothing at startup.
import type { DeliverResult } from './daemonLink.js';

/** Name Claude Code shows for this server. */
export const SERVER_NAME = 'cctl-channel';

/** Claude Code silently DISCARDS `meta` keys that are not `[A-Za-z0-9_]+` — a hyphenated key
 *  does not error, it just never arrives. Anything sanitised through this regex is safe. */
const SAFE_META_KEY = /^[A-Za-z0-9_]+$/;

/** The single tool. Its description is the only place the model learns that the transcript is
 *  not a channel back to the sender, so the wording carries real weight: without it the model
 *  answers into the terminal and the operator sees silence. */
const REPLY_TOOL = {
  name: 'reply',
  description:
    'Send a message back to the person who messaged this session over the cctl channel. ' +
    'They are reading a chat client (Discord), not this terminal: your transcript, tool ' +
    'output, and final answer never reach them. Anything you want them to see — progress ' +
    'updates, the answer to their question, a question back to them, a blocker — must be ' +
    'sent with this tool, and it is the only way to reach them. Use it as soon as you have ' +
    'something worth saying rather than saving it for the end.',
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The message to deliver to the sender. Plain text; keep it self-contained.',
      },
    },
    required: ['text'],
    additionalProperties: false,
  },
} as const;

export interface ChannelServerOptions {
  input: Readable;
  output: Writable;
  /** Handles the `reply` tool. Returning `{ok:false}` surfaces the reason to the model instead
   *  of pretending the message was delivered. */
  onReply: (text: string) => Promise<DeliverResult>;
  logger?: Logger;
  /** Reported in `serverInfo`; defaults to this package's version. */
  version?: string;
  /** Called once when stdin or stdout fails — EPIPE, in practice, when Claude Code goes away.
   *  Node treats an unhandled stream `error` as an uncaught exception, which would kill this
   *  process instantly and skip the detach, leaving the daemon holding an attachment for a
   *  session that no longer exists. The composition root wires this to its shutdown path. */
  onTransportError?: (error: Error) => void;
}

/** JSON-RPC error codes this server emits. */
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

type JsonRpcId = string | number;

export class ChannelServer {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly onReply: (text: string) => Promise<DeliverResult>;
  private readonly logger: Logger;
  private readonly version: string;
  private readonly onTransportError: ((error: Error) => void) | undefined;

  private lines: Interface | undefined;
  private initialized = false;
  private readonly readyPromise: Promise<void>;
  private markReady!: () => void;
  /** Set once the transport has failed. Every later write short-circuits to a failure rather
   *  than pretending, so a dead pipe can never be reported as a delivery. */
  private transportError: string | undefined;

  constructor(options: ChannelServerOptions) {
    this.input = options.input;
    this.output = options.output;
    this.onReply = options.onReply;
    this.logger = options.logger ?? noopLogger;
    this.version = options.version ?? '0.1.0';
    this.onTransportError = options.onTransportError;
    this.readyPromise = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /** Begin reading frames. Called before anything expensive happens elsewhere in the process so
   *  the client's `initialize` is answered immediately. */
  start(): void {
    if (this.lines !== undefined) return;
    // Stream errors MUST be handled here. Node escalates an unhandled `error` on a stream to an
    // uncaught exception, so without these two lines an EPIPE (Claude Code exiting first) kills
    // this process before the shutdown path can detach.
    this.output.on('error', (err: Error) => this.failTransport(err, 'stdout'));
    this.input.on('error', (err: Error) => this.failTransport(err, 'stdin'));
    // readline handles both LF and CRLF framing and never splits a frame across chunks, which a
    // hand-rolled buffer split is easy to get wrong under partial reads.
    this.lines = createInterface({ input: this.input, crlfDelay: Infinity });
    // readline RE-EMITS a source error on the Interface as well as leaving it on the stream
    // (measured). Handling only the stream is therefore not enough — the Interface's copy would
    // still be unhandled, and that is the one that takes the process down.
    this.lines.on('error', (err: Error) => this.failTransport(err, 'stdin'));
    this.lines.on('line', (line) => {
      void this.handleLine(line);
    });
  }

  /**
   * Wait for the client's `notifications/initialized`. Until it arrives the session is not
   * listening on the channel, so pushing would be dropped silently — and channel delivery has no
   * delivered-state to discover that from afterwards.
   *
   * Resolves `true` on handshake, or `false` if `timeoutMs` elapses first. Callers that pass a
   * bound get an answer either way; an unbounded wait on a client that never finishes its
   * handshake is an invisible park, which is worse than a logged failure.
   */
  ready(timeoutMs?: number): Promise<boolean> {
    if (timeoutMs === undefined) return this.readyPromise.then(() => true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      // Never hold the process open on account of this timer.
      timer.unref();
      void this.readyPromise.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  /**
   * Push one channel item into the session.
   *
   * Reports whether the frame reached the transport — NOT whether the session acted on it, which
   * is unobservable from here. The caller acks on this result, and the daemon drops the item from
   * its in-flight map on a `sent` ack, so a false success here destroys a message: it can no
   * longer be recovered by detach, by the stale sweep, or by the turn-boundary fallback.
   */
  push(content: string, meta?: Record<string, unknown>): Promise<DeliverResult> {
    return this.write({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content, meta: sanitizeMetaKeys(meta, this.logger) },
    });
  }

  close(): void {
    this.lines?.close();
    this.lines = undefined;
  }

  /** Record the first transport failure and hand it to the composition root exactly once. */
  private failTransport(error: Error, stream: 'stdin' | 'stdout'): void {
    if (this.transportError !== undefined) return;
    this.transportError = `${stream}: ${error.message}`;
    this.logger.error({ stream, error: error.message }, 'channel: stdio transport failed');
    this.onTransportError?.(error);
  }

  // -------------------------------------------------------------------------
  // Frame handling
  // -------------------------------------------------------------------------

  private async handleLine(line: string): Promise<void> {
    if (line.trim().length === 0) return;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      // Per JSON-RPC, an unparsable frame is answered with a null-id error rather than ignored:
      // if it was a request, silence would hang the client.
      await this.respondNullId(PARSE_ERROR, 'parse error');
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      await this.respondNullId(INVALID_REQUEST, 'invalid request');
      return;
    }
    const record = message as Record<string, unknown>;
    const id = readId(record.id);
    const method = typeof record.method === 'string' ? record.method : undefined;
    if (method === undefined) {
      // A response to something we never sent, or a malformed frame. Only answer if it carries
      // an id we could answer to.
      if (id !== undefined) {
        await this.error(id, INVALID_REQUEST, 'invalid request: no method');
      }
      return;
    }
    await this.dispatch(method, record.params, id);
  }

  private async dispatch(
    method: string,
    params: unknown,
    id: JsonRpcId | undefined,
  ): Promise<void> {
    switch (method) {
      case 'initialize':
        if (id !== undefined) await this.result(id, this.initializeResult(params));
        return;

      case 'notifications/initialized':
        // Only now is the channel live; `push` before this point would be dropped by the client.
        this.initialized = true;
        this.markReady();
        this.logger.info({ event: 'initialized' }, 'channel: session handshake complete');
        return;

      case 'tools/list':
        if (id !== undefined) await this.result(id, { tools: [REPLY_TOOL] });
        return;

      case 'tools/call':
        if (id !== undefined) await this.callTool(params, id);
        return;

      case 'ping':
        // Part of the MCP base protocol, not an extension: answering `-32601` here would have
        // the client treat a healthy server as broken.
        if (id !== undefined) await this.result(id, {});
        return;

      default:
        // Requests get an explicit refusal so the client never waits. Notifications (no id) are
        // ignored — JSON-RPC forbids responding to them, and unknown ones are routine.
        if (id !== undefined) {
          await this.error(id, METHOD_NOT_FOUND, `unknown method: ${method}`);
        }
        return;
    }
  }

  /** The handshake answer, and the whole reason this server exists. */
  private initializeResult(params: unknown): Record<string, unknown> {
    return {
      // Echo whatever the client asked for. Pinning a version here would break this server on
      // the next Claude Code protocol bump for no benefit — the surface used is version-stable.
      protocolVersion: readProtocolVersion(params),
      capabilities: {
        tools: {},
        experimental: {
          // Declaring `claude/channel` is what lets this server push notifications into a live
          // session.
          //
          // `claude/channel/permission` is deliberately ABSENT. cctl already owns permission
          // approval end to end through its hook path (PermissionRequest -> daemon -> operator
          // -> decision), and declaring it here would put a second, independent approver on the
          // same tool call. Two authorities answering one decision is a defect class this
          // project has already paid for; there is one approval path and it is not this server.
          'claude/channel': {},
        },
      },
      serverInfo: { name: SERVER_NAME, version: this.version },
    };
  }

  private async callTool(params: unknown, id: JsonRpcId): Promise<void> {
    const record =
      params !== null && typeof params === 'object' ? (params as Record<string, unknown>) : {};
    if (record.name !== REPLY_TOOL.name) {
      await this.error(id, INVALID_PARAMS, `unknown tool: ${String(record.name)}`);
      return;
    }
    const args =
      record.arguments !== null && typeof record.arguments === 'object'
        ? (record.arguments as Record<string, unknown>)
        : {};
    const text = typeof args.text === 'string' ? args.text : undefined;
    if (text === undefined || text.trim().length === 0) {
      await this.toolResult(id, 'reply needs a non-empty `text` argument.', true);
      return;
    }
    const sent = await this.onReply(text);
    if (sent.ok) {
      // NOT "delivered". All that is known here is that cctl accepted it: the daemon enqueues to
      // a durable outbox, and nothing on this side ever learns whether the sender saw it. This
      // package refuses to overclaim delivery everywhere else and must not start here.
      await this.toolResult(id, 'Handed to cctl for delivery.', false);
      return;
    }
    // The model must know its reply did NOT go out, or it will assume the sender has been
    // answered and stop talking to a person who has heard nothing.
    await this.toolResult(id, `The reply could not be sent: ${sent.error}`, true);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  /** The JSON-RPC answer to a frame so malformed we never recovered an id from it. */
  private async respondNullId(code: number, message: string): Promise<void> {
    const wrote = await this.write({ jsonrpc: '2.0', id: null, error: { code, message } });
    if (!wrote.ok) {
      this.logger.error({ error: wrote.error }, 'channel: could not write a response');
    }
  }

  /** Send a response frame. A response that cannot be written is unrecoverable — the client is
   *  gone — so it is logged rather than propagated; only `push` has a caller that can act. */
  private async respond(message: unknown, id: JsonRpcId): Promise<void> {
    const wrote = await this.write(message);
    if (!wrote.ok) {
      this.logger.error({ id, error: wrote.error }, 'channel: could not write a response');
    }
  }

  private result(id: JsonRpcId, result: unknown): Promise<void> {
    return this.respond({ jsonrpc: '2.0', id, result }, id);
  }

  private error(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.respond({ jsonrpc: '2.0', id, error: { code, message } }, id);
  }

  private toolResult(id: JsonRpcId, text: string, isError: boolean): Promise<void> {
    return this.result(id, { content: [{ type: 'text', text }], isError });
  }

  /**
   * One frame, one line, with an honest answer about whether it left.
   *
   * The write callback's FIRST ARGUMENT IS THE ERROR. Discarding it — which reads perfectly
   * naturally as `write(line, () => resolve())` — makes every failed write indistinguishable
   * from a successful one, and everything downstream of `push` is built on trusting this result.
   */
  private write(message: unknown): Promise<DeliverResult> {
    if (this.transportError !== undefined) {
      return Promise.resolve({ ok: false, error: this.transportError });
    }
    if (this.output.destroyed || this.output.writableEnded) {
      return Promise.resolve({ ok: false, error: 'the stdio transport is closed' });
    }
    return new Promise<DeliverResult>((resolve) => {
      this.output.write(`${JSON.stringify(message)}\n`, (err) => {
        resolve(err ? { ok: false, error: err.message } : { ok: true });
      });
    });
  }

  /** Whether the client has completed the handshake. Exposed for diagnostics and tests. */
  get isInitialized(): boolean {
    return this.initialized;
  }
}

/**
 * Make a `meta` object survive the trip.
 *
 * Claude Code drops any key outside `[A-Za-z0-9_]+` without complaining, so `message-id` simply
 * vanishes at the far end. Keys are therefore normalised (`-` and friends become `_`) in a second
 * pass, and a normalised key that would collide with a key that was already valid is dropped
 * rather than overwriting it — silently replacing a good value with a different one is worse than
 * losing the one that was malformed.
 *
 * Values are flattened to strings. Anything that is not a primitive (an object, an array, `null`)
 * has no meaningful flat form and IS dropped — as is a key that normalises to nothing. Every one
 * of those drops is logged, because the alternative is meta quietly arriving incomplete with no
 * way to tell from either end.
 */
export function sanitizeMetaKeys(
  meta: Record<string, unknown> | undefined,
  logger: Logger = noopLogger,
): Record<string, string> {
  // Null-prototype: `meta` comes off the wire, so a key of `__proto__` is reachable, and on a
  // normal object literal `out['__proto__'] = v` mutates the prototype instead of adding a key —
  // the value would vanish and the object would be quietly corrupted.
  const out = Object.create(null) as Record<string, string>;
  if (meta === undefined || meta === null) return out;

  const put = (key: string, value: unknown): void => {
    const flat = flattenMetaValue(value);
    if (flat === undefined) {
      logger.warn(
        { key, kind: value === null ? 'null' : typeof value },
        'channel: dropped a meta value with no flat form',
      );
      return;
    }
    out[key] = flat;
  };

  // Pass 1: keys that are already legal claim their name.
  for (const [key, value] of Object.entries(meta)) {
    if (SAFE_META_KEY.test(key)) put(key, value);
  }
  // Pass 2: everything else, normalised, first-come — and never over the top of pass 1.
  for (const [key, value] of Object.entries(meta)) {
    if (SAFE_META_KEY.test(key)) continue;
    const normalized = key.replace(/[^A-Za-z0-9_]+/g, '_');
    if (normalized.length === 0 || Object.hasOwn(out, normalized)) {
      logger.warn({ key }, 'channel: dropped an unrepresentable meta key');
      continue;
    }
    put(normalized, value);
  }
  return out;
}

function flattenMetaValue(value: unknown): string | undefined {
  switch (typeof value) {
    case 'string':
      return value;
    case 'number':
      return Number.isFinite(value) ? String(value) : undefined;
    case 'boolean':
      return String(value);
    default:
      return undefined;
  }
}

/** JSON-RPC ids are strings or numbers. `null` is the "no id" marker in error responses, and an
 *  absent id means a notification — both mean "do not answer this". */
function readId(value: unknown): JsonRpcId | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return undefined;
}

/** The client's advertised protocol version, echoed verbatim. Falls back only when the client
 *  sent nothing usable, which no real client does. */
function readProtocolVersion(params: unknown): string {
  if (params !== null && typeof params === 'object') {
    const value = (params as Record<string, unknown>).protocolVersion;
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return '2025-11-25';
}
