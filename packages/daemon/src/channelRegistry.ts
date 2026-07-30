// Which live sessions have a channel server attached, and what is queued for each.
//
// A channel is the only way text reaches a Claude Code session that is sitting IDLE at its
// prompt — the hook-response steering path can only answer a hook that is already in flight, so
// it delivers at the next turn boundary and not before. This registry is the daemon's half of
// that: the channel server (one stdio child per session, spawned by Claude Code itself) attaches
// here, long-polls for work, and emits what it is handed as an MCP channel notification.
//
// Deliberately transport-free. The receiver owns held HTTP responses and sockets; this module
// owns only the queue and the attachment bookkeeping, mirroring how the receiver already
// delegates `cctl session` logic to injected handlers.
//
// The hard requirement is that a message is never silently lost. A channel server can die
// between being handed an injection and actually writing it, so taken items stay IN FLIGHT until
// acknowledged and are recovered on detach — the caller then falls back to turn-boundary
// steering rather than dropping them.

import { randomUUID } from 'node:crypto';

/** Matches the steering queue's cap, so the two delivery paths refuse at the same depth and an
 *  operator does not have to learn two different limits. */
export const CHANNEL_QUEUE_CAP = 8;

/** Matches the steering queue's TTL. Text queued half an hour ago is stale advice, and quietly
 *  delivering it into whatever the session is doing now is worse than dropping it. */
export const CHANNEL_TTL_MS = 30 * 60_000;

/** How long the daemon holds a `/cli/channel/next` poll open before answering empty. Bounded so
 *  shutdown stays fast and a dead daemon is detectable by the client without extra machinery;
 *  Node imposes no response deadline of its own. */
export const CHANNEL_POLL_MS = 30_000;

/** An attachment with no poll for this long is treated as dead and swept. Comfortably longer
 *  than the poll bound so a client that is merely between polls is never mistaken for gone. */
export const CHANNEL_ATTACH_STALE_MS = 3 * CHANNEL_POLL_MS;

/** How the channel server worked out which session it belongs to. Recorded because an
 *  `ancestry` resolution is a weaker claim than `env` and is worth surfacing when a message
 *  lands somewhere surprising. */
export type ChannelIdentitySource = 'env' | 'ancestry';

export interface ChannelAttachInput {
  sessionId: string;
  pid: number;
  cwd?: string;
  name?: string;
  identitySource: ChannelIdentitySource;
}

export interface ChannelAttachment extends ChannelAttachInput {
  attachId: string;
  attachedAtMs: number;
  lastPollAtMs: number;
}

export interface ChannelInjection {
  injectId: string;
  text: string;
  meta?: Record<string, string>;
  queuedAtMs: number;
}

export type EnqueueResult =
  { ok: true; injectId: string } | { ok: false; reason: 'not_attached' | 'queue_full' };

export interface ChannelRegistryOptions {
  clock?: () => number;
  /** Called when work arrives for an attachment, so the receiver can complete a held poll
   *  immediately instead of leaving the operator waiting for the next one. */
  onEnqueue?: (attachId: string) => void;
  queueCap?: number;
  ttlMs?: number;
}

export class ChannelRegistry {
  private readonly clock: () => number;
  private readonly onEnqueue: ((attachId: string) => void) | undefined;
  private readonly queueCap: number;
  private readonly ttlMs: number;

  private readonly attachments = new Map<string, ChannelAttachment>();
  /** One attachment per session. A second server for the same session is a bug (two copies of
   *  the plugin, or a stale process that outlived its CLI), and admitting it would make delivery
   *  a coin flip between them. */
  private readonly bySession = new Map<string, string>();
  private readonly queues = new Map<string, ChannelInjection[]>();
  /** Handed to a client but not yet acknowledged. Recovered on detach so a channel server that
   *  dies mid-delivery costs a fallback, not a lost message. */
  private readonly inFlight = new Map<string, Map<string, ChannelInjection>>();

  constructor(options: ChannelRegistryOptions = {}) {
    this.clock = options.clock ?? Date.now;
    this.onEnqueue = options.onEnqueue;
    this.queueCap = options.queueCap ?? CHANNEL_QUEUE_CAP;
    this.ttlMs = options.ttlMs ?? CHANNEL_TTL_MS;
  }

  /** Attach a channel server to a session. Refuses a second attachment for a session that
   *  already has a live one, unless the existing attachment has gone stale (its process died
   *  without detaching, which is the ordinary case after a crash). */
  attach(
    input: ChannelAttachInput,
  ): { ok: true; attachment: ChannelAttachment } | { ok: false; reason: 'already_attached' } {
    const now = this.clock();
    const existingId = this.bySession.get(input.sessionId);
    // Whatever the outgoing server never delivered is carried onto the newcomer's queue rather
    // than dropped: the session is the same one, it is alive again, and the operator was told the
    // text was sent. `take` re-applies the TTL, so anything genuinely stale still expires there.
    let inherited: ChannelInjection[] = [];
    if (existingId !== undefined) {
      const existing = this.attachments.get(existingId);
      if (existing !== undefined && now - existing.lastPollAtMs < CHANNEL_ATTACH_STALE_MS) {
        return { ok: false, reason: 'already_attached' };
      }
      inherited = this.detach(existingId);
    }
    const attachment: ChannelAttachment = {
      ...input,
      attachId: randomUUID(),
      attachedAtMs: now,
      lastPollAtMs: now,
    };
    this.attachments.set(attachment.attachId, attachment);
    this.bySession.set(input.sessionId, attachment.attachId);
    this.queues.set(attachment.attachId, inherited);
    this.inFlight.set(attachment.attachId, new Map());
    return { ok: true, attachment };
  }

