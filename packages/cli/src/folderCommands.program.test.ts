// Program-level coverage for the folder-rule commands: commander dispatch, the action, the render,
// against a stubbed engine and a sandboxed data folder — nothing near a real vault, a real
// ~/.claude/settings.json, or a real daemon.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RefreshError,
  SlotError,
  type AccountView,
  type ActivateResult,
  type FolderRule,
  type PoolEntry,
} from '@claude-control/switch-engine';
import { BIND_GUARD_MARKER } from '@claude-control/daemon';
import { buildProgram } from './program.js';
import { CliFailure, reportFatal } from './context.js';
import type { SettingsReport } from './settings.js';

// Every path the commands resolve (vault, profiles, the guard's settings.json, daemon.db) lands in a
// per-test sandbox: the guard install that follows a successful rule change must never touch the
// operator's real Claude settings.
const sandbox = vi.hoisted(() => ({ root: '' }));
vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return {
    ...real,
    defaultPaths: () => {
      if (sandbox.root === '') throw new Error('test ran outside its sandbox');
      return real.sandboxPaths(sandbox.root);
    },
  };
});

// The CLI's single seam onto the switch engine.
const engine = vi.hoisted(() => ({
  backfillAccountMetadata: vi.fn(() => Promise.resolve(0)),
  dedupeAccounts: vi.fn(() => Promise.resolve({ merged: [], relabelled: [] })),
  listAccounts: vi.fn((): Promise<AccountView[]> => Promise.resolve([])),
  listAllAccounts: vi.fn((): Promise<AccountView[]> => Promise.resolve([])),
  listRules: vi.fn((): Promise<FolderRule[]> => Promise.resolve([])),
  liveSlots: vi.fn((): Promise<Map<string, string | null>> => Promise.resolve(new Map())),
  getRule: vi.fn((): Promise<FolderRule | undefined> => Promise.resolve(undefined)),
  slotPool: vi.fn((_slot: string): Promise<PoolEntry[]> => Promise.resolve([])),
  getGuardSnapshotFreshness: vi.fn(() =>
    Promise.resolve({
      present: true,
      fresh: true,
      enforce: 'block' as const,
      generation: 1,
    }),
  ),
  checkSlots: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  includeInFolder: vi.fn(),
  excludeInFolder: vi.fn(),
  resetFolder: vi.fn(),
  ensureRuleLive: vi.fn(),
  activate: vi.fn((id: string): Promise<ActivateResult> =>
    Promise.reject(new Error(`activate(${id})`)),
  ),
  getActiveId: vi.fn((): Promise<string | null> => Promise.resolve(null)),
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => engine,
}));

// The daemon's settings report and heartbeat, per test: they decide the older-daemon refusal.
const settingsIo = vi.hoisted(() => ({
  configPath: '',
  heartbeatPath: '',
  readSettingsReport: vi.fn((): Promise<SettingsReport | undefined> => Promise.resolve(undefined)),
}));
vi.mock('./settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./settings.js')>()),
  daemonConfigPath: () => settingsIo.configPath,
  daemonSettingsPath: () => '',
  daemonHeartbeatPath: () => settingsIo.heartbeatPath,
  readSettingsReport: settingsIo.readSettingsReport,
}));

// `cctl claude` finds and spawns the real executable; here it spawns nothing and reports the env.
const launcher = vi.hoisted(() => ({
  spawnClaude: vi.fn((_opts: { command: string; args: string[]; env: NodeJS.ProcessEnv }) =>
    Promise.resolve(0),
  ),
}));
vi.mock('./launcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./launcher.js')>()),
  findClaudeOnPath: () => 'claude',
  resolveLaunchTarget: () => ({ kind: 'run', command: 'claude', prefixArgs: [] }),
  spawnClaude: launcher.spawnClaude,
}));

