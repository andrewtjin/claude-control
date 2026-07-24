import { describe, it, expect } from 'vitest';
import type { PayloadOf } from '@claude-control/shared-protocol';
import { SessionPlanner, type GatewayOp, type SessionRoute } from './sessionPlanner.js';

const ROUTE: SessionRoute = { discordUserId: 'u1', sessionId: 's1' };

type Status = PayloadOf<'session.status'>;
type Output = PayloadOf<'session.output'>;

function status(state: Status['state'], extra?: { summary?: string; accountId?: string }): Status {
  return {
    sessionId: ROUTE.sessionId,
    state,
    ...(extra?.summary !== undefined ? { summary: extra.summary } : {}),
    ...(extra?.accountId !== undefined ? { accountId: extra.accountId } : {}),
  };
}

function output(
  seq: number,
  kind: Output['kind'],
  text: string,
  truncated = false,
  epoch?: string,
): Output {
  return {
    sessionId: ROUTE.sessionId,
    seq,
    kind,
    text,
    truncated,
    ...(epoch !== undefined ? { epoch } : {}),
  };
}

// --- op selectors -----------------------------------------------------------
const cardSends = (ops: GatewayOp[]) =>
  ops.filter((o) => o.kind === 'sendMessage' && o.role === 'card');
const lineSends = (ops: GatewayOp[]) =>
  ops.filter((o) => o.kind === 'sendMessage' && o.role === 'line');
const edits = (ops: GatewayOp[]) => ops.filter((o) => o.kind === 'editMessage');
const uploads = (ops: GatewayOp[]) => ops.filter((o) => o.kind === 'uploadAttachment');
/** Title of the embed a card/edit op carries. */
function embedTitle(op: GatewayOp): string | undefined {
  return 'embed' in op && op.embed ? op.embed.toJSON().title : undefined;
}

describe('SessionPlanner — live card creation', () => {
  it('creates exactly one card on the first status, with a Stop button while live', () => {
    const p = new SessionPlanner();
    const r = p.onStatus(ROUTE, status('running'), 0);
    expect(cardSends(r.ops)).toHaveLength(1);
    const card = cardSends(r.ops)[0]!;
    expect(embedTitle(card)).toContain('running');
    // A running card offers Stop (armed → two-tap).
    expect('components' in card && card.components?.[0]).toHaveLength(1);
  });

  it('does not create a second card on a later status — it edits in place', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onStatus(ROUTE, status('waiting_input'), 5000); // well past the window
    expect(cardSends(r.ops)).toHaveLength(0);
    expect(edits(r.ops)).toHaveLength(1);
    expect(embedTitle(edits(r.ops)[0]!)).toContain('waiting input');
  });
});

describe('SessionPlanner — coalescing (≤1 edit per window)', () => {
  it('collapses a burst of stdout updates into a single edit at the window boundary', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 2000 });
    p.onStatus(ROUTE, status('running'), 0);
    const a = p.onOutput(ROUTE, output(0, 'stdout', 'hello '), 100);
    const b = p.onOutput(ROUTE, output(1, 'stdout', 'world'), 200);
    // Neither in-window update edits immediately; both ask to flush at lastEdit(0)+window.
    expect(edits(a.ops)).toHaveLength(0);
    expect(edits(b.ops)).toHaveLength(0);
    expect(a.flushAtMs).toBe(2000);
    expect(b.flushAtMs).toBe(2000);
    // The scheduled flush emits ONE edit carrying the latest coalesced state.
    const f = p.flush(ROUTE, 2000);
    expect(edits(f.ops)).toHaveLength(1);
    expect(embedTitle(f.ops[0]!)).toBeDefined();
  });

  it('edits immediately when an update lands after a quiet period', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'x'), 5000); // > window since last edit
    expect(edits(r.ops)).toHaveLength(1);
  });
});

