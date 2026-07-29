import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stamp, type Envelope } from '@claude-control/shared-protocol';
import { SlackSessionDelivery } from './slackSessionDelivery.js';
import { createChannelPacer } from './slackGateway.js';
import type { SlackContext } from './context.js';
import { PersistentThreadRegistry, type DeliveryTarget } from '../discord/threadRegistry.js';
import { SLACK_LIMITS } from './slackFormat.js';

/** The Slack-owned subdirectory of the deployment state dir the thread registry actually lives
 *  in — see SlackSessionDeliveryOptions.stateDir for why it is not the state dir itself. */
const REGISTRY_DIR = 'slack';

// -----------------------------------------------------------------------------
// Envelope builders — mirror exactly what the daemon actually sends (via stamp()) rather than
// hand-rolling envelope shapes that could drift from the real wire contract.
// -----------------------------------------------------------------------------

function outputEnvelope(
  sessionId: string,
  seq: number,
  kind: 'stdout' | 'milestone' | 'summary' | 'error',
  text: string,
  truncated = false,
): Envelope {
  return stamp({
    daemonId: 'daemon-1',
    type: 'session.output',
    payload: { sessionId, seq, kind, text, truncated },
  });
}

function statusEnvelope(
  sessionId: string,
  state:
    | 'starting'
    | 'running'
    | 'waiting_input'
    | 'waiting_permission'
    | 'done'
    | 'failed'
    | 'orphaned',
  summary?: string,
): Envelope {
  return stamp({
    daemonId: 'daemon-1',
    type: 'session.status',
    payload: { sessionId, state, ...(summary !== undefined ? { summary } : {}) },
  });
}

// -----------------------------------------------------------------------------
// Fakes
// -----------------------------------------------------------------------------

/** A `chat.postMessage`/`chat.update` stand-in with deterministic, always-unique `ts` values so
 *  assertions never depend on wall-clock time (fake timers freeze `Date.now()` for long stretches
 *  of a test). */
function fakeWeb() {
  let n = 0;
  const postMessage = vi.fn((args: { channel: string; text: string; thread_ts?: string }) =>
    Promise.resolve({ ok: true, channel: args.channel, ts: `${1_700_000_000 + n++}.000000` }),
  );
  const update = vi.fn((args: { channel: string; ts: string; text: string }) =>
    Promise.resolve({ ok: true, channel: args.channel, ts: args.ts }),
  );
  return { chat: { postMessage, update } };
}

/** Captures whatever `sendToUser` is asked to send, without a real relay/daemon on the other end —
 *  `build` is invoked exactly the way RelayServer invokes it (with a fixed daemon id), so a test
 *  observes the real envelope draft `handleSay` produces. */
function fakeRelay() {
  const sent: Array<{ userId: string; draft: unknown }> = [];
  const sendToUser = vi.fn((userId: string, build: (daemonId: string) => unknown) => {
    sent.push({ userId, draft: build('daemon-1') });
    return { ok: true as const };
  });
  const isOnline = vi.fn(() => true);
  return { sent, sendToUser, isOnline };
}

/** A minimal `App` stand-in: captures the single `message` listener `register()` installs so a
 *  test can fire it directly with a fabricated event, without a real Socket Mode connection. */
function fakeApp() {
  let handler: ((args: { message: Record<string, unknown> }) => Promise<void>) | undefined;
  const app = {
    message: (fn: typeof handler) => {
      handler = fn;
    },
  };
  return {
    app: app as unknown as import('@slack/bolt').App,
    trigger: async (message: Record<string, unknown>) => {
      if (!handler) throw new Error('register() was never called');
      await handler({ message });
    },
  };
}

interface Rig {
  ctx: SlackContext;
  web: ReturnType<typeof fakeWeb>;
  relay: ReturnType<typeof fakeRelay>;
  openDm: ReturnType<typeof vi.fn>;
}

