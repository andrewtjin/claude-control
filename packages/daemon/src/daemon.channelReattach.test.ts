// What happens to an operator's prompt when a session's channel comes and goes.
//
// The channel path and the turn-boundary path hand work to each other, and until now they only
// handed it ONE way: everything that retires a channel (a clean detach, a dead pid, the stale
// sweep, a shutdown) moved undelivered prompts onto the turn-boundary queue, and nothing ever
// moved them back. A session sitting IDLE never reaches a turn boundary — which is the exact
// state a channel exists to reach — so a prompt that fell back after the phone said "Sent to live
// session" waited there for the rest of the session's life while every later prompt overtook it.
//
// These tests drive the whole daemon: real loopback HTTP for attach/detach, a real in-process
// relay for the prompts, a real sqlite file for the restart cases. The queues involved are
// private, so every assertion here is made through a surface an operator actually touches — what
// a channel poll returns, and what a Stop hook is answered with.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decode,
  encode,
  stamp,
  isType,
  negotiateVersion,
  type Envelope,
  type EnvelopeDraft,
} from '@claude-control/shared-protocol';
import type {
  RecoverResult,
  ActivateResult,
  ReauthResult,
  StoredAccount,
} from '@claude-control/switch-engine';
import type {
  SessionManager,
  SessionRecord,
  AgentSdkClient,
} from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import { ControlPlaneClient, type DaemonIdentity } from './controlPlaneClient.js';
import { Daemon, DELIVERED_INJECT_SESSIONS, type SwitchEngineLike } from './daemon.js';

const SECRET = 'shh';
const DAEMON_ID = 'daemon-under-test';

/** Just enough relay to accept a daemon, collect what it emits, and push prompts down. */
class MiniRelay {
  private readonly wss: WebSocketServer;
  private socket: WebSocket | undefined;
  readonly received: Envelope[] = [];

  constructor() {
    this.wss = new WebSocketServer({ port: 0 });
    this.wss.on('connection', (socket) => {
      this.socket = socket;
      socket.on('message', (raw: RawData) => {
        const decoded = decode(rawToString(raw));
        if (!decoded.ok) return;
        this.received.push(decoded.envelope);
        if (isType(decoded.envelope, 'hello')) {
          const negotiated = negotiateVersion(decoded.envelope.payload.protocolVersion);
          socket.send(
            encode(
              stamp({
                daemonId: decoded.envelope.daemonId,
                type: 'hello.result',
                payload: {
                  ok: negotiated !== null,
                  ...(negotiated !== null ? { negotiatedVersion: negotiated } : {}),
                },
              }),
            ),
          );
        }
      });
    });
  }

  async listen(): Promise<number> {
    await new Promise<void>((resolve) => this.wss.once('listening', resolve));
    const addr = this.wss.address();
    if (addr === null || typeof addr === 'string') throw new Error('no address');
    return addr.port;
  }

  push(draft: EnvelopeDraft): Envelope {
    const envelope = stamp(draft);
    this.socket?.send(encode(envelope));
    return envelope;
  }

