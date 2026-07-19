import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hookEndpointPath, writeHookEndpoint } from '@claude-control/daemon';
import {
  appendCrashLine,
  buildDefaultProbeFn,
  crashLogPath,
  superviseDaemon,
  type ProbeOptions,
  type SupervisedChild,
} from './daemonSupervise.js';

/** An emitter-backed fake child the loop can drive without real processes. Also stands in for
 *  a spawn failure via `emit('error', ...)` — superviseDaemon always registers its 'error'
 *  listener synchronously before returning from spawnChild, and the harness only ever
 *  schedules the scripted emit via setImmediate, so the listener is guaranteed to be there. */
class FakeChild extends EventEmitter implements SupervisedChild {
  killed = false;
  kill(): void {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
  }
}

/** Harness: scripted exits, virtual clock, instant sleeps, captured logs.
 *  Each entry in `exits` scripts one spawned child:
 *   - a number (or null) fires 'exit' with that code
 *   - an Error fires 'error' instead of 'exit' (simulated spawn failure)
 *   - undefined — including running past the end of the array — fires nothing: the child
 *     "runs forever" until killed via signal or the health probe. */
function harness(exits: Array<number | null | Error | undefined>) {
  const children: FakeChild[] = [];
  const logs: string[] = [];
  const crashLines: string[] = [];
  let now = 0;
  const pendingExits = [...exits];
  return {
    children,
    logs,
    crashLines,
    run: (overrides?: { signal?: AbortSignal; probe?: ProbeOptions }) =>
      superviseDaemon({
        spawnChild: () => {
          const child = new FakeChild();
          children.push(child);
          const scripted = pendingExits.shift();
          if (scripted instanceof Error) {
            setImmediate(() => child.emit('error', scripted));
          } else if (scripted !== undefined) {
            setImmediate(() => child.emit('exit', scripted, null));
          }
          return child;
        },
        log: (line) => logs.push(line),
        logCrash: (line) => crashLines.push(line),
        clock: () => now,
        // Resolves via setImmediate (a real macrotask), not an already-resolved microtask:
        // a probe loop awaits this every interval, and a purely-microtask resolution would
        // let it spin forever without ever yielding to the macrotask queue where scripted
        // child exits (also scheduled via setImmediate) are waiting — starving the event
        // loop instead of racing fairly against them.
        sleep: (ms) =>
          new Promise<void>((resolve) => {
            now += ms;
            setImmediate(resolve);
          }),
        restartDelayMs: 2_000,
        crashLoopWindowMs: 60_000,
        crashLoopThreshold: 3,
        crashLoopDelayMs: 30_000,
        ...(overrides?.signal ? { signal: overrides.signal } : {}),
        ...(overrides?.probe ? { probe: overrides.probe } : {}),
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

  it('a real abort during the restart delay returns promptly instead of waiting out the delay', async () => {
    // Uses superviseDaemon directly (not the harness) so the PRODUCTION default sleep — the
    // one that must race the abort signal — is actually exercised, with real short timers.
    const controller = new AbortController();
    const logs: string[] = [];
    const crashLines: string[] = [];
    let child: FakeChild | undefined;
    const done = superviseDaemon({
      spawnChild: () => {
        child = new FakeChild();
        setImmediate(() => child?.emit('exit', 1, null));
        return child;
      },
      log: (line) => logs.push(line),
      logCrash: (line) => crashLines.push(line),
      signal: controller.signal,
      restartDelayMs: 5_000, // would hang the test for 5s without the abort-aware sleep
    });
    // Let the child crash and the loop settle into its restart-delay sleep, then interrupt.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const abortedAt = Date.now();
    controller.abort();
    await done;
    expect(Date.now() - abortedAt).toBeLessThan(1_000);
    expect(crashLines).toHaveLength(1);
  });
});

describe('child spawn/runtime errors', () => {
  it('treats a child "error" event as a crash: logged with the error and respawned', async () => {
    // No 'exit' ever fires for this child — only Node's 'error' contract for a process that
    // never actually started. Without an 'error' listener this would hang the loop forever.
    const h = harness([new Error('spawn cctl ENOENT'), 0]);
    await h.run();
    expect(h.children).toHaveLength(2); // error → respawn → clean exit ends it
    expect(h.crashLines).toHaveLength(1);
    expect(h.crashLines[0]).toContain('spawn cctl ENOENT');
    expect(h.logs.at(-1)).toContain('exited cleanly');
  });
});

describe('health probe (hang detection)', () => {
  it('kills a hung child after consecutive probe failures and respawns', async () => {
    const probeResults: boolean[] = [true, false, false, false];
    const probeCalls: unknown[] = [];
    const probeFn = (): Promise<boolean> => {
      const next = probeResults.shift();
      if (next === undefined) throw new Error('probeFn called more than scripted');
      probeCalls.push(next);
      return Promise.resolve(next);
    };
    // Child never exits on its own — only the probe's kill() ends it.
    const h = harness([undefined, 0]);
    await h.run({ probe: { probeFn } });
    expect(probeCalls).toHaveLength(4); // 3rd CONSECUTIVE false is the 4th call overall
    expect(h.children).toHaveLength(2);
    expect(h.children[0]?.killed).toBe(true);
    expect(h.crashLines.some((l) => l.includes('unresponsive'))).toBe(true);
  });

  it('resets the consecutive-failure counter on any healthy probe', async () => {
    const probeResults: boolean[] = [false, false, true, false, false, false];
    const probeCalls: unknown[] = [];
    const probeFn = (): Promise<boolean> => {
      const next = probeResults.shift();
      if (next === undefined) throw new Error('probeFn called more than scripted');
      probeCalls.push(next);
      return Promise.resolve(next);
    };
    const h = harness([undefined, 0]);
    await h.run({ probe: { probeFn } });
    expect(probeCalls).toHaveLength(6); // kill only after the LATER 3-streak
    expect(h.children).toHaveLength(2);
    expect(h.crashLines.filter((l) => l.includes('unresponsive'))).toHaveLength(1);
  });

  it('does not probe at all when the probe option is absent (existing behavior unchanged)', async () => {
    const controller = new AbortController();
    const h = harness([1]);
    const done = h.run({ signal: controller.signal });
    await new Promise<void>((resolve) => {
      const tick = () => (h.children.length >= 2 ? resolve() : setImmediate(tick));
      tick();
    });
    controller.abort();
    await done;
    expect(h.children).toHaveLength(2);
    expect(h.crashLines.some((l) => l.includes('unresponsive'))).toBe(false);
  });

  it('stops probing on abort: no further probeFn calls and no extra kill', async () => {
    const controller = new AbortController();
    const probeCalls: unknown[] = [];
    let resolveProbe: ((v: boolean) => void) | undefined;
    const probeFn = (): Promise<boolean> =>
      new Promise<boolean>((resolve) => {
        probeCalls.push(undefined);
        resolveProbe = resolve;
      });
    const h = harness([]); // first child runs forever
    const done = h.run({ signal: controller.signal, probe: { probeFn } });
    // Wait for the first probe call to be in flight before interrupting.
    await new Promise<void>((resolve) => {
      const tick = () => (probeCalls.length >= 1 ? resolve() : setImmediate(tick));
      tick();
    });
    controller.abort();
    resolveProbe?.(false); // settle the in-flight probe now that the signal is already aborted
    await done;
    expect(probeCalls).toHaveLength(1);
    expect(h.children).toHaveLength(1);
    expect(h.children[0]?.killed).toBe(true);
  });
});

describe('buildDefaultProbeFn (production health probe)', () => {
  it('is vacuously healthy when no hook-endpoint.json has ever been published', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-probe-'));
    try {
      await expect(buildDefaultProbeFn(dir)()).resolves.toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is healthy when the published endpoint answers /healthz with 200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-probe-'));
    const server = createServer((req, res) => {
      res.writeHead(req.url === '/healthz' ? 200 : 404);
      res.end();
    });
    try {
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      await writeHookEndpoint(hookEndpointPath(dir), { port });
      await expect(buildDefaultProbeFn(dir)()).resolves.toBe(true);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is unhealthy when the published endpoint answers non-200', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-probe-'));
    const server = createServer((_req, res) => {
      res.writeHead(500);
      res.end();
    });
    try {
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      await writeHookEndpoint(hookEndpointPath(dir), { port });
      await expect(buildDefaultProbeFn(dir)()).resolves.toBe(false);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is unhealthy when nothing is listening on the published port', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-probe-'));
    try {
      // Grab a real ephemeral port, then free it immediately — nothing answers there.
      const port = await new Promise<number>((resolve) => {
        const probe = createServer();
        probe.listen(0, '127.0.0.1', () => {
          const addr = probe.address();
          const p = typeof addr === 'object' && addr ? addr.port : 0;
          probe.close(() => resolve(p));
        });
      });
      await writeHookEndpoint(hookEndpointPath(dir), { port });
      await expect(buildDefaultProbeFn(dir)()).resolves.toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('times out (unhealthy) when the endpoint never responds within timeoutMs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cctl-probe-'));
    const server = createServer(() => {
      // Deliberately never respond — exercises the AbortController timeout path.
    });
    try {
      const port = await new Promise<number>((resolve) => {
        server.listen(0, '127.0.0.1', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
      });
      await writeHookEndpoint(hookEndpointPath(dir), { port });
      await expect(buildDefaultProbeFn(dir, 20)()).resolves.toBe(false);
    } finally {
      server.close();
      await rm(dir, { recursive: true, force: true });
    }
  }, 2_000);
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
