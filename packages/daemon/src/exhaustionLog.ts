// The exhaustion log: one line each time no account could take work, and one when usage came
// back. That is the fleet's worst failure (auto-switch walked every account and all of them are
// spent), so every occurrence goes on record: when, for how long, why each account was out, and
// the switches that led there.
//
// The file IS the log, the only store: append-only JSON lines at
// `<dataDir>/exhaustion-log.jsonl`, each carrying a plain-English `summary` so the file reads on
// its own, rendered by `cctl exhausted`. The daemon reads it back on start to resume an episode
// that was open when it stopped, so a restart never announces the same outage twice.
//
// Deciding WHEN an episode starts and ends is pure (see {@link decideExhaustion}) and leans on
// the usage advisor's shared availability rule, so the log can never disagree with the plan or
// the post-switch session resume about whether an account has usage left.

import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  describeFirstBack,
  describeUnavailable,
  humanizeDuration,
  LIMIT_NOUN,
  type AccountAvailability,
  type FleetAvailability,
  type LimitInput,
  type UnavailableReason,
} from '@claude-control/usage-advisor';

/** The log's file name inside the daemon's data directory. */
export const EXHAUSTION_LOG_FILE = 'exhaustion-log.jsonl';

/** How far back the switch chain in an `exhausted` entry reaches: one 5-hour window, the
 *  span over which auto-switch could have walked every account's window. */
export const SWITCH_CHAIN_WINDOW_MS = 5 * 60 * 60_000;

/** Where the log lives for a given data directory. Shared by the daemon (writer) and the CLI
 *  (reader), so the two can never look in different places. */
export function exhaustionLogPath(dataDir: string): string {
  return join(dataDir, EXHAUSTION_LOG_FILE);
}

/** One account as it stood when the episode began. */
export interface ExhaustedAccount {
  accountId: string;
  label: string;
  reason: UnavailableReason;
  /** Percent used on the binding limit, when known. */
  percent?: number;
  /** When it was expected back (the last of its walls to reset). */
  backAt?: number;
  backAtPredicted?: boolean;
  /** The limits at the wall, with their reported resets: what a later cycle checks to tell a
   *  real return from a poll that merely came back empty. */
  spent: LimitInput[];
}

/** One switch in the walk that led to the episode, by each account's label when the entry was
 *  written (an account removed since shows its id). */
export interface ExhaustionSwitch {
  at: number;
  from: string | null;
  to: string;
  origin?: string;
  reason?: string;
}

/** Written when the last account runs out. */
export interface ExhaustedRecord {
  v: 1;
  event: 'exhausted';
  /** Pairs this entry with its `recovered` entry. */
  id: string;
  at: number;
  /** `at` as ISO-8601, for a human reading the file. */
  time: string;
  summary: string;
  /** The live account's label at that moment, or null when none was live. */
  active: string | null;
  accounts: ExhaustedAccount[];
  firstBack?: { accountId: string; label: string; at: number; predicted: boolean };
  /** Every switch of the live account in the {@link SWITCH_CHAIN_WINDOW_MS} before `at`. */
  switches: ExhaustionSwitch[];
}

/** How the first account came back. */
export type RecoveryHow = 'reset' | 'headroom' | 'relogin' | 'new_account';

/** Written when some account can take work again. */
export interface RecoveredRecord {
  v: 1;
  event: 'recovered';
  id: string;
  /** When the daemon saw it. */
  at: number;
  time: string;
  summary: string;
  /** When the account actually came back: the reset that brought it back when that is how,
   *  else `at`. A daemon that was stopped through the reset still measures the outage right. */
  backSince: number;
  /** `backSince` minus the episode's start. */
  durationMs: number;
  account: { accountId: string; label: string };
  how: RecoveryHow;
  /** For `reset`: the limit whose reset brought it back. */
  limit?: LimitInput['kind'];
}

export type ExhaustionRecord = ExhaustedRecord | RecoveredRecord;

/** An episode as the CLI lists it: its start and, once over, its end. */
export interface ExhaustionEpisode {
  start: ExhaustedRecord;
  end?: RecoveredRecord;
}

// ---- reading lines back -----------------------------------------------------------------------
//
// Every field the daemon or the CLI reads is checked before a line is accepted, down to each
// account and limit: a line from a newer build (another `v`), a torn write, or a hand edit that
// left a field out is skipped whole, never half-used. Half-used, it would throw on every poll
// cycle that judged the episode it describes, and stop `cctl exhausted` from printing anything.

const LIMIT_KINDS = new Set<string>(['session', 'weekly_all', 'weekly_scoped']);
const REASONS = new Set<string>([...LIMIT_KINDS, 'quarantined']);
const HOWS = new Set<string>(['reset', 'headroom', 'relogin', 'new_account']);

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isString = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown, check: (v: unknown) => boolean): boolean =>
  v === undefined || check(v);

