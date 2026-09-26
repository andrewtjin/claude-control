import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  lstatSync,
  symlinkSync,
  utimesSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename, normalize } from 'node:path';
import {
  ensureGroupProfile,
  planGroupProfile,
  computeClaudeJsonMerge,
  createNodeProfileFs,
  defaultProfilesRoot,
  groupProfileDir,
  SHARED_PROFILE_DIRS,
  type ProfileFs,
  type ProfilePlatform,
  type EntryKind,
} from './profile.js';

// ---------------------------------------------------------------------------------------------
// Sandboxes. Every test that touches the real filesystem builds a throwaway root under the OS temp
// dir and drops it afterwards; nothing here ever reaches the real `~/.claude`.
// ---------------------------------------------------------------------------------------------

let sandboxes: string[] = [];
function sandbox(): { root: string; main: string; profile: string } {
  const root = mkdtempSync(join(tmpdir(), 'ce-profile-'));
  sandboxes.push(root);
  const main = join(root, 'main');
  const profile = join(root, 'profiles', 'g1');
  mkdirSync(main, { recursive: true });
  return { root, main, profile };
}

afterEach(() => {
  for (const d of sandboxes) rmSync(d, { recursive: true, force: true });
  sandboxes = [];
});

/** The same temp+rename write Claude Code uses for `settings.json` etc. — it lands a NEW inode, so a
 *  hard link to the old inode is severed exactly as it would be in production. Used to manufacture a
 *  broken link for the repair tests. */
