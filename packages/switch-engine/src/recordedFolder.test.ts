// The one reading of "which folder does this transcript's conversation belong to" (recordedFolder.ts),
// over REAL files shaped the way Claude Code 2.1.283 writes them, and the embedded copy the
// enforcement guard runs, proven to agree with the live functions on every one of those files.

import * as nodeFs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embeddableFolderPathSource } from './folderPath.js';
import {
  RECORDED_FOLDER_HEAD_BYTES,
  RECORDED_FOLDER_TAIL_BYTES,
  embeddableRecordedFolderSource,
  projectDirStem,
  readRecordedFolder,
  recordedFolderFor,
  type RecordedFolderFs,
  type RecordedFolderRead,
} from './recordedFolder.js';

const P = process.platform;
const SEP = P === 'win32' ? '\\' : '/';

let root: string;
let projects: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'cctl-recorded-'));
  projects = join(root, 'projects');
  mkdirSync(projects, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** A folder path under the temp root (it need not exist: nothing here resolves it). */
const folder = (...parts: string[]): string => [root, ...parts].join(SEP);

/** Write a transcript in `dirOf`'s project directory (the name Claude Code gives it). */
function transcript(dirOf: string, lines: readonly (object | string)[], id = 's1'): string {
  const dir = join(projects, projectDirStem(dirOf));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  writeFileSync(file, text + '\n');
  return file;
}

/** The lines Claude Code 2.1.283 writes for a named `-p` session recorded in `cwd` (measured): the
 *  prompt goes out twice before the first line carrying a cwd — in a queue-operation line, then in
 *  the user line, whose cwd key FOLLOWS the message. */
function ccSession(cwd: string, opts: { prompt?: string; title?: string } = {}): object[] {
  const prompt = opts.prompt ?? 'hi';
  const title = opts.title ?? 'T';
  return [
    { type: 'custom-title', customTitle: title, sessionId: 's1' },
    { type: 'agent-name', agentName: title, sessionId: 's1' },
    { type: 'queue-operation', operation: 'enqueue', sessionId: 's1', content: prompt },
    { type: 'queue-operation', operation: 'dequeue', sessionId: 's1' },
    { type: 'user', message: { role: 'user', content: prompt }, cwd, sessionId: 's1' },
    { type: 'assistant', message: { role: 'assistant', content: 'OK' }, cwd, sessionId: 's1' },
    { type: 'custom-title', customTitle: title, sessionId: 's1' },
  ];
}

const relocatedTo = (cwd: string) => ({ type: 'relocated', relocatedCwd: cwd, sessionId: 's1' });

const read = (file: string): RecordedFolderRead => readRecordedFolder(file, nodeFs, P);

describe('readRecordedFolder: the launch folder', () => {
  it('is the first top-level cwd of a Claude Code transcript', () => {
    const repo = folder('repo');
    const file = transcript(repo, ccSession(repo));
    expect(read(file)).toEqual({
      status: 'read',
      dirName: projectDirStem(repo),
      launchFolder: repo,
      folder: repo,
      sawCwd: true,
    });
  });

  it('is found behind a 70 KiB first prompt, written twice before it (measured: cwd at ~144 KB)', () => {
    const repo = folder('repo');
    const file = transcript(repo, ccSession(repo, { prompt: 'x'.repeat(70 * 1024) }));
    expect(nodeFs.statSync(file).size).toBeGreaterThan(140 * 1024);
    expect(read(file).folder).toBe(repo);
  });

  it('counts a line only when it ends inside the 1 MiB window (or the file ends there)', () => {
    const repo = folder('repo');
    const cwdLine = JSON.stringify({ type: 'user', cwd: repo });
    // A padding line sized so the cwd line's newline is the window's LAST byte.
    const pad = (extra: number) => {
      const bare = JSON.stringify({ type: 'queue-operation', content: '' });
      const room = RECORDED_FOLDER_HEAD_BYTES - (cwdLine.length + 1) - 1 - bare.length;
      return JSON.stringify({ type: 'queue-operation', content: 'p'.repeat(room + extra) });
    };
    const after = JSON.stringify({ type: 'assistant' });
    const fits = transcript(repo, [pad(0), cwdLine, after], 'fits');
    const spills = transcript(repo, [pad(1), cwdLine, after], 'spills');
    expect(read(fits).folder).toBe(repo);
    expect(read(spills)).toMatchObject({ status: 'read', folder: null, sawCwd: false });
    // The same spilled line IS whole when the file ends with it (nothing follows it).
    const atEnd = join(projects, projectDirStem(repo), 'end.jsonl');
    writeFileSync(atEnd, `${pad(1)}\n${cwdLine}`);
    expect(nodeFs.statSync(atEnd).size).toBe(RECORDED_FOLDER_HEAD_BYTES);
    expect(read(atEnd).folder).toBe(repo);
  });

  it('is not read past the window: a cwd behind a 1.2 MB prompt leaves only the fallback', () => {
    const repo = folder('repo');
    const file = transcript(repo, ccSession(repo, { prompt: 'z'.repeat(1_200_000) }));
    expect(read(file)).toMatchObject({ status: 'read', launchFolder: null, folder: null });
  });

  it('ignores a nested cwd, a quoted needle and a torn line', () => {
    const repo = folder('repo');
    const elsewhere = folder('elsewhere');
    const file = transcript(repo, [
      { type: 'tool', input: { cwd: elsewhere } },
      { type: 'user', message: { content: `"cwd":${JSON.stringify(elsewhere)}` } },
      `{"type":"user","cwd":${JSON.stringify(elsewhere)}`, // torn: never closed
      { type: 'user', cwd: '' },
      { type: 'user', cwd: repo },
    ]);
    expect(read(file).folder).toBe(repo);
  });

  it('is a transcript that records no conversation: no cwd anywhere', () => {
    const repo = folder('repo');
    const file = transcript(repo, [{ type: 'summary', summary: 's' }]);
    expect(read(file)).toMatchObject({ status: 'read', folder: null, sawCwd: false });
  });
});

describe('readRecordedFolder: consistency with the project directory', () => {
  it('rejects a launch folder that does not encode to the transcript’s own directory (an edit)', () => {
    const bound = folder('bound');
    const elsewhere = folder('elsewhere');
    // The conversation lives in elsewhere's project dir; only its head's cwd claims the bound folder.
    const file = transcript(elsewhere, ccSession(bound));
    expect(read(file)).toMatchObject({
      status: 'read',
      dirName: projectDirStem(elsewhere),
      launchFolder: null,
      folder: null,
      sawCwd: true,
    });
  });

  it('accepts every measured legitimate shape', () => {
    const repo = folder('repo');
    // A fork: a NEW transcript in the launch folder's directory, every cwd rewritten to it.
    expect(read(transcript(repo, ccSession(repo), 'fork')).folder).toBe(repo);
    // A folder Claude Code was started in with another case: the directory keeps that spelling.
    const lower = folder('Long Folder Name').toLowerCase();
    const dir = join(projects, projectDirStem(lower));
    mkdirSync(dir, { recursive: true });
    const lowerFile = join(dir, 'lower.jsonl');
    writeFileSync(
      lowerFile,
      ccSession(lower)
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    expect(read(lowerFile).folder).toBe(lower);
    // A path past 200 characters: Claude Code truncates the name and appends a hash.
    const long = folder('deep'.repeat(60));
    const longDir = join(projects, `${projectDirStem(long)}-1a2b3c`);
    mkdirSync(longDir, { recursive: true });
    const longFile = join(longDir, 'long.jsonl');
    writeFileSync(
      longFile,
      ccSession(long)
        .map((l) => JSON.stringify(l))
        .join('\n') + '\n',
    );
    expect(read(longFile).folder).toBe(long);
  });
});

describe('readRecordedFolder: relocations', () => {
  const repo = () => folder('repo');
  const worktree = (name: string) => [repo(), '.claude', 'worktrees', name].join(SEP);

  it('a session that entered a .claude worktree belongs there', () => {
    const file = transcript(repo(), [...ccSession(repo()), relocatedTo(worktree('feature'))]);
    expect(read(file)).toMatchObject({ launchFolder: repo(), folder: worktree('feature') });
  });

  it('the LAST relocation wins: a round trip ends back in the launch folder', () => {
    const file = transcript(repo(), [
      ...ccSession(repo()),
      relocatedTo(worktree('feature')),
      relocatedTo(repo()),
    ]);
    expect(read(file).folder).toBe(repo());
  });

  it('a session launched in a worktree may move to its repository or a sibling worktree', () => {
    const toRoot = transcript(worktree('a'), [...ccSession(worktree('a')), relocatedTo(repo())]);
    expect(read(toRoot).folder).toBe(repo());
    const toSibling = transcript(
      worktree('a'),
      [...ccSession(worktree('a')), relocatedTo(worktree('b'))],
      's2',
    );
    expect(read(toSibling).folder).toBe(worktree('b'));
  });

  it('a relocation outside the launch folder’s worktree root is not trusted', () => {
    for (const target of [folder('elsewhere'), [repo(), 'sub'].join(SEP), folder('repo-other')]) {
      const file = transcript(repo(), [...ccSession(repo()), relocatedTo(target)]);
      expect({ target, folder: read(file).folder }).toEqual({ target, folder: repo() });
    }
  });

  it('only the tail window is searched, and only whole lines of it', () => {
    const tailPad = {
      type: 'assistant',
      message: { content: 'q'.repeat(RECORDED_FOLDER_TAIL_BYTES) },
    };
    const early = transcript(repo(), [...ccSession(repo()), relocatedTo(worktree('f')), tailPad]);
    expect(read(early).folder).toBe(repo());
    // Inside the window it counts — and a relocation that is not a `relocated` record never does.
    const late = transcript(
      repo(),
      [
        ...ccSession(repo()),
        tailPad,
        relocatedTo(worktree('f')),
        { type: 'x', relocatedCwd: repo() },
      ],
      's2',
    );
    expect(read(late).folder).toBe(worktree('f'));
  });

  it('no relocation is read when the launch folder is not accepted', () => {
    const file = transcript(folder('elsewhere'), [
      ...ccSession(repo()),
      relocatedTo(worktree('f')),
    ]);
    expect(read(file).folder).toBeNull();
  });
});

describe('readRecordedFolder: files that cannot be read', () => {
  it('a missing file is missing; a directory or a device path is unreadable, never opened', () => {
    const repo = folder('repo');
    const missing = join(projects, projectDirStem(repo), 'nope.jsonl');
    expect(read(missing)).toEqual({
      status: 'missing',
      dirName: projectDirStem(repo),
      launchFolder: null,
      folder: null,
      sawCwd: false,
    });
    const asDir = join(projects, projectDirStem(repo), 'dir.jsonl');
    mkdirSync(asDir, { recursive: true });
    expect(read(asDir).status).toBe('unreadable');
    expect(read(join(projects, 'no-dir', 'x.jsonl')).status).toBe('missing');
  });

  it('a read that fails after the file opened (a byte-range lock) is unreadable, never a throw', () => {
    const repo = folder('repo');
    const file = transcript(repo, ccSession(repo));
    let closed = 0;
    const busy: RecordedFolderFs = {
      statSync: (p) => nodeFs.statSync(p),
      openSync: (p, f) => nodeFs.openSync(p, f),
      readSync: () => {
        throw Object.assign(new Error('locked'), { code: 'EBUSY' });
      },
      closeSync: (fd) => {
        closed++;
        nodeFs.closeSync(fd);
      },
    };
    expect(readRecordedFolder(file, busy, P)).toMatchObject({ status: 'unreadable', folder: null });
    expect(closed).toBe(1);
  });
});

describe('recordedFolderFor', () => {
  const canon = (f: string) => `canon:${f}`;

  it('an accepted recorded folder, canonicalized by the caller’s rule', () => {
    expect(
      recordedFolderFor(
        { folder: 'C:\\repo\\sub', dirName: 'C--repo-sub' },
        {
          spelled: 'C:\\repo',
          canonical: 'C:\\repo',
        },
        canon,
      ),
    ).toBe('canon:C:\\repo\\sub');
  });

  it('else the folder the session runs in, when the directory name can stand for it', () => {
    const running = { spelled: 'C:\\a-b', canonical: 'C:\\A-B' };
    // The lossy twin: C:\a_b's directory name is also C:\a-b's; the session runs in a-b.
    expect(recordedFolderFor({ folder: null, dirName: 'C--a-b' }, running, canon)).toBe('C:\\A-B');
    // Reached through a link: the spelled folder names the directory, the canonical one is returned.
    expect(
      recordedFolderFor(
        { folder: null, dirName: 'C--link' },
        { spelled: 'C:\\link', canonical: 'C:\\target' },
        canon,
      ),
    ).toBe('C:\\target');
  });

  it('else no folder: a lossy name never picks a folder the session does not run in', () => {
    expect(
      recordedFolderFor(
        { folder: null, dirName: 'C--a-b' },
        {
          spelled: 'C:\\repo',
          canonical: 'C:\\repo',
        },
        canon,
      ),
    ).toBeNull();
  });
});

describe('embeddableRecordedFolderSource', () => {
  /** The embedded pair, reconstituted exactly as the guard does (after the folderPath source). */
  function loadEmbedded(): {
    readRecordedFolder: typeof readRecordedFolder;
    recordedFolderFor: typeof recordedFolderFor;
  } {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      `${embeddableFolderPathSource()}\n${embeddableRecordedFolderSource()}\n` +
        'return { readRecordedFolder, recordedFolderFor };',
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return factory() as ReturnType<typeof loadEmbedded>;
  }

  it('agrees with the live reader on every shape above, and the live resolver on its table', () => {
    const embedded = loadEmbedded();
    const repo = folder('repo');
    const wt = [repo, '.claude', 'worktrees', 'w'].join(SEP);
    const dirPath = join(projects, projectDirStem(repo), 'dir.jsonl');
    mkdirSync(dirPath, { recursive: true });
    const files = [
      transcript(repo, ccSession(repo), 'a'),
      transcript(repo, ccSession(repo, { prompt: 'x'.repeat(70 * 1024) }), 'b'),
      transcript(repo, ccSession(repo, { prompt: 'z'.repeat(1_200_000) }), 'c'),
      transcript(folder('elsewhere'), ccSession(repo), 'd'),
      transcript(repo, [...ccSession(repo), relocatedTo(wt)], 'e'),
      transcript(repo, [...ccSession(repo), relocatedTo(folder('x'))], 'f'),
      transcript(repo, [{ type: 'summary' }], 'g'),
      join(projects, 'nope', 'missing.jsonl'),
      dirPath,
    ];
    for (const file of files) {
      expect({ file, got: embedded.readRecordedFolder(file, nodeFs, P) }).toEqual({
        file,
        got: readRecordedFolder(file, nodeFs, P),
      });
    }
    const running = { spelled: repo, canonical: repo };
    for (const r of files.map((f) => readRecordedFolder(f, nodeFs, P))) {
      expect(embedded.recordedFolderFor(r, running, (f) => f)).toBe(
        recordedFolderFor(r, running, (f) => f),
      );
    }
  });
});
