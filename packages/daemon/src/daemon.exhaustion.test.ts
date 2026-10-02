// The exhaustion log, driven through the real poll cycle: a real Daemon, UsagePoller, Store,
// AttributionJournal and ControlPlaneClient talking to a minimal in-process relay, with the
// usage endpoint scripted per account and a clock the test moves. What is under test is that the
// pieces agree: the file gets exactly one start and one end per outage, the phone gets exactly
// one card each time, and nothing in between (a failed poll, a restart, an account added mid-way,
// a write that failed) adds a second outage or a false end.

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
  type ExhaustionRecord,
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

  /** The plan line of the last usage snapshot: what the phone's /usage shows. */
  lastPlanReason(): string | undefined {
    const last = this.received.filter((e) => e.type === 'usage.snapshot').at(-1);
    return last !== undefined && isType(last, 'usage.snapshot')
      ? last.payload.plan?.reason
      : undefined;
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

/** Let anything a cycle sent cross the real socket before asserting that nothing more came. */
const settle = () => new Promise((r) => setTimeout(r, 60));

const account = (id: string, label: string): StoredAccount => ({
  id,
  label,
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
});

/** An endpoint body: the 5-hour window at `percent`, resetting at `resetsAt`, the week at
 *  `weeklyPercent` (quiet by default). */
const sessionBody = (percent: number, resetsAt: number, weeklyPercent = 50) => ({
  limits: [
    { kind: 'session', percent, resets_at: iso(resetsAt) },
    { kind: 'weekly_all', percent: weeklyPercent, resets_at: iso(T0 + 90 * H) },
  ],
});

/** A body the fake endpoint answers with that HTTP status instead of usage (429, 500). */
const httpStatus = (status: number) => ({ __status: status });

/** The episode's own lines, without the tracking (`walls`) lines. */
const startsAndEnds = (records: ExhaustionRecord[]) =>
  records.filter((r) => r.event !== 'walls').map((r) => r.event);

/** A log whose appends fail while `failing` says so: a file briefly held by a scanner, a disk
 *  briefly full. */
class FlakyLog extends ExhaustionLog {
  failing: (record: ExhaustionRecord) => boolean = () => false;
  override async append(record: ExhaustionRecord): Promise<void> {
    if (this.failing(record)) throw new Error('EBUSY: resource busy or locked');
    return super.append(record);
  }
}

interface Rig {
  daemon: Daemon;
  relay: SteadyRelay;
  log: ExhaustionLog;
  lines: string[];
  /** The usage endpoint's answer per account id; mutate between cycles. */
  bodies: Map<string, unknown>;
  /** The registry the daemon lists each cycle; push to add an account mid-run. */
  accounts: StoredAccount[];
  /** Run one poll cycle at `at`, after any cycle already running has finished. */
  cycle: (at: number) => Promise<void>;
  /** Stop this daemon (a restart test starts another on the same log). */
  stop: () => Promise<void>;
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
    /** The daemon's auto-switch policy, also handed to the poller's plan as the composition
     *  root does. */
    autoSwitchPolicy?: AutoSwitchPolicy;
    /** Where the log lives; default a file in the rig's temp folder. */
    logPath?: (dir: string) => string;
    /** A log of the test's own (a flaky one); overrides `logPath`. */
    log?: ExhaustionLog;
    accounts?: StoredAccount[];
    activeId?: string;
    /** The clock when the daemon starts (its first cycle runs then). */
    startAt?: number;
    /** The daemon's bound on each shutdown step (default its own 5 s). */
    sessionStopOnShutdownMs?: number;
  } = {},
): Promise<Rig> {
  const relay = new SteadyRelay();
  const relayPort = await relay.listen();
  const store = new Store(':memory:');
  const vaultDir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-'));
  const clock = { now: options.startAt ?? T0 };
  const bodies = new Map<string, unknown>();
  const accounts = options.accounts ?? [account('acct-1', 'work1'), account('acct-2', 'work2')];

  const log =
    options.log ??
    new ExhaustionLog(options.logPath?.(vaultDir) ?? join(vaultDir, 'exhaustion-log.jsonl'));
  if (options.seedLog !== undefined) {
    await writeFile(log.path, options.seedLog.map((r) => JSON.stringify(r) + '\n').join(''));
  }
  if (options.seedAudit !== undefined) {
    await writeFile(
      join(vaultDir, 'switch-audit.jsonl'),
      options.seedAudit.map((r) => JSON.stringify(r) + '\n').join(''),
    );
  }

  const respond = (body: unknown): FetchLikeResponse => {
    const status =
      typeof body === 'object' && body !== null && '__status' in body
        ? (body as { __status: number }).__status
        : 200;
    return { ok: status === 200, status, json: () => Promise.resolve(body) };
  };
  const poller = new UsagePoller({
    // The token names the account, so one fetch answers per account.
    fetch: (_url, init) =>
      Promise.resolve(
        respond(bodies.get((init.headers.authorization ?? '').replace('Bearer tok-', '')) ?? {}),
      ),
    getToken: (accountId: string) => Promise.resolve(`tok-${accountId}`),
    getCachedUsage: () => Promise.resolve(undefined),
    clock: () => clock.now,
    random: () => 0,
    ...(options.autoSwitchPolicy !== undefined
      ? { advisorOptions: { autoSwitchPolicy: options.autoSwitchPolicy } }
      : {}),
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
    listAccounts: (): Promise<StoredAccount[]> => Promise.resolve([...accounts]),
    getActiveId: (): Promise<string | null> => Promise.resolve(options.activeId ?? 'acct-2'),
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
    ...(options.sessionStopOnShutdownMs !== undefined
      ? { sessionStopOnShutdownMs: options.sessionStopOnShutdownMs }
      : {}),
    // Effectively off: every cycle is driven by the test.
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
  return { daemon, relay, log, lines, bodies, accounts, cycle, stop, vaultDir };
}

/** Start the daemon with its first (immediate) cycle at `at` (default T0), and wait for that
 *  cycle to finish. */
async function startAtT0(rig: Rig, at = T0): Promise<void> {
  await rig.daemon.start();
  await waitFor(() => rig.relay.received.some((e) => e.type === 'usage.snapshot'));
  await rig.cycle(at + 1); // waits out the start cycle; a second reading at the same numbers
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
    expect(rig.lines).toContain('could not write the exhaustion log; retrying every cycle');
    await expect(readFile(rig.log.path, 'utf8')).rejects.toThrow();
    // And the cycle after it still runs and does not announce the outage again.
    await rig.cycle(T0 + 10 * M);
    await settle();
    expect(rig.relay.cards()).toHaveLength(1);
  });
});

