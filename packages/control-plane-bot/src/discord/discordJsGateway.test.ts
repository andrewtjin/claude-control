// discordJsGateway is otherwise a live boundary (see its file header): start()/deliver() make real
// Discord API calls, so it is not unit-tested. Three deliberate exceptions live here. The first
// proves the per-session-route SERIALIZATION of deliver(), which is gateway-local state (the
// promise chain + the cardMessages map) that no pure module can hold; it exercises that
// serialization through the single `protected sinkFor` seam by returning a controllable fake sink.
// The second is pure data — it holds the pairing primer and the registered command list to each
// other. The third reads back the session-channel resolver the CONSTRUCTOR wired, so the option
// plumbing is covered without re-deriving the precedence rules already proven in
// sessionChannels.test.ts. None touches a real Discord connection.

import { describe, it, expect, afterEach } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  InteractionContextType,
  PermissionFlagsBits,
  PermissionsBitField,
  type ChatInputCommandInteraction,
  type EmbedBuilder,
  type Message,
  type SendableChannels,
} from 'discord.js';
import type { Envelope } from '@claude-control/shared-protocol';
import {
  DiscordJsGateway,
  PAIRING_PRIMER_MESSAGE,
  PRIMER_OMITTED_COMMANDS,
  commandDefinitions,
  missingThreadPermissionLabels,
} from './discordJsGateway.js';
import type {
  CommandResult,
  ThreadHereAction,
  ThreadHereChannelFacts,
  ThreadHereChannelHealth,
} from './commands.js';
import type { DeliveryTarget } from './threadRegistry.js';
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

/** The post-pairing primer is the first thing a new user reads, and it is a hand-written list of
 *  a surface declared somewhere else — the shape that goes stale without anyone noticing, because
 *  nothing fails when it does. These tests are what fails: they tie the primer to the registered
 *  commands in both directions, so neither adding nor removing a command can leave it wrong. Pure
 *  data on both sides — no Discord connection is involved. */
