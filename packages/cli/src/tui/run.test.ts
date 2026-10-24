// The runtime: fake terminal streams drive the real reducer and renderer. One suite runs a whole
// session against a real engine on a temp vault, a seeded daemon database and a real loopback
// daemon route; the rest pin the one promise the runtime makes on every way out — the terminal is
// given back (main screen, cursor shown, line wrap on, raw mode off) — with scripted sources.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { stat } from 'node:fs';
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
import { CadenceError } from '@claude-control/switch-engine';
import { SessionClientError } from '../sessionClient.js';
import { daemonHeartbeatPath } from '../settings.js';
import { account, everyStateAccounts, snapshotOf, usage } from '../testing/tuiFixtures.js';
import {
  AMBIGUOUS_WIDTH_PROBE,
  ENTER_SCREEN,
  LEAVE_SCREEN,
  StatusLog,
  paintFrame,
  runTui,
  type TuiDeps,
} from './run.js';
import { ambiguousWidth, setAmbiguousWidth } from './text.js';
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
    // What the terminal held while nobody read it arrives once reading starts again, on a later
    // turn of the loop, as a real tty's queued input does.
    if (this.held.length > 0) {
      const held = this.held.splice(0);
      this.deliverHeld(() => {
        for (const text of held) this.emit('data', text);
      });
    }
    return this;
  }
  /** When held input is delivered once reading resumes: on the next turn of the loop by default.
   *  A test replaces it to deliver the way a real terminal on a loaded machine can. */
  deliverHeld: (send: () => void) => void = (send) => setImmediate(send);
  /** Input the terminal holds while it is not being read. */
  held: string[] = [];
  pause(): this {
    this.paused = true;
    return this;
  }
  /** Type keys, as raw input arrives. */
  type(text: string): void {
    this.emit('data', text);
  }
  /** Type keys at a terminal that may not be read right now: held until reading resumes. */
  typeAhead(text: string): void {
    if (this.paused || this.listenerCount('data') === 0) this.held.push(text);
    else this.emit('data', text);
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
    // One-shot timers (the Escape wait, the input drain) run on the real clock.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>),
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
  // The output error guard stays: a restore write that fails late must not become a crash.
  expect(rig.output.listenerCount('error')).toBe(1);
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
      // The view holds the daemon database open while it runs; whoever made the sources closes
      // them (as `cctl tui` does), or the file stays locked on Windows.
      sources.close?.();
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

  it('at once on a second Ctrl-C mid-action, then waits out the action and reports it', async () => {
    let finishSwitch: (v: { message: string }) => void = () => {};
    const rig = start(
      scripted({
        switchAccount: () =>
          new Promise((resolve) => {
            finishSwitch = resolve;
          }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    rig.input.type(CTRL_C);
    rig.input.type(CTRL_C);
    // The screen is given back at once...
    expect(rig.input.isRaw).toBe(false);
    expect(rig.output.all).toContain(LEAVE_SCREEN);
    let ended = false;
    void rig.exit.then(() => (ended = true));
    // ...but the process stays for the switch, and a further Ctrl-C does not cut it off.
    expect(rig.proc.listenerCount('SIGINT')).toBe(1);
    rig.proc.emit('SIGINT');
    await new Promise((r) => setTimeout(r, 50));
    expect(ended).toBe(false);
    finishSwitch({ message: 'Activated work.' });
    expect(await rig.exit).toEqual({ code: 130 });
    expect(rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN))).toContain(
      'Activated work.',
    );
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
    expect(rig.output.screen()[0]).toBe('Terminal too narrow: widen it to 40');
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

// ---------------------------------------------------------------------------
// Regressions: keys, reads and endings the runtime once got wrong
// ---------------------------------------------------------------------------

describe('keys that arrive when the person did not mean them for the view', () => {
  it('drops keys typed while the screen was stepped aside for a login window', async () => {
    const calls: string[] = [];
    const sources = scripted({
      switchAccount: (id) => {
        calls.push(`switch:${id}`);
        return Promise.resolve({ message: 'switched' });
      },
      addAccount: (label) => {
        // The person presses Enter at what looks like a hung screen while the add finishes.
        rig.input.typeAhead('\r');
        return Promise.resolve({ message: `Added ${label}.` });
      },
    });
    const rig = start(sources);
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('j');
    rig.input.type('a');
    rig.input.type('fresh\r');
    await until(() => expect(rig.output.text()).toContain('Added fresh.'));
    await new Promise((r) => setTimeout(r, 400));
    expect(calls).toEqual([]);
    rig.input.type('q');
    await rig.exit;
  });

  /** Sources whose add is refused after the login window, with an Enter typed at the terminal
   *  while it looked hung. */
  function refusedAdd(): { sources: TuiSources & { calls: string[] }; rig: Rig } {
    const sources: TuiSources & { calls: string[] } = scripted({
      addAccount: (label) => {
        sources.calls.push(`add:${label}`);
        rig.input.typeAhead('\r');
        return Promise.reject(new AccountActionError('no_capture_login', 'no login in the window'));
      },
    });
    const rig = start(sources);
    return { sources, rig };
  }

  it('drops held keys that are only read after a stall longer than the drain', async () => {
    const { sources, rig } = refusedAdd();
    // As a terminal on Linux or macOS delivers them on a loaded machine: the process stalls just
    // after the screen comes back, and the held Enter is read in the loop turn after the stall,
    // once the timers that were due during it have already run.
    rig.input.deliverHeld = (send) =>
      setImmediate(() => {
        stat(import.meta.dirname, () => send());
        const until = Date.now() + 250;
        while (Date.now() < until) {
          // A stall: a descheduled process or a long collection.
        }
      });
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('a');
    rig.input.type('fresh\r');
    await until(() => expect(rig.output.text()).toContain('no login in the window'));
    await new Promise((r) => setTimeout(r, 600));
    expect(sources.calls).toEqual(['add:fresh']);
    rig.input.type('q');
    await rig.exit;
  });

  it('keeps dropping input while a held key is still repeating when the screen comes back', async () => {
    const { sources, rig } = refusedAdd();
    rig.input.deliverHeld = (send) => {
      setImmediate(send);
      // The key is still held: the terminal repeats it every 40 ms for a while.
      let repeats = 0;
      const repeat = setInterval(() => {
        rig.input.emit('data', '\r');
        if ((repeats += 1) === 10) clearInterval(repeat);
      }, 40);
    };
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('a');
    rig.input.type('fresh\r');
    await until(() => expect(rig.output.text()).toContain('no login in the window'));
    await new Promise((r) => setTimeout(r, 800));
    expect(sources.calls).toEqual(['add:fresh']);
    rig.input.type('q');
    await rig.exit;
  });

  it('still hears Ctrl-C while dropping input after a login window', async () => {
    const { sources, rig } = refusedAdd();
    rig.input.deliverHeld = (send) =>
      setImmediate(() => {
        send();
        rig.input.emit('data', CTRL_C);
      });
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('a');
    rig.input.type('fresh\r');
    // The refused add ends the view, as Ctrl-C during an action does, and says how it went.
    expect(await rig.exit).toEqual({ code: 1 });
    expect(rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN))).toContain(
      'no login in the window',
    );
    expect(sources.calls).toEqual(['add:fresh']);
  });

  it('brings the screen back as soon as the add has stored the account', async () => {
    let finishCleanup: () => void = () => {};
    const rig = start(
      scripted({
        addAccount: (label, onStored) =>
          new Promise((resolve) => {
            onStored?.(`Added ${label}.`);
            finishCleanup = () => resolve({ message: `Added ${label}.` });
          }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('a');
    rig.input.type('fresh\r');
    await until(() => expect(rig.input.isRaw).toBe(true));
    expect(rig.output.all.lastIndexOf(ENTER_SCREEN)).toBeGreaterThan(
      rig.output.all.indexOf(LEAVE_SCREEN),
    );
    expect(rig.output.text()).toContain('Added fresh. Cleaning up after the login window...');
    finishCleanup();
    await until(() => expect(rig.output.text()).not.toContain('Cleaning up'));
    expect(rig.output.text()).toContain('Added fresh.');
    rig.input.type('q');
    await rig.exit;
  });

  it('gives back the screen before cooking the input when stepping aside', async () => {
    const order: string[] = [];
    const rig = start(
      scripted({
        addAccount: () => Promise.resolve({ message: 'Added x.' }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    const setRawMode = rig.input.setRawMode.bind(rig.input);
    rig.input.setRawMode = (mode: boolean) => {
      order.push(mode ? 'raw on' : 'raw off');
      return setRawMode(mode);
    };
    const write = rig.output.write.bind(rig.output);
    rig.output.write = (chunk: string) => {
      if (chunk.includes(LEAVE_SCREEN)) order.push('leave screen');
      return write(chunk);
    };
    rig.input.type('a');
    rig.input.type('x\r');
    await until(() => expect(rig.output.text()).toContain('Added x.'));
    expect(order.slice(0, 2)).toEqual(['leave screen', 'raw off']);
    rig.input.type('q');
    await rig.exit;
  });

  it('reads an arrow split across two reads as the arrow, not Escape then text', async () => {
    const rig = start(scripted());
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type(ESC);
    rig.input.type('[B');
    await new Promise((r) => setTimeout(r, 300));
    expect(rig.output.screen()[4]).toMatch(/^> {2}home /);
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
  });

  it('asks the terminal to mark pastes, and stops asking on the way out', () => {
    expect(ENTER_SCREEN).toContain(`${ESC}[?2004h`);
    expect(LEAVE_SCREEN).toContain(`${ESC}[?2004l`);
  });

  it('acts on nothing but quitting while the terminal is too small to show the view', async () => {
    const calls: string[] = [];
    const rig = start(
      scripted({
        switchAccount: (id) => {
          calls.push(id);
          return Promise.resolve({ message: 'switched' });
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.output.columns = 30;
    rig.output.emit('resize');
    rig.input.type('j\re');
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toEqual([]);
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
  });
});

describe('reads around an action', () => {
  it('re-reads after an action even when a timed read was already running', async () => {
    let excluded = false;
    let holdNext = false;
    let release: () => void = () => {};
    const load = vi.fn(() => {
      const snapshot = () =>
        snapshotOf(everyStateAccounts().map((a) => (a.id === 'id-work' ? { ...a, excluded } : a)));
      if (!holdNext) return Promise.resolve(snapshot());
      holdNext = false;
      // Taken before the action: it reads the picture as it was then.
      const before = snapshot();
      return new Promise<ReturnType<typeof snapshot>>((resolve) => {
        release = () => resolve(before);
      });
    });
    const rig = start(
      scripted({
        load,
        setExcluded: (_id, value) => {
          excluded = value;
          return Promise.resolve({ message: 'Excluded work from auto-switch.' });
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    holdNext = true;
    rig.timers.tick();
    rig.input.type('e');
    await until(() => expect(rig.output.text()).toContain('Excluded work'));
    release();
    await until(() => expect(rig.output.screen()[3]).toContain('excluded'));
    rig.input.type('q');
    await rig.exit;
  });
});

describe('how an action ends when the person asked to quit during it', () => {
  it('prints a refusal after the screen is given back, and exits non-zero', async () => {
    let refuse: (e: Error) => void = () => {};
    const rig = start(
      scripted({
        switchAccount: () =>
          new Promise((_, reject) => {
            refuse = reject;
          }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    rig.input.type(CTRL_C);
    refuse(new AccountActionError('switch_failed', 'REFUSAL: the live login is now home.'));
    expect(await rig.exit).toEqual({ code: 1 });
    const after = rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN));
    expect(after).toContain('REFUSAL: the live login is now home.');
    expectRestored(rig);
  });

  it('prints the success line too', async () => {
    let finish: (v: { message: string }) => void = () => {};
    const rig = start(
      scripted({
        removeAccount: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('dwork\r');
    rig.input.type(CTRL_C);
    finish({ message: 'Removed work.' });
    expect(await rig.exit).toEqual({ code: 0 });
    expect(rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN))).toContain(
      'Removed work.',
    );
  });

  it('rejects with a fault that lands after the screen was already given back', async () => {
    let fail: (e: Error) => void = () => {};
    const rig = start(
      scripted({
        switchAccount: () =>
          new Promise((_, reject) => {
            fail = reject;
          }),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    rig.input.type(CTRL_C + CTRL_C);
    const boom = new Error('vault exploded');
    fail(boom);
    await expect(rig.exit).rejects.toBe(boom);
  });
});

describe('the terminal going away or misbehaving', () => {
  it('keeps a guard on output errors after the view ends, so a late one is not a crash', async () => {
    const rig = start(scripted());
    rig.input.type('q');
    await rig.exit;
    expect(() => rig.output.emit('error', new Error('write EIO'))).not.toThrow();
  });

  it('gives the screen back when raw mode cannot be turned on at start', async () => {
    const input = new FakeInput();
    input.setRawMode = (mode: boolean) => {
      if (mode) throw Object.assign(new Error('setRawMode EIO'), { code: 'EIO' });
      input.isRaw = false;
      return input;
    };
    const rig = start(scripted(), { stdin: input });
    await expect(rig.exit).rejects.toThrow('setRawMode EIO');
    expect(rig.output.all.lastIndexOf(LEAVE_SCREEN)).toBeGreaterThan(
      rig.output.all.lastIndexOf(ENTER_SCREEN),
    );
  });

  it('gives the screen back when raw mode cannot be turned on after a login window', async () => {
    const input = new FakeInput();
    let calls = 0;
    const real = input.setRawMode.bind(input);
    input.setRawMode = (mode: boolean) => {
      if (mode && ++calls === 2) throw new Error('setRawMode EBADF');
      return real(mode);
    };
    const rig = start(scripted({ addAccount: () => Promise.resolve({ message: 'Added x.' }) }), {
      stdin: input,
    });
    await until(() => expect(rig.output.text()).toContain('work'));
    input.type('a');
    input.type('x\r');
    await expect(rig.exit).rejects.toThrow('setRawMode EBADF');
    expect(rig.output.all.lastIndexOf(LEAVE_SCREEN)).toBeGreaterThan(
      rig.output.all.lastIndexOf(ENTER_SCREEN),
    );
  });

  it('on Ctrl-Break (SIGBREAK) on Windows, with the exit code it asks for', async () => {
    const rig = start(scripted(), { platform: 'win32' });
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.proc.emit('SIGBREAK');
    expect(await rig.exit).toEqual({ code: 149 });
    expectLeftScreen(rig);
  });

  it('draws at 80x24 when the terminal reports a size of zero', async () => {
    const output = new FakeOutput();
    output.columns = 0;
    output.rows = 0;
    const rig = start(scripted(), { stdout: output });
    await until(() => expect(output.text()).toContain('work'));
    expect(output.screen()).toHaveLength(24);
    rig.input.type('q');
    await rig.exit;
  });
});

describe('refusals in the words of the view', () => {
  it('names the account a vanished id belonged to', async () => {
    const rig = start(
      scripted({
        setExcluded: () =>
          Promise.reject(
            new AccountActionError(
              'not_found',
              'No account matches "05a0c5ac-e293-4504-8f60-33c988411d20".',
            ),
          ),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('e');
    await until(() =>
      expect(rig.output.text()).toContain('work is no longer stored; nothing was changed.'),
    );
    expect(rig.output.text()).not.toContain('05a0c5ac');
    rig.input.type('q');
    await rig.exit;
  });

  it('says how to force a switch the cadence guard held back, with a command that exists', async () => {
    const cause = new CadenceError('switched 1s ago; next switch allowed in 60s', 60_000);
    const rig = start(
      scripted({
        switchAccount: () =>
          Promise.reject(
            new AccountActionError('cadence', `${cause.message}. Use --force to override.`, {
              cause,
            }),
          ),
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await until(() => expect(rig.output.text()).toContain('next switch allowed in 60s'));
    expect(rig.output.text()).not.toContain('Use --force to override');
    expect(rig.output.text()).toContain("cctl switch 'work' --force");
    rig.input.type('q');
    await rig.exit;
  });

  it('keeps a warning logged during an action next to its outcome', async () => {
    const rig = start(
      scripted({
        switchAccount: () => {
          rig.log.write('refused to adopt the live token\n');
          return Promise.resolve({ message: 'Activated work.' });
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await until(() =>
      expect(rig.output.text()).toContain(
        'Activated work. Warning: refused to adopt the live token',
      ),
    );
    rig.input.type('q');
    await rig.exit;
  });

  it('prints the warnings of an action that faulted, after the screen is given back', async () => {
    const boom = new Error('EPERM: operation not permitted, rename');
    const rig = start(
      scripted({
        switchAccount: () => {
          rig.log.write('refused to adopt the live token\n');
          return Promise.reject(boom);
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await expect(rig.exit).rejects.toBe(boom);
    expectRestored(rig);
    const after = rig.output.all.slice(rig.output.all.lastIndexOf(LEAVE_SCREEN));
    expect(after).toContain('Warning: refused to adopt the live token');
  });

  it('keeps every warning and every line of one write', async () => {
    const rig = start(
      scripted({
        switchAccount: () => {
          rig.log.write('refused to adopt the live token\n');
          (rig.stderr.write as unknown as (s: string) => boolean)(
            'the vault was repaired\nsee the audit log\n',
          );
          return Promise.resolve({ message: 'Activated work.' });
        },
      }),
    );
    await until(() => expect(rig.output.text()).toContain('work'));
    rig.input.type('\r');
    await until(() => expect(rig.output.text()).toContain('Activated work. 3 warnings'));
    // The status line keeps the start and end; the message overlay has all of it.
    rig.input.type('m');
    const said = rig.output.text().split('\n').join(' ');
    for (const part of ['refused to adopt the live token', 'the vault was repaired', 'audit log']) {
      expect(said).toContain(part);
    }
    rig.input.type('q');
    rig.input.type('q');
    await rig.exit;
  });
});

describe('paintFrame', () => {
  it('erases to the end of a line only when the line stops short of the edge', () => {
    const H = `${ESC}[H`;
    const EL = `${ESC}[K`;
    const ED = `${ESC}[J`;
    expect(paintFrame(['abc', 'xy'], 3)).toBe(`${H}abc\r\nxy${EL}${ED}`);
    expect(paintFrame(['ab', 'xyz'], 3)).toBe(`${H}ab${EL}\r\nxyz`);
  });
});

describe('how wide the terminal draws ambiguous-width characters', () => {
  afterEach(() => setAmbiguousWidth(1));

  // An account row whose label, folder and poll error each hold characters a terminal set up for
  // CJK text draws two wide: at 80 columns it fills the line when they are counted one wide.
  const wideRow = (): TuiSources =>
    scripted({
      load: vi.fn(() =>
        Promise.resolve(
          snapshotOf([
            account('id-o', 'Ωmega·α', {
              folders: ['C:/proj—client'],
              usage: usage([], undefined, { error: 'HTTP 429 × 3 retries' }),
            }),
          ]),
        ),
      ),
    });
  const WIDE_HERE = /[—Ωα·×]/u;
  /** The columns a line takes on such a terminal, counted without the code under test. */
  const drawn = (line: string): number =>
    [...line].reduce((n, ch) => n + (WIDE_HERE.test(ch) ? 2 : 1), 0);
  const ANSWER_TWO = `${ESC}[2;3R`;

  it('is asked once, on the screen just entered, before the first frame', async () => {
    const rig = start(scripted());
    expect(rig.output.all.startsWith(ENTER_SCREEN + AMBIGUOUS_WIDTH_PROBE + `${ESC}[H`)).toBe(true);
    rig.input.type('q');
    await rig.exit;
    expect(rig.output.all.split(AMBIGUOUS_WIDTH_PROBE)).toHaveLength(2);
  });

  it('measures every cell two wide once the terminal answers that it draws them so', async () => {
    const rig = start(wideRow());
    rig.output.columns = 80;
    await until(() => expect(rig.output.text()).toContain('Ωmega'));
    rig.input.type(ANSWER_TWO);
    expect(ambiguousWidth()).toBe(2);
    await until(() => {
      const lines = rig.output.screen();
      expect(lines.join(' ')).toContain('Ωmega');
      for (const line of lines) expect(drawn(line), line).toBeLessThanOrEqual(80);
    });
    rig.input.type('q');
    await rig.exit;
  });

  it('takes an answer split across reads', async () => {
    const rig = start(scripted());
    rig.input.type(`${ESC}[2;`);
    rig.input.type('3R');
    expect(ambiguousWidth()).toBe(2);
    rig.input.type('q');
    await rig.exit;
  });

  it('keeps one column for a terminal that answers one, or does not answer', async () => {
    const one = start(scripted());
    one.input.type(`${ESC}[2;2R`);
    expect(ambiguousWidth()).toBe(1);
    one.input.type('q');
    await one.exit;
    const silent = start(scripted());
    silent.input.type('q');
    await silent.exit;
    expect(ambiguousWidth()).toBe(1);
  });

  it('does not take a modified F3 key, spelled as a report from row 1, for the answer', async () => {
    const rig = start(scripted());
    rig.input.type(`${ESC}[1;3R`);
    expect(ambiguousWidth()).toBe(1);
    // Nor is it a key: the view is still there to quit.
    rig.input.type('q');
    expect(await rig.exit).toEqual({ code: 0 });
  });

  it('only takes the first answer, and puts the width back when the view ends', async () => {
    const rig = start(scripted());
    rig.input.type(ANSWER_TWO);
    rig.input.type(`${ESC}[2;2R`);
    expect(ambiguousWidth()).toBe(2);
    rig.input.type('q');
    await rig.exit;
    expect(ambiguousWidth()).toBe(1);
    expectRestored(rig);
  });
});
