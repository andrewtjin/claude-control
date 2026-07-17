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
import type { AccountUsageInput } from '@claude-control/usage-advisor';
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
import {
  Daemon,
  reconcileQuarantineNotices,
  type SwitchEngineLike,
  type QuarantineNoticeState,
} from './daemon.js';

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
  listAccounts: ReturnType<typeof vi.fn>;
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

  it('installs hooks on startup with the receiver’s actual bound port', async () => {
    let installedPort: number | undefined;
    const installHooks = vi.fn((port: number) => {
      installedPort = port;
      return Promise.resolve();
    });
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      installHooks,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000,
    });
    await daemon.start();

    expect(installHooks).toHaveBeenCalledTimes(1);
    // The port is OS-assigned (listen(0)); we can't predict it, but it must be a real bound port.
    expect(typeof installedPort).toBe('number');
    expect(installedPort).toBeGreaterThan(0);
  });

  it('a failing hook self-heal is swallowed — the daemon still comes up and polls', async () => {
    const installHooks = vi.fn(() => Promise.reject(new Error('EACCES: settings.json read-only')));
    const pollSpy = vi.spyOn(poller, 'pollAll');
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      installHooks,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000,
    });

    // start() must resolve despite the installer throwing.
    await expect(daemon.start()).resolves.toBeUndefined();
    expect(installHooks).toHaveBeenCalledTimes(1);
    expect(controlPlaneClient.getState()).toBe('open');
    await waitFor(() => pollSpy.mock.calls.length > 0);
  });

  it('does NOT push a quarantine notice for an account already quarantined at first poll', async () => {
    // First sight of a quarantined account is recorded silently (restart-storm guard) — the
    // standing state rides on the usage snapshot, not a fresh push. NOTE: we key off the poll
    // spy, not usage.snapshot: a snapshot containing a quarantined account currently fails
    // envelope decode at the relay (advisor scores unusable accounts -Infinity → JSON null →
    // fails AccountScore.score; see the daemon agent's report), so it never arrives — but the
    // quarantine hook.notification (a separate envelope) would, if one were emitted.
    switchEngine.listAccounts.mockResolvedValue([
      { id: 'acct-q', label: 'dead', quarantined: true, createdAtMs: 0, updatedAtMs: 0 },
    ]);
    const pollSpy = vi.spyOn(poller, 'pollAll');
    await daemon.start();
    await waitFor(() => pollSpy.mock.calls.length > 0);
    // Let any envelope the cycle would emit make it across the real socket before asserting.
    await new Promise((r) => setTimeout(r, 60));
    const quarantineCards = relay.received.filter(
      (e) => e.type === 'hook.notification' && e.payload.notificationType === 'quarantine',
    );
    expect(quarantineCards).toHaveLength(0);
  });

  it('pushes exactly one quarantine notice when an account transitions into quarantine', async () => {
    // Cycle 1 (immediate): healthy → records baseline. Cycle 2+ (interval): quarantined →
    // false→true transition fires the quarantine card (a hook.notification, which decodes fine
    // even though that cycle's usage.snapshot does not — see the note in the test above).
    switchEngine.listAccounts
      .mockResolvedValueOnce([
        { id: 'acct-q', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
      ])
      .mockResolvedValue([
        { id: 'acct-q', label: 'spare', quarantined: true, createdAtMs: 0, updatedAtMs: 0 },
      ]);
    // Rebuild with a short poll interval so the second cycle actually runs (real timers, not
    // fake — house convention). A huge debounce guarantees the transition fires at most once
    // across the several interval cycles this test spans.
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 30,
      quarantineNoticeDebounceMs: 10 * 60_000,
    });
    await daemon.start();

    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'quarantine',
      ),
    );
    // Give a few more interval cycles a chance to (wrongly) double-fire; debounce must hold.
    await new Promise((r) => setTimeout(r, 120));
    const cards = relay.received.filter(
      (e) => e.type === 'hook.notification' && e.payload.notificationType === 'quarantine',
    );
    expect(cards).toHaveLength(1);
    const card = cards[0];
    if (card?.type === 'hook.notification') {
      expect(card.payload.level).toBe('warn');
      expect(card.payload.title).toContain('spare'); // label in the title
      expect(card.payload.body).toContain('acct-q'); // account id (human-readable ref) in the body
    }
  });

  it("feeds each poll cycle's advisor inputs to the auto-switcher when one is wired", async () => {
    const evaluate = vi.fn((accounts: AccountUsageInput[]) => {
      void accounts;
      return Promise.resolve();
    });
    // Rebuild with the optional collaborator present — afterEach stops whatever `daemon`
    // points to, so reassigning keeps cleanup intact.
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      autoSwitcher: { evaluate },
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000,
    });
    await daemon.start();

    await waitFor(() => evaluate.mock.calls.length > 0);
    const inputs = evaluate.mock.calls[0]?.[0];
    // One advisor input per account the fake engine reports, in poll order.
    expect(inputs?.map((i) => i.accountId)).toEqual(['acct-x', 'acct-y']);
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

