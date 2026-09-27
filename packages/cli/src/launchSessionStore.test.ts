// The launcher's read of Claude Code's session store. Two things are pinned here: that a transcript
// is read the way Claude Code's own session listing reads it (its 64 KiB head and tail windows, and
// its field rules), and that each lookup searches where Claude Code searches and reads no more than
// its answer needs — the launcher runs before every `cctl claude`, so an unbounded read is a slow
// launch.

import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { projectDirStem } from '@claude-control/switch-engine';
import type { LaunchSessionFacts } from './launcher.js';
import {
  TRANSCRIPT_WINDOW_BYTES,
  claudeCodeCwd,
  firstLineValue,
  gitWorktreeList,
  hasLossyProjectName,
  lastStringValue,
  lastTypedLineValue,
  launchSessionStore,
  parseWorktreeList,
  readTranscriptFacts,
  resumeSearchPlan,
  transcriptFacts,
  type LaunchSessionStoreOptions,
} from './launchSessionStore.js';

const line = (record: object): string => JSON.stringify(record);
const user = (cwd: string): string =>
  line({ type: 'user', cwd, message: { role: 'user', content: 'hi' } });

describe('transcriptFacts (Claude Code’s quick read)', () => {
  it('takes the first recorded cwd, and the last title of each kind', () => {
    const text = [
      user('C:\\first'),
      user('C:\\second'),
      line({ type: 'custom-title', customTitle: 'Old' }),
      line({ type: 'ai-title', aiTitle: 'Generated' }),
      line({ type: 'custom-title', customTitle: 'New' }),
    ].join('\n');
    expect(transcriptFacts(text, text)).toEqual({
      customTitle: 'New',
      aiTitle: 'Generated',
      folder: 'C:\\first',
    });
  });

  it('a title in the tail wins; the head is the fallback', () => {
    const head = line({ type: 'custom-title', customTitle: 'Head' }) + '\n' + user('C:\\w');
    expect(
      transcriptFacts(head, line({ type: 'custom-title', customTitle: 'Tail' })).customTitle,
    ).toBe('Tail');
    expect(transcriptFacts(head, user('C:\\w')).customTitle).toBe('Head');
  });

  it('a relocation counts only from the tail, and outranks the recorded cwd', () => {
    const relocated = line({ type: 'relocated', relocatedCwd: 'D:\\moved' });
    expect(transcriptFacts(user('C:\\w'), relocated).folder).toBe('D:\\moved');
    // Claude Code reads relocations from the tail window only.
    expect(transcriptFacts(`${user('C:\\w')}\n${relocated}`, user('C:\\w')).folder).toBe('C:\\w');
  });

  it('a needle quoted inside a message string is never a title', () => {
    const quoted = line({
      type: 'user',
      cwd: 'C:\\w',
      message: { role: 'user', content: '{"type":"custom-title","customTitle":"Fake"}' },
    });
    expect(transcriptFacts(quoted, quoted).customTitle).toBeNull();
  });

  it('reads the spaced "field": "value" form and decodes escapes', () => {
    const text = `{"type":"custom-title", "customTitle": "A \\"quoted\\" \\u00e9 title"}\n${user('C:\\w')}`;
    expect(transcriptFacts(text, text).customTitle).toBe('A "quoted" é title');
  });

  it('an empty transcript, or a blank recorded cwd, records nothing', () => {
    expect(transcriptFacts('', '')).toEqual({ customTitle: null, aiTitle: null, folder: null });
    expect(transcriptFacts(line({ type: 'user', cwd: '' }), '').folder).toBeNull();
  });

  it('reads how the session was started from the first head line recording it', () => {
    const head = [
      line({ type: 'custom-title', customTitle: 'T' }),
      line({ type: 'user', entrypoint: 'sdk-cli', cwd: 'C:\\w' }),
      line({ type: 'user', entrypoint: 'cli', cwd: 'C:\\w' }),
    ].join('\n');
    expect(transcriptFacts(head, head).entrypoint).toBe('sdk-cli');
    expect(transcriptFacts(user('C:\\w'), '')).not.toHaveProperty('entrypoint');
  });
});

