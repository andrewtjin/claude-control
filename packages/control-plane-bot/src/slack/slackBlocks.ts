// Block Kit twins of the Discord permission/question card set, plus their interactivity.
//
// WHY this shape: every DECISION already lives in the Discord-side pure modules — the
// action-id/value grammar (buttons.ts), the two-tap confirm state machine (buttons.ts's
// resolveTap), the bounded card registries and progressive-answer collector (permissionCards.ts /
// questionCards.ts), and the command dispatch (discord/commands.ts). None of that is
// Discord-specific; it is "how an approval or an answer round-trips", and re-deriving it here
// would let the two surfaces silently disagree about what a double-tap or an expired confirm
// means. So this module imports those pieces verbatim and supplies only the one thing that
// really is Slack-specific: turning plain ButtonSpecs/requestIds into Block Kit JSON and back.
//
// The one structural gap: discord.js's `Message.edit()` (and `EmbedBuilder.from`) let the Discord
// surface patch just the fields it wants to change and keep everything else. `chat.update` has no
// such partial-patch concept — every edit resends the FULL block array. So this module keeps its
// own bot-side `requestId -> {channel, ts, blocks}` map (populated once, at render time) and every
// later edit (confirm/restore/execute/lapse/answered) rebuilds the message from that plus whatever
// changed, rather than mutating anything already posted.

import type { App } from '@slack/bolt';
import type { types as SlackBlockTypes } from '@slack/bolt';
import type {
  BlockAction,
  ButtonAction,
  StaticSelectAction,
  MultiStaticSelectAction,
} from '@slack/bolt';
import { isType, type Envelope, type PayloadOf } from '@claude-control/shared-protocol';
import type { SlackContext, SlackWebClient } from './context.js';
import { toMrkdwn, sanitizeSlackText, SLACK_LIMITS } from './slackFormat.js';
import {
  decodeButton,
  resolveTap,
  permissionButtons,
  buttonIdempotencyKey,
  type ButtonSpec,
} from '../discord/buttons.js';
import {
  QuestionCardRegistry,
  QuestionAnswerCollector,
  encodeQuestionSelect,
  decodeQuestionSelect,
  encodeOptionValue,
  questionSubmitDedupeKey,
  questionIdempotencyKey,
  MAX_QUESTIONS,
  MAX_OPTIONS,
} from '../discord/questionCards.js';
import { PermissionCardRegistry } from '../discord/permissionCards.js';
import { SeenKeys } from '../discord/idempotencyGuard.js';
import {
  handleApprove,
  handleDeny,
  handleQuestionAnswer,
  type CommandDeps,
  type CommandResult,
} from '../discord/commands.js';
import { truncateLabeled } from '../discord/richFormat.js';
import { clampBalanced } from '../discord/messageChunks.js';

type KnownBlock = SlackBlockTypes.KnownBlock;

// ---------------------------------------------------------------------------
// Per-ctx module state
// ---------------------------------------------------------------------------
//
// deliverCard() and registerSlackInteractivity() are two independently-callable exports, but a
// button tap has to find the SAME card a push rendered — so their state has to be shared. It is
// keyed off the SlackContext instance (a WeakMap, not a module-level singleton) so two contexts
// — two paired teams, or two isolated tests — never see each other's cards, without adding a
// slot to the pinned SlackContext type this module does not own.

interface SlackCardState {
  /** requestId -> {channel, ts} for a live permission card, so a later `permission.lapsed` push
   *  (which arrives with no interaction context) can find it. Discord's CardRef shape is reused
   *  verbatim (channelId/messageId) purely for its proven bounded-FIFO, one-shot-on-resolve
   *  registry logic; the fields hold Slack's channel id and message `ts` respectively. */
  permissionCards: PermissionCardRegistry;
  /** Same reuse, for question cards — plus the progressive-answer collector below. */
  questionCards: QuestionCardRegistry;
  questionAnswers: QuestionAnswerCollector;
  /** Bot-side double-click / double-submit guard, mirroring the Discord surface's SeenKeys
   *  instance exactly (same class, same dedupe-key grammar). */
  seenKeys: SeenKeys;
  /** requestId -> the card's non-interactive blocks (header/section/context — everything except
   *  the actions row(s)), captured once at render time. Every later edit rebuilds the full message
   *  from this plus a fresh actions row, which is what `chat.update`'s full-replace contract
   *  requires (see the module comment). */
  cardBlocks: BoundedBlockStore;
}

