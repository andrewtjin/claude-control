// The CLI's two views of the exhaustion log (see the daemon's exhaustionLog.ts): the history
// `cctl outages` prints, and the banner `cctl usage` and `cctl timeline` lead with while some pool
// has no account that can take work. Every episode has a scope (the global pool, or one folder
// rule's pool), and both views say which. Pure renderers; program.ts does the reading and the
// judging.

import { resolveBinding } from '@claude-control/switch-engine';
import {
  describeWalls,
  humanizeElapsed,
  type FleetAvailability,
} from '@claude-control/usage-advisor';
import {
  describeScope,
  firstBackSentence,
  GLOBAL_SCOPE,
  noAccountSentence,
  recoveryText,
  scopeKey,
  scopeOf,
  SWITCH_CHAIN_WINDOW_WORDS,
  trackedBackAt,
  type ExhaustedAccount,
  type ExhaustionEpisode,
  type ExhaustionSwitch,
  type OpenEpisode,
  type OutageScope,
  type Recovery,
} from '@claude-control/daemon';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** An account expected back, and when. */
export interface ExpectedBack {
  label: string;
  at: number;
}

/** Where one scope's open outage (the daemon's open episode of that scope) stands by the latest
 *  numbers: over, and how (the end a running daemon would record on its next cycle), or the
 *  account expected back first. `ruleRemoved` says a folder's rule is gone, which a running daemon
 *  records as the end on its next cycle. */
export interface OutageStatus {
  id: string;
  scope: OutageScope;
  overBy?: Recovery;
  expected?: ExpectedBack;
  ruleRemoved?: boolean;
}

/** A moment in this machine's local time, "Oct 1 14:02" — with the year when it is not this
 *  year's. Absolute, unlike the countdowns the live views print, because a history entry is read
 *  long after the moment it describes. */
