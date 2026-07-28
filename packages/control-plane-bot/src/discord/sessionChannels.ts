// Which channel hosts a given user's session threads — the pure half of session-thread routing.
//
// Session output is keyed by (discordUserId, sessionId) and arrives from a daemon over the relay
// socket, so nothing about a frame says which SERVER it belongs to. The only routing question that
// can be answered is therefore per-USER: "for this Discord user, which channel do their threads go
// under?" — which is exactly the shape of {@link SessionChannelResolver}.
//
// Two authorities answer it, and the USER outranks the deployment. In order:
//   1. the user's own pin, `{channel}`  → threads under the channel they chose with /thread-here
//   2. the user's own pin, `{dm}`       → DMs, TERMINALLY — it does not fall through to 3 or 4
//   3. a user named in the operator map → threads under their configured channel
//   4. an all-users fallback channel    → threads under the shared channel
//   5. none of the above                → resolver returns undefined → the gateway's DM fallback
// The last case is why a mixed deployment needs no new delivery path: `undefined` already means
// "DM this user", and has since threads existed.
//
// The user beating the operator map (1 over 3) is deliberate. The map is a convenience default, not
// an access control — it cannot stop someone reading their own session output, so overriding it
// grants no capability the user did not already have. What it WOULD do if it won is defeat the
// feature for exactly the people an operator already touched: a user configured into the wrong
// channel would still need an operator edit and a redeploy, which is the problem /thread-here
// exists to remove. The operator's real lever over where the bot may post is the channel's Discord
// permissions, which the command preflights and reports on.
//
// An explicit `{dm}` pin terminating the chain (2, rather than falling through) is what makes
// revocation honest. Falling through would mean a user on a deployment with a fallback channel asks
// to go back to DMs, is told they have, and then gets a channel thread anyway on their next session.
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

/** A user's OWN standing choice of destination, set from Discord with `/thread-here` and persisted
 *  (see sessionChannelPins.ts). The `dm` variant is a REMEMBERED DECISION, not the absence of one —
 *  the same distinction threadRegistry.ts draws for a session's delivery target, and for the same
 *  reason: only a recorded "I chose DMs" can outrank a deployment channel, and without that the
 *  revocation path would silently do nothing on the deployments that most need it. Having no pin at
 *  all is the third state, and is what defers to the deployment's configuration. */
export type SessionChannelPin = { kind: 'channel'; channelId: string } | { kind: 'dm' };

/** Which authority decided a destination. Carried so a status reply can say WHY output goes where
 *  it goes ("pinned by you" vs "this deployment's default") — a user who is surprised by their
 *  routing needs the reason, not just the answer. */
export type SessionChannelSource = 'pin' | 'deployment';

/** A user's resolved destination, decided before any channel is fetched. `dm` carries a source too:
 *  a user who cleared their pin and a user on a deployment that configures nothing both end up on
 *  DMs, but only the first one chose it. */
export type SessionChannelChoice =
  | { destination: 'channel'; channelId: string; source: SessionChannelSource }
  | { destination: 'dm'; source: SessionChannelSource };

/** Every input the precedence rules consult. Required-but-nullable rather than optional: a caller
 *  cannot forget a tier by omitting it, and a call site that legitimately holds `undefined` can
 *  pass it straight through instead of doing the conditional-spread dance exactOptionalPropertyTypes
 *  would otherwise force. */
export interface SessionChannelInputs {
  pin: SessionChannelPin | undefined;
  byUser: ReadonlyMap<string, string> | undefined;
  fallbackChannelId: string | undefined;
}

/** The precedence rules from this module's header, as one pure function.
 *
 *  Separate from {@link createSessionChannelResolver} because two callers need the SAME answer for
 *  different purposes: the resolver, which then fetches the channel, and `/thread-here action:show`,
 *  which reports the destination and its source back to the user. Deriving the second from a copy of
 *  the rules is how a status reply comes to confidently describe routing the bot no longer does. */
export function chooseSessionChannel(
  discordUserId: string,
  inputs: SessionChannelInputs,
): SessionChannelChoice {
  const { pin, byUser, fallbackChannelId } = inputs;
  if (pin?.kind === 'dm') return { destination: 'dm', source: 'pin' };
  if (pin?.kind === 'channel') {
    return { destination: 'channel', channelId: pin.channelId, source: 'pin' };
  }
  const channelId = byUser?.get(discordUserId) ?? fallbackChannelId;
  return channelId === undefined
    ? { destination: 'dm', source: 'deployment' }
    : { destination: 'channel', channelId, source: 'deployment' };
}

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
  /** The invoking user's own persisted `/thread-here` choice, highest precedence. An ACCESSOR, not
   *  a snapshot: this resolver is built once during construction and never rebuilt, so a pin read
   *  from a captured value would not take effect until the next restart — which is the whole point
   *  of letting a user set it themselves. */
  resolvePin?: (discordUserId: string) => SessionChannelPin | undefined;
  /** Per-user operator overrides, outranked by the user's own pin. */
  byUser?: ReadonlyMap<string, string>;
  /** Channel used for any user without a pin or an override — the pre-existing all-users behaviour. */
  fallbackChannelId?: string;
}

/** Build the resolver, or `undefined` when NOTHING at all is configured — no pin accessor, no map,
 *  no fallback.
 *
 *  That `undefined` is load-bearing rather than a mere optimisation: the gateway treats "no
 *  resolver" as a pure-DM deployment, so returning a resolver that always resolves to nothing
 *  would be a behaviour change dressed as a refactor.
 *
 *  `resolvePin` alone is enough to build one, and that is the subtle part. Gating on CONFIG size
 *  was correct while every input was static, but a pin arrives at runtime: the ordinary deployment
 *  sets no session-channel env vars, so a config-only guard would build no resolver there, and
 *  because the gateway holds the resolver in a readonly field assigned once, every `/thread-here`
 *  pin would be written to disk and then ignored until a restart — no error, no log, nothing to
 *  notice. A resolver that answers `undefined` for everyone behaves exactly like no resolver, at
 *  the cost of one function call per new session.
 *
 *  The returned resolver re-fetches on every call by design. Caching a channel handle for the
 *  bot's lifetime means a channel that is later deleted, retyped, or made invisible keeps being
 *  handed out; re-fetching lets that degrade to the DM fallback on the next session instead. */
export function createSessionChannelResolver(
  options: SessionChannelResolverOptions,
): SessionChannelResolver | undefined {
  const { fetchParent, resolvePin, byUser, fallbackChannelId } = options;
  if (!resolvePin && !fallbackChannelId && !(byUser && byUser.size > 0)) return undefined;
  return async (discordUserId: string) => {
    const choice = chooseSessionChannel(discordUserId, {
      pin: resolvePin?.(discordUserId),
      byUser,
      fallbackChannelId,
    });
    // Either an explicit DM pin, or nothing configured for this user — the mixed deployment this
    // feature exists for, where unpinned and unlisted users belong on DMs.
    if (choice.destination === 'dm') return undefined;
    return fetchParent(choice.channelId);
  };
}