  close(): Promise<void> {
    return new Promise<void>((resolve, reject) =>
      this.wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

const fakeSwitchEngine = (): SwitchEngineLike => ({
  recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
  activate: (id: string): Promise<ActivateResult> =>
    Promise.resolve({
      ok: true,
      activeAccountId: id,
      refreshed: false,
      adoptedPreviousRotation: false,
      wroteCredentials: true,
    }),
  listAccounts: (): Promise<StoredAccount[]> => Promise.resolve([]),
  getActiveId: (): Promise<string | null> => Promise.resolve(null),
  reauthenticate: (id: string): Promise<ReauthResult> =>
    Promise.resolve({
      account: { id, label: id, quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
      healedLiveLogin: false,
      identityVerified: true,
    }),
});

/** No managed sessions anywhere in this file: every case is a REGISTERED TERMINAL session, which
 *  is the only kind that has both a channel and a turn-boundary queue. */
const fakeSessionManager = (): SessionManager => ({
  spawnManaged: () => Promise.reject(new Error('not used')),
  attachObserved: () => Promise.reject(new Error('not used')),
  get: () => undefined,
  list: (): SessionRecord[] => [],
  recover: (): Promise<SessionRecord[]> => Promise.resolve([]),
  prune: (): Promise<SessionRecord[]> => Promise.resolve([]),
});

const fakeAgentSdkClient: AgentSdkClient = {
  query: async function* () {},
  interrupt: () => Promise.resolve(),
  end: () => Promise.resolve(),
};

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let relay: MiniRelay;
let relayPort: number;
let store: Store;
let hookReceiver: HookReceiver;
let controlPlaneClient: ControlPlaneClient;
let attributionJournal: AttributionJournal;
let daemon: Daemon | undefined;
let stateDir: string;
let hookPort: number;

beforeEach(async () => {
  relay = new MiniRelay();
  relayPort = await relay.listen();
  stateDir = await mkdtemp(join(tmpdir(), 'cctl-channel-reattach-'));
});

afterEach(async () => {
  await daemon?.stop().catch(() => undefined);
  daemon = undefined;
  await relay.close();
  await rm(stateDir, { recursive: true, force: true });
});

/** Build and start a daemon over `dbPath` (a real file, so a restart can read what the previous
 *  one left), returning its loopback port. */
async function startDaemon(dbPath: string): Promise<number> {
  store = new Store(dbPath);
  hookReceiver = new HookReceiver({
    store,
    secret: SECRET,
    emit: () => undefined,
    daemonId: () => DAEMON_ID,
  });
  controlPlaneClient = new ControlPlaneClient({
    url: `ws://127.0.0.1:${relayPort}`,
    identityStore: {
      load: () => Promise.resolve<DaemonIdentity>({ daemonId: DAEMON_ID, daemonToken: 'tok' }),
      save: () => Promise.resolve(),
    },
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });
  attributionJournal = new AttributionJournal({ store, vaultDir: stateDir });
  let captured: number | undefined;
  daemon = new Daemon({
    store,
    switchEngine: fakeSwitchEngine(),
    sessionManager: fakeSessionManager(),
    poller: new UsagePoller({
      fetch: () => Promise.reject(new Error('not used')),
      getToken: () => Promise.resolve(undefined),
      getCachedUsage: () => Promise.resolve({ limits: [] }),
    }),
    attributionJournal,
    hookReceiver,
    controlPlaneClient,
    createAgentSdkClient: () => fakeAgentSdkClient,
    publishHookEndpoint: (port) => {
      captured = port;
      return Promise.resolve();
    },
    pollIntervalMs: 100_000,
  });
  await daemon.start();
  await waitFor(() => captured !== undefined);
  hookPort = captured as number;
  return hookPort;
}

/** Simulate the daemon dying WITHOUT its drain: a `taskkill /F`, a crash, a logoff. Only the
 *  sockets and the database handle are released — `Daemon.stop()`, which is what moves queued
 *  channel work somewhere durable, deliberately never runs. */
async function killDaemon(): Promise<void> {
  controlPlaneClient.close();
  await hookReceiver.close();
  store.close();
  daemon = undefined;
}

/** `cctl session register`ed terminal session, seeded directly. */
function seedTerminalSession(id: string): void {
  store.upsertSession({
    id,
    kind: 'interactive',
    state: 'active',
    accountId: null,
    json: JSON.stringify({
      id,
      kind: 'interactive',
      state: 'active',
      watch: true,
      registeredAtMs: 0,
      updatedAtMs: 0,
    }),
    updatedAtMs: 0,
  });
}

async function channelPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${hookPort}/cli/channel/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-control-secret': SECRET },
    body: JSON.stringify(body),
  });
  return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

/** A `cctl session <verb>` call, over the same loopback endpoint the CLI uses. */
async function sessionPost(verb: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`http://127.0.0.1:${hookPort}/cli/session/${verb}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-control-secret': SECRET },
    body: JSON.stringify(body),
  });
  return ((await res.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

async function attachChannel(sessionId: string): Promise<string> {
  const body = await channelPost('attach', {
    sessionId,
    pid: process.pid,
    identitySource: 'env',
  });
  const attachId = body.attachId;
  if (typeof attachId !== 'string') throw new Error(`attach failed: ${JSON.stringify(body)}`);
  return attachId;
}

/** What a channel server's poll would be handed right now. */
async function pollChannel(attachId: string): Promise<string[]> {
  const body = await channelPost('next', { attachId });
  const items = (body.items ?? []) as { text: string }[];
  return items.map((item) => item.text);
}

/** Answer a Stop hook the way the CLI's forwarder does, and report what the session was told. */
async function stopHook(sessionId: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`http://127.0.0.1:${hookPort}/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-claude-control-secret': SECRET },
    body: JSON.stringify({ hook_event_name: 'Stop', session_id: sessionId }),
  });
  return (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
}

function inject(sessionId: string, text: string, key: string): void {
  relay.push({
    daemonId: DAEMON_ID,
    type: 'prompt.inject',
    payload: { sessionId, text, idempotencyKey: key },
  });
}

function cardsOfType(type: string): { sessionId?: string; body?: string }[] {
  return relay.received
    .filter((e) => e.type === 'hook.notification' && e.payload.notificationType === type)
    .map((e) => (e.type === 'hook.notification' ? e.payload : {}));
}

const countOf = (type: string): number => cardsOfType(type).length;

describe('a replacement channel inherits what the old one left behind', () => {
  it('takes back a prompt that fell off a cleanly detached predecessor, in order', async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-clean');
    const first = await attachChannel('sess-clean');

    inject('sess-clean', 'the original prompt', 'k1');
    await waitFor(() => countOf('channel_sent') === 1);

    // The ordinary exit: Claude Code closes the pipe, the server detaches, the daemon falls the
    // undelivered prompt back to the turn boundary and says so.
    await channelPost('detach', { attachId: first });
    await waitFor(() => countOf('channel_fell_back') === 1);

    // A second prompt arrives while there is no channel at all, so it queues behind the first.
    inject('sess-clean', 'the later prompt', 'k2');
    await waitFor(() => countOf('steering_queued') === 1);

    // A replacement server attaches for the same session — the moment both prompts could be
    // delivered at once instead of waiting for a boundary an idle session never reaches.
    const second = await attachChannel('sess-clean');
    expect(await pollChannel(second)).toEqual(['the original prompt', 'the later prompt']);

    // …and they really left the turn-boundary queue, rather than being delivered by both paths.
    expect(await stopHook('sess-clean')).toEqual({ ok: true });
  });

  it('keeps arrival order when the replacement already has newer work of its own', async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-order');
    const first = await attachChannel('sess-order');
    inject('sess-order', 'written first', 'o1');
    await waitFor(() => countOf('channel_sent') === 1);
    await channelPost('detach', { attachId: first });
    await waitFor(() => countOf('channel_fell_back') === 1);

    const second = await attachChannel('sess-order');
    inject('sess-order', 'written second', 'o2');
    await waitFor(() => countOf('channel_sent') === 2);

    // Delivery order is the one property an operator notices, and it is the order they WROTE in,
    // not the order the two delivery paths happened to hand the prompts over in.
    expect(await pollChannel(second)).toEqual(['written first', 'written second']);
  });

