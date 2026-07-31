// The channel server's half of the loopback conversation with the cctl daemon.
//
// Shape of the exchange: attach once to claim this session, then long-poll `next` forever,
// handing each item to the transport and acking what happened to it. Replies travel the other
// way on the same authenticated connection.
//
// SELF-HEALING is the load-bearing property. The daemon's receiver binds an OS-assigned port
// that changes on every daemon run, and this server outlives daemon restarts (Claude Code owns
// its lifetime, not us). So the address is never cached across a failure: any connection error,
// and any `404 unknown attachment`, drops the cached address AND the attachment, which forces
// the next iteration to re-read `hook-endpoint.json` and re-attach — exactly the recovery the
// hook forwarder already implements for the same reason. Between those attempts the loop backs
// off exponentially to a cap, so a daemon that is down for an hour costs a poll every 30s
// instead of a spin.
//
// One thing this module deliberately does NOT do is author anything. The hook secret is minted
// by the daemon and read here read-only; a channel server that invented a secret would simply be
// 401'd by the receiver, so "no secret" is reported as "the daemon has never run", never fixed.

import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
// switch-engine is reached ONLY through a dynamic import inside `createDiscover` — its barrel
// carries the vault, OAuth refresh, Keychain and DPAPI, none of which may sit in front of the
// MCP handshake. `Protector` is type-only here, so it is erased and costs nothing.
import type { Protector } from '@claude-control/switch-engine';
import { noopLogger, type Logger } from './logger.js';

/** One injection the daemon wants delivered into this session. */
export interface ChannelItem {
  injectId: string;
  text: string;
  meta?: Record<string, unknown> | undefined;
}

/** What the transport reports back about one item, which becomes the ack state.
 *
 *  `sent` means the notification was accepted by the transport — NOT that the session acted on
 *  it. Channel delivery is fire-and-forget by design, so no code here may ever claim more. The
 *  distinction has teeth: the daemon drops an item from its in-flight map on a `sent` ack, so a
 *  wrongly-optimistic `{ok:true}` destroys the message rather than merely mis-reporting it. */
export type DeliverResult = { ok: true } | { ok: false; error: string };

/** Hand one item to the MCP transport. Supplied by the composition root so this module never
 *  depends on the server, only on the direction of travel. */
export type Deliver = (item: ChannelItem) => Promise<DeliverResult>;

/** The daemon's loopback address plus the shared secret that authenticates to it. */
export interface DaemonAddress {
  port: number;
  secret: string;
}

/** Resolve where the daemon is right now. Re-invoked on every re-attach precisely so a daemon
 *  that restarted on a new port is found again instead of being declared dead. */
export type Discover = () => Promise<
  { ok: true; address: DaemonAddress } | { ok: false; reason: string }
>;

/** The minimal fetch this module needs. Declared here rather than reused from the daemon's
 *  `FetchLike` because that one models the usage poller's GET-with-headers shape and has no
 *  `method` or `body`; widening it would change a type the poller depends on. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<FetchLikeResponse>;

/** The identity facts the daemon needs to key and label the attachment. Structural, not
 *  `ResolvedIdentity`, so the link cannot be handed an unresolved one. */
export interface AttachIdentity {
  sessionId: string;
  pid: number;
  cwd: string;
  name?: string | undefined;
  source: 'env' | 'ancestry';
}

/** First backoff step after a failed attach/poll. Short enough that a daemon restarting under
 *  us is picked up almost immediately. */
export const BACKOFF_BASE_MS = 500;
/** Ceiling on the backoff. Matches the long-poll bound: once the daemon is properly down there
 *  is no value in retrying more often than we would have polled anyway. */
export const BACKOFF_CAP_MS = 30_000;
/** Fallback long-poll bound, used until the daemon's `attach` response states its own. */
export const DEFAULT_POLL_MS = 30_000;
/** Clamp on the daemon-supplied `pollMs`. It is used to size this client's own request deadline,
 *  so an absurd value from a buggy or future daemon would either make every poll time out
 *  instantly or disable the deadline entirely. Trusting the peer's number unbounded is how a
 *  remote field becomes a local hang. */
export const MIN_POLL_MS = 1_000;
export const MAX_POLL_MS = 120_000;
/** Floor between polls when the daemon answered with nothing.
 *
 *  An empty `200` is a success and resets the backoff, but the daemon does NOT always hold the
 *  socket for the full bound — it answers a displaced poll immediately, and releases every held
 *  poll at shutdown. Without a floor those cases turn into an unthrottled request loop against
 *  the daemon's event loop. Small enough to be invisible to an operator waiting on a message. */
