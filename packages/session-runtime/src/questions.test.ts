import { describe, it, expect } from 'vitest';
import { parseQuestions, composeAnswers } from './questions.js';
import type { QuestionAnswer } from './types.js';

describe('parseQuestions', () => {
  it('parses a well-formed single question, defaulting multiSelect to false', () => {
    expect(
      parseQuestions({
        questions: [
          {
            question: 'Which color?',
            header: 'Color',
            options: [{ label: 'teal', description: 'blue-green' }, { label: 'red' }],
          },
        ],
      }),
    ).toEqual([
      {
        question: 'Which color?',
        header: 'Color',
        multiSelect: false,
        options: [{ label: 'teal', description: 'blue-green' }, { label: 'red' }],
      },
    ]);
  });

  it('preserves an explicit multiSelect: true and parses multiple questions', () => {
    const parsed = parseQuestions({
      questions: [
        { question: 'q1', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
        { question: 'q2', options: [{ label: 'c' }] },
      ],
    });
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]?.multiSelect).toBe(true);
    expect(parsed?.[1]?.multiSelect).toBe(false);
  });

  it.each([
    ['not an object', 'nope'],
    ['no questions field', {}],
    ['questions not an array', { questions: 'x' }],
    ['empty questions array', { questions: [] }],
    ['a question with no text', { questions: [{ options: [{ label: 'a' }] }] }],
    ['a question with empty text', { questions: [{ question: '', options: [{ label: 'a' }] }] }],
    ['a question with no options array', { questions: [{ question: 'q' }] }],
    ['a question with empty options', { questions: [{ question: 'q', options: [] }] }],
    ['an option with no label', { questions: [{ question: 'q', options: [{ description: 'd' }] }] }],
  ])('returns undefined (fall back to terminal) for %s', (_label, input) => {
    expect(parseQuestions(input)).toBeUndefined();
  });

  it('rejects the WHOLE input when any question is malformed (never a partial set)', () => {
    expect(
      parseQuestions({
        questions: [
          { question: 'good', options: [{ label: 'a' }] },
          { question: 'bad', options: [] },
        ],
      }),
    ).toBeUndefined();
  });
});

describe('composeAnswers', () => {
  it('keys by question text and joins multiSelect labels with ", "', () => {
    const answers: QuestionAnswer[] = [
      { question: 'Which color?', selected: ['teal'] },
      { question: 'Which toppings?', selected: ['cheese', 'olives'] },
    ];
    expect(composeAnswers(answers)).toEqual({
      'Which color?': 'teal',
      'Which toppings?': 'cheese, olives',
    });
  });

  it('lets otherText win over selected when present', () => {
    const answers: QuestionAnswer[] = [
      { question: 'Anything else?', selected: ['ignored'], otherText: 'a custom reply' },
    ];
    expect(composeAnswers(answers)).toEqual({ 'Anything else?': 'a custom reply' });
  });

  it('composes an empty selection to an empty string (other-only answered elsewhere)', () => {
    expect(composeAnswers([{ question: 'q', selected: [] }])).toEqual({ q: '' });
  });
});
