import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RefreshError, type StoredAccount } from '@claude-control/switch-engine';
import { buildProgram } from './program.js';
import { CliFailure, reportFatal } from './context.js';
import type { ClaudeRun, ClaudeRunOptions } from './claudeAuthLogin.js';

// `cctl accounts relogin` end to end through commander, with every outside effect stubbed:
//  - the `claude` spawner, so no test ever runs the real `claude auth login` (it really logs in
//    through the browser) or opens a window;
//  - the engine, so nothing reads or writes a vault or a live login;
//  - every path the engine resolves, and the environment variables those paths are derived from,
//    so the throwaway login dir — and anything else a regression might write — lands in a temp
//    folder, never in the operator's real data or config dirs.

const io = vi.hoisted(() => ({ root: '' }));
vi.mock('@claude-control/switch-engine', async (importOriginal) => {
  const real = await importOriginal<typeof import('@claude-control/switch-engine')>();
  return {
    ...real,
    defaultPaths: () => {
      if (io.root === '') throw new Error('defaultPaths called outside a sandboxed test');
      const claudeDir = join(io.root, 'home', '.claude');
      return {
        claudeDir,
        credentialsPath: join(claudeDir, '.credentials.json'),
        claudeJsonPath: join(io.root, 'home', '.claude.json'),
        vaultDir: join(io.root, 'data', 'claude-control', 'vault'),
      };
    },
  };
});

const engine = vi.hoisted(() => ({
  listAllAccounts: vi.fn((): Promise<StoredAccount[]> => Promise.resolve([])),
  readLiveOauth: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  reloginFromConfigDir: vi.fn(),
  reloginFromKeychainDelta: vi.fn(),
}));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => engine,
}));

const spawner = vi.hoisted(() => ({
  spawnClaude: vi.fn((_args: readonly string[], _options: unknown): Promise<unknown> =>
    Promise.reject(new Error('spawnClaude not stubbed')),
  ),
}));
vi.mock('./claudeAuthLogin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claudeAuthLogin.js')>()),
  spawnClaude: spawner.spawnClaude,
}));

const work: StoredAccount = {
  id: 'id-1',
  label: 'work',
  emailAddress: 'me@example.com',
  accountUuid: 'uuid-1',
  quarantined: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

const AUTH_HELP = '  --claudeai  Use Claude subscription\n  --email <email>  Pre-populate email\n';
const ok: ClaudeRun = { status: 0, signal: null, output: '', timedOut: false };

/** Each `claude` run the command made, with the config dir it was pointed at. */
let runs: { args: string[]; configDir: string | undefined }[] = [];

/** Answer the probe with `help` and the login (or window) with `login`. A successful run writes
 *  a credentials file into its config dir, the way the real login does, so the cleanup
 *  assertions below are about a dir that actually held a token file. */
function stubClaude(opts: { help?: string; login?: ClaudeRun } = {}): void {
  spawner.spawnClaude.mockImplementation(async (args, options) => {
    const { env } = options as ClaudeRunOptions;
    runs.push({ args: [...args], configDir: env.CLAUDE_CONFIG_DIR });
    if (args.includes('--help')) return { ...ok, output: opts.help ?? AUTH_HELP };
    const login = opts.login ?? ok;
    if (login.status === 0 && env.CLAUDE_CONFIG_DIR !== undefined) {
      await writeFile(join(env.CLAUDE_CONFIG_DIR, '.credentials.json'), '{"claudeAiOauth":{}}');
    }
    return login;
  });
}

/** The engine call that captures the login, whichever one this platform uses. */
const captureCall = () =>
  process.platform === 'darwin' ? engine.reloginFromKeychainDelta : engine.reloginFromConfigDir;

/** Run one command through commander with stdout/stderr captured — the same shape as the
 *  program tests: a `fail()` comes back as `exited` with its line in `err`. */
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
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { out: out.join(''), err: err.join(''), exited: false };
  } catch (e) {
    if (!(e instanceof CliFailure)) throw e;
    reportFatal(e);
    process.exitCode = undefined;
    return { out: out.join(''), err: err.join(''), exited: true };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

const relogin = (...extra: string[]) => runCli(['accounts', 'relogin', 'work', ...extra]);

/** The throwaway dirs still on disk. Every test ends by asserting this is empty. */
async function leftoverLoginDirs(): Promise<string[]> {
  const parent = join(io.root, 'data', 'claude-control');
  if (!existsSync(parent)) return [];
  return (await readdir(parent)).filter((name) => name.startsWith('relogin-'));
}

beforeEach(async () => {
  io.root = await mkdtemp(join(tmpdir(), 'cctl-relogin-cmd-'));
  // Belt and braces: nothing here should resolve a real path, but if a regression did, these
  // keep it inside the sandbox too.
  for (const name of ['HOME', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'XDG_DATA_HOME']) {
    vi.stubEnv(name, join(io.root, 'env', name));
  }
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(io.root, 'env', 'claude-config'));
  runs = [];
  engine.listAllAccounts.mockResolvedValue([work]);
  engine.readLiveOauth.mockResolvedValue(undefined);
  for (const capture of [engine.reloginFromConfigDir, engine.reloginFromKeychainDelta]) {
    capture.mockReset();
  }
  engine.reloginFromConfigDir.mockResolvedValue({
    account: { ...work, quarantined: false },
    healedLiveLogin: false,
  });
  engine.reloginFromKeychainDelta.mockResolvedValue({ ...work, quarantined: false });
  spawner.spawnClaude.mockReset();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(io.root, { recursive: true, force: true });
  io.root = '';
});

