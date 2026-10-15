// Client for the daemon's loopback CLI endpoints: the `cctl session` commands and the on-demand
// usage refresh.
//
// `cctl session register|label|watch` talk to the RUNNING daemon over the same 127.0.0.1
// HookReceiver server the CLI hooks use, guarded by the SAME `x-claude-control-secret`. Two
// invariants:
//   1. The CLI is NEVER a secret author. It reads the daemon-minted secret with the daemon
//      package's READ-ONLY `loadHookSecret`; if the file is missing (daemon never ran) it fails
//      with an actionable message rather than inventing a secret the receiver would reject.
//   2. The daemon's loopback port is OS-assigned per run, so it is PUBLISHED to a file
//      (hook-endpoint.json) the daemon rewrites on start; the CLI reads it to know where to POST.
//
// Everything here is one-shot: read secret + port, POST, map the daemon's JSON result onto a
// success value or an actionable error. Failure posture is uniform — anything that means "the
// daemon isn't reachable" becomes a {@link SessionClientError} the command action prints via
// `fail()`.

import { dirname } from 'node:path';
import {
  defaultPaths,
  defaultProtector,
  type Paths,
  type Protector,
} from '@claude-control/switch-engine';
import {
  hookEndpointPath,
  hookSecretPath,
  loadHookSecret,
  readHookEndpoint,
  type UsageRepollResult,
  type UsageRepollVerdict,
} from '@claude-control/daemon';

/** A tracked session as echoed back by the daemon (compact view). */
export interface SessionView {
  id: string;
  kind: string;
  state: string;
  label?: string;
  watch: boolean;
  accountId?: string;
}

/** A successful CLI session command result. Statuses mirror the daemon's contract: `applied`
 *  (the mutation took), `already_handled` (duplicate idempotency key), `already_registered`
 *  (a repeated register that would change nothing — value-level feedback across separate
 *  invocations, which fresh per-invocation keys cannot catch). */
export interface SessionCommandSuccess {
  ok: true;
  status: 'applied' | 'already_handled' | 'already_registered';
  session: SessionView;
}

/** The verbs the daemon exposes as mutating loopback endpoints. */
export type SessionVerb = 'register' | 'label' | 'watch' | 'unregister';

/** Every failure the CLI can surface for a daemon call (a session command, a usage refresh)
 *  carries a human-actionable message; a dedicated class lets the command action print it cleanly
 *  (via `fail`) without leaking a stack trace or guessing whether an Error was expected. */
export class SessionClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionClientError';
  }
}

/** Injectable seams so the colocated test can point at a temp data dir + passthrough protector
 *  and a real (temporary) HookReceiver instead of the production paths/DPAPI. */
export interface SessionClientDeps {
  /** The claude-control data dir (`dirname(vaultDir)`); defaults to the production location. */
  dataDir?: string;
  /** The at-rest protector for reading the hook secret; defaults to this platform's real one. */
  protector?: Protector;
}

/**
 * Resolve the interactive session id to act on. Priority: explicit `--session` flag, then a
 * best-effort environment scan.
 *
 * WHY --session is the guaranteed path: as of Claude Code 2.1.x there is NO documented, reliable
 * environment variable exposing the current session id to a slash-command subprocess.
 * `CLAUDE_SESSION_ID` does not exist; `CLAUDE_CODE_BRIDGE_SESSION_ID` is present only when the
 * session has an active Remote Control connection. So we try those opportunistically but require
 * `--session <id>` otherwise — surfaced as a clear error, never a silent wrong-session action.
 */
