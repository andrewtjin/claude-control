// Public surface of the burn-down optimizer.
export * from './types.js';
export { computePlan } from './advisor.js';
export {
  decideAutoSwitch,
  DEFAULT_TRIGGER_PERCENT,
  DEFAULT_MIN_SESSION_HEADROOM_PCT,
  DEFAULT_GREEDY_RESET_MARGIN_MS,
  type AutoSwitchDecision,
  type AutoSwitchPolicy,
} from './autoswitch.js';
export { humanizeDuration, roundPct } from './format.js';
export { severityOf, worstSeverity, type Severity } from './severity.js';
export { computePacing, type AccountPacing, type Pacing, type PacingVerdict } from './pacing.js';
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
