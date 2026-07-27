import { describe, it, expect } from 'vitest';
import {
  renderAccountsTable,
  renderDaemonStatus,
  renderPacingLine,
  renderTokenStats,
  renderUsage,
  type DaemonStatusView,
  type UsageRow,
} from './render.js';
import { ANSI_PALETTE, pacingStyle, PLAIN_PALETTE } from './ansi.js';
import type { StoredAccount } from '@claude-control/switch-engine';
import type {
  AccountUsage,
  TokenStatsSnapshot,
  TokenTotals,
} from '@claude-control/shared-protocol';
import type { AccountUsageInput } from '@claude-control/usage-advisor';

/** Remove ANSI SGR codes — used to prove color never changes the visible text/layout. */
// eslint-disable-next-line no-control-regex -- matching ESC codes is the whole point
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, '');

function acct(id: string, label: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label, quarantined: false, createdAtMs: 0, updatedAtMs: 0, ...extra };
}

describe('renderAccountsTable', () => {
  it('prompts to add when empty', () => {
    expect(renderAccountsTable([], null)).toMatch(/No accounts yet/);
  });

  it('marks the active account and shows quarantine status', () => {
    const out = renderAccountsTable(
      [
        acct('id-1', 'Work', { emailAddress: 'w@x.com' }),
        acct('id-2', 'Dead', { quarantined: true }),
      ],
      'id-1',
    );
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/LABEL/);
    // Active row carries the '*' marker; quarantined row shows the status.
    expect(out).toMatch(/\*\s+Work/);
    expect(out).toMatch(/quarantined/);
  });

  it('colors quarantine red under a palette without disturbing column alignment', () => {
    const accounts = [
      acct('id-1', 'Work', { emailAddress: 'w@x.com' }),
      acct('id-2', 'Dead', { quarantined: true }),
    ];
    const plain = renderAccountsTable(accounts, 'id-1');
    const colored = renderAccountsTable(accounts, 'id-1', ANSI_PALETTE);
    expect(colored).toContain(ANSI_PALETTE.red('quarantined'));
    // Zero-width contract: stripping the codes reproduces the plain table exactly.
    expect(stripAnsi(colored)).toBe(plain);
  });

  describe('PLAN column', () => {
    it('shows the derived weight when a rate-limit tier is present', () => {
      const out = renderAccountsTable(
        [acct('id-1', 'Work', { organizationRateLimitTier: 'default_claude_max_20x' })],
        null,
      );
      expect(out).toMatch(/PLAN/);
      expect(out).toMatch(/\bWork\s+.*\s20x\b/);
    });

    it('shows "?" — not a fabricated 1x — when no plan-tier signal is present', () => {
      const out = renderAccountsTable([acct('id-1', 'Fresh')], null);
      const dataLine = out.split('\n')[1];
      expect(dataLine).toMatch(/\?/);
    });
  });

  describe('BILLING column', () => {
    const NOW = Date.parse('2026-07-25T00:00:00.000Z');

    it('renders "unknown" when billingType was never captured', () => {
      const out = renderAccountsTable([acct('id-1', 'Fresh')], null, PLAIN_PALETTE, NOW);
      expect(out.split('\n')[1]).toMatch(/unknown/);
    });

    it('estimates the next monthly anniversary from subscriptionCreatedAt, clearly labeled', () => {
      const out = renderAccountsTable(
        [
          acct('id-1', 'Work', {
            billingType: 'stripe_subscription',
            subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
          }),
        ],
        null,
        PLAIN_PALETTE,
        NOW,
      );
      // Anchored on the 15th, "now" is the 25th, so the next anniversary is Aug 15 - and it
      // must carry an explicit estimate marker, never read as a bare fact.
      expect(out).toMatch(/~Aug 15 \(est\.\)/);
    });

    it("prioritizes a live trial's end date over any billing estimate", () => {
      const out = renderAccountsTable(
        [
          acct('id-1', 'Trialing', {
            billingType: 'stripe_subscription',
            subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
            claudeCodeTrialEndsAt: '2026-08-01T00:00:00.000Z',
          }),
        ],
        null,
        PLAIN_PALETTE,
        NOW,
      );
      expect(out).toMatch(/trial->Aug 1\b/);
      expect(out).not.toMatch(/est\./);
    });

    it('shows an unrecognized billingType verbatim rather than fabricating a date', () => {
      const out = renderAccountsTable(
        [acct('id-1', 'Weird', { billingType: 'some_future_type' })],
        null,
        PLAIN_PALETTE,
        NOW,
      );
      expect(out.split('\n')[1]).toMatch(/some_future_type/);
    });

    /** The BILLING cell for one account, isolated from column padding. */
    const billing = (extra: Partial<StoredAccount>, nowMs = NOW): string => {
      const line = renderAccountsTable(
        [acct('id-1', 'Work', extra)],
        null,
        PLAIN_PALETTE,
        nowMs,
      ).split('\n')[1];
      return line ?? '';
    };

    it('keeps the anniversary day for subscriptions created on the 29th-31st', () => {
      // Regression: rolling the estimate forward by mutating one Date with setUTCMonth let a
      // short month overflow the day (Jan 31 -> Mar 3), and because each step rolled from the
      // PREVIOUS corrupted value the damage compounded instead of correcting. A Jan 31
      // subscription rendered ~Aug 3 when the real next anniversary is Jul 31 — over a month
      // out, in the wrong month entirely, for roughly a tenth of all subscribers.
      for (const [createdAt, expected] of [
        ['2025-01-31T12:00:00.000Z', 'Jul 31'],
        ['2025-03-31T12:00:00.000Z', 'Jul 31'],
        ['2025-01-29T12:00:00.000Z', 'Jul 29'],
        ['2025-01-30T12:00:00.000Z', 'Jul 30'],
        ['2025-08-15T12:00:00.000Z', 'Aug 15'],
      ] as const) {
        expect(
          billing({ billingType: 'stripe_subscription', subscriptionCreatedAt: createdAt }),
          createdAt,
        ).toContain(`~${expected} (est.)`);
      }
    });

    it('clamps to the last day of a short target month rather than spilling into the next', () => {
      // A Jan 31 subscription billed in February can only land on Feb 28 — never Mar 3.
      expect(
        billing(
          { billingType: 'stripe_subscription', subscriptionCreatedAt: '2025-01-31T12:00:00.000Z' },
          Date.parse('2026-02-01T00:00:00.000Z'),
        ),
      ).toContain('~Feb 28 (est.)');
    });

    it('renders "unknown" for a malformed subscriptionCreatedAt instead of a bogus date', () => {
      for (const bad of ['not-a-date', '', '2026-13-45T00:00:00.000Z']) {
        expect(billing({ billingType: 'stripe_subscription', subscriptionCreatedAt: bad })).toMatch(
          /unknown/,
        );
      }
    });

    it('renders "unknown" rather than hanging when the caller passes a non-finite clock', () => {
      // The estimate walks candidate anniversaries forward until one passes `nowMs`. A NaN or
      // Infinity `nowMs` makes that comparison unsatisfiable, so an unguarded loop would spin
      // forever and wedge the CLI instead of failing.
      for (const badNow of [Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(
          billing(
            {
              billingType: 'stripe_subscription',
              subscriptionCreatedAt: '2026-01-15T12:00:00.000Z',
            },
            badNow,
          ),
        ).toMatch(/unknown/);
      }
    });

    it('falls through an EXPIRED trial to the billing estimate', () => {
      // A trial end in the past is no longer the next billing event; continuing to show it
      // would tell the user a date that has already gone by.
      const cell = billing({
        billingType: 'stripe_subscription',
        subscriptionCreatedAt: '2026-01-15T12:00:00.000Z',
        claudeCodeTrialEndsAt: '2026-02-01T00:00:00.000Z',
      });
      expect(cell).toContain('~Aug 15 (est.)');
      expect(cell).not.toContain('trial->');
    });

    it('caps an unbounded upstream billingType so one odd value cannot stretch the table', () => {
      const long = 'x'.repeat(300);
      const line = billing({ billingType: long });
      expect(line).not.toContain(long);
      expect(line).toContain('...');
      expect(line.length).toBeLessThan(140);
    });

    it('never colors a billing estimate as if it were fact — plain dim, no red/green', () => {
      const accounts = [
        acct('id-1', 'Work', {
          billingType: 'stripe_subscription',
          subscriptionCreatedAt: '2026-07-15T20:35:34.215673Z',
        }),
      ];
      const plain = renderAccountsTable(accounts, 'id-1', PLAIN_PALETTE, NOW);
      const colored = renderAccountsTable(accounts, 'id-1', ANSI_PALETTE, NOW);
      expect(stripAnsi(colored)).toBe(plain);
    });
  });
});

