// Folder-bound slots in the daemon poll cycle: the per-slot auto-switch over each slot's effective
// pool (global over the shared pool, each folder rule over its included accounts first, then the
// shared pool it inherits), the slot context carried onto the usage wire, the startup snapshot
// refresh, the per-cycle rule ensure-live + slot-invariant repair, and the once-per-episode alert a
// folder whose whole pool is out raises.
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
  ruleSlotId,
  type AccountView,
  type ActivateOptions,
  type ActivateResult,
  type FolderRule,
  type RuleLiveResult,
  type Logger,
  type RecoverResult,
  type RepairResult,
  type SlotId,
  type SlotViolation,
  type StoredAccount,
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
import type {
  BackgroundSession,
  BackgroundSessionHost,
  SessionActivity,
} from './backgroundMover.js';

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

function view(id: string, label: string, ruleId?: string): AccountView {
  return {
    id,
    label,
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...(ruleId !== undefined ? { ruleIds: [ruleId] } : {}),
  };
}

/** A folder's rule as the fixtures describe it: its included accounts as full rows, so a case can
 *  name labels and flags beside ids. The fake engine hands the daemon the {@link FolderRule} it
 *  stands for (include = the members' ids, in order; nothing excluded). */
interface TestGroup {
  id: string;
  label: string;
  members: AccountView[];
  activeId: string | null;
  folders: string[];
  createdAtMs: number;
  updatedAtMs: number;
  /** Shared accounts the folder must not use (default none). */
  exclude?: string[];
}

/** The rule a {@link TestGroup} fixture stands for. */
function ruleOf(g: TestGroup): FolderRule {
  return {
    id: g.id,
    label: g.label,
    folders: g.folders,
    include: g.members.map((m) => m.id),
    exclude: g.exclude ?? [],
    activeId: g.activeId,
    createdAtMs: g.createdAtMs,
    updatedAtMs: g.updatedAtMs,
  };
}

/** A rule-aware fake engine. Live slots are mutable so an activation is observable to the next
 *  liveSlots() read; checkSlots/repairSlots are stubbable per case. */
interface FakeEngineControls {
  engine: SwitchEngineLike;
  activateCalls: Array<{ id: string; options: ActivateOptions | undefined }>;
  ensureRuleLiveCalls: string[];
  refreshSnapshotCalls: number;
  refreshSnapshotIfStaleCalls: number;
  checkSlotsCalls: number;
  repairSlotsCalls: number;
  liveSlots: Map<SlotId, string | null>;
}

