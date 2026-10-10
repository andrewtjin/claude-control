// `cctl claude` with arguments that reach a Claude Code background session (`claude --bg`): open it
// on the account of the folder it works in, moving it there when it can, and never let Claude Code
// take it from the service that runs it.
//
// Claude Code runs one background service per config dir, and a session's account is the config
// dir that hosts it. A ruled folder runs on its own profile (a config dir of its own), so the same
// session can be hosted by the main config dir's service or by a profile's. Each config dir keeps a
// job row for a session it ran, and a row under a config dir X for a session running in another
// config dir's service is a trap (measured against the real binary, 2.1.295): whatever under X
// wakes, stops or removes that row — `claude attach`, an interactive `--resume` (by id, by title,
// or chosen in its picker), `claude stop`, `claude rm`, `claude respawn`, Enter or Ctrl+X in the
// agents view — reaches the session where it runs and kills it there, mid-turn included (the turn
// is lost), or answers with the row's stale error. So:
//   - a move, by the daemon or by cctl, leaves a session a row only where it runs (see the daemon's
//     backgroundMove.ts);
//   - what `cctl claude` is asked to open is found first (by full id; a job id or any prefix of one,
//     or a name, for `attach`; a title among this folder's sessions and its git worktrees' for
//     `--resume`), and opened where it runs, or moved where it belongs first;
//   - anything else passed to Claude Code as typed under a config dir X is first checked against
//     X's rows: a row there for a session live in another service refuses the launch, naming where
//     the session runs and how to open it safely. Arguments cctl cannot tell are a plain new session
//     are checked so too, whatever they name.
// For one session found:
//   - it runs where it belongs (the slot of the folder it works in): opened there;
//   - it runs elsewhere, idle with nothing held and no terminal on that service: moved there by the
//     same move the daemon makes, then opened; busy, watched, in a git worktree Claude Code made for
//     it, or not movable: opened where it runs, saying it stays on that account for now. A session
//     left on the profile of a rule since removed has no login there, so it is moved to its folder's
//     slot whenever it is idle, and said plainly when it cannot be;
//   - it is open in a terminal: nothing is touched, and the operator is told where;
//   - it runs nowhere: `attach` wakes its row where it belongs (rows elsewhere removed first, a
//     failed one restarted, none at all started there with the options its latest row saved), and a
//     plain `--resume` runs it in the foreground as Claude Code does.
// A prompt given with `--resume <session> <prompt>` is passed on to the session where it is opened.
// The daemon's mover may reach the same session at the same moment, so all of this runs under the
// session's move lock, which is kept until the terminal opened here has shown up in its service's
// attach journal: from then on the daemon holds back on its own (see backgroundMover.ts).

import {
  SESSION_ID_PATTERN,
  allRows,
  confirmHosted,
  moveBackgroundSession,
  reasonOf,
  sameConfigDir,
  sessionLabel,
  settledWhere,
  type JobRow,
  type Lineage,
  type LiveSession,
  type LocatedRow,
  type MoveResult,
  type MoveTiming,
  type ResumeRecovery,
  type SessionLock,
  type SessionWhere,
} from '@claude-control/daemon';
import type { BackgroundSession } from '@claude-control/daemon';
import type { ClaudeBackgroundHost } from './backgroundHost.js';

/** Claude Code's own rule for a job id given to `attach` and its kin: one to eight lowercase hex
 *  digits are always a prefix of a job id, never a name. */
const JOB_PREFIX = /^[0-9a-f]{1,8}$/;

/** What the operator asked Claude Code to do with a background session. */
export type BackgroundRequest =
  /** `attach <session>`, flags before or after. `refAt` is where the session is named in `args`
   *  (the operator's words after a leading `--`). */
  | { verb: 'attach'; ref: string; args: string[]; refAt: number }
  /** An interactive `--resume <session>` (`-r`, `--resume=`), with every other word (a prompt, its
   *  flags) in `rest`. */
  | { verb: 'resume'; ref: string; rest: string[] }
  /** `stop`, `kill`, `rm` or `respawn` of one session: run where it runs. */
  | { verb: 'control'; ref: string; args: string[]; refAt: number }
  /** Anything else that can wake or stop a row under the slot it runs on: Claude Code's resume
   *  picker (a bare `--resume`, or a term matching no title), `--continue`, the agents view, a
   *  `respawn` of every session, a print-mode resume, and any arguments cctl cannot tell are a plain
   *  new session. Passed as typed once that slot holds no trap row (one matching `ref`, when given). */
  | { verb: 'guard'; ref?: string };

/** Options that start a new background session, or a copy of one: neither ever wakes an existing
 *  row (measured: the words around them become the new session's prompt or options). */
const BACKGROUND_STARTS: ReadonlySet<string> = new Set(['--bg', '--background']);
/** Subcommands that stop, remove or restart one session, or all of them. */
const CONTROL: ReadonlySet<string> = new Set(['stop', 'kill', 'rm', 'respawn']);
/** Subcommands that reach a job row, or list rows to choose from: never a plain new session. */
const ROW_SUBCOMMANDS: ReadonlySet<string> = new Set(['attach', 'agents', 'logs', ...CONTROL]);
/** Long options that resume or continue a conversation: never a plain new session. */
const RESUMING_OPTIONS: readonly string[] = ['--resume', '--continue', '--from-pr'];

/**
 * How Claude Code reads short options for a resume (its own argument pre-parser, the same in 2.1.296
 * as in 2.1.295): it peels `-c`, `-p`, `-h` and `-v` off the front of a word (`-cr` and `-pr` become
 * `-c` and `-p`, then `-r`), then reads what is left: `-r<value>` resumes that value, `-r` alone the
 * next word unless it is an option. Print mode is decided on the words `-p` and `--print` alone, so
 * `-pr <id>` is an interactive resume; a continue wins over any resume (measured: `-cr <id>` opens
 * the latest conversation, whatever the id).
 */
