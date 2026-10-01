// The exhaustion log, driven through the real poll cycle: a real Daemon, UsagePoller, Store,
// AttributionJournal and ControlPlaneClient talking to a minimal in-process relay, with the
// usage endpoint scripted per account and a clock the test moves. What is under test is that the
// pieces agree: the file gets exactly one start and one end per outage, the phone gets exactly
// one card each time, and nothing in between (a failed poll, a restart) adds a second outage.

import { describe, it, expect, afterEach } from 'vitest';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  decode,
  encode,
  isType,
  negotiateVersion,
  stamp,
  type Envelope,
} from '@claude-control/shared-protocol';
import { assessFleet, type AutoSwitchPolicy } from '@claude-control/usage-advisor';
import type {
  ActivateResult,
  Logger,
  RecoverResult,
  StoredAccount,
} from '@claude-control/switch-engine';
import type { SessionManager, SessionRecord } from '@claude-control/session-runtime';
import { Store } from './store.js';
import { UsagePoller, type FetchLikeResponse } from './usagePoller.js';
import { AttributionJournal } from './attributionJournal.js';
import { HookReceiver } from './hookReceiver.js';
import { ControlPlaneClient, type DaemonIdentity } from './controlPlaneClient.js';
import { Daemon, type SwitchEngineLike } from './daemon.js';
import {
  exhaustedRecord,
  ExhaustionLog,
  type ExhaustedRecord,
  type RecoveredRecord,
} from './exhaustionLog.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const H = 60 * 60 * 1000;
const M = 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

/** Collects everything the daemon pushes; answers just enough protocol to come all the way up. */
class SteadyRelay {
  private readonly wss = new WebSocketServer({ port: 0 });
  readonly received: Envelope[] = [];