describe('SessionPlanner — milestone / summary / error lines', () => {
  it('posts a milestone as its own line, not folded into the card tail', () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'milestone', 'built package'), 10);
    const lines = lineSends(r.ops);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { content: string }).content).toBe('🔹 built package');
    expect(edits(r.ops)).toHaveLength(0); // milestone does not dirty the card tail
  });

  it('labels a truncated milestone line', () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'milestone', 'partial', true), 10);
    expect((lineSends(r.ops)[0] as { content: string }).content).toBe('🔹 partial ⟨truncated⟩');
  });

  it('re-renders a table in a summary line as a fenced phone-width box', () => {
    // Standalone lines post as proportional-font content, where terminal box-drawing turns
    // to soup — the planner must ship tables through the table formatter, fenced.
    const table = [
      'verdicts:',
      '┌──────────────────────────────────────────────┬─────────────┐',
      '│ Inferred                                     │ Confirmed   │',
      '├──────────────────────────────────────────────┼─────────────┤',
      '│ some very long inferred claim that overflows │ exact match │',
      '└──────────────────────────────────────────────┴─────────────┘',
    ].join('\n');
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'summary', table), 10);
    const content = (lineSends(r.ops)[0] as { content: string }).content;
    expect(content.startsWith('📝 verdicts:')).toBe(true);
    expect(content).toContain('```');
    for (const line of content.split('\n').filter((l) => l.startsWith('│') || l.startsWith('┌')))
      expect(line.length).toBeLessThanOrEqual(40);
    expect(content).toContain('Confirmed');
  });

  it('posts an error as its own line AND keeps it in the transcript', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1 }); // force an attachment so we can read the transcript
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'error', 'boom'), 10);
    expect((lineSends(r.ops)[0] as { content: string }).content).toBe('❗ boom');
    expect((uploads(r.ops)[0] as { text: string }).text).toContain('boom');
  });
});

describe('SessionPlanner — attachments for long output', () => {
  it('uploads the full output once it crosses the threshold and notes it on the card', () => {
    const p = new SessionPlanner({ attachThresholdChars: 10, coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const big = 'x'.repeat(25);
    const r = p.onOutput(ROUTE, output(0, 'stdout', big), 5000);
    const up = uploads(r.ops);
    expect(up).toHaveLength(1);
    expect((up[0] as { text: string; filename: string }).text).toBe(big);
    expect((up[0] as { filename: string }).filename).toBe('session-s1.log');
    // The card edited in the same batch carries the "full output attached" note.
    const note = edits(r.ops)[0]!;
    expect(JSON.stringify('embed' in note && note.embed ? note.embed.toJSON() : {})).toContain(
      'full output attached',
    );
  });

  it('does not attach short output', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'short'), 5000);
    expect(uploads(r.ops)).toHaveLength(0);
  });
});

describe('SessionPlanner — gaps and truncation are never silent', () => {
  it('writes an explicit gap marker into the transcript at terminal', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1, gapGraceMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    p.onOutput(ROUTE, output(0, 'stdout', 'a'), 0);
    p.onOutput(ROUTE, output(2, 'stdout', 'c'), 0); // seq 1 never arrives
    const done = p.onStatus(ROUTE, status('done', { summary: 'finished' }), 100);
    const attachment = (uploads(done.ops)[0] as { text: string }).text;
    expect(attachment).toContain('gap: output seq 1–1 lost');
    expect(attachment).toContain('a');
    expect(attachment).toContain('c');
  });

  it('marks a source-truncated chunk in the transcript', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'capped', true), 5000);
    expect((uploads(r.ops)[0] as { text: string }).text).toContain('source truncated its output');
  });
});

