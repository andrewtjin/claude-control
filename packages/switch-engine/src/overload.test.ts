// Tests for the 529 retry primitive, against an injected clock/sleep/jitter and a fake status
// page — no real waiting and no network, so the whole budget is exercised in microseconds.

import { describe, it, expect, vi } from 'vitest';
import {
  createStatusProbeCache,
  describeStatus,
  isOverloadCode,
  probeClaudeStatus,
  withOverloadRetry,
  CLAUDE_STATUS_URL,
  LOCKED_OVERLOAD_BUDGET_CAP_MS,
  OVERLOAD_BACKOFF_CAP_MS,
  PATIENT_OVERLOAD_BUDGET,
  RETRY_AFTER_CAP_MS,
  SHORT_OVERLOAD_BUDGET,
  STATUS_CACHE_TTL_MS,
  type OverloadAttemptContext,
  type OverloadRetryDeps,
} from './overload.js';

/** What a status-page fetch resolves to, spelled out so the fixtures below type-check as one. */
interface StatusPageResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** A response as the retry loop sees it: status plus optional headers. */
function response(status: number, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string): string | null => headers[name.toLowerCase()] ?? null },
  };
}

/** An attempt that walks a list of statuses, repeating the last one forever after. */
function attemptsOf(statuses: number[], headers: Record<string, string> = {}) {
  let index = 0;
  return vi.fn(() => {
    const status = statuses[Math.min(index, statuses.length - 1)] ?? 200;
    index += 1;
    return Promise.resolve(response(status, headers));
  });
}

/** A status page answering with the given Statuspage v2 indicator. */
function statusPage(indicator: string) {
  return vi.fn((_url: string, _init: { signal?: AbortSignal }) =>
    Promise.resolve<StatusPageResponse>({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve<unknown>({
          page: { id: 'p', name: 'Claude' },
          status: { indicator, description: 'whatever' },
        }),
    }),
  );
}

/** A status page whose fetch rejects outright (offline, DNS, abort). */
function unreachablePage() {
  return vi.fn((_url: string, _init: { signal?: AbortSignal }) =>
    Promise.reject(new Error('ENOTFOUND status.claude.com')),
  );
}

/** A fake clock the injected `sleep` advances, so the loop's total-time budget binds exactly as
 *  it would in production without anything actually waiting. */
function harness(statusFetch: OverloadRetryDeps['statusFetch'], random = () => 0.5) {
  let nowMs = 0;
  const sleep = vi.fn((ms: number) => {
    nowMs += ms;
    return Promise.resolve();
  });
  const deps: OverloadRetryDeps = {
    ...(statusFetch !== undefined ? { statusFetch } : {}),
    sleep,
    random,
    now: () => nowMs,
    // A private cache per case: a verdict cached by one test must never decide another.
    statusCache: createStatusProbeCache(),
  };
  const advance = (ms: number): void => {
    nowMs += ms;
  };
  return { deps, sleep, advance };
}

/** Every way the status page can fail to give a usable answer. All must land on "patient". */
const unusablePages: [string, () => Promise<StatusPageResponse>][] = [
  [
    'a non-2xx status page',
    () => Promise.resolve({ ok: false, status: 503, json: () => Promise.resolve<unknown>({}) }),
  ],
  [
    'a body with no status block',
    () => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve<unknown>({}) }),
  ],
  [
    'a non-string indicator',
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve<unknown>({ status: { indicator: 3 } }),
      }),
  ],
  [
    'an unparseable body',
    () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.reject(new Error('unexpected token < in JSON')),
      }),
  ],
];

