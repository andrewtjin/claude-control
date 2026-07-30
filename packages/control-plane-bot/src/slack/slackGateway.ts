// Slack composition root: owns the single Bolt App, the socket-mode connection lifecycle, and
// envelope dispatch to Slack users — the Slack-surface counterpart of discordJsGateway.ts.
//
// LIVE BOUNDARY: `start()` opens a real Slack connection and `deliver()` makes real Slack API
// calls — neither is exercised headlessly. `appFactory` is the seam that lets a test stand in a
// fake app while keeping this class's own logic (dispatch order, principal checks, reconnect
// scheduling) under test the same way discordJsGateway.ts keeps its live boundary thin.
//
// RECONNECTION IS NOT BOLT'S JOB HERE, IT IS OURS. Socket Mode's own client reconnects on some
// failures and not others (a `disconnect` message from Slack's edge and an unrecoverable start()
// rejection are both real, documented ways for the connection to go quiet without Bolt bringing
// it back up on its own). Treating "the process is still running" as "the socket is still live"
// is exactly the failure mode a supervisor exists to close: a failed `app.start()` and a
// connection-level `app.error` both route through `scheduleRestart`, which retries the SAME App
// instance (its listeners are registered once, in `start()`; only the socket portion —
// `app.start()` / `app.stop()` — cycles) with capped exponential backoff and full jitter, so a
// prolonged outage does not turn into either a tight retry loop or a thundering herd across every
// bot process reconnecting on the same schedule.
//
// `app.error` IS NOT A DISCONNECT SIGNAL BY ITSELF. Bolt routes every rejection that escapes a
// listener to the same handler as a transport failure, so a single failed `chat.update` (a card
// the user deleted answers `message_not_found`) arrives looking exactly like a dead socket. Only
// the error codes that actually mean the transport is gone reconnect — see
// {@link CONNECTION_LOSS_ERROR_CODES}; everything else is logged and left to the listener that
// raised it, because tearing the socket down for every user over one bad API call is a far worse
// outcome than the failed call itself.
//
// One Bolt App per process. `deliver()` reads `this.ctx`, populated once by `start()`; a relay
// push that lands before `start()` has finished (or after `stop()`) is dropped with a warning
// rather than throwing, matching the relay's fire-and-forget contract for every gateway.

import { App, ErrorCode } from '@slack/bolt';
import { isType, type Envelope } from '@claude-control/shared-protocol';
import type { Logger } from '../logger.js';
import { parseSlackPrincipal, slackPrincipal } from '../principal.js';
import { renderPush } from '../discord/pushRender.js';
import { DaemonStateCache } from '../discord/stateCache.js';
import { PendingStatsScans } from '../discord/pendingStatsScans.js';
import { SLACK_PAIRING_PRIMER_MESSAGE } from '../primerMessage.js';
import type {
  PacedChannelSend,
  SlackContext,
  SlackGatewayOptions as PinnedSlackGatewayOptions,
} from './context.js';
import { toMrkdwn, slackChunks, SLACK_LIMITS } from './slackFormat.js';
import { registerSlackCommands } from './slackCommands.js';
import { registerSlackInteractivity, deliverCard } from './slackBlocks.js';
import { SlackSessionDelivery } from './slackSessionDelivery.js';

/** Delay before the FIRST reconnect attempt after a failure. Doubled per consecutive failure
 *  (capped by {@link DEFAULT_BACKOFF_MAX_MS}) and always jittered — see {@link nextDelayMs}. */
const DEFAULT_BACKOFF_BASE_MS = 1_000;
/** Ceiling on the backoff delay. Past a handful of failures, retrying roughly once a minute is
 *  close enough to "as soon as Slack is reachable again" without hammering a real outage. */
const DEFAULT_BACKOFF_MAX_MS = 60_000;
/** Floor under the jittered backoff delay. Full jitter is uniform over `[0, window)`, so it can
 *  land arbitrarily close to zero — and a connect that fails immediately (no DNS, no route) would
 *  then retry in a tight loop rather than backing off at all. Clamped by the window itself so a
 *  test seam configuring a ceiling below this floor still gets sub-floor delays. */
const MIN_RECONNECT_DELAY_MS = 100;

