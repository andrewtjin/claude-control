// Transport-level tests for the live-channel endpoints. Kept in their own file rather than
// appended to hookReceiver.test.ts, which is already large and covers a different surface.
//
// Real node:http on an ephemeral port throughout — the properties under test (a response held
// open, a bound that expires it, a shutdown that drains it) only exist at that boundary, and a
// mocked transport would agree with any of them.

import { request } from 'node:http';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChannelRegistry } from './channelRegistry.js';
import {
  HookReceiver,
  type ChannelInjectionView,
  type HookReceiverChannelHandlers,
} from './hookReceiver.js';
import { Store } from './store.js';

interface RawResponse {
  status: number;
  body: unknown;
}

function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const SECRET = 'test-secret-abc';
const auth = { 'x-claude-control-secret': SECRET };
/** Short enough that a poll bound is a test, not a wait. */
const POLL_MS = 250;

let store: Store;
let receiver: HookReceiver;
let registry: ChannelRegistry;
let port: number;
let replies: { attachId: string; text: string }[];
let recovered: string[];

/** The same binding daemon.ts installs, minus the envelope plumbing. */
function handlersFor(reg: ChannelRegistry): HookReceiverChannelHandlers {
  return {
    attach: (input) => {
      const result = reg.attach(input);
      return result.ok
        ? { ok: true, attachId: result.attachment.attachId }
        : { ok: false, error: 'already attached' };
    },
    take: (attachId): ChannelInjectionView[] | undefined => reg.take(attachId),
    ack: (attachId, injectId, state) => reg.ack(attachId, injectId, state).ok,
    reply: (attachId, text) => {
      if (reg.get(attachId) === undefined) return false;
      replies.push({ attachId, text });
      return true;
    },
    detach: (attachId) => {
      for (const item of reg.detach(attachId)) recovered.push(item.text);
    },
  };
}

beforeEach(async () => {
  store = new Store(':memory:');
  replies = [];
  recovered = [];
  receiver = new HookReceiver({
    store,
    secret: SECRET,
    emit: () => undefined,
    daemonId: () => 'daemon-1',
    channelPollMs: POLL_MS,
  });
  registry = new ChannelRegistry({ onEnqueue: (id) => receiver.wakeChannelPoll(id) });
  receiver.setChannelHandlers(handlersFor(registry));
  port = await receiver.listen(0);
});

afterEach(async () => {
  await receiver.close();
  store.close();
});

async function attach(sessionId = 'sess-1'): Promise<string> {
  const res = await post(
    port,
    '/cli/channel/attach',
    { sessionId, pid: 4242, cwd: 'C:\\repo', name: 'repo-ab', identitySource: 'env' },
    auth,
  );
  expect(res.status).toBe(200);
  return (res.body as { attachId: string }).attachId;
}

describe('auth and validation', () => {
  it('rejects an unauthenticated channel request like every other endpoint', async () => {
    const res = await post(port, '/cli/channel/attach', { sessionId: 's', pid: 1 });
    expect(res.status).toBe(401);
  });

  it('requires sessionId and pid to attach', async () => {
    const res = await post(port, '/cli/channel/attach', { sessionId: 's' }, auth);
    expect(res.status).toBe(400);
  });

  it('rejects an identitySource it does not recognise', async () => {
    const res = await post(
      port,
      '/cli/channel/attach',
      { sessionId: 's', pid: 1, identitySource: 'vibes' },
      auth,
    );
    expect(res.status).toBe(400);
  });

  it('404s an unknown channel endpoint rather than falling through to the hook handler', async () => {
    const res = await post(port, '/cli/channel/nonsense', { attachId: 'x' }, auth);
    expect(res.status).toBe(404);
  });

  it('503s before the daemon has installed its handlers', async () => {
    const bare = new HookReceiver({
      store,
      secret: SECRET,
      emit: () => undefined,
      daemonId: () => 'daemon-1',
    });
    const barePort = await bare.listen(0);
    try {
      const res = await post(barePort, '/cli/channel/attach', { sessionId: 's', pid: 1 }, auth);
      expect(res.status).toBe(503);
    } finally {
      await bare.close();
    }
  });
});

describe('attach', () => {
  it('mints an attachId and reports the poll bound the client should expect', async () => {
    const res = await post(
      port,
      '/cli/channel/attach',
      { sessionId: 'sess-1', pid: 7, identitySource: 'env' },
      auth,
    );
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, pollMs: POLL_MS });
  });

  it('409s a second server for the same session, so the loser exits instead of retrying', async () => {
    await attach('sess-1');
    const res = await post(
      port,
      '/cli/channel/attach',
      { sessionId: 'sess-1', pid: 8, identitySource: 'env' },
      auth,
    );
    expect(res.status).toBe(409);
  });
});

