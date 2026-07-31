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
 *  so the UI can label staleness rather than pretend cached data is fresh.
 *
 *  Deliberately carries NO monetary fields. The usage endpoint also returns an extra-usage
 *  credit `spend` block, but this envelope is relayed in cleartext through a host that is not
 *  the user's (see `docs/THREAT_MODEL.md`, "In-transit visibility"), so per-account dollar
 *  amounts must not ride along until something actually renders them — the privacy cost is
 *  paid the moment the field is populated, not the moment it is read. */
export const AccountUsage = z.object({
  accountId: AccountId,
  label: z.string(),
  active: z.boolean(),
  source: z.enum(['live', 'cached']),
  fetchedAtMs: z.number().int().nonnegative(),
  limits: z.array(UsageLimit),
  error: z.string().nullish(),
  /** Epoch ms of this account's next weekly reset, DERIVED by the daemon from its stored
   *  snapshot history. The endpoint stops publishing `resets_at` once an account's weekly
   *  window closes, so the accounts holding a full untouched allowance are exactly the ones
   *  that report no reset — and only the daemon holds the history to derive one. Additive and
   *  tolerant like `epoch`/`permissionMode`: a daemon predating this field omits it and the
   *  phone says the reset is unknown rather than inventing one. Consumers must always label
   *  it as predicted; it is never an endpoint observation. */
  predictedResetAt: z.number().int().nonnegative().nullish(),
  /** The account's relative plan capacity (Pro = 1, Max 20x = 20), resolved by the daemon from
   *  the registry's tier signals. The bot cannot derive it: the signals live in the local vault,
   *  never on the wire. Absent means the tier could not be resolved, which every renderer shows
   *  as "?" — an account of unknown tier is still weighted 1 in aggregate math, and saying "1x"
   *  would present that fallback as a reading. Additive and tolerant like `predictedResetAt`. */
  planWeight: z.number().positive().finite().nullish(),
  /** The billing cell as the daemon rendered it, e.g. "~Aug 11 (est.)" / "trial->Aug 3" /
   *  "unknown". Pre-rendered rather than sent as raw dates because the estimate is a derivation
   *  with rules (anniversary roll-forward, short-month clamping, trials outranking
   *  subscriptions) that must not be reimplemented on a second surface — the same reason
   *  `SettingRow` ships display text. Display-only: nothing routes or authorizes on it. */
  billing: z.string().nullish(),
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
// Token stats (absolute counts read from local Claude Code transcripts)
// ---------------------------------------------------------------------------
//
// Every `AccountUsage` number above is a PERCENT of an opaque limit. These are absolute token
// counts the daemon reads out of Claude Code's own transcript files on the host and attributes to
// accounts through its switch-audit journal. Only the AGGREGATE crosses the wire: the bot must
// never read a transcript (they contain conversation text, and the bot holds nothing privileged),
// so it receives sums and nothing else.

/** One bucket's token counts. The four token kinds stay separate all the way to the wire: they
 *  are separate fields upstream, they are billed differently, and cache reads outweigh plain
 *  input by orders of magnitude — folding them into one number destroys the only useful signal. */
export const TokenTotals = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheCreation: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  /** Assistant turns counted (after de-duplication), so a reader can sanity-check the sums. */
  turns: z.number().int().nonnegative(),
});

/** Totals for one account. `accountId` is null for the UNATTRIBUTED bucket — turns that happened
 *  before cctl recorded its first switch, which have no account they can honestly be assigned to.
 *  That bucket is carried on the wire (rather than dropped) precisely so every surface can render
 *  it: silently omitting it would make the per-account numbers look like the whole truth. */
export const TokenAccountRow = z.object({
  accountId: AccountId.nullish(),
  label: z.string(),
  totals: TokenTotals,
});

/** Totals for one model id, or one local calendar day (`YYYY-MM-DD`). */
export const TokenBucketRow = z.object({
  label: z.string(),
  totals: TokenTotals,
});

/** What the scan could and could not read. Sent so the phone can say so out loud — a total over
 *  40 of 442 transcript files is a different claim from the same total over all 442. */
export const TokenStatsCoverage = z.object({
  filesScanned: z.number().int().nonnegative(),
  filesSkippedByMtime: z.number().int().nonnegative(),
  filesUnreadable: z.number().int().nonnegative(),
  /** Project directories that could not even be listed (permission denied, a stale mount) — a
   *  distinct failure mode from an unreadable FILE: it can hide an entire project's transcripts. */
  dirsUnreadable: z.number().int().nonnegative(),
  malformedLines: z.number().int().nonnegative(),
  duplicateTurns: z.number().int().nonnegative(),
});