describe('an account that joins an open outage', () => {
  it('added at the wall, then one empty poll of it: the outage stays open', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + 4 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 5 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);

    // A third login during the outage, just as spent (used elsewhere).
    rig.accounts.push(account('acct-3', 'work3'));
    rig.bodies.set('acct-3', sessionBody(100, T0 + 3 * H));
    await rig.cycle(T0 + 10 * M);
    // One empty reading of it, then it reads at the wall again.
    rig.bodies.set('acct-3', {});
    await rig.cycle(T0 + 20 * M);
    rig.bodies.set('acct-3', sessionBody(100, T0 + 3 * H));
    await rig.cycle(T0 + 30 * M);
    await settle();

    expect(rig.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
    // work3 joining is tracking (a walls line), not a second start.
    expect(startsAndEnds(await rig.log.read())).toEqual(['exhausted']);
  });

  it('added at the wall, it comes back by its own reset, dated to that reset', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + 4 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 5 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    rig.accounts.push(account('acct-3', 'work3'));
    rig.bodies.set('acct-3', sessionBody(100, T0 + 2 * H));
    await rig.cycle(T0 + 10 * M);
    rig.bodies.set('acct-3', sessionBody(3, T0 + 7 * H));
    await rig.cycle(T0 + 2 * H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    const end = (await rig.log.read()).find((r) => r.event === 'recovered') as RecoveredRecord;
    expect(end).toMatchObject({ how: 'reset', limit: 'session', backSince: T0 + 2 * H });
  });

  it('added mid-outage, its first poll failing (500): no false end, no second start', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + 2 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 3 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    rig.accounts.push(account('acct-3', 'work3'));
    rig.bodies.set('acct-3', httpStatus(500));
    await rig.cycle(T0 + 10 * M);
    rig.bodies.set('acct-3', sessionBody(100, T0 + 4 * H));
    await rig.cycle(T0 + 15 * M);
    await settle();
    expect(rig.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
    expect(startsAndEnds(await rig.log.read())).toEqual(['exhausted']);
  });

  it('added while the daemon was stopped and rate-limited on its first poll: not back', async () => {
    const before = exhaustedRecord({
      fleet: assessFleet(
        [
          {
            accountId: 'acct-1',
            label: 'work1',
            active: false,
            quarantined: false,
            limits: [{ kind: 'session', percent: 100, resetsAt: T0 + 3 * H }],
          },
          {
            accountId: 'acct-2',
            label: 'work2',
            active: true,
            quarantined: false,
            limits: [{ kind: 'session', percent: 100, resetsAt: T0 + 4 * H }],
          },
        ],
        T0 - 30 * M,
      ),
      now: T0 - 30 * M,
      active: 'work2',
      switches: [],
    });
    const rig = await createRig({
      seedLog: [before],
      accounts: [
        account('acct-1', 'work1'),
        account('acct-2', 'work2'),
        account('acct-3', 'work3'),
      ],
    });
    rig.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    rig.bodies.set('acct-3', httpStatus(429));
    await startAtT0(rig);
    rig.bodies.set('acct-3', sessionBody(100, T0 + 2 * H));
    await rig.cycle(T0 + 40 * M); // past the 429 backoff: work3 reads at the wall
    await settle();
    expect(rig.relay.cards()).toEqual([]);
  });
});

