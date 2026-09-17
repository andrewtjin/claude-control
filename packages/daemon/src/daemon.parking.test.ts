// What the daemon does around a session PARKED on a usage limit: it is idle, it is not ready
// for work, and the only thing that moves it is a switch to an account with usage left. Every
// case here is about the difference between those two kinds of idle.

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionBusyError, createSessionManager } from '@claude-control/session-runtime';
import type { AgentSdkEvent, SessionRecord } from '@claude-control/session-runtime';
import {
  createHarness,
  fakeManagedHandle,
  fakeSessionManager,
  fakeSwitchEngine,
  scriptedAgentSdkClient,
  waitFor,
  type FakeManagedHandle,
  type Harness,
} from './testing/sessionDaemonHarness.js';

const USAGE_LIMIT = 'Claude usage limit reached. Your limit will reset at 3pm.';

let harness: Harness | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs.length = 0;
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-park-'));
  tempDirs.push(dir);
  return dir;
}

/** Spawn a managed session through the wire (so the daemon attaches its real event pipes) and
 *  hand back the fake handle behind it. */
async function spawnSession(h: Harness, accountId?: string): Promise<FakeManagedHandle> {
  h.relay.push({
    daemonId: 'daemon-under-test',
    type: 'session.spawn',
    payload: {
      requestId: 'req-1',
      prompt: 'go',
      idempotencyKey: 'spawn-1',
      ...(accountId !== undefined ? { accountId } : {}),
    },
  });
  await waitFor(() => h.sessionManager.get('spawned-session') !== undefined);
  return h.sessionManager.get('spawned-session') as FakeManagedHandle;
}

describe('Daemon: queued injects and the usage-limit park', () => {
  beforeEach(async () => {
    harness = await createHarness();
    await harness.daemon.start();
  });

  it('holds queued text while the session is parked, and delivers it only after the resume turn', async () => {
    const h = harness!;
    const handle = await spawnSession(h);
    // Mid-turn: the first /say is refused as busy, which is what puts it in the queue.
    const refused: string[] = [];
    handle.send = (text: string) => {
      refused.push(text);
      return Promise.reject(new SessionBusyError(handle.id));
    };
    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'prompt.inject',
      payload: { sessionId: handle.id, text: 'and then deploy it', idempotencyKey: 'k1' },
    });
    await waitFor(() => refused.length === 1);
    expect(h.store.listPendingSteering()).toHaveLength(1);

    // The turn dies of a usage limit: the session parks. It reports the SAME `waiting_input` a
    // finished turn does — the boundary the queue drains on — but sending here would spend a
    // request on the exhausted account and replace the prompt the kick is holding.
    handle.send = (text: string) => {
      handle.sent.push(text);
      return Promise.resolve();
    };
    handle.setParked(true);
    handle.emit({ kind: 'status', state: 'waiting_input' });
    await waitFor(() => h.sent.some((e) => e.type === 'session.status'));
    expect(handle.sent).toEqual([]);
    // Nothing was consumed: the text is still queued, in memory and on disk.
    expect(h.store.listPendingSteering()).toHaveLength(1);

    // A /switch kicks the park. The runtime replays its own stalled prompt first (the kick, not
    // this queue, is what starts that turn).
    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'sw-1',
        targetAccountId: 'spare',
        reason: 'manual',
        idempotencyKey: 'sw-k1',
      },
    });
    await waitFor(() => handle.kicks === 1);
    expect(handle.sent).toEqual([]);

    // …and when THAT turn reaches its boundary, the queued text finally delivers.
    handle.emit({ kind: 'status', state: 'waiting_input' });
    await waitFor(() => handle.sent.length === 1);
    expect(handle.sent).toEqual(['and then deploy it']);
    expect(h.store.listPendingSteering()).toHaveLength(0);
  });

  it('stamps the account a kicked session was resumed onto, not the one it was spawned on', async () => {
    const h = harness!;
    const handle = await spawnSession(h, 'acct-x');
    handle.setParked(true);

    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'switch.command',
      payload: {
        requestId: 'sw-1',
        targetAccountId: 'spare',
        reason: 'manual',
        idempotencyKey: 'sw-k1',
      },
    });
    await waitFor(() => handle.kicks === 1);

    handle.emit({ kind: 'status', state: 'running' });
    await waitFor(() =>
      h.sent.some(
        (e) =>
          e.type === 'session.status' &&
          (e.payload as { state?: string; accountId?: string }).state === 'running',
      ),
    );
    const status = h.sent
      .filter((e) => e.type === 'session.status')
      .map((e) => e.payload as { state?: string; accountId?: string })
      .find((p) => p.state === 'running');
    // The resumed turn runs on the account just switched to; a frame naming the old one sends
    // the phone (and the session mirror) to the wrong account.
    expect(status?.accountId).toBe('acct-y');
    expect(h.store.getSession('spawned-session')?.accountId).toBe('acct-y');
  });
});

