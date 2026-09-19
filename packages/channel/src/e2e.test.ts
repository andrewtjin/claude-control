import { describe, it, expect, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
import { HookReceiver, Store, ChannelRegistry } from '@claude-control/daemon';
import { ChannelServer } from './server.js';
import { DaemonLink } from './daemonLink.js';

// The composition nothing else covers: a real ChannelServer and a real DaemonLink (this package)
// against a real HookReceiver and a real ChannelRegistry (the daemon package), over real loopback
// HTTP and a real stdio pipe.
//
// Every other test in either package drives one side against a STUB of the other — the link
// against a hand-written HTTP stub, the receiver against hand-written handlers — so a wire
// mismatch between them (a renamed field, a status code one side does not expect, an ack shape
// the registry cannot match) is invisible to both suites while being exactly the kind of defect
// that only shows up in front of an operator. This test is the one place the two halves talk to
// each other and nothing in between is pretend.

const SECRET = 'e2e-secret';

interface Rig {
  registry: ChannelRegistry;
  link: DaemonLink;
  server: ChannelServer;
  /** Notifications and responses the "Claude Code" side of the pipe saw. */
  clientSaw: Record<string, unknown>[];
  /** Texts the model sent back out through `reply`. */
  replies: string[];
  /** Items the daemon was handed back when a channel closed with work still on it. */
  recovered: string[];
  /** Every ack the daemon side received, in arrival order. The client seeing a notification says
   *  only that the bytes left the server; the ack is what clears the daemon's in-flight entry, and
   *  it travels back over its own HTTP round trip, so a test that stops the link after the client
   *  saw the prompt must wait for this too or the daemon still counts the item as owed. */
  acked: { injectId: string; state: 'sent' | 'failed' }[];
  say(message: unknown): void;
  /** The session-side end of the stdio pipe, so a test can kill it the way an exiting Claude
   *  Code kills it. */
  output: PassThrough;
  running: Promise<unknown>;
  close(): Promise<void>;
}

const rigs: Rig[] = [];

afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.close();
});

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Stand the whole path up: daemon side (store + receiver + registry) on a real loopback port,
 *  session side (channel server + link) on a real pipe. */
