import { describe, it, expect, vi } from 'vitest';
import type { Envelope, EnvelopeDraft } from '@claude-control/shared-protocol';
import type { RelaySender, SendResult } from '../relay.js';
import { BindingStore } from '../bindings.js';
import { PairingService } from '../pairing.js';
import { DaemonStateCache } from './stateCache.js';
import {
  handlePair,
  handleUsage,
  handleTimeline,
  handleAccounts,
  handleSessions,
  handleSettings,
  handleStats,
  handleStatsScan,
  handleStatus,
  handleSwitch,
  handleRun,
  handleSay,
  handleApprove,
  handleDeny,
  handleQuestionAnswer,
  handleStop,
  handlePruneRequest,
  handlePruneConfirm,
  handleReauth,
  rejectThreadHereChannel,
  buildThreadHereResult,
  type CommandDeps,
  type ThreadHereChannelFacts,
  type ThreadHereRejection,
  type ThreadHereStatus,
} from './commands.js';
import { decodeButton } from './buttons.js';

/** A fake relay that never has network state — it records what it was asked to send and
 *  lets tests control whether "the daemon" is reachable, without any real socket. */
function createFakeRelay(options: { online: Record<string, string | undefined> }) {
  const sent: { discordUserId: string; daemonId: string; draft: EnvelopeDraft }[] = [];
  const relay: RelaySender = {
    sendToUser(discordUserId, build) {
      const daemonId = options.online[discordUserId];
      if (!daemonId) return { ok: false, error: 'no daemon is paired to this account' };
      sent.push({ discordUserId, daemonId, draft: build(daemonId) });
      return { ok: true, id: `sent-${sent.length}` } satisfies SendResult;
    },
    isOnline(discordUserId) {
      return options.online[discordUserId] !== undefined;
    },
  };
  return { relay, sent };
}

function makeDeps(relay: RelaySender): CommandDeps {
  return {
    relay,
    pairing: new PairingService({ bindings: new BindingStore() }),
    cache: new DaemonStateCache(),
  };
}

describe('handlePair', () => {
  it('issues a code scoped to the invoking user', () => {
    const bindings = new BindingStore();
    const pairing = new PairingService({ bindings });
    const spy = vi.spyOn(pairing, 'createCode');
    const deps: CommandDeps = {
      relay: createFakeRelay({ online: {} }).relay,
      pairing,
      cache: new DaemonStateCache(),
    };

    const result = handlePair(deps, 'user-a');
    expect(spy).toHaveBeenCalledWith('user-a');
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('Pairing code');
  });
});

describe('read commands (usage/accounts/sessions/status)', () => {
  it('handleUsage answers from the cache, not a live call', () => {
    const { relay } = createFakeRelay({ online: {} });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    expect(handleUsage(deps, 'user-a').kind).toBe('text'); // no data yet

    cache.record('user-a', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'usage.snapshot',
      payload: { accounts: [] },
    });
    expect(handleUsage(deps, 'user-a').kind).toBe('embed');
  });

  it('handleSettings answers from the cached settings.snapshot', () => {
    const { relay } = createFakeRelay({ online: {} });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    expect(handleSettings(deps, 'user-a').kind).toBe('text'); // no data yet

    cache.record('user-a', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'settings.snapshot',
      payload: {
        startedAtMs: 123,
        settings: [{ name: 'auto-switch', value: 'on', source: 'flag' }],
      },
    });
    expect(handleSettings(deps, 'user-a').kind).toBe('embed');
  });

  it('handleTimeline answers from the same cached snapshot as handleUsage', () => {
    const { relay } = createFakeRelay({ online: {} });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    expect(handleTimeline(deps, 'user-a').kind).toBe('text'); // no data yet

    cache.record('user-a', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'usage.snapshot',
      payload: {
        accounts: [
          {
            accountId: 'acct-1',
            label: 'Work',
            active: true,
            source: 'live',
            fetchedAtMs: 0,
            limits: [{ kind: 'weekly_all', percent: 30, isActive: true }],
          },
        ],
      },
    });
    expect(handleTimeline(deps, 'user-a').kind).toBe('embed');
  });

  it('handleAccounts reflects the same cached snapshot', () => {
    const { relay } = createFakeRelay({ online: {} });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    cache.record('user-a', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'usage.snapshot',
      payload: {
        accounts: [
          {
            accountId: 'a1',
            label: 'Work',
            active: true,
            source: 'live',
            fetchedAtMs: 0,
            limits: [],
          },
        ],
      },
    });
    const result = handleAccounts(deps, 'user-a');
    expect(result.kind).toBe('embed');
  });

  it('handleSessions lists cached session statuses', () => {
    const { relay } = createFakeRelay({ online: {} });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    cache.record('user-a', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'session.status',
      payload: { sessionId: 's1', state: 'running' },
    });
    const result = handleSessions(deps, 'user-a');
    expect(result.kind).toBe('embed');
  });

  it('handleStatus reflects RelaySender.isOnline for that user only', () => {
    const { relay } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    expect(handleStatus(deps, 'user-a').kind).toBe('text');
    const online = handleStatus(deps, 'user-a');
    const offline = handleStatus(deps, 'user-b');
    expect(online.kind === 'text' && online.text).toMatch(/online/i);
    expect(offline.kind === 'text' && offline.text).toMatch(/offline/i);
  });
});

