// In-call retries for an OVERLOADED upstream (HTTP 529), with patience tuned by status.claude.com.
//
// 529 is the one status where retrying the identical request is the right answer: the service is
// saying "too much load right now", not "your request is wrong" and not "your credential is
// dead". Every other failure keeps the behavior it already had — a 5xx, a 429 and a network
// error each mean something different to the callers here, and quietly folding them into one
// retry loop would paper over a rate limit or a dead endpoint. The retryable set is therefore a
// named constant: widening it later is a one-line, reviewable change, not a rewrite.
//
// The status page TUNES the wait; it never gates it. A 529 is always retried a few times even
// when the probe says all-clear, and a probe that fails or times out buys the LONGER budget
// rather than cutting retries short — an unreachable status page is itself weak evidence that
// something is wrong, and "we could not check" must never be the reason an account stops trying.
//
// BUDGET CEILING (the constraint that sizes everything below): the token refresh this wraps runs
// inside the cross-process credential lock, which another process may reclaim once the holder is
// 60s old, with no heartbeat to say otherwise. A refresh that retried past that would have its
// lock pulled mid-flight. So the in-call budget is capped well under a minute, and true
// persistence lives at the callers that already re-attempt on their own schedule (the usage
// poller's next cycle, the token getter's next interval).

import { noopLogger, type Logger } from './logger.js';

/** Statuses this module retries. 529 ("overloaded") only — see the module comment for why
 *  5xx/429/network deliberately keep their existing, distinct handling. */
export const OVERLOAD_STATUSES: ReadonlySet<number> = new Set([529]);

/** Atlassian Statuspage v2 summary for the Claude services. */
export const CLAUDE_STATUS_URL = 'https://status.claude.com/api/v2/status.json';

/** The one indicator value that means "nothing wrong". Anything else — including a value we do
 *  not recognize — counts as an incident, because an unknown indicator is not an all-clear. */
export const STATUS_INDICATOR_OK = 'none';

/** The status probe is advisory, so it must never become the slow part of a retry. Bound it
 *  tightly: a page that has not answered in this long is treated as unreachable (→ patient). */
export const STATUS_PROBE_TIMEOUT_MS = 5_000;

/** How long one process reuses a status verdict. A fleet-wide 529 hits every account at once;
 *  without this, one upstream hiccup would turn into a burst of probes against the status page. */
export const STATUS_CACHE_TTL_MS = 60_000;

/** How many tries a budget allows and how long they may take in total. Both bind: whichever
 *  runs out first ends the loop. */
export interface OverloadBudget {
  readonly maxAttempts: number;
  readonly totalBudgetMs: number;
}

/** Budget when the status page reports all-clear: a 529 with nothing else known to be wrong is
 *  most likely a brief spike, so try a couple more times and hand the caller its answer fast. */
export const SHORT_OVERLOAD_BUDGET: OverloadBudget = { maxAttempts: 3, totalBudgetMs: 10_000 };

/** Budget when an incident is reported (or the probe failed). Deliberately still far short of
 *  the credential lock's 60s reclaim window — the refresh path is the tightest caller, and a
 *  budget that outlived its own lock would be worse than giving up. */
export const PATIENT_OVERLOAD_BUDGET: OverloadBudget = { maxAttempts: 6, totalBudgetMs: 25_000 };

/** First backoff step; doubles per retry up to {@link OVERLOAD_BACKOFF_CAP_MS}. */
export const OVERLOAD_BACKOFF_BASE_MS = 1_000;
/** Ceiling on one backoff step, so the patient budget spends itself across several tries
 *  instead of on a single long sleep. */
export const OVERLOAD_BACKOFF_CAP_MS = 8_000;
/** Ceiling on a server-supplied `Retry-After`. Honoring the header is right; letting an upstream
 *  park us for an arbitrary time inside a locked call is not. */
export const RETRY_AFTER_CAP_MS = 15_000;

/** What the status page said, as this module acts on it. `incident` is the decision (patient vs
 *  short); `indicator` and `probeFailed` are kept separate so a log line can say WHICH of the
 *  two reasons produced a patient budget. */
export interface StatusVerdict {
  /** True for any indicator other than 'none', AND whenever the probe itself failed. */
  incident: boolean;
  /** The reported indicator; absent when the probe failed. */
  indicator?: string;
  /** True when the status page could not be read, or answered with a shape we cannot read. */
  probeFailed: boolean;
}

