// Poll-cycle wiring: what the cycle computes ONCE and hands to everyone (the plan the phone
// renders, the inputs the auto-switch executor decides on, the candidates the activation probe
// spends a turn on), and the one-at-a-time rule that keeps two cycles from running at once.
//
// Driven through the real Daemon against a real Store, a real HookReceiver and a real
// ControlPlaneClient talking to a minimal in-process relay — the same posture daemon.test.ts
// takes — because the whole point of these cases is that the pieces agree with each other, and
// a fake cycle could only ever agree with itself.

import { describe, it, expect, afterEach, vi } from 'vitest';
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
  computePlan,
  type AccountUsageInput,
  type AdvisorOptions,
} from '@claude-control/usage-advisor';
import type {
  ActivateResult,
  Logger,
  RecoverResult,
  StoredAccount,
} from '@claude-control/switch-engine';
import type { SessionManager, SessionRecord } from '@claude-control/session-runtime';
import { Store } from './store.js';
import {
  POLL_FLOOR_MS,
  POLL_JITTER_MS,
  UsagePoller,
  type FetchLikeResponse,
} from './usagePoller.js';
import { parseUsageEndpointResponse } from './usageParse.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import {
  ControlPlaneClient,
  type DaemonIdentity,
  type IdentityStore,
} from './controlPlaneClient.js';
import {
  Daemon,
  type AccountProbeLike,
  type AutoSwitcherLike,
  type SwitchEngineLike,
} from './daemon.js';
import type { ProbeCandidate } from './accountProbe.js';

const NOW = Date.parse('2026-07-25T19:00:00.000Z');
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const iso = (atMs: number): string => new Date(atMs).toISOString();

// ---------------------------------------------------------------------------
// A minimal steady-state relay: accepts `hello`, answers `ping`, and collects everything the
// daemon pushes. Just enough wire protocol to let the daemon come all the way up.
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

// ---------------------------------------------------------------------------
// Fakes: only the collaborators the poll cycle actually touches. Everything a session command
// would need throws, so a future cycle that started calling one fails loudly here.
// ---------------------------------------------------------------------------

