// `cctl session bind|unbind|show` at their edges, end to end over real files (a temp Claude config
// dir with transcripts in Claude Code's layout, a temp vault behind a real SwitchEngine with a
// passthrough protector): running sessions opened with --resume, a binding another process changed
// between the command's look and its write, a session on a config dir cctl does not manage, a session
// running on a group profile, and every printed resume command being paste-safe.

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
  groupSlotId,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';
import { SESSION_ID_ENV, runSessionShow } from './sessionAliases.js';
import { runSessionBind, runSessionUnbind, type SessionBindDeps } from './sessionBinding.js';
import { reconcileBindGuard } from './bindCommands.js';

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
let research: string;
let main: StoredAccount;
let work: StoredAccount;
let client: StoredAccount;

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
  await mkdir(join(root, 'research'), { recursive: true });
  repo = realpathSync.native(join(root, 'repo'));
  research = realpathSync.native(join(root, 'research'));
  const e = sandboxEngine();
  main = await e.addAccount('main', bundle('a'));
  work = await e.addAccount('work', bundle('b'));
  client = await e.addAccount('client', bundle('c'));
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

function harness(engine: SwitchEngine, over: Partial<SessionBindDeps> = {}) {
  const written: string[] = [];
  const deps: SessionBindDeps = {
    paths,
    env: {},
    cwd: repo,
    platform: process.platform,
    write: (t) => written.push(t),
    note: () => {},
    engine,
    reconcileGuard: () => Promise.resolve(),
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
  it('blocks a dissolving session unbind without --force', async () => {
    const engine = sandboxEngine(() => true);
    await runSessionBind('Auth Work', 'work', {}, harness(engine).deps);
    await resumedSessionRunning();
    await expect(runSessionUnbind('Auth Work', {}, harness(engine).deps)).rejects.toThrow(
      /running session/,
    );
    expect(await engine.listGroups()).toHaveLength(1);
  });

  it('blocks removing the last account without --force', async () => {
    const engine = sandboxEngine(() => true);
    await runSessionBind('Auth Work', 'work', {}, harness(engine).deps);
    await resumedSessionRunning();
    await expect(
      runSessionUnbind('Auth Work', { accounts: 'work' }, harness(engine).deps),
    ).rejects.toThrow(/running session/);
    expect(await engine.listGroups()).toHaveLength(1);
  });

  it('is reported by session bind, which says it stays on its slot until relaunched', async () => {
    const engine = sandboxEngine(() => true);
    await resumedSessionRunning();
    const h = harness(engine);
    await runSessionBind('Auth Work', 'work', {}, h.deps);
    expect(h.text()).toContain('1 running session(s) named "Auth Work"');
    expect(h.text()).toContain('stay on the slot they started on');
  });
});

describe('a binding another process changed between the look and the write', () => {
  /** The CLI's engine, with a competing `cctl bind <research> <accounts>` (another process) landing
   *  right after the CLI's own scope check — just before its grow/shrink call reaches the engine. */
  function racedEngine(accounts: () => string[]): SwitchEngine {
    const cliEngine = sandboxEngine();
    const other = sandboxEngine();
    const add = cliEngine.addGroupMembers.bind(cliEngine);
    const remove = cliEngine.removeGroupMembers.bind(cliEngine);
    cliEngine.addGroupMembers = async (...args) => {
      await other.bindFolder(research, accounts());
      return add(...args);
    };
    cliEngine.removeGroupMembers = async (...args) => {
      await other.bindFolder(research, accounts());
      return remove(...args);
    };
    return cliEngine;
  }

  it('session bind never grows a folder binding that joined the group meanwhile', async () => {
    await sandboxEngine().bindAlias(repo, 'Auth Work', [work.id]); // alias-only group {work}
    const engine = racedEngine(() => [work.id]); // reuses the {work} group

    await expect(
      runSessionBind('Auth Work', 'client', { cwd: repo }, harness(engine).deps),
    ).rejects.toThrow(/Nothing changed/);
    const g = (await sandboxEngine().listGroups())[0]!;
    expect(g.folders).toEqual([research]);
    expect(g.members.map((m) => m.id)).toEqual([work.id]);
  });

  it('session unbind --accounts never shrinks a folder binding that joined the group meanwhile', async () => {
    await sandboxEngine().bindAlias(repo, 'Auth Work', [work.id, client.id]);
    const engine = racedEngine(() => [work.id, client.id]);

    await expect(
      runSessionUnbind('Auth Work', { cwd: repo, accounts: 'client' }, harness(engine).deps),
    ).rejects.toThrow(/Nothing changed/);
    const g = (await sandboxEngine().listGroups())[0]!;
    expect(g.folders).toEqual([research]);
    expect(g.members.map((m) => m.id).sort()).toEqual([work.id, client.id].sort());
  });
});