/** Minimal response shape the retry loop needs. Callers keep their own richer response types;
 *  this only reads the status and, when the caller's fetch exposes them, the headers. */
export interface OverloadResponse {
  status: number;
  headers?: { get(name: string): string | null | undefined };
}

/** The status-page fetch, injectable so tests never touch the network. */
export type StatusFetchLike = (
  url: string,
  init: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A per-process holder for the cached verdict. Production shares one module-level cache;
 *  tests create their own so a cached verdict cannot leak between cases. */
export interface StatusProbeCache {
  entry?: { atMs: number; verdict: Promise<StatusVerdict> };
}

/** A fresh, empty cache — see {@link StatusProbeCache}. */
export function createStatusProbeCache(): StatusProbeCache {
  return {};
}

/** The cache every caller shares unless it injects its own: the whole point is that a burst of
 *  529s across accounts and modules costs ONE status request per minute. */
const processStatusCache = createStatusProbeCache();

/** Reported to the caller's `onRetry` before each sleep. */
export interface OverloadRetryEvent {
  /** 1-based number of the attempt that just came back overloaded. */
  attempt: number;
  status: number;
  /** How long the loop is about to sleep. */
  delayMs: number;
  verdict: StatusVerdict;
}

export interface OverloadRetryDeps {
  statusFetch?: StatusFetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** `Math.random`-shaped jitter source. */
  random?: () => number;
  /** Cache override; defaults to the shared per-process one. */
  statusCache?: StatusProbeCache;
  onRetry?: (event: OverloadRetryEvent) => void;
  logger?: Logger;
}

/** What the loop finished with. The response is returned AS-IS — still 529 when the budget ran
 *  out — so every caller keeps its own non-2xx handling instead of learning a new error type. */
export interface OverloadRetryOutcome<Res extends OverloadResponse> {
  response: Res;
  /** How many extra attempts the loop spent (0 when the first attempt was not overloaded). */
  retries: number;
  /** The verdict that chose the budget; absent when no 529 ever happened, because the probe
   *  only runs once a retry is actually on the table. */
  verdict?: StatusVerdict;
}

/**
 * Ask the status page whether Claude is having an incident. Never throws and never rejects: any
 * failure — transport, timeout, non-2xx, unparseable or unexpected body — resolves to the
 * patient default (`incident: true, probeFailed: true`).
 *
 * The cache stores the in-flight PROMISE, not just the settled verdict, so concurrent probes
 * (several accounts hitting 529 in the same instant) collapse into one request.
 */
export async function probeClaudeStatus(deps: OverloadRetryDeps = {}): Promise<StatusVerdict> {
  const now = deps.now ?? Date.now;
  const cache = deps.statusCache ?? processStatusCache;
  const cached = cache.entry;
  if (cached !== undefined && now() - cached.atMs < STATUS_CACHE_TTL_MS) return cached.verdict;
  const verdict = runStatusProbe(deps);
  cache.entry = { atMs: now(), verdict };
  return verdict;
}

/**
 * Run `attempt`, re-running it while it answers with an {@link OVERLOAD_STATUSES} status.
 *
 * The status probe fires on the FIRST 529 and not before: a request that succeeds must cost
 * exactly one network call, so the happy path never pays for the status page. Anything the
 * attempt THROWS (network error, abort) propagates untouched — those are the caller's existing
 * transient paths, and this module deliberately does not claim them.
 */
export async function withOverloadRetry<Res extends OverloadResponse>(
  attempt: () => Promise<Res>,
  deps: OverloadRetryDeps = {},
): Promise<OverloadRetryOutcome<Res>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const log = deps.logger ?? noopLogger;
  const startedAtMs = now();

  let verdict: StatusVerdict | undefined;
  // Assume the cheap budget until the probe says otherwise; it is only ever consulted after a
  // 529, at which point the verdict's budget replaces this.
  let budget = SHORT_OVERLOAD_BUDGET;
  let retries = 0;

  for (;;) {
    const response = await attempt();
    if (!OVERLOAD_STATUSES.has(response.status)) return outcome(response, retries, verdict);

    if (verdict === undefined) {
      verdict = await probeClaudeStatus(deps);
      budget = verdict.incident ? PATIENT_OVERLOAD_BUDGET : SHORT_OVERLOAD_BUDGET;
      log.debug(
        { status: response.status, statusPage: describeStatus(verdict) },
        'upstream overloaded; retrying',
      );
    }

    // Attempts made so far is `retries + 1`. Both bounds are checked BEFORE sleeping, so an
    // exhausted budget answers immediately instead of waiting to discover it is done.
    if (retries + 1 >= budget.maxAttempts) return outcome(response, retries, verdict);
    const remainingMs = budget.totalBudgetMs - (now() - startedAtMs);
    if (remainingMs <= 0) return outcome(response, retries, verdict);

    const delayMs = Math.min(nextDelayMs(retries, response, random), remainingMs);
    deps.onRetry?.({ attempt: retries + 1, status: response.status, delayMs, verdict });
    retries += 1;
    await sleep(delayMs);
  }
}