describe('SessionPlanner — terminal summary', () => {
  it('edits the card to final, posts a standalone summary card, and clears the Stop button', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const done = p.onStatus(ROUTE, status('done', { summary: 'all tests pass' }), 5000);
    // The live card edited to terminal, with its components cleared.
    const cardEdit = edits(done.ops)[0]!;
    expect('components' in cardEdit && cardEdit.components).toEqual([]);
    // A standalone summary card posted as its own line message.
    const summary = lineSends(done.ops).at(-1)!;
    expect(embedTitle(summary)).toContain('complete');
    expect(
      JSON.stringify('embed' in summary && summary.embed ? summary.embed.toJSON() : {}),
    ).toContain('all tests pass');
    // No further flush is scheduled after terminal.
    expect(done.flushAtMs).toBeUndefined();
  });
});

describe('SessionPlanner — stop composes with the live card', () => {
  it('flips the card to "stopping…" immediately on a stop request', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 10000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onStopRequested(ROUTE, 100); // well inside the window — must still edit now
    expect(edits(r.ops)).toHaveLength(1);
    expect(embedTitle(r.ops[0]!)).toContain('stopping');
    // The stopping card offers no Stop button (nothing left to stop).
    const edit = r.ops[0]!;
    expect('components' in edit && edit.components).toEqual([]);
  });

  it('is a no-op for a session that was never streamed here', () => {
    const p = new SessionPlanner();
    expect(p.onStopRequested({ discordUserId: 'u1', sessionId: 'never' }, 0).ops).toEqual([]);
  });

  it('a terminal status after a stop clears the stopping state', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    p.onStopRequested(ROUTE, 100);
    const done = p.onStatus(ROUTE, status('failed', { summary: 'stopped' }), 5000);
    expect(embedTitle(edits(done.ops)[0]!)).toContain('failed');
  });
});

describe('SessionPlanner — output epoch resets reassembly across a daemon restart', () => {
  it('adopts the first epoch seen without emitting a restart marker', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1, coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    p.onOutput(ROUTE, output(0, 'stdout', 'a', false, 'e1'), 0);
    const r = p.onOutput(ROUTE, output(1, 'stdout', 'b', false, 'e1'), 0);
    const transcript = (uploads(r.ops).at(-1) as { text: string } | undefined)?.text ?? '';
    expect(transcript).toContain('ab');
    expect(transcript).not.toContain('output stream restarted');
  });

  it('resets nextSeq and writes a visible marker when the epoch changes (resumed turn not dropped)', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1, coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    // Run e1 advances nextSeq to 2.
    p.onOutput(ROUTE, output(0, 'stdout', 'a', false, 'e1'), 0);
    p.onOutput(ROUTE, output(1, 'stdout', 'b', false, 'e1'), 0);
    // Daemon restart: same session, new epoch, seq restarts at 0. Without a reset this seq-0 chunk
    // would be dropped as "below nextSeq"; with it, the transcript gains a restart marker then 'c'.
    p.onOutput(ROUTE, output(0, 'stdout', 'c', false, 'e2'), 100);
    // Read the COMPLETE transcript off the terminal top-up attachment (the first crossing already
    // fired on 'b', so only terminal re-emits the whole thing).
    const done = p.onStatus(ROUTE, status('done', { summary: 'resumed and finished' }), 200);
    const transcript = (uploads(done.ops).at(-1) as { text: string }).text;
    expect(transcript).toContain('output stream restarted — daemon resumed this session');
    expect(transcript.endsWith('c')).toBe(true); // the resumed chunk survived, appended after the marker
  });

  it('never resets on an undefined epoch, even after an epoch was already tracked (old daemon)', () => {
    const p = new SessionPlanner({ attachThresholdChars: 1, coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    p.onOutput(ROUTE, output(0, 'stdout', 'a', false, 'e1'), 0); // adopt e1
    // A subsequent chunk with NO epoch must behave exactly as today: seq 1 commits, no marker.
    const r = p.onOutput(ROUTE, output(1, 'stdout', 'b'), 0);
    const transcript = (uploads(r.ops).at(-1) as { text: string }).text;
    expect(transcript).toBe('ab');
    expect(transcript).not.toContain('output stream restarted');
  });
});