/** Run one command with stdout/stderr captured; a refusal comes back as `exited` with its line. */
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
      // The entry point's own reporter, so the line comes back exactly as stderr would see it.
      reportFatal(e);
      process.exitCode = undefined;
      return { out: out.join(''), err: err.join(''), exited: true };
    }
    // Commander's own refusals (a missing argument, an unknown command) end in process.exit.
    if (!(e instanceof Error) || !e.message.startsWith('exit ')) throw e;
    return { out: out.join(''), err: err.join(''), exited: true };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
    exit.mockRestore();
  }
}

const account = (id: string, over: Partial<AccountView> = {}): AccountView => ({
  id,
  label: id,
  quarantined: false,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const ruleOn = (folder: string, over: Partial<FolderRule> = {}): FolderRule => ({
  id: 'r1',
  label: 'research',
  folders: [folder],
  include: [],
  exclude: [],
  activeId: null,
  createdAtMs: 0,
  updatedAtMs: 0,
  ...over,
});

const supportedReport: SettingsReport = {
  startedAtMs: 1,
  settings: [
    { name: 'daemon build', value: 'v1.0.0', source: 'default' },
    { name: 'folder rules', value: 'supported', source: 'default' },
  ],
};
const olderReport: SettingsReport = {
  startedAtMs: 1,
  settings: [{ name: 'daemon build', value: 'v0.5.2', source: 'default' }],
};

// A shared account A (live globally), a shared account B, and E, reserved to the research folder.
const A = account('a', { label: 'A', emailAddress: 'a@example.com' });
const B = account('b', { label: 'B' });
const E = account('e', { label: 'E', emailAddress: 'e@example.com', ruleIds: ['r1'] });

let research = '';

beforeEach(async () => {
  sandbox.root = await mkdtemp(join(tmpdir(), 'cctl-folder-cli-'));
  research = join(sandbox.root, 'repos', 'research');
  await mkdir(research, { recursive: true });
  // The canonical form the CLI compares folders in (8.3 names and symlinks resolved).
  research = realpathSync.native(research);
  settingsIo.configPath = join(sandbox.root, 'config.json');
  settingsIo.heartbeatPath = join(sandbox.root, 'daemon-heartbeat.json');
  settingsIo.readSettingsReport.mockResolvedValue(undefined);
  vi.stubEnv('NO_COLOR', '1');
  for (const fn of Object.values(engine)) fn.mockClear();
  engine.listAccounts.mockResolvedValue([A, B]);
  engine.listAllAccounts.mockResolvedValue([A, B, E]);
  engine.listRules.mockResolvedValue([]);
  engine.liveSlots.mockResolvedValue(new Map([['global', 'a']]));
  engine.slotPool.mockResolvedValue([]);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(sandbox.root, { recursive: true, force: true });
  sandbox.root = '';
});

/** A daemon heartbeat written just now: the daemon counts as running. */
async function daemonRunning(report: SettingsReport | undefined): Promise<void> {
  await writeFile(settingsIo.heartbeatPath, JSON.stringify({ writtenAtMs: Date.now() }));
  settingsIo.readSettingsReport.mockResolvedValue(report);
}

describe('cctl folder include', () => {
  it('refuses a missing account argument instead of using the account in use', async () => {
    const r = await runCli(['folder', 'include', research]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain("missing required argument 'accounts'");
    expect(engine.includeInFolder).not.toHaveBeenCalled();
    // Not even asked which account is live: there is no default to fall back to.
    expect(engine.getActiveId).not.toHaveBeenCalled();
  });

  it('refuses an account argument that names no account', async () => {
    const r = await runCli(['folder', 'include', research, ' , ']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('folder include needs at least one account');
    expect(engine.includeInFolder).not.toHaveBeenCalled();
    expect(engine.getActiveId).not.toHaveBeenCalled();
  });

  it('refuses an unknown account and changes nothing', async () => {
    const r = await runCli(['folder', 'include', research, 'E,ghost']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('No account matches "ghost"');
    expect(engine.includeInFolder).not.toHaveBeenCalled();
  });

  it('resolves labels, emails and ids across the whole registry and reports every change', async () => {
    const after = ruleOn(research, { include: ['e', 'b'] });
    engine.includeInFolder.mockResolvedValueOnce({
      rule: after,
      created: true,
      reserved: ['b'],
      unexcluded: [],
      handedOff: [{ slot: 'global', from: 'b', to: 'a' }],
      live: { ruleId: 'r1', liveAccount: 'e', activated: true, noWorkingAccount: false },
      runningSessions: [{ pid: 7, cwd: research, sessionFile: 's.json' }],
    });
    engine.listRules.mockResolvedValue([after]);
    engine.listAllAccounts.mockResolvedValue([A, { ...B, ruleIds: ['r1'] }, E]);

    const r = await runCli([
      'folder',
      'include',
      research,
      'e@example.com, b',
      '--label',
      'research',
    ]);

    expect(r.exited).toBe(false);
    expect(engine.includeInFolder).toHaveBeenCalledWith(research, ['e', 'b'], {
      label: 'research',
    });
    expect(r.out).toContain(`Created a folder rule on ${research}: it uses E, B first`);
    expect(r.out).toContain('reserved: B left the shared pool');
    expect(r.out).toContain('the global slot switched off B (now reserved) and is on A.');
    expect(r.out).toContain("live in the folder's slot: E (included)");
    expect(r.out).toContain('1 running session(s) under this folder keep their current account');
    // The guard is wired at once, in the sandboxed settings.json.
    const settings = await readFile(join(sandbox.root, 'claude', 'settings.json'), 'utf8');
    expect(settings).toContain(BIND_GUARD_MARKER);
  });

  it('surfaces an engine refusal as a single error line', async () => {
    engine.includeInFolder.mockRejectedValueOnce(
      new RefreshError(
        'the global slot has no other shared account to move to',
        'no_shared_account_remains',
      ),
    );
    const r = await runCli(['folder', 'include', research, 'A']);
    expect(r.exited).toBe(true);
    expect(r.err).toBe('error: the global slot has no other shared account to move to\n');
  });

  it('refuses while a daemon that predates folder rules is running, naming the fix', async () => {
    await daemonRunning(olderReport);
    const r = await runCli(['folder', 'include', research, 'E']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('the running daemon (v0.5.2) predates folder rules');
    expect(r.err).toContain('cctl daemon restart');
    expect(r.err).toContain('Nothing was changed.');
    expect(engine.includeInFolder).not.toHaveBeenCalled();
  });

  it('goes ahead while a daemon that honors folder rules is running', async () => {
    await daemonRunning(supportedReport);
    engine.includeInFolder.mockResolvedValueOnce({
      rule: ruleOn(research, { include: ['e'] }),
      created: false,
      reserved: [],
      unexcluded: [],
      handedOff: [],
      live: { ruleId: 'r1', liveAccount: 'e', activated: false, noWorkingAccount: false },
      runningSessions: [],
    });
    const r = await runCli(['folder', 'include', research, 'E']);
    expect(r.exited).toBe(false);
    expect(r.out).toContain(`Included E in the folder rule on ${research}.`);
  });

  it('goes ahead when the older daemon has stopped', async () => {
    await writeFile(
      settingsIo.heartbeatPath,
      JSON.stringify({ writtenAtMs: Date.now(), stoppedAtMs: Date.now() }),
    );
    settingsIo.readSettingsReport.mockResolvedValue(olderReport);
    engine.includeInFolder.mockRejectedValueOnce(new RefreshError('reached the engine', 'x'));
    const r = await runCli(['folder', 'include', research, 'E']);
    expect(r.err).toContain('reached the engine');
  });
});

describe('cctl folder exclude', () => {
  it('refuses a missing account argument', async () => {
    const r = await runCli(['folder', 'exclude', research]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain("missing required argument 'accounts'");
    expect(engine.excludeInFolder).not.toHaveBeenCalled();
  });

  it('passes --force and reports the slot moving off the excluded account', async () => {
    const after = ruleOn(research, { exclude: ['a'] });
    engine.excludeInFolder.mockResolvedValueOnce({
      rule: after,
      created: false,
      movedOff: 'a',
      live: { ruleId: 'r1', liveAccount: 'b', activated: true, noWorkingAccount: false },
      runningSessions: [],
    });
    engine.listRules.mockResolvedValue([after]);
    const r = await runCli(['folder', 'exclude', research, 'A', '--force']);
    expect(r.exited).toBe(false);
    expect(engine.excludeInFolder).toHaveBeenCalledWith(research, ['a'], { force: true });
    expect(r.out).toContain(`Excluded A from the folder rule on ${research}.`);
    expect(r.out).toContain('A stays usable everywhere else.');
    expect(r.out).toContain("the folder's slot switched off A.");
    expect(r.out).toContain("live in the folder's slot: B (inherited from the shared pool)");
  });

  it('refuses while a daemon that predates folder rules is running', async () => {
    await daemonRunning(undefined);
    const r = await runCli(['folder', 'exclude', research, 'A']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('predates folder rules');
    expect(engine.excludeInFolder).not.toHaveBeenCalled();
  });

  it('surfaces the refusal to exclude a reserved account', async () => {
    engine.excludeInFolder.mockRejectedValueOnce(
      new RefreshError(
        'account "E" is reserved to a folder rule; only a shared account can be excluded',
        'x',
      ),
    );
    const r = await runCli(['folder', 'exclude', research, 'E']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('only a shared account can be excluded');
  });
});

describe('cctl folder reset', () => {
  it('with no accounts removes the whole rule and says what that did', async () => {
    const before = ruleOn(research, { include: ['e'] });
    engine.listRules.mockResolvedValueOnce([before]).mockResolvedValue([]);
    engine.resetFolder.mockResolvedValueOnce({
      folder: research,
      dissolved: true,
      released: ['e'],
      adoptedRotation: false,
      runningSessions: [],
    });
    const r = await runCli(['folder', 'reset', research]);
    expect(r.exited).toBe(false);
    expect(engine.resetFolder).toHaveBeenCalledWith(research, undefined, {});
    expect(r.out).toContain(`Removed the folder rule on ${research}.`);
    expect(r.out).toContain('now uses the global slot and the shared pool');
    expect(r.out).toContain('returned to the shared pool: E.');
  });

  it('with accounts drops just those and reports the slot', async () => {
    const before = ruleOn(research, { include: ['e'], exclude: ['a'] });
    const after = ruleOn(research, { include: ['e'] });
    engine.listRules.mockResolvedValueOnce([before]).mockResolvedValue([after]);
    engine.resetFolder.mockResolvedValueOnce({
      folder: research,
      dissolved: false,
      rule: after,
      released: [],
      adoptedRotation: false,
      runningSessions: [],
    });
    engine.liveSlots.mockResolvedValue(new Map([['group:r1', 'e']]));
    const r = await runCli(['folder', 'reset', research, 'A', '--force']);
    expect(engine.resetFolder).toHaveBeenCalledWith(research, ['a'], { force: true });
    expect(r.out).toContain(`Removed A from what ${research} excludes`);
    expect(r.out).toContain("live in the folder's slot: E (included)");
  });

  it('never reads an empty account list as "remove the whole rule"', async () => {
    const r = await runCli(['folder', 'reset', research, ',']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('folder reset needs at least one account');
    expect(engine.resetFolder).not.toHaveBeenCalled();
  });

  it('surfaces a refusal to reset a folder with no rule', async () => {
    engine.resetFolder.mockRejectedValueOnce(
      new RefreshError(`"${research}" has no folder rule`, 'not_ruled'),
    );
    const r = await runCli(['folder', 'reset', research]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('has no folder rule');
  });
});

describe('cctl folders', () => {
  it('says there are no rules and how to add one', async () => {
    const r = await runCli(['folders']);
    expect(r.out).toContain('No folder rules');
    expect(r.out).toContain('cctl folder include <folder>');
  });

  it('lists each rule with its includes, excludes, live account and pool, then the global slot', async () => {
    const rule = ruleOn(research, { include: ['e'], exclude: ['b'] });
    engine.listRules.mockResolvedValue([rule]);
    engine.liveSlots.mockResolvedValue(
      new Map([
        ['global', 'a'],
        ['group:r1', 'e'],
      ]),
    );
    engine.slotPool.mockImplementation((slot: string) =>
      Promise.resolve(
        slot === 'global'
          ? [
              { account: A, source: 'inherited', autoTarget: true, liveElsewhere: null },
              { account: B, source: 'inherited', autoTarget: true, liveElsewhere: null },
            ]
          : [
              { account: E, source: 'include', autoTarget: true, liveElsewhere: null },
              { account: A, source: 'inherited', autoTarget: true, liveElsewhere: 'global' },
            ],
      ),
    );
    const r = await runCli(['folders']);
    expect(r.out).toContain(`folder:   ${research}`);
    expect(r.out).toContain('includes: E');
    expect(r.out).toContain('excludes: B');
    expect(r.out).toContain('live:     E (included)');
    expect(r.out).toContain('1. E  included, live here');
    expect(r.out).toContain('2. A  inherited, live in the global slot');
    expect(r.out).toContain('every other folder (the global slot)');
    expect(r.out).toContain('guard snapshot: fresh');
  });
});

describe('cctl where', () => {
  it('explains a folder with no rule as the global slot, with its pool', async () => {
    engine.slotPool.mockResolvedValue([
      { account: A, source: 'inherited', autoTarget: true, liveElsewhere: null },
    ]);
    const r = await runCli(['where', research]);
    expect(r.out).toContain('no folder rule applies here');
    expect(r.out).toContain('live:    A');
    expect(r.out).toContain('cctl folder include');
  });

  it('explains a ruled subfolder by the rule that matched, with the env line', async () => {
    const sub = join(research, 'sub');
    await mkdir(sub);
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    engine.liveSlots.mockResolvedValue(new Map([['group:r1', 'a']]));
    const r = await runCli(['where', sub]);
    expect(r.out).toContain('runs on:  the folder rule research');
    expect(r.out).toContain(`matched:  ${research}`);
    expect(r.out).toContain(
      'live:     A (inherited from the shared pool: no included account is available)',
    );
    expect(r.out).toContain('CLAUDE_CONFIG_DIR=');
    expect(r.out).toContain('claudeCode.environmentVariables');
  });
});

describe('cctl switch --folder', () => {
  const activated: ActivateResult = {
    ok: true,
    activeAccountId: 'a',
    wroteCredentials: true,
    refreshed: false,
    adoptedPreviousRotation: false,
  };

  it("puts the account in the slot of the folder's rule", async () => {
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    engine.activate.mockResolvedValueOnce(activated);
    engine.liveSlots.mockResolvedValue(new Map([['group:r1', 'a']]));
    const r = await runCli(['switch', 'A', '--folder', research]);
    expect(r.exited).toBe(false);
    expect(engine.activate).toHaveBeenCalledWith('a', {
      force: false,
      origin: 'manual',
      slot: 'group:r1',
    });
    expect(r.out).toContain(`Activated A in the folder slot of ${research}`);
  });

  it('uses the global slot for a folder no rule applies to, and says so', async () => {
    engine.activate.mockResolvedValueOnce(activated);
    const r = await runCli(['switch', 'A', '--folder', research]);
    expect(engine.activate).toHaveBeenCalledWith('a', expect.objectContaining({ slot: 'global' }));
    expect(r.out).toContain('in the global slot (no folder rule applies to');
  });

  it('turns a live-elsewhere refusal into plain words', async () => {
    engine.listRules.mockResolvedValue([ruleOn(research)]);
    engine.activate.mockRejectedValueOnce(
      new SlotError(
        'account "A" is live in the global slot, and an account is live in one slot at a time',
        'live_elsewhere',
      ),
    );
    const r = await runCli(['switch', 'A', '--folder', research]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('is live in the global slot');
    expect(r.err).toContain('Nothing was changed - switch that slot to another account first');
  });

  it('turns a slot mismatch into plain words', async () => {
    engine.listRules.mockResolvedValue([ruleOn(research, { exclude: ['a'] })]);
    engine.activate.mockRejectedValueOnce(
      new SlotError(
        'account "A" cannot be live in the folder slot: that folder excludes it',
        'slot_mismatch',
      ),
    );
    const r = await runCli(['switch', 'A', '--folder', research]);
    expect(r.err).toContain('that folder excludes it. Nothing was changed - pick an account');
  });

  it('without --folder, points an ambiguous account at --folder', async () => {
    engine.listAllAccounts.mockResolvedValue([A, { ...E, ruleIds: ['r1', 'r2'] }]);
    engine.activate.mockRejectedValueOnce(
      new SlotError('account "E" is included by several folder rules', 'slot_ambiguous'),
    );
    const r = await runCli(['switch', 'E']);
    // No slot asserted: the engine picks the one it is live in, or refuses.
    expect(engine.activate).toHaveBeenCalledWith('e', { force: false, origin: 'manual' });
    expect(r.err).toContain('name the folder: cctl switch E --folder <folder>');
  });
});

describe('cctl accounts list', () => {
  it('shows every reserved account with its email and the folders that include it', async () => {
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    engine.liveSlots.mockResolvedValue(new Map([['group:r1', 'e']]));
    const r = await runCli(['accounts', 'list']);
    expect(r.out).toContain('Reserved to folder rules');
    const line = r.out.split('\n').find((l) => l.includes('e@example.com'));
    expect(line).toBeDefined();
    expect(line).toContain(research);
    expect(line?.startsWith('*')).toBe(true);
  });

  it('adds nothing when no folder has a rule', async () => {
    const r = await runCli(['accounts', 'list']);
    expect(r.out).not.toContain('Reserved to folder rules');
  });
});

describe('cctl usage and timeline', () => {
  it('end on each folder rule with its live account and pool', async () => {
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    engine.liveSlots.mockResolvedValue(new Map([['group:r1', 'e']]));
    engine.slotPool.mockResolvedValue([
      { account: E, source: 'include', autoTarget: true, liveElsewhere: null },
      { account: A, source: 'inherited', autoTarget: true, liveElsewhere: 'global' },
    ]);
    for (const cmd of ['usage', 'timeline']) {
      const r = await runCli([cmd]);
      expect(r.exited).toBe(false);
      expect(r.out).toContain('Folder rules (cctl folders for detail):');
      expect(r.out).toContain('live: E (included)');
      expect(r.out).toContain('pool: *E, A (live in the global slot)');
    }
  });
});

describe('cctl timeline plan', () => {
  it('never recommends a shared account live in a folder slot, which the global slot cannot take', async () => {
    // F is shared but live in the research folder's slot (that folder excludes G); with nothing
    // polled the two tie, and F would win the tie on its label.
    const G = account('g', { label: 'G' });
    const F = account('f', { label: 'F' });
    engine.listAccounts.mockResolvedValue([G, F]);
    engine.listAllAccounts.mockResolvedValue([G, F]);
    engine.getActiveId.mockResolvedValue('g');
    engine.listRules.mockResolvedValue([ruleOn(research, { exclude: ['g'], activeId: 'f' })]);
    engine.liveSlots.mockResolvedValue(
      new Map([
        ['global', 'g'],
        ['group:r1', 'f'],
      ]),
    );
    const r = await runCli(['timeline']);
    expect(r.exited).toBe(false);
    expect(r.out).not.toContain('F has the most available headroom');
    expect(r.out).toContain('G has the most available headroom');
  });
});

describe('cctl doctor', () => {
  it('flags a running daemon that predates folder rules', { timeout: 60_000 }, async () => {
    await daemonRunning(olderReport);
    vi.stubEnv('LOCALAPPDATA', sandbox.root);
    vi.stubEnv('XDG_DATA_HOME', sandbox.root);
    vi.stubEnv('CLAUDE_CONFIG_DIR', join(sandbox.root, 'claude'));
    const r = await runCli(['doctor']);
    expect(r.out).toMatch(/\[!!\] daemon-folder-rules: the running daemon \(v0\.5\.2\) predates/);
  });
});

describe('retired commands', () => {
  it('no longer offers bind, unbind or bindings, and offers folder and folders instead', async () => {
    const names = buildProgram().commands.map((c) => c.name());
    for (const gone of ['bind', 'unbind', 'bindings']) expect(names).not.toContain(gone);
    expect(names).toContain('folder');
    expect(names).toContain('folders');
    const r = await runCli(['bind', research, 'A']);
    expect(r.exited).toBe(true);
    expect(engine.includeInFolder).not.toHaveBeenCalled();
  });
});

describe('older daemon: every command that can put a shared account live in a folder slot refuses', () => {
  it('folder reset of named accounts refuses (it can release a live account into the shared pool)', async () => {
    await daemonRunning(olderReport);
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    const r = await runCli(['folder', 'reset', research, 'E']);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('predates folder rules');
    expect(r.err).toContain('Nothing was changed.');
    expect(engine.resetFolder).not.toHaveBeenCalled();
  });

  it('folder reset of the whole rule goes ahead: it clears the slot and seats nothing', async () => {
    await daemonRunning(olderReport);
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    engine.resetFolder.mockResolvedValueOnce({
      folder: research,
      dissolved: true,
      released: ['e'],
      adoptedRotation: false,
      runningSessions: [],
    });
    const r = await runCli(['folder', 'reset', research]);
    expect(r.exited).toBe(false);
    expect(engine.resetFolder).toHaveBeenCalled();
  });

  it('switch of a shared account into a folder slot refuses; a reserved one into its own slot does not', async () => {
    await daemonRunning(olderReport);
    engine.listRules.mockResolvedValue([ruleOn(research, { include: ['e'] })]);
    const shared = await runCli(['switch', 'B', '--folder', research]);
    expect(shared.exited).toBe(true);
    expect(shared.err).toContain('predates folder rules');
    expect(engine.activate).not.toHaveBeenCalled();

    engine.activate.mockResolvedValueOnce({
      ok: true,
      activeAccountId: 'e',
      wroteCredentials: true,
      refreshed: false,
      adoptedPreviousRotation: false,
    });
    const reserved = await runCli(['switch', 'E']);
    expect(reserved.exited).toBe(false);
    expect(engine.activate).toHaveBeenCalledWith(
      'e',
      expect.objectContaining({ slot: 'group:r1' }),
    );
  });
});

describe('cctl claude', () => {
  /** Run `cctl claude` from `cwd`, returning what it printed and the env it launched with. */
  async function launch(args: string[], cwd: string) {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(cwd);
    launcher.spawnClaude.mockClear();
    try {
      const r = await runCli(['claude', ...args]);
      const env = launcher.spawnClaude.mock.calls[0]?.[0]?.env;
      return { ...r, env };
    } finally {
      cwdSpy.mockRestore();
    }
  }
  const rulesLiveOn = (live: string | null, rule: FolderRule) => {
    engine.listRules.mockResolvedValue([rule]);
    engine.getRule.mockResolvedValue(rule);
    engine.liveSlots.mockResolvedValue(
      new Map([
        ['global', 'a'],
        ['group:r1', live],
      ]),
    );
    engine.getActiveId.mockImplementation((slot?: string) =>
      Promise.resolve(slot === 'group:r1' ? live : 'a'),
    );
    engine.ensureRuleLive.mockResolvedValue({
      ruleId: 'r1',
      liveAccount: live,
      activated: false,
      noWorkingAccount: live === null,
    });
  };

  it('--account of a shared account live in this folder slot runs in that slot', async () => {
    rulesLiveOn('b', ruleOn(research, { exclude: ['a'], activeId: 'b' }));
    const r = await launch(['--account', 'B'], research);
    expect(r.exited).toBe(false);
    expect(r.err).not.toContain('can only run in the global slot');
    expect(r.env?.CLAUDE_CONFIG_DIR).toContain('r1');
  });

  it('--account of a shared account live in neither slot is refused with a fix that works', async () => {
    rulesLiveOn('b', ruleOn(research, { exclude: ['a'], activeId: 'b' }));
    const C = account('c', { label: 'C' });
    engine.listAllAccounts.mockResolvedValue([A, B, C, E]);
    const r = await launch(['--account', 'C'], research);
    expect(r.exited).toBe(true);
    expect(r.err).not.toContain('can only run in the global slot');
    expect(r.err).toContain('cctl switch C');
  });

  it('--override in a ruled folder launches on the global account, as documented', async () => {
    rulesLiveOn('e', ruleOn(research, { include: ['e'], activeId: 'e' }));
    const r = await launch(['--override'], research);
    expect(r.exited).toBe(false);
    expect(engine.ensureRuleLive).not.toHaveBeenCalled();
    expect(r.env?.CLAUDE_CONFIG_DIR ?? '').not.toContain('r1');
    expect(r.err).toContain('--override in effect');
  });

  it('says why nothing is usable instead of always asking for a re-login', async () => {
    rulesLiveOn(null, ruleOn(research, { exclude: ['a'] }));
    engine.slotPool.mockResolvedValue([
      { account: B, source: 'inherited', autoTarget: true, liveElsewhere: 'global' },
    ]);
    const r = await launch([], research);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('B is live in the global slot');
    expect(r.err).not.toContain('relogin');
  });

  it('refuses while a daemon that predates folder rules runs, unless the slot is on an included account', async () => {
    await daemonRunning(olderReport);
    rulesLiveOn('b', ruleOn(research, { include: ['e'], activeId: 'b' }));
    const onShared = await launch([], research);
    expect(onShared.exited).toBe(true);
    expect(onShared.err).toContain('predates folder rules');
    expect(engine.ensureRuleLive).not.toHaveBeenCalled();

    rulesLiveOn('e', ruleOn(research, { include: ['e'], activeId: 'e' }));
    const onIncluded = await launch([], research);
    expect(onIncluded.exited).toBe(false);
  });
});

describe('rule change reports say why a slot has nothing usable', () => {
  it('names the account live elsewhere rather than asking for a re-login', async () => {
    const rule = ruleOn(research, { exclude: ['a'] });
    engine.excludeInFolder.mockResolvedValueOnce({
      rule,
      created: true,
      movedOff: null,
      live: { ruleId: 'r1', liveAccount: null, activated: false, noWorkingAccount: true },
      runningSessions: [],
    });
    engine.listRules.mockResolvedValue([rule]);
    engine.slotPool.mockResolvedValue([
      { account: B, source: 'inherited', autoTarget: true, liveElsewhere: 'global' },
    ]);
    const r = await runCli(['folder', 'exclude', research, 'A']);
    expect(r.out).toContain('B is live in the global slot');
    expect(r.out).not.toContain('relogin');
  });

  it('says a pool emptied by the rule is empty, not that its accounts are reserved elsewhere', async () => {
    const rule = ruleOn(research, { exclude: ['a', 'b'] });
    engine.listRules.mockResolvedValue([rule]);
    engine.listAllAccounts.mockResolvedValue([A, B]);
    engine.slotPool.mockResolvedValue([]);
    const r = await runCli(['folders']);
    expect(r.out).not.toContain('reserved elsewhere');
    expect(r.out).toContain('excluded by its rule');
    expect(r.out).not.toContain('relogin');
  });
});

describe('cctl folder include --label', () => {
  it('says the label was not applied when the folder already has a rule', async () => {
    const rule = ruleOn(research, { include: ['e'] });
    engine.includeInFolder.mockResolvedValueOnce({
      rule: { ...rule, include: ['e', 'b'] },
      created: false,
      reserved: ['b'],
      unexcluded: [],
      handedOff: [],
      live: { ruleId: 'r1', liveAccount: 'e', activated: false, noWorkingAccount: false },
      runningSessions: [],
    });
    engine.listRules.mockResolvedValue([rule]);
    const r = await runCli(['folder', 'include', research, 'B', '--label', 'renamed']);
    expect(r.exited).toBe(false);
    expect(r.out).toContain('--label');
    expect(r.out).toContain('research');
  });
});