export function resolveSessionId(
  opts: { session?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = opts.session?.trim();
  if (explicit) return explicit;
  for (const name of ['CLAUDE_CODE_BRIDGE_SESSION_ID', 'CLAUDE_SESSION_ID']) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

/** The data dir the CLI shares with the daemon (secret + endpoint live here). */
function dataDirOf(deps: SessionClientDeps, paths: Paths): string {
  return deps.dataDir ?? dirname(paths.vaultDir);
}

/** The daemon's JSON answer, loosely typed: each caller narrows the fields it reads. */
interface DaemonReply {
  ok?: unknown;
  message?: string;
  error?: string;
  [field: string]: unknown;
}

/**
 * POST one JSON body to a loopback CLI route of the running daemon and return its parsed answer.
 * Reads the secret (read-only) and the published port first. Throws a {@link SessionClientError}
 * with an actionable message for every "can't reach the daemon" condition (no secret, no
 * endpoint, connection refused) and for any non-2xx answer (surfacing the daemon's own words).
 * One path for every CLI route, so they all fail the same way.
 */
async function postToDaemon(
  route: string,
  payload: Record<string, unknown>,
  deps: SessionClientDeps,
  // A route can put a refusal in better words than the daemon's own (a daemon too old to know the
  // route, for one), judged by the status and the daemon's answer; undefined falls through to the
  // daemon's message.
  explainRefusal: (status: number, body: DaemonReply | undefined) => string | undefined = () =>
    undefined,
): Promise<DaemonReply | undefined> {
  const paths = defaultPaths();
  const dataDir = dataDirOf(deps, paths);
  const protector = deps.protector ?? defaultProtector();

  const secret = await loadHookSecret({ filePath: hookSecretPath(dataDir), protector });
  if (secret === undefined) {
    throw new SessionClientError(
      'the daemon has never run on this machine, so its loopback secret does not exist yet - ' +
        'start it with `cctl daemon run`',
    );
  }
  const endpoint = await readHookEndpoint(hookEndpointPath(dataDir));
  if (endpoint === undefined) {
    throw new SessionClientError(
      'the daemon is not running (no loopback endpoint published) - start it with `cctl daemon run`',
    );
  }

  let res: Awaited<ReturnType<typeof fetch>>;
  try {
    res = await fetch(`http://127.0.0.1:${endpoint.port}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': secret },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    // A published endpoint whose daemon has since died → connection refused.
    throw new SessionClientError(
      `could not reach the daemon on 127.0.0.1:${endpoint.port} - is \`cctl daemon run\` still ` +
        `running? (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  const body = (await res.json().catch(() => undefined)) as DaemonReply | undefined;
  if (!res.ok) {
    // 4xx/5xx from the daemon: surface its explanation (unknown_session message, validation
    // error) verbatim so the user sees exactly what to fix.
    throw new SessionClientError(
      explainRefusal(res.status, body) ??
        body?.message ??
        body?.error ??
        `daemon returned HTTP ${res.status}`,
    );
  }
  return body;
}

/**
 * POST one session command to the running daemon. Every failure is a {@link SessionClientError}
 * with an actionable message (see {@link postToDaemon}), including a 2xx answer that does not
 * carry the session it should.
 */
export async function callDaemonSession(
  verb: SessionVerb,
  payload: Record<string, unknown>,
  deps: SessionClientDeps = {},
): Promise<SessionCommandSuccess> {
  const body = (await postToDaemon(`/cli/session/${verb}`, payload, deps)) as
    (DaemonReply & { status?: string; session?: SessionView }) | undefined;
  if (!body || body.ok !== true || body.session === undefined) {
    throw new SessionClientError(body?.message ?? body?.error ?? 'unexpected daemon response');
  }
  return {
    ok: true,
    status:
      body.status === 'already_handled' || body.status === 'already_registered'
        ? body.status
        : 'applied',
    session: body.session,
  };
}

/** The words a daemon from before the usage refresh answers the route with: it reads it as a
 *  session command and refuses the missing session. Kept as a literal on purpose, since it
 *  identifies what already-shipped daemons say, whatever the current receiver says later. */
const PRE_REPOLL_SESSION_REFUSAL = 'sessionId and idempotencyKey are required';

/**
 * Whether a refusal of `/cli/usage/repoll` comes from a daemon that predates the route. Such a
 * daemon answers 404 (an unknown CLI endpoint) or a 400 complaining about the session fields; a
 * current daemon never answers 404 here, and its own 400s (a body over its size cap, a malformed
 * id list) and a 401 for a stale secret are not cured by a restart, so they keep their own words.
 */
function predatesUsageRepoll(status: number, reply: DaemonReply | undefined): boolean {
  if (status === 404) return true;
  return status === 400 && reply?.error === PRE_REPOLL_SESSION_REFUSAL;
}

/**
 * Ask the running daemon to refresh usage now for these accounts (every stored account when `ids`
 * is absent). The daemon honors each account's poll floor and 429 backoff, so the answer is a
 * verdict per account: `scheduled`, or `skipped` with the reason (and, for a held account, when it
 * is next due). Fails with a {@link SessionClientError} like every other daemon call, and in plain
 * words when the running daemon predates the route.
 */
export async function callDaemonUsageRepoll(
  ids?: readonly string[],
  deps: SessionClientDeps = {},
): Promise<UsageRepollResult> {
  // Caught here, in words naming the mistake, rather than as the daemon's generic list refusal.
  if (ids !== undefined && ids.some((id) => id.length === 0)) {
    throw new SessionClientError('an account id to refresh is empty');
  }
  const body = await postToDaemon(
    '/cli/usage/repoll',
    ids === undefined ? {} : { ids: [...ids] },
    deps,
    (status, reply) =>
      predatesUsageRepoll(status, reply)
        ? 'the running daemon is older than this cctl and cannot refresh usage on demand - ' +
          'restart it with `cctl daemon restart`'
        : undefined,
  );
  if (!body || body.ok !== true || !Array.isArray(body.results)) {
    throw new SessionClientError(body?.message ?? body?.error ?? 'unexpected daemon response');
  }
  return { ok: true, results: body.results as UsageRepollVerdict[] };
}