/** One-word rendering of a verdict for a log line or a user-facing message: the reported
 *  indicator, `unreachable` when the probe failed, or `not checked` when none was needed. */
export function describeStatus(verdict: StatusVerdict | undefined): string {
  if (verdict === undefined) return 'not checked';
  return verdict.probeFailed ? 'unreachable' : (verdict.indicator ?? 'unknown');
}

/** Whether an `http_<status>` error code (the shape {@link SwitchEngineError} codes use for a
 *  non-2xx) names an overload status. Callers branch on this instead of hard-coding 529, so
 *  widening {@link OVERLOAD_STATUSES} carries them along. */
export function isOverloadCode(code: string): boolean {
  const match = /^http_(\d+)$/.exec(code);
  const digits = match?.[1];
  return digits !== undefined && OVERLOAD_STATUSES.has(Number(digits));
}

function outcome<Res extends OverloadResponse>(
  response: Res,
  retries: number,
  verdict: StatusVerdict | undefined,
): OverloadRetryOutcome<Res> {
  // Spread-conditional rather than an assigned `undefined`: exactOptionalPropertyTypes.
  return { response, retries, ...(verdict !== undefined ? { verdict } : {}) };
}

/** Exponential backoff with FULL jitter (uniform in [0, ceiling]) — the variant that actually
 *  de-synchronizes a fleet of clients retrying the same overloaded endpoint; a fixed backoff
 *  would just have them all come back together and re-overload it. A sane `Retry-After` wins
 *  over the computed delay: a server naming a time is better information than our guess. */
function nextDelayMs(retryIndex: number, response: OverloadResponse, random: () => number): number {
  const retryAfterMs = parseRetryAfterMs(response);
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, RETRY_AFTER_CAP_MS);
  const ceilingMs = Math.min(OVERLOAD_BACKOFF_BASE_MS * 2 ** retryIndex, OVERLOAD_BACKOFF_CAP_MS);
  return Math.round(random() * ceilingMs);
}

/** `Retry-After` in delta-seconds, or undefined when absent or not sane. The HTTP-date form is
 *  deliberately NOT parsed: it depends on agreeing with the server's clock, and falling back to
 *  our own backoff is strictly safer than acting on a skewed date. */
function parseRetryAfterMs(response: OverloadResponse): number | undefined {
  const raw = response.headers?.get('retry-after');
  if (raw === undefined || raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw.trim());
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return seconds * 1000;
}

/** The verdict every failure mode of the probe produces: patient, and honest about why. */
function probeFailedVerdict(): StatusVerdict {
  return { incident: true, probeFailed: true };
}

/** The uncached probe. Wrapped in one try/catch on purpose — every distinguishable failure here
 *  (offline, DNS, timeout, a 503 from the status page itself, an HTML error page, a renamed
 *  field) leads to the same decision, and pretending otherwise would only add branches. */
async function runStatusProbe(deps: OverloadRetryDeps): Promise<StatusVerdict> {
  const doFetch: StatusFetchLike | undefined = deps.statusFetch ?? globalThis.fetch;
  if (!doFetch) return probeFailedVerdict();
  try {
    const res = await doFetch(CLAUDE_STATUS_URL, {
      signal: AbortSignal.timeout(STATUS_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return probeFailedVerdict();
    const body: unknown = await res.json();
    const indicator = (body as { status?: { indicator?: unknown } } | null)?.status?.indicator;
    // A body without a string indicator is not an all-clear — it is a page we cannot read.
    if (typeof indicator !== 'string' || indicator === '') return probeFailedVerdict();
    return { incident: indicator !== STATUS_INDICATOR_OK, indicator, probeFailed: false };
  } catch {
    return probeFailedVerdict();
  }
}

/** Real sleeping, used whenever a caller does not inject its own (tests always do). */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
