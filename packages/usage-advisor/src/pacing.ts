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

/** Accounts named individually in any rendered list; the rest are counted, never dropped. */
const MAX_NAMED_ACCOUNTS = 3;

export type PacingVerdict = 'sustainable' | 'runs-dry' | 'unknown';

/** Why an account contributes nothing to the totals. Carried alongside the prose `reason` so a
 *  renderer can branch on the cause without parsing English — a fleet that is entirely
 *  quarantined needs different advice from one that has simply never been polled. */
export type PacingExclusion = 'quarantined' | 'no-weekly-limit' | 'no-percent';

/** The one place each exclusion's prose lives, so the code and the sentence can never drift. */
const EXCLUSION_REASON: Record<PacingExclusion, string> = {
  quarantined: 'quarantined - excluded until re-login',
  'no-weekly-limit': 'no weekly limit reported',
  'no-percent': 'weekly limit missing percent',
};

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
  /** Why this account was excluded from the totals, in prose. Absent when contributing. */
  reason?: string;
  /** The same exclusion as a code. Absent when contributing. */
  excluded?: PacingExclusion;
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
  /** True when a CONTRIBUTING account's plan weight was unresolved, so the fleet math actually
   *  fell back to weighting it equally (1 unit). Excluded accounts cannot trigger it: their
   *  weight never entered a total, so claiming the math was assumed would be false. Split out
   *  from `notes` as its own field because the compact CLI view (`renderPacingSummary`) must
   *  never let this caveat get lost while the rest of the prose notes are compressed away — it
   *  is the one assumption a reader cannot detect from the numbers alone. */
  tiersUnknown: boolean;
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
  // The equal-weighting caveat is about the arithmetic, so only an account that entered the
  // arithmetic can raise it. One excluded weightless account beside one contributing account of
  // known tier means nothing was assumed, and saying otherwise sends a reader hunting for a
  // fallback that never happened.
  const tiersUnknown = analyzed.some((a) => a.pacing.contributing && a.weightAssumed);
  const notes = buildNotes(outAccounts, sim.length, burnUnitsPerDay, tiersUnknown);

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
      tiersUnknown,
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
    tiersUnknown,
  };
}

// ---------------------------------------------------------------------------
// Per-account analysis
// ---------------------------------------------------------------------------

/** One account's public entry, its simulation state when it contributes, and whether its plan
 *  weight had to be assumed. */
function analyzeAccount(
  account: AccountUsageInput,
  nowMs: number,
): { pacing: AccountPacing; weightAssumed: boolean; sim?: SimAccount } {
  // An unresolved plan weight means 1 Pro-equivalent unit. That default is SURFACED as a note by
  // the caller (see buildNotes) — equal weighting applied silently is the original bug.
  const weightUnits = account.weight !== undefined && account.weight > 0 ? account.weight : 1;
  // Read the fallback off the RESULT rather than re-testing the input, so "we assumed a tier"
  // can never disagree with the tier actually used. A genuine Pro account (weight 1) is not a
  // fallback; an absent or non-positive weight is.
  const weightAssumed = weightUnits !== account.weight;
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
    return { pacing: exclude(base, 'quarantined'), weightAssumed };
  }
  if (usedFraction === undefined) {
    return {
      pacing: exclude(base, weekly === undefined ? 'no-weekly-limit' : 'no-percent'),
      weightAssumed,
    };
  }

  // One formula covers both states: an account whose weekly window has closed reports 0% used,
  // so it holds its full allowance and needs no dormant special case.
  const balanceUnits = weightUnits * (1 - usedFraction);
  return {
    pacing: { ...base, balanceUnits, contributing: true },
    weightAssumed,
    sim: {
      accountId: account.accountId,
      label: account.label,
      weight: weightUnits,
      balance: balanceUnits,
      ...(weekly?.resetsAt !== undefined ? { resetsAt: weekly.resetsAt } : {}),
    },
  };
}

/** Mark an account as contributing nothing, tagging it with both the code and its one canonical
 *  sentence — the pair always travels together so no caller can report one without the other. */
