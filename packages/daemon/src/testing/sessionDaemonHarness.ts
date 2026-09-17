// Test-only: the smallest real Daemon that can be driven over a real socket, plus the session
// fakes its session-lifecycle behaviour is asserted against. Shared by the session-focused
// daemon test files; never imported by production code.
//
// Deliberately free of any vitest import (like cli/src/testing/fakeTaskScheduler.ts): the fakes
// record what happened in plain arrays, so they compile and read as ordinary code and the
// assertions stay in the test files where they belong.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
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
  ActivateResult,
  Logger,
  RecoverResult,
  ReauthResult,
  StoredAccount,
} from '@claude-control/switch-engine';
import type {
  AgentSdkClient,
  AgentSdkEvent,
  ResumeOrphanOptions,
  SessionEvent,
  SessionHandle,
  SessionManager,
  SessionRecord,
  SessionState,
} from '@claude-control/session-runtime';
import { Store } from '../store.js';
import { UsagePoller } from '../usagePoller.js';
import { AttributionJournal } from '../attributionJournal.js';
import { HookReceiver } from '../hookReceiver.js';
import { ControlPlaneClient, type DaemonIdentity } from '../controlPlaneClient.js';
import { Daemon, type AutoSwitcherLike, type SwitchEngineLike } from '../daemon.js';

/** A minimal steady-state relay: accepts `hello`, answers `ping`, collects everything the
 *  daemon sends, and can push envelopes down to it. Enough wire protocol to drive the daemon's
 *  inbound dispatch for real rather than by calling private methods. */
export class TestRelay {
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

