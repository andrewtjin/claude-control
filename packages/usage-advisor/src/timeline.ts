// The reset outlook: 5h-session budgeting + a cross-account reset timeline.
//
// Claude subscriptions meter two clocks per account: a rolling 5-hour session window and a
// weekly cap. This module answers two planning questions the moment-scoped advisor
// (advisor.ts) does not: "how many 5h windows can I still open on each account before its
// weekly reset?" and "in what order do everyone's limits refresh?". Like the advisor it is a
// PURE function of a snapshot — no IO, no Date.now() unless the caller omits `now` — so the
// CLI and the Discord bot render identical, unit-tested output from the same inputs.
//
// Budget semantics: a 5h window opens when you send the first message and closes 5h later,
// so the number of windows you can still OPEN before the weekly reset is what matters.
// A currently-open window counts as one; after it closes, back-to-back full windows fit in
// the remaining time; a leftover shorter than 5h is still an openable (truncated) window and
// is reported separately as "partial" rather than silently rounded away.

import { humanizeDuration, roundPct } from './format.js';
import type { AccountUsageInput, LimitInput } from './types.js';

/** Length of one Claude session window. */
export const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000;

/** One future reset, across any account/limit — the unit the merged timeline is built from. */
export interface ResetEvent {
  atMs: number;
  accountId: string;
  label: string;
  kind: LimitInput['kind'];
  /** Percent of the limit consumed at snapshot time (what the reset will clear). */
  percentUsed: number;
}

/** How many 5h windows an account can still open before its weekly reset. */
export interface SessionWindowBudget {
  /** The weekly reset that bounds the budget (soonest of weekly_all / weekly_scoped). */
  weeklyResetAt: number;
  /** Full-length 5h windows that fit, INCLUDING a currently-open one. */
  fullWindows: number;
  /** True when a final, truncated window (< 5h) also fits before the weekly reset. */
  hasPartialWindow: boolean;
}

/** One account's place in the outlook. */
export interface AccountOutlook {
  accountId: string;
  label: string;
  active: boolean;
  quarantined: boolean;
  /** When the currently-open 5h window closes — absent when no window is open. */
  openWindowEndsAt?: number;
  /** Percent used of the open window, when the session limit reported one. */
  sessionPercent?: number;
  /** Absent when no weekly reset time is known (the budget is then uncomputable). */
  budget?: SessionWindowBudget;
}

/** The full computed outlook for a moment. */
export interface ResetOutlook {
  accounts: AccountOutlook[];
  /** Every known future reset across all accounts, soonest first. */
  events: ResetEvent[];
  generatedAtMs: number;
}

/**
 * Compute the reset outlook for a snapshot. Pure and deterministic: same accounts + same
 * `now` always yield the same outlook. Expired reset times (in the past) are ignored rather
 * than trusted — stale cached snapshots routinely carry them.
 */
export function computeOutlook(accounts: AccountUsageInput[], now = Date.now()): ResetOutlook {
  const outlooks: AccountOutlook[] = [];
  const events: ResetEvent[] = [];

  for (const account of accounts) {
    const sessionLimit = soonestFutureLimit(account.limits, ['session'], now);
    const weeklyLimit = soonestFutureLimit(account.limits, ['weekly_all', 'weekly_scoped'], now);

    const outlook: AccountOutlook = {
      accountId: account.accountId,
      label: account.label,
      active: account.active,
      quarantined: account.quarantined,
    };
    // A session limit with a FUTURE reset means a 5h window is open right now.
    if (sessionLimit) {
      outlook.openWindowEndsAt = sessionLimit.resetsAt as number;
      outlook.sessionPercent = roundPct(sessionLimit.percent);
    }
    if (weeklyLimit) {
      outlook.budget = computeBudget(now, weeklyLimit.resetsAt as number, outlook.openWindowEndsAt);
    }
    outlooks.push(outlook);

    // Every future reset becomes a timeline event, weekly_scoped included — even when it is
    // not the budget-binding one, seeing it refresh is exactly what the timeline is for.
    for (const limit of account.limits) {
      if (limit.resetsAt === undefined || limit.resetsAt <= now) continue;
      events.push({
        atMs: limit.resetsAt,
        accountId: account.accountId,
        label: account.label,
        kind: limit.kind,
        percentUsed: roundPct(limit.percent),
      });
    }
  }

  events.sort((a, b) => a.atMs - b.atMs || a.label.localeCompare(b.label));
  return { accounts: outlooks, events, generatedAtMs: now };
}

