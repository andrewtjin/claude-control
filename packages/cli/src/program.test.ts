import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VaultError, type StoredAccount } from '@claude-control/switch-engine';
import { buildProgram } from './program.js';
import { CliFailure } from './context.js';
import { VERSION, type SettingsReport } from './settings.js';

// `buildEngine` is the CLI's single seam onto the switch engine, so stubbing it lets an action
// body run for real — commander dispatch, the action, the render — with nothing near a real
// vault. Hoisted because the mock factory is evaluated during the import above.
const engine = vi.hoisted(() => ({
  backfillAccountMetadata: vi.fn(() => Promise.resolve(0)),
  listAccounts: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  getActiveId: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  setAutoSwitchExcluded: vi.fn(() => Promise.resolve()),
  renameAccount: vi.fn((id: string, label: string): Promise<StoredAccount> =>
    Promise.reject(new Error(`renameAccount(${id}, ${label}) not stubbed`)),
  ),
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => engine,
}));
/// config.json and the daemon's settings report are resolved through these seams, so the settings
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

/** Run one command through commander with stdout/stderr captured. `fail()` throws a CliFailure
 *  that the entry point turns into an error line and exit 1, so a refusal comes back here as
 *  `exited` with that line in `err`; a stray `process.exit` is turned into a throw as well. */
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
    if (e instanceof CliFailure) {
      return { out: out.join(''), err: err.join('') + `error: ${e.message}\n`, exited: true };
    }
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

  it('nests account subcommands including both in-place re-login verbs', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const subs = accounts?.commands.map((c) => c.name()).sort();
    // `relogin` spawns a browser login on this host; `reauth` takes a pasted code instead, so a
    // headless/SSH host has a path too.
    expect(subs).toEqual([
      'add',
      'exclude',
      'include',
      'list',
      'reauth',
      'relogin',
      'remove',
      'rename',
    ]);
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

  it('nests install, uninstall, status, and supervise alongside run under daemon', () => {
    const daemon = buildProgram().commands.find((c) => c.name() === 'daemon');
    const subs = daemon?.commands.map((c) => c.name()).sort();
    expect(subs).toEqual(['install', 'run', 'status', 'supervise', 'uninstall']);
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
  // ENOENT`. The CLI must answer with the platform fact and fail before it resolves a shim or
  // spawns anything — proven here by running the real action with the platform swapped. `fail`
  // throws a CliFailure that the entry point turns into the non-zero exit.
  it('daemon install on a host without autostart explains itself and fails', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    // Pin the Linux backend off: the real probes would otherwise answer for whatever box runs
    // the tests (a CI runner with a systemd user manager gets a real backend and a real unit).
    const previousOverride = process.env.CCTL_AUTOSTART_BACKEND;
    process.env.CCTL_AUTOSTART_BACKEND = 'none';
    try {
      const run = buildProgram().parseAsync(['daemon', 'install'], { from: 'user' });
      await expect(run).rejects.toBeInstanceOf(CliFailure);
      await expect(run).rejects.toThrow('autostart is not available on this platform');
      await expect(run).rejects.toThrow('cctl daemon supervise');
      await expect(run).rejects.toThrow('CCTL_AUTOSTART_BACKEND=none');
    } finally {
      if (previousOverride === undefined) delete process.env.CCTL_AUTOSTART_BACKEND;
      else process.env.CCTL_AUTOSTART_BACKEND = previousOverride;
      if (platform) Object.defineProperty(process, 'platform', platform);
    }
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

// Exclusion is a registry write behind a resolved ref, so the verbs are worth running for real:
// a typo'd command name or a wrong-way-round boolean would sail past a surface-only assertion.
describe('accounts exclude / include', () => {
  const row = (extra: Record<string, unknown> = {}) => ({
    id: 'id-1',
    label: 'Work',
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
    ...extra,
  });

  beforeEach(() => {
    engine.setAutoSwitchExcluded.mockClear();
    engine.backfillAccountMetadata.mockImplementation(() => Promise.resolve(0));
  });

  it('excludes an account by label and says what changed', async () => {
    engine.listAccounts.mockImplementation(() => Promise.resolve([row()]));
    const out = await run(['accounts', 'exclude', 'Work']);
    expect(engine.setAutoSwitchExcluded).toHaveBeenCalledWith('id-1', true);
    expect(out).toMatch(/Excluded Work from auto-switch/);
  });

  it('includes an excluded account again', async () => {
    engine.listAccounts.mockImplementation(() =>
      Promise.resolve([row({ autoSwitchExcluded: true })]),
    );
    const out = await run(['accounts', 'include', 'Work']);
    expect(engine.setAutoSwitchExcluded).toHaveBeenCalledWith('id-1', false);
    expect(out).toMatch(/available to auto-switch again/);
  });

  it('reports a no-op honestly instead of claiming a change it did not make', async () => {
    engine.listAccounts.mockImplementation(() =>
      Promise.resolve([row({ autoSwitchExcluded: true })]),
    );
    const excluded = await run(['accounts', 'exclude', 'Work']);
    expect(excluded).toMatch(/already excluded/);

    engine.listAccounts.mockImplementation(() => Promise.resolve([row()]));
    const included = await run(['accounts', 'include', 'Work']);
    expect(included).toMatch(/already available/);

    expect(engine.setAutoSwitchExcluded).not.toHaveBeenCalled();
  });
});
