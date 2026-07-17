// The wire contract between daemons and the control-plane bot.
//
// Every frame is an envelope: common routing fields (version, id, timestamp, which
// daemon, which Discord user) plus a `type` discriminant and a `type`-specific payload.
// A single `Envelope` discriminated union validates the whole frame in one parse, so a
// malformed or unknown message is rejected at the boundary and never reaches handlers.
//
// This is the ONLY module the bot imports from any package — it must stay free of
// credential- or Node-specific code so "the bot holds zero credentials" is structural.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared scalars
// ---------------------------------------------------------------------------

export const AccountId = z.string().min(1);
export const SessionId = z.string().min(1);
export const RequestId = z.string().min(1);
export const IdempotencyKey = z.string().min(1);

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

export const UsageLimitKind = z.enum(['session', 'weekly_all', 'weekly_scoped']);

/**
 * One limit line as normalized from the OAuth usage endpoint. `percent` is given a
 * tolerant upper bound: the endpoint is undocumented, so we clamp for sanity but never
 * reject a snapshot just because Anthropic changed the scale (that would blind the poller).
 */
export const UsageLimit = z.object({
  kind: UsageLimitKind,
  percent: z.number().min(0).max(1000),
  severity: z.string().nullish(),
  resetsAt: z.string().nullish(),
  scope: z.string().nullish(),
  isActive: z.boolean().default(true),
});

/** Per-account usage as the daemon reports it to the phone. `source` records whether the
 *  numbers are live (endpoint) or cached (tier-0 `~/.claude.json`), with a fetch timestamp
 *  so the UI can label staleness rather than pretend cached data is fresh. */
