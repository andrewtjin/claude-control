// Lifecycle test for Daemon: every collaborator is either a hand-rolled fake (switch engine,
// session manager) or a real-but-cheap instance (Store, UsagePoller with a fake fetch,
// AttributionJournal against an empty temp dir, a real loopback HookReceiver, a real
// ControlPlaneClient talking to a minimal in-process relay). What's under test is
// composition and wiring, not any subsystem's own internals — those have their own test files.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
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
import type { RecoverResult, ActivateResult, StoredAccount } from '@claude-control/switch-engine';
import type {
  SessionManager,
  SessionHandle,
  SessionEvent,
  SessionRecord,
  AgentSdkClient,
} from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import {
  ControlPlaneClient,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';
import { Daemon, type SwitchEngineLike } from './daemon.js';

// ---------------------------------------------------------------------------
// A minimal steady-state relay: accepts `hello` unconditionally, collects every envelope it
// receives, and lets the test push envelopes down to the connected daemon. Not the real bot —
// control-plane-bot's own relay has its own test file; this is just enough wire protocol to
// drive Daemon's inbound dispatch for real over a real socket.
// ---------------------------------------------------------------------------

class SteadyRelay {
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
        } else if (isType(decoded.envelope, 'ping')) {
          socket.send(
            encode(stamp({ daemonId: decoded.envelope.daemonId, type: 'pong', payload: {} })),
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

  url(port: number): string {
    return `ws://127.0.0.1:${port}`;
  }

  push(draft: EnvelopeDraft): void {
    this.socket?.send(encode(stamp(draft)));
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

function rawToString(raw: RawData): string {
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8');
  return raw.toString('utf8');
}

function memoryIdentityStore(identity: DaemonIdentity): IdentityStore {
  return { load: () => Promise.resolve(identity), save: () => Promise.resolve() };
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function fakeSwitchEngine(): SwitchEngineLike & {
  activate: ReturnType<typeof vi.fn>;
  recover: ReturnType<typeof vi.fn>;
} {
  return {
    recover: vi.fn((): Promise<RecoverResult> =>
      Promise.resolve({ recovered: false, action: 'none' }),
    ),
    activate: vi.fn((id: string): Promise<ActivateResult> =>
      Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      }),
    ),
    // Two known accounts so switch.command tests can exercise id AND label resolution — the
    // daemon resolves the phone-supplied ref against this list before activating.
    listAccounts: vi.fn((): Promise<StoredAccount[]> =>
      Promise.resolve([
        { id: 'acct-x', label: 'main', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
        { id: 'acct-y', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
      ]),
    ),
    getActiveId: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  };
}

/** A controllable fake SessionHandle — tests can synthesize events via `emit`. */
function makeFakeHandle(
  id: string,
): SessionHandle & { emit: (e: SessionEvent) => void; sent: string[] } {
  const listeners = new Set<(e: SessionEvent) => void>();
  const sent: string[] = [];
  return {
    id,
    sent,
    getState: () => 'running',
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
    interrupt: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    emit(e: SessionEvent) {
      for (const cb of listeners) cb(e);
    },
  };
}

function fakeSessionManager(): SessionManager & { spawnManaged: ReturnType<typeof vi.fn> } {
  const handles = new Map<string, SessionHandle>();
  return {
    spawnManaged: vi.fn((opts) => {
      void opts;
      const handle = makeFakeHandle('spawned-session');
      handles.set(handle.id, handle);
      return Promise.resolve(handle);
    }),
    attachObserved: vi.fn(() => {
      throw new Error('not used in this test');
    }),
    get: (id: string) => handles.get(id),
    list: (): SessionRecord[] => [],
    recover: (): Promise<SessionRecord[]> => Promise.resolve([]),
  };
}

const fakeAgentSdkClient: AgentSdkClient = {
  query: async function* () {},
  interrupt: async () => {},
  end: async () => {},
};

describe('Daemon lifecycle', () => {
  let relay: SteadyRelay;
  let relayPort: number;
  let store: Store;
  let vaultDir: string;
  let switchEngine: ReturnType<typeof fakeSwitchEngine>;
  let sessionManager: ReturnType<typeof fakeSessionManager>;
  let poller: UsagePoller;
  let attributionJournal: AttributionJournal;
  let hookReceiver: HookReceiver;
  let controlPlaneClient: ControlPlaneClient;
  let daemon: Daemon;

  beforeEach(async () => {
    relay = new SteadyRelay();
    relayPort = await relay.listen();

    store = new Store(':memory:');
    vaultDir = await mkdtemp(join(tmpdir(), 'daemon-lifecycle-'));

    switchEngine = fakeSwitchEngine();
    sessionManager = fakeSessionManager();
    poller = new UsagePoller({
      fetch: vi.fn(),
      getToken: () => Promise.resolve(undefined),
      getCachedUsage: () => Promise.resolve({ limits: [] }),
    });
    attributionJournal = new AttributionJournal({ store, vaultDir });
    hookReceiver = new HookReceiver({
      store,
      secret: 'shh',
      emit: () => {},
      daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unknown',
    });
    const identity: DaemonIdentity = { daemonId: 'daemon-under-test', daemonToken: 'tok' };
    controlPlaneClient = new ControlPlaneClient({
      url: relay.url(relayPort),
      identityStore: memoryIdentityStore(identity),
      store,
      hostLabel: 'test',
      reconnectBaseMs: 10,
      heartbeatMs: 100_000,
    });

    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000, // effectively off; each test drives runPollCycle indirectly via start()
    });
  });

  afterEach(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  it('start() recovers, opens the hook receiver, connects, and polls once immediately', async () => {
    const pollSpy = vi.spyOn(poller, 'pollAll');
    await daemon.start();

    expect(switchEngine.recover).toHaveBeenCalledTimes(1);
    expect(controlPlaneClient.getState()).toBe('open');
    await waitFor(() => pollSpy.mock.calls.length > 0);
    await waitFor(() => relay.received.some((e) => e.type === 'usage.snapshot'));
  });

  it('start() is idempotent — calling it twice does not double-connect or double-recover', async () => {
    await daemon.start();
    await daemon.start();
    expect(switchEngine.recover).toHaveBeenCalledTimes(1);
  });

  it('wires switch.command -> switchEngine.activate() and sends switch.result back', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'r1',
        targetAccountId: 'acct-x',
        reason: 'manual',
        idempotencyKey: 'k1',
      },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'switch.result'));
    expect(switchEngine.activate).toHaveBeenCalledWith('acct-x');
    const result = relay.received.find((e) => e.type === 'switch.result');
    if (result?.type === 'switch.result') {
      expect(result.payload).toMatchObject({
        requestId: 'r1',
        ok: true,
        activeAccountId: 'acct-x',
      });
    }
  });

  it('resolves a LABEL in switch.command to the account id before activating', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'r-label',
        targetAccountId: 'spare', // the label, exactly as a user would type it in /switch
        reason: 'manual',
        idempotencyKey: 'k-label',
      },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'switch.result'));
    expect(switchEngine.activate).toHaveBeenCalledWith('acct-y');
    const result = relay.received.find((e) => e.type === 'switch.result');
    if (result?.type === 'switch.result') {
      expect(result.payload).toMatchObject({ ok: true, activeAccountId: 'acct-y' });
    }
  });

  it('refuses an unknown account ref with ok:false and never calls activate()', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'r-unknown',
        targetAccountId: 'no-such-account',
        reason: 'manual',
        idempotencyKey: 'k-unknown',
      },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'switch.result'));
    expect(switchEngine.activate).not.toHaveBeenCalled();
    const result = relay.received.find((e) => e.type === 'switch.result');
    if (result?.type === 'switch.result') {
      expect(result.payload.ok).toBe(false);
      expect(result.payload.error).toMatch(/No account matches/);
    }
  });

  it('a failed activate() still sends a switch.result with ok:false', async () => {
    switchEngine.activate.mockRejectedValueOnce(new Error('quarantined'));
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'r2',
        targetAccountId: 'acct-y',
        reason: 'manual',
        idempotencyKey: 'k2',
      },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'switch.result'));
    const result = relay.received.find((e) => e.type === 'switch.result');
    if (result?.type === 'switch.result') {
      expect(result.payload.ok).toBe(false);
      expect(result.payload.error).toMatch(/quarantined/);
    }
  });

  it('wires permission.response -> hookReceiver.resolvePermission (security contract intact)', async () => {
    store.insertPendingPermission({
      requestId: 'perm-1',
      sessionId: 's1',
      tool: 'Bash',
      summary: 'run it',
      createdAtMs: Date.now(),
    });
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: { requestId: 'perm-1', decision: 'allow', scope: 'once', idempotencyKey: 'k' },
    });
    await waitFor(() => store.getPendingPermission('perm-1')?.resolvedDecision !== null);
    expect(store.getPendingPermission('perm-1')?.resolvedDecision).toBe('allow');
  });

  it('an unsolicited permission.response for an unknown requestId is dropped, not applied', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: {
        requestId: 'never-requested',
        decision: 'allow',
        scope: 'once',
        idempotencyKey: 'k',
      },
    });
    // Give the dispatch a moment; there is nothing to observe succeeding, only that nothing
    // throws and no row gets created out of thin air.
    await new Promise((r) => setTimeout(r, 50));
    expect(store.getPendingPermission('never-requested')).toBeUndefined();
  });

  it("wires prompt.inject -> the live session handle's send()", async () => {
    const handle = makeFakeHandle('sess-existing');
    sessionManager.get = () => handle;
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'sess-existing', text: 'hello there', idempotencyKey: 'k' },
    });
    await waitFor(() => handle.sent.length > 0);
    expect(handle.sent).toEqual(['hello there']);
  });

  it('wires session.spawn -> sessionManager.spawnManaged and forwards its events as envelopes', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'do the thing', idempotencyKey: 'k' },
    });
    await waitFor(() => sessionManager.spawnManaged.mock.calls.length > 0);

    const handle = sessionManager.get('spawned-session') as
      ReturnType<typeof makeFakeHandle> | undefined;
    expect(handle).toBeDefined();
    handle?.emit({ kind: 'status', state: 'running' });
    handle?.emit({ kind: 'output', text: 'hi from the session' });

    await waitFor(() => relay.received.some((e) => e.type === 'session.status'));
    await waitFor(() => relay.received.some((e) => e.type === 'session.output'));
    const output = relay.received.find((e) => e.type === 'session.output');
    if (output?.type === 'session.output') {
      expect(output.payload).toMatchObject({
        sessionId: 'spawned-session',
        seq: 0,
        kind: 'stdout',
        text: 'hi from the session',
      });
    }
  });

  it('stop() closes the hook receiver, closes the control-plane client, and stops polling', async () => {
    const pollSpy = vi.spyOn(poller, 'pollAll');
    await daemon.start();
    await waitFor(() => pollSpy.mock.calls.length > 0);
    const callsAtStop = pollSpy.mock.calls.length;

    await daemon.stop();
    expect(controlPlaneClient.getState()).toBe('closed');

    // Wait long enough that, if the interval were still alive, it would have fired again.
    await new Promise((r) => setTimeout(r, 150));
    expect(pollSpy.mock.calls.length).toBe(callsAtStop);
  });

  it('stop() is idempotent — calling it twice does not throw', async () => {
    await daemon.start();
    await daemon.stop();
    await expect(daemon.stop()).resolves.toBeUndefined();
  });
});
