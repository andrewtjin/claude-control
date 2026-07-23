// discordJsGateway is otherwise a live boundary (see its file header): start()/deliver() make real
// Discord API calls, so it is not unit-tested. This ONE test is the deliberate exception — it
// proves the per-session-route SERIALIZATION of deliver(), which is gateway-local
// state (the promise chain + the cardMessages map) that no pure module can hold. It exercises that
// serialization through the single `protected sinkFor` seam by returning a controllable fake sink,
// so nothing here touches a real Discord connection.

import { describe, it, expect } from 'vitest';
import type { EmbedBuilder, Message, SendableChannels } from 'discord.js';
import type { Envelope, EnvelopeDraft } from '@claude-control/shared-protocol';
import { DiscordJsGateway, type SessionThreadParent } from './discordJsGateway.js';
import type { SessionRoute } from './sessionPlanner.js';
import type { CardRef } from './permissionCards.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';

/** A fake message whose `edit` is observable — a real card edit must land HERE, not become a
 *  second send. */
class FakeMessage {
  editCount = 0;
  edit(_payload: unknown): Promise<void> {
    this.editCount += 1;
    return Promise.resolve();
  }
}

/** A fake sendable channel: records every send and (optionally) gates the FIRST send on a promise
 *  the test releases, so the interleaving that used to double-post a card can be forced
 *  deterministically. Every send returns the SAME message, mirroring one live card per route. */
class FakeSink {
  readonly sends: unknown[] = [];
  readonly message = new FakeMessage();
  private release: (() => void) | undefined;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  gateFirstSend = false;

  releaseGate(): void {
    this.release?.();
  }

  async send(payload: unknown): Promise<FakeMessage> {
    this.sends.push(payload);
    if (this.gateFirstSend && this.sends.length === 1) await this.gate;
    return this.message;
  }
}

/** DiscordJsGateway with its testable seams redirected: sinkFor returns a fake sink, and the
 *  protected stop nudge is exposed so the serialization tests can fire it directly (its
 *  production caller needs a full fake Discord interaction, beside the point here). */
class TestGateway extends DiscordJsGateway {
  testSink: FakeSink | undefined;
  protected override sinkFor(_route: SessionRoute): Promise<SendableChannels | undefined> {
    return Promise.resolve(this.testSink as unknown as SendableChannels);
  }
  driveNudgeStop(route: SessionRoute): Promise<void> {
    return this.nudgeStop(route);
  }
}

const stubRelay = {
  sendToUser: () => ({ ok: true }),
  isOnline: () => true,
} as unknown as RelaySender;
const stubPairing = {} as unknown as PairingService;

function envelope(type: Envelope['type'], payload: unknown): Envelope {
  return { v: 1, id: 'id-1', ts: 0, daemonId: 'd1', type, payload } as Envelope;
}