const ACCOUNTS: StoredAccount[] = [
  { id: 'acct-1', label: 'Work', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
  { id: 'acct-2', label: 'Alt', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
];

function stubSwitchEngine(activateCalls: string[]): SwitchEngineLike {
  return {
    recover: (): Promise<RecoverResult> => Promise.resolve({ recovered: false, action: 'none' }),
    activate: (id: string): Promise<ActivateResult> => {
      activateCalls.push(id);
      return Promise.resolve({
        ok: true,
        activeAccountId: id,
        refreshed: false,
        adoptedPreviousRotation: false,
        wroteCredentials: true,
      });
    },
    listAccounts: (): Promise<StoredAccount[]> => Promise.resolve(ACCOUNTS),
    getActiveId: (): Promise<string | null> => Promise.resolve('acct-1'),
    reauthenticate: () => Promise.reject(new Error('not used in this test')),
  };
}

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

/** Log lines, so the cycle's debug-level decisions (a skipped tick) are observable without
 *  widening the daemon's public surface for a test. */
function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const log =
    () =>
    (_obj: unknown, msg?: string): void => {
      if (msg !== undefined) lines.push(msg);
    };
  return {
    logger: { debug: log(), info: log(), warn: log(), error: log() },
    lines,
  };
}

const jsonResponse = (body: unknown, status = 200): FetchLikeResponse => ({
  ok: status >= 200 && status < 300,
  status,
  json: () => Promise.resolve(body),
});

interface Rig {
  daemon: Daemon;
  store: Store;
  relay: SteadyRelay;
  poller: UsagePoller;
  /** One entry per auto-switch evaluation: exactly the inputs the executor decided on. */
  autoSwitchInputs: AccountUsageInput[][];
  /** One entry per probe call: the candidates the cycle judged unplaceable on a weekly clock. */
  probed: ProbeCandidate[][];
  logLines: string[];
  hookReceiver: HookReceiver;
  /** The account each usage-endpoint request was for, in order. */
  fetched: string[];
  start: () => Promise<void>;
}

/** Build a daemon whose only interesting collaborator is the poll cycle. `bodyFor` is the usage
 *  endpoint's answer per account; `seed` writes the snapshot history a cycle will read back. */
async function createRig(options: {
  bodyFor: (accountId: string) => unknown;
  advisorOptions?: AdvisorOptions;
  seed?: (store: Store) => void;
  pollIntervalMs?: number;
  /** The usage endpoint's HTTP status per account; 200 when absent. */
  statusFor?: (accountId: string) => number;
  /** The clock the poller and the daemon read; fixed at NOW when absent. */
  clock?: () => number;
}): Promise<Rig> {
  const relay = new SteadyRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  options.seed?.(store);
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-pollcycle-'));

  const clock = options.clock ?? (() => NOW);
  const fetched: string[] = [];
  const poller = new UsagePoller({
    // The token names the account, so one fetch can answer differently per account without
    // knowing anything about the poller's internals.
    fetch: (_url, init) => {
      const accountId = (init.headers.authorization ?? '').replace('Bearer tok-', '');
      fetched.push(accountId);
      return Promise.resolve(
        jsonResponse(options.bodyFor(accountId), options.statusFor?.(accountId) ?? 200),
      );
    },
    getToken: (accountId: string) => Promise.resolve(`tok-${accountId}`),
    getCachedUsage: () => Promise.resolve(undefined),
    clock,
    ...(options.advisorOptions !== undefined ? { advisorOptions: options.advisorOptions } : {}),
  });

  const autoSwitchInputs: AccountUsageInput[][] = [];
  const autoSwitcher: AutoSwitcherLike = {
    evaluate: (accounts) => {
      autoSwitchInputs.push(accounts);
      // No hop, so nothing for the cycle to absorb as its own.
      return Promise.resolve(undefined);
    },
  };
  const probed: ProbeCandidate[][] = [];
  const accountProbe: AccountProbeLike = {
    probeUnknown: (candidates) => {
      probed.push(candidates);
      return Promise.resolve([]);
    },
  };

  const hookReceiver = new HookReceiver({
    store,
    secret: 'shh',
    emit: () => {},
    daemonId: () => 'daemon-under-test',
  });
  const identity: DaemonIdentity = { daemonId: 'daemon-under-test', daemonToken: 'tok' };
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
  const { logger, lines } = capturingLogger();

  const daemon = new Daemon({
    store,
    switchEngine: stubSwitchEngine([]),
    sessionManager: stubSessionManager(),
    poller,
    attributionJournal: new AttributionJournal({ store, vaultDir }),
    hookReceiver,
    controlPlaneClient,
    autoSwitcher,
    accountProbe,
    logger,
    clock,
    // Effectively off unless a case wants the interval itself under test.
    pollIntervalMs: options.pollIntervalMs ?? 100_000,
  });

  cleanups.push(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  return {
    daemon,
    store,
    relay,
    poller,
    autoSwitchInputs,
    probed,
    logLines: lines,
    hookReceiver,
    fetched,
    start: () => daemon.start(),
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

/** The usage.snapshot payload the phone would render. */
function lastSnapshot(relay: SteadyRelay): PayloadOf<'usage.snapshot'> {
  const frames = relay.received.filter((e) => e.type === 'usage.snapshot');
  const last = frames[frames.length - 1];
  if (last === undefined || last.type !== 'usage.snapshot') throw new Error('no usage.snapshot');
  return last.payload;
}

describe('poll cycle — one set of inputs for the plan and the executor', () => {
  // acct-1 is live with an observed weekly reset days away: plenty of headroom, nothing urgent.
  // acct-2 is idle and its weekly window has CLOSED, so the endpoint publishes no reset for it
  // at all — the exact shape whose clock only history can supply.
  const bodyFor = (accountId: string): unknown =>
    accountId === 'acct-1'
      ? {
          limits: [
            { kind: 'session', percent: 5, resets_at: iso(NOW + 2 * HOUR_MS) },
            { kind: 'weekly_all', percent: 10, resets_at: iso(NOW + 6 * DAY_MS) },
          ],
        }
      : { limits: [{ kind: 'weekly_all', percent: 30 }] };

  /** One stored reading for acct-2, anchoring its weekly cadence a week back so the prediction
   *  lands three hours from now — inside the advisor's "imminent" window, which is what makes
   *  the merge observable in the plan rather than only in the executor's inputs. */
  function seedClosedWindowHistory(store: Store): void {
    const observedResetAt = NOW + 3 * HOUR_MS - WEEK_MS;
    store.insertUsageSnapshot({
      accountId: 'acct-2',
      fetchedAtMs: NOW - WEEK_MS,
      source: 'live',
      json: JSON.stringify(
        parseUsageEndpointResponse(
          { limits: [{ kind: 'weekly_all', percent: 30, resets_at: iso(observedResetAt) }] },
          {
            accountId: 'acct-2',
            label: 'Alt',
            active: false,
            quarantined: false,
            autoSwitchExcluded: false,
            fetchedAtMs: NOW - WEEK_MS,
            source: 'live',
          },
        ).accountUsage,
      ),
    });
  }

  it('the plan the phone is shown is computed from the same accounts the executor decides on', async () => {
    const rig = await createRig({
      bodyFor,
      seed: seedClosedWindowHistory,
      advisorOptions: { now: () => NOW },
    });
    await rig.start();
    await waitFor(() => rig.autoSwitchInputs.length > 0 && rig.relay.received.length > 0);
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));

    const executorInputs = rig.autoSwitchInputs[0] as AccountUsageInput[];
    const predicted = executorInputs.find((a) => a.accountId === 'acct-2')?.predictedResetAt;
    // The history-derived clock reached the executor (it always did) …
    expect(predicted).toBe(NOW + 3 * HOUR_MS);

    // … and the SAME inputs produced the plan that shipped: re-running the advisor over exactly
    // what the executor saw reproduces the wire plan, which it cannot do if the two were
    // computed from different accounts.
    const wire = lastSnapshot(rig.relay);
    const replan = computePlan(executorInputs, { now: () => NOW });
    expect(wire.plan?.recommendedAccountId).toBe(replan.recommendedAccountId);
    expect(wire.plan?.reason).toBe(replan.reason);
    expect(wire.plan?.ranking.map((r) => r.accountId)).toEqual(
      replan.ranking.map((r) => r.accountId),
    );

    // And the fixture is genuinely prediction-sensitive: without the merge the plan would name
    // the account with the most headroom while the executor was reasoning about a burn target.
    const unmerged = executorInputs.map(({ predictedResetAt: _dropped, ...rest }) => rest);
    expect(computePlan(unmerged, { now: () => NOW }).recommendedAccountId).toBe('acct-1');
    expect(wire.plan?.recommendedAccountId).toBe('acct-2');
  });

  it('an account with no history at all carries no prediction into either', async () => {
    const rig = await createRig({ bodyFor, advisorOptions: { now: () => NOW } });
    await rig.start();
    await waitFor(() => rig.autoSwitchInputs.length > 0);
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));

    const executorInputs = rig.autoSwitchInputs[0] as AccountUsageInput[];
    expect(executorInputs.find((a) => a.accountId === 'acct-2')?.predictedResetAt).toBeUndefined();
    // No clock anywhere, so the burn queue is empty and headroom decides — the same answer the
    // executor's own candidate gate would give.
    expect(lastSnapshot(rig.relay).plan?.recommendedAccountId).toBe('acct-1');
  });
});

