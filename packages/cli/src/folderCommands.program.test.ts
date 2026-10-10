// Program-level coverage for the folder-rule commands: commander dispatch, the action, the render,
// against a stubbed engine and a sandboxed data folder — nothing near a real vault, a real
// ~/.claude/settings.json, or a real daemon.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  RefreshError,
  SlotError,
  SwitchEngineError,
  sandboxPaths,
  type AccountView,
  type ActivateResult,
  type FolderRule,
  type PoolEntry,
} from '@claude-control/switch-engine';
import { BIND_GUARD_MARKER } from '@claude-control/daemon';
import { backgroundHostOptions, createClaudeBackgroundHost } from './backgroundHost.js';
import { buildProgram } from './program.js';
import { CliFailure, reportFatal } from './context.js';
import type { SettingsReport } from './settings.js';

// Every path the commands resolve (vault, profiles, the guard's settings.json, daemon.db) lands in a
// per-test sandbox: the guard install that follows a successful rule change must never touch the
// operator's real Claude settings. `customMain` lays the main config dir out the way a
// CLAUDE_CONFIG_DIR set to it does (its .claude.json inside it), rather than the default layout.
const sandbox = vi.hoisted(() => ({ root: '', customMain: false }));
vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@claude-control/switch-engine')>();
  // Imported here, as vi.mock hoists its factory above the file's own imports.
  const path = await import('node:path');
  return {
    ...real,
    defaultPaths: () => {
      if (sandbox.root === '') throw new Error('test ran outside its sandbox');
      const paths = real.sandboxPaths(sandbox.root);
      return sandbox.customMain
        ? { ...paths, claudeJsonPath: path.join(paths.claudeDir, '.claude.json') }
        : paths;
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

// The background-service host `cctl claude` builds reads the sandbox's real files, but never runs a
// Claude Code: its commands go to a scripted runner that records them, and answers the way Claude Code
// does (a stop takes the session out of its service, a resume puts it in the profile's).
const bgHost = vi.hoisted(() => ({
  built: 0,
  calls: [] as Array<{ args: string[]; configDir: string | undefined }>,
  answer: (
    _args: string[],
    _configDir: string | undefined,
  ): { code: number | null; stdout: string; stderr: string } => ({
    code: 0,
    stdout: '',
    stderr: '',
  }),
}));
vi.mock('./backgroundHost.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./backgroundHost.js')>();
  return {
    ...real,
    createClaudeBackgroundHost: (o: Parameters<typeof real.createClaudeBackgroundHost>[0]) => {
      bgHost.built++;
      return real.createClaudeBackgroundHost({
        ...o,
        run: (args, opts) => {
          bgHost.calls.push({ args, configDir: opts.env.CLAUDE_CONFIG_DIR });
          return Promise.resolve(bgHost.answer(args, opts.env.CLAUDE_CONFIG_DIR));
        },
      });
    },
  };
});

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

