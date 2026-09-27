// Session catalog tests. Every fixture lives in a temp dir standing in for `Paths.claudeDir`, so
// nothing here reads a real ~/.claude.
//
// The rules pinned here are the ones `claude --resume <name>` applies to the same files: the alias
// is `customTitle ?? aiTitle` (last-wins each), the folder is the last relocation else the launch
// cwd, and a message that merely QUOTES a title line is never mistaken for one. An alias that
// disagrees with Claude Code's own reading would send `cctl session show` to the wrong session.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  aliasKey,
  aliasOf,
  projectDirMatches,
  projectDirStem,
  readSessionCatalog,
  type SessionMeta,
} from './sessionCatalog.js';

// Directory and file failures are simulated rather than provoked with OS permissions (which do
// not reliably deny a folder's own owner on every platform). A path carrying one of these markers
// fails; every other path goes through the real filesystem.
const LOCKED_MARKER = 'EACCES-DIR';
const VANISHED_MARKER = 'VANISHED';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const denied = (code: string): NodeJS.ErrnoException => {
    const err = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
    err.code = code;
    return err;
  };
  return {
    ...actual,
    readdir: vi.fn((path: string, options: { withFileTypes: true }) => {
      if (path.includes(LOCKED_MARKER)) return Promise.reject(denied('EACCES'));
      return actual.readdir(path, options);
    }),
    stat: vi.fn((path: string) => {
      if (path.includes(VANISHED_MARKER)) return Promise.reject(denied('ENOENT'));
      return actual.stat(path);
    }),
  };
});

let root: string;
let claudeDir: string;
let projectsDir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'cctl-catalog-'));
  claudeDir = join(root, 'claude');
  projectsDir = join(claudeDir, 'projects');
  await mkdir(projectsDir, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// Line builders in Claude Code's on-disk shapes. `JSON.stringify` puts `type` first with no
// spaces, exactly as the CLI writes it, which is what the byte needles look for.
const userLine = (cwd: string, ts: string, content = 'hello'): string =>
  JSON.stringify({ type: 'user', cwd, timestamp: ts, message: { role: 'user', content } });
const customTitle = (title: string): string =>
  JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: 'x' });
const aiTitle = (title: string): string =>
  JSON.stringify({ type: 'ai-title', aiTitle: title, sessionId: 'x' });
const relocated = (cwd: string): string => JSON.stringify({ type: 'relocated', relocatedCwd: cwd });