describe('the field readers', () => {
  it('lastStringValue ignores a value whose closing quote is outside the window', () => {
    expect(lastStringValue('{"customTitle":"cut off', 'customTitle')).toBeUndefined();
    expect(lastStringValue('{"customTitle":"a"} {"customTitle":"b', 'customTitle')).toBe('a');
  });

  it('lastTypedLineValue needs the type AND a parseable line', () => {
    const text = [
      line({ type: 'relocated', relocatedCwd: 'A' }),
      line({ type: 'other', relocatedCwd: 'B' }),
      '{"type":"relocated","relocatedCwd":"C"', // cut by the window edge
    ].join('\n');
    expect(lastTypedLineValue(text, 'relocatedCwd', 'relocated')).toBe('A');
  });

  it('firstLineValue reads top-level fields only', () => {
    const text = [line({ message: { cwd: 'nested' } }), line({ cwd: 'top' })].join('\r\n');
    expect(firstLineValue(text, 'cwd')).toBe('top');
  });
});

describe('readTranscriptFacts', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cctl-lss-read-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads a small transcript whole', async () => {
    const file = join(dir, 'a.jsonl');
    writeFileSync(
      file,
      [user('C:\\w'), line({ type: 'custom-title', customTitle: 'T' })].join('\n'),
    );
    expect(await readTranscriptFacts(file)).toEqual({
      customTitle: 'T',
      aiTitle: null,
      folder: 'C:\\w',
    });
  });

  // Claude Code's own listing shares this blind spot; titles are re-appended at exit, which puts
  // them back in the tail.
  it('sees only the head and tail windows of a long transcript', async () => {
    const filler = line({ type: 'assistant', text: 'x'.repeat(1000) });
    const fill = Array.from(
      { length: Math.ceil((TRANSCRIPT_WINDOW_BYTES * 1.5) / filler.length) },
      () => filler,
    );
    const middleOnly = join(dir, 'middle.jsonl');
    writeFileSync(
      middleOnly,
      [user('C:\\w'), ...fill, line({ type: 'custom-title', customTitle: 'Mid' }), ...fill].join(
        '\n',
      ),
    );
    expect(await readTranscriptFacts(middleOnly)).toEqual({
      customTitle: null,
      aiTitle: null,
      folder: 'C:\\w',
    });
    const atEnd = join(dir, 'end.jsonl');
    writeFileSync(
      atEnd,
      [user('C:\\w'), ...fill, ...fill, line({ type: 'custom-title', customTitle: 'End' })].join(
        '\n',
      ),
    );
    expect((await readTranscriptFacts(atEnd))?.customTitle).toBe('End');
  });

  it('is null for a missing file or a directory, never a throw', async () => {
    expect(await readTranscriptFacts(join(dir, 'missing.jsonl'))).toBeNull();
    expect(await readTranscriptFacts(dir)).toBeNull();
  });
});

