// `switch.command` idempotency: a re-delivered or double-tapped switch frame must activate
// once.
//
// A switch is the least replay-safe command the phone can send. Every other inbound command
// either reports something or acts on a session the operator is looking at; this one moves the
// live account for the whole machine, and the relay's delivery guarantee is at-least-once. A
// frame replayed after the operator has moved on drags the live login back to the earlier
// target and files a second activation in the audit trail, where it reads as a hop nobody asked
// for.
//
// Driven over a real socket through a real ControlPlaneClient, because the dedupe has to hold
// on the path the frames actually arrive by.

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decode,
  encode,
  isType,
  negotiateVersion,
  stamp,
  type Envelope,
  type EnvelopeDraft,
  type PayloadOf,
} from '@claude-control/shared-protocol';
import type { ActivateResult, RecoverResult, StoredAccount } from '@claude-control/switch-engine';
import type { SessionManager, SessionRecord } from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import {
  ControlPlaneClient,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';
import { Daemon, SEEN_SWITCH_KEY_TTL_MS, type SwitchEngineLike } from './daemon.js';

const DAEMON_ID = 'daemon-under-test';

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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const ACCOUNTS: StoredAccount[] = [
  { id: 'acct-x', label: 'main', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
  { id: 'acct-y', label: 'spare', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
];

function stubSessionManager(): SessionManager {
  const records: SessionRecord[] = [];
  return {
    spawnManaged: () => Promise.reject(new Error('not used in this test')),
    attachObserved: () => Promise.reject(new Error('not used in this test')),
    get: () => undefined,
    list: () => records,
    recover: () => Promise.resolve([]),
  };
}

interface Rig {
  relay: SteadyRelay;
  /** Every account id the engine was asked to activate, in order. The engine is also what
   *  writes the audit line per activation, so this list IS the audit trail's length. */
  activated: string[];
  switchResults: () => Array<PayloadOf<'switch.result'>>;
  /** Move the daemon's own clock forward. The daemon reads every age it measures through the
   *  injected clock (house convention: no fake timers), so ageing a remembered key out takes no
   *  waiting and no timer control. */
  advance: (ms: number) => void;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function startRig(): Promise<Rig> {
  const relay = new SteadyRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-switchdedupe-'));
  const activated: string[] = [];
  // A plain number the test moves by hand: the daemon's clock is injectable precisely so an age
  // can be crossed without waiting for one.
  let nowMs = 1_700_000_000_000;

  const switchEngine: SwitchEngineLike = {
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate: (id: string): Promise<ActivateResult> => {
      activated.push(id);
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: (): Promise<StoredAccount[]> => Promise.resolve(ACCOUNTS),
    getActiveId: (): Promise<string | null> => Promise.resolve('acct-x'),
    reauthenticate: () => Promise.reject(new Error('not used in this test')),
  };

  const hookReceiver = new HookReceiver({
    store,
    secret: 'shh',
    emit: () => {},
    daemonId: () => DAEMON_ID,
  });
  const identity: DaemonIdentity = { daemonId: DAEMON_ID, daemonToken: 'tok' };
  const identityStore: IdentityStore = {
    load: () => Promise.resolve(identity),
    save: () => Promise.resolve(),
  };
  const controlPlaneClient = new ControlPlaneClient({
    url: relay.url(relayPort),
    identityStore,
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });

  const daemon = new Daemon({
    store,
    switchEngine,
    sessionManager: stubSessionManager(),
    // No usable token anywhere: the poll cycle degrades to tier-0 and stays out of the way.
    poller: new UsagePoller({
      fetch: () => Promise.reject(new Error('no network in this test')),
      getToken: () => Promise.resolve(undefined),
      getCachedUsage: () => Promise.resolve(undefined),
    }),
    attributionJournal: new AttributionJournal({ store, vaultDir }),
    hookReceiver,
    controlPlaneClient,
    pollIntervalMs: 100_000,
    clock: () => nowMs,
  });

  cleanups.push(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  await daemon.start();
  return {
    relay,
    activated,
    switchResults: () =>
      relay.received.filter((e) => e.type === 'switch.result').map((e) => e.payload),
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

function switchFrame(options: {
  requestId: string;
  targetAccountId: string;
  idempotencyKey: string;
}): EnvelopeDraft {
  return {
    daemonId: DAEMON_ID,
    type: 'switch.command',
    payload: {
      requestId: options.requestId,
      targetAccountId: options.targetAccountId,
      reason: 'manual',
      idempotencyKey: options.idempotencyKey,
    },
  };
}

describe('switch.command idempotency', () => {
  it('a replayed frame activates once and files one activation', async () => {
    const rig = await startRig();
    const frame = switchFrame({
      requestId: 'r1',
      targetAccountId: 'acct-y',
      idempotencyKey: 'k1',
    });
    rig.relay.push(frame);
    await waitFor(() => rig.switchResults().length === 1);

    // The same frame again — what an at-least-once relay redelivering, or a double-tapped
    // button, actually sends.
    rig.relay.push(frame);
    // Sequenced behind a DIFFERENT command rather than a sleep: frames are dispatched in
    // arrival order, so once the third one has answered the second has had its chance.
    rig.relay.push(
      switchFrame({ requestId: 'r2', targetAccountId: 'acct-x', idempotencyKey: 'k2' }),
    );
    await waitFor(() => rig.switchResults().length === 2);

    expect(rig.activated).toEqual(['acct-y', 'acct-x']);
    expect(rig.switchResults().map((p) => p.requestId)).toEqual(['r1', 'r2']);
  });

  it('reports the switch it performed with an outcome that matches its own ok flag', async () => {
    const rig = await startRig();
    rig.relay.push(
      switchFrame({ requestId: 'r1', targetAccountId: 'spare', idempotencyKey: 'k1' }),
    );
    await waitFor(() => rig.switchResults().length === 1);

    const result = rig.switchResults()[0] as PayloadOf<'switch.result'>;
    expect(result.ok).toBe(true);
    expect(result.outcome).toBe('hot_applied');
    // Resolved by label, and named by the label the operator used.
    expect(rig.activated).toEqual(['acct-y']);
    expect(result.message).toBe('switched to spare');
  });

  // A tapped card derives its key from the LOGICAL action — who, what, which account — so that
  // two phones tapping the same button collapse to one command. The price of that is a key that
  // recurs: tapping "switch to spare" again next week produces the identical string. The sender
  // forgets its own copy after fifteen minutes and lets the second one through, so a daemon that
  // remembers forever drops a command the operator just issued and answers it with nothing at
  // all — a request on the phone that never resolves.
  const CARD_KEY = 'btn:user-1:switch:account:acct-y';

  it('still drops a redelivery of the same key inside the window, right up to its edge', async () => {
    const rig = await startRig();
    const frame = switchFrame({
      requestId: 'r1',
      targetAccountId: 'acct-y',
      idempotencyKey: CARD_KEY,
    });
    rig.relay.push(frame);
    await waitFor(() => rig.switchResults().length === 1);

    // Exactly AT the boundary is still the same command: the two ends must not disagree by a
    // millisecond over which frames are replays.
    rig.advance(SEEN_SWITCH_KEY_TTL_MS);
    rig.relay.push(frame);
    // Sequenced behind a different command rather than a sleep, as above.
    rig.relay.push(
      switchFrame({ requestId: 'r2', targetAccountId: 'acct-x', idempotencyKey: 'k-other' }),
    );
    await waitFor(() => rig.switchResults().length === 2);

    expect(rig.activated).toEqual(['acct-y', 'acct-x']);
    expect(rig.switchResults().map((p) => p.requestId)).toEqual(['r1', 'r2']);
  });

  it('treats the same key past the TTL as the new command it is', async () => {
    const rig = await startRig();
    rig.relay.push(
      switchFrame({ requestId: 'r1', targetAccountId: 'acct-y', idempotencyKey: CARD_KEY }),
    );
    await waitFor(() => rig.switchResults().length === 1);

    // The operator switches away, then taps the same card's button again later.
    rig.relay.push(
      switchFrame({ requestId: 'r2', targetAccountId: 'acct-x', idempotencyKey: 'k-other' }),
    );
    await waitFor(() => rig.switchResults().length === 2);
    rig.advance(SEEN_SWITCH_KEY_TTL_MS + 1);
    rig.relay.push(
      switchFrame({ requestId: 'r3', targetAccountId: 'acct-y', idempotencyKey: CARD_KEY }),
    );
    await waitFor(() => rig.switchResults().length === 3);

    // It switched, and it said so — silence here is the failure, not a second activation.
    expect(rig.activated).toEqual(['acct-y', 'acct-x', 'acct-y']);
    expect(rig.switchResults().map((p) => p.requestId)).toEqual(['r1', 'r2', 'r3']);
  });
});