/** Flush the microtask/macrotask queue so chained deliveries can advance to their next await. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('DiscordJsGateway — per-session delivery is serialized', () => {
  it('two concurrently-delivered frames for one session produce ONE card send, then an edit', async () => {
    const gw = new TestGateway({ relay: stubRelay, pairing: stubPairing });
    const sink = new FakeSink();
    sink.gateFirstSend = true; // hold the card send in flight to force the interleaving
    gw.testSink = sink;

    // Fire both frames for the SAME session without awaiting the first (exactly how relay.ts calls
    // deliver from its un-awaited socket handler): status 'running' creates the card, 'done' edits.
    const pA = gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    const pB = gw.deliver(
      'u1',
      envelope('session.status', { sessionId: 's1', state: 'done', summary: 'ok' }),
    );

    // With the card send parked, the SECOND frame must not have run yet — its edit is chained behind
    // the first delivery, not racing it. Before the fix it would already have re-anchored a DUPLICATE
    // card here (sends.length ≥ 2).
    await tick();
    expect(sink.sends.length).toBe(1);

    sink.releaseGate();
    await Promise.all([pA, pB]);

    // The terminal edit found the remembered card and edited it in place; the only other send is the
    // standalone summary line — never a duplicate card.
    expect(sink.message.editCount).toBe(1);
    expect(sink.sends.length).toBe(2); // [card send, summary line send]
  });

  it('a stop nudge during an in-flight card send edits THAT card — never posts a second', async () => {
    const gw = new TestGateway({ relay: stubRelay, pairing: stubPairing });
    const sink = new FakeSink();
    sink.gateFirstSend = true; // park the card send in flight
    gw.testSink = sink;
    const route: SessionRoute = { discordUserId: 'u1', sessionId: 's1' };

    const pA = gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    // The planner marked the card posted at PLAN time, but the send itself is still parked, so
    // the card id is not yet remembered — exactly the window where an unchained nudge used to
    // hit the empty-map re-anchor branch and post a DUPLICATE card (the frozen-card shape: the
    // later send wins the map and the first card never receives another edit).
    const pB = gw.driveNudgeStop(route);

    await tick();
    expect(sink.sends.length).toBe(1); // the nudge is chained behind the delivery, not racing it

    sink.releaseGate();
    await Promise.all([pA, pB]);

    expect(sink.sends.length).toBe(1); // still exactly one card
    expect(sink.message.editCount).toBe(1); // "stopping…" landed as an edit on that card
  });
});

/** A fake permission-card message: exposes just enough of discord.js's `Message` shape for
 *  `applyPermissionLapse` to read (`embeds[0].toJSON()`) and mutate (`edit`). */
class FakePermissionMessage {
  editCount = 0;
  lastEditPayload: { embeds?: EmbedBuilder[]; components?: unknown[] } | undefined;
  readonly embeds: { toJSON(): Record<string, unknown> }[];

  constructor(embedData: Record<string, unknown> | undefined) {
    this.embeds = embedData !== undefined ? [{ toJSON: () => embedData }] : [];
  }

  edit(payload: { embeds?: EmbedBuilder[]; components?: unknown[] }): Promise<void> {
    this.editCount += 1;
    this.lastEditPayload = payload;
    return Promise.resolve();
  }
}

/** DiscordJsGateway with the permission-card seams exposed for testing: `seedPermissionCard`
 *  stands in for an earlier permission.request send having populated the bounded requestId->ref
 *  map, and `resolveCardMessage` is redirected to a fake message instead of a real channel/message
 *  fetch — mirroring how `TestGateway` above redirects `sinkFor` for the session-card surface. */
class PermissionTestGateway extends DiscordJsGateway {
  resolveCalls: CardRef[] = [];
  fakeMessage: FakePermissionMessage | undefined;

  seedPermissionCard(requestId: string, ref: CardRef): void {
    this.permissionCards.record(requestId, ref);
  }

  cardCount(): number {
    return this.permissionCards.size();
  }

  protected override resolveCardMessage(ref: CardRef): Promise<Message | undefined> {
    this.resolveCalls.push(ref);
    return Promise.resolve(this.fakeMessage as unknown as Message | undefined);
  }
}

