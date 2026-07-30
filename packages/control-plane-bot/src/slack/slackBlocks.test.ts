import { describe, it, expect, vi } from 'vitest';
import type { App } from '@slack/bolt';
import type { types as SlackBlockTypes } from '@slack/bolt';
import type { Envelope } from '@claude-control/shared-protocol';
import { SLACK_LIMITS } from './slackFormat.js';
import { deliverCard, registerSlackInteractivity, withBlockBudget } from './slackBlocks.js';
import type { SlackContext } from './context.js';
import type { RelaySender, SendResult } from '../relay.js';
import type { PairingService } from '../pairing.js';
import type { DaemonStateCache } from '../discord/stateCache.js';

type KnownBlock = SlackBlockTypes.KnownBlock;

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Captures every `app.action(matcher, handler)` registration and lets a test fire one by the
 *  action_id Slack would have sent — the same black-box shape a real Bolt dispatch presents. */
class FakeApp {
  private readonly handlers: { matcher: RegExp; handler: (args: never) => Promise<void> }[] = [];

  action(matcher: RegExp, handler: (args: never) => Promise<void>): void {
    this.handlers.push({ matcher, handler });
  }

  async fire(actionId: string, args: unknown): Promise<void> {
    const entry = this.handlers.find((h) => h.matcher.test(actionId));
    if (!entry) throw new Error(`no handler registered for action_id ${actionId}`);
    await entry.handler(args as never);
  }
}

function createFakeWebClient() {
  let seq = 0;
  const postMessage = vi.fn((args: { channel: string }) =>
    Promise.resolve({ ok: true, ts: `ts-${++seq}`, channel: args.channel }),
  );
  const update = vi.fn(() => Promise.resolve({ ok: true }));
  return { chat: { postMessage, update } };
}

function createFakeCtx() {
  const web = createFakeWebClient();
  // Held separately from `ctx`: reading it back off the SlackContext would be an unbound method
  // reference, and the mock is what assertions actually want anyway.
  const openDm = vi.fn((slackUserId: string) => Promise.resolve(`D-${slackUserId}`));
  const relayCalls: { userId: string; envelope: unknown }[] = [];
  const relay: RelaySender = {
    sendToUser: vi.fn((userId: string, build: (daemonId: string) => unknown): SendResult => {
      relayCalls.push({ userId, envelope: build('daemon-1') });
      return { ok: true };
    }),
    isOnline: () => true,
  };
  const ctx = {
    web,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    relay,
    pairing: {} as unknown as PairingService,
    teamId: 'T1',
    cache: {} as unknown as DaemonStateCache,
    statsScans: {} as unknown as SlackContext['statsScans'],
    openDm,
    principalOf: (slackUserId: string) => `slack:T1:${slackUserId}`,
  } as unknown as SlackContext;
  return { ctx, web, relayCalls, openDm };
}

// ---------------------------------------------------------------------------
// Envelope builders
// ---------------------------------------------------------------------------

function permissionRequest(overrides: {
  requestId: string;
  summary: string;
  detail?: string;
  permissionMode?: string;
}): Envelope {
  return {
    v: 1,
    id: 'e-1',
    ts: 0,
    daemonId: 'daemon-1',
    discordUserId: 'U1',
    type: 'permission.request',
    payload: {
      requestId: overrides.requestId,
      sessionId: 's-1',
      tool: 'Bash',
      summary: overrides.summary,
      detail: overrides.detail,
      permissionMode: overrides.permissionMode,
    },
  } as unknown as Envelope;
}

function permissionLapsed(requestId: string, reason: 'local' | 'expired' | 'shutdown'): Envelope {
  return {
    v: 1,
    id: 'e-2',
    ts: 0,
    daemonId: 'daemon-1',
    discordUserId: 'U1',
    type: 'permission.lapsed',
    payload: { requestId, reason },
  } as unknown as Envelope;
}

function questionRequest(requestId: string): Envelope {
  return {
    v: 1,
    id: 'e-3',
    ts: 0,
    daemonId: 'daemon-1',
    discordUserId: 'U1',
    type: 'question.request',
    payload: {
      requestId,
      sessionId: 's-1',
      questions: [
        {
          question: 'Which environment?',
          header: 'Environment',
          multiSelect: false,
          options: [{ label: 'staging' }, { label: 'production' }],
        },
        {
          question: 'Which regions?',
          header: 'Regions',
          multiSelect: true,
          options: [{ label: 'us-east' }, { label: 'eu-west' }],
        },
      ],
    },
  } as unknown as Envelope;
}