export const AccountUsage = z.object({
  accountId: AccountId,
  label: z.string(),
  active: z.boolean(),
  source: z.enum(['live', 'cached']),
  fetchedAtMs: z.number().int().nonnegative(),
  limits: z.array(UsageLimit),
  error: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Usage plan (the burn-down optimizer's recommendation)
// ---------------------------------------------------------------------------

export const UsageAdvisoryKind = z.enum([
  'burn_before_reset',
  'switch_now',
  'exhausted',
  'all_healthy',
  'quarantined',
]);

/** One actionable note from the advisor, e.g. "burn account A before its weekly reset". */
export const UsageAdvisory = z.object({
  kind: UsageAdvisoryKind,
  accountId: AccountId.nullish(),
  message: z.string(),
  /** Epoch ms by which to act (e.g. the reset that would strand unused quota). */
  deadlineMs: z.number().int().nonnegative().nullish(),
});

/** One account's score in the ranking. Higher score = better to use right now. */
export const AccountScore = z.object({
  accountId: AccountId,
  label: z.string(),
  score: z.number(),
  /** Remaining capacity right now, 0–100, as the min across active limits. */
  headroomPct: z.number(),
  weeklyResetAt: z.number().int().nonnegative().nullish(),
  sessionResetAt: z.number().int().nonnegative().nullish(),
  note: z.string(),
});

/** The advisor's full recommendation: which account to use now, why, the ranking, advisories. */
export const UsagePlan = z.object({
  recommendedAccountId: AccountId.nullish(),
  reason: z.string(),
  ranking: z.array(AccountScore),
  advisories: z.array(UsageAdvisory),
});

// ---------------------------------------------------------------------------
// Payloads (per message type)
// ---------------------------------------------------------------------------

const UsageSnapshotPayload = z.object({
  accounts: z.array(AccountUsage),
  /** The optimizer's recommendation, when the daemon has computed one. */
  plan: UsagePlan.nullish(),
});

const SwitchCommandPayload = z.object({
  requestId: RequestId,
  targetAccountId: AccountId,
  reason: z.enum(['near_cap', 'manual']).default('manual'),
  idempotencyKey: IdempotencyKey,
});

/** The daemon's honest report of what a switch actually did. `outcome` distinguishes a
 *  live hot-swap from a change that only takes effect on next launch — the UX copy on the
 *  phone depends on which one happened, so it is never collapsed into a bare ok/fail. */
const SwitchResultPayload = z.object({
  requestId: RequestId,
  ok: z.boolean(),
  outcome: z.enum(['hot_applied', 'staged_next_launch', 'resumed_session', 'failed']),
  activeAccountId: AccountId,
  message: z.string(),
  error: z.string().nullish(),
});

const PermissionRequestPayload = z.object({
  requestId: RequestId,
  sessionId: SessionId,
  tool: z.string(),
  summary: z.string(),
  detail: z.string().nullish(),
  cwd: z.string().nullish(),
  expiresAt: z.number().int().nonnegative().nullish(),
  /** The session's Claude Code permission mode (hook field `permission_mode`), e.g.
   *  'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'. A tolerant string, not an
   *  enum: Claude ships new modes without notice, and rejecting the whole frame over an
   *  unknown mode would blind the phone to a real request. The bot's contract (plan §4):
   *  approve/deny buttons ONLY when this is exactly 'default'; absent or unrecognized
   *  modes get an informational card — fail-safe, never a button that lies. */
  permissionMode: z.string().min(1).nullish(),
});

const PermissionResponsePayload = z.object({
  requestId: RequestId,
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']).default('once'),
  idempotencyKey: IdempotencyKey,
});

const PromptInjectPayload = z.object({
  sessionId: SessionId,
  text: z.string().min(1),
  idempotencyKey: IdempotencyKey,
});

const SessionSpawnPayload = z.object({
  requestId: RequestId,
  prompt: z.string().min(1),
  resumeSessionId: SessionId.nullish(),
  cwd: z.string().nullish(),
  accountId: AccountId.nullish(),
  idempotencyKey: IdempotencyKey,
});

/** Long output is a presentation problem, not a wire problem (decision, plan §4 "no silent
 *  truncation"): the daemon streams ALL output as ordered `seq` chunks and never drops text;
 *  when accumulated output crosses its inline-display threshold the BOT re-materializes the
 *  chunks as a file attachment. No attachment wire type exists — attachments would duplicate
 *  the chunk stream's content while adding a second delivery path to keep honest. `truncated`
 *  stays as the daemon's explicit marker for the rare case a source itself truncated (e.g. a
 *  capped scrollback), so the UI can label the gap instead of pretending completeness. */
const SessionOutputPayload = z.object({
  sessionId: SessionId,
  seq: z.number().int().nonnegative(),
  kind: z.enum(['stdout', 'milestone', 'summary', 'error']),
  text: z.string(),
  truncated: z.boolean().default(false),
});

/** Phone-initiated stop of a managed session. Deliberately minimal: escalation semantics
 *  (interrupt → grace window → hard stop) are a daemon policy, not a wire choice, and the
 *  acknowledgment rides on the `session.status` transitions the daemon already emits
 *  (running → done/failed) — a dedicated stop.result would be a second source of truth.
 *  `idempotencyKey` lets a double-tapped Stop button resolve to "already handled". */
const SessionStopPayload = z.object({
  sessionId: SessionId,
  idempotencyKey: IdempotencyKey,
});

const SessionStatusPayload = z.object({
  sessionId: SessionId,
  state: z.enum([
    'starting',
    'running',
    'waiting_input',
    'waiting_permission',
    'done',
    'failed',
    'orphaned',
  ]),
  accountId: AccountId.nullish(),
  resumeId: SessionId.nullish(),
  summary: z.string().nullish(),
});

/** Widened (not split into done/waiting variants) on purpose: title/body/level stays the one
 *  required contract every bot version can render, so an N-1 bot shows a plain notification
 *  where a current bot shows a rich done/waiting card. New variant TYPES would instead be
 *  dropped whole by the older peer's envelope parse — a silent notification loss. */
const HookNotificationPayload = z.object({
  event: z.enum(['permission', 'stop', 'notification']),
  sessionId: SessionId.nullish(),
  title: z.string(),
  body: z.string(),
  level: z.enum(['info', 'warn', 'success']).default('info'),
  /** Raw hook `notification_type` (e.g. 'idle_prompt'). Tolerant string for the same reason
   *  as `permissionMode`: the bot keys "waiting on you" cards off known values and falls back
   *  to the generic card for anything else — never rejects the frame. */
  notificationType: z.string().min(1).nullish(),
  /** On Stop events: the hook's `last_assistant_message`, so the done card can show WHAT
   *  Claude finished saying rather than a bare "session ended". */
  lastAssistantMessage: z.string().nullish(),
});

// ---- control frames (socket lifecycle; not user-facing) ----

const HelloPayload = z.object({
  protocolVersion: z.number().int().positive(),
  daemonToken: z.string().min(1),
});

const HelloResultPayload = z.object({
  ok: z.boolean(),
  negotiatedVersion: z.number().int().positive().nullish(),
  error: z.string().nullish(),
});

const PairClaimPayload = z.object({
  pairingCode: z.string().min(1),
  hostLabel: z.string(),
});

const PairResultPayload = z.object({
  ok: z.boolean(),
  /** The daemon id the BOT assigned at pairing. The daemon adopts this as its identity for
   *  all later frames — it is minted server-side so a claimer can never name another user's
   *  daemon (which would otherwise allow a cross-user binding hijack). */
  daemonId: z.string().nullish(),
  daemonToken: z.string().nullish(),
  discordUserId: z.string().nullish(),
  error: z.string().nullish(),
});

const PingPayload = z.object({ nonce: z.string().nullish() });
const PongPayload = z.object({ nonce: z.string().nullish() });

const ErrorPayload = z.object({
  code: z.string(),
  message: z.string(),
  relatesTo: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Envelope
// ---------------------------------------------------------------------------

/** Routing fields present on every frame. `discordUserId` is stamped server-side by the
 *  bot from `interaction.user.id`; a daemon never sets it (and cannot forge another user's
 *  id) — it is absent on the daemon→bot handshake before a binding exists. */
const EnvelopeBase = {
  v: z.number().int().positive(),
  id: z.string().min(1),
  ts: z.number().int().nonnegative(),
  daemonId: z.string().min(1),
  discordUserId: z.string().min(1).nullish(),
};

/** Build one envelope variant: base fields + a literal `type` + its payload. */
function frame<T extends string, P extends z.ZodTypeAny>(type: T, payload: P) {
  return z.object({ ...EnvelopeBase, type: z.literal(type), payload });
}

export const messageSchemas = {
  'usage.snapshot': frame('usage.snapshot', UsageSnapshotPayload),
  'switch.command': frame('switch.command', SwitchCommandPayload),
  'switch.result': frame('switch.result', SwitchResultPayload),
  'permission.request': frame('permission.request', PermissionRequestPayload),
  'permission.response': frame('permission.response', PermissionResponsePayload),
  'prompt.inject': frame('prompt.inject', PromptInjectPayload),
  'session.spawn': frame('session.spawn', SessionSpawnPayload),
  'session.output': frame('session.output', SessionOutputPayload),
  'session.status': frame('session.status', SessionStatusPayload),
  'session.stop': frame('session.stop', SessionStopPayload),
  'hook.notification': frame('hook.notification', HookNotificationPayload),
  hello: frame('hello', HelloPayload),
  'hello.result': frame('hello.result', HelloResultPayload),
  'pair.claim': frame('pair.claim', PairClaimPayload),
  'pair.result': frame('pair.result', PairResultPayload),
  ping: frame('ping', PingPayload),
  pong: frame('pong', PongPayload),
  error: frame('error', ErrorPayload),
} as const;

/** The full frame schema. One `.parse` validates routing + type + payload together. */
export const Envelope = z.discriminatedUnion('type', [
  messageSchemas['usage.snapshot'],
  messageSchemas['switch.command'],
  messageSchemas['switch.result'],
  messageSchemas['permission.request'],
  messageSchemas['permission.response'],
  messageSchemas['prompt.inject'],
  messageSchemas['session.spawn'],
  messageSchemas['session.output'],
  messageSchemas['session.status'],
  messageSchemas['session.stop'],
  messageSchemas['hook.notification'],
  messageSchemas.hello,
  messageSchemas['hello.result'],
  messageSchemas['pair.claim'],
  messageSchemas['pair.result'],
  messageSchemas.ping,
  messageSchemas.pong,
  messageSchemas.error,
]);

// ---------------------------------------------------------------------------
// Inferred types
// ---------------------------------------------------------------------------

export type Envelope = z.infer<typeof Envelope>;
export type MessageType = Envelope['type'];

/** Narrow the envelope union to a single message type — e.g. `MessageOf<'switch.command'>`. */
export type MessageOf<T extends MessageType> = Extract<Envelope, { type: T }>;
export type PayloadOf<T extends MessageType> = MessageOf<T>['payload'];

export type UsageLimit = z.infer<typeof UsageLimit>;
export type AccountUsage = z.infer<typeof AccountUsage>;
export type UsageAdvisory = z.infer<typeof UsageAdvisory>;
export type AccountScore = z.infer<typeof AccountScore>;
export type UsagePlan = z.infer<typeof UsagePlan>;

/** Runtime membership test for the discriminant — useful at socket boundaries. */
export function isMessageType(value: string): value is MessageType {
  return Object.prototype.hasOwnProperty.call(messageSchemas, value);
}
