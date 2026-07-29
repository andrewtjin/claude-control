import { describe, it, expect, vi } from 'vitest';
import type { App, RespondFn, AckFn, RespondArguments, SlashCommand } from '@slack/bolt';
import type { EnvelopeDraft, TokenStatsSnapshot } from '@claude-control/shared-protocol';
import type { RelaySender, SendResult } from '../relay.js';
import { BindingStore } from '../bindings.js';
import { PairingService } from '../pairing.js';
import { DaemonStateCache } from '../discord/stateCache.js';
import { PendingStatsScans } from '../discord/pendingStatsScans.js';
import { noopLogger } from '../logger.js';
import type { SlackContext } from './context.js';
import { registerSlackCommands } from './slackCommands.js';

// ---------------------------------------------------------------------------
// Fakes. No real Bolt App, no real socket — `registerSlackCommands` only ever touches
// `app.command()` and whatever's on `SlackContext`, so both are stood up by hand.
// ---------------------------------------------------------------------------

/** What `registerSlackCommands`'s inner listener actually destructures — narrower than Bolt's
 *  full `SlackCommandMiddlewareArgs`, which is fine: the fake `App` below is cast past Bolt's
 *  real (much wider) `Middleware` type, so nothing here is checked against it anyway. */
type SlackCommandHandlerArgs = {
  command: SlashCommand;
  ack: AckFn<string | RespondArguments>;
  respond: RespondFn;
};
type CommandHandler = (args: SlackCommandHandlerArgs) => Promise<void>;

/** Captures the listener `registerSlackCommands` hands to `app.command('/cctl', …)` so a test
 *  can invoke it directly with a fake interaction — no Bolt receiver, no HTTP, no socket. */
function createFakeApp(): { app: App; getHandler: () => CommandHandler } {
  let handler: CommandHandler | undefined;
  const app = {
    command: (_name: string, listener: unknown) => {
      handler = listener as CommandHandler;
    },
  } as unknown as App;
  return {
    app,
    getHandler: () => {
      if (handler === undefined) throw new Error('registerSlackCommands did not register /cctl');
      return handler;
    },
  };
}

function fakeSlashCommand(text: string, userId = 'U1'): SlashCommand {
  return {
    token: 'tok',
    command: '/cctl',
    text,
    response_url: 'https://hooks.slack.test/1',
    trigger_id: 'trigger-1',
    user_id: userId,
    user_name: 'tester',
    team_id: 'T1',
    team_domain: 'example',
    channel_id: 'C1',
    channel_name: 'general',
    api_app_id: 'A1',
  };
}

/** A `respond` fake that never touches the network, plus a reader for what got sent — every
 *  production call passes a `RespondArguments` object (never a bare string), so the cast is safe. */
function fakeRespond() {
  // The parameter is declared (and unused) purely so `mock.calls` is typed as a 1-tuple — a
  // zero-arg fake records `[]`, leaving nothing at index 0 for `at()` to read back.
  const respond = vi.fn((_message: string | RespondArguments) =>
    Promise.resolve({} as Awaited<ReturnType<RespondFn>>),
  );
  const at = (index: number): RespondArguments =>
    respond.mock.calls[index]?.[0] as RespondArguments;
  return { respond: respond as unknown as RespondFn, spy: respond, at };
}

const noopAck: AckFn<string | RespondArguments> = () => Promise.resolve();

/** A `SlackContext` wired to fakes throughout. `onSend` lets a test observe (or react to) a frame
 *  the instant it would reach a daemon — used by the stats-scan tests to settle the waiter from
 *  exactly the point in time production code sends the request, proving register-before-send
 *  rather than merely asserting it after the fact. */
function makeCtx(
  opts: { online?: Record<string, string>; onSend?: (draft: EnvelopeDraft) => void } = {},
) {
  const online = opts.online ?? {};
  const statsScans = new PendingStatsScans();
  const sent: { discordUserId: string; daemonId: string; draft: EnvelopeDraft }[] = [];
  const relay: RelaySender = {
    sendToUser(discordUserId, build) {
      const daemonId = online[discordUserId];
      if (!daemonId) return { ok: false, error: 'no daemon is paired to this account' };
      const draft = build(daemonId);
      sent.push({ discordUserId, daemonId, draft });
      opts.onSend?.(draft);
      return { ok: true } satisfies SendResult;
    },
    isOnline(discordUserId) {
      return online[discordUserId] !== undefined;
    },
  };
  const ctx: SlackContext = {
    web: {} as SlackContext['web'],
    logger: noopLogger,
    relay,
    pairing: new PairingService({ bindings: new BindingStore() }),
    teamId: 'T1',
    cache: new DaemonStateCache(),
    statsScans,
    openDm: () => Promise.resolve('D1'),
    principalOf: (slackUserId: string) => `slack:T1:${slackUserId}`,
  };
  return { ctx, sent, statsScans };
}

