import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ATTACH_STALE_MS,
  CHANNEL_POLL_MS,
  CHANNEL_QUEUE_CAP,
  CHANNEL_TTL_MS,
  ChannelRegistry,
  type ChannelInjection,
} from './channelRegistry.js';

/** A clock the test drives by hand, so TTL and staleness are exercised without real waiting. */
function fakeClock(start = 1_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const attachInput = (sessionId = 'sess-1') => ({
  sessionId,
  pid: 4242,
  cwd: 'C:\\repo',
  name: 'repo-ab',
  identitySource: 'env' as const,
});

describe('attach', () => {
  it('attaches a session and makes it addressable', () => {
    const reg = new ChannelRegistry();
    const result = reg.attach(attachInput());
    expect(result.ok).toBe(true);
    expect(reg.isAttached('sess-1')).toBe(true);
    expect(reg.attachmentFor('sess-1')?.pid).toBe(4242);
  });

  it('refuses a second live server for the same session rather than splitting delivery', () => {
    const reg = new ChannelRegistry();
    reg.attach(attachInput());
    const second = reg.attach(attachInput());
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_attached');
  });

  it('lets a new server reclaim a session whose old one stopped polling', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    reg.attach(attachInput());
    clock.advance(CHANNEL_ATTACH_STALE_MS + 1);
    expect(reg.attach(attachInput()).ok).toBe(true);
  });

  it('carries the dead server’s undelivered work onto the replacement', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    const first = reg.attach(attachInput());
    if (!first.ok) throw new Error('attach failed');
    reg.enqueue('sess-1', 'queued before the crash');
    reg.enqueue('sess-1', 'also undelivered');
    // One of them was handed out but never acknowledged before the server died.
    reg.take(first.attachment.attachId);
    reg.enqueue('sess-1', 'arrived after');

    clock.advance(CHANNEL_ATTACH_STALE_MS + 1);
    const second = reg.attach(attachInput());
    if (!second.ok) throw new Error('re-attach failed');
    expect(reg.take(second.attachment.attachId)?.map((i) => i.text)).toEqual([
      'queued before the crash',
      'also undelivered',
      'arrived after',
    ]);
  });

  it('still expires inherited work that aged past the TTL', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    reg.attach(attachInput());
    reg.enqueue('sess-1', 'ancient');
    clock.advance(CHANNEL_TTL_MS + 1);
    const second = reg.attach(attachInput());
    if (!second.ok) throw new Error('re-attach failed');
    expect(reg.take(second.attachment.attachId)).toEqual([]);
  });

  it('inherited work keeps its ORIGINAL queue time, so re-attaching cannot renew a TTL', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    reg.attach(attachInput());
    reg.enqueue('sess-1', 'queued at the very start');
    // Old enough to be inherited by a replacement, young enough to survive the TTL...
    clock.advance(CHANNEL_ATTACH_STALE_MS + 1);
    const second = reg.attach(attachInput());
    if (!second.ok) throw new Error('re-attach failed');
    // …and it must still expire on the ORIGINAL schedule, not one restarted by the re-attach.
    clock.advance(CHANNEL_TTL_MS - CHANNEL_ATTACH_STALE_MS);
    expect(reg.take(second.attachment.attachId)).toEqual([]);
  });

  it('refuses to attach once the registry is closed, so a drain cannot be undone', () => {
    const reg = new ChannelRegistry();
    reg.attach(attachInput());
    reg.close();
    const after = reg.attach(attachInput('sess-2'));
    expect(after.ok).toBe(false);
    if (!after.ok) expect(after.reason).toBe('closing');
    expect(reg.list()).toEqual([]);
  });
});

