// The running-session scan that guards dissolving an alias binding, wired as in production: a real
// SwitchEngine with `sessionIdentity: sessionIdentities` (the daemon's transcript catalog), real
// `sessions/<pid>.json` files and real transcripts. A session counts as running in an alias scope
// when its transcript names the title; when its title cannot be learned at all — its transcript
// cannot be read, or it has none yet (a fork or a new session before its first prompt, whose
// session file carries only a DERIVED name) — and it runs in the alias folder, it MAY be that
// conversation, so the dissolve is refused without --force and the refusal says why.

import { spawn, type ChildProcess } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FileCredentialChannel,
  InsecurePassthroughProtector,
  SwitchEngine,
  projectDirStem,
  sandboxPaths,
  type ClaudeOauth,
  type CredentialBundle,
  type Paths,
} from '@claude-control/switch-engine';
import { sessionIdentities } from '@claude-control/daemon';

const NOW = Date.now();
const bundle = (t: string): CredentialBundle => ({
  claudeAiOauth: { accessToken: t, refreshToken: 'r-' + t, expiresAt: NOW + 3_600_000 * 100 },
  oauthAccount: { accountUuid: 'uuid-' + t, emailAddress: t + '@example.com' },
});

const ID = (n: number): string =>
  `${n}${n}${n}${n}${n}${n}${n}${n}-${n}${n}${n}${n}-4${n}${n}${n}-8${n}${n}${n}-${`${n}`.repeat(12)}`;

let root: string;
let paths: Paths;
let repo: string;
let engine: SwitchEngine;
const ALIVE = new Set<number>();
let holder: ChildProcess | undefined;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-running-scan-'));
  paths = sandboxPaths(root);
  await mkdir(join(paths.claudeDir, 'sessions'), { recursive: true });
  await mkdir(join(root, 'repo'), { recursive: true });
  repo = realpathSync.native(join(root, 'repo'));
  engine = new SwitchEngine({
    paths,
    protector: new InsecurePassthroughProtector(),
    liveCredentialChannel: new FileCredentialChannel(paths.credentialsPath),
    refresh: (c: ClaudeOauth) => Promise.resolve(c),
    minSwitchIntervalMs: 0,
    lockOptions: { timeoutMs: 5000, pollMs: 10 },
    isProcessAlive: (pid) => ALIVE.has(pid),
    bindEnforce: 'block',
    sessionIdentity: sessionIdentities,
  });
  const main = await engine.addAccount('main', bundle('a'));
  const work = await engine.addAccount('work', bundle('b'));
  await engine.activate(main.id, { force: true });
  await engine.bindAlias(repo, 'auth', [work.id]);
});

afterEach(async () => {
  holder?.kill();
  holder = undefined;
  ALIVE.clear();
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A running Claude Code session as its pid file records it (measured shape, 2.1.283). */
async function pidFile(
  pid: number,
  sessionId: string,
  nameSource: 'derived' | 'user',
  name: string,
  cwd = repo,
): Promise<void> {
  await writeFile(
    join(paths.claudeDir, 'sessions', `${pid}.json`),
    JSON.stringify({ pid, sessionId, cwd, name, nameSource, startedAt: NOW }),
  );
  ALIVE.add(pid);
}

/** The session's transcript, recorded in `cwd`, where Claude Code keeps it. */
async function transcript(sessionId: string, title: string, cwd = repo): Promise<string> {
  const dir = join(paths.claudeDir, 'projects', projectDirStem(cwd));
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${sessionId}.jsonl`);
  await writeFile(
    file,
    [
      JSON.stringify({ type: 'user', cwd, sessionId, timestamp: new Date(NOW).toISOString() }),
      JSON.stringify({ type: 'custom-title', customTitle: title, sessionId }),
    ].join('\n') + '\n',
  );
  return file;
}

/** How an unbind turned out: dissolved, or the refusal's code and message. */
const outcome = (p: Promise<unknown>): Promise<string> =>
  p.then(
    (r) => `dissolved ${JSON.stringify((r as { dissolved?: boolean }).dissolved)}`,
    (e: Error & { code?: string }) => `refused (${e.code ?? e.name}): ${e.message}`,
  );

describe('dissolving an alias binding while sessions run', () => {
  it('a resumed session whose transcript names the alias blocks it', async () => {
    await pidFile(4101, ID(1), 'derived', 'repo-4101');
    await transcript(ID(1), 'Auth');
    expect(await outcome(engine.unbindAlias(repo, 'auth'))).toMatch(
      /^refused \(sessions_running\): .*has 1 running session\(s\) under it; exit them/,
    );
  });

  it('a session whose transcript names another title does not', async () => {
    await pidFile(4102, ID(2), 'derived', 'repo-4102');
    await transcript(ID(2), 'Something Else');
    expect(await outcome(engine.unbindAlias(repo, 'auth'))).toBe('dissolved true');
  });

  it('a fork (or a new session) before its first prompt — no transcript, a derived name — blocks it, saying why', async () => {
    // Measured: a fork keeps the title under a NEW id whose transcript is written after its first
    // prompt; its session file's name is derived.
    await pidFile(4103, ID(3), 'derived', 'repo-4103');
    const got = await outcome(engine.unbindAlias(repo, 'auth'));
    expect(got).toMatch(/^refused \(sessions_running\)/);
    expect(got).toContain('1 of them could not be identified');
    expect(got).toContain('rerun with --force');
    expect(await outcome(engine.unbindAlias(repo, 'auth', { force: true }))).toBe('dissolved true');
  });

  it('an unidentified session in ANOTHER folder does not block it', async () => {
    await mkdir(join(root, 'elsewhere'), { recursive: true });
    await pidFile(4104, ID(4), 'derived', 'x', realpathSync.native(join(root, 'elsewhere')));
    expect(await outcome(engine.unbindAlias(repo, 'auth'))).toBe('dissolved true');
  });

  it.runIf(process.platform === 'win32')(
    'a resumed session whose transcript is held open exclusively (a scanner, a sync client) blocks it',
    async () => {
      await pidFile(4105, ID(5), 'derived', 'repo-4105');
      const file = await transcript(ID(5), 'Auth');
      holder = spawn('powershell.exe', [
        '-NoProfile',
        '-Command',
        `$f=[System.IO.File]::Open('${file.replace(/'/g, "''")}','Open','Read','None'); ` +
          'Write-Output locked; Start-Sleep -Seconds 30',
      ]);
      await new Promise<void>((resolve, reject) => {
        const to = setTimeout(() => reject(new Error('the lock holder never locked')), 15000);
        holder!.stdout!.once('data', () => {
          clearTimeout(to);
          resolve();
        });
      });
      // The lookup names the unreadable transcript rather than dropping it.
      const ids = await sessionIdentities(paths.claudeDir, [ID(5)]);
      expect(ids.get(ID(5))).toEqual({
        customTitle: null,
        folder: null,
        dirName: projectDirStem(repo),
        unreadable: true,
      });
      const got = await outcome(engine.unbindAlias(repo, 'auth'));
      expect(got).toMatch(/^refused \(sessions_running\)/);
      expect(got).toContain('could not be identified');
    },
    60_000,
  );
});
