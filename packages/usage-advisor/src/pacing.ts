// Fleet pacing: at the measured burn rate, does the fleet hold out, and what expires unused?
//
// advisor.ts answers "use which account right now"; timeline.ts answers "when does each limit
// refresh". Neither answers the owner's planning question: across every registered account, is
// the fleet sustainable, and how much budget am I about to throw away? Pacing answers both by
// simulating the fleet forward over a horizon.
//
// Why a simulation rather than a ratio. The old model averaged per-account "fraction of the
// week used / fraction of the week elapsed". That is not a fleet metric: the denominator goes
// to zero for every account that just reset, so a fleet sitting on four nearly-full budgets
// reads as "ahead of pace, slow down" — the exact opposite of the truth. It also silently
// dropped every account the endpoint had stopped publishing a reset for, which is precisely
// the set of accounts holding a FULL untouched allowance.
//
// The model, in Pro-equivalent units (a "Wx Pro" plan holds W units per weekly window):
//   - balance      = weight * (1 - usedFraction), the budget left in the current window. An
//                    account whose window has closed reports 0% used, so it holds its full
//                    allowance and this one formula covers it with no special case.
//   - burn         = MEASURED at the edge from snapshot history, in units/day. Passed in.
//   - draw-down    = spend from the account whose quota EXPIRES SOONEST, mirroring the
//                    daemon's greedy auto-switch, because unused weekly budget is destroyed
//                    at reset rather than banked.
//   - at reset     = the account returns to its full allowance and whatever it still held is
//                    LOST. Modelling that loss is what produces the waste figure, which is the
//                    single most actionable output: "use tjin.29 before Friday or lose a week
//                    of it" is advice a ratio can never give.
//
// Every input the simulation cannot see is reported as a note rather than assumed away: an
// unmeasured burn rate yields no verdict, unknown plan tiers are called out as equal
// weighting, and a predicted reset is always labelled predicted. Pure, like its siblings:
// `nowMs` is a parameter, never read from the clock internally, so the CLI and the Discord bot
// render identical, unit-tested output from the same snapshot.

import { humanizeDuration, roundPct } from './format.js';
import type { AccountUsageInput } from './types.js';
import { selectWeeklyBudget } from './weekly.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** One weekly quota cycle: the fixed cadence every account's weekly window repeats on. */
const WEEK_MS = 7 * DAY_MS;

/** How far ahead the simulation runs. Two weekly cycles: long enough that every account resets
 *  at least once (so its waste is visible) and short enough that a measured burn rate is still
 *  a defensible extrapolation. */
export const PACING_HORIZON_DAYS = 14;

/** Balances below this are floating-point residue from the draw-down, not real budget — never
 *  reported as waste and never counted as "still has balance". */
const UNIT_EPSILON = 1e-9;

/** Accounts named individually in the rendered waste note; the rest are counted, never dropped. */
const MAX_NAMED_WASTE = 3;

export type PacingVerdict = 'sustainable' | 'runs-dry' | 'unknown';

/** One account's place in the fleet. Always present in the result — even a non-contributing
 *  account is listed, so a renderer can show WHY the totals exclude it instead of silently
 *  dropping it from view. */
export interface AccountPacing {
  accountId: string;
  label: string;
  /** Weekly allowance in Pro-equivalent units (the resolved plan weight, or 1 when unknown). */
  weightUnits: number;
  /** Units still held in the current weekly window. Absent when the account contributes none. */
  balanceUnits?: number;
  /** Percent of the weekly budget used, when known. */
  usedPct?: number;
  /** Epoch ms of the next weekly reset, observed or predicted, when either is known. */
  resetsAt?: number;
  /** True when `resetsAt` is a prediction from history, not an endpoint reading. */
  resetPredicted: boolean;
  contributing: boolean;
  /** Why this account was excluded from the totals. Absent when contributing. */
  reason?: string;
}

