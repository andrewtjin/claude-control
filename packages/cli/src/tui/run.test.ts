// The runtime: fake terminal streams drive the real reducer and renderer. One suite runs a whole
// session against a real engine on a temp vault, a seeded daemon database and a real loopback
// daemon route; the rest pin the one promise the runtime makes on every way out — the terminal is
// given back (main screen, cursor shown, line wrap on, raw mode off) — with scripted sources.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  CredentialStore,
  InsecurePassthroughProtector,
  SwitchEngine,
  defaultPaths,
  noopLogger,
  type CredentialBundle,
} from '@claude-control/switch-engine';
import {
  HookReceiver,
  Store,
  hookEndpointPath,
  hookSecretPath,
  loadOrCreateHookSecret,
  writeHookEndpoint,
} from '@claude-control/daemon';
import { PLAIN_PALETTE } from '../ansi.js';
import { AccountActionError } from '../accountActions.js';
import { SessionClientError } from '../sessionClient.js';
import { daemonHeartbeatPath } from '../settings.js';
import { everyStateAccounts, snapshotOf } from '../testing/tuiFixtures.js';
import { ENTER_SCREEN, LEAVE_SCREEN, StatusLog, runTui, type TuiDeps } from './run.js';
import { createTuiSources } from './sources.js';
import type { TuiSources } from './types.js';

// The data dir (vault, daemon.db, heartbeat) is moved into a temp root for every test.
const pathsIo = vi.hoisted(() => ({ dataRoot: '' }));
vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return {
    ...real,
    defaultPaths: (...args: Parameters<typeof real.defaultPaths>) => ({
      ...real.defaultPaths(...args),
      vaultDir: join(pathsIo.dataRoot, 'claude-control', 'vault'),
    }),
  };
});

const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);

/** Wait for an assertion to hold. The bound is generous on purpose: a real switch takes a lock,
 *  writes files and re-reads the vault, and on a loaded machine that alone can pass vi.waitFor's
 *  one-second default without anything being wrong. */
function until(assertion: () => void): Promise<void> {
  return vi.waitFor(assertion, { timeout: 15_000, interval: 20 });
}

// ---------------------------------------------------------------------------
// A fake terminal
// ---------------------------------------------------------------------------

/** stdin in raw mode: records every mode change and whether it is paused. */
class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  paused = true;
  modes: boolean[] = [];
  setRawMode(mode: boolean): this {
    this.isRaw = mode;
    this.modes.push(mode);
    return this;
  }
  setEncoding(): this {
    return this;
  }
  resume(): this {
    this.paused = false;
    return this;
  }
  pause(): this {
    this.paused = true;
    return this;
  }
  /** Type keys, as raw input arrives. */
  type(text: string): void {
    this.emit('data', text);
  }
}

/** stdout: records every write; a size the test can change. */
class FakeOutput extends EventEmitter {
  isTTY = true;
  columns = 120;
  rows = 16;
  chunks: string[] = [];
  write(chunk: string): boolean {
    this.chunks.push(chunk);
    return true;
  }
  get all(): string {
    return this.chunks.join('');
  }
  /** The last frame drawn, as plain lines. */
  screen(): string[] {
    const frames = this.all.split(`${ESC}[H`);
    const last = frames[frames.length - 1] ?? '';
    return last
      .split(`${ESC}[?7h`)[0]!
      .split(`${ESC}[K`)
      .join('')
      .split(`${ESC}[J`)
      .join('')
      .split('\r\n');
  }
  text(): string {
    return this.screen().join('\n');
  }
}

/** Manual timers: the refresh only ticks when the test says. */
function manualTimers() {
  const fns = new Map<number, () => void>();
  let next = 1;
  return {
    setInterval: (fn: () => void) => {
      fns.set(next, fn);
      return next++;
    },
    clearInterval: (h: unknown) => {
      fns.delete(h as number);
    },
    tick: () => {
      for (const fn of [...fns.values()]) fn();
    },
    get active(): number {
      return fns.size;
    },
  };
}

interface Rig {
  input: FakeInput;
  output: FakeOutput;
  proc: EventEmitter;
  timers: ReturnType<typeof manualTimers>;
  stderr: { write: (...args: never[]) => boolean };
  stderrOriginal: (...args: never[]) => boolean;
  log: StatusLog;
  logFallback: string[];
  exit: Promise<{ code: number }>;
}

