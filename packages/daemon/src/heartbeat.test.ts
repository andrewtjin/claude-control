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

describe('HeartbeatWriter', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-heartbeat-'));
    filePath = join(dir, 'daemon-heartbeat.json');
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
    // A directory that does not exist makes every write fail.
    const badPath = join(dir, 'missing-subdir', 'heartbeat.json');
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
