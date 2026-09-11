import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultError, type StoredAccount } from '@claude-control/switch-engine';
import { buildProgram } from './program.js';
import { VERSION, type SettingsReport } from './settings.js';

// `buildEngine` is the CLI's single seam onto the switch engine, so stubbing it lets an action
// body run for real — commander dispatch, the action, the render — with nothing near a real
// vault. Hoisted because the mock factory is evaluated during the import above.
const engine = vi.hoisted(() => ({
  backfillAccountMetadata: vi.fn(() => Promise.resolve(0)),
  listAccounts: vi.fn((): Promise<StoredAccount[]> => Promise.resolve([])),
  getActiveId: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  renameAccount: vi.fn((id: string, label: string): Promise<StoredAccount> =>
    Promise.reject(new Error(`renameAccount(${id}, ${label}) not stubbed`)),
  ),
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => engine,
}));
// config.json and the daemon's settings report are resolved through these seams, so the settings
// tests below write to per-test temp files and never near the operator's real ones, and `version`
// stays deterministic regardless of what daemon (if any) last ran on the box a test executes on.
const settingsIo = vi.hoisted(() => ({
  configPath: '',
  reportPath: '',
  readSettingsReport: vi.fn((): Promise<SettingsReport | undefined> => Promise.resolve(undefined)),
}));
vi.mock('./settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settings.js')>()),
  daemonConfigPath: () => settingsIo.configPath,
  daemonSettingsPath: () => settingsIo.reportPath,
  readSettingsReport: settingsIo.readSettingsReport,
}));
// The lifecycle commands' policy has its own unit tests against fake deps; here only the
// wiring is exercised (outcome → rendered lines, control error → the one error line), so the
// three operations are stubbed and nothing near a real daemon, task, or process is touched.
const controlIo = vi.hoisted(() => ({
  stopDaemon: vi.fn(),
  startDaemon: vi.fn(),
  restartDaemon: vi.fn(),
}));
vi.mock('./daemonControl.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./daemonControl.js')>()),
  stopDaemon: controlIo.stopDaemon,
  startDaemon: controlIo.startDaemon,
  restartDaemon: controlIo.restartDaemon,
}));

/** Run one command through commander with stdout/stderr captured and `process.exit` turned
 *  into a throw, so `fail()` surfaces as `exited` instead of ending the test runner. */
async function runCli(args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`exit ${String(code)}`);
  });
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { out: out.join(''), err: err.join(''), exited: false };
  } catch (e) {
    if (!(e instanceof Error) || !e.message.startsWith('exit ')) throw e;
    return { out: out.join(''), err: err.join(''), exited: true };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
}

/** Run one command with stdout captured, so the printed text can be asserted. */
async function run(argv: string[]): Promise<string> {
  let out = '';
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await buildProgram().parseAsync(argv, { from: 'user' });
  } finally {
    write.mockRestore();
  }
  return out;
}

