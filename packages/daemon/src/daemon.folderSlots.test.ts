// Folder-bound slots in the daemon poll cycle: the per-slot auto-switch (global over the shared
// pool, each group over its own members), the group context carried onto the usage wire, the
// startup snapshot refresh, the per-cycle group ensure-live + slot-invariant repair, and the
// once-per-window alert a group out of quota raises.
//
// Driven through the real Daemon against a real Store/HookReceiver/ControlPlaneClient and a
// minimal in-process relay, like daemon.pollCycle.test.ts — a group-aware FAKE switch engine is
// the one seam, because a real one would need on-disk profiles these cases do not exercise.

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
import {
  groupSlotId,
  type AccountView,
  type ActivateResult,
  type GroupLiveResult,
  type Logger,
  type RecoverResult,
  type RepairResult,
  type SlotId,
  type SlotViolation,
  type StoredAccount,
  type StoredGroup,
} from '@claude-control/switch-engine';
import type { SessionManager, SessionRecord } from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller, type FetchLikeResponse } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import {
  ControlPlaneClient,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';
import { AutoSwitcher } from './autoSwitcher.js';
import { Daemon, type SwitchEngineLike } from './daemon.js';

const NOW = Date.parse('2026-07-25T19:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const iso = (atMs: number): string => new Date(atMs).toISOString();

// A minimal steady-state relay (identical contract to the one in daemon.pollCycle.test.ts).
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

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

function view(id: string, label: string, groupId?: string): AccountView {
  return {
    id,
    label,
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(groupId !== undefined ? { groupId } : {}),
  };
}

/** A group-aware fake engine. Live slots are mutable so an activation is observable to the next
 *  liveSlots() read; checkSlots/repairSlots are stubbable per case. */
interface FakeEngineControls {
  engine: SwitchEngineLike;
  activateCalls: Array<{ id: string }>;
  ensureGroupLiveCalls: string[];
  refreshSnapshotCalls: number;
  checkSlotsCalls: number;
  repairSlotsCalls: number;
  liveSlots: Map<SlotId, string | null>;
}

function fakeEngine(opts: {
  accounts: AccountView[];
  groups: StoredGroup[];
  live: Map<SlotId, string | null>;
  violations?: SlotViolation[];
  repair?: RepairResult;
}): FakeEngineControls {
  const controls: FakeEngineControls = {
    activateCalls: [],
    ensureGroupLiveCalls: [],
    refreshSnapshotCalls: 0,
    checkSlotsCalls: 0,
    repairSlotsCalls: 0,
    liveSlots: opts.live,
    engine: undefined as unknown as SwitchEngineLike,
  };
  controls.engine = {
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate: (id: string): Promise<ActivateResult> => {
      controls.activateCalls.push({ id });
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: (): Promise<StoredAccount[]> =>
      Promise.resolve(opts.accounts.filter((a) => a.groupId === undefined)),
    listAllAccounts: (): Promise<AccountView[]> => Promise.resolve(opts.accounts),
    listGroups: (): Promise<StoredGroup[]> => Promise.resolve(opts.groups),
    liveSlots: (): Promise<Map<SlotId, string | null>> =>
      Promise.resolve(new Map(controls.liveSlots)),
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      Promise.resolve(controls.liveSlots.get(slot) ?? null),
    ensureGroupLive: (groupId: string): Promise<GroupLiveResult> => {
      controls.ensureGroupLiveCalls.push(groupId);
      const live = controls.liveSlots.get(groupSlotId(groupId)) ?? null;
      return Promise.resolve({
        groupId,
        liveMember: live,
        activated: false,
        noWorkingAccount: false,
      });
    },
    checkSlots: (): Promise<SlotViolation[]> => {
      controls.checkSlotsCalls++;
      return Promise.resolve(opts.violations ?? []);
    },
    repairSlots: (): Promise<RepairResult> => {
      controls.repairSlotsCalls++;
      return Promise.resolve(opts.repair ?? { repaired: [], remaining: [], actions: [] });
    },
    refreshSnapshot: (): Promise<void> => {
      controls.refreshSnapshotCalls++;
      return Promise.resolve();
    },
    reauthenticate: () => Promise.reject(new Error('unused')),
  };
  return controls;
}

function stubSessionManager(): SessionManager {
  const records: SessionRecord[] = [];
  return {
    spawnManaged: () => Promise.reject(new Error('unused')),
    attachObserved: () => Promise.reject(new Error('unused')),
    get: () => undefined,
    list: () => records,
    recover: () => Promise.resolve([]),
  };
}

function silentLogger(): Logger {
  const noop = (): void => {};
  return { debug: noop, info: noop, warn: noop, error: noop };
}

const jsonResponse = (body: unknown): FetchLikeResponse => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(body),
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

interface Rig {
  daemon: Daemon;
  relay: SteadyRelay;
  controls: FakeEngineControls;
  start: () => Promise<void>;
}

async function createRig(opts: {
  controls: FakeEngineControls;
  bodyFor: (accountId: string) => unknown;
  withAutoSwitcher?: boolean;
  slotAlertWindowMs?: number;
  pollIntervalMs?: number;
}): Promise<Rig> {
  const relay = new SteadyRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-folderslots-'));

  const poller = new UsagePoller({
    fetch: (_url, init) =>
      Promise.resolve(
        jsonResponse(opts.bodyFor((init.headers.authorization ?? '').replace('Bearer tok-', ''))),
      ),
    getToken: (accountId: string) => Promise.resolve(`tok-${accountId}`),
    getCachedUsage: () => Promise.resolve(undefined),
    clock: () => NOW,
  });

  const controlPlaneClient = new ControlPlaneClient({
    url: relay.url(relayPort),
    identityStore: fakeIdentityStore(),
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });

  const autoSwitcher =
    opts.withAutoSwitcher === true
      ? new AutoSwitcher({
          activate: (id, options) => opts.controls.engine.activate(id, options),
          notify: (payload) =>
            controlPlaneClient.send({ type: 'switch.result', payload, daemonId: 'd' }),
          clock: () => NOW,
          cooldownMs: 0,
        })
      : undefined;

  const daemon = new Daemon({
    store,
    switchEngine: opts.controls.engine,
    sessionManager: stubSessionManager(),
    poller,
    attributionJournal: new AttributionJournal({ store, vaultDir }),
    hookReceiver: new HookReceiver({
      store,
      secret: 'shh',
      emit: () => {},
      daemonId: () => 'd',
    }),
    controlPlaneClient,
    ...(autoSwitcher !== undefined ? { autoSwitcher } : {}),
    logger: silentLogger(),
    clock: () => NOW,
    pollIntervalMs: opts.pollIntervalMs ?? 100_000,
    ...(opts.slotAlertWindowMs !== undefined ? { slotAlertWindowMs: opts.slotAlertWindowMs } : {}),
  });

  cleanups.push(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  return { daemon, relay, controls: opts.controls, start: () => daemon.start() };
}

function fakeIdentityStore(): IdentityStore {
  const identity: DaemonIdentity = { daemonId: 'd', daemonToken: 't' };
  return { load: () => Promise.resolve(identity), save: () => Promise.resolve() };
}

function lastUsageSnapshot(relay: SteadyRelay): PayloadOf<'usage.snapshot'> {
  const frames = relay.received.filter((e) => e.type === 'usage.snapshot');
  const last = frames[frames.length - 1];
  if (last === undefined || last.type !== 'usage.snapshot') throw new Error('no usage.snapshot');
  return last.payload;
}

function countUsageSnapshots(relay: SteadyRelay): number {
  return relay.received.filter((e) => e.type === 'usage.snapshot').length;
}

function slotAlerts(relay: SteadyRelay): Array<PayloadOf<'hook.notification'>> {
  return relay.received
    .filter((e) => e.type === 'hook.notification')
    .map((e) => e.payload)
    .filter((p) => p.notificationType === 'slot_alert');
}

// One shared account (live global), a group of two members (m1 live), all healthy.
function twoAccountGroup(): {
  accounts: AccountView[];
  groups: StoredGroup[];
  live: Map<SlotId, string | null>;
} {
  const m1 = view('m1', 'Member One', 'g1');
  const m2 = view('m2', 'Member Two', 'g1');
  const shared = view('s1', 'Shared');
  const group: StoredGroup = {
    id: 'g1',
    label: 'C:/work',
    members: [m1, m2],
    activeId: 'm1',
    folders: ['C:/work'],
    createdAtMs: 0,
    updatedAtMs: 0,
  };
  const live = new Map<SlotId, string | null>([
    ['global', 's1'],
    [groupSlotId('g1'), 'm1'],
  ]);
  return { accounts: [shared, m1, m2], groups: [group], live };
}

describe('daemon folder-bound slots — startup and maintenance', () => {
  it('refreshes the snapshot once at startup and ensures every group live each cycle', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({ accounts, groups, live });
    const rig = await createRig({
      controls,
      bodyFor: () => ({
        limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }],
      }),
    });
    await rig.start();
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));

    expect(controls.refreshSnapshotCalls).toBe(1);
    expect(controls.ensureGroupLiveCalls).toContain('g1');
    expect(controls.checkSlotsCalls).toBeGreaterThanOrEqual(1);
  });

  it('repairs a slot invariant breach and alerts once per window on what survives', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const remaining: SlotViolation = {
      kind: 'broken_profile_link',
      detail: 'C:/work profile link to settings.json is broken',
      groupId: 'g1',
    };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      violations: [remaining],
      repair: { repaired: [], remaining: [remaining], actions: [] },
    });
    const rig = await createRig({
      controls,
      bodyFor: () => ({
        limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }],
      }),
      slotAlertWindowMs: 60 * 60_000,
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => slotAlerts(rig.relay).length > 0);

    expect(controls.repairSlotsCalls).toBeGreaterThanOrEqual(1);
    const alerts = slotAlerts(rig.relay);
    expect(alerts[0]?.body).toContain('broken_profile_link');
    // Let several more poll cycles run inside the window; the alert must not repeat.
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay)).toHaveLength(1);
  });
});

