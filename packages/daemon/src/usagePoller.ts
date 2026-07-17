// Polls usage for every account WITHOUT switching which one is live.
//
// The switch engine's `activate()` makes an account's credentials the live ones — polling
// must never call it. Instead each account's access token is obtained directly (an injected
// `getToken`), and the tier-1 endpoint is hit with that token in the `Authorization` header.
// A per-account floor + jitter + backoff keeps this from hammering the endpoint or the vault's
// refresh path; a tier-0 cached fallback keeps the advisor fed even when the network is down.
//
// WET-GATED: the real endpoint URL, header names, and response shape are reverse-engineered
// from the CLI (see docs/VERIFICATION.md) — this module only ever calls the INJECTED `fetch`,
// never `globalThis.fetch`, so tests can fully control what "the endpoint" returns.

import type { AccountUsage, UsagePlan } from '@claude-control/shared-protocol';
import {
  computePlan,
  type AccountUsageInput,
  type AdvisorOptions,
} from '@claude-control/usage-advisor';
import { parseUsageEndpointResponse, parseCachedUsage, type ParsedUsage } from './usageParse.js';

export const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
export const ANTHROPIC_BETA_HEADER = 'oauth-2025-04-20';

/** Per-account poll floor: never re-poll an account sooner than this after its last poll. */
export const POLL_FLOOR_MS = 180_000;
/** Random jitter added on top of the floor so many accounts don't all re-poll in lockstep. */
export const POLL_JITTER_MS = 15_000;
/** Backoff base and cap for repeated 429s from one account. */
export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_CAP_MS = 30 * 60_000;

/** Minimal shape of a fetch response the poller actually uses — narrower than the DOM
 *  `Response` type so tests can hand back a plain object instead of a real fetch Response. */
export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}
export type FetchLike = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<FetchLikeResponse>;

/** One account this poller is responsible for. */
export interface PollAccount {
  accountId: string;
  label: string;
  active: boolean;
  quarantined: boolean;
}

export interface UsagePollerOptions {
  fetch: FetchLike;
  /** Obtain a currently-valid access token for an account WITHOUT switching the live
   *  account — production wires this to the vault (decrypt + refresh-if-needed); tests
   *  inject a fake. Returning `undefined` means "no usable token" (falls back to tier-0). */
  getToken: (accountId: string) => Promise<string | undefined>;
  /** The tier-0 cached usage payload for an account, from `~/.claude.json`'s
   *  `cachedUsageUtilization` — read fresh each fallback so it's never stale by construction. */
  getCachedUsage: (accountId: string) => Promise<unknown>;
  clock?: () => number;
  /** `Math.random`-shaped jitter source, injectable for deterministic tests. */
  random?: () => number;
  userAgent?: string;
  advisorOptions?: AdvisorOptions;
}

/** Per-account poll/backoff bookkeeping the poller carries between calls. */
interface AccountPollState {
  /** Consecutive 429s seen; drives exponential backoff. Resets to 0 on any non-429 result. */
  consecutive429s: number;
  /** When this account may next be polled. Always at least `POLL_FLOOR_MS` (+jitter) past
   *  the last poll; a 429 pushes it further out by `max(floor, backoff)` so the floor is a
   *  hard minimum backoff never shrinks below, and backoff only matters once it exceeds it. */
  nextDueAtMs: number;
  /** The last REAL poll result (live or cached) for this account. On a skipped cycle the
   *  poller returns THIS unchanged — preserving its original `fetchedAtMs`/`source` — instead
   *  of re-reading tier-0 and stamping it `fetchedAtMs: now`, which would report frozen cache
   *  as freshly-fetched and flip the burn-down advisor on stale numbers ~2/3 of the time. */
  lastResult?: ParsedUsage;
}

export interface AccountPollResult {
  accountId: string;
  usage: ParsedUsage;
  /** Whether this call actually polled (vs. being skipped by the floor/backoff) and, if so,
   *  which tier answered. `'skipped'` means the previous result (if any) is still current. */
  outcome: 'live' | 'cached' | 'skipped';
}

export interface SnapshotResult {
  results: AccountPollResult[];
  accounts: AccountUsage[];
  plan: UsagePlan;
}

/**
 * Stateful poller: one instance tracks per-account timing/backoff across repeated
 * `pollAll()` calls (e.g. from a daemon's setInterval loop). A fresh instance has no history,
 * so the very first `pollAll()` always polls every account regardless of the floor.
 */
