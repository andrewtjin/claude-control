// Loopback HTTP server that receives Claude Code CLI hook events (PermissionRequest, Stop,
// Notification) and turns them into protocol envelopes for the control-plane client to send.
//
// SECURITY CONTRACT (bot security review, finding #4): the bot deliberately does not
// correlate `permission.response` messages against anything — it just relays what the phone
// says. That means THIS process is the only thing standing between "a stale/forged/duplicate
// approval" and "a tool actually running". `resolvePermission` therefore rejects any
// requestId that is not a currently-pending row: unknown, already-resolved, or expired. An
// unsolicited or replayed approval must never be applied.
//
// WET-GATED: the exact hook event names/payload shapes the installed CLI POSTs are
// reverse-engineered and unconfirmed (see docs/VERIFICATION.md) — hence `eventNames` below is
// configurable rather than hardcoded, and the request body is parsed tolerantly.

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { EnvelopeDraft } from '@claude-control/shared-protocol';
import type { Store } from './store.js';

/** The three hook events the CLI is expected to send, and the header/config the daemon
 *  expects on every request. Configurable because the real names are WET-GATED. */
export interface HookEventNames {
  permissionRequest: string;
  stop: string;
  notification: string;
}

export const DEFAULT_HOOK_EVENT_NAMES: HookEventNames = {
  permissionRequest: 'PermissionRequest',
  stop: 'Stop',
  notification: 'Notification',
};

export interface HookReceiverOptions {
  store: Store;
  /** Shared secret every request must present (see `secretHeader`), minted once per install. */
  secret: string;
  /** Header name carrying the secret. Defaults to `x-claude-control-secret`. */
  secretHeader?: string;
  eventNames?: HookEventNames;
  /** How long a pending permission stays resolvable before it's treated as expired. */
  permissionTtlMs?: number;
  clock?: () => number;
  /** Called with a fully-formed envelope draft whenever a hook produces one — the daemon
   *  wires this to the control-plane client's send/outbox path. Kept synchronous-callback
   *  shaped (no return value) so a slow/failing send can never block the HTTP response. */
  emit: (draft: EnvelopeDraft) => void;
  /** `daemonId` is a routing field on every envelope this receiver emits (see stamp()) — the
   *  daemon's own adopted identity, not something a hook payload could ever supply. */
  daemonId: () => string;
}

export interface ResolvePermissionResult {
  ok: boolean;
  error?: string;
}

const DEFAULT_SECRET_HEADER = 'x-claude-control-secret';
const DEFAULT_PERMISSION_TTL_MS = 15 * 60_000;

