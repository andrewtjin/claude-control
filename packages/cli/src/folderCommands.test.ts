// Unit coverage for the folder-rule commands' pure halves (account refs, views, what a change did)
// and the guard-install wiring.
//
// The enforcement guard machinery (writeBindGuard / installBindGuard) is unit-proven elsewhere, but it
// only enforces anything if production code CALLS it. `reconcileFolderGuard` is the caller every
// `cctl folder` change runs; the tests below exercise it against a sandbox so the wiring cannot
// silently regress to "no caller".

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  sandboxPaths,
  type AccountView,
  type FolderRule,
  type Paths,
} from '@claude-control/switch-engine';
import { BIND_GUARD_MARKER, Store, bindGuardPath, isMoveTarget } from '@claude-control/daemon';
import { lastUsageOf, reconcileFolderGuard, relaxationBannerLine } from './folderCommands.js';

/** A minimal stand-in for the switch engine: `reconcileFolderGuard` only asks it how many folder
 *  rules exist. `count` is what `listRules` reports — the one input that decides install vs. remove. */
function engineWithGroups(count: number): Parameters<typeof reconcileFolderGuard>[0] {
  const rules = Array.from({ length: count }, (_, i) => ({ id: `g${i}` }) as FolderRule);
  return {
    listRules: () => Promise.resolve(rules),
  } as unknown as Parameters<typeof reconcileFolderGuard>[0];
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('reconcileFolderGuard', () => {
  let root: string;
  let paths: Paths;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-bindguard-wiring-'));
    paths = sandboxPaths(root);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('installs the guard (marker in settings.json + script on disk) when a folder has a rule', async () => {
    await reconcileFolderGuard(engineWithGroups(1), paths);

    const settingsPath = join(paths.claudeDir, 'settings.json');
    const raw = await readFile(settingsPath, 'utf8');
    expect(raw.includes(BIND_GUARD_MARKER)).toBe(true);

    // The command must have a real script behind it, keyed to this box's data dir.
    const guardPath = bindGuardPath(dirname(paths.vaultDir));
    expect(await exists(guardPath)).toBe(true);
  });

  it('removes the guard when the last rule is gone', async () => {
    await reconcileFolderGuard(engineWithGroups(1), paths);
    await reconcileFolderGuard(engineWithGroups(0), paths);

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
      await expect(reconcileFolderGuard(engineWithGroups(1), brokenPaths)).resolves.toBeUndefined();
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
  it('names the session cwd (not the rule folder) for an override', () => {
    const line = relaxationBannerLine('override', 'work@corp', 'C:/other/place');
    expect(line).toContain('--override in effect');
    expect(line).toContain('work@corp');
    expect(line).toContain('C:/other/place');
    expect(line).toContain('whose folder rule runs on a different slot');
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

// `cctl claude` judges whether a folder slot can take a moved session by the usage the daemon last
// recorded for its account, in the daemon's own database.
describe('lastUsageOf', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-last-usage-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  const E: AccountView = {
    id: 'e',
    label: 'E',
    quarantined: false,
    createdAtMs: 0,
    updatedAtMs: 0,
  };

  it('reads the usage the daemon recorded: an account out of its weekly allowance is no move target', () => {
    const db = join(root, 'daemon.db');
    const store = new Store(db);
    store.insertUsageSnapshot({
      accountId: 'e',
      fetchedAtMs: Date.now(),
      source: 'poll',
      json: JSON.stringify({
        accountId: 'e',
        label: 'E',
        active: true,
        source: 'live',
        fetchedAtMs: Date.now(),
        limits: [
          {
            kind: 'weekly_all',
            percent: 100,
            resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
            isActive: true,
          },
        ],
      }),
    });
    store.close();
    const usage = lastUsageOf(E, db);
    expect(usage).toBeDefined();
    expect(isMoveTarget(['e'], 'e', usage, Date.now())).toBe(false);
    // With no record at all it counts as able.
    const none = lastUsageOf(E, join(root, 'none.db'));
    expect(isMoveTarget(['e'], 'e', none, Date.now())).toBe(true);
  });
});
