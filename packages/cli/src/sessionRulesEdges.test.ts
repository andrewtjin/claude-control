// `cctl session include|reset|show` at their edges, end to end over real files (a temp Claude config
// dir with transcripts in Claude Code's layout, a temp vault behind a real SwitchEngine with a
// passthrough protector): running sessions opened with --resume, a session on a config dir cctl does
// not manage, a session running on a rule's profile, and every printed resume command being
// paste-safe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { projectDirStem, sessionIdentities } from '@claude-control/daemon';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  defaultPaths,
  folderBindingsPath,
  groupProfileDir,
  leaseRuleId,
  sandboxPaths,
  selfHolder,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { SESSION_ID_ENV, runSessionShow } from './sessionAliases.js';
import { runSessionInclude, runSessionReset, type SessionRuleDeps } from './sessionRules.js';
import { reconcileFolderGuard } from './folderCommands.js';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-01T00:00:00.000Z');
const S_CUR = 'aaaaaaaa-0000-4000-8000-000000000001'; // named "Auth Work" in repo
const S_DOLLAR = 'aaaaaaaa-0000-4000-8000-000000000004'; // named 'Deploy $(calc) "now"' in repo

const bundle = (token: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: token, refreshToken: 'r-' + token, expiresAt: NOW + 100 * HOUR },
  oauthAccount: { accountUuid: 'uuid-' + token, emailAddress: token + '@example.com' },
});
const userLine = (cwd: string, tsMs: number): string =>
  JSON.stringify({
    type: 'user',
    cwd,
    timestamp: new Date(tsMs).toISOString(),
    message: { role: 'user', content: 'hi' },
  });
const customTitle = (t: string): string => JSON.stringify({ type: 'custom-title', customTitle: t });

let root: string;
let paths: Paths;
let repo: string;
let main: StoredAccount;

async function writeSession(folder: string, id: string, lines: string[], atMs: number) {
  const dir = join(paths.claudeDir, 'projects', projectDirStem(folder));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  await writeFile(file, lines.join('\n') + '\n', 'utf8');
  await utimes(file, atMs / 1000, atMs / 1000);
}

/** An engine over `over` (default: the sandbox) wired like production's: the transcript lookup is
 *  the daemon's session catalog. `alive` decides which recorded pids count as running. */
function sandboxEngine(
  alive: (pid: number) => boolean = () => false,
  over: Paths = paths,
): SwitchEngine {
  return new SwitchEngine({
    paths: over,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(over.credentialsPath),
    refresh: (cur: ClaudeOauth) => Promise.resolve(cur),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 10 },
    isProcessAlive: alive,
    bindEnforce: 'block',
    sessionIdentity: sessionIdentities,
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-session-edges-'));
  vi.stubEnv('CCTL_BIND_ENFORCE', 'block');
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'repo'), { recursive: true });
  repo = realpathSync.native(join(root, 'repo'));
  const e = sandboxEngine();
  main = await e.addAccount('main', bundle('a'));
  await e.addAccount('work', bundle('b'));
  await e.addAccount('client', bundle('c'));
  await e.activate(main.id, { force: true }); // main = the global live account
  await writeSession(repo, S_CUR, [userLine(repo, NOW), customTitle('Auth Work')], NOW + HOUR);
  await writeSession(
    repo,
    S_DOLLAR,
    [userLine(repo, NOW), customTitle('Deploy $(calc) "now"')],
    NOW,
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

function harness(engine: SwitchEngine, over: Partial<SessionRuleDeps> = {}) {
  const written: string[] = [];
  const deps: SessionRuleDeps = {
    paths,
    env: {},
    cwd: repo,
    platform: process.platform,
    write: (t) => written.push(t),
    note: () => {},
    engine,
    reconcileGuard: () => Promise.resolve(),
    refuseOnOlderDaemon: () => Promise.resolve(),
    ...over,
  };
  return { deps, text: () => written.join('') };
}

/** A running session opened the way cctl tells operators to: `cctl claude --resume "Auth Work"`.
 *  Measured on Claude Code 2.1.283: its session file records a DERIVED name, never the title. */
async function resumedSessionRunning(): Promise<void> {
  const dir = join(paths.claudeDir, 'sessions');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, '44248.json'),
    JSON.stringify({
      pid: 44248,
      sessionId: S_CUR,
      cwd: repo,
      startedAt: NOW,
      kind: 'interactive',
      name: 'repo-9e',
      nameSource: 'derived',
    }),
  );
}

