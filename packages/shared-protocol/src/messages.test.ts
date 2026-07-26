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
    // Deliberately WITHOUT remainingSessionIds: a result from a daemon predating that field
    // must still decode (the field is additive, never required).
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'session.prune.result',
      payload: { requestId: 'req-1', ok: true, prunedSessionIds: ['sess-1', 'sess-2'] },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.prune.result')) {
      expect(result.envelope.payload.prunedSessionIds).toEqual(['sess-1', 'sess-2']);
      expect(result.envelope.payload.remainingSessionIds ?? undefined).toBeUndefined();
    }
  });

  it('round-trips the post-prune remaining view when the daemon reports one', () => {
    const env = stamp({
      daemonId: 'daemon-1',
      type: 'session.prune.result',
      payload: {
        requestId: 'req-1',
        ok: true,
        prunedSessionIds: ['sess-1'],
        remainingSessionIds: ['sess-2', 'sess-3'],
      },
    });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'session.prune.result')) {
      expect(result.envelope.payload.remainingSessionIds).toEqual(['sess-2', 'sess-3']);
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

describe('question round-trip trio', () => {
  const questions = [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [{ label: 'crimson', description: 'A deep, rich red.' }, { label: 'teal' }],
    },
  ];

  it('question.request parses with defaults — multiSelect absent means false', () => {
    const result = decode(
      rawFrame('question.request', { requestId: 'req-1', sessionId: 'sess-1', questions }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'question.request')) {
      expect(result.envelope.payload.questions[0]?.multiSelect).toBe(false);
      expect(result.envelope.payload.questions[0]?.options).toHaveLength(2);
    }
  });

  it('question.request rejects an empty questions array — an unanswerable card is a bug', () => {
    const result = decode(
      rawFrame('question.request', { requestId: 'req-1', sessionId: 'sess-1', questions: [] }),
    );
    expect(result.ok).toBe(false);
  });

  it('question.request tolerates more than 4 questions — the bot clamps, the wire never rejects', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      question: `Q${i}?`,
      options: [{ label: 'a' }, { label: 'b' }],
    }));
    const result = decode(
      rawFrame('question.request', { requestId: 'req-1', sessionId: 'sess-1', questions: many }),
    );
    expect(result.ok).toBe(true);
  });

  it('question.response carries selected labels and defaults selected to empty for other-only answers', () => {
    const result = decode(
      rawFrame('question.response', {
        requestId: 'req-1',
        answers: [
          { question: 'Which color do you prefer?', selected: ['teal'] },
          { question: 'Anything else?', otherText: 'a custom reply' },
        ],
        idempotencyKey: 'idem-1',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'question.response')) {
      expect(result.envelope.payload.answers[0]?.selected).toEqual(['teal']);
      expect(result.envelope.payload.answers[1]?.selected).toEqual([]);
      expect(result.envelope.payload.answers[1]?.otherText).toBe('a custom reply');
    }
  });

  it('question.response rejects an empty answers array', () => {
    const result = decode(
      rawFrame('question.response', { requestId: 'req-1', answers: [], idempotencyKey: 'i-1' }),
    );
    expect(result.ok).toBe(false);
  });

  it('question.lapsed carries the same reason vocabulary as permission.lapsed', () => {
    for (const reason of ['local', 'expired', 'shutdown'] as const) {
      const result = decode(rawFrame('question.lapsed', { requestId: 'req-1', reason }));
      expect(result.ok).toBe(true);
    }
    expect(decode(rawFrame('question.lapsed', { requestId: 'req-1', reason: 'nope' })).ok).toBe(
      false,
    );
  });

  it('all three are registered in both the schema map and the Envelope union', () => {
    for (const type of ['question.request', 'question.response', 'question.lapsed']) {
      expect(isMessageType(type)).toBe(true);
    }
    const parsed = Envelope.safeParse({
      v: PROTOCOL_VERSION,
      id: 'msg-1',
      ts: 1,
      daemonId: 'daemon-1',
      type: 'question.request',
      payload: { requestId: 'req-1', sessionId: 'sess-1', questions },
    });
    expect(parsed.success).toBe(true);
  });
});

describe('pair.claim hostLabel bound', () => {
  const base = { pairingCode: 'ABCDEFGH' };

  it('accepts a normal short hostLabel', () => {
    const result = decode(rawFrame('pair.claim', { ...base, hostLabel: 'my-laptop' }));
    expect(result.ok).toBe(true);
  });

  it('accepts a hostLabel at the 256-char bound', () => {
    const result = decode(rawFrame('pair.claim', { ...base, hostLabel: 'h'.repeat(256) }));
    expect(result.ok).toBe(true);
  });

  it('rejects a hostLabel past the bound — the bot persists it verbatim, so it must be capped', () => {
    // The label is written into the shared bindings.json and that whole file is rewritten on
    // every pairing; an unbounded label would let one claimer bloat every other user's write.
    const result = decode(rawFrame('pair.claim', { ...base, hostLabel: 'h'.repeat(257) }));
    expect(result.ok).toBe(false);
  });
});