describe('Daemon: what may kick a parked session', () => {
  it('kicks parked sessions when a poll cycle finds the active account changed under it', async () => {
    const switchEngine = fakeSwitchEngine('acct-x');
    const sessionManager = fakeSessionManager();
    const parked = fakeManagedHandle('s-parked', true);
    sessionManager.handles.set(parked.id, parked);
    sessionManager.records.push({
      id: parked.id,
      kind: 'managed',
      state: 'waiting_input',
      startedAtMs: 1,
    });
    harness = await createHarness({ switchEngine, sessionManager, pollIntervalMs: 30 });
    const h = harness;
    await h.daemon.start();

    // The first cycle only LEARNS the active account: starting on one is nobody's switch.
    await waitFor(() => h.sent.filter((e) => e.type === 'usage.snapshot').length >= 1);
    expect(parked.kicks).toBe(0);

    // A local `cctl switch spare` writes the vault directly and never reaches the daemon's
    // switch handler — the poll cycle is the only place it can be noticed at all.
    switchEngine.activeId = 'acct-y';
    await waitFor(() => parked.kicks === 1);
    await waitFor(() =>
      h.sent.some(
        (e) =>
          e.type === 'hook.notification' &&
          (e.payload as { notificationType?: string }).notificationType === 'usage_stall_resumed',
      ),
    );

    // Steady state afterwards: the change was consumed, so later cycles kick nothing again.
    const snapshots = h.sent.filter((e) => e.type === 'usage.snapshot').length;
    await waitFor(() => h.sent.filter((e) => e.type === 'usage.snapshot').length > snapshots + 1);
    expect(parked.kicks).toBe(1);
  });

  it('does NOT kick parked sessions when auto-switch is the one that hopped', async () => {
    const switchEngine = fakeSwitchEngine('acct-x');
    const sessionManager = fakeSessionManager();
    const parked = fakeManagedHandle('s-parked', true);
    sessionManager.handles.set(parked.id, parked);
    sessionManager.records.push({
      id: parked.id,
      kind: 'managed',
      state: 'waiting_input',
      startedAtMs: 1,
    });
    let hopped = false;
    harness = await createHarness({
      switchEngine,
      sessionManager,
      pollIntervalMs: 30,
      autoSwitcher: {
        // One policy hop, exactly what the real AutoSwitcher does to the active account — and
        // REPORTED back the way the real one reports it, which is the daemon's only evidence
        // that this particular hop was its own.
        evaluate: async () => {
          if (hopped) return undefined;
          hopped = true;
          const result = await switchEngine.activate('acct-y', { origin: 'auto' });
          return result.activeAccountId;
        },
      },
    });
    const h = harness;
    await h.daemon.start();

    await waitFor(() => hopped);
    // Several more cycles: auto-switch hopping is not an operator saying "resume my work", so
    // no cycle may read the daemon's own hop as one.
    const snapshots = h.sent.filter((e) => e.type === 'usage.snapshot').length;
    await waitFor(() => h.sent.filter((e) => e.type === 'usage.snapshot').length > snapshots + 2);
    expect(switchEngine.activeId).toBe('acct-y');
    expect(parked.kicks).toBe(0);
  });

  it('kicks on the next cycle for an operator switch that landed mid-cycle', async () => {
    const switchEngine = fakeSwitchEngine('acct-x');
    const sessionManager = fakeSessionManager();
    const parked = fakeManagedHandle('s-parked', true);
    sessionManager.handles.set(parked.id, parked);
    sessionManager.records.push({
      id: parked.id,
      kind: 'managed',
      state: 'waiting_input',
      startedAtMs: 1,
    });
    let landed = false;
    harness = await createHarness({
      switchEngine,
      sessionManager,
      pollIntervalMs: 30,
      autoSwitcher: {
        // The policy hops nothing (so it reports nothing), and while it is deciding, an
        // operator's `cctl switch spare` lands: the vault is rewritten under a cycle that has
        // already read the active account and has not finished. That window is not a sliver —
        // the probe that runs beside this phase can hold it open for minutes — and it is the
        // only window a switch made outside the daemon has to fall into.
        evaluate: () => {
          if (!landed) {
            landed = true;
            switchEngine.activeId = 'acct-y';
          }
          return Promise.resolve(undefined);
        },
      },
    });
    const h = harness;
    await h.daemon.start();
    await waitFor(() => landed);

    // The operator who typed it is as present as the one who taps /switch on the phone, so the
    // session parked on the exhausted account is waiting for exactly this — being swallowed as
    // "something the daemon did" is what leaves it parked forever.
    await waitFor(() => parked.kicks === 1);
    // And it really was nobody's hop but the operator's: the daemon activated nothing.
    expect(switchEngine.activations).toEqual([]);

    // Consumed once, like every other noticed change: later cycles kick nothing again.
    const snapshots = h.sent.filter((e) => e.type === 'usage.snapshot').length;
    await waitFor(() => h.sent.filter((e) => e.type === 'usage.snapshot').length > snapshots + 2);
    expect(parked.kicks).toBe(1);
  });
});

