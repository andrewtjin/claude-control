// The accounting behind the status page. Every scenario drives the recorder with an injected clock
// and a scripted gateway readiness, then reads back both the persisted file and the report the page
// renders — the file because a restart resumes from it, the report because that is what a reader
// sees. Timers are faked so a started recorder never ticks on its own unless a test advances them.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  UptimeRecorder,
  splitByUtcDay,
  startOfUtcDay,
  utcDayKey,
  type Outage,
  type UptimeStoreFile,
} from './uptime.js';

// 2026-09-15T12:00:00Z: mid-day, so a handful of ticks never crosses midnight by accident.
const T0 = Date.UTC(2026, 8, 15, 12, 0, 0);
const DAY = 86_400_000;
const SAMPLE = 30_000;
const MIN = 60_000;

describe('splitByUtcDay', () => {
  it('yields nothing for an empty or inverted interval', () => {
    expect(splitByUtcDay(T0, T0)).toEqual([]);
    expect(splitByUtcDay(T0 + 1, T0)).toEqual([]);
  });

  it('keeps an interval inside one day whole', () => {
    expect(splitByUtcDay(T0, T0 + 5 * MIN)).toEqual([{ day: '2026-09-15', ms: 5 * MIN }]);
  });

  it('splits at a UTC midnight without losing or double-counting a millisecond', () => {
    const midnight = startOfUtcDay(T0) + DAY;
    const parts = splitByUtcDay(midnight - 10_000, midnight + 20_000);
    expect(parts).toEqual([
      { day: '2026-09-15', ms: 10_000 },
      { day: '2026-09-16', ms: 20_000 },
    ]);
  });

  it('gives every intermediate day its full length', () => {
    const start = startOfUtcDay(T0) - 1000;
    const parts = splitByUtcDay(start, start + 3 * DAY);
    expect(parts.map((p) => p.day)).toEqual([
      '2026-09-14',
      '2026-09-15',
      '2026-09-16',
      '2026-09-17',
    ]);
    expect(parts.map((p) => p.ms)).toEqual([1000, DAY, DAY, DAY - 1000]);
  });

  it('an interval starting exactly at midnight belongs to the new day', () => {
    const midnight = startOfUtcDay(T0);
    expect(splitByUtcDay(midnight, midnight + 1)).toEqual([{ day: '2026-09-15', ms: 1 }]);
    expect(utcDayKey(midnight - 1)).toBe('2026-09-14');
  });
});

