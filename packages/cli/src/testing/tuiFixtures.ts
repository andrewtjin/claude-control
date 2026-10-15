// Test-only: shared fixtures for the full-screen view's tests: a fixed clock, accounts covering
// every tag and error state, and a snapshot builder. Never imported by production code.

import type { AccountUsage } from '@claude-control/shared-protocol';
import { applySnapshot, initialState } from '../tui/state.js';
import type { TuiAccount, TuiSnapshot, TuiState } from '../tui/types.js';

/** 2026-01-15 12:00:00 UTC: every relative time in the fixtures is measured from here. */
export const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** An ISO time `ms` from {@link NOW}. */
export function inMs(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

/** A usage snapshot polled `ageMs` ago with these limits. */
export function usage(
  limits: AccountUsage['limits'],
  ageMs = 2 * MIN,
  extra: Partial<AccountUsage> = {},
): AccountUsage {
  return {
    accountId: 'x',
    label: 'x',
    active: false,
    source: 'live',
    fetchedAtMs: NOW - ageMs,
    limits,
    ...extra,
  };
}

/** One account, plain unless `over` says otherwise. */
export function account(id: string, label: string, over: Partial<TuiAccount> = {}): TuiAccount {
  return {
    id,
    label,
    plan: '1x',
    active: false,
    quarantined: false,
    excluded: false,
    folders: [],
    extraTags: [],
    ...over,
  };
}

/** Accounts between them carrying every tag and state the row can show. */
export function everyStateAccounts(): TuiAccount[] {
  return [
    account('id-work', 'work', {
      plan: '20x',
      active: true,
      usage: usage([
        { kind: 'session', percent: 45, resetsAt: inMs(2 * HOUR + 13 * MIN), isActive: true },
        { kind: 'weekly_all', percent: 72, resetsAt: inMs(3 * DAY + 4 * HOUR), isActive: true },
        { kind: 'weekly_scoped', percent: 12, resetsAt: inMs(3 * DAY), isActive: true },
      ]),
    }),
    account('id-home', 'home', {
      plan: '5x',
      excluded: true,
      folders: ['client-a'],
      usage: usage(
        [
          { kind: 'session', percent: 91, resetsAt: inMs(40 * MIN), isActive: true },
          { kind: 'weekly_all', percent: 100, isActive: true },
          { kind: 'weekly_scoped', percent: 64, scope: 'opus', isActive: true },
        ],
        3 * HOUR,
      ),
      predictedResetAt: NOW + 5 * DAY + 2 * HOUR,
    }),
    account('id-dead', 'expired-login', {
      quarantined: true,
      usage: usage([], 2 * DAY, { error: 'invalid_grant' }),
    }),
    account('id-new', 'never-polled', {
      plan: '?',
      extraTags: [{ text: 'session x2', tone: 'info' }],
    }),
    account('id-long', 'a-label-far-too-long-for-the-column', {
      folders: ['client-a', 'side-project'],
      usage: usage([{ kind: 'session', percent: 3, isActive: true }], 30_000),
    }),
  ];
}

/** A read with these accounts and a running daemon, and empty other panes. */
export function snapshotOf(accounts: TuiAccount[], over: Partial<TuiSnapshot> = {}): TuiSnapshot {
  return {
    readAtMs: NOW,
    accounts: { ok: true, value: accounts },
    daemon: {
      heartbeat: { state: 'alive', writtenAtMs: NOW - 5_000, ageMs: 5_000 },
      autoSwitch: true,
    },
    sessions: { ok: true, value: { rows: [], header: {} } },
    folders: {
      ok: true,
      value: {
        rules: [],
        global: { live: null, pool: [] },
        footer: { present: false, fresh: false, enforce: 'block' },
      },
    },
    outages: { ok: true, value: { episodes: [], open: [], logPath: '/data/exhaustion.jsonl' } },
    ...over,
  };
}

/** The state after the first read of `snapshot`. */
export function stateWith(snapshot: TuiSnapshot, over: Partial<TuiState> = {}): TuiState {
  return { ...applySnapshot(initialState(NOW, 'linux'), snapshot), ...over };
}