function fakeCtx(overrides: Partial<SlackContext> = {}): Rig {
  const web = fakeWeb();
  const relay = fakeRelay();
  const dmChannels = new Map<string, string>();
  const openDm = vi.fn((slackUserId: string) => {
    let ch = dmChannels.get(slackUserId);
    if (!ch) {
      ch = `D${slackUserId}`;
      dmChannels.set(slackUserId, ch);
    }
    return Promise.resolve(ch);
  });
  const ctx = {
    web: web as unknown as SlackContext['web'],
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    relay,
    pairing: {} as SlackContext['pairing'],
    teamId: 'T1',
    cache: {} as SlackContext['cache'],
    statsScans: {} as SlackContext['statsScans'],
    openDm,
    principalOf: (slackUserId: string) => `slack:T1:${slackUserId}`,
    ...overrides,
  };
  return { ctx, web, relay, openDm };
}

/** Build the module under test with the surface's REAL per-channel pacer (see
 *  createChannelPacer), not a pass-through stand-in: the spacing assertions below are only worth
 *  anything if the timing under test is the timing production gets. A fresh pacer per instance
 *  matches production, where one gateway owns exactly one — so a "restarted process" fixture
 *  (a second instance over the same stateDir) correctly starts with an empty one. */
function makeDelivery(ctx: SlackContext, stateDir: string): SlackSessionDelivery {
  return new SlackSessionDelivery({ ctx, stateDir, sendPaced: createChannelPacer() });
}

/** The UNFAKED timer, captured at module load (before any `useFakeTimers`). `settle` below needs
 *  to hand the real event loop a turn, and inside a test every scheduling primitive is
 *  virtualized — including the one `advanceTimersByTimeAsync` would otherwise break on. */
const realSetTimeout = globalThis.setTimeout;

/** Yield to the REAL event loop, so anything blocked on actual disk I/O can complete. */
function yieldToRealLoop(): Promise<void> {
  return new Promise((resolve) => {
    realSetTimeout(resolve, 0);
  });
}

/** Drive fake time forward until `pending` settles. Needed wherever one flush sends MORE than one
 *  message: the second and later sends deliberately wait out the per-channel interval, so the
 *  promise the test is awaiting cannot settle until the clock moves — hence the
 *  fire-then-advance-then-await shape at every call site.
 *
 *  A LOOP with a real-loop yield in it, not one big jump, because these chains interleave virtual
 *  waits with real disk I/O (the thread registry persists through the filesystem). Advancing
 *  virtual time does nothing for the I/O, and when no fake timer is pending the advance does not
 *  even give the event loop a turn — so a single jump lands entirely before the write completes,
 *  and the pacing timer created after it has nobody left to advance it. That is a deadlock in the
 *  fixture, not in the code under test. */
async function settle(pending: Promise<unknown>, maxSteps = 400): Promise<void> {
  let done = false;
  const tracked = pending.then(
    (value) => {
      done = true;
      return value;
    },
    (err: unknown) => {
      done = true;
      throw err;
    },
  );
  void tracked.catch(() => undefined); // the real failure is re-thrown by the await below
  for (let step = 0; step < maxSteps && !done; step++) {
    await yieldToRealLoop();
    await vi.advanceTimersByTimeAsync(SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS);
  }
  // Fail loudly rather than hanging until the runner's timeout: "never settled" is a real result
  // and the message names it, where a bare `await` on a dead promise names nothing.
  if (!done) throw new Error(`settle: still pending after ${maxSteps} steps of virtual time`);
  await tracked;
}

const dirs: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slack-session-delivery-'));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.useRealTimers();
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
});

// -----------------------------------------------------------------------------
// handle() — dispatch ownership
// -----------------------------------------------------------------------------