function isLimit(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.kind) &&
    LIMIT_KINDS.has(v.kind) &&
    isNumber(v.percent) &&
    optional(v.resetsAt, isNumber)
  );
}

function isExhaustedAccount(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.accountId) &&
    isString(v.label) &&
    isString(v.reason) &&
    REASONS.has(v.reason) &&
    Array.isArray(v.spent) &&
    v.spent.every(isLimit) &&
    optional(v.percent, isNumber) &&
    optional(v.backAt, isNumber)
  );
}

function isSwitch(v: unknown): boolean {
  return (
    isObject(v) &&
    isNumber(v.at) &&
    (v.from === null || isString(v.from)) &&
    isString(v.to) &&
    optional(v.origin, isString) &&
    optional(v.reason, isString)
  );
}

/** Narrow one parsed line to a record this build understands (see above). */
function isRecord(value: unknown): value is ExhaustionRecord {
  if (!isObject(value) || value.v !== 1 || !isString(value.id) || !isNumber(value.at)) {
    return false;
  }
  if (value.event === 'exhausted') {
    return (
      Array.isArray(value.accounts) &&
      value.accounts.every(isExhaustedAccount) &&
      Array.isArray(value.switches) &&
      value.switches.every(isSwitch) &&
      (value.active === null || isString(value.active)) &&
      optional(value.firstBack, (f) => isObject(f) && isString(f.label) && isNumber(f.at))
    );
  }
  if (value.event === 'recovered') {
    const account = value.account;
    return (
      isObject(account) &&
      isString(account.accountId) &&
      isString(account.label) &&
      isNumber(value.backSince) &&
      isNumber(value.durationMs) &&
      isString(value.how) &&
      HOWS.has(value.how) &&
      optional(value.limit, (l) => isString(l) && LIMIT_KINDS.has(l))
    );
  }
  return false;
}

/** Pair starts with their ends, oldest first. An end with no start (a hand-edited file) is
 *  dropped; a start with no end is the episode still open. */
export function episodesOf(records: ExhaustionRecord[]): ExhaustionEpisode[] {
  const episodes: ExhaustionEpisode[] = [];
  const byId = new Map<string, ExhaustionEpisode>();
  for (const r of records) {
    if (r.event === 'exhausted') {
      const episode: ExhaustionEpisode = { start: r };
      episodes.push(episode);
      byId.set(r.id, episode);
    } else {
      const episode = byId.get(r.id);
      if (episode !== undefined && episode.end === undefined) episode.end = r;
    }
  }
  return episodes;
}

/** The episode still open: the LAST start, when it has no end. An older start left without an
 *  end (a crash between two writes) is history, not a second open episode. */
export function openEpisodeOf(records: ExhaustionRecord[]): ExhaustedRecord | undefined {
  const last = episodesOf(records).at(-1);
  return last !== undefined && last.end === undefined ? last.start : undefined;
}

/** Reads and appends the log file. */
export class ExhaustionLog {
  constructor(readonly path: string) {}

  /** Append one record as one line. Creates the directory on first use. A crash mid-append can
   *  leave the file ending in a fragment with no newline; a record appended straight onto it
   *  would join that fragment and be unreadable, so it starts on a fresh line instead. */
  async append(record: ExhaustionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const lead = (await endsMidLine(this.path)) ? '\n' : '';
    await appendFile(this.path, lead + JSON.stringify(record) + '\n', 'utf8');
  }

  /** Every record, oldest first. A missing file is an empty log; an unreadable line is skipped. */
  async read(): Promise<ExhaustionRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.path, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const records: ExhaustionRecord[] = [];
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue; // a torn write from a crash mid-append
      }
      if (isRecord(parsed)) records.push(parsed);
    }
    return records;
  }
}

/** Whether a file's last byte is something other than a newline. A missing or empty file ends
 *  on a line boundary. Reads one byte, however long the log grows. */
async function endsMidLine(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  try {
    const { size } = await handle.stat();
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } finally {
    await handle.close();
  }
}

// ---- an open episode ---------------------------------------------------------------------------

/** One account as the daemon tracks it through an open episode: what keeps it out, as of the
 *  latest reading that showed it out. */
export interface TrackedAccount {
  label: string;
  reason: UnavailableReason;
  /** Its walls, from the latest reading with numbers that showed it out. */
  spent: LimitInput[];
  /** The last moment a reading showed it out: its return is never dated earlier. */
  lastOutAt: number;
}

/**
 * An open episode: the start entry as the file holds it, plus every account's latest known
 * state. The start entry never changes; the tracking lives in memory and is rebuilt from the
 * start entry after a restart. It is what a return is judged against, so a wall an account hits
 * mid-outage, or a reset the endpoint moves later, cannot be mistaken for the account coming
 * back once the reset recorded at the start has passed.
 */
