// Tests for the enforcement guard — the second UserPromptSubmit hook that blocks a folder-bound
// account from being used in the wrong place, and vice versa.
//
// Like the forwarder, the guard is a standalone child process Claude Code spawns per event, so it
// is tested exactly that way: generate the script, write it to a temp file, spawn it under the real
// node binary with a real stdin payload and a real snapshot on disk, and read the decision back
// from stdout. Every folder is a REAL directory so the embedded canonicalizer's realpath step
// behaves as it does in production. The proofs are the spec §9 decision table: block (A) with the
// exact reason text, --override warns, block (B), --account allows, warn never blocks, off is
// silent, an unusable snapshot fails open with one stderr line, a thrown error fails open, and the
// prefix-boundary + case rules match the TS canonicalizer (because the guard embeds it).

import { spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonicalizeFolder } from '@claude-control/switch-engine';
import { bindGuardPath, generateBindGuardSource, writeBindGuard } from './bindGuard.js';

interface GuardResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Spawn the guard the way Claude Code's hook runner does: payload on stdin, decision on stdout.
 *  `env` is the FULL child env — tests build it explicitly so CLAUDE_PROJECT_DIR / CLAUDE_CONFIG_DIR
 *  and the enforcement knobs are deterministic regardless of the runner's own environment. */
function runGuard(
  scriptPath: string,
  payload: string,
  env: NodeJS.ProcessEnv,
): Promise<GuardResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.stdin.on('error', () => {});
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.write(payload);
    child.stdin.end();
  });
}

/** A base env with none of the guard's knobs set (the global-slot, block-mode default). */
function baseEnv(): NodeJS.ProcessEnv {
  const e = { ...process.env };
  delete e.CLAUDE_PROJECT_DIR;
  delete e.CLAUDE_CONFIG_DIR;
  delete e.CCTL_BIND_ENFORCE;
  delete e.CCTL_BIND_OVERRIDE;
  delete e.CCTL_LAUNCH_EXPLICIT;
  return e;
}

const PAYLOAD = '{"hook_event_name":"UserPromptSubmit","session_id":"s-1"}';