describe('Daemon: auto-continue is what makes a session park at all', () => {
  /** A real managed session (real registry, real runtime) behind a scripted SDK client whose
   *  only turn dies of a usage limit — the one input that parks a session when the policy is on
   *  and fails it when it is off. */
  async function spawnAgainstUsageLimit(autoContinue: boolean): Promise<SessionRecord> {
    const stateDir = await sandbox();
    const manager = createSessionManager({ stateDir });
    const usageLimitTurn: AgentSdkEvent[] = [
      { type: 'session_init', sessionId: 'sdk-1' },
      { type: 'turn_result', ok: false, summary: USAGE_LIMIT },
    ];
    const h = await createHarness({
      sessionManager: manager,
      createAgentSdkClient: () => scriptedAgentSdkClient([usageLimitTurn]),
      // The composition root omits the policy entirely when the operator turns auto-continue
      // off, and that ABSENCE is the whole off switch — so this is exactly what
      // CCTL_AUTO_CONTINUE=0 hands the Daemon.
      ...(autoContinue ? { autoContinue: {} } : {}),
    });
    harness = h;
    await h.daemon.start();
    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.spawn',
      payload: { requestId: 'req-1', prompt: 'go', idempotencyKey: 'spawn-1' },
    });
    // Asserted on the registry rather than the wire: this session's whole (very short) life can
    // run inside the spawn's own `await persist()`, before the daemon has subscribed to it — the
    // record is what both the daemon and the next start read either way.
    await waitFor(() => {
      const state = manager.list()[0]?.state;
      return state === 'failed' || state === 'waiting_input';
    });
    const record = manager.list()[0];
    if (record === undefined) throw new Error('no session record');
    return record;
  }

  it('parks the session when the policy is on', async () => {
    const record = await spawnAgainstUsageLimit(true);
    expect(record.state).toBe('waiting_input');
    // And the park is persisted, which is what lets a later start report it honestly.
    expect(record.parkedOnUsageLimit).toBe(true);
  });

  it('fails the session outright when the policy is off (CCTL_AUTO_CONTINUE=0)', async () => {
    const record = await spawnAgainstUsageLimit(false);
    expect(record.state).toBe('failed');
    expect(record.parkedOnUsageLimit).toBeUndefined();
  });
});
