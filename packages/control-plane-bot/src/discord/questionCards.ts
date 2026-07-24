// The AskUserQuestion card's pure machinery: the requestId→message registry, the partial-answer
// accumulator, and the customId / select-value grammar. Everything a question card needs to
// DECIDE is here, discord.js-free and unit-testable; discordJsGateway is left to inflate the
// specs into real select menus / modals and perform the sends and edits.
//
// Shape mirrors the permission card surface (permissionCards.ts + buttons.ts) deliberately: same
// bounded FIFO registry, same `cc:<action>:<phase>:<scope>:<ts>:<id>` customId grammar (new
// actions `qans`/`qother`), so the two answerable-card surfaces read the same and neither invents
// a parallel scheme.

import type { PayloadOf } from '@claude-control/shared-protocol';

/** A card's location, same plain {channelId, messageId} the permission registry stores — a live
 *  discord.js Message would not survive the map's lifetime reasoning (see permissionCards.ts). */
export interface CardRef {
  channelId: string;
  messageId: string;
}

/** Hard ceiling on retained entries in both the registry and the collector. Same rationale and
 *  value as PermissionCardRegistry: the live set is bounded by concurrent held questions, not by
 *  total questions ever asked, so a FIFO cap this size never evicts a card still being answered. */
const MAX_ENTRIES = 64;

/** discord.js hard cap on a customId. A question customId is `cc:qans:go:na:0:<requestId>:<qIndex>`
 *  — with a UUID requestId ~54 chars, comfortably under this — but the constant documents the
 *  ceiling for reviewers, exactly like buttons.ts's CUSTOM_ID_MAX. */
export const CUSTOM_ID_MAX = 100;

/** Most questions AskUserQuestion can pose in one call; the tool's own contract caps at 4 and a
 *  Discord message holds at most 5 action rows, so 4 select menus (one per question) always fit.
 *  Oversized frames are CLAMPED to this, never rejected — a dropped card would strand the session
 *  on the hold until it lapses. */
export const MAX_QUESTIONS = 4;

/** Most listed options a single select renders, leaving room for the trailing "Other" entry
 *  inside Discord's 25-option-per-menu limit. Extra options are dropped (not rejected) for the
 *  same never-strand-the-session reason as MAX_QUESTIONS. */
export const MAX_OPTIONS = 24;

/** The sentinel select value that means "the free-text Other choice" rather than a listed option.
 *  Listed options carry their INDEX as their value (labels can exceed Discord's 100-char value
 *  limit; indices are short and stable within a card), so this cannot collide with one. */
export const OTHER_VALUE = '__other__';

/** The single text input's customId inside the Other modal — the key the gateway reads the typed
 *  answer back out under. */
export const QUESTION_MODAL_INPUT_ID = 'answer';

const PREFIX = 'cc';
const SEP = ':';
const SELECT_ACTION = 'qans';
const MODAL_ACTION = 'qother';

// Discord component text ceilings the specs are clamped to, so a long question or option can never
// make discord.js reject the whole message at build time.
const PLACEHOLDER_MAX = 150;
const OPTION_LABEL_MAX = 100;
const OPTION_DESC_MAX = 100;

/** The questions payload as the wire delivers it, and the wire answer shape the collector emits —
 *  aliased so this module names the exact protocol types without re-declaring them. */
type WireQuestions = PayloadOf<'question.request'>['questions'];
type WireAnswers = PayloadOf<'question.response'>['answers'];

// ---------------------------------------------------------------------------
// customId + select-value grammar (pure, round-trippable)
// ---------------------------------------------------------------------------

/** A decoded question customId: which held request, and which of its questions the interaction is
 *  for. `requestId` may itself contain the delimiter (it is rejoined from the middle segments,
 *  exactly like buttons.ts rebuilds its trailing id). */
export interface ParsedQuestionId {
  requestId: string;
  qIndex: number;
}

/** Encode a select customId for question `qIndex` of `requestId`. Field layout matches the button
 *  grammar (prefix : action : phase : scope : ts : id…) so both surfaces share one shape; the
 *  trailing segments carry `requestId` then `qIndex`, and `requestId` goes BEFORE the fixed-width
 *  `qIndex` so a `:` inside it survives the round trip. */
export function encodeQuestionSelect(requestId: string, qIndex: number): string {
  return [PREFIX, SELECT_ACTION, 'go', 'na', 0, requestId, qIndex].join(SEP);
}

