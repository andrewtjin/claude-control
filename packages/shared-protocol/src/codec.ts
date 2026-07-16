// Encode/decode helpers for putting envelopes on and off the wire.
//
// Decoding NEVER throws: a bad frame from the network is an expected condition, not a
// crash. Callers get a discriminated result and decide how loudly to complain. Encoding
// validates too, so a programming error (constructing an invalid envelope) is caught here
// rather than shipped as garbage the peer will silently drop.

import { randomUUID } from 'node:crypto';
import { Envelope, type MessageType } from './messages.js';
import { PROTOCOL_VERSION } from './version.js';

/** A parse that cannot throw: either a validated envelope or a human-readable reason. */
export type DecodeResult = { ok: true; envelope: Envelope } | { ok: false; error: string };

/** Omit that distributes across the union so each variant keeps its own payload type. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An envelope minus the fields `stamp()` fills in — what a caller actually authors. */
export type EnvelopeDraft = DistributiveOmit<Envelope, 'v' | 'id' | 'ts'>;

/**
 * Stamp version, a fresh message id, and the current time onto a draft, producing a
 * complete envelope. Centralizing this keeps every sender consistent and makes ids and
 * timestamps impossible to forget.
 */
export function stamp(draft: EnvelopeDraft): Envelope {
  return { ...draft, v: PROTOCOL_VERSION, id: randomUUID(), ts: Date.now() };
}

/** Validate and serialize. Throws only on a caller bug (an invalid envelope). */
export function encode(envelope: Envelope): string {
  return JSON.stringify(Envelope.parse(envelope));
}

/** Parse and validate a raw wire string. Never throws; returns a result. */
export function decode(raw: string): DecodeResult {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `invalid JSON: ${(err as Error).message}` };
  }
  const parsed = Envelope.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, envelope: parsed.data };
}

/** Type guard narrowing a decoded envelope to a specific message type. */
export function isType<T extends MessageType>(
  envelope: Envelope,
  type: T,
): envelope is Extract<Envelope, { type: T }> {
  return envelope.type === type;
}