describe('pairing primer', () => {
  /** Command names the primer mentions. Matches the `/name` opening a backticked command
   *  reference then drops the two leading punctuation chars, so option placeholders (`<prompt>`)
   *  and surrounding prose are ignored. The hyphen is part of a NAME, not a separator: the primer
   *  separates a command from its gloss with an em dash, so without it a hyphenated command reads
   *  as a phantom shorter command that is registered nowhere. */
  const mentioned = new Set(
    (PAIRING_PRIMER_MESSAGE.match(/`\/[a-z-]+/g) ?? []).map((token) => token.slice(2)),
  );
  const registered = new Set(commandDefinitions().map((c) => c.name));

  it('mentions no command that is not registered', () => {
    expect([...mentioned].filter((name) => !registered.has(name))).toEqual([]);
  });

  it('mentions every registered command except the documented omissions', () => {
    const unmentioned = [...registered].filter(
      (name) => !mentioned.has(name) && !PRIMER_OMITTED_COMMANDS.has(name),
    );
    expect(unmentioned).toEqual([]);
  });

  it('omits only commands that still exist', () => {
    // The reverse drift: deleting a command must retire its omission entry too, or the set
    // quietly excuses a name nothing would have mentioned anyway.
    expect([...PRIMER_OMITTED_COMMANDS].filter((name) => !registered.has(name))).toEqual([]);
  });

  it('reads a hyphenated command name as one name', () => {
    // The extraction regex is the only thing standing between "the primer is checked" and "the
    // primer is checked for every command whose name happens to be one word".
    expect(mentioned.has('thread-here')).toBe(true);
    expect(mentioned.has('thread')).toBe(false);
  });

  it('fits in one Discord message', () => {
    // Discord rejects a body over 2000 characters and sendPrimer posts this in a single send, so
    // an over-long primer fails as a DM the user never sees rather than truncating.
    expect(PAIRING_PRIMER_MESSAGE.length).toBeLessThanOrEqual(2000);
  });
});

// Constructor wiring for session-channel routing. The precedence rules themselves live in
// sessionChannels.test.ts; what is unproven there is that each option actually REACHES the
// factory — a spread into the wrong key would leave the operator on DMs with nothing logged.
describe('DiscordJsGateway session channel wiring', () => {
  const USER = '111111111111111111';
  const OTHER = '222222222222222222';

  /** Exposes the constructor-wired resolver (see its `protected` note in the gateway). */
  class ResolverProbe extends DiscordJsGateway {
    resolver(): ((id: string) => Promise<unknown>) | undefined {
      return this.sessionChannelResolver;
    }
  }
  const build = (extra: Partial<ConstructorParameters<typeof DiscordJsGateway>[0]>) =>
    new ResolverProbe({
      relay: stubRelay,
      pairing: stubPairing,
      token: 'not-used-without-start',
      ...extra,
    });

  it('builds a resolver from the shared channel id alone', () => {
    expect(build({ sessionChannelId: '333333333333333333' }).resolver()).toBeDefined();
  });

  it('builds a resolver from a per-user map alone', () => {
    const byUser = new Map([[USER, '333333333333333333']]);
    expect(build({ sessionChannelsByUser: byUser }).resolver()).toBeDefined();
  });

  // The mixed deployment, end to end through the real constructor: a mapped user resolves to a
  // channel (the fetch fails against no client, which is fine — reaching the fetch at all is the
  // proof), while an unmapped user short-circuits to undefined and lands on the DM fallback.
  it('routes only mapped users toward a channel when no shared fallback is set', async () => {
    const resolve = build({
      sessionChannelsByUser: new Map([[USER, '333333333333333333']]),
    }).resolver();
    expect(await resolve?.(OTHER)).toBeUndefined();
    await expect(Promise.resolve(resolve?.(USER))).rejects.toThrow();
  });

  it('lets an explicit resolver override both the map and the shared channel id', async () => {
    const sentinel = {
      threads: {
        create: () =>
          Promise.resolve({ id: 't', members: { add: () => Promise.resolve(undefined) } }),
      },
    };
    const resolve = build({
      sessionChannelResolver: () => Promise.resolve(sentinel),
      sessionChannelsByUser: new Map([[USER, '333333333333333333']]),
      sessionChannelId: '444444444444444444',
    }).resolver();
    expect(await resolve?.(USER)).toBe(sentinel);
    expect(await resolve?.(OTHER)).toBe(sentinel);
  });
});

// `/thread-here` through the real command path. The decision tree and every reply string are proven
// in commands.test.ts and the precedence in sessionChannels.test.ts; what only the gateway can hold
// is the ORDER — that nothing is written until both preflight stages pass — and the wiring that
// makes a pin reach the resolver without a restart. The three live adapters (read the invoking
// channel, probe it, inspect a pinned channel) are redirected through their `protected` seams, the
// same way `sinkFor` is above; they are the untested boundary, and deliberately thin.
describe('DiscordJsGateway — /thread-here', () => {
  const USER = '111111111111111111';
  const OTHER = '222222222222222222';
  const CHANNEL = '333333333333333333';
  const OTHER_CHANNEL = '444444444444444444';

  const dirs: string[] = [];
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'thread-here-'));
    dirs.push(dir);
    return dir;
  }
  afterEach(async () => {
    while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true });
  });

  /** A channel every preflight accepts; each test spoils only what it is about. */
  const USABLE: ThreadHereChannelFacts = {
    inGuild: true,
    botInGuild: true,
    channelResolved: true,
    isThread: false,
    isGuildText: true,
    missingPermissions: [],
  };

  /** The only two things `onThreadHere` itself reads off the interaction: who ran it, and where. */
  function fakeInteraction(discordUserId: string, channelId: string): ChatInputCommandInteraction {
    return {
      user: { id: discordUserId },
      channelId,
    } as unknown as ChatInputCommandInteraction;
  }

  /** The gateway with its three `/thread-here` live seams replaced by controllable stand-ins, plus
   *  readers for what was actually persisted and where the resolver now points. */
  class ThreadHereGateway extends DiscordJsGateway {
    facts: ThreadHereChannelFacts = USABLE;
    probeResult: { ok: true } | { ok: false; detail: string } = { ok: true };
    probeCalls = 0;
    health: ThreadHereChannelHealth = { kind: 'ok' };
    /** What the health seam was asked about — the wiring, not the rendering. */
    readonly healthCalls: Array<{ channelId: string; discordUserId: string }> = [];
    /** Fires as the (slow, live) probe runs, so a test can observe what happened BEFORE it. */
    onProbe: (() => void) | undefined;

    protected override gatherThreadHereFacts(
      _interaction: ChatInputCommandInteraction,
    ): Promise<ThreadHereChannelFacts> {
      return Promise.resolve(this.facts);
    }

    protected override probeThreadHere(
      _interaction: ChatInputCommandInteraction,
    ): Promise<{ ok: true } | { ok: false; detail: string }> {
      this.probeCalls += 1;
      this.onProbe?.();
      return Promise.resolve(this.probeResult);
    }

    protected override inspectChannelHealth(
      channelId: string,
      discordUserId: string,
    ): Promise<ThreadHereChannelHealth> {
      this.healthCalls.push({ channelId, discordUserId });
      return Promise.resolve(this.health);
    }

    /** The real dispatch path, including the acknowledgement discipline `run` skips. */
    slash(interaction: ChatInputCommandInteraction): Promise<void> {
      return this.onSlashCommand(interaction);
    }

    run(
      discordUserId: string,
      action: ThreadHereAction,
      channelId = CHANNEL,
    ): Promise<CommandResult> {
      return this.onThreadHere(fakeInteraction(discordUserId, channelId), discordUserId, action);
    }

    loadPins(): Promise<void> {
      return this.sessionChannelPins.load();
    }

    pinOf(discordUserId: string): unknown {
      return this.sessionChannelPins.get(discordUserId);
    }

    resolveFor(discordUserId: string): Promise<unknown> | undefined {
      return this.sessionChannelResolver?.(discordUserId);
    }
  }

  async function gateway(
    extra: Partial<ConstructorParameters<typeof DiscordJsGateway>[0]> = {},
  ): Promise<ThreadHereGateway> {
    return new ThreadHereGateway({
      relay: stubRelay,
      pairing: stubPairing,
      token: 'not-used-without-start',
      stateDir: await tempDir(),
      ...extra,
    });
  }

  function textOf(result: CommandResult): string {
    if (result.kind === 'text') return result.text;
    if (result.kind === 'error') return result.message;
    throw new Error('expected a text or error reply');
  }

  it('registers /thread-here for both guild and DM contexts', () => {
    const definition = commandDefinitions().find((c) => c.name === 'thread-here');
    expect(definition).toBeDefined();
    // clear and show must work from a DM; pin needs to REJECT there with guidance rather than be
    // invisible, which it cannot do if the command is not offered in that context.
    expect(definition?.contexts).toContain(InteractionContextType.BotDM);
    expect(definition?.contexts).toContain(InteractionContextType.Guild);
  });

  it('pins the invoking channel for the invoking user only', async () => {
    const gw = await gateway();
    const result = await gw.run(USER, 'pin');

    expect(textOf(result)).toContain(`<#${CHANNEL}>`);
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
    // The command carries no user option and keys solely off the invoking id, so another user's
    // routing is untouched — structurally, not by a check.
    expect(gw.pinOf(OTHER)).toBeUndefined();
  });

  it('persists nothing when the permission preflight fails', async () => {
    const gw = await gateway();
    gw.facts = { ...USABLE, missingPermissions: ['Manage Threads'] };

    const result = await gw.run(USER, 'pin');
    expect(result.kind).toBe('error');
    expect(textOf(result)).toContain('Manage Threads');
    expect(textOf(result)).toContain('Nothing was changed.');
    expect(gw.pinOf(USER)).toBeUndefined();
    // Not even attempted: a channel whose bits are already wrong should not cost a live call.
    expect(gw.probeCalls).toBe(0);
  });

  // The half a permission check cannot see — a thread ceiling, a rate limit, an overwrite subtlety,
  // or a user-installed app whose reported permissions are a fixed baseline.
  it('persists nothing when the live thread probe fails', async () => {
    const gw = await gateway();
    gw.probeResult = { ok: false, detail: 'Missing Permissions' };

    const result = await gw.run(USER, 'pin');
    expect(result.kind).toBe('error');
    expect(textOf(result)).toContain('Missing Permissions');
    expect(textOf(result)).toContain('Nothing was changed.');
    expect(gw.pinOf(USER)).toBeUndefined();
  });

  it('pins only after a thread was actually created and the user admitted', async () => {
    const gw = await gateway();
    await gw.run(USER, 'pin');
    expect(gw.probeCalls).toBe(1);
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  // Permissions get revoked after the fact, so "already pinned" is only worth saying once the
  // channel has been rechecked — and a revoked permission must turn a no-op re-pin into a refusal.
  it('rechecks a re-pin of the same channel instead of short-circuiting on the stored value', async () => {
    const gw = await gateway();
    await gw.run(USER, 'pin');

    const again = await gw.run(USER, 'pin');
    expect(textOf(again)).toContain('rechecked');
    expect(gw.probeCalls).toBe(2);

    gw.probeResult = { ok: false, detail: 'Missing Permissions' };
    const broken = await gw.run(USER, 'pin');
    expect(broken.kind).toBe('error');
    // The earlier pin stands: a failed recheck refuses, it does not un-pin.
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  it('names the previous channel when a pin moves', async () => {
    const gw = await gateway();
    await gw.run(USER, 'pin', OTHER_CHANNEL);
    const moved = await gw.run(USER, 'pin', CHANNEL);
    expect(textOf(moved)).toContain(`<#${CHANNEL}> instead of <#${OTHER_CHANNEL}>`);
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  it('clears to DMs from a DM without any channel check', async () => {
    const gw = await gateway({ sessionChannelId: OTHER_CHANNEL });
    // Everything a pin would need is missing — which is the point: the way out must not require
    // standing in a usable channel.
    gw.facts = { ...USABLE, inGuild: false, botInGuild: false, channelResolved: false };

    const result = await gw.run(USER, 'clear');
    expect(result.kind).toBe('text');
    expect(textOf(result)).toContain(`instead of <#${OTHER_CHANNEL}>`);
    expect(gw.probeCalls).toBe(0);
    expect(gw.pinOf(USER)).toEqual({ kind: 'dm' });
  });

  // Recording a choice that changes nothing today is the whole point: an operator who later sets
  // CCTL_SESSION_CHANNEL_ID must not sweep up a user who explicitly asked for DMs, while the user
  // who happened to pin-then-clear stays put. Same visible action, same future.
  it('records the DM choice even on a deployment with no channel to override', async () => {
    const dir = await tempDir();
    const gw = await gateway({ stateDir: dir });
    const result = await gw.run(USER, 'clear');
    expect(result.kind).toBe('text');
    expect(textOf(result)).toContain('your DMs');
    expect(gw.pinOf(USER)).toEqual({ kind: 'dm' });

    // And that record survives the operator edit it exists to defend against.
    const later = new ThreadHereGateway({
      relay: stubRelay,
      pairing: stubPairing,
      token: 'not-used-without-start',
      stateDir: dir,
      sessionChannelId: OTHER_CHANNEL,
    });
    await later.loadPins();
    expect(await later.resolveFor(USER)).toBeUndefined();
    // Everyone who never expressed a choice still follows the new deployment channel.
    await expect(Promise.resolve(later.resolveFor(OTHER))).rejects.toThrow();
  });

  it('reports a second clear as a no-op once the DM choice is recorded', async () => {
    const gw = await gateway({ sessionChannelId: OTHER_CHANNEL });
    await gw.run(USER, 'clear');
    const again = await gw.run(USER, 'clear');
    expect(textOf(again)).toContain('already go to your DMs');
  });

  // The integration this whole change exists for: command → store → resolver, with no restart in
  // between, on a deployment that configures no session channels at all.
  it('honours a pin made by the command through the constructor-wired resolver', async () => {
    const gw = await gateway();
    // Before the pin this deployment routes everyone to DMs.
    expect(await gw.resolveFor(USER)).toBeUndefined();

    await gw.run(USER, 'pin');

    // The resolver now reaches for the pinned channel: the fetch fails against no client, which is
    // fine — reaching the fetch at all is the proof that the pin was consulted.
    await expect(Promise.resolve(gw.resolveFor(USER))).rejects.toThrow();
    // And only for the user who pinned.
    expect(await gw.resolveFor(OTHER)).toBeUndefined();
  });

  it("a cleared pin beats the deployment's own channel", async () => {
    const gw = await gateway({ sessionChannelId: OTHER_CHANNEL });
    await gw.run(USER, 'clear');
    expect(await gw.resolveFor(USER)).toBeUndefined();
    // Everyone else still follows the deployment channel.
    await expect(Promise.resolve(gw.resolveFor(OTHER))).rejects.toThrow();
  });

  it('keeps a user with no config and no pin on DMs', async () => {
    const gw = await gateway();
    // A resolver now always exists (it has to, or a first pin could not take effect until a
    // restart), and answering `undefined` for everyone is what the gateway reads as "DM this user"
    // — the same outcome the pure-DM deployment always had.
    expect(await gw.resolveFor(USER)).toBeUndefined();
  });

  it('reports where output goes, its source, and a pinned channel that has become unusable', async () => {
    const gw = await gateway({ sessionChannelId: OTHER_CHANNEL });
    const deployment = await gw.run(USER, 'show');
    expect(textOf(deployment)).toContain("this deployment's default");

    await gw.run(USER, 'pin');
    gw.health = { kind: 'missing-permissions', missing: ['Manage Threads'] };
    const broken = await gw.run(USER, 'show');
    expect(textOf(broken)).toContain(`<#${CHANNEL}>`);
    expect(textOf(broken)).toContain('Manage Threads');
    // The pin is NOT auto-cleared by a channel going bad — a transient outage must not silently
    // discard a setting the user chose — so the reply has to say where output is landing meanwhile.
    expect(textOf(broken)).toContain('your DMs');
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  it('a pin survives a restart', async () => {
    const dir = await tempDir();
    const first = new ThreadHereGateway({
      relay: stubRelay,
      pairing: stubPairing,
      token: 'not-used-without-start',
      stateDir: dir,
    });
    await first.run(USER, 'pin');

    // A brand-new gateway over the same state dir, loaded the way start() loads it.
    const second = new ThreadHereGateway({
      relay: stubRelay,
      pairing: stubPairing,
      token: 'not-used-without-start',
      stateDir: dir,
    });
    await second.loadPins();
    expect(second.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  // The store goes to real trouble to make a failed write reportable (the memory mutation is rolled
  // back inside the queued unit, and record() returns the un-swallowed promise). What only the
  // gateway can hold is that the trouble is USED: a write that never reached disk must answer with
  // an error, not a confirmation of a setting that would vanish on restart.
  it('reports a failed write as an error rather than a confirmation', async () => {
    const dir = await tempDir();
    // A directory where the state file belongs makes the rename fail for real, without mocking the
    // writer — the same idiom sessionChannelPins.test.ts uses.
    await mkdir(join(dir, 'session-channel-pins.json'));
    const gw = await gateway({ stateDir: dir, sessionChannelId: OTHER_CHANNEL });

    const pinned = await gw.run(USER, 'pin');
    expect(pinned.kind).toBe('error');
    expect(textOf(pinned)).toContain('could not save');
    expect(textOf(pinned)).toContain('Nothing was changed.');
    // Rolled back in memory too, so the resolver never acts on a pin that is not on disk.
    expect(gw.pinOf(USER)).toBeUndefined();

    // The revocation path makes the same promise and has to keep it the same way.
    const cleared = await gw.run(USER, 'clear');
    expect(cleared.kind).toBe('error');
    expect(textOf(cleared)).toContain('could not save');
    expect(gw.pinOf(USER)).toBeUndefined();
  });

  // Every other command here answers synchronously; this one reads a channel, mints a probe thread,
  // admits the user, deletes it and persists before it can say anything. Discord gives an
  // unacknowledged interaction three seconds, and overrunning it shows "The application did not
  // respond" over a pin that DID persist — so the acknowledgement has to come first, and the answer
  // has to arrive as an edit of it.
  it('acknowledges the interaction before any of the slow work', async () => {
    const gw = await gateway();
    const events: string[] = [];
    const interaction = {
      commandName: 'thread-here',
      user: { id: USER },
      channelId: CHANNEL,
      deferred: false,
      options: { getString: () => null },
      deferReply: () => {
        events.push('defer');
        interaction.deferred = true;
        return Promise.resolve(undefined);
      },
      editReply: (payload: { content?: string }) => {
        events.push(`edit:${payload.content ?? ''}`);
        return Promise.resolve(undefined);
      },
      reply: () => {
        events.push('reply');
        return Promise.resolve(undefined);
      },
    };
    gw.onProbe = () => events.push('probe');

    await gw.slash(interaction as unknown as ChatInputCommandInteraction);

    expect(events[0]).toBe('defer');
    expect(events[1]).toBe('probe');
    // Delivered by editing the acknowledgement: `reply` on a deferred interaction is refused by
    // Discord, which would leave the user watching the thinking indicator with the pin already made.
    expect(events).not.toContain('reply');
    expect(events[2]).toContain(`<#${CHANNEL}>`);
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });

  // The diagnostic only earns its keep if it can name the likeliest cause, which is the user's own
  // access rather than the bot's: the bot creates the thread, then ADDS the user to it, and that
  // second half fails alone when someone leaves the server or loses sight of the channel.
  it('asks after the invoking user when checking a pinned channel, not just the bot', async () => {
    const gw = await gateway();
    await gw.run(USER, 'pin');
    gw.health = { kind: 'user-cannot-access' };

    const status = await gw.run(USER, 'show');
    expect(gw.healthCalls).toContainEqual({ channelId: CHANNEL, discordUserId: USER });
    expect(textOf(status)).toContain(`<#${CHANNEL}>`);
    expect(textOf(status)).toContain('cannot see that channel');
    expect(textOf(status)).toContain('your DMs');
    // Still not auto-cleared: a user who rejoins gets their channel back without re-pinning.
    expect(gw.pinOf(USER)).toEqual({ kind: 'channel', channelId: CHANNEL });
  });
});

// Constraint that needs no code and would be lost by an innocent-looking refactor: a session's
// delivery target is decided once, on its first frame, so moving your channel never moves a session
// that is already streaming.
describe('DiscordJsGateway — a running session keeps its thread', () => {
  const USER = '111111111111111111';

  /** Drives `ensureTarget` directly — the real path costs a live channel fetch, and what is under
   *  test is how OFTEN the resolver is consulted, not what it returns. */
  class EnsureTargetGateway extends DiscordJsGateway {
    drive(route: SessionRoute): Promise<DeliveryTarget> {
      return this.ensureTarget(route);
    }
  }

  it('leaves a session already bound to a thread on that thread after a pin change', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'thread-here-ensure-'));
    try {
      let channelId = 'channel-one';
      let resolverCalls = 0;
      const gw = new EnsureTargetGateway({
        relay: stubRelay,
        pairing: stubPairing,
        token: 'not-used-without-start',
        stateDir: dir,
        sessionChannelResolver: () => {
          resolverCalls += 1;
          return Promise.resolve({
            threads: {
              create: () =>
                Promise.resolve({
                  id: `thread-in-${channelId}`,
                  members: { add: () => Promise.resolve(undefined) },
                }),
            },
          });
        },
      });
      const route: SessionRoute = { discordUserId: USER, sessionId: 's1' };

      expect(await gw.drive(route)).toEqual({ kind: 'thread', threadId: 'thread-in-channel-one' });
      expect(resolverCalls).toBe(1);

      // The user moves their channel mid-session.
      channelId = 'channel-two';
      expect(await gw.drive(route)).toEqual({ kind: 'thread', threadId: 'thread-in-channel-one' });
      // Never re-resolved: the registry entry short-circuits, which is the whole mechanism.
      expect(resolverCalls).toBe(1);

      // A NEW session follows the change.
      const next = await gw.drive({ discordUserId: USER, sessionId: 's2' });
      expect(next).toEqual({ kind: 'thread', threadId: 'thread-in-channel-two' });
      expect(resolverCalls).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('missingThreadPermissionLabels', () => {
  const ALL = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.CreatePrivateThreads,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
  ];

  it('reports nothing missing when every thread permission is granted', () => {
    expect(missingThreadPermissionLabels(new PermissionsBitField(ALL))).toEqual([]);
  });

  // The non-obvious one, and the reason the preflight exists: session threads are created with
  // `invitable: false`, so admitting the user needs Manage Threads. Without it the create succeeds
  // and the add throws, and delivery lands on DMs with only a log line to show for it.
  it('names Manage Threads when only that one is missing', () => {
    const granted = ALL.filter((flag) => flag !== PermissionFlagsBits.ManageThreads);
    expect(missingThreadPermissionLabels(new PermissionsBitField(granted))).toEqual([
      'Manage Threads',
    ]);
  });

  it('reports them in fix order when several are missing', () => {
    expect(missingThreadPermissionLabels(new PermissionsBitField([]))).toEqual([
      'View Channel',
      'Create Private Threads',
      'Send Messages in Threads',
      'Manage Threads',
    ]);
  });

  // No computed permission set at all is unknown, not granted — reporting "nothing missing" there
  // would pin a channel on the strength of an absence.
  it('treats an absent permission set as everything missing', () => {
    expect(missingThreadPermissionLabels(null)).toHaveLength(4);
  });
});