describe('buildProgram', () => {
  it('exposes the expected command surface', () => {
    const names = buildProgram()
      .commands.map((c) => c.name())
      .sort();
    expect(names).toContain('accounts');
    expect(names).toContain('switch');
    expect(names).toContain('recover');
    expect(names).toContain('doctor');
    // Daemon-backed placeholders are present so the surface is discoverable.
    expect(names).toContain('usage');
    expect(names).toContain('timeline');
    expect(names).toContain('stats');
    expect(names).toContain('settings');
    expect(names).toContain('pair');
    expect(names).toContain('session');
    expect(names).toContain('version');
    // First-run + at-a-glance status surfaces.
    expect(names).toContain('setup');
    expect(names).toContain('status');
  });

  it('offers a --days window on stats, defaulting to a week', () => {
    const stats = buildProgram().commands.find((c) => c.name() === 'stats');
    const days = stats?.options.find((o) => o.long === '--days');
    expect(days).toBeDefined();
    expect(days?.defaultValue).toBe('7');
  });

  it('offers --reconfigure and --relay on setup', () => {
    const setup = buildProgram().commands.find((c) => c.name() === 'setup');
    expect(setup?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining(['--reconfigure', '--relay']),
    );
  });

  it('gives pair an optional code argument and a --relay override', () => {
    const pair = buildProgram().commands.find((c) => c.name() === 'pair');
    expect(pair?.options.map((o) => o.long)).toContain('--relay');
    // The optional [code] argument keeps pairing usable both interactively and as `cctl pair <code>`.
    expect(pair?.registeredArguments.map((a) => a.name())).toContain('code');
  });

  it('nests account subcommands including in-place relogin', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const subs = accounts?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['add', 'list', 'relogin', 'remove', 'rename']);
  });

  describe('accounts rename', () => {
    const work: StoredAccount = {
      id: 'id-1',
      label: 'work',
      quarantined: false,
      createdAtMs: 1,
      updatedAtMs: 1,
    };

    const rename = (args: string[]) => runCli(['accounts', 'rename', ...args]);

    // The new-label half of the line must be what the VAULT stored, not an echo of the
    // argument: the stub answers with a label differing from the raw arg in case and
    // whitespace, so an implementation printing the input would fail here.
    it('resolves the ref, renames by id and reports old name, stored name and id', async () => {
      engine.listAccounts.mockResolvedValueOnce([work]);
      engine.renameAccount.mockResolvedValueOnce({ ...work, label: 'Personal' });
      const r = await rename(['WORK', '  Personal  ']);
      expect(r.exited).toBe(false);
      // Trimming is the vault's job; the CLI hands the argument over untouched.
      expect(engine.renameAccount).toHaveBeenCalledWith('id-1', '  Personal  ');
      expect(r.out).toBe('Renamed work to Personal (id-1).\n');
    });

    it('answers a same-name rename without writing anything', async () => {
      engine.listAccounts.mockResolvedValueOnce([work]);
      engine.renameAccount.mockClear();
      const r = await rename(['work', ' work ']);
      expect(r.exited).toBe(false);
      expect(engine.renameAccount).not.toHaveBeenCalled();
      expect(r.out).toBe('work already has that label.\n');
    });

    it('turns a vault refusal (collision, empty label) into an error line and exit 1', async () => {
      engine.listAccounts.mockResolvedValueOnce([work]);
      engine.renameAccount.mockRejectedValueOnce(new VaultError('"home" already refers to x'));
      const r = await rename(['work', 'home']);
      expect(r.exited).toBe(true);
      expect(r.err).toBe('error: "home" already refers to x\n');
    });

    it('fails on an unknown ref before touching the engine', async () => {
      engine.listAccounts.mockResolvedValueOnce([work]);
      engine.renameAccount.mockClear();
      const r = await rename(['nope', 'x']);
      expect(r.exited).toBe(true);
      expect(r.err).toMatch(/No account matches "nope"/);
      expect(engine.renameAccount).not.toHaveBeenCalled();
    });
  });

  describe('settings set / unset', () => {
    let dir = '';
    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), 'cctl-settings-cli-'));
      settingsIo.configPath = join(dir, 'config.json');
    });
    afterEach(async () => {
      settingsIo.configPath = '';
      settingsIo.reportPath = '';
      await rm(dir, { recursive: true, force: true });
    });
    const config = async () =>
      JSON.parse(await readFile(settingsIo.configPath, 'utf8')) as Record<string, unknown>;

    it('nests set and unset under settings, keeping the bare view', async () => {
      const settings = buildProgram().commands.find((c) => c.name() === 'settings');
      expect(settings?.commands.map((c) => c.name()).sort()).toEqual(['set', 'unset']);
      // The parent action must still run with no subcommand — commander would otherwise print
      // help. With no daemon report on disk the daemon section is the preview, which reads the
      // (temp) config.json, so a persisted value is visible here without a daemon.
      settingsIo.reportPath = join(dir, 'daemon-settings.json');
      await runCli(['settings', 'set', 'fable-cap', 'off']);
      const r = await runCli(['settings']);
      expect(r.exited).toBe(false);
      expect(r.out).toContain('cli (this shell)');
      expect(r.out).toContain('no daemon has run yet');
      expect(r.out).toMatch(/fable cap trigger\s+off\s+config/);
    });

    it('lists every settable name when the name is unknown, even with no value given', async () => {
      const r = await runCli(['settings', 'set', 'x']);
      expect(r.exited).toBe(true);
      expect(r.err).toMatch(
        /"x" is not a daemon setting\. Settable: autoswitch \(CCTL_AUTOSWITCH\)/,
      );
      // A known name with no value gets the checker's own "takes …" line for that kind.
      const known = await runCli(['settings', 'set', 'trigger']);
      expect(known.exited).toBe(true);
      expect(known.err).toMatch(/CCTL_AUTOSWITCH_TRIGGER_PCT takes a non-negative number/);
      await expect(readFile(settingsIo.configPath, 'utf8')).rejects.toThrow();
    });

    it('persists a setting under its env var name, in any case, and says where it went', async () => {
      const r = await runCli(['settings', 'set', 'cctl_autoswitch', 'off']);
      expect(r.exited).toBe(false);
      expect(r.out).toContain(`Saved CCTL_AUTOSWITCH=off to ${settingsIo.configPath}.`);
      expect(r.out).toMatch(/next starts/);
      expect(await config()).toEqual({ env: { CCTL_AUTOSWITCH: 'off' } });
    });

    it('accepts the short alias and stores the value under the env var name', async () => {
      const r = await runCli(['settings', 'set', 'fable-cap', 'off']);
      expect(r.exited).toBe(false);
      expect(r.out).toContain('Saved CCTL_AUTOSWITCH_ON_FABLE_CAP=off to');
      expect(await config()).toEqual({ env: { CCTL_AUTOSWITCH_ON_FABLE_CAP: 'off' } });
      const gone = await runCli(['settings', 'unset', 'FABLE_CAP']);
      expect(gone.out).toContain('Removed CCTL_AUTOSWITCH_ON_FABLE_CAP from');
      expect(await config()).toEqual({});
    });

    it('stores the relay in its own field', async () => {
      const r = await runCli(['settings', 'set', 'relay', 'wss://relay.example.com']);
      expect(r.exited).toBe(false);
      expect(await config()).toEqual({ relayUrl: 'wss://relay.example.com' });
    });

    it('refuses a value the daemon would ignore, and writes nothing', async () => {
      const r = await runCli(['settings', 'set', 'CCTL_AUTOSWITCH', 'maybe']);
      expect(r.exited).toBe(true);
      expect(r.err).toMatch(/CCTL_AUTOSWITCH takes on or off/);
      await expect(readFile(settingsIo.configPath, 'utf8')).rejects.toThrow();
    });

    it('refuses an unknown name and lists what can be set', async () => {
      const r = await runCli(['settings', 'set', 'CCTL_NOPE', '1']);
      expect(r.exited).toBe(true);
      expect(r.err).toMatch(/"CCTL_NOPE" is not a daemon setting/);
      expect(r.err).toContain('fable-cap (CCTL_AUTOSWITCH_ON_FABLE_CAP)');
    });

    it('unset removes the entry, says when there was none, and never creates the file', async () => {
      const none = await runCli(['settings', 'unset', 'CCTL_AUTOSWITCH']);
      expect(none.exited).toBe(false);
      expect(none.out).toContain('CCTL_AUTOSWITCH is not set in');
      await expect(readFile(settingsIo.configPath, 'utf8')).rejects.toThrow();

      await runCli(['settings', 'set', 'CCTL_AUTOSWITCH', 'off']);
      const removed = await runCli(['settings', 'unset', 'CCTL_AUTOSWITCH']);
      expect(removed.exited).toBe(false);
      expect(removed.out).toContain('Removed CCTL_AUTOSWITCH from');
      expect(await config()).toEqual({});
    });

    it('turns a corrupt config file into an error rather than overwriting it', async () => {
      const { writeFile } = await import('node:fs/promises');
      await writeFile(settingsIo.configPath, '{not json', 'utf8');
      const r = await runCli(['settings', 'set', 'CCTL_AUTOSWITCH', 'off']);
      expect(r.exited).toBe(true);
      expect(r.err).toMatch(/not valid JSON/);
      expect(await readFile(settingsIo.configPath, 'utf8')).toBe('{not json');
    });
  });

  it('nests session subcommands', () => {
    const session = buildProgram().commands.find((c) => c.name() === 'session');
    const subs = session?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['label', 'register', 'status', 'unregister', 'watch']);
  });

  it('offers --session on the register/label/watch/unregister session commands', () => {
    const session = buildProgram().commands.find((c) => c.name() === 'session');
    for (const name of ['register', 'label', 'watch', 'unregister']) {
      const cmd = session?.commands.find((c) => c.name() === name);
      expect(cmd?.options.map((o) => o.long)).toContain('--session');
    }
  });

  it('offers --label on unregister as an alternative to --session', () => {
    const session = buildProgram().commands.find((c) => c.name() === 'session');
    const unregister = session?.commands.find((c) => c.name() === 'unregister');
    expect(unregister?.options.map((o) => o.long)).toContain('--label');
    // register already has its own --label (set at registration time) — unregister's is a
    // distinct alternative-ref flag, not a naming collision to worry about across commands.
    const register = session?.commands.find((c) => c.name() === 'register');
    expect(register?.options.map((o) => o.long)).toContain('--label');
  });

  it('offers the --fresh capture flag on accounts add', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const add = accounts?.commands.find((c) => c.name() === 'add');
    expect(add?.options.map((o) => o.long)).toContain('--fresh');
  });

  it('offers the --force cadence override on switch', () => {
    const cmd = buildProgram().commands.find((c) => c.name() === 'switch');
    expect(cmd?.options.map((o) => o.long)).toContain('--force');
  });

  it('nests a real daemon run subcommand with pairing, relay, and auto-switch flags', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const run = daemon?.commands.find((c) => c.name() === 'run');
    expect(run).toBeDefined();
    expect(run?.options.map((o) => o.long)).toEqual(
      expect.arrayContaining([
        '--pair',
        '--relay',
        '--auto-switch',
        '--no-auto-switch',
        '--greedy',
        '--no-greedy',
      ]),
    );
  });

  it('daemon supervise mirrors the run option surface (nothing can be forwarded wrong)', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const run = daemon?.commands.find((c) => c.name() === 'run');
    const supervise = daemon?.commands.find((c) => c.name() === 'supervise');
    expect(supervise).toBeDefined();
    expect(supervise?.options.map((o) => o.long).sort()).toEqual(
      run?.options.map((o) => o.long).sort(),
    );
  });

  it('nests the lifecycle, install, uninstall, status, and supervise alongside run under daemon', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const subs = daemon?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual([
      'install',
      'restart',
      'run',
      'start',
      'status',
      'stop',
      'supervise',
      'uninstall',
    ]);
  });

  // Asserting a version literal here only restated the constant one import away, so it stayed
  // green while the publishable package sat on a different number — a 0.3.0 tarball packed a
  // bundle that reported 0.2.2. The invariant worth holding is that the version a user is told
  // they are running is the version npm published, so read the real manifest instead.
  it('reports the version that gets published', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../cctl-publish/package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    expect(buildProgram().version()).toBe(manifest.version);
  });

  // Asserting the command SURFACE (above) says nothing about what an action does, and the engine's
  // own tests pass with the listing's call to it deleted — which is exactly the seam the original
  // defect shipped through: the bundle -> row mapping was right all along and only the wiring that
  // reaches non-live accounts was missing. So the wiring itself is the invariant to hold.
  it('repairs stale account metadata before reading the rows it renders', async () => {
    const order: string[] = [];
    engine.backfillAccountMetadata.mockImplementation(() => {
      order.push('repair');
      return Promise.resolve(0);
    });
    engine.listAccounts.mockImplementation(() => {
      order.push('read');
      return Promise.resolve([]);
    });
    const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    try {
      await buildProgram().parseAsync(['accounts', 'list'], { from: 'user' });
    } finally {
      write.mockRestore();
    }
    // Order, not just invocation: a repair that lands after the read still renders the stale rows.
    expect(order).toEqual(['repair', 'read']);
  });

  // Every autostart call site used to decide darwin-vs-everything-else on its own, so Linux (WSL
  // included) ran the Windows Scheduled Task backend and died on `spawnSync powershell.exe
  // ENOENT`. The CLI must answer with the platform fact and exit before it resolves a shim or
  // spawns anything — proven here by running the real action with the platform swapped.
  it('daemon install on a platform without autostart explains itself and exits 1', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`exit ${String(code)}`);
    });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(
        buildProgram().parseAsync(['daemon', 'install'], { from: 'user' }),
      ).rejects.toThrow('exit 1');
      const written = stderr.mock.calls.map((call) => String(call[0])).join('');
      expect(written).toContain('autostart is not available on this platform');
      expect(written).toContain('cctl daemon supervise');
    } finally {
      stderr.mockRestore();
      exit.mockRestore();
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
  });
});

