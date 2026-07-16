import { describe, it, expect } from 'vitest';
import { resolveAccountRef } from './resolve.js';
import type { StoredAccount } from '@claude-control/switch-engine';

function acct(id: string, label: string): StoredAccount {
  return { id, label, quarantined: false, createdAtMs: 0, updatedAtMs: 0 };
}

const accounts = [acct('id-1', 'Work'), acct('id-2', 'Personal'), acct('id-3', 'work')];

describe('resolveAccountRef', () => {
  it('matches by exact id first', () => {
    const r = resolveAccountRef(accounts, 'id-2');
    expect(r.ok && r.account.label).toBe('Personal');
  });

  it('matches by exact label', () => {
    const r = resolveAccountRef(accounts, 'Personal');
    expect(r.ok && r.account.id).toBe('id-2');
  });

  it('prefers an exact-case label over a case-insensitive collision', () => {
    // 'Work' and 'work' both exist; exact case wins unambiguously.
    const r = resolveAccountRef(accounts, 'Work');
    expect(r.ok && r.account.id).toBe('id-1');
  });

  it('falls back to case-insensitive when there is a single such match', () => {
    const r = resolveAccountRef([acct('id-1', 'Work'), acct('id-2', 'Personal')], 'wOrK');
    expect(r.ok && r.account.id).toBe('id-1');
  });

  it('reports ambiguity rather than guessing', () => {
    const r = resolveAccountRef([acct('a', 'Dup'), acct('b', 'Dup')], 'Dup');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('ambiguous');
  });

  it('reports not-found', () => {
    const r = resolveAccountRef(accounts, 'nope');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('not_found');
  });
});
