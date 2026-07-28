// Per-user session-channel config and resolution.
//
// Four properties carry the feature and are therefore what these tests defend:
//   1. malformed config is LOUD (a mistyped id silently reverts a user to DMs — invisible)
//   2. an unlisted user resolves to `undefined`, which is the gateway's DM fallback — the whole
//      point of a mixed deployment, and a regression that would look like "threads work fine"
//      right up until someone else pairs and their output lands in the operator's channel.
//   3. a user's own pin outranks both env vars, and an explicit DM pin ENDS the chain rather than
//      falling through to a deployment channel — otherwise "send my threads back to my DMs" is a
//      lie told with a confirmation message
//   4. a pin accessor alone is enough to build a resolver, because the ordinary deployment
//      configures no session channels at all and a config-only guard would leave every pin on
//      those deployments written to disk and then silently ignored

import { describe, it, expect, vi } from 'vitest';
import {
  parseSessionChannelMap,
  createSessionChannelResolver,
  chooseSessionChannel,
  type SessionChannelPin,
  type SessionThreadParent,
} from './sessionChannels.js';

// Snowflake-shaped ids: the parser validates shape, so tests must use realistic ones or they
// would pass against a parser that accepted anything.
const USER_A = '111111111111111111';
const USER_B = '222222222222222222';
const CHANNEL_A = '333333333333333333';
const CHANNEL_B = '444444444444444444';

/** A stand-in for a fetched text channel. Only its identity matters here — the resolver's job is
 *  choosing WHICH channel id to fetch, not what the channel can do. */
function fakeParent(label: string): SessionThreadParent & { label: string } {
  return {
    label,
    threads: {
      create: () =>
        Promise.resolve({
          id: `thread-${label}`,
          members: { add: () => Promise.resolve(undefined) },
        }),
    },
  };
}

