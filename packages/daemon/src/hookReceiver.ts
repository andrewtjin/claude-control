// Loopback HTTP server that receives Claude Code CLI hook events (PermissionRequest, Stop,
// Notification, PostToolUse) and turns them into protocol envelopes for the control-plane
// client to send.
//
// SECURITY CONTRACT: the bot deliberately does not
// correlate `permission.response` messages against anything — it just relays what the phone
// says. That means THIS process is the only thing standing between "a stale/forged/duplicate
// approval" and "a tool actually running". `resolvePermission` therefore rejects any
// requestId that is not a currently-pending row: unknown, already-resolved, or expired. An
// unsolicited or replayed approval must never be applied.
//
// The exact hook event names/payload shapes the installed CLI POSTs are reverse-engineered
// (see docs/VERIFICATION.md) — hence `eventNames` below is configurable rather than
// hardcoded, and the request body is parsed tolerantly. The CLI's hook payload is snake_case
// (`hook_event_name`, `session_id`, `tool_name`, `tool_input`, `message`), so every field
// below reads snake_case FIRST with camelCase fallbacks (unit tests and any internal senders
// use them). The CLI never sends a `requestId` — the daemon mints one, because the
// requestId's real job is correlating OUR pending-permission row with the phone's response,
// not echoing anything the CLI knows about.

import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import type { EnvelopeDraft } from '@claude-control/shared-protocol';
import { type Logger, noopLogger } from '@claude-control/switch-engine';
import type { Store } from './store.js';

/** The hook events the CLI is expected to send, and the header/config the daemon
 *  expects on every request. Configurable because the real names were reverse-engineered from the installed CLI. */
export interface HookEventNames {
  permissionRequest: string;
  stop: string;
  notification: string;
  postToolUse: string;
}

export const DEFAULT_HOOK_EVENT_NAMES: HookEventNames = {
  permissionRequest: 'PermissionRequest',
  stop: 'Stop',
  notification: 'Notification',
  postToolUse: 'PostToolUse',
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
  /** How long a permission hook's HTTP response is held open for a remote decision before a
   *  neutral answer lets the local prompt take over. See DEFAULT_PERMISSION_HOLD_MS. */
  permissionHoldMs?: number;
  /** Forward the CLI's `Notification` hook events ("Claude is waiting for your input",
   *  "Claude needs your permission") as phone cards. Default OFF — they duplicate the real
   *  permission/done cards and read as nag noise; opt back in with CCTL_WAITING_CARDS.
   *  Stop/done cards and the daemon's own emits (quarantine, AskUserQuestion's question
   *  card) are not affected by this switch. */
  forwardNotificationCards?: boolean;
  clock?: () => number;
  /** Called with a fully-formed envelope draft whenever a hook produces one — the daemon
   *  wires this to the control-plane client's send/outbox path. Kept synchronous-callback
   *  shaped (no return value) so a slow/failing send can never block the HTTP response. */
  emit: (draft: EnvelopeDraft) => void;
  /** `daemonId` is a routing field on every envelope this receiver emits (see stamp()) — the
   *  daemon's own adopted identity, not something a hook payload could ever supply. */
  daemonId: () => string;
  /** Observability for live debugging: every inbound POST's outcome
   *  (accepted event, unrecognized event name, auth failure, parse failure) is logged, because
   *  the curl hooks fail SILENTLY on the CLI side — this log is the only place a broken hook
   *  loop is visible at all. Defaults to no-op for unit tests. */
  logger?: Logger;
}

