// Thread-per-session delivery for Slack: one DM thread per managed session, plus the reply path
// back into it.
//
// This is a DELIBERATELY MINIMAL sibling of discord/sessionPlanner.ts, not a port of it. The
// Discord surface earns a full state machine (coalesced embeds, file attachments, button rows)
// because Discord gives it a fresh channel-shaped object (a thread) per session. Slack does not:
// every session for a user lives in the SAME DM conversation, distinguished only by `thread_ts`,
// and Slack's ~1 msg/sec rate limit is per-CHANNEL, not per-thread — so several concurrent
// sessions for one user share one throttle. Re-deriving the Discord planner's generality for that
// shape would be more code, not less, so this file re-implements just the sequencing it actually
// needs (ordering/gap resolution reused from sessionOutput.ts; coalescing reworked to be
// per-channel rather than per-route) and accepts the small duplication as the cost of staying
// simple. If Slack ever grows Discord-shaped needs (attachments, rich cards), that is the trigger
// to extract a shared planner — not before.
//
// TWO SERIALIZATION LAYERS, AND THEY ARE NOT THE SAME LAYER. The relay starts an independent
// async chain per frame, so nothing upstream orders two envelopes for one session:
//   - per SESSION (`chainOnSession`): a session's first status and first output arriving together
//     would otherwise both find `posted` false and both create a thread parent, leaving one
//     orphaned message frozen on its first render and one registry entry overwriting the other.
//     Mirrors discord/discordJsGateway.ts's `chainOnRoute`, at the scale of one session.
//   - per CHANNEL (`flushChannel`): two overlapping flushes each splice their own batch out of
//     the same queue and then interleave their sends, putting a later thread reply ahead of an
//     earlier one.
// Spacing BETWEEN sends is a third concern again, and belongs to nobody here — it is the whole
// surface's (see PacedChannelSend in context.ts), because the DM channel this module posts into
// is the same one the gateway sends fallbacks and primers to.
//
// Thread-id encoding: `PersistentThreadRegistry` (discord/threadRegistry.ts) treats `threadId` as
// an opaque string — it was designed for Discord's actual thread-channel snowflakes, which carry
// no structure of their own. Slack has no equivalent single id: a thread is addressed by the pair
// (channel id, parent message `ts`). This module is the one that MINTS the Slack encoding of that
// opaque field, so the encoding is documented here, next to the only two functions allowed to
// produce or consume it: `${channelId}:${threadTs}`. `:` is a safe separator because Slack channel
// ids are alphanumeric (`D…`/`C…`) and a message `ts` is digits-and-a-single-dot — neither can ever
// contain a colon, so the split below is unambiguous and never needs escaping.
//
// Reply routing: Slack's Events API has no server-side index from "a message with this thread_ts"
// back to "the session it belongs to" — unlike a Discord thread, which the reply arrives ALREADY
// scoped to. This module keeps that reverse index itself, in memory, keyed by the same encoding.
// It is populated (and, on a restart, self-healingly re-populated) every time `handle()` resolves a
// session's thread — including for a session whose thread was created by an EARLIER process, once
// that session next emits any envelope. A thread whose session has gone completely silent since a
// restart is not resolvable until then; that is an accepted gap for a session that has nothing
// left to say, not a live one a reply is likely to land on.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { App } from '@slack/bolt';
import { isType, type Envelope, type PayloadOf } from '@claude-control/shared-protocol';
import type { PacedChannelSend, SlackContext } from './context.js';
import { toMrkdwn, sanitizeSlackText, slackChunks, SLACK_LIMITS } from './slackFormat.js';
import { PersistentThreadRegistry, type DeliveryTarget } from '../discord/threadRegistry.js';
import { clampBalanced } from '../discord/messageChunks.js';
import { truncateLabeled } from '../discord/richFormat.js';
import { OrderedOutput, type CommittedItem } from '../discord/sessionOutput.js';
import * as commands from '../discord/commands.js';
import type { CommandDeps } from '../discord/commands.js';

export interface SlackSessionDeliveryOptions {
  ctx: SlackContext;
  /** Root of the deployment's on-disk state — the same directory every surface is handed. The
   *  session→thread registry is NOT kept in that root but in a Slack-owned subdirectory of it:
   *  `PersistentThreadRegistry` persists by rewriting its ENTIRE in-memory snapshot over one
   *  fixed filename, so two surfaces pointed at the same directory do not merge, they clobber —
   *  whichever records last erases every mapping the other had, and after a restart the losing
   *  surface re-mints threads for sessions that already had one while replies into the old
   *  threads stop resolving. The registry's composite key being per-surface-user-id prevents key
   *  COLLISION and nothing else; it is no defence against a whole-snapshot overwrite. The
   *  subdirectory is created by the registry's own atomic writer on the first record. */
  stateDir: string;
  /** Every Slack call this module makes goes through here — see PacedChannelSend in context.ts.
   *  Shared with the rest of the surface on purpose: the ~1 msg/sec ceiling it enforces is per
   *  CHANNEL, and one DM channel carries every session thread this module owns alongside whatever
   *  the gateway sends the same user directly. */
  sendPaced: PacedChannelSend;
}