describe('parseSessionChannelMap', () => {
  it('parses a single pair', () => {
    const { entries, errors } = parseSessionChannelMap(`${USER_A}:${CHANNEL_A}`);
    expect(errors).toEqual([]);
    expect([...entries]).toEqual([[USER_A, CHANNEL_A]]);
  });

  it('parses several pairs and tolerates operator whitespace and stray commas', () => {
    const { entries, errors } = parseSessionChannelMap(
      `  ${USER_A} : ${CHANNEL_A} , , ${USER_B}:${CHANNEL_B},  `,
    );
    expect(errors).toEqual([]);
    expect(entries.get(USER_A)).toBe(CHANNEL_A);
    expect(entries.get(USER_B)).toBe(CHANNEL_B);
    expect(entries.size).toBe(2);
  });

  // Unset and empty are the overwhelmingly common cases (every deployment that predates this
  // feature), and must be ordinary rather than a startup failure.
  it.each([
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   '],
    ['commas only', ' , , '],
  ])('treats %s config as no overrides, not an error', (_label, spec) => {
    const { entries, errors } = parseSessionChannelMap(spec);
    expect(errors).toEqual([]);
    expect(entries.size).toBe(0);
  });

  it('rejects a segment with no colon', () => {
    const { entries, errors } = parseSessionChannelMap(`${USER_A}${CHANNEL_A}`);
    expect(entries.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not a <userId>:<channelId> pair');
  });

  // A third colon means the operator wrote something they did not mean; keeping the first two
  // fields would route real output somewhere unverified.
  it('rejects a segment with more than one colon', () => {
    const { errors } = parseSessionChannelMap(`${USER_A}:${CHANNEL_A}:${CHANNEL_B}`);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('not a <userId>:<channelId> pair');
  });

  it.each([
    ['user id', `123:${CHANNEL_A}`, 'not a Discord user id'],
    ['channel id', `${USER_A}:nope`, 'not a Discord channel id'],
    ['both, reporting the user id first', 'abc:def', 'not a Discord user id'],
  ])('rejects a non-snowflake %s', (_label, spec, expected) => {
    const { entries, errors } = parseSessionChannelMap(spec);
    expect(entries.size).toBe(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(expected);
  });

  // No defensible winner between two channels for one user, and picking one silently would send
  // session output to a channel the operator did not intend.
  it('rejects a duplicated user and keeps the first mapping out of the result', () => {
    const { entries, errors } = parseSessionChannelMap(
      `${USER_A}:${CHANNEL_A},${USER_A}:${CHANNEL_B}`,
    );
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('listed more than once');
    expect(entries.get(USER_A)).toBe(CHANNEL_A);
  });

  // The same user id may legitimately appear as a CHANNEL id in another pair; only a repeated
  // *user* is ambiguous.
  it('allows the same channel to host two users', () => {
    const { entries, errors } = parseSessionChannelMap(
      `${USER_A}:${CHANNEL_A},${USER_B}:${CHANNEL_A}`,
    );
    expect(errors).toEqual([]);
    expect(entries.get(USER_A)).toBe(CHANNEL_A);
    expect(entries.get(USER_B)).toBe(CHANNEL_A);
  });

  it('reports every malformed pair at once, and keeps the valid ones', () => {
    const { entries, errors } = parseSessionChannelMap(
      `oops,${USER_A}:${CHANNEL_A},also:bad,${USER_B}:short`,
    );
    expect(errors).toHaveLength(3);
    expect(entries.size).toBe(1);
    expect(entries.get(USER_A)).toBe(CHANNEL_A);
  });
});

describe('createSessionChannelResolver', () => {
  // "No resolver" is what the gateway reads as a pure-DM deployment, so this must stay undefined
  // rather than becoming a resolver that always resolves to nothing.
  it('is undefined when neither a pin accessor, a map, nor a fallback is configured', () => {
    expect(
      createSessionChannelResolver({ fetchParent: () => Promise.resolve(undefined) }),
    ).toBeUndefined();
    expect(
      createSessionChannelResolver({
        fetchParent: () => Promise.resolve(undefined),
        byUser: new Map(),
      }),
    ).toBeUndefined();
  });

  it('exists when only a fallback is configured (the pre-existing all-users behaviour)', async () => {
    const fetchParent = vi.fn(() => Promise.resolve(fakeParent('fallback')));
    const resolve = createSessionChannelResolver({ fetchParent, fallbackChannelId: CHANNEL_B });
    expect(resolve).toBeDefined();
    await resolve?.(USER_A);
    expect(fetchParent).toHaveBeenCalledWith(CHANNEL_B);
  });

  it('exists when only a map is configured', () => {
    const resolve = createSessionChannelResolver({
      fetchParent: () => Promise.resolve(undefined),
      byUser: new Map([[USER_A, CHANNEL_A]]),
    });
    expect(resolve).toBeDefined();
  });

  // The headline behaviour: named user → their channel, everyone else → DM fallback.
  it('resolves a listed user to their channel and leaves an unlisted user on DMs', async () => {
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      byUser: new Map([[USER_A, CHANNEL_A]]),
    });
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_A });
    expect(await resolve?.(USER_B)).toBeUndefined();
    // No fetch is issued for the unlisted user — there is no channel to ask about.
    expect(fetchParent).toHaveBeenCalledTimes(1);
    expect(fetchParent).toHaveBeenCalledWith(CHANNEL_A);
  });

  it('prefers a user override over the shared fallback channel', async () => {
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      byUser: new Map([[USER_A, CHANNEL_A]]),
      fallbackChannelId: CHANNEL_B,
    });
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_A });
    expect(await resolve?.(USER_B)).toMatchObject({ label: CHANNEL_B });
  });

  // A channel that is deleted, retyped, or hidden from the bot must degrade to the DM fallback
  // rather than propagating a failure into delivery.
  it('passes through an unresolvable channel as undefined', async () => {
    const resolve = createSessionChannelResolver({
      fetchParent: () => Promise.resolve(undefined),
      byUser: new Map([[USER_A, CHANNEL_A]]),
    });
    expect(await resolve?.(USER_A)).toBeUndefined();
  });

  // Caching a handle for the bot's lifetime would keep handing out a channel that has since
  // disappeared, so every call must re-ask.
  it('re-fetches on every call rather than caching a channel handle', async () => {
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      byUser: new Map([[USER_A, CHANNEL_A]]),
    });
    await resolve?.(USER_A);
    await resolve?.(USER_A);
    expect(fetchParent).toHaveBeenCalledTimes(2);
  });
});