export interface ResolvePermissionResult {
  ok: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// CLI session endpoints (the `cctl session register|label|watch` surface)
// ---------------------------------------------------------------------------
//
// These share the SAME loopback server and the SAME `x-claude-control-secret` gate as the hook
// events — a `cctl` process authenticates with the secret the daemon minted (read-only via the
// CLI's `loadHookSecret`). The receiver owns transport (routing, auth, body validation, mapping
// a domain result onto an HTTP status); the LOGIC (a session registry + idempotency) lives in
// the injected {@link HookReceiverCliHandlers}, so it is unit-testable at the daemon level and
// the receiver stays a thin, auditable boundary — mirroring how `emit`/`resolvePermission`
// already split transport from policy.

/** Fields every mutating CLI command carries: the interactive session it targets, and an
 *  idempotency key so a re-sent request (a network retry, a double-invoked slash command)
 *  resolves to "already handled" instead of applying twice. */
export interface SessionCommandBase {
  sessionId: string;
  idempotencyKey: string;
}
export interface SessionRegisterInput extends SessionCommandBase {
  /** Optional human label to set at registration time (equivalent to a follow-up `label`). */
  label?: string;
}
export interface SessionLabelInput extends SessionCommandBase {
  label: string;
}
export interface SessionWatchInput extends SessionCommandBase {
  /** Per-session Discord-streaming opt-in flag. */
  watch: boolean;
}

/** Compact view of a tracked session, echoed back so the CLI can print a confirmation without
 *  a second round-trip. `kind`/`state` are free-form strings (the daemon stores 'interactive'
 *  for registered sessions, distinct from session-runtime's managed/observed kinds). */
export interface TrackedSessionView {
  id: string;
  kind: string;
  state: string;
  label?: string;
  watch: boolean;
  accountId?: string;
}

/** Outcome of a CLI session command. `applied` = the mutation took effect (or a first
 *  registration); `already_handled` = a duplicate idempotency key, a harmless no-op that still
 *  echoes the current view. A failure names a machine-stable `code` the transport maps to a
 *  4xx — `unknown_session` (a label/watch against a session that was never registered) becomes
 *  404, never a crash. */
export type SessionCommandResult =
  | { ok: true; status: 'applied' | 'already_handled'; session: TrackedSessionView }
  | { ok: false; code: 'unknown_session'; message: string };

/** The session-command logic the daemon installs via {@link HookReceiver.setCliHandlers}. Async
 *  because registration reads the switch engine (for the active-account attribution tag). */
export interface HookReceiverCliHandlers {
  registerSession(input: SessionRegisterInput): Promise<SessionCommandResult>;
  labelSession(input: SessionLabelInput): Promise<SessionCommandResult>;
  watchSession(input: SessionWatchInput): Promise<SessionCommandResult>;
}

/** Exported because the header name doubles as the installer's ownership fingerprint: any
 *  settings.json hook command containing it is one of OURS (some generation of the curl
 *  forwarder), which is what lets installHooks replace stale-port entries across restarts. */
export const DEFAULT_SECRET_HEADER = 'x-claude-control-secret';
const DEFAULT_PERMISSION_TTL_MS = 15 * 60_000;

/** How long a permission hook's HTTP response is held open awaiting a phone decision before
 *  we answer neutrally and let the CLI's local prompt take over. The CLI kills a command hook
 *  after 600s by default (docs: settings.json hook `timeout`, seconds) — the 30s margin keeps
 *  US in control of the lapse (a clean neutral response + honest late-tap rejection) instead
 *  of curl dying and leaving the pending row silently resolvable. Tunable via
 *  CCTL_PERMISSION_HOLD_MS: the hook contract offers exactly ONE decision channel, so while
 *  the hold is open the terminal cannot prompt — a shorter hold trades remote decision time
 *  for a faster local-prompt fallback when the operator is at the keyboard. */
export const DEFAULT_PERMISSION_HOLD_MS = 570_000;

/** Tools whose "permission" is really an interactive terminal exchange, not a remote-decidable
 *  yes/no. Holding these would freeze the terminal UI they need, and an approve/deny card is
 *  nonsense for a question the phone can't answer — so they get a "waiting on you"
 *  notification instead of a permission card, and no hold. */
const INTERACTIVE_PROMPT_TOOLS = new Set(['AskUserQuestion']);

/** How long after a remote allow the matching PostToolUse is still forwarded as an output
 *  card. PostToolUse fires only when the tool FINISHES, so the window must outlast a slow
 *  command (a build, a long test run), not just the approval round-trip. */
const OUTPUT_WATCH_TTL_MS = 10 * 60_000;
/** Upper bound on armed output watches — each remote allow arms exactly one, so hitting this
 *  means watches are leaking (tools approved but never completing); oldest are dropped. */
const OUTPUT_WATCH_CAP = 16;
/** Cap on the output text shipped in the card body. The bot clamps to Discord's limits again,
 *  but the wire shouldn't carry megabytes of stdout to show a phone-sized excerpt. */
const OUTPUT_BODY_MAX = 1500;

/** Tolerant body narrowing helpers — a hook payload is attacker-adjacent (it's whatever the
 *  locally-running CLI sends), so every field is checked before use rather than trusted. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
/** Defensive cap for strings derived from `tool_input` — the protocol schema doesn't cap
 *  summary/detail, but shipping an unbounded JSON blob through the relay to a Discord card
 *  helps nobody. The marker makes the cut visible instead of silent. */
function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}… [truncated]`;
}
/** The first question AskUserQuestion is posing (`tool_input.questions[0].question`), so the
 *  "waiting on you" card can show WHAT is being asked instead of a JSON blob. */
function firstQuestionText(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput || !Array.isArray(toolInput.questions)) return undefined;
  const first: unknown = toolInput.questions[0];
  return isRecord(first) ? str(first.question) : undefined;
}
/** Deterministic identity for a tool_input object, insensitive to key order: both sides of a
 *  watch match (the PermissionRequest's `tool_input` and the later PostToolUse's) come out of
 *  separate JSON.parse calls, and nothing guarantees the CLI serialized them identically. */
function stableKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableKey).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableKey(value[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}
/** The human-readable text inside a PostToolUse `tool_response`. The shape is per-tool and
 *  reverse-engineered (live boundary): Bash sends `{stdout, stderr, ...}`, some tools send a
 *  bare string, others structured objects — so prefer real output streams, fall back to
 *  compact JSON, and never throw on a shape we haven't seen. */
function toolResponseText(toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  if (isRecord(toolResponse)) {
    const stdout = str(toolResponse.stdout);
    const stderr = str(toolResponse.stderr);
    // The presence of stream fields means this IS a command-style response — blank streams
    // are a genuinely silent command, not a shape to fall back to JSON on.
    if (stdout !== undefined || stderr !== undefined) {
      return [stdout, stderr]
        .filter((s): s is string => s !== undefined && s.trim() !== '')
        .join('\n');
    }
    const json = JSON.stringify(toolResponse);
    return json === '{}' ? '' : json;
  }
  if (toolResponse === undefined || toolResponse === null) return '';
  if (typeof toolResponse === 'number' || typeof toolResponse === 'boolean') {
    return String(toolResponse);
  }
  return JSON.stringify(toolResponse);
}
/** Best human line for a permission card, derived from the tool's input: a Bash `command` or
 *  a file path IS the summary a phone reader needs; anything else falls back to compact JSON. */
function summarizeToolInput(toolInput: Record<string, unknown> | undefined): string | undefined {
  if (!toolInput) return undefined;
  const command = str(toolInput.command);
  if (command !== undefined) return truncate(command, 200);
  const filePath = str(toolInput.file_path);
  if (filePath !== undefined) return truncate(filePath, 200);
  const json = JSON.stringify(toolInput);
  return json === '{}' ? undefined : truncate(json, 200);
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
  private readonly logger: Logger;
  private readonly permissionHoldMs: number;
  private readonly forwardNotificationCards: boolean;
  private server: Server | undefined;
  /** Installed by the daemon (post-construction, before `listen`) — see {@link setCliHandlers}.
   *  Undefined until then: a `cctl session` command that races daemon startup gets a clean 503
   *  rather than a crash. */
  private cliHandlers: HookReceiverCliHandlers | undefined;
  /** Permission hook responses currently held open awaiting a phone decision, keyed by the
   *  requestId we minted. `event` echoes the exact hook event name the CLI fired — the
   *  decision output must name it back (`hookSpecificOutput.hookEventName`). `toolInput` is
   *  the CLI's original `tool_input`, echoed back as `updatedInput` on allow: the SDK's
   *  permission contract runs the tool with `updatedInput`, and an allow without it risks
   *  the tool running on empty input. `sessionId`/`tool` identify the run so a remote allow
   *  can arm an output watch (see `outputWatches`). */
  private readonly heldPermissions = new Map<
    string,
    {
      res: ServerResponse;
      timer: NodeJS.Timeout;
      event: string;
      sessionId: string;
      tool: string;
      toolInput?: Record<string, unknown>;
    }
  >();
  /** One-shot watches armed by remote allows: when the matching PostToolUse arrives, its
   *  output is forwarded to the phone as a card. This closes the visibility gap a remote
   *  approval creates — the tool runs in a terminal the operator, by definition, is not
   *  watching (they answered from the phone), and its output would otherwise appear nowhere
   *  they can see. Keyed by session + tool + stable input identity so ordinary local tool
   *  use never leaks to the phone; one-shot so a repeated identical command doesn't either. */
  private readonly outputWatches: Array<{
    sessionId: string;
    tool: string;
    inputKey: string;
    expiresAtMs: number;
  }> = [];
  /** requestIds whose hold ended WITHOUT a decision (lapse, dead socket, shutdown). Once the
   *  local prompt has taken over, a late phone tap must be rejected honestly — resolving the
   *  row would tell the phone "Approved." about a decision nothing ever applied. Entries
   *  self-clean after the TTL, when the store's own expiry makes the guard redundant. */
  private readonly lapsedHolds = new Set<string>();

  constructor(options: HookReceiverOptions) {
    this.store = options.store;
    this.secret = options.secret;
    this.secretHeader = options.secretHeader ?? DEFAULT_SECRET_HEADER;
    this.eventNames = options.eventNames ?? DEFAULT_HOOK_EVENT_NAMES;
    this.permissionTtlMs = options.permissionTtlMs ?? DEFAULT_PERMISSION_TTL_MS;
    this.clock = options.clock ?? Date.now;
    this.emit = options.emit;
    this.daemonId = options.daemonId;
    this.logger = options.logger ?? noopLogger;
    this.permissionHoldMs = options.permissionHoldMs ?? DEFAULT_PERMISSION_HOLD_MS;
    this.forwardNotificationCards = options.forwardNotificationCards ?? false;
  }

  /** Install the CLI session-command logic. Called by the daemon before `listen` (symmetric
   *  with `ControlPlaneClient.setHandlers`), which is why the field is nullable — the receiver
   *  is constructed in the composition root before the Daemon that owns the registry exists. */
  setCliHandlers(handlers: HookReceiverCliHandlers): void {
    this.cliHandlers = handlers;
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
    // Held permission responses are open connections — `server.close()` waits for them, so a
    // shutdown mid-hold would hang until the hold lapsed. Answer them all neutrally first
    // (the local prompt takes over, same as a lapse).
    for (const [requestId, held] of this.heldPermissions) {
      clearTimeout(held.timer);
      this.markLapsed(requestId);
      this.respond(held.res, 200, {});
    }
    this.heldPermissions.clear();
    await new Promise<void>((resolve, reject) => {
      this.server?.close((err) => (err ? reject(err) : resolve()));
    });
    this.server = undefined;
  }

  /**
   * Record a decision for a pending permission request. Enforces the security contract: only
   * a currently-pending, non-expired request can be resolved, and only once. Returns
   * `{ok:false}` (never throws, never applies) for anything else.
   */
  resolvePermission(requestId: string, decision: 'allow' | 'deny'): ResolvePermissionResult {
    // Once a hold ended without a decision, the CLI's local prompt owns this request — a late
    // remote tap must not resolve the row (the phone would see "Approved." for a decision
    // nothing applied).
    if (this.lapsedHolds.has(requestId)) {
      return { ok: false, error: 'hold lapsed — the local prompt took over' };
    }
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
    this.completeHeldPermission(requestId, decision);
    return { ok: true };
  }

  /** Answer a held permission hook response with the CLI's decision schema (docs: hook output
   *  `hookSpecificOutput.decision`). curl prints our response body to stdout, and hook stdout
   *  IS the CLI's decision channel — this is the moment a phone tap actually gates the tool.
   *  No-op when the request isn't held (already lapsed, or resolved via a non-hook path). */
  private completeHeldPermission(requestId: string, decision: 'allow' | 'deny'): void {
    const held = this.heldPermissions.get(requestId);
    if (!held) return;
    clearTimeout(held.timer);
    this.heldPermissions.delete(requestId);
    // A remote allow arms a one-shot output watch: the operator approved from the phone, so
    // the phone is where the tool's output must land. Denies and lapses arm nothing — a
    // denied tool produces no output, and a lapsed hold means the operator answered at the
    // terminal, where the output is already in front of them.
    if (decision === 'allow') {
      this.outputWatches.push({
        sessionId: held.sessionId,
        tool: held.tool,
        inputKey: stableKey(held.toolInput ?? {}),
        expiresAtMs: this.clock() + OUTPUT_WATCH_TTL_MS,
      });
      while (this.outputWatches.length > OUTPUT_WATCH_CAP) this.outputWatches.shift();
    }
    // Allow echoes the ORIGINAL tool_input as updatedInput — the permission contract runs
    // the tool with updatedInput, so omitting it risks an empty-input run. We never modify
    // the input, only echo it.
    this.respond(held.res, 200, {
      hookSpecificOutput: {
        hookEventName: held.event,
        decision:
          decision === 'allow'
            ? {
                behavior: 'allow',
                ...(held.toolInput !== undefined ? { updatedInput: held.toolInput } : {}),
              }
            : { behavior: 'deny', message: 'denied by remote operator' },
      },
    });
    this.logger.info({ requestId, decision }, 'held permission response completed');
  }

  /** Record that `requestId`'s hold ended with no decision, and self-clean the marker after
   *  the TTL (past it, the store's own expiry already rejects the resolve). */
  private markLapsed(requestId: string): void {
    this.lapsedHolds.add(requestId);
    const cleanup = setTimeout(() => this.lapsedHolds.delete(requestId), this.permissionTtlMs);
    cleanup.unref();
  }

  /** The hold window ended without a phone decision: answer neutrally (no `decision` in the
   *  output → the CLI shows its normal local prompt) and mark the request lapsed. */
  private lapseHeldPermission(requestId: string): void {
    const held = this.heldPermissions.get(requestId);
    if (!held) return;
    this.heldPermissions.delete(requestId);
    this.markLapsed(requestId);
    this.logger.info({ requestId }, 'permission hold lapsed; local prompt takes over');
    this.respond(held.res, 200, {});
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      this.respond(res, 405, { ok: false, error: 'method not allowed' });
      return;
    }

    const presented = req.headers[this.secretHeader.toLowerCase()];
    const presentedSecret = Array.isArray(presented) ? presented[0] : presented;
    if (presentedSecret !== this.secret) {
      // A stale secret in settings.json (or a stranger on loopback) — never log the value.
      this.logger.warn({ path: req.url }, 'hook POST rejected: bad or missing secret header');
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
    if (path.startsWith('/cli/')) {
      await this.handleCliRequest(path, body, res);
      return;
    }

    this.handleHookEvent(body, res);
  }

  /** Route a `cctl session` command. Validates the common shape here (so a malformed request is
   *  a 400 that never reaches the registry), delegates the mutation to the injected handlers,
   *  and maps the domain result onto an HTTP status. Never throws to the caller — a handler
   *  rejection would be caught by `listen`'s wrapper and answered 500, but the handlers
   *  themselves return results rather than throwing for expected failures (unknown session). */
  private async handleCliRequest(
    path: string,
    body: Record<string, unknown>,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.cliHandlers) {
      // Raced daemon startup (handlers installed just before listen); tell the CLI to retry.
      this.respond(res, 503, { ok: false, error: 'daemon is starting; retry in a moment' });
      return;
    }
    const sessionId = str(body.sessionId);
    const idempotencyKey = str(body.idempotencyKey);
    if (!sessionId || !idempotencyKey) {
      this.respond(res, 400, {
        ok: false,
        error: 'sessionId and idempotencyKey are required',
      });
      return;
    }
    const base: SessionCommandBase = { sessionId, idempotencyKey };

    switch (path) {
      case '/cli/session/register': {
        const label = str(body.label);
        const result = await this.cliHandlers.registerSession({
          ...base,
          ...(label !== undefined ? { label } : {}),
        });
        this.respondSessionCommand(res, result);
        return;
      }
      case '/cli/session/label': {
        const label = str(body.label);
        if (label === undefined || label.length === 0) {
          this.respond(res, 400, { ok: false, error: 'label is required and must be non-empty' });
          return;
        }
        const result = await this.cliHandlers.labelSession({ ...base, label });
        this.respondSessionCommand(res, result);
        return;
      }
      case '/cli/session/watch': {
        // A boolean, strictly — a missing/omitted `watch` is a client bug, not a default, since
        // register vs unwatch are opposite intents. `true`/`false` both pass; nothing else does.
        if (typeof body.watch !== 'boolean') {
          this.respond(res, 400, { ok: false, error: 'watch must be a boolean' });
          return;
        }
        const result = await this.cliHandlers.watchSession({ ...base, watch: body.watch });
        this.respondSessionCommand(res, result);
        return;
      }
      default:
        this.respond(res, 404, { ok: false, error: `unknown CLI endpoint "${path}"` });
    }
  }

  /** Map a {@link SessionCommandResult} onto an HTTP response: success → 200 (with the echoed
   *  view), `unknown_session` → 404 with a useful body. The full result object is the body
   *  either way, so the CLI can print `status`/`session` or `code`/`message` without guessing. */
  private respondSessionCommand(res: ServerResponse, result: SessionCommandResult): void {
    if (result.ok) {
      this.respond(res, 200, result);
      return;
    }
    // Only one failure code today; a switch keeps the mapping honest if more are added.
    const status = result.code === 'unknown_session' ? 404 : 400;
    this.respond(res, status, result);
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
    if (result.ok) {
      this.logger.info({ requestId, decision }, 'pending permission resolved');
    } else {
      // Not a daemon error — the security contract rejecting a stale/duplicate/expired
      // resolve. Logged so an operator can tell "guard working" from "resolve never arrived".
      this.logger.warn({ requestId, decision, error: result.error }, 'permission resolve rejected');
    }
    this.respond(res, result.ok ? 200 : 409, result);
  }

  private handleHookEvent(body: Record<string, unknown>, res: ServerResponse): void {
    // `hook_event_name` is the CLI's real field; the camelCase names are aliases kept for
    // internal senders and existing tests.
    const event = str(body.hook_event_name) ?? str(body.event) ?? str(body.hookEventName);
    if (event === undefined) {
      // Keys only, never values — enough to diagnose a contract drift without logging content.
      this.logger.warn({ keys: Object.keys(body) }, 'hook POST with no event name field');
      this.respond(res, 400, { ok: false, error: 'missing event name' });
      return;
    }

    if (event === this.eventNames.permissionRequest) {
      this.handlePermissionRequest(body, res, event);
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
    if (event === this.eventNames.postToolUse) {
      this.handlePostToolUse(body, res);
      return;
    }
    // Whatever event name the CLI fires that we don't handle shows up here by name, so a
    // contract drift is visible in the log instead of silently dropped.
    this.logger.warn(
      { event, sessionId: str(body.session_id) ?? str(body.sessionId) },
      'hook POST with unrecognized event name — not an event we handle',
    );
    this.respond(res, 400, { ok: false, error: `unrecognized event "${event}"` });
  }

  private handlePermissionRequest(
    body: Record<string, unknown>,
    res: ServerResponse,
    event: string,
  ): void {
    // The CLI names the tool `tool_name` and carries its arguments in `tool_input`; it sends
    // NO requestId of its own, so the daemon mints one (its only job is correlating our
    // pending row with the phone's later response). `requestId`/`sessionId`/`tool` remain as
    // internal-sender/test aliases.
    const requestId = str(body.requestId) ?? randomUUID();
    const sessionId = str(body.session_id) ?? str(body.sessionId);
    const tool = str(body.tool_name) ?? str(body.tool);
    const toolInput = isRecord(body.tool_input) ? body.tool_input : undefined;
    const summary = str(body.summary) ?? summarizeToolInput(toolInput) ?? tool ?? 'unknown tool';
    if (!sessionId || !tool) {
      this.logger.warn(
        { keys: Object.keys(body) },
        'permission hook POST missing session id or tool name',
      );
      this.respond(res, 400, { ok: false, error: 'session_id and tool_name are required' });
      return;
    }

    // An interactive-prompt tool (AskUserQuestion) is not a remote-decidable permission: the
    // phone can't answer the question, and holding the response would freeze the terminal UI
    // the question needs. Neutral answer immediately (normal flow shows the question) and
    // push a "waiting on you" card naming what's being asked instead of approve/deny buttons.
    if (INTERACTIVE_PROMPT_TOOLS.has(tool)) {
      this.emit({
        daemonId: this.daemonId(),
        type: 'hook.notification',
        payload: {
          event: 'notification',
          sessionId,
          title: 'Waiting on you: Claude has a question in the terminal',
          body: firstQuestionText(toolInput) ?? summary,
          level: 'info',
          notificationType: 'question_prompt',
        },
      });
      this.logger.info({ sessionId, tool }, 'interactive-prompt tool; waiting card pushed');
      this.respond(res, 200, {});
      return;
    }

    const now = this.clock();
    this.store.insertPendingPermission({ requestId, sessionId, tool, summary, createdAtMs: now });

    const detail =
      str(body.detail) ??
      (toolInput !== undefined ? truncate(JSON.stringify(toolInput, null, 2), 2000) : undefined);
    const cwd = str(body.cwd);
    // The hook payload carries `permission_mode` (snake_case per Claude Code's hook
    // contract; we also accept camelCase defensively). Parsed tolerantly — any string
    // passes through untouched — because it is display context for the bot's card: this hook
    // only fires when the CLI is actually blocking on a prompt (accept-edits still prompts
    // for shell commands), so the card stays actionable in every mode and the bot shows the
    // mode instead of gating on it. A missing/unknown mode simply omits the field; it never
    // changes the permission SEMANTICS here (the security contract on resolvePermission is
    // untouched).
    const permissionMode = str(body.permission_mode) ?? str(body.permissionMode);
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
        ...(permissionMode !== undefined ? { permissionMode } : {}),
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

    // THE round-trip: hold this HTTP response open. A phone Approve/Deny lands in
    // `resolvePermission`, which answers it with the CLI's decision schema; the hold lapsing
    // (or the socket dying) answers neutrally and the local prompt takes over. The CLI's own
    // hook timeout (600s default) outlasts our hold window — see DEFAULT_PERMISSION_HOLD_MS.
    const timer = setTimeout(() => this.lapseHeldPermission(requestId), this.permissionHoldMs);
    timer.unref();
    this.heldPermissions.set(requestId, {
      res,
      timer,
      event,
      sessionId,
      tool,
      ...(toolInput !== undefined ? { toolInput } : {}),
    });
    res.on('close', () => {
      // Fires on our own completion too — only a request STILL in the map is an abandoned
      // socket (curl killed, session ended, CLI-side timeout beating ours).
      if (this.heldPermissions.has(requestId)) {
        clearTimeout(timer);
        this.heldPermissions.delete(requestId);
        this.markLapsed(requestId);
        this.logger.info({ requestId }, 'held permission socket closed by the CLI side');
      }
    });
    this.logger.info(
      { requestId, sessionId, tool, permissionMode },
      'permission hook received; card pushed; response held for remote decision',
    );
  }

  /** PostToolUse fires after EVERY completed tool call, so this handler is observe-only and
   *  deliberately permissive: nothing here can fail a hook (always 200), and nothing is
   *  forwarded unless a one-shot watch — armed by a remote allow — matches this exact run.
   *  Forwarding rides `hook.notification` with `notificationType: 'tool_output'` (the schema's
   *  tolerant-string extension point), so no wire change: an older bot shows the generic
   *  title/body card, which for output IS the content. This emit is daemon-originated — the
   *  CCTL_WAITING_CARDS suppression gate only covers the CLI's Notification nags. */
  private handlePostToolUse(body: Record<string, unknown>, res: ServerResponse): void {
    const sessionId = str(body.session_id) ?? str(body.sessionId);
    const tool = str(body.tool_name) ?? str(body.tool);
    const toolInput = isRecord(body.tool_input) ? body.tool_input : undefined;
    const now = this.clock();
    // Expired watches are pruned lazily here (no timers to clean up on close).
    for (let i = this.outputWatches.length - 1; i >= 0; i--) {
      const watch = this.outputWatches[i];
      if (watch !== undefined && watch.expiresAtMs < now) this.outputWatches.splice(i, 1);
    }
    if (sessionId === undefined || tool === undefined) {
      this.respond(res, 200, { ok: true });
      return;
    }
    const inputKey = stableKey(toolInput ?? {});
    const matchIndex = this.outputWatches.findIndex(
      (w) => w.sessionId === sessionId && w.tool === tool && w.inputKey === inputKey,
    );
    if (matchIndex === -1) {
      this.respond(res, 200, { ok: true });
      return;
    }
    this.outputWatches.splice(matchIndex, 1);
    const text = toolResponseText(body.tool_response).trim();
    this.emit({
      daemonId: this.daemonId(),
      type: 'hook.notification',
      payload: {
        event: 'notification',
        sessionId,
        title: `Output — ${summarizeToolInput(toolInput) ?? tool}`,
        // An empty result still confirms the approved tool RAN — silence here would read as
        // the approval having vanished.
        body: text === '' ? '(no output)' : truncate(text, OUTPUT_BODY_MAX),
        level: 'info',
        notificationType: 'tool_output',
      },
    });
    // Size only, never content — tool output can contain anything.
    this.logger.info(
      { sessionId, tool, chars: text.length },
      'remotely approved tool finished; output card pushed',
    );
    this.respond(res, 200, { ok: true });
  }

  private handleStopOrNotification(
    body: Record<string, unknown>,
    res: ServerResponse,
    event: 'stop' | 'notification',
  ): void {
    const sessionId = str(body.session_id) ?? str(body.sessionId);
    // Notification events are the CLI mirroring its terminal nags ("Claude is waiting for your
    // input", "Claude needs your permission") — with real permission/done cards in place they
    // are duplicate noise, so forwarding them is opt-in.
    // The hook is still answered 200: suppression is a display choice, never a hook failure.
    if (event === 'notification' && !this.forwardNotificationCards) {
      this.logger.info(
        { event, sessionId, notificationType: str(body.notification_type) },
        'notification hook suppressed (waiting cards off — CCTL_WAITING_CARDS enables)',
      );
      this.respond(res, 200, { ok: true });
      return;
    }
    // Two optional discriminators from the CLI hook payload, threaded through so the bot can
    // render rich done/waiting cards. Both parsed tolerantly (snake_case primary,
    // camelCase accepted): unknown values pass through unchanged and the bot falls back to the
    // generic card rather than the frame being rejected.
    //   - Notification events carry `notification_type` (e.g. 'idle_prompt' → the "waiting on
    //     you" card).
    //   - Stop events carry `last_assistant_message` (WHAT Claude finished saying → the "done"
    //     card). When a Stop arrives with no explicit body/message, we surface that message as
    //     the body so the done card isn't empty.
    const notificationType = str(body.notification_type) ?? str(body.notificationType);
    const lastAssistantMessage = str(body.last_assistant_message) ?? str(body.lastAssistantMessage);
    const title = str(body.title) ?? (event === 'stop' ? 'Session stopped' : 'Notification');
    const text =
      str(body.body) ??
      str(body.message) ??
      (event === 'stop' ? lastAssistantMessage : undefined) ??
      '';
    this.emit({
      daemonId: this.daemonId(),
      type: 'hook.notification',
      payload: {
        event,
        ...(sessionId !== undefined ? { sessionId } : {}),
        title,
        body: text,
        level: 'info',
        ...(notificationType !== undefined ? { notificationType } : {}),
        ...(lastAssistantMessage !== undefined ? { lastAssistantMessage } : {}),
      },
    });
    this.logger.info({ event, sessionId, notificationType }, 'hook event received; card pushed');
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
