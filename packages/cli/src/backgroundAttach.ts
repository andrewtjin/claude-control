// `cctl claude attach <session>` and `cctl claude --resume <session>` when the session is a Claude
// Code background session (`claude --bg`): open it on the account of the folder it works in, moving
// it there when it can, and never let Claude Code take it from the service that runs it.
//
// Claude Code runs one background service per config dir, and a session's account is the config
// dir that hosts it. A ruled folder runs on its own profile (a config dir of its own), so the same
// session can be hosted by the main config dir's service or by a profile's, and can have a job row
// in several. What Claude Code does with `attach` or an interactive `--resume` under a config dir X
// depends on where the session runs (measured against the real binary, 2.1.295):
//   - live in X: it opens it;
//   - live in another config dir's service while X holds a STOPPED row for it: it wakes X's row,
//     and the wake kills the copy running elsewhere, even mid-turn (the turn is lost, and the other
//     row ends failed). That is a steal, and nothing here ever lets one happen: no attach or resume
//     is run under a config dir while the session runs as a background session in another;
//   - live elsewhere while X holds a FAILED row: it echoes that row's stale error and exits 1;
//   - live elsewhere while X holds no row: "No job matching", exit 1 (attach), or "running in the
//     background", exit 1 (--resume);
//   - live nowhere: attach wakes X's stopped row with X's saved options, but echoes a failed row's
//     error even then; --resume opens it in the foreground (fine), unless X's row failed.
// So the session is found first (the shared registry says whether it runs and what it is doing,
// each service's roster says which one runs it), and then:
//   - it runs where it belongs (the slot of the folder it works in): opened there;
//   - it runs elsewhere and is idle, with no terminal on it: moved there by the same move the daemon
//     makes (see the daemon's backgroundMove.ts), then opened; busy, watched, or not movable: opened
//     where it runs, saying it stays on that account for now;
//   - it is open in a terminal: nothing is touched, and the operator is told where;
//   - it runs nowhere: its row where it belongs is woken (a failed one restarted first; none at all
//     started there with the options its latest row saved, as a move would), then opened; a plain
//     --resume runs in the foreground as Claude Code does it.
// The daemon's mover may reach the same session at the same moment, so all of this runs under the
// session's move lock, which is kept until the terminal opened here has shown up in its service's
// attach journal: from then on the daemon holds back on its own (see backgroundMover.ts).

import {
  confirmHosted,
  moveBackgroundSession,
  type MoveTiming,
  type SessionLock,
} from '@claude-control/daemon';
import type { ClaudeBackgroundHost, JobRow, LiveSession } from './backgroundHost.js';

/** What the operator asked Claude Code to open. */
export interface BackgroundRequest {
  verb: 'attach' | 'resume';
  /** The session as named: a session id, a short id (attach only), or a name. */
  ref: string;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHORT_ID = /^[0-9a-f]{8}$/i;

/** Options that make `--resume` something other than opening the session in this terminal: a copy,
 *  a new background start, a one-shot print run, or the folder's latest session instead. None of
 *  them opens a running background session, so they pass through untouched. */
const NOT_AN_OPEN: ReadonlySet<string> = new Set([
  '--bg',
  '--background',
  '--fork-session',
  '-p',
  '--print',
  '-c',
  '--continue',
]);

/**
 * The background session `cctl claude`'s arguments open, if they open one: `attach <session>`, or an
 * interactive `--resume <session>` (`-r`, `--resume=`), also after a leading `--`. `--resume` with no
 * value opens Claude Code's picker, and anything else is not a request to open a session, so both
 * are left alone.
 */
export function parseBackgroundRequest(args: readonly string[]): BackgroundRequest | undefined {
  const words = args[0] === '--' ? args.slice(1) : args;
  if (words[0] === 'attach') {
    // `claude attach` takes exactly one session; anything more is Claude Code's to refuse.
    const ref = words[1];
    if (words.length !== 2 || ref === undefined || ref.startsWith('-') || ref.trim() === '') {
      return undefined;
    }
    return { verb: 'attach', ref };
  }
  let ref: string | undefined;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (NOT_AN_OPEN.has(word)) return undefined;
    if (word === '--resume' || word === '-r') {
      const next = words[i + 1];
      if (next === undefined || next.startsWith('-')) return undefined;
      ref = next;
      i++;
    } else if (word.startsWith('--resume=')) {
      ref = word.slice('--resume='.length);
    }
  }
  return ref !== undefined && ref.trim() !== '' ? { verb: 'resume', ref } : undefined;
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
}