describe('command-to-envelope mapping and ACL', () => {
  it("handleSwitch sends switch.command to exactly the invoking user's daemon", () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    const result = handleSwitch(deps, 'user-a', 'acct-2', 'req-1', 'idem-1');
    expect(result.kind).toBe('text');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.discordUserId).toBe('user-a');
    expect(sent[0]?.daemonId).toBe('daemon-1');
    expect(sent[0]?.draft).toMatchObject({
      daemonId: 'daemon-1',
      type: 'switch.command',
      payload: {
        requestId: 'req-1',
        targetAccountId: 'acct-2',
        reason: 'manual',
        idempotencyKey: 'idem-1',
      },
    });
  });

  it('handleSwitch fails cleanly when the caller has no reachable daemon', () => {
    const { relay, sent } = createFakeRelay({ online: {} });
    const deps = makeDeps(relay);
    const result = handleSwitch(deps, 'user-a', 'acct-2', 'req-1', 'idem-1');
    expect(result.kind).toBe('error');
    expect(sent).toHaveLength(0);
  });

  it("a user can never cause an envelope to target another user's daemon", () => {
    const { relay, sent } = createFakeRelay({
      online: { 'user-a': 'daemon-1', 'user-b': 'daemon-2' },
    });
    const deps = makeDeps(relay);
    handleSwitch(deps, 'user-a', 'acct-x', 'r1', 'k1');
    handleSwitch(deps, 'user-b', 'acct-x', 'r2', 'k2');
    expect(sent.find((s) => s.discordUserId === 'user-a')?.daemonId).toBe('daemon-1');
    expect(sent.find((s) => s.discordUserId === 'user-b')?.daemonId).toBe('daemon-2');
  });

  it('handleRun includes optional fields only when supplied', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    handleRun(deps, 'user-a', 'do the thing', 'req-1', 'idem-1');
    expect(sent[0]?.draft).toMatchObject({
      type: 'session.spawn',
      payload: { prompt: 'do the thing' },
    });
    expect(sent[0]?.draft.payload).not.toHaveProperty('cwd');
    expect(sent[0]?.draft.payload).not.toHaveProperty('resumeSessionId');

    handleRun(deps, 'user-a', 'resume it', 'req-2', 'idem-2', {
      cwd: '/repo',
      resumeSessionId: 's1',
    });
    expect(sent[1]?.draft.payload).toMatchObject({ cwd: '/repo', resumeSessionId: 's1' });
  });

  it('handleSay sends prompt.inject with the given session and text', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    handleSay(deps, 'user-a', 's1', 'hello', 'idem-1');
    expect(sent[0]?.draft).toMatchObject({
      type: 'prompt.inject',
      payload: { sessionId: 's1', text: 'hello', idempotencyKey: 'idem-1' },
    });
  });

  it('handleApprove and handleDeny send opposite decisions', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    handleApprove(deps, 'user-a', 'req-1', 'once', 'idem-1');
    handleDeny(deps, 'user-a', 'req-2', 'session', 'idem-2');
    expect(sent[0]?.draft).toMatchObject({
      type: 'permission.response',
      payload: { requestId: 'req-1', decision: 'allow', scope: 'once' },
    });
    expect(sent[1]?.draft).toMatchObject({
      type: 'permission.response',
      payload: { requestId: 'req-2', decision: 'deny', scope: 'session' },
    });
  });
});

