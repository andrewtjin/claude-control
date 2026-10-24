// The exhaustion log: one line each time no account could take work, and one when usage came
// back. That is the fleet's worst failure (auto-switch walked every account and all of them are
// spent), so every occurrence goes on record: when, for how long, why each account was out, and
// the switches that led there.
//
// The file IS the log, the only store: append-only JSON lines at
// `<dataDir>/exhaustion-log.jsonl`, each carrying a plain-English `summary` so the file reads on
// its own, rendered by `cctl outages`. The daemon reads it back on start to resume an episode
// that was open when it stopped, so a restart never announces the same outage twice.
//
// Deciding WHEN an episode starts and ends is pure (see {@link decideExhaustion}) and leans on
// the usage advisor's shared availability rule, so the log can never disagree with the plan or
// the post-switch session resume about whether an account has usage left.
//
// Every episode has a SCOPE: the global pool, or one folder rule's effective pool (see
// {@link outageScopes}). Each scope runs its own episodes side by side, and a scope is out when
// nothing in its pool can take work, where an account live in another slot does not count: one
// login is never live in two slots, so that slot cannot have it. The global scope follows the same
// rule, so an account held by a folder slot is not counted as the global pool's. A line without a
// scope is the global pool's, which is how every line written before scopes existed reads. Folder
// lines are written as `v: 2` so that a build predating scopes, which reads only `v: 1`, skips them
// rather than taking a folder's outage for the whole fleet's.

import { appendFile, mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  operatorRules,
  ruleIdOfSlot,
  ruleSlotId,
  slotMayHold,
  type AccountView,
  type FolderRule,
  type SlotId,
} from '@claude-control/switch-engine';
import {
  assessFleet,
  describeFirstBack,
  describeUnavailable,
  humanizeElapsed,
  LIMIT_NOUN,
  type AccountAvailability,
  type AccountUsageInput,
  type AutoSwitchPolicy,
  type FleetAvailability,
  type LimitInput,
  type UnavailableReason,
} from '@claude-control/usage-advisor';
import { folderNameOf, rulesPictureOf } from './folderSlots.js';

/** The log's file name inside the daemon's data directory. */
const EXHAUSTION_LOG_FILE = 'exhaustion-log.jsonl';

/** How far back the switch chain in an `exhausted` entry reaches: one 5-hour window, the
 *  span over which auto-switch could have walked every account's window. */
export const SWITCH_CHAIN_WINDOW_MS = 5 * 60 * 60_000;

/** {@link SWITCH_CHAIN_WINDOW_MS} in words, for the card and the CLI. */
export const SWITCH_CHAIN_WINDOW_WORDS = '5 hours';

/** Where the log lives for a given data directory. Shared by the daemon (writer) and the CLI
 *  (reader), so the two can never look in different places. */
export function exhaustionLogPath(dataDir: string): string {
  return join(dataDir, EXHAUSTION_LOG_FILE);
}

// ---- scopes -------------------------------------------------------------------------------------

/** Which pool an episode is about: the global pool, or one folder rule's effective pool. A folder
 *  scope records the rule's folders and label as they stood when the episode began, so the
 *  history still names it after the rule changes or is removed. A global scope marked `ruled`
 *  was judged while folder rules existed: the global pool was then not every account (a folder
 *  could still be working on its own), so it is worded as the global pool, never as all of them.
 *  The mark is wording only; it is the same scope either way. */
export type OutageScope =
  | { kind: 'global'; ruled?: true }
  | { kind: 'folder'; ruleId: string; folders: string[]; label: string };

/** The global pool's scope. */
export const GLOBAL_SCOPE: OutageScope = { kind: 'global' };

/** One string per scope, stable across a rule's edits: `global`, or `folder:<rule id>`. */
export function scopeKey(scope: OutageScope): string {
  return scope.kind === 'global' ? 'global' : folderScopeKey(scope.ruleId);
}

/** The {@link scopeKey} of a folder rule's scope. */
export function folderScopeKey(ruleId: string): string {
  return `folder:${ruleId}`;
}

/** A record's scope. A line without one is the global pool's: every line written before scopes
 *  existed reads that way. */
export function scopeOf(record: { scope?: OutageScope }): OutageScope {
  return record.scope ?? GLOBAL_SCOPE;
}

