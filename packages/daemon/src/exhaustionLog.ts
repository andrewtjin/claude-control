// The exhaustion log: one line each time no account could take work, and one when usage came
// back. That is the fleet's worst failure (auto-switch walked every account and all of them are
// spent), so the owner wants every occurrence on record: when, for how long, why each account
// was out, and the switches that led there.
//
// The file IS the log, the only store: append-only JSON lines at
// `<dataDir>/exhaustion-log.jsonl`, each carrying a plain-English `summary` so the file reads on
// its own, rendered by `cctl exhausted`. The daemon reads it back on start to resume an episode
// that was open when it stopped, so a restart never announces the same outage twice.
//
// Deciding WHEN an episode starts and ends is pure (see {@link decideExhaustion}) and leans on
// the advisor's shared availability rule, so the log can never disagree with auto-switch about
// whether an account has usage left.

import { appendFile, mkdir, readFile } from 'node:fs/promises';
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

/** One switch in the walk that led to the episode, by account label as of that moment. */
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

/** Narrow one parsed line to a record this build understands. A line from a newer build
 *  (another `v`) or a torn write is skipped, never fatal: the rest of the log still reads. */
function isRecord(value: unknown): value is ExhaustionRecord {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.v !== 1 || typeof v.id !== 'string' || typeof v.at !== 'number') return false;
  if (v.event === 'exhausted') return Array.isArray(v.accounts) && Array.isArray(v.switches);
  if (v.event === 'recovered') {
    return typeof v.backSince === 'number' && typeof v.account === 'object' && v.account !== null;
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

  /** Append one record as one line. Creates the directory on first use. */
  async append(record: ExhaustionRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, JSON.stringify(record) + '\n', 'utf8');
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
  open: ExhaustedRecord | undefined,
  fleet: FleetAvailability,
  now: number,
): ExhaustionTransition {
  if (open === undefined) return fleet.exhausted ? { kind: 'start' } : { kind: 'none' };
  let best: Recovery | undefined;
  for (const account of fleet.accounts) {
    const before = open.accounts.find((a) => a.accountId === account.accountId);
    const recovery = recoveryOf(before, account, now);
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

/** Whether one account is back, judged against how it stood when the episode began. */
function recoveryOf(
  before: ExhaustedAccount | undefined,
  now: AccountAvailability,
  at: number,
): Recovery | undefined {
  if (!now.usable) return undefined;
  const who = { accountId: now.accountId, label: now.label };
  // An account added during the episode: a deliberate act, and a fresh login holds quota.
  if (before === undefined) return { ...who, how: 'new_account', backSince: at };
  const wall = wallResetOf(before, at);
  const wasLoggedOut = before.reason === 'quarantined';
  if (now.measured) {
    // Live numbers show headroom: back, for whichever reason explains it.
    if (wasLoggedOut) return { ...who, how: 'relogin', backSince: at };
    if (wall !== undefined) return { ...who, how: 'reset', backSince: wall.at, limit: wall.kind };
    return { ...who, how: 'headroom', backSince: at };
  }
  // No live numbers. Usable only because unknown is not exhausted, which is also what a failed
  // poll looks like, so it counts only when what kept the account out is provably gone.
  if (wasLoggedOut) {
    // The login is back; the quota was fine, or its walls have since reset.
    return before.spent.length === 0 || wall !== undefined
      ? { ...who, how: 'relogin', backSince: at }
      : undefined;
  }
  return wall !== undefined
    ? { ...who, how: 'reset', backSince: wall.at, limit: wall.kind }
    : undefined;
}

/** When every limit the account was out on has reset (by the resets recorded at the start), and
 *  which reset came last; undefined while any is still ahead or was never known. */
function wallResetOf(
  before: ExhaustedAccount,
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
  const durationMs = Math.max(0, recovery.backSince - open.at);
  return {
    v: 1,
    event: 'recovered',
    id: open.id,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      `Usage is back: ${recovery.label} (${recoveryText(recovery)}). ` +
      `No account could take work for ${humanizeDuration(durationMs)}.`,
    backSince: recovery.backSince,
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