describe('DiscordJsGateway — permission.lapsed', () => {
  it('edits the tracked card in place: buttons stripped, reason annotation present, original content kept', async () => {
    const gw = new PermissionTestGateway({ relay: stubRelay, pairing: stubPairing });
    gw.seedPermissionCard('req-1', { channelId: 'c1', messageId: 'm1' });
    gw.fakeMessage = new FakePermissionMessage({
      title: 'Permission requested',
      description: 'run rm -rf',
      color: 0xf1c40f,
    });

    await gw.deliver('u1', envelope('permission.lapsed', { requestId: 'req-1', reason: 'local' }));

    expect(gw.resolveCalls).toEqual([{ channelId: 'c1', messageId: 'm1' }]);
    expect(gw.fakeMessage.editCount).toBe(1);
    const payload = gw.fakeMessage.lastEditPayload;
    expect(payload?.components).toEqual([]); // every button component removed
    const editedEmbed = payload?.embeds?.[0]?.toJSON();
    expect(editedEmbed?.title).toBe('Handled at the terminal'); // reason: 'local' annotation
    expect(editedEmbed?.description).toBe('run rm -rf'); // original card content preserved
    // One-shot: the requestId is forgotten once its lapse card has been edited.
    expect(gw.cardCount()).toBe(0);
  });

  it('a different reason picks a different annotation', async () => {
    const gw = new PermissionTestGateway({ relay: stubRelay, pairing: stubPairing });
    gw.seedPermissionCard('req-2', { channelId: 'c1', messageId: 'm2' });
    gw.fakeMessage = new FakePermissionMessage({ title: 'Permission requested' });

    await gw.deliver(
      'u1',
      envelope('permission.lapsed', { requestId: 'req-2', reason: 'shutdown' }),
    );

    const editedEmbed = gw.fakeMessage.lastEditPayload?.embeds?.[0]?.toJSON();
    expect(editedEmbed?.title).toBe('Daemon stopped');
  });

  it('an unknown requestId is dropped silently: no crash, no card resolved/sent', async () => {
    const gw = new PermissionTestGateway({ relay: stubRelay, pairing: stubPairing });

    await expect(
      gw.deliver(
        'u1',
        envelope('permission.lapsed', { requestId: 'never-tracked', reason: 'expired' }),
      ),
    ).resolves.toBeUndefined();

    // Never even attempted to resolve a message — the only path to a Discord API call for this
    // envelope type — proving the drop is silent all the way through, not just error-swallowed.
    expect(gw.resolveCalls).toEqual([]);
  });
});

/** DiscordJsGateway with the question-card seams exposed, mirroring PermissionTestGateway: seed the
 *  bounded requestId→ref map that a real question.request send would have populated, and redirect
 *  the card-message resolution to a fake message — so the lapse-edit path is exercised without a
 *  real Discord connection (the send path itself is live-boundary, proven the same way permission
 *  registration is: by seeding). */
class QuestionTestGateway extends DiscordJsGateway {
  resolveCalls: CardRef[] = [];
  fakeMessage: FakePermissionMessage | undefined;

  seedQuestionCard(requestId: string, ref: CardRef): void {
    this.questionCards.record(requestId, ref);
  }

  cardCount(): number {
    return this.questionCards.size();
  }

  protected override resolveCardMessage(ref: CardRef): Promise<Message | undefined> {
    this.resolveCalls.push(ref);
    return Promise.resolve(this.fakeMessage as unknown as Message | undefined);
  }
}