/** One weekly reset that arrives with budget still unspent — the budget it destroys. */
export interface PacingWaste {
  accountId: string;
  label: string;
  /** Units that expire unused at this reset. */
  units: number;
  /** Epoch ms of the reset that destroys them. */
  atMs: number;
}

/** The fleet's pacing outlook for a moment. */
export interface Pacing {
  verdict: PacingVerdict;
  /** Units the fleet holds right now, summed across contributing accounts. */
  availableUnits: number;
  /** Units the fleet would hold with every window untouched. */
  capacityUnits: number;
  /** Measured burn in units/day. Absent = not measurable, which forces verdict 'unknown'. */
  burnUnitsPerDay?: number;
  /** Units the fleet regains per day on average: one full capacity every weekly cycle. */
  replenishUnitsPerDay: number;
  /** Epoch ms the fleet runs out of budget. Present only for verdict 'runs-dry'. */
  dryAtMs?: number;
  horizonDays: number;
  /** Units that expire unused inside the horizon (0 when the simulation did not run). */
  wastedUnits: number;
  /** Every wasting reset inside the horizon, soonest first. */
  waste: PacingWaste[];
  /** One human sentence carrying the verdict — the line frontends print as-is. */
  headline: string;
  /** Honesty markers: unmeasured burn, unknown plan tiers, predicted resets, excluded
   *  accounts. Rendered under the headline; never empty when something was assumed. */
  notes: string[];
  accounts: AccountPacing[];
}

/** Knobs for the simulation. `nowMs` is required (the purity contract); the rest are the
 *  history-derived measurements the caller made at the edge. */
export interface PacingOptions {
  nowMs: number;
  /** Fleet-wide burn in Pro-equivalent units/day, measured from stored snapshots. Omit when
   *  there is not enough history to measure one — the result then carries no verdict. */
  burnUnitsPerDay?: number;
  /** Override the simulation horizon (days). Defaults to {@link PACING_HORIZON_DAYS}. */
  horizonDays?: number;
}

/** A contributing account as the simulation carries it: mutable balance, fixed allowance. */
interface SimAccount {
  accountId: string;
  label: string;
  weight: number;
  balance: number;
  resetsAt?: number;
}

/**
 * Compute the fleet's pacing outlook. Pure and deterministic: same accounts + same options
 * always yield the same result. Quarantined accounts and accounts with no weekly usage data
 * are excluded from the totals but still appear in `accounts` with a reason.
 */
export function computePacing(accounts: AccountUsageInput[], options: PacingOptions): Pacing {
  const { nowMs, burnUnitsPerDay } = options;
  const horizonDays = options.horizonDays ?? PACING_HORIZON_DAYS;

  const analyzed = accounts.map((a) => analyzeAccount(a, nowMs));
  const outAccounts = analyzed.map((a) => a.pacing);
  const sim = analyzed.map((a) => a.sim).filter((s): s is SimAccount => s !== undefined);

  const availableUnits = sim.reduce((sum, a) => sum + a.balance, 0);
  const capacityUnits = sim.reduce((sum, a) => sum + a.weight, 0);
  const replenishUnitsPerDay = (capacityUnits / WEEK_MS) * DAY_MS;
  const notes = buildNotes(accounts, outAccounts, sim.length, burnUnitsPerDay);

  if (sim.length === 0 || burnUnitsPerDay === undefined) {
    return {
      verdict: 'unknown',
      availableUnits,
      capacityUnits,
      replenishUnitsPerDay,
      horizonDays,
      wastedUnits: 0,
      waste: [],
      headline: unknownHeadline(sim.length, availableUnits, capacityUnits, replenishUnitsPerDay),
      notes,
      accounts: outAccounts,
    };
  }

  const { dryAtMs, waste } = simulate(sim, burnUnitsPerDay, nowMs, horizonDays);
  const wastedUnits = waste.reduce((sum, w) => sum + w.units, 0);
  return {
    verdict: dryAtMs === undefined ? 'sustainable' : 'runs-dry',
    availableUnits,
    capacityUnits,
    burnUnitsPerDay,
    replenishUnitsPerDay,
    ...(dryAtMs !== undefined ? { dryAtMs } : {}),
    horizonDays,
    wastedUnits,
    waste,
    headline: buildHeadline({
      availableUnits,
      capacityUnits,
      burnUnitsPerDay,
      replenishUnitsPerDay,
      horizonDays,
      nowMs,
      ...(dryAtMs !== undefined ? { dryAtMs } : {}),
    }),
    notes:
      wastedUnits > UNIT_EPSILON
        ? [wasteNote(waste, wastedUnits, horizonDays, nowMs), ...notes]
        : notes,
    accounts: outAccounts,
  };
}