export class UsagePoller {
  private readonly fetchFn: FetchLike;
  private readonly getToken: (accountId: string) => Promise<string | undefined>;
  private readonly getCachedUsage: (accountId: string) => Promise<unknown>;
  private readonly clock: () => number;
  private readonly random: () => number;
  private readonly userAgent: string;
  private readonly advisorOptions: AdvisorOptions | undefined;
  private readonly state = new Map<string, AccountPollState>();

  constructor(options: UsagePollerOptions) {
    this.fetchFn = options.fetch;
    this.getToken = options.getToken;
    this.getCachedUsage = options.getCachedUsage;
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? Math.random;
    this.userAgent = options.userAgent ?? 'claude-code/1.0.0';
    this.advisorOptions = options.advisorOptions;
  }

  /** Poll every account (subject to each one's floor/backoff), then assemble the burn-down
   *  plan from whatever usage is now current for each — freshly polled or carried over from
   *  a prior call. Accounts never before polled always poll (no prior result to carry). */
  async pollAll(accounts: PollAccount[]): Promise<SnapshotResult> {
    const results: AccountPollResult[] = [];
    for (const account of accounts) {
      results.push(await this.pollOne(account));
    }

    const accountUsages = results.map((r) => r.usage.accountUsage);
    const advisorInputs: AccountUsageInput[] = results.map((r) => r.usage.advisorInput);
    const plan = computePlan(advisorInputs, this.advisorOptions);
    return { results, accounts: accountUsages, plan };
  }

  private async pollOne(account: PollAccount): Promise<AccountPollResult> {
    const now = this.clock();
    const state = this.state.get(account.accountId);

    if (state && !this.isDue(state, now) && state.lastResult) {
      // Not due yet: return the retained last real result with its POLLED DATA unchanged
      // (original fetchedAtMs + source), tagged 'skipped' so callers can tell "we
      // deliberately didn't poll" apart from "we polled and got nothing new". Deliberately
      // does NOT re-read tier-0 — re-reading and stamping fetchedAtMs:now here would report
      // stale, frozen cache as freshly-fetched. Identity flags (active/quarantined/label)
      // are NOT polled data though — the caller knows them fresh every cycle — so they are
      // re-stamped: a switch during the poll floor must not leave the advisor and the
      // auto-switcher reasoning about who WAS active up to 3 minutes ago.
      return {
        accountId: account.accountId,
        usage: restampIdentity(state.lastResult, account),
        outcome: 'skipped',
      };
    }

    try {
      const { usage, outcome } = await this.pollLive(account, now);
      this.retain(account.accountId, usage);
      return { accountId: account.accountId, usage, outcome };
    } catch (err) {
      // One account's failure (a tier-0 disk read error, or `getToken` rejecting) must never
      // reject the whole cycle (pollOne -> pollAll -> runPollCycle) and drop the snapshot +
      // plan for EVERY account. Degrade THIS account to a best-effort error entry, mirroring
      // the tolerant parse layer, and keep going.
      const message = err instanceof Error ? err.message : String(err);
      const usage = this.degradedResult(account, now, `usage poll failed: ${message}`);
      this.recordSuccess(account.accountId, now);
      this.retain(account.accountId, usage);
      return { accountId: account.accountId, usage, outcome: 'cached' };
    }
  }

  /** Actually hit the endpoint (or tier-0 fallback) for one account and produce its result.
   *  Separated from `pollOne` so the skip / retain / degrade bookkeeping lives in one place. */
  private async pollLive(
    account: PollAccount,
    now: number,
  ): Promise<{ usage: ParsedUsage; outcome: 'live' | 'cached' }> {
    const token = await this.getToken(account.accountId);
    if (token === undefined) {
      const usage = await this.fetchCached(account, now);
      this.recordSuccess(account.accountId, now);
      return { usage, outcome: 'cached' };
    }

    try {
      const res = await this.fetchFn(USAGE_ENDPOINT, {
        headers: {
          authorization: `Bearer ${token}`,
          'anthropic-beta': ANTHROPIC_BETA_HEADER,
          'user-agent': this.userAgent,
        },
      });

      if (res.status === 429) {
        this.recordRateLimited(account.accountId, now);
        const usage = await this.fetchCached(account, now);
        return { usage, outcome: 'cached' };
      }

      if (!res.ok) {
        // Any other non-2xx is treated the same as a network failure below: fall back, but
        // don't apply 429-style backoff (a transient 5xx shouldn't silence future polls).
        this.recordSuccess(account.accountId, now);
        const usage = await this.fetchCached(account, now, `usage endpoint returned ${res.status}`);
        return { usage, outcome: 'cached' };
      }

      const body = await res.json();
      this.recordSuccess(account.accountId, now);
      const usage = parseUsageEndpointResponse(body, {
        accountId: account.accountId,
        label: account.label,
        active: account.active,
        quarantined: account.quarantined,
        fetchedAtMs: now,
        source: 'live',
      });
      return { usage, outcome: 'live' };
    } catch (err) {
      // Network error (fetch rejected) — transient, no backoff penalty; fall back to tier-0.
      this.recordSuccess(account.accountId, now);
      const message = err instanceof Error ? err.message : String(err);
      const usage = await this.fetchCached(
        account,
        now,
        `usage endpoint request failed: ${message}`,
      );
      return { usage, outcome: 'cached' };
    }
  }

