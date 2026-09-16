// Self-recorded availability for the relay, behind the status page served at `/`.
//
// The relay is its own monitor. Every sample the process attests to the time that elapsed since its
// previous tick, attributed to the UTC day it fell in, and persists the running totals to
// uptime.json on the bot's state volume. A day's availability is then attested time over elapsed
// time. Downtime is never estimated from the inside; it is exactly what the process could NOT vouch
// for: the interval between a shutdown and the next start (a clean stop leaves a `stoppedAt` marker,
// a crash leaves only the last tick it managed to persist), and any inter-tick gap long enough to
// mean the event loop was not running (a stall, a suspended host). The Discord gateway's readiness
// is sampled on the same tick, so a dropped gateway shows as a Discord-only outage while the relay
// keeps serving daemons.
//
// Two limits follow from the design, both erring toward reporting MORE downtime, never less: a
// crash costs up to one sample of over-counted downtime (the last persisted tick is the last moment
// the process can vouch for), and the process cannot render its own total outage (deploy/Caddyfile
// answers `/` with a static page while the container is down).

import { rename } from 'node:fs/promises';
import { atomicWriteFile, readJsonIfExists } from './fsutil.js';
import type { Logger } from './logger.js';
import { noopLogger } from './logger.js';

export type ComponentId = 'relay' | 'discord';

/** How an outage was detected. Drives the incident title on the page:
 *  - `stopped`: a clean shutdown (SIGTERM) followed by a start; a deploy or a restart.
 *  - `restart`: a start with no shutdown marker; the process died, or the host did.
 *  - `stalled`: two ticks further apart than the stall threshold; the event loop was not running.
 *  - `discord`: the relay stayed up but the Discord gateway was not ready. */
export type OutageCause = 'stopped' | 'restart' | 'stalled' | 'discord';

export interface Outage {
  /** A process outage takes both components down; a gateway drop lists `discord` alone. */
  components: ComponentId[];
  /** Epoch ms. */
  start: number;
  /** Epoch ms, or null while the outage is ongoing (only a `discord` outage can be open). */
  end: number | null;
  cause: OutageCause;
}

/** Attested milliseconds per component within one UTC day. Never more than the day's length. */
interface DayTotals {
  relayMs: number;
  discordMs: number;
}

/** On-disk shape of uptime.json. Versioned so a later layout can migrate instead of guessing. */
export interface UptimeStoreFile {
  version: 1;
  /** Epoch ms of the first tick ever recorded; days before it carry no data, not downtime. */
  since: number;
  /** Epoch ms of the last tick persisted; the interval up to here is attested. */
  lastTick: number;
  /** Set by a clean shutdown, removed on the next start; its presence names the outage `stopped`. */
  stoppedAt?: number;
  /** Keyed by UTC date (`YYYY-MM-DD`). Pruned to the window on every write. */
  days: Record<string, DayTotals>;
  /** Oldest first; an open outage, if any, is always the last entry. Pruned with the days. */
  outages: Outage[];
}

export type ComponentStatus = 'operational' | 'down';

export interface DayAvailability {
  /** UTC date, `YYYY-MM-DD`. */
  date: string;
  /** Milliseconds of the day the tracker was in a position to observe (0 before `since`). */
  elapsedMs: number;
  /** Milliseconds of that span the component was NOT attested up. */
  downMs: number;
}

export interface ComponentReport {
  id: ComponentId;
  name: string;
  description: string;
  status: ComponentStatus;
  /** Over the whole window; null when nothing has been observed yet. */
  uptimePercent: number | null;
  /** Oldest first, exactly `windowDays` entries. */
  days: DayAvailability[];
}

/** What `GET /api/status` returns; the page renders it verbatim. */
export interface StatusReport {
  generatedAt: number;
  since: number;
  windowDays: number;
  sampleMs: number;
  /** `degraded` when any component is down. A total outage never reaches this code path. */
  overall: 'operational' | 'degraded';
  /** Live count of authenticated daemon sockets, supplied by the relay. A count, never identities. */
  connectedDaemons: number;
  components: ComponentReport[];
  /** Outages inside the window, newest first. */
  incidents: Outage[];
}

export interface UptimeRecorderOptions {
  /** Where uptime.json lives; the bot's state directory, so it survives a redeploy. */
  path: string;
  /** Sampled on every tick. Must reflect the gateway NOW, not whether it was ever ready. */
  isDiscordReady: () => boolean;
  logger?: Logger;
  clock?: () => number;
  /** Tick interval; also the resolution of every duration this module reports. */
  sampleMs?: number;
  /** How many UTC days the page shows and the file keeps. */
  windowDays?: number;
}