/** Tolerant body narrowing helpers — a hook payload is attacker-adjacent (it's whatever the
 *  locally-running CLI sends), so every field is checked before use rather than trusted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export class HookReceiver {
  private readonly store: Store;
  private readonly secret: string;
  private readonly secretHeader: string;
  private readonly eventNames: HookEventNames;
  private readonly permissionTtlMs: number;
  private readonly clock: () => number;
  private readonly emit: (draft: EnvelopeDraft) => void;
  private readonly daemonId: () => string;
  private server: Server | undefined;

  constructor(options: HookReceiverOptions) {
    this.store = options.store;
    this.secret = options.secret;
    this.secretHeader = options.secretHeader ?? DEFAULT_SECRET_HEADER;
    this.eventNames = options.eventNames ?? DEFAULT_HOOK_EVENT_NAMES;
    this.permissionTtlMs = options.permissionTtlMs ?? DEFAULT_PERMISSION_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.emit = options.emit;
    this.daemonId = options.daemonId;
  }

  /** Start listening on 127.0.0.1. `port: 0` (the default) picks an OS-assigned ephemeral
   *  port; resolves once bound, returning the actual port. */
  async listen(port = 0): Promise<number> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch(() => {
        // handleRequest already writes a response on every path it controls; a rejection
        // escaping it means something threw before a response was sent (e.g. a body-read
        // failure) — answer 500 defensively rather than leave the client hanging forever.
        if (!res.writableEnded) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'internal error' }));
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject);
      this.server?.listen(port, '127.0.0.1', () => resolve());
    });
    const address = this.server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('hook receiver has no network address');
    }
    return address.port;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  /** The port actually bound by `listen()` — `undefined` before it has been called, or after
   *  `close()`. Lets a composition root that holds this receiver (but not its internal
   *  server) learn the real, often OS-assigned, port — e.g. to (re)install hooks that must
   *  POST back to this exact address. */
  getPort(): number | undefined {
    const address = this.server?.address();
    return address !== null && typeof address === 'object' ? address.port : undefined;
  }

  /**
   * Record a decision for a pending permission request. Enforces the security contract: only
   * a currently-pending, non-expired request can be resolved, and only once. Returns
   * `{ok:false}` (never throws, never applies) for anything else.
   */
  resolvePermission(requestId: string, decision: 'allow' | 'deny'): ResolvePermissionResult {
    const row = this.store.getPendingPermission(requestId);
    if (!row) return { ok: false, error: 'unknown requestId' };
    if (row.resolvedDecision !== null) return { ok: false, error: 'already resolved' };
    if (this.clock() - row.createdAtMs > this.permissionTtlMs) {
      return { ok: false, error: 'expired' };
    }
    // The store's own WHERE-guarded UPDATE is the actual atomic double-resolve guard; the
    // checks above just produce a specific, honest error message for each rejection reason.
    const changed = this.store.resolvePendingPermission(requestId, decision);
    if (changed === 0) return { ok: false, error: 'already resolved' };
    return { ok: true };
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.respond(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const presented = req.headers[this.secretHeader.toLowerCase()];
    const presentedSecret = Array.isArray(presented) ? presented[0] : presented;
    if (presentedSecret !== this.secret) {
      this.respond(res, 401, { ok: false, error: 'invalid secret' });
      return;
    }

    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.respond(res, 400, { ok: false, error: `malformed body: ${message}` });
      return;
    }
    if (!isRecord(body)) {
      this.respond(res, 400, { ok: false, error: 'body must be a JSON object' });
      return;
    }

    const path = req.url ?? '/';
    if (path === '/resolve-permission') {
      this.handleResolvePermission(body, res);
      return;
    }

    this.handleHookEvent(body, res);
  }

  private handleResolvePermission(body: Record<string, unknown>, res: ServerResponse): void {
    const requestId = str(body.requestId);
    const decision =
      body.decision === 'allow' || body.decision === 'deny' ? body.decision : undefined;
    if (!requestId || !decision) {
      this.respond(res, 400, {
        ok: false,
        error: 'requestId and decision (allow|deny) are required',
      });
      return;
    }
    const result = this.resolvePermission(requestId, decision);
    this.respond(res, result.ok ? 200 : 409, result);
  }

  private handleHookEvent(body: Record<string, unknown>, res: ServerResponse): void {
    const event = str(body.event) ?? str(body.hookEventName);
    if (event === undefined) {
      this.respond(res, 400, { ok: false, error: 'missing event name' });
      return;
    }

    if (event === this.eventNames.permissionRequest) {
      this.handlePermissionRequest(body, res);
      return;
    }
    if (event === this.eventNames.stop) {
      this.handleStopOrNotification(body, res, 'stop');
      return;
    }
    if (event === this.eventNames.notification) {
      this.handleStopOrNotification(body, res, 'notification');
      return;
    }
    this.respond(res, 400, { ok: false, error: `unrecognized event "${event}"` });
  }

  private handlePermissionRequest(body: Record<string, unknown>, res: ServerResponse): void {
    const requestId = str(body.requestId);
    const sessionId = str(body.sessionId);
    const tool = str(body.tool);
    const summary = str(body.summary) ?? tool ?? 'unknown tool';
    if (!requestId || !sessionId || !tool) {
      this.respond(res, 400, { ok: false, error: 'requestId, sessionId, and tool are required' });
      return;
    }

    const now = this.clock();
    this.store.insertPendingPermission({ requestId, sessionId, tool, summary, createdAtMs: now });

    const detail = str(body.detail);
    const cwd = str(body.cwd);
    this.emit({
      daemonId: this.daemonId(),
      type: 'permission.request',
      payload: {
        requestId,
        sessionId,
        tool,
        summary,
        ...(detail !== undefined ? { detail } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        expiresAt: now + this.permissionTtlMs,
      },
    });
    this.emit({
      daemonId: this.daemonId(),
      type: 'hook.notification',
      payload: {
        event: 'permission',
        sessionId,
        title: 'Permission requested',
        body: summary,
        level: 'info',
      },
    });

    this.respond(res, 200, { ok: true });
  }

  private handleStopOrNotification(
    body: Record<string, unknown>,
    res: ServerResponse,
    event: 'stop' | 'notification',
  ): void {
    const sessionId = str(body.sessionId);
    const title = str(body.title) ?? (event === 'stop' ? 'Session stopped' : 'Notification');
    const text = str(body.body) ?? str(body.message) ?? '';
    this.emit({
      daemonId: this.daemonId(),
      type: 'hook.notification',
      payload: {
        event,
        ...(sessionId !== undefined ? { sessionId } : {}),
        title,
        body: text,
        level: 'info',
      },
    });
    this.respond(res, 200, { ok: true });
  }

  private respond(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  }
}

/** Read and JSON-parse a request body, bounded so a misbehaving/malicious sender can't exhaust
 *  memory by streaming forever. */
function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
    req.on('error', reject);
  });
}
