// Which Claude Code session does this MCP server belong to?
//
// The channel server is spawned once per session by Claude Code itself, and every injection it
// accepts is addressed to a session id. Getting that id wrong does not degrade — it delivers
// one operator's message into somebody else's terminal. So the rule here is: an identity is
// either a CHECKED FACT or it does not exist. There is no "probably".
//
// Two sources, in strict order:
//   1. `CLAUDE_CODE_SESSION_ID` from the spawn environment, VERIFIED against Claude Code's own
//      session registry (`<claudeDir>/sessions/<pid>.json`) AND against the process ancestor
//      chain. The env var alone is a claim; a registry file carrying the same `sessionId` turns
//      it into a fact about SOME session, and the ancestor chain is what turns it into a fact
//      about OURS. (`CLAUDE_SESSION_ID`, without `CODE`, is a different variable and does not
//      exist — do not add it as a fallback.)
//   2. Failing that, the process ancestor chain intersected with the pids in those same registry
//      files. This is the degraded path and it is deliberately kept behind (1): it has to walk
//      the WHOLE chain to answer "was this ambiguous", whereas (1) stops at the first ancestor
//      that is a registered session — normally `process.ppid`, which Node hands over for free.
//
// WHY (1) STILL WALKS: Claude Code exports `CLAUDE_CODE_SESSION_ID` into the subprocesses its
// Bash tool spawns, so a `claude` launched from inside a session INHERITS the outer session's
// id. Its channel server would read that inherited id, find the outer session's registry file,
// confirm it, and attach as the outer session — after which every message the operator sends to
// the outer session is written into the INNER session's terminal, in a different repo. A
// confirmed env var proves the id names a real session; only the process tree proves it names
// THIS one, so both must agree before anything is attached.
//
// THE AMBIGUITY HAZARD (measured, not theoretical): the ancestor intersection can match MORE
// THAN ONE session, because a Claude Code session that spawns another Claude Code session is an
// ancestor of the inner one's MCP servers too. Both are live, both have registry files, both are
// on the chain. The nearest ancestor is the owning session — but the caller is told the
// resolution was ambiguous so the daemon can record it rather than have it vanish.
//
// THE CONTRADICTION RULE, and it runs in BOTH directions. If `CLAUDE_CODE_SESSION_ID` is set but
// the registry does not confirm it, the ancestor walk is NOT allowed to answer instead: the env
// var is always present and always correct, so a miss means the registry was momentarily
// incomplete — a torn write we skipped, or the file not yet created — which is precisely when the
// process tree is least trustworthy. The concrete failure: session A spawns session B through a
// Bash tool; B's registry file is torn for one read; B's walk climbs past its own missing entry to
// A and attaches as A, and every message for A lands in B's terminal in the wrong repo. So the
// registry is re-read a couple of times first, and an ancestry answer that disagrees with the env
// var is a refusal. The mirror image is the inherited-env case above: a CONFIRMED env var whose
// nearest live registered ancestor is a different session is refused too. Two identity sources
// that contradict each other are not a resolution, whichever of them happens to be checkable.
//
// A confirmation is not the end of that transient window, only of half of it. A RESUMED session
// leaves its previous pid's file behind carrying the same session id, so the id confirms on the
// first read against a file describing a process we are not descended from, while the file for
// the pid that IS our ancestor has not been written yet. A confirmed id with no registered
// ancestor therefore spends the rest of the same read budget before it refuses — a contradiction
// is a refusal, but an incomplete registry is not a contradiction.
//
// Anything that is not a checked outcome is a refusal with a reason, never a guess. In particular
// an EMPTY ancestor chain resolves to nothing at all: "we could not see the process tree" is not
// evidence for "it must be the only session running", and it is not evidence that an inherited
// env var is ours either — an unreadable tree refuses rather than falling back to the env var
// alone, because the one thing the fast path cannot do is tell the two cases apart. The cost of
// that refusal is this session's channel (the daemon still reaches it at its next turn boundary,
// and the reason is printed); the cost of guessing is delivery into the wrong terminal.

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