describe('accounts relogin', () => {
  it('offers --window on the command', () => {
    const accounts = buildProgram().commands.find((c) => c.name() === 'accounts');
    const cmd = accounts?.commands.find((c) => c.name() === 'relogin');
    expect(cmd?.options.map((o) => o.long)).toContain('--window');
  });

  it('logs in through `claude auth login` in the throwaway dir and captures from it', async () => {
    stubClaude();
    const r = await relogin();
    expect(r.exited).toBe(false);
    expect(runs.map((run) => run.args)).toEqual([
      ['auth', 'login', '--help'],
      ['auth', 'login', '--claudeai', '--email', 'me@example.com'],
    ]);
    // Both runs point at ONE throwaway dir inside the sandbox — never the inherited config dir.
    const dir = runs[0]?.configDir ?? '';
    expect(runs[1]?.configDir).toBe(dir);
    expect(dir.startsWith(join(io.root, 'data', 'claude-control', 'relogin-'))).toBe(true);
    expect(captureCall()).toHaveBeenCalledTimes(1);
    expect(captureCall().mock.calls[0]?.slice(0, 2)).toEqual(['id-1', dir]);
    expect(r.out).toContain('Sign in as me@example.com');
    expect(r.out).toContain('Re-logged in work (id-1). Quarantine cleared; usage history kept');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('reads the darwin Keychain baseline before any `claude` run', async () => {
    stubClaude();
    const order: string[] = [];
    engine.readLiveOauth.mockImplementation(() => {
      order.push('baseline');
      return Promise.resolve(undefined);
    });
    const spawnImpl = spawner.spawnClaude.getMockImplementation();
    spawner.spawnClaude.mockImplementation((args, options) => {
      order.push('spawn');
      return spawnImpl!(args, options);
    });
    await relogin();
    if (process.platform === 'darwin') expect(order[0]).toBe('baseline');
    else expect(order).not.toContain('baseline');
  });

  it('opens the interactive window instead with --window, without probing', async () => {
    stubClaude();
    const r = await relogin('--window');
    expect(r.exited).toBe(false);
    expect(runs.map((run) => run.args)).toEqual([[]]);
    expect(r.out).toContain('A throwaway Claude window will open.');
    expect(captureCall()).toHaveBeenCalledTimes(1);
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('falls back to the window when this Claude Code has no `auth login`', async () => {
    stubClaude({ help: 'Usage: claude [options] [command] [prompt]\n' });
    const r = await relogin();
    expect(r.exited).toBe(false);
    expect(runs.map((run) => run.args)).toEqual([['auth', 'login', '--help'], []]);
    expect(r.out).toContain('This Claude Code has no `claude auth login`; falling back');
    expect(captureCall()).toHaveBeenCalledTimes(1);
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('fails a login run that exits non-zero, captures nothing and opens no window', async () => {
    stubClaude({ login: { ...ok, status: 1 } });
    const r = await relogin();
    expect(r.exited).toBe(true);
    expect(r.err).toContain('`claude auth login` exited with code 1; the login did not complete');
    expect(r.err).toContain('`cctl accounts relogin work --window`');
    expect(r.err).toContain('`cctl accounts reauth work`');
    expect(runs).toHaveLength(2);
    expect(captureCall()).not.toHaveBeenCalled();
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('fails a login run that timed out, and still deletes the dir', async () => {
    stubClaude({ login: { status: null, signal: 'SIGTERM', output: '', timedOut: true } });
    const r = await relogin();
    expect(r.exited).toBe(true);
    expect(r.err).toContain('did not finish within 15 minutes, so it was stopped');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('reports a login that left no credentials, with the other ways in', async () => {
    stubClaude();
    captureCall().mockRejectedValue(
      new RefreshError('no credentials found in "x"; did the login complete?', 'no_capture_login'),
    );
    const r = await relogin();
    expect(r.exited).toBe(true);
    expect(r.err).toContain('no credentials found in "x"; did the login complete?');
    expect(r.err).toContain('Re-run, or log in through an interactive window');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('reports a wrong-account login with how to recover, and the guard still refuses', async () => {
    stubClaude();
    captureCall().mockRejectedValue(
      new RefreshError(
        'the captured login is a different account (other@example.com) than "work" - re-login ' +
          'must use the SAME account to keep its usage history intact',
        'relogin_identity_mismatch',
      ),
    );
    const r = await relogin();
    expect(r.exited).toBe(true);
    expect(r.err).toContain('the captured login is a different account (other@example.com)');
    expect(r.err).toContain('The browser was signed in to a different claude.ai account.');
    expect(r.err).toContain('Switch it to me@example.com on claude.ai and re-run.');
    expect(r.err).toContain('`cctl accounts relogin work --window`');
    expect(r.err).toContain('`cctl accounts reauth work`');
    expect(r.out).not.toContain('Re-logged in');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  // The window's /login can be pointed at any account, so the browser advice does not apply there.
  it('reports a wrong-account window login with the engine message alone', async () => {
    stubClaude();
    captureCall().mockRejectedValue(
      new RefreshError('the captured login is a different account', 'relogin_identity_mismatch'),
    );
    const r = await relogin('--window');
    expect(r.exited).toBe(true);
    expect(r.err).toContain('the captured login is a different account');
    expect(r.err).not.toContain('claude.ai account');
    expect(r.err).not.toContain('--window');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('still deletes the dir when the capture throws something unexpected', async () => {
    stubClaude();
    captureCall().mockRejectedValue(new Error('disk on fire'));
    await expect(relogin()).rejects.toThrow('disk on fire');
    expect(await leftoverLoginDirs()).toEqual([]);
  });

  it('refuses an unknown account before running anything', async () => {
    stubClaude();
    const r = await runCli(['accounts', 'relogin', 'nobody']);
    expect(r.exited).toBe(true);
    expect(runs).toEqual([]);
    expect(await leftoverLoginDirs()).toEqual([]);
  });
});