  /** Detach and hand back everything undelivered, so the caller can fall the messages back to
   *  turn-boundary steering instead of losing them. In-flight items come first: they were queued
   *  earlier than anything still waiting. */
  detach(attachId: string): ChannelInjection[] {
    const attachment = this.attachments.get(attachId);
    if (attachment === undefined) return [];
    const flying = [...(this.inFlight.get(attachId)?.values() ?? [])];
    const queued = this.queues.get(attachId) ?? [];
    this.attachments.delete(attachId);
    this.queues.delete(attachId);
    this.inFlight.delete(attachId);
    if (this.bySession.get(attachment.sessionId) === attachId) {
      this.bySession.delete(attachment.sessionId);
    }
    return [...flying, ...queued].sort((a, b) => a.queuedAtMs - b.queuedAtMs);
  }

  get(attachId: string): ChannelAttachment | undefined {
    return this.attachments.get(attachId);
  }

  /** The live attachment for a session, if any. This — not what the launch command intended —
   *  is the daemon's only evidence that a session can take an injection right now. */
  attachmentFor(sessionId: string): ChannelAttachment | undefined {
    const attachId = this.bySession.get(sessionId);
    return attachId === undefined ? undefined : this.attachments.get(attachId);
  }

  isAttached(sessionId: string): boolean {
    return this.attachmentFor(sessionId) !== undefined;
  }

  list(): ChannelAttachment[] {
    return [...this.attachments.values()];
  }

  /** Queue text for a session's live channel. Refuses rather than silently shedding when the
   *  queue is full, matching the steering queue's contract. */
  enqueue(sessionId: string, text: string, meta?: Record<string, string>): EnqueueResult {
    const attachment = this.attachmentFor(sessionId);
    if (attachment === undefined) return { ok: false, reason: 'not_attached' };
    const queue = this.queues.get(attachment.attachId);
    if (queue === undefined) return { ok: false, reason: 'not_attached' };
    const inFlightCount = this.inFlight.get(attachment.attachId)?.size ?? 0;
    if (queue.length + inFlightCount >= this.queueCap) return { ok: false, reason: 'queue_full' };
    const injection: ChannelInjection = {
      injectId: randomUUID(),
      text,
      ...(meta !== undefined ? { meta } : {}),
      queuedAtMs: this.clock(),
    };
    queue.push(injection);
    this.onEnqueue?.(attachment.attachId);
    return { ok: true, injectId: injection.injectId };
  }

  /** Hand a poller everything queued for it, moving those items in-flight. Expired items are
   *  dropped here rather than delivered: see {@link CHANNEL_TTL_MS}. */
  take(attachId: string): ChannelInjection[] | undefined {
    const attachment = this.attachments.get(attachId);
    if (attachment === undefined) return undefined;
    const now = this.clock();
    attachment.lastPollAtMs = now;
    const queue = this.queues.get(attachId) ?? [];
    const fresh = queue.filter((item) => now - item.queuedAtMs <= this.ttlMs);
    this.queues.set(attachId, []);
    const flying = this.inFlight.get(attachId);
    if (flying !== undefined) for (const item of fresh) flying.set(item.injectId, item);
    return fresh;
  }

  /** Record the client's report for one injection. A failure puts the item back at the FRONT of
   *  the queue — it was queued before anything that arrived while it was in flight, and delivery
   *  order is the one property an operator will notice. */
  ack(
    attachId: string,
    injectId: string,
    state: 'sent' | 'failed',
  ): { ok: boolean; requeued: boolean } {
    const flying = this.inFlight.get(attachId);
    const item = flying?.get(injectId);
    if (flying === undefined || item === undefined) return { ok: false, requeued: false };
    flying.delete(injectId);
    if (state === 'sent') return { ok: true, requeued: false };
    this.queues.get(attachId)?.unshift(item);
    return { ok: true, requeued: true };
  }

  /** Drop attachments whose client stopped polling, returning their undelivered work so the
   *  caller can fall it back. Called on a timer; a dead channel server has no other way to tell
   *  us it is gone. */
  sweepStale(): { attachment: ChannelAttachment; recovered: ChannelInjection[] }[] {
    const now = this.clock();
    const dead: { attachment: ChannelAttachment; recovered: ChannelInjection[] }[] = [];
    for (const attachment of [...this.attachments.values()]) {
      if (now - attachment.lastPollAtMs < CHANNEL_ATTACH_STALE_MS) continue;
      dead.push({ attachment, recovered: this.detach(attachment.attachId) });
    }
    return dead;
  }

  /** Everything still undelivered, for a clean shutdown that wants to fall messages back rather
   *  than drop them on the floor. */
  drainAll(): ChannelInjection[] {
    return [...this.attachments.keys()].flatMap((attachId) => this.detach(attachId));
  }
}