describe('enqueue', () => {
  it('refuses when no channel is attached, so the caller can fall back', () => {
    const reg = new ChannelRegistry();
    const result = reg.enqueue('nobody', 'hello');
    expect(result).toEqual({ ok: false, reason: 'not_attached' });
  });

  it('wakes a held poll the moment work arrives', () => {
    const woken: string[] = [];
    const reg = new ChannelRegistry({ onEnqueue: (id) => woken.push(id) });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    reg.enqueue('sess-1', 'hello');
    expect(woken).toEqual([attached.attachment.attachId]);
  });

  it('refuses at the cap instead of silently shedding', () => {
    const reg = new ChannelRegistry();
    reg.attach(attachInput());
    for (let i = 0; i < CHANNEL_QUEUE_CAP; i++) {
      expect(reg.enqueue('sess-1', `m${i}`).ok).toBe(true);
    }
    expect(reg.enqueue('sess-1', 'one too many')).toEqual({ ok: false, reason: 'queue_full' });
  });

  it('counts in-flight items against the cap', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    for (let i = 0; i < CHANNEL_QUEUE_CAP; i++) reg.enqueue('sess-1', `m${i}`);
    // Taking them moves them in-flight; they are still undelivered, so the queue is still full.
    reg.take(attached.attachment.attachId);
    expect(reg.enqueue('sess-1', 'nope')).toEqual({ ok: false, reason: 'queue_full' });
  });
});

describe('take', () => {
  it('drains in order and reports an unknown attachment distinctly from an empty one', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    const id = attached.attachment.attachId;
    reg.enqueue('sess-1', 'first');
    reg.enqueue('sess-1', 'second');
    expect(reg.take(id)?.map((i) => i.text)).toEqual(['first', 'second']);
    expect(reg.take(id)).toEqual([]);
    expect(reg.take('no-such-attachment')).toBeUndefined();
  });

  it('drops items that aged past the TTL rather than delivering stale guidance', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    reg.enqueue('sess-1', 'stale');
    clock.advance(CHANNEL_TTL_MS + 1);
    expect(reg.take(attached.attachment.attachId)).toEqual([]);
  });

  it('reports what it expired, so an expiry can never be a silent drop', () => {
    const clock = fakeClock();
    const expiries: { sessionId: string; texts: string[] }[] = [];
    const reg = new ChannelRegistry({
      clock: clock.now,
      onExpire: (sessionId, expired: ChannelInjection[]) =>
        expiries.push({ sessionId, texts: expired.map((i) => i.text) }),
    });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    reg.enqueue('sess-1', 'too old');
    clock.advance(CHANNEL_TTL_MS + 1);
    reg.enqueue('sess-1', 'still fresh');

    expect(reg.take(attached.attachment.attachId)?.map((i) => i.text)).toEqual(['still fresh']);
    expect(expiries).toEqual([{ sessionId: 'sess-1', texts: ['too old'] }]);
  });

  it('says nothing when nothing expired', () => {
    let calls = 0;
    const reg = new ChannelRegistry({
      onExpire: () => {
        calls += 1;
      },
    });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    reg.enqueue('sess-1', 'fresh');
    reg.take(attached.attachment.attachId);
    expect(calls).toBe(0);
  });

  it('a daemon-side wake does NOT count as the client being alive', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    const id = attached.attachment.attachId;

    // The client stops polling and its socket half-opens; the daemon keeps pushing into it.
    clock.advance(CHANNEL_ATTACH_STALE_MS - 1);
    reg.enqueue('sess-1', 'pushed into a dead socket');
    reg.take(id, 'wake');
    clock.advance(2);

    // A write the client never read must not have restarted the staleness countdown.
    expect(reg.sweepStale()).toHaveLength(1);
    expect(reg.isAttached('sess-1')).toBe(false);
  });

  it('a real poll DOES count as the client being alive', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    clock.advance(CHANNEL_ATTACH_STALE_MS - 1);
    reg.take(attached.attachment.attachId, 'poll');
    clock.advance(2);
    expect(reg.sweepStale()).toEqual([]);
  });
});