  /** Remember an account's most recent real result so a later skipped cycle can return it
   *  unchanged. Mutates the timing-state entry that a `record*()` call just wrote. */
  private retain(accountId: string, usage: ParsedUsage): void {
    const state = this.state.get(accountId);
    if (state) state.lastResult = usage;
  }

  /** A best-effort error result for an account whose poll threw outright (e.g. a tier-0 disk
   *  read error). Reuses the tolerant parser for a well-formed empty shape, then stamps the
   *  real failure reason over its placeholder error — so the account is still reported rather
   *  than dropped along with every other account in the cycle. */
  private degradedResult(account: PollAccount, now: number, message: string): ParsedUsage {
    const parsed = parseCachedUsage(undefined, {
      accountId: account.accountId,
      label: account.label,
      active: account.active,
      quarantined: account.quarantined,
      fetchedAtMs: now,
      source: 'cached',
    });
    return {
      accountUsage: { ...parsed.accountUsage, error: message },
      advisorInput: parsed.advisorInput,
    };
  }

  /** Whether an account is due to be (re)polled. */
  private isDue(state: AccountPollState, now: number): boolean {
    return now >= state.nextDueAtMs;
  }

  private recordSuccess(accountId: string, now: number): void {
    this.state.set(accountId, {
      consecutive429s: 0,
      nextDueAtMs: now + POLL_FLOOR_MS + this.jitter(),
    });
  }

  private recordRateLimited(accountId: string, now: number): void {
    const prior = this.state.get(accountId);
    const consecutive429s = (prior?.consecutive429s ?? 0) + 1;
    // Exponential backoff from the base, capped. The floor is a hard minimum wait — backoff
    // only extends the wait once it grows past what the floor already enforces.
    const backoffMs = Math.min(BACKOFF_BASE_MS * 2 ** (consecutive429s - 1), BACKOFF_CAP_MS);
    this.state.set(accountId, {
      consecutive429s,
      nextDueAtMs: now + Math.max(POLL_FLOOR_MS, backoffMs) + this.jitter(),
    });
  }

  private jitter(): number {
    return Math.floor(this.random() * POLL_JITTER_MS);
  }

  /** Fall back to the tier-0 cached usage payload for an account. `extraError`, when given,
   *  is prepended so the reason for falling back survives into the reported `AccountUsage`. */
  private async fetchCached(
    account: PollAccount,
    now: number,
    extraError?: string,
  ): Promise<ParsedUsage> {
    const raw = await this.getCachedUsage(account.accountId);
    const parsed = parseCachedUsage(raw, {
      accountId: account.accountId,
      label: account.label,
      active: account.active,
      quarantined: account.quarantined,
      fetchedAtMs: now,
      source: 'cached',
    });
    if (extraError === undefined) return parsed;
    const combinedError = parsed.accountUsage.error
      ? `${extraError}; ${parsed.accountUsage.error}`
      : extraError;
    return {
      accountUsage: { ...parsed.accountUsage, error: combinedError },
      advisorInput: parsed.advisorInput,
    };
  }
}

/** Overwrite a retained result's identity flags with the caller's current ones. Usage
 *  numbers age with the poll floor; WHO is active does not — it changes the instant a
 *  switch commits, and both frontends and the auto-switcher must see that immediately. */
function restampIdentity(usage: ParsedUsage, account: PollAccount): ParsedUsage {
  return {
    accountUsage: {
      ...usage.accountUsage,
      label: account.label,
      active: account.active,
    },
    advisorInput: {
      ...usage.advisorInput,
      label: account.label,
      active: account.active,
      quarantined: account.quarantined,
    },
  };
}

/** Build the `usage.snapshot` envelope payload from a poll result — kept separate from
 *  `UsagePoller` so daemon.ts can wire it without the poller needing to know about envelopes. */
export function toUsageSnapshotPayload(snapshot: SnapshotResult): {
  accounts: AccountUsage[];
  plan: UsagePlan;
} {
  return { accounts: snapshot.accounts, plan: snapshot.plan };
}
