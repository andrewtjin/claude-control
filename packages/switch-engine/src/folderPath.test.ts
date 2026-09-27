import { describe, it, expect } from 'vitest';
import {
  aliasKey,
  aliasScopeUniquenessKey,
  canonicalizeFolder,
  checkAliasFolder,
  exactAliasBinding,
  folderKey,
  isWithin,
  resolveBinding,
  resolveSessionBinding,
  exactBinding,
  checkBindTarget,
  embeddableFolderPathSource,
  type CanonicalizeDeps,
  type CanonicalizeResult,
  type ScopedGroup,
  type SessionBinding,
} from './folderPath.js';

/** Build a fake `realpath.native`: paths present in `map` resolve to their canonical form (this is
 *  how we simulate a junction, a symlink, an 8.3 short name or a true-case fixup deterministically
 *  and without touching the real filesystem); everything else throws ENOENT like the real call. */
function fakeRealpath(map: Record<string, string>): (p: string) => string {
  return (p: string) => {
    const v = map[p];
    if (v === undefined) {
      const err = new Error(`ENOENT: ${p}`) as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    }
    return v;
  };
}

const winDeps = (realMap: Record<string, string> = {}): CanonicalizeDeps => ({
  platform: 'win32',
  cwd: 'C:\\base',
  realpath: fakeRealpath(realMap),
});
const posixDeps = (realMap: Record<string, string> = {}): CanonicalizeDeps => ({
  platform: 'linux',
  cwd: '/base',
  realpath: fakeRealpath(realMap),
});

/** The full case table both the live and the embedded canonicalizer are checked against. Keeping it
 *  as data lets the agreement test reuse the exact same inputs the behavioural tests assert on. */