function questionLapsed(requestId: string, reason: 'local' | 'expired' | 'shutdown'): Envelope {
  return {
    v: 1,
    id: 'e-4',
    ts: 0,
    daemonId: 'daemon-1',
    discordUserId: 'U1',
    type: 'question.lapsed',
    payload: { requestId, reason },
  } as unknown as Envelope;
}

// ---------------------------------------------------------------------------
// Block-tree helpers
// ---------------------------------------------------------------------------

function actionsElements(blocks: KnownBlock[]): SlackBlockTypes.ActionsBlockElement[] {
  return blocks
    .filter((b): b is SlackBlockTypes.ActionsBlock => b.type === 'actions')
    .flatMap((b) => b.elements);
}

function findButtonByLabel(blocks: KnownBlock[], label: string): SlackBlockTypes.Button {
  const found = actionsElements(blocks).find(
    (el): el is SlackBlockTypes.Button => el.type === 'button' && el.text.text === label,
  );
  if (!found) throw new Error(`no button labelled "${label}" in blocks`);
  return found;
}

function lastCallArgs<T>(mockFn: { mock: { calls: unknown[][] } }): T {
  const calls = mockFn.mock.calls;
  const last = calls[calls.length - 1];
  if (!last) throw new Error('mock was never called');
  return last[0] as T;
}

/** The `ts` Slack returned for the Nth `chat.postMessage`. Vitest types `mock.results[].value` as
 *  `any` (the union covers the throw case), so the returned shape is restated once here rather
 *  than re-asserted at every call site. */
async function postedTs(
  postMessage: ReturnType<typeof createFakeWebClient>['chat']['postMessage'],
  index = 0,
): Promise<string> {
  const result = postMessage.mock.results[index];
  if (!result || result.type !== 'return') throw new Error(`postMessage #${index} never returned`);
  return ((await result.value) as { ts: string }).ts;
}