/** Encode the modal customId for the Other free-text answer to question `qIndex` of `requestId`. */
export function encodeQuestionModal(requestId: string, qIndex: number): string {
  return [PREFIX, MODAL_ACTION, 'go', 'na', 0, requestId, qIndex].join(SEP);
}

/** Decode a `qans` select customId, or `null` for anything that isn't one of ours / is malformed.
 *  `requestId` is the segments between the fixed header and the trailing `qIndex`, rejoined, so an
 *  id containing `:` round-trips. */
export function decodeQuestionSelect(customId: string): ParsedQuestionId | null {
  return decodeQuestionId(customId, SELECT_ACTION);
}

/** Decode a `qother` modal customId, same rules as {@link decodeQuestionSelect}. */
export function decodeQuestionModal(customId: string): ParsedQuestionId | null {
  return decodeQuestionId(customId, MODAL_ACTION);
}

function decodeQuestionId(customId: string, action: string): ParsedQuestionId | null {
  const parts = customId.split(SEP);
  // cc : action : go : na : ts : <requestId…> : qIndex → at least 7 segments.
  if (parts.length < 7) return null;
  if (parts[0] !== PREFIX || parts[1] !== action || parts[2] !== 'go' || parts[3] !== 'na') {
    return null;
  }
  const qIndexRaw = parts[parts.length - 1];
  const qIndex = Number(qIndexRaw);
  if (!Number.isInteger(qIndex) || qIndex < 0) return null;
  // Everything between the fixed header (indices 0–4) and the trailing qIndex is the requestId.
  const requestId = parts.slice(5, parts.length - 1).join(SEP);
  if (requestId.length === 0) return null;
  return { requestId, qIndex };
}

/** The select `value` for listed option `optionIndex` — its index as a string, so a label longer
 *  than Discord's 100-char value limit can never overflow it. */
export function encodeOptionValue(optionIndex: number): string {
  return String(optionIndex);
}

// ---------------------------------------------------------------------------
// Select render spec (plain data the gateway inflates into a StringSelectMenu)
// ---------------------------------------------------------------------------

/** One option row inside a select — plain data, no discord.js. */
export interface SelectOptionSpec {
  label: string;
  value: string;
  description?: string;
}

/** One select menu as plain data, the render struct the gateway turns into a StringSelectMenu
 *  in its own ActionRow (a select occupies a whole row). `minValues`/`maxValues` encode single-
 *  vs multi-select: single is 1/1, multi is 1/(option count). */
export interface SelectSpec {
  customId: string;
  placeholder: string;
  minValues: number;
  maxValues: number;
  options: SelectOptionSpec[];
}

