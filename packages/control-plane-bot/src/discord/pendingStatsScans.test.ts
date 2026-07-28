import { describe, it, expect } from 'vitest';
import type { PayloadOf } from '@claude-control/shared-protocol';
import { PendingStatsScans } from './pendingStatsScans.js';

/** A minimal well-formed result payload — the contents never matter here, only that the exact
 *  object handed to `settle` is the one the waiter receives. */
function result(requestId: string, turns = 1): PayloadOf<'stats.result'> {
  return {
    requestId,
    ok: true,
    snapshot: {
      windowStartMs: 0,
      windowEndMs: 1000,
      overall: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns },
      byAccount: [],
      byModel: [],
      byDay: [],
      coverage: {
        filesScanned: 1,
        filesSkippedByMtime: 0,
        filesUnreadable: 0,
        dirsUnreadable: 0,
        malformedLines: 0,
        duplicateTurns: 0,
      },
    },
  };
}

describe('PendingStatsScans', () => {
  it('hands a delivered result to the waiter for that requestId', async () => {
    const pending = new PendingStatsScans();
    // Generous bound: this test is about correlation, not about the timeout ever firing.
    const waiting = pending.awaitResult('req-1', 10_000);
    expect(pending.settle('req-1', result('req-1', 42))).toBe(true);

    const outcome = await waiting;
    expect(outcome.kind).toBe('result');
    expect(outcome.kind === 'result' && outcome.payload.snapshot?.overall.turns).toBe(42);
    // Settling releases the entry — nothing is retained for a wait that is over.
    expect(pending.size()).toBe(0);
  });

  it('routes each result to its own waiter, never to another in-flight scan', async () => {
    const pending = new PendingStatsScans();
    const first = pending.awaitResult('req-1', 10_000);
    const second = pending.awaitResult('req-2', 10_000);
    expect(pending.size()).toBe(2);

    pending.settle('req-2', result('req-2', 22));
    const secondOutcome = await second;
    expect(secondOutcome.kind === 'result' && secondOutcome.payload.snapshot?.overall.turns).toBe(
      22,
    );
    // The other wait is untouched and still pending.
    expect(pending.size()).toBe(1);

    pending.settle('req-1', result('req-1', 11));
    const firstOutcome = await first;
    expect(firstOutcome.kind === 'result' && firstOutcome.payload.snapshot?.overall.turns).toBe(11);
  });

  it('reports no waiter for an unknown requestId rather than throwing', () => {
    const pending = new PendingStatsScans();
    // The bot-restart / already-timed-out case: the caller's contract is a silent drop, so this
    // has to be an ordinary false, not an exception on the delivery path.
    expect(pending.settle('never-seen', result('never-seen'))).toBe(false);
  });

  it('gives up with a timeout outcome when no result ever arrives', async () => {
    const pending = new PendingStatsScans();
    // A real (very short) timer rather than fake timers — house convention, and it proves the
    // actual setTimeout path rather than a mocked stand-in.
    const outcome = await pending.awaitResult('req-1', 5);
    expect(outcome.kind).toBe('timeout');
    // The entry must be gone BEFORE the promise resolves, so a late result cannot resolve a
    // promise that is already settled.
    expect(pending.size()).toBe(0);
  });

  it('drops a result that arrives after its wait timed out', async () => {
    const pending = new PendingStatsScans();
    const outcome = await pending.awaitResult('req-1', 5);
    expect(outcome.kind).toBe('timeout');
    expect(pending.settle('req-1', result('req-1'))).toBe(false);
  });

  it('abandons a wait whose request never got out', async () => {
    const pending = new PendingStatsScans();
    // Bound far longer than the test could tolerate: if `abandon` did not settle the promise,
    // this await would hang rather than fail fast.
    const waiting = pending.awaitResult('req-1', 600_000);
    pending.abandon('req-1');

    expect((await waiting).kind).toBe('timeout');
    expect(pending.size()).toBe(0);
    // Abandoning is idempotent and safe for an id that is already gone.
    expect(() => {
      pending.abandon('req-1');
    }).not.toThrow();
  });

  it('refuses a new wait past the in-flight cap instead of evicting a live one', async () => {
    const pending = new PendingStatsScans();
    const waits = Array.from({ length: 16 }, (_, i) => pending.awaitResult(`req-${i}`, 600_000));
    expect(pending.size()).toBe(16);

    // The 17th is refused outright — and, crucially, the 16 already waiting are untouched:
    // a wait that exists is always settled by exactly one of result/timeout/abandon.
    expect((await pending.awaitResult('req-16', 600_000)).kind).toBe('busy');
    expect(pending.size()).toBe(16);

    // A freed slot lets the next request through again.
    pending.abandon('req-0');
    const readmitted = pending.awaitResult('req-16', 600_000);
    expect(pending.size()).toBe(16);
    pending.settle('req-16', result('req-16'));
    expect((await readmitted).kind).toBe('result');

    for (let i = 1; i < 16; i += 1) pending.abandon(`req-${i}`);
    await Promise.all(waits);
  });
});