const FAKE_STATS_SNAPSHOT: TokenStatsSnapshot = {
  windowStartMs: 0,
  windowEndMs: 5 * 86_400_000,
  overall: { input: 1, output: 2, cacheCreation: 3, cacheRead: 4, turns: 5 },
  byAccount: [],
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
};

// ---------------------------------------------------------------------------

describe('registerSlackCommands', () => {
  it('registers exactly one /cctl command', () => {
    const { ctx } = makeCtx();
    const commandSpy = vi.fn();
    const app = { command: commandSpy } as unknown as App;
    registerSlackCommands(app, ctx);
    expect(commandSpy).toHaveBeenCalledTimes(1);
    expect(commandSpy.mock.calls[0]?.[0]).toBe('/cctl');
  });

  it('acks before any handler work runs, not after', async () => {
    const { ctx } = makeCtx();
    const order: string[] = [];
    // handlePair's only side effect is this call — a clean, single marker for "work happened".
    vi.spyOn(ctx.pairing, 'createCode').mockImplementation(() => {
      order.push('work');
      return 'CODE-1';
    });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const ack: AckFn<string | RespondArguments> = () => {
      order.push('ack');
      return Promise.resolve();
    };
    const { respond } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('pair'), ack, respond });
    expect(order).toEqual(['ack', 'work']);
  });

  it('dispatches /cctl pair to handlePair with the namespaced principal, never the raw Slack id', async () => {
    const { ctx } = makeCtx();
    const spy = vi.spyOn(ctx.pairing, 'createCode');
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('pair', 'U42'), ack: noopAck, respond });
    expect(spy).toHaveBeenCalledWith('slack:T1:U42');
    expect(spy).not.toHaveBeenCalledWith('U42');
  });

  it('dispatches /cctl status to handleStatus with the namespaced principal (case-insensitive subcommand)', async () => {
    const { ctx } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('STATUS', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toBe('Daemon is online.');
  });

  it('dispatches /cctl usage to handleUsage (cache miss text, no relay round trip)', async () => {
    const { ctx, sent } = makeCtx();
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('usage', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toContain('No usage data yet');
    expect(sent).toHaveLength(0);
  });

  it('dispatches /cctl sessions to handleSessions', async () => {
    const { ctx } = makeCtx();
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('sessions', 'U1'), ack: noopAck, respond });
    // No sessions cached -> embed renders its own "no sessions" description; converted to text
    // it still carries the bolded "Sessions" title from the embed.
    expect(at(0).text).toContain('Sessions');
  });

  it('escapes Slack control sequences carried in daemon-sourced embed content (hostile input)', async () => {
    const { ctx } = makeCtx();
    ctx.cache.record('slack:T1:U1', {
      v: 1,
      id: 'x',
      ts: 0,
      daemonId: 'daemon-1',
      type: 'usage.snapshot',
      payload: {
        accounts: [
          {
            accountId: 'acct-1',
            // A compromised/misbehaving daemon controls this label end to end.
            label: '<!everyone> pwned & <@U000>',
            active: true,
            source: 'live',
            fetchedAtMs: 0,
            limits: [],
          },
        ],
      },
    });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('accounts', 'U1'), ack: noopAck, respond });
    const text = at(0).text ?? '';
    expect(text).not.toContain('<!everyone>');
    expect(text).not.toContain('<@U000>');
    expect(text).toContain('&lt;!everyone&gt;');
    expect(text).toContain('&amp;');
  });

  describe('link scheme allowlist — end to end through the command-reply path', () => {
    // Same payload table as slackFormat.test.ts's toMrkdwn suite and slackBlocks.test.ts's card
    // senders, driven through respondResult's sanitize-then-chunk pipeline this time — a
    // compromised/misbehaving daemon can put an account label on the wire, and this proves it
    // can't turn a `[label](url)` inside that label into a live mention in a slash-command reply.
    const HOSTILE_LINK_URLS = [
      '!channel',
      '!here',
      '!everyone',
      '@U024BE7LH',
      '#C024BE7LR|general',
    ];

    it.each(HOSTILE_LINK_URLS)(
      'never lets a [label](%s) link in a daemon-sourced account label become a live mention',
      async (url) => {
        const { ctx } = makeCtx();
        const safeId = url.replace(/[^a-zA-Z0-9]/g, '');
        ctx.cache.record('slack:T1:U1', {
          v: 1,
          id: `x-${safeId}`,
          ts: 0,
          daemonId: 'daemon-1',
          type: 'usage.snapshot',
          payload: {
            accounts: [
              {
                accountId: 'acct-1',
                label: `see [details](${url})`,
                active: true,
                source: 'live',
                fetchedAtMs: 0,
                limits: [],
              },
            ],
          },
        });
        const { app, getHandler } = createFakeApp();
        registerSlackCommands(app, ctx);
        const { respond, at } = fakeRespond();
        await getHandler()({ command: fakeSlashCommand('accounts', 'U1'), ack: noopAck, respond });
        const text = at(0).text ?? '';
        expect(text).not.toMatch(/<[!@#]/);
      },
    );
  });

  describe('respondResult — reply chunk cap', () => {
    it('caps a huge reply at MAX_REPLY_CHUNKS and marks how much was left out, instead of silently dropping chunks past the response_url budget', async () => {
      const { ctx } = makeCtx();
      // 20 accounts stays under Discord's own 25-field-per-embed cap; a long daemon-sourced
      // `error` string on each pushes the rendered reply well past four 3000-char chunks, forcing
      // the cap in `respondResult` to actually bite.
      const accounts = Array.from({ length: 20 }, (_, i) => ({
        accountId: `acct-${i}`,
        label: `account-${i}`,
        active: true,
        source: 'live' as const,
        fetchedAtMs: 0,
        limits: [],
        error: 'x'.repeat(900),
      }));
      ctx.cache.record('slack:T1:U1', {
        v: 1,
        id: 'x',
        ts: 0,
        daemonId: 'daemon-1',
        type: 'usage.snapshot',
        payload: { accounts },
      });
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, spy } = fakeRespond();
      await getHandler()({ command: fakeSlashCommand('accounts', 'U1'), ack: noopAck, respond });
      expect(spy.mock.calls.length).toBeLessThanOrEqual(4);
      const lastCall = spy.mock.calls[spy.mock.calls.length - 1]?.[0] as RespondArguments;
      expect(lastCall.text).toContain('output truncated');
    });
  });

  it('/cctl run parses leading cwd:/resume: flags ahead of the prompt', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond } = fakeRespond();
    await getHandler()({
      command: fakeSlashCommand('run cwd:/tmp/proj resume:sess-1 fix the thing', 'U1'),
      ack: noopAck,
      respond,
    });
    expect(sent).toHaveLength(1);
    const draft = sent[0]?.draft;
    if (draft?.type !== 'session.spawn') throw new Error('expected a session.spawn envelope');
    expect(draft.payload.prompt).toBe('fix the thing');
    expect(draft.payload.cwd).toBe('/tmp/proj');
    expect(draft.payload.resumeSessionId).toBe('sess-1');
  });

  it('/cctl run with no prompt is a usage error, sending nothing to the relay', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('run', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toContain('Usage: `/cctl run');
    expect(sent).toHaveLength(0);
  });

  it('/cctl say splits sessionId from the remaining text and reaches the relay', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({
      command: fakeSlashCommand('say sess-1 keep going, looks good', 'U1'),
      ack: noopAck,
      respond,
    });
    expect(at(0).text).toBe('Sent.');
    const draft = sent[0]?.draft;
    if (draft?.type !== 'prompt.inject') throw new Error('expected a prompt.inject envelope');
    expect(draft.payload.sessionId).toBe('sess-1');
    expect(draft.payload.text).toBe('keep going, looks good');
  });

  it('/cctl say with only a session id (no text) is a usage error', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('say sess-1', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toContain('Usage: `/cctl say');
    expect(sent).toHaveLength(0);
  });

  it('/cctl stop reaches the relay with the given session id', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('stop sess-1', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toBe('Stop requested.');
    const draft = sent[0]?.draft;
    if (draft?.type !== 'session.stop') throw new Error('expected a session.stop envelope');
    expect(draft.payload.sessionId).toBe('sess-1');
  });

  it('/cctl stop with no session id is a usage error', async () => {
    const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('stop', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toContain('Usage: `/cctl stop');
    expect(sent).toHaveLength(0);
  });

  it('a daemon-offline error surfaces through the same sanitize-then-respond path', async () => {
    const { ctx } = makeCtx({ online: {} });
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('stop sess-1', 'U1'), ack: noopAck, respond });
    expect(at(0).text).toBe('Error: no daemon is paired to this account');
  });

  it('unknown subcommands get help listing the whole accepted set', async () => {
    const { ctx } = makeCtx();
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand('bogus'), ack: noopAck, respond });
    const text = at(0).text ?? '';
    expect(text).toContain('Unknown command');
    for (const sub of [
      'pair',
      'status',
      'usage',
      'accounts',
      'sessions',
      'run',
      'say',
      'stop',
      'stats',
    ]) {
      expect(text).toContain(sub);
    }
  });

  it('an empty command (just "/cctl") gets the same help', async () => {
    const { ctx } = makeCtx();
    const { app, getHandler } = createFakeApp();
    registerSlackCommands(app, ctx);
    const { respond, at } = fakeRespond();
    await getHandler()({ command: fakeSlashCommand(''), ack: noopAck, respond });
    expect(at(0).text).toContain('Unknown command');
  });

  describe('/cctl stats', () => {
    it('with no window answers from the cache, sending nothing to the relay', async () => {
      const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, at } = fakeRespond();
      await getHandler()({ command: fakeSlashCommand('stats', 'U1'), ack: noopAck, respond });
      expect(at(0).text).toContain('No token stats yet');
      expect(sent).toHaveLength(0);
    });

    it('rejects an out-of-range or malformed days argument before ever touching the relay', async () => {
      const { ctx, sent } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, at } = fakeRespond();
      await getHandler()({
        command: fakeSlashCommand('stats days:999', 'U1'),
        ack: noopAck,
        respond,
      });
      expect(at(0).text).toContain('Usage: `/cctl stats`');
      await getHandler()({ command: fakeSlashCommand('stats foo', 'U1'), ack: noopAck, respond });
      expect(at(1).text).toContain('Usage: `/cctl stats`');
      expect(sent).toHaveLength(0);
    });

    it('registers the waiter before the request reaches the relay, then delivers the result via respond', async () => {
      let settledSynchronously: boolean | undefined;
      const { ctx, statsScans } = makeCtx({
        online: { 'slack:T1:U1': 'daemon-1' },
        onSend: (draft) => {
          if (draft.type !== 'stats.request') return;
          // Settling HERE, from inside the send itself, only delivers if `awaitResult` was
          // already called for this requestId — proving register-before-send rather than just
          // asserting call order after the fact. A regression that sends before registering
          // would make this settle() return false and the awaited promise hang to timeout.
          settledSynchronously = statsScans.settle(draft.payload.requestId, {
            requestId: draft.payload.requestId,
            ok: true,
            snapshot: FAKE_STATS_SNAPSHOT,
          });
        },
      });
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, at } = fakeRespond();
      await getHandler()({
        command: fakeSlashCommand('stats days:5', 'U1'),
        ack: noopAck,
        respond,
      });

      expect(settledSynchronously).toBe(true);
      expect(at(0).text).toContain('Scanning the last 5 days');
      expect(at(0).replace_original).toBeUndefined();
      expect(at(1).replace_original).toBe(true);
      expect(at(1).text).toContain('Token usage');
    });

    it('abandons the waiter (rather than leaving it dangling) when the daemon is offline', async () => {
      const { ctx, statsScans } = makeCtx({ online: {} });
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, at } = fakeRespond();
      await getHandler()({
        command: fakeSlashCommand('stats days:5', 'U1'),
        ack: noopAck,
        respond,
      });
      expect(at(0).text).toBe('Error: no daemon is paired to this account');
      expect(statsScans.size()).toBe(0);
    });

    it('reports the cap when too many scans are already in flight', async () => {
      const { ctx, statsScans } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } });
      // Mirrors PendingStatsScans' own MAX_IN_FLIGHT — filling it makes the NEXT awaitResult
      // resolve 'busy' immediately, without ever registering.
      // `void`: each filler waiter is deliberately left unsettled — occupying a slot IS the setup.
      for (let i = 0; i < 16; i++) void statsScans.awaitResult(`filler-${i}`, 60_000);
      const { app, getHandler } = createFakeApp();
      registerSlackCommands(app, ctx);
      const { respond, at } = fakeRespond();
      await getHandler()({
        command: fakeSlashCommand('stats days:5', 'U1'),
        ack: noopAck,
        respond,
      });
      expect(at(1).text).toContain('Too many stats scans');
      expect(at(1).replace_original).toBe(true);
    });

    it('tells the user rather than dangling when the host never answers before the timeout', async () => {
      vi.useFakeTimers();
      try {
        const { ctx } = makeCtx({ online: { 'slack:T1:U1': 'daemon-1' } }); // onSend never settles
        const { app, getHandler } = createFakeApp();
        registerSlackCommands(app, ctx);
        const { respond, at } = fakeRespond();
        const done = getHandler()({
          command: fakeSlashCommand('stats days:5', 'U1'),
          ack: noopAck,
          respond,
        });
        await vi.advanceTimersByTimeAsync(120_000);
        await done;
        expect(at(1).text).toContain('did not finish scanning');
        expect(at(1).replace_original).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('a late stats.result for a requestId nobody is waiting on is a silent no-op', () => {
      const { statsScans } = makeCtx();
      const settle = () =>
        statsScans.settle('never-registered', {
          requestId: 'never-registered',
          ok: true,
          snapshot: FAKE_STATS_SNAPSHOT,
        });
      expect(settle).not.toThrow();
      expect(settle()).toBe(false);
    });
  });
});
