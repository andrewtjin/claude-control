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
  refreshSnapshotIfStaleCalls: number;
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
  /** Bind a cwd to a group so a spawn resolves into a group slot (default: everything unbound). */
  cwdBinding?: (cwd: string) => { groupId: string } | null;
  /** The profile dir for a reserved account (default: `/profiles/<accountId>` for members). */
  configDirFor?: (accountId: string) => string | undefined;
  /** Override ensureGroupLive to model a group that cannot be made live (throws or no member). */
  ensureGroupLiveImpl?: (groupId: string) => Promise<GroupLiveResult>;
  /** Override checkSlots, e.g. to model a breach that the per-group self-heal clears. */
  checkSlotsImpl?: () => Promise<SlotViolation[]>;
  /** What refreshSnapshotIfStale reports (default: the snapshot was already fresh). */
  snapshotStale?: boolean;
}): FakeEngineControls {
  const controls: FakeEngineControls = {
    activateCalls: [],
    ensureGroupLiveCalls: [],
    refreshSnapshotCalls: 0,
    refreshSnapshotIfStaleCalls: 0,
    checkSlotsCalls: 0,
    repairSlotsCalls: 0,
    liveSlots: opts.live,
    engine: undefined as unknown as SwitchEngineLike,
  };
  const memberIds = new Set(opts.groups.flatMap((g) => g.members.map((m) => m.id)));
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
    // A reserved member's profile dir; undefined for a shared account. Overridable for the case
    // where a member exists but its profile cannot be prepared.
    configDirForAccount: (accountId: string): Promise<string | undefined> =>
      Promise.resolve(
        opts.configDirFor
          ? opts.configDirFor(accountId)
          : memberIds.has(accountId)
            ? `/profiles/${accountId}`
            : undefined,
      ),
    resolveCwdBinding: (cwd: string): Promise<{ groupId: string } | null> =>
      Promise.resolve(opts.cwdBinding ? opts.cwdBinding(cwd) : null),
    ensureGroupLive: (groupId: string): Promise<GroupLiveResult> => {
      controls.ensureGroupLiveCalls.push(groupId);
      if (opts.ensureGroupLiveImpl) return opts.ensureGroupLiveImpl(groupId);
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
      if (opts.checkSlotsImpl) return opts.checkSlotsImpl();
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
    refreshSnapshotIfStale: (): Promise<boolean> => {
      controls.refreshSnapshotIfStaleCalls++;
      return Promise.resolve(opts.snapshotStale === true);
    },
    reauthenticate: () => Promise.reject(new Error('unused')),
  };
  return controls;
}

