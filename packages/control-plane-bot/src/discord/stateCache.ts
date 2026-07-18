// Per-Discord-user cache of the daemon's last-known state.
//
// The relay is a stateless pass-through with no memory of what it has forwarded, but a few
// commands (/usage, /accounts, /sessions, /status) need something to answer with even when
// no fresh push just arrived. This cache is fed by DiscordGateway.deliver() on every
// daemon-originated envelope and read by the command handlers — it never influences routing
// or authorization (BindingStore alone does that), only what gets displayed.

import {
  isType,
  type AccountUsage,
  type Envelope,
  type PayloadOf,
  type UsagePlan,
} from '@claude-control/shared-protocol';

export type SessionStatus = PayloadOf<'session.status'>;

interface UsageState {
  accounts: AccountUsage[];
  plan?: UsagePlan;
}

interface UserState {
  usage?: UsageState;
  /** The daemon's effective-settings report; a new push overwrites (a daemon restart may
   *  legitimately carry different flags). */
  settings?: PayloadOf<'settings.snapshot'>;
  /** Latest status per session id; a new session.status push for the same id overwrites it. */
  sessions: Map<string, SessionStatus>;
}

export class DaemonStateCache {
  private readonly byUser = new Map<string, UserState>();

  /** Feed one delivered envelope into the cache. A no-op for types this cache doesn't track
   *  (e.g. session.output, hook.notification) — those are display-only pushes, not state
   *  worth remembering for a later `/usage`-style read. */
  record(discordUserId: string, envelope: Envelope): void {
    const state = this.stateFor(discordUserId);
    if (isType(envelope, 'usage.snapshot')) {
      const usage: UsageState = { accounts: envelope.payload.accounts };
      // Only set `plan` when one was actually sent — exactOptionalPropertyTypes forbids an
      // explicit `plan: undefined`, and a snapshot without a computed plan is common (the
      // daemon may not have run the advisor yet).
      if (envelope.payload.plan !== undefined && envelope.payload.plan !== null) {
        usage.plan = envelope.payload.plan;
      }
      state.usage = usage;
    } else if (isType(envelope, 'settings.snapshot')) {
      state.settings = envelope.payload;
    } else if (isType(envelope, 'session.status')) {
      state.sessions.set(envelope.payload.sessionId, envelope.payload);
    } else if (isType(envelope, 'session.prune.result')) {
      // The daemon names exactly what its registry dropped; mirror the removal so `/sessions`
      // stops showing rows that no longer exist anywhere. Ids this cache never saw are no-ops.
      for (const sessionId of envelope.payload.prunedSessionIds) {
        state.sessions.delete(sessionId);
      }
    }
  }

  getSettings(discordUserId: string): PayloadOf<'settings.snapshot'> | undefined {
    return this.byUser.get(discordUserId)?.settings;
  }

  getUsage(discordUserId: string): UsageState | undefined {
    return this.byUser.get(discordUserId)?.usage;
  }

  getSessions(discordUserId: string): SessionStatus[] {
    return [...(this.byUser.get(discordUserId)?.sessions.values() ?? [])];
  }

  private stateFor(discordUserId: string): UserState {
    let state = this.byUser.get(discordUserId);
    if (!state) {
      state = { sessions: new Map() };
      this.byUser.set(discordUserId, state);
    }
    return state;
  }
}
