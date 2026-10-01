// The CLI's two views of the exhaustion log (see the daemon's exhaustionLog.ts): the history
// `cctl exhausted` prints, and the one-line banner `cctl usage` and `cctl timeline` lead with
// while no account can take work. Pure renderers; program.ts does the reading.

import {
  describeFirstBack,
  humanizeDuration,
  LIMIT_NOUN,
  roundPct,
  type FleetAvailability,
} from '@claude-control/usage-advisor';
import {
  recoveryText,
  type ExhaustedAccount,
  type ExhaustedRecord,
  type ExhaustionEpisode,
  type ExhaustionSwitch,
} from '@claude-control/daemon';
import { PLAIN_PALETTE, type Palette } from './ansi.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A moment in this machine's local time, "Oct 1 14:02" — with the year when it is not this
 *  year's. Absolute, unlike the countdowns the live views print, because a history entry is read
 *  long after the moment it describes. */
export function formatLocalTime(ms: number, now: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : ` ${d.getFullYear()}`;
  return `${MONTHS[d.getMonth()]} ${d.getDate()}${year} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** One account as it stood when the episode began. */
function accountLine(a: ExhaustedAccount, now: number): string {
  if (a.reason === 'quarantined') return 'login expired';
  const limit =
    a.percent !== undefined
      ? `${LIMIT_NOUN[a.reason]} ${roundPct(a.percent)}%`
      : LIMIT_NOUN[a.reason];
  const back =
    a.backAt === undefined
      ? 'reset time unknown'
      : `back ${formatLocalTime(a.backAt, now)}${a.backAtPredicted === true ? ' (predicted)' : ''}`;
  return `${limit}, ${back}`;
}

/** One switch in the walk that led there: "11:40  work1 -> work2  auto: work1 at 95% of ...". */
function switchLine(s: ExhaustionSwitch, now: number, palette: Palette): string {
  const why = [s.origin, s.reason].filter((p) => p !== undefined && p !== '').join(': ');
  return (
    `    ${formatLocalTime(s.at, now)}  ${s.from ?? '(none)'} -> ${s.to}` +
    (why !== '' ? `  ${palette.dim(why)}` : '')
  );
}

/** The heading line of one episode: when, how long, and how it ended. */
function episodeHeading(e: ExhaustionEpisode, now: number, palette: Palette): string {
  const start = palette.bold(formatLocalTime(e.start.at, now));
  if (e.end === undefined) {
    const first = e.start.firstBack;
    const expected =
      first !== undefined
        ? `; first back expected: ${first.label} at ${formatLocalTime(first.at, now)}` +
          `${first.predicted ? ' (predicted)' : ''}`
        : '';
    return `${start} -> ${palette.red('ongoing')}, ${humanizeDuration(now - e.start.at)} so far${expected}`;
  }
  return (
    `${start} -> ${formatLocalTime(e.end.backSince, now)}  ${palette.bold(humanizeDuration(e.end.durationMs))}` +
    `  back: ${e.end.account.label} (${recoveryText(e.end)})`
  );
}

/** Which episodes a `--days` window shows: those that started inside it, plus any still open. */
export function episodesInWindow(
  episodes: ExhaustionEpisode[],
  now: number,
  days: number | undefined,
): ExhaustionEpisode[] {
  if (days === undefined) return episodes;
  const since = now - days * 86_400_000;
  return episodes.filter((e) => e.start.at >= since || e.end === undefined);
}

/** `cctl exhausted`: every episode, newest first, each with its accounts and the switches
 *  that led there, then where the log lives. */
export function renderExhaustionLog(
  episodes: ExhaustionEpisode[],
  options: { now: number; logPath: string; days?: number; palette?: Palette },
): string {
  const { now, logPath } = options;
  const palette = options.palette ?? PLAIN_PALETTE;
  const scope = options.days !== undefined ? ` in the last ${options.days} days` : '';
  const footer = palette.dim(`Log: ${logPath}`);
  if (episodes.length === 0) {
    return `No time on record${scope} when every account was out of usage.\n${footer}`;
  }
  const blocks = [...episodes].reverse().map((e) => {
    const width = Math.max(...e.start.accounts.map((a) => a.label.length));
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
    return [episodeHeading(e, now, palette), ...accounts, ...walk].join('\n');
  });
  const count = `${episodes.length} time${episodes.length === 1 ? '' : 's'}${scope} no account could take work (newest first):`;
  return [count, '', blocks.join('\n\n'), '', footer].join('\n');
}

/** The banner `cctl usage` and `cctl timeline` lead with while no account can take work, or
 *  `undefined` while one can. Judged live from the same numbers the view prints; the open
 *  episode in the log only supplies since when. */
export function renderExhaustionBanner(
  fleet: FleetAvailability,
  open: ExhaustedRecord | undefined,
  now: number,
  palette: Palette = PLAIN_PALETTE,
): string | undefined {
  if (!fleet.exhausted) return undefined;
  const since =
    open !== undefined
      ? ` since ${formatLocalTime(open.at, now)} (${humanizeDuration(now - open.at)})`
      : '';
  return (
    palette.red(palette.bold(`No account can take work${since}.`)) +
    ` ${describeFirstBack(fleet, now)} cctl exhausted lists every time this happened.`
  );
}