export interface RouteContext {
  host: ClaudeBackgroundHost;
  /** The folder this command runs in; a name given to --resume is looked up there, as Claude Code
   *  looks one up. */
  cwd: string;
  platform: NodeJS.Platform;
  /** Whether two folders are the same one, by the platform's path rules. */
  sameFolder(a: string, b: string): boolean;
  /** Where a session working in a folder belongs. Makes that folder's slot live, as a launch there
   *  would, so it is asked only once a session has been found. */
  homeOf(cwd: string): Promise<SessionHome>;
  /** A config dir in words. */
  view(configDir: string | null): Promise<ConfigView>;
  /** Whether cctl's daemon is running, and so moves background sessions between turns. */
  daemonRunning: boolean;
  /** One line to the operator. */
  say(line: string): void;
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

/** One session as found: its ids, where it works, and what it is called. */
interface Target {
  sessionId: string;
  short: string;
  cwd: string;
  name?: string;
}

/** Everything read about one session before it is chosen. */
interface Known {
  sessionId: string;
  short: string;
  entry?: LiveSession;
  /** Its rows, by config dir, the latest first. */
  rows: Array<{ configDir: string | null; row: JobRow }>;
  /** Hosted by some service's roster. */
  hostedCwd?: string;
}

/** Whether two config dirs are the same one (null is the main config dir). */
function sameConfig(a: string | null, b: string | null, platform: NodeJS.Platform): boolean {
  if (a === null || b === null) return a === b;
  const norm = (p: string): string => {
    const trimmed = p.replace(/[\\/]+$/, '');
    return platform === 'win32' ? trimmed.replace(/\//g, '\\').toLowerCase() : trimmed;
  };
  return norm(a) === norm(b);
}

/** Every config dir that can run a background service of cctl's: the main one, then each profile. */
async function configDirs(host: ClaudeBackgroundHost): Promise<Array<string | null>> {
  return [null, ...(await host.profileConfigDirs())];
}

/** Read everything known about every session: the live registry, every config dir's rows and
 *  rosters. */
async function knownSessions(ctx: RouteContext): Promise<Map<string, Known>> {
  const known = new Map<string, Known>();
  const of = (sessionId: string): Known => {
    let k = known.get(sessionId);
    if (k === undefined) {
      k = { sessionId, short: sessionId.slice(0, 8), rows: [] };
      known.set(sessionId, k);
    }
    return k;
  };
  for (const entry of await ctx.host.liveSessions()) {
    const k = of(entry.sessionId);
    // A foreground entry wins over a background one: it says the session is open in a terminal.
    if (k.entry === undefined || entry.kind !== 'bg') k.entry = entry;
  }
  for (const configDir of await configDirs(ctx.host)) {
    for (const row of await ctx.host.jobRows(configDir))
      of(row.sessionId).rows.push({ configDir, row });
    for (const s of await ctx.host.listHosted(configDir).catch(() => [])) {
      of(s.sessionId).hostedCwd = s.cwd;
    }
  }
  for (const k of known.values()) {
    k.rows.sort((a, b) => (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? ''));
  }
  return known;
}

/** The folder a session works in: where it runs, else its latest row's. */
function cwdOf(k: Known): string | undefined {
  return k.entry?.cwd ?? k.hostedCwd ?? k.rows.find((r) => r.row.cwd !== undefined)?.row.cwd;
}

/** Claude Code's name for a session, when it has one other than its id. */
function nameOf(k: Known): string | undefined {
  const names = [k.entry?.name, ...k.rows.map((r) => r.row.name)];
  return names.find((n) => n !== undefined && n.length > 0 && n !== k.short);
}

function targetOf(k: Known): Target | undefined {
  const cwd = cwdOf(k);
  if (cwd === undefined) return undefined;
  const name = nameOf(k);
  return { sessionId: k.sessionId, short: k.short, cwd, ...(name !== undefined ? { name } : {}) };
}

/** Whether a session runs as a background session somewhere, or has a row that failed: the only
 *  ones a --resume by name could make Claude Code steal, or answer with a stale error. */
function atRisk(k: Known): boolean {
  return (
    k.hostedCwd !== undefined ||
    k.entry?.kind === 'bg' ||
    k.rows.some((r) => r.row.state === 'failed')
  );
}

type Resolution =
  { kind: 'none' } | { kind: 'one'; target: Target } | { kind: 'ambiguous'; candidates: Target[] };

/** The session a request names, read the way Claude Code reads it: a session id anywhere; for
 *  attach, a short id, else a whole name, else part of one (job rows and live entries); for
 *  --resume, a title among the sessions of this folder. */
async function resolve(req: BackgroundRequest, ctx: RouteContext): Promise<Resolution> {
  const known = await knownSessions(ctx);
  const pick = (ks: Known[]): Resolution => {
    const targets = ks.map(targetOf).filter((t): t is Target => t !== undefined);
    if (targets.length === 0) return { kind: 'none' };
    return targets.length === 1
      ? { kind: 'one', target: targets[0]! }
      : { kind: 'ambiguous', candidates: targets };
  };
  const ref = req.ref.trim();
  if (SESSION_ID.test(ref)) {
    const k = known.get(ref.toLowerCase());
    return k === undefined ? { kind: 'none' } : pick([k]);
  }
  const all = [...known.values()];
  if (req.verb === 'attach') {
    if (SHORT_ID.test(ref)) {
      const short = ref.toLowerCase();
      const byShort = all.filter((k) => k.short === short || k.entry?.jobId === short);
      if (byShort.length > 0) return pick(byShort);
    }
    const lower = ref.toLowerCase();
    const names = (k: Known): string[] =>
      [k.entry?.name, ...k.rows.map((r) => r.row.name)]
        .filter((n): n is string => n !== undefined)
        .map((n) => n.toLowerCase().trim());
    const whole = all.filter((k) => names(k).includes(lower));
    if (whole.length > 0) return pick(whole);
    // Claude Code takes part of a name too.
    return pick(all.filter((k) => names(k).some((n) => n.includes(lower))));
  }
  // --resume <name>: Claude Code matches a title among the sessions of the folder it runs in.
  const wanted = ref.toLowerCase();
  const matches: Known[] = [];
  for (const k of all) {
    const cwd = cwdOf(k);
    if (cwd === undefined || !ctx.sameFolder(cwd, ctx.cwd) || !atRisk(k)) continue;
    const title = await ctx.host.sessionTitle(k.sessionId);
    if (title !== undefined && title.toLowerCase().trim() === wanted) matches.push(k);
  }
  return pick(matches);
}

/** How a session is named to the operator: its name and short id, or the short id alone. */
function label(t: Target): string {
  return t.name !== undefined ? `"${t.name}" (${t.short})` : t.short;
}

/** An account and its slot in words: "Alice (the global slot)", or the slot alone. */
function onWhat(v: ConfigView): string {
  return v.account !== undefined ? `${v.account} (${v.slot})` : v.slot;
}

/** Where a session runs right now. */
type Where =
  | { kind: 'interactive'; pid: number; cwd?: string }
  | { kind: 'bg'; configDir: string | null; status?: string; cwd: string }
  | { kind: 'unclear' }
  | { kind: 'nowhere' };

/** How many times to look again when the registry and the rosters disagree for a moment (a session
 *  starting or stopping), and the pause between looks. */
const LOCATE_TRIES = 3;
const LOCATE_PAUSE_MS = 500;

/** Where a session runs: open in a terminal (the registry says so), hosted by exactly one service
 *  (its roster says which), or nowhere. Anything else is unclear, and nothing is run on a guess. */
async function locate(sessionId: string, ctx: RouteContext): Promise<Where> {
  for (let attempt = 1; ; attempt++) {
    const entries = (await ctx.host.liveSessions()).filter((e) => e.sessionId === sessionId);
    const foreground = entries.find((e) => e.kind !== 'bg');
    if (foreground !== undefined) {
      return {
        kind: 'interactive',
        pid: foreground.pid,
        ...(foreground.cwd !== undefined ? { cwd: foreground.cwd } : {}),
      };
    }
    const holders: Array<{ configDir: string | null; cwd: string }> = [];
    for (const configDir of await configDirs(ctx.host)) {
      const hosted = await ctx.host.listHosted(configDir).catch(() => []);
      const s = hosted.find((h) => h.sessionId === sessionId);
      if (s !== undefined) holders.push({ configDir, cwd: s.cwd });
    }
    if (holders.length === 1) {
      const status = entries[0]?.status;
      return { kind: 'bg', ...holders[0]!, ...(status !== undefined ? { status } : {}) };
    }
    // No service hosts it and the registry has no entry: it runs nowhere.
    if (holders.length === 0 && entries.length === 0) return { kind: 'nowhere' };
    // Live in the registry with no service claiming it (one cctl does not know, or a moment
    // between the two files), or claimed by two.
    if (attempt >= LOCATE_TRIES) return { kind: 'unclear' };
    await ctx.timing.sleep(LOCATE_PAUSE_MS);
  }
}

/** Why a session running elsewhere is not moved where it belongs, in words. */
function stayReason(status: string | undefined): string {
  if (status === 'busy') return 'it is in a turn';
  if (status === 'waiting') return 'it is waiting on a prompt';
  return 'it is not idle between turns';
}

/**
 * Decide what `cctl claude` runs for a request that names a background session (see the header).
 * The session's move lock is held while deciding, and handed on in the decision (`hold`) when
 * a terminal is about to open it; otherwise it is released before this returns.
 */
export async function routeBackgroundLaunch(
  req: BackgroundRequest,
  ctx: RouteContext,
  mode: RouteMode,
): Promise<RouteDecision> {
  const found = await resolve(req, ctx);
  if (found.kind === 'none') return PASS;
  if (found.kind === 'ambiguous') {
    const list = found.candidates
      .map(
        (t) =>
          `${req.verb === 'resume' ? t.sessionId : t.short}${t.name !== undefined ? ` "${t.name}"` : ''}`,
      )
      .join(', ');
    return {
      kind: 'refuse',
      message: `"${req.ref}" names more than one background session (${list}); name one by its id.`,
    };
  }
  const target = found.target;
  let lock = await ctx.host.lockSession(target.sessionId, 0);
  if (lock === undefined) {
    ctx.say(`cctl: another cctl process is moving ${label(target)}; waiting for it to finish.`);
    lock = await ctx.host.lockSession(target.sessionId, ctx.lockWaitMs);
  }
  if (lock === undefined) {
    return {
      kind: 'refuse',
      message: `another cctl process is still moving ${label(target)}; try again in a moment.`,
    };
  }
  let decision: RouteDecision | undefined;
  try {
    decision = await decide(req, target, ctx, mode, lock);
    return decision;
  } finally {
    if (decision === undefined || !('hold' in decision) || decision.hold === undefined) {
      lock.release();
    }
  }
}

/** The decision for one found session, under its move lock. `again` is set on the one second look
 *  taken when the session left the service it was found on while being moved. */
async function decide(
  req: BackgroundRequest,
  target: Target,
  ctx: RouteContext,
  mode: RouteMode,
  lock: SessionLock,
  again = false,
): Promise<RouteDecision> {
  const { host, platform } = ctx;
  const where = await locate(target.sessionId, ctx);
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
  const attach = (configDir: string | null): RouteDecision => ({
    kind: 'open',
    configDir,
    args: ['attach', target.short],
    hold: { lock, configDir },
  });

  if (where.kind === 'bg') {
    const home: SessionHome =
      mode.kind === 'fixed'
        ? { configDir: mode.configDir, movable: false }
        : await ctx.homeOf(where.cwd);
    if (sameConfig(where.configDir, home.configDir, platform)) {
      // It runs where this launch runs: the operator's own arguments open it there.
      return mode.kind === 'fixed'
        ? { kind: 'pass', hold: { lock, configDir: where.configDir } }
        : attach(where.configDir);
    }
    // It runs on another config dir's service. Anything run where it belongs would wake that
    // config dir's row and kill it where it runs, so it is either moved first or opened where it runs.
    const runsOn = await ctx.view(where.configDir);
    if (mode.kind === 'fixed') {
      ctx.say(
        `cctl: background session ${label(target)} runs on ${onWhat(runsOn)}; opening it there.`,
      );
      return attach(where.configDir);
    }
    const belongs = await ctx.view(home.configDir);
    let why: string;
    let final = false;
    if (home.unusable !== undefined) {
      why = home.unusable;
    } else if (!home.movable) {
      why =
        home.configDir === null
          ? 'cctl moves background sessions only onto a folder slot'
          : `${belongs.slot} does not hold one of its own accounts with usage left`;
    } else if (where.status !== 'idle') {
      why = stayReason(where.status);
    } else {
      const moved = await moveBackgroundSession(
        host,
        {
          session: { short: target.short, sessionId: target.sessionId, cwd: where.cwd },
          from: { configDir: where.configDir, name: runsOn.slot },
          to: { configDir: home.configDir, name: belongs.slot },
        },
        ctx.timing,
      );
      if (moved.result === 'moved') {
        ctx.say(
          `cctl: moved background session ${label(target)} from ${onWhat(runsOn)} onto ` +
            `${onWhat(belongs)}, the folder's own account. Same session, same conversation.`,
        );
        return attach(home.configDir);
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
            `resume it on ${onWhat(runsOn)}. Resume it there with: claude --bg --resume ` +
            target.sessionId,
        };
      }
      why =
        moved.result === 'not-moved' && moved.cause === 'busy'
          ? stayReason(undefined)
          : moved.reason;
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
        (daemonMoves
          ? ` cctl's daemon moves it onto ${belongs.account ?? belongs.slot} between turns.`
          : '') +
        ' Opening it there.',
    );
    return attach(where.configDir);
  }

  // It runs nowhere. With the slot chosen by the operator, Claude Code opens it as asked.
  if (mode.kind === 'fixed') return PASS;
  const home = await ctx.homeOf(target.cwd);
  const rows = (await host.jobRows(home.configDir)).filter((r) => r.sessionId === target.sessionId);
  const here = rows[0];
  // Started under a config dir, idle, and confirmed there; a refusal says why.
  const wake = async (
    configDir: string | null,
    options?: string[],
  ): Promise<string | undefined> => {
    try {
      await host.resumeIdle({
        configDir,
        sessionId: target.sessionId,
        short: target.short,
        cwd: target.cwd,
        ...(options !== undefined ? { options } : {}),
      });
      if (!(await confirmHosted(host, configDir, target.short, ctx.timing))) {
        return 'it did not show up there';
      }
      return undefined;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };
  const cannotStart = async (configDir: string | null, why: string): Promise<RouteDecision> => ({
    kind: 'refuse',
    message: `could not start ${label(target)} on ${onWhat(await ctx.view(configDir))}: ${why}.`,
  });

  if (req.verb === 'resume') {
    // A foreground resume works, except that a failed row there answers with its stale error.
    if (here?.state !== 'failed') return PASS;
    if (home.unusable !== undefined) return { kind: 'refuse', message: home.unusable };
    const failed = await wake(home.configDir);
    if (failed !== undefined) return cannotStart(home.configDir, failed);
    ctx.say(
      `cctl: background session ${label(target)} had stopped on an error; started it again on ` +
        `${onWhat(await ctx.view(home.configDir))}.`,
    );
    return attach(home.configDir);
  }

  const elsewhere: Array<{ configDir: string | null; row: JobRow }> = [];
  for (const configDir of await configDirs(host)) {
    if (sameConfig(configDir, home.configDir, platform)) continue;
    for (const row of await host.jobRows(configDir)) {
      if (row.sessionId === target.sessionId) elsewhere.push({ configDir, row });
    }
  }
  elsewhere.sort((a, b) => (b.row.updatedAt ?? '').localeCompare(a.row.updatedAt ?? ''));
  // No row anywhere: nothing of cctl's to open, and Claude Code says so itself.
  if (here === undefined && elsewhere.length === 0) return PASS;
  if (home.unusable !== undefined) return { kind: 'refuse', message: home.unusable };
  if (here !== undefined) {
    // Claude Code wakes a stopped row with its own saved options; a failed one only echoes its error.
    if (here.state === 'failed') {
      const failed = await wake(home.configDir);
      if (failed !== undefined) return cannotStart(home.configDir, failed);
    }
    return attach(home.configDir);
  }
  // The slot it belongs to holds no row: start it there with what its latest row saved, on the
  // terms a move carries options over on.
  const latest = elsewhere[0]!;
  const saved = await host.savedOptions(latest.configDir, target.short);
  if (saved.kind === 'replayable') {
    const failed = await wake(home.configDir, saved.options);
    if (failed !== undefined) return cannotStart(home.configDir, failed);
    ctx.say(
      `cctl: started background session ${label(target)} on ` +
        `${onWhat(await ctx.view(home.configDir))}, the slot of the folder it works in.`,
    );
    return attach(home.configDir);
  }
  // It cannot start there without changing: open it where its row is.
  const rowOn = await ctx.view(latest.configDir);
  const why =
    saved.kind === 'unreplayable' ? saved.reason : `its job row on ${rowOn.slot} could not be read`;
  ctx.say(
    `cctl: background session ${label(target)} stays on ${onWhat(rowOn)}: ${why}. Opening it there.`,
  );
  if (latest.row.state === 'failed') {
    const failed = await wake(latest.configDir);
    if (failed !== undefined) return cannotStart(latest.configDir, failed);
  }
  return attach(latest.configDir);
}

/** How long the move lock is kept for a terminal that has not shown up in its attach journal: far
 *  past the few seconds an attach takes, and far short of the lock's staleness. */
const HOLD_CAP_MS = 60_000;
const HOLD_POLL_MS = 250;

/**
 * Run the terminal that opens a session (`run`), keeping the move lock of `hold` until that service's
 * attach journal shows a terminal, the terminal exits, or {@link HOLD_CAP_MS} passes. Until then the
 * daemon could take the session idle and unwatched and move it, and the attach would then wake its
 * row here and kill the moved copy; once the journal shows it, the daemon holds back by itself.
 */
export async function runHolding<T>(
  host: Pick<ClaudeBackgroundHost, 'attachedNow'>,
  hold: AttachHold | undefined,
  run: () => Promise<T>,
  opts: { clock?: () => number; sleep?: (ms: number) => Promise<void>; capMs?: number } = {},
): Promise<T> {
  if (hold === undefined) return run();
  const clock = opts.clock ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = clock() + (opts.capMs ?? HOLD_CAP_MS);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    hold.lock.release();
  };
  const watch = (async (): Promise<void> => {
    while (!released && clock() < deadline) {
      if (await host.attachedNow(hold.configDir).catch(() => false)) break;
      await sleep(HOLD_POLL_MS);
    }
    release();
  })();
  try {
    return await run();
  } finally {
    release();
    await watch;
  }
}