  constructor() {
    this.wss.on('connection', (socket: WebSocket) => {
      socket.on('message', (raw: RawData) => {
        const decoded = decode(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw));
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

  /** The exhaustion cards the phone received, in order. */
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

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.wss.close((err) => (err ? reject(err) : resolve())),
    );
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Let anything a cycle sent cross the real socket before asserting that nothing more came. */
const settle = () => new Promise((r) => setTimeout(r, 60));

const ACCOUNTS: StoredAccount[] = [
  { id: 'acct-1', label: 'work1', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
  { id: 'acct-2', label: 'work2', quarantined: false, createdAtMs: 0, updatedAtMs: 0 },
];

/** An endpoint body: the 5-hour window at `percent`, resetting at `resetsAt`, a quiet week. */
const sessionBody = (percent: number, resetsAt: number) => ({
  limits: [
    { kind: 'session', percent, resets_at: iso(resetsAt) },
    { kind: 'weekly_all', percent: 50, resets_at: iso(T0 + 90 * H) },
  ],
});

interface Rig {
  daemon: Daemon;
  relay: SteadyRelay;
  log: ExhaustionLog;
  lines: string[];
  /** The usage endpoint's answer per account id; mutate between cycles. */
  bodies: Map<string, unknown>;
  /** Run one poll cycle at `at`, after any cycle already running has finished. */
  cycle: (at: number) => Promise<void>;
  vaultDir: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function createRig(
  options: {
    /** Lines already in the exhaustion log when the daemon starts. */
    seedLog?: unknown[];
    /** Lines already in the switch audit log. */
    seedAudit?: unknown[];
    autoSwitchPolicy?: AutoSwitchPolicy;
    /** Where the log lives; default a file in the rig's temp folder. */
    logPath?: (dir: string) => string;
  } = {},
): Promise<Rig> {
  const relay = new SteadyRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-'));
  const clock = { now: T0 };
  const bodies = new Map<string, unknown>();

  const log = new ExhaustionLog(
    options.logPath?.(vaultDir) ?? join(vaultDir, 'exhaustion-log.jsonl'),
  );
  if (options.seedLog !== undefined) {
    await writeFile(log.path, options.seedLog.map((r) => JSON.stringify(r) + '\n').join(''));
  }
  if (options.seedAudit !== undefined) {
    await writeFile(
      join(vaultDir, 'switch-audit.jsonl'),
      options.seedAudit.map((r) => JSON.stringify(r) + '\n').join(''),
    );
  }

  const json = (body: unknown): FetchLikeResponse => ({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  });
  const poller = new UsagePoller({
    // The token names the account, so one fetch answers per account.
    fetch: (_url, init) =>
      Promise.resolve(
        json(bodies.get((init.headers.authorization ?? '').replace('Bearer tok-', '')) ?? {}),
      ),
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
    listAccounts: (): Promise<StoredAccount[]> => Promise.resolve(ACCOUNTS),
    getActiveId: (): Promise<string | null> => Promise.resolve('acct-2'),
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
  const hookReceiver = new HookReceiver({
    store,
    secret: 'shh',
    emit: () => {},
    daemonId: () => 'daemon-under-test',
  });
  const identity: DaemonIdentity = { daemonId: 'daemon-under-test', daemonToken: 'tok' };
  const controlPlaneClient = new ControlPlaneClient({
    url: `ws://127.0.0.1:${relayPort}`,
    identityStore: { load: () => Promise.resolve(identity), save: () => Promise.resolve() },
    store,
    hostLabel: 'test',
    reconnectBaseMs: 10,
    heartbeatMs: 100_000,
  });
  const lines: string[] = [];
  const capture =
    () =>
    (_obj: unknown, msg?: string): void => {
      if (msg !== undefined) lines.push(msg);
    };
  const logger: Logger = { debug: capture(), info: capture(), warn: capture(), error: capture() };

  const daemon = new Daemon({
    store,
    switchEngine,
    sessionManager,
    poller,
    attributionJournal: new AttributionJournal({ store, vaultDir }),
    hookReceiver,
    controlPlaneClient,
    exhaustionLog: log,
    logger,
    clock: () => clock.now,
    ...(options.autoSwitchPolicy !== undefined
      ? { autoSwitchPolicy: options.autoSwitchPolicy }
      : {}),
    // Effectively off: every cycle is driven by the test.
    pollIntervalMs: 100_000,
  });
  cleanups.push(async () => {
    await daemon.stop().catch(() => {});
    await relay.close();
    await rm(vaultDir, { recursive: true, force: true });
  });

  // The cycle is private; driving it directly (rather than through a timer) is what makes the
  // order of readings, and so the assertions, deterministic.
  const internals = daemon as unknown as {
    runPollCycle(): Promise<void>;
    pollCycleInFlight: boolean;
  };
  const cycle = async (at: number): Promise<void> => {
    await waitFor(() => !internals.pollCycleInFlight);
    clock.now = at;
    await internals.runPollCycle();
  };
  return { daemon, relay, log, lines, bodies, cycle, vaultDir };
}

/** Start the daemon with its first (immediate) cycle at T0, and wait for that cycle to finish. */
async function startAtT0(rig: Rig): Promise<void> {
  await rig.daemon.start();
  await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));
  await rig.cycle(T0 + 1); // waits out the start cycle; a second reading at the same numbers
}

describe('exhaustion log through the poll cycle', () => {
  it('one outage = one start line + one card, then one end line + one card', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(99, T0 + 2 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    const [start] = await rig.log.read();
    expect(start).toMatchObject({
      event: 'exhausted',
      at: T0,
      active: 'work2',
      firstBack: { label: 'work1', at: T0 + H },
    });
    expect(rig.relay.cards()[0]).toMatchObject({
      type: 'usage_exhausted',
      title: 'All accounts are out of usage',
      level: 'warn',
    });
    expect(rig.relay.cards()[0]?.body).toContain('• work1 (5-hour window 100%, back in 1h)');
    expect(rig.lines).toContain('no account can take work');

    // Still out ten minutes later: nothing new anywhere.
    await rig.cycle(T0 + 10 * M);
    await settle();
    expect(await rig.log.read()).toHaveLength(1);
    expect(rig.relay.cards()).toHaveLength(1);

    // work1's window resets and the endpoint says so.
    rig.bodies.set('acct-1', sessionBody(3, T0 + 6 * H));
    await rig.cycle(T0 + H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    const records = await rig.log.read();
    expect(records).toHaveLength(2);
    const end = records[1] as RecoveredRecord;
    expect(end).toMatchObject({
      event: 'recovered',
      id: (start as ExhaustedRecord).id,
      how: 'reset',
      limit: 'session',
      backSince: T0 + H,
      durationMs: H,
      account: { label: 'work1' },
    });
    expect(rig.relay.cards()[1]).toMatchObject({
      type: 'usage_restored',
      title: 'Usage is back',
      level: 'success',
      body: 'Usage is back: work1 (its 5-hour window reset). No account could take work for 1h.',
    });
  });

  it('a poll that comes back empty mid-outage does not end it or start a second one', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);

    // The endpoint answers work1 with nothing usable: "unknown", which the shared rule counts
    // as having usage left. The fleet is no longer provably exhausted, but nothing came back.
    rig.bodies.set('acct-1', {});
    await rig.cycle(T0 + 10 * M);
    // ...and the next reading shows it still at the wall.
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    await rig.cycle(T0 + 20 * M);
    await settle();
    expect(await rig.log.read()).toHaveLength(1);
    expect(rig.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
  });

  it('an outage open in the log when the daemon starts is resumed, not announced again', async () => {
    const before = exhaustedRecord({
      fleet: assessFleet(
        [
          {
            accountId: 'acct-1',
            label: 'work1',
            active: false,
            quarantined: false,
            limits: [{ kind: 'session', percent: 100, resetsAt: T0 + H }],
          },
          {
            accountId: 'acct-2',
            label: 'work2',
            active: true,
            quarantined: false,
            limits: [{ kind: 'session', percent: 100, resetsAt: T0 + 2 * H }],
          },
        ],
        T0 - 30 * M,
      ),
      now: T0 - 30 * M,
      active: 'work2',
      switches: [],
    });
    const rig = await createRig({ seedLog: [before] });
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    await startAtT0(rig);
    await settle();
    expect(rig.relay.cards()).toEqual([]);
    expect(await rig.log.read()).toEqual([before]);

    // No cycle runs until well after work1's recorded reset (T0+1h), as if the daemon were
    // stopped through it. The end names work1 and is dated to that reset, so the outage
    // measures 1.5h from its start before this daemon even ran, not up to the late reading.
    await rig.cycle(T0 + 2 * H + M);
    await waitFor(() => rig.relay.cards().length === 1);
    const records = await rig.log.read();
    expect(records[1]).toMatchObject({
      event: 'recovered',
      id: before.id,
      account: { label: 'work1' },
      how: 'reset',
      backSince: T0 + H,
      durationMs: 1.5 * H,
    });
  });

  it('the start line carries the switches of the last 5 hours, by label, with who and why', async () => {
    const rig = await createRig({
      seedAudit: [
        {
          ts: T0 - 6 * H,
          event: 'activated',
          fromAccountId: null,
          toAccountId: 'acct-1',
          origin: 'manual',
        },
        {
          ts: T0 - 3 * H,
          event: 'activated',
          fromAccountId: 'acct-1',
          toAccountId: 'acct-2',
          origin: 'auto',
          detail: 'work1 at 95% of its 5-hour window',
        },
        { ts: T0 - 2 * H, event: 'refreshed', fromAccountId: null, toAccountId: 'acct-2' },
      ],
    });
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    const [start] = (await rig.log.read()) as ExhaustedRecord[];
    expect(start?.switches).toEqual([
      {
        at: T0 - 3 * H,
        from: 'work1',
        to: 'work2',
        origin: 'auto',
        reason: 'work1 at 95% of its 5-hour window',
      },
    ]);
    expect(rig.relay.cards()[0]?.body).toContain('1 switch in the last 5 hours');
  });

  it('with the Fable cap opted out of auto-switch, a fleet only Fable-capped is not an outage', async () => {
    const rig = await createRig({ autoSwitchPolicy: { fableCapTriggers: false } });
    const fableCapped = {
      limits: [
        { kind: 'session', percent: 20, resets_at: iso(T0 + 3 * H) },
        { kind: 'weekly_scoped', percent: 100, resets_at: iso(T0 + 30 * H) },
      ],
    };
    rig.bodies.set('acct-1', fableCapped);
    rig.bodies.set('acct-2', fableCapped);
    await startAtT0(rig);
    await settle();
    expect(rig.relay.cards()).toEqual([]);
    expect(await rig.log.read()).toEqual([]);
  });

  it('a log that cannot be written still sends the card and keeps the entry in daemon.log', async () => {
    // A FILE where the log's folder should be: mkdir fails, so every append fails.
    const rig = await createRig({ logPath: (dir) => join(dir, 'blocker', 'exhaustion-log.jsonl') });
    await writeFile(join(rig.vaultDir, 'blocker'), 'not a folder');
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.lines).toContain('could not write the exhaustion log');
    await expect(readFile(rig.log.path, 'utf8')).rejects.toThrow();
    // And the cycle after it still runs and does not announce the outage again.
    await rig.cycle(T0 + 10 * M);
    await settle();
    expect(rig.relay.cards()).toHaveLength(1);
  });
});