describe('a write that failed for a while', () => {
  /** An outage at T0 that ends at T0+1h05 while the end cannot be written. */
  async function outageWhoseEndFailsToWrite(path: string): Promise<{ rig: Rig; log: FlakyLog }> {
    const log = new FlakyLog(path);
    log.failing = (r) => r.event === 'recovered';
    const rig = await createRig({ log });
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    rig.bodies.set('acct-1', sessionBody(3, T0 + 6 * H));
    await rig.cycle(T0 + H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2); // the phone heard: usage is back
    expect(rig.lines).toContain('could not write the exhaustion log; retrying every cycle');
    expect((await log.read()).map((r) => r.event)).toEqual(['exhausted']);
    return { rig, log };
  }

  it('an end that could not be written lands on the next cycle once the file is writable', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const { rig, log } = await outageWhoseEndFailsToWrite(join(dir, 'exhaustion-log.jsonl'));
    log.failing = () => false;
    await rig.cycle(T0 + H + 10 * M);
    expect((await log.read()).map((r) => r.event)).toEqual(['exhausted', 'recovered']);
    expect(rig.relay.cards()).toHaveLength(2);
  });

  it('an end written on shutdown is not announced again by the next daemon', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const { rig, log } = await outageWhoseEndFailsToWrite(path);
    log.failing = () => false;
    await rig.stop(); // the queued end is written on the way down
    expect((await log.read()).map((r) => r.event)).toEqual(['exhausted', 'recovered']);

    // Days later the daemon starts again; usage has been fine all along.
    const later = T0 + 72 * H;
    const second = await createRig({ logPath: () => path, startAt: later });
    second.bodies.set('acct-1', sessionBody(3, later + 3 * H));
    second.bodies.set('acct-2', sessionBody(3, later + 3 * H));
    await startAtT0(second, later);
    await settle();
    expect(second.relay.cards()).toEqual([]);
  });

  it('after an end written late, the next outage after a restart still gets its start card', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const { rig, log } = await outageWhoseEndFailsToWrite(path);
    log.failing = () => false;
    await rig.stop();

    const later = T0 + 72 * H;
    const second = await createRig({ logPath: () => path, startAt: later });
    second.bodies.set('acct-1', sessionBody(100, later + H));
    second.bodies.set('acct-2', sessionBody(100, later + 2 * H));
    await startAtT0(second, later);
    await settle();
    expect(second.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
  });

  it('a start written late is not announced again by a restart mid-outage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const log = new FlakyLog(path);
    log.failing = (r) => r.event === 'exhausted';
    const first = await createRig({ log });
    first.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    first.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(first);
    await waitFor(() => first.relay.cards().length === 1);
    log.failing = () => false;
    await first.stop();

    const second = await createRig({ logPath: () => path, startAt: T0 + 30 * M });
    second.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    second.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(second, T0 + 30 * M);
    await settle();
    expect(second.relay.cards()).toEqual([]);
  });

  it('a torn last line left by a crash does not swallow the next entry', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    await writeFile(path, '{"v":1,"event":"exhausted","id":"ep-1","at":17');
    const first = await createRig({ logPath: () => path });
    first.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    first.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(first);
    await waitFor(() => first.relay.cards().length === 1);
    expect((await first.log.read()).map((r) => r.event)).toEqual(['exhausted']);
    await first.stop();

    // So a restart mid-outage resumes it instead of announcing it again.
    const second = await createRig({ logPath: () => path, startAt: T0 + 30 * M });
    second.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    second.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(second, T0 + 30 * M);
    await settle();
    expect(second.relay.cards()).toEqual([]);
  });
});