describe('poll cycle — one at a time', () => {
  it('a tick that lands while a cycle is still running is skipped, not stacked', async () => {
    const rig = await createRig({
      bodyFor: () => ({ limits: [{ kind: 'weekly_all', percent: 10 }] }),
      pollIntervalMs: 10,
    });
    // A cycle that outlasts many intervals — the activation probe alone may take two minutes,
    // so this is the ordinary case, not a pathological one.
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pollSpy = vi
      .spyOn(rig.poller, 'pollAll')
      .mockImplementation(() => blocked.then(() => ({ results: [], accounts: [] })));

    await rig.start();
    await waitFor(() => pollSpy.mock.calls.length > 0);
    // Ten-millisecond ticks over this window would have started dozens of cycles.
    await new Promise((r) => setTimeout(r, 150));
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(rig.logLines).toContain('poll cycle still running; skipping this tick');

    // The guard releases with the cycle, so polling resumes rather than wedging for good.
    release();
    await waitFor(() => pollSpy.mock.calls.length > 1);
  });
});

describe('poll cycle — probe candidates match what the policy can see', () => {
  // acct-2 reports ONLY the Fable sub-cap, with a reset. With the cap counted that IS a weekly
  // clock; with the cap opted out the policy sees no limits on this account at all.
  const bodyFor = (accountId: string): unknown =>
    accountId === 'acct-1'
      ? { limits: [{ kind: 'weekly_all', percent: 10, resets_at: iso(NOW + 6 * DAY_MS) }] }
      : { limits: [{ kind: 'weekly_scoped', percent: 5, resets_at: iso(NOW + 5 * DAY_MS) }] };

  it('probes the account whose only weekly signal the policy has been told to ignore', async () => {
    const rig = await createRig({
      bodyFor,
      advisorOptions: { now: () => NOW, autoSwitchPolicy: { fableCapTriggers: false } },
    });
    await rig.start();
    await waitFor(() => rig.probed.length > 0);
    expect(rig.probed[0]).toEqual([{ accountId: 'acct-2', label: 'Alt' }]);
  });

  it('leaves it alone when the same cap is one the policy counts', async () => {
    const rig = await createRig({ bodyFor, advisorOptions: { now: () => NOW } });
    await rig.start();
    // The probe is only consulted when there is something to probe, so "nothing was probed" is
    // observed through the cycle that ran: wait for the snapshot it pushes, then assert.
    await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));
    expect(rig.probed).toEqual([]);
  });
});

