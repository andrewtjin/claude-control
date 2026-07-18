import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { EnvelopeDraft } from '@claude-control/shared-protocol';
import { Store } from './store.js';
import { HookReceiver } from './hookReceiver.js';

interface RawResponse {
  status: number;
  body: unknown;
}

/** POST helper against the real loopback server — no mocking of node:http itself, since the
 *  properties under test (secret enforcement, malformed-body handling) live at that boundary. */
function post(
  port: number,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          let parsed: unknown = undefined;
          try {
            parsed = raw ? JSON.parse(raw) : undefined;
          } catch {
            parsed = raw;
          }
          resolve({ status: res.statusCode ?? 0, body: parsed });
        });
      },
    );
    req.on('error', reject);
    req.end(payload);
  });
}

const SECRET = 'test-secret-abc';

describe('HookReceiver', () => {
  let store: Store;
  let receiver: HookReceiver;
  let port: number;
  let emitted: EnvelopeDraft[];

  beforeEach(async () => {
    store = new Store(':memory:');
    emitted = [];
    receiver = new HookReceiver({
      store,
      secret: SECRET,
      emit: (draft) => emitted.push(draft),
      daemonId: () => 'daemon-1',
      clock: () => 1_000_000,
    });
    port = await receiver.listen(0);
  });

  afterEach(async () => {
    await receiver.close();
    store.close();
  });

  describe('secret enforcement', () => {
    it('rejects a request with no secret header', async () => {
      const res = await post(port, '/', { event: 'Stop' });
      expect(res.status).toBe(401);
    });

    it('rejects a request with the wrong secret', async () => {
      const res = await post(port, '/', { event: 'Stop' }, { 'x-claude-control-secret': 'wrong' });
      expect(res.status).toBe(401);
    });

    it('accepts a request with the correct secret', async () => {
      const res = await post(port, '/', { event: 'Stop' }, { 'x-claude-control-secret': SECRET });
      expect(res.status).toBe(200);
    });
  });

  describe('malformed body', () => {
    it('rejects non-JSON bodies', async () => {
      const res = await post(port, '/', '{not json', { 'x-claude-control-secret': SECRET });
      expect(res.status).toBe(400);
    });

    it('rejects a JSON body that is not an object', async () => {
      const res = await post(port, '/', [1, 2, 3], { 'x-claude-control-secret': SECRET });
      expect(res.status).toBe(400);
    });

    it('rejects a hook event body missing required fields', async () => {
      const res = await post(
        port,
        '/',
        { event: 'PermissionRequest' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(400);
    });

    it('rejects an unrecognized event name', async () => {
      const res = await post(
        port,
        '/',
        { event: 'SomethingElse' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('PermissionRequest -> emits + persists', () => {
    it('persists a pending permission and emits permission.request + hook.notification', async () => {
      const res = await post(
        port,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-1',
          sessionId: 'sess-1',
          tool: 'Bash',
          summary: 'run rm -rf /tmp/x',
          cwd: '/tmp',
        },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);

      const row = store.getPendingPermission('req-1');
      expect(row).toBeDefined();
      expect(row?.resolvedDecision).toBeNull();

      expect(emitted).toHaveLength(2);
      expect(emitted[0]?.type).toBe('permission.request');
      if (emitted[0]?.type === 'permission.request') {
        expect(emitted[0].payload.requestId).toBe('req-1');
        expect(emitted[0].payload.cwd).toBe('/tmp');
      }
      expect(emitted[1]?.type).toBe('hook.notification');
    });
  });

  describe('Stop / Notification -> emit hook.notification', () => {
    it('Stop emits a hook.notification', async () => {
      const res = await post(
        port,
        '/',
        { event: 'Stop', sessionId: 'sess-1' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(emitted).toHaveLength(1);
      expect(emitted[0]?.type).toBe('hook.notification');
      if (emitted[0]?.type === 'hook.notification') {
        expect(emitted[0].payload.event).toBe('stop');
      }
    });

    it('Notification emits a hook.notification', async () => {
      const res = await post(
        port,
        '/',
        { event: 'Notification', body: 'hello' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(emitted[0]?.type).toBe('hook.notification');
      if (emitted[0]?.type === 'hook.notification') {
        expect(emitted[0].payload.event).toBe('notification');
        expect(emitted[0].payload.body).toBe('hello');
      }
    });
  });

  describe('resolvePermission via /resolve-permission', () => {
    async function requestPermission(requestId: string): Promise<void> {
      const res = await post(
        port,
        '/',
        { event: 'PermissionRequest', requestId, sessionId: 's', tool: 'Bash', summary: 'x' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
    }

    it('a valid pending requestId can be resolved exactly once', async () => {
      await requestPermission('req-a');
      const first = await post(
        port,
        '/resolve-permission',
        { requestId: 'req-a', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ ok: true });
      expect(store.getPendingPermission('req-a')?.resolvedDecision).toBe('allow');
    });

    it('rejects an UNKNOWN requestId with ok:false — never applies an unsolicited approval', async () => {
      const res = await post(
        port,
        '/resolve-permission',
        { requestId: 'never-requested', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ ok: false });
    });

    it('rejects a double-resolve of the same requestId', async () => {
      await requestPermission('req-b');
      const first = await post(
        port,
        '/resolve-permission',
        { requestId: 'req-b', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(first.status).toBe(200);

      const second = await post(
        port,
        '/resolve-permission',
        { requestId: 'req-b', decision: 'deny' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(second.status).toBe(409);
      expect(second.body).toMatchObject({ ok: false });
      // The FIRST decision sticks — the second call must not have overwritten it.
      expect(store.getPendingPermission('req-b')?.resolvedDecision).toBe('allow');
    });

    it('rejects an EXPIRED requestId even though it was never resolved', async () => {
      let now = 1_000_000;
      const expiringReceiver = new HookReceiver({
        store,
        secret: SECRET,
        emit: () => {},
        daemonId: () => 'daemon-1',
        clock: () => now,
        permissionTtlMs: 1000,
      });
      const expiringPort = await expiringReceiver.listen(0);
      try {
        await post(
          expiringPort,
          '/',
          {
            event: 'PermissionRequest',
            requestId: 'req-exp',
            sessionId: 's',
            tool: 'Bash',
            summary: 'x',
          },
          { 'x-claude-control-secret': SECRET },
        );
        now += 5000; // well past the 1000ms TTL
        const res = await post(
          expiringPort,
          '/resolve-permission',
          { requestId: 'req-exp', decision: 'allow' },
          { 'x-claude-control-secret': SECRET },
        );
        expect(res.status).toBe(409);
        expect(res.body).toMatchObject({ ok: false });
      } finally {
        await expiringReceiver.close();
      }
    });

    it('rejects a resolve request missing requestId or decision', async () => {
      const res = await post(
        port,
        '/resolve-permission',
        { requestId: 'req-c' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(400);
    });
  });

  describe('getPort', () => {
    it('reports the same port listen() resolved with', () => {
      expect(receiver.getPort()).toBe(port);
    });

    it('reports undefined before listen() has ever been called', () => {
      const fresh = new HookReceiver({
        store,
        secret: SECRET,
        emit: () => {},
        daemonId: () => 'd',
      });
      expect(fresh.getPort()).toBeUndefined();
    });

    it('reports undefined again after close()', async () => {
      const other = new HookReceiver({
        store,
        secret: SECRET,
        emit: () => {},
        daemonId: () => 'd',
      });
      await other.listen(0);
      await other.close();
      expect(other.getPort()).toBeUndefined();
    });
  });
});
