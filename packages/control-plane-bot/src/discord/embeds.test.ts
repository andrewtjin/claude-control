import { describe, it, expect } from 'vitest';
import type { AccountUsage, UsagePlan } from '@claude-control/shared-protocol';
import {
  buildUsageEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildPermissionRequestEmbed,
  buildSettingsEmbed,
  buildSwitchResultEmbed,
  buildTimelineEmbed,
  buildDoneEmbed,
  buildWaitingEmbed,
  buildQuarantineEmbed,
} from './embeds.js';
import { NOTIFICATION_COLOR } from './richFormat.js';
import type { SessionStatus } from './stateCache.js';

function account(overrides: Partial<AccountUsage> = {}): AccountUsage {
  return {
    accountId: 'acct-1',
    label: 'Work',
    active: true,
    source: 'live',
    fetchedAtMs: 0,
    limits: [{ kind: 'session', percent: 42, isActive: true }],
    ...overrides,
  };
}

describe('buildUsageEmbed', () => {
  it('renders a field per account with a layered progress bar per limit', () => {
    const embed = buildUsageEmbed({ accounts: [account()] }).toJSON();
    expect(embed.title).toBe('Usage');
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields?.[0]?.name).toContain('Work');
    expect(embed.fields?.[0]?.name).toContain('🟢 active');
    // 42% in the ok zone: 4 green cells, 6 empty, then the text line.
    expect(embed.fields?.[0]?.value).toContain('🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ session 42%');
  });

  it('colors the embed by the worst severity across all accounts', () => {
    const ok = buildUsageEmbed({ accounts: [account()] }).toJSON();
    expect(ok.color).toBe(0x2ecc71);
    const critical = buildUsageEmbed({
      accounts: [
        account(),
        account({ limits: [{ kind: 'weekly_all', percent: 97, isActive: true }] }),
      ],
    }).toJSON();
    expect(critical.color).toBe(0xe74c3c);
  });

  it('appends a native relative timestamp when a limit has a future reset', () => {
    const NOW = Date.parse('2026-07-16T12:00:00.000Z');
    const resetsAt = '2026-07-16T14:00:00.000Z';
    const embed = buildUsageEmbed(
      {
        accounts: [
          account({ limits: [{ kind: 'session', percent: 42, isActive: true, resetsAt }] }),
        ],
      },
      NOW,
    ).toJSON();
    expect(embed.fields?.[0]?.value).toContain(
      `resets <t:${Math.floor(Date.parse(resetsAt) / 1000)}:R>`,
    );
  });

  it('marks idle accounts, cached snapshots, and surfaces a per-account error', () => {
    const embed = buildUsageEmbed({
      accounts: [account({ active: false, source: 'cached', error: 'refresh failed' })],
    }).toJSON();
    expect(embed.fields?.[0]?.name).toContain('idle');
    expect(embed.fields?.[0]?.name).toContain('· cached');
    expect(embed.fields?.[0]?.name).toContain('⚠️');
    expect(embed.fields?.[0]?.value).toContain('refresh failed');
  });

  it('adds one compact Plan field when a plan is present', () => {
    const plan: UsagePlan = {
      recommendedAccountId: 'acct-2',
      reason: 'Burn spare (48% weekly left, resets in 9h); hold main (weekly resets in 6d).',
      ranking: [],
      advisories: [{ kind: 'switch_now', message: 'switch before reset', accountId: 'acct-1' }],
    };
    const embed = buildUsageEmbed({ accounts: [account()], plan }).toJSON();
    const planField = embed.fields?.find((f) => f.name === 'Plan');
    expect(planField?.value).toBe(
      'Burn spare (48% weekly left, resets in 9h); hold main (weekly resets in 6d).\n' +
        '• switch before reset',
    );
    // The old two-heading layout is gone — advice is a single field now.
    expect(embed.fields?.some((f) => f.name === 'Recommendation')).toBe(false);
    expect(embed.fields?.some((f) => f.name === 'Advisories')).toBe(false);
  });

  it('shows a placeholder description when there are no accounts yet', () => {
    const embed = buildUsageEmbed({ accounts: [] }).toJSON();
    expect(embed.description).toMatch(/no accounts/i);
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('appends the 5h-window budget when a weekly reset time is known', () => {
    const NOW = Date.parse('2026-07-16T12:00:00.000Z');
    const embed = buildUsageEmbed(
      {
        accounts: [
          account({
            limits: [
              { kind: 'session', percent: 42, isActive: true },
              {
                kind: 'weekly_all',
                percent: 30,
                isActive: true,
                resetsAt: '2026-07-17T14:00:00.000Z', // 26h out: 5 full 5h windows
              },
            ],
          }),
        ],
      },
      NOW,
    ).toJSON();
    const weeklyTs = Math.floor(Date.parse('2026-07-17T14:00:00.000Z') / 1000);
    expect(embed.fields?.[0]?.value).toContain(
      `5×5h windows left · weekly resets <t:${weeklyTs}:R>`,
    );
  });

  it('omits the budget line when no weekly reset time is known', () => {
    const embed = buildUsageEmbed({ accounts: [account()] }).toJSON();
    expect(embed.fields?.[0]?.value).not.toContain('5h windows left');
  });

  it('renders bars through an injected renderer instead of the unicode default', () => {
    // The gateway swaps in the emoji renderer this same way; a sentinel renderer proves the
    // bar text comes from the injected function and NOT the built-in unicode squares.
    const fakeBar = (percent: number) => `EBAR(${Math.round(percent)})`;
    const embed = buildUsageEmbed({ accounts: [account()] }, undefined, fakeBar).toJSON();
    expect(embed.fields?.[0]?.value).toContain('EBAR(42) session 42%');
    expect(embed.fields?.[0]?.value).not.toContain('🟩');
  });
});

describe('buildTimelineEmbed', () => {
  const NOW = Date.parse('2026-07-16T12:00:00.000Z');
  const accounts = [
    account({
      limits: [
        { kind: 'session', percent: 42, isActive: true, resetsAt: '2026-07-16T14:00:00.000Z' },
        { kind: 'weekly_all', percent: 30, isActive: true, resetsAt: '2026-07-17T14:00:00.000Z' },
      ],
    }),
  ];

  const SESSION_TS = Math.floor(Date.parse('2026-07-16T14:00:00.000Z') / 1000);
  const WEEKLY_TS = Math.floor(Date.parse('2026-07-17T14:00:00.000Z') / 1000);

  it('renders rich markdown — no code block, native timestamps, emoji track', () => {
    const embed = buildTimelineEmbed({ accounts }, NOW).toJSON();
    expect(embed.title).toBe('Reset timeline');
    expect(embed.description).not.toContain('```');
    // Legend + shared span in the description.
    expect(embed.description).toContain(`now → <t:${WEEKLY_TS}:R>`);
    expect(embed.description).toContain('🟦 5h window');
    // Per-account field: session bar, budget line, and the proportional track.
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.name).toContain('🟢');
    expect(field?.value).toContain(
      `🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ window open · 42% used · resets <t:${SESSION_TS}:R>`,
    );
    expect(field?.value).toContain(
      `5×5h windows left +1 partial · weekly resets <t:${WEEKLY_TS}:R>`,
    );
    // Track: session reset at 2h of a 26h span → cell 1 (round(2/26·11)); weekly at the end.
    expect(field?.value).toContain('⬛🟦⬛⬛⬛⬛⬛⬛⬛⬛⬛🟪');
  });

  it('lists upcoming resets chronologically with reset semantics', () => {
    const embed = buildTimelineEmbed({ accounts }, NOW).toJSON();
    const upcoming = embed.fields?.find((f) => f.name === 'Upcoming resets');
    expect(upcoming?.value).toContain(
      `🟦 <t:${SESSION_TS}:R> — **Work** · 5h window resets (42% used clears)`,
    );
    expect(upcoming?.value).toContain(
      `🟪 <t:${WEEKLY_TS}:R> — **Work** · weekly quota resets — 70% unused expires`,
    );
  });

  it('shows a no-open-window signal when the session limit has no future reset', () => {
    const embed = buildTimelineEmbed(
      {
        accounts: [
          account({
            limits: [
              {
                kind: 'weekly_all',
                percent: 30,
                isActive: true,
                resetsAt: '2026-07-17T14:00:00.000Z',
              },
            ],
          }),
        ],
      },
      NOW,
    ).toJSON();
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.value).toContain('no open 5h window');
  });

  it('appends the daemon-computed plan when the snapshot carries one', () => {
    const plan: UsagePlan = {
      recommendedAccountId: 'acct-1',
      reason: 'Work has the most available headroom (58%).',
      ranking: [],
      advisories: [{ kind: 'all_healthy', message: 'All accounts have healthy headroom.' }],
    };
    const embed = buildTimelineEmbed({ accounts, plan }, NOW).toJSON();
    const planField = embed.fields?.find((f) => f.name === 'Plan');
    expect(planField?.value).toContain('Work has the most available headroom (58%).');
    expect(planField?.value).toContain('• All accounts have healthy headroom.');
  });

  it('shows a placeholder when there are no accounts', () => {
    const embed = buildTimelineEmbed({ accounts: [] }, NOW).toJSON();
    expect(embed.description).toMatch(/no accounts/i);
  });

  it('draws the session bar through an injected renderer', () => {
    const fakeBar = (percent: number) => `EBAR(${Math.round(percent)})`;
    const embed = buildTimelineEmbed({ accounts }, NOW, fakeBar).toJSON();
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.value).toContain('EBAR(42) window open');
    expect(field?.value).not.toContain('🟩');
  });

  it('draws tracks and marker glyphs through an injected track style', () => {
    // The gateway swaps in the sprite-backed style this same way; sentinels prove both the
    // per-account track and the legend/list markers come from the injected style, and that
    // no unicode track squares leak through anywhere.
    const style = {
      track: () => 'TRACK',
      session: 'S!',
      weekly: 'W!',
      both: 'B!',
    };
    const embed = buildTimelineEmbed({ accounts }, NOW, undefined, style).toJSON();
    expect(embed.description).toContain('S! 5h window · W! weekly · B! both');
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.value).toContain('TRACK');
    expect(field?.value).not.toContain('⬛');
    const upcoming = embed.fields?.find((f) => f.name === 'Upcoming resets');
    expect(upcoming?.value).toContain(`S! <t:${SESSION_TS}:R> — **Work**`);
    expect(upcoming?.value).toContain(`W! <t:${WEEKLY_TS}:R> — **Work**`);
  });
});