describe('SessionPlanner — line content is clamped to the Discord limit', () => {
  it('clamps an over-long milestone line to ≤2000 chars ending in a truncation label', () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'milestone', 'm'.repeat(5000)), 10);
    const line = lineSends(r.ops)[0] as { content: string };
    expect(line.content.length).toBeLessThanOrEqual(2000);
    expect(line.content).toContain('chars truncated');
  });
});

describe('SessionPlanner — no silent gap between the inline tail and the attachment', () => {
  it('attaches output longer than the inline tail even in the old 1001–1499 silent zone', () => {
    // Defaults: tail 1000, threshold now defaults to the tail (1000) with strictly-greater
    // crossing — so 1001 chars (which the tail would clip) attaches instead of vanishing.
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'x'.repeat(1001)), 5000);
    expect(uploads(r.ops)).toHaveLength(1);
  });

  it('keeps output that exactly fits the inline tail inline-only (boundary stays un-attached)', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 1000 });
    p.onStatus(ROUTE, status('running'), 0);
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'x'.repeat(1000)), 5000);
    expect(uploads(r.ops)).toHaveLength(0);
  });
});

describe('SessionPlanner — route isolation', () => {
  it('keys state by user AND session so two users never share a card', () => {
    const p = new SessionPlanner();
    const a: SessionRoute = { discordUserId: 'uA', sessionId: 'shared' };
    const b: SessionRoute = { discordUserId: 'uB', sessionId: 'shared' };
    expect(cardSends(p.onStatus(a, { sessionId: 'shared', state: 'running' }, 0).ops)).toHaveLength(
      1,
    );
    // Same sessionId, different user → a fresh card, not an edit of A's.
    expect(cardSends(p.onStatus(b, { sessionId: 'shared', state: 'running' }, 0).ops)).toHaveLength(
      1,
    );
  });
});

