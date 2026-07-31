// Which Claude Code session does this MCP server belong to?
//
// The channel server is spawned once per session by Claude Code itself, and every injection it
// accepts is addressed to a session id. Getting that id wrong does not degrade — it delivers
// one operator's message into somebody else's terminal. So the rule here is: an identity is
// either a CHECKED FACT or it does not exist. There is no "probably".
//
// Two sources, in strict order:
//   1. `CLAUDE_CODE_SESSION_ID` from the spawn environment, VERIFIED against Claude Code's own
//      session registry (`<claudeDir>/sessions/<pid>.json`). The env var alone is a claim; a
//      registry file carrying the same `sessionId` is what turns it into a fact, and it is also
//      where the pid/cwd/name the daemon wants come from. (`CLAUDE_SESSION_ID`, without `CODE`,
//      is a different variable and does not exist — do not add it as a fallback.)
//   2. Failing that, the process ancestor chain intersected with the pids in those same registry
//      files. This is the degraded path and it is deliberately kept behind (1): resolving a
//      parent chain costs a subprocess on every platform except Linux, and the MCP handshake is
//      waiting on this module.
//
// THE AMBIGUITY HAZARD (measured, not theoretical): the ancestor intersection can match MORE
// THAN ONE session, because a Claude Code session that spawns another Claude Code session is an
// ancestor of the inner one's MCP servers too. Both are live, both have registry files, both are
// on the chain. The nearest ancestor is the owning session — but the caller is told the
// resolution was ambiguous so the daemon can record it rather than have it vanish.
//
// THE CONTRADICTION RULE: if `CLAUDE_CODE_SESSION_ID` is set but the registry does not confirm
// it, the ancestor walk is NOT allowed to answer instead. The env var is always present and
// always correct, so a miss means the registry was momentarily incomplete — a torn write we
// skipped, or the file not yet created — which is precisely when the process tree is least
// trustworthy. The concrete failure: session A spawns session B through a Bash tool; B's registry
// file is torn for one read; B's walk climbs past its own missing entry to A and attaches as A,
// and every message for A lands in B's terminal in the wrong repo. So the registry is re-read a
// couple of times first, and an ancestry answer that disagrees with the env var is a refusal.
// Two identity sources that contradict each other are not a resolution.
//
// Anything that is not a checked outcome is a refusal with a reason, never a guess. In particular
// an EMPTY ancestor chain resolves to nothing at all: "we could not see the process tree" is not
// evidence for "it must be the only session running".

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

/** How many times the registry is read when `CLAUDE_CODE_SESSION_ID` is set but unconfirmed.
 *  The misses this recovers are transient by nature — a torn write, or the file not yet created
 *  during startup — so a couple of re-reads a moment apart is the whole fix. */
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
  /** Hops above the first. Defaults to this platform's real implementation, which is built
   *  lazily so the verified-env path never constructs it. */
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
 * EPERM means the process EXISTS and belongs to another user, which is very much alive; only
 * ESRCH means gone. Getting that backwards would reject live sessions on a shared machine.
 */
export function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
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
 *  pid or a sessionId cannot participate in either resolution path, so it is not an entry. */
function toRegistryEntry(value: unknown): SessionRegistryEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const { pid, sessionId, cwd, name } = record;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return undefined;
  if (typeof sessionId !== 'string' || sessionId.length === 0) return undefined;
  return {
    pid,
    sessionId,
    cwd: typeof cwd === 'string' ? cwd : '',
    name: typeof name === 'string' && name.length > 0 ? name : undefined,
  };
}

/**
 * Establish this server's session identity, or refuse with a reason.
 *
 * The environment branch does one directory scan and no process work at all; the ancestor walk is
 * only constructed if that branch produces nothing, which is what keeps the MCP handshake off the
 * expensive path.
 *
 * An unconfirmed `CLAUDE_CODE_SESSION_ID` is retried before anything else is tried, and if
 * ancestry then names a DIFFERENT session the whole resolution is refused — see the contradiction
 * rule in this module's header. The env var is not "one opinion among two"; it is the ground
 * truth, and disagreement means the evidence is bad, not that the other source wins.
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
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    entries = await readSessionRegistry(sessionsDir);
    if (hasDeclared) {
      // Among duplicate sessionIds prefer the one whose process still exists; a resumed session
      // can leave its previous pid's file behind, and that file's pid is the wrong attach target.
      const candidates = entries.filter((entry) => entry.sessionId === declared);
      const match = candidates.find((entry) => isLive(entry.pid)) ?? candidates[0];
      if (match !== undefined) {
        return {
          ok: true,
          sessionId: match.sessionId,
          source: 'env',
          pid: match.pid,
          cwd: match.cwd,
          name: match.name,
          ambiguous: false,
        };
      }
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
  const chain = await ancestorChain(
    self,
    parentPid,
    deps.parentOf ?? createParentOf(platform),
    deps.now ?? Date.now,
  );
  if (chain.length === 0) {
    // An unreadable process tree is an absence of evidence, not evidence that the only live
    // session is ours. Refuse.
    return {
      ok: false,
      reason: hasDeclared
        ? `CLAUDE_CODE_SESSION_ID=${declared} matches no session in ${sessionsDir}, and this process has no visible ancestors`
        : 'no CLAUDE_CODE_SESSION_ID and this process has no visible ancestors',
    };
  }

  const byPid = new Map(entries.map((entry) => [entry.pid, entry]));
  // `chain` is ordered nearest-first, so the first hit is the nearest ancestor by construction.
  // Entries whose process is gone are skipped: a registry file outlives its session, so without
  // this the walk can resolve to a dead session and the refusal below would be a lie.
  const matches = chain
    .map((pid) => byPid.get(pid))
    .filter((entry): entry is SessionRegistryEntry => entry !== undefined && isLive(entry.pid));
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
 *  root (pid 0 / no parent), at {@link MAX_ANCESTOR_HOPS}, on {@link MAX_ANCESTOR_WALK_MS}, or on
 *  a repeat — pids are recycled by the OS, so a reported cycle is possible and must terminate
 *  rather than spin. The wall-clock bound exists because the hop bound alone is not one: on
 *  POSIX every hop is its own `ps`, so 24 slow hops multiply into a stall no single per-lookup
 *  timeout would catch. A truncated chain is a shorter chain, never a wrong answer. */
async function ancestorChain(
  self: number,
  firstParent: number | undefined,
  parentOf: ParentOf,
  now: () => number,
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
 * NONE of this is reachable from the verified-`CLAUDE_CODE_SESSION_ID` path — see this module's
 * header. That matters most on Windows, where the only general answer is a CIM process query
 * costing on the order of a second; running it in front of the MCP handshake would stall the
 * session, so it runs once, lazily, and only when the environment failed to identify us. The
 * whole pid→ppid table is fetched in that single query and memoised, so a deep chain costs the
 * same as a shallow one.
 */
export function createParentOf(platform: NodeJS.Platform = process.platform): ParentOf {
  if (platform === 'linux') return linuxParentOf;
  if (platform === 'win32') return createWindowsParentOf();
  return posixParentOf;
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
 *  means the session is never identified and the channel never attaches at all. Measured at ~4s
 *  for the Windows CIM query on an idle box and >10s on a loaded one, so a tighter bound buys
 *  nothing and loses the identity. */
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
