// Text queued for a busy managed session, against the REAL runtime rather than a fake handle. A
// fake accepts a send whenever the test says so; the real session decides for itself, and the
// moments it reports idle are not always moments it can take a send. These cases pin the
// daemon's queue to what the runtime actually does at those moments.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSessionManager } from '@claude-control/session-runtime';
import type { AgentSdkClient, AgentSdkEvent } from '@claude-control/session-runtime';
import { createHarness, waitFor, type Harness } from './testing/sessionDaemonHarness.js';

const SERVER_500 =
  'API Error: 500 Internal server error. This is a server-side issue, usually temporary - try again in a moment.';

let harness: Harness | undefined;
const tempDirs: string[] = [];

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true, maxRetries: 5 })));
  tempDirs.length = 0;
});

/** An SDK client whose first turn holds until released, so a test can act while it is in flight;
 *  every later turn ends cleanly at once. Records each query's prompt. */
function gatedClient(firstTurnEnd: AgentSdkEvent): {
  client: AgentSdkClient;
  prompts: string[];
  release: () => void;
} {
  const prompts: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const client: AgentSdkClient = {
    query(prompt) {
      prompts.push(prompt);
      const first = prompts.length === 1;
      return {
        async *[Symbol.asyncIterator](): AsyncGenerator<AgentSdkEvent> {
          await Promise.resolve();
          yield { type: 'session_init', sessionId: 'sdk-1' };
          if (first) {
            await gate;
            yield firstTurnEnd;
            return;
          }
          yield { type: 'turn_result', ok: true, summary: 'done' };
        },
      };
    },
    interrupt: () => Promise.resolve(),
    end: () => Promise.resolve(),
  };
  return { client, prompts, release };
}

/** Spawn a real managed session behind `client`, then queue `text` while its first turn is still
 *  in flight. Resolves with the session's id once the text is in the queue. */
async function spawnAndQueue(
  client: AgentSdkClient,
  text: string,
  autoContinue?: { schedule: (fn: () => void, ms: number) => () => void },
): Promise<{ h: Harness; sessionId: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), 'daemon-inject-'));
  tempDirs.push(stateDir);
  const manager = createSessionManager({ stateDir });
  const h = await createHarness({
    sessionManager: manager,
    createAgentSdkClient: () => client,
    ...(autoContinue !== undefined ? { autoContinue } : {}),
  });
  harness = h;
  await h.daemon.start();
  h.relay.push({
    daemonId: 'daemon-under-test',
    type: 'session.spawn',
    payload: { requestId: 'req-1', prompt: 'go', idempotencyKey: 'spawn-1' },
  });
  // The spawn's announcing status is sent once the daemon's pipes are attached.
  await waitFor(() => statuses(h).includes('starting'));
  const sessionId = manager.list()[0]?.id;
  if (sessionId === undefined) throw new Error('no session record');
  h.relay.push({
    daemonId: 'daemon-under-test',
    type: 'prompt.inject',
    payload: { sessionId, text, idempotencyKey: 'inject-1' },
  });
  await waitFor(() => h.store.listPendingSteering().length === 1);
  return { h, sessionId };
}

/** The session.status states the daemon sent, in order. */
function statuses(h: Harness): string[] {
  return h.sent.flatMap((e) =>
    e.type === 'session.status' ? [(e.payload as { state: string }).state] : [],
  );
}

describe('Daemon: queued injects against a real managed session', () => {
  it('delivers text queued mid-turn when that turn ends cleanly', async () => {
    const { client, prompts, release } = gatedClient({
      type: 'turn_result',
      ok: true,
      summary: 'first',
    });
    const { h } = await spawnAndQueue(client, 'then run the tests');

    release();
    await waitFor(() => prompts.length === 2);
    expect(prompts).toEqual(['go', 'then run the tests']);
    expect(h.store.listPendingSteering()).toHaveLength(0);
    await waitFor(() => statuses(h).filter((s) => s === 'waiting_input').length === 2);
  });

  it('a stop during an auto-continue backoff ends the session without starting the queued text', async () => {
    const { client, prompts, release } = gatedClient({
      type: 'turn_result',
      ok: false,
      summary: SERVER_500,
    });
    const retries: Array<() => void> = [];
    const { h, sessionId } = await spawnAndQueue(client, 'also do this', {
      schedule: (fn) => {
        retries.push(fn);
        return () => undefined;
      },
    });

    // The transient death schedules a retry and reports no turn boundary, so the text stays queued.
    release();
    await waitFor(() => retries.length === 1);
    expect(h.store.listPendingSteering()).toHaveLength(1);

    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'session.stop',
      payload: { sessionId, idempotencyKey: 'stop-1' },
    });
    await waitFor(() => statuses(h).includes('done'));
    expect(prompts).toEqual(['go']);
    expect(h.store.listPendingSteering()).toHaveLength(0);
    // The stop's interrupt settles the session idle and it ends from there; no turn ran between.
    expect(statuses(h).slice(-2)).toEqual(['waiting_input', 'done']);
  });
});
