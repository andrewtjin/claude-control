// Splitting daemon text into messages Discord will actually accept.
//
// A DM's `content` is capped at 2000 characters and the API rejects the WHOLE message when it
// overflows — a 2001-character session summary does not arrive truncated, it does not arrive at
// all. Embeds elsewhere in this package clamp their fields (see `clampFieldValue`), but summary,
// milestone, and notification text is delivered as plain content, so it needs its own bound.
//
// Truncating is the wrong trade here: a summary's conclusion lives at its END, which is exactly
// what a clamp would discard. So this splits instead, and only truncates once the text is long
// enough that DMing all of it would be its own kind of failure.
//
// The subtlety is code fences. Cutting between ``` and its closer leaves the first message with
// an unterminated fence and the next starting mid-fence, so both render as garbage — and the
// daemon's text is full of fenced tables and command output. Chunks therefore close an open
// fence on the way out and reopen it (with its original info string, so highlighting survives)
// on the way in.
//
// Shape: pre-split the text into units no larger than a chunk can hold, then greedily pack them.
// Doing the hard-splitting up front is what keeps the packing loop simple and obviously
// terminating — an earlier version interleaved the two and could cut a closing fence off.
//
// Pure: no Discord types, no IO, fully unit-testable.

/** Discord's hard cap on a message's `content` field. */
export const DISCORD_CONTENT_MAX = 2000;

/** Beyond this many messages, a "helpful" notification has become a flood; the rest is dropped
 *  with a visible marker so a reader knows the text was cut rather than silently ending. */
const DEFAULT_MAX_CHUNKS = 4;

const FENCE = '```';
const TRUNCATION_NOTE = '… (truncated)';
const FENCE_LINE = /^\s*```(.*)$/;

export interface ChunkOptions {
  max?: number;
  maxChunks?: number;
}

/**
 * Split `text` into messages that each fit within `max`, preferring line boundaries and keeping
 * code fences balanced across every cut. Always returns at least one chunk. A single line too
 * long to ever fit is hard-split rather than dropped — an ugly break beats losing content.
 */
export function chunkMessage(text: string, options: ChunkOptions = {}): string[] {
  const max = options.max ?? DISCORD_CONTENT_MAX;
  const maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;

  if (text.length <= max) return [text];

  const units = toUnits(text, max);

  const chunks: string[] = [];
  let current = '';
  // Info string of the fence open at the cursor (`''` for a bare ```), undefined when outside a
  // fence. `carried` is that same state as of the current chunk's start, so a continuation can
  // reopen with the original language.
  let openFence: string | undefined;
  let carried: string | undefined;
  let truncated = false;

  const closed = (chunk: string): string =>
    openFence === undefined ? chunk : `${chunk}\n${FENCE}`;

  for (const unit of units) {
    const separator = current === '' ? 0 : 1;
    const closingReserve = openFence === undefined ? 0 : FENCE.length + 1;

    if (current !== '' && current.length + separator + unit.length + closingReserve > max) {
      chunks.push(closed(current));
      carried = openFence;
      current = carried === undefined ? '' : `${FENCE}${carried}\n`;
      if (chunks.length >= maxChunks) {
        truncated = true;
        break;
      }
    }

    current += (current === '' || current.endsWith('\n') ? '' : '\n') + unit;

    // Fence state flips AFTER the line is placed, so a closing fence still lands inside the
    // chunk that needed it.
    const fence = FENCE_LINE.exec(unit);
    if (fence) openFence = openFence === undefined ? (fence[1] ?? '').trim() : undefined;
  }

  if (!truncated && current !== '') chunks.push(closed(current));

  return truncated ? markTruncated(chunks, max) : chunks;
}

/** Break `text` into lines, hard-splitting any line that could never fit in a chunk. The cap
 *  leaves room for the fence scaffolding a continuation chunk may need to add. */
function toUnits(text: string, max: number): string[] {
  const widestInfo = Math.max(
    0,
    ...[...text.matchAll(/^[ \t]*```(.*)$/gm)].map((m) => (m[1] ?? '').trim().length),
  );
  // Reopening costs ```<info>\n and closing costs \n``` — reserve both.
  const overhead = FENCE.length + widestInfo + 1 + FENCE.length + 1;
  const cap = Math.max(1, max - overhead);

  const units: string[] = [];
  for (const line of text.split('\n')) {
    if (line.length <= cap) {
      units.push(line);
      continue;
    }
    for (let i = 0; i < line.length; i += cap) units.push(line.slice(i, i + cap));
  }
  return units;
}

/** Append a visible cut marker to the final chunk, making room for it and re-closing the fence
 *  if trimming disturbed it. Without this a truncated summary just appears to stop mid-thought. */
function markTruncated(chunks: string[], max: number): string[] {
  const last = chunks.length - 1;
  const body = chunks[last] ?? '';
  const note = `\n${TRUNCATION_NOTE}`;

  let trimmed = body.length + note.length > max ? body.slice(0, max - note.length) : body;
  // Trimming may have removed a closing fence (or half of one); rebalance before appending.
  if (countFences(trimmed) % 2 !== 0) {
    const room = max - note.length - (FENCE.length + 1);
    if (trimmed.length > room) trimmed = trimmed.slice(0, Math.max(0, room));
    trimmed += `\n${FENCE}`;
  }

  chunks[last] = trimmed + note;
  return chunks;
}

function countFences(text: string): number {
  return (text.match(/```/g) ?? []).length;
}