function fakeAckArgs(overrides: Record<string, unknown>) {
  return {
    ack: vi.fn(() => Promise.resolve(undefined)),
    respond: vi.fn(() => Promise.resolve(undefined)),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deliverCard', () => {
  it('renders a permission.request card into the user DM and returns true', async () => {
    const { ctx, web, openDm } = createFakeCtx();
    const owned = await deliverCard(
      ctx,
      'U1',
      permissionRequest({ requestId: 'req-1', summary: 'rm -rf /tmp/x' }),
    );
    expect(owned).toBe(true);
    expect(openDm).toHaveBeenCalledWith('U1');
    expect(web.chat.postMessage).toHaveBeenCalledTimes(1);
    const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
    expect(findButtonByLabel(blocks, 'Approve')).toBeDefined();
    expect(findButtonByLabel(blocks, 'Deny')).toBeDefined();
    expect(findButtonByLabel(blocks, 'Deny (session)')).toBeDefined();
  });

  it('returns false for an envelope kind it does not own', async () => {
    const { ctx } = createFakeCtx();
    const owned = await deliverCard(ctx, 'U1', {
      v: 1,
      id: 'e-9',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId: 'U1',
      type: 'switch.result',
      payload: {
        requestId: 'r',
        ok: true,
        outcome: 'hot_applied',
        activeAccountId: 'a',
        message: 'ok',
      },
    } as unknown as Envelope);
    expect(owned).toBe(false);
  });

  it('permission round trip: render, tap Approve, principal routed, card resolved', async () => {
    const { ctx, web, relayCalls } = createFakeCtx();
    const app = new FakeApp();
    await deliverCard(
      ctx,
      'U1',
      permissionRequest({ requestId: 'req-1', summary: 'rm -rf /tmp/x' }),
    );
    registerSlackInteractivity(app as unknown as App, ctx);

    const { blocks, channel } = lastCallArgs<{ blocks: KnownBlock[]; channel: string }>(
      web.chat.postMessage,
    );
    const ts = await postedTs(web.chat.postMessage);
    const approve = findButtonByLabel(blocks, 'Approve');

    const respond = vi.fn(() => Promise.resolve(undefined));
    await app.fire(
      approve.action_id!,
      fakeAckArgs({
        action: {
          type: 'button',
          action_id: approve.action_id,
          value: approve.value,
          block_id: 'b',
          action_ts: '1',
          text: approve.text,
        },
        body: { user: { id: 'U1' }, channel: { id: channel }, message: { type: 'message', ts } },
        client: web,
        respond,
      }),
    );

    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.userId).toBe(ctx.principalOf('U1'));
    expect(relayCalls[0]!.envelope).toMatchObject({
      type: 'permission.response',
      payload: { requestId: 'req-1', decision: 'allow', scope: 'once' },
    });

    const update = lastCallArgs<{ channel: string; ts: string; blocks: KnownBlock[] }>(
      web.chat.update,
    );
    expect(update.channel).toBe(channel);
    expect(update.ts).toBe(ts);
    expect(update.blocks.some((b) => b.type === 'actions')).toBe(false);
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ text: 'Approved.' }));
  });

  it('suppresses a double-tapped Approve as "Already handled."', async () => {
    const { ctx, web, relayCalls } = createFakeCtx();
    const app = new FakeApp();
    await deliverCard(ctx, 'U1', permissionRequest({ requestId: 'req-2', summary: 'ls' }));
    registerSlackInteractivity(app as unknown as App, ctx);
    const { blocks, channel } = lastCallArgs<{ blocks: KnownBlock[]; channel: string }>(
      web.chat.postMessage,
    );
    const ts = await postedTs(web.chat.postMessage);
    const approve = findButtonByLabel(blocks, 'Approve');
    const args = () =>
      fakeAckArgs({
        action: {
          type: 'button',
          action_id: approve.action_id,
          value: approve.value,
          block_id: 'b',
          action_ts: '1',
          text: approve.text,
        },
        body: { user: { id: 'U1' }, channel: { id: channel }, message: { type: 'message', ts } },
        client: web,
      });

    const first = args();
    await app.fire(approve.action_id!, first);
    const second = args();
    await app.fire(approve.action_id!, second);

    expect(relayCalls).toHaveLength(1);
    expect(second.respond).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Already handled.' }),
    );
  });

  it('lapses a permission card whose requestId was never tracked without throwing', async () => {
    const { ctx, web } = createFakeCtx();
    await expect(deliverCard(ctx, 'U1', permissionLapsed('never-seen', 'expired'))).resolves.toBe(
      true,
    );
    expect(web.chat.update).not.toHaveBeenCalled();
  });

  it('lapses a live question card before it is answered, then no-ops the second lapse', async () => {
    const { ctx, web } = createFakeCtx();
    await deliverCard(ctx, 'U1', questionRequest('req-q1'));
    await deliverCard(ctx, 'U1', questionLapsed('req-q1', 'expired'));
    expect(web.chat.update).toHaveBeenCalledTimes(1);
    const { blocks, text } = lastCallArgs<{ blocks: KnownBlock[]; text: string }>(web.chat.update);
    expect(text).toBe('Expired — continuing without answers');
    const header = blocks[0] as SlackBlockTypes.HeaderBlock;
    expect(header.type).toBe('header');
    expect(header.text.text).toBe('Expired — continuing without answers');
    expect(blocks.some((b) => b.type === 'actions')).toBe(false);

    // A second lapse for the same (now-consumed) requestId is a silent no-op.
    await deliverCard(ctx, 'U1', questionLapsed('req-q1', 'expired'));
    expect(web.chat.update).toHaveBeenCalledTimes(1);
  });

  it('question single + multi select: completes only once every question is answered', async () => {
    const { ctx, web, relayCalls } = createFakeCtx();
    const app = new FakeApp();
    await deliverCard(ctx, 'U1', questionRequest('req-q2'));
    registerSlackInteractivity(app as unknown as App, ctx);

    const { blocks, channel } = lastCallArgs<{ blocks: KnownBlock[]; channel: string }>(
      web.chat.postMessage,
    );
    const elements = actionsElements(blocks);
    const q0Button = elements.find(
      (el): el is SlackBlockTypes.Button => el.type === 'button' && el.value === '0',
    );
    const q1Select = elements.find(
      (el): el is SlackBlockTypes.MultiStaticSelect => el.type === 'multi_static_select',
    );
    const submit = elements.find(
      (el): el is SlackBlockTypes.Button => el.type === 'button' && el.text.text === 'Submit',
    );
    expect(q0Button).toBeDefined();
    expect(q1Select).toBeDefined();
    expect(submit).toBeDefined();

    const respond = vi.fn(() => Promise.resolve(undefined));
    const baseBody = { user: { id: 'U1' }, channel: { id: channel } };

    // Q0: single-select button tap — recorded, but the card is not complete yet (Q1 unanswered).
    await app.fire(
      q0Button!.action_id!,
      fakeAckArgs({
        action: {
          type: 'button',
          action_id: q0Button!.action_id,
          value: q0Button!.value,
          block_id: 'b',
          action_ts: '1',
          text: q0Button!.text,
        },
        body: baseBody,
        client: web,
        respond,
      }),
    );
    expect(relayCalls).toHaveLength(0);
    expect(web.chat.update).not.toHaveBeenCalled();

    // Q1: a multi-select change alone must NOT auto-finalize.
    await app.fire(
      q1Select!.action_id!,
      fakeAckArgs({
        action: {
          type: 'multi_static_select',
          action_id: q1Select!.action_id,
          selected_options: [
            { text: { type: 'plain_text', text: 'us-east' }, value: '0' },
            { text: { type: 'plain_text', text: 'eu-west' }, value: '1' },
          ],
          block_id: 'b',
          action_ts: '1',
        },
        body: baseBody,
        client: web,
        respond,
      }),
    );
    expect(relayCalls).toHaveLength(0);

    // The explicit Submit tap is what finalizes the card.
    await app.fire(
      submit!.action_id!,
      fakeAckArgs({
        action: {
          type: 'button',
          action_id: submit!.action_id,
          block_id: 'b',
          action_ts: '1',
          text: submit!.text,
        },
        body: baseBody,
        client: web,
        respond,
      }),
    );

    expect(relayCalls).toHaveLength(1);
    expect(relayCalls[0]!.envelope).toMatchObject({
      type: 'question.response',
      payload: {
        requestId: 'req-q2',
        answers: [
          { question: 'Which environment?', selected: ['staging'] },
          { question: 'Which regions?', selected: ['us-east', 'eu-west'] },
        ],
      },
    });
    expect(respond).toHaveBeenLastCalledWith(
      expect.objectContaining({ text: 'Answer sent to the session.' }),
    );
    const update = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.update);
    expect(update.blocks.some((b) => b.type === 'actions')).toBe(false);
  });

  it('cannot let hostile summary text survive as a live mention', async () => {
    const { ctx, web } = createFakeCtx();
    await deliverCard(
      ctx,
      'U1',
      permissionRequest({
        requestId: 'req-hostile',
        summary: '<!channel> ping <@U999999> please rm -rf /',
      }),
    );
    const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
    const summarySection = blocks.find(
      (b): b is SlackBlockTypes.SectionBlock => b.type === 'section' && b.text !== undefined,
    );
    const rendered = (summarySection?.text as SlackBlockTypes.MrkdwnElement).text;
    expect(rendered).not.toContain('<!channel>');
    expect(rendered).not.toContain('<@U999999>');
  });

  it('truncates an over-long detail field with a visible marker instead of exceeding the section budget', async () => {
    const { ctx, web } = createFakeCtx();
    const longDetail = 'x'.repeat(SLACK_LIMITS.SECTION_TEXT_MAX + 500);
    await deliverCard(
      ctx,
      'U1',
      permissionRequest({ requestId: 'req-long', summary: 'short', detail: longDetail }),
    );
    const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
    const sections = blocks.filter((b): b is SlackBlockTypes.SectionBlock => b.type === 'section');
    const detailSection = sections[sections.length - 1]!;
    const text = (detailSection.text as SlackBlockTypes.MrkdwnElement).text;
    expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.SECTION_TEXT_MAX);
    expect(text).toContain('truncated');
  });

  describe('link scheme allowlist — end to end through the card senders', () => {
    // Same payload table as slackFormat.test.ts's toMrkdwn suite, driven through the actual card
    // renderers (permission summary/detail, question text) rather than toMrkdwn directly — proving
    // a future sender that bypasses toMrkdwn's link conversion (or calls it differently) still
    // can't let one of these through, because the assertion is structural, not string-specific.
    const HOSTILE_LINK_URLS = [
      '!channel',
      '!here',
      '!everyone',
      '@U024BE7LH',
      '#C024BE7LR|general',
    ];

    function sectionTexts(blocks: KnownBlock[]): string[] {
      return blocks
        .filter(
          (b): b is SlackBlockTypes.SectionBlock => b.type === 'section' && b.text !== undefined,
        )
        .map((b) => (b.text as SlackBlockTypes.MrkdwnElement).text);
    }

    it.each(HOSTILE_LINK_URLS)(
      'never renders a live mention from a [label](%s) link in a permission summary or detail',
      async (url) => {
        const { ctx, web } = createFakeCtx();
        const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
        await deliverCard(
          ctx,
          'U1',
          permissionRequest({
            requestId: `req-link-${safeId}`,
            summary: `see [details](${url})`,
            detail: `also [here](${url})`,
          }),
        );
        const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
        for (const text of sectionTexts(blocks)) {
          expect(text).not.toMatch(/<[!@#]/);
        }
      },
    );

    it.each(HOSTILE_LINK_URLS)(
      'never renders a live mention from a [label](%s) link in a question card',
      async (url) => {
        const { ctx, web } = createFakeCtx();
        const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
        const envelope: Envelope = {
          v: 1,
          id: 'e-link',
          ts: 0,
          daemonId: 'daemon-1',
          discordUserId: 'U1',
          type: 'question.request',
          payload: {
            requestId: `req-qlink-${safeId}`,
            sessionId: 's-1',
            questions: [
              {
                question: `pick one [opt](${url})`,
                header: 'Q',
                multiSelect: false,
                options: [{ label: 'a' }, { label: 'b' }],
              },
            ],
          },
        } as unknown as Envelope;
        await deliverCard(ctx, 'U1', envelope);
        const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
        for (const text of sectionTexts(blocks)) {
          expect(text).not.toMatch(/<[!@#]/);
        }
      },
    );
  });

  it('closes an unterminated code fence left open by clamping an over-long detail, instead of leaving Slack to swallow the rest of the card into a code block', async () => {
    const { ctx, web } = createFakeCtx();
    const detail = '```\n' + 'x'.repeat(5000) + '\n```';
    await deliverCard(
      ctx,
      'U1',
      permissionRequest({ requestId: 'req-fence', summary: 'short', detail }),
    );
    const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
    const sections = blocks.filter((b): b is SlackBlockTypes.SectionBlock => b.type === 'section');
    const text = (sections[sections.length - 1]!.text as SlackBlockTypes.MrkdwnElement).text;
    expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.SECTION_TEXT_MAX);
    expect((text.match(/```/g) ?? []).length % 2).toBe(0);
  });

  // Swept across a small range of padding lengths rather than one fixed offset: the exact byte
  // where truncateLabeled's blind cut lands depends on internal stash-token bookkeeping this test
  // has no business knowing the width of, but '&' recurs every 5 escaped characters once
  // sanitized ('&' -> '&amp;'), so sweeping 5 consecutive offsets is guaranteed to include
  // whichever one actually lands mid-entity — proving the fix regardless of that internal detail.
  it.each([0, 1, 2, 3, 4])(
    'clamps an over-long &-heavy detail without leaving a half-cut entity dangling before the marker (padding offset %i)',
    async (pad) => {
      const { ctx, web } = createFakeCtx();
      const detail = 'x'.repeat(50 + pad) + '&'.repeat(4000);
      await deliverCard(
        ctx,
        'U1',
        permissionRequest({ requestId: `req-entity-${pad}`, summary: 'short', detail }),
      );
      const { blocks } = lastCallArgs<{ blocks: KnownBlock[] }>(web.chat.postMessage);
      const sections = blocks.filter(
        (b): b is SlackBlockTypes.SectionBlock => b.type === 'section',
      );
      const text = (sections[sections.length - 1]!.text as SlackBlockTypes.MrkdwnElement).text;
      expect(text.length).toBeLessThanOrEqual(SLACK_LIMITS.SECTION_TEXT_MAX);
      const markerMatch = / … \[\+(\d+) chars truncated\]/.exec(text);
      expect(markerMatch).not.toBeNull();
      const before = markerMatch ? text.slice(0, markerMatch.index) : text;
      // The exact check truncateEntitySafe itself makes: nothing dangling right before the marker.
      expect(before).not.toMatch(/&\w{0,3}$/);
    },
  );

  it('withBlockBudget caps a block list and leaves a visible omission marker', () => {
    const blocks: KnownBlock[] = Array.from(
      { length: SLACK_LIMITS.BLOCKS_PER_MESSAGE_MAX + 10 },
      (_, i) => ({
        type: 'divider',
        block_id: `d-${i}`,
      }),
    );
    const capped = withBlockBudget(blocks);
    expect(capped.length).toBe(SLACK_LIMITS.BLOCKS_PER_MESSAGE_MAX);
    const marker = capped[capped.length - 1]!;
    expect(marker.type).toBe('context');
    expect((marker as SlackBlockTypes.ContextBlock).elements[0]).toMatchObject({
      // Cast: asymmetric matchers are typed `any`, which the unsafe-assignment rule rejects.
      text: expect.stringContaining('omitted') as string,
    });
  });
});
