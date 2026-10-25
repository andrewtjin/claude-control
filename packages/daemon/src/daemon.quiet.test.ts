// Discord quiet mode on the daemon: what a phone-started session and the daemon's own notices still
// send while quiet, and the live change from the phone (`settings.quiet.set`) and the CLI
// (`POST /cli/settings/quiet`).

import { describe, it, expect, afterEach } from 'vitest';
import type { Envelope, PayloadOf, SettingsSnapshot } from '@claude-control/shared-protocol';
import type { SessionRecord } from '@claude-control/session-runtime';
import {
  createHarness,
  fakeSessionManager,
  waitFor,
  type FakeManagedHandle,
  type Harness,
} from './testing/sessionDaemonHarness.js';
import { QUIET_DROPPED_NOTICES, quietDropsNotice, type QuietControl } from './quietMode.js';
import type { QuietSetResult } from './quietMode.js';

let harness: Harness | undefined;

afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
});

/** The report the harness daemon starts with; the fake control rewrites only `quiet`. */
const REPORT: SettingsSnapshot = {
  startedAtMs: 1,
  settings: [{ name: 'discord quiet', value: 'on', source: 'default' }],
  quiet: true,
};

/** A stand-in for the composition root's control: an in-memory value, every set recorded, and
 *  an optional scripted refusal or throw in place of a save. Like the real one, a set moves the
 *  row's source to config and an unset back to default, whether or not the value moved. */
function fakeQuiet(
  initial: boolean,
  behaviour: { refuse?: QuietSetResult; throws?: boolean } = {},
): QuietControl & { value: boolean; calls: (boolean | undefined)[] } {
  const control = {
    value: initial,
    calls: [] as (boolean | undefined)[],
    isQuiet: () => control.value,
    set(value: boolean | undefined): Promise<QuietSetResult> {
      control.calls.push(value);
      if (behaviour.throws === true) return Promise.reject(new Error('disk full'));
      if (behaviour.refuse !== undefined) return Promise.resolve(behaviour.refuse);
      const next = value ?? true;
      const changed = next !== control.value;
      control.value = next;
      return Promise.resolve({
        ok: true,
        quiet: next,
        changed,
        report: {
          ...REPORT,
          settings: [
            {
              name: 'discord quiet',
              value: next ? 'on' : 'off',
              source: value === undefined ? 'default' : 'config',
            },
          ],
          quiet: next,
        },
      });
    },
  };
  return control;
}

/** Spawn a managed session from the "phone" and hand back its fake handle. */
async function spawnSession(h: Harness): Promise<FakeManagedHandle> {
  h.relay.push({
    daemonId: 'daemon-under-test',
    type: 'session.spawn',
    payload: { requestId: 'r-q', prompt: 'go', idempotencyKey: 'k-q' },
  });
  let handle: FakeManagedHandle | undefined;
  await waitFor(() => {
    handle = h.sessionManager.get('spawned-session') as FakeManagedHandle | undefined;
    return handle !== undefined;
  });
  if (handle === undefined) throw new Error('no session was spawned');
  return handle;
}

const outputs = (h: Harness): PayloadOf<'session.output'>[] =>
  h.sent.flatMap((e) => (e.type === 'session.output' ? [e.payload] : []));
const statuses = (h: Harness): string[] =>
  h.sent.flatMap((e) => (e.type === 'session.status' ? [e.payload.state] : []));
const sawStatus = (h: Harness, state: string) => () => statuses(h).includes(state);