/** One entry of Claude Code's own session registry, `<claudeDir>/sessions/<pid>.json`. Only the
 *  fields this server needs are modelled; the file carries more (status, version, timings) and
 *  is owned by Claude Code, so unknown fields are ignored rather than validated. */
export interface SessionRegistryEntry {
  /** OS pid of the `claude` process that owns the session — the join key for the ancestor walk. */
  pid: number;
  /** The session uuid, identical to what hooks and `CLAUDE_CODE_SESSION_ID` report. */
  sessionId: string;
  /** The session's working directory; the daemon labels the attachment with it. */
  cwd: string;
  /** Operator-assigned session name, absent until one is set. */
  name?: string | undefined;
  /** Claude Code's own anti-pid-reuse stamp: when the process behind {@link pid} started.
   *  Opaque and PLATFORM-SPECIFIC — observed on win32 as a FILETIME string ("100-ns intervals
   *  since 1601"), unverified elsewhere — so it is carried, not parsed. See
   *  {@link registryEntryIsLive} for what it would take to actually compare it. */
  procStart?: string | undefined;
  /** Which pid namespace {@link pid} belongs to, observed as `<platform>:<hostname>` (e.g.
   *  `win32:desktop-1d1ptag`). A pid is only meaningful inside its own namespace: a WSL pid and
   *  a Windows pid of the same number name unrelated processes, and one `CLAUDE_CONFIG_DIR`
   *  shared across that boundary puts both kinds of file in the same directory. */
  pidDomain?: string | undefined;
}

/** A session identity that was established from evidence. */
export interface ResolvedIdentity {
  ok: true;
  sessionId: string;
  /** `'env'` = a verified `CLAUDE_CODE_SESSION_ID`. `'ancestry'` = the degraded process-tree
   *  match. The daemon is told which, because they are not equally trustworthy. */
  source: 'env' | 'ancestry';
  pid: number;
  cwd: string;
  name?: string | undefined;
  /** True only when the ancestor walk matched several live sessions and the nearest one was
   *  taken. Never true for `'env'`, which matches exactly one registry entry by construction. */
  ambiguous: boolean;
}

/** No identity could be established. The reason is operator-facing: it is printed to stderr,
 *  which Claude Code captures into `~/.claude/debug/<session-id>.txt`. */
export interface UnresolvedIdentity {
  ok: false;
  reason: string;
}

export type IdentityResult = ResolvedIdentity | UnresolvedIdentity;

/** Look up a process's parent. Separated from the walk so the platform-specific half is one
 *  injectable function and the traversal logic is testable without real processes. Returns
 *  `undefined` for "unknown / no parent / lookup failed" — all three end the walk identically. */
export type ParentOf = (pid: number) => Promise<number | undefined>;

/** Depth bound on the ancestor walk. Deep enough for any realistic shell → editor → claude →
 *  claude → mcp nesting, shallow enough that a pathological or mis-reported tree costs a fixed
 *  amount of work instead of an unbounded number of subprocess calls. */
export const MAX_ANCESTOR_HOPS = 24;

/** Wall-clock bound on the WHOLE walk, independent of the per-lookup timeout. The POSIX path
 *  spends one `ps` per hop, so a hop bound alone permits 24 sequential lookups; this is what
 *  stops a slow machine from turning the fallback into a multi-minute stall. */
export const MAX_ANCESTOR_WALK_MS = 45_000;

/** How many times the registry may be read while `CLAUDE_CODE_SESSION_ID` is set, across BOTH
 *  things that read it: confirming the declared id, and finding the ancestor that proves the id
 *  is ours. One budget rather than one each, because what it bounds is the total time a session
 *  waits to be identified. The misses it recovers are transient by nature — a torn write, a file
 *  not yet created at startup, a resumed session whose new pid file lands a moment after its old
 *  one — so a couple of re-reads a moment apart is the whole fix. */
export const REGISTRY_READ_ATTEMPTS = 3;
/** Gap between those re-reads. Long enough for the owning session to finish rewriting its file,
 *  short enough that the worst case stays far under the MCP handshake's patience. */