function stubSessionManager(spawnCalls?: { count: number }): SessionManager {
  const records: SessionRecord[] = [];
  return {
    spawnManaged: () => {
      if (spawnCalls) spawnCalls.count++;
      return Promise.reject(new Error('unused'));
    },
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
  spawnCalls?: { count: number };
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
    sessionManager: stubSessionManager(opts.spawnCalls),
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

function switchResults(relay: SteadyRelay): Array<PayloadOf<'switch.result'>> {
  return relay.received
    .filter((e) => e.type === 'switch.result')
    .map((e) => (e.type === 'switch.result' ? e.payload : undefined))
    .filter((p): p is PayloadOf<'switch.result'> => p !== undefined);
}

function errorFrames(relay: SteadyRelay): Array<PayloadOf<'error'>> {
  return relay.received
    .filter((e) => e.type === 'error')
    .map((e) => (e.type === 'error' ? e.payload : undefined))
    .filter((p): p is PayloadOf<'error'> => p !== undefined);
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

  it('checks the guard snapshot for staleness every cycle, even with no slot breach', async () => {
    // A crash between a group write and its snapshot write leaves every slot legal, so the
    // check/repair path never runs; the per-cycle staleness check is what converges the snapshot.
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({ accounts, groups, live, snapshotStale: true });
    const rig = await createRig({
      controls,
      bodyFor: () => ({
        limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }],
      }),
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => countUsageSnapshots(rig.relay) >= 2);

    expect(controls.refreshSnapshotIfStaleCalls).toBeGreaterThanOrEqual(2);
    expect(controls.repairSlotsCalls).toBe(0);
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

  it('names the folder group on the phone notice for a GROUP hop (not a global switch)', async () => {
    // Regression: a group auto-switch pushed the same switch.result as a global one, so the phone
    // could not tell which folder rotated. The group hop's notice must name its bound folder; the
    // global hop's notice keeps its historical wording (no folder scope).
    const m1 = view('m1', 'Member One', 'g1');
    const m2 = view('m2', 'Member Two', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const group: StoredGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [m1, m2],
      activeId: 'm1',
      folders: ['C:/ai-research'],
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
    await waitFor(() => switchResults(rig.relay).length >= 2);

    const results = switchResults(rig.relay);
    // The group hop's notice names the bound folder and lands on the group's own member.
    const groupNotice = results.find((r) => r.activeAccountId === 'm2');
    expect(groupNotice?.message).toContain('(C:/ai-research)');
    // The global hop's notice does NOT carry a folder scope (it rotated the shared pool).
    const globalNotice = results.find((r) => r.activeAccountId === 's2');
    expect(globalNotice?.message).not.toContain('(C:/ai-research)');
    expect(globalNotice?.message).toContain('auto-switch:');
  });
});

describe('daemon folder-bound slots — a breach the self-heal clears is still surfaced', () => {
  it('alerts once when ensureGroupLive re-seats the group over a stranger before checkSlots runs', async () => {
    // ensureGroupLive re-activates a group's rightful member over whatever it finds in the profile,
    // so by the time the post-heal checkSlots runs, a stranger that was live there is already gone.
    // The breach seen BEFORE the heal must still reach the operator, exactly once per window.
    const { accounts, groups, live } = twoAccountGroup();
    const stranger: SlotViolation = {
      kind: 'nonmember_live_in_group',
      detail: 'non-member "Shared" is live in the C:/work group',
      accountId: 's1',
      groupId: 'g1',
    };
    let healed = false;
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      checkSlotsImpl: () => Promise.resolve(healed ? [] : [stranger]),
      ensureGroupLiveImpl: (groupId) => {
        healed = true;
        return Promise.resolve({
          groupId,
          liveMember: 'm1',
          activated: true,
          noWorkingAccount: false,
        });
      },
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
    await waitFor(() => slotAlerts(rig.relay).length >= 1);

    const body = slotAlerts(rig.relay)[0]?.body ?? '';
    expect(body).toContain('is live in the C:/work group');
    expect(body).toContain("cctl restored the folder group's own account");
    // Nothing was left for repairSlots, and later cycles (the breach is gone) add no alert.
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay)).toHaveLength(1);
    expect(controls.repairSlotsCalls).toBe(0);
  });

  it('does not alert on a profile link the self-heal re-linked (routine sync, not news)', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const brokenLink: SlotViolation = {
      kind: 'broken_profile_link',
      detail: 'profile of the C:/work group: settings.json is no longer linked to the main config',
      groupId: 'g1',
    };
    let healed = false;
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      checkSlotsImpl: () => Promise.resolve(healed ? [] : [brokenLink]),
      ensureGroupLiveImpl: (groupId) => {
        healed = true;
        return Promise.resolve({
          groupId,
          liveMember: 'm1',
          activated: false,
          noWorkingAccount: false,
        });
      },
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
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay)).toHaveLength(0);
  });
});