describe('a session on a config dir cctl does not manage', () => {
  it('session bind refuses to guess its account, and changes nothing', async () => {
    const engine = sandboxEngine();
    const foreign = join(root, 'my-other-claude-config');
    await mkdir(foreign, { recursive: true });
    const h = harness(engine, { env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: foreign } });
    await expect(runSessionBind(undefined, undefined, {}, h.deps)).rejects.toThrow(
      /cannot tell which account this session runs on.*pass the accounts/is,
    );
    expect(await engine.listGroups()).toEqual([]);
    expect(await engine.getActiveId('global')).toBe(main.id);
  });

  it('session show reports its slot as unknown, not the shared account', async () => {
    const engine = sandboxEngine();
    await runSessionBind('Auth Work', 'work', {}, harness(engine).deps);
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
    const h = harness(engine, {
      env: { [SESSION_ID_ENV]: S_CUR, CLAUDE_CONFIG_DIR: paths.claudeDir },
    });
    await runSessionBind('Auth Work', undefined, {}, h.deps);
    const g = (await engine.listGroups())[0]!;
    expect(g.members.map((m) => m.id)).toEqual([main.id]);
  });
});

describe('printed resume commands are paste-safe', () => {
  it('the out-of-binding note resumes this session by its id, never by an unquoted alias', async () => {
    const engine = sandboxEngine();
    const h = harness(engine, { env: { [SESSION_ID_ENV]: S_DOLLAR } });
    await runSessionBind(undefined, 'work', {}, h.deps);
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
  'run from inside a session on a group profile',
  () => {
    // A folder- or alias-bound session runs with CLAUDE_CONFIG_DIR = its group's profile. A cctl
    // command it runs (the natural way to ask Claude to bind) must still act on the MAIN config dir —
    // deps.paths come from defaultPaths, which sees through a profile — while reading the session's
    // own slot from the RAW environment.
    it('binds against the main config dir: moves global off the account, snapshot names the main dir', async () => {
      const mainDir = paths.claudeDir;
      const env = { LOCALAPPDATA: root, XDG_DATA_HOME: root, CLAUDE_CONFIG_DIR: mainDir };
      const mainPaths = defaultPaths(env, process.platform);
      const engine = sandboxEngine(() => false, mainPaths);
      const A = await engine.addAccount('A', bundle('A'));
      const W = await engine.addAccount('W', bundle('W'));
      const C = await engine.addAccount('C', bundle('C'));
      await engine.activate(A.id, { force: true });
      const first = await engine.bindAlias(repo, 'Other', [W.id]);
      const profile = groupProfileDir(mainPaths.vaultDir, first.group.id);
      await engine.activate(C.id, { force: true }); // C is now the global live account

      // The session's own environment: its profile, and its session id.
      const sessionEnv = { ...env, CLAUDE_CONFIG_DIR: profile, [SESSION_ID_ENV]: S_CUR };
      const seenThrough = defaultPaths(sessionEnv, process.platform);
      expect(seenThrough.claudeDir.toLowerCase()).toBe(mainDir.toLowerCase());
      const cliEngine = sandboxEngine(() => false, seenThrough);
      const h = harness(cliEngine, {
        paths: seenThrough,
        env: sessionEnv,
        reconcileGuard: (e: SwitchEngine) => reconcileBindGuard(e, seenThrough),
      });
      await runSessionBind('Auth Work', 'C', { cwd: repo }, h.deps);

      // C was the GLOBAL live account: it moved off global before being reserved.
      expect(await cliEngine.getActiveId('global')).toBe(A.id);
      expect(await cliEngine.checkSlots()).toEqual([]);
      const snapshot = JSON.parse(
        await readFile(folderBindingsPath(mainPaths.vaultDir), 'utf8'),
      ) as { mainConfigDir: string };
      expect(snapshot.mainConfigDir.toLowerCase()).toBe(realpathSync.native(mainDir).toLowerCase());
      // Its own slot was read from the raw env: this session (on the "Other" profile) is outside the
      // new binding, and says so.
      expect(h.text()).toContain('This session is now outside its binding');
      expect(h.text()).toContain(`its binding’s slot`);

      // Unbinding everything from inside the profile removes the guard from the MAIN settings.
      await runSessionUnbind('Auth Work', { cwd: repo }, h.deps);
      await runSessionUnbind('Other', { cwd: repo }, h.deps);
      const settings = await readFile(join(mainDir, 'settings.json'), 'utf8').catch(() => '');
      expect(settings).not.toContain('bind-guard');
      expect(groupSlotId(first.group.id)).toBeTruthy();
    });
  },
);