/** Same cap rationale as {@link PermissionCardRegistry}/{@link QuestionCardRegistry}'s own
 *  MAX_ENTRIES (64): bounded so a long-lived bot's memory can't grow with total-requests-ever
 *  rather than concurrent-holds. Sized at double a single registry's cap because this ONE store is
 *  shared across both the permission and the question surface (requestIds are server-minted and
 *  never collide across kinds), so it must outlive whichever combination of the two registries is
 *  closer to full — sizing it to only one registry's cap would let it evict a block set the other
 *  registry still has a live ref for. */
const CARD_BLOCKS_MAX = 128;

/** A minimal bounded FIFO map, matching the eviction shape of the reused Discord registries
 *  (oldest entry dropped once the cap is exceeded) — kept local rather than imported because
 *  neither permissionCards.ts nor questionCards.ts has a slot for arbitrary block JSON in their
 *  CardRef, and this module owns no shared "state module" of its own to add one to. */
class BoundedBlockStore {
  private readonly byRequestId = new Map<string, KnownBlock[]>();

  set(requestId: string, blocks: KnownBlock[]): void {
    if (this.byRequestId.size >= CARD_BLOCKS_MAX && !this.byRequestId.has(requestId)) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest !== undefined) this.byRequestId.delete(oldest);
    }
    this.byRequestId.set(requestId, blocks);
  }

  get(requestId: string): KnownBlock[] | undefined {
    return this.byRequestId.get(requestId);
  }

  delete(requestId: string): void {
    this.byRequestId.delete(requestId);
  }
}

const stateByCtx = new WeakMap<SlackContext, SlackCardState>();

function stateFor(ctx: SlackContext): SlackCardState {
  let state = stateByCtx.get(ctx);
  if (!state) {
    state = {
      permissionCards: new PermissionCardRegistry(),
      questionCards: new QuestionCardRegistry(),
      questionAnswers: new QuestionAnswerCollector(),
      // 10-minute TTL mirrors the discord.js gateway's SEEN_KEYS_TTL_MS intent: long enough to
      // catch a genuine double-tap/double-submit, short enough that a legitimate retry long after
      // is never mistaken for one.
      seenKeys: new SeenKeys({ max: 256, ttlMs: 10 * 60_000 }),
      cardBlocks: new BoundedBlockStore(),
    };
    stateByCtx.set(ctx, state);
  }
  return state;
}

// ---------------------------------------------------------------------------
// Text helpers — every wire-derived string funnels through exactly one of these, exactly once,
// so sanitize/format never runs twice over the same text (double-escaping risk) and every leaf
// text object is clamped to Slack's own field ceiling with a visible truncation marker.
// ---------------------------------------------------------------------------

/** Slack option/button/header/placeholder text: literal, never markdown-parsed, but still run
 *  through the sanitizer — defense in depth, since this module's contract is "every wire string,
 *  no exceptions" rather than "every string Slack would otherwise treat as mrkdwn". */
function plainText(raw: string, max: number): SlackBlockTypes.PlainTextElement {
  const safe = sanitizeSlackText(raw);
  return {
    type: 'plain_text',
    text: safe.length > max ? truncateLabeled(safe, max) : safe,
    emoji: true,
  };
}

/** Every possible half-written prefix of the three entities `sanitizeSlackText` ever emits
 *  (`&amp;`, `&lt;`, `&gt;`), anchored to the very end of a string — `&`, `&a`, `&am`, `&amp`,
 *  `&l`, `&lt`, `&g`, `&gt`. Because sanitize is the ONLY source of `&` in this pipeline's output,
 *  and it never emits anything BUT those three complete entities, an `&`-led run dangling at a cut
 *  boundary can only be one of these — never a coincidental match against ordinary prose. */
const DANGLING_ENTITY_TAIL = /&\w{0,3}$/;

/** `truncateLabeled`'s own marker, matched verbatim so its `hidden` count can be re-derived after
 *  the cut point below is retreated. */
const TRUNCATION_MARKER = / … \[\+(\d+) chars truncated\]$/;

/** `truncateLabeled` cuts blind. Landing mid-entity leaves Slack rendering literal garbage
 *  (`&am`) instead of the character the entity stood in for, so a cut that lands there is
 *  retreated to just before the broken entity and the marker's hidden-count is recomputed to
 *  match. Passed as the `clamp` argument to {@link clampBalanced} (see `mrkdwnText`) so a
 *  fence-balancing re-cut goes through this same entity-safe path rather than a second, unguarded
 *  call to `truncateLabeled`. */
function truncateEntitySafe(text: string, max: number): string {
  const naive = truncateLabeled(text, max);
  const marker = TRUNCATION_MARKER.exec(naive);
  if (!marker) return naive; // text fit inside `max`; nothing was cut, nothing to repair
  const body = naive.slice(0, marker.index);
  const dangling = DANGLING_ENTITY_TAIL.exec(body);
  if (!dangling) return naive; // clean cut, no partial entity to repair
  const safeBody = body.slice(0, dangling.index);
  const hidden = text.length - safeBody.length;
  return `${safeBody} … [+${hidden} chars truncated]`;
}

