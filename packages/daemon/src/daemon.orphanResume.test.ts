// Re-attaching a session this daemon did not start: what the daemon owes the operator when a
// previous run's session comes back — and when it cannot come back at all.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionRecord, SessionState } from '@claude-control/session-runtime';
import {
  createHarness,
  fakeSessionManager,
  fakeSwitchEngine,
  waitFor,
  type FakeManagedHandle,
  type FakeSessionManager,
  type Harness,
} from './testing/sessionDaemonHarness.js';

let harness: Harness | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs.length = 0;
});

async function sandbox(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'daemon-resume-'));
  tempDirs.push(dir);
  return dir;
}

/** An orphaned managed record — what a previous daemon run leaves behind for this one. */
function orphanRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 's1',
    kind: 'managed',
    state: 'orphaned',
    startedAtMs: 1,
    resumeId: 'sdk-1',
    ...overrides,
  };
}

/** Make the manager's resumed handle come back in `state`, as if it got there before the daemon
 *  subscribed (emitting with no listener only moves the state). */
function resumeIn(manager: FakeSessionManager, state: SessionState): void {
  const resume = manager.resumeOrphan.bind(manager);
  manager.resumeOrphan = async (sessionId, opts) => {
    const handle = (await resume(sessionId, opts)) as FakeManagedHandle;
    handle.emit({ kind: 'status', state });
    return handle;
  };
}

/** Every session.status state the phone was sent for `sessionId`, in order. */
function statesSent(h: Harness, sessionId: string): Array<string | undefined> {
  return h.sent
    .filter((e) => e.type === 'session.status')
    .map((e) => e.payload as { sessionId?: string; state?: string })
    .filter((p) => p.sessionId === sessionId)
    .map((p) => p.state);
}

function inject(h: Harness, sessionId: string, text: string): void {
  h.relay.push({
    daemonId: 'daemon-under-test',
    type: 'prompt.inject',
    payload: { sessionId, text, idempotencyKey: 'k1' },
  });
}

describe('Daemon: re-attaching an orphaned session', () => {
  it('refuses to re-attach into a working directory that is gone, and says why', async () => {
    const manager = fakeSessionManager();
    // The shape this covers: the session was spawned in a worktree that has since been removed.
    const missing = join(await sandbox(), 'deleted-worktree');
    manager.records.push(orphanRecord({ cwd: missing }));
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    inject(h, 's1', 'pick it up');
    await waitFor(() => h.sent.some((e) => e.type === 'error'));

    const error = h.sent.find((e) => e.type === 'error');
    const payload = error?.payload as { code?: string; message?: string };
    expect(payload.code).toBe('resume_failed');
    expect(payload.message).toContain('working directory does not exist');
    expect(payload.message).toContain(missing);
    // Nothing was launched: a session that re-attaches into a missing directory never produces
    // a first event, so it would sit at `starting` forever with the phone told nothing.
    expect(manager.resumeOrphanCalls).toEqual([]);
  });

  it('re-attaches when the directory is still there', async () => {
    const manager = fakeSessionManager();
    const cwd = await sandbox();
    manager.records.push(orphanRecord({ cwd }));
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    inject(h, 's1', 'pick it up');
    await waitFor(() => manager.resumeOrphanCalls.length === 1);
    expect(manager.resumeOrphanCalls[0]?.opts.prompt).toBe('pick it up');
    expect(h.sent.filter((e) => e.type === 'error')).toEqual([]);
  });

  it('announces the re-attached session as starting before its first event', async () => {
    const manager = fakeSessionManager();
    resumeIn(manager, 'starting');
    manager.records.push(orphanRecord({ cwd: await sandbox() }));
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    inject(h, 's1', 'pick it up');
    // The phone still holds the crashed run's state; a stop before the resumed turn's first
    // event must read as starting -> done, not as a stale idle state -> done.
    await waitFor(() => statesSent(h, 's1').includes('starting'));
  });

  it('reports a resumed turn that already failed as failed, not as starting', async () => {
    const manager = fakeSessionManager();
    // The resumed turn died before the daemon subscribed, e.g. a missing CLI binary.
    resumeIn(manager, 'failed');
    manager.records.push(orphanRecord({ cwd: await sandbox() }));
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    inject(h, 's1', 'pick it up');
    await waitFor(() => statesSent(h, 's1').includes('failed'));
    expect(statesSent(h, 's1')).not.toContain('starting');
    expect(h.store.getSession('s1')?.state).toBe('failed');
  });
});

describe('Daemon: reporting what startup recovery found', () => {
  it('tells the operator when a session that was PARKED did not survive the restart', async () => {
    const manager = fakeSessionManager();
    // What recover() hands back for a session parked on a usage limit when the daemon stopped:
    // revived as an orphan, still carrying the marker so this run can say what happened.
    manager.recovered.push(orphanRecord({ parkedOnUsageLimit: true }));
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    await waitFor(() =>
      h.sent.some(
        (e) =>
          e.type === 'hook.notification' &&
          (e.payload as { notificationType?: string }).notificationType === 'usage_stall_lost',
      ),
    );
    const card = h.sent
      .filter((e) => e.type === 'hook.notification')
      .map((e) => e.payload as { sessionId?: string; body?: string; notificationType?: string })
      .find((p) => p.notificationType === 'usage_stall_lost');
    // The promise it was made ("it resumes after a switch") is no longer keepable by a switch,
    // so the card has to name the session and what will bring it back instead.
    expect(card?.sessionId).toBe('s1');
    expect(card?.body).toContain('parked on a usage limit');
    expect(card?.body).toContain('Send it a message');
  });

  it('says nothing extra about an ordinary orphan', async () => {
    const manager = fakeSessionManager();
    manager.recovered.push(orphanRecord());
    harness = await createHarness({ sessionManager: manager });
    const h = harness;
    await h.daemon.start();

    // Wait for a full poll cycle so the daemon has demonstrably finished its startup work.
    await waitFor(() => h.sent.some((e) => e.type === 'usage.snapshot'));
    expect(
      h.sent.filter(
        (e) =>
          e.type === 'hook.notification' &&
          (e.payload as { notificationType?: string }).notificationType === 'usage_stall_lost',
      ),
    ).toEqual([]);
  });
});

describe('Daemon: re-attaching a session whose account runs a parallel session', () => {
  it('refuses with the reason, and never re-attaches it on the global slot', async () => {
    const manager = fakeSessionManager();
    const cwd = await sandbox();
    manager.records.push(orphanRecord({ cwd, accountId: 'acct-y' }));
    const engine = fakeSwitchEngine();
    engine.leaseOf = (id: string) =>
      Promise.resolve(
        id === 'acct-y'
          ? {
              ruleId: 'session-acct-y',
              accountId: id,
              label: 'spare',
              profileDir: '/profiles/session-acct-y',
              startedAtMs: 0,
              holders: [],
            }
          : undefined,
      );
    harness = await createHarness({ sessionManager: manager, switchEngine: engine });
    const h = harness;
    await h.daemon.start();

    inject(h, 's1', 'pick it up');
    await waitFor(() => h.sent.some((e) => e.type === 'error'));

    const payload = h.sent.find((e) => e.type === 'error')?.payload as {
      code?: string;
      message?: string;
    };
    expect(payload.code).toBe('resume_failed');
    expect(payload.message).toContain(
      'account "spare" is in use by a parallel session (a terminal, or a background session or ' +
        'Claude Code process it started)',
    );
    expect(manager.resumeOrphanCalls).toEqual([]);
  });
});