describe('withOverloadRetry', () => {
  it('passes a success straight through and never touches the status page', async () => {
    const page = statusPage('none');
    const { deps, sleep } = harness(page);
    const attempt = attemptsOf([200]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(outcome.response.status).toBe(200);
    expect(outcome.retries).toBe(0);
    // The verdict is absent because the probe never ran — a healthy call must cost exactly one
    // request, so patience is only ever priced once a retry is actually on the table.
    expect(outcome.verdict).toBeUndefined();
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });

  // 503 leads the list on purpose: it is the status most likely to be folded in by mistake, and
  // an unavailable upstream is a different fact from an overloaded one.
  it.each([503, 500, 502, 429, 400, 401])('does not retry a %d', async (status) => {
    const page = statusPage('none');
    const { deps } = harness(page);
    const attempt = attemptsOf([status]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(outcome.response.status).toBe(status);
    expect(outcome.retries).toBe(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(page).not.toHaveBeenCalled();
  });

  it('retries a 529 and returns the eventual success', async () => {
    const { deps, sleep } = harness(statusPage('none'));
    const attempt = attemptsOf([529, 200]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(outcome.response.status).toBe(200);
    expect(outcome.retries).toBe(1);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(describeStatus(outcome.verdict)).toBe('none');
  });

  it('all-clear buys the SHORT budget and returns the final 529 unchanged', async () => {
    const { deps } = harness(statusPage('none'));
    const attempt = attemptsOf([529]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(attempt).toHaveBeenCalledTimes(SHORT_OVERLOAD_BUDGET.maxAttempts);
    expect(outcome.retries).toBe(SHORT_OVERLOAD_BUDGET.maxAttempts - 1);
    // The exhausted response is handed back as-is so callers keep their own non-2xx handling.
    expect(outcome.response.status).toBe(529);
    expect(outcome.verdict).toEqual({ incident: false, indicator: 'none', probeFailed: false });
  });

  it.each(['minor', 'major', 'critical', 'something-we-do-not-recognize'])(
    'indicator %s buys the PATIENT budget',
    async (indicator) => {
      const { deps } = harness(statusPage(indicator));
      const attempt = attemptsOf([529]);

      const outcome = await withOverloadRetry(attempt, deps);

      expect(attempt).toHaveBeenCalledTimes(PATIENT_OVERLOAD_BUDGET.maxAttempts);
      expect(outcome.verdict?.incident).toBe(true);
      expect(describeStatus(outcome.verdict)).toBe(indicator);
    },
  );

  it('a status page that throws still buys the PATIENT budget (never fewer retries)', async () => {
    const { deps } = harness(unreachablePage());
    const attempt = attemptsOf([529]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(attempt).toHaveBeenCalledTimes(PATIENT_OVERLOAD_BUDGET.maxAttempts);
    expect(outcome.verdict).toEqual({ incident: true, probeFailed: true });
    expect(describeStatus(outcome.verdict)).toBe('unreachable');
  });

  it.each(unusablePages)('treats %s as probe failure (patient)', async (_label, make) => {
    const page = vi.fn((_url: string, _init: { signal?: AbortSignal }) => make());
    const { deps } = harness(page);
    const attempt = attemptsOf([529]);

    const outcome = await withOverloadRetry(attempt, deps);

    expect(outcome.verdict?.probeFailed).toBe(true);
    expect(attempt).toHaveBeenCalledTimes(PATIENT_OVERLOAD_BUDGET.maxAttempts);
  });

  it('backs off exponentially with full jitter, capped per step', async () => {
    // random() === 1 is the top of the full-jitter range, so the observed sleeps ARE the
    // ceilings — the assertion that pins both the doubling and the per-step cap.
    const { deps, sleep } = harness(statusPage('major'), () => 1);
    await withOverloadRetry(attemptsOf([529]), deps);

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([1_000, 2_000, 4_000, 8_000, 8_000]);
    expect(Math.max(...sleep.mock.calls.map((call) => call[0]))).toBe(OVERLOAD_BACKOFF_CAP_MS);
  });

  it('jitters below the ceiling: random() === 0 sleeps nothing at all', async () => {
    const { deps, sleep } = harness(statusPage('major'), () => 0);
    await withOverloadRetry(attemptsOf([529]), deps);

    expect(sleep.mock.calls.map((call) => call[0])).toEqual([0, 0, 0, 0, 0]);
  });

  it('honors a sane Retry-After instead of the computed backoff', async () => {
    const { deps, sleep } = harness(statusPage('none'), () => 1);
    const attempt = attemptsOf([529, 200], { 'retry-after': '2' });

    await withOverloadRetry(attempt, deps);

    // 2s from the server, not the 1s first backoff step this jitter would otherwise produce.
    expect(sleep).toHaveBeenCalledWith(2_000);
  });

  it('caps an outrageous Retry-After rather than parking inside a locked call', async () => {
    const { deps, sleep } = harness(statusPage('major'));
    const attempt = attemptsOf([529, 200], { 'retry-after': '3600' });

    await withOverloadRetry(attempt, deps);

    expect(sleep).toHaveBeenCalledWith(RETRY_AFTER_CAP_MS);
  });

  it.each(['', '   ', 'Wed, 21 Oct 2026 07:28:00 GMT', '-5', 'soon'])(
    'ignores an unusable Retry-After (%s) and uses the computed backoff',
    async (raw) => {
      const { deps, sleep } = harness(statusPage('none'), () => 1);
      const attempt = attemptsOf([529, 200], { 'retry-after': raw });

      await withOverloadRetry(attempt, deps);

      expect(sleep).toHaveBeenCalledWith(1_000);
    },
  );

  it('stops on the total-time budget even with attempts left, clamping the last sleep', async () => {
    // Slow attempts (7s each) burn the patient budget before its 6th try, and the last sleep
    // has to shrink to whatever is left rather than overrunning the budget.
    const { deps, advance } = harness(statusPage('major'), () => 1);
    const attempt = vi.fn(() => {
      advance(7_000);
      return Promise.resolve(response(529));
    });

    const outcome = await withOverloadRetry(attempt, deps);

    expect(attempt.mock.calls.length).toBeLessThan(PATIENT_OVERLOAD_BUDGET.maxAttempts);
    expect(outcome.response.status).toBe(529);
    const sleeps = (deps.sleep as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => call[0] as number,
    );
    // The budget's clock starts at the first overloaded answer, so the 7s spent discovering it
    // is not charged to the retries; the final sleep is clamped to what remains after them.
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(sleeps.reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(
      PATIENT_OVERLOAD_BUDGET.totalBudgetMs,
    );
  });

  it('deadlines every retry, so the last one cannot outlive the budget', async () => {
    // The failure this pins: bounding only when a retry may START lets the final attempt run
    // for its caller's whole per-request timeout ON TOP of the budget — under the credential
    // lock that is the difference between a bounded hold and one reclaimed mid-refresh.
    const REQUEST_TIMEOUT_MS = 30_000; // a caller's own ceiling, far past the retry budget
    const { deps, advance } = harness(statusPage('major'), () => 1);
    const offered: number[] = [];
    const attempt = vi.fn((ctx: OverloadAttemptContext) => {
      offered.push(ctx.remainingMs);
      // A request that ends at its own timeout or at the loop's deadline, whichever comes
      // first — exactly what composing `ctx.signal` into the fetch produces in production.
      advance(Math.min(REQUEST_TIMEOUT_MS, ctx.remainingMs));
      return Promise.resolve(response(529));
    });

    const outcome = await withOverloadRetry(attempt, deps);

    // The first attempt is the request the caller would have made anyway: no deadline of ours.
    expect(offered[0]).toBe(Number.POSITIVE_INFINITY);
    expect(offered.slice(1).every((ms) => ms <= PATIENT_OVERLOAD_BUDGET.totalBudgetMs)).toBe(true);
    expect(outcome.response.status).toBe(529);
    // Total elapsed, not summed sleeps: everything after the first answer fits in the budget.
    expect(deps.now?.()).toBeLessThanOrEqual(
      REQUEST_TIMEOUT_MS + PATIENT_OVERLOAD_BUDGET.totalBudgetMs,
    );
  });

  it('honors a caller-supplied budget cap (the locked refresh path)', async () => {
    const { deps, advance } = harness(statusPage('major'), () => 1);
    const FIRST_ATTEMPT_MS = 30_000;
    const attempt = vi.fn((ctx: OverloadAttemptContext) => {
      advance(Math.min(FIRST_ATTEMPT_MS, ctx.remainingMs));
      return Promise.resolve(response(529));
    });

    const outcome = await withOverloadRetry(attempt, {
      ...deps,
      budgetCapMs: LOCKED_OVERLOAD_BUDGET_CAP_MS,
    });

    // The incident bought the patient budget, but a caller holding the credential lock spends
    // only its cap — everything after the first answer lands inside it.
    expect(outcome.verdict?.incident).toBe(true);
    expect(attempt.mock.calls.length).toBeGreaterThan(1);
    expect((deps.now?.() ?? 0) - FIRST_ATTEMPT_MS).toBeLessThanOrEqual(
      LOCKED_OVERLOAD_BUDGET_CAP_MS,
    );
  });

  it('releases the body of every response it retries away', async () => {
    // An undrained body holds its socket out of the pool until the collector gets to it, and a
    // fleet-wide overload discards one of them per retry per account.
    const { deps } = harness(statusPage('none'));
    const cancel = vi.fn(() => Promise.resolve());
    let index = 0;
    const attempt = vi.fn(() => {
      index += 1;
      return Promise.resolve({ ...response(index === 1 ? 529 : 200), body: { cancel } });
    });

    await withOverloadRetry(attempt, deps);

    // Once for the discarded 529; the response handed back is the caller's to read.
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('reports each retry to onRetry with the verdict that priced it', async () => {
    const seen: { attempt: number; delayMs: number; indicator: string }[] = [];
    const { deps } = harness(statusPage('minor'), () => 1);

    await withOverloadRetry(attemptsOf([529, 529, 200]), {
      ...deps,
      onRetry: (event) =>
        seen.push({
          attempt: event.attempt,
          delayMs: event.delayMs,
          indicator: describeStatus(event.verdict),
        }),
    });

    expect(seen).toEqual([
      { attempt: 1, delayMs: 1_000, indicator: 'minor' },
      { attempt: 2, delayMs: 2_000, indicator: 'minor' },
    ]);
  });
});

describe('probeClaudeStatus', () => {
  it('asks the documented status endpoint', async () => {
    const page = statusPage('none');
    const { deps } = harness(page);

    const verdict = await probeClaudeStatus(deps);

    expect(page.mock.calls[0]?.[0]).toBe(CLAUDE_STATUS_URL);
    expect(verdict).toEqual({ incident: false, indicator: 'none', probeFailed: false });
  });

  it('caches one verdict per process, then re-probes after the TTL', async () => {
    const page = statusPage('none');
    const { deps, advance } = harness(page);

    await withOverloadRetry(attemptsOf([529, 200]), deps);
    await withOverloadRetry(attemptsOf([529, 200]), deps);
    // A burst of 529s across accounts must not turn into a burst of status requests.
    expect(page).toHaveBeenCalledTimes(1);

    advance(STATUS_CACHE_TTL_MS + 1);
    await withOverloadRetry(attemptsOf([529, 200]), deps);
    expect(page).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent probes into a single request', async () => {
    const page = statusPage('none');
    const { deps } = harness(page);

    await Promise.all([probeClaudeStatus(deps), probeClaudeStatus(deps), probeClaudeStatus(deps)]);

    expect(page).toHaveBeenCalledTimes(1);
  });

  it('caches the failure verdict too, so an unreachable page is not hammered', async () => {
    const page = unreachablePage();
    const { deps } = harness(page);

    expect((await probeClaudeStatus(deps)).probeFailed).toBe(true);
    expect((await probeClaudeStatus(deps)).probeFailed).toBe(true);
    expect(page).toHaveBeenCalledTimes(1);
  });
});

describe('describeStatus', () => {
  it('names the indicator, the unreachable page, and the un-run probe distinctly', () => {
    expect(describeStatus({ incident: true, indicator: 'major', probeFailed: false })).toBe(
      'major',
    );
    expect(describeStatus({ incident: true, probeFailed: true })).toBe('unreachable');
    expect(describeStatus(undefined)).toBe('not checked');
  });
});

describe('isOverloadCode', () => {
  it('recognizes only the retryable status codes', () => {
    expect(isOverloadCode('http_529')).toBe(true);
    expect(isOverloadCode('http_503')).toBe(false);
    expect(isOverloadCode('http_429')).toBe(false);
    expect(isOverloadCode('invalid_grant')).toBe(false);
    expect(isOverloadCode('network')).toBe(false);
    // Not a status code at all — the shape must not be matched loosely.
    expect(isOverloadCode('http_529x')).toBe(false);
  });
});