/** Slack section/context text: converted to Slack's mrkdwn flavor, then sanitized so raw
 *  `<!channel>`/`<@U…>`-shaped sequences from the wire (a hostile summary/question/label) cannot
 *  survive as a live broadcast or user mention once Slack parses the message. Clamped through
 *  `clampBalanced` (discord/messageChunks.ts) rather than a blind slice, so a `` ``` `` fence
 *  opened by wire-sourced text (a fenced `detail`, most often) can never end unterminated and
 *  swallow the rest of the card into a code block. */
function mrkdwnText(
  raw: string,
  max: number = SLACK_LIMITS.SECTION_TEXT_MAX,
): SlackBlockTypes.MrkdwnElement {
  // toMrkdwn already sanitizes internally (see slackFormat.ts's module doc) — wrapping it in a
  // second sanitizeSlackText call would double-escape (`&` -> `&amp;` -> `&amp;amp;`).
  const safe = toMrkdwn(raw);
  return { type: 'mrkdwn', text: clampBalanced(safe, max, truncateEntitySafe) };
}

/** Cap a card's block list at Slack's per-message ceiling (default
 *  {@link SLACK_LIMITS.BLOCKS_PER_MESSAGE_MAX}), replacing whatever would overflow with one
 *  visible "N omitted" marker rather than letting `chat.postMessage`/`chat.update` reject the
 *  call outright. Exported so the budget itself is unit-testable without needing to contrive a
 *  request that legitimately produces 50+ blocks. */
export function withBlockBudget(
  blocks: KnownBlock[],
  max: number = SLACK_LIMITS.BLOCKS_PER_MESSAGE_MAX,
): KnownBlock[] {
  if (blocks.length <= max) return blocks;
  const omitted = blocks.length - (max - 1);
  const marker: KnownBlock = {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `_… ${omitted} block${omitted === 1 ? '' : 's'} omitted (${max}-block limit)_`,
      },
    ],
  };
  return [...blocks.slice(0, max - 1), marker];
}

/** Rebuild a card's header block with a new title, for lapse edits — the Slack analog of
 *  `EmbedBuilder.from(original).setTitle(...)`. Prepends a header if the stored blocks
 *  (unexpectedly) don't start with one, so a lapse edit can never silently lose its heading. */
function withHeaderTitle(blocks: KnownBlock[], title: string): KnownBlock[] {
  const [first, ...rest] = blocks;
  if (first && first.type === 'header') {
    return [{ ...first, text: plainText(title, 150) }, ...rest];
  }
  return [{ type: 'header', text: plainText(title, 150) }, ...blocks];
}

/** Map a Discord ButtonSpec (from buttons.ts) to a Slack Button element, reusing its `customId`
 *  verbatim as the Slack `action_id` — this is the whole point of sharing buttons.ts: the SAME
 *  string round-trips through `resolveTap`/`decodeButton` regardless of which surface sent it.
 *  Slack's ColorScheme only has `primary`/`danger` (no `secondary`/`success` distinction), so
 *  Discord's `success` collapses onto `primary` and `secondary` gets no `style` (Slack's default
 *  neutral look). */
function toSlackButton(spec: ButtonSpec): SlackBlockTypes.Button {
  return {
    type: 'button',
    action_id: spec.customId,
    text: plainText(spec.label, 75),
    ...(spec.style === 'danger' ? { style: 'danger' as const } : {}),
    ...(spec.style === 'success' || spec.style === 'primary' ? { style: 'primary' as const } : {}),
  };
}

function actionsBlockFrom(rows: ButtonSpec[][]): KnownBlock {
  return { type: 'actions', elements: rows.flat().map(toSlackButton) };
}

// ---------------------------------------------------------------------------
// Permission cards
// ---------------------------------------------------------------------------

const PERMISSION_LAPSE_TITLE: Record<PayloadOf<'permission.lapsed'>['reason'], string> = {
  local: 'Handled at the terminal',
  expired: 'Expired — answer at the terminal',
  shutdown: 'Daemon stopped',
};

/** The non-actions blocks of a permission card. Mirrors embeds.ts's buildPermissionRequestEmbed:
 *  title, summary, optional unbounded detail, a footer note naming the mode when non-default. */