export const REGISTRY_RETRY_DELAY_MS = 120;

export interface IdentityDeps {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Claude Code's session registry directory. Defaults to `<claudeDir>/sessions`, where
   *  `claudeDir` honours `CLAUDE_CONFIG_DIR` exactly as the rest of the workspace does. */
  sessionsDir?: string;
  /** This process's own pid — the bottom of the walk, excluded from matching. */
  pid?: number;
  /** This process's immediate parent. Node hands it over for free, so hop 1 never costs a
   *  process-table query; only hop 2 and beyond reach for {@link ParentOf}. */
  parentPid?: number | undefined;
  /** Hops above the first. Defaults to this platform's real implementation, whose expensive part
   *  is deferred until a hop actually asks for it — the verified-env path skips it entirely only
   *  when the session's own process is this one's direct parent (see {@link createParentOf}). */
  parentOf?: ParentOf;
  /** Is this pid still running? Defaults to a signal-0 probe. Injected by tests so the
   *  liveness rule can be exercised without real processes. */
  isLive?: (pid: number) => boolean;
  /** Delay between registry re-reads; injectable so tests do not pay for them. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the walk deadline. */
  now?: () => number;
}

/**
 * Is a pid still running? `signal 0` performs the permission and existence checks without
 * delivering anything — the same probe `daemonInstanceLock` and switch-engine's `lock` use.
 *
 * ESRCH ("no such process") is the ONLY code that means gone. EPERM means the process EXISTS and
 * belongs to another user, which is very much alive, and Windows raises it routinely; anything
 * else (EINVAL, an unmapped errno) is an unknown probe outcome, and reading "unknown" as "dead"
 * would reject live sessions. This is deliberately the SAME rule the daemon's own `pidIsAlive`
 * applies to the pid this module hands it: the two probe the same process for the same reason,
 * and a session one of them calls dead while the other calls it live is a state neither side can
 * reason about.
 */
export function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** Platform tokens {@link SessionRegistryEntry.pidDomain} has been observed prefixed with. A
 *  domain whose prefix is not one of these is a spelling this module does not understand, and an
 *  unrecognised spelling must NOT reject the entry: the format is Claude Code's, observed rather
 *  than specified, so failing closed on a future rename would silently disable every channel on
 *  the machine. */
const KNOWN_PID_DOMAIN_PLATFORMS = new Set<string>([
  'aix',
  'android',
  'cygwin',
  'darwin',
  'freebsd',
  'haiku',
  'linux',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
]);

/**
 * Can this registry entry's pid be treated as a live session of OURS?
 *
 * Two questions, cheapest first, and both have to answer yes:
 *
 * 1. Is the pid even in our namespace? `pidDomain` is Claude Code's own answer to that, and it
 *    costs nothing to read. A pid from another platform cannot be probed with `process.kill` at
 *    all — the call would be asking about an unrelated local process that happens to share the
 *    number — so an entry stamped for a platform that is not ours is not live HERE, whatever
 *    `process.kill` would say. Absent or unrecognised domains fail OPEN (see
 *    {@link KNOWN_PID_DOMAIN_PLATFORMS}).
 * 2. Does the pid exist? {@link pidIsLive}.
 *
 * WHAT IS DELIBERATELY NOT CHECKED: `procStart`. It is the field that would close the remaining
 * hole — an OS that recycled the pid onto an unrelated process answers (2) with a false yes — but
 * comparing it needs the process's real start time, and there is no cheap portable way to get
 * that here. Every platform helper below answers "who is this pid's parent", not "when did it
 * start", and the only general Windows answer is another whole-process-table CIM query, i.e. the
 * per-probe subprocess this module is built to avoid; the stored value is also encoded per
 * platform (a FILETIME string on win32, unverified elsewhere) so a comparison written against one
 * platform's spelling would silently misjudge the others. The check belongs exactly here, keyed
 * off `entry.procStart`, the day a parent lookup can return a start time in the same call.
 */