function clamp(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

/** Build one select spec per question (clamped to MAX_QUESTIONS), each carrying its listed options
 *  (clamped to MAX_OPTIONS) plus the trailing "✏️ Other…" entry that opens the free-text modal.
 *  Pure and total: an oversized frame is silently clamped here (this module has no logger and must
 *  never throw — the daemon already caps questions at 4), so a malformed request degrades to a
 *  renderable card rather than crashing the push. */
export function questionSelectSpecs(requestId: string, questions: WireQuestions): SelectSpec[] {
  return questions.slice(0, MAX_QUESTIONS).map((q, qIndex) => {
    const listed: SelectOptionSpec[] = q.options.slice(0, MAX_OPTIONS).map((o, i) => ({
      label: clamp(o.label, OPTION_LABEL_MAX),
      value: encodeOptionValue(i),
      ...(o.description != null && o.description.length > 0
        ? { description: clamp(o.description, OPTION_DESC_MAX) }
        : {}),
    }));
    const options: SelectOptionSpec[] = [...listed, { label: '✏️ Other…', value: OTHER_VALUE }];
    // Multi-select lets any subset (min 1) through; single-select forces exactly one. The Other
    // entry counts toward the max so a multi-select user can pick options AND Other together.
    const maxValues = q.multiSelect ? options.length : 1;
    return {
      customId: encodeQuestionSelect(requestId, qIndex),
      placeholder: clamp(
        q.header != null && q.header.length > 0 ? q.header : q.question,
        PLACEHOLDER_MAX,
      ),
      minValues: 1,
      maxValues,
      options,
    };
  });
}

// ---------------------------------------------------------------------------
// Registry: requestId → card location (bounded, one-shot on resolve)
// ---------------------------------------------------------------------------

/** Bounded requestId→CardRef map for question cards. Mirrors PermissionCardRegistry, with one
 *  addition: a non-consuming {@link get}. A question card is resolved (edited to its answered state
 *  and forgotten) only after the answer has actually been RELAYED — so the submit path must peek
 *  the ref, attempt the send, and consume only on success; an eager `take` would strand a card
 *  with no ref to edit if the daemon was offline. A lapse consumes with `take`, and a successful
 *  submit consumes with `take` too, so a spurious later lapse for an already-answered card finds
 *  nothing and is dropped. */
export class QuestionCardRegistry {
  // Map insertion order IS FIFO eviction order.
  private readonly byRequestId = new Map<string, CardRef>();

  /** Remember where a just-sent question card landed. Called once, right after the send. */
  record(requestId: string, ref: CardRef): void {
    if (this.byRequestId.size >= MAX_ENTRIES) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest !== undefined) this.byRequestId.delete(oldest);
    }
    this.byRequestId.set(requestId, ref);
  }

  /** Peek the ref without dropping it — the submit path needs the location BEFORE it knows the
   *  relay send succeeded, and must keep the card retryable if it did not. */
  get(requestId: string): CardRef | undefined {
    return this.byRequestId.get(requestId);
  }

  /** Look up and drop in one step — the consume step of a successful submit or a lapse. Returns
   *  `undefined` for a requestId this registry never saw (evicted, or a restart since the send);
   *  the caller drops that case silently. */
  take(requestId: string): CardRef | undefined {
    const ref = this.byRequestId.get(requestId);
    if (ref !== undefined) this.byRequestId.delete(requestId);
    return ref;
  }

  /** Current retained-entry count — exposed for tests and diagnostics. */
  size(): number {
    return this.byRequestId.size;
  }
}

// ---------------------------------------------------------------------------
// Collector: partial answers accumulated across a card's several selects/modals
// ---------------------------------------------------------------------------

/** One question's accumulating answer. `otherText` is mutable-optional (`string | undefined`, not
 *  `?:`) because it is reassigned in place — under exactOptionalPropertyTypes a `?:` field cannot
 *  be set to `undefined`. `pendingOther` guards the multi-select "Other picked but not yet typed"
 *  window: such a question is NOT complete even though `selected` may be non-empty, so the card
 *  waits for the modal instead of auto-submitting with the free-text answer missing. */
interface AnswerState {
  selected: string[];
  otherText: string | undefined;
  pendingOther: boolean;
}

interface CardState {
  /** Per question: the text (the wire answer key) and the listed option LABELS, clamped to the
   *  same MAX_QUESTIONS/MAX_OPTIONS the selects render, so a select value (an option index)
   *  resolves back to the label the daemon expects. */
  questions: { question: string; options: string[] }[];
  answers: AnswerState[];
}

/** Accumulates a card's answers across its several select/modal interactions until every question
 *  is answered, then hands back the wire `answers` array. Bounded like the registry so abandoned
 *  cards (picked at but never finished) cannot leak. Answers are keyed by question TEXT, captured
 *  at register time, because that is exactly the key the CLI's answer map wants — never an index. */
export class QuestionAnswerCollector {
  private readonly byRequestId = new Map<string, CardState>();

  /** Snapshot the questions of a just-sent card (clamped identically to the rendered selects, so
   *  indices line up) so later selects resolve option indices to labels and the final answers
   *  carry question text. */
  register(requestId: string, questions: WireQuestions): void {
    if (this.byRequestId.size >= MAX_ENTRIES) {
      const oldest = this.byRequestId.keys().next().value;
      if (oldest !== undefined) this.byRequestId.delete(oldest);
    }
    const clamped = questions.slice(0, MAX_QUESTIONS).map((q) => ({
      question: q.question,
      options: q.options.slice(0, MAX_OPTIONS).map((o) => o.label),
    }));
    this.byRequestId.set(requestId, {
      questions: clamped,
      answers: clamped.map(() => ({ selected: [], otherText: undefined, pendingOther: false })),
    });
  }

  /** How many questions this card expects an answer to — `undefined` once the card is unknown
   *  (never registered, evicted, or already consumed), which the gateway reads as "no longer
   *  active". */
  expectedCount(requestId: string): number | undefined {
    return this.byRequestId.get(requestId)?.questions.length;
  }