function buildPermissionInfoBlocks(p: PayloadOf<'permission.request'>): KnownBlock[] {
  const mode = p.permissionMode ?? undefined;
  const modeNote = mode !== undefined && mode !== 'default' ? ` · ${mode} mode` : '';
  const blocks: KnownBlock[] = [
    { type: 'header', text: plainText('Permission requested', 150) },
    { type: 'section', text: mrkdwnText(p.summary) },
  ];
  if (p.detail) {
    blocks.push({ type: 'section', text: mrkdwnText(`*Detail*\n${p.detail}`) });
  }
  blocks.push({ type: 'context', elements: [mrkdwnText(`Approve or Deny below${modeNote}`, 150)] });
  return blocks;
}

async function postPermissionCard(
  ctx: SlackContext,
  state: SlackCardState,
  slackUserId: string,
  p: PayloadOf<'permission.request'>,
): Promise<void> {
  const info = buildPermissionInfoBlocks(p);
  const actions = actionsBlockFrom(permissionButtons({ requestId: p.requestId }));
  const channel = await ctx.openDm(slackUserId);
  try {
    const res = await ctx.web.chat.postMessage({
      channel,
      text: mrkdwnText(p.summary, 150).text,
      blocks: withBlockBudget([...info, actions]),
    });
    if (res.ok && res.ts) {
      state.permissionCards.record(p.requestId, { channelId: channel, messageId: res.ts });
      state.cardBlocks.set(p.requestId, info);
    }
  } catch (err) {
    ctx.logger.warn({ err, slackUserId }, 'slack: failed to post a permission card');
  }
}

/** `permission.lapsed`: edit the ORIGINAL card in place — keep its info blocks, swap the header
 *  title for the lapse reason, drop the actions row. An untracked requestId (bot restart, evicted
 *  from the bounded map, or a card already resolved) is a no-op: logged, never thrown, and never
 *  re-sent as a new message the reader can no longer act on anyway. */
async function applyPermissionLapse(
  ctx: SlackContext,
  state: SlackCardState,
  payload: PayloadOf<'permission.lapsed'>,
): Promise<void> {
  const ref = state.permissionCards.take(payload.requestId);
  const info = state.cardBlocks.get(payload.requestId);
  state.cardBlocks.delete(payload.requestId);
  if (!ref) {
    ctx.logger.debug(
      { requestId: payload.requestId },
      'slack: permission.lapsed for a card this bot never tracked (restart, or already evicted)',
    );
    return;
  }
  const title = PERMISSION_LAPSE_TITLE[payload.reason];
  try {
    await ctx.web.chat.update({
      channel: ref.channelId,
      ts: ref.messageId,
      text: title,
      blocks: withBlockBudget(withHeaderTitle(info ?? [], title)),
    });
  } catch (err) {
    ctx.logger.warn(
      { err, requestId: payload.requestId },
      'slack: failed to edit a lapsed permission card',
    );
  }
}

// ---------------------------------------------------------------------------
// Question cards
// ---------------------------------------------------------------------------

const QUESTION_LAPSE_TITLE: Record<PayloadOf<'question.lapsed'>['reason'], string> = {
  local: 'Answered at the terminal',
  expired: 'Expired — continuing without answers',
  shutdown: 'Daemon stopped',
};

/** Most listed options rendered as a row of buttons before falling back to a `static_select` — a
 *  handful of buttons is more glanceable/tappable on a phone than opening a picker, but a wide
 *  Actions block of buttons stops being readable well before Slack's 25-element hard cap. */
const BUTTON_OPTION_THRESHOLD = 5;

/** Local-only grammar for the multi-select "Submit" button. Not part of the shared `cc:` grammar
 *  (buttons.ts/questionCards.ts have no submit action of their own — a multi-select's own
 *  selection-change event must NOT auto-finalize a still-partial answer the way a single-select
 *  tap does), so this is this module's own small, round-trippable encoding. */
const SUBMIT_PREFIX = 'sb:qsubmit';

function encodeSubmit(requestId: string, qIndex: number): string {
  return [SUBMIT_PREFIX, requestId, qIndex].join(':');
}

function decodeSubmit(actionId: string): { requestId: string; qIndex: number } | null {
  if (!actionId.startsWith(`${SUBMIT_PREFIX}:`)) return null;
  const rest = actionId.slice(SUBMIT_PREFIX.length + 1);
  const parts = rest.split(':');
  if (parts.length < 2) return null;
  const qIndexRaw = parts[parts.length - 1];
  const qIndex = Number(qIndexRaw);
  if (!Number.isInteger(qIndex) || qIndex < 0) return null;
  const requestId = parts.slice(0, -1).join(':');
  if (requestId.length === 0) return null;
  return { requestId, qIndex };
}

// `description` mirrors the protocol's own optional-AND-nullable field: under
// exactOptionalPropertyTypes an absent key and an explicit `undefined` are different types, and
// question payloads decoded off the wire can present either.
type QuestionOption = { label: string; description?: string | null | undefined };