function breakLinkWithNewInode(path: string, content: string): void {
  const tmp = join(dirname(path), `.break-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(tmp, content);
  rmSync(path, { force: true });
  // rename via a fresh write is what severs the link; write-then-rename keeps it atomic.
  writeFileSync(path, content);
  rmSync(tmp, { force: true });
}

function ino(path: string): bigint {
  return statSync(path, { bigint: true }).ino;
}

/** The subset of `.claude.json` shape these tests read back, typed so assertions stay lint-clean
 *  (an untyped `JSON.parse` is `any`, which the workspace lint rejects). */
interface ClaudeJson {
  oauthAccount?: { accountUuid?: string; emailAddress?: string };
  theme?: string;
  installMethod?: string;
  hasCompletedOnboarding?: boolean;
  fooMigrationComplete?: boolean;
  barMigrationTimestamp?: number;
  unpinFooLaunchEffort?: string;
  projects?: Record<string, { hasTrustDialogAccepted?: boolean; allowedTools?: string[] }>;
  [key: string]: unknown;
}

function parseClaude(text: string | null): ClaudeJson {
  if (text === null) throw new Error('expected JSON text, got null');
  return JSON.parse(text) as ClaudeJson;
}

// ---------------------------------------------------------------------------------------------
// Pure `.claude.json` merge — no filesystem. The account identity must survive every path.
// ---------------------------------------------------------------------------------------------

describe('computeClaudeJsonMerge', () => {
  it('copies allowlisted onboarding keys main -> profile and leaves everything else', () => {
    const profile = JSON.stringify({
      oauthAccount: { accountUuid: 'PROFILE-ACCT', emailAddress: 'work@example.com' },
      theme: 'light',
    });
    const main = JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      installMethod: 'npm',
      somePrivateKey: 'should-not-copy',
      oauthAccount: { accountUuid: 'MAIN-ACCT' },
    });
    const merge = computeClaudeJsonMerge(profile, main);
    const out = parseClaude(merge.serialized);
    // Identity is the profile's, never main's.
    expect(out.oauthAccount?.accountUuid).toBe('PROFILE-ACCT');
    // Allowlisted keys flow from main (theme is overwritten, onboarding/install added).
    expect(out.hasCompletedOnboarding).toBe(true);
    expect(out.theme).toBe('dark');
    expect(out.installMethod).toBe('npm');
    // A non-allowlisted key in main is not copied.
    expect('somePrivateKey' in out).toBe(false);
    expect(merge.profileCorrupt).toBe(false);
    expect(merge.mainUnreadable).toBe(false);
  });

  it('copies keys matched by the migration/launch-effort patterns', () => {
    const main = JSON.stringify({
      fooMigrationComplete: true,
      barMigrationTimestamp: 123,
      unpinFooLaunchEffort: 'x',
      randomMigrationOther: 'no',
    });
    const out = parseClaude(computeClaudeJsonMerge('{}', main).serialized);
    expect(out.fooMigrationComplete).toBe(true);
    expect(out.barMigrationTimestamp).toBe(123);
    expect(out.unpinFooLaunchEffort).toBe('x');
    // Not matched by any allowlist entry or pattern.
    expect('randomMigrationOther' in out).toBe(false);
  });

  it('never pollutes Object.prototype via a hostile __proto__/constructor key on either side', () => {
    // JSON.parse keeps `__proto__` as an OWN property (it does not invoke the prototype setter), so a
    // naive copy would still reach Object.prototype; the merge must drop it on both sides.
    const main = '{"__proto__":{"polluted":"yes"},"constructor":{"bad":1},"theme":"dark"}';
    const profile = '{"__proto__":{"polluted":"also"},"prototype":{"x":1}}';
    const merge = computeClaudeJsonMerge(profile, main);
    const out = parseClaude(merge.serialized);
    // No pollution reached the global prototype.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
    // The forbidden keys are not present as ordinary keys either.
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, 'prototype')).toBe(false);
    // A legitimate allowlisted key still made it through.
    expect(out.theme).toBe('dark');
  });

  it('overlays per-project entries main -> profile and OR-merges trust (main -> profile only)', () => {
    const profile = JSON.stringify({
      projects: {
        '/a': { hasTrustDialogAccepted: true, allowedTools: ['P'] },
        '/b': { hasTrustDialogAccepted: false },
      },
    });
    const main = JSON.stringify({
      projects: {
        '/b': { hasTrustDialogAccepted: true, allowedTools: ['M'] },
        '/c': { hasTrustDialogAccepted: true },
      },
    });
    const out = parseClaude(computeClaudeJsonMerge(profile, main).serialized);
    // /a exists only in the profile: trust preserved (main did not revoke it).
    expect(out.projects?.['/a']?.hasTrustDialogAccepted).toBe(true);
    // /b: main grants trust the profile lacked -> OR gives true; main's fields overlay.
    expect(out.projects?.['/b']?.hasTrustDialogAccepted).toBe(true);
    expect(out.projects?.['/b']?.allowedTools).toEqual(['M']);
    // /c exists only in main: carried over.
    expect(out.projects?.['/c']?.hasTrustDialogAccepted).toBe(true);
  });

  it('keeps a profile-only trust grant even when main is missing that project', () => {
    // Trust must never be revoked from the profile by a main that simply has not seen the folder.
    const out = parseClaude(
      computeClaudeJsonMerge(
        JSON.stringify({ projects: { '/only': { hasTrustDialogAccepted: true } } }),
        JSON.stringify({ projects: {} }),
      ).serialized,
    );
    expect(out.projects?.['/only']?.hasTrustDialogAccepted).toBe(true);
  });

  it('refuses to merge when the profile file is corrupt (identity must not be discarded)', () => {
    const merge = computeClaudeJsonMerge('{not json', JSON.stringify({ theme: 'dark' }));
    expect(merge.profileCorrupt).toBe(true);
    expect(merge.serialized).toBeNull();
  });

  it('preserves the profile when main is corrupt or missing', () => {
    const profile = JSON.stringify({ oauthAccount: { accountUuid: 'KEEP' }, theme: 'light' });
    for (const main of ['{bad', null]) {
      const merge = computeClaudeJsonMerge(profile, main);
      expect(merge.mainUnreadable).toBe(true);
      const out = parseClaude(merge.serialized);
      expect(out.oauthAccount?.accountUuid).toBe('KEEP');
      expect(out.theme).toBe('light');
    }
  });

  it('strips a leading BOM before parsing', () => {
    const profile = '\uFEFF' + JSON.stringify({ oauthAccount: { accountUuid: 'BOM' } });
    const merge = computeClaudeJsonMerge(profile, '{}');
    expect(merge.profileCorrupt).toBe(false);
    expect(parseClaude(merge.serialized).oauthAccount?.accountUuid).toBe('BOM');
  });

  it('is idempotent: feeding the serialized output back yields the same bytes', () => {
    const profile = JSON.stringify({ oauthAccount: { accountUuid: 'X' } });
    const main = JSON.stringify({
      hasCompletedOnboarding: true,
      theme: 'dark',
      projects: { '/p': { hasTrustDialogAccepted: true } },
    });
    const first = computeClaudeJsonMerge(profile, main).serialized as string;
    const second = computeClaudeJsonMerge(first, main).serialized as string;
    expect(second).toBe(first);
  });
});

// ---------------------------------------------------------------------------------------------
// Real filesystem on this Windows box: junction creation, hard-link identity, repair, backups.
// These exercise the production node-backed seam against real NTFS primitives.
// ---------------------------------------------------------------------------------------------

describe('ensureGroupProfile (real filesystem)', () => {
  it('materializes a fresh profile: junctions for dirs, hard links for files, merged .claude.json', () => {
    const { main, profile } = sandbox();
    // Seed main with a couple of shared dirs and files plus a private identity file.
    mkdirSync(join(main, 'projects'), { recursive: true });
    mkdirSync(join(main, 'plugins'), { recursive: true });
    writeFileSync(join(main, 'settings.json'), '{"a":1}');
    writeFileSync(join(main, 'CLAUDE.md'), '# memory');
    writeFileSync(join(main, 'RTK.md'), '# rtk');
    writeFileSync(join(main, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }));
    // A credentials file in main must NEVER be linked into the profile.
    writeFileSync(join(main, '.credentials.json'), 'SECRET');

    const report = ensureGroupProfile(profile, main);

    // Shared dirs are junctions pointing at main.
    for (const d of ['projects', 'plugins']) {
      const link = join(profile, d);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(normalize(readlinkSync(link)).toLowerCase()).toBe(
        normalize(join(main, d)).toLowerCase(),
      );
      expect(report.linkedDirs).toContain(d);
    }
    // Shared files are hard links: same inode as main.
    for (const f of ['settings.json', 'CLAUDE.md', 'RTK.md']) {
      expect(ino(join(profile, f))).toBe(ino(join(main, f)));
      expect(report.linkedFiles).toContain(f);
    }
    // The credentials file is never linked.
    expect(
      lstatSync(join(profile, '.credentials.json'), { throwIfNoEntry: false }),
    ).toBeUndefined();
    // .claude.json is a real independent file (not a link) and carries the merged onboarding key.
    expect(lstatSync(join(profile, '.claude.json')).isSymbolicLink()).toBe(false);
    expect(
      parseClaude(readFileSync(join(profile, '.claude.json'), 'utf8')).hasCompletedOnboarding,
    ).toBe(true);
    expect(report.claudeJsonMerged).toBe(true);
    // The profile root is private-mode on POSIX; on Windows the mode is inherited (no assertion).
    expect(report.skipped).toEqual([]);
  });

  it('is idempotent: a second run repairs nothing, copies nothing, merges nothing', () => {
    const { main, profile } = sandbox();
    mkdirSync(join(main, 'projects'), { recursive: true });
    writeFileSync(join(main, 'settings.json'), '{"a":1}');
    writeFileSync(join(main, '.claude.json'), JSON.stringify({ theme: 'dark' }));

    ensureGroupProfile(profile, main);
    const settingsInoAfterFirst = ino(join(profile, 'settings.json'));
    const second = ensureGroupProfile(profile, main);

    expect(second.repaired).toEqual([]);
    expect(second.copiedFallback).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.claudeJsonMerged).toBe(false);
    // The verified-OK entries are still reported as linked, and the inode is unchanged.
    expect(second.linkedDirs).toContain('projects');
    expect(second.linkedFiles).toContain('settings.json');
    expect(ino(join(profile, 'settings.json'))).toBe(settingsInoAfterFirst);
  });

  it('creates a shared dir in main when it is absent, then links it', () => {
    const { main, profile } = sandbox();
    // main has none of the shared dirs yet.
    const report = ensureGroupProfile(profile, main);
    for (const d of SHARED_PROFILE_DIRS) {
      expect(statSync(join(main, d)).isDirectory()).toBe(true);
      expect(lstatSync(join(profile, d)).isSymbolicLink()).toBe(true);
      expect(report.linkedDirs).toContain(d);
    }
  });

  it('repairs a broken hard link newest-wins when the PROFILE copy is newer', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, 'settings.json'), 'MAIN-OLD');
    ensureGroupProfile(profile, main);
    // Sever the link with a temp+rename, then make the profile copy the newer one.
    breakLinkWithNewInode(join(profile, 'settings.json'), 'PROFILE-NEW');
    utimesSync(join(main, 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(join(profile, 'settings.json'), new Date('2030-01-01'), new Date('2030-01-01'));

    const report = ensureGroupProfile(profile, main);

    expect(report.repaired).toContain('settings.json');
    // Both names share one inode again, and it holds the profile's newer content.
    expect(ino(join(profile, 'settings.json'))).toBe(ino(join(main, 'settings.json')));
    expect(readFileSync(join(main, 'settings.json'), 'utf8')).toBe('PROFILE-NEW');
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('PROFILE-NEW');
    // Main's losing content is preserved as a backup.
    const backups = readdirSync(join(profile, '.cctl-backup')).filter((f) =>
      f.startsWith('settings.json.'),
    );
    expect(backups.length).toBe(1);
    expect(readFileSync(join(profile, '.cctl-backup', backups[0] as string), 'utf8')).toBe(
      'MAIN-OLD',
    );
  });

  it('repairs a broken hard link newest-wins when MAIN is newer', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, 'settings.json'), 'MAIN-OLD');
    ensureGroupProfile(profile, main);
    breakLinkWithNewInode(join(profile, 'settings.json'), 'PROFILE-OLD');
    // Now make MAIN the newer side and give it fresh content.
    writeFileSync(join(main, 'settings.json'), 'MAIN-NEW');
    utimesSync(join(profile, 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));
    utimesSync(join(main, 'settings.json'), new Date('2030-01-01'), new Date('2030-01-01'));

    const report = ensureGroupProfile(profile, main);

    expect(report.repaired).toContain('settings.json');
    expect(ino(join(profile, 'settings.json'))).toBe(ino(join(main, 'settings.json')));
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('MAIN-NEW');
    // The profile's losing content is preserved as a backup.
    const backups = readdirSync(join(profile, '.cctl-backup')).filter((f) =>
      f.startsWith('settings.json.'),
    );
    expect(backups.length).toBe(1);
    expect(readFileSync(join(profile, '.cctl-backup', backups[0] as string), 'utf8')).toBe(
      'PROFILE-OLD',
    );
  });

  it('bounds the number of backups kept per file', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, 'settings.json'), 'v0');
    ensureGroupProfile(profile, main, { maxBackupsPerFile: 3 });
    // Repair repeatedly; each run severs the link again and produces one backup. A monotonic clock
    // gives every backup a distinct, sortable name so pruning keeps the newest three.
    let clock = 1000;
    for (let i = 1; i <= 8; i += 1) {
      breakLinkWithNewInode(join(profile, 'settings.json'), `p${i}`);
      utimesSync(join(main, 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));
      utimesSync(join(profile, 'settings.json'), new Date('2030-01-01'), new Date('2030-01-01'));
      clock += 1000;
      ensureGroupProfile(profile, main, { maxBackupsPerFile: 3, now: () => clock });
    }
    const backups = readdirSync(join(profile, '.cctl-backup')).filter((f) =>
      f.startsWith('settings.json.'),
    );
    expect(backups.length).toBe(3);
  });

  it('refuses a pre-planted junction that escapes the main config dir, and leaves it untouched', () => {
    const { root, main, profile } = sandbox();
    // A hostile directory the pre-planted junction points at, well OUTSIDE main.
    const hostile = join(root, 'hostile');
    mkdirSync(hostile, { recursive: true });
    writeFileSync(join(hostile, 'evidence.txt'), 'do not touch');
    mkdirSync(profile, { recursive: true });
    symlinkSync(hostile, join(profile, 'projects'), 'junction');

    const report = ensureGroupProfile(profile, main);

    // The junction is still the hostile one — never followed, never removed.
    expect(normalize(readlinkSync(join(profile, 'projects'))).toLowerCase()).toBe(
      normalize(hostile).toLowerCase(),
    );
    expect(readFileSync(join(hostile, 'evidence.txt'), 'utf8')).toBe('do not touch');
    expect(report.linkedDirs).not.toContain('projects');
    const skip = report.skipped.find((s) => s.path === join(profile, 'projects'));
    expect(skip?.reason).toMatch(/outside main config dir/);
  });

  it('leaves an unexpected real entry (a real dir, or a file where a dir belongs) untouched and reports it', () => {
    // "Unexpected" = a real entry at a path the sweep would otherwise create a LINK at, that it did
    // not create itself. A diverged regular file at a shared-FILE path is a different case: that is a
    // hard link Claude Code severed, and it is healed by the repair path, not skipped (covered above).
    const { main, profile } = sandbox();
    mkdirSync(join(main, 'plugins'), { recursive: true });
    // A real directory where the `projects` junction would go, holding data that must survive.
    mkdirSync(join(profile, 'projects'), { recursive: true });
    writeFileSync(join(profile, 'projects', 'user-data.txt'), 'mine');
    // A real regular file where the `plugins` junction would go.
    writeFileSync(join(profile, 'plugins'), 'not a directory');

    const report = ensureGroupProfile(profile, main);

    // The real directory is not turned into a link and its contents survive.
    expect(lstatSync(join(profile, 'projects')).isDirectory()).toBe(true);
    expect(readFileSync(join(profile, 'projects', 'user-data.txt'), 'utf8')).toBe('mine');
    expect(report.skipped.some((s) => s.path === join(profile, 'projects'))).toBe(true);
    expect(report.linkedDirs).not.toContain('projects');
    // The real file where a dir belongs is left alone and reported.
    expect(readFileSync(join(profile, 'plugins'), 'utf8')).toBe('not a directory');
    expect(report.skipped.some((s) => s.path === join(profile, 'plugins'))).toBe(true);
    expect(report.linkedDirs).not.toContain('plugins');
  });

  it('heals a diverged regular file at a shared-file path via repair, not skip', () => {
    // A settings.json that is a real file with a different inode than main is a severed hard link;
    // the sweep repairs it (newest-wins, with a backup) rather than treating it as foreign.
    const { main, profile } = sandbox();
    writeFileSync(join(main, 'settings.json'), 'MAIN');
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, 'settings.json'), 'PROFILE');
    utimesSync(join(main, 'settings.json'), new Date('2030-01-01'), new Date('2030-01-01'));
    utimesSync(join(profile, 'settings.json'), new Date('2020-01-01'), new Date('2020-01-01'));

    const report = ensureGroupProfile(profile, main);

    expect(report.repaired).toContain('settings.json');
    expect(report.skipped.some((s) => s.path === join(profile, 'settings.json'))).toBe(false);
    // Main was newer, so it wins; the profile's losing copy is backed up.
    expect(ino(join(profile, 'settings.json'))).toBe(ino(join(main, 'settings.json')));
    expect(readFileSync(join(profile, 'settings.json'), 'utf8')).toBe('MAIN');
    const backups = readdirSync(join(profile, '.cctl-backup')).filter((f) =>
      f.startsWith('settings.json.'),
    );
    expect(readFileSync(join(profile, '.cctl-backup', backups[0] as string), 'utf8')).toBe(
      'PROFILE',
    );
  });

  it('never clobbers a corrupt profile .claude.json (identity is left intact)', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, '.claude.json'), JSON.stringify({ theme: 'dark' }));
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, '.claude.json'), '{ this is not valid json');

    const report = ensureGroupProfile(profile, main);

    expect(report.claudeJsonMerged).toBe(false);
    expect(readFileSync(join(profile, '.claude.json'), 'utf8')).toBe('{ this is not valid json');
    expect(report.skipped.some((s) => s.path === join(profile, '.claude.json'))).toBe(true);
  });

  it('preserves the profile oauthAccount when main .claude.json is corrupt', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, '.claude.json'), '{ broken');
    mkdirSync(profile, { recursive: true });
    writeFileSync(
      join(profile, '.claude.json'),
      JSON.stringify({ oauthAccount: { accountUuid: 'SAFE' } }),
    );

    ensureGroupProfile(profile, main);

    const out = parseClaude(readFileSync(join(profile, '.claude.json'), 'utf8'));
    expect(out.oauthAccount?.accountUuid).toBe('SAFE');
  });

  it('discovers and hard-links every root *.md, but not a *.md in a subdir', () => {
    const { main, profile } = sandbox();
    writeFileSync(join(main, 'CLAUDE.md'), 'a');
    writeFileSync(join(main, 'NOTES.md'), 'b');
    mkdirSync(join(main, 'projects'), { recursive: true });
    writeFileSync(join(main, 'projects', 'inside.md'), 'c');

    const report = ensureGroupProfile(profile, main);

    expect(report.linkedFiles).toContain('CLAUDE.md');
    expect(report.linkedFiles).toContain('NOTES.md');
    // inside.md is reachable through the projects junction, never linked as a root file.
    expect(report.linkedFiles).not.toContain('inside.md');
    expect(ino(join(profile, 'NOTES.md'))).toBe(ino(join(main, 'NOTES.md')));
  });
});

// ---------------------------------------------------------------------------------------------
// The plan view (doctor) agrees with what a run does.
// ---------------------------------------------------------------------------------------------

describe('planGroupProfile', () => {
  it('describes the same actions a first run would take without changing anything', () => {
    const { main, profile } = sandbox();
    mkdirSync(join(main, 'projects'), { recursive: true });
    writeFileSync(join(main, 'settings.json'), '{}');

    const plan = planGroupProfile(profile, main);
    // Nothing was created by planning.
    expect(lstatSync(join(profile, 'projects'), { throwIfNoEntry: false })).toBeUndefined();
    // The plan calls for a link and a hard link.
    expect(plan.dirs.find((d) => d.name === 'projects')?.action).toBe('link');
    expect(plan.files.find((f) => f.name === 'settings.json')?.action).toBe('hardlink');
    expect(plan.claudeJson.action).toBe('write');
  });
});

// ---------------------------------------------------------------------------------------------
// The filesystem seam: an in-memory fake that lets a test drive the POSIX symlink primitives (which
// need privilege to create on Windows) and inject an EXDEV cross-volume fault deterministically.
// ---------------------------------------------------------------------------------------------

interface MemInode {
  kind: EntryKind;
  data?: Buffer;
  target?: string;
  mtimeMs: bigint;
}

interface MemFsOptions {
  platform: ProfilePlatform;
  /** Paths at or under this prefix report a different volume id (drives cross-volume handling). */
  separateVolumeUnder?: string;
  /** When set, every hard-link attempt throws with this errno code (a "late" EXDEV, say). */
  hardlinkThrows?: string;
}

/** A tiny in-memory ProfileFs with real inode/hard-link semantics: two names can share one inode,
 *  an in-place write is seen through both, an atomic write forks a new inode. Enough to prove the
 *  module's platform branches without needing OS symlink privilege. */
function makeMemFs(opts: MemFsOptions): ProfileFs {
  const inodes = new Map<number, MemInode>();
  const tree = new Map<string, { inoId: number; path: string }>();
  let nextIno = 1;
  let clock = 1n;

  const pk = (p: string): string => {
    const n = normalize(p);
    return opts.platform === 'win32' ? n.toLowerCase() : n;
  };
  const deviceFor = (p: string): bigint => {
    if (opts.separateVolumeUnder && pk(p).startsWith(pk(opts.separateVolumeUnder))) return 2n;
    return 1n;
  };
  // Resolve a path through any symlink chain to the real inode plus the real path (for the volume id).
  const resolve = (p: string): { inoId: number; node: MemInode; realPath: string } | null => {
    const entry = tree.get(pk(p));
    if (!entry) return null;
    const node = inodes.get(entry.inoId) as MemInode;
    if (node.kind === 'symlink') return resolve(node.target as string);
    return { inoId: entry.inoId, node, realPath: p };
  };
  const ensureParent = (p: string): void => {
    const parent = dirname(p);
    if (parent === p) return;
    if (!tree.get(pk(parent))) {
      ensureParent(parent);
      const id = nextIno++;
      inodes.set(id, { kind: 'dir', mtimeMs: clock++ });
      tree.set(pk(parent), { inoId: id, path: parent });
    }
  };
  const enoent = (): NodeJS.ErrnoException => {
    const e: NodeJS.ErrnoException = new Error('ENOENT');
    e.code = 'ENOENT';
    return e;
  };

  return {
    platform: opts.platform,
    lstatKind(p) {
      const entry = tree.get(pk(p));
      if (!entry) return null;
      return (inodes.get(entry.inoId) as MemInode).kind;
    },
    statIdentity(p) {
      const r = resolve(p);
      if (!r) throw enoent();
      return { dev: deviceFor(r.realPath), ino: BigInt(r.inoId), mtimeMs: r.node.mtimeMs };
    },
    readlinkTarget(p) {
      const entry = tree.get(pk(p));
      if (!entry) throw enoent();
      const node = inodes.get(entry.inoId) as MemInode;
      if (node.kind !== 'symlink') {
        const e: NodeJS.ErrnoException = new Error('EINVAL');
        e.code = 'EINVAL';
        throw e;
      }
      return node.target as string;
    },
    readFileBuffer(p) {
      const r = resolve(p);
      if (!r || r.node.kind !== 'file') throw enoent();
      return Buffer.from(r.node.data ?? Buffer.alloc(0));
    },
    readTextIfExists(p) {
      const r = resolve(p);
      if (!r) return null;
      if (r.node.kind !== 'file') throw new Error('not a file');
      return (r.node.data ?? Buffer.alloc(0)).toString('utf8');
    },
    readdirNames(p) {
      const base = pk(p);
      const names: string[] = [];
      for (const [key, entry] of tree) {
        if (key === base) continue;
        if (pk(dirname(entry.path)) === base) names.push(basename(entry.path));
      }
      return names;
    },
    mkdirp(p) {
      ensureParent(p);
      if (!tree.get(pk(p))) {
        const id = nextIno++;
        inodes.set(id, { kind: 'dir', mtimeMs: clock++ });
        tree.set(pk(p), { inoId: id, path: p });
      }
    },
    chmodPath() {
      // Modes are not modeled in memory.
    },
    createDirLink(target, link) {
      ensureParent(link);
      const id = nextIno++;
      inodes.set(id, { kind: 'symlink', target, mtimeMs: clock++ });
      tree.set(pk(link), { inoId: id, path: link });
    },
    createHardLink(target, link) {
      if (opts.hardlinkThrows) {
        const e: NodeJS.ErrnoException = new Error(opts.hardlinkThrows);
        e.code = opts.hardlinkThrows;
        throw e;
      }
      if (deviceFor(target) !== deviceFor(link)) {
        const e: NodeJS.ErrnoException = new Error('EXDEV');
        e.code = 'EXDEV';
        throw e;
      }
      const r = resolve(target);
      if (!r) throw enoent();
      ensureParent(link);
      tree.set(pk(link), { inoId: r.inoId, path: link });
    },
    createFileSymlink(target, link) {
      ensureParent(link);
      const id = nextIno++;
      inodes.set(id, { kind: 'symlink', target, mtimeMs: clock++ });
      tree.set(pk(link), { inoId: id, path: link });
    },
    copyFileContents(src, dst) {
      const r = resolve(src);
      if (!r || r.node.kind !== 'file') throw enoent();
      ensureParent(dst);
      const id = nextIno++;
      inodes.set(id, {
        kind: 'file',
        data: Buffer.from(r.node.data ?? Buffer.alloc(0)),
        mtimeMs: clock++,
      });
      tree.set(pk(dst), { inoId: id, path: dst });
    },
    writeFileAtomic(p, data) {
      ensureParent(p);
      const id = nextIno++;
      inodes.set(id, { kind: 'file', data: Buffer.from(data), mtimeMs: clock++ });
      tree.set(pk(p), { inoId: id, path: p });
    },
    writeFileInPlace(p, data) {
      const r = resolve(p);
      if (!r) throw enoent();
      r.node.data = Buffer.from(data);
      r.node.mtimeMs = clock++;
    },
    removePath(p) {
      tree.delete(pk(p));
    },
  };
}

/** Seed a file directly into a mem fs (bypassing the module) so a test can arrange main's contents. */
function seedFile(fs: ProfileFs, path: string, text: string): void {
  fs.writeFileAtomic(path, Buffer.from(text, 'utf8'), 0o600);
}

describe('ensureGroupProfile (fake fs — platform primitives)', () => {
  const MAIN = 'C:/main';
  const PROFILE = 'C:/profiles/g1';

  it('creates POSIX directory symlinks and hard links, and is idempotent', () => {
    const fs = makeMemFs({ platform: 'posix' });
    fs.mkdirp(join(MAIN, 'projects'));
    seedFile(fs, join(MAIN, 'settings.json'), '{}');

    const first = ensureGroupProfile(PROFILE, MAIN, { fs });
    expect(first.linkedDirs).toContain('projects');
    expect(first.linkedFiles).toContain('settings.json');
    expect(fs.lstatKind(join(PROFILE, 'projects'))).toBe('symlink');
    // Hard link: same inode as main.
    expect(fs.statIdentity(join(PROFILE, 'settings.json')).ino).toBe(
      fs.statIdentity(join(MAIN, 'settings.json')).ino,
    );

    const second = ensureGroupProfile(PROFILE, MAIN, { fs });
    expect(second.repaired).toEqual([]);
    expect(second.copiedFallback).toEqual([]);
    expect(second.skipped).toEqual([]);
  });

  it('falls back to a copy on Windows when a hard link crosses a volume (planned cross-volume)', () => {
    // The profile root sits on a different volume than main, so no shared file can be hard-linked.
    const fs = makeMemFs({ platform: 'win32', separateVolumeUnder: 'C:/profiles' });
    seedFile(fs, join(MAIN, 'settings.json'), 'CONTENT');

    const report = ensureGroupProfile(PROFILE, MAIN, { fs });

    expect(report.copiedFallback).toContain('settings.json');
    expect(fs.readTextIfExists(join(PROFILE, 'settings.json'))).toBe('CONTENT');
    // The copy is an independent inode, not a link.
    expect(fs.lstatKind(join(PROFILE, 'settings.json'))).toBe('file');
    // Second run with unchanged content is a no-op copy (reported as linked, not re-copied).
    const second = ensureGroupProfile(PROFILE, MAIN, { fs });
    expect(second.copiedFallback).toEqual([]);
    expect(second.linkedFiles).toContain('settings.json');
  });

  it('falls back to a file symlink on POSIX when a hard link crosses a volume', () => {
    const fs = makeMemFs({ platform: 'posix', separateVolumeUnder: 'C:/profiles' });
    seedFile(fs, join(MAIN, 'settings.json'), 'CONTENT');

    const report = ensureGroupProfile(PROFILE, MAIN, { fs });

    expect(report.linkedFiles).toContain('settings.json');
    expect(fs.lstatKind(join(PROFILE, 'settings.json'))).toBe('symlink');
    expect(fs.readlinkTarget(join(PROFILE, 'settings.json'))).toBe(join(MAIN, 'settings.json'));
  });

  it('honours a late EXDEV from the hard-link syscall (plan said same-volume)', () => {
    // The planner predicted same-volume from the profile root, but the syscall throws EXDEV anyway;
    // the apply path must catch it and take the platform fallback rather than aborting.
    const fs = makeMemFs({ platform: 'win32', hardlinkThrows: 'EXDEV' });
    seedFile(fs, join(MAIN, 'settings.json'), 'CONTENT');
    const report = ensureGroupProfile(PROFILE, MAIN, { fs });
    expect(report.copiedFallback).toContain('settings.json');
    expect(fs.readTextIfExists(join(PROFILE, 'settings.json'))).toBe('CONTENT');
  });

  it('skips a foreign file symlink that points somewhere other than main', () => {
    const fs = makeMemFs({ platform: 'posix' });
    seedFile(fs, join(MAIN, 'settings.json'), '{}');
    // A pre-existing symlink at the profile path aimed at an unrelated file.
    fs.createFileSymlink('C:/somewhere/else.json', join(PROFILE, 'settings.json'));

    const report = ensureGroupProfile(PROFILE, MAIN, { fs });

    expect(report.linkedFiles).not.toContain('settings.json');
    expect(report.skipped.some((s) => s.path === join(PROFILE, 'settings.json'))).toBe(true);
    // Untouched: still the foreign target.
    expect(fs.readlinkTarget(join(PROFILE, 'settings.json'))).toBe('C:/somewhere/else.json');
  });
});

// ---------------------------------------------------------------------------------------------
// Path helpers.
// ---------------------------------------------------------------------------------------------

describe('profile path helpers', () => {
  it('derives the profiles root from the machine-local data root', () => {
    const win = defaultProfilesRoot({ LOCALAPPDATA: 'D:/Local' }, 'win32');
    expect(normalize(win)).toBe(normalize('D:/Local/claude-control/profiles'));
    const linux = defaultProfilesRoot({ XDG_DATA_HOME: '/data' }, 'linux');
    expect(linux).toBe(normalize('/data/claude-control/profiles'));
  });

  it('names a group dir under the root and refuses an id that tries to escape it', () => {
    const root = normalize('/root/profiles');
    expect(groupProfileDir('abc', root)).toBe(join(root, 'abc'));
    // A traversal attempt is reduced to its basename — the id names one directory, never a path.
    expect(groupProfileDir('../../etc', root)).toBe(join(root, 'etc'));
  });

  it('the node seam reports junctions/symlinks as symlink kind', () => {
    // Guards the lstat ordering (a junction reports isSymbolicLink() true and must be caught first).
    const fs = createNodeProfileFs();
    const { main, profile } = sandbox();
    mkdirSync(join(main, 'projects'), { recursive: true });
    mkdirSync(profile, { recursive: true });
    symlinkSync(join(main, 'projects'), join(profile, 'projects'), 'junction');
    expect(fs.lstatKind(join(profile, 'projects'))).toBe('symlink');
    expect(fs.lstatKind(join(main, 'projects'))).toBe('dir');
    expect(fs.lstatKind(join(profile, 'missing'))).toBeNull();
  });
});
