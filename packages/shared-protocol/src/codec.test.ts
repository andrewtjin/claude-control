import { describe, it, expect } from 'vitest';
import { encode, decode, stamp, isType, type EnvelopeDraft } from './codec.js';
import { Envelope, isMessageType } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

// A representative draft used across the round-trip tests.
const switchCommand: EnvelopeDraft = {
  daemonId: 'daemon-1',
  discordUserId: 'user-1',
  type: 'switch.command',
  payload: {
    requestId: 'req-1',
    targetAccountId: 'acct-2',
    reason: 'near_cap',
    idempotencyKey: 'idem-1',
  },
};

describe('stamp', () => {
  it('fills version, a unique id, and a timestamp', () => {
    const a = stamp(switchCommand);
    const b = stamp(switchCommand);
    expect(a.v).toBe(PROTOCOL_VERSION);
    expect(typeof a.ts).toBe('number');
    expect(a.id).not.toBe(b.id); // fresh uuid each time
    // A stamped draft is a valid envelope.
    expect(Envelope.safeParse(a).success).toBe(true);
  });
});

describe('encode/decode round-trip', () => {
  it('preserves a valid envelope', () => {
    const env = stamp(switchCommand);
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toEqual(env);
  });

  it('applies schema defaults on decode', () => {
    // `reason` defaults to 'manual'; omit it and confirm the default lands.
    const raw = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 'm1',
      ts: 1,
      daemonId: 'd1',
      type: 'switch.command',
      payload: { requestId: 'r1', targetAccountId: 'a1', idempotencyKey: 'k1' },
    });
    const result = decode(raw);
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'switch.command')) {
      expect(result.envelope.payload.reason).toBe('manual');
    }
  });
});

describe('settings.snapshot', () => {
  it('round-trips a settings report', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'settings.snapshot',
      payload: {
        startedAtMs: 1_700_000_000_000,
        settings: [
          { name: 'auto-switch', value: 'on', source: 'flag' },
          { name: 'switch trigger', value: '94% used', source: 'default', detail: 'CCTL_...' },
        ],
      },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.envelope).toEqual(env);
  });

  it('rejects a source outside default/env/flag', () => {
    const raw = JSON.stringify({
      v: PROTOCOL_VERSION,
      id: 'x',
      ts: 0,
      daemonId: 'd',
      type: 'settings.snapshot',
      payload: { startedAtMs: 0, settings: [{ name: 'n', value: 'v', source: 'magic' }] },
    });
    expect(decode(raw).ok).toBe(false);
  });
});

describe('decode never throws', () => {
  it('rejects non-JSON with a reason', () => {
    const result = decode('not json{');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('invalid JSON');
  });

  it('rejects an unknown message type', () => {
    const raw = JSON.stringify({ v: 1, id: 'x', ts: 0, daemonId: 'd', type: 'nope', payload: {} });
    expect(decode(raw).ok).toBe(false);
  });

  it('rejects a wrong-shaped payload', () => {
    const raw = JSON.stringify({
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'd',
      type: 'switch.command',
      payload: { targetAccountId: 'a1' }, // missing requestId + idempotencyKey
    });
    const result = decode(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/requestId|idempotencyKey/);
  });

  it('rejects a missing routing field', () => {
    const raw = JSON.stringify({ v: 1, id: 'x', ts: 0, type: 'ping', payload: {} }); // no daemonId
    expect(decode(raw).ok).toBe(false);
  });
});

describe('encode validates its input', () => {
  it('throws on a structurally invalid envelope', () => {
    // Force an invalid envelope past the type system to prove the runtime guard.
    const bad = { v: 1, id: 'x', ts: 0, daemonId: 'd', type: 'ping' } as unknown as Envelope;
    expect(() => encode(bad)).toThrow();
  });
});

describe('isMessageType', () => {
  it('recognizes known and unknown discriminants', () => {
    expect(isMessageType('usage.snapshot')).toBe(true);
    expect(isMessageType('switch.command')).toBe(true);
    expect(isMessageType('totally-made-up')).toBe(false);
  });
});
