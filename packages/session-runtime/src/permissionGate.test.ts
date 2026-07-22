import { describe, it, expect } from 'vitest';
import { createPermissionGate } from './permissionGate.js';
import type { PermissionDecision } from './types.js';

/** Drain the microtask queue so a resolved gate promise's `.then` has run before assertions. */
async function tick(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Attach a recorder to a register() promise so a test can assert whether/what it resolved to
 *  WITHOUT awaiting it (awaiting a still-blocked request would hang the test). */
function watch(p: Promise<PermissionDecision>): { get: () => PermissionDecision | undefined } {
  let value: PermissionDecision | undefined;
  void p.then((d) => {
    value = d;
  });
  return { get: () => value };
}

describe('createPermissionGate', () => {
  it('blocks a registered request until it is resolved, then delivers the decision', async () => {
    const gate = createPermissionGate();
    const pending = watch(gate.register('r1'));
    await tick();
    // Still blocking — no timer, no auto-decision.
    expect(pending.get()).toBeUndefined();
    expect(gate.pending()).toEqual(['r1']);

    const decision: PermissionDecision = { behavior: 'allow', updatedInput: { cmd: 'ls' } };
    expect(gate.resolve('r1', decision)).toBe('resolved');
    await tick();
    expect(pending.get()).toEqual(decision);
    // Once resolved it is no longer pending.
    expect(gate.pending()).toEqual([]);
  });

  it('is single-resolve: a second decision on the same id is a no-op returning already_handled', async () => {
    const gate = createPermissionGate();
    const pending = watch(gate.register('r1'));
    expect(gate.resolve('r1', { behavior: 'allow' })).toBe('resolved');
    await tick();

    // The repeat neither changes the delivered decision nor re-applies.
    expect(gate.resolve('r1', { behavior: 'deny', message: 'too late' })).toBe('already_handled');
    await tick();
    expect(pending.get()).toEqual({ behavior: 'allow' });
  });

  it('returns unknown for an id with no pending request', () => {
    const gate = createPermissionGate();
    expect(gate.resolve('nope', { behavior: 'allow' })).toBe('unknown');
  });

  it('denyAll resolves every pending request as a fail-closed deny — no promise leaks', async () => {
    const gate = createPermissionGate();
    const a = watch(gate.register('a'));
    const b = watch(gate.register('b'));
    await tick();
    expect(a.get()).toBeUndefined();
    expect(b.get()).toBeUndefined();

    gate.denyAll('session ended');
    await tick();
    expect(a.get()).toEqual({ behavior: 'deny', message: 'session ended' });
    expect(b.get()).toEqual({ behavior: 'deny', message: 'session ended' });
    expect(gate.pending()).toEqual([]);
    // A request the teardown already denied is 'already_handled' on a late resolve — it WAS
    // handled (denied), so a straggler approval is a safe idempotent no-op, never re-applied.
    expect(gate.resolve('a', { behavior: 'allow' })).toBe('already_handled');
    // An id the gate never saw is still 'unknown'.
    expect(gate.resolve('never', { behavior: 'allow' })).toBe('unknown');
  });

  it('denyAll does not disturb an already-resolved request and is idempotent', async () => {
    const gate = createPermissionGate();
    const a = watch(gate.register('a'));
    gate.resolve('a', { behavior: 'allow', updatedInput: { x: 1 } });
    await tick();

    gate.denyAll('ended');
    gate.denyAll('ended again');
    await tick();
    // The prior allow decision stands — teardown never overwrites a settled request.
    expect(a.get()).toEqual({ behavior: 'allow', updatedInput: { x: 1 } });
  });

  it('re-registering a still-pending id returns the same blocking promise', async () => {
    const gate = createPermissionGate();
    const p1 = gate.register('r1');
    const p2 = gate.register('r1');
    expect(p2).toBe(p1);
    expect(gate.pending()).toEqual(['r1']);

    gate.resolve('r1', { behavior: 'allow' });
    await expect(p1).resolves.toEqual({ behavior: 'allow' });
    await expect(p2).resolves.toEqual({ behavior: 'allow' });
  });
});