  /** Returns the stamped envelope so a test can correlate on its id (e.g. error.relatesTo). */
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

/** Poll until `predicate` holds — the only way to observe work the daemon does off a timer
 *  (a poll cycle) or behind a socket round-trip. */
export async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A managed SessionHandle a test drives by hand, including the one state the daemon has to
 *  treat specially: PARKED on a usage limit (idle, but not ready for work). */
export interface FakeManagedHandle extends SessionHandle {
  /** Synthesize a backend event (what the real runtime would emit). */
  emit: (e: SessionEvent) => void;
  /** Park/un-park, mirroring what a usage-limit death and a resumed turn do. */
  setParked: (parked: boolean) => void;
  /** Text the daemon actually sent into the session, in order. */
  sent: string[];
  /** How many times the daemon kicked this session's usage-limit park. */
  kicks: number;
}

export function fakeManagedHandle(id: string, parked = false): FakeManagedHandle {
  const listeners = new Set<(e: SessionEvent) => void>();
  let state: SessionState = parked ? 'waiting_input' : 'running';
  let isParked = parked;
  const handle: FakeManagedHandle = {
    id,
    sent: [],
    kicks: 0,
    getState: () => state,
    onEvent(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    send(text: string) {
      handle.sent.push(text);
      return Promise.resolve();
    },
    interrupt: () => Promise.resolve(),
    stop() {
      state = 'done';
      handle.emit({ kind: 'status', state: 'done' });
      return Promise.resolve();
    },
    isParkedOnUsageLimit: () => isParked,
    resumeFromUsageLimitStall() {
      // Mirrors the real handle: only a parked session reacts, and the resume consumes the
      // park by starting a turn — which is what makes a second kick a no-op.
      if (!isParked) return false;
      handle.kicks += 1;
      isParked = false;
      state = 'running';
      return true;
    },
    emit(e: SessionEvent) {
      if (e.kind === 'status') state = e.state;
      for (const cb of listeners) cb(e);
    },
    setParked(next: boolean) {
      isParked = next;
    },
  };
  return handle;
}

export interface FakeSessionManager extends SessionManager {
  /** Live handles by id — seed one to make the daemon treat a session as running here. */
  handles: Map<string, SessionHandle>;
  /** Backing array for list(); seed persisted-looking records here. */
  records: SessionRecord[];
  /** What recover() should report (and therefore what startup reconciliation acts on). */
  recovered: SessionRecord[];
  /** Every resumeOrphan call, with real types. */
  resumeOrphanCalls: Array<{ sessionId: string; opts: ResumeOrphanOptions }>;
  /** Every spawnManaged call's options, for asserting what the daemon threads into a spawn. */
  spawnCalls: unknown[];
}

export function fakeSessionManager(): FakeSessionManager {
  const handles = new Map<string, SessionHandle>();
  const records: SessionRecord[] = [];
  const recovered: SessionRecord[] = [];
  const resumeOrphanCalls: Array<{ sessionId: string; opts: ResumeOrphanOptions }> = [];
  const spawnCalls: unknown[] = [];
  return {
    handles,
    records,
    recovered,
    resumeOrphanCalls,
    spawnCalls,
    spawnManaged(opts) {
      spawnCalls.push(opts);
      const handle = fakeManagedHandle(opts.id ?? 'spawned-session');
      handles.set(handle.id, handle);
      // A record as well as a handle, like the real manager: everything that walks the registry
      // (the post-switch kick, the session mirror) sees a spawn only through list().
      records.push({
        id: handle.id,
        kind: 'managed',
        state: handle.getState(),
        startedAtMs: 0,
        ...(opts.accountId !== undefined ? { accountId: opts.accountId } : {}),
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      });
      return Promise.resolve(handle);
    },
    attachObserved() {
      throw new Error('observed sessions are not used in these tests');
    },
    get: (id: string) => handles.get(id),
    list: () => records,
    recover: () => Promise.resolve(recovered),
    resumeOrphan(sessionId, opts) {
      resumeOrphanCalls.push({ sessionId, opts });
      // Mirror the real manager: the resumed handle comes live under the SAME id.
      const handle = fakeManagedHandle(sessionId);
      handles.set(sessionId, handle);
      return Promise.resolve(handle);
    },
    prune: () => Promise.resolve([]),
  };
}

export interface FakeSwitchEngine extends SwitchEngineLike {
  /** The currently-active account — writable, which is how a test plays a `cctl switch` that
   *  happened outside the daemon. */
  activeId: string | null;
  accounts: StoredAccount[];
  /** Every activate() call, in order. */
  activations: Array<{ accountId: string; origin: string | undefined }>;
}

export function fakeSwitchEngine(activeId: string | null = 'acct-x'): FakeSwitchEngine {
  const engine: FakeSwitchEngine = {
    activeId,
    activations: [],
    accounts: [
      { id: 'acct-x', label: 'main', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
      { id: 'acct-y', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
    ],
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate(id: string, options?: { origin?: string }): Promise<ActivateResult> {
      engine.activations.push({ accountId: id, origin: options?.origin });
      engine.activeId = id;
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: () => Promise.resolve(engine.accounts),
    getActiveId: () => Promise.resolve(engine.activeId),
    reauthenticate: (id: string): Promise<ReauthResult> =>
      Promise.resolve({
        account: { id, label: id, quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
        healedLiveLogin: false,
        identityVerified: true,
      }),
  };
  return engine;
}

/** An AgentSdkClient whose turn N yields `script[N]` and then ends — the seam that lets a test
 *  put a REAL managed session (park included) behind the daemon with no SDK anywhere. */
export function scriptedAgentSdkClient(script: AgentSdkEvent[][]): AgentSdkClient {
  let turn = 0;
  return {
    query() {
      const events = script[turn] ?? [];
      turn++;
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentSdkEvent> {
          await Promise.resolve();
          for (const e of events) yield e;
        },
      };
    },
    interrupt: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
}

/** Log lines a test can assert on for policy the daemon only reports through the logger. */
export function capturingLogger(): {
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

export interface HarnessOptions {
  sessionManager?: SessionManager;
  switchEngine?: FakeSwitchEngine;
  createAgentSdkClient?: () => AgentSdkClient;
  autoContinue?: { maxAttempts?: number; schedule?: (fn: () => void, ms: number) => () => void };
  autoSwitcher?: AutoSwitcherLike;
  /** Effectively off by default: most tests drive exactly one cycle via start(). */
  pollIntervalMs?: number;
  logger?: Logger;
}

export interface Harness {
  daemon: Daemon;
  relay: TestRelay;
  store: Store;
  switchEngine: FakeSwitchEngine;
  sessionManager: SessionManager;
  /** Envelopes the daemon has sent, newest last. */
  sent: Envelope[];
  dispose: () => Promise<void>;
}

/** Wire one Daemon over a real loopback relay with real-but-cheap collaborators (in-memory
 *  Store, a token-less UsagePoller, a real HookReceiver) and fakes for everything a session
 *  test needs to control. */
export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const relay = new TestRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-sessions-'));
  const switchEngine = options.switchEngine ?? fakeSwitchEngine();
  const sessionManager = options.sessionManager ?? fakeSessionManager();
  const poller = new UsagePoller({
    // No token and an empty cached payload: every account polls to "nothing known", which is
    // exactly the unknown-is-not-exhausted input the post-switch headroom guard passes.
    fetch: () => Promise.reject(new Error('no network in tests')),
    getToken: () => Promise.resolve(undefined),
    getCachedUsage: () => Promise.resolve({ limits: [] }),
  });
  const attributionJournal = new AttributionJournal({ store, vaultDir });
  const identity: DaemonIdentity = { daemonId: 'daemon-under-test', daemonToken: 'tok' };
  const controlPlaneClient = new ControlPlaneClient({
    url: `ws://127.0.0.1:${relayPort}`,
    identityStore: { load: () => Promise.resolve(identity), save: () => Promise.resolve() },
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });
  const hookReceiver = new HookReceiver({
    store,
    secret: 'shh',
    emit: () => undefined,
    daemonId: () => controlPlaneClient.getIdentity()?.daemonId ?? 'unknown',
  });
  const daemon = new Daemon({
    store,
    switchEngine,
    sessionManager,
    poller,
    attributionJournal,
    hookReceiver,
    controlPlaneClient,
    // An empty script by default: a client whose turns produce nothing at all, for the tests
    // that never let a real managed session run behind the daemon.
    createAgentSdkClient: options.createAgentSdkClient ?? (() => scriptedAgentSdkClient([])),
    ...(options.autoContinue !== undefined ? { autoContinue: options.autoContinue } : {}),
    ...(options.autoSwitcher !== undefined ? { autoSwitcher: options.autoSwitcher } : {}),
    ...(options.logger !== undefined ? { logger: options.logger } : {}),
    pollIntervalMs: options.pollIntervalMs ?? 100_000,
  });
  return {
    daemon,
    relay,
    store,
    switchEngine,
    sessionManager,
    sent: relay.received,
    async dispose() {
      await daemon.stop().catch(() => undefined);
      await relay.close();
      await rm(vaultDir, { recursive: true, force: true });
    },
  };
}