describe('a running session opened with --resume', () => {
  it('blocks removing the rule without --force', async () => {
    const engine = sandboxEngine(() => true);
    await runSessionInclude('Auth Work', 'work', {}, harness(engine).deps);
    await resumedSessionRunning();
    await expect(runSessionReset('Auth Work', undefined, {}, harness(engine).deps)).rejects.toThrow(
      /running session/,
    );
    expect(await engine.listRules()).toHaveLength(1);
    await runSessionReset('Auth Work', undefined, { force: true }, harness(engine).deps);
    expect(await engine.listRules()).toEqual([]);
  });

  it('blocks removing the last account without --force', async () => {
    const engine = sandboxEngine(() => true);
    await runSessionInclude('Auth Work', 'work', {}, harness(engine).deps);
    await resumedSessionRunning();
    await expect(runSessionReset('Auth Work', 'work', {}, harness(engine).deps)).rejects.toThrow(
      /running session/,
    );
    expect(await engine.listRules()).toHaveLength(1);
  });

  it('is reported by session include, which says it keeps its account until resumed', async () => {
    const engine = sandboxEngine(() => true);
    await resumedSessionRunning();
    const h = harness(engine);
    await runSessionInclude('Auth Work', 'work', {}, h.deps);
    expect(h.text()).toContain('1 running session(s) named "Auth Work" keep their current account');
    expect(h.text()).toContain('until resumed with: cctl claude --resume');
  });
});

describe('a session on a config dir cctl does not manage', () => {
  it('session include says nothing about this session (its slot is unknown)', async () => {
    const engine = sandboxEngine();
    const foreign = join(root, 'my-other-claude-config');
    await mkdir(foreign, { recursive: true });
    const h = harness(engine, { env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: foreign } });
    await runSessionInclude('Auth Work', 'work', {}, h.deps);
    expect(h.text()).not.toContain('This session');
    expect(await engine.getActiveId('global')).toBe(main.id);
  });

  it('session show reports its slot as unknown, not the shared account', async () => {
    const engine = sandboxEngine();
    await runSessionInclude('Auth Work', 'work', {}, harness(engine).deps);
    const foreign = join(root, 'my-other-claude-config');
    await mkdir(foreign, { recursive: true });
    const h = harness(engine, { env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: foreign } });
    await runSessionShow(undefined, { json: true }, h.deps);
    const binding = (JSON.parse(h.text()) as { sessions: { binding: Record<string, unknown> }[] })
      .sessions[0]!.binding;
    expect(binding.slot).toBeNull();
    expect(binding.inScope).toBeNull();
    const plain = harness(engine, { env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: foreign } });
    await runSessionShow(undefined, {}, plain.deps);
    expect(plain.text()).toContain('this session runs on a config dir cctl does not manage');
  });

  it('the main config dir spelled out in CLAUDE_CONFIG_DIR is the global slot', async () => {
    const engine = sandboxEngine();
    await runSessionInclude('Auth Work', 'work', {}, harness(engine).deps);
    const h = harness(engine, {
      env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: paths.claudeDir },
    });
    await runSessionShow(undefined, { json: true }, h.deps);
    const binding = (JSON.parse(h.text()) as { sessions: { binding: Record<string, unknown> }[] })
      .sessions[0]!.binding;
    expect(binding).toMatchObject({ slot: 'global', slotSource: 'env', inScope: false });
  });
});

describe('printed resume commands are paste-safe', () => {
  it('the note to this session resumes it by its id, never by an unquoted alias', async () => {
    const engine = sandboxEngine();
    const h = harness(engine, { env: { [SESSION_ID_ENV]: S_DOLLAR } });
    await runSessionInclude('Deploy $(calc) "now"', 'work', {}, h.deps);
    const out = h.text();
    // THIS session is named by its id (a UUID: nothing for a shell to expand); a double-quoted
    // "$(calc)" would RUN calc in PowerShell and POSIX shells.
    expect(out).toContain(`cctl claude --resume ${S_DOLLAR}`);
    expect(out).not.toContain('--resume "Deploy');
  });

  it('session show echoes an unknown ref without terminal controls', async () => {
    const engine = sandboxEngine();
    const evil = 'x\u001b]0;pwned\u0007\u001b[2J';
    const err = await runSessionShow(evil, {}, harness(engine).deps).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message).toMatch(/no session with id or alias/);
    expect(err?.message).not.toContain('\u001b');
    expect(err?.message).not.toContain('\u0007');
  });
});