function optionButton(
  requestId: string,
  qIndex: number,
  optionIndex: number,
  labelRaw: string,
): SlackBlockTypes.Button {
  return {
    type: 'button',
    action_id: encodeQuestionSelect(requestId, qIndex),
    value: encodeOptionValue(optionIndex),
    text: plainText(labelRaw, 75),
  };
}

function toPlainTextOption(
  o: QuestionOption,
  index: number,
): {
  text: SlackBlockTypes.PlainTextElement;
  value: string;
  description?: SlackBlockTypes.PlainTextElement;
} {
  return {
    text: plainText(o.label, 75),
    value: encodeOptionValue(index),
    ...(o.description != null && o.description.length > 0
      ? { description: plainText(o.description, 75) }
      : {}),
  };
}

function staticSelectFor(
  requestId: string,
  qIndex: number,
  options: QuestionOption[],
  placeholderRaw: string,
): SlackBlockTypes.StaticSelect {
  return {
    type: 'static_select',
    action_id: encodeQuestionSelect(requestId, qIndex),
    placeholder: plainText(placeholderRaw, 150),
    options: options.map(toPlainTextOption),
  };
}

function multiStaticSelectFor(
  requestId: string,
  qIndex: number,
  options: QuestionOption[],
  placeholderRaw: string,
): SlackBlockTypes.MultiStaticSelect {
  return {
    type: 'multi_static_select',
    action_id: encodeQuestionSelect(requestId, qIndex),
    placeholder: plainText(placeholderRaw, 150),
    options: options.map(toPlainTextOption),
  };
}

function submitButtonFor(requestId: string, qIndex: number): SlackBlockTypes.Button {
  return {
    type: 'button',
    action_id: encodeSubmit(requestId, qIndex),
    text: plainText('Submit', 75),
    style: 'primary',
  };
}

/** One question's controls block: buttons for a short single-select list, a `static_select` once
 *  the option count outgrows a button row, or a `multi_static_select` + explicit Submit for a
 *  multi-select question (see {@link SUBMIT_PREFIX} for why multi-select needs the extra tap). */
function buildQuestionControlsBlock(
  requestId: string,
  qIndex: number,
  multiSelect: boolean,
  options: QuestionOption[],
  placeholderRaw: string,
): KnownBlock {
  if (multiSelect) {
    return {
      type: 'actions',
      elements: [
        multiStaticSelectFor(requestId, qIndex, options, placeholderRaw),
        submitButtonFor(requestId, qIndex),
      ],
    };
  }
  if (options.length <= BUTTON_OPTION_THRESHOLD) {
    return {
      type: 'actions',
      elements: options.map((o, i) => optionButton(requestId, qIndex, i, o.label)),
    };
  }
  return {
    type: 'actions',
    elements: [staticSelectFor(requestId, qIndex, options, placeholderRaw)],
  };
}

async function postQuestionCard(
  ctx: SlackContext,
  state: SlackCardState,
  slackUserId: string,
  p: PayloadOf<'question.request'>,
): Promise<void> {
  // Clamped identically to questionCards.ts's own registration clamp (MAX_QUESTIONS/MAX_OPTIONS)
  // so the collector's indices always line up with what actually renders.
  const questions = p.questions.slice(0, MAX_QUESTIONS);
  const mode = p.permissionMode ?? undefined;
  const modeNote = mode !== undefined && mode !== 'default' ? ` · ${mode} mode` : '';
  const title = questions.length <= 1 ? 'Claude has a question' : 'Claude has questions';
  const info: KnownBlock[] = [{ type: 'header', text: plainText(title, 150) }];
  const controls: KnownBlock[] = [];
  questions.forEach((q, qIndex) => {
    const label = q.header != null && q.header.length > 0 ? q.header : `Question ${qIndex + 1}`;
    info.push({ type: 'section', text: mrkdwnText(`*${label}*\n${q.question}`) });
    const options = q.options.slice(0, MAX_OPTIONS);
    controls.push(buildQuestionControlsBlock(p.requestId, qIndex, q.multiSelect, options, label));
  });
  info.push({
    type: 'context',
    elements: [mrkdwnText(`Answer with the controls below${modeNote}`, 150)],
  });
  const channel = await ctx.openDm(slackUserId);
  try {
    const res = await ctx.web.chat.postMessage({
      channel,
      text: title,
      blocks: withBlockBudget([...info, ...controls]),
    });
    if (res.ok && res.ts) {
      state.questionCards.record(p.requestId, { channelId: channel, messageId: res.ts });
      state.cardBlocks.set(p.requestId, info);
      state.questionAnswers.register(p.requestId, p.questions);
    }
  } catch (err) {
    ctx.logger.warn({ err, slackUserId }, 'slack: failed to post a question card');
  }
}

