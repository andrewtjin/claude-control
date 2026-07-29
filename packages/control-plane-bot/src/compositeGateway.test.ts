import { describe, it, expect, vi } from 'vitest';
import type { Envelope } from '@claude-control/shared-protocol';
import { CompositeGateway, type StartableGateway } from './compositeGateway.js';
import { slackPrincipal } from './principal.js';
import type { Logger } from './logger.js';

/** Minimal envelope fixture — only the routing layer's own logic is under test here, so its
 *  contents never matter, only that the SAME object reaches the SAME gateway call. `ping` is the
 *  cheapest fully-valid variant of the union, so the fixture needs no cast. */
function envelope(): Envelope {
  return { v: 1, id: 'id-1', ts: 0, daemonId: 'd1', type: 'ping', payload: { nonce: null } };
}

/** Every method a gateway double exposes is a mock, so assertions can read call args off any of
 *  them — not just the one a given test drives. */
type FakeGateway = StartableGateway & {
  deliver: ReturnType<typeof vi.fn>;
  sendPrimer: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
};

/** A gateway double whose start/stop are independently controllable — needed for the
 *  reject-one-still-attempts-both fan-out case, which a plain vi.fn() can't express. Overrides are
 *  applied with Object.assign rather than an object spread: a spread would union each property
 *  with its optional counterpart from Partial<>, erasing the mock half of the type. */
function fakeGateway(overrides: Partial<FakeGateway> = {}): FakeGateway {
  const base: FakeGateway = {
    deliver: vi.fn(),
    sendPrimer: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return Object.assign(base, overrides);
}

/** A logger double that records warn() calls without printing anything — the only method this
 *  file's drop paths exercise. */
function fakeLogger(): Logger & { warn: ReturnType<typeof vi.fn> } {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('CompositeGateway routing', () => {
  it('routes a bare (Discord) id to the discord gateway', () => {
    const discord = fakeGateway();
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });
    const env = envelope();

    // `void`: deliver() is declared `void | Promise<void>` because a real gateway may be async,
    // but routing itself is synchronous — the call is recorded before this line returns.
    void composite.deliver('123456789', env);

    expect(discord.deliver).toHaveBeenCalledWith('123456789', env);
    expect(slack.deliver).not.toHaveBeenCalled();
  });

  it('routes a slack-namespaced principal to the slack gateway', () => {
    const discord = fakeGateway();
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });
    const env = envelope();
    const principal = slackPrincipal('T1', 'U1');

    void composite.deliver(principal, env);

    expect(slack.deliver).toHaveBeenCalledWith(principal, env);
    expect(discord.deliver).not.toHaveBeenCalled();
  });

  it('routes sendPrimer the same way as deliver', () => {
    const discord = fakeGateway();
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });
    const principal = slackPrincipal('T1', 'U1');

    void composite.sendPrimer('123456789');
    void composite.sendPrimer(principal);

    expect(discord.sendPrimer).toHaveBeenCalledWith('123456789');
    expect(slack.sendPrimer).toHaveBeenCalledWith(principal);
  });

  it('drops (warns, never throws) a deliver() for a surface with no configured gateway', () => {
    const discord = fakeGateway();
    const logger = fakeLogger();
    // Only Discord configured — a stale Slack binding must not crash delivery.
    const composite = new CompositeGateway({ discord, logger });
    const principal = slackPrincipal('T1', 'U1');

    expect(() => composite.deliver(principal, envelope())).not.toThrow();
    expect(discord.deliver).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ id: principal, surface: 'slack' });
  });

  it('drops (warns, never throws) a sendPrimer() for a surface with no configured gateway', () => {
    const slack = fakeGateway();
    const logger = fakeLogger();
    // Only Slack configured — a stray Discord id must not crash the primer send.
    const composite = new CompositeGateway({ slack, logger });

    expect(() => composite.sendPrimer('123456789')).not.toThrow();
    expect(slack.sendPrimer).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ id: '123456789', surface: 'discord' });
  });

  it('drops with neither surface configured, still without throwing', () => {
    const logger = fakeLogger();
    const composite = new CompositeGateway({ logger });

    expect(() => composite.deliver('123456789', envelope())).not.toThrow();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('CompositeGateway start/stop fan-out', () => {
  it('start() starts every configured gateway', async () => {
    const discord = fakeGateway();
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });

    await composite.start();

    expect(discord.start).toHaveBeenCalledTimes(1);
    expect(slack.start).toHaveBeenCalledTimes(1);
  });

  it('start() with only one surface configured does not touch the other', async () => {
    const discord = fakeGateway();
    const composite = new CompositeGateway({ discord, logger: fakeLogger() });

    await composite.start();

    expect(discord.start).toHaveBeenCalledTimes(1);
  });

  it('stop() attempts every configured gateway even when one rejects', async () => {
    const discord = fakeGateway({
      stop: vi.fn().mockRejectedValue(new Error('discord teardown failed')),
    });
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });

    await expect(composite.stop()).rejects.toThrow('discord teardown failed');

    // Both were attempted — the rejection did not short-circuit the fan-out.
    expect(discord.stop).toHaveBeenCalledTimes(1);
    expect(slack.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() resolves cleanly when every configured gateway resolves', async () => {
    const discord = fakeGateway();
    const slack = fakeGateway();
    const composite = new CompositeGateway({ discord, slack, logger: fakeLogger() });

    await expect(composite.stop()).resolves.toBeUndefined();
  });

  it('stop() with no configured gateways is a no-op that resolves', async () => {
    const composite = new CompositeGateway({ logger: fakeLogger() });

    await expect(composite.stop()).resolves.toBeUndefined();
  });
});