function fakeEngine(opts: {
  accounts: AccountView[];
  groups: TestGroup[];
  live: Map<SlotId, string | null>;
  violations?: SlotViolation[];
  repair?: RepairResult;
  /** Give a cwd a folder rule so a spawn resolves into its slot (default: no folder has one). */
  cwdBinding?: (cwd: string) => { groupId: string } | null;
  /** The profile dir for a reserved account (default: `/profiles/<accountId>` for members). */
  configDirFor?: (accountId: string) => string | undefined;
  /** Override ensureRuleLive to model a rule slot that cannot be made live (throws or no account). */
  ensureRuleLiveImpl?: (ruleId: string) => Promise<RuleLiveResult>;
  /** Override checkSlots, e.g. to model a breach that the per-group self-heal clears. */
  checkSlotsImpl?: () => Promise<SlotViolation[]>;
  /** What refreshSnapshotIfStale reports (default: the snapshot was already fresh). */
  snapshotStale?: boolean;
  /** Seat each activation in the slot it named, so the next cycle sees the hop (default: the live
   *  slots never move, as for a single-cycle case). */
  applyActivations?: boolean;
}): FakeEngineControls {
  const controls: FakeEngineControls = {
    activateCalls: [],
    ensureRuleLiveCalls: [],
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
    activate: (id: string, options?: ActivateOptions): Promise<ActivateResult> => {
      controls.activateCalls.push({ id, options });
      if (opts.applyActivations === true) controls.liveSlots.set(options?.slot ?? 'global', id);
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: (): Promise<StoredAccount[]> =>
      Promise.resolve(opts.accounts.filter((a) => a.ruleIds === undefined)),
    listAllAccounts: (): Promise<AccountView[]> => Promise.resolve(opts.accounts),
    listRules: (): Promise<FolderRule[]> => Promise.resolve(opts.groups.map(ruleOf)),
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
    // A rule slot's profile dir, as the background mover resumes a session under it.
    configDirForSlot: (slotId: SlotId): string | undefined =>
      slotId === 'global' ? undefined : `/profiles/${slotId}`,
    resolveFolderRule: (cwd: string): Promise<{ ruleId: string; folder: string } | null> => {
      const match = opts.cwdBinding ? opts.cwdBinding(cwd) : null;
      return Promise.resolve(match === null ? null : { ruleId: match.groupId, folder: cwd });
    },
    ensureRuleLive: (ruleId: string): Promise<RuleLiveResult> => {
      controls.ensureRuleLiveCalls.push(ruleId);
      if (opts.ensureRuleLiveImpl) return opts.ensureRuleLiveImpl(ruleId);
      const live = controls.liveSlots.get(ruleSlotId(ruleId)) ?? null;
      return Promise.resolve({
        ruleId,
        liveAccount: live,
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
  /** The poller, so a case that changes an account's numbers can have it re-read next cycle. */
  poller: UsagePoller;
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
  /** Run greedy auto-switch, with the plan phrased and gated the way the daemon's composition root
   *  sets the poller up for it. */
  greedy?: boolean;
  /** Claude Code's background service, for the cases about moving background sessions. */
  backgroundSessionHost?: BackgroundSessionHost;
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
    ...(opts.greedy === true
      ? {
          advisorOptions: {
            autoSwitchPolicy: { greedy: true },
            greedyAutoSwitch: true,
            now: () => NOW,
          },
        }
      : {}),
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
          ...(opts.greedy === true ? { policy: { greedy: true } } : {}),
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
    ...(opts.backgroundSessionHost !== undefined
      ? { backgroundSessionHost: opts.backgroundSessionHost }
      : {}),
  });

  cleanups.push(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  return { daemon, poller, relay, controls: opts.controls, start: () => daemon.start() };
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
  groups: TestGroup[];
  live: Map<SlotId, string | null>;
} {
  const m1 = view('m1', 'Member One', 'g1');
  const m2 = view('m2', 'Member Two', 'g1');
  const shared = view('s1', 'Shared');
  const group: TestGroup = {
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
    [ruleSlotId('g1'), 'm1'],
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
    expect(controls.ensureRuleLiveCalls).toContain('g1');
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
      ruleId: 'g1',
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
    const group: TestGroup = {
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
      [ruleSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({ accounts: [s1, s2, m1, m2], groups: [group], live });
    const rig = await createRig({ controls, bodyFor, withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => controls.activateCalls.length >= 2);

    const hopped = controls.activateCalls.map((c) => c.id).sort();
    // Global hopped to the healthy SHARED account (never a group member); the group hopped to its
    // own healthy member (never the shared pool).
    expect(hopped).toEqual(['m2', 's2']);
    // Each hop names the slot it was decided for, so a membership change that lands before the
    // switch reaches the engine lock refuses the hop instead of re-routing it to another slot.
    const slotOf = new Map(controls.activateCalls.map((c) => [c.id, c.options?.slot]));
    expect(slotOf.get('s2')).toBe('global');
    expect(slotOf.get('m2')).toBe(ruleSlotId('g1'));
  });

  it('names the folder group on the phone notice for a GROUP hop (not a global switch)', async () => {
    // Regression: a group auto-switch pushed the same switch.result as a global one, so the phone
    // could not tell which folder rotated. The group hop's notice must name its bound folder; the
    // global hop's notice keeps its historical wording (no folder scope).
    const m1 = view('m1', 'Member One', 'g1');
    const m2 = view('m2', 'Member Two', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const group: TestGroup = {
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
      [ruleSlotId('g1'), 'm1'],
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
  it('alerts once when ensureRuleLive re-seats the folder slot over a stranger before checkSlots runs', async () => {
    // ensureRuleLive re-seats a folder slot from its pool over whatever it finds in the profile,
    // so by the time the post-heal checkSlots runs, a stranger that was live there is already gone.
    // The breach seen BEFORE the heal must still reach the operator, exactly once per window.
    const { accounts, groups, live } = twoAccountGroup();
    const stranger: SlotViolation = {
      kind: 'outside_pool_live_in_rule',
      detail: '"Shared", which that folder excludes, is live in the folder slot of C:/work',
      accountId: 's1',
      ruleId: 'g1',
    };
    let healed = false;
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      checkSlotsImpl: () => Promise.resolve(healed ? [] : [stranger]),
      ensureRuleLiveImpl: (groupId) => {
        healed = true;
        return Promise.resolve({
          ruleId: groupId,
          liveAccount: 'm1',
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
    expect(body).toContain('is live in the folder slot of C:/work');
    expect(body).toContain('cctl moved the folder slot back onto an account its rule allows');
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
      ruleId: 'g1',
    };
    let healed = false;
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      checkSlotsImpl: () => Promise.resolve(healed ? [] : [brokenLink]),
      ensureRuleLiveImpl: (groupId) => {
        healed = true;
        return Promise.resolve({
          ruleId: groupId,
          liveAccount: 'm1',
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
      kind: 'outside_pool_live_in_rule',
      detail: '"Shared", which that folder excludes, is live in the folder slot of C:/work',
      accountId: 's1',
      ruleId: 'g1',
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
    const groupAlert = bodies.find((b) => b.includes('is live in the folder slot of C:/work'));
    expect(groupAlert).toContain('cctl moved the folder slot back onto an account its rule allows');

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
      [ruleSlotId('g1'), null],
    ]);
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
      // The group has no live member and none can be activated.
      ensureRuleLiveImpl: (groupId) =>
        Promise.resolve({
          ruleId: groupId,
          liveAccount: null,
          activated: false,
          noWorkingAccount: true,
        }),
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
    // The remedy names a command this build has.
    expect(err?.message).toContain('cctl folders');
    expect(err?.message).not.toContain('cctl bindings');
    // The whole point: the session was NOT spawned on the global account as a fallback.
    expect(spawnCalls.count).toBe(0);
    expect(rig.relay.received.some((e) => e.type === 'session.status')).toBe(false);
  });

  it('refuses (not falls back to global) when making the bound group live throws', async () => {
    const { accounts, groups } = twoAccountGroup();
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [ruleSlotId('g1'), 'm1'],
    ]);
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
      // A resolution fault (e.g. a profile write error) must become a refusal for a BOUND folder,
      // never a silent global fallback that spends the wrong account.
      ensureRuleLiveImpl: () => Promise.reject(new Error('profile write failed')),
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
    expect(err?.message).not.toContain('cctl bindings');
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
    const group: TestGroup = {
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
      [ruleSlotId('g1'), 'm1'],
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

  it('alerts when the only spare is an inherited account with headroom but auto-switch-excluded', async () => {
    // The folder's live account is out of quota; the one shared account it could fall back to has
    // headroom but the operator excluded it from auto-switch, and the global slot holds the other.
    // Auto-switch therefore cannot hop, so the alert must go out. The alert's hop check must be the
    // exact complement of the executor's candidate gate — a plain "has headroom" test would see the
    // spare and wrongly suppress the alert.
    const live = view('m1', 'work@corp', 'g1');
    const excludedSpare: AccountView = { ...view('s2', 'Spare'), autoSwitchExcluded: true };
    const shared = view('s1', 'Shared');
    const group: TestGroup = {
      id: 'g1',
      label: 'work@corp',
      members: [live],
      activeId: 'm1',
      folders: ['C:/ai-research'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const liveSlots = new Map<SlotId, string | null>([
      ['global', 's1'],
      [ruleSlotId('g1'), 'm1'],
    ]);
    const controls = fakeEngine({
      accounts: [shared, excludedSpare, live],
      groups: [group],
      live: liveSlots,
    });
    // m1 (live) fully spent; s2 (excluded spare) has ample headroom but is not an eligible target.
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
    expect(controls.activateCalls.map((c) => c.id)).not.toContain('s2');
  });

  it('names every bound folder when a multi-folder group is exhausted', async () => {
    // A group can hold several folders; the alert joins them so the operator sees all stalled slots.
    const only = view('m1', 'work@corp', 'g1');
    const shared = view('s1', 'Shared');
    const group: TestGroup = {
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
      [ruleSlotId('g1'), 'm1'],
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

describe('daemon folder-bound slots — a phone switch asserts the slot it resolved', () => {
  it('switches a reserved member in its group slot and names that slot to the engine', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({ accounts, groups, live });
    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }) });
    await rig.start();

    rig.relay.push({
      daemonId: 'd',
      type: 'switch.command',
      payload: {
        requestId: 'rq-member',
        targetAccountId: 'Member Two',
        reason: 'manual',
        idempotencyKey: 'ik-member',
      },
    });
    await waitFor(() => switchResults(rig.relay).some((r) => r.requestId === 'rq-member'));

    expect(controls.activateCalls).toEqual([
      { id: 'm2', options: { origin: 'phone', slot: ruleSlotId('g1') } },
    ]);
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
    const group: TestGroup = {
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
      [ruleSlotId('g1'), 'm1'],
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

describe('daemon folder rules — slots never share an account', () => {
  it('never hops the global slot onto a shared account live in a folder slot', async () => {
    // s2 is shared but live in the folder slot (an inherited account while the folder's own m1 is
    // out). It is the healthiest account, so only the "live elsewhere" filter keeps the global slot
    // from taking it — which would put one login live in two slots.
    const m1 = view('m1', 'Member One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const s3 = view('s3', 'Shared Three');
    const group: TestGroup = {
      id: 'g1',
      label: 'C:/work',
      members: [m1],
      activeId: 's2',
      folders: ['C:/work'],
      createdAtMs: 0,
      updatedAtMs: 0,
    };
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [ruleSlotId('g1'), 's2'],
    ]);
    const controls = fakeEngine({ accounts: [s1, s2, s3, m1], groups: [group], live });
    const bodyFor = (accountId: string): unknown => {
      if (accountId === 's1' || accountId === 'm1') {
        return { limits: [{ kind: 'session', percent: 96, resets_at: iso(NOW + 2 * HOUR_MS) }] };
      }
      const percent = accountId === 's2' ? 1 : 30;
      return { limits: [{ kind: 'weekly_all', percent, resets_at: iso(NOW + 2 * DAY_MS) }] };
    };
    const rig = await createRig({ controls, bodyFor, withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => controls.activateCalls.some((c) => c.options?.slot === 'global'));

    const globalHops = controls.activateCalls.filter((c) => c.options?.slot === 'global');
    expect(globalHops.map((c) => c.id)).toEqual(['s3']);
  });

  it('tags an account two rules include with the rule whose slot it is live in', async () => {
    const shared = view('s1', 'Shared');
    const both: AccountView = { ...view('m1', 'Member One'), ruleIds: ['g1', 'g2'] };
    const rule = (id: string, folder: string): TestGroup => ({
      id,
      label: folder,
      members: [both],
      activeId: id === 'g2' ? 'm1' : null,
      folders: [folder],
      createdAtMs: 0,
      updatedAtMs: 0,
    });
    const live = new Map<SlotId, string | null>([
      ['global', 's1'],
      [ruleSlotId('g1'), null],
      [ruleSlotId('g2'), 'm1'],
    ]);
    const controls = fakeEngine({
      accounts: [shared, both],
      groups: [rule('g1', 'C:/one'), rule('g2', 'C:/two')],
      live,
    });
    const rig = await createRig({
      controls,
      bodyFor: () => ({
        limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }],
      }),
    });
    await rig.start();
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));

    const m1 = lastUsageSnapshot(rig.relay).accounts.find((a) => a.accountId === 'm1');
    expect(m1?.groupId).toBe('g2');
    expect(m1?.groupLabel).toBe('C:/two');
    expect(m1?.groupActive).toBe(true);
  });

  it('a phone switch of an account two rules include, live in neither, names no slot', async () => {
    // There is no single slot to assert; the engine then refuses it as ambiguous rather than the
    // daemon picking a folder for the operator.
    const shared = view('s1', 'Shared');
    const both: AccountView = { ...view('m1', 'Member One'), ruleIds: ['g1', 'g2'] };
    const rule = (id: string, folder: string): TestGroup => ({
      id,
      label: folder,
      members: [both],
      activeId: null,
      folders: [folder],
      createdAtMs: 0,
      updatedAtMs: 0,
    });
    const live = new Map<SlotId, string | null>([['global', 's1']]);
    const controls = fakeEngine({
      accounts: [shared, both],
      groups: [rule('g1', 'C:/one'), rule('g2', 'C:/two')],
      live,
    });
    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }) });
    await rig.start();

    rig.relay.push({
      daemonId: 'd',
      type: 'switch.command',
      payload: {
        requestId: 'rq-both',
        targetAccountId: 'Member One',
        reason: 'manual',
        idempotencyKey: 'ik-both',
      },
    });
    await waitFor(() => switchResults(rig.relay).some((r) => r.requestId === 'rq-both'));
    expect(controls.activateCalls).toEqual([{ id: 'm1', options: { origin: 'phone' } }]);
  });
});

// ---- per-slot switching over the effective pool ------------------------------------------------

/** A folder rule fixture: its included accounts, its live account and what it excludes. */
function folderRule(
  id: string,
  folder: string,
  members: AccountView[],
  activeId: string | null,
  exclude: string[] = [],
): TestGroup {
  return {
    id,
    label: folder,
    members,
    activeId,
    folders: [folder],
    createdAtMs: 0,
    updatedAtMs: 0,
    exclude,
  };
}

/** Endpoint bodies by name: `low` is past the 94% trigger but not spent, `spent` is at the wall,
 *  `healthy(reset)` has a weekly reset `reset` hours out and plenty left. */
const LOW = { limits: [{ kind: 'session', percent: 96, resets_at: iso(NOW + 2 * HOUR_MS) }] };
const SPENT = { limits: [{ kind: 'weekly_all', percent: 100, resets_at: iso(NOW + 3 * HOUR_MS) }] };
const healthyIn = (hours: number, percent = 10): unknown => ({
  limits: [{ kind: 'weekly_all', percent, resets_at: iso(NOW + hours * HOUR_MS) }],
});

/** The hops one slot made, in order. */
const hopsIn = (controls: FakeEngineControls, slot: SlotId): string[] =>
  controls.activateCalls.filter((c) => c.options?.slot === slot).map((c) => c.id);

/** Let a few more poll cycles run (and their frames cross the socket). */
async function cycles(rig: Rig, n: number): Promise<void> {
  const target = countUsageSnapshots(rig.relay) + n;
  await waitFor(() => countUsageSnapshots(rig.relay) >= target);
}

describe('folder rules — per-slot auto-switch over the effective pool', () => {
  it('rotates to another included account before any inherited one, however soon that resets', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const m2 = view('m2', 'Inc Two', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2, m1, m2],
      groups: [folderRule('g1', 'C:/work', [m1, m2], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
    });
    const bodies: Record<string, unknown> = {
      s1: healthyIn(30),
      s2: healthyIn(2),
      m1: LOW,
      m2: healthyIn(100),
    };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['m2']);
  });

  it('falls back to a free inherited account only when every included account is out', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const s3 = view('s3', 'Shared Three');
    const controls = fakeEngine({
      accounts: [s1, s2, s3, m1],
      // s3 is excluded by the folder: never its target, however healthy.
      groups: [folderRule('g1', 'C:/work', [m1], 'm1', ['s3'])],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
    });
    const bodies: Record<string, unknown> = {
      s1: healthyIn(30),
      s2: healthyIn(50),
      s3: healthyIn(1),
      m1: LOW,
    };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    // s1 is live in the global slot, s3 is excluded: s2 is the one fallback.
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s2']);
    expect(hopsIn(controls, 'global')).toEqual([]);
  });

  it('returns to the included account once it can take work again, with the reason on the notice', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
      applyActivations: true,
    });
    const bodies: Record<string, unknown> = { s1: healthyIn(30), s2: healthyIn(50), m1: LOW };
    const rig = await createRig({
      controls,
      bodyFor: (id) => bodies[id],
      withAutoSwitcher: true,
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s2']);

    // Still out: the slot stays on the inherited account.
    await cycles(rig, 2);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s2']);

    // m1's window resets: back to it, though s2 is perfectly healthy.
    bodies.m1 = healthyIn(80);
    rig.poller.repollNow('m1');
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 2);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s2', 'm1']);
    await waitFor(() => switchResults(rig.relay).some((r) => r.activeAccountId === 'm1'));
    const notice = switchResults(rig.relay).find((r) => r.activeAccountId === 'm1');
    expect(notice?.message).toContain('auto-switch (C:/work): Inc One can take work again');
    // And it stays there: no ping-pong.
    await cycles(rig, 2);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s2', 'm1']);
  });

  it('an included account is a target even when excluded globally; an inherited excluded one is not', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const m2: AccountView = { ...view('m2', 'Inc Two', 'g1'), autoSwitchExcluded: true };
    const s1 = view('s1', 'Shared One');
    const s2: AccountView = { ...view('s2', 'Shared Two'), autoSwitchExcluded: true };
    const controls = fakeEngine({
      accounts: [s1, s2, m1, m2],
      groups: [folderRule('g1', 'C:/work', [m1, m2], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
      applyActivations: true,
    });
    const bodies: Record<string, unknown> = {
      s1: healthyIn(30),
      s2: healthyIn(1),
      m1: LOW,
      m2: healthyIn(100),
    };
    const rig = await createRig({
      controls,
      bodyFor: (id) => bodies[id],
      withAutoSwitcher: true,
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['m2']);

    // Now m2 runs low too: the only inherited account left is excluded, so the slot stays.
    bodies.m2 = LOW;
    rig.poller.repollNow('m2');
    await cycles(rig, 3);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['m2']);
  });

  it('never takes an account live in another slot, included or inherited', async () => {
    // e1 is included by both folders and live in the second; s2 is live in the third as its
    // fallback. The free s3 is the only legal target, though both others reset far sooner.
    const e1: AccountView = { ...view('e1', 'Both'), ruleIds: ['g1', 'g2'] };
    const m1 = view('m1', 'Inc One', 'g1');
    const m3 = view('m3', 'Inc Three', 'g3');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const s3 = view('s3', 'Shared Three');
    const controls = fakeEngine({
      accounts: [s1, s2, s3, m1, e1, m3],
      groups: [
        folderRule('g1', 'C:/one', [m1, e1], 'm1'),
        folderRule('g2', 'C:/two', [e1], 'e1'),
        folderRule('g3', 'C:/three', [m3], 's2'),
      ],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
        [ruleSlotId('g2'), 'e1'],
        [ruleSlotId('g3'), 's2'],
      ]),
    });
    const bodies: Record<string, unknown> = {
      s1: healthyIn(30),
      s2: healthyIn(2),
      s3: healthyIn(60),
      m1: LOW,
      e1: healthyIn(1),
      m3: SPENT,
    };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['s3']);
  });

  it('under contention the global slot takes the last free shared account and the folder waits', async () => {
    // Both the global slot and the folder (in fallback) want out; s2 is the one free account.
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
      applyActivations: true,
    });
    const bodies: Record<string, unknown> = { s1: LOW, s2: healthyIn(50), m1: SPENT };
    const rig = await createRig({
      controls,
      bodyFor: (id) => bodies[id],
      withAutoSwitcher: true,
      slotAlertWindowMs: 60 * 60_000,
      pollIntervalMs: 25,
    });
    await rig.start();
    await waitFor(() => hopsIn(controls, 'global').length >= 1);
    await cycles(rig, 2);
    expect(hopsIn(controls, 'global')).toEqual(['s2']);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual([]);
    // The folder is told it waits, by name.
    const alerts = slotAlerts(rig.relay).filter((a) => a.body.startsWith('C:/work'));
    expect(alerts).toHaveLength(1);
    expect(alerts[0]?.body).toContain('nothing else in its pool is free to take over');
  });

  it('alerts once per episode when a folder whole pool is out, and again on the next episode', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const controls = fakeEngine({
      accounts: [s1, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
    });
    const bodies: Record<string, unknown> = { s1: healthyIn(30), m1: SPENT };
    // A short window: a per-window alert would repeat here, a per-episode one must not.
    const rig = await createRig({
      controls,
      bodyFor: (id) => bodies[id],
      withAutoSwitcher: true,
      slotAlertWindowMs: 1,
      pollIntervalMs: 25,
    });
    const poolOut = () => slotAlerts(rig.relay).filter((a) => a.body.includes('out of quota'));
    await rig.start();
    await waitFor(() => poolOut().length >= 1);
    await cycles(rig, 3);
    expect(poolOut()).toHaveLength(1);

    // m1 comes back: the episode is over, nothing new is said.
    bodies.m1 = healthyIn(80);
    rig.poller.repollNow('m1');
    await cycles(rig, 3);
    expect(poolOut()).toHaveLength(1);

    // And runs out again: a new episode, a new alert.
    bodies.m1 = SPENT;
    rig.poller.repollNow('m1');
    await waitFor(() => poolOut().length >= 2);
    await cycles(rig, 2);
    expect(poolOut()).toHaveLength(2);
  });

  it('a folder with no working account is alerted on once per episode too', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    let working = false;
    const controls = fakeEngine({
      accounts: [s1, m1],
      groups: [folderRule('g1', 'C:/work', [m1], null)],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), null],
      ]),
      ensureRuleLiveImpl: (ruleId) =>
        Promise.resolve({
          ruleId,
          liveAccount: working ? 'm1' : null,
          activated: false,
          noWorkingAccount: !working,
        }),
    });
    const rig = await createRig({
      controls,
      bodyFor: () => healthyIn(30),
      slotAlertWindowMs: 1,
      pollIntervalMs: 25,
    });
    const noAccount = () =>
      slotAlerts(rig.relay).filter((a) => a.body.includes('has no working account'));
    await rig.start();
    await waitFor(() => noAccount().length >= 1);
    await cycles(rig, 3);
    expect(noAccount()).toHaveLength(1);
    expect(noAccount()[0]?.body.startsWith('C:/work has no working account')).toBe(true);
    working = true;
    await cycles(rig, 2);
    working = false;
    await waitFor(() => noAccount().length >= 2);
  });

  it('carries where each account is live and every rule including it on the usage wire', async () => {
    const e1: AccountView = { ...view('e1', 'Both'), ruleIds: ['g1', 'g2'] };
    const m3 = view('m3', 'Inc Three', 'g3');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2, e1, m3],
      groups: [
        folderRule('g1', 'C:/one', [e1], null),
        folderRule('g2', 'C:/two', [e1], 'e1'),
        folderRule('g3', 'C:/three', [m3], 's2'),
      ],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), null],
        [ruleSlotId('g2'), 'e1'],
        [ruleSlotId('g3'), 's2'],
      ]),
    });
    const rig = await createRig({ controls, bodyFor: () => healthyIn(30) });
    await rig.start();
    await waitFor(() => countUsageSnapshots(rig.relay) >= 1);
    const byId = new Map(lastUsageSnapshot(rig.relay).accounts.map((a) => [a.accountId, a]));
    // A shared account live in a folder slot (that folder's fallback) says so, and stays shared.
    expect(byId.get('s2')).toMatchObject({ liveSlot: ruleSlotId('g3'), liveSlotLabel: 'C:/three' });
    expect(byId.get('s2')?.groupId ?? undefined).toBeUndefined();
    // The global slot's account carries its slot, with no folder label.
    expect(byId.get('s1')?.liveSlot).toBe('global');
    expect(byId.get('s1')?.liveSlotLabel ?? undefined).toBeUndefined();
    // A shared account two rules include lists both, and the legacy fields name the live one.
    expect(byId.get('e1')).toMatchObject({
      ruleIds: ['g1', 'g2'],
      liveSlot: ruleSlotId('g2'),
      liveSlotLabel: 'C:/two',
      groupId: 'g2',
      groupActive: true,
    });
    // An included account live nowhere carries no live slot.
    expect(byId.get('m3')?.liveSlot ?? undefined).toBeUndefined();
    expect(byId.get('m3')?.ruleIds).toEqual(['g3']);
  });
});