describe('settings view beside a running daemon', () => {
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-settings-view-'));
    settingsIo.configPath = join(dir, 'config.json');
  });
  afterEach(async () => {
    settingsIo.configPath = '';
    settingsIo.readSettingsReport.mockReset().mockResolvedValue(undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('shows a saved value beside the running one and names the restart in the title', async () => {
    settingsIo.readSettingsReport.mockResolvedValue({
      startedAtMs: 0,
      settings: [
        { name: 'daemon build', value: `v${VERSION}`, source: 'default' },
        {
          name: 'fable cap trigger',
          value: 'on',
          source: 'default',
          detail: 'CCTL_AUTOSWITCH_ON_FABLE_CAP',
        },
      ],
    });
    await runCli(['settings', 'set', 'fable-cap', 'off']);
    const r = await runCli(['settings']);
    expect(r.exited).toBe(false);
    expect(r.out).toMatch(
      /daemon \(effective since .*; 1 setting changes at its next start: cctl daemon restart\)/,
    );
    expect(r.out).toMatch(/fable cap trigger\s+on \(off after restart\)\s+default/);
    // Once the daemon runs with it, nothing is pending and the title is bare again.
    settingsIo.readSettingsReport.mockResolvedValue({
      startedAtMs: 0,
      settings: [
        {
          name: 'fable cap trigger',
          value: 'off',
          source: 'config',
          detail: 'CCTL_AUTOSWITCH_ON_FABLE_CAP',
        },
      ],
    });
    const applied = await runCli(['settings']);
    expect(applied.out).toMatch(/daemon \(effective since [^;)]*\)\n/);
    expect(applied.out).not.toContain('after restart');
  });
});

