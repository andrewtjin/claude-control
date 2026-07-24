import { describe, it, expect } from 'vitest';
import type { PayloadOf } from '@claude-control/shared-protocol';
import {
  QuestionCardRegistry,
  QuestionAnswerCollector,
  questionSelectSpecs,
  encodeQuestionSelect,
  encodeQuestionModal,
  decodeQuestionSelect,
  decodeQuestionModal,
  encodeOptionValue,
  questionSubmitDedupeKey,
  questionIdempotencyKey,
  OTHER_VALUE,
  CUSTOM_ID_MAX,
  MAX_QUESTIONS,
  MAX_OPTIONS,
} from './questionCards.js';

type WireQuestions = PayloadOf<'question.request'>['questions'];

/** Build a well-formed questions array so each test states only what matters. */
function questions(
  specs: { question: string; header?: string; multiSelect?: boolean; options: string[] }[],
): WireQuestions {
  return specs.map((s) => ({
    question: s.question,
    ...(s.header !== undefined ? { header: s.header } : {}),
    multiSelect: s.multiSelect ?? false,
    options: s.options.map((label) => ({ label })),
  }));
}

describe('QuestionCardRegistry', () => {
  it('get() peeks without dropping; take() returns then forgets', () => {
    const reg = new QuestionCardRegistry();
    reg.record('req-1', { channelId: 'c1', messageId: 'm1' });
    // get is non-consuming — the submit path peeks before it knows the relay send succeeded.
    expect(reg.get('req-1')).toEqual({ channelId: 'c1', messageId: 'm1' });
    expect(reg.get('req-1')).toEqual({ channelId: 'c1', messageId: 'm1' });
    expect(reg.size()).toBe(1);
    // take is one-shot — a successful submit or a lapse consumes it.
    expect(reg.take('req-1')).toEqual({ channelId: 'c1', messageId: 'm1' });
    expect(reg.take('req-1')).toBeUndefined();
    expect(reg.get('req-1')).toBeUndefined();
  });

  it('get()/take() on an unknown requestId return undefined — never throw', () => {
    const reg = new QuestionCardRegistry();
    expect(reg.get('nope')).toBeUndefined();
    expect(reg.take('nope')).toBeUndefined();
  });

  it('evicts the oldest entry once the cap is exceeded (bounded memory)', () => {
    const reg = new QuestionCardRegistry();
    for (let i = 0; i < 64; i++) reg.record(`req-${i}`, { channelId: 'c', messageId: `m${i}` });
    expect(reg.size()).toBe(64);
    reg.record('req-64', { channelId: 'c', messageId: 'm64' });
    expect(reg.size()).toBe(64);
    expect(reg.get('req-0')).toBeUndefined(); // oldest evicted
    expect(reg.get('req-64')).toEqual({ channelId: 'c', messageId: 'm64' });
  });
});

describe('question customId grammar', () => {
  it('round-trips select and modal ids, including a requestId containing the delimiter', () => {
    const rid = 'req:with:colons';
    expect(decodeQuestionSelect(encodeQuestionSelect(rid, 2))).toEqual({
      requestId: rid,
      qIndex: 2,
    });
    expect(decodeQuestionModal(encodeQuestionModal(rid, 0))).toEqual({
      requestId: rid,
      qIndex: 0,
    });
  });

  it('rejects the wrong action, foreign ids, and malformed ids as null', () => {
    // A modal decoder must reject a select id and vice-versa (the action segment differs).
    expect(decodeQuestionModal(encodeQuestionSelect('r', 0))).toBeNull();
    expect(decodeQuestionSelect(encodeQuestionModal('r', 0))).toBeNull();
    expect(decodeQuestionSelect('cc:approve:go:once:0:r')).toBeNull(); // a button id, not a question
    expect(decodeQuestionSelect('random')).toBeNull();
    expect(decodeQuestionSelect('cc:qans:go:na:0::3')).toBeNull(); // empty requestId
    expect(decodeQuestionSelect('cc:qans:go:na:0:r:notint')).toBeNull(); // bad qIndex
  });

  it('keeps a realistic max-size id under the customId ceiling', () => {
    // A UUID requestId plus the fixed header and a one-digit qIndex — the real worst case.
    const id = encodeQuestionSelect('3b35a35f-7f34-46ca-95a0-90258b142eb0', 3);
    expect(id.length).toBeLessThanOrEqual(CUSTOM_ID_MAX);
    expect(decodeQuestionSelect(id)).toEqual({
      requestId: '3b35a35f-7f34-46ca-95a0-90258b142eb0',
      qIndex: 3,
    });
  });
});