describe('buildAccountsEmbed', () => {
  it('lists each account with its source', () => {
    const embed = buildAccountsEmbed([account({ source: 'cached' })]).toJSON();
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields?.[0]?.value).toContain('cached');
  });

  it('shows a placeholder when there are no accounts', () => {
    const embed = buildAccountsEmbed([]).toJSON();
    expect(embed.description).toMatch(/no accounts/i);
  });
});

describe('buildSettingsEmbed', () => {
  it('lists one line per knob, naming the source only for explicit overrides', () => {
    const embed = buildSettingsEmbed({
      startedAtMs: 1_700_000_000_000,
      settings: [
        { name: 'auto-switch', value: 'on', source: 'flag' },
        { name: 'greedy burn-back', value: 'on', source: 'env' },
        { name: 'switch trigger', value: '94% used', source: 'default' },
      ],
    }).toJSON();
    expect(embed.title).toBe('Daemon settings');
    expect(embed.description).toBe(
      [
        '**auto-switch** — on _(via flag)_',
        '**greedy burn-back** — on _(via env)_',
        '**switch trigger** — 94% used',
      ].join('\n'),
    );
    // The report is dated, never passed off as live state.
    expect(embed.footer?.text).toBe('as of daemon start');
    expect(embed.timestamp).toBe(new Date(1_700_000_000_000).toISOString());
  });
});