describe('handleQuestionAnswer sends question.response', () => {
  const answers = [
    { question: 'Which color?', selected: ['Green'] },
    { question: 'Anything else?', selected: [], otherText: 'a custom reply' },
  ];

  it("emits a question.response to exactly the invoking user's daemon", () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    const result = handleQuestionAnswer(deps, 'user-a', {
      requestId: 'req-1',
      answers,
      idempotencyKey: 'qans:req-1',
    });
    expect(result.kind).toBe('text');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.daemonId).toBe('daemon-1');
    expect(sent[0]?.draft).toMatchObject({
      type: 'question.response',
      payload: { requestId: 'req-1', answers, idempotencyKey: 'qans:req-1' },
    });
  });

  it('fails cleanly (no frame) when the daemon is offline, so the card stays retryable', () => {
    const { relay, sent } = createFakeRelay({ online: {} });
    const deps = makeDeps(relay);
    const result = handleQuestionAnswer(deps, 'user-a', {
      requestId: 'req-1',
      answers,
      idempotencyKey: 'qans:req-1',
    });
    expect(result.kind).toBe('error');
    expect(sent).toHaveLength(0);
  });
});

describe('handleStop sends session.stop', () => {
  it('emits a session.stop frame to the invoking user’s daemon with the idempotency key', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    const result = handleStop(deps, 'user-a', 's1', 'idem-stop');
    expect(result.kind).toBe('text');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.draft).toMatchObject({
      type: 'session.stop',
      payload: { sessionId: 's1', idempotencyKey: 'idem-stop' },
    });
  });

  it('fails cleanly (no frame) when the caller has no reachable daemon', () => {
    const { relay, sent } = createFakeRelay({ online: {} });
    const deps = makeDeps(relay);
    const result = handleStop(deps, 'user-a', 's1', 'idem-stop');
    expect(result.kind).toBe('error');
    expect(sent).toHaveLength(0);
  });
});

describe('handlePruneRequest / handlePruneConfirm — the two-step prune', () => {
  it('the request sends NOTHING — it returns a preview with an armed Prune button', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const cache = new DaemonStateCache();
    const deps: CommandDeps = {
      relay,
      pairing: new PairingService({ bindings: new BindingStore() }),
      cache,
    };
    cache.record('user-a', {
      v: 1,
      id: 'x1',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'session.status',
      payload: { sessionId: 'orphan-1', state: 'orphaned' },
    });
    cache.record('user-a', {
      v: 1,
      id: 'x2',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'session.status',
      payload: { sessionId: 'live-1', state: 'running' },
    });

    const result = handlePruneRequest(deps, 'user-a', 'req-1');

    expect(sent).toHaveLength(0); // confirmation gate: no frame until the confirmed tap
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('1 dormant');
    expect(result.text).toContain('orphan-1'.slice(0, 8));
    expect(result.text).not.toContain('live-1'.slice(0, 8)); // live sessions are not on the block
    // The armed button carries THIS invocation's requestId so its dedupe key is per-invocation.
    const armed = result.components?.[0]?.[0];
    if (armed === undefined) throw new Error('unreachable');
    const parsed = decodeButton(armed.customId);
    expect(parsed).toMatchObject({ action: 'prune', phase: 'arm', id: 'req-1' });
  });

  it('the request fails cleanly when the daemon is offline (nothing to prune against)', () => {
    const { relay, sent } = createFakeRelay({ online: {} });
    const deps = makeDeps(relay);
    expect(handlePruneRequest(deps, 'user-a', 'req-1').kind).toBe('error');
    expect(sent).toHaveLength(0);
  });

  it('the confirm is the only step that sends session.prune, with requestId + idempotency key', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);

    const result = handlePruneConfirm(deps, 'user-a', 'req-1', 'idem-1');

    expect(result.kind).toBe('text');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.draft).toMatchObject({
      type: 'session.prune',
      payload: { requestId: 'req-1', idempotencyKey: 'idem-1' },
    });
  });
});