const PEELED: ReadonlySet<string> = new Set(['-c', '-p', '-h', '-v']);
/** A word that is a cluster of short options. */
const SHORT_CLUSTER = /^-[A-Za-z]/;

/** The first word after `from` that is not an option, and where it is. */
function nextWord(
  words: readonly string[],
  from: number,
): { word: string; at: number } | undefined {
  for (let i = from + 1; i < words.length; i++) {
    const word = words[i]!;
    if (!word.startsWith('-')) return word.trim() === '' ? undefined : { word, at: i };
  }
  return undefined;
}

/** What one argument list asks of a conversation, read as Claude Code reads it (see
 *  {@link PEELED}). */
interface ResumeReading {
  /** The session a resume names (the last one given, as Claude Code takes it). */
  ref?: string;
  /** A resume naming no session: the picker. */
  picker: boolean;
  /** `--continue`, in any spelling: Claude Code continues the latest conversation, whatever else
   *  it is told. */
  continues: boolean;
  print: boolean;
  /** A resume behind `-h` or `-v` in one word: Claude Code may print its help or version instead,
   *  so it is no resume cctl opens by itself. */
  unplain: boolean;
  /** Every word that is not the resume itself. */
  rest: string[];
}

function readResume(words: readonly string[]): ResumeReading {
  const out: ResumeReading = {
    picker: false,
    continues: false,
    print: false,
    unplain: false,
    rest: [],
  };
  /** An optional value: the word at `i` when it is no option. */
  const optionalAt = (i: number): string | undefined => {
    const next = words[i];
    return next !== undefined && !next.startsWith('-') && next.trim() !== '' ? next : undefined;
  };
  const resumeWith = (value: string | undefined): void => {
    if (value === undefined || value.trim() === '') {
      out.picker = true;
      delete out.ref;
    } else {
      out.picker = false;
      out.ref = value;
    }
  };
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (word === '--') {
      // Everything after it is the prompt, never an option.
      out.rest.push(...words.slice(i));
      break;
    }
    if (word === '--resume') {
      const value = optionalAt(i + 1);
      resumeWith(value);
      if (value !== undefined) i++;
      continue;
    }
    if (word.startsWith('--resume=')) {
      resumeWith(word.slice('--resume='.length));
      continue;
    }
    if (word === '--continue') out.continues = true;
    if (word === '--print' || word === '-p') out.print = true;
    if (!SHORT_CLUSTER.test(word)) {
      out.rest.push(word);
      continue;
    }
    // Peeled off its front, then read: what is left may be a resume.
    let left = word;
    while (/^-[a-zA-Z]./.test(left) && PEELED.has(left.slice(0, 2))) {
      if (left[1] === 'c') out.continues = true;
      if (left[1] === 'h' || left[1] === 'v') out.unplain = true;
      left = `-${left.slice(2)}`;
    }
    if (left === '-c') out.continues = true;
    if (left === '-r') {
      const value = optionalAt(i + 1);
      resumeWith(value);
      if (value !== undefined) i++;
      continue;
    }
    if (/^-r./.test(left)) {
      resumeWith(left.slice(2));
      continue;
    }
    out.rest.push(word);
  }
  return out;
}

/** Whether arguments are, by every word, a plain new session: no subcommand that reaches a row, no
 *  resume or continue in any spelling, and no cluster of short options with `r` or `c` in it.
 *  Anything else could reach a row, however it is spelled. */
function plainNewSession(words: readonly string[], reading: ResumeReading): boolean {
  if (reading.ref !== undefined || reading.picker || reading.continues || reading.unplain) {
    return false;
  }
  return !words.some(
    (w) =>
      ROW_SUBCOMMANDS.has(w) ||
      RESUMING_OPTIONS.some((o) => w === o || w.startsWith(`${o}=`)) ||
      (SHORT_CLUSTER.test(w) && /[rc]/.test(w.slice(1))),
  );
}

/**
 * What `cctl claude`'s arguments ask of a background session, if anything (see
 * {@link BackgroundRequest}), also after a leading `--`. A word that names a subcommand is taken as
 * one wherever it stands, flags before or after: Claude Code reads it so, and a word read as one
 * here that is not one only makes cctl look the session up. A resume is read in every spelling
 * Claude Code takes (`--resume <id>`, `--resume=<id>`, `-r <id>`, `-r<id>`, `-pr <id>`); one that
 * also continues is a continue, as Claude Code runs it. Undefined only for what is positively a plain new session,
 * or a new background start: anything cctl cannot read so is checked against the slot's rows before
 * it runs, whatever it names.
 */
export function parseBackgroundRequest(args: readonly string[]): BackgroundRequest | undefined {
  const words = args[0] === '--' ? args.slice(1) : [...args];
  // A new background session, or a copy of one when it names a session to resume.
  if (words.some((w) => BACKGROUND_STARTS.has(w))) return undefined;
  const attachAt = words.indexOf('attach');
  if (attachAt >= 0) {
    const ref = nextWord(words, attachAt);
    return ref === undefined
      ? { verb: 'guard' }
      : { verb: 'attach', ref: ref.word, args: words, refAt: ref.at };
  }
  const controlAt = words.findIndex((w) => CONTROL.has(w));
  if (controlAt >= 0) {
    const ref = nextWord(words, controlAt);
    if (ref === undefined) return { verb: 'guard' };
    return { verb: 'control', ref: ref.word, args: words, refAt: ref.at };
  }
  const reading = readResume(words);
  if (plainNewSession(words, reading)) return undefined;
  const rows = words.some((w) => ROW_SUBCOMMANDS.has(w));
  // A fork of the conversation it resumes wakes no row.
  if (words.includes('--fork-session') && !rows) return undefined;
  if (rows || reading.continues || reading.unplain || reading.ref === undefined) {
    return { verb: 'guard' };
  }
  // A one-shot print run is no terminal to open the session in: it is passed on, checked.
  if (reading.print) return { verb: 'guard', ref: reading.ref };
  return { verb: 'resume', ref: reading.ref, rest: reading.rest };
}