/** The scope in words: "the global pool", or the rule's folders (its label when it has none). */
export function describeScope(scope: OutageScope): string {
  return scope.kind === 'global' ? 'the global pool' : folderNameOf(scope);
}

/** Whether the scope's words name it: a folder always, the global pool only beside folder rules
 *  (see {@link OutageScope}). With no rules the global pool is every account, and says so. */
function namesScope(scope: OutageScope): boolean {
  return scope.kind === 'folder' || scope.ruled === true;
}

/** The `v` a record of this scope is written with (see the module header). */
function versionOf(scope: OutageScope): 1 | 2 {
  return scope.kind === 'global' ? 1 : 2;
}

/** One scope as one poll cycle sees it: the accounts in its effective pool, and those of them live
 *  in another slot, mapped to where in words (what {@link judgeOutage} takes). */
export interface ScopeView {
  scope: OutageScope;
  key: string;
  accountIds: string[];
  liveElsewhere: Map<string, string>;
}

/** A slot in words, as an account live in it is described: "the global slot", or "the slot of"
 *  its rule's folders. */
function slotWords(slot: SlotId, rules: readonly FolderRule[]): string {
  if (slot === 'global') return 'the global slot';
  const rule = rules.find((r) => r.id === ruleIdOfSlot(slot));
  return rule === undefined ? 'another slot' : `the slot of ${folderNameOf(rule)}`;
}

/** A rule's scope as it stands now. */
function folderScope(rule: FolderRule): OutageScope {
  return { kind: 'folder', ruleId: rule.id, folders: [...rule.folders], label: rule.label };
}

/**
 * Every scope this cycle: the global pool, then one per folder rule in rule order. Membership is
 * the engine's own `slotMayHold` (a rule's included accounts plus the shared accounts it does not
 * exclude; the shared accounts for the global pool), so the log can never count an account a slot
 * may not take, nor leave out one it may. Unlike the switching pool it keeps quarantined and
 * globally excluded accounts: a dead login is an account out (and named so), and an excluded one
 * still takes work when chosen by hand. An account live in a slot other than the scope's own is
 * listed in `liveElsewhere`.
 */
export function outageScopes(fleet: {
  accounts: readonly AccountView[];
  rules: readonly FolderRule[];
  liveSlots: ReadonlyMap<SlotId, string | null>;
}): ScopeView[] {
  const { accounts, rules, liveSlots } = fleet;
  const picture = rulesPictureOf(accounts, rules);
  const view = (slot: SlotId, scope: OutageScope, order: readonly string[]): ScopeView => {
    const members = accounts
      .filter((a) => slotMayHold(slot, a.id, picture))
      .map((a) => a.id)
      // The rule's own accounts first, in its order, as its pool lists them.
      .sort((a, b) => rank(order, a) - rank(order, b));
    const liveElsewhere = new Map<string, string>();
    for (const id of members) {
      for (const [other, live] of liveSlots) {
        if (other !== slot && live === id) {
          liveElsewhere.set(id, slotWords(other, rules));
          break;
        }
      }
    }
    return { scope, key: scopeKey(scope), accountIds: members, liveElsewhere };
  };
  // A parallel session is no scope: its slot running out is its terminal's own choice of account,
  // not "no account can take work".
  const scoped = operatorRules(rules);
  return [
    view('global', scoped.length > 0 ? { kind: 'global', ruled: true } : GLOBAL_SCOPE, []),
    ...scoped.map((r) => view(ruleSlotId(r.id), folderScope(r), r.include)),
  ];
}

/** Where an id sits in a preferred order; anything not in it after, in its existing order. */
function rank(order: readonly string[], id: string): number {
  const at = order.indexOf(id);
  return at === -1 ? order.length : at;
}

/** {@link judgeOutage} for one scope: its own accounts out of the cycle's inputs, judged with those
 *  live in other slots counted out. */