// ---------------------------------------------------------------------------
// Per-account analysis
// ---------------------------------------------------------------------------

/** One account's public entry, plus its simulation state when it contributes. */
function analyzeAccount(
  account: AccountUsageInput,
  nowMs: number,
): { pacing: AccountPacing; sim?: SimAccount } {
  // An absent plan weight means 1 Pro-equivalent unit. That default is SURFACED as a note by
  // the caller (see buildNotes) — equal weighting applied silently is the original bug.
  const weightUnits = account.weight !== undefined && account.weight > 0 ? account.weight : 1;
  const weekly = selectWeeklyBudget(account.limits, nowMs, account.predictedResetAt);
  // Clamped for the arithmetic (the endpoint grants overage past 100%), rounded only for
  // display — rounding before the sum would drift the fleet totals off the true balance.
  const usedFraction = weekly?.percent !== undefined ? clamp01(weekly.percent / 100) : undefined;
  const usedPct = weekly?.percent !== undefined ? roundPct(weekly.percent) : undefined;

  const base: AccountPacing = {
    accountId: account.accountId,
    label: account.label,
    weightUnits,
    ...(usedPct !== undefined ? { usedPct } : {}),
    ...(weekly?.resetsAt !== undefined ? { resetsAt: weekly.resetsAt } : {}),
    resetPredicted: weekly?.predicted === true,
    contributing: false,
  };

  if (account.quarantined) {
    return { pacing: { ...base, reason: 'quarantined - excluded until re-login' } };
  }
  if (usedFraction === undefined) {
    return {
      pacing: {
        ...base,
        reason: weekly === undefined ? 'no weekly limit reported' : 'weekly limit missing percent',
      },
    };
  }

  // One formula covers both states: an account whose weekly window has closed reports 0% used,
  // so it holds its full allowance and needs no dormant special case.
  const balanceUnits = weightUnits * (1 - usedFraction);
  return {
    pacing: { ...base, balanceUnits, contributing: true },
    sim: {
      accountId: account.accountId,
      label: account.label,
      weight: weightUnits,
      balance: balanceUnits,
      ...(weekly?.resetsAt !== undefined ? { resetsAt: weekly.resetsAt } : {}),
    },
  };
}

// ---------------------------------------------------------------------------
// The simulation
// ---------------------------------------------------------------------------

/**
 * Walk the fleet forward to the horizon. The only events are weekly resets: between them the
 * measured burn is drawn from the soonest-expiring account with balance, and at each one the
 * resetting account's leftover balance is recorded as waste and its allowance restored.
 * An account with no known reset never resets inside the horizon — its budget is spendable but
 * never replenished, which is the honest reading of "we cannot see its clock".
 */
