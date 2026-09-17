import { describe, it, expect } from 'vitest';
import type { AccountUsage } from '@claude-control/shared-protocol';
import { renderSessionStatus, weeklyResetHeader, type SessionStatusRow } from './sessionRender.js';
import { renderUsage } from './render.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const DAY_MS = 86_400_000;

/** A poll snapshot whose weekly window has CLOSED — the endpoint stops publishing a reset once
 *  it does, which is exactly when a prediction from history is the only clock there is. */
const lapsedWeekly: AccountUsage = {
  accountId: 'acct-1',
  label: 'work',
  active: true,
  source: 'cached',
  fetchedAtMs: NOW - 60_000,
  limits: [{ kind: 'weekly_all', percent: 40, isActive: true }],
};

describe('renderSessionStatus', () => {
  it('nudges with an empty state when nothing is tracked', () => {
    const out = renderSessionStatus([], { activeLabel: 'work', weeklyResetInMs: 3 * 86_400_000 });
    expect(out).toContain('Active account: work');
    expect(out).toContain('3d left');
    expect(out).toContain('/cctl:register');
  });

  it('marks a predicted weekly countdown, and agrees with what cctl usage prints', () => {
    // The endpoint has stopped publishing this account's weekly reset, so the only clock is the
    // one measured from history. It must still show — and must say what it is.
    const predictedResetAt = NOW + 5 * DAY_MS;
    const header = {
      activeLabel: 'work',
      ...weeklyResetHeader(lapsedWeekly, predictedResetAt, NOW),
    };
    const out = renderSessionStatus([], header);
    expect(out).toContain('Active account: work');
    expect(out).toContain('5d left (predicted)');

    // The same snapshot through `cctl usage`: one fact, one phrasing, on both surfaces.
    const usageOut = renderUsage(
      [{ label: 'work', active: true, usage: lapsedWeekly, predictedResetAt }],
      NOW,
    );
    expect(usageOut).toContain('5d left (predicted)');
  });

  it('leaves an observed countdown unmarked, so a reading is never read as a projection', () => {
    const observed: AccountUsage = {
      ...lapsedWeekly,
      limits: [
        {
          kind: 'weekly_all',
          percent: 40,
          isActive: true,
          resetsAt: new Date(NOW + 3 * DAY_MS).toISOString(),
        },
      ],
    };
    const header = { activeLabel: 'work', ...weeklyResetHeader(observed, undefined, NOW) };
    const out = renderSessionStatus([], header);
    expect(out).toContain('3d left');
    expect(out).not.toContain('(predicted)');
    expect(renderUsage([{ label: 'work', active: true, usage: observed }], NOW)).toContain(
      '3d left',
    );
  });

  it('leaves the countdown out entirely when nothing knows when the week turns over', () => {
    expect(weeklyResetHeader(lapsedWeekly, undefined, NOW)).toEqual({});
    expect(weeklyResetHeader(undefined, NOW + DAY_MS, NOW)).toEqual({});
    const out = renderSessionStatus([], { activeLabel: 'work' });
    expect(out).toContain('Active account: work');
    expect(out).not.toContain('left');
  });

  it('shows a "no active account" header when the daemon has no data', () => {
    const out = renderSessionStatus([]);
    expect(out).toContain('(none');
    expect(out).toContain('cctl daemon run');
  });

  it('renders a table of interactive + managed sessions with labels, watch, and account', () => {
    const rows: SessionStatusRow[] = [
      {
        id: 'sess-interactive-1',
        kind: 'interactive',
        state: 'active',
        label: 'refactor',
        watch: true,
        accountLabel: 'work',
      },
      // A managed (phone-spawned) session: no label → short id; no watch concept → dash.
      { id: 'abcdef1234567890', kind: 'managed', state: 'running', accountLabel: 'spare' },
    ];
    const out = renderSessionStatus(rows, { activeLabel: 'work', weeklyResetInMs: 2 * 86_400_000 });

    expect(out).toContain('SESSION');
    expect(out).toContain('refactor'); // interactive label
    expect(out).toContain('on'); // watch on
    expect(out).toContain('work');
    // Managed row: short id (first 8 chars), watch dash.
    expect(out).toContain('abcdef12');
    expect(out).not.toContain('abcdef1234567890');
    expect(out).toContain('-');
  });

  it('shows watch off distinctly from watch on', () => {
    const out = renderSessionStatus([
      { id: 's1', kind: 'interactive', state: 'active', label: 'quiet', watch: false },
    ]);
    // The watch column carries "off"; the label column carries the label.
    expect(out).toMatch(/quiet.*off/s);
  });
});
