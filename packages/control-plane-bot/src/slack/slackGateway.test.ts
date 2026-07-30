// Unit tests for the Slack composition root. Every sibling this module wires (slackCommands.js,
// slackBlocks.js, slackSessionDelivery.js) is mocked: these tests are about SlackGateway's OWN
// logic — dispatch order, principal checks, the reconnect supervisor — not about what any sibling
// actually renders. `App` itself is stood in via `appFactory` (see fakeApp below): Bolt's App has
// private fields a plain object literal can never structurally satisfy, so the fake is cast through
// `unknown` rather than typed as a real App — the standard shape for faking a class with private
// state, and the only methods this gateway ever calls on it (client/start/stop/error) are real here.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Envelope } from '@claude-control/shared-protocol';
import type { App } from '@slack/bolt';
import type { PairingService } from '../pairing.js';
import type { RelaySender } from '../relay.js';
import type { SlackContext } from './context.js';

vi.mock('./slackCommands.js', () => ({
  registerSlackCommands: vi.fn(),
}));
vi.mock('./slackBlocks.js', () => ({
  registerSlackInteractivity: vi.fn(),
  deliverCard: vi.fn(() => Promise.resolve(false)),
}));
vi.mock('./slackSessionDelivery.js', () => ({
  SlackSessionDelivery: vi.fn().mockImplementation(() => ({
    handle: vi.fn(() => Promise.resolve(false)),
    register: vi.fn(),
    stop: vi.fn(() => Promise.resolve()),
  })),
}));

import { SlackGateway, type SlackGatewayOptions } from './slackGateway.js';
import { registerSlackCommands } from './slackCommands.js';
import { registerSlackInteractivity, deliverCard } from './slackBlocks.js';
import { SlackSessionDelivery } from './slackSessionDelivery.js';