describe('next', () => {
  it('returns queued work immediately', async () => {
    const attachId = await attach();
    registry.enqueue('sess-1', 'do the thing');
    const res = await post(port, '/cli/channel/next', { attachId }, auth);
    expect(res.status).toBe(200);
    const items = (res.body as { items: ChannelInjectionView[] }).items;
    expect(items.map((i) => i.text)).toEqual(['do the thing']);
  });

  it('holds the response open and completes it the moment work arrives', async () => {
    const attachId = await attach();
    const pending = post(port, '/cli/channel/next', { attachId }, auth);
    // Give the poll time to be registered as held, then push work into it.
    await new Promise((r) => setTimeout(r, 60));
    const started = Date.now();
    registry.enqueue('sess-1', 'woken');
    const res = await pending;
    const items = (res.body as { items: ChannelInjectionView[] }).items;
    expect(items.map((i) => i.text)).toEqual(['woken']);
    // It must have been woken, not answered by the bound expiring.
    expect(Date.now() - started).toBeLessThan(POLL_MS);
  });

  it('answers empty when the bound elapses, so the client re-polls', async () => {
    const attachId = await attach();
    const res = await post(port, '/cli/channel/next', { attachId }, auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, items: [] });
  });

  it('404s an unknown attachment so the client knows to re-attach', async () => {
    const res = await post(port, '/cli/channel/next', { attachId: 'gone' }, auth);
    expect(res.status).toBe(404);
  });

  it('never abandons a socket when a second poll replaces the first', async () => {
    const attachId = await attach();
    const first = post(port, '/cli/channel/next', { attachId }, auth);
    await new Promise((r) => setTimeout(r, 60));
    const second = post(port, '/cli/channel/next', { attachId }, auth);
    // The displaced poll is answered rather than left hanging.
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
  });
});

describe('ack, reply, detach', () => {
  it('acknowledges a delivered item', async () => {
    const attachId = await attach();
    const queued = registry.enqueue('sess-1', 'hello');
    if (!queued.ok) throw new Error('enqueue failed');
    await post(port, '/cli/channel/next', { attachId }, auth);
    const res = await post(
      port,
      '/cli/channel/ack',
      { attachId, injectId: queued.injectId, state: 'sent' },
      auth,
    );
    expect(res.status).toBe(200);
  });

  it('rejects an ack with a state it does not understand', async () => {
    const attachId = await attach();
    const res = await post(
      port,
      '/cli/channel/ack',
      { attachId, injectId: 'x', state: 'probably' },
      auth,
    );
    expect(res.status).toBe(400);
  });

  it('routes a reply back to the daemon', async () => {
    const attachId = await attach();
    const res = await post(port, '/cli/channel/reply', { attachId, text: 'done' }, auth);
    expect(res.status).toBe(200);
    expect(replies).toEqual([{ attachId, text: 'done' }]);
  });

  it('refuses an empty reply rather than pushing a blank card', async () => {
    const attachId = await attach();
    expect((await post(port, '/cli/channel/reply', { attachId, text: '' }, auth)).status).toBe(400);
  });

  it('answers a held poll before detaching, so nothing is left waiting on a dead attachment', async () => {
    const attachId = await attach();
    const pending = post(port, '/cli/channel/next', { attachId }, auth);
    await new Promise((r) => setTimeout(r, 60));
    await post(port, '/cli/channel/detach', { attachId }, auth);
    expect((await pending).status).toBe(200);
  });

  it('hands undelivered work back on detach', async () => {
    const attachId = await attach();
    registry.enqueue('sess-1', 'never sent');
    await post(port, '/cli/channel/detach', { attachId }, auth);
    expect(recovered).toEqual(['never sent']);
  });
});

describe('shutdown', () => {
  it('drains held polls so close() does not wait on them', async () => {
    const attachId = await attach();
    const pending = post(port, '/cli/channel/next', { attachId }, auth);
    await new Promise((r) => setTimeout(r, 60));
    const started = Date.now();
    await receiver.close();
    // close() must not have waited out the poll bound.
    expect(Date.now() - started).toBeLessThan(POLL_MS);
    expect((await pending).status).toBe(200);
    // afterEach closes again; that is a no-op and must not throw.
  });
});