describe('daemon stop / start / restart', () => {
  afterEach(() => {
    controlIo.stopDaemon.mockReset();
    controlIo.startDaemon.mockReset();
    controlIo.restartDaemon.mockReset();
  });
  const started = {
    outcome: 'started',
    how: 'background',
    report: {
      startedAtMs: 1,
      settings: [
        { name: 'daemon build', value: `v${VERSION}`, source: 'default' },
        { name: 'fable cap trigger', value: 'off', source: 'config' },
      ],
    },
  };

  it('prints each outcome as its lines', async () => {
    controlIo.stopDaemon.mockResolvedValue({ outcome: 'stopped', how: 'graceful', pid: 41 });
    expect((await runCli(['daemon', 'stop'])).out).toBe('Stopped the daemon (pid 41).\n');
    controlIo.startDaemon.mockResolvedValue(started);
    expect((await runCli(['daemon', 'start'])).out).toBe(
      `Started the daemon in the background (build v${VERSION}).\nSettings from config.json: fable cap trigger off.\n`,
    );
    controlIo.restartDaemon.mockResolvedValue({ stop: { outcome: 'not_running' }, start: started });
    const r = await runCli(['daemon', 'restart']);
    expect(r.out.startsWith('No daemon is running.\nStarted the daemon in the background')).toBe(
      true,
    );
  });

  it('turns a control refusal into the one error line and a non-zero exit', async () => {
    const { DaemonControlError } = await import('./daemonControl.js');
    controlIo.stopDaemon.mockRejectedValue(
      new DaemonControlError('the daemon (pid 41) acknowledged the stop but is still running'),
    );
    const r = await runCli(['daemon', 'stop']);
    expect(r.exited).toBe(true);
    expect(r.err).toBe('error: the daemon (pid 41) acknowledged the stop but is still running\n');
    expect(r.out).toBe('');
  });
});

