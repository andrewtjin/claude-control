import { describe, it, expect } from 'vitest';
import type { AccountUsage, UsagePlan } from '@claude-control/shared-protocol';
import {
  buildUsageEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildPermissionRequestEmbed,
  buildSwitchResultEmbed,
  buildTimelineEmbed,
} from './embeds.js';
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
  it('renders a field per account with formatted limits', () => {
    const embed = buildUsageEmbed({ accounts: [account()] }).toJSON();
    expect(embed.title).toBe('Usage');
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields?.[0]?.name).toContain('Work');
    expect(embed.fields?.[0]?.name).toContain('active');
    expect(embed.fields?.[0]?.value).toContain('session 42%');
  });

  it('marks idle accounts and surfaces a per-account error', () => {
    const embed = buildUsageEmbed({
      accounts: [account({ active: false, error: 'refresh failed' })],
    }).toJSON();
    expect(embed.fields?.[0]?.name).toContain('idle');
    expect(embed.fields?.[0]?.value).toContain('refresh failed');
  });

  it('adds a recommendation field and advisories when a plan is present', () => {
    const plan: UsagePlan = {
      recommendedAccountId: 'acct-2',
      reason: 'account 1 is near its weekly cap',
      ranking: [],
      advisories: [{ kind: 'switch_now', message: 'switch before reset', accountId: 'acct-1' }],
    };
    const embed = buildUsageEmbed({ accounts: [account()], plan }).toJSON();
    const rec = embed.fields?.find((f) => f.name === 'Recommendation');
    expect(rec?.value).toContain('acct-2');
    expect(rec?.value).toContain('near its weekly cap');
    const advisories = embed.fields?.find((f) => f.name === 'Advisories');
    expect(advisories?.value).toContain('switch before reset');
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
    expect(embed.fields?.[0]?.value).toContain('5×5h windows left · weekly resets in 1d 2h');
  });

  it('omits the budget line when no weekly reset time is known', () => {
    const embed = buildUsageEmbed({ accounts: [account()] }).toJSON();
    expect(embed.fields?.[0]?.value).not.toContain('5h windows left');
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

  it('renders the outlook inside a code block so the ASCII tracks align', () => {
    const embed = buildTimelineEmbed({ accounts }, NOW).toJSON();
    expect(embed.title).toBe('Reset timeline');
    expect(embed.description).toMatch(/^```\n/);
    expect(embed.description).toMatch(/\n```$/);
    expect(embed.description).toContain('5h-session budget');
    expect(embed.description).toContain('Reset timeline  now -> 1d 2h');
    expect(embed.description).toContain('Upcoming resets');
    expect(embed.description).toContain('5h window resets (42% used clears)');
  });

  it('appends the daemon-computed plan when the snapshot carries one', () => {
    const plan: UsagePlan = {
      recommendedAccountId: 'acct-1',
      reason: 'Work has the most available headroom (58%).',
      ranking: [],
      advisories: [{ kind: 'all_healthy', message: 'All accounts have healthy headroom.' }],
    };
    const embed = buildTimelineEmbed({ accounts, plan }, NOW).toJSON();
    expect(embed.description).toContain('Plan: Work has the most available headroom (58%).');
    expect(embed.description).toContain('- All accounts have healthy headroom.');
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
    const embed = buildPermissionRequestEmbed('run rm -rf', 'in /tmp/scratch').toJSON();
    expect(embed.description).toBe('run rm -rf');
    expect(embed.fields?.[0]?.value).toBe('in /tmp/scratch');
  });

  it('omits the detail field when none is given', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf').toJSON();
    expect(embed.fields ?? []).toHaveLength(0);
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