/** Start the view on a fake terminal over `sources`. */
function start(sources: TuiSources, over: Partial<TuiDeps> = {}): Rig {
  const input = new FakeInput();
  const output = new FakeOutput();
  const proc = new EventEmitter();
  const timers = manualTimers();
  const stderrOriginal = vi.fn(() => true) as unknown as (...args: never[]) => boolean;
  const stderr = { write: stderrOriginal };
  const logFallback: string[] = [];
  const log = new StatusLog({ write: (c: string) => logFallback.push(c) });
  const exit = runTui({
    stdin: input,
    stdout: output,
    sources,
    palette: PLAIN_PALETTE,
    platform: 'linux',
    timers,
    process: proc,
    stderr,
    log,
    ...over,
  });
  return { input, output, proc, timers, stderr, stderrOriginal, log, logFallback, exit };
}

/** The terminal is back as it was: main screen, cursor, wrap, cooked input, nothing listening. */
function expectRestored(rig: Rig): void {
  expect(rig.input.isRaw).toBe(false);
  expect(rig.input.paused).toBe(true);
  expect(rig.input.listenerCount('data')).toBe(0);
  expect(rig.output.listenerCount('resize')).toBe(0);
  expect(rig.output.listenerCount('error')).toBe(0);
  for (const event of ['SIGTERM', 'SIGINT', 'SIGHUP', 'exit']) {
    expect(rig.proc.listenerCount(event)).toBe(0);
  }
  expect(rig.timers.active).toBe(0);
  expect(rig.stderr.write).toBe(rig.stderrOriginal);
}

/** The terminal got its restore sequence last: leave the alternate screen, show the cursor. */
function expectLeftScreen(rig: Rig): void {
  const tail = rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN));
  expect(tail).toBe(LEAVE_SCREEN);
  expect(LEAVE_SCREEN).toContain(`${ESC}[?1049l`);
  expect(LEAVE_SCREEN).toContain(`${ESC}[?25h`);
}

/** Sources that serve one fixed picture and record what they were asked. */
function scripted(over: Partial<TuiSources> = {}): TuiSources & { calls: string[] } {
  const calls: string[] = [];
  const done =
    (what: string) =>
    (...args: unknown[]) => {
      calls.push(`${what}:${args.join(',')}`);
      return Promise.resolve({ message: `${what} done` });
    };
  return {
    calls,
    load: vi.fn(() => Promise.resolve(snapshotOf(everyStateAccounts()))),
    switchAccount: done('switch'),
    setExcluded: done('exclude'),
    renameAccount: done('rename'),
    removeAccount: done('remove'),
    addAccount: done('add'),
    repoll: () => Promise.resolve({ ok: true as const, results: [] }),
    ...over,
  };
}

// ---------------------------------------------------------------------------
// A whole session on a real engine
// ---------------------------------------------------------------------------