describe('version command', () => {
  beforeEach(() => {
    settingsIo.readSettingsReport.mockReset().mockResolvedValue(undefined);
  });

  it('prints the cli build and says no daemon has run when there is no report', async () => {
    const out = await run(['version']);
    expect(out).toContain(`cli build: v${VERSION}`);
    expect(out).toContain('no daemon has run');
  });

  it('prints both builds when the daemon has reported one', async () => {
    settingsIo.readSettingsReport.mockResolvedValue({
      startedAtMs: 0,
      settings: [{ name: 'daemon build', value: `v${VERSION}`, source: 'default' }],
    });
    const out = await run(['version']);
    expect(out).toContain(`cli build: v${VERSION}`);
    expect(out).toContain(`daemon build: v${VERSION}`);
  });
});

describe('help', () => {
  // Commander's own `help` dispatch always ends by calling `process.exit` (see `Command.help()`)
  // — a bare-program `.action()` (the `cctl` summary above) is exactly the condition that makes
  // Commander skip adding its implicit help command in the first place (see `_getHelpCommand`),
  // so this exercises the real dispatch path rather than asserting our fix from the outside.
  // `exitOverride()` can't substitute here: it only takes effect on subcommands created AFTER
  // it is called, and every subcommand is already built by the time a test gets `buildProgram()`'s
  // return value — so the exit itself is turned into a throw instead, unwinding the same way
  // `exitOverride` would, without ever reaching a real `process.exit` in the test worker.
  async function captureHelp(argv: string[]): Promise<string> {
    let out = '';
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('__test_process_exit__');
    });
    try {
      await buildProgram().parseAsync(argv, { from: 'user' });
    } catch (err) {
      if (!(err instanceof Error) || err.message !== '__test_process_exit__') throw err;
    } finally {
      write.mockRestore();
      exit.mockRestore();
    }
    return out;
  }

  it('prints top-level usage for `cctl help`', async () => {
    const out = await captureHelp(['help']);
    expect(out).toContain('Usage: cctl');
  });

  it("resolves `cctl help <command>` to that command's own usage", async () => {
    const out = await captureHelp(['help', 'switch']);
    expect(out).toContain('Usage: cctl switch');
  });
});

