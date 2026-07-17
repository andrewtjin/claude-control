import { describe, it, expect } from 'vitest';
import { renderAccountsTable, renderUsage, type UsageRow } from './render.js';
import { ANSI_PALETTE } from './ansi.js';
import type { StoredAccount } from '@claude-control/switch-engine';
import type { AccountUsage } from '@claude-control/shared-protocol';

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