/** The error codes that mean the TRANSPORT is gone, as opposed to a listener or an API call
 *  having failed while the socket stayed perfectly healthy. See this module's header for why the
 *  distinction has to be drawn here at all.
 *
 *  The socket-mode codes are spelled as literals rather than imported: this package declares
 *  `@slack/bolt`, and `@slack/socket-mode` is Bolt's own transitive transport — the same reason
 *  context.ts names Bolt's WebClient through `App` instead of importing `@slack/web-api`. They
 *  are Slack's published, stable code strings, not internal detail. */
const CONNECTION_LOSS_ERROR_CODES: ReadonlySet<string> = new Set<string>([
  'slack_socket_mode_websocket_error',
  'slack_socket_mode_send_while_disconnected_error',
  'slack_socket_mode_send_while_not_ready_error',
  'slack_socket_mode_no_reply_received_error',
  // Bolt's own: the receiver's idea of the connection stopped matching the connection.
  ErrorCode.ReceiverInconsistentStateError,
]);

/** Read the `.code` Bolt stamps on everything it routes to `app.error` (`asCodedError` wraps a
 *  bare throw in `UnknownError`). Deliberately not Bolt's exported `isCodedError`, which does a
 *  bare `'code' in err` and therefore throws outright for a primitive rejection value. */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

/** Resolve after `ms`. The timer is deliberately NOT unref'd, unlike this file's reconnect timer
 *  and session delivery's coalescing timers: those hold work that may never matter, while this
 *  one is the tail of a send already in flight, and letting the process exit through it would
 *  silently drop the message it is pacing. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Build the surface's shared per-channel send pacer — see {@link PacedChannelSend} for the
 *  contract and why pacing belongs to the composition root rather than to each module. Exported
 *  so a module that RECEIVES a pacer can be tested against this real one rather than a stand-in
 *  that agrees on everything except the timing being asserted.
 *
 *  One "lane" per channel: a promise chain that orders the channel's sends, plus the timestamp of
 *  the last one so the next can wait out the remainder of the interval. Both `.then` branches run
 *  the work, so a failed send can never skip the send queued behind it. Lanes are kept rather than
 *  evicted when a chain drains — dropping one would also drop the timestamp the very next send is
 *  owed its wait against — and the map is bounded by DM channels with traffic, i.e. by paired
 *  users, exactly like the DM-channel cache in {@link SlackGateway.buildContext}. */
export function createChannelPacer(): PacedChannelSend {
  interface Lane {
    tail: Promise<unknown>;
    lastSentAtMs: number;
  }
  const lanes = new Map<string, Lane>();
  return <T>(channelId: string, call: () => Promise<T>): Promise<T> => {
    let lane = lanes.get(channelId);
    if (!lane) {
      // -Infinity reads as "infinitely long ago", so a channel's first send never waits out an
      // interval that never started.
      lane = { tail: Promise.resolve(), lastSentAtMs: Number.NEGATIVE_INFINITY };
      lanes.set(channelId, lane);
    }
    const own = lane;
    const run = async (): Promise<T> => {
      const waitMs = own.lastSentAtMs + SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS - Date.now();
      if (waitMs > 0) await delay(waitMs);
      own.lastSentAtMs = Date.now();
      return call();
    };
    const next = own.tail.then(run, run);
    // The TAIL is the swallowed form and `next` the honest one: the chain must never stall on a
    // rejection, while the caller still sees its own send's real failure.
    own.tail = next.catch(() => undefined);
    return next;
  };
}

export interface SlackGatewayOptions extends PinnedSlackGatewayOptions {
  /** Test seam: construct the Bolt App instance. Defaults to a real Socket Mode `App`. bin.ts
   *  never sets this — production always takes the default, which is the only path that ever
   *  opens a real connection. */
  appFactory?: () => App;
  /** Test seam: source of jitter for backoff delays. Defaults to `Math.random`. */
  random?: () => number;
  /** Test seam: base/cap for the reconnect backoff, so a test can observe several scheduled
   *  restarts without waiting on production-sized delays (house convention is real timers, not
   *  fake ones — see other *.test.ts files in this package). */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
}

/** discord.js-free, Bolt-backed Slack surface: DMs the bound user for daemon-originated pushes,
 *  registers the `/cctl` command and card interactivity (delegated to the sibling modules named
 *  in the class doc above), and supervises the Socket Mode connection itself. */