/** Windows that fit between now and the weekly reset. See the header for the model. */
function computeBudget(
  now: number,
  weeklyResetAt: number,
  openWindowEndsAt: number | undefined,
): SessionWindowBudget {
  // With a window open, counting starts when it closes; the open window itself counts as 1.
  // A window can outlive the weekly reset (they are independent clocks) — clamp so the
  // remaining span never goes negative.
  const countFrom = Math.min(openWindowEndsAt ?? now, weeklyResetAt);
  const remainingMs = weeklyResetAt - countFrom;
  const fullWindows =
    (openWindowEndsAt !== undefined ? 1 : 0) + Math.floor(remainingMs / SESSION_WINDOW_MS);
  const hasPartialWindow = remainingMs % SESSION_WINDOW_MS > 0;
  return { weeklyResetAt, fullWindows, hasPartialWindow };
}

/** The limit of one of `kinds` with the soonest STILL-FUTURE reset, or undefined. */
function soonestFutureLimit(
  limits: LimitInput[],
  kinds: LimitInput['kind'][],
  now: number,
): LimitInput | undefined {
  let best: LimitInput | undefined;
  for (const limit of limits) {
    if (!kinds.includes(limit.kind)) continue;
    if (limit.resetsAt === undefined || limit.resetsAt <= now) continue;
    if (!best || limit.resetsAt < (best.resetsAt as number)) best = limit;
  }
  return best;
}

// ---------------------------------------------------------------------------
// Wire-shape adapter
// ---------------------------------------------------------------------------

/** Structural stand-in for shared-protocol's `AccountUsage`, so this package can adapt wire
 *  snapshots without depending on shared-protocol (it stays dependency-free on purpose). */
export interface WireUsageLike {
  accountId: string;
  label: string;
  active: boolean;
  /** Callers that know quarantine state (e.g. the CLI reading the registry) pass it; the
   *  wire snapshot doesn't carry it, so it defaults to false. */
  quarantined?: boolean | undefined;
  limits: Array<{
    kind: LimitInput['kind'];
    percent: number;
    /** ISO timestamp on the wire (epoch ms in advisor inputs). The explicit `| undefined`
     *  keeps zod-inferred wire types assignable under exactOptionalPropertyTypes. */
    resetsAt?: string | null | undefined;
  }>;
}

/** Adapt wire usage snapshots to advisor inputs: ISO reset times become epoch ms, and an
 *  unparseable timestamp is dropped rather than poisoning the math with NaN. */
export function timelineInputFromWire(accounts: WireUsageLike[]): AccountUsageInput[] {
  return accounts.map((a) => ({
    accountId: a.accountId,
    label: a.label,
    active: a.active,
    quarantined: a.quarantined ?? false,
    limits: a.limits.map((l) => {
      const ms = l.resetsAt != null ? Date.parse(l.resetsAt) : NaN;
      return {
        kind: l.kind,
        percent: l.percent,
        ...(Number.isFinite(ms) ? { resetsAt: ms } : {}),
      };
    }),
  }));
}

// ---------------------------------------------------------------------------
// Rendering (plain text, shared by the CLI and the Discord code block)
// ---------------------------------------------------------------------------

/** Options for `renderOutlook`. `trackWidth` is the interior of the ASCII timeline bar. */
export interface RenderOutlookOptions {
  trackWidth?: number;
}

const DEFAULT_TRACK_WIDTH = 36;

/**
 * Render the outlook as plain ASCII: a per-account 5h-window budget, a proportional
 * timeline track per account (s = 5h window resets, w = weekly resets, * = both in the same
 * cell), and the merged list of upcoming resets. Deliberately color- and unicode-free so it
 * reads identically in any terminal and inside a Discord code block.
 */
export function renderOutlook(outlook: ResetOutlook, options: RenderOutlookOptions = {}): string {
  if (outlook.accounts.length === 0) {
    return 'No accounts yet. Add one with: cctl accounts add <label>';
  }
  const width = options.trackWidth ?? DEFAULT_TRACK_WIDTH;
  const now = outlook.generatedAtMs;
  const labelWidth = Math.max(...outlook.accounts.map((a) => a.label.length));

  const sections: string[] = [budgetSection(outlook, now, labelWidth)];
  if (outlook.events.length > 0) {
    sections.push(timelineSection(outlook, now, labelWidth, width));
    sections.push(upcomingSection(outlook, now, labelWidth));
  } else {
    sections.push('No reset times reported yet — wait for the next daemon poll.');
  }
  return sections.join('\n\n');
}