describe('ack', () => {
  it('clears an item that was written', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    const id = attached.attachment.attachId;
    const queued = reg.enqueue('sess-1', 'hello');
    if (!queued.ok) throw new Error('enqueue failed');
    reg.take(id);
    expect(reg.ack(id, queued.injectId, 'sent')).toEqual({ ok: true, requeued: false });
    // Nothing left to recover once acknowledged.
    expect(reg.detach(id)).toEqual([]);
  });

  it('requeues a failed item at the FRONT so delivery order survives', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    const id = attached.attachment.attachId;
    const first = reg.enqueue('sess-1', 'first');
    if (!first.ok) throw new Error('enqueue failed');
    reg.take(id);
    reg.enqueue('sess-1', 'second');
    expect(reg.ack(id, first.injectId, 'failed').requeued).toBe(true);
    expect(reg.take(id)?.map((i) => i.text)).toEqual(['first', 'second']);
  });

  it('reports an unknown item rather than pretending success', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    expect(reg.ack(attached.attachment.attachId, 'never-existed', 'sent').ok).toBe(false);
  });
});

describe('detach and sweep', () => {
  it('hands back undelivered work so nothing is silently lost', () => {
    const reg = new ChannelRegistry();
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    const id = attached.attachment.attachId;
    reg.enqueue('sess-1', 'in flight');
    reg.take(id);
    reg.enqueue('sess-1', 'still queued');
    expect(reg.detach(id).map((i) => i.text)).toEqual(['in flight', 'still queued']);
    expect(reg.isAttached('sess-1')).toBe(false);
  });

  it('sweeps an attachment whose server stopped polling and returns its work', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    reg.attach(attachInput());
    reg.enqueue('sess-1', 'orphaned');
    clock.advance(CHANNEL_ATTACH_STALE_MS + 1);
    const swept = reg.sweepStale();
    expect(swept).toHaveLength(1);
    expect(swept[0]?.recovered.map((i) => i.text)).toEqual(['orphaned']);
    expect(reg.isAttached('sess-1')).toBe(false);
  });

  it('leaves an attachment alone while it is still polling', () => {
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now });
    const attached = reg.attach(attachInput());
    if (!attached.ok) throw new Error('attach failed');
    clock.advance(CHANNEL_ATTACH_STALE_MS - 1);
    reg.take(attached.attachment.attachId);
    clock.advance(CHANNEL_ATTACH_STALE_MS - 1);
    expect(reg.sweepStale()).toEqual([]);
    expect(reg.isAttached('sess-1')).toBe(true);
  });

  it('keeps sessions independent', () => {
    const reg = new ChannelRegistry();
    reg.attach(attachInput('sess-1'));
    reg.attach(attachInput('sess-2'));
    reg.enqueue('sess-1', 'for one');
    const two = reg.attachmentFor('sess-2');
    if (two === undefined) throw new Error('missing attachment');
    expect(reg.take(two.attachId)).toEqual([]);
    expect(reg.list()).toHaveLength(2);
  });

  it('drains everything on shutdown, naming the session each message was for', () => {
    const reg = new ChannelRegistry();
    reg.attach(attachInput('sess-1'));
    reg.attach(attachInput('sess-2'));
    reg.enqueue('sess-1', 'a');
    reg.enqueue('sess-2', 'b');
    // Grouped by attachment, not flattened: the caller has to fall each message back to ITS
    // session's turn-boundary queue, which a bare list of texts cannot tell it how to do.
    const drained = reg.close();
    expect(drained.map((d) => [d.attachment.sessionId, d.recovered.map((i) => i.text)])).toEqual([
      ['sess-1', ['a']],
      ['sess-2', ['b']],
    ]);
    expect(reg.list()).toEqual([]);
  });

  it('scales its staleness window with the poll bound in force', () => {
    // A deployment (or a test) that holds polls for longer than the DEFAULT stale window must not
    // have its clients detached mid-hold — the window is derived from the bound, never fixed.
    const longPollMs = CHANNEL_ATTACH_STALE_MS * 2;
    const clock = fakeClock();
    const reg = new ChannelRegistry({ clock: clock.now, pollMs: longPollMs });
    expect(reg.staleAfterMs).toBeGreaterThan(longPollMs);
    reg.attach(attachInput());
    clock.advance(longPollMs);
    expect(reg.sweepStale()).toEqual([]);
    expect(new ChannelRegistry().staleAfterMs).toBe(3 * CHANNEL_POLL_MS);
  });
});
