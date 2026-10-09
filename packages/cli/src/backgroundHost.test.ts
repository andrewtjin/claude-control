// Tests for the daemon's seam to Claude Code's background service.
//
// Most cases drive the host through an injected command runner and file reader, so what it reads
// out of a service's roster and job rows, which commands it runs (in what order, with what
// environment and working directory) and how it reads Claude Code's answers are pinned without a
// Claude Code binary. The last block runs the REAL runner against a fake `claude` put on PATH (an
// npm-style .cmd shim on Windows, a node script elsewhere), so the no-shell spawn, the closed stdin,
// the environment and the working directory are proven on the path production uses.

import { realpathSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createClaudeBackgroundHost,
  replayableOptions,
  type ClaudeRunResult,
  type RunClaude,
} from './backgroundHost.js';

const MAIN = 'C:/Users/me/.claude';
const PROFILE = 'C:/Users/me/AppData/Local/claude-control/profiles/rule-1';
const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SHORT = '1ee43a2b';

/** A roster as Claude Code writes it, including the attach secrets the host must never read out. */
function roster(workers: Record<string, unknown>): string {
  return JSON.stringify({ proto: 1, supervisorPid: 1, updatedAt: 1, workers });
}

function worker(sessionId: string, cwd: string, pid = 4242): Record<string, unknown> {
  return {
    pid,
    sessionId,
    cwd,
    rvAuth: 'secret-rv',
    ptyAuth: 'secret-pty',
    dispatch: { env: { CLAUDE_CONFIG_DIR: MAIN } },
  };
}

interface Recorded {
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string | undefined;
}

