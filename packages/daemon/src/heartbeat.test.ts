import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HeartbeatWriter,
  readHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_STALE_AFTER_MS,
} from './heartbeat.js';

/** Writes aimed at {@link gatedPath} park here instead of reaching the disk, newest last; every
 *  other target goes through the real atomic writer, so the rest of this file still exercises
 *  real files. Ordering between two beats in flight at once is set by disk timing, which no test
 *  can steer — parking them is the only way to settle a pair in a chosen order and assert what
 *  the writer guarantees regardless of it. */
const parkedWrites: Array<{ data: string; land: () => void }> = [];
/** The order payloads actually reached the file, newest last. */
const landedWrites: string[] = [];
/** The heartbeat file's on-disk shape, named so a parsed payload is compared as a real type
 *  rather than as `any`. */
interface HeartbeatFileShape {
  writtenAtMs: number;
}
let gatedPath: string | undefined;

vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return {
    ...actual,
    atomicWriteFile: (target: string, data: string | Buffer): Promise<void> => {
      if (gatedPath === undefined || target !== gatedPath)
        return actual.atomicWriteFile(target, data);
      return new Promise<void>((resolve) => {
        const payload = typeof data === 'string' ? data : data.toString('utf8');
        parkedWrites.push({
          data: payload,
          land: () => {
            landedWrites.push(payload);
            resolve();
          },
        });
      });
    },
  };
});

describe('HeartbeatWriter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-heartbeat-'));
    filePath = join(dir, 'daemon-heartbeat.json');
    // Nothing is gated unless a test opts in by naming its own path; the shared arrays are
    // cleared here so one test's parked writes can never be read by the next.
    gatedPath = undefined;
    parkedWrites.length = 0;
    landedWrites.length = 0;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes immediately on start()', async () => {
    const writer = new HeartbeatWriter(filePath, { clock: () => 1000 });
    writer.start();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ writtenAtMs: 1000 });
    });
    writer.stop();
  });

  it('writes again every intervalMs while running', async () => {
    let now = 1000;
    const writer = new HeartbeatWriter(filePath, { intervalMs: 100, clock: () => now });
    writer.start();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ writtenAtMs: 1000 });
    });
    now = 2000;
    await vi.advanceTimersByTimeAsync(100);
    // The tick's fs write is real async work fake timers don't cover — without lining up
    // behind it, this read can catch the write mid-flight and see the previous beat.
    await writer.flush();
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ writtenAtMs: 2000 });
    writer.stop();
  });

  it('never starts a second beat while one is still in flight', async () => {
    gatedPath = join(dir, 'gated-heartbeat.json');
    let now = 1000;
    const writer = new HeartbeatWriter(gatedPath, { intervalMs: 100, clock: () => now });
    writer.start();
    await vi.advanceTimersByTimeAsync(0); // let the immediate beat reach the writer
    expect(parkedWrites).toHaveLength(1); // ...and sit there, still unwritten

    now = 2000;
    await vi.advanceTimersByTimeAsync(100);
    // The tick's beat waits its turn rather than racing the one already in flight. Two writes
    // outstanding at once is the whole defect: whichever rename lands last wins, so an older
    // beat can overwrite a newer one and report the daemon as staler than it is.
    expect(parkedWrites).toHaveLength(1);

    // Settle the first; only then does the second start, and it carries its OWN tick's stamp
    // rather than the time the disk freed up.
    parkedWrites[0]?.land();
    await vi.advanceTimersByTimeAsync(0);
    expect(parkedWrites).toHaveLength(2);
    now = 9999; // a later clock must not reach the file — the beat was stamped at its tick
    parkedWrites[1]?.land();

    await writer.flush();
    writer.stop();
    expect(landedWrites.map((d) => JSON.parse(d) as HeartbeatFileShape)).toEqual([
      { writtenAtMs: 1000 },
      { writtenAtMs: 2000 },
    ]);
  });

  it('stops writing after stop()', async () => {
    let now = 1000;
    const writer = new HeartbeatWriter(filePath, { intervalMs: 100, clock: () => now });
    writer.start();
    await vi.waitFor(async () => {
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ writtenAtMs: 1000 });
    });
    writer.stop();
    now = 9999;
    await vi.advanceTimersByTimeAsync(500);
    expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({ writtenAtMs: 1000 });
  });

  it('start() is idempotent — calling it twice does not double the timer', async () => {
    let ticks = 0;
    let now = 1000;
    const writer = new HeartbeatWriter(filePath, {
      intervalMs: 100,
      clock: () => {
        ticks++;
        return now;
      },
    });
    writer.start();
    writer.start();
    await vi.waitFor(() => expect(ticks).toBeGreaterThanOrEqual(1));
    const ticksAfterFirstStart = ticks;
    now = 2000;
    await vi.advanceTimersByTimeAsync(100);
    // Exactly one more tick from the single live interval, not two.
    expect(ticks).toBe(ticksAfterFirstStart + 1);
    writer.stop();
    // The tick above kicked off a real temp-file write + rename; on Windows, afterEach's
    // recursive rm can walk the directory mid-rename and die with ENOTEMPTY unless the
    // write settles first.
    await writer.flush();
  });

  it('reports a write failure through onError instead of throwing out of the timer', async () => {
    const errors: unknown[] = [];
    // Writing ONTO an existing directory always fails. A merely-missing parent directory no
    // longer does: the atomic writer creates it, which is a deliberate self-heal — a daemon
    // whose data dir vanished should re-make it rather than warn every 30s forever.
    const badPath = dir;
    const writer = new HeartbeatWriter(badPath, { onError: (err) => errors.push(err) });
    writer.start();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    writer.stop();
  });

  it('defaults to the real 30s interval', () => {
    expect(HEARTBEAT_INTERVAL_MS).toBe(30_000);
  });
});

