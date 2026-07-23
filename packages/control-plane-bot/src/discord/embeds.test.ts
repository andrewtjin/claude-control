import { describe, it, expect } from 'vitest';
import type { AccountUsage, UsagePlan } from '@claude-control/shared-protocol';
import {
  buildUsageEmbed,
  buildAccountsEmbed,
  buildSessionListEmbed,
  buildPermissionRequestEmbed,
  buildLapsedPermissionEmbed,
  buildQuestionEmbed,
  buildAnsweredQuestionEmbed,
  buildLapsedQuestionEmbed,
  buildSettingsEmbed,
  buildSwitchResultEmbed,
  buildTimelineEmbed,
  buildDoneEmbed,
  buildToolOutputEmbed,
  buildWaitingEmbed,
  buildQuarantineEmbed,
  buildSessionCardEmbed,
  buildSessionSummaryEmbed,
  clampFieldValue,
  type SessionCardModel,
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
    // One field per account, plus the trailing Pacing field.
    expect(embed.fields).toHaveLength(2);
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

  it('adds a Pacing field computed from the same accounts', () => {
    const NOW = Date.parse('2026-07-16T12:00:00.000Z');
    const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
    const embed = buildUsageEmbed(
      {
        accounts: [
          account({
            limits: [
              // 38% elapsed, 52% used — the same "ahead of pace" fixture as usage-advisor's
              // pacing tests, so the expected headline is known exactly.
              {
                kind: 'weekly_all',
                percent: 52,
                isActive: true,
                resetsAt: new Date(NOW + Math.round(0.62 * WEEK_MS)).toISOString(),
              },
            ],
          }),
        ],
      },
      NOW,
    ).toJSON();
    const pacing = embed.fields?.find((f) => f.name === 'Pacing');
    expect(pacing?.value).toBe(
      '38% of the combined week elapsed, 52% of budget burned - ahead of pace (~1.4x): ' +
        'slow down or expect an early wall.',
    );
  });

  it('omits the Pacing field when there are no accounts', () => {
    const embed = buildUsageEmbed({ accounts: [] }).toJSON();
    expect(embed.fields ?? []).toHaveLength(0);
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

  it('adds a Pacing field alongside the timeline', () => {
    // Work is 42%/30% used with resets 2h/26h out — a fresh (just-computed) pacing verdict
    // from the SAME accounts the timeline above already renders; only assert it's present
    // and sane, since the exact verdict here is incidental to this fixture's real purpose.
    const embed = buildTimelineEmbed({ accounts }, NOW).toJSON();
    const pacing = embed.fields?.find((f) => f.name === 'Pacing');
    expect(pacing?.value).toBeTruthy();
    expect(pacing?.value).not.toContain('NaN');
  });

  it('draws the session bar through an injected renderer', () => {
    const fakeBar = (percent: number) => `EBAR(${Math.round(percent)})`;
    const embed = buildTimelineEmbed({ accounts }, NOW, fakeBar).toJSON();
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.value).toContain('EBAR(42) window open');
    expect(field?.value).not.toContain('🟩');
  });

  it('flags a cached account with its true age and failure reason (2026-07-17 incident)', () => {
    // The incident surface: stale fallback data rendered on /timeline exactly like a live
    // read. The cached marker must carry the ORIGINAL fetch time, not render time.
    const fetchedAtMs = Date.parse('2026-07-16T10:00:00.000Z');
    const stale = account({
      source: 'cached',
      fetchedAtMs,
      error: 'usage endpoint rate-limited (429)',
      limits: [
        { kind: 'session', percent: 42, isActive: true, resetsAt: '2026-07-16T14:00:00.000Z' },
      ],
    });
    const live = account({
      accountId: 'acct-2',
      label: 'Play',
      active: false,
      limits: [
        { kind: 'session', percent: 10, isActive: true, resetsAt: '2026-07-16T13:00:00.000Z' },
      ],
    });
    const embed = buildTimelineEmbed({ accounts: [stale, live] }, NOW).toJSON();
    const staleField = embed.fields?.find((f) => f.name.includes('Work'));
    expect(staleField?.name).toContain(`· cached <t:${Math.floor(fetchedAtMs / 1000)}:R>`);
    expect(staleField?.value).toContain('⚠️ usage endpoint rate-limited (429)');
    const liveField = embed.fields?.find((f) => f.name.includes('Play'));
    expect(liveField?.name).not.toContain('cached');
    expect(liveField?.value).not.toContain('⚠️');
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

describe('emoji-width overflow fallback', () => {
  // A real custom-emoji cell is a ~25-char mention (`<:name:id>`); enough of them push a
  // field past Discord's 1024-char ceiling, and discord.js then rejects the WHOLE embed
  // (the live failure mode: /timeline dead once emoji bars were enabled). The builders must
  // fall back to the 1-char unicode cells instead — same information, plainer glyphs.
  const WIDE_CELL = '<:pb_mf_g:123456789012345678>';
  const wideBar = (): string => WIDE_CELL.repeat(12);
  const wideTrack = {
    session: WIDE_CELL,
    weekly: WIDE_CELL,
    both: WIDE_CELL,
    track: (): string => WIDE_CELL.repeat(24),
  };
  const NOW = Date.parse('2026-07-16T12:00:00.000Z');
  const accounts = [
    account({
      limits: [
        { kind: 'session', percent: 42, isActive: true, resetsAt: '2026-07-16T14:00:00.000Z' },
        { kind: 'weekly_all', percent: 30, isActive: true, resetsAt: '2026-07-17T14:00:00.000Z' },
      ],
    }),
  ];

  it('buildTimelineEmbed falls back to unicode when emoji cells would overflow a field', () => {
    const embed = buildTimelineEmbed({ accounts }, NOW, wideBar, wideTrack).toJSON();
    for (const field of embed.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const field = embed.fields?.find((f) => f.name.includes('Work'));
    expect(field?.value).toContain('🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ window open');
    expect(field?.value).not.toContain(WIDE_CELL);
  });

  it('buildUsageEmbed falls back to unicode when emoji bars would overflow a field', () => {
    const embed = buildUsageEmbed(
      {
        accounts: [
          account({
            limits: [
              { kind: 'session', percent: 42, isActive: true },
              { kind: 'weekly_all', percent: 30, isActive: true },
              { kind: 'weekly_scoped', percent: 10, isActive: true },
            ],
          }),
        ],
      },
      NOW,
      wideBar,
    ).toJSON();
    const field = embed.fields?.[0];
    expect(field?.value.length).toBeLessThanOrEqual(1024);
    expect(field?.value).toContain('🟩🟩🟩🟩⬜⬜⬜⬜⬜⬜ session 42%');
    expect(field?.value).not.toContain(WIDE_CELL);
  });

  it('keeps the preferred emoji cells when the field fits', () => {
    const embed = buildUsageEmbed({ accounts: [account()] }, NOW, wideBar).toJSON();
    expect(embed.fields?.[0]?.value).toContain(WIDE_CELL);
  });
});

describe('buildAccountsEmbed', () => {
  it('lists each account with its source', () => {
    const embed = buildAccountsEmbed([account({ source: 'cached' })]).toJSON();
    expect(embed.fields).toHaveLength(1);
    expect(embed.fields?.[0]?.value).toContain('cached');
  });

  it('shows the true fetch age and failure reason for cached data, neither for live', () => {
    const fetchedAtMs = Date.parse('2026-07-16T10:00:00.000Z');
    const embed = buildAccountsEmbed([
      account({ source: 'cached', fetchedAtMs, error: 'usage endpoint rate-limited (429)' }),
      account({ accountId: 'acct-2', label: 'Play', active: false }),
    ]).toJSON();
    expect(embed.fields?.[0]?.value).toContain(`cached (<t:${Math.floor(fetchedAtMs / 1000)}:R>)`);
    expect(embed.fields?.[0]?.value).toContain('⚠️ usage endpoint rate-limited (429)');
    expect(embed.fields?.[1]?.value).toBe('idle · source: live');
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

  it('is an actionable (warn) card in default mode, with no mode note', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf', undefined, 'default').toJSON();
    expect(embed.title).toBe('Permission requested');
    expect(embed.color).toBe(0xf1c40f);
    expect(embed.footer?.text).toMatch(/approve or deny/i);
    expect(embed.footer?.text).not.toContain('mode');
  });

  it('stays actionable in a non-default mode and names the mode as context', () => {
    // Accept-edits auto-approves file edits but still prompts (and the daemon still holds)
    // for shell commands — so the card keeps its approve/deny copy in every mode.
    const embed = buildPermissionRequestEmbed('run rm -rf', undefined, 'acceptEdits').toJSON();
    expect(embed.title).toBe('Permission requested');
    expect(embed.color).toBe(0xf1c40f);
    expect(embed.footer?.text).toMatch(/approve or deny/i);
    expect(embed.footer?.text).toContain('acceptEdits mode');
    expect(embed.description).toBe('run rm -rf');
  });

  it('treats an absent mode as a plain actionable card', () => {
    const embed = buildPermissionRequestEmbed('run rm -rf').toJSON();
    expect(embed.title).toBe('Permission requested');
    expect(embed.footer?.text).not.toContain('mode');
  });
});

describe('buildLapsedPermissionEmbed', () => {
  it('picks the right title per reason', () => {
    expect(buildLapsedPermissionEmbed('local').toJSON().title).toBe('Handled at the terminal');
    expect(buildLapsedPermissionEmbed('expired').toJSON().title).toBe(
      'Expired — answer at the terminal',
    );
    expect(buildLapsedPermissionEmbed('shutdown').toJSON().title).toBe('Daemon stopped');
  });

  it('recolors to the muted accent regardless of reason', () => {
    expect(buildLapsedPermissionEmbed('expired').toJSON().color).toBe(0x95a5a6);
  });

  it('preserves the original embed content (summary, detail, footer) — only title/color change', () => {
    const original = buildPermissionRequestEmbed(
      'run rm -rf',
      'in /tmp/scratch',
      'default',
    ).toJSON();
    const lapsed = buildLapsedPermissionEmbed('expired', original).toJSON();
    expect(lapsed.description).toBe('run rm -rf');
    expect(lapsed.fields?.[0]?.value).toBe('in /tmp/scratch');
    expect(lapsed.title).toBe('Expired — answer at the terminal');
    expect(lapsed.color).toBe(0x95a5a6);
  });

  it('still produces a valid card with no original embed', () => {
    const lapsed = buildLapsedPermissionEmbed('shutdown').toJSON();
    expect(lapsed.title).toBe('Daemon stopped');
    expect(lapsed.description).toBeUndefined();
  });
});

describe('buildQuestionEmbed', () => {
  const twoQuestions = [
    { question: 'Which color do you prefer?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }] },
    { question: 'Anything else?', multiSelect: false, options: [{ label: 'No' }] },
  ];

  it('is a warn card, one field per question, header (or ordinal) as the name', () => {
    const embed = buildQuestionEmbed(twoQuestions).toJSON();
    expect(embed.title).toBe('Claude has questions');
    expect(embed.color).toBe(0xf1c40f);
    expect(embed.fields?.[0]?.name).toBe('Color'); // header preferred
    expect(embed.fields?.[0]?.value).toBe('Which color do you prefer?');
    expect(embed.fields?.[1]?.name).toBe('Question 2'); // no header → ordinal
    expect(embed.fields?.[1]?.value).toBe('Anything else?');
  });

  it('uses the singular title for one question and names a non-default mode', () => {
    const embed = buildQuestionEmbed([twoQuestions[0]!], 'plan').toJSON();
    expect(embed.title).toBe('Claude has a question');
    expect(embed.footer?.text).toContain('plan mode');
  });

  it('omits the mode note in default mode', () => {
    const embed = buildQuestionEmbed([twoQuestions[0]!], 'default').toJSON();
    expect(embed.footer?.text).not.toContain('mode');
  });

  it('renders at most four questions', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      question: `q${i}`,
      multiSelect: false,
      options: [{ label: 'a' }],
    }));
    expect(buildQuestionEmbed(many).toJSON().fields).toHaveLength(4);
  });
});

describe('buildAnsweredQuestionEmbed', () => {
  it('is a success card listing chosen labels and the typed Other on a marked line', () => {
    const embed = buildAnsweredQuestionEmbed([
      { question: 'Which color?', selected: ['Green'] },
      { question: 'Which sizes?', selected: ['S', 'L'], otherText: 'XXL' },
    ]).toJSON();
    expect(embed.title).toBe('Answered');
    expect(embed.color).toBe(0x2ecc71);
    expect(embed.fields?.[0]?.value).toBe('• Green');
    expect(embed.fields?.[1]?.value).toBe('• S\n• L\n✏️ XXL');
  });

  it('shows a placeholder for an answer with no selection', () => {
    const embed = buildAnsweredQuestionEmbed([{ question: 'q', selected: [] }]).toJSON();
    expect(embed.fields?.[0]?.value).toBe('(no selection)');
  });
});

describe('buildLapsedQuestionEmbed', () => {
  it('picks the right title per reason and recolors muted', () => {
    expect(buildLapsedQuestionEmbed('local').toJSON().title).toBe('Answered at the terminal');
    expect(buildLapsedQuestionEmbed('expired').toJSON().title).toBe(
      'Expired — continuing without answers',
    );
    expect(buildLapsedQuestionEmbed('shutdown').toJSON().title).toBe('Daemon stopped');
    expect(buildLapsedQuestionEmbed('expired').toJSON().color).toBe(0x95a5a6);
  });

  it('preserves the original card content — only title/color change', () => {
    const original = buildQuestionEmbed([
      { question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Red' }] },
    ]).toJSON();
    const lapsed = buildLapsedQuestionEmbed('local', original).toJSON();
    expect(lapsed.fields?.[0]?.value).toBe('Which color?');
    expect(lapsed.title).toBe('Answered at the terminal');
    expect(lapsed.color).toBe(0x95a5a6);
  });
});

describe('buildToolOutputEmbed', () => {
  it('renders the fenced preview with the origin tag as the footer', () => {
    const embed = buildToolOutputEmbed({
      title: 'Output — ls',
      preview: 'files',
      attached: false,
      totalChars: 5,
      footer: 'proj · abcd1234',
    }).toJSON();
    expect(embed.title).toBe('Output — ls');
    expect(embed.description).toBe('```\nfiles\n```');
    expect(embed.footer?.text).toBe('proj · abcd1234');
  });

  it('notes the tap-to-expand attachment when the preview was clipped, and omits an empty footer', () => {
    const embed = buildToolOutputEmbed({
      title: 'Output — big',
      preview: 'x\n…',
      attached: true,
      totalChars: 5000,
    }).toJSON();
    expect(embed.description).toContain('full output attached (5000 chars)');
    expect(embed.description).toContain('tap to expand');
    expect(embed.footer ?? undefined).toBeUndefined();
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

describe('clampFieldValue', () => {
  it('passes short values through untouched', () => {
    expect(clampFieldValue('line1\nline2')).toBe('line1\nline2');
  });

  it('drops whole trailing lines and reports how many were cut', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line ${i} `.padEnd(100, 'x'));
    const clamped = clampFieldValue(lines.join('\n'));
    expect(clamped.length).toBeLessThanOrEqual(1024);
    expect(clamped).toContain('line 0');
    // No partial line survives — a cut mid-line would break emoji-sprite tokens on screen.
    expect(clamped).toMatch(/… \+\d+ more$/);
    for (const kept of clamped.split('\n').slice(0, -1)) expect(lines).toContain(kept);
  });

  it('hard-truncates a single line that alone exceeds the cap', () => {
    const clamped = clampFieldValue('y'.repeat(3000));
    expect(clamped.length).toBe(1024);
    expect(clamped.endsWith('…')).toBe(true);
  });
});

describe('embed field overflow (regression)', () => {
  // FOUR 3-limit accounts × emoji-sprite marks (~28 raw chars per token) push the
  // "Upcoming resets" value past Discord's 1024 cap, and discord.js VALIDATES at addFields
  // time — so `/timeline` would throw instead of rendering. Rebuild that exact shape and
  // require it to degrade: first to unicode marks (everything still shown), and only past
  // that to the line-dropping clamp.
  const NOW = Date.parse('2026-07-17T12:00:00.000Z');
  const spriteToken = '<:tl_ms:1384311055791234567>'; // realistic 19-digit-snowflake length
  const spriteStyle = {
    track: () => spriteToken.repeat(12),
    session: spriteToken,
    weekly: spriteToken,
    both: spriteToken,
  };
  const fleet = ['legoboy', 'jina25', 'tjin.29', 'debate'].map((label, i) =>
    account({
      accountId: `acct-${label}`,
      label,
      active: label === 'tjin.29',
      limits: [
        { kind: 'session', percent: 40 + i, isActive: true, resetsAt: '2026-07-17T14:00:00.000Z' },
        {
          kind: 'weekly_all',
          percent: 60 + i,
          isActive: true,
          resetsAt: '2026-07-20T12:00:00.000Z',
        },
        {
          kind: 'weekly_scoped',
          percent: 20 + i,
          isActive: true,
          resetsAt: '2026-07-21T12:00:00.000Z',
        },
      ],
    }),
  );

  it('renders /timeline for a 4-account fleet with sprite marks instead of throwing', () => {
    const embed = buildTimelineEmbed({ accounts: fleet }, NOW, undefined, spriteStyle).toJSON();
    for (const field of embed.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    const upcoming = embed.fields?.find((f) => f.name === 'Upcoming resets');
    // The sprite render overflows, so the field falls back to unicode marks — which fit,
    // keeping EVERY event visible instead of dropping the far tail.
    expect(upcoming?.value).not.toContain(spriteToken);
    for (const label of ['legoboy', 'jina25', 'tjin.29', 'debate']) {
      expect(upcoming?.value).toContain(`**${label}**`);
    }
  });

  it('clamps with a visible "+N more" marker once even the unicode render overflows', () => {
    // A fleet big enough that 1-char unicode marks still cross the cap (12 accounts × 3
    // limits ≈ 36 event lines). The clamp cuts the far tail, keeping the soonest resets.
    const bigFleet = Array.from({ length: 12 }, (_, i) =>
      account({
        accountId: `acct-${i}`,
        label: `account-${i}`,
        active: i === 0,
        limits: [
          { kind: 'session', percent: 40, isActive: true, resetsAt: '2026-07-17T14:00:00.000Z' },
          {
            kind: 'weekly_all',
            percent: 60,
            isActive: true,
            resetsAt: '2026-07-20T12:00:00.000Z',
          },
          {
            kind: 'weekly_scoped',
            percent: 20,
            isActive: true,
            resetsAt: '2026-07-21T12:00:00.000Z',
          },
        ],
      }),
    );
    const embed = buildTimelineEmbed({ accounts: bigFleet }, NOW, undefined, spriteStyle).toJSON();
    const upcoming = embed.fields?.find((f) => f.name === 'Upcoming resets');
    expect(upcoming?.value.length).toBeLessThanOrEqual(1024);
    expect(upcoming?.value).toMatch(/… \+\d+ more$/);
    // Soonest resets (today's 5h windows) survive; they are the actionable ones.
    expect(upcoming?.value).toContain('**account-0**');
  });

  it('renders /usage for the same fleet within field limits', () => {
    const embed = buildUsageEmbed({ accounts: fleet }, NOW).toJSON();
    for (const field of embed.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
  });

  it('clamps an unbounded permission detail instead of throwing', () => {
    const embed = buildPermissionRequestEmbed('run a command', 'x'.repeat(5000)).toJSON();
    expect(embed.fields?.[0]?.value.length).toBeLessThanOrEqual(1024);
  });
});

describe('session card / summary embeds — table re-rendering', () => {
  const TABLE = [
    'Verification verdicts:',
    '┌───────────────────────────────────────────────────┬────────────────────────────────────┐',
    '│                     Inferred                      │             Confirmed              │',
    '├───────────────────────────────────────────────────┼────────────────────────────────────┤',
    '│ Precedence --relay > env > config.json > built-in │ matches what #6 shipped            │',
    '└───────────────────────────────────────────────────┴────────────────────────────────────┘',
  ].join('\n');

  function model(overrides: Partial<SessionCardModel> = {}): SessionCardModel {
    return {
      sessionId: 's1',
      state: 'done',
      stopping: false,
      totalOutputChars: 0,
      attached: false,
      hasGap: false,
      sourceTruncated: false,
      hadError: false,
      ...overrides,
    };
  }

  it('summary embed re-renders a terminal table phone-width inside a fence', () => {
    const embed = buildSessionSummaryEmbed(model({ summary: TABLE })).toJSON();
    const description = embed.description ?? '';
    expect(description).toContain('Verification verdicts:');
    expect(description).toContain('```');
    // The re-rendered box fits a phone-width code block; the 88-column original would not.
    for (const line of description.split('\n').filter((l) => /^[┌│├└]/.test(l))) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(description).toContain('Confirmed');
  });

  it('live card body re-renders a table in the summary the same way', () => {
    const embed = buildSessionCardEmbed(model({ state: 'running', summary: TABLE })).toJSON();
    const description = embed.description ?? '';
    expect(description).toContain('```');
    const boxLines = description.split('\n').filter((l) => /^[┌│├└]/.test(l));
    expect(boxLines.length).toBeGreaterThan(0);
    for (const line of boxLines) expect(line.length).toBeLessThanOrEqual(40);
  });
});
