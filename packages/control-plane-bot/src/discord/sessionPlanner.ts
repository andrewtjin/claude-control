// The pure brain of thread-per-session streaming: envelopes in, gateway operations out.
//
// Everything visual about a managed session — the delivery surface in either of its two modes,
// the coalescing that keeps it under Discord's rate ceilings, milestone/summary/error lines
// posted as their own messages, the full-output file attachment, the seq-ordered transcript with
// honest gap and truncation markers, and the optimistic "stopping…" state — is decided HERE, as a
// state machine over plain data. The live gateway (discordJsGateway) does nothing but EXECUTE the
// returned operations (create a thread / send / edit / upload) and feed a scheduled `flush` back
// in when a coalescing window elapses. That split is what makes all of this unit-testable with
// zero discord.js and an injected clock: no fake timers, no real API.
//
// Two delivery modes, chosen by the gateway from where the session's frames actually land:
//
// `card` (DM fallback): the original surface — one live card edited in place, showing state plus
// a trailing output tail, with the full transcript attached once it outgrows the tail. A DM is a
// shared timeline with every other notification, so a session must occupy ONE message there, not
// scroll the conversation away.
//
// `stream` (per-session thread): the thread IS the transcript, so output is APPENDED as ordinary
// messages (coalesced, chunked with balanced code fences) instead of edited into a card — the
// conversation reads top-to-bottom like the terminal it mirrors, and nothing the user already
// read ever changes under them. No card exists; stop lives on `/stop`. State changes that need
// the user (waiting on a permission, orphaned) post as their own lines; terminal still posts the
// summary embed. An extreme burst is not streamed inline (that would flood the thread and
// Discord's send budget) — it leaves a visible skip marker and the COMPLETE transcript is
// attached at terminal, so every byte still reaches at least one surface, never zero.
//
// Coalescing model (≤1 emission per 1.5–4s, coalesced): after the surface is (re)rendered, a
// further change within the window does NOT emit immediately — it marks the surface dirty and asks
// the gateway to flush at `lastEmit + window`, so a burst of updates collapses to a SINGLE edit
// (card) or one batch of appended messages (stream). An isolated change after a quiet period emits
// at once. The window default of 2s sits in the middle of the plan's range: responsive enough to
// feel live, comfortably under Discord's ~1 edit/second-sustained budget (card) and ~5 messages/5s
// channel budget (stream) so a chatty session never gets rate-limited.

import type { EmbedBuilder } from 'discord.js';
import type { PayloadOf } from '@claude-control/shared-protocol';
import { OrderedOutput, type CommittedItem } from './sessionOutput.js';
import {
  buildSessionCardEmbed,
  buildSessionSummaryEmbed,
  type SessionCardModel,
} from './embeds.js';
import { MESSAGE_CONTENT_LIMIT, truncateLabeled } from './richFormat.js';
import { formatTables } from './tableFormat.js';
import { sessionCardButtons, type ButtonSpec } from './buttons.js';
import { chunkMessage } from './messageChunks.js';

/** How a session's frames are presented: `card` = one live embed edited in place (the DM
 *  surface), `stream` = output appended as plain messages (the per-session thread surface).
 *  The gateway picks per session from the resolved delivery target; the first frame's mode
 *  sticks for the session's life (a mid-session thread loss falls back to DM DELIVERY while
 *  keeping stream rendering — degraded but consistent, never a half-card hybrid). */
export type PlanMode = 'card' | 'stream';

/** Identifies one session AND the user who owns it — the routing address every op carries. The
 *  gateway resolves this to a concrete Discord thread (or DM fallback) via the thread registry;
 *  the planner never learns a physical thread/message id, keeping it free of discord.js state. */
export interface SessionRoute {
  discordUserId: string;
  sessionId: string;
}

/** The operations the planner emits for the gateway to execute, in order. `sendMessage`'s `role`
 *  tells the gateway whether the sent message is THE live card (whose id it must remember, so a
 *  later `editMessage` can target it) or a standalone `line` (milestone/summary/final card). A
 *  route-targeted op is transparently resolved to a thread by the gateway, which creates the thread
 *  on first use (or pins a DM fallback) — "create thread" is therefore the gateway's resolution of
 *  the logical route, not a discrete planner op, so the planner stays purely about content + timing. */