describe('bind guard script', () => {
  let root: string;
  let scriptPath: string;
  let snapshotPath: string;
  let boundFolder: string; // canonical, as stored in the snapshot
  let profileDir: string; // canonical, the group's slot config dir
  let outsideFolder: string; // canonical, bound to nothing

  /** Canonicalize a real path the same way the engine + guard do, so snapshot values and expected
   *  reason strings use the exact stored form. */
  function canon(p: string): string {
    const r = canonicalizeFolder(p, {
      platform: process.platform,
      cwd: process.cwd(),
      realpath: (x) => realpathSync.native(x),
    });
    if (!r.ok) throw new Error(`could not canonicalize ${p}: ${r.reason}`);
    return r.path;
  }

  /** Write a snapshot with one group bound to `boundFolder`, members Alice+Bob. Overrides let a
   *  test change enforce mode or the schema. */
  async function writeSnapshot(overrides: Record<string, unknown> = {}): Promise<void> {
    const snapshot = {
      schemaVersion: 1,
      generation: 1,
      enforce: 'block',
      mainConfigDir: canon(root),
      groups: [
        {
          id: 'group-1',
          label: 'Alice + Bob',
          profileDir,
          folders: [boundFolder],
          members: ['Alice', 'Bob'],
        },
      ],
      ...overrides,
    };
    await writeFile(snapshotPath, JSON.stringify(snapshot), 'utf8');
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cctl-guard-'));
    scriptPath = bindGuardPath(root);
    snapshotPath = join(root, 'folder-bindings.json');
    const bf = join(root, 'research');
    const pf = join(root, 'profile');
    const of = join(root, 'elsewhere');
    await mkdir(bf, { recursive: true });
    await mkdir(pf, { recursive: true });
    await mkdir(of, { recursive: true });
    boundFolder = canon(bf);
    profileDir = canon(pf);
    outsideFolder = canon(of);
    await writeBindGuard(scriptPath, snapshotPath);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  });

  // The exact case-A reason text (spec §9), reproduced here so a drift in the script is caught.
  function expectedReasonA(): string {
    return (
      'cctl: ' +
      boundFolder +
      ' is bound to Alice, Bob, but this session runs on the shared account. ' +
      'Exit and start it with: cctl claude' +
      '   (or set up the claude wrapper: cctl shell-init powershell)'
    );
  }

  it('(A) project bound to a group, session on the shared account → block with the exact reason', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: expectedReasonA() });
  });

  it('(A) with --override (CCTL_BIND_OVERRIDE=1) → allow with a systemMessage, never a block', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
      CCTL_BIND_OVERRIDE: '1',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expectedReasonA() });
  });

  it('correct pairing (project bound to G, session on G) → silent allow', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
      CLAUDE_CONFIG_DIR: profileDir,
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('(B) session on a group slot, project dir outside the group folders → block', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: outsideFolder,
      CLAUDE_CONFIG_DIR: profileDir,
    });
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout) as { decision?: string; reason?: string };
    expect(parsed.decision).toBe('block');
    expect(parsed.reason).toContain(outsideFolder);
    expect(parsed.reason).toContain('cctl claude --account');
  });

  it('(B) with --account (CCTL_LAUNCH_EXPLICIT=1) → allow silently', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: outsideFolder,
      CLAUDE_CONFIG_DIR: profileDir,
      CCTL_LAUNCH_EXPLICIT: '1',
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('warn mode emits the block text as a systemMessage and never blocks (env override)', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
      CCTL_BIND_ENFORCE: 'warn',
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expectedReasonA() });
  });

  it('warn mode from the snapshot (no env) also emits a systemMessage', async () => {
    await writeSnapshot({ enforce: 'warn' });
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(JSON.parse(result.stdout)).toEqual({ systemMessage: expectedReasonA() });
  });

  it('off mode is silent even on a clear violation (env override beats snapshot block)', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
      CCTL_BIND_ENFORCE: 'off',
    });
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  it('env CCTL_BIND_ENFORCE overrides the snapshot enforce mode', async () => {
    // Snapshot says off, env says block → the env wins and the violation is blocked.
    await writeSnapshot({ enforce: 'off' });
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
      CCTL_BIND_ENFORCE: 'block',
    });
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: expectedReasonA() });
  });

  it('a missing snapshot fails OPEN: exit 0, empty stdout, one stderr line', async () => {
    // Point a freshly-generated guard at a path that does not exist.
    const missingPath = join(root, 'nope', 'folder-bindings.json');
    const guard2 = join(root, 'guard2.cjs');
    await writeBindGuard(guard2, missingPath);
    const result = await runGuard(guard2, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('cctl bind-guard:');
  });

  it('a corrupt snapshot fails OPEN with one stderr line', async () => {
    await writeFile(snapshotPath, '{ this is not json', 'utf8');
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr.trim().split('\n')).toHaveLength(1);
  });

  it('an unknown schemaVersion fails OPEN', async () => {
    await writeSnapshot({ schemaVersion: 2 });
    const result = await runGuard(scriptPath, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cctl bind-guard:');
  });

  it('a thrown IO error (snapshot path is a directory) fails OPEN', async () => {
    // readFileSync on a directory throws EISDIR — the guard catches it and allows the prompt.
    const dirAsSnapshot = join(root, 'snapdir');
    await mkdir(dirAsSnapshot, { recursive: true });
    const guard3 = join(root, 'guard3.cjs');
    await writeBindGuard(guard3, dirAsSnapshot);
    const result = await runGuard(guard3, PAYLOAD, {
      ...baseEnv(),
      CLAUDE_PROJECT_DIR: boundFolder,
    });
    expect(result.code).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('cctl bind-guard:');
  });

  it('falls back to the payload cwd when CLAUDE_PROJECT_DIR is unset', async () => {
    await writeSnapshot();
    const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: boundFolder });
    const result = await runGuard(scriptPath, payload, baseEnv());
    expect(JSON.parse(result.stdout)).toEqual({ decision: 'block', reason: expectedReasonA() });
  });

  it('no project dir at all → silent allow (nothing to check)', async () => {
    await writeSnapshot();
    const result = await runGuard(scriptPath, '{"hook_event_name":"UserPromptSubmit"}', baseEnv());
    expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
  });

  describe('prefix-boundary + case behavior matches the TS canonicalizer', () => {
    it('a sibling folder (research2) is NOT within the bound folder (research) → silent', async () => {
      // research2 shares a string prefix with research but is not under it; the embedded isWithin
      // uses a separator boundary, exactly like the TS function.
      const sibling = join(root, 'research2');
      await mkdir(sibling, { recursive: true });
      await writeSnapshot();
      const result = await runGuard(scriptPath, PAYLOAD, {
        ...baseEnv(),
        CLAUDE_PROJECT_DIR: canon(sibling),
      });
      expect(result).toEqual({ code: 0, stdout: '', stderr: '' });
    });

    it('a subfolder of the bound folder IS within it → block', async () => {
      const sub = join(root, 'research', 'sub');
      await mkdir(sub, { recursive: true });
      await writeSnapshot();
      const result = await runGuard(scriptPath, PAYLOAD, {
        ...baseEnv(),
        CLAUDE_PROJECT_DIR: canon(sub),
      });
      const parsed = JSON.parse(result.stdout) as { decision?: string };
      expect(parsed.decision).toBe('block');
    });

    it.runIf(process.platform === 'win32')(
      'a case-variant of the bound path still matches (Windows case-insensitivity)',
      async () => {
        await writeSnapshot();
        // Upper-case the whole path; on Windows folderKey folds case so it still matches.
        const result = await runGuard(scriptPath, PAYLOAD, {
          ...baseEnv(),
          CLAUDE_PROJECT_DIR: boundFolder.toUpperCase(),
        });
        expect(JSON.parse(result.stdout)).toEqual({
          decision: 'block',
          reason: expectedReasonA(),
        });
      },
    );
  });

  it('the generated source embeds the canonicalizer and bakes in the snapshot path', () => {
    const src = generateBindGuardSource({ snapshotPath: 'C:\\vault\\..\\folder-bindings.json' });
    expect(src).toContain('const canonicalizeFolder =');
    expect(src).toContain('const isWithin =');
    expect(src).toContain('const folderKey =');
    expect(src).toContain(JSON.stringify('C:\\vault\\..\\folder-bindings.json'));
  });
});