interface Case {
  name: string;
  input: string;
  deps: CanonicalizeDeps;
  expected: CanonicalizeResult;
}
const CASES: Case[] = [
  // --- Windows: realpath resolution (junction / symlink / 8.3 / true case) ---
  {
    name: 'win junction/symlink resolved by realpath',
    input: 'C:\\link',
    deps: winDeps({ 'C:\\link': 'C:\\Target\\Real' }),
    expected: { ok: true, path: 'C:\\Target\\Real' },
  },
  {
    name: 'win 8.3 short name resolved by realpath',
    input: 'C:\\PROGRA~1',
    deps: winDeps({ 'C:\\PROGRA~1': 'C:\\Program Files' }),
    expected: { ok: true, path: 'C:\\Program Files' },
  },
  {
    name: 'win true case resolved by realpath',
    input: 'C:\\users\\foo',
    deps: winDeps({ 'C:\\users\\foo': 'C:\\Users\\Foo' }),
    expected: { ok: true, path: 'C:\\Users\\Foo' },
  },
  {
    // The leaf does not exist yet, but its parent is a junction; realpath the deepest existing
    // ancestor and re-attach the missing tail so resolution is not existence-dependent.
    name: 'win resolves a junctioned ancestor when the leaf does not exist yet',
    input: 'C:\\proj\\ghost',
    deps: winDeps({ 'C:\\proj': 'C:\\research' }),
    expected: { ok: true, path: 'C:\\research\\ghost' },
  },
  {
    name: 'win resolves a junctioned ancestor two levels below a missing tail',
    input: 'C:\\proj\\a\\b',
    deps: winDeps({ 'C:\\proj': 'C:\\research' }),
    expected: { ok: true, path: 'C:\\research\\a\\b' },
  },
  // --- Windows: namespace prefixes ---
  {
    name: 'win strips \\\\?\\ extended-length prefix',
    input: '\\\\?\\C:\\research',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\research' },
  },
  {
    name: 'win strips \\\\?\\UNC\\ prefix to a UNC root',
    input: '\\\\?\\UNC\\server\\share\\dir',
    deps: winDeps(),
    expected: { ok: true, path: '\\\\server\\share\\dir' },
  },
  {
    name: 'win rejects \\\\.\\ device namespace',
    input: '\\\\.\\PhysicalDrive0',
    deps: winDeps(),
    expected: { ok: false, reason: 'device namespace path is not a folder' },
  },
  {
    // Mixed separators must not smuggle a device path past the reject: forward slashes are folded to
    // backslashes before the device check, so this cannot normalize back into the \\.\ form.
    name: 'win rejects a device namespace spelled with mixed separators',
    input: '/\\.\\PhysicalDrive0',
    deps: winDeps(),
    expected: { ok: false, reason: 'device namespace path is not a folder' },
  },
  {
    name: 'win rejects a device namespace spelled with all forward slashes',
    input: '//./PhysicalDrive0',
    deps: winDeps(),
    expected: { ok: false, reason: 'device namespace path is not a folder' },
  },
  {
    name: 'win rejects a \\\\?\\-wrapped device path spelled with mixed separators',
    input: '//?/.\\PhysicalDrive0',
    deps: winDeps(),
    expected: { ok: false, reason: 'device namespace path is not a folder' },
  },
  // --- Windows: colon rules (ADS, drive-relative) ---
  {
    name: 'win rejects NTFS alternate data stream',
    input: 'C:\\foo:bar',
    deps: winDeps(),
    expected: { ok: false, reason: 'alternate data stream in path' },
  },
  {
    name: 'win rejects drive-relative C:foo',
    input: 'C:foo',
    deps: winDeps(),
    expected: { ok: false, reason: 'drive-relative path is ambiguous' },
  },
  {
    name: 'win rejects bare drive designator C:',
    input: 'C:',
    deps: winDeps(),
    expected: { ok: false, reason: 'drive-relative path is ambiguous' },
  },
  {
    name: 'win rejects a colon in a relative segment',
    input: 'foo:bar',
    deps: winDeps(),
    expected: { ok: false, reason: 'alternate data stream or invalid colon in path' },
  },
  // --- Windows: trailing dots/spaces, mixed separators, collapse ---
  {
    name: 'win strips trailing dots and spaces per segment',
    input: 'C:\\foo. \\bar.',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\foo\\bar' },
  },
  {
    name: 'win collapses mixed separators to backslash',
    input: 'C:/foo\\bar/baz',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\foo\\bar\\baz' },
  },
  {
    name: 'win collapses .. against a real segment',
    input: 'C:\\a\\b\\..\\c',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\a\\c' },
  },
  {
    name: 'win resolves a relative input against cwd',
    input: 'sub\\dir',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\base\\sub\\dir' },
  },
  {
    name: 'win strips a trailing separator but keeps the drive root',
    input: 'C:\\foo\\',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\foo' },
  },
  {
    name: 'win keeps a bare drive root',
    input: 'C:\\',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\' },
  },
  {
    name: 'win NFD normalizes to NFC',
    // "café" with a decomposed e + combining acute accent -> precomposed é.
    input: 'C:\\caf\u0065\u0301',
    deps: winDeps(),
    expected: { ok: true, path: 'C:\\caf\u00e9' },
  },
  // --- POSIX ---
  {
    name: 'posix keeps an absolute path',
    input: '/a/b',
    deps: posixDeps(),
    expected: { ok: true, path: '/a/b' },
  },
  {
    name: 'posix resolves a relative input against cwd',
    input: 'a/b',
    deps: posixDeps(),
    expected: { ok: true, path: '/base/a/b' },
  },
  {
    name: 'posix treats a colon as an ordinary filename character',
    input: '/a:b/c',
    deps: posixDeps(),
    expected: { ok: true, path: '/a:b/c' },
  },
  {
    name: 'posix strips a trailing slash but keeps root',
    input: '/a/b/',
    deps: posixDeps(),
    expected: { ok: true, path: '/a/b' },
  },
  {
    name: 'posix keeps the filesystem root',
    input: '/',
    deps: posixDeps(),
    expected: { ok: true, path: '/' },
  },
  {
    name: 'posix collapses ..',
    input: '/a/b/../c',
    deps: posixDeps(),
    expected: { ok: true, path: '/a/c' },
  },
  {
    name: 'posix symlink resolved by realpath',
    input: '/link',
    deps: posixDeps({ '/link': '/real/target' }),
    expected: { ok: true, path: '/real/target' },
  },
  {
    name: 'posix resolves a symlinked ancestor when the leaf does not exist yet',
    input: '/proj/ghost',
    deps: posixDeps({ '/proj': '/real/research' }),
    expected: { ok: true, path: '/real/research/ghost' },
  },
  {
    name: 'posix NFD normalizes to NFC',
    input: '/caf\u0065\u0301',
    deps: posixDeps(),
    expected: { ok: true, path: '/caf\u00e9' },
  },
  // --- shared rejections ---
  {
    name: 'rejects the empty string',
    input: '',
    deps: winDeps(),
    expected: { ok: false, reason: 'path is empty' },
  },
  {
    name: 'rejects a NUL byte',
    input: 'C:\\foo\u0000bar',
    deps: winDeps(),
    expected: { ok: false, reason: 'path contains a control character' },
  },
  {
    name: 'rejects a control character on posix',
    input: '/foo\u0007bar',
    deps: posixDeps(),
    expected: { ok: false, reason: 'path contains a control character' },
  },
  {
    // A right-to-left override in a segment renders the tail reversed on a terminal, so the eye
    // reads a different folder than the one keyed. A canonical folder must never carry one.
    name: 'rejects a right-to-left override (U+202E) on win32',
    input: 'C:\\repos\\\u202egpj.evil',
    deps: winDeps(),
    expected: { ok: false, reason: 'path contains a bidirectional or format control character' },
  },
  {
    name: 'rejects a left-to-right/right-to-left mark (U+200F) on posix',
    input: '/repos/\u200fresearch',
    deps: posixDeps(),
    expected: { ok: false, reason: 'path contains a bidirectional or format control character' },
  },
  {
    name: 'rejects a directional isolate (U+2066) on posix',
    input: '/repos/\u2066research',
    deps: posixDeps(),
    expected: { ok: false, reason: 'path contains a bidirectional or format control character' },
  },
  {
    name: 'rejects a BOM/zero-width no-break space (U+FEFF) on win32',
    input: 'C:\\repos\\\ufeffresearch',
    deps: winDeps(),
    expected: { ok: false, reason: 'path contains a bidirectional or format control character' },
  },
];