describe('daemon folder-bound slots — usage wire', () => {
  it('marks each reserved member with its group id, label, and live flag', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({ accounts, groups, live });
    const rig = await createRig({
      controls,
      bodyFor: () => ({
        limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }],
      }),
    });
    await rig.start();
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));

    const wire = lastUsageSnapshot(rig.relay);
    const byId = new Map(wire.accounts.map((a) => [a.accountId, a]));
    // Shared account: no group fields, and it is the global-active one.
    expect(byId.get('s1')?.groupId ?? null).toBeNull();
    expect(byId.get('s1')?.active).toBe(true);
    // Reserved members: group id + label; m1 is the live member, m2 is not; neither is `active`.
    expect(byId.get('m1')?.groupId).toBe('g1');
    expect(byId.get('m1')?.groupLabel).toBe('C:/work');
    expect(byId.get('m1')?.groupActive).toBe(true);
    expect(byId.get('m1')?.active).toBe(false);
    expect(byId.get('m2')?.groupActive ?? false).toBe(false);
    expect(byId.get('m2')?.active).toBe(false);
  });
});

describe('daemon folder-bound slots — per-slot auto-switch', () => {
  // The global-live shared account is nearly out of quota, so is m1 (the group's live member); each
  // slot has a healthy alternative of its own kind. Two hops must happen, each within its own slot.
  const bodyFor = (accountId: string): unknown => {
    const low = { limits: [{ kind: 'session', percent: 96, resets_at: iso(NOW + 2 * HOUR_MS) }] };
    const healthy = {
      limits: [{ kind: 'weekly_all', percent: 5, resets_at: iso(NOW + 2 * DAY_MS) }],
    };
    // s1 (global live) low; s2 healthy shared; m1 (group live) low; m2 healthy member.
    if (accountId === 's1' || accountId === 'm1') return low;
    return healthy;
  };

  it('hops the global slot within the shared pool and each group within its members', async () => {
    const m1 = view('m1', 'Member One', 'g1');
    const m2 = view('m2', 'Member Two', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const group: StoredGroup = {
      id: 'g1',
      label: 'C:/work',
      members: [m1, m2],
      activeId: 'm1',
      folders: ['C:/work'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({ accounts: [s1, s2, m1, m2], groups: [group], live });
    const rig = await createRig({ controls, bodyFor, withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => controls.activateCalls.length >= 2);

    const hopped = controls.activateCalls.map((c) => c.id).sort();
    // Global hopped to the healthy SHARED account (never a group member); the group hopped to its
    // own healthy member (never the shared pool).
    expect(hopped).toEqual(['m2', 's2']);
  });
});

describe('daemon folder-bound slots — group out of quota alert', () => {
  it('alerts once per window when a single-member group is exhausted', async () => {
    const only = view('m1', 'Member One', 'g1');
    const shared = view('s1', 'Shared');
    const group: StoredGroup = {
      id: 'g1',
      label: 'C:/solo',
      members: [only],
      activeId: 'm1',
      folders: ['C:/solo'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({ accounts: [shared, only], groups: [group], live });
    const bodyFor = (accountId: string): unknown =>
      accountId === 'm1'
        ? { limits: [{ kind: 'weekly_all', percent: 100, resets_at: iso(NOW + 3 * HOUR_MS) }] }
        : { limits: [{ kind: 'weekly_all', percent: 5, resets_at: iso(NOW + DAY_MS) }] };
    const rig = await createRig({
      controls,
      bodyFor,
      withAutoSwitcher: true,
      slotAlertWindowMs: 60 * 60_000,
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => slotAlerts(rig.relay).some((a) => a.body.includes('out of quota')));

    const exhaustion = slotAlerts(rig.relay).filter((a) => a.body.includes('out of quota'));
    expect(exhaustion).toHaveLength(1);
    expect(exhaustion[0]?.body).toContain('C:/solo');
    expect(exhaustion[0]?.body).toContain('Member One');
    // Several more cycles inside the window must not repeat the alert.
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay).filter((a) => a.body.includes('out of quota'))).toHaveLength(1);
  });
});
