// Public surface of the burn-down optimizer.
export * from './types.js';
export { computePlan } from './advisor.js';
export { humanizeDuration, roundPct } from './format.js';
export {
  SESSION_WINDOW_MS,
  computeOutlook,
  renderOutlook,
  renderPlanSummary,
  timelineInputFromWire,
  type AccountOutlook,
  type RenderOutlookOptions,
  type ResetEvent,
  type ResetOutlook,
  type SessionWindowBudget,
  type WireUsageLike,
} from './timeline.js';