const THREAD_ID_SEPARATOR = ':';

/** Subdirectory of the deployment state dir this surface's thread registry lives in — see
 *  {@link SlackSessionDeliveryOptions.stateDir} for why it is not the state dir itself. */
const REGISTRY_SUBDIR = 'slack';

/** Encode a Slack thread's address into the opaque string threadRegistry.ts persists. See the
 *  file header for why the separator is safe. */
function encodeThreadId(channelId: string, threadTs: string): string {
  return `${channelId}${THREAD_ID_SEPARATOR}${threadTs}`;
}

/** Inverse of {@link encodeThreadId}. `undefined` for anything that isn't exactly one encoded
 *  pair — fails closed rather than guessing, the same posture threadRegistry.ts's own on-disk
 *  parsing takes for a snapshot it doesn't recognise. */
function decodeThreadId(threadId: string): { channelId: string; threadTs: string } | undefined {
  const sep = threadId.indexOf(THREAD_ID_SEPARATOR);
  if (sep < 0) return undefined;
  const channelId = threadId.slice(0, sep);
  const threadTs = threadId.slice(sep + 1);
  if (!channelId || !threadTs) return undefined;
  return { channelId, threadTs };
}

type SessionState = PayloadOf<'session.status'>['state'];

/** No more envelopes follow a terminal state — the status message is flushed at once (bypassing
 *  the coalescing window) rather than left to a timer that will never usefully fire again. */
const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['done', 'failed', 'orphaned']);

/** Composite key for the in-memory session view map — same shape as threadRegistry.ts's own `key`,
 *  kept local rather than imported since it is a two-line pure function, not shared state. */
function sessionKey(slackUserId: string, sessionId: string): string {
  return `${slackUserId} ${sessionId}`;
}

/** How much of the accumulated transcript the live status message shows inline. Small on purpose:
 *  this is a status line a phone notification banner can show at a glance, not a full transcript —
 *  the honest full record is the thread itself (every milestone/summary/error line, posted as its
 *  own follow-up message; see `applyItems`). */
const STATUS_TAIL_CHARS = 1_000;

/** How much transcript is RETAINED. Only the last {@link STATUS_TAIL_CHARS} are ever rendered, so
 *  anything beyond a small multiple of that is pure leak — and stdout is unbounded on the wire, so
 *  in a process that runs for weeks the leak is the session's entire output held in memory forever.
 *  Kept at a multiple rather than exactly the tail so a render always has a full tail to slice. */
const TRANSCRIPT_MAX_CHARS = STATUS_TAIL_CHARS * 2;

/** Cap on the summary's contribution to the status message. The summary is unbounded on the wire
 *  and escaping can expand it several times over, so an unclamped one is enough on its own to push
 *  the assembled text past Slack's limit — which fails the post INSIDE `ensureThread`, leaving the
 *  session with no thread at all. Same scale as the transcript tail: this is a glanceable status
 *  line, not the record. */
const SUMMARY_MAX_CHARS = STATUS_TAIL_CHARS * 2;

/** Cap on the session id shown in the status header. The id is wire-derived and unbounded; without
 *  this, a hostile one crowds the state (and everything else) out of its own header before the
 *  whole-message clamp gets a say. */
const SESSION_ID_MAX_CHARS = 200;

/** Cap on follow-up lines staged on a view before its thread exists. The staging buffer only
 *  drains once `ensureThread` succeeds, so a session whose thread creation keeps failing (DMs
 *  closed, revoked scope) would otherwise accumulate every line it ever produced, forever. */
const MAX_PENDING_FOLLOWUPS = 200;

/** Grace before a terminal session's in-memory state is dropped: long enough that a straggler
 *  frame arriving just behind the terminal status still finds its view, short enough that a
 *  long-lived process does not retain one view (and one transcript) per session it ever saw.
 *  Mirrors discord/discordJsGateway.ts's own forget grace. */
const SESSION_FORGET_MS = 5 * 60_000;

/** All mutable per-session state this module tracks. Purely data, mirroring the shape (not the
 *  size) of discord/sessionPlanner.ts's SessionView. */
