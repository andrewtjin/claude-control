// Public surface of the burn-down optimizer.
export * from './types.js';
export { computePlan } from './advisor.js';
export {
  decideAutoSwitch,
  hasUsableHeadroom,
  MIN_USABLE_HEADROOM_PCT,
  DEFAULT_TRIGGER_PERCENT,
  DEFAULT_STALE_TRIGGER_PERCENT,
  DEFAULT_STALE_AFTER_MS,
  DEFAULT_MIN_SESSION_HEADROOM_PCT,
  DEFAULT_GREEDY_RESET_MARGIN_MS,
  DEFAULT_GREEDY_PREDICTED_RESET_MARGIN_MS,
  type AutoSwitchDecision,
  type AutoSwitchPolicy,
} from './autoswitch.js';
export { formatTokens, humanizeDaysUntil, humanizeDuration, roundPct } from './format.js';
export {
  planWeight,
  type PlanTierSignals,
  type PlanWeightResult,
  type PlanWeightSource,
} from './planWeight.js';
export {
  billingLabel,
  estimateNextBillingMs,
  planLabel,
  type BillingSignals,
} from './planBilling.js';
export { severityOf, worstSeverity, type Severity } from './severity.js';
export {
  computePacing,
  renderPacingSummary,
  PACING_HORIZON_DAYS,
  PLAIN_PACING_STYLE,
  type AccountPacing,
  type Pacing,
  type PacingExclusion,
  type PacingOptions,
  type PacingStyle,
  type PacingVerdict,
  type PacingWaste,
} from './pacing.js';
export { selectWeeklyBudget, type WeeklyBudget } from './weekly.js';
export {
  PLAIN_OUTLOOK_STYLE,
  SESSION_WINDOW_MS,
  computeOutlook,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
  type AccountOutlook,
  type OutlookStyle,
  type RenderOutlookOptions,
  type ResetEvent,
  type ResetOutlook,
  type SessionWindowBudget,
  type WireUsageLike,
} from './timeline.js';