function simulate(
  sim: SimAccount[],
  burnUnitsPerDay: number,
  nowMs: number,
  horizonDays: number,
): { dryAtMs?: number; waste: PacingWaste[] } {
  const endMs = nowMs + horizonDays * DAY_MS;
  const events: Array<{ atMs: number; accountId: string }> = [];
  for (const a of sim) {
    if (a.resetsAt === undefined) continue;
    for (let t = a.resetsAt; t <= endMs; t += WEEK_MS)
      events.push({ atMs: t, accountId: a.accountId });
  }
  events.sort((x, y) => x.atMs - y.atMs);

  const waste: PacingWaste[] = [];
  let clock = nowMs;
  for (const event of events) {
    const dryAtMs = draw(sim, burnUnitsPerDay, clock, event.atMs);
    if (dryAtMs !== undefined) return { dryAtMs, waste };
    const account = sim.find((a) => a.accountId === event.accountId);
    if (account === undefined) continue; // unreachable: events are built from `sim`
    if (account.balance > UNIT_EPSILON) {
      waste.push({
        accountId: account.accountId,
        label: account.label,
        units: account.balance,
        atMs: event.atMs,
      });
    }
    // The window rolls: full again, remainder destroyed, and the next expiry is one cadence
    // out. Advancing it matters for the draw order — an account that just reset is now the
    // LAST one whose budget is about to be lost, not the first.
    account.balance = account.weight;
    account.resetsAt = event.atMs + WEEK_MS;
    clock = event.atMs;
  }
  const dryAtMs = draw(sim, burnUnitsPerDay, clock, endMs);
  return { ...(dryAtMs !== undefined ? { dryAtMs } : {}), waste };
}

/** Spend the burn accrued between `fromMs` and `toMs`, always from the account whose quota
 *  expires soonest (unused weekly budget is destroyed at reset, so it must go first; an
 *  account with no known reset is drawn last). Returns the moment the fleet ran out, or
 *  undefined when the whole interval was covered. */
function draw(
  sim: SimAccount[],
  burnUnitsPerDay: number,
  fromMs: number,
  toMs: number,
): number | undefined {
  const days = (toMs - fromMs) / DAY_MS;
  if (days <= 0) return undefined;
  let remaining = burnUnitsPerDay * days;
  if (remaining <= UNIT_EPSILON) return undefined;

  const order = [...sim]
    .filter((a) => a.balance > UNIT_EPSILON)
    .sort((x, y) => (x.resetsAt ?? Infinity) - (y.resetsAt ?? Infinity));
  for (const account of order) {
    const take = Math.min(account.balance, remaining);
    account.balance -= take;
    remaining -= take;
    if (remaining <= UNIT_EPSILON) return undefined;
  }
  // Ran out partway through the interval; burn is constant, so the moment is linear in the
  // units actually spent. `burnUnitsPerDay` is provably > 0 here (`remaining` started above
  // the epsilon and is proportional to it).
  const spent = burnUnitsPerDay * days - remaining;
  return fromMs + (spent / burnUnitsPerDay) * DAY_MS;
}

// ---------------------------------------------------------------------------
// Copy. ASCII only (no em dashes) — this is operator-facing runtime text.
// ---------------------------------------------------------------------------

/** The verdict sentence for a fleet the simulation could actually run. */
function buildHeadline(p: {
  availableUnits: number;
  capacityUnits: number;
  burnUnitsPerDay: number;
  replenishUnitsPerDay: number;
  horizonDays: number;
  nowMs: number;
  dryAtMs?: number;
}): string {
  const stock =
    `${units(p.availableUnits)} of ${units(p.capacityUnits)} available (${share(p.availableUnits, p.capacityUnits)}), ` +
    `burning ${rate(p.burnUnitsPerDay)} against ${rate(p.replenishUnitsPerDay)} replenished`;
  return p.dryAtMs === undefined
    ? `${stock} - sustainable for the next ${p.horizonDays}d.`
    : `${stock} - runs dry in ${humanizeDuration(p.dryAtMs - p.nowMs)}.`;
}

/** The verdict sentence when the simulation could not run: say what IS known and why the rest
 *  is missing, rather than falling back to a number that would look like a verdict. */
function unknownHeadline(
  contributing: number,
  availableUnits: number,
  capacityUnits: number,
  replenishUnitsPerDay: number,
): string {
  if (contributing === 0) return 'No weekly usage data yet - fleet pacing unknown.';
  return (
    `${units(availableUnits)} of ${units(capacityUnits)} available (${share(availableUnits, capacityUnits)}), ` +
    `${rate(replenishUnitsPerDay)} replenished - burn rate not measured yet, so no sustainability verdict.`
  );
}