describe('folder rules — the plan on the phone is the one for the global slot', () => {
  it('never announces a greedy hop to an account reserved to a folder or live in a folder slot', async () => {
    // m1 is reserved to the folder and s2 is shared but live in its slot as a fallback; both
    // expire far sooner than s3, so a fleet-wide greedy plan would burn them as s1 runs low.
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const s3 = view('s3', 'Shared Three');
    const controls = fakeEngine({
      accounts: [s1, s2, s3, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 's2')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 's2'],
      ]),
    });
    const bodies: Record<string, unknown> = {
      s1: LOW,
      s2: healthyIn(2),
      s3: healthyIn(50),
      m1: healthyIn(1),
    };
    const rig = await createRig({
      controls,
      bodyFor: (id) => bodies[id],
      withAutoSwitcher: true,
      greedy: true,
    });
    await rig.start();
    await waitFor(() => countUsageSnapshots(rig.relay) >= 1);
    const plan = lastUsageSnapshot(rig.relay).plan;
    expect(plan?.recommendedAccountId).toBe('s3');
    expect(plan?.reason).not.toContain('Inc One');
    expect(plan?.reason).not.toContain('Shared Two');
    // And the executor agrees with it.
    await waitFor(() => hopsIn(controls, 'global').length >= 1);
    expect(hopsIn(controls, 'global')).toEqual(['s3']);
  });
});

