// Which channel hosts a given user's session threads — the pure half of session-thread routing.
//
// Session output is keyed by (discordUserId, sessionId) and arrives from a daemon over the relay
// socket, so nothing about a frame says which SERVER it belongs to. The only routing question that
// can be answered is therefore per-USER: "for this Discord user, which channel do their threads go
// under?" — which is exactly the shape of {@link SessionChannelResolver}.
//
// A deployment answers that with a per-user map, an all-users fallback channel, or neither:
//   - a user named in the map           → threads under their channel
//   - a user not named, fallback set    → threads under the shared fallback channel
//   - a user not named, no fallback     → resolver returns undefined → the gateway's DM fallback
// The last case is why a mixed deployment needs no new delivery path: `undefined` already means
// "DM this user", and has since threads existed.
//
// Everything here is pure. Fetching a channel (and narrowing it to a real text channel) is a live
// discord.js concern and stays at the gateway boundary, injected as `fetchParent`; this module only
// decides WHICH channel id to ask for. That split is what makes the precedence rules unit-testable
// without a Discord connection.

import type { ChannelType } from 'discord.js';

/** The single capability a session thread's parent channel must have: minting a private thread and
 *  admitting one member. Structural (not a discord.js class) so tests can satisfy it with a plain
 *  object and the gateway can pass a real TextChannel unchanged. The `ChannelType` import is
 *  type-only — this module stays free of discord.js at runtime. */
export interface SessionThreadParent {
  threads: {
    create(options: {
      name: string;
      type: ChannelType.PrivateThread;
      invitable: boolean;
    }): Promise<{ id: string; members: { add(userId: string): Promise<unknown> } }>;
  };
}

/** Where a user's per-session threads should be created. Returns `undefined` (the default) when no
 *  channel is available, in which case delivery falls back to the user's DM and remembers it. */
export type SessionChannelResolver = (
  discordUserId: string,
) => Promise<SessionThreadParent | undefined>;

/** Outcome of parsing the `CCTL_SESSION_CHANNELS` spec. Errors are returned rather than thrown so
 *  the caller can report EVERY malformed entry in one startup failure instead of making an operator
 *  fix a long map one typo per restart. */
export interface SessionChannelMapParse {
  entries: Map<string, string>;
  errors: string[];
}

/** Discord snowflakes are decimal ids — 17-19 digits today, 20 allowed for headroom. Validating
 *  shape matters more than it looks: a mistyped user id is not a crash but a SILENT no-op (that
 *  user simply never matches and keeps getting DMs), which is the one failure mode this feature
 *  exists to eliminate. Cheap syntactic check now beats a puzzled operator later. */
const SNOWFLAKE = /^\d{17,20}$/;

/** Parse `"<userId>:<channelId>,<userId>:<channelId>"` into a user→channel map.
 *
 *  Tolerant of operator formatting — surrounding whitespace, whitespace around either side of a
 *  pair, empty segments from a trailing or doubled comma — because this is hand-edited in a `.env`
 *  file. Strict about everything that would change ROUTING: a missing colon, a non-snowflake on
 *  either side, or the same user listed twice (genuinely ambiguous — there is no defensible winner)
 *  are all reported as errors. An unset or all-whitespace spec is not an error; it is the ordinary
 *  "no per-user overrides configured" case and yields an empty map. */
export function parseSessionChannelMap(spec: string | undefined): SessionChannelMapParse {
  const entries = new Map<string, string>();
  const errors: string[] = [];
  for (const raw of (spec ?? '').split(',')) {
    const segment = raw.trim();
    if (segment === '') continue;
    // indexOf, not split(':'): a third colon means the entry is malformed, and reporting that is
    // more useful than silently keeping the first two fields of a line the operator got wrong.
    const sep = segment.indexOf(':');
    const extra = segment.indexOf(':', sep + 1);
    if (sep === -1 || extra !== -1) {
      errors.push(`"${segment}" is not a <userId>:<channelId> pair`);
      continue;
    }
    const discordUserId = segment.slice(0, sep).trim();
    const channelId = segment.slice(sep + 1).trim();
    if (!SNOWFLAKE.test(discordUserId)) {
      errors.push(`"${discordUserId}" is not a Discord user id (17-20 digits)`);
      continue;
    }
    if (!SNOWFLAKE.test(channelId)) {
      errors.push(`"${channelId}" is not a Discord channel id (17-20 digits)`);
      continue;
    }
    if (entries.has(discordUserId)) {
      errors.push(`user ${discordUserId} is listed more than once`);
      continue;
    }
    entries.set(discordUserId, channelId);
  }
  return { entries, errors };
}

export interface SessionChannelResolverOptions {
  /** Fetch a channel by id and narrow it to a usable thread parent, or `undefined` if it is gone,
   *  invisible to the bot, or not a text channel. Injected so this module stays free of discord.js;
   *  the gateway supplies the real lookup. */
  fetchParent: (channelId: string) => Promise<SessionThreadParent | undefined>;
  /** Per-user overrides, highest precedence. */
  byUser?: ReadonlyMap<string, string>;
  /** Channel used for any user without an override — the pre-existing all-users behaviour. */
  fallbackChannelId?: string;
}

/** Build the resolver, or `undefined` when NO channel is configured at all.
 *
 *  That `undefined` is load-bearing rather than a mere optimisation: the gateway treats "no
 *  resolver" as a pure-DM deployment, so returning a resolver that always resolves to nothing
 *  would be a behaviour change dressed as a refactor.
 *
 *  The returned resolver re-fetches on every call by design. Caching a channel handle for the
 *  bot's lifetime means a channel that is later deleted, retyped, or made invisible keeps being
 *  handed out; re-fetching lets that degrade to the DM fallback on the next session instead. */
export function createSessionChannelResolver(
  options: SessionChannelResolverOptions,
): SessionChannelResolver | undefined {
  const { fetchParent, byUser, fallbackChannelId } = options;
  if (!fallbackChannelId && !(byUser && byUser.size > 0)) return undefined;
  return async (discordUserId: string) => {
    const channelId = byUser?.get(discordUserId) ?? fallbackChannelId;
    // Reachable only when a map is configured without a fallback and this user is not in it —
    // the mixed deployment this feature exists for, where unlisted users belong on DMs.
    if (channelId === undefined) return undefined;
    return fetchParent(channelId);
  };
}
