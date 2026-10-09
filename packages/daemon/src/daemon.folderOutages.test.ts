// The exhaustion log per scope, driven through the real poll cycle: the global pool and each folder
// rule's pool keep their own episodes in the one file, an account live in another slot does not
// count as available to a scope (the global one included), the cards name the folder, a restart
// resumes every scope, lines written before scopes existed still read as the global pool's, and a
// folder's open episode is closed when its rule is removed.
//
// A real Daemon, UsagePoller, Store, AttributionJournal and ControlPlaneClient against a minimal
// relay, with a rule-aware fake engine whose registry and live slots each test moves between cycles.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ruleSlotId,
  type AccountView,
  type ActivateResult,
  type FolderRule,
  type Logger,
  type RecoverResult,
  type RuleLiveResult,
  type SlotId,
  type StoredAccount,
} from '@claude-control/switch-engine';
import type { SessionManager, SessionRecord } from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller, type FetchLikeResponse } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import { ControlPlaneClient, type DaemonIdentity } from './controlPlaneClient.js';
import { Daemon, type SwitchEngineLike } from './daemon.js';
import { TestRelay, waitFor as waitForWithin } from './testing/sessionDaemonHarness.js';
import {
  ExhaustionLog,
  scopeOf,
  type ExhaustedRecord,
  type ExhaustionRecord,
  type OutageScope,
  type RecoveredRecord,
} from './exhaustionLog.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

const waitFor = (predicate: () => boolean): Promise<void> => waitForWithin(predicate, 5000);
const settle = () => new Promise((r) => setTimeout(r, 60));

/** The exhaustion cards the phone received, in order. */
class CardRelay extends TestRelay {
  cards(): Array<{ type: string; title: string; body: string; level: string }> {
    return this.received.flatMap((e) =>
      e.type === 'hook.notification' &&
      (e.payload.notificationType === 'usage_exhausted' ||
        e.payload.notificationType === 'usage_restored')
        ? [
            {
              type: e.payload.notificationType,
              title: e.payload.title,
              body: e.payload.body,
              level: e.payload.level,
            },
          ]
        : [],
    );
  }
}

const view = (id: string, ruleIds?: string[]): AccountView => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...(ruleIds !== undefined ? { ruleIds } : {}),
});

const rule = (
  id: string,
  folder: string,
  include: string[],
  exclude: string[] = [],
): FolderRule => ({
  id,
  label: folder,
  folders: [folder],
  include,
  exclude,
  activeId: null,
  createdAtMs: 0,
  updatedAtMs: 0,
});

/** Endpoint bodies: spent until `resetsAt`, or free with a far reset. */
const spentUntil = (resetsAt: number) => ({
  limits: [
    { kind: 'session', percent: 100, resets_at: iso(resetsAt) },
    { kind: 'weekly_all', percent: 50, resets_at: iso(T0 + 90 * H) },
  ],
});
const free = () => ({
  limits: [
    { kind: 'session', percent: 10, resets_at: iso(T0 + 4 * H) },
    { kind: 'weekly_all', percent: 20, resets_at: iso(T0 + 90 * H) },
  ],
});

const RESEARCH: OutageScope = {
  kind: 'folder',
  ruleId: 'r1',
  folders: ['C:/research'],
  label: 'C:/research',
};