function registryEntryIsLive(
  entry: SessionRegistryEntry,
  isLive: (pid: number) => boolean,
  platform: NodeJS.Platform,
): boolean {
  const domainPlatform = entry.pidDomain?.split(':')[0];
  if (
    domainPlatform !== undefined &&
    KNOWN_PID_DOMAIN_PLATFORMS.has(domainPlatform) &&
    domainPlatform !== platform
  ) {
    return false;
  }
  return isLive(entry.pid);
}

/**
 * Read every parsable session registry file. Unreadable, half-written, or foreign files are
 * skipped rather than fatal: the directory is owned by Claude Code, a session can exit while we
 * are reading it, and one bad file must not cost us the identity that the file next to it holds.
 */
export async function readSessionRegistry(sessionsDir: string): Promise<SessionRegistryEntry[]> {
  let names: string[];
  try {
    names = await readdir(sessionsDir);
  } catch {
    return []; // Claude Code has never run here, or the config dir points somewhere else
  }
  const entries: SessionRegistryEntry[] = [];
  await Promise.all(
    names
      .filter((name) => name.endsWith('.json'))
      .map(async (name) => {
        let raw: string;
        try {
          raw = await readFile(join(sessionsDir, name), 'utf8');
        } catch {
          return; // the session exited between readdir and read
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          return; // torn write; the owner rewrites it continuously
        }
        const entry = toRegistryEntry(parsed);
        if (entry !== undefined) entries.push(entry);
      }),
  );
  // Sorted because the reads above complete in arbitrary order, and callers pick with `find`.
  // Two files can legitimately carry the same sessionId (a resumed session leaving its old pid
  // file behind), and "whichever read finished first wins" is a coin flip between the live
  // session and a dead one. Ascending pid is arbitrary but STABLE, which is the property needed.
  entries.sort((a, b) => a.pid - b.pid);
  return entries;
}

/** Narrow one parsed registry file to the fields we join on, or reject it. A record missing a
 *  pid or a sessionId cannot participate in either resolution path, so it is not an entry.
 *
 *  `procStart` and `pidDomain` are Claude Code's own anti-pid-reuse data and are kept verbatim
 *  rather than dropped: a narrowing that discards the evidence guarantees nothing downstream can
 *  ever use it, and the pid probe below is exactly the place that wants it. */
function toRegistryEntry(value: unknown): SessionRegistryEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { pid, sessionId, cwd, name, procStart, pidDomain } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  return {
    pid,
    sessionId,
    cwd: typeof cwd === 'string' ? cwd : '',
    name: typeof name === 'string' && name.length > 0 ? name : undefined,
    procStart: typeof procStart === 'string' && procStart.length > 0 ? procStart : undefined,
    pidDomain: typeof pidDomain === 'string' && pidDomain.length > 0 ? pidDomain : undefined,
  };
}

/**
 * Establish this server's session identity, or refuse with a reason.
 *
 * Both branches end at the same question — which live registered session is the nearest one above
 * this process — and differ only in what they do with the answer. The environment branch already
 * knows which id it expects, so it stops walking the moment it finds ANY registered ancestor
 * (normally `process.ppid`, free); the fallback branch has to walk the whole chain, because
 * "were there several" is part of its answer.
 *
 * Every disagreement is a refusal, in both directions: an unconfirmed `CLAUDE_CODE_SESSION_ID` is
 * retried and then refused if ancestry names a different session, and a CONFIRMED one is refused
 * if the process tree names a different session. See the contradiction rule in this module's
 * header — an id two sources disagree about is not an identity, whichever source is checkable.
 */