export class SlackGateway {
  private readonly relay: SlackGatewayOptions['relay'];
  private readonly pairing: SlackGatewayOptions['pairing'];
  private readonly logger: Logger;
  private readonly botToken: string;
  private readonly appToken: string;
  private readonly stateDir: string;
  private readonly appFactory: () => App;
  private readonly random: () => number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  /** Shared by this class's own sends and by session delivery's — see {@link createChannelPacer}.
   *  Built in the constructor rather than in `start()` because it holds no connection state. */
  private readonly sendPaced: PacedChannelSend;

  private app: App | undefined;
  private ctx: SlackContext | undefined;
  private sessionDelivery: SlackSessionDelivery | undefined;
  /** Guards `start()` against double-invocation: the one-time setup (auth.test, context, sibling
   *  registration) must run exactly once per gateway instance. */
  private started = false;
  /** Flips true the moment `stop()` is called and stays true forever after — the single flag every
   *  supervisor step checks before touching the socket, so a restart already in flight cannot race
   *  a shutdown into reconnecting a socket the caller just asked to close. */
  private stopped = true;
  /** Consecutive FAILED CONNECTION ATTEMPTS driving the backoff exponent; reset to 0 on a
   *  successful connect. Advanced in exactly one place — `connectOnce`'s catch — so that a burst
   *  of app-level signals can never walk the delay to its cap without a connection having
   *  actually failed. */
  private attempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  /** True from the moment a reconnect cycle starts its stop()/start() until it finishes. External
   *  "the connection may be gone" signals arriving inside that window are redundant: the cycle
   *  will either succeed or schedule its own retry. */
  private reconnecting = false;
  /** Serializes every reconnect cycle: a signal that arrives while a previous reconnect's
   *  stop()/start() is still in flight (e.g. two `app.error` calls close together) chains onto it
   *  rather than firing a second overlapping cycle, which could otherwise race to be "the" live
   *  socket. Mirrors discordJsGateway.ts's `chainOnRoute` in spirit, at the scale of one socket. */
  private reconnectChain: Promise<void> = Promise.resolve();

  constructor(options: SlackGatewayOptions) {
    this.relay = options.relay;
    this.pairing = options.pairing;
    this.logger = options.logger;
    this.botToken = options.botToken;
    this.appToken = options.appToken;
    this.stateDir = options.stateDir;
    this.appFactory =
      options.appFactory ??
      (() => new App({ token: this.botToken, appToken: this.appToken, socketMode: true }));
    this.random = options.random ?? Math.random;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffMaxMs = options.backoffMaxMs ?? DEFAULT_BACKOFF_MAX_MS;
    this.sendPaced = createChannelPacer();
  }

  /** One-time setup, then hand the socket connection to the supervisor. Never call twice — a
   *  second call is a silent no-op rather than re-registering every sibling's listeners on the
   *  same App instance. */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.stopped = false;

    const app = this.appFactory();
    this.app = app;

    // A real WebClient call, independent of the socket: this is the one setup step the
    // supervisor does NOT retry, because a failure here means the bot token itself is bad, which
    // no amount of reconnecting fixes.
    const auth = await app.client.auth.test();
    const teamId = auth.team_id;
    if (typeof teamId !== 'string' || teamId === '') {
      throw new Error('slack: auth.test did not return a team id');
    }

    const ctx = this.buildContext(app, teamId);
    this.ctx = ctx;

    const sessionDelivery = new SlackSessionDelivery({
      ctx,
      stateDir: this.stateDir,
      sendPaced: this.sendPaced,
    });
    sessionDelivery.register(app);
    this.sessionDelivery = sessionDelivery;
    registerSlackCommands(app, ctx);
    registerSlackInteractivity(app, ctx);

    // The one hook Bolt's public App API gives for "something went wrong after start() already
    // resolved" — Socket Mode's own client is private to the App instance, so this (and a
    // rejected app.start()) are the only two available without reaching into Bolt internals.
    // It carries BOTH transport failures and every exception a listener let escape, hence the
    // classification: see this module's header.
    app.error((error: unknown) => {
      const code = errorCode(error);
      if (code !== undefined && CONNECTION_LOSS_ERROR_CODES.has(code)) {
        this.logger.warn({ err: error, code }, 'slack: transport error (reconnecting)');
        this.signalConnectionLost('app.error');
        return Promise.resolve();
      }
      this.logger.warn({ err: error, code }, 'slack: listener error (connection left alone)');
      return Promise.resolve();
    });

