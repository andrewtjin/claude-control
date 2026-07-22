// @claude-control/session-runtime — run and control Claude Code sessions behind one
// SessionHandle interface, whether they're driven directly (managed, via the Agent SDK)
// or watched over someone's shoulder (observed, via a ConPTY terminal).
//
// Public surface only below — internal helpers (persistence, the fake-friendly seams'
// concrete adapters' private types) stay in their own modules.

export type {
  SessionState,
  SessionKind,
  SessionRecord,
  SessionEvent,
  SessionHandle,
  PermissionDecision,
  PermissionResolveOutcome,
  PermissionRequest,
  QuestionOption,
  QuestionPrompt,
  QuestionRequest,
  QuestionAnswer,
  QuestionResolution,
} from './types.js';

export { parseQuestions, composeAnswers } from './questions.js';

export {
  stripAnsi,
  splitCompleteLines,
  collapseRepeats,
  classifyLine,
  summarizeText,
} from './summarizer.js';

export { startManagedSession } from './managedSession.js';
export type {
  AgentSdkEvent,
  AgentSdkQueryOptions,
  AgentSdkClient,
  ManagedSessionOptions,
} from './managedSession.js';

export { createAgentSdkClient } from './agentSdkClient.js';
export type { CreateAgentSdkClientDeps } from './agentSdkClient.js';

export { escalateStop } from './stopEscalation.js';
export type { StopRung, StopEscalationResult, EscalateStopOptions } from './stopEscalation.js';

export { attachObservedSession, createNodePtyFactory } from './observedSession.js';
export type {
  PtySpawnOptions,
  PtyExitInfo,
  PtyHandle,
  PtyFactory,
  PtyFactoryResult,
  ObservedSessionOptions,
} from './observedSession.js';

export { createSessionManager } from './sessionManager.js';
export type {
  SessionManager,
  SessionManagerOptions,
  SpawnManagedOptions,
  AttachObservedOptions,
  ResumeOrphanOptions,
} from './sessionManager.js';