/** Where a session belongs: the slot of the folder it works in. */
export interface SessionHome {
  /** That slot's config dir; null is the main config dir (the global slot). */
  configDir: string | null;
  /** Whether a background session may be moved onto it now: a rule slot holding one of its
   *  included accounts with usage left (the daemon's own judgment, see `isMoveTarget`). */
  movable: boolean;
  /** Why nothing can run there now, as a sentence (a rule slot with no usable account). */
  unusable?: string;
}

/** A config dir as the operator knows it. */
export interface ConfigView {
  /** The account live there; absent when there is none (the profile of a removed rule). */
  account?: string;
  /** The slot in words: "the global slot", "the folder slot of C:\work". */
  slot: string;
  /** The profile of a folder rule since removed: no login, so every prompt there fails. */
  removed?: boolean;
}

export interface RouteContext {
  host: ClaudeBackgroundHost;
  /** The folder this command runs in; a title given to --resume is looked up there, as Claude Code
   *  looks one up. */
  cwd: string;
  platform: NodeJS.Platform;
  /** Whether two folders are the same one, by the platform's path rules. */
  sameFolder(a: string, b: string): boolean;
  /** The folders a title given to --resume from `cwd` is searched in, as Claude Code searches:
   *  the folder itself and every git worktree of its repository (Claude Code's own among them). */
  titleFolders(cwd: string): Promise<string[]>;
  /** Where a session working in a folder belongs. Makes that folder's slot live, as a launch there
   *  would, so it is asked only once a session has been found. */
  homeOf(cwd: string): Promise<SessionHome>;
  /** The config dir a launch that follows the folder runs under, without making anything live. */
  launchConfigDir(): Promise<string | null>;
  /** A config dir in words. */
  view(configDir: string | null): Promise<ConfigView>;
  /** Whether cctl's daemon is running, and so moves background sessions between turns. */
  daemonRunning: boolean;
  /** One line to the operator. */
  say(line: string): void;
  /** Run a move with Ctrl-C held off until it has finished or put the session back. `recovery`
   *  says, once the move has committed, the command that brings the session back by hand: it is
   *  told to an operator who interrupts, in case the window closes before the move ends. */
  shield<T>(fn: () => Promise<T>, recovery?: () => string | undefined): Promise<T>;
  /** How long to wait for another cctl process that is moving the same session. */
  lockWaitMs: number;
  timing: MoveTiming;
}

/** How the launch's config dir is chosen. */
export type RouteMode =
  /** By the session: it opens where it belongs, moved there when it can be. */
  | { kind: 'follow' }
  /** By the operator (`--account`, `--override`): the session is never moved, only kept from being
   *  taken from where it runs. */
  | { kind: 'fixed'; configDir: string | null };

/** A move lock kept until the terminal opened under a config dir shows up in its attach journal. */
export interface AttachHold {
  lock: SessionLock;
  configDir: string | null;
}

/** What `cctl claude` runs. */
export type RouteDecision =
  /** The arguments as given, on the slot the launch resolves to. */
  | { kind: 'pass'; hold?: AttachHold }
  /** These arguments under this config dir. */
  | { kind: 'open'; configDir: string | null; args: string[]; hold?: AttachHold }
  /** Nothing runs; the message says why. */
  | { kind: 'refuse'; message: string };

const PASS: RouteDecision = { kind: 'pass' };

/** Everything known of one background session: every id and job id it has had, its rows in every
 *  config dir (the latest first), its registry entries and the services listing it. */
interface Known {
  lineage: Lineage;
  rows: LocatedRow[];
  entries: LiveSession[];
  hosted: Array<{ configDir: string | null; worker: BackgroundSession }>;
}

/** How a found session is named and where it works. */
interface Target {
  known: Known;
  /** Its job id where it runs, else its latest row's. */
  short: string;
  /** The conversation it runs now. */
  currentId: string;
  /** The folder it works in: where its service started it, else its latest row's, else where its
   *  registry entry is. */
  cwd: string;
  name?: string;
}

/** Read every config dir's rows and roster and the registry, and gather them by session: a row,
 *  an entry and a roster worker belong together when they share an id or a job id (see the
 *  daemon's lineageOf). Something that cannot be read right now is left out here: this only finds
 *  the session, and where it runs is read again, strictly, before anything is done. Only background
 *  sessions are kept: one with a row, a service listing it, or a background registry entry. */