describe('folder rules — the pool-out alert names the reset that ends the wait', () => {
  it('says the 5-hour window when that is the wall, not the weekly reset days out', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const controls = fakeEngine({
      accounts: [s1, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 'm1')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 'm1'],
      ]),
    });
    const bodies: Record<string, unknown> = {
      s1: healthyIn(30),
      m1: {
        limits: [
          { kind: 'session', percent: 100, resets_at: iso(NOW + 2 * HOUR_MS) },
          { kind: 'weekly_all', percent: 20, resets_at: iso(NOW + 100 * HOUR_MS) },
        ],
      },
    };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => slotAlerts(rig.relay).some((a) => a.body.includes('out of quota')));
    const alert = slotAlerts(rig.relay).find((a) => a.body.includes('out of quota'));
    expect(alert?.body).toContain('C:/work account Inc One is out of quota until it resets in 2h');
  });
});

describe('folder rules — a phone switch to a shared account live in a folder slot', () => {
  it('switches it in that slot, so the folder sessions parked on a usage limit resume', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 's2')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 's2'],
      ]),
    });
    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }) });
    await rig.start();

    rig.relay.push({
      daemonId: 'd',
      type: 'switch.command',
      payload: {
        requestId: 'rq-fallback',
        targetAccountId: 'Shared Two',
        reason: 'manual',
        idempotencyKey: 'ik-fallback',
      },
    });
    await waitFor(() => switchResults(rig.relay).some((r) => r.requestId === 'rq-fallback'));
    expect(controls.activateCalls).toEqual([
      { id: 's2', options: { origin: 'phone', slot: ruleSlotId('g1') } },
    ]);
  });
});