export const DEFAULT_SAMPLE_MS = 30_000;
export const DEFAULT_WINDOW_DAYS = 90;
// A gap of more than this many samples between consecutive ticks is a stall, not timer jitter: the
// interval is recorded as an outage instead of attested. Three samples leaves ample room for a busy
// event loop (a slow disk on a small droplet) while still catching a suspended host.
const STALL_SAMPLES = 3;
// Bound on the outage list so a gateway that flaps every tick for a day cannot grow the file without
// limit; the newest entries win because the page shows recent incidents.
const MAX_OUTAGES = 200;
const DAY_MS = 86_400_000;

export const COMPONENT_NAMES: Record<ComponentId, { name: string; description: string }> = {
  relay: { name: 'Relay', description: 'daemon WebSocket and HTTPS endpoint' },
  discord: { name: 'Discord gateway', description: 'the bot’s connection to Discord' },
};

/** UTC calendar day of an epoch-ms instant, as `YYYY-MM-DD`. */
export function utcDayKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Epoch ms of the UTC midnight that starts the day containing `ms`. Epoch 0 is itself a UTC
 *  midnight, so this is plain integer division; no Date arithmetic, no timezone. */
export function startOfUtcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

/** Split the interval [start, end) at UTC midnights, yielding the milliseconds that land in each
 *  day. An empty or inverted interval yields nothing. Exported for its own tests: the accounting's
 *  correctness rests on this never dropping or double-counting a millisecond across a boundary. */
export function splitByUtcDay(start: number, end: number): Array<{ day: string; ms: number }> {
  const parts: Array<{ day: string; ms: number }> = [];
  let cursor = start;
  while (cursor < end) {
    const next = Math.min(startOfUtcDay(cursor) + DAY_MS, end);
    parts.push({ day: utcDayKey(cursor), ms: next - cursor });
    cursor = next;
  }
  return parts;
}