interface FakeAppClient {
  auth: { test: ReturnType<typeof vi.fn> };
  conversations: { open: ReturnType<typeof vi.fn> };
  chat: { postMessage: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
}

/** The fake's own shape, kept as the bundle's static type instead of `App`: tests assert on
 *  `app.start.mock`, and typing the field as the real App would hide the mocks behind Bolt's own
 *  method signatures. The unknown-cast to `App` happens once, where appFactory hands it over. */
interface FakeAppLike {
  client: FakeAppClient;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

interface FakeAppBundle {
  app: FakeAppLike;
  client: FakeAppClient;
  getErrorHandler: () => ((error: unknown) => void | Promise<void>) | undefined;
}

/** A Bolt App stand-in exposing exactly what SlackGateway touches. `team_id: 'T123'` and the
 *  `D-<user>` channel-id convention are shared fixtures every test below relies on. */
function fakeApp(
  overrides: { start?: () => Promise<unknown>; stop?: () => Promise<unknown> } = {},
): FakeAppBundle {
  const client = {
    auth: { test: vi.fn(() => Promise.resolve({ ok: true, team_id: 'T123' })) },
    conversations: {
      open: vi.fn(({ users }: { users: string }) =>
        Promise.resolve({ ok: true, channel: { id: `D-${users}` } }),
      ),
    },
    chat: {
      postMessage: vi.fn(() => Promise.resolve({ ok: true, ts: '1.1' })),
      update: vi.fn(() => Promise.resolve({ ok: true })),
    },
  };
  let errorHandler: ((error: unknown) => void | Promise<void>) | undefined;
  const appLike = {
    client,
    start: vi.fn(overrides.start ?? (() => Promise.resolve(undefined))),
    stop: vi.fn(overrides.stop ?? (() => Promise.resolve(undefined))),
    error: vi.fn((handler: (error: unknown) => void | Promise<void>) => {
      errorHandler = handler;
    }),
  };
  return { app: appLike, client, getErrorHandler: () => errorHandler };
}

function makeGateway(
  overrides: Partial<SlackGatewayOptions> = {},
  bundle: FakeAppBundle = fakeApp(),
) {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const relay: RelaySender = {
    sendToUser: vi.fn(() => ({ ok: true as const })),
    isOnline: vi.fn(() => true),
  };
  const pairing = {} as PairingService; // never called by SlackGateway itself — only threaded into ctx
  const gateway = new SlackGateway({
    relay,
    pairing,
    logger,
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    stateDir: 'unused-in-tests',
    appFactory: () => bundle.app as unknown as App,
    // Small enough that even a few backoff hops finish in well under a test timeout, matching
    // this package's house convention of real timers over fake ones.
    backoffBaseMs: 3,
    backoffMaxMs: 12,
    random: () => 0.5,
    ...overrides,
  });
  return { gateway, logger, relay, ...bundle };
}

/** Poll a real clock rather than fake Vitest timers — see the module doc for why. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The SlackContext SlackGateway built in `start()`, recovered from a mock's own call args rather
 *  than exposed by the gateway itself — the same context every sibling (and this test) sees. */
function ctxFromMocks(): SlackContext {
  const calls = vi.mocked(registerSlackCommands).mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('registerSlackCommands was never called — call gateway.start() first');
  return last[1];
}

interface FakeSessionDelivery {
  handle: ReturnType<typeof vi.fn>;
  register: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function sessionDeliveryInstance(): FakeSessionDelivery {
  const results = vi.mocked(SlackSessionDelivery).mock.results;
  const last = results[results.length - 1];
  if (!last || last.type !== 'return') {
    throw new Error('SlackSessionDelivery was never constructed — call gateway.start() first');
  }
  // Through `unknown`: the mocked constructor is declared as returning the real class, but the
  // vi.mock factory above hands back a mocks-only object with no structural overlap.
  return last.value as unknown as FakeSessionDelivery;
}

/** A Bolt-shaped coded error. Bolt stamps `.code` on everything it routes to `app.error`
 *  (`asCodedError` wraps a bare throw in `UnknownError`), and that code is the ONLY thing
 *  separating "the socket died" from "a listener threw" — see slackGateway.ts's header. */
function codedError(code: string, message = 'boom'): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/** Real socket-mode transport failure code (see @slack/socket-mode's ErrorCode). */
const WEBSOCKET_ERROR_CODE = 'slack_socket_mode_websocket_error';
/** Real @slack/web-api code for e.g. `message_not_found` on a `chat.update` — a listener-level
 *  failure that must NEVER take the connection down with it. */
const WEB_API_PLATFORM_ERROR_CODE = 'slack_webapi_platform_error';

function baseEnvelope(type: string, payload: unknown): Envelope {
  return {
    v: 1,
    id: 'id-1',
    ts: 0,
    daemonId: 'daemon-1',
    // Generic routed-principal field every envelope carries (see relay.ts) — SlackGateway.deliver
    // takes the real principal as its own explicit argument and never reads this one.
    discordUserId: 'unused-field',
    type,
    payload,
  } as Envelope;
}

function sessionStatusEnvelope(sessionId = 'sess-1'): Envelope {
  return baseEnvelope('session.status', { sessionId, state: 'running', summary: null });
}

function permissionRequestEnvelope(): Envelope {
  return baseEnvelope('permission.request', {
    requestId: 'req-1',
    summary: 'run rm -rf /',
    detail: null,
    permissionMode: null,
  });
}

function statsResultEnvelope(requestId: string): Envelope {
  return baseEnvelope('stats.result', {
    requestId,
    ok: true,
    snapshot: {
      windowStartMs: 0,
      windowEndMs: 1000,
      overall: { input: 1, output: 2, cacheCreation: 0, cacheRead: 0, turns: 1 },
      byAccount: [],
      byModel: [],
      byDay: [],
      coverage: {
        filesScanned: 0,
        filesSkippedByMtime: 0,
        filesUnreadable: 0,
        dirsUnreadable: 0,
        malformedLines: 0,
        duplicateTurns: 0,
      },
    },
  });
}

/** kind: 'summary' (never 'stdout') is the one session.output shape renderPush turns into a DM —
 *  see discord/pushRender.ts. Plain, table-free text passes through formatTables close to
 *  verbatim, which is what lets a long fixture actually exercise multi-chunk delivery below. */
function summaryOutputEnvelope(sessionId: string, text: string): Envelope {
  return baseEnvelope('session.output', {
    sessionId,
    seq: 0,
    kind: 'summary',
    text,
    truncated: false,
  });
}

const PRINCIPAL_U1 = 'slack:T123:U1';

describe('SlackGateway', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('start() / stop()', () => {
    it('authenticates, wires every sibling exactly once, and connects the socket', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);

      await gateway.start();

      expect(bundle.client.auth.test).toHaveBeenCalledTimes(1);
      expect(bundle.app.start).toHaveBeenCalledTimes(1);
      expect(vi.mocked(registerSlackCommands)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(registerSlackInteractivity)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(SlackSessionDelivery)).toHaveBeenCalledTimes(1);
      expect(sessionDeliveryInstance().register).toHaveBeenCalledWith(bundle.app);

      // A second start() is a no-op: it must not re-run one-time setup or open a second socket.
      await gateway.start();
      expect(bundle.client.auth.test).toHaveBeenCalledTimes(1);
      expect(bundle.app.start).toHaveBeenCalledTimes(1);
    });

    it('rejects when auth.test cannot resolve a team id — a broken token is not retried', async () => {
      const bundle = fakeApp();
      bundle.client.auth.test.mockResolvedValueOnce({ ok: false });
      const { gateway } = makeGateway({}, bundle);

      await expect(gateway.start()).rejects.toThrow(/team id/);
      expect(bundle.app.start).not.toHaveBeenCalled();
    });

    it('stop() closes the socket and halts the supervisor', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();

      await gateway.stop();
      expect(bundle.app.stop).toHaveBeenCalledTimes(1);
    });