/** Run `body` with the named stream pretending to be a terminal and NO_COLOR unset — the one
 *  condition under which the CLI paints — restoring both afterwards. */
async function onTerminal<T>(stream: NodeJS.WriteStream, body: () => Promise<T>): Promise<T> {
  const had = Object.getOwnPropertyDescriptor(stream, 'isTTY');
  Object.defineProperty(stream, 'isTTY', { value: true, configurable: true, writable: true });
  vi.stubEnv('NO_COLOR', undefined);
  try {
    return await body();
  } finally {
    vi.unstubAllEnvs();
    if (had) Object.defineProperty(stream, 'isTTY', had);
    else delete (stream as { isTTY?: boolean }).isTTY;
  }
}

describe('color on a terminal', () => {
  const ESC = String.fromCharCode(27);
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-color-cli-'));
    settingsIo.configPath = join(dir, 'config.json');
  });
  afterEach(async () => {
    settingsIo.configPath = '';
    await rm(dir, { recursive: true, force: true });
  });

  it('paints the saved assignment and the removal green, and nothing when piped', async () => {
    const saved = await onTerminal(process.stdout, () =>
      runCli(['settings', 'set', 'fable-cap', 'off']),
    );
    expect(saved.out).toContain(`${ESC}[32mSaved CCTL_AUTOSWITCH_ON_FABLE_CAP=off${ESC}[0m to `);
    const removed = await onTerminal(process.stdout, () =>
      runCli(['settings', 'unset', 'fable-cap']),
    );
    expect(removed.out).toContain(`${ESC}[32mRemoved CCTL_AUTOSWITCH_ON_FABLE_CAP${ESC}[0m from `);
    // Piped — the default in this worker — the same lines carry no code at all.
    const piped = await runCli(['settings', 'set', 'fable-cap', 'off']);
    expect(piped.out).toContain('Saved CCTL_AUTOSWITCH_ON_FABLE_CAP=off to ');
    expect(piped.out).not.toContain(ESC);
  });

  it("paints fail()'s line red when stderr is a terminal, judged by stderr alone", async () => {
    const r = await onTerminal(process.stderr, () =>
      runCli(['settings', 'set', 'fable-cap', 'maybe']),
    );
    expect(r.exited).toBe(true);
    expect(r.err.startsWith(`${ESC}[31merror: CCTL_AUTOSWITCH_ON_FABLE_CAP takes `)).toBe(true);
    expect(r.err.endsWith(`${ESC}[0m\n`)).toBe(true);
    // A terminal on stdout does not color stderr: `cctl x 2>err.log` stays plain.
    const redirected = await onTerminal(process.stdout, () =>
      runCli(['settings', 'set', 'fable-cap', 'maybe']),
    );
    expect(redirected.exited).toBe(true);
    expect(redirected.err).not.toContain(ESC);
  });

  it("paints commander's own refusals the same red", async () => {
    const r = await onTerminal(process.stderr, () => runCli(['settings', 'unset']));
    expect(r.exited).toBe(true);
    expect(r.err).toBe(`${ESC}[31merror: missing required argument 'name'${ESC}[0m\n`);
  });
});