export async function resolveIdentity(deps: IdentityDeps = {}): Promise<IdentityResult> {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const sleep = deps.sleep ?? ((ms: number) => delay(ms));
  const isLive = deps.isLive ?? pidIsLive;
  const sessionsDir = deps.sessionsDir ?? (await defaultSessionsDir(env, platform));
  const declared = env.CLAUDE_CODE_SESSION_ID?.trim();
  const hasDeclared = declared !== undefined && declared.length > 0;

  // Only the declared-but-unconfirmed case is worth re-reading for: with no env var there is
  // nothing a second scan could confirm, so the fallback path pays nothing for this.
  const attempts = hasDeclared ? REGISTRY_READ_ATTEMPTS : 1;
  let entries: SessionRegistryEntry[] = [];
  let confirmed = false;
  // How many of `attempts` this loop spent. The cross-check below can need re-reads of its own
  // for the same transient reason, and they come out of the same budget rather than a second one:
  // the point of the bound is the total time a session may wait to be identified.
  let reads = 0;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    reads = attempt;
    entries = await readSessionRegistry(sessionsDir);
    // A single registry file carrying the declared id is all this loop is waiting for; WHICH of
    // several duplicates to attach to is decided by the ancestor walk below, which knows which
    // pid is actually ours rather than guessing from liveness alone.
    if (hasDeclared && entries.some((entry) => entry.sessionId === declared)) {
      confirmed = true;
      break;
    }
    if (attempt < attempts) await sleep(REGISTRY_RETRY_DELAY_MS);
  }

  if (entries.length === 0) {
    return {
      ok: false,
      reason: `no readable Claude Code session registry files under ${sessionsDir}`,
    };
  }

  const self = deps.pid ?? process.pid;
  // `in` rather than `??`: an explicitly-supplied `undefined` means "this process has no visible
  // parent", which is a case that must be representable — `??` would silently substitute the
  // real `process.ppid` and turn a test of the refusal path into a live process-table query.
  const parentPid = 'parentPid' in deps ? deps.parentPid : process.ppid;
  const parentOf = deps.parentOf ?? createParentOf(platform);
  const now = deps.now ?? Date.now;
  // `let`, because the cross-check below re-reads the registry when it comes up empty and
  // `sessionAt` has to see the new entries. Rebuilding the map is the whole of that update.
  let byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  /** The live registered session owning `pid`, if that pid is one. */
  const sessionAt = (pid: number): SessionRegistryEntry | undefined => {
    const entry = byPid.get(pid);
    return entry !== undefined && registryEntryIsLive(entry, isLive, platform) ? entry : undefined;
  };

  if (confirmed) {
    // Stop at the first registered ancestor: the env var already names the session we expect, so
    // the only open question is whether the nearest one above us IS that session. In the ordinary
    // case that ancestor is `process.ppid` — the `claude` process that spawned this server — and
    // the walk costs nothing beyond a map lookup.
    const chain = await ancestorChain(
      self,
      parentPid,
      parentOf,
      now,
      (pid) => sessionAt(pid) !== undefined,
    );
    let owner = chain.map(sessionAt).find((entry) => entry !== undefined);
    // A confirmation is not the end of the transient window, only the end of one half of it. A
    // RESUMED session leaves its previous pid's file behind carrying the same session id, so the
    // loop above stops on the first read — satisfied by a file that describes a process we are
    // not descended from — while the file for the pid that IS our ancestor has not been written
    // yet. Refusing here would make a resume cost the session its channel for good, every time.
    //
    // Only the registry is re-read, never the tree: `stopAt` cannot have fired if nothing on the
    // chain was a registered session, so `chain` is already the COMPLETE ancestor list and
    // re-walking it would repeat the expensive half (see {@link createParentOf}) to obtain the
    // identical pids. What can still change is which of them the registry knows about — so an
    // EMPTY chain, which no re-read can populate, is refused at once instead of after the budget.
    for (
      let attempt = reads;
      owner === undefined && chain.length > 0 && attempt < attempts;
      attempt += 1
    ) {
      await sleep(REGISTRY_RETRY_DELAY_MS);
      entries = await readSessionRegistry(sessionsDir);
      byPid = new Map(entries.map((entry) => [entry.pid, entry]));
      owner = chain.map(sessionAt).find((entry) => entry !== undefined);
    }
    if (owner === undefined) {
      // The env var names a real session, but nothing above this process is one, so there is no
      // evidence it is OUR session rather than one we inherited the variable from. Refusing costs
      // this session its channel; guessing costs a different session's operator their privacy.
      return {
        ok: false,
        reason:
          `CLAUDE_CODE_SESSION_ID=${declared} names a session in ${sessionsDir}, but no ancestor of ` +
          `pid ${self} is a live Claude Code session (walked ${chain.length} hop(s)) - refusing ` +
          `rather than attaching to a session this process cannot be shown to belong to (` +
          `${unreadableTreeHint(platform)})`,
      };
    }
    if (owner.sessionId !== declared) {
      // The inherited-environment case, measured: Claude Code exports CLAUDE_CODE_SESSION_ID into
      // Bash-tool subprocesses, so a nested `claude` reads its parent's id. Attaching here is how
      // the outer session's messages end up in the inner session's terminal.
      return {
        ok: false,
        reason:
          `CLAUDE_CODE_SESSION_ID=${declared} is inherited, not ours: the nearest live Claude Code ` +
          `session above pid ${self} is ${owner.sessionId} (pid ${owner.pid}) - refusing rather ` +
          'than attaching to a session the process tree contradicts',
      };
    }
    return {
      ok: true,
      sessionId: owner.sessionId,
      source: 'env',
      // From the ANCESTOR entry, not merely from whichever file carried the id: a resumed session
      // can leave its previous pid's file behind, and the ancestor is the copy that is really ours.
      pid: owner.pid,
      cwd: owner.cwd,
      name: owner.name,
      // Two sources agreed on one session; there is nothing ambiguous left to report.
      ambiguous: false,
    };
  }

  const chain = await ancestorChain(self, parentPid, parentOf, now);
  if (chain.length === 0) {
    // An unreadable process tree is an absence of evidence, not evidence that the only live
    // session is ours. Refuse.
    const hint = ` (${unreadableTreeHint(platform)})`;
    return {
      ok: false,
      reason: hasDeclared
        ? `CLAUDE_CODE_SESSION_ID=${declared} matches no session in ${sessionsDir}, and this process has no visible ancestors${hint}`
        : `no CLAUDE_CODE_SESSION_ID and this process has no visible ancestors${hint}`,
    };
  }

  // `chain` is ordered nearest-first, so the first hit is the nearest ancestor by construction.
  // Entries whose process is gone are skipped: a registry file outlives its session, so without
  // this the walk can resolve to a dead session and the refusal below would be a lie.
  const matches = chain
    .map(sessionAt)
    .filter((entry): entry is SessionRegistryEntry => entry !== undefined);
  const nearest = matches[0];
  if (nearest === undefined) {
    return {
      ok: false,
      reason: `no ancestor of pid ${self} is a live Claude Code session (walked ${chain.length} hop(s))`,
    };
  }
  if (hasDeclared && nearest.sessionId !== declared) {
    // The contradiction rule. Attaching as `nearest` here is how a nested session steals its
    // parent's channel; refusing costs this session its channel and nothing else, and the daemon
    // still reaches it through the turn-boundary fallback.
    return {
      ok: false,
      reason:
        `CLAUDE_CODE_SESSION_ID=${declared} is not in ${sessionsDir}, but the process tree points at ` +
        `session ${nearest.sessionId} (pid ${nearest.pid}) - refusing rather than attaching to a ` +
        'session the environment contradicts',
    };
  }
  return {
    ok: true,
    sessionId: nearest.sessionId,
    source: 'ancestry',
    pid: nearest.pid,
    cwd: nearest.cwd,
    name: nearest.name,
    // A nested session is an ancestor of the inner session's MCP servers, so >1 match is a real
    // and observed shape. The nearest wins, but the caller is told the tree was not unambiguous.
    ambiguous: matches.length > 1,
  };
}