describe('UptimeRecorder', () => {
  let dir: string;
  let path: string;
  let now: number;
  let ready: boolean;

  const make = (overrides: Partial<ConstructorParameters<typeof UptimeRecorder>[0]> = {}) =>
    new UptimeRecorder({
      path,
      isDiscordReady: () => ready,
      clock: () => now,
      sampleMs: SAMPLE,
      windowDays: 90,
      ...overrides,
    });
  const readStore = async (): Promise<UptimeStoreFile> =>
    JSON.parse(await readFile(path, 'utf8')) as UptimeStoreFile;
  const today = (store: UptimeStoreFile) => store.days[utcDayKey(now)];
  const component = (r: UptimeRecorder, id: 'relay' | 'discord') =>
    r.report({ connectedDaemons: 0 }).components.find((c) => c.id === id)!;
  const lastDay = (r: UptimeRecorder, id: 'relay' | 'discord') => component(r, id).days.at(-1)!;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    dir = await mkdtemp(join(tmpdir(), 'cctl-uptime-'));
    path = join(dir, 'uptime.json');
    now = T0;
    ready = true;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('a first start creates a fresh history: since now, nothing attested, no outages', async () => {
    const r = make();
    await r.start();
    expect(await readStore()).toEqual({
      version: 1,
      since: T0,
      lastTick: T0,
      days: {},
      outages: [],
    });
    await r.stop();
  });

  it('each tick attests the interval since the previous one to its UTC day, per component', async () => {
    const r = make();
    await r.start();
    for (let i = 0; i < 3; i++) {
      now += SAMPLE;
      await r.tick();
    }
    expect(today(await readStore())).toEqual({ relayMs: 3 * SAMPLE, discordMs: 3 * SAMPLE });
    expect(lastDay(r, 'relay')).toEqual({ date: '2026-09-15', elapsedMs: 3 * SAMPLE, downMs: 0 });
    expect(component(r, 'relay').uptimePercent).toBe(100);
    expect(component(r, 'discord').uptimePercent).toBe(100);
  });

  it('a tick that spans midnight credits each day its own share', async () => {
    now = startOfUtcDay(T0) + DAY - 10_000;
    const r = make();
    await r.start();
    now += SAMPLE;
    await r.tick();
    const store = await readStore();
    expect(store.days['2026-09-15']).toEqual({ relayMs: 10_000, discordMs: 10_000 });
    expect(store.days['2026-09-16']).toEqual({ relayMs: 20_000, discordMs: 20_000 });
  });

  it('the report counts the not-yet-attested tail so a live process never shows phantom downtime', async () => {
    const r = make();
    await r.start();
    now += SAMPLE;
    await r.tick();
    now += 10_000;
    expect(lastDay(r, 'relay')).toEqual({
      date: '2026-09-15',
      elapsedMs: SAMPLE + 10_000,
      downMs: 0,
    });
    // The tail is credited to Discord only while the gateway is ready right now.
    ready = false;
    expect(lastDay(r, 'discord').downMs).toBe(10_000);
    expect(lastDay(r, 'relay').downMs).toBe(0);
  });

  it('a report before start is a window with no data, not an error', () => {
    const report = make().report({ connectedDaemons: 2 });
    expect(report.components.map((c) => c.id)).toEqual(['relay', 'discord']);
    expect(report.components[0]!.days).toHaveLength(90);
    expect(report.components[0]!.days.every((d) => d.elapsedMs === 0 && d.downMs === 0)).toBe(true);
    expect(report.components[0]!.uptimePercent).toBeNull();
    expect(report.overall).toBe('operational');
    expect(report.connectedDaemons).toBe(2);
    expect(report.incidents).toEqual([]);
  });

  it('elapsed time starts at `since`, so the first day is never charged for the hours before', async () => {
    // A long sample so one two-hour tick is ordinary attestation, not a stall.
    const r = make({ sampleMs: 60 * MIN });
    await r.start();
    now += 2 * 60 * MIN;
    await r.tick();
    const days = component(r, 'relay').days;
    expect(days.at(-1)).toEqual({ date: '2026-09-15', elapsedMs: 2 * 60 * MIN, downMs: 0 });
    expect(days.at(-2)).toEqual({ date: '2026-09-14', elapsedMs: 0, downMs: 0 });
    expect(days).toHaveLength(90);
  });

  it('a gateway that is not ready opens a Discord-only outage and stops crediting Discord', async () => {
    const r = make();
    await r.start();
    const t1 = (now += SAMPLE);
    await r.tick();
    ready = false;
    const t2 = (now += SAMPLE);
    await r.tick();
    let store = await readStore();
    expect(store.outages).toEqual<Outage[]>([
      { components: ['discord'], start: t1, end: null, cause: 'discord' },
    ]);
    expect(today(store)).toEqual({ relayMs: 2 * SAMPLE, discordMs: SAMPLE });
    let report = r.report({ connectedDaemons: 0 });
    expect(report.overall).toBe('degraded');
    expect(report.components[1]).toMatchObject({ id: 'discord', status: 'down' });
    expect(report.incidents[0]).toMatchObject({ cause: 'discord', end: null });

    // Back: the outage ends at the tick that saw it down, because this interval WAS credited.
    ready = true;
    now += SAMPLE;
    await r.tick();
    store = await readStore();
    expect(store.outages).toEqual<Outage[]>([
      { components: ['discord'], start: t1, end: t2, cause: 'discord' },
    ]);
    expect(today(store)).toEqual({ relayMs: 3 * SAMPLE, discordMs: 2 * SAMPLE });
    report = r.report({ connectedDaemons: 0 });
    expect(report.overall).toBe('operational');
    expect(lastDay(r, 'discord').downMs).toBe(SAMPLE);
    expect(component(r, 'discord').uptimePercent).toBeCloseTo((2 / 3) * 100, 6);
    expect(component(r, 'relay').uptimePercent).toBe(100);
  });

  it('a stall between ticks is an outage of both components and attests nothing', async () => {
    const r = make();
    await r.start();
    const t1 = (now += SAMPLE);
    await r.tick();
    const t2 = (now += 10 * MIN);
    await r.tick();
    const store = await readStore();
    expect(store.outages).toEqual<Outage[]>([
      { components: ['relay', 'discord'], start: t1, end: t2, cause: 'stalled' },
    ]);
    expect(today(store)).toEqual({ relayMs: SAMPLE, discordMs: SAMPLE });
    expect(lastDay(r, 'relay').downMs).toBe(10 * MIN);
    expect(lastDay(r, 'discord').downMs).toBe(10 * MIN);
  });

  it('a stall while the gateway is down closes the Discord outage at the last real tick and reopens it', async () => {
    const r = make();
    await r.start();
    const t1 = (now += SAMPLE);
    await r.tick();
    ready = false;
    const t2 = (now += SAMPLE);
    await r.tick();
    const t3 = (now += 10 * MIN);
    await r.tick();
    expect((await readStore()).outages).toEqual<Outage[]>([
      { components: ['discord'], start: t1, end: t2, cause: 'discord' },
      { components: ['relay', 'discord'], start: t2, end: t3, cause: 'stalled' },
      { components: ['discord'], start: t3, end: null, cause: 'discord' },
    ]);
  });

  it('a clean stop followed by a start is a planned restart, dated from the stop marker', async () => {
    const r1 = make();
    await r1.start();
    now += SAMPLE;
    await r1.tick();
    now += 5000;
    await r1.stop();
    const stopped = now;
    let store = await readStore();
    expect(store.stoppedAt).toBe(stopped);
    // The final tick attested up to the stop, so nothing before it reads as down.
    expect(today(store)).toEqual({ relayMs: SAMPLE + 5000, discordMs: SAMPLE + 5000 });

    now += 5 * MIN;
    const r2 = make();
    await r2.start();
    store = await readStore();
    expect(store.stoppedAt).toBeUndefined();
    expect(store.since).toBe(T0);
    expect(store.lastTick).toBe(now);
    expect(store.outages).toEqual<Outage[]>([
      { components: ['relay', 'discord'], start: stopped, end: now, cause: 'stopped' },
    ]);
    expect(lastDay(r2, 'relay').downMs).toBe(5 * MIN);
    await r2.stop();
  });

  it('a start with no stop marker is an unclean restart, dated from the last persisted tick', async () => {
    const r1 = make();
    await r1.start();
    const t1 = (now += SAMPLE);
    await r1.tick();
    // No stop(): the process died. Its timer is fake, so nothing fires from here on.
    now = t1 + 5 * MIN;
    const r2 = make();
    await r2.start();
    expect((await readStore()).outages).toEqual<Outage[]>([
      { components: ['relay', 'discord'], start: t1, end: now, cause: 'restart' },
    ]);
    expect(r2.report({ connectedDaemons: 0 }).incidents[0]!.cause).toBe('restart');
    await r2.stop();
  });

  it('a crash while a Discord outage was open closes it at the last tick, then adds the restart', async () => {
    const r1 = make();
    await r1.start();
    const t1 = (now += SAMPLE);
    await r1.tick();
    ready = false;
    const t2 = (now += SAMPLE);
    await r1.tick();
    now = t2 + 5 * MIN;
    ready = true;
    const r2 = make();
    await r2.start();
    expect((await readStore()).outages).toEqual<Outage[]>([
      { components: ['discord'], start: t1, end: t2, cause: 'discord' },
      { components: ['relay', 'discord'], start: t2, end: now, cause: 'restart' },
    ]);
    await r2.stop();
  });

  it('a restart with the clock behind the history records no outage and keeps going', async () => {
    const r1 = make();
    await r1.start();
    now += SAMPLE;
    await r1.tick();
    now -= 2 * SAMPLE;
    const r2 = make();
    await r2.start();
    const store = await readStore();
    expect(store.outages).toEqual([]);
    expect(store.lastTick).toBe(now);
    await r2.stop();
  });

  it('a clock step backwards between ticks skips the interval without crashing', async () => {
    const r = make();
    await r.start();
    now += SAMPLE;
    await r.tick();
    now -= MIN;
    await r.tick();
    const store = await readStore();
    expect(store.outages).toEqual([]);
    expect(store.lastTick).toBe(now);
    expect(today(store)).toEqual({ relayMs: SAMPLE, discordMs: SAMPLE });
    await r.stop();
  });

  it('history older than the window is pruned on start; the report and incidents stay inside it', async () => {
    const jan = Date.UTC(2026, 0, 1, 12);
    const seeded: UptimeStoreFile = {
      version: 1,
      since: jan,
      lastTick: jan + MIN,
      days: {
        '2026-01-01': { relayMs: MIN, discordMs: MIN },
        [utcDayKey(T0 - 89 * DAY)]: { relayMs: 1000, discordMs: 1000 },
      },
      outages: [
        { components: ['discord'], start: jan, end: jan + 1000, cause: 'discord' },
        {
          components: ['discord'],
          start: T0 - 89 * DAY,
          end: T0 - 89 * DAY + 1000,
          cause: 'discord',
        },
      ],
    };
    await writeFile(path, JSON.stringify(seeded));
    const r = make();
    await r.start();
    const store = await readStore();
    expect(Object.keys(store.days)).toEqual([utcDayKey(T0 - 89 * DAY)]);
    expect(store.outages.map((o) => o.cause)).toEqual(['discord', 'restart']);
    expect(store.outages[0]!.start).toBe(T0 - 89 * DAY);
    const report = r.report({ connectedDaemons: 0 });
    expect(report.since).toBe(jan);
    expect(report.components[0]!.days[0]!.date).toBe(utcDayKey(T0 - 89 * DAY));
    // Newest START first: the restart began back in January (it ended just now), so it sorts
    // after the outage that started inside the window.
    expect(report.incidents.map((o) => o.cause)).toEqual(['discord', 'restart']);
    expect(report.incidents[1]).toMatchObject({ start: jan + MIN, end: T0 });
    await r.stop();
  });

  it('an unparseable history is set aside and a fresh one started', async () => {
    await writeFile(path, '{not json');
    const r = make();
    await r.start();
    expect(await readStore()).toEqual({
      version: 1,
      since: T0,
      lastTick: T0,
      days: {},
      outages: [],
    });
    expect((await stat(`${path}.invalid`)).isFile()).toBe(true);
    await r.stop();
  });

  it('a history with the wrong shape is set aside too, never half-trusted', async () => {
    await writeFile(
      path,
      JSON.stringify({ version: 1, since: T0, lastTick: 'yesterday', days: {}, outages: [] }),
    );
    const r = make();
    await r.start();
    expect((await readStore()).since).toBe(T0);
    expect((await stat(`${path}.invalid`)).isFile()).toBe(true);
    await r.stop();
  });

  it('the outage list is capped, keeping the newest entries and any open one', async () => {
    const old: Outage[] = [];
    for (let i = 0; i < 199; i++) {
      old.push({
        components: ['discord'],
        start: T0 - MIN * (400 - i),
        end: T0 - MIN * (400 - i) + 1000,
        cause: 'discord',
      });
    }
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        since: T0 - DAY,
        lastTick: T0 - SAMPLE,
        days: {},
        outages: old,
      } satisfies UptimeStoreFile),
    );
    const r = make();
    await r.start(); // 199 old + 1 restart = 200
    // Down, up, down: two new Discord outages, the second still open.
    for (let i = 0; i < 3; i++) {
      ready = i % 2 === 1;
      now += SAMPLE;
      await r.tick();
    }
    const store = await readStore();
    expect(store.outages).toHaveLength(200);
    expect(store.outages.at(-1)).toMatchObject({ cause: 'discord', end: null });
    expect(store.outages.at(-2)).toMatchObject({ cause: 'discord', end: T0 + SAMPLE });
    expect(store.outages[0]!.start).toBe(old[2]!.start);
    await r.stop();
  });

  it('start() ticks on its own at the sample interval', async () => {
    const r = make();
    await r.start();
    // Observed BEFORE stop(), which would otherwise attest the same interval itself and hide a
    // timer that never fired.
    now += SAMPLE;
    await vi.advanceTimersByTimeAsync(SAMPLE);
    await vi.waitFor(async () => expect((await readStore()).lastTick).toBe(T0 + SAMPLE));
    now += SAMPLE;
    await vi.advanceTimersByTimeAsync(SAMPLE);
    await vi.waitFor(async () => expect((await readStore()).lastTick).toBe(T0 + 2 * SAMPLE));
    await r.stop();
    expect(today(await readStore())).toEqual({ relayMs: 2 * SAMPLE, discordMs: 2 * SAMPLE });
  });

  it('a stop issued right behind a tick, without awaiting it, lands both in the file', async () => {
    const r = make();
    await r.start();
    now += SAMPLE;
    await Promise.all([r.tick(), r.stop()]);
    const store = await readStore();
    expect(store.stoppedAt).toBe(now);
    expect(store.lastTick).toBe(now);
    expect(today(store)).toEqual({ relayMs: SAMPLE, discordMs: SAMPLE });
  });

  it('a stop that lands while start() is still loading leaves no timer behind', async () => {
    const r = make();
    const starting = r.start();
    await r.stop();
    await starting;
    const stopped = await readStore();
    now += 2 * SAMPLE;
    await vi.advanceTimersByTimeAsync(2 * SAMPLE);
    expect(await readStore()).toEqual(stopped);
    expect(stopped.stoppedAt).toBe(T0);
  });

  it('stop() samples the gateway like a tick, so it must run before the gateway is torn down', async () => {
    const r = make();
    await r.start();
    now += SAMPLE;
    await r.tick();
    ready = false;
    now += 5000;
    await r.stop();
    const store = await readStore();
    expect(today(store)).toEqual({ relayMs: SAMPLE + 5000, discordMs: SAMPLE });
    expect(store.outages).toEqual<Outage[]>([
      { components: ['discord'], start: T0 + SAMPLE, end: null, cause: 'discord' },
    ]);
  });

  it('a tick after a stop outdates the marker, so the next start dates the gap from the tick', async () => {
    const r1 = make();
    await r1.start();
    now += SAMPLE;
    await r1.stop();
    now += 3 * 60 * MIN;
    await r1.tick(); // a stray tick long after the stop: a stall, and the marker is gone
    let store = await readStore();
    expect(store.stoppedAt).toBeUndefined();
    expect(store.outages.map((o) => o.cause)).toEqual(['stalled']);
    now += 1000;
    const r2 = make();
    await r2.start();
    store = await readStore();
    expect(store.outages.map((o) => o.cause)).toEqual(['stalled', 'restart']);
    expect(store.outages[1]).toMatchObject({ start: now - 1000, end: now });
    await r2.stop();
  });

  it('a stop marker older than the last tick is ignored rather than fabricating an overlap', async () => {
    const seeded: UptimeStoreFile = {
      version: 1,
      since: T0 - 2 * 60 * MIN,
      lastTick: T0 - MIN,
      stoppedAt: T0 - 60 * MIN,
      days: { [utcDayKey(T0)]: { relayMs: 2 * 60 * MIN - MIN, discordMs: 2 * 60 * MIN - MIN } },
      outages: [],
    };
    await writeFile(path, JSON.stringify(seeded));
    const r = make();
    await r.start();
    expect((await readStore()).outages).toEqual<Outage[]>([
      { components: ['relay', 'discord'], start: T0 - MIN, end: T0, cause: 'restart' },
    ]);
    expect(lastDay(r, 'relay').downMs).toBe(MIN);
    await r.stop();
  });

  it('a history whose open outage is not the last entry is set aside', async () => {
    const seeded: UptimeStoreFile = {
      version: 1,
      since: T0 - DAY,
      lastTick: T0 - SAMPLE,
      days: {},
      outages: [
        { components: ['discord'], start: T0 - 30 * MIN, end: null, cause: 'discord' },
        { components: ['discord'], start: T0 - 10 * MIN, end: T0 - 8 * MIN, cause: 'discord' },
      ],
    };
    await writeFile(path, JSON.stringify(seeded));
    const r = make();
    await r.start();
    expect((await readStore()).since).toBe(T0);
    expect((await stat(`${path}.invalid`)).isFile()).toBe(true);
    await r.stop();
  });

  it('a history with an outage that ends before it starts is set aside', async () => {
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        since: T0 - DAY,
        lastTick: T0 - SAMPLE,
        days: {},
        outages: [{ components: ['relay'], start: T0, end: T0 - 1, cause: 'stalled' }],
      }),
    );
    const r = make();
    await r.start();
    expect((await readStore()).since).toBe(T0);
    await r.stop();
  });

  it('a report during a stall drops the unattested tail, so today shows the gap', async () => {
    const r = make();
    await r.start();
    now += SAMPLE;
    await r.tick();
    now += 10 * MIN;
    expect(lastDay(r, 'relay')).toEqual({
      date: '2026-09-15',
      elapsedMs: SAMPLE + 10 * MIN,
      downMs: 10 * MIN,
    });
    await r.stop();
  });

  it('a failing persist rejects the caller and leaves the queue usable', async () => {
    // A directory where the file should be: the atomic rename onto it fails every time.
    // A FILE where the state directory should be: nothing can be created beneath it, so every
    // write fails. (A directory at the file's own path would just be set aside as unreadable.)
    await writeFile(join(dir, 'blocker'), '');
    path = join(dir, 'blocker', 'uptime.json');
    const r = make();
    await expect(r.start()).rejects.toThrow();
    await expect(r.tick()).rejects.toThrow();
    await expect(r.stop()).rejects.toThrow();
    // Nothing hangs: every call above settled, each with its own rejection.
  });

  it('the report carries the live daemon count and the window parameters through unchanged', async () => {
    const r = make();
    await r.start();
    const report = r.report({ connectedDaemons: 7 });
    expect(report).toMatchObject({
      connectedDaemons: 7,
      windowDays: 90,
      sampleMs: SAMPLE,
      since: T0,
      generatedAt: T0,
    });
    expect(report.components[0]).toMatchObject({
      id: 'relay',
      name: 'Relay',
      status: 'operational',
    });
    await r.stop();
  });
});
