// Protocol version negotiation.
//
// The daemon and bot are versioned independently and deployed at different times, so
// every persistent socket negotiates a wire version on connect. Policy (per plan §ops):
// support the current version N and the previous N-1, so a daemon and bot that are one
// release apart still interoperate. Anything older is refused loudly rather than
// silently mis-parsed.

/** The version this build speaks and stamps onto every outbound envelope. */
export const PROTOCOL_VERSION = 1 as const;

/** Oldest wire version this build can still parse. Bump in lockstep with breaking changes. */
export const MIN_SUPPORTED_VERSION = 1 as const;

/**
 * Given the version a peer announced, return the highest version both sides can speak,
 * or `null` if there is no overlap (the connection must be refused).
 *
 * A newer peer is downgraded to our version (we cannot speak what we do not know); an
 * older-but-supported peer is met at its own version; anything below the floor fails.
 */
export function negotiateVersion(peerVersion: number): number | null {
  if (!Number.isInteger(peerVersion) || peerVersion < 1) return null;
  if (peerVersion >= PROTOCOL_VERSION) return PROTOCOL_VERSION;
  if (peerVersion >= MIN_SUPPORTED_VERSION) return peerVersion;
  return null;
}