describe('canonicalizeFolder', () => {
  for (const c of CASES) {
    it(c.name, () => {
      expect(canonicalizeFolder(c.input, c.deps)).toEqual(c.expected);
    });
  }

  it('is idempotent: canonicalizing a canonical path yields the same path', () => {
    for (const c of CASES) {
      const first = canonicalizeFolder(c.input, c.deps);
      if (!first.ok) continue;
      const second = canonicalizeFolder(first.path, c.deps);
      expect(second).toEqual(first);
    }
  });
});

describe('folderKey', () => {
  it('folds case on win32 only', () => {
    expect(folderKey('C:\\Foo\\Bar', 'win32')).toBe('c:\\foo\\bar');
    expect(folderKey('/Foo/Bar', 'linux')).toBe('/Foo/Bar');
  });
});

describe('isWithin', () => {
  it('treats an equal path as within', () => {
    expect(isWithin('C:\\research', 'C:\\research', 'win32')).toBe(true);
    expect(isWithin('/research', '/research', 'linux')).toBe(true);
  });
  it('honors the separator boundary (C:\\research vs C:\\research2)', () => {
    expect(isWithin('C:\\research\\x', 'C:\\research', 'win32')).toBe(true);
    expect(isWithin('C:\\research2', 'C:\\research', 'win32')).toBe(false);
    expect(isWithin('/research2', '/research', 'linux')).toBe(false);
  });
  it('folds case only on win32', () => {
    expect(isWithin('C:\\RESEARCH\\x', 'c:\\research', 'win32')).toBe(true);
    expect(isWithin('/RESEARCH/x', '/research', 'linux')).toBe(false);
  });
});