describe('renderUsage', () => {
  const NOW = 1_000_000_000;
  const usage = (over: Partial<AccountUsage> = {}): AccountUsage => ({
    accountId: 'a',
    label: 'Work',
    active: true,
    source: 'live',
    fetchedAtMs: NOW - 3 * 60_000, // 3 minutes ago
    limits: [
      { kind: 'session', percent: 45, isActive: true },
      { kind: 'weekly_all', percent: 30, isActive: true },
    ],
    ...over,
  });

  it('shows source, staleness, and per-limit percentages', () => {
    const rows: UsageRow[] = [{ label: 'Work', active: true, usage: usage() }];
    const out = renderUsage(rows, NOW);
    expect(out).toMatch(/\* Work/); // active marker
    expect(out).toMatch(/live, 3m ago/); // source + staleness
    expect(out).toMatch(/5h 45%/); // session limit
    expect(out).toMatch(/week 30%/); // weekly limit
  });

  it('appends the 5h-window budget when reset times are known', () => {
    // Open window ends in 2h, weekly resets in 12h: the open window + two more = 3.
    const rows: UsageRow[] = [
      {
        label: 'Work',
        active: true,
        usage: usage({
          limits: [
            {
              kind: 'session',
              percent: 45,
              isActive: true,
              resetsAt: new Date(NOW + 2 * 3_600_000).toISOString(),
            },
            {
              kind: 'weekly_all',
              percent: 30,
              isActive: true,
              resetsAt: new Date(NOW + 12 * 3_600_000).toISOString(),
            },
          ],
        }),
      },
    ];
    expect(renderUsage(rows, NOW)).toMatch(/· 3x5h left/);
  });

  it('omits the window budget when no weekly reset time is known', () => {
    const rows: UsageRow[] = [{ label: 'Work', active: true, usage: usage() }];
    expect(renderUsage(rows, NOW)).not.toMatch(/x5h left/);
  });

  it('labels a cached reading as cached so it is not mistaken for fresh', () => {
    const rows: UsageRow[] = [
      { label: 'Reserve', active: false, usage: usage({ source: 'cached', label: 'Reserve' }) },
    ];
    expect(renderUsage(rows, NOW)).toMatch(/cached, 3m ago/);
  });

  it('prompts to start the daemon when an account has no snapshot yet', () => {
    const rows: UsageRow[] = [{ label: 'Fresh', active: false, usage: undefined }];
    expect(renderUsage(rows, NOW)).toMatch(/no usage data yet/);
  });

  it('prompts to add accounts when empty', () => {
    expect(renderUsage([], NOW)).toMatch(/No accounts yet/);
  });

  it('colors percents by severity under a palette, plain text unchanged', () => {
    const rows: UsageRow[] = [
      {
        label: 'Work',
        active: true,
        usage: usage({
          error: 'refresh failed',
          limits: [
            { kind: 'session', percent: 45, isActive: true }, // ok → green
            { kind: 'weekly_all', percent: 97, isActive: true }, // critical → red
          ],
        }),
      },
    ];
    const plain = renderUsage(rows, NOW);
    const colored = renderUsage(rows, NOW, ANSI_PALETTE);
    expect(colored).toContain(ANSI_PALETTE.green('45%'));
    expect(colored).toContain(ANSI_PALETTE.red('97%'));
    expect(colored).toContain(ANSI_PALETTE.red('[refresh failed]'));
    expect(colored).toContain(ANSI_PALETTE.green('*'));
    expect(stripAnsi(colored)).toBe(plain);
  });
});