/** Walk from `firstParent` upward, nearest-first, excluding `self`. Stops at the process tree's
 *  root (pid 0 / no parent), at {@link MAX_ANCESTOR_HOPS}, on {@link MAX_ANCESTOR_WALK_MS}, on a
 *  repeat — pids are recycled by the OS, so a reported cycle is possible and must terminate
 *  rather than spin — or on `stopAt`, which a caller that is looking for ONE particular kind of
 *  ancestor supplies so the walk ends the moment it has been found. The wall-clock bound exists
 *  because the hop bound alone is not one: on POSIX every hop is its own `ps`, so 24 slow hops
 *  multiply into a stall no single per-lookup timeout would catch. A truncated chain is a shorter
 *  chain, never a wrong answer — which is also what makes `stopAt` safe: it can only remove
 *  ancestors FURTHER away than the one the caller already has. */
async function ancestorChain(
  self: number,
  firstParent: number | undefined,
  parentOf: ParentOf,
  now: () => number,
  stopAt?: (pid: number) => boolean,
): Promise<number[]> {
  const deadline = now() + MAX_ANCESTOR_WALK_MS;
  const chain: number[] = [];
  const seen = new Set<number>([self]);
  let current = firstParent;
  while (
    current !== undefined &&
    Number.isInteger(current) &&
    current > 0 &&
    !seen.has(current) &&
    chain.length < MAX_ANCESTOR_HOPS
  ) {
    chain.push(current);
    seen.add(current);
    // Tested AFTER the push, so the pid that satisfied the caller is part of the chain it gets.
    if (stopAt?.(current) === true) break;
    if (now() >= deadline) break;
    current = await parentOf(current);
  }
  return chain;
}

