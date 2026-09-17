import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { runChannelServer, type ChannelLink } from './run.js';
import type { ChannelItem, DeliverResult, RunOutcome } from './daemonLink.js';
import type { IdentityResult } from './identity.js';
import { noopLogger } from './logger.js';

// What this file is for: the composition root makes three decisions nothing else in the package
// makes — refuse a session it cannot identify, refuse a session that never completed its MCP
// handshake, and stop the poll loop BEFORE releasing the attachment — and all three are decisions
// about what NOT to do, which no downstream module can observe. Driven over real streams with a
// fake link, so the wiring is exercised without a daemon or a Claude Code session.

const IDENTITY = {
  ok: true as const,
  sessionId: 'sess-run',
  source: 'env' as const,
  pid: 4242,
  cwd: 'C:\\repo',
  ambiguous: false,
};

/** A stand-in for the real loopback client that records what the composition did to it, and in
 *  what order — which is the whole point for the shutdown case. */
function fakeLink(outcome: RunOutcome = { reason: 'stopped' }): ChannelLink & {
  calls: string[];
  replies: string[];
  deliver(item: ChannelItem): Promise<DeliverResult>;
  finish(): void;
} {
  const calls: string[] = [];
  const replies: string[] = [];
  let deliver: ((item: ChannelItem) => Promise<DeliverResult>) | undefined;
  let finishRun: (() => void) | undefined;
  return {
    calls,
    replies,
    deliver: (item) => deliver?.(item) ?? Promise.resolve({ ok: false, error: 'not running' }),
    finish: () => finishRun?.(),
    run: (fn) => {
      calls.push('run');
      deliver = fn;
      return new Promise<RunOutcome>((resolve) => {
        finishRun = () => resolve(outcome);
      });
    },
    reply: (text) => {
      replies.push(text);
      return Promise.resolve({ ok: true });
    },
    stop: () => {
      calls.push('stop');
      finishRun?.();
    },
    detach: () => {
      calls.push('detach');
      return Promise.resolve();
    },
  };
}

interface Harness {
  /** Frames the server wrote back to the "client". */
  frames: Record<string, unknown>[];
  send(message: unknown): void;
  /** Complete the handshake the way a real client does. */
  handshake(): Promise<void>;
  /** Wait until a frame satisfying `match` has arrived. */
  await(match: (frame: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  exitCode: Promise<number>;
  /** The shutdown trigger the composition installed, if the test asked to capture it. */
  shutdown(reason: string): void;
}

function harness(options: {
  identity?: IdentityResult;
  link?: ChannelLink;
  handshakeTimeoutMs?: number;
}): Harness {
  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const frames: Record<string, unknown>[] = [];
  const waiters: Array<() => void> = [];
  createInterface({ input: fromServer, crlfDelay: Infinity }).on('line', (line) => {
    frames.push(JSON.parse(line) as Record<string, unknown>);
    for (const waiter of waiters.splice(0)) waiter();
  });

  let trigger: (reason: string) => void = () => {};
  const exitCode = runChannelServer({
    input: toServer,
    output: fromServer,
    logger: noopLogger,
    resolveIdentity: () => Promise.resolve(options.identity ?? IDENTITY),
    ...(options.link !== undefined ? { createLink: () => options.link as ChannelLink } : {}),
    ...(options.handshakeTimeoutMs !== undefined
      ? { handshakeTimeoutMs: options.handshakeTimeoutMs }
      : {}),
    // The real one registers process-level signal handlers and calls `process.exit`, neither of
    // which belongs in a test runner; the shutdown BEHAVIOUR is what is under test, not the
    // signal plumbing.
    installShutdown: (stop) => {
      trigger = () => void stop();
      return trigger;
    },
  });

  const send = (message: unknown): void => {
    toServer.write(`${JSON.stringify(message)}\n`);
  };
  const awaitFrame = (
    match: (frame: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> =>
    new Promise((resolve) => {
      const check = (): void => {
        const found = frames.find(match);
        if (found !== undefined) resolve(found);
        else waiters.push(check);
      };
      check();
    });

  return {
    frames,
    send,
    exitCode,
    await: awaitFrame,
    shutdown: (reason) => trigger(reason),
    handshake: async () => {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'x' } });
      await awaitFrame((f) => f.id === 1);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    },
  };
}

/** Ask the server to send a reply and read back what the model was told. */
async function callReply(h: Harness, id: number, text: string): Promise<string> {
  h.send({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: 'reply', arguments: { text } },
  });
  const frame = await h.await((f) => f.id === id);
  const result = frame.result as { content: Array<{ text: string }> };
  return result.content[0]?.text ?? '';
}