/**
 * Absolute token usage over a window, broken down by account, model and day.
 *
 * HONEST LIMITS, which every renderer of this payload must state: these are the turns Claude Code
 * wrote to disk ON THIS MACHINE. Work done from the web app, the mobile app or another machine is
 * invisible here, turns predating the first recorded switch land in the unattributed bucket, and
 * none of it is an authoritative billing figure from Anthropic.
 */
export const TokenStatsSnapshot = z.object({
  windowStartMs: z.number().int().nonnegative(),
  /** End of the window, i.e. when the scan ran — the payload's "as of". */
  windowEndMs: z.number().int().nonnegative(),
  overall: TokenTotals,
  byAccount: z.array(TokenAccountRow),
  byModel: z.array(TokenBucketRow),
  byDay: z.array(TokenBucketRow),
  coverage: TokenStatsCoverage,
});

/** How many days back a stats window covers when nobody says otherwise — the daemon's pushed
 *  snapshot, `cctl stats`, and `/stats` with no `days` all use this one number. Lives in the wire
 *  contract rather than in each package because the three surfaces are only comparable if their
 *  default window is literally the same; three local copies would drift silently. */
export const DEFAULT_STATS_DAYS = 7;
/** Bounds on an explicitly requested window. The floor is one day because a window is counted in
 *  whole local days. The ceiling is a real cost guard, not a formality: a request makes the HOST
 *  re-read every transcript touched inside the window, so an unbounded value turns one slash
 *  command into a full-history disk scan. 90 days answers any "what did this quarter cost" question
 *  while keeping the worst case bounded. Enforced in three places, deliberately: Discord rejects
 *  out-of-range input client-side, this schema rejects a hand-crafted frame, and the daemon clamps
 *  what it actually scans — the outer two are UX, the daemon's is the one that protects the disk. */
export const MIN_STATS_DAYS = 1;
export const MAX_STATS_DAYS = 90;

/** Phone-initiated request for a token-stats window OTHER than the one the daemon pushes on its
 *  own schedule. There is no idempotency key: a scan is read-only and changes nothing, so a
 *  replayed frame costs a redundant scan at worst — and unlike a prune, silently ignoring a
 *  duplicate would strand the phone's deferred reply waiting for a result that never comes. */
const TokenStatsRequestPayload = z.object({
  requestId: RequestId,
  days: z.number().int().min(MIN_STATS_DAYS).max(MAX_STATS_DAYS),
});

/** The daemon's answer to stats.request. Correlated by `requestId` because the asking surface is
 *  a single Discord interaction waiting on THIS scan — unlike the pushed `stats.snapshot`, which
 *  is addressed to nobody in particular and answers whoever asks next. A failure is reported
 *  explicitly (`ok: false` + reason) rather than by silence: the phone is holding a deferred reply
 *  open, and "the scan failed" is a far better thing to show than a spinner that times out. */