describe('usage.snapshot carries no monetary data', () => {
  const account = {
    accountId: 'acct-1',
    label: 'Work',
    active: true,
    source: 'live' as const,
    fetchedAtMs: 1,
    limits: [],
  };

  it('strips a spend block off an account rather than relaying it', () => {
    // The usage endpoint returns per-account credit spend, and the daemon deliberately does not
    // carry it: this envelope is relayed in cleartext through a host the user does not own (see
    // docs/THREAT_MODEL.md, "In-transit visibility"), so dollar amounts must not cross it while
    // nothing renders them. The schema is the enforcement point — a sender that starts emitting
    // the field (a rolled-back daemon, a future edit) has it dropped here, not forwarded.
    const result = decode(
      rawFrame('usage.snapshot', {
        accounts: [
          {
            ...account,
            spend: {
              used: { amountMinor: 1234, currency: 'USD', exponent: 2 },
              percent: 12,
              enabled: true,
              canPurchaseCredits: true,
            },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'usage.snapshot')) {
      const decoded = result.envelope.payload.accounts[0];
      expect(decoded && 'spend' in decoded).toBe(false);
      expect(JSON.stringify(result.envelope)).not.toContain('1234');
    }
  });

  it('accepts an account with no monetary fields at all', () => {
    const payload: PayloadOf<'usage.snapshot'> = { accounts: [account] };
    const env = stamp({ daemonId: 'daemon-1', type: 'usage.snapshot', payload });
    const result = decode(encode(env));
    expect(result.ok).toBe(true);
  });
});

describe('stats.snapshot', () => {
  const totals = { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns: 5 };
  const payload = {
    windowStartMs: 0,
    windowEndMs: 604_800_000,
    overall: totals,
    byAccount: [{ accountId: 'acct-a', label: 'main', totals }],
    byModel: [{ label: 'claude-opus-5', totals }],
    byDay: [{ label: '2026-07-25', totals }],
    coverage: {
      filesScanned: 42,
      filesSkippedByMtime: 400,
      filesUnreadable: 1,
      dirsUnreadable: 1,
      malformedLines: 2,
      duplicateTurns: 3,
    },
  };

  it('is a registered message type', () => {
    expect(isMessageType('stats.snapshot')).toBe(true);
  });

  it('round-trips a full snapshot', () => {
    const result = decode(encode(stamp({ daemonId: 'daemon-1', type: 'stats.snapshot', payload })));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'stats.snapshot')) {
      expect(result.envelope.payload).toEqual(payload);
    }
  });

  it('carries the unattributed bucket as a null accountId rather than dropping the row', () => {
    const result = decode(
      rawFrame('stats.snapshot', {
        ...payload,
        byAccount: [{ accountId: null, label: 'unattributed', totals }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'stats.snapshot')) {
      expect(result.envelope.payload.byAccount[0]?.accountId ?? null).toBeNull();
      expect(result.envelope.payload.byAccount[0]?.label).toBe('unattributed');
    }
  });

  it('rejects a frame missing its coverage, so a total can never arrive uncontextualized', () => {
    const { coverage: _coverage, ...withoutCoverage } = payload;
    expect(decode(rawFrame('stats.snapshot', withoutCoverage)).ok).toBe(false);
  });

  it('rejects negative token counts', () => {
    expect(
      decode(rawFrame('stats.snapshot', { ...payload, overall: { ...totals, output: -1 } })).ok,
    ).toBe(false);
  });
});

describe('usage.snapshot pacing inputs (additive, N/N-1 tolerant)', () => {
  const account = {
    accountId: 'acct-1',
    label: 'Work',
    active: true,
    source: 'live',
    fetchedAtMs: 1,
    limits: [{ kind: 'weekly_all', percent: 40 }],
  };

  it('parses without them — frames from daemons predating the fields stay valid', () => {
    const result = decode(rawFrame('usage.snapshot', { accounts: [account] }));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'usage.snapshot')) {
      expect(result.envelope.payload.burnUnitsPerDay ?? undefined).toBeUndefined();
      expect(result.envelope.payload.accounts[0]?.predictedResetAt ?? undefined).toBeUndefined();
    }
  });

  it('carries a predicted reset and a fractional burn rate through a round-trip', () => {
    const result = decode(
      rawFrame('usage.snapshot', {
        accounts: [{ ...account, predictedResetAt: 1_800_000_000_000 }],
        burnUnitsPerDay: 2.75,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'usage.snapshot')) {
      expect(result.envelope.payload.accounts[0]?.predictedResetAt).toBe(1_800_000_000_000);
      expect(result.envelope.payload.burnUnitsPerDay).toBe(2.75);
    }
  });

  it('a measured zero survives — it is a verdict ("idle"), not a missing value', () => {
    const result = decode(rawFrame('usage.snapshot', { accounts: [account], burnUnitsPerDay: 0 }));
    expect(result.ok).toBe(true);
    if (result.ok && isType(result.envelope, 'usage.snapshot')) {
      expect(result.envelope.payload.burnUnitsPerDay).toBe(0);
    }
  });

  it('refuses a fractional predicted reset and a non-finite burn rate at encode time', () => {
    // encode() validates BEFORE serializing, so a sender whose value is looser than the schema
    // throws here rather than shipping a frame the peer will drop. Both shapes are the ones a
    // careless producer actually reaches: a rate is fractional by nature and a reset is not.
    const frame = (payload: PayloadOf<'usage.snapshot'>) =>
      stamp({ daemonId: 'daemon-1', type: 'usage.snapshot', payload });
    expect(() =>
      encode(frame({ accounts: [{ ...account, predictedResetAt: 1.5 }] } as never)),
    ).toThrow();
    expect(() =>
      encode(frame({ accounts: [account], burnUnitsPerDay: Infinity } as never)),
    ).toThrow();
    expect(() => encode(frame({ accounts: [account], burnUnitsPerDay: -1 } as never))).toThrow();
  });
});
