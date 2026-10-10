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
  moveLocksDir,
  replayOptions,
  titleOfTranscript,
  type ClaudeRunResult,
  type RunClaude,
} from './backgroundHost.js';

const MAIN = 'C:/Users/me/.claude';
const PROFILE = 'C:/Users/me/AppData/Local/claude-control/profiles/rule-1';
const SID = '1ee43a2b-076b-42a1-b487-70a8b77401fa';
const SHORT = '1ee43a2b';
/** Never written by the in-memory hosts: their tests take no lock. */
const LOCKS = 'C:/Users/me/AppData/Local/claude-control/background-moves';

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

/** A host over in-memory files and a scripted runner. A directory exists when a file sits in it;
 *  `failDir` makes reading one fail the way an unreadable directory does. */
function hostWith(opts: {
  files?: Record<string, string>;
  answer?: (args: string[]) => ClaudeRunResult;
  env?: NodeJS.ProcessEnv;
  alive?: (pid: number) => boolean;
  failDir?: string;
  /** Runs at each pause of a wait, to change the files the way Claude Code would meanwhile. */
  onSleep?: (files: Record<string, string>) => void;
  profilesRoot?: string;
}): { host: ReturnType<typeof createClaudeBackgroundHost>; runs: Recorded[]; sleeps: number[] } {
  const runs: Recorded[] = [];
  const sleeps: number[] = [];
  const files = opts.files ?? {};
  let now = 0;
  const run: RunClaude = (args, o) => {
    runs.push({ args, env: o.env, cwd: o.cwd });
    return Promise.resolve(opts.answer?.(args) ?? { code: 0, stdout: '', stderr: '' });
  };
  const host = createClaudeBackgroundHost({
    mainConfigDir: MAIN,
    moveLockDir: LOCKS,
    env: opts.env ?? { PATH: '/bin' },
    run,
    readFile: (p) => {
      const key = p.replace(/\\/g, '/');
      const text = files[key];
      if (text === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return text;
    },
    readDir: (p) => {
      const dir = p.replace(/\\/g, '/');
      if (dir === opts.failDir) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      // Every file and every subdirectory directly in it.
      const names = [
        ...new Set(
          Object.keys(files)
            .filter((f) => f.startsWith(`${dir}/`))
            .map((f) => f.slice(dir.length + 1).split('/')[0]!),
        ),
      ];
      if (names.length === 0) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return names;
    },
    isProcessAlive: opts.alive ?? (() => true),
    clock: () => now,
    sleep: (ms) => {
      sleeps.push(ms);
      now += ms;
      opts.onSleep?.(files);
      return Promise.resolve();
    },
    ...(opts.profilesRoot !== undefined ? { profilesRoot: opts.profilesRoot } : {}),
  });
  return { host, runs, sleeps };
}

describe('replayOptions', () => {
  const ok = (options: string[]) => ({ ok: true, options });

  it('replays everything Claude Code saves, each value attached to its option', () => {
    // The shape a session started with
    //   --bg --effort low --disallowedTools Bash WebFetch --permission-mode acceptEdits
    //   --model claude-haiku-4-5 --add-dir <a> <b>
    // is saved in (measured), restrictions included.
    expect(
      replayOptions([
        '--effort',
        'low',
        '--disallowedTools',
        'Bash',
        'WebFetch',
        '--permission-mode',
        'acceptEdits',
        '--add-dir',
        'C:/a',
        'C:/b',
        '--model',
        'claude-haiku-4-5',
        '--dangerously-skip-permissions',
        '--settings',
        'C:/s.json',
        '--max-budget-usd',
        '2',
        '--restricted',
      ]),
    ).toEqual(
      ok([
        '--effort=low',
        '--disallowedTools=Bash',
        '--disallowedTools=WebFetch',
        '--permission-mode=acceptEdits',
        '--add-dir=C:/a',
        '--add-dir=C:/b',
        '--model=claude-haiku-4-5',
        '--dangerously-skip-permissions',
        '--settings=C:/s.json',
        '--max-budget-usd=2',
        '--restricted',
      ]),
    );
  });

  it('never drops a restriction while keeping the bypass switch', () => {
    const replay = replayOptions([
      '--dangerously-skip-permissions',
      '--disallowedTools',
      'Bash',
      'WebFetch',
    ]);
    expect(replay).toEqual(
      ok([
        '--dangerously-skip-permissions',
        '--disallowedTools=Bash',
        '--disallowedTools=WebFetch',
      ]),
    );
  });

  it('spells one option the same however it was saved, so two rows compare equal', () => {
    expect(replayOptions(['--model=opus', '--add-dir=C:/a'])).toEqual(
      replayOptions(['--model', 'opus', '--add-dir', 'C:/a']),
    );
    expect(replayOptions(['-n', 'pods'])).toEqual(ok(['--name=pods']));
  });

  it('every word after a list option is one of its values, so none can reach the resume as a prompt', () => {
    // Measured: `--add-dir <a> "trailing words"` saves the trailing words as a directory, which is
    // also how Claude Code read them at launch. Attached to the option, they stay one.
    expect(replayOptions(['--add-dir', 'C:/a', 'trailing words', '--model', 'opus'])).toEqual(
      ok(['--add-dir=C:/a', '--add-dir=trailing words', '--model=opus']),
    );
    // A single-value option takes the next word whatever it looks like, as Claude Code does.
    expect(replayOptions(['--append-system-prompt', '-be terse'])).toEqual(
      ok(['--append-system-prompt=-be terse']),
    );
  });

  it('an empty or absent list replays nothing', () => {
    expect(replayOptions([])).toEqual(ok([]));
    expect(replayOptions(undefined)).toEqual(ok([]));
  });

  it('refuses, rather than drops, anything it cannot place', () => {
    expect(replayOptions(['--model', 'opus', '--brand-new-flag', 'x'])).toEqual({
      ok: false,
      reason: 'it was started with --brand-new-flag, which this cctl cannot carry over',
    });
    // A stray word is never repeated: it could be the session's own text.
    expect(replayOptions(['E1 initial prompt'])).toEqual({
      ok: false,
      reason: 'its saved launch options hold a word this cctl cannot place',
    });
    expect(replayOptions(['--model'])).toMatchObject({ ok: false });
    expect(replayOptions(['--verbose=1'])).toMatchObject({ ok: false });
    expect(replayOptions('not a list')).toEqual({
      ok: false,
      reason: 'its saved launch options could not be read',
    });
    expect(replayOptions([1, '--model', 'opus'])).toMatchObject({ ok: false });
  });

  it('refuses the options that would act again at startup, or name another session', () => {
    for (const saved of [
      ['--file', 'f:a.txt'],
      ['--rewind-files', 'abc'],
      ['--session-id', '1ee43a2b-076b-42a1-b487-70a8b77401fa'],
      ['--exec', 'x'],
      ['-m', 'x'],
      ['--reply-on-resume'],
    ]) {
      expect(replayOptions(saved)).toEqual({
        ok: false,
        reason: `it was started with ${saved[0]!}, which a move does not replay`,
      });
    }
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

    it("reads a config dir's job row: none, unreadable, replayable or not", async () => {
      const row = (o: Record<string, unknown>): string => JSON.stringify(o);
      const { host } = hostWith({
        files: {
          [`${MAIN}/jobs/${SHORT}/state.json`]: row({
            respawnFlags: ['--permission-mode', 'auto'],
            providerEnv: { CLAUDE_CONFIG_DIR: MAIN },
          }),
          [`${PROFILE}/jobs/${SHORT}/state.json`]: '{"respawnFlags": [',
          [`${PROFILE}/jobs/aaaaaaaa/state.json`]: row({ respawnFlags: ['--brand-new-flag'] }),
        },
      });
      expect(await host.savedOptions(null, SHORT)).toEqual({
        kind: 'replayable',
        options: ['--permission-mode=auto'],
      });
      expect(await host.savedOptions(null, 'bbbbbbbb')).toEqual({ kind: 'none' });
      expect(await host.savedOptions(PROFILE, SHORT)).toEqual({ kind: 'unreadable' });
      expect(await host.savedOptions(PROFILE, 'aaaaaaaa')).toMatchObject({ kind: 'unreplayable' });
      expect(await host.savedOptions(null, '../x')).toEqual({ kind: 'none' });
    });

    it('a row holding permission rules granted while it ran cannot be carried over', async () => {
      const reason =
        'it holds permission rules granted while it ran, which a move cannot carry over';
      for (const rules of [
        { allow: [], deny: ['Bash(rm:*)'] },
        { allow: ['Bash(npm test:*)'], deny: [] },
        { allow: [], deny: [], addDirs: ['C:/x'] },
        'garbled',
      ]) {
        const { host } = hostWith({
          files: {
            [`${MAIN}/jobs/${SHORT}/state.json`]: JSON.stringify({
              respawnFlags: [],
              sessionPermissionRules: rules,
            }),
          },
        });
        expect(await host.savedOptions(null, SHORT)).toEqual({ kind: 'unreplayable', reason });
      }
      const empty = hostWith({
        files: {
          [`${MAIN}/jobs/${SHORT}/state.json`]: JSON.stringify({
            respawnFlags: [],
            sessionPermissionRules: { allow: [], deny: [] },
          }),
        },
      });
      expect(await empty.host.savedOptions(null, SHORT)).toEqual({
        kind: 'replayable',
        options: [],
      });
    });
  });

  describe('attachedNow', () => {
    const JOURNAL = `${MAIN}/daemon/attach-journal`;
    const entry = (pid: unknown): string =>
      JSON.stringify({ gestureId: 'g', surface: 'bg_cli', startedAtEpochMs: 1, attempt: 1, pid });

    it('is true while a terminal named in the journal is still running', async () => {
      const { host, runs } = hostWith({
        files: { [`${JOURNAL}/g1.json`]: entry(500), [`${JOURNAL}/g2.json`]: entry(501) },
        alive: (pid) => pid === 501,
      });
      expect(await host.attachedNow(null)).toBe(true);
      expect(runs).toEqual([]);
    });

    it('is false with no journal, or only entries of terminals that have exited or were cleared', async () => {
      expect(await hostWith({}).host.attachedNow(null)).toBe(false);
      const { host } = hostWith({
        files: {
          [`${JOURNAL}/g1.json`]: entry(500),
          [`${JOURNAL}/g2.json`]: '{}',
          [`${JOURNAL}/g3.json.123.cleared`]: 'whatever',
        },
        alive: () => false,
      });
      expect(await host.attachedNow(null)).toBe(false);
    });

    it("reads a profile's own journal for a profile config dir", async () => {
      const { host } = hostWith({
        files: { [`${PROFILE}/daemon/attach-journal/g.json`]: entry(7) },
      });
      expect(await host.attachedNow(null)).toBe(false);
      expect(await host.attachedNow(PROFILE)).toBe(true);
    });

    it('an entry caught mid-write counts as open; a journal that cannot be listed fails', async () => {
      const torn = hostWith({ files: { [`${JOURNAL}/g.json`]: '{"pid": 5' }, alive: () => false });
      expect(await torn.host.attachedNow(null)).toBe(true);
      const locked = hostWith({ failDir: JOURNAL });
      await expect(locked.host.attachedNow(null)).rejects.toThrow('EACCES');
    });
  });

  describe('resumeIdle', () => {
    it('resumes by full id from the cwd, with the options passed and no prompt', async () => {
      const { host, runs } = hostWith({
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
        options: ['--model=opus'],
      });
      expect(runs.map((r) => [r.args, r.cwd, r.env.CLAUDE_CONFIG_DIR])).toEqual([
        [['--bg', '--resume', SID, '--model=opus'], 'C:/research', PROFILE],
      ]);
    });

    it('never drops a row the target holds: with options it refuses, without it wakes with that row', async () => {
      // Claude Code's rm deletes the session's worktree and branch along with the row.
      const files = { [`${PROFILE}/jobs/${SHORT}/state.json`]: '{"state":"stopped"}' };
      const withOptions = hostWith({ files });
      await expect(
        withOptions.host.resumeIdle({
          configDir: PROFILE,
          sessionId: SID,
          short: SHORT,
          cwd: 'C:/r',
          options: ['--model=opus'],
        }),
      ).rejects.toThrow('that config dir already holds a job row for it');
      expect(withOptions.runs).toEqual([]);
      // Even a row that cannot be read is never dropped.
      const torn = hostWith({ files: { [`${PROFILE}/jobs/${SHORT}/state.json`]: '{' } });
      await expect(
        torn.host.resumeIdle({
          configDir: PROFILE,
          sessionId: SID,
          short: SHORT,
          cwd: 'C:/r',
          options: [],
        }),
      ).rejects.toThrow(/already holds a job row/);
      const plain = hostWith({ files });
      await plain.host.resumeIdle({
        configDir: PROFILE,
        sessionId: SID,
        short: SHORT,
        cwd: 'C:/r',
      });
      expect(plain.runs.map((r) => r.args)).toEqual([['--bg', '--resume', SID]]);
      expect(plain.runs.some((r) => r.args[0] === 'rm')).toBe(false);
    });

    it('passes no options when none are given, and an empty list when the target has no row', async () => {
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
      ).rejects.toThrow(
        'claude started a copy (5ad47a09) instead of resuming it: session 1ee43a2b is already ' +
          'running in the background, so this started a copy as 5ad47a09.',
      );
      expect(runs.map((r) => r.args)).toEqual([
        ['--bg', '--resume', SID],
        ['stop', '5ad47a09'],
      ]);
    });

    it("keeps Claude Code's reason for every kind of copy, which is what tells them apart", async () => {
      for (const note of [
        'note: session 1ee43a2b is open in another Claude Code process, so this started a copy ' +
          'as 5ad47a09. The original conversation is unchanged.',
        'note: could not check whether session 1ee43a2b is running, so this started a copy as ' +
          '5ad47a09.',
        'note: a restricted shell does not wake background session 1ee43a2b in place, so this ' +
          'started a restricted copy as 5ad47a09.',
      ]) {
        const { host } = hostWith({
          answer: (args) =>
            args[0] === '--bg'
              ? { code: 0, stdout: 'backgrounded · 5ad47a09', stderr: note }
              : { code: 0, stdout: '', stderr: '' },
        });
        const failure = await host
          .resumeIdle({ configDir: PROFILE, sessionId: SID, short: SHORT, cwd: 'C:/r' })
          .then(
            () => undefined,
            (err: unknown) => (err as Error).message,
          );
        expect(failure).toBe(
          `claude started a copy (5ad47a09) instead of resuming it: ${note.replace(/^note: /, '')}`,
        );
      }
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

describe('what cctl claude reads to find a session', () => {
  const REG = `${MAIN}/sessions`;
  const entry = (o: Record<string, unknown>): string => JSON.stringify(o);
  const OTHER_SID = 'f38038c6-523b-4be5-9dff-160c472faeb0';

  it('reads the shared registry: live entries only, with what each says it is doing', async () => {
    const { host, runs } = hostWith({
      files: {
        [`${REG}/100.json`]: entry({
          pid: 100,
          sessionId: SID,
          kind: 'bg',
          status: 'busy',
          jobId: SHORT,
          name: 'bg eval',
          cwd: 'C:/work',
          messagingSocketPath: 'never read out',
        }),
        [`${REG}/200.json`]: entry({ pid: 200, sessionId: OTHER_SID, kind: 'interactive' }),
        // Left by a process that died hard.
        [`${REG}/300.json`]: entry({ pid: 300, sessionId: SID, kind: 'bg', status: 'idle' }),
        [`${REG}/400.json`]: '{"pid": 4',
        [`${REG}/500.json`]: entry({ pid: 500, sessionId: 'not-a-session' }),
        [`${REG}/notes.txt`]: 'x',
      },
      alive: (pid) => pid !== 300,
    });
    expect(await host.liveSessions()).toEqual([
      {
        pid: 100,
        sessionId: SID,
        kind: 'bg',
        status: 'busy',
        jobId: SHORT,
        name: 'bg eval',
        cwd: 'C:/work',
      },
      { pid: 200, sessionId: OTHER_SID, kind: 'interactive' },
    ]);
    expect(runs).toEqual([]);
    expect(await hostWith({}).host.liveSessions()).toEqual([]);
  });

  it("reads each config dir's job rows: state, name, cwd, when it changed", async () => {
    const row = (o: Record<string, unknown>): string => JSON.stringify(o);
    const { host } = hostWith({
      files: {
        [`${PROFILE}/jobs/${SHORT}/state.json`]: row({
          state: 'failed',
          name: 'bg eval',
          sessionId: SID,
          cwd: 'C:/work',
          updatedAt: '2026-10-09T22:45:19.367Z',
          detail: 'exit 1 before init',
        }),
        // A row whose session id is not its short's, a torn row, and one with no state.
        [`${PROFILE}/jobs/f38038c6/state.json`]: row({ state: 'stopped', sessionId: SID }),
        [`${PROFILE}/jobs/aaaaaaaa/state.json`]: '{',
        [`${PROFILE}/jobs/bbbbbbbb/state.json`]: row({
          sessionId: 'bbbbbbbb-076b-42a1-b487-70a8b77401fa',
        }),
      },
    });
    expect(await host.jobRows(PROFILE)).toEqual([
      {
        short: SHORT,
        sessionId: SID,
        state: 'failed',
        name: 'bg eval',
        cwd: 'C:/work',
        updatedAt: '2026-10-09T22:45:19.367Z',
      },
    ]);
    expect(await host.jobRows(null)).toEqual([]);
  });

  it('lists every profile under the profiles root, and nothing without one', async () => {
    const root = 'C:/Users/me/AppData/Local/claude-control/profiles';
    const { host } = hostWith({
      profilesRoot: root,
      files: {
        [`${root}/rule-1/x`]: '',
        [`${root}/0b5f3c1e-aaaa-4bbb-8ccc-123456789abc/x`]: '',
      },
    });
    expect((await host.profileConfigDirs()).map((p) => p.replace(/\\/g, '/'))).toEqual([
      `${root}/rule-1`,
      `${root}/0b5f3c1e-aaaa-4bbb-8ccc-123456789abc`,
    ]);
    expect(await hostWith({}).host.profileConfigDirs()).toEqual([]);
  });

  it("finds a session's title in whichever project holds its conversation", async () => {
    const lines = [
      JSON.stringify({ type: 'user', message: 'hi' }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'ok', sessionId: SID }),
      JSON.stringify({ type: 'custom-title', customTitle: 'bg eval', sessionId: SID }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'later', sessionId: SID }),
    ].join('\n');
    const { host } = hostWith({
      files: {
        [`${MAIN}/projects/C--other/other.jsonl`]: '',
        [`${MAIN}/projects/C--work/${SID}.jsonl`]: lines,
      },
    });
    expect(await host.sessionTitle(SID)).toBe('bg eval');
    expect(await host.sessionTitle(OTHER_SID)).toBeUndefined();
    expect(await host.sessionTitle('../x')).toBeUndefined();
  });

  it('a title is the last custom title, else the last ai title', () => {
    const line = (o: Record<string, unknown>): string => JSON.stringify(o);
    expect(
      titleOfTranscript(
        [
          line({ type: 'ai-title', aiTitle: 'one' }),
          line({ type: 'ai-title', aiTitle: 'two' }),
        ].join('\n'),
      ),
    ).toBe('two');
    expect(
      titleOfTranscript(
        [
          line({ type: 'custom-title', customTitle: 'named' }),
          line({ type: 'ai-title', aiTitle: 'two' }),
          '{"type":"custom-title" torn',
        ].join('\n'),
      ),
    ).toBe('named');
    expect(
      titleOfTranscript(line({ type: 'user', text: 'mentions "custom-title" in passing' })),
    ).toBeUndefined();
    expect(titleOfTranscript('')).toBeUndefined();
  });
});

describe('stop waits for the session to exit', () => {
  const REG = `${MAIN}/sessions`;
  const live = (): Record<string, string> => ({
    [`${REG}/100.json`]: JSON.stringify({ pid: 100, sessionId: SID, kind: 'bg', jobId: SHORT }),
    [`${MAIN}/daemon/roster.json`]: roster({ [SHORT]: worker(SID, 'C:/work', 4242) }),
  });

  it('returns once the registry and the roster no longer hold it', async () => {
    // Claude Code's stop returns first; the entry goes a moment later, and the terminal host after it.
    let pauses = 0;
    const { host, runs, sleeps } = hostWith({
      files: live(),
      onSleep: (files) => {
        pauses++;
        if (pauses === 3) delete files[`${REG}/100.json`];
        if (pauses === 5) files[`${MAIN}/daemon/roster.json`] = roster({});
      },
    });
    await host.stop(null, SHORT);
    expect(runs.map((r) => r.args)).toEqual([['stop', SHORT]]);
    expect(sleeps).toEqual([100, 100, 100, 100, 100]);
  });

  it('fails when it is still running after the wait, saying so', async () => {
    const { host } = hostWith({ files: live() });
    await expect(host.stop(null, SHORT)).rejects.toThrow(
      'it was still running 10s after claude stop',
    );
  });

  it('does not wait on another session, or on an entry whose process has exited', async () => {
    const { host, sleeps } = hostWith({
      files: {
        [`${REG}/100.json`]: JSON.stringify({ pid: 100, sessionId: SID, kind: 'bg', jobId: SHORT }),
        [`${REG}/200.json`]: JSON.stringify({
          pid: 200,
          sessionId: 'f38038c6-523b-4be5-9dff-160c472faeb0',
          kind: 'bg',
        }),
      },
      alive: (pid) => pid !== 100,
    });
    await host.stop(null, SHORT);
    expect(sleeps).toEqual([]);
  });
});

describe('the move lock', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true, maxRetries: 5 });
    dir = undefined;
  });

  it('is one per session, held until released, and shared by every host on the same dir', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-movelock-'));
    const locks = moveLocksDir(dir);
    const a = createClaudeBackgroundHost({ mainConfigDir: MAIN, moveLockDir: locks });
    const b = createClaudeBackgroundHost({ mainConfigDir: MAIN, moveLockDir: locks });
    const held = await a.lockSession(SID, 0);
    expect(held).toBeDefined();
    expect(await b.lockSession(SID, 0)).toBeUndefined();
    // Another session's lock is its own.
    const other = await b.lockSession('f38038c6-523b-4be5-9dff-160c472faeb0', 0);
    expect(other).toBeDefined();
    held!.release();
    const again = await b.lockSession(SID, 0);
    expect(again).toBeDefined();
    again!.release();
    other!.release();
  });

  it('waits for a holder that lets go within the wait', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-movelock-'));
    const host = createClaudeBackgroundHost({
      mainConfigDir: MAIN,
      moveLockDir: moveLocksDir(dir),
    });
    const first = await host.lockSession(SID, 0);
    setTimeout(() => first!.release(), 300);
    const second = await host.lockSession(SID, 5_000);
    expect(second).toBeDefined();
    second!.release();
  });

  it('names its directory only after a session id', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-movelock-'));
    const host = createClaudeBackgroundHost({
      mainConfigDir: MAIN,
      moveLockDir: moveLocksDir(dir),
    });
    await expect(host.lockSession('../escape', 0)).rejects.toThrow(/not a background session id/);
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
      moveLockDir: join(dir, 'locks'),
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
      options: ['--model=a b "c"', '--add-dir=C:/x y'],
    });
    const seen = JSON.parse(await readFile(record, 'utf8')) as {
      argv: string[];
      cwd: string;
      configDir: string | null;
      claudecode: string | null;
      stdinClosed: boolean;
    };
    expect(seen.argv).toEqual(['--bg', '--resume', SID, '--model=a b "c"', '--add-dir=C:/x y']);
    expect(realpathSync.native(seen.cwd)).toBe(realpathSync.native(work));
    expect(seen.configDir).toBe(PROFILE);
    expect(seen.claudecode).toBeNull();
    expect(seen.stdinClosed).toBe(true);
  });

  it('fails plainly when no claude is on PATH', async () => {
    dir = await mkdtemp(join(tmpdir(), 'cctl-bghost-'));
    const host = createClaudeBackgroundHost({
      mainConfigDir: MAIN,
      moveLockDir: join(dir, 'locks'),
      env: { PATH: dir },
    });
    await expect(host.activity(null)).rejects.toThrow(/claude is not on the PATH/);
  });
});