describe('Daemon quiet mode: a phone-started session', () => {
  it('sends one message per turn — the summary — and keeps every status frame', async () => {
    harness = await createHarness({ quiet: fakeQuiet(true) });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'output', text: 'thinking out loud' });
    handle.emit({ kind: 'milestone', text: 'Tool: Bash' });
    handle.emit({ kind: 'milestone', text: 'Tool result: Bash ok' });
    handle.emit({ kind: 'milestone', text: 'Auto-continue: retrying in 5s (attempt 1/3)' });
    handle.emit({ kind: 'error', text: 'the word error in prose' });
    handle.emit({ kind: 'summary', text: 'Session complete: all done' });
    handle.emit({ kind: 'status', state: 'waiting_input' });
    await waitFor(sawStatus(h, 'waiting_input'));

    // Seq 0: dropped lines take no seq, so the bot sees no gap where nothing was lost.
    expect(outputs(h).map((o) => [o.seq, o.kind, o.text])).toEqual([
      [0, 'summary', 'Session complete: all done'],
    ]);
    // Status frames still flow: they carry thread/card setup and prompt routing.
    expect(statuses(h)).toEqual(['starting', 'running', 'waiting_input']);
  });

  it('streams the whole turn, stamped not quiet, to a bot that cannot plan quiet frames', async () => {
    harness = await createHarness({ quiet: fakeQuiet(true), botQuietFrames: false });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'output', text: 'the reply, in full' });
    handle.emit({ kind: 'summary', text: 'Session complete: the reply' });
    handle.emit({ kind: 'status', state: 'waiting_input' });
    await waitFor(sawStatus(h, 'waiting_input'));

    // That bot clamps the summary to one message: the streamed prose is where the rest lives.
    expect(outputs(h).map((o) => [o.kind, o.text, o.quiet])).toEqual([
      ['stdout', 'the reply, in full', false],
      ['summary', 'Session complete: the reply', false],
    ]);
    expect(h.sent.flatMap((e) => (e.type === 'session.status' ? [e.payload.quiet] : []))).toEqual([
      false,
      false,
      false,
    ]);
  });

  it('stamps every session frame with the quiet mode it was sent under', async () => {
    const quiet = fakeQuiet(true);
    harness = await createHarness({ quiet });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'summary', text: 'first turn' });
    await waitFor(() => outputs(h).length === 1);
    quiet.value = false;
    handle.emit({ kind: 'output', text: 'second turn prose' });
    handle.emit({ kind: 'status', state: 'waiting_input' });
    await waitFor(sawStatus(h, 'waiting_input'));

    // A frame replayed after a later change is still read under the mode that filtered it.
    expect(outputs(h).map((o) => [o.text, o.quiet])).toEqual([
      ['first turn', true],
      ['second turn prose', false],
    ]);
    const stamped = h.sent.flatMap((e) =>
      e.type === 'session.status' ? [[e.payload.state, e.payload.quiet]] : [],
    );
    expect(stamped).toEqual([
      ['starting', true],
      ['running', true],
      ['waiting_input', false],
    ]);
  });

  it('posts the error that ended a failed turn as its one outcome line, before the status', async () => {
    harness = await createHarness({ quiet: fakeQuiet(true) });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'error', text: 'an earlier prose line about an error' });
    handle.emit({ kind: 'error', text: 'Error: the API connection dropped' });
    handle.emit({ kind: 'status', state: 'failed' });
    await waitFor(sawStatus(h, 'failed'));

    expect(outputs(h).map((o) => [o.kind, o.text])).toEqual([
      ['error', 'Error: the API connection dropped'],
    ]);
    const kinds = h.sent
      .filter((e) => e.type === 'session.output' || e.type === 'session.status')
      .map((e) => e.type);
    expect(kinds.slice(-2)).toEqual(['session.output', 'session.status']);
  });

  it('posts no second line for a turn whose summary already said it failed', async () => {
    harness = await createHarness({ quiet: fakeQuiet(true) });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'error', text: 'a prose line with error in it' });
    handle.emit({ kind: 'summary', text: 'Session failed: out of budget' });
    handle.emit({ kind: 'status', state: 'failed' });
    await waitFor(sawStatus(h, 'failed'));

    expect(outputs(h).map((o) => o.text)).toEqual(['Session failed: out of budget']);
  });

  it('still posts a held failure reason when quiet mode was turned off before the turn failed', async () => {
    const quiet = fakeQuiet(true);
    harness = await createHarness({ quiet });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'error', text: 'Error: the API connection dropped' });
    quiet.value = false;
    handle.emit({ kind: 'status', state: 'failed' });
    await waitFor(sawStatus(h, 'failed'));

    // Held while quiet, so it never went out live: the failed status is its one chance.
    expect(outputs(h).map((o) => [o.kind, o.text])).toEqual([
      ['error', 'Error: the API connection dropped'],
    ]);
  });

  it('posts no stale held line after an error that went out once quiet mode was off', async () => {
    const quiet = fakeQuiet(true);
    harness = await createHarness({ quiet });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'status', state: 'running' });
    handle.emit({ kind: 'error', text: 'a prose line about an error' });
    quiet.value = false;
    handle.emit({ kind: 'error', text: 'Error: the API connection dropped' });
    handle.emit({ kind: 'status', state: 'failed' });
    await waitFor(sawStatus(h, 'failed'));

    // The phone already has this turn's reason; the older held line must not follow it.
    expect(outputs(h).map((o) => [o.kind, o.text])).toEqual([
      ['error', 'Error: the API connection dropped'],
    ]);
  });

  it('drops a held error line when the turn ends any other way', async () => {
    harness = await createHarness({ quiet: fakeQuiet(true) });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'error', text: 'prose about an error' });
    handle.emit({ kind: 'status', state: 'waiting_input' });
    handle.emit({ kind: 'status', state: 'failed' });
    await waitFor(sawStatus(h, 'failed'));

    expect(outputs(h)).toEqual([]);
  });

  it('reads the setting live: lines flow again the moment quiet is off', async () => {
    const quiet = fakeQuiet(true);
    harness = await createHarness({ quiet });
    const h = harness;
    await h.daemon.start();
    const handle = await spawnSession(h);

    handle.emit({ kind: 'milestone', text: 'Tool: Read' });
    quiet.value = false;
    handle.emit({ kind: 'milestone', text: 'Tool: Edit' });
    handle.emit({ kind: 'output', text: 'prose' });
    await waitFor(() => outputs(h).length === 2);

    expect(outputs(h).map((o) => [o.seq, o.kind, o.text])).toEqual([
      [0, 'milestone', 'Tool: Edit'],
      [1, 'stdout', 'prose'],
    ]);
  });
});

