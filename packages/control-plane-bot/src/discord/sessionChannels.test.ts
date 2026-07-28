// Per-user session-channel config and resolution.
//
// Two properties carry the feature and are therefore what these tests defend:
//   1. malformed config is LOUD (a mistyped id silently reverts a user to DMs — invisible)
//   2. an unlisted user resolves to `undefined`, which is the gateway's DM fallback — the whole
//      point of a mixed deployment, and a regression that would look like "threads work fine"
//      right up until someone else pairs and their output lands in the operator's channel.

import { describe, it, expect, vi } from 'vitest';
import {
  parseSessionChannelMap,
  createSessionChannelResolver,
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
  it('is undefined when neither a map nor a fallback is configured', () => {
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