interface Rig {
  daemon: Daemon;
  relay: CardRelay;
  log: ExhaustionLog;
  bodies: Map<string, unknown>;
  /** The registry and live slots the engine reports; mutate between cycles. */
  registry: { accounts: AccountView[]; rules: FolderRule[]; live: Map<SlotId, string | null> };
  poller: UsagePoller;
  cycle: (at: number) => Promise<void>;
  stop: () => Promise<void>;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createRig(options: {
  registry: Rig['registry'];
  bodies: Record<string, unknown>;
  seedLog?: unknown[];
  logPath?: string;
  /** Rules whose slot the engine reports as having no working account. */
  noWorking?: string[];
}): Promise<Rig> {
  const relay = new CardRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-folder-outages-'));
  const clock = { now: T0 };
  const bodies = new Map(Object.entries(options.bodies));
  const registry = options.registry;
  const log = new ExhaustionLog(options.logPath ?? join(vaultDir, 'exhaustion-log.jsonl'));
  if (options.seedLog !== undefined) {
    await writeFile(log.path, options.seedLog.map((r) => JSON.stringify(r) + '\n').join(''));
  }

  const poller = new UsagePoller({
    fetch: (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            bodies.get((init.headers.authorization ?? '').replace('Bearer tok-', '')) ?? {},
          ),
      } satisfies FetchLikeResponse),
    getToken: (accountId: string) => Promise.resolve(`tok-${accountId}`),
    getCachedUsage: () => Promise.resolve(undefined),
    clock: () => clock.now,
    random: () => 0,
  });

  const switchEngine: SwitchEngineLike = {
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate: (id: string): Promise<ActivateResult> =>
      Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      }),
    listAccounts: (): Promise<StoredAccount[]> =>
      Promise.resolve(registry.accounts.filter((a) => a.ruleIds === undefined)),
    listAllAccounts: (): Promise<AccountView[]> => Promise.resolve([...registry.accounts]),
    listRules: (): Promise<FolderRule[]> => Promise.resolve([...registry.rules]),
    liveSlots: (): Promise<Map<SlotId, string | null>> => Promise.resolve(new Map(registry.live)),
    getActiveId: (slot: SlotId = 'global'): Promise<string | null> =>
      Promise.resolve(registry.live.get(slot) ?? null),
    ensureRuleLive: (ruleId: string): Promise<RuleLiveResult> =>
      Promise.resolve({
        ruleId,
        liveAccount: registry.live.get(ruleSlotId(ruleId)) ?? null,
        activated: false,
        noWorkingAccount: options.noWorking?.includes(ruleId) === true,
      }),
    reauthenticate: () => Promise.reject(new Error('not used in this test')),
  };
  const records: SessionRecord[] = [];
  const sessionManager: SessionManager = {
    spawnManaged: () => Promise.reject(new Error('not used in this test')),
    attachObserved: () => Promise.reject(new Error('not used in this test')),
    get: () => undefined,
    list: () => records,
    recover: () => Promise.resolve([]),
  };
  const identity: DaemonIdentity = { daemonId: 'daemon-under-test', daemonToken: 'tok' };
  const controlPlaneClient = new ControlPlaneClient({
    url: `ws://127.0.0.1:${relayPort}`,
    identityStore: { load: () => Promise.resolve(identity), save: () => Promise.resolve() },
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });
  const noop = (): void => {};
  const logger: Logger = { debug: noop, info: noop, warn: noop, error: noop };
  const daemon = new Daemon({
    store,
    switchEngine,
    sessionManager,
    poller,
    attributionJournal: new AttributionJournal({ store, vaultDir }),
    hookReceiver: new HookReceiver({
      store,
      secret: 'shh',
      emit: () => {},
      daemonId: () => 'daemon-under-test',
    }),
    controlPlaneClient,
    exhaustionLog: log,
    logger,
    clock: () => clock.now,
    pollIntervalMs: 100_000,
  });
  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    await daemon.stop().catch(() => {});
    await relay.close();
  };
  cleanups.push(async () => {
    await stop();
    await rm(vaultDir, { recursive: true, force: true });
  });
  const internals = daemon as unknown as {
    runPollCycle(): Promise<void>;
    pollCycleInFlight: boolean;
  };
  const cycle = async (at: number): Promise<void> => {
    await waitFor(() => !internals.pollCycleInFlight);
    clock.now = at;
    for (const id of bodies.keys()) poller.repollNow(id);
    await internals.runPollCycle();
  };
  await daemon.start();
  await waitFor(() => relay.received.some((e) => e.type === 'usage.snapshot'));
  // The start cycle sends its cards before it writes the file: let it finish, so a test reads the
  // file it wrote.
  await waitFor(() => !internals.pollCycleInFlight);
  return { daemon, relay, log, bodies, registry, poller, cycle, stop };
}

