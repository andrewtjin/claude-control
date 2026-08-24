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
  /** True when the operator has taken this account out of the auto-switch TARGET pool. Unlike
   *  `quarantined` it says nothing about the account's health: it is perfectly usable, and a
   *  deliberate switch (CLI or phone) still goes there. It only bars the UNATTENDED hop, so it
   *  gates where auto-switch may go — never whether the account may be left. Absent = not
   *  excluded, so callers predating the field behave exactly as before. */
  autoSwitchExcluded?: boolean;
  limits: LimitInput[];
  /** Epoch ms when this snapshot's limits were actually READ (live poll time, or the cache's
   *  own stamp when serving fallback data). Usage only grows between reads, so an old stamp
   *  means the true percents are AT LEAST what `limits` says — the auto-switch policy tightens
   *  its trigger on stale data rather than trusting numbers from a blind spot. Absent = treat
   *  as fresh (callers that predate the field never see derated behavior). */
  fetchedAtMs?: number;
  /** This account's weekly allowance in Pro-equivalent units: a "Wx Pro" plan holds W units
   *  per weekly window. The usage endpoint reports `percent` of the account's OWN limit and
   *  carries no absolute allowance anywhere, so averaging percents across a Pro account and a
   *  Max 20x account would weight them equally — wrong by up to 20x. Resolved by the caller
   *  from the registry's plan tier. Absent = unknown, which every consumer must treat as 1
   *  AND say so: silent equal-weighting is the bug this field exists to kill. */
  weight?: number;
  /** Epoch ms of this account's next weekly reset as PREDICTED from stored history, used only
   *  when the endpoint reports no future reset of its own. The endpoint stops publishing
   *  `resets_at` once an account's weekly window closes and does not republish until the
   *  account is used again — but the cadence is a fixed 7 days anchored per account, so the
   *  next reset is derivable by advancing the last observed one. Prediction reads history, so
   *  it happens at the edge (see the CLI's usage-history helpers); this module only consumes
   *  the result and always labels it as predicted, never as observed. */
  predictedResetAt?: number;
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
