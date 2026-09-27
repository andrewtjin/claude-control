// Session lookup tests. Pure: catalogs are built as literals, so every rule — which match wins,
// when a lookup leaves the working folder, when it must refuse to guess — is pinned without IO.
//
// Folder comparison is exercised under an explicit platform on both sides: Windows folders are
// one directory however their case and separators are spelled, POSIX folders are case-sensitive,
// and a lookup that got either wrong would open a different folder's session under the same alias.

import { describe, it, expect } from 'vitest';
import type { SessionMeta } from './sessionCatalog.js';
import {
  accountsBySession,
  aliasedSessions,
  resolveSessionRef,
  sameFolder,
  UNATTRIBUTED_SESSION_LABEL,
} from './sessionLookup.js';
import type { TranscriptTurn } from './transcriptTokens.js';

/** A catalog entry with sensible defaults; `lastActivityMs` orders "most recent first". */
function session(overrides: Partial<SessionMeta> & { sessionId: string }): SessionMeta {
  return {
    file: `/claude/projects/p/${overrides.sessionId}.jsonl`,
    projectDir: 'p',
    launchCwd: overrides.folder ?? null,
    folder: null,
    customTitle: null,
    aiTitle: null,
    firstActivityMs: 0,
    lastActivityMs: 0,
    ...overrides,
  };
}

const HERE = 'C:\\work\\app';
const ELSEWHERE = 'C:\\work\\other';
const THIRD = 'D:\\scratch';

describe('sameFolder', () => {
  it('treats Windows spellings of one folder as the same, across case and separators', () => {
    expect(sameFolder('C:\\Work\\App', 'c:/work/app', 'win32')).toBe(true);
    expect(sameFolder('C:\\Work\\App\\', 'C:\\work\\app', 'win32')).toBe(true);
    expect(sameFolder('c:\\work\\x\\..\\app', 'C:\\work\\app', 'win32')).toBe(true);
    expect(sameFolder('C:\\work\\app', 'C:\\work\\app2', 'win32')).toBe(false);
  });

  it('is case-sensitive on POSIX, while still ignoring a trailing or doubled slash', () => {
    expect(sameFolder('/home/me/app', '/home/me/App', 'linux')).toBe(false);
    expect(sameFolder('/home/me/app/', '/home/me/app', 'linux')).toBe(true);
    expect(sameFolder('/home//me/app', '/home/me/app', 'linux')).toBe(true);
  });
});

