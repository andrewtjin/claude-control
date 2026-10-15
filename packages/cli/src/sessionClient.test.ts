import { describe, it, expect, afterEach } from 'vitest';
import { createServer } from 'node:http';
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
  type UsageRepollVerdict,
} from '@claude-control/daemon';
import { InsecurePassthroughProtector, type Protector } from '@claude-control/switch-engine';
import {
  callDaemonSession,
  callDaemonUsageRepoll,
  resolveSessionId,
  SessionClientError,
} from './sessionClient.js';

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

describe('callDaemonUsageRepoll', () => {
  /** A real receiver with the session harness's secret and endpoint, whose usage refresh records
   *  what it was asked and answers with `results`. */
  async function usageHarness(
    results: UsageRepollVerdict[],
  ): Promise<{ deps: { dataDir: string; protector: Protector }; asked: unknown[] }> {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    const asked: unknown[] = [];
    h.receiver.setUsageHandlers({
      repollUsage: (ids) => {
        asked.push(ids);
        return Promise.resolve({ ok: true, results });
      },
    });
    return { deps: { dataDir: h.dataDir, protector: h.protector }, asked };
  }

  it('asks for every account when given no ids and returns the verdicts', async () => {
    const results: UsageRepollVerdict[] = [
      { id: 'a', outcome: 'scheduled' },
      { id: 'b', outcome: 'skipped', reason: 'floor', dueAtMs: 123 },
    ];
    const h = await usageHarness(results);
    expect(await callDaemonUsageRepoll(undefined, h.deps)).toEqual({ ok: true, results });
    expect(h.asked).toEqual([undefined]);
  });

  it('passes the named ids through', async () => {
    const h = await usageHarness([{ id: 'ghost', outcome: 'skipped', reason: 'unknown' }]);
    const answer = await callDaemonUsageRepoll(['ghost'], h.deps);
    expect(answer.results).toEqual([{ id: 'ghost', outcome: 'skipped', reason: 'unknown' }]);
    expect(h.asked).toEqual([['ghost']]);
  });

  it('refuses an empty id without asking the daemon', async () => {
    const h = await usageHarness([]);
    await expect(callDaemonUsageRepoll([''], h.deps)).rejects.toThrow(
      'an account id to refresh is empty',
    );
    expect(h.asked).toEqual([]);
  });

  it('fails with the actionable message when the daemon has never run', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }), {
      writeSecret: false,
    });
    const err = await callDaemonUsageRepoll(undefined, {
      dataDir: h.dataDir,
      protector: h.protector,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionClientError);
    expect((err as Error).message).toMatch(/never run on this machine/);
  });

  const OLDER_DAEMON =
    'the running daemon is older than this cctl and cannot refresh usage on demand - ' +
    'restart it with `cctl daemon restart`';

  /**
   * Point the client at a stand-in daemon that refuses every request with `status` and `error`,
   * and return the message the client failed with plus what the stand-in was sent. The secret it
   * expects is the real one the harness wrote, so a request that forgot it would show here.
   */
  async function refusedWith(
    status: number,
    error: string,
  ): Promise<{
    message: string;
    failure: string;
    url: string | undefined;
    secretSent: boolean;
  }> {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    const secret = await loadOrCreateHookSecret({
      filePath: hookSecretPath(h.dataDir),
      protector: h.protector,
    });
    let url: string | undefined;
    let secretSent = false;
    const standIn = createServer((req, res) => {
      url = req.url;
      secretSent = req.headers['x-claude-control-secret'] === secret;
      req.resume();
      req.on('end', () => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error }));
      });
    });
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    try {
      const address = standIn.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      await writeHookEndpoint(hookEndpointPath(h.dataDir), { port: address.port });
      const err = await callDaemonUsageRepoll(undefined, {
        dataDir: h.dataDir,
        protector: h.protector,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(SessionClientError);
      return {
        message: (err as Error).message,
        failure: (err as SessionClientError).failure,
        url,
        secretSent,
      };
    } finally {
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
  }

  it('says a daemon from before the route cannot refresh, instead of its session complaint', async () => {
    // A daemon from before the route reads it as a session command: no usage handler, and the
    // session-shape check refuses it with a 400.
    expect(await refusedWith(400, 'sessionId and idempotencyKey are required')).toEqual({
      message: OLDER_DAEMON,
      failure: 'older_daemon',
      url: '/cli/usage/repoll',
      secretSent: true,
    });
  });

  it('says the same for a daemon that answers the route as an unknown endpoint', async () => {
    const answer = await refusedWith(404, 'unknown CLI endpoint "/cli/usage/repoll"');
    expect(answer.message).toBe(OLDER_DAEMON);
  });

  it("keeps the daemon's own words for a stale secret, which no restart of the daemon fixes", async () => {
    expect(await refusedWith(401, 'invalid secret')).toMatchObject({
      message: 'invalid secret',
      failure: 'refused',
    });
  });

  it("keeps the daemon's own words for any other 400 a current daemon gives", async () => {
    expect((await refusedWith(400, 'malformed body: body too large')).message).toBe(
      'malformed body: body too large',
    );
    expect((await refusedWith(400, 'ids must be a list of account ids')).message).toBe(
      'ids must be a list of account ids',
    );
  });

  it('an id list over the daemon body cap is reported as too large, not as an older daemon', async () => {
    const h = await usageHarness([]);
    // About 1.2 MB of ids: past the receiver's 1 MB cap, which a current daemon refuses with 400.
    const ids = Array.from(
      { length: 30_000 },
      (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    );
    const err = await callDaemonUsageRepoll(ids, h.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionClientError);
    expect((err as Error).message).toBe('malformed body: body too large');
    expect(h.asked).toEqual([]);
  });

  it("surfaces the daemon's own words for any other refusal", async () => {
    // No usage handler installed: the receiver answers 503 while the daemon is starting.
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    await expect(
      callDaemonUsageRepoll(undefined, { dataDir: h.dataDir, protector: h.protector }),
    ).rejects.toThrow('daemon is starting; retry in a moment');
  });
});

describe('a daemon that takes the request and never answers', () => {
  /**
   * Point the client at a stand-in that accepts every connection and, depending on `stall`,
   * either never writes a byte or sends its headers and then stalls the body. Returns the error
   * the call failed with and how long it took.
   */
  async function askStalled(
    stall: 'headers' | 'body',
    call: (deps: {
      dataDir: string;
      protector: Protector;
      requestTimeoutMs: number;
    }) => Promise<unknown>,
  ): Promise<{ err: unknown; elapsedMs: number }> {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    const sockets = new Set<import('node:net').Socket>();
    const standIn = createServer((req, res) => {
      req.resume();
      if (stall === 'body') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{"ok":');
      }
      // Otherwise: nothing at all, the wedged-event-loop shape.
    });
    standIn.on('connection', (socket) => sockets.add(socket));
    await new Promise<void>((resolve) => standIn.listen(0, '127.0.0.1', resolve));
    try {
      const address = standIn.address();
      if (address === null || typeof address === 'string') throw new Error('no address');
      await writeHookEndpoint(hookEndpointPath(h.dataDir), { port: address.port });
      const started = Date.now();
      const err = await call({
        dataDir: h.dataDir,
        protector: h.protector,
        requestTimeoutMs: 300,
      }).then(
        () => undefined,
        (e: unknown) => e,
      );
      return { err, elapsedMs: Date.now() - started };
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => standIn.close(() => resolve()));
    }
  }

  it('gives up on the usage refresh after the timeout, saying the daemon may be stuck', async () => {
    const { err, elapsedMs } = await askStalled('headers', (deps) =>
      callDaemonUsageRepoll(undefined, deps),
    );
    expect(err).toBeInstanceOf(SessionClientError);
    expect((err as SessionClientError).failure).toBe('hung');
    expect((err as Error).message).toMatch(
      /^the daemon on 127\.0\.0\.1:\d+ took the request but did not answer within 300 ms - it may be stuck; `cctl daemon restart` restarts it$/,
    );
    // Bounded by the timeout, not by the test runner's own limit.
    expect(elapsedMs).toBeLessThan(5_000);
  });

  it('gives up the same way when the headers come and the body stalls', async () => {
    const { err } = await askStalled('body', (deps) => callDaemonUsageRepoll(undefined, deps));
    expect((err as SessionClientError).failure).toBe('hung');
  });

  it('bounds a session command too, since every route goes through one path', async () => {
    const { err } = await askStalled('headers', (deps) =>
      callDaemonSession('register', { sessionId: 's', idempotencyKey: 'k' }, deps),
    );
    expect((err as SessionClientError).failure).toBe('hung');
  });

  it('defaults to the five-second bound daemon stop uses', async () => {
    const { DEFAULT_REQUEST_TIMEOUT_MS } = await import('./daemonControl.js');
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5_000);
  });
});