/** A host over in-memory files and a scripted runner. */
function hostWith(opts: {
  files?: Record<string, string>;
  answer?: (args: string[]) => ClaudeRunResult;
  env?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
}): { host: ReturnType<typeof createClaudeBackgroundHost>; runs: Recorded[] } {
  const runs: Recorded[] = [];
  const files = opts.files ?? {};
  const run: RunClaude = (args, o) => {
    runs.push({ args, env: o.env, cwd: o.cwd });
    return Promise.resolve(opts.answer?.(args) ?? { code: 0, stdout: '', stderr: '' });
  };
  const host = createClaudeBackgroundHost({
    mainConfigDir: MAIN,
    env: opts.env ?? { PATH: '/bin' },
    run,
    readFile: (p) => {
      const key = p.replace(/\\/g, '/');
      const text = files[key];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    isProcessAlive: opts.alive ?? (() => true),
  });
  return { host, runs };
}

describe('replayableOptions', () => {
  it('keeps model, permission mode, added dirs and the skip-permissions switch, in both spellings', () => {
    expect(
      replayableOptions([
        '--model',
        'opus',
        '--permission-mode=auto',
        '--add-dir',
        'C:/a',
        '--dangerously-skip-permissions',
      ]),
    ).toEqual([
      '--model',
      'opus',
      '--permission-mode=auto',
      '--add-dir',
      'C:/a',
      '--dangerously-skip-permissions',
    ]);
  });

  it('drops the first prompt a job row can hold, and anything it does not know', () => {
    // Measured: a session started with a prompt saved it in respawnFlags. Replayed, it would start
    // a turn under the new account.
    expect(replayableOptions(['E1 initial prompt'])).toEqual([]);
    expect(replayableOptions(['--verbose', '--settings', 'x.json', 'hello'])).toEqual([]);
    expect(replayableOptions(['--model'])).toEqual([]);
    expect(replayableOptions(['--model', '--permission-mode', 'auto'])).toEqual([
      '--permission-mode',
      'auto',
    ]);
    expect(replayableOptions('not a list')).toEqual([]);
    expect(replayableOptions([1, null, '--model', 'opus'])).toEqual(['--model', 'opus']);
  });
});

describe('createClaudeBackgroundHost', () => {
  describe('listHosted', () => {
    it("reads the service's roster without running Claude Code, keeping only id, session and cwd", async () => {
      const { host, runs } = hostWith({
        files: { [`${MAIN}/daemon/roster.json`]: roster({ [SHORT]: worker(SID, 'C:/research') }) },
      });
      const hosted = await host.listHosted(null);
      expect(hosted).toEqual([{ short: SHORT, sessionId: SID, cwd: 'C:/research' }]);
      expect(JSON.stringify(hosted)).not.toContain('secret');
      expect(runs).toEqual([]);
    });

    it("reads a folder profile's own roster for a profile config dir", async () => {
      const { host } = hostWith({
        files: {
          [`${MAIN}/daemon/roster.json`]: roster({}),
          [`${PROFILE}/daemon/roster.json`]: roster({ [SHORT]: worker(SID, 'C:/research') }),
        },
      });
      expect(await host.listHosted(null)).toEqual([]);
      expect((await host.listHosted(PROFILE)).map((s) => s.short)).toEqual([SHORT]);
    });

    it('skips a worker whose terminal host is dead (a roster left by a service that died)', async () => {
      const { host } = hostWith({
        files: { [`${MAIN}/daemon/roster.json`]: roster({ [SHORT]: worker(SID, 'C:/r', 99) }) },
        alive: (pid) => pid !== 99,
      });
      expect(await host.listHosted(null)).toEqual([]);
    });

    it('skips malformed workers and reads a missing or torn roster as nothing hosted', async () => {
      const { host } = hostWith({
        files: {
          [`${MAIN}/daemon/roster.json`]: roster({
            NOTSHORT: worker(SID, 'C:/r'),
            f38038c6: worker(SID, 'C:/r'), // a session id that is not this short's
            abcdef12: { ...worker('ABCDEF12-076B-42A1-B487-70A8B77401FA', 'C:/r') },
            '1ee43a2c': { pid: 1, sessionId: '1ee43a2c-076b-42a1-b487-70a8b77401fa' },
          }),
          [`${PROFILE}/daemon/roster.json`]: '{"workers": {',
        },
      });
      expect(await host.listHosted(null)).toEqual([]);
      expect(await host.listHosted(PROFILE)).toEqual([]);
      expect(await host.listHosted('C:/nowhere')).toEqual([]);
    });
  });

  describe('activity', () => {
    it('reads `claude agents --json`: idle only when Claude Code says idle', async () => {
      const { host, runs } = hostWith({
        answer: () => ({
          code: 0,
          stderr: '',
          stdout: JSON.stringify([
            { id: SHORT, status: 'idle', state: 'working', name: 'pods' },
            { id: 'f38038c6', status: 'busy' },
            { id: 'aaaaaaaa', status: 'waiting' },
            { id: 'not-an-id', status: 'idle' },
          ]),
        }),
      });
      const activity = await host.activity(null);
      expect([...activity]).toEqual([
        [SHORT, { idle: true, name: 'pods' }],
        ['f38038c6', { idle: false }],
        ['aaaaaaaa', { idle: false }],
      ]);
      expect(runs.map((r) => r.args)).toEqual([['agents', '--json']]);
    });

    it('fails on a non-zero exit or output that is not a JSON list', async () => {
      const failing = hostWith({ answer: () => ({ code: 1, stdout: '', stderr: 'boom\nmore' }) });
      await expect(failing.host.activity(null)).rejects.toThrow('claude agents exited 1: boom');
      const garbled = hostWith({ answer: () => ({ code: 0, stdout: 'hello', stderr: '' }) });
      await expect(garbled.host.activity(null)).rejects.toThrow(/did not print JSON/);
      const object = hostWith({ answer: () => ({ code: 0, stdout: '{}', stderr: '' }) });
      await expect(object.host.activity(null)).rejects.toThrow(/did not print a list/);
    });
  });

  describe('the environment each command runs with', () => {
    const daemonEnv: NodeJS.ProcessEnv = {
      PATH: '/bin',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:1',
      CLAUDECODE: '1',
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDE_CODE_SESSION_KIND: 'bg',
      CLAUDE_JOB_DIR: 'x',
      CLAUDE_PROJECT_DIR: 'y',
      CCTL_BIND_OVERRIDE: 'tok',
      CCTL_LAUNCH_EXPLICIT: 'tok',
      CCTL_BIND_ENFORCE: 'off',
    };
    const answer = (): ClaudeRunResult => ({ code: 0, stdout: '[]', stderr: '' });

    it('names a profile with CLAUDE_CONFIG_DIR and strips every session marker', async () => {
      const { host, runs } = hostWith({ env: daemonEnv, answer });
      await host.activity(PROFILE);
      const env = runs[0]!.env;
      expect(env.CLAUDE_CONFIG_DIR).toBe(PROFILE);
      expect(env.PATH).toBe('/bin');
      expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:1');
      for (const marker of [
        'CLAUDECODE',
        'CLAUDE_CODE_ENTRYPOINT',
        'CLAUDE_CODE_SESSION_KIND',
        'CLAUDE_JOB_DIR',
        'CLAUDE_PROJECT_DIR',
        'CCTL_BIND_OVERRIDE',
        'CCTL_LAUNCH_EXPLICIT',
        'CCTL_BIND_ENFORCE',
      ]) {
        expect(env[marker]).toBeUndefined();
      }
    });

    it('reaches the main config the way the daemon does: no CLAUDE_CONFIG_DIR when it has none', async () => {
      const { host, runs } = hostWith({ env: daemonEnv, answer });
      await host.activity(null);
      expect('CLAUDE_CONFIG_DIR' in runs[0]!.env).toBe(false);
      const spelled = hostWith({
        env: { ...daemonEnv, CLAUDE_CONFIG_DIR: 'C:/x/.claude' },
        answer,
      });
      await spelled.host.activity(null);
      expect(spelled.runs[0]!.env.CLAUDE_CONFIG_DIR).toBe(MAIN);
    });
  });

  describe('stop and savedOptions', () => {
    it('stops by short id and fails with what Claude Code said', async () => {
      const ok = hostWith({});
      await ok.host.stop(null, SHORT);
      expect(ok.runs.map((r) => r.args)).toEqual([['stop', SHORT]]);
      const refused = hostWith({
        answer: () => ({ code: 1, stdout: 'no such session', stderr: '' }),
      });
      await expect(refused.host.stop(null, SHORT)).rejects.toThrow(
        'claude stop exited 1: no such session',
      );
      await expect(ok.host.stop(null, '../x')).rejects.toThrow(/not a background session id/);
    });

    it("replays only the safe options of the config dir's job row", async () => {
      const { host } = hostWith({
        files: {
          [`${MAIN}/jobs/${SHORT}/state.json`]: JSON.stringify({
            respawnFlags: ['--permission-mode', 'auto', 'S initial prompt'],
            providerEnv: { CLAUDE_CONFIG_DIR: MAIN },
          }),
        },
      });
      expect(await host.savedOptions(null, SHORT)).toEqual(['--permission-mode', 'auto']);
      expect(await host.savedOptions(PROFILE, SHORT)).toEqual([]);
    });
  });

  describe('resumeIdle', () => {
    it('drops a stale row in the target first, then resumes by full id from the cwd, with no prompt', async () => {
      const { host, runs } = hostWith({
        files: { [`${PROFILE}/jobs/${SHORT}/state.json`]: '{"state":"stopped"}' },
        answer: (args) => ({
          code: 0,
          stderr: '',
          stdout:
            args[0] === '--bg' ? `backgrounded · ${SHORT} (idle — send a prompt to start)` : '',
        }),
      });
      await host.resumeIdle({
        configDir: PROFILE,
        sessionId: SID,
        short: SHORT,
        cwd: 'C:/research',
        options: ['--model', 'opus'],
      });
      expect(runs.map((r) => [r.args, r.cwd, r.env.CLAUDE_CONFIG_DIR])).toEqual([
        [['rm', SHORT], undefined, PROFILE],
        [['--bg', '--resume', SID, '--model', 'opus'], 'C:/research', PROFILE],
      ]);
    });

    it('does not drop anything when the target has no row, or when no options are passed', async () => {
      const noRow = hostWith({});
      await noRow.host.resumeIdle({
        configDir: PROFILE,
        sessionId: SID,
        short: SHORT,
        cwd: 'C:/r',
        options: [],
      });
      expect(noRow.runs.map((r) => r.args)).toEqual([['--bg', '--resume', SID]]);
      // Waking it back with its own saved options: the row stays.
      const back = hostWith({ files: { [`${MAIN}/jobs/${SHORT}/state.json`]: '{}' } });
      await back.host.resumeIdle({ configDir: null, sessionId: SID, short: SHORT, cwd: 'C:/r' });
      expect(back.runs.map((r) => r.args)).toEqual([['--bg', '--resume', SID]]);
    });

    it('a copy started instead of the session is stopped, and the resume fails', async () => {
      const { host, runs } = hostWith({
        answer: (args) =>
          args[0] === '--bg'
            ? {
                code: 0,
                stderr: '',
                stdout:
                  'note: session 1ee43a2b is already running in the background, so this started ' +
                  'a copy as 5ad47a09.\nbackgrounded · 5ad47a09',
              }
            : { code: 0, stdout: '', stderr: '' },
      });
      await expect(
        host.resumeIdle({ configDir: PROFILE, sessionId: SID, short: SHORT, cwd: 'C:/r' }),
      ).rejects.toThrow('claude started a copy (5ad47a09) instead of resuming it');
      expect(runs.map((r) => r.args)).toEqual([
        ['--bg', '--resume', SID],
        ['stop', '5ad47a09'],
      ]);
    });

    it("fails on Claude Code's refusal, and refuses an id that is not a full session id", async () => {
      const refused = hostWith({
        answer: () => ({
          code: 1,
          stdout: '',
          stderr: 'Your message is saved and will be delivered when session 1ee43a2b next starts.',
        }),
      });
      await expect(
        refused.host.resumeIdle({ configDir: PROFILE, sessionId: SID, short: SHORT, cwd: 'C:/r' }),
      ).rejects.toThrow(/exited 1: Your message is saved/);
      const { host, runs } = hostWith({});
      await expect(
        host.resumeIdle({ configDir: PROFILE, sessionId: SHORT, short: SHORT, cwd: 'C:/r' }),
      ).rejects.toThrow(/not a background session id/);
      await expect(
        host.resumeIdle({
          configDir: PROFILE,
          sessionId: SID.toUpperCase(),
          short: SHORT,
          cwd: 'C:/r',
        }),
      ).rejects.toThrow(/not a background session id/);
      expect(runs).toEqual([]);
    });
  });
});

describe('the real runner, against a fake claude on PATH', () => {
  // The fake records its argv, cwd, selected env and whether stdin was closed, then answers like
  // Claude Code's resume.
  const FAKE = `
const fs = require('fs');
let stdinClosed = false;
try { stdinClosed = fs.readFileSync(0, 'utf8') === ''; } catch (e) { stdinClosed = true; }
fs.writeFileSync(process.env.FAKE_RECORD, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  configDir: process.env.CLAUDE_CONFIG_DIR ?? null,
  claudecode: process.env.CLAUDECODE ?? null,
  stdinClosed,
}));
process.stdout.write('backgrounded · 1ee43a2b (idle — send a prompt to start)\\n');
`;
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    dir = undefined;
  });

  it('runs it without a shell, stdin closed, in the cwd, with the profile env', async () => {
    dir = realpathSync.native(await mkdtemp(join(tmpdir(), 'cctl-bghost-')));
    const bin = join(dir, 'bin');
    const work = join(dir, "work & (x) 'q' é");
    await mkdir(bin, { recursive: true });
    await mkdir(work, { recursive: true });
    await writeFile(join(bin, 'fake.js'), FAKE, 'utf8');
    if (process.platform === 'win32') {
      // An npm-style shim the launcher unwraps to `node fake.js`.
      await writeFile(join(bin, 'claude.cmd'), '@ECHO off\r\n"%_prog%" "%dp0%\\fake.js" %*\r\n');
    } else {
      await writeFile(join(bin, 'claude'), `#!${process.execPath}\n${FAKE}`, 'utf8');
      await chmod(join(bin, 'claude'), 0o755);
    }
    const record = join(dir, 'record.json');
    const host = createClaudeBackgroundHost({
      mainConfigDir: MAIN,
      env: {
        PATH: bin,
        PATHEXT: '.EXE;.CMD',
        SystemRoot: process.env.SystemRoot,
        FAKE_RECORD: record,
        CLAUDECODE: '1',
      },
    });
    await host.resumeIdle({
      configDir: PROFILE,
      sessionId: SID,
      short: SHORT,
      cwd: work,
      options: ['--model', 'a b "c"'],
    });
    const seen = JSON.parse(await readFile(record, 'utf8')) as {
      argv: string[];
      cwd: string;
      configDir: string | null;
      claudecode: string | null;
      stdinClosed: boolean;
    };
    expect(seen.argv).toEqual(['--bg', '--resume', SID, '--model', 'a b "c"']);
    expect(realpathSync.native(seen.cwd)).toBe(realpathSync.native(work));
    expect(seen.configDir).toBe(PROFILE);
    expect(seen.claudecode).toBeNull();
    expect(seen.stdinClosed).toBe(true);
  });

  it('fails plainly when no claude is on PATH', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-bghost-'));
    const host = createClaudeBackgroundHost({ mainConfigDir: MAIN, env: { PATH: dir } });
    await expect(host.activity(null)).rejects.toThrow(/claude is not on the PATH/);
  });
});