    await this.connectOnce('initial');
  }

  /** Halt the supervisor first, THEN stop the socket — the ordering that makes shutdown never
   *  race a restart: once `stopped` is true, every supervisor entry point (`connectOnce`,
   *  `scheduleRestart`, `reconnect`) bails before touching the socket, so a restart timer that
   *  fires mid-shutdown is a no-op rather than a reconnect the caller no longer wants.
   *
   *  The flag alone is not enough, because it is only ever CHECKED at those entry points: a
   *  reconnect already past its check is mid stop()/start(), and closing the app underneath it
   *  would either double-stop it or race its `app.start()` into a socket still live after this
   *  method resolved. So the chain is drained first, and `connectOnce` re-checks the flag on the
   *  far side of its own await. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = undefined;
    }
    // The chain never rejects in practice (every step handles its own failure); the catch is
    // belt-and-braces so shutdown itself can never throw on the way out.
    await this.reconnectChain.catch(() => undefined);
    // Session delivery's coalescing timers outlive the socket unless it is wound down first, and
    // the edit sitting on one is typically the LAST thing a session had to say.
    if (this.sessionDelivery) {
      await this.sessionDelivery.stop();
    }
    if (this.app) {
      await this.app.stop();
    }
  }

  /** Push one daemon-originated envelope to the Slack user `principalId` names. Never throws —
   *  the relay calls this fire-and-forget, so a bug in any handler below must surface as a log
   *  line, never an unhandled rejection on the relay's socket-message path. */
  async deliver(principalId: string, envelope: Envelope): Promise<void> {
    const parts = parseSlackPrincipal(principalId);
    if (!parts) {
      this.logger.warn(
        { principalId },
        'slack: deliver() called for a non-Slack principal; dropped',
      );
      return;
    }
    if (!this.ctx || !this.sessionDelivery) {
      this.logger.warn(
        { principalId },
        'slack: deliver() called before start() finished setup; dropped',
      );
      return;
    }
    // Namespaced ids are opaque strings the bindings layer never inspects (see principal.ts), so
    // a binding from another workspace parses as a perfectly well-formed Slack principal — this
    // is the ONLY place that checks it against the workspace this gateway is actually running in.
    if (parts.teamId !== this.ctx.teamId) {
      this.logger.warn(
        { principalId, expectedTeamId: this.ctx.teamId },
        'slack: deliver() for a principal from a different workspace; dropped',
      );
      return;
    }
    const { userId } = parts;
    const ctx = this.ctx;
    const sessionDelivery = this.sessionDelivery;

    try {
      // Fed UNCONDITIONALLY, before any first-taker handler below gets a chance to claim the
      // envelope — mirroring DiscordJsGateway.deliver()'s own unconditional `cache.record(...)`
      // as the very first line. DaemonStateCache.record() is already a no-op for kinds it does
      // not track, so this costs nothing for the common case; what it buys is correctness for
      // the uncommon one — e.g. session.status is ALSO owned by session delivery below, and if
      // the cache feed were gated behind "did an earlier handler already claim this", /sessions
      // would silently stop updating the moment session delivery started handling that kind.
      ctx.cache.record(userId, envelope);

      if (await sessionDelivery.handle(userId, envelope)) return;
      if (await deliverCard(ctx, userId, envelope)) return;
      if (isType(envelope, 'stats.result')) {
        // Same contract as the Discord surface: a result with no waiter is dropped, not DM'd —
        // the only intended reader is an interaction that has, by definition, already timed out.
        if (!ctx.statsScans.settle(envelope.payload.requestId, envelope.payload)) {
          this.logger.debug(
            { requestId: envelope.payload.requestId },
            'slack: stats.result with no waiting interaction (timed out, or a restart since)',
          );
        }
        return;
      }
      await this.deliverFallback(ctx, userId, envelope);
    } catch (err) {
      this.logger.warn(
        { err, principalId, envelopeType: envelope.type },
        'slack: deliver() failed',
      );
    }
  }

  /** DM the working-commands primer to a freshly paired Slack user. Sends the Slack-native primer
   *  (see primerMessage.ts) — every line names a real `/cctl <subcommand>`, not Discord's bare
   *  command names, since Slack's v1 command set is both smaller and shaped differently. */
  async sendPrimer(principalId: string): Promise<void> {
    const parts = parseSlackPrincipal(principalId);
    if (!parts || !this.ctx || parts.teamId !== this.ctx.teamId) {
      this.logger.warn({ principalId }, 'slack: sendPrimer() for an unroutable principal; dropped');
      return;
    }
    // Captured before the closure below: narrowing from the guard above does not follow `this.ctx`
    // into a nested function.
    const ctx = this.ctx;
    try {
      const channel = await ctx.openDm(parts.userId);
      // Paced like every other send into this channel: pairing typically lands right alongside the
      // user's first session thread, so the primer and that thread's first messages contend for
      // the same per-channel budget.
      for (const chunk of slackChunks(toMrkdwn(SLACK_PAIRING_PRIMER_MESSAGE))) {
        await this.sendPaced(channel, () => ctx.web.chat.postMessage({ channel, text: chunk }));
      }
    } catch (err) {
      this.logger.warn({ err, principalId }, 'slack: failed to send pairing primer DM');
    }
  }

  /** Build the SlackContext handed to every sibling module. `openDm` closes over its own cache
   *  (keyed by raw Slack user id, never the namespaced principal — see context.ts) so a burst of
   *  envelopes for the same user issues at most one `conversations.open` call each. */
  private buildContext(app: App, teamId: string): SlackContext {
    // The cache holds the in-flight PROMISE, not the resolved channel id, and is populated
    // SYNCHRONOUSLY: caching only the resolved value means a burst of first-time deliveries for
    // one user each miss the cache and each fire their own conversations.open — dozens of calls
    // against a rate-limited endpoint where one would do.
    const dmChannelByUser = new Map<string, Promise<string>>();
    return {
      web: app.client,
      logger: this.logger,
      relay: this.relay,
      pairing: this.pairing,
      teamId,
      cache: new DaemonStateCache(),
      statsScans: new PendingStatsScans(),
      openDm: (slackUserId: string): Promise<string> => {
        const cached = dmChannelByUser.get(slackUserId);
        if (cached !== undefined) return cached;
        const opening = (async (): Promise<string> => {
          const opened = await app.client.conversations.open({ users: slackUserId });
          const channelId = opened.channel?.id;
          if (!channelId) {
            throw new Error(
              `slack: conversations.open returned no channel id for user ${slackUserId}`,
            );
          }
          return channelId;
        })();
        dmChannelByUser.set(slackUserId, opening);
        // A FAILED open is never remembered: caching a rejected promise would pin the user to one
        // transient error for the life of the process, with every later delivery re-throwing it
        // instead of retrying the call.
        void opening.catch(() => {
          if (dmChannelByUser.get(slackUserId) === opening) dmChannelByUser.delete(slackUserId);
        });
        return opening;
      },
      principalOf: (slackUserId: string): string => slackPrincipal(teamId, slackUserId),
    };
  }

  /** Fallback path: an envelope kind neither session delivery nor a card owns. Reuses the same
   *  pure `renderPush` the Discord surface does for its OWN plain-content pushes, taking only
   *  `.content` — `.embeds`/`.components`/`.selects` are discord.js-shaped render output that
   *  `deliverCard` (Block-Kit-native) is responsible for above; a push whose only content is one
   *  of those is a card this gateway already gave `deliverCard` first refusal on, so a `content`
   *  of `undefined` here means "nothing left to send", not "send nothing wrong". */
  private async deliverFallback(
    ctx: SlackContext,
    userId: string,
    envelope: Envelope,
  ): Promise<void> {
    const push = renderPush(envelope);
    if (push?.content === undefined) return;
    const channel = await ctx.openDm(userId);
    // Through the shared pacer, one chunk at a time: an unspaced chunk series is precisely what
    // Slack's per-channel limit rejects, and a rejected middle chunk leaves the DM reading as a
    // truncated message with no marker.
    for (const chunk of slackChunks(toMrkdwn(push.content))) {
      await this.sendPaced(channel, () => ctx.web.chat.postMessage({ channel, text: chunk }));
    }
  }

  /** Attempt (or re-attempt) the Socket Mode connection on the existing App instance. Success
   *  resets the backoff counter; failure hands off to {@link scheduleRestart} rather than
   *  rejecting — a connection failure after `start()`'s one-time setup has already succeeded is
   *  the supervisor's problem, not the caller's. */
  private async connectOnce(reason: string): Promise<void> {
    if (this.stopped || !this.app) return;
    this.logger.info({ reason, attempt: this.attempt }, 'slack: connecting');
    try {
      await this.app.start();
    } catch (err) {
      // THE one place the backoff exponent advances — see the field's own doc.
      this.attempt += 1;
      this.logger.warn({ err, reason, attempt: this.attempt }, 'slack: connect attempt failed');
      this.scheduleRestart(reason, err);
      return;
    }
    // `stop()` can land while `app.start()` is in flight; it saw nothing to drain and returned,
    // so without this re-check the socket brought up by the call above would stay live for the
    // rest of the process, delivering into a gateway the caller believes is shut down.
    if (this.stopped) {
      this.logger.info({ reason }, 'slack: connected after shutdown; closing the socket again');
      try {
        await this.app.stop();
      } catch (err) {
        this.logger.debug({ err }, 'slack: closing a post-shutdown socket failed');
      }
      return;
    }
    this.logger.info({ reason }, 'slack: connected');
    this.attempt = 0;
  }

  /** An EXTERNAL "the connection may be gone" signal (today: the connection-loss subset of
   *  `app.error`). Ignored outright while a retry is already pending or a reconnect cycle is
   *  mid-flight: those paths already own the next attempt, and letting every signal re-arm the
   *  schedule is how a burst of them used to walk the backoff toward its cap. A genuinely failed
   *  connection attempt does NOT come through here — `connectOnce` schedules its own retry
   *  directly, so the guard below can never suppress the retry chain's own next hop. */
  private signalConnectionLost(reason: string, err?: unknown): void {
    if (this.stopped) return;
    if (this.restartTimer !== undefined || this.reconnecting) {
      this.logger.debug({ reason, err }, 'slack: reconnect already in progress; signal ignored');
      return;
    }
    this.scheduleRestart(reason, err);
  }

  /** Schedule the next reconnect after a capped exponential backoff with full jitter (uniform in
   *  `[0, min(max, base * 2^attempt))`, floored — see {@link MIN_RECONNECT_DELAY_MS}). Full jitter
   *  (rather than a fixed or "equal" jitter fraction) is the AWS-recommended shape for exactly
   *  this problem: it spreads retries across the WHOLE window instead of clustering near either
   *  the deterministic curve or a coin-flip around it, which matters here because every bot
   *  process hitting the same Slack-side outage would otherwise reconnect on the same schedule. */
  private scheduleRestart(reason: string, err?: unknown): void {
    if (this.stopped) return;
    // At most one pending retry per gateway: two timers would mean two independent reconnect
    // cycles racing to be "the" live socket.
    if (this.restartTimer) return;
    const delayMs = this.nextDelayMs();
    this.logger.warn(
      { reason, err, attempt: this.attempt, delayMs },
      'slack: scheduling reconnect',
    );
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      // Chained, not fired directly: a reconnect already in flight (started by an earlier signal
      // whose delay elapsed first) must finish its stop()/start() cycle before this one begins its
      // own, or the two could interleave into two live sockets racing to be "the" connection.
      // The chain is also what `stop()` drains, so shutdown cannot resolve mid-cycle.
      this.reconnectChain = this.reconnectChain.then(() => this.reconnect(reason));
    }, delayMs);
    // Do not keep the event loop alive solely for a pending reconnect.
    if (typeof this.restartTimer.unref === 'function') this.restartTimer.unref();
  }

  /** Stop the (presumably already-broken) socket before starting it again — App/Socket Mode
   *  reconnection is a stop-then-start cycle on the SAME instance, not a fresh App construction,
   *  so every sibling's listeners (registered once, in `start()`) stay attached across restarts. */
  private async reconnect(reason: string): Promise<void> {
    if (this.stopped || !this.app) return;
    this.reconnecting = true;
    try {
      try {
        await this.app.stop();
      } catch (err) {
        this.logger.debug({ err }, 'slack: stop before reconnect failed (already down?)');
      }
      await this.connectOnce(reason);
    } finally {
      // Cleared only after connectOnce has had its chance to schedule the NEXT retry, so the
      // window in which a redundant external signal is ignored covers the whole cycle.
      this.reconnecting = false;
    }
  }

  private nextDelayMs(): number {
    const window = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** this.attempt);
    const floor = Math.min(MIN_RECONNECT_DELAY_MS, window);
    return Math.max(floor, Math.round(this.random() * window));
  }
}