  /** Record a select's chosen values for one question. Values are option INDICES as strings plus
   *  possibly {@link OTHER_VALUE}: indices resolve to their labels, and the Other sentinel arms
   *  `pendingOther` (the modal that follows fills `otherText`). Re-selecting WITHOUT Other clears
   *  any stale free-text so a changed answer never carries an abandoned Other. Out-of-range indices
   *  and unknown requestIds are ignored — never thrown. */
  setSelection(requestId: string, qIndex: number, values: string[]): void {
    const answer = this.answerAt(requestId, qIndex);
    if (!answer) return;
    const options = this.byRequestId.get(requestId)?.questions[qIndex]?.options ?? [];
    let hasOther = false;
    const labels: string[] = [];
    for (const value of values) {
      if (value === OTHER_VALUE) {
        hasOther = true;
        continue;
      }
      const index = Number(value);
      const label = Number.isInteger(index) ? options[index] : undefined;
      if (label !== undefined) labels.push(label);
    }
    answer.selected = labels;
    answer.pendingOther = hasOther;
    if (!hasOther) answer.otherText = undefined;
  }

  /** Record the free-text Other answer from a modal submit. Clears `pendingOther` so the question
   *  now counts as complete. */
  setOther(requestId: string, qIndex: number, text: string): void {
    const answer = this.answerAt(requestId, qIndex);
    if (!answer) return;
    answer.otherText = text;
    answer.pendingOther = false;
  }

  /** True once every one of the card's `questionCount` questions is answered — a listed choice or
   *  a typed Other, and NOT waiting on a modal that Other opened. */
  isComplete(requestId: string, questionCount: number): boolean {
    const state = this.byRequestId.get(requestId);
    if (!state) return false;
    for (let i = 0; i < questionCount; i++) {
      const answer = state.answers[i];
      if (!answer || !isAnswered(answer)) return false;
    }
    return true;
  }

  /** Build the wire `answers` array WITHOUT consuming the card, so the gateway can attempt the
   *  relay send first and keep the card retryable if it fails. Order follows the questions; each
   *  answer carries its question text, the chosen labels, and the free-text when present (the
   *  daemon prefers `otherText` over `selected` when both exist). */
  answersOf(requestId: string): WireAnswers {
    const state = this.byRequestId.get(requestId);
    if (!state) return [];
    return state.questions.map((q, i) => {
      const answer = state.answers[i] ?? {
        selected: [],
        otherText: undefined,
        pendingOther: false,
      };
      return {
        question: q.question,
        selected: answer.selected,
        ...(answer.otherText !== undefined && answer.otherText.length > 0
          ? { otherText: answer.otherText }
          : {}),
      };
    });
  }

  /** {@link answersOf} plus consume — the successful-submit path. */
  takeAnswers(requestId: string): WireAnswers {
    const answers = this.answersOf(requestId);
    this.byRequestId.delete(requestId);
    return answers;
  }

  /** Drop a card's accumulated state without reading it — used when a lapse ends the card. */
  forget(requestId: string): void {
    this.byRequestId.delete(requestId);
  }

  /** Current retained-card count — exposed for tests and diagnostics. */
  size(): number {
    return this.byRequestId.size;
  }

  private answerAt(requestId: string, qIndex: number): AnswerState | undefined {
    return this.byRequestId.get(requestId)?.answers[qIndex];
  }
}

/** A question is answered when it has a listed choice or a typed Other AND is not still waiting on
 *  the Other modal. */
function isAnswered(answer: AnswerState): boolean {
  if (answer.pendingOther) return false;
  return (
    answer.selected.length > 0 || (answer.otherText !== undefined && answer.otherText.length > 0)
  );
}

// ---------------------------------------------------------------------------
// Dedupe / idempotency keys (mirrors buttonIdempotencyKey)
// ---------------------------------------------------------------------------

/** The bot-side dedupe key for a completed answer submit — per (user, requestId), so a
 *  double-completed card collapses to one send. Mirrors buttonIdempotencyKey's shape. */
export function questionSubmitDedupeKey(userId: string, requestId: string): string {
  return `qans:${userId}:${requestId}`;
}

/** The wire idempotencyKey carried on question.response, derived from the requestId so a resend
 *  (e.g. a retry after the daemon came back) is idempotent daemon-side as well. */
export function questionIdempotencyKey(requestId: string): string {
  return `qans:${requestId}`;
}
