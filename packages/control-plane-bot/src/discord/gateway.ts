// The narrow surface the relay needs from Discord: deliver one envelope to one user.
//
// Kept as an interface — not a discord.js dependency — so RelayServer (and anything that
// composes it) is unit-tested with a bare fake, and the real discord.js wiring lives
// entirely in discordJsGateway.ts, which stays out of headless unit tests (it drives the real Discord API).

import type { Envelope } from '@claude-control/shared-protocol';

export interface DiscordGateway {
  /** Deliver a daemon-originated envelope to the Discord user it belongs to (e.g. DM the
   *  user, render an embed, resolve a pending interaction). */
  deliver(discordUserId: string, envelope: Envelope): void | Promise<void>;

  /** DM a first-run primer to a user immediately after their daemon successfully claims a
   *  pairing code — the one moment the relay knows binding is complete and the user has
   *  nothing on their phone yet to tell them what to try. Lists only commands that actually
   *  do something today; the caller (relay.ts) never blocks pairing on this succeeding. */
  sendPrimer(discordUserId: string): void | Promise<void>;
}
