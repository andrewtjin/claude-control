import { describe, it, expect } from 'vitest';
import {
  renderAccountHeal,
  renderAccountsTable,
  renderBindingGroups,
  renderBindings,
  renderBindingsFooter,
  renderDaemonStatus,
  renderAmbiguousAlias,
  renderPacingLine,
  renderSessionAliasList,
  renderSessionDetails,
  renderTokenStats,
  renderUsage,
  renderWhere,
  sessionViewJson,
  shellQuote,
  vscodeProfileName,
  type DaemonStatusView,
  type SessionBindingView,
  type SessionView,
  type UsageRow,
} from './render.js';
import { ANSI_PALETTE, pacingStyle, PLAIN_PALETTE } from './ansi.js';
import type { SessionAccountUse, SessionMeta } from '@claude-control/daemon';
import { embeddableFolderPathSource, type StoredAccount } from '@claude-control/switch-engine';
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

  it('shows an auto-switch exclusion in the STATUS column, and quarantine outranks it', () => {
    const out = renderAccountsTable(
      [
        acct('id-1', 'Work'),
        acct('id-2', 'Paused', { autoSwitchExcluded: true }),
        // Both flags set: quarantine is why the account cannot be used at all, so it wins.
        acct('id-3', 'Dead', { quarantined: true, autoSwitchExcluded: true }),
      ],
      'id-1',
    );
    expect(out).toMatch(/Paused\s+.*\bexcluded\b/);
    expect(out).toMatch(/Dead\s+.*\bquarantined\b/);
    expect(out).not.toMatch(/Dead\s+.*\bexcluded\b/);
  });

  it('paints an exclusion dim, never red — it is a choice, not a fault', () => {
    const accounts = [acct('id-1', 'Work'), acct('id-2', 'Paused', { autoSwitchExcluded: true })];
    const plain = renderAccountsTable(accounts, 'id-1');
    const colored = renderAccountsTable(accounts, 'id-1', ANSI_PALETTE);
    expect(colored).toContain(ANSI_PALETTE.dim('excluded'));
    expect(colored).not.toContain(ANSI_PALETTE.red('excluded'));
    expect(stripAnsi(colored)).toBe(plain);
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

  /** A usage row whose session limit resets in 2h and whose weekly limit resets `weeklyInMs`
   *  out — the two clocks the countdown is derived from. */
  function rowsResettingIn(weeklyInMs: number): UsageRow[] {
    return [
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
              resetsAt: new Date(NOW + weeklyInMs).toISOString(),
            },
          ],
        }),
      },
    ];
  }

  it('counts down to the weekly reset in days, not 5h windows', () => {
    // 3 days and change out: the count floors, so the label is a floor on the runway left.
    const out = renderUsage(rowsResettingIn(3 * 86_400_000 + 7 * 3_600_000), NOW);
    expect(out).toMatch(/· 3d left/);
    // The window count is `cctl timeline`'s unit — usage must not make the reader convert.
    expect(out).not.toMatch(/x5h left/);
  });

  it('shows "<1d" rather than "0d" when the weekly reset is hours away', () => {
    // 12h floors to zero whole days, and "0d left" would read as an already-spent budget.
    expect(renderUsage(rowsResettingIn(12 * 3_600_000), NOW)).toMatch(/· <1d left/);
  });

  it('omits the reset countdown when no weekly reset time is known', () => {
    const rows: UsageRow[] = [{ label: 'Work', active: true, usage: usage() }];
    expect(renderUsage(rows, NOW)).not.toMatch(/left/);
  });

  it('counts down to a PREDICTED reset, marked as one, when the endpoint reports none', () => {
    // An account whose weekly window has rolled stops carrying a reset in its snapshot, which
    // is exactly when the history-derived prediction is the only clock there is. The timeline
    // and the phone both count down to it; this view went silent instead.
    const rows: UsageRow[] = [
      { label: 'Work', active: true, usage: usage(), predictedResetAt: NOW + 6 * 86_400_000 },
    ];
    const out = renderUsage(rows, NOW);
    expect(out).toMatch(/· 6d left \(predicted\)/);
  });

  it('lets a real future reset win over a prediction, and drops the mark with it', () => {
    // The prediction is a fallback, never an override: an observed reset is the better clock
    // AND the honest label, so a row carrying both must render the observation unmarked.
    const rows: UsageRow[] = rowsResettingIn(3 * 86_400_000 + 7 * 3_600_000).map((r) => ({
      ...r,
      predictedResetAt: NOW + 6 * 86_400_000,
    }));
    const out = renderUsage(rows, NOW);
    expect(out).toMatch(/· 3d left/);
    expect(out).not.toMatch(/predicted/);
  });

  it('omits the countdown when neither a reported nor a predicted reset exists', () => {
    // A prediction already in the past is not a clock; the shared weekly rule refuses it, and
    // this view must then say nothing rather than count down to a moment that has gone.
    const rows: UsageRow[] = [
      { label: 'Work', active: true, usage: usage(), predictedResetAt: NOW - 86_400_000 },
    ];
    expect(renderUsage(rows, NOW)).not.toMatch(/left/);
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

  it('renders the verdict line, the labelled rows and the unit legend', () => {
    const line = renderPacingLine([input('a', 50, 3)], { nowMs: NOW, burnUnitsPerDay: 2 });
    expect(line).toBe(
      [
        'Pacing  [ok] sustainable past 14d (2u/2.9u burned per day)',
        '  left     10u of 20u (50%)',
        '  expires  a 4u in 3d, then 1 more - 10u total over 14d',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
    );
  });

  it('counts a dormant account at full allowance instead of dropping it', () => {
    // The account with no reset time used to be excluded outright, which inverted the verdict.
    const line = renderPacingLine([input('idle', 0), input('busy', 80, 2)], {
      nowMs: NOW,
      burnUnitsPerDay: 1,
    });
    expect(line).toContain('24u of 40u (60%)');
  });

  it('omits the expires row, but never the legend, when nothing is wasted', () => {
    const line = renderPacingLine([input('a', 50, 3)], { nowMs: NOW });
    expect(line).toBe(
      [
        'Pacing  [--] burn rate not measured yet',
        '  left     10u of 20u (50%)',
        '  1u = one Pro account-week (a Max 20x counts 20)',
      ].join('\n'),
    );
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
    expect(colored).toContain(ANSI_PALETTE.yellow('a 4u in 3d, then 1 more - 10u total over 14d'));
    // The row labels are bold, and the legend dim — the block's two furniture tiers.
    expect(colored).toContain(ANSI_PALETTE.bold('expires'));
    expect(colored).toContain(ANSI_PALETTE.dim('1u = one Pro account-week (a Max 20x counts 20)'));
    // Color never changes the visible text, only wraps it.
    expect(stripAnsi(colored)).toBe(plain);
    // The identity style (what every command falls back to off a TTY / under NO_COLOR) is
    // byte-for-byte the same as passing no style at all.
    expect(renderPacingLine([input('a', 50, 3)], opts, pacingStyle(PLAIN_PALETTE))).toBe(plain);
  });
});

describe('renderDaemonStatus', () => {
  const healthy: DaemonStatusView = {
    task: { supported: true, noun: 'logon task', registered: true, state: 'Ready' },
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
    const out = renderDaemonStatus({
      ...healthy,
      task: { supported: true, noun: 'logon task', registered: false },
    });
    expect(out).toMatch(/logon task not registered — run: cctl daemon install/);
  });

  it("calls the mechanism by the host's own name", () => {
    const unit = {
      supported: true,
      noun: 'systemd user service',
      registered: true,
      state: 'active',
    };
    expect(renderDaemonStatus({ ...healthy, task: unit })).toMatch(
      /systemd user service registered \(active\)/,
    );
    expect(renderDaemonStatus({ ...healthy, task: { ...unit, registered: false } })).toMatch(
      /systemd user service not registered — run: cctl daemon install/,
    );
  });

  it("says the daemon has never run when the heartbeat state is 'never'", () => {
    const out = renderDaemonStatus({ ...healthy, heartbeat: { state: 'never' } });
    expect(out).toMatch(/daemon has never run on this machine — run: cctl daemon install/);
  });

  it('reports a clean stop as stopped, never as not responding, and names the way back', () => {
    const stopped = { state: 'stopped', writtenAtMs: 0, stoppedAtMs: 0, ageMs: 5_000 } as const;
    const registered = renderDaemonStatus({ ...healthy, heartbeat: stopped });
    expect(registered).toMatch(
      /\[--\] daemon stopped cleanly \(just now\) — run: cctl daemon start/,
    );
    expect(registered).not.toMatch(/not responding|daemon alive/);
    const unregistered = renderDaemonStatus({
      ...healthy,
      task: { supported: true, noun: 'logon task', registered: false },
      heartbeat: stopped,
    });
    expect(unregistered).toMatch(/daemon stopped cleanly \(just now\) — run: cctl daemon install/);
    const unsupported = renderDaemonStatus({
      ...healthy,
      task: { supported: false },
      heartbeat: { ...stopped, ageMs: 5 * 60_000 },
    });
    expect(unsupported).toMatch(/daemon stopped cleanly \(5m ago\) — run: cctl daemon supervise/);
    // Yellow like the never-run line: it hands the reader a command.
    expect(renderDaemonStatus({ ...healthy, heartbeat: stopped }, ANSI_PALETTE)).toContain(
      ANSI_PALETTE.yellow('[--]'),
    );
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
      task: { supported: true, noun: 'logon task', registered: false },
      heartbeat: { state: 'stale', writtenAtMs: 0, ageMs: 5 * 60_000 },
    });
    expect(out).toMatch(/not scheduled to restart — run: cctl daemon install/);
    expect(out).not.toMatch(/will restart at next logon/);
  });

  // A platform with no autostart backend (Linux, WSL2 included) is a fact, not a fault: the
  // report says how to run the daemon instead and never points at `cctl daemon install`, which
  // would only print the same fact and exit.
  it('states that autostart is unavailable instead of prompting to install it', () => {
    const out = renderDaemonStatus({ ...healthy, task: { supported: false } });
    expect(out).toMatch(/\[--\] autostart not available on this platform/);
    expect(out).toMatch(/cctl daemon supervise/);
    expect(out).not.toContain('cctl daemon install');
    // The other lines still render on their own.
    expect(out).toMatch(/daemon alive/);
    expect(out).toMatch(/paired with the relay/);
  });

  it('hands the manual start command to a never-run daemon when autostart is unavailable', () => {
    const out = renderDaemonStatus({
      ...healthy,
      task: { supported: false },
      heartbeat: { state: 'never' },
    });
    expect(out).toMatch(/daemon has never run on this machine — run: cctl daemon supervise/);
    expect(out).not.toContain('cctl daemon install');
  });

  it('hands the manual start command to a stale daemon when autostart is unavailable', () => {
    const out = renderDaemonStatus({
      ...healthy,
      task: { supported: false },
      heartbeat: { state: 'stale', writtenAtMs: 0, ageMs: 5 * 60_000 },
    });
    expect(out).toMatch(/not scheduled to restart — run: cctl daemon supervise/);
    expect(out).not.toMatch(/will restart at next logon/);
    expect(out).not.toContain('cctl daemon install');
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

describe('renderAccountHeal', () => {
  it('is empty when nothing was repaired', () => {
    expect(renderAccountHeal({ merged: [], relabelled: [] })).toBe('');
  });

  it('explains each merge and each relabel on its own line, painting only the verb', () => {
    const report = {
      merged: [{ label: 'jina25', keptId: 'keep-1', removedId: 'dup-2' }],
      relabelled: [{ id: 'x-3', from: 'jina25', to: 'jina25 (2)' }],
    };
    expect(renderAccountHeal(report)).toBe(
      'merged duplicate account jina25: kept keep-1, removed dup-2 (the same login was stored twice)\n' +
        'renamed account jina25 (x-3) to "jina25 (2)": another account already had that label\n',
    );
    const ESC = String.fromCharCode(27);
    const painted = renderAccountHeal(report, ANSI_PALETTE);
    expect(painted.startsWith(`${ESC}[33mmerged${ESC}[0m duplicate account jina25`)).toBe(true);
    expect(painted).toContain(`\n${ESC}[33mrenamed${ESC}[0m account jina25 (x-3)`);
  });
});

describe('renderBindingGroups', () => {
  const group = {
    label: 'work + client',
    folders: ['C:\\repos\\work', 'C:\\repos\\client'],
    members: [
      { label: 'work@me.com', live: true, quarantined: false, excluded: false },
      { label: 'client@me.com', live: false, quarantined: false, excluded: true },
    ],
    profileDir: 'C:\\data\\profiles\\g1',
    noWorkingAccount: false,
  };

  it('lists folders, members with the live one marked, and the profile dir', () => {
    const out = renderBindingGroups([group], PLAIN_PALETTE);
    expect(out).toContain('work + client');
    expect(out).toContain('folder:  C:\\repos\\work');
    expect(out).toContain('folder:  C:\\repos\\client');
    expect(out).toContain('*work@me.com');
    expect(out).toContain('client@me.com (excluded)');
    expect(out).toContain('profile: C:\\data\\profiles\\g1');
  });

  it('returns empty string when there are no groups', () => {
    expect(renderBindingGroups([], PLAIN_PALETTE)).toBe('');
  });

  it('flags a binding with no folder and no session, with the command that releases it', () => {
    const out = renderBindingGroups(
      [{ ...group, id: 'g-1', folders: [], aliases: [] }],
      PLAIN_PALETTE,
    );
    expect(out).toContain('scope:   none — this binding routes nothing');
    expect(out).toContain('cctl unbind --group g-1');
    // A binding with a scope never carries the line.
    expect(renderBindingGroups([group], PLAIN_PALETTE)).not.toContain('scope:');
  });

  it('flags a group with no working account', () => {
    const dead = { ...group, members: [], noWorkingAccount: true };
    expect(renderBindingGroups([dead], PLAIN_PALETTE)).toContain('none usable');
  });

  it('strips terminal control/bidi sequences from labels and folders', () => {
    const evil = {
      ...group,
      // A label that keeps "work" readable once the leading ESC (which starts an SGR sequence) and a
      // bidi override are stripped.
      label: '\u001b[31mwork\u202e',
      folders: ['C:\\r\u200eepos'],
      members: [{ label: 'a\u0007b', live: false, quarantined: false, excluded: false }],
      profileDir: 'C:\\p',
    };
    const out = renderBindingGroups([evil], PLAIN_PALETTE);
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u202e');
    expect(out).not.toContain('\u200e');
    expect(out).not.toContain('\u0007');
    // The ESC byte is gone but the "[31m" text would remain; here the label is ESC-led so "work"
    // survives cleanly.
    expect(out).toContain('work');
  });
});

describe('renderBindings', () => {
  it('shows a helpful message when nothing is bound', () => {
    const out = renderBindings(
      { groups: [], footer: { present: false, fresh: false, enforce: 'block' } },
      PLAIN_PALETTE,
    );
    expect(out).toContain('No folder-bound accounts');
  });

  it('reports a stale snapshot', () => {
    const out = renderBindings(
      {
        groups: [
          {
            label: 'g',
            folders: ['C:\\x'],
            members: [{ label: 'a', live: true, quarantined: false, excluded: false }],
            profileDir: 'C:\\p',
            noWorkingAccount: false,
          },
        ],
        footer: { present: true, fresh: false, enforce: 'warn' },
      },
      PLAIN_PALETTE,
    );
    expect(out).toContain('enforcement: warn');
    expect(out).toContain('STALE');
  });

  it('reports a fresh snapshot', () => {
    const out = renderBindingsFooter(
      { present: true, fresh: true, enforce: 'block' },
      PLAIN_PALETTE,
    );
    expect(out).toContain('fresh');
  });

  it('reports a missing snapshot', () => {
    const out = renderBindingsFooter(
      { present: false, fresh: false, enforce: 'block' },
      PLAIN_PALETTE,
    );
    expect(out).toContain('missing');
  });
});

describe('renderWhere', () => {
  it('explains a bound folder with the env line and a VS Code snippet', () => {
    const out = renderWhere(
      {
        folder: 'C:\\repos\\work',
        bound: {
          groupLabel: 'work',
          matchedFolder: 'C:\\repos\\work',
          members: ['work@me.com'],
          profileDir: 'C:\\data\\profiles\\g1',
          liveMemberLabel: 'work@me.com',
        },
      },
      PLAIN_PALETTE,
    );
    expect(out).toContain('runs on: work (work@me.com)');
    expect(out).toContain('CLAUDE_CONFIG_DIR=C:\\data\\profiles\\g1');
    // The extension's setting is machine-scoped: a folder's .vscode/settings.json is ignored, so the
    // advice is a VS Code profile whose USER settings carry it, never the workspace file.
    expect(out).toContain('USER settings only');
    expect(out).toContain("code --profile 'cctl-work' 'C:\\repos\\work'");
    expect(out).toContain('Open User Settings (JSON)');
    // The printed snippet must parse and carry the extension's array-of-{name,value} shape.
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed['claudeCode.environmentVariables']).toEqual([
      { name: 'CLAUDE_CONFIG_DIR', value: 'C:\\data\\profiles\\g1' },
    ]);
  });

  it('quotes the VS Code command for the shell, whatever the folder or label holds', () => {
    const out = renderWhere(
      {
        folder: "C:\\it's $HOME",
        bound: {
          groupLabel: 'Work "Main"',
          matchedFolder: "C:\\it's $HOME",
          members: ['w'],
          profileDir: 'C:\\p',
          liveMemberLabel: 'w',
        },
      },
      PLAIN_PALETTE,
      'win32',
    );
    // PowerShell single quotes: nothing expands inside, a quote is doubled.
    expect(out).toContain("code --profile 'cctl-Work-Main' 'C:\\it''s $HOME'");
  });

  it('uses POSIX quoting off Windows', () => {
    expect(shellQuote("a'b $c", 'linux')).toBe("'a'\\''b $c'");
    expect(shellQuote("a'b $c", 'win32')).toBe("'a''b $c'");
    expect(vscodeProfileName('  ')).toBe('cctl-binding');
  });

  it('quotes exactly like the copy the enforcement guard embeds', () => {
    // The guard is a generated CommonJS script and carries its own copy of the quoting rule; the
    // CLI and the guard must print the same command for the same alias.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(`${embeddableFolderPathSource()}\nreturn shellQuoteArg;`);
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const guardCopy = factory() as (text: string, platform: NodeJS.Platform) => string;
    for (const text of ['Auth Work', "it's", 'don’t', 'Deploy $(calc) "now" `id`', '']) {
      for (const platform of ['win32', 'linux', 'darwin'] as const) {
        expect(shellQuote(text, platform)).toBe(guardCopy(text, platform));
      }
    }
    // PowerShell also treats the typographic single quotes as quotes, so they are doubled too.
    expect(shellQuote('don’t', 'win32')).toBe("'don’’t'");
  });

  it('explains an unbound folder as the global account', () => {
    const out = renderWhere({ folder: 'C:\\tmp', bound: null }, PLAIN_PALETTE);
    expect(out).toContain('global (shared) account');
    expect(out).toContain('CLAUDE_CONFIG_DIR is not set');
    expect(out).toContain('cctl bind C:\\tmp');
    expect(out).not.toContain('Named sessions');
  });

  it('lists the named sessions alias-bound in the folder, with how to start each', () => {
    const view = {
      folder: 'C:\\repos\\work',
      bound: null,
      aliases: [
        {
          alias: 'Auth Work',
          groupLabel: 'Research',
          members: ['research@x', 'spare@x'],
          liveMemberLabel: 'research@x',
        },
      ],
    };
    const out = renderWhere(view, PLAIN_PALETTE);
    expect(out).toContain('Named sessions bound here (they outrank the folder rule above):');
    expect(out).toContain('"Auth Work" -> Research (research@x, spare@x), live: research@x');
    // The resume command quotes the alias as ONE single-quoted literal (paste-safe in PowerShell and
    // POSIX shells alike; a double-quoted "$(...)" would run a command).
    expect(out).toContain("start or resume it with: cctl claude --resume 'Auth Work'");
    // Alongside a folder binding too, and before the VS Code snippet (whose JSON must still parse).
    const both = renderWhere(
      {
        ...view,
        bound: {
          groupLabel: 'work',
          matchedFolder: 'C:\\repos\\work',
          members: ['work@me.com'],
          profileDir: 'C:\\p',
          liveMemberLabel: null,
        },
      },
      PLAIN_PALETTE,
    );
    expect(both).toContain('"Auth Work" -> Research');
    // The VS Code snippet is followed by the profile steps now, so the JSON is the text between its
    // first opening and last closing brace.
    expect(
      () => JSON.parse(both.slice(both.indexOf('{'), both.lastIndexOf('}') + 1)) as unknown,
    ).not.toThrow();
    // The alias lines come before the VS Code advice.
    expect(both.indexOf('Named sessions bound here')).toBeLessThan(both.indexOf('For VS Code'));
  });

  it('strips terminal controls from an alias it prints', () => {
    const out = renderWhere(
      {
        folder: 'C:\\r',
        bound: null,
        aliases: [
          {
            alias: `x${String.fromCharCode(27)}[31m\u202e`,
            groupLabel: 'g',
            members: ['m'],
            liveMemberLabel: null,
          },
        ],
      },
      PLAIN_PALETTE,
    );
    expect(out).not.toContain(String.fromCharCode(27));
    expect(out).not.toContain('\u202e');
    expect(out).toContain('live: none usable');
  });
});

describe('renderBindingGroups — alias scopes', () => {
  it('lists each alias scope under its group, sanitized', () => {
    const out = renderBindingGroups(
      [
        {
          label: 'Research',
          folders: [],
          aliases: [{ folder: 'C:\\repo', alias: `Auth${String.fromCharCode(27)}[2K Work` }],
          members: [{ label: 'r', live: true, quarantined: false, excluded: false }],
          profileDir: 'C:\\p',
          noWorkingAccount: false,
        },
      ],
      PLAIN_PALETTE,
    );
    expect(out).toContain('  session: "Auth[2K Work" in C:\\repo');
    expect(out).not.toContain(String.fromCharCode(27));
  });
});

// ---------------------------------------------------------------------------
// Session aliases (`cctl session show` / `cctl session aliases`)
// ---------------------------------------------------------------------------

/** An instant built from LOCAL wall-clock fields: the renderers print local time, so a stamp
 *  built this way renders as the same text in every time zone the suite runs in. */
const localMs = (y: number, mo: number, d: number, h: number, mi: number): number =>
  new Date(y, mo - 1, d, h, mi).getTime();

function sessionMeta(over: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    file: `C:\\claude\\projects\\p\\${over.sessionId}.jsonl`,
    projectDir: 'p',
    launchCwd: 'C:\\work\\app',
    folder: 'C:\\work\\app',
    customTitle: null,
    aiTitle: null,
    firstActivityMs: localMs(2026, 9, 1, 9, 5),
    lastActivityMs: localMs(2026, 9, 1, 17, 30),
    ...over,
  };
}

