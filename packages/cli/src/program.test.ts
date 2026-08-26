import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildProgram } from './program.js';

// `buildEngine` is the CLI's single seam onto the switch engine, so stubbing it lets an action
// body run for real — commander dispatch, the action, the render — with nothing near a real
// vault. Hoisted because the mock factory is evaluated during the import above.
const engine = vi.hoisted(() => ({
  backfillAccountMetadata: vi.fn(() => Promise.resolve(0)),
  listAccounts: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  getActiveId: vi.fn((): Promise<string | null> => Promise.resolve(null)),
  setAutoSwitchExcluded: vi.fn(() => Promise.resolve()),
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => engine,
}));

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
    expect(subs).toEqual(['add', 'exclude', 'include', 'list', 'reauth', 'relogin', 'remove']);
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

  /** Run one command with stdout captured, so the printed line can be asserted. */
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