describe('resolveSessionRef', () => {
  it('matches a session id exactly, ignoring case', () => {
    const catalog = [session({ sessionId: 'abc-123', folder: ELSEWHERE })];
    const res = resolveSessionRef(catalog, 'ABC-123', HERE, 'win32');
    // An id is global: it resolves even though the session lives in another folder.
    expect(res).toEqual({ kind: 'id', session: catalog[0] });
  });

  it('lets an id win over an alias that happens to spell the same text', () => {
    const catalog = [
      session({ sessionId: 'named', folder: HERE, customTitle: 'abc-123', lastActivityMs: 9 }),
      session({ sessionId: 'abc-123', folder: ELSEWHERE }),
    ];
    const res = resolveSessionRef(catalog, 'abc-123', HERE, 'win32');
    expect(res.kind).toBe('id');
    expect(res.kind === 'id' && res.session.sessionId).toBe('abc-123');
  });

  it('finds nothing for an empty or blank reference', () => {
    const catalog = [session({ sessionId: 's', folder: HERE, customTitle: '' })];
    expect(resolveSessionRef(catalog, '', HERE, 'win32')).toEqual({ kind: 'none' });
    expect(resolveSessionRef(catalog, '   ', HERE, 'win32')).toEqual({ kind: 'none' });
  });

  it('compares aliases the way claude --resume does: lower-cased and trimmed', () => {
    const catalog = [session({ sessionId: 's', folder: HERE, customTitle: '  Auth Work ' })];
    const res = resolveSessionRef(catalog, 'auth work  ', HERE, 'win32');
    expect(res).toMatchObject({ kind: 'alias', inScope: true, folder: HERE });
  });

  it('matches a generated title when no custom title was set', () => {
    const catalog = [session({ sessionId: 's', folder: HERE, aiTitle: 'Fix login' })];
    expect(resolveSessionRef(catalog, 'fix login', HERE, 'win32').kind).toBe('alias');
  });

  it('does not match the generated title of a session whose custom title is blank', () => {
    // `customTitle ?? aiTitle` stops at '' — the resume search would not find it either.
    const catalog = [
      session({ sessionId: 's', folder: HERE, customTitle: '', aiTitle: 'Fix login' }),
    ];
    expect(resolveSessionRef(catalog, 'fix login', HERE, 'win32')).toEqual({ kind: 'none' });
  });

  it('prefers the matches in the working folder, however that folder is spelled', () => {
    const catalog = [
      session({ sessionId: 'far', folder: ELSEWHERE, customTitle: 'api', lastActivityMs: 99 }),
      session({
        sessionId: 'near-old',
        folder: 'c:/Work/App',
        customTitle: 'api',
        lastActivityMs: 1,
      }),
      session({ sessionId: 'near-new', folder: HERE, customTitle: 'API', lastActivityMs: 5 }),
    ];
    const res = resolveSessionRef(catalog, 'api', HERE, 'win32');
    expect(res.kind).toBe('alias');
    if (res.kind !== 'alias') return;
    expect(res.inScope).toBe(true);
    expect(res.folder).toBe(HERE);
    // Only the in-folder sessions, most recent first; the more recent one elsewhere is not a rival.
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['near-new', 'near-old']);
  });

  it('answers with the one other folder that uses the alias, flagged out of scope', () => {
    const catalog = [
      session({ sessionId: 'a', folder: ELSEWHERE, customTitle: 'api', lastActivityMs: 1 }),
      // The same folder spelled differently still counts as ONE other folder on Windows.
      session({ sessionId: 'b', folder: 'c:/WORK/other', customTitle: 'api', lastActivityMs: 2 }),
    ];
    const res = resolveSessionRef(catalog, 'api', HERE, 'win32');
    expect(res.kind).toBe('alias');
    if (res.kind !== 'alias') return;
    expect(res.inScope).toBe(false);
    expect(res.sessions.map((s) => s.sessionId)).toEqual(['b', 'a']);
  });

  it('refuses to guess between several other folders: ambiguous, most recent folder first', () => {
    const catalog = [
      session({ sessionId: 'x1', folder: ELSEWHERE, customTitle: 'api', lastActivityMs: 10 }),
      session({ sessionId: 'y1', folder: THIRD, customTitle: 'api', lastActivityMs: 30 }),
      session({ sessionId: 'x2', folder: ELSEWHERE, customTitle: 'api', lastActivityMs: 20 }),
    ];
    const res = resolveSessionRef(catalog, 'api', HERE, 'win32');
    expect(res.kind).toBe('ambiguous');
    if (res.kind !== 'ambiguous') return;
    expect(res.folders.map((f) => [f.folder, f.sessions.map((s) => s.sessionId)])).toEqual([
      [THIRD, ['y1']],
      [ELSEWHERE, ['x2', 'x1']],
    ]);
  });

  it('keeps POSIX folders that differ only in case apart', () => {
    const catalog = [
      session({
        sessionId: 'lower',
        folder: '/home/me/app',
        customTitle: 'api',
        lastActivityMs: 1,
      }),
      session({
        sessionId: 'upper',
        folder: '/home/me/App',
        customTitle: 'api',
        lastActivityMs: 2,
      }),
    ];
    const res = resolveSessionRef(catalog, 'api', '/home/me/app', 'linux');
    // Only the exact-case folder is "here"; on Windows both would be.
    expect(res).toMatchObject({ kind: 'alias', inScope: true });
    expect(res.kind === 'alias' && res.sessions.map((s) => s.sessionId)).toEqual(['lower']);
    const elsewhere = resolveSessionRef(catalog, 'api', '/home/me/APP', 'linux');
    expect(elsewhere.kind).toBe('ambiguous');
    const win = resolveSessionRef(
      catalog.map((s) => ({
        ...s,
        folder: s.folder === null ? null : `C:${s.folder.replace(/\//g, '\\')}`,
      })),
      'api',
      'C:\\home\\me\\APP',
      'win32',
    );
    expect(win.kind === 'alias' && win.sessions).toHaveLength(2);
  });

  it('matches a session with no recorded folder by id only, never by alias', () => {
    const catalog = [session({ sessionId: 'nofolder', folder: null, customTitle: 'api' })];
    expect(resolveSessionRef(catalog, 'api', HERE, 'win32')).toEqual({ kind: 'none' });
    expect(resolveSessionRef(catalog, 'nofolder', HERE, 'win32').kind).toBe('id');
  });

  it('finds nothing when no id or alias matches', () => {
    const catalog = [session({ sessionId: 's', folder: HERE, customTitle: 'api' })];
    expect(resolveSessionRef(catalog, 'web', HERE, 'win32')).toEqual({ kind: 'none' });
  });
});