export function judgeScope(
  inputs: AccountUsageInput[],
  scope: ScopeView,
  open: OpenEpisode | undefined,
  now: number,
  policy: Pick<AutoSwitchPolicy, 'fableCapTriggers'>,
): OutageJudgement {
  const members = new Set(scope.accountIds);
  const judged = judgeOutage(
    inputs.filter((i) => members.has(i.accountId)),
    open,
    now,
    policy,
    scope.liveElsewhere,
  );
  // A pool with nothing in it (a folder that excludes every shared account, or whose last one
  // another folder reserved) cannot take work either, though the shared rule calls a fleet of no
  // accounts not exhausted. That rule stands for a machine with no accounts at all, which has no
  // pool to be out of; so an empty pool counts as out only while some account exists. It ends the
  // usual way, once an account that can work joins it.
  if (scope.accountIds.length === 0 && inputs.length > 0 && open === undefined) {
    return {
      ...judged,
      fleet: { ...judged.fleet, exhausted: true },
      transition: { kind: 'start' },
      on: true,
    };
  }
  return judged;
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
  /** For `live_elsewhere`: the slot it was live in, in words. */
  liveIn?: string;
}

/** A record's version: 1 for the global pool, 2 for a folder scope (see the module header). */
export type ExhaustionVersion = 1 | 2;

/** One switch in the walk that led to the episode, by each account's label when the entry was
 *  written (an account removed since shows its id). */
export interface ExhaustionSwitch {
  at: number;
  from: string | null;
  to: string;
  origin?: string;
  reason?: string;
}