describe('buildSessionListEmbed', () => {
  const session: SessionStatus = { sessionId: 's1', state: 'running', summary: 'building' };

  it('lists sessions by id with state and summary', () => {
    const embed = buildSessionListEmbed([session]).toJSON();
    expect(embed.fields?.[0]?.name).toBe('s1');
    expect(embed.fields?.[0]?.value).toBe('running — building');
  });

  it('shows a placeholder when there are no sessions', () => {
    const embed = buildSessionListEmbed([]).toJSON();
    expect(embed.description).toMatch(/no sessions/i);
  });
});

describe('buildPermissionRequestEmbed', () => {
  it('sets the summary as the description and adds detail when present', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf', 'in /tmp/scratch', 'default').toJSON();
    expect(embed.description).toBe('run rm -rf');
    expect(embed.fields?.[0]?.value).toBe('in /tmp/scratch');
  });

  it('omits the detail field when none is given', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf').toJSON();
    expect(embed.fields ?? []).toHaveLength(0);
  });

  it('is an actionable (warn) card in default mode', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf', undefined, 'default').toJSON();
    expect(embed.title).toBe('Permission requested');
    expect(embed.color).toBe(0xf1c40f);
    expect(embed.footer?.text).toMatch(/approve or deny/i);
  });

  it('is an informational (info) card that explains why in a non-default mode', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf', undefined, 'acceptEdits').toJSON();
    expect(embed.title).toBe('Permission (auto-handled)');
    expect(embed.color).toBe(0x3498db);
    expect(embed.footer?.text).toContain('acceptEdits');
    // Description still names WHAT was requested, even though it can't be actioned here.
    expect(embed.description).toBe('run rm -rf');
  });
});

