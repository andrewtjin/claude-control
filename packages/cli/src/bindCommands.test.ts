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
import { reconcileBindGuard } from './bindCommands.js';

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
