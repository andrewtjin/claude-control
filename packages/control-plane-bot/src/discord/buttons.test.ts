import { describe, it, expect } from 'vitest';
import {
  buttonIdempotencyKey,
  CONFIRM_TTL_MS,
  decodeButton,
  encodeButton,
  isDestructive,
  permissionButtons,
  resolveTap,
  sessionCardButtons,
  type ParsedButton,
} from './buttons.js';

describe('encode/decode customId', () => {
  it('round-trips every field, including an id that contains the delimiter', () => {
    const p: ParsedButton = {
      action: 'deny',
      phase: 'confirm',
      scope: 'session',
      ts: 123456,
      id: 'req:with:colons',
    };
    const round = decodeButton(encodeButton(p));
    expect(round).toEqual(p);
  });

  it('floors a fractional timestamp so the wire value is an integer', () => {
    const encoded = encodeButton({
      action: 'switch',
      phase: 'confirm',
      scope: 'na',
      ts: 10.9,
      id: 'a',
    });
    expect(decodeButton(encoded)?.ts).toBe(10);
  });

  it('rejects foreign, malformed, and empty-id customIds as null', () => {
    expect(decodeButton('approve:req-1')).toBeNull(); // legacy 2-field form, no prefix
    expect(decodeButton('cc:teleport:go:once:0:x')).toBeNull(); // unknown action
    expect(decodeButton('cc:deny:go:everywhere:0:x')).toBeNull(); // unknown scope
    expect(decodeButton('cc:deny:go:once:notanumber:x')).toBeNull(); // bad ts
    expect(decodeButton('cc:deny:go:once:0:')).toBeNull(); // empty id
    expect(decodeButton('random string')).toBeNull();
  });
});

describe('isDestructive', () => {
  it('flags switch and stop always, deny only at session scope', () => {
    expect(isDestructive('switch', 'na')).toBe(true);
    expect(isDestructive('stop', 'na')).toBe(true);
    expect(isDestructive('deny', 'session')).toBe(true);
    expect(isDestructive('deny', 'once')).toBe(false);
    expect(isDestructive('approve', 'once')).toBe(false);
  });
});

describe('resolveTap — two-tap state machine', () => {
  const NOW = 1_000_000;

  it('a `go` button executes immediately (safe, single tap)', () => {
    const id = encodeButton({ action: 'approve', phase: 'go', scope: 'once', ts: 0, id: 'req-1' });
    expect(resolveTap(id, NOW)).toEqual({
      kind: 'execute',
      action: 'approve',
      scope: 'once',
      id: 'req-1',
    });
  });

  it('the first tap of an armed destructive button swaps in Confirm/Cancel, executes nothing', () => {
    const id = encodeButton({ action: 'switch', phase: 'arm', scope: 'na', ts: 0, id: 'acct-2' });
    const out = resolveTap(id, NOW);
    expect(out.kind).toBe('confirm');
    if (out.kind !== 'confirm') throw new Error('unreachable');
    const [confirm, cancel] = out.rows[0]!;
    // Confirm carries the arm time; Cancel does not.
    const confirmParsed = decodeButton(confirm!.customId)!;
    expect(confirmParsed).toMatchObject({
      action: 'switch',
      phase: 'confirm',
      scope: 'na',
      ts: NOW,
      id: 'acct-2',
    });
    expect(decodeButton(cancel!.customId)).toMatchObject({ phase: 'cancel', id: 'acct-2' });
    expect(confirm!.label).toBe('Confirm');
    expect(cancel!.label).toBe('Cancel');
  });

  it('a Confirm tap within the TTL executes', () => {
    const armMs = NOW;
    const id = encodeButton({
      action: 'stop',
      phase: 'confirm',
      scope: 'na',
      ts: armMs,
      id: 'sess-1',
    });
    const out = resolveTap(id, armMs + CONFIRM_TTL_MS); // exactly at the boundary still fires
    expect(out).toEqual({ kind: 'execute', action: 'stop', scope: 'na', id: 'sess-1' });
  });

  it('a Confirm tap past the TTL re-arms instead of firing (no stale destructive action)', () => {
    const armMs = NOW;
    const id = encodeButton({
      action: 'stop',
      phase: 'confirm',
      scope: 'na',
      ts: armMs,
      id: 'sess-1',
    });
    const out = resolveTap(id, armMs + CONFIRM_TTL_MS + 1);
    expect(out.kind).toBe('restore');
    if (out.kind !== 'restore') throw new Error('unreachable');
    expect(decodeButton(out.rows[0]![0]!.customId)).toMatchObject({
      phase: 'arm',
      action: 'stop',
      id: 'sess-1',
    });
    // The note names the window so the reset teaches the mechanic — a silent revert reads
    // as a bug. The gateway surfaces it as an ephemeral follow-up.
    expect(out.note).toBe('Expired; confirm within 30s. Tap again to retry.');
  });

  it('a Cancel on a permission-card deny restores the FULL Approve/Deny/Deny (session) row', () => {
    // Restoring only the armed deny button would lose Approve/Deny for good.
    const id = encodeButton({
      action: 'deny',
      phase: 'cancel',
      scope: 'session',
      ts: 0,
      id: 'req-9',
    });
    const out = resolveTap(id, NOW);
    expect(out.kind).toBe('restore');
    if (out.kind !== 'restore') throw new Error('unreachable');
    expect(out.rows).toEqual(permissionButtons({ requestId: 'req-9' }));
    expect(out.rows[0]!.map((b) => b.label)).toEqual(['Approve', 'Deny', 'Deny (session)']);
  });

  it('a stale Confirm on a permission-card deny also re-arms to the full row', () => {
    const id = encodeButton({
      action: 'deny',
      phase: 'confirm',
      scope: 'session',
      ts: NOW,
      id: 'req-9',
    });
    const out = resolveTap(id, NOW + CONFIRM_TTL_MS + 1);
    expect(out.kind).toBe('restore');
    if (out.kind !== 'restore') throw new Error('unreachable');
    expect(out.rows).toEqual(permissionButtons({ requestId: 'req-9' }));
  });

  it('a Cancel on a session-card Stop restores the single armed Stop (its whole row)', () => {
    const id = encodeButton({ action: 'stop', phase: 'cancel', scope: 'na', ts: 0, id: 'sess-1' });
    const out = resolveTap(id, NOW);
    expect(out.kind).toBe('restore');
    if (out.kind !== 'restore') throw new Error('unreachable');
    expect(out.rows).toEqual(sessionCardButtons({ sessionId: 'sess-1', stoppable: true }));
  });

  it('a Cancel on a switch button falls back to re-arming just that button', () => {
    const id = encodeButton({
      action: 'switch',
      phase: 'cancel',
      scope: 'na',
      ts: 0,
      id: 'acct-2',
    });
    const out = resolveTap(id, NOW);
    expect(out.kind).toBe('restore');
    if (out.kind !== 'restore') throw new Error('unreachable');
    expect(out.rows).toHaveLength(1);
    expect(out.rows[0]).toHaveLength(1);
    expect(decodeButton(out.rows[0]![0]!.customId)).toMatchObject({
      phase: 'arm',
      action: 'switch',
      id: 'acct-2',
    });
  });

  it('ignores an unrecognized button', () => {
    expect(resolveTap('not-ours', NOW)).toMatchObject({ kind: 'ignore' });
  });
});