async function rig(sessionId: string): Promise<Rig> {
  const store = new Store(':memory:');
  const recovered: string[] = [];
  const replies: string[] = [];
  const acked: Rig['acked'] = [];
  const receiver = new HookReceiver({
    store,
    secret: SECRET,
    emit: () => undefined,
    daemonId: () => 'daemon-e2e',
    // Short, so a test that waits out a held poll does not wait out the production bound.
    channelPollMs: 2_000,
  });
  const registry = new ChannelRegistry({
    pollMs: 2_000,
    onEnqueue: (attachId) => receiver.wakeChannelPoll(attachId),
  });
  // The same delegation the daemon installs, reduced to the channel half.
  receiver.setChannelHandlers({
    attach: (input) => {
      const result = registry.attach(input);
      return result.ok
        ? { ok: true, attachId: result.attachment.attachId }
        : { ok: false, error: result.reason, retryable: result.reason === 'closing' };
    },
    take: (attachId, source) => registry.take(attachId, source),
    ack: (attachId, injectId, state) => {
      const ok = registry.ack(attachId, injectId, state).ok;
      acked.push({ injectId, state });
      return ok;
    },
    reply: (attachId, text) => {
      if (registry.get(attachId) === undefined) return false;
      replies.push(text);
      return true;
    },
    detach: (attachId) => {
      for (const item of registry.detach(attachId)) recovered.push(item.text);
    },
  });
  const port = await receiver.listen(0);

  const toServer = new PassThrough();
  const fromServer = new PassThrough();
  const clientSaw: Record<string, unknown>[] = [];
  createInterface({ input: fromServer, crlfDelay: Infinity }).on('line', (line) => {
    clientSaw.push(JSON.parse(line) as Record<string, unknown>);
  });

  // The server's `reply` handler routes into the link, but the link cannot be built until the
  // receiver has a port — the same knot the real composition root ties, with the same mutable cell.
  const cell: { link?: DaemonLink } = {};
  const server = new ChannelServer({
    input: toServer,
    output: fromServer,
    onReply: (text) =>
      cell.link?.reply(text) ?? Promise.resolve({ ok: false, error: 'not attached yet' }),
  });
  server.start();
  const say = (message: unknown): void => {
    toServer.write(`${JSON.stringify(message)}\n`);
  };
  say({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  say({ jsonrpc: '2.0', method: 'notifications/initialized' });
  await server.ready(5_000);

  const link = new DaemonLink({
    identity: { sessionId, pid: process.pid, cwd: 'C:\\repo', name: 'repo', source: 'env' },
    discover: () => Promise.resolve({ ok: true as const, address: { port, secret: SECRET } }),
  });
  cell.link = link;
  const running = link.run((item) => server.push(item.text, item.meta));

  const built: Rig = {
    registry,
    link,
    server,
    clientSaw,
    replies,
    recovered,
    acked,
    say,
    output: fromServer,
    running,
    close: async () => {
      link.stop();
      await running;
      await link.detach();
      server.close();
      await receiver.close();
      store.close();
    },
  };
  rigs.push(built);
  await waitFor(() => registry.isAttached(sessionId));
  return built;
}

describe('channel end to end: session server ↔ daemon receiver', () => {
  it('carries a prompt from the daemon into an idle session, and the reply back out', async () => {
    const r = await rig('sess-e2e');

    const queued = r.registry.enqueue('sess-e2e', 'ship the release', { source: 'discord' });
    expect(queued.ok).toBe(true);

    // The held poll is woken by the enqueue, so this lands without waiting out a poll bound —
    // which is the entire reason a channel exists for a session sitting idle at its prompt.
    await waitFor(() => r.clientSaw.some((m) => m.method === 'notifications/claude/channel'));
    const note = r.clientSaw.find((m) => m.method === 'notifications/claude/channel');
    expect(note?.params).toEqual({
      content: 'ship the release',
      meta: { source: 'discord' },
    });

    // The ack really cleared the in-flight entry on the daemon side: a detach now hands nothing
    // back, which is the difference between "delivered" and "still owed to the operator".
    await waitFor(() => r.acked.some((a) => a.state === 'sent'));
    const attachId = r.link.currentAttachId;
    expect(attachId).toBeDefined();
    expect(r.registry.take(attachId ?? '', 'wake')).toEqual([]);

    // And the model's answer travels the other way on the same authenticated connection.
    r.say({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'reply', arguments: { text: 'shipped' } },
    });
    await waitFor(() => r.replies.length > 0);
    expect(r.replies).toEqual(['shipped']);
    // The daemon records the reply before its HTTP response reaches the link, and the tool result
    // is written to the pipe only after that, so the client-visible half is awaited on its own
    // rather than assumed to have landed with the daemon-side one.
    await waitFor(() => r.clientSaw.some((m) => m.id === 2));
    const toolResult = r.clientSaw.find((m) => m.id === 2);
    expect((toolResult?.result as { content: Array<{ text: string }> }).content[0]?.text).toContain(
      'Handed to cctl',
    );
  });

  it('leaves nothing stranded when the session shuts down cleanly', async () => {
    const r = await rig('sess-e2e-clean');
    r.registry.enqueue('sess-e2e-clean', 'do this one thing');
    await waitFor(() => r.clientSaw.some((m) => m.method === 'notifications/claude/channel'));
    // "Delivered" is the daemon's word, not the client's: only once the link's ack has landed is
    // the item off the daemon's books, and a stop before that would hand it back as still owed.
    await waitFor(() => r.acked.some((a) => a.state === 'sent'));

    r.link.stop();
    await r.running;
    await r.link.detach();

    await waitFor(() => !r.registry.isAttached('sess-e2e-clean'));
    // Acknowledged work is gone for good; anything still owed would appear here instead.
    expect(r.recovered).toEqual([]);
  });

  it('hands undelivered work back when the session transport dies mid-flight', async () => {
    const r = await rig('sess-e2e-dead');
    // Kill the pipe first, so the item is taken from the queue and then cannot be written.
    r.server.close();
    r.output.destroy();
    r.registry.enqueue('sess-e2e-dead', 'this one never lands');

    // The failed delivery is acked `failed`, the daemon requeues it, and the throttle keeps that
    // from becoming a spin — so the item is still owed, and a detach must surface it rather than
    // letting it die with the attachment.
    await waitFor(() => {
      const attachId = r.link.currentAttachId;
      if (attachId === undefined) return false;
      const attachment = r.registry.get(attachId);
      return attachment !== undefined;
    });
    r.link.stop();
    await r.running;
    await r.link.detach();

    await waitFor(() => r.recovered.length > 0);
    expect(r.recovered).toEqual(['this one never lands']);
  });
});
