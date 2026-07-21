import { describe, it, expect } from 'vitest';
import { chunkMessage, DISCORD_CONTENT_MAX } from './messageChunks.js';

/** Every chunk must be independently sendable: within the cap and fence-balanced. */
function expectSendable(chunks: string[], max = DISCORD_CONTENT_MAX): void {
  for (const chunk of chunks) {
    expect(chunk.length, `chunk of ${chunk.length} exceeds ${max}`).toBeLessThanOrEqual(max);
    const fences = (chunk.match(/```/g) ?? []).length;
    expect(fences % 2, `unbalanced fence in chunk: ${chunk.slice(0, 60)}…`).toBe(0);
  }
}

describe('chunkMessage', () => {
  it('leaves a message that already fits completely untouched', () => {
    expect(chunkMessage('short')).toEqual(['short']);
    const exact = 'x'.repeat(DISCORD_CONTENT_MAX);
    expect(chunkMessage(exact)).toEqual([exact]);
  });

  it('splits one character past the cap rather than rejecting it', () => {
    const chunks = chunkMessage('x'.repeat(DISCORD_CONTENT_MAX + 1));
    expect(chunks.length).toBeGreaterThan(1);
    expectSendable(chunks);
  });

  it('prefers line boundaries over mid-line cuts', () => {
    const line = 'y'.repeat(90);
    const chunks = chunkMessage(Array.from({ length: 40 }, () => line).join('\n'), {
      max: 200,
      maxChunks: 50,
    });
    expectSendable(chunks, 200);
    // No chunk should contain a partial line: every line is either whole or absent.
    for (const chunk of chunks) {
      for (const l of chunk.split('\n')) {
        if (l !== '') expect(l).toBe(line);
      }
    }
  });

  it('keeps code fences balanced across a split, preserving the info string', () => {
    const body = Array.from({ length: 30 }, (_, i) => `row ${i} ${'z'.repeat(40)}`).join('\n');
    const chunks = chunkMessage(`before\n\`\`\`json\n${body}\n\`\`\`\nafter`, {
      max: 300,
      maxChunks: 50,
    });

    expect(chunks.length).toBeGreaterThan(1);
    expectSendable(chunks, 300);
    // Every continuation that resumes inside the fence reopens it with the same language.
    const resumed = chunks.slice(1).filter((c) => c.startsWith('```'));
    expect(resumed.length).toBeGreaterThan(0);
    for (const chunk of resumed) expect(chunk.startsWith('```json')).toBe(true);
  });

  it('hard-splits a single line too long to ever fit', () => {
    const chunks = chunkMessage('q'.repeat(500), { max: 100 });
    expectSendable(chunks, 100);
    expect(chunks.join('').replace(/\n|… \(truncated\)/g, '')).toMatch(/^q+$/);
  });

  it('bounds the flood and marks the cut instead of ending silently', () => {
    const huge = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkMessage(huge, { max: 200, maxChunks: 3 });
    expect(chunks).toHaveLength(3);
    expectSendable(chunks, 200);
    expect(chunks[chunks.length - 1]).toContain('truncated');
  });

  it('does not claim truncation when everything fit', () => {
    const text = Array.from({ length: 6 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkMessage(text, { max: 30, maxChunks: 10 });
    expectSendable(chunks, 30);
    expect(chunks.join('\n')).not.toContain('truncated');
    // Content is preserved in order across the split.
    expect(chunks.join('\n')).toBe(text);
  });

  it('preserves content in order for a realistic fenced summary', () => {
    const text = [
      '**Session stopped**',
      'Here is the table you asked about:',
      '```',
      ...Array.from({ length: 25 }, (_, i) => `| col ${i} | value ${i} |`),
      '```',
      'and a closing thought.',
    ].join('\n');

    const chunks = chunkMessage(text, { max: 250, maxChunks: 20 });
    expectSendable(chunks, 250);
    expect(chunks.join('\n')).not.toContain('truncated');

    // Strip the fence scaffolding the splitter added, then the original lines must remain,
    // in order, with nothing lost.
    const original = text.split('\n').filter((l) => l !== '```');
    const seen = chunks
      .join('\n')
      .split('\n')
      .filter((l) => !l.startsWith('```') && l !== '');
    expect(seen).toEqual(original.filter((l) => l !== ''));
  });
});