  it('promotes a prompt that arrived before the channel server finished attaching', async () => {
    // The same stranding with a different cause: the session started, its hooks are live, the
    // operator sent a prompt — and the channel server was still resolving its identity. That
    // prompt is queued against a boundary that may never come while a live channel exists.
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-race');
    inject('sess-race', 'sent a second too early', 'r1');
    await waitFor(() => countOf('steering_queued') === 1);

    const attachId = await attachChannel('sess-race');
    expect(await pollChannel(attachId)).toEqual(['sent a second too early']);
  });
});

describe('a prompt outlives the daemon', () => {
  it('reaches the channel on attach after a clean restart', async () => {
    const dbPath = join(stateDir, 'daemon.db');
    await startDaemon(dbPath);
    seedTerminalSession('sess-restart');
    await attachChannel('sess-restart');
    inject('sess-restart', 'survive the restart', 's1');
    await waitFor(() => countOf('channel_sent') === 1);

    await daemon?.stop();
    daemon = undefined;
    await startDaemon(dbPath);

    // Nothing is attached at startup and nothing can know whether the session's channel server is
    // still alive, so the prompt reloads onto the turn-boundary queue — and the instant a channel
    // server does re-attach it takes the faster path instead.
    const attachId = await attachChannel('sess-restart');
    expect(await pollChannel(attachId)).toEqual(['survive the restart']);
  });

  it('survives a daemon that is killed outright, with no drain at all', async () => {
    const dbPath = join(stateDir, 'daemon.db');
    await startDaemon(dbPath);
    seedTerminalSession('sess-kill');
    await attachChannel('sess-kill');
    inject('sess-kill', 'the phone was told this was sent', 'k1');
    await waitFor(() => countOf('channel_sent') === 1);

    // `taskkill /F`, a crash, a logoff: the registry holding this prompt was pure memory, so
    // before it had a row of its own the prompt vanished here — after the operator had already
    // been told it was sent, with nothing anywhere to say otherwise.
    await killDaemon();
    await startDaemon(dbPath);

    // Deliverable by whichever path the session reaches first.
    const attachId = await attachChannel('sess-kill');
    expect(await pollChannel(attachId)).toEqual(['the phone was told this was sent']);
  });

  it('delivers a killed daemon’s prompt at a turn boundary when no channel comes back', async () => {
    const dbPath = join(stateDir, 'daemon.db');
    await startDaemon(dbPath);
    seedTerminalSession('sess-kill-2');
    await attachChannel('sess-kill-2');
    inject('sess-kill-2', 'still owed', 'k2');
    await waitFor(() => countOf('channel_sent') === 1);
    await killDaemon();
    await startDaemon(dbPath);

    // The channel server died with the session, or never came back. The turn-boundary queue is a
    // worse delivery path but a real one, and the restored prompt has to be on it.
    expect(await stopHook('sess-kill-2')).toEqual({ decision: 'block', reason: 'still owed' });
  });
});

