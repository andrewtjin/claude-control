import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HookReceiver,
  Store,
  hookEndpointPath,
  hookSecretPath,
  loadOrCreateHookSecret,
  writeHookEndpoint,
  type HookReceiverCliHandlers,
  type SessionCommandResult,
  type TrackedSessionView,
} from '@claude-control/daemon';
import { InsecurePassthroughProtector, type Protector } from '@claude-control/switch-engine';
import { callDaemonSession, resolveSessionId, SessionClientError } from './sessionClient.js';

// resolveSessionId is pure — no server needed.
describe('resolveSessionId', () => {
  it('prefers the explicit --session flag over everything', () => {
    expect(resolveSessionId({ session: 'flag-id' }, { CLAUDE_SESSION_ID: 'env-id' })).toBe(
      'flag-id',
    );
  });

  it('falls back to CLAUDE_CODE_BRIDGE_SESSION_ID, then CLAUDE_SESSION_ID', () => {
    expect(resolveSessionId({}, { CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge' })).toBe('bridge');
    expect(resolveSessionId({}, { CLAUDE_SESSION_ID: 'legacy' })).toBe('legacy');
    // Bridge wins when both are present.
    expect(
      resolveSessionId(
        {},
        { CLAUDE_CODE_BRIDGE_SESSION_ID: 'bridge', CLAUDE_SESSION_ID: 'legacy' },
      ),
    ).toBe('bridge');
  });

  it('returns undefined when nothing carries a session id', () => {
    expect(resolveSessionId({}, {})).toBeUndefined();
    // Blank/whitespace values do not count.
    expect(resolveSessionId({ session: '   ' }, { CLAUDE_SESSION_ID: '' })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// callDaemonSession against a REAL loopback HookReceiver (house convention: real transports).
// ---------------------------------------------------------------------------

interface Harness {
  dataDir: string;
  protector: Protector;
  receiver: HookReceiver;
  store: Store;
  calls: Array<{ verb: string; input: unknown }>;
}

let dirs: string[] = [];
let receivers: HookReceiver[] = [];
let stores: Store[] = [];

/** Stand up a temp data dir with a real hook secret + published endpoint, plus a real
 *  HookReceiver whose CLI handlers are recorded and answered by `respond`. */
async function harness(
  respond: (verb: string, input: unknown) => SessionCommandResult,
  opts: { writeSecret?: boolean; writeEndpoint?: boolean } = {},
): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'cctl-session-client-'));
  dirs.push(dataDir);
  const protector = new InsecurePassthroughProtector();
  const store = new Store(':memory:');
  stores.push(store);
  const calls: Harness['calls'] = [];

  // The daemon is the sole secret author; write it exactly as the daemon would.
  const secret = await loadOrCreateHookSecret({ filePath: hookSecretPath(dataDir), protector });

  const handlers: HookReceiverCliHandlers = {
    registerSession: (input) => {
      calls.push({ verb: 'register', input });
      return Promise.resolve(respond('register', input));
    },
    labelSession: (input) => {
      calls.push({ verb: 'label', input });
      return Promise.resolve(respond('label', input));
    },
    watchSession: (input) => {
      calls.push({ verb: 'watch', input });
      return Promise.resolve(respond('watch', input));
    },
    unregisterSession: (input) => {
      calls.push({ verb: 'unregister', input });
      return Promise.resolve(respond('unregister', input));
    },
  };

  const receiver = new HookReceiver({
    store,
    secret,
    emit: () => {},
    daemonId: () => 'daemon-test',
  });
  receiver.setCliHandlers(handlers);
  receivers.push(receiver);
  const port = await receiver.listen(0);

  if (opts.writeSecret === false) {
    // Simulate "daemon never ran": remove the secret file the CLI would read.
    await rm(hookSecretPath(dataDir), { force: true });
  }
  if (opts.writeEndpoint !== false) {
    await writeHookEndpoint(hookEndpointPath(dataDir), { port });
  }

  return { dataDir, protector, receiver, store, calls };
}

afterEach(async () => {
  await Promise.all(receivers.map((r) => r.close()));
  receivers = [];
  for (const s of stores) s.close();
  stores = [];
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
  dirs = [];
});

const view: TrackedSessionView = {
  id: 'sess-1',
  kind: 'interactive',
  state: 'active',
  watch: true,
  label: 'work',
};

describe('callDaemonSession', () => {
  it('POSTs a register command and returns the applied result', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    const result = await callDaemonSession(
      'register',
      { sessionId: 'sess-1', idempotencyKey: 'key-1', label: 'work' },
      { dataDir: h.dataDir, protector: h.protector },
    );
    expect(result).toEqual({ ok: true, status: 'applied', session: view });
    expect(h.calls).toEqual([
      { verb: 'register', input: { sessionId: 'sess-1', idempotencyKey: 'key-1', label: 'work' } },
    ]);
  });

  it('POSTs an unregister command and returns the applied result', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    const result = await callDaemonSession(
      'unregister',
      { sessionId: 'sess-1', idempotencyKey: 'key-u' },
      { dataDir: h.dataDir, protector: h.protector },
    );
    expect(result).toEqual({ ok: true, status: 'applied', session: view });
    expect(h.calls).toEqual([
      { verb: 'unregister', input: { sessionId: 'sess-1', idempotencyKey: 'key-u' } },
    ]);
  });

  it("passes the daemon's already_registered status through untouched", async () => {
    const h = await harness(() => ({ ok: true, status: 'already_registered', session: view }));
    const result = await callDaemonSession(
      'register',
      { sessionId: 'sess-1', idempotencyKey: 'key-2' },
      { dataDir: h.dataDir, protector: h.protector },
    );
    expect(result.status).toBe('already_registered');
  });

  it('surfaces a daemon 4xx (unknown_session) as an actionable SessionClientError', async () => {
    const h = await harness(() => ({
      ok: false,
      code: 'unknown_session',
      message: "session 'sess-x' is not registered",
    }));
    await expect(
      callDaemonSession(
        'label',
        { sessionId: 'sess-x', idempotencyKey: 'k', label: 'name' },
        { dataDir: h.dataDir, protector: h.protector },
      ),
    ).rejects.toThrowError(/not registered/);
  });

  it('fails with an actionable message when the secret is missing (daemon never ran)', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }), {
      writeSecret: false,
    });
    await expect(
      callDaemonSession(
        'register',
        { sessionId: 'sess-1', idempotencyKey: 'k' },
        { dataDir: h.dataDir, protector: h.protector },
      ),
    ).rejects.toThrowError(SessionClientError);
    await expect(
      callDaemonSession(
        'register',
        { sessionId: 'sess-1', idempotencyKey: 'k' },
        { dataDir: h.dataDir, protector: h.protector },
      ),
    ).rejects.toThrowError(/cctl daemon run/);
  });

  it('fails with an actionable message when no endpoint is published (daemon not running)', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }), {
      writeEndpoint: false,
    });
    await expect(
      callDaemonSession(
        'watch',
        { sessionId: 'sess-1', idempotencyKey: 'k', watch: true },
        { dataDir: h.dataDir, protector: h.protector },
      ),
    ).rejects.toThrowError(/not running/);
  });

  it('fails with an actionable message when the daemon died but left a stale endpoint', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    // Close the receiver: the endpoint file still points at a now-dead port (connection refused).
    await h.receiver.close();
    receivers = receivers.filter((r) => r !== h.receiver);
    await expect(
      callDaemonSession(
        'register',
        { sessionId: 'sess-1', idempotencyKey: 'k' },
        { dataDir: h.dataDir, protector: h.protector },
      ),
    ).rejects.toThrowError(SessionClientError);
  });
});