/** `question.lapsed`: same shape as {@link applyPermissionLapse}, plus forgetting any
 *  partially-accumulated answers so a stray late select/submit for this card finds nothing. */
async function applyQuestionLapse(
  ctx: SlackContext,
  state: SlackCardState,
  payload: PayloadOf<'question.lapsed'>,
): Promise<void> {
  const ref = state.questionCards.take(payload.requestId);
  state.questionAnswers.forget(payload.requestId);
  const info = state.cardBlocks.get(payload.requestId);
  state.cardBlocks.delete(payload.requestId);
  if (!ref) {
    ctx.logger.debug(
      { requestId: payload.requestId },
      'slack: question.lapsed for a card this bot never tracked (restart, or already evicted)',
    );
    return;
  }
  const title = QUESTION_LAPSE_TITLE[payload.reason];
  try {
    await ctx.web.chat.update({
      channel: ref.channelId,
      ts: ref.messageId,
      text: title,
      blocks: withBlockBudget(withHeaderTitle(info ?? [], title)),
    });
  } catch (err) {
    ctx.logger.warn(
      { err, requestId: payload.requestId },
      'slack: failed to edit a lapsed question card',
    );
  }
}

function buildAnsweredQuestionBlocks(
  answers: PayloadOf<'question.response'>['answers'],
): KnownBlock[] {
  const blocks: KnownBlock[] = [{ type: 'header', text: plainText('Answered', 150) }];
  for (const answer of answers) {
    const lines = answer.selected.map((label) => `• ${label}`);
    if (answer.otherText != null && answer.otherText.length > 0)
      lines.push(`✏️ ${answer.otherText}`);
    blocks.push({
      type: 'section',
      text: mrkdwnText(
        `*${answer.question}*\n${lines.length > 0 ? lines.join('\n') : '(no selection)'}`,
      ),
    });
  }
  return blocks;
}

/** What attempting to finalize a question card produced — the caller (a select or a Submit tap)
 *  turns this into the one ephemeral reply the tapper sees. */
type FinalizeResult =
  | { kind: 'incomplete' }
  | { kind: 'gone' }
  | { kind: 'duplicate' }
  | { kind: 'error'; message: string }
  | { kind: 'sent' };

/** Mirrors discordJsGateway's `finalizeQuestion` precisely: record is already done by the caller;
 *  this only decides completeness and, once every question is answered, relays the response and
 *  marks the card answered. Incomplete is the COMMON case for every non-final tap (mirrors
 *  Discord's silent `deferUpdate`) — the collector, not this function, is the single source of
 *  truth for "done", so a multi-select's own change events can freely call this without risking an
 *  early relay. */
async function finalizeQuestionIfComplete(
  ctx: SlackContext,
  state: SlackCardState,
  client: SlackWebClient,
  requestId: string,
  slackUserId: string,
): Promise<FinalizeResult> {
  const count = state.questionAnswers.expectedCount(requestId);
  if (count === undefined) return { kind: 'gone' };
  if (!state.questionAnswers.isComplete(requestId, count)) return { kind: 'incomplete' };
  const dedupeKey = questionSubmitDedupeKey(slackUserId, requestId);
  if (!state.seenKeys.markIfNew(dedupeKey)) return { kind: 'duplicate' };
  const ref = state.questionCards.get(requestId);
  if (!ref) return { kind: 'gone' };
  const answers = state.questionAnswers.answersOf(requestId);
  const deps: CommandDeps = { relay: ctx.relay, pairing: ctx.pairing, cache: ctx.cache };
  const principal = ctx.principalOf(slackUserId);
  const result = handleQuestionAnswer(deps, principal, {
    requestId,
    answers,
    idempotencyKey: questionIdempotencyKey(requestId),
  });
  if (result.kind === 'error') {
    // Daemon offline / relay failure: roll back the dedupe mark so a retry once it returns is not
    // swallowed as a duplicate, and leave the card + accumulated answers untouched.
    state.seenKeys.forget(dedupeKey);
    return { kind: 'error', message: result.message };
  }
  // Consume the card and its state right away (before the network edit), so a concurrent second
  // completion sees no ref and bails instead of relaying/editing twice.
  state.questionCards.take(requestId);
  state.questionAnswers.forget(requestId);
  state.cardBlocks.delete(requestId);
  try {
    await client.chat.update({
      channel: ref.channelId,
      ts: ref.messageId,
      text: 'Answered',
      blocks: withBlockBudget(buildAnsweredQuestionBlocks(answers)),
    });
  } catch (err) {
    ctx.logger.warn({ err, requestId }, 'slack: failed to edit an answered question card');
  }
  return { kind: 'sent' };
}