describe('folder rules — a slot moves off a live account its pool leaves out', () => {
  it('hops the global slot off a quarantined, spent account', async () => {
    const s1: AccountView = { ...view('s1', 'Shared One'), quarantined: true };
    const s2 = view('s2', 'Shared Two');
    const controls = fakeEngine({
      accounts: [s1, s2],
      groups: [],
      live: new Map<SlotId, string | null>([['global', 's1']]),
    });
    const bodies: Record<string, unknown> = { s1: SPENT, s2: healthyIn(50) };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => hopsIn(controls, 'global').length >= 1);
    expect(hopsIn(controls, 'global')).toEqual(['s2']);
  });

  it('hops a folder slot off a spent account the folder excludes, onto an included one', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s3 = view('s3', 'Shared Three');
    const controls = fakeEngine({
      accounts: [s1, s3, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 's3', ['s3'])],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 's3'],
      ]),
    });
    const bodies: Record<string, unknown> = { s1: healthyIn(30), s3: SPENT, m1: healthyIn(50) };
    const rig = await createRig({ controls, bodyFor: (id) => bodies[id], withAutoSwitcher: true });
    await rig.start();
    await waitFor(() => hopsIn(controls, ruleSlotId('g1')).length >= 1);
    expect(hopsIn(controls, ruleSlotId('g1'))).toEqual(['m1']);
  });
});