async function knownSessions(ctx: RouteContext): Promise<Known[]> {
  const { host } = ctx;
  const rows = await allRows(host).catch(() => [] as LocatedRow[]);
  const entries = await host.liveSessions().catch(() => [] as LiveSession[]);
  const hosted: Known['hosted'] = [];
  for (const configDir of await host.configDirs()) {
    for (const worker of await host.listHosted(configDir).catch(() => [])) {
      hosted.push({ configDir, worker });
    }
  }
  // Seeds, one per row, entry and worker, merged while any two share an id or a job id.
  const groups: Known[] = [];
  const seed = (ids: Array<string | undefined>, shorts: Array<string | undefined>): Known => {
    const known: Known = {
      lineage: {
        ids: new Set(ids.filter((x): x is string => x !== undefined)),
        shorts: new Set(shorts.filter((x): x is string => x !== undefined)),
      },
      rows: [],
      entries: [],
      hosted: [],
    };
    groups.push(known);
    return known;
  };
  for (const r of rows) seed([r.row.sessionId, r.row.resumeSessionId], [r.row.short]).rows.push(r);
  for (const e of entries) {
    seed([e.sessionId], [e.kind === 'bg' ? e.jobId : undefined]).entries.push(e);
  }
  for (const h of hosted) seed([h.worker.sessionId], [h.worker.short]).hosted.push(h);
  const overlaps = (a: Lineage, b: Lineage): boolean =>
    [...a.ids].some((x) => b.ids.has(x)) || [...a.shorts].some((x) => b.shorts.has(x));
  for (let merged = true; merged;) {
    merged = false;
    for (let i = 0; i < groups.length && !merged; i++) {
      for (let j = i + 1; j < groups.length && !merged; j++) {
        const a = groups[i]!;
        const b = groups[j]!;
        if (!overlaps(a.lineage, b.lineage)) continue;
        a.lineage = {
          ids: new Set([...a.lineage.ids, ...b.lineage.ids]),
          shorts: new Set([...a.lineage.shorts, ...b.lineage.shorts]),
        };
        a.rows.push(...b.rows);
        a.entries.push(...b.entries);
        a.hosted.push(...b.hosted);
        groups.splice(j, 1);
        merged = true;
      }
    }
  }
  for (const k of groups) {
    k.rows.sort((a, b) => (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? ''));
  }
  return groups.filter(
    (k) => k.rows.length > 0 || k.hosted.length > 0 || k.entries.some((e) => e.kind === 'bg'),
  );
}

/** A known session as it is named and found: its live job and conversation, else its latest
 *  row's; undefined when nothing says where it works. */
function targetOf(k: Known): Target | undefined {
  const live = k.entries.find((e) => e.kind === 'bg');
  const latest = k.rows[0]?.row;
  const worker = k.hosted[0]?.worker;
  const cwd = worker?.cwd ?? latest?.cwd ?? live?.cwd ?? k.entries[0]?.cwd;
  if (cwd === undefined) return undefined;
  const short = live?.jobId ?? worker?.short ?? latest?.short;
  const currentId =
    live?.sessionId ??
    (latest !== undefined ? (latest.resumeSessionId ?? latest.sessionId) : undefined) ??
    worker?.sessionId;
  if (short === undefined || currentId === undefined) return undefined;
  const name = namesOf(k).find((n) => n !== short);
  return { known: k, short, currentId, cwd, ...(name !== undefined ? { name } : {}) };
}

/** Claude Code's names for a session: its registry entries', then its rows'. */
function namesOf(k: Known): string[] {
  return [...k.entries.map((e) => e.name), ...k.rows.map((r) => r.row.name)].filter(
    (n): n is string => n !== undefined && n.length > 0,
  );
}

/** Every folder a session works in, by any record of it: where its service started it, where its
 *  rows say, its git worktree, and where its registry entry says it runs now. */
function foldersOfSession(k: Known): string[] {
  return [
    ...k.hosted.map((h) => h.worker.cwd),
    ...k.rows.flatMap((r) => [r.row.cwd, r.row.worktreePath]),
    ...k.entries.map((e) => e.cwd),
  ].filter((f): f is string => f !== undefined);
}

type Resolution =
  { kind: 'none' } | { kind: 'one'; target: Target } | { kind: 'ambiguous'; candidates: string[] };

/** The candidates of an ambiguous name in words: an id with its name, as the operator retypes it. */
function candidateOf(t: Target, verb: BackgroundRequest['verb']): string {
  return `${verb === 'resume' ? t.currentId : t.short}${t.name !== undefined ? ` "${t.name}"` : ''}`;
}

/** The session a request names, read the way Claude Code reads it: a full session id (any id the
 *  session has had); for attach and its kin, a job id prefix (never a name), else a whole name,
 *  else part of one; for --resume, a title among the sessions of this folder and its worktrees,
 *  counting every conversation there with that title, background or not. */
async function resolve(
  req: Extract<BackgroundRequest, { ref: string }>,
  ctx: RouteContext,
): Promise<Resolution> {
  const known = await knownSessions(ctx);
  const pick = (ks: Known[]): Resolution => {
    const targets = ks.map(targetOf).filter((t): t is Target => t !== undefined);
    if (targets.length === 0) return { kind: 'none' };
    return targets.length === 1
      ? { kind: 'one', target: targets[0]! }
      : { kind: 'ambiguous', candidates: targets.map((t) => candidateOf(t, req.verb)) };
  };
  const ref = req.ref.trim();
  if (SESSION_ID_PATTERN.test(ref.toLowerCase())) {
    return pick(known.filter((k) => k.lineage.ids.has(ref.toLowerCase())));
  }
  if (req.verb !== 'resume') {
    if (JOB_PREFIX.test(ref))
      return pick(known.filter((k) => [...k.lineage.shorts].some((s) => s.startsWith(ref))));
    const lower = ref.toLowerCase();
    const names = (k: Known): string[] => namesOf(k).map((n) => n.toLowerCase().trim());
    const whole = known.filter((k) => names(k).includes(lower));
    if (whole.length > 0) return pick(whole);
    // Claude Code takes part of a name too.
    return pick(known.filter((k) => names(k).some((n) => n.includes(lower))));
  }
  // --resume <title>: Claude Code matches a conversation's title among the sessions of the folder
  // it runs in and of its repository's worktrees; one match resumes it, more open its picker.
  const wanted = ref.toLowerCase();
  const folders = await ctx.titleFolders(ctx.cwd);
  const inScope = (f: string): boolean => folders.some((s) => ctx.sameFolder(s, f));
  const background: Known[] = [];
  for (const k of known) {
    if (!foldersOfSession(k).some(inScope)) continue;
    for (const id of k.lineage.ids) {
      const title = await ctx.host.sessionTitle(id);
      if (title !== undefined && title.toLowerCase().trim() === wanted) {
        background.push(k);
        break;
      }
    }
  }
  const ordinary = [...(await ctx.host.titlesIn(folders))].filter(
    ([id, title]) =>
      title.toLowerCase().trim() === wanted && !known.some((k) => k.lineage.ids.has(id)),
  );
  if (background.length === 1 && ordinary.length === 0) return pick(background);
  if (background.length + ordinary.length <= 1) return { kind: 'none' };
  return {
    kind: 'ambiguous',
    candidates: [
      ...background
        .map(targetOf)
        .filter((t): t is Target => t !== undefined)
        .map((t) => candidateOf(t, 'resume')),
      ...ordinary.map(([id]) => id),
    ],
  };
}

