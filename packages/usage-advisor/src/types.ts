// Types for the burn-down optimizer.
//
// The advisor is a PURE function of a moment's usage snapshot: given each account's limits
// and when they reset, it decides which account to use right now and what to warn about.
// It holds no state and does no IO, so it is fully deterministic and unit-testable — the
// daemon feeds it a snapshot and ships the resulting plan to the phone.
//
// Convention: `percent` everywhere means percent USED (0–100). Headroom is `100 - percent`.
// This matches the OAuth usage endpoint, which reports utilization, not remaining.

/** One usage limit for an account, as normalized from the usage endpoint. */
export interface LimitInput {
  kind: 'session' | 'weekly_all' | 'weekly_scoped';
  /** Percent of this limit already consumed, 0–100. */
  percent: number;
  /** Epoch ms when this limit rolls back to zero, if known. */
  resetsAt?: number;
}

/** One account's usage at the moment the plan is computed. */
export interface AccountUsageInput {
  accountId: string;
  label: string;
  /** True if this is the account whose credentials are currently live. */
  active: boolean;
  /** A quarantined account has a dead refresh token and cannot be used until re-login. */
  quarantined: boolean;
  limits: LimitInput[];
  /** Epoch ms when this snapshot's limits were actually READ (live poll time, or the cache's
   *  own stamp when serving fallback data). Usage only grows between reads, so an old stamp
   *  means the true percents are AT LEAST what `limits` says — the auto-switch policy tightens
   *  its trigger on stale data rather than trusting numbers from a blind spot. Absent = treat
   *  as fresh (callers that predate the field never see derated behavior). */
  fetchedAtMs?: number;
}

/** Knobs governing the recommendation. Defaults live in `advisor.ts`; override for tuning/tests. */
export interface AdvisorOptions {
  now?: () => number;
  /** True when the daemon is running `--auto-switch --greedy`: the burn plan is then being
   *  EXECUTED automatically, so advice reads descriptive ("Greedy auto-switch burns A → B")
   *  instead of imperative ("Burn A → B"). Display-only — the queue itself is identical. */
  greedyAutoSwitch?: boolean;
  /** A reset within this window counts as "imminent" — its unused quota is at risk. */
  urgentWindowMs?: number;
  /** Only advise burning when at least this much of a limit is still unused. */
  significantUnusedPct?: number;
  /** Headroom at/below this is "near the cap" — risky to start fresh work on. */
  riskHeadroomPct?: number;
  /** Headroom below this means the account is effectively exhausted (not usable now). */
  minUsableHeadroomPct?: number;
}

/** One account's place in the ranking. Higher `score` = better to use right now. */
export interface AccountScore {
  accountId: string;
  label: string;
  score: number;
  /** Remaining capacity now, 0–100 — the min across the account's limits (the binding one). */
  headroomPct: number;
  weeklyResetAt?: number;
  sessionResetAt?: number;
  note: string;
}

export type AdvisoryKind =
  'burn_before_reset' | 'switch_now' | 'exhausted' | 'all_healthy' | 'quarantined';

/** One actionable note for the phone. `deadlineMs` is when the window to act closes. */
export interface Advisory {
  kind: AdvisoryKind;
  accountId?: string;
  message: string;
  deadlineMs?: number;
}

/** The advisor's full recommendation for this moment. */
export interface UsagePlan {
  /** Which account to use now, or null if none is usable. */
  recommendedAccountId: string | null;
  /** One human sentence explaining the recommendation. */
  reason: string;
  /** Every account scored, best first. */
  ranking: AccountScore[];
  advisories: Advisory[];
  generatedAtMs: number;
}