/** "38u expires unused within 14d: 20u on tjin.29 in 6d, 18u on legoboy in 5d 3h."
 *
 *  Aggregated PER ACCOUNT rather than per reset: an account that wastes at two resets inside
 *  the horizon is one decision ("use tjin.29"), not two, and naming it twice buries the other
 *  accounts. Ranked by units lost, because the biggest loss is the one worth acting on, and
 *  stamped with that account's FIRST wasting reset, which is the deadline to act by. The named
 *  entries are capped, but the remainder is COUNTED in the sentence, never dropped. */
function wasteNote(
  waste: PacingWaste[],
  wastedUnits: number,
  horizonDays: number,
  nowMs: number,
): string {
  const byAccount = new Map<string, { label: string; units: number; firstAtMs: number }>();
  for (const w of waste) {
    const entry = byAccount.get(w.accountId);
    if (entry === undefined) {
      byAccount.set(w.accountId, { label: w.label, units: w.units, firstAtMs: w.atMs });
      continue;
    }
    entry.units += w.units;
    entry.firstAtMs = Math.min(entry.firstAtMs, w.atMs);
  }
  const ranked = [...byAccount.values()].sort(
    (a, b) => b.units - a.units || a.firstAtMs - b.firstAtMs || a.label.localeCompare(b.label),
  );
  const named = ranked
    .slice(0, MAX_NAMED_WASTE)
    .map((w) => `${units(w.units)} on ${w.label} in ${humanizeDuration(w.firstAtMs - nowMs)}`)
    .join(', ');
  const rest = Math.max(0, ranked.length - MAX_NAMED_WASTE);
  const tail = rest > 0 ? `, and ${rest} more account${rest === 1 ? '' : 's'}` : '';
  return `${units(wastedUnits)} expires unused within ${horizonDays}d: ${named}${tail}.`;
}

/** Every assumption the result rests on, stated outright. Order is fixed so the rendered
 *  block is stable between polls. */
function buildNotes(
  inputs: AccountUsageInput[],
  accounts: AccountPacing[],
  contributing: number,
  burnUnitsPerDay: number | undefined,
): string[] {
  const notes: string[] = [];
  // A missing burn rate is only worth reporting when there is a fleet to measure: with no
  // contributing account the headline already says the whole story.
  if (burnUnitsPerDay === undefined && contributing > 0) {
    notes.push('no usage history to measure a burn rate from yet.');
  }
  if (inputs.some((a) => a.weight === undefined)) {
    notes.push('plan tiers unknown, so accounts are weighted equally (1 unit each).');
  }
  const predicted = accounts.filter((a) => a.contributing && a.resetPredicted);
  if (predicted.length > 0) {
    notes.push(`next weekly reset predicted from history for ${labels(predicted)}.`);
  }
  const blind = accounts.filter((a) => a.contributing && a.resetsAt === undefined);
  if (blind.length > 0) {
    notes.push(
      `no reset time for ${labels(blind)}, so their budget is never modelled as expiring.`,
    );
  }
  for (const a of accounts) {
    if (a.reason !== undefined) notes.push(`${a.label} excluded: ${a.reason}.`);
  }
  return notes;
}

function labels(accounts: AccountPacing[]): string {
  return accounts.map((a) => a.label).join(', ');
}

/** "20u" / "6.5u" — whole units read cleanly, fractions keep one decimal. */
function units(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}u`;
}

function rate(unitsPerDay: number): string {
  return `${units(unitsPerDay)}/day`;
}

/** Share of capacity as a whole percent. Capacity is 0 only when nothing contributes, which
 *  the caller has already routed to the no-data headline. */
function share(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '0%';
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Compact rendering of the pacing outlook, printed under the timeline and usage views.
 *  Mirrors `renderPlanSummary`: one headline line, then the honesty notes as bullets. */
export function renderPacingSummary(pacing: Pick<Pacing, 'headline' | 'notes'>): string {
  return [`Pacing: ${pacing.headline}`, ...pacing.notes.map((n) => `  - ${n}`)].join('\n');
}