const TokenStatsResultPayload = z.object({
  requestId: RequestId,
  ok: z.boolean(),
  /** The window that was actually scanned; absent when `ok` is false. */
  snapshot: TokenStatsSnapshot.nullish(),
  error: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Settings (the daemon's effective configuration, for visibility only)
// ---------------------------------------------------------------------------

/** Where a setting's effective value came from — the whole point of the settings view is
 *  distinguishing a deliberate override (config/env/flag) from a silent default. Listed in
 *  ascending precedence: when two sources supply a value, the later one wins. */
export const SettingSource = z.enum(['default', 'config', 'env', 'flag']);

/** One knob, pre-rendered by the daemon: a human name, the effective value as display text
 *  (e.g. "on", "94% used", "10m"), and its source. `detail` names how to change it (the env
 *  var / flag), so the view teaches its own configuration surface. Display-only: nothing
 *  routes or authorizes on these strings. */
export const SettingRow = z.object({
  name: z.string().min(1),
  value: z.string(),
  source: SettingSource,
  detail: z.string().nullish(),
});

// ---------------------------------------------------------------------------
// Payloads (per message type)
// ---------------------------------------------------------------------------

const UsageSnapshotPayload = z.object({
  accounts: z.array(AccountUsage),
  /** The optimizer's recommendation, when the daemon has computed one. */
  plan: UsagePlan.nullish(),
  /** Fleet-wide burn in Pro-equivalent units/day, MEASURED by the daemon from stored snapshot
   *  history. The pacing model returns no sustainability verdict without it, and the bot can
   *  never measure it itself: it holds no history and must not read the daemon's database.
   *  Fractional by nature (a rate), and finite-bounded because a non-finite number serializes
   *  to `null` and would fail the peer's own parse. Absent means "not measurable", which the
   *  model reports as such — never as zero, which would read as "nothing is being used". */
  burnUnitsPerDay: z.number().finite().nonnegative().nullish(),
});

/** The daemon's effective settings, resolved once at startup (flags and env are read only
 *  then, so the report is immutable for the life of the run). `startedAtMs` dates the
 *  report — the phone shows "as of daemon start", never pretending settings are live.
 *  Exported (unlike the other payload schemas) because the daemon persists this exact
 *  shape to disk for `cctl settings`, which re-validates it with the same schema. */
export const SettingsSnapshot = z.object({
  startedAtMs: z.number().int().nonnegative(),
  settings: z.array(SettingRow),
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
   *  unknown mode would blind the phone to a real request. Display context only: the card
   *  keeps its Approve/Deny buttons in every mode — a request only exists while the CLI is
   *  actually blocking on a prompt — so the bot shows the mode on the card instead of
   *  gating the controls on it. */
  permissionMode: z.string().min(1).nullish(),
});

const PermissionResponsePayload = z.object({
  requestId: RequestId,
  decision: z.enum(['allow', 'deny']),
  scope: z.enum(['once', 'session']).default('once'),
  idempotencyKey: IdempotencyKey,
});

/** A held permission's hold ended WITHOUT a phone decision — the daemon's honest signal that
 *  the card's Approve/Deny buttons are now dead and must stop claiming otherwise. `reason`
 *  names WHY so the bot's edit can say something true: `local` (the operator answered at the
 *  terminal — detected where the hook's response socket closes while still held), `expired`
 *  (the hold window's own timer fired first), `shutdown` (the daemon closed while the hold was
 *  still open). Never sent for a permission the phone actually decided. */
const PermissionLapsedPayload = z.object({
  requestId: RequestId,
  reason: z.enum(['local', 'expired', 'shutdown']),
});

/** One selectable option of an AskUserQuestion question, as the CLI's tool_input carries
 *  it. `description` is display context for the picker; only `label` round-trips into the
 *  answer. */
const QuestionOption = z.object({
  label: z.string().min(1),
  description: z.string().nullish(),
});

/** One question from AskUserQuestion's `tool_input.questions`. The CLI contract says 2–4
 *  options and an optional short `header`, but both bounds are left tolerant here — the
 *  tool ships new shapes without notice, and rejecting the frame would strand the session
 *  on an unanswerable prompt. The BOT clamps whatever arrives to what Discord can render;
 *  the daemon never re-validates the CLI's own input. */
const Question = z.object({
  question: z.string().min(1),
  header: z.string().nullish(),
  multiSelect: z.boolean().default(false),
  options: z.array(QuestionOption).min(1),
});

/** Claude asked the user something (AskUserQuestion) and the session is blocked on the
 *  answer. Mirrors `permission.request`: same hold-and-resolve lifecycle, but the payload
 *  carries the full structured questions so the phone can render real pickers instead of
 *  Approve/Deny. Questions are capped at 4 by the tool's contract; the bot additionally
 *  clamps (never rejects) oversized frames because a lost question card blocks the
 *  session until the hold lapses. */
const QuestionRequestPayload = z.object({
  requestId: RequestId,
  sessionId: SessionId,
  questions: z.array(Question).min(1),
  cwd: z.string().nullish(),
  expiresAt: z.number().int().nonnegative().nullish(),
  /** Same tolerant-string contract as permission.request's permissionMode. */
  permissionMode: z.string().min(1).nullish(),
});

/** One answered question. `question` echoes the question TEXT (not an index) because that
 *  is exactly the key the CLI's `updatedInput.answers` map requires — indexes would make
 *  the daemon re-derive the mapping and drift if the tool reorders. `selected` holds
 *  chosen option labels (exactly 1 unless multiSelect); `otherText` is the free-form
 *  answer and wins over `selected` when present, matching the terminal picker where
 *  "Other" replaces a listed choice. */
const QuestionAnswer = z.object({
  question: z.string().min(1),
  selected: z.array(z.string()).default([]),
  otherText: z.string().nullish(),
});

/** The phone's answers for a `question.request`. Requires an entry per answered question;
 *  the daemon rejects a response that leaves any of the request's questions unanswered
 *  (a partial answer set would make the CLI re-prompt in the terminal, silently
 *  contradicting the card's "answered" state). */
const QuestionResponsePayload = z.object({
  requestId: RequestId,
  answers: z.array(QuestionAnswer).min(1),
  idempotencyKey: IdempotencyKey,
});

/** Same contract as permission.lapsed, for a held question: the hold ended with NO phone
 *  answer (`local`: answered at the terminal / socket died, `expired`: hold timer fired,
 *  `shutdown`: daemon closed) and the card's pickers are now dead. */
const QuestionLapsedPayload = z.object({
  requestId: RequestId,
  reason: z.enum(['local', 'expired', 'shutdown']),
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

/** Long output is a presentation problem, not a wire problem (decision: "no silent
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
  /** One opaque token per daemon RUN (process lifetime), stamped on every chunk. The per-session
   *  `seq` counter is in-memory and restarts at 0 when the daemon restarts, but a crashed daemon
   *  never emitted a terminal `session.status`, so a long-lived bot still holds reassembly state
   *  (its `nextSeq` advanced past 0) for that sessionId — and would silently swallow the resumed
   *  turn's low-seq chunks. The bot compares this token across chunks: a CHANGE means "same session,
   *  new daemon run" and it resets reassembly (with a visible marker) instead of dropping output.
   *  Additive + tolerant like `permissionMode`/`notificationType`: a pre-epoch daemon omits it and
   *  a current bot must treat its absence exactly as today (no reset). */
  epoch: z.string().min(1).nullish(),
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

/** Phone-initiated prune of DORMANT session records: every record resting in a terminal
 *  state (done/failed/orphaned), plus non-terminal leftovers whose owning process is gone
 *  (the daemon holds no live handle for them — records an earlier or parallel daemon run
 *  wrote and abandoned). A live session is untouchable by construction — live work always
 *  has a handle in the serving daemon. Pruning is registry-only: the underlying Claude
 *  conversation on the host survives; only the daemon's memory of the session (including
 *  its resume anchor) is dropped, so a pruned orphan can no longer be revived from the
 *  phone. */
const SessionPrunePayload = z.object({
  requestId: RequestId,
  idempotencyKey: IdempotencyKey,
});

/** The daemon's answer to session.prune. Unlike session.stop there IS a dedicated result
 *  envelope: pruned records DISAPPEAR rather than transition, so no session.status ack will
 *  ever come — and the bot needs the exact pruned ids to drop its own cached `/sessions`
 *  rows (its cache is fed by status pushes and would otherwise show the rows forever). */
const SessionPruneResultPayload = z.object({
  requestId: RequestId,
  ok: z.boolean(),
  /** Exactly the records that were removed; empty on a failed or no-op prune. */
  prunedSessionIds: z.array(SessionId),
  /** The registry's FULL post-prune view (every id it still holds). The pruned ids alone
   *  cannot clear a cached row for a session the daemon no longer knows AT ALL (its record
   *  was lost rather than pruned — e.g. clobbered registry, wiped state dir), and such
   *  ghosts would otherwise sit in the bot's `/sessions` list forever. When present, the
   *  bot drops every cached session NOT listed here; optional so a result from a daemon
   *  predating this field keeps its old pruned-ids-only meaning. */
  remainingSessionIds: z.array(SessionId).nullish(),
  error: z.string().nullish(),
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
  /** The `session.spawn` requestId this session was born from, echoed on its status frames.
   *  A spawn mints a NEW sessionId the requester has no other way to learn, so without this
   *  echo the bot cannot connect "the spawn I sent" to "the session now streaming" — which it
   *  must, to keep a resumed conversation in the surface (thread) where the user asked for it.
   *  Stamped on EVERY status frame of a spawned session, not just the first: the first frame
   *  can be lost to a reconnect, and a late learner is still a correct learner. Additive +
   *  tolerant like `epoch`: a pre-echo daemon omits it and the bot simply cannot correlate,
   *  exactly as today. */
  spawnRequestId: RequestId.nullish(),
  /** The caller-supplied `resumeSessionId` this spawn continued from, echoed verbatim (the
   *  WIRE id the requester already knows, not the SDK anchor it resolved to). Where
   *  `spawnRequestId` correlates "the spawn I sent", this correlates "the conversation it
   *  continues" — and unlike a pending requestId map, the requester can act on it with no
   *  in-memory state at all (e.g. a bot restarted between spawn and status still routes the
   *  resumed session into the original session's thread). Same additive + tolerant contract
   *  as its sibling. */
  resumedFrom: SessionId.nullish(),
});

/** Widened (not split into done/waiting variants) on purpose: title/body/level stays the one
 *  required contract every bot version can render, so an N-1 bot shows a plain notification
 *  where a current bot shows a rich done/waiting card. New variant TYPES would instead be
 *  dropped whole by the older peer's envelope parse — a silent notification loss. */
const HookNotificationPayload = z.object({
  event: z.enum(['permission', 'stop', 'notification']),
  sessionId: SessionId.nullish(),
  /** The session's working directory, when the hook reported one. Several CLI windows can
   *  notify at once and their cards are otherwise indistinguishable, so the bot renders the
   *  directory's basename (with a sessionId prefix) as the card's origin tag. Additive +
   *  tolerant like `notificationType`: an older daemon omits it and the card simply loses
   *  the folder half of its tag. */
  cwd: z.string().nullish(),
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
  // A short display label (the daemon sends its host name). Bounded because the bot persists it
  // verbatim into the shared bindings.json and rewrites that whole file on every pairing — an
  // unbounded label would let one claimer bloat every other user's pairing write. 256 covers any
  // real hostname (DNS caps a name at 253) with room to spare.
  hostLabel: z.string().max(256),
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
  'stats.snapshot': frame('stats.snapshot', TokenStatsSnapshot),
  'stats.request': frame('stats.request', TokenStatsRequestPayload),
  'stats.result': frame('stats.result', TokenStatsResultPayload),
  'settings.snapshot': frame('settings.snapshot', SettingsSnapshot),
  'switch.command': frame('switch.command', SwitchCommandPayload),
  'switch.result': frame('switch.result', SwitchResultPayload),
  'permission.request': frame('permission.request', PermissionRequestPayload),
  'permission.response': frame('permission.response', PermissionResponsePayload),
  'permission.lapsed': frame('permission.lapsed', PermissionLapsedPayload),
  'question.request': frame('question.request', QuestionRequestPayload),
  'question.response': frame('question.response', QuestionResponsePayload),
  'question.lapsed': frame('question.lapsed', QuestionLapsedPayload),
  'prompt.inject': frame('prompt.inject', PromptInjectPayload),
  'session.spawn': frame('session.spawn', SessionSpawnPayload),
  'session.output': frame('session.output', SessionOutputPayload),
  'session.status': frame('session.status', SessionStatusPayload),
  'session.stop': frame('session.stop', SessionStopPayload),
  'session.prune': frame('session.prune', SessionPrunePayload),
  'session.prune.result': frame('session.prune.result', SessionPruneResultPayload),
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
  messageSchemas['stats.snapshot'],
  messageSchemas['stats.request'],
  messageSchemas['stats.result'],
  messageSchemas['settings.snapshot'],
  messageSchemas['switch.command'],
  messageSchemas['switch.result'],
  messageSchemas['permission.request'],
  messageSchemas['permission.response'],
  messageSchemas['permission.lapsed'],
  messageSchemas['question.request'],
  messageSchemas['question.response'],
  messageSchemas['question.lapsed'],
  messageSchemas['prompt.inject'],
  messageSchemas['session.spawn'],
  messageSchemas['session.output'],
  messageSchemas['session.status'],
  messageSchemas['session.stop'],
  messageSchemas['session.prune'],
  messageSchemas['session.prune.result'],
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
export type SettingSource = z.infer<typeof SettingSource>;
export type SettingRow = z.infer<typeof SettingRow>;
export type SettingsSnapshot = z.infer<typeof SettingsSnapshot>;
export type TokenTotals = z.infer<typeof TokenTotals>;
export type TokenAccountRow = z.infer<typeof TokenAccountRow>;
export type TokenBucketRow = z.infer<typeof TokenBucketRow>;
export type TokenStatsCoverage = z.infer<typeof TokenStatsCoverage>;
export type TokenStatsSnapshot = z.infer<typeof TokenStatsSnapshot>;
export type UsageAdvisory = z.infer<typeof UsageAdvisory>;
export type AccountScore = z.infer<typeof AccountScore>;
export type UsagePlan = z.infer<typeof UsagePlan>;

/** Runtime membership test for the discriminant — useful at socket boundaries. */
export function isMessageType(value: string): value is MessageType {
  return Object.prototype.hasOwnProperty.call(messageSchemas, value);
}