/** "how many 5h windows do I have left on each account" — one line per account. */
function budgetSection(outlook: ResetOutlook, now: number, labelWidth: number): string {
  const lines = ['5h-session budget (windows you can still open before each weekly reset)'];
  for (const a of outlook.accounts) {
    const marker = a.active ? '*' : ' ';
    const label = a.label.padEnd(labelWidth);
    if (a.quarantined) {
      lines.push(`${marker} ${label}  quarantined — re-login required`);
      continue;
    }
    const window =
      a.openWindowEndsAt !== undefined
        ? `window open (${a.sessionPercent ?? 0}% used, resets in ${humanizeDuration(a.openWindowEndsAt - now)})`
        : 'no open window';
    const budget = a.budget
      ? `${a.budget.fullWindows} full 5h window${a.budget.fullWindows === 1 ? '' : 's'}` +
        `${a.budget.hasPartialWindow ? ' +1 partial' : ''}` +
        ` before weekly reset in ${humanizeDuration(a.budget.weeklyResetAt - now)}`
      : 'weekly reset time unknown';
    lines.push(`${marker} ${label}  ${window} · ${budget}`);
  }
  return lines.join('\n');
}

/** Proportional ASCII track per account, all sharing one time scale (now → last event). */
function timelineSection(
  outlook: ResetOutlook,
  now: number,
  labelWidth: number,
  width: number,
): string {
  const lastEvent = outlook.events[outlook.events.length - 1] as ResetEvent;
  const span = Math.max(lastEvent.atMs - now, 1); // avoid divide-by-zero on a same-ms event
  const lines = [
    `Reset timeline  now -> ${humanizeDuration(span)}  (s = 5h window resets, w = weekly resets)`,
  ];
  for (const a of outlook.accounts) {
    const cells: string[] = new Array<string>(width).fill('-');
    for (const e of outlook.events) {
      if (e.accountId !== a.accountId) continue;
      const pos = Math.min(width - 1, Math.round(((e.atMs - now) / span) * (width - 1)));
      const mark = e.kind === 'session' ? 's' : 'w';
      // Two resets landing in the same cell collapse to '*' so neither silently vanishes.
      cells[pos] = cells[pos] === '-' || cells[pos] === mark ? mark : '*';
    }
    lines.push(`  ${a.label.padEnd(labelWidth)}  |${cells.join('')}|`);
  }
  return lines.join('\n');
}

/** The merged chronological list — what refreshes next, and what each reset means. */
function upcomingSection(outlook: ResetOutlook, now: number, labelWidth: number): string {
  const inWidth = Math.max(...outlook.events.map((e) => humanizeDuration(e.atMs - now).length));
  const lines = ['Upcoming resets'];
  for (const e of outlook.events) {
    const when = `in ${humanizeDuration(e.atMs - now).padEnd(inWidth)}`;
    lines.push(`  ${when}  ${e.label.padEnd(labelWidth)}  ${describeEvent(e)}`);
  }
  return lines.join('\n');
}

/** What a reset means for planning: a session reset frees the window; a weekly reset wastes
 *  whatever headroom went unburned — that asymmetry is the "use them efficiently" signal. */
function describeEvent(e: ResetEvent): string {
  if (e.kind === 'session') return `5h window resets (${e.percentUsed}% used clears)`;
  const scoped = e.kind === 'weekly_scoped' ? 'weekly (scoped)' : 'weekly';
  const unused = 100 - e.percentUsed;
  return unused > 0
    ? `${scoped} quota resets — ${unused}% unused expires with it`
    : `${scoped} quota resets`;
}

/** Compact rendering of an advisor plan, appended under the timeline by both frontends.
 *  Structurally typed so it accepts either the advisor's `UsagePlan` or the wire copy. */
export function renderPlanSummary(plan: {
  reason: string;
  advisories: Array<{ message: string }>;
}): string {
  const lines = [`Plan: ${plan.reason}`];
  for (const a of plan.advisories) lines.push(`  - ${a.message}`);
  return lines.join('\n');
}
