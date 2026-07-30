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
import { noopLogger, type Logger } from '@claude-control/switch-engine';
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

  private lines: Interface | undefined;
  private initialized = false;
  private readonly readyPromise: Promise<void>;
  private markReady!: () => void;

  constructor(options: ChannelServerOptions) {
    this.input = options.input;
    this.output = options.output;
    this.onReply = options.onReply;
    this.logger = options.logger ?? noopLogger;
    this.version = options.version ?? '0.1.0';
    this.readyPromise = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  /** Begin reading frames. Called before anything expensive happens elsewhere in the process so
   *  the client's `initialize` is answered immediately. */
  start(): void {
    if (this.lines !== undefined) return;
    // readline handles both LF and CRLF framing and never splits a frame across chunks, which a
    // hand-rolled buffer split is easy to get wrong under partial reads.
    this.lines = createInterface({ input: this.input, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      void this.handleLine(line);
    });
  }

  /**
   * Resolves once the client has sent `notifications/initialized`. Until then the session is not
   * listening on the channel, so pushing a notification would drop it silently — and channel
   * delivery has no delivered-state to discover that from afterwards.
   */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  /** Push one channel item into the session. Resolves when the frame has been flushed to the
   *  transport, which is the strongest claim anyone here can honestly make: what the session
   *  then does with it is unobservable from this side. */
  async push(content: string, meta?: Record<string, unknown>): Promise<void> {
    await this.write({
      jsonrpc: '2.0',
      method: 'notifications/claude/channel',
      params: { content, meta: sanitizeMetaKeys(meta, this.logger) },
    });
  }

  close(): void {
    this.lines?.close();
    this.lines = undefined;
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
      await this.write({
        jsonrpc: '2.0',
        id: null,
        error: { code: PARSE_ERROR, message: 'parse error' },
      });
      return;
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      await this.write({
        jsonrpc: '2.0',
        id: null,
        error: { code: INVALID_REQUEST, message: 'invalid request' },
      });
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
      await this.toolResult(id, 'Delivered to the sender.', false);
      return;
    }
    // The model must know its reply did NOT land, or it will assume the sender has been answered
    // and stop talking to a person who has heard nothing.
    await this.toolResult(id, `The reply was not delivered: ${sent.error}`, true);
  }

  // -------------------------------------------------------------------------
  // Writing
  // -------------------------------------------------------------------------

  private result(id: JsonRpcId, result: unknown): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, result });
  }

  private error(id: JsonRpcId, code: number, message: string): Promise<void> {
    return this.write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private toolResult(id: JsonRpcId, text: string, isError: boolean): Promise<void> {
    return this.result(id, { content: [{ type: 'text', text }], isError });
  }

  /** One frame, one line. Resolves when the chunk has actually been handed to the OS, so callers
   *  that ack on "written to the transport" are not acking on a buffer append. */
  private write(message: unknown): Promise<void> {
    return new Promise((resolve) => {
      this.output.write(`${JSON.stringify(message)}\n`, () => resolve());
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
 * vanishes at the far end. Rather than lose data silently, keys are normalised (`-` and friends
 * become `_`) in a second pass, and a normalised key that would collide with a key that was
 * already valid is dropped instead of overwriting it — silently replacing a good value with a
 * different one is worse than losing the one that was malformed. Values are flattened to
 * strings; anything that is not a primitive has no meaningful string form and is dropped.
 */
export function sanitizeMetaKeys(
  meta: Record<string, unknown> | undefined,
  logger: Logger = noopLogger,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (meta === undefined || meta === null) return out;

  // Pass 1: keys that are already legal claim their name.
  for (const [key, value] of Object.entries(meta)) {
    if (!SAFE_META_KEY.test(key)) continue;
    const flat = flattenMetaValue(value);
    if (flat !== undefined) out[key] = flat;
  }
  // Pass 2: everything else, normalised, first-come — and never over the top of pass 1.
  for (const [key, value] of Object.entries(meta)) {
    if (SAFE_META_KEY.test(key)) continue;
    const normalized = key.replace(/[^A-Za-z0-9_]+/g, '_');
    if (normalized.length === 0 || Object.hasOwn(out, normalized)) {
      logger.warn({ key }, 'channel: dropped an unrepresentable meta key');
      continue;
    }
    const flat = flattenMetaValue(value);
    if (flat !== undefined) out[normalized] = flat;
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