/** A job row under the launch's config dir for a session live in another service (see the
 *  header): what wakes, stops or removes it kills that session where it runs. */
interface Trap {
  row: JobRow;
  /** The config dir whose service runs the session, when one of cctl's lists it. */
  runsIn: string | null | undefined;
  name?: string;
}

/** How many times a trap check reads again when something is caught mid-write. */
const TRAP_TRIES = 3;
const TRAP_PAUSE_MS = 300;

/** The trap rows a config dir holds (see {@link Trap}), read strictly: something that cannot be
 *  read throws, and is read again a few times before the caller is told. */
async function trapsIn(ctx: RouteContext, configDir: string | null): Promise<Trap[]> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await readTraps(ctx, configDir);
    } catch (err) {
      if (attempt >= TRAP_TRIES) throw err;
      await ctx.timing.sleep(TRAP_PAUSE_MS);
    }
  }
}

async function readTraps(ctx: RouteContext, configDir: string | null): Promise<Trap[]> {
  const { host, platform } = ctx;
  const rows = await host.jobRows(configDir);
  if (rows.length === 0) return [];
  const live = (await host.liveSessions()).filter((e) => e.kind === 'bg');
  const traps: Trap[] = [];
  for (const row of rows) {
    const ids = [row.sessionId, row.resumeSessionId];
    const entry = live.find((e) => e.jobId === row.short || ids.includes(e.sessionId));
    if (entry === undefined) continue;
    let runsIn: string | null | undefined;
    for (const c of await host.configDirs()) {
      const hosted = await host.listHosted(c, { verified: true });
      if (hosted.some((w) => w.short === entry.jobId || ids.includes(w.sessionId))) runsIn = c;
    }
    if (runsIn !== undefined && sameConfigDir(runsIn, configDir, platform)) continue;
    traps.push({
      row,
      runsIn,
      ...(entry.name !== undefined
        ? { name: entry.name }
        : row.name !== undefined
          ? { name: row.name }
          : {}),
    });
  }
  return traps;
}

/** Whether Claude Code could take a reference typed under a config dir to mean a trap row's
 *  session: an id it has had, a prefix of its job id, its name or part of it, or a title. */
async function trapMatches(ctx: RouteContext, trap: Trap, ref: string): Promise<boolean> {
  const r = ref.trim();
  const ids = [trap.row.sessionId, trap.row.resumeSessionId].filter(
    (x): x is string => x !== undefined,
  );
  if (SESSION_ID_PATTERN.test(r.toLowerCase())) return ids.includes(r.toLowerCase());
  if (JOB_PREFIX.test(r)) return trap.row.short.startsWith(r);
  const lower = r.toLowerCase();
  if ([trap.name, trap.row.name].some((n) => n !== undefined && n.toLowerCase().includes(lower))) {
    return true;
  }
  for (const id of ids) {
    const title = await ctx.host.sessionTitle(id);
    if (title !== undefined && title.toLowerCase().trim() === lower) return true;
  }
  return false;
}

/**
 * Pass the operator's arguments to Claude Code as typed under the launch's config dir, once that
 * config dir holds no trap row they could reach: one matching `ref` when the arguments name a
 * session, any at all when they open a list to choose from. Otherwise refuse, naming the session,
 * where it runs, and the command that opens it safely.
 */
async function guardedPass(
  ctx: RouteContext,
  mode: RouteMode,
  ref: string | undefined,
): Promise<RouteDecision> {
  const under = mode.kind === 'fixed' ? mode.configDir : await ctx.launchConfigDir();
  let traps: Trap[];
  try {
    traps = await trapsIn(ctx, under);
  } catch (err) {
    return {
      kind: 'refuse',
      message:
        `cannot tell whether a background session would be taken from the service running it ` +
        `(${reasonOf(err)}); try again in a moment.`,
    };
  }
  const reached: Trap[] = [];
  for (const trap of traps) {
    if (ref === undefined || (await trapMatches(ctx, trap, ref))) reached.push(trap);
  }
  if (reached.length === 0) return PASS;
  const here = await ctx.view(under);
  const lines: string[] = [];
  for (const trap of reached) {
    const runs =
      trap.runsIn === undefined
        ? 'another background service'
        : onWhat(await ctx.view(trap.runsIn));
    lines.push(
      `${sessionLabel(trap.row.short, trap.name)} runs on ${runs}; open it with: cctl claude attach ${trap.row.short}`,
    );
  }
  return {
    kind: 'refuse',
    message:
      `${here.slot} still holds a job row for a background session that runs elsewhere, and Claude ` +
      `Code would stop it there and take it over from this command. ${lines.join('. ')}.`,
  };
}