export const EMPTY_POLL_FLOOR_MS = 50;
/** How long the daemon keeps an attachment alive after a server stops polling. A server that
 *  died uncleanly still owns its session for this long. */
export const STALE_ATTACHMENT_MS = 90_000;
/** Timeout for the small request/response calls (attach, ack, reply, detach). The long poll is
 *  bounded separately and far more generously — see {@link DaemonLink.poll}. */
const SHORT_CALL_TIMEOUT_MS = 10_000;

export interface DaemonLinkOptions {
  identity: AttachIdentity;
  /** Defaults to the real endpoint-file + hook-secret discovery. */
  discover?: Discover;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  logger?: Logger;
  /** Abortable sleep; injectable so tests can observe the backoff schedule without waiting. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** How long to wait before the single re-attach that follows a 409. Defaults to just past the
   *  daemon's stale-attachment window; see {@link DaemonLink.run}. */
  conflictRetryMs?: number;
}

/** Why {@link DaemonLink.run} returned. `conflict` is the one the operator must see: another
 *  channel server already owns this session, and two of them would double-deliver. */
export type RunOutcome = { reason: 'stopped' } | { reason: 'conflict' };

export class DaemonLink {
  private readonly identity: AttachIdentity;
  private readonly discover: Discover;
  private readonly fetchFn: FetchLike;
  private readonly logger: Logger;
  private readonly sleepFn: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly backoffBaseMs: number;
  private readonly backoffCapMs: number;
  private readonly conflictRetryMs: number;

  /** Cached only while it keeps working; dropped on any failure so recovery always re-reads the
   *  endpoint file rather than retrying a port the daemon no longer owns. */
  private address: DaemonAddress | undefined;
  private attachId: string | undefined;
  private pollMs = DEFAULT_POLL_MS;
  private backoffMs = 0;
  /** A 409 buys exactly one retry, tracked here so a daemon that answers 409 forever cannot keep
   *  this server waiting in a loop. */
  private conflictRetried = false;
  private readonly abort = new AbortController();

  constructor(options: DaemonLinkOptions) {
    this.identity = options.identity;
    this.discover = options.discover ?? createDiscover();
    this.fetchFn = options.fetch ?? defaultFetch;
    this.logger = options.logger ?? noopLogger;
    this.sleepFn = options.sleep ?? defaultSleep;
    this.backoffBaseMs = options.backoffBaseMs ?? BACKOFF_BASE_MS;
    this.backoffCapMs = options.backoffCapMs ?? BACKOFF_CAP_MS;
    // Just past the daemon's stale window, so the retry lands after a dead predecessor's
    // attachment has been swept rather than while it is still held.
    this.conflictRetryMs = options.conflictRetryMs ?? STALE_ATTACHMENT_MS + 5_000;
  }

  /** The attachment id the daemon minted, once attached. Exposed for logging and tests. */
  get currentAttachId(): string | undefined {
    return this.attachId;
  }

  /**
   * Attach, then poll until stopped. Every failure mode funnels into the same two moves — forget
   * the address, back off — so there is exactly one recovery path to reason about, and it is the
   * one that also covers "the daemon restarted on a different port".
   *
   * A 409 gets ONE bounded retry rather than an immediate exit. Claude Code does not restart a
   * failed MCP server, so exiting on the first 409 is terminal for the session's whole life — and
   * the most likely cause of a 409 is not a genuine second server but a predecessor that died
   * without detaching, whose attachment the daemon still holds for {@link STALE_ATTACHMENT_MS}.
   * Waiting out that window converts "no channel, ever" into "no channel for ninety seconds".
   */
  async run(deliver: Deliver): Promise<RunOutcome> {
    while (!this.abort.signal.aborted) {
      if (this.attachId === undefined) {
        const attached = await this.attach();
        if (attached === 'conflict') {
          if (this.conflictRetried) return { reason: 'conflict' };
          this.conflictRetried = true;
          this.logger.warn(
            { sessionId: this.identity.sessionId, retryInMs: this.conflictRetryMs },
            'channel: session already attached; waiting out the stale-attachment window to retry',
          );
          if (!(await this.pause(this.conflictRetryMs))) break;
          continue;
        }
        if (attached === 'failed') {
          if (!(await this.backoff())) break;
          continue;
        }
      }
      const polled = await this.poll(deliver);
      if (polled === 'failed') {
        if (!(await this.backoff())) break;
      } else if (polled === 'empty') {
        // Floor an empty result. It is a success (backoff stays reset) but must not become a
        // zero-delay request loop when the daemon answers immediately instead of holding.
        if (!(await this.pause(EMPTY_POLL_FLOOR_MS))) break;
      }
    }
    return { reason: 'stopped' };
  }

