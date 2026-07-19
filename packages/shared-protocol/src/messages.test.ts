import { describe, it, expect } from 'vitest';
import { decode, isType, stamp, encode } from './codec.js';
import { Envelope, isMessageType, type PayloadOf } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

// Schema-level tests for the hook/managed-session protocol additions (permissionMode, the widened
// hook.notification, session.stop). Codec mechanics live in codec.test.ts; this file
// proves the CONTRACT: new fields are optional (old peers' frames still parse), tolerant
// (unknown mode/type strings never reject a frame), and the new type is fully registered.

/** Wrap a payload in valid routing fields so tests only vary what they mean to test. */
function rawFrame(type: string, payload: unknown): string {
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    id: 'msg-1',
    ts: 1,
    daemonId: 'daemon-1',
    type,
    payload,
  });
}

describe('permission.request permissionMode', () => {
  const base = {
    requestId: 'req-1',
    sessionId: 'sess-1',
    tool: 'Bash',
    summary: 'run a command',
  };

  it('parses without permissionMode — frames from older daemons stay valid', () => {
    const result = decode(rawFrame('permission.request', base));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'permission.request')) {
      expect(result.envelope.payload.permissionMode ?? undefined).toBeUndefined();
    }
  });

  it('carries a known mode through a round-trip', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'permission.request',
      payload: { ...base, permissionMode: 'default' },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'permission.request')) {
      expect(result.envelope.payload.permissionMode).toBe('default');
    }
  });

  it('accepts an unknown future mode string — tolerance is the contract', () => {
    const result = decode(
      rawFrame('permission.request', { ...base, permissionMode: 'someFutureMode' }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects an empty-string mode — absent and empty must not be conflated', () => {
    const result = decode(rawFrame('permission.request', { ...base, permissionMode: '' }));
    expect(result.ok).toBe(false);
  });
});