describe('resolveBinding', () => {
  const groups = [
    { id: 'g1', folders: ['C:\\work'] },
    { id: 'g2', folders: ['C:\\work\\client'] },
  ];
  it('returns null when no folder contains the path (global slot)', () => {
    expect(resolveBinding('C:\\other', groups, 'win32')).toBeNull();
  });
  it('returns the longest match so a nested binding overrides its ancestor', () => {
    expect(resolveBinding('C:\\work\\client\\sub', groups, 'win32')).toEqual({
      groupId: 'g2',
      folder: 'C:\\work\\client',
    });
    expect(resolveBinding('C:\\work\\elsewhere', groups, 'win32')).toEqual({
      groupId: 'g1',
      folder: 'C:\\work',
    });
  });
});

describe('exactBinding', () => {
  const groups = [{ id: 'g1', folders: ['C:\\work'] }];
  it('finds the group holding the exact folder (case-folded on win32)', () => {
    expect(exactBinding('c:\\WORK', groups, 'win32')).toBe('g1');
  });
  it('does not match a nested subfolder (that is allowed to bind elsewhere)', () => {
    expect(exactBinding('C:\\work\\client', groups, 'win32')).toBeNull();
  });
  it('matches a stored folder under a different separator spelling (keyed canonically)', () => {
    // A stored non-canonical spelling (hand-edit, or a vault copied under a different separator
    // convention) must still be found, or bind would report a bound folder as free.
    const skewed = [{ id: 'g1', folders: ['C:/g/8'] }];
    expect(exactBinding('C:\\g\\8', skewed, 'win32')).toBe('g1');
    expect(exactBinding('c:/G/8/', skewed, 'win32')).toBe('g1');
  });
});

describe('checkBindTarget', () => {
  const base = {
    platform: 'win32' as const,
    isDirectory: (p: string) => p.startsWith('C:\\work'),
    homeDir: 'C:\\Users\\me',
    vaultDir: 'C:\\Users\\me\\AppData\\Local\\claude-control\\vault',
    profilesRoot: 'C:\\Users\\me\\AppData\\Local\\claude-control\\profiles',
    mainConfigDir: 'C:\\Users\\me\\.claude',
  };
  it('accepts an ordinary directory', () => {
    expect(checkBindTarget('C:\\work\\proj', base)).toEqual({ ok: true });
  });
  it('refuses a path that is not an existing directory', () => {
    expect(checkBindTarget('C:\\nope', base)).toEqual({
      ok: false,
      reason: 'not an existing directory',
    });
  });
  it('refuses a filesystem root', () => {
    const deps = { ...base, isDirectory: () => true };
    expect(checkBindTarget('C:\\', deps).ok).toBe(false);
    expect(checkBindTarget('\\\\server\\share', deps).ok).toBe(false);
  });
  it('refuses the home directory', () => {
    const deps = { ...base, isDirectory: () => true };
    expect(checkBindTarget('C:\\Users\\me', deps)).toEqual({
      ok: false,
      reason: 'the home directory cannot be bound',
    });
  });
  it('refuses a descendant of the vault', () => {
    const deps = { ...base, isDirectory: () => true };
    expect(checkBindTarget(base.vaultDir + '\\g1', deps).ok).toBe(false);
  });
  it('refuses an ancestor of the profiles root', () => {
    const deps = { ...base, isDirectory: () => true };
    // C:\Users\me\AppData contains the profiles root -> overlap in the ancestor direction.
    expect(checkBindTarget('C:\\Users\\me\\AppData', deps).ok).toBe(false);
  });
  it('refuses the main config directory', () => {
    const deps = { ...base, isDirectory: () => true };
    expect(checkBindTarget('C:\\Users\\me\\.claude', deps).ok).toBe(false);
  });
});

