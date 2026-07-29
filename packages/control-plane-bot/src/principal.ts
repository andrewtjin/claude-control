// Namespaced surface-user ids. The relay/bindings layer (see bindings.ts) treats every user id
// as an opaque string — it never parses one, it only compares them for equality. That opacity is
// what lets this module bolt a second surface onto a store that was built assuming Discord
// snowflakes: a Slack id just has to be a string that never collides with a Discord one, and a
// Discord id must keep working unchanged (bindings.json is never migrated).
//
// The encoding: "slack:<teamId>:<userId>". Anything that does NOT start with "slack:" — in
// practice every existing Discord snowflake, plus any other id nobody thought to namespace yet —
// is grandfathered in as Discord. That is a one-way door on purpose: adding a new surface later
// means giving it its own prefix, not touching this one's contract.

/** The two segments of a Slack principal, decoded back out of its opaque string form. */
export interface SlackPrincipalParts {
  teamId: string;
  userId: string;
}

const SLACK_PREFIX = 'slack:';

/** A colon inside a segment would be indistinguishable from the field separator, so a value that
 *  contains one can never be safely encoded — Slack team/user ids are alphanumeric and never
 *  legitimately hit this, so failing loudly here (construction time) beats silently mis-parsing
 *  later (read time), where the caller has long since lost the context to explain the mismatch. */
function assertEncodable(segment: string, label: string): void {
  if (segment.length === 0) throw new Error(`${label} must not be empty`);
  if (segment.includes(':')) throw new Error(`${label} must not contain ':'`);
}

/** Build the namespaced principal the relay/bindings layer stores and compares as an opaque
 *  string. Throws instead of producing a corrupt or ambiguous encoding. */
export function slackPrincipal(teamId: string, userId: string): string {
  assertEncodable(teamId, 'teamId');
  assertEncodable(userId, 'userId');
  return `${SLACK_PREFIX}${teamId}:${userId}`;
}

/** Decode a Slack principal, or `undefined` for anything that isn't exactly one. This is the
 *  sole authority on well-formedness: wrong prefix, missing/empty segments, or extra colons all
 *  fail closed to `undefined` rather than throwing, because callers (surfaceOf, and any relay
 *  code inspecting an id of unknown origin) need to probe arbitrary strings without a try/catch
 *  at every call site. */
export function parseSlackPrincipal(id: string): SlackPrincipalParts | undefined {
  if (!id.startsWith(SLACK_PREFIX)) return undefined;
  const rest = id.slice(SLACK_PREFIX.length);
  const parts = rest.split(':');
  // Exactly two non-empty segments — a third colon (or a missing one) means the string was
  // never produced by slackPrincipal(), so it is not a Slack principal at all.
  if (parts.length !== 2) return undefined;
  const [teamId, userId] = parts;
  if (!teamId || !userId) return undefined;
  return { teamId, userId };
}

/** Which surface an opaque id belongs to. 'discord' is the default for anything that doesn't
 *  parse as a Slack principal — bare snowflakes included — which is exactly the grandfathering
 *  guarantee that lets bindings.json go untouched by this migration. */
export function surfaceOf(id: string): 'slack' | 'discord' {
  return parseSlackPrincipal(id) === undefined ? 'discord' : 'slack';
}
