// Every lifecycle rule of the pending-reauth map, proven without a daemon: one-shot take,
// TTL, same-account replacement, restore-after-local-failure, FIFO bound, sweep.

import { describe, it, expect } from 'vitest';
import { PendingReauths, type PendingReauth } from './reauthFlow.js';

const NOW = 1_000_000;

function entry(accountId: string, expiresAtMs = NOW + 60_000): PendingReauth {
  return {
    accountId,
    label: accountId,
    verifier: `ver-${accountId}`,
    state: `st-${accountId}`,
    url: `https://claude.ai/oauth/authorize?state=st-${accountId}`,
    expiresAtMs,
  };
}

describe('PendingReauths', () => {
  it('takes a live entry once, and never again', () => {
    const pending = new PendingReauths();
    pending.start('req-1', entry('acct-1'));

    const first = pending.take('req-1', NOW);
    expect(first.kind).toBe('ok');
    if (first.kind === 'ok') expect(first.entry.verifier).toBe('ver-acct-1');
    // Single-use daemon-side, independent of any client dedupe: a racing second submit must not
    // reach a second exchange of the same authorization code.
    expect(pending.take('req-1', NOW).kind).toBe('not_found');
    expect(pending.size()).toBe(0);
  });

  it('reports an unknown requestId as not_found', () => {
    expect(new PendingReauths().take('nope', NOW).kind).toBe('not_found');
  });

  it('reports an entry past its expiry as expired, and drops it', () => {
    const pending = new PendingReauths();
    pending.start('req-1', entry('acct-1', NOW + 1000));

    expect(pending.take('req-1', NOW + 1000).kind).toBe('expired');
    expect(pending.size()).toBe(0);
  });

  it('replaces an outstanding link for the SAME account, deadening the old one', () => {
    // A second /reauth mints a new browser flow; leaving the first consumable would keep two
    // live verifiers for one account and let a stale link win a race.
    const pending = new PendingReauths();
    pending.start('req-1', entry('acct-1'));
    pending.start('req-2', entry('acct-1'));

    expect(pending.size()).toBe(1);
    expect(pending.take('req-1', NOW).kind).toBe('not_found');
    expect(pending.take('req-2', NOW).kind).toBe('ok');
  });

  it('leaves a DIFFERENT account’s flow alone', () => {
    const pending = new PendingReauths();
    pending.start('req-1', entry('acct-1'));
    pending.start('req-2', entry('acct-2'));

    expect(pending.size()).toBe(2);
    expect(pending.take('req-1', NOW).kind).toBe('ok');
    expect(pending.take('req-2', NOW).kind).toBe('ok');
  });

  it('restores a taken entry with its ORIGINAL expiry (a typo must not extend the link)', () => {
    const pending = new PendingReauths();
    const original = entry('acct-1', NOW + 1000);
    pending.start('req-1', original);

    const taken = pending.take('req-1', NOW);
    expect(taken.kind).toBe('ok');
    if (taken.kind === 'ok') pending.restore('req-1', taken.entry);

    // Usable again right away (the code was never spent)...
    expect(pending.take('req-1', NOW).kind).toBe('ok');
    // ...but the clock did not restart.
    pending.restore('req-1', original);
    expect(pending.take('req-1', NOW + 1000).kind).toBe('expired');
  });

  it('FIFO-evicts the oldest flow past its bound', () => {
    const pending = new PendingReauths(2);
    pending.start('req-1', entry('acct-1'));
    pending.start('req-2', entry('acct-2'));
    pending.start('req-3', entry('acct-3'));

    expect(pending.size()).toBe(2);
    expect(pending.take('req-1', NOW).kind).toBe('not_found');
    expect(pending.take('req-3', NOW).kind).toBe('ok');
  });

  it('sweeps only the expired flows', () => {
    const pending = new PendingReauths();
    pending.start('req-1', entry('acct-1', NOW + 500));
    pending.start('req-2', entry('acct-2', NOW + 5000));

    pending.sweep(NOW + 1000);

    expect(pending.size()).toBe(1);
    expect(pending.take('req-1', NOW + 1000).kind).toBe('not_found');
    expect(pending.take('req-2', NOW + 1000).kind).toBe('ok');
  });
});