describe('SessionPlanner — stream mode (per-session thread surface)', () => {
  // Times start at 5000: with lastEditAtMs starting at 0, any real clock is "past the window"
  // for a session's first emission, and these tests mirror that.
  it('never posts a card and emits the first stdout immediately as a plain line', () => {
    const p = new SessionPlanner();
    const s0 = p.onStatus(ROUTE, status('running'), 5000, 'stream');
    expect(cardSends(s0.ops)).toHaveLength(0);
    expect(edits(s0.ops)).toHaveLength(0);
    expect(lineSends(s0.ops)).toHaveLength(0); // starting→running is noise, not a line
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'hello world'), 5010, 'stream');
    const lines = lineSends(r.ops);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { content: string }).content).toBe('hello world');
    expect(cardSends(r.ops)).toHaveLength(0);
    expect(edits(r.ops)).toHaveLength(0);
  });

  it("the first frame's mode is sticky — a later frame cannot flip the surface to card", () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 5000, 'stream');
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'x'), 9000, 'card');
    expect(cardSends(r.ops)).toHaveLength(0);
    expect(lineSends(r.ops)).toHaveLength(1);
  });

  it('coalesces an in-window burst into one appended batch at the window boundary', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 2000 });
    p.onOutput(ROUTE, output(0, 'stdout', 'first '), 5000, 'stream'); // emits, anchors the window
    const a = p.onOutput(ROUTE, output(1, 'stdout', 'hel'), 5100, 'stream');
    const b = p.onOutput(ROUTE, output(2, 'stdout', 'lo'), 5200, 'stream');
    expect(lineSends(a.ops)).toHaveLength(0);
    expect(lineSends(b.ops)).toHaveLength(0);
    expect(a.flushAtMs).toBe(7000);
    expect(b.flushAtMs).toBe(7000);
    const f = p.flush(ROUTE, 7000);
    const lines = lineSends(f.ops);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { content: string }).content).toBe('hello');
  });

  it('splits an over-limit batch into multiple messages, each within the content cap', () => {
    const p = new SessionPlanner();
    const big = 'line\n'.repeat(700); // 3500 chars — needs 2 messages
    const r = p.onOutput(ROUTE, output(0, 'stdout', big), 5000, 'stream');
    const lines = lineSends(r.ops);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    for (const line of lines) {
      expect((line as { content: string }).content.length).toBeLessThanOrEqual(2000);
    }
  });

  it('replaces an extreme burst with a visible skip marker, then attaches the FULL transcript at terminal', () => {
    const p = new SessionPlanner();
    const flood = 'x'.repeat(13_000); // past STREAM_SKIP_THRESHOLD_CHARS
    const r = p.onOutput(ROUTE, output(0, 'stdout', flood), 5000, 'stream');
    const lines = lineSends(r.ops);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { content: string }).content).toContain('⏩');
    expect((lines[0] as { content: string }).content).toContain('skipped');
    const done = p.onStatus(ROUTE, status('done'), 6000, 'stream');
    const ups = uploads(done.ops);
    expect(ups).toHaveLength(1);
    expect((ups[0] as { text: string }).text).toBe(flood); // complete, not a remainder
  });

  it('posts no attachment when everything streamed inline', () => {
    const p = new SessionPlanner();
    p.onOutput(ROUTE, output(0, 'stdout', 'short output'), 5000, 'stream');
    const done = p.onStatus(ROUTE, status('done'), 6000, 'stream');
    expect(uploads(done.ops)).toHaveLength(0);
  });

  it('drains the buffer ahead of the terminal summary so the transcript reads in order', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 2000 });
    p.onOutput(ROUTE, output(0, 'stdout', 'a'), 5000, 'stream');
    p.onOutput(ROUTE, output(1, 'stdout', 'b'), 5100, 'stream'); // buffered, in-window
    const done = p.onStatus(ROUTE, status('done', { summary: 'fin' }), 5200, 'stream');
    const lines = lineSends(done.ops);
    // [drained 'b' line, summary embed line] — text strictly before the summary card.
    expect(lines.length).toBe(2);
    expect((lines[0] as { content?: string }).content).toBe('b');
    expect('embed' in lines[1]! && lines[1].embed).toBeTruthy();
  });

  it('a declared gap surfaces as a visible marker IN the thread', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 100, gapGraceMs: 500 });
    p.onOutput(ROUTE, output(0, 'stdout', 'a'), 5000, 'stream'); // emits
    const hole = p.onOutput(ROUTE, output(2, 'stdout', 'c'), 5050, 'stream'); // seq 1 missing
    expect(lineSends(hole.ops)).toHaveLength(0); // parked behind the hole
    const f = p.flush(ROUTE, 6000); // grace elapsed
    const lines = lineSends(f.ops);
    expect(lines).toHaveLength(1);
    const content = (lines[0] as { content: string }).content;
    expect(content).toContain('⟨gap: output seq 1–1 lost⟩');
    expect(content).toContain('c');
  });

  it('a daemon-run change mid-session writes the restart marker into the stream', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 100 });
    p.onOutput(ROUTE, output(0, 'stdout', 'before', false, 'run-1'), 5000, 'stream');
    const r = p.onOutput(ROUTE, output(0, 'stdout', 'after', false, 'run-2'), 9000, 'stream');
    const lines = lineSends(r.ops);
    expect(lines).toHaveLength(1);
    const content = (lines[0] as { content: string }).content;
    expect(content).toContain('output stream restarted');
    expect(content).toContain('after');
  });

  it('posts action-worthy state changes as lines, exactly once per change', () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 5000, 'stream');
    const wait = p.onStatus(ROUTE, status('waiting_permission'), 6000, 'stream');
    const lines = lineSends(wait.ops);
    expect(lines).toHaveLength(1);
    expect((lines[0] as { content: string }).content).toContain('🔐');
    // The same state repeated is not a change — no repeat line.
    const again = p.onStatus(ROUTE, status('waiting_permission'), 7000, 'stream');
    expect(lineSends(again.ops)).toHaveLength(0);
  });

  it('acknowledges a stop request with a line, once', () => {
    const p = new SessionPlanner();
    p.onStatus(ROUTE, status('running'), 5000, 'stream');
    const first = p.onStopRequested(ROUTE, 6000);
    expect(lineSends(first.ops)).toHaveLength(1);
    expect((lineSends(first.ops)[0] as { content: string }).content).toContain('stopping');
    expect(edits(first.ops)).toHaveLength(0); // no card exists to edit
    const second = p.onStopRequested(ROUTE, 6100);
    expect(second.ops).toHaveLength(0);
  });
});