describe('resumeSearchPlan (where Claude Code’s --resume <text> looks)', () => {
  const S = (p: string) => projectDirStem(p);

  it('with at most one worktree: the folder’s own directory and its --claude-worktrees- ones', () => {
    const names = [
      S('C:\\repo'),
      `${S('C:\\repo')}--claude-worktrees-feature`,
      S('C:\\repo\\sub'),
      S('C:\\repo-other'),
    ];
    const plan = resumeSearchPlan(names, 'C:\\repo', ['C:/repo']);
    expect(plan.dirs).toEqual([
      { name: S('C:\\repo'), owner: 'C:\\repo' },
      { name: `${S('C:\\repo')}--claude-worktrees-feature`, owner: null },
    ]);
    expect(plan.owners).toEqual(['C:\\repo']);
    expect(plan.widenToSubfolders).toBe(false);
  });

  it('from a subfolder, the worktree prefix is the containing worktree’s', () => {
    const names = [S('C:\\repo\\sub'), `${S('C:\\repo')}--claude-worktrees-x`];
    const plan = resumeSearchPlan(names, 'C:\\repo\\sub', ['C:/repo']);
    expect(plan.dirs.map((d) => d.name)).toEqual(names);
  });

  it('with two or more worktrees: every directory named after a worktree or prefixed by it', () => {
    const names = [
      S('C:\\repo'),
      S('C:\\repo\\sub'),
      S('C:\\repo-other'),
      S('C:\\repo-wt'),
      S('C:\\repo-wt\\deep'),
      S('C:\\unrelated'),
    ];
    const plan = resumeSearchPlan(names, 'C:\\repo', ['C:/repo', 'C:/repo-wt']);
    expect(plan.dirs).toEqual([
      { name: S('C:\\repo'), owner: 'C:/repo' },
      { name: S('C:\\repo\\sub'), owner: 'C:/repo' },
      { name: S('C:\\repo-other'), owner: 'C:/repo' },
      { name: S('C:\\repo-wt'), owner: 'C:/repo-wt' },
      { name: S('C:\\repo-wt\\deep'), owner: 'C:/repo-wt' },
    ]);
    expect(plan.owners).toEqual(['C:/repo', 'C:/repo-wt']);
    expect(plan.widenToSubfolders).toBe(true);
  });

  it('a folder inside no worktree adds its own directory', () => {
    const names = [S('C:\\elsewhere'), S('C:\\repo')];
    const plan = resumeSearchPlan(names, 'C:\\elsewhere', ['C:/repo', 'C:/repo-wt']);
    expect(plan.dirs).toEqual([
      { name: S('C:\\elsewhere'), owner: 'C:\\elsewhere' },
      { name: S('C:\\repo'), owner: 'C:/repo' },
    ]);
    expect(plan.owners).toEqual(['C:\\elsewhere', 'C:/repo', 'C:/repo-wt']);
  });

  it('compares directory names case-insensitively', () => {
    const plan = resumeSearchPlan([S('c:\\REPO').toUpperCase()], 'C:\\repo', []);
    expect(plan.dirs).toHaveLength(1);
  });

  it('a name truncated past 200 characters matches any hash suffix', () => {
    const long = `C:\\${'a'.repeat(250)}`;
    const stem = S(long);
    const plan = resumeSearchPlan(
      [`${stem}-abc123`, `${stem}-abc123--claude-worktrees-x`],
      long,
      [],
    );
    expect(plan.dirs.map((d) => d.name)).toEqual([
      `${stem}-abc123`,
      `${stem}-abc123--claude-worktrees-x`,
    ]);
  });
});