describe('handleReauth stays host-only and prints the REAL CLI verb', () => {
  it('points the user at `cctl accounts relogin` and never sends an envelope', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    const result = handleReauth(deps, 'user-a', 'acct-9');
    expect(result.kind).toBe('text');
    // The account it names, the in-place verb, and NOT the id-minting `add --fresh` (which
    // would break usage attribution) or the nonexistent `cctl login`.
    expect(result.kind === 'text' && result.text).toContain('acct-9');
    expect(result.kind === 'text' && result.text).toContain('cctl accounts relogin <label>');
    expect(result.kind === 'text' && result.text).not.toContain('--fresh');
    expect(result.kind === 'text' && result.text).not.toContain('cctl login');
    expect(sent).toHaveLength(0);
  });
});

describe('handleStats', () => {
  function statsEnvelope(discordUserId: string): Envelope {
    return {
      v: 1,
      id: 'stats-1',
      ts: 0,
      daemonId: 'daemon-1',
      discordUserId,
      type: 'stats.snapshot',
      payload: {
        windowStartMs: 0,
        windowEndMs: 7 * 86_400_000,
        overall: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns: 5 },
        byAccount: [
          {
            accountId: 'acct-a',
            label: 'main',
            totals: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns: 5 },
          },
        ],
        byModel: [],
        byDay: [],
        coverage: {
          filesScanned: 1,
          filesSkippedByMtime: 0,
          filesUnreadable: 0,
          dirsUnreadable: 0,
          malformedLines: 0,
          duplicateTurns: 0,
        },
      },
    };
  }

  it('says what to wait for when no snapshot has arrived yet', () => {
    const { relay } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const result = handleStats(makeDeps(relay), 'user-a');
    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.text).toMatch(/every 15 minutes/);
  });

  it('renders the last snapshot the daemon pushed, sending nothing to the daemon', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    deps.cache.record('user-a', statsEnvelope('user-a'));
    const result = handleStats(deps, 'user-a');
    expect(result.kind).toBe('embed');
    expect(result.kind === 'embed' && result.embed.toJSON().title).toBe('Token usage');
    // A cache read, never a round trip — /stats must answer with the daemon offline.
    expect(sent).toHaveLength(0);
  });

  it('never answers one user with another user daemon stats', () => {
    const { relay } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    deps.cache.record('user-a', statsEnvelope('user-a'));
    expect(handleStats(deps, 'user-b').kind).toBe('text');
  });

  it('still answers from cache when a cached snapshot exists, sending no request', () => {
    // Guards the fast path against the days-option work: /stats with no window must never
    // become a host scan.
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const deps = makeDeps(relay);
    deps.cache.record('user-a', statsEnvelope('user-a'));
    expect(handleStats(deps, 'user-a').kind).toBe('embed');
    expect(sent).toHaveLength(0);
  });
});