function freshStore(now: number): UptimeStoreFile {
  return { version: 1, since: now, lastTick: now, days: {}, outages: [] };
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** Structural check on a loaded file. Anything that does not match is treated as absent (with the
 *  file set aside) rather than repaired in place: a half-understood history would report downtime
 *  that never happened, and the cost of starting over is a shorter graph, not a lost credential. */
function isStoreFile(v: unknown): v is UptimeStoreFile {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Record<string, unknown>;
  if (f.version !== 1 || !isFiniteNumber(f.since) || !isFiniteNumber(f.lastTick)) return false;
  if (f.stoppedAt !== undefined && !isFiniteNumber(f.stoppedAt)) return false;
  if (typeof f.days !== 'object' || f.days === null || Array.isArray(f.days)) return false;
  for (const totals of Object.values(f.days as Record<string, unknown>)) {
    if (typeof totals !== 'object' || totals === null) return false;
    const t = totals as Record<string, unknown>;
    if (!isFiniteNumber(t.relayMs) || !isFiniteNumber(t.discordMs)) return false;
  }
  if (!Array.isArray(f.outages)) return false;
  for (const o of f.outages as unknown[]) {
    if (typeof o !== 'object' || o === null) return false;
    const x = o as Record<string, unknown>;
    if (!Array.isArray(x.components) || !isFiniteNumber(x.start)) return false;
    if (x.end !== null && !isFiniteNumber(x.end)) return false;
    if (!['stopped', 'restart', 'stalled', 'discord'].includes(x.cause as string)) return false;
  }
  return true;
}

function openOutage(store: UptimeStoreFile): Outage | undefined {
  const last = store.outages[store.outages.length - 1];
  return last && last.end === null ? last : undefined;
}

/** Close the open outage (if any) at `at`. An outage that would end where it began never happened
 *  from the reader's point of view, so it is dropped rather than shown as a zero-length incident. */
function closeOpenOutage(store: UptimeStoreFile, at: number): void {
  const open = openOutage(store);
  if (!open) return;
  if (at <= open.start) store.outages.pop();
  else open.end = at;
}

export class UptimeRecorder {
  private readonly path: string;
  private readonly isDiscordReady: () => boolean;
  private readonly logger: Logger;
  private readonly clock: () => number;
  private readonly sampleMs: number;
  private readonly windowDays: number;
  private readonly stallMs: number;
  private store: UptimeStoreFile | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;
  // Every mutation runs through this chain so the interval's tick and a shutdown's final tick can
  // never interleave their read-modify-write of the store and the file.
  private queue: Promise<void> = Promise.resolve();

  constructor(options: UptimeRecorderOptions) {
    this.path = options.path;
    this.isDiscordReady = options.isDiscordReady;
    this.logger = options.logger ?? noopLogger;
    this.clock = options.clock ?? Date.now;
    this.sampleMs = options.sampleMs ?? DEFAULT_SAMPLE_MS;
    this.windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
    this.stallMs = this.sampleMs * STALL_SAMPLES;
  }

  /** Load (or create) the history, record the outage that ended just now if there was a previous
   *  run, and begin ticking. Call once the process is genuinely serving: from here on, elapsed time
   *  counts against availability. */
  async start(): Promise<void> {
    await this.enqueue(async () => {
      const now = this.clock();
      const loaded = await this.load();
      this.store = loaded ? this.resume(loaded, now) : freshStore(now);
      this.prune(this.store, now);
      await this.persist(this.store);
    });
    this.timer = setInterval(() => {
      this.tick().catch((err: unknown) => {
        this.logger.warn({ err }, 'uptime: tick failed');
      });
    }, this.sampleMs);
  }

  /** Attest the interval since the previous tick and persist. Public so tests drive the accounting
   *  with an injected clock instead of real timers. */
  async tick(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.store) return;
      const now = this.clock();
      this.account(this.store, now);
      this.prune(this.store, now);
      await this.persist(this.store);
    });
  }

  /** Final tick plus the clean-shutdown marker, so the next start can name the gap `stopped` and
   *  date it precisely instead of from the last periodic tick. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.enqueue(async () => {
      if (!this.store) return;
      const now = this.clock();
      this.account(this.store, now);
      this.store.stoppedAt = now;
      this.prune(this.store, now);
      await this.persist(this.store);
    });
  }

  /** Build the report the page renders. Safe to call before `start()` (the few hundred ms between
   *  the relay listening and the gateway logging in): it then shows a window with no data. */
  report(live: { connectedDaemons: number }, now: number = this.clock()): StatusReport {
    const store = this.store ?? freshStore(now);
    const ready = this.isDiscordReady();
    const firstDay = startOfUtcDay(now) - (this.windowDays - 1) * DAY_MS;
    // The tail since the last tick is not attested yet but the process is plainly alive (it is
    // answering this request), so count it, for Discord only while the gateway is ready right now.
    // Without this, every report would show up to one sample of phantom downtime for today.
    const pending = now - store.lastTick <= this.stallMs ? splitByUtcDay(store.lastTick, now) : [];
    const pendingByDay = new Map(pending.map((p) => [p.day, p.ms]));

    const build = (id: ComponentId): ComponentReport => {
      const days: DayAvailability[] = [];
      let elapsedTotal = 0;
      let downTotal = 0;
      for (let i = 0; i < this.windowDays; i++) {
        const dayStart = firstDay + i * DAY_MS;
        const date = utcDayKey(dayStart);
        const elapsedMs = Math.max(
          0,
          Math.min(dayStart + DAY_MS, now) - Math.max(dayStart, store.since),
        );
        const totals = store.days[date];
        const attested = id === 'relay' ? (totals?.relayMs ?? 0) : (totals?.discordMs ?? 0);
        const tail = id === 'relay' || ready ? (pendingByDay.get(date) ?? 0) : 0;
        // Clamped both ways: attested time can slightly exceed elapsed after a clock step.
        const downMs = Math.min(elapsedMs, Math.max(0, elapsedMs - attested - tail));
        days.push({ date, elapsedMs, downMs });
        elapsedTotal += elapsedMs;
        downTotal += downMs;
      }
      return {
        id,
        ...COMPONENT_NAMES[id],
        status: id === 'relay' || ready ? 'operational' : 'down',
        uptimePercent: elapsedTotal > 0 ? (1 - downTotal / elapsedTotal) * 100 : null,
        days,
      };
    };

    const components = [build('relay'), build('discord')];
    const incidents = store.outages
      .filter((o) => (o.end ?? now) >= firstDay)
      .map((o) => ({ ...o, components: [...o.components] }))
      .sort((a, b) => b.start - a.start);
    return {
      generatedAt: now,
      since: store.since,
      windowDays: this.windowDays,
      sampleMs: this.sampleMs,
      overall: components.every((c) => c.status === 'operational') ? 'operational' : 'degraded',
      connectedDaemons: live.connectedDaemons,
      components,
      incidents,
    };
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.queue.then(op);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The persisted history, or undefined when there is none. A file that is not JSON, or is JSON
   *  of another shape, counts as none: it is set aside under `.invalid` for a human to look at
   *  and a fresh history takes its path. `readJsonIfExists` rather than the forgiving variant on
   *  purpose, so a damaged file is noticed and kept instead of silently overwritten. */
  private async load(): Promise<UptimeStoreFile | undefined> {
    let raw: unknown;
    try {
      raw = await readJsonIfExists<unknown>(this.path);
    } catch (err) {
      await this.setAside('uptime: history is not valid JSON; starting over', err);
      return undefined;
    }
    if (raw === undefined) return undefined;
    if (isStoreFile(raw)) return raw;
    await this.setAside('uptime: history has an unexpected shape; starting over');
    return undefined;
  }

  private async setAside(reason: string, err?: unknown): Promise<void> {
    const aside = `${this.path}.invalid`;
    this.logger.warn({ err, path: this.path, aside }, reason);
    try {
      await rename(this.path, aside);
    } catch (renameErr) {
      this.logger.warn({ err: renameErr }, 'uptime: could not set the unreadable history aside');
    }
  }

  /** Continue a persisted history: everything between the previous run's last vouched-for instant
   *  and now is an outage of both components. Zero-length or negative (clock stepped back) gaps
   *  record nothing, since there is nothing honest to say about them. */
  private resume(file: UptimeStoreFile, now: number): UptimeStoreFile {
    const downSince = file.stoppedAt ?? file.lastTick;
    const cause: OutageCause = file.stoppedAt === undefined ? 'restart' : 'stopped';
    const store: UptimeStoreFile = {
      version: 1,
      since: file.since,
      lastTick: now,
      days: file.days,
      outages: file.outages,
    };
    if (now > downSince) {
      closeOpenOutage(store, downSince);
      store.outages.push({ components: ['relay', 'discord'], start: downSince, end: now, cause });
    } else {
      this.logger.warn({ downSince, now }, 'uptime: clock is behind the history; gap not recorded');
    }
    return store;
  }

  /** The accounting step shared by tick() and stop(): attest [lastTick, now) or record it as a
   *  stall, then reconcile the Discord outage state against the gateway's readiness right now. */
  private account(store: UptimeStoreFile, now: number): void {
    const prev = store.lastTick;
    if (now < prev) {
      this.logger.warn({ prev, now }, 'uptime: clock stepped backwards; interval skipped');
      store.lastTick = now;
      return;
    }
    const ready = this.isDiscordReady();
    const stalled = now - prev > this.stallMs;
    if (stalled) {
      // The process was not running its timers; nothing in the gap can be attested, and a
      // gateway outage that was open cannot be said to have lasted past the last real tick.
      closeOpenOutage(store, prev);
      store.outages.push({
        components: ['relay', 'discord'],
        start: prev,
        end: now,
        cause: 'stalled',
      });
    } else {
      for (const { day, ms } of splitByUtcDay(prev, now)) {
        const totals = store.days[day] ?? (store.days[day] = { relayMs: 0, discordMs: 0 });
        totals.relayMs += ms;
        if (ready) totals.discordMs += ms;
      }
    }
    const open = openOutage(store);
    if (!ready && !open) {
      // The un-attested Discord time began at the previous tick (this interval was not credited
      // to it), or right now if the interval was a stall already recorded against both components.
      store.outages.push({
        components: ['discord'],
        start: stalled ? now : prev,
        end: null,
        cause: 'discord',
      });
    } else if (ready && open) {
      // This interval WAS credited to Discord, so the outage ended at its start, not at `now`.
      closeOpenOutage(store, prev);
    }
    store.lastTick = now;
  }

  private prune(store: UptimeStoreFile, now: number): void {
    const cutoff = startOfUtcDay(now) - (this.windowDays - 1) * DAY_MS;
    const cutoffKey = utcDayKey(cutoff);
    for (const key of Object.keys(store.days)) {
      if (key < cutoffKey) delete store.days[key];
    }
    store.outages = store.outages.filter((o) => (o.end ?? now) >= cutoff);
    if (store.outages.length > MAX_OUTAGES) store.outages = store.outages.slice(-MAX_OUTAGES);
  }

  private async persist(store: UptimeStoreFile): Promise<void> {
    await atomicWriteFile(this.path, JSON.stringify(store));
  }
}