export interface OpenEpisode {
  record: ExhaustedRecord;
  accounts: ReadonlyMap<string, TrackedAccount>;
}

/** The open episode as its start entry describes it. */
export function openEpisodeFrom(record: ExhaustedRecord): OpenEpisode {
  return {
    record,
    accounts: new Map(
      record.accounts.map((a) => [
        a.accountId,
        { label: a.label, reason: a.reason, spent: a.spent, lastOutAt: record.at },
      ]),
    ),
  };
}

/**
 * Fold one cycle's readings into the open episode. Every account out right now is tracked as of
 * now: its walls replaced by this reading's when the reading has numbers (a dead login with no
 * numbers keeps the walls it had), its last-seen-out moved to now. An account first seen out
 * mid-outage joins here, so its return needs the same evidence as everyone else's. Accounts that
 * can take work are left as they were: whether they are back is {@link decideExhaustion}'s call.
 */
export function trackOpenEpisode(
  open: OpenEpisode,
  fleet: FleetAvailability,
  now: number,
): OpenEpisode {
  const accounts = new Map(open.accounts);
  for (const a of fleet.accounts) {
    if (a.usable || a.reason === undefined) continue;
    const before = accounts.get(a.accountId);
    accounts.set(a.accountId, {
      label: a.label,
      reason: a.reason,
      spent: a.measured ? a.spent : (before?.spent ?? []),
      lastOutAt: now,
    });
  }
  return { record: open.record, accounts };
}

/** Whether an outage is on, judged from the log and one reading the way the daemon judges it: an
 *  open episode stays on until an account is provably back, and with none open it is on when no
 *  account can take work. For the CLI, which has the start entry and the current numbers but not
 *  the daemon's tracking between them. */
export function outageStatus(
  open: ExhaustedRecord | undefined,
  fleet: FleetAvailability,
  now: number,
): { on: boolean; recovery?: Recovery } {
  if (open === undefined) return { on: fleet.exhausted };
  const tracked = trackOpenEpisode(openEpisodeFrom(open), fleet, now);
  const transition = decideExhaustion(tracked, fleet, now);
  return transition.kind === 'end' ? { on: false, recovery: transition.recovery } : { on: true };
}

// ---- deciding transitions ----------------------------------------------------------------------

/** How the first account came back, and since when. */
export interface Recovery {
  accountId: string;
  label: string;
  how: RecoveryHow;
  backSince: number;
  limit?: LimitInput['kind'];
}

/** What one poll cycle changes. */
export type ExhaustionTransition =
  { kind: 'none' } | { kind: 'start' } | { kind: 'end'; recovery: Recovery };

/**
 * Decide whether this cycle starts an episode, ends the open one, or changes nothing.
 *
 * Starting needs the shared rule to say no account can take work. Ending needs POSITIVE
 * evidence that one can, because the shared rule counts an account with no live numbers as
 * usable (unknown is not exhausted) and a poll that failed this cycle reports exactly that. An
 * episode ended on a failed poll would send a false "usage is back" card and, when the numbers
 * return next cycle, a second "out of usage" card for the same outage.
 */
export function decideExhaustion(
  open: OpenEpisode | undefined,
  fleet: FleetAvailability,
  now: number,
): ExhaustionTransition {
  if (open === undefined) return fleet.exhausted ? { kind: 'start' } : { kind: 'none' };
  let best: Recovery | undefined;
  for (const account of fleet.accounts) {
    const recovery = recoveryOf(open.accounts.get(account.accountId), account, now);
    if (recovery === undefined) continue;
    // The account back earliest names the end; ties break by label for a stable answer.
    if (
      best === undefined ||
      recovery.backSince < best.backSince ||
      (recovery.backSince === best.backSince && recovery.label < best.label)
    ) {
      best = recovery;
    }
  }
  return best === undefined ? { kind: 'none' } : { kind: 'end', recovery: best };
}

/**
 * Whether one account is back, judged against how the episode last saw it. Live numbers with
 * headroom are evidence; no numbers (never polled, or a poll that failed) are evidence only when
 * the clock alone proves that what kept the account out is gone.
 */
function recoveryOf(
  before: TrackedAccount | undefined,
  now: AccountAvailability,
  at: number,
): Recovery | undefined {
  if (!now.usable) return undefined;
  const who = { accountId: now.accountId, label: now.label };
  // An account this episode has never seen out (added during it): back only on numbers. A login
  // whose first poll fails has none, and may be just as spent as the rest.
  if (before === undefined) {
    return now.measured ? { ...who, how: 'new_account', backSince: at } : undefined;
  }
  const wall = wallResetOf(before, at);
  if (before.reason === 'quarantined') {
    // A restored login: its numbers show headroom, or the walls it also had have since reset.
    return now.measured || wall !== undefined
      ? { ...who, how: 'relogin', backSince: at }
      : undefined;
  }
  if (wall !== undefined) {
    // Dated to the reset, but never before the last reading that still showed it out: a reset
    // the endpoint moved later is not a return.
    return {
      ...who,
      how: 'reset',
      backSince: Math.max(wall.at, before.lastOutAt),
      limit: wall.kind,
    };
  }
  // Numbers with headroom before the walls' reported resets.
  return now.measured ? { ...who, how: 'headroom', backSince: at } : undefined;
}