describe('walls kept current through the outage', () => {
  it('a wall hit during the outage keeps it open through an empty poll after the first reset', async () => {
    const rig = await createRig();
    // work1: 99% of its 5-hour window (resets T0+1h), week at 97%. work2: out for the week.
    rig.bodies.set('acct-1', sessionBody(99, T0 + H, 97));
    rig.bodies.set('acct-2', {
      limits: [
        { kind: 'session', percent: 10, resets_at: iso(T0 + 3 * H) },
        { kind: 'weekly_all', percent: 100, resets_at: iso(T0 + 50 * H) },
      ],
    });
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    // The last of the window burns the week to 99%.
    rig.bodies.set('acct-1', sessionBody(100, T0 + H, 99));
    await rig.cycle(T0 + 30 * M);
    // After the window's reset, one empty reading...
    rig.bodies.set('acct-1', {});
    await rig.cycle(T0 + H + 5 * M);
    // ...then a fresh window, but the week is still at the wall.
    rig.bodies.set('acct-1', sessionBody(0, T0 + 6 * H, 99));
    await rig.cycle(T0 + H + 10 * M);
    await settle();
    expect(rig.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
  });

  it('a reset the endpoint moves later dates the end to the later reset', async () => {
    const rig = await createRig();
    const weekly = (percent: number, resetsAt: number) => ({
      limits: [
        { kind: 'session', percent: 0, resets_at: iso(T0 + 4 * H) },
        { kind: 'weekly_all', percent, resets_at: iso(resetsAt) },
      ],
    });
    rig.bodies.set('acct-1', weekly(100, T0 + H));
    rig.bodies.set('acct-2', weekly(100, T0 + 50 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    // Past the reset recorded at the start, work1 still reads at the wall, now until T0+3h.
    rig.bodies.set('acct-1', weekly(100, T0 + 3 * H));
    await rig.cycle(T0 + H + 5 * M);
    await rig.cycle(T0 + 2 * H);
    rig.bodies.set('acct-1', weekly(0, T0 + 171 * H));
    await rig.cycle(T0 + 3 * H + 5 * M);
    await waitFor(() => rig.relay.cards().length === 2);
    // The moved reset was filed as a walls line on the way.
    const records = await rig.log.read();
    expect(records.map((r) => r.event)).toEqual(['exhausted', 'walls', 'recovered']);
    const end = records.find((r) => r.event === 'recovered') as RecoveredRecord;
    expect(end).toMatchObject({ how: 'reset', backSince: T0 + 3 * H, durationMs: 3 * H });
  });
});

describe('a log line this build cannot use', () => {
  it('a structurally broken start is skipped, not resumed, and tracking keeps working', async () => {
    const good = exhaustedRecord({
      fleet: assessFleet(
        [
          {
            accountId: 'acct-1',
            label: 'work1',
            active: false,
            quarantined: false,
            limits: [{ kind: 'session', percent: 100, resetsAt: T0 + H }],
          },
        ],
        T0 - 30 * M,
      ),
      now: T0 - 30 * M,
      active: 'work1',
      switches: [],
    });
    // The same entry with an account's walls cut out by hand.
    const broken = { ...good, accounts: good.accounts.map(({ spent: _spent, ...rest }) => rest) };
    const rig = await createRig({ seedLog: [broken] });
    rig.bodies.set('acct-1', sessionBody(100, T0 + 2 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 3 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    expect(rig.lines).not.toContain('exhaustion tracking failed');
    // Nothing was resumed from the unusable line, so this outage is announced as its own.
    expect(rig.relay.cards().map((c) => c.type)).toEqual(['usage_exhausted']);
  });
});

describe('the phone hears one story', () => {
  it('Fable cap opted out: the plan does not say "No usable account" while no card is sent', async () => {
    const rig = await createRig({ autoSwitchPolicy: { fableCapTriggers: false } });
    const fableCapped = {
      limits: [
        { kind: 'session', percent: 20, resets_at: iso(T0 + 3 * H) },
        { kind: 'weekly_all', percent: 40, resets_at: iso(T0 + 72 * H) },
        { kind: 'weekly_scoped', percent: 100, resets_at: iso(T0 + 30 * H) },
      ],
    };
    rig.bodies.set('acct-1', fableCapped);
    rig.bodies.set('acct-2', fableCapped);
    await startAtT0(rig);
    await settle();
    expect(rig.relay.cards()).toEqual([]);
    expect(rig.relay.lastPlanReason() ?? '').not.toMatch(/^No usable account/);
  });

  it('a crash recovery that rolled a switch forward is part of the walk', async () => {
    const rig = await createRig({
      accounts: [
        account('acct-1', 'work1'),
        account('acct-2', 'work2'),
        account('acct-3', 'work3'),
      ],
      activeId: 'acct-3',
      seedAudit: [
        {
          ts: T0 - 3 * H,
          event: 'activated',
          fromAccountId: 'acct-1',
          toAccountId: 'acct-2',
          origin: 'auto',
          detail: 'work1 at 95% of its 5-hour window',
        },
        // A switch to work3 was torn after its first write; recovery finished it.
        {
          ts: T0 - H,
          event: 'recovered',
          fromAccountId: 'acct-2',
          toAccountId: 'acct-3',
          detail: 'rolled forward',
          origin: 'recovery',
        },
        // A recovery that only cleared a record moved nothing.
        {
          ts: T0 - 30 * M,
          event: 'recovered',
          fromAccountId: 'acct-3',
          toAccountId: null,
          detail: 'cleared at phase writing',
          origin: 'recovery',
        },
      ],
    });
    rig.bodies.set('acct-1', sessionBody(100, T0 + H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 2 * H));
    rig.bodies.set('acct-3', sessionBody(100, T0 + 3 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    const [start] = (await rig.log.read()) as ExhaustedRecord[];
    expect(start?.active).toBe('work3');
    expect(start?.switches.map((sw) => `${sw.from}->${sw.to} ${sw.origin}`)).toEqual([
      'work1->work2 auto',
      'work2->work3 recovery',
    ]);
  });
});

/** work2 is out for the week; its 5-hour window is fine. */
const weekOut = () => ({
  limits: [
    { kind: 'session', percent: 10, resets_at: iso(T0 + 3 * H) },
    { kind: 'weekly_all', percent: 100, resets_at: iso(T0 + 50 * H) },
  ],
});

describe('what the open outage learned, across a restart', () => {
  it('a wall hit mid-outage is filed, so a restart whose first poll is rate-limited keeps it open', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const first = await createRig({ logPath: () => path });
    first.bodies.set('acct-1', sessionBody(99, T0 + H, 97));
    first.bodies.set('acct-2', weekOut());
    await startAtT0(first);
    await waitFor(() => first.relay.cards().length === 1);
    // The last of work1's window burns its week to 99%: a new wall, filed as a walls line.
    first.bodies.set('acct-1', sessionBody(100, T0 + H, 99));
    await first.cycle(T0 + 30 * M);
    expect((await first.log.read()).map((r) => r.event)).toEqual(['exhausted', 'walls']);
    await first.stop();

    // Restarted after work1's 5-hour reset; the restart's first poll of work1 is rate-limited.
    const second = await createRig({ logPath: () => path, startAt: T0 + H + 5 * M });
    second.bodies.set('acct-1', httpStatus(429));
    second.bodies.set('acct-2', weekOut());
    await startAtT0(second, T0 + H + 5 * M);
    // Past the backoff work1 reads: a fresh window, the week still at the wall.
    second.bodies.set('acct-1', sessionBody(0, T0 + 6 * H, 99));
    await second.cycle(T0 + H + 40 * M);
    await settle();
    expect(second.relay.cards()).toEqual([]);
    expect(startsAndEnds(await second.log.read())).toEqual(['exhausted']);
  });

  it('a reset moved later, with the daemon stopped through it, still dates the end to it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const weekly = (percent: number, resetsAt: number) => ({
      limits: [
        { kind: 'session', percent: 0, resets_at: iso(T0 + 4 * H) },
        { kind: 'weekly_all', percent, resets_at: iso(resetsAt) },
      ],
    });
    const first = await createRig({ logPath: () => path });
    first.bodies.set('acct-1', weekly(100, T0 + H));
    first.bodies.set('acct-2', weekly(100, T0 + 50 * H));
    await startAtT0(first);
    await waitFor(() => first.relay.cards().length === 1);
    // Past the reset recorded at the start, work1 still reads at the wall, now until T0+3h.
    first.bodies.set('acct-1', weekly(100, T0 + 3 * H));
    await first.cycle(T0 + H + 5 * M);
    await first.cycle(T0 + 2 * H);
    await first.stop();

    const second = await createRig({ logPath: () => path, startAt: T0 + 5 * H });
    second.bodies.set('acct-1', weekly(0, T0 + 171 * H));
    second.bodies.set('acct-2', weekly(100, T0 + 50 * H));
    await startAtT0(second, T0 + 5 * H);
    await waitFor(() => second.relay.cards().length === 1);
    const end = (await second.log.read()).find((r) => r.event === 'recovered') as RecoveredRecord;
    expect(end).toMatchObject({ how: 'reset', backSince: T0 + 3 * H, durationMs: 3 * H });
  });

  it('a jittering reset (seconds) is not filed again and again', async () => {
    const rig = await createRig();
    rig.bodies.set('acct-1', sessionBody(100, T0 + 2 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 3 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    for (let i = 1; i <= 5; i++) {
      rig.bodies.set('acct-1', sessionBody(100, T0 + 2 * H + (i % 2 === 0 ? 900 : -700)));
      await rig.cycle(T0 + i * 10 * M);
    }
    expect((await rig.log.read()).map((r) => r.event)).toEqual(['exhausted']);
  });
});

/** A log whose next append can be held mid-write, and whose appends can fail. */
class HeldLog extends ExhaustionLog {
  failing = false;
  hold: Promise<void> | undefined;
  entered = 0;
  override async append(record: ExhaustionRecord): Promise<void> {
    if (this.failing) throw new Error('EBUSY: resource busy or locked');
    this.entered++;
    const hold = this.hold;
    this.hold = undefined;
    if (hold !== undefined) await hold;
    return super.append(record);
  }
}

/** A log whose next read fails once, as a file briefly held by a scanner does. */
class ReadFlakyLog extends ExhaustionLog {
  readFailing = false;
  override async read(): Promise<ExhaustionRecord[]> {
    if (this.readFailing) {
      this.readFailing = false;
      throw Object.assign(new Error('EBUSY: resource busy or locked, open'), { code: 'EBUSY' });
    }
    return super.read();
  }
}

describe('the write queue, shutdown and resume', () => {
  it('a shutdown while a cycle is mid-write writes the queued entry once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const log = new HeldLog(join(dir, 'exhaustion-log.jsonl'));
    log.failing = true; // the start cannot be written for now
    const rig = await createRig({ log });
    rig.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);

    // The file frees up; the next cycle starts writing the queued start, slowly...
    log.failing = false;
    let release: () => void = () => {};
    log.hold = new Promise<void>((r) => (release = r));
    const internals = rig.daemon as unknown as { runPollCycle(): Promise<void> };
    const inFlight = internals.runPollCycle().catch(() => {});
    await waitFor(() => log.entered === 1);
    // ...and the daemon is stopped meanwhile; the slow write then completes.
    const stopping = rig.daemon.stop();
    release();
    await stopping;
    await inFlight;
    expect((await log.read()).map((r) => r.event)).toEqual(['exhausted']);
  });

  it('a restart whose first read of the log fails resumes on the next cycle, announcing nothing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, 'exhaustion-log.jsonl');
    const first = await createRig({ logPath: () => path });
    first.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    first.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(first);
    await waitFor(() => first.relay.cards().length === 1);
    await first.stop();

    const log = new ReadFlakyLog(path);
    log.readFailing = true;
    const second = await createRig({ log, startAt: T0 + 30 * M });
    second.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    second.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(second, T0 + 30 * M);
    await settle();
    expect(second.relay.cards()).toEqual([]);
    expect((await log.read()).map((r) => r.event)).toEqual(['exhausted']);
    expect(second.lines).toContain('exhaustion log unreadable; retrying next cycle');
  });
});

describe('shutdown with a write that never settles', () => {
  it('stop() gives up on the queued entry after its bound instead of hanging', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'daemon-exhaustion-shared-'));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const log = new HeldLog(join(dir, 'exhaustion-log.jsonl'));
    log.failing = true; // the start is queued, not written
    const rig = await createRig({ log, sessionStopOnShutdownMs: 200 });
    rig.bodies.set('acct-1', sessionBody(100, T0 + 3 * H));
    rig.bodies.set('acct-2', sessionBody(100, T0 + 4 * H));
    await startAtT0(rig);
    await waitFor(() => rig.relay.cards().length === 1);
    // The file is "free" again, but the write never comes back (a hung network share).
    log.failing = false;
    log.hold = new Promise<void>(() => {});
    const started = Date.now();
    await rig.daemon.stop();
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