describe('usage refresh on demand (POST /cli/usage/repoll)', () => {
  const weekly = () => ({ limits: [{ kind: 'weekly_all', percent: 10 }] });

  /** Ask the running daemon for a refresh over its real loopback route. */
  async function repoll(
    rig: Rig,
    body: Record<string, unknown>,
    // null sends no secret header at all.
    secret: string | null = 'shh',
  ): Promise<{ status: number; body: unknown }> {
    const res = await fetch(`http://127.0.0.1:${rig.hookReceiver.getPort()}/cli/usage/repoll`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(secret !== null ? { 'x-claude-control-secret': secret } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  }

  /** Start the rig and wait until its first cycle has polled both accounts and finished. */
  async function startAndSettle(rig: Rig) {
    const pollSpy = vi.spyOn(rig.poller, 'pollAll');
    await rig.start();
    await waitFor(() => rig.autoSwitchInputs.length === 1);
    expect(pollSpy).toHaveBeenCalledTimes(1);
    return pollSpy;
  }

  /** Long enough for a cycle the request should NOT have started to show up if it had. */
  const settle = () => new Promise((r) => setTimeout(r, 150));

  it('is refused without the secret, and starts nothing', async () => {
    const rig = await createRig({ bodyFor: weekly });
    const pollSpy = await startAndSettle(rig);
    expect((await repoll(rig, {}, null)).status).toBe(401);
    expect((await repoll(rig, {}, 'wrong')).status).toBe(401);
    await settle();
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it('honors the floor: just-polled accounts are skipped with when they are due', async () => {
    const rig = await createRig({ bodyFor: weekly });
    const pollSpy = await startAndSettle(rig);
    const res = await repoll(rig, {});
    expect(res.status).toBe(200);
    const results = (res.body as { results: Array<Record<string, unknown>> }).results;
    expect(results.map((r) => [r.id, r.outcome, r.reason])).toEqual([
      ['acct-1', 'skipped', 'floor'],
      ['acct-2', 'skipped', 'floor'],
    ]);
    for (const r of results) {
      expect(r.dueAtMs).toBeGreaterThanOrEqual(NOW + POLL_FLOOR_MS);
      expect(r.dueAtMs).toBeLessThanOrEqual(NOW + POLL_FLOOR_MS + POLL_JITTER_MS);
    }
    await settle();
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(rig.fetched).toHaveLength(2);
  });

  it('honors a 429 backoff: the account is skipped as backed off', async () => {
    const rig = await createRig({
      bodyFor: weekly,
      statusFor: (id) => (id === 'acct-2' ? 429 : 200),
    });
    const pollSpy = await startAndSettle(rig);
    const res = await repoll(rig, { ids: ['acct-2'] });
    expect(res.body).toMatchObject({
      ok: true,
      results: [{ id: 'acct-2', outcome: 'skipped', reason: 'backoff' }],
    });
    await settle();
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it('answers an unknown id as unknown and starts nothing', async () => {
    const rig = await createRig({ bodyFor: weekly });
    const pollSpy = await startAndSettle(rig);
    const res = await repoll(rig, { ids: ['ghost'] });
    expect(res.body).toEqual({
      ok: true,
      results: [{ id: 'ghost', outcome: 'skipped', reason: 'unknown' }],
    });
    await settle();
    expect(pollSpy).toHaveBeenCalledTimes(1);
  });

  it('schedules every account once the floor has passed, and polls them now', async () => {
    let now = NOW;
    const rig = await createRig({ bodyFor: weekly, clock: () => now });
    const pollSpy = await startAndSettle(rig);
    now += POLL_FLOOR_MS + POLL_JITTER_MS;
    const res = await repoll(rig, {});
    expect(res.body).toEqual({
      ok: true,
      results: [
        { id: 'acct-1', outcome: 'scheduled' },
        { id: 'acct-2', outcome: 'scheduled' },
      ],
    });
    // Polled now, not at the next tick (the rig's interval is far away).
    await waitFor(() => rig.fetched.length === 4);
    expect(pollSpy).toHaveBeenCalledTimes(2);
    expect(rig.fetched.slice(2).sort()).toEqual(['acct-1', 'acct-2']);
  });

  it('follows a cycle already running with exactly one more', async () => {
    const rig = await createRig({ bodyFor: weekly });
    let release: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first cycle hangs inside pollAll, so nothing is polled yet and every account is due.
    const pollSpy = vi
      .spyOn(rig.poller, 'pollAll')
      .mockImplementationOnce(() => blocked.then(() => ({ results: [], accounts: [] })));
    await rig.start();
    await waitFor(() => pollSpy.mock.calls.length === 1);

    const first = await repoll(rig, {});
    const second = await repoll(rig, { ids: ['acct-1'] });
    expect(first.body).toMatchObject({
      results: [{ outcome: 'scheduled' }, { outcome: 'scheduled' }],
    });
    expect(second.body).toMatchObject({ results: [{ outcome: 'scheduled' }] });
    expect(pollSpy).toHaveBeenCalledTimes(1);

    release();
    await waitFor(() => pollSpy.mock.calls.length === 2);
    await settle();
    // Two refreshes during one cycle still make one follow-up cycle, not two, and no loop.
    expect(pollSpy).toHaveBeenCalledTimes(2);
  });

  it('does not follow a running cycle that went on to poll every account the refresh named', async () => {
    const rig = await createRig({ bodyFor: weekly });
    const realPollAll = rig.poller.pollAll.bind(rig.poller);
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The first cycle waits just before pollAll, so the refresh finds every account due; then it
    // polls them for real.
    const pollSpy = vi
      .spyOn(rig.poller, 'pollAll')
      .mockImplementationOnce((accounts) => gate.then(() => realPollAll(accounts)));
    await rig.start();
    await waitFor(() => pollSpy.mock.calls.length === 1);

    const res = await repoll(rig, {});
    expect(res.body).toMatchObject({
      results: [{ outcome: 'scheduled' }, { outcome: 'scheduled' }],
    });

    release();
    await waitFor(() => rig.autoSwitchInputs.length >= 1);
    await settle();
    // The running cycle already served the refresh; a second one would only re-run every
    // per-cycle side effect (and spend retry budgets counted in cycles) to poll nothing.
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(rig.autoSwitchInputs).toHaveLength(1);
    expect([...rig.fetched].sort()).toEqual(['acct-1', 'acct-2']);
  });

  it('starts no cycle once the daemon is stopping, and says so', async () => {
    let now = NOW;
    const rig = await createRig({ bodyFor: weekly, clock: () => now });
    const pollSpy = await startAndSettle(rig);
    now += POLL_FLOOR_MS + POLL_JITTER_MS; // every account is due again
    const internals = rig.daemon as unknown as {
      repollUsage(ids: string[] | undefined): Promise<unknown>;
    };
    // One refresh is still reading the fleet when stop() begins; another arrives after it.
    const inFlight = internals.repollUsage(undefined);
    const stopping = rig.daemon.stop();
    const late = internals.repollUsage(undefined);
    expect(await inFlight).toBe('stopping');
    expect(await late).toBe('stopping');
    await stopping;
    await settle();
    expect(pollSpy).toHaveBeenCalledTimes(1);
    expect(rig.logLines).not.toContain('requested poll cycle failed');
  });

  it('starts no cycle while cycles keep failing before they poll, and says why', async () => {
    let now = NOW;
    // The audit log is unreadable, so every cycle dies before it reaches the usage endpoint and
    // no account ever gets poll state for the floor to hold.
    const sync = vi
      .spyOn(AttributionJournal.prototype, 'sync')
      .mockRejectedValue(new Error('EISDIR: illegal operation on a directory, read'));
    try {
      const rig = await createRig({ bodyFor: weekly, clock: () => now });
      await rig.start();
      await waitFor(() => rig.logLines.includes('initial poll cycle failed'));

      for (let i = 0; i < 5; i += 1) {
        expect((await repoll(rig, {})).body).toEqual({
          ok: true,
          results: [
            { id: 'acct-1', outcome: 'skipped', reason: 'cycle_failed' },
            { id: 'acct-2', outcome: 'skipped', reason: 'cycle_failed' },
          ],
        });
      }
      await settle();
      // Only the initial cycle ran: the refreshes added none, so none failed.
      expect(sync).toHaveBeenCalledTimes(1);
      expect(rig.logLines).not.toContain('requested poll cycle failed');
      expect(rig.fetched).toEqual([]);

      // Once a cycle gets through again, a refresh schedules as before.
      sync.mockResolvedValue(undefined);
      await (rig.daemon as unknown as { runPollCycle(): Promise<void> }).runPollCycle();
      expect([...rig.fetched].sort()).toEqual(['acct-1', 'acct-2']);
      now += POLL_FLOOR_MS + POLL_JITTER_MS;
      expect((await repoll(rig, {})).body).toEqual({
        ok: true,
        results: [
          { id: 'acct-1', outcome: 'scheduled' },
          { id: 'acct-2', outcome: 'scheduled' },
        ],
      });
      await waitFor(() => rig.fetched.length === 4);
    } finally {
      sync.mockRestore();
    }
  });
});