describe('embeddableFolderPathSource', () => {
  // Reconstruct the trio in a scope with NO access to module state. If any of the three referenced
  // a module-level binding, this factory would throw a ReferenceError when the function ran — so
  // this both proves self-containment and gives us the embedded copy to compare.
  function loadEmbedded(): {
    canonicalizeFolder: typeof canonicalizeFolder;
    folderKey: typeof folderKey;
    isWithin: typeof isWithin;
  } {
    // `new Function` is exactly how the enforcement guard reconstitutes the embedded source, so the
    // test proves the real mechanism rather than a proxy for it — the implied-eval rule is disabled
    // here deliberately, not worked around.
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      `${embeddableFolderPathSource()}\nreturn { canonicalizeFolder, folderKey, isWithin };`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    return factory() as ReturnType<typeof loadEmbedded>;
  }

  it('agrees with the live canonicalizer on the entire case table', () => {
    const embedded = loadEmbedded();
    for (const c of CASES) {
      expect(embedded.canonicalizeFolder(c.input, c.deps)).toEqual(
        canonicalizeFolder(c.input, c.deps),
      );
    }
  });

  it('embeds working folderKey and isWithin too', () => {
    const embedded = loadEmbedded();
    expect(embedded.folderKey('C:\\Foo', 'win32')).toBe('c:\\foo');
    expect(embedded.isWithin('C:\\a\\b', 'C:\\a', 'win32')).toBe(true);
    expect(embedded.isWithin('C:\\ab', 'C:\\a', 'win32')).toBe(false);
  });

  it('embeds aliasKey and resolveSessionBinding, agreeing with the live ones on the whole table', () => {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const factory = new Function(
      `${embeddableFolderPathSource()}\nreturn { aliasKey, resolveSessionBinding };`,
    );
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call
    const embedded = factory() as {
      aliasKey: typeof aliasKey;
      resolveSessionBinding: typeof resolveSessionBinding;
    };
    for (const c of PRECEDENCE_CASES) {
      expect(embedded.resolveSessionBinding(c.folder, c.title, c.groups, c.platform)).toEqual(
        resolveSessionBinding(c.folder, c.title, c.groups, c.platform),
      );
    }
    expect(embedded.aliasKey('  Auth WORK ')).toBe(aliasKey('  Auth WORK '));
  });
});

// ---------------------------------------------------------------------------
// The precedence rule: alias scope (exact folder) > longest folder binding > global
// ---------------------------------------------------------------------------

/** One row of the precedence table: a session in `folder` titled `title`, and the binding the rule
 *  must pick (null = the global slot). Shared by the live test and the embedded-copy test so the
 *  guard's copy is held to exactly the same answers. */
interface PrecedenceCase {
  name: string;
  folder: string;
  title: string | null | undefined;
  groups: ScopedGroup[];
  platform: NodeJS.Platform;
  want: SessionBinding | null;
}

const WIN_GROUPS: ScopedGroup[] = [
  // A folder binding of C:\work (and so of every subfolder).
  { id: 'outer', folders: ['C:\\work'] },
  // A nested folder binding.
  { id: 'inner', folders: ['C:\\work\\client'] },
  // An alias-only group: "auth work" in C:\work, and "ops" in C:\work\client.
  {
    id: 'alias',
    folders: [],
    aliases: [
      { folder: 'C:\\work', aliasKey: 'auth work' },
      { folder: 'C:\\work\\client', aliasKey: 'ops' },
    ],
  },
  // A group with BOTH kinds: folder C:\research and alias "notes" in C:\elsewhere.
  {
    id: 'both',
    folders: ['C:\\research'],
    aliases: [{ folder: 'C:\\elsewhere', aliasKey: 'notes' }],
  },
];