describe('lifecycle cards (done / waiting / quarantine)', () => {
  it('buildDoneEmbed shows the last assistant message and a green ✅ card', () => {
    const embed = buildDoneEmbed({ sessionId: 's1', lastAssistantMessage: 'Shipped it.' }).toJSON();
    expect(embed.title).toContain('✅');
    expect(embed.color).toBe(NOTIFICATION_COLOR.done);
    expect(embed.description).toBe('Shipped it.');
    expect(embed.fields?.[0]?.value).toBe('s1');
  });

  it('buildDoneEmbed labels a truncated long message instead of cutting silently', () => {
    const long = 'x'.repeat(5000);
    const embed = buildDoneEmbed({ lastAssistantMessage: long }).toJSON();
    expect(embed.description!.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toContain('chars truncated');
  });

  it('buildWaitingEmbed is a blue 🔔 "your turn" card', () => {
    const embed = buildWaitingEmbed({ sessionId: 's1', body: 'Reply to continue.' }).toJSON();
    expect(embed.title).toContain('🔔');
    expect(embed.color).toBe(NOTIFICATION_COLOR.waiting);
    expect(embed.description).toBe('Reply to continue.');
  });

  it('buildQuarantineEmbed prints the injected host re-login command verbatim', () => {
    const embed = buildQuarantineEmbed({
      body: 'Work is quarantined.',
      reloginCommand: 'cctl accounts relogin <label>',
    }).toJSON();
    expect(embed.title).toContain('🚫');
    expect(embed.color).toBe(NOTIFICATION_COLOR.quarantine);
    const fix = embed.fields?.find((f) => f.name === 'Fix it on the host');
    expect(fix?.value).toContain('cctl accounts relogin <label>');
  });
});

describe('buildSwitchResultEmbed', () => {
  it('titles success and failure differently', () => {
    const ok = buildSwitchResultEmbed(true, 'switched to acct-2').toJSON();
    const fail = buildSwitchResultEmbed(false, 'refresh failed').toJSON();
    expect(ok.title).toBe('Switched');
    expect(fail.title).toBe('Switch failed');
    expect(ok.description).toBe('switched to acct-2');
  });
});