/** `<claudeDir>/sessions`, honouring `CLAUDE_CONFIG_DIR`.
 *
 *  switch-engine's `defaultPaths` is the workspace's single authority on that precedence, so it
 *  is reused rather than re-derived — but imported DYNAMICALLY. Its barrel pulls the vault, OAuth
 *  refresh, Keychain and DPAPI along with it, and this process's module graph sits in front of
 *  the MCP handshake. Identity resolution already runs after the transport is answering, so the
 *  cost lands where nothing is waiting on it. */
async function defaultSessionsDir(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Promise<string> {
  const { defaultPaths } = await import('@claude-control/switch-engine');
  return join(defaultPaths(env, platform).claudeDir, 'sessions');
}

/**
 * This platform's parent lookup.
 *
 * Reachable from BOTH resolution paths, which is not what the fast path's shape suggests. The
 * verified-`CLAUDE_CODE_SESSION_ID` path stops at the first registered ancestor, and when that is
 * `process.ppid` Node has already handed it over — no lookup at all. But that only holds while
 * the session's `claude` process is this server's DIRECT parent. Put any wrapper in between and
 * hop 2 lands here: on Windows the plugin's `cctl` is a `.cmd` shim, so the real tree is
 * `claude -> cmd.exe -> node` and the cross-check reaches for a lookup every time.
 *
 * The cost of that hop on Windows is one `Get-CimInstance Win32_Process` query over the whole
 * process table — around 0.8s on an idle box, and several seconds on a loaded one (see
 * {@link PARENT_LOOKUP_TIMEOUT_MS}, whose bound has to cover that whole spread). It is why the
 * query is memoised for the life of the walk — a deep chain costs the same as a shallow one, and
 * a registry retry re-uses the table rather than paying again — and why nothing constructs it
 * during startup: identity resolution runs after the MCP handshake has been answered, so the
 * seconds land where no client is waiting on them.
 */
export function createParentOf(platform: NodeJS.Platform = process.platform): ParentOf {
  if (platform === 'linux') return linuxParentOf;
  if (platform === 'win32') return createWindowsParentOf();
  return posixParentOf;
}

/**
 * What to check when a refusal may have been caused by an unreadable process tree.
 *
 * {@link ParentOf} collapses "this is the top of the tree", "the process is gone" and "the lookup
 * failed" into the same `undefined`, and the walk cannot tell them apart — so a refusal that
 * blames the tree cannot honestly say WHY it could not read it. What it can do is name the helper
 * this platform depends on, which turns a dead end into something the operator can check: the
 * refusal is printed to stderr and captured into Claude Code's own debug log, where it is the
 * only thing they will have to go on.
 */
function unreadableTreeHint(platform: NodeJS.Platform): string {
  if (platform === 'win32') {
    return 'if the process tree could not be read, check that powershell.exe is on PATH and can run Get-CimInstance Win32_Process';
  }
  if (platform === 'linux') {
    return 'if the process tree could not be read, check that /proc is mounted and readable';
  }
  return "if the process tree could not be read, check that 'ps' is on PATH";
}

/** Linux (and WSL2): procfs, no subprocess at all. `stat` field 4 is the ppid, but field 2 is
 *  the executable name in parentheses and may itself contain spaces or parentheses — so the
 *  parse starts after the LAST `)`, which is the only unambiguous anchor. */
async function linuxParentOf(pid: number): Promise<number | undefined> {
  let raw: string;
  try {
    raw = await readFile(`/proc/${pid}/stat`, 'utf8');
  } catch {
    return undefined; // process gone, or not really Linux
  }
  const afterComm = raw
    .slice(raw.lastIndexOf(')') + 1)
    .trim()
    .split(/\s+/);
  // Fields after the comm are: state, ppid, ...
  return toPid(afterComm[1]);
}

/** macOS and the BSDs: no procfs, so `ps` is the portable answer. One short-lived process per
 *  hop, bounded by a timeout so a wedged `ps` cannot hold the walk open. */
async function posixParentOf(pid: number): Promise<number | undefined> {
  const out = await run('ps', ['-o', 'ppid=', '-p', String(pid)]);
  return out === undefined ? undefined : toPid(out.trim());
}

/** Windows: one CIM query for the entire process table, memoised for the life of the walk.
 *  Per-pid querying would multiply an already expensive call by the chain depth. */
function createWindowsParentOf(): ParentOf {
  let table: Promise<Map<number, number>> | undefined;
  return async (pid: number) => (await (table ??= windowsProcessTable())).get(pid);
}

async function windowsProcessTable(): Promise<Map<number, number>> {
  const out = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress',
  ]);
  return out === undefined ? new Map() : parseWindowsProcessTable(out);
}