interface SessionView {
  slackUserId: string;
  sessionId: string;
  /** Set once the thread's parent message exists — either just posted, or resolved from a
   *  persisted mapping left by an earlier process. */
  channelId: string | undefined;
  /** The parent message's `ts` — simultaneously the thread's `thread_ts` for replies/follow-ups
   *  AND the target `ts` for the live status `chat.update`. */
  statusTs: string | undefined;
  posted: boolean;
  state: SessionState;
  summary: string | undefined;
  /** Reassembled stdout+error text (see `applyItems`); the live status message shows its tail.
   *  Trimmed to {@link TRANSCRIPT_MAX_CHARS} on every append. */
  transcript: string;
  hasGap: boolean;
  output: OrderedOutput;
  /** Chunked follow-up lines produced by the envelope just processed, not yet handed to a channel
   *  queue — staged here because the destination channel may not be known yet (a brand-new
   *  session's very first envelope can carry a milestone chunk before `ensureThread` has run).
   *  Bounded by {@link MAX_PENDING_FOLLOWUPS}. */
  pendingFollowups: string[];
  /** Lines the staging cap had to refuse, reported as a visible marker when the buffer next
   *  drains — a silently shorter thread is exactly the failure the gap markers exist to avoid. */
  droppedFollowups: number;
}

/** One Slack DM channel's outbound queue. Slack's rate limit is per-channel and several sessions
 *  for the same user share one channel, so coalescing lives here, not on the session view. */
interface ChannelQueue {
  /** `undefined` until this channel's first flush — treated as "infinitely long ago" so the very
   *  first send for a freshly-seen channel never waits out an interval that never started. */
  lastFlushAtMs: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** The flush currently running (or queued behind one), so the next flush chains rather than
   *  overlaps — see the file header's second serialization layer. `undefined` when idle. */
  inFlight: Promise<void> | undefined;
  /** Session keys whose live status message needs a `chat.update` on the next flush. A Set because
   *  a burst of updates for the same session collapses to one edit — the same coalescing guarantee
   *  discord/sessionPlanner.ts makes, applied per channel instead of per route. */
  dirtySessionKeys: Set<string>;
  /** Standalone follow-up lines (milestone/summary/error, already chunked) queued for a
   *  `chat.postMessage` reply, each tagged with the thread it belongs to (several sessions can
   *  share one channel, so the destination thread travels with the line). */
  followups: Array<{ threadTs: string; text: string }>;
}

/** Render a wire-derived session id for the status header's code span.
 *
 * The id is NOT authored locally — shared-protocol constrains it to "a non-empty string", so
 * whatever can talk to a daemon can put anything in it. Backticks go first, because one would
 * CLOSE the code span the id is rendered inside and hand the remainder of the id straight to
 * Slack's live mrkdwn and mention grammar (`<!here>`, `<@U…>`, which Slack resolves in plain text
 * with no allowedMentions-style opt-out). The usual escape follows, via `sanitizeSlackText` rather
 * than `toMrkdwn`: an id has no markdown to convert, and converting it could only invent syntax
 * that was never there.
 */