/** The file's records of the research folder's scope. */
const researchLines = async (log: ExhaustionLog): Promise<ExhaustionRecord[]> =>
  (await log.read()).filter((r) => scopeOf(r).kind === 'folder');

/** Shared A and B (A live globally); E included by the research folder, live in its slot. */
function researchFleet(): Rig['registry'] {
  return {
    accounts: [view('A'), view('B'), view('E', ['r1'])],
    rules: [rule('r1', 'C:/research', ['E'])],
    live: new Map<SlotId, string | null>([
      ['global', 'A'],
      [ruleSlotId('r1'), 'E'],
    ]),
  };
}

describe('per-scope outages through the poll cycle', () => {
  it('a folder out while the global pool works: one folder episode, cards naming the folder', async () => {
    // E is spent; B (spent) and A (free, but live in the global slot) are the inherited pool.
    const rig = await createRig({
      registry: researchFleet(),
      bodies: { A: free(), B: spentUntil(T0 + 3 * H), E: spentUntil(T0 + H) },
    });
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.relay.cards()[0]).toMatchObject({
      type: 'usage_exhausted',
      title: 'C:/research: every account in its pool is out',
    });
    expect(rig.relay.cards()[0]?.body).toContain("No account in C:/research's pool can take work.");
    expect(rig.relay.cards()[0]?.body).toContain('• A (live in the global slot)');
    const [start] = await rig.log.read();
    expect(start).toMatchObject({ v: 2, event: 'exhausted', scope: RESEARCH, active: 'E' });

    // E's window resets: the folder's episode ends, named.
    rig.bodies.set('E', free());
    await rig.cycle(T0 + H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    expect(rig.relay.cards()[1]).toMatchObject({
      type: 'usage_restored',
      title: 'Usage is back in C:/research',
    });
    const records = await rig.log.read();
    expect(records.map((r) => `${r.event}:${scopeOf(r).kind}`)).toEqual([
      'exhausted:folder',
      'recovered:folder',
    ]);
    expect((records[1] as RecoveredRecord).how).toBe('reset');
  });

  it('the global pool out while the folder still works', async () => {
    const rig = await createRig({
      registry: researchFleet(),
      bodies: { A: spentUntil(T0 + H), B: spentUntil(T0 + 2 * H), E: free() },
    });
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.relay.cards()[0]?.title).toBe('All accounts are out of usage');
    await rig.cycle(T0 + 10 * M);
    await settle();
    expect(rig.relay.cards()).toHaveLength(1);
    const records = await rig.log.read();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ v: 1, scope: { kind: 'global' } });
    // E is the folder's own and free: not in the global pool at all.
    expect((records[0] as ExhaustedRecord).accounts.map((a) => a.accountId)).toEqual(['A', 'B']);
  });

  it('the global pool does not count a shared account live in a folder slot', async () => {
    // B is free but live in the research slot as its fallback (E spent): the global pool is out.
    const registry = researchFleet();
    registry.live.set(ruleSlotId('r1'), 'B');
    const rig = await createRig({
      registry,
      bodies: { A: spentUntil(T0 + H), B: free(), E: spentUntil(T0 + 5 * H) },
    });
    await waitFor(() => rig.relay.cards().length >= 1);
    const global = rig.relay.cards().find((c) => c.title === 'All accounts are out of usage');
    expect(global?.body).toContain('• B (live in the slot of C:/research)');
    // The folder holds B and B can work: the folder is not out.
    expect(rig.relay.cards().some((c) => c.title.startsWith('C:/research'))).toBe(false);

    // E resets and the folder returns to it, letting B go: the global pool's outage ends, released.
    rig.registry.live.set(ruleSlotId('r1'), 'E');
    rig.bodies.set('E', free());
    await rig.cycle(T0 + 10 * M);
    await waitFor(() => rig.relay.cards().length >= 2);
    const end = (await rig.log.read()).find((r) => r.event === 'recovered') as RecoveredRecord;
    expect(end).toMatchObject({ how: 'released', account: { accountId: 'B' } });
    expect(end.summary).toContain('another slot let it go');
  });

  it('an account taken by another slot mid-outage is filed as a walls line of that scope', async () => {
    // The folder is out: E and B spent, A free but held by the global slot.
    const rig = await createRig({
      registry: researchFleet(),
      bodies: { A: free(), B: spentUntil(T0 + 4 * H), E: spentUntil(T0 + 5 * H) },
    });
    await waitFor(() => rig.relay.cards().length === 1);
    // The global slot moves from A (now spent) to B (its window reset): B is free but held, A is
    // free of the global slot but spent. The folder stays out, and both changes are filed.
    rig.registry.live.set('global', 'B');
    rig.bodies.set('A', spentUntil(T0 + 6 * H));
    rig.bodies.set('B', free());
    await rig.cycle(T0 + 20 * M);
    await settle();
    const walls = (await researchLines(rig.log)).filter((r) => r.event === 'walls');
    expect(walls.map((w) => (w.event === 'walls' ? `${w.accountId}:${w.reason}` : ''))).toEqual(
      expect.arrayContaining(['B:live_elsewhere', 'A:session']),
    );
    for (const w of walls) expect(w).toMatchObject({ v: 2, scope: RESEARCH });
    expect(rig.relay.cards()).toHaveLength(1);
  });

  it('a rule removed while its folder is out closes the episode as removed, with an info card', async () => {
    const rig = await createRig({
      registry: researchFleet(),
      bodies: { A: free(), B: spentUntil(T0 + 3 * H), E: spentUntil(T0 + 5 * H) },
    });
    await waitFor(() => rig.relay.cards().length === 1);
    // The rule goes; E is shared again.
    rig.registry.rules = [];
    rig.registry.accounts = [view('A'), view('B'), view('E')];
    rig.registry.live.delete(ruleSlotId('r1'));
    await rig.cycle(T0 + 30 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    expect(rig.relay.cards()[1]).toMatchObject({
      type: 'usage_restored',
      title: 'C:/research: folder rule removed',
      level: 'info',
    });
    const end = (await rig.log.read()).at(-1) as RecoveredRecord;
    expect(end).toMatchObject({ how: 'rule_removed', scope: RESEARCH, durationMs: 30 * M });
    expect(end.account).toBeUndefined();
    // Nothing more: the folder has no scope left to judge.
    await rig.cycle(T0 + 40 * M);
    await settle();
    expect(rig.relay.cards()).toHaveLength(2);
  });
});