describe('folder rules — a spawn naming a shared account live in its folder slot', () => {
  const boundCwd = process.cwd();

  it('runs in that folder slot rather than refusing it as not the global account', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts: [s1, s2, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 's2')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 's2'],
      ]),
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
      // The folder slot's profile, where s2 is live.
      configDirFor: (id) => (id === 'm1' || id === 's2' ? '/profiles/g1' : undefined),
    });
    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }), spawnCalls });
    await rig.start();
    rig.relay.push({
      daemonId: 'd',
      type: 'session.spawn',
      payload: {
        requestId: 'r-s2',
        prompt: 'go',
        idempotencyKey: 'k-s2',
        cwd: boundCwd,
        accountId: 's2',
      },
    });
    await waitFor(() => spawnCalls.count > 0 || errorFrames(rig.relay).length > 0);
    expect(
      errorFrames(rig.relay)
        .map((e) => e.message)
        .join(),
    ).not.toContain('not the live global account');
    expect(spawnCalls.count).toBe(1);
  });

  it('refuses a shared account live in neither slot, naming the slots it may run in', async () => {
    const m1 = view('m1', 'Inc One', 'g1');
    const s1 = view('s1', 'Shared One');
    const s2 = view('s2', 'Shared Two');
    const s3 = view('s3', 'Shared Three');
    const spawnCalls = { count: 0 };
    const controls = fakeEngine({
      accounts: [s1, s2, s3, m1],
      groups: [folderRule('g1', 'C:/work', [m1], 's2')],
      live: new Map<SlotId, string | null>([
        ['global', 's1'],
        [ruleSlotId('g1'), 's2'],
      ]),
      cwdBinding: (cwd) => (cwd === boundCwd ? { groupId: 'g1' } : null),
    });
    const rig = await createRig({ controls, bodyFor: () => ({ limits: [] }), spawnCalls });
    await rig.start();
    rig.relay.push({
      daemonId: 'd',
      type: 'session.spawn',
      payload: {
        requestId: 'r-s3',
        prompt: 'go',
        idempotencyKey: 'k-s3',
        cwd: boundCwd,
        accountId: 's3',
      },
    });
    await waitFor(() => errorFrames(rig.relay).some((e) => e.relatesTo !== undefined));
    const err = errorFrames(rig.relay)[0];
    expect(err?.code).toBe('spawn_failed');
    expect(err?.message).toContain('Shared Three');
    expect(err?.message).not.toContain('bound folder');
    expect(spawnCalls.count).toBe(0);
  });
});

