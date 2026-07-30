import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { ChannelServer, SERVER_NAME, sanitizeMetaKeys } from './server.js';
import type { DeliverResult } from './daemonLink.js';

// Real streams and real newline framing: the server is driven exactly the way Claude Code drives
// it, through a pipe, with responses read back by a second real line reader.

/** An async queue of parsed frames read off the server's output stream. */
class Frames {
  private readonly queue: Record<string, unknown>[] = [];
  private readonly waiters: Array<(frame: Record<string, unknown>) => void> = [];

  push(frame: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter(frame);
    else this.queue.push(frame);
  }

  next(): Promise<Record<string, unknown>> {
    const queued = this.queue.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get pending(): number {
    return this.queue.length;
  }
}

interface Harness {
  server: ChannelServer;
  frames: Frames;
  send(message: unknown): void;
  /** Write a frame the client would never write, byte for byte. */
  raw(line: string): void;
  /** Complete the MCP handshake the way a real client does. */
  handshake(protocolVersion?: string): Promise<Record<string, unknown>>;
  replies: string[];
}

const okReply = (): Promise<DeliverResult> => Promise.resolve({ ok: true });

function harness(onReply: (text: string) => Promise<DeliverResult> = okReply): Harness {
  const input = new PassThrough();
  const output = new PassThrough();
  const frames = new Frames();
  const replies: string[] = [];

  createInterface({ input: output, crlfDelay: Infinity }).on('line', (line) => {
    frames.push(JSON.parse(line) as Record<string, unknown>);
  });

  const server = new ChannelServer({
    input,
    output,
    onReply: (text) => {
      replies.push(text);
      return onReply(text);
    },
  });
  server.start();

  const send = (message: unknown): void => {
    input.write(`${JSON.stringify(message)}\n`);
  };

  return {
    server,
    frames,
    send,
    raw: (line: string) => {
      input.write(`${line}\n`);
    },
    replies,
    handshake: async (protocolVersion = '2025-11-25') => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion } });
      const response = await frames.next();
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      await server.ready();
      return response;
    },
  };
}

describe('handshake', () => {
  it('answers initialize with the channel capability and no second permission authority', async () => {
    const h = harness();
    const response = await h.handshake();

    expect(response.id).toBe(1);
    const result = response.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-11-25');
    expect(result.serverInfo).toMatchObject({ name: SERVER_NAME });

    const capabilities = result.capabilities as Record<string, unknown>;
    expect(capabilities.tools).toEqual({});
    const experimental = capabilities.experimental as Record<string, unknown>;
    expect(experimental['claude/channel']).toEqual({});
    // cctl already approves permissions through its hook path. A second declared approver would
    // put two independent answers on one tool call.
    expect(Object.keys(experimental)).toEqual(['claude/channel']);
  });

  it('echoes whatever protocol version the client advertises', async () => {
    const h = harness();
    const response = await h.handshake('2099-01-01');
    expect((response.result as Record<string, unknown>).protocolVersion).toBe('2099-01-01');
  });

  it('only reports the channel live after notifications/initialized', async () => {
    const h = harness();
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await h.frames.next();
    expect(h.server.isInitialized).toBe(false);

    h.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await h.server.ready();
    expect(h.server.isInitialized).toBe(true);
    // A notification must not be answered.
    expect(h.frames.pending).toBe(0);
  });
});

describe('tools', () => {
  it('exposes exactly one tool, and its description steers replies off the transcript', async () => {
    const h = harness();
    await h.handshake();
    h.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

    const tools = ((await h.frames.next()).result as { tools: Array<Record<string, unknown>> })
      .tools;
    expect(tools).toHaveLength(1);
    const [reply] = tools;
    expect(reply?.name).toBe('reply');
    const description = String(reply?.description);
    expect(description).toContain('Discord');
    expect(description).toMatch(/never reach them/i);
    expect(reply?.inputSchema).toMatchObject({ required: ['text'] });
  });

  it('round-trips a reply and tells the model it landed', async () => {
    const h = harness();
    await h.handshake();
    h.send({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'on it' } },
    });

    const response = await h.frames.next();
    expect(h.replies).toEqual(['on it']);
    expect(response.result).toMatchObject({ isError: false });
    expect((response.result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'Delivered',
    );
  });

  it('tells the model when the reply did NOT land', async () => {
    const h = harness(() => Promise.resolve({ ok: false, error: 'daemon unreachable' }));
    await h.handshake();
    h.send({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'hello' } },
    });

    const response = await h.frames.next();
    expect(response.result).toMatchObject({ isError: true });
    expect((response.result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'daemon unreachable',
    );
  });

  it('rejects an empty reply instead of sending nothing', async () => {
    const h = harness();
    await h.handshake();
    h.send({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: '   ' } },
    });

    expect((await h.frames.next()).result).toMatchObject({ isError: true });
    expect(h.replies).toEqual([]);
  });

  it('rejects any tool that is not reply', async () => {
    const h = harness();
    await h.handshake();
    h.send({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'react' } });

    expect((await h.frames.next()).error).toMatchObject({ code: -32602 });
  });
});

