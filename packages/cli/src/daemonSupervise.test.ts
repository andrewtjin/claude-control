import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendCrashLine,
  crashLogPath,
  superviseDaemon,
  type SupervisedChild,
} from './daemonSupervise.js';

/** An emitter-backed fake child the loop can drive without real processes. */
class FakeChild extends EventEmitter implements SupervisedChild {
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
  }
}

/** Harness: scripted exits, virtual clock, instant sleeps, captured logs. */
function harness(exits: Array<number | null>) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const crashLines: string[] = [];
  let now = 0;
  const pendingExits = [...exits];
  return {
    children,
    logs,
    crashLines,
    run: (overrides?: { signal?: AbortSignal }) =>
      superviseDaemon({
        spawnChild: () => {
          const child = new FakeChild();
          children.push(child);
          const code = pendingExits.shift();
          // Undefined script = the child "runs forever" (until killed via signal).
          if (code !== undefined) setImmediate(() => child.emit('exit', code, null));
          return child;
        },
        log: (line) => logs.push(line),
        logCrash: (line) => crashLines.push(line),
        clock: () => now,
        sleep: (ms) => {
          now += ms;
          return Promise.resolve();
        },
        restartDelayMs: 2_000,
        crashLoopWindowMs: 60_000,
        crashLoopThreshold: 3,
        crashLoopDelayMs: 30_000,
        ...(overrides?.signal ? { signal: overrides.signal } : {}),
      }),
  };
}

describe('superviseDaemon', () => {
  it('respawns after a crash and stops on the first clean exit', async () => {
    const h = harness([1, 1, 0]);
    await h.run();
    expect(h.children).toHaveLength(3); // two crashes → two respawns → clean exit ends it
    expect(h.crashLines).toHaveLength(2);
    expect(h.crashLines[0]).toContain('code=1');
    expect(h.logs.at(-1)).toContain('exited cleanly');
  });

  it('a clean exit spawns exactly one child and never restarts', async () => {
    const h = harness([0]);
    await h.run();
    expect(h.children).toHaveLength(1);
    expect(h.crashLines).toEqual([]);
  });

  it('slows to the crash-loop delay once exits pile up inside the window', async () => {
    const h = harness([1, 1, 1, 1, 0]);
    await h.run();
    // First two crashes are ordinary restarts; from the third (threshold) on, the slow delay.
    expect(h.crashLines[0]).toContain('restarting in 2000ms');
    expect(h.crashLines[1]).toContain('restarting in 2000ms');
    expect(h.crashLines[2]).toContain('restarting in 30000ms');
    expect(h.crashLines[3]).toContain('restarting in 30000ms');
  });

  it('an abort kills the running child and ends supervision without a respawn', async () => {
    const controller = new AbortController();
    // Child 1 crashes; child 2 (no scripted exit) runs until the abort kills it.
    const h = harness([1]);
    const done = h.run({ signal: controller.signal });
    // Wait until the second child exists (first crashed and was respawned).
    await new Promise<void>((resolve) => {
      const tick = () => (h.children.length >= 2 ? resolve() : setImmediate(tick));
      tick();
    });
    controller.abort();
    await done;
    expect(h.children).toHaveLength(2);
    expect(h.children[1]?.killed).toBe(true);
    expect(h.logs.at(-1)).toContain('operator interrupt');
  });
});

describe('crash log plumbing', () => {
  it('appendCrashLine creates the directory and appends timestamped lines', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-crash-'));
    try {
      const filePath = crashLogPath(join(dir, 'nested'));
      appendCrashLine(filePath, 'first');
      appendCrashLine(filePath, 'second');
      const text = await readFile(filePath, 'utf8');
      const lines = text.trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T.* first$/);
      expect(lines[1]).toMatch(/second$/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