describe('renderPacingLine', () => {
  const NOW = Date.parse('2026-07-16T12:00:00.000Z');
  const DAY_MS = 24 * 60 * 60 * 1000;

  function input(accountId: string, percent: number, resetInDays?: number): AccountUsageInput {
    return {
      accountId,
      label: accountId,
      active: false,
      quarantined: false,
      weight: 20,
      limits: [
        {
          kind: 'weekly_all',
          percent,
          ...(resetInDays !== undefined ? { resetsAt: NOW + resetInDays * DAY_MS } : {}),
        },
      ],
    };
  }

  it('prints the verdict marker, headroom and a waste line under a "Pacing: " prefix', () => {
    const line = renderPacingLine([input('a', 50, 3)], { nowMs: NOW, burnUnitsPerDay: 2 });
    expect(line).toBe(
      [
        'Pacing: [ok] 10u/20u (50%) - burn 2u/d < 2.9u/d - 14d',
        '  waste 10u: soonest a in 3d',
      ].join('\n'),
    );
  });

  it('counts a dormant account at full allowance instead of dropping it', () => {
    // The account with no reset time used to be excluded outright, which inverted the verdict.
    const line = renderPacingLine([input('idle', 0), input('busy', 80, 2)], {
      nowMs: NOW,
      burnUnitsPerDay: 1,
    });
    expect(line).toContain('24u/40u (60%)');
  });

  it('is one line, with no caveats, when nothing is wasted and tiers are known', () => {
    const line = renderPacingLine([input('a', 50, 3)], { nowMs: NOW });
    expect(line).toBe('Pacing: [--] 10u/20u (50%) - burn unmeasured - replenish 2.9u/d');
  });

  it('reports pacing unknown with no accounts', () => {
    expect(renderPacingLine([], { nowMs: NOW })).toBe('Pacing: no usage data yet.');
  });

  it('tells a wholly quarantined fleet to re-login instead of claiming there is no data', () => {
    const locked = [input('a', 50, 3), input('b', 10, 5)].map((i) => ({ ...i, quarantined: true }));
    const line = renderPacingLine(locked, { nowMs: NOW, burnUnitsPerDay: 1 });
    expect(line).toBe(
      'Pacing: [--] no usable accounts - a, b quarantined; run: cctl accounts relogin <label>',
    );
  });

  it('paints the locked-out marker yellow: there is a command to run (see ansi.ts)', () => {
    const locked = [{ ...input('a', 50, 3), quarantined: true }];
    const opts = { nowMs: NOW, burnUnitsPerDay: 1 };
    const colored = renderPacingLine(locked, opts, pacingStyle(ANSI_PALETTE));
    expect(colored).toContain(ANSI_PALETTE.yellow('[--]'));
    expect(stripAnsi(colored)).toBe(renderPacingLine(locked, opts));
  });

  it('colors the marker, headroom and waste line when given an ANSI style, and stays plain by default', () => {
    const opts = { nowMs: NOW, burnUnitsPerDay: 2 };
    const plain = renderPacingLine([input('a', 50, 3)], opts);
    const colored = renderPacingLine([input('a', 50, 3)], opts, pacingStyle(ANSI_PALETTE));
    expect(colored).not.toBe(plain);
    expect(colored).toContain(ANSI_PALETTE.green('[ok]'));
    expect(colored).toContain(ANSI_PALETTE.yellow('waste 10u: soonest a in 3d'));
    // Color never changes the visible text, only wraps it.
    expect(stripAnsi(colored)).toBe(plain);
    // The identity style (what every command falls back to off a TTY / under NO_COLOR) is
    // byte-for-byte the same as passing no style at all.
    expect(renderPacingLine([input('a', 50, 3)], opts, pacingStyle(PLAIN_PALETTE))).toBe(plain);
  });
});