describe('a delivery confirmation that arrives late', () => {
  it('does not let the same prompt be delivered a second time', async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-ack');
    const attachId = await attachChannel('sess-ack');
    inject('sess-ack', 'do the thing', 'a1');
    await waitFor(() => countOf('channel_sent') === 1);

    // The server takes the item and writes it into the session…
    const body = await channelPost('next', { attachId });
    const [item] = (body.items ?? []) as { injectId: string; text: string }[];
    expect(item?.text).toBe('do the thing');

    // …and before its acknowledgement is processed, the attachment is retired (a sweep, a dead
    // pid, or — as here — the server exiting), which hands the in-flight item back for
    // turn-boundary delivery.
    await channelPost('detach', { attachId });
    await waitFor(() => countOf('channel_fell_back') === 1);

    // Now the confirmation lands. It is still proof the session received the prompt, so the copy
    // waiting on the turn-boundary queue is the same prompt, not a second one.
    await channelPost('ack', { attachId, injectId: item?.injectId, state: 'sent' });

    expect(await stopHook('sess-ack')).toEqual({ ok: true });
  });

  it('is remembered, so a later hand-back of the same prompt is not re-queued', async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-stale-ack');
    const attachId = await attachChannel('sess-stale-ack');
    inject('sess-stale-ack', 'confirmed by a server we forgot', 'sa1');
    await waitFor(() => countOf('channel_sent') === 1);
    const body = await channelPost('next', { attachId });
    const [item] = (body.items ?? []) as { injectId: string }[];

    // A confirmation naming an attachment the daemon no longer knows — what a channel server's
    // late ack looks like on the wire after its attachment has been swept or replaced. The
    // registry cannot match it, but the prompt WAS delivered, and the daemon is the only thing
    // that can remember that.
    await channelPost('ack', {
      attachId: 'an-attachment-this-daemon-has-forgotten',
      injectId: item?.injectId,
      state: 'sent',
    });

    // The live attachment is then retired with the item still in flight. Falling it back would
    // deliver the operator's instruction a second time at the next turn boundary.
    await channelPost('detach', { attachId });
    expect(await stopHook('sess-stale-ack')).toEqual({ ok: true });
    expect(countOf('channel_fell_back')).toBe(0);
  });

  it('still delivers at the boundary when no confirmation ever arrives', async () => {
    // The guard against the test above passing vacuously: without the ack, the recovered prompt
    // MUST be delivered — at-least-once is the contract, and dropping it would be far worse than
    // delivering it twice.
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-noack');
    const attachId = await attachChannel('sess-noack');
    inject('sess-noack', 'nobody confirmed this', 'n1');
    await waitFor(() => countOf('channel_sent') === 1);
    await channelPost('next', { attachId });
    await channelPost('detach', { attachId });
    await waitFor(() => countOf('channel_fell_back') === 1);

    expect(await stopHook('sess-noack')).toEqual({
      decision: 'block',
      reason: 'nobody confirmed this',
    });
  });

  it("does not let one session's channel retire another session's queued prompt", async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-owner');
    seedTerminalSession('sess-bystander');

    // The owner's prompt is handed back to its turn-boundary queue, keeping its inject id.
    const ownerAttach = await attachChannel('sess-owner');
    inject('sess-owner', 'work the operator is still owed', 'c1');
    await waitFor(() => countOf('channel_sent') === 1);
    const body = await channelPost('next', { attachId: ownerAttach });
    const [item] = (body.items ?? []) as { injectId: string }[];
    await channelPost('detach', { attachId: ownerAttach });
    await waitFor(() => countOf('channel_fell_back') === 1);

    // A DIFFERENT session's channel server now reports that id as sent. Whatever that is — a
    // confused client, a replayed frame — it is not evidence that this prompt reached the owner,
    // and cancelling on it swallows an operator's message with nothing anywhere to say so.
    const bystander = await attachChannel('sess-bystander');
    await channelPost('ack', { attachId: bystander, injectId: item?.injectId, state: 'sent' });

    expect(await stopHook('sess-owner')).toEqual({
      decision: 'block',
      reason: 'work the operator is still owed',
    });
  });

  it('remembers the busiest session rather than the first one it saw', async () => {
    // The memory of confirmed deliveries is bounded, so it has to forget sessions. Forgetting
    // them in the order they were first seen drops the session the operator has been working in
    // all day in favour of sixty-odd they touched once — and each forgotten confirmation is a
    // prompt delivered to a session a second time.
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-busy');
    const attachId = await attachChannel('sess-busy');
    inject('sess-busy', 'confirmed once, still in flight', 'b1');
    await waitFor(() => countOf('channel_sent') === 1);
    const body = await channelPost('next', { attachId });
    const [item] = (body.items ?? []) as { injectId: string }[];

    // The confirmation that only this memory can hold: it names an attachment the registry has
    // already forgotten, so the registry cannot match it to the item still in flight.
    await channelPost('ack', {
      attachId: 'an-attachment-this-daemon-has-forgotten',
      injectId: item?.injectId,
      state: 'sent',
    });

    /** One more session confirming one delivery of its own. */
    const otherSessionConfirms = async (n: number): Promise<void> => {
      const id = await attachChannel(`sess-filler-${n}`);
      await channelPost('ack', { attachId: id, injectId: `filler-inject-${n}`, state: 'sent' });
    };
    // Filled to exactly the bound: one more session and something has to go.
    for (let i = 0; i < DELIVERED_INJECT_SESSIONS - 1; i += 1) await otherSessionConfirms(i);

    // The busy session is used again. Under insertion order that changes nothing and it is still
    // first in line to be dropped; under recency it is now last, which is the whole fix.
    await channelPost('ack', { attachId, injectId: 'another-of-ours', state: 'sent' });
    for (let i = 0; i < 5; i += 1) await otherSessionConfirms(DELIVERED_INJECT_SESSIONS + i);

    // The in-flight prompt is handed back. Its confirmation must still be remembered, or the
    // operator's instruction is delivered a second time at the next turn boundary.
    await channelPost('detach', { attachId });
    expect(await stopHook('sess-busy')).toEqual({ ok: true });
    expect(countOf('channel_fell_back')).toBe(0);
  });
});