describe('handleStatsScan', () => {
  it('asks the daemon for the requested window', () => {
    const { relay, sent } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const result = handleStatsScan(makeDeps(relay), 'user-a', 30, 'req-1');

    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.text).toContain('30 days');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.draft.type).toBe('stats.request');
    expect(sent[0]?.draft.payload).toEqual({ requestId: 'req-1', days: 30 });
  });

  it('addresses only the invoking user daemon', () => {
    const { relay, sent } = createFakeRelay({
      online: { 'user-a': 'daemon-a', 'user-b': 'daemon-b' },
    });
    handleStatsScan(makeDeps(relay), 'user-b', 14, 'req-1');
    // The handler never names a daemon; the relay resolves it from the invoking user alone.
    expect(sent[0]?.daemonId).toBe('daemon-b');
  });

  it('reports an offline daemon as an error rather than pretending a scan started', () => {
    const { relay, sent } = createFakeRelay({ online: {} });
    const result = handleStatsScan(makeDeps(relay), 'user-a', 7, 'req-1');

    // The caller uses this to stop waiting immediately — a "scanning…" reply here would leave
    // the interaction spinning for the full timeout on a request that never left the bot.
    expect(result.kind).toBe('error');
    expect(sent).toHaveLength(0);
  });

  it('says "day" rather than "days" for a one-day window', () => {
    const { relay } = createFakeRelay({ online: { 'user-a': 'daemon-1' } });
    const result = handleStatsScan(makeDeps(relay), 'user-a', 1, 'req-1');
    expect(result.kind === 'text' && result.text).toContain('1 day');
    expect(result.kind === 'text' && result.text).not.toContain('1 days');
  });
});

// `/thread-here` — the decision tree and every reply string. This is the whole feature except for
// three thin live adapters in the gateway (read the invoking channel, probe it, inspect a pinned
// channel's health), which is exactly why the tree is shaped as pure functions over plain data: the
// guarantees the command makes are guarantees about ORDER and about what it says, and both are
// testable here without a Discord connection.
describe('rejectThreadHereChannel', () => {
  /** A channel that would be accepted; each test spoils exactly the one fact it is about. */
  function usableChannel(over: Partial<ThreadHereChannelFacts> = {}): ThreadHereChannelFacts {
    return {
      inGuild: true,
      botInGuild: true,
      channelResolved: true,
      isThread: false,
      isGuildText: true,
      missingPermissions: [],
      ...over,
    };
  }

  it('accepts an ordinary guild text channel the bot has every thread permission in', () => {
    expect(rejectThreadHereChannel(usableChannel())).toBeUndefined();
  });

  it.each([
    ['a DM invocation', { inGuild: false }, 'not-in-guild'],
    ['a server the bot was never added to', { botInGuild: false }, 'bot-not-in-guild'],
    ['an unreadable channel', { channelResolved: false }, 'channel-unresolved'],
    ['being run inside a thread', { isThread: true }, 'inside-thread'],
    ['a non-text channel', { isGuildText: false }, 'not-text-channel'],
    [
      'a channel the bot lacks permissions in',
      { missingPermissions: ['Manage Threads'] },
      'missing-permissions',
    ],
  ])('rejects %s', (_label, over, kind) => {
    expect(rejectThreadHereChannel(usableChannel(over))?.kind).toBe(kind);
  });

  it('names every missing permission in the rejection', () => {
    const rejection = rejectThreadHereChannel(
      usableChannel({ missingPermissions: ['Create Private Threads', 'Manage Threads'] }),
    );
    expect(rejection).toEqual({
      kind: 'missing-permissions',
      missing: ['Create Private Threads', 'Manage Threads'],
    });
  });

  // These overlap in practice — a DM has no permissions at all, an unresolved channel has no type —
  // so the ORDER is what decides whether the user is told something they can act on. Each row makes
  // several checks fail at once and asserts which one is reported.
  it.each([
    [
      'a DM outranks the permissions it structurally cannot have',
      { inGuild: false, botInGuild: false, missingPermissions: ['View Channel'] },
      'not-in-guild',
    ],
    [
      'a missing bot outranks the baseline permissions Discord reports for it',
      { botInGuild: false, missingPermissions: ['Manage Threads'] },
      'bot-not-in-guild',
    ],
    [
      'an unreadable channel outranks its unknown type',
      { channelResolved: false, isGuildText: false },
      'channel-unresolved',
    ],
    [
      'being inside a thread outranks the thread not being a text channel',
      { isThread: true, isGuildText: false },
      'inside-thread',
    ],
    [
      'the wrong channel type outranks the permissions on it',
      { isGuildText: false, missingPermissions: ['Manage Threads'] },
      'not-text-channel',
    ],
  ])('applies the checks in a fixed order: %s', (_label, over, kind) => {
    expect(rejectThreadHereChannel(usableChannel(over))?.kind).toBe(kind);
  });
});