describe('questionSelectSpecs', () => {
  it('emits one select per question with indexed values and a trailing Other entry', () => {
    const specs = questionSelectSpecs(
      'req-1',
      questions([{ question: 'Pick one', options: ['Red', 'Green'] }]),
    );
    expect(specs).toHaveLength(1);
    const spec = specs[0]!;
    expect(spec.customId).toBe(encodeQuestionSelect('req-1', 0));
    expect(spec.placeholder).toBe('Pick one'); // no header → the question text
    // Values are option indices as strings, then the Other sentinel.
    expect(spec.options.map((o) => o.value)).toEqual(['0', '1', OTHER_VALUE]);
    expect(spec.options.map((o) => o.label)).toEqual(['Red', 'Green', '✏️ Other…']);
  });

  it('single-select is min/max 1; multi-select is min 1 / max = option count (incl. Other)', () => {
    const [single] = questionSelectSpecs('r', questions([{ question: 'q', options: ['a', 'b'] }]));
    expect(single).toMatchObject({ minValues: 1, maxValues: 1 });
    const [multi] = questionSelectSpecs(
      'r',
      questions([{ question: 'q', multiSelect: true, options: ['a', 'b'] }]),
    );
    // 2 listed + Other = 3 selectable.
    expect(multi).toMatchObject({ minValues: 1, maxValues: 3 });
  });

  it('prefers the header as the placeholder when present', () => {
    const [spec] = questionSelectSpecs(
      'r',
      questions([{ question: 'the long question text', header: 'Color', options: ['a'] }]),
    );
    expect(spec!.placeholder).toBe('Color');
  });

  it('clamps to 4 questions and 24 options (+Other) without throwing', () => {
    const many = questions(
      Array.from({ length: 6 }, (_, i) => ({
        question: `q${i}`,
        options: Array.from({ length: 30 }, (_, j) => `opt${j}`),
      })),
    );
    const specs = questionSelectSpecs('r', many);
    expect(specs).toHaveLength(MAX_QUESTIONS); // 6 → 4
    // 24 listed options + the Other entry = 25, Discord's per-menu ceiling.
    expect(specs[0]!.options).toHaveLength(MAX_OPTIONS + 1);
    expect(specs[0]!.options.at(-1)!.value).toBe(OTHER_VALUE);
  });
});

describe('QuestionAnswerCollector', () => {
  const twoQuestions = questions([
    { question: 'Which color?', options: ['Red', 'Green'] },
    { question: 'Which size?', multiSelect: true, options: ['S', 'M', 'L'] },
  ]);

  it('resolves option indices to labels and completes when every question is answered', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', twoQuestions);
    expect(c.expectedCount('r')).toBe(2);
    expect(c.isComplete('r', 2)).toBe(false);

    c.setSelection('r', 0, ['1']); // Green
    expect(c.isComplete('r', 2)).toBe(false); // second question still open
    c.setSelection('r', 1, ['0', '2']); // S, L
    expect(c.isComplete('r', 2)).toBe(true);

    expect(c.answersOf('r')).toEqual([
      { question: 'Which color?', selected: ['Green'] },
      { question: 'Which size?', selected: ['S', 'L'] },
    ]);
  });

  it('an Other-only single select is incomplete until the modal text arrives, then wins', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', questions([{ question: 'Which color?', options: ['Red'] }]));
    c.setSelection('r', 0, [OTHER_VALUE]); // picked Other, modal not submitted yet
    expect(c.isComplete('r', 1)).toBe(false); // pendingOther blocks completion
    c.setOther('r', 0, 'Teal');
    expect(c.isComplete('r', 1)).toBe(true);
    expect(c.answersOf('r')).toEqual([
      { question: 'Which color?', selected: [], otherText: 'Teal' },
    ]);
  });

  it('multi-select keeps both a listed choice AND the typed Other', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', questions([{ question: 'Which?', multiSelect: true, options: ['A', 'B'] }]));
    c.setSelection('r', 0, ['0', OTHER_VALUE]); // A + Other
    expect(c.isComplete('r', 1)).toBe(false); // still waiting on the Other text
    c.setOther('r', 0, 'custom');
    expect(c.isComplete('r', 1)).toBe(true);
    expect(c.answersOf('r')).toEqual([
      { question: 'Which?', selected: ['A'], otherText: 'custom' },
    ]);
  });

  it('re-selecting without Other drops a stale typed answer', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', questions([{ question: 'q', options: ['A', 'B'] }]));
    c.setSelection('r', 0, [OTHER_VALUE]);
    c.setOther('r', 0, 'stale');
    c.setSelection('r', 0, ['1']); // changed mind to a listed option, no Other
    expect(c.answersOf('r')).toEqual([{ question: 'q', selected: ['B'] }]);
  });

  it('takeAnswers returns the wire array and consumes; forget drops silently', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', questions([{ question: 'q', options: ['A'] }]));
    c.setSelection('r', 0, ['0']);
    expect(c.takeAnswers('r')).toEqual([{ question: 'q', selected: ['A'] }]);
    expect(c.expectedCount('r')).toBeUndefined(); // consumed
    expect(c.answersOf('r')).toEqual([]);

    c.register('r2', questions([{ question: 'q', options: ['A'] }]));
    c.forget('r2');
    expect(c.expectedCount('r2')).toBeUndefined();
  });

  it('ignores out-of-range indices and unknown requestIds without throwing', () => {
    const c = new QuestionAnswerCollector();
    c.register('r', questions([{ question: 'q', options: ['A'] }]));
    c.setSelection('r', 0, ['9']); // no such option → nothing recorded
    expect(c.isComplete('r', 1)).toBe(false);
    expect(() => c.setSelection('ghost', 0, ['0'])).not.toThrow();
    expect(() => c.setOther('ghost', 0, 'x')).not.toThrow();
  });

  it('is bounded — an abandoned card ages out by FIFO', () => {
    const c = new QuestionAnswerCollector();
    for (let i = 0; i < 65; i++) {
      c.register(`r${i}`, questions([{ question: 'q', options: ['A'] }]));
    }
    expect(c.size()).toBe(64);
    expect(c.expectedCount('r0')).toBeUndefined(); // oldest evicted
  });
});

describe('dedupe / idempotency keys', () => {
  it('the dedupe key separates users and requests; the wire key is per-request', () => {
    expect(questionSubmitDedupeKey('u1', 'r1')).not.toBe(questionSubmitDedupeKey('u2', 'r1'));
    expect(questionSubmitDedupeKey('u1', 'r1')).not.toBe(questionSubmitDedupeKey('u1', 'r2'));
    expect(questionIdempotencyKey('r1')).toBe(questionIdempotencyKey('r1')); // deterministic
    expect(encodeOptionValue(3)).toBe('3');
  });
});