describe('what kind of failure each daemon call reports', () => {
  it('reads a daemon that never ran, or one that is gone, as down', async () => {
    const never = await harness(() => ({ ok: true, status: 'applied', session: view }), {
      writeSecret: false,
    });
    const neverErr = await callDaemonUsageRepoll(undefined, {
      dataDir: never.dataDir,
      protector: never.protector,
    }).catch((e: unknown) => e);
    expect((neverErr as SessionClientError).failure).toBe('down');

    const gone = await harness(() => ({ ok: true, status: 'applied', session: view }));
    await gone.receiver.close();
    receivers = receivers.filter((r) => r !== gone.receiver);
    const goneErr = await callDaemonUsageRepoll(undefined, {
      dataDir: gone.dataDir,
      protector: gone.protector,
    }).catch((e: unknown) => e);
    expect((goneErr as SessionClientError).failure).toBe('down');
  });

  it('reads a current daemon refusing in its own words as refused', async () => {
    const h = await harness(() => ({ ok: true, status: 'applied', session: view }));
    // No usage handler installed on a current receiver: a 503 refusal in its own words.
    const err = await callDaemonUsageRepoll(undefined, {
      dataDir: h.dataDir,
      protector: h.protector,
    }).catch((e: unknown) => e);
    expect((err as SessionClientError).failure).toBe('refused');
  });
});
