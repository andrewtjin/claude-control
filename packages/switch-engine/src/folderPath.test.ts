import { describe, it, expect } from 'vitest';
import {
  canonicalizeFolder,
  folderKey,
  isWithin,
  resolveBinding,
  exactBinding,
  checkBindTarget,
  embeddableFolderPathSource,
  type CanonicalizeDeps,
  type CanonicalizeResult,
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
});
