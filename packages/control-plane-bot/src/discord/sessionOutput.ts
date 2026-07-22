// Pure, ordered reassembly of a session's streamed output chunks.
//
// `session.output` frames carry a monotonic `seq`, but they can still arrive OUT OF ORDER: the
// daemon's durable outbox replays queued frames after a bot/daemon reconnect, and replay does not
// guarantee the original order. Naive append would scramble a transcript. This accumulator buffers
// by seq and commits only contiguous runs, in order.
//
// It NEVER silently drops (the plan bans silent truncation): a chunk whose predecessor never
// arrives is held only until a grace window elapses (or the session ends), after which an explicit
// gap marker is emitted and the stream skips forward — a lost chunk becomes VISIBLE, not swallowed,
// and the stream never stalls forever waiting on a seq that will never come. A chunk flagged
// `truncated` (a source that capped its own scrollback) is committed with its truncation still
// signalled, so the presentation layer can label it rather than pretend completeness.
//
// Everything here is a pure transform over (chunk, now) — time is passed in, never read — so it
// unit-tests deterministically with an injected clock and no fake timers.

/** The four output kinds the daemon streams (mirrors `session.output` `kind`). */
export type OutputKind = 'stdout' | 'milestone' | 'summary' | 'error';

/** One inbound output frame, reduced to the fields ordering cares about. */
export interface OutputChunk {
  seq: number;
  kind: OutputKind;
  text: string;
  truncated: boolean;
}

/** What the accumulator hands back once a slot is settled, in delivery order. A `gap` is an
 *  honest marker that seqs `fromSeq..toSeq` were declared lost after their grace elapsed. */
export type CommittedItem =
  | { kind: 'chunk'; outputKind: OutputKind; text: string; truncated: boolean; seq: number }
  | { kind: 'gap'; fromSeq: number; toSeq: number };

export interface OrderedOutputOptions {
  /** How long a missing head-of-line seq is waited on before its slot is declared a gap and the
   *  stream skips past it. A genuinely reordered chunk fills the hole well within this; a truly
   *  lost one is surfaced as a marker instead of stalling the transcript forever. */
  gapGraceMs?: number;
}

/** Waited ~one coalescing window's worth of reorder tolerance by default (see sessionPlanner):
 *  long enough to absorb a replayed frame arriving a beat late, short enough that a real loss is
 *  surfaced promptly rather than freezing the live card. */
const DEFAULT_GAP_GRACE_MS = 5_000;

export class OrderedOutput {
  private readonly gapGraceMs: number;
  /** The next seq we are willing to commit; everything below it is already delivered or skipped. */
  private nextSeq = 0;
  /** Out-of-order chunks parked until their predecessors arrive (or their grace expires). */
  private readonly parked = new Map<number, OutputChunk>();
  /** Epoch ms the current head-of-line hole started waiting; undefined when nothing is stuck. */
  private waitingSinceMs: number | undefined;

  constructor(options: OrderedOutputOptions = {}) {
    this.gapGraceMs = options.gapGraceMs ?? DEFAULT_GAP_GRACE_MS;
  }

  /** Ingest one chunk at time `now`; return the items it made deliverable, in order. A chunk at
   *  or below `nextSeq` is a duplicate/late-after-skip and is dropped idempotently (never
   *  re-committed). Buffered out-of-order chunks may trigger an immediate gap resolution if the
   *  caller's clock already shows the grace elapsed. */
  accept(chunk: OutputChunk, now: number): CommittedItem[] {
    if (chunk.seq < this.nextSeq) return [];
    this.parked.set(chunk.seq, chunk);
    const committed = this.drain();
    if (this.hasHole()) {
      // A hole remains at the head after draining: start (or keep) the grace clock, then let a
      // clock that has already passed the grace resolve it right away.
      this.waitingSinceMs ??= now;
      committed.push(...this.resolveGaps(now, false));
    }
    return committed;
  }

  /**
   * Resolve stuck holes. `force` (session terminal) collapses EVERY remaining hole at once so the
   * final transcript is complete; otherwise a single head hole is resolved, and only once its
   * grace has elapsed — a reordered chunk still in flight is given its full window first.
   */
  resolveGaps(now: number, force: boolean): CommittedItem[] {
    const out: CommittedItem[] = [];
    while (this.hasHole()) {
      const graceElapsed =
        this.waitingSinceMs !== undefined && now - this.waitingSinceMs >= this.gapGraceMs;
      if (!force && !graceElapsed) break; // still within grace — keep waiting for the real chunk
      const minSeq = this.lowestParked();
      out.push({ kind: 'gap', fromSeq: this.nextSeq, toSeq: minSeq - 1 });
      this.nextSeq = minSeq;
      out.push(...this.drain());
      // One hole per grace window unless forced: restart the clock for any NEXT hole so a second
      // gap is not declared on the same expired timer, while a terminal resolve keeps going.
      this.waitingSinceMs = force ? undefined : now;
      if (!force) break;
    }
    if (!this.hasHole()) this.waitingSinceMs = undefined;
    return out;
  }

  /** Epoch ms at which the current head hole should be declared a gap, or undefined when nothing
   *  is stuck. The planner uses this to schedule a wake-up so a persistent gap is surfaced even if
   *  no further output arrives to drive the stream. */
  gapDeadline(): number | undefined {
    if (!this.hasHole() || this.waitingSinceMs === undefined) return undefined;
    return this.waitingSinceMs + this.gapGraceMs;
  }

  /** Whether any chunks are parked awaiting a missing predecessor. */
  hasPending(): boolean {
    return this.parked.size > 0;
  }

  /** Commit the contiguous run starting at `nextSeq`, advancing past each. */
  private drain(): CommittedItem[] {
    const out: CommittedItem[] = [];
    for (
      let c = this.parked.get(this.nextSeq);
      c !== undefined;
      c = this.parked.get(this.nextSeq)
    ) {
      this.parked.delete(this.nextSeq);
      out.push({
        kind: 'chunk',
        outputKind: c.kind,
        text: c.text,
        truncated: c.truncated,
        seq: c.seq,
      });
      this.nextSeq++;
    }
    if (!this.hasHole()) this.waitingSinceMs = undefined;
    return out;
  }

  /** A hole exists when something is parked but the very next seq is not yet present. */
  private hasHole(): boolean {
    return this.parked.size > 0 && !this.parked.has(this.nextSeq);
  }

  /** Smallest parked seq — the target we skip forward to when declaring a gap. */
  private lowestParked(): number {
    let min = Number.POSITIVE_INFINITY;
    for (const seq of this.parked.keys()) if (seq < min) min = seq;
    return min;
  }
}