describe('DiscordJsGateway — question.lapsed', () => {
  it('edits the tracked card in place: selects stripped, reason title present, content kept', async () => {
    const gw = new QuestionTestGateway({ relay: stubRelay, pairing: stubPairing });
    gw.seedQuestionCard('req-1', { channelId: 'c1', messageId: 'm1' });
    gw.fakeMessage = new FakePermissionMessage({
      title: 'Claude has a question',
      fields: [{ name: 'Color', value: 'Which color?' }],
      color: 0xf1c40f,
    });

    await gw.deliver('u1', envelope('question.lapsed', { requestId: 'req-1', reason: 'expired' }));

    expect(gw.resolveCalls).toEqual([{ channelId: 'c1', messageId: 'm1' }]);
    expect(gw.fakeMessage.editCount).toBe(1);
    const payload = gw.fakeMessage.lastEditPayload;
    expect(payload?.components).toEqual([]); // every select removed
    const editedEmbed = payload?.embeds?.[0]?.toJSON();
    expect(editedEmbed?.title).toBe('Expired — continuing without answers');
    // Original question content preserved.
    expect((editedEmbed?.fields as { value: string }[] | undefined)?.[0]?.value).toBe(
      'Which color?',
    );
    // One-shot: the requestId is forgotten once its lapse card has been edited.
    expect(gw.cardCount()).toBe(0);
  });

  it('a different reason picks a different title', async () => {
    const gw = new QuestionTestGateway({ relay: stubRelay, pairing: stubPairing });
    gw.seedQuestionCard('req-2', { channelId: 'c1', messageId: 'm2' });
    gw.fakeMessage = new FakePermissionMessage({ title: 'Claude has a question' });

    await gw.deliver('u1', envelope('question.lapsed', { requestId: 'req-2', reason: 'local' }));

    expect(gw.fakeMessage.lastEditPayload?.embeds?.[0]?.toJSON().title).toBe(
      'Answered at the terminal',
    );
  });

  it('an unknown requestId is dropped silently: no crash, no card resolved', async () => {
    const gw = new QuestionTestGateway({ relay: stubRelay, pairing: stubPairing });

    await expect(
      gw.deliver('u1', envelope('question.lapsed', { requestId: 'never', reason: 'shutdown' })),
    ).resolves.toBeUndefined();

    expect(gw.resolveCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Thread messages -> session input (the reverse direction)
// ---------------------------------------------------------------------------

/** A relay fake that records every draft and lets a test flip the daemon offline. */
function inboundFakeRelay() {
  const sent: EnvelopeDraft[] = [];
  const state = { online: true };
  const relay: RelaySender = {
    sendToUser(_userId, build) {
      if (!state.online) return { ok: false, error: 'daemon is offline' };
      const draft = build('daemon-1');
      sent.push(draft);
      return { ok: true, id: `env-${sent.length}` };
    },
    isOnline: () => state.online,
  };
  return { relay, sent, state };
}

/** Gateway with the inbound seams recording instead of calling Discord. */
class InboundTestGateway extends DiscordJsGateway {
  testSink = new FakeSink();
  readonly reactions: Array<{ threadId: string; messageId: string; emoji: string }> = [];
  readonly threadSends: Array<{ threadId: string; content: string }> = [];
  protected override sinkFor(_route: SessionRoute): Promise<SendableChannels | undefined> {
    return Promise.resolve(this.testSink as unknown as SendableChannels);
  }
  protected override reactInThread(
    threadId: string,
    messageId: string,
    emoji: string,
  ): Promise<void> {
    this.reactions.push({ threadId, messageId, emoji });
    return Promise.resolve();
  }
  protected override sendInThread(threadId: string, content: string): Promise<void> {
    this.threadSends.push({ threadId, content });
    return Promise.resolve();
  }
  driveThreadMessage(message: {
    author: { id: string; bot: boolean };
    channelId: string;
    channel: { isThread(): boolean };
    content: string;
    id: string;
  }): Promise<void> {
    return this.onThreadMessage(message);
  }
}

/** A thread parent whose create() mints predictable thread ids. */
function fakeThreadParent(): SessionThreadParent {
  let n = 0;
  return {
    threads: {
      create: () =>
        Promise.resolve({
          id: `t${++n}`,
          members: { add: () => Promise.resolve(undefined as unknown) },
        }),
    },
  };
}

function inboundSetup() {
  const { relay, sent, state } = inboundFakeRelay();
  const parent = fakeThreadParent();
  const gw = new InboundTestGateway({
    relay,
    pairing: stubPairing,
    sessionChannelResolver: () => Promise.resolve(parent),
  });
  return { gw, sent, state };
}

const THREAD_MSG = {
  author: { id: 'u1', bot: false },
  channelId: 't1',
  channel: { isThread: () => true },
  content: 'keep going',
  id: 'm1',
};

describe('DiscordJsGateway — thread messages become session input', () => {
  it("forwards the bound user's text to the owning session as prompt.inject", async () => {
    const { gw, sent } = inboundSetup();
    // First frame binds (u1, s1) -> thread t1 via the resolver.
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    await gw.driveThreadMessage(THREAD_MSG);
    const inject = sent.find((d) => d.type === 'prompt.inject');
    expect(inject?.payload).toEqual({
      sessionId: 's1',
      text: 'keep going',
      idempotencyKey: 'thread:m1',
    });
    expect(gw.reactions).toContainEqual({ threadId: 't1', messageId: 'm1', emoji: '📨' });
  });

  it('ignores bots, non-threads, unbound threads, and any author but the bound user', async () => {
    const { gw, sent } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    const before = sent.length;
    await gw.driveThreadMessage({ ...THREAD_MSG, author: { id: 'u1', bot: true } });
    await gw.driveThreadMessage({ ...THREAD_MSG, channel: { isThread: () => false } });
    await gw.driveThreadMessage({ ...THREAD_MSG, channelId: 't-not-ours' });
    await gw.driveThreadMessage({ ...THREAD_MSG, author: { id: 'intruder', bot: false } });
    expect(sent.length).toBe(before);
    expect(gw.reactions).toHaveLength(0); // ignored silently — no confirmation leaks
  });

  it('shrugs visibly at a message with no forwardable text', async () => {
    const { gw, sent } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    const before = sent.length;
    await gw.driveThreadMessage({ ...THREAD_MSG, content: '   ' });
    expect(sent.length).toBe(before);
    expect(gw.reactions).toContainEqual({ threadId: 't1', messageId: 'm1', emoji: '⚠️' });
  });

  it('surfaces an offline daemon in the thread instead of dropping the message', async () => {
    const { gw, state } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    state.online = false;
    await gw.driveThreadMessage(THREAD_MSG);
    expect(gw.reactions).toContainEqual({ threadId: 't1', messageId: 'm1', emoji: '⚠️' });
    expect(gw.threadSends.some((t) => t.threadId === 't1' && t.content.includes('offline'))).toBe(
      true,
    );
  });

  it('resumes an ENDED session via session.spawn and rebinds the new sessionId to the SAME thread', async () => {
    const { gw, sent } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'done' }));
    await gw.driveThreadMessage({ ...THREAD_MSG, content: 'and another thing', id: 'm2' });

    const spawn = sent.find((d) => d.type === 'session.spawn');
    expect(spawn?.payload).toMatchObject({
      prompt: 'and another thing',
      resumeSessionId: 's1',
      idempotencyKey: 'thread:m2',
    });
    expect(gw.reactions).toContainEqual({ threadId: 't1', messageId: 'm2', emoji: '🔄' });

    // The daemon spawns a NEW sessionId and echoes the requestId; the first status frame must
    // bind s2 to the same thread and announce the seam there.
    const requestId = (spawn?.payload as { requestId: string }).requestId;
    await gw.deliver(
      'u1',
      envelope('session.status', { sessionId: 's2', state: 'running', spawnRequestId: requestId }),
    );
    expect(gw.threadSends.some((t) => t.threadId === 't1' && t.content.includes('s2'))).toBe(true);

    // And the thread now steers the NEW session.
    await gw.driveThreadMessage({ ...THREAD_MSG, content: 'louder', id: 'm3' });
    const inject = sent.find((d) => d.type === 'prompt.inject');
    expect(inject?.payload).toMatchObject({ sessionId: 's2', text: 'louder' });
  });

  it('escalates a session_ended inject refusal to a resume spawn with the SAME text', async () => {
    const { gw, sent } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    await gw.driveThreadMessage(THREAD_MSG); // inject sent as env-1
    await gw.deliver(
      'u1',
      envelope('error', {
        code: 'session_ended',
        message: "prompt.inject: session 's1' already ended",
        relatesTo: 'env-1',
      }),
    );
    const spawn = sent.find((d) => d.type === 'session.spawn');
    expect(spawn?.payload).toMatchObject({ prompt: 'keep going', resumeSessionId: 's1' });
  });

  it('lands any other correlated refusal in the thread, not the DMs', async () => {
    const { gw, sent } = inboundSetup();
    await gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    await gw.driveThreadMessage(THREAD_MSG); // inject sent as env-1
    await gw.deliver(
      'u1',
      envelope('error', {
        code: 'inject_failed',
        message: "prompt.inject: session 's1' did not accept the message (busy)",
        relatesTo: 'env-1',
      }),
    );
    expect(sent.some((d) => d.type === 'session.spawn')).toBe(false);
    expect(gw.reactions).toContainEqual({ threadId: 't1', messageId: 'm1', emoji: '❗' });
    expect(
      gw.threadSends.some((t) => t.threadId === 't1' && t.content.includes('did not accept')),
    ).toBe(true);
  });
});
