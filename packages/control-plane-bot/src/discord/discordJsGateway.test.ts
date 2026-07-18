// discordJsGateway is otherwise a live boundary (see its file header): start()/deliver() make real
// Discord API calls, so it is not unit-tested. This ONE test is the deliberate exception — it
// proves the per-session-route SERIALIZATION of deliver(), which is gateway-local
// state (the promise chain + the cardMessages map) that no pure module can hold. It exercises that
// serialization through the single `protected sinkFor` seam by returning a controllable fake sink,
// so nothing here touches a real Discord connection.

import { describe, it, expect } from 'vitest';
import type { SendableChannels } from 'discord.js';
import type { Envelope } from '@claude-control/shared-protocol';
import { DiscordJsGateway } from './discordJsGateway.js';
import type { SessionRoute } from './sessionPlanner.js';
import type { RelaySender } from '../relay.js';
import type { PairingService } from '../pairing.js';

/** A fake message whose `edit` is observable — a real card edit must land HERE, not become a
 *  second send. */
class FakeMessage {
  editCount = 0;
  edit(_payload: unknown): Promise<void> {
    this.editCount += 1;
    return Promise.resolve();
  }
}

/** A fake sendable channel: records every send and (optionally) gates the FIRST send on a promise
 *  the test releases, so the interleaving that used to double-post a card can be forced
 *  deterministically. Every send returns the SAME message, mirroring one live card per route. */
class FakeSink {
  readonly sends: unknown[] = [];
  readonly message = new FakeMessage();
  private release: (() => void) | undefined;
  private readonly gate = new Promise<void>((r) => {
    this.release = r;
  });
  gateFirstSend = false;

  releaseGate(): void {
    this.release?.();
  }

  async send(payload: unknown): Promise<FakeMessage> {
    this.sends.push(payload);
    if (this.gateFirstSend && this.sends.length === 1) await this.gate;
    return this.message;
  }
}

/** DiscordJsGateway with its one testable seam (sinkFor) redirected to a fake sink. */
class TestGateway extends DiscordJsGateway {
  testSink: FakeSink | undefined;
  protected override sinkFor(_route: SessionRoute): Promise<SendableChannels | undefined> {
    return Promise.resolve(this.testSink as unknown as SendableChannels);
  }
}

const stubRelay = {
  sendToUser: () => ({ ok: true }),
  isOnline: () => true,
} as unknown as RelaySender;
const stubPairing = {} as unknown as PairingService;

function envelope(type: Envelope['type'], payload: unknown): Envelope {
  return { v: 1, id: 'id-1', ts: 0, daemonId: 'd1', type, payload } as Envelope;
}

/** Flush the microtask/macrotask queue so chained deliveries can advance to their next await. */
function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

describe('DiscordJsGateway — per-session delivery is serialized', () => {
  it('two concurrently-delivered frames for one session produce ONE card send, then an edit', async () => {
    const gw = new TestGateway({ relay: stubRelay, pairing: stubPairing });
    const sink = new FakeSink();
    sink.gateFirstSend = true; // hold the card send in flight to force the interleaving
    gw.testSink = sink;

    // Fire both frames for the SAME session without awaiting the first (exactly how relay.ts calls
    // deliver from its un-awaited socket handler): status 'running' creates the card, 'done' edits.
    const pA = gw.deliver('u1', envelope('session.status', { sessionId: 's1', state: 'running' }));
    const pB = gw.deliver(
      'u1',
      envelope('session.status', { sessionId: 's1', state: 'done', summary: 'ok' }),
    );

    // With the card send parked, the SECOND frame must not have run yet — its edit is chained behind
    // the first delivery, not racing it. Before the fix it would already have re-anchored a DUPLICATE
    // card here (sends.length ≥ 2).
    await tick();
    expect(sink.sends.length).toBe(1);

    sink.releaseGate();
    await Promise.all([pA, pB]);

    // The terminal edit found the remembered card and edited it in place; the only other send is the
    // standalone summary line — never a duplicate card.
    expect(sink.message.editCount).toBe(1);
    expect(sink.sends.length).toBe(2); // [card send, summary line send]
  });
});
