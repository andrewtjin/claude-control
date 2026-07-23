import { describe, it, expect } from 'vitest';
import { createQuestionGate } from './questionGate.js';
import type { QuestionAnswer, QuestionResolution } from './types.js';

/** Drain the microtask queue so a resolved gate promise's `.then` has run before assertions. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Record what a register() promise resolves to WITHOUT awaiting it (awaiting a still-blocked
 *  question would hang the test). */
function watch(p: Promise<QuestionResolution>): { get: () => QuestionResolution | undefined } {
  let value: QuestionResolution | undefined;
  void p.then((r) => {
    value = r;
  });
  return { get: () => value };
}

const oneAnswer: QuestionAnswer[] = [{ question: 'Pick', selected: ['a'] }];

describe('createQuestionGate', () => {
  it('blocks a registered question until it is answered, then delivers the answers', async () => {
    const gate = createQuestionGate();
    const pending = watch(gate.register('r1'));
    await tick();
    // Still blocking — no timer, no auto-answer.
    expect(pending.get()).toBeUndefined();
    expect(gate.pending()).toEqual(['r1']);

    expect(gate.resolve('r1', oneAnswer)).toBe('resolved');
    await tick();
    expect(pending.get()).toEqual({ kind: 'answers', answers: oneAnswer });
    expect(gate.pending()).toEqual([]);
  });

  it('is single-resolve: a second answer on the same id is a no-op returning already_handled', async () => {
    const gate = createQuestionGate();
    const pending = watch(gate.register('r1'));
    expect(gate.resolve('r1', oneAnswer)).toBe('resolved');
    await tick();

    const other: QuestionAnswer[] = [{ question: 'Pick', selected: ['b'] }];
    expect(gate.resolve('r1', other)).toBe('already_handled');
    await tick();
    expect(pending.get()).toEqual({ kind: 'answers', answers: oneAnswer });
  });

  it('returns unknown for an id with no pending question', () => {
    const gate = createQuestionGate();
    expect(gate.resolve('nope', oneAnswer)).toBe('unknown');
  });

  it('denyAll resolves every pending question as a fail-closed deny — no promise leaks', async () => {
    const gate = createQuestionGate();
    const a = watch(gate.register('a'));
    const b = watch(gate.register('b'));
    await tick();
    expect(a.get()).toBeUndefined();
    expect(b.get()).toBeUndefined();

    gate.denyAll('session ended');
    await tick();
    expect(a.get()).toEqual({ kind: 'denied', message: 'session ended' });
    expect(b.get()).toEqual({ kind: 'denied', message: 'session ended' });
    expect(gate.pending()).toEqual([]);
    // A denied question is 'already_handled' on a late answer — a safe idempotent no-op.
    expect(gate.resolve('a', oneAnswer)).toBe('already_handled');
    expect(gate.resolve('never', oneAnswer)).toBe('unknown');
  });

  it('denyAll does not disturb an already-answered question and is idempotent', async () => {
    const gate = createQuestionGate();
    const a = watch(gate.register('a'));
    gate.resolve('a', oneAnswer);
    await tick();

    gate.denyAll('ended');
    gate.denyAll('ended again');
    await tick();
    expect(a.get()).toEqual({ kind: 'answers', answers: oneAnswer });
  });

  it('re-registering a still-pending id returns the same blocking promise', async () => {
    const gate = createQuestionGate();
    const p1 = gate.register('r1');
    const p2 = gate.register('r1');
    expect(p2).toBe(p1);
    expect(gate.pending()).toEqual(['r1']);

    gate.resolve('r1', oneAnswer);
    await expect(p1).resolves.toEqual({ kind: 'answers', answers: oneAnswer });
    await expect(p2).resolves.toEqual({ kind: 'answers', answers: oneAnswer });
  });
});