/** How a session is named to the operator: its name and short id, or the short id alone. */
function label(t: Target): string {
  return sessionLabel(t.short, t.name);
}

/** An account and its slot in words: "Alice (the global slot)", or the slot alone. */
function onWhat(v: ConfigView): string {
  return v.account !== undefined ? `${v.account} (${v.slot})` : v.slot;
}

/** The command that brings a session back by hand where a move left it to be (see the daemon's
 *  ResumeRecovery), naming the config dir as the host reaches it. */
function recoveryHint(ctx: RouteContext, recovery: ResumeRecovery): string {
  return ctx.host.resumeHint(recovery.configDir, recovery.sessionId, recovery.options);
}

/** Why a session running elsewhere is not moved where it belongs, in words. */
function stayReason(status: string | undefined): string {
  if (status === 'busy') return 'it is in a turn';
  if (status === 'waiting') return 'it is waiting on a prompt';
  return 'it is not idle between turns';
}

/**
 * Decide what `cctl claude` runs for a request that reaches a background session (see the header).
 * The session's move lock is held while deciding, and handed on in the decision (`hold`) when a
 * terminal is about to open it; otherwise it is released before this returns.
 */
export async function routeBackgroundLaunch(
  req: BackgroundRequest,
  ctx: RouteContext,
  mode: RouteMode,
): Promise<RouteDecision> {
  if (req.verb === 'guard') return guardedPass(ctx, mode, req.ref);
  const found = await resolve(req, ctx);
  // A --resume term that is no title here opens Claude Code's picker, where anything can be
  // chosen; what attach and its kin are given only ever names one session.
  if (found.kind === 'none') {
    return guardedPass(ctx, mode, req.verb === 'resume' ? undefined : req.ref);
  }
  if (found.kind === 'ambiguous') {
    // A --resume title more than one conversation has opens Claude Code's picker: safe to pass on
    // only while nothing there can be chosen into a steal.
    if (req.verb === 'resume') {
      const passed = await guardedPass(ctx, mode, undefined);
      if (passed.kind === 'pass') return passed;
    }
    return {
      kind: 'refuse',
      message: `"${req.ref}" names more than one session (${found.candidates.join(', ')}); name one by its id.`,
    };
  }
  const target = found.target;
  let lock = await ctx.host.lockSession(target.currentId, 0);
  if (lock === undefined) {
    ctx.say(`cctl: another cctl process is moving ${label(target)}; waiting for it to finish.`);
    lock = await ctx.host.lockSession(target.currentId, ctx.lockWaitMs);
  }
  if (lock === undefined) {
    return {
      kind: 'refuse',
      message: `another cctl process is still moving ${label(target)}; try again in a moment.`,
    };
  }
  let decision: RouteDecision | undefined;
  try {
    decision =
      req.verb === 'control'
        ? await decideControl(req, target, ctx)
        : await decide(req, target, ctx, mode, lock);
    return decision;
  } finally {
    if (decision === undefined || !('hold' in decision) || decision.hold === undefined) {
      lock.release();
    }
  }
}

/** Where a session runs, read strictly (see the daemon's settledWhere). */
function locate(t: Target, ctx: RouteContext): Promise<SessionWhere> {
  return settledWhere(ctx.host, t.known.lineage, ctx.timing);
}

/** `stop`, `kill`, `rm` or `respawn` of one session: run under the config dir whose service runs
 *  it, by its job id there, so no row elsewhere is ever what the command reaches. */
async function decideControl(
  req: Extract<BackgroundRequest, { verb: 'control' }>,
  target: Target,
  ctx: RouteContext,
): Promise<RouteDecision> {
  const where = await locate(target, ctx);
  if (where.kind === 'unclear') {
    return {
      kind: 'refuse',
      message: `cannot tell which account's background service runs ${label(target)} right now (${where.reason}); try again in a moment.`,
    };
  }
  if (where.kind !== 'bg') return PASS;
  const args = [...req.args];
  args[req.refAt] = where.short;
  const runsOn = await ctx.view(where.configDir);
  ctx.say(`cctl: background session ${label(target)} runs on ${onWhat(runsOn)}; running it there.`);
  return { kind: 'open', configDir: where.configDir, args };
}

/** What opens a session under a config dir: `attach` by its job id there, with the operator's
 *  other words; a `--resume` with a prompt or flags is run as given, by the conversation's id, so
 *  the prompt reaches the session (Claude Code sends it to the background session and opens it). */
function openArgs(
  req: Extract<BackgroundRequest, { verb: 'attach' | 'resume' }>,
  short: string,
  currentId: string,
): string[] {
  if (req.verb === 'resume') {
    return req.rest.length > 0 ? ['--resume', currentId, ...req.rest] : ['attach', short];
  }
  const args = [...req.args];
  args[req.refAt] = short;
  return args;
}

/** The decision for one found session, under its move lock. `again` is set on the one second look
 *  taken when the session left the service it was found on while being moved. */