describe('aliasedSessions', () => {
  const catalog = [
    session({ sessionId: 'here-custom', folder: HERE, customTitle: 'one', lastActivityMs: 1 }),
    session({ sessionId: 'here-auto', folder: 'c:/work/APP', aiTitle: 'two', lastActivityMs: 3 }),
    session({ sessionId: 'here-none', folder: HERE, lastActivityMs: 9 }),
    session({
      sessionId: 'here-blank',
      folder: HERE,
      customTitle: ' ',
      aiTitle: 'hidden',
      lastActivityMs: 9,
    }),
    session({ sessionId: 'away', folder: ELSEWHERE, customTitle: 'three', lastActivityMs: 2 }),
    session({ sessionId: 'nowhere', folder: null, customTitle: 'four', lastActivityMs: 4 }),
  ];

  it('lists the aliased sessions of one folder, most recent first', () => {
    expect(aliasedSessions(catalog, HERE, 'win32').map((s) => s.sessionId)).toEqual([
      'here-auto',
      'here-custom',
    ]);
  });

  it('lists every folder for a null folder, still skipping sessions with no alias or no folder', () => {
    expect(aliasedSessions(catalog, null, 'win32').map((s) => s.sessionId)).toEqual([
      'here-auto',
      'away',
      'here-custom',
    ]);
  });
});

describe('accountsBySession', () => {
  function turn(sessionId: string | null, tsMs: number, tokens = 1): TranscriptTurn {
    return {
      tsMs,
      sessionId,
      model: 'm',
      inputTokens: tokens,
      outputTokens: tokens * 10,
      cacheCreationTokens: tokens * 100,
      cacheReadTokens: tokens * 1000,
    };
  }

  /** Attribute by time: before 100 nobody, 100..199 acct-a, 200..299 acct-b, then acct-a again. */
  const accountFor = (t: TranscriptTurn): string | null =>
    t.tsMs < 100 ? null : t.tsMs < 200 ? 'acct-a' : t.tsMs < 300 ? 'acct-b' : 'acct-a';
  const labels = new Map([['acct-a', 'main']]);

  it('lists accounts in the order the session first used them, whatever order the turns came in', () => {
    const uses = accountsBySession(
      [turn('s', 350), turn('s', 250), turn('s', 50), turn('s', 150)],
      accountFor,
      labels,
    );
    expect(uses.get('s')?.map((u) => u.accountId)).toEqual([null, 'acct-a', 'acct-b']);
  });

  it('labels the unattributed bucket, uses registry labels, and falls back to the raw id', () => {
    const uses = accountsBySession(
      [turn('s', 50), turn('s', 150), turn('s', 250)],
      accountFor,
      labels,
    );
    expect(uses.get('s')?.map((u) => u.label)).toEqual([
      UNATTRIBUTED_SESSION_LABEL,
      'main',
      'acct-b',
    ]);
    expect(UNATTRIBUTED_SESSION_LABEL).toBe('unattributed');
  });

  it('sums turns and all four token kinds, and spans first to last use per account', () => {
    const uses = accountsBySession(
      [turn('s', 110, 1), turn('s', 250, 5), turn('s', 190, 2), turn('s', 400, 3)],
      accountFor,
      labels,
    );
    const a = uses.get('s')?.find((u) => u.accountId === 'acct-a');
    // Turns at 110, 190 and 400 (acct-a again after acct-b): 1111 * (1 + 2 + 3) tokens.
    expect(a).toEqual({
      accountId: 'acct-a',
      label: 'main',
      turns: 3,
      tokens: 1111 * 6,
      firstMs: 110,
      lastMs: 400,
    });
  });

  it('keeps sessions apart and skips turns with no session', () => {
    const uses = accountsBySession(
      [turn('s1', 150), turn('s2', 250), turn(null, 150)],
      accountFor,
      labels,
    );
    expect([...uses.keys()].sort()).toEqual(['s1', 's2']);
    expect(uses.get('s1')?.map((u) => u.accountId)).toEqual(['acct-a']);
    expect(uses.get('s2')?.map((u) => u.accountId)).toEqual(['acct-b']);
  });

  it('returns an empty map for no turns', () => {
    expect(accountsBySession([], accountFor, labels).size).toBe(0);
  });
});
