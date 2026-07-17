// Tests for the reset outlook: 5h-window budgeting, event ordering, the wire adapter, and
// the exact rendered text (the render is a public contract shared by CLI and Discord).

import { describe, expect, it } from 'vitest';
import {
  computeOutlook,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
} from './timeline.js';
import type { AccountUsageInput } from './types.js';

const NOW = Date.parse('2026-07-16T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

/** Convenience account factory with sane defaults. */
function account(overrides: Partial<AccountUsageInput> & { accountId: string }): AccountUsageInput {
  return {
    label: overrides.accountId,
    active: false,
    quarantined: false,
    limits: [],
    ...overrides,
  };
}

describe('computeOutlook — 5h window budget', () => {
  it('counts full windows plus a partial when no window is open', () => {
    // 76h until the weekly reset: 15 full 5h windows + a 1h truncated one.
    const outlook = computeOutlook(
      [
        account({
          accountId: 'a',
          limits: [{ kind: 'weekly_all', percent: 21, resetsAt: NOW + 76 * HOUR }],
        }),
      ],
      NOW,
    );
    expect(outlook.accounts[0]?.budget).toEqual({
      weeklyResetAt: NOW + 76 * HOUR,
      fullWindows: 15,
      hasPartialWindow: true,
    });
    expect(outlook.accounts[0]?.openWindowEndsAt).toBeUndefined();
  });

  it('counts a currently-open window as one and budgets the rest from its close', () => {
    // Window closes in 2h; weekly resets in 12h: the open window + exactly two more.
    const outlook = computeOutlook(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'session', percent: 34, resetsAt: NOW + 2 * HOUR },
            { kind: 'weekly_all', percent: 50, resetsAt: NOW + 12 * HOUR },
          ],
        }),
      ],
      NOW,
    );
    const a = outlook.accounts[0];
    expect(a?.openWindowEndsAt).toBe(NOW + 2 * HOUR);
    expect(a?.sessionPercent).toBe(34);
    expect(a?.budget).toEqual({
      weeklyResetAt: NOW + 12 * HOUR,
      fullWindows: 3,
      hasPartialWindow: false,
    });
  });

  it('clamps to just the open window when it outlives the weekly reset', () => {
    const outlook = computeOutlook(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'session', percent: 10, resetsAt: NOW + 4 * HOUR },
            { kind: 'weekly_all', percent: 95, resetsAt: NOW + 1 * HOUR },
          ],
        }),
      ],
      NOW,
    );
    expect(outlook.accounts[0]?.budget).toEqual({
      weeklyResetAt: NOW + 1 * HOUR,
      fullWindows: 1,
      hasPartialWindow: false,
    });
  });

  it('reports no budget when the weekly reset time is unknown', () => {
    const outlook = computeOutlook(
      [account({ accountId: 'a', limits: [{ kind: 'weekly_all', percent: 10 }] })],
      NOW,
    );
    expect(outlook.accounts[0]?.budget).toBeUndefined();
  });

  it('ignores reset times in the past (stale cached snapshots carry them)', () => {
    const outlook = computeOutlook(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'session', percent: 80, resetsAt: NOW - 1 * HOUR },
            { kind: 'weekly_all', percent: 10, resetsAt: NOW - 2 * HOUR },
          ],
        }),
      ],
      NOW,
    );
    expect(outlook.accounts[0]?.openWindowEndsAt).toBeUndefined();
    expect(outlook.accounts[0]?.budget).toBeUndefined();
    expect(outlook.events).toEqual([]);
  });

  it('budgets against the SOONEST weekly reset when both weekly kinds report one', () => {
    const outlook = computeOutlook(
      [
        account({
          accountId: 'a',
          limits: [
            { kind: 'weekly_scoped', percent: 34, resetsAt: NOW + 10 * HOUR },
            { kind: 'weekly_all', percent: 21, resetsAt: NOW + 20 * HOUR },
          ],
        }),
      ],
      NOW,
    );
    expect(outlook.accounts[0]?.budget?.weeklyResetAt).toBe(NOW + 10 * HOUR);
    expect(outlook.accounts[0]?.budget?.fullWindows).toBe(2);
  });
});

describe('computeOutlook — merged events', () => {
  it('merges all accounts, soonest first, with a deterministic same-time tie-break', () => {
    const outlook = computeOutlook(
      [
        account({
          accountId: 'b',
          label: 'spare',
          limits: [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 26 * HOUR }],
        }),
        account({
          accountId: 'a',
          label: 'main',
          limits: [
            { kind: 'session', percent: 34, resetsAt: NOW + 2 * HOUR },
            { kind: 'weekly_all', percent: 21, resetsAt: NOW + 76 * HOUR },
            { kind: 'weekly_scoped', percent: 90, resetsAt: NOW + 26 * HOUR },
          ],
        }),
      ],
      NOW,
    );
    expect(outlook.events.map((e) => [e.label, e.kind])).toEqual([
      ['main', 'session'],
      ['main', 'weekly_scoped'], // same ms as spare's weekly — label breaks the tie
      ['spare', 'weekly_all'],
      ['main', 'weekly_all'],
    ]);
    expect(outlook.events[0]?.percentUsed).toBe(34);
  });
});