const POSIX_GROUPS: ScopedGroup[] = [
  { id: 'outer', folders: ['/home/me/work'] },
  { id: 'alias', folders: [], aliases: [{ folder: '/home/me/work', aliasKey: 'auth work' }] },
];

const PRECEDENCE_CASES: PrecedenceCase[] = [
  {
    name: 'no groups: global',
    folder: 'C:\\work',
    title: 'Auth Work',
    groups: [],
    platform: 'win32',
    want: null,
  },
  {
    name: 'unbound folder, unnamed: global',
    folder: 'C:\\other',
    title: null,
    groups: WIN_GROUPS,
    platform: 'win32',
    want: null,
  },
  {
    name: 'folder binding, unnamed session',
    folder: 'C:\\work\\x',
    title: undefined,
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'outer', via: 'folder', folder: 'C:\\work' },
  },
  {
    name: 'nested folder binding wins by length',
    folder: 'C:\\work\\client\\deep',
    title: null,
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'inner', via: 'folder', folder: 'C:\\work\\client' },
  },
  {
    name: 'alias in the exact folder outranks the folder binding of that folder',
    folder: 'C:\\work',
    title: 'Auth Work',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'alias', via: 'alias', folder: 'C:\\work', aliasKey: 'auth work' },
  },
  {
    name: 'alias match is case-insensitive and trims (the claude --resume rule)',
    folder: 'C:\\work',
    title: '   AUTH work\t',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'alias', via: 'alias', folder: 'C:\\work', aliasKey: 'auth work' },
  },
  {
    name: 'alias folder compared case-insensitively on win32',
    folder: 'c:\\WORK',
    title: 'auth work',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'alias', via: 'alias', folder: 'C:\\work', aliasKey: 'auth work' },
  },
  {
    name: 'an alias scope is EXACT-folder: the same title in a subfolder falls to the folder rule',
    folder: 'C:\\work\\sub',
    title: 'Auth Work',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'outer', via: 'folder', folder: 'C:\\work' },
  },
  {
    name: 'alias in a nested bound folder outranks the nested folder binding',
    folder: 'C:\\work\\client',
    title: 'OPS',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'alias', via: 'alias', folder: 'C:\\work\\client', aliasKey: 'ops' },
  },
  {
    name: 'a different title falls to the folder rule',
    folder: 'C:\\work',
    title: 'something else',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'outer', via: 'folder', folder: 'C:\\work' },
  },
  {
    name: 'a blank title never matches an alias',
    folder: 'C:\\work',
    title: '   ',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'outer', via: 'folder', folder: 'C:\\work' },
  },
  {
    name: 'alias scope of a group that ALSO has folders, in an otherwise unbound folder',
    folder: 'C:\\elsewhere',
    title: 'Notes',
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'both', via: 'alias', folder: 'C:\\elsewhere', aliasKey: 'notes' },
  },
  {
    name: 'the same group’s folder scope still applies to unnamed sessions',
    folder: 'C:\\research\\x',
    title: null,
    groups: WIN_GROUPS,
    platform: 'win32',
    want: { groupId: 'both', via: 'folder', folder: 'C:\\research' },
  },
  {
    name: 'posix: alias in the exact folder',
    folder: '/home/me/work',
    title: 'auth WORK',
    groups: POSIX_GROUPS,
    platform: 'linux',
    want: { groupId: 'alias', via: 'alias', folder: '/home/me/work', aliasKey: 'auth work' },
  },
  {
    name: 'posix: folders are case-SENSITIVE, so a case variant is another (unbound) folder',
    folder: '/home/me/Work',
    title: 'auth work',
    groups: POSIX_GROUPS,
    platform: 'linux',
    want: null,
  },
  {
    name: 'posix: subfolder with the alias falls to the folder binding',
    folder: '/home/me/work/sub',
    title: 'auth work',
    groups: POSIX_GROUPS,
    platform: 'linux',
    want: { groupId: 'outer', via: 'folder', folder: '/home/me/work' },
  },
  {
    name: 'defensive: malformed rows (as an untrusted snapshot may carry) are skipped, never thrown',
    folder: 'C:\\work',
    title: 'auth work',
    groups: [
      null,
      { id: 'bad1', folders: 'nope', aliases: 'nope' },
      { id: 'bad2', folders: [7], aliases: [null, { folder: 7, aliasKey: 'auth work' }] },
      { id: 'good', folders: ['C:\\work'] },
    ] as unknown as ScopedGroup[],
    platform: 'win32',
    want: { groupId: 'good', via: 'folder', folder: 'C:\\work' },
  },
];