describe('daemon folder-bound slots — repair is surfaced to the operator', () => {
  it('alerts once per window naming what a repair moved, per repaired kind', async () => {
    // repairSlots silently moves credentials back where they belong (a reserved member that
    // surfaced in the shared slot, a stranger that surfaced in a profile). The operator must be
    // told a slot's account changed under them — one alert per repaired KIND per window.
    const { accounts, groups, live } = twoAccountGroup();
    const repairedGlobal: SlotViolation = {
      kind: 'reserved_live_in_global',
      detail: 'reserved account "Member One" is live in the global slot',
      accountId: 'm1',
      slot: 'global',
    };
    const repairedGroup: SlotViolation = {
      kind: 'nonmember_live_in_group',
      detail: 'non-member "Shared" is live in the C:/work group',
      accountId: 's1',
      groupId: 'g1',
    };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      violations: [repairedGlobal, repairedGroup],
      repair: {
        repaired: [repairedGlobal, repairedGroup],
        remaining: [],
        actions: ['moved the global slot off reserved "Member One" onto "Shared"'],
      },
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
    await waitFor(() => slotAlerts(rig.relay).length >= 2);

    const bodies = slotAlerts(rig.relay).map((a) => a.body);
    // One alert per repaired kind, each naming the offending account AND what cctl did about it.
    const globalAlert = bodies.find((b) => b.includes('is live in the global slot'));
    expect(globalAlert).toContain('cctl moved the shared slot back to a shared account');
    const groupAlert = bodies.find((b) => b.includes('is live in the C:/work group'));
    expect(groupAlert).toContain("cctl restored the folder group's own account");

    // Several more cycles inside the window must not repeat either alert.
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay)).toHaveLength(2);
  });
});

describe('daemon folder-bound slots — a spawn that cannot take its group slot is refused', () => {
  // A working directory that exists (so the bad-cwd guard passes) but is bound to a group that
  // cannot be placed. process.cwd() is a real directory on every runner.
  const boundCwd = process.cwd();

  it('refuses (not falls back to global) when the bound group has no working account', async () => {
    const { accounts, groups } = twoAccountGroup();
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), null],
    ]);
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
      // The group has no live member and none can be activated.
      ensureGroupLiveImpl: (groupId) =>
        Promise.resolve({ groupId, liveMember: null, activated: false, noWorkingAccount: true }),
    });
    const rig = await createRig({
      controls,
      bodyFor: () => ({ limits: [] }),
      spawnCalls,
    });
    await rig.start();
    rig.relay.push({
      daemonId: 'd',
      type: 'session.spawn',
      payload: { requestId: 'r-nowork', prompt: 'go', idempotencyKey: 'k', cwd: boundCwd },
    });
    await waitFor(() => errorFrames(rig.relay).some((e) => e.relatesTo !== undefined));

    const err = errorFrames(rig.relay)[0];
    expect(err?.code).toBe('spawn_failed');
    expect(err?.message).toContain('no working account');
    // The whole point: the session was NOT spawned on the global account as a fallback.
    expect(spawnCalls.count).toBe(0);
    expect(rig.relay.received.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('refuses (not falls back to global) when making the bound group live throws', async () => {
    const { accounts, groups } = twoAccountGroup();
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), 'm1'],
    ]);
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
      // A resolution fault (e.g. a profile write error) must become a refusal for a BOUND folder,
      // never a silent global fallback that spends the wrong account.
      ensureGroupLiveImpl: () => Promise.reject(new Error('profile write failed')),
    });
    const rig = await createRig({
      controls,
      bodyFor: () => ({ limits: [] }),
      spawnCalls,
    });
    await rig.start();
    rig.relay.push({
      daemonId: 'd',
      type: 'session.spawn',
      payload: { requestId: 'r-throw', prompt: 'go', idempotencyKey: 'k', cwd: boundCwd },
    });
    await waitFor(() => errorFrames(rig.relay).some((e) => e.relatesTo !== undefined));

    const err = errorFrames(rig.relay)[0];
    expect(err?.code).toBe('spawn_failed');
    expect(err?.message).toContain('could not be made live');
    expect(spawnCalls.count).toBe(0);
    expect(rig.relay.received.some((e) => e.type === 'session.status')).toBe(false);
  });
});

