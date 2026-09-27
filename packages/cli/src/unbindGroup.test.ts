// `cctl unbind --group` over real engines on a sandbox vault (the CLI's buildEngine seam is pointed
// at one). The one interposition lets a SECOND real engine — another cctl process — act at the
// moment the CLI calls into its engine, after the CLI's own unlocked read of the binding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
  type StoredAccount,
} from '@claude-control/switch-engine';

const current = vi.hoisted((): { engine: unknown } => ({ engine: null }));
vi.mock('./context.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./context.js')>()),
  buildEngine: () => current.engine,
}));

import { buildProgram } from './program.js';
import { CliFailure, reportFatal } from './context.js';

const HOUR = 3_600_000;
const NOW = Date.now();
const bundle = (t: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: t, refreshToken: 'r-' + t, expiresAt: NOW + 100 * HOUR },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@example.com' },
});

let root: string;
let paths: Paths;
let repo: string;
let acct: Record<'main' | 'work' | 'client' | 'extra', StoredAccount>;

function sandboxEngine(): SwitchEngine {
  return new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (cur: ClaudeOauth) => Promise.resolve(cur),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 10 },
    isProcessAlive: () => false,
    bindEnforce: 'block',
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-unbind-group-'));
  vi.stubEnv('LOCALAPPDATA', root);
  vi.stubEnv('XDG_DATA_HOME', root);
  vi.stubEnv('CLAUDE_CONFIG_DIR', join(root, 'claude'));
  vi.stubEnv('CCTL_LOG_FILE', undefined);
  paths = sandboxPaths(root);
  await mkdir(paths.claudeDir, { recursive: true });
  await mkdir(join(root, 'repo'), { recursive: true });
  repo = realpathSync.native(join(root, 'repo'));
  const e = sandboxEngine();
  acct = {
    main: await e.addAccount('main', bundle('a')),
    work: await e.addAccount('work', bundle('b')),
    client: await e.addAccount('client', bundle('c')),
    extra: await e.addAccount('extra', bundle('d')),
  };
  await e.activate(acct.main.id, { force: true });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true, maxRetries: 5 });
});

async function runCli(args: string[]): Promise<{ out: string; err: string; exited: boolean }> {
  const out: string[] = [];
  const err: string[] = [];
  const so = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation((c) => (out.push(String(c)), true));
  const se = vi
    .spyOn(process.stderr, 'write')
    .mockImplementation((c) => (err.push(String(c)), true));
  try {
    await buildProgram().parseAsync(args, { from: 'user' });
    return { out: out.join(''), err: err.join(''), exited: false };
  } catch (e) {
    if (e instanceof CliFailure) {
      reportFatal(e);
      process.exitCode = undefined;
      return { out: out.join(''), err: err.join(''), exited: true };
    }
    throw e;
  } finally {
    so.mockRestore();
    se.mockRestore();
  }
}

describe('cctl unbind --group', () => {
  it('dissolves the binding as it stands under the lock, even when it grew after the CLI listed it', async () => {
    const g = (await sandboxEngine().bindAlias(repo, 'auth', [acct.work.id, acct.client.id])).group;
    const cli = sandboxEngine();
    const other = sandboxEngine();
    const original = cli.dissolveGroup.bind(cli);
    cli.dissolveGroup = async (...a) => {
      // Another process (`cctl session bind auth extra`, run inside the session) grows the binding
      // after this CLI listed its members but before its engine call takes the lock.
      await other.addGroupMembers(g.id, [acct.extra.id], {
        soleScope: { kind: 'alias', folder: repo, alias: 'auth' },
      });
      return original(...a);
    };
    current.engine = cli;

    const r = await runCli(['unbind', '--group', g.id]);

    // "Dissolved" means no binding is left, and what it says it released is what it released.
    expect(r.exited).toBe(false);
    expect(await sandboxEngine().listGroups()).toEqual([]);
    expect(r.out).toContain('3 account(s) returned to the shared pool (work, client, extra)');
    const shared = (await sandboxEngine().listAccounts()).map((a) => a.label).sort();
    expect(shared).toEqual(['client', 'extra', 'main', 'work']);
  });

  it('refuses a binding that is gone by the time it takes the lock, changing nothing', async () => {
    const g = (await sandboxEngine().bindAlias(repo, 'auth', [acct.work.id])).group;
    const cli = sandboxEngine();
    const original = cli.dissolveGroup.bind(cli);
    cli.dissolveGroup = async (...a) => {
      await sandboxEngine().unbindAlias(repo, 'auth');
      return original(...a);
    };
    current.engine = cli;
    const r = await runCli(['unbind', '--group', g.id]);
    expect(r.exited).toBe(true);
    expect(r.err).toContain(`no binding group with id "${g.id}"`);
  });
});