/**
 * Turn the CIM query's JSON into a pid→ppid map. Separated from the subprocess so the parsing —
 * the part that can be wrong rather than merely slow — is testable without spawning PowerShell,
 * which on a loaded machine takes tens of seconds and makes an otherwise sound test load-flaky.
 *
 * Tolerant by construction: anything unparsable yields an empty (or partial) table, which the
 * walk reads as "unknown parent" and stops on. A wrong answer would be far worse than a short one.
 */
export function parseWindowsProcessTable(json: string): Map<number, number> {
  const table = new Map<number, number>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return table;
  }
  // `ConvertTo-Json` serialises a single row as a bare object rather than a one-element array.
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    if (row === null || typeof row !== 'object') continue;
    const { ProcessId, ParentProcessId } = row as Record<string, unknown>;
    const child = toPid(ProcessId);
    const parent = toPid(ParentProcessId);
    if (child !== undefined && parent !== undefined) table.set(child, parent);
  }
  return table;
}

/** Timeout so no branch of the fallback can hang the server indefinitely; a lookup that does not
 *  answer in time is simply "unknown parent", which ends the walk the same way a root does.
 *
 *  Deliberately generous. Nothing is blocked on this — the MCP handshake is long since answered
 *  and the daemon attach is a background loop that backs off anyway — whereas timing out early
 *  means the session is never identified and the channel never attaches at all. The Windows CIM
 *  query is the expensive one, and its spread is what the bound has to cover rather than its
 *  typical cost: under a second on an idle box, several seconds and more on a loaded one. A
 *  tighter bound buys nothing and loses the identity. */
const PARENT_LOOKUP_TIMEOUT_MS = 30_000;

/** Run a helper and return its stdout, or `undefined` for any failure. Async on purpose: the
 *  contract forbids synchronous subprocess work anywhere in this server. */
function run(command: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      command,
      args,
      { timeout: PARENT_LOOKUP_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (err, stdout) => resolve(err ? undefined : stdout),
    );
  });
}

/** Accept the several shapes a pid arrives in (JSON number, `ps` text) and reject everything
 *  that is not a usable pid, including 0 — the tree root, which must end a walk, not extend it. */
function toPid(value: unknown): number | undefined {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string') n = Number(value.trim());
  else return undefined;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}