// The edge-detection + debounce logic is pure, so it is proven here directly rather than by
// orchestrating live poll cycles (the daemon lifecycle tests above cover the wiring).
describe('reconcileQuarantineNotices', () => {
  const acct = (accountId: string, quarantined: boolean, label = accountId) => ({
    accountId,
    label,
    quarantined,
  });
  const DEBOUNCE = 60_000;

  it('records a first-sight account silently (no notice), whether healthy or already quarantined', () => {
    const empty = new Map<string, QuarantineNoticeState>();
    const { notices, nextState } = reconcileQuarantineNotices(
      [acct('a', false), acct('b', true)],
      empty,
      1000,
      DEBOUNCE,
    );
    expect(notices).toEqual([]);
    expect(nextState.get('a')).toEqual({ quarantined: false, lastNoticeAtMs: 0 });
    expect(nextState.get('b')).toEqual({ quarantined: true, lastNoticeAtMs: 0 });
  });

  it('fires a notice on a healthy→quarantined transition observed across two cycles', () => {
    const s1 = reconcileQuarantineNotices([acct('a', false)], new Map(), 1000, DEBOUNCE).nextState;
    const { notices, nextState } = reconcileQuarantineNotices(
      [acct('a', true, 'spare')],
      s1,
      2000,
      DEBOUNCE,
    );
    expect(notices).toEqual([{ accountId: 'a', label: 'spare' }]);
    expect(nextState.get('a')).toEqual({ quarantined: true, lastNoticeAtMs: 2000 });
  });

  it('does not re-fire while the account stays quarantined across subsequent cycles', () => {
    let state = reconcileQuarantineNotices([acct('a', false)], new Map(), 0, DEBOUNCE).nextState;
    state = reconcileQuarantineNotices([acct('a', true)], state, 1000, DEBOUNCE).nextState; // fires
    const third = reconcileQuarantineNotices([acct('a', true)], state, 2000, DEBOUNCE); // still quarantined
    expect(third.notices).toEqual([]);
  });

  it('debounces a flap: quarantine → clear → quarantine within the window fires only once', () => {
    let state = reconcileQuarantineNotices([acct('a', false)], new Map(), 0, DEBOUNCE).nextState;
    // First transition at t=1000 → fires.
    const first = reconcileQuarantineNotices([acct('a', true)], state, 1000, DEBOUNCE);
    expect(first.notices).toHaveLength(1);
    state = first.nextState;
    // Clears at t=1500.
    state = reconcileQuarantineNotices([acct('a', false)], state, 1500, DEBOUNCE).nextState;
    // Re-quarantines at t=2000, still inside the 60s debounce of the t=1000 notice → suppressed.
    const second = reconcileQuarantineNotices([acct('a', true)], state, 2000, DEBOUNCE);
    expect(second.notices).toEqual([]);
  });

  it('re-fires once the debounce window has fully elapsed', () => {
    let state = reconcileQuarantineNotices([acct('a', false)], new Map(), 0, DEBOUNCE).nextState;
    state = reconcileQuarantineNotices([acct('a', true)], state, 1000, DEBOUNCE).nextState; // fires @1000
    state = reconcileQuarantineNotices([acct('a', false)], state, 2000, DEBOUNCE).nextState; // clears
    // Re-quarantine at t = 1000 + DEBOUNCE (exactly the window boundary) → fires again.
    const again = reconcileQuarantineNotices([acct('a', true)], state, 1000 + DEBOUNCE, DEBOUNCE);
    expect(again.notices).toEqual([{ accountId: 'a', label: 'a' }]);
  });

  it('does not mutate the passed-in previous-state map', () => {
    const prev = new Map<string, QuarantineNoticeState>();
    reconcileQuarantineNotices([acct('a', false)], prev, 0, DEBOUNCE);
    expect(prev.size).toBe(0);
  });
});