/** Written when the last account of a scope runs out. */
export interface ExhaustedRecord {
  v: ExhaustionVersion;
  event: 'exhausted';
  /** Pairs this entry with its `recovered` entry. */
  id: string;
  /** The pool this episode is about; absent reads as the global pool. */
  scope?: OutageScope;
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

/** Every way an episode can end; the reader accepts exactly these. All but `rule_removed` are an
 *  account coming back: `released` is one another slot let go of. `rule_removed` ends a folder's
 *  episode because its rule is gone, so there is no pool left to be out. */
const RECOVERY_HOWS = [
  'reset',
  'headroom',
  'relogin',
  'new_account',
  'released',
  'rule_removed',
] as const;

/** How an episode ended: how the first account came back, or its rule being removed. */
export type RecoveryHow = (typeof RECOVERY_HOWS)[number];

/** Written when some account of the scope can take work again, or the scope's rule is gone. */
export interface RecoveredRecord {
  v: ExhaustionVersion;
  event: 'recovered';
  id: string;
  scope?: OutageScope;
  /** When the daemon saw it. */
  at: number;
  time: string;
  summary: string;
  /** When the account actually came back: the reset that brought it back when that is how,
   *  else `at`. A daemon that was stopped through the reset still measures the outage right. */
  backSince: number;
  /** `backSince` minus the episode's start. */
  durationMs: number;
  /** The account that came back; absent only when the episode ended with its rule removed. */
  account?: { accountId: string; label: string };
  how: RecoveryHow;
  /** For `reset`: the limit whose reset brought it back. */
  limit?: LimitInput['kind'];
}

/**
 * Written while an episode is open, when what keeps an account out changes materially: it hits a
 * new limit, its login dies, a reset it waits on moves by more than {@link WALL_MOVE_MS}, it is
 * taken by another slot, or it joins the episode (added mid-outage). A restarted daemon, and the
 * CLI, fold these into the start entry's accounts, so a return is judged against what was last
 * seen, not only against what was true at the start.
 */
export interface WallsRecord {
  v: ExhaustionVersion;
  event: 'walls';
  /** The open episode it belongs to. */
  id: string;
  scope?: OutageScope;
  at: number;
  time: string;
  accountId: string;
  label: string;
  reason: UnavailableReason;
  spent: LimitInput[];
  liveIn?: string;
}

export type ExhaustionRecord = ExhaustedRecord | RecoveredRecord | WallsRecord;

/** How far a reset must move before it is worth a `walls` line: the endpoint recomputes every
 *  reset per response with about a second of jitter, and a line per poll would bury the history. */
export const WALL_MOVE_MS = 5 * 60_000;

/** An episode as the CLI lists it: its start and, once over, its end. Its scope is the start's. */
export interface ExhaustionEpisode {
  start: ExhaustedRecord;
  end?: RecoveredRecord;
}

// ---- reading lines back -----------------------------------------------------------------------
//
// Every field the daemon or the CLI reads is checked before a line is accepted, down to each
// account and limit: a line from a newer build (another `v`), a torn write, or a hand edit that
// left a field out is skipped whole, never half-used. Half-used, it would throw on every poll
// cycle that judged the episode it describes, and stop `cctl outages` from printing anything.

// Taken from the exhaustive per-kind table, so a limit kind added there is read here too rather
// than dropping every line that carries it.
const LIMIT_KINDS = new Set<string>(Object.keys(LIMIT_NOUN));
const REASONS = new Set<string>([...LIMIT_KINDS, 'quarantined', 'live_elsewhere']);
const HOWS = new Set<string>(RECOVERY_HOWS);

/** The largest magnitude a `Date` can hold: a timestamp past it renders as "NaN". */
const MAX_TIME_MS = 8.64e15;

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isTime = (v: unknown): v is number => isNumber(v) && Math.abs(v) <= MAX_TIME_MS;
const isString = (v: unknown): v is string => typeof v === 'string';
const optional = (v: unknown, check: (v: unknown) => boolean): boolean =>
  v === undefined || check(v);

function isLimit(v: unknown): boolean {
  return (
    isObject(v) &&
    isString(v.kind) &&
    LIMIT_KINDS.has(v.kind) &&
    isNumber(v.percent) &&
    optional(v.resetsAt, isTime)
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
    optional(v.backAt, isTime) &&
    optional(v.liveIn, isString)
  );
}

function isSwitch(v: unknown): boolean {
  return (
    isObject(v) &&
    isTime(v.at) &&
    (v.from === null || isString(v.from)) &&
    isString(v.to) &&
    optional(v.origin, isString) &&
    optional(v.reason, isString)
  );
}

/** Whether a line's version and scope agree: `v: 1` is the global pool's (its scope absent or
 *  global), `v: 2` a folder's, with every field of the folder scope present. */
function hasScopeOfVersion(value: Record<string, unknown>): boolean {
  const scope = value.scope;
  if (value.v === 1) {
    return (
      scope === undefined ||
      (isObject(scope) && scope.kind === 'global' && optional(scope.ruled, (r) => r === true))
    );
  }
  return (
    value.v === 2 &&
    isObject(scope) &&
    scope.kind === 'folder' &&
    isString(scope.ruleId) &&
    Array.isArray(scope.folders) &&
    scope.folders.every(isString) &&
    isString(scope.label)
  );
}

/** Narrow one parsed line to a record this build understands (see above). */
function isRecord(value: unknown): value is ExhaustionRecord {
  if (!isObject(value) || !hasScopeOfVersion(value) || !isString(value.id) || !isTime(value.at)) {
    return false;
  }
  if (value.event === 'exhausted') {
    return (
      Array.isArray(value.accounts) &&
      value.accounts.every(isExhaustedAccount) &&
      Array.isArray(value.switches) &&
      value.switches.every(isSwitch) &&
      (value.active === null || isString(value.active)) &&
      optional(value.firstBack, (f) => isObject(f) && isString(f.label) && isTime(f.at))
    );
  }
  if (value.event === 'walls') {
    return isExhaustedAccount(value);
  }
  if (value.event === 'recovered') {
    const account = value.account;
    // Only a removed rule ends an episode with no account back.
    const accountOk =
      value.how === 'rule_removed'
        ? account === undefined
        : isObject(account) && isString(account.accountId) && isString(account.label);
    return (
      accountOk &&
      isTime(value.backSince) &&
      isNumber(value.durationMs) &&
      isString(value.how) &&
      HOWS.has(value.how) &&
      optional(value.limit, (l) => isString(l) && LIMIT_KINDS.has(l))
    );
  }
  return false;
}

/** The key that pairs a start with its end and its `walls` lines: the scope, then the id. Two
 *  scopes can never share an episode, whatever their ids. */
function episodeKey(record: ExhaustionRecord): string {
  return `${scopeKey(scopeOf(record))} ${record.id}`;
}

/** Pair starts with their ends, oldest first, across every scope (each episode's scope is its
 *  start's). An end with no start (a hand-edited file) is dropped; a start with no end is the
 *  episode still open. `walls` lines are tracking, not history, and are left to
 *  {@link resumeOpenEpisode}. A start written twice (a write retried after it had in fact landed)
 *  is one episode. */
export function episodesOf(records: ExhaustionRecord[]): ExhaustionEpisode[] {
  const episodes: ExhaustionEpisode[] = [];
  const byKey = new Map<string, ExhaustionEpisode>();
  for (const r of records) {
    if (r.event === 'exhausted') {
      if (byKey.has(episodeKey(r))) continue;
      const episode: ExhaustionEpisode = { start: r };
      episodes.push(episode);
      byKey.set(episodeKey(r), episode);
    } else if (r.event === 'recovered') {
      const episode = byKey.get(episodeKey(r));
      if (episode !== undefined && episode.end === undefined) episode.end = r;
    }
  }
  return episodes;
}

/** A scope's episode still open: its LAST start, when that has no end. An older start left
 *  without an end (a crash between two writes) is history, not a second open episode. */
export function openEpisodeOf(
  records: ExhaustionRecord[],
  scope: OutageScope = GLOBAL_SCOPE,
): ExhaustedRecord | undefined {
  const key = scopeKey(scope);
  const last = episodesOf(records)
    .filter((e) => scopeKey(scopeOf(e.start)) === key)
    .at(-1);
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
      if (isNoSuchFile(err)) return [];
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

/** Whether an error says no file exists at the path: ENOENT, or ENOTDIR when a parent in the path
 *  is a file, which Linux reports where Windows says ENOENT. Either way there is no log to read,
 *  which is not the same as one that cannot be read right now. */
function isNoSuchFile(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Whether a file's last byte is something other than a newline. A missing or empty file ends
 *  on a line boundary. Reads one byte, however long the log grows. */
async function endsMidLine(path: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (err) {
    if (isNoSuchFile(err)) return false;
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
  /** What the log file holds for it (the start entry or its last `walls` line), or `undefined`
   *  when the file has nothing yet: what a change is measured against before it is written. */
  filed?: { reason: UnavailableReason; spent: LimitInput[] };
  /** For `live_elsewhere`: the slot it is live in, in words. Not a material change on its own: an
   *  account moving between two other slots is still not this scope's. */
  liveIn?: string;
}

/**
 * An open episode: the start entry as the file holds it, plus every account's latest known
 * state. It is what a return is judged against, so a wall an account hits mid-outage, or a reset
 * the endpoint moves later, cannot be mistaken for the account coming back once the reset
 * recorded at the start has passed. The tracking lives in memory; its material changes are filed
 * as `walls` lines (see {@link fileWallChanges}), which is what a restart rebuilds it from.
 */
export interface OpenEpisode {
  record: ExhaustedRecord;
  accounts: ReadonlyMap<string, TrackedAccount>;
}

/** The open episode as its start entry describes it, with any `walls` lines filed since folded
 *  in, oldest first. */
export function openEpisodeFrom(record: ExhaustedRecord, walls: WallsRecord[] = []): OpenEpisode {
  const accounts = new Map<string, TrackedAccount>(
    record.accounts.map((a) => [
      a.accountId,
      {
        label: a.label,
        reason: a.reason,
        spent: a.spent,
        lastOutAt: record.at,
        filed: { reason: a.reason, spent: a.spent },
        ...(a.liveIn !== undefined ? { liveIn: a.liveIn } : {}),
      },
    ]),
  );
  const key = episodeKey(record);
  for (const w of walls) {
    if (episodeKey(w) !== key) continue;
    accounts.set(w.accountId, {
      label: w.label,
      reason: w.reason,
      spent: w.spent,
      lastOutAt: Math.max(w.at, accounts.get(w.accountId)?.lastOutAt ?? w.at),
      filed: { reason: w.reason, spent: w.spent },
      ...(w.liveIn !== undefined ? { liveIn: w.liveIn } : {}),
    });
  }
  return { record, accounts };
}

/** A scope's open episode as the log holds it: its last start without an end, and its `walls`
 *  lines. What a restarted daemon resumes, and what the CLI judges an outage by. */
export function resumeOpenEpisode(
  records: ExhaustionRecord[],
  scope: OutageScope = GLOBAL_SCOPE,
): OpenEpisode | undefined {
  const open = openEpisodeOf(records, scope);
  if (open === undefined) return undefined;
  const key = episodeKey(open);
  const walls = records.filter(
    (r): r is WallsRecord => r.event === 'walls' && episodeKey(r) === key,
  );
  return openEpisodeFrom(open, walls);
}

/** Every scope's open episode, keyed by {@link scopeKey}: what a restarted daemon resumes, and
 *  what the CLI judges each scope's outage by. A scope whose rule has since been removed is
 *  still here; ending it is the daemon's job. */
export function resumeOpenEpisodes(records: ExhaustionRecord[]): Map<string, OpenEpisode> {
  const scopes = new Map<string, OutageScope>();
  for (const r of records) {
    if (r.event === 'exhausted') scopes.set(scopeKey(scopeOf(r)), scopeOf(r));
  }
  const open = new Map<string, OpenEpisode>();
  for (const [key, scope] of scopes) {
    const episode = resumeOpenEpisode(records, scope);
    if (episode !== undefined) open.set(key, episode);
  }
  return open;
}

/** Whether two sets of walls differ in a way that changes a return: a limit added or gone, or a
 *  reset moved by more than {@link WALL_MOVE_MS} (or becoming known or unknown). A percent that
 *  moves at the wall changes nothing. Compared as sorted lists, not by looking each kind up: one
 *  reading can carry two limits of the same kind (an Opus and a Fable weekly cap both normalize
 *  to `weekly_scoped`), and a lookup would pair them crosswise and see a change every cycle. */
function wallsDiffer(a: LimitInput[], b: LimitInput[]): boolean {
  if (a.length !== b.length) return true;
  const order = (l: LimitInput) =>
    `${l.kind}:${String(l.resetsAt ?? Number.MAX_SAFE_INTEGER).padStart(16, '0')}`;
  const sortedA = [...a].sort((x, y) => order(x).localeCompare(order(y)));
  const sortedB = [...b].sort((x, y) => order(x).localeCompare(order(y)));
  return sortedA.some((limit, i) => {
    const other = sortedB[i] as LimitInput;
    if (other.kind !== limit.kind) return true;
    if ((limit.resetsAt === undefined) !== (other.resetsAt === undefined)) return true;
    return (
      limit.resetsAt !== undefined &&
      other.resetsAt !== undefined &&
      Math.abs(limit.resetsAt - other.resetsAt) > WALL_MOVE_MS
    );
  });
}

/** When an account tracked by an open episode is expected back: the last reset among the walls
 *  it was last seen out on, or `undefined` when one of them has no known reset, or it is out on a
 *  dead login with nothing else to wait for. */
export function trackedBackAt(account: TrackedAccount): number | undefined {
  if (account.spent.length === 0) return undefined;
  let backAt = Number.NEGATIVE_INFINITY;
  for (const limit of account.spent) {
    if (limit.resetsAt === undefined) return undefined;
    backAt = Math.max(backAt, limit.resetsAt);
  }
  return backAt;
}

/**
 * The `walls` lines this cycle's tracking calls for: one per account whose reason or walls
 * changed materially since the file last described it, or that the file has never described.
 * Returns the episode with those accounts marked as filed, so the same change is not written
 * twice.
 */
export function fileWallChanges(
  open: OpenEpisode,
  now: number,
): { open: OpenEpisode; records: WallsRecord[] } {
  const records: WallsRecord[] = [];
  const accounts = new Map(open.accounts);
  for (const [accountId, a] of open.accounts) {
    const filed = a.filed;
    if (filed !== undefined && filed.reason === a.reason && !wallsDiffer(filed.spent, a.spent)) {
      continue;
    }
    const scope = scopeOf(open.record);
    records.push({
      v: versionOf(scope),
      event: 'walls',
      id: open.record.id,
      scope,
      at: now,
      time: new Date(now).toISOString(),
      accountId,
      label: a.label,
      reason: a.reason,
      spent: a.spent,
      ...(a.liveIn !== undefined ? { liveIn: a.liveIn } : {}),
    });
    accounts.set(accountId, { ...a, filed: { reason: a.reason, spent: a.spent } });
  }
  return { open: { record: open.record, accounts }, records };
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
      ...(before?.filed !== undefined ? { filed: before.filed } : {}),
      ...(a.liveIn !== undefined ? { liveIn: a.liveIn } : {}),
    });
  }
  return { record: open.record, accounts };
}

/** One cycle's verdict on the outage. */
export interface OutageJudgement {
  /** The fleet as this reading stands now. */
  fleet: FleetAvailability;
  /** The open episode with this reading folded in (see {@link trackOpenEpisode}); `undefined`
   *  when none was open. */
  open: OpenEpisode | undefined;
  transition: ExhaustionTransition;
  /** Whether an outage is on once the transition is applied. */
  on: boolean;
}

/**
 * Judge the outage from the log's open episode and one reading: whether one starts, the open
 * one ends, or nothing changes. The daemon acts on it every poll cycle; the CLI judges the same
 * way from the file and the latest numbers, so the banner and `cctl outages` can never disagree
 * with what the daemon would record. Whether the Fable cap counts comes from `policy`, exactly
 * as for auto-switch.
 *
 * Resets are the endpoint's times, compared against this machine's clock. A clock stepped ahead
 * across a reset therefore ends an outage early, and a step back can then start a second one.
 * No margin is held against that: the poller re-polls an account only every few minutes, so any
 * margin would delay every real "usage is back" by up to its length, to guard against a step
 * that has to land within minutes of a reset to matter.
 *
 * `liveElsewhere` names the accounts live in a slot other than the judged scope's, which that
 * scope cannot take (see {@link judgeScope}); absent, every account counts as free.
 */
export function judgeOutage(
  inputs: AccountUsageInput[],
  open: OpenEpisode | undefined,
  now: number,
  policy: Pick<AutoSwitchPolicy, 'fableCapTriggers'>,
  liveElsewhere?: ReadonlyMap<string, string>,
): OutageJudgement {
  const fleet = assessFleet(
    inputs,
    now,
    liveElsewhere === undefined ? policy : { ...policy, liveElsewhere },
  );
  if (open === undefined) {
    const transition = decideExhaustion(undefined, fleet, now);
    return { fleet, open, transition, on: transition.kind === 'start' };
  }
  // This reading refreshes what the episode knows about every account still out before judging
  // whether any is back.
  const tracked = trackOpenEpisode(open, fleet, now);
  const transition = decideExhaustion(tracked, fleet, now);
  return { fleet, open: tracked, transition, on: transition.kind !== 'end' };
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
 * Decide whether this cycle starts an episode, ends the open one, or changes nothing (the pure
 * core of {@link judgeOutage}).
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
  // Let go by the slot that held it. Being free is certain (the slots say so), but whether it can
  // take work needs numbers, as for an added account: a poll that failed reads as usable too.
  if (before.reason === 'live_elsewhere') {
    return now.measured ? { ...who, how: 'released', backSince: at } : undefined;
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

/** When every limit the account was last seen out on has reset by `now`, and which reset came
 *  last; undefined while any is still ahead or was never known. */
function wallResetOf(
  before: TrackedAccount,
  now: number,
): { at: number; kind: LimitInput['kind'] } | undefined {
  const at = trackedBackAt(before);
  if (at === undefined || at > now) return undefined;
  // trackedBackAt is the latest reset among the walls, so one of them carries it.
  const last = before.spent.find((l) => l.resetsAt === at) as LimitInput;
  return { at, kind: last.kind };
}

// ---- building records ----------------------------------------------------------------------------

/** "No account can take work" for the global pool with no folder rules; "No account in the global
 *  pool can take work" beside them; "No account in <folder>'s pool can take work" for a folder; so
 *  no card, line or banner reads as the whole fleet's unless it is. Shared with the CLI banner. */
export function noAccountSentence(scope: OutageScope): string {
  if (scope.kind === 'folder') return `No account in ${describeScope(scope)}'s pool can take work`;
  return scope.ruled === true
    ? 'No account in the global pool can take work'
    : 'No account can take work';
}

/** When the first account is expected back, or for a pool with nothing in it, that it is empty:
 *  the shared sentence would read an empty list as every login having expired. Shared with the
 *  CLI banner. */
export function firstBackSentence(fleet: FleetAvailability, now: number): string {
  return fleet.accounts.length === 0
    ? 'Its pool is empty: every account it could use is excluded by its rule or reserved to ' +
        'other folders.'
    : describeFirstBack(fleet, now);
}

/** The `exhausted` entry for an exhausted fleet, of the global pool unless `scope` says else. */
export function exhaustedRecord(args: {
  fleet: FleetAvailability;
  now: number;
  active: string | null;
  switches: ExhaustionSwitch[];
  scope?: OutageScope;
}): ExhaustedRecord {
  const { fleet, now } = args;
  const scope = args.scope ?? GLOBAL_SCOPE;
  const accounts: ExhaustedAccount[] = fleet.accounts.map((a) => ({
    accountId: a.accountId,
    label: a.label,
    reason: reasonOf(a),
    ...(a.percent !== undefined ? { percent: a.percent } : {}),
    ...(a.backAt !== undefined ? { backAt: a.backAt } : {}),
    ...(a.backAtPredicted === true ? { backAtPredicted: true } : {}),
    spent: a.spent,
    ...(a.liveIn !== undefined ? { liveIn: a.liveIn } : {}),
  }));
  return {
    v: versionOf(scope),
    event: 'exhausted',
    // The rule id keeps two scopes that run out in the same cycle apart in the file, too.
    id: scope.kind === 'global' ? `ep-${now}` : `ep-${now}-${scope.ruleId}`,
    scope,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      fleet.accounts.length === 0
        ? `${noAccountSentence(scope)}. ${firstBackSentence(fleet, now)}`
        : `${noAccountSentence(scope)}: ${fleet.accounts.map((a) => describeUnavailable(a, now)).join(', ')}. ` +
          firstBackSentence(fleet, now),
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

/** How an episode ended, in words. Shared with `cctl outages`, so the file's summary and the CLI
 *  never word the same end differently. */
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
    case 'released':
      return 'another slot let it go';
    case 'rule_removed':
      return 'its folder rule was removed';
  }
}

/** The `recovered` entry that closes `open`. */
export function recoveredRecord(
  open: ExhaustedRecord,
  recovery: Recovery,
  now: number,
): RecoveredRecord {
  // Never before the start: a clock stepped back between the two must not yield a negative
  // outage.
  const backSince = Math.max(recovery.backSince, open.at);
  const durationMs = backSince - open.at;
  const scope = scopeOf(open);
  const where = namesScope(scope) ? ` in ${describeScope(scope)}` : '';
  const could = namesScope(scope) ? 'No account in its pool could' : 'No account could';
  return {
    v: versionOf(scope),
    event: 'recovered',
    id: open.id,
    scope,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      `Usage is back${where}: ${recovery.label} (${recoveryText(recovery)}). ` +
      `${could} take work for ${humanizeElapsed(durationMs)}.`,
    backSince,
    durationMs,
    account: { accountId: recovery.accountId, label: recovery.label },
    how: recovery.how,
    ...(recovery.limit !== undefined ? { limit: recovery.limit } : {}),
  };
}

/** The entry that closes a folder's open episode because its rule is gone: with no rule there is
 *  no pool left to be out, and leaving it open would keep it "ongoing" in the history for good.
 *  Dated to when the daemon noticed. */
export function ruleRemovedRecord(open: ExhaustedRecord, now: number): RecoveredRecord {
  const backSince = Math.max(now, open.at);
  const durationMs = backSince - open.at;
  const scope = scopeOf(open);
  return {
    v: versionOf(scope),
    event: 'recovered',
    id: open.id,
    scope,
    at: now,
    time: new Date(now).toISOString(),
    summary:
      `The folder rule for ${describeScope(scope)} was removed, which ends its outage. ` +
      `No account in its pool could take work for ${humanizeElapsed(durationMs)}.`,
    backSince,
    durationMs,
    how: 'rule_removed',
  };
}

/** The phone card's title for the start of an episode. */
export function exhaustedCardTitle(scope: OutageScope): string {
  if (scope.kind === 'folder') return `${describeScope(scope)}: every account in its pool is out`;
  return scope.ruled === true
    ? 'Every account in the global pool is out'
    : 'All accounts are out of usage';
}

/** The phone card's title for the end of an episode. */
export function recoveredCardTitle(record: RecoveredRecord): string {
  const scope = scopeOf(record);
  if (record.how === 'rule_removed') return `${describeScope(scope)}: folder rule removed`;
  return namesScope(scope) ? `Usage is back in ${describeScope(scope)}` : 'Usage is back';
}

/** The phone card for the start of an episode: one account per line, then when it ends. */
export function exhaustedCardBody(fleet: FleetAvailability, record: ExhaustedRecord): string {
  const lines = fleet.accounts.map((a) => `• ${describeUnavailable(a, record.at)}`);
  const walk =
    record.switches.length > 0
      ? [
          `${record.switches.length} switch${record.switches.length === 1 ? '' : 'es'} in the last ${SWITCH_CHAIN_WINDOW_WORDS}; cctl outages lists them.`,
        ]
      : [];
  return [
    `${noAccountSentence(scopeOf(record))}.`,
    ...lines,
    firstBackSentence(fleet, record.at),
    ...walk,
  ].join('\n');
}