describe('unregistering a session', () => {
  it('leaves nothing on any queue for a later registration of the same id', async () => {
    const dbPath = join(stateDir, 'daemon.db');
    await startDaemon(dbPath);
    seedTerminalSession('sess-unreg');
    await attachChannel('sess-unreg');
    inject('sess-unreg', 'guidance from a channel that is about to die', 'u1');
    await waitFor(() => countOf('channel_sent') === 1);

    // `cctl session unregister`. Everything queued for the session dies with the registration —
    // including the copy tagged as living on its channel, which is the same operator text by a
    // faster route.
    await sessionPost('unregister', { sessionId: 'sess-unreg', idempotencyKey: 'u-1' });

    // The daemon is then killed outright, so nothing else gets a chance to tidy up after it.
    await killDaemon();
    await startDaemon(dbPath);

    // The operator registers the same id again — the same terminal, a `cctl session register`
    // minutes later. A row the unregister failed to remove is restored by the start above and
    // handed over at the first turn boundary: stale guidance from a channel that is long gone.
    seedTerminalSession('sess-unreg');
    expect(await stopHook('sess-unreg')).toEqual({ ok: true });
  });

  it('empties the live channel without disconnecting its server', async () => {
    await startDaemon(join(stateDir, 'daemon.db'));
    seedTerminalSession('sess-unreg-live');
    const attachId = await attachChannel('sess-unreg-live');
    inject('sess-unreg-live', 'owed to nobody once the session is forgotten', 'ul1');
    await waitFor(() => countOf('channel_sent') === 1);

    await sessionPost('unregister', { sessionId: 'sess-unreg-live', idempotencyKey: 'ul-1' });

    // The attachment survives on purpose: unregistering is cctl's own bookkeeping and says
    // nothing about the Claude Code process, whose channel has to keep working the moment the
    // operator registers it again. What must NOT survive is the work.
    await sessionPost('register', { sessionId: 'sess-unreg-live', idempotencyKey: 'ul-2' });
    inject('sess-unreg-live', 'sent after the re-register', 'ul2');
    await waitFor(() => countOf('channel_sent') === 2);
    expect(await pollChannel(attachId)).toEqual(['sent after the re-register']);
  });
});