describe('renderDaemonStatus', () => {
  const healthy: DaemonStatusView = {
    task: { registered: true, state: 'Ready' },
    heartbeat: { state: 'alive', writtenAtMs: 0, ageMs: 5_000 },
    paired: true,
    relayUrl: 'wss://relay.example.com',
  };

  it('reports every dimension as ok on a fully healthy daemon', () => {
    const out = renderDaemonStatus(healthy);
    expect(out).toMatch(/logon task registered \(Ready\)/);
    expect(out).toMatch(/daemon alive \(heartbeat just now\)/);
    expect(out).toMatch(/paired with the relay/);
    expect(out).toMatch(/relay:\s+wss:\/\/relay\.example\.com/);
  });

  it('prompts to install when no logon task is registered', () => {
    const out = renderDaemonStatus({ ...healthy, task: { registered: false } });
    expect(out).toMatch(/logon task not registered — run: cctl daemon install/);
  });

  it("says the daemon has never run when the heartbeat state is 'never'", () => {
    const out = renderDaemonStatus({ ...healthy, heartbeat: { state: 'never' } });
    expect(out).toMatch(/daemon has never run on this machine — run: cctl daemon install/);
  });

  it('yellows the never-run mark, since the line hands the reader a command', () => {
    // The `[--]` glyph splits on whether there is something to run, not on which surface prints
    // it — a dim mark here would read as "wait and it will sort itself out".
    const out = renderDaemonStatus({ ...healthy, heartbeat: { state: 'never' } }, ANSI_PALETTE);
    expect(out).toContain(ANSI_PALETTE.yellow('[--]'));
    expect(out).not.toContain(ANSI_PALETTE.dim('[--]'));
  });

  it('explains a stale heartbeat will self-heal at next logon when the task IS registered', () => {
    const out = renderDaemonStatus({
      ...healthy,
      heartbeat: { state: 'stale', writtenAtMs: 0, ageMs: 5 * 60_000 },
    });
    expect(out).toMatch(/daemon not responding/);
    expect(out).toMatch(/will restart at next logon/);
  });

  it('does NOT promise a next-logon restart for a stale heartbeat when no task is registered', () => {
    const out = renderDaemonStatus({
      ...healthy,
      task: { registered: false },
      heartbeat: { state: 'stale', writtenAtMs: 0, ageMs: 5 * 60_000 },
    });
    expect(out).toMatch(/not scheduled to restart — run: cctl daemon install/);
    expect(out).not.toMatch(/will restart at next logon/);
  });

  it('prompts to pair when not paired', () => {
    const out = renderDaemonStatus({ ...healthy, paired: false });
    expect(out).toMatch(/not paired — see: cctl pair/);
  });

  it('colors the alive/ok lines green under a palette without changing the plain text', () => {
    const plain = renderDaemonStatus(healthy);
    const colored = renderDaemonStatus(healthy, ANSI_PALETTE);
    expect(colored).toContain(ANSI_PALETTE.green('[ok]'));
    expect(stripAnsi(colored)).toBe(plain);
  });
});