describe('readHeartbeat', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-heartbeat-read-'));
    filePath = join(dir, 'daemon-heartbeat.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads 'never' when the file has never been written", async () => {
    expect(await readHeartbeat(filePath)).toEqual({ state: 'never' });
  });

  it("reads 'never' on corrupt content instead of throwing", async () => {
    await writeFile(filePath, 'not json at all', 'utf8');
    expect(await readHeartbeat(filePath)).toEqual({ state: 'never' });
  });

  it("reads 'never' when the JSON is well-formed but missing writtenAtMs", async () => {
    await writeFile(filePath, JSON.stringify({ other: 1 }), 'utf8');
    expect(await readHeartbeat(filePath)).toEqual({ state: 'never' });
  });

  it("reads 'alive' for a recent write", async () => {
    await writeFile(filePath, JSON.stringify({ writtenAtMs: 1_000_000 }), 'utf8');
    const reading = await readHeartbeat(filePath, 1_000_000 + 5_000);
    expect(reading).toEqual({ state: 'alive', writtenAtMs: 1_000_000, ageMs: 5_000 });
  });

  it("reads 'stale' once the age exceeds HEARTBEAT_STALE_AFTER_MS", async () => {
    await writeFile(filePath, JSON.stringify({ writtenAtMs: 0 }), 'utf8');
    const reading = await readHeartbeat(filePath, HEARTBEAT_STALE_AFTER_MS + 1);
    expect(reading.state).toBe('stale');
  });

  it('is exactly-alive at the stale boundary (not yet stale)', async () => {
    await writeFile(filePath, JSON.stringify({ writtenAtMs: 0 }), 'utf8');
    const reading = await readHeartbeat(filePath, HEARTBEAT_STALE_AFTER_MS);
    expect(reading.state).toBe('alive');
  });

  it('honors a custom staleAfterMs override', async () => {
    await writeFile(filePath, JSON.stringify({ writtenAtMs: 0 }), 'utf8');
    expect((await readHeartbeat(filePath, 1000, 500)).state).toBe('stale');
    expect((await readHeartbeat(filePath, 400, 500)).state).toBe('alive');
  });
});