describe('timelineInputFromWire', () => {
  it('parses ISO reset times to epoch ms and defaults quarantined to false', () => {
    const inputs = timelineInputFromWire([
      {
        accountId: 'a',
        label: 'main',
        active: true,
        limits: [{ kind: 'session', percent: 12, resetsAt: '2026-07-16T14:00:00.000Z' }],
      },
    ]);
    expect(inputs[0]?.quarantined).toBe(false);
    expect(inputs[0]?.limits[0]?.resetsAt).toBe(Date.parse('2026-07-16T14:00:00.000Z'));
  });

  it('drops unparseable or absent reset times instead of producing NaN', () => {
    const inputs = timelineInputFromWire([
      {
        accountId: 'a',
        label: 'main',
        active: false,
        quarantined: true,
        limits: [
          { kind: 'session', percent: 1, resetsAt: 'not-a-date' },
          { kind: 'weekly_all', percent: 2, resetsAt: null },
          { kind: 'weekly_scoped', percent: 3 },
        ],
      },
    ]);
    expect(inputs[0]?.quarantined).toBe(true);
    for (const limit of inputs[0]?.limits ?? []) {
      expect('resetsAt' in limit).toBe(false);
    }
  });
});

describe('renderOutlook', () => {
  const twoAccounts = [
    account({
      accountId: 'a',
      label: 'main',
      active: true,
      limits: [
        { kind: 'session', percent: 34, resetsAt: NOW + 2 * HOUR },
        { kind: 'weekly_all', percent: 21, resetsAt: NOW + 76 * HOUR },
      ],
    }),
    account({
      accountId: 'b',
      label: 'spare',
      limits: [{ kind: 'weekly_all', percent: 60, resetsAt: NOW + 26 * HOUR }],
    }),
  ];

  it('renders budget, timeline track, and upcoming resets', () => {
    const text = renderOutlook(computeOutlook(twoAccounts, NOW), { trackWidth: 20 });
    expect(text).toContain(
      '* main   window open (34% used, resets in 2h) · 15 full 5h windows +1 partial before weekly reset in 3d 4h',
    );
    expect(text).toContain(
      '  spare  no open window · 5 full 5h windows +1 partial before weekly reset in 1d 2h',
    );
    expect(text).toContain('Reset timeline  now -> 3d 4h');
    // 20-wide track, 76h span: session at round(2/76*19)=1, weekly at 19.
    expect(text).toContain('main   |-s-----------------w|');
    // spare's weekly at 26h: round(26/76*19) = round(6.5) = 7.
    expect(text).toContain('spare  |-------w------------|');
    expect(text).toContain('in 2h     main   5h window resets (34% used clears)');
    expect(text).toContain('in 1d 2h  spare  weekly quota resets — 40% unused expires with it');
    expect(text).toContain('in 3d 4h  main   weekly quota resets — 79% unused expires with it');
  });

  it('marks a quarantined account instead of budgeting it', () => {
    const text = renderOutlook(
      computeOutlook([account({ accountId: 'a', label: 'dead', quarantined: true })], NOW),
    );
    expect(text).toContain('dead  quarantined — re-login required');
  });

  it('collapses two resets in the same track cell to *', () => {
    // 1-wide effective resolution: both events land on the same cell.
    const text = renderOutlook(
      computeOutlook(
        [
          account({
            accountId: 'a',
            label: 'main',
            limits: [
              { kind: 'session', percent: 1, resetsAt: NOW + 10 * HOUR },
              { kind: 'weekly_all', percent: 2, resetsAt: NOW + 10 * HOUR + 1 },
            ],
          }),
        ],
        NOW,
      ),
      { trackWidth: 3 },
    );
    expect(text).toContain('main  |--*|');
  });

  it('says so when nothing has a reset time yet', () => {
    const text = renderOutlook(computeOutlook([account({ accountId: 'a', label: 'main' })], NOW));
    expect(text).toContain('weekly reset time unknown');
    expect(text).toContain('No reset times reported yet');
  });

  it('prompts to add an account when there are none', () => {
    expect(renderOutlook(computeOutlook([], NOW))).toContain('No accounts yet');
  });

  it('routes text through the style hooks without changing the visible layout', () => {
    // A tagging style proves which hook saw which text; stripping the tags must reproduce
    // the plain render exactly (the "styles are zero-visible-width" contract ANSI codes
    // satisfy — layout is computed before styling).
    const tag = (name: string) => (text: string) => `«${name}:${text}»`;
    const outlook = computeOutlook(twoAccounts, NOW);
    const styled = renderOutlook(outlook, {
      trackWidth: 20,
      style: {
        heading: tag('h'),
        label: tag('l'),
        active: tag('a'),
        dim: tag('d'),
        session: tag('s'),
        weekly: tag('w'),
        both: tag('b'),
        percent: (text, pct) => `«p${pct}:${text}»`,
        alert: tag('!'),
      },
    });
    expect(styled).toContain('«a:*» «l:main »'); // active marker + padded label, separately styled
    expect(styled).toContain('«s:s»'); // session mark on the track
    expect(styled).toContain('«w:w»'); // weekly mark on the track
    expect(styled).toContain('«p34:34% used»'); // percent hook sees the number for banding
    expect(styled.replace(/«[^:»]*:([^»]*)»/g, '$1')).toBe(
      renderOutlook(outlook, { trackWidth: 20 }),
    );
  });
});

describe('renderPlanSummary', () => {
  it('renders the reason and each advisory as a bullet', () => {
    const text = renderPlanSummary({
      reason: 'main has the most available headroom (79%).',
      advisories: [{ message: 'Burn spare: 40% of its weekly quota resets in 1d 2h.' }],
    });
    expect(text).toBe(
      'Plan: main has the most available headroom (79%).\n' +
        '  - Burn spare: 40% of its weekly quota resets in 1d 2h.',
    );
  });
});
