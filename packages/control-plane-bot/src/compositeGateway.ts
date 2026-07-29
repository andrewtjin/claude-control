// Fans the single DiscordGateway seam RelayServer depends on out across however many chat
// surfaces are actually configured, keyed by surfaceOf() on the target principal.
//
// WHY a composite rather than RelayServer learning about two gateways: RelayServer's whole
// contract with the outside world is "here is ONE thing that can deliver to a user" (see
// relay.ts) — that seam is what keeps it testable with a bare fake and ignorant of which chat
// platforms exist. Concentrating the surface switch here, instead of threading an `if (slack)`
// through relay.ts and bin.ts, means a third surface later is one more constructor branch in
// this file, not a change to the tested relay core.

import type { Envelope } from '@claude-control/shared-protocol';
import type { DiscordGateway } from './discord/gateway.js';
import { surfaceOf } from './principal.js';
import type { Logger } from './logger.js';

/** The gateway contract this file routes onto — DiscordGateway plus the process-lifecycle
 *  methods bin.ts drives directly (listen/shutdown). Both DiscordJsGateway and SlackGateway
 *  already shape-match this; kept as a local interface (rather than importing either
 *  implementation) so this module stays a pure router with no dependency on which surfaces
 *  actually exist. */
export interface StartableGateway extends DiscordGateway {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Constructor options: each surface is optional because a deployment may run Discord only,
 *  Slack only, or (eventually) both — bin.ts decides which gateways exist from env vars and
 *  hands in only the ones it built. */
export interface CompositeGatewayOptions {
  discord?: StartableGateway;
  slack?: StartableGateway;
  logger: Logger;
}

/** Routes deliver()/sendPrimer() to the gateway matching the target principal's surface, and
 *  fans start()/stop() out to every configured gateway. This is the ONLY gateway RelayServer
 *  and bin.ts see once construction is done — see the file header for why. */
export class CompositeGateway implements StartableGateway {
  private readonly discord: StartableGateway | undefined;
  private readonly slack: StartableGateway | undefined;
  private readonly logger: Logger;

  constructor(options: CompositeGatewayOptions) {
    this.discord = options.discord;
    this.slack = options.slack;
    this.logger = options.logger;
  }

  /** Resolve the gateway for an id's surface, or undefined if that surface has no configured
   *  gateway — e.g. a Slack principal survives in bindings.json after SLACK_BOT_TOKEN is
   *  unset for this run. Centralized here so deliver() and sendPrimer() apply the identical
   *  routing + drop rule instead of duplicating it. */
  private gatewayFor(id: string): StartableGateway | undefined {
    return surfaceOf(id) === 'slack' ? this.slack : this.discord;
  }

  /** Never throws: the relay's push paths (daemon → user) are fire-and-forget, so a stale or
   *  unconfigured binding must degrade to a dropped message + a log line, never an unhandled
   *  rejection that could take down the relay's event loop. */
  deliver(id: string, envelope: Envelope): void | Promise<void> {
    const gateway = this.gatewayFor(id);
    if (!gateway) {
      this.logger.warn(
        { id, surface: surfaceOf(id) },
        'dropping envelope: surface has no configured gateway',
      );
      return;
    }
    return gateway.deliver(id, envelope);
  }

  /** Same drop-not-throw contract as deliver() — the primer is a best-effort courtesy DM sent
   *  right after pairing, and the caller (relay.ts) already never blocks pairing success on it. */
  sendPrimer(id: string): void | Promise<void> {
    const gateway = this.gatewayFor(id);
    if (!gateway) {
      this.logger.warn(
        { id, surface: surfaceOf(id) },
        'dropping primer: surface has no configured gateway',
      );
      return;
    }
    return gateway.sendPrimer(id);
  }

  /** Starts whichever gateways are configured. Left sequential (not Promise.all) so a failure
   *  on the first surface fails fast instead of leaving the second half-started with no clear
   *  owner of the failure — unlike stop(), there is no "best effort" case for startup. */
  async start(): Promise<void> {
    if (this.discord) await this.discord.start();
    if (this.slack) await this.slack.start();
  }

  /** Attempts every configured gateway's stop even if one rejects — shutdown must not strand a
   *  second surface's sockets open just because the first surface's teardown threw. Uses
   *  allSettled and rethrows the first failure only after every gateway has been given the
   *  chance to close. */
  async stop(): Promise<void> {
    const gateways = [this.discord, this.slack].filter(
      (gateway): gateway is StartableGateway => gateway !== undefined,
    );
    const results = await Promise.allSettled(gateways.map((gateway) => gateway.stop()));
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }
}