  /** Claim this session. `409` is the one answer that is not a retryable failure: another server
   *  holds the attachment, and racing it would deliver every operator message twice. */
  private async attach(): Promise<'ok' | 'failed' | 'conflict'> {
    const result = await this.post('/cli/channel/attach', {
      sessionId: this.identity.sessionId,
      pid: this.identity.pid,
      cwd: this.identity.cwd,
      ...(this.identity.name === undefined ? {} : { name: this.identity.name }),
      identitySource: this.identity.source,
    });
    if (result.kind === 'unreachable') {
      this.logger.warn(
        { sessionId: this.identity.sessionId, reason: result.reason },
        'channel: daemon unreachable, will retry',
      );
      return 'failed';
    }
    if (result.status === 409) {
      this.logger.error(
        { sessionId: this.identity.sessionId },
        'channel: another channel server is already attached to this session',
      );
      return 'conflict';
    }
    const attachId = readString(result.body, 'attachId');
    if (result.status !== 200 || attachId === undefined) {
      this.logger.warn(
        { sessionId: this.identity.sessionId, status: result.status },
        'channel: attach rejected',
      );
      this.address = undefined;
      return 'failed';
    }
    this.attachId = attachId;
    // Clamped, not trusted: this number sizes our own request deadline below.
    const advertised = readPositiveInt(result.body, 'pollMs') ?? DEFAULT_POLL_MS;
    this.pollMs = Math.min(Math.max(advertised, MIN_POLL_MS), MAX_POLL_MS);
    this.backoffMs = 0;
    this.logger.info(
      {
        sessionId: this.identity.sessionId,
        attachId,
        identitySource: this.identity.source,
        pollMs: this.pollMs,
      },
      'channel: attached to daemon',
    );
    return 'ok';
  }

  /** One bounded long poll.
   *
   *  `failed` means back off. `empty` is a SUCCESS — the daemon's bound simply elapsed — so the
   *  backoff resets and only a small floor separates it from the next poll. `delivered` re-polls
   *  at once, which is what keeps a busy session responsive. */
  private async poll(deliver: Deliver): Promise<'delivered' | 'empty' | 'failed'> {
    const attachId = this.attachId;
    if (attachId === undefined) return 'failed';
    // Generously above the daemon's own bound: the server is supposed to answer within
    // `pollMs`, so anything past double that is a hang, not a slow answer.
    const result = await this.post(
      '/cli/channel/next',
      { attachId },
      { timeoutMs: this.pollMs * 2 + SHORT_CALL_TIMEOUT_MS },
    );
    if (result.kind === 'unreachable') {
      // Our own shutdown aborts the in-flight poll, which arrives here looking exactly like a
      // dead daemon. It is not: the attachment is still valid and `detach` is about to need it.
      if (this.abort.signal.aborted) return 'failed';
      // The daemon died mid-poll (or never came back). Forget both the port and the attachment:
      // the attachment cannot outlive the process that minted it.
      this.attachId = undefined;
      this.logger.warn(
        { sessionId: this.identity.sessionId, reason: result.reason },
        'channel: poll lost the daemon, re-attaching',
      );
      return 'failed';
    }
    if (result.status === 404) {
      // The daemon is alive but has forgotten us (restart, or the attachment expired). Re-attach
      // against a freshly read endpoint rather than polling a dead attachId forever.
      this.attachId = undefined;
      this.address = undefined;
      this.logger.info(
        { sessionId: this.identity.sessionId },
        'channel: attachment unknown to daemon, re-attaching',
      );
      return 'failed';
    }
    if (result.status !== 200) {
      this.logger.warn(
        { sessionId: this.identity.sessionId, status: result.status },
        'channel: unexpected poll status',
      );
      return 'failed';
    }
    this.backoffMs = 0;
    const items = readItems(result.body);
    for (const item of items) {
      if (this.abort.signal.aborted) break;
      const delivered = await deliver(item);
      if (!delivered.ok) {
        this.logger.error(
          { sessionId: this.identity.sessionId, injectId: item.injectId, error: delivered.error },
          'channel: the session transport rejected an item; acking failed so the daemon can requeue it',
        );
      }
      await this.ack(item.injectId, delivered);
    }
    return items.length > 0 ? 'delivered' : 'empty';
  }