describe('unknown traffic', () => {
  it('answers an unknown request with -32601 so the client never hangs', async () => {
    const h = harness();
    await h.handshake();
    h.send({ jsonrpc: '2.0', id: 7, method: 'resources/list' });

    const response = await h.frames.next();
    expect(response.id).toBe(7);
    expect(response.error).toMatchObject({ code: -32601 });
  });

  it('answers ping, because it is base protocol and not an extension', async () => {
    const h = harness();
    await h.handshake();
    h.send({ jsonrpc: '2.0', id: 8, method: 'ping' });

    const response = await h.frames.next();
    expect(response.result).toEqual({});
  });

  it('stays silent for an unknown notification', async () => {
    const h = harness();
    await h.handshake();
    h.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    // Prove silence by sending something that IS answered and seeing it arrive first.
    h.send({ jsonrpc: '2.0', id: 9, method: 'ping' });

    expect((await h.frames.next()).id).toBe(9);
  });

  it('answers an unparsable frame with a null-id parse error', async () => {
    const h = harness();
    await h.handshake();
    h.raw('{ this is not json');

    const response = await h.frames.next();
    expect(response.id).toBeNull();
    expect(response.error).toMatchObject({ code: -32700 });
  });

  it('answers a well-formed but non-object frame with invalid request', async () => {
    const h = harness();
    await h.handshake();
    h.raw('"a bare string"');

    expect((await h.frames.next()).error).toMatchObject({ code: -32600 });
  });
});

describe('channel notifications', () => {
  it('pushes content and meta as notifications/claude/channel', async () => {
    const h = harness();
    await h.handshake();
    await h.server.push('deploy is red', { source: 'discord', seq: '3' });

    const frame = await h.frames.next();
    expect(frame.method).toBe('notifications/claude/channel');
    expect(frame.id).toBeUndefined();
    expect(frame.params).toEqual({
      content: 'deploy is red',
      meta: { source: 'discord', seq: '3' },
    });
  });

  it('sanitizes meta keys on the way out', async () => {
    const h = harness();
    await h.handshake();
    // Claude Code silently discards hyphenated keys, so `message-id` would vanish untouched.
    await h.server.push('hi', { 'message-id': '42', source: 'discord' });

    const frame = await h.frames.next();
    expect((frame.params as { meta: Record<string, string> }).meta).toEqual({
      source: 'discord',
      message_id: '42',
    });
  });
});

describe('sanitizeMetaKeys', () => {
  it('passes already-legal keys through untouched', () => {
    expect(sanitizeMetaKeys({ source: 'discord', seq_2: 'x' })).toEqual({
      source: 'discord',
      seq_2: 'x',
    });
  });

  it('normalizes every character Claude Code would drop the key over', () => {
    expect(sanitizeMetaKeys({ 'message-id': 'a', 'thread.ts': 'b', 'a b': 'c' })).toEqual({
      message_id: 'a',
      thread_ts: 'b',
      a_b: 'c',
    });
  });

  it('never lets a normalized key overwrite one that was already legal', () => {
    // Silently replacing a good value with a different one is worse than losing the bad key.
    expect(sanitizeMetaKeys({ a_b: 'legal', 'a-b': 'normalized' })).toEqual({ a_b: 'legal' });
  });

  it('drops a key with no representable form', () => {
    expect(sanitizeMetaKeys({ '': 'nameless', ok: '1' })).toEqual({ ok: '1' });
  });

  it('flattens primitive values and drops the rest', () => {
    expect(
      sanitizeMetaKeys({
        seq: 7,
        urgent: true,
        ratio: Number.NaN,
        nested: { a: 1 },
        missing: undefined,
        empty: null,
      }),
    ).toEqual({ seq: '7', urgent: 'true' });
  });

  it('returns an empty object rather than undefined for no meta', () => {
    expect(sanitizeMetaKeys(undefined)).toEqual({});
  });
});