describe('handle — envelope ownership', () => {
  it('owns session.output and session.status, and declines everything else', async () => {
    const { ctx } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    expect(await delivery.handle('U1', outputEnvelope('s1', 0, 'stdout', 'hi'))).toBe(true);
    expect(await delivery.handle('U1', statusEnvelope('s1', 'running'))).toBe(true);

    const usageEnvelope = stamp({
      daemonId: 'daemon-1',
      type: 'usage.snapshot',
      payload: { accounts: [] },
    });
    expect(await delivery.handle('U1', usageEnvelope)).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// Thread creation + persistence
// -----------------------------------------------------------------------------

describe('thread creation', () => {
  it('posts a parent message naming the session on the first envelope, and persists the mapping', async () => {
    const { ctx, web, openDm } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('sess-abc', 'starting'));

    expect(openDm).toHaveBeenCalledWith('U1');
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
    // Guaranteed present by the call-count assertion directly above.
    const call = web.chat.postMessage.mock.calls[0]!;
    expect(call[0].channel).toBe('DU1');
    expect(call[0].text).toContain('sess-abc');

    // Persisted through threadRegistry.ts's own on-disk format — a fresh registry over the same
    // (Slack-owned) directory must see the mapping, and it must decode as this module's
    // channel:ts encoding.
    const reg = new PersistentThreadRegistry(join(stateDir, REGISTRY_DIR));
    await reg.load();
    const target = reg.get('U1', 'sess-abc');
    expect(target?.kind).toBe('thread');
    if (target?.kind === 'thread') {
      const [channelId, ts] = target.threadId.split(':');
      expect(channelId).toBe('DU1');
      expect(ts).toBeTruthy();
    }
  });

  it('keeps its thread registry out of the state dir another surface writes to', async () => {
    const { ctx } = fakeCtx();
    const stateDir = await tempDir();

    // The Discord surface's registry: same class, same filename, rooted at the shared state dir
    // both surfaces are handed. record() rewrites the WHOLE snapshot over that one file, so a
    // Slack registry rooted there too would erase this entry the first time it recorded — and
    // vice versa on the next restart, silently re-minting threads on both surfaces.
    const otherSurface = new PersistentThreadRegistry(stateDir);
    await otherSurface.load();
    const discordTarget: DeliveryTarget = { kind: 'thread', threadId: '1234567890' };
    await otherSurface.record('discord-user', 'sess-shared', discordTarget);

    await makeDelivery(ctx, stateDir).handle('U1', statusEnvelope('sess-shared', 'starting'));

    // Reload BOTH from disk: each surface's mappings survived the other's write.
    const reloadedOther = new PersistentThreadRegistry(stateDir);
    await reloadedOther.load();
    expect(reloadedOther.get('discord-user', 'sess-shared')).toEqual(discordTarget);

    const reloadedSlack = new PersistentThreadRegistry(join(stateDir, REGISTRY_DIR));
    await reloadedSlack.load();
    expect(reloadedSlack.get('U1', 'sess-shared')?.kind).toBe('thread');
  });

  it('does not re-post a parent for a second envelope on the same session', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('sess-1', 'starting'));
    await delivery.handle('U1', statusEnvelope('sess-1', 'running'));

    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
  });

  it('resolves an existing persisted thread on a fresh instance instead of posting a new one', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const first = makeDelivery(ctx, stateDir);
    await first.handle('U1', statusEnvelope('sess-1', 'starting'));
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);

    // Simulate a restart: a brand-new instance over the same stateDir and a brand-new ctx (so the
    // second instance's own web-client mock proves nothing was re-posted).
    const { ctx: ctx2, web: web2 } = fakeCtx();
    const second = makeDelivery(ctx2, stateDir);
    await second.handle('U1', statusEnvelope('sess-1', 'running'));
    expect(web2.chat.postMessage).not.toHaveBeenCalled();
  });

  it('still edits the status message for a resumed session, even though no new parent was posted', async () => {
    const { ctx } = fakeCtx();
    const stateDir = await tempDir();
    const first = makeDelivery(ctx, stateDir);
    await first.handle('U1', statusEnvelope('sess-1', 'starting'));

    // A brand-new SlackSessionDelivery (fresh in-memory view) resolves the persisted thread on its
    // very first envelope for this session — the case that must NOT silently swallow the update.
    const { ctx: ctx2, web: web2 } = fakeCtx();
    const second = makeDelivery(ctx2, stateDir);
    await second.handle('U1', statusEnvelope('sess-1', 'done', 'resumed and finished'));

    expect(web2.chat.postMessage).not.toHaveBeenCalled(); // no duplicate parent
    expect(web2.chat.update).toHaveBeenCalledTimes(1); // but the state change still reached Slack
    expect(web2.chat.update.mock.calls[0]![0].text).toContain('resumed and finished');
  });
});

// -----------------------------------------------------------------------------
// Ordering + gap handling (via sessionOutput.ts's OrderedOutput)
// -----------------------------------------------------------------------------