describe('worktree listing', () => {
  it('parses git’s porcelain output', () => {
    const out =
      'worktree C:/repo\nHEAD abc\nbranch refs/heads/main\n\nworktree C:/repo-wt\r\nHEAD def\ndetached\n';
    expect(parseWorktreeList(out)).toEqual(['C:/repo', 'C:/repo-wt']);
  });

  it('is empty outside a repository or for a missing folder, never a throw', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cctl-lss-nogit-'));
    try {
      expect(await gitWorktreeList(dir)).toEqual([]);
      expect(await gitWorktreeList(join(dir, 'missing'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists a real repository’s worktrees', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cctl-lss-git-'));
    try {
      const repo = join(dir, 'repo');
      mkdirSync(repo);
      // A hermetic git: no system or user configuration (hooks, templates, signing) reaches this
      // throwaway fixture repository.
      const emptyConfig = join(dir, 'gitconfig');
      writeFileSync(emptyConfig, '');
      const git = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
          cwd: repo,
          stdio: 'ignore',
          env: { ...process.env, GIT_CONFIG_GLOBAL: emptyConfig, GIT_CONFIG_NOSYSTEM: '1' },
        });
      git('init', '-q');
      git('commit', '-q', '--allow-empty', '-m', 'init');
      git('worktree', 'add', '-q', join(dir, 'wt'));
      const listed = await gitWorktreeList(repo);
      expect(listed).toHaveLength(2);
      expect(listed.map((p) => p.replace(/\\/g, '/').toLowerCase())).toContain(
        join(dir, 'wt').replace(/\\/g, '/').toLowerCase(),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('hasLossyProjectName', () => {
  it('flags any character the project-directory name flattens', () => {
    expect(hasLossyProjectName('C:\\plain\\path-1')).toBe(false);
    expect(hasLossyProjectName('/home/a/b')).toBe(false);
    for (const p of ['C:\\a_b', 'C:\\a b', 'C:\\a.b', 'C:\\ünï'])
      expect(hasLossyProjectName(p)).toBe(true);
  });
});

describe('launchSessionStore', () => {
  let claudeDir: string;
  let base: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'cctl-lss-claude-'));
    base = mkdtempSync(join(tmpdir(), 'cctl-lss-work-'));
  });
  afterEach(() => {
    rmSync(claudeDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  let clock = 1_700_000_000;
  /** Write a transcript into `dirOf`'s project directory, recorded in `cwd`, with a distinct mtime
   *  (later calls are newer). Returns its path. */
  function session(
    dirOf: string,
    id: string,
    opts: {
      cwd?: string | null;
      title?: string;
      ai?: string;
      relocated?: string;
      prompt?: string;
    } = {},
  ): string {
    const dir = join(claudeDir, 'projects', projectDirStem(dirOf));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    const lines: string[] = [];
    const cwd = opts.cwd === undefined ? dirOf : opts.cwd;
    if (opts.prompt !== undefined) {
      // Claude Code writes a first prompt twice before the first cwd: a queue-operation line, then
      // the user line, whose cwd FOLLOWS the message.
      lines.push(line({ type: 'queue-operation', operation: 'enqueue', content: opts.prompt }));
      lines.push(line({ type: 'user', message: { role: 'user', content: opts.prompt }, cwd }));
    }
    lines.push(cwd === null ? line({ type: 'summary', summary: 's' }) : user(cwd));
    if (opts.ai !== undefined) lines.push(line({ type: 'ai-title', aiTitle: opts.ai }));
    if (opts.title !== undefined)
      lines.push(line({ type: 'custom-title', customTitle: opts.title }));
    if (opts.relocated !== undefined)
      lines.push(line({ type: 'relocated', relocatedCwd: opts.relocated }));
    writeFileSync(file, lines.join('\n') + '\n');
    clock += 10;
    utimesSync(file, clock, clock);
    return file;
  }

  /** A store for `cwd` that counts transcript reads. */
  function counted(cwd: string, over: Partial<LaunchSessionStoreOptions> = {}) {
    const reads: string[] = [];
    const s = launchSessionStore({
      claudeDir,
      cwd,
      platform: process.platform,
      gitWorktrees: () => Promise.resolve([]),
      readTranscript: async (file) => {
        reads.push(file);
        return readTranscriptFacts(file);
      },
      ...over,
    });
    return { s, reads };
  }
  const titles = (list: LaunchSessionFacts[]) =>
    list.map((f) => f.customTitle ?? `ai:${f.aiTitle}`).sort();

  describe('sessionsTitled', () => {
    it('matches by (custom ?? generated) title, compared the way claude --resume compares', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Auth Work' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000002', { ai: ' auth work ' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000003', { title: 'Other' });
      // A blank custom title does not fall through to the generated one.
      session(w, 'aaaaaaaa-0000-4000-8000-000000000004', { title: '  ', ai: 'Auth Work' });
      const { s } = counted(w);
      expect(titles(await s.sessionsTitled('AUTH WORK'))).toEqual(['Auth Work', 'ai: auth work ']);
      // And a blank title is never a match, even for blank search text.
      expect(await s.sessionsTitled('  ')).toEqual([]);
    });

    it('searches as for one worktree when the worktree lookup fails', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'X' });
      session(join(base, 'w-sibling'), 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'X' });
      const { s } = counted(w, { gitWorktrees: () => Promise.reject(new Error('git exploded')) });
      // The default lookup never rejects; a rejecting one must not fail the launch either.
      expect(titles(await s.sessionsTitled('X'))).toEqual(['X']);
    });

    it('with two or more worktrees reaches subfolder and prefix-sibling sessions, each with its folder', async () => {
      const repo = join(base, 'repo');
      session(repo, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'X' });
      session(join(repo, 'sub'), 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'X' });
      session(join(base, 'repo-other'), 'aaaaaaaa-0000-4000-8000-000000000003', { title: 'x' });
      session(join(base, 'unrelated'), 'aaaaaaaa-0000-4000-8000-000000000004', { title: 'X' });
      const { s } = counted(repo, {
        gitWorktrees: () => Promise.resolve([repo, join(base, 'repo-wt')]),
      });
      const found = await s.sessionsTitled('X');
      expect(found.map((f) => f.folder).sort()).toEqual(
        [repo, join(repo, 'sub'), join(base, 'repo-other')].sort(),
      );
    });

    it('a project directory two folders share yields both folders’ sessions', async () => {
      // C:\a_b and C:\a-b (and /x/a_b, /x/a-b) flatten to one project-directory name.
      const underscore = join(base, 'a_b');
      const dash = join(base, 'a-b');
      expect(projectDirStem(underscore)).toBe(projectDirStem(dash));
      session(underscore, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'T' });
      session(dash, 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'T' });
      const { s } = counted(underscore);
      expect((await s.sessionsTitled('T')).map((f) => f.folder).sort()).toEqual(
        [dash, underscore].sort(),
      );
    });

    it('widens to directories whose newest session is recorded in a lossy folder with none of its own', async () => {
      // `a_b` has a lossy name and no session of its own; a session relocated into it lives in
      // another project directory, which Claude Code's widened search reaches.
      const lossy = join(base, 'a_b');
      session(join(base, 'origin'), 'aaaaaaaa-0000-4000-8000-000000000001', {
        title: 'Moved',
        relocated: lossy,
      });
      session(join(base, 'unrelated'), 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'Moved' });
      const { s } = counted(lossy);
      const found = await s.sessionsTitled('Moved');
      expect(titles(found)).toEqual(['Moved']);
      // Found by Claude Code's own search; its conversation still belongs to the folder it was
      // launched in: the relocation did not move its transcript (the directory is still named after
      // that folder), so it is not where the conversation lives.
      expect(found.map((f) => f.folder)).toEqual([join(base, 'origin')]);
    });

    it('does not widen when the folder has a session of its own', async () => {
      const lossy = join(base, 'a_b');
      session(lossy, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Here' });
      session(join(base, 'origin'), 'aaaaaaaa-0000-4000-8000-000000000002', {
        title: 'Moved',
        relocated: lossy,
      });
      const { s, reads } = counted(lossy);
      expect(await s.sessionsTitled('Moved')).toEqual([]);
      expect(reads).toHaveLength(1); // only the folder's own transcript
    });

    it('reads the recorded folder behind a long first prompt, past Claude Code’s quick-read window', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', {
        title: 'Big',
        prompt: 'x'.repeat(70 * 1024),
      });
      const { s } = counted(w);
      expect((await s.sessionsTitled('Big')).map((f) => f.folder)).toEqual([w]);
    });

    it('keeps one entry per session id, the newest copy winning', async () => {
      const w = join(base, 'w');
      const id = 'aaaaaaaa-0000-4000-8000-000000000001';
      const worktree = join(w, '.claude', 'worktrees', 'x');
      session(w, id, { title: 'Dup', cwd: w });
      session(worktree, id, { title: 'Dup' });
      const { s } = counted(w);
      expect((await s.sessionsTitled('Dup')).map((f) => f.folder)).toEqual([worktree]);
    });
  });

  describe('continueSessions', () => {
    it('reads the newest transcript only when it is recorded here', async () => {
      const w = join(base, 'w');
      for (let i = 1; i <= 5; i++)
        session(w, `aaaaaaaa-0000-4000-8000-00000000000${i}`, { title: `T${i}` });
      const { s, reads } = counted(w);
      expect(titles(await s.continueSessions())).toEqual(['T5']);
      expect(reads).toHaveLength(1);
    });

    it('keeps a newer session recorded in another folder as a second candidate', async () => {
      const here = join(base, 'a_b');
      const sibling = join(base, 'a-b');
      session(here, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Mine' });
      session(sibling, 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'Theirs' });
      const { s, reads } = counted(here);
      expect(titles(await s.continueSessions())).toEqual(['Mine', 'Theirs']);
      expect(reads).toHaveLength(2);
    });

    it('continues a session whose first cwd lies past Claude Code’s quick-read window', async () => {
      // Measured: Claude Code's --continue opened the newest session although its first cwd sat at
      // ~144 KB; routing by the older one would put the session on the wrong account.
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Older' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000002', {
        title: 'Big',
        prompt: 'x'.repeat(70 * 1024),
      });
      const { s } = counted(w);
      const found = await s.continueSessions();
      expect(found.map((f) => [f.customTitle, f.folder])).toEqual([['Big', w]]);
    });

    it('a transcript whose first cwd lies past even the shared window counts for this folder', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Older' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000002', {
        title: 'Huge',
        prompt: 'x'.repeat(1_200_000),
      });
      const { s } = counted(w);
      const found = await s.continueSessions();
      expect(found.map((f) => [f.customTitle, f.folder, f.dirName])).toEqual([
        ['Huge', null, projectDirStem(w)],
      ]);
    });

    it('names nothing when the newest transcript cannot be read', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Older' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000002', { title: 'Locked' });
      const { s } = counted(w, {
        readFolder: (file) => ({
          status: file.endsWith('2.jsonl') ? 'unreadable' : 'read',
          dirName: projectDirStem(w),
          launchFolder: w,
          folder: w,
          sawCwd: true,
          relocatedCwd: null,
        }),
      });
      expect(await s.continueSessions()).toEqual([]);
    });

    it('skips a transcript that records no folder (nothing to continue)', async () => {
      const w = join(base, 'w');
      session(w, 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Real' });
      session(w, 'aaaaaaaa-0000-4000-8000-000000000002', { cwd: null, title: 'Bookkeeping' });
      const { s } = counted(w);
      expect(titles(await s.continueSessions())).toEqual(['Real']);
    });

    it('names nothing when no session is recorded here', async () => {
      const here = join(base, 'a_b');
      session(join(base, 'a-b'), 'aaaaaaaa-0000-4000-8000-000000000001', { title: 'Theirs' });
      const { s } = counted(here);
      expect(await s.continueSessions()).toEqual([]);
      expect(await counted(join(base, 'empty')).s.continueSessions()).toEqual([]);
    });
  });

  describe('sessionById', () => {
    it('finds the id in any project directory and reads only that transcript', async () => {
      const id = 'aaaaaaaa-0000-4000-8000-00000000000a';
      session(join(base, 'x'), 'aaaaaaaa-0000-4000-8000-00000000000b', { title: 'Other' });
      session(join(base, 'y'), id, { title: 'Target' });
      const { s, reads } = counted(join(base, 'somewhere-else'));
      expect((await s.sessionById(id.toUpperCase()))?.customTitle).toBe('Target');
      expect(reads).toHaveLength(1);
    });

    it('prefers the newest copy of an id; a missing id is null', async () => {
      const id = 'aaaaaaaa-0000-4000-8000-00000000000a';
      session(join(base, 'x'), id, { title: 'Older' });
      session(join(base, 'y'), id, { title: 'Newer' });
      const { s } = counted(base);
      expect((await s.sessionById(id))?.customTitle).toBe('Newer');
      expect(await s.sessionById('bbbbbbbb-0000-4000-8000-000000000000')).toBeNull();
    });
  });

  it('sessionAtPath reads that one file', async () => {
    const file = session(join(base, 'x'), 'aaaaaaaa-0000-4000-8000-00000000000c', { title: 'P' });
    const { s, reads } = counted(base);
    expect((await s.sessionAtPath(file))?.customTitle).toBe('P');
    expect(reads).toEqual([file]);
    expect(await s.sessionAtPath(join(base, 'missing.jsonl'))).toBeNull();
  });

  it('sessionById and sessionAtPath carry the recorded folder and the project directory', async () => {
    const w = join(base, 'w');
    const file = session(w, 'aaaaaaaa-0000-4000-8000-00000000000d', { title: 'P' });
    const { s } = counted(base);
    const expected = { customTitle: 'P', aiTitle: null, folder: w, dirName: projectDirStem(w) };
    expect(await s.sessionById('aaaaaaaa-0000-4000-8000-00000000000d')).toEqual(expected);
    expect(await s.sessionAtPath(file)).toEqual(expected);
  });

  it('a missing projects directory is an empty store', async () => {
    const s = launchSessionStore({
      claudeDir: join(base, 'no-such-config'),
      cwd: base,
      platform: process.platform,
      gitWorktrees: () => Promise.resolve([]),
    });
    expect(await s.sessionsTitled('x')).toEqual([]);
    expect(await s.continueSessions()).toEqual([]);
    expect(await s.sessionById('aaaaaaaa-0000-4000-8000-000000000000')).toBeNull();
  });
});

describe('claudeCodeCwd', () => {
  it('resolves a link in the launch folder the way Claude Code does, and keeps an unresolvable one', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'cctl-lss-link-')));
    try {
      const real = join(base, 'real');
      mkdirSync(real);
      const link = join(base, 'link');
      symlinkSync(real, link, process.platform === 'win32' ? 'junction' : 'dir');
      expect(claudeCodeCwd(link)).toBe(real);
      expect(claudeCodeCwd(join(base, 'missing'))).toBe(join(base, 'missing'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