describe('resolveSessionBinding (the precedence table)', () => {
  it.each(PRECEDENCE_CASES.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    expect(resolveSessionBinding(c.folder, c.title, c.groups, c.platform)).toEqual(c.want);
  });

  it('resolveBinding is its folder half (no title)', () => {
    expect(resolveBinding('C:\\work', WIN_GROUPS, 'win32')).toEqual({
      groupId: 'outer',
      folder: 'C:\\work',
    });
  });
});

describe('aliasKey', () => {
  it('lower-cases and trims, exactly the claude --resume comparison', () => {
    expect(aliasKey('  Probe Alias ')).toBe('probe alias');
    expect(aliasKey('\tX\n')).toBe('x');
    // Inner whitespace is significant.
    expect(aliasKey('a  b')).not.toBe(aliasKey('a b'));
  });
});

describe('exactAliasBinding', () => {
  const groups = [
    { id: 'g1', aliases: [{ folder: 'C:\\repo', alias: 'Auth Work' }] },
    { id: 'g2', aliases: [{ folder: 'C:\\other', alias: 'Auth Work' }] },
    { id: 'g3' },
  ];
  it('finds the group by folder key + alias key, whatever the spelling', () => {
    expect(exactAliasBinding('c:/REPO/', ' auth WORK', groups, 'win32')).toBe('g1');
    expect(exactAliasBinding('C:\\other', 'auth work', groups, 'win32')).toBe('g2');
  });
  it('does not match another folder, a subfolder, or another alias', () => {
    expect(exactAliasBinding('C:\\repo\\sub', 'auth work', groups, 'win32')).toBeNull();
    expect(exactAliasBinding('C:\\repo', 'auth', groups, 'win32')).toBeNull();
    expect(exactAliasBinding('C:\\nowhere', 'auth work', groups, 'win32')).toBeNull();
  });
  it('uses a composite key that keeps the two halves apart', () => {
    expect(aliasScopeUniquenessKey('C:\\a', 'b', 'win32')).toBe('c:\\a\u0000b');
  });
});

describe('checkAliasFolder', () => {
  const base = {
    platform: 'win32' as const,
    isDirectory: () => true,
    homeDir: 'C:\\Users\\me',
    vaultDir: 'C:\\Users\\me\\AppData\\Local\\claude-control\\vault',
    profilesRoot: 'C:\\Users\\me\\AppData\\Local\\claude-control\\profiles',
    mainConfigDir: 'C:\\Users\\me\\.claude',
  };
  it('allows the home dir and a volume root (an alias scope never captures subfolders)', () => {
    expect(checkAliasFolder('C:\\Users\\me', base)).toEqual({ ok: true });
    expect(checkAliasFolder('C:\\', base)).toEqual({ ok: true });
  });
  it('refuses a missing folder and anything inside cctl state or the main config dir', () => {
    expect(checkAliasFolder('C:\\nope', { ...base, isDirectory: () => false }).ok).toBe(false);
    expect(checkAliasFolder(base.vaultDir, base).ok).toBe(false);
    expect(checkAliasFolder(base.profilesRoot + '\\g1', base).ok).toBe(false);
    expect(checkAliasFolder(base.mainConfigDir + '\\projects', base).ok).toBe(false);
  });
});