// ---------------------------------------------------------------------------
// deliverCard
// ---------------------------------------------------------------------------

/** SlackGateway.deliver's card path — the Slack analog of `renderPush` + the card-sending half of
 *  discordJsGateway's `deliver()`. Owns exactly the same envelope kinds Discord's card surface
 *  owns (permission.request/lapsed, question.request/lapsed); everything else returns `false` so
 *  the gateway's dispatch chain falls through to the next handler (session delivery, built-ins,
 *  plain-text fallback — see context.ts's module comment on deliver() ordering). */
export async function deliverCard(
  ctx: SlackContext,
  slackUserId: string,
  envelope: Envelope,
): Promise<boolean> {
  const state = stateFor(ctx);
  if (isType(envelope, 'permission.request')) {
    await postPermissionCard(ctx, state, slackUserId, envelope.payload);
    return true;
  }
  if (isType(envelope, 'permission.lapsed')) {
    await applyPermissionLapse(ctx, state, envelope.payload);
    return true;
  }
  if (isType(envelope, 'question.request')) {
    await postQuestionCard(ctx, state, slackUserId, envelope.payload);
    return true;
  }
  if (isType(envelope, 'question.lapsed')) {
    await applyQuestionLapse(ctx, state, envelope.payload);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// registerSlackInteractivity
// ---------------------------------------------------------------------------

/** Extract the reply text a command handler wants shown, for the three shapes handleApprove /
 *  handleDeny / handleQuestionAnswer actually return (`text` on success, `error` on failure —
 *  they never return `embed`, but the switch stays exhaustive against CommandResult's full union
 *  so a future handler change can't silently fall through here). */
function commandReplyText(result: CommandResult): string {
  switch (result.kind) {
    case 'text':
      return result.text;
    case 'error':
      return `Error: ${result.message}`;
    case 'embed':
      return 'Done.';
  }
}

/** Fire-and-log a fallible Slack API call from inside an already-acked listener. A tapped card's
 *  message can be gone (deleted) or its `response_url` past its ~30-minute expiry by the time this
 *  runs; in Bolt v5 letting that rejection escape a listener routes it to `app.error`, which the
 *  gateway (see slackGateway.ts) treats as a connection failure and restarts the socket for the
 *  WHOLE workspace over what is, to every other user in it, a no-op. Mirrors the try/catch
 *  `finalizeQuestionIfComplete` already wraps its own `chat.update` call in. */
async function guarded(
  ctx: SlackContext,
  label: string,
  fn: () => Promise<unknown>,
): Promise<void> {
  try {
    await fn();
  } catch (err) {
    ctx.logger.warn({ err }, `slack: ${label}`);
  }
}

async function finalizeAndRespond(
  ctx: SlackContext,
  state: SlackCardState,
  client: SlackWebClient,
  respond: (
    message: string | { text: string; response_type?: 'ephemeral' | 'in_channel' },
  ) => Promise<unknown>,
  requestId: string,
  slackUserId: string,
): Promise<void> {
  const outcome = await finalizeQuestionIfComplete(ctx, state, client, requestId, slackUserId);
  const reply = (text: string): Promise<void> =>
    guarded(ctx, 'failed to reply to a question-card tap', () =>
      respond({ response_type: 'ephemeral', text }),
    );
  switch (outcome.kind) {
    case 'incomplete':
      // Quiet — mirrors Discord's `interaction.deferUpdate()`: the card keeps its remaining
      // controls, no reply needed for a partial pick.
      return;
    case 'gone':
      await reply('This question is no longer active.');
      return;
    case 'duplicate':
      await reply('Already answered.');
      return;
    case 'error':
      await reply(`Error: ${outcome.message}`);
      return;
    case 'sent':
      await reply('Answer sent to the session.');
      return;
  }
}

/** SlackGateway's `block_actions` router. Registers three narrow action-id patterns — approve/deny
 *  buttons, question selects, and this module's own submit button — so it never intercepts a
 *  sibling surface's `cc:switch`/`cc:stop`/`cc:prune` session-card actions, which reuse the same
 *  `cc:` grammar but belong to a different card owner. Every branch acks first (Slack's 3s budget),
 *  decodes through the reused Discord grammar, and — for a terminal action — `chat.update`s the
 *  card to its resolved rendering (info blocks with the actions row stripped), exactly mirroring
 *  discordJsGateway's `interaction.update({ components: [] })`.
 *
 *  Each listener binds `BlockAction<…>` explicitly. Left unbound, Bolt widens `body`/`action` to
 *  the whole `SlackAction` union, which still includes the legacy attachment-based
 *  interactive-message shape — and that shape carries neither `action_id` nor `message`, so a
 *  Block Kit card's own fields stop type-checking. Binding the generic states the payload family
 *  these listeners actually receive rather than runtime-narrowing a case that cannot arrive. */
export function registerSlackInteractivity(app: App, ctx: SlackContext): void {
  const state = stateFor(ctx);

  app.action<BlockAction<ButtonAction>>(
    /^cc:(approve|deny):/,
    async ({ ack, action, body, client, respond }) => {
      await ack();
      if (action.type !== 'button') return;
      const parsed = decodeButton(action.action_id);
      if (!parsed) return;
      const channel = body.channel?.id;
      const ts = body.message?.ts;
      const slackUserId = body.user.id;
      if (channel === undefined || ts === undefined) {
        ctx.logger.warn(
          { actionId: action.action_id },
          'slack: permission action with no source message',
        );
        return;
      }
      const info = state.cardBlocks.get(parsed.id) ?? [];
      const outcome = resolveTap(action.action_id, Date.now());
      // A tapped card's message can be gone or its response_url expired between the tap landing
      // and here; both helpers route through `guarded` so neither call can escape this listener
      // as an unhandled rejection (see `guarded`'s doc comment for why that matters in Bolt v5).
      const reply = (text: string): Promise<void> =>
        guarded(ctx, 'failed to reply to an approve/deny tap', () =>
          respond({ response_type: 'ephemeral', text }),
        );
      const updateCard = (text: string, blocks: KnownBlock[]): Promise<void> =>
        guarded(ctx, 'failed to update a permission card after a tap', () =>
          client.chat.update({ channel, ts, text, blocks: withBlockBudget(blocks) }),
        );
      switch (outcome.kind) {
        case 'ignore':
          await reply(`Error: ${outcome.reason}`);
          return;
        case 'confirm':
          await updateCard(outcome.note, [...info, actionsBlockFrom(outcome.rows)]);
          return;
        case 'restore':
          await updateCard(outcome.note, [...info, actionsBlockFrom(outcome.rows)]);
          await reply(outcome.note);
          return;
        case 'execute': {
          // The `cc:(approve|deny):` constraint guarantees this, but the branch is defensive rather
          // than a cast — decodeButton's ButtonAction union is wider than what this listener owns.
          if (outcome.action !== 'approve' && outcome.action !== 'deny') return;
          const key = buttonIdempotencyKey(slackUserId, outcome);
          if (!state.seenKeys.markIfNew(key)) {
            await reply('Already handled.');
            return;
          }
          const deps: CommandDeps = { relay: ctx.relay, pairing: ctx.pairing, cache: ctx.cache };
          const principal = ctx.principalOf(slackUserId);
          const scope: 'once' | 'session' = outcome.scope === 'session' ? 'session' : 'once';
          const result =
            outcome.action === 'approve'
              ? handleApprove(deps, principal, outcome.id, scope, key)
              : handleDeny(deps, principal, outcome.id, scope, key);
          // Terminal: strip the actions row regardless of outcome — a card that already resolved
          // must never claim its buttons still work.
          await updateCard('Resolved', info);
          await reply(commandReplyText(result));
          return;
        }
      }
    },
  );

  app.action<BlockAction<ButtonAction | StaticSelectAction | MultiStaticSelectAction>>(
    /^cc:qans:/,
    async ({ ack, action, body, client, respond }) => {
      await ack();
      if (
        action.type !== 'button' &&
        action.type !== 'static_select' &&
        action.type !== 'multi_static_select'
      ) {
        return;
      }
      const decoded = decodeQuestionSelect(action.action_id);
      if (!decoded) return;
      const slackUserId = body.user.id;
      if (state.questionAnswers.expectedCount(decoded.requestId) === undefined) {
        await guarded(ctx, 'failed to reply to a stale question-card select', () =>
          respond({ response_type: 'ephemeral', text: 'This question is no longer active.' }),
        );
        return;
      }
      const values: string[] =
        action.type === 'button'
          ? [action.value].filter((v): v is string => v !== undefined && v.length > 0)
          : action.type === 'static_select'
            ? [action.selected_option.value]
            : action.selected_options.map((o) => o.value);
      state.questionAnswers.setSelection(decoded.requestId, decoded.qIndex, values);
      if (action.type === 'multi_static_select') return; // waits for the explicit Submit tap below
      await finalizeAndRespond(ctx, state, client, respond, decoded.requestId, slackUserId);
    },
  );

  app.action<BlockAction<ButtonAction>>(
    /^sb:qsubmit:/,
    async ({ ack, action, body, client, respond }) => {
      await ack();
      if (action.type !== 'button') return;
      const decoded = decodeSubmit(action.action_id);
      if (!decoded) return;
      await finalizeAndRespond(ctx, state, client, respond, decoded.requestId, body.user.id);
    },
  );
}