describe.skipIf(process.platform === 'darwin')(
  'run from inside a session on a rule profile',
  () => {
    // A session under a rule runs with CLAUDE_CONFIG_DIR = its rule's profile. A cctl command it runs
    // (the natural way to ask Claude to add a rule) must still act on the MAIN config dir — deps.paths
    // come from defaultPaths, which sees through a profile — while reading the session's own slot from
    // the RAW environment.
    it('includes against the main config dir: moves global off the account, snapshot names the main dir', async () => {
      const mainDir = paths.claudeDir;
      const env = { LOCALAPPDATA: root, XDG_DATA_HOME: root, CLAUDE_CONFIG_DIR: mainDir };
      const mainPaths = defaultPaths(env, process.platform);
      const engine = sandboxEngine(() => false, mainPaths);
      const A = await engine.addAccount('A', bundle('A'));
      const W = await engine.addAccount('W', bundle('W'));
      const C = await engine.addAccount('C', bundle('C'));
      await engine.activate(A.id, { force: true });
      const first = await engine.includeInAlias(repo, 'Other', [W.id]);
      const profile = groupProfileDir(mainPaths.vaultDir, first.rule.id);
      await engine.activate(C.id, { force: true }); // C is now the global live account

      // The session's own environment: its profile, and its session id.
      const sessionEnv = { ...env, CLAUDE_CONFIG_DIR: profile, [SESSION_ID_ENV]: S_CUR };
      const seenThrough = defaultPaths(sessionEnv, process.platform);
      expect(seenThrough.claudeDir.toLowerCase()).toBe(mainDir.toLowerCase());
      const cliEngine = sandboxEngine(() => false, seenThrough);
      const h = harness(cliEngine, {
        paths: seenThrough,
        env: sessionEnv,
        reconcileGuard: (e: SwitchEngine) => reconcileFolderGuard(e, seenThrough),
      });
      await runSessionInclude('Auth Work', 'C', { cwd: repo }, h.deps);

      // C was the GLOBAL live account: it moved off global before being reserved.
      expect(await cliEngine.getActiveId('global')).toBe(A.id);
      expect(await cliEngine.checkSlots()).toEqual([]);
      const snapshot = JSON.parse(
        await readFile(folderBindingsPath(mainPaths.vaultDir), 'utf8'),
      ) as { mainConfigDir: string };
      expect(snapshot.mainConfigDir.toLowerCase()).toBe(realpathSync.native(mainDir).toLowerCase());
      // Its own slot was read from the raw env: this session (on the "Other" profile) is on another
      // rule's slot than its new one, and says so.
      expect(h.text()).toContain("This session now runs on another rule's slot");
      expect(h.text()).toContain(`cctl claude --resume ${S_CUR}`);

      // Removing every rule from inside the profile removes the guard from the MAIN settings.
      await runSessionReset('Auth Work', undefined, { cwd: repo }, h.deps);
      await runSessionReset('Other', undefined, { cwd: repo }, h.deps);
      const settings = await readFile(join(mainDir, 'settings.json'), 'utf8').catch(() => '');
      expect(settings).not.toContain('bind-guard');
    });

    it('a session on a parallel-session profile is never told to move: it runs where it was started', async () => {
      const mainDir = paths.claudeDir;
      const env = { LOCALAPPDATA: root, XDG_DATA_HOME: root, CLAUDE_CONFIG_DIR: mainDir };
      const mainPaths = defaultPaths(env, process.platform);
      const engine = sandboxEngine(() => true, mainPaths);
      const A = await engine.addAccount('A', bundle('A'));
      const W = await engine.addAccount('W', bundle('W'));
      await engine.addAccount('C', bundle('C'));
      await engine.activate(A.id, { force: true });
      await engine.claimSessionSlot(W.id, selfHolder('launcher'), { launchRuleId: null });
      const profile = groupProfileDir(mainPaths.vaultDir, leaseRuleId(W.id));

      const sessionEnv = { ...env, CLAUDE_CONFIG_DIR: profile, [SESSION_ID_ENV]: S_CUR };
      const seenThrough = defaultPaths(sessionEnv, process.platform);
      const cliEngine = sandboxEngine(() => true, seenThrough);
      const h = harness(cliEngine, { paths: seenThrough, env: sessionEnv });
      await runSessionInclude('Auth Work', 'A', { cwd: repo }, h.deps);
      expect(h.text()).not.toContain("This session now runs on another rule's slot");
      expect(h.text()).not.toContain('runs on the global slot');
    });
  },
);
