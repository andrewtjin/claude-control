// The per-account decision behind the usage refresh, on its own. The route and the daemon's wiring
// are covered in hookReceiver.test.ts and daemon.pollCycle.test.ts.

import { describe, it, expect } from 'vitest';
import type { PollReadiness } from './usagePoller.js';
import { planUsageRepoll } from './usageRepoll.js';

const FLEET = ['due-1', 'floor-1', 'backoff-1'];

/** Readiness for the fleet above: one due, one held by the floor, one by a 429 backoff. */
function readiness(id: string): PollReadiness {
  if (id === 'floor-1') return { due: false, reason: 'floor', dueAtMs: 1_000 };
  if (id === 'backoff-1') return { due: false, reason: 'backoff', dueAtMs: 9_000 };
  return { due: true };
}

describe('planUsageRepoll', () => {
  it('answers every stored account, in fleet order, when no ids are named', () => {
    expect(planUsageRepoll(undefined, FLEET, readiness)).toEqual([
      { id: 'due-1', outcome: 'scheduled' },
      { id: 'floor-1', outcome: 'skipped', reason: 'floor', dueAtMs: 1_000 },
      { id: 'backoff-1', outcome: 'skipped', reason: 'backoff', dueAtMs: 9_000 },
    ]);
  });

  it('answers the named ids in request order, and an unknown one as unknown', () => {
    expect(planUsageRepoll(['backoff-1', 'ghost', 'due-1'], FLEET, readiness)).toEqual([
      { id: 'backoff-1', outcome: 'skipped', reason: 'backoff', dueAtMs: 9_000 },
      { id: 'ghost', outcome: 'skipped', reason: 'unknown' },
      { id: 'due-1', outcome: 'scheduled' },
    ]);
  });

  it('never asks the poller about an id no stored account has', () => {
    const asked: string[] = [];
    planUsageRepoll(['ghost'], FLEET, (id) => {
      asked.push(id);
      return { due: true };
    });
    expect(asked).toEqual([]);
  });

  it('answers a repeated id once', () => {
    expect(planUsageRepoll(['due-1', 'due-1'], FLEET, readiness)).toEqual([
      { id: 'due-1', outcome: 'scheduled' },
    ]);
  });

  it('while poll cycles are failing, answers a due account as such and a held one as held', () => {
    expect(planUsageRepoll(undefined, FLEET, readiness, { cyclesFailing: true })).toEqual([
      { id: 'due-1', outcome: 'skipped', reason: 'cycle_failed' },
      { id: 'floor-1', outcome: 'skipped', reason: 'floor', dueAtMs: 1_000 },
      { id: 'backoff-1', outcome: 'skipped', reason: 'backoff', dueAtMs: 9_000 },
    ]);
  });

  it('answers an empty list with nothing, not with every account', () => {
    expect(planUsageRepoll([], FLEET, readiness)).toEqual([]);
  });
});