describe('per-scope outages across a restart', () => {
  const folderStart = {
    v: 2,
    event: 'exhausted',
    id: `ep-${T0 - H}-r1`,
    scope: RESEARCH,
    at: T0 - H,
    time: iso(T0 - H),
    summary: 's',
    active: 'E',
    accounts: [
      {
        accountId: 'E',
        label: 'E',
        reason: 'session',
        spent: [{ kind: 'session', percent: 100, resetsAt: T0 + 2 * H }],
      },
      {
        accountId: 'A',
        label: 'A',
        reason: 'session',
        spent: [{ kind: 'session', percent: 100, resetsAt: T0 + H }],
      },
      {
        accountId: 'B',
        label: 'B',
        reason: 'session',
        spent: [{ kind: 'session', percent: 100, resetsAt: T0 + 3 * H }],
      },
    ],
    switches: [],
  };
  // A line written before scopes existed: no scope, version 1.
  const legacyGlobalStart = {
    v: 1,
    event: 'exhausted',
    id: `ep-${T0 - 2 * H}`,
    at: T0 - 2 * H,
    time: iso(T0 - 2 * H),
    summary: 's',
    active: 'A',
    accounts: [
      {
        accountId: 'A',
        label: 'A',
        reason: 'session',
        spent: [{ kind: 'session', percent: 100, resetsAt: T0 + H }],
      },
      {
        accountId: 'B',
        label: 'B',
        reason: 'session',
        spent: [{ kind: 'session', percent: 100, resetsAt: T0 + 3 * H }],
      },
    ],
    switches: [],
  };

  it('resumes the global and the folder episodes without announcing either again', async () => {
    const rig = await createRig({
      registry: researchFleet(),
      bodies: { A: spentUntil(T0 + H), B: spentUntil(T0 + 3 * H), E: spentUntil(T0 + 2 * H) },
      seedLog: [legacyGlobalStart, folderStart],
    });
    await rig.cycle(T0 + 5 * M);
    await settle();
    expect(rig.relay.cards()).toHaveLength(0);
    expect(await rig.log.read()).toHaveLength(2);

    // A's window resets: the global pool is back (the legacy line was its episode). A is live in the
    // global slot, so the folder is still out.
    rig.bodies.set('A', free());
    await rig.cycle(T0 + H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.relay.cards()[0]?.title).toBe('Usage is back');
    const recoveredOf = async (id: string) =>
      (await rig.log.read()).find((r) => r.event === 'recovered' && r.id === id) as
        RecoveredRecord | undefined;
    const end = await recoveredOf(legacyGlobalStart.id);
    expect(end).toMatchObject({ v: 1, how: 'reset' });
    expect(end?.durationMs).toBe(3 * H);
    // The folder learned that A, back from its wall, is held by the global slot.
    const walls = (await researchLines(rig.log)).filter((r) => r.event === 'walls');
    expect(walls).toMatchObject([{ accountId: 'A', reason: 'live_elsewhere', v: 2 }]);

    // E resets: the folder's episode ends too, dated to its reset.
    rig.bodies.set('E', free());
    await rig.cycle(T0 + 2 * H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    expect(rig.relay.cards()[1]?.title).toBe('Usage is back in C:/research');
    const folderEnd = await recoveredOf(folderStart.id);
    expect(folderEnd).toMatchObject({ v: 2, scope: RESEARCH, how: 'reset' });
    expect(folderEnd?.backSince).toBe(T0 + 2 * H);
  });

  it('a folder episode resumed after its rule was removed is closed as removed on the first cycle', async () => {
    const rig = await createRig({
      registry: {
        accounts: [view('A'), view('B'), view('E')],
        rules: [],
        live: new Map<SlotId, string | null>([['global', 'A']]),
      },
      bodies: { A: free(), B: free(), E: free() },
      seedLog: [folderStart],
    });
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.relay.cards()[0]?.title).toBe('C:/research: folder rule removed');
    await rig.cycle(T0 + 5 * M);
    const end = (await rig.log.read()).at(-1) as RecoveredRecord;
    expect(end).toMatchObject({ how: 'rule_removed', id: folderStart.id });
  });
});

describe('a folder out of usage and out of accounts', () => {
  it('its outage card is the one alert: the slot alert for the same news is held back', async () => {
    const registry = researchFleet();
    registry.live.set(ruleSlotId('r1'), null);
    const rig = await createRig({
      registry,
      bodies: { A: free(), B: spentUntil(T0 + 3 * H), E: spentUntil(T0 + 5 * H) },
      noWorking: ['r1'],
    });
    await waitFor(() => rig.relay.cards().length === 1);
    await rig.cycle(T0 + 5 * M);
    await settle();
    const slotAlerts = rig.relay.received.filter(
      (e) => e.type === 'hook.notification' && e.payload.notificationType === 'slot_alert',
    );
    expect(slotAlerts).toHaveLength(0);
  });
});