describe("chooseSessionChannel - who decides where a user's threads go", () => {
  const none = { pin: undefined, byUser: undefined, fallbackChannelId: undefined } as const;

  // The contested case, and the one the whole feature turns on: a user the operator already
  // configured is exactly the user who most needs to be able to move themselves.
  it("a user's own pinned channel beats the operator per-user map", () => {
    expect(
      chooseSessionChannel(USER_A, {
        ...none,
        pin: { kind: 'channel', channelId: CHANNEL_A },
        byUser: new Map([[USER_A, CHANNEL_B]]),
      }),
    ).toEqual({ destination: 'channel', channelId: CHANNEL_A, source: 'pin' });
  });

  it("a user's own pinned channel beats the shared fallback channel", () => {
    expect(
      chooseSessionChannel(USER_A, {
        ...none,
        pin: { kind: 'channel', channelId: CHANNEL_A },
        fallbackChannelId: CHANNEL_B,
      }),
    ).toEqual({ destination: 'channel', channelId: CHANNEL_A, source: 'pin' });
  });

  // A cleared pin that fell through would confirm "back to your DMs" and then deliver to a
  // channel anyway on the very next session — the revocation path has to be unconditional.
  it.each([
    ['the operator map names a channel', { byUser: new Map([[USER_A, CHANNEL_A]]) }],
    ['a shared fallback is set', { fallbackChannelId: CHANNEL_B }],
    ['both are set', { byUser: new Map([[USER_A, CHANNEL_A]]), fallbackChannelId: CHANNEL_B }],
  ])('an explicit DM pin routes to DMs even when %s', (_label, config) => {
    expect(chooseSessionChannel(USER_A, { ...none, ...config, pin: { kind: 'dm' } })).toEqual({
      destination: 'dm',
      source: 'pin',
    });
  });

  // Constraint on the whole change: env-configured deployments keep behaving exactly as before for
  // anyone who has never touched /thread-here.
  it('a user with no pin still follows the operator map, then the shared fallback', () => {
    const config = { byUser: new Map([[USER_A, CHANNEL_A]]), fallbackChannelId: CHANNEL_B };
    expect(chooseSessionChannel(USER_A, { ...none, ...config })).toEqual({
      destination: 'channel',
      channelId: CHANNEL_A,
      source: 'deployment',
    });
    expect(chooseSessionChannel(USER_B, { ...none, ...config })).toEqual({
      destination: 'channel',
      channelId: CHANNEL_B,
      source: 'deployment',
    });
  });

  // Two ways to end up on DMs that call for completely different replies: one was chosen.
  it('separates DMs by deployment default from DMs the user asked for', () => {
    expect(chooseSessionChannel(USER_A, none)).toEqual({
      destination: 'dm',
      source: 'deployment',
    });
    expect(chooseSessionChannel(USER_A, { ...none, pin: { kind: 'dm' } })).toEqual({
      destination: 'dm',
      source: 'pin',
    });
  });
});

describe("createSessionChannelResolver - a user's own pin", () => {
  // The highest-regression line in the change. The ordinary deployment sets NEITHER env var, so a
  // guard that only counted config would build no resolver at all there — and the gateway holds
  // the resolver in a field assigned once, so every pin would be persisted and then ignored until
  // a restart, with nothing thrown and nothing logged.
  it('builds a resolver from a pin accessor alone, so a first pin needs no restart', async () => {
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      resolvePin: () => ({ kind: 'channel', channelId: CHANNEL_A }),
    });
    expect(resolve).toBeDefined();
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_A });
  });

  it('still returns no resolver when nothing at all is configured', () => {
    expect(
      createSessionChannelResolver({ fetchParent: () => Promise.resolve(undefined) }),
    ).toBeUndefined();
  });

  // The accessor is read per call, not captured: the resolver is built once during construction
  // and never rebuilt, so a snapshot would make every pin take effect one restart late.
  it('reads the pin accessor on every call, so a pin made after construction is honoured', async () => {
    const pins = new Map<string, SessionChannelPin>();
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      resolvePin: (id) => pins.get(id),
      fallbackChannelId: CHANNEL_B,
    });
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_B });

    pins.set(USER_A, { kind: 'channel', channelId: CHANNEL_A });
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_A });

    pins.set(USER_A, { kind: 'dm' });
    expect(await resolve?.(USER_A)).toBeUndefined();
  });

  it('leaves an unpinned user on the deployment channel', async () => {
    const fetchParent = vi.fn((id: string) => Promise.resolve(fakeParent(id)));
    const resolve = createSessionChannelResolver({
      fetchParent,
      resolvePin: () => undefined,
      byUser: new Map([[USER_A, CHANNEL_A]]),
    });
    expect(await resolve?.(USER_A)).toMatchObject({ label: CHANNEL_A });
    expect(await resolve?.(USER_B)).toBeUndefined();
  });
});