    it('stop() winds session delivery down BEFORE closing the socket', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();

      await gateway.stop();

      // Ordering is the point, not just the call: a final coalesced status edit still needs a
      // live connection to go out on.
      expect(sd.stop).toHaveBeenCalledTimes(1);
      expect(sd.stop.mock.invocationCallOrder[0]!).toBeLessThan(
        bundle.app.stop.mock.invocationCallOrder[0]!,
      );
    });
  });

  describe('reconnect supervisor', () => {
    it('retries a failed app.start() with capped backoff, and resets the counter once it succeeds', async () => {
      let calls = 0;
      const bundle = fakeApp({
        start: () => {
          calls += 1;
          return calls < 3 ? Promise.reject(new Error('socket unreachable')) : Promise.resolve();
        },
      });
      const { gateway, logger } = makeGateway({ backoffBaseMs: 3, backoffMaxMs: 10 }, bundle);

      await gateway.start(); // the FIRST attempt runs synchronously inside start() and fails
      expect(bundle.app.start).toHaveBeenCalledTimes(1);

      await waitFor(() => bundle.app.start.mock.calls.length >= 3);
      expect(calls).toBe(3);
      // Every transition (attempt, delay) is logged — not just the eventual success.
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ reason: 'initial' }),
        expect.stringContaining('scheduling reconnect'),
      );

      await gateway.stop();
    });

    it('stop() cancels a pending restart so a scheduled retry never fires after shutdown', async () => {
      const bundle = fakeApp({
        start: () => Promise.reject(new Error('socket unreachable')),
      });
      const { gateway } = makeGateway({ backoffBaseMs: 50, backoffMaxMs: 50 }, bundle);

      await gateway.start(); // fails once, schedules a retry ~25-50ms out (random() = 0.5)
      expect(bundle.app.start).toHaveBeenCalledTimes(1);

      await gateway.stop(); // must cancel the pending timer before it can fire
      const startCallsAtShutdown = bundle.app.start.mock.calls.length;

      // Outlive the window the cancelled retry would have fired in.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(bundle.app.start.mock.calls.length).toBe(startCallsAtShutdown);
    });

    it('treats a TRANSPORT-level app.error as a disconnect signal and reconnects the same App instance', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({ backoffBaseMs: 3, backoffMaxMs: 10 }, bundle);
      await gateway.start();
      expect(bundle.app.start).toHaveBeenCalledTimes(1);
      expect(bundle.app.stop).not.toHaveBeenCalled();

      const handler = bundle.getErrorHandler();
      expect(handler).toBeTypeOf('function');
      await handler?.(codedError(WEBSOCKET_ERROR_CODE, 'ECONNRESET'));

      await waitFor(() => bundle.app.start.mock.calls.length >= 2);
      // Reconnect is a stop-then-start cycle on the SAME app — never a second App construction —
      // which is what keeps every sibling's listeners attached across the restart.
      expect(bundle.app.stop).toHaveBeenCalledTimes(1);

      await gateway.stop();
    });

    it('leaves the connection alone for a LISTENER-level app.error, however many arrive', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({ backoffBaseMs: 3, backoffMaxMs: 10 }, bundle);
      await gateway.start();
      const handler = bundle.getErrorHandler();

      // Bolt routes every rejection escaping a listener here. One failed chat.update on a card
      // the user deleted must not tear the socket down for every user in the workspace.
      for (let i = 0; i < 5; i++) {
        await handler?.(codedError(WEB_API_PLATFORM_ERROR_CODE, 'message_not_found'));
      }
      // A bare throw (no code at all) is the same class of thing and gets the same treatment.
      await handler?.(new Error('a listener threw a plain Error'));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(bundle.app.stop).not.toHaveBeenCalled();
      expect(bundle.app.start).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ code: WEB_API_PLATFORM_ERROR_CODE }),
        expect.stringContaining('connection left alone'),
      );

      await gateway.stop();
    });

    it('does not advance the backoff for signals that never cost a connection attempt', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({ backoffBaseMs: 4, backoffMaxMs: 4_000 }, bundle);
      await gateway.start();
      const handler = bundle.getErrorHandler();

      // A burst of transport signals arriving together is ONE lost connection, not six: the
      // first arms a retry and the rest are redundant. Counting them as failures instead walked
      // the delay toward the cap without a single attempt having failed.
      for (let i = 0; i < 6; i++) await handler?.(codedError(WEBSOCKET_ERROR_CODE));
      await waitFor(() => bundle.app.start.mock.calls.length >= 2);

      const scheduled = logger.warn.mock.calls.filter((call) =>
        String(call[1]).includes('scheduling reconnect'),
      );
      expect(scheduled).toHaveLength(1);
      // attempt is still 0 (nothing failed to connect), so the window is the un-doubled base.
      expect(scheduled[0]![0]).toMatchObject({ attempt: 0 });

      await gateway.stop();
    });

    it('never returns a zero-length backoff delay, even when jitter bottoms out', async () => {
      const bundle = fakeApp({ start: () => Promise.reject(new Error('socket unreachable')) });
      // random() = 0 is the corner full jitter makes reachable; without a floor the supervisor
      // would re-attempt on a 0ms timer, i.e. a tight loop against a fast-failing connect.
      const { gateway, logger } = makeGateway(
        { backoffBaseMs: 1_000, backoffMaxMs: 60_000, random: () => 0 },
        bundle,
      );

      await gateway.start();
      const scheduled = logger.warn.mock.calls.find((call) =>
        String(call[1]).includes('scheduling reconnect'),
      );
      expect((scheduled?.[0] as { delayMs: number }).delayMs).toBeGreaterThanOrEqual(100);

      await gateway.stop();
    });

    it('never schedules a restart after stop(), even for an error that fires post-shutdown', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const handler = bundle.getErrorHandler();

      await gateway.stop();
      const startCallsAtShutdown = bundle.app.start.mock.calls.length;
      await handler?.(codedError(WEBSOCKET_ERROR_CODE, 'late error after shutdown'));
      await new Promise((resolve) => setTimeout(resolve, 30));

      expect(bundle.app.start.mock.calls.length).toBe(startCallsAtShutdown);
    });

    it('stop() drains a reconnect already in flight instead of racing it', async () => {
      let releaseStart: (() => void) | undefined;
      let starts = 0;
      const bundle = fakeApp({
        start: () => {
          starts += 1;
          if (starts === 1) return Promise.reject(new Error('socket unreachable'));
          // The reconnect's app.start() is held open across the stop() call below, which is the
          // window in which the old code could resolve shutdown with a socket still coming up.
          return new Promise<void>((resolve) => {
            releaseStart = resolve;
          });
        },
      });
      const { gateway } = makeGateway({ backoffBaseMs: 1, backoffMaxMs: 2 }, bundle);

      await gateway.start(); // attempt 1 fails and schedules the retry
      await waitFor(() => starts >= 2); // the retry is now parked inside app.start()

      const stopping = gateway.stop();
      let settled = false;
      void stopping.then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled).toBe(false); // still draining the reconnect

      releaseStart?.();
      await stopping;

      // The socket that came up mid-shutdown is closed again by connectOnce's own re-check, and
      // stop() closes it as well — what matters is that neither is left running.
      expect(bundle.app.stop.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(bundle.app.start).toHaveBeenCalledTimes(2);
    });
  });

  describe('DM channel caching', () => {
    it('opens a conversation at most once per Slack user id', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const ctx = ctxFromMocks();

      expect(await ctx.openDm('U1')).toBe('D-U1');
      expect(await ctx.openDm('U1')).toBe('D-U1');
      expect(await ctx.openDm('U2')).toBe('D-U2');

      expect(bundle.client.conversations.open).toHaveBeenCalledTimes(2);
    });

    it('collapses a burst of concurrent first-time opens into one API call', async () => {
      const bundle = fakeApp();
      let release: ((value: unknown) => void) | undefined;
      bundle.client.conversations.open.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const ctx = ctxFromMocks();

      // Nothing is awaited between these: caching the resolved VALUE (rather than the in-flight
      // promise) means every one of them misses the cache and fires its own conversations.open,
      // against an endpoint that rate-limits hard.
      const pending = [ctx.openDm('U1'), ctx.openDm('U1'), ctx.openDm('U1'), ctx.openDm('U1')];
      expect(bundle.client.conversations.open).toHaveBeenCalledTimes(1);

      release?.({ ok: true, channel: { id: 'D-U1' } });
      expect(await Promise.all(pending)).toEqual(['D-U1', 'D-U1', 'D-U1', 'D-U1']);
      expect(bundle.client.conversations.open).toHaveBeenCalledTimes(1);
    });

    it('retries after a failed open instead of caching the failure forever', async () => {
      const bundle = fakeApp();
      bundle.client.conversations.open.mockRejectedValueOnce(new Error('transient'));
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const ctx = ctxFromMocks();

      await expect(ctx.openDm('U1')).rejects.toThrow('transient');
      // A remembered rejection would pin this user to that one error for the process's life.
      expect(await ctx.openDm('U1')).toBe('D-U1');
      expect(bundle.client.conversations.open).toHaveBeenCalledTimes(2);
    });
  });

  describe('deliver() dispatch order', () => {
    it('feeds the state cache unconditionally, even when session delivery claims the envelope', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();
      sd.handle.mockResolvedValueOnce(true);

      await gateway.deliver(PRINCIPAL_U1, sessionStatusEnvelope('sess-1'));

      expect(sd.handle).toHaveBeenCalledWith(
        'U1',
        expect.objectContaining({ type: 'session.status' }),
      );
      expect(vi.mocked(deliverCard)).not.toHaveBeenCalled();
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
      // The cache feed is NOT gated behind "did an earlier handler already claim this" — see the
      // production code's comment for why that gate would silently break /sessions.
      const ctx = ctxFromMocks();
      expect(ctx.cache.getSessions('U1')).toHaveLength(1);
      expect(ctx.cache.getSessions('U1')[0]?.sessionId).toBe('sess-1');
    });

    it('falls through to deliverCard when session delivery does not own the envelope', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();
      sd.handle.mockResolvedValueOnce(false);
      vi.mocked(deliverCard).mockResolvedValueOnce(true);

      await gateway.deliver(PRINCIPAL_U1, permissionRequestEnvelope());

      expect(sd.handle).toHaveBeenCalledTimes(1);
      expect(deliverCard).toHaveBeenCalledWith(
        expect.anything(),
        'U1',
        expect.objectContaining({ type: 'permission.request' }),
      );
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('settles a waiting /stats scan instead of posting a DM, when no card owns the envelope', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      const ctx = ctxFromMocks();
      const waiting = ctx.statsScans.awaitResult('req-1', 5_000);

      await gateway.deliver(PRINCIPAL_U1, statsResultEnvelope('req-1'));

      const outcome = await waiting;
      expect(outcome.kind).toBe('result');
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('drops a stats.result with no waiter, rather than falling through to a DM', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();

      await gateway.deliver(PRINCIPAL_U1, statsResultEnvelope('never-awaited'));

      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
      expect(logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: 'never-awaited' }),
        expect.stringContaining('no waiting interaction'),
      );
    });

    it('falls back to a chunked, mrkdwn-converted DM for an unowned content-bearing envelope', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();
      // Long enough (with no tables, so formatTables passes it through close to verbatim) to
      // exceed slackChunks' default 3000-char budget and force a real multi-message split.
      const longText = `**bold marker**\n${'line of plain summary text\n'.repeat(200)}`;

      const sentAtMs: number[] = [];
      bundle.client.chat.postMessage.mockImplementation(() => {
        sentAtMs.push(Date.now());
        return Promise.resolve({ ok: true, ts: '1.1' });
      });

      await gateway.deliver(PRINCIPAL_U1, summaryOutputEnvelope('sess-2', longText));

      expect(bundle.client.chat.postMessage.mock.calls.length).toBeGreaterThan(1);
      const firstCallArgs = bundle.client.chat.postMessage.mock.calls[0]?.[0] as {
        channel: string;
        text: string;
      };
      expect(firstCallArgs.channel).toBe('D-U1');
      // toMrkdwn ran: Discord's '**bold**' became Slack's single-asterisk bold.
      expect(firstCallArgs.text).toContain('*bold marker*');
      expect(firstCallArgs.text).not.toContain('**bold marker**');
      // Chunks are SPACED, not fired back to back: Slack's ~1 msg/sec ceiling is per channel, and
      // an unspaced series comes back 429 for everything past the first — a DM that reads as a
      // silently truncated message.
      for (let i = 1; i < sentAtMs.length; i++) {
        expect(sentAtMs[i]! - sentAtMs[i - 1]!).toBeGreaterThanOrEqual(900);
      }
    }, 20_000);

    it('sends nothing for a cache-only envelope (renderPush returns undefined)', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();

      // stdout is the one session.output kind renderPush deliberately drops (too high-volume for
      // a DM) — see discord/pushRender.ts.
      await gateway.deliver(
        PRINCIPAL_U1,
        baseEnvelope('session.output', {
          sessionId: 'sess-3',
          seq: 0,
          kind: 'stdout',
          text: 'raw output',
          truncated: false,
        }),
      );

      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('hostile/malformed principals', () => {
    it('drops a non-Slack principal without throwing or touching any handler', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();

      // A bare Discord snowflake — never namespaced, never routable to this gateway.
      await expect(
        gateway.deliver('123456789012345678', sessionStatusEnvelope()),
      ).resolves.toBeUndefined();

      expect(sd.handle).not.toHaveBeenCalled();
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: '123456789012345678' }),
        expect.stringContaining('non-Slack principal'),
      );
    });

    it('drops a well-formed Slack principal from a different workspace', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();

      await gateway.deliver('slack:OTHER_TEAM:U1', sessionStatusEnvelope());

      expect(sd.handle).not.toHaveBeenCalled();
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: 'slack:OTHER_TEAM:U1', expectedTeamId: 'T123' }),
        expect.stringContaining('different workspace'),
      );
    });

    it('drops delivery gracefully when called before start() has finished setup', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      // Deliberately never call gateway.start().

      await expect(gateway.deliver(PRINCIPAL_U1, sessionStatusEnvelope())).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: PRINCIPAL_U1 }),
        expect.stringContaining('before start()'),
      );
    });

    it('never throws out of deliver() even when a handler itself throws', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();
      const sd = sessionDeliveryInstance();
      sd.handle.mockRejectedValueOnce(new Error('boom'));

      await expect(gateway.deliver(PRINCIPAL_U1, sessionStatusEnvelope())).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: PRINCIPAL_U1 }),
        expect.stringContaining('deliver() failed'),
      );
    });
  });

  describe('sendPrimer()', () => {
    it('DMs the mrkdwn-converted primer to a freshly paired Slack user', async () => {
      const bundle = fakeApp();
      const { gateway } = makeGateway({}, bundle);
      await gateway.start();

      await gateway.sendPrimer(PRINCIPAL_U1);

      expect(bundle.client.conversations.open).toHaveBeenCalledWith({ users: 'U1' });
      const call = bundle.client.chat.postMessage.mock.calls[0]?.[0] as {
        channel: string;
        text: string;
      };
      expect(call.channel).toBe('D-U1');
      expect(call.text).toContain('Paired');
      // The primer's source markdown ('**bold**', CommonMark-style) went through toMrkdwn and came
      // out as Slack's single-asterisk bold.
      expect(call.text).not.toContain('**');
    });

    it('drops a primer for an unroutable principal without throwing', async () => {
      const bundle = fakeApp();
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();

      await expect(gateway.sendPrimer('not-a-slack-principal')).resolves.toBeUndefined();
      expect(bundle.client.chat.postMessage).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: 'not-a-slack-principal' }),
        expect.stringContaining('unroutable'),
      );
    });

    it('logs and swallows a failed primer DM rather than throwing', async () => {
      const bundle = fakeApp();
      bundle.client.chat.postMessage.mockRejectedValueOnce(new Error('user has DMs closed'));
      const { gateway, logger } = makeGateway({}, bundle);
      await gateway.start();

      await expect(gateway.sendPrimer(PRINCIPAL_U1)).resolves.toBeUndefined();
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ principalId: PRINCIPAL_U1 }),
        expect.stringContaining('failed to send'),
      );
    });
  });
});