describe('daemon folder-bound slots — background sessions move onto their folder slot', () => {
  const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
  const HEALTHY = { limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + DAY_MS) }] };
  const OUT = { limits: [{ kind: 'weekly_all', percent: 100, resets_at: iso(NOW + 3 * HOUR_MS) }] };

  /** A Claude Code service on the global slot hosting one idle background session in `cwd`; a
   *  resume moves it to the named config dir. Records every command. */
  function recordingHost(cwd: string): { host: BackgroundSessionHost; calls: string[] } {
    const calls: string[] = [];
    const hosted = new Map<string | null, BackgroundSession[]>([
      [null, [{ short: SID.slice(0, 8), sessionId: SID, cwd }]],
    ]);
    const host: BackgroundSessionHost = {
      listHosted: (configDir) => {
        calls.push(`list ${String(configDir)}`);
        return Promise.resolve([...(hosted.get(configDir) ?? [])]);
      },
      activity: (configDir) => {
        calls.push(`activity ${String(configDir)}`);
        return Promise.resolve(
          new Map<string, SessionActivity>([[SID.slice(0, 8), { idle: true, name: 'pods' }]]),
        );
      },
      stop: (configDir, short) => {
        calls.push(`stop ${String(configDir)} ${short}`);
        hosted.set(configDir, []);
        return Promise.resolve();
      },
      savedOptions: () => Promise.resolve(['--model', 'opus']),
      resumeIdle: (input) => {
        calls.push(`resume ${String(input.configDir)} ${input.sessionId}`);
        hosted.set(input.configDir, [
          { short: input.short, sessionId: input.sessionId, cwd: input.cwd },
        ]);
        return Promise.resolve();
      },
    };
    return { host, calls };
  }

  function movedNotices(relay: SteadyRelay): Array<PayloadOf<'hook.notification'>> {
    return relay.received
      .filter((e) => e.type === 'hook.notification')
      .map((e) => (e.type === 'hook.notification' ? e.payload : undefined))
      .filter(
        (p): p is PayloadOf<'hook.notification'> =>
          p !== undefined && p.notificationType === 'session_moved',
      );
  }

  it('moves an idle global-slot session in the folder once its included account is live and can take work', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd.startsWith('C:/work') ? { groupId: 'g1' } : null),
    });
    const { host, calls } = recordingHost('C:/work/app');
    const rig = await createRig({ controls, bodyFor: () => HEALTHY, backgroundSessionHost: host });
    await rig.start();
    await waitFor(() => movedNotices(rig.relay).length > 0);

    expect(calls).toContain('stop null 1ee43a2b');
    expect(calls).toContain(`resume /profiles/${ruleSlotId('g1')} ${SID}`);
    const [notice] = movedNotices(rig.relay);
    expect(notice?.level).toBe('info');
    expect(notice?.body).toContain('"pods" (1ee43a2b) in C:/work onto Member One');
  });

  it('leaves it alone while the included account live in the folder slot is out of usage', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd.startsWith('C:/work') ? { groupId: 'g1' } : null),
    });
    const { host, calls } = recordingHost('C:/work');
    const rig = await createRig({
      controls,
      bodyFor: (id) => (id === 'm1' ? OUT : HEALTHY),
      backgroundSessionHost: host,
    });
    await rig.start();
    await waitFor(() => countUsageSnapshots(rig.relay) >= 1);
    await new Promise((r) => setTimeout(r, 50));

    // No folder is ready, so Claude Code is not even asked.
    expect(calls).toEqual([]);
    expect(movedNotices(rig.relay)).toEqual([]);
  });

  it('leaves it alone while the folder slot runs on a shared account (its fallback)', async () => {
    const { accounts, groups } = twoAccountGroup();
    const live = new Map<SlotId, string | null>([
      ['global', null],
      [ruleSlotId('g1'), 's1'],
    ]);
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd.startsWith('C:/work') ? { groupId: 'g1' } : null),
    });
    const { host, calls } = recordingHost('C:/work');
    const rig = await createRig({ controls, bodyFor: () => HEALTHY, backgroundSessionHost: host });
    await rig.start();
    await waitFor(() => countUsageSnapshots(rig.relay) >= 1);
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual([]);
  });

  it('never moves a session out of a folder without a rule', async () => {
    const { accounts, groups, live } = twoAccountGroup();
    const controls = fakeEngine({
      accounts,
      groups,
      live,
      cwdBinding: (cwd) => (cwd.startsWith('C:/work') ? { groupId: 'g1' } : null),
    });
    const { host, calls } = recordingHost('C:/elsewhere');
    const rig = await createRig({ controls, bodyFor: () => HEALTHY, backgroundSessionHost: host });
    await rig.start();
    await waitFor(() => calls.includes('list null'));
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual(['list null']);
    expect(movedNotices(rig.relay)).toEqual([]);
  });
});