describe('daemon folder-bound slots — group out of quota alert', () => {
  it('alerts once per window and names the bound folder when a single-member group is exhausted', async () => {
    // The owner's real shape: one work account bound to a research folder. The group label defaults
    // to the joined member labels, so it EQUALS the member label here — the alert must name the
    // FOLDER (the actionable thing), not the label, or it would read "work@corp account work@corp".
    const only = view('m1', 'work@corp', 'g1');
    const shared = view('s1', 'Shared');
    const group: StoredGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [only],
      activeId: 'm1',
      folders: ['C:/ai-research'],
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
    // The bound folder is named (regression: the alert used to name the group label instead).
    expect(exhaustion[0]?.body).toContain('C:/ai-research account work@corp is out of quota');
    // The group label alone (would read "work@corp account work@corp") must not be what leads.
    expect(exhaustion[0]?.body).not.toContain('work@corp account work@corp');
    // Several more cycles inside the window must not repeat the alert.
    await waitFor(() => countUsageSnapshots(rig.relay) >= 3);
    expect(slotAlerts(rig.relay).filter((a) => a.body.includes('out of quota'))).toHaveLength(1);
  });

  it('alerts when the only spare member has headroom but is auto-switch-excluded', async () => {
    // The group's live member is out of quota; its one spare has headroom but the operator excluded
    // it from auto-switch. Auto-switch therefore cannot hop, so the exhaustion is terminal and must
    // be alerted. The alert's hop check must be the exact complement of the executor's candidate
    // gate — a plain "has headroom" test would see the spare and wrongly suppress the alert.
    const live = view('m1', 'work@corp', 'g1');
    const excludedSpare: AccountView = {
      ...view('m2', 'work@backup', 'g1'),
      autoSwitchExcluded: true,
    };
    const shared = view('s1', 'Shared');
    const group: StoredGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [live, excludedSpare],
      activeId: 'm1',
      folders: ['C:/ai-research'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const liveSlots = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({
      accounts: [shared, live, excludedSpare],
      groups: [group],
      live: liveSlots,
    });
    // m1 (live) fully spent; m2 (excluded spare) has ample headroom but is not an eligible target.
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
    expect(exhaustion.length).toBeGreaterThanOrEqual(1);
    expect(exhaustion[0]?.body).toContain('C:/ai-research account work@corp is out of quota');
    // The excluded spare is never chosen as a hop target, so no activation happened.
    expect(controls.activateCalls.map((c) => c.id)).not.toContain('m2');
  });

  it('names every bound folder when a multi-folder group is exhausted', async () => {
    // A group can hold several folders; the alert joins them so the operator sees all stalled slots.
    const only = view('m1', 'work@corp', 'g1');
    const shared = view('s1', 'Shared');
    const group: StoredGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [only],
      activeId: 'm1',
      folders: ['C:/ai-research', 'C:/experiments'],
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
    expect(exhaustion[0]?.body).toContain('C:/ai-research, C:/experiments');
  });
});

describe('daemon folder-bound slots — reauth resolves reserved members', () => {
  // The phone /reauth path must reach a folder-bound member. Reserved members live in the group
  // registry (listAllAccounts), not the shared-only account list (listAccounts) — resolving against
  // the shared list alone would report "No account matches" for exactly the accounts binding reserves.
  function reauthLink(relay: SteadyRelay, requestId: string): PayloadOf<'reauth.link'> | undefined {
    const frame = relay.received.find(
      (e) => e.type === 'reauth.link' && e.payload.requestId === requestId,
    );
    return frame?.type === 'reauth.link' ? frame.payload : undefined;
  }

  it('mints a link for a reserved member resolved by id and by label', async () => {
    const member = view('m1', 'work@corp', 'g1');
    const shared = view('s1', 'Shared');
    const group: StoredGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [member],
      activeId: 'm1',
      folders: ['C:/ai-research'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const liveSlots = new Map<SlotId, string | null>([
      ['global', 's1'],
      [groupSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({ accounts: [shared, member], groups: [group], live: liveSlots });
    // The reserved member is intentionally ABSENT from the shared-only list — this is the state that
    // made the shared-only resolution fail; the whole-fleet list is what must be consulted instead.
    expect((await controls.engine.listAccounts()).map((a) => a.id)).toEqual(['s1']);

    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }) });
    await rig.start();

    for (const [requestId, ref] of [
      ['rq-id', 'm1'],
      ['rq-label', 'work@corp'],
    ] as const) {
      rig.relay.push({
        daemonId: 'd',
        type: 'reauth.start',
        payload: { requestId, accountRef: ref, idempotencyKey: `ik-${requestId}` },
      });
      await waitFor(() => reauthLink(rig.relay, requestId) !== undefined);
      const link = reauthLink(rig.relay, requestId);
      expect(link?.ok).toBe(true);
      expect(link?.accountId).toBe('m1');
      expect(link?.url).toBeTruthy();
    }
  });
});