describe('a session against a temp vault, a seeded store and a real daemon route', () => {
  let root: string;
  let receiver: HookReceiver | undefined;
  let receiverStore: Store | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-tui-run-'));
    pathsIo.dataRoot = root;
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
    await mkdir(join(root, 'claude'), { recursive: true });
  });
  afterEach(async () => {
    await receiver?.close();
    receiver = undefined;
    receiverStore?.close();
    receiverStore = undefined;
    vi.unstubAllEnvs();
    pathsIo.dataRoot = '';
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  /** A login far from expiry, so a switch never needs the network. */
  function login(name: string): CredentialBundle {
    return {
      claudeAiOauth: {
        accessToken: `at-${name}`,
        refreshToken: `rt-${name}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
      },
      oauthAccount: { accountUuid: `uuid-${name}`, emailAddress: `${name}@example.com` },
    };
  }

  it(
    'opens, moves, switches, renames, refreshes and quits, then gives the terminal back',
    { timeout: 120_000 },
    async () => {
      const paths = defaultPaths();
      const dataDir = dirname(paths.vaultDir);
      const protector = new InsecurePassthroughProtector();
      const engine = new SwitchEngine({ paths, protector, logger: noopLogger });

      // The live login is "work"; "home" is stored beside it.
      const credStore = new CredentialStore(paths);
      const work = login('work');
      await credStore.writeLiveCredentials(work.claudeAiOauth);
      await credStore.writeOauthAccount(work.oauthAccount!);
      const workRow = await engine.captureCurrentLogin('work');
      const homeRow = await engine.addAccount('home', login('home'));

      // The daemon's database: a poll for each account and one tracked session.
      const store = new Store(join(dataDir, 'daemon.db'));
      for (const [row, pct] of [
        [workRow, 30],
        [homeRow, 70],
      ] as const) {
        store.insertUsageSnapshot({
          accountId: row.id,
          fetchedAtMs: Date.now() - 60_000,
          source: 'live',
          json: JSON.stringify({
            accountId: row.id,
            label: row.label,
            active: false,
            source: 'live',
            fetchedAtMs: Date.now() - 60_000,
            limits: [{ kind: 'session', percent: pct, isActive: true }],
          }),
        });
      }
      store.upsertSession({
        id: 'sess-1',
        kind: 'interactive',
        state: 'active',
        accountId: workRow.id,
        json: JSON.stringify({ label: 'planning' }),
        updatedAtMs: Date.now(),
      });
      store.close();

      // A running daemon: a fresh heartbeat, and the loopback route answering the refresh.
      await writeFile(daemonHeartbeatPath(paths), JSON.stringify({ writtenAtMs: Date.now() }));
      const secret = await loadOrCreateHookSecret({ filePath: hookSecretPath(dataDir), protector });
      const asked: unknown[] = [];
      receiverStore = new Store(':memory:');
      receiver = new HookReceiver({
        store: receiverStore,
        secret,
        emit: () => {},
        daemonId: () => 'daemon-test',
      });
      receiver.setUsageHandlers({
        repollUsage: (ids) => {
          asked.push(ids);
          return Promise.resolve({
            ok: true,
            results: [workRow.id, homeRow.id].map((id) => ({ id, outcome: 'scheduled' as const })),
          });
        },
      });
      await writeHookEndpoint(hookEndpointPath(dataDir), { port: await receiver.listen(0) });

      const sources = createTuiSources({
        engine,
        readOutages: () =>
          Promise.resolve({ episodes: [], open: [], logPath: join(dataDir, 'exhaustion.jsonl') }),
        daemonClient: { dataDir, protector },
      });
      const rig = start(sources);

      expect(rig.output.chunks[0]).toBe(ENTER_SCREEN);
      expect(rig.input.isRaw).toBe(true);
      await until(() => expect(rig.output.text()).toContain('home'));
      expect(rig.output.text()).toContain('daemon up');
      expect(rig.output.screen()[3]).toMatch(/^>\* work /);

      // Down to home, Enter: home goes live.
      rig.input.type('j');
      expect(rig.output.screen()[4]).toMatch(/^> {2}home /);
      rig.input.type('\r');
      await until(() => expect(rig.output.text()).toContain('Activated home'));
      expect(await engine.getActiveId()).toBe(homeRow.id);
      await until(() => expect(rig.output.screen()[4]).toMatch(/^>\* home /));

      // Rename it.
      rig.input.type('r');
      rig.input.type('house\r');
      await until(() =>
        expect(rig.output.text()).toContain(`Renamed home to house (${homeRow.id}).`),
      );
      expect((await engine.listAllAccounts()).map((a) => a.label).sort()).toEqual([
        'house',
        'work',
      ]);
      // The re-read after the rename has landed before the next key.
      await until(() => expect(rig.output.screen()[4]).toMatch(/^>\* house /));

      // Refresh: the daemon is asked for every account and says both are scheduled.
      rig.input.type('u');
      await until(() => expect(rig.output.text()).toContain('Refreshing work, house'));
      expect(asked).toEqual([undefined]);

      // The sessions pane shows the seeded session under its account's label.
      rig.input.type('\t');
      await until(() => expect(rig.output.text()).toContain('planning'));

      rig.input.type('q');
      expect(await rig.exit).toEqual({ code: 0 });
      expectRestored(rig);
      expectLeftScreen(rig);
    },
  );
});

// ---------------------------------------------------------------------------
// Every way out gives the terminal back
// ---------------------------------------------------------------------------

describe('giving the terminal back', () => {
  it('on q', async () => {
    const rig = start(scripted());
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
    expectLeftScreen(rig);
  });

  it('on Escape', async () => {
    const rig = start(scripted());
    rig.input.type(ESC);
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
  });

  it('on Ctrl-C', async () => {
    const rig = start(scripted());
    rig.input.type(CTRL_C);
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
    expectLeftScreen(rig);
  });

  it.each([
    ['SIGTERM', 143],
    ['SIGHUP', 129],
    ['SIGINT', 130],
  ])('on %s, with the exit code it asks for', async (signal, code) => {
    const rig = start(scripted());
    rig.proc.emit(signal);
    expect(await rig.exit).toEqual({ code });
    expectRestored(rig);
    expectLeftScreen(rig);
  });

  it('on an action that throws a fault, rejecting with it after the restore', async () => {
    const boom = new Error('the account registry at x is malformed');
    const rig = start(scripted({ switchAccount: () => Promise.reject(boom) }));
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await expect(rig.exit).rejects.toBe(boom);
    expectRestored(rig);
    expectLeftScreen(rig);
  });

  it('on a fault while drawing, rejecting with it after the restore', async () => {
    const boom = new Error('render blew up');
    let armed = false;
    const palette = {
      ...PLAIN_PALETTE,
      bold: (t: string) => {
        if (armed) throw boom;
        return t;
      },
    };
    const rig = start(scripted(), { palette });
    await until(() => expect(rig.output.text()).toContain('work'));
    armed = true;
    rig.input.type('j');
    await expect(rig.exit).rejects.toBe(boom);
    expectRestored(rig);
    expectLeftScreen(rig);
  });

  it('when the output closes (EPIPE): raw mode off, nothing more written', async () => {
    const rig = start(scripted());
    await until(() => expect(rig.output.text()).toContain('work'));
    const before = rig.output.chunks.length;
    rig.output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    expect(await rig.exit).toEqual({ code: 1 });
    expectRestored(rig);
    expect(rig.output.chunks.length).toBe(before);
  });

  it('when the process exits under it, as a last resort', async () => {
    const rig = start(scripted());
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.proc.emit('exit');
    expect(rig.input.isRaw).toBe(false);
    expectLeftScreen(rig);
    // The view is down; a key afterwards reaches nothing.
    expect(rig.input.listenerCount('data')).toBe(0);
    rig.proc.emit('SIGTERM');
    expect(await rig.exit).toEqual({ code: 143 });
  });

  it('after the running action when Ctrl-C arrives mid-action', async () => {
    let finishSwitch: (v: { message: string }) => void = () => {};
    const sources = scripted({
      switchAccount: () =>
        new Promise((resolve) => {
          finishSwitch = resolve;
        }),
    });
    const rig = start(sources);
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    rig.input.type(CTRL_C);
    expect(rig.output.text()).toContain('quitting when this finishes');
    expect(rig.input.isRaw).toBe(true);
    finishSwitch({ message: 'Activated work.' });
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
  });

  it('at once on a second Ctrl-C mid-action', async () => {
    const rig = start(scripted({ switchAccount: () => new Promise(() => {}) }));
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    rig.input.type(CTRL_C);
    rig.input.type(CTRL_C);
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
  });
});

// ---------------------------------------------------------------------------
// Behavior while running
// ---------------------------------------------------------------------------

describe('while running', () => {
  it('shows a refusal on the status line and keeps going', async () => {
    const rig = start(
      scripted({
        switchAccount: () =>
          Promise.reject(
            new AccountActionError('quarantined', 'work is quarantined; re-login required.'),
          ),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await until(() =>
      expect(rig.output.text()).toContain('work is quarantined; re-login required.'),
    );
    expect(rig.input.isRaw).toBe(true);
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
  });

  it.each([
    ['hung', 'the daemon on 127.0.0.1:1 took the request but did not answer within 5 s'],
    [
      'older_daemon',
      'the running daemon is older than this cctl and cannot refresh usage on demand',
    ],
  ] as const)('says a %s refresh honestly', async (failure, message) => {
    const rig = start(
      scripted({ repoll: () => Promise.reject(new SessionClientError(message, failure)) }),
    );
    await until(() => expect(rig.output.text()).toContain('daemon up'));
    rig.input.type('u');
    await until(() => expect(rig.output.text()).toContain(message));
    rig.input.type('q');
    await rig.exit;
  });

  it('refuses the refresh with a reason when the daemon is down, without asking it', async () => {
    const repoll = vi.fn();
    const rig = start(
      scripted({
        load: () =>
          Promise.resolve(
            snapshotOf(everyStateAccounts(), { daemon: { heartbeat: { state: 'never' } } }),
          ),
        repoll,
      }),
    );
    await until(() => expect(rig.output.text()).toContain('daemon not running'));
    rig.input.type('u');
    expect(rig.output.text()).toContain('Refresh needs the running daemon');
    expect(repoll).not.toHaveBeenCalled();
    rig.input.type('q');
    await rig.exit;
  });

  it('steps the screen aside for the add login window and comes back after it', async () => {
    let during: { raw: boolean; left: boolean } | undefined;
    const rig = start(
      scripted({
        addAccount: (label) => {
          during = {
            raw: rig.input.isRaw,
            left: rig.output.all.endsWith(LEAVE_SCREEN),
          };
          return Promise.resolve({ message: `Added ${label} (id-9).` });
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('a');
    rig.input.type('fresh\r');
    await until(() => expect(rig.output.text()).toContain('Added fresh (id-9).'));
    expect(during).toEqual({ raw: false, left: true });
    // Back on the alternate screen, reading keys again.
    expect(rig.output.all.lastIndexOf(ENTER_SCREEN)).toBeGreaterThan(
      rig.output.all.indexOf(LEAVE_SCREEN),
    );
    expect(rig.input.isRaw).toBe(true);
    expect(rig.timers.active).toBe(1);
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
    expectRestored(rig);
  });

  it('comes back from an add that was refused, and ends cleanly on one that faulted', async () => {
    const refused = start(
      scripted({
        addAccount: () =>
          Promise.reject(new AccountActionError('no_capture_login', 'no login in the window')),
      }),
    );
    await until(() => expect(refused.output.text()).toContain('work'));
    refused.input.type('a');
    refused.input.type('x\r');
    await until(() => expect(refused.output.text()).toContain('no login in the window'));
    expect(refused.input.isRaw).toBe(true);
    refused.input.type('q');
    await refused.exit;

    const boom = new Error('spawn failed oddly');
    const faulted = start(scripted({ addAccount: () => Promise.reject(boom) }));
    await until(() => expect(faulted.output.text()).toContain('work'));
    faulted.input.type('a');
    faulted.input.type('x\r');
    await expect(faulted.exit).rejects.toBe(boom);
    expectRestored(faulted);
  });

  it('puts engine log lines and stray stderr writes on the status line, not the screen', async () => {
    const rig = start(scripted());
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.log.write('WARN metadata repair could not finish\n');
    expect(rig.output.screen()[14]).toBe('WARN metadata repair could not finish');
    (rig.stderr.write as unknown as (s: string) => boolean)(`warning: ${ESC}[31mstray${ESC}[0m\n`);
    expect(rig.output.screen()[14]).toBe('warning: stray');
    expect(rig.stderrOriginal).not.toHaveBeenCalled();
    rig.input.type('q');
    await rig.exit;
    // Back to normal once the view is gone.
    expectRestored(rig);
    rig.log.write('after\n');
    expect(rig.logFallback).toEqual(['after\n']);
  });

  it('re-reads on every tick and redraws on resize', async () => {
    const load = vi.fn(() => Promise.resolve(snapshotOf(everyStateAccounts())));
    const rig = start(scripted({ load }));
    await until(() => expect(rig.output.text()).toContain('work'));
    const loads = load.mock.calls.length;
    rig.timers.tick();
    await until(() => expect(load.mock.calls.length).toBe(loads + 1));
    rig.output.columns = 39;
    rig.output.emit('resize');
    expect(rig.output.screen()[0]).toBe('Terminal too narrow: widen it to 40 col');
    rig.input.type('q');
    await rig.exit;
  });

  it('keeps the last picture and says so when a read fails', async () => {
    let fail = false;
    const rig = start(
      scripted({
        load: () =>
          fail
            ? Promise.reject(new Error('daemon.db is locked'))
            : Promise.resolve(snapshotOf(everyStateAccounts())),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    fail = true;
    rig.timers.tick();
    await until(() => expect(rig.output.text()).toContain('Could not read: daemon.db is locked'));
    expect(rig.output.text()).toContain('home');
    rig.input.type('q');
    await rig.exit;
  });
});