describe('buildThreadHereResult — rejections', () => {
  /** Every rejection the command can produce, including the two the channel check cannot reach. */
  const ALL_REJECTIONS: ThreadHereRejection[] = [
    { kind: 'not-in-guild' },
    { kind: 'bot-not-in-guild' },
    { kind: 'channel-unresolved' },
    { kind: 'inside-thread' },
    { kind: 'not-text-channel' },
    { kind: 'missing-permissions', missing: ['Manage Threads'] },
    { kind: 'probe-failed', detail: 'Missing Permissions' },
    { kind: 'save-failed' },
  ];

  // The preflight's promise is that a refused pin leaves routing exactly as it was, and a user
  // cannot check that from the outside — so every refusal says it, in the same words.
  it.each(ALL_REJECTIONS.map((r) => [r.kind, r] as const))(
    '%s tells the user nothing was changed',
    (_kind, rejection) => {
      const result = buildThreadHereResult({ kind: 'rejected', rejection });
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.message).toContain('Nothing was changed.');
    },
  );

  it('points a DM invocation at the clear action rather than leaving it a dead end', () => {
    const result = buildThreadHereResult({ kind: 'rejected', rejection: { kind: 'not-in-guild' } });
    expect(result.kind === 'error' && result.message).toContain('/thread-here action:clear');
  });

  // Adding the bot is a different action from granting it permissions, and telling someone to
  // change permissions for a bot that is not in the server is advice that cannot work.
  it('distinguishes a server without the bot from a permissions problem', () => {
    const absent = buildThreadHereResult({
      kind: 'rejected',
      rejection: { kind: 'bot-not-in-guild' },
    });
    const perms = buildThreadHereResult({
      kind: 'rejected',
      rejection: { kind: 'missing-permissions', missing: ['Manage Threads'] },
    });
    expect(absent.kind === 'error' && absent.message).toContain('add the bot');
    expect(perms.kind === 'error' && perms.message).toContain('Manage Threads');
    expect(perms.kind === 'error' && perms.message).not.toContain('add the bot');
  });

  it('quotes what Discord actually refused when the live probe failed', () => {
    const result = buildThreadHereResult({
      kind: 'rejected',
      rejection: { kind: 'probe-failed', detail: 'Missing Permissions' },
    });
    expect(result.kind === 'error' && result.message).toContain('Missing Permissions');
  });

  // Never claim success on a write that did not reach the disk.
  it('reports a save failure as an error rather than a confirmation', () => {
    const result = buildThreadHereResult({ kind: 'rejected', rejection: { kind: 'save-failed' } });
    expect(result.kind).toBe('error');
    expect(result.kind === 'error' && result.message).toContain('could not save');
  });
});

describe('buildThreadHereResult — successes', () => {
  const CHANNEL = '333333333333333333';
  const OTHER_CHANNEL = '444444444444444444';

  it('confirms a fresh pin with the channel and the way back', () => {
    const result = buildThreadHereResult({ kind: 'pinned', channelId: CHANNEL });
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain(`<#${CHANNEL}>`);
    expect(result.text).toContain('/thread-here action:clear');
    // Sessions already running do not move, and silence about that reads as a bug.
    expect(result.text).toContain('Sessions already running');
    expect(result.text).not.toContain('instead of');
  });

  it('names the previous channel when a pin moves', () => {
    const result = buildThreadHereResult({
      kind: 'pinned',
      channelId: CHANNEL,
      previousChannelId: OTHER_CHANNEL,
    });
    expect(result.kind === 'text' && result.text).toContain(
      `<#${CHANNEL}> instead of <#${OTHER_CHANNEL}>`,
    );
  });

  // A re-pin is a no-op on disk but NOT a no-op in what it proves, so the reply says so.
  it('says a re-pin of the same channel was rechecked', () => {
    const result = buildThreadHereResult({ kind: 'already-pinned', channelId: CHANNEL });
    expect(result.kind === 'text' && result.text).toContain('rechecked');
    expect(result.kind === 'text' && result.text).toContain(`<#${CHANNEL}>`);
  });

  it('confirms a clear and names the deployment channel it overrides', () => {
    const result = buildThreadHereResult({ kind: 'cleared', overriddenChannelId: CHANNEL });
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    expect(result.text).toContain('your DMs');
    expect(result.text).toContain(`instead of <#${CHANNEL}>`);
  });

  it('confirms a clear with no channel to name when the user only had their own pin', () => {
    const result = buildThreadHereResult({ kind: 'cleared' });
    expect(result.kind === 'text' && result.text).toContain('your DMs');
    expect(result.kind === 'text' && result.text).not.toContain('instead of');
  });

  // `already-dm` is now reserved for a DM choice that is already ON DISK — clearing with no pin at
  // all still records one, so this reply only appears when there is genuinely nothing to write.
  it('says nothing changed when the DM choice was already recorded', () => {
    const result = buildThreadHereResult({ kind: 'already-dm' });
    expect(result.kind).toBe('text');
    expect(result.kind === 'text' && result.text).toContain('Nothing changed.');
  });
});

