// Regression coverage for the guard-install wiring on the CLI bind/unbind path.
//
// The enforcement guard machinery (writeBindGuard / installBindGuard) was fully functional and
// unit-proven, but no production code ever CALLED it — so folder bindings were recorded and never
// enforced at prompt time. `reconcileBindGuard` is the caller `cctl bind` / `cctl unbind` now run;
// these tests exercise it against a sandbox so the wiring cannot silently regress to "no caller".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { sandboxPaths, type Paths, type StoredGroup } from '@claude-control/switch-engine';
import { BIND_GUARD_MARKER, bindGuardPath } from '@claude-control/daemon';
import { describeSwitchedGroup, reconcileBindGuard, relaxationBannerLine } from './bindCommands.js';

/** A minimal stand-in for the switch engine: `reconcileBindGuard` only asks it how many groups
 *  (folder bindings) exist. `count` is what `listGroups` reports — the one input that decides
 *  install vs. remove. */
function engineWithGroups(count: number): Parameters<typeof reconcileBindGuard>[0] {
  const groups = Array.from({ length: count }, (_, i) => ({ id: `g${i}` }) as StoredGroup);
  return {
    listGroups: () => Promise.resolve(groups),
  } as unknown as Parameters<typeof reconcileBindGuard>[0];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('reconcileBindGuard', () => {
  let root: string;
  let paths: Paths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-bindguard-wiring-'));
    paths = sandboxPaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs the guard (marker in settings.json + script on disk) when a folder is bound', async () => {
    await reconcileBindGuard(engineWithGroups(1), paths);

    const settingsPath = join(paths.claudeDir, 'settings.json');
    const raw = await readFile(settingsPath, 'utf8');
    expect(raw.includes(BIND_GUARD_MARKER)).toBe(true);

    // The command must have a real script behind it, keyed to this box's data dir.
    const guardPath = bindGuardPath(dirname(paths.vaultDir));
    expect(await exists(guardPath)).toBe(true);
  });

  it('removes the guard when the last binding is gone', async () => {
    await reconcileBindGuard(engineWithGroups(1), paths);
    await reconcileBindGuard(engineWithGroups(0), paths);

    const raw = await readFile(join(paths.claudeDir, 'settings.json'), 'utf8');
    expect(raw.includes(BIND_GUARD_MARKER)).toBe(false);
  });

  it('is best-effort: a failing settings write warns rather than throwing', async () => {
    // Point settings at a path whose parent is a FILE, so the write cannot succeed.
    const brokenPaths: Paths = { ...paths, claudeDir: join(root, 'claude', 'settings.json') };
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'claude'), { recursive: true });
    await writeFile(join(root, 'claude', 'settings.json'), 'x', 'utf8');

    const warn = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      await expect(reconcileBindGuard(engineWithGroups(1), brokenPaths)).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalled();
      const warned = warn.mock.calls.map((c) => String(c[0])).join('');
      expect(warned).toContain('enforcement guard');
    } finally {
      warn.mockRestore();
    }
  });
});

// A honored --override / --account relaxation is surfaced on the launcher's OWN stderr, not only via
// the guard's systemMessage (which Claude Code drops in a headless -p / SDK run). The banner names the
// actual session cwd — where the relaxation applies — and sanitizes both label and path.
describe('relaxationBannerLine', () => {
  it('names the session cwd (not the bound folder) for an override', () => {
    const line = relaxationBannerLine('override', 'work@corp', 'C:/other/place');
    expect(line).toContain('--override in effect');
    expect(line).toContain('work@corp');
    expect(line).toContain('C:/other/place');
    expect(line).toContain('bound to a different account');
    expect(line.endsWith('\n')).toBe(true);
  });

  it('explains a reserved account run on purpose for --account', () => {
    const line = relaxationBannerLine('explicit', 'work@corp', 'C:/somewhere');
    expect(line).toContain('--account in effect');
    expect(line).toContain('reserved to its folders');
    expect(line).toContain('C:/somewhere');
  });

  it('strips terminal control sequences from a crafted label and cwd', () => {
    const line = relaxationBannerLine('override', 'a\u001b[31mred\u0007', 'C:/x\r\nFAKE: injected');
    expect(line).not.toContain('\u001b');
    expect(line).not.toContain('\u0007');
    // The CR/LF that would forge a new banner line is gone (only the single trailing newline remains).
    expect(line.indexOf('\n')).toBe(line.length - 1);
    expect(line).not.toContain('\r');
  });
});

describe('describeSwitchedGroup', () => {
  const member = { id: 'm1', label: 'm', quarantined: false, createdAtMs: 1, updatedAtMs: 1 };
  const engineWith = (groups: StoredGroup[]) =>
    ({ listGroups: () => Promise.resolve(groups) }) as unknown as Parameters<
      typeof describeSwitchedGroup
    >[0];
  const group = (over: Partial<StoredGroup>): StoredGroup => ({
    id: 'g1',
    label: 'G',
    members: [member],
    activeId: 'm1',
    folders: [],
    createdAtMs: 1,
    updatedAtMs: 1,
    ...over,
  });

  it('names a folder-only group by its folders, as before', async () => {
    const d = await describeSwitchedGroup(engineWith([group({ folders: ['C:/w'] })]), 'm1');
    expect(d?.where).toBe('the C:/w folder group');
  });

  it('names an alias-bound group by its scopes, never an empty folder list', async () => {
    const d = await describeSwitchedGroup(
      engineWith([group({ aliases: [{ folder: 'C:/r', alias: 'Auth Work' }] })]),
      'm1',
    );
    expect(d?.where).toBe('the binding of session "Auth Work" in C:/r');
  });

  it('is null for a shared account', async () => {
    expect(await describeSwitchedGroup(engineWith([group({ folders: ['C:/w'] })]), 'x')).toBeNull();
  });
});