describe('output ordering and gaps', () => {
  it('holds an out-of-order chunk and commits it once the predecessor arrives', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', outputEnvelope('s1', 0, 'stdout', 'first '));
    await delivery.handle('U1', outputEnvelope('s1', 2, 'stdout', 'third ')); // parked: seq 1 missing
    await delivery.handle('U1', outputEnvelope('s1', 1, 'stdout', 'second ')); // fills the hole

    await vi.runOnlyPendingTimersAsync();

    const lastUpdate = web.chat.update.mock.calls.at(-1);
    expect(lastUpdate?.[0].text).toContain('first second third');
  });

  it('declares a visible gap once the reorder grace elapses, never dropping silently', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', outputEnvelope('s1', 0, 'stdout', 'first '));
    await delivery.handle('U1', outputEnvelope('s1', 2, 'stdout', 'third ')); // parked: seq 1 missing

    // Past the default 5s reorder grace — the next chunk's accept() call resolves the gap.
    await vi.advanceTimersByTimeAsync(6_000);
    await delivery.handle('U1', outputEnvelope('s1', 3, 'stdout', 'fourth '));
    await vi.runOnlyPendingTimersAsync();

    const lastUpdate = web.chat.update.mock.calls.at(-1);
    expect(lastUpdate?.[0].text).toContain('gap: output seq 1');
    expect(lastUpdate?.[0].text).toContain('third fourth');
  });
});

// -----------------------------------------------------------------------------
// Coalescing (per channel, >= MIN_CHANNEL_SEND_INTERVAL_MS)
// -----------------------------------------------------------------------------

describe('per-channel coalescing', () => {
  it('sends the first status edit immediately, then coalesces a rapid second one to the next window', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('s1', 'starting')); // creates the thread (postMessage)
    await delivery.handle('U1', statusEnvelope('s1', 'running')); // first edit — no prior flush, sends now
    expect(web.chat.update).toHaveBeenCalledTimes(1);

    await delivery.handle('U1', statusEnvelope('s1', 'waiting_input')); // arrives inside the window
    await delivery.handle('U1', statusEnvelope('s1', 'waiting_permission')); // still inside the window
    expect(web.chat.update).toHaveBeenCalledTimes(1); // both coalesced, not sent yet

    await vi.advanceTimersByTimeAsync(1_000);
    expect(web.chat.update).toHaveBeenCalledTimes(2); // exactly one more edit, showing the LATEST state
    const lastUpdate = web.chat.update.mock.calls.at(-1);
    expect(lastUpdate?.[0].text).toContain('waiting_permission');
  });

  it('shares one throttle across two sessions in the same DM channel', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('s1', 'starting'));
    await delivery.handle('U1', statusEnvelope('s2', 'starting'));
    await delivery.handle('U1', statusEnvelope('s1', 'running')); // first edit for the channel
    await delivery.handle('U1', statusEnvelope('s2', 'running')); // coalesced with s1's pending flush

    expect(web.chat.update).toHaveBeenCalledTimes(1); // only s1's edit went out synchronously
    await vi.advanceTimersByTimeAsync(1_000);
    expect(web.chat.update).toHaveBeenCalledTimes(2); // the coalesced flush covers BOTH sessions
  });

  it('a terminal status skips the coalescing window but still respects the send interval', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('s1', 'starting'));
    await delivery.handle('U1', statusEnvelope('s1', 'running')); // consumes the immediate-send slot
    expect(web.chat.update).toHaveBeenCalledTimes(1);

    // No coalescing wait — the terminal flush starts immediately rather than parking on a timer —
    // but a send that comes back 429 was never delivered, so the channel interval still applies.
    await settle(delivery.handle('U1', statusEnvelope('s1', 'done', 'all finished')));
    expect(web.chat.update).toHaveBeenCalledTimes(2);
    expect(web.chat.update.mock.calls.at(-1)?.[0].text).toContain('all finished');
  });

  it('keeps a channel totally ordered and spaced when two sessions flush together', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);
    await delivery.handle('U1', statusEnvelope('s1', 'starting'));
    await delivery.handle('U1', statusEnvelope('s2', 'starting'));

    const sentAtMs: number[] = [];
    const stamp_ = <T>(value: T): Promise<T> => {
      sentAtMs.push(Date.now());
      return Promise.resolve(value);
    };
    web.chat.update.mockImplementation((args: { channel: string; ts: string }) =>
      stamp_({ ok: true, channel: args.channel, ts: args.ts }),
    );
    web.chat.postMessage.mockImplementation((args: { channel: string }) =>
      stamp_({ ok: true, channel: args.channel, ts: `${Date.now()}.000000` }),
    );

    // Two SESSIONS sharing one DM channel, fired with nothing awaited between them — separate
    // per-session chains, so the second lands while the first is already mid-flush, before
    // lastFlushAtMs has been stamped. That is the window a second concurrent flush used to open.
    await settle(
      Promise.all([
        delivery.handle('U1', outputEnvelope('s1', 0, 'milestone', 'from-s1')),
        delivery.handle('U1', outputEnvelope('s2', 0, 'milestone', 'from-s2')),
      ]),
    );

    // Nothing queued behind a running flush is lost, and nothing is sent twice.
    const followups = web.chat.postMessage.mock.calls
      .filter(([args]) => args.thread_ts !== undefined)
      .map(([args]) => args.text);
    expect(followups).toEqual(['🔹 from-s1', '🔹 from-s2']);
    expect(web.chat.update).toHaveBeenCalledTimes(2);
    // …and the channel's whole outbound series stays inside its per-channel budget, rather than
    // two flushes each spending it.
    for (let i = 1; i < sentAtMs.length; i++) {
      expect(sentAtMs[i]! - sentAtMs[i - 1]!).toBeGreaterThanOrEqual(
        SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS,
      );
    }
  });
});