export type GatewayOp =
  | {
      kind: 'sendMessage';
      route: SessionRoute;
      role: 'card' | 'line';
      content?: string;
      embed?: EmbedBuilder;
      components?: ButtonSpec[][];
    }
  | {
      kind: 'editMessage';
      route: SessionRoute;
      ref: 'card';
      embed: EmbedBuilder;
      components?: ButtonSpec[][];
    }
  | {
      kind: 'uploadAttachment';
      route: SessionRoute;
      filename: string;
      text: string;
      content?: string;
    };

/** What each planner call returns: the ops to run now, and (optionally) the absolute time the
 *  gateway should call `flush(route, now)` to emit a coalesced card edit or surface a pending gap. */
export interface PlanResult {
  ops: GatewayOp[];
  flushAtMs?: number;
}

export interface SessionPlannerConfig {
  /** Coalescing window: at most one card edit per this many ms. Default 2000 (see file header). */
  coalesceWindowMs?: number;
  /** How many trailing stdout chars the live card shows. Kept well under the 4096 embed-description
   *  limit so the fenced tail plus body/notes always fit; the FULL text goes to the attachment. */
  cardTailChars?: number;
  /** Accumulated-stdout length past which the full output is delivered as a file attachment (with
   *  the card noting it). Defaults to the tail size, and the crossing is strictly-greater, so any
   *  output the inline tail cannot fully show is attached — the head is never stranded on no
   *  surface (silent truncation is banned). Kept as an option, but the invariant is threshold ≤
   *  `cardTailChars`; a threshold ABOVE the tail re-opens the silent-truncation gap. */
  attachThresholdChars?: number;
  /** Reorder grace before a missing seq is declared a gap (forwarded to OrderedOutput). */
  gapGraceMs?: number;
  /** Stream mode: max characters per terminal-transcript attachment part (see
   *  {@link SessionPlanner.attachIfNeeded}). Test seam; the default keeps every part far
   *  below Discord's upload cap even at 4-bytes-per-char UTF-8. */
  attachPartChars?: number;
}

const DEFAULT_COALESCE_WINDOW_MS = 2_000;
const DEFAULT_CARD_TAIL_CHARS = 1_000;
/** Attachment threshold defaults to the inline tail size (with a strictly-greater crossing in
 *  {@link SessionPlanner.attachIfNeeded}), so ANY output longer than what the card shows inline is
 *  delivered as a file. INVARIANT: threshold ≤ tail. A larger threshold left a silent-truncation
 *  gap — e.g. 1001–1499 chars showed a 1000-char tail with no marker and no attachment, stranding
 *  the head on no surface. Keeping threshold at the tail size closes it. */
const DEFAULT_ATTACH_THRESHOLD_CHARS = DEFAULT_CARD_TAIL_CHARS;

/** Stream mode: a single flush whose buffered output exceeds this is NOT streamed inline — it
 *  posts one visible skip marker instead, and the complete transcript attaches at terminal.
 *  12k chars ≈ 6–7 Discord messages: a one-off burst that size is tolerable once (discord.js
 *  queues past the rate limit), but a source that sustains it (a build log, a huge file dump)
 *  would bury the conversation and starve the channel's ~5 msgs/5s budget forever. */
const STREAM_SKIP_THRESHOLD_CHARS = 12_000;

/** Chunk allowance when a stream flush IS inline. Sized so text under the skip threshold can
 *  never hit chunkMessage's truncation path (16 × ~1700 usable chars ≫ 12k): inline emission
 *  must be all-or-marker, never a silent partial. */
const STREAM_FLUSH_MAX_CHUNKS = 16;

/** Stream mode: characters per terminal-transcript attachment part. A skipped burst exists on
 *  NO other surface, so its delivery must be un-failable by construction — one unbounded file
 *  can exceed Discord's upload cap and be rejected WHOLE, which would be the exact silent loss
 *  the skip marker promised against. 2M chars ≤ 8 MiB even at 4-byte worst-case UTF-8. */
const DEFAULT_ATTACH_PART_CHARS = 2_000_000;