describe('the identity gate', () => {
  it('serves the handshake but attaches nothing when the session cannot be identified', async () => {
    const link = fakeLink();
    const h = harness({
      link,
      identity: { ok: false, reason: 'the process tree contradicts CLAUDE_CODE_SESSION_ID' },
    });
    await h.handshake();

    // Exiting instead would show up in Claude Code as a broken MCP server with no explanation,
    // and Claude Code does not restart one — so the server stays up and simply accepts nothing.
    expect(await h.exitCode).toBe(0);
    expect(link.calls).toEqual([]);
  });

  it('tells the model WHY its reply cannot be sent, rather than failing silently', async () => {
    const h = harness({
      link: fakeLink(),
      identity: { ok: false, reason: 'no ancestor of pid 1 is a live Claude Code session' },
    });
    await h.handshake();
    await h.exitCode;

    const told = await callReply(h, 2, 'did anyone hear me?');
    expect(told).toContain('could not be identified');
    expect(told).toContain('no ancestor of pid 1');
  });
});

describe('the handshake gate', () => {
  it('does not attach a session that never completed its MCP handshake', async () => {
    const link = fakeLink();
    const h = harness({ link, handshakeTimeoutMs: 25 });
    // `initialize` is answered, but `notifications/initialized` never arrives — the client is not
    // listening on the channel, so an attachment would tell the daemon this session can take
    // injections while stopping it using the turn-boundary path that would still have worked.
    h.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await h.await((f) => f.id === 1);

    expect(await h.exitCode).toBe(0);
    expect(link.calls).toEqual([]);

    const told = await callReply(h, 2, 'hello?');
    expect(told).toContain('never completed its MCP handshake');
  });

  it('attaches as soon as the handshake does complete', async () => {
    const link = fakeLink();
    const h = harness({ link, handshakeTimeoutMs: 5_000 });
    await h.handshake();
    // The link is only constructed after `notifications/initialized`; nothing else in the process
    // can observe that ordering, which is why it is asserted here.
    await h.await((f) => f.id === 1);
    while (link.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    expect(link.calls).toEqual(['run']);

    link.finish();
    expect(await h.exitCode).toBe(0);
  });
});

describe('the running server', () => {
  it('pushes what the daemon hands it into the session, and routes replies back out', async () => {
    const link = fakeLink();
    const h = harness({ link });
    await h.handshake();
    while (link.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    const delivered = await link.deliver({
      injectId: 'i-1',
      text: 'ship the release',
      meta: { source: 'discord' },
    });
    expect(delivered).toEqual({ ok: true });
    const note = await h.await((f) => f.method === 'notifications/claude/channel');
    expect(note.params).toEqual({
      content: 'ship the release',
      meta: { source: 'discord' },
    });

    expect(await callReply(h, 2, 'shipped')).toContain('Handed to cctl');
    expect(link.replies).toEqual(['shipped']);
    link.finish();
    await h.exitCode;
  });

  it('exits non-zero on a conflict, because two servers on one session is not a clean exit', async () => {
    const link = fakeLink({ reason: 'conflict' });
    const h = harness({ link });
    await h.handshake();
    while (link.calls.length === 0) await new Promise((r) => setTimeout(r, 5));
    link.finish();

    expect(await h.exitCode).toBe(1);
  });
});

describe('shutdown', () => {
  it('stops the poll loop BEFORE releasing the attachment', async () => {
    const link = fakeLink();
    const h = harness({ link });
    await h.handshake();
    while (link.calls.length === 0) await new Promise((r) => setTimeout(r, 5));

    h.shutdown('stdin-eof');
    await h.exitCode;

    // Order is the assertion. `detach` with the poll still running races its own teardown: the
    // loop can re-attach the session in the window between the release and the process exiting,
    // leaving the next daemon holding an attachment for a session that is gone.
    expect(link.calls).toEqual(['run', 'stop', 'detach']);
  });

  it('is wired before the identity gate, so even a refusing server still tears down', async () => {
    const link = fakeLink();
    const h = harness({ link, identity: { ok: false, reason: 'unidentified' } });
    await h.handshake();
    await h.exitCode;

    // No link was ever built, so there is nothing to stop — but the trigger must exist and must
    // not throw, or a degraded server lingers until Claude Code kills the pipe.
    expect(() => h.shutdown('SIGTERM')).not.toThrow();
    expect(link.calls).toEqual([]);
  });
});