async function decide(
  req: Extract<BackgroundRequest, { verb: 'attach' | 'resume' }>,
  target: Target,
  ctx: RouteContext,
  mode: RouteMode,
  lock: SessionLock,
  again = false,
): Promise<RouteDecision> {
  const { platform } = ctx;
  const where = await locate(target, ctx);
  if (where.kind === 'interactive') {
    return {
      kind: 'refuse',
      message:
        `${label(target)} is open in a terminal right now (process ${where.pid}` +
        `${where.cwd !== undefined ? `, in ${where.cwd}` : ''}); use that terminal, or close the ` +
        'session there first.',
    };
  }
  if (where.kind === 'unclear') {
    return {
      kind: 'refuse',
      message:
        `cannot tell which account's background service runs ${label(target)} right now; ` +
        'try again in a moment.',
    };
  }
  const open = (configDir: string | null, short: string, currentId: string): RouteDecision => ({
    kind: 'open',
    configDir,
    args: openArgs(req, short, currentId),
    hold: { lock, configDir },
  });
  const tree = target.known.rows.find((r) => r.row.worktreePath !== undefined);

  if (where.kind === 'bg') {
    const here = (configDir: string | null): RouteDecision =>
      open(configDir, where.short, where.currentId);
    if (mode.kind === 'fixed') {
      if (sameConfigDir(where.configDir, mode.configDir, platform)) {
        // It runs where this launch runs: the operator's own arguments open it there.
        return { kind: 'pass', hold: { lock, configDir: where.configDir } };
      }
      ctx.say(
        `cctl: background session ${label(target)} runs on ${onWhat(await ctx.view(where.configDir))}; opening it there.`,
      );
      return here(where.configDir);
    }
    const home = await ctx.homeOf(where.cwd);
    if (sameConfigDir(where.configDir, home.configDir, platform)) return here(where.configDir);
    // It runs on another config dir's service: anything run where it belongs would reach it through
    // a row there, so it is either moved first or opened where it runs.
    const runsOn = await ctx.view(where.configDir);
    const belongs = await ctx.view(home.configDir);
    // A rule since removed left its profile without a login: there is nothing to keep it there for.
    const orphaned = runsOn.removed === true && home.unusable === undefined;
    let why: string;
    let final = false;
    if (tree !== undefined) {
      why = 'it works in a git worktree Claude Code made for it, which a move would delete';
      final = true;
    } else if (home.unusable !== undefined) {
      why = home.unusable;
    } else if (!home.movable && !orphaned) {
      why =
        home.configDir === null
          ? 'cctl moves background sessions only onto a folder slot'
          : `${belongs.slot} does not hold one of its own accounts with usage left`;
    } else if (where.status !== 'idle') {
      why = stayReason(where.status);
    } else {
      let hint: string | undefined;
      const moved: MoveResult = await ctx.shield(
        () =>
          moveBackgroundSession(
            ctx.host,
            {
              session: { short: where.short, sessionId: where.sessionId, cwd: where.cwd },
              from: { configDir: where.configDir, name: runsOn.slot },
              to: { configDir: home.configDir, name: belongs.slot },
              platform,
            },
            ctx.timing,
            // Said once the move's own checks have passed, right before the stop: from then on
            // the session runs nowhere until it is resumed, here or back where it was.
            (recovery) => {
              hint = recoveryHint(ctx, recovery);
              ctx.say(
                `cctl: moving background session ${label(target)} from ${onWhat(runsOn)} onto ` +
                  `${onWhat(belongs)}; Ctrl-C waits until it has finished.`,
              );
            },
          ),
        () => hint,
      );
      if (moved.result === 'moved') {
        ctx.say(
          `cctl: moved background session ${sessionLabel(moved.short, target.name)} onto ` +
            `${onWhat(belongs)}, the folder's own account. Same session, same conversation.`,
        );
        return open(home.configDir, moved.short, moved.sessionId);
      }
      // It stopped or left on its own between the look and the move: look once more.
      if (moved.result === 'not-moved' && moved.cause === 'gone' && !again) {
        return decide(req, target, ctx, mode, lock, true);
      }
      if (moved.result === 'failed' && !moved.restored) {
        return {
          kind: 'refuse',
          message:
            `could not move ${label(target)} onto ${onWhat(belongs)} (${moved.reason}), nor ` +
            `resume it on ${onWhat(runsOn)}. Resume it there with: ` +
            recoveryHint(ctx, moved.recovery),
        };
      }
      why = moved.reason;
      final = moved.result === 'not-moved' ? moved.final : true;
    }
    // The daemon moves sessions off the global slot only, onto a folder slot it judges movable.
    const daemonMoves =
      ctx.daemonRunning &&
      where.configDir === null &&
      home.configDir !== null &&
      home.movable &&
      !final;
    ctx.say(
      `cctl: background session ${label(target)} stays on ${onWhat(runsOn)} for now: ${why}.` +
        (runsOn.removed === true
          ? ' That profile has no login, so prompts there fail with "Not logged in" until cctl ' +
            'can move it, between turns.'
          : '') +
        (daemonMoves
          ? ` cctl's daemon moves it onto ${belongs.account ?? belongs.slot} between turns.`
          : '') +
        ' Opening it there.',
    );
    return here(where.configDir);
  }

  // It runs nowhere. With the slot chosen by the operator, or for a plain --resume (Claude Code
  // runs it in the foreground there, whatever rows it has), Claude Code opens it as asked.
  if (mode.kind === 'fixed' || req.verb === 'resume') return PASS;
  const rows = target.known.rows;
  // No row anywhere: nothing of cctl's to open, and Claude Code says so itself.
  if (rows.length === 0) return PASS;
  const home = await ctx.homeOf(target.cwd);

  // Started under a config dir from its row there, idle, and confirmed; a refusal says why. The row
  // is woken by the id its job started with: Claude Code wakes it into the conversation it ran last,
  // with the options it saved, under its own job id (measured: after /clear, given the
  // conversation's own id, it starts a new job of that name with no options, and the row stays).
  const wake = async (configDir: string | null, row: JobRow): Promise<string | undefined> => {
    try {
      await ctx.host.resumeIdle({
        configDir,
        sessionId: row.sessionId,
        short: row.short,
        cwd: target.cwd,
      });
      if (!(await confirmHosted(ctx.host, configDir, row.short, ctx.timing))) {
        return 'it did not show up there';
      }
      return undefined;
    } catch (err) {
      return reasonOf(err);
    }
  };
  const cannotStart = async (configDir: string | null, why: string): Promise<RouteDecision> => ({
    kind: 'refuse',
    message: `could not start ${label(target)} on ${onWhat(await ctx.view(configDir))}: ${why}.`,
  });
  // Opened under one config dir: every other row it has goes first, while it runs nowhere, so no
  // row is left elsewhere to reach it once it runs. One recording a worktree stays.
  const keepOnly = async (configDir: string | null): Promise<void> => {
    for (const r of rows) {
      if (sameConfigDir(r.configDir, configDir, platform) || r.row.worktreePath !== undefined) {
        continue;
      }
      await ctx.host
        .removeRow(r.configDir, r.row.short)
        .catch((err: unknown) =>
          ctx.say(
            `cctl: could not remove the job row of ${label(target)} left on ` +
              `${r.configDir === null ? 'the main config dir' : r.configDir}: ${reasonOf(err)}.`,
          ),
        );
    }
  };
  // Opened where its row is, waking a failed one first (attach only echoes a failed row's error).
  const openRow = async (r: LocatedRow, note?: string): Promise<RouteDecision> => {
    await keepOnly(r.configDir);
    if (r.row.state === 'failed') {
      const failed = await wake(r.configDir, r.row);
      if (failed !== undefined) return cannotStart(r.configDir, failed);
    }
    if (note !== undefined) ctx.say(note);
    const currentId = r.row.resumeSessionId ?? r.row.sessionId;
    return open(r.configDir, r.row.short, currentId);
  };

  if (tree !== undefined) {
    const where = await ctx.view(tree.configDir);
    return openRow(
      tree,
      sameConfigDir(tree.configDir, home.configDir, platform)
        ? undefined
        : `cctl: background session ${label(target)} stays on ${onWhat(where)}: it works in a git ` +
            'worktree Claude Code made for it, which a move would delete. Opening it there.',
    );
  }
  if (home.unusable !== undefined) return { kind: 'refuse', message: home.unusable };
  const here = rows.find((r) => sameConfigDir(r.configDir, home.configDir, platform));
  if (here !== undefined) return openRow(here);
  // The slot it belongs to holds no row: start it there from its latest row, on the terms a move
  // carries options over on (its rows elsewhere go, so it is left one only there).
  const latest = rows[0]!;
  let hint: string | undefined;
  const started = await ctx.shield(
    () =>
      moveBackgroundSession(
        ctx.host,
        {
          session: { short: latest.row.short, sessionId: latest.row.sessionId, cwd: target.cwd },
          from: { configDir: latest.configDir, name: 'its last config dir' },
          to: { configDir: home.configDir, name: 'the slot it belongs to' },
          start: true,
          platform,
        },
        ctx.timing,
        // From here its rows are going, until it is started there or put back.
        (recovery) => (hint = recoveryHint(ctx, recovery)),
      ),
    () => hint,
  );
  if (started.result === 'moved') {
    ctx.say(
      `cctl: started background session ${label(target)} on ` +
        `${onWhat(await ctx.view(home.configDir))}, the slot of the folder it works in.`,
    );
    return open(home.configDir, started.short, started.sessionId);
  }
  if (started.result === 'failed') {
    if (!started.restored) {
      return {
        kind: 'refuse',
        message:
          `could not start ${label(target)} on ${onWhat(await ctx.view(home.configDir))} ` +
          `(${started.reason}). Resume it with: ${recoveryHint(ctx, started.recovery)}`,
      };
    }
    return cannotStart(home.configDir, started.reason);
  }
  // It cannot start there without changing: open it where its row is.
  const rowOn = await ctx.view(latest.configDir);
  return openRow(
    latest,
    `cctl: background session ${label(target)} stays on ${onWhat(rowOn)}: ${started.reason}. Opening it there.`,
  );
}