describe('hook.notification widened fields', () => {
  const base = { event: 'notification', title: 'Waiting', body: 'Claude is waiting for input' };

  it('parses the legacy shape unchanged — widening must not orphan old daemons', () => {
    const result = decode(rawFrame('hook.notification', base));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'hook.notification')) {
      expect(result.envelope.payload.level).toBe('info'); // default still applies
      expect(result.envelope.payload.notificationType ?? undefined).toBeUndefined();
      expect(result.envelope.payload.lastAssistantMessage ?? undefined).toBeUndefined();
    }
  });

  it('carries notificationType and lastAssistantMessage together with stop events', () => {
    const payload: PayloadOf<'hook.notification'> = {
      event: 'stop',
      sessionId: 'sess-1',
      title: 'Done',
      body: 'Session finished',
      level: 'success',
      lastAssistantMessage: 'All tests pass.',
    };
    const env = stamp({ daemonId: 'daemon-1', type: 'hook.notification', payload });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'hook.notification')) {
      expect(result.envelope.payload.lastAssistantMessage).toBe('All tests pass.');
    }
  });

  it('carries cwd so the bot can tag which window a notification came from', () => {
    const result = decode(rawFrame('hook.notification', { ...base, cwd: 'C:\\repos\\proj' }));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'hook.notification')) {
      expect(result.envelope.payload.cwd).toBe('C:\\repos\\proj');
    }
  });

  it('accepts an unknown notificationType string — bot falls back, wire never rejects', () => {
    const result = decode(
      rawFrame('hook.notification', { ...base, notificationType: 'brand_new_kind' }),
    );
    expect(result.ok).toBe(true);
  });

  it('allows an empty lastAssistantMessage — a session can end having said nothing', () => {
    const result = decode(
      rawFrame('hook.notification', { ...base, event: 'stop', lastAssistantMessage: '' }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('session.output epoch (additive, N/N-1 tolerant)', () => {
  const base: PayloadOf<'session.output'> = {
    sessionId: 'sess-1',
    seq: 0,
    kind: 'stdout',
    text: 'hi',
    truncated: false,
  };

  it('parses without epoch — frames from pre-epoch daemons stay valid', () => {
    const result = decode(rawFrame('session.output', base));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.output')) {
      expect(result.envelope.payload.epoch ?? undefined).toBeUndefined();
    }
  });

  it('carries an epoch through a round-trip', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'session.output',
      payload: { ...base, epoch: 'run-abc' },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.output')) {
      expect(result.envelope.payload.epoch).toBe('run-abc');
    }
  });

  it('rejects an empty-string epoch — absent and empty must not be conflated', () => {
    const result = decode(rawFrame('session.output', { ...base, epoch: '' }));
    expect(result.ok).toBe(false);
  });
});

describe('session.stop', () => {
  it('is a registered message type', () => {
    expect(isMessageType('session.stop')).toBe(true);
  });

  it('round-trips a valid stop command', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      discordUserId: 'user-1',
      type: 'session.stop',
      payload: { sessionId: 'sess-1', idempotencyKey: 'idem-1' },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.stop')) {
      expect(result.envelope.payload.sessionId).toBe('sess-1');
      expect(result.envelope.payload.idempotencyKey).toBe('idem-1');
    }
  });

  it('rejects a stop without an idempotencyKey — every mutating command must dedupe', () => {
    const result = decode(rawFrame('session.stop', { sessionId: 'sess-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/idempotencyKey/);
  });

  it('rejects a stop without a sessionId — an untargeted stop is meaningless', () => {
    const result = decode(rawFrame('session.stop', { idempotencyKey: 'idem-1' }));
    expect(result.ok).toBe(false);
  });

  it('is part of the Envelope union, not just the schema map', () => {
    // Guards the two-places registration rule: a type present in messageSchemas but
    // missing from the discriminatedUnion would pass isMessageType yet fail every parse.
    const parsed = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      id: 'msg-1',
      ts: 1,
      daemonId: 'daemon-1',
      type: 'session.stop',
      payload: { sessionId: 'sess-1', idempotencyKey: 'idem-1' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('permission.lapsed', () => {
  it('is a registered message type', () => {
    expect(isMessageType('permission.lapsed')).toBe(true);
  });

  it('round-trips for each reason', () => {
    for (const reason of ['local', 'expired', 'shutdown'] as const) {
      const env = stamp({
        daemonId: 'daemon-1',
        type: 'permission.lapsed',
        payload: { requestId: 'req-1', reason },
      });
      const result = decode(encode(env));
      expect(result.ok).toBe(true);
      if (result.ok && isType(result.envelope, 'permission.lapsed')) {
        expect(result.envelope.payload).toEqual({ requestId: 'req-1', reason });
      }
    }
  });

  it('rejects an unknown reason — the enum is closed, unlike permissionMode/notificationType', () => {
    const result = decode(rawFrame('permission.lapsed', { requestId: 'req-1', reason: 'other' }));
    expect(result.ok).toBe(false);
  });

  it('rejects a lapse without a requestId — nothing to correlate the edit against', () => {
    const result = decode(rawFrame('permission.lapsed', { reason: 'expired' }));
    expect(result.ok).toBe(false);
  });

  it('is part of the Envelope union, not just the schema map', () => {
    const parsed = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      id: 'msg-1',
      ts: 1,
      daemonId: 'daemon-1',
      type: 'permission.lapsed',
      payload: { requestId: 'req-1', reason: 'local' },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('session.prune / session.prune.result', () => {
  it('both are registered message types', () => {
    expect(isMessageType('session.prune')).toBe(true);
    expect(isMessageType('session.prune.result')).toBe(true);
  });

  it('round-trips a prune command', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      discordUserId: 'user-1',
      type: 'session.prune',
      payload: { requestId: 'req-1', idempotencyKey: 'idem-1' },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.prune')) {
      expect(result.envelope.payload.requestId).toBe('req-1');
      expect(result.envelope.payload.idempotencyKey).toBe('idem-1');
    }
  });

  it('rejects a prune without an idempotencyKey — every mutating command must dedupe', () => {
    const result = decode(rawFrame('session.prune', { requestId: 'req-1' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/idempotencyKey/);
  });

  it('round-trips a result carrying the pruned ids', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'session.prune.result',
      payload: { requestId: 'req-1', ok: true, prunedSessionIds: ['sess-1', 'sess-2'] },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.prune.result')) {
      expect(result.envelope.payload.prunedSessionIds).toEqual(['sess-1', 'sess-2']);
    }
  });

  it('a failed result carries an error and no pruned ids', () => {
    const result = decode(
      rawFrame('session.prune.result', {
        requestId: 'req-1',
        ok: false,
        prunedSessionIds: [],
        error: 'registry unreadable',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.prune.result')) {
      expect(result.envelope.payload.ok).toBe(false);
      expect(result.envelope.payload.error).toBe('registry unreadable');
    }
  });

  it('both are part of the Envelope union, not just the schema map', () => {
    const prune = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      id: 'msg-1',
      ts: 1,
      daemonId: 'daemon-1',
      type: 'session.prune',
      payload: { requestId: 'req-1', idempotencyKey: 'idem-1' },
    });
    expect(prune.success).toBe(true);
    const pruneResult = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      id: 'msg-2',
      ts: 1,
      daemonId: 'daemon-1',
      type: 'session.prune.result',
      payload: { requestId: 'req-1', ok: true, prunedSessionIds: [] },
    });
    expect(pruneResult.success).toBe(true);
  });
});