  /** Report what became of one item. Best-effort by design: a lost ack costs the daemon a retry
   *  decision, whereas failing the poll loop over it would cost the session its channel. */
  private async ack(injectId: string, delivered: DeliverResult): Promise<void> {
    const attachId = this.attachId;
    if (attachId === undefined) return;
    const result = await this.post('/cli/channel/ack', {
      attachId,
      injectId,
      state: delivered.ok ? 'sent' : 'failed',
      ...(delivered.ok ? {} : { error: delivered.error }),
    });
    if (result.kind === 'unreachable' || result.status !== 200) {
      this.logger.warn(
        {
          sessionId: this.identity.sessionId,
          injectId,
          status: result.kind === 'unreachable' ? undefined : result.status,
        },
        'channel: ack not accepted',
      );
    }
  }

  /**
   * Send text back to whoever is on the other end of the channel. Answers honestly rather than
   * silently succeeding: the model is told whether its reply actually left the machine, because
   * the person waiting for it is in a chat client and will otherwise just see nothing.
   */
  async reply(text: string): Promise<DeliverResult> {
    const attachId = this.attachId;
    if (attachId === undefined) {
      return { ok: false, error: 'not attached to the cctl daemon; the reply was not sent' };
    }
    const result = await this.post('/cli/channel/reply', { attachId, text });
    if (result.kind === 'unreachable') return { ok: false, error: result.reason };
    if (result.status !== 200) return { ok: false, error: `daemon returned HTTP ${result.status}` };
    return { ok: true };
  }

  /** Release the attachment so the daemon can hand this session to a replacement server without
   *  waiting for the attachment to expire. Best-effort: shutdown must not block on the daemon. */
  async detach(): Promise<void> {
    const attachId = this.attachId;
    if (attachId === undefined) return;
    this.attachId = undefined;
    // Deliberately NOT bound by the stop signal. Detach exists to run during shutdown, and
    // shutdown is precisely when that signal is already aborted — riding it would guarantee the
    // one request that must still go out is the one that never does.
    await this.post('/cli/channel/detach', { attachId }, { ignoreStop: true });
  }

  /** Stop the loop and cancel anything in flight, including a sleep — otherwise a shutdown that
   *  lands mid-backoff would wait out the full cap before exiting. */
  stop(): void {
    if (!this.abort.signal.aborted) this.abort.abort();
  }

  /** Exponential, capped, and reset on every successful poll. Returns false when the sleep was
   *  cut short by {@link stop}, which ends the loop. */
  private async backoff(): Promise<boolean> {
    this.backoffMs =
      this.backoffMs === 0 ? this.backoffBaseMs : Math.min(this.backoffMs * 2, this.backoffCapMs);
    return this.pause(this.backoffMs);
  }

  /** Sleep, unless we are shutting down. Returns false when the loop should stop — either because
   *  stop() had already been called, or because it landed during the sleep. A failure caused BY
   *  the shutdown (the in-flight poll being aborted) must not schedule a retry: that would both
   *  delay exit and misreport the backoff schedule. */
  private async pause(ms: number): Promise<boolean> {
    if (this.abort.signal.aborted) return false;
    try {
      await this.sleepFn(ms, this.abort.signal);
    } catch {
      return false; // aborted mid-sleep
    }
    return !this.abort.signal.aborted;
  }