/** When every limit the account was last seen out on has reset, and which reset came last;
 *  undefined while any is still ahead or was never known. */
function wallResetOf(
  before: TrackedAccount,
  now: number,
): { at: number; kind: LimitInput['kind'] } | undefined {
  if (before.spent.length === 0) return undefined;
  let last: { at: number; kind: LimitInput['kind'] } | undefined;
  for (const limit of before.spent) {
    if (limit.resetsAt === undefined || limit.resetsAt > now) return undefined;
    if (last === undefined || limit.resetsAt > last.at) {
      last = { at: limit.resetsAt, kind: limit.kind };
    }
  }
  return last;
}

// ---- building records ----------------------------------------------------------------------------

/** The `exhausted` entry for an exhausted fleet. */
export function exhaustedRecord(args: {
  fleet: FleetAvailability;
  now: number;
  active: string | null;
  switches: ExhaustionSwitch[];
}): ExhaustedRecord {
  const { fleet, now } = args;
  const accounts: ExhaustedAccount[] = fleet.accounts.map((a) => ({
    accountId: a.accountId,
    label: a.label,
    reason: reasonOf(a),
    ...(a.percent !== undefined ? { percent: a.percent } : {}),
    ...(a.backAt !== undefined ? { backAt: a.backAt } : {}),
    ...(a.backAtPredicted === true ? { backAtPredicted: true } : {}),
    spent: a.spent,
  }));
  return {
    v: 1,
    event: 'exhausted',
    id: `ep-${now}`,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      `No account can take work: ${fleet.accounts.map((a) => describeUnavailable(a, now)).join(', ')}. ` +
      describeFirstBack(fleet, now),
    active: args.active,
    accounts,
    ...(fleet.firstBack !== undefined ? { firstBack: fleet.firstBack } : {}),
    switches: args.switches,
  };
}

/** Why an account in an exhausted fleet is out. Every one of them is unavailable, so a reason is
 *  always there; a usable one here means the caller recorded a fleet that was not exhausted. */
function reasonOf(a: AccountAvailability): UnavailableReason {
  if (a.reason === undefined) {
    throw new Error(`exhausted entry built for a fleet where ${a.label} can still take work`);
  }
  return a.reason;
}

/** What brought an account back, in words. Shared with `cctl exhausted`, so the file's summary
 *  and the CLI never word the same recovery differently. */
export function recoveryText(recovery: Pick<Recovery, 'how' | 'limit'>): string {
  switch (recovery.how) {
    case 'reset':
      return recovery.limit !== undefined
        ? `its ${LIMIT_NOUN[recovery.limit]} reset`
        : 'its limits reset';
    case 'relogin':
      return 'its login was restored';
    case 'new_account':
      return 'a newly added account';
    case 'headroom':
      return 'it has usage left again';
  }
}

/** The `recovered` entry that closes `open`. */
export function recoveredRecord(
  open: ExhaustedRecord,
  recovery: Recovery,
  now: number,
): RecoveredRecord {
  // Never before the start: a clock stepped back between the two must not yield a negative
  // outage, and a zero-length one reads "<1m", not "for now".
  const backSince = Math.max(recovery.backSince, open.at);
  const durationMs = backSince - open.at;
  return {
    v: 1,
    event: 'recovered',
    id: open.id,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      `Usage is back: ${recovery.label} (${recoveryText(recovery)}). ` +
      `No account could take work for ${humanizeDuration(Math.max(durationMs, 1))}.`,
    backSince,
    durationMs,
    account: { accountId: recovery.accountId, label: recovery.label },
    how: recovery.how,
    ...(recovery.limit !== undefined ? { limit: recovery.limit } : {}),
  };
}

/** The phone card for the start of an episode: one account per line, then when it ends. */
export function exhaustedCardBody(fleet: FleetAvailability, record: ExhaustedRecord): string {
  const lines = fleet.accounts.map((a) => `• ${describeUnavailable(a, record.at)}`);
  const walk =
    record.switches.length > 0
      ? [
          `${record.switches.length} switch${record.switches.length === 1 ? '' : 'es'} in the last 5 hours; cctl exhausted lists them.`,
        ]
      : [];
  return ['No account can take work.', ...lines, describeFirstBack(fleet, record.at), ...walk].join(
    '\n',
  );
}