describe("Daemon quiet mode: the daemon's own notices", () => {
  /** A session parked on a usage limit when the previous run stopped: startup reports it lost. */
  function parkedOrphan(): SessionRecord {
    return {
      id: 's1',
      kind: 'managed',
      state: 'orphaned',
      startedAtMs: 1,
      parkedOnUsageLimit: true,
    };
  }
  const stallLost = (h: Harness): Envelope[] =>
    h.sent.filter(
      (e) => e.type === 'hook.notification' && e.payload.notificationType === 'usage_stall_lost',
    );

  it('keeps a fleet notice off the phone in quiet mode', async () => {
    const manager = fakeSessionManager();
    manager.recovered.push(parkedOrphan());
    harness = await createHarness({ sessionManager: manager, quiet: fakeQuiet(true) });
    const h = harness;
    await h.daemon.start();
    // A full poll cycle has run, so startup recovery is long done.
    await waitFor(() => h.sent.some((e) => e.type === 'usage.snapshot'));
    expect(stallLost(h)).toEqual([]);
  });

  it('keeps a fleet notice off the phone whatever the bot can plan', async () => {
    const manager = fakeSessionManager();
    manager.recovered.push(parkedOrphan());
    harness = await createHarness({
      sessionManager: manager,
      quiet: fakeQuiet(true),
      botQuietFrames: false,
    });
    const h = harness;
    await h.daemon.start();
    await waitFor(() => h.sent.some((e) => e.type === 'usage.snapshot'));
    expect(stallLost(h)).toEqual([]);
  });

  it('sends the same notice once quiet mode is off', async () => {
    const manager = fakeSessionManager();
    manager.recovered.push(parkedOrphan());
    harness = await createHarness({ sessionManager: manager, quiet: fakeQuiet(false) });
    const h = harness;
    await h.daemon.start();
    await waitFor(() => stallLost(h).length === 1);
  });

  it('drops exactly the fleet notices, and keeps quarantine and every reply to a /say', () => {
    const notice = (notificationType: string): PayloadOf<'hook.notification'> => ({
      event: 'notification',
      title: 't',
      body: 'b',
      level: 'info',
      notificationType,
    });
    expect([...QUIET_DROPPED_NOTICES].sort()).toEqual(
      [
        'session_moved',
        'slot_alert',
        'usage_exhausted',
        'usage_restored',
        'usage_stall_lost',
        'usage_stall_resumed',
      ].sort(),
    );
    for (const type of QUIET_DROPPED_NOTICES) expect(quietDropsNotice(notice(type))).toBe(true);
    for (const kept of [
      'quarantine',
      'steering_queued',
      'steering_delivered',
      'steering_expired',
      'steering_dropped',
      'channel_sent',
      'channel_fell_back',
      'channel_expired',
      'channel_reply',
      'some_future_notice',
    ]) {
      expect(quietDropsNotice(notice(kept))).toBe(false);
    }
    // A notice with no type at all is not a fleet notice.
    expect(quietDropsNotice({ event: 'notification', title: 't', body: 'b', level: 'info' })).toBe(
      false,
    );
  });
});

