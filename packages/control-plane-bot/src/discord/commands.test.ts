import { describe, it, expect, vi } from 'vitest';
import type { EnvelopeDraft } from '@claude-control/shared-protocol';
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
  type CommandDeps,
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
