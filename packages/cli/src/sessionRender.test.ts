import { describe, it, expect } from 'vitest';
import { renderSessionStatus, type SessionStatusRow } from './sessionRender.js';

describe('renderSessionStatus', () => {
  it('nudges with an empty state when nothing is tracked', () => {
    const out = renderSessionStatus([], { activeLabel: 'work', fullWindowsLeft: 3 });
    expect(out).toContain('Active account: work');
    expect(out).toContain('3x5h left');
    expect(out).toContain('/cctl:register');
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
    const out = renderSessionStatus(rows, { activeLabel: 'work', fullWindowsLeft: 2 });

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