// -----------------------------------------------------------------------------
// Overflow chunking
// -----------------------------------------------------------------------------

describe('overflow chunking', () => {
  it('splits an oversized milestone line into several spaced follow-up messages via slackChunks', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    const sentAtMs: number[] = [];
    web.chat.postMessage.mockImplementation((args: { channel: string }) => {
      sentAtMs.push(Date.now());
      return Promise.resolve({ ok: true, channel: args.channel, ts: `${Date.now()}.000000` });
    });

    const big = 'x'.repeat(7_000);
    await settle(delivery.handle('U1', outputEnvelope('s1', 0, 'milestone', big)));

    // 1 parent post + >=3 chunked follow-ups (default 3000-char budget over 7000 chars).
    expect(web.chat.postMessage.mock.calls.length).toBeGreaterThanOrEqual(4);
    const followups = web.chat.postMessage.mock.calls.slice(1);
    for (const [args] of followups) {
      expect(args.thread_ts).toBeTruthy();
      expect(args.text.length).toBeLessThanOrEqual(3_050); // budget + the emoji-prefix overhead
    }
    // The chunks are a SERIES into one channel, which is exactly what the per-channel ceiling
    // rejects when it arrives back to back; consecutive follow-ups are a full window apart.
    const followupTimes = sentAtMs.slice(1);
    for (let i = 1; i < followupTimes.length; i++) {
      expect(followupTimes[i]! - followupTimes[i - 1]!).toBeGreaterThanOrEqual(
        SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS,
      );
    }
  });

  it('caps the staging buffer when the thread never opens, and says how much it dropped', async () => {
    const { ctx, web, openDm } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    // No thread can be created, so nothing ever drains — the case where an append-only staging
    // buffer grows without bound for the life of the process.
    openDm.mockRejectedValue(new Error('this user has DMs closed'));
    for (let i = 0; i < 400; i++) {
      await delivery.handle('U1', outputEnvelope('s1', i, 'milestone', `line ${i}`));
    }
    expect(web.chat.postMessage).not.toHaveBeenCalled();

    // Once the thread finally opens, what survived the cap is posted — followed by an explicit
    // marker for what did not, rather than a silently shorter thread.
    openDm.mockResolvedValue('DU1');
    await settle(delivery.handle('U1', statusEnvelope('s1', 'running')));

    const followups = web.chat.postMessage.mock.calls
      .filter(([args]) => args.thread_ts !== undefined)
      .map(([args]) => args.text);
    expect(followups).toHaveLength(201); // the 200 the cap kept, plus the marker
    expect(followups.at(-1)).toMatch(/⟨200 follow-up line\(s\) dropped/);
  }, 30_000);
});