// ---------------------------------------------------------------------------
// cctl stats
// ---------------------------------------------------------------------------

function totals(over: Partial<TokenTotals> = {}): TokenTotals {
  return { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, turns: 0, ...over };
}

const STATS_END = new Date(2026, 6, 25, 12, 0, 0).getTime();

function stats(over: Partial<TokenStatsSnapshot> = {}): TokenStatsSnapshot {
  return {
    windowStartMs: STATS_END - 7 * 86_400_000,
    windowEndMs: STATS_END,
    overall: totals({
      input: 1000,
      output: 2_000_000,
      cacheCreation: 3000,
      cacheRead: 4_000_000_000,
      turns: 1234,
    }),
    byAccount: [
      { accountId: 'acct-a', label: 'main', totals: totals({ output: 2_000_000, turns: 1000 }) },
      { accountId: null, label: 'unattributed', totals: totals({ output: 500, turns: 234 }) },
    ],
    byModel: [{ label: 'claude-opus-5', totals: totals({ output: 2_000_500, turns: 1234 }) }],
    byDay: [{ label: '2026-07-25', totals: totals({ output: 2_000_500, turns: 1234 }) }],
    coverage: {
      filesScanned: 42,
      filesSkippedByMtime: 400,
      filesUnreadable: 0,
      dirsUnreadable: 0,
      malformedLines: 0,
      duplicateTurns: 99,
    },
    ...over,
  };
}