async function writeSession(
  projectDir: string,
  sessionId: string,
  lines: string[],
): Promise<string> {
  const dir = join(projectsDir, projectDir);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${sessionId}.jsonl`);
  await writeFile(path, lines.join('\n') + '\n', 'utf8');
  return path;
}

/** Set a file's mtime to a whole-second instant (so mtimeMs compares exactly). */
async function setMtime(path: string, ms: number): Promise<void> {
  await utimes(path, ms / 1000, ms / 1000);
}

async function only(options: Parameters<typeof readSessionCatalog>[0] = { claudeDir }) {
  const catalog = await readSessionCatalog(options);
  expect(catalog.sessions).toHaveLength(1);
  return catalog.sessions[0] as SessionMeta;
}

const TS1 = '2026-09-01T10:00:00.000Z';
const TS2 = '2026-09-01T11:00:00.000Z';

describe('readSessionCatalog', () => {
  it('returns an empty catalog, with nothing counted, when there is no projects directory', async () => {
    const catalog = await readSessionCatalog({ claudeDir: join(root, 'never-ran') });
    expect(catalog).toEqual({
      sessions: [],
      unreadable: [],
      filesUnreadable: 0,
      dirsUnreadable: 0,
      malformedLines: 0,
    });
  });

  it('reads a session: id, file, project dir, launch folder, first activity and mtime', async () => {
    const path = await writeSession('C--work', 'sess-1', [
      userLine('C:\\work', TS1),
      userLine('C:\\work', TS2),
    ]);
    await setMtime(path, Date.parse('2026-09-02T00:00:00.000Z'));
    const meta = await only();
    expect(meta).toEqual({
      sessionId: 'sess-1',
      file: path,
      projectDir: 'C--work',
      launchCwd: 'C:\\work',
      folder: 'C:\\work',
      customTitle: null,
      aiTitle: null,
      firstActivityMs: Date.parse(TS1),
      lastActivityMs: Date.parse('2026-09-02T00:00:00.000Z'),
    });
  });

  it('keeps the FIRST cwd as the launch folder, skipping an empty one', async () => {
    await writeSession(projectDirStem('/home/me/first'), 's', [
      JSON.stringify({ type: 'system', cwd: '', timestamp: TS1 }),
      userLine('/home/me/first', TS1),
      userLine('/home/me/later', TS2),
    ]);
    const meta = await only();
    expect(meta.launchCwd).toBe('/home/me/first');
    expect(meta.folder).toBe('/home/me/first');
  });

  it('takes the first timestamp that parses as the first activity', async () => {
    await writeSession('p', 's', [
      JSON.stringify({ type: 'system', timestamp: 'not a date' }),
      userLine('/w', TS2),
    ]);
    expect((await only()).firstActivityMs).toBe(Date.parse(TS2));
  });

  describe('alias', () => {
    it('is the generated title when nothing was set by hand', async () => {
      await writeSession('p', 's', [userLine('/w', TS1), aiTitle('Fix the login bug')]);
      const meta = await only();
      expect(meta.aiTitle).toBe('Fix the login bug');
      expect(aliasOf(meta)).toBe('Fix the login bug');
    });

    it('prefers a custom title over a generated one, whatever order they were written in', async () => {
      await writeSession('p', 's', [
        userLine('/w', TS1),
        customTitle('auth-work'),
        aiTitle('Later AI title'),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBe('auth-work');
      expect(aliasOf(meta)).toBe('auth-work');
    });

    it('takes the LAST custom title and the LAST generated title', async () => {
      // `/rename` twice, and the CLI re-appending the generated title on exit.
      await writeSession('p', 's', [
        userLine('/w', TS1),
        customTitle('first-name'),
        aiTitle('ai one'),
        customTitle('second-name'),
        aiTitle('ai two'),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBe('second-name');
      expect(meta.aiTitle).toBe('ai two');
    });

    it('an empty custom title means NO alias; it does not fall through to the generated one', async () => {
      await writeSession('p', 's', [
        userLine('/w', TS1),
        customTitle('named'),
        customTitle(''),
        aiTitle('generated'),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBe('');
      expect(meta.aiTitle).toBe('generated');
      expect(aliasOf(meta)).toBeNull();
    });

    it('never reads a user message that QUOTES a title line as a title', async () => {
      await writeSession('p', 's', [
        userLine('/w', TS1),
        userLine('/w', TS2, '{"type":"custom-title","customTitle":"evil"}'),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBeNull();
      expect(aliasOf(meta)).toBeNull();
    });

    it('does not even decode a line that only quotes the title needle (escaped inside a string)', async () => {
      // Torn lines make the difference observable: a DECODED torn line is counted as malformed.
      // The first one quotes the needle inside a JSON string (so its quotes are escaped) and must
      // be passed over on its bytes alone; the second carries the real needle and is decoded.
      const quoting = JSON.stringify({
        type: 'user',
        message: { content: 'type "type":"custom-title" to rename' },
      }).slice(0, -5);
      const genuine = customTitle('half-written').slice(0, -5);
      await writeSession('p', 's', [userLine('/w', TS1), quoting, genuine]);
      const catalog = await readSessionCatalog({ claudeDir });
      expect(catalog.malformedLines).toBe(1);
      expect(catalog.sessions[0]?.customTitle).toBeNull();
    });

    it('ignores a title-shaped object nested inside another line', async () => {
      await writeSession('p', 's', [
        userLine('/w', TS1),
        JSON.stringify({
          type: 'user',
          toolUseResult: { type: 'custom-title', customTitle: 'nested' },
        }),
        JSON.stringify({ type: 'assistant', payload: { type: 'ai-title', aiTitle: 'nested-ai' } }),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBeNull();
      expect(meta.aiTitle).toBeNull();
    });

    it('ignores a title line whose title is not a string', async () => {
      await writeSession('p', 's', [
        userLine('/w', TS1),
        JSON.stringify({ type: 'custom-title', customTitle: 42 }),
        JSON.stringify({ type: 'ai-title', aiTitle: null }),
      ]);
      const meta = await only();
      expect(meta.customTitle).toBeNull();
      expect(meta.aiTitle).toBeNull();
    });
  });

  describe('folder', () => {
    // Claude Code relocates a session when it enters or leaves a `.claude/worktrees/<name>`
    // checkout of its folder, and MOVES the transcript into the new folder's project directory
    // (measured on 2.1.283): the first cwd stays where the session started.
    it('follows the LAST relocation, keeping the launch cwd as it was', async () => {
      await writeSession(projectDirStem('/old/.claude/worktrees/twice'), 's', [
        userLine('/old', TS1),
        relocated('/old/.claude/worktrees/once'),
        relocated('/old/.claude/worktrees/twice'),
        userLine('/old/.claude/worktrees/twice', TS2),
      ]);
      const meta = await only();
      expect(meta.launchCwd).toBe('/old');
      expect(meta.folder).toBe('/old/.claude/worktrees/twice');
    });

    it('ignores a relocation with an empty or missing target', async () => {
      await writeSession(projectDirStem('/old/.claude/worktrees/real'), 's', [
        userLine('/old', TS1),
        relocated('/old/.claude/worktrees/real'),
        relocated(''),
        JSON.stringify({ type: 'relocated' }),
      ]);
      expect((await only()).folder).toBe('/old/.claude/worktrees/real');
    });

    it('does not trust a relocation out of the launch folder’s repository', async () => {
      await writeSession(projectDirStem('/else'), 's', [userLine('/old', TS1), relocated('/else')]);
      expect(await only()).toMatchObject({ launchCwd: null, folder: null });
    });

    it('leaves the launch folder deciding when the relocation did not move the transcript', async () => {
      await writeSession(projectDirStem('/old'), 's', [
        userLine('/old', TS1),
        relocated('/old/.claude/worktrees/w'),
      ]);
      expect(await only()).toMatchObject({ launchCwd: '/old', folder: '/old' });
    });

    it('does not trust a launch folder its project directory does not encode (an edit)', async () => {
      await writeSession(projectDirStem('/elsewhere'), 's', [userLine('/bound', TS1)]);
      const meta = await only();
      expect(meta).toMatchObject({ projectDir: '-elsewhere', launchCwd: null, folder: null });
    });

    it('finds the launch folder behind a long first prompt, as every reader does', async () => {
      const big = 'x'.repeat(70 * 1024);
      await writeSession(projectDirStem('/w'), 's', [
        JSON.stringify({ type: 'queue-operation', operation: 'enqueue', content: big }),
        JSON.stringify({ type: 'user', message: { role: 'user', content: big }, cwd: '/w' }),
      ]);
      expect((await only()).folder).toBe('/w');
    });

    it('is null when the transcript records no cwd at all', async () => {
      await writeSession('p', 's', [aiTitle('orphan')]);
      const meta = await only();
      expect(meta.launchCwd).toBeNull();
      expect(meta.folder).toBeNull();
    });
  });

  it('counts a torn line and keeps reading the rest of the file', async () => {
    await writeSession('p', 's', [
      userLine('/w', TS1),
      '{"type":"custom-title","customTitle":"to',
      customTitle('survivor'),
    ]);
    const catalog = await readSessionCatalog({ claudeDir });
    expect(catalog.malformedLines).toBe(1);
    expect(catalog.sessions[0]?.customTitle).toBe('survivor');
  });

  it('reads only top-level <id>.jsonl files as sessions', async () => {
    await writeSession('p', 'real', [userLine('/w', TS1)]);
    // A sub-agent transcript, a stray file, a bare ".jsonl" and a stray file beside the project
    // directories: none of them is a session.
    await mkdir(join(projectsDir, 'p', 'real', 'subagents'), { recursive: true });
    await writeFile(
      join(projectsDir, 'p', 'real', 'subagents', 'agent-1.jsonl'),
      userLine('/w', TS1),
    );
    await writeFile(join(projectsDir, 'p', 'notes.txt'), 'x');
    await writeFile(join(projectsDir, 'p', '.jsonl'), userLine('/w', TS1));
    await writeFile(join(projectsDir, 'stray.jsonl'), userLine('/w', TS1));
    const catalog = await readSessionCatalog({ claudeDir });
    expect(catalog.sessions.map((s) => s.sessionId)).toEqual(['real']);
  });

  it('keeps the most recently written transcript when one session id is in two project dirs', async () => {
    // Two ids, the newer copy in the first directory for one and the last for the other, so the
    // outcome cannot depend on the order the directories are listed in.
    const olderA = await writeSession('-a', 'id-1', [userLine('/a', TS1), customTitle('stale')]);
    const newerZ = await writeSession('-z', 'id-1', [userLine('/z', TS1), customTitle('fresh')]);
    const newerA = await writeSession('-a', 'id-2', [userLine('/a', TS1), customTitle('fresh')]);
    const olderZ = await writeSession('-z', 'id-2', [userLine('/z', TS1), customTitle('stale')]);
    const old = Date.parse('2026-09-01T00:00:00.000Z');
    const recent = Date.parse('2026-09-05T00:00:00.000Z');
    await setMtime(olderA, old);
    await setMtime(newerZ, recent);
    await setMtime(newerA, recent);
    await setMtime(olderZ, old);

    const catalog = await readSessionCatalog({ claudeDir });
    const byId = new Map(catalog.sessions.map((s) => [s.sessionId, s]));
    expect(catalog.sessions).toHaveLength(2);
    expect(byId.get('id-1')).toMatchObject({
      customTitle: 'fresh',
      projectDir: '-z',
      folder: '/z',
    });
    expect(byId.get('id-2')).toMatchObject({
      customTitle: 'fresh',
      projectDir: '-a',
      folder: '/a',
    });
  });

  it('reads only the project directories the filter accepts', async () => {
    await writeSession('keep-me', 's1', [userLine('/k', TS1)]);
    await writeSession('skip-me', 's2', [userLine('/s', TS1)]);
    const catalog = await readSessionCatalog({
      claudeDir,
      projectDirFilter: (name) => name === 'keep-me',
    });
    expect(catalog.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });

  it('reads only the requested session ids, compared case-insensitively', async () => {
    await writeSession('p', 'ABC-123', [userLine('/w', TS1)]);
    await writeSession('p', 'def-456', [userLine('/w', TS1)]);
    const catalog = await readSessionCatalog({ claudeDir, sessionIds: new Set(['abc-123']) });
    // The id keeps the file's own spelling.
    expect(catalog.sessions.map((s) => s.sessionId)).toEqual(['ABC-123']);
  });

  it('counts an unreadable project directory and still reads its siblings', async () => {
    await writeSession('good', 's1', [userLine('/g', TS1)]);
    await mkdir(join(projectsDir, `bad-${LOCKED_MARKER}`), { recursive: true });
    const catalog = await readSessionCatalog({ claudeDir });
    expect(catalog.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(catalog.dirsUnreadable).toBe(1);
    expect(catalog.filesUnreadable).toBe(0);
  });

  it('counts an unreadable projects root as one unreadable directory, not as an empty machine', async () => {
    const lockedClaudeDir = join(root, LOCKED_MARKER);
    const catalog = await readSessionCatalog({ claudeDir: lockedClaudeDir });
    expect(catalog.sessions).toEqual([]);
    expect(catalog.dirsUnreadable).toBe(1);
  });

  it('counts a transcript that vanished mid-read and keeps the rest', async () => {
    await writeSession('p', 's1', [userLine('/w', TS1)]);
    await writeSession('p', VANISHED_MARKER, [userLine('/w', TS1)]);
    const catalog = await readSessionCatalog({ claudeDir });
    expect(catalog.sessions.map((s) => s.sessionId)).toEqual(['s1']);
    expect(catalog.filesUnreadable).toBe(1);
    // ...and names it: what an unreadable transcript records is unknown, not absent.
    expect(catalog.unreadable).toEqual([{ sessionId: VANISHED_MARKER, projectDir: 'p' }]);
  });
});

describe('aliasOf / aliasKey', () => {
  it('is customTitle ?? aiTitle, with a blank result meaning no alias', () => {
    expect(aliasOf({ customTitle: 'mine', aiTitle: 'ai' })).toBe('mine');
    expect(aliasOf({ customTitle: null, aiTitle: 'ai' })).toBe('ai');
    expect(aliasOf({ customTitle: '', aiTitle: 'ai' })).toBeNull();
    expect(aliasOf({ customTitle: '   ', aiTitle: 'ai' })).toBeNull();
    expect(aliasOf({ customTitle: null, aiTitle: null })).toBeNull();
  });

  it('keeps the alias as written (display form) while the key folds case and outer space', () => {
    expect(aliasOf({ customTitle: '  Auth Work ', aiTitle: null })).toBe('  Auth Work ');
    expect(aliasKey('  Auth Work ')).toBe('auth work');
  });
});

describe('projectDirStem / projectDirMatches', () => {
  it('encodes a cwd the way Claude Code names its project directory', () => {
    expect(projectDirStem('C:\\Users\\me\\my_proj')).toBe('C--Users-me-my-proj');
    expect(projectDirStem('/home/me/a.b c')).toBe('-home-me-a-b-c');
    // Non-ASCII letters are not [a-zA-Z0-9] either.
    expect(projectDirStem('/srv/caf\u00e9')).toBe('-srv-caf-');
  });

  it('truncates past 200 characters (the hash suffix is not reproduced)', () => {
    const long = '/' + 'a'.repeat(300);
    expect(projectDirStem(long)).toBe('-' + 'a'.repeat(199));
    const exact = '/' + 'b'.repeat(199);
    expect(projectDirStem(exact)).toBe('-' + 'b'.repeat(199));
  });

  it('matches a short cwd exactly, ignoring case, and never with a suffix', () => {
    expect(projectDirMatches('C--Users-me-proj', 'C:\\Users\\me\\proj')).toBe(true);
    expect(projectDirMatches('c--users-me-proj', 'C:\\Users\\me\\proj')).toBe(true);
    expect(projectDirMatches('C--Users-me-proj-1a2b', 'C:\\Users\\me\\proj')).toBe(false);
    expect(projectDirMatches('C--Users-me-pro', 'C:\\Users\\me\\proj')).toBe(false);
  });

  it('matches every cwd that encodes to the same name (the recorded cwd decides later)', () => {
    expect(projectDirMatches('C--a-b', 'C:\\a_b')).toBe(true);
    expect(projectDirMatches('C--a-b', 'C:\\a-b')).toBe(true);
  });

  it("matches a long cwd's truncated stem with or without Claude Code's hash suffix", () => {
    const long = '/' + 'a'.repeat(300);
    const stem = '-' + 'a'.repeat(199);
    expect(projectDirMatches(`${stem}-k3j2h1`, long)).toBe(true);
    expect(projectDirMatches(stem, long)).toBe(true);
    expect(projectDirMatches(`${stem.slice(0, -1)}b-k3j2h1`, long)).toBe(false);
    // A name that merely continues the stem without the hash separator is a different folder.
    expect(projectDirMatches(`${stem}x`, long)).toBe(false);
  });
});