/** How long the move lock is kept for a terminal that has not shown up in its attach journal: far
 *  past the few seconds an attach takes. The lock's claim is refreshed while held, so a hold never
 *  outlives it (see backgroundHost.ts). */
const HOLD_CAP_MS = 60_000;
const HOLD_POLL_MS = 250;

/**
 * Run the terminal that opens a session (`run`, which reports the pid of the process it started),
 * keeping the move lock of `hold` until that service's attach journal shows THAT process, the
 * terminal exits, or {@link HOLD_CAP_MS} passes. Until then the daemon could take the session idle
 * and unwatched and move it, and the attach would then wake its row here and kill the moved copy;
 * once the journal shows it, the daemon holds back by itself. Another terminal already on that
 * service says nothing about this one.
 */
export async function runHolding<T>(
  host: Pick<ClaudeBackgroundHost, 'attachedBy'>,
  hold: AttachHold | undefined,
  run: (spawned: (pid: number) => void) => Promise<T>,
  opts: { clock?: () => number; sleep?: (ms: number) => Promise<void>; capMs?: number } = {},
): Promise<T> {
  if (hold === undefined) return run(() => {});
  const clock = opts.clock ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = clock() + (opts.capMs ?? HOLD_CAP_MS);
  let released = false;
  let pid: number | undefined;
  const release = (): void => {
    if (released) return;
    released = true;
    hold.lock.release();
  };
  const watch = (async (): Promise<void> => {
    while (!released && clock() < deadline) {
      if (pid !== undefined && (await host.attachedBy(hold.configDir, pid).catch(() => false))) {
        break;
      }
      await sleep(HOLD_POLL_MS);
    }
    release();
  })();
  try {
    return await run((p) => (pid = p));
  } finally {
    release();
    await watch;
  }
}
