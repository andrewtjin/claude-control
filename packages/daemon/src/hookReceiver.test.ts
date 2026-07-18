import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request } from 'node:http';
import type { EnvelopeDraft } from '@claude-control/shared-protocol';
import { Store } from './store.js';
import {
  HookReceiver,
  type HookReceiverCliHandlers,
  type SessionCommandResult,
} from './hookReceiver.js';

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

/** Poll until `get` yields a value — permission POSTs are now HELD open awaiting a decision,
 *  so tests observe their side effects (emitted envelopes) while the response is in flight. */
async function waitFor<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

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
      // Long enough that a mid-hold resolve is never raced by the lapse; tests that WANT a
      // lapse build their own receiver with a tiny hold. afterEach's close() answers any
      // still-held responses neutrally, so no test hangs on an unresolved hold.
      permissionHoldMs: 3000,
      // Notification forwarding is opt-in (off by default); the harness opts in so the
      // forwarding-shape tests below exercise the wire payload. The default-off behavior has
      // its own describe with a dedicated receiver.
      forwardNotificationCards: true,
      // Command cards default ON; the harness turns them off so the watch-mechanics tests
      // observe ONLY the one-shot watch (and so the off knob itself is exercised). The
      // default-on behavior has its own describe with a dedicated receiver.
      commandOutputCards: false,
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

  describe('PermissionRequest -> emits + persists (response held)', () => {
    it('persists a pending permission and emits permission.request + hook.notification', async () => {
      const held = post(
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
      await waitFor(() => emitted.find((e) => e.type === 'permission.request'));

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

      // Complete the hold so the held socket doesn't outlive the test.
      await post(
        port,
        '/resolve-permission',
        { requestId: 'req-1', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect((await held).status).toBe(200);
    });

    it('threads permission_mode into the permission.request payload (mode-aware cards)', async () => {
      void post(
        port,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-mode',
          sessionId: 'sess-1',
          tool: 'Bash',
          summary: 'run something',
          permission_mode: 'default',
        },
        { 'x-claude-control-secret': SECRET },
      );
      const req = await waitFor(() => emitted.find((e) => e.type === 'permission.request'));
      expect(req.type).toBe('permission.request');
      if (req.type === 'permission.request') {
        expect(req.payload.permissionMode).toBe('default');
      }
    });

    it('omits permissionMode entirely when the hook payload has no mode', async () => {
      void post(
        port,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-nomode',
          sessionId: 'sess-1',
          tool: 'Bash',
          summary: 'run something',
        },
        { 'x-claude-control-secret': SECRET },
      );
      const req = await waitFor(() => emitted.find((e) => e.type === 'permission.request'));
      if (req.type === 'permission.request') {
        // exactOptionalPropertyTypes: absent, not `undefined`.
        expect('permissionMode' in req.payload).toBe(false);
      }
    });
  });

  describe('PostToolUse output forwarding (watch mechanics; command cards off)', () => {
    /** Drive a full remote approval: hold the permission response, tap allow, await the hold
     *  completing — the receiver has now armed a one-shot output watch for this exact run. */
    async function remoteAllow(
      requestId: string,
      toolInput: Record<string, unknown>,
    ): Promise<void> {
      const held = post(
        port,
        '/',
        {
          event: 'PermissionRequest',
          requestId,
          session_id: 'sess-out',
          tool_name: 'Bash',
          tool_input: toolInput,
        },
        { 'x-claude-control-secret': SECRET },
      );
      await waitFor(() =>
        emitted.find((e) => e.type === 'permission.request' && e.payload.requestId === requestId),
      );
      await post(
        port,
        '/resolve-permission',
        { requestId, decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect((await held).status).toBe(200);
    }

    /** The CLI's real PostToolUse shape: snake_case fields, per-tool `tool_response`. */
    function postToolUse(
      toolInput: Record<string, unknown>,
      toolResponse: unknown,
    ): Promise<RawResponse> {
      return post(
        port,
        '/',
        {
          hook_event_name: 'PostToolUse',
          session_id: 'sess-out',
          tool_name: 'Bash',
          tool_input: toolInput,
          tool_response: toolResponse,
        },
        { 'x-claude-control-secret': SECRET },
      );
    }

    const outputCards = () =>
      emitted.flatMap((e) =>
        e.type === 'hook.notification' && e.payload.notificationType === 'tool_output'
          ? [e.payload]
          : [],
      );

    it("forwards a remotely-approved tool's output as a tool_output card", async () => {
      await remoteAllow('req-out-1', { command: 'netstat -ano' });
      const res = await postToolUse(
        { command: 'netstat -ano' },
        { stdout: 'TCP 127.0.0.1:5433 LISTENING 41184', stderr: '' },
      );
      expect(res.status).toBe(200);
      const cards = outputCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.title).toBe('Output — netstat -ano');
      expect(cards[0]?.body).toBe('TCP 127.0.0.1:5433 LISTENING 41184');
      expect(cards[0]?.sessionId).toBe('sess-out');
    });

    it('the watch is one-shot — a repeat of the same command is not forwarded again', async () => {
      await remoteAllow('req-out-2', { command: 'echo hi' });
      await postToolUse({ command: 'echo hi' }, { stdout: 'hi' });
      await postToolUse({ command: 'echo hi' }, { stdout: 'hi again' });
      expect(outputCards()).toHaveLength(1);
    });

    it('with command cards off, a shell run with no armed watch is never forwarded', async () => {
      const res = await postToolUse({ command: 'ls' }, { stdout: 'files' });
      expect(res.status).toBe(200);
      expect(outputCards()).toHaveLength(0);
    });

    it('a remote deny arms nothing', async () => {
      const held = post(
        port,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-out-3',
          session_id: 'sess-out',
          tool_name: 'Bash',
          tool_input: { command: 'rm x' },
        },
        { 'x-claude-control-secret': SECRET },
      );
      await waitFor(() => emitted.find((e) => e.type === 'permission.request'));
      await post(
        port,
        '/resolve-permission',
        { requestId: 'req-out-3', decision: 'deny' },
        { 'x-claude-control-secret': SECRET },
      );
      await held;
      await postToolUse({ command: 'rm x' }, { stdout: 'should never surface' });
      expect(outputCards()).toHaveLength(0);
    });

    it('matches tool_input by content, not key order', async () => {
      await remoteAllow('req-out-4', { command: 'x', timeout: 5 });
      await postToolUse({ timeout: 5, command: 'x' }, 'plain string output');
      const cards = outputCards();
      expect(cards).toHaveLength(1);
      expect(cards[0]?.body).toBe('plain string output');
    });

    it('caps long output with a visible marker and labels empty output honestly', async () => {
      await remoteAllow('req-out-5', { command: 'big' });
      await postToolUse({ command: 'big' }, { stdout: 'x'.repeat(5000) });
      await remoteAllow('req-out-6', { command: 'quiet' });
      await postToolUse({ command: 'quiet' }, { stdout: '   ' });
      const cards = outputCards();
      expect(cards).toHaveLength(2);
      expect(cards[0]?.body.length).toBeLessThan(2000);
      expect(cards[0]?.body).toContain('[truncated]');
      expect(cards[1]?.body).toBe('(no output)');
    });
  });

  describe('shell command output cards (default on, every mode)', () => {
    // A remote operator cannot see the terminal, so shell output must not depend on how the
    // run was approved — no watch, no permission round-trip, any permission mode.
    let cardReceiver: HookReceiver;
    let cardPort: number;
    let cardEmitted: EnvelopeDraft[];

    beforeEach(async () => {
      cardEmitted = [];
      cardReceiver = new HookReceiver({
        store,
        secret: SECRET,
        emit: (draft) => cardEmitted.push(draft),
        daemonId: () => 'daemon-1',
        clock: () => 1_000_000,
        permissionHoldMs: 3000,
        // No commandOutputCards — this describe pins the DEFAULT (on).
      });
      cardPort = await cardReceiver.listen(0);
    });

    afterEach(async () => {
      await cardReceiver.close();
    });

    const cards = () =>
      cardEmitted.flatMap((e) =>
        e.type === 'hook.notification' && e.payload.notificationType === 'tool_output'
          ? [e.payload]
          : [],
      );

    function postTool(
      tool: string,
      toolInput: Record<string, unknown>,
      toolResponse: unknown,
      cwd?: string,
    ): Promise<RawResponse> {
      return post(
        cardPort,
        '/',
        {
          hook_event_name: 'PostToolUse',
          session_id: 'sess-cards',
          tool_name: tool,
          tool_input: toolInput,
          tool_response: toolResponse,
          ...(cwd !== undefined ? { cwd } : {}),
        },
        { 'x-claude-control-secret': SECRET },
      );
    }

    it('forwards a shell command that was never remotely approved', async () => {
      const res = await postTool(
        'Bash',
        { command: 'netstat -ano' },
        { stdout: 'TCP 127.0.0.1:5433 LISTENING 41184', stderr: '' },
      );
      expect(res.status).toBe(200);
      const seen = cards();
      expect(seen).toHaveLength(1);
      expect(seen[0]?.title).toBe('Output — netstat -ano');
      expect(seen[0]?.body).toBe('TCP 127.0.0.1:5433 LISTENING 41184');
      expect(seen[0]?.sessionId).toBe('sess-cards');
    });

    it('forwards a repeated shell command every time — a card per run, not one-shot', async () => {
      await postTool('Bash', { command: 'echo hi' }, { stdout: 'hi' });
      await postTool('Bash', { command: 'echo hi' }, { stdout: 'hi again' });
      expect(cards()).toHaveLength(2);
    });

    it('counts PowerShell as a shell command too', async () => {
      await postTool('PowerShell', { command: 'Get-Date' }, { stdout: 'Thursday' });
      expect(cards()).toHaveLength(1);
    });

    it('never forwards a non-shell tool without a watch', async () => {
      await postTool('Read', { file_path: 'C:/x.txt' }, 'file contents');
      expect(cards()).toHaveLength(0);
    });

    it("relays the hook's cwd so the phone can tell which window produced the output", async () => {
      await postTool('Bash', { command: 'pwd' }, { stdout: '/x' }, 'C:\\repos\\proj');
      await postTool('Bash', { command: 'pwd' }, { stdout: '/x' });
      const seen = cards();
      // A hook that reports no cwd still forwards — the card just loses the folder tag.
      expect(seen[0]?.cwd).toBe('C:\\repos\\proj');
      expect(seen[1]?.cwd ?? undefined).toBeUndefined();
    });

    it('a remotely approved shell run yields exactly ONE card (watch and command card never double up)', async () => {
      const held = post(
        cardPort,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-cards-1',
          session_id: 'sess-cards',
          tool_name: 'Bash',
          tool_input: { command: 'netstat -ano' },
        },
        { 'x-claude-control-secret': SECRET },
      );
      await waitFor(() =>
        cardEmitted.find(
          (e) => e.type === 'permission.request' && e.payload.requestId === 'req-cards-1',
        ),
      );
      await post(
        cardPort,
        '/resolve-permission',
        { requestId: 'req-cards-1', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect((await held).status).toBe(200);
      await postTool('Bash', { command: 'netstat -ano' }, { stdout: 'TCP LISTENING' });
      expect(cards()).toHaveLength(1);
    });

    it('still caps at the phone-sized excerpt by default', async () => {
      await postTool('Bash', { command: 'big' }, { stdout: 'x'.repeat(5000) });
      expect(cards()[0]?.body).toContain('[truncated]');
      expect(cards()[0]?.body.length).toBeLessThan(2000);
    });
  });

  describe('managed-session hook suppression', () => {
    // A managed session already reaches the phone as session.status/session.output (live
    // card, milestone lines, summary card) and decides permissions through the SDK gate —
    // its CLI subprocess inherits the installed hooks, so unsuppressed hook traffic says
    // everything twice (and a held permission hook RACES the SDK's parked request).
    let mgReceiver: HookReceiver;
    let mgPort: number;
    let mgEmitted: EnvelopeDraft[];

    beforeEach(async () => {
      mgEmitted = [];
      mgReceiver = new HookReceiver({
        store,
        secret: SECRET,
        emit: (draft) => mgEmitted.push(draft),
        daemonId: () => 'daemon-1',
        clock: () => 1_000_000,
        permissionHoldMs: 3000,
        isManagedSession: (sessionId) => sessionId === 'sess-managed',
      });
      mgPort = await mgReceiver.listen(0);
    });

    afterEach(async () => {
      await mgReceiver.close();
    });

    const mgCards = () =>
      mgEmitted.flatMap((e) =>
        e.type === 'hook.notification' && e.payload.notificationType === 'tool_output'
          ? [e.payload]
          : [],
      );

    function mgPostTool(sessionId: string): Promise<RawResponse> {
      return post(
        mgPort,
        '/',
        {
          hook_event_name: 'PostToolUse',
          session_id: sessionId,
          tool_name: 'Bash',
          tool_input: { command: 'netstat -ano' },
          tool_response: { stdout: 'TCP LISTENING' },
        },
        { 'x-claude-control-secret': SECRET },
      );
    }

    it("suppresses a managed session's Stop — the summary card already reports it", async () => {
      const res = await post(
        mgPort,
        '/',
        { event: 'Stop', session_id: 'sess-managed', last_assistant_message: 'done' },
        { 'x-claude-control-secret': SECRET },
      );
      // Suppression is a display choice, never a hook failure.
      expect(res.status).toBe(200);
      expect(mgEmitted).toHaveLength(0);
    });

    it('still forwards Stop from an interactive CLI window', async () => {
      await post(
        mgPort,
        '/',
        { event: 'Stop', session_id: 'sess-window' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(mgEmitted.filter((e) => e.type === 'hook.notification')).toHaveLength(1);
    });

    it('suppresses blanket shell output cards for a managed session, not for a window', async () => {
      await mgPostTool('sess-managed');
      expect(mgCards()).toHaveLength(0);
      await mgPostTool('sess-window');
      expect(mgCards()).toHaveLength(1);
    });

    it("answers a managed session's permission hook neutrally — the SDK gate owns the decision", async () => {
      const res = await post(
        mgPort,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-mg-1',
          session_id: 'sess-managed',
          tool_name: 'Bash',
          tool_input: { command: 'netstat -ano' },
        },
        { 'x-claude-control-secret': SECRET },
      );
      // Resolves IMMEDIATELY with a neutral answer: not held for a remote decision, and no
      // card pushed — the SDK's canUseTool card is the one permission card for this run.
      expect(res.status).toBe(200);
      expect(mgEmitted).toHaveLength(0);
    });

    it('still holds a permission from an interactive CLI window for the remote decision', async () => {
      const held = post(
        mgPort,
        '/',
        {
          event: 'PermissionRequest',
          requestId: 'req-mg-2',
          session_id: 'sess-window',
          tool_name: 'Bash',
          tool_input: { command: 'x' },
        },
        { 'x-claude-control-secret': SECRET },
      );
      await waitFor(() =>
        mgEmitted.find(
          (e) => e.type === 'permission.request' && e.payload.requestId === 'req-mg-2',
        ),
      );
      await post(
        mgPort,
        '/resolve-permission',
        { requestId: 'req-mg-2', decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect((await held).status).toBe(200);
    });
  });

  describe('full tool output (CCTL_TOOL_OUTPUT_FULL)', () => {
    let fullReceiver: HookReceiver;
    let fullPort: number;
    let fullEmitted: EnvelopeDraft[];

    beforeEach(async () => {
      fullEmitted = [];
      fullReceiver = new HookReceiver({
        store,
        secret: SECRET,
        emit: (draft) => fullEmitted.push(draft),
        daemonId: () => 'daemon-1',
        clock: () => 1_000_000,
        fullToolOutput: true,
      });
      fullPort = await fullReceiver.listen(0);
    });

    afterEach(async () => {
      await fullReceiver.close();
    });

    const fullCards = () =>
      fullEmitted.flatMap((e) =>
        e.type === 'hook.notification' && e.payload.notificationType === 'tool_output'
          ? [e.payload]
          : [],
      );

    function postShell(toolResponse: unknown): Promise<RawResponse> {
      return post(
        fullPort,
        '/',
        {
          hook_event_name: 'PostToolUse',
          session_id: 'sess-full',
          tool_name: 'Bash',
          tool_input: { command: 'big' },
          tool_response: toolResponse,
        },
        { 'x-claude-control-secret': SECRET },
      );
    }

    it('ships output whole past the excerpt cap — the bot attaches what one message cannot hold', async () => {
      await postShell({ stdout: 'x'.repeat(5000) });
      expect(fullCards()[0]?.body).toBe('x'.repeat(5000));
    });

    it('still bounds the wire: output past the ceiling is cut with a visible marker', async () => {
      await postShell({ stdout: 'x'.repeat(210_000) });
      const body = fullCards()[0]?.body ?? '';
      expect(body).toContain('[truncated]');
      expect(body.length).toBeLessThan(210_000);
    });
  });

  describe('Notification suppression (default: waiting cards off)', () => {
    // The CLI's Notification nags ("Claude is waiting for your input") duplicate the real
    // permission/done cards, so forwarding them is opt-in.
    let quietReceiver: HookReceiver;
    let quietPort: number;
    let quietEmitted: EnvelopeDraft[];

    beforeEach(async () => {
      quietEmitted = [];
      quietReceiver = new HookReceiver({
        store,
        secret: SECRET,
        emit: (draft) => quietEmitted.push(draft),
        daemonId: () => 'daemon-1',
        clock: () => 1_000_000,
        // No forwardNotificationCards — this describe pins the DEFAULT.
      });
      quietPort = await quietReceiver.listen(0);
    });

    afterEach(async () => {
      await quietReceiver.close();
    });

    it('answers a Notification 200 but emits NO card by default', async () => {
      const res = await post(
        quietPort,
        '/',
        { event: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting' },
        { 'x-claude-control-secret': SECRET },
      );
      // Suppression is a display choice, never a hook failure — the CLI must see success.
      expect(res.status).toBe(200);
      expect(quietEmitted).toHaveLength(0);
    });

    it('still forwards Stop (done cards) by default', async () => {
      const res = await post(
        quietPort,
        '/',
        { event: 'Stop', session_id: 'sess-1' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(quietEmitted).toHaveLength(1);
      expect(quietEmitted[0]?.type).toBe('hook.notification');
      if (quietEmitted[0]?.type === 'hook.notification') {
        expect(quietEmitted[0].payload.event).toBe('stop');
      }
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

    it('threads notification_type (e.g. idle_prompt) into the notification card', async () => {
      await post(
        port,
        '/',
        { event: 'Notification', notification_type: 'idle_prompt', body: 'waiting on you' },
        { 'x-claude-control-secret': SECRET },
      );
      const note = emitted.find((e) => e.type === 'hook.notification');
      if (note?.type === 'hook.notification') {
        expect(note.payload.notificationType).toBe('idle_prompt');
      }
    });

    it('Stop threads last_assistant_message and uses it as the body when none is given', async () => {
      await post(
        port,
        '/',
        {
          event: 'Stop',
          sessionId: 'sess-done',
          last_assistant_message: 'All done — I refactored the parser.',
        },
        { 'x-claude-control-secret': SECRET },
      );
      const note = emitted.find((e) => e.type === 'hook.notification');
      if (note?.type === 'hook.notification') {
        expect(note.payload.event).toBe('stop');
        expect(note.payload.lastAssistantMessage).toBe('All done — I refactored the parser.');
        // No explicit body was sent, so the done card falls back to the assistant message.
        expect(note.payload.body).toBe('All done — I refactored the parser.');
      }
    });

    it('an explicit body is not overridden by last_assistant_message on Stop', async () => {
      await post(
        port,
        '/',
        {
          event: 'Stop',
          sessionId: 'sess-done',
          body: 'custom body',
          last_assistant_message: 'assistant said this',
        },
        { 'x-claude-control-secret': SECRET },
      );
      const note = emitted.find((e) => e.type === 'hook.notification');
      if (note?.type === 'hook.notification') {
        expect(note.payload.body).toBe('custom body');
        expect(note.payload.lastAssistantMessage).toBe('assistant said this');
      }
    });
  });

  describe('Stop-hook steering delivery', () => {
    it('answers Stop with block+reason when the steering source has queued text', async () => {
      const taken: string[] = [];
      receiver.setSteeringSource((sessionId) => {
        taken.push(sessionId);
        return sessionId === 'sess-steer' ? 'focus on the failing test' : undefined;
      });

      const res = await post(
        port,
        '/',
        { event: 'Stop', sessionId: 'sess-steer' },
        { 'x-claude-control-secret': SECRET },
      );

      // The CLI's documented Stop contract: block + reason = continue the turn with the
      // reason as guidance. Top-level fields, not hookSpecificOutput.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ decision: 'block', reason: 'focus on the failing test' });
      expect(taken).toEqual(['sess-steer']);
      // No stop card: the session is not stopping, it is continuing.
      expect(emitted).toHaveLength(0);
    });

    it('a Stop with nothing queued keeps the normal neutral answer and stop card', async () => {
      receiver.setSteeringSource(() => undefined);
      const res = await post(
        port,
        '/',
        { event: 'Stop', sessionId: 'sess-idle' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.body).toEqual({ ok: true });
      expect(emitted.some((e) => e.type === 'hook.notification')).toBe(true);
    });

    it('never consults steering for a managed session (SDK send path owns it)', async () => {
      const managed = new Store(':memory:');
      const taken: string[] = [];
      const managedReceiver = new HookReceiver({
        store: managed,
        secret: SECRET,
        emit: () => {},
        daemonId: () => 'daemon-1',
        isManagedSession: () => true,
      });
      managedReceiver.setSteeringSource((sessionId) => {
        taken.push(sessionId);
        return 'must never deliver';
      });
      const managedPort = await managedReceiver.listen(0);
      try {
        const res = await post(
          managedPort,
          '/',
          { event: 'Stop', sessionId: 'managed-1' },
          { 'x-claude-control-secret': SECRET },
        );
        expect(res.body).toEqual({ ok: true });
        expect(taken).toEqual([]);
      } finally {
        await managedReceiver.close();
        managed.close();
      }
    });

    it('Notification events never consume steering, even with text queued', async () => {
      const taken: string[] = [];
      receiver.setSteeringSource((sessionId) => {
        taken.push(sessionId);
        return 'queued text';
      });
      const res = await post(
        port,
        '/',
        { event: 'Notification', sessionId: 'sess-steer', body: 'waiting' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.body).toEqual({ ok: true });
      expect(taken).toEqual([]);
    });
  });

  // The CLI's REAL hook payload contract: snake_case field names
  // (`hook_event_name`, `session_id`, `tool_name`, `tool_input`, `message`) and NO requestId.
  // The camelCase bodies used elsewhere in this file remain supported as internal aliases.
  describe('real CLI payload shape (snake_case)', () => {
    it('accepts a real Stop payload: hook_event_name + session_id + last_assistant_message', async () => {
      const res = await post(
        port,
        '/',
        {
          hook_event_name: 'Stop',
          session_id: 'sess-real',
          transcript_path: 'C:/x/transcript.jsonl',
          cwd: 'C:/x',
          last_assistant_message: 'All done.',
        },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      const note = emitted.find((e) => e.type === 'hook.notification');
      expect(note?.payload).toMatchObject({
        event: 'stop',
        sessionId: 'sess-real',
        body: 'All done.',
      });
    });

    it('accepts a real Notification payload: message becomes the card body', async () => {
      const res = await post(
        port,
        '/',
        {
          hook_event_name: 'Notification',
          session_id: 'sess-real',
          message: 'Claude needs your permission to use Bash',
        },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      const note = emitted.find((e) => e.type === 'hook.notification');
      expect(note?.payload).toMatchObject({
        event: 'notification',
        sessionId: 'sess-real',
        body: 'Claude needs your permission to use Bash',
      });
    });

    it('THE round-trip: holds the hook response and answers it with the allow decision on phone approve', async () => {
      const held = post(
        port,
        '/',
        {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-real',
          tool_name: 'Bash',
          tool_input: { command: 'echo hello' },
          permission_mode: 'default',
          cwd: 'C:/x',
        },
        { 'x-claude-control-secret': SECRET },
      );
      const permission = await waitFor(() => emitted.find((e) => e.type === 'permission.request'));
      expect(permission.payload).toMatchObject({
        sessionId: 'sess-real',
        tool: 'Bash',
        summary: 'echo hello',
        permissionMode: 'default',
        cwd: 'C:/x',
      });
      const requestId = (permission.payload as { requestId: string }).requestId;
      expect(requestId).toBeTruthy(); // minted by the daemon — the CLI sends none

      const resolved = await post(
        port,
        '/resolve-permission',
        { requestId, decision: 'allow' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(resolved.status).toBe(200);

      // The held curl response IS the hook's stdout — the CLI decision schema comes back.
      // Allow echoes the ORIGINAL tool_input as updatedInput (the contract runs the tool
      // with updatedInput; omitting it risks an empty-input run).
      const hookRes = await held;
      expect(hookRes.status).toBe(200);
      expect(hookRes.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow', updatedInput: { command: 'echo hello' } },
        },
      });
      expect(store.getPendingPermission(requestId)?.resolvedDecision).toBe('allow');
    });

    it('a phone deny answers the held response with behavior:deny and a reason', async () => {
      const held = post(
        port,
        '/',
        {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-real',
          tool_name: 'Bash',
          tool_input: { command: 'netstat -ano' },
        },
        { 'x-claude-control-secret': SECRET },
      );
      const permission = await waitFor(() => emitted.find((e) => e.type === 'permission.request'));
      const requestId = (permission.payload as { requestId: string }).requestId;
      await post(
        port,
        '/resolve-permission',
        { requestId, decision: 'deny' },
        { 'x-claude-control-secret': SECRET },
      );
      const hookRes = await held;
      expect(hookRes.body).toEqual({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'denied by remote operator' },
        },
      });
      expect(store.getPendingPermission(requestId)?.resolvedDecision).toBe('deny');
    });

    it('an unanswered hold lapses to a NEUTRAL response (local prompt takes over) and a late tap is rejected', async () => {
      const lapsedEmitted: EnvelopeDraft[] = [];
      const lapsing = new HookReceiver({
        store,
        secret: SECRET,
        emit: (draft) => lapsedEmitted.push(draft),
        daemonId: () => 'daemon-1',
        clock: () => 1_000_000,
        permissionHoldMs: 100,
      });
      const lapsingPort = await lapsing.listen(0);
      try {
        const hookRes = await post(
          lapsingPort,
          '/',
          {
            hook_event_name: 'PermissionRequest',
            session_id: 'sess-real',
            tool_name: 'Bash',
            tool_input: { command: 'echo x' },
          },
          { 'x-claude-control-secret': SECRET },
        );
        // Neutral body: no decision fields → the CLI falls through to its local prompt.
        expect(hookRes.status).toBe(200);
        expect(hookRes.body).toEqual({});

        const permission = lapsedEmitted.find((e) => e.type === 'permission.request');
        const requestId = (permission?.payload as { requestId: string }).requestId;
        const late = await post(
          lapsingPort,
          '/resolve-permission',
          { requestId, decision: 'allow' },
          { 'x-claude-control-secret': SECRET },
        );
        expect(late.status).toBe(409);
        expect(late.body).toMatchObject({ ok: false });
        // No decision was silently recorded for a request nothing applied.
        expect(store.getPendingPermission(requestId)?.resolvedDecision).toBeNull();
      } finally {
        await lapsing.close();
      }
    });

    it('AskUserQuestion is answered immediately with a waiting card, never a permission card', async () => {
      const res = await post(
        port,
        '/',
        {
          hook_event_name: 'PermissionRequest',
          session_id: 'sess-q',
          tool_name: 'AskUserQuestion',
          tool_input: { questions: [{ question: 'Which option do you want?', header: 'Choice' }] },
          permission_mode: 'default',
        },
        { 'x-claude-control-secret': SECRET },
      );
      // Immediate + neutral — a held response would freeze the terminal question UI.
      expect(res.status).toBe(200);
      expect(res.body).toEqual({});
      expect(emitted.some((e) => e.type === 'permission.request')).toBe(false);
      const note = emitted.find((e) => e.type === 'hook.notification');
      expect(note?.payload).toMatchObject({
        event: 'notification',
        sessionId: 'sess-q',
        title: 'Waiting on you: Claude has a question in the terminal',
        body: 'Which option do you want?',
        notificationType: 'question_prompt',
      });
    });

    it('a permission payload with no tool name is still rejected (nothing useful to card)', async () => {
      const res = await post(
        port,
        '/',
        { hook_event_name: 'PermissionRequest', session_id: 'sess-real' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(400);
    });

    it('logs the exact unrecognized event name', async () => {
      const warns: unknown[] = [];
      const logging = new HookReceiver({
        store,
        secret: SECRET,
        emit: () => {},
        daemonId: () => 'daemon-1',
        logger: {
          debug: () => {},
          info: () => {},
          warn: (obj) => warns.push(obj),
          error: () => {},
        },
      });
      const loggingPort = await logging.listen(0);
      try {
        const res = await post(
          loggingPort,
          '/',
          { hook_event_name: 'PreToolUse', session_id: 'sess-real', tool_name: 'Bash' },
          { 'x-claude-control-secret': SECRET },
        );
        expect(res.status).toBe(400);
        expect(warns).toContainEqual(
          expect.objectContaining({ event: 'PreToolUse', sessionId: 'sess-real' }),
        );
      } finally {
        await logging.close();
      }
    });
  });

  describe('resolvePermission via /resolve-permission', () => {
    // Seed the pending row directly — these tests exercise the resolve-side security
    // contract, not the (now held-open) hook POST transport.
    function requestPermission(requestId: string): void {
      store.insertPendingPermission({
        requestId,
        sessionId: 's',
        tool: 'Bash',
        summary: 'x',
        createdAtMs: 1_000_000,
      });
    }

    it('a valid pending requestId can be resolved exactly once', async () => {
      requestPermission('req-a');
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
      requestPermission('req-b');
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
        // Direct row seed — a hook POST would be held open by default now.
        store.insertPendingPermission({
          requestId: 'req-exp',
          sessionId: 's',
          tool: 'Bash',
          summary: 'x',
          createdAtMs: now,
        });
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

  describe('CLI session endpoints (/cli/session/*)', () => {
    // A configurable, call-recording set of CLI handlers — the receiver owns transport; the
    // daemon (faked here) owns the registry logic, so these tests assert only the boundary.
    interface FakeCli {
      handlers: HookReceiverCliHandlers;
      calls: Array<{ verb: string; input: unknown }>;
    }
    function fakeCli(respond: (verb: string, input: unknown) => SessionCommandResult): FakeCli {
      const calls: FakeCli['calls'] = [];
      const make =
        (verb: string) =>
        (input: unknown): Promise<SessionCommandResult> => {
          calls.push({ verb, input });
          return Promise.resolve(respond(verb, input));
        };
      // A handler accepting `unknown` is assignable to one accepting the concrete input type
      // (contravariance), so no cast is needed.
      return {
        calls,
        handlers: {
          registerSession: make('register'),
          labelSession: make('label'),
          watchSession: make('watch'),
          unregisterSession: make('unregister'),
        },
      };
    }

    const okApplied: SessionCommandResult = {
      ok: true,
      status: 'applied',
      session: { id: 'sess-1', kind: 'interactive', state: 'active', watch: true, label: 'work' },
    };

    it('still enforces the secret on CLI routes', async () => {
      receiver.setCliHandlers(fakeCli(() => okApplied).handlers);
      const res = await post(port, '/cli/session/register', {
        sessionId: 'sess-1',
        idempotencyKey: 'k',
      });
      expect(res.status).toBe(401);
    });

    it('returns 503 when the daemon has not installed handlers yet', async () => {
      // The default receiver in beforeEach has no CLI handlers set.
      const res = await post(
        port,
        '/cli/session/register',
        { sessionId: 'sess-1', idempotencyKey: 'k' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(503);
    });

    it('routes register to the handler and echoes its result', async () => {
      const cli = fakeCli(() => okApplied);
      receiver.setCliHandlers(cli.handlers);
      const res = await post(
        port,
        '/cli/session/register',
        { sessionId: 'sess-1', idempotencyKey: 'k1', label: 'work' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ ok: true, status: 'applied' });
      expect(cli.calls).toEqual([
        { verb: 'register', input: { sessionId: 'sess-1', idempotencyKey: 'k1', label: 'work' } },
      ]);
    });

    it('maps an unknown_session result onto a 404 with the daemon message', async () => {
      receiver.setCliHandlers(
        fakeCli(() => ({
          ok: false,
          code: 'unknown_session',
          message: "session 'sess-x' is not registered",
        })).handlers,
      );
      const res = await post(
        port,
        '/cli/session/label',
        { sessionId: 'sess-x', idempotencyKey: 'k', label: 'name' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(404);
      expect(res.body).toMatchObject({ ok: false, code: 'unknown_session' });
    });

    it('rejects a CLI command missing sessionId or idempotencyKey with 400 (handler untouched)', async () => {
      const cli = fakeCli(() => okApplied);
      receiver.setCliHandlers(cli.handlers);
      const noSession = await post(
        port,
        '/cli/session/register',
        { idempotencyKey: 'k' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(noSession.status).toBe(400);
      const noKey = await post(
        port,
        '/cli/session/register',
        { sessionId: 'sess-1' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(noKey.status).toBe(400);
      expect(cli.calls).toHaveLength(0);
    });

    it('rejects label with an empty/missing label, and watch with a non-boolean, as 400', async () => {
      const cli = fakeCli(() => okApplied);
      receiver.setCliHandlers(cli.handlers);
      const emptyLabel = await post(
        port,
        '/cli/session/label',
        { sessionId: 'sess-1', idempotencyKey: 'k', label: '' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(emptyLabel.status).toBe(400);
      const badWatch = await post(
        port,
        '/cli/session/watch',
        { sessionId: 'sess-1', idempotencyKey: 'k', watch: 'yes' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(badWatch.status).toBe(400);
      expect(cli.calls).toHaveLength(0);
    });

    it('accepts watch:false (turning streaming off is a valid boolean)', async () => {
      const cli = fakeCli((_verb, input) => ({
        ok: true,
        status: 'applied',
        session: {
          id: 'sess-1',
          kind: 'interactive',
          state: 'active',
          watch: (input as { watch: boolean }).watch,
        },
      }));
      receiver.setCliHandlers(cli.handlers);
      const res = await post(
        port,
        '/cli/session/watch',
        { sessionId: 'sess-1', idempotencyKey: 'k', watch: false },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(cli.calls).toEqual([
        { verb: 'watch', input: { sessionId: 'sess-1', idempotencyKey: 'k', watch: false } },
      ]);
    });

    it('routes unregister to the handler with the base fields only', async () => {
      const cli = fakeCli(() => okApplied);
      receiver.setCliHandlers(cli.handlers);
      const res = await post(
        port,
        '/cli/session/unregister',
        { sessionId: 'sess-1', idempotencyKey: 'k9' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(200);
      expect(cli.calls).toEqual([
        { verb: 'unregister', input: { sessionId: 'sess-1', idempotencyKey: 'k9' } },
      ]);
    });

    it('404s an unknown /cli/... path', async () => {
      receiver.setCliHandlers(fakeCli(() => okApplied).handlers);
      const res = await post(
        port,
        '/cli/session/bogus',
        { sessionId: 'sess-1', idempotencyKey: 'k' },
        { 'x-claude-control-secret': SECRET },
      );
      expect(res.status).toBe(404);
    });
  });
});