  /** One authenticated POST. Collapses every "cannot reach the daemon" condition — no endpoint
   *  file, no secret, connection refused, aborted — into a single `unreachable` result, because
   *  the caller's response to all of them is identical. */
  private async post(
    path: string,
    body: Record<string, unknown>,
    opts: { timeoutMs?: number; ignoreStop?: boolean } = {},
  ): Promise<
    { kind: 'response'; status: number; body: unknown } | { kind: 'unreachable'; reason: string }
  > {
    if (this.address === undefined) {
      const found = await this.discover();
      if (!found.ok) return { kind: 'unreachable', reason: found.reason };
      this.address = found.address;
    }
    const address = this.address;
    const deadline = AbortSignal.timeout(opts.timeoutMs ?? SHORT_CALL_TIMEOUT_MS);
    let res: FetchLikeResponse;
    try {
      res = await this.fetchFn(`http://127.0.0.1:${address.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-claude-control-secret': address.secret },
        body: JSON.stringify(body),
        signal: opts.ignoreStop ? deadline : AbortSignal.any([this.abort.signal, deadline]),
      });
    } catch (err) {
      this.address = undefined;
      return { kind: 'unreachable', reason: err instanceof Error ? err.message : String(err) };
    }
    // A body that is absent or unparsable is not a transport failure; the status still decides.
    const parsed = await res.json().catch(() => undefined);
    return { kind: 'response', status: res.status, body: parsed };
  }
}

export interface DiscoverOptions {
  /** The claude-control data dir holding `hook-endpoint.json` and `hook-secret.enc`. Defaults to
   *  the production location, derived the same way the daemon and CLI derive it. */
  dataDir?: string;
  /** At-rest protector for the hook secret. Must be the same one the daemon wrote with. */
  protector?: Protector;
}

/**
 * The production discovery: the daemon's own published endpoint file and its own encrypted
 * secret, read with the daemon package's own read-only readers so the two processes can never
 * disagree about where either file lives or how it is encoded.
 *
 * The daemon import is DYNAMIC on purpose. Its public barrel pulls in `node:sqlite`, `ws`, and
 * the Agent SDK — measured at ~0.65s of module loading — and this process is spawned by Claude
 * Code, which is waiting on the MCP handshake. Deferring the import to first discovery moves
 * that cost behind the handshake, where nothing is blocked on it. (A subpath export on
 * `@claude-control/daemon` for `hookEndpoint`/`hookSecret` would make a static import viable and
 * is the better long-term shape.)
 */
export function createDiscover(options: DiscoverOptions = {}): Discover {
  return async () => {
    const { hookEndpointPath, hookSecretPath, loadHookSecret, readHookEndpoint } =
      await import('@claude-control/daemon');
    // switch-engine is dynamic for the same reason and pays the same way: discovery runs behind
    // the handshake, so the vault/OAuth/Keychain/DPAPI graph loads where nothing is waiting.
    const needsDefaults = options.dataDir === undefined || options.protector === undefined;
    const engine = needsDefaults ? await import('@claude-control/switch-engine') : undefined;
    const dataDir = options.dataDir ?? dirname(engine!.defaultPaths().vaultDir);
    const protector = options.protector ?? engine!.defaultProtector();

    const secret = await loadHookSecret({ filePath: hookSecretPath(dataDir), protector });
    if (secret === undefined) {
      return {
        ok: false,
        reason: 'the cctl daemon has never run on this machine, so it has no loopback secret',
      };
    }
    const endpoint = await readHookEndpoint(hookEndpointPath(dataDir));
    if (endpoint === undefined) {
      return {
        ok: false,
        reason: 'the cctl daemon is not running (no loopback endpoint published)',
      };
    }
    return { ok: true, address: { port: endpoint.port, secret } };
  };
}

/** Narrow wrapper so the injectable seam stays small; the global `fetch` accepts far more than
 *  this module ever sends. `signal` is normalised to `null` because `RequestInit` models "no
 *  signal" as null, and under `exactOptionalPropertyTypes` an explicit `undefined` is not it. */
const defaultFetch: FetchLike = (url, init) =>
  globalThis.fetch(url, { ...init, signal: init.signal ?? null });

/** Abortable sleep. Rejects on abort, which {@link DaemonLink.backoff} reads as "stop". */
const defaultSleep = async (ms: number, signal: AbortSignal): Promise<void> => {
  await delay(ms, undefined, { signal });
};

// ---------------------------------------------------------------------------
// Response narrowing. The daemon is trusted to be well-behaved but not trusted to be a type:
// a field that is not the shape we need is treated as absent, never coerced.
// ---------------------------------------------------------------------------

function readString(body: unknown, key: string): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readPositiveInt(body: unknown, key: string): number | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const value = (body as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Extract the deliverable items. An entry without an `injectId` could never be acked, so it is
 *  dropped rather than delivered into a session with no way to report on it. */
function readItems(body: unknown): ChannelItem[] {
  if (body === null || typeof body !== 'object') return [];
  const raw = (body as Record<string, unknown>).items;
  if (!Array.isArray(raw)) return [];
  const items: ChannelItem[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const injectId = typeof record.injectId === 'string' ? record.injectId : undefined;
    if (injectId === undefined || injectId.length === 0) continue;
    items.push({
      injectId,
      text: typeof record.text === 'string' ? record.text : '',
      meta:
        record.meta !== null && typeof record.meta === 'object'
          ? (record.meta as Record<string, unknown>)
          : undefined,
    });
  }
  return items;
}