describe('SessionPlanner — stream mode ordering and fences', () => {
  it('drains buffered stdout BEFORE an error line, preserving seq order in the thread', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 2000 });
    p.onOutput(ROUTE, output(0, 'stdout', 'first'), 5000, 'stream'); // emits, anchors window
    const buffered = p.onOutput(ROUTE, output(1, 'stdout', 'second'), 5100, 'stream');
    expect(lineSends(buffered.ops)).toHaveLength(0); // in-window, buffered
    const err = p.onOutput(ROUTE, output(2, 'error', 'boom'), 5150, 'stream');
    const lines = lineSends(err.ops).map((l) => (l as { content: string }).content);
    // The buffered 'second' must post ahead of the error annotation — the thread reads in
    // the order the terminal produced it, never annotation-first.
    expect(lines).toEqual(['second', '❗ boom']);
  });

  it('drains buffered stdout BEFORE a milestone line too', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 2000 });
    p.onOutput(ROUTE, output(0, 'stdout', 'first'), 5000, 'stream');
    p.onOutput(ROUTE, output(1, 'stdout', 'second'), 5100, 'stream');
    const mile = p.onOutput(ROUTE, output(2, 'milestone', 'built'), 5150, 'stream');
    const lines = lineSends(mile.ops).map((l) => (l as { content: string }).content);
    expect(lines).toEqual(['second', '🔹 built']);
  });

  it('closes an open fence at a flush boundary and reopens it (with info string) at the next', () => {
    const p = new SessionPlanner({ coalesceWindowMs: 100 });
    const first = p.onOutput(ROUTE, output(0, 'stdout', '```js\nconst a = 1;'), 5000, 'stream');
    const firstContent = (lineSends(first.ops)[0] as { content: string }).content;
    expect(firstContent.endsWith('```')).toBe(true); // balanced for isolated rendering
    const second = p.onOutput(
      ROUTE,
      output(1, 'stdout', '\nconst b = 2;\n```\nplain prose'),
      9000,
      'stream',
    );
    const secondContent = (lineSends(second.ops)[0] as { content: string }).content;
    expect(secondContent.startsWith('```js\n')).toBe(true); // reopened with its language
    expect(secondContent).toContain('plain prose');
    // The reopened fence closes where the source closed it, so the prose stays prose.
    expect(secondContent.endsWith('plain prose')).toBe(true);
  });

  it('splits an oversized terminal transcript into multiple attachment parts, losing nothing', () => {
    const p = new SessionPlanner({ attachPartChars: 7000 });
    const flood = 'x'.repeat(13_000); // triggers the inline skip AND spans two parts
    p.onOutput(ROUTE, output(0, 'stdout', flood), 5000, 'stream');
    const done = p.onStatus(ROUTE, status('done'), 6000, 'stream');
    const ups = uploads(done.ops) as Array<{ filename: string; text: string; content?: string }>;
    expect(ups).toHaveLength(2);
    expect(ups[0]!.filename).toContain('part1of2');
    expect(ups[1]!.filename).toContain('part2of2');
    expect(ups.map((u) => u.text).join('')).toBe(flood);
    expect(ups[0]!.content).toBeDefined(); // the note rides the first part only
    expect(ups[1]!.content).toBeUndefined();
  });
});