describe('Daemon quiet mode: changing it live', () => {
  const setFromPhone = (h: Harness, quiet: boolean, requestId = 'q-1'): void => {
    h.relay.push({
      daemonId: 'daemon-under-test',
      type: 'settings.quiet.set',
      payload: { requestId, quiet },
    });
  };
  const results = (h: Harness): PayloadOf<'settings.quiet.result'>[] =>
    h.sent.flatMap((e) => (e.type === 'settings.quiet.result' ? [e.payload] : []));
  const snapshots = (h: Harness): PayloadOf<'settings.snapshot'>[] =>
    h.sent.flatMap((e) => (e.type === 'settings.snapshot' ? [e.payload] : []));

  /** Start, and let the startup snapshots go out — the one that opens the connection and the first
   *  poll cycle's — so later snapshots are the change's. */
  async function started(quiet: QuietControl | undefined): Promise<Harness> {
    harness = await createHarness({
      ...(quiet !== undefined ? { quiet } : {}),
      settingsReport: REPORT,
    });
    const h = harness;
    await h.daemon.start();
    await waitFor(() => snapshots(h).length === 2);
    return h;
  }

  it('opens the connection with the settings snapshot, before any other frame', async () => {
    const h = await started(fakeQuiet(true));
    // A restarted bot holds no settings; the very first frame after the handshake gives it quiet
    // mode, so no queued or live session frame is rendered without it.
    expect(h.sent.map((e) => e.type).slice(0, 2)).toEqual(['hello', 'settings.snapshot']);
    const first = h.sent[1];
    expect(first?.type === 'settings.snapshot' && first.payload.quiet).toBe(true);
  });

  it('applies a phone change, re-sends the snapshot first, then answers the request', async () => {
    const quiet = fakeQuiet(true);
    const h = await started(quiet);
    setFromPhone(h, false);
    await waitFor(() => results(h).length === 1);

    expect(quiet.calls).toEqual([false]);
    expect(results(h)).toEqual([
      { requestId: 'q-1', ok: true, quiet: false, message: 'Quiet mode is now off.' },
    ]);
    expect(snapshots(h).map((s) => s.quiet)).toEqual([true, true, false]);
    const order = h.sent
      .filter((e) => e.type === 'settings.snapshot' || e.type === 'settings.quiet.result')
      .map((e) => e.type);
    expect(order).toEqual([
      'settings.snapshot',
      'settings.snapshot',
      'settings.snapshot',
      'settings.quiet.result',
    ]);
  });

  it('re-sends the snapshot for a repeat too, since the source moved to config', async () => {
    const h = await started(fakeQuiet(true));
    setFromPhone(h, true);
    await waitFor(() => results(h).length === 1);
    expect(results(h)[0]?.message).toBe('Quiet mode was already on.');
    expect(snapshots(h)).toHaveLength(3);
    expect(snapshots(h)[2]?.settings).toEqual([
      { name: 'discord quiet', value: 'on', source: 'config' },
    ]);
  });

  it("relays the control's refusal in its own words, leaving everything as it was", async () => {
    const message = 'CCTL_DISCORD_QUIET is set in the daemon environment';
    const h = await started(
      fakeQuiet(true, { refuse: { ok: false, quiet: true, reason: 'env_pinned', message } }),
    );
    setFromPhone(h, false);
    await waitFor(() => results(h).length === 1);
    expect(results(h)).toEqual([{ requestId: 'q-1', ok: false, quiet: true, message }]);
    expect(snapshots(h)).toHaveLength(2);
  });

  it('answers a control that throws as a failed save, never leaving the phone waiting', async () => {
    const h = await started(fakeQuiet(true, { throws: true }));
    setFromPhone(h, false);
    await waitFor(() => results(h).length === 1);
    expect(results(h)[0]).toMatchObject({ ok: false, quiet: true });
    expect(results(h)[0]?.message).toContain('could not be saved');
  });

  it('answers even when the daemon has no control at all', async () => {
    const h = await started(undefined);
    setFromPhone(h, false);
    await waitFor(() => results(h).length === 1);
    expect(results(h)[0]).toMatchObject({ ok: false, quiet: false });
  });

  it('takes a CLI change through its loopback route the same way', async () => {
    const quiet = fakeQuiet(true);
    const h = await started(quiet);
    const port = h.hookReceiver.getPort();
    const res = await fetch(`http://127.0.0.1:${port}/cli/settings/quiet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': 'shh' },
      body: JSON.stringify({ quiet: null }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, quiet: true, changed: false });
    expect(quiet.calls).toEqual([undefined]);

    await fetch(`http://127.0.0.1:${port}/cli/settings/quiet`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-claude-control-secret': 'shh' },
      body: JSON.stringify({ quiet: false }),
    });
    await waitFor(() => snapshots(h).length === 4);
    expect(snapshots(h)[3]?.quiet).toBe(false);
  });
});