export function formatLocalTime(ms: number, now: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One account as it stood when the episode began: every limit holding it out, and when the
 *  last of them was due to reset — or the login that died, or the slot that held it. */
function accountLine(a: ExhaustedAccount, now: number): string {
  if (a.reason === 'quarantined') return 'login expired';
  if (a.reason === 'live_elsewhere') return `live in ${a.liveIn ?? 'another slot'}`;
  const back =
    a.backAt === undefined
      ? 'reset time unknown'
      : `back ${formatLocalTime(a.backAt, now)}${a.backAtPredicted === true ? ' (predicted)' : ''}`;
  return `${describeWalls(a.spent)}, ${back}`;
}

/** One switch in the walk that led there: "11:40  work1 -> work2  auto: work1 at 95% of ...". */
function switchLine(s: ExhaustionSwitch, now: number, palette: Palette): string {
  const why = [s.origin, s.reason].filter((p) => p !== undefined && p !== '').join(': ');
  return (
    `    ${formatLocalTime(s.at, now)}  ${s.from ?? '(none)'} -> ${s.to}` +
    (why !== '' ? `  ${palette.dim(why)}` : '')
  );
}

/** The status of an episode's own scope, when that scope's open outage is this episode. */
function statusOf(e: ExhaustionEpisode, open: readonly OutageStatus[]): OutageStatus | undefined {
  const key = scopeKey(scopeOf(e.start));
  return open.find((o) => o.id === e.start.id && scopeKey(o.scope) === key);
}

/** The heading line of one episode: when, how long, and how it ended. Only a scope's open
 *  outage is "ongoing"; any other start without an end lost its end to a failed write. */
function episodeHeading(
  e: ExhaustionEpisode,
  now: number,
  open: readonly OutageStatus[],
  palette: Palette,
): string {
  const start = palette.bold(formatLocalTime(e.start.at, now));
  if (e.end !== undefined) {
    const span = `${start} -> ${formatLocalTime(e.end.backSince, now)}  ${palette.bold(humanizeElapsed(e.end.durationMs))}`;
    // Only a removed rule ends an episode with no account back.
    return e.end.account === undefined
      ? `${span}  ended: ${recoveryText(e.end)}`
      : `${span}  back: ${e.end.account.label} (${recoveryText(e.end)})`;
  }
  const status = statusOf(e, open);
  if (status === undefined) return `${start} -> ${palette.dim('end not recorded')}`;
  if (status.ruleRemoved === true) {
    return (
      `${start} -> ${palette.yellow('its folder rule was removed')}; ` +
      'no running daemon has recorded the end yet'
    );
  }
  if (status.overBy !== undefined) {
    // Over by the numbers, but nothing has closed it: no daemon is running, or it has not
    // polled since.
    return (
      `${start} -> ${palette.yellow('over by the latest numbers')}: ${status.overBy.label} back since ` +
      `${formatLocalTime(status.overBy.backSince, now)} (${recoveryText(status.overBy)}); ` +
      'no running daemon has recorded the end yet'
    );
  }
  // By the walls last seen, as the banner says it: the start entry's own guess may have passed.
  const first = status.expected;
  const expected =
    first !== undefined
      ? `; first back expected: ${first.label} at ${formatLocalTime(first.at, now)}`
      : '';
  return `${start} -> ${palette.red('ongoing')}, ${humanizeElapsed(now - e.start.at)} so far${expected}`;
}

/** Which episodes a `--days` window shows: those that started inside it, plus every scope's open
 *  outage however long ago it began. */
export function episodesInWindow(
  episodes: ExhaustionEpisode[],
  now: number,
  days: number | undefined,
  open: readonly OutageStatus[] = [],
): ExhaustionEpisode[] {
  if (days === undefined) return episodes;
  const since = now - days * 86_400_000;
  return episodes.filter((e) => e.start.at >= since || statusOf(e, open) !== undefined);
}

/**
 * Which episodes `--folder` shows: those of the pool `folder` runs under now, resolved the way the
 * engine resolves a folder (the longest rule folder containing it wins, with no merging) against
 * `rules`, the rules in force. A rule keeps its id across edits, so every episode of that rule is
 * shown, whatever folders it had then; a rule made anew on the same folder (after a reset) is a new
 * pool, and only its own history is. A folder no rule applies to runs under the global pool, so
 * the global pool's episodes are shown, with those of any removed rule that covered it, the pool it
 * ran under before. Without `rules` (the registry could not be read) the folder is resolved
 * against the folders the log records, the best that history alone can say. `folder` must be
 * canonical.
 */
export function episodesForFolder(
  episodes: ExhaustionEpisode[],
  folder: string,
  platform: NodeJS.Platform,
  rules?: ReadonlyArray<{ id: string; folders: readonly string[] }>,
): ExhaustionEpisode[] {
  const ruleIdOf = (e: ExhaustionEpisode): string | undefined => {
    const scope = scopeOf(e.start);
    return scope.kind === 'folder' ? scope.ruleId : undefined;
  };
  const logged = new Map<string, Set<string>>();
  for (const e of episodes) {
    const scope = scopeOf(e.start);
    if (scope.kind !== 'folder') continue;
    const known = logged.get(scope.ruleId) ?? new Set<string>();
    for (const f of scope.folders) known.add(f);
    logged.set(scope.ruleId, known);
  }
  /** The rule among those the log records (less `skip`) that `folder` resolves to. */
  const fromHistory = (skip: ReadonlySet<string>): string | undefined =>
    resolveBinding(
      folder,
      [...logged].filter(([id]) => !skip.has(id)).map(([id, set]) => ({ id, folders: [...set] })),
      platform,
    )?.groupId;

  if (rules === undefined) {
    const id = fromHistory(new Set());
    return id === undefined ? [] : episodes.filter((e) => ruleIdOf(e) === id);
  }
  const current = resolveBinding(
    folder,
    rules.map((r) => ({ id: r.id, folders: [...r.folders] })),
    platform,
  );
  if (current !== null) return episodes.filter((e) => ruleIdOf(e) === current.groupId);
  const removed = fromHistory(new Set(rules.map((r) => r.id)));
  return episodes.filter((e) => {
    const id = ruleIdOf(e);
    return id === undefined || id === removed;
  });
}

/** `cctl outages`: every episode, newest first, each with its accounts and the switches that led
 *  there, then where the log lives. Each heading leads with its scope once any episode is a
 *  folder's or was judged beside folder rules, so a log with no folder rules reads exactly as it
 *  always did. */
export function renderOutages(
  episodes: ExhaustionEpisode[],
  options: {
    now: number;
    logPath: string;
    days?: number;
    open?: readonly OutageStatus[];
    /** The `--folder` the list was narrowed to, for the line saying there is nothing. */
    folder?: string;
    palette?: Palette;
  },
): string {
  const { now, logPath, days } = options;
  const palette = options.palette ?? PLAIN_PALETTE;
  const open = options.open ?? [];
  const window = days !== undefined ? ` in the last ${days} day${days === 1 ? '' : 's'}` : '';
  const footer = palette.dim(`Log: ${logPath}`);
  if (episodes.length === 0) {
    const whose = options.folder !== undefined ? `account in ${options.folder}'s pool` : 'account';
    return `No time on record${window} when every ${whose} was out of usage.\n${footer}`;
  }
  const scoped = episodes.some((e) => {
    const scope = scopeOf(e.start);
    return scope.kind === 'folder' || scope.ruled === true;
  });
  const blocks = [...episodes].reverse().map((e) => {
    const width = Math.max(0, ...e.start.accounts.map((a) => a.label.length));
    const accounts = e.start.accounts.map(
      (a) => `  ${a.label.padEnd(width)}  ${accountLine(a, now)}`,
    );
    const walk =
      e.start.switches.length > 0
        ? [
            `  Switches in the ${SWITCH_CHAIN_WINDOW_WORDS} before:`,
            ...e.start.switches.map((s) => switchLine(s, now, palette)),
          ]
        : [`  No switches in the ${SWITCH_CHAIN_WINDOW_WORDS} before.`];
    const tag = scoped ? `${palette.bold(`[${scopeTag(scopeOf(e.start))}]`)} ` : '';
    return [tag + episodeHeading(e, now, open, palette), ...accounts, ...walk].join('\n');
  });
  const who = scoped ? 'a pool had no account that' : 'no account';
  const count = `${episodes.length} time${episodes.length === 1 ? '' : 's'}${window} ${who} could take work (newest first):`;
  return [count, '', blocks.join('\n\n'), '', footer].join('\n');
}

/** A scope as the history tags it: "global", or the folder(s). */
function scopeTag(scope: OutageScope): string {
  return scope.kind === 'global' ? 'global' : describeScope(scope);
}

/** The tracked account expected back soonest, by the walls last seen for it, among those still
 *  ahead. With `fleet`, only accounts that still exist count: one removed since the outage began
 *  coming back changes nothing. */
export function expectedFirstBack(
  open: OpenEpisode,
  now: number,
  fleet?: FleetAvailability,
): ExpectedBack | undefined {
  let first: ExpectedBack | undefined;
  for (const [accountId, a] of open.accounts) {
    if (fleet !== undefined && !fleet.accounts.some((f) => f.accountId === accountId)) continue;
    const at = trackedBackAt(a);
    if (at === undefined || at <= now) continue;
    if (first === undefined || at < first.at || (at === first.at && a.label < first.label)) {
      first = { label: a.label, at };
    }
  }
  return first;
}

/** One line of the banner `cctl usage` and `cctl timeline` lead with while a scope's outage is on
 *  (the caller has judged that, the daemon's way): the global pool's, or a folder's, named. Since
 *  when comes from the scope's open episode in the log; when the first account is back comes from
 *  the numbers when they show every account out, else from what the log last recorded for each
 *  account (an account whose poll came back empty has no numbers to say). */
export function renderOutageBanner(
  fleet: FleetAvailability,
  open: OpenEpisode | undefined,
  now: number,
  palette: Palette = PLAIN_PALETTE,
  scope: OutageScope = GLOBAL_SCOPE,
): string {
  const start = open?.record;
  const since =
    start !== undefined
      ? ` since ${formatLocalTime(start.at, now)} (${humanizeElapsed(now - start.at)})`
      : '';
  const expected = open !== undefined ? expectedFirstBack(open, now, fleet) : undefined;
  const firstBack = fleet.exhausted
    ? firstBackSentence(fleet, now)
    : expected !== undefined
      ? `First back expected: ${expected.label} at ${formatLocalTime(expected.at, now)}.`
      : '';
  const headline = noAccountSentence(scope);
  return (
    palette.red(palette.bold(`${headline}${since}.`)) +
    (firstBack !== '' ? ` ${firstBack}` : '') +
    ' cctl outages lists every time this happened.'
  );
}
