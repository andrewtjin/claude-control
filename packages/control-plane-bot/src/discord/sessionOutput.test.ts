import { describe, it, expect } from 'vitest';
import { OrderedOutput, type CommittedItem, type OutputChunk } from './sessionOutput.js';

/** A stdout chunk with only `seq`/`text` spelled out; the rest defaulted. */
function chunk(seq: number, text: string, truncated = false): OutputChunk {
  return { seq, kind: 'stdout', text, truncated };
}

/** Concatenate the committed stdout text (ignoring gaps) for terse assertions. */
function textOf(items: CommittedItem[]): string {
  return items
    .filter((i): i is Extract<CommittedItem, { kind: 'chunk' }> => i.kind === 'chunk')
    .map((i) => i.text)
    .join('');
}

describe('OrderedOutput — in-order and dedupe', () => {
  it('commits contiguous chunks immediately, in order', () => {
    const out = new OrderedOutput();
    expect(textOf(out.accept(chunk(0, 'a'), 0))).toBe('a');
    expect(textOf(out.accept(chunk(1, 'b'), 0))).toBe('b');
    expect(textOf(out.accept(chunk(2, 'c'), 0))).toBe('c');
  });

  it('drops a duplicate or late-after-skip seq idempotently', () => {
    const out = new OrderedOutput();
    out.accept(chunk(0, 'a'), 0);
    out.accept(chunk(1, 'b'), 0);
    expect(out.accept(chunk(1, 'b-again'), 0)).toEqual([]); // already delivered
    expect(out.accept(chunk(0, 'a-again'), 0)).toEqual([]);
  });
});

describe('OrderedOutput — reordering within grace', () => {
  it('buffers an out-of-order chunk and commits both once the hole fills', () => {
    const out = new OrderedOutput({ gapGraceMs: 1000 });
    expect(out.accept(chunk(1, 'b'), 0)).toEqual([]); // seq 0 not here yet → parked
    expect(out.hasPending()).toBe(true);
    const committed = out.accept(chunk(0, 'a'), 100); // fills the hole
    expect(textOf(committed)).toBe('ab');
    expect(out.hasPending()).toBe(false);
  });

  it('exposes the gap deadline while a hole is open', () => {
    const out = new OrderedOutput({ gapGraceMs: 1000 });
    out.accept(chunk(1, 'b'), 500);
    expect(out.gapDeadline()).toBe(1500); // waitingSince(500) + grace(1000)
  });
});

describe('OrderedOutput — gaps are surfaced, never silent', () => {
  it('declares a gap once grace elapses and skips forward to the next chunk', () => {
    const out = new OrderedOutput({ gapGraceMs: 1000 });
    out.accept(chunk(0, 'a'), 0);
    expect(out.accept(chunk(2, 'c'), 0)).toEqual([]); // seq 1 missing, still within grace
    const resolved = out.resolveGaps(1000, false); // grace elapsed
    expect(resolved[0]).toEqual({ kind: 'gap', fromSeq: 1, toSeq: 1 });
    expect(textOf(resolved)).toBe('c');
  });

  it('auto-resolves inside accept when the clock has already passed the grace', () => {
    const out = new OrderedOutput({ gapGraceMs: 1000 });
    out.accept(chunk(0, 'a'), 0);
    out.accept(chunk(2, 'c'), 0); // parked; waiting since 0
    const committed = out.accept(chunk(5, 'f'), 1000); // now past grace → head gap resolves
    expect(committed[0]).toEqual({ kind: 'gap', fromSeq: 1, toSeq: 1 });
    expect(textOf(committed)).toBe('c'); // seq 5 still parked behind the 3–4 hole
    expect(out.hasPending()).toBe(true);
  });

  it('force-resolves EVERY remaining hole at terminal so the transcript is complete', () => {
    const out = new OrderedOutput({ gapGraceMs: 1000 });
    out.accept(chunk(0, 'a'), 0);
    out.accept(chunk(2, 'c'), 0);
    out.accept(chunk(4, 'e'), 0);
    const resolved = out.resolveGaps(0, true); // terminal, ignore grace
    expect(resolved).toEqual([
      { kind: 'gap', fromSeq: 1, toSeq: 1 },
      { kind: 'chunk', outputKind: 'stdout', text: 'c', truncated: false, seq: 2 },
      { kind: 'gap', fromSeq: 3, toSeq: 3 },
      { kind: 'chunk', outputKind: 'stdout', text: 'e', truncated: false, seq: 4 },
    ]);
    expect(out.hasPending()).toBe(false);
  });
});

describe('OrderedOutput — truncation flag', () => {
  it('preserves a source-truncated chunk so it can be labeled downstream', () => {
    const out = new OrderedOutput();
    const committed = out.accept(chunk(0, 'partial', true), 0);
    expect(committed[0]).toMatchObject({ kind: 'chunk', truncated: true, text: 'partial' });
  });
});