function renderSessionId(sessionId: string): string {
  return truncateLabeled(sanitizeSlackText(sessionId.replace(/`/g, '')), SESSION_ID_MAX_CHARS);
}

/**
 * Per-session Slack DM delivery: creates one thread per managed session, keeps a single status
 * message live in it, and routes threaded replies back into the session. See the file header for
 * the scope this deliberately does NOT cover (attachments, rich cards — Discord's job).
 */
export class SlackSessionDelivery {
  private readonly ctx: SlackContext;
  private readonly sendPaced: PacedChannelSend;
  private readonly threadReg: PersistentThreadRegistry;
  private readonly views = new Map<string, SessionView>();
  private readonly channels = new Map<string, ChannelQueue>();
  /** In-memory reverse index: encoded thread address -> the session it belongs to. See the file
   *  header for why this cannot be persisted through threadRegistry.ts's public API and what that
   *  costs. */
  private readonly reverseThreads = new Map<string, { slackUserId: string; sessionId: string }>();
  /** Per-session envelope serialization — see the file header's first layer. Entries are dropped
   *  as they drain, so the map is bounded by sessions with a frame actually in flight. */
  private readonly deliverChains = new Map<string, Promise<void>>();
  /** Pending "drop this terminal session's state" timers, kept so `stop()` can cancel them and a
   *  repeated terminal status re-arms rather than stacks. */
  private readonly forgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Set by `stop()`. Read wherever new timed work would otherwise be armed after shutdown. */
  private stopped = false;

  constructor(opts: SlackSessionDeliveryOptions) {
    this.ctx = opts.ctx;
    this.sendPaced = opts.sendPaced;
    this.threadReg = new PersistentThreadRegistry(join(opts.stateDir, REGISTRY_SUBDIR));
  }

  /**
   * Own a `session.output`/`session.status` envelope end to end: resolve (or create) the session's
   * thread, fold the envelope into its view, and queue/flush whatever changed. Returns `false`
   * for every other envelope kind so the caller's dispatch chain (see context.ts) can fall through
   * to the next handler — this module has no opinion on permission cards, question cards, or
   * anything else. Branches positively on `isType` (rather than a single negated compound guard)
   * so each payload access below sits inside its own narrowed branch — the same shape
   * discord/stateCache.ts and discord/discordJsGateway.ts's `deliver()` already use.
   *
   * Work is appended to the session's chain rather than run directly: see the file header.
   */
  async handle(slackUserId: string, envelope: Envelope): Promise<boolean> {
    if (isType(envelope, 'session.output')) {
      const payload = envelope.payload;
      await this.chainOnSession(slackUserId, payload.sessionId, () =>
        this.process(slackUserId, payload.sessionId, (view, now) => {
          const items = view.output.accept(
            {
              seq: payload.seq,
              kind: payload.kind,
              text: payload.text,
              truncated: payload.truncated,
            },
            now,
          );
          this.applyItems(view, items);
          return { changed: items.length > 0, terminal: false };
        }),
      );
      return true;
    }
    if (isType(envelope, 'session.status')) {
      const payload = envelope.payload;
      await this.chainOnSession(slackUserId, payload.sessionId, () =>
        this.process(slackUserId, payload.sessionId, (view, now) => {
          view.state = payload.state;
          view.summary = payload.summary ?? undefined;
          const terminal = TERMINAL_STATES.has(view.state);
          if (terminal) {
            // No further output is coming: collapse every remaining reorder hole now rather than
            // leave it stuck waiting on a chunk that will never arrive (never-silent guarantee,
            // same as discord/sessionPlanner.ts's terminal handling).
            this.applyItems(view, view.output.resolveGaps(now, true));
          }
          return { changed: true, terminal };
        }),
      );
      return true;
    }
    return false;
  }

  /**
   * Register the DM message listener that turns an in-thread reply into a `prompt.inject`. Ignores
   * anything that is not a plain user message (edits, bot messages, joins — anything with a
   * `subtype`), anything outside a thread, and any thread this process does not recognise (another
   * bot's thread, or a session whose thread predates this process and has not emitted since — see
   * the file header).
   */
  register(app: App): void {
    // Declared async purely because Bolt's listener seam is Promise-returning; every step below is
    // synchronous — handleSay queues the frame on the relay socket rather than awaiting a round trip.
    // eslint-disable-next-line @typescript-eslint/require-await -- see above
    app.message(async ({ message }) => {
      if (message.subtype !== undefined) return; // bot_message/message_changed/etc., not a reply
      if (message.bot_id) return; // defensive belt-and-braces alongside the subtype check above
      if (!message.thread_ts || !message.text) return; // not a threaded reply, or nothing to send

      const found = this.reverseThreads.get(encodeThreadId(message.channel, message.thread_ts));
      if (!found) return; // unknown thread — other bots/threads share this DM, ignored silently

      // The same command path `/say` uses: the invoking user's RAW id resolves the thread, but
      // relay/pairing calls only ever see the namespaced principal (see context.ts's division of
      // labour). A thread reply IS a say targeted at the thread's session.
      const deps: CommandDeps = {
        relay: this.ctx.relay,
        pairing: this.ctx.pairing,
        cache: this.ctx.cache,
      };
      const principal = this.ctx.principalOf(found.slackUserId);
      const result = commands.handleSay(
        deps,
        principal,
        found.sessionId,
        message.text,
        randomUUID(),
      );
      if (result.kind === 'error') {
        this.ctx.logger.warn(
          { error: result.message, sessionId: found.sessionId },
          'slack: failed to inject a thread reply',
        );
      }
    });
  }

  /**
   * Wind down: no further timed work, then one last flush per channel that still has something
   * staged. Without it, the coalesced status edit sitting on a timer — typically the LAST thing a
   * session had to say — is dropped on the floor at shutdown. Called by SlackGateway.stop() before
   * the socket closes, since a flush still needs the connection.
   */
  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.forgetTimers.values()) clearTimeout(timer);
    this.forgetTimers.clear();
    const finalFlushes: Array<Promise<void>> = [];
    for (const [channelId, ch] of this.channels) {
      if (ch.timer) {
        clearTimeout(ch.timer);
        ch.timer = undefined;
      }
      // Chained like any other flush, so a flush already mid-send finishes before this one starts
      // and the last edit still reflects the newest state. A channel with nothing staged no-ops.
      finalFlushes.push(this.flushChannel(channelId));
    }
    await Promise.all(finalFlushes);
  }

  // ---------------------------------------------------------------------------
  // internals
  // ---------------------------------------------------------------------------

  /** Append one envelope's processing to its session's serialization chain, resolving when THIS
   *  unit has run. Both `.then` branches run the work so a prior unit's (never-expected) rejection
   *  cannot skip one, and the work is wrapped so the chain itself never rejects — a rejected chain
   *  would stall every later frame for the session. The entry is dropped once it drains, but only
   *  if it is still the tail, keeping the map bounded by sessions with a frame in flight. Mirrors
   *  discord/discordJsGateway.ts's `chainOnRoute`. */
  private chainOnSession(
    slackUserId: string,
    sessionId: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const key = sessionKey(slackUserId, sessionId);
    const guarded = async (): Promise<void> => {
      try {
        await work();
      } catch (err) {
        this.ctx.logger.warn(
          { err, slackUserId, sessionId },
          'slack: session envelope processing failed',
        );
      }
    };
    const prior = this.deliverChains.get(key) ?? Promise.resolve();
    const next = prior.then(guarded, guarded);
    this.deliverChains.set(key, next);
    void next.finally(() => {
      if (this.deliverChains.get(key) === next) this.deliverChains.delete(key);
    });
    return next;
  }

  /** Shared tail of `handle()`: resolve/create the session's thread, then queue and (as
   *  appropriate) flush whatever the envelope changed. `apply` runs with the envelope's payload
   *  still captured in its defining closure — see `handle()` — so this method itself needs no
   *  knowledge of which envelope kind produced the update. */
  private async process(
    slackUserId: string,
    sessionId: string,
    apply: (view: SessionView, now: number) => { changed: boolean; terminal: boolean },
  ): Promise<void> {
    // Idempotent past the first call — cheap to call on every envelope rather than push a
    // load-before-use obligation onto the caller.
    await this.threadReg.load();
    const view = this.viewFor(slackUserId, sessionId);
    const now = Date.now();
    const { changed, terminal } = apply(view, now);

    // `justPosted` distinguishes the two ways `ensureThread` can leave `view.posted` true: a
    // BRAND-NEW parent message (which already reflects this envelope, since `apply` ran above)
    // needs no follow-up edit, but RESOLVING a thread an earlier process created does — that
    // parent message predates this envelope's change and would otherwise go stale forever the
    // first time a restarted process picks a live session back up.
    let justPosted = false;
    if (!view.posted) justPosted = await this.ensureThread(slackUserId, view);
    if (changed && !justPosted) this.markDirty(view);
    if (!view.channelId || !view.statusTs) return; // ensureThread failed; already logged

    this.drainFollowups(view);

    if (terminal) {
      await this.forceFlushChannel(view.channelId);
      this.scheduleForget(view);
    } else {
      await this.scheduleOrFlush(view.channelId, now);
    }
  }

  private viewFor(slackUserId: string, sessionId: string): SessionView {
    const k = sessionKey(slackUserId, sessionId);
    let view = this.views.get(k);
    if (!view) {
      view = {
        slackUserId,
        sessionId,
        channelId: undefined,
        statusTs: undefined,
        posted: false,
        state: 'starting',
        summary: undefined,
        transcript: '',
        hasGap: false,
        output: new OrderedOutput(),
        pendingFollowups: [],
        droppedFollowups: 0,
      };
      this.views.set(k, view);
    }
    return view;
  }

  /** Route committed output items to their presentation: stdout/error text into the transcript
   *  tail, milestone/summary/error ALSO staged as standalone follow-up lines (chunked so an
   *  oversized one still arrives, never dropped), gaps as visible transcript markers. Mirrors
   *  discord/sessionPlanner.ts's `applyItems` in spirit; simpler because there is no card embed,
   *  attachment, or button state to update alongside it. */
  private applyItems(view: SessionView, items: CommittedItem[]): void {
    for (const item of items) {
      if (item.kind === 'gap') {
        view.transcript += `\n⟨gap: output seq ${item.fromSeq}–${item.toSeq} lost⟩\n`;
        view.hasGap = true;
        this.trimTranscript(view);
        continue;
      }
      // Wire-derived text goes through toMrkdwn exactly once, here, before it is combined with
      // any authored prefix/marker below — see slackFormat.ts's header for why this is the only
      // safe order (sanitize before anything else touches the string).
      const converted = toMrkdwn(item.text);
      const withMarker = item.truncated
        ? `${converted}\n⟨source truncated its output here⟩`
        : converted;
      view.transcript += withMarker;
      this.trimTranscript(view);
      if (item.outputKind === 'stdout') continue; // tail-only: no standalone line for plain stdout
      const prefix =
        item.outputKind === 'error' ? '❗ ' : item.outputKind === 'milestone' ? '🔹 ' : '📝 ';
      for (const chunk of slackChunks(withMarker)) {
        if (view.pendingFollowups.length >= MAX_PENDING_FOLLOWUPS) {
          view.droppedFollowups += 1;
          continue;
        }
        view.pendingFollowups.push(`${prefix}${chunk}`);
      }
    }
  }

  /** Keep only what a status render can actually show — see {@link TRANSCRIPT_MAX_CHARS}. */
  private trimTranscript(view: SessionView): void {
    if (view.transcript.length > TRANSCRIPT_MAX_CHARS) {
      view.transcript = view.transcript.slice(-TRANSCRIPT_MAX_CHARS);
    }
  }

  /** Hand this envelope's staged follow-up lines to the destination channel's queue, plus a
   *  visible marker for anything the staging cap refused while the thread was unavailable. */
  private drainFollowups(view: SessionView): void {
    for (const text of view.pendingFollowups.splice(0)) this.queueFollowup(view, text);
    if (view.droppedFollowups > 0) {
      this.queueFollowup(
        view,
        `⟨${view.droppedFollowups} follow-up line(s) dropped: this session's backlog was full⟩`,
      );
      view.droppedFollowups = 0;
    }
  }

  /** Post the thread's parent message the first time this session is seen, or resolve an existing
   *  one left by an earlier process. Returns whether a NEW message was just posted (`true`) as
   *  opposed to an existing one resolved or the attempt failing (`false`) — see `process()` for
   *  why that distinction matters. Never throws — a failure (DM open, or the post itself) is
   *  logged and leaves `view.channelId` unset, which the caller treats as "nothing more to do for
   *  this envelope" rather than crashing the delivery path. Only ever reached once per session
   *  concurrently: `handle()` serializes a session's envelopes, without which two arriving
   *  together would each post their own parent and each record it, orphaning one. */
  private async ensureThread(slackUserId: string, view: SessionView): Promise<boolean> {
    const existing = this.threadReg.get(slackUserId, view.sessionId);
    const decoded =
      existing && existing.kind === 'thread' ? decodeThreadId(existing.threadId) : undefined;
    if (decoded) {
      view.channelId = decoded.channelId;
      view.statusTs = decoded.threadTs;
      view.posted = true;
      this.rememberReverse(decoded.channelId, decoded.threadTs, slackUserId, view.sessionId);
      return false;
    }
    try {
      const channelId = await this.ctx.openDm(slackUserId);
      const res = await this.ctx.web.chat.postMessage({
        channel: channelId,
        text: this.renderStatusText(view),
      });
      if (!res.ts) throw new Error('chat.postMessage returned no ts');
      view.channelId = channelId;
      view.statusTs = res.ts;
      view.posted = true;
      const target: DeliveryTarget = {
        kind: 'thread',
        threadId: encodeThreadId(channelId, res.ts),
      };
      await this.threadReg.record(slackUserId, view.sessionId, target);
      this.rememberReverse(channelId, res.ts, slackUserId, view.sessionId);
      return true;
    } catch (err) {
      this.ctx.logger.warn(
        { err, slackUserId, sessionId: view.sessionId },
        'slack: failed to open a session thread',
      );
      return false;
    }
  }

  /** (Re)populate the reverse index for one resolved thread. Idempotent — called both on creation
   *  and whenever a persisted mapping from an earlier process is re-resolved, which is what lets a
   *  restarted process's reply routing self-heal for any session that is still active. */
  private rememberReverse(
    channelId: string,
    threadTs: string,
    slackUserId: string,
    sessionId: string,
  ): void {
    this.reverseThreads.set(encodeThreadId(channelId, threadTs), { slackUserId, sessionId });
  }

  /** Drop a terminal session's in-memory state after {@link SESSION_FORGET_MS}. A frame that
   *  arrives later still is not lost: the PERSISTED thread mapping outlives the view, so the
   *  rebuilt view resolves the same thread (and re-registers it for replies) instead of minting a
   *  second one. Mirrors discord/discordJsGateway.ts's `scheduleForget`. */
  private scheduleForget(view: SessionView): void {
    if (this.stopped) return;
    const key = sessionKey(view.slackUserId, view.sessionId);
    const pending = this.forgetTimers.get(key);
    if (pending) clearTimeout(pending); // re-arm rather than stack: terminal states can repeat
    const timer = setTimeout(() => {
      this.forgetTimers.delete(key);
      this.forget(view.slackUserId, view.sessionId);
    }, SESSION_FORGET_MS);
    // Do not keep the event loop alive solely to forget something.
    if (typeof timer.unref === 'function') timer.unref();
    this.forgetTimers.set(key, timer);
  }

  /** Drop every in-memory trace of one session: its view (transcript included), its reverse-thread
   *  entry, and its channel's queue once that queue is genuinely idle and empty. */
  private forget(slackUserId: string, sessionId: string): void {
    const key = sessionKey(slackUserId, sessionId);
    const view = this.views.get(key);
    this.views.delete(key);
    if (!view?.channelId || !view.statusTs) return;
    this.reverseThreads.delete(encodeThreadId(view.channelId, view.statusTs));
    const ch = this.channels.get(view.channelId);
    if (
      ch &&
      !ch.timer &&
      !ch.inFlight &&
      ch.dirtySessionKeys.size === 0 &&
      ch.followups.length === 0
    ) {
      this.channels.delete(view.channelId);
    }
  }

  /** Plain-text render of a session's live status message. Only the wire-derived pieces
   *  (`sessionId`, `summary`, the transcript tail — already run through `toMrkdwn` when appended
   *  in `applyItems`) came from the daemon; the labels and structure around them are authored here
   *  and never re-escaped, matching toMrkdwn's own "call it exactly once" contract.
   *
   *  Clamping the summary can cut mid-entity (`&am`), which is cosmetic only and never unsafe:
   *  sanitization has already replaced every raw `<` with an entity, so no cut can reveal one. The
   *  whole assembled string is clamped last as the backstop — an oversized `text` is rejected by
   *  Slack outright, and that rejection lands inside `ensureThread`, whose catch would leave the
   *  session with no thread and therefore permanently silent. */
  private renderStatusText(view: SessionView): string {
    const header = `Session \`${renderSessionId(view.sessionId)}\` — *${view.state}*`;
    const summary = view.summary
      ? `\n${truncateLabeled(toMrkdwn(view.summary), SUMMARY_MAX_CHARS)}`
      : '';
    const tail =
      view.transcript.length > 0
        ? `\n\`\`\`\n${view.transcript.slice(-STATUS_TAIL_CHARS)}\n\`\`\``
        : '';
    const gapNote = view.hasGap ? '\n_(some output was lost — see the gap marker above)_' : '';
    return clampBalanced(
      `${header}${summary}${tail}${gapNote}`,
      SLACK_LIMITS.MESSAGE_TEXT_MAX,
      truncateLabeled,
    );
  }

  private channelFor(channelId: string): ChannelQueue {
    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = {
        lastFlushAtMs: undefined,
        timer: undefined,
        inFlight: undefined,
        dirtySessionKeys: new Set(),
        followups: [],
      };
      this.channels.set(channelId, ch);
    }
    return ch;
  }

  private markDirty(view: SessionView): void {
    if (!view.channelId) return;
    this.channelFor(view.channelId).dirtySessionKeys.add(
      sessionKey(view.slackUserId, view.sessionId),
    );
  }

  private queueFollowup(view: SessionView, text: string): void {
    if (!view.channelId || !view.statusTs) return;
    this.channelFor(view.channelId).followups.push({ threadTs: view.statusTs, text });
  }

  /** Flush now if the channel's minimum send interval has already elapsed, otherwise (re)schedule
   *  a timer for exactly when it will have. A no-op when nothing is actually pending, so a call
   *  that turned out to change nothing can never reset the channel's throttle clock or leave a
   *  dangling timer. The immediate-send branch is awaited by the caller (`process()`) so a
   *  freshly-created session's own first status edit is guaranteed to have actually gone out
   *  before `handle()` resolves; the timer branch necessarily fires later, on its own schedule,
   *  and is fire-and-forget from here like every other scheduled flush in this file.
   *
   *  A flush already IN FLIGHT owns this work too, but only indirectly: it spliced its own batch
   *  before this work was queued, so it will not send it — its completion hook re-arms the timer
   *  instead (see {@link flushChannel}). Starting a second flush here would be the overlap the
   *  chain exists to prevent. */
  private async scheduleOrFlush(channelId: string, now: number): Promise<void> {
    const ch = this.channelFor(channelId);
    if (ch.dirtySessionKeys.size === 0 && ch.followups.length === 0) return;
    if (ch.timer || ch.inFlight) return;
    const readyAt = (ch.lastFlushAtMs ?? -Infinity) + SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS;
    if (now >= readyAt) {
      await this.flushChannel(channelId);
      return;
    }
    this.armFlushTimer(channelId);
  }

  /** Arm the coalescing timer for whenever this channel's window next opens. Idempotent and
   *  self-suppressing: nothing staged, a timer already armed, a flush still running, or a stopped
   *  instance all mean somebody else already owns (or has cancelled) the next flush. */
  private armFlushTimer(channelId: string): void {
    if (this.stopped) return;
    const ch = this.channels.get(channelId);
    if (!ch || ch.timer || ch.inFlight) return;
    if (ch.dirtySessionKeys.size === 0 && ch.followups.length === 0) return;
    const readyAt = (ch.lastFlushAtMs ?? -Infinity) + SLACK_LIMITS.MIN_CHANNEL_SEND_INTERVAL_MS;
    const timer = setTimeout(
      () => {
        ch.timer = undefined;
        void this.flushChannel(channelId);
      },
      Math.max(0, readyAt - Date.now()),
    );
    // Do not keep the event loop alive solely for a pending status edit.
    if (typeof timer.unref === 'function') timer.unref();
    ch.timer = timer;
  }

  /** Terminal-state path: drop any pending coalescing timer (a stop-like state has nothing left to
   *  coalesce with) and flush without waiting out the coalescing window — the same "terminal
   *  bypasses the window" posture as discord/sessionPlanner.ts's `forceEditCard`. The COALESCING
   *  window is what is skipped, not the channel's send interval: a terminal edit that comes back
   *  429 was never delivered at all, which is strictly worse than one that lands a moment later. */
  private async forceFlushChannel(channelId: string): Promise<void> {
    const ch = this.channelFor(channelId);
    if (ch.timer) {
      clearTimeout(ch.timer);
      ch.timer = undefined;
    }
    await this.flushChannel(channelId);
  }

  /** Run one flush for `channelId`, serialized against any flush already running on it — see the
   *  file header's second layer. Both `.then` branches run the work so a prior flush's rejection
   *  cannot skip this one (`flushChannelNow` swallows per-send failures, so that is belt-and-
   *  braces). The completion hook re-arms the timer for work queued while this flush was
   *  mid-send: that work was not in its batch, and nothing else would pick it up until the
   *  session's next envelope happened along. */
  private flushChannel(channelId: string): Promise<void> {
    const ch = this.channelFor(channelId);
    const run = (): Promise<void> => this.flushChannelNow(channelId);
    const next = (ch.inFlight ?? Promise.resolve()).then(run, run);
    ch.inFlight = next;
    void next.finally(() => {
      // Only if this flush is still the tail — a later one may already have taken over, and it
      // will run this same hook when it drains.
      if (ch.inFlight !== next) return;
      ch.inFlight = undefined;
      this.armFlushTimer(channelId);
    });
    return next;
  }

  /** Send everything currently queued for one channel: one `chat.update` per dirty session (the
   *  coalesced status edit), then every queued follow-up line, in order. Every send goes through
   *  the surface's shared per-channel pacer, so a batch of several is spaced rather than fired
   *  back to back into a ~1 msg/sec ceiling. A failed individual send is logged and skipped —
   *  never thrown — so one bad call can't stall the rest of the batch or the channel's later
   *  flushes. */
  private async flushChannelNow(channelId: string): Promise<void> {
    const ch = this.channelFor(channelId);
    const dirtyKeys = [...ch.dirtySessionKeys];
    ch.dirtySessionKeys.clear();
    const followups = ch.followups.splice(0);
    if (dirtyKeys.length === 0 && followups.length === 0) return; // never touch the throttle clock on a no-op

    for (const key of dirtyKeys) {
      const view = this.views.get(key);
      if (!view || !view.channelId || !view.statusTs) continue;
      const { channelId: target, statusTs } = view;
      try {
        // Rendered inside the paced call, not before it: by the time a queued edit actually goes
        // out, the view may have folded in later frames, and the newest render is the honest one.
        await this.sendPaced(target, () =>
          this.ctx.web.chat.update({
            channel: target,
            ts: statusTs,
            text: this.renderStatusText(view),
          }),
        );
      } catch (err) {
        this.ctx.logger.warn(
          { err, sessionId: view.sessionId },
          'slack: failed to edit a session status message',
        );
      }
    }
    for (const f of followups) {
      try {
        await this.sendPaced(channelId, () =>
          this.ctx.web.chat.postMessage({
            channel: channelId,
            thread_ts: f.threadTs,
            text: f.text,
          }),
        );
      } catch (err) {
        this.ctx.logger.warn({ err, channelId }, 'slack: failed to post a session follow-up');
      }
    }
    ch.lastFlushAtMs = Date.now();
  }
}