/** The info string of the fence left OPEN at the end of `text`, or undefined when balanced.
 *  Same line discipline as messageChunks' splitter: a fence line is ``` plus an optional info
 *  string, and fence state toggles per fence line. */
function openFenceAtEnd(text: string): string | undefined {
  let open: string | undefined;
  for (const line of text.split('\n')) {
    const match = /^\s*```(.*)$/.exec(line);
    if (match) open = open === undefined ? (match[1] ?? '').trim() : undefined;
  }
  return open;
}

/** Terminal states: no more edits follow, so the card is flushed to final immediately (bypassing
 *  the coalescing window) and a standalone summary card is posted. */
const TERMINAL_STATES: ReadonlySet<SessionState> = new Set(['done', 'failed', 'orphaned']);

type SessionState = PayloadOf<'session.status'>['state'];

/** Composite routing key — exported so the gateway keys its own (message-id, timer) maps
 *  identically. NUL-joined (a byte no Discord id or sessionId can contain), written as the
 *  ESCAPE sequence, never a raw byte: a literal NUL in source makes grep-family tools classify
 *  the whole file as binary and silently skip it. */
export function sessionRouteKey(route: SessionRoute): string {
  return `${route.discordUserId}\u0000${route.sessionId}`;
}

// File-embedded honesty markers (never silent): a declared gap and a source-side truncation each
// leave a VISIBLE mark in the accumulated transcript, so the attached file reads truthfully too.
function gapMarker(fromSeq: number, toSeq: number): string {
  return `\n⟨gap: output seq ${fromSeq}–${toSeq} lost⟩\n`;
}
const TRUNCATION_MARKER = '\n⟨source truncated its output here⟩\n';
/** Written into the transcript when the daemon's output `epoch` changes mid-session (a daemon
 *  restart that resumed this session). The daemon re-numbers `seq` from 0 across the restart, so
 *  we reset reassembly and mark the seam VISIBLY here — otherwise the resumed turn's low seqs fall
 *  below our advanced `nextSeq` and OrderedOutput would drop them silently (the plan bans that). */
const STREAM_RESTART_MARKER = '\n⟨output stream restarted — daemon resumed this session⟩\n';

/** All mutable per-session state the planner tracks. Purely data — no ids, no discord.js. */
interface SessionView {
  route: SessionRoute;
  /** Presentation mode, fixed by the first frame's caller-supplied mode (see {@link PlanMode}). */
  mode: PlanMode;
  state: SessionState;
  summary: string | undefined;
  accountId: string | undefined;
  /** Optimistic: a stop was requested and no terminal status has arrived to confirm it yet. */
  stopping: boolean;
  output: OrderedOutput;
  /** Stream mode: stdout (plus gap/restart markers) committed since the last inline emission —
   *  the batch the next flush posts as appended messages. Always empty in card mode. */
  pendingStream: string;
  /** Stream mode: some buffered output was skipped inline (a burst over the threshold), so the
   *  terminal flush MUST deliver the complete transcript as an attachment — the skipped bytes
   *  exist on no other surface. */
  streamCut: boolean;
  /** Stream mode: info string of the code fence the LAST emitted batch ended inside, if any.
   *  Each Discord message renders in isolation, so a fence spanning two flushes must close at
   *  the first batch's end and reopen (with this info string) at the next — see emitStream. */
  openFence: string | undefined;
  /** The daemon-run token last seen on this session's output (see `session.output.epoch`).
   *  `undefined` until the first epoch-bearing chunk; a CHANGE means the daemon restarted and
   *  resumed the session, so reassembly is reset. Stays `undefined` forever for a pre-epoch
   *  daemon, whose absent epoch never triggers a reset. */
  outputEpoch: string | undefined;
  /** The reassembled stdout+error transcript (with gap/truncation markers) — the attachment body. */
  fullStdout: string;
  attached: boolean;
  attachedLen: number;
  hasGap: boolean;
  sourceTruncated: boolean;
  hadError: boolean;
  cardPosted: boolean;
  dirty: boolean;
  lastEditAtMs: number;
  flushScheduledAtMs: number | undefined;
  terminalPosted: boolean;
}

export class SessionPlanner {
  private readonly views = new Map<string, SessionView>();
  private readonly window: number;
  private readonly tailChars: number;
  private readonly attachThreshold: number;
  private readonly gapGraceMs: number | undefined;
  private readonly attachPartChars: number;

  constructor(config: SessionPlannerConfig = {}) {
    this.window = config.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    this.tailChars = config.cardTailChars ?? DEFAULT_CARD_TAIL_CHARS;
    this.attachThreshold = config.attachThresholdChars ?? DEFAULT_ATTACH_THRESHOLD_CHARS;
    this.gapGraceMs = config.gapGraceMs;
    this.attachPartChars = config.attachPartChars ?? DEFAULT_ATTACH_PART_CHARS;
  }

  /** A `session.status` update. Card mode: creates the card on the first-ever event for the
   *  session and edits it thereafter. Stream mode: posts action-worthy state changes as their own
   *  lines. On a terminal state both modes finalize: the surface flushes (final card edit / buffer
   *  drain), the standalone summary card posts, and the output attachment delivers where owed.
   *  `mode` applies to a session's FIRST frame and is sticky thereafter (see {@link PlanMode}). */
  onStatus(
    route: SessionRoute,
    payload: PayloadOf<'session.status'>,
    now: number,
    mode: PlanMode = 'card',
  ): PlanResult {
    const view = this.viewFor(route, mode);
    const first = !view.cardPosted;
    const prevState = view.state;
    view.state = payload.state;
    view.summary = payload.summary ?? undefined;
    view.accountId = payload.accountId ?? undefined;

    const ops: GatewayOp[] = [];
    if (view.mode === 'card') {
      this.ensureCard(view, ops, now);
      // The card that ensureCard just posted already reflects the new state; an EXISTING card
      // needs an edit to catch up. Terminal edits bypass the coalescing window.
      if (!first) view.dirty = true;
    } else if (payload.state !== prevState) {
      this.streamStateLine(view, payload.state, ops);
    }

    if (TERMINAL_STATES.has(payload.state)) {
      view.stopping = false;
      // Terminal: collapse every remaining reorder hole so the transcript is complete, posting any
      // milestone/error lines that were buffered behind a gap (dropping them would be silent loss).
      this.applyItems(view, view.output.resolveGaps(now, true), ops, now);
      if (view.mode === 'card') {
        this.forceEditCard(view, ops, now);
      } else {
        // Drain the buffer ahead of the summary so the transcript reads in order.
        this.emitStream(view, ops, now);
      }
      this.postSummary(view, ops);
      this.attachIfNeeded(view, ops, /*final*/ true);
      view.flushScheduledAtMs = undefined;
      return { ops };
    }
    const at = this.planFlush(view, ops, now);
    return at !== undefined ? { ops, flushAtMs: at } : { ops };
  }

  /** A `session.output` chunk. Card mode: stdout accumulates into the live card's tail (coalesced)
   *  and the attachment. Stream mode: stdout buffers and posts as appended messages per coalescing
   *  window. In both, milestone/summary/error post as their own standalone lines, never dropped. */
  onOutput(
    route: SessionRoute,
    payload: PayloadOf<'session.output'>,
    now: number,
    mode: PlanMode = 'card',
  ): PlanResult {
    const view = this.viewFor(route, mode);
    const ops: GatewayOp[] = [];
    if (view.mode === 'card') this.ensureCard(view, ops, now);
    // A daemon-run change (crash + resume) restarts `seq` at 0 — reset reassembly first so the
    // resumed chunk is committed, not dropped as "below nextSeq". No-op for a pre-epoch daemon.
    this.applyOutputEpoch(view, payload.epoch ?? undefined);
    const items = view.output.accept(
      { seq: payload.seq, kind: payload.kind, text: payload.text, truncated: payload.truncated },
      now,
    );
    this.applyItems(view, items, ops, now);
    this.attachIfNeeded(view, ops, /*final*/ false);
    const at = this.planFlush(view, ops, now);
    return at !== undefined ? { ops, flushAtMs: at } : { ops };
  }

  /** The user asked to stop this session (from `/stop` or the card's Stop button). Card mode
   *  optimistically flips the card to "stopping…"; stream mode posts a one-line acknowledgment —
   *  either way the surface never looks idle while the stop is in flight, and the real terminal
   *  `session.status` later resolves it. A no-op (empty ops) if the session was never streamed
   *  here — the stop still travels to the daemon regardless. */
  onStopRequested(route: SessionRoute, now: number): PlanResult {
    const view = this.views.get(sessionRouteKey(route));
    if (!view || view.terminalPosted || view.stopping) return { ops: [] };
    if (view.mode === 'card' && !view.cardPosted) return { ops: [] };
    view.stopping = true;
    const ops: GatewayOp[] = [];
    if (view.mode === 'card') {
      view.dirty = true;
      // Show "stopping…" immediately — a stop confirmation must not wait out a coalescing window.
      this.forceEditCard(view, ops, now);
    } else {
      ops.push(this.line(view, '🛑 stopping…'));
    }
    return { ops };
  }

  /** Called by the gateway when a scheduled flush fires: drain any grace-expired gap, then emit the
   *  single coalesced card edit if one is due. May return a fresh `flushAtMs` if work still pends. */
  flush(route: SessionRoute, now: number): PlanResult {
    const view = this.views.get(sessionRouteKey(route));
    if (!view) return { ops: [] };
    const ops: GatewayOp[] = [];
    view.flushScheduledAtMs = undefined;
    // A gap that outlived its grace with no further output is surfaced here.
    this.applyItems(view, view.output.resolveGaps(now, false), ops, now);
    this.attachIfNeeded(view, ops, /*final*/ false);
    const at = this.planFlush(view, ops, now);
    return at !== undefined ? { ops, flushAtMs: at } : { ops };
  }

  /** Drop a terminal session's state (the gateway calls this after a grace so a long-lived bot does
   *  not retain every finished session forever). Safe on unknown routes. */
  forget(route: SessionRoute): void {
    this.views.delete(sessionRouteKey(route));
  }

  // -------------------------------------------------------------------------
  // internals
  // -------------------------------------------------------------------------

  /** Build an OrderedOutput with this planner's configured gap grace — one place so a fresh view
   *  AND an epoch-triggered reset build it identically. */
  private makeOrderedOutput(): OrderedOutput {
    return new OrderedOutput(this.gapGraceMs !== undefined ? { gapGraceMs: this.gapGraceMs } : {});
  }

  /** Reset reassembly across a daemon-run change on the output stream. A daemon restart re-numbers
   *  this session's `seq` from 0; without a reset the resumed turn's low seqs fall below the
   *  advanced `nextSeq` and OrderedOutput.accept drops them silently. An absent/undefined epoch (a
   *  pre-epoch daemon) NEVER triggers a reset — behaviour is exactly as before. The first epoch ever
   *  seen is adopted WITHOUT a marker (there is no prior stream to have been interrupted). A real
   *  change swaps in a fresh OrderedOutput and writes a visible restart marker into the transcript
   *  (the same "never silent" mechanism as gap/truncation markers). */
  private applyOutputEpoch(view: SessionView, epoch: string | undefined): void {
    if (epoch === undefined) return; // old daemon: no epoch → no reset, unchanged behaviour
    if (view.outputEpoch === undefined) {
      view.outputEpoch = epoch; // first epoch seen: adopt it, no reset
      return;
    }
    if (view.outputEpoch === epoch) return; // same run: nothing to do
    view.outputEpoch = epoch;
    view.output = this.makeOrderedOutput();
    view.fullStdout += STREAM_RESTART_MARKER;
    if (view.mode === 'stream') view.pendingStream += STREAM_RESTART_MARKER;
    view.dirty = true;
  }

  private viewFor(route: SessionRoute, mode: PlanMode = 'card'): SessionView {
    const k = sessionRouteKey(route);
    let view = this.views.get(k);
    if (!view) {
      view = {
        route,
        mode,
        state: 'starting',
        summary: undefined,
        accountId: undefined,
        stopping: false,
        output: this.makeOrderedOutput(),
        pendingStream: '',
        streamCut: false,
        openFence: undefined,
        outputEpoch: undefined,
        fullStdout: '',
        attached: false,
        attachedLen: -1,
        hasGap: false,
        sourceTruncated: false,
        hadError: false,
        cardPosted: false,
        dirty: false,
        lastEditAtMs: 0,
        flushScheduledAtMs: undefined,
        terminalPosted: false,
      };
      this.views.set(k, view);
    }
    return view;
  }

  /** Post the live card the first time we see any event for a session (renders current state).
   *  Card mode only — a stream session's surface is its appended messages, never a card. */
  private ensureCard(view: SessionView, ops: GatewayOp[], now: number): void {
    if (view.mode !== 'card' || view.cardPosted) return;
    ops.push({
      kind: 'sendMessage',
      route: view.route,
      role: 'card',
      embed: this.cardEmbed(view),
      components: this.cardComponents(view),
    });
    view.cardPosted = true;
    view.lastEditAtMs = now;
    view.dirty = false;
  }

  /** Route committed output items to their presentation: stdout/error into the transcript (and the
   *  coalesced card tail), milestone/summary/error also as their own standalone lines, gaps as
   *  visible transcript markers. Never silent, never reordered — in stream mode a standalone
   *  line first DRAINS the buffered stdout ahead of it, so the thread never shows an
   *  annotation apparently preceding output that in fact came before it. (The forced early
   *  emission trades a little coalescing for the top-to-bottom ordering the surface promises;
   *  annotation lines are rare, the ordering contract is permanent.) */
  private applyItems(
    view: SessionView,
    items: CommittedItem[],
    ops: GatewayOp[],
    now: number,
  ): void {
    for (const item of items) {
      if (item.kind === 'gap') {
        const marker = gapMarker(item.fromSeq, item.toSeq);
        view.fullStdout += marker;
        // Stream mode has no card to badge, so the gap marker flows into the thread itself —
        // the same "a loss is VISIBLE where the reader is looking" rule, different surface.
        if (view.mode === 'stream') view.pendingStream += marker;
        view.hasGap = true;
        view.dirty = true;
        continue;
      }
      const text = item.truncated ? `${item.text}${TRUNCATION_MARKER}` : item.text;
      if (item.truncated) view.sourceTruncated = true;
      switch (item.outputKind) {
        case 'stdout':
          view.fullStdout += text;
          if (view.mode === 'stream') view.pendingStream += text;
          view.dirty = true;
          break;
        case 'error':
          // Errors matter twice: they belong in the transcript AND deserve their own visible line.
          view.fullStdout += text;
          view.hadError = true;
          view.dirty = true;
          this.emitStream(view, ops, now); // keep seq order: buffered stdout first (no-op in card mode)
          ops.push(this.line(view, `❗ ${formatTables(item.text)}`, item.truncated));
          break;
        case 'milestone':
          this.emitStream(view, ops, now);
          ops.push(this.line(view, `🔹 ${formatTables(item.text)}`, item.truncated));
          break;
        case 'summary':
          // Standalone lines post as plain proportional-font content, where a terminal
          // table is unreadable — re-render any tables phone-width inside a code fence.
          this.emitStream(view, ops, now);
          ops.push(this.line(view, `📝 ${formatTables(item.text)}`, item.truncated));
          break;
      }
    }
  }

  private line(view: SessionView, content: string, truncated = false): GatewayOp {
    const withMarker = truncated ? `${content} ⟨truncated⟩` : content;
    return {
      kind: 'sendMessage',
      route: view.route,
      role: 'line',
      // Clamp to Discord's 2000-char content ceiling (accounting for the emoji prefix already in
      // `content` and any ⟨truncated⟩ marker): discord.js rejects an over-long `content`, executeOps
      // swallows the throw, and the line would vanish — and it is NOT in fullStdout for milestone/
      // summary lines, so it would appear on no surface. truncateLabeled keeps the result ≤ limit
      // and ending in a visible truncation label.
      content: truncateLabeled(withMarker, MESSAGE_CONTENT_LIMIT),
    };
  }

  /** Deliver the full output as a file once it grows past the inline threshold, and again at
   *  terminal if more arrived since — so the attachment is always the COMPLETE transcript, never a
   *  stale prefix. Re-attaches only when the length actually advanced, so it is never spammy.
   *
   *  Stream mode owes a file ONLY when a skipped burst left bytes on no other surface: the
   *  appended messages already carry the transcript, so a routine mid-run attachment would just
   *  duplicate what the reader scrolled past. */
  private attachIfNeeded(view: SessionView, ops: GatewayOp[], final: boolean): void {
    const len = view.fullStdout.length;
    if (len === 0) return;
    if (view.mode === 'stream') {
      if (!final || !view.streamCut) return;
      // Split into parts each far below Discord's upload cap: the skipped bursts exist on NO
      // other surface, so this delivery must be un-failable by construction — one unbounded
      // file would be rejected WHOLE past the cap, the exact loss the skip marker promised
      // against.
      const parts: string[] = [];
      for (let i = 0; i < view.fullStdout.length; i += this.attachPartChars) {
        parts.push(view.fullStdout.slice(i, i + this.attachPartChars));
      }
      for (const [index, part] of parts.entries()) {
        ops.push({
          kind: 'uploadAttachment',
          route: view.route,
          filename:
            parts.length === 1
              ? `session-${view.route.sessionId}.log`
              : `session-${view.route.sessionId}-part${index + 1}of${parts.length}.log`,
          text: part,
          ...(index === 0
            ? { content: 'Complete transcript attached — parts were skipped inline above.' }
            : {}),
        });
      }
      view.attached = true;
      view.attachedLen = len;
      return;
    }
    // Strictly-greater so that, with the default threshold == tail size, output that exactly fits
    // the inline tail stays inline-only while anything LONGER (which the tail would clip) attaches.
    const firstCrossing = !view.attached && len > this.attachThreshold;
    const finalTopUp = final && view.attached && len > view.attachedLen;
    if (!firstCrossing && !finalTopUp) return;
    ops.push({
      kind: 'uploadAttachment',
      route: view.route,
      filename: `session-${view.route.sessionId}.log`,
      text: view.fullStdout,
      ...(firstCrossing ? { content: 'Full output attached (streaming continues below).' } : {}),
    });
    view.attached = true;
    view.attachedLen = len;
    view.dirty = true; // the card should now show the "full output attached" note
  }

  /** Post the standalone final summary card at terminal (once). */
  private postSummary(view: SessionView, ops: GatewayOp[]): void {
    if (view.terminalPosted) return;
    view.terminalPosted = true;
    ops.push({
      kind: 'sendMessage',
      route: view.route,
      role: 'line',
      embed: buildSessionSummaryEmbed(this.cardModel(view)),
    });
  }

  /** Emit the coalesced surface update if one is due now — a card edit or a stream batch, by
   *  mode — and compute when the gateway should next call `flush` (for a still-pending coalesced
   *  emission and/or a not-yet-expired gap). Returns that wake time, or undefined when nothing
   *  pends. */
  private planFlush(view: SessionView, ops: GatewayOp[], now: number): number | undefined {
    if (view.mode === 'stream') {
      // First-ever emission goes out immediately (lastEditAtMs starts 0); later ones coalesce.
      if (view.pendingStream.length > 0 && now - view.lastEditAtMs >= this.window) {
        this.emitStream(view, ops, now);
      }
      let at: number | undefined;
      if (view.pendingStream.length > 0) at = view.lastEditAtMs + this.window;
      const gapAt = view.output.gapDeadline();
      if (gapAt !== undefined) at = at === undefined ? gapAt : Math.min(at, gapAt);
      view.flushScheduledAtMs = at;
      return at;
    }
    if (view.dirty && view.cardPosted && now - view.lastEditAtMs >= this.window) {
      this.editCard(view, ops, now);
    }
    let at: number | undefined;
    if (view.dirty && view.cardPosted) at = view.lastEditAtMs + this.window;
    const gapAt = view.output.gapDeadline();
    if (gapAt !== undefined) at = at === undefined ? gapAt : Math.min(at, gapAt);
    view.flushScheduledAtMs = at;
    return at;
  }

  /** Stream mode: post everything buffered as appended messages — or, for an over-threshold
   *  burst, one visible skip marker (the complete transcript then attaches at terminal; see
   *  {@link attachIfNeeded}) — stamping the emission time that anchors the next coalescing
   *  window. A no-op on an empty buffer, so terminal paths may call it unconditionally. */
  private emitStream(view: SessionView, ops: GatewayOp[], now: number): void {
    if (view.mode !== 'stream' || view.pendingStream.length === 0) return;
    // Re-enter any fence the previous batch ended inside: each Discord message renders in
    // isolation, so a fence spanning two flushes must be closed at the first batch's end
    // (below) and reopened here with its original info string — otherwise the continuation
    // renders its code as prose and its prose as code.
    const prefix = view.openFence !== undefined ? `\`\`\`${view.openFence}\n` : '';
    const text = prefix + view.pendingStream;
    view.pendingStream = '';
    view.lastEditAtMs = now;
    // Track fence state across the SKIP path too: the skipped burst still advanced the
    // source's fence state, and the next inline batch must continue from where it truly is.
    const endFence = openFenceAtEnd(text);
    view.openFence = endFence;
    if (text.length > STREAM_SKIP_THRESHOLD_CHARS) {
      view.streamCut = true;
      ops.push({
        kind: 'sendMessage',
        route: view.route,
        role: 'line',
        content:
          `⏩ ${text.length} characters arrived too fast to stream inline — skipped here; ` +
          `the complete transcript is attached when the session ends.`,
      });
      return;
    }
    const balanced = endFence !== undefined ? `${text}\n\`\`\`` : text;
    for (const chunk of chunkMessage(balanced, { maxChunks: STREAM_FLUSH_MAX_CHUNKS })) {
      // A marker-only buffer can chunk to whitespace, and Discord rejects empty content.
      if (chunk.trim().length === 0) continue;
      ops.push({ kind: 'sendMessage', route: view.route, role: 'line', content: chunk });
    }
  }

  /** Stream mode: surface the state changes the user must ACT on (or would otherwise misread as
   *  silence) as their own lines. Starting/running transitions are noise in a thread whose content
   *  already shows liveness, and done/failed speak through the terminal summary embed. */
  private streamStateLine(view: SessionView, state: SessionState, ops: GatewayOp[]): void {
    if (state === 'waiting_permission') {
      ops.push(
        this.line(view, '🔐 waiting for a permission decision — check the card in your DMs'),
      );
    } else if (state === 'waiting_input') {
      ops.push(this.line(view, '⌨️ waiting for input — reply here to continue'));
    } else if (state === 'orphaned') {
      ops.push(
        this.line(
          view,
          '🪦 the daemon restarted and this session went dormant — send a message here to resume it',
        ),
      );
    }
  }

  /** Edit the card to its final state immediately, ignoring the coalescing window (terminal / stop
   *  transitions must show at once). No-op if the card is not dirty (already current). */
  private forceEditCard(view: SessionView, ops: GatewayOp[], now: number): void {
    if (!view.dirty || !view.cardPosted) return;
    this.editCard(view, ops, now);
  }

  private editCard(view: SessionView, ops: GatewayOp[], now: number): void {
    ops.push({
      kind: 'editMessage',
      route: view.route,
      ref: 'card',
      embed: this.cardEmbed(view),
      components: this.cardComponents(view),
    });
    view.lastEditAtMs = now;
    view.dirty = false;
  }

  /** The Stop control lives on the card only while the session is live and not already stopping — a
   *  terminal or stopping card clears its row on the same edit. */
  private cardComponents(view: SessionView): ButtonSpec[][] {
    const stoppable = !view.stopping && !TERMINAL_STATES.has(view.state);
    return sessionCardButtons({ sessionId: view.route.sessionId, stoppable });
  }

  private cardEmbed(view: SessionView): EmbedBuilder {
    return buildSessionCardEmbed(this.cardModel(view));
  }

  private cardModel(view: SessionView): SessionCardModel {
    const tail = view.fullStdout.length > 0 ? view.fullStdout.slice(-this.tailChars) : undefined;
    return {
      sessionId: view.route.sessionId,
      state: view.state,
      stopping: view.stopping,
      ...(view.summary !== undefined ? { summary: view.summary } : {}),
      ...(view.accountId !== undefined ? { accountId: view.accountId } : {}),
      ...(tail !== undefined ? { outputTail: tail } : {}),
      totalOutputChars: view.fullStdout.length,
      attached: view.attached,
      hasGap: view.hasGap,
      sourceTruncated: view.sourceTruncated,
      hadError: view.hadError,
    };
  }
}