function exclude(base: AccountPacing, excluded: PacingExclusion): AccountPacing {
  return { ...base, excluded, reason: EXCLUSION_REASON[excluded] };
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

/** One account's total loss inside the horizon, aggregated from however many individual resets
 *  it wastes budget at. */
interface WasteByAccount {
  label: string;
  units: number;
  /** The account's FIRST wasting reset — the deadline to act by. */
  firstAtMs: number;
}

/** Aggregate waste events PER ACCOUNT rather than per reset: an account that wastes at two
 *  resets inside the horizon is one decision ("use tjin.29"), not two, and naming it twice
 *  buries the other accounts. */
function wasteByAccount(waste: PacingWaste[]): WasteByAccount[] {
  const byAccount = new Map<string, WasteByAccount>();
  for (const w of waste) {
    const entry = byAccount.get(w.accountId);
    if (entry === undefined) {
      byAccount.set(w.accountId, { label: w.label, units: w.units, firstAtMs: w.atMs });
      continue;
    }
    entry.units += w.units;
    entry.firstAtMs = Math.min(entry.firstAtMs, w.atMs);
  }
  return [...byAccount.values()];
}

/** Biggest loss first — the ordering for the prose note, which prints EVERY named account's own
 *  deadline, so leading with the largest loss costs the reader no accuracy. */
function rankWasteByUnits(waste: PacingWaste[]): WasteByAccount[] {
  return wasteByAccount(waste).sort(
    (a, b) => b.units - a.units || a.firstAtMs - b.firstAtMs || a.label.localeCompare(b.label),
  );
}

/** Soonest deadline first — the ordering for the compact dashboard line, which prints ONE
 *  deadline beside a fleet-wide total. Only the earliest deadline is safe there: any later one
 *  tells a reader the whole total keeps until then, and the budget expiring first burns while
 *  they wait. Ties break on the larger loss, then the label, so the line is stable poll to poll. */
function rankWasteByDeadline(waste: PacingWaste[]): WasteByAccount[] {
  return wasteByAccount(waste).sort(
    (a, b) => a.firstAtMs - b.firstAtMs || b.units - a.units || a.label.localeCompare(b.label),
  );
}

/** "38u expires unused within 14d: 20u on tjin.29 in 6d, 18u on legoboy in 5d 3h." The named
 *  entries are capped, but the remainder is COUNTED in the sentence, never dropped. */
function wasteNote(
  waste: PacingWaste[],
  wastedUnits: number,
  horizonDays: number,
  nowMs: number,
): string {
  const ranked = rankWasteByUnits(waste);
  const named = ranked
    .slice(0, MAX_NAMED_ACCOUNTS)
    .map((w) => `${units(w.units)} on ${w.label} in ${humanizeDuration(w.firstAtMs - nowMs)}`)
    .join(', ');
  const rest = Math.max(0, ranked.length - MAX_NAMED_ACCOUNTS);
  const tail = rest > 0 ? `, and ${rest} more account${rest === 1 ? '' : 's'}` : '';
  return `${units(wastedUnits)} expires unused within ${horizonDays}d: ${named}${tail}.`;
}

/** Every assumption the result rests on, stated outright. Order is fixed so the rendered
 *  block is stable between polls. */
function buildNotes(
  accounts: AccountPacing[],
  contributing: number,
  burnUnitsPerDay: number | undefined,
  tiersUnknown: boolean,
): string[] {
  const notes: string[] = [];
  // A missing burn rate is only worth reporting when there is a fleet to measure: with no
  // contributing account the headline already says the whole story.
  if (burnUnitsPerDay === undefined && contributing > 0) {
    notes.push('no usage history to measure a burn rate from yet.');
  }
  // Taken from the caller's already-computed flag rather than re-derived, so the prose bullet
  // and the dashboard marker can never claim different things about the same fleet.
  if (tiersUnknown) {
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

/** The unit value AS DISPLAYED. Anything that compares two unit figures a reader can see side
 *  by side must compare these, not the raw ones: 0.62 and 0.58 both print "0.6u", so a raw
 *  comparison renders an operator its own operands contradict. */
function roundUnits(value: number): number {
  return Math.round(value * 10) / 10;
}

/** "20u" / "6.5u" — whole units read cleanly, fractions keep one decimal. */
function units(value: number): string {
  const rounded = roundUnits(value);
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

/** Style hooks for `renderPacingSummary`, mirroring `OutlookStyle` in timeline.ts (same
 *  identity-default, pure-decorator contract) rather than inventing a second convention. */
export interface PacingStyle {
  /** The `[ok]`/`[!!]`/`[--]` verdict marker, colored by what it says rather than by a fixed
   *  role — sustainable, runs-dry and unknown are different colors, so the mark carries the
   *  verdict that produced it. */
  marker(text: string, verdict: PacingVerdict): string;
  /** The headroom phrase, colorable by its severity band (mirrors `OutlookStyle.percent`). */
  percent(text: string, pct: number): string;
  /** The waste line: budget about to be destroyed unused. Loud because it is the single most
   *  actionable line in the block. */
  waste(text: string): string;
  /** A state the operator has to repair before pacing can say anything at all. */
  warn(text: string): string;
  /** Low-salience furniture: the unit legend, separators. */
  dim(text: string): string;
  /** The row labels down the left edge. These are what the eye lands on first when scanning the
   *  block, so they are emphasized rather than dimmed — the label is the index, not furniture. */
  label(text: string): string;
}

/** The identity style — plain text, the default everywhere. */
export const PLAIN_PACING_STYLE: PacingStyle = {
  marker: (t) => t,
  percent: (t) => t,
  waste: (t) => t,
  warn: (t) => t,
  dim: (t) => t,
  label: (t) => t,
};

/** Width of the row-label column. Sized to the longest label ("expires") so the value columns
 *  line up under each other; alignment is computed on plain text, which is safe because every
 *  `PacingStyle` hook is width-preserving. */
const ROW_LABEL_WIDTH = 7;

/**
 * Compact, dashboard-style rendering of the pacing outlook, printed under `cctl usage` and
 * `cctl timeline`: a verdict line, then labelled rows.
 *
 *   Pacing  [ok] sustainable past 14d (6u/11.4u burned per day)
 *     left     54u of 80u (67%)
 *     expires  jina25 9.6u in 4d 1h, then 2 more - 72u total over 14d
 *     1u = one Pro account-week (a Max 20x counts 20)
 *
 * EVERY NUMBER IS LABELLED, which the first compact version did not manage: it printed
 * "burn 0.3u/d < 0.6u/d - 14d", where the second figure named nothing (a reader cannot tell
 * replenishment from a threshold or a recommendation) and the bare "14d" carried no verb. The
 * burn pair now sits inside the verdict it explains, as the fraction of the daily refill being
 * consumed, which is the one comparison that decides sustainable-vs-dry.
 *
 * The unit needs the legend because it is not a quantity anyone can eyeball: 1u is one Pro
 * account's weekly allowance, so the SAME fleet reads "2.7u of 4u" while plan tiers are unknown
 * and "54u of 80u" once they resolve to Max 20x. Percentages and the burn fraction are stable
 * across that change; the absolute figures are not.
 *
 * This deliberately does not print `pacing.notes` — those are the full-prose honesty markers
 * (predicted resets, excluded accounts, missing burn history) that `Pacing.headline`/`notes`
 * still carry for the Discord embed, which has room for prose and no on-call operator staring
 * at it for pacing decisions every few minutes.
 *
 * Compaction is only safe for a caveat the reader can act on LATER. `cctl timeline` prints its
 * own per-account rows (quarantine included), but `cctl usage` prints nothing of the sort, so on
 * that surface this block is the only pacing signal there is: anything that stops the fleet from
 * being measurable at all has to survive compaction here, or the operator is told nothing.
 */
export function renderPacingSummary(
  pacing: Pick<
    Pacing,
    | 'verdict'
    | 'availableUnits'
    | 'capacityUnits'
    | 'burnUnitsPerDay'
    | 'replenishUnitsPerDay'
    | 'horizonDays'
    | 'dryAtMs'
    | 'wastedUnits'
    | 'waste'
    | 'tiersUnknown'
    | 'accounts'
  >,
  nowMs: number,
  style: PacingStyle = PLAIN_PACING_STYLE,
): string {
  // No contributing account, so there are no totals to print — but "no data" and "the data is
  // fine and every account is locked out" are opposite situations with opposite fixes, and only
  // the accounts themselves say which one this is.
  if (pacing.capacityUnits <= 0) return renderNoCapacity(pacing.accounts, style);

  const pct = Math.round((pacing.availableUnits / pacing.capacityUnits) * 100);
  const marker =
    pacing.verdict === 'runs-dry' ? '[!!]' : pacing.verdict === 'unknown' ? '[--]' : '[ok]';

  // The verdict, then the burn pair that produced it. Naming the outcome BEFORE the arithmetic
  // is the whole point of a dashboard line: the reader who only reads three words still learns
  // whether anything is wrong.
  const outcome =
    pacing.verdict === 'runs-dry' && pacing.dryAtMs !== undefined
      ? `runs dry in ${humanizeDuration(pacing.dryAtMs - nowMs)}`
      : pacing.verdict === 'sustainable'
        ? `sustainable past ${pacing.horizonDays}d`
        : 'burn rate not measured yet';
  const head =
    `Pacing  ${style.marker(marker, pacing.verdict)} ${outcome}` +
    `${burnFraction(pacing.burnUnitsPerDay, pacing.replenishUnitsPerDay, style)}`;

  // `pct` is headroom (available/capacity) — high is GOOD. `style.percent`'s severity bands
  // (shared with every other percent in the CLI) are keyed on percent USED — high is bad. Feed
  // it the inverse so a fleet sitting on 90% headroom reads green, not a false-alarm red.
  const rows = [
    row(
      'left',
      style.percent(
        `${units(pacing.availableUnits)} of ${units(pacing.capacityUnits)} (${pct}%)`,
        100 - pct,
      ),
      style,
    ),
  ];

  if (pacing.wastedUnits > UNIT_EPSILON) {
    const expiring = renderExpiring(pacing.waste, pacing.wastedUnits, pacing.horizonDays, nowMs);
    if (expiring !== undefined) rows.push(row('expires', style.waste(expiring), style));
  }
  rows.push(`  ${style.dim(unitLegend(pacing.tiersUnknown))}`);

  return [head, ...rows].join('\n');
}

/** One labelled row, padded on the PLAIN label so the value columns align regardless of style. */
function row(label: string, value: string, style: PacingStyle): string {
  return `  ${style.label(label.padEnd(ROW_LABEL_WIDTH))}  ${value}`;
}

/** "(6u/11.4u burned per day)" — what is being spent against what arrives, as a fraction, since
 *  the ratio is what decides the verdict it sits beside. Colored by the share of the refill
 *  consumed, so a fleet burning faster than it refills reads hot even when the stock is still
 *  healthy: `severityOf`-style bands are keyed on percent USED, and burn/refill IS that percent.
 *  Empty when burn was never measured — the verdict already says so, and inventing a zero would
 *  read as "nothing is being used". */
function burnFraction(
  burnUnitsPerDay: number | undefined,
  replenishUnitsPerDay: number,
  style: PacingStyle,
): string {
  if (burnUnitsPerDay === undefined) return '';
  const shareOfRefill =
    replenishUnitsPerDay > 0 ? Math.round((burnUnitsPerDay / replenishUnitsPerDay) * 100) : 100;
  const text = `${units(burnUnitsPerDay)}/${units(replenishUnitsPerDay)} burned per day`;
  return ` (${style.percent(text, shareOfRefill)})`;
}

/** "jina25 9.6u in 4d 1h, then 2 more - 72u total over 14d".
 *
 *  The named account is the one whose budget expires FIRST, paired with ITS OWN loss and ITS OWN
 *  deadline. That pairing is the load-bearing part: an earlier version printed the fleet-wide
 *  total beside one account's date, which reads as "all of it keeps until then".
 *
 *  Note the first waster is NOT generally the first account to reset. The simulation spends from
 *  whichever account expires soonest, so the earliest-resetting accounts are typically drained to
 *  nothing and lose NOTHING; the first real loss belongs to the first account still holding
 *  budget when its reset lands. Naming it "soonest" invited exactly the reading it deserves —
 *  that it resets first — so the row says what expires, not what is soonest. */
function renderExpiring(
  waste: PacingWaste[],
  wastedUnits: number,
  horizonDays: number,
  nowMs: number,
): string | undefined {
  const first = rankWasteByDeadline(waste)[0];
  if (first === undefined) return undefined;
  const others = wasteByAccount(waste).length - 1;
  const head = `${first.label} ${units(first.units)} in ${humanizeDuration(first.firstAtMs - nowMs)}`;
  // With a single waster the fleet total IS the named figure, so repeating it would just invite
  // the reader to look for the difference between two identical numbers.
  return others > 0
    ? `${head}, then ${others} more - ${units(wastedUnits)} total over ${horizonDays}d`
    : `${head} - nothing else expires within ${horizonDays}d`;
}

/** The unit legend. `u` is unguessable — it is one Pro account's WEEKLY allowance, which is why
 *  the same fleet reads "4u" and "80u" either side of resolving its plan tiers. When a tier could
 *  not be resolved the legend states the fallback instead of the multiplier, because quoting the
 *  20x rule to a reader whose accounts were all counted as 1u describes math that did not run. */
function unitLegend(tiersUnknown: boolean): string {
  return tiersUnknown
    ? '1u = one Pro account-week; plan tiers unknown, so every account counts 1u'
    : '1u = one Pro account-week (a Max 20x counts 20)';
}

/** The line for a fleet with no measurable capacity. An account excluded for quarantine holds
 *  real, readable usage data behind a login the operator has to redo, so it gets named with the
 *  command that fixes it; every other cause genuinely is missing data and says so. */
function renderNoCapacity(accounts: AccountPacing[], style: PacingStyle): string {
  const locked = accounts.filter((a) => a.excluded === 'quarantined');
  if (locked.length === 0) return 'Pacing: no usage data yet.';
  const named = locked
    .slice(0, MAX_NAMED_ACCOUNTS)
    .map((a) => a.label)
    .join(', ');
  const rest = locked.length - MAX_NAMED_ACCOUNTS;
  return (
    `Pacing: ${style.warn('[--]')} no usable accounts - ${named}${rest > 0 ? ` +${rest}` : ''} ` +
    `quarantined; run: cctl accounts relogin <label>`
  );
}
