// The CLI's two views of the exhaustion log (see the daemon's exhaustionLog.ts): the history
// `cctl outages` prints, and the one-line banner `cctl usage` and `cctl timeline` lead with
// while no account can take work. Pure renderers; program.ts does the reading and the judging.

import {
  describeFirstBack,
  describeWalls,
  humanizeDuration,
  type FleetAvailability,
} from '@claude-control/usage-advisor';
import {
  recoveryText,
  trackedBackAt,
  type ExhaustedAccount,
  type ExhaustionEpisode,
  type ExhaustionSwitch,
  type OpenEpisode,
  type Recovery,
} from '@claude-control/daemon';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The outage the log has open (the daemon's open episode), and, when the latest numbers already
 *  show an account back, how: the end a running daemon would record on its next cycle. */
export interface OpenOutage {
  id: string;
  overBy?: Recovery;
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
 *  last of them was due to reset. */
function accountLine(a: ExhaustedAccount, now: number): string {
  if (a.reason === 'quarantined') return 'login expired';
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

/** The heading line of one episode: when, how long, and how it ended. Only the log's open
 *  outage is "ongoing"; any other start without an end lost its end to a failed write. */
function episodeHeading(
  e: ExhaustionEpisode,
  now: number,
  open: OpenOutage | undefined,
  palette: Palette,
): string {
  const start = palette.bold(formatLocalTime(e.start.at, now));
  if (e.end !== undefined) {
    return (
      `${start} -> ${formatLocalTime(e.end.backSince, now)}  ${palette.bold(humanizeDuration(Math.max(e.end.durationMs, 1)))}` +
      `  back: ${e.end.account.label} (${recoveryText(e.end)})`
    );
  }
  if (e.start.id !== open?.id) return `${start} -> ${palette.dim('end not recorded')}`;
  if (open.overBy !== undefined) {
    // Over by the numbers, but nothing has closed it: no daemon is running, or it has not
    // polled since.
    return (
      `${start} -> ${palette.yellow('over by the latest numbers')}: ${open.overBy.label} back since ` +
      `${formatLocalTime(open.overBy.backSince, now)} (${recoveryText(open.overBy)}); ` +
      'no running daemon has recorded the end yet'
    );
  }
  const first = e.start.firstBack;
  const expected =
    first !== undefined
      ? `; first back expected: ${first.label} at ${formatLocalTime(first.at, now)}` +
        `${first.predicted ? ' (predicted)' : ''}`
      : '';
  return `${start} -> ${palette.red('ongoing')}, ${humanizeDuration(Math.max(now - e.start.at, 1))} so far${expected}`;
}

/** Which episodes a `--days` window shows: those that started inside it, plus the open outage
 *  however long ago it began. */
export function episodesInWindow(
  episodes: ExhaustionEpisode[],
  now: number,
  days: number | undefined,
  openId?: string,
): ExhaustionEpisode[] {
  if (days === undefined) return episodes;
  const since = now - days * 86_400_000;
  return episodes.filter((e) => e.start.at >= since || e.start.id === openId);
}

/** `cctl outages`: every episode, newest first, each with its accounts and the switches
 *  that led there, then where the log lives. */
export function renderExhaustionLog(
  episodes: ExhaustionEpisode[],
  options: { now: number; logPath: string; days?: number; open?: OpenOutage; palette?: Palette },
): string {
  const { now, logPath } = options;
  const palette = options.palette ?? PLAIN_PALETTE;
  const scope = options.days !== undefined ? ` in the last ${options.days} days` : '';
  const footer = palette.dim(`Log: ${logPath}`);
  if (episodes.length === 0) {
    return `No time on record${scope} when every account was out of usage.\n${footer}`;
  }
  const blocks = [...episodes].reverse().map((e) => {
    const width = Math.max(0, ...e.start.accounts.map((a) => a.label.length));
    const accounts = e.start.accounts.map(
      (a) => `  ${a.label.padEnd(width)}  ${accountLine(a, now)}`,
    );
    const walk =
      e.start.switches.length > 0
        ? [
            '  Switches in the 5 hours before:',
            ...e.start.switches.map((s) => switchLine(s, now, palette)),
          ]
        : ['  No switches in the 5 hours before.'];
    return [episodeHeading(e, now, options.open, palette), ...accounts, ...walk].join('\n');
  });
  const count = `${episodes.length} time${episodes.length === 1 ? '' : 's'}${scope} no account could take work (newest first):`;
  return [count, '', blocks.join('\n\n'), '', footer].join('\n');
}

/** The tracked account expected back soonest, by the walls the log last recorded for it. */
function expectedFirstBack(
  open: OpenEpisode,
  now: number,
): { label: string; at: number } | undefined {
  let first: { label: string; at: number } | undefined;
  for (const a of open.accounts.values()) {
    const at = trackedBackAt(a);
    if (at === undefined || at <= now) continue;
    if (first === undefined || at < first.at || (at === first.at && a.label < first.label)) {
      first = { label: a.label, at };
    }
  }
  return first;
}

/** The banner `cctl usage` and `cctl timeline` lead with while an outage is on (the caller has
 *  judged that, the daemon's way). Since when comes from the open episode in the log; when the
 *  first account is back comes from the numbers when they show every account out, else from what
 *  the log last recorded for each account (an account whose poll came back empty has no numbers
 *  to say). */
export function renderExhaustionBanner(
  fleet: FleetAvailability,
  open: OpenEpisode | undefined,
  now: number,
  palette: Palette = PLAIN_PALETTE,
): string {
  const start = open?.record;
  const since =
    start !== undefined
      ? ` since ${formatLocalTime(start.at, now)} (${humanizeDuration(Math.max(now - start.at, 1))})`
      : '';
  const expected = open !== undefined ? expectedFirstBack(open, now) : undefined;
  const firstBack = fleet.exhausted
    ? describeFirstBack(fleet, now)
    : expected !== undefined
      ? `First back expected: ${expected.label} at ${formatLocalTime(expected.at, now)}.`
      : '';
  return (
    palette.red(palette.bold(`No account can take work${since}.`)) +
    (firstBack !== '' ? ` ${firstBack}` : '') +
    ' cctl outages lists every time this happened.'
  );
}