// -----------------------------------------------------------------------------
// register() — reply -> inject round trip
// -----------------------------------------------------------------------------

describe('register — thread replies', () => {
  async function setUp() {
    const { ctx, web, relay } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);
    const { app, trigger } = fakeApp();
    delivery.register(app);
    await delivery.handle('U1', statusEnvelope('sess-1', 'starting'));
    const channel = web.chat.postMessage.mock.calls[0]![0].channel;
    // Cast: vitest types `mock.results[].value` as `any` because the union covers the throw case.
    const parentTs = ((await web.chat.postMessage.mock.results[0]!.value) as { ts: string }).ts;
    return { delivery, trigger, relay, channel, parentTs };
  }

  it('injects a threaded reply as prompt.inject, namespaced through principalOf', async () => {
    const { trigger, relay, channel, parentTs } = await setUp();

    await trigger({
      type: 'message',
      subtype: undefined,
      channel,
      user: 'U1',
      text: 'go ahead',
      ts: '1700000100.000000',
      thread_ts: parentTs,
    });

    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]!.userId).toBe('slack:T1:U1'); // principalOf(), not the raw Slack id
    expect(relay.sent[0]!.draft).toMatchObject({
      type: 'prompt.inject',
      payload: { sessionId: 'sess-1', text: 'go ahead' },
    });
  });

  it('ignores a bot-authored message even if it carries a matching thread_ts', async () => {
    const { trigger, relay, channel, parentTs } = await setUp();
    await trigger({
      type: 'message',
      subtype: 'bot_message',
      channel,
      bot_id: 'B1',
      text: 'reporting in',
      ts: '1700000100.000000',
      thread_ts: parentTs,
    });
    expect(relay.sent).toHaveLength(0);
  });

  it('ignores a threadless DM message', async () => {
    const { trigger, relay, channel } = await setUp();
    await trigger({
      type: 'message',
      subtype: undefined,
      channel,
      user: 'U1',
      text: 'not a reply',
      ts: '1700000100.000000',
    });
    expect(relay.sent).toHaveLength(0);
  });

  it('ignores a reply into a thread it never created', async () => {
    const { trigger, relay, channel } = await setUp();
    await trigger({
      type: 'message',
      subtype: undefined,
      channel,
      user: 'U1',
      text: 'hello?',
      ts: '1700000100.000000',
      thread_ts: '1699999999.000000', // never issued by this delivery instance
    });
    expect(relay.sent).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Per-session serialization (see the module's own header)
// -----------------------------------------------------------------------------

describe('per-session serialization', () => {
  it('creates exactly one thread parent when a session’s first two envelopes race', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    // The relay starts an independent async chain per frame, so a session's first status and
    // first output genuinely can be in flight together. Both would find `posted` false, both
    // would post a parent, and the second registry write would overwrite the first — leaving one
    // live thread and one orphan frozen on its first render.
    await settle(
      Promise.all([
        delivery.handle('U1', statusEnvelope('sess-race', 'starting')),
        delivery.handle('U1', outputEnvelope('sess-race', 0, 'milestone', 'early line')),
      ]),
    );

    const parents = web.chat.postMessage.mock.calls.filter(
      ([args]) => args.thread_ts === undefined,
    );
    expect(parents).toHaveLength(1);

    // …and the one mapping on disk is the one that was actually posted.
    const reg = new PersistentThreadRegistry(join(stateDir, REGISTRY_DIR));
    await reg.load();
    const parentTs = ((await web.chat.postMessage.mock.results[0]!.value) as { ts: string }).ts;
    expect(reg.get('U1', 'sess-race')).toEqual({
      kind: 'thread',
      threadId: `DU1:${parentTs}`,
    });
  });
});

// -----------------------------------------------------------------------------
// Hostile wire content in the status message
// -----------------------------------------------------------------------------

describe('status message safety', () => {
  it('neutralises a session id carrying a code-span break and a mention', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    // sessionId is z.string().min(1) on the wire — unconstrained in every way that matters here.
    // A backtick closes the code span the id is rendered inside, and Slack resolves <!here> and
    // <@U…> out of plain message text with no allowedMentions-style opt-out.
    await delivery.handle('U1', statusEnvelope('sess` <!here> <@U0000> <!channel>', 'running'));

    const posted = web.chat.postMessage.mock.calls[0]![0].text;
    expect(posted).not.toContain('<!');
    expect(posted).not.toContain('<@');
    expect(posted).toContain('&lt;!here&gt;');
    // The code span the id sits in is still exactly one span — the id's own backtick is gone.
    expect((posted.match(/`/g) ?? []).length).toBe(2);
  });

  it('clamps an unbounded summary to Slack’s message limit', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    // An oversized `text` is rejected outright, and that rejection lands inside ensureThread —
    // whose catch would leave the session with no thread at all, i.e. permanently silent. The
    // fixture is all `&` because escaping expands each one fivefold.
    await delivery.handle('U1', statusEnvelope('s1', 'running', '&'.repeat(100_000)));

    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
    const posted = web.chat.postMessage.mock.calls[0]![0].text;
    expect(posted.length).toBeLessThanOrEqual(SLACK_LIMITS.MESSAGE_TEXT_MAX);
    expect(posted).toContain('Session `s1`');
  });
});

// -----------------------------------------------------------------------------
// Bounded in-memory state
// -----------------------------------------------------------------------------

describe('bounded state', () => {
  it('keeps the retained transcript near the tail it can actually render', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);
    await delivery.handle('U1', statusEnvelope('s1', 'starting'));

    // Only the last 1000 chars are ever rendered; stdout is unbounded on the wire, so an
    // append-only transcript is the session's entire output held in memory forever.
    for (let i = 0; i < 50; i++) {
      await delivery.handle('U1', outputEnvelope('s1', i, 'stdout', 'y'.repeat(5_000)));
    }
    await settle(delivery.handle('U1', statusEnvelope('s1', 'done')));

    const rendered = web.chat.update.mock.calls.at(-1)![0].text;
    // The rendered tail is intact (nothing user-visible was traded away)…
    expect(rendered).toContain('y'.repeat(1_000));
    // …while the message stays a status line rather than a 250KB transcript.
    expect(rendered.length).toBeLessThan(4_000);
  });

  it('drops a terminal session’s state after the grace, and reuses its thread if it speaks again', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await settle(delivery.handle('U1', statusEnvelope('s1', 'done', 'finished')));
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
    const parentTs = ((await web.chat.postMessage.mock.results[0]!.value) as { ts: string }).ts;

    await vi.advanceTimersByTimeAsync(10 * 60_000); // past the forget grace

    // A straggler after the drop must not mint a SECOND thread: the persisted mapping outlives
    // the in-memory view, so the rebuilt view resolves the same one.
    await settle(delivery.handle('U1', outputEnvelope('s1', 0, 'milestone', 'late straggler')));

    const parents = web.chat.postMessage.mock.calls.filter(
      ([args]) => args.thread_ts === undefined,
    );
    expect(parents).toHaveLength(1);
    expect(web.chat.postMessage.mock.calls.at(-1)![0].thread_ts).toBe(parentTs);
  });
});

// -----------------------------------------------------------------------------
// stop()
// -----------------------------------------------------------------------------

describe('stop', () => {
  it('flushes a coalesced edit that was still sitting on a timer', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('s1', 'starting'));
    await delivery.handle('U1', statusEnvelope('s1', 'running')); // consumes the immediate slot
    await delivery.handle('U1', statusEnvelope('s1', 'waiting_input')); // parked on the timer
    expect(web.chat.update).toHaveBeenCalledTimes(1);

    // Without a shutdown path the parked edit — typically the last thing the session had to say —
    // dies with the process.
    await settle(delivery.stop());
    expect(web.chat.update).toHaveBeenCalledTimes(2);
    expect(web.chat.update.mock.calls.at(-1)![0].text).toContain('waiting_input');
  });

  it('arms no further timers once stopped', async () => {
    const { ctx, web } = fakeCtx();
    const stateDir = await tempDir();
    const delivery = makeDelivery(ctx, stateDir);

    await delivery.handle('U1', statusEnvelope('s1', 'starting'));
    await settle(delivery.stop());
    const sendsAtShutdown = web.chat.update.mock.calls.length;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(web.chat.update.mock.calls.length).toBe(sendsAtShutdown);
  });
});