describe('permissionButtons', () => {
  // No mode parameter on purpose: a permission card only exists while the daemon holds the
  // hook response open for a remote decision, so the buttons are truthful in every mode.
  it('offers Approve / Deny / Deny(session)', () => {
    const rows = permissionButtons({ requestId: 'req-1' });
    expect(rows).toHaveLength(1);
    const labels = rows[0]!.map((b) => b.label);
    expect(labels).toEqual(['Approve', 'Deny', 'Deny (session)']);
    // Approve/Deny are single-tap `go`; the session deny is destructive and ships `arm`.
    expect(decodeButton(rows[0]![0]!.customId)).toMatchObject({
      action: 'approve',
      phase: 'go',
      scope: 'once',
    });
    expect(decodeButton(rows[0]![1]!.customId)).toMatchObject({
      action: 'deny',
      phase: 'go',
      scope: 'once',
    });
    expect(decodeButton(rows[0]![2]!.customId)).toMatchObject({
      action: 'deny',
      phase: 'arm',
      scope: 'session',
    });
  });
});

describe('sessionCardButtons — the live card Stop control', () => {
  it('ships an armed Stop that flows through the two-tap confirm to an execute', () => {
    const rows = sessionCardButtons({ sessionId: 'sess-1', stoppable: true });
    expect(rows).toHaveLength(1);
    const stop = rows[0]![0]!;
    expect(stop.label).toBe('Stop session');
    // Armed, carrying the sessionId, so a confirmed tap maps straight to handleStop(sessionId).
    expect(decodeButton(stop.customId)).toMatchObject({
      action: 'stop',
      phase: 'arm',
      id: 'sess-1',
    });
    // Tap 1: arm → Confirm/Cancel (executes nothing).
    const first = resolveTap(stop.customId, 1000);
    expect(first.kind).toBe('confirm');
    if (first.kind !== 'confirm') throw new Error('unreachable');
    // Tap 2 (Confirm within TTL): execute stop for that session.
    const confirmId = first.rows[0]![0]!.customId;
    expect(resolveTap(confirmId, 1000)).toEqual({
      kind: 'execute',
      action: 'stop',
      scope: 'na',
      id: 'sess-1',
    });
  });

  it('offers no button once the session is stopping or terminal', () => {
    expect(sessionCardButtons({ sessionId: 'sess-1', stoppable: false })).toEqual([]);
  });
});

describe('buttonIdempotencyKey', () => {
  it('is deterministic per logical action so a double-tap collapses to one key', () => {
    const a = buttonIdempotencyKey('user-1', { action: 'approve', scope: 'once', id: 'req-1' });
    const b = buttonIdempotencyKey('user-1', { action: 'approve', scope: 'once', id: 'req-1' });
    expect(a).toBe(b);
  });

  it('separates different users, actions, scopes, and targets', () => {
    const base = { action: 'deny', scope: 'session', id: 'req-1' } as const;
    const k = buttonIdempotencyKey('user-1', base);
    expect(k).not.toBe(buttonIdempotencyKey('user-2', base));
    expect(k).not.toBe(buttonIdempotencyKey('user-1', { ...base, action: 'approve' }));
    expect(k).not.toBe(buttonIdempotencyKey('user-1', { ...base, scope: 'once' }));
    expect(k).not.toBe(buttonIdempotencyKey('user-1', { ...base, id: 'req-2' }));
  });
});