function accountUse(over: Partial<SessionAccountUse> = {}): SessionAccountUse {
  return {
    accountId: 'acct-a',
    label: 'main',
    turns: 3,
    tokens: 1500,
    firstMs: localMs(2026, 9, 1, 9, 5),
    lastMs: localMs(2026, 9, 1, 12, 0),
    ...over,
  };
}

const ESC_CHAR = String.fromCharCode(27);
/** A title a hostile transcript could carry: an SGR recolor, an OSC window retitle, a forged
 *  newline and a bidi override. */
const HOSTILE_TITLE = `${ESC_CHAR}[31mpwn${ESC_CHAR}]0;owned\u0007\nfake line\u202e`;

describe('renderSessionDetails', () => {
  it('renders alias, folder, session, active window and per-account use', () => {
    const out = renderSessionDetails(
      [
        {
          meta: sessionMeta({ sessionId: 'aaaa-1111', customTitle: 'auth-work' }),
          accounts: [
            accountUse(),
            accountUse({
              accountId: null,
              label: 'unattributed',
              turns: 1,
              tokens: 10,
              firstMs: localMs(2026, 8, 30, 8, 0),
              lastMs: localMs(2026, 9, 1, 8, 0),
            }),
          ],
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'alias', inScope: true },
    );
    expect(out.split('\n')).toEqual([
      'Alias     auth-work',
      'Folder    C:\\work\\app',
      'Session   aaaa-1111',
      'Active    2026-09-01 09:05 -> 2026-09-01 17:30',
      // Same-day use shows one stamp; use spanning days shows the range.
      'Accounts  main  3 turns, 1.5k tokens  2026-09-01 12:00',
      '          unattributed  1 turn, 10 tokens  2026-08-30 08:00 -> 2026-09-01 08:00',
    ]);
  });

  it('marks a generated title and says how to set a real one', () => {
    const out = renderSessionDetails(
      [{ meta: sessionMeta({ sessionId: 's', aiTitle: 'Fix login' }), accounts: [] }],
      { folder: 'C:\\work\\app', matchedBy: 'alias', inScope: true },
    );
    expect(out).toContain('Alias     Fix login  (generated title; /rename sets one)');
  });

  it('does not mark a custom title as generated', () => {
    const out = renderSessionDetails(
      [{ meta: sessionMeta({ sessionId: 's', customTitle: 'mine', aiTitle: 'ai' }), accounts: [] }],
      { folder: 'C:\\work\\app', matchedBy: 'id' },
    );
    expect(out).toContain('Alias     mine');
    expect(out).not.toContain('generated title');
  });

  it('marks the session the command runs inside, matching its id case-insensitively', () => {
    const out = renderSessionDetails(
      [{ meta: sessionMeta({ sessionId: 'abcd-ef', customTitle: 'me' }), accounts: [] }],
      { folder: 'C:\\work\\app', matchedBy: 'id', currentSessionId: 'ABCD-EF' },
    );
    expect(out).toContain('Alias     me  <- this session');
  });

  it('does not mark another session as the current one', () => {
    const out = renderSessionDetails(
      [{ meta: sessionMeta({ sessionId: 'abcd-ef', customTitle: 'me' }), accounts: [] }],
      { folder: 'C:\\work\\app', matchedBy: 'id', currentSessionId: 'other' },
    );
    expect(out).not.toContain('this session');
  });

  it('says so when the alias was found only in another folder', () => {
    const out = renderSessionDetails(
      [
        {
          meta: sessionMeta({ sessionId: 's', customTitle: 'api', folder: 'D:\\elsewhere' }),
          accounts: [],
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'alias', inScope: false },
    );
    expect(out.split('\n')[0]).toBe(
      'No session with that alias in C:\\work\\app; showing the one in D:\\elsewhere.',
    );
  });

  it('shows no out-of-folder notice for an in-folder alias or an id match', () => {
    const views: SessionView[] = [
      { meta: sessionMeta({ sessionId: 's', customTitle: 'api', folder: 'D:\\x' }), accounts: [] },
    ];
    expect(
      renderSessionDetails(views, { folder: 'C:\\work\\app', matchedBy: 'alias', inScope: true }),
    ).not.toContain('No session with that alias');
    expect(renderSessionDetails(views, { folder: 'C:\\work\\app', matchedBy: 'id' })).not.toContain(
      'No session with that alias',
    );
  });

  it('explains the resume picker when several sessions share the alias', () => {
    const out = renderSessionDetails(
      [
        { meta: sessionMeta({ sessionId: 'one', customTitle: 'api' }), accounts: [] },
        { meta: sessionMeta({ sessionId: 'two', customTitle: 'api' }), accounts: [] },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'alias', inScope: true },
    );
    expect(out).toContain('2 sessions share this alias in this folder');
    expect(out).toContain('opens a picker');
    // One block per session, separated by a blank line.
    expect(out).toContain('Session   one\n');
    expect(out).toContain('\n\nAlias     api\n');
    expect(out).toContain('Session   two');
  });

  it('spells out the missing pieces instead of printing blanks', () => {
    const out = renderSessionDetails(
      [
        {
          meta: sessionMeta({
            sessionId: 's',
            folder: null,
            launchCwd: null,
            firstActivityMs: null,
          }),
          accounts: [],
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'id' },
    );
    expect(out).toContain('Alias     (none)');
    expect(out).toContain('Folder    (unknown)');
    expect(out).toContain('Active    ? -> 2026-09-01 17:30');
    expect(out).toContain('Accounts  (no turns recorded yet)');
  });

  it('shows where a relocated session was started', () => {
    const out = renderSessionDetails(
      [
        {
          meta: sessionMeta({ sessionId: 's', launchCwd: 'C:\\old', folder: 'C:\\work\\app' }),
          accounts: [],
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'id' },
    );
    expect(out).toContain('Folder    C:\\work\\app\n          (started in C:\\old)');
  });

  it('strips terminal control sequences from titles, folders and labels', () => {
    const out = renderSessionDetails(
      [
        {
          meta: sessionMeta({
            sessionId: 's',
            customTitle: HOSTILE_TITLE,
            folder: `C:\\work\\${ESC_CHAR}[2Jwiped`,
          }),
          accounts: [accountUse({ label: `${ESC_CHAR}[31mred-label` })],
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'id' },
    );
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain('\u202e');
    // The forged newline is gone: the title stays on the Alias line.
    expect(out.split('\n')[0]).toBe('Alias     [31mpwn]0;ownedfake line');
  });

  it('never lets color change the visible text', () => {
    const views: SessionView[] = [
      {
        meta: sessionMeta({ sessionId: 's', aiTitle: 'gen', folder: 'D:\\x' }),
        accounts: [accountUse(), accountUse({ accountId: null, label: 'unattributed' })],
      },
    ];
    const ctx = {
      folder: 'C:\\work\\app',
      matchedBy: 'alias' as const,
      inScope: false,
      currentSessionId: 's',
    };
    expect(stripAnsi(renderSessionDetails(views, ctx, ANSI_PALETTE))).toBe(
      renderSessionDetails(views, ctx, PLAIN_PALETTE),
    );
  });
});

describe('renderSessionDetails — Bound to', () => {
  const binding = (over: Partial<SessionBindingView> = {}): SessionBindingView => ({
    via: 'alias',
    folder: 'C:\\work\\app',
    alias: 'Auth Work',
    groupId: 'g1',
    groupLabel: 'Research',
    members: ['research@x'],
    requiredSlot: 'group:g1',
    slot: 'group:g1',
    slotSource: 'env',
    slotLabel: 'the Research binding',
    inScope: true,
    ...over,
  });
  const render = (b: SessionBindingView): string[] =>
    renderSessionDetails(
      [
        {
          meta: sessionMeta({ sessionId: 's', customTitle: 'Auth Work' }),
          accounts: [],
          binding: b,
        },
      ],
      { folder: 'C:\\work\\app', matchedBy: 'id' },
    ).split('\n');

  it('names the binding and the rule that matched, and says in scope', () => {
    const lines = render(binding());
    expect(lines).toContain(
      'Bound to  Research (research@x)  by alias "Auth Work" in C:\\work\\app',
    );
    expect(lines).toContain('Scope     in scope');
  });

  it('says OUT of scope with where it runs and how to resume it on the bound account', () => {
    const lines = render(
      binding({ slot: 'global', slotLabel: 'the shared account', inScope: false }),
    );
    expect(lines).toContain(
      // Single-quoted: the paste-safe literal (see resumeCommand).
      "Scope     OUT of scope: it runs on the shared account; resume it with: cctl claude --resume 'Auth Work'",
    );
    // A recorded (not live) slot is reported in the past tense.
    const recorded = render(
      binding({
        slot: 'global',
        slotLabel: 'the shared account',
        slotSource: 'recorded',
        inScope: false,
      }),
    );
    expect(recorded.join('\n')).toContain('it last ran on the shared account');
  });

  it('a folder binding, an unbound session and an unknown slot', () => {
    expect(
      render(binding({ via: 'folder', alias: null, folder: 'C:\\work' })).join('\n'),
    ).toContain('Bound to  Research (research@x)  by folder C:\\work');
    expect(
      render(
        binding({
          via: null,
          groupId: null,
          groupLabel: null,
          members: [],
          folder: null,
          alias: null,
        }),
      ),
    ).toContain('Bound to  nothing: it runs on the shared account');
    expect(render(binding({ slot: null, slotSource: null, inScope: null })).join('\n')).toContain(
      'unknown (no slot recorded for this session yet)',
    );
  });

  it('strips terminal controls from the bound alias and labels', () => {
    const out = render(binding({ alias: HOSTILE_TITLE, groupLabel: HOSTILE_TITLE })).join('\n');
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain('\u202e');
    expect(out).not.toContain('\u0007');
  });

  it('carries the binding in the --json shape', () => {
    const json = sessionViewJson({
      meta: sessionMeta({ sessionId: 's' }),
      accounts: [],
      binding: binding({ inScope: false }),
    });
    expect(json.binding).toMatchObject({ via: 'alias', inScope: false, requiredSlot: 'group:g1' });
    // No binding computed (the alias listing) -> no field.
    expect(
      sessionViewJson({ meta: sessionMeta({ sessionId: 's' }), accounts: [] }),
    ).not.toHaveProperty('binding');
  });
});

describe('renderSessionAliasList', () => {
  const views: SessionView[] = [
    {
      meta: sessionMeta({
        sessionId: '11111111-aaaa',
        customTitle: 'auth-work',
        lastActivityMs: localMs(2026, 9, 2, 8, 15),
      }),
      accounts: [accountUse(), accountUse({ accountId: 'acct-b', label: 'spare' })],
    },
    {
      meta: sessionMeta({ sessionId: '22222222-bbbb', aiTitle: 'Fix login' }),
      accounts: [],
    },
  ];

  it('lists one row per session under aligned headers, with the folder above', () => {
    const out = renderSessionAliasList(views, { folder: 'C:\\work\\app' });
    const lines = out.split('\n');
    expect(lines[0]).toBe('C:\\work\\app');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/^ALIAS\s+LAST ACTIVE\s+ACCOUNTS\s+SESSION$/);
    // Columns line up: each value starts where its header does.
    const col = (header: string) => lines[2]!.indexOf(header);
    expect(lines[3]!.indexOf('2026-09-02 08:15')).toBe(col('LAST ACTIVE'));
    expect(lines[3]!.indexOf('main, spare')).toBe(col('ACCOUNTS'));
    // Only the short session id is shown.
    expect(lines[3]!.endsWith('11111111')).toBe(true);
    expect(out).not.toContain('11111111-aaaa');
    // A session with no turns shows a dash, not an empty cell.
    expect(lines[4]!.slice(col('ACCOUNTS'), col('ACCOUNTS') + 1)).toBe('-');
  });

  it('marks generated titles and the current session, and explains both marks', () => {
    const out = renderSessionAliasList(views, {
      folder: 'C:\\work\\app',
      currentSessionId: '11111111-AAAA',
    });
    expect(out).toMatch(/^auth-work \* /m);
    expect(out).toMatch(/^Fix login ~ /m);
    expect(out.split('\n').at(-1)).toBe('~ generated title   * this session');
  });

  it('omits the legend when there is nothing to explain', () => {
    const out = renderSessionAliasList([views[0]!], { folder: 'C:\\work\\app' });
    expect(out).not.toContain('generated title');
    expect(out).not.toContain('this session');
  });

  it('adds a FOLDER column, and no folder heading, when listing every folder', () => {
    const out = renderSessionAliasList(views, { folder: null });
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^ALIAS\s+LAST ACTIVE\s+ACCOUNTS\s+SESSION\s+FOLDER$/);
    expect(lines[1]!.endsWith('C:\\work\\app')).toBe(true);
  });

  it('says how to name a session when there are none', () => {
    expect(renderSessionAliasList([], { folder: 'C:\\work\\app' })).toBe(
      'No named sessions in C:\\work\\app. Name one with /rename <alias> (or claude --name <alias>).',
    );
    expect(renderSessionAliasList([], { folder: null })).toMatch(
      /^No named sessions on this machine\./,
    );
  });

  it('strips terminal control sequences from aliases, labels and folders', () => {
    const out = renderSessionAliasList(
      [
        {
          meta: sessionMeta({
            sessionId: 's',
            customTitle: HOSTILE_TITLE,
            folder: `C:\\${ESC_CHAR}[2Jx`,
          }),
          accounts: [accountUse({ label: `${ESC_CHAR}[31mred` })],
        },
      ],
      { folder: null },
    );
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain('\u0007');
    // The forged newline cannot add a row: header + one data row.
    expect(out.split('\n')).toHaveLength(2);
  });
});

describe('renderAmbiguousAlias', () => {
  it('lists each folder using the alias with its session count and last activity', () => {
    const out = renderAmbiguousAlias('api', [
      {
        folder: 'D:\\one',
        sessions: [
          sessionMeta({ sessionId: 'a', lastActivityMs: localMs(2026, 9, 3, 14, 0) }),
          sessionMeta({ sessionId: 'b', lastActivityMs: localMs(2026, 9, 1, 9, 0) }),
        ],
      },
      { folder: 'E:\\two', sessions: [sessionMeta({ sessionId: 'c' })] },
    ]);
    expect(out.split('\n')).toEqual([
      '"api" is not a session in this folder, and 2 other folders use it:',
      '  D:\\one  (2 sessions)  last active 2026-09-03 14:00',
      '  E:\\two  (1 session)  last active 2026-09-01 17:30',
      '',
      'Run it from one of those folders, or pass --cwd <folder>.',
    ]);
  });

  it('strips terminal control sequences from the alias and the folders', () => {
    const out = renderAmbiguousAlias(HOSTILE_TITLE, [
      { folder: `D:\\${ESC_CHAR}[2Jone`, sessions: [sessionMeta({ sessionId: 'a' })] },
    ]);
    expect(out).not.toContain(ESC_CHAR);
    expect(out).not.toContain('\u202e');
  });
});

describe('sessionViewJson', () => {
  it('emits stable fields with ISO timestamps and the per-account breakdown', () => {
    const view: SessionView = {
      meta: sessionMeta({ sessionId: 's1', customTitle: 'auth-work', aiTitle: 'Generated' }),
      accounts: [accountUse()],
    };
    expect(sessionViewJson(view)).toEqual({
      sessionId: 's1',
      alias: 'auth-work',
      aliasSource: 'custom',
      customTitle: 'auth-work',
      aiTitle: 'Generated',
      folder: 'C:\\work\\app',
      launchCwd: 'C:\\work\\app',
      firstActivity: new Date(localMs(2026, 9, 1, 9, 5)).toISOString(),
      lastActivity: new Date(localMs(2026, 9, 1, 17, 30)).toISOString(),
      transcript: 'C:\\claude\\projects\\p\\s1.jsonl',
      accounts: [
        {
          accountId: 'acct-a',
          label: 'main',
          turns: 3,
          tokens: 1500,
          first: new Date(localMs(2026, 9, 1, 9, 5)).toISOString(),
          last: new Date(localMs(2026, 9, 1, 12, 0)).toISOString(),
        },
      ],
    });
  });

  it('names the alias source: auto for a generated title, none for a blank custom title', () => {
    const auto = sessionViewJson({
      meta: sessionMeta({ sessionId: 's', aiTitle: 'gen' }),
      accounts: [],
    });
    expect(auto).toMatchObject({ alias: 'gen', aliasSource: 'auto' });
    // A blank custom title hides the generated one, exactly as claude --resume reads it.
    const blank = sessionViewJson({
      meta: sessionMeta({ sessionId: 's', customTitle: ' ', aiTitle: 'gen' }),
      accounts: [],
    });
    expect(blank).toMatchObject({
      alias: null,
      aliasSource: null,
      customTitle: ' ',
      aiTitle: 'gen',
    });
    const none = sessionViewJson({
      meta: sessionMeta({ sessionId: 's', firstActivityMs: null }),
      accounts: [],
    });
    expect(none).toMatchObject({ alias: null, aliasSource: null, firstActivity: null });
  });

  it('keeps a hostile title verbatim: JSON escapes it, the terminal renderers strip it', () => {
    const json = sessionViewJson({
      meta: sessionMeta({ sessionId: 's', customTitle: HOSTILE_TITLE }),
      accounts: [],
    });
    expect(json['alias']).toBe(HOSTILE_TITLE);
    const text = JSON.stringify(json);
    expect(text).not.toContain(ESC_CHAR);
    expect((JSON.parse(text) as Record<string, unknown>)['customTitle']).toBe(HOSTILE_TITLE);
  });
});