describe('buildThreadHereResult — status', () => {
  const CHANNEL = '333333333333333333';

  // Every row of the routing status. The reply has to name the destination, the authority behind
  // it, and a way to change it — a user reading this because their output turned up somewhere
  // unexpected needs all three, and a broken channel needs the reason too.
  it.each<[string, ThreadHereStatus, string[]]>([
    [
      'a healthy channel the user pinned',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'pin',
        health: { kind: 'ok' },
      },
      ['pinned by you', `<#${CHANNEL}>`],
    ],
    [
      'a pinned channel that has gone away',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'pin',
        health: { kind: 'unreachable' },
      },
      ['pinned to', 'cannot use that channel', 'your DMs'],
    ],
    [
      'a pinned channel the bot lost permissions in',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'pin',
        health: { kind: 'missing-permissions', missing: ['Manage Threads'] },
      },
      ['pinned to', 'Manage Threads', 'server admin'],
    ],
    [
      'a pinned channel the user themselves can no longer see',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'pin',
        health: { kind: 'user-cannot-access' },
      },
      // The bot's own permissions are fine here, so the reply must point at the user's access
      // instead of sending them to an admin who has nothing to grant.
      ['pinned to', 'cannot see that channel', 'your DMs'],
    ],
    [
      'a healthy deployment channel',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'deployment',
        health: { kind: 'ok' },
      },
      ["this deployment's default", 'pin your own'],
    ],
    [
      'a deployment channel that has gone away',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'deployment',
        health: { kind: 'unreachable' },
      },
      ['This deployment sends', 'cannot use that channel', 'your DMs'],
    ],
    [
      'a deployment channel the bot lost permissions in',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'deployment',
        health: { kind: 'missing-permissions', missing: ['View Channel'] },
      },
      ['This deployment sends', 'View Channel', 'your DMs'],
    ],
    [
      'a deployment channel the user themselves can no longer see',
      {
        destination: 'channel',
        channelId: CHANNEL,
        source: 'deployment',
        health: { kind: 'user-cannot-access' },
      },
      ['This deployment sends', 'cannot see that channel', 'your DMs'],
    ],
    ['DMs the user asked for', { destination: 'dm', source: 'pin' }, ['cleared by you', 'pin one']],
    [
      'DMs as the deployment default',
      { destination: 'dm', source: 'deployment' },
      ['your DMs', 'send them there instead'],
    ],
  ])('reports %s', (_label, status, expected) => {
    const result = buildThreadHereResult({ kind: 'status', status });
    expect(result.kind).toBe('text');
    if (result.kind !== 'text') throw new Error('unreachable');
    for (const fragment of expected) expect(result.text).toContain(fragment);
  });

  // Status is read-only: it must never be phrased as though it did something.
  it('never claims a change', () => {
    const result = buildThreadHereResult({
      kind: 'status',
      status: { destination: 'dm', source: 'deployment' },
    });
    expect(result.kind === 'text' && result.text).not.toContain('Pinned.');
    expect(result.kind === 'text' && result.text).not.toContain('Cleared.');
  });
});
