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
import type {
  RecoverResult,
  ActivateResult,
  StoredAccount,
  Logger,
} from '@claude-control/switch-engine';
import type { AccountUsageInput } from '@claude-control/usage-advisor';
import type {
  SessionManager,
  SessionHandle,
  SessionEvent,
  SessionRecord,
  SessionState,
  AgentSdkClient,
  PermissionDecision,
  PermissionRequest,
  ResumeOrphanOptions,
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

  /** Returns the stamped envelope so tests can correlate on its `id` (e.g. error.relatesTo). */
  push(draft: EnvelopeDraft): Envelope {
    const envelope = stamp(draft);
    this.socket?.send(encode(envelope));
    return envelope;
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
  getActiveId: ReturnType<typeof vi.fn>;
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

/** What the upgraded fake handle exposes on top of SessionHandle: event/permission
 *  synthesizers plus observability for everything the daemon may do to a session. */
interface FakeHandle extends SessionHandle {
  emit: (e: SessionEvent) => void;
  /** Synthesize a structured SDK permission request (the managed-session seam). */
  emitPermission: (req: PermissionRequest) => void;
  sent: string[];
  /** Decisions the daemon routed into resolvePermission, in arrival order. */
  resolved: Array<{ requestId: string; decision: PermissionDecision }>;
  interruptCalls: number;
  stopCalls: number;
}

/** A controllable fake SessionHandle — tests can synthesize display events via `emit` and
 *  structured permission requests via `emitPermission`, and observe what the daemon did
 *  (sent prompts, interrupt/stop calls, resolved decisions). By default `interrupt()` moves
 *  the fake to 'waiting_input' so escalateStop's grace wait settles instantly; pass
 *  `settleOnInterrupt: false` to pin it 'running' and force the hard-stop rung. `stop()`
 *  goes terminal and emits the status event, mirroring the real handle's ack surface. */
function makeFakeHandle(id: string, settleOnInterrupt = true): FakeHandle {
  const listeners = new Set<(e: SessionEvent) => void>();
  const permissionListeners = new Set<(req: PermissionRequest) => void>();
  const sent: string[] = [];
  // Single-resolve bookkeeping mirroring the real permission gate: first decision wins,
  // repeats are 'already_handled', ids never requested are 'unknown'.
  const knownIds = new Set<string>();
  const settledIds = new Set<string>();
  let state: SessionState = 'running';
  const emit = (e: SessionEvent): void => {
    for (const cb of listeners) cb(e);
  };
  const handle: FakeHandle = {
    id,
    sent,
    resolved: [],
    interruptCalls: 0,
    stopCalls: 0,
    getState: () => state,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send: (text: string) => {
      sent.push(text);
      return Promise.resolve();
    },
    interrupt: () => {
      handle.interruptCalls += 1;
      if (settleOnInterrupt) state = 'waiting_input';
      return Promise.resolve();
    },
    stop: () => {
      handle.stopCalls += 1;
      state = 'done';
      emit({ kind: 'status', state: 'done' });
      return Promise.resolve();
    },
    onPermissionRequest(cb) {
      permissionListeners.add(cb);
      return () => permissionListeners.delete(cb);
    },
    resolvePermission(requestId, decision) {
      if (!knownIds.has(requestId)) return 'unknown';
      if (settledIds.has(requestId)) return 'already_handled';
      settledIds.add(requestId);
      handle.resolved.push({ requestId, decision });
      return 'resolved';
    },
    emit,
    emitPermission(req: PermissionRequest) {
      knownIds.add(req.requestId);
      for (const cb of permissionListeners) cb(req);
    },
  };
  return handle;
}

function fakeSessionManager(): SessionManager & {
  spawnManaged: ReturnType<typeof vi.fn>;
  /** Exposed so resume tests can pre-register handles the daemon should find via get(). */
  handles: Map<string, SessionHandle>;
  /** Backing array for list() — tests seed persisted-looking records here. */
  records: SessionRecord[];
  /** Every resumeOrphan call, observable with real types (no mock-generics needed). */
  resumeOrphanCalls: Array<{ sessionId: string; opts: ResumeOrphanOptions }>;
  /** One entry per prune() call: the batch of ids it removed. */
  pruneCalls: string[][];
} {
  const handles = new Map<string, SessionHandle>();
  const records: SessionRecord[] = [];
  const resumeOrphanCalls: Array<{ sessionId: string; opts: ResumeOrphanOptions }> = [];
  const pruneCalls: string[][] = [];
  return {
    handles,
    records,
    resumeOrphanCalls,
    pruneCalls,
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
    list: (): SessionRecord[] => records,
    recover: (): Promise<SessionRecord[]> => Promise.resolve([]),
    resumeOrphan: (sessionId, opts) => {
      resumeOrphanCalls.push({ sessionId, opts });
      // Mirror the real manager: the resumed handle comes live under the SAME id.
      const handle = makeFakeHandle(sessionId);
      handles.set(sessionId, handle);
      return Promise.resolve(handle);
    },
    prune: (): Promise<SessionRecord[]> => {
      // Mirror the real manager's dormancy rule: terminal-state records go, and so does any
      // non-terminal record with no live handle; only handle-backed live work stays.
      const pruned = records.filter(
        (r) =>
          r.state === 'done' ||
          r.state === 'failed' ||
          r.state === 'orphaned' ||
          !handles.has(r.id),
      );
      for (const record of pruned) {
        records.splice(records.indexOf(record), 1);
        handles.delete(record.id);
      }
      pruneCalls.push(pruned.map((r) => r.id));
      return Promise.resolve(pruned);
    },
  };
}

const fakeAgentSdkClient: AgentSdkClient = {
  query: async function* () {},
  interrupt: async () => {},
  end: async () => {},
};

/** Capture log lines so tests can assert on values the daemon only reports via the logger
 *  (e.g. the stop-escalation rung) — house convention keeps such policy observable without
 *  widening the daemon's public surface just for tests. */
function capturingLogger(): {
  logger: Logger;
  entries: Array<{ level: string; obj: unknown; msg: string | undefined }>;
} {
  const entries: Array<{ level: string; obj: unknown; msg: string | undefined }> = [];
  const log =
    (level: string) =>
    (obj: unknown, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return {
    logger: { debug: log('debug'), info: log('info'), warn: log('warn'), error: log('error') },
    entries,
  };
}

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

  it('re-pushes the effective-settings report with every poll cycle when one is wired', async () => {
    const settingsReport = {
      startedAtMs: 1_700_000_000_000,
      settings: [{ name: 'auto-switch', value: 'on', source: 'flag' as const }],
    };
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      settingsReport,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000,
    });
    await daemon.start();

    await waitFor(() => relay.received.some((e) => e.type === 'settings.snapshot'));
    const pushed = relay.received.find((e) => e.type === 'settings.snapshot');
    expect(pushed?.payload).toEqual(settingsReport);
  });

  it('does not push settings.snapshot when no report was provided', async () => {
    await daemon.start();
    // The usage snapshot proves a full poll cycle ran — by then settings would have shipped.
    await waitFor(() => relay.received.some((e) => e.type === 'usage.snapshot'));
    expect(relay.received.some((e) => e.type === 'settings.snapshot')).toBe(false);
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
      origin: 'hook',
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

  it('stamps a stable per-run epoch on every session.output envelope', async () => {
    // The epoch lets the bot tell a restart-induced seq reset (re-numbered from 0) apart from real
    // output loss. It must be present and CONSTANT within a single daemon run.
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r1', prompt: 'do the thing', idempotencyKey: 'k' },
    });
    await waitFor(() => sessionManager.spawnManaged.mock.calls.length > 0);
    const handle = sessionManager.get('spawned-session') as
      ReturnType<typeof makeFakeHandle> | undefined;
    handle?.emit({ kind: 'output', text: 'one' });
    handle?.emit({ kind: 'output', text: 'two' });

    await waitFor(() => relay.received.filter((e) => e.type === 'session.output').length >= 2);
    const epochs = relay.received
      .filter((e) => e.type === 'session.output')
      .map((e) => (e.type === 'session.output' ? e.payload.epoch : undefined));
    expect(epochs[0]).toBeTruthy(); // a non-empty per-run token is present
    expect(epochs[0]).toBe(epochs[1]); // and stable within the run (no spurious mid-session reset)
  });

  // ---- managed-session permission pipeline ----

  /** Drive a session.spawn through the live relay and hand back the fake handle it created. */
  async function spawnFakeSession(): Promise<FakeHandle> {
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'r-spawn', prompt: 'do the thing', idempotencyKey: 'k-spawn' },
    });
    await waitFor(() => sessionManager.spawnManaged.mock.calls.length > 0);
    const handle = sessionManager.get('spawned-session');
    if (!handle) throw new Error('spawn did not register a handle');
    return handle as FakeHandle;
  }

  it("spawns managed sessions in 'default' permission mode and forwards SDK permission requests", async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    // The mode is daemon policy (session.spawn has no mode field in v1) and 'default' is the
    // only mode in which remote approve/deny works — see MANAGED_SESSION_PERMISSION_MODE.
    expect(sessionManager.spawnManaged).toHaveBeenCalledWith(
      expect.objectContaining({ permissionMode: 'default' }),
    );

    handle.emitPermission({
      requestId: 'sdk-req-1',
      tool: 'Bash',
      summary: 'run ls',
      permissionMode: 'default',
    });
    await waitFor(() => relay.received.some((e) => e.type === 'permission.request'));
    const request = relay.received.find((e) => e.type === 'permission.request');
    if (request?.type === 'permission.request') {
      expect(request.payload).toMatchObject({
        requestId: 'sdk-req-1',
        sessionId: 'spawned-session',
        tool: 'Bash',
        summary: 'run ls',
        permissionMode: 'default',
      });
      // No TTL on an SDK-parked prompt — the design bans timeout-based decisions.
      expect(request.payload.expiresAt ?? undefined).toBeUndefined();
    }
    // Same bookkeeping as a hook-originated request: a pending_permissions row exists.
    expect(store.getPendingPermission('sdk-req-1')).toMatchObject({
      sessionId: 'spawned-session',
      tool: 'Bash',
      resolvedDecision: null,
    });
  });

  it('routes permission.response for an SDK-originated request into the session handle', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    handle.emitPermission({ requestId: 'sdk-req-2', tool: 'Write', summary: 'write file' });
    await waitFor(() => store.getPendingPermission('sdk-req-2') !== undefined);

    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: { requestId: 'sdk-req-2', decision: 'allow', scope: 'once', idempotencyKey: 'ka' },
    });
    await waitFor(() => handle.resolved.length > 0);
    expect(handle.resolved[0]).toMatchObject({
      requestId: 'sdk-req-2',
      decision: { behavior: 'allow' },
    });
    // The audit row mirrors the decision the handle actually applied.
    await waitFor(() => store.getPendingPermission('sdk-req-2')?.resolvedDecision === 'allow');
  });

  it('a repeated permission.response for a managed request is applied exactly once', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    handle.emitPermission({ requestId: 'sdk-req-3', tool: 'Bash', summary: 'rm -rf things' });
    await waitFor(() => store.getPendingPermission('sdk-req-3') !== undefined);

    const payload = { requestId: 'sdk-req-3', decision: 'deny', scope: 'once' } as const;
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: { ...payload, idempotencyKey: 'k-first' },
    });
    await waitFor(() => handle.resolved.length > 0);
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: { ...payload, idempotencyKey: 'k-second' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(handle.resolved).toHaveLength(1); // the double-tap is 'already_handled', never re-applied
    // A deny reaches the handle with an explicit reason (the SDK requires one on deny).
    expect(handle.resolved[0]?.decision.behavior).toBe('deny');
    expect(handle.resolved[0]?.decision.message).toContain('remote');
  });

  it('a re-delivered SDK permission request produces exactly one card and one row', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    const req: PermissionRequest = { requestId: 'sdk-req-4', tool: 'Bash', summary: 'again' };
    handle.emitPermission(req);
    handle.emitPermission(req); // the SDK may re-deliver a control_request for a pending id
    await waitFor(() => relay.received.some((e) => e.type === 'permission.request'));
    await new Promise((r) => setTimeout(r, 60));
    expect(relay.received.filter((e) => e.type === 'permission.request')).toHaveLength(1);
  });

  it('sweeps managed routes at session end: rows fail closed and a late response is rejected', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    handle.emitPermission({ requestId: 'sdk-req-5', tool: 'Bash', summary: 'pending at death' });
    await waitFor(() => store.getPendingPermission('sdk-req-5') !== undefined);

    handle.emit({ kind: 'status', state: 'done' }); // session ends with the request pending
    // The audit row mirrors the runtime's fail-closed teardown (the gate denies on turn end).
    expect(store.getPendingPermission('sdk-req-5')?.resolvedDecision).toBe('deny');

    // A LATE response falls through to the hook path, whose already-resolved DB guard rejects
    // it — it must never reach the handle or flip the recorded deny to an allow.
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'permission.response',
      payload: { requestId: 'sdk-req-5', decision: 'allow', scope: 'once', idempotencyKey: 'kl' },
    });
    await new Promise((r) => setTimeout(r, 60));
    expect(handle.resolved).toHaveLength(0);
    expect(store.getPendingPermission('sdk-req-5')?.resolvedDecision).toBe('deny');
  });

  // ---- session.stop ----

  it('wires session.stop -> interrupt-then-stop, acked via the forwarded session.status', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'spawned-session', idempotencyKey: 'stop-1' },
    });
    await waitFor(() => handle.stopCalls > 0);
    expect(handle.interruptCalls).toBe(1);
    // There is deliberately no stop.result — the ack IS the session.status 'done' transition.
    await waitFor(() =>
      relay.received.some((e) => e.type === 'session.status' && e.payload.state === 'done'),
    );
  });

  it('a repeated session.stop idempotencyKey never double-escalates', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    const stop = {
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'spawned-session', idempotencyKey: 'stop-dup' },
    } as const;
    relay.push(stop);
    await waitFor(() => handle.stopCalls > 0);
    relay.push(stop); // the double-tap / redelivery
    await new Promise((r) => setTimeout(r, 60));
    expect(handle.interruptCalls).toBe(1);
    expect(handle.stopCalls).toBe(1);
  });

  it('hard-stops a session that does not settle within the grace window (rung logged)', async () => {
    const { logger, entries } = capturingLogger();
    const stuck = makeFakeHandle('stuck-session', false); // interrupt() leaves it 'running'
    sessionManager.handles.set('stuck-session', stuck);
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      pollIntervalMs: 100_000,
      stopGraceMs: 25, // short REAL grace window — house convention forbids fake timers
      logger,
    });
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'stuck-session', idempotencyKey: 'stop-hard' },
    });
    await waitFor(() => stuck.stopCalls > 0);
    expect(stuck.interruptCalls).toBe(1);
    await waitFor(() => entries.some((e) => e.msg === 'session.stop escalation finished'));
    const finished = entries.find((e) => e.msg === 'session.stop escalation finished');
    expect((finished?.obj as { rung?: string }).rung).toBe('hard_stopped');
  });

  it('session.stop for an unknown session emits an error envelope correlated via relatesTo', async () => {
    await daemon.start();
    const pushed = relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'ghost', idempotencyKey: 'stop-ghost' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const err = relay.received.find((e) => e.type === 'error');
    if (err?.type === 'error') {
      expect(err.payload.code).toBe('unknown_session');
      expect(err.payload.relatesTo).toBe(pushed.id); // correlates to the stop frame itself
      expect(err.payload.message).toContain('ghost');
    }
  });

  it('a stop that races a not-yet-live session does not burn the key — a later stop still works', async () => {
    await daemon.start();
    // First stop targets a session that is not live yet (e.g. a spawn still in flight): it errors,
    // and must NOT remember the idempotencyKey (otherwise the card's stable key is un-stoppable).
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'late-session', idempotencyKey: 'stop-race' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'error'));

    // The session becomes live (a resume/spawn landed after the stop).
    const handle = makeFakeHandle('late-session');
    sessionManager.handles.set('late-session', handle);

    // The SAME idempotencyKey now stops it successfully — the key was not burned by the race.
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId: 'late-session', idempotencyKey: 'stop-race' },
    });
    await waitFor(() => handle.stopCalls > 0);
    expect(handle.interruptCalls).toBe(1);
  });

  // ---- orphan reconciliation + on-demand re-attach ----

  it('startup stamps leftover records orphaned but never resumes them', async () => {
    const orphan: SessionRecord = {
      id: 'orphan-1',
      kind: 'managed',
      state: 'orphaned',
      startedAtMs: 0,
      accountId: 'acct-x',
      resumeId: 'sdk-abc',
    };
    sessionManager.records.push(orphan);
    const recover = vi.fn(() => Promise.resolve([orphan]));
    sessionManager.recover = recover;
    await daemon.start();

    expect(recover).toHaveBeenCalledTimes(1);
    // Reconciliation is bookkeeping only: nothing resumed means nothing can run a turn —
    // an orphan re-attaches solely when an operator prompt addresses it.
    expect(sessionManager.resumeOrphanCalls).toHaveLength(0);
    expect(sessionManager.get('orphan-1')).toBeUndefined();
  });

  it("prompt.inject to an orphan re-attaches it with the operator's text as the resumed turn", async () => {
    sessionManager.records.push({
      id: 'orphan-1',
      kind: 'managed',
      state: 'orphaned',
      startedAtMs: 0,
      accountId: 'acct-x',
      resumeId: 'sdk-abc',
    });
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'orphan-1', text: 'pick the task back up', idempotencyKey: 'k' },
    });
    await waitFor(() => sessionManager.resumeOrphanCalls.length > 0);

    const call = sessionManager.resumeOrphanCalls[0];
    expect(call?.sessionId).toBe('orphan-1');
    // The operator's own text is the resumed turn — never a synthetic prompt.
    expect(call?.opts.prompt).toBe('pick the task back up');
    // Resumed sessions get the same remote-approval mode as fresh spawns, and clients from
    // the daemon's own injected factory.
    expect(call?.opts.permissionMode).toBe('default');
    expect(call?.opts.client).toBe(fakeAgentSdkClient);

    // The re-attached handle is wired exactly like a fresh spawn: status events flow as
    // envelopes with the persisted record's account threaded.
    const handle = sessionManager.get('orphan-1') as ReturnType<typeof makeFakeHandle> | undefined;
    expect(handle).toBeDefined();
    handle?.emit({ kind: 'status', state: 'running' });
    await waitFor(() => relay.received.some((e) => e.type === 'session.status'));
    const status = relay.received.find((e) => e.type === 'session.status');
    if (status?.type === 'session.status') {
      expect(status.payload).toMatchObject({
        sessionId: 'orphan-1',
        state: 'running',
        accountId: 'acct-x',
      });
    }

    // The structured permission pipe is attached on re-attach too, not just on spawn.
    handle?.emitPermission({ requestId: 'resume-req-1', tool: 'Bash', summary: 'continue' });
    await waitFor(() => relay.received.some((e) => e.type === 'permission.request'));
    const request = relay.received.find((e) => e.type === 'permission.request');
    if (request?.type === 'permission.request') {
      expect(request.payload).toMatchObject({ requestId: 'resume-req-1', sessionId: 'orphan-1' });
    }
  });

  it('prompt.inject never resurrects a terminal session — refused with an "already ended" answer', async () => {
    sessionManager.records.push({
      id: 'done-1',
      kind: 'managed',
      state: 'done',
      startedAtMs: 0,
      resumeId: 'sdk-done',
    });
    await daemon.start();
    const frame = relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'done-1', text: 'hello?', idempotencyKey: 'k' },
    });
    // The refusal must be VISIBLE (the bot acks /say optimistically): an error envelope
    // correlated to the inject frame, and no resume.
    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const error = relay.received.find((e) => e.type === 'error');
    if (error?.type === 'error') {
      expect(error.payload.code).toBe('unknown_session');
      expect(error.payload.message).toContain('already ended');
      expect(error.payload.relatesTo).toBe(frame.id);
    }
    expect(sessionManager.resumeOrphanCalls).toHaveLength(0);
    expect(sessionManager.get('done-1')).toBeUndefined();
  });

  it('prompt.inject to a wholly unknown id answers unknown_session, never a silent drop', async () => {
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'ghost-1', text: 'anyone home?', idempotencyKey: 'k' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const error = relay.received.find((e) => e.type === 'error');
    if (error?.type === 'error') {
      expect(error.payload.code).toBe('unknown_session');
      expect(error.payload.message).toContain("no live session 'ghost-1'");
    }
  });

  /** Seed a `cctl session register`ed interactive session row directly (bypassing the CLI
   *  endpoint) — the starting state for every steering test. */
  function seedTerminalSession(id: string, label?: string): void {
    store.upsertSession({
      id,
      kind: 'interactive',
      state: 'active',
      accountId: null,
      json: JSON.stringify({
        id,
        kind: 'interactive',
        state: 'active',
        ...(label !== undefined ? { label } : {}),
        watch: true,
        registeredAtMs: 0,
        updatedAtMs: 0,
      }),
      updatedAtMs: 0,
    });
  }

  /** POST a raw hook event (as the CLI's curl forwarder would) at the receiver. */
  async function postHook(
    hookPort: number,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const res = await fetch(`http://127.0.0.1:${hookPort}/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': 'shh' },
      body: JSON.stringify(body),
    });
    return (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
  }

  it('prompt.inject to a registered terminal session queues and confirms, never errors', async () => {
    seedTerminalSession('terminal-1', 'demo');
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'terminal-1', text: 'steer this', idempotencyKey: 'k' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );
    const card = relay.received.find((e) => e.type === 'hook.notification');
    if (card?.type === 'hook.notification') {
      expect(card.payload.title).toContain('demo');
      expect(card.payload.body).toContain('steer this');
      expect(card.payload.body).toContain('finishes its current turn or you next type in it');
    }
    expect(relay.received.some((e) => e.type === 'error')).toBe(false);
  });

  it('queued steering delivers as the session’s next Stop-hook answer, exactly once', async () => {
    seedTerminalSession('terminal-2');
    const hookPort = await startCapturingHookPort();
    for (const [i, text] of ['fix the flaky test first', 'then push'].entries()) {
      relay.push({
        daemonId: 'daemon-under-test',
        type: 'prompt.inject',
        payload: { sessionId: 'terminal-2', text, idempotencyKey: `steer-${i}` },
      });
    }
    // Both queued-confirmation cards seen -> the queue mutations have landed; Stop can fire.
    await waitFor(
      () =>
        relay.received.filter(
          (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
        ).length === 2,
    );

    const answer = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'terminal-2' });

    // The CLI's documented Stop contract: block + reason = continue the turn with the reason
    // as guidance. Everything queued delivers in one answer, in arrival order.
    expect(answer).toEqual({ decision: 'block', reason: 'fix the flaky test first\n\nthen push' });
    await waitFor(() =>
      relay.received.some(
        (e) =>
          e.type === 'hook.notification' && e.payload.notificationType === 'steering_delivered',
      ),
    );

    // Consumed on delivery: the next Stop is a normal stop again.
    const second = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'terminal-2' });
    expect(second).toEqual({ ok: true });
  });

  it('steering past the TTL is dropped with an expiry card, never delivered', async () => {
    seedTerminalSession('terminal-3');
    let now = 1_000_000;
    let captured: number | undefined;
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      clock: () => now,
      publishHookEndpoint: (port) => {
        captured = port;
        return Promise.resolve();
      },
      pollIntervalMs: 100_000,
    });
    await daemon.start();
    await waitFor(() => captured !== undefined);
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'terminal-3', text: 'stale by now', idempotencyKey: 'ttl-1' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    now += 31 * 60_000; // past the 30-minute steering TTL
    if (captured === undefined) throw new Error('unreachable');
    const answer = await postHook(captured, { hook_event_name: 'Stop', session_id: 'terminal-3' });

    expect(answer).toEqual({ ok: true });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_expired',
      ),
    );
  });

  it('a full steering queue refuses the next /say with an honest error', async () => {
    seedTerminalSession('terminal-4');
    await daemon.start();
    for (let i = 0; i < 8; i++) {
      relay.push({
        daemonId: 'daemon-under-test',
        type: 'prompt.inject',
        payload: { sessionId: 'terminal-4', text: `msg ${i}`, idempotencyKey: `cap-${i}` },
      });
    }
    await waitFor(
      () =>
        relay.received.filter(
          (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
        ).length === 8,
    );

    const overflow = relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'terminal-4', text: 'one too many', idempotencyKey: 'cap-8' },
    });

    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const error = relay.received.find((e) => e.type === 'error');
    if (error?.type === 'error') {
      expect(error.payload.code).toBe('steer_queue_full');
      expect(error.payload.relatesTo).toBe(overflow.id);
    }
  });

  it('unregister discards the session’s queued steering', async () => {
    seedTerminalSession('terminal-5');
    const hookPort = await startCapturingHookPort();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'terminal-5', text: 'soon obsolete', idempotencyKey: 'un-1' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    const res = await postCli(hookPort, 'unregister', {
      sessionId: 'terminal-5',
      idempotencyKey: 'un-2',
    });
    expect(res.body).toMatchObject({ ok: true, status: 'applied' });

    const answer = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'terminal-5' });
    expect(answer).toEqual({ ok: true });
    expect(
      relay.received.some(
        (e) =>
          e.type === 'hook.notification' && e.payload.notificationType === 'steering_delivered',
      ),
    ).toBe(false);
  });

  // ---- UserPromptSubmit: the second steering delivery channel, for a session sitting idle ----

  it('queued steering delivers via UserPromptSubmit, and a subsequent Stop finds nothing left', async () => {
    seedTerminalSession('terminal-upsub-1');
    const hookPort = await startCapturingHookPort();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: {
        sessionId: 'terminal-upsub-1',
        text: 'type-triggered steer',
        idempotencyKey: 'up-1',
      },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    const answer = await postHook(hookPort, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'terminal-upsub-1',
    });
    expect(answer).toEqual({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'type-triggered steer',
      },
    });
    await waitFor(() =>
      relay.received.some(
        (e) =>
          e.type === 'hook.notification' && e.payload.notificationType === 'steering_delivered',
      ),
    );

    // Consumed exactly once: the same Map.delete backs both delivery channels, so the
    // session's next Stop finds an already-empty queue.
    const stopAnswer = await postHook(hookPort, {
      hook_event_name: 'Stop',
      session_id: 'terminal-upsub-1',
    });
    expect(stopAnswer).toEqual({ ok: true });
  });

  it('queued steering delivers via Stop first; a later UserPromptSubmit finds nothing left', async () => {
    seedTerminalSession('terminal-upsub-2');
    const hookPort = await startCapturingHookPort();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'terminal-upsub-2', text: 'stop-delivered', idempotencyKey: 'up-2' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    const stopAnswer = await postHook(hookPort, {
      hook_event_name: 'Stop',
      session_id: 'terminal-upsub-2',
    });
    expect(stopAnswer).toEqual({ decision: 'block', reason: 'stop-delivered' });

    const answer = await postHook(hookPort, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'terminal-upsub-2',
    });
    expect(answer).toEqual({});
  });

  it('managed session UserPromptSubmit always answers {}, leaving the queue untouched', async () => {
    seedTerminalSession('managed-upsub-1');
    // isManagedSession is a closure so this ONE test can flip it mid-run: the first
    // UserPromptSubmit proves the managed branch never touches the queue (answers {} while
    // steering is queued, no steering_delivered card), and flipping it false afterward proves
    // the queue was genuinely untouched by actually delivering the SAME text unchanged.
    let treatAsManaged = true;
    const managedHookReceiver = new HookReceiver({
      store,
      secret: 'shh',
      emit: () => {},
      daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unknown',
      isManagedSession: (sessionId) => treatAsManaged && sessionId === 'managed-upsub-1',
    });
    let captured: number | undefined;
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver: managedHookReceiver,
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
    if (captured === undefined) throw new Error('unreachable');

    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'managed-upsub-1', text: 'still queued', idempotencyKey: 'mg-up-1' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    const managedAnswer = await postHook(captured, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'managed-upsub-1',
    });
    expect(managedAnswer).toEqual({});
    expect(
      relay.received.some(
        (e) =>
          e.type === 'hook.notification' && e.payload.notificationType === 'steering_delivered',
      ),
    ).toBe(false);

    treatAsManaged = false;
    const answer = await postHook(captured, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'managed-upsub-1',
    });
    expect(answer).toEqual({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'still queued' },
    });
  });

  it('TTL-expired steering at UserPromptSubmit time is dropped with an expiry card, never delivered', async () => {
    seedTerminalSession('terminal-upsub-3');
    let now = 1_000_000;
    let captured: number | undefined;
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      clock: () => now,
      publishHookEndpoint: (port) => {
        captured = port;
        return Promise.resolve();
      },
      pollIntervalMs: 100_000,
    });
    await daemon.start();
    await waitFor(() => captured !== undefined);
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: {
        sessionId: 'terminal-upsub-3',
        text: 'stale by the time you type',
        idempotencyKey: 'ttl-up-1',
      },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );

    now += 31 * 60_000; // past the 30-minute steering TTL
    if (captured === undefined) throw new Error('unreachable');
    const answer = await postHook(captured, {
      hook_event_name: 'UserPromptSubmit',
      session_id: 'terminal-upsub-3',
    });

    expect(answer).toEqual({});
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_expired',
      ),
    );
  });

  it('a failed orphan re-attach answers resume_failed with the cause', async () => {
    sessionManager.records.push({
      id: 'orphan-2',
      kind: 'managed',
      state: 'orphaned',
      startedAtMs: 0,
      resumeId: 'sdk-x',
    });
    sessionManager.resumeOrphan = () => Promise.reject(new Error('no conversation on disk'));
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'orphan-2', text: 'continue', idempotencyKey: 'k' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const error = relay.received.find((e) => e.type === 'error');
    if (error?.type === 'error') {
      expect(error.payload.code).toBe('resume_failed');
      expect(error.payload.message).toContain('no conversation on disk');
    }
  });

  // ---- phone-initiated prune of dormant records ----

  it('session.prune drops dormant records and answers pruned + remaining ids', async () => {
    sessionManager.records.push(
      { id: 'orphan-1', kind: 'managed', state: 'orphaned', startedAtMs: 0, resumeId: 'sdk-a' },
      { id: 'done-1', kind: 'managed', state: 'done', startedAtMs: 1 },
      { id: 'resting-1', kind: 'managed', state: 'waiting_input', startedAtMs: 2 },
    );
    // The live handle is what keeps the resting session out of the dormant set.
    sessionManager.handles.set('resting-1', makeFakeHandle('resting-1'));
    // Display-mirror rows for a pruned and a surviving session: the prune must clean up the
    // first and leave the second, or `cctl session status` shows pruned sessions forever.
    store.upsertSession({
      id: 'done-1',
      kind: 'managed',
      state: 'done',
      accountId: null,
      json: '{}',
      updatedAtMs: 1,
    });
    store.upsertSession({
      id: 'resting-1',
      kind: 'managed',
      state: 'waiting_input',
      accountId: null,
      json: '{}',
      updatedAtMs: 2,
    });
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.prune',
      payload: { requestId: 'pr-1', idempotencyKey: 'pk-1' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'session.prune.result'));

    const result = relay.received.find((e) => e.type === 'session.prune.result');
    if (result?.type === 'session.prune.result') {
      expect(result.payload.requestId).toBe('pr-1');
      expect(result.payload.ok).toBe(true);
      expect([...result.payload.prunedSessionIds].sort()).toEqual(['done-1', 'orphan-1']);
      // The registry's post-prune view rides along so the bot can also drop cached rows for
      // sessions this daemon holds no record of at all.
      expect(result.payload.remainingSessionIds).toEqual(['resting-1']);
    }
    // The continuable session survived; only dormant history was forgotten.
    expect(sessionManager.records.map((r) => r.id)).toEqual(['resting-1']);
    // And the display mirror matches: pruned row gone, surviving row intact.
    expect(store.getSession('done-1')).toBeUndefined();
    expect(store.getSession('resting-1')).toBeDefined();
  });

  it('a replayed session.prune (same idempotencyKey) is answered once, never re-run', async () => {
    await daemon.start();
    const frame = {
      daemonId: 'daemon-under-test',
      type: 'session.prune' as const,
      payload: { requestId: 'pr-dup', idempotencyKey: 'pk-dup' },
    };
    relay.push(frame);
    await waitFor(() => relay.received.some((e) => e.type === 'session.prune.result'));
    relay.push(frame);
    await new Promise((r) => setTimeout(r, 60));

    expect(relay.received.filter((e) => e.type === 'session.prune.result')).toHaveLength(1);
    expect(sessionManager.pruneCalls).toHaveLength(1);
  });

  it('a failing prune answers ok:false with the error instead of going silent', async () => {
    sessionManager.prune = () => Promise.reject(new Error('registry locked'));
    await daemon.start();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.prune',
      payload: { requestId: 'pr-err', idempotencyKey: 'pk-err' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'session.prune.result'));

    const result = relay.received.find((e) => e.type === 'session.prune.result');
    if (result?.type === 'session.prune.result') {
      expect(result.payload.ok).toBe(false);
      expect(result.payload.prunedSessionIds).toEqual([]);
      expect(result.payload.error).toContain('registry locked');
    }
  });

  it('a failing session reconciliation is logged and never kills startup', async () => {
    sessionManager.recover = vi.fn(() => Promise.reject(new Error('corrupt sessions.json')));
    await expect(daemon.start()).resolves.toBeUndefined();
    // The daemon is fully up regardless — still connected to the control plane.
    expect(controlPlaneClient.getState()).toBe('open');
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

  it('stop() stops every live session handle — no leaked SDK subprocess on shutdown', async () => {
    // Two live sessions — one mid-turn, one parked on a permission — exactly the shapes a
    // Ctrl+C used to leak: their client.end() never ran, so the spawned `claude` process
    // kept running under the active account, invisible to the next daemon run.
    const running = makeFakeHandle('live-running');
    const parked = makeFakeHandle('live-parked');
    sessionManager.records.push(
      { id: 'live-running', kind: 'managed', state: 'running', startedAtMs: 0 },
      { id: 'live-parked', kind: 'managed', state: 'waiting_permission', startedAtMs: 1 },
    );
    sessionManager.handles.set('live-running', running);
    sessionManager.handles.set('live-parked', parked);
    await daemon.start();

    await daemon.stop();

    expect(running.stopCalls).toBe(1);
    expect(parked.stopCalls).toBe(1);
  });

  it('a wedged handle.stop() cannot hang shutdown — the teardown is bounded', async () => {
    const wedged = makeFakeHandle('wedged-1');
    wedged.stop = () => {
      wedged.stopCalls += 1;
      return new Promise<void>(() => undefined); // never settles — a dead transport
    };
    sessionManager.records.push({
      id: 'wedged-1',
      kind: 'managed',
      state: 'running',
      startedAtMs: 0,
    });
    sessionManager.handles.set('wedged-1', wedged);
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      sessionStopOnShutdownMs: 50, // short real-time bound, house convention (no fake timers)
      pollIntervalMs: 100_000,
    });
    await daemon.start();

    // Boundedness is proven by resolving at all: an unbounded teardown would await the
    // never-settling stop() forever and this test would die on its own timeout. No
    // wall-clock assertion — elapsed-time checks flake under parallel-suite load.
    await daemon.stop();

    expect(wedged.stopCalls).toBe(1);
  });

  // ---- cctl session registry (loopback CLI endpoints) + display mirror ----

  /** Rebuild + start the daemon with a port-capturing endpoint publisher, so the test knows the
   *  loopback port to POST cctl-session commands at. Returns the bound port. */
  async function startCapturingHookPort(): Promise<number> {
    let captured: number | undefined;
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
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
    if (captured === undefined) throw new Error('hook port was never published');
    return captured;
  }

  /** POST a cctl-session command to the daemon's loopback CLI endpoint (real HTTP, house
   *  convention). Secret is the receiver's own ('shh' from beforeEach). */
  async function postCli(
    hookPort: number,
    verb: string,
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
    const res = await fetch(`http://127.0.0.1:${hookPort}/cli/session/${verb}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': 'shh' },
      body: JSON.stringify(body),
    });
    const parsed = (await res.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    return { status: res.status, body: parsed };
  }

  it('mirrors managed-session state transitions into the display-only sessions table', async () => {
    await daemon.start();
    const handle = await spawnFakeSession();
    handle.emit({ kind: 'status', state: 'running' });
    await waitFor(() => store.getSession('spawned-session') !== undefined);
    expect(store.getSession('spawned-session')).toMatchObject({
      kind: 'managed',
      state: 'running',
    });
  });

  it('publishHookEndpoint is called with the receiver’s actual bound port', async () => {
    const port = await startCapturingHookPort();
    expect(port).toBeGreaterThan(0);
  });

  it('re-publishes the hook endpoint on a heartbeat, so a deleted endpoint file self-heals', async () => {
    const publishes: number[] = [];
    daemon = new Daemon({
      store,
      switchEngine,
      sessionManager,
      poller,
      attributionJournal,
      hookReceiver,
      controlPlaneClient,
      createAgentSdkClient: () => fakeAgentSdkClient,
      publishHookEndpoint: (port) => {
        publishes.push(port);
        return Promise.resolve();
      },
      endpointRepublishMs: 25,
      pollIntervalMs: 100_000,
    });
    await daemon.start();
    // One initial publish plus heartbeat re-publishes, all naming the same bound port.
    await waitFor(() => publishes.length >= 3);
    expect(new Set(publishes).size).toBe(1);
  });

  it('GET /healthz answers ok without a secret — the supervision liveness probe', async () => {
    const hookPort = await startCapturingHookPort();
    const res = await fetch(`http://127.0.0.1:${hookPort}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('register creates an interactive session row (watch on, active account tagged)', async () => {
    switchEngine.getActiveId.mockResolvedValue('acct-x');
    const hookPort = await startCapturingHookPort();
    const res = await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-1',
      idempotencyKey: 'reg-1',
      label: 'refactor',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, status: 'applied' });
    const row = store.getSession('cc-sess-1');
    expect(row).toMatchObject({ kind: 'interactive', accountId: 'acct-x' });
    const parsed = JSON.parse(row!.json) as { label: string; watch: boolean };
    expect(parsed).toMatchObject({ label: 'refactor', watch: true });
  });

  it('register is idempotent on the idempotency key (re-send = already_handled)', async () => {
    const hookPort = await startCapturingHookPort();
    const first = await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-2',
      idempotencyKey: 'dup',
    });
    expect(first.body).toMatchObject({ status: 'applied' });
    const second = await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-2',
      idempotencyKey: 'dup',
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ status: 'already_handled' });
  });

  it('label/watch on an UNREGISTERED session are a clean 404, never a crash', async () => {
    const hookPort = await startCapturingHookPort();
    const label = await postCli(hookPort, 'label', {
      sessionId: 'ghost',
      idempotencyKey: 'l',
      label: 'x',
    });
    expect(label.status).toBe(404);
    expect(label.body).toMatchObject({ ok: false, code: 'unknown_session' });
    const watch = await postCli(hookPort, 'watch', {
      sessionId: 'ghost',
      idempotencyKey: 'w',
      watch: true,
    });
    expect(watch.status).toBe(404);
  });

  it('watch flips the streaming flag; label sets the name preserving watch', async () => {
    const hookPort = await startCapturingHookPort();
    await postCli(hookPort, 'register', { sessionId: 'cc-sess-3', idempotencyKey: 'r3' });
    await postCli(hookPort, 'watch', {
      sessionId: 'cc-sess-3',
      idempotencyKey: 'w3',
      watch: false,
    });
    await postCli(hookPort, 'label', {
      sessionId: 'cc-sess-3',
      idempotencyKey: 'l3',
      label: 'named',
    });
    const parsed = JSON.parse(store.getSession('cc-sess-3')!.json) as {
      label: string;
      watch: boolean;
    };
    expect(parsed).toMatchObject({ label: 'named', watch: false });
  });

  it('a repeated no-change register answers already_registered — fresh keys, no rewrite', async () => {
    const hookPort = await startCapturingHookPort();
    await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-5',
      idempotencyKey: 'r5a',
      label: 'demo',
    });
    const rowAfterFirst = store.getSession('cc-sess-5');

    // A separate deliberate invocation (new key, same values) — the key set cannot catch
    // this; the VALUE comparison must, and the row must not be churned by it.
    const same = await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-5',
      idempotencyKey: 'r5b',
      label: 'demo',
    });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ ok: true, status: 'already_registered' });
    expect(store.getSession('cc-sess-5')).toEqual(rowAfterFirst);

    // Supplying a NEW label is a genuine update, not a repeat.
    const relabel = await postCli(hookPort, 'register', {
      sessionId: 'cc-sess-5',
      idempotencyKey: 'r5c',
      label: 'renamed',
    });
    expect(relabel.body).toMatchObject({ ok: true, status: 'applied' });
    const parsed = JSON.parse(store.getSession('cc-sess-5')!.json) as { label: string };
    expect(parsed.label).toBe('renamed');
  });

  it('unregister removes the row; the id is then unknown to label/unregister alike', async () => {
    const hookPort = await startCapturingHookPort();
    await postCli(hookPort, 'register', { sessionId: 'cc-sess-6', idempotencyKey: 'r6' });
    expect(store.getSession('cc-sess-6')).toBeDefined();

    const removed = await postCli(hookPort, 'unregister', {
      sessionId: 'cc-sess-6',
      idempotencyKey: 'u6',
    });
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ ok: true, status: 'applied' });
    expect(store.getSession('cc-sess-6')).toBeUndefined();

    // A fresh unregister of the now-gone id is an honest 404…
    const again = await postCli(hookPort, 'unregister', {
      sessionId: 'cc-sess-6',
      idempotencyKey: 'u6-fresh',
    });
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ ok: false, code: 'unknown_session' });

    // …while a REPLAY of the applied unregister (same key) stays a calm already_handled.
    const replay = await postCli(hookPort, 'unregister', {
      sessionId: 'cc-sess-6',
      idempotencyKey: 'u6',
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ ok: true, status: 'already_handled' });
  });

  it('unregister never touches a managed mirror row (interactive-only by kind)', async () => {
    const hookPort = await startCapturingHookPort();
    // A managed session's mirror row shares the table but not the kind.
    store.upsertSession({
      id: 'managed-1',
      kind: 'managed',
      state: 'running',
      accountId: null,
      json: '{}',
      updatedAtMs: 0,
    });
    const res = await postCli(hookPort, 'unregister', {
      sessionId: 'managed-1',
      idempotencyKey: 'um',
    });
    expect(res.status).toBe(404);
    expect(store.getSession('managed-1')).toBeDefined();
  });

  // ---- label refs: label/watch/unregister (and prompt.inject) may address a session by its
  // registered label instead of its id — the daemon resolves it (resolveInteractiveRef). ----

  it('unregister by label removes the row and echoes the real session id', async () => {
    seedTerminalSession('term-by-label', 'demo-label');
    const hookPort = await startCapturingHookPort();

    const res = await postCli(hookPort, 'unregister', {
      sessionId: 'demo-label',
      idempotencyKey: 'ul-1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: 'applied',
      session: { id: 'term-by-label' },
    });
    expect(store.getSession('term-by-label')).toBeUndefined();
  });

  it('watch/label by label ref apply to the right row', async () => {
    seedTerminalSession('term-a', 'alpha-label');
    seedTerminalSession('term-b', 'beta-label');
    const hookPort = await startCapturingHookPort();

    await postCli(hookPort, 'watch', {
      sessionId: 'beta-label',
      idempotencyKey: 'wl-1',
      watch: false,
    });
    await postCli(hookPort, 'label', {
      sessionId: 'alpha-label',
      idempotencyKey: 'll-1',
      label: 'renamed-alpha',
    });

    const a = JSON.parse(store.getSession('term-a')!.json) as { label: string; watch: boolean };
    const b = JSON.parse(store.getSession('term-b')!.json) as { label: string; watch: boolean };
    // Each command only touched the row its OWN label named — a shared resolver is not license
    // to blur which row a command acts on.
    expect(a).toMatchObject({ label: 'renamed-alpha', watch: true });
    expect(b).toMatchObject({ label: 'beta-label', watch: false });
  });

  it('an ambiguous label is refused with 409 naming both matching ids, rows untouched', async () => {
    seedTerminalSession('term-dup-1', 'dup');
    seedTerminalSession('term-dup-2', 'dup');
    const hookPort = await startCapturingHookPort();
    const before1 = store.getSession('term-dup-1');
    const before2 = store.getSession('term-dup-2');

    const res = await postCli(hookPort, 'label', {
      sessionId: 'dup',
      idempotencyKey: 'amb-1',
      label: 'x',
    });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, code: 'ambiguous_label' });
    const message = res.body?.message as string | undefined;
    expect(message).toContain('term-dup-1');
    expect(message).toContain('term-dup-2');
    expect(store.getSession('term-dup-1')).toEqual(before1);
    expect(store.getSession('term-dup-2')).toEqual(before2);
  });

  it('an id ref wins outright over a session labeled with that same string', async () => {
    seedTerminalSession('alpha');
    seedTerminalSession('term-other', 'alpha');
    const hookPort = await startCapturingHookPort();

    const res = await postCli(hookPort, 'label', {
      sessionId: 'alpha',
      idempotencyKey: 'idwin-1',
      label: 'renamed',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, session: { id: 'alpha', label: 'renamed' } });
    // The session merely LABELED 'alpha' never entered the resolution — its own label is untouched.
    const other = JSON.parse(store.getSession('term-other')!.json) as { label: string };
    expect(other.label).toBe('alpha');
  });

  it('register never resolves labels: a sessionId equal to an existing label creates a new row', async () => {
    seedTerminalSession('term-labeled', 'taken-label');
    const hookPort = await startCapturingHookPort();

    const res = await postCli(hookPort, 'register', {
      sessionId: 'taken-label',
      idempotencyKey: 'reg-label-1',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: 'applied',
      session: { id: 'taken-label' },
    });
    // A brand-new row keyed on the literal string 'taken-label' — the session that happens to be
    // LABELED that string is a completely separate row, untouched.
    expect(store.getSession('taken-label')).toBeDefined();
    const untouched = JSON.parse(store.getSession('term-labeled')!.json) as { label: string };
    expect(untouched.label).toBe('taken-label');
  });

  it('prompt.inject by label queues steering under the REAL session id', async () => {
    seedTerminalSession('term-lab-1', 'wet');
    const hookPort = await startCapturingHookPort();
    relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'wet', text: 'steer by label', idempotencyKey: 'lbl-1' },
    });
    await waitFor(() =>
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    );
    const card = relay.received.find((e) => e.type === 'hook.notification');
    if (card?.type === 'hook.notification') {
      // Queued under the REAL id, not the label the operator typed — otherwise the Stop hook
      // below (which only ever knows the real id) could never find the queue.
      expect(card.payload.sessionId).toBe('term-lab-1');
    }
    expect(relay.received.some((e) => e.type === 'error')).toBe(false);

    const answer = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'term-lab-1' });
    expect(answer).toEqual({ decision: 'block', reason: 'steer by label' });
  });

  it('prompt.inject with an ambiguous label answers an error envelope and queues nothing', async () => {
    seedTerminalSession('term-dup-a', 'dup');
    seedTerminalSession('term-dup-b', 'dup');
    const hookPort = await startCapturingHookPort();
    const frame = relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: 'dup', text: 'who gets this?', idempotencyKey: 'amb-inj-1' },
    });
    await waitFor(() => relay.received.some((e) => e.type === 'error'));
    const error = relay.received.find((e) => e.type === 'error');
    if (error?.type === 'error') {
      expect(error.payload.code).toBe('ambiguous_label');
      expect(error.payload.relatesTo).toBe(frame.id);
    }
    expect(
      relay.received.some(
        (e) => e.type === 'hook.notification' && e.payload.notificationType === 'steering_queued',
      ),
    ).toBe(false);

    // Neither candidate got anything queued — both answer a plain, un-steered stop.
    const answerA = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'term-dup-a' });
    const answerB = await postHook(hookPort, { hook_event_name: 'Stop', session_id: 'term-dup-b' });
    expect(answerA).toEqual({ ok: true });
    expect(answerB).toEqual({ ok: true });
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