describe('renderTokenStats', () => {
  it('renders every breakdown with a header and the window it covers', () => {
    const out = renderTokenStats(stats());
    expect(out).toMatch(/Token usage - last 7 days \(2026-07-18 to 2026-07-25\)/);
    expect(out).toMatch(/By account/);
    expect(out).toMatch(/By model/);
    expect(out).toMatch(/By day/);
    expect(out).toMatch(/ACCOUNT/);
    expect(out).toMatch(/CACHE R/);
    expect(out).toMatch(/claude-opus-5/);
  });

  it('renders the unattributed bucket rather than dropping it', () => {
    expect(renderTokenStats(stats())).toMatch(/unattributed/);
  });

  it('states the measurement limits in the output itself, not only the docs', () => {
    const out = renderTokenStats(stats());
    expect(out).toMatch(/THIS machine/);
    expect(out).toMatch(/web app/);
    expect(out).toMatch(/before cctl recorded its first switch/);
    expect(out).toMatch(/not an Anthropic billing figure/);
    expect(out).toMatch(/42 transcript files read/);
    expect(out).toMatch(/400 untouched since the window opened/);
  });

  it('surfaces read failures instead of quietly reporting a partial total', () => {
    const out = renderTokenStats(
      stats({
        coverage: {
          filesScanned: 5,
          filesSkippedByMtime: 0,
          filesUnreadable: 3,
          dirsUnreadable: 1,
          malformedLines: 7,
          duplicateTurns: 0,
        },
      }),
    );
    expect(out).toMatch(/3 could not be read/);
    expect(out).toMatch(/1 project folder could not be read/);
    expect(out).toMatch(/7 malformed lines skipped/);
  });

  it('surfaces the duplicate-turn count so the de-duplication rule can be sanity-checked', () => {
    const out = renderTokenStats(stats({ coverage: { ...stats().coverage, duplicateTurns: 42 } }));
    expect(out).toMatch(/42 duplicate turns skipped/);
  });

  it('says so plainly when the window holds no local turns, keeping the caveats', () => {
    const out = renderTokenStats(
      stats({ overall: totals(), byAccount: [], byModel: [], byDay: [] }),
    );
    expect(out).toMatch(/No Claude Code turns recorded on this machine in this window/);
    expect(out).toMatch(/not an Anthropic billing figure/);
  });

  it('is ASCII-only and plain by default', () => {
    const out = renderTokenStats(stats());
    // eslint-disable-next-line no-control-regex -- asserting there are no escape codes at all
    expect(out).not.toMatch(/\u001b\[/);
    expect(out).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('aligns columns on plain text, so color never shifts the layout', () => {
    const plain = renderTokenStats(stats());
    const colored = renderTokenStats(stats(), ANSI_PALETTE);
    expect(stripAnsi(colored)).toBe(plain);
    // And the numeric columns really are aligned: every data row in a table ends at the same
    // column as its header row.
    const lines = plain.split('\n');
    const headerIndex = lines.findIndex((l) => l.startsWith('ACCOUNT'));
    expect(headerIndex).toBeGreaterThan(-1);
    const header = lines[headerIndex]!;
    expect(lines[headerIndex + 1]!.length).toBe(header.length);
    expect(lines[headerIndex + 2]!.length).toBe(header.length);
  });

  it('marks the unattributed row as a caveat under a palette', () => {
    const colored = renderTokenStats(stats(), ANSI_PALETTE);
    expect(colored).toContain(ANSI_PALETTE.yellow('unattributed'));
  });
});