describe('cctl claude opening a background session', () => {
  const SID = 'c5f2097e-d500-42a0-9ddf-8a33f4f9a886';
  const SHORT = 'c5f2097e';
  const main = (): string => join(sandbox.root, 'claude');
  const profile = (): string => join(sandbox.root, 'profiles', 'r1');

  /** Run `cctl claude` from the research folder, returning what it printed and what it spawned. */
  async function launchFrom(args: string[]) {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(research);
    launcher.spawnClaude.mockClear();
    try {
      const r = await runCli(['claude', ...args]);
      const spawned = launcher.spawnClaude.mock.calls[0]?.[0];
      return { ...r, args: spawned?.args, env: spawned?.env };
    } finally {
      cwdSpy.mockRestore();
    }
  }

  /** The research folder's rule includes E, live in its slot. */
  function ruleOnE(): void {
    const rule = ruleOn(research, { include: ['e'], activeId: 'e' });
    engine.listRules.mockResolvedValue([rule]);
    engine.getRule.mockResolvedValue(rule);
    engine.liveSlots.mockResolvedValue(
      new Map([
        ['global', 'a'],
        ['group:r1', 'e'],
      ]),
    );
    engine.ensureRuleLive.mockResolvedValue({
      ruleId: 'r1',
      liveAccount: 'e',
      activated: false,
      noWorkingAccount: false,
    });
  }

  /** The session runs in a config dir's service (this process stands in for its processes, so it
   *  counts as alive), with a row there, and the registry entry saying what it is doing. It works
   *  in the research folder unless `cwd` says otherwise. */
  async function runsIn(
    configDir: string,
    status: string,
    kind = 'bg',
    cwd = research,
  ): Promise<void> {
    await mkdir(join(configDir, 'daemon'), { recursive: true });
    if (kind === 'bg') {
      await writeFile(
        join(configDir, 'daemon', 'roster.json'),
        JSON.stringify({
          workers: { [SHORT]: { pid: process.pid, sessionId: SID, cwd } },
        }),
      );
    }
    await mkdir(join(main(), 'sessions'), { recursive: true });
    await writeFile(
      join(main(), 'sessions', '100001.json'),
      JSON.stringify({
        pid: process.pid,
        sessionId: SID,
        kind,
        status,
        jobId: SHORT,
        cwd,
      }),
    );
    await rowIn(configDir, 'running', cwd);
  }

  async function rowIn(configDir: string, state: string, cwd = research): Promise<void> {
    await mkdir(join(configDir, 'jobs', SHORT), { recursive: true });
    await writeFile(
      join(configDir, 'jobs', SHORT, 'state.json'),
      JSON.stringify({
        state,
        sessionId: SID,
        name: 'bg eval',
        cwd,
        respawnFlags: ['-n', 'bg eval'],
      }),
    );
  }

  beforeEach(() => {
    bgHost.built = 0;
    bgHost.calls.length = 0;
    bgHost.answer = () => ({ code: 0, stdout: '', stderr: '' });
  });

  it('a session running in the folder profile is attached there, with no Claude Code command first', async () => {
    ruleOnE();
    await runsIn(profile(), 'busy');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
    expect(r.err).toContain('cctl: Claude Code on E (the folder slot of');
    expect(bgHost.calls).toEqual([]);
  });

  it('an idle session on the global slot is moved onto the folder slot first, then attached there', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    bgHost.answer = (args, configDir) => {
      if (args[0] === 'agents') {
        return {
          code: 0,
          stdout: JSON.stringify([{ id: SHORT, status: 'idle', name: 'bg eval' }]),
          stderr: '',
        };
      }
      if (args[0] === 'stop') {
        // Claude Code takes it out of the global slot's service and the registry.
        writeFileSync(join(main(), 'daemon', 'roster.json'), JSON.stringify({ workers: {} }));
        rmSync(join(main(), 'sessions', '100001.json'));
      }
      if (args[0] === 'rm') {
        rmSync(join(configDir ?? main(), 'jobs', SHORT), { recursive: true, force: true });
      }
      if (args[0] === '--bg' && configDir === profile()) {
        mkdirSync(join(profile(), 'daemon'), { recursive: true });
        writeFileSync(
          join(profile(), 'daemon', 'roster.json'),
          JSON.stringify({
            workers: { [SHORT]: { pid: process.pid, sessionId: SID, cwd: research } },
          }),
        );
        return {
          code: 0,
          stdout: `backgrounded · ${SHORT} (idle — send a prompt to start)`,
          stderr: '',
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    };
    const r = await launchFrom(['--', 'attach', 'bg eval']);
    expect(r.exited).toBe(false);
    expect(bgHost.calls.map((c) => [c.args.join(' '), c.configDir])).toEqual([
      ['agents --json', undefined],
      [`stop ${SHORT}`, undefined],
      // While it runs nowhere, its row on the global slot goes: none is left there to wake it by.
      [`rm ${SHORT}`, undefined],
      [`--bg --resume ${SID} --name=bg eval`, profile()],
    ]);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
    // Said before the move starts, and once it is done.
    expect(r.err).toContain(
      'cctl: moving background session "bg eval" (c5f2097e) from A (the global slot) onto E',
    );
    expect(r.err).toContain('cctl: moved background session "bg eval" (c5f2097e) onto E');
  });

  it('a busy session on the global slot is attached there, never stopped, and says why', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'failed');
    const r = await launchFrom(['--resume', SID]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(r.err).toContain('stays on A (the global slot) for now: it is in a turn.');
    expect(bgHost.calls).toEqual([]);
  });

  it('a session open in a terminal is refused, and nothing runs', async () => {
    ruleOnE();
    await runsIn(main(), 'idle', 'interactive');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('is open in a terminal right now');
    expect(launcher.spawnClaude).not.toHaveBeenCalled();
    expect(bgHost.calls).toEqual([]);
  });

  it('--override does not take a session from the folder profile running it: it is opened there', async () => {
    ruleOnE();
    await runsIn(profile(), 'idle');
    await rowIn(main(), 'stopped');
    const r = await launchFrom(['--override', 'attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
    expect(r.env?.CCTL_BIND_OVERRIDE).toBeUndefined();
    expect(r.err).toContain('runs on E (the folder slot of');
    expect(bgHost.calls).toEqual([]);
  });

  it('a session cctl knows nothing of is passed through to Claude Code as typed', async () => {
    ruleOnE();
    const r = await launchFrom(['attach', 'nothing-by-that-name']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', 'nothing-by-that-name']);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
  });

  it('arguments that open no background session never read the background services', async () => {
    ruleOnE();
    const r = await launchFrom(['--model', 'opus', 'hello']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['--model', 'opus', 'hello']);
    expect(bgHost.built).toBe(0);
  });

  it('the older-daemon fence still guards seating the folder slot a session belongs to', async () => {
    await daemonRunning(olderReport);
    rulesLiveOnShared();
    await runsIn(main(), 'idle');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('predates folder rules');
    expect(engine.ensureRuleLive).not.toHaveBeenCalled();
    expect(bgHost.calls).toEqual([]);
  });

  /** Claude Code answering the way it does for an idle session on the global slot: its listing,
   *  a stop that takes it out of the service and the registry, a row removed, and a resume that puts
   *  it in the profile's service. */
  function answersAMove(): void {
    bgHost.answer = (args, configDir) => {
      if (args[0] === 'agents') {
        return { code: 0, stdout: JSON.stringify([{ id: SHORT, status: 'idle' }]), stderr: '' };
      }
      if (args[0] === 'stop') {
        writeFileSync(join(main(), 'daemon', 'roster.json'), JSON.stringify({ workers: {} }));
        rmSync(join(main(), 'sessions', '100001.json'));
      }
      if (args[0] === 'rm') {
        rmSync(join(configDir ?? main(), 'jobs', SHORT), { recursive: true, force: true });
      }
      if (args[0] === '--bg' && configDir === profile()) {
        mkdirSync(join(profile(), 'daemon'), { recursive: true });
        writeFileSync(
          join(profile(), 'daemon', 'roster.json'),
          JSON.stringify({
            workers: { [SHORT]: { pid: process.pid, sessionId: SID, cwd: research } },
          }),
        );
      }
      return { code: 0, stdout: '', stderr: '' };
    };
  }

  it('--account of the folder account never opens a session running on the global slot under the profile', async () => {
    ruleOnE();
    engine.activate.mockResolvedValue({} as never);
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'stopped');
    const r = await launchFrom(['--account', 'E', 'attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(r.err).toContain('runs on A (the global slot); opening it there.');
    expect(bgHost.calls).toEqual([]);
  });

  it('a shell inheriting the profile CLAUDE_CONFIG_DIR still attaches on the global slot where it runs', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'stopped');
    vi.stubEnv('CLAUDE_CONFIG_DIR', profile());
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('a folder slot on a shared account (its fallback) is no move target for cctl claude', async () => {
    rulesLiveOnShared();
    engine.ensureRuleLive.mockResolvedValue({
      ruleId: 'r1',
      liveAccount: 'b',
      activated: false,
      noWorkingAccount: false,
    });
    await runsIn(main(), 'idle');
    answersAMove();
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(bgHost.calls.map((c) => c.args[0])).not.toContain('stop');
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(r.err).toContain('does not hold one of its own accounts with usage left');
  });

  it('a usage record that cannot be read is no proof the folder account can take work: not moved', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    answersAMove();
    await writeFile(join(sandbox.root, 'daemon.db'), 'not a database');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(bgHost.calls.map((c) => c.args[0])).not.toContain('stop');
    expect(r.err).toContain('does not hold one of its own accounts with usage left');
  });

  it('with no usage record yet, the folder account counts as able: moved', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    answersAMove();
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(bgHost.calls.map((c) => c.args[0])).toContain('stop');
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
  });

  it('Ctrl-C during a move lets it finish, then opens nothing', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    answersAMove();
    const answer = bgHost.answer;
    bgHost.answer = (args, configDir) => {
      // The operator presses Ctrl-C while the session is stopped and not yet resumed.
      if (args[0] === 'rm') process.emit('SIGINT');
      return answer(args, configDir);
    };
    const r = await launchFrom(['attach', SHORT]);
    expect(bgHost.calls.map((c) => c.args[0])).toEqual(['agents', 'stop', 'rm', '--bg']);
    expect(r.err).toContain(
      'cctl: finishing the move first; stopping now would leave the session stopped. If this ' +
        `window closes before it finishes, bring it back with: cctl claude --resume ${SID}`,
    );
    expect(r.err).toContain('cctl: interrupted; not opening the session.');
    expect(launcher.spawnClaude).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
    process.exitCode = undefined;
    // The signal is the operator's own again.
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it('Ctrl-C is held only from the moment the move commits, never during its checks', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    answersAMove();
    const answer = bgHost.answer;
    const heldAt: Record<string, number> = {};
    bgHost.answer = (args, configDir) => {
      // Asked what it is doing: one of the move's own checks, before anything is touched.
      heldAt[args[0]!] = process.listenerCount('SIGINT');
      return answer(args, configDir);
    };
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(heldAt).toEqual({ agents: 0, stop: 1, rm: 1, '--bg': 1 });
    expect(process.listenerCount('SIGINT')).toBe(0);
  });

  it("Claude Code's resume picker is refused while the folder profile holds a row of a session running on the global slot", async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'stopped');
    for (const args of [['--resume'], ['--continue'], ['agents']]) {
      const r = await launchFrom(args);
      expect(r.exited).toBe(true);
      expect(r.err).toContain(`open it with: cctl claude attach ${SHORT}`);
    }
    expect(launcher.spawnClaude).not.toHaveBeenCalled();
    expect(bgHost.calls).toEqual([]);
  });

  it('a resume spelled -r<id> is opened where the session runs; spellings that are no plain resume are checked first', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'stopped');
    const routed = await launchFrom([`-r${SID}`]);
    expect(routed.exited).toBe(false);
    expect(routed.args).toEqual(['attach', SHORT]);
    expect(routed.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    for (const args of [
      ['-cr', SID],
      ['logs', SHORT],
      ['agents', '--json'],
    ]) {
      const r = await launchFrom(args);
      expect({ args, exited: r.exited }).toEqual({ args, exited: true });
      expect(r.err).toContain(`open it with: cctl claude attach ${SHORT}`);
    }
    expect(bgHost.calls).toEqual([]);
  });

  it('stop of a session running on the global slot is run there, by its job id', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    await rowIn(profile(), 'stopped');
    const r = await launchFrom(['stop', 'c5f2']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['stop', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
  });

  it('a prompt after --resume <id> is passed to the session where it runs', async () => {
    ruleOnE();
    await runsIn(profile(), 'busy');
    const r = await launchFrom(['--resume', SID, 'carry on']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['--resume', SID, 'carry on']);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
  });

  /** Whether the session's move lock is free now: nothing of the command just run still holds it. */
  async function lockFree(): Promise<boolean> {
    const host = createClaudeBackgroundHost(backgroundHostOptions(sandboxPaths(sandbox.root)));
    const lock = await host.lockSession(SID, 0);
    lock?.release();
    return lock !== undefined;
  }

  /** The options the launch spawned Claude Code with, beyond the command, arguments and env. */
  const spawnedWith = (): { onSpawn?: unknown } =>
    launcher.spawnClaude.mock.calls[0]?.[0] as { onSpawn?: unknown };

  it('an open routed to where the session runs is told the pid it starts, and lets the move lock go once that terminal is done', async () => {
    // The lock is kept until the attach journal names that very process (see runHolding).
    ruleOnE();
    await runsIn(profile(), 'busy');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(typeof spawnedWith().onSpawn).toBe('function');
    expect(await lockFree()).toBe(true);
  });

  it('a launch on the slot is told the pid it starts, and a pass that held the move lock lets it go', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    const r = await launchFrom(['--override', 'attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(typeof spawnedWith().onSpawn).toBe('function');
    expect(await lockFree()).toBe(true);
  });

  it('Ctrl-C pressed twice during a move is answered once, and the move lock is let go', async () => {
    ruleOnE();
    await runsIn(main(), 'idle');
    answersAMove();
    const answer = bgHost.answer;
    bgHost.answer = (args, configDir) => {
      if (args[0] === 'rm') {
        process.emit('SIGINT');
        process.emit('SIGINT');
      }
      return answer(args, configDir);
    };
    const r = await launchFrom(['attach', SHORT]);
    expect(r.err.split('finishing the move first').length - 1).toBe(1);
    expect(process.exitCode).toBe(130);
    process.exitCode = undefined;
    expect(await lockFree()).toBe(true);
  });

  for (const sig of ['SIGBREAK', 'SIGHUP'] as const) {
    // Ctrl-Break and a closing terminal end cctl as Ctrl-C does; Ctrl-Break exists on Windows only.
    it.skipIf(sig === 'SIGBREAK' && process.platform !== 'win32')(
      `${sig} during a move is held off like Ctrl-C, then the signal is the operator's own again`,
      async () => {
        expect(process.listenerCount(sig)).toBe(0);
        ruleOnE();
        await runsIn(main(), 'idle');
        answersAMove();
        const answer = bgHost.answer;
        bgHost.answer = (args, configDir) => {
          if (args[0] === 'rm') process.emit(sig);
          return answer(args, configDir);
        };
        const r = await launchFrom(['attach', SHORT]);
        expect(bgHost.calls.map((c) => c.args[0])).toEqual(['agents', 'stop', 'rm', '--bg']);
        expect(r.err).toContain('cctl: interrupted; not opening the session.');
        expect(launcher.spawnClaude).not.toHaveBeenCalled();
        expect(process.exitCode).toBe(130);
        process.exitCode = undefined;
        expect(process.listenerCount(sig)).toBe(0);
      },
    );
  }

  /** A session busy in the folder profile, working in `cwd`, whose conversation is titled "feat x". */
  async function titledSessionIn(cwd: string): Promise<void> {
    await runsIn(profile(), 'busy', 'bg', cwd);
    await mkdir(join(main(), 'projects', 'p'), { recursive: true });
    await writeFile(
      join(main(), 'projects', 'p', `${SID}.jsonl`),
      JSON.stringify({ type: 'custom-title', customTitle: 'feat x', sessionId: SID }) + '\n',
    );
  }

  it('--resume <title> finds a session working in a worktree Claude Code made under the folder', async () => {
    ruleOnE();
    const tree = join(research, '.claude', 'worktrees', 'feat');
    await mkdir(tree, { recursive: true });
    await titledSessionIn(tree);
    const r = await launchFrom(['--resume', 'feat x']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
  });

  it("--resume <title> finds a session working in a git worktree of the folder's repository", async () => {
    ruleOnE();
    // A throwaway repository: no hooks, no signing, whatever the box's git config says.
    const git = (args: string[], cwd: string): void =>
      void execFileSync(
        'git',
        [
          '-c',
          'core.longpaths=true',
          '-c',
          `core.hooksPath=${join(sandbox.root, 'no-hooks')}`,
          '-c',
          'commit.gpgsign=false',
          '-c',
          'user.name=t',
          '-c',
          'user.email=t@t',
          ...args,
        ],
        { cwd, stdio: 'pipe', encoding: 'utf8' },
      );
    git(['init', '-q'], research);
    git(['commit', '-q', '--allow-empty', '-m', 'x'], research);
    const tree = join(dirname(research), 'research-wt');
    git(['worktree', 'add', '-q', tree], research);
    await titledSessionIn(realpathSync.native(tree));
    const r = await launchFrom(['--resume', 'feat x']);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBe(profile());
  });

  it('with the main config dir reached through CLAUDE_CONFIG_DIR, a session there is opened under that very dir', async () => {
    sandbox.customMain = true;
    try {
      ruleOnE();
      await runsIn(main(), 'busy');
      const r = await launchFrom(['attach', SHORT]);
      expect(r.exited).toBe(false);
      expect(r.args).toEqual(['attach', SHORT]);
      expect(r.env?.CLAUDE_CONFIG_DIR).toBe(main());
    } finally {
      sandbox.customMain = false;
    }
  });

  it('a folder slot that cannot be seated is no move target: the session opens where it runs, saying why', async () => {
    ruleOnE();
    engine.ensureRuleLive.mockRejectedValue(
      new SwitchEngineError('the folder slot cannot be seated now', 'NO_SEAT'),
    );
    await runsIn(main(), 'idle');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.args).toEqual(['attach', SHORT]);
    expect(r.env?.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(r.err).toContain('the folder slot cannot be seated now');
  });

  it('with no daemon running, no move by the daemon is promised', async () => {
    ruleOnE();
    await runsIn(main(), 'busy');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.err).toContain('stays on A (the global slot) for now');
    expect(r.err).not.toContain('daemon moves it');
  });

  it("a session left on a removed rule's profile is said to have no login there", async () => {
    ruleOnE();
    await runsIn(join(sandbox.root, 'profiles', 'old'), 'busy');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(r.err).toContain('That profile has no login');
  });

  it('a session working in a folder no rule covers is never moved off its folder profile onto the global slot', async () => {
    ruleOnE();
    const elsewhere = join(sandbox.root, 'elsewhere');
    await mkdir(elsewhere, { recursive: true });
    await runsIn(profile(), 'idle', 'bg', realpathSync.native(elsewhere));
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(false);
    expect(bgHost.calls).toEqual([]);
    expect(r.err).toContain('cctl moves background sessions only onto a folder slot');
  });

  it('a folder slot left with no working account is no place to start a session: refused, saying why', async () => {
    ruleOnE();
    engine.ensureRuleLive.mockResolvedValue({
      ruleId: 'r1',
      liveAccount: 'e',
      activated: false,
      noWorkingAccount: true,
    });
    await rowIn(profile(), 'stopped');
    const r = await launchFrom(['attach', SHORT]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain('no account it may use is usable');
    expect(launcher.spawnClaude).not.toHaveBeenCalled();
  });

  /** The research rule includes E, but its slot runs on the shared account B. */
  function rulesLiveOnShared(): void {
    const rule = ruleOn(research, { include: ['e'], activeId: 'b' });
    engine.listRules.mockResolvedValue([rule]);
    engine.getRule.mockResolvedValue(rule);
    engine.liveSlots.mockResolvedValue(
      new Map([
        ['global', 'a'],
        ['group:r1', 'b'],
      ]),
    );
  }
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
